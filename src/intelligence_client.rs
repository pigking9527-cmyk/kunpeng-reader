//! Account-scoped client cache for the independent intelligence API.
//!
//! This module deliberately lives outside the WebView boundary.  It can reuse
//! the protected sync credential in Rust, but has no serializable credentials
//! and exposes cache-only status data.  Public intelligence bundles are never
//! placed in sync entities.

use crate::{profile, sync, AppState};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

const CACHE_SCHEMA_VERSION: i64 = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FEED_PAGES: usize = 1_000;
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARCHIVE_PACKAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;
const ASSET_DOWNLOAD_CHUNK_BYTES: usize = 1024 * 1024;
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const STREAM_IDLE_RECHECK: Duration = Duration::from_secs(2);
const STREAM_BACKOFF: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// Credentials never leave Rust. Do not add Serialize or a Tauri command
/// returning this value.
#[derive(Clone)]
struct AccountConnection {
    base: String,
    account_id: String,
    token: String,
    /// This is the already registered desktop installation identity.  It
    /// never crosses the WebView boundary; the API uses it only to keep this
    /// account's delivery acknowledgement and SSE cursor device-scoped.
    device_id: String,
}

/// Content-free native stream wake-up.  Editorial content must still travel
/// through the existing authenticated, schema-validated feed path.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryStreamEvent {
    delivery_id: String,
    cursor: String,
    kind: String,
}

#[derive(Debug, PartialEq, Eq)]
enum StreamEnd {
    Disconnected,
    LoginRequired,
    PermissionRequired,
    AccountChanged,
}

impl AccountConnection {
    fn current(state: &AppState) -> Result<Self, String> {
        let value = sync::intelligence_connection(state)?;
        let device_id =
            state.with_db_read("intelligence_client_device_id", |db| Ok(db.device_id()))?;
        if !valid_id(&device_id) {
            return Err("此设备身份无效，无法同步情报内容".into());
        }
        Ok(Self {
            base: value.base,
            account_id: value.account_id,
            token: value.token,
            device_id,
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCacheStatus {
    pub cache_present: bool,
    pub publication_count: u64,
    pub unacknowledged_count: u64,
    /// A fixed, content-free delivery outcome. Service address, account ID,
    /// raw error, package contents and credentials never cross this boundary.
    pub delivery_state: String,
    pub last_attempt_at: i64,
    pub last_success_at: i64,
    pub last_refresh_at: i64,
    pub last_fetched: u64,
    pub last_persisted: u64,
    pub last_acknowledged: u64,
    pub sse_state: String,
    pub last_sse_at: i64,
}

impl IntelligenceCacheStatus {
    fn not_logged_in() -> Self {
        Self {
            cache_present: false,
            publication_count: 0,
            unacknowledged_count: 0,
            delivery_state: "login_required".into(),
            last_attempt_at: 0,
            last_success_at: 0,
            last_refresh_at: 0,
            last_fetched: 0,
            last_persisted: 0,
            last_acknowledged: 0,
            sse_state: "login_required".into(),
            last_sse_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct IntelligenceRefreshReport {
    pub fetched: usize,
    pub persisted: usize,
    pub acknowledged: usize,
}

/// Content-free historical availability.  This intentionally exposes neither
/// server address nor old publication titles; those are only available after
/// an authorized archive request has completed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArchiveCalendar {
    pub days: Vec<IntelligenceArchiveDay>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArchiveDay {
    pub day: String,
    pub entry_count: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntelligenceArchiveSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArchiveRequest {
    pub request_id: String,
    pub state: String,
    pub requested_at: String,
    pub expires_at: String,
    pub request: IntelligenceArchiveSelector,
    pub content_ready: bool,
}

/// A deliberately narrow, validated projection of a formal publication for
/// the WebView.  It contains public editorial content and public source
/// citations only.  Authentication material, service addresses, cache paths,
/// bundle hashes and delivery state remain on the Rust side of the boundary.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCachedPublication {
    pub publication_id: String,
    pub kind: String,
    pub published_at: String,
    pub expires_at: String,
    pub importance: i64,
    pub events: Vec<IntelligenceCachedEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCachedEvent {
    pub event_id: String,
    pub revision_no: i64,
    pub series_id: Option<String>,
    pub title: String,
    pub occurred_at: Option<String>,
    pub body: String,
    /// Preserve the validated segment-to-note relation so the only product UI
    /// can render the required inline `注` links.  Flattening the body alone
    /// would make an otherwise valid formal package lose its evidence trail.
    pub segments: Vec<IntelligenceCachedSegment>,
    pub media: Vec<IntelligenceCachedMedia>,
    pub sources: Vec<IntelligenceCachedSource>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCachedSource {
    pub note_id: String,
    pub publisher: String,
    pub title: String,
    pub original_url: String,
    pub published_at: String,
    pub fallback_excerpt: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCachedSegment {
    pub block_id: String,
    pub text: String,
    pub note_ids: Vec<String>,
}

/// Verified public media metadata only. Local cache paths and credentials stay
/// inside this module; video remains an HTTPS link and is never downloaded.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceCachedMedia {
    pub asset_id: String,
    pub sha256: String,
    pub mime: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub block_id: String,
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capabilities {
    schema_version: u8,
    feed_enabled: bool,
    server_now: String,
    archive: ArchiveAvailability,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveAvailability {
    available_from: Option<String>,
    available_to: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeedPage {
    schema_version: u8,
    items: Vec<FeedItem>,
    next_cursor: String,
    server_now: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeedItem {
    publication_id: String,
    kind: String,
    published_at: String,
    expires_at: String,
    revision_no: i64,
    importance: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveCalendarResponse {
    schema_version: u8,
    days: Vec<ArchiveCalendarDayResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveCalendarDayResponse {
    day: String,
    entry_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveRequestResponse {
    schema_version: u8,
    request_id: String,
    state: String,
    requested_at: String,
    expires_at: String,
    request: IntelligenceArchiveSelector,
    content_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveContentResponse {
    schema_version: u8,
    request_id: String,
    content_base64: String,
    content_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedAsset {
    asset_id: String,
    sha256: String,
    mime: String,
    bytes: usize,
    width: Option<i64>,
    height: Option<i64>,
}

struct AssetChunk {
    mime: String,
    bytes: Vec<u8>,
}

trait IntelligenceTransport {
    fn capabilities(&mut self) -> Result<Value, String>;
    fn feed(&mut self, cursor: Option<&str>) -> Result<Value, String>;
    fn publication(&mut self, id: &str) -> Result<Value, String>;
    fn acknowledge(&mut self, id: &str) -> Result<(), String>;
    fn asset_range(&mut self, sha256: &str, start: usize, end: usize)
        -> Result<AssetChunk, String>;
}

trait IntelligenceArchiveTransport {
    fn archive_calendar(&mut self) -> Result<Value, String>;
    fn archive_create(&mut self, selector: &IntelligenceArchiveSelector) -> Result<Value, String>;
    fn archive_status(&mut self, request_id: &str) -> Result<Value, String>;
    fn archive_content(&mut self, request_id: &str) -> Result<Value, String>;
    fn archive_ack(&mut self, request_id: &str) -> Result<Value, String>;
}

struct HttpTransport {
    agent: ureq::Agent,
    base: String,
    token: String,
    device_id: String,
}

impl HttpTransport {
    fn new(connection: AccountConnection) -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .into(),
            base: connection.base,
            token: connection.token,
            device_id: connection.device_id,
        }
    }

    fn get_json(&self, path: &str) -> Result<Value, String> {
        self.agent
            .get(&format!("{}{path}", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(intelligence_http_error)?
            .into_body()
            .read_json::<Value>()
            .map_err(|_| "情报服务返回无效 JSON".to_string())
    }

    fn post_json(&self, path: &str, body: Value) -> Result<Value, String> {
        self.agent
            .post(&format!("{}{path}", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", &uuid::Uuid::new_v4().to_string())
            .send_json(body)
            .map_err(intelligence_http_error)?
            .into_body()
            .read_json::<Value>()
            .map_err(|_| "情报服务返回无效 JSON".to_string())
    }

    /// The service keeps the SSE cursor and delivery ACK state per account and
    /// device. Register before either operation so a newly logged-in desktop
    /// does not silently subscribe with an unknown device identity.
    fn register_device(&self) -> Result<(), String> {
        let platform = intelligence_device_platform()?;
        let response = self.post_json(
            "/v1/intelligence/devices",
            serde_json::json!({
                "schemaVersion": 1,
                "deviceId": self.device_id,
                "platform": platform,
                "quietHours": {},
            }),
        )?;
        validate_registered_device(&response, &self.device_id, platform)
    }
}

impl IntelligenceTransport for HttpTransport {
    fn capabilities(&mut self) -> Result<Value, String> {
        self.get_json("/v1/intelligence/capabilities")
    }

    fn feed(&mut self, cursor: Option<&str>) -> Result<Value, String> {
        let path = match cursor.filter(|value| !value.is_empty()) {
            Some(cursor) => format!("/v1/intelligence/feed?cursor={cursor}&limit=100"),
            None => "/v1/intelligence/feed?limit=100".into(),
        };
        self.get_json(&path)
    }

    fn publication(&mut self, id: &str) -> Result<Value, String> {
        self.get_json(&format!("/v1/intelligence/publications/{id}"))
    }

    fn acknowledge(&mut self, id: &str) -> Result<(), String> {
        self.agent.post(&format!("{}/v1/intelligence/deliveries/{id}/ack", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .header("X-Intelligence-Device-Id", &self.device_id)
            .header("Idempotency-Key", &uuid::Uuid::new_v4().to_string())
            .send_json(serde_json::json!({"schemaVersion": 1, "publicationId": id, "acknowledgedAt": now_rfc3339()}))
            .map_err(|error| match error {
                ureq::Error::StatusCode(401) => "登录状态失效，请重新登录后刷新情报内容".to_string(),
                ureq::Error::StatusCode(403) => "当前账户没有情报中心访问权限".to_string(),
                _ => "情报投递确认失败".to_string(),
            })?;
        Ok(())
    }

    fn asset_range(
        &mut self,
        sha256: &str,
        start: usize,
        end: usize,
    ) -> Result<AssetChunk, String> {
        if !valid_sha256(sha256) || start > end || end >= MAX_ASSET_BYTES {
            return Err("情报图片请求无效".into());
        }
        let mut response = self
            .agent
            .get(&format!("{}/v1/intelligence/assets/{sha256}", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Range", &format!("bytes={start}-{end}"))
            .call()
            .map_err(intelligence_http_error)?;
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let bytes = response
            .body_mut()
            .read_to_vec()
            .map_err(|_| "读取情报图片失败".to_string())?;
        Ok(AssetChunk { mime, bytes })
    }
}

impl IntelligenceArchiveTransport for HttpTransport {
    fn archive_calendar(&mut self) -> Result<Value, String> {
        self.get_json("/v1/intelligence/archive/calendar")
    }

    fn archive_create(&mut self, selector: &IntelligenceArchiveSelector) -> Result<Value, String> {
        self.post_json(
            "/v1/intelligence/archive-requests",
            serde_json::json!({"request": selector}),
        )
    }

    fn archive_status(&mut self, request_id: &str) -> Result<Value, String> {
        self.get_json(&format!("/v1/intelligence/archive-requests/{request_id}"))
    }

    fn archive_content(&mut self, request_id: &str) -> Result<Value, String> {
        self.get_json(&format!(
            "/v1/intelligence/archive-requests/{request_id}/content"
        ))
    }

    fn archive_ack(&mut self, request_id: &str) -> Result<Value, String> {
        self.post_json(
            &format!("/v1/intelligence/archive-requests/{request_id}/content/ack"),
            serde_json::json!({}),
        )
    }
}

fn intelligence_device_platform() -> Result<&'static str, String> {
    match std::env::consts::OS {
        "windows" => Ok("windows"),
        "macos" => Ok("macos"),
        "linux" => Ok("linux"),
        _ => Err("当前平台不支持情报设备登记".into()),
    }
}

fn validate_registered_device(
    response: &Value,
    expected_device_id: &str,
    expected_platform: &str,
) -> Result<(), String> {
    if response["schemaVersion"].as_u64() != Some(1)
        || response["deviceId"].as_str() != Some(expected_device_id)
        || response["platform"].as_str() != Some(expected_platform)
        || !response["quietHours"].is_object()
        || !response["updatedAt"].as_str().is_some_and(valid_timestamp)
    {
        return Err("情报服务返回的设备登记无效".into());
    }
    Ok(())
}

fn intelligence_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(401) => "登录状态失效，请重新登录后刷新情报内容".to_string(),
        ureq::Error::StatusCode(403) => "当前账户没有情报中心访问权限".to_string(),
        _ => "情报服务请求失败".to_string(),
    }
}

/// Pull the authenticated account's formal publications. This is intentionally
/// Rust-only; callers should run it from a native background task, never from
/// page open or refresh handlers.
pub(crate) fn refresh_current_account(
    state: &AppState,
) -> Result<IntelligenceRefreshReport, String> {
    let connection = AccountConnection::current(state)?;
    refresh_for_connection(connection)
}

fn refresh_for_connection(
    connection: AccountConnection,
) -> Result<IntelligenceRefreshReport, String> {
    let root = cache_root()?;
    let mut cache = IntelligenceCache::open(&root, &connection.account_id, &connection.base)?;
    let mut transport = HttpTransport::new(connection);
    cache.begin_refresh_attempt()?;
    let result = transport
        .register_device()
        .and_then(|()| refresh_with_transport_inner(&mut cache, &mut transport));
    finish_refresh_attempt(&cache, result)
}

/// Starts one process-local supervisor for the content-free delivery stream.
/// It is deliberately called from native startup, never from a WebView/page
/// action.  A notification only wakes the existing verified refresh path;
/// stream payloads are not saved or exposed to JavaScript.
pub(crate) fn spawn_delivery_stream(app: tauri::AppHandle) {
    let _ = thread::Builder::new()
        .name("intelligence-delivery-stream".into())
        .spawn(move || delivery_stream_supervisor(app));
}

fn delivery_stream_supervisor(app: tauri::AppHandle) {
    let mut retry_index = 0usize;
    let mut cursor = String::new();
    let mut active_scope = String::new();
    let mut registered_scope = String::new();
    loop {
        let state = app.state::<AppState>();
        let connection = match AccountConnection::current(state.inner()) {
            Ok(connection) => connection,
            Err(_) => {
                // Logged out / inaccessible protected credential.  There is
                // no network work until a valid account becomes available.
                thread::sleep(STREAM_IDLE_RECHECK);
                retry_index = 0;
                cursor.clear();
                continue;
            }
        };
        let scope = account_scope_hash(&connection.account_id, &connection.base);
        if active_scope != scope {
            cursor = cache_root()
                .and_then(|root| {
                    IntelligenceCache::open(&root, &connection.account_id, &connection.base)
                })
                .and_then(|cache| cache.stream_cursor())
                .unwrap_or_default();
            active_scope = scope.clone();
            registered_scope.clear();
        }
        if registered_scope != scope {
            match HttpTransport::new(connection.clone()).register_device() {
                Ok(()) => {
                    registered_scope = scope.clone();
                    set_stream_state(&connection, "connecting");
                }
                Err(error) => {
                    set_stream_state(&connection, stream_state_for_error(&error));
                    let delay = STREAM_BACKOFF[retry_index.min(STREAM_BACKOFF.len() - 1)];
                    retry_index = retry_index.saturating_add(1);
                    thread::sleep(delay);
                    continue;
                }
            }
        }
        let end = stream_once(&app, state.inner(), &connection, &mut cursor);
        if let Ok(cache) = cache_root().and_then(|root| {
            IntelligenceCache::open(&root, &connection.account_id, &connection.base)
        }) {
            let _ = cache.set_stream_cursor(&cursor);
        }
        if end == StreamEnd::AccountChanged {
            // Never carry a previous account's cursor into the next account.
            cursor.clear();
            retry_index = 0;
            continue;
        }
        set_stream_state(
            &connection,
            match end {
                StreamEnd::Disconnected => "reconnecting",
                StreamEnd::LoginRequired => "login_required",
                StreamEnd::PermissionRequired => "permission_required",
                StreamEnd::AccountChanged => unreachable!("handled above"),
            },
        );
        let delay = STREAM_BACKOFF[retry_index.min(STREAM_BACKOFF.len() - 1)];
        retry_index = retry_index.saturating_add(1);
        thread::sleep(delay);
    }
}

/// Consume a single SSE response.  All state-changing work is guarded by a
/// fresh account comparison, so a late frame from an old session cannot
/// refresh or write on behalf of a newly signed-in account.
fn stream_once(
    app: &tauri::AppHandle,
    state: &AppState,
    session: &AccountConnection,
    cursor: &mut String,
) -> StreamEnd {
    if !stream_session_is_current(state, session) {
        return StreamEnd::AccountChanged;
    }
    let suffix = if cursor.is_empty() {
        format!("/v1/intelligence/stream?deviceId={}", session.device_id)
    } else {
        format!(
            "/v1/intelligence/stream?cursor={cursor}&deviceId={}",
            session.device_id
        )
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(STREAM_CONNECT_TIMEOUT))
        .build()
        .into();
    let response = match agent
        .get(&format!("{}{}", session.base, suffix))
        .header("Authorization", &format!("Bearer {}", session.token))
        .header("Accept", "text/event-stream")
        .call()
    {
        Ok(response) => {
            set_stream_state(session, "connected");
            response
        }
        Err(ureq::Error::StatusCode(401)) => return StreamEnd::LoginRequired,
        Err(ureq::Error::StatusCode(403)) => return StreamEnd::PermissionRequired,
        Err(_) => return StreamEnd::Disconnected,
    };
    let mut reader = BufReader::new(response.into_body().into_reader());
    let mut data = String::new();
    loop {
        if !stream_session_is_current(state, session) {
            return StreamEnd::AccountChanged;
        }
        let mut line = String::new();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(_) => return StreamEnd::Disconnected,
        };
        if read == 0 {
            return StreamEnd::Disconnected;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if let Some(event) = parse_delivery_stream_event(&data) {
                // Monotonic cursor prevents replayed frames from causing a
                // second refresh after a reconnect.
                if cursor_is_newer(&event.cursor, cursor) {
                    *cursor = event.cursor;
                    if !stream_session_is_current(state, session) {
                        return StreamEnd::AccountChanged;
                    }
                    // Refresh errors are deliberately not surfaced to the
                    // WebView and do not affect the cached, already verified
                    // content. The next valid delivery or reconnect retries.
                    //
                    // The notification carries no delivery data.  It only
                    // tells an already open workspace to re-read the native,
                    // account-isolated cache after this verified refresh has
                    // completed.  This prevents the UI from continuing to
                    // display an older cache count until the user clicks the
                    // manual refresh button.
                    if refresh_for_connection(session.clone()).is_ok() {
                        let _ = app.emit("intelligence-delivery-updated", ());
                    }
                }
            }
            data.clear();
        } else if let Some(value) = line.strip_prefix("data:") {
            // SSE permits multiple data lines; cap the content-free frame so
            // a malicious server cannot make the background subscriber grow.
            if data.len().saturating_add(value.len()) <= 1024 {
                data.push_str(value.trim_start());
            } else {
                data.clear();
            }
        }
    }
}

fn stream_session_is_current(state: &AppState, session: &AccountConnection) -> bool {
    let Ok(current) = AccountConnection::current(state) else {
        return false;
    };
    stream_sessions_match(session, &current)
}

fn stream_sessions_match(session: &AccountConnection, current: &AccountConnection) -> bool {
    current.base == session.base
        && current.account_id == session.account_id
        && current.token == session.token
        && current.device_id == session.device_id
}

fn parse_delivery_stream_event(data: &str) -> Option<DeliveryStreamEvent> {
    let event: DeliveryStreamEvent = serde_json::from_str(data).ok()?;
    let cursor = event.cursor.parse::<u64>().ok()?;
    if cursor == 0 || !valid_id(&event.delivery_id) || !valid_stream_kind(&event.kind) {
        return None;
    }
    Some(event)
}

fn cursor_is_newer(next: &str, current: &str) -> bool {
    let Ok(next) = next.parse::<u64>() else {
        return false;
    };
    current
        .parse::<u64>()
        .map_or(true, |current| next > current)
}

fn valid_stream_kind(value: &str) -> bool {
    matches!(value, "daily" | "event")
}

fn valid_delivery_state(value: &str) -> bool {
    matches!(
        value,
        "not_refreshed"
            | "refreshing"
            | "server_empty"
            | "ready"
            | "login_required"
            | "permission_required"
            | "delivery_failed"
    )
}

fn valid_sse_state(value: &str) -> bool {
    matches!(
        value,
        "not_started"
            | "connecting"
            | "connected"
            | "reconnecting"
            | "login_required"
            | "permission_required"
    )
}

fn delivery_state_for_error(error: &str) -> &'static str {
    if error.contains("未登录") || error.contains("登录状态失效") {
        "login_required"
    } else if error.contains("未启用") || error.contains("访问权限") || error.contains("403")
    {
        "permission_required"
    } else {
        "delivery_failed"
    }
}

fn stream_state_for_error(error: &str) -> &'static str {
    match delivery_state_for_error(error) {
        "login_required" => "login_required",
        "permission_required" => "permission_required",
        _ => "reconnecting",
    }
}

/// Persist only a fixed aggregate stream state. This path must never store an
/// endpoint, token, delivery frame, or raw transport error.
fn set_stream_state(connection: &AccountConnection, state: &str) {
    if !valid_sse_state(state) {
        return;
    }
    let _ = cache_root()
        .and_then(|root| IntelligenceCache::open(&root, &connection.account_id, &connection.base))
        .and_then(|cache| cache.set_sse_state(state));
}

/// Return only aggregate cache data for the currently authenticated account.
/// No URL, token, or cross-account publication contents are returned here.
pub(crate) fn current_cache_status(state: &AppState) -> Result<IntelligenceCacheStatus, String> {
    let connection = match AccountConnection::current(state) {
        Ok(connection) => connection,
        Err(error) if delivery_state_for_error(&error) == "login_required" => {
            return Ok(IntelligenceCacheStatus::not_logged_in());
        }
        Err(error) => return Err(error),
    };
    IntelligenceCache::open(&cache_root()?, &connection.account_id, &connection.base)?.status()
}

/// Read formal publications which have already passed the network-time V1
/// validation and are still within their local display window.  This function
/// never performs I/O beyond the account-isolated SQLite cache.
pub(crate) fn current_cached_publications(
    state: &AppState,
) -> Result<Vec<IntelligenceCachedPublication>, String> {
    let connection = AccountConnection::current(state)?;
    IntelligenceCache::open(&cache_root()?, &connection.account_id, &connection.base)?
        .cached_publications()
}

/// Return a verified, account-scoped image as a data URL for the reader's
/// already-open WebView.  The native cache path and service credentials never
/// leave Rust, and the image was downloaded and SHA-256 checked before the
/// delivery acknowledgement.
pub(crate) fn current_asset_data_url(state: &AppState, sha256: String) -> Result<String, String> {
    if !valid_sha256(&sha256) {
        return Err("情报图片标识无效".into());
    }
    let connection = AccountConnection::current(state)?;
    IntelligenceCache::open(&cache_root()?, &connection.account_id, &connection.base)?
        .asset_data_url(&sha256)
}

pub(crate) fn archive_calendar_current_account(
    state: &AppState,
) -> Result<IntelligenceArchiveCalendar, String> {
    let connection = AccountConnection::current(state)?;
    let mut transport = HttpTransport::new(connection);
    archive_calendar_with_transport(&mut transport)
}

pub(crate) fn archive_request_current_account(
    state: &AppState,
    selector: IntelligenceArchiveSelector,
) -> Result<IntelligenceArchiveRequest, String> {
    validate_archive_selector(&selector)?;
    let connection = AccountConnection::current(state)?;
    let mut transport = HttpTransport::new(connection);
    archive_request_with_transport(&mut transport, &selector)
}

pub(crate) fn archive_status_current_account(
    state: &AppState,
    request_id: String,
) -> Result<IntelligenceArchiveRequest, String> {
    if !valid_id(&request_id) {
        return Err("历史请求 ID 无效".into());
    }
    let connection = AccountConnection::current(state)?;
    let mut transport = HttpTransport::new(connection);
    archive_status_with_transport(&mut transport, &request_id)
}

/// Download the temporary historical package, verify it before commit, and
/// only then acknowledge delivery.  It deliberately uses the same
/// account-and-service scoped cache as hot publications, so account switching
/// cannot reveal another account's temporary archive.
pub(crate) fn archive_download_current_account(
    state: &AppState,
    request_id: String,
) -> Result<IntelligenceArchiveRequest, String> {
    if !valid_id(&request_id) {
        return Err("历史请求 ID 无效".into());
    }
    let connection = AccountConnection::current(state)?;
    let root = cache_root()?;
    let mut cache = IntelligenceCache::open(&root, &connection.account_id, &connection.base)?;
    let mut transport = HttpTransport::new(connection);
    archive_download_with_transport(&mut cache, &mut transport, &request_id)
}

/// Native command boundary deliberately returns only aggregate cache state.
/// The protected account token and service base never cross this boundary.
#[tauri::command]
pub(crate) async fn intelligence_client_cache_status(
    app: tauri::AppHandle,
) -> Result<IntelligenceCacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        current_cache_status(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("读取情报缓存状态失败：{error}"))?
}

/// Native cache-read boundary for the single existing intelligence workspace.
/// It intentionally cannot refresh, discover endpoints, or expose the
/// account's credential/base URL.
#[tauri::command]
pub(crate) async fn intelligence_client_cached_publications(
    app: tauri::AppHandle,
) -> Result<Vec<IntelligenceCachedPublication>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        current_cached_publications(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("读取情报缓存内容失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn intelligence_client_asset_data_url(
    app: tauri::AppHandle,
    sha256: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        current_asset_data_url(app.state::<AppState>().inner(), sha256)
    })
    .await
    .map_err(|error| format!("读取情报图片失败：{error}"))?
}

/// An explicit native refresh hook for the future client UI/scheduler. It is
/// not registered by this change, so opening the current intelligence page
/// cannot accidentally start network work.
#[tauri::command]
pub(crate) async fn intelligence_client_refresh(
    app: tauri::AppHandle,
) -> Result<IntelligenceRefreshReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_current_account(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("同步情报内容失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn intelligence_archive_calendar(
    app: tauri::AppHandle,
) -> Result<IntelligenceArchiveCalendar, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive_calendar_current_account(app.state::<AppState>().inner())
    })
    .await
    .map_err(|error| format!("读取情报历史日历失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn intelligence_archive_request(
    app: tauri::AppHandle,
    request: IntelligenceArchiveSelector,
) -> Result<IntelligenceArchiveRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive_request_current_account(app.state::<AppState>().inner(), request)
    })
    .await
    .map_err(|error| format!("创建情报历史请求失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn intelligence_archive_request_status(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<IntelligenceArchiveRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive_status_current_account(app.state::<AppState>().inner(), request_id)
    })
    .await
    .map_err(|error| format!("读取情报历史请求失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn intelligence_archive_download(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<IntelligenceArchiveRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive_download_current_account(app.state::<AppState>().inner(), request_id)
    })
    .await
    .map_err(|error| format!("下载情报历史内容失败：{error}"))?
}

#[cfg(test)]
fn refresh_with_transport<T: IntelligenceTransport>(
    cache: &mut IntelligenceCache,
    transport: &mut T,
) -> Result<IntelligenceRefreshReport, String> {
    cache.begin_refresh_attempt()?;
    let result = refresh_with_transport_inner(cache, transport);
    finish_refresh_attempt(cache, result)
}

fn finish_refresh_attempt(
    cache: &IntelligenceCache,
    result: Result<IntelligenceRefreshReport, String>,
) -> Result<IntelligenceRefreshReport, String> {
    match result {
        Ok(report) => {
            cache.record_refresh_success(&report)?;
            Ok(report)
        }
        Err(error) => {
            // Status persistence is diagnostics only. A cache write failure
            // must never replace the actual delivery failure or permit ACK.
            let _ = cache.record_refresh_failure(delivery_state_for_error(&error));
            Err(error)
        }
    }
}

fn refresh_with_transport_inner<T: IntelligenceTransport>(
    cache: &mut IntelligenceCache,
    transport: &mut T,
) -> Result<IntelligenceRefreshReport, String> {
    let capabilities: Capabilities = serde_json::from_value(transport.capabilities()?)
        .map_err(|_| "情报能力响应不符合 V1 协议".to_string())?;
    validate_capabilities(&capabilities)?;
    if !capabilities.feed_enabled {
        return Err("当前账户未启用情报内容".into());
    }

    let mut report = IntelligenceRefreshReport {
        fetched: 0,
        persisted: 0,
        acknowledged: 0,
    };
    let mut cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();
    for _ in 0..MAX_FEED_PAGES {
        let page: FeedPage = serde_json::from_value(transport.feed(cursor.as_deref())?)
            .map_err(|_| "情报列表响应不符合 V1 协议".to_string())?;
        validate_feed_page(&page)?;
        for item in page.items {
            report.fetched += 1;
            let bundle = transport.publication(&item.publication_id)?;
            validate_bundle_for_feed(&bundle, &item)?;
            // Image bytes are part of the formal delivery.  Do not ACK a
            // publication until every referenced image has been verified and
            // committed inside this account's cache scope.  Video remains a
            // projected HTTPS link and is intentionally not downloaded.
            cache.cache_bundle_assets(&bundle, transport)?;
            // Commit happens before network ACK. A failed SQLite transaction
            // leaves the delivery unacknowledged for a later retry.
            let inserted = cache.persist_bundle(&bundle, item.importance)?;
            if inserted {
                report.persisted += 1;
            }
            transport.acknowledge(&item.publication_id)?;
            cache.mark_acknowledged(&item.publication_id)?;
            report.acknowledged += 1;
        }
        if page.next_cursor.is_empty() {
            break;
        }
        if !seen_cursors.insert(page.next_cursor.clone()) {
            return Err("情报列表游标循环".into());
        }
        cursor = Some(page.next_cursor);
    }
    Ok(report)
}

fn archive_calendar_with_transport<T: IntelligenceArchiveTransport>(
    transport: &mut T,
) -> Result<IntelligenceArchiveCalendar, String> {
    let response: ArchiveCalendarResponse =
        serde_json::from_value(transport.archive_calendar()?)
            .map_err(|_| "情报历史日历响应不符合 V1 协议".to_string())?;
    if response.schema_version != 1 || response.days.len() > 3_660 {
        return Err("情报历史日历响应无效".into());
    }
    let mut prior = None;
    let mut days = Vec::with_capacity(response.days.len());
    for entry in response.days {
        if !valid_day(&entry.day)
            || entry.entry_count < 0
            || prior
                .as_deref()
                .is_some_and(|previous: &str| previous <= entry.day.as_str())
        {
            return Err("情报历史日历响应无效".into());
        }
        prior = Some(entry.day.clone());
        days.push(IntelligenceArchiveDay {
            day: entry.day,
            entry_count: entry.entry_count,
        });
    }
    Ok(IntelligenceArchiveCalendar { days })
}

fn archive_request_with_transport<T: IntelligenceArchiveTransport>(
    transport: &mut T,
    selector: &IntelligenceArchiveSelector,
) -> Result<IntelligenceArchiveRequest, String> {
    parse_archive_request(transport.archive_create(selector)?, Some(selector))
}

fn archive_status_with_transport<T: IntelligenceArchiveTransport>(
    transport: &mut T,
    request_id: &str,
) -> Result<IntelligenceArchiveRequest, String> {
    let request = parse_archive_request(transport.archive_status(request_id)?, None)?;
    if request.request_id != request_id {
        return Err("情报历史请求响应不匹配".into());
    }
    Ok(request)
}

fn archive_download_with_transport<T: IntelligenceArchiveTransport>(
    cache: &mut IntelligenceCache,
    transport: &mut T,
    request_id: &str,
) -> Result<IntelligenceArchiveRequest, String> {
    let status = archive_status_with_transport(transport, request_id)?;
    if status.state != "READY" && status.state != "DOWNLOADED" {
        return Ok(status);
    }
    let response: ArchiveContentResponse =
        serde_json::from_value(transport.archive_content(request_id)?)
            .map_err(|_| "情报历史内容响应不符合 V1 协议".to_string())?;
    if response.schema_version != 1
        || response.request_id != request_id
        || !valid_sha256(&response.content_sha256)
    {
        return Err("情报历史内容响应无效".into());
    }
    let bytes = STANDARD
        .decode(response.content_base64.as_bytes())
        .map_err(|_| "情报历史内容编码无效".to_string())?;
    if bytes.is_empty()
        || bytes.len() > MAX_ARCHIVE_PACKAGE_BYTES
        || hex(&Sha256::digest(&bytes)) != response.content_sha256
    {
        return Err("情报历史内容哈希校验失败".into());
    }
    let package: Value =
        serde_json::from_slice(&bytes).map_err(|_| "情报历史内容不是有效 JSON".to_string())?;
    validate_archive_package(&package, &status.request)?;
    // The package is committed before ACK.  `persist_archive_package` uses a
    // one-row transaction, so an error here intentionally leaves the server
    // request unacknowledged for a safe later retry.
    cache.persist_archive_package(request_id, &package, &response.content_sha256)?;
    let acknowledged =
        parse_archive_request(transport.archive_ack(request_id)?, Some(&status.request))?;
    if acknowledged.request_id != request_id || acknowledged.state != "ACKED" {
        return Err("情报历史确认响应无效".into());
    }
    Ok(acknowledged)
}

fn parse_archive_request(
    value: Value,
    expected_selector: Option<&IntelligenceArchiveSelector>,
) -> Result<IntelligenceArchiveRequest, String> {
    let response: ArchiveRequestResponse =
        serde_json::from_value(value).map_err(|_| "情报历史请求响应不符合 V1 协议".to_string())?;
    if response.schema_version != 1
        || !valid_id(&response.request_id)
        || !valid_archive_state(&response.state)
        || !valid_timestamp(&response.requested_at)
        || !valid_timestamp(&response.expires_at)
        || parse_timestamp(&response.expires_at)? <= parse_timestamp(&response.requested_at)?
        || response
            .content_sha256
            .as_deref()
            .is_some_and(|sha| !valid_sha256(sha))
    {
        return Err("情报历史请求响应无效".into());
    }
    validate_archive_selector(&response.request)?;
    if expected_selector.is_some_and(|expected| expected != &response.request) {
        return Err("情报历史请求选择器不匹配".into());
    }
    Ok(IntelligenceArchiveRequest {
        request_id: response.request_id,
        state: response.state.clone(),
        requested_at: response.requested_at,
        expires_at: response.expires_at,
        request: response.request,
        content_ready: matches!(response.state.as_str(), "READY" | "DOWNLOADED" | "ACKED"),
    })
}

struct IntelligenceCache {
    conn: Connection,
}

impl IntelligenceCache {
    fn open(root: &Path, account_id: &str, base: &str) -> Result<Self, String> {
        if account_id.trim().is_empty() || base.trim().is_empty() {
            return Err("情报账户身份不完整".into());
        }
        let scope_hash = account_scope_hash(account_id, base);
        let path = root.join("v1").join(&scope_hash).join("cache.sqlite3");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "创建情报缓存目录失败".to_string())?;
        }
        let conn = Connection::open(path).map_err(|_| "打开情报缓存失败".to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;\
            CREATE TABLE IF NOT EXISTS intelligence_cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
            CREATE TABLE IF NOT EXISTS intelligence_publication_cache_v1 (\
                publication_id TEXT PRIMARY KEY, bundle_json TEXT NOT NULL, bundle_sha256 TEXT NOT NULL,\
                published_at TEXT NOT NULL, expires_at TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 0, persisted_at INTEGER NOT NULL, acknowledged_at INTEGER NOT NULL DEFAULT 0\
            );\
            CREATE TABLE IF NOT EXISTS intelligence_archive_cache_v1 (\
                request_id TEXT PRIMARY KEY, package_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, persisted_at INTEGER NOT NULL\
            );\
            CREATE TABLE IF NOT EXISTS intelligence_asset_cache_v1 (\
                sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, byte_size INTEGER NOT NULL, content BLOB NOT NULL, persisted_at INTEGER NOT NULL\
            );\
            CREATE INDEX IF NOT EXISTS idx_intelligence_publication_cache_expires ON intelligence_publication_cache_v1(expires_at);")
            .map_err(|_| "初始化情报缓存失败".to_string())?;
        // Existing V1 cache files predate the feed-level importance projection.
        // A failed ADD means the new column is already present and is safe.
        let _ = conn.execute(
            "ALTER TABLE intelligence_publication_cache_v1 ADD COLUMN importance INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM intelligence_cache_metadata WHERE key='scope_hash'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "读取情报缓存身份失败".to_string())?;
        match existing {
            Some(value) if value == scope_hash => {}
            Some(_) => return Err("情报缓存身份不匹配，已拒绝读取".into()),
            None => {
                conn.execute(
                    "INSERT INTO intelligence_cache_metadata(key,value) VALUES('scope_hash',?1)",
                    params![scope_hash],
                )
                .map_err(|_| "初始化情报缓存身份失败".to_string())?;
            }
        }
        conn.execute("INSERT INTO intelligence_cache_metadata(key,value) VALUES('schema_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![CACHE_SCHEMA_VERSION.to_string()]).map_err(|_| "初始化情报缓存版本失败".to_string())?;
        Ok(Self { conn })
    }

    fn status(&self) -> Result<IntelligenceCacheStatus, String> {
        let count = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_publication_cache_v1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "读取情报缓存状态失败".to_string())?;
        let unacknowledged = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_publication_cache_v1 WHERE acknowledged_at=0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "读取情报缓存状态失败".to_string())?;
        let last_refresh = self.metadata_i64("last_refresh_at")?;
        let last_success = self.metadata_i64("last_success_at")?.max(last_refresh);
        let delivery_state = self
            .metadata_text("delivery_state")?
            .filter(|value| valid_delivery_state(value))
            .unwrap_or_else(|| {
                if last_success > 0 {
                    if count > 0 {
                        "ready".into()
                    } else {
                        "server_empty".into()
                    }
                } else {
                    "not_refreshed".into()
                }
            });
        let sse_state = self
            .metadata_text("sse_state")?
            .filter(|value| valid_sse_state(value))
            .unwrap_or_else(|| "not_started".into());
        Ok(IntelligenceCacheStatus {
            cache_present: count > 0,
            publication_count: count.max(0) as u64,
            unacknowledged_count: unacknowledged.max(0) as u64,
            delivery_state,
            last_attempt_at: self.metadata_i64("last_attempt_at")?,
            last_success_at: last_success,
            last_refresh_at: last_refresh,
            last_fetched: self.metadata_u64("last_fetched")?,
            last_persisted: self.metadata_u64("last_persisted")?,
            last_acknowledged: self.metadata_u64("last_acknowledged")?,
            sse_state,
            last_sse_at: self.metadata_i64("last_sse_at")?,
        })
    }

    fn metadata_text(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM intelligence_cache_metadata WHERE key=?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "读取情报缓存状态失败".to_string())
    }

    fn metadata_i64(&self, key: &str) -> Result<i64, String> {
        Ok(self
            .metadata_text(key)?
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value >= 0)
            .unwrap_or(0))
    }

    fn metadata_u64(&self, key: &str) -> Result<u64, String> {
        Ok(self
            .metadata_text(key)?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0))
    }

    fn set_metadata(&self, key: &str, value: impl ToString) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO intelligence_cache_metadata(key,value) VALUES(?1,?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value.to_string()],
            )
            .map_err(|_| "更新情报交付状态失败".to_string())?;
        Ok(())
    }

    fn begin_refresh_attempt(&self) -> Result<(), String> {
        self.set_metadata("last_attempt_at", now_millis())?;
        self.set_metadata("delivery_state", "refreshing")
    }

    fn record_refresh_success(&self, report: &IntelligenceRefreshReport) -> Result<(), String> {
        let now = now_millis();
        self.set_metadata("last_refresh_at", now)?;
        self.set_metadata("last_success_at", now)?;
        self.set_metadata("last_fetched", report.fetched)?;
        self.set_metadata("last_persisted", report.persisted)?;
        self.set_metadata("last_acknowledged", report.acknowledged)?;
        self.set_metadata(
            "delivery_state",
            if report.fetched == 0 {
                "server_empty"
            } else {
                "ready"
            },
        )
    }

    fn record_refresh_failure(&self, state: &str) -> Result<(), String> {
        if !valid_delivery_state(state) {
            return Err("情报交付状态无效".into());
        }
        self.set_metadata("delivery_state", state)
    }

    fn set_sse_state(&self, state: &str) -> Result<(), String> {
        if !valid_sse_state(state) {
            return Err("情报 SSE 状态无效".into());
        }
        self.set_metadata("sse_state", state)?;
        self.set_metadata("last_sse_at", now_millis())
    }

    fn persist_bundle(&mut self, bundle: &Value, importance: i64) -> Result<bool, String> {
        let id = bundle["publicationId"].as_str().ok_or("情报包缺少 ID")?;
        let sha = bundle["bundleSha256"].as_str().ok_or("情报包缺少哈希")?;
        let published = bundle["publishedAt"].as_str().ok_or("情报包缺少发布时间")?;
        let expires = bundle["expiresAt"].as_str().ok_or("情报包缺少到期时间")?;
        let text = serde_json::to_string(bundle).map_err(|_| "序列化情报包失败".to_string())?;
        if !(0..=100).contains(&importance) {
            return Err("情报重要性无效".into());
        }
        let changed = self.conn.execute("INSERT INTO intelligence_publication_cache_v1(publication_id,bundle_json,bundle_sha256,published_at,expires_at,importance,persisted_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(publication_id) DO UPDATE SET bundle_json=excluded.bundle_json,bundle_sha256=excluded.bundle_sha256,published_at=excluded.published_at,expires_at=excluded.expires_at,importance=excluded.importance,persisted_at=excluded.persisted_at WHERE intelligence_publication_cache_v1.bundle_sha256<>excluded.bundle_sha256 OR intelligence_publication_cache_v1.importance<>excluded.importance", params![id,text,sha,published,expires,importance,now_millis()]).map_err(|_| "持久化情报包失败".to_string())?;
        Ok(changed > 0)
    }

    fn cache_bundle_assets<T: IntelligenceTransport>(
        &mut self,
        bundle: &Value,
        transport: &mut T,
    ) -> Result<(), String> {
        for asset in bundle_assets(bundle)?.values() {
            if self.has_verified_asset(asset)? {
                continue;
            }
            let mut content = Vec::with_capacity(asset.bytes);
            let mut start = 0usize;
            while start < asset.bytes {
                let end = (start + ASSET_DOWNLOAD_CHUNK_BYTES)
                    .min(asset.bytes)
                    .saturating_sub(1);
                let chunk = transport.asset_range(&asset.sha256, start, end)?;
                let expected = end.saturating_sub(start).saturating_add(1);
                // Exact chunk sizes reject an intermediary which ignored a
                // range request and returned an arbitrary full response.
                if chunk.mime != asset.mime || chunk.bytes.len() != expected {
                    return Err("情报图片下载校验失败".into());
                }
                content.extend_from_slice(&chunk.bytes);
                start = end.saturating_add(1);
            }
            self.persist_asset(asset, &content)?;
        }
        Ok(())
    }

    fn has_verified_asset(&self, asset: &VerifiedAsset) -> Result<bool, String> {
        let row: Option<(String, i64, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT mime, byte_size, content FROM intelligence_asset_cache_v1 WHERE sha256=?1",
                params![asset.sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "读取情报图片缓存失败".to_string())?;
        let Some((mime, bytes, content)) = row else {
            return Ok(false);
        };
        Ok(mime == asset.mime
            && bytes == asset.bytes as i64
            && content.len() == asset.bytes
            && sha256_hex(&content) == asset.sha256)
    }

    fn asset_data_url(&self, sha256: &str) -> Result<String, String> {
        let row: Option<(String, i64, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT mime, byte_size, content FROM intelligence_asset_cache_v1 WHERE sha256=?1",
                params![sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "读取情报图片缓存失败".to_string())?;
        let Some((mime, byte_size, content)) = row else {
            return Err("情报图片尚未保存到本机".into());
        };
        if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp")
            || byte_size < 1
            || usize::try_from(byte_size).ok() != Some(content.len())
            || content.len() > MAX_ASSET_BYTES
            || sha256_hex(&content) != sha256
        {
            return Err("情报图片缓存完整性校验失败".into());
        }
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(content)))
    }

    fn persist_asset(&mut self, asset: &VerifiedAsset, content: &[u8]) -> Result<(), String> {
        if content.len() != asset.bytes || sha256_hex(content) != asset.sha256 {
            return Err("情报图片哈希校验失败".into());
        }
        self.conn
            .execute(
                "INSERT INTO intelligence_asset_cache_v1(sha256,mime,byte_size,content,persisted_at) \
                 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(sha256) DO UPDATE SET \
                 mime=excluded.mime,byte_size=excluded.byte_size,content=excluded.content,persisted_at=excluded.persisted_at \
                 WHERE intelligence_asset_cache_v1.mime<>excluded.mime \
                    OR intelligence_asset_cache_v1.byte_size<>excluded.byte_size \
                    OR intelligence_asset_cache_v1.content<>excluded.content",
                params![asset.sha256, asset.mime, asset.bytes as i64, content, now_millis()],
            )
            .map_err(|_| "持久化情报图片失败".to_string())?;
        Ok(())
    }

    fn mark_acknowledged(&mut self, id: &str) -> Result<(), String> {
        let changed = self.conn.execute("UPDATE intelligence_publication_cache_v1 SET acknowledged_at=?2 WHERE publication_id=?1", params![id, now_millis()]).map_err(|_| "更新情报确认状态失败".to_string())?;
        if changed != 1 {
            return Err("情报包未持久化，拒绝确认投递".into());
        }
        Ok(())
    }

    /// The cursor contains no editorial content, but it still belongs to the
    /// account-and-service cache scope.  Persisting it lets SSE reconnect
    /// after a reader restart without advancing a different account's feed.
    fn stream_cursor(&self) -> Result<String, String> {
        self.conn
            .query_row(
                "SELECT value FROM intelligence_cache_metadata WHERE key='delivery_stream_cursor'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "读取情报投递游标失败".to_string())
            .map(|value| {
                value
                    .filter(|cursor| valid_cursor(cursor))
                    .unwrap_or_default()
            })
    }

    fn set_stream_cursor(&self, cursor: &str) -> Result<(), String> {
        if cursor.is_empty() {
            self.conn
                .execute(
                    "DELETE FROM intelligence_cache_metadata WHERE key='delivery_stream_cursor'",
                    [],
                )
                .map_err(|_| "更新情报投递游标失败".to_string())?;
            return Ok(());
        }
        if !valid_cursor(cursor) {
            return Err("情报投递游标无效".into());
        }
        self.conn
            .execute(
                "INSERT INTO intelligence_cache_metadata(key,value) VALUES('delivery_stream_cursor',?1) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![cursor],
            )
            .map_err(|_| "更新情报投递游标失败".to_string())?;
        Ok(())
    }

    fn persist_archive_package(
        &mut self,
        request_id: &str,
        package: &Value,
        content_sha256: &str,
    ) -> Result<(), String> {
        if !valid_id(request_id) || !valid_sha256(content_sha256) {
            return Err("情报历史缓存身份无效".into());
        }
        let package_json =
            serde_json::to_string(package).map_err(|_| "序列化情报历史内容失败".to_string())?;
        self.conn
            .execute(
                "INSERT INTO intelligence_archive_cache_v1(request_id,package_json,content_sha256,persisted_at) \
                 VALUES(?1,?2,?3,?4) ON CONFLICT(request_id) DO UPDATE SET \
                 package_json=excluded.package_json,content_sha256=excluded.content_sha256,persisted_at=excluded.persisted_at \
                 WHERE intelligence_archive_cache_v1.content_sha256<>excluded.content_sha256",
                params![request_id, package_json, content_sha256, now_millis()],
            )
            .map_err(|_| "持久化情报历史内容失败".to_string())?;
        Ok(())
    }

    fn cached_publications(&self) -> Result<Vec<IntelligenceCachedPublication>, String> {
        let now = now_rfc3339();
        let mut statement = self
            .conn
            .prepare(
                "SELECT bundle_json, publication_id, published_at, expires_at, importance \
                 FROM intelligence_publication_cache_v1 \
                 WHERE expires_at > ?1 \
                 ORDER BY published_at DESC, publication_id ASC",
            )
            .map_err(|_| "读取情报缓存内容失败".to_string())?;
        let rows = statement
            .query_map(params![now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|_| "读取情报缓存内容失败".to_string())?;
        let mut publications = Vec::new();
        for row in rows {
            let (bundle_json, publication_id, published_at, expires_at, importance) =
                row.map_err(|_| "读取情报缓存内容失败".to_string())?;
            let bundle: Value = serde_json::from_str(&bundle_json)
                .map_err(|_| "情报缓存完整性校验失败".to_string())?;
            // Do not assume the local SQLite file stayed intact after its
            // original verified write.  Revalidate before anything enters the
            // WebView, while using only metadata already stored beside it.
            let item = FeedItem {
                publication_id,
                kind: required_string(&bundle, "kind", 5)?.to_string(),
                published_at,
                expires_at,
                revision_no: 1,
                importance,
            };
            validate_bundle_for_feed(&bundle, &item)
                .map_err(|_| "情报缓存完整性校验失败".to_string())?;
            publications.push(self.project_cached_publication(&bundle, importance)?);
        }
        Ok(publications)
    }

    fn project_cached_publication(
        &self,
        bundle: &Value,
        importance: i64,
    ) -> Result<IntelligenceCachedPublication, String> {
        project_cached_publication(bundle, importance, |asset| self.has_verified_asset(asset))
    }
}

fn project_cached_publication<F>(
    bundle: &Value,
    importance: i64,
    mut asset_cached: F,
) -> Result<IntelligenceCachedPublication, String>
where
    F: FnMut(&VerifiedAsset) -> Result<bool, String>,
{
    let assets = bundle_assets(bundle)?;
    let events = bundle["events"]
        .as_array()
        .ok_or_else(|| "情报缓存完整性校验失败".to_string())?
        .iter()
        .map(|event| {
            let notes = event["notes"]
                .as_array()
                .ok_or_else(|| "情报缓存完整性校验失败".to_string())?;
            let sources = notes
                .iter()
                .map(|note| {
                    Ok(IntelligenceCachedSource {
                        note_id: required_string(note, "noteId", 128)?.to_string(),
                        publisher: required_string(note, "publisher", 256)?.to_string(),
                        title: required_string(note, "title", 2048)?.to_string(),
                        original_url: required_string(note, "originalUrl", 4096)?.to_string(),
                        published_at: required_string(note, "publishedAt", 64)?.to_string(),
                        fallback_excerpt: required_string(note, "fallbackExcerpt", 4096)?
                            .to_string(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let mut segments = Vec::new();
            let mut media = Vec::new();
            for block in event["blocks"]
                .as_array()
                .ok_or_else(|| "情报缓存完整性校验失败".to_string())?
            {
                let block_id = required_string(block, "blockId", 128)?.to_string();
                for segment in block["segments"]
                    .as_array()
                    .ok_or_else(|| "情报缓存完整性校验失败".to_string())?
                {
                    let note_ids = segment["noteIds"]
                        .as_array()
                        .ok_or_else(|| "情报缓存完整性校验失败".to_string())?
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .filter(|id| valid_id(id))
                                .map(str::to_string)
                                .ok_or_else(|| "情报缓存完整性校验失败".to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    // `validate_bundle_for_feed` already verified each ID
                    // against this revision's notes. Keep this defensive
                    // projection check so a later cache-schema bug cannot
                    // manufacture a citation target for the WebView.
                    if note_ids.is_empty()
                        || note_ids
                            .iter()
                            .any(|id| !sources.iter().any(|source| source.note_id == *id))
                    {
                        return Err("情报缓存完整性校验失败".into());
                    }
                    segments.push(IntelligenceCachedSegment {
                        block_id: block_id.clone(),
                        text: required_string(segment, "text", 16_384)?.to_string(),
                        note_ids,
                    });
                }
                let video_url = block
                    .get("videoUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                for asset_id in block["mediaIds"]
                    .as_array()
                    .ok_or_else(|| "情报缓存完整性校验失败".to_string())?
                {
                    let asset_id = asset_id
                        .as_str()
                        .filter(|id| valid_id(id))
                        .ok_or_else(|| "情报缓存完整性校验失败".to_string())?;
                    let asset = assets
                        .get(asset_id)
                        .ok_or_else(|| "情报缓存完整性校验失败".to_string())?;
                    media.push(IntelligenceCachedMedia {
                        asset_id: asset.asset_id.clone(),
                        sha256: asset.sha256.clone(),
                        mime: asset.mime.clone(),
                        bytes: asset.bytes as i64,
                        width: asset.width,
                        height: asset.height,
                        block_id: block_id.clone(),
                        cached: asset_cached(asset)?,
                        video_url: video_url.clone(),
                    });
                }
            }
            let body = segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            Ok(IntelligenceCachedEvent {
                event_id: required_string(event, "eventId", 128)?.to_string(),
                revision_no: event["revisionNo"]
                    .as_i64()
                    .ok_or_else(|| "情报缓存完整性校验失败".to_string())?,
                series_id: event
                    .get("seriesId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                title: required_string(event, "title", 512)?.to_string(),
                occurred_at: event
                    .get("occurredAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                body,
                segments,
                media,
                sources,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(IntelligenceCachedPublication {
        publication_id: required_string(bundle, "publicationId", 128)?.to_string(),
        kind: required_string(bundle, "kind", 5)?.to_string(),
        published_at: required_string(bundle, "publishedAt", 64)?.to_string(),
        expires_at: required_string(bundle, "expiresAt", 64)?.to_string(),
        importance,
        events,
    })
}

fn cache_root() -> Result<PathBuf, String> {
    profile::app_data_dir()
        .map(|path| path.join("intelligence-client"))
        .ok_or_else(|| "无法确定情报缓存目录".into())
}

fn account_scope_hash(account_id: &str, base: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base.as_bytes());
    hasher.update([0]);
    hasher.update(account_id.as_bytes());
    hex(&hasher.finalize())
}

fn validate_capabilities(value: &Capabilities) -> Result<(), String> {
    if value.schema_version != 1
        || !valid_timestamp(&value.server_now)
        || !valid_day_or_none(&value.archive.available_from)
        || !valid_day_or_none(&value.archive.available_to)
    {
        return Err("情报能力响应字段无效".into());
    }
    Ok(())
}

fn validate_feed_page(page: &FeedPage) -> Result<(), String> {
    if page.schema_version != 1
        || page.items.len() > 100
        || !valid_timestamp(&page.server_now)
        || (!page.next_cursor.is_empty() && !valid_cursor(&page.next_cursor))
    {
        return Err("情报列表字段无效".into());
    }
    for item in &page.items {
        validate_feed_item(item)?;
    }
    Ok(())
}

fn validate_feed_item(item: &FeedItem) -> Result<(), String> {
    if !valid_id(&item.publication_id)
        || !matches!(item.kind.as_str(), "event" | "daily")
        || !valid_timestamp(&item.published_at)
        || !valid_timestamp(&item.expires_at)
        || item.revision_no < 1
        || !(0..=100).contains(&item.importance)
    {
        return Err("情报列表项目无效".into());
    }
    if parse_timestamp(&item.expires_at)? <= parse_timestamp(&item.published_at)? {
        return Err("情报列表有效期无效".into());
    }
    Ok(())
}

fn validate_bundle_for_feed(bundle: &Value, item: &FeedItem) -> Result<(), String> {
    let bytes = serde_json::to_vec(bundle).map_err(|_| "情报包无法编码".to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err("情报包超过大小限制".into());
    }
    let object = bundle.as_object().ok_or("情报包必须为对象")?;
    reject_unknown(
        object,
        &[
            "schemaVersion",
            "publicationId",
            "kind",
            "publishedAt",
            "expiresAt",
            "issuedAt",
            "events",
            "assets",
            "bundleSha256",
        ],
    )?;
    if object.len() != 9 || bundle["schemaVersion"].as_u64() != Some(1) {
        return Err("情报包版本无效".into());
    }
    let id = required_string(bundle, "publicationId", 128)?;
    if id != item.publication_id
        || !valid_id(id)
        || required_string(bundle, "kind", 5)? != item.kind
        || required_string(bundle, "publishedAt", 64)? != item.published_at
        || required_string(bundle, "expiresAt", 64)? != item.expires_at
    {
        return Err("情报包与列表项目不一致".into());
    }
    let published = parse_timestamp(required_string(bundle, "publishedAt", 64)?)?;
    let expires = parse_timestamp(required_string(bundle, "expiresAt", 64)?)?;
    let issued = parse_timestamp(required_string(bundle, "issuedAt", 64)?)?;
    if expires - published != 30 * 24 * 60 * 60 * 1_000 || issued < published || issued > expires {
        return Err("情报包时间边界无效".into());
    }
    let events = bundle["events"].as_array().ok_or("情报包事件无效")?;
    let assets = bundle["assets"].as_array().ok_or("情报包资源无效")?;
    if events.is_empty() || events.len() > 30 || assets.len() > 1024 {
        return Err("情报包数量无效".into());
    }
    let mut asset_ids = BTreeSet::new();
    for asset in assets {
        let asset_id = validate_asset(asset)?;
        if !asset_ids.insert(asset_id) {
            return Err("媒体 ID 重复".into());
        }
    }
    let mut event_ids = BTreeSet::new();
    for event in events {
        let event_id = validate_event(event, &asset_ids)?;
        if !event_ids.insert(event_id) {
            return Err("事件 ID 重复".into());
        }
    }
    let expected = required_string(bundle, "bundleSha256", 64)?;
    if !valid_sha256(expected) {
        return Err("情报包哈希格式无效".into());
    }
    let mut canonical = bundle.clone();
    canonical
        .as_object_mut()
        .ok_or("情报包对象无效")?
        .remove("bundleSha256");
    if hex(&Sha256::digest(canonical_json(&canonical).as_bytes())) != expected {
        return Err("情报包哈希校验失败".into());
    }
    Ok(())
}

fn validate_event(event: &Value, asset_ids: &BTreeSet<String>) -> Result<String, String> {
    let object = event.as_object().ok_or("事件无效")?;
    reject_unknown(
        object,
        &[
            "eventId",
            "revisionNo",
            "seriesId",
            "title",
            "occurredAt",
            "blocks",
            "notes",
        ],
    )?;
    for key in [
        "eventId",
        "revisionNo",
        "title",
        "occurredAt",
        "blocks",
        "notes",
    ] {
        if !object.contains_key(key) {
            return Err("事件字段缺失".into());
        }
    }
    if !valid_id(required_string(event, "eventId", 128)?)
        || event["revisionNo"].as_i64().filter(|v| *v >= 1).is_none()
        || required_string(event, "title", 512)?.is_empty()
        || contains_model_url(required_string(event, "title", 512)?)
    {
        return Err("事件字段无效".into());
    }
    if event
        .get("seriesId")
        .is_some_and(|series| !series.as_str().is_some_and(valid_id))
    {
        return Err("事件序列无效".into());
    }
    if !event["occurredAt"].is_null() && !event["occurredAt"].as_str().is_some_and(valid_timestamp)
    {
        return Err("事件时间无效".into());
    }
    let blocks = event["blocks"].as_array().ok_or("事件块无效")?;
    let notes = event["notes"].as_array().ok_or("事件注释无效")?;
    if blocks.is_empty() || blocks.len() > 1024 || notes.is_empty() || notes.len() > 512 {
        return Err("事件内容数量无效".into());
    }
    let mut note_ids = BTreeSet::new();
    for note in notes {
        let note_id = validate_note(note)?;
        if !note_ids.insert(note_id) {
            return Err("事件注释 ID 重复".into());
        }
    }
    let mut block_ids = BTreeSet::new();
    for block in blocks {
        let block_id = validate_block(block, &note_ids, asset_ids)?;
        if !block_ids.insert(block_id) {
            return Err("事件正文块 ID 重复".into());
        }
    }
    Ok(required_string(event, "eventId", 128)?.to_string())
}

fn validate_block(
    block: &Value,
    note_ids: &BTreeSet<String>,
    asset_ids: &BTreeSet<String>,
) -> Result<String, String> {
    let object = block.as_object().ok_or("正文块无效")?;
    reject_unknown(object, &["blockId", "segments", "mediaIds", "videoUrl"])?;
    if !valid_id(required_string(block, "blockId", 128)?) {
        return Err("正文块 ID 无效".into());
    }
    let segments = block["segments"].as_array().ok_or("正文片段无效")?;
    if segments.is_empty() || segments.len() > 128 {
        return Err("正文片段数量无效".into());
    }
    for segment in segments {
        let obj = segment.as_object().ok_or("正文片段无效")?;
        reject_unknown(obj, &["text", "noteIds"])?;
        let text = required_string(segment, "text", 16384)?;
        let ids = segment["noteIds"].as_array().ok_or("正文引用无效")?;
        if text.is_empty()
            || contains_model_url(text)
            || ids.is_empty()
            || ids.len() > 16
            || !ids.iter().all(|id| id.as_str().is_some_and(valid_id))
            || !unique_strings(ids)
        {
            return Err("正文片段字段无效".into());
        }
        if ids
            .iter()
            .any(|id| !note_ids.contains(id.as_str().unwrap_or_default()))
        {
            return Err("正文引用未指向同一事件的来源注释".into());
        }
    }
    if let Some(ids) = block.get("mediaIds") {
        if !ids.as_array().is_some_and(|items| {
            items.len() <= 16
                && items.iter().all(|id| id.as_str().is_some_and(valid_id))
                && unique_strings(items)
        }) {
            return Err("媒体引用无效".into());
        }
        if ids.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|id| !asset_ids.contains(id.as_str().unwrap_or_default()))
        }) {
            return Err("媒体引用未指向包内图片".into());
        }
    }
    if block
        .get("videoUrl")
        .is_some_and(|url| !url.as_str().is_some_and(valid_https_url))
    {
        return Err("视频地址无效".into());
    }
    Ok(required_string(block, "blockId", 128)?.to_string())
}

fn validate_note(note: &Value) -> Result<String, String> {
    let object = note.as_object().ok_or("来源注释无效")?;
    reject_unknown(
        object,
        &[
            "noteId",
            "sourceId",
            "sourceSha256",
            "publisher",
            "title",
            "originalUrl",
            "publishedAt",
            "paragraphs",
            "fallbackExcerpt",
        ],
    )?;
    for key in [
        "noteId",
        "sourceId",
        "sourceSha256",
        "publisher",
        "title",
        "originalUrl",
        "publishedAt",
        "paragraphs",
        "fallbackExcerpt",
    ] {
        if !object.contains_key(key) {
            return Err("来源注释字段缺失".into());
        }
    }
    if !valid_id(required_string(note, "noteId", 128)?)
        || !valid_id(required_string(note, "sourceId", 128)?)
        || !valid_sha256(required_string(note, "sourceSha256", 64)?)
        || required_string(note, "publisher", 256)?.is_empty()
        || required_string(note, "title", 2048)?.is_empty()
        || !valid_https_url(required_string(note, "originalUrl", 4096)?)
        || !valid_timestamp(required_string(note, "publishedAt", 64)?)
        || required_string(note, "fallbackExcerpt", 4096)?.is_empty()
    {
        return Err("来源注释字段无效".into());
    }
    let paragraphs = note["paragraphs"].as_array().ok_or("段落引用无效")?;
    if paragraphs.is_empty() || paragraphs.len() > 64 {
        return Err("段落引用无效".into());
    }
    let mut paragraph_ids = BTreeSet::new();
    for paragraph in paragraphs {
        let object = paragraph.as_object().ok_or("段落证据无效")?;
        reject_unknown(object, &["paragraphId", "sha256"])?;
        if !valid_id(required_string(paragraph, "paragraphId", 128)?)
            || !valid_sha256(required_string(paragraph, "sha256", 64)?)
            || !paragraph_ids.insert(required_string(paragraph, "paragraphId", 128)?.to_string())
        {
            return Err("段落证据无效".into());
        }
    }
    Ok(required_string(note, "noteId", 128)?.to_string())
}

fn validate_asset(asset: &Value) -> Result<String, String> {
    let object = asset.as_object().ok_or("媒体资源无效")?;
    reject_unknown(
        object,
        &[
            "assetId", "kind", "sha256", "mime", "bytes", "width", "height",
        ],
    )?;
    for key in ["assetId", "kind", "sha256", "mime", "bytes"] {
        if !object.contains_key(key) {
            return Err("媒体资源字段缺失".into());
        }
    }
    let valid_mime = matches!(
        required_string(asset, "mime", 32)?,
        "image/jpeg" | "image/png" | "image/webp"
    );
    if !valid_id(required_string(asset, "assetId", 128)?)
        || required_string(asset, "kind", 16)? != "image"
        || !valid_sha256(required_string(asset, "sha256", 64)?)
        || !valid_mime
        || !asset["bytes"]
            .as_i64()
            .is_some_and(|v| (1..=26_214_400).contains(&v))
    {
        return Err("媒体资源字段无效".into());
    }
    for key in ["width", "height"] {
        if let Some(value) = asset.get(key) {
            if !value.as_i64().is_some_and(|v| (1..=16_384).contains(&v)) {
                return Err("媒体尺寸无效".into());
            }
        }
    }
    Ok(required_string(asset, "assetId", 128)?.to_string())
}

/// Convert the already schema-validated asset list to typed metadata.  Keep
/// this separate from the network path so projection and download use the
/// same identity and size checks.
fn bundle_assets(bundle: &Value) -> Result<BTreeMap<String, VerifiedAsset>, String> {
    let assets = bundle["assets"]
        .as_array()
        .ok_or_else(|| "情报缓存完整性校验失败".to_string())?;
    let mut result = BTreeMap::new();
    for asset in assets {
        let asset_id = validate_asset(asset)?;
        let bytes = asset["bytes"]
            .as_i64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value <= MAX_ASSET_BYTES)
            .ok_or_else(|| "情报缓存完整性校验失败".to_string())?;
        let verified = VerifiedAsset {
            asset_id: asset_id.clone(),
            sha256: required_string(asset, "sha256", 64)?.to_string(),
            mime: required_string(asset, "mime", 32)?.to_string(),
            bytes,
            width: asset.get("width").and_then(Value::as_i64),
            height: asset.get("height").and_then(Value::as_i64),
        };
        if result.insert(asset_id, verified).is_some() {
            return Err("情报缓存完整性校验失败".into());
        }
    }
    Ok(result)
}

fn required_string<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<&'a str, String> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("情报字段 {key} 无效"))?;
    if value.len() > maximum {
        return Err(format!("情报字段 {key} 过长"));
    }
    Ok(value)
}
fn reject_unknown(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err("情报包包含未知字段".into())
    } else {
        Ok(())
    }
}
fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphanumeric())
        && value.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !(b'A'..=b'F').contains(&b))
}
fn valid_cursor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://") && value.len() <= 4096 && !value.chars().any(char::is_whitespace)
}
fn contains_model_url(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    let http_scheme = ["http", "://"].concat();
    let https_scheme = ["https", "://"].concat();
    value.contains(&http_scheme) || value.contains(&https_scheme) || value.contains("www.")
}
fn valid_day_or_none(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|v| {
        v.len() == 10
            && v.as_bytes().get(4) == Some(&b'-')
            && v.as_bytes().get(7) == Some(&b'-')
            && v.chars()
                .enumerate()
                .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
    })
}
fn valid_day(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}
fn validate_archive_selector(selector: &IntelligenceArchiveSelector) -> Result<(), String> {
    let selected = usize::from(selector.day.is_some())
        + usize::from(selector.event_id.is_some())
        + usize::from(selector.series_id.is_some());
    if selected != 1
        || selector.day.as_deref().is_some_and(|day| !valid_day(day))
        || selector.event_id.as_deref().is_some_and(|id| !valid_id(id))
        || selector
            .series_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
    {
        return Err("情报历史请求选择器无效".into());
    }
    Ok(())
}
fn valid_archive_state(value: &str) -> bool {
    matches!(
        value,
        "REQUESTED"
            | "QUEUED"
            | "CLAIMED"
            | "UPLOADING"
            | "READY"
            | "DOWNLOADED"
            | "ACKED"
            | "PURGED"
            | "HOST_OFFLINE"
            | "NOT_FOUND"
            | "FAILED"
            | "REQUEST_EXPIRED"
    )
}
fn validate_archive_package(
    package: &Value,
    expected_selector: &IntelligenceArchiveSelector,
) -> Result<(), String> {
    let object = package.as_object().ok_or("情报历史包必须为对象")?;
    reject_unknown(object, &["schemaVersion", "kind", "request", "events"])?;
    if object.len() != 4
        || package["schemaVersion"].as_u64() != Some(1)
        || required_string(package, "kind", 32)? != "archive_relay"
    {
        return Err("情报历史包版本无效".into());
    }
    let selector: IntelligenceArchiveSelector = serde_json::from_value(package["request"].clone())
        .map_err(|_| "情报历史包选择器无效".to_string())?;
    validate_archive_selector(&selector)?;
    if &selector != expected_selector {
        return Err("情报历史包选择器不匹配".into());
    }
    let events = package["events"].as_array().ok_or("情报历史包事件无效")?;
    if events.is_empty() || events.len() > 30 {
        return Err("情报历史包事件数量无效".into());
    }
    let mut ids = BTreeSet::new();
    for event in events {
        let event = event.as_object().ok_or("情报历史包事件无效")?;
        reject_unknown(
            event,
            &[
                "eventId",
                "seriesId",
                "revisionNo",
                "title",
                "occurredAt",
                "revision",
            ],
        )?;
        for key in ["eventId", "revisionNo", "title", "revision"] {
            if !event.contains_key(key) {
                return Err("情报历史包事件字段缺失".into());
            }
        }
        let id = event
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|id| id.len() <= 128)
            .ok_or("情报历史包事件无效")?;
        let title = event
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| title.len() <= 512)
            .ok_or("情报历史包事件无效")?;
        if !valid_id(id)
            || !ids.insert(id.to_string())
            || event["revisionNo"]
                .as_i64()
                .filter(|value| *value >= 1)
                .is_none()
            || title.is_empty()
            || !event["revision"].is_object()
            || event
                .get("seriesId")
                .is_some_and(|value| !value.as_str().is_some_and(valid_id))
            || event.get("occurredAt").is_some_and(|value| {
                !value.is_null() && !value.as_str().is_some_and(valid_timestamp)
            })
        {
            return Err("情报历史包事件无效".into());
        }
    }
    Ok(())
}
fn valid_timestamp(value: &str) -> bool {
    parse_timestamp(value).is_ok()
}
fn parse_timestamp(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .map_err(|_| "情报时间戳无效".into())
}
fn unique_strings(values: &[Value]) -> bool {
    let mut seen = BTreeSet::new();
    values.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|value| seen.insert(value.to_string()))
    })
}
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| i64::try_from(v.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut items = values.iter().collect::<Vec<_>>();
            items.sort_by(|a, b| a.0.cmp(b.0));
            format!(
                "{{{}}}",
                items
                    .into_iter()
                    .map(|(k, v)| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(v)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn bundle() -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/intelligence-publication-bundle.v1.json"
        ))
        .unwrap();
        // A real digest for the in-memory transport: fixture metadata must
        // describe the same bytes supplied by `asset_range`.
        let image = b"synthetic-image";
        value["assets"][0]["sha256"] = Value::String(sha256_hex(image));
        value["assets"][0]["bytes"] = serde_json::json!(image.len());
        let mut unsigned = value.clone();
        unsigned.as_object_mut().unwrap().remove("bundleSha256");
        value["bundleSha256"] =
            Value::String(hex(&Sha256::digest(canonical_json(&unsigned).as_bytes())));
        value
    }
    fn feed_item(bundle: &Value) -> FeedItem {
        FeedItem {
            publication_id: bundle["publicationId"].as_str().unwrap().into(),
            kind: bundle["kind"].as_str().unwrap().into(),
            published_at: bundle["publishedAt"].as_str().unwrap().into(),
            expires_at: bundle["expiresAt"].as_str().unwrap().into(),
            revision_no: 1,
            importance: 80,
        }
    }
    fn resign(value: &mut Value) {
        value.as_object_mut().unwrap().remove("bundleSha256");
        let digest = hex(&Sha256::digest(canonical_json(value).as_bytes()));
        value["bundleSha256"] = Value::String(digest);
    }
    fn temp_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "kunpeng-intelligence-client-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn caps() -> Value {
        serde_json::json!({"schemaVersion":1,"feedEnabled":true,"serverNow":"2026-08-23T00:00:00Z","archive":{"availableFrom":null,"availableTo":null}})
    }
    struct Fake {
        bundle: Value,
        acks: Arc<Mutex<Vec<String>>>,
        fail_publication: bool,
    }
    impl IntelligenceTransport for Fake {
        fn capabilities(&mut self) -> Result<Value, String> {
            Ok(caps())
        }
        fn feed(&mut self, cursor: Option<&str>) -> Result<Value, String> {
            Ok(
                serde_json::json!({"schemaVersion":1,"items":if cursor.is_none(){vec![feed_item(&self.bundle)]}else{vec![]},"nextCursor":"","serverNow":"2026-08-23T00:00:00Z"}),
            )
        }
        fn publication(&mut self, _: &str) -> Result<Value, String> {
            if self.fail_publication {
                Err("network".into())
            } else {
                Ok(self.bundle.clone())
            }
        }
        fn acknowledge(&mut self, id: &str) -> Result<(), String> {
            self.acks.lock().unwrap().push(id.into());
            Ok(())
        }
        fn asset_range(
            &mut self,
            sha256: &str,
            start: usize,
            end: usize,
        ) -> Result<AssetChunk, String> {
            let image = b"synthetic-image";
            if sha256 != sha256_hex(image) || start > end || end >= image.len() {
                return Err("asset range mismatch".into());
            }
            Ok(AssetChunk {
                mime: "image/webp".into(),
                bytes: image[start..=end].to_vec(),
            })
        }
    }

    struct ArchiveFake {
        selector: IntelligenceArchiveSelector,
        bytes: Vec<u8>,
        acknowledged: bool,
    }
    impl ArchiveFake {
        fn response(&self, state: &str) -> Value {
            serde_json::json!({
                "schemaVersion": 1,
                "requestId": "request-1",
                "state": state,
                "requestedAt": "2026-08-23T00:00:00Z",
                "expiresAt": "2026-08-30T00:00:00Z",
                "request": self.selector,
                "contentSha256": if matches!(state, "READY" | "DOWNLOADED" | "ACKED") { Some(sha256_hex(&self.bytes)) } else { None::<String> },
            })
        }
    }
    impl IntelligenceArchiveTransport for ArchiveFake {
        fn archive_calendar(&mut self) -> Result<Value, String> {
            Ok(serde_json::json!({"schemaVersion":1,"days":[{"day":"2026-08-01","entryCount":2}]}))
        }
        fn archive_create(
            &mut self,
            selector: &IntelligenceArchiveSelector,
        ) -> Result<Value, String> {
            if selector != &self.selector {
                return Err("selector mismatch".into());
            }
            Ok(self.response("QUEUED"))
        }
        fn archive_status(&mut self, _: &str) -> Result<Value, String> {
            Ok(self.response("READY"))
        }
        fn archive_content(&mut self, _: &str) -> Result<Value, String> {
            Ok(serde_json::json!({
                "schemaVersion": 1, "requestId": "request-1",
                "contentBase64": STANDARD.encode(&self.bytes), "contentSha256": sha256_hex(&self.bytes),
            }))
        }
        fn archive_ack(&mut self, _: &str) -> Result<Value, String> {
            self.acknowledged = true;
            Ok(self.response("ACKED"))
        }
    }

    /// A deterministic, in-memory approximation of the archive service's
    /// account-local request state.  It deliberately has no HTTP listener or
    /// database: the test below verifies the client-side recovery contract
    /// without pretending to be a PostgreSQL integration test.
    struct RecoveringArchiveFake {
        selector: IntelligenceArchiveSelector,
        bytes: Vec<u8>,
        state: String,
        acknowledgements: usize,
    }

    impl RecoveringArchiveFake {
        fn response(&self, state: &str) -> Value {
            serde_json::json!({
                "schemaVersion": 1,
                "requestId": "request-recovery-1",
                "state": state,
                "requestedAt": "2026-08-23T00:00:00Z",
                "expiresAt": "2026-08-30T00:00:00Z",
                "request": self.selector,
                "contentSha256": if matches!(state, "READY" | "DOWNLOADED" | "ACKED") {
                    Some(sha256_hex(&self.bytes))
                } else {
                    None::<String>
                },
            })
        }

        fn recover(&mut self) {
            self.state = "READY".into();
        }
    }

    impl IntelligenceArchiveTransport for RecoveringArchiveFake {
        fn archive_calendar(&mut self) -> Result<Value, String> {
            Ok(serde_json::json!({"schemaVersion":1,"days":[]}))
        }

        fn archive_create(
            &mut self,
            selector: &IntelligenceArchiveSelector,
        ) -> Result<Value, String> {
            (selector == &self.selector)
                .then(|| self.response("QUEUED"))
                .ok_or_else(|| "selector mismatch".to_string())
        }

        fn archive_status(&mut self, request_id: &str) -> Result<Value, String> {
            (request_id == "request-recovery-1")
                .then(|| self.response(&self.state))
                .ok_or_else(|| "request mismatch".to_string())
        }

        fn archive_content(&mut self, request_id: &str) -> Result<Value, String> {
            if request_id != "request-recovery-1" || self.state != "READY" {
                return Err("archive content is not ready".into());
            }
            Ok(serde_json::json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "contentBase64": STANDARD.encode(&self.bytes),
                "contentSha256": sha256_hex(&self.bytes),
            }))
        }

        fn archive_ack(&mut self, request_id: &str) -> Result<Value, String> {
            if request_id != "request-recovery-1" || self.state != "READY" {
                return Err("archive acknowledgement is not ready".into());
            }
            self.acknowledgements += 1;
            self.state = "ACKED".into();
            Ok(self.response("ACKED"))
        }
    }
    fn sha256_hex(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }
    fn archive_selector() -> IntelligenceArchiveSelector {
        IntelligenceArchiveSelector {
            day: Some("2026-08-01".into()),
            event_id: None,
            series_id: None,
        }
    }
    fn archive_package(selector: &IntelligenceArchiveSelector) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "kind": "archive_relay", "request": selector,
            "events": [{"eventId":"event-1","seriesId":"series-1","revisionNo":1,"title":"历史事件","occurredAt":"2026-08-01T01:00:00Z","revision":{"text":"历史正文"}}],
        })).unwrap()
    }
    #[test]
    fn fixture_passes_strict_bundle_validation() {
        let value = bundle();
        validate_bundle_for_feed(&value, &feed_item(&value)).unwrap();
    }

    #[test]
    fn host_inference_fixture_cannot_cross_the_publication_reader_boundary() {
        // The host-inference fixture describes encrypted task traffic, not a
        // publication bundle. The consumer must never decrypt, display, or
        // send it; pin that separation at the strict public-bundle boundary.
        let value: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/intelligence-host-inference-v1.json"
        ))
        .unwrap();
        assert!(validate_bundle_for_feed(&value, &feed_item(&bundle())).is_err());
    }
    #[test]
    fn altered_bundle_rejects_hash() {
        let mut value = bundle();
        value["events"][0]["title"] = Value::String("tampered".into());
        assert!(validate_bundle_for_feed(&value, &feed_item(&bundle())).is_err());
    }
    #[test]
    fn strict_cache_validation_rejects_unresolvable_or_model_controlled_references() {
        let mut value = bundle();
        value["events"][0]["blocks"][0]["segments"][0]["noteIds"] =
            serde_json::json!(["missing-note"]);
        resign(&mut value);
        assert!(validate_bundle_for_feed(&value, &feed_item(&value)).is_err());

        let mut value = bundle();
        value["events"][0]["notes"][0]["paragraphs"] = serde_json::json!([]);
        resign(&mut value);
        assert!(validate_bundle_for_feed(&value, &feed_item(&value)).is_err());

        let mut value = bundle();
        value["events"][0]["blocks"][0]["mediaIds"] = serde_json::json!(["missing-image"]);
        resign(&mut value);
        assert!(validate_bundle_for_feed(&value, &feed_item(&value)).is_err());

        let mut value = bundle();
        value["events"][0]["blocks"][0]["videoUrl"] =
            Value::String("http://video.invalid/demo".into());
        resign(&mut value);
        assert!(validate_bundle_for_feed(&value, &feed_item(&value)).is_err());

        let mut value = bundle();
        value["events"][0]["title"] = Value::String("See HTTPS://untrusted.invalid".into());
        resign(&mut value);
        assert!(validate_bundle_for_feed(&value, &feed_item(&value)).is_err());
    }
    #[test]
    fn cache_is_account_scoped() {
        let root = temp_root("isolation");
        let value = bundle();
        let mut a = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        a.persist_bundle(&value, 80).unwrap();
        let status = a.status().unwrap();
        assert_eq!(status.publication_count, 1);
        // Older account caches have no delivery metadata. They remain safely
        // readable and are represented as an unrefreshed cache, rather than
        // inventing a network outcome.
        assert_eq!(status.delivery_state, "not_refreshed");
        let b = IntelligenceCache::open(&root, "b", "https://two.example").unwrap();
        assert_eq!(b.status().unwrap().publication_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delivery_stream_cursor_is_persisted_per_account_scope() {
        let root = temp_root("stream-cursor");
        let a = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        a.set_stream_cursor("42").unwrap();
        assert_eq!(a.stream_cursor().unwrap(), "42");
        let b = IntelligenceCache::open(&root, "b", "https://one.example").unwrap();
        assert!(b.stream_cursor().unwrap().is_empty());
        a.set_stream_cursor("").unwrap();
        assert!(a.stream_cursor().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn cached_publications_revalidate_and_project_public_editorial_content() {
        let root = temp_root("projection");
        let value = bundle();
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        cache.persist_bundle(&value, 80).unwrap();
        let publications = cache.cached_publications().unwrap();
        assert_eq!(publications.len(), 1);
        let event = &publications[0].events[0];
        assert_eq!(event.event_id, "event-demo-1");
        assert_eq!(event.title, "虚构事件示例");
        assert!(event.body.contains("虚构来源确认"));
        assert_eq!(event.sources[0].publisher, "Example News");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn tampered_cached_bundle_never_crosses_webview_boundary() {
        let root = temp_root("tampered-cache");
        let value = bundle();
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        cache.persist_bundle(&value, 80).unwrap();
        let mut altered = value;
        altered["events"][0]["title"] = Value::String("tampered after write".into());
        cache
            .conn
            .execute(
                "UPDATE intelligence_publication_cache_v1 SET bundle_json=?1",
                params![serde_json::to_string(&altered).unwrap()],
            )
            .unwrap();
        assert_eq!(
            cache.cached_publications().unwrap_err(),
            "情报缓存完整性校验失败"
        );
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn acknowledgement_follows_persistence() {
        let root = temp_root("ack");
        let value = bundle();
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        let acks = Arc::new(Mutex::new(Vec::new()));
        let mut transport = Fake {
            bundle: value,
            acks: acks.clone(),
            fail_publication: false,
        };
        let report = refresh_with_transport(&mut cache, &mut transport).unwrap();
        assert_eq!(report.acknowledged, 1);
        let status = cache.status().unwrap();
        assert_eq!(status.unacknowledged_count, 0);
        assert_eq!(status.delivery_state, "ready");
        assert_eq!(status.last_fetched, 1);
        assert_eq!(status.last_persisted, 1);
        assert_eq!(status.last_acknowledged, 1);
        assert!(status.last_attempt_at > 0 && status.last_success_at > 0);
        assert_eq!(acks.lock().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_images_are_cached_before_ack_and_stay_account_scoped() {
        let root = temp_root("image-cache");
        let value = bundle();
        let acks = Arc::new(Mutex::new(Vec::new()));
        let mut account_a = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        let mut transport = Fake {
            bundle: value.clone(),
            acks: acks.clone(),
            fail_publication: false,
        };
        refresh_with_transport(&mut account_a, &mut transport).unwrap();
        let asset = bundle_assets(&value).unwrap().remove("img-1").unwrap();
        assert!(account_a.has_verified_asset(&asset).unwrap());
        assert_eq!(acks.lock().unwrap().as_slice(), ["daily:2030-01-02:zh-CN"]);
        let publications = account_a.cached_publications().unwrap();
        assert!(publications[0].events[0].media[0].cached);

        let account_b = IntelligenceCache::open(&root, "b", "https://one.example").unwrap();
        assert!(!account_b.has_verified_asset(&asset).unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn failed_download_does_not_ack() {
        let root = temp_root("no-ack");
        let value = bundle();
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        let acks = Arc::new(Mutex::new(Vec::new()));
        let mut transport = Fake {
            bundle: value,
            acks: acks.clone(),
            fail_publication: true,
        };
        assert!(refresh_with_transport(&mut cache, &mut transport).is_err());
        assert!(acks.lock().unwrap().is_empty());
        let status = cache.status().unwrap();
        assert_eq!(status.delivery_state, "delivery_failed");
        assert!(status.last_attempt_at > 0);
        assert_eq!(status.last_success_at, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_success_is_distinct_from_never_refreshing_and_keeps_safe_sse_state() {
        let root = temp_root("empty-delivery-status");
        let cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        assert_eq!(cache.status().unwrap().delivery_state, "not_refreshed");
        cache.begin_refresh_attempt().unwrap();
        cache
            .record_refresh_success(&IntelligenceRefreshReport {
                fetched: 0,
                persisted: 0,
                acknowledged: 0,
            })
            .unwrap();
        cache.set_sse_state("connected").unwrap();
        let status = cache.status().unwrap();
        assert_eq!(status.delivery_state, "server_empty");
        assert_eq!(status.sse_state, "connected");
        assert!(status.last_success_at > 0 && status.last_sse_at > 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_calendar_is_content_free_and_validated() {
        let selector = archive_selector();
        let mut transport = ArchiveFake {
            bytes: archive_package(&selector),
            selector,
            acknowledged: false,
        };
        let calendar = archive_calendar_with_transport(&mut transport).unwrap();
        assert_eq!(
            calendar.days,
            vec![IntelligenceArchiveDay {
                day: "2026-08-01".into(),
                entry_count: 2
            }]
        );
    }

    #[test]
    fn archive_package_is_committed_and_hashed_before_acknowledgement() {
        let root = temp_root("archive-ack");
        let selector = archive_selector();
        let bytes = archive_package(&selector);
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        let mut transport = ArchiveFake {
            selector,
            bytes,
            acknowledged: false,
        };
        let response =
            archive_download_with_transport(&mut cache, &mut transport, "request-1").unwrap();
        assert_eq!(response.state, "ACKED");
        assert!(transport.acknowledged);
        let count: i64 = cache
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_archive_cache_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_package_rejects_selector_or_hash_substitution_without_ack() {
        let root = temp_root("archive-reject");
        let selector = archive_selector();
        let mut cache = IntelligenceCache::open(&root, "a", "https://one.example").unwrap();
        let mut transport = ArchiveFake {
            selector,
            bytes: br#"{\"schemaVersion\":1}"#.to_vec(),
            acknowledged: false,
        };
        assert!(archive_download_with_transport(&mut cache, &mut transport, "request-1").is_err());
        assert!(!transport.acknowledged);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_host_offline_recovery_commits_before_ack_and_remains_account_scoped() {
        let root = temp_root("archive-host-recovery");
        let selector = archive_selector();
        let bytes = archive_package(&selector);
        let mut account_a =
            IntelligenceCache::open(&root, "account-a", "https://relay.example").unwrap();
        let account_b =
            IntelligenceCache::open(&root, "account-b", "https://relay.example").unwrap();
        let mut transport = RecoveringArchiveFake {
            selector: selector.clone(),
            bytes,
            state: "HOST_OFFLINE".into(),
            acknowledgements: 0,
        };

        // Request creation and the first poll return promptly.  No content
        // has arrived, so there is neither a local row nor an ACK to the
        // relay while its publisher host is offline.
        assert_eq!(
            archive_request_with_transport(&mut transport, &selector)
                .unwrap()
                .state,
            "QUEUED"
        );
        let waiting =
            archive_download_with_transport(&mut account_a, &mut transport, "request-recovery-1")
                .unwrap();
        assert_eq!(waiting.state, "HOST_OFFLINE");
        assert_eq!(transport.acknowledgements, 0);
        let a_before: i64 = account_a
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_archive_cache_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(a_before, 0);

        // A later poll after the host recovers obtains the same immutable
        // package.  Hash/schema validation and the SQLite transaction happen
        // before exactly one ACK.  The second account has a distinct cache
        // scope and cannot observe account A's recovered history.
        transport.recover();
        let completed =
            archive_download_with_transport(&mut account_a, &mut transport, "request-recovery-1")
                .unwrap();
        assert_eq!(completed.state, "ACKED");
        assert_eq!(transport.acknowledgements, 1);
        let a_after: i64 = account_a
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_archive_cache_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let b_after: i64 = account_b
            .conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_archive_cache_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(a_after, 1);
        assert_eq!(b_after, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stream_wakeup_accepts_only_content_free_valid_delivery_frames() {
        let event = parse_delivery_stream_event(
            r#"{"deliveryId":"daily:2026-08-23:zh-CN","cursor":"42","kind":"daily"}"#,
        )
        .unwrap();
        assert_eq!(event.cursor, "42");
        assert!(parse_delivery_stream_event(
            r#"{"deliveryId":"daily:2026-08-23:zh-CN","cursor":"0","kind":"daily"}"#,
        )
        .is_none());
        assert!(parse_delivery_stream_event(
            r#"{"deliveryId":"daily:2026-08-23:zh-CN","cursor":"42","kind":"daily","body":"no"}"#,
        )
        .is_none());
        assert!(parse_delivery_stream_event(
            r#"{"deliveryId":"daily:2026-08-23:zh-CN","cursor":"42","kind":"archive"}"#,
        )
        .is_none());
    }

    #[test]
    fn registered_device_response_must_bind_the_current_device_and_platform() {
        let response = serde_json::json!({
            "schemaVersion": 1,
            "deviceId": "desktop-device",
            "platform": "windows",
            "quietHours": {},
            "updatedAt": "2026-08-25T00:00:00Z",
        });
        assert!(validate_registered_device(&response, "desktop-device", "windows").is_ok());
        assert!(validate_registered_device(&response, "other-device", "windows").is_err());
        assert!(validate_registered_device(&response, "desktop-device", "linux").is_err());

        let mut malformed = response;
        malformed["quietHours"] = serde_json::json!([]);
        assert!(validate_registered_device(&malformed, "desktop-device", "windows").is_err());
    }

    #[test]
    fn stream_cursor_is_monotonic_and_account_changes_cancel_old_session() {
        assert!(cursor_is_newer("43", "42"));
        assert!(!cursor_is_newer("42", "42"));
        assert!(!cursor_is_newer("not-a-cursor", "42"));
        let old = AccountConnection {
            base: "https://service.example".into(),
            account_id: "account-a".into(),
            token: "old-token".into(),
            device_id: "device-a".into(),
        };
        let changed_account = AccountConnection {
            account_id: "account-b".into(),
            ..old.clone()
        };
        let renewed_token = AccountConnection {
            token: "new-token".into(),
            ..old.clone()
        };
        assert!(!stream_sessions_match(&old, &changed_account));
        assert!(!stream_sessions_match(&old, &renewed_token));
        assert!(stream_sessions_match(&old, &old));
    }
}
