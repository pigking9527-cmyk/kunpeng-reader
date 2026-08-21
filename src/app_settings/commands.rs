//! Thin Tauri command adapters for account-level application settings.

use super::{
    app_settings_sync_get_inner, app_settings_sync_save_inner, AppSettingsSyncRequest,
    AppSettingsSyncSnapshot,
};
use crate::AppState;

#[tauri::command]
pub(crate) fn app_settings_sync_get(
    state: tauri::State<AppState>,
) -> Result<AppSettingsSyncSnapshot, String> {
    app_settings_sync_get_inner(state.inner())
}

#[tauri::command]
pub(crate) fn app_settings_sync_save(
    state: tauri::State<AppState>,
    request: AppSettingsSyncRequest,
) -> Result<AppSettingsSyncSnapshot, String> {
    app_settings_sync_save_inner(state.inner(), request)
}
