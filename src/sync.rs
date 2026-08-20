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
    sync_push_batches, SyncCheckpointResponse, SyncInventoryResponse, SyncPullResponse,
    SyncPushRequest, SyncPushResponse, SyncReconcileResponse,
};
use reader_core::sync::sync_scope_id;
use reconcile::{reconcile_request_body, reconcile_upload_entities};
use retry::sync_request_with_retry_delays;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use validation::{
    account_sync_scope, default_data_generation, ensure_data_generation, normalize_auth_base,
    normalize_sync_base,
};

const SYNC_PULL_PAGE_SIZE: usize = 1_000;
const MAX_SYNC_PULL_PAGES: usize = 1_000;
// Keep the client deadline longer than the service's 15-second handler
// deadline. This leaves enough time to receive a structured 504 and apply the
// bounded retry policy instead of racing the server with a transport timeout.
// Durable SQLite state and the automatic scheduler still handle a later retry.
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SYNC_REQUEST_ATTEMPTS: usize = 3;
const SYNC_RETRY_DELAYS_MS: &[u64] = &[750, 1_500];
// A laptop can wake before Wi-Fi or its captive portal is ready.  These are
// process-local retry delays for the startup refresh only: durable local edits
// still use the SQLite-backed scheduler below.  Keeping this bounded avoids a
// permanently noisy task after a real outage while letting a routine network
// transition recover without another click.
const SILENT_STARTUP_RETRY_DELAYS_MS: &[u64] = &[5_000, 15_000, 45_000, 120_000, 300_000];
const SYNC_FULL_INVENTORY_REPAIR_INTERVAL_MS: u64 = 60 * 60 * 1000;
const SYNC_LAST_FULL_INVENTORY_AT_KEY: &str = "last_full_inventory_at";
const SYNC_PAUSED: &str = "__sync_paused__";
const SYNC_CANCELLED: &str = "__sync_cancelled__";
struct SyncRunGuard<'a>(&'a AtomicBool);

fn checkpoint_inventory_repair_due(last_full_inventory_at: u64, now: u64) -> bool {
    last_full_inventory_at == 0
        || now.saturating_sub(last_full_inventory_at) >= SYNC_FULL_INVENTORY_REPAIR_INTERVAL_MS
}

fn checkpoint_is_eligible(
    cursor: Option<i64>,
    is_initial_scope_sync: bool,
    runtime_projection_pending: bool,
    has_pending_local_entities: bool,
    last_full_inventory_at: u64,
    now: u64,
) -> bool {
    cursor.is_some()
        && !is_initial_scope_sync
        && !runtime_projection_pending
        && !has_pending_local_entities
        && !checkpoint_inventory_repair_due(last_full_inventory_at, now)
}

/// A service deployed before these independently optional entities rejects the
/// whole scoped inventory request with HTTP 400.  The regular reading data is
/// still compatible, so remove only the newer categories and retry rather
/// than making a successful login unusable.  A current service keeps the
/// complete list and never takes this path.
fn legacy_inventory_fallback_kinds(kinds: &[String]) -> Option<Vec<String>> {
    let fallback = kinds
        .iter()
        .filter(|kind| {
            !matches!(
                kind.as_str(),
                crate::private_sync::READING_HANDOFF_KIND
                    | crate::private_sync::NEWS_SUBSCRIPTIONS_KIND
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    (fallback.len() < kinds.len() && !fallback.is_empty()).then_some(fallback)
}

#[derive(Clone)]
struct CachedSyncToken {
    protected_marker: String,
    value: CachedSyncTokenValue,
}

#[derive(Clone)]
enum CachedSyncTokenValue {
    Token(String),
    AccessDenied(String),
}

// macOS may ask to unlock the login keychain when a protected item is first
// read. Keep the successfully read token only in process memory so a single
// sync operation and adjacent account-status calls do not repeatedly prompt.
// Account writes and clears invalidate this cache below.
static SYNC_TOKEN_CACHE: OnceLock<Mutex<Option<CachedSyncToken>>> = OnceLock::new();

fn sync_token_cache() -> &'static Mutex<Option<CachedSyncToken>> {
    SYNC_TOKEN_CACHE.get_or_init(|| Mutex::new(None))
}

fn cache_sync_token(protected_marker: &str, token: &str) {
    if let Ok(mut cached) = sync_token_cache().lock() {
        *cached = Some(CachedSyncToken {
            protected_marker: protected_marker.to_string(),
            value: CachedSyncTokenValue::Token(token.to_string()),
        });
    }
}

fn cached_sync_token(protected_marker: &str) -> Option<String> {
    let cached = sync_token_cache().lock().ok()?;
    let value = cached
        .as_ref()
        .filter(|value| value.protected_marker == protected_marker)?;
    match &value.value {
        CachedSyncTokenValue::Token(token) => Some(token.clone()),
        CachedSyncTokenValue::AccessDenied(_) => None,
    }
}

/// Decide whether automatic work may use credentials without opening an
/// operating-system credential prompt.  A remembered macOS account can resume
/// after restart when Keychain grants access silently; otherwise the scheduler
/// remains dormant instead of turning a background read into a prompt.
pub(crate) fn automatic_sync_credentials_ready_without_prompt(db: &db::AppDb) -> bool {
    let record = sync_settings_record_from_db(db);
    if record.url.trim().is_empty() || record.user_id.trim().is_empty() {
        return false;
    }
    match record.protected_token.as_deref() {
        Some(protected) if secret_store::is_sync_secret_protected(protected) => {
            resolve_platform_sync_token_without_interaction(protected)
                .is_ok_and(|token| !token.trim().is_empty())
        }
        Some(protected) => !protected.trim().is_empty(),
        None => !record.legacy_token.trim().is_empty(),
    }
}

fn resolve_platform_sync_token_without_interaction(
    protected_marker: &str,
) -> Result<String, String> {
    let mut cached = sync_token_cache()
        .lock()
        .map_err(|_| "同步凭据缓存不可用".to_string())?;
    if let Some(value) = cached
        .as_ref()
        .filter(|value| value.protected_marker == protected_marker)
    {
        return match &value.value {
            CachedSyncTokenValue::Token(token) => Ok(token.clone()),
            CachedSyncTokenValue::AccessDenied(error) => Err(error.clone()),
        };
    }
    match secret_store::unprotect_sync_secret_without_interaction(protected_marker) {
        Ok(token) => {
            *cached = Some(CachedSyncToken {
                protected_marker: protected_marker.to_string(),
                value: CachedSyncTokenValue::Token(token.clone()),
            });
            Ok(token)
        }
        // A no-prompt Keychain probe may fail merely because macOS requires
        // interactive authorization.  That is not a user cancellation: do
        // not cache it, so an explicit Sync click can still ask once.
        Err(error) => Err(error),
    }
}

fn resolve_platform_sync_token(protected_marker: &str) -> Result<String, String> {
    // Hold the cache lock across the OS credential read. Startup restores
    // account state and may start background sync from different tasks; a
    // check-then-read gap lets all of them queue their own macOS Keychain
    // prompt before the first successful read reaches the cache.
    let mut cached = sync_token_cache()
        .lock()
        .map_err(|_| "同步凭据缓存不可用".to_string())?;
    if let Some(value) = cached
        .as_ref()
        .filter(|value| value.protected_marker == protected_marker)
    {
        return match &value.value {
            CachedSyncTokenValue::Token(token) => Ok(token.clone()),
            CachedSyncTokenValue::AccessDenied(error) => Err(error.clone()),
        };
    }
    match secret_store::unprotect_sync_secret(protected_marker) {
        Ok(token) => {
            *cached = Some(CachedSyncToken {
                protected_marker: protected_marker.to_string(),
                value: CachedSyncTokenValue::Token(token.clone()),
            });
            Ok(token)
        }
        Err(error) => {
            if secret_store::credential_access_was_denied(&error) {
                *cached = Some(CachedSyncToken {
                    protected_marker: protected_marker.to_string(),
                    value: CachedSyncTokenValue::AccessDenied(error.clone()),
                });
            }
            Err(error)
        }
    }
}

fn clear_cached_sync_token() {
    if let Ok(mut cached) = sync_token_cache().lock() {
        *cached = None;
    }
}

/// A manual Sync click is affirmative user intent to unlock the platform
/// credential.  It is the sole path that clears a remembered cancellation;
/// account rendering and automatic work must remain non-interactive.
fn prepare_explicit_sync_credential_retry() {
    if let Ok(mut cached) = sync_token_cache().lock() {
        if cached
            .as_ref()
            .is_some_and(|value| matches!(&value.value, CachedSyncTokenValue::AccessDenied(_)))
        {
            *cached = None;
        }
    }
    secret_store::allow_explicit_sync_secret_retry();
}

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

/// A non-authenticated connection observation for the account overview.
/// It intentionally contains neither the saved URL nor a credential: opening
/// the panel may show whether the service answers, but must not leak or unlock
/// the account token just to render the page.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncConnectionStatus {
    configured: bool,
    online: bool,
    credentials_ready: bool,
    requires_user_action: bool,
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
        if secret_store::is_sync_secret_protected(protected) {
            resolve_platform_sync_token(protected)
        } else {
            secret_store::unprotect_sync_secret(protected)
        }
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
    resolve_sync_settings(record)
}

fn read_sync_token(db: &db::AppDb) -> Result<String, String> {
    resolve_sync_settings(sync_settings_record_from_db(db)).map(|settings| settings.token)
}

fn migrate_sync_token_to_platform_store(db: &mut db::AppDb) -> Result<(), String> {
    let stored = db.metadata("sync_token_protected").unwrap_or_default();
    if secret_store::is_current_sync_secret_platform_marker(&stored) {
        return Ok(());
    }
    let token = read_sync_token(db)?;
    if token.is_empty() {
        return Ok(());
    }
    let protected = protect_sync_token(&token)?;
    db.set_metadata_batch(&[("sync_token_protected", &protected), ("sync_token", "")])
}

/// Refresh the current macOS Keychain item's app-only ACL after an explicit
/// user request. This performs all OS credential I/O outside SQLite's lock.
fn refresh_explicit_sync_credential_access_from_snapshot(
    stored: &str,
) -> Result<Option<String>, String> {
    if !secret_store::is_current_sync_secret_platform_marker(stored) {
        return Ok(None);
    }
    let token = resolve_platform_sync_token(stored)?;
    if token.is_empty() {
        return Ok(None);
    }
    protect_sync_token(&token).map(Some)
}

/// A manual sync is the user's affirmative approval to access their stored
/// credential. Refresh the current macOS Keychain item's app-only ACL at that
/// point, before network work begins, so a later app restart can read it
/// silently. Background sync deliberately never calls this function.
fn refresh_explicit_sync_credential_access(state: &AppState) -> Result<(), String> {
    let stored = state.with_db_read("sync_refresh_explicit_credential_snapshot", |db| {
        Ok(db.metadata("sync_token_protected").unwrap_or_default())
    })?;
    let Some(protected) = refresh_explicit_sync_credential_access_from_snapshot(&stored)? else {
        return Ok(());
    };
    state.with_db_write("sync_refresh_explicit_credential_persist", |db| {
        // Do not overwrite a concurrent logout or account switch.
        if db.metadata("sync_token_protected").as_deref() == Some(stored.as_str()) {
            db.set_metadata_batch(&[("sync_token_protected", &protected), ("sync_token", "")])?;
        }
        Ok(())
    })
}

fn protect_sync_token(token: &str) -> Result<String, String> {
    let protected = secret_store::protect_sync_secret(token.trim())?;
    if token.trim().is_empty() {
        clear_cached_sync_token();
    } else if secret_store::is_sync_secret_protected(&protected) {
        cache_sync_token(&protected, token.trim());
    } else {
        clear_cached_sync_token();
    }
    Ok(protected)
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
    // A changed development signature can make an old Keychain ACL reject
    // deletion. That stale OS item must not keep the local account signed in.
    if let Err(error) = secret_store::clear_sync_secret_for_logout() {
        crate::log(&format!(
            "[sync] local_credential_cleanup=deferred error={error}"
        ));
    }
    clear_cached_sync_token();
    db.set_metadata_batch(&[
        ("sync_token_protected", ""),
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

/// Logout is a local credential-removal operation. A verified account can
/// assign any remaining legacy state from SQLite metadata alone; an old,
/// unverifiable account is sealed as unclaimed. Neither case needs to unlock
/// the OS credential store.
fn prepare_saved_account_for_logout(state: &AppState) -> Result<SyncSettingsRecord, String> {
    let (record, verified_scope) = state.with_db_read("prepare_logout_snapshot", |db| {
        Ok((
            sync_settings_record_from_db(db),
            db.metadata(db::SYNC_IDENTITY_VERIFIED_SCOPE_KEY)
                .unwrap_or_default(),
        ))
    })?;
    let base = normalize_sync_base(&record.url).ok();
    let stored_scope = base
        .as_deref()
        .and_then(|base| account_sync_scope(base, &record.user_id).ok());
    state.with_db_write("prepare_logout_commit", |db| {
        if !saved_account_record_unchanged(db, &record, &verified_scope)? {
            return Err("同步账户设置已变化，请重试".into());
        }
        if let Some(scope) = stored_scope
            .as_deref()
            .filter(|scope| *scope == verified_scope)
        {
            db.migrate_legacy_sync_state(scope)?;
        } else {
            db.seal_unclaimed_legacy_sync_state()?;
        }
        Ok(())
    })?;
    Ok(record)
}

fn logout_token_without_keychain_prompt(record: &SyncSettingsRecord) -> String {
    match record.protected_token.as_deref() {
        Some(protected) if secret_store::is_sync_secret_protected(protected) => {
            cached_sync_token(protected).unwrap_or_default()
        }
        Some(protected) => secret_store::unprotect_sync_secret(protected).unwrap_or_default(),
        None => record.legacy_token.clone(),
    }
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
    let record = state.with_db_read("sync_get_settings", |db| {
        Ok(sync_settings_record_from_db(db))
    })?;
    // This command never serializes the token. Do not unlock the OS credential
    // store merely to render the remembered account during application start.
    Ok(SyncSettings {
        url: record.url,
        token: String::new(),
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

pub(crate) fn sync_account_open_refresh_inner(
    state: &AppState,
) -> Result<SyncConnectionStatus, String> {
    let record = state.with_db_read("sync_account_open_status", |db| {
        Ok(sync_settings_record_from_db(db))
    })?;
    let Ok(base) = normalize_sync_base(&record.url) else {
        return Ok(SyncConnectionStatus::default());
    };
    let credentials_ready = state.with_db_read("sync_account_open_credentials", |db| {
        Ok(automatic_sync_credentials_ready_without_prompt(db))
    })?;
    // Health is deliberately unauthenticated. This keeps an account-panel
    // open from turning into a Keychain prompt, while still distinguishing a
    // sleeping/offline service from a credential that needs user action.
    let online = agent_with_timeout(Duration::from_secs(5))
        .get(&format!("{base}/health"))
        .call()
        .is_ok();
    Ok(SyncConnectionStatus {
        configured: true,
        online,
        credentials_ready,
        requires_user_action: !credentials_ready
            && (!record
                .protected_token
                .as_deref()
                .unwrap_or_default()
                .is_empty()
                || !record.legacy_token.trim().is_empty()),
    })
}

// `tauri::generate_handler!` needs the command macro's private helper symbols
// in this parent module, so each exported command is a deliberately tiny
// forwarder to the adapter module.
#[tauri::command]
pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    commands::sync_get_settings(state)
}

#[tauri::command]
pub(crate) async fn sync_account_open_refresh(
    app: tauri::AppHandle,
) -> Result<SyncConnectionStatus, String> {
    commands::sync_account_open_refresh(app).await
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
                clear_sync_account(db)?;
                db.set_metadata("sync_url", &base)?;
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
        let record = prepare_saved_account_for_logout(state.inner())?;
        let token = logout_token_without_keychain_prompt(&record);
        if !token.is_empty() {
            if let Ok(base) = normalize_sync_base(&record.url) {
                // Remote revocation is best effort: an offline user must still
                // be able to remove credentials from this device immediately.
                let agent: ureq::Agent = ureq::Agent::config_builder()
                    .timeout_global(Some(std::time::Duration::from_secs(8)))
                    .build()
                    .into();
                let _ = agent
                    .post(&format!("{base}/v1/auth/logout"))
                    .header("Authorization", &format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .send_json(serde_json::json!({}));
            }
        }
        let record = state.with_db_write("auth_logout_clear", |db| {
            clear_sync_account(db)?;
            Ok(sync_settings_record_from_db(db))
        })?;
        Ok(SyncSettings {
            url: record.url,
            ..SyncSettings::default()
        })
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
    // v5 accepts only Unix-millisecond entity envelopes. Older desktop
    // releases persisted some envelope timestamps in seconds; repair that
    // metadata before pending rows are selected for the first v5 push.
    state.with_db_write("sync_normalize_v5_timestamps", |db| {
        db.normalize_protocol_v5_entity_timestamps().map(|_| ())
    })?;
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
    let initial_settings = resolve_sync_settings(initial_record.clone())?;
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
    let (
        settings_record,
        scope,
        cursor,
        is_initial_scope_sync,
        runtime_projection_pending,
        last_full_inventory_at,
    ) = {
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
        let runtime_projection_pending = db
            .sync_scope_metadata(&scope, "runtime_projection_pending")
            .as_deref()
            == Some("1");
        let last_full_inventory_at = db
            .sync_scope_metadata(&scope, SYNC_LAST_FULL_INVENTORY_AT_KEY)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        (
            settings_record,
            scope,
            cursor,
            is_initial_scope_sync,
            runtime_projection_pending,
            last_full_inventory_at,
        )
    };
    let settings = resolve_sync_settings(settings_record)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(request_timeout))
        .build()
        .into();

    // A previously complete cursor is a stronger no-change proof than a
    // fresh inventory scan, provided this device has no local entity awaiting
    // upload.  Keep a periodic full inventory repair pass: checkpoint is a
    // fast path, not a replacement for reconciliation after local corruption
    // or a future protocol mistake.
    let checkpoint_cursor = cursor.trim().parse::<i64>().ok();
    let has_pending_local_entities =
        state.with_db_read("sync_checkpoint_pending_entities", |db| {
            Ok(db
                .pending_sync_entities(&scope)?
                .into_iter()
                .any(|entity| crate::private_sync::is_entity_enabled(db, &entity.kind)))
        })?;
    let now = crate::now_ms();
    if checkpoint_is_eligible(
        checkpoint_cursor,
        is_initial_scope_sync,
        runtime_projection_pending,
        has_pending_local_entities,
        last_full_inventory_at,
        now,
    ) {
        check_sync_control(task)?;
        let cursor = checkpoint_cursor.expect("eligible checkpoint cursor");
        let checkpoint: Result<SyncCheckpointResponse, ureq::Error> = agent
            .get(&format!("{base}/v1/sync/checkpoint"))
            .query("dataGeneration", settings.data_generation.to_string())
            .query("cursor", cursor.to_string())
            .header("Authorization", &format!("Bearer {}", settings.token))
            .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
            .call()
            .and_then(|mut response| response.body_mut().read_json());
        if let Ok(checkpoint) = checkpoint {
            if checkpoint.proves_caught_up(settings.data_generation, cursor) {
                let server_time = i64::try_from(now).unwrap_or(i64::MAX);
                state.with_db_write("sync_checkpoint_finalize", |db| {
                    db.set_sync_scope_metadata(&scope, "last_sync_at", &server_time.to_string())?;
                    db.set_sync_scope_metadata(&scope, "last_pushed", "0")?;
                    db.set_sync_scope_metadata(&scope, "last_pulled", "0")?;
                    db.set_sync_scope_metadata(&scope, "last_accepted", "0")?;
                    db.set_sync_scope_metadata(&scope, "last_ignored", "0")?;
                    Ok(())
                })?;
                let report = SyncReport {
                    ok: true,
                    message: "同步完成：服务端 cursor 已确认，无需传输数据".into(),
                    pushed: 0,
                    pulled: 0,
                    accepted: 0,
                    ignored: 0,
                    server_time,
                };
                log_sync_stage("checkpoint", sync_started, "caught_up=true");
                return Ok(report);
            }
        }
        // A negative, an older server, a generation mismatch, malformed JSON,
        // or a network error must retain the original full synchronization
        // behavior.  The optional fast path never turns a transient outage
        // into a visible failure or an unverified local success.
        log_sync_stage("checkpoint", sync_started, "caught_up=false_or_unavailable");
    }

    // Pull before push. A newly imported zero-progress book must not overwrite
    // the established position from another computer. Continue paging until the
    // server confirms that this cursor has caught up.
    let mut pulled = 0u32;
    let mut pull_server_time = 0i64;
    // A pull/reconcile transaction persists this marker with its cursor and
    // rows.  It makes it safe to skip costly runtime projection on a stable
    // cursor, while still recovering correctly if the process stopped after a
    // durable remote commit and before its local files were applied.
    let mut runtime_projection_pending = runtime_projection_pending;
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
        runtime_projection_pending |= !enabled_entities.is_empty();
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
    if runtime_projection_pending {
        let runtime_projection_started = Instant::now();
        data_migration::apply_sqlite_to_runtime(state)?;
        // Persist the field-wise book merge only when a durable remote commit
        // (or a recovered pending projection) actually changed the runtime.
        data_migration::migrate_json_to_sqlite_from_remote_projection(state)?;
        state.with_db_write("sync_clear_runtime_projection_after_pull", |db| {
            db.set_sync_scope_metadata(&scope, "runtime_projection_pending", "0")
        })?;
        runtime_projection_pending = false;
        log_sync_stage(
            "runtime_projection",
            runtime_projection_started,
            "source=pull",
        );
    }
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
    let had_enabled_kinds = !enabled_kinds.is_empty();
    let mut inventory_kinds = enabled_kinds;
    let mut inventory_verified = inventory_kinds.is_empty();
    if !inventory_kinds.is_empty() {
        for reconcile_pass in 0..=3 {
            check_sync_control(task)?;
            let inventory: SyncInventoryResponse =
                match sync_request_with_retry_delays("inventory", task, retry_delays_ms, || {
                    agent
                        .get(&format!("{base}/v1/sync/inventory"))
                        .query_pairs(inventory_kinds.iter().map(|kind| ("kind", kind.as_str())))
                        .header("Authorization", &format!("Bearer {}", settings.token))
                        .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                        .call()?
                        .body_mut()
                        .read_json()
                }) {
                    Ok(inventory) => inventory,
                    Err(error) if error.contains("http status: 400") => {
                        let Some(fallback) = legacy_inventory_fallback_kinds(&inventory_kinds)
                        else {
                            return Err(error);
                        };
                        crate::log(
                            "[sync] inventory=legacy-server-fallback optional_categories_deferred",
                        );
                        inventory_kinds = fallback;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            ensure_data_generation(settings.data_generation, inventory.data_generation)?;
            push_server_time = push_server_time.max(inventory.server_time);
            let local: Vec<db::SyncEntityManifest> = state
                .with_db_read("sync_inventory_local_entities", |db| {
                    db.sync_entity_manifest_for_kinds(&inventory_kinds)
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
                reconcile_request_body(settings.data_generation, &inventory_kinds, &local);
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
                data_migration::migrate_json_to_sqlite_from_remote_projection(state)?;
                state.with_db_write("sync_clear_runtime_projection_after_reconcile", |db| {
                    db.set_sync_scope_metadata(&scope, "runtime_projection_pending", "0")
                })?;
                runtime_projection_pending = false;
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
        if had_enabled_kinds {
            db.set_sync_scope_metadata(
                &scope,
                SYNC_LAST_FULL_INVENTORY_AT_KEY,
                &crate::now_ms().to_string(),
            )?;
        }
        db.set_metadata(crate::private_sync::SYNC_FILTERS_CHANGED_KEY, "0")?;
        Ok(())
    })?;
    // Push conflicts can install an authoritative remote row after the pull
    // projection.  Their transaction sets the same durable marker; avoid a
    // second full runtime JSON/SQLite pass when no such row arrived.
    runtime_projection_pending |= state.with_db_read("sync_runtime_projection_pending", |db| {
        Ok(db
            .sync_scope_metadata(&scope, "runtime_projection_pending")
            .as_deref()
            == Some("1"))
    })?;
    if runtime_projection_pending {
        let runtime_projection_started = Instant::now();
        data_migration::apply_sqlite_to_runtime(state)?;
        state.with_db_write("sync_clear_runtime_projection_after_push", |db| {
            db.set_sync_scope_metadata(&scope, "runtime_projection_pending", "0")
        })?;
        log_sync_stage(
            "runtime_projection",
            runtime_projection_started,
            "source=push",
        );
    }
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

/// Start one deferred local-change sync.  The durable generation is owned by
/// SQLite; this function only hands the real network work to the existing
/// single-flight sync path and reports its outcome back to the scheduler.
pub(crate) fn start_automatic_sync(app: tauri::AppHandle, generation: u64) {
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue_or_resume(BackgroundTaskKind::Sync, "自动同步阅读数据");
    let _ = task_handle.spawn_detached("自动同步阅读数据", move |task| {
        let state = app.state::<AppState>();
        let result = sync_now_inner(state.inner(), Some(&task));
        let busy = matches!(&result, Err(error) if error == "同步任务正在进行");
        if busy {
            let _ = task.complete();
        } else {
            settle_sync_task(task, &result);
        }
        if result.is_ok() {
            let _ = app.emit("app-settings-synced", ());
        } else if !busy {
            // UI may have attached to this automatic single-flight run after
            // receiving "同步任务正在进行".  Always send a terminal signal so
            // it cannot remain visually syncing after the task has failed.
            let _ = app.emit("app-settings-sync-failed", ());
        }
        // A manual task may have won the single-flight guard after this timer
        // became due. Keep the task centre clean, but apply the normal short
        // retry delay so an already-overdue marker cannot spin new tasks.
        if busy {
            state
                .sync_auto_scheduler
                .finish_run(state.inner(), generation, false);
        } else {
            state
                .sync_auto_scheduler
                .finish_run(state.inner(), generation, result.is_ok());
        }
    });
}

/// Resume one remembered account at application startup.  This is deliberately
/// separate from local-change scheduling: remote edits should become visible
/// after restart even when this device has no pending mutation.  Keychain is
/// consulted only through the non-interactive path above, so a locked or
/// unapproved credential simply skips this run without a modal prompt.
pub(crate) fn start_silent_startup_sync(app: tauri::AppHandle) {
    start_silent_startup_sync_attempt(app, 0);
}

fn start_silent_startup_sync_attempt(app: tauri::AppHandle, retry_index: usize) {
    let credentials_ready = app
        .state::<AppState>()
        .with_db_read("sync_startup_credentials", |db| {
            Ok(automatic_sync_credentials_ready_without_prompt(db))
        })
        .unwrap_or(false);
    if !credentials_ready {
        return;
    }
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue_or_resume(BackgroundTaskKind::Sync, "启动同步阅读数据");
    let _ = task_handle.spawn_detached("启动同步阅读数据", move |task| {
        let state = app.state::<AppState>();
        let result = sync_now_inner(state.inner(), Some(&task));
        let busy = matches!(&result, Err(error) if error == "同步任务正在进行");
        if busy {
            let _ = task.complete();
        } else {
            settle_sync_task(task, &result);
        }
        if result.is_ok() {
            let _ = app.emit("app-settings-synced", ());
        } else if !busy {
            let _ = app.emit("app-settings-sync-failed", ());
            if result
                .as_ref()
                .err()
                .is_some_and(|error| silent_startup_sync_error_is_retryable(error))
            {
                schedule_silent_startup_sync_retry(app, retry_index);
            }
        }
    });
}

fn silent_startup_sync_error_is_retryable(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "connection",
        "hostnotfound",
        "host not found",
        "timeout",
        "timed out",
        "network",
        "dns",
        "io:",
        "status code: 5",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

fn schedule_silent_startup_sync_retry(app: tauri::AppHandle, retry_index: usize) {
    let Some(delay_ms) = SILENT_STARTUP_RETRY_DELAYS_MS.get(retry_index).copied() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        start_silent_startup_sync_attempt(app, retry_index.saturating_add(1));
    });
}

#[tauri::command]
pub(crate) async fn sync_now(app: tauri::AppHandle) -> Result<SyncReport, String> {
    let automatic_generation = app
        .state::<AppState>()
        .with_db_read("sync_manual_auto_generation", |db| {
            Ok(db.automatic_sync_due()?.map(|due| due.generation))
        })?;
    let task_handle = app
        .state::<AppState>()
        .background_tasks
        .enqueue_or_resume(BackgroundTaskKind::Sync, "同步阅读数据");
    task_handle
        .run_blocking(move |task| {
            let state = app.state::<AppState>();
            prepare_explicit_sync_credential_retry();
            refresh_explicit_sync_credential_access(state.inner())?;
            let result = sync_now_inner(state.inner(), Some(&task));
            settle_sync_task(task, &result);
            if result.is_ok() {
                let _ = app.emit("app-settings-synced", ());
            }
            if let Some(generation) = automatic_generation {
                // A manual run is still the attempt for the pending durable
                // local generation.  On failure, persist the same bounded
                // backoff as an automatic run.  If the credential was just
                // read successfully, `finish_run` wakes the cache-only
                // scheduler; if access was denied it remains dormant and
                // cannot create another Keychain prompt.
                state
                    .sync_auto_scheduler
                    .finish_run(state.inner(), generation, result.is_ok());
            } else if result
                .as_ref()
                .err()
                .is_some_and(|error| silent_startup_sync_error_is_retryable(error))
            {
                // A user can press Sync while Wi-Fi is still returning.  Do
                // not make them press it again after a transient failure: the
                // retry path reuses the already-authorized token and never
                // opens Keychain on its own.
                schedule_silent_startup_sync_retry(app.clone(), 0);
            }
            result
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_token_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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
    fn legacy_inventory_fallback_only_defers_new_optional_categories() {
        let kinds = vec![
            "reading_progress_v1".to_string(),
            crate::private_sync::READING_HANDOFF_KIND.to_string(),
            crate::private_sync::NEWS_SUBSCRIPTIONS_KIND.to_string(),
        ];
        assert_eq!(
            legacy_inventory_fallback_kinds(&kinds),
            Some(vec!["reading_progress_v1".to_string()])
        );
        assert_eq!(
            legacy_inventory_fallback_kinds(&["reading_progress_v1".to_string()]),
            None
        );
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
    fn platform_token_is_cached_only_for_the_current_protected_marker() {
        let _test_lock = sync_token_test_lock();
        clear_cached_sync_token();
        let record = SyncSettingsRecord {
            url: String::new(),
            protected_token: Some("keychain:v1".into()),
            legacy_token: String::new(),
            username: String::new(),
            user_id: String::new(),
            data_generation: 1,
            last_sync_at: 0,
            last_sync_pushed: 0,
            last_sync_pulled: 0,
            last_sync_accepted: 0,
            last_sync_ignored: 0,
        };
        cache_sync_token("keychain:v1", "session-token");
        assert_eq!(
            resolve_sync_settings(record.clone()).unwrap().token,
            "session-token"
        );

        clear_cached_sync_token();
        assert!(resolve_sync_settings(record).is_err());
    }

    #[test]
    fn explicit_sync_retry_discards_only_a_cached_keychain_cancellation() {
        let _test_lock = sync_token_test_lock();
        clear_cached_sync_token();
        if let Ok(mut cached) = sync_token_cache().lock() {
            *cached = Some(CachedSyncToken {
                protected_marker: "test:remembered".into(),
                value: CachedSyncTokenValue::AccessDenied("cancelled".into()),
            });
        }

        prepare_explicit_sync_credential_retry();
        assert!(cached_sync_token("test:remembered").is_none());

        cache_sync_token("test:remembered", "already-unlocked");
        prepare_explicit_sync_credential_retry();
        assert_eq!(
            cached_sync_token("test:remembered").as_deref(),
            Some("already-unlocked")
        );
        clear_cached_sync_token();
    }

    #[test]
    fn explicit_sync_refreshes_the_current_protected_credential_before_network_work() {
        let _test_lock = sync_token_test_lock();
        clear_cached_sync_token();
        let protected =
            refresh_explicit_sync_credential_access_from_snapshot("test:cmVtZW1iZXJlZA==").unwrap();
        assert_eq!(protected.as_deref(), Some("test:cmVtZW1iZXJlZA=="));
        assert_eq!(
            cached_sync_token("test:cmVtZW1iZXJlZA==").as_deref(),
            Some("remembered")
        );
        clear_cached_sync_token();
    }

    #[test]
    fn startup_refresh_retries_network_failures_but_not_credentials_or_quota() {
        assert!(silent_startup_sync_error_is_retryable(
            "pull 失败：io: Connection refused"
        ));
        assert!(silent_startup_sync_error_is_retryable(
            "inventory 失败：status code: 503"
        ));
        assert!(!silent_startup_sync_error_is_retryable(
            "已取消或拒绝访问 macOS 钥匙串；本次启动不再重复请求"
        ));
        assert!(!silent_startup_sync_error_is_retryable(
            "push 失败：status code: 429"
        ));
        assert!(!silent_startup_sync_error_is_retryable("请先登录账号"));
    }

    #[test]
    fn automatic_sync_warms_a_platform_token_without_interaction() {
        let _test_lock = sync_token_test_lock();
        clear_cached_sync_token();
        let database = db::AppDb::open_in_memory_for_tests();
        database
            .set_metadata("sync_url", "https://reader.example")
            .unwrap();
        database.set_metadata("sync_user_id", "u1").unwrap();
        database
            .set_metadata("sync_token_protected", "test:cmVtZW1iZXJlZA==")
            .unwrap();

        // The test-only marker exercises the same cache-warming branch as a
        // macOS Keychain item that grants access while interaction is disabled.
        assert!(automatic_sync_credentials_ready_without_prompt(&database));
        assert_eq!(
            cached_sync_token("test:cmVtZW1iZXJlZA==").as_deref(),
            Some("remembered")
        );
        clear_cached_sync_token();
    }

    #[test]
    fn automatic_sync_keeps_legacy_in_database_token_noninteractive() {
        let database = db::AppDb::open_in_memory_for_tests();
        database
            .set_metadata("sync_url", "https://reader.example")
            .unwrap();
        database.set_metadata("sync_user_id", "u1").unwrap();
        database.set_metadata("sync_token", "legacy-token").unwrap();

        assert!(automatic_sync_credentials_ready_without_prompt(&database));
    }

    #[test]
    fn checkpoint_fast_path_requires_a_stable_complete_local_snapshot() {
        let now = 7_200_000;
        assert!(checkpoint_is_eligible(
            Some(42),
            false,
            false,
            false,
            now - 60_000,
            now
        ));
        assert!(!checkpoint_is_eligible(
            None,
            false,
            false,
            false,
            now - 60_000,
            now
        ));
        assert!(!checkpoint_is_eligible(
            Some(42),
            true,
            false,
            false,
            now - 60_000,
            now
        ));
        assert!(!checkpoint_is_eligible(
            Some(42),
            false,
            true,
            false,
            now - 60_000,
            now
        ));
        assert!(!checkpoint_is_eligible(
            Some(42),
            false,
            false,
            true,
            now - 60_000,
            now
        ));
        assert!(!checkpoint_is_eligible(
            Some(42),
            false,
            false,
            false,
            0,
            now
        ));
        assert!(!checkpoint_is_eligible(
            Some(42),
            false,
            false,
            false,
            now - SYNC_FULL_INVENTORY_REPAIR_INTERVAL_MS,
            now,
        ));
    }

    #[test]
    fn logout_uses_only_an_already_cached_platform_token() {
        let _test_lock = sync_token_test_lock();
        clear_cached_sync_token();
        let record = SyncSettingsRecord {
            url: "https://reader.example".into(),
            protected_token: Some("keychain:v1".into()),
            legacy_token: String::new(),
            username: "alice".into(),
            user_id: "u1".into(),
            data_generation: 1,
            last_sync_at: 0,
            last_sync_pushed: 0,
            last_sync_pulled: 0,
            last_sync_accepted: 0,
            last_sync_ignored: 0,
        };
        assert_eq!(logout_token_without_keychain_prompt(&record), "");
        cache_sync_token("keychain:v1", "session-token");
        assert_eq!(
            logout_token_without_keychain_prompt(&record),
            "session-token"
        );
        clear_cached_sync_token();
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
}
