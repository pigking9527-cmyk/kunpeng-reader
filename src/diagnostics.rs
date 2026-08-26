//! Bounded, redacted runtime diagnostics for support exports.
//!
//! Only fixed internal labels and numeric measurements are retained here. Raw
//! SQL, URLs, credentials, book identifiers and book text must never enter this
//! store.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, OnceLock};

const SCHEMA_VERSION: u32 = 3;
const SLOW_DB_TIMING_MS: u64 = 250;
const MAX_RECENT_SLOW_DB_TIMINGS: usize = 64;
const MAX_RECENT_RETRIES: usize = 64;
const MAX_RECENT_SYNC_STAGES: usize = 96;
const MAX_RECENT_NATIVE_EVENTS: usize = 192;
const ALLOWED_NATIVE_FIELDS: &[&str] = &[
    "phase",
    "stage",
    "outcome",
    "source",
    "status",
    "reason",
    "kind",
    "mode",
    "backend",
    "result",
    "error_class",
    "operation",
    "elapsed_ms",
    "duration_ms",
    "count",
    "attempt",
    "delay_ms",
    "rows",
    "bytes",
    "ok",
    "success",
    "total",
    "indexed",
    "skipped",
    "removed",
    "disk_mb",
    "pending",
    "changed",
    "caught_up",
    "fallback",
    "target_bytes",
    "shown",
    "restored",
    "taskbar",
    "window_focused",
    "window_requested",
    "native_focused",
    "webview_requested",
    "webview_focused",
    "visible",
    "bound",
    "registered",
    "pool_ready",
    "engine_ready",
    "geometry_available",
    "requested_available",
    "maximized",
    "minimized",
    "x",
    "y",
    "width",
    "height",
    "inner_width",
    "inner_height",
    "frame_width",
    "frame_height",
    "requested_x",
    "requested_y",
    "requested_width",
    "requested_height",
    "scale_milli",
];

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
    pub(crate) native_events_total: u64,
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
#[serde(untagged)]
enum NativeDiagnosticValue {
    Boolean(bool),
    Integer(i64),
    Label(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct NativeEventDiagnostic {
    sequence: u64,
    at_ms: u64,
    component: String,
    event: String,
    fields: BTreeMap<String, NativeDiagnosticValue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RuntimeDiagnostics {
    schema_version: u32,
    generated_at_ms: u64,
    counters: DiagnosticCounters,
    recent_slow_db_timings: Vec<SlowDbTimingDiagnostic>,
    recent_retries: Vec<RetryDiagnostic>,
    recent_sync_stages: Vec<SyncStageDiagnostic>,
    recent_native_events: Vec<NativeEventDiagnostic>,
}

#[derive(Default)]
struct DiagnosticsState {
    next_sequence: u64,
    counters: DiagnosticCounters,
    slow_db_timings: VecDeque<SlowDbTimingDiagnostic>,
    retries: VecDeque<RetryDiagnostic>,
    sync_stages: VecDeque<SyncStageDiagnostic>,
    native_events: VecDeque<NativeEventDiagnostic>,
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

fn native_component(source_file: &str) -> String {
    let normalized = source_file.replace('\\', "/");
    let mut parts = normalized.rsplit('/');
    let file = parts.next().unwrap_or_default().trim_end_matches(".rs");
    let parent = parts.next().unwrap_or_default();
    let candidate = if parent.is_empty() || parent == "src" {
        file.to_string()
    } else {
        format!("{parent}_{file}")
    };
    safe_label(&candidate)
}

fn safe_native_label(value: &str) -> Option<String> {
    let candidate = value
        .trim()
        .trim_matches(|character: char| matches!(character, '[' | ']' | ':' | ',' | ';'));
    let is_internal_label = !candidate.is_empty()
        && candidate.len() <= 48
        && candidate.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        })
        && (candidate.contains('_')
            || candidate.contains('-')
            || matches!(
                candidate,
                "startup"
                    | "shutdown"
                    | "sync"
                    | "index"
                    | "window"
                    | "open"
                    | "close"
                    | "start"
                    | "end"
                    | "ok"
                    | "failed"
                    | "ready"
                    | "built"
                    | "skipped"
                    | "paused"
                    | "deferred"
                    | "scheduled"
                    | "activated"
                    | "received"
                    | "recovered"
                    | "background"
                    | "foreground"
                    | "focused"
                    | "incremental"
                    | "manual"
                    | "lazy"
            ));
    is_internal_label.then(|| candidate.to_string())
}

fn native_event(message: &str) -> String {
    message
        .split_ascii_whitespace()
        .next()
        .and_then(safe_native_label)
        .unwrap_or_else(|| "native_event".to_string())
}

fn native_fields(message: &str) -> BTreeMap<String, NativeDiagnosticValue> {
    let mut fields = BTreeMap::new();
    let tokens: Vec<&str> = message.split_ascii_whitespace().take(32).collect();
    let bracketed_category = tokens
        .first()
        .is_some_and(|token| token.starts_with('[') && token.ends_with(']'));
    let positional_start = 1;
    if bracketed_category {
        if let Some(operation) = tokens
            .get(positional_start)
            .and_then(|value| safe_native_label(value))
        {
            fields.insert(
                "operation".to_string(),
                NativeDiagnosticValue::Label(operation),
            );
        }
        if let Some(phase) = tokens
            .get(positional_start + 1)
            .and_then(|value| safe_native_label(value))
        {
            fields.insert("phase".to_string(), NativeDiagnosticValue::Label(phase));
        }
    } else if let Some(phase) = tokens.get(1).and_then(|value| safe_native_label(value)) {
        fields.insert("phase".to_string(), NativeDiagnosticValue::Label(phase));
    }

    for &token in tokens.iter().skip(1) {
        if let Some(milliseconds) = token
            .strip_suffix("ms")
            .and_then(|value| value.parse::<i64>().ok())
        {
            if (0..=1_000_000_000_000).contains(&milliseconds) {
                fields
                    .entry("elapsed_ms".to_string())
                    .or_insert(NativeDiagnosticValue::Integer(milliseconds));
            }
            continue;
        }
        let Some((raw_key, raw_value)) = token.split_once('=') else {
            continue;
        };
        let key = raw_key
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '_');
        if !ALLOWED_NATIVE_FIELDS.contains(&key) {
            continue;
        }
        let value = raw_value.trim_matches(|character: char| {
            matches!(character, ',' | ';' | '[' | ']' | '(' | ')' | '"' | '\'')
        });
        let parsed = match value {
            "true" => Some(NativeDiagnosticValue::Boolean(true)),
            "false" => Some(NativeDiagnosticValue::Boolean(false)),
            _ => value
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite() && number.abs() <= 1_000_000_000_000.0)
                .map(|number| NativeDiagnosticValue::Integer(number.round() as i64))
                .or_else(|| safe_native_label(value).map(NativeDiagnosticValue::Label)),
        };
        if let Some(parsed) = parsed {
            fields.insert(key.to_string(), parsed);
        }
    }
    fields
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

    fn record_native_log(&mut self, source_file: &str, message: &str, at_ms: u64) {
        self.counters.native_events_total = self.counters.native_events_total.saturating_add(1);
        let sequence = self.next_sequence();
        push_bounded(
            &mut self.native_events,
            NativeEventDiagnostic {
                sequence,
                at_ms,
                component: native_component(source_file),
                event: native_event(message),
                fields: native_fields(message),
            },
            MAX_RECENT_NATIVE_EVENTS,
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
            recent_native_events: self.native_events.iter().cloned().collect(),
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

/// Converts a legacy native log call into one bounded, structured diagnostic.
/// The original message is deliberately discarded: only the caller component,
/// a code-controlled event label, allowlisted fields and numeric timings remain.
pub(crate) fn record_native_log(source_file: &str, message: &str) {
    with_state(|state| state.record_native_log(source_file, message, crate::now_ms()));
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
    fn native_log_is_structured_bounded_and_discards_raw_sensitive_text() {
        let mut state = DiagnosticsState::default();
        for index in 0..(MAX_RECENT_NATIVE_EVENTS + 3) {
            state.record_native_log(
                "src/window_commands.rs",
                &format!(
                    "reader_window phase=open outcome=ok elapsed_ms={index} path=C:\\private\\book.epub token=secret https://reader.invalid/private"
                ),
                index as u64,
            );
        }
        let snapshot = state.snapshot(999);
        assert_eq!(snapshot.counters.native_events_total, 195);
        assert_eq!(
            snapshot.recent_native_events.len(),
            MAX_RECENT_NATIVE_EVENTS
        );
        assert_eq!(snapshot.recent_native_events[0].at_ms, 3);
        assert_eq!(
            snapshot.recent_native_events[0].component,
            "window_commands"
        );
        assert_eq!(snapshot.recent_native_events[0].event, "reader_window");
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"phase\":\"open\""));
        assert!(json.contains("\"outcome\":\"ok\""));
        assert!(!json.contains("private"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("reader.invalid"));
        assert!(!json.contains("path"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn native_log_rejects_free_form_event_and_field_values() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "C:\\Users\\someone\\src\\ai_reader.rs",
            "用户书名 error=https://private.invalid reason=C:\\private\\book.epub status=ready",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let event = &value["recent_native_events"][0];
        assert_eq!(event["component"], "ai_reader");
        assert_eq!(event["event"], "native_event");
        assert_eq!(event["fields"]["status"], "ready");
        assert!(event["fields"].get("reason").is_none());
        let json = value.to_string();
        assert!(!json.contains("用户书名"));
        assert!(!json.contains("private.invalid"));
        assert!(!json.contains("private\\\\book.epub"));
    }

    #[test]
    fn reader_binding_diagnostics_keep_only_fixed_role_and_boolean_state() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/epub_runtime.rs",
            "reader_book_info phase=binding_lookup outcome=binding_unbound kind=preload_pool bound=false visible=true registered=false label=reader-private path=C:\\private\\book.epub",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let serialized = value.to_string();
        assert!(serialized.contains("reader_book_info"));
        assert!(serialized.contains("preload_pool"));
        assert!(serialized.contains("binding_unbound"));
        assert!(serialized.contains("\"bound\":false"));
        assert!(serialized.contains("\"registered\":false"));
        assert!(!serialized.contains("reader-private"));
        assert!(!serialized.contains("book.epub"));
    }

    #[test]
    fn reader_reveal_keeps_only_window_activation_booleans() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/window_commands.rs",
            "reader_reveal outcome=focused shown=true restored=true taskbar=true window_focused=true native_focused=false webview_focused=true visible=true title=private",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let fields = &value["recent_native_events"][0]["fields"];
        assert_eq!(fields["outcome"], "focused");
        assert_eq!(fields["shown"], true);
        assert_eq!(fields["native_focused"], false);
        assert_eq!(fields["webview_focused"], true);
        assert_eq!(fields["visible"], true);
        assert!(fields.get("title").is_none());
    }

    #[test]
    fn reader_geometry_keeps_only_bounded_numeric_window_evidence() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/window_commands.rs",
            "reader_geometry phase=geometry_observed source=same_book outcome=after_250ms geometry_available=true requested_available=true x=196 y=196 width=1786 height=1535 inner_width=1760 inner_height=1520 frame_width=26 frame_height=15 requested_x=196 requested_y=196 requested_width=1786 requested_height=1535 scale_milli=2000 maximized=false minimized=false title=private path=C:\\private\\book.epub",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let event = &value["recent_native_events"][0];
        assert_eq!(event["event"], "reader_geometry");
        let fields = &event["fields"];
        assert_eq!(fields["phase"], "geometry_observed");
        assert_eq!(fields["source"], "same_book");
        assert_eq!(fields["width"], 1786);
        assert_eq!(fields["inner_width"], 1760);
        assert_eq!(fields["frame_width"], 26);
        assert_eq!(fields["scale_milli"], 2000);
        assert_eq!(fields["maximized"], false);
        assert!(fields.get("title").is_none());
        assert!(fields.get("path").is_none());
        let json = value.to_string();
        assert!(!json.contains("private"));
        assert!(!json.contains("book.epub"));
    }

    #[test]
    fn main_geometry_keeps_only_bounded_numeric_window_evidence() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/window_commands.rs",
            "main_geometry phase=geometry_save source=main_close outcome=ok geometry_available=true requested_available=true x=632 y=16 width=3051 height=2067 inner_width=3025 inner_height=2052 frame_width=26 frame_height=15 requested_x=632 requested_y=16 requested_width=3051 requested_height=2067 scale_milli=2000 maximized=false minimized=false title=private path=C:\\private\\library.json",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let event = &value["recent_native_events"][0];
        assert_eq!(event["event"], "main_geometry");
        let fields = &event["fields"];
        assert_eq!(fields["x"], 632);
        assert_eq!(fields["y"], 16);
        assert_eq!(fields["width"], 3051);
        assert_eq!(fields["height"], 2067);
        assert_eq!(fields["scale_milli"], 2000);
        let json = value.to_string();
        assert!(!json.contains("private"));
        assert!(!json.contains("library.json"));
    }

    #[test]
    fn shelf_focus_handoff_distinguishes_requests_from_confirmed_focus() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/window_commands.rs",
            "reader_window phase=focus_restore outcome=focused_after_retry duration_ms=144 attempt=3 window_requested=true native_focused=true webview_requested=true webview_focused=true visible=true path=private",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let fields = &value["recent_native_events"][0]["fields"];
        assert_eq!(fields["window_requested"], true);
        assert_eq!(fields["native_focused"], true);
        assert_eq!(fields["webview_requested"], true);
        assert_eq!(fields["webview_focused"], true);
        assert_eq!(fields["attempt"], 3);
        assert!(fields.get("path").is_none());
    }

    #[test]
    fn native_log_preserves_startup_operation_phase_and_safe_metrics() {
        let mut state = DiagnosticsState::default();
        state.record_native_log(
            "src/runtime_support.rs",
            "[startup] keyword-index end 16853ms total=797 indexed=0 skipped=780 removed=0 disk_mb=2836",
            1,
        );
        let value = serde_json::to_value(state.snapshot(2)).unwrap();
        let event = &value["recent_native_events"][0];
        assert_eq!(event["event"], "startup");
        assert_eq!(event["fields"]["operation"], "keyword-index");
        assert_eq!(event["fields"]["phase"], "end");
        assert_eq!(event["fields"]["elapsed_ms"], 16_853);
        assert_eq!(event["fields"]["total"], 797);
        assert_eq!(event["fields"]["skipped"], 780);
        assert_eq!(event["fields"]["disk_mb"], 2_836);
    }

    #[test]
    fn snapshot_schema_is_stable_and_clear_resets_all_history() {
        let mut state = DiagnosticsState::default();
        state.record_sync_stage("sync_total", 42, false, 1);
        state.record_retry_recovered("pull", 2, 12, 2);
        let value = serde_json::to_value(state.snapshot(3)).unwrap();
        assert_eq!(value["schema_version"], 3);
        assert_eq!(value["generated_at_ms"], 3);
        assert!(value.get("counters").is_some());
        assert!(value.get("recent_slow_db_timings").is_some());
        assert!(value.get("recent_retries").is_some());
        assert!(value.get("recent_sync_stages").is_some());
        assert!(value.get("recent_native_events").is_some());

        state.clear();
        let cleared = state.snapshot(4);
        assert_eq!(cleared.counters, DiagnosticCounters::default());
        assert!(cleared.recent_retries.is_empty());
        assert!(cleared.recent_sync_stages.is_empty());
        assert!(cleared.recent_native_events.is_empty());
    }
}
