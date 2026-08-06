//! Portable data package and recovery-point command boundary.
//!
//! These commands coordinate database migration, backup creation and runtime
//! cache refresh. Keeping that orchestration here leaves `main.rs` responsible
//! for application assembly instead of persistence workflows.

use crate::{
    atomic_file, backup, book::Library, data_migration, db, stats::StatsStore, vocab::VocabStore,
    AppState,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::Manager;

const APP_DATA_DIRECTORY: &str = "ebook-reader";

fn owned_app_directory(base: Option<PathBuf>, label: &str) -> Result<PathBuf, String> {
    let base = base.ok_or_else(|| format!("无法确定{label}目录"))?;
    let target = base.join(APP_DATA_DIRECTORY);
    if target.parent() != Some(base.as_path())
        || target.file_name().and_then(|name| name.to_str()) != Some(APP_DATA_DIRECTORY)
    {
        return Err(format!("拒绝清除意外的{label}路径：{}", target.display()));
    }
    Ok(target)
}

fn remove_owned_directory(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除 {}：{error}", path.display())),
    }
}

fn path_is_within(path: &Path, directory: &Path) -> bool {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let directory = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    path.starts_with(directory)
}

#[tauri::command]
pub(crate) fn recovery_backup_status() -> Result<backup::BackupStatus, String> {
    backup::status()
}

#[tauri::command]
pub(crate) fn create_recovery_backup(
    state: tauri::State<AppState>,
) -> Result<backup::BackupStatus, String> {
    backup::create(state.inner(), true)
}

#[tauri::command]
pub(crate) fn restore_recovery_backup(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<backup::BackupStatus, String> {
    if app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with("reader-"))
    {
        return Err("恢复前请先关闭所有阅读窗口，避免覆盖尚未保存的阅读进度".to_string());
    }
    backup::restore(state.inner(), &backup_id)
}

#[tauri::command]
pub(crate) fn migrate_data_to_sqlite(state: tauri::State<AppState>) -> Result<(), String> {
    data_migration::migrate_json_to_sqlite(state.inner())
}

#[tauri::command]
pub(crate) fn export_data_package(
    state: tauri::State<AppState>,
    path: String,
) -> Result<(), String> {
    data_migration::migrate_json_to_sqlite(state.inner())?;
    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    let package = db.export_package()?;
    atomic_file::write_json(std::path::Path::new(&path), &package, true)
}

#[tauri::command]
pub(crate) fn import_data_package(
    state: tauri::State<AppState>,
    path: String,
) -> Result<u32, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    backup::create(state.inner(), true)?;
    let imported = {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        db.import_package(&value)?
    };
    data_migration::apply_sqlite_to_runtime(state.inner())?;
    Ok(imported)
}

/// Clear data owned by this installation without touching any original book
/// file referenced by the shelf. The UI reloads after this command returns.
#[tauri::command]
pub(crate) fn clear_local_app_data(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if state.sync_running.load(Ordering::Acquire) {
        return Err("同步任务正在进行，请完成后再清除此设备数据".into());
    }
    if !state.background_tasks.active_snapshots().is_empty() {
        return Err("后台任务正在运行，请完成或取消后再清除此设备数据".into());
    }
    if app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with("reader-"))
    {
        return Err("请先关闭所有阅读窗口，再清除此设备数据".into());
    }

    let targets = [
        owned_app_directory(dirs::config_dir(), "配置")?,
        owned_app_directory(dirs::cache_dir(), "缓存")?,
        owned_app_directory(dirs::data_local_dir(), "本地数据")?,
    ]
    .into_iter()
    .collect::<HashSet<_>>();

    let protected_book_path = {
        let library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        library
            .books
            .iter()
            .map(|book| book.path.clone())
            .find(|path| targets.iter().any(|target| path_is_within(path, target)))
    };
    if let Some(book_path) = protected_book_path {
        return Err(format!(
            "检测到原始图书位于阅读器数据目录：{}。请先把该图书移到其他文件夹，应用不会删除原始图书文件",
            book_path.display()
        ));
    }

    for window in app.webview_windows().values() {
        window
            .clear_all_browsing_data()
            .map_err(|error| format!("无法清除网页缓存、Cookie 与本地存储：{error}"))?;
    }

    // Close SQLite (including WAL handles) before deleting the application
    // directories. Original EPUB/PDF/TXT/MOBI/AZW files live outside these
    // exact directories and are deliberately never removed here.
    {
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        *guard = None;
    }
    for target in &targets {
        if let Err(error) = remove_owned_directory(target) {
            let reopened = db::AppDb::open();
            if let Ok(database) = reopened {
                if let Ok(mut guard) = state.db.lock() {
                    *guard = Some(database);
                }
            }
            return Err(error);
        }
    }

    let database = db::AppDb::open()?;
    {
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        *guard = Some(database);
    }
    *state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())? = Library::default();
    *state.stats.lock().map_err(|_| "统计锁定失败".to_string())? = StatsStore::default();
    *state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())? = VocabStore::default();
    state.reset_runtime_caches_after_restore();
    Ok(())
}
