use crate::{
    background_tasks::{BackgroundTaskKind, TaskControlSignal, TaskRunGuard},
    data_migration, db, secret_store, AppState, DEFAULT_SYNC_URL,
};
use reader_core::sync::sync_scope_id;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

const SYNC_PULL_PAGE_SIZE: usize = 1_000;
const MAX_SYNC_PULL_PAGES: usize = 1_000;
const SYNC_PUSH_BATCH_ENTITIES: usize = 400;
const SYNC_PUSH_BATCH_BYTES: usize = 2 * 1024 * 1024;
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SYNC_REQUEST_ATTEMPTS: usize = 3;
const SYNC_RETRY_DELAYS_MS: &[u64] = &[250, 500];
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
pub(crate) struct AuthResponse {
    #[serde(default)]
    ok: bool,
    #[serde(skip_serializing)]
    token: String,
    user: AuthUser,
    #[serde(default = "default_data_generation")]
    data_generation: i64,
}

fn default_data_generation() -> i64 {
    1
}

fn ensure_data_generation(expected: i64, actual: i64) -> Result<(), String> {
    if expected.max(1) == actual.max(1) {
        Ok(())
    } else {
        Err("云端数据版本已经变化；请在“数据与隐私”中清除此设备数据后重新登录".into())
    }
}

#[derive(Deserialize, Default)]
struct AuthMeResponse {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    user: AuthUser,
    #[serde(default = "default_data_generation")]
    data_generation: i64,
}

impl AuthMeResponse {
    fn into_verified_identity(self) -> Result<(AuthUser, i64), String> {
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
        Ok((user, self.data_generation.max(1)))
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
    #[serde(default = "default_data_generation")]
    data_generation: i64,
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
    #[serde(default = "default_data_generation")]
    data_generation: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    next_cursor: String,
    #[serde(default)]
    has_more: bool,
}

#[derive(Deserialize)]
struct SyncInventoryResponse {
    server_time: i64,
    #[serde(default = "default_data_generation")]
    data_generation: i64,
    entity_count: usize,
    inventory_digest: String,
    #[serde(default)]
    revision: String,
}

#[derive(Clone, Serialize)]
struct SyncManifestEntry {
    kind: String,
    id: String,
    updated_at: i64,
    deleted_at: i64,
    device_id: String,
    sync_version: i64,
}

impl From<&db::SyncEntity> for SyncManifestEntry {
    fn from(entity: &db::SyncEntity) -> Self {
        Self {
            kind: entity.kind.clone(),
            id: entity.id.clone(),
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id.clone(),
            sync_version: entity.sync_version,
        }
    }
}

#[derive(Deserialize)]
struct SyncEntityKey {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
struct SyncReconcileResponse {
    server_time: i64,
    #[serde(default = "default_data_generation")]
    data_generation: i64,
    #[serde(default)]
    entity_count: usize,
    #[serde(default)]
    inventory_digest: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    upload: Vec<SyncEntityKey>,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
}

fn reconcile_proves_inventory(local_count: usize, response: &SyncReconcileResponse) -> bool {
    response.entity_count == local_count
        && response.upload.is_empty()
        && response.entities.is_empty()
}

fn update_inventory_text(hasher: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    hasher.update(u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn sync_inventory_digest(entities: &[db::SyncEntity]) -> String {
    let mut sorted = entities.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut hasher = Sha256::new();
    for entity in sorted {
        update_inventory_text(&mut hasher, &entity.kind);
        update_inventory_text(&mut hasher, &entity.id);
        update_inventory_text(&mut hasher, &entity.device_id);
        hasher.update(entity.sync_version.to_be_bytes());
        hasher.update(entity.updated_at.to_be_bytes());
        hasher.update(entity.deleted_at.to_be_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn inventory_matches(local: &[db::SyncEntity], remote: &SyncInventoryResponse) -> bool {
    local.len() == remote.entity_count
        && sync_inventory_digest(local).eq_ignore_ascii_case(&remote.inventory_digest)
}

pub(crate) fn sync_settings_from_db(db: &db::AppDb) -> SyncSettings {
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

pub(crate) fn normalize_sync_base(input: &str) -> Result<String, String> {
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

fn normalize_auth_base(input: &str) -> Result<String, String> {
    let value = if input.trim().is_empty() {
        DEFAULT_SYNC_URL
    } else {
        input
    };
    normalize_sync_base(value)
}

fn auth_base_from_state(state: &AppState, requested: &str) -> Result<String, String> {
    if !requested.trim().is_empty() {
        return normalize_auth_base(requested);
    }
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    normalize_auth_base(&sync_settings_from_db(db).url)
}

fn account_sync_scope(base: &str, user_id: &str) -> Result<String, String> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err("同步账户身份缺失，请重新登录".into());
    }
    Ok(sync_scope_id(base, user_id))
}

fn fetch_auth_user(base: &str, token: &str, timeout: Duration) -> Result<(AuthUser, i64), String> {
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
    let data_generation = data_generation.max(1);
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

    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    if !saved_account_unchanged(db, &saved, &verified_scope)? {
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
    device_id: &str,
    scope: &str,
    data_generation: i64,
    entities: &[db::SyncEntity],
    progress_base: usize,
) -> Result<PushTotals, String> {
    let mut totals = PushTotals::default();
    for (batch_index, batch) in sync_push_batches(entities)?.into_iter().enumerate() {
        check_sync_control(task)?;
        let push_body = serde_json::json!({
            "schema_version": 2,
            "device_id": device_id,
            "data_generation": data_generation,
            "capabilities": ["push_dispositions_v1"],
            "entities": batch,
        });
        let push: SyncPushResponse =
            sync_request_with_retry_delays("push", task, retry_delays_ms, || {
                agent
                    .post(&format!("{base}/sync/push"))
                    .header("Authorization", &format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    // kind + id + device_id + sync_version make retries idempotent.
                    .send_json(push_body.clone())?
                    .body_mut()
                    .read_json()
            })?;
        ensure_data_generation(data_generation, push.data_generation)?;
        totals.pushed += batch.len();
        totals.accepted += push.accepted_total() as usize;
        totals.ignored += push.ignored_total() as usize;
        totals.server_time = totals.server_time.max(push.server_time);
        let commit_started = Instant::now();
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let acknowledged = push.acknowledged_entities(&batch);
        let _ = db.commit_sync_push(scope, &acknowledged, &push.entities)?;
        log_sync_stage(
            "push_commit",
            commit_started,
            format_args!("batch={} entities={}", batch_index + 1, batch.len()),
        );
        drop(db_guard);
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
    save_sync_account(db, base, &res.token, &res.user, res.data_generation).map(|_| ())
}

fn auth_request_inner(
    state: &AppState,
    endpoint: &str,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    let base = normalize_auth_base(&url)?;
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

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthSecurityStatus {
    pub email_bound: bool,
    pub email: String,
    pub recovery_available: bool,
    pub mail_configured: bool,
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
pub(crate) struct DataResetResponse {
    ok: bool,
    data_generation: i64,
    tokens_revoked: bool,
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
    let settings = {
        let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
        sync_settings_from_db(db)
    };
    let base = normalize_sync_base(&settings.url)?;
    if settings.token.trim().is_empty() {
        return Err("请先登录账号".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(SYNC_REQUEST_TIMEOUT))
        .build()
        .into();
    let request = if let Some(body) = body {
        agent
            .post(&format!("{base}{path}"))
            .header("Authorization", &format!("Bearer {}", settings.token))
            .header("Content-Type", "application/json")
            .send_json(body)
    } else {
        agent
            .get(&format!("{base}{path}"))
            .header("Authorization", &format!("Bearer {}", settings.token))
            .call()
    };
    request
        .map_err(|e| format!("账户安全请求失败：{e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("账户安全返回解析失败：{e}"))
}

pub(crate) fn private_secret_bundle_state(state: &AppState) -> Result<SecretBundleState, String> {
    authenticated_endpoint(state, "/sync/secret-state", None)
}

pub(crate) fn reset_private_secret_bundle_state(
    state: &AppState,
) -> Result<SecretBundleState, String> {
    authenticated_endpoint(
        state,
        "/sync/secret-state/reset",
        Some(serde_json::json!({})),
    )
}

#[tauri::command]
pub(crate) async fn auth_security_status(
    app: tauri::AppHandle,
) -> Result<AuthSecurityStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authenticated_endpoint(app.state::<AppState>().inner(), "/auth/security", None)
    })
    .await
    .map_err(|e| format!("账户安全任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_bind_email_start(
    app: tauri::AppHandle,
    request: EmailBindRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/auth/email/start",
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
            "/auth/email/confirm",
            Some(serde_json::json!({"email": request.email, "code": request.code})),
        )?;
        authenticated_endpoint(app.state::<AppState>().inner(), "/auth/security", None)
    })
    .await
    .map_err(|e| format!("确认邮箱任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_rebind_email_old_start(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _: serde_json::Value = authenticated_endpoint(
            app.state::<AppState>().inner(),
            "/auth/email/rebind/old/start",
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
            "/auth/email/rebind/old/confirm",
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
            "/auth/email/rebind/new/start",
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
            "/auth/email/rebind/new/confirm",
            Some(serde_json::json!({"email": request.email, "code": request.code})),
        )?;
        authenticated_endpoint(app.state::<AppState>().inner(), "/auth/security", None)
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
            "/auth/password/change",
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
            "/sync/data/reset",
            Some(serde_json::json!({"password": request.password})),
        )?;
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        clear_sync_account(db)?;
        Ok(response)
    })
    .await
    .map_err(|e| format!("清除云端数据任务失败：{e}"))?
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
            "/auth/account/delete",
            Some(serde_json::json!({
                "password": request.password,
                "username": request.username.trim(),
            })),
        )?;
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        clear_sync_account(db)
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
            .post(&format!("{base}/auth/password/reset/request"))
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
        let base = auth_base_from_state(state.inner(), &request.url)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(SYNC_REQUEST_TIMEOUT))
            .build()
            .into();
        let response: AuthResponse = agent
            .post(&format!("{base}/auth/password/reset/confirm"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({
                "username": request.username,
                "code": request.code,
                "newPassword": request.new_password,
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
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        save_auth_response(db, &base, &response)?;
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
        let pull: SyncPullResponse =
            sync_request_with_retry_delays("pull", task, retry_delays_ms, || {
                agent
                    .get(&format!("{base}/sync/pull"))
                    .query("cursor", &pull_cursor)
                    .query("limit", SYNC_PULL_PAGE_SIZE.to_string())
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .call()?
                    .body_mut()
                    .read_json()
            })?;
        ensure_data_generation(settings.data_generation, pull.data_generation)?;
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
    let initial_push = push_sync_entities(
        state,
        task,
        retry_delays_ms,
        &agent,
        &base,
        &settings.token,
        &device_id,
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
    let mut inventory_verified = false;
    for reconcile_pass in 0..=3 {
        check_sync_control(task)?;
        let inventory: SyncInventoryResponse =
            sync_request_with_retry_delays("inventory", task, retry_delays_ms, || {
                agent
                    .get(&format!("{base}/sync/inventory"))
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .call()?
                    .body_mut()
                    .read_json()
            })?;
        ensure_data_generation(settings.data_generation, inventory.data_generation)?;
        push_server_time = push_server_time.max(inventory.server_time);
        let local = {
            let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
            db.all_sync_entities()?
        };
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
        let manifest = local
            .iter()
            .map(SyncManifestEntry::from)
            .collect::<Vec<_>>();
        let reconcile_body = serde_json::json!({
            "schema_version": 2,
            "data_generation": settings.data_generation,
            "manifest": manifest,
        });
        let reconcile: SyncReconcileResponse =
            sync_request_with_retry_delays("reconcile", task, retry_delays_ms, || {
                agent
                    .post(&format!("{base}/sync/reconcile"))
                    .header("Authorization", &format!("Bearer {}", settings.token))
                    .header("Content-Type", "application/json")
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

        if !reconcile.entities.is_empty() {
            data_migration::merge_pulled_book_states(state, &reconcile.entities)?;
            pulled =
                pulled.saturating_add(u32::try_from(reconcile.entities.len()).unwrap_or(u32::MAX));
            let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
            let _ = db.import_reconciled_sync_entities(&scope, &reconcile.entities)?;
            drop(db_guard);
            data_migration::apply_sqlite_to_runtime(state)?;
            data_migration::migrate_json_to_sqlite(state)?;
        }

        let upload_keys = reconcile
            .upload
            .into_iter()
            .map(|item| (item.kind, item.id))
            .collect::<HashSet<_>>();
        if !upload_keys.is_empty() {
            let local_by_key = {
                let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
                let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
                db.all_sync_entities()?
                    .into_iter()
                    .map(|entity| ((entity.kind.clone(), entity.id.clone()), entity))
                    .collect::<HashMap<_, _>>()
            };
            let missing_local = upload_keys
                .iter()
                .filter(|key| !local_by_key.contains_key(*key))
                .collect::<Vec<_>>();
            if !missing_local.is_empty() {
                return Err("服务器请求补传的实体已不在本地，请重新同步".into());
            }
            let repair_entities = upload_keys
                .iter()
                .filter_map(|key| local_by_key.get(key).cloned())
                .collect::<Vec<_>>();
            let repair = push_sync_entities(
                state,
                task,
                retry_delays_ms,
                &agent,
                &base,
                &settings.token,
                &device_id,
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
    if !inventory_verified {
        return Err("同步后本地与服务器库存仍不一致，已停止并保留未确认状态".into());
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
            let (user, generation) = response.into_verified_identity().unwrap();
            assert_eq!(user.id, expected_id);
            assert_eq!(generation, 1);
        }
        let response: AuthMeResponse = serde_json::from_str("{}").unwrap();
        assert!(response.into_verified_identity().is_err());
    }

    #[test]
    fn sync_base_requires_https_except_localhost() {
        assert_eq!(normalize_auth_base("").unwrap(), "https://117.72.220.69");
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
    fn inventory_digest_matches_server_binary_format() {
        let entities = vec![
            db::SyncEntity {
                kind: "vocab".into(),
                id: "zh:词".into(),
                json: serde_json::json!({}),
                updated_at: 1_700_000_000_100,
                deleted_at: 1_700_000_000_200,
                device_id: "device-b".into(),
                sync_version: 7,
            },
            db::SyncEntity {
                kind: "book_state_v2".into(),
                id: "书-1".into(),
                json: serde_json::json!({}),
                updated_at: 1_700_000_000_000,
                deleted_at: 0,
                device_id: "device-a".into(),
                sync_version: 3,
            },
        ];
        assert_eq!(
            sync_inventory_digest(&entities),
            "5b47a5b8875ddb2d9cf9fc65c7698eaa3de450ccb547b84a11f2f688fa41c267"
        );
        let inventory = SyncInventoryResponse {
            server_time: 0,
            data_generation: 1,
            entity_count: 2,
            inventory_digest: "5b47a5b8875ddb2d9cf9fc65c7698eaa3de450ccb547b84a11f2f688fa41c267"
                .into(),
            revision: "10".into(),
        };
        assert!(inventory_matches(&entities, &inventory));
    }

    #[test]
    fn empty_reconcile_with_equal_count_proves_inventory_despite_digest_drift() {
        let response = SyncReconcileResponse {
            server_time: 1,
            data_generation: 1,
            entity_count: 2,
            inventory_digest: "legacy-digest".into(),
            revision: "10".into(),
            upload: vec![],
            entities: vec![],
        };
        assert!(reconcile_proves_inventory(2, &response));
        assert!(!reconcile_proves_inventory(1, &response));
    }

    #[test]
    fn reconcile_actions_never_prove_inventory() {
        let upload = SyncReconcileResponse {
            server_time: 1,
            data_generation: 1,
            entity_count: 2,
            inventory_digest: String::new(),
            revision: String::new(),
            upload: vec![SyncEntityKey {
                kind: "vocab".into(),
                id: "word".into(),
            }],
            entities: vec![],
        };
        assert!(!reconcile_proves_inventory(2, &upload));

        let mut download = upload;
        download.upload.clear();
        download.entities.push(db::SyncEntity {
            kind: "vocab".into(),
            id: "word".into(),
            json: serde_json::json!({}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "device-a".into(),
            sync_version: 1,
        });
        assert!(!reconcile_proves_inventory(2, &download));
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
