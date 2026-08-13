//! Tauri command adapters for sync operations.
//!
//! This module deliberately owns only command-shaped input/output adaptation.
//! Authentication, HTTP, persistence, and account-switch rules remain in the
//! parent sync module so they have a single domain owner.

use super::{
    auth_request_from_command, auth_security_status_inner, auth_usage_status_inner,
    sync_get_settings_inner, AccountUsageStatus, AppState, AuthRequest, AuthResponse,
    AuthSecurityStatus, SyncSettings,
};
use tauri::Manager;

pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    sync_get_settings_inner(state.inner())
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
