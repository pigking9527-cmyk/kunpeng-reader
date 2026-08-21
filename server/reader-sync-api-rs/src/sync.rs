use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    time::Instant,
};

use axum::{
    Extension, Json,
    extract::{Query, RawQuery, State, rejection::JsonRejection},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{
    Acquire, FromRow, PgConnection, PgPool, Postgres, QueryBuilder, Transaction,
    types::Json as SqlJson,
};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    account_mutation,
    auth::{
        AuthenticatedConnection, authenticate, authenticate_with_connection, verify_login_password,
    },
    error::ApiError,
    middleware::RequestContext,
    rate_limit::{check_data_reset_limits, check_secret_reset_limits},
    state::AppState,
};

const MIN_EPOCH_MILLIS: i64 = 946_684_800_000;
const MAX_EPOCH_MILLIS: i64 = 4_102_444_800_000;
const MAX_ENTITY_ID_BYTES: usize = 256;
const MAX_KIND_BYTES: usize = 96;
const MAX_DEVICE_ID_BYTES: usize = 128;
const MAX_PUSH_ENTITIES: usize = 5_000;
const MAX_PULL_ENTITIES: i64 = 5_000;
const MAX_PULL_RESPONSE_BYTES: i64 = 4 * 1024 * 1024;
const CHECKPOINT_SNAPSHOT_SQL: &str =
    "SELECT generation,server_cursor FROM account_data_generations WHERE user_id=$1";
const PUSH_PREFLIGHT_SQL: &str = "SELECT generation.generation,receipt.request_hash,receipt.response \
     FROM account_data_generations AS generation \
     LEFT JOIN sync_push_receipts_v4 AS receipt \
       ON receipt.user_id=generation.user_id AND receipt.mutation_id=$2 \
      AND receipt.created_at >= $3 \
     WHERE generation.user_id=$1";
const APPLY_QUOTAS_SQL: &str = "WITH usage AS ( \
       INSERT INTO account_daily_usage_v4(user_id,utc_day,accepted_entities,accepted_bytes) \
       VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,utc_day) DO UPDATE SET \
       accepted_entities=account_daily_usage_v4.accepted_entities+EXCLUDED.accepted_entities, \
       accepted_bytes=account_daily_usage_v4.accepted_bytes+EXCLUDED.accepted_bytes \
       RETURNING accepted_entities,accepted_bytes \
     ) \
     SELECT storage.entity_bytes+storage.asset_bytes AS total_bytes, \
            usage.accepted_entities,usage.accepted_bytes \
     FROM account_storage_usage_v5 AS storage CROSS JOIN usage \
     WHERE storage.user_id=$1";
const MAX_ENTITY_BYTES: usize = 1024 * 1024;
const MAX_READER_BACKGROUND_ASSET_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PUSH_BYTES: usize = 4 * 1024 * 1024;
const PUSH_RECEIPT_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const PUSH_RECEIPT_PRUNE_BATCH_ROWS: i64 = 2_000;
const ACCOUNT_STORAGE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
const DAILY_WRITE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
// A newly linked desktop library can legitimately contain several thousand
// small metadata entities before its first successful upload.  Keep a firm
// per-day entity cap for abuse control, but leave enough headroom for that
// one-time catch-up; the independent 25 MiB byte budget remains the primary
// daily bandwidth guard.
const DAILY_WRITE_QUOTA_ENTITIES: i64 = 10_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const APP_SETTINGS_KIND: &str = "app_settings_v1";
const APP_SETTINGS_ID: &str = "default";
const RETIRED_JUMP_BACK_SIZE_LEVEL: &str = "readerJumpBackSizeLevel";
const JUMP_BACK_ICON_SIZE_PX: &str = "readerJumpBackIconSizePx";
const MIN_JUMP_BACK_ICON_SIZE_PX: i64 = 30;
const MAX_JUMP_BACK_ICON_SIZE_PX: i64 = 160;
const INVENTORY_KINDS: &[&str] = &[
    "reading_progress_v1",
    "reading_data_v1",
    "reading_statistics_v1",
    "model_book_tags_v1",
    "user_book_tags_v1",
    "book_collections_v1",
    "booklist_v1",
    "vocab",
    "reading_bucket_v2",
    "ai_reader_history_entry_v2",
    "reader_palette_v1",
    "reader_palette_order_v1",
    "app_settings_v1",
    "reading_handoff_v1",
    "news_subscriptions_v1",
];

fn record_sync_database_query(operation: &'static str, started: Instant) {
    metrics::histogram!("reader_sync_database_query_seconds", "operation" => operation)
        .record(started.elapsed().as_secs_f64());
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityEnvelope {
    pub id: String,
    pub kind: String,
    pub updated_at: i64,
    pub deleted_at: i64,
    pub device_id: String,
    pub sync_version: i64,
    pub payload: Value,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub mutation_id: Uuid,
    pub data_generation: i64,
    pub entities: Vec<EntityEnvelope>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub ok: bool,
    pub data_generation: i64,
    pub mutation_id: Uuid,
    pub accepted: Vec<EntityEnvelope>,
    pub conflicts: Vec<EntityEnvelope>,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullQuery {
    #[serde(default)]
    pub cursor: i64,
    #[serde(default = "default_pull_limit")]
    pub limit: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub ok: bool,
    pub data_generation: i64,
    pub cursor: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub entities: Vec<EntityEnvelope>,
    pub request_id: Uuid,
}

/// A lightweight, account-scoped synchronization checkpoint.
///
/// This is deliberately not an inventory digest: a client may only skip its
/// full inventory/reconcile repair pass when it has no pending local writes
/// and the exact cursor it previously applied equals `server_cursor`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointQuery {
    pub data_generation: i64,
    #[serde(default)]
    pub cursor: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResponse {
    pub ok: bool,
    pub data_generation: i64,
    pub cursor: i64,
    pub server_cursor: i64,
    pub caught_up: bool,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InventoryResponse {
    pub ok: bool,
    pub server_time: i64,
    pub data_generation: i64,
    pub kinds: Vec<String>,
    pub entity_count: usize,
    pub inventory_digest: String,
    pub revision: String,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileRequest {
    pub data_generation: i64,
    pub kinds: Vec<String>,
    pub manifest: Vec<ManifestEntry>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub kind: String,
    pub id: String,
    pub updated_at: i64,
    pub deleted_at: i64,
    pub device_id: String,
    pub sync_version: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResponse {
    pub ok: bool,
    pub server_time: i64,
    pub data_generation: i64,
    pub kinds: Vec<String>,
    pub entity_count: usize,
    pub inventory_digest: String,
    pub revision: String,
    pub upload: Vec<EntityKey>,
    pub entities: Vec<EntityEnvelope>,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EntityKey {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretBundleStateResponse {
    pub ok: bool,
    pub secret_bundle_epoch: u64,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataResetRequest {
    #[schema(value_type = String, format = Password)]
    pub password: SecretString,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataResetResponse {
    pub ok: bool,
    pub data_generation: i64,
    pub tokens_revoked: bool,
    pub request_id: Uuid,
}

#[derive(Debug, FromRow)]
struct StoredEntity {
    envelope: SqlJson<EntityEnvelope>,
    server_cursor: i64,
}

/// One account row is always returned by the pull query, including when no
/// entities have changed since the supplied cursor.
#[derive(Debug, FromRow)]
struct PullCandidateRow {
    generation: i64,
    envelope: Option<SqlJson<EntityEnvelope>>,
    server_cursor: Option<i64>,
    envelope_bytes: Option<i64>,
}

#[derive(Debug, FromRow)]
struct CheckpointRow {
    generation: i64,
    server_cursor: i64,
}

/// One account row is returned even when no inventory entity matches.  Keeping
/// the optional projection separate from `InventoryMetadataRow` makes the
/// empty inventory use the same query and snapshot as a populated one.
#[derive(Debug, FromRow)]
struct InventoryMetadataCandidateRow {
    generation: i64,
    kind: Option<String>,
    entity_id: Option<String>,
    updated_at: Option<i64>,
    deleted_at: Option<i64>,
    device_id: Option<String>,
    sync_version: Option<i64>,
    server_cursor: Option<i64>,
}

#[derive(Debug, FromRow)]
struct StoredEntityKey {
    kind: String,
    entity_id: String,
    envelope: SqlJson<EntityEnvelope>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredPushResult {
    data_generation: i64,
    accepted: Vec<EntityEnvelope>,
    conflicts: Vec<EntityEnvelope>,
}

#[derive(Debug, FromRow)]
struct StoredPushReceipt {
    request_hash: Vec<u8>,
    response: SqlJson<StoredPushResult>,
}

#[derive(Debug, FromRow)]
struct PushPreflightRow {
    generation: i64,
    request_hash: Option<Vec<u8>>,
    response: Option<SqlJson<StoredPushResult>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EntityValidationError {
    #[error("entity id is invalid")]
    InvalidId,
    #[error("entity kind is invalid")]
    InvalidKind,
    #[error("legacy AI history arrays are not writable in protocol v5")]
    LegacyAiHistory,
    #[error("updated_at must be a canonical epoch-millisecond value")]
    InvalidUpdatedAt,
    #[error("deleted_at must be zero or a canonical epoch-millisecond value")]
    InvalidDeletedAt,
    #[error("device id is invalid")]
    InvalidDeviceId,
    #[error("sync version must be positive")]
    InvalidSyncVersion,
    #[error("payload must be a JSON object")]
    InvalidPayload,
    #[error("retired jump-back size level is not writable")]
    RetiredJumpBackSizeLevel,
    #[error("jump-back icon size must be an integer between 30 and 160 pixels")]
    InvalidJumpBackIconSizePx,
}

impl EntityEnvelope {
    /// Validates the protocol-v5 envelope without changing or dropping fields.
    ///
    /// # Errors
    ///
    /// Returns the first invalid protocol boundary found in the envelope.
    pub fn validate_v5(&self) -> Result<(), EntityValidationError> {
        if self.id.is_empty() || self.id.len() > MAX_ENTITY_ID_BYTES {
            return Err(EntityValidationError::InvalidId);
        }
        if self.kind.is_empty() || self.kind.len() > MAX_KIND_BYTES {
            return Err(EntityValidationError::InvalidKind);
        }
        if self.kind == "ai_reader_history_v1" {
            return Err(EntityValidationError::LegacyAiHistory);
        }
        if !canonical_epoch_millis(self.updated_at) {
            return Err(EntityValidationError::InvalidUpdatedAt);
        }
        if self.deleted_at != 0 && !canonical_epoch_millis(self.deleted_at) {
            return Err(EntityValidationError::InvalidDeletedAt);
        }
        if self.device_id.is_empty() || self.device_id.len() > MAX_DEVICE_ID_BYTES {
            return Err(EntityValidationError::InvalidDeviceId);
        }
        if self.sync_version < 1 {
            return Err(EntityValidationError::InvalidSyncVersion);
        }
        if !self.payload.is_object() {
            return Err(EntityValidationError::InvalidPayload);
        }
        self.validate_reader_palette_background()?;
        self.validate_v5_settings_payload()?;
        Ok(())
    }

    fn validate_reader_palette_background(&self) -> Result<(), EntityValidationError> {
        if self.kind != "reader_palette_v1" || self.deleted_at != 0 {
            return Ok(());
        }
        let payload = self
            .payload
            .as_object()
            .expect("payload object was checked before palette validation");
        let Some(byte_size) = payload.get("backgroundAssetBytes") else {
            return Ok(());
        };
        byte_size
            .as_u64()
            .filter(|size| (1..=MAX_READER_BACKGROUND_ASSET_BYTES).contains(size))
            .map(|_| ())
            .ok_or(EntityValidationError::InvalidPayload)
    }

    fn validate_v5_settings_payload(&self) -> Result<(), EntityValidationError> {
        if self.kind != APP_SETTINGS_KIND || self.id != APP_SETTINGS_ID {
            return Ok(());
        }
        let payload = self
            .payload
            .as_object()
            .expect("payload object was checked before settings validation");
        if payload.contains_key(RETIRED_JUMP_BACK_SIZE_LEVEL) {
            return Err(EntityValidationError::RetiredJumpBackSizeLevel);
        }
        let Some(size) = payload
            .get(JUMP_BACK_ICON_SIZE_PX)
            .and_then(serde_json::Value::as_i64)
        else {
            return Err(EntityValidationError::InvalidJumpBackIconSizePx);
        };
        if !(MIN_JUMP_BACK_ICON_SIZE_PX..=MAX_JUMP_BACK_ICON_SIZE_PX).contains(&size) {
            return Err(EntityValidationError::InvalidJumpBackIconSizePx);
        }
        Ok(())
    }

    #[must_use]
    pub fn lww_order(&self, other: &Self) -> Ordering {
        (self.updated_at, self.sync_version, self.device_id.as_str()).cmp(&(
            other.updated_at,
            other.sync_version,
            other.device_id.as_str(),
        ))
    }
}

#[must_use]
pub fn incoming_wins(current: &EntityEnvelope, incoming: &EntityEnvelope) -> bool {
    incoming.lww_order(current).is_gt()
}

#[utoipa::path(
    post,
    path = "/v1/sync/data/reset",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    request_body = DataResetRequest,
    responses(
        (status = 200, body = DataResetResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn reset_data(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<DataResetRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.password.expose_secret().is_empty() || input.password.expose_secret().len() > 1024 {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_data_reset_limits(&state, &user.id).await {
        return error.response(context);
    }
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
    if let Err(error) = verify_login_password(&state, input.password, Some(stored_hash)).await {
        return error.response(context);
    }
    match reset_account_data(&state, &user.id).await {
        Ok(data_generation) => {
            let mut response = Json(DataResetResponse {
                ok: true,
                data_generation,
                tokens_revoked: true,
                request_id: context.request_id,
            })
            .into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            response
        }
        Err(error) => error.response(context),
    }
}

async fn reset_account_data(state: &AppState, user_id: &str) -> Result<i64, ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    // Use the same per-account mutation lock as entity pushes and asset
    // chunks. A reset must not race a valid pre-reset upload into the new
    // data generation after its deletion transaction commits.
    account_mutation::try_lock(&mut transaction, user_id).await?;
    let generation = sqlx::query_scalar::<_, i64>(
        "UPDATE account_data_generations \
         SET generation=generation+1,server_cursor=0,updated_at=$2 \
         WHERE user_id=$1 RETURNING generation",
    )
    .bind(user_id)
    .bind(now_ms())
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::Unauthorized)?;
    for statement in [
        "DELETE FROM sync_entities_v4 WHERE user_id=$1",
        "DELETE FROM sync_push_receipts_v4 WHERE user_id=$1",
        "DELETE FROM account_daily_usage_v4 WHERE user_id=$1",
        "DELETE FROM sync_assets_v4 WHERE user_id=$1",
        "DELETE FROM sync_secret_bundle_epochs_v5 WHERE user_id=$1",
    ] {
        sqlx::query(statement)
            .bind(user_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    sqlx::query("UPDATE auth_sessions_v4 SET revoked_at=$2 WHERE user_id=$1 AND revoked_at=0")
        .bind(user_id)
        .bind(now_ms())
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(generation)
}

#[utoipa::path(
    post,
    path = "/v1/sync/push",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    request_body = PushRequest,
    responses(
        (status = 200, body = PushResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn push(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<PushRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.entities.len() > MAX_PUSH_ENTITIES
        || input.entities.iter().any(|entity| {
            entity.validate_v5().is_err()
                || serde_json::to_vec(entity).map_or(true, |json| json.len() > MAX_ENTITY_BYTES)
        })
    {
        return ApiError::InvalidRequest.response(context);
    }
    let request_json = match serde_json::to_vec(&input) {
        Ok(json) if json.len() <= MAX_PUSH_BYTES => json,
        Ok(_) | Err(_) => return ApiError::InvalidRequest.response(context),
    };
    let request_hash: [u8; 32] = Sha256::digest(request_json).into();
    let authenticated = match authenticate_with_connection(&state, &headers).await {
        Ok(authenticated) if authenticated.user.sync_verified_at != 0 => authenticated,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let AuthenticatedConnection {
        user,
        mut connection,
    } = authenticated;
    let mutation_id = input.mutation_id;
    let query_started = Instant::now();
    let result =
        push_transaction_on_connection(&mut connection, &user.id, input, request_hash).await;
    record_sync_database_query("push", query_started);
    drop(connection);
    match result {
        Ok(result) => Json(PushResponse {
            ok: true,
            data_generation: result.data_generation,
            mutation_id,
            accepted: result.accepted,
            conflicts: result.conflicts,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

async fn push_transaction_on_connection(
    connection: &mut PgConnection,
    user_id: &str,
    input: PushRequest,
    request_hash: [u8; 32],
) -> Result<StoredPushResult, ApiError> {
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    account_mutation::try_lock(&mut transaction, user_id).await?;
    let receipt_now = now_ms();
    let receipt_cutoff = push_receipt_cutoff(receipt_now);
    // Keep the advisory lock in the preceding statement. This point lookup
    // therefore receives a fresh READ COMMITTED snapshot after any previous
    // lock holder committed, while combining the receipt and generation reads
    // into one round trip.
    let preflight = sqlx::query_as::<_, PushPreflightRow>(PUSH_PREFLIGHT_SQL)
        .bind(user_id)
        .bind(input.mutation_id)
        .bind(receipt_cutoff)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?
        .ok_or(ApiError::DatabaseUnavailable)?;
    let PushPreflightRow {
        generation,
        request_hash: existing_request_hash,
        response: existing_response,
    } = preflight;
    let existing = match (existing_request_hash, existing_response) {
        (Some(request_hash), Some(response)) => Some(StoredPushReceipt {
            request_hash,
            response,
        }),
        (None, None) => None,
        // Both receipt columns are NOT NULL. A half-present projection means
        // the database no longer satisfies the migration invariant.
        (Some(_), None) | (None, Some(_)) => return Err(ApiError::DatabaseUnavailable),
    };
    if let Some(existing) = existing {
        if existing.request_hash.as_slice() != request_hash {
            return Err(ApiError::IdempotencyConflict);
        }
        return Ok(existing.response.0);
    }
    if input.data_generation != generation {
        return Err(ApiError::DataGenerationMismatch);
    }
    let (accepted, conflicts) = apply_entities(&mut transaction, user_id, input.entities).await?;
    let result = StoredPushResult {
        data_generation: generation,
        accepted,
        conflicts,
    };
    // A normal sync retries unchanged entities after reconnecting or after an
    // inventory repair. It still receives a receipt for idempotency, but it
    // must not re-scan account storage or update daily quota when no incoming
    // entity won LWW resolution.
    if result.accepted.is_empty() {
        store_push_receipt(
            &mut transaction,
            user_id,
            input.mutation_id,
            &request_hash,
            &result,
            receipt_now,
            receipt_cutoff,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Ok(result);
    }
    // Asset reference cleanup is intentionally handled after commit by the
    // bounded maintenance worker.  It cannot affect the accepted LWW result,
    // receipt, or exact storage quota for this request: unreferenced assets
    // remain retained for the full seven-day recovery window either way.
    apply_quotas(&mut transaction, user_id, &result.accepted).await?;
    store_push_receipt(
        &mut transaction,
        user_id,
        input.mutation_id,
        &request_hash,
        &result,
        receipt_now,
        receipt_cutoff,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(result)
}

async fn apply_quotas(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    accepted: &[EntityEnvelope],
) -> Result<(), ApiError> {
    let accepted_entities =
        i64::try_from(accepted.len()).map_err(|_| ApiError::SyncQuotaExceeded)?;
    let accepted_bytes = accepted.iter().try_fold(0_i64, |total, entity| {
        let size = serde_json::to_vec(entity)
            .map_err(|_| ApiError::InvalidRequest)?
            .len();
        let size = i64::try_from(size).map_err(|_| ApiError::SyncQuotaExceeded)?;
        total.checked_add(size).ok_or(ApiError::SyncQuotaExceeded)
    })?;
    let utc_day = now_ms().div_euclid(DAY_MS);
    // Entity triggers updated the exact storage ledger in the preceding
    // statement. Read that value and advance the daily counter together. If
    // either quota is exceeded the caller returns an error and drops the whole
    // transaction, rolling back both the entity and this usage update.
    let usage = sqlx::query_as::<_, (i64, i64, i64)>(APPLY_QUOTAS_SQL)
        .bind(user_id)
        .bind(utc_day)
        .bind(accepted_entities)
        .bind(accepted_bytes)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?
        // The ledger is initialized with the account. Its absence is an
        // inconsistent database state, matching `storage_usage_bytes` semantics.
        .ok_or(ApiError::DatabaseUnavailable)?;
    if !push_quotas_within_limits(usage.0, usage.1, usage.2) {
        return Err(ApiError::SyncQuotaExceeded);
    }
    Ok(())
}

const fn push_quotas_within_limits(
    total_bytes: i64,
    daily_entities: i64,
    daily_bytes: i64,
) -> bool {
    total_bytes <= ACCOUNT_STORAGE_QUOTA_BYTES
        && daily_entities <= DAILY_WRITE_QUOTA_ENTITIES
        && daily_bytes <= DAILY_WRITE_QUOTA_BYTES
}

async fn apply_entities(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    entities: Vec<EntityEnvelope>,
) -> Result<(Vec<EntityEnvelope>, Vec<EntityEnvelope>), ApiError> {
    // Duplicate keys have intentionally sequential v5 behavior: a later
    // envelope in the same request observes an earlier winning envelope. Keep
    // that rare compatibility path exact while the normal (unique-key) batch
    // uses one keyed lock/read and one multi-row UPSERT.
    let mut seen = HashSet::with_capacity(entities.len());
    if entities
        .iter()
        .any(|entity| !seen.insert((entity.kind.as_str(), entity.id.as_str())))
    {
        return apply_entities_sequential(transaction, user_id, entities).await;
    }

    apply_entities_batch(transaction, user_id, entities).await
}

async fn apply_entities_batch(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    entities: Vec<EntityEnvelope>,
) -> Result<(Vec<EntityEnvelope>, Vec<EntityEnvelope>), ApiError> {
    if entities.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    // An account-scoped transaction lock already serializes this account's
    // writers. For the overwhelmingly common batch (no secret bundle), a
    // conditional UPSERT can make the same LWW decision as `incoming_wins`
    // without first reading and row-locking every entity. Only losing rows are
    // read back to form the protocol conflict response.
    if !entities
        .iter()
        .any(|entity| entity.kind == "secret_bundle_v1")
    {
        return apply_entities_conditional_upsert(transaction, user_id, entities).await;
    }

    // Secret bundles additionally compare their payload epoch with account
    // state, so retain the explicit read path below for that sensitive kind.
    let kinds = entities
        .iter()
        .map(|entity| entity.kind.clone())
        .collect::<Vec<_>>();
    let ids = entities
        .iter()
        .map(|entity| entity.id.clone())
        .collect::<Vec<_>>();
    let current = sqlx::query_as::<_, StoredEntityKey>(
        "SELECT entity.kind,entity.entity_id,entity.envelope \
         FROM sync_entities_v4 AS entity \
         JOIN UNNEST($2::text[],$3::text[]) AS requested(kind,entity_id) \
           ON entity.kind=requested.kind AND entity.entity_id=requested.entity_id \
         WHERE entity.user_id=$1 FOR UPDATE OF entity",
    )
    .bind(user_id)
    .bind(&kinds)
    .bind(&ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .into_iter()
    .map(|stored| ((stored.kind, stored.entity_id), stored.envelope.0))
    .collect::<HashMap<_, _>>();

    let expected_secret_epoch = if entities
        .iter()
        .any(|entity| entity.kind == "secret_bundle_v1" && entity.deleted_at == 0)
    {
        Some(secret_bundle_epoch_transaction(transaction, user_id).await?)
    } else {
        None
    };
    let mut accepted = Vec::new();
    let mut conflicts = Vec::new();
    for entity in entities {
        let existing = current.get(&(entity.kind.clone(), entity.id.clone()));
        if entity.kind == "secret_bundle_v1"
            && entity.deleted_at == 0
            && Some(secret_payload_epoch(&entity)) != expected_secret_epoch
        {
            if let Some(stored) = existing {
                conflicts.push(stored.clone());
            }
            continue;
        }
        if let Some(stored) = existing
            && !incoming_wins(stored, &entity)
        {
            conflicts.push(stored.clone());
            continue;
        }
        accepted.push(entity);
    }
    upsert_entities_batch(transaction, user_id, &accepted).await?;
    Ok((accepted, conflicts))
}

async fn apply_entities_conditional_upsert(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    entities: Vec<EntityEnvelope>,
) -> Result<(Vec<EntityEnvelope>, Vec<EntityEnvelope>), ApiError> {
    let mut query = QueryBuilder::<Postgres>::new(
        "INSERT INTO sync_entities_v4 \
         (user_id,kind,entity_id,envelope,updated_at,deleted_at,device_id,sync_version) ",
    );
    query.push_values(&entities, |mut row, entity| {
        row.push_bind(user_id)
            .push_bind(&entity.kind)
            .push_bind(&entity.id)
            .push_bind(SqlJson(entity))
            .push_bind(entity.updated_at)
            .push_bind(entity.deleted_at)
            .push_bind(&entity.device_id)
            .push_bind(entity.sync_version);
    });
    query.push(
        " ON CONFLICT (user_id,kind,entity_id) DO UPDATE SET \
         envelope=EXCLUDED.envelope,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at, \
         device_id=EXCLUDED.device_id,sync_version=EXCLUDED.sync_version, \
         server_cursor=nextval('sync_cursor_v4') \
         WHERE (EXCLUDED.updated_at,EXCLUDED.sync_version,EXCLUDED.device_id) > \
               (sync_entities_v4.updated_at,sync_entities_v4.sync_version,sync_entities_v4.device_id) \
         RETURNING kind,entity_id",
    );
    let accepted_keys = query
        .build_query_as::<(String, String)>()
        .fetch_all(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?
        .into_iter()
        .collect::<HashSet<_>>();

    if accepted_keys.len() == entities.len() {
        return Ok((entities, Vec::new()));
    }

    let mut missing_kinds = Vec::new();
    let mut missing_ids = Vec::new();
    for entity in &entities {
        if !accepted_keys.contains(&(entity.kind.clone(), entity.id.clone())) {
            missing_kinds.push(entity.kind.clone());
            missing_ids.push(entity.id.clone());
        }
    }
    let conflicts = sqlx::query_as::<_, StoredEntityKey>(
        "SELECT entity.kind,entity.entity_id,entity.envelope \
         FROM sync_entities_v4 AS entity \
         JOIN UNNEST($2::text[],$3::text[]) AS requested(kind,entity_id) \
           ON entity.kind=requested.kind AND entity.entity_id=requested.entity_id \
         WHERE entity.user_id=$1",
    )
    .bind(user_id)
    .bind(&missing_kinds)
    .bind(&missing_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .into_iter()
    .map(|stored| ((stored.kind, stored.entity_id), stored.envelope.0))
    .collect::<HashMap<_, _>>();

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for entity in entities {
        let key = (entity.kind.clone(), entity.id.clone());
        if accepted_keys.contains(&key) {
            accepted.push(entity);
        } else if let Some(current) = conflicts.get(&key) {
            rejected.push(current.clone());
        } else {
            return Err(ApiError::DatabaseUnavailable);
        }
    }
    Ok((accepted, rejected))
}

async fn upsert_entities_batch(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    accepted: &[EntityEnvelope],
) -> Result<(), ApiError> {
    if accepted.is_empty() {
        return Ok(());
    }
    let mut query = QueryBuilder::<Postgres>::new(
        "INSERT INTO sync_entities_v4 \
         (user_id,kind,entity_id,envelope,updated_at,deleted_at,device_id,sync_version) ",
    );
    query.push_values(accepted, |mut row, entity| {
        row.push_bind(user_id)
            .push_bind(&entity.kind)
            .push_bind(&entity.id)
            .push_bind(SqlJson(entity))
            .push_bind(entity.updated_at)
            .push_bind(entity.deleted_at)
            .push_bind(&entity.device_id)
            .push_bind(entity.sync_version);
    });
    query.push(
        " ON CONFLICT (user_id,kind,entity_id) DO UPDATE SET \
         envelope=EXCLUDED.envelope,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at, \
         device_id=EXCLUDED.device_id,sync_version=EXCLUDED.sync_version, \
         server_cursor=nextval('sync_cursor_v4')",
    );
    query
        .build()
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn apply_entities_sequential(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    entities: Vec<EntityEnvelope>,
) -> Result<(Vec<EntityEnvelope>, Vec<EntityEnvelope>), ApiError> {
    let mut accepted = Vec::new();
    let mut conflicts = Vec::new();
    for entity in entities {
        if entity.kind == "secret_bundle_v1"
            && entity.deleted_at == 0
            && secret_payload_epoch(&entity)
                != secret_bundle_epoch_transaction(transaction, user_id).await?
        {
            if let Some(stored) = sqlx::query_as::<_, StoredEntity>(
                "SELECT envelope,server_cursor FROM sync_entities_v4 \
                 WHERE user_id=$1 AND kind=$2 AND entity_id=$3 FOR UPDATE",
            )
            .bind(user_id)
            .bind(&entity.kind)
            .bind(&entity.id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?
            {
                conflicts.push(stored.envelope.0);
            }
            continue;
        }
        let current = sqlx::query_as::<_, StoredEntity>(
            "SELECT envelope,server_cursor FROM sync_entities_v4 \
             WHERE user_id=$1 AND kind=$2 AND entity_id=$3 FOR UPDATE",
        )
        .bind(user_id)
        .bind(&entity.kind)
        .bind(&entity.id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        if let Some(stored) = current
            && !incoming_wins(&stored.envelope, &entity)
        {
            conflicts.push(stored.envelope.0);
            continue;
        }
        let envelope = SqlJson(entity.clone());
        sqlx::query(
            "INSERT INTO sync_entities_v4 \
             (user_id,kind,entity_id,envelope,updated_at,deleted_at,device_id,sync_version) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
             ON CONFLICT (user_id,kind,entity_id) DO UPDATE SET \
             envelope=EXCLUDED.envelope,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at, \
             device_id=EXCLUDED.device_id,sync_version=EXCLUDED.sync_version, \
             server_cursor=nextval('sync_cursor_v4')",
        )
        .bind(user_id)
        .bind(&entity.kind)
        .bind(&entity.id)
        .bind(envelope)
        .bind(entity.updated_at)
        .bind(entity.deleted_at)
        .bind(&entity.device_id)
        .bind(entity.sync_version)
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        accepted.push(entity);
    }
    Ok((accepted, conflicts))
}

fn secret_payload_epoch(entity: &EntityEnvelope) -> u64 {
    entity
        .payload
        .get("epoch")
        .and_then(Value::as_u64)
        .unwrap_or(1)
}

async fn secret_bundle_epoch_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<u64, ApiError> {
    let epoch = sqlx::query_scalar::<_, i64>(
        "INSERT INTO sync_secret_bundle_epochs_v5(user_id,epoch,updated_at) VALUES($1,1,$2) \
         ON CONFLICT(user_id) DO UPDATE SET epoch=sync_secret_bundle_epochs_v5.epoch \
         RETURNING epoch",
    )
    .bind(user_id)
    .bind(now_ms())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    u64::try_from(epoch).map_err(|_| ApiError::DatabaseUnavailable)
}

async fn store_push_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    mutation_id: Uuid,
    request_hash: &[u8; 32],
    result: &StoredPushResult,
    created_at: i64,
    replace_before: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO sync_push_receipts_v4 \
         (user_id,mutation_id,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5) \
         ON CONFLICT(user_id,mutation_id) DO UPDATE SET \
           request_hash=EXCLUDED.request_hash,response=EXCLUDED.response,created_at=EXCLUDED.created_at \
         WHERE sync_push_receipts_v4.created_at < $6",
    )
    .bind(user_id)
    .bind(mutation_id)
    .bind(request_hash.as_slice())
    .bind(SqlJson(result))
    .bind(created_at)
    .bind(replace_before)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

fn push_receipt_cutoff(now: i64) -> i64 {
    now.saturating_sub(PUSH_RECEIPT_TTL_MS)
}

/// Removes one bounded oldest-first batch of receipts that are already outside
/// the idempotency window.  The maintenance worker invokes this independently
/// of foreground pushes.  Receipt lookup and replacement retain the exact
/// 90-day cutoff, so a delayed or failed cleanup never changes retry
/// semantics.
pub(crate) async fn prune_expired_push_receipts(pool: &PgPool) -> Result<u64, ApiError> {
    // `idx_sync_push_receipts_v4_created_at` supports the inner oldest-first
    // scan. `ctid` keeps the delete bounded even if many accounts have stale
    // receipts; no payload or account data is read into the service.
    sqlx::query(
        "DELETE FROM sync_push_receipts_v4 WHERE ctid IN ( \
           SELECT ctid FROM sync_push_receipts_v4 WHERE created_at < $1 \
           ORDER BY created_at ASC LIMIT $2 \
         )",
    )
    .bind(push_receipt_cutoff(now_ms()))
    .bind(PUSH_RECEIPT_PRUNE_BATCH_ROWS)
    .execute(pool)
    .await
    .map(|result| result.rows_affected())
    .map_err(|_| ApiError::DatabaseUnavailable)
}

#[utoipa::path(
    get,
    path = "/v1/sync/checkpoint",
    params(
        ("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5"),
        ("dataGeneration" = i64, Query, description = "The client's current data generation"),
        ("cursor" = Option<i64>, Query, description = "The exact last applied server cursor")
    ),
    responses(
        (status = 200, body = CheckpointResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn checkpoint(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<CheckpointQuery>,
) -> Response {
    if query.data_generation < 1 || query.cursor < 0 {
        return ApiError::InvalidRequest.response(context);
    }
    let authenticated = match authenticate_with_connection(&state, &headers).await {
        Ok(authenticated) if authenticated.user.sync_verified_at != 0 => authenticated,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let AuthenticatedConnection {
        user,
        mut connection,
    } = authenticated;
    let snapshot = checkpoint_snapshot(&mut connection, &user.id).await;
    drop(connection);
    match snapshot {
        Ok(row) if row.generation != query.data_generation => {
            ApiError::DataGenerationMismatch.response(context)
        }
        Ok(row) => Json(CheckpointResponse {
            ok: true,
            data_generation: row.generation,
            cursor: query.cursor,
            server_cursor: row.server_cursor,
            caught_up: checkpoint_caught_up(query.cursor, row.server_cursor),
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    get,
    path = "/v1/sync/pull",
    params(
        ("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5"),
        ("cursor" = Option<i64>, Query, description = "Last applied server cursor"),
        ("limit" = Option<i64>, Query, description = "1 through 5000")
    ),
    responses(
        (status = 200, body = PullResponse),
        (status = 401, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn pull(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<PullQuery>,
) -> Response {
    let authenticated = match authenticate_with_connection(&state, &headers).await {
        Ok(authenticated) if authenticated.user.sync_verified_at != 0 => authenticated,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let AuthenticatedConnection {
        user,
        mut connection,
    } = authenticated;
    let cursor = query.cursor.max(0);
    let limit = query.limit.clamp(1, MAX_PULL_ENTITIES);
    let page = pull_page(&mut connection, &user.id, cursor, limit).await;
    drop(connection);
    match page {
        Ok((generation, rows, has_more)) => {
            let next_cursor = rows.last().map_or(cursor, |row| row.server_cursor);
            Json(PullResponse {
                ok: true,
                data_generation: generation,
                cursor,
                next_cursor,
                has_more,
                entities: rows.into_iter().map(|row| row.envelope.0).collect(),
                request_id: context.request_id,
            })
            .into_response()
        }
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    get,
    path = "/v1/sync/inventory",
    params(
        ("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5"),
        ("kind" = Option<String>, Query, description = "Repeat to scope the inventory")
    ),
    responses(
        (status = 200, body = InventoryResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn inventory(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let kinds = match inventory_kinds_from_query(query.as_deref()) {
        Ok(kinds) => kinds,
        Err(error) => return error.response(context),
    };
    let authenticated = match authenticate_with_connection(&state, &headers).await {
        Ok(authenticated) if authenticated.user.sync_verified_at != 0 => authenticated,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let AuthenticatedConnection {
        user,
        mut connection,
    } = authenticated;
    let snapshot = inventory_metadata_snapshot(&mut connection, &user.id, &kinds).await;
    drop(connection);
    match snapshot {
        Ok((generation, rows)) => {
            let summary = inventory_summary(&rows);
            Json(InventoryResponse {
                ok: true,
                server_time: now_ms(),
                data_generation: generation,
                kinds,
                entity_count: summary.entity_count,
                inventory_digest: summary.inventory_digest,
                revision: summary.revision,
                request_id: context.request_id,
            })
            .into_response()
        }
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/sync/reconcile",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    request_body = ReconcileRequest,
    responses(
        (status = 200, body = ReconcileResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn reconcile(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<ReconcileRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let kinds = match inventory_kinds(&input.kinds) {
        Ok(kinds) => kinds,
        Err(error) => return error.response(context),
    };
    if !valid_manifest(&input.manifest, &kinds) {
        return ApiError::InvalidRequest.response(context);
    }
    let authenticated = match authenticate_with_connection(&state, &headers).await {
        Ok(authenticated) if authenticated.user.sync_verified_at != 0 => authenticated,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let AuthenticatedConnection {
        user,
        mut connection,
    } = authenticated;
    let snapshot = inventory_snapshot(&mut connection, &user.id, &kinds).await;
    drop(connection);
    let (generation, rows) = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) => return error.response(context),
    };
    match reconcile_snapshot(generation, rows, input.data_generation, &input.manifest) {
        Ok((generation, rows, upload, entities)) => {
            let summary = inventory_summary(&rows);
            Json(ReconcileResponse {
                ok: true,
                server_time: now_ms(),
                data_generation: generation,
                kinds,
                entity_count: summary.entity_count,
                inventory_digest: summary.inventory_digest,
                revision: summary.revision,
                upload,
                entities,
                request_id: context.request_id,
            })
            .into_response()
        }
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    get,
    path = "/v1/sync/secret-state",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    responses(
        (status = 200, body = SecretBundleStateResponse),
        (status = 401, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn secret_state(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match secret_bundle_epoch(&state, &user.id).await {
        Ok(secret_bundle_epoch) => Json(SecretBundleStateResponse {
            ok: true,
            secret_bundle_epoch,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/sync/secret-state/reset",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    responses(
        (status = 200, body = SecretBundleStateResponse),
        (status = 401, body = crate::error::ErrorBody),
        (status = 426, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn reset_secret_state(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_secret_reset_limits(&state, &user.id).await {
        return error.response(context);
    }
    match reset_secret_bundle_epoch(&state, &user.id).await {
        Ok(secret_bundle_epoch) => Json(SecretBundleStateResponse {
            ok: true,
            secret_bundle_epoch,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

async fn pull_page(
    connection: &mut PgConnection,
    user_id: &str,
    cursor: i64,
    limit: i64,
) -> Result<(i64, Vec<StoredEntity>, bool), ApiError> {
    // Fetch one look-ahead page in the same snapshot as the generation.  Page
    // byte accounting is deliberately done by the API process: PostgreSQL has
    // already materialized each returned row, and windowing `SUM` plus
    // `ROW_NUMBER` made every pull spend extra database CPU on an otherwise
    // bounded (`limit + 1`) result.  `envelope_bytes` is the same stored value
    // used by the former window expression, so the 4 MiB boundary and the
    // first-oversized-entity behavior remain byte-for-byte compatible.
    let query_started = Instant::now();
    let candidates = sqlx::query_as::<_, PullCandidateRow>(
        "WITH account AS ( \
           SELECT generation FROM account_data_generations WHERE user_id=$1 \
         ), page_candidates AS ( \
           SELECT envelope,server_cursor,envelope_bytes \
           FROM sync_entities_v4 WHERE user_id=$1 AND server_cursor>$2 \
           ORDER BY server_cursor ASC LIMIT ($3 + 1) \
         ) \
         SELECT account.generation,page_candidates.envelope,page_candidates.server_cursor, \
                page_candidates.envelope_bytes \
         FROM account LEFT JOIN page_candidates ON TRUE \
         ORDER BY page_candidates.server_cursor ASC NULLS FIRST",
    )
    .bind(user_id)
    .bind(cursor)
    .bind(limit)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable);
    record_sync_database_query("pull", query_started);
    let candidates = candidates?;
    let generation = candidates
        .first()
        .map(|row| row.generation)
        .ok_or(ApiError::DatabaseUnavailable)?;
    let mut rows = Vec::with_capacity(candidates.len());
    let mut candidate_count = 0_usize;
    let mut cumulative_bytes = 0_i64;
    for candidate in candidates {
        let (Some(envelope), Some(server_cursor), Some(envelope_bytes)) = (
            candidate.envelope,
            candidate.server_cursor,
            candidate.envelope_bytes,
        ) else {
            continue;
        };
        candidate_count += 1;
        cumulative_bytes = cumulative_bytes.saturating_add(envelope_bytes);
        if pull_candidate_fits_response(candidate_count, limit, cumulative_bytes) {
            rows.push(StoredEntity {
                envelope,
                server_cursor,
            });
        }
    }
    let has_more = candidate_count > rows.len();
    Ok((generation, rows, has_more))
}

fn pull_candidate_fits_response(
    candidate_position: usize,
    limit: i64,
    cumulative_bytes: i64,
) -> bool {
    let within_entity_limit = candidate_position <= usize::try_from(limit).unwrap_or(0);
    within_entity_limit && (candidate_position == 1 || cumulative_bytes <= MAX_PULL_RESPONSE_BYTES)
}

async fn checkpoint_snapshot(
    connection: &mut PgConnection,
    user_id: &str,
) -> Result<CheckpointRow, ApiError> {
    // Entity mutations maintain this account row transactionally. Checkpoint
    // therefore stays one primary-key lookup regardless of inventory size.
    let query_started = Instant::now();
    let row = sqlx::query_as::<_, CheckpointRow>(CHECKPOINT_SNAPSHOT_SQL)
        .bind(user_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable);
    record_sync_database_query("checkpoint", query_started);
    row?.ok_or(ApiError::Unauthorized)
}

const fn checkpoint_caught_up(cursor: i64, server_cursor: i64) -> bool {
    // Equality, rather than >=, refuses a corrupted or stale cursor that jumps
    // ahead of the server's visible high-water mark.
    cursor == server_cursor
}

#[derive(Debug, FromRow)]
struct InventoryRow {
    envelope: SqlJson<EntityEnvelope>,
    server_cursor: i64,
}

/// The inventory endpoint needs a digest of sync metadata, not entity payloads.
/// Keeping this projection separate from [`InventoryRow`] avoids transferring and
/// deserializing potentially large JSONB envelopes on every inventory check.
#[derive(Debug, FromRow)]
struct InventoryMetadataRow {
    kind: String,
    entity_id: String,
    updated_at: i64,
    deleted_at: i64,
    device_id: String,
    sync_version: i64,
    server_cursor: i64,
}

struct InventorySummary {
    entity_count: usize,
    inventory_digest: String,
    revision: String,
}

type ReconcileSnapshot = (i64, Vec<InventoryRow>, Vec<EntityKey>, Vec<EntityEnvelope>);

fn inventory_kinds(requested: &[String]) -> Result<Vec<String>, ApiError> {
    let mut kinds = if requested.is_empty() {
        INVENTORY_KINDS
            .iter()
            .map(|kind| (*kind).to_owned())
            .collect()
    } else {
        requested
            .iter()
            .filter_map(|kind| {
                let kind = kind.trim();
                (!kind.is_empty()).then(|| kind.to_owned())
            })
            .collect::<Vec<_>>()
    };
    kinds.sort();
    kinds.dedup();
    if kinds.is_empty()
        || kinds
            .iter()
            .any(|kind| !INVENTORY_KINDS.contains(&kind.as_str()))
    {
        return Err(ApiError::InvalidRequest);
    }
    Ok(kinds)
}

fn inventory_kinds_from_query(query: Option<&str>) -> Result<Vec<String>, ApiError> {
    let Some(query) = query.filter(|query| !query.is_empty()) else {
        return inventory_kinds(&[]);
    };
    let kinds = query
        .split('&')
        .map(|pair| pair.strip_prefix("kind=").ok_or(ApiError::InvalidRequest))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    inventory_kinds(&kinds)
}

fn valid_manifest(manifest: &[ManifestEntry], kinds: &[String]) -> bool {
    if manifest.len() > MAX_PUSH_ENTITIES {
        return false;
    }
    let mut seen = std::collections::BTreeSet::new();
    manifest.iter().all(|entry| {
        kinds.iter().any(|kind| kind == &entry.kind)
            && entry.id.len() <= MAX_ENTITY_ID_BYTES
            && !entry.id.is_empty()
            && entry.device_id.len() <= MAX_DEVICE_ID_BYTES
            && !entry.device_id.is_empty()
            && canonical_epoch_millis(entry.updated_at)
            && (entry.deleted_at == 0 || canonical_epoch_millis(entry.deleted_at))
            && entry.sync_version > 0
            && seen.insert((entry.kind.as_str(), entry.id.as_str()))
    })
}

async fn inventory_snapshot(
    connection: &mut PgConnection,
    user_id: &str,
    kinds: &[String],
) -> Result<(i64, Vec<InventoryRow>), ApiError> {
    let generation = account_generation(&mut *connection, user_id).await?;
    let rows = sqlx::query_as::<_, InventoryRow>(
        "SELECT envelope,server_cursor FROM sync_entities_v4 \
         WHERE user_id=$1 AND kind = ANY($2) ORDER BY kind,entity_id",
    )
    .bind(user_id)
    .bind(kinds)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((generation, rows))
}

async fn inventory_metadata_snapshot(
    connection: &mut PgConnection,
    user_id: &str,
    kinds: &[String],
) -> Result<(i64, Vec<InventoryMetadataRow>), ApiError> {
    let query_started = Instant::now();
    let candidates = sqlx::query_as::<_, InventoryMetadataCandidateRow>(
        "WITH account AS ( \
           SELECT generation FROM account_data_generations WHERE user_id=$1 \
         ), inventory AS ( \
           SELECT kind,entity_id,updated_at,deleted_at,device_id,sync_version,server_cursor \
           FROM sync_entities_v4 WHERE user_id=$1 AND kind = ANY($2) \
         ) \
         SELECT account.generation,inventory.kind,inventory.entity_id,inventory.updated_at, \
                inventory.deleted_at,inventory.device_id,inventory.sync_version,inventory.server_cursor \
         FROM account LEFT JOIN inventory ON TRUE \
         ORDER BY inventory.kind ASC NULLS FIRST, inventory.entity_id ASC NULLS FIRST",
    )
    .bind(user_id)
    .bind(kinds)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable);
    record_sync_database_query("inventory", query_started);
    let candidates = candidates?;
    let generation = candidates
        .first()
        .map(|row| row.generation)
        .ok_or(ApiError::DatabaseUnavailable)?;
    let rows = candidates
        .into_iter()
        .filter_map(|candidate| {
            Some(InventoryMetadataRow {
                kind: candidate.kind?,
                entity_id: candidate.entity_id?,
                updated_at: candidate.updated_at?,
                deleted_at: candidate.deleted_at?,
                device_id: candidate.device_id?,
                sync_version: candidate.sync_version?,
                server_cursor: candidate.server_cursor?,
            })
        })
        .collect();
    Ok((generation, rows))
}

fn reconcile_snapshot(
    generation: i64,
    rows: Vec<InventoryRow>,
    requested_generation: i64,
    manifest: &[ManifestEntry],
) -> Result<ReconcileSnapshot, ApiError> {
    if requested_generation != generation {
        return Err(ApiError::DataGenerationMismatch);
    }
    let local = manifest
        .iter()
        .map(|entry| ((entry.kind.as_str(), entry.id.as_str()), entry))
        .collect::<std::collections::BTreeMap<_, _>>();
    let remote = rows
        .iter()
        .map(|row| {
            let entity = &row.envelope.0;
            ((entity.kind.as_str(), entity.id.as_str()), entity)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let keys = local
        .keys()
        .chain(remote.keys())
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut upload = Vec::new();
    let mut entities = Vec::new();
    for key in keys {
        match (local.get(&key), remote.get(&key)) {
            (Some(entry), None) => upload.push(EntityKey {
                kind: entry.kind.clone(),
                id: entry.id.clone(),
            }),
            (Some(entry), Some(entity)) if manifest_entry_matches(entry, entity) => {}
            (Some(entry), Some(entity)) if manifest_entry_wins(entry, entity) => {
                upload.push(EntityKey {
                    kind: entry.kind.clone(),
                    id: entry.id.clone(),
                });
            }
            (None | Some(_), Some(entity)) => entities.push((*entity).clone()),
            (None, None) => unreachable!("union of manifest and stored keys"),
        }
    }
    Ok((generation, rows, upload, entities))
}

fn manifest_entry_matches(entry: &ManifestEntry, entity: &EntityEnvelope) -> bool {
    entry.updated_at == entity.updated_at
        && entry.deleted_at == entity.deleted_at
        && entry.device_id == entity.device_id
        && entry.sync_version == entity.sync_version
}

fn manifest_entry_wins(entry: &ManifestEntry, entity: &EntityEnvelope) -> bool {
    (
        entry.updated_at,
        entry.sync_version,
        entry.device_id.as_str(),
    ) > (
        entity.updated_at,
        entity.sync_version,
        entity.device_id.as_str(),
    )
}

trait InventorySummaryRow {
    fn kind(&self) -> &str;
    fn entity_id(&self) -> &str;
    fn device_id(&self) -> &str;
    fn sync_version(&self) -> i64;
    fn updated_at(&self) -> i64;
    fn deleted_at(&self) -> i64;
    fn server_cursor(&self) -> i64;
}

impl InventorySummaryRow for InventoryRow {
    fn kind(&self) -> &str {
        &self.envelope.0.kind
    }

    fn entity_id(&self) -> &str {
        &self.envelope.0.id
    }

    fn device_id(&self) -> &str {
        &self.envelope.0.device_id
    }

    fn sync_version(&self) -> i64 {
        self.envelope.0.sync_version
    }

    fn updated_at(&self) -> i64 {
        self.envelope.0.updated_at
    }

    fn deleted_at(&self) -> i64 {
        self.envelope.0.deleted_at
    }

    fn server_cursor(&self) -> i64 {
        self.server_cursor
    }
}

impl InventorySummaryRow for InventoryMetadataRow {
    fn kind(&self) -> &str {
        &self.kind
    }

    fn entity_id(&self) -> &str {
        &self.entity_id
    }

    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn sync_version(&self) -> i64 {
        self.sync_version
    }

    fn updated_at(&self) -> i64 {
        self.updated_at
    }

    fn deleted_at(&self) -> i64 {
        self.deleted_at
    }

    fn server_cursor(&self) -> i64 {
        self.server_cursor
    }
}

fn inventory_summary<T: InventorySummaryRow>(rows: &[T]) -> InventorySummary {
    let mut digest = Sha256::new();
    let mut revision = 0_i64;
    for row in rows {
        inventory_digest_text(&mut digest, row.kind());
        inventory_digest_text(&mut digest, row.entity_id());
        inventory_digest_text(&mut digest, row.device_id());
        digest.update(row.sync_version().to_be_bytes());
        digest.update(row.updated_at().to_be_bytes());
        digest.update(row.deleted_at().to_be_bytes());
        revision = revision.max(row.server_cursor());
    }
    InventorySummary {
        entity_count: rows.len(),
        inventory_digest: digest.finalize().iter().fold(
            String::with_capacity(64),
            |mut text, byte| {
                use std::fmt::Write as _;
                write!(&mut text, "{byte:02x}").expect("writing to String cannot fail");
                text
            },
        ),
        revision: revision.to_string(),
    }
}

fn inventory_digest_text(digest: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    digest.update(u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    digest.update(bytes);
}

async fn secret_bundle_epoch(state: &AppState, user_id: &str) -> Result<u64, ApiError> {
    let epoch = sqlx::query_scalar::<_, i64>(
        "INSERT INTO sync_secret_bundle_epochs_v5(user_id,epoch,updated_at) VALUES($1,1,$2) \
         ON CONFLICT(user_id) DO UPDATE SET epoch=sync_secret_bundle_epochs_v5.epoch \
         RETURNING epoch",
    )
    .bind(user_id)
    .bind(now_ms())
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    u64::try_from(epoch).map_err(|_| ApiError::DatabaseUnavailable)
}

async fn reset_secret_bundle_epoch(state: &AppState, user_id: &str) -> Result<u64, ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    account_mutation::try_lock(&mut transaction, user_id).await?;
    let epoch = sqlx::query_scalar::<_, i64>(
        "INSERT INTO sync_secret_bundle_epochs_v5(user_id,epoch,updated_at) VALUES($1,2,$2) \
         ON CONFLICT(user_id) DO UPDATE SET epoch=sync_secret_bundle_epochs_v5.epoch+1,updated_at=EXCLUDED.updated_at \
         RETURNING epoch",
    )
    .bind(user_id)
    .bind(now_ms())
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT sync_version FROM sync_entities_v4 WHERE user_id=$1 AND kind='secret_bundle_v1' AND entity_id='default' FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let now = now_ms();
    let next_version = existing.unwrap_or(0).saturating_add(1);
    let tombstone = EntityEnvelope {
        id: "default".to_owned(),
        kind: "secret_bundle_v1".to_owned(),
        updated_at: now,
        deleted_at: now,
        device_id: "server-secret-reset".to_owned(),
        sync_version: next_version,
        payload: serde_json::json!({}),
        extensions: BTreeMap::new(),
    };
    sqlx::query(
        "INSERT INTO sync_entities_v4 \
         (user_id,kind,entity_id,envelope,updated_at,deleted_at,device_id,sync_version) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) \
         ON CONFLICT(user_id,kind,entity_id) DO UPDATE SET \
         envelope=EXCLUDED.envelope,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at, \
         device_id=EXCLUDED.device_id,sync_version=EXCLUDED.sync_version,server_cursor=nextval('sync_cursor_v4')",
    )
    .bind(user_id)
    .bind(&tombstone.kind)
    .bind(&tombstone.id)
    .bind(SqlJson(tombstone))
    .bind(now)
    .bind(now)
    .bind("server-secret-reset")
    .bind(next_version)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    u64::try_from(epoch).map_err(|_| ApiError::DatabaseUnavailable)
}

async fn account_generation<'e, E>(executor: E, user_id: &str) -> Result<i64, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_scalar("SELECT generation FROM account_data_generations WHERE user_id=$1")
        .bind(user_id)
        .fetch_one(executor)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

/// Reads the exact, transactionally maintained storage total for one account.
///
/// Source-table triggers populate the ledger for new and migrated accounts;
/// a missing row therefore means the authenticated account is inconsistent.
pub(crate) async fn storage_usage_bytes<'e, E>(executor: E, user_id: &str) -> Result<i64, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_scalar(
        "SELECT entity_bytes+asset_bytes \
         FROM account_storage_usage_v5 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_optional(executor)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::DatabaseUnavailable)
}

const fn default_pull_limit() -> i64 {
    1_000
}

fn canonical_epoch_millis(value: i64) -> bool {
    (MIN_EPOCH_MILLIS..=MAX_EPOCH_MILLIS).contains(&value)
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

    fn fixture() -> EntityEnvelope {
        serde_json::from_str(include_str!(
            "../../../contracts/fixtures/api-v5-entity-envelope.json"
        ))
        .expect("v5 fixture")
    }

    #[test]
    fn fixture_is_valid_and_unknown_fields_round_trip() {
        let entity = fixture();
        entity.validate_v5().expect("valid v5 entity");
        let encoded = serde_json::to_value(entity).expect("serialize entity");
        assert_eq!(encoded["futureEnvelopeField"], "preserve-me");
        assert_eq!(encoded["payload"]["futurePayloadField"]["preserved"], true);
    }

    #[test]
    fn rejects_legacy_seconds_and_ai_history_array() {
        let mut entity = fixture();
        entity.updated_at = 1_786_521_600;
        assert_eq!(
            entity.validate_v5(),
            Err(EntityValidationError::InvalidUpdatedAt)
        );
        entity.updated_at = 1_786_521_600_123;
        entity.kind = "ai_reader_history_v1".to_owned();
        assert_eq!(
            entity.validate_v5(),
            Err(EntityValidationError::LegacyAiHistory)
        );
    }

    #[test]
    fn lww_ties_are_deterministic() {
        let current = fixture();
        let mut incoming = current.clone();
        incoming.device_id = "fixture-device-b".to_owned();
        assert!(incoming_wins(&current, &incoming));
        incoming.sync_version -= 1;
        assert!(!incoming_wins(&current, &incoming));
        incoming.sync_version += 2;
        assert!(incoming_wins(&current, &incoming));
    }

    #[test]
    fn checkpoint_requires_the_exact_high_water_cursor() {
        assert!(checkpoint_caught_up(42, 42));
        assert!(!checkpoint_caught_up(41, 42));
        assert!(!checkpoint_caught_up(43, 42));
    }

    #[test]
    fn checkpoint_snapshot_is_an_account_primary_key_lookup() {
        assert!(CHECKPOINT_SNAPSHOT_SQL.contains("account_data_generations"));
        assert!(CHECKPOINT_SNAPSHOT_SQL.contains("WHERE user_id=$1"));
        assert!(!CHECKPOINT_SNAPSHOT_SQL.contains("sync_entities_v4"));
        assert!(!CHECKPOINT_SNAPSHOT_SQL.contains("ORDER BY"));
    }

    #[test]
    fn push_preflight_combines_receipt_and_generation_after_external_lock() {
        assert!(PUSH_PREFLIGHT_SQL.contains("account_data_generations"));
        assert!(PUSH_PREFLIGHT_SQL.contains("sync_push_receipts_v4"));
        assert!(PUSH_PREFLIGHT_SQL.contains("receipt.mutation_id=$2"));
        assert!(PUSH_PREFLIGHT_SQL.contains("receipt.created_at >= $3"));
        assert!(PUSH_PREFLIGHT_SQL.contains("generation.user_id=$1"));
        assert!(!PUSH_PREFLIGHT_SQL.contains("advisory"));
    }

    #[test]
    fn accepted_push_quota_statement_returns_all_exact_counters() {
        assert!(APPLY_QUOTAS_SQL.contains("account_daily_usage_v4"));
        assert!(APPLY_QUOTAS_SQL.contains("account_storage_usage_v5"));
        assert!(APPLY_QUOTAS_SQL.contains("RETURNING accepted_entities,accepted_bytes"));
        assert!(APPLY_QUOTAS_SQL.contains("entity_bytes+storage.asset_bytes AS total_bytes"));

        assert!(push_quotas_within_limits(
            ACCOUNT_STORAGE_QUOTA_BYTES,
            DAILY_WRITE_QUOTA_ENTITIES,
            DAILY_WRITE_QUOTA_BYTES
        ));
        assert!(!push_quotas_within_limits(
            ACCOUNT_STORAGE_QUOTA_BYTES + 1,
            DAILY_WRITE_QUOTA_ENTITIES,
            DAILY_WRITE_QUOTA_BYTES
        ));
        assert!(!push_quotas_within_limits(
            ACCOUNT_STORAGE_QUOTA_BYTES,
            DAILY_WRITE_QUOTA_ENTITIES + 1,
            DAILY_WRITE_QUOTA_BYTES
        ));
        assert!(!push_quotas_within_limits(
            ACCOUNT_STORAGE_QUOTA_BYTES,
            DAILY_WRITE_QUOTA_ENTITIES,
            DAILY_WRITE_QUOTA_BYTES + 1
        ));
    }

    #[test]
    fn pull_page_byte_budget_keeps_the_first_oversized_entity_only() {
        assert!(pull_candidate_fits_response(
            1,
            50,
            MAX_PULL_RESPONSE_BYTES.saturating_add(1)
        ));
        assert!(!pull_candidate_fits_response(
            2,
            50,
            MAX_PULL_RESPONSE_BYTES.saturating_add(1)
        ));
        assert!(!pull_candidate_fits_response(51, 50, 1));
        assert!(pull_candidate_fits_response(
            50,
            50,
            MAX_PULL_RESPONSE_BYTES
        ));
    }

    #[test]
    fn v5_rejects_retired_or_invalid_jump_back_settings_before_storage() {
        let mut entity = fixture();
        entity.id = APP_SETTINGS_ID.to_owned();
        entity.kind = APP_SETTINGS_KIND.to_owned();
        entity.payload = serde_json::json!({
            "readerJumpBackIconSizePx": 60,
            "readerJumpBackSizeLevel": 4
        });
        assert_eq!(
            entity.validate_v5(),
            Err(EntityValidationError::RetiredJumpBackSizeLevel)
        );

        entity.payload = serde_json::json!({"readerJumpBackIconSizePx": 29});
        assert_eq!(
            entity.validate_v5(),
            Err(EntityValidationError::InvalidJumpBackIconSizePx)
        );

        entity.payload = serde_json::json!({"readerJumpBackIconSizePx": 160});
        entity.validate_v5().expect("v5 settings payload");
    }

    #[test]
    fn v5_rejects_oversized_live_palette_backgrounds() {
        let mut entity = fixture();
        entity.id = "custom-large-background".to_owned();
        entity.kind = "reader_palette_v1".to_owned();
        entity.payload = serde_json::json!({
            "backgroundAssetBytes": MAX_READER_BACKGROUND_ASSET_BYTES + 1
        });
        assert_eq!(
            entity.validate_v5(),
            Err(EntityValidationError::InvalidPayload)
        );

        entity.deleted_at = entity.updated_at;
        entity
            .validate_v5()
            .expect("a tombstone must remain writable to remove old data");
    }

    #[test]
    fn inventory_digest_and_manifest_lww_match_desktop_protocol() {
        let entity = fixture();
        let row = InventoryRow {
            envelope: SqlJson(entity.clone()),
            server_cursor: 42,
        };
        let summary = inventory_summary(&[row]);
        assert_eq!(summary.entity_count, 1);
        assert_eq!(summary.revision, "42");
        assert_eq!(summary.inventory_digest.len(), 64);

        let same = ManifestEntry {
            kind: entity.kind.clone(),
            id: entity.id.clone(),
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id.clone(),
            sync_version: entity.sync_version,
        };
        assert!(manifest_entry_matches(&same, &entity));
        let newer = ManifestEntry {
            updated_at: same.updated_at + 1,
            ..same
        };
        assert!(manifest_entry_wins(&newer, &entity));
    }

    #[test]
    fn inventory_metadata_summary_matches_complete_envelope_summary() {
        let entity = fixture();
        let complete = inventory_summary(&[InventoryRow {
            envelope: SqlJson(entity.clone()),
            server_cursor: 42,
        }]);
        let metadata = inventory_summary(&[InventoryMetadataRow {
            kind: entity.kind,
            entity_id: entity.id,
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id,
            sync_version: entity.sync_version,
            server_cursor: 42,
        }]);
        assert_eq!(metadata.entity_count, complete.entity_count);
        assert_eq!(metadata.inventory_digest, complete.inventory_digest);
        assert_eq!(metadata.revision, complete.revision);
    }

    #[test]
    fn push_receipt_retention_is_ninety_days_and_maintenance_batches_are_bounded() {
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        assert_eq!(push_receipt_cutoff(now), 10 * day);
        assert_eq!(PUSH_RECEIPT_PRUNE_BATCH_ROWS, 2_000);
    }

    #[test]
    fn first_upload_fits_the_full_account_storage_budget_in_one_day() {
        assert_eq!(DAILY_WRITE_QUOTA_BYTES, ACCOUNT_STORAGE_QUOTA_BYTES);
        assert_eq!(DAILY_WRITE_QUOTA_ENTITIES, 10_000);
    }

    #[test]
    fn inventory_kind_query_allows_repeated_desktop_style_values() {
        assert_eq!(
            inventory_kinds_from_query(Some("kind=vocab&kind=app_settings_v1")).unwrap(),
            vec!["app_settings_v1", "vocab"]
        );
        assert!(inventory_kinds_from_query(Some("kind=vocab&unknown=x")).is_err());
    }
}
