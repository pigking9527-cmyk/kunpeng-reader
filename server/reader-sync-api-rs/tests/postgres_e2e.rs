use std::{
    fmt::Write as _,
    sync::{Arc, LazyLock},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::Engine;
use http_body_util::BodyExt;
use metrics_exporter_prometheus::PrometheusBuilder;
use reader_sync_api::{app, config::Config, credentials::hash_password, state::AppState};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::postgres::PgPoolOptions;
use tokio::sync::{Mutex, Semaphore};
use tower::ServiceExt;
use uuid::Uuid;

static E2E_DATABASE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn explicit_test_database_url() -> Option<String> {
    let url = std::env::var("KUNPENG_SYNC_TEST_DATABASE_URL").ok()?;
    let database = url.rsplit('/').next()?.split('?').next()?;
    assert!(
        database.starts_with("reader_sync_rust_test_"),
        "refusing to modify a database without the reader_sync_rust_test_ prefix"
    );
    Some(url)
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

fn request(method: &str, uri: &str, token: Option<&str>, body: &Value) -> Request<Body> {
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

async fn login_token(service: &Router) -> String {
    let login_body = json!({
        "username": "e2e-user",
        "password": "test-password-v4",
        "installationId": "e2e-installation",
        "deviceName": "e2e-device"
    });
    let login = service
        .clone()
        .oneshot(request("POST", "/v1/auth/login", None, &login_body))
        .await
        .expect("login response");
    assert_eq!(login.status(), StatusCode::OK);
    let login = response_json(login).await;
    assert_eq!(login["ok"], true);
    assert_eq!(login["dataGeneration"], 1);
    assert_eq!(login["syncEnabled"], true);
    login["token"].as_str().expect("session token").to_owned()
}

fn login_body(username: &str, password: &str, installation_id: &str) -> Value {
    json!({
        "username": username,
        "password": password,
        "installationId": installation_id,
        "deviceName": installation_id
    })
}

async fn login_with_password(
    service: &Router,
    username: &str,
    password: &str,
    installation_id: &str,
) -> axum::response::Response {
    service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/login",
            None,
            &login_body(username, password, installation_id),
        ))
        .await
        .expect("login response")
}

async fn assert_session_status(service: &Router, token: &str, expected: StatusCode) {
    let response = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/auth/session",
            Some(token),
            &Value::Null,
        ))
        .await
        .expect("session response");
    assert_eq!(response.status(), expected);
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    let mut value = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("write digest hex");
    }
    value
}

async fn initialize_asset(service: &Router, token: &str, asset_id: &str, byte_size: usize) -> i64 {
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/assets/init",
            Some(token),
            &json!({
                "assetId": asset_id,
                "sha256": asset_id,
                "mime": "image/png",
                "byteSize": byte_size,
                "dataGeneration": 1
            }),
        ))
        .await
        .expect("asset init response");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await["receivedBytes"]
        .as_i64()
        .expect("received byte count")
}

async fn upload_asset_chunk(
    service: &Router,
    token: &str,
    asset_id: &str,
    range: String,
    bytes: Vec<u8>,
) -> StatusCode {
    service
        .clone()
        .oneshot(binary_request(
            &format!("/v1/sync/assets/{asset_id}"),
            token,
            "image/png",
            &range,
            bytes,
        ))
        .await
        .expect("asset chunk response")
        .status()
}

async fn assert_account_identity(service: &Router, token: &str) {
    let me = service
        .clone()
        .oneshot(request("GET", "/v1/auth/me", Some(token), &Value::Null))
        .await
        .expect("account identity response");
    assert_eq!(me.status(), StatusCode::OK);
    let me = response_json(me).await;
    assert_eq!(me["user"]["id"], "e2e-user");
    assert_eq!(me["dataGeneration"], 1);
    assert_eq!(me["token"], Value::Null);
}

async fn assert_materialized_checkpoint_cursor(
    pool: &sqlx::PgPool,
    service: &Router,
    token: &str,
    user_id: &str,
) {
    let (generation, account_cursor, entity_cursor) = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT account.generation,account.server_cursor, \
                COALESCE(MAX(entity.server_cursor),0)::bigint \
         FROM account_data_generations AS account \
         LEFT JOIN sync_entities_v4 AS entity ON entity.user_id=account.user_id \
         WHERE account.user_id=$1 \
         GROUP BY account.user_id,account.generation,account.server_cursor",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("materialized checkpoint cursor");
    assert!(account_cursor > 0);
    assert_eq!(account_cursor, entity_cursor);
    let checkpoint = service
        .clone()
        .oneshot(request(
            "GET",
            &format!("/v1/sync/checkpoint?dataGeneration={generation}&cursor={account_cursor}"),
            Some(token),
            &Value::Null,
        ))
        .await
        .expect("materialized checkpoint response");
    assert_eq!(checkpoint.status(), StatusCode::OK);
    let checkpoint = response_json(checkpoint).await;
    assert_eq!(checkpoint["serverCursor"], account_cursor);
    assert_eq!(checkpoint["caughtUp"], true);
}

async fn install_checkpoint_update_audit(pool: &sqlx::PgPool) {
    remove_checkpoint_update_audit(pool).await;
    sqlx::query(
        "CREATE TABLE checkpoint_cursor_update_audit_v5_test(\
           user_id text NOT NULL,server_cursor bigint NOT NULL)",
    )
    .execute(pool)
    .await
    .expect("create checkpoint audit table");
    sqlx::query(
        "CREATE FUNCTION record_checkpoint_cursor_update_v5_test() \
         RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN \
           INSERT INTO checkpoint_cursor_update_audit_v5_test(user_id,server_cursor) \
           VALUES(NEW.user_id,NEW.server_cursor); \
           RETURN NEW; \
         END; \
         $$",
    )
    .execute(pool)
    .await
    .expect("create checkpoint audit function");
    sqlx::query(
        "CREATE TRIGGER checkpoint_cursor_update_audit_v5_test \
         AFTER UPDATE OF server_cursor ON account_data_generations \
         FOR EACH ROW EXECUTE FUNCTION record_checkpoint_cursor_update_v5_test()",
    )
    .execute(pool)
    .await
    .expect("create checkpoint audit trigger");
}

async fn remove_checkpoint_update_audit(pool: &sqlx::PgPool) {
    sqlx::query(
        "DROP TRIGGER IF EXISTS checkpoint_cursor_update_audit_v5_test \
         ON account_data_generations",
    )
    .execute(pool)
    .await
    .expect("drop previous checkpoint audit trigger");
    sqlx::query("DROP FUNCTION IF EXISTS record_checkpoint_cursor_update_v5_test()")
        .execute(pool)
        .await
        .expect("drop previous checkpoint audit function");
    sqlx::query("DROP TABLE IF EXISTS checkpoint_cursor_update_audit_v5_test")
        .execute(pool)
        .await
        .expect("drop previous checkpoint audit table");
}

async fn assert_bulk_push_updates_checkpoint_once(
    pool: &sqlx::PgPool,
    service: &Router,
    token: &str,
    entities: Value,
) {
    sqlx::query("TRUNCATE checkpoint_cursor_update_audit_v5_test")
        .execute(pool)
        .await
        .expect("reset checkpoint audit");
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(token),
            &json!({
                "mutationId": Uuid::new_v4(),
                "dataGeneration": 1,
                "entities": entities
            }),
        ))
        .await
        .expect("audited bulk push");
    assert_eq!(response.status(), StatusCode::OK);
    let update_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM checkpoint_cursor_update_audit_v5_test \
         WHERE user_id='load-rehearsal-user'",
    )
    .fetch_one(pool)
    .await
    .expect("checkpoint account update count");
    assert_eq!(update_count, 1, "one account-row update per bulk push");
}

fn checkpoint_audit_entity(id: &str, updated_at: i64, sync_version: i64) -> Value {
    json!({
        "id": id,
        "kind": "bookmark",
        "updatedAt": updated_at,
        "deletedAt": 0,
        "deviceId": "checkpoint-audit-device",
        "syncVersion": sync_version,
        "payload": {"chapter": sync_version}
    })
}

async fn data_reset_fixture(database_url: &str) -> (sqlx::PgPool, Router) {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    let password = SecretString::from("reset-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('data-reset-user','data-reset-user','data-reset-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert test user");
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    (pool, app(state))
}

async fn assert_data_reset_database_state(pool: &sqlx::PgPool) {
    for (query, expected, label) in [
        (
            "SELECT COUNT(*) FROM sync_entities_v4 WHERE user_id='data-reset-user'",
            0,
            "entity count",
        ),
        (
            "SELECT COUNT(*) FROM sync_push_receipts_v4 WHERE user_id='data-reset-user'",
            0,
            "receipt count",
        ),
        (
            "SELECT COUNT(*) FROM sync_assets_v4 WHERE user_id='data-reset-user'",
            0,
            "asset count",
        ),
        (
            "SELECT COUNT(*) FROM sync_secret_bundle_epochs_v5 WHERE user_id='data-reset-user'",
            0,
            "secret epoch count",
        ),
        (
            "SELECT generation FROM account_data_generations WHERE user_id='data-reset-user'",
            2,
            "generation",
        ),
        (
            "SELECT server_cursor FROM account_data_generations WHERE user_id='data-reset-user'",
            0,
            "checkpoint cursor",
        ),
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(query)
                .fetch_one(pool)
                .await
                .expect(label),
            expected
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM account_daily_usage_v4 WHERE user_id='data-reset-user'",
        )
        .fetch_one(pool)
        .await
        .expect("daily entity usage"),
        0,
        "a reset must clear the account's daily quota ledger"
    );
}

async fn assert_data_reset_response(response: axum::response::Response) {
    let status = response.status();
    let cache_control = response.headers()["cache-control"]
        .to_str()
        .unwrap_or_default()
        .to_owned();
    let body = response_json(response).await;
    assert_eq!(status, StatusCode::OK, "unexpected reset response: {body}");
    assert_eq!(cache_control, "no-store");
    assert_eq!(body["ok"], true);
    assert_eq!(body["dataGeneration"], 2);
    assert_eq!(body["tokensRevoked"], true);
}

async fn password_reset_fixture(database_url: &str) -> (sqlx::PgPool, Router) {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    sqlx::query("TRUNCATE password_reset_challenges_v4,mail_outbox_v4,rate_limit_buckets_v4")
        .execute(&pool)
        .await
        .expect("clear reset queues");
    let password = SecretString::from("original-reset-password".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('password-reset-user','password-reset-user','password-reset-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert reset user");
    sqlx::query(
        "INSERT INTO account_emails_v4(user_id,email,verified_at) \
         VALUES ('password-reset-user','reset@example.com',1786521600000)",
    )
    .execute(&pool)
    .await
    .expect("insert verified reset email");
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    (pool, app(state))
}

async fn request_password_reset_code(service: &Router, pool: &sqlx::PgPool) -> String {
    let requested = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/password/reset/request",
            None,
            &json!({"username":"password-reset-user","email":"reset@example.com"}),
        ))
        .await
        .expect("password reset request");
    assert_eq!(requested.status(), StatusCode::ACCEPTED);
    sqlx::query_scalar::<_, Value>("SELECT payload FROM mail_outbox_v4 WHERE kind='password_reset'")
        .fetch_one(pool)
        .await
        .expect("queued reset mail")["code"]
        .as_str()
        .expect("reset code")
        .to_owned()
}

async fn asset_fixture(database_url: &str) -> (sqlx::PgPool, Router, String) {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    let password = SecretString::from("asset-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('asset-user','asset-user','asset-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert asset test user");
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let service = app(state);
    let token = response_json(
        login_with_password(&service, "asset-user", "asset-password-v4", "asset-device").await,
    )
    .await["token"]
        .as_str()
        .expect("asset token")
        .to_owned();
    (pool, service, token)
}

fn binary_request(
    uri: &str,
    token: &str,
    content_type: &str,
    content_range: &str,
    body: Vec<u8>,
) -> Request<Body> {
    let mut request = Request::put(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("x-sync-protocol-version", "5")
        .header("x-data-generation", "1")
        .header("content-type", content_type)
        .header("content-range", content_range)
        .body(Body::from(body))
        .expect("asset upload request");
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
    request
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn login_push_replay_conflict_and_pull() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");

    let password = SecretString::from("test-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('e2e-user','e2e-user','e2e-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert test user");

    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let service = app(state);

    let token = login_token(&service).await;
    assert_account_identity(&service, &token).await;

    let mutation_id = Uuid::new_v4();
    let entity = json!({
        "id": "bookmark-e2e",
        "kind": "bookmark",
        "updatedAt": 1_786_521_600_123_i64,
        "deletedAt": 0,
        "deviceId": "e2e-device",
        "syncVersion": 1,
        "payload": {"chapter": 7},
        "future_field": "preserved"
    });
    let push_body = json!({
        "mutationId": mutation_id,
        "dataGeneration": 1,
        "entities": [entity]
    });
    for _ in 0..2 {
        let push = service
            .clone()
            .oneshot(request("POST", "/v1/sync/push", Some(&token), &push_body))
            .await
            .expect("push response");
        assert_eq!(push.status(), StatusCode::OK);
        let body = response_json(push).await;
        assert_eq!(body["accepted"][0]["future_field"], "preserved");
        assert_eq!(body["mutationId"], mutation_id.to_string());
    }
    assert_materialized_checkpoint_cursor(&pool, &service, &token, "e2e-user").await;

    let conflicting_push = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&token),
            &json!({
                "mutationId": mutation_id,
                "dataGeneration": 1,
                "entities": []
            }),
        ))
        .await
        .expect("conflicting push response");
    assert_eq!(conflicting_push.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(conflicting_push).await["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );

    let pull = service
        .oneshot(request(
            "GET",
            "/v1/sync/pull?cursor=0&limit=100",
            Some(&token),
            &Value::Null,
        ))
        .await
        .expect("pull response");
    assert_eq!(pull.status(), StatusCode::OK);
    let pull_body = response_json(pull).await;
    assert_eq!(pull_body["entities"][0]["payload"]["chapter"], 7);
    assert_eq!(pull_body["entities"][0]["future_field"], "preserved");
}

#[tokio::test]
async fn bulk_push_updates_materialized_checkpoint_once() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = load_rehearsal_fixture(&database_url).await;
    install_checkpoint_update_audit(&pool).await;

    assert_bulk_push_updates_checkpoint_once(
        &pool,
        &service,
        &token,
        json!([
            checkpoint_audit_entity("checkpoint-a", 1_786_521_600_100, 1),
            checkpoint_audit_entity("checkpoint-b", 1_786_521_600_101, 1)
        ]),
    )
    .await;
    assert_bulk_push_updates_checkpoint_once(
        &pool,
        &service,
        &token,
        json!([
            checkpoint_audit_entity("checkpoint-a", 1_786_521_600_200, 2),
            checkpoint_audit_entity("checkpoint-b", 1_786_521_600_201, 2)
        ]),
    )
    .await;
    assert_bulk_push_updates_checkpoint_once(
        &pool,
        &service,
        &token,
        json!([
            checkpoint_audit_entity("checkpoint-a", 1_786_521_600_300, 3),
            checkpoint_audit_entity("checkpoint-c", 1_786_521_600_301, 1)
        ]),
    )
    .await;
    assert_materialized_checkpoint_cursor(&pool, &service, &token, "load-rehearsal-user").await;
    remove_checkpoint_update_audit(&pool).await;
}

#[tokio::test]
async fn user_cascade_delete_with_entities_keeps_checkpoint_trigger_safe() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = load_rehearsal_fixture(&database_url).await;
    let push = service
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&token),
            &json!({
                "mutationId": Uuid::new_v4(),
                "dataGeneration": 1,
                "entities": [checkpoint_audit_entity(
                    "checkpoint-cascade",
                    1_786_521_600_400,
                    1
                )]
            }),
        ))
        .await
        .expect("push cascade fixture");
    assert_eq!(push.status(), StatusCode::OK);

    let deleted = sqlx::query("DELETE FROM users WHERE id='load-rehearsal-user'")
        .execute(&pool)
        .await
        .expect("cascade user with materialized checkpoint");
    assert_eq!(deleted.rows_affected(), 1);
    let remaining = sqlx::query_scalar::<_, i64>(
        "SELECT (SELECT COUNT(*) FROM account_data_generations \
                 WHERE user_id='load-rehearsal-user') + \
                (SELECT COUNT(*) FROM sync_entities_v4 \
                 WHERE user_id='load-rehearsal-user')",
    )
    .fetch_one(&pool)
    .await
    .expect("cascade checkpoint rows");
    assert_eq!(remaining, 0);
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn inventory_reconcile_and_secret_epoch_match_desktop_v5_semantics() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    let password = SecretString::from("inventory-password-v5".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('inventory-user','inventory-user','inventory-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert test user");
    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let service = app(AppState {
        pool: pool.clone(),
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
        config,
    });
    let token = response_json(
        login_with_password(
            &service,
            "inventory-user",
            "inventory-password-v5",
            "inventory-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("session token")
        .to_owned();
    let entity = json!({
        "id": "inventory-vocab",
        "kind": "vocab",
        "updatedAt": 1_786_521_600_123_i64,
        "deletedAt": 0,
        "deviceId": "inventory-device",
        "syncVersion": 1,
        "payload": {"word": "reader"}
    });
    let pushed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&token),
            &json!({"mutationId":Uuid::new_v4(),"dataGeneration":1,"entities":[entity]}),
        ))
        .await
        .expect("push inventory fixture");
    assert_eq!(pushed.status(), StatusCode::OK);

    let inventory = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/sync/inventory?kind=vocab",
            Some(&token),
            &Value::Null,
        ))
        .await
        .expect("inventory response");
    assert_eq!(inventory.status(), StatusCode::OK);
    let inventory = response_json(inventory).await;
    assert_eq!(inventory["kinds"], json!(["vocab"]));
    assert_eq!(inventory["entityCount"], 1);
    assert_eq!(
        inventory["inventoryDigest"].as_str().map(str::len),
        Some(64)
    );

    let reconcile = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/reconcile",
            Some(&token),
            &json!({
                "dataGeneration": 1,
                "kinds": ["vocab"],
                "manifest": [{
                    "kind": "vocab",
                    "id": "local-only",
                    "updatedAt": 1_786_521_600_124_i64,
                    "deletedAt": 0,
                    "deviceId": "inventory-device",
                    "syncVersion": 1
                }]
            }),
        ))
        .await
        .expect("reconcile response");
    assert_eq!(reconcile.status(), StatusCode::OK);
    let reconcile = response_json(reconcile).await;
    assert_eq!(
        reconcile["upload"],
        json!([{"kind":"vocab","id":"local-only"}])
    );
    assert_eq!(reconcile["entities"][0]["id"], "inventory-vocab");

    let before = service
        .clone()
        .oneshot(request(
            "GET",
            "/v1/sync/secret-state",
            Some(&token),
            &Value::Null,
        ))
        .await
        .expect("secret state response");
    assert_eq!(response_json(before).await["secretBundleEpoch"], 1);
    let reset = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/secret-state/reset",
            Some(&token),
            &json!({}),
        ))
        .await
        .expect("secret reset response");
    assert_eq!(reset.status(), StatusCode::OK);
    assert_eq!(response_json(reset).await["secretBundleEpoch"], 2);
    let first_reset_cursor = sqlx::query_scalar::<_, i64>(
        "SELECT server_cursor FROM account_data_generations WHERE user_id='inventory-user'",
    )
    .fetch_one(&pool)
    .await
    .expect("first secret reset cursor");
    let reset_again = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/secret-state/reset",
            Some(&token),
            &json!({}),
        ))
        .await
        .expect("second secret reset response");
    assert_eq!(reset_again.status(), StatusCode::OK);
    assert_eq!(response_json(reset_again).await["secretBundleEpoch"], 3);
    let second_reset_cursor = sqlx::query_scalar::<_, i64>(
        "SELECT server_cursor FROM account_data_generations WHERE user_id='inventory-user'",
    )
    .fetch_one(&pool)
    .await
    .expect("second secret reset cursor");
    assert!(second_reset_cursor > first_reset_cursor);
    let tombstone = sqlx::query_as::<_, (i64, String)>(
        "SELECT deleted_at,device_id FROM sync_entities_v4 \
         WHERE user_id='inventory-user' AND kind='secret_bundle_v1' AND entity_id='default'",
    )
    .fetch_one(&pool)
    .await
    .expect("secret reset tombstone");
    assert!(tombstone.0 > 0);
    assert_eq!(tombstone.1, "server-secret-reset");
    assert_materialized_checkpoint_cursor(&pool, &service, &token, "inventory-user").await;
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn account_email_rebind_and_delete_follow_desktop_v5_flow() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    let password = SecretString::from("email-flow-password-v5".to_owned());
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at) \
         VALUES('email-user','email-user','email-user',$1,1786521600000)",
    )
    .bind(hash_password(&password).expect("hash password"))
    .execute(&pool)
    .await
    .expect("insert email flow user");
    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let service = app(AppState {
        pool: pool.clone(),
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
        config,
    });
    let token = response_json(
        login_with_password(
            &service,
            "email-user",
            "email-flow-password-v5",
            "email-flow-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("email flow token")
        .to_owned();

    let bind = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/start",
            Some(&token),
            &json!({"email":"first@example.com"}),
        ))
        .await
        .expect("email bind start");
    assert_eq!(bind.status(), StatusCode::ACCEPTED);
    let bind_code = email_code(&pool, "bind_email").await;
    let bind_confirm = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/confirm",
            Some(&token),
            &json!({"email":"first@example.com","code":bind_code}),
        ))
        .await
        .expect("email bind confirm");
    assert_eq!(bind_confirm.status(), StatusCode::OK);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT email FROM account_emails_v4 WHERE user_id='email-user'"
        )
        .fetch_one(&pool)
        .await
        .expect("bound email"),
        "first@example.com"
    );

    let old_start = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/rebind/old/start",
            Some(&token),
            &json!({}),
        ))
        .await
        .expect("old-email start");
    assert_eq!(old_start.status(), StatusCode::ACCEPTED);
    let old_code = email_code(&pool, "rebind_old").await;
    let old_confirm = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/rebind/old/confirm",
            Some(&token),
            &json!({"code":old_code}),
        ))
        .await
        .expect("old-email confirm");
    assert_eq!(old_confirm.status(), StatusCode::OK);
    let grant = response_json(old_confirm).await["rebindGrant"]
        .as_str()
        .expect("rebind grant")
        .to_owned();
    let new_start = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/rebind/new/start",
            Some(&token),
            &json!({"email":"second@example.com","rebindGrant":grant}),
        ))
        .await
        .expect("new-email start");
    assert_eq!(new_start.status(), StatusCode::ACCEPTED);
    let new_code = email_code(&pool, "rebind_new").await;
    let new_confirm = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/email/rebind/new/confirm",
            Some(&token),
            &json!({"email":"second@example.com","code":new_code}),
        ))
        .await
        .expect("new-email confirm");
    assert_eq!(new_confirm.status(), StatusCode::OK);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT email FROM account_emails_v4 WHERE user_id='email-user'"
        )
        .fetch_one(&pool)
        .await
        .expect("rebound email"),
        "second@example.com"
    );

    let mismatch = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/account/delete",
            Some(&token),
            &json!({"password":"email-flow-password-v5","username":"wrong"}),
        ))
        .await
        .expect("delete mismatch");
    assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(mismatch).await["error"]["code"],
        "ACCOUNT_CONFIRMATION_MISMATCH"
    );
    let deleted = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/account/delete",
            Some(&token),
            &json!({"password":"email-flow-password-v5","username":"email-user"}),
        ))
        .await
        .expect("account delete");
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(response_json(deleted).await["accountDeleted"], true);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE id='email-user'")
            .fetch_one(&pool)
            .await
            .expect("deleted user count"),
        0
    );
}

async fn email_code(pool: &sqlx::PgPool, kind: &str) -> String {
    sqlx::query_scalar::<_, Value>(
        "SELECT payload FROM mail_outbox_v4 WHERE kind=$1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(kind)
    .fetch_one(pool)
    .await
    .expect("queued account email")["code"]
        .as_str()
        .expect("queued account email code")
        .to_owned()
}

async fn load_rehearsal_fixture(database_url: &str) -> (sqlx::PgPool, Router, String) {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    sqlx::query("TRUNCATE rate_limit_buckets_v4")
        .execute(&pool)
        .await
        .expect("clear load rehearsal rate limits");
    let password = SecretString::from("load-rehearsal-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('load-rehearsal-user','load-rehearsal-user','load-rehearsal-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert load rehearsal user");
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let service = app(state);
    let token = response_json(
        login_with_password(
            &service,
            "load-rehearsal-user",
            "load-rehearsal-password-v4",
            "load-rehearsal-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("load rehearsal token")
        .to_owned();
    (pool, service, token)
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn single_connection_pool_serves_hot_routes_and_observes_session_revocation() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let setup_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&setup_pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&setup_pool)
        .await
        .expect("clear explicit test database");
    sqlx::query("TRUNCATE rate_limit_buckets_v4")
        .execute(&setup_pool)
        .await
        .expect("clear admission buckets");
    let password = SecretString::from("single-connection-password-v5".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('single-connection-user','single-connection-user','single-connection-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&setup_pool)
    .await
    .expect("insert single-connection user");

    let service_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect single-connection service pool");
    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: service_pool,
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
        config,
    };
    let service = app(state);
    let token = response_json(
        login_with_password(
            &service,
            "single-connection-user",
            "single-connection-password-v5",
            "single-connection-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("single-connection token")
        .to_owned();

    let push_body = json!({
        "mutationId": Uuid::new_v4(),
        "dataGeneration": 1,
        "entities": [{
            "id": "single-connection-progress",
            "kind": "reading_progress_v1",
            "updatedAt": 1_786_521_600_123_i64,
            "deletedAt": 0,
            "deviceId": "single-connection-device",
            "syncVersion": 1,
            "payload": {"progress": 0.5}
        }]
    });
    for (method, uri, body) in [
        ("POST", "/v1/sync/push", push_body),
        (
            "GET",
            "/v1/sync/checkpoint?dataGeneration=1&cursor=0",
            Value::Null,
        ),
        ("GET", "/v1/sync/pull?cursor=0&limit=50", Value::Null),
        ("GET", "/v1/sync/inventory", Value::Null),
    ] {
        // Force the persistent admission branch for every request. With a
        // one-connection service pool, any hidden second checkout would time
        // out instead of reaching the route's business statement.
        reader_sync_api::rate_limit::clear_authenticated_account_leases_for_test();
        let response = service
            .clone()
            .oneshot(request(method, uri, Some(&token), &body))
            .await
            .expect("single-connection hot route response");
        assert_eq!(response.status(), StatusCode::OK, "{method} {uri}");
    }

    sqlx::query(
        "UPDATE auth_sessions_v4 SET revoked_at=1786521601000 \
         WHERE user_id='single-connection-user'",
    )
    .execute(&setup_pool)
    .await
    .expect("revoke single-connection session");
    reader_sync_api::rate_limit::clear_authenticated_account_leases_for_test();
    let revoked = service
        .oneshot(request(
            "GET",
            "/v1/sync/checkpoint?dataGeneration=1&cursor=0",
            Some(&token),
            &Value::Null,
        ))
        .await
        .expect("revoked session response");
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(revoked).await["error"]["code"],
        "UNAUTHORIZED"
    );
}

#[tokio::test]
async fn load_rehearsal_idempotent_push_is_single_write() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = load_rehearsal_fixture(&database_url).await;
    let push_body = json!({
        "mutationId": "a82fb5c3-6c4a-4f3d-99de-92c9921d4206",
        "dataGeneration": 1,
        "entities": [{
            "id": "load-rehearsal-bookmark",
            "kind": "bookmark",
            "updatedAt": 1_786_521_600_123_i64,
            "deletedAt": 0,
            "deviceId": "load-rehearsal-device",
            "syncVersion": 1,
            "payload": {"chapter": 7}
        }]
    });
    for _ in 0..2 {
        let response = service
            .clone()
            .oneshot(request("POST", "/v1/sync/push", Some(&token), &push_body))
            .await
            .expect("idempotent retry response");
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sync_entities_v4 WHERE user_id='load-rehearsal-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("load rehearsal entity count"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sync_push_receipts_v4 WHERE user_id='load-rehearsal-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("load rehearsal receipt count"),
        1
    );
}

async fn assert_retired_history_storage_removed(pool: &sqlx::PgPool) {
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT to_regclass('public.sync_entity_history_v4')::text",
        )
        .fetch_one(pool)
        .await
        .expect("retired history table lookup"),
        None
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM information_schema.columns \
             WHERE table_schema='public' AND table_name='account_storage_usage_v5' \
             AND column_name='history_bytes'",
        )
        .fetch_one(pool)
        .await
        .expect("retired history ledger column lookup"),
        0
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn storage_ledger_tracks_batch_push_assets_and_reset() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = load_rehearsal_fixture(&database_url).await;
    assert_retired_history_storage_removed(&pool).await;
    let entities = (1_i64..=3)
        .map(|index| {
            json!({
                "id": format!("ledger-bookmark-{index}"),
                "kind": "bookmark",
                "updatedAt": 1_786_521_600_100_i64 + index,
                "deletedAt": 0,
                "deviceId": "ledger-device",
                "syncVersion": 1,
                "payload": {"chapter": index}
            })
        })
        .collect::<Vec<_>>();
    let pushed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&token),
            &json!({
                "mutationId": Uuid::new_v4(),
                "dataGeneration": 1,
                "entities": entities
            }),
        ))
        .await
        .expect("batch push response");
    assert_eq!(pushed.status(), StatusCode::OK);
    let pushed = response_json(pushed).await;
    assert_eq!(pushed["accepted"].as_array().map(Vec::len), Some(3));
    assert_eq!(
        pushed["accepted"]
            .as_array()
            .and_then(|accepted| accepted.first())
            .and_then(|entity| entity["id"].as_str()),
        Some("ledger-bookmark-1")
    );

    let bytes = b"\x89PNG\r\n\x1a\nledger-asset".to_vec();
    let asset_id = sha256_hex(&bytes);
    assert_eq!(
        initialize_asset(&service, &token, &asset_id, bytes.len()).await,
        0
    );
    assert_eq!(
        upload_asset_chunk(
            &service,
            &token,
            &asset_id,
            format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()),
            bytes,
        )
        .await,
        StatusCode::NO_CONTENT
    );

    let (entities_bytes, assets_bytes) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT entity_bytes,asset_bytes \
         FROM account_storage_usage_v5 WHERE user_id='load-rehearsal-user'",
    )
    .fetch_one(&pool)
    .await
    .expect("storage ledger");
    let exact = sqlx::query_as::<_, (i64, i64)>(
        "SELECT \
           COALESCE((SELECT SUM(octet_length(envelope::text)) FROM sync_entities_v4 WHERE user_id='load-rehearsal-user'),0), \
           COALESCE((SELECT SUM(octet_length(body)) FROM sync_assets_v4 WHERE user_id='load-rehearsal-user'),0)",
    )
    .fetch_one(&pool)
    .await
    .expect("exact source totals");
    assert_eq!((entities_bytes, assets_bytes), exact);
    assert!(entities_bytes > 0 && assets_bytes > 0);

    let reset = service
        .oneshot(request(
            "POST",
            "/v1/sync/data/reset",
            Some(&token),
            &json!({"password":"load-rehearsal-password-v4"}),
        ))
        .await
        .expect("data reset response");
    let reset_status = reset.status();
    let reset_body = response_json(reset).await;
    assert_eq!(
        reset_status,
        StatusCode::OK,
        "unexpected reset response: {reset_body}"
    );
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT entity_bytes,asset_bytes \
             FROM account_storage_usage_v5 WHERE user_id='load-rehearsal-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("zeroed storage ledger"),
        (0, 0)
    );
}

#[tokio::test]
async fn account_mutation_lock_rejects_busy_push_without_queueing() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = load_rehearsal_fixture(&database_url).await;
    let mut held_lock = pool.begin().await.expect("begin held account lock");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind("load-rehearsal-user")
        .execute(&mut *held_lock)
        .await
        .expect("hold account mutation lock");
    let body = json!({
        "mutationId": "ee752a35-ec33-44d2-93a8-01d3ad9ef401",
        "dataGeneration": 1,
        "entities": []
    });
    let busy = service
        .clone()
        .oneshot(request("POST", "/v1/sync/push", Some(&token), &body))
        .await
        .expect("busy push response");
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()["retry-after"], "1");
    assert_eq!(response_json(busy).await["error"]["code"], "SERVER_BUSY");
    held_lock
        .rollback()
        .await
        .expect("release account mutation lock");
    let retried = service
        .oneshot(request("POST", "/v1/sync/push", Some(&token), &body))
        .await
        .expect("retried push response");
    assert_eq!(retried.status(), StatusCode::OK);
}

#[tokio::test]
async fn authenticated_account_admission_is_shared_by_api_instances() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, _fixture_service, token) = load_rehearsal_fixture(&database_url).await;
    reader_sync_api::rate_limit::clear_authenticated_account_leases_for_test();
    let mut config = Config::for_test(&database_url);
    config.max_authenticated_account_requests_per_minute = 2;
    let first_instance = app(AppState {
        pool: pool.clone(),
        metrics: PrometheusBuilder::new().build_recorder().handle(),
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
        config: config.clone(),
    });
    let second_instance = app(AppState {
        pool,
        metrics: PrometheusBuilder::new().build_recorder().handle(),
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
        config,
    });

    for _ in 0..2 {
        assert_session_status(&first_instance, &token, StatusCode::OK).await;
    }
    let rejected = second_instance
        .oneshot(request(
            "GET",
            "/v1/auth/session",
            Some(&token),
            &Value::Null,
        ))
        .await
        .expect("admission response");
    assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(rejected.headers()["retry-after"], "60");
    assert_eq!(
        response_json(rejected).await["error"]["code"],
        "RATE_LIMITED"
    );
}

#[tokio::test]
async fn load_rehearsal_feedback_limit_persists_only_allowed_requests() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, _) = load_rehearsal_fixture(&database_url).await;
    let feedback = json!({
        "kind": "bug",
        "text": "load-rehearsal-test-only",
        "appVersion": "1.0.0-test",
        "platform": "test",
        "images": []
    });
    for expected in [
        StatusCode::CREATED,
        StatusCode::CREATED,
        StatusCode::CREATED,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let response = service
            .clone()
            .oneshot(request("POST", "/v1/feedback", None, &feedback))
            .await
            .expect("load rehearsal feedback");
        assert_eq!(response.status(), expected);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM feedback_v4")
            .fetch_one(&pool)
            .await
            .expect("load rehearsal feedback count"),
        3
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn registration_uses_outbox_code_and_creates_verified_account() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    sqlx::query(
        "TRUNCATE registration_challenges_v4,mail_outbox_v4,rate_limit_buckets_v4,account_daily_usage_v4",
    )
        .execute(&pool)
        .await
        .expect("clear registration queues");

    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let service = app(state);
    let start_body = json!({"username":"New_Reader","email":"Reader@Example.com"});
    let started = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/register/start",
            None,
            &start_body,
        ))
        .await
        .expect("registration start response");
    assert_eq!(started.status(), StatusCode::ACCEPTED);
    let started_body = response_json(started).await;
    assert_eq!(started_body["ok"], true);
    assert_eq!(started_body["expiresIn"], 900);
    let payload = sqlx::query_scalar::<_, Value>(
        "SELECT payload FROM mail_outbox_v4 WHERE kind='registration_verification'",
    )
    .fetch_one(&pool)
    .await
    .expect("queued registration email");
    let confirm_body = json!({
        "username": "New_Reader",
        "email": "reader@example.com",
        "code": payload["code"],
        "password": "a-long-test-password",
        "installationId": "new-reader-installation",
        "deviceName": "new-reader-device"
    });
    let confirmed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/register/confirm",
            None,
            &confirm_body,
        ))
        .await
        .expect("registration confirm response");
    assert_eq!(confirmed.status(), StatusCode::CREATED);
    let verified_at = sqlx::query_scalar::<_, i64>(
        "SELECT sync_verified_at FROM users WHERE username_key='new_reader'",
    )
    .fetch_one(&pool)
    .await
    .expect("created account");
    assert!(verified_at > 0);

    let login_body = json!({
        "username": "New_Reader",
        "password": "a-long-test-password",
        "installationId": "new-reader-installation",
        "deviceName": "new-reader-device"
    });
    let login = service
        .oneshot(request("POST", "/v1/auth/login", None, &login_body))
        .await
        .expect("new account login response");
    assert_eq!(login.status(), StatusCode::OK);
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn phone_registration_requires_delivered_sms_and_stores_only_digest() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");
    sqlx::query(
        "TRUNCATE phone_registration_challenges_v5,sms_outbox_v5,sms_daily_usage_v5,rate_limit_buckets_v4",
    )
    .execute(&pool)
    .await
    .expect("clear phone registration queues");

    let mut config = Config::for_test(&database_url);
    config.sms = Some(reader_sync_api::config::TencentSmsConfig {
        secret_id: "test-id".to_owned(),
        secret_key: SecretString::from("test-secret-key-value".to_owned()),
        sdk_app_id: "1400000000".to_owned(),
        sign_name: "test".to_owned(),
        template_id: "1000".to_owned(),
        region: "ap-guangzhou".to_owned(),
        daily_send_limit: 10,
    });
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let service = app(state);
    let phone = "+8613711112222";
    let start = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/register/phone/start",
            None,
            &json!({
                "username": "Phone_Reader",
                "phone": phone,
                "installationId": "phone-reader-installation"
            }),
        ))
        .await
        .expect("phone registration start");
    assert_eq!(start.status(), StatusCode::ACCEPTED);
    let (outbox_id, payload) = sqlx::query_as::<_, (Uuid, Value)>(
        "SELECT id,payload FROM sms_outbox_v5 WHERE kind='phone_registration'",
    )
    .fetch_one(&pool)
    .await
    .expect("queued registration SMS");
    let confirm = json!({
        "username": "Phone_Reader",
        "phone": phone,
        "code": payload["code"],
        "password": "a-long-phone-password",
        "installationId": "phone-reader-installation",
        "deviceName": "phone-reader-device"
    });
    let before_delivery = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/register/phone/confirm",
            None,
            &confirm,
        ))
        .await
        .expect("undelivered phone registration confirm");
    assert_eq!(before_delivery.status(), StatusCode::BAD_REQUEST);

    sqlx::query("UPDATE sms_outbox_v5 SET delivered_at=$2 WHERE id=$1")
        .bind(outbox_id)
        .bind(1_786_521_600_000_i64)
        .execute(&pool)
        .await
        .expect("simulate SMS provider acceptance");
    let confirmed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/register/phone/confirm",
            None,
            &confirm,
        ))
        .await
        .expect("phone registration confirm");
    assert_eq!(confirmed.status(), StatusCode::CREATED);
    let (digest_length, last_four) = sqlx::query_as::<_, (i32, String)>(
        "SELECT octet_length(phone_digest),last_four FROM account_phones_v5",
    )
    .fetch_one(&pool)
    .await
    .expect("stored phone digest");
    assert_eq!(digest_length, 32);
    assert_eq!(last_four, "2222");
    let (recipient, stored_payload) = sqlx::query_as::<_, (String, Value)>(
        "SELECT recipient,payload FROM sms_outbox_v5 WHERE id=$1",
    )
    .bind(outbox_id)
    .fetch_one(&pool)
    .await
    .expect("cleared SMS outbox");
    assert!(recipient.is_empty());
    assert_eq!(stored_payload, json!({}));
}

#[tokio::test]
async fn feedback_persists_valid_bug_attachment() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE feedback_v4,rate_limit_buckets_v4")
        .execute(&pool)
        .await
        .expect("clear feedback test rows");

    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
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
        config,
    };
    let attachment = base64::engine::general_purpose::STANDARD.encode(br#"{"events":[]}"#);
    let response = app(state)
        .oneshot(request(
            "POST",
            "/v1/feedback",
            None,
            &json!({
                "kind": "bug",
                "text": "A test-only page turn failure",
                "appVersion": "1.0.0-test",
                "platform": "test",
                "images": [],
                "attachments": [{
                    "name": "test-problem.json",
                    "mime": "application/json",
                    "data": attachment
                }]
            }),
        ))
        .await
        .expect("feedback response");
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["emailed"], false);
    assert_eq!(body["acceptedAttachments"], 1);
    let saved_attachments =
        sqlx::query_scalar::<_, Value>("SELECT attachments_json FROM feedback_v4 WHERE id=$1")
            .bind(
                Uuid::parse_str(body["id"].as_str().expect("feedback id")).expect("feedback UUID"),
            )
            .fetch_one(&pool)
            .await
            .expect("saved feedback attachment");
    assert_eq!(saved_attachments[0]["name"], "test-problem.json");
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn password_change_keeps_current_session_and_revokes_other_devices() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to explicit test database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate explicit test database");
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("clear explicit test database");

    let password = SecretString::from("original-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('password-change-user','password-change-user','password-change-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert test user");

    let config = Config::for_test(&database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
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
        config,
    };
    let service = app(state);
    let current_login = login_with_password(
        &service,
        "password-change-user",
        "original-password-v4",
        "current-device",
    )
    .await;
    let current_token = response_json(current_login).await["token"]
        .as_str()
        .expect("current session token")
        .to_owned();
    let other_login = login_with_password(
        &service,
        "password-change-user",
        "original-password-v4",
        "other-device",
    )
    .await;
    let other_token = response_json(other_login).await["token"]
        .as_str()
        .expect("other session token")
        .to_owned();

    let changed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/password/change",
            Some(&current_token),
            &json!({
                "currentPassword": "original-password-v4",
                "newPassword": "replacement-password-v4"
            }),
        ))
        .await
        .expect("password change response");
    assert_eq!(changed.status(), StatusCode::OK);
    let changed = response_json(changed).await;
    assert_eq!(changed["ok"], true);

    assert_session_status(&service, &current_token, StatusCode::OK).await;
    assert_session_status(&service, &other_token, StatusCode::UNAUTHORIZED).await;

    let old_password = login_with_password(
        &service,
        "password-change-user",
        "original-password-v4",
        "new-device",
    )
    .await;
    assert_eq!(old_password.status(), StatusCode::UNAUTHORIZED);
    let replacement_password = login_with_password(
        &service,
        "password-change-user",
        "replacement-password-v4",
        "new-device",
    )
    .await;
    assert_eq!(replacement_password.status(), StatusCode::OK);
}

#[tokio::test]
async fn password_reset_consumes_code_revokes_sessions_and_issues_current_device_token() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service) = password_reset_fixture(&database_url).await;
    let current_token = response_json(
        login_with_password(
            &service,
            "password-reset-user",
            "original-reset-password",
            "reset-current-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("current reset token")
        .to_owned();
    let other_token = response_json(
        login_with_password(
            &service,
            "password-reset-user",
            "original-reset-password",
            "reset-other-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("other reset token")
        .to_owned();
    let code = request_password_reset_code(&service, &pool).await;
    let reset = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/auth/password/reset/confirm",
            None,
            &json!({
                "username":"password-reset-user",
                "code":code,
                "newPassword":"replacement-reset-password",
                "installationId":"reset-fresh-device",
                "deviceName":"reset-test"
            }),
        ))
        .await
        .expect("password reset confirm");
    assert_eq!(reset.status(), StatusCode::OK);
    let fresh_token = response_json(reset).await["token"]
        .as_str()
        .expect("fresh reset token")
        .to_owned();
    assert_session_status(&service, &current_token, StatusCode::UNAUTHORIZED).await;
    assert_session_status(&service, &other_token, StatusCode::UNAUTHORIZED).await;
    assert_session_status(&service, &fresh_token, StatusCode::OK).await;
    let old_password = login_with_password(
        &service,
        "password-reset-user",
        "original-reset-password",
        "reset-old-password-device",
    )
    .await;
    assert_eq!(old_password.status(), StatusCode::UNAUTHORIZED);
    let replay = service
        .oneshot(request(
            "POST",
            "/v1/auth/password/reset/confirm",
            None,
            &json!({
                "username":"password-reset-user",
                "code":code,
                "newPassword":"third-reset-password",
                "installationId":"reset-replay-device"
            }),
        ))
        .await
        .expect("reset replay response");
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(replay).await["error"]["code"],
        "INVALID_OR_EXPIRED_CODE"
    );
}

#[tokio::test]
async fn assets_resume_strict_chunks_verify_hash_and_serve_ranges() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (_pool, service, token) = asset_fixture(&database_url).await;
    let bytes = b"\x89PNG\r\n\x1a\nasset-e2e-payload".to_vec();
    let asset_id = sha256_hex(&bytes);
    assert_eq!(
        initialize_asset(&service, &token, &asset_id, bytes.len()).await,
        0
    );

    let split = 10;
    assert_eq!(
        upload_asset_chunk(
            &service,
            &token,
            &asset_id,
            format!("bytes 0-{}/{}", split - 1, bytes.len()),
            bytes[..split].to_vec(),
        )
        .await,
        StatusCode::NO_CONTENT
    );

    assert_eq!(
        initialize_asset(&service, &token, &asset_id, bytes.len()).await,
        i64::try_from(split).expect("test split fits i64")
    );

    assert_eq!(
        upload_asset_chunk(
            &service,
            &token,
            &asset_id,
            format!("bytes {}-{}/{}", split + 1, bytes.len() - 1, bytes.len()),
            bytes[split + 1..].to_vec(),
        )
        .await,
        StatusCode::BAD_REQUEST
    );

    assert_eq!(
        upload_asset_chunk(
            &service,
            &token,
            &asset_id,
            format!("bytes {split}-{}/{}", bytes.len() - 1, bytes.len()),
            bytes[split..].to_vec(),
        )
        .await,
        StatusCode::NO_CONTENT
    );

    let download = service
        .oneshot(
            Request::get(format!("/v1/sync/assets/{asset_id}"))
                .header("authorization", format!("Bearer {token}"))
                .header("x-sync-protocol-version", "5")
                .header("range", "bytes=2-8")
                .body(Body::empty())
                .expect("range request"),
        )
        .await
        .expect("asset range response");
    assert_eq!(download.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(download.headers()["content-type"], "image/png");
    assert_eq!(
        download.headers()["content-range"],
        format!("bytes 2-8/{}", bytes.len())
    );
    let downloaded = download
        .into_body()
        .collect()
        .await
        .expect("read asset bytes")
        .to_bytes();
    assert_eq!(downloaded.as_ref(), &bytes[2..9]);
}

#[tokio::test]
async fn data_reset_increments_generation_removes_entities_and_revokes_every_session() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service) = data_reset_fixture(&database_url).await;
    let current_token = response_json(
        login_with_password(
            &service,
            "data-reset-user",
            "reset-password-v4",
            "reset-current-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("current session token")
        .to_owned();
    let other_token = response_json(
        login_with_password(
            &service,
            "data-reset-user",
            "reset-password-v4",
            "reset-other-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("other session token")
        .to_owned();
    let mutation_id = Uuid::new_v4();
    let pushed = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&current_token),
            &json!({
                "mutationId": mutation_id,
                "dataGeneration": 1,
                "entities": [{
                    "id": "reset-bookmark",
                    "kind": "bookmark",
                    "updatedAt": 1_786_521_600_123_i64,
                    "deletedAt": 0,
                    "deviceId": "reset-device",
                    "syncVersion": 1,
                    "payload": {"chapter": 7}
                }]
            }),
        ))
        .await
        .expect("push response");
    assert_eq!(pushed.status(), StatusCode::OK);

    upload_data_reset_asset(&service, &current_token).await;

    let reset = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/data/reset",
            Some(&current_token),
            &json!({"password": "reset-password-v4"}),
        ))
        .await
        .expect("data reset response");
    assert_data_reset_response(reset).await;
    assert_data_reset_database_state(&pool).await;
    assert_session_status(&service, &current_token, StatusCode::UNAUTHORIZED).await;
    assert_session_status(&service, &other_token, StatusCode::UNAUTHORIZED).await;

    let fresh_token = response_json(
        login_with_password(
            &service,
            "data-reset-user",
            "reset-password-v4",
            "reset-fresh-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("fresh session token")
        .to_owned();
    let stale_push = service
        .oneshot(request(
            "POST",
            "/v1/sync/push",
            Some(&fresh_token),
            &json!({"mutationId": Uuid::new_v4(), "dataGeneration": 1, "entities": []}),
        ))
        .await
        .expect("stale push response");
    assert_eq!(stale_push.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(stale_push).await["error"]["code"],
        "DATA_GENERATION_MISMATCH"
    );
}

async fn upload_data_reset_asset(service: &Router, token: &str) {
    let bytes = b"\x89PNG\r\n\x1a\ndata-reset-asset".to_vec();
    let asset_id = sha256_hex(&bytes);
    assert_eq!(
        initialize_asset(service, token, &asset_id, bytes.len()).await,
        0
    );
    assert_eq!(
        upload_asset_chunk(
            service,
            token,
            &asset_id,
            format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()),
            bytes,
        )
        .await,
        StatusCode::NO_CONTENT
    );
}
