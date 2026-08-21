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
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, types::Json as SqlJson};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    account_validation::{normalize_username, valid_new_password},
    auth::{SessionResponse, SessionUser, issue_initial_session},
    credentials::{
        bytes_match, hash_password, new_verification_code, phone_number_digest,
        verification_code_digest,
    },
    error::ApiError,
    middleware::RequestContext,
    rate_limit::check_phone_registration_limits,
    state::AppState,
};

const CHALLENGE_TTL_MS: i64 = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS: i64 = 60 * 1000;
const MAX_CODE_ATTEMPTS: i16 = 5;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneRegistrationStartRequest {
    pub username: String,
    pub phone: String,
    pub installation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PhoneRegistrationStartResponse {
    pub ok: bool,
    pub expires_in: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneRegistrationConfirmRequest {
    pub username: String,
    pub phone: String,
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
    phone_digest: Vec<u8>,
    code_digest: Vec<u8>,
    attempts: i16,
    expires_at: i64,
    consumed_at: i64,
    delivered_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmsPayload<'a> {
    code: &'a str,
    expires_minutes: &'static str,
}

#[utoipa::path(
    post,
    path = "/v1/auth/register/phone/start",
    request_body = PhoneRegistrationStartRequest,
    responses(
        (status = 202, body = PhoneRegistrationStartResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn start(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<PhoneRegistrationStartRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Some(sms) = &state.config.sms else {
        return ApiError::PhoneRegistrationUnavailable.response(context);
    };
    let Ok((username, username_key)) = normalize_username(&input.username) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(phone) = normalize_phone(&input.phone) else {
        return ApiError::InvalidRequest.response(context);
    };
    let installation_id = input.installation_id.trim();
    if installation_id.is_empty() || installation_id.len() > 128 {
        return ApiError::InvalidRequest.response(context);
    }
    let client_ip = client_ip(&state, peer, &headers);
    if let Err(error) =
        check_phone_registration_limits(&state, client_ip, &phone, installation_id).await
    {
        return error.response(context);
    }
    match create_challenge(
        &state,
        &username,
        &username_key,
        &phone,
        sms.daily_send_limit,
    )
    .await
    {
        Ok(()) => (
            axum::http::StatusCode::ACCEPTED,
            Json(PhoneRegistrationStartResponse {
                ok: true,
                expires_in: CHALLENGE_TTL_MS / 1000,
                request_id: context.request_id,
            }),
        )
            .into_response(),
        Err(error) => error.response(context),
    }
}

async fn create_challenge(
    state: &AppState,
    username: &str,
    username_key: &str,
    phone: &str,
    daily_limit: u32,
) -> Result<(), ApiError> {
    let now = now_ms();
    let challenge_id = Uuid::new_v4();
    let expires_at = now.saturating_add(CHALLENGE_TTL_MS);
    let code = new_verification_code().map_err(|_| ApiError::Internal)?;
    let code_digest = verification_code_digest(&state.token_hmac_key, challenge_id, &code)
        .map_err(|_| ApiError::Internal)?;
    let phone_digest =
        phone_number_digest(&state.token_hmac_key, phone).map_err(|_| ApiError::Internal)?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let unavailable = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE username_key=$1) \
         OR EXISTS(SELECT 1 FROM account_phones_v5 WHERE phone_digest=$2)",
    )
    .bind(username_key)
    .bind(phone_digest.as_slice())
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let too_soon = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM phone_registration_challenges_v5 \
         WHERE (username_key=$1 OR phone_digest=$2) AND created_at>$3)",
    )
    .bind(username_key)
    .bind(phone_digest.as_slice())
    .bind(now.saturating_sub(RESEND_COOLDOWN_MS))
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if !unavailable && !too_soon {
        let reserved = sqlx::query_scalar::<_, i32>(
            "INSERT INTO sms_daily_usage_v5(utc_day,reserved,delivered) VALUES($1,1,0) \
             ON CONFLICT(utc_day) DO UPDATE SET reserved=sms_daily_usage_v5.reserved+1 \
             WHERE sms_daily_usage_v5.reserved<$2 RETURNING reserved",
        )
        .bind(now.div_euclid(DAY_MS))
        .bind(i32::try_from(daily_limit).unwrap_or(i32::MAX))
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        if reserved.is_none() {
            return Err(ApiError::SmsBudgetExceeded);
        }
        sqlx::query(
            "INSERT INTO phone_registration_challenges_v5 \
             (id,username,username_key,phone_digest,code_digest,created_at,expires_at) \
             VALUES($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(challenge_id)
        .bind(username)
        .bind(username_key)
        .bind(phone_digest.as_slice())
        .bind(code_digest.as_slice())
        .bind(now)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        let queued = sqlx::query(
            "INSERT INTO sms_outbox_v5 \
             (id,challenge_id,kind,recipient,payload,created_at,available_at) \
             VALUES($1,$2,'phone_registration',$3,$4,$5,$5) \
             ON CONFLICT(challenge_id) DO NOTHING",
        )
        .bind(Uuid::new_v4())
        .bind(challenge_id)
        .bind(phone)
        .bind(SqlJson(SmsPayload {
            code: code.expose_secret(),
            expires_minutes: "5",
        }))
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        if queued.rows_affected() != 1 {
            return Err(ApiError::DatabaseUnavailable);
        }
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

#[utoipa::path(
    post,
    path = "/v1/auth/register/phone/confirm",
    request_body = PhoneRegistrationConfirmRequest,
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
    input: Result<Json<PhoneRegistrationConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok((_, username_key)) = normalize_username(&input.username) else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(phone) = normalize_phone(&input.phone) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_code(&input.code)
        || !valid_new_password(input.password.expose_secret())
        || input.installation_id.trim().is_empty()
        || input.installation_id.len() > 128
        || input.device_name.len() > 64
    {
        return ApiError::InvalidRequest.response(context);
    }
    let response_username = input.username.trim().to_owned();
    match consume_challenge(&state, input, &username_key, &phone).await {
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
    input: PhoneRegistrationConfirmRequest,
    username_key: &str,
    phone: &str,
) -> Result<(Uuid, crate::auth::IssuedSession), ApiError> {
    let now = now_ms();
    let phone_digest =
        phone_number_digest(&state.token_hmac_key, phone).map_err(|_| ApiError::Internal)?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let challenge = sqlx::query_as::<_, ChallengeRow>(
        "SELECT c.id,c.username_key,c.phone_digest,c.code_digest,c.attempts,c.expires_at,c.consumed_at, \
         COALESCE(o.delivered_at,0) AS delivered_at FROM phone_registration_challenges_v5 c \
         LEFT JOIN sms_outbox_v5 o ON o.challenge_id=c.id \
         WHERE c.username_key=$1 AND c.phone_digest=$2 \
         ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE OF c",
    )
    .bind(username_key)
    .bind(phone_digest.as_slice())
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
        && challenge.delivered_at > 0
        && challenge.attempts < MAX_CODE_ATTEMPTS
        && challenge.username_key == username_key
        && bytes_match(&challenge.phone_digest, &phone_digest)
        && bytes_match(&challenge.code_digest, &expected);
    if !valid {
        sqlx::query(
            "UPDATE phone_registration_challenges_v5 SET attempts=LEAST(attempts+1,$2) WHERE id=$1",
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
         VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING",
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
    sqlx::query(
        "INSERT INTO account_phones_v5(user_id,phone_digest,last_four,verified_at) VALUES($1,$2,$3,$4)",
    )
    .bind(user_id.to_string())
    .bind(phone_digest.as_slice())
    .bind(&phone[phone.len() - 4..])
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::AccountUnavailable)?;
    sqlx::query("UPDATE phone_registration_challenges_v5 SET consumed_at=$2 WHERE id=$1")
        .bind(challenge.id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("UPDATE sms_outbox_v5 SET recipient='',payload='{}'::jsonb WHERE challenge_id=$1")
        .bind(challenge.id)
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

fn normalize_phone(phone: &str) -> Result<String, ()> {
    let phone = phone.trim();
    let digits = phone.strip_prefix('+').ok_or(())?;
    if !(8..=15).contains(&digits.len())
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(());
    }
    Ok(phone.to_owned())
}

fn valid_code(code: &SecretString) -> bool {
    code.expose_secret().len() == 6
        && code
            .expose_secret()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
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
    fn phone_requires_canonical_e164() {
        assert_eq!(normalize_phone("+8613711112222").unwrap(), "+8613711112222");
        for invalid in ["13711112222", "+012345678", "+123", "+86 13711112222"] {
            assert!(normalize_phone(invalid).is_err(), "{invalid}");
        }
    }
}
