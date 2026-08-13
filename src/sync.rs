use crate::{
    background_tasks::{BackgroundTaskKind, TaskControlSignal, TaskRunGuard},
    data_migration, db, secret_store, AppState, DEFAULT_SYNC_URL,
};

mod client;
mod commands;
mod protocol;
mod reconcile;
mod retry;
mod validation;

use client::{
    agent_with_timeout, authenticated_json, JsonRequestError, SYNC_PROTOCOL_HEADER,
    SYNC_PROTOCOL_VERSION,
};
use protocol::{
    cursor_strictly_advances, inventory_matches, newer_cursor, reconcile_proves_inventory,
    sync_push_batches, SyncInventoryResponse, SyncPullResponse, SyncPushRequest, SyncPushResponse,
    SyncReconcileResponse,
};
use reader_core::sync::sync_scope_id;
use reconcile::{reconcile_request_body, reconcile_upload_entities};
use retry::sync_request_with_retry_delays;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use validation::{
    account_sync_scope, default_data_generation, ensure_data_generation, normalize_auth_base,
    normalize_sync_base,
};

const SYNC_PULL_PAGE_SIZE: usize = 1_000;
const MAX_SYNC_PULL_PAGES: usize = 1_000;
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_REQUEST_ATTEMPTS: usize = 6;
const SYNC_RETRY_DELAYS_MS: &[u64] = &[1_000, 2_000, 4_000, 8_000, 16_000];
const SYNC_PAUSED: &str = "__sync_paused__";
const SYNC_CANCELLED: &str = "__sync_cancelled__";
struct SyncRunGuard<'a>(&'a AtomicBool);

impl Drop for SyncRunGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn acquire_account_change(state: &AppState) -> Result<SyncRunGuard<'_>, String> {
    state
        .sync_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "同步任务正在进行，请在完成后再切换账户".to_string())?;
    Ok(SyncRunGuard(&state.sync_running))
}

fn check_sync_control(task: Option<&TaskRunGuard>) -> Result<(), String> {
    match task.map(TaskRunGuard::control_signal) {
        Some(TaskControlSignal::Pause) => Err(SYNC_PAUSED.into()),
        Some(TaskControlSignal::Cancel) => Err(SYNC_CANCELLED.into()),
        _ => Ok(()),
    }
}

fn log_sync_stage(stage: &str, started: Instant, detail: impl std::fmt::Display) {
    let elapsed_ms = started.elapsed().as_millis();
    crate::diagnostics::record_sync_stage(
        stage,
        u64::try_from(elapsed_ms).unwrap_or(u64::MAX),
        true,
    );
    crate::log(&format!(
        "[sync] stage={stage} elapsed_ms={} {detail}",
        elapsed_ms
    ));
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct SyncSettings {
    url: String,
    #[serde(skip_serializing)]
    token: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    user_id: String,
    #[serde(default = "default_data_generation")]
    data_generation: i64,
    #[serde(default)]
    last_sync_at: i64,
    #[serde(default)]
    last_sync_pushed: usize,
    #[serde(default)]
    last_sync_pulled: usize,
    #[serde(default)]
    last_sync_accepted: usize,
    #[serde(default)]
    last_sync_ignored: usize,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct AuthUser {
    id: String,
    username: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthResponse {
    ok: bool,
    #[serde(skip_serializing)]
    token: String,
    user: AuthUser,
    data_generation: i64,
    sync_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthMeResponse {
    user: AuthUser,
    data_generation: i64,
}

impl AuthMeResponse {
    fn into_verified_identity(self) -> Result<(AuthUser, i64), String> {
        if self.user.id.trim().is_empty() || self.data_generation < 1 {
            return Err("服务器没有返回账户 ID".into());
        }
        Ok((self.user, self.data_generation))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    ok: bool,
    message: String,
    pushed: usize,
    pulled: usize,
    accepted: usize,
    ignored: usize,
    server_time: i64,
}

#[derive(Clone, PartialEq, Eq)]
struct SyncSettingsRecord {
    url: String,
    protected_token: Option<String>,
    legacy_token: String,
    username: String,
    user_id: String,
    data_generation: i64,
    last_sync_at: i64,
    last_sync_pushed: usize,
    last_sync_pulled: usize,
    last_sync_accepted: usize,
    last_sync_ignored: usize,
}

fn sync_settings_record_from_db(db: &db::AppDb) -> SyncSettingsRecord {
    let url = db
        .metadata("sync_url")
        .unwrap_or_else(|| DEFAULT_SYNC_URL.to_string());
    let user_id = db.metadata("sync_user_id").unwrap_or_default();
    let scope = normalize_sync_base(&url)
        .ok()
        .filter(|_| !user_id.trim().is_empty())
        .map(|base| sync_scope_id(&base, &user_id));
    let scoped = |key: &str| {
        scope
            .as_deref()
            .and_then(|scope| db.sync_scope_metadata(scope, key))
    };
    SyncSettingsRecord {
        url,
        protected_token: db.metadata("sync_token_protected"),
        legacy_token: db.metadata("sync_token").unwrap_or_default(),
        username: db.metadata("sync_username").unwrap_or_default(),
        user_id,
        data_generation: scoped("data_generation")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(1)
            .max(1),
        last_sync_at: scoped("last_sync_at")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0),
        last_sync_pushed: scoped("last_pushed")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_pulled: scoped("last_pulled")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_accepted: scoped("last_accepted")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_ignored: scoped("last_ignored")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
    }
}

fn resolve_sync_settings(record: SyncSettingsRecord) -> Result<SyncSettings, String> {
    let token = if let Some(protected) = record.protected_token.as_deref() {
        secret_store::unprotect_secret(protected)
    } else {
        Ok(record.legacy_token)
    }?;
    Ok(SyncSettings {
        url: record.url,
        token,
        username: record.username,
        user_id: record.user_id,
        data_generation: record.data_generation,
        last_sync_at: record.last_sync_at,
        last_sync_pushed: record.last_sync_pushed,
        last_sync_pulled: record.last_sync_pulled,
        last_sync_accepted: record.last_sync_accepted,
        last_sync_ignored: record.last_sync_ignored,
    })
}

fn read_sync_settings(state: &AppState, operation: &'static str) -> Result<SyncSettings, String> {
    let record = state.with_db_read(operation, |db| Ok(sync_settings_record_from_db(db)))?;
    // Preserve the existing settings surface: an inaccessible OS credential
    // is represented as an empty token and therefore as a logged-out account.
    Ok(resolve_sync_settings(record).unwrap_or_default())
}

fn read_sync_token(db: &db::AppDb) -> Result<String, String> {
    resolve_sync_settings(sync_settings_record_from_db(db)).map(|settings| settings.token)
}

fn migrate_sync_token_to_platform_store(db: &mut db::AppDb) -> Result<(), String> {
    let stored = db.metadata("sync_token_protected").unwrap_or_default();
    if secret_store::is_platform_protected(&stored) {
        return Ok(());
    }
    let token = read_sync_token(db)?;
    if token.is_empty() {
        return Ok(());
    }
    let protected = protect_sync_token(&token)?;
    db.set_metadata_batch(&[("sync_token_protected", &protected), ("sync_token", "")])
}

fn protect_sync_token(token: &str) -> Result<String, String> {
    secret_store::protect_secret(token.trim())
}

fn auth_base_from_state(state: &AppState, requested: &str) -> Result<String, String> {
    if !requested.trim().is_empty() {
        return normalize_auth_base(requested, DEFAULT_SYNC_URL);
    }
    state.with_db_read("auth_base_from_state", |db| {
        normalize_auth_base(&sync_settings_record_from_db(db).url, DEFAULT_SYNC_URL)
    })
}

fn fetch_auth_user(base: &str, token: &str, timeout: Duration) -> Result<(AuthUser, i64), String> {
    if token.trim().is_empty() {
        return Err("同步 token 为空".into());
    }
    let agent = agent_with_timeout(timeout);
    let response: AuthMeResponse =
        authenticated_json(&agent, base, "/v1/auth/me", token.trim(), None).map_err(|error| {
            match error {
                JsonRequestError::Request(error) => format!("账户身份确认失败：{error}"),
                JsonRequestError::Decode(error) => format!("账户身份返回解析失败：{error}"),
            }
        })?;
    response.into_verified_identity()
}

fn save_sync_account(
    db: &mut db::AppDb,
    base: &str,
    token: &str,
    user: &AuthUser,
    data_generation: i64,
) -> Result<String, String> {
    let scope = account_sync_scope(base, &user.id)?;
    if token.trim().is_empty() {
        return Err("服务器没有返回登录 token".into());
    }
    if data_generation < 1 {
        return Err("服务器返回的云端数据版本无效".into());
    }
    let previous_generation = db
        .sync_scope_metadata(&scope, "data_generation")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if data_generation > 1
        && previous_generation != data_generation
        && !db.all_sync_entities()?.is_empty()
    {
        return Err(
            "云端数据已经清除；为防止旧数据复活，请先在“数据与隐私”中清除此设备数据，再重新登录"
                .into(),
        );
    }
    let protected = protect_sync_token(token)?;
    db.set_metadata_batch(&[
        ("sync_url", base),
        ("sync_token_protected", &protected),
        // Clear the legacy plaintext slot so new writes do not leave secrets there.
        ("sync_token", ""),
        ("sync_username", user.username.trim()),
        ("sync_user_id", user.id.trim()),
        (db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY, &scope),
    ])?;
    db.set_sync_scope_metadata(&scope, "data_generation", &data_generation.to_string())?;
    db.migrate_legacy_sync_state(&scope)?;
    Ok(scope)
}

fn clear_sync_account(db: &mut db::AppDb) -> Result<(), String> {
    let protected = protect_sync_token("")?;
    db.set_metadata_batch(&[
        ("sync_token_protected", &protected),
        ("sync_token", ""),
        ("sync_username", ""),
        ("sync_user_id", ""),
        (db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY, ""),
    ])
}

fn saved_account_record_unchanged(
    db: &db::AppDb,
    expected: &SyncSettingsRecord,
    expected_verified_scope: &str,
) -> Result<bool, String> {
    let current = sync_settings_record_from_db(db);
    Ok(current == *expected
        && db
            .metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
            .unwrap_or_default()
            == expected_verified_scope)
}

/// Assign pre-v4 global state to the currently saved account before replacing
/// or clearing its credentials. Legacy tokens (including the server's default
/// account token) are resolved through `/v1/auth/me`; an unverifiable owner is
/// deliberately sealed as unclaimed so the next login performs a full sync.
fn prepare_saved_account_for_switch(state: &AppState) -> Result<(), String> {
    let (record, verified_scope) = state.with_db_read("prepare_saved_account_snapshot", |db| {
        Ok((
            sync_settings_record_from_db(db),
            db.metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
                .unwrap_or_default(),
        ))
    })?;
    let saved = resolve_sync_settings(record.clone()).unwrap_or_default();
    let base = normalize_sync_base(&saved.url).ok();
    let stored_scope = base
        .as_deref()
        .and_then(|base| account_sync_scope(base, &saved.user_id).ok());
    let resolved_user = match (base.as_deref(), stored_scope.as_deref()) {
        (Some(_), Some(scope)) if scope == verified_scope => Some((
            AuthUser {
                id: saved.user_id.trim().to_string(),
                username: saved.username.clone(),
            },
            saved.data_generation,
        )),
        (Some(base), _) if !saved.token.trim().is_empty() => {
            match fetch_auth_user(base, &saved.token, SYNC_REQUEST_TIMEOUT) {
                Ok(user) => Some(user),
                Err(error) => {
                    crate::log(&format!(
                        "[sync] legacy_account_resolution=unclaimed error={error}"
                    ));
                    None
                }
            }
        }
        _ => None,
    };

    state.with_db_write("prepare_saved_account_commit", |db| {
        if !saved_account_record_unchanged(db, &record, &verified_scope)? {
            return Err("同步账户设置已变化，请重试".into());
        }
        match (base.as_deref(), resolved_user) {
            (Some(base), Some((user, data_generation))) => {
                if saved.token.trim().is_empty() {
                    let scope = account_sync_scope(base, &user.id)?;
                    db.migrate_legacy_sync_state(&scope)?;
                } else {
                    save_sync_account(db, base, &saved.token, &user, data_generation)?;
                }
            }
            _ => {
                db.seal_unclaimed_legacy_sync_state()?;
            }
        }
        Ok(())
    })
}

#[derive(Default)]
struct PushTotals {
    pushed: usize,
    accepted: usize,
    ignored: usize,
    server_time: i64,
}

#[allow(clippy::too_many_arguments)]
fn push_sync_entities(
    state: &AppState,
    task: Option<&TaskRunGuard>,
    retry_delays_ms: &[u64],
    agent: &ureq::Agent,
    base: &str,
    token: &str,
    scope: &str,
    data_generation: i64,
    entities: &[db::SyncEntity],
    progress_base: usize,
) -> Result<PushTotals, String> {
    let mut totals = PushTotals::default();
    for (batch_index, batch) in sync_push_batches(entities)?.into_iter().enumerate() {
        check_sync_control(task)?;
        let push_body = SyncPushRequest::new(data_generation, &batch);
        let push: SyncPushResponse =
            sync_request_with_retry_delays("push", task, retry_delays_ms, || {
                agent
                    .post(&format!("{base}/v1/sync/push"))
                    .header("Authorization", &format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                    // One mutation ID per batch makes retries idempotent at the v5 boundary.
                    .send_json(push_body.clone())?
                    .body_mut()
                    .read_json()
            })?;
        if push.mutation_id != push_body.mutation_id() {
            return Err("push 响应请求 ID 不匹配，已拒绝提交本地同步状态".into());
        }
        ensure_data_generation(data_generation, push.data_generation)?;
        totals.pushed += batch.len();
        let acknowledged = push.accepted_entities();
        let authoritative = push.conflicts();
        totals.accepted += acknowledged.len();
        totals.ignored += authoritative.len();
        totals.server_time = totals.server_time.max(crate::now_ms() as i64);
        let commit_started = Instant::now();
        state.with_db_write("sync_push_commit", |db| {
            let _ = db.commit_sync_push(scope, &acknowledged, &authoritative)?;
            Ok(())
        })?;
        log_sync_stage(
            "push_commit",
            commit_started,
            format_args!("batch={} entities={}", batch_index + 1, batch.len()),
        );
        if let Some(task) = task {
            task.checkpoint(
                (progress_base + totals.pushed) as u64,
                (progress_base + entities.len()) as u64,
                format!("已推送第 {} 批，共 {} 条", batch_index + 1, totals.pushed),
                format!(
                    r#"{{"phase":"push","batch":{},"pushed":{}}}"#,
                    batch_index + 1,
                    totals.pushed
                ),
            )?;
        }
    }
    Ok(totals)
}

fn save_auth_response(db: &mut db::AppDb, base: &str, res: &AuthResponse) -> Result<(), String> {
    save_sync_account(db, base, &res.token, &res.user, res.data_generation).map(|_| ())
}

pub(crate) fn auth_request_inner(
    state: &AppState,
    endpoint: &str,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    let base = normalize_auth_base(&url, DEFAULT_SYNC_URL)?;
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".into());
    }
    let _account_change = acquire_account_change(state)?;
    let installation_id = state.with_db_read("auth_installation_id", |db| Ok(db.device_id()))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .build()
        .into();
    let body = serde_json::json!({
        "username": username,
        "password": password,
        "installationId": installation_id,
        "deviceName": std::env::consts::OS,
    });
    let res: AuthResponse = agent
        .post(&format!("{base}{endpoint}"))
        .header("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("认证请求失败：{e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("认证返回解析失败：{e}"))?;
    if res.token.trim().is_empty() || res.user.id.trim().is_empty() {
        return Err("服务器返回的登录身份不完整".into());
    }
    // A failed login leaves the previous account untouched. Once the new
    // credentials are verified, preserve (or safely retire) the old global
    // baseline before atomically installing the new account tuple.
    prepare_saved_account_for_switch(state)?;
    state.with_db_write("auth_save_response", |db| {
        save_auth_response(db, &base, &res)
    })?;
    Ok(res)
}

pub(crate) fn sync_get_settings_inner(state: &AppState) -> Result<SyncSettings, String> {
    read_sync_settings(state, "sync_get_settings")
}

// `tauri::generate_handler!` needs the command macro's private helper symbols
// in this parent module, so each exported command is a deliberately tiny
// forwarder to the adapter module.
#[tauri::command]
pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    commands::sync_get_settings(state)
}

#[tauri::command]
pub(crate) async fn sync_set_settings(
    app: tauri::AppHandle,
    url: String,
    token: String,
) -> Result<SyncSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let base = normalize_sync_base(&url)?;
        let _account_change = acquire_account_change(state.inner())?;
        // Validate a supplied token and obtain its stable user id before any
        // local account setting changes.
        let user = if token.trim().is_empty() {
            None
        } else {
            Some(fetch_auth_user(&base, &token, SYNC_REQUEST_TIMEOUT)?)
        };
        prepare_saved_account_for_switch(state.inner())?;
        let record = state.with_db_write("sync_set_settings", |db| {
            if let Some((user, data_generation)) = user {
                save_sync_account(db, &base, &token, &user, data_generation)?;
            } else {
                let protected = protect_sync_token("")?;
                db.set_metadata_batch(&[
                    ("sync_url", &base),
                    ("sync_token_protected", &protected),
                    ("sync_token", ""),
                    ("sync_username", ""),
                    ("sync_user_id", ""),
                    (db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY, ""),
                ])?;
            }
            Ok(sync_settings_record_from_db(db))
        })?;
        Ok(resolve_sync_settings(record).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("保存同步设置任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_logout(app: tauri::AppHandle) -> Result<SyncSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let settings = read_sync_settings(state.inner(), "auth_logout_settings")?;
        prepare_saved_account_for_switch(state.inner())?;
        if !settings.token.is_empty() {
            if let Ok(base) = normalize_sync_base(&settings.url) {
                // Remote revocation is best effort: an offline user must still
                // be able to remove credentials from this device immediately.
                let agent: ureq::Agent = ureq::Agent::config_builder()
                    .timeout_global(Some(std::time::Duration::from_secs(8)))
                    .build()
                    .into();
                let _ = agent
                    .post(&format!("{base}/v1/auth/logout"))
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .header("Content-Type", "application/json")
                    .send_json(serde_json::json!({}));
            }
        }
        let record = state.with_db_write("auth_logout_clear", |db| {
            clear_sync_account(db)?;
            Ok(sync_settings_record_from_db(db))
        })?;
        Ok(resolve_sync_settings(record).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("退出登录任务失败：{e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthRequest {
    url: String,
    username: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistrationStartRequest {
    url: String,
    username: String,
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistrationConfirmRequest {
    url: String,
    username: String,
    email: String,
    code: String,
    password: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistrationStartResponse {
    ok: bool,
    expires_in: u64,
}

#[tauri::command]
pub(crate) async fn auth_register_start(
    app: tauri::AppHandle,
    request: RegistrationStartRequest,
) -> Result<RegistrationStartResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let base = normalize_auth_base(&request.url, DEFAULT_SYNC_URL)?;
        let username = request.username.trim();
        let email = request.email.trim();
        if username.is_empty() || email.is_empty() {
            return Err("请输入账号和邮箱".into());
        }
        let _account_change = acquire_account_change(state.inner())?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(25)))
            .build()
            .into();
        agent
            .post(&format!("{base}/v1/auth/register/start"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({"username": username, "email": email}))
            .map_err(|e| format!("发送注册验证码失败：{e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("注册返回解析失败：{e}"))
    })
    .await
    .map_err(|e| format!("注册任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_register_confirm(
    app: tauri::AppHandle,
    request: RegistrationConfirmRequest,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let base = normalize_auth_base(&request.url, DEFAULT_SYNC_URL)?;
        if request.username.trim().is_empty()
            || request.email.trim().is_empty()
            || request.code.trim().is_empty()
            || request.password.is_empty()
        {
            return Err("请输入账号、邮箱、验证码和密码".into());
        }
        let _account_change = acquire_account_change(state.inner())?;
        let installation_id =
            state.with_db_read("auth_register_installation", |db| Ok(db.device_id()))?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(25)))
            .build()
            .into();
        let res: AuthResponse = agent
            .post(&format!("{base}/v1/auth/register/confirm"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({
                "username": request.username.trim(),
                "email": request.email.trim(),
                "code": request.code.trim(),
                "password": request.password,
                "installationId": installation_id,
                "deviceName": std::env::consts::OS,
            }))
            .map_err(|e| format!("确认注册失败：{e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("注册返回解析失败：{e}"))?;
        if res.token.trim().is_empty() || res.user.id.trim().is_empty() {
            return Err("服务器返回的登录身份不完整".into());
        }
        prepare_saved_account_for_switch(state.inner())?;
        state.with_db_write("auth_register_save_response", |db| {
            save_auth_response(db, &base, &res)
        })?;
        Ok(res)
    })
    .await
    .map_err(|e| format!("注册任务失败：{e}"))?
}

pub(crate) fn auth_request_from_command(
    state: &AppState,
    endpoint: &str,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    let AuthRequest {
        url,
        username,
        password,
    } = request;
    auth_request_inner(state, endpoint, url, username, password)
}

#[tauri::command]
pub(crate) async fn auth_register(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    commands::auth_register(app, request).await
}

#[tauri::command]
pub(crate) async fn auth_login(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    commands::auth_login(app, request).await
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthSecurityStatus {
    pub email_bound: bool,
    pub email: String,
    pub recovery_available: bool,
    pub mail_configured: bool,
    pub sync_enabled: bool,
}

/// Aggregate account usage only. Entity payloads and account identifiers never
/// cross this command boundary, so the account overview cannot expose sync data.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountUsageStatus {
    pub storage_bytes: u64,
    pub storage_limit_bytes: u64,
    pub daily_written_bytes: u64,
    pub daily_write_limit_bytes: u64,
    pub daily_entity_writes: u64,
    pub daily_entity_write_limit: u64,
    pub daily_window_at: i64,
    pub daily_reset_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailBindRequest {
    pub email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailConfirmRequest {
    pub email: String,
    pub code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCodeRequest {
    pub code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailRebindNewRequest {
    pub email: String,
    pub rebind_grant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailRebindGrantResponse {
    rebind_grant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordChangeRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordResetRequest {
    pub url: String,
    pub username: String,
    pub email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordResetConfirmRequest {
    pub url: String,
    pub username: String,
    pub code: String,
    pub new_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataResetRequest {
    pub password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountDeleteRequest {
    pub password: String,
    pub username: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataResetResponse {
    ok: bool,
    data_generation: i64,
    tokens_revoked: bool,
}

/// Non-sensitive summary of the server-side entity history available for a
/// deliberate cloud restore. It intentionally carries no entity payloads.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRecoveryStatus {
    pub available: bool,
    pub retention_days: i64,
    pub restorable_from: i64,
    pub latest_version_at: i64,
    pub version_count: i64,
    pub data_generation: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRecoveryRestoreRequest {
    pub target_at: i64,
    pub data_generation: i64,
    pub password: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRecoveryRestoreResponse {
    pub data_generation: i64,
    pub tokens_revoked: bool,
    pub target_at: i64,
    pub restored_at: i64,
    pub restored_entities: i64,
    pub tombstoned_entities: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretBundleState {
    pub secret_bundle_epoch: u64,
}

fn authenticated_endpoint<T: DeserializeOwned>(
    state: &AppState,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<T, String> {
    let settings = read_sync_settings(state, "authenticated_endpoint_settings")?;
    let base = normalize_sync_base(&settings.url)?;
    if settings.token.trim().is_empty() {
        return Err("请先登录账号".into());
    }
    let agent = agent_with_timeout(SYNC_REQUEST_TIMEOUT);
    authenticated_json(&agent, &base, path, &settings.token, body).map_err(|error| match error {
        JsonRequestError::Request(error) => format!("账户安全请求失败：{error}"),
        JsonRequestError::Decode(error) => format!("账户安全返回解析失败：{error}"),
    })
}

pub(crate) fn private_secret_bundle_state(state: &AppState) -> Result<SecretBundleState, String> {
    authenticated_endpoint(state, "/v1/sync/secret-state", None)
}

pub(crate) fn reset_private_secret_bundle_state(
    state: &AppState,
) -> Result<SecretBundleState, String> {
    authenticated_endpoint(
        state,
        "/v1/sync/secret-state/reset",
        Some(serde_json::json!({})),
    )
}

pub(crate) fn auth_security_status_inner(state: &AppState) -> Result<AuthSecurityStatus, String> {
    authenticated_endpoint(state, "/v1/auth/security", None)
}

pub(crate) fn auth_usage_status_inner(state: &AppState) -> Result<AccountUsageStatus, String> {
    authenticated_endpoint(state, "/v1/auth/usage", None)
}

#[tauri::command]
pub(crate) async fn auth_security_status(
    app: tauri::AppHandle,
) -> Result<AuthSecurityStatus, String> {
    commands::auth_security_status(app).await
}

#[tauri::command]
pub(crate) async fn auth_usage_status(app: tauri::AppHandle) -> Result<AccountUsageStatus, String> {
    commands::auth_usage_status(app).await
}

#[tauri::command]
pub(crate) async fn auth_bind_email_start(
    app: tauri::AppHandle,
    request: EmailBindRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/start",
            Some(serde_json::json!({"email": request.email})),
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("绑定邮箱任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_bind_email_confirm(
    app: tauri::AppHandle,
    request: EmailConfirmRequest,
) -> Result<AuthSecurityStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/confirm",
            Some(serde_json::json!({"email": request.email, "code": request.code})),
        )?;
        authenticated_endpoint(app.state::<AppState>().inner(), "/v1/auth/security", None)
    })
    .await
    .map_err(|e| format!("确认邮箱任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_rebind_email_old_start(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/rebind/old/start",
            Some(serde_json::json!({})),
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("验证旧邮箱任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_rebind_email_old_confirm(
    app: tauri::AppHandle,
    request: EmailCodeRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response: EmailRebindGrantResponse = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/rebind/old/confirm",
            Some(serde_json::json!({"code": request.code})),
        )?;
        Ok(response.rebind_grant)
    })
    .await
    .map_err(|e| format!("确认旧邮箱失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_rebind_email_new_start(
    app: tauri::AppHandle,
    request: EmailRebindNewRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/rebind/new/start",
            Some(serde_json::json!({
                "email": request.email,
                "rebindGrant": request.rebind_grant,
            })),
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("发送新邮箱验证码失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_rebind_email_new_confirm(
    app: tauri::AppHandle,
    request: EmailConfirmRequest,
) -> Result<AuthSecurityStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/email/rebind/new/confirm",
            Some(serde_json::json!({"email": request.email, "code": request.code})),
        )?;
        authenticated_endpoint(app.state::<AppState>().inner(), "/v1/auth/security", None)
    })
    .await
    .map_err(|e| format!("确认新邮箱失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_change_password(
    app: tauri::AppHandle,
    request: PasswordChangeRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/auth/password/change",
            Some(serde_json::json!({
                "currentPassword": request.current_password,
                "newPassword": request.new_password,
            })),
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("修改密码任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn sync_reset_cloud_data(
    app: tauri::AppHandle,
    request: DataResetRequest,
) -> Result<DataResetResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.password.is_empty() {
            return Err("请输入登录密码".into());
        }
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let response: DataResetResponse = authenticated_endpoint(
            state.inner(),
            "/v1/sync/data/reset",
            Some(serde_json::json!({"password": request.password})),
        )?;
        state.with_db_write("sync_reset_cloud_data_clear_account", |db| {
            clear_sync_account(db)?;
            Ok(response)
        })
    })
    .await
    .map_err(|e| format!("清除云端数据任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn sync_recovery_status(
    app: tauri::AppHandle,
) -> Result<SyncRecoveryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/v1/sync/recovery/status",
            None,
        )
    })
    .await
    .map_err(|e| format!("读取云端恢复状态任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn sync_recovery_restore(
    app: tauri::AppHandle,
    request: SyncRecoveryRestoreRequest,
) -> Result<SyncRecoveryRestoreResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.password.is_empty() {
            return Err("请输入登录密码".into());
        }
        if request.target_at <= 0 || request.data_generation <= 0 {
            return Err("云端恢复请求无效".into());
        }
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let response: SyncRecoveryRestoreResponse = authenticated_endpoint(
            state.inner(),
            "/v1/sync/recovery/restore",
            Some(serde_json::json!({
                "targetAt": request.target_at,
                "dataGeneration": request.data_generation,
                "password": request.password,
                "confirm": true,
            })),
        )?;
        // The server revokes every token at restore time. Remove the local
        // credential too so this installation cannot accidentally write its
        // pre-restore state back before the user deliberately reauthenticates.
        state.with_db_write("sync_recovery_restore_clear_account", |db| {
            clear_sync_account(db)?;
            Ok(response)
        })
    })
    .await
    .map_err(|e| format!("云端恢复任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_delete_account(
    app: tauri::AppHandle,
    request: AccountDeleteRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.password.is_empty() || request.username.trim().is_empty() {
            return Err("请输入登录密码和完整账号名".into());
        }
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let _: serde_json::Value = authenticated_endpoint(
            state.inner(),
            "/v1/auth/account/delete",
            Some(serde_json::json!({
                "password": request.password,
                "username": request.username.trim(),
            })),
        )?;
        state.with_db_write("auth_delete_account_clear", clear_sync_account)
    })
    .await
    .map_err(|e| format!("删除账号任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_request_password_reset(
    app: tauri::AppHandle,
    request: PasswordResetRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let base = auth_base_from_state(state.inner(), &request.url)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(SYNC_REQUEST_TIMEOUT))
            .build()
            .into();
        let _: serde_json::Value = agent
            .post(&format!("{base}/v1/auth/password/reset/request"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({"username": request.username, "email": request.email}))
            .map_err(|e| format!("找回密码请求失败：{e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("找回密码返回解析失败：{e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("找回密码任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_confirm_password_reset(
    app: tauri::AppHandle,
    request: PasswordResetConfirmRequest,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let base = auth_base_from_state(state.inner(), &request.url)?;
        let installation_id =
            state.with_db_read("password_reset_installation", |db| Ok(db.device_id()))?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(SYNC_REQUEST_TIMEOUT))
            .build()
            .into();
        let response: AuthResponse = agent
            .post(&format!("{base}/v1/auth/password/reset/confirm"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({
                "username": request.username,
                "code": request.code,
                "newPassword": request.new_password,
                "installationId": installation_id,
                "deviceName": std::env::consts::OS,
            }))
            .map_err(|e| format!("重置密码请求失败：{e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("重置密码返回解析失败：{e}"))?;
        if response.token.trim().is_empty() || response.user.id.trim().is_empty() {
            return Err("服务器返回的登录身份不完整".into());
        }
        let state = app.state::<AppState>();
        prepare_saved_account_for_switch(state.inner())?;
        state.with_db_write("password_reset_save_response", |db| {
            save_auth_response(db, &base, &response)
        })?;
        Ok(response)
    })
    .await
    .map_err(|e| format!("重置密码任务失败：{e}"))?
}

fn sync_now_inner_with_limits_impl(
    state: &AppState,
    request_timeout: Duration,
    max_pull_pages: usize,
    retry_delays_ms: &[u64],
    task: Option<&TaskRunGuard>,
) -> Result<SyncReport, String> {
    let sync_started = Instant::now();
    check_sync_control(task)?;
    if state
        .sync_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("同步任务正在进行".into());
    }
    let _sync_guard = SyncRunGuard(&state.sync_running);

    let prepare_started = Instant::now();
    data_migration::ensure_content_ids_for_sync(state)?;
    let _ = crate::ai_reader::materialize_library_profiles_into_model_tags(state)?;
    // Snapshot local JSON first so unsynced edits are represented in SQLite.
    data_migration::migrate_json_to_sqlite(state)?;
    // v5 is intentionally incompatible with the retired 1–10 jump-back
    // setting. Normalize the local entity before pending rows are selected;
    // otherwise an unopened legacy reader setting could be uploaded verbatim.
    crate::app_settings::normalize_protocol_v5_entity(state)?;
    log_sync_stage("prepare_local", prepare_started, "status=ok");
    let (initial_record, initial_verified_scope) =
        state.with_db_read("sync_initial_account_snapshot", |db| {
            Ok((
                sync_settings_record_from_db(db),
                db.metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
                    .unwrap_or_default(),
            ))
        })?;
    let initial_settings = resolve_sync_settings(initial_record.clone()).unwrap_or_default();
    if initial_settings.url.trim().is_empty() || initial_settings.token.trim().is_empty() {
        return Err("请先登录账号".into());
    }
    let base = normalize_sync_base(&initial_settings.url)?;
    let stored_scope = account_sync_scope(&base, &initial_settings.user_id).ok();
    let identity_is_verified = stored_scope.as_deref() == Some(initial_verified_scope.as_str());
    let resolved_user = if identity_is_verified {
        None
    } else {
        check_sync_control(task)?;
        Some(fetch_auth_user(
            &base,
            &initial_settings.token,
            request_timeout,
        )?)
    };
    let (settings_record, scope, cursor, is_initial_scope_sync) = {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        if !saved_account_record_unchanged(db, &initial_record, &initial_verified_scope)? {
            return Err("同步账户设置已变化，请重试".into());
        }
        migrate_sync_token_to_platform_store(db)?;
        let scope = if let Some((user, data_generation)) = resolved_user {
            save_sync_account(db, &base, &initial_settings.token, &user, data_generation)?
        } else {
            if base != initial_settings.url {
                db.set_metadata("sync_url", &base)?;
            }
            let scope = account_sync_scope(&base, &initial_settings.user_id)?;
            db.migrate_legacy_sync_state(&scope)?;
            scope
        };
        let settings_record = sync_settings_record_from_db(db);
        if db
            .metadata(crate::private_sync::SYNC_FILTERS_CHANGED_KEY)
            .as_deref()
            == Some("1")
        {
            // A previously disabled category may have been skipped while the
            // cursor advanced. Start from the beginning once it is enabled.
            db.set_sync_scope_metadata(&scope, "cursor", "")?;
        }
        // v4 stored a timestamp-like cursor; v5 Axum uses a monotonically
        // increasing server sequence. Never reinterpret an old opaque value
        // as the new cursor or an initial v5 pull could skip existing rows.
        let protocol_upgraded = db
            .sync_scope_metadata(&scope, "protocol_version")
            .as_deref()
            != Some("5");
        if protocol_upgraded {
            db.set_sync_scope_metadata(&scope, "cursor", "")?;
            db.set_sync_scope_metadata(&scope, "protocol_version", "5")?;
        }
        let is_initial_scope_sync =
            protocol_upgraded || db.sync_scope_metadata(&scope, "last_sync_at").is_none();
        let cursor = db.sync_scope_metadata(&scope, "cursor").unwrap_or_default();
        (settings_record, scope, cursor, is_initial_scope_sync)
    };
    let settings = resolve_sync_settings(settings_record).unwrap_or_default();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(request_timeout))
        .build()
        .into();

    // Pull before push. A newly imported zero-progress book must not overwrite
    // the established position from another computer. Continue paging until the
    // server confirms that this cursor has caught up.
    let mut pulled = 0u32;
    let mut pull_server_time = 0i64;
    let mut sync_cursor = cursor.clone();
    let mut pull_cursor = if cursor.is_empty() {
        "0".to_string()
    } else {
        cursor
    };
    let mut pull_completed = false;
    for page_index in 0..max_pull_pages {
        check_sync_control(task)?;
        let pull: SyncPullResponse =
            sync_request_with_retry_delays("pull", task, retry_delays_ms, || {
                agent
                    .get(&format!("{base}/v1/sync/pull"))
                    .query("cursor", &pull_cursor)
                    .query("limit", SYNC_PULL_PAGE_SIZE.to_string())
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                    .call()?
                    .body_mut()
                    .read_json()
            })?;
        ensure_data_generation(settings.data_generation, pull.data_generation)?;
        pull_server_time = pull_server_time.max(crate::now_ms() as i64);
        let next_cursor = pull.next_cursor.to_string();
        if pull.has_more && !cursor_strictly_advances(&pull_cursor, &next_cursor) {
            return Err("pull 游标没有前进，已停止以避免重复同步".into());
        }
        let checkpoint_base = if sync_cursor.is_empty() {
            pull_cursor.as_str()
        } else {
            sync_cursor.as_str()
        };
        let page_checkpoint = newer_cursor(checkpoint_base, &next_cursor);
        let merge_started = Instant::now();
        state.with_db_read("sync_pull_scope_check", |db| {
            db.ensure_active_sync_scope(&scope)
        })?;
        let has_more = pull.has_more;
        let pulled_entities = pull.into_entities();
        let pulled_entity_count = pulled_entities.len();
        let enabled_entities: Vec<db::SyncEntity> =
            state.with_db_read("sync_pull_enabled_entities", |db| {
                Ok(pulled_entities
                    .iter()
                    .filter(|entity| crate::private_sync::is_entity_enabled(db, &entity.kind))
                    .cloned()
                    .collect::<Vec<_>>())
            })?;
        data_migration::merge_pulled_book_states(state, &enabled_entities)?;
        pulled += state.with_db_write("sync_pull_commit", |db| {
            db.import_sync_page_with_remote_app_settings_priority(
                &scope,
                &enabled_entities,
                &page_checkpoint,
                is_initial_scope_sync,
            )
        })?;
        log_sync_stage(
            "pull_commit",
            merge_started,
            format_args!("page={} entities={}", page_index + 1, pulled_entity_count),
        );
        sync_cursor = page_checkpoint;
        if let Some(task) = task {
            task.checkpoint(
                pulled as u64,
                0,
                format!("已拉取第 {} 页，共 {pulled} 条", page_index + 1),
                format!(
                    r#"{{"phase":"pull","page":{},"cursor":{}}}"#,
                    page_index + 1,
                    serde_json::json!(&sync_cursor)
                ),
            )?;
        }
        if !has_more {
            pull_completed = true;
            break;
        }
        pull_cursor = next_cursor;
    }
    if !pull_completed {
        return Err("pull 分页数量超过安全上限，稍后可继续同步".into());
    }
    // Palette entities carry only asset metadata. Download their binary files
    // before runtime settings consume the references, never through WebView IPC.
    let downloaded_assets = state.with_db_read("sync_palette_asset_projection", |db| {
        db.sync_entities_by_kind(crate::reader_palettes::READER_PALETTE_KIND)
    })?;
    crate::reader_backgrounds::sync_download_referenced_assets(
        &agent,
        &base,
        &settings.token,
        &downloaded_assets,
    )?;
    data_migration::apply_sqlite_to_runtime(state)?;
    // Persist the field-wise book merge; unchanged JSON does not become dirty.
    data_migration::migrate_json_to_sqlite(state)?;
    let entities: Vec<db::SyncEntity> =
        state.with_db_read("sync_pending_enabled_entities", |db| {
            Ok(db
                .pending_sync_entities(&scope)?
                .into_iter()
                .filter(|entity| crate::private_sync::is_entity_enabled(db, &entity.kind))
                .collect::<Vec<_>>())
        })?;
    // Ensure every referenced image has reached the authenticated binary store
    // before the tiny palette entity can make that reference visible remotely.
    crate::reader_backgrounds::sync_upload_referenced_assets(
        &agent,
        &base,
        &settings.token,
        settings.data_generation,
        &entities,
    )?;
    let initial_push = push_sync_entities(
        state,
        task,
        retry_delays_ms,
        &agent,
        &base,
        &settings.token,
        &scope,
        settings.data_generation,
        &entities,
        pulled as usize,
    )?;
    let mut pushed = initial_push.pushed;
    let mut accepted = initial_push.accepted;
    let mut ignored = initial_push.ignored;
    let mut push_server_time = initial_push.server_time;
    // A local acknowledgement is only a cache of a previous server response;
    // it is not proof that a restored or repaired server still owns that row.
    // Verify the actual account inventory after every incremental sync. A
    // matching digest costs one tiny request. On mismatch, exchange only
    // version metadata and transfer just the missing/winning entities.
    // Inventory is scoped to the exact categories enabled on this device. This
    // retains post-restore self-healing without touching paused categories.
    let enabled_kinds = state.with_db_read("sync_inventory_enabled_kinds", |db| {
        Ok(crate::private_sync::enabled_inventory_kinds(db)
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>())
    })?;
    let mut inventory_verified = enabled_kinds.is_empty();
    if !enabled_kinds.is_empty() {
        for reconcile_pass in 0..=3 {
            check_sync_control(task)?;
            let inventory: SyncInventoryResponse =
                sync_request_with_retry_delays("inventory", task, retry_delays_ms, || {
                    agent
                        .get(&format!("{base}/v1/sync/inventory"))
                        .query_pairs(enabled_kinds.iter().map(|kind| ("kind", kind.as_str())))
                        .header("Authorization", &format!("Bearer {}", settings.token))
                        .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                        .call()?
                        .body_mut()
                        .read_json()
                })?;
            ensure_data_generation(settings.data_generation, inventory.data_generation)?;
            push_server_time = push_server_time.max(inventory.server_time);
            let local: Vec<db::SyncEntity> =
                state.with_db_read("sync_inventory_local_entities", |db| {
                    Ok(db
                        .all_sync_entities()?
                        .into_iter()
                        .filter(|entity| enabled_kinds.contains(&entity.kind))
                        .collect::<Vec<_>>())
                })?;
            if inventory_matches(&local, &inventory) {
                inventory_verified = true;
                crate::log(&format!(
                    "[sync] inventory=verified entities={} revision={}",
                    local.len(),
                    inventory.revision
                ));
                break;
            }

            crate::log(&format!(
                "[sync] inventory=mismatch pass={} local_count={} server_count={} revision={}",
                reconcile_pass + 1,
                local.len(),
                inventory.entity_count,
                inventory.revision
            ));
            if reconcile_pass == 3 {
                break;
            }
            let reconcile_body =
                reconcile_request_body(settings.data_generation, &enabled_kinds, &local);
            let reconcile: SyncReconcileResponse =
                sync_request_with_retry_delays("reconcile", task, retry_delays_ms, || {
                    agent
                        .post(&format!("{base}/v1/sync/reconcile"))
                        .header("Authorization", &format!("Bearer {}", settings.token))
                        .header("Content-Type", "application/json")
                        .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                        .send_json(reconcile_body.clone())?
                        .body_mut()
                        .read_json()
                })?;
            ensure_data_generation(settings.data_generation, reconcile.data_generation)?;
            push_server_time = push_server_time.max(reconcile.server_time);

            // Older deployed servers can calculate the compact inventory digest
            // from legacy second-based timestamps while reconcile normalizes those
            // timestamps before comparing every row. A no-op reconcile with an
            // equal count is therefore stronger compatibility evidence than a
            // version-sensitive digest: the server inspected the complete union
            // and found nothing to upload or download.
            if reconcile_proves_inventory(local.len(), &reconcile) {
                inventory_verified = true;
                crate::log(&format!(
                    "[sync] inventory=reconcile_verified entities={} revision={} digest={}",
                    local.len(),
                    reconcile.revision,
                    reconcile.inventory_digest
                ));
                break;
            }

            let reconciled_entities = reconcile.entities();
            if !reconciled_entities.is_empty() {
                data_migration::merge_pulled_book_states(state, &reconciled_entities)?;
                pulled = pulled
                    .saturating_add(u32::try_from(reconciled_entities.len()).unwrap_or(u32::MAX));
                state.with_db_write("sync_reconcile_commit", |db| {
                    let _ = db.import_reconciled_sync_entities(&scope, &reconciled_entities)?;
                    Ok(())
                })?;
                data_migration::apply_sqlite_to_runtime(state)?;
                data_migration::migrate_json_to_sqlite(state)?;
            }

            // The server response may have installed authoritative rows above;
            // reload before selecting a requested repair so we never resend a
            // superseded local version from the pre-reconcile inventory.
            let repair_source =
                state.with_db_read("sync_reconcile_repair_source", |db| db.all_sync_entities())?;
            let repair_entities = reconcile_upload_entities(&repair_source, &reconcile)?;
            if !repair_entities.is_empty() {
                let repair = push_sync_entities(
                    state,
                    task,
                    retry_delays_ms,
                    &agent,
                    &base,
                    &settings.token,
                    &scope,
                    settings.data_generation,
                    &repair_entities,
                    pulled as usize + pushed,
                )?;
                pushed += repair.pushed;
                accepted += repair.accepted;
                ignored += repair.ignored;
                push_server_time = push_server_time.max(repair.server_time);
            }
        }
    }
    if !inventory_verified {
        return Err("同步后本地与服务器库存仍不一致，已停止并保留未确认状态".into());
    }

    let server_time = push_server_time.max(pull_server_time);
    state.with_db_write("sync_finalize_metadata", |db| {
        db.set_sync_scope_metadata(&scope, "last_sync_at", &server_time.to_string())?;
        if !sync_cursor.is_empty() {
            db.set_sync_scope_metadata(&scope, "cursor", &sync_cursor)?;
        }
        db.set_sync_scope_metadata(&scope, "last_pushed", &pushed.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_pulled", &pulled.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_accepted", &accepted.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_ignored", &ignored.to_string())?;
        db.set_metadata(crate::private_sync::SYNC_FILTERS_CHANGED_KEY, "0")?;
        Ok(())
    })?;
    data_migration::apply_sqlite_to_runtime(state)?;
    let report = SyncReport {
        ok: true,
        message: format!(
            "同步完成：推送 {} 条，服务端接受 {} 条，忽略 {} 条，拉取 {} 条",
            pushed, accepted, ignored, pulled
        ),
        pushed,
        pulled: pulled as usize,
        accepted,
        ignored,
        server_time,
    };
    log_sync_stage(
        "complete",
        sync_started,
        format_args!("pushed={pushed} pulled={pulled} accepted={accepted} ignored={ignored}"),
    );
    Ok(report)
}

fn sync_now_inner_with_limits(
    state: &AppState,
    request_timeout: Duration,
    max_pull_pages: usize,
    retry_delays_ms: &[u64],
    task: Option<&TaskRunGuard>,
) -> Result<SyncReport, String> {
    let started = Instant::now();
    let result = sync_now_inner_with_limits_impl(
        state,
        request_timeout,
        max_pull_pages,
        retry_delays_ms,
        task,
    );
    crate::diagnostics::record_sync_stage(
        "sync_total",
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        result.is_ok(),
    );
    result
}

fn sync_now_inner(state: &AppState, task: Option<&TaskRunGuard>) -> Result<SyncReport, String> {
    sync_now_inner_with_limits(
        state,
        SYNC_REQUEST_TIMEOUT,
        MAX_SYNC_PULL_PAGES,
        SYNC_RETRY_DELAYS_MS,
        task,
    )
}

fn settle_sync_task(task: TaskRunGuard, result: &Result<SyncReport, String>) {
    match result {
        Ok(_) => {
            let _ = task.complete();
        }
        Err(error) if error == SYNC_PAUSED => {
            let _ = task.pause();
        }
        Err(error) if error == SYNC_CANCELLED => {
            let _ = task.cancel();
        }
        Err(error) => {
            let _ = task.fail(error.clone());
        }
    }
}

#[tauri::command]
pub(crate) async fn sync_now(app: tauri::AppHandle) -> Result<SyncReport, String> {
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue_or_resume(BackgroundTaskKind::Sync, "同步阅读数据");
    task_handle
        .run_blocking(move |task| {
            let state = app.state::<AppState>();
            let result = sync_now_inner(state.inner(), Some(&task));
            settle_sync_task(task, &result);
            if result.is_ok() {
                let _ = app.emit("app-settings-synced", ());
            }
            result
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_request_deserializes_as_one_object() {
        let request: AuthRequest = serde_json::from_value(serde_json::json!({
            "url": "https://reader.example",
            "username": "alice",
            "password": "secret"
        }))
        .unwrap();
        assert_eq!(request.url, "https://reader.example");
        assert_eq!(request.username, "alice");
        assert_eq!(request.password, "secret");
    }

    #[test]
    fn serialized_sync_responses_do_not_expose_tokens() {
        let settings = SyncSettings {
            url: "https://example.com".to_string(),
            token: "secret-token".to_string(),
            username: "alice".to_string(),
            user_id: "u1".to_string(),
            data_generation: 1,
            last_sync_at: 123,
            last_sync_pushed: 2,
            last_sync_pulled: 3,
            last_sync_accepted: 2,
            last_sync_ignored: 0,
        };
        let auth = AuthResponse {
            ok: true,
            token: "auth-token".to_string(),
            user: AuthUser {
                id: "u1".to_string(),
                username: "alice".to_string(),
            },
            data_generation: 1,
            sync_enabled: true,
        };

        let settings_json = serde_json::to_value(settings).unwrap();
        let auth_json = serde_json::to_value(auth).unwrap();
        assert!(settings_json.get("token").is_none());
        assert!(auth_json.get("token").is_none());
        assert_eq!(settings_json["username"], "alice");
        assert_eq!(auth_json["user"]["username"], "alice");
    }

    #[test]
    fn settings_record_is_plain_sqlite_snapshot_and_resolves_legacy_token() {
        let database = db::AppDb::open_in_memory_for_tests();
        database
            .set_metadata("sync_url", "https://reader.example")
            .unwrap();
        database.set_metadata("sync_username", "alice").unwrap();
        database.set_metadata("sync_user_id", "u1").unwrap();
        database.set_metadata("sync_token", "legacy-token").unwrap();
        let scope = account_sync_scope("https://reader.example", "u1").unwrap();
        database
            .set_sync_scope_metadata(&scope, "data_generation", "3")
            .unwrap();
        database
            .set_sync_scope_metadata(&scope, "last_pushed", "7")
            .unwrap();

        let record = sync_settings_record_from_db(&database);
        assert_eq!(record.protected_token, None);
        assert_eq!(record.legacy_token, "legacy-token");
        assert_eq!(record.last_sync_pushed, 7);
        let settings = resolve_sync_settings(record).unwrap();
        assert_eq!(settings.token, "legacy-token");
        assert_eq!(settings.data_generation, 3);
    }

    #[test]
    fn auth_me_requires_v5_nested_user_and_data_generation() {
        let response: AuthMeResponse =
            serde_json::from_str(r#"{"user":{"id":"u2","username":"bob"},"dataGeneration":3}"#)
                .unwrap();
        let (user, generation) = response.into_verified_identity().unwrap();
        assert_eq!(user.id, "u2");
        assert_eq!(generation, 3);
        assert!(serde_json::from_str::<AuthMeResponse>(r#"{"id":"u2","username":"bob"}"#).is_err());
        let response: AuthMeResponse =
            serde_json::from_str(r#"{"user":{"id":"u2","username":"bob"},"dataGeneration":0}"#)
                .unwrap();
        assert!(response.into_verified_identity().is_err());
    }

    #[test]
    fn cloud_recovery_payloads_require_v5_camel_case_metadata() {
        let status: SyncRecoveryStatus = serde_json::from_value(serde_json::json!({
            "available": true,
            "retentionDays": 90,
            "restorableFrom": 1_700_000_000_000i64,
            "latestVersionAt": 1_700_000_100_000i64,
            "versionCount": 12,
            "dataGeneration": 4,
        }))
        .unwrap();
        assert!(status.available);
        assert_eq!(status.retention_days, 90);
        assert_eq!(status.data_generation, 4);

        let result: SyncRecoveryRestoreResponse = serde_json::from_value(serde_json::json!({
            "dataGeneration": 5,
            "tokensRevoked": true,
            "targetAt": 1_700_000_050_000i64,
            "restoredAt": 1_700_000_200_000i64,
            "restoredEntities": 9,
            "tombstonedEntities": 3,
        }))
        .unwrap();
        assert!(result.tokens_revoked);
        assert_eq!(result.restored_entities, 9);
        assert_eq!(result.tombstoned_entities, 3);
        assert_eq!(result.data_generation, 5);

        assert!(
            serde_json::from_value::<SyncRecoveryStatus>(serde_json::json!({
                "available": true,
                "retention_days": 90,
                "restorable_from": 1,
                "latest_version_at": 2,
                "version_count": 3,
                "data_generation": 4
            }))
            .is_err()
        );
    }
}
