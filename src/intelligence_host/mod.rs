//! Independent, local-only control plane for the intelligence workstation.
//!
//! Collection, 7B/8B triage, vector candidate recall, 27B review and the
//! permanent archive are deliberately implemented by the existing headless
//! worker.  This module turns those safe, individual commands into an
//! operator-visible workstation boundary without embedding that work in the
//! reader WebView.  Its optional dashboard is a loopback-only page on the
//! processing machine; the reader remains a client of published content.

use crate::{archive, atomic_file, profile};
mod audit;
mod dashboard;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// The controller is a short-lived PowerShell process that starts/stops
// local model services.  It must never flash a console while the unattended
// host loop changes phase in the background.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CONFIG_FILE: &str = "intelligence-host-v1.json";
const DEFAULT_SOURCES_FILE: &str = "intelligence-host-default-sources-v1.json";
const CONFIG_VERSION: u8 = 1;
const MAX_STAGE_RUNS: u16 = 500;
const WORKSTATION_LOOP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const WORKSTATION_ACTIVE_LOOP_INTERVAL: Duration = Duration::from_secs(30);
/// Full-text retrieval is an evidence-only lane.  It deliberately wakes more
/// often than the editorial pipeline so a several-thousand-item historical
/// archive can keep moving without waiting for the next 8B/27B round.
const FULL_TEXT_BACKFILL_ACTIVE_INTERVAL: Duration = Duration::from_secs(5);
const FULL_TEXT_BACKFILL_IDLE_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// When a substantial evidence backlog remains, one unattended round must
/// yield back to fetch work promptly.  Otherwise a slow 8B relation batch can
/// make the full-text queue appear stuck even though retrieval itself does not
/// need the GPU.
const FULL_TEXT_BACKLOG_YIELD_THRESHOLD: u64 = 512;
const BACKLOG_MODEL_STAGE_LIMIT: u16 = 24;
/// Completed relation work is already durable.  Once a real editorial backlog
/// exists, a small bounded group prevents a legacy "one article per round"
/// setting from stretching a healthy 27B queue over many days.
const BACKLOG_EDITORIAL_BATCH_LIMIT: u16 = 4;
/// The independent scheduler yields the shared SQLite writer after at most
/// two bounded worker batches.  Larger limits would simply move the old
/// starvation problem from the model lane to the backfill lane.
const BACKGROUND_BACKFILL_BATCHES_PER_CYCLE: u8 = 2;
const JUDGE_8B_SHA256: &str = "D98CDCBD03E17CE47681435B5150E34C1417F50B5C0019DD560E4882C5745785";
const EMBEDDING_06_SHA256: &str =
    "06507C7B42688469C4E7298B0A1E16DEFF06CAF291CF0A5B278C308249C3E439";
const RERANKER_06_SHA256: &str = "22C9979CE4FBCDC5ACDC310C6641C32797EFF1AA980B8F7A2DB8A8EA23429A48";
const EDITOR_27B_SHA256: &str = "8C2A45FF85E7674CA185EC8EB6CDEAB0E617ED9D8018CAED0B64380EB2A67A5E";
const HOST_AUDIT_FILE: &str = "host-latest-v1.json";
const COLLECTION_TIMEOUT: Duration = Duration::from_secs(120);
// One bounded batch can contain eight source-fair waves. Public article
// retrieval is capped at 45 seconds per wave, so the host deadline must cover
// that worst case plus archive writes instead of killing a healthy batch.
const BACKFILL_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const TRIAGE_TIMEOUT: Duration = Duration::from_secs(120);
/// One relation item can need up to three 8B pair decisions. Each decision has
/// its own short transport deadline.  A worker-private ANN snapshot is shared
/// by two durable items, so the host budget must cover both items plus cleanup
/// instead of aborting a healthy second item on a slower local archive drive.
const RELATION_TIMEOUT: Duration = Duration::from_secs(4 * 60);
/// Keep the worker-private ANN graph alive for a few durable relation items,
/// while preserving regular opportunities for full-text backfill in a busy
/// unattended loop.  This is a fixed internal bound, never dashboard input.
const RELATION_BATCH_SIZE: u16 = 2;
const EDITORIAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// A first switch verifies locally pinned GGUF artifacts.  On a mechanical
// archive drive that can legitimately take longer than the short per-article
// model calls, so keep it bounded but do not mislabel a healthy integrity
// check as a model hang.
const RUNTIME_SWITCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelRoute {
    base_url: String,
    model: String,
    #[serde(default)]
    artifact_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostConfiguration {
    version: u8,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    launch_at_login: bool,
    #[serde(default)]
    sources_file: Option<String>,
    #[serde(default)]
    worker_path: Option<String>,
    #[serde(default = "default_stage_limit")]
    max_triage_per_run: u16,
    #[serde(default = "default_stage_limit")]
    max_processing_per_run: u16,
    /// The 27B editorial service is deliberately more expensive than the
    /// small-model stages.  Keep each unattended round responsive: completed
    /// relation work is durable and the next loop resumes from that boundary.
    #[serde(default = "default_editorial_limit")]
    max_editorial_per_run: u16,
    /// Full-text acquisition does not occupy the GPU and must be allowed to
    /// make visible progress even while editorial work is intentionally
    /// bounded.  Each batch retains its per-publisher fairness and timeout.
    #[serde(default = "default_backfill_batches_per_run")]
    max_backfill_batches_per_run: u8,
    #[serde(default)]
    triage: Option<ModelRoute>,
    #[serde(default)]
    embedding: Option<ModelRoute>,
    #[serde(default)]
    reranker: Option<ModelRoute>,
    #[serde(default)]
    deep_review: Option<ModelRoute>,
}

const fn default_stage_limit() -> u16 {
    120
}

fn balanced_model_stage_limit(configured_limit: u16, awaiting_full_text: u64) -> u16 {
    if awaiting_full_text >= FULL_TEXT_BACKLOG_YIELD_THRESHOLD {
        configured_limit.clamp(1, BACKLOG_MODEL_STAGE_LIMIT)
    } else {
        configured_limit.max(1)
    }
}

/// The independent evidence scheduler must be responsive to both the large
/// historical backlog and the interactive model pipeline.  It performs one
/// bounded batch for ordinary new work and, once the durable waiting queue is
/// substantial, two batches before releasing the shared pipeline lock.  The
/// worker retains the real per-source concurrency/circuit-breaker policy.
fn background_backfill_batch_limit(configured_limit: u8, awaiting_full_text: u64) -> u8 {
    if awaiting_full_text == 0 {
        return 0;
    }
    let configured_limit = configured_limit.max(1);
    if awaiting_full_text >= FULL_TEXT_BACKLOG_YIELD_THRESHOLD {
        configured_limit.min(BACKGROUND_BACKFILL_BATCHES_PER_CYCLE)
    } else {
        1
    }
}

fn editorial_batch_limit(configured_limit: u16, ready_for_editorial: u64) -> u16 {
    let configured_limit = configured_limit.max(1);
    if ready_for_editorial >= FULL_TEXT_BACKLOG_YIELD_THRESHOLD {
        configured_limit.max(BACKLOG_EDITORIAL_BATCH_LIMIT)
    } else {
        configured_limit
    }
}

/// Versions before the independent evidence lane saved conservative defaults
/// (one editorial item and four evidence batches).  There is no operator UI
/// for these internal values, so migrate only those old defaults; a higher
/// future operator value is preserved.
fn upgrade_legacy_throughput_limits(configuration: &mut HostConfiguration) {
    if configuration.max_editorial_per_run == 1 {
        configuration.max_editorial_per_run = default_editorial_limit();
    }
    if configuration.max_backfill_batches_per_run < default_backfill_batches_per_run() {
        configuration.max_backfill_batches_per_run = default_backfill_batches_per_run();
    }
}

const fn default_editorial_limit() -> u16 {
    // A single 27B editorial item per round left a healthy workstation taking
    // many hours to turn an already-validated daily backlog into events. Two
    // retains a strict bound (and lets the next round return to evidence
    // acquisition) without needlessly serialising all editorial work.
    2
}

const fn default_backfill_batches_per_run() -> u8 {
    // Each worker batch is already bounded to 32 candidates and eight
    // cross-host requests.  A 5k+ evidence backlog should not make the
    // workstation wait through GPU phases after merely 128 attempts: retain
    // the publisher-level throttle/circuit-breaker in the worker, but let a
    // single durable round cover 256 candidates.
    8
}

impl Default for HostConfiguration {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            enabled: false,
            launch_at_login: false,
            sources_file: None,
            worker_path: None,
            max_triage_per_run: default_stage_limit(),
            max_processing_per_run: default_stage_limit(),
            max_editorial_per_run: default_editorial_limit(),
            max_backfill_batches_per_run: default_backfill_batches_per_run(),
            triage: None,
            embedding: None,
            reranker: None,
            deep_review: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStatus {
    kind: &'static str,
    enabled: bool,
    launch_at_login: bool,
    /// Whether the independent `--loop` owner is currently alive.  This is
    /// intentionally distinct from `enabled`: the latter is an operator
    /// preference persisted to disk, while this proves the background host
    /// process itself is still present.
    continuous_processing_active: bool,
    configuration_ready: bool,
    pipeline_running: bool,
    archive_present: bool,
    worker_available: bool,
    sources_configured: bool,
    triage_configured: bool,
    processing_configured: bool,
    article_count: u64,
    /// All article rows still awaiting the 8B decision.  This is intentionally
    /// split below so an operator does not mistake a large permanent-backfill
    /// queue for a large model queue.
    queued_count: u64,
    ready_for_triage_count: u64,
    /// Queued articles blocked before the 8B judge because their immutable
    /// evidence revision is still missing.
    awaiting_full_text_count: u64,
    /// Older kept/filtered archive rows which are safe to backfill, but are
    /// not part of the active model queue.  Surface this separately so the
    /// dashboard never presents a 7k archive repair backlog as a handful of
    /// current candidates.
    historical_backfill_count: u64,
    /// Current article revisions that still lack complete evidence, while an
    /// older revision of the same article remains archived.  This makes the
    /// version boundary visible without silently treating stale evidence as
    /// current model input.
    evidence_version_mismatch_count: u64,
    /// Aggregate-only evidence-acquisition health.  This deliberately keeps
    /// per-article retry scheduling distinct from per-publisher protection:
    /// the workbench must never disclose an article URL or a publisher host
    /// merely to explain why a public body has not been archived yet.
    full_text_backfill: FullTextBackfillHealth,
    /// Kept full-text records still waiting for 0.6B recall plus the 8B
    /// relation pass.
    ready_for_relation_count: u64,
    /// Kept records whose durable 8B relation pass is complete.  This is the
    /// only queue that may cause the host to acquire the 27B editorial phase.
    /// It keeps a missing CUDA provider from blocking collection/backfill when
    /// there is no evidence ready to review yet.
    ready_for_editorial_count: u64,
    kept_count: u64,
    filtered_count: u64,
    full_text_count: u64,
    processed_count: u64,
    /// The durable phase of the current or most recently interrupted host
    /// round.  This lets the loopback observer distinguish "loading 8B" from
    /// "running 8B" without exposing source content or local paths.
    current_stage: Option<String>,
    /// The most recent locally persisted processing round.  This is an
    /// observer projection: a dead owner turns a stale `running` record into
    /// `interrupted` without rewriting the historical audit file or inventing
    /// a completion timestamp.
    audit_run: Option<AuditRunProjection>,
    audit_summary: Vec<AuditSummary>,
    last_run: Option<AggregateRunReport>,
    last_error: Option<String>,
}

/// Safe, fixed-shape operational counters for permanent full-text acquisition.
/// Neither this type nor the queries that populate it project article text,
/// titles, URLs, source identifiers, hosts, raw HTTP errors or credentials.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct FullTextBackfillHealth {
    /// Incomplete article revisions with a durable public HTTPS source that
    /// can enter the evidence backfill lane.
    waiting_count: u64,
    /// Article-level retry windows that have elapsed. A host circuit can still
    /// temporarily defer one of these rows; `limited_host_count` exposes that
    /// separate safety boundary without naming the host.
    retryable_now_count: u64,
    /// Article-level retry windows still in their persisted backoff period.
    delayed_count: u64,
    /// Number of publisher circuits currently protecting a remote host.
    limited_host_count: u64,
    /// Aggregate publisher health derived from the durable circuit table.  The
    /// dashboard intentionally exposes only counts: a source may be public,
    /// but listing its host here would turn a process-health view into a feed
    /// inventory and could reveal a user's configured subscriptions.
    known_source_count: u64,
    healthy_source_count: u64,
    degraded_source_count: u64,
    circuit_open_source_count: u64,
    /// Fixed, operator-safe categories from the most recent persisted retry
    /// state. Zero categories remain present so dashboard clients do not need
    /// to infer the accepted failure vocabulary from raw worker errors.
    failure_categories: Vec<FullTextBackfillFailureCount>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FullTextBackfillFailureCount {
    category: &'static str,
    count: u64,
}

/// Aggregate-only audit information for the local control page.  Keeping this
/// at stage/status granularity avoids the old audit view's large eager payload
/// and never returns source text, source URLs, local paths, or credentials.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditSummary {
    stage: String,
    status: String,
    /// Number of times this host round entered the stage.  It is deliberately
    /// not an article, event, or source count.
    count: u64,
    /// A stable display hint for loopback tooling.  It lets the workbench say
    /// "调用次数" rather than presenting stage transitions as news items.
    unit: &'static str,
}

/// Aggregate-only lifecycle data for the most recent host round.  `status`
/// is the effective status observed now, rather than blindly repeating a
/// stale on-disk `running` marker after the owner process has disappeared.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRunProjection {
    /// Opaque, short operator handle. The durable UUID remains local to the
    /// audit file; the dashboard never needs the complete identifier.
    run_code: String,
    status: String,
    started_at: i64,
    finished_at: Option<i64>,
    current_stage: Option<String>,
    /// Ordered, consecutive-stage-compressed lifecycle evidence. This is
    /// deliberately separate from the grouped audit summary so an operator can
    /// see the path a round took without receiving article-level details.
    stage_sequence: Vec<AuditSummary>,
    /// The durable per-round aggregate is projected here rather than allowing
    /// an `auditRun` lifecycle marker to hide the completed report.
    report: Option<AggregateRunReport>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunReport {
    outcome: String,
    collection: String,
    collected: u64,
    duplicates: u64,
    backfilled: u64,
    backfill_retried: u64,
    triaged: u64,
    retried: u64,
    /// Most recent durable relation-worker result.  This is aggregate-only
    /// diagnostic state: it distinguishes a normal embedding warm-up from a
    /// retryable model failure without retaining any source content.
    relation: String,
    /// Narrow retry boundary reported by the worker.  This is deliberately a
    /// fixed code instead of a raw error, so audit and dashboard views remain
    /// useful without retaining article text, provider messages, or URLs.
    relation_failure: String,
    /// Equivalent bounded diagnostic for the 27B editorial phase.  This keeps
    /// a complete-but-unpublished item observable without ever persisting the
    /// provider response, article text, or prompt.
    editorial_failure: String,
    processed: u64,
    reviewed: u64,
    /// The bounded same-day event lane.  It is kept apart from the daily
    /// retrospective below so the operator can tell whether a completed event
    /// is merely frozen locally, actually acknowledged by the server, or not
    /// yet available.  It never contains IDs, article data or credentials.
    #[serde(default)]
    event_publication: String,
    /// The immutable previous-UTC-day retrospective lane.  Older audit rows
    /// only have this field, so retain it for backwards-readable status.
    #[serde(default)]
    publication: String,
    /// Historical delivery is owned by the DPAPI-capability sidecar rather
    /// than the model pipeline. It remains alive when GPU/model work fails.
    distribution_service: String,
}

/// Strictly allowlisted aggregate report for the loopback dashboard. The
/// worker owns its raw output, so projecting only known outcome codes prevents
/// a malformed audit file or unexpected child output from disclosing text,
/// URLs, hosts, paths, or credentials.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AggregateRunReport {
    outcome: String,
    collection: String,
    collected: u64,
    duplicates: u64,
    backfilled: u64,
    backfill_retried: u64,
    triaged: u64,
    retried: u64,
    relation: String,
    relation_failure: String,
    editorial: String,
    processed: u64,
    reviewed: u64,
    event_publication: String,
    publication: String,
}

/// A durable, aggregate-only record for one explicit host round.  It is
/// deliberately separate from the reader's historical audit tables: those
/// tables describe earlier UI experiments and must never be presented as the
/// state of the independent processing machine.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRunAudit {
    version: u8,
    run_id: String,
    status: String,
    /// The owning local host process.  A dashboard observer uses this to
    /// distinguish a genuine background round from a stale file left by a
    /// crash or forced shutdown.
    #[serde(default)]
    runner_pid: u32,
    started_at: i64,
    #[serde(default)]
    heartbeat_at: i64,
    finished_at: Option<i64>,
    current_stage: String,
    stages: Vec<HostRunStage>,
    report: Option<RunReport>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRunStage {
    stage: String,
    status: String,
    started_at: i64,
    finished_at: Option<i64>,
}

impl HostRunAudit {
    fn start() -> Self {
        let now = unix_millis();
        Self {
            version: 1,
            run_id: uuid::Uuid::new_v4().to_string(),
            status: "running".into(),
            runner_pid: std::process::id(),
            started_at: now,
            heartbeat_at: now,
            finished_at: None,
            current_stage: "preparing".into(),
            stages: Vec::new(),
            report: None,
        }
    }

    fn begin_stage(&mut self, stage: &str) {
        let now = unix_millis();
        self.heartbeat_at = now;
        if let Some(previous) = self
            .stages
            .last_mut()
            .filter(|value| value.finished_at.is_none())
        {
            previous.status = "completed".into();
            previous.finished_at = Some(now);
        }
        self.current_stage = stage.into();
        self.stages.push(HostRunStage {
            stage: stage.into(),
            status: "running".into(),
            started_at: now,
            finished_at: None,
        });
    }

    fn finish(&mut self, status: &str, report: Option<RunReport>) {
        let now = unix_millis();
        self.heartbeat_at = now;
        if let Some(current) = self
            .stages
            .last_mut()
            .filter(|value| value.finished_at.is_none())
        {
            current.status = status.into();
            current.finished_at = Some(now);
        }
        self.status = status.into();
        self.finished_at = Some(now);
        self.report = report;
    }
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn config_path() -> Result<PathBuf, String> {
    profile::app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .ok_or_else(|| "无法定位本机情报工作台配置目录".to_string())
}

/// Persisting a host audit is an explicit processing-side effect.  Status
/// reads use `existing_store_path` and never create this archive or migrate a
/// legacy database merely because someone opened the local dashboard.
fn host_audit_path() -> Result<PathBuf, String> {
    let catalog = archive::store_path()?;
    let root = catalog
        .parent()
        .ok_or_else(|| "本机情报档案目录无效".to_string())?;
    Ok(root.join("audit").join(HOST_AUDIT_FILE))
}

fn existing_host_audit_path() -> Result<PathBuf, String> {
    let catalog = archive::existing_store_path()?;
    let root = catalog
        .parent()
        .ok_or_else(|| "本机情报档案目录无效".to_string())?;
    Ok(root.join("audit").join(HOST_AUDIT_FILE))
}

fn write_host_audit(path: &Path, audit: &HostRunAudit) -> Result<(), String> {
    atomic_file::write_json(path, audit, false)
}

fn read_host_audit() -> Option<HostRunAudit> {
    let path = existing_host_audit_path().ok()?;
    let bytes = fs::read(path).ok()?;
    let value = serde_json::from_slice::<HostRunAudit>(&bytes).ok()?;
    (value.version == 1).then_some(value)
}

fn project_host_audit(audit: &HostRunAudit, owner_is_running: bool) -> AuditRunProjection {
    let interrupted = audit.status == "running" && !owner_is_running;
    AuditRunProjection {
        run_code: safe_run_code(&audit.run_id),
        status: if interrupted {
            "interrupted".into()
        } else {
            safe_lifecycle_status(&audit.status)
        },
        started_at: audit.started_at,
        // A process liveness check cannot tell when a crashed owner stopped.
        // Keep the original missing timestamp instead of fabricating one.
        finished_at: audit.finished_at,
        current_stage: owner_is_running.then(|| safe_stage(&audit.current_stage)),
        stage_sequence: sequence_from_host_audit(audit, owner_is_running),
        report: audit.report.as_ref().map(project_run_report),
    }
}

fn safe_run_code(run_id: &str) -> String {
    uuid::Uuid::parse_str(run_id)
        .map(|value| value.simple().to_string()[..8].to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn safe_lifecycle_status(value: &str) -> String {
    match value {
        "running" | "completed" | "failed" | "interrupted" | "stopped" => value.into(),
        _ => "unknown".into(),
    }
}

fn safe_stage(value: &str) -> String {
    match value {
        "preparing"
        | "collection"
        | "full_text_backfill"
        | "triage_runtime"
        | "triage_runtime_ready"
        | "small_model_triage"
        | "vector_recall_and_relation"
        | "editorial_runtime"
        | "editorial_runtime_ready"
        | "editorial_synthesis"
        | "publication"
        | "publication_without_model" => value.into(),
        _ => "unknown".into(),
    }
}

fn safe_report_outcome(value: &str) -> String {
    match value {
        "disabled"
        | "collector_not_configured"
        | "evidence_completed"
        | "collection_and_backfill_incomplete"
        | "collection_incomplete"
        | "content_backfill_incomplete"
        | "evidence_completed_models_not_configured"
        | "triage_runtime_unavailable"
        | "triage_incomplete"
        | "relation_processing_incomplete"
        | "editorial_runtime_unavailable"
        | "processing_incomplete" => value.into(),
        _ => "unknown".into(),
    }
}

fn safe_collection_outcome(value: &str) -> String {
    match value {
        "collected" | "collection_failed" => value.into(),
        "" => "not_run".into(),
        _ => "unknown".into(),
    }
}

fn safe_processing_outcome(value: &str) -> String {
    match value {
        "processed"
        | "processing_idle"
        | "processing_retry_scheduled"
        | "processing_not_configured" => value.into(),
        "" => "not_run".into(),
        _ => "unknown".into(),
    }
}

fn safe_relation_failure(value: &str) -> String {
    match value {
        "relation_judge_model_transport"
        | "relation_worker_timeout"
        | "relation_worker_nonzero"
        | "relation_worker_invalid_status" => value.into(),
        "" => "not_run".into(),
        _ => "unknown".into(),
    }
}

fn safe_publication_outcome(value: &str) -> String {
    match value {
        "event_prepared_locally"
        | "event_events_unavailable"
        | "event_already_published"
        | "event_published"
        | "event_publication_transport_unavailable"
        | "event_publication_failed"
        | "daily_prepared_locally"
        | "daily_events_unavailable"
        | "daily_already_published"
        | "daily_published"
        | "publication_transport_unavailable"
        | "publication_failed" => value.into(),
        "" => "not_run".into(),
        _ => "unknown".into(),
    }
}

fn project_run_report(report: &RunReport) -> AggregateRunReport {
    AggregateRunReport {
        outcome: safe_report_outcome(&report.outcome),
        collection: safe_collection_outcome(&report.collection),
        collected: report.collected,
        duplicates: report.duplicates,
        backfilled: report.backfilled,
        backfill_retried: report.backfill_retried,
        triaged: report.triaged,
        retried: report.retried,
        relation: safe_processing_outcome(&report.relation),
        relation_failure: safe_relation_failure(&report.relation_failure),
        editorial: if report.processed > 0 {
            "processed".into()
        } else if report.editorial_failure.is_empty() {
            "not_run".into()
        } else {
            "processing_retry_scheduled".into()
        },
        processed: report.processed,
        reviewed: report.reviewed,
        event_publication: safe_publication_outcome(&report.event_publication),
        publication: safe_publication_outcome(&report.publication),
    }
}

fn summary_from_host_audit(audit: &HostRunAudit, owner_is_running: bool) -> Vec<AuditSummary> {
    let mut grouped = std::collections::BTreeMap::<(String, String), u64>::new();
    for stage in &audit.stages {
        let status = if !owner_is_running && stage.status == "running" {
            "interrupted".into()
        } else {
            safe_lifecycle_status(&stage.status)
        };
        *grouped
            .entry((safe_stage(&stage.stage), status))
            .or_default() += 1;
    }
    grouped
        .into_iter()
        .map(|((stage, status), count)| AuditSummary {
            stage,
            status,
            count,
            unit: "stage_invocations",
        })
        .collect()
}

fn sequence_from_host_audit(audit: &HostRunAudit, owner_is_running: bool) -> Vec<AuditSummary> {
    let mut sequence = Vec::<AuditSummary>::new();
    for stage in &audit.stages {
        let status = if !owner_is_running && stage.status == "running" {
            "interrupted".into()
        } else {
            safe_lifecycle_status(&stage.status)
        };
        let stage = safe_stage(&stage.stage);
        if let Some(last) = sequence.last_mut().filter(|last| {
            last.stage == stage && last.status == status && last.unit == "stage_invocations"
        }) {
            last.count = last.count.saturating_add(1);
            continue;
        }
        sequence.push(AuditSummary {
            stage,
            status,
            count: 1,
            unit: "stage_invocations",
        });
    }
    sequence
}

/// The first-run source list is deliberately small and public.  It provides a
/// usable, editable starting point without silently enrolling private feeds,
/// using a proxy, or enabling the model pipeline.  The worker still validates
/// every endpoint before making a request.
fn default_sources_template() -> serde_json::Value {
    serde_json::json!({
        "batchId": "kunpeng-host-default-public-v1",
        "sources": [
            {"sourceId":"reliefweb-updates","kind":"rss","url":"https://reliefweb.int/updates/rss.xml","language":"en","intervalSeconds":300},
            {"sourceId":"cisa-advisories","kind":"rss","url":"https://www.cisa.gov/cybersecurity-advisories/all.xml","language":"en","intervalSeconds":300},
            {"sourceId":"simon-willison","kind":"atom","url":"https://simonwillison.net/atom/everything/","language":"en","intervalSeconds":600},
            {"sourceId":"vllm-blog","kind":"rss","url":"https://vllm.ai/blog/rss.xml","language":"en","intervalSeconds":600},
            {"sourceId":"cnbc-finance","kind":"rss","url":"https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664","language":"en","intervalSeconds":300},
            {"sourceId":"nvidia-cuda","kind":"rss","url":"https://developer.nvidia.com/blog/tag/cuda/feed/","language":"en","intervalSeconds":600},
            {"sourceId":"gdacs-alerts","kind":"rss","url":"https://www.gdacs.org/xml/rss.xml","language":"en","intervalSeconds":300}
        ]
    })
}

fn default_sources_path() -> Result<PathBuf, String> {
    profile::app_config_dir()
        .map(|directory| directory.join(DEFAULT_SOURCES_FILE))
        .ok_or_else(|| "无法定位本机情报工作台来源目录".to_string())
}

/// Creates the default list once.  A user-edited list is never overwritten;
/// if a path was already configured, `--init` leaves it entirely alone.
fn ensure_default_sources_file() -> Result<PathBuf, String> {
    let path = default_sources_path()?;
    if path.is_file() {
        return Ok(path);
    }
    if path.exists() {
        return Err("默认资讯来源路径不是文件".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "默认资讯来源路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建默认资讯来源目录")?;
    atomic_file::write_json(&path, &default_sources_template(), true)
        .map_err(|_| "无法写入默认公开资讯来源")?;
    Ok(path)
}

fn initialize_configuration() -> Result<HostConfiguration, String> {
    let mut configuration = read_configuration()?;
    if configuration.sources_file.is_none() {
        let path = ensure_default_sources_file()?;
        configuration.sources_file = Some(path.to_string_lossy().into_owned());
    }
    // Routes are pinned to the artifact identities verified by the shipped
    // runtime scripts.  Initialization remains inert: it never enables the
    // pipeline or starts a model; a later runtime phase re-verifies the local
    // bytes before accepting requests.
    configuration.triage.get_or_insert_with(|| ModelRoute {
        base_url: "http://127.0.0.1:8081/v1".into(),
        model: "Qwen3-8B-Q4_K_M".into(),
        artifact_sha256: JUDGE_8B_SHA256.into(),
    });
    configuration.embedding.get_or_insert_with(|| ModelRoute {
        base_url: "http://127.0.0.1:8082/v1".into(),
        model: "Qwen3-Embedding-0.6B-Q8_0".into(),
        artifact_sha256: EMBEDDING_06_SHA256.into(),
    });
    configuration.reranker.get_or_insert_with(|| ModelRoute {
        base_url: "http://127.0.0.1:8083/v1".into(),
        model: "Qwen3-Reranker-0.6B-Q8_0".into(),
        artifact_sha256: RERANKER_06_SHA256.into(),
    });
    configuration.deep_review.get_or_insert_with(|| ModelRoute {
        base_url: "http://127.0.0.1:8080/v1".into(),
        model: "Qwen3.8-27B-UD-Q3_K_XL".into(),
        artifact_sha256: EDITOR_27B_SHA256.into(),
    });
    write_configuration(&configuration)?;
    Ok(configuration)
}

fn read_configuration() -> Result<HostConfiguration, String> {
    read_configuration_at(&config_path()?)
}

fn read_configuration_at(path: &Path) -> Result<HostConfiguration, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HostConfiguration::default())
        }
        Err(_) => return Err("无法读取本机情报工作台配置".into()),
    };
    let mut configuration: HostConfiguration =
        serde_json::from_slice(&bytes).map_err(|_| "本机情报工作台配置已损坏".to_string())?;
    // Legacy route records did not carry a model artifact hash.  Never guess
    // one: remove only those incomplete routes so archive/collection can keep
    // running and the operator can reconfigure verified model identities.
    clear_legacy_unverified_routes(&mut configuration);
    validate_configuration(&configuration)?;
    Ok(configuration)
}

fn clear_legacy_unverified_routes(configuration: &mut HostConfiguration) {
    for route in [
        &mut configuration.triage,
        &mut configuration.embedding,
        &mut configuration.reranker,
        &mut configuration.deep_review,
    ] {
        if route
            .as_ref()
            .is_some_and(|route| route.artifact_sha256.trim().is_empty())
        {
            *route = None;
        }
    }
}

fn write_configuration(configuration: &HostConfiguration) -> Result<(), String> {
    validate_configuration(configuration)?;
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "本机情报工作台配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建本机情报工作台配置目录")?;
    atomic_file::write_json(&path, configuration, true)
        .map_err(|_| "无法保存本机情报工作台配置".to_string())
}

/// A host-only, profile-scoped process guard.  The dashboard, a scheduled
/// `--loop`, and an operator's `--run-once` command must never race the same
/// archive or model runtime.  It intentionally does not share the reader or
/// worker-service mutexes: this is the independent processing host boundary.
struct HostProcessGuard {
    #[cfg(windows)]
    handle: *mut core::ffi::c_void,
}

#[cfg(any(windows, test))]
fn host_mutex_name(kind: &str) -> String {
    let scope = profile::instance_scope_key();
    let suffix = if scope == "global" {
        ""
    } else {
        return format!("Local\\KunpengIntelligenceHost{kind}V1-{scope}");
    };
    format!("Local\\KunpengIntelligenceHost{kind}V1{suffix}")
}

#[cfg(windows)]
impl Drop for HostProcessGuard {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        }
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// `Ok(None)` means a different host process currently owns this role.
fn acquire_host_guard(kind: &str) -> Result<Option<HostProcessGuard>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        type Handle = *mut core::ffi::c_void;
        const ERROR_ALREADY_EXISTS: u32 = 183;
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(
                attributes: *const core::ffi::c_void,
                initial_owner: i32,
                name: *const u16,
            ) -> Handle;
            fn GetLastError() -> u32;
            fn CloseHandle(handle: Handle) -> i32;
        }
        let name = host_mutex_name(kind);
        let name = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("无法初始化本机情报主机单实例保护".into());
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(HostProcessGuard { handle }))
    }
    #[cfg(not(windows))]
    {
        let _ = kind;
        Ok(Some(HostProcessGuard {}))
    }
}

/// Observational probe used by the loopback dashboard.  Acquiring and
/// immediately releasing a named mutex is safe here: only an existing host
/// loop can make it return `true`; no input reaches an OS command line.
fn continuous_processing_active() -> bool {
    match acquire_host_guard("Loop") {
        Ok(Some(guard)) => {
            drop(guard);
            false
        }
        Ok(None) | Err(_) => true,
    }
}

fn run_once_with_pipeline_guard(configuration: &HostConfiguration) -> Result<RunReport, String> {
    run_once_with_pipeline_guard_and_stop(configuration, false)
}

/// A dashboard stop must take effect at the next durable worker boundary, not
/// only after a legacy multi-item round has drained.  Manual one-off runs do
/// not use this switch: their configuration is intentionally allowed to keep
/// `enabled` false.
fn run_once_with_pipeline_guard_and_stop(
    configuration: &HostConfiguration,
    stop_when_disabled: bool,
) -> Result<RunReport, String> {
    let Some(_guard) = acquire_host_guard("Pipeline")? else {
        return Err("已有本机情报处理正在运行".into());
    };
    run_once_unlocked(configuration, stop_when_disabled)
}

/// Starts the independent host loop after an explicit dashboard action.  The
/// spawned executable retains no dashboard request data and receives neither
/// credentials nor endpoints through its command line or environment.
pub(super) fn start_continuous_processing(launch_at_login: bool) -> Result<(), String> {
    if continuous_processing_active() {
        return Ok(());
    }
    let original = read_configuration()?;
    if original.sources_file.is_none() {
        return Err("请先初始化并配置资讯来源，再启动持续处理".into());
    }
    let mut configuration = original.clone();
    upgrade_legacy_throughput_limits(&mut configuration);
    configuration.enabled = true;
    configuration.launch_at_login = launch_at_login;
    write_configuration(&configuration)?;
    if let Err(error) = configure_login_startup(launch_at_login) {
        let _ = write_configuration(&original);
        return Err(error);
    }
    if let Err(error) = spawn_continuous_workers() {
        let _ = configure_login_startup(original.launch_at_login);
        let _ = write_configuration(&original);
        return Err(error);
    }
    Ok(())
}

/// Stop requests never kill an in-flight model subprocess.  They atomically
/// disable the durable loop and remove login startup; the active host observes
/// this within one second, completes its current bounded round, then exits.
pub(super) fn stop_continuous_processing() -> Result<(), String> {
    let mut configuration = read_configuration()?;
    configuration.enabled = false;
    configuration.launch_at_login = false;
    write_configuration(&configuration)?;
    // Keep the conservative disabled configuration even when Windows rejects
    // removal of a stale Run value. A later explicit start can retry
    // registration; this must never resurrect continuous work.
    configure_login_startup(false)?;
    Ok(())
}

/// Starts the two independent, no-window background lanes.  The backfill lane
/// owns only public-body acquisition; all SQLite-mutating worker invocations
/// still acquire the shared `Pipeline` guard, so it can never race collection,
/// 8B relation work, or 27B synthesis.
fn spawn_continuous_workers() -> Result<(), String> {
    spawn_background_host("--backfill-loop")?;
    spawn_background_host("--loop")
}

fn spawn_background_host(mode: &str) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|_| "无法定位本机情报主机程序")?
        .canonicalize()
        .map_err(|_| "无法确认本机情报主机程序路径")?;
    let mut command = Command::new(executable);
    command
        .args(profile::child_profile_args())
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法启动本机情报持续处理".into())
}

/// Registers only this independently launched host loop for the current user.
/// It never adds the reader UI to Windows startup, and the action is reachable
/// only after an explicit click in the nonce-protected loopback page.
fn configure_login_startup(enabled: bool) -> Result<(), String> {
    if crate::profile::is_isolated() {
        return (!enabled)
            .then_some(())
            .ok_or("隔离情报配置不支持登录启动".into());
    }
    if !cfg!(windows) {
        return Err("当前平台暂不支持本机情报工作台开机启动".into());
    }
    let executable = std::env::current_exe()
        .map_err(|_| "无法定位本机情报工作台程序")?
        .canonicalize()
        .map_err(|_| "无法确认本机情报工作台程序路径")?;
    let output = if enabled {
        let command = format!("\"{}\" --loop", executable.display());
        Command::new("reg.exe")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "KunpengIntelligenceHost",
                "/t",
                "REG_SZ",
                "/d",
                &command,
                "/f",
            ])
            .output()
    } else {
        Command::new("reg.exe")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "KunpengIntelligenceHost",
                "/f",
            ])
            .output()
    }
    .map_err(|_| "无法更新本机情报工作台开机启动设置".to_string())?;
    if output.status.success() || (!enabled && output.status.code() == Some(1)) {
        Ok(())
    } else {
        Err("无法更新本机情报工作台开机启动设置".into())
    }
}

fn validate_configuration(configuration: &HostConfiguration) -> Result<(), String> {
    if configuration.version != CONFIG_VERSION
        || configuration.max_triage_per_run == 0
        || configuration.max_triage_per_run > MAX_STAGE_RUNS
        || configuration.max_processing_per_run == 0
        || configuration.max_processing_per_run > MAX_STAGE_RUNS
        || configuration.max_editorial_per_run == 0
        || configuration.max_editorial_per_run > MAX_STAGE_RUNS
    {
        return Err("本机情报工作台配置版本或批处理上限无效".into());
    }
    if let Some(path) = configuration.sources_file.as_deref() {
        if !Path::new(path).is_absolute() || path.len() > 4096 {
            return Err("资讯来源文件必须是绝对本机路径".into());
        }
    }
    if let Some(path) = configuration.worker_path.as_deref() {
        if !Path::new(path).is_absolute() || path.len() > 4096 {
            return Err("情报 worker 必须是绝对本机路径".into());
        }
    }
    validate_route(configuration.triage.as_ref(), "7B/8B 初筛", "7b|8b")?;
    validate_route(configuration.embedding.as_ref(), "向量模型", "0.6b|8b")?;
    validate_route(configuration.reranker.as_ref(), "重排模型", "0.6b")?;
    validate_route(configuration.deep_review.as_ref(), "27B 复核", "27b")?;
    Ok(())
}

fn validate_route(route: Option<&ModelRoute>, name: &str, expected: &str) -> Result<(), String> {
    let Some(route) = route else {
        return Ok(());
    };
    let endpoint = route.base_url.trim().trim_end_matches('/');
    let valid_loopback = endpoint.starts_with("http://127.0.0.1")
        || endpoint.starts_with("http://localhost")
        || endpoint.starts_with("http://[::1]");
    if !valid_loopback
        || endpoint.len() > 512
        || route.model.trim().is_empty()
        || route.model.len() > 200
        || !valid_sha256(&route.artifact_sha256)
    {
        return Err(format!("{name} 只能使用有效的本机回环 OpenAI 兼容服务"));
    }
    let model = route.model.to_ascii_lowercase();
    if !expected.split('|').any(|marker| model.contains(marker)) {
        return Err(format!("{name} 的模型标识与当前职责不匹配"));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn worker_path(configuration: &HostConfiguration) -> Option<PathBuf> {
    if let Some(path) = configuration.worker_path.as_deref() {
        return PathBuf::from(path).is_file().then(|| PathBuf::from(path));
    }
    let executable = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "kunpeng-intelligence-worker.exe"
    } else {
        "kunpeng-intelligence-worker"
    };
    let candidate = executable.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

/// Resolve the phase controller shipped beside the desktop resources (or the
/// development checkout).  The controller owns the GPU transition: 8B is
/// loaded for bulk judgement, then unloaded before 27B editorial review.  A
/// 16 GB GPU cannot safely keep both resident merely because one pipeline run
/// needs both roles.
fn runtime_controller_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = std::env::var_os("KUNPENG_INTELLIGENCE_RUNTIME_CONTROLLER") {
        candidates.push(PathBuf::from(value));
    }
    if let Ok(directory) = std::env::current_dir() {
        candidates.push(
            directory
                .join("scripts")
                .join("local-intelligence-runtime.ps1"),
        );
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(
                directory
                    .join("scripts")
                    .join("local-intelligence-runtime.ps1"),
            );
            candidates.push(
                directory
                    .join("resources")
                    .join("scripts")
                    .join("local-intelligence-runtime.ps1"),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    unavailable_message: &str,
    timeout_message: &str,
) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| unavailable_message.to_owned())?;
    // A model/runtime helper can emit a few kilobytes of harmless progress
    // before it exits.  Drain both pipes concurrently, otherwise an OS pipe
    // filling up can make a completed switch look like an infinite hang.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| unavailable_message.to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| unavailable_message.to_owned())?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(timeout_message.to_owned());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(unavailable_message.to_owned());
            }
        }
    };
    Ok(std::process::Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

/// Runtime phase scripts intentionally start long-lived local model servers.
/// Those servers can inherit PowerShell's standard handles even after the
/// controller itself exits.  Do not use the JSON-worker pipe collector here:
/// waiting for EOF would then wait for the model service forever.  Phase
/// status is recorded by the controller/audit instead, while this helper only
/// waits for the short-lived controller process.
fn command_status_with_timeout(
    command: &mut Command,
    timeout: Duration,
    unavailable_message: &str,
    timeout_message: &str,
) -> Result<std::process::ExitStatus, String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|_| unavailable_message.to_owned())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timeout_message.to_owned());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unavailable_message.to_owned());
            }
        }
    }
}

fn switch_runtime_phase_once(phase: &str) -> Result<(), String> {
    let controller = runtime_controller_path()
        .ok_or_else(|| "未找到本机模型阶段控制器；请重新安装情报工作台组件".to_string())?;
    let shells: &[&str] = if cfg!(windows) {
        &["pwsh.exe", "powershell.exe"]
    } else {
        &["pwsh"]
    };
    for shell in shells {
        let mut command = Command::new(shell);
        command
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&controller)
            .args(["-Action", phase]);
        let status = command_status_with_timeout(
            &mut command,
            RUNTIME_SWITCH_TIMEOUT,
            "无法启动本机模型阶段控制器",
            "本机模型阶段切换超时；已停止本轮处理",
        );
        match status {
            Ok(status) if status.success() => return Ok(()),
            Ok(_) => return Err(format!("本机模型阶段 {phase} 未就绪；请查看本机运行时状态")),
            // `command_output_with_timeout` intentionally returns a
            // redacted message, so preserve the pwsh -> Windows PowerShell
            // fallback without exposing a local executable/path error.
            Err(_) => continue,
        }
    }
    Err("本地情报模型需要 PowerShell 7（pwsh.exe）".into())
}

fn switch_runtime_phase(phase: &str) -> Result<(), String> {
    // A just-completed 8B request can briefly retain its listener/process
    // handle while the short-lived controller is releasing the phase mutex.
    // Returning to CoreOnly is idempotent and is the workstation's safe idle
    // state, so retry only that cleanup transition instead of leaving GPU
    // services resident or failing an otherwise completed archive round.
    let attempts = if phase == "CoreOnly" { 3 } else { 1 };
    let mut last_error = None;
    for attempt in 0..attempts {
        match switch_runtime_phase_once(phase) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < attempts {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "本机模型阶段切换失败".into()))
}

fn collection_ready(configuration: &HostConfiguration) -> bool {
    configuration.enabled && configuration.sources_file.is_some()
}

/// All routes are needed only for model processing.  Evidence collection and
/// full-text backfill intentionally have a weaker prerequisite: those jobs
/// must keep reducing the permanent-archive backlog while a GPU model is
/// stopped, unavailable, or being replaced.
fn model_processing_ready(configuration: &HostConfiguration) -> bool {
    collection_ready(configuration)
        && configuration.triage.is_some()
        && configuration.embedding.is_some()
        && configuration.reranker.is_some()
        && configuration.deep_review.is_some()
}

fn configuration_ready(configuration: &HostConfiguration) -> bool {
    model_processing_ready(configuration)
}

fn status(
    configuration: &HostConfiguration,
    last_run: Option<RunReport>,
    pipeline_running: bool,
) -> HostStatus {
    let persisted_audit = read_host_audit();
    // `--status` is normally invoked by a second short-lived host process.
    // Only a durable audit whose owner is still alive can establish that a
    // separate host is working; a stale `running` file is interrupted work,
    // not a future stage that the dashboard may invent.
    let audit_running = audit_is_running(persisted_audit.as_ref());
    let effective_pipeline_running = pipeline_running || audit_running;
    let mut result = HostStatus {
        kind: "kunpeng-intelligence-host",
        enabled: configuration.enabled,
        launch_at_login: configuration.launch_at_login,
        continuous_processing_active: continuous_processing_active(),
        configuration_ready: configuration_ready(configuration),
        pipeline_running: effective_pipeline_running,
        archive_present: false,
        worker_available: worker_path(configuration).is_some(),
        sources_configured: configuration.sources_file.is_some(),
        triage_configured: configuration.triage.is_some(),
        processing_configured: configuration.embedding.is_some()
            && configuration.reranker.is_some()
            && configuration.deep_review.is_some(),
        article_count: 0,
        queued_count: 0,
        ready_for_triage_count: 0,
        awaiting_full_text_count: 0,
        historical_backfill_count: 0,
        evidence_version_mismatch_count: 0,
        full_text_backfill: FullTextBackfillHealth::default(),
        ready_for_relation_count: 0,
        ready_for_editorial_count: 0,
        kept_count: 0,
        filtered_count: 0,
        full_text_count: 0,
        processed_count: 0,
        current_stage: persisted_audit
            .as_ref()
            .filter(|_| audit_running)
            .map(|audit| audit.current_stage.clone()),
        audit_run: persisted_audit
            .as_ref()
            .map(|audit| project_host_audit(audit, audit_running)),
        audit_summary: Vec::new(),
        last_run: last_run.as_ref().map(project_run_report).or_else(|| {
            persisted_audit
                .as_ref()
                .and_then(|audit| audit.report.as_ref().map(project_run_report))
        }),
        last_error: persisted_audit
            .as_ref()
            .filter(|audit| audit.status == "running" && !audit_running && !pipeline_running)
            .map(|_| "上一轮本机处理已中断；可安全重新运行，已完成的归档和模型结果会复用。".into()),
    };
    // Status is displayed whenever the workbench view opens.  It must remain
    // observatory-only: initializing/migrating the archive is an explicit
    // operator action, never a side effect of looking at this projection.
    let Ok(path) = archive::existing_store_path() else {
        return result;
    };
    result.archive_present = path.is_file();
    if !result.archive_present {
        return result;
    }
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return result;
    };
    let query = "SELECT COUNT(*),
                 COALESCE(SUM(CASE WHEN triage_state='queued' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state='queued' AND EXISTS (
                    SELECT 1 FROM intelligence_article_content_versions content
                    WHERE content.article_id=intelligence_articles.article_id
                      AND content.record_fingerprint=intelligence_articles.fingerprint
                      AND content.is_current=1 AND content.body_status='complete'
                 ) THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state='queued' AND NOT EXISTS (
                    SELECT 1 FROM intelligence_article_content_versions content
                    WHERE content.article_id=intelligence_articles.article_id
                      AND content.record_fingerprint=intelligence_articles.fingerprint
                      AND content.is_current=1 AND content.body_status='complete'
                 ) THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state<>'queued' AND NOT EXISTS (
                    SELECT 1 FROM intelligence_article_content_versions content
                    WHERE content.article_id=intelligence_articles.article_id
                      AND content.record_fingerprint=intelligence_articles.fingerprint
                      AND content.is_current=1 AND content.body_status='complete'
                 ) THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state='keep' AND EXISTS (
                    SELECT 1 FROM intelligence_article_content_versions content
                    WHERE content.article_id=intelligence_articles.article_id
                      AND content.record_fingerprint=intelligence_articles.fingerprint
                      AND content.is_current=1 AND content.body_status='complete'
                 ) AND EXISTS (
                    SELECT 1 FROM intelligence_worker_canonical_aliases canonical
                    WHERE canonical.article_id=intelligence_articles.article_id
                      AND canonical.fingerprint=intelligence_articles.fingerprint
                      AND canonical.canonical_article_id=intelligence_articles.article_id
                      AND canonical.canonical_fingerprint=intelligence_articles.fingerprint
                 ) AND NOT EXISTS (
                    SELECT 1 FROM intelligence_worker_processed_articles processed
                    WHERE processed.article_id=intelligence_articles.article_id
                      AND processed.fingerprint=intelligence_articles.fingerprint
                      AND processed.status IN ('relation_ready','completed')
                 ) THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state='keep' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN triage_state='filter' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM intelligence_article_content_versions content
                    WHERE content.article_id=intelligence_articles.article_id
                      AND content.record_fingerprint=intelligence_articles.fingerprint
                      AND content.is_current=1 AND content.body_status='complete'
                 ) THEN 1 ELSE 0 END), 0)
                 FROM intelligence_articles";
    if let Ok((
        articles,
        queued,
        ready_for_triage,
        awaiting_full_text,
        historical_backfill,
        ready_for_relation,
        kept,
        filtered,
        complete,
    )) = connection.query_row(query, [], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, u64>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, u64>(3)?,
            row.get::<_, u64>(4)?,
            row.get::<_, u64>(5)?,
            row.get::<_, u64>(6)?,
            row.get::<_, u64>(7)?,
            row.get::<_, u64>(8)?,
        ))
    }) {
        result.article_count = articles;
        result.queued_count = queued;
        result.ready_for_triage_count = ready_for_triage;
        result.awaiting_full_text_count = awaiting_full_text;
        result.historical_backfill_count = historical_backfill;
        result.ready_for_relation_count = ready_for_relation;
        result.kept_count = kept;
        result.filtered_count = filtered;
        result.full_text_count = complete;
    }
    result.processed_count = connection
        .query_row("SELECT COUNT(*) FROM intelligence_events", [], |row| {
            row.get::<_, u64>(0)
        })
        .unwrap_or(0);
    result.audit_summary = persisted_audit
        .as_ref()
        .map(|audit| summary_from_host_audit(audit, audit_running))
        .unwrap_or_default();
    result.ready_for_editorial_count = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_articles a
             JOIN intelligence_worker_canonical_aliases canonical
               ON canonical.article_id=a.article_id AND canonical.fingerprint=a.fingerprint
              AND canonical.canonical_article_id=a.article_id
              AND canonical.canonical_fingerprint=a.fingerprint
             JOIN intelligence_worker_processed_articles p
               ON p.article_id=a.article_id AND p.fingerprint=a.fingerprint
             WHERE a.triage_state='keep' AND p.status='relation_ready'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .unwrap_or(0);
    result.full_text_backfill = full_text_backfill_health(&connection, unix_millis());
    result.evidence_version_mismatch_count = evidence_version_mismatch_count(&connection);
    result
}

fn evidence_version_mismatch_count(connection: &Connection) -> u64 {
    if !sqlite_table_exists(connection, "intelligence_articles")
        || !sqlite_table_exists(connection, "intelligence_article_content_versions")
    {
        return 0;
    }
    connection
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN NOT EXISTS (
                 SELECT 1 FROM intelligence_article_content_versions current_content
                 WHERE current_content.article_id=a.article_id
                   AND current_content.record_fingerprint=a.fingerprint
                   AND current_content.is_current=1
                   AND current_content.body_status='complete'
               ) AND EXISTS (
                 SELECT 1 FROM intelligence_article_content_versions old_content
                 WHERE old_content.article_id=a.article_id
                   AND old_content.record_fingerprint<>a.fingerprint
                   AND old_content.body_status='complete'
               ) THEN 1 ELSE 0 END),0)
             FROM intelligence_articles a",
            [],
            |row| row.get::<_, u64>(0),
        )
        .unwrap_or(0)
}

const FULL_TEXT_BACKFILL_FAILURE_CATEGORIES: &[&str] = &[
    "http_access_denied",
    "http_not_found",
    "http_rate_limited",
    "http_server_error",
    "network_request_failed",
    "body_paywall_or_interstitial",
    "body_not_found",
    "content_extraction_failed",
    // A recent Google News wrapper can remain a valid discovery record while
    // exposing no verifiable publisher target.  It is intentionally terminal
    // for body backfill, but must remain visible as its own queue class rather
    // than being folded into `other` and mistaken for extractor debt.
    "google_news_discovery_only",
    // Older catalogs persisted this narrower predecessor.  Keep it visible
    // while the archive is upgraded instead of rewriting durable history.
    "google_news_target_unresolved",
    "archive_persist_failed",
    // Catalogs written before the narrower public evidence taxonomy used a
    // combined extraction/paywall outcome and a generic HTTP rejection.  Keep
    // those durable records visible to the operator instead of collapsing
    // them into `other`; the names intentionally state that the old data does
    // not let us distinguish the more specific modern causes.
    "legacy_extraction_or_paywall",
    "legacy_http_rejected",
    "other",
];

fn stable_backfill_failure_category(reason: &str) -> &str {
    if FULL_TEXT_BACKFILL_FAILURE_CATEGORIES.contains(&reason) {
        reason
    } else {
        match reason {
            "body_missing_or_paywall" => "legacy_extraction_or_paywall",
            "http_status_rejected" => "legacy_http_rejected",
            _ => "other",
        }
    }
}

fn full_text_backfill_health(connection: &Connection, now_millis: i64) -> FullTextBackfillHealth {
    let mut health = FullTextBackfillHealth {
        failure_categories: FULL_TEXT_BACKFILL_FAILURE_CATEGORIES
            .iter()
            .map(|category| FullTextBackfillFailureCount { category, count: 0 })
            .collect(),
        ..FullTextBackfillHealth::default()
    };
    if !sqlite_table_exists(connection, "intelligence_articles") {
        return health;
    }

    let has_content_versions =
        sqlite_table_exists(connection, "intelligence_article_content_versions");
    let has_collection_records = sqlite_table_exists(connection, "intelligence_collection_records");
    let has_article_state = sqlite_table_exists(connection, "intelligence_content_backfill_state");
    let has_host_state = sqlite_table_exists(connection, "intelligence_content_backfill_hosts");
    let complete_evidence = if has_content_versions {
        "NOT EXISTS (SELECT 1 FROM intelligence_article_content_versions content
          WHERE content.article_id=a.article_id
            AND content.record_fingerprint=a.fingerprint
            AND content.is_current=1 AND content.body_status='complete')"
    } else {
        "1=1"
    };
    let public_source = if has_collection_records {
        "(NULLIF(a.url,'') LIKE 'https://%' OR EXISTS (
          SELECT 1 FROM intelligence_collection_records record
           WHERE record.article_id=a.article_id
             AND record.normalized_url LIKE 'https://%'))"
    } else {
        "NULLIF(a.url,'') LIKE 'https://%'"
    };

    let pending = format!(
        "WITH pending AS (
           SELECT a.article_id FROM intelligence_articles a
            WHERE {complete_evidence} AND {public_source}
         )"
    );
    let article_health = if has_article_state {
        format!(
            "{pending}
             SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN state.article_id IS NULL
                                       OR state.next_retry_at<=?1 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN state.next_retry_at>?1 THEN 1 ELSE 0 END),0)
               FROM pending
               LEFT JOIN intelligence_content_backfill_state state
                 ON state.article_id=pending.article_id"
        )
    } else {
        // Keep the same bound parameter shape as the stateful branch.  Status
        // is read-only and old catalogs without the retry table treat every
        // source-backed evidence gap as immediately eligible.
        format!("{pending} SELECT COUNT(*),COUNT(*),0 FROM pending WHERE ?1 IS NOT NULL")
    };
    if let Ok((waiting, retryable, delayed)) =
        connection.query_row(&article_health, [now_millis], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })
    {
        health.waiting_count = waiting;
        health.retryable_now_count = retryable;
        health.delayed_count = delayed;
    }

    if has_host_state {
        health.limited_host_count = connection
            .query_row(
                "SELECT COUNT(*) FROM intelligence_content_backfill_hosts WHERE next_allowed_at>?1",
                [now_millis],
                |row| row.get::<_, u64>(0),
            )
            .unwrap_or(0);
        // Older pre-circuit catalogs can have the table but not the newer
        // failure-count columns.  A failed read must leave this optional
        // operator projection at zero rather than making status unavailable.
        if let Ok((known, healthy, degraded, circuit_open)) = connection.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN failure_count<=0 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN failure_count>0 AND next_allowed_at<=?1 THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN next_allowed_at>?1 THEN 1 ELSE 0 END),0)
               FROM intelligence_content_backfill_hosts",
            [now_millis],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            },
        ) {
            health.known_source_count = known;
            health.healthy_source_count = healthy;
            health.degraded_source_count = degraded;
            health.circuit_open_source_count = circuit_open;
        }
    }
    if has_article_state {
        let mut failure_counts = match connection.prepare(
            "SELECT last_failure_reason,COUNT(*)
               FROM intelligence_content_backfill_state
              WHERE attempts>0 AND last_failure_reason IS NOT NULL
              GROUP BY last_failure_reason",
        ) {
            Ok(statement) => statement,
            Err(_) => return health,
        };
        let rows = match failure_counts.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        }) {
            Ok(rows) => rows,
            Err(_) => return health,
        };
        for row in rows.flatten() {
            let (reason, count) = row;
            let category = stable_backfill_failure_category(&reason);
            if let Some(target) = health
                .failure_categories
                .iter_mut()
                .find(|item| item.category == category)
            {
                target.count = target.count.saturating_add(count);
            }
        }
    }
    health
}

fn sqlite_table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .is_ok_and(|present| present != 0)
}

fn audit_is_running(audit: Option<&HostRunAudit>) -> bool {
    audit.is_some_and(|value| value.status == "running" && audit_owner_is_alive(value.runner_pid))
}

fn audit_owner_is_alive(pid: u32) -> bool {
    if pid == 0 {
        // Legacy audit records did not have an owner identity.  Fail closed:
        // they remain visible as history but cannot hold the UI in `running`.
        return false;
    }
    #[cfg(windows)]
    unsafe {
        type Handle = *mut core::ffi::c_void;
        unsafe extern "system" {
            fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
            fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
            fn CloseHandle(handle: Handle) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE;
        let _ = CloseHandle(handle);
        result
    }
    #[cfg(all(unix, not(windows)))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).is_dir()
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
    }
}

fn child_output(
    configuration: &HostConfiguration,
    mode: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    child_output_args_with_backfill_pass(configuration, &[mode], timeout, None)
}

/// Invoke a fixed worker mode plus its validated bounded arguments.  The host
/// never forwards dashboard text here: callers supply only static flags and
/// decimal limits derived from trusted host configuration.
fn child_output_args(
    configuration: &HostConfiguration,
    args: &[&str],
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    child_output_args_with_backfill_pass(configuration, args, timeout, None)
}

/// The operator page needs a retry boundary, not a raw process error. Keep the
/// mapping narrow so local paths, provider output and arguments never enter a
/// durable audit report.
fn relation_worker_failure_code(error: &str) -> &'static str {
    match error {
        "本机情报 worker 超时；已停止本轮处理" => "relation_worker_timeout",
        "本机情报 worker 未成功完成本轮任务" => "relation_worker_nonzero",
        "本机情报 worker 返回无效状态" => "relation_worker_invalid_status",
        _ => "relation_judge_model_transport",
    }
}

/// A host round can run several bounded evidence batches.  Keep their common
/// pass identifier out of the dashboard and logs, but pass it to the worker so
/// a failure which becomes retryable after the short backoff cannot be fetched
/// twice by later batches in the same operator-visible round.
fn child_output_args_with_backfill_pass(
    configuration: &HostConfiguration,
    args: &[&str],
    timeout: Duration,
    backfill_pass_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let worker = worker_path(configuration).ok_or("未找到本机情报 worker；请先安装阅读器组件")?;
    let mut command = Command::new(worker);
    command
        .args(args)
        .args(crate::profile::child_profile_args())
        .env("KUNPENG_INTELLIGENCE_WORKER_ENABLED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // Each host round runs short-lived workers. Their JSON output is
        // captured below, so Windows must not create a visible console for
        // every collection or backfill batch.
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    if let Some(pass_id) = backfill_pass_id {
        command.env("KUNPENG_INTELLIGENCE_BACKFILL_PASS_ID", pass_id);
    }
    if let Some(path) = configuration.sources_file.as_deref() {
        command.env("KUNPENG_INTELLIGENCE_COLLECTOR_SOURCES", path);
    }
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_TRIAGE",
        configuration.triage.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_EMBEDDING",
        configuration.embedding.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_RERANKER",
        configuration.reranker.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_DEEP",
        configuration.deep_review.as_ref(),
    );
    let output = command_output_with_timeout(
        &mut command,
        timeout,
        "无法启动本机情报 worker",
        "本机情报 worker 超时；已停止本轮处理",
    )?;
    if !output.status.success() {
        return Err("本机情报 worker 未成功完成本轮任务".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "本机情报 worker 返回无效状态".into())
}

fn set_route(command: &mut Command, prefix: &str, route: Option<&ModelRoute>) {
    if let Some(route) = route {
        command
            .env(format!("{prefix}_BASE_URL"), &route.base_url)
            .env(format!("{prefix}_MODEL"), &route.model)
            .env(format!("{prefix}_MODEL_SHA256"), &route.artifact_sha256);
    }
}

fn number(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn text(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

/// Optional worker diagnostics must remain empty after a successful phase.
/// Rendering a missing `processingFailure` as `unknown` made a healthy 8B or
/// 27B pass look suspicious in the aggregate-only audit view.
fn optional_text(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Starts the independently guarded publisher/relay service.  It reads its
/// own DPAPI-protected capability record; no credential or server origin is
/// passed through this host's command line, environment, audit, or local UI.
/// The worker mutex makes repeated starts safe when the reader or the Windows
/// login entry has already launched the service.
fn ensure_distribution_sidecar(configuration: &HostConfiguration) -> String {
    let Some(worker) = worker_path(configuration) else {
        return "distribution_worker_unavailable".into();
    };
    match distribution_sidecar_command(&worker, configuration).spawn() {
        Ok(_) => "distribution_worker_start_requested".into(),
        Err(_) => "distribution_worker_unavailable".into(),
    }
}

fn distribution_sidecar_command(worker: &Path, configuration: &HostConfiguration) -> Command {
    let mut command = Command::new(worker);
    command
        .arg("--service-loop")
        .args(crate::profile::child_profile_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.env("KUNPENG_INTELLIGENCE_WORKER_ENABLED", "1");
    if let Some(path) = configuration.sources_file.as_deref() {
        command.env("KUNPENG_INTELLIGENCE_COLLECTOR_SOURCES", path);
    }
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_TRIAGE",
        configuration.triage.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_EMBEDDING",
        configuration.embedding.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_RERANKER",
        configuration.reranker.as_ref(),
    );
    set_route(
        &mut command,
        "KUNPENG_INTELLIGENCE_DEEP",
        configuration.deep_review.as_ref(),
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command
}

fn begin_audit_stage(path: &Path, audit: &mut HostRunAudit, stage: &str) -> Result<(), String> {
    audit.begin_stage(stage);
    write_host_audit(path, audit).map_err(|_| "无法写入本机处理审计状态".to_string())
}

fn run_once(configuration: &HostConfiguration) -> Result<RunReport, String> {
    if continuous_processing_active() {
        return Err("本机情报持续处理正在运行；请先停止后再执行手动一轮".into());
    }
    run_once_with_pipeline_guard(configuration)
}

/// The durable continuous loop already owns the `Loop` guard, so it uses the
/// shared pipeline guard directly rather than treating itself as a conflicting
/// manual execution.
fn run_once_from_continuous_loop(configuration: &HostConfiguration) -> Result<RunReport, String> {
    run_once_with_pipeline_guard_and_stop(configuration, true)
}

fn run_once_unlocked(
    configuration: &HostConfiguration,
    stop_when_disabled: bool,
) -> Result<RunReport, String> {
    if !configuration.enabled {
        return Ok(RunReport {
            outcome: "disabled".into(),
            ..RunReport::default()
        });
    }
    if configuration.sources_file.is_none() {
        return Ok(RunReport {
            outcome: "collector_not_configured".into(),
            ..RunReport::default()
        });
    }
    let audit_path = host_audit_path()?;
    let mut audit = HostRunAudit::start();
    write_host_audit(&audit_path, &audit).map_err(|_| "无法写入本机处理审计状态".to_string())?;
    let result = run_once_with_audit(configuration, &audit_path, &mut audit, stop_when_disabled);
    match &result {
        Ok(report) => audit.finish(audit_completion_status(report), Some(report.clone())),
        Err(_) => audit.finish("failed", None),
    }
    write_host_audit(&audit_path, &audit).map_err(|_| "无法写入本机处理审计状态".to_string())?;
    result
}

fn audit_completion_status(report: &RunReport) -> &'static str {
    match report.outcome.as_str() {
        "relation_processing_incomplete" | "processing_incomplete" | "triage_incomplete" => {
            "failed"
        }
        "stopped_by_operator" => "stopped",
        _ => "completed",
    }
}

/// A failed transient configuration read must not turn into a destructive
/// cancellation.  Only a successfully read, explicitly disabled setting asks
/// a continuous loop to stop after its current worker child returns.
fn operator_stop_requested(stop_when_disabled: bool) -> bool {
    stop_when_disabled && read_configuration().is_ok_and(|configuration| !configuration.enabled)
}

/// Freeze/publish the two intentionally separate formal lanes in a stable
/// order.  The current event lane is bounded to one immutable event revision;
/// the daily lane remains the completed previous-UTC-day retrospective.  The
/// worker alone reads any DPAPI-protected capability, so this control plane
/// neither receives nor logs a server address or credential.
fn publish_ready_outputs(configuration: &HostConfiguration) -> Result<(String, String), String> {
    let event = child_output(configuration, "--publish-event-once", TRIAGE_TIMEOUT)?;
    let daily = child_output(configuration, "--publish-daily-once", TRIAGE_TIMEOUT)?;
    Ok((text(&event, "outcome"), text(&daily, "outcome")))
}

fn run_once_with_audit(
    configuration: &HostConfiguration,
    audit_path: &Path,
    audit: &mut HostRunAudit,
    stop_when_disabled: bool,
) -> Result<RunReport, String> {
    let distribution_service = ensure_distribution_sidecar(configuration);
    let pipeline = (|| -> Result<RunReport, String> {
        begin_audit_stage(audit_path, audit, "collection")?;
        let collected = child_output(configuration, "--collect-once", COLLECTION_TIMEOUT)?;
        let mut report = RunReport {
            outcome: "evidence_completed".into(),
            collection: text(&collected, "outcome"),
            collected: number(&collected, "collected"),
            duplicates: number(&collected, "duplicates"),
            ..RunReport::default()
        };
        let collection_completed = report.collection == "collected";
        if !collection_completed {
            report.outcome = "collection_incomplete".into();
            // Full-text repair has its own durable scheduler. A collection
            // failure must still keep the model lane fail-closed for this
            // round, but evidence retries do not depend on 8B/27B availability.
            return Ok(report);
        }
        if operator_stop_requested(stop_when_disabled) {
            report.outcome = "stopped_by_operator".into();
            return Ok(report);
        }
        if !model_processing_ready(configuration) {
            report.outcome = "evidence_completed_models_not_configured".into();
            return Ok(report);
        }
        let awaiting_full_text = status(configuration, None, false).awaiting_full_text_count;
        // Network evidence acquisition and model judgment are both durable.
        // With a large archive backlog, give the next loop a chance to fetch
        // more bodies instead of holding the GPU for a long, monolithic
        // triage/relation pass.
        let triage_limit =
            balanced_model_stage_limit(configuration.max_triage_per_run, awaiting_full_text);
        let relation_limit =
            balanced_model_stage_limit(configuration.max_processing_per_run, awaiting_full_text);
        let mut acquired_model_phase = false;

        // Phase 1 owns the GPU with the 7/8B judge while the 0.6B retrieval
        // services remain available.  It is deliberately conditional: a large
        // archive-backfill queue is not a model queue, so it must not make an
        // unavailable CUDA provider prevent ordinary collection or archiving.
        if status(configuration, None, false).ready_for_triage_count > 0
            || status(configuration, None, false).ready_for_relation_count > 0
        {
            begin_audit_stage(audit_path, audit, "triage_runtime")?;
            match switch_runtime_phase("TriageGpu") {
                Ok(()) => {
                    acquired_model_phase = true;
                    begin_audit_stage(audit_path, audit, "triage_runtime_ready")?;
                }
                Err(_error) => {
                    report.outcome = "triage_runtime_unavailable".into();
                    begin_audit_stage(audit_path, audit, "publication_without_model")?;
                    let (event, daily) = publish_ready_outputs(configuration)?;
                    report.event_publication = event;
                    report.publication = daily;
                    return Ok(report);
                }
            }
        }

        let work = (|| -> Result<RunReport, String> {
            for _ in 0..triage_limit {
                if operator_stop_requested(stop_when_disabled) {
                    report.outcome = "stopped_by_operator".into();
                    return Ok(report);
                }
                if status(configuration, None, false).ready_for_triage_count == 0 {
                    break;
                }
                begin_audit_stage(audit_path, audit, "small_model_triage")?;
                let value = child_output(configuration, "--once", TRIAGE_TIMEOUT)?;
                match text(&value, "outcome").as_str() {
                    "triaged" => report.triaged += number(&value, "triaged"),
                    "retry_scheduled" => report.retried += number(&value, "retried"),
                    "idle" => break,
                    _ => {
                        report.outcome = "triage_incomplete".into();
                        break;
                    }
                }
            }
            // 0.6B retrieval and the 8B relation judge share this same GPU
            // phase.  Persist their result before the runtime swaps to 27B;
            // a restart can resume from `relation_ready` without repeating
            // either the collector or the expensive editorial work.
            let mut remaining_relation_runs = relation_limit;
            while remaining_relation_runs > 0 {
                if operator_stop_requested(stop_when_disabled) {
                    report.outcome = "stopped_by_operator".into();
                    return Ok(report);
                }
                let batch = remaining_relation_runs.min(RELATION_BATCH_SIZE);
                begin_audit_stage(audit_path, audit, "vector_recall_and_relation")?;
                let batch_argument = batch.to_string();
                let value = match child_output_args(
                    configuration,
                    &["--relate-batch", &batch_argument],
                    RELATION_TIMEOUT,
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        report.relation = "processing_retry_scheduled".into();
                        report.relation_failure = relation_worker_failure_code(&error).into();
                        report.outcome = "relation_processing_incomplete".into();
                        return Ok(report);
                    }
                };
                report.relation = text(&value, "outcome");
                report.relation_failure = optional_text(&value, "processingFailure");
                match report.relation.as_str() {
                    "processed" => remaining_relation_runs -= batch,
                    "processing_idle" => break,
                    _ => {
                        report.outcome = "relation_processing_incomplete".into();
                        break;
                    }
                }
            }
            // Phase 2 stops the judge before loading 27B.  Only a kept article
            // with a complete current body can enter this phase; titles, RSS
            // snippets and incomplete legacy records are never 27B inputs.
            if operator_stop_requested(stop_when_disabled) {
                report.outcome = "stopped_by_operator".into();
                return Ok(report);
            }
            if status(configuration, None, false).ready_for_editorial_count > 0 {
                begin_audit_stage(audit_path, audit, "editorial_runtime")?;
                match switch_runtime_phase("EditorialGpu") {
                    Ok(()) => {
                        acquired_model_phase = true;
                        begin_audit_stage(audit_path, audit, "editorial_runtime_ready")?;
                    }
                    Err(_) => {
                        report.outcome = "editorial_runtime_unavailable".into();
                    }
                }
                if report.outcome != "editorial_runtime_unavailable" {
                    let editorial_limit = editorial_batch_limit(
                        configuration.max_editorial_per_run,
                        status(configuration, None, false).ready_for_editorial_count,
                    );
                    for _ in 0..editorial_limit {
                        if operator_stop_requested(stop_when_disabled) {
                            report.outcome = "stopped_by_operator".into();
                            return Ok(report);
                        }
                        if status(configuration, None, false).ready_for_editorial_count == 0 {
                            break;
                        }
                        begin_audit_stage(audit_path, audit, "editorial_synthesis")?;
                        let value =
                            child_output(configuration, "--synthesize-once", EDITORIAL_TIMEOUT)?;
                        let editorial_outcome = text(&value, "outcome");
                        report.editorial_failure = optional_text(&value, "processingFailure");
                        match editorial_outcome.as_str() {
                            "processed" => {
                                report.processed += number(&value, "processed");
                                report.reviewed += number(&value, "reviewed");
                            }
                            "processing_idle" => break,
                            _ => {
                                report.outcome = "processing_incomplete".into();
                                break;
                            }
                        }
                    }
                }
            }
            // The worker itself reads an optional DPAPI-protected publisher pairing.
            // This control plane forwards neither a token nor a server address; an
            // unpaired workstation first freezes a local daily draft and reports
            // `daily_prepared_locally` instead of attempting any outbound call.
            if operator_stop_requested(stop_when_disabled) {
                report.outcome = "stopped_by_operator".into();
                return Ok(report);
            }
            begin_audit_stage(audit_path, audit, "publication")?;
            let (event, daily) = publish_ready_outputs(configuration)?;
            report.event_publication = event;
            report.publication = daily;
            Ok(report)
        })();
        // Leave the machine responsive after a background round.  The next round
        // will acquire its required phase again; this also avoids holding 27B in
        // VRAM while the user reads or opens the desktop client.
        let cleanup = if acquired_model_phase {
            switch_runtime_phase("CoreOnly")
        } else {
            Ok(())
        };
        match (work, cleanup) {
            (Ok(report), Ok(())) => Ok(report),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(cleanup)) => Err(cleanup),
            (Err(error), Err(cleanup)) => {
                Err(format!("{error}；恢复本机模型空闲状态也失败：{cleanup}"))
            }
        }
    })();
    pipeline.map(|mut report| {
        report.distribution_service = distribution_service;
        report
    })
}

/// Performs a small, evidence-only slice while holding the same guard used by
/// the collection/model pipeline. `Ok(false)` means the main pipeline owns
/// the guard at the moment, so the scheduler yielded without starting a
/// worker. This is intentional: SQLite writes are never concurrent.
fn run_backfill_scheduler_cycle(configuration: &HostConfiguration) -> Result<bool, String> {
    if !configuration.enabled || configuration.sources_file.is_none() {
        return Ok(false);
    }
    let Some(_pipeline_guard) = acquire_host_guard("Pipeline")? else {
        return Ok(false);
    };
    let awaiting_full_text = status(configuration, None, false).awaiting_full_text_count;
    let batch_limit = background_backfill_batch_limit(
        configuration.max_backfill_batches_per_run,
        awaiting_full_text,
    );
    if batch_limit == 0 {
        return Ok(false);
    }
    let backfill_pass_id = uuid::Uuid::new_v4().to_string();
    let mut attempted_work = false;
    for _ in 0..batch_limit {
        let value = child_output_args_with_backfill_pass(
            configuration,
            &["--backfill-content-once"],
            BACKFILL_TIMEOUT,
            Some(&backfill_pass_id),
        )?;
        if text(&value, "outcome") != "content_backfilled" {
            return Err("本机情报正文补全未成功完成本轮任务".into());
        }
        let attempted = number(&value, "backfillAttempted");
        attempted_work |= attempted > 0;
        // The worker has no currently eligible rows. Do not consume the
        // scheduler's writer turn with another identical no-op invocation.
        if attempted == 0 {
            break;
        }
    }
    Ok(attempted_work)
}

/// Dedicated no-window loop for public full-text repair. It intentionally
/// does not start or stop any GPU runtime. A transient download/SQLite error
/// is retried in a later slice and never prevents the ordinary collection,
/// 8B or 27B loop from continuing.
fn run_backfill_loop() -> i32 {
    let Some(_backfill_guard) = (match acquire_host_guard("Backfill") {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    }) else {
        println!(
            "{}",
            serde_json::json!({"ok": true, "outcome": "backfill_already_running"})
        );
        return 0;
    };
    loop {
        let configuration = match read_configuration() {
            Ok(configuration) if configuration.enabled => configuration,
            Ok(_) => return 0,
            Err(_) => {
                std::thread::sleep(FULL_TEXT_BACKFILL_ACTIVE_INTERVAL);
                continue;
            }
        };
        let _ = run_backfill_scheduler_cycle(&configuration);
        let waiting = status(&configuration, None, false).awaiting_full_text_count;
        let interval = if waiting > 0 {
            FULL_TEXT_BACKFILL_ACTIVE_INTERVAL
        } else {
            FULL_TEXT_BACKFILL_IDLE_INTERVAL
        };
        let mut remaining = interval;
        while remaining > Duration::ZERO {
            let step = remaining.min(Duration::from_secs(1));
            std::thread::sleep(step);
            remaining = remaining.saturating_sub(step);
            if !read_configuration().is_ok_and(|configuration| configuration.enabled) {
                return 0;
            }
        }
    }
}

/// Long-running no-UI mode for a dedicated host machine. Configuration is
/// reloaded between rounds, so disabling the switch or replacing a local
/// model route takes effect without restarting the process.
fn run_loop() -> i32 {
    let Some(_loop_guard) = (match acquire_host_guard("Loop") {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    }) else {
        // A dashboard may have spawned a loop just before a login startup
        // entry fires.  Treat that as a harmless duplicate, not a second
        // writer of archive state or a user-visible failure.
        println!(
            "{}",
            serde_json::json!({"ok": true, "outcome": "already_running"})
        );
        return 0;
    };
    let initial = read_configuration().unwrap_or_default();
    if !initial.enabled {
        println!("{}", serde_json::json!({"ok": true, "outcome": "disabled"}));
        return 0;
    }
    let _ = ensure_distribution_sidecar(&initial);
    loop {
        let (value, yielded_to_backfill) = match read_configuration() {
            Ok(configuration) if !configuration.enabled => break,
            Ok(configuration) => match run_once_from_continuous_loop(&configuration) {
                Ok(report) => (serde_json::json!({"ok": true, "report": report}), false),
                // Full-text repair and the main pipeline deliberately share a
                // single writer guard. A failed try-lock is a normal yield, not
                // a failed processing round; retry promptly so the fast
                // backfill lane cannot starve 8B relation work or 27B editing.
                Err(error) if error == "已有本机情报处理正在运行" => (
                    serde_json::json!({"ok": true, "outcome": "yielded_to_backfill"}),
                    true,
                ),
                Err(error) => (serde_json::json!({"ok": false, "error": error}), false),
            },
            Err(error) => (serde_json::json!({"ok": false, "error": error}), false),
        };
        println!("{}", value);
        // While durable evidence or model work is waiting, the host should
        // drain it promptly rather than pretending a five-minute polling loop
        // can process thousands of retained articles.  The worker still owns
        // per-source limits and retry scheduling; this only removes avoidable
        // idle time between safe bounded rounds.
        let interval = if yielded_to_backfill {
            Duration::from_secs(2)
        } else {
            match read_configuration() {
                Ok(configuration) => {
                    let projection = status(&configuration, None, false);
                    if projection.awaiting_full_text_count > 0
                        || projection.ready_for_triage_count > 0
                        || projection.ready_for_relation_count > 0
                        || projection.ready_for_editorial_count > 0
                    {
                        WORKSTATION_ACTIVE_LOOP_INTERVAL
                    } else {
                        WORKSTATION_LOOP_INTERVAL
                    }
                }
                Err(_) => WORKSTATION_LOOP_INTERVAL,
            }
        };
        // A stop command changes only durable local configuration.  Polling
        // once per second makes that command observable promptly while never
        // force-killing collection, archive or model work mid-round.
        let mut remaining = interval;
        while remaining > Duration::ZERO {
            let step = remaining.min(Duration::from_secs(1));
            std::thread::sleep(step);
            remaining = remaining.saturating_sub(step);
            if !read_configuration().is_ok_and(|configuration| configuration.enabled) {
                return 0;
            }
        }
    }
    0
}
pub(crate) fn run(arguments: impl IntoIterator<Item = OsString>) -> i32 {
    let arguments = crate::profile::application_args(arguments)
        .into_iter()
        .skip(1)
        .collect::<Vec<_>>();
    let command = arguments
        .first()
        .and_then(|value| value.to_str())
        .unwrap_or("--status");
    let configuration = match read_configuration() {
        Ok(configuration) => configuration,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let sources_were_configured = configuration.sources_file.is_some();
    match command {
        "--init" => match initialize_configuration() {
            Ok(_) => {
                let source_state = if sources_were_configured {
                    "已保留现有来源配置"
                } else {
                    "已生成可编辑的默认公开来源"
                };
                println!("本机情报工作台配置已创建；{source_state}。请配置并启用本机模型后执行 --run-once 或 --loop");
                0
            }
            Err(error) => {
                eprintln!("{error}");
                2
            }
        },
        "--status" if arguments.len() == 1 || arguments.is_empty() => {
            println!(
                "{}",
                serde_json::to_string(&status(&configuration, None, false))
                    .expect("status serializes")
            );
            0
        }
        "--run-once" if arguments.len() == 1 => match run_once(&configuration) {
            Ok(report) => {
                println!(
                    "{}",
                    serde_json::to_string(&report).expect("report serializes")
                );
                0
            }
            Err(error) => {
                eprintln!("{error}");
                2
            }
        },
        "--dashboard" if arguments.len() <= 2 => {
            let port = match arguments.get(1).and_then(|value| value.to_str()) {
                None => dashboard::default_port(),
                Some(value) => match value.parse::<u16>() {
                    Ok(port) if port > 0 => port,
                    _ => {
                        eprintln!("工作台端口必须是 1–65535 的整数");
                        return 2;
                    }
                },
            };
            match dashboard::serve(port) {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("{error}");
                    2
                }
            }
        }
        "--loop" if arguments.len() == 1 => run_loop(),
        "--backfill-loop" if arguments.len() == 1 => run_backfill_loop(),
        _ => {
            eprintln!("用法：kunpeng-intelligence-host --init|--status|--run-once|--dashboard [端口]|--loop|--backfill-loop");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn defaults_are_safe_and_not_enabled() {
        let configuration = HostConfiguration::default();
        assert!(!configuration.enabled);
        assert_eq!(configuration.max_backfill_batches_per_run, 8);
        assert_eq!(configuration.max_editorial_per_run, 2);
        assert!(!configuration_ready(&configuration));
        assert!(!collection_ready(&configuration));
        validate_configuration(&configuration).unwrap();
    }

    #[test]
    fn large_full_text_backlog_yields_model_budget_without_disabling_work() {
        assert_eq!(balanced_model_stage_limit(120, 0), 120);
        assert_eq!(
            balanced_model_stage_limit(120, FULL_TEXT_BACKLOG_YIELD_THRESHOLD - 1),
            120
        );
        assert_eq!(
            balanced_model_stage_limit(120, FULL_TEXT_BACKLOG_YIELD_THRESHOLD),
            BACKLOG_MODEL_STAGE_LIMIT
        );
        assert_eq!(balanced_model_stage_limit(8, 10_000), 8);
        assert_eq!(balanced_model_stage_limit(0, 10_000), 1);
    }

    #[test]
    fn editorial_backlog_uses_a_bounded_batch_and_migrates_legacy_defaults() {
        assert_eq!(editorial_batch_limit(2, 0), 2);
        assert_eq!(
            editorial_batch_limit(2, FULL_TEXT_BACKLOG_YIELD_THRESHOLD),
            BACKLOG_EDITORIAL_BATCH_LIMIT
        );
        assert_eq!(editorial_batch_limit(8, 10_000), 8);

        let mut legacy = HostConfiguration {
            max_editorial_per_run: 1,
            max_backfill_batches_per_run: 4,
            ..HostConfiguration::default()
        };
        upgrade_legacy_throughput_limits(&mut legacy);
        assert_eq!(legacy.max_editorial_per_run, default_editorial_limit());
        assert_eq!(
            legacy.max_backfill_batches_per_run,
            default_backfill_batches_per_run()
        );
    }

    #[test]
    fn independent_backfill_scheduler_is_adaptive_but_yields_the_writer() {
        assert_eq!(background_backfill_batch_limit(8, 0), 0);
        assert_eq!(background_backfill_batch_limit(8, 1), 1);
        assert_eq!(
            background_backfill_batch_limit(8, FULL_TEXT_BACKLOG_YIELD_THRESHOLD),
            BACKGROUND_BACKFILL_BATCHES_PER_CYCLE
        );
        assert_eq!(
            background_backfill_batch_limit(1, FULL_TEXT_BACKLOG_YIELD_THRESHOLD),
            1
        );
        assert_eq!(
            background_backfill_batch_limit(40, FULL_TEXT_BACKLOG_YIELD_THRESHOLD + 1),
            BACKGROUND_BACKFILL_BATCHES_PER_CYCLE
        );
    }

    #[test]
    fn host_loop_and_manual_pipeline_guards_are_distinct_and_profile_scoped() {
        let loop_name = host_mutex_name("Loop");
        let pipeline_name = host_mutex_name("Pipeline");
        let backfill_name = host_mutex_name("Backfill");
        assert!(loop_name.starts_with("Local\\KunpengIntelligenceHostLoopV1"));
        assert!(pipeline_name.starts_with("Local\\KunpengIntelligenceHostPipelineV1"));
        assert!(backfill_name.starts_with("Local\\KunpengIntelligenceHostBackfillV1"));
        assert_ne!(loop_name, pipeline_name);
        assert_ne!(loop_name, backfill_name);
        assert_ne!(pipeline_name, backfill_name);
    }

    #[test]
    fn evidence_collection_does_not_wait_for_model_routes() {
        let configuration = HostConfiguration {
            enabled: true,
            sources_file: Some("C:\\public-sources.json".into()),
            ..HostConfiguration::default()
        };
        assert!(collection_ready(&configuration));
        assert!(!model_processing_ready(&configuration));
        assert!(!configuration_ready(&configuration));
    }

    #[test]
    fn model_processing_requires_the_evidence_and_all_pinned_roles() {
        let mut configuration = HostConfiguration {
            enabled: true,
            sources_file: Some("C:\\public-sources.json".into()),
            ..HostConfiguration::default()
        };
        assert!(!model_processing_ready(&configuration));
        configuration.triage = Some(ModelRoute {
            base_url: "http://127.0.0.1:8081/v1".into(),
            model: "Qwen3-8B-Q4_K_M".into(),
            artifact_sha256: "a".repeat(64),
        });
        configuration.embedding = Some(ModelRoute {
            base_url: "http://127.0.0.1:8082/v1".into(),
            model: "Qwen3-Embedding-0.6B-Q8_0".into(),
            artifact_sha256: "b".repeat(64),
        });
        configuration.reranker = Some(ModelRoute {
            base_url: "http://127.0.0.1:8083/v1".into(),
            model: "Qwen3-Reranker-0.6B-Q8_0".into(),
            artifact_sha256: "c".repeat(64),
        });
        configuration.deep_review = Some(ModelRoute {
            base_url: "http://127.0.0.1:8080/v1".into(),
            model: "Qwen3.8-27B-UD-Q3_K_XL".into(),
            artifact_sha256: "d".repeat(64),
        });
        assert!(model_processing_ready(&configuration));
    }

    #[test]
    fn default_sources_are_public_editable_and_do_not_enable_the_pipeline() {
        let template = default_sources_template();
        let sources = template
            .get("sources")
            .and_then(serde_json::Value::as_array)
            .expect("default sources");
        assert_eq!(sources.len(), 7);
        for source in sources {
            let url = source
                .get("url")
                .and_then(serde_json::Value::as_str)
                .expect("public URL");
            assert!(url.starts_with("https://"));
            assert!(!url.contains("localhost"));
            assert!(source.get("sourceId").is_some());
            assert!(source.get("kind").is_some());
        }
        assert!(!HostConfiguration::default().enabled);
    }

    #[test]
    fn initialization_defaults_match_the_pinned_loopback_runtime_roles() {
        let mut configuration = HostConfiguration {
            sources_file: Some(r"C:\\public-sources.json".into()),
            ..HostConfiguration::default()
        };
        configuration.triage.get_or_insert_with(|| ModelRoute {
            base_url: "http://127.0.0.1:8081/v1".into(),
            model: "Qwen3-8B-Q4_K_M".into(),
            artifact_sha256: "a".repeat(64),
        });
        configuration.embedding.get_or_insert_with(|| ModelRoute {
            base_url: "http://127.0.0.1:8082/v1".into(),
            model: "Qwen3-Embedding-0.6B-Q8_0".into(),
            artifact_sha256: "b".repeat(64),
        });
        configuration.reranker.get_or_insert_with(|| ModelRoute {
            base_url: "http://127.0.0.1:8083/v1".into(),
            model: "Qwen3-Reranker-0.6B-Q8_0".into(),
            artifact_sha256: "c".repeat(64),
        });
        configuration.deep_review.get_or_insert_with(|| ModelRoute {
            base_url: "http://127.0.0.1:8080/v1".into(),
            model: "Qwen3.8-27B-UD-Q3_K_XL".into(),
            artifact_sha256: "d".repeat(64),
        });
        validate_configuration(&configuration).unwrap();
        assert!(!configuration.enabled);
    }

    #[test]
    fn rejects_non_loopback_model_route() {
        let configuration = HostConfiguration {
            triage: Some(ModelRoute {
                base_url: "https://example.com/v1".into(),
                model: "judge-8b".into(),
                artifact_sha256: "a".repeat(64),
            }),
            ..HostConfiguration::default()
        };
        assert!(validate_configuration(&configuration).is_err());
    }

    #[test]
    fn rejects_an_unbounded_or_disabled_editorial_batch_limit() {
        let disabled = HostConfiguration {
            max_editorial_per_run: 0,
            ..HostConfiguration::default()
        };
        assert!(validate_configuration(&disabled).is_err());
        let unbounded = HostConfiguration {
            max_editorial_per_run: MAX_STAGE_RUNS + 1,
            ..HostConfiguration::default()
        };
        assert!(validate_configuration(&unbounded).is_err());
    }

    #[test]
    fn route_requires_model_for_its_role() {
        let configuration = HostConfiguration {
            deep_review: Some(ModelRoute {
                base_url: "http://127.0.0.1:8080/v1".into(),
                model: "qwen-8b".into(),
                artifact_sha256: "a".repeat(64),
            }),
            ..HostConfiguration::default()
        };
        assert!(validate_configuration(&configuration).is_err());
    }

    #[test]
    fn configured_model_route_requires_its_verified_artifact_hash() {
        let configuration = HostConfiguration {
            triage: Some(ModelRoute {
                base_url: "http://127.0.0.1:8081/v1".into(),
                model: "judge-8b".into(),
                artifact_sha256: "not-a-sha".into(),
            }),
            ..HostConfiguration::default()
        };
        assert!(validate_configuration(&configuration).is_err());
    }

    #[test]
    fn legacy_model_route_without_an_artifact_hash_is_safely_disabled() {
        let path = std::env::temp_dir().join(format!("host-config-{}.json", Uuid::new_v4()));
        let legacy = serde_json::json!({
            "version": 1,
            "maxTriagePerRun": 120,
            "maxProcessingPerRun": 120,
            "triage": {"baseUrl":"http://127.0.0.1:8081/v1","model":"judge-8b"}
        });
        fs::write(&path, legacy.to_string()).unwrap();
        let configuration = read_configuration_at(&path).unwrap();
        assert!(configuration.triage.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn status_does_not_disclose_paths_or_endpoints() {
        let configuration = HostConfiguration {
            enabled: true,
            sources_file: Some("C:\\private\\sources.json".into()),
            triage: Some(ModelRoute {
                base_url: "http://127.0.0.1:8081/v1".into(),
                model: "judge-8b".into(),
                artifact_sha256: "a".repeat(64),
            }),
            ..HostConfiguration::default()
        };
        let encoded = serde_json::to_string(&status(&configuration, None, true)).unwrap();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("8081"));
        assert!(encoded.contains("\"pipelineRunning\":true"));
        assert!(encoded.contains("\"launchAtLogin\":false"));
        assert!(encoded.contains("\"continuousProcessingActive\":"));
        // `status` also intentionally projects the live, aggregate-only
        // archive state.  Do not make this privacy test depend on whichever
        // durable queue happens to exist on the developer machine.
        assert!(serde_json::from_str::<serde_json::Value>(&encoded)
            .unwrap()
            .get("readyForEditorialCount")
            .is_some_and(serde_json::Value::is_u64));
    }

    #[test]
    fn full_text_backfill_health_is_aggregate_only_and_distinguishes_backoff() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE intelligence_articles(
                     article_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,url TEXT
                 );
                 CREATE TABLE intelligence_article_content_versions(
                     article_id TEXT,record_fingerprint TEXT,is_current INTEGER,body_status TEXT
                 );
                 CREATE TABLE intelligence_collection_records(
                     article_id TEXT,normalized_url TEXT
                 );
                 CREATE TABLE intelligence_content_backfill_state(
                     article_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,next_retry_at INTEGER NOT NULL,
                     last_failure_reason TEXT
                 );
                 CREATE TABLE intelligence_content_backfill_hosts(
                     host TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL,failure_count INTEGER NOT NULL
                 );
                 INSERT INTO intelligence_articles(article_id,fingerprint,url) VALUES
                    ('ready','one','https://redacted.invalid/ready'),
                    ('access','two','https://redacted.invalid/access'),
                    ('delayed','three','https://redacted.invalid/delayed'),
                    ('legacy-extraction','four','https://redacted.invalid/legacy-extraction'),
                    ('legacy-http','five','https://redacted.invalid/legacy-http'),
                    ('google-discovery','six','https://redacted.invalid/google-discovery'),
                    ('no-source','four','');
                 INSERT INTO intelligence_content_backfill_state(article_id,attempts,next_retry_at,last_failure_reason) VALUES
                    ('access',1,0,'http_access_denied'),
                    ('delayed',1,2000,'network_request_failed'),
                    ('legacy-extraction',1,0,'body_missing_or_paywall'),
                    ('legacy-http',1,0,'http_status_rejected'),
                    ('google-discovery',1,9223372036854775807,'google_news_discovery_only');
                 INSERT INTO intelligence_content_backfill_hosts(host,next_allowed_at,failure_count) VALUES
                    ('redacted.invalid',2000,3),('available.invalid',0,0),('degraded.invalid',0,2);",
            )
            .unwrap();

        let health = full_text_backfill_health(&connection, 1000);
        assert_eq!(health.waiting_count, 6);
        assert_eq!(health.retryable_now_count, 4);
        assert_eq!(health.delayed_count, 2);
        assert_eq!(health.limited_host_count, 1);
        assert_eq!(health.known_source_count, 3);
        assert_eq!(health.healthy_source_count, 1);
        assert_eq!(health.degraded_source_count, 1);
        assert_eq!(health.circuit_open_source_count, 1);
        let count = |category| {
            health
                .failure_categories
                .iter()
                .find(|item| item.category == category)
                .map(|item| item.count)
                .unwrap_or_default()
        };
        assert_eq!(count("http_access_denied"), 1);
        assert_eq!(count("network_request_failed"), 1);
        assert_eq!(count("legacy_extraction_or_paywall"), 1);
        assert_eq!(count("legacy_http_rejected"), 1);
        assert_eq!(count("google_news_discovery_only"), 1);
        assert_eq!(count("other"), 0);

        let encoded = serde_json::to_string(&health).unwrap();
        assert!(!encoded.contains("redacted.invalid"));
        assert!(!encoded.contains("/ready"));
    }

    #[test]
    fn evidence_version_mismatch_keeps_old_complete_body_visible_without_reusing_it() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE intelligence_articles(article_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
                 CREATE TABLE intelligence_article_content_versions(
                     article_id TEXT,record_fingerprint TEXT,is_current INTEGER,body_status TEXT
                 );
                 INSERT INTO intelligence_articles(article_id,fingerprint) VALUES
                    ('revised','new-fingerprint'),('complete','same-fingerprint'),('missing','none');
                 INSERT INTO intelligence_article_content_versions(article_id,record_fingerprint,is_current,body_status) VALUES
                    ('revised','old-fingerprint',0,'complete'),
                    ('revised','new-fingerprint',1,'unavailable'),
                    ('complete','same-fingerprint',1,'complete');",
            )
            .unwrap();
        assert_eq!(evidence_version_mismatch_count(&connection), 1);
    }

    #[test]
    fn persisted_running_audit_keeps_an_observer_status_running() {
        let mut audit = HostRunAudit::start();
        assert!(audit_is_running(Some(&audit)));
        audit.runner_pid = u32::MAX;
        assert!(!audit_is_running(Some(&audit)));
        audit.runner_pid = std::process::id();
        audit.finish("completed", None);
        assert!(!audit_is_running(Some(&audit)));
        assert!(!audit_is_running(None));
    }

    #[test]
    fn stale_running_audit_projects_as_interrupted_without_faking_completion() {
        let mut audit = HostRunAudit::start();
        audit.run_id = "00000000-0000-0000-0000-000000000000".into();
        audit.started_at = 42;
        audit.begin_stage("collection");

        let projection = project_host_audit(&audit, false);
        assert_eq!(projection.run_code, "00000000");
        assert_eq!(projection.status, "interrupted");
        assert_eq!(projection.started_at, 42);
        assert_eq!(projection.finished_at, None);
        assert_eq!(projection.current_stage, None);
        assert_eq!(projection.stage_sequence.len(), 1);
        assert_eq!(projection.stage_sequence[0].status, "interrupted");

        let summary = summary_from_host_audit(&audit, false);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].stage, "collection");
        assert_eq!(summary[0].status, "interrupted");
        assert_eq!(summary[0].count, 1);
        assert_eq!(summary[0].unit, "stage_invocations");
    }

    #[test]
    fn live_audit_projection_keeps_the_current_stage_and_call_count() {
        let mut audit = HostRunAudit::start();
        audit.run_id = "11111111-1111-1111-1111-111111111111".into();
        audit.begin_stage("small_model_triage");

        let projection = project_host_audit(&audit, true);
        assert_eq!(projection.run_code, "11111111");
        assert_eq!(projection.status, "running");
        assert_eq!(
            projection.current_stage.as_deref(),
            Some("small_model_triage")
        );

        let summary = summary_from_host_audit(&audit, true);
        assert_eq!(summary[0].status, "running");
        assert_eq!(summary[0].count, 1);
    }

    #[test]
    fn completed_audit_projects_an_ordered_safe_aggregate_report() {
        let mut audit = HostRunAudit::start();
        audit.run_id = "01234567-89ab-cdef-0123-456789abcdef".into();
        audit.begin_stage("collection");
        audit.begin_stage("small_model_triage");
        audit.begin_stage("small_model_triage");
        audit.finish(
            "completed",
            Some(RunReport {
                outcome: "evidence_completed".into(),
                collection: "collected".into(),
                collected: 12,
                duplicates: 7,
                backfilled: 3,
                backfill_retried: 2,
                triaged: 5,
                retried: 1,
                relation: "processed".into(),
                // This deliberately resembles data that must never cross the
                // loopback audit boundary.
                relation_failure: "https://private.invalid/secret".into(),
                editorial_failure: "Bearer credential-value".into(),
                processed: 0,
                reviewed: 0,
                event_publication: "event_prepared_locally".into(),
                publication: "daily_prepared_locally".into(),
                distribution_service: "distribution_worker_start_requested".into(),
            }),
        );

        let projection = project_host_audit(&audit, false);
        assert_eq!(projection.run_code, "01234567");
        assert_eq!(projection.status, "completed");
        assert_eq!(projection.current_stage, None);
        assert_eq!(projection.stage_sequence.len(), 2);
        assert_eq!(projection.stage_sequence[0].stage, "collection");
        assert_eq!(projection.stage_sequence[0].status, "completed");
        assert_eq!(projection.stage_sequence[1].stage, "small_model_triage");
        assert_eq!(projection.stage_sequence[1].count, 2);

        let report = projection.report.unwrap();
        assert_eq!(report.collected, 12);
        assert_eq!(report.duplicates, 7);
        assert_eq!(report.backfilled, 3);
        assert_eq!(report.backfill_retried, 2);
        assert_eq!(report.triaged, 5);
        assert_eq!(report.retried, 1);
        assert_eq!(report.relation, "processed");
        assert_eq!(report.relation_failure, "unknown");
        assert_eq!(report.editorial, "processing_retry_scheduled");
        assert_eq!(report.event_publication, "event_prepared_locally");
        assert_eq!(report.publication, "daily_prepared_locally");

        let encoded = serde_json::to_string(&project_host_audit(&audit, false)).unwrap();
        assert!(!encoded.contains("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(!encoded.contains("private.invalid"));
        assert!(!encoded.contains("credential-value"));
        assert!(!encoded.contains("distribution_worker_start_requested"));
    }

    #[test]
    fn relation_worker_failure_codes_are_fixed_and_redacted() {
        assert_eq!(
            relation_worker_failure_code("本机情报 worker 超时；已停止本轮处理"),
            "relation_worker_timeout"
        );
        assert_eq!(
            relation_worker_failure_code("本机情报 worker 未成功完成本轮任务"),
            "relation_worker_nonzero"
        );
        assert_eq!(
            relation_worker_failure_code("unexpected local path or provider body"),
            "relation_judge_model_transport"
        );
        let report = RunReport {
            outcome: "relation_processing_incomplete".into(),
            relation: "processing_retry_scheduled".into(),
            relation_failure: "relation_worker_timeout".into(),
            ..RunReport::default()
        };
        assert_eq!(audit_completion_status(&report), "failed");
        assert_eq!(
            project_run_report(&report).relation_failure,
            "relation_worker_timeout"
        );
    }

    #[test]
    fn operator_stop_is_a_safe_completed_audit_boundary() {
        let report = RunReport {
            outcome: "stopped_by_operator".into(),
            ..RunReport::default()
        };
        assert_eq!(audit_completion_status(&report), "stopped");

        let mut audit = HostRunAudit::start();
        audit.finish(audit_completion_status(&report), Some(report));
        let projection = project_host_audit(&audit, false);
        assert_eq!(projection.status, "stopped");
        assert!(projection.finished_at.is_some());
    }

    #[test]
    fn absent_optional_processing_diagnostic_is_not_rendered_as_unknown() {
        let successful = serde_json::json!({"outcome":"processed","processingFailure":""});
        let legacy_successful = serde_json::json!({"outcome":"processed"});
        assert_eq!(optional_text(&successful, "processingFailure"), "");
        assert_eq!(optional_text(&legacy_successful, "processingFailure"), "");
        assert_eq!(text(&legacy_successful, "outcome"), "processed");
    }

    #[test]
    fn distribution_sidecar_state_is_reported_without_credential_data() {
        let report = RunReport {
            outcome: "production_not_configured".into(),
            distribution_service: "distribution_worker_start_requested".into(),
            ..RunReport::default()
        };
        let encoded = serde_json::to_string(&report).unwrap();
        assert_eq!(report.outcome, "production_not_configured");
        assert_eq!(
            report.distribution_service,
            "distribution_worker_start_requested"
        );
        assert!(!encoded.contains("https://"));
        assert!(!encoded.contains("credential"));
    }

    #[test]
    fn distribution_sidecar_uses_its_own_lifecycle_without_secret_arguments() {
        let command =
            distribution_sidecar_command(Path::new("worker.exe"), &HostConfiguration::default());
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments, vec!["--service-loop"]);
        assert!(command.get_envs().all(|(key, _)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            !key.contains("TOKEN") && !key.contains("CREDENTIAL")
        }));
    }

    #[test]
    fn distribution_sidecar_receives_only_local_pipeline_configuration() {
        let configuration = HostConfiguration {
            sources_file: Some(r"C:\\sources.json".into()),
            triage: Some(ModelRoute {
                base_url: "http://127.0.0.1:8081/v1".into(),
                model: "judge-8b".into(),
                artifact_sha256: "a".repeat(64),
            }),
            ..HostConfiguration::default()
        };
        let command = distribution_sidecar_command(Path::new("worker.exe"), &configuration);
        let variables = command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            variables.get("KUNPENG_INTELLIGENCE_WORKER_ENABLED"),
            Some(&"1".into())
        );
        assert!(variables.contains_key("KUNPENG_INTELLIGENCE_COLLECTOR_SOURCES"));
        assert!(variables.contains_key("KUNPENG_INTELLIGENCE_TRIAGE_MODEL_SHA256"));
        assert!(variables
            .keys()
            .all(|key| !key.contains("TOKEN") && !key.contains("CREDENTIAL")));
    }
}
