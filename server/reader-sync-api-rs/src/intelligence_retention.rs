//! Strict 30-day deletion for public intelligence distribution data.
//!
//! This module intentionally owns no HTTP route.  A privileged scheduler calls
//! [`purge_expired_publications`]; client reads remain protected independently
//! by `expires_at > now` predicates in `intelligence.rs`.  Keeping both gates
//! is essential: a missed or delayed scheduler run must never revive day-31
//! content, and a successful cleanup removes all content bytes instead of just
//! hiding them from a feed.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use metrics::counter;
use sqlx::{PgPool, Postgres, Transaction};
use tokio::{
    task::JoinHandle,
    time::{Duration as TokioDuration, MissedTickBehavior, interval},
};
use uuid::Uuid;

use crate::state::AppState;

const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_RECLAIM_INTERVAL: TokioDuration = TokioDuration::from_mins(15);
/// Keep one retention transaction bounded even when a publisher has produced
/// a large number of expired image rows while the scheduler was unavailable.
const MAX_ORPHANED_ASSETS_PER_RUN: i64 = 512;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| {
            i64::try_from(value.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Runs a bounded, independent 30-day content reclaimer.  It neither logs nor
/// labels metrics with publication, account, source, URL, or asset data.
/// Readers remain protected by their own expiry predicates if this work is
/// delayed or a database operation fails.
pub(crate) fn spawn_reclaimer(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = interval(RETENTION_RECLAIM_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            match purge_expired_publications(&state.pool, now_ms()).await {
                Ok(report) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "intelligence_retention", "outcome" => "success").increment(1);
                    counter!("reader_sync_background_maintenance_items_total", "job" => "intelligence_retention_publications").increment(report.publications_purged);
                }
                Err(_) => {
                    counter!("reader_sync_background_maintenance_runs_total", "job" => "intelligence_retention", "outcome" => "error").increment(1);
                }
            }
        }
    })
}

/// One complete, ordered transaction for content deletion.
///
/// The constants are public so the scheduled host and tests share an auditable
/// definition of the required order.  Do not merge the asset sweep before the
/// reference deletion: doing so obscures a broken reference invariant.
pub const PURGE_STEPS: [&str; 10] = [
    "mark_purging",
    "record_content_free_receipt",
    "delete_account_delivery_references",
    "delete_publication_asset_references",
    "enqueue_unreferenced_s3_images_for_gc",
    "delete_unreferenced_images",
    "delete_publication_content",
    "delete_expired_draft_content",
    "delete_expired_idempotency_receipts",
    "complete_and_remove_transient_queue",
];

/// Result counters contain operational data only; they are safe to emit as a
/// metric but not as a publication log.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PurgeReport {
    pub run_id: Uuid,
    pub cutoff_at: i64,
    pub publications_purged: u64,
    pub delivery_refs_deleted: u64,
    pub asset_refs_deleted: u64,
    pub assets_deleted: u64,
    pub draft_rows_deleted: u64,
    pub receipts_deleted: u64,
}

impl PurgeReport {
    fn database_counts(&self) -> [i64; 6] {
        [
            i64::try_from(self.publications_purged).unwrap_or(i64::MAX),
            i64::try_from(self.delivery_refs_deleted).unwrap_or(i64::MAX),
            i64::try_from(self.asset_refs_deleted).unwrap_or(i64::MAX),
            i64::try_from(self.assets_deleted).unwrap_or(i64::MAX),
            i64::try_from(self.draft_rows_deleted).unwrap_or(i64::MAX),
            i64::try_from(self.receipts_deleted).unwrap_or(i64::MAX),
        ]
    }
}

/// Returns true only when a formal publication is at least 30 days old.
///
/// The boundary is intentionally inclusive: reads require `expires_at > now`,
/// therefore `expires_at == now` is already inaccessible and eligible for
/// physical deletion.
#[must_use]
pub const fn is_expired_at(expires_at: i64, now: i64) -> bool {
    expires_at <= now
}

/// Validates the invariant before a scheduler attempts any database mutation.
#[must_use]
pub fn exact_thirty_day_expiry(published_at: i64, expires_at: i64) -> bool {
    expires_at
        .checked_sub(published_at)
        .is_some_and(|delta| delta == THIRTY_DAYS_MS)
}

/// Physically purges expired public content in a single database transaction.
///
/// A failed transaction leaves the public rows untouched.  The failed run
/// record is retained as permitted operational metadata, without an error
/// string or any publication content.  Callers should schedule this regularly
/// but must never rely on it for authorization: every read query retains its
/// `expires_at > now` predicate.
///
/// # Errors
///
/// Returns an error when a retention-run marker, its deletion transaction, or
/// the final run-state update cannot be written to `PostgreSQL`.
pub async fn purge_expired_publications(pool: &PgPool, now: i64) -> Result<PurgeReport> {
    let mut report = PurgeReport {
        run_id: Uuid::new_v4(),
        cutoff_at: now,
        ..PurgeReport::default()
    };

    sqlx::query(
        "INSERT INTO intelligence_retention_runs_v1 (run_id,state,cutoff_at,started_at) VALUES ($1,'PURGING',$2,$2)",
    )
    .bind(report.run_id)
    .bind(now)
    .execute(pool)
    .await
    .context("start intelligence retention run")?;

    let outcome = purge_transaction(pool, &mut report, now).await;
    if outcome.is_err() {
        // Do not persist database error text: it can include SQL or driver
        // details.  State plus timestamp is enough to alert the scheduler.
        let _ = sqlx::query(
            "UPDATE intelligence_retention_runs_v1 SET state='FAILED',finished_at=$2 WHERE run_id=$1 AND state='PURGING'",
        )
        .bind(report.run_id)
        .bind(now)
        .execute(pool)
        .await;
    }
    outcome?;
    Ok(report)
}

async fn purge_transaction(pool: &PgPool, report: &mut PurgeReport, now: i64) -> Result<()> {
    let mut tx = pool
        .begin()
        .await
        .context("begin intelligence retention transaction")?;
    enqueue_expired(&mut tx, report.run_id, now).await?;
    copy_content_free_receipts(&mut tx, report.run_id, now).await?;

    report.delivery_refs_deleted = delete_delivery_refs(&mut tx, report.run_id).await?;
    report.asset_refs_deleted = delete_asset_refs(&mut tx, report.run_id).await?;
    report.assets_deleted = delete_orphaned_images(&mut tx, now).await?;
    report.publications_purged = delete_publications(&mut tx, report.run_id).await?;
    report.draft_rows_deleted = delete_expired_drafts(&mut tx, now).await?;
    report.receipts_deleted = delete_expired_receipts(&mut tx, now).await?;

    let [
        publications,
        deliveries,
        asset_refs,
        assets,
        drafts,
        receipts,
    ] = report.database_counts();
    sqlx::query(
        "UPDATE intelligence_retention_runs_v1 SET state='COMPLETE',finished_at=$2,publications_purged=$3,delivery_refs_deleted=$4,asset_refs_deleted=$5,assets_deleted=$6,draft_rows_deleted=$7,receipts_deleted=$8 WHERE run_id=$1 AND state='PURGING'",
    )
    .bind(report.run_id)
    .bind(now)
    .bind(publications)
    .bind(deliveries)
    .bind(asset_refs)
    .bind(assets)
    .bind(drafts)
    .bind(receipts)
    .execute(&mut *tx)
    .await
    .context("complete intelligence retention run")?;
    sqlx::query("DELETE FROM intelligence_publication_purge_queue_v1 WHERE run_id=$1")
        .bind(report.run_id)
        .execute(&mut *tx)
        .await
        .context("remove transient intelligence purge queue")?;
    tx.commit()
        .await
        .context("commit intelligence retention transaction")
}

async fn enqueue_expired(tx: &mut Transaction<'_, Postgres>, run_id: Uuid, now: i64) -> Result<()> {
    sqlx::query(
        "INSERT INTO intelligence_publication_purge_queue_v1 (run_id,publication_id,state,queued_at) SELECT $1,p.publication_id,'PURGING',$2 FROM intelligence_publications_v1 p WHERE p.expires_at <= $2 AND NOT EXISTS (SELECT 1 FROM intelligence_publication_purge_queue_v1 q WHERE q.publication_id=p.publication_id) FOR UPDATE SKIP LOCKED",
    )
    .bind(run_id)
    .bind(now)
    .execute(&mut **tx)
    .await
    .context("mark expired intelligence publications purging")?;
    Ok(())
}

async fn copy_content_free_receipts(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO intelligence_purged_publication_receipts_v1 (published_day,kind,revision_no,bundle_sha256,publisher_installation_id,purged_at) SELECT to_timestamp(p.published_at / 1000.0)::date,p.kind,p.revision_no,p.bundle_sha256,c.installation_id,$2 FROM intelligence_publications_v1 p JOIN intelligence_publication_purge_queue_v1 q ON q.publication_id=p.publication_id JOIN intelligence_publisher_credentials_v1 c ON c.token_digest=p.publisher_token_digest WHERE q.run_id=$1 ON CONFLICT DO NOTHING",
    )
    .bind(run_id)
    .bind(now)
    .execute(&mut **tx)
    .await
    .context("record content-free intelligence purge receipts")?;
    sqlx::query(
        "INSERT INTO intelligence_archive_calendar_v1 (archive_day,purged_publication_count,updated_at) SELECT to_timestamp(p.published_at / 1000.0)::date,COUNT(*),$2 FROM intelligence_publications_v1 p JOIN intelligence_publication_purge_queue_v1 q ON q.publication_id=p.publication_id WHERE q.run_id=$1 GROUP BY 1 ON CONFLICT (archive_day) DO UPDATE SET purged_publication_count=intelligence_archive_calendar_v1.purged_publication_count + EXCLUDED.purged_publication_count,updated_at=EXCLUDED.updated_at",
    )
    .bind(run_id)
    .bind(now)
    .execute(&mut **tx)
    .await
    .context("update content-free intelligence archive calendar")?;
    Ok(())
}

async fn delete_delivery_refs(tx: &mut Transaction<'_, Postgres>, run_id: Uuid) -> Result<u64> {
    sqlx::query(
        "DELETE FROM intelligence_delivery_state_v1 d USING intelligence_publication_purge_queue_v1 q WHERE q.run_id=$1 AND d.publication_id=q.publication_id",
    )
    .bind(run_id)
    .execute(&mut **tx)
    .await
    .map(|result| result.rows_affected())
    .context("delete intelligence account delivery references")
}

async fn delete_asset_refs(tx: &mut Transaction<'_, Postgres>, run_id: Uuid) -> Result<u64> {
    sqlx::query(
        "DELETE FROM intelligence_publication_asset_refs_v1 r USING intelligence_publication_purge_queue_v1 q WHERE q.run_id=$1 AND r.publication_id=q.publication_id",
    )
    .bind(run_id)
    .execute(&mut **tx)
    .await
    .map(|result| result.rows_affected())
    .context("delete intelligence publication image references")
}

async fn delete_orphaned_images(tx: &mut Transaction<'_, Postgres>, now: i64) -> Result<u64> {
    // An S3 asset cannot be deleted directly from this database transaction.
    // Persist its GC intent first, then remove the authoritative database
    // reference in the same transaction.  This preserves recovery after a
    // crash between SQL commit and the object-store worker's DELETE.
    let candidates = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT a.sha256,a.storage_backend,a.object_key FROM intelligence_assets_v1 a \
         WHERE a.expires_at <= $1 OR NOT EXISTS ( \
           SELECT 1 FROM intelligence_publication_asset_refs_v1 r \
           JOIN intelligence_publications_v1 p ON p.publication_id=r.publication_id \
           WHERE r.sha256=a.sha256 AND p.expires_at>$1 \
         ) ORDER BY a.sha256 LIMIT $2 FOR UPDATE",
    )
    .bind(now)
    .bind(MAX_ORPHANED_ASSETS_PER_RUN)
    .fetch_all(&mut **tx)
    .await
    .context("select expired intelligence images")?;

    let mut deleted = 0_u64;
    for (sha256, storage_backend, object_key) in candidates {
        if storage_backend == "s3" {
            let object_key = object_key
                .filter(|key| valid_asset_object_key(&sha256, key))
                .context("invalid expired intelligence image object key")?;
            sqlx::query(
                "INSERT INTO intelligence_object_gc_outbox_v1 (outbox_id,storage_backend,object_key,state,not_before_at,created_at,updated_at) \
                 VALUES ($1,'s3',$2,'QUEUED',$3,$3,$3) \
                 ON CONFLICT (storage_backend,object_key) DO UPDATE SET \
                   state=CASE WHEN intelligence_object_gc_outbox_v1.state='COMPLETE' THEN 'QUEUED' ELSE intelligence_object_gc_outbox_v1.state END, \
                   not_before_at=LEAST(intelligence_object_gc_outbox_v1.not_before_at,EXCLUDED.not_before_at), \
                   updated_at=EXCLUDED.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(object_key)
            .bind(now)
            .execute(&mut **tx)
            .await
            .context("enqueue expired intelligence image object GC")?;
        }
        deleted = deleted.saturating_add(
            sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256=$1")
                .bind(sha256)
                .execute(&mut **tx)
                .await
                .context("delete expired intelligence image row")?
                .rows_affected(),
        );
    }
    Ok(deleted)
}

fn valid_asset_object_key(sha256: &str, object_key: &str) -> bool {
    sha256.len() == 64
        && sha256
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && object_key == format!("intelligence/assets/{sha256}")
}

async fn delete_publications(tx: &mut Transaction<'_, Postgres>, run_id: Uuid) -> Result<u64> {
    sqlx::query(
        "DELETE FROM intelligence_publications_v1 p USING intelligence_publication_purge_queue_v1 q WHERE q.run_id=$1 AND p.publication_id=q.publication_id",
    )
    .bind(run_id)
    .execute(&mut **tx)
    .await
    .map(|result| result.rows_affected())
    .context("delete expired intelligence publication content")
}

async fn delete_expired_drafts(tx: &mut Transaction<'_, Postgres>, now: i64) -> Result<u64> {
    sqlx::query("DELETE FROM intelligence_publication_drafts_v1 WHERE expires_at <= $1")
        .bind(now)
        .execute(&mut **tx)
        .await
        .map(|result| result.rows_affected())
        .context("delete expired intelligence draft content")
}

async fn delete_expired_receipts(tx: &mut Transaction<'_, Postgres>, now: i64) -> Result<u64> {
    let cutoff = now.saturating_sub(THIRTY_DAYS_MS);
    let publisher =
        sqlx::query("DELETE FROM intelligence_publication_receipts_v1 WHERE created_at <= $1")
            .bind(cutoff)
            .execute(&mut **tx)
            .await
            .context("delete expired intelligence publisher receipts")?
            .rows_affected();
    let account =
        sqlx::query("DELETE FROM intelligence_account_receipts_v1 WHERE created_at <= $1")
            .bind(cutoff)
            .execute(&mut **tx)
            .await
            .context("delete expired intelligence account receipts")?
            .rows_affected();
    Ok(publisher.saturating_add(account))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_boundary_matches_read_security_gate() {
        assert!(is_expired_at(100, 100));
        assert!(is_expired_at(99, 100));
        assert!(!is_expired_at(101, 100));
        assert!(exact_thirty_day_expiry(5, 5 + THIRTY_DAYS_MS));
        assert!(!exact_thirty_day_expiry(5, 5 + THIRTY_DAYS_MS - 1));
    }

    #[test]
    fn cleanup_order_removes_references_before_images_and_content() {
        let delivery = PURGE_STEPS
            .iter()
            .position(|step| *step == "delete_account_delivery_references")
            .unwrap();
        let refs = PURGE_STEPS
            .iter()
            .position(|step| *step == "delete_publication_asset_references")
            .unwrap();
        let images = PURGE_STEPS
            .iter()
            .position(|step| *step == "delete_unreferenced_images")
            .unwrap();
        let content = PURGE_STEPS
            .iter()
            .position(|step| *step == "delete_publication_content")
            .unwrap();
        assert!(delivery < refs && refs < images && images < content);
        let object_gc = PURGE_STEPS
            .iter()
            .position(|step| *step == "enqueue_unreferenced_s3_images_for_gc")
            .unwrap();
        assert!(refs < object_gc && object_gc < images);
    }

    #[test]
    fn retention_migration_has_no_long_lived_content_columns() {
        let migration = include_str!("../migrations/0027_intelligence_retention_v1.sql");
        let receipt_start = migration
            .find("CREATE TABLE intelligence_purged_publication_receipts_v1")
            .unwrap();
        let receipt_end = migration[receipt_start..]
            .find("CREATE TABLE intelligence_archive_calendar_v1")
            .map(|offset| receipt_start + offset)
            .unwrap();
        let receipt_schema = &migration[receipt_start..receipt_end];
        for prohibited in [
            "title",
            "summary",
            "original_url",
            "content bytea",
            "bundle jsonb",
            "note",
        ] {
            assert!(
                !receipt_schema.contains(prohibited),
                "retention schema must not preserve {prohibited}"
            );
        }
        assert!(migration.contains("PURGING"));
        assert!(migration.contains("intelligence_archive_calendar_v1"));
        assert!(migration.contains("bundle_sha256"));
    }

    #[test]
    fn object_storage_image_keys_are_content_addressed_before_gc() {
        let sha256 = "a".repeat(64);
        assert!(valid_asset_object_key(
            &sha256,
            "intelligence/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!valid_asset_object_key(
            &sha256,
            "intelligence/assets/not-a-digest"
        ));
    }

    #[test]
    fn asset_sweep_requires_a_live_publication_reference() {
        let source = include_str!("intelligence_retention.rs");
        let index = source
            .find("SELECT a.sha256,a.storage_backend,a.object_key FROM intelligence_assets_v1")
            .unwrap();
        let statement = &source[index..index + 350];
        assert!(statement.contains("intelligence_publication_asset_refs_v1"));
        assert!(statement.contains("intelligence_publications_v1"));
        assert!(statement.contains("p.expires_at>$1"));
        assert!(source.contains("intelligence_object_gc_outbox_v1"));
    }

    #[test]
    fn every_public_read_path_has_an_independent_expiry_gate() {
        let source = include_str!("intelligence.rs");
        // Feed pagination, one immutable bundle, and the image route must all
        // reject day-31 data even if maintenance is delayed or unavailable.
        assert!(source.matches("WHERE expires_at>$1").count() >= 2);
        assert!(source.contains("WHERE publication_id=$1 AND expires_at>$2"));
        assert!(source.contains("a.expires_at>$2"));
        assert!(source.contains("p.expires_at>$2"));
    }
}
