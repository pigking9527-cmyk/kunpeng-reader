use std::{cmp::Ordering, collections::BTreeMap};

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
use sqlx::{FromRow, Postgres, Transaction, types::Json as SqlJson};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    auth::{authenticate, verify_login_password},
    error::ApiError,
    middleware::RequestContext,
    rate_limit::{check_data_reset_limits, check_secret_reset_limits},
    recovery::record_accepted_versions,
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
const MAX_ENTITY_BYTES: usize = 1024 * 1024;
const MAX_PUSH_BYTES: usize = 4 * 1024 * 1024;
const PUSH_RECEIPT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_STORAGE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
const DAILY_WRITE_QUOTA_BYTES: i64 = 10 * 1024 * 1024;
const DAILY_WRITE_QUOTA_ENTITIES: i64 = 3_000;
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
];

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
        self.validate_v5_settings_payload()?;
        Ok(())
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
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let generation = sqlx::query_scalar::<_, i64>(
        "UPDATE account_data_generations SET generation=generation+1,updated_at=$2 \
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
        "DELETE FROM sync_entity_history_v4 WHERE user_id=$1",
        "DELETE FROM sync_recovery_accounts_v4 WHERE user_id=$1",
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
    if serde_json::to_vec(&input).map_or(true, |json| json.len() > MAX_PUSH_BYTES) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let mutation_id = input.mutation_id;
    match push_transaction(&state, &user.id, input).await {
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

async fn push_transaction(
    state: &AppState,
    user_id: &str,
    input: PushRequest,
) -> Result<StoredPushResult, ApiError> {
    let request_hash: [u8; 32] =
        Sha256::digest(serde_json::to_vec(&input).map_err(|_| ApiError::InvalidRequest)?).into();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("DELETE FROM sync_push_receipts_v4 WHERE user_id=$1 AND created_at<$2")
        .bind(user_id)
        .bind(now_ms().saturating_sub(PUSH_RECEIPT_TTL_MS))
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let existing = sqlx::query_as::<_, StoredPushReceipt>(
        "SELECT request_hash,response FROM sync_push_receipts_v4 \
         WHERE user_id=$1 AND mutation_id=$2",
    )
    .bind(user_id)
    .bind(input.mutation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(existing) = existing {
        if existing.request_hash.as_slice() != request_hash {
            return Err(ApiError::IdempotencyConflict);
        }
        return Ok(existing.response.0);
    }
    let generation = account_generation(&mut *transaction, user_id).await?;
    if input.data_generation != generation {
        return Err(ApiError::DataGenerationMismatch);
    }
    let (accepted, conflicts) = apply_entities(&mut transaction, user_id, input.entities).await?;
    let result = StoredPushResult {
        data_generation: generation,
        accepted,
        conflicts,
    };
    // Persist recovery versions before checking quota. The transaction rolls
    // back on rejection, and both retained history and its compressed bytes
    // are part of the account's storage and daily-write budgets.
    let history_bytes =
        record_accepted_versions(&mut transaction, user_id, &result.accepted, now_ms()).await?;
    apply_quotas(&mut transaction, user_id, &result.accepted, history_bytes).await?;
    store_push_receipt(
        &mut transaction,
        user_id,
        input.mutation_id,
        &request_hash,
        &result,
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
    history_bytes: i64,
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
    let total_bytes = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(octet_length(envelope::text)),0) + \
         COALESCE((SELECT SUM(octet_length(body)) FROM sync_assets_v4 WHERE user_id=$1),0) + \
         COALESCE((SELECT SUM(octet_length(compressed_envelope)) FROM sync_entity_history_v4 WHERE user_id=$1),0) \
         FROM sync_entities_v4 WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if total_bytes > ACCOUNT_STORAGE_QUOTA_BYTES {
        return Err(ApiError::SyncQuotaExceeded);
    }
    let accepted_bytes = accepted_bytes
        .checked_add(history_bytes)
        .ok_or(ApiError::SyncQuotaExceeded)?;
    let utc_day = now_ms().div_euclid(DAY_MS);
    let usage = sqlx::query_as::<_, (i64, i64)>(
        "INSERT INTO account_daily_usage_v4(user_id,utc_day,accepted_entities,accepted_bytes) \
         VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,utc_day) DO UPDATE SET \
         accepted_entities=account_daily_usage_v4.accepted_entities+EXCLUDED.accepted_entities, \
         accepted_bytes=account_daily_usage_v4.accepted_bytes+EXCLUDED.accepted_bytes \
         RETURNING accepted_entities,accepted_bytes",
    )
    .bind(user_id)
    .bind(utc_day)
    .bind(accepted_entities)
    .bind(accepted_bytes)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if usage.0 > DAILY_WRITE_QUOTA_ENTITIES || usage.1 > DAILY_WRITE_QUOTA_BYTES {
        return Err(ApiError::SyncQuotaExceeded);
    }
    Ok(())
}

async fn apply_entities(
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
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO sync_push_receipts_v4 \
         (user_id,mutation_id,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(user_id)
    .bind(mutation_id)
    .bind(request_hash.as_slice())
    .bind(SqlJson(result))
    .bind(now_ms())
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
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
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    let cursor = query.cursor.max(0);
    let limit = query.limit.clamp(1, MAX_PULL_ENTITIES);
    match pull_page(&state, &user.id, cursor, limit).await {
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
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match inventory_snapshot(&state, &user.id, &kinds).await {
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
    let user = match authenticate(&state, &headers).await {
        Ok(user) if user.sync_verified_at != 0 => user,
        Ok(_) => return ApiError::EmailVerificationRequired.response(context),
        Err(error) => return error.response(context),
    };
    match reconcile_snapshot(
        &state,
        &user.id,
        input.data_generation,
        &kinds,
        &input.manifest,
    )
    .await
    {
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
    state: &AppState,
    user_id: &str,
    cursor: i64,
    limit: i64,
) -> Result<(i64, Vec<StoredEntity>, bool), ApiError> {
    let generation = account_generation(&state.pool, user_id).await?;
    let rows = sqlx::query_as::<_, StoredEntity>(
        "WITH candidates AS ( \
           SELECT envelope,server_cursor, \
             SUM(octet_length(envelope::text)) OVER (ORDER BY server_cursor) AS cumulative_bytes, \
             ROW_NUMBER() OVER (ORDER BY server_cursor) AS row_number \
           FROM sync_entities_v4 WHERE user_id=$1 AND server_cursor>$2 \
           ORDER BY server_cursor ASC LIMIT $3 \
         ) \
         SELECT envelope,server_cursor FROM candidates \
         WHERE cumulative_bytes<=$4 OR row_number=1 ORDER BY server_cursor ASC",
    )
    .bind(user_id)
    .bind(cursor)
    .bind(limit)
    .bind(MAX_PULL_RESPONSE_BYTES)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let next_cursor = rows.last().map_or(cursor, |row| row.server_cursor);
    let has_more = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM sync_entities_v4 WHERE user_id=$1 AND server_cursor>$2)",
    )
    .bind(user_id)
    .bind(next_cursor)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((generation, rows, has_more))
}

#[derive(Debug, FromRow)]
struct InventoryRow {
    envelope: SqlJson<EntityEnvelope>,
    server_cursor: i64,
}

struct InventorySummary {
    entity_count: usize,
    inventory_digest: String,
    revision: String,
}

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
    state: &AppState,
    user_id: &str,
    kinds: &[String],
) -> Result<(i64, Vec<InventoryRow>), ApiError> {
    let generation = account_generation(&state.pool, user_id).await?;
    let rows = sqlx::query_as::<_, InventoryRow>(
        "SELECT envelope,server_cursor FROM sync_entities_v4 \
         WHERE user_id=$1 AND kind = ANY($2) ORDER BY kind,entity_id",
    )
    .bind(user_id)
    .bind(kinds)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((generation, rows))
}

async fn reconcile_snapshot(
    state: &AppState,
    user_id: &str,
    requested_generation: i64,
    kinds: &[String],
    manifest: &[ManifestEntry],
) -> Result<(i64, Vec<InventoryRow>, Vec<EntityKey>, Vec<EntityEnvelope>), ApiError> {
    let (generation, rows) = inventory_snapshot(state, user_id, kinds).await?;
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

fn inventory_summary(rows: &[InventoryRow]) -> InventorySummary {
    let mut digest = Sha256::new();
    let mut revision = 0_i64;
    for row in rows {
        let entity = &row.envelope.0;
        inventory_digest_text(&mut digest, &entity.kind);
        inventory_digest_text(&mut digest, &entity.id);
        inventory_digest_text(&mut digest, &entity.device_id);
        digest.update(entity.sync_version.to_be_bytes());
        digest.update(entity.updated_at.to_be_bytes());
        digest.update(entity.deleted_at.to_be_bytes());
        revision = revision.max(row.server_cursor);
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
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
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
    fn inventory_kind_query_allows_repeated_desktop_style_values() {
        assert_eq!(
            inventory_kinds_from_query(Some("kind=vocab&kind=app_settings_v1")).unwrap(),
            vec!["app_settings_v1", "vocab"]
        );
        assert!(inventory_kinds_from_query(Some("kind=vocab&unknown=x")).is_err());
    }
}
