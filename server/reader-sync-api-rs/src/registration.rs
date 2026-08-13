use std::{
    net::SocketAddr,
    time::{SystemTime, UNIX_EPOCH},
};

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
    auth::{SessionResponse, SessionUser, issue_initial_session},
    credentials::{bytes_match, hash_password, new_verification_code, verification_code_digest},
    error::ApiError,
    middleware::RequestContext,
    rate_limit::check_registration_limits,
    state::AppState,
};

const CHALLENGE_TTL_MS: i64 = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS: i64 = 60 * 1000;
const MAX_CODE_ATTEMPTS: i16 = 5;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStartRequest {
    pub username: String,
    pub email: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStartResponse {
    pub ok: bool,
    pub expires_in: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationConfirmRequest {
    pub username: String,
    pub email: String,
    #[schema(value_type = String)]
    pub code: SecretString,
    #[schema(value_type = String, format = Password)]
    pub password: SecretString,
    pub installation_id: String,
    #[serde(default)]
    pub device_name: String,
}

#[derive(Debug, FromRow)]
struct ChallengeRow {
    id: Uuid,
    username_key: String,
    email: String,
    code_digest: Vec<u8>,
    attempts: i16,
    expires_at: i64,
    consumed_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationMail<'a> {
    challenge_id: Uuid,
    code: &'a str,
    expires_at: i64,
}

#[utoipa::path(
    post,
    path = "/v1/auth/register/start",
    request_body = RegistrationStartRequest,
    responses(
        (status = 202, body = RegistrationStartResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn start(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<RegistrationStartRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if state.config.smtp.is_none() {
        return ApiError::RegistrationUnavailable.response(context);
    }
    let Ok((username, username_key, email)) = normalize_identity(&input.username, &input.email)
    else {
        return ApiError::InvalidRequest.response(context);
    };
    let client_ip = client_ip(&state, peer, &headers);
    if let Err(error) = check_registration_limits(&state, client_ip, &email).await {
        return error.response(context);
    }
    match create_challenge(&state, &username, &username_key, &email).await {
        Ok(()) => (
            axum::http::StatusCode::ACCEPTED,
            Json(RegistrationStartResponse {
                ok: true,
                expires_in: CHALLENGE_TTL_MS / 1000,
                request_id: context.request_id,
            }),
        )
            .into_response(),
        Err(error) => error.response(context),
    }
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

pub async fn legacy_register(Extension(context): Extension<RequestContext>) -> Response {
    ApiError::RegistrationEmailRequired.response(context)
}

async fn create_challenge(
    state: &AppState,
    username: &str,
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
    let unavailable = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE username_key=$1) \
         OR EXISTS(SELECT 1 FROM account_emails_v4 WHERE email=$2)",
    )
    .bind(username_key)
    .bind(email)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let too_soon = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM registration_challenges_v4 \
         WHERE (username_key=$1 OR email=$2) AND created_at>$3)",
    )
    .bind(username_key)
    .bind(email)
    .bind(now.saturating_sub(RESEND_COOLDOWN_MS))
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if !unavailable && !too_soon {
        sqlx::query(
            "INSERT INTO registration_challenges_v4 \
             (id,username,username_key,email,code_digest,created_at,expires_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(challenge_id)
        .bind(username)
        .bind(username_key)
        .bind(email)
        .bind(digest.as_slice())
        .bind(now)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        sqlx::query(
            "INSERT INTO mail_outbox_v4 \
             (id,kind,recipient,payload,created_at,available_at) VALUES ($1,$2,$3,$4,$5,$5)",
        )
        .bind(Uuid::new_v4())
        .bind("registration_verification")
        .bind(email)
        .bind(SqlJson(RegistrationMail {
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
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

#[utoipa::path(
    post,
    path = "/v1/auth/register/confirm",
    request_body = RegistrationConfirmRequest,
    responses(
        (status = 201, body = SessionResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn confirm(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    input: Result<Json<RegistrationConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok((_, username_key, email)) = normalize_identity(&input.username, &input.email) else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.code.expose_secret().len() != 6
        || !input
            .code
            .expose_secret()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        || !(8..=1024).contains(&input.password.expose_secret().len())
        || input.installation_id.trim().is_empty()
        || input.installation_id.len() > 128
        || input.device_name.len() > 64
    {
        return ApiError::InvalidRequest.response(context);
    }
    let response_username = input.username.trim().to_owned();
    match consume_challenge(&state, input, &username_key, &email).await {
        Ok((user_id, issued)) => (
            axum::http::StatusCode::CREATED,
            Json(SessionResponse {
                ok: true,
                token: Some(issued.token.expose_secret().to_owned()),
                user: SessionUser {
                    id: user_id.to_string(),
                    username: response_username,
                    sync_enabled: true,
                },
                data_generation: 1,
                sync_enabled: true,
                expires_at: issued.expires_at,
                request_id: context.request_id,
            }),
        )
            .into_response(),
        Err(error) => error.response(context),
    }
}

async fn consume_challenge(
    state: &AppState,
    input: RegistrationConfirmRequest,
    username_key: &str,
    email: &str,
) -> Result<(Uuid, crate::auth::IssuedSession), ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let challenge = sqlx::query_as::<_, ChallengeRow>(
        "SELECT id,username_key,email,code_digest,attempts,expires_at,consumed_at \
         FROM registration_challenges_v4 WHERE username_key=$1 AND email=$2 \
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(username_key)
    .bind(email)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let Some(challenge) = challenge else {
        return Err(ApiError::VerificationInvalid);
    };
    let expected = verification_code_digest(&state.token_hmac_key, challenge.id, &input.code)
        .map_err(|_| ApiError::Internal)?;
    let valid = challenge.consumed_at == 0
        && challenge.expires_at > now
        && challenge.attempts < MAX_CODE_ATTEMPTS
        && challenge.username_key == username_key
        && challenge.email == email
        && bytes_match(&challenge.code_digest, &expected);
    if !valid {
        sqlx::query(
            "UPDATE registration_challenges_v4 SET attempts=LEAST(attempts+1,$2) WHERE id=$1",
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
    let password_hash = hash_password_bounded(state, input.password).await?;
    let user_id = Uuid::new_v4();
    let created = sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING",
    )
    .bind(user_id.to_string())
    .bind(input.username.trim())
    .bind(username_key)
    .bind(password_hash)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if created.rows_affected() != 1 {
        return Err(ApiError::AccountUnavailable);
    }
    sqlx::query("INSERT INTO account_emails_v4(user_id,email,verified_at) VALUES ($1,$2,$3)")
        .bind(user_id.to_string())
        .bind(email)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::AccountUnavailable)?;
    sqlx::query("UPDATE registration_challenges_v4 SET consumed_at=$2 WHERE id=$1")
        .bind(challenge.id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let issued = issue_initial_session(
        &mut transaction,
        state,
        &user_id.to_string(),
        input.installation_id.trim(),
        input.device_name.trim(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((user_id, issued))
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

fn normalize_identity(username: &str, email: &str) -> Result<(String, String, String), ()> {
    let username = username.trim();
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(());
    }
    let email = email.trim().to_ascii_lowercase();
    if email.len() > 254 || !EmailAddress::is_valid(&email) {
        return Err(());
    }
    Ok((username.to_owned(), username.to_ascii_lowercase(), email))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
