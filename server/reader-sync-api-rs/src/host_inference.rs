//! Feature-gated, account-isolated relay for end-to-end encrypted private
//! intelligence-host inference.  This module is intentionally incapable of
//! decrypting HPKE envelopes: it validates wire shape and ciphertext hashes,
//! then treats every envelope as opaque bytes/JSON.

use std::{fmt::Write as _, sync::LazyLock};

use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use metrics::counter;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::Semaphore,
    task::JoinHandle,
    time::{Duration as TokioDuration, MissedTickBehavior, interval, sleep},
};
use uuid::Uuid;

use crate::{
    auth::authenticate,
    credentials::{bytes_match, derived_intelligence_host_token, intelligence_host_token_digest},
    error::ApiError,
    middleware::RequestContext,
    state::AppState,
};

const OFFER_TTL: Duration = Duration::minutes(10);
#[cfg(test)]
const TASK_DEFAULT_TTL: Duration = Duration::minutes(15);
const TASK_MAX_TTL: Duration = Duration::hours(1);
const RESULT_TTL: Duration = Duration::hours(24);
const MAX_WAIT_SECONDS: u8 = 25;
const RECLAIM_INTERVAL: TokioDuration = TokioDuration::from_mins(1);
const SUITE: &str = "HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305";
const OPERATIONS: &[&str] = &[
    "library_answer",
    "library_compare",
    "reading_deep_analysis",
    "reading_memory",
    "news_preference",
    "news_evidence_review",
    "companion_prompt",
];
// This is intentionally independent of the ordinary HTTP read lane.  Long
// polls must not consume a reader slot, while a stalled host is still bounded.
static LONG_POLL_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateOfferInput {
    pub schema_version: u8,
    /// Generated and retained by the initiating client.  The server stores
    /// only its SHA-256 digest and never returns it.
    pub offer_token: SecretString,
    pub client_key_id: String,
    pub client_public_key: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferResponse {
    pub schema_version: u8,
    pub offer_id: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimOfferInput {
    pub schema_version: u8,
    pub offer_token: SecretString,
    pub host_installation_id: String,
    pub host_key_id: String,
    pub host_public_key: String,
    pub capabilities: Vec<String>,
}

/// Returned only from the successful initial claim. The server persists only
/// a domain-separated HMAC digest; callers must store the plaintext locally.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOfferResponse {
    #[serde(flatten)]
    pub pairing: PairingView,
    pub capability_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    pub schema_version: u8,
    pub pair_id: String,
    pub state: String,
    pub host_installation_id: String,
    pub host_key_id: String,
    pub host_key_fingerprint: String,
    pub client_key_id: String,
    pub capability_revision: i32,
    pub capabilities: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvelopeInput {
    pub schema_version: u8,
    pub suite: String,
    pub recipient_key_id: String,
    pub sender_key_id: String,
    pub enc: String,
    pub ciphertext: String,
    pub ciphertext_sha256: String,
    #[serde(default)]
    pub compression: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRequestInput {
    pub schema_version: u8,
    pub task_id: String,
    pub pair_id: String,
    pub operation: String,
    pub capability_revision: i32,
    pub expires_at: String,
    pub request_envelope: EnvelopeInput,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReceipt {
    pub schema_version: u8,
    pub task_id: String,
    pub state: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTasksResponse {
    pub schema_version: u8,
    pub tasks: Vec<HostTask>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTask {
    pub schema_version: u8,
    pub task_id: String,
    pub pair_id: String,
    pub operation: String,
    pub capability_revision: i32,
    pub state: String,
    pub expires_at: String,
    pub request_envelope: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultInput {
    pub schema_version: u8,
    pub task_id: String,
    pub result_envelope: EnvelopeInput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub schema_version: u8,
    pub task_id: String,
    pub state: String,
    pub expires_at: String,
    pub result_envelope: Value,
}

/// A receipt deliberately stores only a response status and a protocol-safe
/// JSON response body. It is never used for user content.  The one credential
/// response is represented by `ClaimOfferReceipt`, which contains pairing
/// metadata only; the opaque credential itself is deterministically rebuilt
/// from server-held key material when an identical retry arrives.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredReceipt<T> {
    status: u16,
    body: T,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimOfferReceipt {
    pairing: PairingView,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostTaskQuery {
    pub wait: Option<u8>,
}

#[derive(Debug, FromRow)]
struct OfferRow {
    account_id: String,
    offer_digest: Vec<u8>,
    client_key_id: String,
    client_public_key: String,
    state: String,
    expires_at: i64,
}
#[derive(Debug, FromRow)]
struct PairRow {
    pair_id: Uuid,
    account_id: String,
    host_installation_id: String,
    host_key_id: String,
    host_public_key: String,
    host_key_fingerprint: String,
    client_key_id: String,
    client_public_key: String,
    capability_revision: i32,
    capabilities: Vec<String>,
    state: String,
    created_at: i64,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct TaskRow {
    task_id: String,
    pair_id: Uuid,
    #[allow(dead_code)] // selected to make SQL row-account scope explicit
    account_id: String,
    operation: String,
    capability_revision: i32,
    state: String,
    request_envelope: Option<sqlx::types::Json<Value>>,
    result_envelope: Option<sqlx::types::Json<Value>>,
    created_at: i64,
    expires_at: i64,
    cancelled_at: i64,
    completed_at: i64,
    result_expires_at: i64,
}
#[derive(Debug, FromRow)]
struct CredentialRow {
    pair: Uuid,
    host_key: String,
    client_key: String,
    capability_revision: i32,
}
#[derive(Clone)]
struct HostCredential {
    pair: Uuid,
    host_key: String,
    client_key: String,
    capability_revision: i32,
}

/// Content-free counters from one TTL reclaimer pass. They are safe for
/// metrics and tests: no task title, ciphertext, account, pair or host id is
/// retained in this report.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReclaimReport {
    pub offers_deleted: u64,
    pub tasks_expired: u64,
    pub results_purged: u64,
    pub credentials_deleted: u64,
    pub receipts_deleted: u64,
}

/// Starts the local, bounded TTL reclaimer used by the API process. It is
/// inactive while the feature gate is closed; route-level expiry predicates
/// remain authoritative if a tick is delayed or a database operation fails.
pub(crate) fn spawn_reclaimer(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = interval(RECLAIM_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            if !state.config.intelligence_host_inference_enabled {
                continue;
            }
            match reclaim_expired(&state).await {
                Ok(report) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "host_inference_ttl", "outcome" => "success").increment(1);
                    counter!("reader_sync_background_maintenance_items_total", "job" => "host_inference_offers").increment(report.offers_deleted);
                    counter!("reader_sync_background_maintenance_items_total", "job" => "host_inference_tasks").increment(report.tasks_expired + report.results_purged);
                    counter!("reader_sync_background_maintenance_items_total", "job" => "host_inference_credentials").increment(report.credentials_deleted);
                    counter!("reader_sync_background_maintenance_items_total", "job" => "host_inference_receipts").increment(report.receipts_deleted);
                }
                Err(_) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "host_inference_ttl", "outcome" => "error").increment(1);
                }
            }
        }
    })
}

pub async fn create_offer(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<CreateOfferInput>, JsonRejection>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Some((client_key_id, client_public_key)) = validate_client_offer(&input) else {
        return ApiError::InvalidRequest.response(context);
    };
    let digest = hash(input.offer_token.expose_secret().as_bytes());
    let request_hash = hash(&canonical(&serde_json::json!({
        "endpoint": "create_offer",
        "offerTokenDigest": hex(&digest),
        "clientKeyId": client_key_id,
        "clientPublicKey": client_public_key,
    })));
    let now = now_ms();
    let offer_id = Uuid::new_v4();
    let expires = now + duration_ms(OFFER_TTL);
    let Ok(mut tx) = state.pool.begin().await else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    if let Err(error) = cleanup_tx(&mut tx, now).await {
        return error.response(context);
    }
    match receipt::<OfferResponse>(&mut tx, "account", &user.id, &key, request_hash).await {
        Ok(Some(receipt)) => {
            return match tx.commit().await {
                Ok(()) => receipt_response(receipt, context),
                Err(_) => ApiError::DatabaseUnavailable.response(context),
            };
        }
        Ok(None) => {}
        Err(error) => return error.response(context),
    }
    let result = sqlx::query("INSERT INTO intelligence_host_pairing_offers_v1 (offer_id,account_id,offer_digest,client_key_id,client_public_key,state,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)")
        .bind(offer_id).bind(&user.id).bind(digest.as_slice()).bind(&client_key_id).bind(&client_public_key).bind(now).bind(expires).execute(&mut *tx).await;
    if result.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    let response = OfferResponse {
        schema_version: 1,
        offer_id: offer_id.to_string(),
        expires_at: format_ms(expires),
    };
    if let Err(error) = store_receipt(
        &mut tx,
        "account",
        &user.id,
        &key,
        request_hash,
        axum::http::StatusCode::CREATED,
        &response,
    )
    .await
    {
        return error.response(context);
    }
    if tx.commit().await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    (axum::http::StatusCode::CREATED, Json(response)).into_response()
}

#[allow(clippy::too_many_lines)] // Coordinates idempotency, lease transfer, and receipt persistence atomically.
pub async fn claim_offer(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(offer_id): Path<Uuid>,
    input: Result<Json<ClaimOfferInput>, JsonRejection>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Some(claim) = validate_claim(&input) else {
        return ApiError::InvalidRequest.response(context);
    };
    let digest = hash(input.offer_token.expose_secret().as_bytes());
    let request_hash = hash(&canonical(&serde_json::json!({
        "endpoint": "claim_offer",
        "offerId": offer_id,
        "offerTokenDigest": hex(&digest),
        "hostInstallationId": claim.host_installation_id,
        "hostKeyId": claim.host_key_id,
        "hostPublicKey": claim.host_public_key,
        "capabilities": claim.capabilities,
    })));
    let now = now_ms();
    let Ok(mut tx) = state.pool.begin().await else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    if let Err(error) = cleanup_tx(&mut tx, now).await {
        return error.response(context);
    }
    match receipt::<ClaimOfferReceipt>(&mut tx, "account", &user.id, &key, request_hash).await {
        Ok(Some(receipt)) => {
            let Ok(pair_id) = Uuid::parse_str(&receipt.body.pairing.pair_id) else {
                return ApiError::Internal.response(context);
            };
            let Ok(capability_token) = derived_intelligence_host_token(
                &state.token_hmac_key,
                pair_id,
                &receipt.body.pairing.host_installation_id,
            ) else {
                return ApiError::Internal.response(context);
            };
            if tx.commit().await.is_err() {
                return ApiError::DatabaseUnavailable.response(context);
            }
            return Json(ClaimOfferResponse {
                pairing: receipt.body.pairing,
                capability_token: capability_token.expose_secret().to_owned(),
            })
            .into_response();
        }
        Ok(None) => {}
        Err(error) => return error.response(context),
    }
    let offer = sqlx::query_as::<_, OfferRow>("SELECT account_id,offer_digest,client_key_id,client_public_key,state,expires_at FROM intelligence_host_pairing_offers_v1 WHERE offer_id=$1 FOR UPDATE")
        .bind(offer_id).fetch_optional(&mut *tx).await;
    let Ok(Some(offer)) = offer else {
        return ApiError::NotFound.response(context);
    };
    if offer.account_id != user.id
        || offer.state != "PENDING"
        || offer.expires_at <= now
        || !bytes_match(&offer.offer_digest, &digest)
    {
        return ApiError::NotFound.response(context);
    }
    let pair_id = Uuid::new_v4();
    let Ok(capability_token) = derived_intelligence_host_token(
        &state.token_hmac_key,
        pair_id,
        &claim.host_installation_id,
    ) else {
        return ApiError::Internal.response(context);
    };
    let Ok(host_digest) = intelligence_host_token_digest(&state.token_hmac_key, &capability_token)
    else {
        return ApiError::Internal.response(context);
    };
    let fingerprint = hex(&hash(claim.host_public_key.as_bytes()));
    let create = sqlx::query("INSERT INTO intelligence_host_pairings_v1 (pair_id,account_id,host_installation_id,host_key_id,host_public_key,host_key_fingerprint,client_key_id,client_public_key,capability_revision,capabilities,state,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'ACTIVE',$10,$10)")
        .bind(pair_id).bind(&user.id).bind(&claim.host_installation_id).bind(&claim.host_key_id).bind(&claim.host_public_key).bind(&fingerprint).bind(&offer.client_key_id).bind(&offer.client_public_key).bind(&claim.capabilities).bind(now).execute(&mut *tx).await;
    if create.is_err() {
        return ApiError::InvalidRequest.response(context);
    }
    let expires = now + duration_ms(Duration::days(365));
    let credential = sqlx::query("INSERT INTO intelligence_host_credentials_v1 (credential_digest,pair_id,account_id,host_installation_id,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(host_digest.as_slice()).bind(pair_id).bind(&user.id).bind(&claim.host_installation_id).bind(expires).bind(now).execute(&mut *tx).await;
    if credential.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    // The offer token is single-use and is not useful after a pairing exists.
    // Delete it in the same transaction rather than retaining its digest.
    let consumed = sqlx::query(
        "DELETE FROM intelligence_host_pairing_offers_v1 WHERE offer_id=$1 AND state='PENDING'",
    )
    .bind(offer_id)
    .execute(&mut *tx)
    .await;
    if consumed.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    let pairing = PairingView {
        schema_version: 1,
        pair_id: pair_id.to_string(),
        state: "ACTIVE".to_owned(),
        host_installation_id: claim.host_installation_id,
        host_key_id: claim.host_key_id,
        host_key_fingerprint: fingerprint,
        client_key_id: offer.client_key_id,
        capability_revision: 1,
        capabilities: claim.capabilities,
        created_at: format_ms(now),
        updated_at: format_ms(now),
    };
    let receipt = ClaimOfferReceipt {
        pairing: pairing.clone(),
    };
    if let Err(error) = store_receipt(
        &mut tx,
        "account",
        &user.id,
        &key,
        request_hash,
        axum::http::StatusCode::OK,
        &receipt,
    )
    .await
    {
        return error.response(context);
    }
    if tx.commit().await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    Json(ClaimOfferResponse {
        pairing,
        capability_token: capability_token.expose_secret().to_owned(),
    })
    .into_response()
}

pub async fn pairings(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let rows = sqlx::query_as::<_, PairRow>("SELECT pair_id,account_id,host_installation_id,host_key_id,host_public_key,host_key_fingerprint,client_key_id,client_public_key,capability_revision,capabilities,state,created_at,updated_at FROM intelligence_host_pairings_v1 WHERE account_id=$1 ORDER BY updated_at DESC").bind(&user.id).fetch_all(&state.pool).await;
    match rows {
        Ok(rows) => Json(rows.into_iter().map(pairing_view).collect::<Vec<_>>()).into_response(),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

pub async fn revoke_pairing(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(pair_id): Path<Uuid>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let now = now_ms();
    let request_hash = hash(&canonical(&serde_json::json!({
        "endpoint": "revoke_pairing",
        "pairId": pair_id,
    })));
    let Ok(mut tx) = state.pool.begin().await else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    if let Err(error) = cleanup_tx(&mut tx, now).await {
        return error.response(context);
    }
    match receipt::<Value>(&mut tx, "account", &user.id, &key, request_hash).await {
        Ok(Some(receipt)) => {
            return match tx.commit().await {
                Ok(()) => empty_receipt_response(&receipt, context),
                Err(_) => ApiError::DatabaseUnavailable.response(context),
            };
        }
        Ok(None) => {}
        Err(error) => return error.response(context),
    }
    let changed = sqlx::query("UPDATE intelligence_host_pairings_v1 SET state='REVOKED',revoked_at=$3,updated_at=$3 WHERE pair_id=$1 AND account_id=$2 AND state='ACTIVE'").bind(pair_id).bind(&user.id).bind(now).execute(&mut *tx).await;
    let Ok(changed) = changed else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    if changed.rows_affected() != 1 {
        return ApiError::NotFound.response(context);
    }
    let _ = sqlx::query("UPDATE intelligence_host_credentials_v1 SET revoked_at=$2 WHERE pair_id=$1 AND revoked_at=0").bind(pair_id).bind(now).execute(&mut *tx).await;
    let _ = sqlx::query("UPDATE intelligence_host_tasks_v1 SET state='PURGED',request_envelope=NULL,request_ciphertext_sha256=NULL,result_envelope=NULL,result_ciphertext_sha256=NULL,updated_at=$2 WHERE pair_id=$1 AND state NOT IN ('PURGED','EXPIRED')").bind(pair_id).bind(now).execute(&mut *tx).await;
    if let Err(error) = store_receipt(
        &mut tx,
        "account",
        &user.id,
        &key,
        request_hash,
        axum::http::StatusCode::NO_CONTENT,
        &Value::Null,
    )
    .await
    {
        return error.response(context);
    }
    if tx.commit().await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    axum::http::StatusCode::NO_CONTENT.into_response()
}

pub async fn create_task(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<TaskRequestInput>, JsonRejection>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Some((pair_id, expires_at, envelope, digest)) = validate_task_input(&input) else {
        return ApiError::InvalidRequest.response(context);
    };
    let now = now_ms();
    if !(expires_at > now && expires_at <= now + duration_ms(TASK_MAX_TTL)) {
        return ApiError::InvalidRequest.response(context);
    }
    let request_hash = hash(&canonical(
        &serde_json::json!({"taskId":input.task_id,"pairId":input.pair_id,"operation":input.operation,"capabilityRevision":input.capability_revision,"expiresAt":input.expires_at,"ciphertextSha256":input.request_envelope.ciphertext_sha256}),
    ));
    let Ok(mut tx) = state.pool.begin().await else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    if let Err(error) = cleanup_tx(&mut tx, now).await {
        return error.response(context);
    }
    if let Ok(Some(value)) = account_receipt(&mut tx, &user.id, &key, request_hash).await {
        return match tx.commit().await {
            Ok(()) => serde_json::from_value::<TaskReceipt>(value)
                .map(Json)
                .map_or_else(
                    |_| ApiError::DatabaseUnavailable.response(context),
                    IntoResponse::into_response,
                ),
            Err(_) => ApiError::DatabaseUnavailable.response(context),
        };
    }
    let pair = sqlx::query_as::<_, PairRow>("SELECT pair_id,account_id,host_installation_id,host_key_id,host_public_key,host_key_fingerprint,client_key_id,client_public_key,capability_revision,capabilities,state,created_at,updated_at FROM intelligence_host_pairings_v1 WHERE pair_id=$1 AND account_id=$2 FOR UPDATE").bind(pair_id).bind(&user.id).fetch_optional(&mut *tx).await;
    let Ok(Some(pair)) = pair else {
        return ApiError::NotFound.response(context);
    };
    if pair.state != "ACTIVE"
        || pair.capability_revision != input.capability_revision
        || !pair
            .capabilities
            .iter()
            .any(|value| value == &input.operation)
        || input.request_envelope.recipient_key_id != pair.host_key_id
        || input.request_envelope.sender_key_id != pair.client_key_id
    {
        return ApiError::InvalidRequest.response(context);
    }
    let receipt = TaskReceipt {
        schema_version: 1,
        task_id: input.task_id.clone(),
        state: "QUEUED".to_owned(),
        created_at: format_ms(now),
        expires_at: format_ms(expires_at),
        cancelled_at: None,
        completed_at: None,
    };
    let inserted = sqlx::query("INSERT INTO intelligence_host_tasks_v1 (task_id,pair_id,account_id,operation,capability_revision,state,request_envelope,request_ciphertext_sha256,created_at,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9,$8)").bind(&input.task_id).bind(pair_id).bind(&user.id).bind(&input.operation).bind(input.capability_revision).bind(sqlx::types::Json(envelope)).bind(digest.as_slice()).bind(now).bind(expires_at).execute(&mut *tx).await;
    if inserted.is_err() {
        return ApiError::InvalidRequest.response(context);
    }
    if let Err(error) = store_account_receipt(&mut tx, &user.id, &key, request_hash, &receipt).await
    {
        return error.response(context);
    }
    if tx.commit().await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    (axum::http::StatusCode::CREATED, Json(receipt)).into_response()
}

pub async fn host_tasks(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Query(query): Query<HostTaskQuery>,
) -> Response {
    let wait = query.wait.unwrap_or(0);
    if wait > MAX_WAIT_SECONDS {
        return ApiError::InvalidRequest.response(context);
    }
    let credential = match host_credential(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    if wait == 0 {
        return host_tasks_now(&state, &credential, context).await;
    }
    let Ok(_permit) = LONG_POLL_SLOTS.try_acquire() else {
        return ApiError::Busy.response(context);
    };
    let deadline = tokio::time::Instant::now() + TokioDuration::from_secs(u64::from(wait));
    loop {
        match host_tasks_result(&state, &credential).await {
            Ok(result) if !result.tasks.is_empty() => return Json(result).into_response(),
            Ok(_) => {}
            Err(error) => return error.response(context),
        }
        if tokio::time::Instant::now() >= deadline {
            return Json(HostTasksResponse {
                schema_version: 1,
                tasks: Vec::new(),
            })
            .into_response();
        }
        // Dropping the handler future (client disconnect/server shutdown)
        // cancels this sleep and releases the scarce polling permit.
        sleep(TokioDuration::from_millis(250)).await;
    }
}

async fn host_tasks_now(
    state: &AppState,
    credential: &HostCredential,
    context: RequestContext,
) -> Response {
    match host_tasks_result(state, credential).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.response(context),
    }
}

async fn host_tasks_result(
    state: &AppState,
    credential: &HostCredential,
) -> Result<HostTasksResponse, ApiError> {
    reclaim_expired(state).await?;
    let now = now_ms();
    let rows = sqlx::query_as::<_, TaskRow>("SELECT task_id,pair_id,account_id,operation,capability_revision,state,request_envelope,result_envelope,created_at,expires_at,cancelled_at,completed_at,result_expires_at FROM intelligence_host_tasks_v1 WHERE pair_id=$1 AND capability_revision=$2 AND state='QUEUED' AND expires_at>$3 ORDER BY created_at ASC LIMIT 20").bind(credential.pair).bind(credential.capability_revision).bind(now).fetch_all(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(HostTasksResponse {
        schema_version: 1,
        tasks: rows.into_iter().filter_map(host_task).collect(),
    })
}

pub async fn claim_task(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Response {
    let credential = match host_credential(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let _key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let now = now_ms();
    let row = sqlx::query_as::<_, TaskRow>("UPDATE intelligence_host_tasks_v1 SET state='CLAIMED',claimed_at=$4,updated_at=$4 WHERE task_id=$1 AND pair_id=$2 AND capability_revision=$3 AND state='QUEUED' AND expires_at>$4 RETURNING task_id,pair_id,account_id,operation,capability_revision,state,request_envelope,result_envelope,created_at,expires_at,cancelled_at,completed_at,result_expires_at").bind(&task_id).bind(credential.pair).bind(credential.capability_revision).bind(now).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) => host_task(row).map(Json).map_or_else(
            || ApiError::Internal.response(context),
            IntoResponse::into_response,
        ),
        Ok(None) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

pub async fn submit_result(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    input: Result<Json<ResultInput>, JsonRejection>,
) -> Response {
    let credential = match host_credential(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let _key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.schema_version != 1 || input.task_id != task_id {
        return ApiError::InvalidRequest.response(context);
    }
    let Some((envelope, digest)) = validate_envelope(&input.result_envelope) else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.result_envelope.recipient_key_id != credential.client_key
        || input.result_envelope.sender_key_id != credential.host_key
    {
        return ApiError::InvalidRequest.response(context);
    }
    let now = now_ms();
    if cleanup(&state, now).await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    let result_expires = now + duration_ms(RESULT_TTL);
    let changed = sqlx::query("UPDATE intelligence_host_tasks_v1 SET state='RESULT_READY',result_envelope=$5,result_ciphertext_sha256=$6,completed_at=$4,result_expires_at=$7,updated_at=$4 WHERE task_id=$1 AND pair_id=$2 AND capability_revision=$3 AND state IN ('CLAIMED','RUNNING') AND expires_at>$4").bind(&task_id).bind(credential.pair).bind(credential.capability_revision).bind(now).bind(sqlx::types::Json(envelope)).bind(digest.as_slice()).bind(result_expires).execute(&state.pool).await;
    match changed {
        Ok(result) if result.rows_affected() == 1 => Json(TaskReceipt {
            schema_version: 1,
            task_id,
            state: "RESULT_READY".to_owned(),
            created_at: String::new(),
            expires_at: format_ms(result_expires),
            cancelled_at: None,
            completed_at: Some(format_ms(now)),
        })
        .into_response(),
        Ok(_) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

pub async fn task_status(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let now = now_ms();
    if cleanup(&state, now).await.is_err() {
        return ApiError::DatabaseUnavailable.response(context);
    }
    let row = sqlx::query_as::<_, TaskRow>("SELECT task_id,pair_id,account_id,operation,capability_revision,state,request_envelope,result_envelope,created_at,expires_at,cancelled_at,completed_at,result_expires_at FROM intelligence_host_tasks_v1 WHERE task_id=$1 AND account_id=$2").bind(&task_id).bind(&user.id).fetch_optional(&state.pool).await;
    let Ok(Some(row)) = row else {
        return ApiError::NotFound.response(context);
    };
    if row.state == "RESULT_READY"
        && let Some(envelope) = row.result_envelope
    {
        return Json(TaskResult {
            schema_version: 1,
            task_id: row.task_id,
            state: row.state,
            expires_at: format_ms(row.result_expires_at),
            result_envelope: envelope.0,
        })
        .into_response();
    }
    Json(task_receipt(row)).into_response()
}

pub async fn cancel_task(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let _key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let now = now_ms();
    let row = sqlx::query_as::<_, TaskRow>("UPDATE intelligence_host_tasks_v1 SET state='CANCELLED',cancelled_at=$3,request_envelope=NULL,request_ciphertext_sha256=NULL,result_envelope=NULL,result_ciphertext_sha256=NULL,updated_at=$3 WHERE task_id=$1 AND account_id=$2 AND state NOT IN ('PURGED','EXPIRED','CANCELLED') RETURNING task_id,pair_id,account_id,operation,capability_revision,state,request_envelope,result_envelope,created_at,expires_at,cancelled_at,completed_at,result_expires_at").bind(&task_id).bind(&user.id).bind(now).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) => Json(task_receipt(row)).into_response(),
        Ok(None) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

pub async fn ack_task(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = enabled(&state) {
        return error.response(context);
    }
    let _key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.response(context),
    };
    let now = now_ms();
    let changed = sqlx::query("UPDATE intelligence_host_tasks_v1 SET state='PURGED',result_envelope=NULL,result_ciphertext_sha256=NULL,request_envelope=NULL,request_ciphertext_sha256=NULL,updated_at=$3 WHERE task_id=$1 AND account_id=$2 AND state='RESULT_READY'").bind(&task_id).bind(&user.id).bind(now).execute(&state.pool).await;
    match changed {
        Ok(value) if value.rows_affected() == 1 => {
            axum::http::StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => ApiError::NotFound.response(context),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

fn enabled(state: &AppState) -> Result<(), ApiError> {
    state
        .config
        .intelligence_host_inference_enabled
        .then_some(())
        .ok_or(ApiError::IntelligenceHostInferenceDisabled)
}
async fn host_credential(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<HostCredential, ApiError> {
    let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
    let digest = intelligence_host_token_digest(&state.token_hmac_key, &token)
        .map_err(|_| ApiError::Unauthorized)?;
    let now = now_ms();
    let row = sqlx::query_as::<_, CredentialRow>("SELECT c.pair_id AS pair,p.host_key_id AS host_key,p.client_key_id AS client_key,p.capability_revision FROM intelligence_host_credentials_v1 c JOIN intelligence_host_pairings_v1 p ON p.pair_id=c.pair_id WHERE c.credential_digest=$1 AND c.revoked_at=0 AND c.expires_at>$2 AND p.state='ACTIVE'").bind(digest.as_slice()).bind(now).fetch_optional(&state.pool).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(row) = row {
        let _ = sqlx::query("UPDATE intelligence_host_credentials_v1 SET last_used_at=$2 WHERE credential_digest=$1").bind(digest.as_slice()).bind(now).execute(&state.pool).await;
        return Ok(HostCredential {
            pair: row.pair,
            host_key: row.host_key,
            client_key: row.client_key,
            capability_revision: row.capability_revision,
        });
    }
    match authenticate(state, headers).await {
        Ok(_) => Err(ApiError::IntelligenceHostCredentialRequired),
        Err(ApiError::Unauthorized) => Err(ApiError::Unauthorized),
        Err(error) => Err(error),
    }
}
fn validate_client_offer(input: &CreateOfferInput) -> Option<(String, String)> {
    (input.schema_version == 1
        && valid_token(input.offer_token.expose_secret())
        && valid_key_id(&input.client_key_id)
        && valid_base64url(&input.client_public_key))
    .then(|| (input.client_key_id.clone(), input.client_public_key.clone()))
}
struct Claim {
    host_installation_id: String,
    host_key_id: String,
    host_public_key: String,
    capabilities: Vec<String>,
}
fn validate_claim(input: &ClaimOfferInput) -> Option<Claim> {
    (input.schema_version == 1
        && valid_token(input.offer_token.expose_secret())
        && valid_id(&input.host_installation_id)
        && valid_key_id(&input.host_key_id)
        && valid_base64url(&input.host_public_key)
        && valid_capabilities(&input.capabilities))
    .then(|| Claim {
        host_installation_id: input.host_installation_id.clone(),
        host_key_id: input.host_key_id.clone(),
        host_public_key: input.host_public_key.clone(),
        capabilities: input.capabilities.clone(),
    })
}
fn validate_task_input(input: &TaskRequestInput) -> Option<(Uuid, i64, Value, [u8; 32])> {
    let pair_id = Uuid::parse_str(&input.pair_id).ok()?;
    (input.schema_version == 1
        && valid_id(&input.task_id)
        && valid_operation(&input.operation)
        && input.capability_revision >= 1)
        .then_some(())?;
    let expires = OffsetDateTime::parse(&input.expires_at, &Rfc3339)
        .ok()?
        .unix_timestamp_nanos()
        .div_euclid(1_000_000)
        .try_into()
        .ok()?;
    let (envelope, digest) = validate_envelope(&input.request_envelope)?;
    Some((pair_id, expires, envelope, digest))
}
fn validate_envelope(input: &EnvelopeInput) -> Option<(Value, [u8; 32])> {
    if input.schema_version != 1
        || input.suite != SUITE
        || !valid_key_id(&input.recipient_key_id)
        || !valid_key_id(&input.sender_key_id)
        || !valid_base64url(&input.enc)
        || !valid_base64url(&input.ciphertext)
        || !matches!(input.compression.as_deref(), None | Some("none" | "zstd"))
    {
        return None;
    }
    let ciphertext = URL_SAFE_NO_PAD.decode(&input.ciphertext).ok()?;
    let digest = parse_sha256(&input.ciphertext_sha256)?;
    if hash(&ciphertext) != digest {
        return None;
    }
    Some((serde_json::to_value(input).ok()?, digest))
}
fn host_task(row: TaskRow) -> Option<HostTask> {
    let request = row.request_envelope?.0;
    (row.state == "QUEUED" || row.state == "CLAIMED").then(|| HostTask {
        schema_version: 1,
        task_id: row.task_id,
        pair_id: row.pair_id.to_string(),
        operation: row.operation,
        capability_revision: row.capability_revision,
        state: row.state,
        expires_at: format_ms(row.expires_at),
        request_envelope: request,
    })
}
fn task_receipt(row: TaskRow) -> TaskReceipt {
    TaskReceipt {
        schema_version: 1,
        task_id: row.task_id,
        state: row.state,
        created_at: format_ms(row.created_at),
        expires_at: format_ms(row.expires_at),
        cancelled_at: (row.cancelled_at > 0).then(|| format_ms(row.cancelled_at)),
        completed_at: (row.completed_at > 0).then(|| format_ms(row.completed_at)),
    }
}
fn pairing_view(row: PairRow) -> PairingView {
    let _ = (
        &row.account_id,
        &row.host_public_key,
        &row.client_public_key,
    );
    PairingView {
        schema_version: 1,
        pair_id: row.pair_id.to_string(),
        state: row.state,
        host_installation_id: row.host_installation_id,
        host_key_id: row.host_key_id,
        host_key_fingerprint: row.host_key_fingerprint,
        client_key_id: row.client_key_id,
        capability_revision: row.capability_revision,
        capabilities: row.capabilities,
        created_at: format_ms(row.created_at),
        updated_at: format_ms(row.updated_at),
    }
}
async fn cleanup(state: &AppState, now: i64) -> Result<ReclaimReport, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let report = cleanup_tx(&mut tx, now).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(report)
}

/// Applies the expiry gate before a host can observe queued work.  Reads use
/// the same independent expiry predicates, so a temporary database failure
/// can delay physical removal but cannot revive an expired envelope.
async fn reclaim_expired(state: &AppState) -> Result<ReclaimReport, ApiError> {
    cleanup(state, now_ms()).await
}

async fn cleanup_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    now: i64,
) -> Result<ReclaimReport, ApiError> {
    let offers_deleted =
        sqlx::query("DELETE FROM intelligence_host_pairing_offers_v1 WHERE expires_at<=$1")
            .bind(now)
            .execute(&mut **tx)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?
            .rows_affected();
    let tasks_expired = sqlx::query("UPDATE intelligence_host_tasks_v1 SET state='EXPIRED',request_envelope=NULL,request_ciphertext_sha256=NULL,result_envelope=NULL,result_ciphertext_sha256=NULL,updated_at=$1 WHERE expires_at<=$1 AND state NOT IN ('PURGED','EXPIRED','CANCELLED')").bind(now).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.rows_affected();
    let results_purged = sqlx::query("UPDATE intelligence_host_tasks_v1 SET state='PURGED',request_envelope=NULL,request_ciphertext_sha256=NULL,result_envelope=NULL,result_ciphertext_sha256=NULL,updated_at=$1 WHERE state='RESULT_READY' AND result_expires_at<=$1").bind(now).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?.rows_affected();
    let credentials_deleted = sqlx::query(
        "DELETE FROM intelligence_host_credentials_v1 WHERE expires_at<=$1 OR revoked_at>0",
    )
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .rows_affected();
    let receipts_deleted =
        sqlx::query("DELETE FROM intelligence_host_request_receipts_v1 WHERE created_at<=$1")
            .bind(now - duration_ms(RESULT_TTL))
            .execute(&mut **tx)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?
            .rows_affected();
    Ok(ReclaimReport {
        offers_deleted,
        tasks_expired,
        results_purged,
        credentials_deleted,
        receipts_deleted,
    })
}
async fn account_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: &str,
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<Value>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, sqlx::types::Json<Value>)>("SELECT request_hash,response FROM intelligence_host_request_receipts_v1 WHERE actor_kind='account' AND actor_id=$1 AND idempotency_key=$2 FOR UPDATE").bind(account).bind(key).fetch_optional(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some((stored, response)) if bytes_match(&stored, &request_hash) => Ok(Some(response.0)),
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}
async fn store_account_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: &str,
    key: &str,
    request_hash: [u8; 32],
    response: &TaskReceipt,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO intelligence_host_request_receipts_v1 (actor_kind,actor_id,idempotency_key,request_hash,response,created_at) VALUES ('account',$1,$2,$3,$4,$5)").bind(account).bind(key).bind(request_hash.as_slice()).bind(sqlx::types::Json(serde_json::to_value(response).map_err(|_| ApiError::Internal)?)).bind(now_ms()).execute(&mut **tx).await.map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

/// Reads an idempotency receipt for a route whose response is known to be
/// protocol metadata.  Envelopes and credentials must never be passed to this
/// helper: a retry can safely reconstruct a credential from server-held key
/// material, while opaque payloads are intentionally not receipt material.
async fn receipt<T: DeserializeOwned>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor_kind: &str,
    actor_id: &str,
    key: &str,
    request_hash: [u8; 32],
) -> Result<Option<StoredReceipt<T>>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, sqlx::types::Json<Value>)>(
        "SELECT request_hash,response FROM intelligence_host_request_receipts_v1 WHERE actor_kind=$1 AND actor_id=$2 AND idempotency_key=$3 FOR UPDATE",
    )
    .bind(actor_kind)
    .bind(actor_id)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    match row {
        Some((stored, response)) if bytes_match(&stored, &request_hash) => {
            serde_json::from_value(response.0)
                .map(Some)
                .map_err(|_| ApiError::DatabaseUnavailable)
        }
        Some(_) => Err(ApiError::IdempotencyKeyReused),
        None => Ok(None),
    }
}

async fn store_receipt<T: Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor_kind: &str,
    actor_id: &str,
    key: &str,
    request_hash: [u8; 32],
    status: axum::http::StatusCode,
    body: &T,
) -> Result<(), ApiError> {
    let receipt = StoredReceipt {
        status: status.as_u16(),
        body: serde_json::to_value(body).map_err(|_| ApiError::Internal)?,
    };
    sqlx::query(
        "INSERT INTO intelligence_host_request_receipts_v1 (actor_kind,actor_id,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(actor_kind)
    .bind(actor_id)
    .bind(key)
    .bind(request_hash.as_slice())
    .bind(sqlx::types::Json(
        serde_json::to_value(receipt).map_err(|_| ApiError::Internal)?,
    ))
    .bind(now_ms())
    .execute(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

fn receipt_response<T: Serialize>(receipt: StoredReceipt<T>, context: RequestContext) -> Response {
    let Ok(status) = axum::http::StatusCode::from_u16(receipt.status) else {
        return ApiError::Internal.response(context);
    };
    (status, Json(receipt.body)).into_response()
}

fn empty_receipt_response(receipt: &StoredReceipt<Value>, context: RequestContext) -> Response {
    let Ok(status) = axum::http::StatusCode::from_u16(receipt.status) else {
        return ApiError::Internal.response(context);
    };
    status.into_response()
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
fn valid_capabilities(values: &[String]) -> bool {
    !values.is_empty()
        && values.len() <= 32
        && values.iter().all(|value| valid_operation(value))
        && {
            let mut copy = values.to_vec();
            copy.sort_unstable();
            copy.dedup();
            copy.len() == values.len()
        }
}
fn valid_operation(value: &str) -> bool {
    OPERATIONS.contains(&value)
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}
fn valid_key_id(value: &str) -> bool {
    value
        .strip_prefix("key:")
        .is_some_and(|tail| !tail.is_empty() && tail.len() <= 120 && valid_id(tail))
}
fn valid_token(value: &str) -> bool {
    value.len() >= 32 && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_graphic())
}
fn valid_base64url(value: &str) -> bool {
    (16..=11_184_812).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn parse_sha256(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
}
fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("string write");
    }
    output
}
fn canonical(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("serializable request projection")
}
fn now_ms() -> i64 {
    i64::try_from(
        OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000)
            .min(i128::from(i64::MAX)),
    )
    .expect("unix ms fits i64")
}
fn duration_ms(value: Duration) -> i64 {
    i64::try_from(value.whole_milliseconds()).expect("bounded duration")
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
    fn envelope_requires_real_ciphertext_digest_and_no_plaintext_field() {
        let ciphertext = URL_SAFE_NO_PAD.encode(b"opaque-envelope");
        let envelope = EnvelopeInput {
            schema_version: 1,
            suite: SUITE.to_owned(),
            recipient_key_id: "key:recipient".to_owned(),
            sender_key_id: "key:sender".to_owned(),
            enc: URL_SAFE_NO_PAD.encode([7_u8; 16]),
            ciphertext: ciphertext.clone(),
            ciphertext_sha256: hex(&hash(b"opaque-envelope")),
            compression: Some("zstd".to_owned()),
        };
        assert!(validate_envelope(&envelope).is_some());
        let mut tampered = envelope;
        tampered.ciphertext = URL_SAFE_NO_PAD.encode(b"tampered");
        assert!(validate_envelope(&tampered).is_none());
    }

    #[test]
    fn opaque_envelopes_and_idempotency_receipts_round_trip_as_json() {
        let envelope = EnvelopeInput {
            schema_version: 1,
            suite: SUITE.to_owned(),
            recipient_key_id: "key:recipient".to_owned(),
            sender_key_id: "key:sender".to_owned(),
            enc: URL_SAFE_NO_PAD.encode([7_u8; 16]),
            ciphertext: URL_SAFE_NO_PAD.encode(b"opaque-envelope"),
            ciphertext_sha256: hex(&hash(b"opaque-envelope")),
            compression: None,
        };
        let persisted_envelope =
            serde_json::to_value(&envelope).expect("opaque envelope serializes");
        assert!(persisted_envelope.get("ciphertext").is_some());

        let receipt = TaskReceipt {
            schema_version: 1,
            task_id: "task-1".to_owned(),
            state: "QUEUED".to_owned(),
            created_at: "2026-08-24T00:00:00Z".to_owned(),
            expires_at: "2026-08-24T00:15:00Z".to_owned(),
            cancelled_at: None,
            completed_at: None,
        };
        let restored: TaskReceipt =
            serde_json::from_value(serde_json::to_value(&receipt).expect("receipt serializes"))
                .expect("idempotency receipt deserializes");
        assert_eq!(restored.task_id, receipt.task_id);
    }

    #[test]
    fn task_ttl_and_operation_are_bounded_without_reading_payload() {
        assert!(valid_operation("reading_deep_analysis"));
        assert!(!valid_operation("free-form-prompt"));
        assert!(TASK_DEFAULT_TTL < TASK_MAX_TTL);
        assert_eq!(RESULT_TTL, Duration::hours(24));
    }

    #[test]
    fn host_polling_and_reclaiming_are_bounded_and_content_free() {
        let source = include_str!("host_inference.rs");
        assert_eq!(MAX_WAIT_SECONDS, 25);
        assert!(source.contains("LONG_POLL_SLOTS.try_acquire"));
        assert!(source.contains("sleep(TokioDuration::from_millis(250))"));
        assert!(source.contains("DELETE FROM intelligence_host_pairing_offers_v1"));
        assert!(source.contains("state='EXPIRED',request_envelope=NULL"));
        assert!(source.contains("state='RESULT_READY' AND result_expires_at<=$1"));
        assert!(source.contains("DELETE FROM intelligence_host_credentials_v1"));
        assert!(source.contains("DELETE FROM intelligence_host_request_receipts_v1"));
    }

    #[test]
    fn host_writes_require_idempotency_and_revision_mismatch_cannot_run() {
        let source = include_str!("host_inference.rs");
        // V1 deliberately has no capability-update endpoint. A changed
        // capability set must be represented by a new pairing; every host
        // action compares the task revision with the active pairing revision.
        assert!(!include_str!("lib.rs").contains("host-pairings/{pair_id}/capabilities"));
        assert!(source.contains("pair.capability_revision != input.capability_revision"));
        assert!(source.contains("capability_revision=$2 AND state='QUEUED'"));
        assert!(source.contains("capability_revision=$3 AND state='QUEUED'"));
        assert!(source.contains("capability_revision=$3 AND state IN ('CLAIMED','RUNNING')"));
        // create_task stores a receipt; all other mutating endpoint handlers
        // reject a request lacking the same required protocol header.
        assert!(source.matches("idempotency_key(&headers)").count() >= 8);
    }

    #[test]
    fn migration_keeps_only_ciphertext_envelopes_and_account_scopes() {
        let migration = include_str!("../migrations/0030_host_inference_relay_v1.sql");
        assert!(migration.contains("account_id text NOT NULL REFERENCES users"));
        assert!(migration.contains("request_envelope jsonb"));
        assert!(migration.contains("result_envelope jsonb"));
        assert!(!migration.contains("prompt text"));
        assert!(!migration.contains("plaintext text"));
    }

    #[test]
    fn route_queries_keep_account_and_host_scopes_and_purge_ciphertexts() {
        let source = include_str!("host_inference.rs");
        for required_scope in [
            "WHERE pair_id=$1 AND account_id=$2 FOR UPDATE",
            "WHERE task_id=$1 AND account_id=$2",
            "WHERE task_id=$1 AND pair_id=$2 AND capability_revision=$3 AND state='QUEUED'",
            "WHERE c.credential_digest=$1 AND c.revoked_at=0",
        ] {
            assert!(
                source.contains(required_scope),
                "missing scope: {required_scope}"
            );
        }
        assert!(source.contains("state='CANCELLED',cancelled_at=$3,request_envelope=NULL"));
        assert!(source.contains("state='PURGED',result_envelope=NULL"));
        assert!(source.contains("state='RESULT_READY' AND result_expires_at<=$1"));
    }
}
