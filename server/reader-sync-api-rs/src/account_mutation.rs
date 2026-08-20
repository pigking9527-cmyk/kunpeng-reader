//! Cross-instance admission control for account-scoped data mutations.
//!
//! Account storage and daily-write quotas must remain serialized, but a
//! blocking `PostgreSQL` advisory lock turns a burst from one account into a
//! long tail that occupies request and database capacity.  The caller gets a
//! normal retryable busy response instead of waiting behind another mutation.

use sqlx::{Postgres, Transaction};

use crate::error::ApiError;

/// Acquires the transaction-scoped account mutation lock without queueing.
///
/// The `PostgreSQL` lock is shared by every service instance, unlike a local
/// semaphore.  Returning [`ApiError::Busy`] preserves the existing 503 and
/// `Retry-After: 1` contract for clients that should retry their sync batch.
///
/// # Errors
///
/// Returns [`ApiError::Busy`] when another mutation for the same account owns
/// the transaction lock, or [`ApiError::DatabaseUnavailable`] if the lock
/// query cannot run.
pub async fn try_lock(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<(), ApiError> {
    let locked =
        sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(user_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| ApiError::DatabaseUnavailable)?;
    if locked {
        Ok(())
    } else {
        metrics::counter!(
            "reader_sync_busy_rejections_total",
            "source" => "account_mutation"
        )
        .increment(1);
        Err(ApiError::Busy)
    }
}
