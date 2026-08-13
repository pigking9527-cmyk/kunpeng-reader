use std::{
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    credentials::{hash_password, new_session_token, session_token_digest, verify_password},
    error::ApiError,
    middleware::RequestContext,
    rate_limit::{check_account_delete_limits, check_password_change_limits},
    state::AppState,
};

const SESSION_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DEVICES: i64 = 5;
const LAST_USED_WRITE_INTERVAL_MS: i64 = 5 * 60 * 1000;
static DUMMY_PASSWORD_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password(&SecretString::from("kunpeng-dummy-password-v4".to_owned()))
        .unwrap_or_else(|_| "$argon2id$invalid".to_owned())
});

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    #[schema(value_type = String, format = Password)]
    pub password: SecretString,
    pub installation_id: String,
    #[serde(default)]
    pub device_name: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub ok: bool,
    pub token: Option<String>,
    pub user: SessionUser,
    pub data_generation: i64,
    pub sync_enabled: bool,
    pub expires_at: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub sync_enabled: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResponse {
    pub ok: bool,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordChangeRequest {
    #[schema(value_type = String, format = Password)]
    pub current_password: SecretString,
    #[schema(value_type = String, format = Password)]
    pub new_password: SecretString,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChangeResponse {
    pub ok: bool,
    pub message: &'static str,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct SecurityStatusResponse {
    pub ok: bool,
    pub email_bound: bool,
    pub email: String,
    pub recovery_available: bool,
    pub mail_configured: bool,
    pub sync_enabled: bool,
    pub request_id: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageResponse {
    pub ok: bool,
    pub storage_bytes: u64,
    pub storage_limit_bytes: u64,
    pub daily_written_bytes: u64,
    pub daily_write_limit_bytes: u64,
    pub daily_entity_writes: u64,
    pub daily_entity_write_limit: u64,
    pub daily_window_at: i64,
    pub daily_reset_at: i64,
    pub request_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountDeleteRequest {
    #[schema(value_type = String, format = Password)]
    pub password: SecretString,
    pub username: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeleteResponse {
    pub ok: bool,
    pub account_deleted: bool,
    pub request_id: Uuid,
}

#[derive(Debug, FromRow)]
struct UserRow {
    id: String,
    username: String,
    password_hash: String,
    sync_verified_at: i64,
    disabled_at: i64,
    data_generation: i64,
}

#[derive(Debug, FromRow)]
pub(crate) struct AuthenticatedUser {
    pub id: String,
    pub username: String,
    pub sync_verified_at: i64,
    disabled_at: i64,
    pub data_generation: i64,
    pub expires_at: i64,
}

struct ValidatedLogin {
    username: String,
    password: SecretString,
    installation_id: String,
    device_name: String,
}

pub(crate) struct IssuedSession {
    pub token: SecretString,
    pub expires_at: i64,
}

#[utoipa::path(
    post,
    path = "/v1/auth/login",
    request_body = LoginRequest,
    responses(
        (status = 200, body = SessionResponse),
        (status = 401, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn login(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    input: Result<Json<LoginRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    let input = match validate_login(input) {
        Ok(input) => input,
        Err(error) => return error.response(context),
    };
    let user = match find_user(&state, &input.username).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let stored_hash = user.as_ref().map(|user| user.password_hash.clone());
    match verify_login_password(&state, input.password, stored_hash).await {
        Ok(()) => {}
        Err(error) => return error.response(context),
    }
    let Some(user) = user else {
        return ApiError::InvalidCredentials.response(context);
    };
    if user.disabled_at != 0 {
        return ApiError::AccountDisabled.response(context);
    }
    let issued =
        match issue_session(&state, &user.id, &input.installation_id, &input.device_name).await {
            Ok(issued) => issued,
            Err(error) => return error.response(context),
        };

    Json(SessionResponse {
        ok: true,
        token: Some(issued.token.expose_secret().to_owned()),
        user: SessionUser {
            id: user.id,
            username: user.username,
            sync_enabled: user.sync_verified_at != 0,
        },
        data_generation: user.data_generation,
        sync_enabled: user.sync_verified_at != 0,
        expires_at: issued.expires_at,
        request_id: context.request_id,
    })
    .into_response()
}

fn validate_login(input: LoginRequest) -> Result<ValidatedLogin, ApiError> {
    let username = input.username.trim();
    let installation_id = input.installation_id.trim();
    let device_name = input.device_name.trim();
    if username.is_empty()
        || username.len() > 128
        || installation_id.is_empty()
        || installation_id.len() > 128
        || device_name.len() > 64
        || input.password.expose_secret().len() > 1024
    {
        return Err(ApiError::InvalidRequest);
    }
    Ok(ValidatedLogin {
        username: username.to_owned(),
        password: input.password,
        installation_id: installation_id.to_owned(),
        device_name: device_name.to_owned(),
    })
}

async fn find_user(state: &AppState, username: &str) -> Result<Option<UserRow>, ApiError> {
    sqlx::query_as::<_, UserRow>(
        "SELECT users.id,users.username,users.password_hash,users.sync_verified_at, \
         users.disabled_at,g.generation AS data_generation FROM users \
         JOIN account_data_generations g ON g.user_id=users.id WHERE users.username_key=$1",
    )
    .bind(username.to_ascii_lowercase())
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)
}

pub(crate) async fn verify_login_password(
    state: &AppState,
    password: SecretString,
    stored: Option<String>,
) -> Result<(), ApiError> {
    let Ok(_password_permit) = state.password_slots.clone().try_acquire_owned() else {
        return Err(ApiError::Busy);
    };
    let Ok(valid) = tokio::task::spawn_blocking(move || {
        let stored = stored.unwrap_or_else(|| DUMMY_PASSWORD_HASH.clone());
        verify_password(&password, &stored)
    })
    .await
    else {
        return Err(ApiError::Internal);
    };
    if !valid {
        return Err(ApiError::InvalidCredentials);
    }
    Ok(())
}

async fn hash_password_bounded(
    state: &AppState,
    password: SecretString,
) -> Result<String, ApiError> {
    let Ok(_password_permit) = state.password_slots.clone().try_acquire_owned() else {
        return Err(ApiError::Busy);
    };
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|_| ApiError::Internal)?
        .map_err(|_| ApiError::Internal)
}

pub(crate) async fn issue_session(
    state: &AppState,
    user_id: &str,
    installation_id: &str,
    device_name: &str,
) -> Result<IssuedSession, ApiError> {
    let now = now_ms();
    let expires_at = now.saturating_add(SESSION_TTL_MS);
    let Ok(token) = new_session_token() else {
        return Err(ApiError::Internal);
    };
    let Ok(digest) = session_token_digest(&state.token_hmac_key, &token) else {
        return Err(ApiError::Internal);
    };
    let Ok(mut transaction) = state.pool.begin().await else {
        return Err(ApiError::DatabaseUnavailable);
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('auth-session:' || $1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query(
        "DELETE FROM auth_sessions_v4 WHERE user_id=$1 AND (expires_at<=$2 OR revoked_at<>0)",
    )
    .bind(user_id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let active_other_devices = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM auth_sessions_v4 WHERE user_id=$1 AND installation_id<>$2",
    )
    .bind(user_id)
    .bind(installation_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    if active_other_devices >= MAX_ACTIVE_DEVICES {
        return Err(ApiError::DeviceLimitReached);
    }
    let result = sqlx::query(
        "INSERT INTO auth_sessions_v4 \
         (token_digest,user_id,installation_id,device_name,created_at,last_used_at,expires_at,revoked_at) \
         VALUES ($1,$2,$3,$4,$5,$5,$6,0) \
         ON CONFLICT (user_id,installation_id) DO UPDATE SET \
         token_digest=EXCLUDED.token_digest,device_name=EXCLUDED.device_name, \
         created_at=EXCLUDED.created_at,last_used_at=EXCLUDED.last_used_at, \
         expires_at=EXCLUDED.expires_at,revoked_at=0",
    )
    .bind(digest.as_slice())
    .bind(user_id)
    .bind(installation_id)
    .bind(device_name)
    .bind(now)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await;
    if result.is_err() || transaction.commit().await.is_err() {
        return Err(ApiError::DatabaseUnavailable);
    }
    Ok(IssuedSession { token, expires_at })
}

pub(crate) async fn issue_initial_session(
    transaction: &mut Transaction<'_, Postgres>,
    state: &AppState,
    user_id: &str,
    installation_id: &str,
    device_name: &str,
) -> Result<IssuedSession, ApiError> {
    let now = now_ms();
    let expires_at = now.saturating_add(SESSION_TTL_MS);
    let token = new_session_token().map_err(|_| ApiError::Internal)?;
    let digest =
        session_token_digest(&state.token_hmac_key, &token).map_err(|_| ApiError::Internal)?;
    sqlx::query(
        "INSERT INTO auth_sessions_v4 \
         (token_digest,user_id,installation_id,device_name,created_at,last_used_at,expires_at,revoked_at) \
         VALUES ($1,$2,$3,$4,$5,$5,$6,0)",
    )
    .bind(digest.as_slice())
    .bind(user_id)
    .bind(installation_id)
    .bind(device_name)
    .bind(now)
    .bind(expires_at)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(IssuedSession { token, expires_at })
}

#[utoipa::path(
    get,
    path = "/v1/auth/session",
    responses(
        (status = 200, body = SessionResponse),
        (status = 401, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn session(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    match authenticate(&state, &headers).await {
        Ok(user) => Json(SessionResponse {
            ok: true,
            token: None,
            expires_at: user.expires_at,
            user: SessionUser {
                id: user.id,
                username: user.username,
                sync_enabled: user.sync_verified_at != 0,
            },
            data_generation: user.data_generation,
            sync_enabled: user.sync_verified_at != 0,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    get,
    path = "/v1/auth/me",
    responses(
        (status = 200, body = SessionResponse),
        (status = 401, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn me(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    session(State(state), Extension(context), headers).await
}

#[utoipa::path(
    get,
    path = "/v1/auth/security",
    responses(
        (status = 200, body = SecurityStatusResponse),
        (status = 401, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn security(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    let Ok(email) =
        sqlx::query_scalar::<_, String>("SELECT email FROM account_emails_v4 WHERE user_id=$1")
            .bind(&user.id)
            .fetch_optional(&state.pool)
            .await
    else {
        return ApiError::DatabaseUnavailable.response(context);
    };
    let email_bound = email.is_some();
    Json(SecurityStatusResponse {
        ok: true,
        email: email.as_deref().map_or_else(String::new, mask_email),
        email_bound,
        recovery_available: email_bound && state.config.smtp.is_some(),
        mail_configured: state.config.smtp.is_some(),
        sync_enabled: user.sync_verified_at != 0,
        request_id: context.request_id,
    })
    .into_response()
}

#[utoipa::path(
    get,
    path = "/v1/auth/usage",
    responses(
        (status = 200, body = AccountUsageResponse),
        (status = 401, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn usage(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    match account_usage(&state, &user.id).await {
        Ok(mut response) => {
            response.request_id = context.request_id;
            Json(response).into_response()
        }
        Err(error) => error.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/account/delete",
    request_body = AccountDeleteRequest,
    responses(
        (status = 200, body = AccountDeleteResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn delete_account(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<AccountDeleteRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if input.password.expose_secret().is_empty()
        || input.password.expose_secret().len() > 1_024
        || input.username.trim().is_empty()
        || input.username.len() > 128
    {
        return ApiError::InvalidRequest.response(context);
    }
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_account_delete_limits(&state, &user.id).await {
        return error.response(context);
    }
    if input.username.trim() != user.username {
        return ApiError::AccountConfirmationMismatch.response(context);
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
    match delete_account_records(&state, &user.id).await {
        Ok(()) => Json(AccountDeleteResponse {
            ok: true,
            account_deleted: true,
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

async fn delete_account_records(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('auth-account-delete:' || $1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    // The user row has cascading foreign keys for every service-owned account
    // table. Explicit removal is intentionally limited to the parent row so a
    // future dependent migration cannot be accidentally left behind here.
    let deleted = sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if deleted.rows_affected() != 1 {
        return Err(ApiError::Unauthorized);
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

const ACCOUNT_STORAGE_QUOTA_BYTES: i64 = 25 * 1024 * 1024;
const DAILY_WRITE_QUOTA_BYTES: i64 = 10 * 1024 * 1024;
const DAILY_WRITE_QUOTA_ENTITIES: i64 = 3_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

async fn account_usage(state: &AppState, user_id: &str) -> Result<AccountUsageResponse, ApiError> {
    let now = now_ms();
    let utc_day = now.div_euclid(DAY_MS);
    let (daily_entities, daily_bytes) = sqlx::query_as::<_, (i64, i64)>(
        "INSERT INTO account_daily_usage_v4(user_id,utc_day,accepted_entities,accepted_bytes) \
         VALUES($1,$2,0,0) ON CONFLICT(user_id,utc_day) DO UPDATE SET \
         accepted_entities=account_daily_usage_v4.accepted_entities \
         RETURNING accepted_entities,accepted_bytes",
    )
    .bind(user_id)
    .bind(utc_day)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    let storage_bytes = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE((SELECT SUM(octet_length(envelope::text)) FROM sync_entities_v4 WHERE user_id=$1),0) \
         + COALESCE((SELECT SUM(octet_length(body)) FROM sync_assets_v4 WHERE user_id=$1),0) \
         + COALESCE((SELECT SUM(octet_length(compressed_envelope)) FROM sync_entity_history_v4 WHERE user_id=$1),0)",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(AccountUsageResponse {
        ok: true,
        storage_bytes: u64::try_from(storage_bytes).unwrap_or_default(),
        storage_limit_bytes: u64::try_from(ACCOUNT_STORAGE_QUOTA_BYTES).unwrap_or_default(),
        daily_written_bytes: u64::try_from(daily_bytes).unwrap_or_default(),
        daily_write_limit_bytes: u64::try_from(DAILY_WRITE_QUOTA_BYTES).unwrap_or_default(),
        daily_entity_writes: u64::try_from(daily_entities).unwrap_or_default(),
        daily_entity_write_limit: u64::try_from(DAILY_WRITE_QUOTA_ENTITIES).unwrap_or_default(),
        daily_window_at: utc_day.saturating_mul(DAY_MS),
        daily_reset_at: utc_day.saturating_add(1).saturating_mul(DAY_MS),
        request_id: Uuid::nil(),
    })
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return String::new();
    };
    let mut characters = local.chars();
    let first = characters.next().unwrap_or('*');
    let last = characters.last();
    match last {
        Some(last) if last != first => format!("{first}***{last}@{domain}"),
        _ => format!("{first}***@{domain}"),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/logout",
    responses(
        (status = 200, body = LogoutResponse),
        (status = 401, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn logout(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return ApiError::Unauthorized.response(context);
    };
    let Ok(digest) = session_token_digest(&state.token_hmac_key, &token) else {
        return ApiError::Unauthorized.response(context);
    };
    match sqlx::query("UPDATE auth_sessions_v4 SET revoked_at=$2 WHERE token_digest=$1")
        .bind(digest.as_slice())
        .bind(now_ms())
        .execute(&state.pool)
        .await
    {
        Ok(_) => Json(LogoutResponse {
            ok: true,
            request_id: context.request_id,
        })
        .into_response(),
        Err(_) => ApiError::DatabaseUnavailable.response(context),
    }
}

#[utoipa::path(
    post,
    path = "/v1/auth/password/change",
    request_body = PasswordChangeRequest,
    responses(
        (status = 200, body = PasswordChangeResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 401, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    ),
    security(("bearer_token" = []))
)]
pub async fn change_password(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    headers: HeaderMap,
    input: Result<Json<PasswordChangeRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if !valid_password_change(&input) {
        return ApiError::InvalidRequest.response(context);
    }
    let session_digest = match bearer(&headers)
        .ok_or(ApiError::Unauthorized)
        .and_then(|token| {
            session_token_digest(&state.token_hmac_key, &token).map_err(|_| ApiError::Unauthorized)
        }) {
        Ok(digest) => digest,
        Err(error) => return error.response(context),
    };
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(error) => return error.response(context),
    };
    if let Err(error) = check_password_change_limits(&state, &user.id).await {
        return error.response(context);
    }
    let stored_hash =
        match sqlx::query_scalar::<_, String>("SELECT password_hash FROM users WHERE id=$1")
            .bind(&user.id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(Some(value)) => value,
            Ok(None) => return ApiError::Unauthorized.response(context),
            Err(_) => return ApiError::DatabaseUnavailable.response(context),
        };
    if let Err(error) =
        verify_login_password(&state, input.current_password, Some(stored_hash.clone())).await
    {
        return error.response(context);
    }
    let new_hash = match hash_password_bounded(&state, input.new_password).await {
        Ok(hash) => hash,
        Err(error) => return error.response(context),
    };
    match persist_password_change(&state, &user.id, &stored_hash, &new_hash, &session_digest).await
    {
        Ok(()) => Json(PasswordChangeResponse {
            ok: true,
            message: "登录密码已修改，其他设备已退出登录",
            request_id: context.request_id,
        })
        .into_response(),
        Err(error) => error.response(context),
    }
}

fn valid_password_change(input: &PasswordChangeRequest) -> bool {
    let current_length = input.current_password.expose_secret().len();
    let new_length = input.new_password.expose_secret().len();
    (1..=1024).contains(&current_length) && (12..=1024).contains(&new_length)
}

async fn persist_password_change(
    state: &AppState,
    user_id: &str,
    previous_hash: &str,
    next_hash: &str,
    current_session_digest: &[u8; 32],
) -> Result<(), ApiError> {
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('auth-password-change:' || $1, 0))")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    let changed = sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3")
        .bind(user_id)
        .bind(next_hash)
        .bind(previous_hash)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::InvalidCredentials);
    }
    sqlx::query("UPDATE auth_sessions_v4 SET revoked_at=$3 WHERE user_id=$1 AND token_digest<>$2")
        .bind(user_id)
        .bind(current_session_digest.as_slice())
        .bind(now_ms())
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

pub(crate) async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedUser, ApiError> {
    let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
    let digest =
        session_token_digest(&state.token_hmac_key, &token).map_err(|_| ApiError::Unauthorized)?;
    let now = now_ms();
    let row = sqlx::query_as::<_, AuthenticatedUser>(
        "SELECT users.id,users.username,users.sync_verified_at,users.disabled_at, \
         g.generation AS data_generation,s.expires_at FROM auth_sessions_v4 s \
         JOIN users ON users.id=s.user_id JOIN account_data_generations g ON g.user_id=users.id \
         WHERE s.token_digest=$1 AND s.revoked_at=0 AND s.expires_at>$2",
    )
    .bind(digest.as_slice())
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?
    .ok_or(ApiError::Unauthorized)?;
    if row.disabled_at != 0 {
        return Err(ApiError::AccountDisabled);
    }
    let _last_used_update = sqlx::query(
        "UPDATE auth_sessions_v4 SET last_used_at=$2 \
         WHERE token_digest=$1 AND last_used_at<$2-$3",
    )
    .bind(digest.as_slice())
    .bind(now)
    .bind(LAST_USED_WRITE_INTERVAL_MS)
    .execute(&state.pool)
    .await;
    Ok(row)
}

fn bearer(headers: &HeaderMap) -> Option<SecretString> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| SecretString::from(token.to_owned()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
