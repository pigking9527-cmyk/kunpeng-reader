//! Protected `PostgreSQL` router proof for a completed intelligence image upload.
//!
//! The test deliberately drives the real authenticated publisher routes.  It
//! verifies that completion transfers bytes out of the resumable staging row
//! while preserving a hash-verified, immediately readable asset.  It does
//! nothing unless an explicitly named disposable test database is supplied.

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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use metrics_exporter_prometheus::PrometheusBuilder;
use reader_sync_api::{
    app, config::Config, credentials::intelligence_publisher_token_digest, state::AppState,
};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

static DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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
        write!(&mut encoded, "{byte:02x}").expect("write digest to string");
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

#[allow(clippy::needless_pass_by_value)] // Serialized immediately into the request body.
fn publisher_request(
    method: &str,
    uri: &str,
    publisher_token: &str,
    idempotency_key: &str,
    body: Value,
) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {publisher_token}"))
        .header("content-type", "application/json")
        .header("idempotency-key", idempotency_key)
        .header("x-sync-protocol-version", "5")
        .body(Body::from(body.to_string()))
        .expect("publisher request");
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
    installation_id: String,
    publisher_token: String,
    publisher_digest: Vec<u8>,
    sha256: String,
    content: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        let unique = Uuid::new_v4().simple().to_string();
        let publisher_token = format!("asset-upload-e2e-token-{unique}");
        let content = format!("asset-upload-router-e2e:{unique}").into_bytes();
        let config = Config::for_test("postgresql://unused.invalid/reader_sync_rust_test_unused");
        let publisher_digest = intelligence_publisher_token_digest(
            &config.token_hmac_key,
            &SecretString::from(publisher_token.clone()),
        )
        .expect("derive publisher test digest")
        .to_vec();
        Self {
            installation_id: format!("asset-upload-e2e-host-{unique}"),
            publisher_token,
            publisher_digest,
            sha256: lowercase_hex(Sha256::digest(&content)),
            content,
        }
    }
}

async fn seed_fixture(pool: &PgPool, fixture: &Fixture) {
    let now = current_ms();
    sqlx::query(
        "INSERT INTO intelligence_publisher_credentials_v1 \
         (token_digest,installation_id,capabilities,expires_at,created_at) \
         VALUES ($1,$2,ARRAY['intelligence:publish'],$3,$4)",
    )
    .bind(&fixture.publisher_digest)
    .bind(&fixture.installation_id)
    .bind(now + 24 * 60 * 60 * 1_000_i64)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert synthetic publisher credential");
}

async fn clean_fixture(pool: &PgPool, fixture: &Fixture) {
    // Publisher receipts reference the credential; delete them first even if
    // an assertion interrupted a prior run after a partial upload.
    sqlx::query("DELETE FROM intelligence_publication_receipts_v1 WHERE publisher_token_digest=$1")
        .bind(&fixture.publisher_digest)
        .execute(pool)
        .await
        .expect("remove synthetic publisher receipts");
    sqlx::query("DELETE FROM intelligence_asset_uploads_v1 WHERE sha256=$1")
        .bind(&fixture.sha256)
        .execute(pool)
        .await
        .expect("remove synthetic staging asset");
    sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256=$1")
        .bind(&fixture.sha256)
        .execute(pool)
        .await
        .expect("remove synthetic finalized asset");
    sqlx::query("DELETE FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1")
        .bind(&fixture.publisher_digest)
        .execute(pool)
        .await
        .expect("remove synthetic publisher credential");
}

async fn publisher_json(
    service: &Router,
    method: &str,
    uri: &str,
    fixture: &Fixture,
    key: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = service
        .clone()
        .oneshot(publisher_request(
            method,
            uri,
            &fixture.publisher_token,
            key,
            body,
        ))
        .await
        .expect("publisher route response");
    let status = response.status();
    (status, response_json(response).await)
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // The ordered real-HTTP exchange is the behavior under test.
async fn publisher_asset_upload_completes_without_retaining_staging_content() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&database_url)
        .await
        .expect("connect to explicit asset-upload test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit asset-upload test database");

    let fixture = Fixture::new();
    seed_fixture(&pool, &fixture).await;
    let service = router(pool.clone(), &database_url);
    let first_len = fixture.content.len() / 2;
    let first = &fixture.content[..first_len];
    let second = &fixture.content[first_len..];

    let (status, initialized) = publisher_json(
        &service,
        "POST",
        "/v1/intelligence/assets/init",
        &fixture,
        "asset-upload-e2e-init",
        json!({
            "sha256": fixture.sha256,
            "mime": "image/png",
            "totalBytes": fixture.content.len(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(initialized["sha256"], fixture.sha256);
    assert_eq!(initialized["receivedBytes"], 0);
    assert_eq!(initialized["complete"], false);

    for (offset, bytes, key) in [
        (0_i64, first, "asset-upload-e2e-first"),
        (
            i64::try_from(first.len()).expect("first chunk length fits i64"),
            second,
            "asset-upload-e2e-second",
        ),
    ] {
        let (status, progress) = publisher_json(
            &service,
            "PUT",
            &format!("/v1/intelligence/assets/{}", fixture.sha256),
            &fixture,
            key,
            json!({
                "offset": offset,
                "contentBase64": STANDARD.encode(bytes),
                "chunkSha256": lowercase_hex(Sha256::digest(bytes)),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(progress["complete"], false);
    }

    let (status, completed) = publisher_json(
        &service,
        "POST",
        &format!("/v1/intelligence/assets/{}/complete", fixture.sha256),
        &fixture,
        "asset-upload-e2e-complete",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(completed["sha256"], fixture.sha256);
    assert_eq!(
        completed["receivedBytes"],
        i64::try_from(fixture.content.len()).expect("asset length fits i64")
    );
    assert_eq!(completed["complete"], true);

    let (completed_at, received_bytes, retained_bytes): (i64, i64, i32) = sqlx::query_as(
        "SELECT completed_at,received_bytes,octet_length(content) \
         FROM intelligence_asset_uploads_v1 WHERE sha256=$1",
    )
    .bind(&fixture.sha256)
    .fetch_one(&pool)
    .await
    .expect("completed staging row");
    assert!(completed_at > 0, "staging upload is marked completed");
    assert_eq!(
        received_bytes, 0,
        "completed staging upload resets progress"
    );
    assert_eq!(
        retained_bytes, 0,
        "completed staging upload retains no bytes"
    );

    let (stored_sha256, stored_content, stored_bytes): (String, Vec<u8>, i64) =
        sqlx::query_as("SELECT sha256,content,bytes FROM intelligence_assets_v1 WHERE sha256=$1")
            .bind(&fixture.sha256)
            .fetch_one(&pool)
            .await
            .expect("finalized asset row");
    assert_eq!(stored_sha256, fixture.sha256);
    assert_eq!(stored_content, fixture.content);
    assert_eq!(
        stored_bytes,
        i64::try_from(fixture.content.len()).expect("asset length fits i64")
    );
    assert_eq!(
        lowercase_hex(Sha256::digest(&stored_content)),
        fixture.sha256,
        "finalized bytes must remain hash-addressable"
    );

    clean_fixture(&pool, &fixture).await;
}
