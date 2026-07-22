use crate::{
    background_tasks::{BackgroundTaskKind, TaskControlSignal, TaskRunGuard},
    data_migration, db, secret_store,
    sync_core::sync_scope_id,
    AppState, DEFAULT_SYNC_URL,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

const SYNC_PULL_PAGE_SIZE: usize = 1_000;
const MAX_SYNC_PULL_PAGES: usize = 1_000;
const SYNC_PUSH_BATCH_ENTITIES: usize = 400;
const SYNC_PUSH_BATCH_BYTES: usize = 2 * 1024 * 1024;
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const EXIT_SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const EXIT_SYNC_MAX_PULL_PAGES: usize = 4;
const SYNC_REQUEST_ATTEMPTS: usize = 3;
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

fn sync_error_retryable(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::StatusCode(code) => {
            matches!(*code, 408 | 425 | 429) || (500..=599).contains(code)
        }
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed
        | ureq::Error::Protocol(_) => true,
        _ => false,
    }
}

fn sync_error_class(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::StatusCode(429) => "http_429",
        ureq::Error::StatusCode(code) if (500..=599).contains(code) => "http_5xx",
        ureq::Error::StatusCode(_) => "http_4xx",
        ureq::Error::Timeout(_) => "timeout",
        ureq::Error::HostNotFound => "dns",
        ureq::Error::ConnectionFailed => "connection_failed",
        ureq::Error::Io(_) => "io",
        ureq::Error::Protocol(_) => "protocol",
        _ => "other",
    }
}

fn sync_request_with_retry<T>(
    stage: &str,
    task: Option<&TaskRunGuard>,
    request: impl FnMut() -> Result<T, ureq::Error>,
) -> Result<T, String> {
    sync_request_with_retry_delays(stage, task, &[250, 500], request)
}

fn sync_request_with_retry_delays<T>(
    stage: &str,
    task: Option<&TaskRunGuard>,
    retry_delays_ms: &[u64],
    mut request: impl FnMut() -> Result<T, ureq::Error>,
) -> Result<T, String> {
    let started = Instant::now();
    let attempts = SYNC_REQUEST_ATTEMPTS.min(retry_delays_ms.len().saturating_add(1));
    for attempt in 1..=attempts {
        check_sync_control(task)?;
        let attempt_started = Instant::now();
        match request() {
            Ok(value) => {
                if attempt > 1 {
                    crate::diagnostics::record_retry_recovered(
                        stage,
                        attempt as u64,
                        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    );
                }
                crate::log(&format!(
                    "[sync] stage={stage} attempt={attempt} elapsed_ms={} status=ok",
                    started.elapsed().as_millis()
                ));
                return Ok(value);
            }
            Err(error) => {
                let retry = attempt < attempts && sync_error_retryable(&error);
                let delay_ms = if retry {
                    retry_delays_ms[attempt - 1]
                } else {
                    0
                };
                crate::diagnostics::record_retry_failure(
                    stage,
                    attempt as u64,
                    u64::try_from(attempt_started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    sync_error_class(&error),
                    retry,
                    delay_ms,
                );
                crate::log(&format!(
                    "[sync] stage={stage} attempt={attempt} elapsed_ms={} retry={retry} error={error}",
                    started.elapsed().as_millis()
                ));
                if let Some(task) = task {
                    let _ = task.log(
                        crate::background_tasks::TaskLogLevel::Warning,
                        format!("{stage} 第 {attempt} 次请求失败：{error}"),
                    );
                }
                if !retry {
                    return Err(format!("{stage} 失败：{error}"));
                }
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }
    unreachable!("retry loop always returns")
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
pub(crate) struct AuthResponse {
    #[serde(default)]
    ok: bool,
    #[serde(skip_serializing)]
    token: String,
    user: AuthUser,
}

#[derive(Deserialize, Default)]
struct AuthMeResponse {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    user: AuthUser,
}

impl AuthMeResponse {
    fn into_verified_user(self) -> Result<AuthUser, String> {
        let user = if self.user.id.trim().is_empty() {
            AuthUser {
                id: self.id,
                username: self.username,
            }
        } else {
            self.user
        };
        if user.id.trim().is_empty() {
            return Err("服务器没有返回账户 ID".into());
        }
        Ok(user)
    }
}

#[derive(Serialize)]
pub(crate) struct SyncReport {
    ok: bool,
    message: String,
    pushed: usize,
    pulled: usize,
    accepted: usize,
    ignored: usize,
    server_time: i64,
}

#[derive(Deserialize)]
struct SyncPushResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    accepted_count: Option<u32>,
    #[serde(default)]
    accepted: Option<serde_json::Value>,
    #[serde(default)]
    ignored_count: Option<u32>,
    #[serde(default)]
    ignored: Option<serde_json::Value>,
    #[serde(default)]
    dispositions: Vec<SyncPushDisposition>,
}

#[derive(Deserialize)]
struct SyncPushDisposition {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    sync_version: i64,
    #[serde(default)]
    status: String,
}

impl SyncPushResponse {
    fn accepted_total(&self) -> u32 {
        self.accepted_count
            .unwrap_or_else(|| legacy_sync_count(self.accepted.as_ref()))
    }

    fn ignored_total(&self) -> u32 {
        self.ignored_count
            .unwrap_or_else(|| legacy_sync_count(self.ignored.as_ref()))
    }

    /// Return only exact local versions which the server explicitly settled.
    /// A rejected entity (quota, validation or payload limits) must remain
    /// dirty.  A conflict is acknowledged only when the response also carries
    /// the authoritative entity that will replace it in the same transaction.
    fn acknowledged_entities(&self, batch: &[db::SyncEntity]) -> Vec<db::SyncEntity> {
        if self.dispositions.is_empty() {
            // Compatibility with pre-disposition servers is deliberately
            // conservative: a completely accepted batch is safe, a mixed
            // response is not identifiable and therefore remains retryable.
            if self.ignored_total() == 0
                && usize::try_from(self.accepted_total()).ok() == Some(batch.len())
            {
                return batch.to_vec();
            }
            return Vec::new();
        }

        let authoritative: std::collections::HashSet<(&str, &str)> = self
            .entities
            .iter()
            .map(|entity| (entity.kind.as_str(), entity.id.as_str()))
            .collect();
        let settled: std::collections::HashSet<(&str, &str, &str, i64)> = self
            .dispositions
            .iter()
            .filter(|item| {
                item.status == "accepted"
                    || (item.status == "conflict"
                        && authoritative.contains(&(item.kind.as_str(), item.id.as_str())))
            })
            .map(|item| {
                (
                    item.kind.as_str(),
                    item.id.as_str(),
                    item.device_id.as_str(),
                    item.sync_version,
                )
            })
            .collect();
        batch
            .iter()
            .filter(|item| {
                settled.contains(&(
                    item.kind.as_str(),
                    item.id.as_str(),
                    item.device_id.as_str(),
                    item.sync_version,
                ))
            })
            .cloned()
            .collect()
    }
}

fn legacy_sync_count(value: Option<&serde_json::Value>) -> u32 {
    match value {
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .unwrap_or_default(),
        Some(serde_json::Value::Array(items)) => u32::try_from(items.len()).unwrap_or(u32::MAX),
        _ => 0,
    }
}

#[derive(Deserialize)]
struct SyncPullResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    next_cursor: String,
    #[serde(default)]
    has_more: bool,
}

fn sync_settings_from_db(db: &db::AppDb) -> SyncSettings {
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
    SyncSettings {
        url,
        token: read_sync_token(db).unwrap_or_default(),
        username: db.metadata("sync_username").unwrap_or_default(),
        user_id,
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

fn read_sync_token(db: &db::AppDb) -> Result<String, String> {
    if let Some(protected) = db.metadata("sync_token_protected") {
        return secret_store::unprotect_secret(&protected);
    }
    Ok(db.metadata("sync_token").unwrap_or_default())
}

fn protect_sync_token(token: &str) -> Result<String, String> {
    secret_store::protect_secret(token.trim())
}

fn is_local_http_base(base: &str) -> bool {
    base == "http://localhost"
        || base.starts_with("http://localhost:")
        || base == "http://127.0.0.1"
        || base.starts_with("http://127.0.0.1:")
        || base == "http://[::1]"
        || base.starts_with("http://[::1]:")
}

fn normalize_sync_base(input: &str) -> Result<String, String> {
    let base = input.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先在同步设置中填写 HTTPS 服务器地址".into());
    }
    if base.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("同步服务器地址包含非法空白字符".into());
    }
    if base.starts_with("https://") {
        return Ok(base);
    }
    if base.starts_with("http://") {
        // 只允许本机调试使用明文 HTTP；公网同步必须走 HTTPS。
        if is_local_http_base(&base) {
            return Ok(base);
        }
        return Err("同步服务器必须使用 HTTPS；只有本机调试地址允许 HTTP".into());
    }
    Err("同步服务器地址必须以 https:// 开头".into())
}

fn account_sync_scope(base: &str, user_id: &str) -> Result<String, String> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err("同步账户身份缺失，请重新登录".into());
    }
    Ok(sync_scope_id(base, user_id))
}

fn fetch_auth_user(base: &str, token: &str, timeout: Duration) -> Result<AuthUser, String> {
    if token.trim().is_empty() {
        return Err("同步 token 为空".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into();
    let response: AuthMeResponse = agent
        .get(&format!("{base}/auth/me"))
        .header("Authorization", &format!("Bearer {}", token.trim()))
        .call()
        .map_err(|e| format!("账户身份确认失败：{e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("账户身份返回解析失败：{e}"))?;
    response.into_verified_user()
}

fn save_sync_account(
    db: &mut db::AppDb,
    base: &str,
    token: &str,
    user: &AuthUser,
) -> Result<String, String> {
    let scope = account_sync_scope(base, &user.id)?;
    if token.trim().is_empty() {
        return Err("服务器没有返回登录 token".into());
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

fn saved_account_unchanged(
    db: &db::AppDb,
    expected: &SyncSettings,
    expected_verified_scope: &str,
) -> Result<bool, String> {
    let current = sync_settings_from_db(db);
    Ok(current.url == expected.url
        && current.user_id == expected.user_id
        && db
            .metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
            .unwrap_or_default()
            == expected_verified_scope
        && read_sync_token(db)? == expected.token)
}

/// Assign pre-v4 global state to the currently saved account before replacing
/// or clearing its credentials. Legacy tokens (including the server's default
/// account token) are resolved through `/auth/me`; an unverifiable owner is
/// deliberately sealed as unclaimed so the next login performs a full sync.
fn prepare_saved_account_for_switch(state: &AppState) -> Result<(), String> {
    let (saved, verified_scope) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        (
            sync_settings_from_db(db),
            db.metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
                .unwrap_or_default(),
        )
    };
    let base = normalize_sync_base(&saved.url).ok();
    let stored_scope = base
        .as_deref()
        .and_then(|base| account_sync_scope(base, &saved.user_id).ok());
    let resolved_user = match (base.as_deref(), stored_scope.as_deref()) {
        (Some(_), Some(scope)) if scope == verified_scope => Some(AuthUser {
            id: saved.user_id.trim().to_string(),
            username: saved.username.clone(),
        }),
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

    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    if !saved_account_unchanged(db, &saved, &verified_scope)? {
        return Err("同步账户设置已变化，请重试".into());
    }
    match (base.as_deref(), resolved_user) {
        (Some(base), Some(user)) => {
            if saved.token.trim().is_empty() {
                let scope = account_sync_scope(base, &user.id)?;
                db.migrate_legacy_sync_state(&scope)?;
            } else {
                save_sync_account(db, base, &saved.token, &user)?;
            }
        }
        _ => {
            db.seal_unclaimed_legacy_sync_state()?;
        }
    }
    Ok(())
}

fn sync_push_batches(entities: &[db::SyncEntity]) -> Result<Vec<Vec<db::SyncEntity>>, String> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut batch_bytes = 0usize;

    for entity in entities {
        let entity_bytes = serde_json::to_vec(entity)
            .map_err(|e| format!("同步实体序列化失败：{e}"))?
            .len();
        if !batch.is_empty()
            && (batch.len() >= SYNC_PUSH_BATCH_ENTITIES
                || batch_bytes.saturating_add(entity_bytes) > SYNC_PUSH_BATCH_BYTES)
        {
            batches.push(batch);
            batch = Vec::new();
            batch_bytes = 0;
        }
        batch_bytes = batch_bytes.saturating_add(entity_bytes);
        batch.push(entity.clone());
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

fn newer_cursor(current: &str, candidate: &str) -> String {
    let current = current.trim();
    let candidate = candidate.trim();
    match (current.parse::<i128>(), candidate.parse::<i128>()) {
        (Ok(current_value), Ok(candidate_value)) if candidate_value > current_value => {
            candidate.to_string()
        }
        (Ok(_), Ok(_)) => current.to_string(),
        _ if candidate.is_empty() || candidate == current => current.to_string(),
        _ => candidate.to_string(),
    }
}

fn cursor_strictly_advances(current: &str, candidate: &str) -> bool {
    let current = current.trim();
    let candidate = candidate.trim();
    if candidate.is_empty() || candidate == current {
        return false;
    }
    match (current.parse::<i128>(), candidate.parse::<i128>()) {
        (Ok(current), Ok(candidate)) => candidate > current,
        _ => true,
    }
}

fn save_auth_response(db: &mut db::AppDb, base: &str, res: &AuthResponse) -> Result<(), String> {
    save_sync_account(db, base, &res.token, &res.user).map(|_| ())
}

fn auth_request_inner(
    state: &AppState,
    endpoint: &str,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    let base = normalize_sync_base(&url)?;
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".into());
    }
    let _account_change = acquire_account_change(state)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .build()
        .into();
    let body = serde_json::json!({
        "username": username,
        "password": password,
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
    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    save_auth_response(db, &base, &res)?;
    Ok(res)
}

#[tauri::command]
pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(sync_settings_from_db(db))
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
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        if let Some(user) = user {
            save_sync_account(db, &base, &token, &user)?;
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
        Ok(sync_settings_from_db(db))
    })
    .await
    .map_err(|e| format!("保存同步设置任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_logout(app: tauri::AppHandle) -> Result<SyncSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _account_change = acquire_account_change(state.inner())?;
        let settings = {
            let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
            sync_settings_from_db(db)
        };
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
                    .post(&format!("{base}/auth/logout"))
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .header("Content-Type", "application/json")
                    .send_json(serde_json::json!({}));
            }
        }
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        clear_sync_account(db)?;
        Ok(sync_settings_from_db(db))
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

#[tauri::command]
pub(crate) async fn auth_register(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    let AuthRequest {
        url,
        username,
        password,
    } = request;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/register", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_login(
    app: tauri::AppHandle,
    request: AuthRequest,
) -> Result<AuthResponse, String> {
    let AuthRequest {
        url,
        username,
        password,
    } = request;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/login", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

fn sync_now_inner_with_limits_impl(
    state: &AppState,
    request_timeout: Duration,
    max_pull_pages: usize,
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
    // Snapshot local JSON first so unsynced edits are represented in SQLite.
    data_migration::migrate_json_to_sqlite(state)?;
    log_sync_stage("prepare_local", prepare_started, "status=ok");
    let (initial_settings, initial_verified_scope) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        let settings = sync_settings_from_db(db);
        if settings.url.trim().is_empty() || settings.token.trim().is_empty() {
            return Err("请先登录账号".into());
        }
        (
            settings,
            db.metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
                .unwrap_or_default(),
        )
    };
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
    let (settings, device_id, scope, cursor) = {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        if !saved_account_unchanged(db, &initial_settings, &initial_verified_scope)? {
            return Err("同步账户设置已变化，请重试".into());
        }
        let scope = if let Some(user) = resolved_user {
            save_sync_account(db, &base, &initial_settings.token, &user)?
        } else {
            if base != initial_settings.url {
                db.set_metadata("sync_url", &base)?;
            }
            let scope = account_sync_scope(&base, &initial_settings.user_id)?;
            db.migrate_legacy_sync_state(&scope)?;
            scope
        };
        let settings = sync_settings_from_db(db);
        let cursor = db.sync_scope_metadata(&scope, "cursor").unwrap_or_default();
        (settings, db.device_id(), scope, cursor)
    };
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
        settings.last_sync_at.to_string()
    } else {
        cursor
    };
    let mut pull_completed = false;
    for page_index in 0..max_pull_pages {
        check_sync_control(task)?;
        let pull: SyncPullResponse = sync_request_with_retry("pull", task, || {
            agent
                .get(&format!("{base}/sync/pull"))
                .query("cursor", &pull_cursor)
                .query("limit", SYNC_PULL_PAGE_SIZE.to_string())
                .header("Authorization", &format!("Bearer {}", settings.token))
                .call()?
                .body_mut()
                .read_json()
        })?;
        pull_server_time = pull_server_time.max(pull.server_time);
        let next_cursor = pull.next_cursor.trim();
        if pull.has_more && !cursor_strictly_advances(&pull_cursor, next_cursor) {
            return Err("pull 游标没有前进，已停止以避免重复同步".into());
        }
        let checkpoint_base = if sync_cursor.is_empty() {
            pull_cursor.as_str()
        } else {
            sync_cursor.as_str()
        };
        let page_checkpoint = if next_cursor.is_empty() {
            checkpoint_base.to_string()
        } else {
            newer_cursor(checkpoint_base, next_cursor)
        };
        let merge_started = Instant::now();
        {
            let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
            db.ensure_active_sync_scope(&scope)?;
        }
        data_migration::merge_pulled_book_states(state, &pull.entities)?;
        pulled += {
            let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
            db.import_sync_page(&scope, &pull.entities, &page_checkpoint)?
        };
        log_sync_stage(
            "pull_commit",
            merge_started,
            format_args!("page={} entities={}", page_index + 1, pull.entities.len()),
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
        if !pull.has_more {
            pull_completed = true;
            break;
        }
        pull_cursor = next_cursor.to_string();
    }
    if !pull_completed {
        return Err("pull 分页数量超过安全上限，稍后可继续同步".into());
    }
    data_migration::apply_sqlite_to_runtime(state)?;
    // Persist the field-wise book merge; unchanged JSON does not become dirty.
    data_migration::migrate_json_to_sqlite(state)?;
    let entities = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.pending_sync_entities(&scope)?
    };
    let mut pushed = 0usize;
    let mut accepted = 0usize;
    let mut ignored = 0usize;
    let mut push_server_time = 0i64;
    for (batch_index, batch) in sync_push_batches(&entities)?.into_iter().enumerate() {
        check_sync_control(task)?;
        let push_body = serde_json::json!({
            "schema_version": 2,
            "device_id": device_id,
            "capabilities": ["push_dispositions_v1"],
            "entities": batch,
        });
        let push: SyncPushResponse = sync_request_with_retry("push", task, || {
            agent
                .post(&format!("{base}/sync/push"))
                .header("Authorization", &format!("Bearer {}", settings.token))
                .header("Content-Type", "application/json")
                // 实体 id + sync_version 使同一批重试具备幂等语义；响应丢失时可安全重发。
                .send_json(push_body.clone())?
                .body_mut()
                .read_json()
        })?;
        pushed += batch.len();
        accepted += push.accepted_total() as usize;
        ignored += push.ignored_total() as usize;
        push_server_time = push_server_time.max(push.server_time);
        // Only exact accepted/conflicting versions are settled. Validation and
        // quota rejects stay dirty and can be retried after the cause is fixed.
        // The clean markers and authoritative conflict rows share one SQLite
        // transaction, so a crash cannot leave a losing local row falsely clean.
        let commit_started = Instant::now();
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let acknowledged = push.acknowledged_entities(&batch);
        let _ = db.commit_sync_push(&scope, &acknowledged, &push.entities)?;
        log_sync_stage(
            "push_commit",
            commit_started,
            format_args!("batch={} entities={}", batch_index + 1, batch.len()),
        );
        if let Some(task) = task {
            task.checkpoint(
                (pulled as usize + pushed) as u64,
                (pulled as usize + entities.len()) as u64,
                format!("已推送第 {} 批，共 {pushed} 条", batch_index + 1),
                format!(
                    r#"{{"phase":"push","batch":{},"pushed":{pushed}}}"#,
                    batch_index + 1
                ),
            )?;
        }
    }

    let server_time = {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let server_time = push_server_time.max(pull_server_time);
        db.set_sync_scope_metadata(&scope, "last_sync_at", &server_time.to_string())?;
        if !sync_cursor.is_empty() {
            db.set_sync_scope_metadata(&scope, "cursor", &sync_cursor)?;
        }
        db.set_sync_scope_metadata(&scope, "last_pushed", &pushed.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_pulled", &pulled.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_accepted", &accepted.to_string())?;
        db.set_sync_scope_metadata(&scope, "last_ignored", &ignored.to_string())?;
        server_time
    };
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
    task: Option<&TaskRunGuard>,
) -> Result<SyncReport, String> {
    let started = Instant::now();
    let result = sync_now_inner_with_limits_impl(state, request_timeout, max_pull_pages, task);
    crate::diagnostics::record_sync_stage(
        "sync_total",
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        result.is_ok(),
    );
    result
}

fn sync_now_inner(state: &AppState, task: Option<&TaskRunGuard>) -> Result<SyncReport, String> {
    sync_now_inner_with_limits(state, SYNC_REQUEST_TIMEOUT, MAX_SYNC_PULL_PAGES, task)
}

/// Whether this device has a complete saved login. The token stays in Rust and
/// is only decrypted long enough to decide whether an automatic sync is useful.
pub(crate) fn sync_account_configured(state: &AppState) -> bool {
    let Ok(db_guard) = state.db.lock() else {
        return false;
    };
    let Some(db) = db_guard.as_ref() else {
        return false;
    };
    let settings = sync_settings_from_db(db);
    !settings.username.trim().is_empty()
        && !settings.token.trim().is_empty()
        && normalize_sync_base(&settings.url).is_ok()
}

/// Closing must remain responsive when the network is unavailable. Limit both
/// each request and the number of pull pages; an unfinished sync resumes on the
/// next startup without discarding local dirty entities.
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

/// Schedule the bounded exit sync through the shared task executor, then close
/// the main window regardless of network outcome. The window lifecycle no
/// longer creates its own unmanaged thread.
pub(crate) fn spawn_sync_before_exit(app: tauri::AppHandle) -> Result<(), String> {
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue(BackgroundTaskKind::Sync, "退出前同步");
    task_handle.spawn_detached("reader-sync-before-exit", move |task| {
        crate::log("[sync] exit automatic sync start");
        let result = {
            let state = app.state::<AppState>();
            sync_now_inner_with_limits(
                state.inner(),
                EXIT_SYNC_REQUEST_TIMEOUT,
                EXIT_SYNC_MAX_PULL_PAGES,
                Some(&task),
            )
        };
        settle_sync_task(task, &result);
        match result {
            Ok(_) => crate::log("[sync] exit automatic sync ok"),
            Err(error) => crate::log(&format!(
                "[sync] exit automatic sync skipped/failed: {error}"
            )),
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.close();
        }
    })
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
            result
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

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
        };

        let settings_json = serde_json::to_value(settings).unwrap();
        let auth_json = serde_json::to_value(auth).unwrap();
        assert!(settings_json.get("token").is_none());
        assert!(auth_json.get("token").is_none());
        assert_eq!(settings_json["username"], "alice");
        assert_eq!(auth_json["user"]["username"], "alice");
    }

    #[test]
    fn auth_me_accepts_nested_and_legacy_top_level_user_shapes() {
        for (json, expected_id) in [
            (
                r#"{"user":{"id":"default","username":"legacy"}}"#,
                "default",
            ),
            (r#"{"id":"u2","username":"bob"}"#, "u2"),
        ] {
            let response: AuthMeResponse = serde_json::from_str(json).unwrap();
            assert_eq!(response.into_verified_user().unwrap().id, expected_id);
        }
        let response: AuthMeResponse = serde_json::from_str("{}").unwrap();
        assert!(response.into_verified_user().is_err());
    }

    #[test]
    fn sync_base_requires_https_except_localhost() {
        assert_eq!(
            normalize_sync_base(" https://reader.example.com/ ").unwrap(),
            "https://reader.example.com"
        );
        assert!(normalize_sync_base("").is_err());
        assert_eq!(
            normalize_sync_base("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_sync_base("http://example.com").is_err());
        assert!(normalize_sync_base("ftp://example.com").is_err());
        assert!(normalize_sync_base("https://example.com/a b").is_err());
    }

    #[test]
    fn push_response_accepts_v1_v2_and_combined_count_fields() {
        for (json, accepted, ignored) in [
            (r#"{"server_time":1,"accepted":2,"ignored":3}"#, 2, 3),
            (
                r#"{"server_time":1,"accepted":["a","b"],"ignored":["c"]}"#,
                2,
                1,
            ),
            (
                r#"{"server_time":1,"accepted_count":4,"ignored_count":5}"#,
                4,
                5,
            ),
            (
                r#"{"server_time":1,"accepted_count":6,"accepted":["a","b"],"ignored_count":7,"ignored":["c"]}"#,
                6,
                7,
            ),
        ] {
            let response: SyncPushResponse = serde_json::from_str(json).unwrap();
            assert_eq!(response.accepted_total(), accepted);
            assert_eq!(response.ignored_total(), ignored);
        }
    }

    #[test]
    fn push_response_only_acknowledges_explicitly_settled_versions() {
        let batch = vec![
            db::SyncEntity {
                kind: "vocab".into(),
                id: "accepted".into(),
                json: serde_json::json!({}),
                updated_at: 1,
                deleted_at: 0,
                device_id: "device-a".into(),
                sync_version: 1,
            },
            db::SyncEntity {
                kind: "vocab".into(),
                id: "conflict".into(),
                json: serde_json::json!({}),
                updated_at: 1,
                deleted_at: 0,
                device_id: "device-a".into(),
                sync_version: 2,
            },
            db::SyncEntity {
                kind: "vocab".into(),
                id: "rejected".into(),
                json: serde_json::json!({}),
                updated_at: 1,
                deleted_at: 0,
                device_id: "device-a".into(),
                sync_version: 3,
            },
        ];
        let response: SyncPushResponse = serde_json::from_value(serde_json::json!({
            "server_time": 1,
            "accepted_count": 1,
            "ignored_count": 2,
            "dispositions": [
                {"kind":"vocab","id":"accepted","device_id":"device-a","sync_version":1,"status":"accepted"},
                {"kind":"vocab","id":"conflict","device_id":"device-a","sync_version":2,"status":"conflict"},
                {"kind":"vocab","id":"rejected","device_id":"device-a","sync_version":3,"status":"rejected"}
            ],
            "entities": [{
                "kind":"vocab","id":"conflict","json":{"remote":true},
                "updated_at":2,"deleted_at":0,"device_id":"device-z","sync_version":2
            }]
        }))
        .unwrap();

        let acknowledged = response.acknowledged_entities(&batch);
        assert_eq!(
            acknowledged
                .iter()
                .map(|entity| entity.id.as_str())
                .collect::<Vec<_>>(),
            vec!["accepted", "conflict"]
        );
    }

    #[test]
    fn legacy_mixed_push_response_keeps_entire_batch_dirty() {
        let response: SyncPushResponse =
            serde_json::from_str(r#"{"server_time":1,"accepted_count":1,"ignored_count":1}"#)
                .unwrap();
        let batch = vec![db::SyncEntity {
            kind: "vocab".into(),
            id: "unknown".into(),
            json: serde_json::json!({}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "device-a".into(),
            sync_version: 1,
        }];
        assert!(response.acknowledged_entities(&batch).is_empty());
    }

    #[test]
    fn sync_push_batches_bound_entity_count() {
        let entities = (0..(SYNC_PUSH_BATCH_ENTITIES + 1))
            .map(|index| db::SyncEntity {
                kind: "vocab".to_string(),
                id: index.to_string(),
                json: serde_json::json!({"word": "test"}),
                updated_at: index as i64,
                deleted_at: 0,
                device_id: "test".to_string(),
                sync_version: 1,
            })
            .collect::<Vec<_>>();
        let batches = sync_push_batches(&entities).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), SYNC_PUSH_BATCH_ENTITIES);
        assert_eq!(batches[1].len(), 1);
    }

    #[test]
    fn newer_cursor_never_moves_backwards() {
        assert_eq!(newer_cursor("100", "99"), "100");
        assert_eq!(newer_cursor("100", "101"), "101");
        assert_eq!(newer_cursor("", "101"), "101");
        assert_eq!(newer_cursor("page-a", "page-b"), "page-b");
    }

    #[test]
    fn numeric_pull_cursor_must_advance_but_opaque_cursor_may_change() {
        assert!(cursor_strictly_advances("100", "101"));
        assert!(!cursor_strictly_advances("100", "100"));
        assert!(!cursor_strictly_advances("100", "99"));
        assert!(!cursor_strictly_advances("100", ""));
        assert!(cursor_strictly_advances("page-a", "page-b"));
    }

    #[test]
    fn retry_policy_retries_transient_errors_but_not_client_errors() {
        assert!(sync_error_retryable(&ureq::Error::StatusCode(429)));
        assert!(sync_error_retryable(&ureq::Error::StatusCode(503)));
        assert!(sync_error_retryable(&ureq::Error::HostNotFound));
        assert!(!sync_error_retryable(&ureq::Error::StatusCode(400)));
        assert!(!sync_error_retryable(&ureq::Error::StatusCode(401)));
    }

    #[test]
    fn request_retry_recovers_after_transient_failures_without_sleeping_in_tests() {
        let mut attempts = 0usize;
        let value = sync_request_with_retry_delays("test", None, &[0, 0], || {
            attempts += 1;
            if attempts < 3 {
                Err(ureq::Error::StatusCode(503))
            } else {
                Ok("ok")
            }
        })
        .unwrap();
        assert_eq!(value, "ok");
        assert_eq!(attempts, 3);
    }

    #[test]
    fn request_retry_stops_immediately_for_non_retryable_error() {
        let mut attempts = 0usize;
        let error = sync_request_with_retry_delays::<()>("test", None, &[0, 0], || {
            attempts += 1;
            Err(ureq::Error::StatusCode(401))
        })
        .unwrap_err();
        assert!(error.contains("401"));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn request_retry_recovers_against_a_real_transient_http_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for request_index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request).unwrap();
                let status = if request_index < 2 {
                    "503 Service Unavailable"
                } else {
                    "200 OK"
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                stream.flush().unwrap();
            }
        });

        let url = format!("http://{address}/sync-test");
        sync_request_with_retry_delays("integration-test", None, &[0, 0], || {
            ureq::get(&url).call().map(|_| ())
        })
        .unwrap();
        server.join().unwrap();
    }
}
