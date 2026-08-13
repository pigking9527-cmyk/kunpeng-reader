//! Bounded retry policy for synchronous sync HTTP stages.
//!
//! This module owns only transient-error classification, telemetry and delay
//! calculation. Endpoint construction and sync protocol payloads stay in the
//! parent module so retry policy cannot change their meaning.

use super::{check_sync_control, TaskRunGuard, SYNC_REQUEST_ATTEMPTS};
use std::time::{Duration, Instant};

fn sync_error_retryable(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::StatusCode(code) => {
            matches!(*code, 408 | 425 | 429) || (500..=599).contains(code)
        }
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed
        | ureq::Error::Protocol(_) => true,
        _ => false,
    }
}

fn sync_error_class(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::StatusCode(429) => "http_429",
        ureq::Error::StatusCode(code) if (500..=599).contains(code) => "http_5xx",
        ureq::Error::StatusCode(_) => "http_4xx",
        ureq::Error::Timeout(_) => "timeout",
        ureq::Error::HostNotFound => "dns",
        ureq::Error::ConnectionFailed => "connection_failed",
        ureq::Error::Io(_) => "io",
        ureq::Error::Protocol(_) => "protocol",
        _ => "other",
    }
}

pub(super) fn sync_request_with_retry_delays<T>(
    stage: &str,
    task: Option<&TaskRunGuard>,
    retry_delays_ms: &[u64],
    mut request: impl FnMut() -> Result<T, ureq::Error>,
) -> Result<T, String> {
    let started = Instant::now();
    let attempts = SYNC_REQUEST_ATTEMPTS.min(retry_delays_ms.len().saturating_add(1));
    for attempt in 1..=attempts {
        check_sync_control(task)?;
        let attempt_started = Instant::now();
        match request() {
            Ok(value) => {
                if attempt > 1 {
                    crate::diagnostics::record_retry_recovered(
                        stage,
                        attempt as u64,
                        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    );
                }
                crate::log(&format!(
                    "[sync] stage={stage} attempt={attempt} elapsed_ms={} status=ok",
                    started.elapsed().as_millis()
                ));
                return Ok(value);
            }
            Err(error) => {
                let retry = attempt < attempts && sync_error_retryable(&error);
                let delay_ms = if retry {
                    retry_delay_with_jitter(retry_delays_ms[attempt - 1], attempt)
                } else {
                    0
                };
                crate::diagnostics::record_retry_failure(
                    stage,
                    attempt as u64,
                    u64::try_from(attempt_started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    sync_error_class(&error),
                    retry,
                    delay_ms,
                );
                crate::log(&format!(
                    "[sync] stage={stage} attempt={attempt} elapsed_ms={} retry={retry} error={error}",
                    started.elapsed().as_millis()
                ));
                if let Some(task) = task {
                    let _ = task.log(
                        crate::background_tasks::TaskLogLevel::Warning,
                        format!("{stage} 第 {attempt} 次请求失败：{error}"),
                    );
                }
                if !retry {
                    return Err(format!("{stage} 失败：{error}"));
                }
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn retry_delay_with_jitter(base_ms: u64, attempt: usize) -> u64 {
    // Stable per-process entropy is sufficient to prevent a fleet of clients
    // released or started together from retrying on the same millisecond.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::process::id().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    attempt.hash(&mut hasher);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    let jitter_window = (base_ms / 4).max(1);
    base_ms.saturating_add(hasher.finish() % jitter_window)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn retry_policy_retries_transient_errors_but_not_client_errors() {
        assert!(sync_error_retryable(&ureq::Error::StatusCode(429)));
        assert!(sync_error_retryable(&ureq::Error::StatusCode(503)));
        assert!(sync_error_retryable(&ureq::Error::HostNotFound));
        assert!(!sync_error_retryable(&ureq::Error::StatusCode(400)));
        assert!(!sync_error_retryable(&ureq::Error::StatusCode(401)));
    }

    #[test]
    fn request_retry_recovers_after_transient_failures_without_sleeping_in_tests() {
        let mut attempts = 0usize;
        let value = sync_request_with_retry_delays("test", None, &[0, 0], || {
            attempts += 1;
            if attempts < 3 {
                Err(ureq::Error::StatusCode(503))
            } else {
                Ok("ok")
            }
        })
        .unwrap();
        assert_eq!(value, "ok");
        assert_eq!(attempts, 3);
    }

    #[test]
    fn request_retry_stops_immediately_for_non_retryable_error() {
        let mut attempts = 0usize;
        let error = sync_request_with_retry_delays::<()>("test", None, &[0, 0], || {
            attempts += 1;
            Err(ureq::Error::StatusCode(401))
        })
        .unwrap_err();
        assert!(error.contains("401"));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn request_retry_recovers_from_a_scripted_transient_transport() {
        // A scripted transport checks the same 503 → 503 → success boundary
        // without binding a loopback port, which is prohibited in some test
        // environments.
        let mut responses = VecDeque::from([
            Err(ureq::Error::StatusCode(503)),
            Err(ureq::Error::StatusCode(503)),
            Ok("synced"),
        ]);
        let value = sync_request_with_retry_delays("integration-test", None, &[0, 0], || {
            responses.pop_front().expect("scripted transport response")
        })
        .unwrap();

        assert_eq!(value, "synced");
        assert!(responses.is_empty());
    }
}
