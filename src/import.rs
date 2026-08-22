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
const AUTO_IMPORT_FILE_STABLE_AGE: std::time::Duration = std::time::Duration::from_secs(3);

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
    let rd = match std::fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if depth == 0 => {
            return Err(format!("无法读取自动导入目录 {}：{error}", dir.display()));
        }
        Err(error) => {
            crate::log(&format!(
                "auto_import_scan skipped unreadable subdirectory path={} error={error}",
                dir.display()
            ));
            return Ok(());
        }
    };
    for entry in rd {
        import_control(task)?;
        let ent = match entry {
            Ok(value) => value,
            Err(error) => {
                crate::log(&format!(
                    "auto_import_scan skipped unreadable entry dir={} error={error}",
                    dir.display()
                ));
                continue;
            }
        };
        let p = ent.path();
        let file_type = match ent.file_type() {
            Ok(value) => value,
            Err(error) => {
                crate::log(&format!(
                    "auto_import_scan skipped unknown entry path={} error={error}",
                    p.display()
                ));
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
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
    deferred: usize,
    current: String,
}

fn auto_import_progress(
    phase: &str,
    found: usize,
    processed: usize,
    added: usize,
    total: usize,
    deferred: usize,
    current: &str,
) -> AutoImportProgress {
    AutoImportProgress {
        phase: phase.to_string(),
        found,
        processed,
        added,
        total,
        deferred,
        current: current.to_string(),
    }
}

fn emit_auto_import_progress(app: Option<&tauri::AppHandle>, progress: AutoImportProgress) {
    if let Some(app) = app {
        let _ = app.emit("auto-import-progress", progress);
    }
}

fn auto_import_file_is_stable_at(path: &std::path::Path, now: std::time::SystemTime) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_none_or(|age| age >= AUTO_IMPORT_FILE_STABLE_AGE)
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
        emit_auto_import_progress(
            app,
            auto_import_progress("scan", found.len(), 0, 0, 0, 0, d),
        );
    }
    // 3) 锁外过滤掉路径已在书架里的（稳态：没有新文件 → 候选为空，下面整段都不取写锁）
    let all_candidates = filter_new_book_paths(found.iter().cloned(), &known);
    let now = std::time::SystemTime::now();
    let candidates = all_candidates
        .iter()
        .filter(|path| auto_import_file_is_stable_at(path, now))
        .cloned()
        .collect::<Vec<_>>();
    let deferred = all_candidates.len().saturating_sub(candidates.len());
    let total = candidates.len();
    if total == 0 {
        if deferred > 0 {
            emit_auto_import_progress(
                app,
                auto_import_progress("waiting", found.len(), 0, 0, 0, deferred, ""),
            );
        } else {
            emit_auto_import_progress(
                app,
                auto_import_progress("done", found.len(), 0, 0, 0, 0, ""),
            );
        }
        return Ok(false);
    }
    // 4) 只为真正的新书逐本短暂持锁，给封面等请求留出穿插的间隙
    let mut changed = false;
    let mut processed = 0usize;
    let mut added = 0usize;
    let mut save_after = 0usize;
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
                save_after += 1;
            }
        }
        // 大批量自动导入也分段落盘。即使用户在扫描结束前关闭应用，
        // 已完成的整批图书仍能在下次启动时恢复。
        if save_after >= 50 {
            crate::report_save_error("书架", state.library.lock().unwrap().save());
            save_after = 0;
        }
        if processed == total || processed.is_multiple_of(5) {
            emit_auto_import_progress(
                app,
                auto_import_progress(
                    "import",
                    found.len(),
                    processed,
                    added,
                    total,
                    deferred,
                    &current,
                ),
            );
        }
        checkpoint_import(task, processed, total, &current)?;
    }
    if changed {
        crate::report_save_error("书架", state.library.lock().unwrap().save());
    }
    if deferred > 0 {
        emit_auto_import_progress(
            app,
            auto_import_progress(
                "waiting",
                found.len(),
                processed,
                added,
                total,
                deferred,
                "",
            ),
        );
    } else {
        emit_auto_import_progress(
            app,
            auto_import_progress("done", found.len(), processed, added, total, 0, ""),
        );
    }
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
/// 启动、目录变化或定时补漏时调用：若开启自动导入则扫描目录，返回最新书单。
#[tauri::command]
pub(crate) async fn auto_import_scan(app: tauri::AppHandle) -> Result<Vec<BookDto>, String> {
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
}

#[cfg(test)]
mod auto_import_tests {
    use super::*;

    #[test]
    fn newly_written_files_wait_for_the_stability_window() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-auto-import-stable-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("copying.epub");
        std::fs::write(&path, b"still-copying").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(!auto_import_file_is_stable_at(
            &path,
            modified + std::time::Duration::from_secs(2)
        ));
        assert!(auto_import_file_is_stable_at(
            &path,
            modified + std::time::Duration::from_secs(3)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_files_are_never_imported_as_stable_books() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-auto-import-empty-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("empty.epub");
        std::fs::write(&path, []).unwrap();
        assert!(!auto_import_file_is_stable_at(
            &path,
            std::time::SystemTime::now() + std::time::Duration::from_secs(10)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
