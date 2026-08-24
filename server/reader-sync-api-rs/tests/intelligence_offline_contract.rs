//! Offline guardrails for the intelligence V1 data boundary.
//!
//! These assertions deliberately never construct a `PostgreSQL` connection.  They
//! protect invariants that must be true before an authenticated request is
//! allowed to reach the database: expiry filtering, draft invisibility,
//! account-scoped reads/writes, durable idempotency, and bounded relay polling.

fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source
        .split_once(start)
        .expect("start marker exists")
        .1
        .split_once(end)
        .expect("end marker exists")
        .0
}

#[test]
fn published_read_paths_exclude_expired_content_and_drafts() {
    let source = include_str!("../src/intelligence.rs");
    let feed = section(source, "pub async fn feed", "pub async fn publication");
    let publication = section(
        source,
        "pub async fn publication",
        "pub async fn preferences",
    );
    let asset = section(source, "pub async fn asset", "pub async fn init_upload");

    assert!(feed.contains("intelligence_publications_v1 WHERE expires_at>$1"));
    assert!(publication.contains("WHERE publication_id=$1 AND expires_at>$2"));
    assert!(publication.contains("Ok(None) => ApiError::NotFound"));
    assert!(asset.contains("a.expires_at>$2"));
    assert!(asset.contains("p.expires_at>$2"));

    for read_path in [feed, publication, asset] {
        assert!(
            !read_path.contains("intelligence_publication_drafts_v1"),
            "draft rows must never be readable through a public content path"
        );
    }
}

#[test]
fn account_scoped_state_and_idempotency_are_explicit_in_sql() {
    let source = include_str!("../src/intelligence.rs");
    let archive = include_str!("../src/intelligence_archive.rs");

    assert!(source.contains("WHERE account_id=$1"));
    assert!(source.contains("WHERE account_id=$1 AND publication_id=$2"));
    assert!(source.contains("ON CONFLICT (account_id,publication_id) DO NOTHING"));
    assert!(
        source.contains("WHERE account_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE")
    );
    assert!(source.contains("ApiError::IdempotencyKeyReused"));
    let device_delivery =
        include_str!("../migrations/0034_intelligence_device_delivery_state_v1.sql");
    assert!(device_delivery.contains("intelligence_device_delivery_cursors_v1"));
    assert!(device_delivery.contains("REFERENCES intelligence_devices_v1(account_id, device_id)"));
    assert!(source.contains("persist_device_cursor"));
    assert!(source.contains("ensure_active_device"));

    assert!(
        archive.contains("UNIQUE (user_id, request_fingerprint)")
            || include_str!("../migrations/0026_intelligence_archive_relay_v1.sql")
                .contains("UNIQUE (user_id, request_fingerprint)")
    );
    assert!(archive.contains("WHERE r.request_id=$1 AND r.user_id=$2"));
    assert!(archive.contains("WHERE request_id=$1 AND user_id=$2"));
    assert!(archive.contains("WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE"));
    assert!(archive.contains("ApiError::IdempotencyKeyReused"));
}

#[test]
fn authenticated_accounts_without_the_feed_capability_are_explicitly_forbidden() {
    let intelligence = include_str!("../src/intelligence.rs");
    let archive = include_str!("../src/intelligence_archive.rs");
    let errors = include_str!("../src/error.rs");

    for source in [intelligence, archive] {
        let reader = section(source, "async fn reader", "async fn ");
        assert!(reader.contains("user.intelligence_feed_enabled"));
        assert!(reader.contains("ApiError::IntelligenceAccessDenied"));
    }
    assert!(errors.contains("Self::IntelligenceAccessDenied => ("));
    assert!(errors.contains("StatusCode::FORBIDDEN,"));
    assert!(errors.contains("\"INTELLIGENCE_ACCESS_DENIED\","));
}

#[test]
fn archive_relay_long_poll_is_separate_and_bounded() {
    let source = include_str!("../src/intelligence_archive.rs");

    assert!(source.contains("const MAX_WAIT_SECONDS: u8 = 25"));
    assert!(source.contains("if wait > MAX_WAIT_SECONDS"));
    assert!(source.contains("static LONG_POLL_SLOTS"));
    assert!(source.contains("LONG_POLL_SLOTS.try_acquire()"));
    assert!(source.contains("Instant::now() + TokioDuration::from_secs"));
    assert!(source.contains("if tokio::time::Instant::now() >= deadline"));
    assert!(source.contains("jobs: Vec::new()"));
}

#[test]
fn relay_and_image_uploads_are_resumable_but_staging_is_never_public_content() {
    let archive = include_str!("../src/intelligence_archive.rs");
    let intelligence = include_str!("../src/intelligence.rs");
    let migration = include_str!("../migrations/0028_intelligence_resumable_uploads_v1.sql");

    assert!(archive.contains("pub async fn init_chunked_upload"));
    assert!(archive.contains("pub async fn upload_chunk"));
    assert!(archive.contains("pub async fn complete_chunked_upload"));
    assert!(archive.contains("offset != row.received_bytes"));
    assert!(archive.contains("hash(&row.content)"));

    assert!(intelligence.contains("pub async fn init_asset_upload"));
    assert!(intelligence.contains("pub async fn upload_asset_chunk"));
    assert!(intelligence.contains("pub async fn complete_asset_upload"));
    assert!(intelligence.contains("ensure_bundle_assets"));
    assert!(migration.contains("intelligence_archive_uploads_v1"));
    assert!(migration.contains("intelligence_asset_uploads_v1"));
    assert!(!migration.contains("sync_assets_v4"));
}
