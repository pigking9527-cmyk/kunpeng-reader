use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Instant,
};

use sqlx::PgConnection;
use tokio::sync::Mutex as AsyncMutex;

use crate::{credentials::rate_limit_subject_digest, error::ApiError, state::AppState};

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
const MINUTE_MS: i64 = 60 * 1000;
const AUTHENTICATED_ACCOUNT_SCOPE: &str = "authenticated_account_minute";
// A quiet instance never reserves more than the original eight-request lease.
// Only an instance which consumes that lease earns a larger reservation in the
// same minute, reducing writes for hot accounts without imposing the fixed-32
// fairness cost on ordinary multi-instance traffic.
const INITIAL_AUTHENTICATED_ACCOUNT_LEASE_SIZE: i32 = 8;
const MAX_AUTHENTICATED_ACCOUNT_LEASE_SIZE: i32 = 32;
const MAX_AUTHENTICATED_ACCOUNT_LEASES: usize = 32_768;
static LAST_ADMISSION_CLEANUP_AT: AtomicI64 = AtomicI64::new(0);
static AUTHENTICATED_ACCOUNT_LEASES: LazyLock<
    Mutex<HashMap<AccountAdmissionLease, AccountAdmissionLeaseState>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct AccountAdmissionLease {
    window_start: i64,
    subject_digest: [u8; 32],
}

struct AccountAdmissionLeaseState {
    remaining: i32,
    next_lease_size: i32,
    exhausted: bool,
    refill_lock: Arc<AsyncMutex<()>>,
}

impl AccountAdmissionLeaseState {
    fn new() -> Self {
        Self {
            remaining: 0,
            next_lease_size: INITIAL_AUTHENTICATED_ACCOUNT_LEASE_SIZE,
            exhausted: false,
            refill_lock: Arc::new(AsyncMutex::new(())),
        }
    }
}

enum CachedAdmissionDecision {
    Granted,
    Refill(Arc<AsyncMutex<()>>),
    RateLimited,
    Uncached,
}

/// Consumes the cross-instance request allowance for one authenticated account.
///
/// This admission check deliberately happens after the authoritative session
/// lookup but before the endpoint's business queries. `PostgreSQL` remains the
/// authority: an instance atomically reserves a small part of the fixed-minute
/// allowance then consumes that lease locally. Reservations may leave a few
/// unused requests at a quiet instance, but can never let multiple instances
/// admit more than the configured total. The shared gate covers all
/// authenticated endpoints because route handlers only provide authentication
/// headers; endpoint-specific expensive-operation quotas remain enforced by
/// their respective checks.
///
/// # Errors
///
/// Returns `RateLimited` after the account has exceeded its fixed-minute
/// allowance, or a service error when the persistent admission store cannot be
/// reached.
pub async fn check_authenticated_account_admission(
    state: &AppState,
    user_id: &str,
) -> Result<(), ApiError> {
    let acquire_started = Instant::now();
    let mut connection = state.pool.acquire().await.map_err(|_| {
        metrics::counter!(
            "reader_sync_database_failures_total",
            "operation" => "admission",
            "phase" => "acquire"
        )
        .increment(1);
        ApiError::DatabaseUnavailable
    })?;
    metrics::histogram!("reader_sync_database_pool_acquire_seconds", "operation" => "admission")
        .record(acquire_started.elapsed().as_secs_f64());
    check_authenticated_account_admission_on_connection(state, user_id, &mut connection).await
}

/// Consumes the authenticated-account allowance on an already acquired
/// database connection.
///
/// The authentication and sync hot paths use this entry point so a lease
/// refill does not perform a second pool checkout. `PostgreSQL` still owns the
/// cross-instance counter and the process-local cache only consumes allowance
/// which has already been reserved there.
///
/// # Errors
///
/// Returns `RateLimited` after the account has exhausted its fixed-minute
/// allowance, or a service error when the persistent admission store cannot be
/// reached.
pub async fn check_authenticated_account_admission_on_connection(
    state: &AppState,
    user_id: &str,
    connection: &mut PgConnection,
) -> Result<(), ApiError> {
    let now = now_ms();
    let window_start = now - now.rem_euclid(MINUTE_MS);
    let digest =
        rate_limit_subject_digest(&state.token_hmac_key, AUTHENTICATED_ACCOUNT_SCOPE, user_id)
            .map_err(|_| ApiError::Internal)?;
    let lease_key = AccountAdmissionLease {
        window_start,
        subject_digest: digest,
    };
    let maximum = state.config.max_authenticated_account_requests_per_minute;
    let refill_lock = match cached_authenticated_account_admission(lease_key) {
        CachedAdmissionDecision::Granted => return Ok(()),
        CachedAdmissionDecision::RateLimited => return Err(ApiError::RateLimited),
        CachedAdmissionDecision::Refill(refill_lock) => Some(refill_lock),
        CachedAdmissionDecision::Uncached => None,
    };
    // Only one task may refill a given account/window at a time. Tasks which
    // observed the same empty lease must not reserve overlapping chunks whose
    // cached remainder would be overwritten.
    let _refill_guard = if let Some(refill_lock) = refill_lock {
        // Authentication already owns a PostgreSQL connection here. Never
        // wait on the per-account refill lock while holding that connection:
        // one hot account could otherwise occupy the whole pool and starve
        // unrelated accounts. The caller receives the normal retryable 503
        // and can consume the winner's lease after retrying.
        let guard = refill_lock.try_lock_owned().map_err(|_| {
            metrics::counter!(
                "reader_sync_busy_rejections_total",
                "source" => "admission_refill"
            )
            .increment(1);
            ApiError::Busy
        })?;
        match cached_authenticated_account_admission(lease_key) {
            CachedAdmissionDecision::Granted => return Ok(()),
            CachedAdmissionDecision::RateLimited => return Err(ApiError::RateLimited),
            CachedAdmissionDecision::Refill(_) | CachedAdmissionDecision::Uncached => {}
        }
        Some(guard)
    } else {
        None
    };
    let lease_size = authenticated_account_lease_size(lease_key, maximum);
    let query_started = Instant::now();
    let hits = sqlx::query_scalar::<_, i32>(
        "INSERT INTO rate_limit_buckets_v4(scope,subject_digest,window_start,hits) \
         VALUES ($1,$2,$3,$4) ON CONFLICT(scope,subject_digest,window_start) \
         DO UPDATE SET hits=rate_limit_buckets_v4.hits+$4 RETURNING hits",
    )
    .bind(AUTHENTICATED_ACCOUNT_SCOPE)
    .bind(digest.as_slice())
    .bind(window_start)
    .bind(lease_size)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| {
        metrics::counter!(
            "reader_sync_database_failures_total",
            "operation" => "admission",
            "phase" => "query"
        )
        .increment(1);
        ApiError::DatabaseUnavailable
    });
    metrics::histogram!("reader_sync_database_query_seconds", "operation" => "admission")
        .record(query_started.elapsed().as_secs_f64());
    let hits = hits?;
    maybe_cleanup_authenticated_admission_buckets(connection, now).await;
    // `hits` includes this reservation. Compute the still-valid part of a
    // final, partially overlapping lease; this preserves the exact configured
    // maximum even when another instance already reserved most of the window.
    let granted = authenticated_account_allowance_granted(maximum, hits, lease_size);
    if granted == 0 {
        remember_authenticated_account_limit_exhausted(lease_key);
        return Err(ApiError::RateLimited);
    }
    remember_authenticated_account_lease(lease_key, granted, lease_size);
    Ok(())
}

fn authenticated_account_allowance_granted(maximum: i32, hits: i32, lease_size: i32) -> i32 {
    (maximum - (hits - lease_size)).clamp(0, lease_size)
}

fn cached_authenticated_account_admission(key: AccountAdmissionLease) -> CachedAdmissionDecision {
    let Ok(mut leases) = AUTHENTICATED_ACCOUNT_LEASES.lock() else {
        // A poisoned process-local cache must not turn into an availability or
        // admission bypass. Fall back to one-request PostgreSQL reservations.
        return CachedAdmissionDecision::Uncached;
    };
    if !leases.contains_key(&key) {
        if leases.len() >= MAX_AUTHENTICATED_ACCOUNT_LEASES {
            leases.retain(|existing, _| existing.window_start >= key.window_start);
        }
        if leases.len() < MAX_AUTHENTICATED_ACCOUNT_LEASES {
            leases.insert(key, AccountAdmissionLeaseState::new());
        }
    }
    let Some(lease) = leases.get_mut(&key) else {
        return CachedAdmissionDecision::Uncached;
    };
    if lease.exhausted {
        return CachedAdmissionDecision::RateLimited;
    }
    if lease.remaining > 0 {
        lease.remaining -= 1;
        return CachedAdmissionDecision::Granted;
    }
    CachedAdmissionDecision::Refill(lease.refill_lock.clone())
}

fn authenticated_account_lease_size(key: AccountAdmissionLease, maximum: i32) -> i32 {
    let Ok(mut leases) = AUTHENTICATED_ACCOUNT_LEASES.lock() else {
        return 1;
    };
    leases
        .get_mut(&key)
        .map_or(1, |lease| lease.next_lease_size.min(maximum))
}

fn remember_authenticated_account_lease(key: AccountAdmissionLease, granted: i32, requested: i32) {
    let Ok(mut leases) = AUTHENTICATED_ACCOUNT_LEASES.lock() else {
        return;
    };
    let Some(lease) = leases.get_mut(&key) else {
        return;
    };
    lease.remaining = granted.saturating_sub(1);
    lease.next_lease_size = requested
        .saturating_mul(2)
        .min(MAX_AUTHENTICATED_ACCOUNT_LEASE_SIZE);
}

fn remember_authenticated_account_limit_exhausted(key: AccountAdmissionLease) {
    let Ok(mut leases) = AUTHENTICATED_ACCOUNT_LEASES.lock() else {
        return;
    };
    if let Some(lease) = leases.get_mut(&key) {
        lease.remaining = 0;
        lease.exhausted = true;
    }
}

#[doc(hidden)]
pub fn clear_authenticated_account_leases_for_test() {
    if let Ok(mut leases) = AUTHENTICATED_ACCOUNT_LEASES.lock() {
        leases.clear();
    }
}

async fn maybe_cleanup_authenticated_admission_buckets(connection: &mut PgConnection, now: i64) {
    let previous = LAST_ADMISSION_CLEANUP_AT.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < HOUR_MS
        || LAST_ADMISSION_CLEANUP_AT
            .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    // Hygiene only: failure is harmless because admission correctness is based
    // exclusively on the current fixed-minute primary-key bucket.
    let _ = sqlx::query("DELETE FROM rate_limit_buckets_v4 WHERE scope=$1 AND window_start<$2")
        .bind(AUTHENTICATED_ACCOUNT_SCOPE)
        .bind(now.saturating_sub(2 * HOUR_MS))
        .execute(connection)
        .await;
}

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

/// Atomically consumes persistent phone-registration abuse buckets.
///
/// The subjects are HMAC-digested before storage. The provider budget is
/// enforced separately when an SMS outbox item is reserved.
///
/// # Errors
///
/// Returns `RateLimited` when any bucket exceeds its limit, or a service error
/// when persistent rate-limit storage cannot be updated.
pub async fn check_phone_registration_limits(
    state: &AppState,
    ip: IpAddr,
    phone: &str,
    installation_id: &str,
) -> Result<(), ApiError> {
    check_limits(
        state,
        [
            ("phone_register_phone_hour", phone.to_owned(), HOUR_MS, 3),
            ("phone_register_phone_day", phone.to_owned(), DAY_MS, 10),
            ("phone_register_ip", ip.to_string(), HOUR_MS, 10),
            ("phone_register_network", network_subject(ip), HOUR_MS, 40),
            (
                "phone_register_installation",
                installation_id.to_owned(),
                HOUR_MS,
                5,
            ),
            ("phone_register_global_hour", "all".to_owned(), HOUR_MS, 50),
            ("phone_register_global_day", "all".to_owned(), DAY_MS, 200),
        ],
    )
    .await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_lease(window_start: i64, digest_byte: u8) -> AccountAdmissionLease {
        AccountAdmissionLease {
            window_start,
            subject_digest: [digest_byte; 32],
        }
    }

    fn forget_test_lease(key: AccountAdmissionLease) {
        AUTHENTICATED_ACCOUNT_LEASES
            .lock()
            .expect("authenticated admission leases")
            .remove(&key);
    }

    #[test]
    fn authenticated_account_lease_grows_after_each_consumed_reservation() {
        let key = test_lease(101, 0xa1);
        assert!(matches!(
            cached_authenticated_account_admission(key),
            CachedAdmissionDecision::Refill(_)
        ));
        assert_eq!(authenticated_account_lease_size(key, 600), 8);

        remember_authenticated_account_lease(key, 8, 8);
        for _ in 0..7 {
            assert!(matches!(
                cached_authenticated_account_admission(key),
                CachedAdmissionDecision::Granted
            ));
        }
        assert_eq!(authenticated_account_lease_size(key, 600), 16);

        remember_authenticated_account_lease(key, 16, 16);
        for _ in 0..15 {
            assert!(matches!(
                cached_authenticated_account_admission(key),
                CachedAdmissionDecision::Granted
            ));
        }
        assert_eq!(authenticated_account_lease_size(key, 600), 32);

        remember_authenticated_account_lease(key, 32, 32);
        for _ in 0..31 {
            assert!(matches!(
                cached_authenticated_account_admission(key),
                CachedAdmissionDecision::Granted
            ));
        }
        assert_eq!(authenticated_account_lease_size(key, 600), 32);
        forget_test_lease(key);
    }

    #[test]
    fn concurrent_cache_misses_share_one_refill_lock() {
        let key = test_lease(102, 0xa2);
        let CachedAdmissionDecision::Refill(first) = cached_authenticated_account_admission(key)
        else {
            panic!("first lookup must require a refill");
        };
        let CachedAdmissionDecision::Refill(second) = cached_authenticated_account_admission(key)
        else {
            panic!("second lookup must wait for the same refill");
        };
        assert!(Arc::ptr_eq(&first, &second));
        let _winner = first.try_lock_owned().expect("first refill wins");
        assert!(
            second.try_lock_owned().is_err(),
            "a competing refill must not wait while holding a database connection"
        );
        forget_test_lease(key);
    }

    #[test]
    fn final_partial_lease_never_exceeds_the_account_maximum() {
        assert_eq!(authenticated_account_allowance_granted(10, 8, 8), 8);
        assert_eq!(authenticated_account_allowance_granted(10, 18, 10), 2);
        assert_eq!(authenticated_account_allowance_granted(10, 28, 10), 0);
    }

    #[test]
    fn exhausted_window_is_rejected_without_another_reservation() {
        let key = test_lease(103, 0xa3);
        assert!(matches!(
            cached_authenticated_account_admission(key),
            CachedAdmissionDecision::Refill(_)
        ));
        remember_authenticated_account_limit_exhausted(key);
        assert!(matches!(
            cached_authenticated_account_admission(key),
            CachedAdmissionDecision::RateLimited
        ));
        forget_test_lease(key);
    }
}
