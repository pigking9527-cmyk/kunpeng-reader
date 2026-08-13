//! Verified-email password-reset flow.
//!
//! This module holds only the short-lived challenge and session-revocation
//! transaction. Password hashing, session token construction and transport
//! remain in the existing auth/mail boundaries.

use std::net::SocketAddr;

use axum::{
    Extension, Json,
    extract::{ConnectInfo, State, rejection::JsonRejection},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use email_address::EmailAddress;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, types::Json as SqlJson};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    auth::{IssuedSession, SessionResponse, SessionUser, issue_initial_session},
    credentials::{bytes_match, hash_password, new_verification_code, verification_code_digest},
    error::ApiError,
    middleware::RequestContext,
    rate_limit::{check_password_reset_confirm_limits, check_password_reset_request_limits},
    state::AppState,
};

const CHALLENGE_TTL_MS: i64 = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS: i64 = 60 * 1000;
const MAX_CODE_ATTEMPTS: i16 = 5;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordResetRequest {
    pub username: String,
    pub email: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordResetRequestResponse {
    pub ok: bool,
    pub expires_in: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordResetConfirmRequest {
    pub username: String,
    #[schema(value_type = String)]
    pub code: SecretString,
    #[schema(value_type = String, format = Password)]
    pub new_password: SecretString,
    pub installation_id: String,
    #[serde(default)]
    pub device_name: String,
}

#[derive(Debug, FromRow)]
struct ChallengeRow {
    id: Uuid,
    user_id: String,
    username_key: String,
    code_digest: Vec<u8>,
    attempts: i16,
    expires_at: i64,
    consumed_at: i64,
}

#[derive(Debug, FromRow)]
struct ResetUser {
    id: String,
    password_hash: String,
    sync_verified_at: i64,
    data_generation: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordResetMail<'a> {
    challenge_id: Uuid,
    code: &'a str,
    expires_at: i64,
}

#[utoipa::path(
    post,
    path = "/v1/auth/password/reset/request",
    request_body = PasswordResetRequest,
    responses(
        (status = 202, body = PasswordResetRequestResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn request(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<PasswordResetRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if state.config.smtp.is_none() {
        return ApiError::RegistrationUnavailable.response(context);
    }
    let Ok((username_key, email)) = normalize_request_identity(&input.username, &input.email)
    else {
        return ApiError::InvalidRequest.response(context);
    };
    let ip = client_ip(&state, peer, &headers);
    if let Err(error) = check_password_reset_request_limits(&state, ip, &username_key).await {
        return error.response(context);
    }
    if let Err(error) = create_challenge(&state, &username_key, &email).await {
        return error.response(context);
    }
    (
        axum::http::StatusCode::ACCEPTED,
        Json(PasswordResetRequestResponse {
            ok: true,
            expires_in: CHALLENGE_TTL_MS / 1000,
            request_id: context.request_id,
        }),
    )
        .into_response()
}

#[utoipa::path(
    post,
    path = "/v1/auth/password/reset/confirm",
    request_body = PasswordResetConfirmRequest,
    responses(
        (status = 200, body = SessionResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn confirm(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<PasswordResetConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(username_key) = normalize_username(&input.username) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_confirm_request(&input) {
        return ApiError::InvalidRequest.response(context);
    }
    let ip = client_ip(&state, peer, &headers);
    if let Err(error) = check_password_reset_confirm_limits(&state, ip, &username_key).await {
        return error.response(context);
    }
    let response_username = input.username.trim().to_owned();
    match consume_challenge(&state, input, &username_key).await {
        Ok((user, issued)) => Json(SessionResponse {
            ok: true,
            token: Some(issued.token.expose_secret().to_owned()),
            user: SessionUser {
                id: user.id,
                username: response_username,
                sync_enabled: user.sync_verified_at != 0,
            },
            data_generation: user.data_generation,
            sync_enabled: user.sync_verified_at != 0,
            expires_at: issued.expires_at,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

async fn create_challenge(
    state: &AppState,
    username_key: &str,
    email: &str,
) -> Result<(), ApiError> {
    let now = now_ms();
    let challenge_id = Uuid::new_v4();
    let expires_at = now.saturating_add(CHALLENGE_TTL_MS);
    let code = new_verification_code().map_err(|_| ApiError::Internal)?;
    let digest = verification_code_digest(&state.token_hmac_key, challenge_id, &code)
        .map_err(|_| ApiError::Internal)?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('auth-password-reset-request:' || $1, 0))",
    )
    .bind(username_key)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let user = sqlx::query_as::<_, ResetUser>(
        "SELECT users.id,users.password_hash,users.sync_verified_at, \
         generations.generation AS data_generation FROM users \
         JOIN account_emails_v4 emails ON emails.user_id=users.id \
         JOIN account_data_generations generations ON generations.user_id=users.id \
         WHERE users.username_key=$1 AND emails.email=$2 AND users.disabled_at=0",
    )
    .bind(username_key)
    .bind(email)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let too_soon = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM password_reset_challenges_v4 \
         WHERE username_key=$1 AND created_at>$2)",
    )
    .bind(username_key)
    .bind(now.saturating_sub(RESEND_COOLDOWN_MS))
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if let Some(user) = user.filter(|_| !too_soon) {
        sqlx::query(
            "INSERT INTO password_reset_challenges_v4 \
             (id,user_id,username_key,email,code_digest,created_at,expires_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(challenge_id)
        .bind(&user.id)
        .bind(username_key)
        .bind(email)
        .bind(digest.as_slice())
        .bind(now)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        sqlx::query(
            "INSERT INTO mail_outbox_v4 (id,kind,recipient,payload,created_at,available_at) \
             VALUES ($1,$2,$3,$4,$5,$5)",
        )
        .bind(Uuid::new_v4())
        .bind("password_reset")
        .bind(email)
        .bind(SqlJson(PasswordResetMail {
            challenge_id,
            code: code.expose_secret(),
            expires_at,
        }))
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn consume_challenge(
    state: &AppState,
    input: PasswordResetConfirmRequest,
    username_key: &str,
) -> Result<(ResetUser, IssuedSession), ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let challenge = sqlx::query_as::<_, ChallengeRow>(
        "SELECT id,user_id,username_key,code_digest,attempts,expires_at,consumed_at \
         FROM password_reset_challenges_v4 WHERE username_key=$1 \
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(username_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::VerificationInvalid)?;
    let expected = verification_code_digest(&state.token_hmac_key, challenge.id, &input.code)
        .map_err(|_| ApiError::Internal)?;
    let valid = challenge.consumed_at == 0
        && challenge.expires_at > now
        && challenge.attempts < MAX_CODE_ATTEMPTS
        && challenge.username_key == username_key
        && bytes_match(&challenge.code_digest, &expected);
    if !valid {
        sqlx::query(
            "UPDATE password_reset_challenges_v4 SET attempts=LEAST(attempts+1,$2) WHERE id=$1",
        )
        .bind(challenge.id)
        .bind(MAX_CODE_ATTEMPTS)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        transaction
            .commit()
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Err(ApiError::VerificationInvalid);
    }
    let password_hash = hash_password_bounded(state, input.new_password).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('auth-password-reset:' || $1, 0))")
        .bind(&challenge.user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let user = sqlx::query_as::<_, ResetUser>(
        "SELECT users.id,users.password_hash,users.sync_verified_at, \
         generations.generation AS data_generation FROM users \
         JOIN account_data_generations generations ON generations.user_id=users.id \
         WHERE users.id=$1 AND users.disabled_at=0 FOR UPDATE",
    )
    .bind(&challenge.user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::VerificationInvalid)?;
    let updated = sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3")
        .bind(&user.id)
        .bind(&password_hash)
        .bind(&user.password_hash)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::VerificationInvalid);
    }
    sqlx::query("UPDATE password_reset_challenges_v4 SET consumed_at=$2 WHERE id=$1")
        .bind(challenge.id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("UPDATE auth_sessions_v4 SET revoked_at=$2 WHERE user_id=$1 AND revoked_at=0")
        .bind(&user.id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let issued = issue_initial_session(
        &mut transaction,
        state,
        &user.id,
        input.installation_id.trim(),
        input.device_name.trim(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((user, issued))
}

async fn hash_password_bounded(
    state: &AppState,
    password: SecretString,
) -> Result<String, ApiError> {
    let Ok(_permit) = state.password_slots.clone().try_acquire_owned() else {
        return Err(ApiError::Busy);
    };
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|_| ApiError::Internal)?
        .map_err(|_| ApiError::Internal)
}

fn valid_confirm_request(input: &PasswordResetConfirmRequest) -> bool {
    input.code.expose_secret().len() == 6
        && input
            .code
            .expose_secret()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        && (12..=1024).contains(&input.new_password.expose_secret().len())
        && !input.installation_id.trim().is_empty()
        && input.installation_id.len() <= 128
        && input.device_name.len() <= 64
}

fn normalize_request_identity(username: &str, email: &str) -> Result<(String, String), ()> {
    let username_key = normalize_username(username)?;
    let email = email.trim().to_ascii_lowercase();
    if email.len() > 254 || !EmailAddress::is_valid(&email) {
        return Err(());
    }
    Ok((username_key, email))
}

fn normalize_username(username: &str) -> Result<String, ()> {
    let username = username.trim();
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(());
    }
    Ok(username.to_ascii_lowercase())
}

fn client_ip(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    if state.config.trust_loopback_proxy_headers
        && peer.ip().is_loopback()
        && let Some(forwarded) = headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse().ok())
    {
        return forwarded;
    }
    peer.ip()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
