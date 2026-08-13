use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use metrics_exporter_prometheus::PrometheusBuilder;
use reader_sync_api::{app, config::Config, pool_for_test, state::AppState};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tower::ServiceExt;

fn test_state() -> AppState {
    let config = Config::for_test("postgresql://unused:unused@127.0.0.1:1/unused");
    let recorder = PrometheusBuilder::new().build_recorder();
    let metrics = recorder.handle();
    AppState {
        pool: pool_for_test(),
        metrics,
        request_slots: Arc::new(Semaphore::new(config.max_concurrent_requests)),
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        config,
    }
}

fn bearer_security(operation: &Value) -> Value {
    operation["security"][0]["bearer_token"].clone()
}

async fn json(response: axum::response::Response) -> Value {
    let body = response
        .into_body()
        .collect()
        .await
        .expect("read response body")
        .to_bytes();
    serde_json::from_slice(&body).expect("valid JSON response")
}

fn json_request(method: &str, uri: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build JSON request")
}

fn loopback_peer(request: &mut Request<Body>) {
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
}

async fn assert_invalid_request(response: axum::response::Response) {
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json(response).await["error"]["code"], "INVALID_REQUEST");
}

async fn assert_reaches_database_boundary(response: axum::response::Response) {
    assert!(
        matches!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
        ),
        "the request must pass JSON decoding and route validation before the disconnected test pool rejects its first database operation"
    );
    assert!(matches!(
        json(response).await["error"]["code"].as_str(),
        Some("DATABASE_UNAVAILABLE" | "REQUEST_TIMEOUT")
    ));
}

#[tokio::test]
async fn health_reports_protocol_and_request_id() {
    let response = app(test_state())
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key("x-request-id"));
    let body = json(response).await;
    assert_eq!(body["syncProtocolVersion"], 5);
    assert_eq!(body["service"], "reader-sync-api");
}

#[tokio::test]
async fn sync_rejects_missing_protocol_before_business_logic() {
    let response = app(test_state())
        .oneshot(Request::get("/v1/sync/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "SYNC_PROTOCOL_UNSUPPORTED");
    assert!(body["error"]["requestId"].is_string());
}

#[tokio::test]
async fn sync_accepts_protocol_v5_and_rejects_v4() {
    let response = app(test_state())
        .oneshot(
            Request::get("/v1/sync/status")
                .header("x-sync-protocol-version", "5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = json(response).await;
    assert_eq!(body["syncProtocolVersion"], 5);

    let response = app(test_state())
        .oneshot(
            Request::get("/v1/sync/status")
                .header("x-sync-protocol-version", "4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
}

#[tokio::test]
async fn auth_responses_are_never_cached() {
    let response = app(test_state())
        .oneshot(
            Request::get("/v1/auth/security")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["cache-control"], "no-store");
}

#[tokio::test]
async fn unknown_route_uses_structured_error() {
    let response = app(test_state())
        .oneshot(Request::get("/missing").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
}

#[tokio::test]
async fn malformed_json_uses_contract_error_shape() {
    let response = app(test_state())
        .oneshot(
            Request::post("/v1/auth/login")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response.headers().contains_key("x-request-id"));
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "INVALID_REQUEST");
    assert!(body["error"]["requestId"].is_string());
}

#[tokio::test]
async fn legacy_registration_requires_email_flow() {
    let response = app(test_state())
        .oneshot(
            Request::post("/v1/auth/register")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "REGISTRATION_EMAIL_REQUIRED");
}

#[tokio::test]
async fn registration_is_unavailable_without_smtp() {
    let mut state = test_state();
    state.config.smtp = None;
    let mut request = Request::post("/v1/auth/register/start")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"username":"new-reader","email":"reader@example.com"}"#,
        ))
        .unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
    let response = app(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "REGISTRATION_UNAVAILABLE");
}

#[tokio::test]
async fn password_reset_request_is_unavailable_without_smtp() {
    let mut state = test_state();
    state.config.smtp = None;
    let mut request = Request::post("/v1/auth/password/reset/request")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"username":"existing-reader","email":"reader@example.com"}"#,
        ))
        .unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:54321"
            .parse::<std::net::SocketAddr>()
            .expect("loopback test peer"),
    ));
    let response = app(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "REGISTRATION_UNAVAILABLE");
}

fn assert_password_reset_openapi(body: &Value) {
    assert!(body["paths"]["/v1/auth/password/reset/request"].is_object());
    assert!(body["paths"]["/v1/auth/password/reset/confirm"].is_object());
    assert!(
        body["paths"]["/v1/auth/password/reset/request"]["post"]["responses"]["202"].is_object()
    );
    assert!(
        body["paths"]["/v1/auth/password/reset/confirm"]["post"]["responses"]["200"].is_object()
    );
    assert_eq!(
        body["components"]["schemas"]["PasswordResetRequest"]["required"],
        serde_json::json!(["username", "email"])
    );
    assert_eq!(
        body["components"]["schemas"]["PasswordResetConfirmRequest"]["required"],
        serde_json::json!(["username", "code", "newPassword", "installationId"])
    );
    assert_eq!(
        body["components"]["schemas"]["PasswordResetRequestResponse"]["required"],
        serde_json::json!(["ok", "expiresIn", "requestId"])
    );
}

fn assert_assets_openapi(body: &Value) {
    assert!(body["paths"]["/v1/sync/assets/init"].is_object());
    assert!(body["paths"]["/v1/sync/assets/{asset_id}"].is_object());
    assert!(body["paths"]["/v1/sync/assets/init"]["post"]["responses"]["200"].is_object());
    assert!(body["paths"]["/v1/sync/assets/{asset_id}"]["put"]["responses"]["204"].is_object());
    assert!(body["paths"]["/v1/sync/assets/{asset_id}"]["get"]["responses"]["206"].is_object());
    assert_eq!(
        body["components"]["schemas"]["AssetInitRequest"]["required"],
        serde_json::json!(["assetId", "sha256", "mime", "byteSize", "dataGeneration"])
    );
    assert_eq!(
        body["components"]["schemas"]["AssetInitResponse"]["required"],
        serde_json::json!(["complete", "receivedBytes"])
    );
}

fn assert_v5_protocol_header(body: &Value, path: &str, method: &str) {
    let parameters = body["paths"][path][method]["parameters"]
        .as_array()
        .unwrap_or_else(|| panic!("{method} {path} must declare parameters"));
    let protocol = parameters
        .iter()
        .find(|parameter| parameter["name"] == "X-Sync-Protocol-Version")
        .unwrap_or_else(|| panic!("{method} {path} must declare protocol header"));
    assert_eq!(protocol["in"], "header");
    assert_eq!(protocol["description"], "Must be 5");
}

fn assert_recovery_openapi(body: &Value) {
    assert!(body["paths"]["/v1/sync/recovery/status"].is_object());
    assert!(body["paths"]["/v1/sync/recovery/restore"].is_object());
    assert_eq!(
        body["paths"]["/v1/sync/recovery/status"]["get"]["security"][0]["bearer_token"],
        serde_json::json!([])
    );
    assert_eq!(
        body["paths"]["/v1/sync/recovery/restore"]["post"]["security"][0]["bearer_token"],
        serde_json::json!([])
    );
    assert_eq!(
        body["components"]["schemas"]["RecoveryRestoreRequest"]["required"],
        serde_json::json!(["password", "confirm", "targetAt", "dataGeneration"])
    );
    assert_eq!(
        body["components"]["schemas"]["RecoveryRestoreResponse"]["required"],
        serde_json::json!([
            "ok",
            "targetAt",
            "restoredAt",
            "restoredEntities",
            "tombstonedEntities",
            "dataGeneration",
            "tokensRevoked"
        ])
    );
}

#[tokio::test]
async fn openapi_defines_bearer_security_and_sync_routes() {
    let response = app(test_state())
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    assert_eq!(
        body["components"]["securitySchemes"]["bearer_token"]["scheme"],
        "bearer"
    );
    assert!(body["paths"]["/v1/sync/push"].is_object());
    assert!(body["paths"]["/v1/sync/pull"].is_object());
    assert!(body["paths"]["/v1/sync/inventory"].is_object());
    assert!(body["paths"]["/v1/sync/reconcile"].is_object());
    assert!(body["paths"]["/v1/sync/secret-state"].is_object());
    assert!(body["paths"]["/v1/sync/secret-state/reset"].is_object());
    assert!(body["paths"]["/v1/sync/data/reset"].is_object());
    assert_recovery_openapi(&body);
    assert_assets_openapi(&body);
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn openapi_sync_protocol_headers_require_v5() {
    let response = app(test_state())
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    for (path, method) in [
        ("/v1/sync/status", "get"),
        ("/v1/sync/push", "post"),
        ("/v1/sync/pull", "get"),
        ("/v1/sync/inventory", "get"),
        ("/v1/sync/reconcile", "post"),
        ("/v1/sync/secret-state", "get"),
        ("/v1/sync/secret-state/reset", "post"),
        ("/v1/sync/data/reset", "post"),
        ("/v1/sync/recovery/status", "get"),
        ("/v1/sync/recovery/restore", "post"),
        ("/v1/sync/assets/init", "post"),
        ("/v1/sync/assets/{asset_id}", "get"),
        ("/v1/sync/assets/{asset_id}", "put"),
    ] {
        assert_v5_protocol_header(&body, path, method);
    }
    assert_eq!(
        body["paths"]["/v1/sync/data/reset"]["post"]["security"][0]["bearer_token"],
        serde_json::json!([])
    );
    assert_eq!(
        body["components"]["schemas"]["DataResetRequest"]["required"],
        serde_json::json!(["password"])
    );
    assert!(body["components"]["schemas"]["DataResetResponse"].is_object());
    assert!(body["paths"]["/v1/auth/me"].is_object());
    assert!(body["paths"]["/v1/auth/register/start"].is_object());
    assert!(body["paths"]["/v1/auth/register/confirm"].is_object());
    assert!(
        body["paths"]["/v1/auth/register/start"]["post"]["responses"]["202"].is_object(),
        "registration-v2 start must retain its asynchronous acceptance response"
    );
    assert!(
        body["paths"]["/v1/auth/register/confirm"]["post"]["responses"]["201"].is_object(),
        "registration-v2 confirm must retain its create-and-login response"
    );
    assert_eq!(
        body["components"]["schemas"]["RegistrationStartRequest"]["required"],
        serde_json::json!(["username", "email"])
    );
    assert_eq!(
        body["components"]["schemas"]["RegistrationStartResponse"]["required"],
        serde_json::json!(["ok", "expiresIn", "requestId"])
    );
    assert_eq!(
        body["components"]["schemas"]["RegistrationConfirmRequest"]["required"],
        serde_json::json!(["username", "email", "code", "password", "installationId"])
    );
    assert_password_reset_openapi(&body);
    assert!(body["paths"]["/v1/auth/password/change"].is_object());
    assert!(body["paths"]["/v1/auth/security"].is_object());
    assert!(body["paths"]["/v1/auth/usage"].is_object());
    assert!(body["paths"]["/v1/auth/account/delete"].is_object());
    for route in [
        "/v1/auth/email/start",
        "/v1/auth/email/confirm",
        "/v1/auth/email/rebind/old/start",
        "/v1/auth/email/rebind/old/confirm",
        "/v1/auth/email/rebind/new/start",
        "/v1/auth/email/rebind/new/confirm",
    ] {
        assert!(
            body["paths"][route].is_object(),
            "{route} must be documented"
        );
    }
    for route in [
        "/v1/auth/session",
        "/v1/auth/me",
        "/v1/auth/logout",
        "/v1/auth/password/change",
        "/v1/auth/security",
        "/v1/auth/usage",
        "/v1/auth/account/delete",
    ] {
        let method = if matches!(
            route,
            "/v1/auth/logout" | "/v1/auth/password/change" | "/v1/auth/account/delete"
        ) {
            "post"
        } else {
            "get"
        };
        assert_eq!(
            bearer_security(&body["paths"][route][method]),
            serde_json::json!([]),
            "{route} must declare its Bearer requirement"
        );
    }
    assert_eq!(
        body["components"]["schemas"]["PasswordChangeRequest"]["required"],
        serde_json::json!(["currentPassword", "newPassword"])
    );
    assert!(body["paths"]["/v1/feedback"].is_object());
    assert!(body["paths"]["/v1/feedback"]["post"]["responses"]["201"].is_object());
    assert_eq!(
        body["components"]["schemas"]["FeedbackRequest"]["required"],
        serde_json::json!(["kind", "text", "appVersion", "platform", "images"])
    );
    assert!(
        body["components"]["schemas"]["FeedbackRequest"]["properties"]["attachments"].is_object()
    );
    assert_eq!(
        body["components"]["schemas"]["FeedbackResponse"]["required"],
        serde_json::json!([
            "ok",
            "id",
            "message",
            "emailed",
            "acceptedAttachments",
            "requestId"
        ])
    );
}

#[tokio::test]
async fn v5_push_accepts_only_camel_case_wire_fields() {
    let camel = json_request(
        "POST",
        "/v1/sync/push",
        &serde_json::json!({
            "mutationId": "018f5cb4-5d48-7a03-8e7a-000000000001",
            "dataGeneration": 1,
            "entities": [{
                "id": "fixture",
                "kind": "vocab",
                "updatedAt": 1_786_521_600_123_i64,
                "deletedAt": 0,
                "deviceId": "fixture-device",
                "syncVersion": 1,
                "payload": {}
            }]
        }),
    )
    .into_parts();
    let mut camel = Request::from_parts(camel.0, camel.1);
    camel
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    camel
        .headers_mut()
        .insert("authorization", "Bearer fixture-token".parse().unwrap());
    assert_reaches_database_boundary(app(test_state()).oneshot(camel).await.unwrap()).await;

    let snake = json_request(
        "POST",
        "/v1/sync/push",
        &serde_json::json!({
            "mutation_id":"018f5cb4-5d48-7a03-8e7a-000000000001",
            "data_generation":1,
            "entities":[]
        }),
    )
    .into_parts();
    let mut snake = Request::from_parts(snake.0, snake.1);
    snake
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    assert_invalid_request(app(test_state()).oneshot(snake).await.unwrap()).await;
}

#[tokio::test]
async fn feedback_rejects_a_feature_attachment_before_database_access() {
    let response = app(test_state())
        .oneshot(
            Request::post("/v1/feedback")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{
                        "kind":"feature",
                        "text":"add a reading calendar",
                        "appVersion":"1.0.0",
                        "platform":"test",
                        "images":[],
                        "attachments":[{
                            "name":"proposal.json",
                            "mime":"application/json",
                            "data":"e30="
                        }]
                    }"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn feedback_runtime_accepts_contract_camel_case_before_database_access() {
    let valid = json_request(
        "POST",
        "/v1/feedback",
        &serde_json::json!({
            "kind": "bug",
            "text": "fixture diagnostic",
            "appVersion": "0.0.0-test",
            "platform": "test",
            "images": []
        }),
    );
    assert_reaches_database_boundary(app(test_state()).oneshot(valid).await.unwrap()).await;

    let legacy_snake_case = json_request(
        "POST",
        "/v1/feedback",
        &serde_json::json!({
            "kind": "bug",
            "text": "fixture diagnostic",
            "app_version": "0.0.0-test",
            "platform": "test",
            "images": []
        }),
    );
    assert_invalid_request(app(test_state()).oneshot(legacy_snake_case).await.unwrap()).await;
}

#[tokio::test]
async fn password_and_reset_requests_reject_unknown_or_snake_case_fields_before_database_access() {
    let mut change_valid = json_request(
        "POST",
        "/v1/auth/password/change",
        &serde_json::json!({
            "currentPassword": "present-password",
            "newPassword": "long-enough-password"
        }),
    );
    change_valid
        .headers_mut()
        .insert("authorization", "Bearer fixture-token".parse().unwrap());
    assert_reaches_database_boundary(app(test_state()).oneshot(change_valid).await.unwrap()).await;

    let snake_case = json_request(
        "POST",
        "/v1/auth/password/change",
        &serde_json::json!({"current_password": "present", "new_password": "long-enough-password"}),
    );
    assert_invalid_request(app(test_state()).oneshot(snake_case).await.unwrap()).await;

    let mut reset_unknown_field = json_request(
        "POST",
        "/v1/auth/password/reset/confirm",
        &serde_json::json!({
            "username": "fixture-reader",
            "code": "000000",
            "newPassword": "long-enough-password",
            "installationId": "fixture-installation",
            "unexpected": true
        }),
    );
    loopback_peer(&mut reset_unknown_field);
    assert_invalid_request(
        app(test_state())
            .oneshot(reset_unknown_field)
            .await
            .unwrap(),
    )
    .await;

    let mut reset_valid = json_request(
        "POST",
        "/v1/auth/password/reset/confirm",
        &serde_json::json!({
            "username": "fixture-reader",
            "code": "000000",
            "newPassword": "long-enough-password",
            "installationId": "fixture-installation"
        }),
    );
    loopback_peer(&mut reset_valid);
    assert_reaches_database_boundary(app(test_state()).oneshot(reset_valid).await.unwrap()).await;
}

#[tokio::test]
async fn sync_runtime_uses_camel_case_request_fields_before_database_access() {
    let asset_id = "0".repeat(64);
    let asset_valid = json_request(
        "POST",
        "/v1/sync/assets/init",
        &serde_json::json!({
            "assetId": asset_id,
            "sha256": "0".repeat(64),
            "mime": "image/png",
            "byteSize": 1,
            "dataGeneration": 1
        }),
    )
    .into_parts();
    let mut asset_valid = Request::from_parts(asset_valid.0, asset_valid.1);
    asset_valid
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    asset_valid
        .headers_mut()
        .insert("authorization", "Bearer fixture-token".parse().unwrap());
    assert_reaches_database_boundary(app(test_state()).oneshot(asset_valid).await.unwrap()).await;

    let asset_snake_case = json_request(
        "POST",
        "/v1/sync/assets/init",
        &serde_json::json!({
            "asset_id": "0".repeat(64),
            "sha256": "0".repeat(64),
            "mime": "image/png",
            "byte_size": 1,
            "dataGeneration": 1
        }),
    )
    .into_parts();
    let mut asset_snake_case = Request::from_parts(asset_snake_case.0, asset_snake_case.1);
    asset_snake_case
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    assert_invalid_request(app(test_state()).oneshot(asset_snake_case).await.unwrap()).await;

    let mut recovery_fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/sync-recovery-history.v1.json"
    ))
    .expect("recovery contract fixture");
    let recovery_request = recovery_fixture["restore"]["request"]
        .as_object_mut()
        .expect("recovery restore request fixture");
    recovery_request.insert(
        "password".to_owned(),
        Value::String("long-enough-password".to_owned()),
    );
    assert_eq!(recovery_request.len(), 4);
    assert!(recovery_request.contains_key("confirm"));
    assert!(recovery_request.contains_key("targetAt"));
    assert!(recovery_request.contains_key("dataGeneration"));
    assert!(recovery_request.contains_key("password"));
    let recovery_valid = json_request(
        "POST",
        "/v1/sync/recovery/restore",
        &recovery_fixture["restore"]["request"],
    )
    .into_parts();
    let mut recovery_valid = Request::from_parts(recovery_valid.0, recovery_valid.1);
    recovery_valid
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    recovery_valid
        .headers_mut()
        .insert("authorization", "Bearer fixture-token".parse().unwrap());
    assert_reaches_database_boundary(app(test_state()).oneshot(recovery_valid).await.unwrap())
        .await;

    let recovery_snake_case = json_request(
        "POST",
        "/v1/sync/recovery/restore",
        &serde_json::json!({
            "password": "long-enough-password",
            "confirm": true,
            "target_at": 1_786_155_000_000_i64,
            "dataGeneration": 1
        }),
    )
    .into_parts();
    let mut recovery_snake_case = Request::from_parts(recovery_snake_case.0, recovery_snake_case.1);
    recovery_snake_case
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    assert_invalid_request(
        app(test_state())
            .oneshot(recovery_snake_case)
            .await
            .unwrap(),
    )
    .await;
}

#[tokio::test]
async fn sync_push_rejects_retired_jump_back_settings_before_database_access() {
    let retired = json_request(
        "POST",
        "/v1/sync/push",
        &serde_json::json!({
            "mutationId": "018f5cb4-5d48-7a-0000-000000000001",
            "dataGeneration": 1,
            "entities": [{
                "id": "default",
                "kind": "app_settings_v1",
                "updatedAt": 1_786_521_600_123_i64,
                "deletedAt": 0,
                "deviceId": "fixture-device",
                "syncVersion": 1,
                "payload": {
                    "readerJumpBackIconSizePx": 60,
                    "readerJumpBackSizeLevel": 4
                }
            }]
        }),
    )
    .into_parts();
    let mut retired = Request::from_parts(retired.0, retired.1);
    retired
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    let response = app(test_state()).oneshot(retired).await.unwrap();
    assert_invalid_request(response).await;
}

#[tokio::test]
async fn v5_sync_reconciliation_routes_reject_invalid_input_before_database_access() {
    let inventory = app(test_state())
        .oneshot(
            Request::get("/v1/sync/inventory?kind=unsupported")
                .header("x-sync-protocol-version", "5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_invalid_request(inventory).await;

    let reconcile = json_request(
        "POST",
        "/v1/sync/reconcile",
        &serde_json::json!({
            "dataGeneration": 1,
            "kinds": ["vocab"],
            "manifest": [{
                "kind": "vocab",
                "id": "duplicate",
                "updatedAt": 1_786_521_600_123_i64,
                "deletedAt": 0,
                "deviceId": "fixture-device",
                "syncVersion": 1
            }, {
                "kind": "vocab",
                "id": "duplicate",
                "updatedAt": 1_786_521_600_123_i64,
                "deletedAt": 0,
                "deviceId": "fixture-device",
                "syncVersion": 1
            }]
        }),
    )
    .into_parts();
    let mut reconcile = Request::from_parts(reconcile.0, reconcile.1);
    reconcile
        .headers_mut()
        .insert("x-sync-protocol-version", "5".parse().unwrap());
    assert_invalid_request(app(test_state()).oneshot(reconcile).await.unwrap()).await;
}
