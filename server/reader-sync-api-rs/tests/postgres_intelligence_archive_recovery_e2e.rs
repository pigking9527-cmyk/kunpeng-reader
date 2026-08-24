//! Real router and `PostgreSQL` proof for a resumable archive relay.
//!
//! This is intentionally stricter than the ordinary integration tests: an
//! explicit disposable `reader_sync_rust_test_*` database is mandatory.  It
//! drives the reader and relay HTTP routes through the same router, while the
//! one direct SQL time adjustment is limited to expiring a claim lease before
//! the real reaper is invoked.

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
    app,
    config::Config,
    credentials::{hash_password, intelligence_publisher_token_digest},
    intelligence_archive::reap_archive_jobs,
    state::AppState,
};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

static DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const ACCOUNT_A: &str = "archive-recovery-route-e2e-a";
const PASSWORD: &str = "archive-recovery-route-e2e-password";
const RELAY_TOKEN: &str = "archive-recovery-route-e2e-relay-token";
const RELAY_INSTALLATION: &str = "archive-recovery-e2e-host";
const PRIMARY_DAY: &str = "2026-08-24";
const LEASE_DAY: &str = "2026-08-23";

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
        write!(&mut encoded, "{byte:02x}").expect("write digest into string");
    }
    encoded
}

/// This test deliberately refuses the no-environment case.  A skipped test
/// would make the archive recovery promise look covered on a developer box.
fn explicit_test_database_url() -> String {
    let url = std::env::var("KUNPENG_SYNC_TEST_DATABASE_URL")
        .expect("KUNPENG_SYNC_TEST_DATABASE_URL is required for archive recovery E2E");
    let database = url
        .rsplit('/')
        .next()
        .expect("database URL contains a database name")
        .split('?')
        .next()
        .expect("database name before query");
    assert!(
        database.starts_with("reader_sync_rust_test_"),
        "refusing to modify a database without the reader_sync_rust_test_ prefix"
    );
    url
}

#[allow(clippy::needless_pass_by_value)] // Serialized directly into the test body.
fn request(method: &str, uri: &str, bearer: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-sync-protocol-version", "5");
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::from(body.to_string())).expect("request");
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
    request
}

fn idempotent_request(
    method: &str,
    uri: &str,
    bearer: &str,
    idempotency_key: &str,
    body: Value,
) -> Request<Body> {
    let mut request = request(method, uri, Some(bearer), body);
    request.headers_mut().insert(
        "idempotency-key",
        idempotency_key.parse().expect("valid idempotency key"),
    );
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

async fn login(service: &Router, account: &str, installation_id: &str) -> String {
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/login",
            None,
            json!({
                "username": account,
                "password": PASSWORD,
                "installationId": installation_id,
                "deviceName": installation_id,
            }),
        ))
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

fn relay_digest() -> Vec<u8> {
    let config = Config::for_test("postgresql://unused.invalid/reader_sync_rust_test_unused");
    intelligence_publisher_token_digest(
        &config.token_hmac_key,
        &SecretString::from(RELAY_TOKEN.to_owned()),
    )
    .expect("derive relay test digest")
    .to_vec()
}

async fn clean_fixture(pool: &PgPool) {
    let job_ids = sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM intelligence_archive_requests_v1 WHERE user_id=$1 RETURNING job_id",
    )
    .bind(ACCOUNT_A)
    .fetch_all(pool)
    .await
    .expect("remove synthetic archive requests");
    if !job_ids.is_empty() {
        sqlx::query("DELETE FROM intelligence_archive_jobs_v1 WHERE job_id = ANY($1)")
            .bind(job_ids)
            .execute(pool)
            .await
            .expect("remove synthetic archive jobs");
    }
    let digest = relay_digest();
    sqlx::query(
        "DELETE FROM intelligence_archive_relay_receipts_v1 WHERE publisher_token_digest=$1",
    )
    .bind(&digest)
    .execute(pool)
    .await
    .expect("remove synthetic relay receipts");
    sqlx::query("DELETE FROM intelligence_publisher_credentials_v1 WHERE token_digest=$1")
        .bind(&digest)
        .execute(pool)
        .await
        .expect("remove synthetic relay credential");
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(ACCOUNT_A)
        .execute(pool)
        .await
        .expect("remove synthetic accounts");
}

async fn seed_fixture(pool: &PgPool) {
    clean_fixture(pool).await;
    let password_hash =
        hash_password(&SecretString::from(PASSWORD.to_owned())).expect("hash synthetic password");
    let now = current_ms();
    for account in [ACCOUNT_A] {
        sqlx::query(
            "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at,intelligence_feed_enabled) \
             VALUES ($1,$1,$1,$2,$3,$3,true)",
        )
        .bind(account)
        .bind(&password_hash)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert synthetic account");
    }
    sqlx::query(
        "INSERT INTO intelligence_publisher_credentials_v1 \
         (token_digest,installation_id,capabilities,expires_at,created_at) \
         VALUES ($1,$2,ARRAY['intelligence:relay'],$3,$4)",
    )
    .bind(relay_digest())
    .bind(RELAY_INSTALLATION)
    .bind(now + 7 * 24 * 60 * 60 * 1_000_i64)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert synthetic relay credential");
}

async fn create_archive_request(service: &Router, token: &str, key: &str, day: &str) -> Uuid {
    let response = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            "/v1/intelligence/archive-requests",
            token,
            key,
            json!({"request":{"day":day}}),
        ))
        .await
        .expect("archive request response");
    assert_eq!(response.status(), StatusCode::CREATED);
    Uuid::parse_str(
        response_json(response).await["requestId"]
            .as_str()
            .expect("archive request id"),
    )
    .expect("UUID archive request id")
}

async fn relay_json(service: &Router, method: &str, uri: &str, key: &str, body: Value) -> Value {
    let response = service
        .clone()
        .oneshot(idempotent_request(method, uri, RELAY_TOKEN, key, body))
        .await
        .expect("relay response");
    assert!(
        response.status().is_success(),
        "relay endpoint {method} {uri} must succeed, got {}",
        response.status()
    );
    response_json(response).await
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // Explicitly ordered HTTP exchanges document recovery causality.
async fn archive_relay_resumes_chunked_package_then_acknowledges_and_recovers_expired_lease() {
    let database_url = explicit_test_database_url();
    let _guard = DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&database_url)
        .await
        .expect("connect to explicit archive recovery test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit archive recovery test database");
    seed_fixture(&pool).await;
    let service = router(pool.clone(), &database_url);

    let token_a = login(&service, ACCOUNT_A, "archive-recovery-reader-a").await;
    let request_a =
        create_archive_request(&service, &token_a, "archive-recovery-create-a", PRIMARY_DAY).await;
    let job_a: Uuid = sqlx::query_scalar(
        "SELECT job_id FROM intelligence_archive_requests_v1 WHERE request_id=$1",
    )
    .bind(request_a)
    .fetch_one(&pool)
    .await
    .expect("account A job id");

    let heartbeat = relay_json(
        &service,
        "POST",
        "/v1/intelligence/publisher/heartbeat",
        "archive-recovery-heartbeat",
        json!({"schemaVersion":1,"installationId":RELAY_INSTALLATION}),
    )
    .await;
    assert_eq!(heartbeat["schemaVersion"], 1);

    let listed = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/intelligence/publisher/jobs?wait=0",
            Some(RELAY_TOKEN),
            Value::Null,
        ))
        .await
        .expect("relay jobs response");
    assert_eq!(listed.status(), StatusCode::OK);
    assert!(
        response_json(listed).await["jobs"]
            .as_array()
            .expect("jobs array")
            .iter()
            .any(|job| job["jobId"] == job_a.to_string())
    );

    let claimed = relay_json(
        &service,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/claim"),
        "archive-recovery-claim",
        Value::Null,
    )
    .await;
    assert_eq!(claimed["jobId"], job_a.to_string());

    let content = b"archive recovery package: interrupted upload resumes".to_vec();
    let content_hash = Sha256::digest(&content);
    let content_hash_hex = lowercase_hex(content_hash);
    let split_at = content.len() / 2;
    let first = &content[..split_at];
    let second = &content[split_at..];
    let initialized = relay_json(
        &service,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/uploads/init"),
        "archive-recovery-init-1",
        json!({"totalBytes":content.len(),"contentSha256":content_hash_hex}),
    )
    .await;
    assert_eq!(initialized["receivedBytes"], 0);
    let upload_id = initialized["uploadId"]
        .as_str()
        .expect("upload id")
        .to_owned();
    let first_progress = relay_json(
        &service,
        "PUT",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/uploads/{upload_id}"),
        "archive-recovery-first-chunk",
        json!({
            "offset":0,
            "contentBase64":STANDARD.encode(first),
            "chunkSha256":lowercase_hex(Sha256::digest(first)),
        }),
    )
    .await;
    assert_eq!(
        first_progress["receivedBytes"],
        u64::try_from(first.len()).expect("first length fits JSON")
    );

    let resumed = relay_json(
        &service,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/uploads/init"),
        "archive-recovery-init-resume",
        json!({"totalBytes":content.len(),"contentSha256":lowercase_hex(Sha256::digest(&content))}),
    )
    .await;
    assert_eq!(resumed["uploadId"], upload_id);
    assert_eq!(resumed["receivedBytes"], first_progress["receivedBytes"]);

    let second_progress = relay_json(
        &service,
        "PUT",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/uploads/{upload_id}"),
        "archive-recovery-second-chunk",
        json!({
            "offset":first.len(),
            "contentBase64":STANDARD.encode(second),
            "chunkSha256":lowercase_hex(Sha256::digest(second)),
        }),
    )
    .await;
    assert_eq!(
        second_progress["receivedBytes"],
        u64::try_from(content.len()).expect("content length fits JSON")
    );
    let completed = relay_json(
        &service,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{job_a}/uploads/{upload_id}/complete"),
        "archive-recovery-complete",
        Value::Null,
    )
    .await;
    assert_eq!(completed["complete"], true);

    let content_a = service
        .clone()
        .oneshot(request(
            "GET",
            &format!("/v1/intelligence/archive-requests/{request_a}/content"),
            Some(&token_a),
            Value::Null,
        ))
        .await
        .expect("account A content response");
    assert_eq!(content_a.status(), StatusCode::OK);
    let content_a = response_json(content_a).await;
    assert_eq!(content_a["contentSha256"], content_hash_hex);
    assert_eq!(
        STANDARD
            .decode(content_a["contentBase64"].as_str().expect("content base64"))
            .expect("decode content"),
        content
    );

    let ack_a = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/archive-requests/{request_a}/content/ack"),
            &token_a,
            "archive-recovery-ack-a",
            Value::Null,
        ))
        .await
        .expect("account A acknowledgement");
    assert_eq!(ack_a.status(), StatusCode::OK);
    let (state, remaining): (String, Option<Vec<u8>>) =
        sqlx::query_as("SELECT state,content FROM intelligence_archive_jobs_v1 WHERE job_id=$1")
            .bind(job_a)
            .fetch_one(&pool)
            .await
            .expect("final shared package state");
    assert_eq!(state, "PURGED");
    assert_eq!(remaining, None, "ACK physically clears the final package");

    // The one direct mutation only moves a real claimed job beyond its normal
    // five-minute lease.  Recovery itself remains the real reaper and jobs
    // HTTP route, so it proves a relay can resume after interruption.
    let lease_request = create_archive_request(
        &service,
        &token_a,
        "archive-recovery-create-lease",
        LEASE_DAY,
    )
    .await;
    let lease_job: Uuid = sqlx::query_scalar(
        "SELECT job_id FROM intelligence_archive_requests_v1 WHERE request_id=$1",
    )
    .bind(lease_request)
    .fetch_one(&pool)
    .await
    .expect("lease fixture job id");
    relay_json(
        &service,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{lease_job}/claim"),
        "archive-recovery-lease-claim",
        Value::Null,
    )
    .await;
    let now = current_ms();
    sqlx::query(
        "UPDATE intelligence_archive_jobs_v1 SET lease_expires_at=$2,updated_at=$2 WHERE job_id=$1 AND state='CLAIMED'",
    )
    .bind(lease_job)
    .bind(now - 1)
    .execute(&pool)
    .await
    .expect("expire claimed lease only for the recovery fixture");
    reap_archive_jobs(&pool, now)
        .await
        .expect("recover expired relay claim through reaper");
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_jobs_v1 WHERE job_id=$1",
        )
        .bind(lease_job)
        .fetch_one(&pool)
        .await
        .expect("recovered lease job state"),
        "QUEUED"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_requests_v1 WHERE request_id=$1",
        )
        .bind(lease_request)
        .fetch_one(&pool)
        .await
        .expect("recovered lease request state"),
        "QUEUED"
    );
    let recovered = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/intelligence/publisher/jobs?wait=0",
            Some(RELAY_TOKEN),
            Value::Null,
        ))
        .await
        .expect("recovered jobs response");
    assert_eq!(recovered.status(), StatusCode::OK);
    assert!(
        response_json(recovered).await["jobs"]
            .as_array()
            .expect("recovered jobs array")
            .iter()
            .any(|job| job["jobId"] == lease_job.to_string())
    );

    clean_fixture(&pool).await;
}
