//! Service-side fixture guard for the encrypted host-inference relay.
//!
//! This is deliberately offline: it proves the server's safe-failure and
//! cancellation receipt semantics stay aligned with the portable V1 contract.

use serde_json::Value;

fn object<'a>(value: &'a Value, key: &str) -> &'a serde_json::Map<String, Value> {
    value[key].as_object().expect("fixture object")
}

#[test]
fn fixture_and_schema_keep_safe_failures_content_free_and_cancellation_observable() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/intelligence/host-inference-v1.schema.json"
    ))
    .expect("parse host inference schema");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/intelligence-host-inference-v1.json"
    ))
    .expect("parse host inference fixture");

    let definitions = object(&schema, "$defs");
    let result = object(&definitions["encryptedResult"], "properties");
    assert_eq!(
        result["failureCode"]["enum"],
        serde_json::json!([
            "cancelled",
            "host_unavailable",
            "model_failed",
            "input_unsupported",
            "policy_refused"
        ])
    );
    assert_eq!(
        definitions["encryptedResult"]["oneOf"]
            .as_array()
            .map(Vec::len),
        Some(2),
        "an encrypted result and a safe failure must remain mutually exclusive"
    );
    assert!(object(&definitions["taskReceipt"], "properties").contains_key("cancelRequestedAt"));

    let request = object(&fixture, "request");
    let safe_failure = object(&fixture, "safeFailure");
    assert_eq!(safe_failure["schemaVersion"], 1);
    assert_eq!(safe_failure["taskId"], request["taskId"]);
    assert_eq!(safe_failure["failureCode"], "model_failed");
    assert!(!safe_failure.contains_key("resultEnvelope"));
    for forbidden in [
        "error", "message", "detail", "prompt", "text", "answer", "model",
    ] {
        assert!(
            !safe_failure.contains_key(forbidden),
            "safe failure must not expose {forbidden}"
        );
    }
}
