//! ADR-0017 entity-version recovery history.
//!
//! The push transaction calls [`record_accepted_versions`] only after LWW has
//! accepted a version.  History therefore never contains rejected conflicts or
//! idempotent retries, and a failed recovery transaction cannot partly alter an
//! account.

use std::{
    collections::BTreeMap,
    io::{Read, Write},
};

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction, types::Json as SqlJson};
use utoipa::ToSchema;

use crate::{
    auth::{authenticate, verify_login_password},
    error::ApiError,
    middleware::RequestContext,
    state::AppState,
    sync::EntityEnvelope,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const RETENTION_DAYS: i64 = 90;
const MAX_ENTITY_BYTES: usize = 1024 * 1024;
const MAX_RESTORE_ENTITIES: usize = 5_000;
const RECOVERY_DEVICE_ID: &str = "server-recovery";

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatusResponse {
    pub ok: bool,
    pub schema_version: i64,
    pub server_time: i64,
    pub data_generation: i64,
    pub retention_days: i64,
    pub available: bool,
    pub enabled_at: i64,
    pub restorable_from: i64,
    pub latest_version_at: i64,
    pub version_count: i64,
    pub compressed_bytes: i64,
    pub uncompressed_bytes: i64,
    pub last_pruned_at: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRestoreRequest {
    #[schema(value_type = String, format = Password)]
    pub password: SecretString,
    pub confirm: bool,
    pub target_at: i64,
    pub data_generation: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRestoreResponse {
    pub ok: bool,
    pub target_at: i64,
    pub restored_at: i64,
    pub restored_entities: i64,
    pub tombstoned_entities: i64,
    pub data_generation: i64,
    pub tokens_revoked: bool,
}

#[derive(Debug, FromRow)]
struct RecoveryAccount {
    enabled_at: i64,
    last_pruned_at: i64,
}

#[derive(Debug, FromRow)]
struct RecoveryStats {
    latest_version_at: Option<i64>,
    version_count: i64,
    compressed_bytes: i64,
    uncompressed_bytes: i64,
}

#[derive(Debug, FromRow)]
struct HistoryRow {
    kind: String,
    entity_id: String,
    compressed_envelope: Vec<u8>,
    uncompressed_bytes: i32,
    envelope_sha256: Vec<u8>,
}

#[derive(Debug, FromRow)]
struct CurrentEntity {
    kind: String,
    entity_id: String,
    envelope: SqlJson<EntityEnvelope>,
}

#[utoipa::path(
    get,
    path = "/v1/sync/recovery/status",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    responses(
        (status = 200, body = RecoveryStatusResponse),
        (status = 401, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn status(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    match recovery_status(&state, &user.id, user.data_generation).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/sync/recovery/restore",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    request_body = RecoveryRestoreRequest,
    responses(
        (status = 200, body = RecoveryRestoreResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn restore(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<RecoveryRestoreRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(mut input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if !input.confirm {
        return ApiError::RecoveryConfirmationRequired.response(context);
    }
    if input.password.expose_secret().is_empty() || input.password.expose_secret().len() > 1024 {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let stored_hash =
        match sqlx::query_scalar::<_, String>("SELECT password_hash FROM users WHERE id=$1")
            .bind(&user.id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(Some(hash)) => hash,
            Ok(None) => return ApiError::Unauthorized.response(context),
            Err(_) => return ApiError::DatabaseUnavailable.response(context),
        };
    let password = std::mem::replace(&mut input.password, SecretString::from(String::new()));
    if let Err(error) = verify_login_password(&state, password, Some(stored_hash)).await {
        return error.response(context);
    }
    match restore_account(&state, &user.id, input).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.response(context),
    }
}

/// Adds complete, zlib-compressed versions for a push that has already won LWW.
///
/// This must run inside the same account-locked transaction as the entity
/// upsert. `accepted` must not contain rejected conflicts or replayed receipts.
pub(crate) async fn record_accepted_versions(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    accepted: &[EntityEnvelope],
    recorded_at: i64,
) -> Result<i64, ApiError> {
    let recoverable = accepted
        .iter()
        .filter(|entity| entity.kind != "secret_bundle_v1")
        .collect::<Vec<_>>();
    if recoverable.is_empty() {
        return Ok(0);
    }
    sqlx::query(
        "INSERT INTO sync_recovery_accounts_v4(user_id,enabled_at,last_pruned_at) \
         VALUES ($1,$2,0) ON CONFLICT (user_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(recorded_at)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    // HTTP requests may accept multiple versions within one wall-clock
    // millisecond. Keep the time-point API deterministic by assigning each
    // accepted batch a strictly increasing server timestamp.
    let previous = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(recorded_at),0) FROM sync_entity_history_v4 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let recorded_at = recorded_at.max(previous.saturating_add(1));
    let mut compressed_bytes = 0_i64;
    for entity in recoverable {
        let encoded = serde_json::to_vec(entity).map_err(|_| ApiError::InvalidRequest)?;
        let uncompressed_bytes =
            i32::try_from(encoded.len()).map_err(|_| ApiError::InvalidRequest)?;
        let compressed_envelope = compress(&encoded)?;
        let compressed_len =
            i64::try_from(compressed_envelope.len()).map_err(|_| ApiError::SyncQuotaExceeded)?;
        compressed_bytes = compressed_bytes
            .checked_add(compressed_len)
            .ok_or(ApiError::SyncQuotaExceeded)?;
        let digest: [u8; 32] = Sha256::digest(&encoded).into();
        sqlx::query(
            "INSERT INTO sync_entity_history_v4 \
             (user_id,kind,entity_id,recorded_at,compressed_envelope,uncompressed_bytes,envelope_sha256) \
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(user_id)
        .bind(&entity.kind)
        .bind(&entity.id)
        .bind(recorded_at)
        .bind(compressed_envelope)
        .bind(uncompressed_bytes)
        .bind(digest.as_slice())
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    prune_history(transaction, user_id, recorded_at).await?;
    Ok(compressed_bytes)
}

async fn recovery_status(
    state: &AppState,
    user_id: &str,
    data_generation: i64,
) -> Result<RecoveryStatusResponse, ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    lock_account(&mut transaction, user_id).await?;
    prune_history(&mut transaction, user_id, now).await?;
    let account = sqlx::query_as::<_, RecoveryAccount>(
        "SELECT enabled_at,last_pruned_at FROM sync_recovery_accounts_v4 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let history = history_stats(&mut transaction, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let available = account.is_some() && history.version_count > 0;
    let enabled_at = account.as_ref().map_or(0, |value| value.enabled_at);
    Ok(RecoveryStatusResponse {
        ok: true,
        schema_version: 1,
        server_time: now,
        data_generation,
        retention_days: RETENTION_DAYS,
        available,
        enabled_at,
        restorable_from: if available {
            enabled_at.max(retention_start(now))
        } else {
            0
        },
        latest_version_at: history.latest_version_at.unwrap_or(0),
        version_count: history.version_count,
        compressed_bytes: history.compressed_bytes,
        uncompressed_bytes: history.uncompressed_bytes,
        last_pruned_at: account.map_or(0, |value| value.last_pruned_at),
    })
}

#[allow(clippy::too_many_lines)]
async fn restore_account(
    state: &AppState,
    user_id: &str,
    input: RecoveryRestoreRequest,
) -> Result<RecoveryRestoreResponse, ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    lock_account(&mut transaction, user_id).await?;
    let generation = sqlx::query_scalar::<_, i64>(
        "SELECT generation FROM account_data_generations WHERE user_id=$1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::Unauthorized)?;
    if generation != input.data_generation {
        return Err(ApiError::DataGenerationMismatch);
    }
    let account = sqlx::query_as::<_, RecoveryAccount>(
        "SELECT enabled_at,last_pruned_at FROM sync_recovery_accounts_v4 WHERE user_id=$1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::RecoveryUnavailable)?;
    let restorable_from = account.enabled_at.max(retention_start(now));
    let latest_version_at = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(recorded_at) FROM sync_entity_history_v4 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::RecoveryUnavailable)?;
    if input.target_at < restorable_from || input.target_at > latest_version_at {
        return Err(ApiError::RecoveryTargetOutOfRange);
    }
    let history = select_target_versions(&mut transaction, user_id, input.target_at).await?;
    if history.is_empty() {
        return Err(ApiError::RecoveryUnavailable);
    }
    if history.len() > MAX_RESTORE_ENTITIES {
        return Err(ApiError::RecoveryEntityLimit);
    }
    let mut restored = BTreeMap::new();
    for row in history {
        let envelope = decode_history(&row)?;
        if envelope.kind != row.kind
            || envelope.id != row.entity_id
            || envelope.kind == "secret_bundle_v1"
        {
            return Err(ApiError::RecoveryHistoryCorrupt);
        }
        restored.insert((row.kind, row.entity_id), envelope);
    }
    let current = sqlx::query_as::<_, CurrentEntity>(
        "SELECT kind,entity_id,envelope FROM sync_entities_v4 \
         WHERE user_id=$1 AND kind<>'secret_bundle_v1' FOR UPDATE",
    )
    .bind(user_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if current.len().max(restored.len()) > MAX_RESTORE_ENTITIES {
        return Err(ApiError::RecoveryEntityLimit);
    }
    let mut existing = BTreeMap::new();
    for item in current {
        existing.insert((item.kind, item.entity_id), item.envelope.0);
    }
    let mut restored_entities = 0_i64;
    let mut tombstoned_entities = 0_i64;
    let mut applied = Vec::new();
    for ((kind, entity_id), mut target) in restored {
        let old = existing.get(&(kind.clone(), entity_id.clone()));
        target.updated_at = now;
        RECOVERY_DEVICE_ID.clone_into(&mut target.device_id);
        target.sync_version = old.map_or(target.sync_version.saturating_add(1), |value| {
            value.sync_version.saturating_add(1)
        });
        if target.deleted_at != 0 {
            target.deleted_at = now;
            tombstoned_entities += 1;
        } else {
            restored_entities += 1;
        }
        upsert_restored(&mut transaction, user_id, &kind, &entity_id, &target).await?;
        applied.push(target);
        existing.remove(&(kind, entity_id));
    }
    for ((kind, entity_id), old) in existing {
        let tombstone = EntityEnvelope {
            id: entity_id.clone(),
            kind: kind.clone(),
            updated_at: now,
            deleted_at: now,
            device_id: RECOVERY_DEVICE_ID.to_owned(),
            sync_version: old.sync_version.saturating_add(1),
            payload: serde_json::json!({}),
            extensions: BTreeMap::new(),
        };
        upsert_restored(&mut transaction, user_id, &kind, &entity_id, &tombstone).await?;
        applied.push(tombstone);
        tombstoned_entities += 1;
    }
    record_accepted_versions(&mut transaction, user_id, &applied, now).await?;
    let next_generation = sqlx::query_scalar::<_, i64>(
        "UPDATE account_data_generations SET generation=generation+1,updated_at=$2 \
         WHERE user_id=$1 RETURNING generation",
    )
    .bind(user_id)
    .bind(now)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("UPDATE auth_sessions_v4 SET revoked_at=$2 WHERE user_id=$1 AND revoked_at=0")
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(RecoveryRestoreResponse {
        ok: true,
        target_at: input.target_at,
        restored_at: now,
        restored_entities,
        tombstoned_entities,
        data_generation: next_generation,
        tokens_revoked: true,
    })
}

async fn lock_account(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user_id)
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn history_stats(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<RecoveryStats, ApiError> {
    sqlx::query_as::<_, RecoveryStats>(
        "SELECT MAX(recorded_at) AS latest_version_at,COUNT(*) AS version_count, \
         COALESCE(SUM(octet_length(compressed_envelope)),0) AS compressed_bytes, \
         COALESCE(SUM(uncompressed_bytes),0) AS uncompressed_bytes \
         FROM sync_entity_history_v4 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn prune_history(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    now: i64,
) -> Result<(), ApiError> {
    let cutoff = retention_start(now);
    sqlx::query(
        "WITH anchors AS ( \
           SELECT DISTINCT ON (kind,entity_id) id FROM sync_entity_history_v4 \
           WHERE user_id=$1 AND recorded_at<$2 \
           ORDER BY kind,entity_id,recorded_at DESC,id DESC \
         ) \
         DELETE FROM sync_entity_history_v4 WHERE user_id=$1 AND recorded_at<$2 \
         AND id NOT IN (SELECT id FROM anchors)",
    )
    .bind(user_id)
    .bind(cutoff)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("UPDATE sync_recovery_accounts_v4 SET last_pruned_at=$2 WHERE user_id=$1")
        .bind(user_id)
        .bind(now)
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn select_target_versions(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    target_at: i64,
) -> Result<Vec<HistoryRow>, ApiError> {
    sqlx::query_as::<_, HistoryRow>(
        "SELECT DISTINCT ON (kind,entity_id) kind,entity_id,compressed_envelope,uncompressed_bytes,envelope_sha256 \
         FROM sync_entity_history_v4 WHERE user_id=$1 AND recorded_at<=$2 \
         ORDER BY kind,entity_id,recorded_at DESC,id DESC",
    )
    .bind(user_id)
    .bind(target_at)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn upsert_restored(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    kind: &str,
    entity_id: &str,
    envelope: &EntityEnvelope,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO sync_entities_v4 \
         (user_id,kind,entity_id,envelope,updated_at,deleted_at,device_id,sync_version) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
         ON CONFLICT (user_id,kind,entity_id) DO UPDATE SET \
         envelope=EXCLUDED.envelope,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at, \
         device_id=EXCLUDED.device_id,sync_version=EXCLUDED.sync_version,server_cursor=nextval('sync_cursor_v4')",
    )
    .bind(user_id)
    .bind(kind)
    .bind(entity_id)
    .bind(SqlJson(envelope))
    .bind(envelope.updated_at)
    .bind(envelope.deleted_at)
    .bind(&envelope.device_id)
    .bind(envelope.sync_version)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

fn compress(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(bytes).map_err(|_| ApiError::Internal)?;
    encoder.finish().map_err(|_| ApiError::Internal)
}

fn decode_history(row: &HistoryRow) -> Result<EntityEnvelope, ApiError> {
    let expected_len =
        usize::try_from(row.uncompressed_bytes).map_err(|_| ApiError::RecoveryHistoryCorrupt)?;
    if expected_len == 0 || expected_len > MAX_ENTITY_BYTES || row.envelope_sha256.len() != 32 {
        return Err(ApiError::RecoveryHistoryCorrupt);
    }
    let mut decoder = ZlibDecoder::new(row.compressed_envelope.as_slice());
    let mut bytes = Vec::with_capacity(expected_len);
    decoder
        .by_ref()
        .take(u64::try_from(MAX_ENTITY_BYTES + 1).expect("small cap"))
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::RecoveryHistoryCorrupt)?;
    if bytes.len() != expected_len
        || Sha256::digest(&bytes).as_slice() != row.envelope_sha256.as_slice()
    {
        return Err(ApiError::RecoveryHistoryCorrupt);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::RecoveryHistoryCorrupt)
}

const fn retention_start(now: i64) -> i64 {
    now.saturating_sub(RETENTION_DAYS * DAY_MS)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_round_trip_keeps_extensions() {
        let source = EntityEnvelope {
            id: "bookmark-1".to_owned(),
            kind: "bookmark".to_owned(),
            updated_at: 1_786_521_600_000,
            deleted_at: 0,
            device_id: "device-a".to_owned(),
            sync_version: 4,
            payload: serde_json::json!({"chapter": 7}),
            extensions: BTreeMap::from([("future".to_owned(), serde_json::json!(true))]),
        };
        let bytes = serde_json::to_vec(&source).expect("serialize");
        let row = HistoryRow {
            kind: source.kind.clone(),
            entity_id: source.id.clone(),
            compressed_envelope: compress(&bytes).expect("compress"),
            uncompressed_bytes: i32::try_from(bytes.len()).expect("small fixture"),
            envelope_sha256: Sha256::digest(&bytes).to_vec(),
        };
        assert_eq!(
            decode_history(&row).expect("decode").extensions,
            source.extensions
        );
    }

    #[test]
    fn corrupt_history_is_rejected_before_restore() {
        let row = HistoryRow {
            kind: "bookmark".to_owned(),
            entity_id: "bookmark-1".to_owned(),
            compressed_envelope: vec![0, 1, 2],
            uncompressed_bytes: 2,
            envelope_sha256: vec![0; 32],
        };
        assert!(matches!(
            decode_history(&row),
            Err(ApiError::RecoveryHistoryCorrupt)
        ));
    }

    #[test]
    fn retention_window_is_ninety_days() {
        assert_eq!(retention_start(100 * DAY_MS), 10 * DAY_MS);
    }
}
