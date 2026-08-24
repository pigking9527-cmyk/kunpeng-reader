//! Independent intelligence-distribution API boundary.  It never uses sync
//! entities or sync assets for public content.

use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    time::Duration as StdDuration,
};

use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use utoipa::{IntoParams, ToSchema};

use crate::{
    auth::authenticate, credentials::intelligence_publisher_token_digest, error::ApiError,
    intelligence_object_outbox, intelligence_object_store::IntelligenceObjectStoreStatus,
    middleware::RequestContext, state::AppState,
};

const THIRTY_DAYS: Duration = Duration::days(30);
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FEED_LIMIT: i64 = 100;
const MAX_ASSET_BYTES: i64 = 25 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES: usize = 1024 * 1024;
const STAGED_ASSET_TTL: Duration = Duration::hours(24);

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub schema_version: u8,
    pub feed_enabled: bool,
    pub server_now: String,
    pub archive: ArchiveAvailability,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAvailability {
    pub available_from: Option<String>,
    pub available_to: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicationUploadResponse {
    pub schema_version: u8,
    pub upload_id: String,
    pub publication_id: String,
    pub complete: bool,
    pub bundle_sha256: String,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetUploadInitInput {
    pub sha256: String,
    pub mime: String,
    pub total_bytes: i64,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadProgress {
    pub schema_version: u8,
    pub upload_id: String,
    pub sha256: String,
    pub total_bytes: i64,
    pub received_bytes: i64,
    pub chunk_bytes: usize,
    pub complete: bool,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetUploadChunkInput {
    pub offset: i64,
    pub content_base64: String,
    pub chunk_sha256: String,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub publication_id: String,
    pub kind: String,
    pub published_at: String,
    pub expires_at: String,
    pub revision_no: i32,
    pub importance: i32,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub schema_version: u8,
    pub items: Vec<FeedItem>,
    pub next_cursor: String,
    pub server_now: String,
}
/// A content-free per-account delivery wake-up. The client must retrieve the
/// actual package through the existing authenticated feed/publication routes.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamDeliveryEvent {
    pub delivery_id: String,
    pub cursor: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesResponse {
    pub schema_version: u8,
    pub topics: Vec<String>,
    pub minimum_importance: i32,
    pub updated_at: String,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesRequest {
    pub schema_version: u8,
    pub topics: Vec<String>,
    pub minimum_importance: i32,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAckResponse {
    pub schema_version: u8,
    pub publication_id: String,
    pub acknowledged_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRequest {
    pub schema_version: u8,
    pub device_id: String,
    pub platform: String,
    #[serde(default)]
    pub quiet_hours: Value,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResponse {
    pub schema_version: u8,
    pub device_id: String,
    pub platform: String,
    pub quiet_hours: Value,
    pub updated_at: String,
}
#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}
#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamQuery {
    pub cursor: Option<i64>,
    /// Optional registered device that owns the persisted resume cursor.
    pub device_id: Option<String>,
}
#[derive(Debug, FromRow)]
struct FeedRow {
    publication_id: String,
    kind: String,
    published_at: i64,
    expires_at: i64,
    revision_no: i32,
    importance: i32,
}
#[derive(Debug, FromRow)]
struct DeliveryEventRow {
    cursor: i64,
    publication_id: String,
    kind: String,
}
#[derive(Debug, FromRow)]
struct CredentialRow {
    installation_id: String,
}
#[derive(Debug, FromRow)]
struct ReceiptRow {
    request_hash: Vec<u8>,
    response: sqlx::types::Json<Value>,
}
#[derive(Debug, FromRow)]
struct DraftRow {
    bundle: sqlx::types::Json<Value>,
    bundle_sha256: Vec<u8>,
}
#[derive(Debug, FromRow)]
struct PreferencesRow {
    topics: Vec<String>,
    minimum_importance: i32,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct DeliveryRow {
    acknowledged_at: i64,
}
#[derive(Debug, FromRow)]
struct DeviceRow {
    device_id: String,
    platform: String,
    quiet_hours: sqlx::types::Json<Value>,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct AssetRow {
    mime: String,
    // PostgreSQL is the required staging copy until a durable S3 outbox PUT
    // succeeds. After promotion migration 0035 deliberately releases that
    // duplicate, so this must stay nullable for S3-backed rows.
    content: Option<Vec<u8>>,
    bytes: i64,
    sha256: String,
    storage_backend: String,
    object_key: Option<String>,
}
#[derive(Debug, FromRow)]
struct AssetUploadRow {
    sha256: String,
    publisher_token_digest: Vec<u8>,
    mime: String,
    total_bytes: i64,
    received_bytes: i64,
    completed_at: i64,
}
#[derive(Debug, FromRow)]
struct AssetUploadCompleteRow {
    sha256: String,
    publisher_token_digest: Vec<u8>,
    mime: String,
    total_bytes: i64,
    received_bytes: i64,
    completed_at: i64,
    content: Vec<u8>,
}
#[derive(Debug, FromRow)]
struct AccountReceiptRow {
    request_hash: Vec<u8>,
    response: sqlx::types::Json<Value>,
}
#[derive(Clone)]
struct PublisherCredential {
    digest: [u8; 32],
    #[allow(dead_code)]
    installation_id: String,
}
struct ValidatedBundle {
    id: String,
    kind: String,
    published_at: i64,
    expires_at: i64,
    issued_at: i64,
    revision_no: i32,
    sha: [u8; 32],
    sha_hex: String,
    assets: Vec<BundleAsset>,
    value: Value,
}
#[derive(Clone)]
struct BundleAsset {
    sha256: String,
    mime: String,
    bytes: i64,
}

#[utoipa::path(get, path = "/v1/intelligence/capabilities", responses((status = 200, body = CapabilitiesResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn capabilities(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    match reader(&state, &headers).await {
        Ok(_) => match archive_availability(&state).await {
            Ok(archive) => capabilities_for_authorized_user(true, archive).into_response(),
            Err(error) => error.response(context),
        },
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/feed", params(FeedQuery), responses((status = 200, body = FeedPage), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn feed(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<FeedQuery>,
) -> Response {
    if let Err(error) = reader(&state, &headers).await {
        return error.response(context);
    }
    let limit = query.limit.unwrap_or(30);
    if !(1..=MAX_FEED_LIMIT).contains(&limit) {
        return ApiError::InvalidRequest.response(context);
    }
    let Ok(cursor) = query.cursor.as_deref().map(decode_cursor).transpose() else {
        return ApiError::InvalidRequest.response(context);
    };
    let now = now_ms();
    let query_result = if let Some((stamp, id)) = cursor {
        sqlx::query_as::<_, FeedRow>("SELECT publication_id,kind,published_at,expires_at,revision_no,importance FROM intelligence_publications_v1 WHERE expires_at>$1 AND (published_at,publication_id)<($2,$3) ORDER BY published_at DESC,publication_id DESC LIMIT $4").bind(now).bind(stamp).bind(id).bind(limit + 1).fetch_all(&state.pool).await
    } else {
        sqlx::query_as::<_, FeedRow>("SELECT publication_id,kind,published_at,expires_at,revision_no,importance FROM intelligence_publications_v1 WHERE expires_at>$1 ORDER BY published_at DESC,publication_id DESC LIMIT $2").bind(now).bind(limit + 1).fetch_all(&state.pool).await
    };
    let Ok(mut rows) = query_result else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    let has_more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
    rows.truncate(usize::try_from(limit).unwrap_or(0));
    let next_cursor = if has_more {
        rows.last().map_or_else(String::new, |row| {
            encode_cursor(row.published_at, &row.publication_id)
        })
    } else {
        String::new()
    };
    Json(FeedPage {
        schema_version: 1,
        items: rows.into_iter().map(feed_item).collect(),
        next_cursor,
        server_now: format_ms(now),
    })
    .into_response()
}

/// Opens a durable-cursor, account-scoped SSE wake-up stream.
///
/// The handler deliberately keeps no subscriber registry: dropping the HTTP
/// body immediately drops the polling task, so reconnects and disconnected
/// clients cannot leak account state or consume a permanent server slot.
#[utoipa::path(
    get,
    path = "/v1/intelligence/stream",
    params(StreamQuery),
    responses(
        (status = 200, description = "text/event-stream delivery wake-ups", body = StreamDeliveryEvent, content_type = "text/event-stream"),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn stream(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let Ok(requested_cursor) = stream_cursor(&headers, query.cursor) else {
        return ApiError::InvalidRequest.response(context);
    };
    let account_id = user.id;
    let device_id = match query.device_id {
        Some(device_id) if valid_id(&device_id) => Some(device_id),
        Some(_) => return ApiError::InvalidRequest.response(context),
        None => None,
    };
    let cursor = match device_id.as_deref() {
        Some(device_id) => match active_device_cursor(&state, &account_id, device_id).await {
            Ok(cursor) => cursor.max(requested_cursor),
            Err(error) => return error.response(context),
        },
        None => requested_cursor,
    };
    let stream = async_stream::stream! {
        let mut next_cursor = cursor;
        let mut ticker = tokio::time::interval(StdDuration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let rows = sqlx::query_as::<_, DeliveryEventRow>(
                "SELECT cursor,publication_id,kind FROM intelligence_delivery_events_v1 WHERE account_id=$1 AND cursor>$2 ORDER BY cursor ASC LIMIT 100",
            )
            .bind(&account_id)
            .bind(next_cursor)
            .fetch_all(&state.pool)
            .await;
            let Ok(rows) = rows else {
                // Do not emit an error payload: an SSE error must not become a
                // side-channel for account, publication, or database state.
                break;
            };
            for row in rows {
                next_cursor = row.cursor;
                let cursor = row.cursor.to_string();
                let payload = StreamDeliveryEvent {
                    // Delivery identity intentionally resolves to an opaque
                    // public package ID only after this account's stream has
                    // passed Bearer and intelligence capability gates.
                    delivery_id: row.publication_id,
                    cursor: cursor.clone(),
                    kind: row.kind,
                };
                let Ok(data) = serde_json::to_string(&payload) else {
                    break;
                };
                yield Ok::<Event, Infallible>(
                    Event::default().event("delivery").id(cursor).data(data),
                );
                if let Some(device_id) = device_id.as_deref()
                    && persist_device_cursor(&state, &account_id, device_id, next_cursor)
                        .await
                        .is_err()
                {
                    break;
                }
            }
        }
    };
    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(StdDuration::from_secs(15))
                .text("keepalive"),
        )
        .into_response()
}

#[utoipa::path(get, path = "/v1/intelligence/publications/{id}", params(("id" = String, Path, description = "publication identifier")), responses((status = 200, description = "immutable PublicationBundleV1"), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn publication(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return ApiError::NotFound.response(context);
    }
    if let Err(error) = reader(&state, &headers).await {
        return error.response(context);
    }
    let bundle = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT bundle FROM intelligence_publications_v1 WHERE publication_id=$1 AND expires_at>$2",
    )
    .bind(id)
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await;
    match bundle {
        Ok(Some(bundle)) => Json(bundle.0).into_response(),
        Ok(None) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/preferences", responses((status = 200, body = PreferencesResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn preferences(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    match sqlx::query_as::<_, PreferencesRow>("SELECT topics,minimum_importance,updated_at FROM intelligence_preferences_v1 WHERE account_id=$1")
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => Json(preferences_response(row)).into_response(),
        Ok(None) => Json(PreferencesResponse {
            schema_version: 1,
            topics: Vec::new(),
            minimum_importance: 0,
            updated_at: format_ms(0),
        }).into_response(),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

#[utoipa::path(put, path = "/v1/intelligence/preferences", request_body = PreferencesRequest, responses((status = 200, body = PreferencesResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn put_preferences(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<PreferencesRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = input else {
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
    if !valid_preferences(&request) {
        return ApiError::InvalidRequest.response(context);
    }
    let request_hash = request_hash(&request);
    match put_preferences_tx(&state, &user.id, &key, request_hash, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/deliveries/{id}/ack", params(("id" = String, Path, description = "published intelligence delivery identifier")), responses((status = 200, body = DeliveryAckResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn acknowledge_delivery(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match reader(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Ok(device_id) = intelligence_device_id(&headers) else {
        return ApiError::InvalidRequest.response(context);
    };
    let request_hash = hash(
        format!(
            "delivery-ack:{id}:{}",
            device_id.as_deref().unwrap_or("account")
        )
        .as_bytes(),
    );
    match acknowledge_delivery_tx(
        &state,
        &user.id,
        &key,
        request_hash,
        &id,
        device_id.as_deref(),
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/devices", request_body = DeviceRequest, responses((status = 200, body = DeviceResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn register_device(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<DeviceRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = input else {
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
    if !valid_device(&request) {
        return ApiError::InvalidRequest.response(context);
    }
    let request_hash = request_hash(&request);
    match register_device_tx(&state, &user.id, &key, request_hash, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(get, path = "/v1/intelligence/assets/{sha256}", params(("sha256" = String, Path, description = "content-addressed image SHA-256")), responses((status = 200, description = "authorized intelligence image"), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn asset(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(sha256): Path<String>,
) -> Response {
    if !valid_sha256(&sha256) {
        return ApiError::NotFound.response(context);
    }
    if let Err(error) = reader(&state, &headers).await {
        return error.response(context);
    }
    let range = headers.get(header::RANGE).cloned();
    let row = sqlx::query_as::<_, AssetRow>(
        "SELECT a.mime,a.content,a.bytes,a.sha256,a.storage_backend,a.object_key FROM intelligence_assets_v1 a WHERE a.sha256=$1 AND a.expires_at>$2 AND EXISTS (SELECT 1 FROM intelligence_publication_asset_refs_v1 r JOIN intelligence_publications_v1 p ON p.publication_id=r.publication_id WHERE r.sha256=a.sha256 AND p.expires_at>$2)",
    )
    .bind(sha256)
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await;
    match row {
        Ok(Some(row)) => {
            let Ok(total) = usize::try_from(row.bytes) else {
                return ApiError::DatabaseUnavailable.response(context);
            };
            if total == 0 || row.bytes > MAX_ASSET_BYTES {
                return ApiError::DatabaseUnavailable.response(context);
            }
            let Ok((start, end, partial)) = image_range(range.as_ref(), total) else {
                return ApiError::InvalidRequest.response(context);
            };
            let Ok(payload) = read_asset_content(&state, &row, total).await else {
                return ApiError::DatabaseUnavailable.response(context);
            };
            let bytes = payload[start..=end].to_vec();
            let mut response = (
                if partial {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                },
                [
                    (header::CONTENT_TYPE, row.mime),
                    (header::CACHE_CONTROL, "private, no-store".to_owned()),
                    (header::CONTENT_LENGTH, bytes.len().to_string()),
                    (header::ACCEPT_RANGES, "bytes".to_owned()),
                ],
                bytes,
            )
                .into_response();
            if partial {
                let value = format!("bytes {start}-{end}/{total}");
                if let Ok(value) = value.parse() {
                    response.headers_mut().insert(header::CONTENT_RANGE, value);
                }
            }
            response
        }
        Ok(None) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

/// Loads the verified image bytes after authorization and expiry checks have
/// completed. S3 objects are always fetched through the injected adapter with
/// a bounded range; object-store transport errors remain internal.
async fn read_asset_content(state: &AppState, row: &AssetRow, total: usize) -> Result<Vec<u8>, ()> {
    let content = match row.storage_backend.as_str() {
        // Disabled installations and pre-object-store rows remain on the
        // PostgreSQL path. Do not silently fall back to this payload for an
        // S3-marked row: that would mask an object-store migration failure.
        "postgres" => row.content.clone().ok_or(())?,
        "s3" => {
            let object_key = row.object_key.clone().ok_or(())?;
            let end = u64::try_from(total.checked_sub(1).ok_or(())?).map_err(|_| ())?;
            let expected_total = u64::try_from(total).map_err(|_| ())?;
            let store = std::sync::Arc::clone(&state.intelligence_object_store);
            let object =
                tokio::task::spawn_blocking(move || store.get_range(&object_key, 0, Some(end)))
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
            if object
                .total_size
                .is_some_and(|actual| actual != expected_total)
            {
                return Err(());
            }
            object.bytes
        }
        _ => return Err(()),
    };
    valid_asset_content(row, total, &content)
        .then_some(content)
        .ok_or(())
}

fn valid_asset_content(row: &AssetRow, total: usize, content: &[u8]) -> bool {
    content.len() == total && hex(&hash(content)) == row.sha256
}

#[utoipa::path(post, path = "/v1/intelligence/uploads/init", request_body = Value, responses((status = 201, body = PublicationUploadResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn init_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(value)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let Ok(bundle) = validate_bundle(value) else {
        return ApiError::InvalidRequest.response(context);
    };
    match init_tx(
        &state,
        &credential,
        &key,
        hash(&canonical(&bundle.value)),
        &bundle,
    )
    .await
    {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err(error) => error.response(context),
    }
}

/// Initializes a content-addressed publication image upload.  Assets are not
/// public at this stage: only a later immutable publication can reference one.
#[utoipa::path(post, path = "/v1/intelligence/assets/init", request_body = AssetUploadInitInput, responses((status = 201, body = AssetUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn init_asset_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<AssetUploadInitInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    if !valid_sha256(&input.sha256)
        || !valid_image_mime(&input.mime)
        || !(1..=MAX_ASSET_BYTES).contains(&input.total_bytes)
    {
        return ApiError::InvalidRequest.response(context);
    }
    match asset_upload_init_tx(&state, &credential, &key, input).await {
        Ok(progress) => (StatusCode::CREATED, Json(progress)).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(put, path = "/v1/intelligence/assets/{sha256}", params(("sha256" = String, Path)), request_body = AssetUploadChunkInput, responses((status = 200, body = AssetUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn upload_asset_chunk(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(sha256): Path<String>,
    input: Result<Json<AssetUploadChunkInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let credential = match publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let Ok(chunk) = STANDARD.decode(input.content_base64.as_bytes()) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_sha256(&sha256)
        || !valid_sha256(&input.chunk_sha256)
        || chunk.is_empty()
        || chunk.len() > MAX_UPLOAD_CHUNK_BYTES
        || input.offset < 0
        || hex(&hash(&chunk)) != input.chunk_sha256
    {
        return ApiError::InvalidRequest.response(context);
    }
    match asset_upload_chunk_tx(&state, &credential, &key, &sha256, input.offset, chunk).await {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/assets/{sha256}/complete", params(("sha256" = String, Path)), responses((status = 200, body = AssetUploadProgress), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn complete_asset_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(sha256): Path<String>,
) -> Response {
    if !valid_sha256(&sha256) {
        return ApiError::InvalidRequest.response(context);
    }
    let credential = match publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    match asset_upload_complete_tx(&state, &credential, &key, &sha256).await {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(post, path = "/v1/intelligence/uploads/{id}/complete", params(("id" = String, Path, description = "publication identifier")), responses((status = 200, body = PublicationUploadResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)), security(("bearer_token" = [])))]
pub async fn complete_upload(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return ApiError::InvalidRequest.response(context);
    }
    let credential = match publisher(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    let key = match idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    match complete_tx(
        &state,
        &credential,
        &key,
        hash(format!("complete:{id}").as_bytes()),
        &id,
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
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
async fn publisher(state: &AppState, headers: &HeaderMap) -> Result<PublisherCredential, ApiError> {
    let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
    let digest = intelligence_publisher_token_digest(&state.token_hmac_key, &token)
        .map_err(|_| ApiError::Unauthorized)?;
    let row = sqlx::query_as::<_, CredentialRow>("SELECT installation_id FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1 AND revoked_at=0 AND expires_at>$2 AND capabilities @> ARRAY['intelligence:publish']::text[]").bind(digest.as_slice()).bind(now_ms()).fetch_optional(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(row) = row {
        return Ok(PublisherCredential {
            digest,
            installation_id: row.installation_id,
        });
    }
    match authenticate(state, headers).await {
        Ok(_) => Err(ApiError::IntelligencePublisherRequired),
        Err(ApiError::Unauthorized) => Err(ApiError::Unauthorized),
        Err(error) => Err(error),
    }
}

async fn init_tx(
    state: &AppState,
    credential: &PublisherCredential,
    key: &str,
    request_hash: [u8; 32],
    bundle: &ValidatedBundle,
) -> Result<PublicationUploadResponse, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(response) = receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(response).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let inserted = sqlx::query("INSERT INTO intelligence_publication_drafts_v1 (publication_id,bundle,bundle_sha256,publisher_token_digest,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (publication_id) DO NOTHING").bind(&bundle.id).bind(sqlx::types::Json(&bundle.value)).bind(bundle.sha.as_slice()).bind(credential.digest.as_slice()).bind(now_ms()).bind(bundle.expires_at).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.rows_affected();
    if inserted == 0 {
        let existing = sqlx::query_as::<_, (Vec<u8>, Vec<u8>)>("SELECT bundle_sha256,publisher_token_digest FROM intelligence_publication_drafts_v1 WHERE publication_id=$1 FOR UPDATE").bind(&bundle.id).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if existing.is_none_or(|(sha, owner)| {
            sha.as_slice() != bundle.sha || owner.as_slice() != credential.digest
        }) {
            return Err(ApiError::IdempotencyKeyReused);
        }
    }
    let response = upload_response(bundle, false);
    store_receipt(&mut tx, &credential.digest, key, request_hash, &response).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}
async fn complete_tx(
    state: &AppState,
    credential: &PublisherCredential,
    key: &str,
    request_hash: [u8; 32],
    id: &str,
) -> Result<PublicationUploadResponse, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(response) = receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(response).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let Some(draft) = sqlx::query_as::<_, DraftRow>("SELECT bundle,bundle_sha256 FROM intelligence_publication_drafts_v1 WHERE publication_id=$1 AND publisher_token_digest=$2 AND expires_at>$3 FOR UPDATE").bind(id).bind(credential.digest.as_slice()).bind(now_ms()).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)? else { return Err(ApiError::NotFound); };
    let bundle = validate_bundle(draft.bundle.0).map_err(|()| ApiError::DatabaseUnavailable)?;
    if draft.bundle_sha256.as_slice() != bundle.sha {
        return Err(ApiError::DatabaseUnavailable);
    }
    // A draft may be created before its images finish uploading, but it can
    // never become visible until every declared content-addressed image is
    // present with the exact MIME type and byte count.  References and the
    // publication become durable together.
    ensure_bundle_assets(&mut tx, &bundle).await?;
    sqlx::query("INSERT INTO intelligence_publications_v1 (publication_id,kind,published_at,expires_at,issued_at,revision_no,importance,bundle,bundle_sha256,publisher_token_digest,completed_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10) ON CONFLICT (publication_id) DO NOTHING").bind(&bundle.id).bind(&bundle.kind).bind(bundle.published_at).bind(bundle.expires_at).bind(bundle.issued_at).bind(bundle.revision_no).bind(sqlx::types::Json(&bundle.value)).bind(bundle.sha.as_slice()).bind(credential.digest.as_slice()).bind(now_ms()).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    for asset in &bundle.assets {
        sqlx::query("INSERT INTO intelligence_publication_asset_refs_v1 (publication_id,sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(&bundle.id).bind(&asset.sha256).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        sqlx::query(
            "UPDATE intelligence_assets_v1 SET expires_at=GREATEST(expires_at,$2) WHERE sha256=$1",
        )
        .bind(&asset.sha256)
        .bind(bundle.expires_at)
        .execute(&mut *tx)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    // This insert is part of the same transaction as publication visibility.
    // A subscriber can therefore never receive a wake-up for a package which
    // the authenticated feed endpoint cannot subsequently read. The table is
    // account scoped and stores only a cursor, package ID and kind.
    record_delivery_events(&mut tx, &bundle).await?;
    sqlx::query("UPDATE intelligence_publication_drafts_v1 SET completed_at=$2 WHERE publication_id=$1 AND completed_at=0").bind(id).bind(now_ms()).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let response = upload_response(&bundle, true);
    store_receipt(&mut tx, &credential.digest, key, request_hash, &response).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}

async fn record_delivery_events(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    bundle: &ValidatedBundle,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO intelligence_delivery_events_v1 (account_id,publication_id,kind,created_at) SELECT id,$1,$2,$3 FROM users WHERE intelligence_feed_enabled=true ON CONFLICT (account_id,publication_id) DO NOTHING",
    )
    .bind(&bundle.id)
    .bind(&bundle.kind)
    .bind(now_ms())
    .execute(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn ensure_bundle_assets(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    bundle: &ValidatedBundle,
) -> Result<(), ApiError> {
    let mut seen = BTreeSet::new();
    for asset in &bundle.assets {
        if !seen.insert(&asset.sha256) {
            continue;
        }
        let row = sqlx::query_as::<_, (String, i64)>("SELECT mime,bytes FROM intelligence_assets_v1 WHERE sha256=$1 AND expires_at>$2 FOR UPDATE")
            .bind(&asset.sha256).bind(now_ms()).fetch_optional(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if row.is_none_or(|(mime, bytes)| mime != asset.mime || bytes != asset.bytes) {
            return Err(ApiError::InvalidRequest);
        }
    }
    Ok(())
}

async fn asset_upload_init_tx(
    state: &AppState,
    credential: &PublisherCredential,
    key: &str,
    input: AssetUploadInitInput,
) -> Result<AssetUploadProgress, ApiError> {
    let request_hash = hash(
        format!(
            "asset-upload-init:{}:{}:{}",
            input.sha256, input.mime, input.total_bytes
        )
        .as_bytes(),
    );
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let persisted = sqlx::query_as::<_, (String, i64)>("SELECT mime,bytes FROM intelligence_assets_v1 WHERE sha256=$1 AND expires_at>$2 FOR UPDATE")
        .bind(&input.sha256).bind(now).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let progress = if let Some((mime, bytes)) = persisted {
        if mime != input.mime || bytes != input.total_bytes {
            return Err(ApiError::IdempotencyKeyReused);
        }
        asset_progress(&input.sha256, input.total_bytes, input.total_bytes, true)
    } else {
        let existing = sqlx::query_as::<_, AssetUploadRow>("SELECT sha256,publisher_token_digest,mime,total_bytes,received_bytes,completed_at FROM intelligence_asset_uploads_v1 WHERE sha256=$1 FOR UPDATE")
            .bind(&input.sha256).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        if let Some(row) = existing {
            if row.publisher_token_digest.as_slice() != credential.digest
                || row.mime != input.mime
                || row.total_bytes != input.total_bytes
            {
                return Err(ApiError::IdempotencyKeyReused);
            }
            asset_progress(
                &row.sha256,
                row.total_bytes,
                row.received_bytes,
                row.completed_at > 0,
            )
        } else {
            sqlx::query("INSERT INTO intelligence_asset_uploads_v1 (sha256,publisher_token_digest,mime,total_bytes,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(&input.sha256).bind(credential.digest.as_slice()).bind(&input.mime).bind(input.total_bytes).bind(now + duration_ms(STAGED_ASSET_TTL)).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
            asset_progress(&input.sha256, input.total_bytes, 0, false)
        }
    };
    store_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}

async fn asset_upload_chunk_tx(
    state: &AppState,
    credential: &PublisherCredential,
    key: &str,
    sha256: &str,
    offset: i64,
    chunk: Vec<u8>,
) -> Result<AssetUploadProgress, ApiError> {
    let request_hash = hash(
        format!(
            "asset-upload-chunk:{sha256}:{offset}:{}",
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
    if let Some(value) = receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let row = sqlx::query_as::<_, AssetUploadRow>("SELECT sha256,publisher_token_digest,mime,total_bytes,received_bytes,completed_at FROM intelligence_asset_uploads_v1 WHERE sha256=$1 AND expires_at>$2 FOR UPDATE")
        .bind(sha256).bind(now).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
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
    sqlx::query("UPDATE intelligence_asset_uploads_v1 SET content=content || $2,received_bytes=$3,updated_at=$4 WHERE sha256=$1")
        .bind(sha256).bind(&chunk).bind(next).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    let progress = asset_progress(sha256, row.total_bytes, next, false);
    store_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}

async fn asset_upload_complete_tx(
    state: &AppState,
    credential: &PublisherCredential,
    key: &str,
    sha256: &str,
) -> Result<AssetUploadProgress, ApiError> {
    let request_hash = hash(format!("asset-upload-complete:{sha256}").as_bytes());
    let now = now_ms();
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(value) = receipt(&mut tx, &credential.digest, key, request_hash).await? {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return serde_json::from_value(value).map_err(|_| ApiError::DatabaseUnavailable);
    }
    let row = sqlx::query_as::<_, AssetUploadCompleteRow>("SELECT sha256,publisher_token_digest,mime,total_bytes,received_bytes,completed_at,content FROM intelligence_asset_uploads_v1 WHERE sha256=$1 AND expires_at>$2 FOR UPDATE")
        .bind(sha256).bind(now).fetch_optional(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.ok_or(ApiError::NotFound)?;
    if row.publisher_token_digest.as_slice() != credential.digest {
        return Err(ApiError::NotFound);
    }
    if row.completed_at == 0 {
        if row.received_bytes != row.total_bytes || hex(&hash(&row.content)) != row.sha256 {
            return Err(ApiError::InvalidRequest);
        }
        sqlx::query("INSERT INTO intelligence_assets_v1 (sha256,mime,content,bytes,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha256) DO NOTHING")
            .bind(&row.sha256).bind(&row.mime).bind(&row.content).bind(row.total_bytes).bind(now + duration_ms(STAGED_ASSET_TTL)).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
        // PostgreSQL remains the immediately readable and authoritative copy.
        // Once S3 is actually configured, enqueue the durable secondary write
        // in the same transaction.  Metadata is only switched to `s3` by the
        // worker after the remote PUT succeeds, so a failed PUT can never
        // publish an object key that does not exist.
        if state.intelligence_object_store_status() == IntelligenceObjectStoreStatus::Configured {
            intelligence_object_outbox::enqueue_asset_write(&mut tx, &row.sha256, now).await?;
        }
        // The staging-table invariant requires `received_bytes` to match the
        // bytea length.  Once the completed payload moves to the durable
        // asset row, clear both values rather than leaving an impossible
        // completed staging row behind.
        sqlx::query("UPDATE intelligence_asset_uploads_v1 SET completed_at=$2,received_bytes=0,content=''::bytea,updated_at=$2 WHERE sha256=$1")
            .bind(&row.sha256).bind(now).execute(&mut *tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    let progress = asset_progress(&row.sha256, row.total_bytes, row.total_bytes, true);
    store_receipt(&mut tx, &credential.digest, key, request_hash, &progress).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(progress)
}

async fn put_preferences_tx(
    state: &AppState,
    account_id: &str,
    key: &str,
    request_hash: [u8; 32],
    request: PreferencesRequest,
) -> Result<PreferencesResponse, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(response) = account_receipt::<PreferencesResponse>(
        &mut tx,
        account_id,
        "preferences.put",
        key,
        request_hash,
    )
    .await?
    {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(response);
    }
    let updated_at = now_ms();
    let row = sqlx::query_as::<_, PreferencesRow>(
        "INSERT INTO intelligence_preferences_v1 (account_id,topics,minimum_importance,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET topics=EXCLUDED.topics,minimum_importance=EXCLUDED.minimum_importance,updated_at=EXCLUDED.updated_at RETURNING topics,minimum_importance,updated_at",
    )
    .bind(account_id)
    .bind(&request.topics)
    .bind(request.minimum_importance)
    .bind(updated_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let response = preferences_response(row);
    store_account_receipt(
        &mut tx,
        account_id,
        "preferences.put",
        key,
        request_hash,
        &response,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}

async fn acknowledge_delivery_tx(
    state: &AppState,
    account_id: &str,
    key: &str,
    request_hash: [u8; 32],
    publication_id: &str,
    device_id: Option<&str>,
) -> Result<DeliveryAckResponse, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(response) = account_receipt::<DeliveryAckResponse>(
        &mut tx,
        account_id,
        "delivery.ack",
        key,
        request_hash,
    )
    .await?
    {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(response);
    }
    if let Some(device_id) = device_id {
        ensure_active_device(&mut tx, account_id, device_id).await?;
    }
    let current = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM intelligence_publications_v1 WHERE publication_id=$1 AND expires_at>$2)",
    )
    .bind(publication_id)
    .bind(now_ms())
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(device_id) = device_id {
        sqlx::query("INSERT INTO intelligence_device_delivery_state_v1 (account_id,device_id,publication_id,acknowledged_at) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id,device_id,publication_id) DO NOTHING")
            .bind(account_id)
            .bind(device_id)
            .bind(publication_id)
            .bind(now_ms())
            .execute(&mut *tx)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    if !current {
        return Err(ApiError::NotFound);
    }
    sqlx::query("INSERT INTO intelligence_delivery_state_v1 (account_id,publication_id,acknowledged_at) VALUES ($1,$2,$3) ON CONFLICT (account_id,publication_id) DO NOTHING")
        .bind(account_id)
        .bind(publication_id)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let row = sqlx::query_as::<_, DeliveryRow>(
        "SELECT acknowledged_at FROM intelligence_delivery_state_v1 WHERE account_id=$1 AND publication_id=$2",
    )
    .bind(account_id)
    .bind(publication_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let response = DeliveryAckResponse {
        schema_version: 1,
        publication_id: publication_id.to_owned(),
        acknowledged_at: format_ms(row.acknowledged_at),
        device_id: device_id.map(str::to_owned),
    };
    store_account_receipt(
        &mut tx,
        account_id,
        "delivery.ack",
        key,
        request_hash,
        &response,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}

async fn register_device_tx(
    state: &AppState,
    account_id: &str,
    key: &str,
    request_hash: [u8; 32],
    request: DeviceRequest,
) -> Result<DeviceResponse, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(response) = account_receipt::<DeviceResponse>(
        &mut tx,
        account_id,
        "devices.register",
        key,
        request_hash,
    )
    .await?
    {
        tx.commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(response);
    }
    let updated_at = now_ms();
    let row = sqlx::query_as::<_, DeviceRow>(
        "INSERT INTO intelligence_devices_v1 (account_id,device_id,platform,quiet_hours,updated_at,revoked_at) VALUES ($1,$2,$3,$4,$5,0) ON CONFLICT (account_id,device_id) DO UPDATE SET platform=EXCLUDED.platform,quiet_hours=EXCLUDED.quiet_hours,updated_at=EXCLUDED.updated_at,revoked_at=0 RETURNING device_id,platform,quiet_hours,updated_at",
    )
    .bind(account_id)
    .bind(&request.device_id)
    .bind(&request.platform)
    .bind(sqlx::types::Json(&request.quiet_hours))
    .bind(updated_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let response = device_response(row);
    store_account_receipt(
        &mut tx,
        account_id,
        "devices.register",
        key,
        request_hash,
        &response,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(response)
}

async fn account_receipt<T: serde::de::DeserializeOwned>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    operation: &str,
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<T>, ApiError> {
    let row = sqlx::query_as::<_, AccountReceiptRow>(
        "SELECT request_hash,response FROM intelligence_account_receipts_v1 WHERE account_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE",
    )
    .bind(account_id)
    .bind(operation)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some(row) if row.request_hash.as_slice() == request_hash => {
            serde_json::from_value(row.response.0)
                .map(Some)
                .map_err(|_| ApiError::DatabaseUnavailable)
        }
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}

async fn store_account_receipt<T: Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    operation: &str,
    key: &str,
    request_hash: [u8; 32],
    response: &T,
) -> Result<(), ApiError> {
    let response = serde_json::to_value(response).map_err(|_| ApiError::Internal)?;
    sqlx::query("INSERT INTO intelligence_account_receipts_v1 (account_id,operation,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(account_id)
        .bind(operation)
        .bind(key)
        .bind(request_hash.as_slice())
        .bind(sqlx::types::Json(response))
        .bind(now_ms())
        .execute(&mut **tx)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}
async fn receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    digest: &[u8; 32],
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<Value>, ApiError> {
    let row = sqlx::query_as::<_, ReceiptRow>("SELECT request_hash,response FROM intelligence_publication_receipts_v1 WHERE publisher_token_digest=$1 AND idempotency_key=$2 FOR UPDATE").bind(digest.as_slice()).bind(key).fetch_optional(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some(row) if row.request_hash.as_slice() == request_hash => Ok(Some(row.response.0)),
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}
async fn store_receipt<T: Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    digest: &[u8; 32],
    key: &str,
    request_hash: [u8; 32],
    response: &T,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO intelligence_publication_receipts_v1 (publisher_token_digest,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5)").bind(digest.as_slice()).bind(key).bind(request_hash.as_slice()).bind(sqlx::types::Json(serde_json::to_value(response).map_err(|_| ApiError::Internal)?)).bind(now_ms()).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}
fn upload_response(bundle: &ValidatedBundle, complete: bool) -> PublicationUploadResponse {
    PublicationUploadResponse {
        schema_version: 1,
        upload_id: bundle.id.clone(),
        publication_id: bundle.id.clone(),
        complete,
        bundle_sha256: bundle.sha_hex.clone(),
    }
}
async fn archive_availability(state: &AppState) -> Result<ArchiveAvailability, ApiError> {
    let (available_from, available_to) = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT MIN(archive_day)::text,MAX(archive_day)::text FROM intelligence_archive_calendar_v1",
    )
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(ArchiveAvailability {
        available_from,
        available_to,
    })
}

fn capabilities_for_authorized_user(
    feed_enabled: bool,
    archive: ArchiveAvailability,
) -> Json<CapabilitiesResponse> {
    if !feed_enabled {
        // `reader` gates this route before the projection is constructed.
        // Keep this fallback structurally impossible rather than fabricating a
        // response that could claim the feed is enabled.
        return Json(CapabilitiesResponse {
            schema_version: 1,
            feed_enabled: false,
            server_now: format_ms(now_ms()),
            archive,
        });
    }
    Json(CapabilitiesResponse {
        schema_version: 1,
        feed_enabled: true,
        server_now: format_ms(now_ms()),
        archive,
    })
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
fn request_hash<T: Serialize>(request: &T) -> [u8; 32] {
    serde_json::to_value(request).map_or_else(
        |_| hash(b"invalid-request"),
        |value| hash(&canonical(&value)),
    )
}
fn valid_preferences(request: &PreferencesRequest) -> bool {
    request.schema_version == 1
        && (0..=100).contains(&request.minimum_importance)
        && request.topics.len() <= 64
        && request.topics.iter().all(|topic| {
            !topic.is_empty() && topic.len() <= 64 && !topic.chars().any(char::is_control)
        })
        && {
            let mut topics = request.topics.clone();
            topics.sort_unstable();
            topics.dedup();
            topics.len() == request.topics.len()
        }
}
fn valid_device(request: &DeviceRequest) -> bool {
    request.schema_version == 1
        && valid_id(&request.device_id)
        && matches!(
            request.platform.as_str(),
            "windows" | "macos" | "linux" | "android" | "ios"
        )
        && request.quiet_hours.is_object()
        && canonical(&request.quiet_hours).len() <= 2048
}
fn preferences_response(row: PreferencesRow) -> PreferencesResponse {
    PreferencesResponse {
        schema_version: 1,
        topics: row.topics,
        minimum_importance: row.minimum_importance,
        updated_at: format_ms(row.updated_at),
    }
}
fn device_response(row: DeviceRow) -> DeviceResponse {
    DeviceResponse {
        schema_version: 1,
        device_id: row.device_id,
        platform: row.platform,
        quiet_hours: row.quiet_hours.0,
        updated_at: format_ms(row.updated_at),
    }
}
fn image_range(
    header: Option<&axum::http::HeaderValue>,
    total: usize,
) -> Result<(usize, usize, bool), ()> {
    if total == 0 {
        return Err(());
    }
    let Some(header) = header else {
        return Ok((0, total - 1, false));
    };
    let value = header.to_str().map_err(|_| ())?;
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    let start: usize = start.parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(total - 1)
    };
    (end >= start).then_some((start, end, true)).ok_or(())
}
fn bearer(headers: &HeaderMap) -> Option<SecretString> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| SecretString::from(token.to_owned()))
}
fn validate_bundle(mut value: Value) -> Result<ValidatedBundle, ()> {
    let (id, kind, published_at, expires_at, issued_at, revision_no, declared, bundle_assets) = {
        let object = value.as_object_mut().ok_or(())?;
        let allowed = [
            "schemaVersion",
            "publicationId",
            "kind",
            "publishedAt",
            "expiresAt",
            "issuedAt",
            "events",
            "assets",
            "bundleSha256",
        ];
        if !object.keys().all(|key| allowed.contains(&key.as_str()))
            || object.get("schemaVersion") != Some(&Value::from(1))
        {
            return Err(());
        }
        let id = string(object, "publicationId", 128)?;
        if !valid_id(&id) {
            return Err(());
        }
        let kind = string(object, "kind", 8)?;
        if kind != "event" && kind != "daily" {
            return Err(());
        }
        let published_at = timestamp(&string(object, "publishedAt", 64)?)?;
        let expires_at = timestamp(&string(object, "expiresAt", 64)?)?;
        let issued_at = timestamp(&string(object, "issuedAt", 64)?)?;
        if expires_at != published_at + THIRTY_DAYS
            || issued_at < published_at
            || issued_at > expires_at
        {
            return Err(());
        }
        let events = object.get("events").and_then(Value::as_array).ok_or(())?;
        if events.is_empty() || events.len() > 30 {
            return Err(());
        }
        let assets = object.get("assets").and_then(Value::as_array).ok_or(())?;
        if assets.len() > 1024 {
            return Err(());
        }
        let (asset_ids, bundle_assets) = validate_assets(assets)?;
        let mut event_ids = BTreeSet::new();
        let revision_no = events.iter().try_fold(1_i32, |max, event| {
            let (event_id, revision) = validate_event(event, &asset_ids)?;
            event_ids
                .insert(event_id)
                .then_some(max.max(revision))
                .ok_or(())
        })?;
        let declared = string(object, "bundleSha256", 64)?;
        if !valid_sha256(&declared) {
            return Err(());
        }
        object.remove("bundleSha256");
        (
            id,
            kind,
            published_at,
            expires_at,
            issued_at,
            revision_no,
            declared,
            bundle_assets,
        )
    };
    let calculated = hash(&canonical(&value));
    let calculated_hex = hex(&calculated);
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        declared.as_bytes(),
        calculated_hex.as_bytes(),
    )) {
        return Err(());
    }
    value
        .as_object_mut()
        .ok_or(())?
        .insert("bundleSha256".to_owned(), Value::String(declared.clone()));
    if canonical(&value).len() > MAX_BUNDLE_BYTES {
        return Err(());
    }
    Ok(ValidatedBundle {
        id,
        kind,
        published_at: millis(published_at)?,
        expires_at: millis(expires_at)?,
        issued_at: millis(issued_at)?,
        revision_no,
        sha: calculated,
        sha_hex: declared,
        assets: bundle_assets,
        value,
    })
}
fn string(object: &serde_json::Map<String, Value>, key: &str, max: usize) -> Result<String, ()> {
    let value = object.get(key).and_then(Value::as_str).ok_or(())?;
    (!value.is_empty() && value.len() <= max)
        .then(|| value.to_owned())
        .ok_or(())
}
fn strict_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, ()> {
    let object = value.as_object().ok_or(())?;
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(object)
        .ok_or(())
}
fn required(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), ()> {
    keys.iter()
        .all(|key| object.contains_key(*key))
        .then_some(())
        .ok_or(())
}
fn validate_assets(assets: &[Value]) -> Result<(BTreeSet<String>, Vec<BundleAsset>), ()> {
    let mut ids = BTreeSet::new();
    let mut bundle_assets = Vec::with_capacity(assets.len());
    for asset in assets {
        let object = strict_object(
            asset,
            &[
                "assetId", "kind", "sha256", "mime", "bytes", "width", "height",
            ],
        )?;
        required(object, &["assetId", "kind", "sha256", "mime", "bytes"])?;
        let id = string(object, "assetId", 128)?;
        let sha = string(object, "sha256", 64)?;
        let mime = string(object, "mime", 32)?;
        if !valid_id(&id)
            || !valid_sha256(&sha)
            || object.get("kind") != Some(&Value::String("image".to_owned()))
            || !valid_image_mime(&mime)
            || !object
                .get("bytes")
                .and_then(Value::as_i64)
                .is_some_and(|bytes| (1..=26_214_400).contains(&bytes))
            || !ids.insert(id)
        {
            return Err(());
        }
        for dimension in ["width", "height"] {
            if object.contains_key(dimension)
                && !object
                    .get(dimension)
                    .and_then(Value::as_i64)
                    .is_some_and(|value| (1..=16_384).contains(&value))
            {
                return Err(());
            }
        }
        bundle_assets.push(BundleAsset {
            sha256: sha,
            mime,
            bytes: object.get("bytes").and_then(Value::as_i64).ok_or(())?,
        });
    }
    Ok((ids, bundle_assets))
}
fn validate_event(event: &Value, asset_ids: &BTreeSet<String>) -> Result<(String, i32), ()> {
    let object = strict_object(
        event,
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
    required(
        object,
        &[
            "eventId",
            "revisionNo",
            "title",
            "occurredAt",
            "blocks",
            "notes",
        ],
    )?;
    let id = string(object, "eventId", 128)?;
    let revision = object
        .get("revisionNo")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or(())?;
    let title = string(object, "title", 512)?;
    if !valid_id(&id) || revision < 1 || contains_model_url(&title) {
        return Err(());
    }
    if let Some(series_id) = object.get("seriesId")
        && !series_id.as_str().is_some_and(valid_id)
    {
        return Err(());
    }
    if !object
        .get("occurredAt")
        .is_some_and(|value| value.is_null() || value.as_str().is_some_and(valid_timestamp))
    {
        return Err(());
    }
    let notes = object.get("notes").and_then(Value::as_array).ok_or(())?;
    let blocks = object.get("blocks").and_then(Value::as_array).ok_or(())?;
    if notes.is_empty() || notes.len() > 512 || blocks.is_empty() || blocks.len() > 1024 {
        return Err(());
    }
    let mut note_ids = BTreeSet::new();
    for note in notes {
        let note_id = validate_note(note)?;
        if !note_ids.insert(note_id) {
            return Err(());
        }
    }
    let mut block_ids = BTreeSet::new();
    for block in blocks {
        let block_id = validate_block(block, &note_ids, asset_ids)?;
        if !block_ids.insert(block_id) {
            return Err(());
        }
    }
    Ok((id, revision))
}
fn validate_note(note: &Value) -> Result<String, ()> {
    let object = strict_object(
        note,
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
    required(
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
    let id = string(object, "noteId", 128)?;
    let source_id = string(object, "sourceId", 128)?;
    let source_sha = string(object, "sourceSha256", 64)?;
    let publisher = string(object, "publisher", 256)?;
    let title = string(object, "title", 2048)?;
    let original_url = string(object, "originalUrl", 4096)?;
    let published_at = string(object, "publishedAt", 64)?;
    let fallback_excerpt = string(object, "fallbackExcerpt", 4096)?;
    if !valid_id(&id)
        || !valid_id(&source_id)
        || !valid_sha256(&source_sha)
        || publisher.is_empty()
        || title.is_empty()
        || !valid_https_url(&original_url)
        || !valid_timestamp(&published_at)
        || fallback_excerpt.is_empty()
    {
        return Err(());
    }
    let paragraphs = object
        .get("paragraphs")
        .and_then(Value::as_array)
        .ok_or(())?;
    if paragraphs.is_empty() || paragraphs.len() > 64 {
        return Err(());
    }
    let mut paragraph_ids = BTreeSet::new();
    for paragraph in paragraphs {
        let paragraph = strict_object(paragraph, &["paragraphId", "sha256"])?;
        required(paragraph, &["paragraphId", "sha256"])?;
        let paragraph_id = string(paragraph, "paragraphId", 128)?;
        let sha = string(paragraph, "sha256", 64)?;
        if !valid_id(&paragraph_id) || !valid_sha256(&sha) || !paragraph_ids.insert(paragraph_id) {
            return Err(());
        }
    }
    Ok(id)
}
fn validate_block(
    block: &Value,
    note_ids: &BTreeSet<String>,
    asset_ids: &BTreeSet<String>,
) -> Result<String, ()> {
    let object = strict_object(block, &["blockId", "segments", "mediaIds", "videoUrl"])?;
    required(object, &["blockId", "segments"])?;
    let id = string(object, "blockId", 128)?;
    if !valid_id(&id) {
        return Err(());
    }
    let segments = object.get("segments").and_then(Value::as_array).ok_or(())?;
    if segments.is_empty() || segments.len() > 128 {
        return Err(());
    }
    for segment in segments {
        let segment = strict_object(segment, &["text", "noteIds"])?;
        required(segment, &["text", "noteIds"])?;
        let text = string(segment, "text", 16_384)?;
        let segment_notes = segment.get("noteIds").and_then(Value::as_array).ok_or(())?;
        if contains_model_url(&text) || segment_notes.is_empty() || segment_notes.len() > 16 {
            return Err(());
        }
        let mut seen = BTreeSet::new();
        for note_id in segment_notes {
            let note_id = note_id.as_str().filter(|id| valid_id(id)).ok_or(())?;
            if !note_ids.contains(note_id) || !seen.insert(note_id) {
                return Err(());
            }
        }
    }
    if let Some(media_ids) = object.get("mediaIds") {
        let media_ids = media_ids.as_array().ok_or(())?;
        if media_ids.len() > 16 {
            return Err(());
        }
        let mut seen = BTreeSet::new();
        for media_id in media_ids {
            let media_id = media_id.as_str().filter(|id| valid_id(id)).ok_or(())?;
            if !asset_ids.contains(media_id) || !seen.insert(media_id) {
                return Err(());
            }
        }
    }
    if let Some(video_url) = object.get("videoUrl")
        && !video_url.as_str().is_some_and(valid_https_url)
    {
        return Err(());
    }
    Ok(id)
}
fn contains_model_url(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("http://") || value.contains("https://") || value.contains("www.")
}
fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://") && !value.chars().any(char::is_whitespace)
}
fn valid_timestamp(value: &str) -> bool {
    timestamp(value).is_ok()
}
fn timestamp(value: &str) -> Result<OffsetDateTime, ()> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| ())
}
fn millis(value: OffsetDateTime) -> Result<i64, ()> {
    i64::try_from(value.unix_timestamp_nanos() / 1_000_000).map_err(|_| ())
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_image_mime(value: &str) -> bool {
    matches!(value, "image/jpeg" | "image/png" | "image/webp")
}
fn asset_progress(
    sha256: &str,
    total_bytes: i64,
    received_bytes: i64,
    complete: bool,
) -> AssetUploadProgress {
    AssetUploadProgress {
        schema_version: 1,
        // Content addressing is the stable resumable upload identifier; no
        // server path or credential is surfaced to the publisher response.
        upload_id: sha256.to_owned(),
        sha256: sha256.to_owned(),
        total_bytes,
        received_bytes,
        chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
        complete,
    }
}
fn hash(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
fn canonical(value: &Value) -> Vec<u8> {
    let mut output = String::new();
    canonical_value(value, &mut output);
    output.into_bytes()
}
fn canonical_value(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("string serializes"));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                canonical_value(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let ordered: BTreeMap<_, _> = values.iter().collect();
            for (index, (key, value)) in ordered.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("key serializes"));
                output.push(':');
                canonical_value(value, output);
            }
            output.push('}');
        }
    }
}
fn feed_item(row: FeedRow) -> FeedItem {
    FeedItem {
        publication_id: row.publication_id,
        kind: row.kind,
        published_at: format_ms(row.published_at),
        expires_at: format_ms(row.expires_at),
        revision_no: row.revision_no,
        importance: row.importance,
    }
}
fn encode_cursor(stamp: i64, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{stamp}\0{id}"))
}
fn decode_cursor(value: &str) -> Result<(i64, String), ()> {
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| ())?;
    let (stamp, id) = decoded.split_once('\0').ok_or(())?;
    let stamp = stamp.parse().map_err(|_| ())?;
    valid_id(id).then(|| (stamp, id.to_owned())).ok_or(())
}
fn stream_cursor(headers: &HeaderMap, query_cursor: Option<i64>) -> Result<i64, ()> {
    // Browser/EventSource reconnects use Last-Event-ID. A query cursor exists
    // for native clients that cannot set that header. Header wins so an
    // automatic reconnect cannot be rewound by a stale query string.
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.parse::<i64>().map_err(|_| ()))
        .transpose()?
        .or(query_cursor)
        .unwrap_or(0);
    (cursor >= 0).then_some(cursor).ok_or(())
}

fn intelligence_device_id(headers: &HeaderMap) -> Result<Option<String>, ()> {
    let Some(value) = headers.get("x-intelligence-device-id") else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| ())?;
    valid_id(value).then(|| Some(value.to_owned())).ok_or(())
}

async fn active_device_cursor(
    state: &AppState,
    account_id: &str,
    device_id: &str,
) -> Result<i64, ApiError> {
    let row = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT c.cursor FROM intelligence_devices_v1 d LEFT JOIN intelligence_device_delivery_cursors_v1 c ON c.account_id=d.account_id AND c.device_id=d.device_id WHERE d.account_id=$1 AND d.device_id=$2 AND d.revoked_at=0",
    )
    .bind(account_id)
    .bind(device_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some(Some(cursor)) => Ok(cursor),
        Some(None) => Ok(0),
        None => Err(ApiError::InvalidRequest),
    }
}

async fn persist_device_cursor(
    state: &AppState,
    account_id: &str,
    device_id: &str,
    cursor: i64,
) -> Result<(), ApiError> {
    let updated = sqlx::query(
        "INSERT INTO intelligence_device_delivery_cursors_v1 (account_id,device_id,cursor,updated_at) SELECT account_id,device_id,$3,$4 FROM intelligence_devices_v1 WHERE account_id=$1 AND device_id=$2 AND revoked_at=0 ON CONFLICT (account_id,device_id) DO UPDATE SET cursor=GREATEST(intelligence_device_delivery_cursors_v1.cursor,EXCLUDED.cursor),updated_at=EXCLUDED.updated_at",
    )
    .bind(account_id)
    .bind(device_id)
    .bind(cursor)
    .bind(now_ms())
    .execute(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    (updated.rows_affected() == 1)
        .then_some(())
        .ok_or(ApiError::InvalidRequest)
}

async fn ensure_active_device(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    device_id: &str,
) -> Result<(), ApiError> {
    let active = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM intelligence_devices_v1 WHERE account_id=$1 AND device_id=$2 AND revoked_at=0)",
    )
    .bind(account_id)
    .bind(device_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    active.then_some(()).ok_or(ApiError::InvalidRequest)
}
fn now_ms() -> i64 {
    millis(OffsetDateTime::now_utc()).unwrap_or(0)
}
fn duration_ms(value: Duration) -> i64 {
    i64::try_from(value.whole_milliseconds()).expect("bounded intelligence duration")
}
fn format_ms(value: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(value) * 1_000_000)
        .ok()
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle() -> Value {
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "publicationId": "daily:2026-08-23:zh-CN",
            "kind": "daily",
            "publishedAt": "2026-08-23T00:00:00Z",
            "expiresAt": "2026-09-22T00:00:00Z",
            "issuedAt": "2026-08-23T00:01:00Z",
            "events": [{
                "eventId": "event-1",
                "revisionNo": 1,
                "title": "Synthetic event",
                "occurredAt": "2026-08-22T12:00:00Z",
                "blocks": [{
                    "blockId": "block-1",
                    "segments": [{"text": "Synthetic cited fact.", "noteIds": ["note-1"]}],
                    "mediaIds": ["image-1"]
                }],
                "notes": [{
                    "noteId": "note-1",
                    "sourceId": "source-1",
                    "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "publisher": "Synthetic publisher",
                    "title": "Synthetic source",
                    "originalUrl": "https://example.invalid/source-1",
                    "publishedAt": "2026-08-22T11:00:00Z",
                    "paragraphs": [{"paragraphId": "paragraph-1", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],
                    "fallbackExcerpt": "Synthetic source evidence."
                }]
            }],
            "assets": [{
                "assetId": "image-1",
                "kind": "image",
                "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "mime": "image/webp",
                "bytes": 1024,
                "width": 640,
                "height": 360
            }]
        });
        let digest = hex(&hash(&canonical(&value)));
        value
            .as_object_mut()
            .unwrap()
            .insert("bundleSha256".to_owned(), Value::String(digest));
        value
    }
    #[test]
    fn bundle_enforces_canonical_hash_and_exact_30_days() {
        let bundle = validate_bundle(bundle()).unwrap();
        assert_eq!(
            bundle.expires_at - bundle.published_at,
            30 * 24 * 60 * 60 * 1000
        );
    }
    #[test]
    fn invalid_hash_or_expiry_is_rejected() {
        let mut wrong = bundle();
        wrong["bundleSha256"] = Value::String("0".repeat(64));
        assert!(validate_bundle(wrong).is_err());
        let mut wrong = bundle();
        wrong["expiresAt"] = Value::String("2026-09-21T00:00:00Z".to_owned());
        assert!(validate_bundle(wrong).is_err());
    }
    #[test]
    fn bundle_rejects_unverifiable_citations_media_and_model_urls() {
        let mut wrong = bundle();
        wrong["events"][0]["blocks"][0]["segments"][0]["noteIds"] =
            serde_json::json!(["missing-note"]);
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());

        let mut wrong = bundle();
        wrong["events"][0]["notes"][0]["paragraphs"] = serde_json::json!([]);
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());

        let mut wrong = bundle();
        wrong["events"][0]["notes"][0]["sourceSha256"] = Value::String("invalid".to_owned());
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());

        let mut wrong = bundle();
        wrong["events"][0]["blocks"][0]["mediaIds"] = serde_json::json!(["missing-image"]);
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());

        let mut wrong = bundle();
        wrong["events"][0]["blocks"][0]["videoUrl"] =
            Value::String("http://video.invalid/demo".to_owned());
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());

        let mut wrong = bundle();
        wrong["events"][0]["blocks"][0]["segments"][0]["text"] =
            Value::String("See HTTPS://untrusted.invalid".to_owned());
        resign(&mut wrong);
        assert!(validate_bundle(wrong).is_err());
    }
    fn resign(value: &mut Value) {
        value.as_object_mut().unwrap().remove("bundleSha256");
        let digest = hex(&hash(&canonical(value)));
        value
            .as_object_mut()
            .unwrap()
            .insert("bundleSha256".to_owned(), Value::String(digest));
    }
    #[test]
    fn opaque_cursor_has_stable_tie_breaker() {
        let encoded = encode_cursor(42, "daily:2026-08-23:zh-CN");
        assert_eq!(
            decode_cursor(&encoded),
            Ok((42, "daily:2026-08-23:zh-CN".to_owned()))
        );
    }
    #[test]
    fn stream_cursor_prefers_last_event_id_and_rejects_negative_values() {
        let mut headers = HeaderMap::new();
        headers.insert("last-event-id", "42".parse().unwrap());
        assert_eq!(stream_cursor(&headers, Some(7)), Ok(42));
        let headers = HeaderMap::new();
        assert_eq!(stream_cursor(&headers, Some(7)), Ok(7));
        assert_eq!(stream_cursor(&headers, Some(-1)), Err(()));
        let mut headers = HeaderMap::new();
        headers.insert("last-event-id", "not-a-cursor".parse().unwrap());
        assert_eq!(stream_cursor(&headers, None), Err(()));
    }

    #[test]
    fn device_identifier_header_is_optional_and_strict() {
        let mut headers = HeaderMap::new();
        assert_eq!(intelligence_device_id(&headers), Ok(None));
        headers.insert("x-intelligence-device-id", "device:alpha".parse().unwrap());
        assert_eq!(
            intelligence_device_id(&headers),
            Ok(Some("device:alpha".to_owned()))
        );
        headers.insert("x-intelligence-device-id", "not allowed".parse().unwrap());
        assert_eq!(intelligence_device_id(&headers), Err(()));
    }

    #[test]
    fn stream_payload_is_content_free_and_delivery_storage_is_account_scoped() {
        let event = StreamDeliveryEvent {
            delivery_id: "daily:2026-08-23:zh-CN".to_owned(),
            cursor: "42".to_owned(),
            kind: "daily".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "deliveryId":"daily:2026-08-23:zh-CN",
                "cursor":"42",
                "kind":"daily"
            })
        );
        let migration = include_str!("../migrations/0029_intelligence_delivery_stream_v1.sql");
        assert!(migration.contains("account_id text NOT NULL REFERENCES users(id)"));
        assert!(migration.contains("ON intelligence_delivery_events_v1 (account_id, cursor)"));
        let columns = migration
            .split("CREATE TABLE intelligence_delivery_events_v1")
            .nth(1)
            .and_then(|value| value.split(");").next())
            .expect("delivery events columns");
        assert!(
            !columns
                .lines()
                .any(|line| line.trim_start().starts_with("title "))
        );
        assert!(
            !columns
                .lines()
                .any(|line| line.trim_start().starts_with("original_url "))
        );
        let source = include_str!("intelligence.rs");
        assert!(source.contains("record_delivery_events(&mut tx, &bundle).await?"));
        assert!(source.contains("WHERE account_id=$1 AND cursor>$2"));
    }

    #[test]
    fn device_delivery_progress_is_scoped_to_registered_devices() {
        let migration =
            include_str!("../migrations/0034_intelligence_device_delivery_state_v1.sql");
        assert!(migration.contains("intelligence_device_delivery_state_v1"));
        assert!(migration.contains("intelligence_device_delivery_cursors_v1"));
        assert!(migration.contains("REFERENCES intelligence_devices_v1(account_id, device_id)"));
        let source = include_str!("intelligence.rs");
        assert!(source.contains("active_device_cursor"));
        assert!(source.contains("persist_device_cursor"));
        assert!(source.contains("ensure_active_device"));
    }
    #[test]
    fn migration_does_not_reuse_sync_storage() {
        let migration = include_str!("../migrations/0024_intelligence_publications_v1.sql");
        assert!(!migration.contains("sync_entities_v4"));
        assert!(!migration.contains("sync_assets_v4"));
        assert!(migration.contains("expires_at = published_at + 2592000000"));
    }

    #[test]
    fn preferences_and_devices_are_bounded_and_canonical_for_idempotency() {
        let preferences = PreferencesRequest {
            schema_version: 1,
            topics: vec!["world".to_owned(), "technology".to_owned()],
            minimum_importance: 60,
        };
        assert!(valid_preferences(&preferences));
        let reordered = PreferencesRequest {
            topics: vec!["technology".to_owned(), "world".to_owned()],
            ..preferences
        };
        assert_ne!(
            request_hash(&reordered),
            request_hash(&PreferencesRequest {
                schema_version: 1,
                topics: vec!["world".to_owned(), "technology".to_owned()],
                minimum_importance: 60,
            })
        );
        assert!(!valid_preferences(&PreferencesRequest {
            schema_version: 1,
            topics: vec!["world".to_owned(), "world".to_owned()],
            minimum_importance: 0,
        }));
        assert!(valid_device(&DeviceRequest {
            schema_version: 1,
            device_id: "device:desktop-1".to_owned(),
            platform: "windows".to_owned(),
            quiet_hours: serde_json::json!({"start":"22:00","end":"07:00"}),
        }));
        assert!(!valid_device(&DeviceRequest {
            schema_version: 1,
            device_id: "device:desktop-1".to_owned(),
            platform: "unknown".to_owned(),
            quiet_hours: Value::Null,
        }));
    }

    #[test]
    fn delivery_asset_migration_is_account_and_content_isolated() {
        let migration = include_str!("../migrations/0025_intelligence_delivery_v1.sql");
        assert!(migration.contains("intelligence_delivery_state_v1"));
        assert!(migration.contains("account_id text NOT NULL REFERENCES users(id)"));
        assert!(migration.contains("intelligence_assets_v1"));
        assert!(migration.contains("intelligence_publication_asset_refs_v1"));
        assert!(!migration.contains("sync_entities_v4"));
        assert!(!migration.contains("sync_assets_v4"));
    }

    #[test]
    fn published_images_require_a_complete_hash_checked_staging_upload() {
        let migration = include_str!("../migrations/0028_intelligence_resumable_uploads_v1.sql");
        assert!(migration.contains("intelligence_asset_uploads_v1"));
        assert!(migration.contains("received_bytes"));
        assert!(migration.contains("octet_length(content) = received_bytes"));
        let bundle = validate_bundle(bundle()).unwrap();
        assert_eq!(bundle.assets.len(), 1);
        assert_eq!(bundle.assets[0].mime, "image/webp");
        assert_eq!(bundle.assets[0].bytes, 1024);
        assert!(valid_image_mime("image/jpeg"));
        assert!(!valid_image_mime("image/gif"));
        let source = include_str!("intelligence.rs");
        let complete = source
            .split("async fn complete_tx")
            .nth(1)
            .and_then(|value| value.split("async fn ensure_bundle_assets").next())
            .expect("publication complete implementation");
        assert!(complete.contains("ensure_bundle_assets"));
        assert!(complete.contains("intelligence_publication_asset_refs_v1"));
    }

    #[test]
    fn enabled_object_storage_uses_a_durable_outbox_before_metadata_switch() {
        let source = include_str!("intelligence.rs");
        let complete = source
            .split("async fn asset_upload_complete_tx")
            .nth(1)
            .and_then(|value| value.split("async fn put_preferences_tx").next())
            .expect("asset complete implementation");
        let migration = include_str!("../migrations/0032_intelligence_object_write_outbox_v1.sql");
        assert!(complete.contains("enqueue_asset_write(&mut tx"));
        assert!(complete.contains("IntelligenceObjectStoreStatus::Configured"));
        assert!(migration.contains("intelligence_object_write_outbox_v1"));
        assert!(migration.contains("REFERENCES intelligence_assets_v1"));
    }

    #[test]
    fn asset_read_uses_declared_location_and_verifies_the_full_payload() {
        let content = b"safe-image".to_vec();
        let row = AssetRow {
            mime: "image/png".to_owned(),
            content: None,
            bytes: i64::try_from(content.len()).expect("small test content"),
            sha256: hex(&hash(&content)),
            storage_backend: "s3".to_owned(),
            object_key: Some("intelligence/assets/test.png".to_owned()),
        };
        assert!(valid_asset_content(&row, content.len(), &content));
        assert!(!valid_asset_content(&row, content.len() - 1, &content));
        assert!(!valid_asset_content(&row, content.len(), b"other-image"));

        let source = include_str!("intelligence.rs");
        let read = source
            .split("async fn read_asset_content")
            .nth(1)
            .and_then(|value| value.split("fn valid_asset_content").next())
            .expect("asset read implementation");
        assert!(read.contains("\"postgres\" => row.content.clone().ok_or(())?"));
        assert!(read.contains("\"s3\" =>"));
        assert!(read.contains("store.get_range(&object_key, 0, Some(end))"));
        assert!(!read.contains("row.content.clone(),\n        \"s3\" => row.content"));
    }

    #[test]
    fn image_ranges_are_single_bounded_byte_ranges() {
        let value = axum::http::HeaderValue::from_static("bytes=2-4");
        assert_eq!(image_range(Some(&value), 8), Ok((2, 4, true)));
        let value = axum::http::HeaderValue::from_static("bytes=6-");
        assert_eq!(image_range(Some(&value), 8), Ok((6, 7, true)));
        let value = axum::http::HeaderValue::from_static("bytes=-3");
        assert!(image_range(Some(&value), 8).is_err());
        let value = axum::http::HeaderValue::from_static("bytes=1-2,4-5");
        assert!(image_range(Some(&value), 8).is_err());
    }
}
