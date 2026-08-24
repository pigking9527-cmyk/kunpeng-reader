//! Protected `PostgreSQL` proof for the private host-inference relay.
//!
//! It deliberately exercises only uniquely named synthetic rows, and runs
//! only when explicitly pointed at a disposable `reader_sync_rust_test_*`
//! database.  No fixture contains a usable credential or plaintext task.

use std::{
    fmt::Write as _,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use metrics_exporter_prometheus::PrometheusBuilder;
use reader_sync_api::{app, config::Config, credentials::hash_password, state::AppState};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::Semaphore;
use tower::ServiceExt;

const ACCOUNT_A: &str = "host-relay-e2e-a";
const ACCOUNT_B: &str = "host-relay-e2e-b";
const PASSWORD: &str = "host-relay-e2e-password";
const OFFER_TOKEN: &str = "host-relay-e2e-offer-token-that-is-long-enough";

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

#[allow(clippy::needless_pass_by_value)] // The helper serializes the JSON body immediately.
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
        "127.0.0.1:54322"
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

fn router(pool: PgPool, database_url: &str) -> Router {
    let mut config = Config::for_test(database_url);
    config.intelligence_host_inference_enabled = true;
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

async fn login(service: &Router, username: &str, installation_id: &str) -> String {
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/login",
            None,
            json!({
                "username": username,
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

async fn clean_fixture(pool: &PgPool) {
    sqlx::query(
        "DELETE FROM intelligence_host_request_receipts_v1 WHERE actor_id=$1 \
         OR actor_id IN (SELECT pair_id::text FROM intelligence_host_pairings_v1 WHERE account_id=$1)",
    )
    .bind(ACCOUNT_A)
    .execute(pool)
    .await
    .expect("remove prior account A receipts");
    sqlx::query("DELETE FROM intelligence_host_request_receipts_v1 WHERE actor_id=$1")
        .bind(ACCOUNT_B)
        .execute(pool)
        .await
        .expect("remove prior account B receipts");
    sqlx::query("DELETE FROM intelligence_host_pairing_offers_v1 WHERE account_id IN ($1,$2)")
        .bind(ACCOUNT_A)
        .bind(ACCOUNT_B)
        .execute(pool)
        .await
        .expect("remove prior synthetic offers");
    sqlx::query("DELETE FROM users WHERE id IN ($1,$2)")
        .bind(ACCOUNT_A)
        .bind(ACCOUNT_B)
        .execute(pool)
        .await
        .expect("remove prior synthetic accounts");
}

async fn seed_fixture(pool: &PgPool) {
    clean_fixture(pool).await;
    let password_hash =
        hash_password(&SecretString::from(PASSWORD.to_owned())).expect("hash synthetic password");
    for account in [ACCOUNT_A, ACCOUNT_B] {
        sqlx::query(
            "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at,intelligence_feed_enabled) \
             VALUES ($1,$1,$1,$2,$3,$3,false)",
        )
        .bind(account)
        .bind(&password_hash)
        .bind(current_ms())
        .execute(pool)
        .await
        .expect("insert synthetic account");
    }
}

fn opaque_envelope(recipient: &str, sender: &str, bytes: &[u8]) -> Value {
    let ciphertext = URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(bytes);
    let mut digest_hex = String::with_capacity(64);
    for byte in digest {
        write!(digest_hex, "{byte:02x}").expect("string write");
    }
    json!({
        "schemaVersion": 1,
        "suite": "HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305",
        "recipientKeyId": recipient,
        "senderKeyId": sender,
        "enc": URL_SAFE_NO_PAD.encode([7_u8; 16]),
        "ciphertext": ciphertext,
        "ciphertextSha256": digest_hex,
        "compression": "zstd",
    })
}

fn task_request(task_id: &str, pair_id: &str, expires_at: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "pairId": pair_id,
        "operation": "library_answer",
        "capabilityRevision": 1,
        "expiresAt": expires_at,
        "requestEnvelope": opaque_envelope("key:host-e2e", "key:client-e2e", task_id.as_bytes()),
    })
}

async fn create_task(
    service: &Router,
    account_token: &str,
    pair_id: &str,
    task_id: &str,
    key: &str,
    expires_at: &str,
) -> axum::response::Response {
    service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            "/v1/intelligence/host-tasks",
            account_token,
            key,
            task_request(task_id, pair_id, expires_at),
        ))
        .await
        .expect("create task response")
}

async fn host_claim(
    service: &Router,
    host_token: &str,
    task_id: &str,
    key: &str,
) -> axum::response::Response {
    service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{task_id}/claim"),
            host_token,
            key,
            Value::Null,
        ))
        .await
        .expect("claim task response")
}

async fn cancel_task(
    service: &Router,
    account_token: &str,
    task_id: &str,
    key: &str,
) -> axum::response::Response {
    service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{task_id}/cancel"),
            account_token,
            key,
            Value::Null,
        ))
        .await
        .expect("cancel task response")
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One lifecycle gives stronger cross-route isolation proof than disconnected SQL assertions.
async fn host_relay_preserves_receipts_isolation_cancellation_and_safe_failures() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect(&database_url)
        .await
        .expect("connect to explicit host relay test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit host relay test database");
    seed_fixture(&pool).await;
    let service = router(pool.clone(), &database_url);
    let account_token = login(&service, ACCOUNT_A, "host-relay-e2e-account-a").await;
    let other_account_token = login(&service, ACCOUNT_B, "host-relay-e2e-account-b").await;

    let offer = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            "/v1/intelligence/host-pairings/offers",
            &account_token,
            "host-relay-offer",
            json!({
                "schemaVersion": 1,
                "offerToken": OFFER_TOKEN,
                "clientKeyId": "key:client-e2e",
                "clientPublicKey": URL_SAFE_NO_PAD.encode([1_u8; 16]),
            }),
        ))
        .await
        .expect("create pairing offer");
    assert_eq!(offer.status(), StatusCode::CREATED);
    let offer_id = response_json(offer).await["offerId"]
        .as_str()
        .expect("offer id")
        .to_owned();
    let claim_offer = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-pairings/offers/{offer_id}/claim"),
            &account_token,
            "host-relay-claim-offer",
            json!({
                "schemaVersion": 1,
                "offerToken": OFFER_TOKEN,
                "hostInstallationId": "host-relay-e2e-installation",
                "hostKeyId": "key:host-e2e",
                "hostPublicKey": URL_SAFE_NO_PAD.encode([2_u8; 16]),
                "capabilities": ["library_answer"],
            }),
        ))
        .await
        .expect("claim pairing offer");
    assert_eq!(claim_offer.status(), StatusCode::OK);
    let pairing = response_json(claim_offer).await;
    let pair_id = pairing["pairId"].as_str().expect("pair id").to_owned();
    let host_token = pairing["capabilityToken"]
        .as_str()
        .expect("capability token")
        .to_owned();
    let expires_at = (OffsetDateTime::now_utc() + Duration::minutes(20))
        .format(&Rfc3339)
        .expect("format task expiry");

    let first = create_task(
        &service,
        &account_token,
        &pair_id,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-create-1",
        &expires_at,
    )
    .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_body = response_json(first).await;
    let replay = create_task(
        &service,
        &account_token,
        &pair_id,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-create-1",
        &expires_at,
    )
    .await;
    assert_eq!(
        replay.status(),
        StatusCode::CREATED,
        "create replay keeps original status"
    );
    assert_eq!(response_json(replay).await, first_body);
    let key_reused = create_task(
        &service,
        &account_token,
        &pair_id,
        "host-relay-e2e-key-reused",
        "host-relay-create-1",
        &expires_at,
    )
    .await;
    assert_eq!(key_reused.status(), StatusCode::CONFLICT);

    let host_poll = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/intelligence/host-tasks",
            Some(&host_token),
            Value::Null,
        ))
        .await
        .expect("host poll");
    assert_eq!(host_poll.status(), StatusCode::OK);
    assert_eq!(
        response_json(host_poll).await["tasks"][0]["taskId"],
        "host-relay-e2e-cancel-by-claim"
    );
    let claimed = host_claim(
        &service,
        &host_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-claim-1",
    )
    .await;
    assert_eq!(claimed.status(), StatusCode::OK);
    assert_eq!(response_json(claimed).await["state"], "CLAIMED");
    let claim_replay = host_claim(
        &service,
        &host_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-claim-1",
    )
    .await;
    assert_eq!(claim_replay.status(), StatusCode::OK);
    assert_eq!(response_json(claim_replay).await["state"], "CLAIMED");
    let running = host_claim(
        &service,
        &host_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-start-1",
    )
    .await;
    assert_eq!(running.status(), StatusCode::OK);
    assert_eq!(response_json(running).await["state"], "RUNNING");

    let cross_account = cancel_task(
        &service,
        &other_account_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-cross-account-cancel",
    )
    .await;
    assert_eq!(cross_account.status(), StatusCode::NOT_FOUND);
    let cancellation = cancel_task(
        &service,
        &account_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-cancel-1",
    )
    .await;
    assert_eq!(cancellation.status(), StatusCode::OK);
    let cancellation = response_json(cancellation).await;
    assert_eq!(cancellation["state"], "CANCEL_REQUESTED");
    assert!(cancellation["cancelRequestedAt"].is_string());
    let cancellation_replay = cancel_task(
        &service,
        &account_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-cancel-1",
    )
    .await;
    assert_eq!(cancellation_replay.status(), StatusCode::OK);
    assert_eq!(response_json(cancellation_replay).await, cancellation);
    let cancellation_poll = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/intelligence/host-tasks",
            Some(&host_token),
            Value::Null,
        ))
        .await
        .expect("host cancellation poll");
    assert_eq!(cancellation_poll.status(), StatusCode::OK);
    assert_eq!(
        response_json(cancellation_poll).await["tasks"][0]["state"],
        "CANCEL_REQUESTED"
    );
    let cancelled = host_claim(
        &service,
        &host_token,
        "host-relay-e2e-cancel-by-claim",
        "host-relay-confirm-cancel-1",
    )
    .await;
    assert_eq!(cancelled.status(), StatusCode::OK);
    assert_eq!(response_json(cancelled).await["state"], "CANCELLED");
    let cancel_row: (String, bool, bool) = sqlx::query_as(
        "SELECT state,request_envelope IS NULL,result_envelope IS NULL FROM intelligence_host_tasks_v1 WHERE task_id=$1",
    )
    .bind("host-relay-e2e-cancel-by-claim")
    .fetch_one(&pool)
    .await
    .expect("read cancelled task");
    assert_eq!(cancel_row, ("CANCELLED".to_owned(), true, true));

    // A host can also safely confirm cancellation through the result endpoint;
    // no envelope or model error text is admitted in this path.
    let second_task = "host-relay-e2e-cancel-by-safe-failure";
    assert_eq!(
        create_task(
            &service,
            &account_token,
            &pair_id,
            second_task,
            "host-relay-create-2",
            &expires_at
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        response_json(host_claim(&service, &host_token, second_task, "host-relay-claim-2").await)
            .await["state"],
        "CLAIMED"
    );
    assert_eq!(
        response_json(host_claim(&service, &host_token, second_task, "host-relay-start-2").await)
            .await["state"],
        "RUNNING"
    );
    assert_eq!(
        response_json(
            cancel_task(&service, &account_token, second_task, "host-relay-cancel-2").await
        )
        .await["state"],
        "CANCEL_REQUESTED"
    );
    let safe_cancel = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{second_task}/result"),
            &host_token,
            "host-relay-safe-cancel-2",
            json!({"schemaVersion": 1, "taskId": second_task, "failureCode": "cancelled"}),
        ))
        .await
        .expect("safe cancellation response");
    assert_eq!(safe_cancel.status(), StatusCode::OK);
    assert_eq!(response_json(safe_cancel).await["state"], "CANCELLED");

    let failed_task = "host-relay-e2e-safe-failure";
    assert_eq!(
        create_task(
            &service,
            &account_token,
            &pair_id,
            failed_task,
            "host-relay-create-3",
            &expires_at
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        response_json(host_claim(&service, &host_token, failed_task, "host-relay-claim-3").await)
            .await["state"],
        "CLAIMED"
    );
    let failure = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{failed_task}/result"),
            &host_token,
            "host-relay-safe-failure-3",
            json!({"schemaVersion": 1, "taskId": failed_task, "failureCode": "model_failed"}),
        ))
        .await
        .expect("safe failure response");
    assert_eq!(failure.status(), StatusCode::OK);
    assert_eq!(response_json(failure).await["state"], "FAILED");
    let failed_row: (String, bool, bool) = sqlx::query_as(
        "SELECT state,request_envelope IS NULL,result_envelope IS NULL FROM intelligence_host_tasks_v1 WHERE task_id=$1",
    )
    .bind(failed_task)
    .fetch_one(&pool)
    .await
    .expect("read failed task");
    assert_eq!(failed_row, ("FAILED".to_owned(), true, true));

    let result_task = "host-relay-e2e-result-and-ack";
    assert_eq!(
        create_task(
            &service,
            &account_token,
            &pair_id,
            result_task,
            "host-relay-create-4",
            &expires_at
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        response_json(host_claim(&service, &host_token, result_task, "host-relay-claim-4").await)
            .await["state"],
        "CLAIMED"
    );
    let result = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{result_task}/result"),
            &host_token,
            "host-relay-result-4",
            json!({
                "schemaVersion": 1,
                "taskId": result_task,
                "resultEnvelope": opaque_envelope("key:client-e2e", "key:host-e2e", b"opaque-result"),
            }),
        ))
        .await
        .expect("result response");
    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(response_json(result).await["state"], "RESULT_READY");
    let ack = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{result_task}/ack"),
            &account_token,
            "host-relay-ack-4",
            Value::Null,
        ))
        .await
        .expect("ack response");
    assert_eq!(ack.status(), StatusCode::NO_CONTENT);
    let ack_replay = service
        .clone()
        .oneshot(idempotent_request(
            "POST",
            &format!("/v1/intelligence/host-tasks/{result_task}/ack"),
            &account_token,
            "host-relay-ack-4",
            Value::Null,
        ))
        .await
        .expect("ack replay response");
    assert_eq!(ack_replay.status(), StatusCode::NO_CONTENT);
    let purged_row: (String, bool, bool) = sqlx::query_as(
        "SELECT state,request_envelope IS NULL,result_envelope IS NULL FROM intelligence_host_tasks_v1 WHERE task_id=$1",
    )
    .bind(result_task)
    .fetch_one(&pool)
    .await
    .expect("read purged task");
    assert_eq!(purged_row, ("PURGED".to_owned(), true, true));

    let host_receipts: Vec<String> = sqlx::query_scalar(
        "SELECT response::text FROM intelligence_host_request_receipts_v1 WHERE actor_kind='host' AND actor_id=$1",
    )
    .bind(&pair_id)
    .fetch_all(&pool)
    .await
    .expect("read host receipts");
    assert!(!host_receipts.is_empty());
    assert!(
        host_receipts
            .iter()
            .all(|receipt| !receipt.contains("ciphertext"))
    );

    clean_fixture(&pool).await;
}
