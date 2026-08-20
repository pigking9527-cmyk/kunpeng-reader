use axum::{
    Json,
    extract::{Extension, State},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{error::ApiError, middleware::RequestContext, state::AppState};

pub const SYNC_PROTOCOL_VERSION: u16 = 5;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub service: &'static str,
    pub sync_protocol_version: u16,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub ok: bool,
    pub sync_protocol_version: u16,
    pub request_id: Uuid,
}

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, body = HealthResponse))
)]
pub async fn health(Extension(context): Extension<RequestContext>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "reader-sync-api",
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
        request_id: context.request_id,
    })
}

#[utoipa::path(
    get,
    path = "/ready",
    responses(
        (status = 200, body = HealthResponse),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn ready(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Response {
    match sqlx::query_scalar::<_, bool>(
        "SELECT to_regclass('public.users') IS NOT NULL \
         AND to_regclass('public.auth_sessions_v4') IS NOT NULL \
         AND to_regclass('public.account_emails_v4') IS NOT NULL \
         AND to_regclass('public.account_phones_v5') IS NOT NULL \
         AND to_regclass('public.account_data_generations') IS NOT NULL \
         AND to_regclass('public.sync_entities_v4') IS NOT NULL \
         AND to_regclass('public.sync_push_receipts_v4') IS NOT NULL \
         AND to_regclass('public.registration_challenges_v4') IS NOT NULL \
         AND to_regclass('public.phone_registration_challenges_v5') IS NOT NULL \
         AND to_regclass('public.password_reset_challenges_v4') IS NOT NULL \
         AND to_regclass('public.account_email_challenges_v5') IS NOT NULL \
         AND to_regclass('public.account_email_rebind_grants_v5') IS NOT NULL \
         AND to_regclass('public.sync_secret_bundle_epochs_v5') IS NOT NULL \
         AND to_regclass('public.mail_outbox_v4') IS NOT NULL \
         AND to_regclass('public.sms_outbox_v5') IS NOT NULL \
         AND to_regclass('public.sms_daily_usage_v5') IS NOT NULL \
         AND to_regclass('public.rate_limit_buckets_v4') IS NOT NULL \
         AND to_regclass('public.account_daily_usage_v4') IS NOT NULL \
         AND to_regclass('public.sync_assets_v4') IS NOT NULL \
         AND to_regclass('public.feedback_v4') IS NOT NULL \
         AND EXISTS(SELECT 1 FROM rust_service_metadata \
                    WHERE key='sync_protocol_version' AND value='5')",
    )
    .fetch_one(&state.pool)
    .await
    {
        Ok(true) => Json(HealthResponse {
            ok: true,
            service: "reader-sync-api",
            sync_protocol_version: SYNC_PROTOCOL_VERSION,
            request_id: context.request_id,
        })
        .into_response(),
        Ok(false) | Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

pub async fn metrics(State(state): State<AppState>) -> String {
    state.metrics.render()
}

#[utoipa::path(
    get,
    path = "/v1/sync/status",
    params(("X-Sync-Protocol-Version" = u16, Header, description = "Must be 5")),
    responses(
        (status = 200, body = SyncStatusResponse),
        (status = 426, body = crate::error::ErrorBody)
    )
)]
pub async fn sync_status(
    Extension(context): Extension<RequestContext>,
) -> Json<SyncStatusResponse> {
    Json(SyncStatusResponse {
        ok: true,
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
        request_id: context.request_id,
    })
}

pub async fn not_found(Extension(context): Extension<RequestContext>) -> Response {
    ApiError::NotFound.response(context)
}
