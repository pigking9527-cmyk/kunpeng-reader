//! Small synchronous HTTP transport primitives for the sync client.
//!
//! This module deliberately knows nothing about account lifecycle, SQLite,
//! endpoints' domain semantics, or retry policy. Callers keep ownership of
//! validation and map the typed `ureq::Error` into their existing Chinese UI
//! messages at the outer boundary.

use serde::de::DeserializeOwned;
use std::time::Duration;

pub(super) const SYNC_PROTOCOL_HEADER: &str = "X-Sync-Protocol-Version";
pub(super) const SYNC_PROTOCOL_VERSION: &str = "5";

pub(super) enum JsonRequestError {
    Request(ureq::Error),
    Decode(ureq::Error),
}

pub(super) fn agent_with_timeout(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into()
}

/// Sends one authenticated JSON request and decodes its response.
///
/// Every v5 sync endpoint, including metadata-only GET requests, requires the
/// protocol header. Authentication endpoints deliberately remain unchanged.
pub(super) fn authenticated_json<T: DeserializeOwned>(
    agent: &ureq::Agent,
    base: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> Result<T, JsonRequestError> {
    let mut response = if let Some(body) = body {
        let request = agent
            .post(&format!("{base}{path}"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        let request = if should_send_sync_protocol_header(path) {
            request.header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
        } else {
            request
        };
        request.send_json(body)
    } else {
        let request = agent
            .get(&format!("{base}{path}"))
            .header("Authorization", &format!("Bearer {token}"));
        let request = if should_send_sync_protocol_header(path) {
            request.header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
        } else {
            request
        };
        request.call()
    }
    .map_err(JsonRequestError::Request)?;
    response
        .body_mut()
        .read_json()
        .map_err(JsonRequestError::Decode)
}

fn should_send_sync_protocol_header(path: &str) -> bool {
    path.starts_with("/v1/sync/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_protocol_header_is_scoped_to_sync_paths() {
        assert_eq!(SYNC_PROTOCOL_HEADER, "X-Sync-Protocol-Version");
        assert_eq!(SYNC_PROTOCOL_VERSION, "5");
        assert!(should_send_sync_protocol_header("/v1/sync/pull"));
        assert!(should_send_sync_protocol_header("/v1/sync/inventory"));
        assert!(should_send_sync_protocol_header("/v1/sync/assets/example"));
        assert!(should_send_sync_protocol_header("/v1/sync/data/reset"));
        assert!(!should_send_sync_protocol_header(
            "/v1/auth/password/change"
        ));
        assert!(!should_send_sync_protocol_header("/v1/sync"));
    }
}
