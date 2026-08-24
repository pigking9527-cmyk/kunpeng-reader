//! Account-isolated, bounded historical archive relay.  This module is not a
//! publication store: packages expire shortly after acknowledgement and every
//! row is scoped either to one user request or to a publisher relay credential.

use std::{collections::BTreeMap, fmt::Write as _, sync::LazyLock};

use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use metrics::counter;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::Semaphore,
    task::JoinHandle,
    time::{Duration as TokioDuration, MissedTickBehavior, interval, sleep},
};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    auth::authenticate, credentials::intelligence_publisher_token_digest, error::ApiError,
    intelligence_object_outbox, middleware::RequestContext, state::AppState,
};

const REQUEST_TTL: Duration = Duration::days(7);
const CLAIM_LEASE: Duration = Duration::minutes(5);
const PACKAGE_TTL: Duration = Duration::hours(24);
const ACK_PURGE_DELAY: Duration = Duration::minutes(5);
const MAX_WAIT_SECONDS: u8 = 25;
const MAX_PACKAGE_BYTES: usize = 4 * 1024 * 1024;
/// Archive transfer is chunked so a relay can resume an interrupted package
/// without re-reading the permanent archive.  The finished temporary package
/// is still bounded and is never a second long-term archive.
const MAX_ARCHIVE_PACKAGE_BYTES: i64 = 128 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES: usize = 1024 * 1024;
const ARCHIVE_RECLAIM_INTERVAL: TokioDuration = TokioDuration::from_mins(5);
// This is intentionally outside the ordinary HTTP read/write semaphores.  A
// slow publisher must not occupy a slot needed for reader traffic.
static LONG_POLL_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

/// Run archive expiry independently of reader requests and publisher polls.
/// A quiet installation must still transition stale relay work, erase expired
/// temporary upload buffers, and enqueue object-store GC on schedule.
pub(crate) fn spawn_reclaimer(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = interval(ARCHIVE_RECLAIM_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            match reap_archive_jobs(&state.pool, now_ms()).await {
                Ok(()) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "intelligence_archive", "outcome" => "success").increment(1);
                }
                Err(_) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "intelligence_archive", "outcome" => "error").increment(1);
                }
            }
        }
    })
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRequestInput {
    pub request: ArchiveSelector,
}
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequestView {
    pub schema_version: u8,
    pub request_id: String,
    pub state: String,
    pub requested_at: String,
    pub expires_at: String,
    pub request: ArchiveSelector,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
}
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobQuery {
    pub wait: Option<u8>,
}
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublisherJobsResponse {
    pub schema_version: u8,
    pub jobs: Vec<PublisherJob>,
}
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublisherJob {
    pub schema_version: u8,
    pub job_id: String,
    pub kind: String,
    pub request_id: String,
    pub created_at: String,
    pub request: ArchiveSelector,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadContentInput {
    pub content_base64: String,
    pub content_sha256: String,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveUploadInitInput {
    pub total_bytes: i64,
    pub content_sha256: String,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveUploadProgress {
    pub schema_version: u8,
    pub upload_id: String,
    pub total_bytes: i64,
    pub received_bytes: i64,
    pub chunk_bytes: usize,
    pub complete: bool,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveUploadChunkInput {
    pub offset: i64,
    pub content_base64: String,
    pub chunk_sha256: String,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInput {
    #[serde(default)]
    pub reason: String,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveContentResponse {
    pub schema_version: u8,
    pub request_id: String,
    pub content_base64: String,
    pub content_sha256: String,
}
/// The archive calendar is deliberately content-free.  It is populated by
/// retention after a hot publication has been physically removed.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCalendarResponse {
    pub schema_version: u8,
    pub days: Vec<ArchiveCalendarDay>,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCalendarDay {
    pub day: String,
    pub entry_count: i64,
}
/// Heartbeats prove that the independently provisioned relay installation is
/// alive.  They intentionally carry no job, selector, package or content
/// information.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherHeartbeatInput {
    pub schema_version: u8,
    pub installation_id: String,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublisherHeartbeatResponse {
    pub schema_version: u8,
    pub accepted_at: String,
}

#[derive(FromRow)]
struct RequestRow {
    request_id: Uuid,
    state: String,
    requested_at: i64,
    expires_at: i64,
    request: sqlx::types::Json<ArchiveSelector>,
    content_sha256: Option<Vec<u8>>,
}
#[derive(FromRow)]
struct JobRow {
    job_id: Uuid,
    created_at: i64,
    request: sqlx::types::Json<ArchiveSelector>,
}
#[derive(FromRow)]
struct ContentRow {
    storage_backend: String,
    object_key: Option<String>,
    content: Option<Vec<u8>>,
    content_sha256: Vec<u8>,
}
#[derive(FromRow)]
struct ArchiveStorageRow {
    storage_backend: String,
    object_key: Option<String>,
}
/// Database representation of an archive package location.
///
/// `Postgres` is the compatibility path for every existing deployment.  An
/// `S3` row can only be made visible by a worker *after* `put` has succeeded;
/// the request transaction itself never invokes an object-store operation.
#[derive(Clone, Debug, Eq, PartialEq)]
enum ArchiveStorageLocation {
    Postgres,
    S3 { object_key: String },
}

impl ArchiveStorageLocation {
    fn from_columns(storage_backend: &str, object_key: Option<String>) -> Option<Self> {
        match (storage_backend, object_key) {
            ("postgres", None) => Some(Self::Postgres),
            ("s3", Some(object_key)) if valid_archive_object_key(&object_key) => {
                Some(Self::S3 { object_key })
            }
            _ => None,
        }
    }
}

#[derive(FromRow)]
struct ArchiveCalendarRow {
    archive_day: String,
    purged_publication_count: i64,
}
#[derive(Clone)]
struct RelayCredential {
    digest: [u8; 32],
    installation_id: String,
}
#[derive(FromRow)]
struct ArchiveUploadRow {
    upload_id: Uuid,
    publisher_token_digest: Vec<u8>,
    content_sha256: Vec<u8>,
    total_bytes: i64,
    received_bytes: i64,
    completed_at: i64,
}
#[derive(FromRow)]
struct ArchiveUploadCompleteRow {
    publisher_token_digest: Vec<u8>,
    content_sha256: Vec<u8>,
    total_bytes: i64,
    received_bytes: i64,
    completed_at: i64,
    content: Vec<u8>,
}

/// Internal-safe stage marker for the bounded archive reaper.
///
/// Its display text intentionally omits database and request detail.  The
/// named stage is only available to local protected E2E callers through the
/// debug representation, so HTTP responses remain the generic 503 boundary.
#[derive(Debug, thiserror::Error)]
#[error("archive relay maintenance unavailable")]
pub enum ArchiveReapError {
    /// The transaction could not complete the named bounded state transition.
    Database { step: &'static str },
}

#[utoipa::path(post, path = "/v1/intelligence/archive-requests", request_body = ArchiveRequestInput, responses((status = 201, body = ArchiveRequestView), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn create_request(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<ArchiveRequestInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Some(selector) = normalize(input.request) else {
        return ApiError::InvalidRequest.response(context);
    };
    match create_request_tx(&state, &user.id, &key, selector).await {
        Ok(view) => (StatusCode::CREATED, Json(view)).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/archive-requests/{id}", params(("id" = String, Path)), responses((status = 200, body = ArchiveRequestView), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn request_status(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let Ok(id) = Uuid::parse_str(&id) else {
        return ApiError::NotFound.response(context);
    };
    if reap_archive_jobs(&state.pool, now_ms()).await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    match request_view(&state, &user.id, id).await {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => ApiError::NotFound.response(context),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/archive-requests/{id}/content", params(("id" = String, Path)), responses((status = 200, body = ArchiveContentResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn content(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let Ok(id) = Uuid::parse_str(&id) else {
        return ApiError::NotFound.response(context);
    };
    if reap_archive_jobs(&state.pool, now_ms()).await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    let now = now_ms();
    // This statement intentionally finishes before a possible object-store
    // read.  `S3` can be slow or unavailable, but a request transaction must
    // never hold PostgreSQL locks while performing network I/O.  `DOWNLOADED`
    // is retryable, so a failed object read does not consume the package.
    let row = sqlx::query_as::<_, ContentRow>("UPDATE intelligence_archive_requests_v1 r SET state='DOWNLOADED',downloaded_at=$3,updated_at=$3 FROM intelligence_archive_jobs_v1 j WHERE r.request_id=$1 AND r.user_id=$2 AND r.job_id=j.job_id AND r.state IN ('READY','DOWNLOADED') AND j.state='READY' AND j.content_expires_at>$3 RETURNING j.storage_backend,j.object_key,j.content,j.content_sha256").bind(id).bind(&user.id).bind(now).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) => {
            // `read_archive_content` consumes the storage row so an S3 key
            // can be moved into the blocking read.  Keep the authoritative
            // database digest before that hand-off for the response.
            let content_sha256 = hex(&row.content_sha256);
            match read_archive_content(&state, row).await {
                Ok(payload) => Json(ArchiveContentResponse {
                    schema_version: 1,
                    request_id: id.to_string(),
                    content_base64: STANDARD.encode(payload),
                    content_sha256,
                })
                .into_response(),
                Err(()) => ApiError::DatabaseUnavailable.response(context),
            }
        }
        Ok(None) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

/// Resolves a package only after the SQL state transition has committed.
///
/// Object-store reads deliberately run on Tokio's blocking pool: the adapter
/// is synchronous, and its request timeout must not block an async worker.
/// The hash remains authoritative in `PostgreSQL`, so a stale or substituted
/// object is never returned to the reader.
async fn read_archive_content(state: &AppState, row: ContentRow) -> Result<Vec<u8>, ()> {
    let location =
        ArchiveStorageLocation::from_columns(&row.storage_backend, row.object_key).ok_or(())?;
    let content = match location {
        ArchiveStorageLocation::Postgres => row.content.ok_or(())?,
        ArchiveStorageLocation::S3 { object_key } => {
            let store = std::sync::Arc::clone(&state.intelligence_object_store);
            tokio::task::spawn_blocking(move || store.get_range(&object_key, 0, None))
                .await
                .map_err(|_| ())?
                .map_err(|_| ())?
                .bytes
        }
    };
    (hash(&content).as_slice() == row.content_sha256.as_slice())
        .then_some(content)
        .ok_or(())
}

#[utoipa::path(post, path = "/v1/intelligence/archive-requests/{id}/content/ack", params(("id" = String, Path)), responses((status = 200, body = ArchiveRequestView), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn ack_content(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let Ok(id) = Uuid::parse_str(&id) else {
        return ApiError::NotFound.response(context);
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    match ack_tx(&state, &user.id, &key, id).await {
        Ok(view) => Json(view).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/archive/calendar", responses((status = 200, body = ArchiveCalendarResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn calendar(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = reader(&state, &headers).await {
        return error.response(context);
    }
    let rows = sqlx::query_as::<_, ArchiveCalendarRow>(
        "SELECT archive_day::text AS archive_day,purged_publication_count FROM intelligence_archive_calendar_v1 ORDER BY archive_day DESC",
    )
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(rows) => Json(ArchiveCalendarResponse {
            schema_version: 1,
            days: rows
                .into_iter()
                .map(|row| ArchiveCalendarDay {
                    day: row.archive_day,
                    entry_count: row.purged_publication_count,
                })
                .collect(),
        })
        .into_response(),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/publisher/heartbeat", request_body = PublisherHeartbeatInput, responses((status = 200, body = PublisherHeartbeatResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn heartbeat(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<PublisherHeartbeatInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.schema_version != 1 || !valid_installation_id(&input.installation_id) {
        return ApiError::InvalidRequest.response(context);
    }
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    // The installation id is not a client-selected identity: it must match
    // the still-active, revocable relay credential selected by its token.
    if credential.installation_id != input.installation_id {
        return ApiError::IntelligencePublisherRequired.response(context);
    }
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    match heartbeat_tx(&state, &credential, &key, &input.installation_id).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/publisher/jobs", params(JobQuery), responses((status = 200, body = PublisherJobsResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn jobs(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<JobQuery>,
) -> Response {
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let wait = query.wait.unwrap_or(0);
    if wait > MAX_WAIT_SECONDS {
        return ApiError::InvalidRequest.response(context);
    }
    // Check capability before taking the separate scarce long-poll lane.
    if wait == 0 {
        return jobs_now(&state, &credential, context).await;
    }
    let Ok(_permit) = LONG_POLL_SLOTS.try_acquire() else {
        return ApiError::Busy.response(context);
    };
    let deadline = tokio::time::Instant::now() + TokioDuration::from_secs(u64::from(wait));
    loop {
        match jobs_result(&state, &credential).await {
            Ok(result) if !result.jobs.is_empty() => return Json(result).into_response(),
            Ok(_) => {}
            Err(error) => return error.response(context),
        }
        if tokio::time::Instant::now() >= deadline {
            return Json(PublisherJobsResponse {
                schema_version: 1,
                jobs: Vec::new(),
            })
            .into_response();
        }
        sleep(TokioDuration::from_millis(250)).await;
    }
}

#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/claim", params(("id" = String, Path)), responses((status = 200, body = PublisherJob), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn claim(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    relay_mutation(&state, context, headers, id, RelayAction::Claim).await
}
#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/not-found", params(("id" = String, Path)), request_body = TerminalInput, responses((status = 200), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn not_found(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<TerminalInput>, JsonRejection>,
) -> Response {
    if input.is_err() {
        return ApiError::InvalidRequest.response(context);
    }
    relay_mutation(&state, context, headers, id, RelayAction::NotFound).await
}
#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/failed", params(("id" = String, Path)), request_body = TerminalInput, responses((status = 200), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn failed(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<TerminalInput>, JsonRejection>,
) -> Response {
    if input.is_err() {
        return ApiError::InvalidRequest.response(context);
    }
    relay_mutation(&state, context, headers, id, RelayAction::Failed).await
}

#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/content", params(("id" = String, Path)), request_body = UploadContentInput, responses((status = 200), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn upload_content(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<UploadContentInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let Ok(job_id) = Uuid::parse_str(&id) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(package_bytes) = STANDARD.decode(input.content_base64.as_bytes()) else {
        return ApiError::InvalidRequest.response(context);
    };
    if package_bytes.is_empty()
        || package_bytes.len() > MAX_PACKAGE_BYTES
        || input.content_sha256.len() != 64
        || hex(&hash(&package_bytes)) != input.content_sha256
    {
        return ApiError::InvalidRequest.response(context);
    }
    match upload_content_tx(&state, &credential, &key, job_id, package_bytes).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(error) => error.response(context),
    }
}

/// Starts or resumes a bounded, append-only historical-package upload.
/// The caller obtains the current offset from the response and may retry a
/// chunk with the same idempotency key after a transport interruption.
#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/uploads/init", params(("id" = String, Path)), request_body = ArchiveUploadInitInput, responses((status = 201, body = ArchiveUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn init_chunked_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<ArchiveUploadInitInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let Ok(job_id) = Uuid::parse_str(&id) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(declared_sha) = parse_sha256(&input.content_sha256) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !(1..=MAX_ARCHIVE_PACKAGE_BYTES).contains(&input.total_bytes) {
        return ApiError::InvalidRequest.response(context);
    }
    match archive_upload_init_tx(
        &state,
        &credential,
        &key,
        job_id,
        input.total_bytes,
        declared_sha,
    )
    .await
    {
        Ok(progress) => (StatusCode::CREATED, Json(progress)).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(put, path = "/v1/intelligence/publisher/jobs/{id}/uploads/{upload_id}", params(("id" = String, Path), ("upload_id" = String, Path)), request_body = ArchiveUploadChunkInput, responses((status = 200, body = ArchiveUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn upload_chunk(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path((id, upload_id)): Path<(String, String)>,
    input: Result<Json<ArchiveUploadChunkInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let (Ok(job_id), Ok(upload_id), Ok(chunk)) = (
        Uuid::parse_str(&id),
        Uuid::parse_str(&upload_id),
        STANDARD.decode(input.content_base64.as_bytes()),
    ) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(chunk_sha) = parse_sha256(&input.chunk_sha256) else {
        return ApiError::InvalidRequest.response(context);
    };
    if chunk.is_empty()
        || chunk.len() > MAX_UPLOAD_CHUNK_BYTES
        || hash(&chunk) != chunk_sha
        || input.offset < 0
    {
        return ApiError::InvalidRequest.response(context);
    }
    match archive_upload_chunk_tx(
        &state,
        &credential,
        &key,
        job_id,
        upload_id,
        input.offset,
        chunk,
    )
    .await
    {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/publisher/jobs/{id}/uploads/{upload_id}/complete", params(("id" = String, Path), ("upload_id" = String, Path)), responses((status = 200, body = ArchiveUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn complete_chunked_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path((id, upload_id)): Path<(String, String)>,
) -> Response {
    let credential = match relay_publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let (Ok(job_id), Ok(upload_id)) = (Uuid::parse_str(&id), Uuid::parse_str(&upload_id)) else {
        return ApiError::InvalidRequest.response(context);
    };
    match archive_upload_complete_tx(&state, &credential, &key, job_id, upload_id).await {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(context),
    }
}

#[derive(Clone, Copy)]
enum RelayAction {
    Claim,
    NotFound,
    Failed,
}
async fn relay_mutation(
    state: &AppState,
    context: RequestContext,
    headers: HeaderMap,
    id: String,
    action: RelayAction,
) -> Response {
    let credential = match relay_publisher(state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let Ok(job_id) = Uuid::parse_str(&id) else {
        return ApiError::InvalidRequest.response(context);
    };
    match action_tx(state, &credential, &key, job_id, action).await {
        Ok(job) => Json(job).into_response(),
        Err(error) => error.response(context),
    }
}

async fn reader(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::AuthenticatedUser, ApiError> {
    let user = authenticate(state, headers).await?;
    user.intelligence_feed_enabled
        .then_some(user)
        .ok_or(ApiError::IntelligenceAccessDenied)
}
async fn relay_publisher(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<RelayCredential, ApiError> {
    let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
    let digest = intelligence_publisher_token_digest(&state.token_hmac_key, &token)
        .map_err(|_| ApiError::Unauthorized)?;
    let row = sqlx::query_as::<_, (String,)>("SELECT installation_id FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1 AND revoked_at=0 AND expires_at>$2 AND capabilities @> ARRAY['intelligence:relay']::text[]").bind(digest.as_slice()).bind(now_ms()).fetch_optional(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some((installation_id,)) = row {
        return Ok(RelayCredential {
            digest,
            installation_id,
        });
    }
    match authenticate(state, headers).await {
        Ok(_) => Err(ApiError::IntelligencePublisherRequired),
        Err(ApiError::Unauthorized) => Err(ApiError::Unauthorized),
        Err(error) => Err(error),
    }
}

async fn heartbeat_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    installation_id: &str,
) -> Result<PublisherHeartbeatResponse, ApiError> {
    let request_hash = hash(format!("heartbeat:v1:{installation_id}").as_bytes());
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = relay_receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let response = PublisherHeartbeatResponse {
        schema_version: 1,
        accepted_at: format_ms(now_ms()),
    };
    // Relay receipts provide the durable idempotency write without retaining
    // content.  Credential lookup above already enforces expiration and
    // revocation for every heartbeat.
    store_relay_receipt(&mut tx, &credential.digest, key, request_hash, &response).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}

async fn create_request_tx(
    state: &AppState,
    user_id: &str,
    key: &str,
    request: ArchiveSelector,
) -> Result<ArchiveRequestView, ApiError> {
    let request_json = serde_json::to_value(&request).map_err(|_| ApiError::Internal)?;
    let fingerprint = hash(&canonical(&request_json));
    let request_hash = hash(format!("create:{user_id}:{}", hex(&fingerprint)).as_bytes());
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = user_receipt(&mut tx, user_id, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let job_id = Uuid::new_v4();
    let expires = now + duration_ms(REQUEST_TTL);
    sqlx::query("INSERT INTO intelligence_archive_jobs_v1 (job_id,request_fingerprint,request,state,created_at,expires_at,updated_at) VALUES ($1,$2,$3,'QUEUED',$4,$5,$4) ON CONFLICT (request_fingerprint) DO NOTHING").bind(job_id).bind(fingerprint.as_slice()).bind(sqlx::types::Json(&request_json)).bind(now).bind(expires).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let job_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT job_id FROM intelligence_archive_jobs_v1 WHERE request_fingerprint=$1 FOR UPDATE",
    )
    .bind(fingerprint.as_slice())
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let request_id = Uuid::new_v4();
    sqlx::query("INSERT INTO intelligence_archive_requests_v1 (request_id,user_id,request_fingerprint,job_id,request,state,requested_at,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,'REQUESTED',$6,$7,$6) ON CONFLICT (user_id,request_fingerprint) DO NOTHING").bind(request_id).bind(user_id).bind(fingerprint.as_slice()).bind(job_id).bind(sqlx::types::Json(&request_json)).bind(now).bind(expires).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let row = sqlx::query_as::<_, RequestRow>("SELECT r.request_id,r.state,r.requested_at,r.expires_at,r.request,j.content_sha256 FROM intelligence_archive_requests_v1 r JOIN intelligence_archive_jobs_v1 j ON r.job_id=j.job_id WHERE r.user_id=$1 AND r.request_fingerprint=$2 FOR UPDATE").bind(user_id).bind(fingerprint.as_slice()).fetch_one(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let view = view(row);
    store_user_receipt(&mut tx, user_id, key, request_hash, &view).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(view)
}

async fn jobs_now(
    state: &AppState,
    credential: &RelayCredential,
    context: RequestContext,
) -> Response {
    match jobs_result(state, credential).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.response(context),
    }
}
async fn jobs_result(
    state: &AppState,
    _credential: &RelayCredential,
) -> Result<PublisherJobsResponse, ApiError> {
    reap_archive_jobs(&state.pool, now_ms())
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    // A host that returns to its own long-poll is the only signal needed to
    // release a bounded HOST_OFFLINE back to its queued relay work.  The
    // request itself remains account-isolated; only the shared fetch task is
    // resumed.
    sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='QUEUED',updated_at=$1 WHERE state='HOST_OFFLINE' AND expires_at>$1")
        .bind(now_ms())
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("UPDATE intelligence_archive_requests_v1 r SET state='QUEUED',updated_at=$1 FROM intelligence_archive_jobs_v1 j WHERE r.job_id=j.job_id AND r.state='REQUESTED' AND j.state='QUEUED'")
        .bind(now_ms())
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let rows = sqlx::query_as::<_, JobRow>("SELECT job_id,created_at,request FROM intelligence_archive_jobs_v1 WHERE state='QUEUED' AND expires_at>$1 ORDER BY created_at ASC LIMIT 8").bind(now_ms()).fetch_all(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(PublisherJobsResponse {
        schema_version: 1,
        jobs: rows
            .into_iter()
            .map(|row| PublisherJob {
                schema_version: 1,
                job_id: row.job_id.to_string(),
                kind: "archive_relay".to_owned(),
                request_id: row.job_id.to_string(),
                created_at: format_ms(row.created_at),
                request: row.request.0,
            })
            .collect(),
    })
}
async fn action_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    job_id: Uuid,
    action: RelayAction,
) -> Result<PublisherJob, ApiError> {
    let label = match action {
        RelayAction::Claim => "claim",
        RelayAction::NotFound => "not-found",
        RelayAction::Failed => "failed",
    };
    let request_hash = hash(format!("{label}:{job_id}").as_bytes());
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = relay_receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let row = match action {
        RelayAction::Claim => sqlx::query_as::<_, JobRow>("UPDATE intelligence_archive_jobs_v1 SET state='CLAIMED',claimed_by=$2,lease_expires_at=$3,updated_at=$4 WHERE job_id=$1 AND state='QUEUED' AND expires_at>$4 RETURNING job_id,created_at,request")
            .bind(job_id).bind(credential.digest.as_slice()).bind(now + duration_ms(CLAIM_LEASE)).bind(now).fetch_optional(&mut *tx).await,
        RelayAction::NotFound => sqlx::query_as::<_, JobRow>("UPDATE intelligence_archive_jobs_v1 SET state='NOT_FOUND',claimed_by=$2,lease_expires_at=0,updated_at=$3 WHERE job_id=$1 AND claimed_by=$2 AND state IN ('CLAIMED','UPLOADING') AND expires_at>$3 RETURNING job_id,created_at,request")
            .bind(job_id).bind(credential.digest.as_slice()).bind(now).fetch_optional(&mut *tx).await,
        RelayAction::Failed => sqlx::query_as::<_, JobRow>("UPDATE intelligence_archive_jobs_v1 SET state='FAILED',claimed_by=$2,lease_expires_at=0,updated_at=$3 WHERE job_id=$1 AND claimed_by=$2 AND state IN ('CLAIMED','UPLOADING') AND expires_at>$3 RETURNING job_id,created_at,request")
            .bind(job_id).bind(credential.digest.as_slice()).bind(now).fetch_optional(&mut *tx).await,
    }.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
    let next = match action {
        RelayAction::Claim => "CLAIMED",
        RelayAction::NotFound => "NOT_FOUND",
        RelayAction::Failed => "FAILED",
    };
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state=$2,updated_at=$3 WHERE job_id=$1 AND state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING')").bind(job_id).bind(next).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let job = PublisherJob {
        schema_version: 1,
        job_id: row.job_id.to_string(),
        kind: "archive_relay".to_owned(),
        request_id: row.job_id.to_string(),
        created_at: format_ms(row.created_at),
        request: row.request.0,
    };
    store_relay_receipt(&mut tx, &credential.digest, key, request_hash, &job).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(job)
}
async fn upload_content_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    job_id: Uuid,
    content: Vec<u8>,
) -> Result<(), ApiError> {
    let request_hash = hash(&content);
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if relay_receipt(&mut tx, &credential.digest, key, request_hash)
        .await?
        .is_some()
    {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(());
    }
    let changed = sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='READY',content=$3,content_sha256=$4,content_expires_at=$5,lease_expires_at=0,updated_at=$2 WHERE job_id=$1 AND claimed_by=$6 AND state IN ('CLAIMED','UPLOADING') AND expires_at>$2").bind(job_id).bind(now).bind(&content).bind(hash(&content).as_slice()).bind(now + duration_ms(PACKAGE_TTL)).bind(credential.digest.as_slice()).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::NotFound);
    }
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='READY',updated_at=$2 WHERE job_id=$1 AND state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING')").bind(job_id).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if state.intelligence_object_store_status()
        == crate::intelligence_object_store::IntelligenceObjectStoreStatus::Configured
    {
        intelligence_object_outbox::enqueue_archive_write(&mut tx, job_id, now).await?;
    }
    store_relay_receipt(
        &mut tx,
        &credential.digest,
        key,
        request_hash,
        &serde_json::json!({"ok":true}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn archive_upload_init_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    job_id: Uuid,
    total_bytes: i64,
    content_sha256: [u8; 32],
) -> Result<ArchiveUploadProgress, ApiError> {
    let request_hash = hash(
        format!(
            "archive-upload-init:{job_id}:{total_bytes}:{}",
            hex(&content_sha256)
        )
        .as_bytes(),
    );
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = relay_receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let existing = sqlx::query_as::<_, ArchiveUploadRow>("SELECT upload_id,publisher_token_digest,content_sha256,total_bytes,received_bytes,completed_at FROM intelligence_archive_uploads_v1 WHERE job_id=$1 FOR UPDATE")
        .bind(job_id).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let (upload_id, received_bytes, completed_at) = if let Some(row) = existing {
        if row.publisher_token_digest.as_slice() != credential.digest
            || row.content_sha256.as_slice() != content_sha256
            || row.total_bytes != total_bytes
        {
            return Err(ApiError::IdempotencyKeyReused);
        }
        (row.upload_id, row.received_bytes, row.completed_at)
    } else {
        let changed = sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='UPLOADING',updated_at=$3 WHERE job_id=$1 AND claimed_by=$2 AND state IN ('CLAIMED','UPLOADING') AND expires_at>$3")
            .bind(job_id).bind(credential.digest.as_slice()).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if changed.rows_affected() != 1 {
            return Err(ApiError::NotFound);
        }
        let upload_id = Uuid::new_v4();
        sqlx::query("INSERT INTO intelligence_archive_uploads_v1 (upload_id,job_id,publisher_token_digest,content_sha256,total_bytes,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)")
            .bind(upload_id).bind(job_id).bind(credential.digest.as_slice()).bind(content_sha256.as_slice()).bind(total_bytes).bind(now + duration_ms(PACKAGE_TTL)).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        (upload_id, 0, 0)
    };
    let progress = ArchiveUploadProgress {
        schema_version: 1,
        upload_id: upload_id.to_string(),
        total_bytes,
        received_bytes,
        chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
        complete: completed_at > 0,
    };
    store_relay_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}

async fn archive_upload_chunk_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    job_id: Uuid,
    upload_id: Uuid,
    offset: i64,
    chunk: Vec<u8>,
) -> Result<ArchiveUploadProgress, ApiError> {
    let request_hash = hash(
        format!(
            "archive-upload-chunk:{upload_id}:{offset}:{}",
            hex(&hash(&chunk))
        )
        .as_bytes(),
    );
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = relay_receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let row = sqlx::query_as::<_, ArchiveUploadRow>("SELECT upload_id,publisher_token_digest,content_sha256,total_bytes,received_bytes,completed_at FROM intelligence_archive_uploads_v1 WHERE upload_id=$1 AND job_id=$2 AND expires_at>$3 FOR UPDATE")
        .bind(upload_id).bind(job_id).bind(now).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
    if row.publisher_token_digest.as_slice() != credential.digest
        || row.completed_at > 0
        || offset != row.received_bytes
    {
        return Err(ApiError::IdempotencyKeyReused);
    }
    let next = offset
        .checked_add(i64::try_from(chunk.len()).map_err(|_| ApiError::InvalidRequest)?)
        .ok_or(ApiError::InvalidRequest)?;
    if next > row.total_bytes {
        return Err(ApiError::InvalidRequest);
    }
    sqlx::query("UPDATE intelligence_archive_uploads_v1 SET content=content || $3,received_bytes=$4,updated_at=$5 WHERE upload_id=$1 AND job_id=$2")
        .bind(upload_id).bind(job_id).bind(&chunk).bind(next).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let progress = ArchiveUploadProgress {
        schema_version: 1,
        upload_id: upload_id.to_string(),
        total_bytes: row.total_bytes,
        received_bytes: next,
        chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
        complete: false,
    };
    store_relay_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}

async fn archive_upload_complete_tx(
    state: &AppState,
    credential: &RelayCredential,
    key: &str,
    job_id: Uuid,
    upload_id: Uuid,
) -> Result<ArchiveUploadProgress, ApiError> {
    let request_hash = hash(format!("archive-upload-complete:{upload_id}").as_bytes());
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = relay_receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let row = sqlx::query_as::<_, ArchiveUploadCompleteRow>("SELECT publisher_token_digest,content_sha256,total_bytes,received_bytes,completed_at,content FROM intelligence_archive_uploads_v1 WHERE upload_id=$1 AND job_id=$2 AND expires_at>$3 FOR UPDATE")
        .bind(upload_id).bind(job_id).bind(now).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
    if row.publisher_token_digest.as_slice() != credential.digest {
        return Err(ApiError::NotFound);
    }
    if row.completed_at == 0 {
        if row.received_bytes != row.total_bytes
            || hash(&row.content).as_slice() != row.content_sha256.as_slice()
        {
            return Err(ApiError::InvalidRequest);
        }
        let changed = sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='READY',content=$3,content_sha256=$4,content_expires_at=$5,lease_expires_at=0,updated_at=$2 WHERE job_id=$1 AND claimed_by=$6 AND state='UPLOADING' AND expires_at>$2")
            .bind(job_id).bind(now).bind(&row.content).bind(row.content_sha256.as_slice()).bind(now + duration_ms(PACKAGE_TTL)).bind(credential.digest.as_slice()).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if changed.rows_affected() != 1 {
            return Err(ApiError::NotFound);
        }
        // Clear the resumable staging buffer consistently with its
        // `octet_length(content) = received_bytes` database invariant.
        sqlx::query("UPDATE intelligence_archive_uploads_v1 SET completed_at=$3,received_bytes=0,content=''::bytea,updated_at=$3 WHERE upload_id=$1 AND job_id=$2")
            .bind(upload_id).bind(job_id).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='READY',updated_at=$2 WHERE job_id=$1 AND state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING')")
            .bind(job_id).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if state.intelligence_object_store_status()
            == crate::intelligence_object_store::IntelligenceObjectStoreStatus::Configured
        {
            intelligence_object_outbox::enqueue_archive_write(&mut tx, job_id, now).await?;
        }
    }
    let progress = ArchiveUploadProgress {
        schema_version: 1,
        upload_id: upload_id.to_string(),
        total_bytes: row.total_bytes,
        received_bytes: row.total_bytes,
        chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
        complete: true,
    };
    store_relay_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}
async fn ack_tx(
    state: &AppState,
    user_id: &str,
    key: &str,
    id: Uuid,
) -> Result<ArchiveRequestView, ApiError> {
    let request_hash = hash(format!("ack:{id}").as_bytes());
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = user_receipt(&mut tx, user_id, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let changed = sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='ACKED',acknowledged_at=$3,purge_at=$4,updated_at=$3 WHERE request_id=$1 AND user_id=$2 AND state IN ('READY','DOWNLOADED')").bind(id).bind(user_id).bind(now).bind(now + duration_ms(ACK_PURGE_DELAY)).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::NotFound);
    }
    // A shared fetch task may serve several account-isolated requests.  It is
    // safe to physically erase its bytes as soon as the final retrievable
    // delivery has ACKed; this is stronger than the five-minute upper bound.
    // Earlier ACKs only hide that account's request and cannot revoke another
    // account's still-pending download.
    purge_final_archive_delivery_tx(&mut tx, id, now).await?;
    let row = sqlx::query_as::<_, RequestRow>("SELECT r.request_id,r.state,r.requested_at,r.expires_at,r.request,j.content_sha256 FROM intelligence_archive_requests_v1 r JOIN intelligence_archive_jobs_v1 j ON r.job_id=j.job_id WHERE r.request_id=$1 AND r.user_id=$2 FOR UPDATE").bind(id).bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
    let view = view(row);
    store_user_receipt(&mut tx, user_id, key, request_hash, &view).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(view)
}

/// Removes the final database reference to a package and, for an S3 package,
/// durably schedules deletion.  This is intentionally a database-only
/// transaction.  The GC worker may call S3 only after this transaction
/// commits, so a failed object deletion can be retried without resurrecting a
/// reader-visible package.
async fn purge_final_archive_delivery_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    request_id: Uuid,
    now: i64,
) -> Result<(), ApiError> {
    let row = sqlx::query_as::<_, ArchiveStorageRow>(
        "SELECT j.storage_backend,j.object_key FROM intelligence_archive_jobs_v1 j WHERE j.job_id=(SELECT job_id FROM intelligence_archive_requests_v1 WHERE request_id=$1) AND (j.content IS NOT NULL OR j.object_key IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM intelligence_archive_requests_v1 r WHERE r.job_id=j.job_id AND r.state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING','READY','DOWNLOADED')) FOR UPDATE",
    )
    .bind(request_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let Some(row) = row else {
        return Ok(());
    };
    let location = ArchiveStorageLocation::from_columns(&row.storage_backend, row.object_key)
        .ok_or(ApiError::DatabaseUnavailable)?;
    if let ArchiveStorageLocation::S3 { object_key } = location {
        enqueue_archive_object_gc_tx(tx, &object_key, now).await?;
    }
    sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='PURGED',content=NULL,content_sha256=NULL,content_expires_at=0,lease_expires_at=0,object_key=NULL,updated_at=$2 WHERE job_id=(SELECT job_id FROM intelligence_archive_requests_v1 WHERE request_id=$1)")
        .bind(request_id)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

/// Enqueues a deletion after (and only after) a database transaction has
/// decided that no reader request can reference the object any more.
async fn enqueue_archive_object_gc_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    object_key: &str,
    now: i64,
) -> Result<(), ApiError> {
    if !valid_archive_object_key(object_key) {
        return Err(ApiError::DatabaseUnavailable);
    }
    sqlx::query("INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) ON CONFLICT (storage_backend,object_key) DO UPDATE SET state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END,not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at),updated_at=EXCLUDED.updated_at")
        .bind(Uuid::new_v4())
        .bind(object_key)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn request_view(
    state: &AppState,
    user_id: &str,
    id: Uuid,
) -> Result<Option<ArchiveRequestView>, ApiError> {
    let row = sqlx::query_as::<_, RequestRow>("SELECT r.request_id,r.state,r.requested_at,r.expires_at,r.request,j.content_sha256 FROM intelligence_archive_requests_v1 r JOIN intelligence_archive_jobs_v1 j ON r.job_id=j.job_id WHERE r.request_id=$1 AND r.user_id=$2").bind(id).bind(user_id).fetch_optional(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(row.map(view))
}

/// Reconcile bounded archive-relay state at an explicit clock instant.
///
/// The HTTP handlers pass the current time, while the protected `PostgreSQL`
/// rehearsal supplies a deterministic instant to prove the 24-hour offline,
/// lease-recovery, package-expiry and acknowledged-request cleanup paths on
/// the real schema.  No request selector or package bytes are logged.
///
/// # Errors
///
/// Returns an internal-safe step marker if the reconciliation transaction
/// cannot start, mutate state, or commit.
pub async fn reap_archive_jobs(pool: &sqlx::PgPool, now: i64) -> Result<(), ArchiveReapError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| ArchiveReapError::Database { step: "begin" })?;
    sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='HOST_OFFLINE',updated_at=$1 WHERE state='QUEUED' AND created_at<=$1-$2 AND expires_at>$1").bind(now).bind(duration_ms(Duration::hours(24))).execute(&mut *tx).await.map_err(|_| ArchiveReapError::Database { step: "mark_host_offline" })?;
    sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='QUEUED',claimed_by=NULL,lease_expires_at=0,updated_at=$1 WHERE state IN ('CLAIMED','UPLOADING') AND lease_expires_at<=$1 AND expires_at>$1").bind(now).execute(&mut *tx).await.map_err(|_| ArchiveReapError::Database { step: "recover_expired_lease" })?;
    sqlx::query("UPDATE intelligence_archive_requests_v1 r SET state='QUEUED',updated_at=$1 FROM intelligence_archive_jobs_v1 j WHERE r.job_id=j.job_id AND r.state IN ('CLAIMED','UPLOADING') AND j.state='QUEUED'").bind(now).execute(&mut *tx).await.map_err(|_| ArchiveReapError::Database { step: "recover_request_after_lease" })?;
    // The outbox reference is written before the job drops `object_key`, in
    // this same transaction.  It is therefore impossible for an expiry path
    // to make an S3 package unreachable without leaving durable GC work.
    let expired_objects = sqlx::query_as::<_, (String,)>("SELECT object_key FROM intelligence_archive_jobs_v1 WHERE storage_backend='s3' AND object_key IS NOT NULL AND (expires_at<=$1 OR (content_expires_at>0 AND content_expires_at<=$1)) AND state NOT IN ('PURGED','NOT_FOUND','FAILED') FOR UPDATE")
        .bind(now)
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| ArchiveReapError::Database { step: "find_expired_object" })?;
    for (object_key,) in expired_objects {
        if !valid_archive_object_key(&object_key) {
            return Err(ArchiveReapError::Database {
                step: "invalid_expired_object_key",
            });
        }
        sqlx::query("INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) ON CONFLICT (storage_backend,object_key) DO UPDATE SET state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END,not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at),updated_at=EXCLUDED.updated_at")
            .bind(Uuid::new_v4())
            .bind(object_key)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|_| ArchiveReapError::Database { step: "enqueue_expired_object_gc" })?;
    }
    sqlx::query("UPDATE intelligence_archive_jobs_v1 SET state='REQUEST_EXPIRED',content=NULL,content_sha256=NULL,object_key=NULL,updated_at=$1 WHERE (expires_at<=$1 OR (content_expires_at>0 AND content_expires_at<=$1)) AND state NOT IN ('PURGED','NOT_FOUND','FAILED')").bind(now).execute(&mut *tx).await.map_err(|_| ArchiveReapError::Database { step: "expire_package" })?;
    // Keep each job-to-request transition explicit.  Besides making the
    // allowed request-state set auditable, this avoids treating the job state
    // as a free-form value in a cross-table CASE assignment.
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='PURGED',updated_at=$1 WHERE state NOT IN ('ACKED','PURGED') AND purge_at>0 AND purge_at<=$1")
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ArchiveReapError::Database { step: "purge_due_request" })?;
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='REQUEST_EXPIRED',updated_at=$1 WHERE state NOT IN ('ACKED','PURGED') AND expires_at<=$1")
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ArchiveReapError::Database { step: "expire_request" })?;
    for (job_state, request_state, step) in [
        ("HOST_OFFLINE", "HOST_OFFLINE", "propagate_host_offline"),
        ("NOT_FOUND", "NOT_FOUND", "propagate_not_found"),
        ("FAILED", "FAILED", "propagate_failed"),
        (
            "REQUEST_EXPIRED",
            "REQUEST_EXPIRED",
            "propagate_package_expiry",
        ),
    ] {
        sqlx::query("UPDATE intelligence_archive_requests_v1 r SET state=$1,updated_at=$2 FROM intelligence_archive_jobs_v1 j WHERE r.job_id=j.job_id AND r.state NOT IN ('ACKED','PURGED') AND j.state=$3")
            .bind(request_state)
            .bind(now)
            .bind(job_state)
            .execute(&mut *tx)
            .await
            .map_err(|_| ArchiveReapError::Database { step })?;
    }
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='PURGED',updated_at=$1 WHERE state='ACKED' AND purge_at>0 AND purge_at<=$1").bind(now).execute(&mut *tx).await.map_err(|_| ArchiveReapError::Database { step: "purge_acknowledged_request" })?;
    // Resumable buffers are private staging state.  They must disappear after
    // their explicit TTL even when no client or relay ever returns to resume
    // the upload.  Completed buffers are empty, but deleting their metadata
    // here prevents unbounded terminal rows as well.
    sqlx::query("DELETE FROM intelligence_archive_uploads_v1 WHERE expires_at<=$1")
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ArchiveReapError::Database {
            step: "delete_expired_archive_uploads",
        })?;
    sqlx::query("DELETE FROM intelligence_asset_uploads_v1 WHERE expires_at<=$1")
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ArchiveReapError::Database {
            step: "delete_expired_asset_uploads",
        })?;
    tx.commit()
        .await
        .map_err(|_| ArchiveReapError::Database { step: "commit" })
}

async fn user_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<Value>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, sqlx::types::Json<Value>)>("SELECT request_hash,response FROM intelligence_archive_request_receipts_v1 WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE").bind(user_id).bind(key).fetch_optional(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some((hash, value)) if hash.as_slice() == request_hash => Ok(Some(value.0)),
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}
async fn relay_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    digest: &[u8; 32],
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<Value>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, sqlx::types::Json<Value>)>("SELECT request_hash,response FROM intelligence_archive_relay_receipts_v1 WHERE publisher_token_digest=$1 AND idempotency_key=$2 FOR UPDATE").bind(digest.as_slice()).bind(key).fetch_optional(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some((hash, value)) if hash.as_slice() == request_hash => Ok(Some(value.0)),
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}
async fn store_user_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    key: &str,
    request_hash: [u8; 32],
    response: &ArchiveRequestView,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO intelligence_archive_request_receipts_v1 (user_id,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5)").bind(user_id).bind(key).bind(request_hash.as_slice()).bind(sqlx::types::Json(serde_json::to_value(response).map_err(|_| ApiError::Internal)?)).bind(now_ms()).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}
async fn store_relay_receipt<T: Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    digest: &[u8; 32],
    key: &str,
    request_hash: [u8; 32],
    response: &T,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO intelligence_archive_relay_receipts_v1 (publisher_token_digest,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5)").bind(digest.as_slice()).bind(key).bind(request_hash.as_slice()).bind(sqlx::types::Json(serde_json::to_value(response).map_err(|_| ApiError::Internal)?)).bind(now_ms()).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}
fn normalize(mut selector: ArchiveSelector) -> Option<ArchiveSelector> {
    selector.day = selector.day.filter(|day| {
        day.len() == 10
            && day.as_bytes().iter().enumerate().all(|(idx, b)| {
                matches!(idx, 4 | 7) && *b == b'-' || !matches!(idx, 4 | 7) && b.is_ascii_digit()
            })
    });
    selector.event_id = selector.event_id.filter(|value| valid_id(value));
    selector.series_id = selector.series_id.filter(|value| valid_id(value));
    let count = usize::from(selector.day.is_some())
        + usize::from(selector.event_id.is_some())
        + usize::from(selector.series_id.is_some());
    (count > 0).then_some(selector)
}
fn view(row: RequestRow) -> ArchiveRequestView {
    ArchiveRequestView {
        schema_version: 1,
        request_id: row.request_id.to_string(),
        state: row.state,
        requested_at: format_ms(row.requested_at),
        expires_at: format_ms(row.expires_at),
        request: row.request.0,
        content_sha256: row.content_sha256.map(|value| hex(&value)),
    }
}
fn idempotency_key(headers: &HeaderMap) -> Result<String, ApiError> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::InvalidRequest)?;
    (!key.is_empty()
        && key.len() <= 256
        && key
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' '))
    .then(|| key.to_owned())
    .ok_or(ApiError::InvalidRequest)
}
fn bearer(headers: &HeaderMap) -> Option<SecretString> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| SecretString::from(token.to_owned()))
}
fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn parse_sha256(value: &str) -> Result<[u8; 32], ()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    let mut output = [0_u8; 32];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).map_err(|_| ())?;
    }
    Ok(output)
}
fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("string write");
    }
    output
}
fn canonical(value: &Value) -> Vec<u8> {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().collect();
            let mut result = String::from("{");
            for (index, (key, value)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    result.push(',');
                }
                result.push_str(&serde_json::to_string(key).expect("map key"));
                result.push(':');
                result.push_str(&String::from_utf8(canonical(value)).expect("json"));
            }
            result.push('}');
            result.into_bytes()
        }
        Value::Array(values) => {
            let mut result = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    result.push(',');
                }
                result.push_str(&String::from_utf8(canonical(value)).expect("json"));
            }
            result.push(']');
            result.into_bytes()
        }
        _ => serde_json::to_vec(value).expect("json"),
    }
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}
fn valid_installation_id(value: &str) -> bool {
    valid_id(value) && value.len() <= 256
}
fn valid_archive_object_key(value: &str) -> bool {
    value.starts_with("intelligence/archive/")
        && value.len() <= 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
        && !value.contains("//")
        && !value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
}
fn now_ms() -> i64 {
    i64::try_from(
        OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000)
            .min(i128::from(i64::MAX)),
    )
    .expect("current UNIX milliseconds are in i64 range")
}
fn duration_ms(value: Duration) -> i64 {
    i64::try_from(value.whole_milliseconds()).expect("bounded archive duration")
}
fn format_ms(value: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(value) * 1_000_000)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selector_normalization_is_deterministic_and_rejects_empty() {
        assert!(
            normalize(ArchiveSelector {
                day: None,
                event_id: None,
                series_id: None
            })
            .is_none()
        );
        let selector = normalize(ArchiveSelector {
            day: Some("2030-01-02".into()),
            event_id: Some("event-1".into()),
            series_id: None,
        })
        .unwrap();
        assert_eq!(
            String::from_utf8(canonical(&serde_json::to_value(selector).unwrap())).unwrap(),
            r#"{"day":"2030-01-02","eventId":"event-1"}"#
        );
    }
    #[test]
    fn state_machine_has_bounded_retention_constants() {
        assert_eq!(MAX_WAIT_SECONDS, 25);
        assert_eq!(CLAIM_LEASE, Duration::minutes(5));
        assert_eq!(PACKAGE_TTL, Duration::hours(24));
        assert_eq!(ACK_PURGE_DELAY, Duration::minutes(5));
        assert_eq!(REQUEST_TTL, Duration::days(7));
    }
    #[test]
    fn chunked_relay_upload_is_bounded_and_resumable() {
        assert_eq!(MAX_UPLOAD_CHUNK_BYTES, 1024 * 1024);
        assert_eq!(MAX_ARCHIVE_PACKAGE_BYTES, 128 * 1024 * 1024);
        assert!(parse_sha256(&"a".repeat(64)).is_ok());
        assert!(parse_sha256(&"A".repeat(64)).is_err());
        assert!(parse_sha256("not-a-hash").is_err());
        let migration = include_str!("../migrations/0028_intelligence_resumable_uploads_v1.sql");
        assert!(migration.contains("intelligence_archive_uploads_v1"));
        assert!(migration.contains("UNIQUE REFERENCES intelligence_archive_jobs_v1"));
        assert!(migration.contains("octet_length(content) = received_bytes"));
    }
    #[test]
    fn final_ack_erases_shared_package_only_after_every_retrievable_delivery() {
        let source = include_str!("intelligence_archive.rs");
        let ack = source
            .split("async fn ack_tx")
            .nth(1)
            .and_then(|value| value.split("async fn request_view").next())
            .expect("ack implementation");
        assert!(ack.contains("content=NULL"));
        assert!(ack.contains(
            "state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING','READY','DOWNLOADED')"
        ));
        assert!(ack.contains("state='PURGED'"));
    }
    #[test]
    fn migration_isolated_from_sync_storage_and_has_account_isolation() {
        let sql = include_str!("../migrations/0026_intelligence_archive_relay_v1.sql");
        assert!(!sql.contains("sync_entities_v4"));
        assert!(!sql.contains("sync_assets_v4"));
        assert!(sql.contains("UNIQUE (user_id, request_fingerprint)"));
        assert!(!sql.contains("intelligence:relay"));
        assert!(sql.contains("content_expires_at"));
    }
    #[test]
    fn archive_calendar_wire_shape_has_only_day_and_count() {
        let value = serde_json::to_value(ArchiveCalendarResponse {
            schema_version: 1,
            days: vec![ArchiveCalendarDay {
                day: "2030-01-02".into(),
                entry_count: 3,
            }],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "schemaVersion": 1,
                "days": [{"day": "2030-01-02", "entryCount": 3}]
            })
        );
        assert!(!value.to_string().contains("publication"));
        assert!(!value.to_string().contains("bundle"));
    }

    #[test]
    fn archive_reclaimer_is_independent_and_clears_expired_staging_buffers() {
        let source = include_str!("intelligence_archive.rs");
        assert!(source.contains("pub(crate) fn spawn_reclaimer"));
        assert!(
            source.contains("DELETE FROM intelligence_archive_uploads_v1 WHERE expires_at<=$1")
        );
        assert!(source.contains("DELETE FROM intelligence_asset_uploads_v1 WHERE expires_at<=$1"));
    }
    #[test]
    fn heartbeat_wire_shape_never_contains_relay_content() {
        let value = serde_json::to_value(PublisherHeartbeatResponse {
            schema_version: 1,
            accepted_at: "2030-01-02T03:04:05Z".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "schemaVersion": 1,
                "acceptedAt": "2030-01-02T03:04:05Z"
            })
        );
        assert!(!value.to_string().contains("installation"));
        assert!(!value.to_string().contains("content"));
    }
    #[test]
    fn heartbeat_requires_safe_installation_id_and_relay_credential_checks() {
        assert!(valid_installation_id("publisher-a_1"));
        assert!(!valid_installation_id(""));
        assert!(!valid_installation_id("publisher/a"));
        let source = include_str!("intelligence_archive.rs");
        let relay_check = source
            .split("async fn relay_publisher")
            .nth(1)
            .and_then(|value| value.split("async fn heartbeat_tx").next())
            .unwrap();
        assert!(relay_check.contains("revoked_at=0"));
        assert!(relay_check.contains("intelligence:relay"));
        assert!(relay_check.contains("installation_id"));
    }
    #[test]
    fn object_storage_location_keeps_postgres_fallback_and_rejects_ambiguous_rows() {
        assert_eq!(
            ArchiveStorageLocation::from_columns("postgres", None),
            Some(ArchiveStorageLocation::Postgres)
        );
        assert_eq!(
            ArchiveStorageLocation::from_columns(
                "s3",
                Some("intelligence/archive/job-a/package.tar".into())
            ),
            Some(ArchiveStorageLocation::S3 {
                object_key: "intelligence/archive/job-a/package.tar".into()
            })
        );
        assert!(ArchiveStorageLocation::from_columns("postgres", Some("x".into())).is_none());
        assert!(ArchiveStorageLocation::from_columns("s3", None).is_none());
        assert!(ArchiveStorageLocation::from_columns("s3", Some("../bad".into())).is_none());
    }
    #[test]
    fn archive_reaper_uses_the_shared_object_gc_outbox() {
        let source = include_str!("intelligence_archive.rs");
        let ack = source
            .split("async fn purge_final_archive_delivery_tx")
            .nth(1)
            .and_then(|value| value.split("async fn enqueue_archive_object_gc_tx").next())
            .expect("ack purge state machine");
        assert!(ack.contains("enqueue_archive_object_gc_tx"));
        assert!(ack.contains("object_key=NULL"));
        let reap = source
            .split("pub async fn reap_archive_jobs")
            .nth(1)
            .expect("reaper state machine");
        assert!(reap.contains("enqueue_expired_object_gc"));
        assert!(reap.contains("object_key=NULL"));
    }
}
