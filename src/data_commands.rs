//! Portable data package and recovery-point command boundary.
//!
//! These commands coordinate database migration, backup creation and runtime
//! cache refresh. Keeping that orchestration here leaves `main.rs` responsible
//! for application assembly instead of persistence workflows.

use crate::{atomic_file, backup, data_migration, AppState};
use tauri::Manager;

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
