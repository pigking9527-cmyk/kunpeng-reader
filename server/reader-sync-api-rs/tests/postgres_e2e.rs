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
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \\
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
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        config,
    };
    (pool, app(state))
}

async fn recovery_fixture(database_url: &str) -> (sqlx::PgPool, Router, String) {
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
    let password = SecretString::from("recovery-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \
         VALUES ('recovery-user','recovery-user','recovery-user',$1,1786521600000,1786521600000)",
    )
    .bind(password_hash)
    .execute(&pool)
    .await
    .expect("insert recovery test user");
    let config = Config::for_test(database_url);
    let recorder = PrometheusBuilder::new().build_recorder();
    let state = AppState {
        pool: pool.clone(),
        metrics: recorder.handle(),
        request_slots: Arc::new(Semaphore::new(config.max_concurrent_requests)),
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        config,
    };
    let service = app(state);
    let token = response_json(
        login_with_password(
            &service,
            "recovery-user",
            "recovery-password-v4",
            "recovery-device",
        )
        .await,
    )
    .await["token"]
        .as_str()
        .expect("recovery token")
        .to_owned();
    (pool, service, token)
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
            "SELECT COUNT(*) FROM sync_entity_history_v4 WHERE user_id='data-reset-user'",
            0,
            "history count",
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
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response_json(response).await;
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
        pool,
        metrics: recorder.handle(),
        request_slots: Arc::new(Semaphore::new(config.max_concurrent_requests)),
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
    let tombstone = sqlx::query_as::<_, (i64, String)>(
        "SELECT deleted_at,device_id FROM sync_entities_v4 \
         WHERE user_id='inventory-user' AND kind='secret_bundle_v1' AND entity_id='default'",
    )
    .fetch_one(&pool)
    .await
    .expect("secret reset tombstone");
    assert!(tombstone.0 > 0);
    assert_eq!(tombstone.1, "server-secret-reset");
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
    let password = SecretString::from("load-rehearsal-password-v4".to_owned());
    let password_hash = hash_password(&password).expect("hash password");
    sqlx::query(
        "INSERT INTO users(id,username,username_key,password_hash,created_at,sync_verified_at) \\
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
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let service = service.clone();
        let token = token.clone();
        let push_body = push_body.clone();
        tasks.spawn(async move {
            service
                .oneshot(request("POST", "/v1/sync/push", Some(&token), &push_body))
                .await
                .expect("load rehearsal push")
                .status()
        });
    }
    while let Some(result) = tasks.join_next().await {
        assert_eq!(result.expect("load rehearsal task"), StatusCode::OK);
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
            .bind(body["id"].as_str().expect("feedback id"))
            .fetch_one(&pool)
            .await
            .expect("saved feedback attachment");
    assert_eq!(saved_attachments[0]["name"], "test-problem.json");
}

#[tokio::test]
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

#[tokio::test]
async fn recovery_status_and_restore_rewind_versions_and_tombstone_later_entities() {
    let Some(database_url) = explicit_test_database_url() else {
        return;
    };
    let _database_guard = E2E_DATABASE_LOCK.lock().await;
    let (pool, service, token) = recovery_fixture(&database_url).await;
    let early = 1_786_521_600_001_i64;
    let later = early + 10;
    push_recovery_history_versions(&service, &token, early, later).await;
    assert_recovery_history_rows(&pool).await;
    let history_target = recovery_status_and_target(&service, &pool, &token).await;
    let restored = restore_recovery_target(&service, &token, history_target).await;
    assert_eq!(restored["dataGeneration"], 2);
    assert_eq!(restored["restoredEntities"], 1);
    assert_eq!(restored["tombstonedEntities"], 1);
    assert_session_status(&service, &token, StatusCode::UNAUTHORIZED).await;
    assert_recovery_restored_rows(&pool).await;
}

async fn push_recovery_history_versions(service: &Router, token: &str, early: i64, later: i64) {
    for (mutation_id, entities) in [
        (
            Uuid::new_v4(),
            json!([{
                "id":"recovery-bookmark", "kind":"bookmark", "updatedAt":early,
                "deletedAt":0, "deviceId":"recovery-device", "syncVersion":1,
                "payload":{"chapter":1}
            }]),
        ),
        (
            Uuid::new_v4(),
            json!([
                {
                    "id":"recovery-bookmark", "kind":"bookmark", "updatedAt":later,
                    "deletedAt":0, "deviceId":"recovery-device", "syncVersion":2,
                    "payload":{"chapter":2}
                },
                {
                    "id":"later-bookmark", "kind":"bookmark", "updatedAt":later,
                    "deletedAt":0, "deviceId":"recovery-device", "syncVersion":1,
                    "payload":{"chapter":3}
                },
                {
                    "id":"secret", "kind":"secret_bundle_v1", "updatedAt":later,
                    "deletedAt":0, "deviceId":"recovery-device", "syncVersion":1,
                    "payload":{"ciphertext":"keep"}
                }
            ]),
        ),
    ] {
        let response = service
            .clone()
            .oneshot(request(
                "POST",
                "/v1/sync/push",
                Some(token),
                &json!({"mutationId":mutation_id,"dataGeneration":1,"entities":entities}),
            ))
            .await
            .expect("recovery push");
        assert_eq!(response.status(), StatusCode::OK);
    }
}

async fn assert_recovery_history_rows(pool: &sqlx::PgPool) {
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sync_entity_history_v4 WHERE user_id='recovery-user'",
        )
        .fetch_one(pool)
        .await
        .expect("recovery history count"),
        3,
        "secret bundle must not be present in recovery history"
    );
}

async fn recovery_status_and_target(service: &Router, pool: &sqlx::PgPool, token: &str) -> i64 {
    let before = response_json(
        service
            .clone()
            .oneshot(request(
                "GET",
                "/v1/sync/recovery/status",
                Some(token),
                &Value::Null,
            ))
            .await
            .expect("recovery status"),
    )
    .await;
    assert_eq!(before["available"], true);
    assert_eq!(before["versionCount"], 3);
    sqlx::query_scalar::<_, i64>(
        "SELECT MIN(recorded_at) FROM sync_entity_history_v4 WHERE user_id='recovery-user'",
    )
    .fetch_one(pool)
    .await
    .expect("first history time")
}

async fn restore_recovery_target(service: &Router, token: &str, history_target: i64) -> Value {
    let response = service
        .clone()
        .oneshot(request(
            "POST",
            "/v1/sync/recovery/restore",
            Some(token),
            &json!({
                "password":"recovery-password-v4", "confirm":true,
                "targetAt":history_target, "dataGeneration":1
            }),
        ))
        .await
        .expect("restore response");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
}

async fn assert_recovery_restored_rows(pool: &sqlx::PgPool) {
    let envelopes = sqlx::query_as::<_, (String, Value)>(
        "SELECT entity_id,envelope FROM sync_entities_v4 \
         WHERE user_id='recovery-user' ORDER BY entity_id",
    )
    .fetch_all(pool)
    .await
    .expect("restored entities");
    assert_eq!(envelopes[0].0, "later-bookmark");
    assert!(envelopes[0].1["deletedAt"].as_i64().is_some());
    assert_ne!(envelopes[0].1["deletedAt"], 0);
    assert_eq!(envelopes[1].0, "recovery-bookmark");
    assert_eq!(envelopes[1].1["payload"]["chapter"], 1);
    assert_eq!(envelopes[2].0, "secret");
    assert_eq!(envelopes[2].1["payload"]["ciphertext"], "keep");
}
