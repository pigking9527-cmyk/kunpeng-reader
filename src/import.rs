use crate::import_core::{filter_new_book_paths, is_supported_book_path, normalize_import_dirs};
use crate::{
    background_tasks::{BackgroundTaskKind, TaskControlSignal, TaskRunGuard},
    book, data_migration,
    library_commands::{snapshot, BookDto},
    AppState,
};
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

const IMPORT_PAUSED: &str = "__import_paused__";
const IMPORT_CANCELLED: &str = "__import_cancelled__";

fn import_control(task: &TaskRunGuard) -> Result<(), String> {
    match task.control_signal() {
        TaskControlSignal::Pause => Err(IMPORT_PAUSED.into()),
        TaskControlSignal::Cancel => Err(IMPORT_CANCELLED.into()),
        TaskControlSignal::Continue => Ok(()),
    }
}

fn checkpoint_import(
    task: &TaskRunGuard,
    processed: usize,
    total: usize,
    current: &str,
) -> Result<(), String> {
    task.checkpoint(
        processed as u64,
        total as u64,
        current.to_string(),
        serde_json::json!({ "processed": processed, "current": current }).to_string(),
    )
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
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue(BackgroundTaskKind::Import, "导入图书");
    task_handle
        .run_blocking(move |task| -> Result<Vec<BookDto>, String> {
            let state = app.state::<AppState>();
            let total = paths.len();
            let mut processed = 0usize;
            let mut added = 0usize;
            let mut changed = false;
            let mut save_after = 0usize;
            emit_book_import_progress(&app, "start", 0, 0, total, "");

            for p in paths {
                match task.control_signal() {
                    TaskControlSignal::Pause => {
                        emit_book_import_progress(&app, "paused", processed, added, total, "");
                        let books = snapshot(&state.library.lock().unwrap());
                        let _ = task.pause();
                        return Ok(books);
                    }
                    TaskControlSignal::Cancel => {
                        emit_book_import_progress(&app, "cancelled", processed, added, total, "");
                        let books = snapshot(&state.library.lock().unwrap());
                        let _ = task.cancel();
                        return Ok(books);
                    }
                    TaskControlSignal::Continue => {}
                }
                processed += 1;
                let path = std::path::PathBuf::from(&p);
                let current = path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                // Import is intentionally not resumable across process restarts;
                // publish progress without advertising a durable checkpoint.
                task.update_progress(processed as u64, total as u64, current.clone())?;

                let exact_exists = {
                    let lib = state.library.lock().unwrap();
                    lib.books.iter().any(|b| b.path == path)
                };
                if exact_exists {
                    checkpoint_import(&task, processed, total, &current)?;
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
                checkpoint_import(&task, processed, total, &current)?;
                emit_book_import_progress(&app, "import", processed, added, total, &current);
            }

            if changed {
                crate::report_save_error("书架", state.library.lock().unwrap().save());
            }
            emit_book_import_progress(&app, "done", processed, added, total, "");
            let books = snapshot(&state.library.lock().unwrap());
            let _ = task.complete();
            Ok(books)
        })
        .await
}

// ---- 自动导入目录 ----
#[derive(Serialize)]
pub(crate) struct AutoImportCfg {
    enabled: bool,
    dirs: Vec<String>,
}

/// 递归扫描目录里支持的电子书文件（限深 8 层，防符号链接/超深目录）。
fn scan_dir_books(
    dir: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
    depth: u32,
    task: &TaskRunGuard,
) -> Result<(), String> {
    import_control(task)?;
    if depth > 8 {
        return Ok(());
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for ent in rd.flatten() {
        import_control(task)?;
        let p = ent.path();
        if p.is_dir() {
            scan_dir_books(&p, out, depth + 1, task)?;
        } else if is_supported_book_path(&p) {
            out.push(p);
        }
    }
    Ok(())
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
fn run_auto_import_with_progress(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    task: &TaskRunGuard,
) -> Result<bool, String> {
    use std::collections::HashSet;
    // 1) 短暂持锁，取出目录列表 + 已知书的路径集合
    let (dirs, known): (Vec<String>, HashSet<std::path::PathBuf>) = {
        let lib = state.library.lock().unwrap();
        if !lib.auto_import_enabled {
            return Ok(false);
        }
        (
            lib.auto_import_dirs.clone(),
            lib.books.iter().map(|b| b.path.clone()).collect(),
        )
    };
    if dirs.is_empty() {
        return Ok(false);
    }
    // 2) 锁外扫描目录
    let mut found = Vec::new();
    for d in &dirs {
        scan_dir_books(std::path::Path::new(d), &mut found, 0, task)?;
        emit_auto_import_progress(app, "scan", found.len(), 0, 0, 0, d);
    }
    // 3) 锁外过滤掉路径已在书架里的（稳态：没有新文件 → 候选为空，下面整段都不取写锁）
    let candidates = filter_new_book_paths(found.iter().cloned(), &known);
    let total = candidates.len();
    if total == 0 {
        emit_auto_import_progress(app, "done", found.len(), 0, 0, 0, "");
        return Ok(false);
    }
    // 4) 只为真正的新书逐本短暂持锁，给封面等请求留出穿插的间隙
    let mut changed = false;
    let mut processed = 0usize;
    let mut added = 0usize;
    for p in candidates {
        import_control(task)?;
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
        checkpoint_import(task, processed, total, &current)?;
    }
    if changed {
        crate::report_save_error("书架", state.library.lock().unwrap().save());
    }
    emit_auto_import_progress(app, "done", found.len(), processed, added, total, "");
    Ok(changed)
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
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue(BackgroundTaskKind::Import, "自动扫描导入目录");
    task_handle
        .run_blocking(move |task| {
            let state = app.state::<AppState>();
            let result = run_auto_import_with_progress(Some(&app), state.inner(), &task);
            let books = snapshot(&state.library.lock().unwrap());
            match result {
                Ok(_) => {
                    let _ = task.complete();
                    Ok(books)
                }
                Err(error) if error == IMPORT_PAUSED => {
                    let _ = task.pause();
                    Ok(books)
                }
                Err(error) if error == IMPORT_CANCELLED => {
                    let _ = task.cancel();
                    Ok(books)
                }
                Err(error) => {
                    let _ = task.fail(error.clone());
                    Err(error)
                }
            }
        })
        .await
        .map_err(|_| ())
}
