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
async fn checkpoint_requires_v5_authentication_and_a_valid_query() {
    let missing_protocol = app(test_state())
        .oneshot(
            Request::get("/v1/sync/checkpoint?dataGeneration=1&cursor=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_protocol.status(), StatusCode::UPGRADE_REQUIRED);

    let invalid = app(test_state())
        .oneshot(
            Request::get("/v1/sync/checkpoint?dataGeneration=0&cursor=-1")
                .header("x-sync-protocol-version", "5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_invalid_request(invalid).await;

    let reaches_auth = app(test_state())
        .oneshot(
            Request::get("/v1/sync/checkpoint?dataGeneration=1&cursor=0")
                .header("x-sync-protocol-version", "5")
                .header("authorization", "Bearer fixture-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_reaches_database_boundary(reaches_auth).await;
}

#[tokio::test]
async fn intelligence_capabilities_requires_bearer_authentication_before_database_access() {
    let response = app(test_state())
        .oneshot(
            Request::get("/v1/intelligence/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json(response).await["error"]["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn host_inference_relay_requires_a_credential_before_feature_or_database_access() {
    // The test configuration deliberately leaves the private relay disabled.
    // Anonymous callers must still learn neither that fact nor any route
    // details; every endpoint starts with its account or host credential gate.
    for request in [
        Request::post("/v1/intelligence/host-pairings/offers")
            .body(Body::empty())
            .unwrap(),
        Request::post(
            "/v1/intelligence/host-pairings/offers/00000000-0000-0000-0000-000000000001/claim",
        )
        .body(Body::empty())
        .unwrap(),
        Request::get("/v1/intelligence/host-pairings")
            .body(Body::empty())
            .unwrap(),
        Request::delete("/v1/intelligence/host-pairings/00000000-0000-0000-0000-000000000001")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/intelligence/host-tasks")
            .body(Body::empty())
            .unwrap(),
        Request::get("/v1/intelligence/host-tasks")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/intelligence/host-tasks/task:one/claim")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/intelligence/host-tasks/task:one/result")
            .body(Body::empty())
            .unwrap(),
        Request::get("/v1/intelligence/host-tasks/task:one")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/intelligence/host-tasks/task:one/cancel")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/intelligence/host-tasks/task:one/ack")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json(response).await["error"]["code"], "UNAUTHORIZED");
    }
}

#[tokio::test]
async fn intelligence_publication_routes_require_bearer_before_content_or_database_access() {
    for request in [
        Request::get("/v1/intelligence/feed")
            .body(Body::empty())
            .unwrap(),
        Request::get("/v1/intelligence/stream")
            .body(Body::empty())
            .unwrap(),
        Request::get("/v1/intelligence/publications/daily:2026-08-23:zh-CN")
            .body(Body::empty())
            .unwrap(),
        json_request(
            "POST",
            "/v1/intelligence/uploads/init",
            &serde_json::json!({}),
        ),
        Request::post("/v1/intelligence/uploads/daily:2026-08-23:zh-CN/complete")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json(response).await["error"]["code"], "UNAUTHORIZED");
    }
}

#[tokio::test]
async fn intelligence_account_state_and_assets_require_bearer_before_database_access() {
    for request in [
        Request::get("/v1/intelligence/preferences")
            .body(Body::empty())
            .unwrap(),
        json_request(
            "PUT",
            "/v1/intelligence/preferences",
            &serde_json::json!({"schemaVersion":1,"topics":[],"minimumImportance":0}),
        ),
        Request::post("/v1/intelligence/deliveries/daily:2026-08-23:zh-CN/ack")
            .body(Body::empty())
            .unwrap(),
        json_request(
            "POST",
            "/v1/intelligence/devices",
            &serde_json::json!({"schemaVersion":1,"deviceId":"device:1","platform":"windows","quietHours":{}}),
        ),
        Request::get("/v1/intelligence/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json(response).await["error"]["code"], "UNAUTHORIZED");
    }
}

#[tokio::test]
async fn intelligence_archive_and_relay_routes_reject_anonymous_requests_without_waiting() {
    let archive_id = "00000000-0000-0000-0000-000000000001";
    let content = serde_json::json!({
        "contentBase64": "YQ==",
        "contentSha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    });
    let mut requests = vec![
        json_request(
            "POST",
            "/v1/intelligence/archive-requests",
            &serde_json::json!({"request":{"day":"2030-01-02"}}),
        ),
        Request::get("/v1/intelligence/archive/calendar")
            .body(Body::empty())
            .unwrap(),
        Request::get(format!("/v1/intelligence/archive-requests/{archive_id}"))
            .body(Body::empty())
            .unwrap(),
        Request::get(format!(
            "/v1/intelligence/archive-requests/{archive_id}/content"
        ))
        .body(Body::empty())
        .unwrap(),
        Request::post(format!(
            "/v1/intelligence/archive-requests/{archive_id}/content/ack"
        ))
        .header("idempotency-key", "fixture-archive-ack")
        .body(Body::empty())
        .unwrap(),
        Request::get("/v1/intelligence/publisher/jobs?wait=25")
            .body(Body::empty())
            .unwrap(),
        json_request(
            "POST",
            "/v1/intelligence/publisher/heartbeat",
            &serde_json::json!({"schemaVersion":1,"installationId":"fixture-installation"}),
        ),
    ];
    for (path, body) in [
        ("claim", serde_json::Value::Null),
        ("not-found", serde_json::json!({"reason":"fixture"})),
        ("failed", serde_json::json!({"reason":"fixture"})),
        ("content", content),
    ] {
        let mut request = json_request(
            "POST",
            &format!("/v1/intelligence/publisher/jobs/{archive_id}/{path}"),
            &body,
        );
        request
            .headers_mut()
            .insert("idempotency-key", "fixture-relay".parse().unwrap());
        requests.push(request);
    }

    for request in requests {
        let response = app(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json(response).await["error"]["code"], "UNAUTHORIZED");
    }
}

#[test]
fn sync_checkpoint_fixture_matches_the_schema_surface() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/sync/sync-checkpoint.schema.json"
    ))
    .expect("checkpoint schema JSON");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/sync-checkpoint.v1.json"
    ))
    .expect("checkpoint fixture JSON");
    assert_eq!(fixture["path"], "/v1/sync/checkpoint");
    assert_eq!(fixture["method"], "GET");
    for case_name in ["caughtUp", "behind"] {
        let case = &fixture[case_name];
        for field in schema["$defs"]["query"]["required"].as_array().unwrap() {
            assert!(case["query"].get(field.as_str().unwrap()).is_some());
        }
        for field in schema["$defs"]["response"]["required"].as_array().unwrap() {
            assert!(case["response"].get(field.as_str().unwrap()).is_some());
        }
    }
    assert!(
        fixture["caughtUp"]["response"]["caughtUp"]
            .as_bool()
            .unwrap()
    );
    assert!(!fixture["behind"]["response"]["caughtUp"].as_bool().unwrap());
    assert_eq!(
        fixture["generationMismatch"]["errorCode"],
        "DATA_GENERATION_MISMATCH"
    );
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
async fn phone_registration_is_unavailable_without_sms_provider() {
    let mut state = test_state();
    state.config.sms = None;
    let mut request = Request::post("/v1/auth/register/phone/start")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"username":"new-reader","phone":"+8613711112222","installationId":"test-installation"}"#,
        ))
        .unwrap();
    loopback_peer(&mut request);
    let response = app(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(response).await;
    assert_eq!(body["error"]["code"], "PHONE_REGISTRATION_UNAVAILABLE");
}

#[tokio::test]
async fn phone_registration_rejects_non_e164_before_database_access() {
    let mut state = test_state();
    state.config.sms = Some(reader_sync_api::config::TencentSmsConfig {
        secret_id: "test-id".to_owned(),
        secret_key: secrecy::SecretString::from("test-secret-key-value".to_owned()),
        sdk_app_id: "1400000000".to_owned(),
        sign_name: "test".to_owned(),
        template_id: "1000".to_owned(),
        region: "ap-guangzhou".to_owned(),
        daily_send_limit: 10,
    });
    let mut request = Request::post("/v1/auth/register/phone/start")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"username":"new-reader","phone":"13711112222","installationId":"test-installation"}"#,
        ))
        .unwrap();
    loopback_peer(&mut request);
    assert_invalid_request(app(state).oneshot(request).await.unwrap()).await;
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
    assert!(body["paths"]["/v1/sync/checkpoint"].is_object());
    assert!(body["paths"]["/v1/sync/inventory"].is_object());
    assert!(body["paths"]["/v1/sync/reconcile"].is_object());
    assert!(body["paths"]["/v1/sync/secret-state"].is_object());
    assert!(body["paths"]["/v1/sync/secret-state/reset"].is_object());
    assert!(body["paths"]["/v1/sync/data/reset"].is_object());
    assert!(body["paths"]["/v1/sync/recovery/status"].is_null());
    assert!(body["paths"]["/v1/sync/recovery/restore"].is_null());
    assert_assets_openapi(&body);
}

#[tokio::test]
async fn cloud_recovery_routes_are_not_available() {
    for request in [
        Request::get("/v1/sync/recovery/status")
            .body(Body::empty())
            .unwrap(),
        Request::post("/v1/sync/recovery/restore")
            .body(Body::from("{}"))
            .unwrap(),
    ] {
        let response = app(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[test]
fn phone_registration_contract_fixture_matches_json_schema() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/auth/phone-registration.schema.json"
    ))
    .expect("phone registration schema JSON");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/phone-registration-api.v1.json"
    ))
    .expect("phone registration fixture JSON");
    let start = &fixture["start"]["requestExample"];
    let confirm = &fixture["confirm"]["requestExample"];
    let response = &fixture["start"]["response"];
    assert_eq!(
        start
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        schema["$defs"]["startRequest"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
    );
    assert_eq!(
        response["expiresIn"],
        schema["$defs"]["startResponse"]["properties"]["expiresIn"]["const"]
    );
    assert_eq!(confirm["phone"], "+8613711112222");
    assert_eq!(confirm["code"].as_str().unwrap().len(), 6);
    for required in schema["$defs"]["confirmRequest"]["required"]
        .as_array()
        .unwrap()
    {
        assert!(confirm.get(required.as_str().unwrap()).is_some());
    }
    for sensitive in fixture["sensitiveValuesOmitted"].as_array().unwrap() {
        let sensitive = sensitive.as_str().unwrap();
        assert!(fixture["start"]["response"].get(sensitive).is_none());
    }
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
        ("/v1/sync/checkpoint", "get"),
        ("/v1/sync/inventory", "get"),
        ("/v1/sync/reconcile", "post"),
        ("/v1/sync/secret-state", "get"),
        ("/v1/sync/secret-state/reset", "post"),
        ("/v1/sync/data/reset", "post"),
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
        body["paths"]["/v1/sync/checkpoint"]["get"]["security"][0]["bearer_token"],
        serde_json::json!([])
    );
    assert!(body["components"]["schemas"]["CheckpointQuery"].is_object());
    assert!(body["components"]["schemas"]["CheckpointResponse"].is_object());
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
    assert!(body["paths"]["/v1/auth/register/phone/start"].is_object());
    assert!(body["paths"]["/v1/auth/register/phone/confirm"].is_object());
    assert_eq!(
        body["components"]["schemas"]["PhoneRegistrationStartRequest"]["required"],
        serde_json::json!(["username", "phone", "installationId"])
    );
    assert_eq!(
        body["components"]["schemas"]["PhoneRegistrationConfirmRequest"]["required"],
        serde_json::json!(["username", "phone", "code", "password", "installationId"])
    );
    assert_password_reset_openapi(&body);
    assert!(body["paths"]["/v1/auth/password/change"].is_object());
    assert!(body["paths"]["/v1/auth/security"].is_object());
    assert!(body["paths"]["/v1/auth/usage"].is_object());
    assert!(body["paths"]["/v1/auth/account/delete"].is_object());
    assert!(body["paths"]["/v1/intelligence/capabilities"].is_object());
    assert_eq!(
        bearer_security(&body["paths"]["/v1/intelligence/capabilities"]["get"]),
        serde_json::json!([])
    );
    assert!(body["components"]["schemas"]["CapabilitiesResponse"].is_object());
    assert!(body["components"]["schemas"]["ArchiveAvailability"].is_object());
    for (path, method) in [
        ("/v1/intelligence/feed", "get"),
        ("/v1/intelligence/stream", "get"),
        ("/v1/intelligence/publications/{id}", "get"),
        ("/v1/intelligence/preferences", "get"),
        ("/v1/intelligence/preferences", "put"),
        ("/v1/intelligence/deliveries/{id}/ack", "post"),
        ("/v1/intelligence/devices", "post"),
        ("/v1/intelligence/assets/{sha256}", "get"),
        ("/v1/intelligence/archive-requests", "post"),
        ("/v1/intelligence/archive/calendar", "get"),
        ("/v1/intelligence/archive-requests/{id}", "get"),
        ("/v1/intelligence/archive-requests/{id}/content", "get"),
        ("/v1/intelligence/archive-requests/{id}/content/ack", "post"),
        ("/v1/intelligence/publisher/jobs", "get"),
        ("/v1/intelligence/publisher/heartbeat", "post"),
        ("/v1/intelligence/publisher/jobs/{id}/claim", "post"),
        ("/v1/intelligence/publisher/jobs/{id}/content", "post"),
        ("/v1/intelligence/publisher/jobs/{id}/not-found", "post"),
        ("/v1/intelligence/publisher/jobs/{id}/failed", "post"),
        ("/v1/intelligence/uploads/init", "post"),
        ("/v1/intelligence/uploads/{id}/complete", "post"),
    ] {
        assert!(body["paths"][path][method].is_object(), "{method} {path}");
        assert_eq!(
            bearer_security(&body["paths"][path][method]),
            serde_json::json!([]),
            "{method} {path} must declare bearer authentication"
        );
    }
    assert!(body["components"]["schemas"]["PublicationUploadResponse"].is_object());
    assert!(body["components"]["schemas"]["FeedPage"].is_object());
    assert!(body["components"]["schemas"]["PreferencesResponse"].is_object());
    assert!(body["components"]["schemas"]["DeviceResponse"].is_object());
    assert!(body["components"]["schemas"]["ArchiveRequestView"].is_object());
    assert!(body["components"]["schemas"]["PublisherJobsResponse"].is_object());
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
async fn registration_confirmation_enforces_the_new_password_character_range() {
    let valid = json_request(
        "POST",
        "/v1/auth/register/confirm",
        &serde_json::json!({
            "username": "fixture-reader",
            "email": "fixture@example.com",
            "code": "000000",
            "password": "密密密密密密密密",
            "installationId": "fixture-installation"
        }),
    );
    assert_reaches_database_boundary(app(test_state()).oneshot(valid).await.unwrap()).await;

    let invalid = json_request(
        "POST",
        "/v1/auth/register/confirm",
        &serde_json::json!({
            "username": "fixture-reader",
            "email": "fixture@example.com",
            "code": "000000",
            "password": "1234567",
            "installationId": "fixture-installation"
        }),
    );
    assert_invalid_request(app(test_state()).oneshot(invalid).await.unwrap()).await;
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
