//! Protected-PostgreSQL schema proof for the intelligence distribution tables.
//!
//! This test does nothing unless the caller explicitly provides a disposable
//! `reader_sync_rust_test_*` database. It validates the real migrated catalog,
//! rather than treating offline SQL-string checks as a migration rehearsal.

use std::{
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::Mutex;
use uuid::Uuid;

use reader_sync_api::{
    intelligence_archive::reap_archive_jobs, intelligence_retention::purge_expired_publications,
};

static DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn current_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after UNIX epoch")
            .as_millis(),
    )
    .expect("current milliseconds fit i64")
}

fn explicit_test_database_url() -> Option<String> {
    let url = std::env::var("KUNPENG_SYNC_TEST_DATABASE_URL").ok()?;
    let database = url.rsplit('/').next()?.split('?').next()?;
    assert!(
        database.starts_with("reader_sync_rust_test_"),
        "refusing to modify a database without the reader_sync_rust_test_ prefix"
    );
    Some(url)
}

async fn migrate_test_database(database_url: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(database_url)
        .await
        .expect("connect to explicit intelligence test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit intelligence test database");
    pool
}

#[tokio::test]
async fn intelligence_migrations_create_isolated_blob_and_delivery_schema() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = migrate_test_database(&database_url).await;

    for table in [
        "intelligence_publisher_credentials_v1",
        "intelligence_publication_drafts_v1",
        "intelligence_publications_v1",
        "intelligence_assets_v1",
        "intelligence_publication_asset_refs_v1",
        "intelligence_archive_jobs_v1",
        "intelligence_archive_requests_v1",
        "intelligence_archive_uploads_v1",
        "intelligence_asset_uploads_v1",
        "intelligence_delivery_events_v1",
        "intelligence_publication_purge_queue_v1",
        "intelligence_object_gc_outbox_v1",
        "intelligence_object_write_outbox_v1",
        "intelligence_archive_object_write_outbox_v1",
    ] {
        let present = sqlx::query_scalar::<_, Option<String>>("SELECT to_regclass($1)::text")
            .bind(format!("public.{table}"))
            .fetch_one(&pool)
            .await
            .expect("query migrated table");
        assert_eq!(present.as_deref(), Some(table), "missing {table}");
    }

    for table in [
        "intelligence_assets_v1",
        "intelligence_archive_jobs_v1",
        "intelligence_archive_uploads_v1",
        "intelligence_asset_uploads_v1",
    ] {
        let data_type = sqlx::query_scalar::<_, String>(
            "SELECT data_type FROM information_schema.columns \
             WHERE table_schema='public' AND table_name=$1 AND column_name='content'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("query intelligence blob column");
        assert_eq!(data_type, "bytea", "{table}.content storage type");
    }

    let migrations = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .expect("count applied migrations");
    assert!(
        migrations >= 33,
        "all intelligence migrations must be applied"
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // Ordered insert/assert fixtures make retention causality auditable.
async fn retention_physically_purges_day_31_content_but_keeps_live_account_data_isolated() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = migrate_test_database(&database_url).await;

    // The fixed synthetic identifiers let a prior interrupted test run cleanly
    // retry without truncating another PostgreSQL E2E fixture.
    let expired_id = "e2e-retention-expired";
    let live_id = "e2e-retention-live";
    let expired_asset = "a".repeat(64);
    let live_asset = "b".repeat(64);
    let publisher_digest = vec![41_u8; 32];
    let first_account = "intelligence-retention-e2e-a";
    let second_account = "intelligence-retention-e2e-b";
    sqlx::query("DELETE FROM intelligence_delivery_state_v1 WHERE account_id IN ($1,$2)")
        .bind(first_account)
        .bind(second_account)
        .execute(&pool)
        .await
        .expect("remove prior synthetic delivery rows");
    sqlx::query("DELETE FROM intelligence_publications_v1 WHERE publication_id IN ($1,$2)")
        .bind(expired_id)
        .bind(live_id)
        .execute(&pool)
        .await
        .expect("remove prior synthetic publications");
    sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256 IN ($1,$2)")
        .bind(&expired_asset)
        .bind(&live_asset)
        .execute(&pool)
        .await
        .expect("remove prior synthetic assets");
    sqlx::query("DELETE FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1")
        .bind(&publisher_digest)
        .execute(&pool)
        .await
        .expect("remove prior synthetic publisher credential");
    sqlx::query("DELETE FROM users WHERE id IN ($1,$2)")
        .bind(first_account)
        .bind(second_account)
        .execute(&pool)
        .await
        .expect("remove prior synthetic accounts");

    let now = current_ms();
    let thirty_days = 30 * 24 * 60 * 60 * 1_000_i64;
    // A protected rehearsal database can deliberately retain synthetic
    // expired rows from backup/restore proof.  The reclaimer is global by
    // design, so make the assertion relative to that pre-existing baseline
    // instead of assuming this test owns every expired publication.
    let expired_before = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM intelligence_publications_v1 WHERE expires_at <= $1",
    )
    .bind(now)
    .fetch_one(&pool)
    .await
    .expect("count pre-existing expired publications");
    for (id, username) in [
        (first_account, "retention-e2e-a"),
        (second_account, "retention-e2e-b"),
    ] {
        sqlx::query("INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) VALUES ($1,$2,$2,'not-a-real-password',0,0)")
            .bind(id)
            .bind(username)
            .execute(&pool)
            .await
            .expect("insert synthetic account");
    }
    sqlx::query("INSERT INTO intelligence_publisher_credentials_v1 (token_digest,installation_id,capabilities,expires_at,created_at) VALUES ($1,'retention-e2e-host',ARRAY['intelligence:publish'], $2,0)")
        .bind(&publisher_digest)
        .bind(now + thirty_days)
        .execute(&pool)
        .await
        .expect("insert synthetic publisher credential");
    for (sha, expires_at) in [(&expired_asset, now - 1), (&live_asset, now + 1)] {
        sqlx::query("INSERT INTO intelligence_assets_v1 (sha256,mime,content,bytes,expires_at) VALUES ($1,'image/png',$2,1,$3)")
            .bind(sha)
            .bind(vec![7_u8])
            .bind(expires_at)
            .execute(&pool)
            .await
            .expect("insert synthetic asset");
    }
    for (id, published_at, expires_at) in [
        (expired_id, now - thirty_days - 1, now - 1),
        (live_id, now - thirty_days + 1, now + 1),
    ] {
        sqlx::query("INSERT INTO intelligence_publications_v1 (publication_id,kind,published_at,expires_at,issued_at,revision_no,importance,bundle,bundle_sha256,publisher_token_digest,completed_at) VALUES ($1,'daily',$2,$3,$2,1,50,'{}'::jsonb,$4,$5,$2)")
            .bind(id)
            .bind(published_at)
            .bind(expires_at)
            .bind(vec![9_u8; 32])
            .bind(&publisher_digest)
            .execute(&pool)
            .await
            .expect("insert synthetic publication");
    }
    for (publication_id, sha) in [(expired_id, &expired_asset), (live_id, &live_asset)] {
        sqlx::query("INSERT INTO intelligence_publication_asset_refs_v1 (publication_id,sha256) VALUES ($1,$2)")
            .bind(publication_id)
            .bind(sha)
            .execute(&pool)
            .await
            .expect("insert synthetic asset reference");
    }
    for account_id in [first_account, second_account] {
        sqlx::query("INSERT INTO intelligence_delivery_state_v1 (account_id,publication_id,acknowledged_at) VALUES ($1,$2,$3)")
            .bind(account_id)
            .bind(expired_id)
            .bind(now - 2)
            .execute(&pool)
            .await
            .expect("insert account-scoped delivery state");
    }

    let report = purge_expired_publications(&pool, now)
        .await
        .expect("purge synthetic day-31 content");
    assert_eq!(
        report.publications_purged,
        u64::try_from(expired_before + 1).expect("row count is non-negative")
    );
    assert!(report.delivery_refs_deleted >= 2);
    assert!(report.asset_refs_deleted >= 1);
    assert!(report.assets_deleted >= 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM intelligence_publications_v1 WHERE publication_id=$1"
        )
        .bind(expired_id)
        .fetch_one(&pool)
        .await
        .expect("expired publication count"),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM intelligence_publications_v1 WHERE publication_id=$1"
        )
        .bind(live_id)
        .fetch_one(&pool)
        .await
        .expect("live publication count"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM intelligence_assets_v1 WHERE sha256=$1")
            .bind(&live_asset)
            .fetch_one(&pool)
            .await
            .expect("live asset count"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM intelligence_purged_publication_receipts_v1 WHERE bundle_sha256=$1")
            .bind(vec![9_u8; 32]).fetch_one(&pool).await.expect("content-free receipt count"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM intelligence_publication_purge_queue_v1"
        )
        .fetch_one(&pool)
        .await
        .expect("transient queue count"),
        0
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One fixture proves each archive recovery terminal transition.
async fn archive_reaper_marks_offline_recovers_leases_and_purges_expired_packages() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = migrate_test_database(&database_url).await;

    let account_a = "archive-reaper-e2e-a";
    let account_b = "archive-reaper-e2e-b";
    let offline_job = Uuid::from_u128(0xA11);
    let lease_job = Uuid::from_u128(0xA12);
    let expired_package_job = Uuid::from_u128(0xA13);
    let offline_request = Uuid::from_u128(0xB11);
    let lease_request = Uuid::from_u128(0xB12);
    let expired_package_request = Uuid::from_u128(0xB13);
    // Keep the synthetic job relative to the real protected test database
    // clock.  A fixed future timestamp accidentally made the reaper process
    // unrelated backup-rehearsal rows whose expiry was still in the future.
    let now = current_ms();

    for request_id in [offline_request, lease_request, expired_package_request] {
        sqlx::query("DELETE FROM intelligence_archive_requests_v1 WHERE request_id=$1")
            .bind(request_id)
            .execute(&pool)
            .await
            .expect("remove prior synthetic request");
    }
    for job_id in [offline_job, lease_job, expired_package_job] {
        sqlx::query("DELETE FROM intelligence_archive_jobs_v1 WHERE job_id=$1")
            .bind(job_id)
            .execute(&pool)
            .await
            .expect("remove prior synthetic job");
    }
    sqlx::query("DELETE FROM users WHERE id IN ($1,$2)")
        .bind(account_a)
        .bind(account_b)
        .execute(&pool)
        .await
        .expect("remove prior synthetic accounts");
    for (id, username) in [
        (account_a, "archive-reaper-e2e-a"),
        (account_b, "archive-reaper-e2e-b"),
    ] {
        sqlx::query("INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) VALUES ($1,$2,$2,'not-a-real-password',0,0)")
            .bind(id).bind(username).execute(&pool).await.expect("insert synthetic account");
    }
    let selector = serde_json::json!({"day":"2026-08-24"});
    for (job_id, state, created_at, lease_expires_at, content, content_expires_at) in [
        (
            offline_job,
            "QUEUED",
            now - 24 * 60 * 60 * 1_000 - 1,
            0_i64,
            None,
            0_i64,
        ),
        (lease_job, "CLAIMED", now - 1, now - 1, None, 0_i64),
        (
            expired_package_job,
            "READY",
            now - 1,
            0_i64,
            Some(vec![1_u8]),
            now - 1,
        ),
    ] {
        sqlx::query("INSERT INTO intelligence_archive_jobs_v1 (job_id,request_fingerprint,request,state,created_at,expires_at,claimed_by,lease_expires_at,content,content_sha256,content_expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$5)")
            .bind(job_id).bind(vec![job_id.as_bytes()[15]; 32]).bind(sqlx::types::Json(&selector)).bind(state)
            .bind(created_at).bind(now + 7 * 24 * 60 * 60 * 1_000).bind(Option::<Vec<u8>>::None).bind(lease_expires_at)
            .bind(content.as_deref()).bind(if content.is_some() { Some(vec![3_u8; 32]) } else { None }).bind(content_expires_at)
            .execute(&pool).await.expect("insert synthetic archive job");
    }
    for (request_id, user_id, job_id, state) in [
        (offline_request, account_a, offline_job, "REQUESTED"),
        (lease_request, account_b, lease_job, "CLAIMED"),
        (
            expired_package_request,
            account_a,
            expired_package_job,
            "READY",
        ),
    ] {
        sqlx::query("INSERT INTO intelligence_archive_requests_v1 (request_id,user_id,request_fingerprint,job_id,request,state,requested_at,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)")
            .bind(request_id).bind(user_id).bind(vec![request_id.as_bytes()[15]; 32]).bind(job_id)
            .bind(sqlx::types::Json(&selector)).bind(state).bind(now - 2).bind(now + 7 * 24 * 60 * 60 * 1_000)
            .execute(&pool).await.expect("insert synthetic archive request");
    }

    reap_archive_jobs(&pool, now)
        .await
        .expect("reap synthetic relay rows");
    for (job_id, expected) in [
        (offline_job, "HOST_OFFLINE"),
        (lease_job, "QUEUED"),
        (expired_package_job, "REQUEST_EXPIRED"),
    ] {
        let state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_jobs_v1 WHERE job_id=$1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .expect("archive job state");
        assert_eq!(state, expected);
    }
    for (request_id, expected) in [
        (offline_request, "HOST_OFFLINE"),
        (lease_request, "QUEUED"),
        (expired_package_request, "REQUEST_EXPIRED"),
    ] {
        let state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_requests_v1 WHERE request_id=$1",
        )
        .bind(request_id)
        .fetch_one(&pool)
        .await
        .expect("archive request state");
        assert_eq!(state, expected);
    }
    let (content_bytes, content_hash_bytes): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT octet_length(content),octet_length(content_sha256) FROM intelligence_archive_jobs_v1 WHERE job_id=$1",
    )
    .bind(expired_package_job).fetch_one(&pool).await.expect("expired package bytes");
    assert_eq!((content_bytes, content_hash_bytes), (None, None));
}
