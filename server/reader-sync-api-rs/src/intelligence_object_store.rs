//! S3-compatible object-store boundary for intelligence payloads.
//!
//! Request reads intentionally retain `PostgreSQL` bytea as their fallback.  The
//! injected adapter is consumed only by the reviewed durable dual-write worker.
//! It uses path-style S3 requests so `MinIO` works without DNS wildcard setup.
//! Object URLs are never returned to callers: the API remains the only proxy.

use std::{fmt::Write as _, net::IpAddr, sync::Arc, time::Duration};

use hmac::{Hmac, KeyInit, Mac};
use secrecy::ExposeSecret;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description};

use crate::config::{IntelligenceObjectStorageConfig, S3ObjectStorageConfig};

// Historical relay packages are bounded at 128 MiB.  The object boundary must
// accept that full verified package as well as the smaller publication image
// payloads; callers still impose their own endpoint-specific limits.
const MAX_OBJECT_BYTES: usize = 128 * 1024 * 1024;
const OBJECT_KEY_PREFIX: &str = "intelligence/";
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntelligenceObjectStoreStatus {
    /// Object storage is not configured. `PostgreSQL` remains authoritative.
    Disabled,
    /// A valid S3/MinIO client is injected into the durable outbox worker.
    Configured,
}

/// Stable safe errors. Do not add provider response bodies, URLs, headers, or
/// credentials: this type can cross process boundaries and be logged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntelligenceObjectStoreError {
    Disabled,
    InvalidConfiguration,
    InvalidObjectKey,
    InvalidRange,
    RequestFailed,
    UnexpectedResponse,
    ResponseTooLarge,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectRange {
    pub bytes: Vec<u8>,
    pub total_size: Option<u64>,
}

#[allow(clippy::missing_errors_doc)] // One stable error enum covers the backend operations below.
pub trait IntelligenceObjectStore: Send + Sync {
    fn status(&self) -> IntelligenceObjectStoreStatus;
    fn health(&self) -> Result<(), IntelligenceObjectStoreError>;
    fn put(&self, object_key: &str, bytes: &[u8]) -> Result<(), IntelligenceObjectStoreError>;
    fn get_range(
        &self,
        object_key: &str,
        start: u64,
        end_inclusive: Option<u64>,
    ) -> Result<ObjectRange, IntelligenceObjectStoreError>;
    fn delete(&self, object_key: &str) -> Result<(), IntelligenceObjectStoreError>;
}

/// Safe default used by every current request path.
#[derive(Clone, Copy, Debug, Default)]
pub struct DisabledIntelligenceObjectStore;

impl IntelligenceObjectStore for DisabledIntelligenceObjectStore {
    fn status(&self) -> IntelligenceObjectStoreStatus {
        IntelligenceObjectStoreStatus::Disabled
    }
    fn health(&self) -> Result<(), IntelligenceObjectStoreError> {
        Err(IntelligenceObjectStoreError::Disabled)
    }
    fn put(&self, _: &str, _: &[u8]) -> Result<(), IntelligenceObjectStoreError> {
        Err(IntelligenceObjectStoreError::Disabled)
    }
    fn get_range(
        &self,
        _: &str,
        _: u64,
        _: Option<u64>,
    ) -> Result<ObjectRange, IntelligenceObjectStoreError> {
        Err(IntelligenceObjectStoreError::Disabled)
    }
    fn delete(&self, _: &str) -> Result<(), IntelligenceObjectStoreError> {
        Err(IntelligenceObjectStoreError::Disabled)
    }
}

#[must_use]
pub fn status_for_config(
    config: &IntelligenceObjectStorageConfig,
) -> IntelligenceObjectStoreStatus {
    match config {
        IntelligenceObjectStorageConfig::Disabled => IntelligenceObjectStoreStatus::Disabled,
        IntelligenceObjectStorageConfig::S3(_) => IntelligenceObjectStoreStatus::Configured,
    }
}

/// Constructs the startup-injected adapter.  It is not called from request
/// handlers, so S3 creation and credentials never become a per-request path.
///
/// # Errors
///
/// Returns a stable configuration error when an enabled backend is invalid.
pub fn store_for_config(
    config: &IntelligenceObjectStorageConfig,
) -> Result<Box<dyn IntelligenceObjectStore>, IntelligenceObjectStoreError> {
    match config {
        IntelligenceObjectStorageConfig::Disabled => Ok(Box::new(DisabledIntelligenceObjectStore)),
        IntelligenceObjectStorageConfig::S3(config) => {
            Ok(Box::new(S3IntelligenceObjectStore::new(config)?))
        }
    }
}

#[derive(Clone)]
pub struct S3IntelligenceObjectStore {
    endpoint_base: String,
    host: String,
    region: String,
    bucket: String,
    access_key_id: secrecy::SecretString,
    secret_access_key: secrecy::SecretString,
    session_token: Option<secrecy::SecretString>,
    transport: Arc<dyn S3Transport>,
}

impl S3IntelligenceObjectStore {
    ///
    /// # Errors
    ///
    /// Returns a stable configuration error when the endpoint, bucket, or
    /// credentials cannot be used safely.
    pub fn new(config: &S3ObjectStorageConfig) -> Result<Self, IntelligenceObjectStoreError> {
        Self::with_transport(config, Arc::new(UreqS3Transport::new()))
    }

    fn with_transport(
        config: &S3ObjectStorageConfig,
        transport: Arc<dyn S3Transport>,
    ) -> Result<Self, IntelligenceObjectStoreError> {
        let (endpoint_base, host) = validate_endpoint(&config.endpoint)?;
        validate_bucket(&config.bucket)?;
        if config.region.is_empty() || config.region.len() > 128 {
            return Err(IntelligenceObjectStoreError::InvalidConfiguration);
        }
        Ok(Self {
            endpoint_base,
            host,
            region: config.region.clone(),
            bucket: config.bucket.clone(),
            access_key_id: config.access_key_id.clone(),
            secret_access_key: config.secret_access_key.clone(),
            session_token: config.session_token.clone(),
            transport,
        })
    }

    fn request(
        &self,
        method: HttpMethod,
        key: Option<&str>,
        body: Vec<u8>,
        range: Option<String>,
    ) -> Result<HttpResponse, IntelligenceObjectStoreError> {
        let object_path = match key {
            Some(key) => {
                validate_object_key(key)?;
                format!(
                    "/{}/{}",
                    percent_encode(&self.bucket),
                    percent_encode_path(key)
                )
            }
            None => format!("/{}/", percent_encode(&self.bucket)),
        };
        let url = format!("{}{}", self.endpoint_base, object_path);
        let now = OffsetDateTime::now_utc();
        let date_format = format_description::parse_borrowed::<2>("[year][month][day]")
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let timestamp_format =
            format_description::parse_borrowed::<2>("[year][month][day]T[hour][minute][second]Z")
                .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let date = now
            .format(&date_format)
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let timestamp = now
            .format(&timestamp_format)
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let payload_hash = sha256_hex(&body);
        let mut headers = vec![
            ("host".to_owned(), self.host.clone()),
            ("x-amz-content-sha256".to_owned(), payload_hash.clone()),
            ("x-amz-date".to_owned(), timestamp.clone()),
        ];
        if let Some(range) = range {
            headers.push(("range".to_owned(), range));
        }
        if let Some(token) = &self.session_token {
            headers.push((
                "x-amz-security-token".to_owned(),
                token.expose_secret().to_owned(),
            ));
        }
        headers.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        let canonical_headers = headers
            .iter()
            .fold(String::new(), |mut output, (name, value)| {
                writeln!(output, "{name}:{value}").expect("write to String");
                output
            });
        let signed_headers = headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(";");
        let canonical_request = format!(
            "{}\n{}\n\n{}\n{}\n{}",
            method.as_str(),
            object_path,
            canonical_headers,
            signed_headers,
            payload_hash,
        );
        let credential_scope = format!("{date}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
            sha256_hex(canonical_request.as_bytes()),
        );
        let signing_key = signing_key(
            self.secret_access_key.expose_secret().as_bytes(),
            &date,
            &self.region,
        )?;
        let signature = hex(&hmac_bytes(&signing_key, string_to_sign.as_bytes())?);
        headers.push((
            "authorization".to_owned(),
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
                self.access_key_id.expose_secret(),
            ),
        ));
        self.transport.send(HttpRequest {
            method,
            url,
            headers,
            body,
        })
    }
}

impl IntelligenceObjectStore for S3IntelligenceObjectStore {
    fn status(&self) -> IntelligenceObjectStoreStatus {
        IntelligenceObjectStoreStatus::Configured
    }

    fn health(&self) -> Result<(), IntelligenceObjectStoreError> {
        let response = self.request(HttpMethod::Head, None, Vec::new(), None)?;
        if (200..300).contains(&response.status) {
            Ok(())
        } else {
            Err(IntelligenceObjectStoreError::UnexpectedResponse)
        }
    }

    fn put(&self, object_key: &str, bytes: &[u8]) -> Result<(), IntelligenceObjectStoreError> {
        if bytes.len() > MAX_OBJECT_BYTES {
            return Err(IntelligenceObjectStoreError::ResponseTooLarge);
        }
        let response = self.request(HttpMethod::Put, Some(object_key), bytes.to_vec(), None)?;
        if (200..300).contains(&response.status) {
            Ok(())
        } else {
            Err(IntelligenceObjectStoreError::UnexpectedResponse)
        }
    }

    fn get_range(
        &self,
        object_key: &str,
        start: u64,
        end_inclusive: Option<u64>,
    ) -> Result<ObjectRange, IntelligenceObjectStoreError> {
        if end_inclusive.is_some_and(|end| end < start) {
            return Err(IntelligenceObjectStoreError::InvalidRange);
        }
        let range = match end_inclusive {
            Some(end) => format!("bytes={start}-{end}"),
            None => format!("bytes={start}-"),
        };
        let response = self.request(HttpMethod::Get, Some(object_key), Vec::new(), Some(range))?;
        if response.body.len() > MAX_OBJECT_BYTES {
            return Err(IntelligenceObjectStoreError::ResponseTooLarge);
        }
        if response.status != 206 && response.status != 200 {
            return Err(IntelligenceObjectStoreError::UnexpectedResponse);
        }
        let total_size = response.headers.iter().find_map(|(name, value)| {
            (name.eq_ignore_ascii_case("content-range"))
                .then(|| value.rsplit('/').next()?.parse().ok())
                .flatten()
        });
        Ok(ObjectRange {
            bytes: response.body,
            total_size,
        })
    }

    fn delete(&self, object_key: &str) -> Result<(), IntelligenceObjectStoreError> {
        let response = self.request(HttpMethod::Delete, Some(object_key), Vec::new(), None)?;
        if (200..300).contains(&response.status) || response.status == 404 {
            Ok(())
        } else {
            Err(IntelligenceObjectStoreError::UnexpectedResponse)
        }
    }
}

#[derive(Clone, Copy)]
enum HttpMethod {
    Get,
    Put,
    Delete,
    Head,
}
impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
        }
    }
}

struct HttpRequest {
    method: HttpMethod,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
trait S3Transport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, IntelligenceObjectStoreError>;
}

struct UreqS3Transport {
    agent: ureq::Agent,
}
impl UreqS3Transport {
    fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .https_only(false)
            .max_redirects(0)
            .proxy(None)
            .build()
            .into();
        Self { agent }
    }
}
impl S3Transport for UreqS3Transport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, IntelligenceObjectStoreError> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method.as_str())
            .uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let request = builder
            .body(request.body)
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let mut response = self
            .agent
            .run(request)
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_OBJECT_BYTES as u64)
            .read_to_vec()
            .map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(String, String), IntelligenceObjectStoreError> {
    let uri: ureq::http::Uri = endpoint
        .parse()
        .map_err(|_| IntelligenceObjectStoreError::InvalidConfiguration)?;
    let scheme = uri
        .scheme_str()
        .ok_or(IntelligenceObjectStoreError::InvalidConfiguration)?;
    let authority = uri
        .authority()
        .ok_or(IntelligenceObjectStoreError::InvalidConfiguration)?;
    if uri.query().is_some() {
        return Err(IntelligenceObjectStoreError::InvalidConfiguration);
    }
    let host = authority.as_str().to_owned();
    if scheme != "https" && !(scheme == "http" && is_loopback_host(authority.host())) {
        return Err(IntelligenceObjectStoreError::InvalidConfiguration);
    }
    let base_path = uri.path().trim_end_matches('/');
    Ok((format!("{scheme}://{host}{base_path}"), host))
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}
fn validate_bucket(bucket: &str) -> Result<(), IntelligenceObjectStoreError> {
    if !(3..=63).contains(&bucket.len())
        || bucket.starts_with('.')
        || bucket.ends_with('.')
        || bucket.contains("..")
        || !bucket.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
    {
        return Err(IntelligenceObjectStoreError::InvalidConfiguration);
    }
    Ok(())
}
fn validate_object_key(key: &str) -> Result<(), IntelligenceObjectStoreError> {
    if !(1..=1024).contains(&key.len())
        || !key.starts_with(OBJECT_KEY_PREFIX)
        || key.contains("//")
        || key
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err(IntelligenceObjectStoreError::InvalidObjectKey);
    }
    Ok(())
}
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                format!("{}", byte as char).into_bytes()
            } else {
                format!("%{byte:02X}").into_bytes()
            }
        })
        .map(char::from)
        .collect()
}
fn percent_encode_path(value: &str) -> String {
    value
        .split('/')
        .map(percent_encode)
        .collect::<Vec<_>>()
        .join("/")
}
fn sha256_hex(value: &[u8]) -> String {
    hex(&Sha256::digest(value))
}
fn hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len().saturating_mul(2));
    for byte in value {
        write!(output, "{byte:02x}").expect("write to String");
    }
    output
}
fn hmac_bytes(key: &[u8], value: &[u8]) -> Result<Vec<u8>, IntelligenceObjectStoreError> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|_| IntelligenceObjectStoreError::RequestFailed)?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}
fn signing_key(
    secret: &[u8],
    date: &str,
    region: &str,
) -> Result<Vec<u8>, IntelligenceObjectStoreError> {
    let mut key = b"AWS4".to_vec();
    key.extend_from_slice(secret);
    let date_key = hmac_bytes(&key, date.as_bytes())?;
    let region_key = hmac_bytes(&date_key, region.as_bytes())?;
    let service_key = hmac_bytes(&region_key, b"s3")?;
    hmac_bytes(&service_key, b"aws4_request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::SecretString;
    use std::sync::Mutex;

    struct RecordingTransport {
        response: HttpResponse,
        requests: Mutex<Vec<HttpRequest>>,
    }
    impl RecordingTransport {
        fn new(status: u16, headers: Vec<(&str, &str)>, body: &[u8]) -> Self {
            Self {
                response: HttpResponse {
                    status,
                    headers: headers
                        .into_iter()
                        .map(|(k, v)| (k.to_owned(), v.to_owned()))
                        .collect(),
                    body: body.to_vec(),
                },
                requests: Mutex::new(Vec::new()),
            }
        }
    }
    impl S3Transport for RecordingTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, IntelligenceObjectStoreError> {
            self.requests.lock().expect("lock").push(request);
            Ok(HttpResponse {
                status: self.response.status,
                headers: self.response.headers.clone(),
                body: self.response.body.clone(),
            })
        }
    }
    fn config() -> S3ObjectStorageConfig {
        S3ObjectStorageConfig {
            endpoint: "http://127.0.0.1:9000".to_owned(),
            region: "us-east-1".to_owned(),
            bucket: "intelligence-test".to_owned(),
            access_key_id: SecretString::from("test-access-key".to_owned()),
            secret_access_key: SecretString::from("test-secret-key".to_owned()),
            session_token: None,
        }
    }
    fn store(transport: Arc<RecordingTransport>) -> S3IntelligenceObjectStore {
        S3IntelligenceObjectStore::with_transport(&config(), transport).expect("store")
    }

    #[test]
    fn disabled_store_stably_rejects_all_operations() {
        let store = DisabledIntelligenceObjectStore;
        assert_eq!(store.status(), IntelligenceObjectStoreStatus::Disabled);
        assert_eq!(store.health(), Err(IntelligenceObjectStoreError::Disabled));
        assert_eq!(
            store.put("intelligence/a", b"x"),
            Err(IntelligenceObjectStoreError::Disabled)
        );
    }
    #[test]
    fn put_is_path_style_signed_and_credentials_do_not_leak_to_signature_material() {
        let transport = Arc::new(RecordingTransport::new(200, vec![], b""));
        let store = store(transport.clone());
        store
            .put("intelligence/assets/item-1.bin", b"hello")
            .expect("put");
        let requests = transport.requests.lock().expect("lock");
        let request = &requests[0];
        assert_eq!(
            request.url,
            "http://127.0.0.1:9000/intelligence-test/intelligence/assets/item-1.bin"
        );
        assert_eq!(request.method.as_str(), "PUT");
        assert_eq!(request.body, b"hello");
        let authorization = request
            .headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .expect("authorization")
            .1
            .as_str();
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential=test-access-key/"));
        assert!(!authorization.contains("test-secret-key"));
    }
    #[test]
    fn range_get_has_bounded_range_and_parses_total_without_urls() {
        let transport = Arc::new(RecordingTransport::new(
            206,
            vec![("content-range", "bytes 4-6/12")],
            b"abc",
        ));
        let store = store(transport.clone());
        let value = store
            .get_range("intelligence/archive/a.tar", 4, Some(6))
            .expect("get");
        assert_eq!(value.bytes, b"abc");
        assert_eq!(value.total_size, Some(12));
        let request = &transport.requests.lock().expect("lock")[0];
        assert!(
            request
                .headers
                .iter()
                .any(|(name, value)| name == "range" && value == "bytes=4-6")
        );
        assert_eq!(
            store.get_range("intelligence/archive/a.tar", 6, Some(4)),
            Err(IntelligenceObjectStoreError::InvalidRange)
        );
    }
    #[test]
    fn key_and_endpoint_guards_reject_escape_and_remote_plain_http() {
        let transport = Arc::new(RecordingTransport::new(200, vec![], b""));
        let store = store(transport);
        assert_eq!(
            store.delete("intelligence/../secrets"),
            Err(IntelligenceObjectStoreError::InvalidObjectKey)
        );
        let mut insecure = config();
        insecure.endpoint = "http://objects.example.invalid".to_owned();
        assert_eq!(
            S3IntelligenceObjectStore::new(&insecure).err(),
            Some(IntelligenceObjectStoreError::InvalidConfiguration)
        );
    }
    #[test]
    fn configured_s3_is_constructible_for_the_outbox_worker() {
        let config = IntelligenceObjectStorageConfig::S3(config());
        assert_eq!(
            status_for_config(&config),
            IntelligenceObjectStoreStatus::Configured
        );
        assert_eq!(
            store_for_config(&config).expect("configured").status(),
            IntelligenceObjectStoreStatus::Configured
        );
    }
}
