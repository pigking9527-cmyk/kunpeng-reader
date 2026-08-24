//! Durable secondary object-storage writes for intelligence images.
//!
//! `PostgreSQL` bytea is written first and remains the read fallback.  This
//! worker is deliberately outside request handling: an S3 outage delays only
//! the secondary copy and cannot make an already completed image unreadable.

use std::{sync::Arc, time::Duration};

use sqlx::{FromRow, Postgres, Transaction};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::{
    error::ApiError, intelligence_object_store::IntelligenceObjectStoreStatus, state::AppState,
};

const LEASE_MS: i64 = 60_000;
const IDLE_DELAY: Duration = Duration::from_secs(2);
const RETRY_BASE_MS: i64 = 5_000;
const RETRY_MAX_MS: i64 = 15 * 60_000;
const WORKER_ID_PREFIX: &str = "intelligence-object-outbox-v1";

#[derive(Debug, FromRow)]
struct WriteRow {
    outbox_id: Uuid,
    sha256: String,
    object_key: String,
    content: Vec<u8>,
    attempts: i32,
}

#[derive(Debug, FromRow)]
struct ArchiveWriteRow {
    outbox_id: Uuid,
    job_id: Uuid,
    object_key: String,
    content: Option<Vec<u8>>,
    content_sha256: Option<Vec<u8>>,
    attempts: i32,
}

#[derive(Debug, FromRow)]
struct GcRow {
    outbox_id: Uuid,
    object_key: String,
    attempts: i32,
}

/// Adds a secondary S3 upload only after the `PostgreSQL` asset has been added
/// to the same transaction.  It is intentionally a no-op for disabled object
/// storage; callers branch on the injected adapter before calling it.
pub(crate) async fn enqueue_asset_write(
    tx: &mut Transaction<'_, Postgres>,
    sha256: &str,
    now: i64,
) -> Result<(), ApiError> {
    let object_key = asset_object_key(sha256).ok_or(ApiError::InvalidRequest)?;
    sqlx::query(
        "INSERT INTO intelligence_object_write_outbox_v1 (outbox_id,sha256,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,$2,'s3',$3,'QUEUED',$4,$4,$4) ON CONFLICT (sha256) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(sha256)
    .bind(object_key)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

/// Persists an archive-package secondary write in the same transaction that
/// exposes its `PostgreSQL` fallback.  The worker retains that fallback until a
/// successful S3 `put` and database location transition have both committed.
pub(crate) async fn enqueue_archive_write(
    tx: &mut Transaction<'_, Postgres>,
    job_id: Uuid,
    now: i64,
) -> Result<(), ApiError> {
    let object_key = archive_object_key(job_id);
    sqlx::query(
        "INSERT INTO intelligence_archive_object_write_outbox_v1 (outbox_id,job_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,$2,'s3',$3,'QUEUED',$4,$4,$4) ON CONFLICT (job_id) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(job_id)
    .bind(object_key)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok(())
}

/// Starts only for an injected, usable object-store adapter.  Thus enabling
/// S3 always has an active consumer; disabled installations retain exactly the
/// PostgreSQL-only behavior and start no polling task.
#[must_use]
pub fn spawn_worker(state: AppState) -> Option<JoinHandle<()>> {
    (state.intelligence_object_store_status() == IntelligenceObjectStoreStatus::Configured).then(
        || {
            tokio::spawn(async move {
                let worker_id = format!("{WORKER_ID_PREFIX}:{}", Uuid::new_v4());
                loop {
                    let worked = process_once(&state, &worker_id).await;
                    tokio::time::sleep(if worked {
                        Duration::from_millis(25)
                    } else {
                        IDLE_DELAY
                    })
                    .await;
                }
            })
        },
    )
}

async fn process_once(state: &AppState, worker_id: &str) -> bool {
    let now = now_ms();
    if let Some(row) = claim_write(state, worker_id, now).await {
        let store = Arc::clone(&state.intelligence_object_store);
        let key = row.object_key.clone();
        let content = row.content.clone();
        let upload = tokio::task::spawn_blocking(move || store.put(&key, &content)).await;
        match upload {
            Ok(Ok(())) => mark_write_complete(state, worker_id, &row, now_ms()).await,
            _ => mark_write_retry(state, worker_id, &row, now_ms()).await,
        }
        return true;
    }
    if let Some(row) = claim_archive_write(state, worker_id, now).await {
        let (Some(content), Some(_)) = (row.content.clone(), row.content_sha256.as_deref()) else {
            mark_archive_write_orphan(state, worker_id, &row, now_ms()).await;
            return true;
        };
        let store = Arc::clone(&state.intelligence_object_store);
        let key = row.object_key.clone();
        let upload = tokio::task::spawn_blocking(move || store.put(&key, &content)).await;
        match upload {
            Ok(Ok(())) => mark_archive_write_complete(state, worker_id, &row, now_ms()).await,
            _ => mark_archive_write_retry(state, worker_id, &row, now_ms()).await,
        }
        return true;
    }
    process_one_gc(state, worker_id, now).await
}

async fn process_one_gc(state: &AppState, worker_id: &str, now: i64) -> bool {
    let Some(row) = claim_gc(state, worker_id, now).await else {
        return false;
    };
    let store = Arc::clone(&state.intelligence_object_store);
    let key = row.object_key.clone();
    let deletion = tokio::task::spawn_blocking(move || store.delete(&key)).await;
    match deletion {
        Ok(Ok(())) => mark_gc_complete(state, worker_id, row.outbox_id, now_ms()).await,
        _ => mark_gc_retry(state, worker_id, &row, now_ms()).await,
    }
    true
}

async fn claim_write(state: &AppState, worker_id: &str, now: i64) -> Option<WriteRow> {
    sqlx::query_as::<_, WriteRow>(
        "WITH candidate AS ( \
           SELECT o.outbox_id FROM intelligence_object_write_outbox_v1 o \
           WHERE (o.state='QUEUED' AND o.not_before_at <= $1) \
              OR (o.state='CLAIMED' AND o.lease_expires_at <= $1) \
           ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1 \
         ) \
         UPDATE intelligence_object_write_outbox_v1 o \
         SET state='CLAIMED',claimed_by=$2,lease_expires_at=$3,updated_at=$1,attempts=o.attempts+1,last_error_code=NULL \
         FROM candidate c, intelligence_assets_v1 a \
         WHERE o.outbox_id=c.outbox_id AND a.sha256=o.sha256 \
         RETURNING o.outbox_id,o.sha256,o.object_key,a.content,o.attempts",
    )
    .bind(now)
    .bind(worker_id)
    .bind(now + LEASE_MS)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

async fn mark_write_complete(state: &AppState, worker_id: &str, row: &WriteRow, now: i64) {
    let Ok(mut tx) = state.pool.begin().await else {
        return;
    };
    let changed = sqlx::query(
        "UPDATE intelligence_assets_v1 SET storage_backend='s3',object_key=$2,content=NULL WHERE sha256=$1 AND storage_backend='postgres' AND content IS NOT NULL",
    )
    .bind(&row.sha256)
    .bind(&row.object_key)
    .execute(&mut *tx)
    .await;
    match changed {
        Ok(result) if result.rows_affected() == 1 => {
            let completed = sqlx::query(
                "UPDATE intelligence_object_write_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code=NULL WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
            )
            .bind(row.outbox_id)
            .bind(worker_id)
            .bind(now)
            .execute(&mut *tx)
            .await;
            if completed.is_ok() {
                let _ = tx.commit().await;
            }
        }
        Ok(_) => {
            // A PUT can win a race with retention.  Once the source row is
            // gone (or is no longer eligible for promotion), do not leave the
            // externally written object untracked: settle the write and queue
            // a compensating delete atomically.
            let gc = sqlx::query(
                "INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) ON CONFLICT (storage_backend,object_key) DO UPDATE SET state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END,not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at),updated_at=EXCLUDED.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(&row.object_key)
            .bind(now)
            .execute(&mut *tx)
            .await;
            let completed = sqlx::query(
                "UPDATE intelligence_object_write_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code='finalization_unavailable' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
            )
            .bind(row.outbox_id)
            .bind(worker_id)
            .bind(now)
            .execute(&mut *tx)
            .await;
            if gc.is_ok() && completed.is_ok() {
                let _ = tx.commit().await;
            }
        }
        Err(_) => {
            // The external PUT is idempotent.  Preserve the claimed lease on
            // an unknown database outcome so a later worker can recover it.
        }
    }
}

async fn mark_write_retry(state: &AppState, worker_id: &str, row: &WriteRow, now: i64) {
    let _ = sqlx::query(
        "UPDATE intelligence_object_write_outbox_v1 SET state='QUEUED',claimed_by=NULL,lease_expires_at=0,not_before_at=$3,updated_at=$4,last_error_code='object_store_failed' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
    )
    .bind(row.outbox_id)
    .bind(worker_id)
    .bind(now + retry_delay_ms(row.attempts))
    .bind(now)
    .execute(&state.pool)
    .await;
}

async fn claim_archive_write(
    state: &AppState,
    worker_id: &str,
    now: i64,
) -> Option<ArchiveWriteRow> {
    sqlx::query_as::<_, ArchiveWriteRow>(
        "WITH candidate AS ( \
           SELECT o.outbox_id FROM intelligence_archive_object_write_outbox_v1 o \
           WHERE (o.state='QUEUED' AND o.not_before_at <= $1) \
              OR (o.state='CLAIMED' AND o.lease_expires_at <= $1) \
           ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1 \
         ) \
         UPDATE intelligence_archive_object_write_outbox_v1 o \
         SET state='CLAIMED',claimed_by=$2,lease_expires_at=$3,updated_at=$1,attempts=o.attempts+1,last_error_code=NULL \
         FROM candidate c, intelligence_archive_jobs_v1 j \
         WHERE o.outbox_id=c.outbox_id AND j.job_id=o.job_id \
         RETURNING o.outbox_id,o.job_id,o.object_key,j.content,j.content_sha256,o.attempts",
    )
    .bind(now)
    .bind(worker_id)
    .bind(now + LEASE_MS)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

async fn mark_archive_write_complete(
    state: &AppState,
    worker_id: &str,
    row: &ArchiveWriteRow,
    now: i64,
) {
    let Ok(mut tx) = state.pool.begin().await else {
        return;
    };
    let Some(content_sha256) = row.content_sha256.as_deref() else {
        mark_archive_write_orphan(state, worker_id, row, now).await;
        return;
    };
    let switched = sqlx::query(
        "UPDATE intelligence_archive_jobs_v1 SET storage_backend='s3',object_key=$2,content=NULL,updated_at=$3 WHERE job_id=$1 AND state='READY' AND storage_backend='postgres' AND content_sha256=$4 AND content IS NOT NULL",
    )
    .bind(row.job_id)
    .bind(&row.object_key)
    .bind(now)
    .bind(content_sha256)
    .execute(&mut *tx)
    .await;
    match switched {
        Ok(result) if result.rows_affected() == 1 => {
            let completed = sqlx::query(
                "UPDATE intelligence_archive_object_write_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code=NULL WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
            )
            .bind(row.outbox_id)
            .bind(worker_id)
            .bind(now)
            .execute(&mut *tx)
            .await;
            if completed.is_ok() {
                let _ = tx.commit().await;
            }
        }
        Ok(_) => {
            // The external PUT has succeeded but this package can no longer
            // become reader-visible (expired, purged, or superseded).  Queue
            // its compensating delete in the same transaction that settles
            // this outbox so it cannot leak an orphan.
            let gc = sqlx::query(
                "INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) ON CONFLICT (storage_backend,object_key) DO UPDATE SET state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END,not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at),updated_at=EXCLUDED.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(&row.object_key)
            .bind(now)
            .execute(&mut *tx)
            .await;
            let completed = sqlx::query(
                "UPDATE intelligence_archive_object_write_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code='finalization_unavailable' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
            )
            .bind(row.outbox_id)
            .bind(worker_id)
            .bind(now)
            .execute(&mut *tx)
            .await;
            if gc.is_ok() && completed.is_ok() {
                let _ = tx.commit().await;
            }
        }
        Err(_) => {
            // Do not delete after an unknown transaction outcome.  The lease
            // recovers and repeat PUT is idempotent; this preserves a package
            // that might already have committed its location transition.
        }
    }
}

async fn mark_archive_write_orphan(
    state: &AppState,
    worker_id: &str,
    row: &ArchiveWriteRow,
    now: i64,
) {
    let Ok(mut tx) = state.pool.begin().await else {
        return;
    };
    // A reclaimed lease may have completed PUT before a prior worker lost its
    // database connection.  Queue a delete even when this worker has no
    // source bytes: deleting a never-created job-scoped key is harmless, but
    // retaining an unknown prior PUT would leak the temporary package.
    let gc = sqlx::query(
        "INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) ON CONFLICT (storage_backend,object_key) DO UPDATE SET state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END,not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at),updated_at=EXCLUDED.updated_at",
    )
    .bind(Uuid::new_v4())
    .bind(&row.object_key)
    .bind(now)
    .execute(&mut *tx)
    .await;
    let completed = sqlx::query(
        "UPDATE intelligence_archive_object_write_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code='source_unavailable' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
    )
    .bind(row.outbox_id)
    .bind(worker_id)
    .bind(now)
    .execute(&mut *tx)
    .await;
    if gc.is_ok() && completed.is_ok() {
        let _ = tx.commit().await;
    }
}

async fn mark_archive_write_retry(
    state: &AppState,
    worker_id: &str,
    row: &ArchiveWriteRow,
    now: i64,
) {
    let _ = sqlx::query(
        "UPDATE intelligence_archive_object_write_outbox_v1 SET state='QUEUED',claimed_by=NULL,lease_expires_at=0,not_before_at=$3,updated_at=$4,last_error_code='object_store_failed' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
    )
    .bind(row.outbox_id)
    .bind(worker_id)
    .bind(now + retry_delay_ms(row.attempts))
    .bind(now)
    .execute(&state.pool)
    .await;
}

async fn claim_gc(state: &AppState, worker_id: &str, now: i64) -> Option<GcRow> {
    sqlx::query_as::<_, GcRow>(
        "WITH candidate AS ( \
           SELECT outbox_id FROM intelligence_object_gc_outbox_v1 \
           WHERE (state IN ('QUEUED','FAILED') AND not_before_at <= $1) \
              OR (state='CLAIMED' AND lease_expires_at <= $1) \
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1 \
         ) \
         UPDATE intelligence_object_gc_outbox_v1 o \
         SET state='CLAIMED',claimed_by=$2,lease_expires_at=$3,updated_at=$1,attempts=o.attempts+1,last_error_code=NULL \
         FROM candidate c WHERE o.outbox_id=c.outbox_id \
         RETURNING o.outbox_id,o.object_key,o.attempts",
    )
    .bind(now)
    .bind(worker_id)
    .bind(now + LEASE_MS)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

async fn mark_gc_complete(state: &AppState, worker_id: &str, id: Uuid, now: i64) {
    let _ = sqlx::query(
        "UPDATE intelligence_object_gc_outbox_v1 SET state='COMPLETE',claimed_by=NULL,lease_expires_at=0,completed_at=$3,updated_at=$3,last_error_code=NULL WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
    )
    .bind(id)
    .bind(worker_id)
    .bind(now)
    .execute(&state.pool)
    .await;
}

async fn mark_gc_retry(state: &AppState, worker_id: &str, row: &GcRow, now: i64) {
    let _ = sqlx::query(
        "UPDATE intelligence_object_gc_outbox_v1 SET state='FAILED',claimed_by=NULL,lease_expires_at=0,not_before_at=$3,updated_at=$4,last_error_code='object_store_failed' WHERE outbox_id=$1 AND state='CLAIMED' AND claimed_by=$2",
    )
    .bind(row.outbox_id)
    .bind(worker_id)
    .bind(now + retry_delay_ms(row.attempts))
    .bind(now)
    .execute(&state.pool)
    .await;
}

fn asset_object_key(sha256: &str) -> Option<String> {
    (sha256.len() == 64
        && sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase()))
    .then(|| format!("intelligence/assets/{sha256}"))
}

fn archive_object_key(job_id: Uuid) -> String {
    format!("intelligence/archive/{job_id}/package")
}

fn retry_delay_ms(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1))
        .unwrap_or_default()
        .min(8);
    RETRY_BASE_MS
        .saturating_mul(1_i64 << exponent)
        .min(RETRY_MAX_MS)
}

fn now_ms() -> i64 {
    i64::try_from(
        time::OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000)
            .min(i128::from(i64::MAX)),
    )
    .expect("timestamp milliseconds fit in i64")
}

#[cfg(test)]
mod tests {
    use std::{fmt::Write, time::Duration};

    use super::*;
    use secrecy::SecretString;
    use sha2::{Digest, Sha256};

    use crate::config::{Config, IntelligenceObjectStorageConfig, S3ObjectStorageConfig};

    #[test]
    fn asset_object_keys_are_content_addressed_and_safe() {
        let sha = "a".repeat(64);
        assert_eq!(
            asset_object_key(&sha).as_deref(),
            Some(
                "intelligence/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
        );
        assert!(asset_object_key("../not-a-sha").is_none());
        assert!(asset_object_key(&"A".repeat(64)).is_none());
    }

    #[test]
    fn retry_backoff_is_bounded_and_monotonic() {
        assert_eq!(retry_delay_ms(1), RETRY_BASE_MS);
        assert!(retry_delay_ms(4) > retry_delay_ms(3));
        assert_eq!(retry_delay_ms(i32::MAX), RETRY_MAX_MS);
    }

    #[test]
    fn archive_object_keys_are_job_scoped_and_safe() {
        let id = Uuid::nil();
        assert_eq!(
            archive_object_key(id),
            "intelligence/archive/00000000-0000-0000-0000-000000000000/package"
        );
    }

    #[test]
    fn asset_finalization_queues_compensating_gc_when_retention_wins_the_race() {
        let source = include_str!("intelligence_object_outbox.rs");
        let finalizer = source
            .split("async fn mark_write_complete")
            .nth(1)
            .and_then(|value| value.split("async fn mark_write_retry").next())
            .expect("asset write finalizer");
        assert!(finalizer.contains("storage_backend='postgres' AND content IS NOT NULL"));
        assert!(finalizer.contains("intelligence_object_gc_outbox_v1"));
        assert!(finalizer.contains("finalization_unavailable"));
        assert!(!finalizer.contains("store.put"));
    }

    #[test]
    fn claim_queries_join_source_rows_in_the_update_where_clause() {
        // PostgreSQL does not permit the target `UPDATE` alias in a `JOIN ...
        // ON` expression in the `FROM` clause. Keep the source joins in the
        // `WHERE` clause so a queued row can actually be leased.
        let source = include_str!("intelligence_object_outbox.rs");
        let write_claim = source
            .split("async fn claim_write")
            .nth(1)
            .and_then(|value| value.split("async fn mark_write_complete").next())
            .expect("asset write claim");
        assert!(write_claim.contains("FROM candidate c, intelligence_assets_v1 a "));
        assert!(write_claim.contains("a.sha256=o.sha256"));
        assert!(!write_claim.contains("JOIN intelligence_assets_v1 a ON"));
        let archive_claim = source
            .split("async fn claim_archive_write")
            .nth(1)
            .and_then(|value| value.split("async fn mark_archive_write_complete").next())
            .expect("archive write claim");
        assert!(archive_claim.contains("FROM candidate c, intelligence_archive_jobs_v1 j "));
        assert!(archive_claim.contains("j.job_id=o.job_id"));
        assert!(!archive_claim.contains("JOIN intelligence_archive_jobs_v1 j ON"));
    }

    #[test]
    fn object_storage_promotion_allows_releasing_the_postgres_copy() {
        let migration = include_str!(
            "../migrations/0035_intelligence_object_storage_promoted_content_nullable_v1.sql"
        );
        assert!(migration.contains("ALTER COLUMN content DROP NOT NULL"));
    }

    #[tokio::test]
    #[ignore = "requires explicit real PostgreSQL and S3-compatible object-store confirmation"]
    #[allow(
        clippy::too_many_lines,
        reason = "the opt-in E2E intentionally keeps failure, durable retry, recovery, and cleanup assertions in one audited transaction narrative"
    )]
    async fn real_s3_asset_outbox_promotes_only_after_a_successful_put() {
        let database_url = std::env::var("KUNPENG_SYNC_TEST_DATABASE_URL")
            .expect("real S3 outbox E2E requires protected test database URL");
        let endpoint = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_ENDPOINT")
            .expect("real S3 outbox E2E requires protected endpoint");
        let bucket = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_BUCKET")
            .expect("real S3 outbox E2E requires protected bucket");
        let access_key_id = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_ACCESS_KEY_ID")
            .expect("real S3 outbox E2E requires protected access key");
        let secret_access_key = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_SECRET_ACCESS_KEY")
            .expect("real S3 outbox E2E requires protected secret");
        let database = database_url.rsplit('/').next().unwrap_or_default();
        assert!(database.starts_with("reader_sync_rust_test_"));

        let s3_config = S3ObjectStorageConfig {
            endpoint: endpoint.clone(),
            region: "us-east-1".to_owned(),
            bucket,
            access_key_id: SecretString::from(access_key_id),
            secret_access_key: SecretString::from(secret_access_key),
            session_token: None,
        };
        let mut config = Config::for_test(&database_url);
        // The protected PostgreSQL E2E suite applies migrations first.  This
        // worker test exercises only the real configured storage transition.
        config.run_migrations = false;
        config.database_max_connections = 4;
        config.database_acquire_timeout = Duration::from_secs(5);
        config.intelligence_object_storage = IntelligenceObjectStorageConfig::S3(s3_config.clone());

        let state = crate::build_state(config.clone())
            .await
            .expect("build normal real S3 test state");

        // A refused loopback connection provides a real request failure
        // without putting the protected S3 fixture bucket at risk. Reuse the
        // normal process state and inject only its real S3 adapter: the
        // Prometheus recorder is process-global and production also creates
        // it exactly once at startup.
        let mut unavailable_config = config.clone();
        unavailable_config.intelligence_object_storage =
            IntelligenceObjectStorageConfig::S3(S3ObjectStorageConfig {
                endpoint: "http://127.0.0.1:1".to_owned(),
                ..s3_config
            });
        let unavailable_store = Arc::from(
            crate::intelligence_object_store::store_for_config(
                &unavailable_config.intelligence_object_storage,
            )
            .expect("construct unavailable loopback S3 adapter"),
        );
        let unavailable_state = AppState {
            intelligence_object_store: unavailable_store,
            config: unavailable_config,
            ..state.clone()
        };
        let content = format!("outbox-real-s3-e2e:{}", Uuid::new_v4()).into_bytes();
        let sha256 =
            Sha256::digest(&content)
                .iter()
                .fold(String::with_capacity(64), |mut output, byte| {
                    write!(&mut output, "{byte:02x}").expect("write digest hex");
                    output
                });
        let now = now_ms();
        let mut tx = unavailable_state
            .pool
            .begin()
            .await
            .expect("begin fixture transaction");
        sqlx::query("INSERT INTO intelligence_assets_v1 (sha256,mime,content,bytes,expires_at) VALUES ($1,'image/png',$2,$3,$4) ON CONFLICT (sha256) DO UPDATE SET content=EXCLUDED.content,bytes=EXCLUDED.bytes,expires_at=EXCLUDED.expires_at,storage_backend='postgres',object_key=NULL")
            .bind(&sha256)
            .bind(&content)
            .bind(i64::try_from(content.len()).expect("small fixture"))
            .bind(now + 60_000)
            .execute(&mut *tx)
            .await
            .expect("insert asset fixture");
        enqueue_asset_write(&mut tx, &sha256, now)
            .await
            .expect("enqueue durable object write");
        tx.commit().await.expect("commit object fixture");

        // The protected database may retain queued rows from an interrupted
        // earlier rehearsal. The worker is FIFO, so make only this disposable
        // fixture strictly older than any normal timestamp: it proves the
        // exact row's retry path without failing somebody else's queued row
        // against the deliberately unavailable loopback endpoint.
        let prioritized = sqlx::query(
            "UPDATE intelligence_object_write_outbox_v1 SET created_at=-1 WHERE sha256=$1 AND state='QUEUED'",
        )
        .bind(&sha256)
        .execute(&unavailable_state.pool)
        .await
        .expect("prioritize disposable outbox fixture under FIFO");
        assert_eq!(prioritized.rows_affected(), 1);

        let mut failed_write = None;
        for _ in 0..64 {
            assert!(process_once(&unavailable_state, "real-s3-e2e-failure-worker").await);
            let row: (Uuid, String, i32, Option<String>, i64, Option<String>, i64) = sqlx::query_as(
                "SELECT outbox_id,state,attempts,last_error_code,not_before_at,claimed_by,lease_expires_at FROM intelligence_object_write_outbox_v1 WHERE sha256=$1",
            )
            .bind(&sha256)
            .fetch_one(&unavailable_state.pool)
            .await
            .expect("read failed outbox fixture");
            if row.1 == "QUEUED" && row.2 == 1 && row.3.as_deref() == Some("object_store_failed") {
                failed_write = Some(row);
                break;
            }
        }
        let (
            outbox_id,
            state_after_failure,
            attempts,
            error_code,
            retry_not_before_at,
            claimed_by,
            lease_expires_at,
        ) = failed_write.expect("outbox failure fixture reached its retry state within its bound");
        assert_eq!(state_after_failure, "QUEUED");
        assert_eq!(attempts, 1);
        assert_eq!(error_code.as_deref(), Some("object_store_failed"));
        assert!(retry_not_before_at > now_ms());
        assert_eq!(claimed_by, None);
        assert_eq!(lease_expires_at, 0);
        let fallback: (String, Option<Vec<u8>>) = sqlx::query_as(
            "SELECT storage_backend,content FROM intelligence_assets_v1 WHERE sha256=$1",
        )
        .bind(&sha256)
        .fetch_one(&unavailable_state.pool)
        .await
        .expect("read fallback asset after failed put");
        assert_eq!(fallback.0, "postgres");
        assert_eq!(fallback.1.as_deref(), Some(content.as_slice()));

        // Do not sleep through the production backoff in an opt-in E2E test.
        // The preceding assertions prove that it was persisted; releasing
        // only this exact durable row models its later eligibility without
        // waiting through the production backoff in an opt-in E2E test.
        let released = sqlx::query(
            "UPDATE intelligence_object_write_outbox_v1 SET not_before_at=$2 WHERE outbox_id=$1 AND state='QUEUED' AND attempts=1 AND last_error_code='object_store_failed'",
        )
        .bind(outbox_id)
        .bind(now_ms())
        .execute(&unavailable_state.pool)
        .await
        .expect("release only failed fixture after asserted retry");
        assert_eq!(released.rows_affected(), 1);
        // Continue driving the normal configured S3 endpoint until the same
        // outbox row has atomically promoted its PostgreSQL fallback.
        let mut promoted = None;
        for _ in 0..64 {
            // The persisted retry is released at the current millisecond;
            // PostgreSQL can observe the preceding tick on the first probe.
            // This bounded yield avoids treating that harmless eligibility
            // boundary as a storage failure.
            if !process_once(&state, "real-s3-e2e-worker").await {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
            let row: (String, Option<String>, Option<Vec<u8>>) = sqlx::query_as(
                "SELECT storage_backend,object_key,content FROM intelligence_assets_v1 WHERE sha256=$1",
            )
            .bind(&sha256)
            .fetch_one(&state.pool)
            .await
            .expect("read promoted asset");
            if row.0 == "s3" {
                promoted = Some(row);
                break;
            }
        }
        let (backend, object_key, promoted_content) =
            promoted.expect("outbox promoted the fixture within its bound");
        assert_eq!(backend, "s3");
        assert!(promoted_content.is_none());
        let object_key = object_key.expect("promoted asset object key");
        let object = state
            .intelligence_object_store
            .get_range(&object_key, 0, None)
            .expect("read promoted object");
        assert_eq!(object.bytes, content);

        state
            .intelligence_object_store
            .delete(&object_key)
            .expect("delete promoted fixture object");
        sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256=$1")
            .bind(&sha256)
            .execute(&state.pool)
            .await
            .expect("delete asset fixture");
    }

    #[tokio::test]
    #[ignore = "requires explicit real PostgreSQL and S3-compatible object-store confirmation"]
    async fn real_s3_gc_outbox_deletes_its_durable_object() {
        let database_url = std::env::var("KUNPENG_SYNC_TEST_DATABASE_URL")
            .expect("real S3 GC E2E requires protected test database URL");
        let endpoint = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_ENDPOINT")
            .expect("real S3 GC E2E requires protected endpoint");
        let bucket = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_BUCKET")
            .expect("real S3 GC E2E requires protected bucket");
        let access_key_id = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_ACCESS_KEY_ID")
            .expect("real S3 GC E2E requires protected access key");
        let secret_access_key = std::env::var("KUNPENG_SYNC_OBJECT_STORE_E2E_SECRET_ACCESS_KEY")
            .expect("real S3 GC E2E requires protected secret");
        let database = database_url.rsplit('/').next().unwrap_or_default();
        assert!(database.starts_with("reader_sync_rust_test_"));

        let mut config = Config::for_test(&database_url);
        // The protected PostgreSQL E2E suite applies migrations first. This
        // test verifies only a real durable object deletion through the
        // already-migrated GC outbox.
        config.run_migrations = false;
        config.database_max_connections = 4;
        config.database_acquire_timeout = Duration::from_secs(5);
        config.intelligence_object_storage =
            IntelligenceObjectStorageConfig::S3(S3ObjectStorageConfig {
                endpoint,
                region: "us-east-1".to_owned(),
                bucket,
                access_key_id: SecretString::from(access_key_id),
                secret_access_key: SecretString::from(secret_access_key),
                session_token: None,
            });
        let state = crate::build_state(config)
            .await
            .expect("build real S3 GC test state");

        let object_key = format!("intelligence/e2e/gc/{}.bin", Uuid::new_v4());
        let payload = format!("outbox-real-s3-gc-e2e:{}", Uuid::new_v4()).into_bytes();
        state
            .intelligence_object_store
            .put(&object_key, &payload)
            .expect("create disposable real S3 GC fixture object");
        let before_gc = state
            .intelligence_object_store
            .get_range(&object_key, 0, None)
            .expect("read real S3 GC fixture before durable deletion");
        assert_eq!(before_gc.bytes, payload);

        let outbox_id = Uuid::new_v4();
        let now = now_ms();
        sqlx::query(
            "INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3)",
        )
        .bind(outbox_id)
        .bind(&object_key)
        .bind(now)
        .execute(&state.pool)
        .await
        .expect("insert disposable GC outbox fixture");

        // This protected database can retain unrelated queues from an
        // interrupted rehearsal. Keep every other eligible candidate locked
        // until this one process_once call is finished: it must exercise the
        // exact fixture above rather than consuming someone else's retry.
        let mut queue_locks = state.pool.begin().await.expect("begin queue locks");
        let lock_now = now_ms();
        for statement in [
            "SELECT outbox_id FROM intelligence_object_write_outbox_v1 WHERE state='QUEUED' OR (state='CLAIMED' AND lease_expires_at <= $1) FOR UPDATE SKIP LOCKED",
            "SELECT outbox_id FROM intelligence_archive_object_write_outbox_v1 WHERE state='QUEUED' OR (state='CLAIMED' AND lease_expires_at <= $1) FOR UPDATE SKIP LOCKED",
            "SELECT outbox_id FROM intelligence_object_gc_outbox_v1 WHERE outbox_id <> $2 AND (state IN ('QUEUED','FAILED') OR (state='CLAIMED' AND lease_expires_at <= $1)) FOR UPDATE SKIP LOCKED",
        ] {
            let mut query = sqlx::query(statement).bind(lock_now);
            if statement.contains("outbox_id <> $2") {
                query = query.bind(outbox_id);
            }
            query
                .fetch_all(&mut *queue_locks)
                .await
                .expect("lock unrelated durable outbox candidates");
        }

        assert!(process_once(&state, "real-s3-gc-e2e-worker").await);
        let row: (String, i32, Option<String>, Option<String>, i64, i64) = sqlx::query_as(
            "SELECT state,attempts,last_error_code,claimed_by,lease_expires_at,completed_at FROM intelligence_object_gc_outbox_v1 WHERE outbox_id=$1",
        )
        .bind(outbox_id)
        .fetch_one(&state.pool)
        .await
        .expect("read completed GC outbox fixture");
        assert_eq!(row.0, "COMPLETE");
        assert_eq!(row.1, 1);
        assert_eq!(row.2, None);
        assert_eq!(row.3, None);
        assert_eq!(row.4, 0);
        assert!(row.5 > 0);
        assert!(
            state
                .intelligence_object_store
                .get_range(&object_key, 0, None)
                .is_err()
        );

        queue_locks.rollback().await.expect("release queue locks");
        sqlx::query("DELETE FROM intelligence_object_gc_outbox_v1 WHERE outbox_id=$1")
            .bind(outbox_id)
            .execute(&state.pool)
            .await
            .expect("delete completed disposable GC fixture row");
    }
}
