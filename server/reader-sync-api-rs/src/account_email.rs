//! Authenticated email bind and rebind lifecycle.
//!
//! The opaque rebind grant proves control of the old mailbox and is stored
//! only as an HMAC digest. Email verification codes are independently hashed,
//! one-time, and short-lived.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use email_address::EmailAddress;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction, types::Json as SqlJson};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    auth::authenticate,
    credentials::{
        bytes_match, new_rebind_grant, new_verification_code, rebind_grant_digest,
        verification_code_digest,
    },
    error::ApiError,
    middleware::RequestContext,
    rate_limit::check_account_email_limits,
    state::AppState,
};

const CHALLENGE_TTL_MS: i64 = 15 * 60 * 1000;
const GRANT_TTL_MS: i64 = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS: i16 = 5;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmailStartRequest {
    pub email: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmailConfirmRequest {
    pub email: String,
    #[schema(value_type = String)]
    pub code: SecretString,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebindOldConfirmRequest {
    #[schema(value_type = String)]
    pub code: SecretString,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebindNewStartRequest {
    pub email: String,
    #[schema(value_type = String)]
    pub rebind_grant: SecretString,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmailChallengeResponse {
    pub ok: bool,
    pub expires_in: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RebindGrantResponse {
    pub ok: bool,
    pub rebind_grant: String,
    pub request_id: Uuid,
}

#[derive(Debug, FromRow)]
struct ChallengeRow {
    id: Uuid,
    code_digest: Vec<u8>,
    attempts: i16,
    expires_at: i64,
    consumed_at: i64,
}

#[derive(Debug, FromRow)]
struct GrantRow {
    id: Uuid,
    token_digest: Vec<u8>,
    expires_at: i64,
    consumed_at: i64,
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/start",
    request_body = EmailStartRequest,
    responses((status = 202, body = EmailChallengeResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody), (status = 429, body = crate::error::ErrorBody), (status = 503, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn bind_start(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<EmailStartRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(email) = normalize_email(&input.email) else {
        return ApiError::InvalidRequest.response(context);
    };
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_account_email_limits(&state, &user.id).await {
        return error.response(context);
    }
    if state.config.smtp.is_none() {
        return ApiError::RegistrationUnavailable.response(context);
    }
    match start_bind(&state, &user.id, &email).await {
        Ok(()) => accepted_challenge_response(context),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/confirm",
    request_body = EmailConfirmRequest,
    responses((status = 200, body = EmailChallengeResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn bind_confirm(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<EmailConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(email) = normalize_email(&input.email) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_code(&input.code) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    match confirm_bind(&state, &user.id, &email, &input.code).await {
        Ok(()) => challenge_response(context).into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/rebind/old/start",
    responses((status = 202, body = EmailChallengeResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody), (status = 429, body = crate::error::ErrorBody), (status = 503, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn rebind_old_start(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_account_email_limits(&state, &user.id).await {
        return error.response(context);
    }
    if state.config.smtp.is_none() {
        return ApiError::RegistrationUnavailable.response(context);
    }
    match bound_email(&state, &user.id).await {
        Ok(Some(email)) => match issue_challenge(&state, &user.id, "rebind_old", &email).await {
            Ok(()) => accepted_challenge_response(context),
            Err(error) => error.response(context),
        },
        Ok(None) => ApiError::EmailNotBound.response(context),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/rebind/old/confirm",
    request_body = RebindOldConfirmRequest,
    responses((status = 200, body = RebindGrantResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn rebind_old_confirm(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<RebindOldConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_code(&input.code) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let email = match bound_email(&state, &user.id).await {
        Ok(Some(email)) => email,
        Ok(None) => return ApiError::EmailNotBound.response(context),
        Err(error) => return error.response(context),
    };
    match confirm_old_and_issue_grant(&state, &user.id, &email, &input.code).await {
        Ok(grant) => Json(RebindGrantResponse {
            ok: true,
            rebind_grant: grant.expose_secret().to_owned(),
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/rebind/new/start",
    request_body = RebindNewStartRequest,
    responses((status = 202, body = EmailChallengeResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody), (status = 429, body = crate::error::ErrorBody), (status = 503, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn rebind_new_start(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<RebindNewStartRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(email) = normalize_email(&input.email) else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.rebind_grant.expose_secret().is_empty()
        || input.rebind_grant.expose_secret().len() > 256
    {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_account_email_limits(&state, &user.id).await {
        return error.response(context);
    }
    if state.config.smtp.is_none() {
        return ApiError::RegistrationUnavailable.response(context);
    }
    match start_rebind_new(&state, &user.id, &email, &input.rebind_grant).await {
        Ok(()) => accepted_challenge_response(context),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/email/rebind/new/confirm",
    request_body = EmailConfirmRequest,
    responses((status = 200, body = EmailChallengeResponse), (status = 400, body = crate::error::ErrorBody), (status = 401, body = crate::error::ErrorBody), (status = 409, body = crate::error::ErrorBody)),
    security(("bearer_token" = []))
)]
pub async fn rebind_new_confirm(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<EmailConfirmRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let Ok(email) = normalize_email(&input.email) else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_code(&input.code) {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    match confirm_new_email(&state, &user.id, &email, &input.code).await {
        Ok(()) => challenge_response(context).into_response(),
        Err(error) => error.response(context),
    }
}

fn challenge_response(context: RequestContext) -> Json<EmailChallengeResponse> {
    Json(EmailChallengeResponse {
        ok: true,
        expires_in: CHALLENGE_TTL_MS / 1_000,
        request_id: context.request_id,
    })
}

fn accepted_challenge_response(context: RequestContext) -> Response {
    (StatusCode::ACCEPTED, challenge_response(context)).into_response()
}

fn normalize_email(value: &str) -> Result<String, ()> {
    let email = value.trim().to_ascii_lowercase();
    (email.len() <= 254 && EmailAddress::is_valid(&email))
        .then_some(email)
        .ok_or(())
}

fn valid_code(code: &SecretString) -> bool {
    code.expose_secret().len() == 6
        && code
            .expose_secret()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
}

async fn start_bind(state: &AppState, user_id: &str, email: &str) -> Result<(), ApiError> {
    if bound_email(state, user_id).await?.is_some() || email_owner_exists(state, email).await? {
        return Err(ApiError::EmailAlreadyBound);
    }
    issue_challenge(state, user_id, "bind_email", email).await
}

async fn bound_email(state: &AppState, user_id: &str) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT email FROM account_emails_v4 WHERE user_id=$1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn email_owner_exists(state: &AppState, email: &str) -> Result<bool, ApiError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_emails_v4 WHERE email=$1)")
        .bind(email)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn issue_challenge(
    state: &AppState,
    user_id: &str,
    purpose: &str,
    email: &str,
) -> Result<(), ApiError> {
    let challenge_id = Uuid::new_v4();
    let code = new_verification_code().map_err(|_| ApiError::Internal)?;
    let digest = verification_code_digest(&state.token_hmac_key, challenge_id, &code)
        .map_err(|_| ApiError::Internal)?;
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "DELETE FROM account_email_challenges_v5 WHERE user_id=$1 AND purpose=$2 AND email=$3",
    )
    .bind(user_id)
    .bind(purpose)
    .bind(email)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "INSERT INTO account_email_challenges_v5 \
         (id,user_id,purpose,email,code_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(challenge_id)
    .bind(user_id)
    .bind(purpose)
    .bind(email)
    .bind(digest.as_slice())
    .bind(now)
    .bind(now.saturating_add(CHALLENGE_TTL_MS))
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "INSERT INTO mail_outbox_v4(id,kind,recipient,payload,created_at,available_at) \
         VALUES($1,$2,$3,$4,$5,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(purpose)
    .bind(email)
    .bind(SqlJson(serde_json::json!({"code": code.expose_secret()})))
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn confirm_bind(
    state: &AppState,
    user_id: &str,
    email: &str,
    code: &SecretString,
) -> Result<(), ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if email_bound_transaction(&mut transaction, user_id)
        .await?
        .is_some()
        || email_owner_transaction(&mut transaction, email).await?
    {
        return Err(ApiError::EmailAlreadyBound);
    }
    consume_challenge(
        &mut transaction,
        &state.token_hmac_key,
        user_id,
        "bind_email",
        email,
        code,
    )
    .await?;
    let now = now_ms();
    sqlx::query("INSERT INTO account_emails_v4(user_id,email,verified_at) VALUES($1,$2,$3)")
        .bind(user_id)
        .bind(email)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::EmailAlreadyBound)?;
    sqlx::query("UPDATE users SET sync_verified_at=$2 WHERE id=$1")
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn confirm_old_and_issue_grant(
    state: &AppState,
    user_id: &str,
    email: &str,
    code: &SecretString,
) -> Result<SecretString, ApiError> {
    let grant = new_rebind_grant().map_err(|_| ApiError::Internal)?;
    let digest =
        rebind_grant_digest(&state.token_hmac_key, &grant).map_err(|_| ApiError::Internal)?;
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    consume_challenge(
        &mut transaction,
        &state.token_hmac_key,
        user_id,
        "rebind_old",
        email,
        code,
    )
    .await?;
    sqlx::query("DELETE FROM account_email_rebind_grants_v5 WHERE user_id=$1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "INSERT INTO account_email_rebind_grants_v5(id,user_id,old_email,token_digest,created_at,expires_at) \
         VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(email)
    .bind(digest.as_slice())
    .bind(now)
    .bind(now.saturating_add(GRANT_TTL_MS))
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(grant)
}

async fn start_rebind_new(
    state: &AppState,
    user_id: &str,
    email: &str,
    grant: &SecretString,
) -> Result<(), ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let Some(old_email) = email_bound_transaction(&mut transaction, user_id).await? else {
        return Err(ApiError::EmailNotBound);
    };
    if old_email == email {
        return Err(ApiError::EmailUnchanged);
    }
    if email_owner_transaction(&mut transaction, email).await? {
        return Err(ApiError::EmailAlreadyBound);
    }
    consume_grant(
        &mut transaction,
        &state.token_hmac_key,
        user_id,
        &old_email,
        grant,
    )
    .await?;
    issue_challenge_in_transaction(
        &mut transaction,
        &state.token_hmac_key,
        user_id,
        "rebind_new",
        email,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn confirm_new_email(
    state: &AppState,
    user_id: &str,
    email: &str,
    code: &SecretString,
) -> Result<(), ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if email_owner_transaction(&mut transaction, email).await? {
        return Err(ApiError::EmailAlreadyBound);
    }
    consume_challenge(
        &mut transaction,
        &state.token_hmac_key,
        user_id,
        "rebind_new",
        email,
        code,
    )
    .await?;
    let changed =
        sqlx::query("UPDATE account_emails_v4 SET email=$2,verified_at=$3 WHERE user_id=$1")
            .bind(user_id)
            .bind(email)
            .bind(now_ms())
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiError::EmailAlreadyBound)?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::EmailNotBound);
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn consume_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    key: &SecretString,
    user_id: &str,
    purpose: &str,
    email: &str,
    code: &SecretString,
) -> Result<(), ApiError> {
    let challenge = sqlx::query_as::<_, ChallengeRow>(
        "SELECT id,code_digest,attempts,expires_at,consumed_at FROM account_email_challenges_v5 \
         WHERE user_id=$1 AND purpose=$2 AND email=$3 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(user_id)
    .bind(purpose)
    .bind(email)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::EmailVerificationInvalid)?;
    let expected =
        verification_code_digest(key, challenge.id, code).map_err(|_| ApiError::Internal)?;
    let valid = challenge.consumed_at == 0
        && challenge.expires_at > now_ms()
        && challenge.attempts < MAX_CODE_ATTEMPTS
        && bytes_match(&challenge.code_digest, &expected);
    if !valid {
        sqlx::query(
            "UPDATE account_email_challenges_v5 SET attempts=LEAST(attempts+1,$2) WHERE id=$1",
        )
        .bind(challenge.id)
        .bind(MAX_CODE_ATTEMPTS)
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        return Err(ApiError::EmailVerificationInvalid);
    }
    sqlx::query("UPDATE account_email_challenges_v5 SET consumed_at=$2 WHERE id=$1")
        .bind(challenge.id)
        .bind(now_ms())
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn consume_grant(
    transaction: &mut Transaction<'_, Postgres>,
    key: &SecretString,
    user_id: &str,
    old_email: &str,
    grant: &SecretString,
) -> Result<(), ApiError> {
    let row = sqlx::query_as::<_, GrantRow>(
        "SELECT id,token_digest,expires_at,consumed_at FROM account_email_rebind_grants_v5 \
         WHERE user_id=$1 AND old_email=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(user_id)
    .bind(old_email)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::RebindGrantInvalid)?;
    let digest = rebind_grant_digest(key, grant).map_err(|_| ApiError::Internal)?;
    if row.consumed_at != 0
        || row.expires_at <= now_ms()
        || !bytes_match(&row.token_digest, &digest)
    {
        return Err(ApiError::RebindGrantInvalid);
    }
    sqlx::query("UPDATE account_email_rebind_grants_v5 SET consumed_at=$2 WHERE id=$1")
        .bind(row.id)
        .bind(now_ms())
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

async fn email_bound_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT email FROM account_emails_v4 WHERE user_id=$1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn email_owner_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    email: &str,
) -> Result<bool, ApiError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_emails_v4 WHERE email=$1)")
        .bind(email)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

async fn issue_challenge_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    key: &SecretString,
    user_id: &str,
    purpose: &str,
    email: &str,
) -> Result<(), ApiError> {
    let challenge_id = Uuid::new_v4();
    let code = new_verification_code().map_err(|_| ApiError::Internal)?;
    let digest =
        verification_code_digest(key, challenge_id, &code).map_err(|_| ApiError::Internal)?;
    let now = now_ms();
    sqlx::query(
        "DELETE FROM account_email_challenges_v5 WHERE user_id=$1 AND purpose=$2 AND email=$3",
    )
    .bind(user_id)
    .bind(purpose)
    .bind(email)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "INSERT INTO account_email_challenges_v5 \
         (id,user_id,purpose,email,code_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(challenge_id)
    .bind(user_id)
    .bind(purpose)
    .bind(email)
    .bind(digest.as_slice())
    .bind(now)
    .bind(now.saturating_add(CHALLENGE_TTL_MS))
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "INSERT INTO mail_outbox_v4(id,kind,recipient,payload,created_at,available_at) \
         VALUES($1,$2,$3,$4,$5,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(purpose)
    .bind(email)
    .bind(SqlJson(serde_json::json!({"code": code.expose_secret()})))
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
