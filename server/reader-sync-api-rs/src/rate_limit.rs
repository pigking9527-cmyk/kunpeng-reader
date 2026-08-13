use std::net::IpAddr;

use crate::{credentials::rate_limit_subject_digest, error::ApiError, state::AppState};

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// Atomically consumes all persistent registration rate-limit buckets.
///
/// # Errors
///
/// Returns `RateLimited` when any bucket exceeds its limit, or a service error
/// when the digest or database operation fails.
pub async fn check_registration_limits(
    state: &AppState,
    ip: IpAddr,
    email: &str,
) -> Result<(), ApiError> {
    let now = now_ms();
    let domain = email
        .rsplit_once('@')
        .map_or("invalid", |(_, domain)| domain);
    let mut limits = vec![
        ("register_email", email.to_owned(), HOUR_MS, 3),
        ("register_domain", domain.to_owned(), HOUR_MS, 30),
        ("register_global_hour", "all".to_owned(), HOUR_MS, 30),
        ("register_global_day", "all".to_owned(), DAY_MS, 100),
    ];
    limits.push(("register_ip", ip.to_string(), HOUR_MS, 5));
    limits.push(("register_network", network_subject(ip), HOUR_MS, 20));
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("DELETE FROM rate_limit_buckets_v4 WHERE window_start<$1")
        .bind(now.saturating_sub(2 * DAY_MS))
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    for (scope, subject, window_ms, maximum) in limits {
        let digest = rate_limit_subject_digest(&state.token_hmac_key, scope, &subject)
            .map_err(|_| ApiError::Internal)?;
        let window_start = now - now.rem_euclid(window_ms);
        let hits = sqlx::query_scalar::<_, i32>(
            "INSERT INTO rate_limit_buckets_v4(scope,subject_digest,window_start,hits) \
             VALUES ($1,$2,$3,1) ON CONFLICT(scope,subject_digest,window_start) \
             DO UPDATE SET hits=rate_limit_buckets_v4.hits+1 RETURNING hits",
        )
        .bind(scope)
        .bind(digest.as_slice())
        .bind(window_start)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        if hits > maximum {
            transaction
                .commit()
                .await
                .map_err(|_| ApiError::DatabaseUnavailable)?;
            return Err(ApiError::RateLimited);
        }
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

/// Atomically consumes the persistent anonymous feedback rate-limit buckets.
///
/// # Errors
///
/// Returns `RateLimited` when any bucket exceeds its limit, or a service error
/// when the database is unavailable.
pub async fn check_feedback_limits(state: &AppState, ip: IpAddr) -> Result<(), ApiError> {
    check_limits(
        state,
        [
            ("feedback_ip_hour", ip.to_string(), HOUR_MS, 3),
            ("feedback_ip_day", ip.to_string(), DAY_MS, 8),
            ("feedback_global_hour", "all".to_owned(), HOUR_MS, 100),
        ],
    )
    .await
}

/// Atomically consumes the per-account password-change rate-limit bucket.
///
/// # Errors
///
/// Returns `RateLimited` when the account exceeds five attempts per hour, or
/// a service error when the database is unavailable.
pub async fn check_password_change_limits(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    check_limits(
        state,
        [("password_change_user", user_id.to_owned(), HOUR_MS, 5)],
    )
    .await
}

/// Atomically limits password-reset requests by the public network and the
/// supplied account reference without revealing whether that account exists.
///
/// # Errors
///
/// Returns `RateLimited` when a request bucket exceeds its limit, or a service
/// error when persistent rate-limit storage cannot be updated.
pub async fn check_password_reset_request_limits(
    state: &AppState,
    ip: IpAddr,
    username_key: &str,
) -> Result<(), ApiError> {
    check_limits(
        state,
        [
            (
                "password_reset_request_user",
                username_key.to_owned(),
                HOUR_MS,
                5,
            ),
            ("password_reset_request_ip", ip.to_string(), HOUR_MS, 5),
            (
                "password_reset_request_network",
                network_subject(ip),
                HOUR_MS,
                20,
            ),
        ],
    )
    .await
}

/// Atomically limits password-reset confirmations by the public network and
/// supplied account reference.
///
/// # Errors
///
/// Returns `RateLimited` when a confirmation bucket exceeds its limit, or a
/// service error when persistent rate-limit storage cannot be updated.
pub async fn check_password_reset_confirm_limits(
    state: &AppState,
    ip: IpAddr,
    username_key: &str,
) -> Result<(), ApiError> {
    check_limits(
        state,
        [
            (
                "password_reset_confirm_user",
                username_key.to_owned(),
                HOUR_MS,
                5,
            ),
            ("password_reset_confirm_ip", ip.to_string(), HOUR_MS, 10),
            (
                "password_reset_confirm_network",
                network_subject(ip),
                HOUR_MS,
                40,
            ),
        ],
    )
    .await
}

/// Atomically limits destructive cloud-data reset attempts per account.
/// Checks the per-account rate limit for destructive data resets.
///
/// # Errors
///
/// Returns a rate-limit or database error when the reset cannot proceed.
pub async fn check_data_reset_limits(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    check_limits(
        state,
        [("sync_data_reset_user", user_id.to_owned(), HOUR_MS, 3)],
    )
    .await
}

/// Limits encrypted-secret epoch resets to four attempts per account-hour.
///
/// # Errors
///
/// Returns a rate-limit or database error when the reset cannot proceed.
pub async fn check_secret_reset_limits(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    check_limits(
        state,
        [("secret_reset_user", user_id.to_owned(), HOUR_MS, 4)],
    )
    .await
}

/// Limits email binding and rebind confirmation flows per account.
///
/// # Errors
///
/// Returns a rate-limit or database error when the account exceeds four
/// account-email operations per hour.
pub async fn check_account_email_limits(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    check_limits(
        state,
        [("account_email_user", user_id.to_owned(), HOUR_MS, 4)],
    )
    .await
}

/// Limits irreversible account deletion attempts per account.
///
/// # Errors
///
/// Returns a rate-limit or database error when the account exceeds three
/// deletion attempts per hour.
pub async fn check_account_delete_limits(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    check_limits(
        state,
        [("account_delete_user", user_id.to_owned(), HOUR_MS, 3)],
    )
    .await
}

async fn check_limits<const N: usize>(
    state: &AppState,
    limits: [(&str, String, i64, i32); N],
) -> Result<(), ApiError> {
    let now = now_ms();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    sqlx::query("DELETE FROM rate_limit_buckets_v4 WHERE window_start<$1")
        .bind(now.saturating_sub(2 * DAY_MS))
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
    for (scope, subject, window_ms, maximum) in limits {
        let digest = rate_limit_subject_digest(&state.token_hmac_key, scope, &subject)
            .map_err(|_| ApiError::Internal)?;
        let window_start = now - now.rem_euclid(window_ms);
        let hits = sqlx::query_scalar::<_, i32>(
            "INSERT INTO rate_limit_buckets_v4(scope,subject_digest,window_start,hits) \
             VALUES ($1,$2,$3,1) ON CONFLICT(scope,subject_digest,window_start) \
             DO UPDATE SET hits=rate_limit_buckets_v4.hits+1 RETURNING hits",
        )
        .bind(scope)
        .bind(digest.as_slice())
        .bind(window_start)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)?;
        if hits > maximum {
            transaction
                .commit()
                .await
                .map_err(|_| ApiError::DatabaseUnavailable)?;
            return Err(ApiError::RateLimited);
        }
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::DatabaseUnavailable)
}

fn network_subject(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2])
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
