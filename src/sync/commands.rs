//! Tauri command adapters for sync operations.
//!
//! This module deliberately owns only command-shaped input/output adaptation.
//! Authentication, HTTP, persistence, and account-switch rules remain in the
//! parent sync module so they have a single domain owner.

use super::{
    auth_request_from_command, auth_security_status_inner, auth_usage_status_inner,
    start_silent_startup_sync, sync_account_open_refresh_inner, sync_get_settings_inner,
    AccountUsageStatus, AppState, AuthRequest, AuthResponse, AuthSecurityStatus,
    SyncConnectionStatus, SyncSettings,
};
use tauri::Manager;

pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    sync_get_settings_inner(state.inner())
}

pub(crate) async fn sync_account_open_refresh(
    app: tauri::AppHandle,
) -> Result<SyncConnectionStatus, String> {
    let status = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || sync_account_open_refresh_inner(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("同步服务状态检查失败：{error}"))??;
    if status.online && status.credentials_ready {
        // The status path obtained the token without interaction, so this
        // refresh cannot introduce a Keychain prompt. Existing single-flight
        // protection coalesces it with any startup/manual run.
        start_silent_startup_sync(app);
    }
    Ok(status)
}

pub(crate) async fn auth_register(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    run_auth_request(app, "/v1/auth/register", request).await
}

pub(crate) async fn auth_login(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    run_auth_request(app, "/v1/auth/login", request).await
}

async fn run_auth_request(
    app: tauri::AppHandle,
    endpoint: &'static str,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        auth_request_from_command(app.state::<AppState>().inner(), endpoint, request)
    })
    .await
    .map_err(|error| format!("认证任务失败：{error}"))?
}

pub(crate) async fn auth_security_status(
    app: tauri::AppHandle,
) -> Result<AuthSecurityStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        auth_security_status_inner(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("账户安全任务失败：{error}"))?
}

pub(crate) async fn auth_usage_status(app: tauri::AppHandle) -> Result<AccountUsageStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        auth_usage_status_inner(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("账户额度任务失败：{error}"))?
}
