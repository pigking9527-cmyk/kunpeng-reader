//! Protected `PostgreSQL` router proof for intelligence account boundaries.
//!
//! The fixture deliberately uses only uniquely named test rows, rather than
//! truncating a shared rehearsal database.  It does nothing without an
//! explicit disposable `reader_sync_rust_test_*` connection string.

use std::{
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
use reader_sync_api::{app, config::Config, credentials::hash_password, state::AppState};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

static DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const ACCOUNT_A: &str = "intelligence-route-e2e-a";
const ACCOUNT_B: &str = "intelligence-route-e2e-b";
const ACCOUNT_DISABLED: &str = "intelligence-route-e2e-disabled";
const PUBLICATION_ID: &str = "daily:route-e2e:2026-08-24";
const ASSET_SHA256: &str = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

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

#[allow(clippy::needless_pass_by_value)] // The test helper serializes JSON immediately into a request body.
fn request(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-sync-protocol-version", "5");
    if let Some(token) = token {
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
    token: &str,
    idempotency_key: &str,
    body: Value,
) -> Request<Body> {
    let mut request = request(method, uri, Some(token), body);
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

async fn login(service: &Router, username: &str, password: &str, installation_id: &str) -> String {
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/login",
            None,
            json!({
                "username": username,
                "password": password,
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

async fn clean_fixture(pool: &PgPool) {
    let job_ids = sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM intelligence_archive_requests_v1 \
         WHERE user_id IN ($1,$2,$3) RETURNING job_id",
    )
    .bind(ACCOUNT_A)
    .bind(ACCOUNT_B)
    .bind(ACCOUNT_DISABLED)
    .fetch_all(pool)
    .await
    .expect("remove prior synthetic archive requests");
    if !job_ids.is_empty() {
        sqlx::query("DELETE FROM intelligence_archive_jobs_v1 WHERE job_id = ANY($1)")
            .bind(job_ids)
            .execute(pool)
            .await
            .expect("remove prior synthetic archive jobs");
    }
    sqlx::query("DELETE FROM intelligence_publications_v1 WHERE publication_id=$1")
        .bind(PUBLICATION_ID)
        .execute(pool)
        .await
        .expect("remove prior synthetic publication");
    sqlx::query("DELETE FROM intelligence_assets_v1 WHERE sha256=$1")
        .bind(ASSET_SHA256)
        .execute(pool)
        .await
        .expect("remove prior synthetic asset");
    sqlx::query(
        "DELETE FROM intelligence_publisher_credentials_v1 WHERE installation_id='route-e2e-host'",
    )
    .execute(pool)
    .await
    .expect("remove prior synthetic publisher credential");
    sqlx::query("DELETE FROM users WHERE id IN ($1,$2,$3)")
        .bind(ACCOUNT_A)
        .bind(ACCOUNT_B)
        .bind(ACCOUNT_DISABLED)
        .execute(pool)
        .await
        .expect("remove prior synthetic accounts");
}

async fn seed_fixture(pool: &PgPool) {
    clean_fixture(pool).await;
    let password_hash = hash_password(&SecretString::from("route-e2e-password".to_owned()))
        .expect("hash synthetic password");
    for (id, enabled) in [
        (ACCOUNT_A, true),
        (ACCOUNT_B, true),
        (ACCOUNT_DISABLED, false),
    ] {
        sqlx::query(
            "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at,intelligence_feed_enabled) \
             VALUES ($1,$1,$1,$2,$3,$3,$4)",
        )
        .bind(id)
        .bind(&password_hash)
        .bind(current_ms())
        .bind(enabled)
        .execute(pool)
        .await
        .expect("insert synthetic account");
    }

    let now = current_ms();
    let publisher_digest = vec![0x6e_u8; 32];
    sqlx::query(
        "INSERT INTO intelligence_publisher_credentials_v1 \
         (token_digest,installation_id,capabilities,expires_at,created_at) \
         VALUES ($1,'route-e2e-host',ARRAY['intelligence:publish'],$2,$3)",
    )
    .bind(&publisher_digest)
    .bind(now + 31 * 24 * 60 * 60 * 1_000)
    .bind(now)
    .execute(pool)
    .await
    .expect("insert synthetic publisher credential");
    sqlx::query(
        "INSERT INTO intelligence_assets_v1 (sha256,mime,content,bytes,expires_at) \
         VALUES ($1,'image/png',$2,4,$3)",
    )
    .bind(ASSET_SHA256)
    .bind(vec![1_u8, 2, 3, 4])
    .bind(now + 30 * 24 * 60 * 60 * 1_000)
    .execute(pool)
    .await
    .expect("insert synthetic asset");
    sqlx::query(
        "INSERT INTO intelligence_publications_v1 \
         (publication_id,kind,published_at,expires_at,issued_at,revision_no,importance,bundle,bundle_sha256,publisher_token_digest,completed_at) \
         VALUES ($1,'daily',$2,$3,$2,1,50,$4,$5,$6,$2)",
    )
    .bind(PUBLICATION_ID)
    .bind(now)
    .bind(now + 30 * 24 * 60 * 60 * 1_000)
    .bind(json!({"schemaVersion": 1, "publicationId": PUBLICATION_ID, "routeE2e": true}))
    .bind(vec![0x31_u8; 32])
    .bind(publisher_digest)
    .execute(pool)
    .await
    .expect("insert synthetic publication");
    sqlx::query(
        "INSERT INTO intelligence_publication_asset_refs_v1 (publication_id,sha256) VALUES ($1,$2)",
    )
    .bind(PUBLICATION_ID)
    .bind(ASSET_SHA256)
    .execute(pool)
    .await
    .expect("insert synthetic asset reference");
}

async fn create_archive_request(service: &Router, token: &str, key: &str) -> Uuid {
    let response = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            "/v1/intelligence/archive-requests",
            token,
            key,
            json!({"request":{"day":"2026-08-24"}}),
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

#[tokio::test]
#[allow(clippy::too_many_lines)] // Full router lifecycle proves account isolation, not SQL predicates.
async fn permitted_readers_share_current_content_but_not_archive_request_or_ack_state() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _guard = DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit route test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit route test database");
    seed_fixture(&pool).await;
    let service = router(pool.clone(), &database_url);

    let token_a = login(&service, ACCOUNT_A, "route-e2e-password", "route-e2e-a").await;
    let token_b = login(&service, ACCOUNT_B, "route-e2e-password", "route-e2e-b").await;
    let token_disabled = login(
        &service,
        ACCOUNT_DISABLED,
        "route-e2e-password",
        "route-e2e-disabled",
    )
    .await;

    for token in [&token_a, &token_b] {
        let feed = service
            .clone()
            .oneshot(request(
                "GET",
                "/v1/intelligence/feed",
                Some(token),
                Value::Null,
            ))
            .await
            .expect("feed response");
        assert_eq!(feed.status(), StatusCode::OK);
        assert!(
            response_json(feed).await["items"]
                .as_array()
                .expect("feed items")
                .iter()
                .any(|item| item["publicationId"] == PUBLICATION_ID)
        );

        let publication = service
            .clone()
            .oneshot(request(
                "GET",
                &format!("/v1/intelligence/publications/{PUBLICATION_ID}"),
                Some(token),
                Value::Null,
            ))
            .await
            .expect("publication response");
        assert_eq!(publication.status(), StatusCode::OK);
        assert_eq!(
            response_json(publication).await["publicationId"],
            PUBLICATION_ID
        );

        let asset = service
            .clone()
            .oneshot(request(
                "GET",
                &format!("/v1/intelligence/assets/{ASSET_SHA256}"),
                Some(token),
                Value::Null,
            ))
            .await
            .expect("asset response");
        assert_eq!(asset.status(), StatusCode::OK);
    }
    for uri in [
        "/v1/intelligence/feed".to_owned(),
        format!("/v1/intelligence/publications/{PUBLICATION_ID}"),
        format!("/v1/intelligence/assets/{ASSET_SHA256}"),
    ] {
        let denied = service
            .clone()
            .oneshot(request("GET", &uri, Some(&token_disabled), Value::Null))
            .await
            .expect("disabled reader response");
        assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{uri}");
    }

    let request_a = create_archive_request(&service, &token_a, "route-e2e-archive-a").await;
    let request_b = create_archive_request(&service, &token_b, "route-e2e-archive-b").await;
    let content = b"route-e2e-archive-content".to_vec();
    let content_hash = sha2::Sha256::digest(&content).to_vec();
    // Associate both requests with a bounded ready package.  This intentionally
    // bypasses the publisher network relay: the assertions below exercise only
    // authenticated reader routes and their account predicates.
    let now = current_ms();
    let job_id: Uuid = sqlx::query_scalar(
        "SELECT job_id FROM intelligence_archive_requests_v1 WHERE request_id=$1",
    )
    .bind(request_a)
    .fetch_one(&pool)
    .await
    .expect("shared archive job");
    sqlx::query(
        "UPDATE intelligence_archive_jobs_v1 \
         SET state='READY',content=$2,content_sha256=$3,content_expires_at=$4,updated_at=$5 \
         WHERE job_id=$1",
    )
    .bind(job_id)
    .bind(&content)
    .bind(&content_hash)
    .bind(now + 60 * 60 * 1_000)
    .bind(now)
    .execute(&pool)
    .await
    .expect("make shared package ready");
    sqlx::query("UPDATE intelligence_archive_requests_v1 SET state='READY',updated_at=$2 WHERE request_id IN ($1,$3)")
        .bind(request_a)
        .bind(now)
        .bind(request_b)
        .execute(&pool)
        .await
        .expect("make both account requests ready");

    for (uri, token) in [
        (
            format!("/v1/intelligence/archive-requests/{request_a}"),
            &token_b,
        ),
        (
            format!("/v1/intelligence/archive-requests/{request_a}/content"),
            &token_b,
        ),
        (
            format!("/v1/intelligence/archive-requests/{request_b}"),
            &token_a,
        ),
    ] {
        let forbidden = service
            .clone()
            .oneshot(request("GET", &uri, Some(token), Value::Null))
            .await
            .expect("cross-account archive response");
        assert_eq!(forbidden.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    let cross_account_ack = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/archive-requests/{request_a}/content/ack"),
            &token_b,
            "route-e2e-cross-account-ack",
            Value::Null,
        ))
        .await
        .expect("cross-account archive acknowledgement response");
    assert_eq!(cross_account_ack.status(), StatusCode::NOT_FOUND);

    let downloaded_a = service
        .clone()
        .oneshot(request(
            "GET",
            &format!("/v1/intelligence/archive-requests/{request_a}/content"),
            Some(&token_a),
            Value::Null,
        ))
        .await
        .expect("account A archive content");
    assert_eq!(downloaded_a.status(), StatusCode::OK);
    let ack_a = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/archive-requests/{request_a}/content/ack"),
            &token_a,
            "route-e2e-ack-a",
            Value::Null,
        ))
        .await
        .expect("account A acknowledgement");
    assert_eq!(ack_a.status(), StatusCode::OK);

    let readable_b = service
        .clone()
        .oneshot(request(
            "GET",
            &format!("/v1/intelligence/archive-requests/{request_b}/content"),
            Some(&token_b),
            Value::Null,
        ))
        .await
        .expect("account B archive content remains readable");
    assert_eq!(readable_b.status(), StatusCode::OK);
    let body = response_json(readable_b).await;
    assert_eq!(body["requestId"], request_b.to_string());

    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_requests_v1 WHERE request_id=$1",
        )
        .bind(request_a)
        .fetch_one(&pool)
        .await
        .expect("account A archive state"),
        "ACKED"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT state FROM intelligence_archive_requests_v1 WHERE request_id=$1",
        )
        .bind(request_b)
        .fetch_one(&pool)
        .await
        .expect("account B archive state"),
        "DOWNLOADED"
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<Vec<u8>>>(
            "SELECT content FROM intelligence_archive_jobs_v1 WHERE job_id=$1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .expect("shared package content"),
        Some(content)
    );

    clean_fixture(&pool).await;
}
