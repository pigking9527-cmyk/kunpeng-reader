//! Independent, local-only control plane for the intelligence workstation.
//!
//! Collection, 7B/8B triage, vector candidate recall, 27B review and the
//! permanent archive are deliberately implemented by the existing headless
//! worker.  This module turns those safe, individual commands into an
//! operator-visible workstation boundary without embedding that work in the
//! reader WebView.  Its optional dashboard is a loopback-only page on the
//! processing machine; the reader remains a client of published content.

use crate::{archive, atomic_file, profile};
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

const CONFIG_FILE: &str = "intelligence-host-v1.json";
const DEFAULT_SOURCES_FILE: &str = "intelligence-host-default-sources-v1.json";
const CONFIG_VERSION: u8 = 1;
const MAX_STAGE_RUNS: u16 = 500;
const WORKSTATION_LOOP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const WORKSTATION_ACTIVE_LOOP_INTERVAL: Duration = Duration::from_secs(30);
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
const RELATION_TIMEOUT: Duration = Duration::from_secs(180);
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

const fn default_backfill_batches_per_run() -> u8 {
    4
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
    audit_summary: Vec<AuditSummary>,
    last_run: Option<RunReport>,
    last_error: Option<String>,
}

/// Aggregate-only audit information for the local control page.  Keeping this
/// at stage/status granularity avoids the old audit view's large eager payload
/// and never returns source text, source URLs, local paths, or credentials.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditSummary {
    stage: String,
    status: String,
    count: u64,
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
    processed: u64,
    reviewed: u64,
    publication: String,
    /// Historical delivery is owned by the DPAPI-capability sidecar rather
    /// than the model pipeline. It remains alive when GPU/model work fails.
    distribution_service: String,
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
    started_at: i64,
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
            started_at: now,
            finished_at: None,
            current_stage: "preparing".into(),
            stages: Vec::new(),
            report: None,
        }
    }

    fn begin_stage(&mut self, stage: &str) {
        let now = unix_millis();
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

fn summary_from_host_audit(audit: &HostRunAudit) -> Vec<AuditSummary> {
    let mut grouped = std::collections::BTreeMap::<(String, String), u64>::new();
    for stage in &audit.stages {
        *grouped
            .entry((stage.stage.clone(), stage.status.clone()))
            .or_default() += 1;
    }
    grouped
        .into_iter()
        .map(|((stage, status), count)| AuditSummary {
            stage,
            status,
            count,
        })
        .collect()
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
    let mut result = HostStatus {
        kind: "kunpeng-intelligence-host",
        enabled: configuration.enabled,
        launch_at_login: configuration.launch_at_login,
        configuration_ready: configuration_ready(configuration),
        pipeline_running,
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
        ready_for_relation_count: 0,
        ready_for_editorial_count: 0,
        kept_count: 0,
        filtered_count: 0,
        full_text_count: 0,
        processed_count: 0,
        current_stage: persisted_audit
            .as_ref()
            .filter(|audit| audit.status == "running")
            .map(|audit| audit.current_stage.clone()),
        audit_summary: Vec::new(),
        last_run: last_run.or_else(|| {
            persisted_audit
                .as_ref()
                .and_then(|audit| audit.report.clone())
        }),
        last_error: persisted_audit
            .as_ref()
            .filter(|audit| audit.status == "running" && !pipeline_running)
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
        .map(summary_from_host_audit)
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
    result
}

fn child_output(
    configuration: &HostConfiguration,
    mode: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    child_output_with_backfill_pass(configuration, mode, timeout, None)
}

/// A host round can run several bounded evidence batches.  Keep their common
/// pass identifier out of the dashboard and logs, but pass it to the worker so
/// a failure which becomes retryable after the short backoff cannot be fetched
/// twice by later batches in the same operator-visible round.
fn child_output_with_backfill_pass(
    configuration: &HostConfiguration,
    mode: &str,
    timeout: Duration,
    backfill_pass_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let worker = worker_path(configuration).ok_or("未找到本机情报 worker；请先安装阅读器组件")?;
    let mut command = Command::new(worker);
    command
        .arg(mode)
        .args(crate::profile::child_profile_args())
        .env("KUNPENG_INTELLIGENCE_WORKER_ENABLED", "1");
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
    let result = run_once_with_audit(configuration, &audit_path, &mut audit);
    match &result {
        Ok(report) => audit.finish("completed", Some(report.clone())),
        Err(_) => audit.finish("failed", None),
    }
    write_host_audit(&audit_path, &audit).map_err(|_| "无法写入本机处理审计状态".to_string())?;
    result
}

fn run_once_with_audit(
    configuration: &HostConfiguration,
    audit_path: &Path,
    audit: &mut HostRunAudit,
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
        // Conditional feed requests may return 304 even while legacy records lack
        // permanent full text. Backfill is bounded and evidence-only: it never
        // creates a new item or requeues a previously judged article.
        begin_audit_stage(audit_path, audit, "full_text_backfill")?;
        let mut backfill_completed = true;
        let backfill_pass_id = uuid::Uuid::new_v4().to_string();
        for _ in 0..configuration.max_backfill_batches_per_run.max(1) {
            let backfill = child_output_with_backfill_pass(
                configuration,
                "--backfill-content-once",
                BACKFILL_TIMEOUT,
                Some(&backfill_pass_id),
            )?;
            report.backfilled += number(&backfill, "backfilled");
            report.backfill_retried += number(&backfill, "backfillRetried");
            if text(&backfill, "outcome") != "content_backfilled" {
                backfill_completed = false;
                break;
            }
            // An empty batch means the durable eligible queue is drained for
            // now. Avoid launching three redundant worker processes.
            if number(&backfill, "backfillAttempted") == 0 {
                break;
            }
        }
        let collection_completed = report.collection == "collected";
        if !collection_completed || !backfill_completed {
            report.outcome = if !collection_completed && !backfill_completed {
                "collection_and_backfill_incomplete"
            } else if !collection_completed {
                "collection_incomplete"
            } else {
                "content_backfill_incomplete"
            }
            .into();
            // Do not launch model work after an evidence-stage failure: the
            // next round can safely retry it, while this round has still made
            // its bounded backfill attempt and reported both outcomes.
            return Ok(report);
        }
        if !model_processing_ready(configuration) {
            report.outcome = "evidence_completed_models_not_configured".into();
            return Ok(report);
        }
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
                    report.publication = text(
                        &child_output(configuration, "--publish-daily-once", TRIAGE_TIMEOUT)?,
                        "outcome",
                    );
                    return Ok(report);
                }
            }
        }

        let work = (|| -> Result<RunReport, String> {
            for _ in 0..configuration.max_triage_per_run {
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
            for _ in 0..configuration.max_processing_per_run {
                begin_audit_stage(audit_path, audit, "vector_recall_and_relation")?;
                let value = child_output(configuration, "--relate-once", RELATION_TIMEOUT)?;
                report.relation = text(&value, "outcome");
                report.relation_failure = text(&value, "processingFailure");
                match report.relation.as_str() {
                    "processed" => {}
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
                    for _ in 0..configuration.max_processing_per_run {
                        if status(configuration, None, false).ready_for_editorial_count == 0 {
                            break;
                        }
                        begin_audit_stage(audit_path, audit, "editorial_synthesis")?;
                        let value =
                            child_output(configuration, "--synthesize-once", EDITORIAL_TIMEOUT)?;
                        match text(&value, "outcome").as_str() {
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
            // unpaired workstation simply reports `publisher_not_paired`.
            begin_audit_stage(audit_path, audit, "publication")?;
            let publication = child_output(configuration, "--publish-daily-once", TRIAGE_TIMEOUT)?;
            report.publication = text(&publication, "outcome");
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

/// Long-running no-UI mode for a dedicated host machine. Configuration is
/// reloaded between rounds, so disabling the switch or replacing a local
/// model route takes effect without restarting the process.
fn run_loop() -> i32 {
    let initial = read_configuration().unwrap_or_default();
    let _ = ensure_distribution_sidecar(&initial);
    loop {
        let value = match read_configuration() {
            Ok(configuration) if !configuration.enabled => {
                serde_json::json!({"ok": true, "outcome": "disabled"})
            }
            Ok(configuration) => match run_once(&configuration) {
                Ok(report) => serde_json::json!({"ok": true, "report": report}),
                Err(error) => serde_json::json!({"ok": false, "error": error}),
            },
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        println!("{}", value);
        // While durable evidence or model work is waiting, the host should
        // drain it promptly rather than pretending a five-minute polling loop
        // can process thousands of retained articles.  The worker still owns
        // per-source limits and retry scheduling; this only removes avoidable
        // idle time between safe bounded rounds.
        let interval = match read_configuration() {
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
        };
        std::thread::sleep(interval);
    }
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
        _ => {
            eprintln!("用法：kunpeng-intelligence-host --init|--status|--run-once|--dashboard [端口]|--loop");
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
        assert_eq!(configuration.max_backfill_batches_per_run, 4);
        assert!(!configuration_ready(&configuration));
        assert!(!collection_ready(&configuration));
        validate_configuration(&configuration).unwrap();
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
        let mut configuration = HostConfiguration::default();
        configuration.sources_file = Some(r"C:\\public-sources.json".into());
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
        let mut configuration = HostConfiguration::default();
        configuration.triage = Some(ModelRoute {
            base_url: "https://example.com/v1".into(),
            model: "judge-8b".into(),
            artifact_sha256: "a".repeat(64),
        });
        assert!(validate_configuration(&configuration).is_err());
    }

    #[test]
    fn route_requires_model_for_its_role() {
        let mut configuration = HostConfiguration::default();
        configuration.deep_review = Some(ModelRoute {
            base_url: "http://127.0.0.1:8080/v1".into(),
            model: "qwen-8b".into(),
            artifact_sha256: "a".repeat(64),
        });
        assert!(validate_configuration(&configuration).is_err());
    }

    #[test]
    fn configured_model_route_requires_its_verified_artifact_hash() {
        let mut configuration = HostConfiguration::default();
        configuration.triage = Some(ModelRoute {
            base_url: "http://127.0.0.1:8081/v1".into(),
            model: "judge-8b".into(),
            artifact_sha256: "not-a-sha".into(),
        });
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
        // `status` also intentionally projects the live, aggregate-only
        // archive state.  Do not make this privacy test depend on whichever
        // durable queue happens to exist on the developer machine.
        assert!(serde_json::from_str::<serde_json::Value>(&encoded)
            .unwrap()
            .get("readyForEditorialCount")
            .is_some_and(serde_json::Value::is_u64));
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
        let mut configuration = HostConfiguration::default();
        configuration.sources_file = Some(r"C:\\sources.json".into());
        configuration.triage = Some(ModelRoute {
            base_url: "http://127.0.0.1:8081/v1".into(),
            model: "judge-8b".into(),
            artifact_sha256: "a".repeat(64),
        });
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
