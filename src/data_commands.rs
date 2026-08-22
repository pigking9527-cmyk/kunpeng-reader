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

fn owned_app_directory(target: Option<PathBuf>, label: &str) -> Result<PathBuf, String> {
    target.ok_or_else(|| format!("无法确定{label}目录"))
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
    if crate::window_commands::any_bound_reader_window(&app) {
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
    // Build the portable envelope while holding the database boundary, then
    // release SQLite before filesystem I/O writes the potentially large JSON.
    let package = state.with_db_read("export_data_package", |db| db.export_package())?;
    atomic_file::write_json(std::path::Path::new(&path), &package, true)
}

#[tauri::command]
pub(crate) fn import_data_package(
    state: tauri::State<AppState>,
    path: String,
) -> Result<u32, String> {
    let package_path = std::path::Path::new(&path);
    let metadata = std::fs::metadata(package_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("数据包路径不是普通文件".into());
    }
    if metadata.len() > db::MAX_CORE_PACKAGE_BYTES {
        return Err(format!(
            "数据包超过 {} MiB 未压缩 JSON 上限",
            db::MAX_CORE_PACKAGE_BYTES / 1024 / 1024
        ));
    }
    let text = std::fs::read_to_string(package_path).map_err(|e| e.to_string())?;
    if text.len() as u64 > db::MAX_CORE_PACKAGE_BYTES {
        return Err("数据包超过未压缩 JSON 上限".into());
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    // A recovery point is the outer installation boundary: it contains the
    // actual SQLite database and every runtime projection. If validation or
    // materialization fails later, restore this exact pre-import installation
    // rather than trying to reconstruct only selected database rows.
    let recovery = backup::create(state.inner(), true)?;
    let recovery_id = recovery.latest_id()?.to_string();
    let imported = state.with_db_write("import_data_package", |db| db.import_package(&value))?;
    if let Err(error) = data_migration::apply_sqlite_to_runtime(state.inner()) {
        if let Err(rollback_error) = backup::restore(state.inner(), &recovery_id) {
            return Err(format!(
                "导入后的本机状态物化失败：{error}；恢复 SQLite 与全部运行时投影也失败：{rollback_error}。请使用刚创建的恢复点 {recovery_id}"
            ));
        }
        return Err(format!(
            "导入后的本机状态物化失败，已从恢复点完整还原 SQLite、library.json、stats.json 与 vocab.json：{error}"
        ));
    }
    Ok(imported)
}

fn local_app_data_clear_targets(
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<HashSet<PathBuf>, String> {
    if state.sync_running.load(Ordering::Acquire) {
        return Err("同步任务正在进行，请完成后再清除此设备数据".into());
    }
    if !state.background_tasks.active_snapshots().is_empty() {
        return Err("后台任务正在运行，请完成或取消后再清除此设备数据".into());
    }
    if crate::window_commands::any_bound_reader_window(app) {
        return Err("请先关闭所有阅读窗口，再清除此设备数据".into());
    }

    let targets = [
        owned_app_directory(crate::profile::app_config_dir(), "配置")?,
        owned_app_directory(crate::profile::app_cache_dir(), "缓存")?,
        owned_app_directory(crate::profile::app_data_dir(), "本地数据")?,
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

    Ok(targets)
}

/// Verify that a later local clear can start before performing an irreversible
/// cloud operation. This command only inspects current runtime and file paths.
#[tauri::command]
pub(crate) fn clear_local_app_data_preflight(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    local_app_data_clear_targets(state.inner(), &app).map(|_| ())
}

/// Clear data owned by this installation without touching any original book
/// file referenced by the shelf. The UI reloads after this command returns.
#[tauri::command]
pub(crate) fn clear_local_app_data(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let targets = local_app_data_clear_targets(state.inner(), &app)?;

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
            if let Ok(mut database) = reopened {
                state.bind_sync_auto_scheduler(&mut database);
                if let Ok(mut guard) = state.db.lock() {
                    *guard = Some(database);
                }
            }
            return Err(error);
        }
    }

    let mut database = db::AppDb::open()?;
    state.bind_sync_auto_scheduler(&mut database);
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
