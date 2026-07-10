use crate::import_core::{filter_new_book_paths, is_supported_book_path, normalize_import_dirs};
use crate::{book, data_migration, set_thread_background, snapshot, AppState, BookDto};
use serde::Serialize;
use tauri::{Emitter, Manager};
#[derive(Serialize, Clone)]
struct BookImportProgress {
    phase: String,
    processed: usize,
    added: usize,
    total: usize,
    current: String,
}

fn emit_book_import_progress(
    app: &tauri::AppHandle,
    phase: &str,
    processed: usize,
    added: usize,
    total: usize,
    current: &str,
) {
    let _ = app.emit(
        "book-import-progress",
        BookImportProgress {
            phase: phase.to_string(),
            processed,
            added,
            total,
            current: current.to_string(),
        },
    );
}

#[tauri::command]
pub(crate) async fn add_books(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_thread_background(true);
        let state = app.state::<AppState>();
        let total = paths.len();
        let mut processed = 0usize;
        let mut added = 0usize;
        let mut changed = false;
        let mut save_after = 0usize;
        emit_book_import_progress(&app, "start", 0, 0, total, "");

        for p in paths {
            processed += 1;
            let path = std::path::PathBuf::from(&p);
            let current = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());

            let exact_exists = {
                let lib = state.library.lock().unwrap();
                lib.books.iter().any(|b| b.path == path)
            };
            if exact_exists {
                emit_book_import_progress(&app, "import", processed, added, total, &current);
                continue;
            }

            let mut prepared = book::Book::prepare(path.clone());
            // A remote state can arrive before this file exists locally. Match
            // it by full content hash and restore progress during the import.
            if let Err(error) =
                data_migration::apply_pending_book_state(state.inner(), &mut prepared)
            {
                eprintln!("[sync] apply pending book state failed: {error}");
            }
            let inserted = {
                let mut lib = state.library.lock().unwrap();
                lib.add_prepared(prepared)
            };
            if inserted {
                changed = true;
                added += 1;
                save_after += 1;
                if save_after >= 50 {
                    crate::report_save_error("书架", state.library.lock().unwrap().save());
                    save_after = 0;
                }
            }
            emit_book_import_progress(&app, "import", processed, added, total, &current);
        }

        if changed {
            crate::report_save_error("书架", state.library.lock().unwrap().save());
        }
        emit_book_import_progress(&app, "done", processed, added, total, "");
        let books = snapshot(&state.library.lock().unwrap());
        set_thread_background(false);
        books
    })
    .await
    .map_err(|e| e.to_string())
}

// ---- 自动导入目录 ----
#[derive(Serialize)]
pub(crate) struct AutoImportCfg {
    enabled: bool,
    dirs: Vec<String>,
}

/// 递归扫描目录里支持的电子书文件（限深 8 层，防符号链接/超深目录）。
fn scan_dir_books(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, depth: u32) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            scan_dir_books(&p, out, depth + 1);
        } else if is_supported_book_path(&p) {
            out.push(p);
        }
    }
}

#[derive(Serialize, Clone)]
struct AutoImportProgress {
    phase: String,
    found: usize,
    processed: usize,
    added: usize,
    total: usize,
    current: String,
}

fn emit_auto_import_progress(
    app: Option<&tauri::AppHandle>,
    phase: &str,
    found: usize,
    processed: usize,
    added: usize,
    total: usize,
    current: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "auto-import-progress",
            AutoImportProgress {
                phase: phase.to_string(),
                found,
                processed,
                added,
                total,
                current: current.to_string(),
            },
        );
    }
}

/// 把自动导入目录里的新书加入书架（已存在的由 lib.add 去重）。返回是否有新增。
/// 关键：扫描目录、过滤已知书都在锁外做，绝不在持锁状态下遍历整个目录，
/// 否则封面等请求会因为抢不到书架锁而一直加载不出来（稳态下根本不取写锁）。
fn run_auto_import_with_progress(app: Option<&tauri::AppHandle>, state: &AppState) -> bool {
    use std::collections::HashSet;
    // 1) 短暂持锁，取出目录列表 + 已知书的路径集合
    let (dirs, known): (Vec<String>, HashSet<std::path::PathBuf>) = {
        let lib = state.library.lock().unwrap();
        if !lib.auto_import_enabled {
            return false;
        }
        (
            lib.auto_import_dirs.clone(),
            lib.books.iter().map(|b| b.path.clone()).collect(),
        )
    };
    if dirs.is_empty() {
        return false;
    }
    // 2) 锁外扫描目录
    let mut found = Vec::new();
    for d in &dirs {
        scan_dir_books(std::path::Path::new(d), &mut found, 0);
        emit_auto_import_progress(app, "scan", found.len(), 0, 0, 0, d);
    }
    // 3) 锁外过滤掉路径已在书架里的（稳态：没有新文件 → 候选为空，下面整段都不取写锁）
    let candidates = filter_new_book_paths(found.iter().cloned(), &known);
    let total = candidates.len();
    if total == 0 {
        emit_auto_import_progress(app, "done", found.len(), 0, 0, 0, "");
        return false;
    }
    // 4) 只为真正的新书逐本短暂持锁，给封面等请求留出穿插的间隙
    let mut changed = false;
    let mut processed = 0usize;
    let mut added = 0usize;
    for p in candidates {
        processed += 1;
        let current = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mut prepared = book::Book::prepare(p);
        if let Err(error) = data_migration::apply_pending_book_state(state, &mut prepared) {
            eprintln!("[sync] apply pending book state failed: {error}");
        }
        {
            let mut lib = state.library.lock().unwrap();
            if lib.add_prepared(prepared) {
                changed = true;
                added += 1;
            }
        }
        if processed == total || processed.is_multiple_of(5) {
            emit_auto_import_progress(
                app,
                "import",
                found.len(),
                processed,
                added,
                total,
                &current,
            );
        }
    }
    if changed {
        crate::report_save_error("书架", state.library.lock().unwrap().save());
    }
    emit_auto_import_progress(app, "done", found.len(), processed, added, total, "");
    changed
}

#[tauri::command]
pub(crate) fn get_auto_import(state: tauri::State<AppState>) -> AutoImportCfg {
    let lib = state.library.lock().unwrap();
    AutoImportCfg {
        enabled: lib.auto_import_enabled,
        dirs: lib.auto_import_dirs.clone(),
    }
}

/// 设置自动导入开关 / 目录列表。只保存设置，不在这个命令里扫描，避免设置窗口等待导入完成。
#[tauri::command]
pub(crate) async fn set_auto_import(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    dirs: Vec<String>,
) -> Result<AutoImportCfg, String> {
    let cfg = {
        let mut lib = state.library.lock().unwrap();
        lib.auto_import_enabled = enabled;
        // 去重 + 去空
        lib.auto_import_dirs = normalize_import_dirs(dirs);
        lib.auto_import_dir = None; // 清掉已迁移的旧字段
        lib.save()?;
        AutoImportCfg {
            enabled: lib.auto_import_enabled,
            dirs: lib.auto_import_dirs.clone(),
        }
    };
    Ok(cfg)
}
/// 启动/回到书架时调用：若开启自动导入则扫描目录，返回最新书单。
#[tauri::command]
pub(crate) async fn auto_import_scan(app: tauri::AppHandle) -> Result<Vec<BookDto>, ()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_auto_import_with_progress(Some(&app), state.inner());
        let books = snapshot(&state.library.lock().unwrap());
        books
    })
    .await
    .map_err(|_| ())
}
