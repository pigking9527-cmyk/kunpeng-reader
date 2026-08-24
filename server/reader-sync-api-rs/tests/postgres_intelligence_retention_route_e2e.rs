//! Protected `PostgreSQL` router proof for day-31 intelligence removal.
//!
//! This deliberately exercises the real Axum router with a real account
//! session after the reclaimer has physically removed an expired publication.
//! It does nothing unless the caller explicitly supplies a disposable
//! `reader_sync_rust_test_*` database.

use std::{
    fmt::Write as _,
    sync::{Arc, LazyLock},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use metrics_exporter_prometheus::PrometheusBuilder;
use reader_sync_api::{
    app, config::Config, credentials::hash_password,
    intelligence_retention::purge_expired_publications, state::AppState,
};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

static DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

fn current_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_millis(),
    )
    .expect("current milliseconds fit i64")
}

fn lowercase_hex(bytes: impl AsRef<[u8]>) -> String {
    let mut encoded = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        write!(&mut encoded, "{byte:02x}").expect("write to string");
    }
    encoded
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

fn request(method: &str, uri: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-sync-protocol-version", "5");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::empty()).expect("request");
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
    request
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read response")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("JSON response")
}

async fn login(service: &Router, username: &str, password: &str, installation_id: &str) -> String {
    let mut request = request("POST", "/v1/auth/login", None);
    *request.body_mut() = Body::from(
        json!({
            "username": username,
            "password": password,
            "installationId": installation_id,
            "deviceName": installation_id,
        })
        .to_string(),
    );
    request
        .headers_mut()
        .insert("content-type", "application/json".parse().expect("header"));
    let response = service
        .clone()
        .oneshot(request)
        .await
        .expect("login response");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "authenticate fixture account"
    );
    response_json(response).await["token"]
        .as_str()
        .expect("session token")
        .to_owned()
}

fn router(pool: PgPool, database_url: &str) -> Router {
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    app(AppState {
        pool,
        metrics: recorder.handle(),
        request_slots: Arc::new(Semaphore::new(config.max_concurrent_requests)),
        checkpoint_request_slots: Arc::new(Semaphore::new(
            config.max_concurrent_checkpoint_requests,
        )),
        read_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_read_requests)),
        checkpoint_request_queue_slots: Arc::new(Semaphore::new(
            config.max_queued_checkpoint_requests,
        )),
        write_request_slots: Arc::new(Semaphore::new(config.max_concurrent_write_requests)),
        write_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_write_requests)),
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        intelligence_object_store: AppState::disabled_intelligence_object_store(),
        config,
    })
}

struct Fixture {
    account_id: String,
    username: String,
    publication_id: String,
    asset_sha256: String,
    publisher_digest: Vec<u8>,
    bundle_sha256: Vec<u8>,
    installation_id: String,
}

impl Fixture {
    fn new() -> Self {
        // Account usernames have the same bounded public grammar as the
        // login endpoint.  A short unique suffix keeps this real Router
        // fixture valid while still avoiding collisions in a shared test DB.
        let unique = Uuid::new_v4().simple().to_string()[..12].to_owned();
        let publication_id = format!("daily:retention-route-e2e:{unique}");
        let asset_sha256 = lowercase_hex(Sha256::digest(format!("asset:{unique}").as_bytes()));
        Self {
            account_id: format!("retention-route-e2e-{unique}"),
            username: format!("retentionroute{unique}"),
            publication_id,
            asset_sha256,
            publisher_digest: Sha256::digest(format!("publisher:{unique}").as_bytes()).to_vec(),
            bundle_sha256: Sha256::digest(format!("bundle:{unique}").as_bytes()).to_vec(),
            installation_id: format!("retention-route-e2e-host-{unique}"),
        }
    }
}

async fn seed_fixture(pool: &PgPool, fixture: &Fixture, now: i64) {
    let password_hash = hash_password(&SecretString::from(
        "retention-route-e2e-password".to_owned(),
    ))
    .expect("hash synthetic password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at,intelligence_feed_enabled) \
         VALUES ($1,$2,$2,$3,$4,$4,true)",
    )
    .bind(&fixture.account_id)
    .bind(&fixture.username)
    .bind(&password_hash)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert synthetic account");
    sqlx::query(
        "INSERT INTO intelligence_publisher_credentials_v1 \
         (token_digest,installation_id,capabilities,expires_at,created_at) \
         VALUES ($1,$2,ARRAY['intelligence:publish'],$3,$4)",
    )
    .bind(&fixture.publisher_digest)
    .bind(&fixture.installation_id)
    .bind(now + 365 * 24 * 60 * 60 * 1_000)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert synthetic publisher credential");

    let expires_at = now - 1;
    let published_at = expires_at - THIRTY_DAYS_MS;
    sqlx::query(
        "INSERT INTO intelligence_assets_v1 (sha256,mime,content,bytes,expires_at) \
         VALUES ($1,'image/png',$2,4,$3)",
    )
    .bind(&fixture.asset_sha256)
    .bind(vec![1_u8, 2, 3, 4])
    .bind(expires_at)
    .execute(pool)
    .await
    .expect("insert expired synthetic asset");
    sqlx::query(
        "INSERT INTO intelligence_publications_v1 \
         (publication_id,kind,published_at,expires_at,issued_at,revision_no,importance,bundle,bundle_sha256,publisher_token_digest,completed_at) \
         VALUES ($1,'daily',$2,$3,$2,1,50,$4,$5,$6,$7)",
    )
    .bind(&fixture.publication_id)
    .bind(published_at)
    .bind(expires_at)
    .bind(json!({
        "schemaVersion": 1,
        "publicationId": fixture.publication_id,
        "title": "synthetic fixture content that must be purged",
    }))
    .bind(&fixture.bundle_sha256)
    .bind(&fixture.publisher_digest)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert formally expired synthetic publication");
    sqlx::query(
        "INSERT INTO intelligence_publication_asset_refs_v1 (publication_id,sha256) VALUES ($1,$2)",
    )
    .bind(&fixture.publication_id)
    .bind(&fixture.asset_sha256)
    .execute(pool)
    .await
    .expect("insert synthetic asset reference");
}

async fn clean_fixture(pool: &PgPool, fixture: &Fixture, run_id: Uuid) {
    // Calendar rows intentionally remain as content-free historical counts.
    sqlx::query("DELETE FROM intelligence_purged_publication_receipts_v1 WHERE bundle_sha256=$1")
        .bind(&fixture.bundle_sha256)
        .execute(pool)
        .await
        .expect("remove synthetic content-free receipt");
    sqlx::query("DELETE FROM intelligence_retention_runs_v1 WHERE run_id=$1")
        .bind(run_id)
        .execute(pool)
        .await
        .expect("remove synthetic retention run");
    sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256=$1")
        .bind(&fixture.asset_sha256)
        .execute(pool)
        .await
        .expect("remove synthetic asset if an assertion failed before purge");
    sqlx::query("DELETE FROM intelligence_publications_v1 WHERE publication_id=$1")
        .bind(&fixture.publication_id)
        .execute(pool)
        .await
        .expect("remove synthetic publication if an assertion failed before purge");
    sqlx::query("DELETE FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1")
        .bind(&fixture.publisher_digest)
        .execute(pool)
        .await
        .expect("remove synthetic publisher credential");
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(&fixture.account_id)
        .execute(pool)
        .await
        .expect("remove synthetic account");
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // This is one complete authenticated routing proof.
async fn purged_day_31_publication_and_asset_are_unreadable_through_the_router() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit retention route test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit retention route test database");

    let fixture = Fixture::new();
    let now = current_ms();
    seed_fixture(&pool, &fixture, now).await;
    let service = router(pool.clone(), &database_url);
    let token = login(
        &service,
        &fixture.username,
        "retention-route-e2e-password",
        "retention-route-e2e-reader",
    )
    .await;

    let report = purge_expired_publications(&pool, now)
        .await
        .expect("purge expiry");
    // Other expired disposable rows can exist in a shared rehearsal DB.
    // Precise fixture removal is asserted below by its unique IDs.
    assert!(report.publications_purged >= 1, "purge fixture publication");
    assert!(
        report.asset_refs_deleted >= 1,
        "purge fixture image reference"
    );
    assert!(
        report.assets_deleted >= 1,
        "purge unreferenced fixture image"
    );

    let feed = service
        .clone()
        .oneshot(request("GET", "/v1/intelligence/feed", Some(&token)))
        .await
        .expect("feed response");
    // A collection remains readable, but the removed publication must not be
    // listed.  Direct content URLs below deliberately return 404.
    assert_eq!(feed.status(), StatusCode::OK);
    assert!(
        !response_json(feed).await["items"]
            .as_array()
            .expect("feed items")
            .iter()
            .any(|item| item["publicationId"] == fixture.publication_id),
        "purged publication must not be present in the feed"
    );

    for uri in [
        format!("/v1/intelligence/publications/{}", fixture.publication_id),
        format!("/v1/intelligence/assets/{}", fixture.asset_sha256),
    ] {
        let response = service
            .clone()
            .oneshot(request("GET", &uri, Some(&token)))
            .await
            .expect("purged direct-content response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    let calendar = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/intelligence/archive/calendar",
            Some(&token),
        ))
        .await
        .expect("calendar response");
    assert_eq!(calendar.status(), StatusCode::OK);
    let calendar = response_json(calendar).await;
    for day in calendar["days"].as_array().expect("calendar days") {
        let object = day.as_object().expect("calendar day object");
        assert_eq!(object.len(), 2, "calendar row contains only day and count");
        assert!(object.contains_key("day"));
        assert!(object.contains_key("entryCount"));
        assert!(!object.contains_key("title"));
        assert!(!object.contains_key("content"));
    }

    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM intelligence_publications_v1 WHERE publication_id=$1)",
        )
        .bind(&fixture.publication_id)
        .fetch_one(&pool)
        .await
        .expect("publication physical deletion check"),
        "purge must physically delete the publication row"
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM intelligence_assets_v1 WHERE sha256=$1)",
        )
        .bind(&fixture.asset_sha256)
        .fetch_one(&pool)
        .await
        .expect("asset physical deletion check"),
        "purge must physically delete the unreferenced asset row"
    );

    clean_fixture(&pool, &fixture, report.run_id).await;
}
