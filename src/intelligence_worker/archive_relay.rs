//! Outbound-only relay for temporary historical packages.
//!
//! This is deliberately a narrow publisher-host boundary: the worker polls a
//! configured HTTPS intelligence server, claims at most one archive job, reads
//! already archived public event revisions, persists one minimal package under
//! the permanent archive outbox, verifies its digest and uploads it.  It never
//! accepts inbound connections, starts a collector, or exposes archive content
//! through its process output.

use crate::atomic_file;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) const RELAY_BASE_URL_ENV: &str = "KUNPENG_INTELLIGENCE_RELAY_BASE_URL";
pub(crate) const RELAY_PUBLISHER_TOKEN_ENV: &str = "KUNPENG_INTELLIGENCE_RELAY_PUBLISHER_TOKEN";
const MAX_PACKAGE_BYTES: usize = 4 * 1024 * 1024;
const RELAY_WAIT_SECONDS: u8 = 25;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RelayConfiguration {
    base_url: String,
    publisher_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveSelector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    day: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    series_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RelayJob {
    schema_version: u8,
    job_id: String,
    kind: String,
    request_id: String,
    created_at: String,
    request: ArchiveSelector,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobsResponse {
    schema_version: u8,
    jobs: Vec<RelayJob>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRelayPackage {
    schema_version: u8,
    kind: &'static str,
    request: ArchiveSelector,
    events: Vec<ArchiveEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveEvent {
    event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    series_id: Option<String>,
    revision_no: i64,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    occurred_at: Option<String>,
    revision: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RelayOutcome {
    NotConfigured,
    Idle,
    Uploaded,
    NotFound,
    Failed,
    TerminalUnconfirmed,
    TransportUnavailable,
}

pub(crate) trait RelayTransport {
    fn jobs(&self, configuration: &RelayConfiguration) -> Result<Vec<RelayJob>, ()>;
    fn claim(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
    ) -> Result<RelayJob, ()>;
    fn upload(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
        bytes: &[u8],
        sha256: &str,
    ) -> Result<(), ()>;
    fn not_found(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
    ) -> Result<(), ()>;
    fn failed(&self, configuration: &RelayConfiguration, job_id: &str, key: &str)
        -> Result<(), ()>;
}

pub(crate) struct HttpsRelayTransport;

impl RelayTransport for HttpsRelayTransport {
    fn jobs(&self, configuration: &RelayConfiguration) -> Result<Vec<RelayJob>, ()> {
        let response = call(
            configuration,
            "GET",
            &format!("/v1/intelligence/publisher/jobs?wait={RELAY_WAIT_SECONDS}"),
            None,
            None,
        )?;
        let response: JobsResponse = serde_json::from_str(&response).map_err(|_| ())?;
        if response.schema_version != 1 || response.jobs.len() > 8 {
            return Err(());
        }
        for job in &response.jobs {
            validate_job(job)?;
        }
        Ok(response.jobs)
    }

    fn claim(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
    ) -> Result<RelayJob, ()> {
        let response = call(
            configuration,
            "POST",
            &format!("/v1/intelligence/publisher/jobs/{job_id}/claim"),
            Some(key),
            Some(serde_json::json!({})),
        )?;
        let job: RelayJob = serde_json::from_str(&response).map_err(|_| ())?;
        validate_job(&job)?;
        (job.job_id == job_id).then_some(job).ok_or(())
    }

    fn upload(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
        bytes: &[u8],
        sha256: &str,
    ) -> Result<(), ()> {
        if bytes.is_empty() || bytes.len() > MAX_PACKAGE_BYTES || sha256_hex(bytes) != sha256 {
            return Err(());
        }
        call(
            configuration,
            "POST",
            &format!("/v1/intelligence/publisher/jobs/{job_id}/content"),
            Some(key),
            Some(serde_json::json!({
                "contentBase64": STANDARD.encode(bytes),
                "contentSha256": sha256,
            })),
        )
        .map(|_| ())
    }

    fn not_found(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
    ) -> Result<(), ()> {
        terminal(configuration, job_id, key, "not-found")
    }

    fn failed(
        &self,
        configuration: &RelayConfiguration,
        job_id: &str,
        key: &str,
    ) -> Result<(), ()> {
        terminal(configuration, job_id, key, "failed")
    }
}

fn terminal(
    configuration: &RelayConfiguration,
    job_id: &str,
    key: &str,
    action: &str,
) -> Result<(), ()> {
    call(
        configuration,
        "POST",
        &format!("/v1/intelligence/publisher/jobs/{job_id}/{action}"),
        Some(key),
        Some(serde_json::json!({"reason":"archive_relay_v1"})),
    )
    .map(|_| ())
}

fn call(
    configuration: &RelayConfiguration,
    method: &str,
    suffix: &str,
    idempotency_key: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<String, ()> {
    if !suffix.starts_with('/') || suffix.contains('\r') || suffix.contains('\n') {
        return Err(());
    }
    let endpoint = format!("{}{}", configuration.base_url, suffix);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_recv_response(Some(Duration::from_secs(35)))
        .timeout_recv_body(Some(Duration::from_secs(35)))
        .build()
        .into();
    let authorization = format!("Bearer {}", configuration.publisher_token);
    let response = match (method, body) {
        ("GET", None) => {
            let mut request = agent.get(&endpoint).header("Authorization", &authorization);
            if let Some(key) = idempotency_key {
                request = request.header("Idempotency-Key", key);
            }
            request.call()
        }
        ("POST", Some(value)) => {
            let mut request = agent
                .post(&endpoint)
                .header("Content-Type", "application/json")
                .header("Authorization", &authorization);
            if let Some(key) = idempotency_key {
                request = request.header("Idempotency-Key", key);
            }
            request.send_json(value)
        }
        _ => return Err(()),
    }
    .map_err(|_| ())?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(());
    }
    response.into_body().read_to_string().map_err(|_| ())
}

pub(crate) fn configuration_from_parts(
    base_url: Option<&str>,
    publisher_token: Option<&str>,
) -> Option<RelayConfiguration> {
    let base_url = base_url?.trim().trim_end_matches('/');
    let publisher_token = publisher_token?.trim();
    if !is_safe_https_base_url(base_url)
        || publisher_token.is_empty()
        || publisher_token.len() > 4096
    {
        return None;
    }
    Some(RelayConfiguration {
        base_url: base_url.to_owned(),
        publisher_token: publisher_token.to_owned(),
    })
}

fn is_safe_https_base_url(value: &str) -> bool {
    value.starts_with("https://")
        && value.len() <= 2048
        && !value.contains('@')
        && !value.contains('?')
        && !value.contains('#')
        && !value.chars().any(char::is_whitespace)
        && value[8..].contains('.')
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_day(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn validate_selector(selector: &ArchiveSelector) -> Result<(), ()> {
    let count = usize::from(selector.day.is_some())
        + usize::from(selector.event_id.is_some())
        + usize::from(selector.series_id.is_some());
    if count != 1 {
        return Err(());
    }
    if let Some(day) = &selector.day {
        if !valid_day(day) {
            return Err(());
        }
    }
    if selector.event_id.as_deref().is_some_and(|id| !valid_id(id))
        || selector
            .series_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
    {
        return Err(());
    }
    Ok(())
}

fn validate_job(job: &RelayJob) -> Result<(), ()> {
    if job.schema_version != 1
        || job.kind != "archive_relay"
        || !valid_id(&job.job_id)
        || !valid_id(&job.request_id)
        || job.created_at.len() > 64
    {
        return Err(());
    }
    validate_selector(&job.request)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

enum PackageError {
    NotFound,
    Failed,
}

fn package_for_selector_at(
    catalog_path: &Path,
    selector: &ArchiveSelector,
) -> Result<Vec<u8>, PackageError> {
    validate_selector(selector).map_err(|_| PackageError::Failed)?;
    if !catalog_path.is_file() {
        return Err(PackageError::NotFound);
    }
    let connection = Connection::open_with_flags(catalog_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| PackageError::Failed)?;
    let mut events = Vec::new();
    let (query, parameter): (&str, &str) = if let Some(event_id) = selector.event_id.as_deref() {
        ("SELECT e.event_id,e.series_id,e.current_revision,e.title,e.occurred_at,COALESCE(r.revision_json,r.body) FROM intelligence_events e JOIN intelligence_event_revisions r ON r.event_id=e.event_id AND r.revision_no=e.current_revision WHERE e.event_id=?1", event_id)
    } else if let Some(series_id) = selector.series_id.as_deref() {
        ("SELECT e.event_id,e.series_id,e.current_revision,e.title,e.occurred_at,COALESCE(r.revision_json,r.body) FROM intelligence_events e JOIN intelligence_event_revisions r ON r.event_id=e.event_id AND r.revision_no=e.current_revision WHERE e.series_id=?1 ORDER BY COALESCE(e.occurred_at,''),e.event_id LIMIT 30", series_id)
    } else {
        ("SELECT e.event_id,e.series_id,e.current_revision,e.title,e.occurred_at,COALESCE(r.revision_json,r.body) FROM intelligence_events e JOIN intelligence_event_revisions r ON r.event_id=e.event_id AND r.revision_no=e.current_revision WHERE substr(COALESCE(e.occurred_at,''),1,10)=?1 ORDER BY e.event_id LIMIT 30", selector.day.as_deref().ok_or(PackageError::Failed)?)
    };
    let mut statement = connection
        .prepare(query)
        .map_err(|_| PackageError::Failed)?;
    let rows = statement
        .query_map(params![parameter], |row| {
            let revision: Option<String> = row.get(5)?;
            let revision = revision
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_else(|| serde_json::json!({"text": revision.unwrap_or_default()}));
            Ok(ArchiveEvent {
                event_id: row.get(0)?,
                series_id: row.get(1)?,
                revision_no: row.get(2)?,
                title: row.get(3)?,
                occurred_at: row.get(4)?,
                revision,
            })
        })
        .map_err(|_| PackageError::Failed)?;
    for row in rows {
        events.push(row.map_err(|_| PackageError::Failed)?);
    }
    if events.is_empty() {
        return Err(PackageError::NotFound);
    }
    let bytes = serde_json::to_vec(&ArchiveRelayPackage {
        schema_version: 1,
        kind: "archive_relay",
        request: selector.clone(),
        events,
    })
    .map_err(|_| PackageError::Failed)?;
    if bytes.is_empty() || bytes.len() > MAX_PACKAGE_BYTES {
        return Err(PackageError::Failed);
    }
    Ok(bytes)
}

fn persist_outbox_package(
    catalog_path: &Path,
    job_id: &str,
    bytes: &[u8],
    sha256: &str,
) -> Result<PathBuf, ()> {
    if !valid_id(job_id) || sha256_hex(bytes) != sha256 {
        return Err(());
    }
    let root = catalog_path.parent().ok_or(())?;
    let path = root
        .join("packages")
        .join("outbox")
        .join(outbox_file_name(job_id, sha256));
    atomic_file::write(&path, bytes).map_err(|_| ())?;
    (sha256_hex(&std::fs::read(&path).map_err(|_| ())?) == sha256)
        .then_some(path)
        .ok_or(())
}

/// The durable outbox is an internal retry/audit boundary, not a public
/// filename protocol.  Keep its deterministic name short: an isolated
/// Windows profile can otherwise exceed the legacy path limit once a UUID and
/// a 64-character package digest are appended to a long temporary root.
///
/// The 128-bit prefix is derived from both the job identity and the exact
/// package digest, so it remains stable across retries without exposing or
/// depending on the full server job identifier in the local path.
fn outbox_file_name(job_id: &str, sha256: &str) -> String {
    let identity = sha256_hex(format!("{job_id}\0{sha256}").as_bytes());
    format!("{}.json", &identity[..32])
}

pub(crate) fn execute_once<T: RelayTransport>(
    transport: &T,
    configuration: Option<&RelayConfiguration>,
    catalog_path: &Path,
) -> RelayOutcome {
    let Some(configuration) = configuration else {
        return RelayOutcome::NotConfigured;
    };
    let jobs = match transport.jobs(configuration) {
        Ok(jobs) => jobs,
        Err(()) => return RelayOutcome::TransportUnavailable,
    };
    let Some(candidate) = jobs.into_iter().next() else {
        return RelayOutcome::Idle;
    };
    let claim_key = format!("archive-relay-v1-{}-claim", candidate.job_id);
    let claimed = match transport.claim(configuration, &candidate.job_id, &claim_key) {
        Ok(job) => job,
        Err(()) => return RelayOutcome::TransportUnavailable,
    };
    let package = match package_for_selector_at(catalog_path, &claimed.request) {
        Ok(package) => package,
        Err(PackageError::NotFound) => {
            let key = format!("archive-relay-v1-{}-not-found", claimed.job_id);
            return if transport
                .not_found(configuration, &claimed.job_id, &key)
                .is_ok()
            {
                RelayOutcome::NotFound
            } else {
                RelayOutcome::TerminalUnconfirmed
            };
        }
        Err(PackageError::Failed) => {
            let key = format!("archive-relay-v1-{}-failed", claimed.job_id);
            return if transport
                .failed(configuration, &claimed.job_id, &key)
                .is_ok()
            {
                RelayOutcome::Failed
            } else {
                RelayOutcome::TerminalUnconfirmed
            };
        }
    };
    let sha256 = sha256_hex(&package);
    if persist_outbox_package(catalog_path, &claimed.job_id, &package, &sha256).is_err() {
        let key = format!("archive-relay-v1-{}-failed", claimed.job_id);
        return if transport
            .failed(configuration, &claimed.job_id, &key)
            .is_ok()
        {
            RelayOutcome::Failed
        } else {
            RelayOutcome::TerminalUnconfirmed
        };
    }
    let key = format!("archive-relay-v1-{}-{sha256}", claimed.job_id);
    if transport
        .upload(configuration, &claimed.job_id, &key, &package, &sha256)
        .is_ok()
    {
        RelayOutcome::Uploaded
    } else {
        let key = format!("archive-relay-v1-{}-failed", claimed.job_id);
        if transport
            .failed(configuration, &claimed.job_id, &key)
            .is_ok()
        {
            RelayOutcome::Failed
        } else {
            RelayOutcome::TerminalUnconfirmed
        }
    }
}

pub(crate) fn configured_from_environment() -> Option<RelayConfiguration> {
    configuration_from_parts(
        std::env::var(RELAY_BASE_URL_ENV).ok().as_deref(),
        std::env::var(RELAY_PUBLISHER_TOKEN_ENV).ok().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::{cell::RefCell, fs};

    #[derive(Default)]
    struct FakeTransport {
        jobs: Vec<RelayJob>,
        fail_upload: bool,
        calls: RefCell<Vec<String>>,
    }
    impl RelayTransport for FakeTransport {
        fn jobs(&self, _: &RelayConfiguration) -> Result<Vec<RelayJob>, ()> {
            Ok(self.jobs.clone())
        }
        fn claim(&self, _: &RelayConfiguration, job_id: &str, _: &str) -> Result<RelayJob, ()> {
            self.calls.borrow_mut().push("claim".into());
            self.jobs
                .iter()
                .find(|job| job.job_id == job_id)
                .cloned()
                .ok_or(())
        }
        fn upload(
            &self,
            _: &RelayConfiguration,
            _: &str,
            _: &str,
            bytes: &[u8],
            sha: &str,
        ) -> Result<(), ()> {
            self.calls.borrow_mut().push("upload".into());
            (sha256_hex(bytes) == sha && !self.fail_upload)
                .then_some(())
                .ok_or(())
        }
        fn not_found(&self, _: &RelayConfiguration, _: &str, _: &str) -> Result<(), ()> {
            self.calls.borrow_mut().push("not_found".into());
            Ok(())
        }
        fn failed(&self, _: &RelayConfiguration, _: &str, _: &str) -> Result<(), ()> {
            self.calls.borrow_mut().push("failed".into());
            Ok(())
        }
    }
    fn job(selector: ArchiveSelector) -> RelayJob {
        RelayJob {
            schema_version: 1,
            job_id: "job-1".into(),
            kind: "archive_relay".into(),
            request_id: "request-1".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            request: selector,
        }
    }
    fn config() -> RelayConfiguration {
        configuration_from_parts(Some("https://relay.example.test"), Some("publisher-secret"))
            .unwrap()
    }
    fn catalog() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("kunpeng-relay-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("catalog.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE intelligence_events(event_id TEXT PRIMARY KEY,series_id TEXT,title TEXT,occurred_at TEXT,current_revision INTEGER); CREATE TABLE intelligence_event_revisions(event_id TEXT,revision_no INTEGER,body TEXT,revision_json TEXT); INSERT INTO intelligence_events VALUES('event-1','series-1','事件','2026-08-20T01:00:00Z',1); INSERT INTO intelligence_event_revisions VALUES('event-1',1,'正文',NULL);").unwrap();
        (root, path)
    }
    #[test]
    fn relay_requires_explicit_https_server_and_secret() {
        assert!(configuration_from_parts(Some("http://127.0.0.1"), Some("secret")).is_none());
        assert!(
            configuration_from_parts(Some("https://relay.example.test"), Some("secret")).is_some()
        );
        assert!(
            configuration_from_parts(Some("https://user@relay.example.test"), Some("secret"))
                .is_none()
        );
    }
    #[test]
    fn relay_claims_archived_event_persists_and_uploads_hashed_package() {
        let (root, catalog) = catalog();
        let transport = FakeTransport {
            jobs: vec![job(ArchiveSelector {
                day: None,
                event_id: Some("event-1".into()),
                series_id: None,
            })],
            ..Default::default()
        };
        assert_eq!(
            execute_once(&transport, Some(&config()), &catalog),
            RelayOutcome::Uploaded
        );
        assert_eq!(transport.calls.borrow().as_slice(), ["claim", "upload"]);
        assert_eq!(
            fs::read_dir(root.join("packages/outbox")).unwrap().count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn outbox_filename_is_short_stable_and_bound_to_job_and_package() {
        let package = "a".repeat(64);
        let longest_job = "job-".to_owned() + &"z".repeat(124);
        let first = outbox_file_name(&longest_job, &package);
        assert_eq!(first, outbox_file_name(&longest_job, &package));
        assert_eq!(first.len(), 37);
        assert_ne!(first, outbox_file_name("job-other", &package));
        assert_ne!(first, outbox_file_name(&longest_job, &"b".repeat(64)));
    }
    #[test]
    fn relay_marks_missing_archive_as_not_found_without_uploading() {
        let (root, catalog) = catalog();
        let transport = FakeTransport {
            jobs: vec![job(ArchiveSelector {
                day: None,
                event_id: Some("missing".into()),
                series_id: None,
            })],
            ..Default::default()
        };
        assert_eq!(
            execute_once(&transport, Some(&config()), &catalog),
            RelayOutcome::NotFound
        );
        assert_eq!(transport.calls.borrow().as_slice(), ["claim", "not_found"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn relay_upload_failure_transitions_to_failed() {
        let (root, catalog) = catalog();
        let transport = FakeTransport {
            jobs: vec![job(ArchiveSelector {
                day: Some("2026-08-20".into()),
                event_id: None,
                series_id: None,
            })],
            fail_upload: true,
            ..Default::default()
        };
        assert_eq!(
            execute_once(&transport, Some(&config()), &catalog),
            RelayOutcome::Failed
        );
        assert_eq!(
            transport.calls.borrow().as_slice(),
            ["claim", "upload", "failed"]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
