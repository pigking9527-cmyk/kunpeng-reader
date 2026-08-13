//! Bounded, redacted runtime diagnostics for support exports.
//!
//! Only fixed internal labels and numeric measurements are retained here. Raw
//! SQL, URLs, credentials, book identifiers and book text must never enter this
//! store.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const SCHEMA_VERSION: u32 = 2;
const SLOW_DB_TIMING_MS: u64 = 250;
const MAX_RECENT_SLOW_DB_TIMINGS: usize = 64;
const MAX_RECENT_RETRIES: usize = 64;
const MAX_RECENT_SYNC_STAGES: usize = 96;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct DiagnosticCounters {
    pub(crate) db_lock_acquisitions_total: u64,
    pub(crate) db_lock_wait_ms_total: u64,
    pub(crate) db_slow_lock_waits_total: u64,
    pub(crate) db_locked_accesses_total: u64,
    pub(crate) db_locked_access_ms_total: u64,
    pub(crate) db_slow_locked_accesses_total: u64,
    pub(crate) db_sql_operations_total: u64,
    pub(crate) db_sql_elapsed_ms_total: u64,
    pub(crate) db_slow_sql_operations_total: u64,
    pub(crate) sync_retry_failures_total: u64,
    pub(crate) sync_retries_scheduled_total: u64,
    pub(crate) sync_retries_exhausted_total: u64,
    pub(crate) sync_retry_recoveries_total: u64,
    pub(crate) sync_stage_samples_total: u64,
    pub(crate) sync_stage_failures_total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DbTimingKind {
    LockWait,
    LockedAccess,
    SqlOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SlowDbTimingDiagnostic {
    sequence: u64,
    at_ms: u64,
    kind: DbTimingKind,
    operation: String,
    elapsed_ms: u64,
    rows: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RetryOutcome {
    Scheduled,
    Exhausted,
    Recovered,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RetryDiagnostic {
    sequence: u64,
    at_ms: u64,
    stage: String,
    attempt: u64,
    elapsed_ms: u64,
    outcome: RetryOutcome,
    error_class: String,
    delay_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SyncStageDiagnostic {
    sequence: u64,
    at_ms: u64,
    stage: String,
    elapsed_ms: u64,
    success: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RuntimeDiagnostics {
    schema_version: u32,
    generated_at_ms: u64,
    counters: DiagnosticCounters,
    recent_slow_db_timings: Vec<SlowDbTimingDiagnostic>,
    recent_retries: Vec<RetryDiagnostic>,
    recent_sync_stages: Vec<SyncStageDiagnostic>,
}

#[derive(Default)]
struct DiagnosticsState {
    next_sequence: u64,
    counters: DiagnosticCounters,
    slow_db_timings: VecDeque<SlowDbTimingDiagnostic>,
    retries: VecDeque<RetryDiagnostic>,
    sync_stages: VecDeque<SyncStageDiagnostic>,
}

struct RetryFailureSample<'a> {
    stage: &'a str,
    attempt: u64,
    elapsed_ms: u64,
    error_class: &'a str,
    retry_scheduled: bool,
    delay_ms: u64,
    at_ms: u64,
}

fn push_bounded<T>(queue: &mut VecDeque<T>, value: T, limit: usize) {
    if queue.len() == limit {
        queue.pop_front();
    }
    queue.push_back(value);
}

fn safe_label(value: &str) -> String {
    let value = value.trim();
    if !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        value.to_string()
    } else {
        "other".to_string()
    }
}

impl DiagnosticsState {
    fn next_sequence(&mut self) -> u64 {
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.next_sequence
    }

    fn record_db_timing(
        &mut self,
        kind: DbTimingKind,
        operation: &str,
        elapsed_ms: u64,
        rows: u64,
        at_ms: u64,
    ) {
        let slow = elapsed_ms >= SLOW_DB_TIMING_MS;
        match kind {
            DbTimingKind::LockWait => {
                self.counters.db_lock_acquisitions_total =
                    self.counters.db_lock_acquisitions_total.saturating_add(1);
                self.counters.db_lock_wait_ms_total = self
                    .counters
                    .db_lock_wait_ms_total
                    .saturating_add(elapsed_ms);
                if slow {
                    self.counters.db_slow_lock_waits_total =
                        self.counters.db_slow_lock_waits_total.saturating_add(1);
                }
            }
            DbTimingKind::LockedAccess => {
                self.counters.db_locked_accesses_total =
                    self.counters.db_locked_accesses_total.saturating_add(1);
                self.counters.db_locked_access_ms_total = self
                    .counters
                    .db_locked_access_ms_total
                    .saturating_add(elapsed_ms);
                if slow {
                    self.counters.db_slow_locked_accesses_total = self
                        .counters
                        .db_slow_locked_accesses_total
                        .saturating_add(1);
                }
            }
            DbTimingKind::SqlOperation => {
                self.counters.db_sql_operations_total =
                    self.counters.db_sql_operations_total.saturating_add(1);
                self.counters.db_sql_elapsed_ms_total = self
                    .counters
                    .db_sql_elapsed_ms_total
                    .saturating_add(elapsed_ms);
                if slow {
                    self.counters.db_slow_sql_operations_total =
                        self.counters.db_slow_sql_operations_total.saturating_add(1);
                }
            }
        }
        if !slow {
            return;
        }
        let sequence = self.next_sequence();
        push_bounded(
            &mut self.slow_db_timings,
            SlowDbTimingDiagnostic {
                sequence,
                at_ms,
                kind,
                operation: safe_label(operation),
                elapsed_ms,
                rows,
            },
            MAX_RECENT_SLOW_DB_TIMINGS,
        );
    }

    fn record_retry_failure(&mut self, sample: RetryFailureSample<'_>) {
        self.counters.sync_retry_failures_total =
            self.counters.sync_retry_failures_total.saturating_add(1);
        let outcome = if sample.retry_scheduled {
            self.counters.sync_retries_scheduled_total =
                self.counters.sync_retries_scheduled_total.saturating_add(1);
            RetryOutcome::Scheduled
        } else {
            self.counters.sync_retries_exhausted_total =
                self.counters.sync_retries_exhausted_total.saturating_add(1);
            RetryOutcome::Exhausted
        };
        let sequence = self.next_sequence();
        push_bounded(
            &mut self.retries,
            RetryDiagnostic {
                sequence,
                at_ms: sample.at_ms,
                stage: safe_label(sample.stage),
                attempt: sample.attempt,
                elapsed_ms: sample.elapsed_ms,
                outcome,
                error_class: safe_label(sample.error_class),
                delay_ms: if sample.retry_scheduled {
                    sample.delay_ms
                } else {
                    0
                },
            },
            MAX_RECENT_RETRIES,
        );
    }

    fn record_retry_recovered(&mut self, stage: &str, attempt: u64, elapsed_ms: u64, at_ms: u64) {
        self.counters.sync_retry_recoveries_total =
            self.counters.sync_retry_recoveries_total.saturating_add(1);
        let sequence = self.next_sequence();
        push_bounded(
            &mut self.retries,
            RetryDiagnostic {
                sequence,
                at_ms,
                stage: safe_label(stage),
                attempt,
                elapsed_ms,
                outcome: RetryOutcome::Recovered,
                error_class: "none".to_string(),
                delay_ms: 0,
            },
            MAX_RECENT_RETRIES,
        );
    }

    fn record_sync_stage(&mut self, stage: &str, elapsed_ms: u64, success: bool, at_ms: u64) {
        self.counters.sync_stage_samples_total =
            self.counters.sync_stage_samples_total.saturating_add(1);
        if !success {
            self.counters.sync_stage_failures_total =
                self.counters.sync_stage_failures_total.saturating_add(1);
        }
        let sequence = self.next_sequence();
        push_bounded(
            &mut self.sync_stages,
            SyncStageDiagnostic {
                sequence,
                at_ms,
                stage: safe_label(stage),
                elapsed_ms,
                success,
            },
            MAX_RECENT_SYNC_STAGES,
        );
    }

    fn snapshot(&self, generated_at_ms: u64) -> RuntimeDiagnostics {
        RuntimeDiagnostics {
            schema_version: SCHEMA_VERSION,
            generated_at_ms,
            counters: self.counters.clone(),
            recent_slow_db_timings: self.slow_db_timings.iter().cloned().collect(),
            recent_retries: self.retries.iter().cloned().collect(),
            recent_sync_stages: self.sync_stages.iter().cloned().collect(),
        }
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

fn state() -> &'static Mutex<DiagnosticsState> {
    static STATE: OnceLock<Mutex<DiagnosticsState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(DiagnosticsState::default()))
}

fn with_state<T>(operation: impl FnOnce(&mut DiagnosticsState) -> T) -> T {
    let mut state = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut state)
}

fn record_db_timing(kind: DbTimingKind, operation: &str, elapsed_ms: u64, rows: u64) {
    with_state(|state| state.record_db_timing(kind, operation, elapsed_ms, rows, crate::now_ms()));
}

/// Records time spent waiting to acquire the single SQLite connection mutex.
/// This deliberately excludes query execution time.
pub(crate) fn record_db_lock_wait(operation: &str, elapsed_ms: u64) {
    record_db_timing(DbTimingKind::LockWait, operation, elapsed_ms, 0);
}

/// Records total time in a `with_db_read` or `with_db_write` callback. This
/// is a lock-hold interval, not a claim about SQL-only execution time.
pub(crate) fn record_db_locked_access(operation: &str, elapsed_ms: u64) {
    record_db_timing(DbTimingKind::LockedAccess, operation, elapsed_ms, 0);
}

/// Records a measured `AppDb` SQL operation. Callers measure from immediately
/// before preparing/executing the operation through collecting its result.
pub(crate) fn record_db_sql_operation(operation: &str, elapsed_ms: u64, rows: u64) {
    record_db_timing(DbTimingKind::SqlOperation, operation, elapsed_ms, rows);
}

pub(crate) fn record_retry_failure(
    stage: &str,
    attempt: u64,
    elapsed_ms: u64,
    error_class: &str,
    retry_scheduled: bool,
    delay_ms: u64,
) {
    with_state(|state| {
        state.record_retry_failure(RetryFailureSample {
            stage,
            attempt,
            elapsed_ms,
            error_class,
            retry_scheduled,
            delay_ms,
            at_ms: crate::now_ms(),
        })
    });
}

pub(crate) fn record_retry_recovered(stage: &str, attempt: u64, elapsed_ms: u64) {
    with_state(|state| state.record_retry_recovered(stage, attempt, elapsed_ms, crate::now_ms()));
}

pub(crate) fn record_sync_stage(stage: &str, elapsed_ms: u64, success: bool) {
    with_state(|state| state.record_sync_stage(stage, elapsed_ms, success, crate::now_ms()));
}

pub(crate) fn snapshot() -> RuntimeDiagnostics {
    with_state(|state| state.snapshot(crate::now_ms()))
}

pub(crate) fn clear() -> RuntimeDiagnostics {
    with_state(|state| {
        state.clear();
        state.snapshot(crate::now_ms())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_diagnostics_are_bounded_and_keep_lifetime_counts() {
        let mut state = DiagnosticsState::default();
        for index in 0..(MAX_RECENT_SLOW_DB_TIMINGS + 5) {
            state.record_db_timing(
                DbTimingKind::SqlOperation,
                "import_sync_page",
                300,
                index as u64,
                index as u64,
            );
        }
        let snapshot = state.snapshot(100);
        assert_eq!(snapshot.counters.db_sql_operations_total, 69);
        assert_eq!(snapshot.counters.db_slow_sql_operations_total, 69);
        assert_eq!(
            snapshot.recent_slow_db_timings.len(),
            MAX_RECENT_SLOW_DB_TIMINGS
        );
        assert_eq!(snapshot.recent_slow_db_timings[0].rows, 5);
        assert_eq!(
            snapshot.recent_slow_db_timings[0].kind,
            DbTimingKind::SqlOperation
        );
    }

    #[test]
    fn database_timing_kinds_keep_wait_sql_and_lock_hold_separate() {
        let mut state = DiagnosticsState::default();
        state.record_db_timing(DbTimingKind::LockWait, "sync_pull", 251, 0, 1);
        state.record_db_timing(DbTimingKind::LockedAccess, "sync_pull", 30, 0, 2);
        state.record_db_timing(DbTimingKind::SqlOperation, "sync_pull", 12, 4, 3);

        let snapshot = state.snapshot(4);
        assert_eq!(snapshot.counters.db_lock_acquisitions_total, 1);
        assert_eq!(snapshot.counters.db_lock_wait_ms_total, 251);
        assert_eq!(snapshot.counters.db_slow_lock_waits_total, 1);
        assert_eq!(snapshot.counters.db_locked_accesses_total, 1);
        assert_eq!(snapshot.counters.db_locked_access_ms_total, 30);
        assert_eq!(snapshot.counters.db_slow_locked_accesses_total, 0);
        assert_eq!(snapshot.counters.db_sql_operations_total, 1);
        assert_eq!(snapshot.counters.db_sql_elapsed_ms_total, 12);
        assert_eq!(snapshot.counters.db_slow_sql_operations_total, 0);
        assert_eq!(snapshot.recent_slow_db_timings.len(), 1);
        assert_eq!(
            snapshot.recent_slow_db_timings[0].kind,
            DbTimingKind::LockWait
        );
    }

    #[test]
    fn arbitrary_labels_are_replaced_instead_of_leaking_secrets() {
        let mut state = DiagnosticsState::default();
        state.record_db_timing(
            DbTimingKind::SqlOperation,
            "book:/private/library.epub",
            300,
            1,
            0,
        );
        state.record_retry_failure(RetryFailureSample {
            stage: "pull Bearer private-token",
            attempt: 1,
            elapsed_ms: 5,
            error_class: "https://reader.invalid/?token=private-token",
            retry_scheduled: false,
            delay_ms: 0,
            at_ms: 1,
        });
        let json = serde_json::to_string(&state.snapshot(2)).unwrap();
        assert!(!json.contains("private-token"));
        assert!(!json.contains("private/library.epub"));
        assert!(!json.contains("reader.invalid"));
        assert!(json.contains("\"kind\":\"sql_operation\""));
        assert!(json.contains("\"operation\":\"other\""));
        assert!(json.contains("\"stage\":\"other\""));
        assert!(json.contains("\"error_class\":\"other\""));
    }

    #[test]
    fn snapshot_schema_is_stable_and_clear_resets_all_history() {
        let mut state = DiagnosticsState::default();
        state.record_sync_stage("sync_total", 42, false, 1);
        state.record_retry_recovered("pull", 2, 12, 2);
        let value = serde_json::to_value(state.snapshot(3)).unwrap();
        assert_eq!(value["schema_version"], 2);
        assert_eq!(value["generated_at_ms"], 3);
        assert!(value.get("counters").is_some());
        assert!(value.get("recent_slow_db_timings").is_some());
        assert!(value.get("recent_retries").is_some());
        assert!(value.get("recent_sync_stages").is_some());

        state.clear();
        let cleared = state.snapshot(4);
        assert_eq!(cleared.counters, DiagnosticCounters::default());
        assert!(cleared.recent_retries.is_empty());
        assert!(cleared.recent_sync_stages.is_empty());
    }
}
