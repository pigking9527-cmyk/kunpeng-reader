//! Authenticated, content-addressed reader-background assets.
//!
//! Entity sync keeps only immutable metadata.  This module accepts a strictly
//! ordered byte prefix per asset and returns only verified, completed content.

use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use metrics::counter;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use std::time::Duration;
use tokio::{
    task::JoinHandle,
    time::{MissedTickBehavior, interval},
};
use utoipa::ToSchema;

use crate::{
    account_mutation, auth::authenticate, error::ApiError, middleware::RequestContext,
    state::AppState, sync::storage_usage_bytes,
};

const MAX_NEW_ASSET_BYTES: i64 = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_ASSETS_PER_ACCOUNT: i64 = 10;
const ACCOUNT_STORAGE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
const DAILY_WRITE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const ORPHAN_GRACE_MS: i64 = 7 * DAY_MS;
const ORPHAN_RECLAIM_INTERVAL: Duration = Duration::from_hours(1);
const ORPHAN_RECLAIM_ACCOUNT_BATCH: i64 = 100;
const PUSH_RECEIPT_RECLAIM_INTERVAL: Duration = Duration::from_mins(5);

fn orphan_cutoff(now: i64) -> i64 {
    now.saturating_sub(ORPHAN_GRACE_MS).max(0)
}

/// Reconciles one account inside the maintenance worker.  A palette deliberately
/// uploads its immutable image before publishing its reference, so this work
/// must not run in asset initialization or the foreground push transaction.
async fn reconcile_orphaned_assets(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    now: i64,
) -> Result<u64, ApiError> {
    let updated = sqlx::query(
        "UPDATE sync_assets_v4 AS asset SET orphaned_at = CASE \
         WHEN EXISTS (SELECT 1 FROM sync_entities_v4 AS entity \
             WHERE entity.user_id=asset.user_id \
               AND entity.kind='reader_palette_v1' \
               AND entity.deleted_at=0 \
               AND entity.envelope->'payload'->>'backgroundAssetId'=asset.asset_id) \
             THEN 0 \
         WHEN asset.orphaned_at=0 THEN $2 \
         ELSE asset.orphaned_at END \
         WHERE asset.user_id=$1",
    )
    .bind(user_id)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .rows_affected();
    let deleted = sqlx::query(
        "DELETE FROM sync_assets_v4 \
         WHERE user_id=$1 AND orphaned_at<>0 AND orphaned_at <= $2",
    )
    .bind(user_id)
    .bind(orphan_cutoff(now))
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .rows_affected();
    // `updated` is intentionally not exported separately because it includes
    // harmless re-confirmations. It remains useful here as a sanity check that
    // the maintenance transaction did inspect the account without exposing an
    // account or asset identifier in metrics.
    let _ = updated;
    Ok(deleted)
}

/// Runs a single bounded maintenance loop.  Receipt cleanup and orphan
/// reconciliation never run in a foreground sync transaction.  Failed work is
/// left untouched and retried on a later tick; account identifiers and asset
/// metadata are deliberately never logged or used as metric labels.
pub(crate) fn spawn_orphan_reclaimer(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut receipt_ticks = interval(PUSH_RECEIPT_RECLAIM_INTERVAL);
        receipt_ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut orphan_ticks = interval(ORPHAN_RECLAIM_INTERVAL);
        orphan_ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = receipt_ticks.tick() => reclaim_expired_push_receipts(&state).await,
                _ = orphan_ticks.tick() => reclaim_orphaned_assets(&state).await,
            }
        }
    })
}

async fn reclaim_expired_push_receipts(state: &AppState) {
    match crate::sync::prune_expired_push_receipts(&state.pool).await {
        Ok(deleted) => {
            counter!("reader_sync_background_maintenance_runs_total", "job" => "push_receipts", "outcome" => "success").increment(1);
            counter!("reader_sync_background_maintenance_items_total", "job" => "push_receipts")
                .increment(deleted);
        }
        Err(_) => {
            counter!("reader_sync_background_maintenance_runs_total", "job" => "push_receipts", "outcome" => "error").increment(1);
        }
    }
}

async fn reclaim_orphaned_assets(app_state: &AppState) {
    match reconcile_orphaned_asset_batch(app_state).await {
        Ok(stats) => {
            counter!("reader_sync_background_maintenance_runs_total", "job" => "orphan_assets", "outcome" => "success").increment(1);
            counter!("reader_sync_background_maintenance_items_total", "job" => "orphan_assets_accounts").increment(stats.accounts);
            counter!("reader_sync_background_maintenance_items_total", "job" => "orphan_assets_deleted").increment(stats.deleted_assets);
            counter!("reader_sync_background_maintenance_items_total", "job" => "orphan_assets_busy").increment(stats.busy_accounts);
        }
        Err(_) => {
            counter!("reader_sync_background_maintenance_runs_total", "job" => "orphan_assets", "outcome" => "error").increment(1);
        }
    }
}

#[derive(Default)]
struct OrphanReclaimStats {
    accounts: u64,
    busy_accounts: u64,
    deleted_assets: u64,
}

async fn reconcile_orphaned_asset_batch(
    app_state: &AppState,
) -> Result<OrphanReclaimStats, ApiError> {
    let now = now_ms();
    let users = sqlx::query_scalar::<_, String>(
        "SELECT asset.user_id FROM sync_assets_v4 AS asset \
         WHERE asset.orphaned_at<>0 OR NOT EXISTS ( \
           SELECT 1 FROM sync_entities_v4 AS entity \
           WHERE entity.user_id=asset.user_id \
             AND entity.kind='reader_palette_v1' \
             AND entity.deleted_at=0 \
             AND entity.envelope->'payload'->>'backgroundAssetId'=asset.asset_id \
         ) GROUP BY asset.user_id ORDER BY asset.user_id LIMIT $1",
    )
    .bind(ORPHAN_RECLAIM_ACCOUNT_BATCH)
    .fetch_all(&app_state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let mut batch = OrphanReclaimStats::default();
    for user_id in users {
        let mut transaction = app_state
            .pool
            .begin()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        match account_mutation::try_lock(&mut transaction, &user_id).await {
            Ok(()) => {
                let deleted = reconcile_orphaned_assets(&mut transaction, &user_id, now).await?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| ApiError::DatabaseUnavailable)?;
                batch.accounts = batch.accounts.saturating_add(1);
                batch.deleted_assets = batch.deleted_assets.saturating_add(deleted);
            }
            Err(ApiError::Busy) => {
                let _ = transaction.rollback().await;
                batch.busy_accounts = batch.busy_accounts.saturating_add(1);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(batch)
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetInitRequest {
    pub asset_id: String,
    pub sha256: String,
    pub mime: String,
    pub byte_size: i64,
    pub data_generation: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssetInitResponse {
    pub complete: bool,
    pub received_bytes: i64,
}

#[derive(Debug, FromRow)]
struct StoredAsset {
    sha256: String,
    mime: String,
    byte_size: i64,
    received_bytes: i64,
    body: Vec<u8>,
    completed_at: i64,
}

#[utoipa::path(
    post,
    path = "/v1/sync/assets/init",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    request_body = AssetInitRequest,
    responses(
        (status = 200, body = AssetInitResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn init(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<AssetInitRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_metadata(&input.asset_id, &input.sha256, &input.mime, input.byte_size) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match initialize_asset(&state, &user.id, input).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    put,
    path = "/v1/sync/assets/{asset_id}",
    params(
        ("asset_id" = String, Path, description = "SHA-256 asset ID"),
        ("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5"),
        ("X-Data-Generation" = i64, Header, description = "Current account generation"),
        ("Content-Range" = String, Header, description = "One sequential byte range")
    ),
    request_body(content = Vec<u8>, content_type = "image/png"),
    responses(
        (status = 204, description = "Chunk durably accepted"),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn upload_chunk(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(asset_id): Path<String>,
    body: Bytes,
) -> Response {
    if !valid_asset_id(&asset_id) || body.is_empty() || body.len() > MAX_CHUNK_BYTES {
        return ApiError::InvalidRequest.response(context);
    }
    let Some(content_type) = header_value(&headers, header::CONTENT_TYPE) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Some(content_range) =
        header_value(&headers, header::CONTENT_RANGE).and_then(parse_content_range)
    else {
        return ApiError::InvalidRequest.response(context);
    };
    let Some(data_generation) =
        header_value(&headers, "x-data-generation").and_then(|value| value.parse::<i64>().ok())
    else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(body_len) = i64::try_from(body.len()) else {
        return ApiError::InvalidRequest.response(context);
    };
    if content_range.len() != body_len {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match append_chunk(
        &state,
        &user.id,
        &asset_id,
        content_type,
        data_generation,
        content_range,
        &body,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    get,
    path = "/v1/sync/assets/{asset_id}",
    params(
        ("asset_id" = String, Path, description = "SHA-256 asset ID"),
        ("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5"),
        ("Range" = String, Header, description = "Requested inclusive byte range")
    ),
    responses(
        (status = 206, description = "Requested image bytes"),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
        (status = 404, body = crate::error::ErrorBody),
        (status = 416, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn download(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(asset_id): Path<String>,
) -> Response {
    if !valid_asset_id(&asset_id) {
        return ApiError::InvalidRequest.response(context);
    }
    let Some(range) = header_value(&headers, header::RANGE).and_then(parse_download_range) else {
        return ApiError::InvalidRequest.response(context);
    };
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match read_range(&state, &user.id, &asset_id, range).await {
        Ok((mime, total, start, end, bytes)) => Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .body(axum::body::Body::from(bytes))
            .unwrap_or_else(|_| ApiError::Internal.response(context)),
        Err(error) => error.response(context),
    }
}

async fn initialize_asset(
    state: &AppState,
    user_id: &str,
    input: AssetInitRequest,
) -> Result<AssetInitResponse, ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    lock_account_assets(&mut transaction, user_id).await?;
    ensure_generation(&mut transaction, user_id, input.data_generation).await?;
    let existing = fetch_asset(&mut transaction, user_id, &input.asset_id).await?;
    if let Some(asset) = existing {
        if asset.sha256 != input.sha256
            || asset.mime != input.mime
            || asset.byte_size != input.byte_size
        {
            return Err(ApiError::InvalidRequest);
        }
        transaction
            .commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(AssetInitResponse {
            complete: asset.completed_at != 0,
            received_bytes: asset.received_bytes,
        });
    }
    if !permits_new_asset(input.byte_size) {
        return Err(ApiError::InvalidRequest);
    }
    // A client uploads all referenced images before it pushes the palette
    // entities.  Do not reclaim seemingly orphaned assets here: doing so would
    // make a multi-palette upload lose earlier bytes before the subsequent
    // entity push can publish their references.
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_assets_v4 WHERE user_id=$1")
            .bind(user_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
    if count >= MAX_ASSETS_PER_ACCOUNT {
        return Err(ApiError::SyncQuotaExceeded);
    }
    sqlx::query(
        "INSERT INTO sync_assets_v4 \
         (user_id,asset_id,sha256,mime,byte_size,received_bytes,body,completed_at,orphaned_at,created_at,updated_at) \
         VALUES ($1,$2,$3,$4,$5,0,''::bytea,0,$6,$6,$6)",
    )
    .bind(user_id)
    .bind(&input.asset_id)
    .bind(&input.sha256)
    .bind(&input.mime)
    .bind(input.byte_size)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(AssetInitResponse {
        complete: false,
        received_bytes: 0,
    })
}

async fn append_chunk(
    state: &AppState,
    user_id: &str,
    asset_id: &str,
    content_type: &str,
    data_generation: i64,
    range: ByteRange,
    bytes: &[u8],
) -> Result<(), ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    lock_account_assets(&mut transaction, user_id).await?;
    ensure_generation(&mut transaction, user_id, data_generation).await?;
    let asset = fetch_asset(&mut transaction, user_id, asset_id)
        .await?
        .ok_or(ApiError::InvalidRequest)?;
    if asset.mime != content_type
        || asset.completed_at != 0
        || range.total != asset.byte_size
        || range.start != asset.received_bytes
        || range.end >= asset.byte_size
    {
        return Err(ApiError::InvalidRequest);
    }
    let completed_at = if range.end + 1 == asset.byte_size {
        now
    } else {
        0
    };
    let new_body = [&asset.body[..], bytes].concat();
    if completed_at != 0
        && (!sha256_matches(&new_body, &asset.sha256)
            || !has_expected_image_magic(&asset.mime, &new_body))
    {
        return Err(ApiError::InvalidRequest);
    }
    let byte_increment = i64::try_from(bytes.len()).map_err(|_| ApiError::InvalidRequest)?;
    enforce_asset_quotas(&mut transaction, user_id, byte_increment).await?;
    sqlx::query(
        "UPDATE sync_assets_v4 SET body=$3,received_bytes=$4,completed_at=$5,updated_at=$6 \
         WHERE user_id=$1 AND asset_id=$2",
    )
    .bind(user_id)
    .bind(asset_id)
    .bind(new_body)
    .bind(range.end + 1)
    .bind(completed_at)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn read_range(
    state: &AppState,
    user_id: &str,
    asset_id: &str,
    range: DownloadRange,
) -> Result<(String, i64, i64, i64, Vec<u8>), ApiError> {
    let asset = sqlx::query_as::<_, StoredAsset>(
        "SELECT sha256,mime,byte_size,received_bytes,body,completed_at \
         FROM sync_assets_v4 WHERE user_id=$1 AND asset_id=$2 AND completed_at<>0",
    )
    .bind(user_id)
    .bind(asset_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::NotFound)?;
    let end = range.end.unwrap_or(asset.byte_size.saturating_sub(1));
    if range.start >= asset.byte_size || end < range.start || end >= asset.byte_size {
        return Err(ApiError::InvalidRequest);
    }
    let start = usize::try_from(range.start).map_err(|_| ApiError::InvalidRequest)?;
    let end_exclusive = usize::try_from(end + 1).map_err(|_| ApiError::InvalidRequest)?;
    Ok((
        asset.mime,
        asset.byte_size,
        range.start,
        end,
        asset.body[start..end_exclusive].to_vec(),
    ))
}

async fn lock_account_assets(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<(), ApiError> {
    // Share the non-queueing account mutation gate with entities and reset so
    // asset chunks cannot consume every write slot behind one account.
    account_mutation::try_lock(transaction, user_id).await
}

async fn ensure_generation(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    expected: i64,
) -> Result<(), ApiError> {
    let actual = sqlx::query_scalar::<_, i64>(
        "SELECT generation FROM account_data_generations WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::Unauthorized)?;
    if actual == expected {
        Ok(())
    } else {
        Err(ApiError::DataGenerationMismatch)
    }
}

async fn fetch_asset(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    asset_id: &str,
) -> Result<Option<StoredAsset>, ApiError> {
    sqlx::query_as::<_, StoredAsset>(
        "SELECT sha256,mime,byte_size,received_bytes,body,completed_at \
         FROM sync_assets_v4 WHERE user_id=$1 AND asset_id=$2 FOR UPDATE",
    )
    .bind(user_id)
    .bind(asset_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn enforce_asset_quotas(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    increment: i64,
) -> Result<(), ApiError> {
    // This is a point lookup against the transactionally maintained ledger,
    // rather than three account-wide SUM scans for every asset chunk.
    let combined_bytes = storage_usage_bytes(&mut **transaction, user_id).await?;
    if combined_bytes.saturating_add(increment) > ACCOUNT_STORAGE_QUOTA_BYTES {
        return Err(ApiError::SyncQuotaExceeded);
    }
    let day = now_ms().div_euclid(DAY_MS);
    let (_, accepted_bytes) = sqlx::query_as::<_, (i64, i64)>(
        "INSERT INTO account_daily_usage_v4(user_id,utc_day,accepted_entities,accepted_bytes) \
         VALUES ($1,$2,0,$3) ON CONFLICT(user_id,utc_day) DO UPDATE SET \
         accepted_bytes=account_daily_usage_v4.accepted_bytes+EXCLUDED.accepted_bytes \
         RETURNING accepted_entities,accepted_bytes",
    )
    .bind(user_id)
    .bind(day)
    .bind(increment)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if accepted_bytes > DAILY_WRITE_QUOTA_BYTES {
        return Err(ApiError::SyncQuotaExceeded);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ByteRange {
    start: i64,
    end: i64,
    total: i64,
}

impl ByteRange {
    const fn len(self) -> i64 {
        self.end - self.start + 1
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DownloadRange {
    start: i64,
    end: Option<i64>,
}

fn valid_metadata(asset_id: &str, sha256: &str, mime: &str, byte_size: i64) -> bool {
    valid_asset_id(asset_id)
        && asset_id == sha256
        && valid_mime(mime)
        && permits_new_asset(byte_size)
}

const fn permits_new_asset(byte_size: i64) -> bool {
    byte_size > 0 && byte_size <= MAX_NEW_ASSET_BYTES
}

fn valid_asset_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_mime(value: &str) -> bool {
    matches!(
        value,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

fn header_value(headers: &HeaderMap, name: impl axum::http::header::AsHeaderName) -> Option<&str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

fn parse_content_range(value: &str) -> Option<ByteRange> {
    let (unit, range) = value.split_once(' ')?;
    if unit != "bytes" {
        return None;
    }
    let (bounds, total) = range.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    let range = ByteRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
        total: total.parse().ok()?,
    };
    (range.start >= 0 && range.end >= range.start && range.total > range.end).then_some(range)
}

fn parse_download_range(value: &str) -> Option<DownloadRange> {
    let bounds = value.strip_prefix("bytes=")?;
    if bounds.contains(',') {
        return None;
    }
    let (start, end) = bounds.split_once('-')?;
    let range = DownloadRange {
        start: start.parse().ok()?,
        end: (!end.is_empty()).then(|| end.parse().ok()).flatten(),
    };
    (range.start >= 0).then_some(range)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

fn sha256_matches(bytes: &[u8], expected_lower_hex: &str) -> bool {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    expected_lower_hex.len() == digest.len() * 2
        && digest.iter().enumerate().all(|(index, byte)| {
            expected_lower_hex.as_bytes()[index * 2] == HEX[usize::from(byte >> 4)]
                && expected_lower_hex.as_bytes()[index * 2 + 1] == HEX[usize::from(byte & 0x0f)]
        })
}

fn has_expected_image_magic(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_metadata_is_content_addressed_and_bounded() {
        let id = "a".repeat(64);
        assert!(valid_metadata(&id, &id, "image/png", 1));
        assert!(!valid_metadata(
            &id.to_ascii_uppercase(),
            &id,
            "image/png",
            1
        ));
        assert!(!valid_metadata(&id, &id, "image/svg+xml", 1));
        assert!(valid_metadata(&id, &id, "image/png", MAX_NEW_ASSET_BYTES));
        assert!(!valid_metadata(
            &id,
            &id,
            "image/png",
            MAX_NEW_ASSET_BYTES + 1
        ));
        assert!(permits_new_asset(MAX_NEW_ASSET_BYTES));
        assert!(!permits_new_asset(MAX_NEW_ASSET_BYTES + 1));
    }

    #[test]
    fn asset_upload_daily_budget_matches_the_account_storage_budget() {
        assert_eq!(DAILY_WRITE_QUOTA_BYTES, ACCOUNT_STORAGE_QUOTA_BYTES);
    }

    #[test]
    fn orphan_reclamation_waits_seven_full_days() {
        assert_eq!(orphan_cutoff(ORPHAN_GRACE_MS - 1), 0);
        assert_eq!(orphan_cutoff(ORPHAN_GRACE_MS), 0);
        assert_eq!(orphan_cutoff(ORPHAN_GRACE_MS + 1), 1);
    }

    #[test]
    fn strict_content_ranges_cannot_skip_or_reverse_bytes() {
        assert_eq!(
            parse_content_range("bytes 0-1048575/2097152"),
            Some(ByteRange {
                start: 0,
                end: 1_048_575,
                total: 2_097_152
            })
        );
        assert_eq!(parse_content_range("bytes 1-0/2"), None);
        assert_eq!(parse_content_range("bytes 0-2/2"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
    }

    #[test]
    fn single_download_range_rejects_multiple_and_suffix_forms() {
        assert_eq!(
            parse_download_range("bytes=2-"),
            Some(DownloadRange {
                start: 2,
                end: None
            })
        );
        assert_eq!(
            parse_download_range("bytes=2-4"),
            Some(DownloadRange {
                start: 2,
                end: Some(4)
            })
        );
        assert_eq!(parse_download_range("bytes=2-4,8-9"), None);
        assert_eq!(parse_download_range("bytes=-4"), None);
    }

    #[test]
    fn chunk_length_matches_inclusive_range() {
        assert_eq!(
            ByteRange {
                start: 3,
                end: 5,
                total: 8
            }
            .len(),
            3
        );
    }

    #[test]
    fn final_bytes_must_match_the_declared_image_format() {
        assert!(has_expected_image_magic("image/png", b"\x89PNG\r\n\x1a\n"));
        assert!(has_expected_image_magic("image/jpeg", b"\xff\xd8\xff\xe0"));
        assert!(has_expected_image_magic("image/gif", b"GIF89a"));
        assert!(has_expected_image_magic(
            "image/webp",
            b"RIFF\x00\x00\x00\x00WEBP"
        ));
        assert!(!has_expected_image_magic("image/png", b"not a png"));
    }
}
