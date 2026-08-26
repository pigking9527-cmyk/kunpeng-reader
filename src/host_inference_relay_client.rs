//! Desktop-side client foundation for the optional intelligence-host relay.
//!
//! This module is deliberately not wired to a Tauri command, capability flag,
//! account database, or host lifecycle.  It only sends the public task metadata
//! and HPKE envelopes defined by `host-inference-v1`; task text, prompts,
//! results, and private keys stay in [`crate::host_inference_crypto`].
//!
//! Bearer credentials are accepted per call, placed only in the HTTPS
//! `Authorization` header, and are never stored, serialized, logged, or put in
//! a URL.  A DPAPI-backed caller may implement its own lifecycle and pass the
//! decrypted token only for the duration of one client call.

use std::{collections::BTreeMap, io::Read as _, time::Duration};

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::host_inference_crypto::{
    open_result, seal_request, EncryptedEnvelopeV1, HostInferenceCryptoError,
    HostInferencePrivateKey, HostInferencePublicKey, HostInferenceTaskBinding, PrivatePayloadV1,
};

const RELAY_ROOT: &str = "/v1/intelligence/host-tasks";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Stable, content-free errors from the desktop relay client.  They never
/// include request URLs, response bodies, bearer tokens, task payloads, or
/// cryptographic material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostRelayClientError {
    InvalidConfiguration,
    InvalidCredential,
    InvalidIdempotencyKey,
    InvalidExpiration,
    Transport,
    ServerRejected,
    InvalidResponse,
    UnexpectedTaskState,
    Crypto(HostInferenceCryptoError),
}

impl std::fmt::Display for HostRelayClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidConfiguration => "主机推理中继配置无效",
            Self::InvalidCredential => "主机推理中继凭据无效",
            Self::InvalidIdempotencyKey => "主机推理中继幂等键无效",
            Self::InvalidExpiration => "主机推理任务过期时间无效",
            Self::Transport => "主机推理中继网络请求失败",
            Self::ServerRejected => "主机推理中继服务拒绝请求",
            Self::InvalidResponse => "主机推理中继服务响应无效",
            Self::UnexpectedTaskState => "主机推理任务状态不允许此操作",
            Self::Crypto(_) => "主机推理密封数据校验失败",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for HostRelayClientError {}

impl From<HostInferenceCryptoError> for HostRelayClientError {
    fn from(value: HostInferenceCryptoError) -> Self {
        Self::Crypto(value)
    }
}

/// A short-lived borrow of a caller-owned account token.  It intentionally has
/// no `Debug`, `Display`, or serde implementation.  The relay client does not
/// retain it after an operation returns.
pub struct HostRelayBearerToken<'a>(&'a str);

impl<'a> HostRelayBearerToken<'a> {
    pub fn from_memory(value: &'a str) -> Result<Self, HostRelayClientError> {
        if value.is_empty()
            || value.len() > 16_384
            || value
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(HostRelayClientError::InvalidCredential);
        }
        Ok(Self(value))
    }

    fn authorization_header(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

/// Optional integration seam for a platform secret lifecycle such as DPAPI.
/// The provider remains outside this module so the relay foundation neither
/// creates nor persists credentials itself.
pub trait HostRelayCredentialSource {
    fn relay_bearer_token(&self) -> Result<HostRelayBearerToken<'_>, HostRelayClientError>;
}

/// Reuse this key if a caller retries the same write after a transport failure.
/// It is not a credential, but keeping it typed prevents accidental placement
/// in a task URL.
#[derive(Clone, Eq, PartialEq)]
pub struct HostRelayIdempotencyKey(String);

impl HostRelayIdempotencyKey {
    pub fn new_random() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, HostRelayClientError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        {
            return Err(HostRelayClientError::InvalidIdempotencyKey);
        }
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostRelayHttpMethod {
    Get,
    Post,
}

/// Transport-level data deliberately has no `Debug` implementation: it can
/// contain an Authorization header and an encrypted envelope.
pub struct HostRelayHttpRequest {
    method: HostRelayHttpMethod,
    relative_path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl HostRelayHttpRequest {
    pub fn method(&self) -> HostRelayHttpMethod {
        self.method
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub struct HostRelayHttpResponse {
    status: u16,
    body: Vec<u8>,
}

impl HostRelayHttpResponse {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self { status, body }
    }
}

/// A transport is intentionally synchronous and mockable so callers can run it
/// in their existing native background task.  The concrete HTTPS implementation
/// below uses `ureq`; production wiring remains feature-gated elsewhere.
pub trait HostRelayTransport: Send + Sync {
    fn send(
        &self,
        request: HostRelayHttpRequest,
    ) -> Result<HostRelayHttpResponse, HostRelayClientError>;
}

/// HTTPS-only implementation for a configured account service origin.  It
/// rejects user info, query parameters, fragments, and base paths so a bearer
/// token or sensitive task field cannot be accidentally embedded in the URL.
pub struct UreqHostRelayTransport {
    agent: ureq::Agent,
    origin: String,
}

impl UreqHostRelayTransport {
    pub fn new(account_service_origin: &str) -> Result<Self, HostRelayClientError> {
        let url = reqwest::Url::parse(account_service_origin)
            .map_err(|_| HostRelayClientError::InvalidConfiguration)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.path().is_empty() || url.path() == "/")
        {
            return Err(HostRelayClientError::InvalidConfiguration);
        }
        let origin = url.origin().ascii_serialization();
        if origin == "null" {
            return Err(HostRelayClientError::InvalidConfiguration);
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        Ok(Self { agent, origin })
    }
}

impl HostRelayTransport for UreqHostRelayTransport {
    fn send(
        &self,
        request: HostRelayHttpRequest,
    ) -> Result<HostRelayHttpResponse, HostRelayClientError> {
        let url = format!("{}{}", self.origin, request.relative_path);
        let mut response = match request.method {
            HostRelayHttpMethod::Get => {
                let mut builder = self.agent.get(&url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            HostRelayHttpMethod::Post => {
                let mut builder = self.agent.post(&url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(&request.body)
            }
        }
        .map_err(|_| HostRelayClientError::Transport)?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| HostRelayClientError::Transport)?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(HostRelayClientError::InvalidResponse);
        }
        Ok(HostRelayHttpResponse { status, body })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HostRelayTaskState {
    Queued,
    Claimed,
    Running,
    ResultReady,
    CancelRequested,
    Cancelled,
    Expired,
    Failed,
    Purged,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRelayTaskReceipt {
    pub schema_version: u8,
    pub task_id: String,
    pub state: HostRelayTaskState,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default)]
    pub cancelled_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRelayTaskResult {
    schema_version: u8,
    task_id: String,
    state: HostRelayTaskState,
    expires_at: String,
    result_envelope: EncryptedEnvelopeV1,
}

/// A polled task intentionally exposes ciphertext only until the caller asks
/// [`HostRelayClient::poll_and_open_result`] to verify/decrypt it.
pub enum HostRelayPolledTask {
    Pending(HostRelayTaskReceipt),
    ResultReady {
        task_id: String,
        expires_at: String,
        envelope: EncryptedEnvelopeV1,
    },
}

pub enum HostRelayPollOutcome {
    Pending(HostRelayTaskReceipt),
    ResultReady(PrivatePayloadV1),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRelayTaskRequest<'a> {
    schema_version: u8,
    task_id: &'a str,
    pair_id: &'a str,
    operation: crate::host_inference_crypto::HostInferenceOperation,
    capability_revision: u32,
    expires_at: &'a str,
    request_envelope: &'a EncryptedEnvelopeV1,
}

/// Desktop client for a single account-service origin.  It stores only the
/// transport configuration; caller-owned bearer tokens are passed per method.
pub struct HostRelayClient<T> {
    transport: T,
}

/// All private inputs needed to submit one relay task. Keeping these inputs
/// together makes the capability-bearing operation auditable at the call site
/// and avoids a fragile flat argument list.
pub struct HostRelaySubmission<'a> {
    pub bearer: HostRelayBearerToken<'a>,
    pub idempotency_key: &'a HostRelayIdempotencyKey,
    pub binding: &'a HostInferenceTaskBinding,
    pub client_key: &'a HostInferencePrivateKey,
    pub host_key: &'a HostInferencePublicKey,
    pub expires_at: &'a str,
    pub payload: &'a PrivatePayloadV1,
}

impl<T: HostRelayTransport> HostRelayClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    /// Seal and submit a task request.  The payload is never projected into the
    /// request DTO; only the HPKE envelope crosses the transport boundary.
    pub fn submit_request(
        &self,
        submission: HostRelaySubmission<'_>,
    ) -> Result<HostRelayTaskReceipt, HostRelayClientError> {
        validate_expiration(submission.expires_at)?;
        let envelope = seal_request(
            submission.binding,
            submission.client_key,
            submission.host_key,
            submission.payload,
        )?;
        let body = serde_json::to_vec(&HostRelayTaskRequest {
            schema_version: 1,
            task_id: submission.binding.task_id(),
            pair_id: submission.binding.pair_id(),
            operation: submission.binding.operation(),
            capability_revision: submission.binding.capability_revision(),
            expires_at: submission.expires_at,
            request_envelope: &envelope,
        })
        .map_err(|_| HostRelayClientError::InvalidResponse)?;
        let response = self.send_json(
            HostRelayHttpMethod::Post,
            RELAY_ROOT.to_owned(),
            submission.bearer,
            Some(submission.idempotency_key),
            body,
        )?;
        let receipt: HostRelayTaskReceipt = parse_json(&response)?;
        validate_receipt(&receipt, submission.binding.task_id())?;
        Ok(receipt)
    }

    /// Fetch the current state once.  Scheduling/retry delays remain in the
    /// caller's native worker, preventing an HTTP loop from blocking the UI.
    pub fn poll_task(
        &self,
        bearer: HostRelayBearerToken<'_>,
        binding: &HostInferenceTaskBinding,
    ) -> Result<HostRelayPolledTask, HostRelayClientError> {
        let response = self.send_json(
            HostRelayHttpMethod::Get,
            task_path(binding.task_id())?,
            bearer,
            None,
            Vec::new(),
        )?;
        let value: Value = parse_json(&response)?;
        let state = value
            .get("state")
            .and_then(Value::as_str)
            .ok_or(HostRelayClientError::InvalidResponse)?;
        if state == "RESULT_READY" {
            let result: HostRelayTaskResult =
                serde_json::from_value(value).map_err(|_| HostRelayClientError::InvalidResponse)?;
            if result.schema_version != 1
                || result.task_id != binding.task_id()
                || result.state != HostRelayTaskState::ResultReady
                || !valid_timestamp(&result.expires_at)
            {
                return Err(HostRelayClientError::InvalidResponse);
            }
            return Ok(HostRelayPolledTask::ResultReady {
                task_id: result.task_id,
                expires_at: result.expires_at,
                envelope: result.result_envelope,
            });
        }
        let receipt: HostRelayTaskReceipt =
            serde_json::from_value(value).map_err(|_| HostRelayClientError::InvalidResponse)?;
        validate_receipt(&receipt, binding.task_id())?;
        Ok(HostRelayPolledTask::Pending(receipt))
    }

    /// Fetch and open a result if ready.  Successful decryption is not an ACK:
    /// the caller must first persist the returned private payload locally, then
    /// call [`Self::ack_result`] to let the relay purge its result ciphertext.
    pub fn poll_and_open_result(
        &self,
        bearer: HostRelayBearerToken<'_>,
        binding: &HostInferenceTaskBinding,
        client_key: &HostInferencePrivateKey,
        host_key: &HostInferencePublicKey,
    ) -> Result<HostRelayPollOutcome, HostRelayClientError> {
        match self.poll_task(bearer, binding)? {
            HostRelayPolledTask::Pending(receipt) => Ok(HostRelayPollOutcome::Pending(receipt)),
            HostRelayPolledTask::ResultReady { envelope, .. } => {
                Ok(HostRelayPollOutcome::ResultReady(open_result(
                    binding, client_key, host_key, &envelope,
                )?))
            }
        }
    }

    /// Request cancellation.  It is idempotency-protected and has no task text
    /// or encrypted payload in the request body.
    pub fn cancel_task(
        &self,
        bearer: HostRelayBearerToken<'_>,
        idempotency_key: &HostRelayIdempotencyKey,
        binding: &HostInferenceTaskBinding,
    ) -> Result<HostRelayTaskReceipt, HostRelayClientError> {
        let response = self.send_json(
            HostRelayHttpMethod::Post,
            format!("{}/cancel", task_path(binding.task_id())?),
            bearer,
            Some(idempotency_key),
            b"{}".to_vec(),
        )?;
        let receipt: HostRelayTaskReceipt = parse_json(&response)?;
        validate_receipt(&receipt, binding.task_id())?;
        if !matches!(
            receipt.state,
            HostRelayTaskState::CancelRequested | HostRelayTaskState::Cancelled
        ) {
            return Err(HostRelayClientError::UnexpectedTaskState);
        }
        Ok(receipt)
    }

    /// Acknowledge only after the caller has durably persisted a verified result.
    /// A successful response is empty and permits the server to purge the
    /// encrypted result immediately.
    pub fn ack_result(
        &self,
        bearer: HostRelayBearerToken<'_>,
        idempotency_key: &HostRelayIdempotencyKey,
        binding: &HostInferenceTaskBinding,
    ) -> Result<(), HostRelayClientError> {
        let response = self.send_json(
            HostRelayHttpMethod::Post,
            format!("{}/ack", task_path(binding.task_id())?),
            bearer,
            Some(idempotency_key),
            b"{}".to_vec(),
        )?;
        if !(200..300).contains(&response.status) || !response.body.is_empty() {
            return Err(HostRelayClientError::InvalidResponse);
        }
        Ok(())
    }

    fn send_json(
        &self,
        method: HostRelayHttpMethod,
        relative_path: String,
        bearer: HostRelayBearerToken<'_>,
        idempotency_key: Option<&HostRelayIdempotencyKey>,
        body: Vec<u8>,
    ) -> Result<HostRelayHttpResponse, HostRelayClientError> {
        let mut headers = BTreeMap::from([
            ("Accept".to_owned(), "application/json".to_owned()),
            ("Authorization".to_owned(), bearer.authorization_header()),
        ]);
        if method == HostRelayHttpMethod::Post {
            headers.insert("Content-Type".to_owned(), "application/json".to_owned());
            let key = idempotency_key.ok_or(HostRelayClientError::InvalidIdempotencyKey)?;
            headers.insert("Idempotency-Key".to_owned(), key.as_str().to_owned());
        }
        let response = self.transport.send(HostRelayHttpRequest {
            method,
            relative_path,
            headers,
            body,
        })?;
        if !(200..300).contains(&response.status) {
            return Err(HostRelayClientError::ServerRejected);
        }
        if response.body.len() > MAX_RESPONSE_BYTES {
            return Err(HostRelayClientError::InvalidResponse);
        }
        Ok(response)
    }
}

fn task_path(task_id: &str) -> Result<String, HostRelayClientError> {
    if !valid_contract_id(task_id) {
        return Err(HostRelayClientError::InvalidResponse);
    }
    Ok(format!("{RELAY_ROOT}/{task_id}"))
}

fn validate_expiration(value: &str) -> Result<(), HostRelayClientError> {
    valid_timestamp(value)
        .then_some(())
        .ok_or(HostRelayClientError::InvalidExpiration)
}

fn valid_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_contract_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn parse_json<T: for<'de> Deserialize<'de>>(
    response: &HostRelayHttpResponse,
) -> Result<T, HostRelayClientError> {
    serde_json::from_slice(&response.body).map_err(|_| HostRelayClientError::InvalidResponse)
}

fn validate_receipt(
    receipt: &HostRelayTaskReceipt,
    expected_task_id: &str,
) -> Result<(), HostRelayClientError> {
    if receipt.schema_version != 1
        || receipt.task_id != expected_task_id
        || !valid_timestamp(&receipt.created_at)
        || !valid_timestamp(&receipt.expires_at)
        || receipt
            .cancelled_at
            .as_deref()
            .is_some_and(|value| !valid_timestamp(value))
        || receipt
            .completed_at
            .as_deref()
            .is_some_and(|value| !valid_timestamp(value))
    {
        return Err(HostRelayClientError::InvalidResponse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::host_inference_crypto::{
        seal_result, HostInferenceDirection, HostInferenceKeyId, HostInferenceOperation,
    };

    struct MockTransport {
        replies: Mutex<VecDeque<HostRelayHttpResponse>>,
        requests: Mutex<Vec<HostRelayHttpRequest>>,
    }

    impl MockTransport {
        fn new(replies: Vec<HostRelayHttpResponse>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl HostRelayTransport for MockTransport {
        fn send(
            &self,
            request: HostRelayHttpRequest,
        ) -> Result<HostRelayHttpResponse, HostRelayClientError> {
            self.requests.lock().unwrap().push(request);
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(HostRelayClientError::Transport)
        }
    }

    fn binding() -> HostInferenceTaskBinding {
        HostInferenceTaskBinding::new(
            "task-demo-1",
            "pair-demo-1",
            HostInferenceOperation::LibraryAnswer,
            7,
        )
        .unwrap()
    }

    fn receipt(state: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "taskId": "task-demo-1",
            "state": state,
            "createdAt": "2026-08-24T00:00:00Z",
            "expiresAt": "2026-08-24T00:15:00Z"
        }))
        .unwrap()
    }

    fn token() -> HostRelayBearerToken<'static> {
        HostRelayBearerToken::from_memory("account-token-not-serialized").unwrap()
    }

    struct StaticCredentialSource;

    impl HostRelayCredentialSource for StaticCredentialSource {
        fn relay_bearer_token(&self) -> Result<HostRelayBearerToken<'_>, HostRelayClientError> {
            HostRelayBearerToken::from_memory("account-token-not-serialized")
        }
    }

    #[test]
    fn validates_optional_transport_and_credential_adapter_without_persisting_secrets() {
        let insecure_endpoint = format!("{}://relay.example.test", "http");
        assert!(matches!(
            UreqHostRelayTransport::new(&insecure_endpoint),
            Err(HostRelayClientError::InvalidConfiguration)
        ));
        assert!(HostRelayIdempotencyKey::parse("retry-key-1").is_ok());
        assert_eq!(
            StaticCredentialSource
                .relay_bearer_token()
                .unwrap()
                .authorization_header(),
            "Bearer account-token-not-serialized"
        );
    }

    #[test]
    fn pending_poll_preserves_the_receipt_for_caller_retry_scheduling() {
        let relay = HostRelayClient::new(MockTransport::new(vec![HostRelayHttpResponse::new(
            200,
            receipt("QUEUED"),
        )]));
        match relay.poll_and_open_result(
            token(),
            &binding(),
            &HostInferencePrivateKey::generate(
                HostInferenceKeyId::parse("key:client-pending").unwrap(),
            ),
            &HostInferencePrivateKey::generate(
                HostInferenceKeyId::parse("key:host-pending").unwrap(),
            )
            .public_key(),
        ) {
            Ok(HostRelayPollOutcome::Pending(receipt)) => {
                assert_eq!(receipt.task_id, "task-demo-1");
                assert_eq!(receipt.state, HostRelayTaskState::Queued);
            }
            _ => panic!("pending task must remain pending"),
        }
    }

    #[test]
    fn submits_opens_and_acknowledges_a_sealed_result_over_mock_transport() {
        let binding = binding();
        let client =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:client-1").unwrap());
        let host =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:host-1").unwrap());
        let request_payload = PrivatePayloadV1::new(
            &binding,
            HostInferenceDirection::Request,
            json!({"privatePrompt": "不得离开本机"}),
        )
        .unwrap();
        let result_payload = PrivatePayloadV1::new(
            &binding,
            HostInferenceDirection::Result,
            json!({"privateAnswer": "已经验证"}),
        )
        .unwrap();
        let result_envelope =
            seal_result(&binding, &host, &client.public_key(), &result_payload).unwrap();
        let result_response = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "taskId": "task-demo-1",
            "state": "RESULT_READY",
            "expiresAt": "2026-08-25T00:00:00Z",
            "resultEnvelope": result_envelope
        }))
        .unwrap();
        let transport = MockTransport::new(vec![
            HostRelayHttpResponse::new(201, receipt("QUEUED")),
            HostRelayHttpResponse::new(200, result_response),
            HostRelayHttpResponse::new(204, Vec::new()),
        ]);
        let relay = HostRelayClient::new(transport);

        let idempotency_key = HostRelayIdempotencyKey::new_random();
        let host_public_key = host.public_key();
        let submitted = relay
            .submit_request(HostRelaySubmission {
                bearer: token(),
                idempotency_key: &idempotency_key,
                binding: &binding,
                client_key: &client,
                host_key: &host_public_key,
                expires_at: "2026-08-24T00:15:00Z",
                payload: &request_payload,
            })
            .unwrap();
        assert_eq!(submitted.state, HostRelayTaskState::Queued);

        let opened = match relay.poll_task(token(), &binding).unwrap() {
            HostRelayPolledTask::ResultReady {
                task_id,
                expires_at,
                envelope,
            } => {
                assert_eq!(task_id, "task-demo-1");
                assert_eq!(expires_at, "2026-08-25T00:00:00Z");
                HostRelayPollOutcome::ResultReady(
                    open_result(&binding, &client, &host.public_key(), &envelope).unwrap(),
                )
            }
            HostRelayPolledTask::Pending(_) => panic!("fixture must provide a result"),
        };
        assert!(matches!(
            opened,
            HostRelayPollOutcome::ResultReady(value)
                if value.payload() == result_payload.payload()
        ));
        relay
            .ack_result(token(), &HostRelayIdempotencyKey::new_random(), &binding)
            .unwrap();

        let requests = relay.transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method(), HostRelayHttpMethod::Post);
        assert_eq!(requests[0].relative_path(), RELAY_ROOT);
        assert_eq!(
            requests[0].header("Authorization"),
            Some("Bearer account-token-not-serialized")
        );
        assert!(requests[0].header("Idempotency-Key").is_some());
        assert!(!String::from_utf8_lossy(&requests[0].body).contains("不得离开本机"));
        assert_eq!(requests[1].method(), HostRelayHttpMethod::Get);
        assert_eq!(
            requests[2].relative_path(),
            "/v1/intelligence/host-tasks/task-demo-1/ack"
        );
    }

    #[test]
    fn rejects_tampered_result_before_any_ack() {
        let binding = binding();
        let client =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:client-1").unwrap());
        let host =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:host-1").unwrap());
        let result_payload = PrivatePayloadV1::new(
            &binding,
            HostInferenceDirection::Result,
            json!({"privateAnswer": "验证"}),
        )
        .unwrap();
        let mut envelope =
            seal_result(&binding, &host, &client.public_key(), &result_payload).unwrap();
        envelope.ciphertext.replace_range(0..1, "A");
        let response = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "taskId": "task-demo-1",
            "state": "RESULT_READY",
            "expiresAt": "2026-08-25T00:00:00Z",
            "resultEnvelope": envelope
        }))
        .unwrap();
        let relay = HostRelayClient::new(MockTransport::new(vec![HostRelayHttpResponse::new(
            200, response,
        )]));

        assert!(matches!(
            relay.poll_and_open_result(token(), &binding, &client, &host.public_key()),
            Err(HostRelayClientError::Crypto(_))
        ));
        assert_eq!(relay.transport.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn cancel_requires_a_terminal_cancellation_state_and_never_places_task_in_url_query() {
        let binding = binding();
        let relay = HostRelayClient::new(MockTransport::new(vec![HostRelayHttpResponse::new(
            200,
            receipt("CANCELLED"),
        )]));
        let cancelled = relay
            .cancel_task(token(), &HostRelayIdempotencyKey::new_random(), &binding)
            .unwrap();
        assert_eq!(cancelled.state, HostRelayTaskState::Cancelled);
        let requests = relay.transport.requests.lock().unwrap();
        assert_eq!(
            requests[0].relative_path(),
            "/v1/intelligence/host-tasks/task-demo-1/cancel"
        );
        assert!(!requests[0].relative_path().contains('?'));
        assert!(requests[0].header("Authorization").is_some());
    }
}
