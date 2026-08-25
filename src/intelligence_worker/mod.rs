//! No-UI bounded processor for the permanent local intelligence archive.
//!
//! It only leases one already-queued article, optionally sends its compact
//! public metadata to an explicitly configured *loopback* 7B/8B service, and
//! atomically records either a decision or a retry. It never collects feeds,
//! starts Tauri, reads WebView storage, or emits article content.

mod archive_relay;
mod collection;
pub(crate) mod content_archive;
mod host_executor;
mod processing;
mod publication;
mod synthesis;
mod triage;

use crate::archive;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::ffi::OsString;
use std::time::{SystemTime, UNIX_EPOCH};
use triage::{
    LoopbackTriageTransport, TriageDecision, TriageFailure, TriageHandoff, TriageModel,
    TriageTransport,
};

const ENABLE_ENV: &str = "KUNPENG_INTELLIGENCE_WORKER_ENABLED";
const TRIAGE_BASE_URL_ENV: &str = "KUNPENG_INTELLIGENCE_TRIAGE_BASE_URL";
const TRIAGE_MODEL_ENV: &str = "KUNPENG_INTELLIGENCE_TRIAGE_MODEL";
const TRIAGE_MODEL_SHA256_ENV: &str = "KUNPENG_INTELLIGENCE_TRIAGE_MODEL_SHA256";
const TRIAGE_PROMPT_VERSION: &str = "article-triage-v2";
const CONTENT_FINGERPRINT_RECONCILIATION_LIMIT: usize = 64;

fn triage_retry_reason(failure: TriageFailure) -> &'static str {
    match failure {
        TriageFailure::InvalidInput => {
            "本机 7B/8B 初筛输入超出安全上下文预算；后台将按退避策略重试"
        }
        TriageFailure::ModelRequest => {
            "本机 7B/8B 初筛请求未完成；请检查本机模型服务，后台将按退避策略重试"
        }
        TriageFailure::InvalidResponse => "本机 7B/8B 初筛未返回合规 JSON；后台将按退避策略重试",
        TriageFailure::Staging => "本机 7B/8B 初筛结果未能安全暂存；后台将按退避策略重试",
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Status,
    Once,
    CollectOnce,
    CollectLoop,
    BackfillContentOnce,
    RelateOnce,
    /// Bounded internal mode used by the loopback intelligence host.  It
    /// keeps one worker-private ANN snapshot alive for several durable
    /// relation transitions, but never accepts an unbounded operator value.
    RelateBatch(u8),
    RelateLoop,
    SynthesizeOnce,
    SynthesizeLoop,
    ProcessOnce,
    ProcessLoop,
    RelayOnce,
    PublishDailyOnce,
    PreviewDaily(NaiveDate),
    ServiceLoop,
}

const MAX_RELATION_BATCH: u8 = 24;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EnableConfiguration {
    Enabled,
    NotEnabled,
    Invalid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TriageConfiguration {
    Configured(TriageModel),
    Missing,
    Invalid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerOutput {
    kind: &'static str,
    mode: &'static str,
    outcome: &'static str,
    configured: bool,
    archive_present: bool,
    queued: u64,
    processing: u64,
    claimed: u64,
    triaged: u64,
    retried: u64,
    remaining: u64,
    #[serde(default)]
    collected: u64,
    #[serde(default)]
    duplicates: u64,
    #[serde(default)]
    collection_failed: u64,
    #[serde(default)]
    backfill_attempted: u64,
    #[serde(default)]
    backfilled: u64,
    #[serde(default)]
    backfill_retried: u64,
    #[serde(default)]
    processed: u64,
    #[serde(default)]
    chunks: u64,
    #[serde(default)]
    recalled: u64,
    #[serde(default)]
    judged: u64,
    #[serde(default)]
    reviewed: u64,
    #[serde(default)]
    published: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    processing_failure: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct QueueStatus {
    archive_present: bool,
    queued: u64,
    processing: u64,
}

#[derive(Clone, Debug)]
struct ClaimedTriage {
    lease_owner: String,
    handoff: TriageHandoff,
}

/// Identifies exactly one safe-to-reuse 8B article decision.  The associated
/// row stores only the already validated, bounded decision JSON; it never
/// stores the article, prompt, URL, credential, or raw provider response.
#[derive(Clone, Debug)]
struct TriageStagingKey {
    article_id: String,
    fingerprint: String,
    model_id: String,
    model_sha256: String,
    prompt_version: &'static str,
    input_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AppliedState {
    Triaged,
    Retried,
    Stale,
}

fn now_ms() -> Result<i64, ()> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis()
        .try_into()
        .map_err(|_| ())
}

fn queue_status() -> Result<QueueStatus, ()> {
    queue_status_at(&archive::store_path().map_err(|_| ())?)
}

fn queue_status_at(path: &std::path::Path) -> Result<QueueStatus, ()> {
    if !path.is_file() {
        return Ok(QueueStatus::default());
    }
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ())?;
    let (queued, processing) = connection
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN triage_state='queued' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN triage_state='processing' THEN 1 ELSE 0 END),0)
         FROM intelligence_articles",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
        )
        .map_err(|_| ())?;
    Ok(QueueStatus {
        archive_present: true,
        queued,
        processing,
    })
}

fn claim_one(lease_owner: &str) -> Result<(bool, Option<ClaimedTriage>, u64), ()> {
    claim_one_at(&archive::store_path().map_err(|_| ())?, lease_owner)
}

fn claim_one_at(
    path: &std::path::Path,
    lease_owner: &str,
) -> Result<(bool, Option<ClaimedTriage>, u64), ()> {
    if !path.is_file() {
        return Ok((false, None, 0));
    }
    // Recover only evidence revisions whose current body projection verifies
    // byte-for-byte against the old immutable version. This keeps a process
    // interruption between record and evidence transactions from permanently
    // stranding a valid article, while different bodies still require a fetch.
    content_archive::reconcile_current_complete_content_versions_at(
        path,
        CONTENT_FINGERPRINT_RECONCILIATION_LIMIT,
    )
    .map_err(|_| ())?;
    // The collector intentionally fingerprints validators such as ETag.  Do
    // not let an ETag-only refresh put the same canonical body through the
    // 8B queue again; processing owns the persistent cross-source mapping.
    processing::reconcile_canonical_content_at(path)?;
    let timestamp = now_ms()?;
    let lease_until = timestamp.checked_add(120_000).ok_or(())?;
    let mut connection = Connection::open(path).map_err(|_| ())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| ())?;
    let transaction = connection.transaction().map_err(|_| ())?;
    transaction.execute(
        "UPDATE intelligence_articles SET triage_state='queued', lease_owner=NULL, lease_until=NULL
         WHERE triage_state='processing' AND lease_until < ?1", [timestamp],
    ).map_err(|_| ())?;
    let article_id = transaction
        .query_row(
            "SELECT article_id FROM intelligence_articles
         WHERE triage_state='queued' AND COALESCE(next_retry_at,0) <= ?1
           AND EXISTS (
             SELECT 1 FROM intelligence_article_content_versions content
             WHERE content.article_id=intelligence_articles.article_id
               AND content.record_fingerprint=intelligence_articles.fingerprint
               AND content.body_status='complete' AND content.is_current=1
           )
           AND NOT EXISTS (
             SELECT 1 FROM intelligence_worker_canonical_aliases canonical
             WHERE canonical.article_id=intelligence_articles.article_id
               AND canonical.fingerprint=intelligence_articles.fingerprint
               AND (canonical.canonical_article_id<>intelligence_articles.article_id
                 OR canonical.canonical_fingerprint<>intelligence_articles.fingerprint)
           )
         ORDER BY CASE WHEN published_at IS NULL THEN 1 ELSE 0 END,
                  published_at DESC, created_at ASC LIMIT 1",
            [timestamp],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ())?;
    let claimed_id = if let Some(article_id) = article_id {
        let changed = transaction
            .execute(
                "UPDATE intelligence_articles SET triage_state='processing', lease_owner=?2,
                 lease_until=?3, updated_at=?4 WHERE article_id=?1 AND triage_state='queued'",
                params![article_id, lease_owner, lease_until, timestamp],
            )
            .map_err(|_| ())?;
        (changed == 1).then_some(article_id)
    } else {
        None
    };
    let handoff = if let Some(article_id) = claimed_id {
        transaction.query_row(
            "SELECT article_id,fingerprint,title,COALESCE(summary,''),COALESCE(body,''),COALESCE(published_at,''),COALESCE(source_name,'')
             FROM intelligence_articles WHERE article_id=?1 AND triage_state='processing' AND lease_owner=?2",
            params![article_id, lease_owner],
            |row| Ok(ClaimedTriage {
                lease_owner: lease_owner.to_string(),
                handoff: TriageHandoff {
                    article_id: row.get(0)?, fingerprint: row.get(1)?, title: row.get(2)?,
                    summary: row.get(3)?, evidence_excerpt: body_evidence_excerpt(&row.get::<_, String>(4)?),
                    published_at: row.get(5)?, source_name: row.get(6)?,
                },
            }),
        ).optional().map_err(|_| ())?
    } else {
        None
    };
    let remaining = queued_count(&transaction)?;
    transaction.commit().map_err(|_| ())?;
    Ok((true, handoff, remaining))
}

/// Preserve evidence from across a long article without allowing one record
/// to consume the 8B triage context.  A later processing pass reads every
/// stored paragraph before 27B writes the public synthesis.
fn body_evidence_excerpt(body: &str) -> String {
    const MAX: usize = 12_000;
    let chars = body.chars().collect::<Vec<_>>();
    if chars.len() <= MAX {
        return body.to_owned();
    }
    let section = MAX / 3;
    let middle_start = chars.len().saturating_div(2).saturating_sub(section / 2);
    let tail_start = chars.len().saturating_sub(section);
    let excerpt =
        |start: usize, length: usize| -> String { chars.iter().skip(start).take(length).collect() };
    format!(
        "{}\n\n[正文中段摘录]\n{}\n\n[正文末段摘录]\n{}",
        excerpt(0, section),
        excerpt(middle_start, section),
        excerpt(tail_start, section)
    )
}

fn initialize_triage_staging(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_worker_triage_staging(
                article_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                model_id TEXT NOT NULL,
                model_sha256 TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                input_sha256 TEXT NOT NULL,
                decision_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(article_id,fingerprint,model_id,model_sha256,prompt_version,input_sha256)
             );
             CREATE INDEX IF NOT EXISTS intelligence_worker_triage_staging_created_idx
                ON intelligence_worker_triage_staging(created_at);
             DELETE FROM intelligence_worker_triage_staging
                WHERE created_at < (strftime('%s','now')*1000 - 172800000);",
        )
        .map_err(|_| ())
}

fn triage_staging_key(
    claim: &ClaimedTriage,
    model: &TriageModel,
) -> Result<TriageStagingKey, TriageFailure> {
    Ok(TriageStagingKey {
        article_id: claim.handoff.article_id.clone(),
        fingerprint: claim.handoff.fingerprint.clone(),
        model_id: model.model.clone(),
        model_sha256: model.artifact_sha256.clone(),
        prompt_version: TRIAGE_PROMPT_VERSION,
        input_sha256: triage::input_sha256(&claim.handoff)?,
    })
}

fn load_staged_triage_decision(
    connection: &Connection,
    key: &TriageStagingKey,
) -> Result<Option<TriageDecision>, TriageFailure> {
    let staged: Option<String> = connection
        .query_row(
            "SELECT decision_json FROM intelligence_worker_triage_staging
             WHERE article_id=?1 AND fingerprint=?2 AND model_id=?3
               AND model_sha256=?4 AND prompt_version=?5 AND input_sha256=?6",
            params![
                key.article_id,
                key.fingerprint,
                key.model_id,
                key.model_sha256,
                key.prompt_version,
                key.input_sha256,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| TriageFailure::Staging)?;
    let Some(staged) = staged else {
        return Ok(None);
    };
    match triage::decode_staged_decision(&staged) {
        Ok(decision) => Ok(Some(decision)),
        Err(_) => {
            clear_staged_triage_decision(connection, key)?;
            Ok(None)
        }
    }
}

fn stage_triage_decision(
    connection: &Connection,
    key: &TriageStagingKey,
    decision: &TriageDecision,
) -> Result<(), TriageFailure> {
    let decision_json =
        triage::encode_staged_decision(decision).map_err(|_| TriageFailure::Staging)?;
    connection
        .execute(
            "INSERT INTO intelligence_worker_triage_staging(
                article_id,fingerprint,model_id,model_sha256,prompt_version,input_sha256,decision_json,created_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,strftime('%s','now')*1000)
             ON CONFLICT(article_id,fingerprint,model_id,model_sha256,prompt_version,input_sha256) DO NOTHING",
            params![
                key.article_id,
                key.fingerprint,
                key.model_id,
                key.model_sha256,
                key.prompt_version,
                key.input_sha256,
                decision_json,
            ],
        )
        .map_err(|_| TriageFailure::Staging)?;
    Ok(())
}

fn clear_staged_triage_decision(
    connection: &Connection,
    key: &TriageStagingKey,
) -> Result<(), TriageFailure> {
    connection
        .execute(
            "DELETE FROM intelligence_worker_triage_staging
             WHERE article_id=?1 AND fingerprint=?2 AND model_id=?3
               AND model_sha256=?4 AND prompt_version=?5 AND input_sha256=?6",
            params![
                key.article_id,
                key.fingerprint,
                key.model_id,
                key.model_sha256,
                key.prompt_version,
                key.input_sha256,
            ],
        )
        .map_err(|_| TriageFailure::Staging)?;
    Ok(())
}

/// Returns a previously validated, exact-match staged decision before asking
/// the local model.  A normal process interruption after staging but before
/// `apply_decision_at` therefore resumes without a second 8B request.
///
/// There is intentionally no raw-response cache: a machine failure in the
/// unavoidable interval after the loopback HTTP response but before its JSON
/// has been validated and staged can result in one retry.  Persisting raw
/// model output to close that external-I/O transaction gap would violate the
/// archive boundary for this worker.
fn execute_or_reuse_triage_at<T: TriageTransport>(
    path: &std::path::Path,
    claim: &ClaimedTriage,
    model: &TriageModel,
    transport: &T,
) -> Result<TriageDecision, TriageFailure> {
    let key = triage_staging_key(claim, model)?;
    let connection = Connection::open(path).map_err(|_| TriageFailure::Staging)?;
    initialize_triage_staging(&connection).map_err(|_| TriageFailure::Staging)?;
    if let Some(decision) = load_staged_triage_decision(&connection, &key)? {
        return Ok(decision);
    }
    let decision = triage::execute(transport, model, &claim.handoff)?;
    stage_triage_decision(&connection, &key, &decision)?;
    // A stale competing lease must not make the fresh process select a
    // different model answer.  Return the first durable, validated winner.
    load_staged_triage_decision(&connection, &key)?.ok_or(TriageFailure::Staging)
}

fn apply_decision_at(
    path: &std::path::Path,
    claim: &ClaimedTriage,
    model: &TriageModel,
    decision: Result<TriageDecision, TriageFailure>,
) -> Result<(AppliedState, u64), ()> {
    let timestamp = now_ms()?;
    let mut connection = Connection::open(path).map_err(|_| ())?;
    // `apply_decision_at` is intentionally callable by recovery tests and
    // manual operators as well as the staged executor.  Ensure committing a
    // successful decision can always retire its short-lived staging record.
    initialize_triage_staging(&connection)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| ())?;
    let transaction = connection.transaction().map_err(|_| ())?;
    let attempts = transaction.query_row(
        "SELECT triage_attempts FROM intelligence_articles WHERE article_id=?1 AND fingerprint=?2
         AND triage_state='processing' AND lease_owner=?3",
        params![claim.handoff.article_id, claim.handoff.fingerprint, claim.lease_owner],
        |row| row.get::<_, u32>(0),
    ).optional().map_err(|_| ())?;
    let Some(attempts) = attempts else {
        let remaining = queued_count(&transaction)?;
        transaction.commit().map_err(|_| ())?;
        return Ok((AppliedState::Stale, remaining));
    };
    let staged_key = match &decision {
        Ok(_) => Some(triage_staging_key(claim, model).map_err(|_| ())?),
        Err(_) => None,
    };
    let (status, stored_state, importance, confidence, reason, decision_json, retry_at, result) =
        match decision {
            Ok(decision) => {
                let status = if decision.keep { "keep" } else { "filter" };
                let detail = serde_json::to_string(&serde_json::json!({
                "keep": decision.keep, "importance": decision.importance, "confidence": decision.confidence,
                "topic": decision.topic, "primaryEntities": decision.primary_entities,
                "time": decision.event_time, "place": decision.place,
            })).map_err(|_| ())?;
                (
                    status,
                    status,
                    Some(f64::from(decision.importance)),
                    Some(decision.confidence),
                    decision.reason,
                    Some(detail),
                    None,
                    AppliedState::Triaged,
                )
            }
            Err(failure) => {
                let retry_at = timestamp
                    .checked_add(30_000_i64 << attempts.min(6))
                    .ok_or(())?;
                (
                    "failed",
                    "queued",
                    None,
                    None,
                    triage_retry_reason(failure).to_string(),
                    None,
                    Some(retry_at),
                    AppliedState::Retried,
                )
            }
        };
    let changed = transaction
        .execute(
            "UPDATE intelligence_articles SET triage_state=?4,
             triage_attempts=CASE WHEN ?6='failed' THEN triage_attempts+1 ELSE triage_attempts END,
             next_retry_at=?7,lease_owner=NULL,lease_until=NULL,updated_at=?5
         WHERE article_id=?1 AND fingerprint=?2 AND triage_state='processing' AND lease_owner=?3",
            params![
                claim.handoff.article_id,
                claim.handoff.fingerprint,
                claim.lease_owner,
                stored_state,
                timestamp,
                status,
                retry_at
            ],
        )
        .map_err(|_| ())?;
    if changed == 1 {
        transaction.execute(
            "INSERT INTO intelligence_triage_decisions(article_id,fingerprint,model_id,model_sha,prompt_version,status,importance,confidence,reason,decision_json,decided_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(article_id,fingerprint,model_id,prompt_version) DO UPDATE SET
               status=excluded.status,importance=excluded.importance,confidence=excluded.confidence,
               reason=excluded.reason,decision_json=excluded.decision_json,decided_at=excluded.decided_at",
            params![claim.handoff.article_id, claim.handoff.fingerprint, model.model, model.artifact_sha256, TRIAGE_PROMPT_VERSION,
                status, importance, confidence, reason, decision_json, timestamp],
        ).map_err(|_| ())?;
        if result == AppliedState::Triaged {
            let staged_key = staged_key.as_ref().ok_or(())?;
            transaction
                .execute(
                    "DELETE FROM intelligence_worker_triage_staging
                     WHERE article_id=?1 AND fingerprint=?2 AND model_id=?3
                       AND model_sha256=?4 AND prompt_version=?5 AND input_sha256=?6",
                    params![
                        staged_key.article_id,
                        staged_key.fingerprint,
                        staged_key.model_id,
                        staged_key.model_sha256,
                        staged_key.prompt_version,
                        staged_key.input_sha256,
                    ],
                )
                .map_err(|_| ())?;
        }
    }
    let remaining = queued_count(&transaction)?;
    transaction.commit().map_err(|_| ())?;
    Ok((
        if changed == 1 {
            result
        } else {
            AppliedState::Stale
        },
        remaining,
    ))
}

fn queued_count(transaction: &rusqlite::Transaction<'_>) -> Result<u64, ()> {
    transaction
        .query_row(
            "SELECT COUNT(*) FROM intelligence_articles WHERE triage_state='queued'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|_| ())
}

fn parse_mode(arguments: impl IntoIterator<Item = OsString>) -> Result<Mode, ()> {
    let values = crate::profile::application_args(arguments)
        .into_iter()
        .skip(1)
        .filter_map(|argument| argument.into_string().ok())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [value] if value == "--status" => Ok(Mode::Status),
        [value] if value == "--once" => Ok(Mode::Once),
        [value] if value == "--collect-once" => Ok(Mode::CollectOnce),
        [value] if value == "--collect-loop" => Ok(Mode::CollectLoop),
        [value] if value == "--backfill-content-once" => Ok(Mode::BackfillContentOnce),
        [value] if value == "--relate-once" => Ok(Mode::RelateOnce),
        [flag, count] if flag == "--relate-batch" => count
            .parse::<u8>()
            .ok()
            .filter(|count| (1..=MAX_RELATION_BATCH).contains(count))
            .map(Mode::RelateBatch)
            .ok_or(()),
        [value] if value == "--relate-loop" => Ok(Mode::RelateLoop),
        [value] if value == "--synthesize-once" => Ok(Mode::SynthesizeOnce),
        [value] if value == "--synthesize-loop" => Ok(Mode::SynthesizeLoop),
        [value] if value == "--process-once" => Ok(Mode::ProcessOnce),
        [value] if value == "--process-loop" => Ok(Mode::ProcessLoop),
        [value] if value == "--relay-once" => Ok(Mode::RelayOnce),
        [value] if value == "--publish-daily-once" => Ok(Mode::PublishDailyOnce),
        [flag, date] if flag == "--preview-daily" => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map(Mode::PreviewDaily)
            .map_err(|_| ()),
        [value] if value == "--service-loop" => Ok(Mode::ServiceLoop),
        _ => Err(()),
    }
}

fn enable_configuration(value: Option<&str>) -> EnableConfiguration {
    match value {
        Some("1") => EnableConfiguration::Enabled,
        None | Some("") => EnableConfiguration::NotEnabled,
        Some(_) => EnableConfiguration::Invalid,
    }
}

fn triage_configuration(
    base_url: Option<&str>,
    model: Option<&str>,
    artifact_sha256: Option<&str>,
) -> TriageConfiguration {
    match (
        base_url.map(str::trim).filter(|value| !value.is_empty()),
        model.map(str::trim).filter(|value| !value.is_empty()),
        artifact_sha256
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (None, None, None) => TriageConfiguration::Missing,
        (Some(base_url), Some(model), Some(artifact_sha256)) => {
            triage::model_from_parts_with_sha256(base_url, model, artifact_sha256)
                .map(TriageConfiguration::Configured)
                .unwrap_or(TriageConfiguration::Invalid)
        }
        _ => TriageConfiguration::Invalid,
    }
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Status => "status",
        Mode::Once => "once",
        Mode::CollectOnce => "collect_once",
        Mode::CollectLoop => "collect_loop",
        Mode::BackfillContentOnce => "backfill_content_once",
        Mode::RelateOnce => "relate_once",
        Mode::RelateBatch(_) => "relate_batch",
        Mode::RelateLoop => "relate_loop",
        Mode::SynthesizeOnce => "synthesize_once",
        Mode::SynthesizeLoop => "synthesize_loop",
        Mode::ProcessOnce => "process_once",
        Mode::ProcessLoop => "process_loop",
        Mode::RelayOnce => "relay_once",
        Mode::PublishDailyOnce => "publish_daily_once",
        Mode::PreviewDaily(_) => "preview_daily",
        Mode::ServiceLoop => "service_loop",
    }
}

fn print_output(output: WorkerOutput) {
    // Fixed aggregates only: never emit paths, IDs, titles, bodies, endpoints, model names, credentials, or raw errors.
    println!(
        "{}",
        serde_json::to_string(&output).expect("worker output schema serializes")
    );
}

fn output(
    mode: Mode,
    outcome: &'static str,
    configured: bool,
    status: QueueStatus,
    claimed: u64,
    triaged: u64,
    retried: u64,
    remaining: u64,
) -> WorkerOutput {
    WorkerOutput {
        kind: "kunpeng-intelligence-worker",
        mode: mode_name(mode),
        outcome,
        configured,
        archive_present: status.archive_present,
        queued: status.queued,
        processing: status.processing,
        claimed,
        triaged,
        retried,
        remaining,
        collected: 0,
        duplicates: 0,
        collection_failed: 0,
        backfill_attempted: 0,
        backfilled: 0,
        backfill_retried: 0,
        processed: 0,
        chunks: 0,
        recalled: 0,
        judged: 0,
        reviewed: 0,
        published: 0,
        processing_failure: String::new(),
    }
}

const SERVICE_LOOP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

fn service_triage_once(path: &std::path::Path) -> (u64, u64, u64) {
    let configuration = triage_configuration(
        std::env::var(TRIAGE_BASE_URL_ENV).ok().as_deref(),
        std::env::var(TRIAGE_MODEL_ENV).ok().as_deref(),
        std::env::var(TRIAGE_MODEL_SHA256_ENV).ok().as_deref(),
    );
    let TriageConfiguration::Configured(model) = configuration else {
        return (0, 0, 0);
    };
    let lease_owner = format!("service-worker-{}", std::process::id());
    let Ok((_, Some(claim), _)) = claim_one_at(path, &lease_owner) else {
        return (0, 0, 0);
    };
    let decision = execute_or_reuse_triage_at(path, &claim, &model, &LoopbackTriageTransport);
    match apply_decision_at(path, &claim, &model, decision) {
        Ok((AppliedState::Triaged, _)) => (1, 1, 0),
        Ok((AppliedState::Retried, _)) => (1, 0, 1),
        _ => (1, 0, 0),
    }
}

/// The login-started service is the only long-running lifecycle entry point.
/// Keep collection here rather than relying on a separately scheduled
/// `--collect-loop`: the configured collector itself persists per-source
/// cadence/ETag state and therefore safely skips sources that are not due.
/// `None` means that this installation has no collection source configured,
/// not that collection failed.
fn service_collection_once() -> Option<Result<collection::CollectionResult, ()>> {
    if let Some(sources) = collection::configured_http_sources_from_environment() {
        return Some(
            collection::HttpCollector::from_file(&sources)
                .and_then(|collector| collection::collect_once_with(&collector)),
        );
    }
    collection::configured_file_from_environment()
        .map(|input| collection::collect_once_with(&collection::FileCollector::new(&input)))
}

/// Login-started worker path.  Credentials are read from the DPAPI-protected
/// local lifecycle record inside this process on every iteration; neither the
/// registry command nor process arguments/environment carry capability tokens.
fn run_service_loop() -> i32 {
    let guard = match crate::intelligence_worker_lifecycle::acquire_service_loop_guard() {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            print_output(output(
                Mode::ServiceLoop,
                "service_already_running",
                true,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        Err(_) => {
            print_output(output(
                Mode::ServiceLoop,
                "service_lock_unavailable",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
    };
    // Keep the OS mutex alive until process termination.
    let _guard = guard;
    loop {
        let credentials = match crate::intelligence_worker_lifecycle::runtime_credentials() {
            Ok(Some(credentials)) => credentials,
            Ok(None) => {
                // Local revoke/delete is observed without depending on the
                // reader process.  Exit so the next pairing can start fresh.
                print_output(output(
                    Mode::ServiceLoop,
                    "service_not_paired",
                    false,
                    QueueStatus::default(),
                    0,
                    0,
                    0,
                    0,
                ));
                return 0;
            }
            Err(_) => {
                print_output(output(
                    Mode::ServiceLoop,
                    "service_credentials_unavailable",
                    false,
                    QueueStatus::default(),
                    0,
                    0,
                    0,
                    0,
                ));
                return 0;
            }
        };
        let relay = archive_relay::configuration_from_parts(
            Some(&credentials.base_url),
            credentials.relay_credential.as_deref(),
        );
        let publisher = publication::configuration_from_parts(
            Some(&credentials.base_url),
            credentials.publish_credential.as_deref(),
        );
        let has_any_capability = publisher.is_some() || relay.is_some();
        let Some(path) = archive::store_path().ok().filter(|path| path.is_file()) else {
            print_output(output(
                Mode::ServiceLoop,
                "archive_unavailable",
                true,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            std::thread::sleep(SERVICE_LOOP_INTERVAL);
            continue;
        };
        // A paired long-running worker must drive the complete local pipeline;
        // publishing/relay alone cannot make newly collected articles appear.
        // Collection is deterministic-dedupe-only; the separate content
        // backfill is deliberately retained for old summary-only records.
        let collection_result = service_collection_once();
        let backfill_result = collection::backfill_missing_content_once();
        let (claimed_triage, triaged, retried) = service_triage_once(&path);
        // The paired sidecar is responsible for collection, publication and
        // historical relay.  The host control plane owns GPU phase switches;
        // letting this independently scheduled process call the combined
        // 8B+27B path would race it and cannot work on a 16 GiB GPU.  Keep an
        // explicit opt-in for diagnostic installations that provide every
        // route concurrently.
        let processing_report = if std::env::var("KUNPENG_INTELLIGENCE_SERVICE_PROCESSING")
            .ok()
            .as_deref()
            == Some("1")
        {
            processing::process_once(&path, processing::configured_from_environment().as_ref())
        } else {
            processing::ProcessingReport::default()
        };
        let publication_result = publication::publish_completed_daily(publisher.as_ref(), &path);
        let relay_result = relay.as_ref().map(|relay| {
            archive_relay::execute_once(&archive_relay::HttpsRelayTransport, Some(relay), &path)
        });
        let (outcome, claimed) = match (publication_result, relay_result) {
            (publication::PublishOutcome::Published, _) => ("daily_published", 0),
            (publication::PublishOutcome::TransportUnavailable, _) => {
                ("publication_transport_unavailable", 0)
            }
            (publication::PublishOutcome::Failed, _) => ("publication_failed", 0),
            (_, Some(archive_relay::RelayOutcome::Uploaded)) => ("relay_uploaded", 1),
            (_, Some(archive_relay::RelayOutcome::NotFound)) => ("relay_not_found", 1),
            (_, Some(archive_relay::RelayOutcome::Failed)) => ("relay_failed", 1),
            (_, Some(archive_relay::RelayOutcome::TerminalUnconfirmed)) => {
                ("relay_terminal_unconfirmed", 1)
            }
            (_, Some(archive_relay::RelayOutcome::TransportUnavailable)) => {
                ("relay_transport_unavailable", 0)
            }
            (_, Some(archive_relay::RelayOutcome::NotConfigured)) | (_, None)
                if !has_any_capability =>
            {
                ("service_not_configured", 0)
            }
            _ => ("service_idle", 0),
        };
        let mut report = output(
            Mode::ServiceLoop,
            outcome,
            has_any_capability,
            QueueStatus {
                archive_present: true,
                ..QueueStatus::default()
            },
            claimed + claimed_triage,
            triaged,
            retried,
            0,
        );
        report.published = u64::from(publication_result == publication::PublishOutcome::Published);
        if let Some(Ok(result)) = collection_result {
            report.collected = result.collected;
            report.duplicates = result.duplicates;
            report.collection_failed = result.failed;
        } else if matches!(collection_result, Some(Err(()))) {
            report.collection_failed = 1;
        }
        if let Ok(result) = backfill_result {
            report.backfill_attempted = result.attempted;
            report.backfilled = result.completed;
            report.backfill_retried = result.retried;
        } else {
            report.backfill_retried = 1;
        }
        report.processed =
            u64::from(processing_report.outcome == processing::ProcessingOutcome::Processed);
        report.chunks = processing_report.chunks;
        report.recalled = processing_report.recalled;
        report.judged = processing_report.judged;
        report.reviewed = processing_report.reviewed;
        report.processing_failure = processing_report.failure_stage.to_owned();
        print_output(report);
        std::thread::sleep(SERVICE_LOOP_INTERVAL);
    }
}

pub(crate) fn run(arguments: impl IntoIterator<Item = OsString>) -> i32 {
    let mode = match parse_mode(arguments) {
        Ok(mode) => mode,
        Err(()) => {
            print_output(WorkerOutput {
                kind: "kunpeng-intelligence-worker",
                mode: "invalid",
                outcome: "invalid_arguments",
                configured: false,
                archive_present: false,
                queued: 0,
                processing: 0,
                claimed: 0,
                triaged: 0,
                retried: 0,
                remaining: 0,
                collected: 0,
                duplicates: 0,
                collection_failed: 0,
                backfill_attempted: 0,
                backfilled: 0,
                backfill_retried: 0,
                processed: 0,
                chunks: 0,
                recalled: 0,
                judged: 0,
                reviewed: 0,
                published: 0,
                processing_failure: String::new(),
            });
            return 2;
        }
    };
    if mode == Mode::ServiceLoop {
        return run_service_loop();
    }
    if let Mode::PreviewDaily(day) = mode {
        let Some(path) = archive::store_path().ok().filter(|path| path.is_file()) else {
            print_output(output(
                mode,
                "archive_unavailable",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        };
        let preview = publication::preview_daily_bundle(&path, day);
        let (outcome, events, assets) = match preview {
            publication::DailyPreviewOutcome::Ready { events, assets } => {
                ("daily_preview_ready", events, assets)
            }
            publication::DailyPreviewOutcome::NoCompletedEvents => {
                ("daily_events_unavailable", 0, 0)
            }
            publication::DailyPreviewOutcome::Invalid => ("daily_preview_invalid", 0, 0),
        };
        // `processed` and `chunks` are fixed aggregate fields; in preview mode
        // they respectively mean projected events and local image assets.  No
        // text, identifier, URL, file path, endpoint, or credential is output.
        let mut report = output(
            mode,
            outcome,
            false,
            QueueStatus {
                archive_present: true,
                ..QueueStatus::default()
            },
            0,
            0,
            0,
            0,
        );
        report.processed = events;
        report.chunks = assets;
        print_output(report);
        return 0;
    }
    if mode == Mode::PublishDailyOnce {
        let credentials = crate::intelligence_worker_lifecycle::runtime_credentials()
            .ok()
            .flatten();
        let publisher = credentials.as_ref().and_then(|credentials| {
            publication::configuration_from_parts(
                Some(&credentials.base_url),
                credentials.publish_credential.as_deref(),
            )
        });
        let Some(path) = archive::store_path().ok().filter(|path| path.is_file()) else {
            print_output(output(
                mode,
                "archive_unavailable",
                publisher.is_some(),
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        };
        let result = publication::publish_completed_daily(publisher.as_ref(), &path);
        let outcome = match result {
            publication::PublishOutcome::PreparedLocally => "daily_prepared_locally",
            publication::PublishOutcome::NoCompletedEvents => "daily_events_unavailable",
            publication::PublishOutcome::AlreadyPublished => "daily_already_published",
            publication::PublishOutcome::Published => "daily_published",
            publication::PublishOutcome::TransportUnavailable => {
                "publication_transport_unavailable"
            }
            publication::PublishOutcome::Failed => "publication_failed",
        };
        let mut report = output(
            mode,
            outcome,
            publisher.is_some(),
            QueueStatus {
                archive_present: true,
                ..QueueStatus::default()
            },
            0,
            0,
            0,
            0,
        );
        report.published = u64::from(result == publication::PublishOutcome::Published);
        print_output(report);
        return 0;
    }
    let enabled = enable_configuration(std::env::var(ENABLE_ENV).ok().as_deref());
    if enabled == EnableConfiguration::Invalid {
        print_output(WorkerOutput {
            kind: "kunpeng-intelligence-worker",
            mode: mode_name(mode),
            outcome: "invalid_configuration",
            configured: false,
            archive_present: false,
            queued: 0,
            processing: 0,
            claimed: 0,
            triaged: 0,
            retried: 0,
            remaining: 0,
            collected: 0,
            duplicates: 0,
            collection_failed: 0,
            backfill_attempted: 0,
            backfilled: 0,
            backfill_retried: 0,
            processed: 0,
            chunks: 0,
            recalled: 0,
            judged: 0,
            reviewed: 0,
            published: 0,
            processing_failure: String::new(),
        });
        return 0;
    }
    if mode == Mode::RelayOnce {
        let configured = enabled == EnableConfiguration::Enabled
            && archive_relay::configured_from_environment().is_some();
        if enabled != EnableConfiguration::Enabled {
            print_output(output(
                mode,
                "not_enabled",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        let path = match archive::store_path() {
            Ok(path) if path.is_file() => path,
            _ => {
                print_output(output(
                    mode,
                    "archive_unavailable",
                    configured,
                    QueueStatus::default(),
                    0,
                    0,
                    0,
                    0,
                ));
                return 0;
            }
        };
        let outcome = archive_relay::execute_once(
            &archive_relay::HttpsRelayTransport,
            archive_relay::configured_from_environment().as_ref(),
            &path,
        );
        let (outcome, claimed) = match outcome {
            archive_relay::RelayOutcome::NotConfigured => ("relay_not_configured", 0),
            archive_relay::RelayOutcome::Idle => ("relay_idle", 0),
            archive_relay::RelayOutcome::Uploaded => ("relay_uploaded", 1),
            archive_relay::RelayOutcome::NotFound => ("relay_not_found", 1),
            archive_relay::RelayOutcome::Failed => ("relay_failed", 1),
            archive_relay::RelayOutcome::TerminalUnconfirmed => ("relay_terminal_unconfirmed", 1),
            archive_relay::RelayOutcome::TransportUnavailable => ("relay_transport_unavailable", 0),
        };
        print_output(output(
            mode,
            outcome,
            configured,
            QueueStatus {
                archive_present: true,
                ..QueueStatus::default()
            },
            claimed,
            0,
            0,
            0,
        ));
        return 0;
    }
    if mode == Mode::CollectOnce {
        if enabled != EnableConfiguration::Enabled {
            print_output(output(
                mode,
                "not_enabled",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        let result = if let Some(sources) = collection::configured_http_sources_from_environment() {
            match collection::HttpCollector::from_file(&sources) {
                Ok(collector) => collection::collect_once_with(&collector),
                Err(()) => Err(()),
            }
        } else if let Some(input) = collection::configured_file_from_environment() {
            collection::collect_once_with(&collection::FileCollector::new(&input))
        } else {
            print_output(output(
                mode,
                "collector_not_configured",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        };
        let mut report = output(
            mode,
            if result.is_ok() {
                "collected"
            } else {
                "collection_failed"
            },
            true,
            queue_status().unwrap_or_default(),
            0,
            0,
            0,
            0,
        );
        if let Ok(result) = result {
            report.collected = result.collected;
            report.duplicates = result.duplicates;
            report.collection_failed = result.failed;
            report.remaining = queue_status().map(|status| status.queued).unwrap_or(0);
        }
        print_output(report);
        return 0;
    }
    if mode == Mode::BackfillContentOnce {
        if enabled != EnableConfiguration::Enabled {
            print_output(output(
                mode,
                "not_enabled",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        let result = collection::backfill_missing_content_once();
        let mut report = output(
            mode,
            if result.is_ok() {
                "content_backfilled"
            } else {
                "content_backfill_failed"
            },
            true,
            queue_status().unwrap_or_default(),
            0,
            0,
            0,
            0,
        );
        if let Ok(result) = result {
            report.backfill_attempted = result.attempted;
            report.backfilled = result.completed;
            report.backfill_retried = result.retried;
            report.remaining = queue_status().map(|status| status.queued).unwrap_or(0);
        }
        print_output(report);
        return 0;
    }
    if mode == Mode::CollectLoop {
        if enabled != EnableConfiguration::Enabled {
            print_output(output(
                mode,
                "not_enabled",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        let Some(source_file) = collection::configured_http_sources_from_environment() else {
            print_output(output(
                mode,
                "collector_not_configured",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        };
        // This intentionally never touches Tauri or the page. A Windows Task
        // Scheduler/login entry can keep this process alive after the reader
        // window closes; reloading config each cycle lets an operator adjust
        // sources without a restart.
        loop {
            let (result, interval) = match collection::HttpCollector::from_file(&source_file) {
                Ok(collector) => {
                    let interval = collector.recommended_interval();
                    (collection::collect_once_with(&collector), interval)
                }
                Err(()) => (Err(()), std::time::Duration::from_secs(300)),
            };
            let mut report = output(
                mode,
                if result.is_ok() {
                    "collected"
                } else {
                    "collection_failed"
                },
                true,
                queue_status().unwrap_or_default(),
                0,
                0,
                0,
                0,
            );
            if let Ok(result) = result {
                report.collected = result.collected;
                report.duplicates = result.duplicates;
                report.collection_failed = result.failed;
                report.remaining = queue_status().map(|status| status.queued).unwrap_or(0);
            }
            print_output(report);
            std::thread::sleep(interval);
        }
    }
    if matches!(
        mode,
        Mode::RelateOnce
            | Mode::RelateBatch(_)
            | Mode::RelateLoop
            | Mode::SynthesizeOnce
            | Mode::SynthesizeLoop
            | Mode::ProcessOnce
            | Mode::ProcessLoop
    ) {
        if enabled != EnableConfiguration::Enabled {
            print_output(output(
                mode,
                "not_enabled",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        let Some(path) = archive::store_path().ok().filter(|path| path.is_file()) else {
            print_output(output(
                mode,
                "archive_unavailable",
                false,
                QueueStatus::default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        };
        let has_configuration = match mode {
            Mode::RelateOnce | Mode::RelateBatch(_) | Mode::RelateLoop => {
                processing::configured_relation_from_environment().is_some()
            }
            Mode::SynthesizeOnce | Mode::SynthesizeLoop => {
                processing::configured_editorial_from_environment().is_some()
            }
            Mode::ProcessOnce | Mode::ProcessLoop => {
                processing::configured_from_environment().is_some()
            }
            _ => false,
        };
        if !has_configuration {
            print_output(output(
                mode,
                "processing_not_configured",
                false,
                queue_status().unwrap_or_default(),
                0,
                0,
                0,
                0,
            ));
            return 0;
        }
        loop {
            let report = match mode {
                Mode::RelateOnce | Mode::RelateLoop => processing::process_relation_once(
                    &path,
                    processing::configured_relation_from_environment().as_ref(),
                ),
                Mode::RelateBatch(limit) => processing::process_relation_batch(
                    &path,
                    processing::configured_relation_from_environment().as_ref(),
                    usize::from(limit),
                ),
                Mode::SynthesizeOnce | Mode::SynthesizeLoop => processing::process_editorial_once(
                    &path,
                    processing::configured_editorial_from_environment().as_ref(),
                ),
                Mode::ProcessOnce | Mode::ProcessLoop => processing::process_once(
                    &path,
                    processing::configured_from_environment().as_ref(),
                ),
                _ => unreachable!(),
            };
            let outcome = match report.outcome {
                processing::ProcessingOutcome::Idle => "processing_idle",
                processing::ProcessingOutcome::Processed => "processed",
                processing::ProcessingOutcome::Retry => "processing_retry_scheduled",
                processing::ProcessingOutcome::NotConfigured => "processing_not_configured",
            };
            let mut output = output(
                mode,
                outcome,
                true,
                queue_status().unwrap_or_default(),
                0,
                0,
                0,
                0,
            );
            output.processed =
                u64::from(report.outcome == processing::ProcessingOutcome::Processed);
            output.chunks = report.chunks;
            output.recalled = report.recalled;
            output.judged = report.judged;
            output.reviewed = report.reviewed;
            output.processing_failure = report.failure_stage.to_owned();
            print_output(output);
            if matches!(
                mode,
                Mode::RelateOnce | Mode::RelateBatch(_) | Mode::SynthesizeOnce | Mode::ProcessOnce
            ) {
                return 0;
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }
    let status = match queue_status() {
        Ok(status) => status,
        Err(()) => {
            print_output(WorkerOutput {
                kind: "kunpeng-intelligence-worker",
                mode: mode_name(mode),
                outcome: "archive_unavailable",
                configured: false,
                archive_present: false,
                queued: 0,
                processing: 0,
                claimed: 0,
                triaged: 0,
                retried: 0,
                remaining: 0,
                collected: 0,
                duplicates: 0,
                collection_failed: 0,
                backfill_attempted: 0,
                backfilled: 0,
                backfill_retried: 0,
                processed: 0,
                chunks: 0,
                recalled: 0,
                judged: 0,
                reviewed: 0,
                published: 0,
                processing_failure: String::new(),
            });
            return 0;
        }
    };
    let configuration = triage_configuration(
        std::env::var(TRIAGE_BASE_URL_ENV).ok().as_deref(),
        std::env::var(TRIAGE_MODEL_ENV).ok().as_deref(),
        std::env::var(TRIAGE_MODEL_SHA256_ENV).ok().as_deref(),
    );
    let configured = enabled == EnableConfiguration::Enabled
        && matches!(configuration, TriageConfiguration::Configured(_));
    if mode == Mode::Status {
        let outcome = if !status.archive_present {
            "no_archive"
        } else if matches!(configuration, TriageConfiguration::Invalid) {
            "invalid_triage_configuration"
        } else if !configured {
            "triage_not_configured"
        } else {
            "ready"
        };
        print_output(output(
            mode,
            outcome,
            configured,
            status,
            0,
            0,
            0,
            status.queued,
        ));
        return 0;
    }
    if !status.archive_present || status.queued == 0 {
        print_output(output(
            mode,
            "idle",
            configured,
            status,
            0,
            0,
            0,
            status.queued,
        ));
        return 0;
    }
    let TriageConfiguration::Configured(model) = configuration else {
        let outcome = if matches!(configuration, TriageConfiguration::Invalid) {
            "invalid_triage_configuration"
        } else {
            "triage_not_configured"
        };
        print_output(output(mode, outcome, false, status, 0, 0, 0, status.queued));
        return 0;
    };
    if enabled != EnableConfiguration::Enabled {
        print_output(output(
            mode,
            "not_enabled",
            false,
            status,
            0,
            0,
            0,
            status.queued,
        ));
        return 0;
    }
    let lease_owner = format!("worker-{}", std::process::id());
    let (archive_present, claim, _) = match claim_one(&lease_owner) {
        Ok(value) => value,
        Err(()) => {
            print_output(output(
                mode,
                "archive_unavailable",
                true,
                status,
                0,
                0,
                0,
                status.queued,
            ));
            return 0;
        }
    };
    let Some(claim) = claim else {
        print_output(output(
            mode,
            "idle",
            true,
            QueueStatus {
                archive_present,
                ..status
            },
            0,
            0,
            0,
            status.queued,
        ));
        return 0;
    };
    let path = match archive::store_path() {
        Ok(path) => path,
        Err(_) => {
            print_output(output(
                mode,
                "archive_unavailable",
                true,
                status,
                1,
                0,
                0,
                status.queued,
            ));
            return 0;
        }
    };
    let decision = execute_or_reuse_triage_at(&path, &claim, &model, &LoopbackTriageTransport);
    match apply_decision_at(&path, &claim, &model, decision) {
        Ok((AppliedState::Triaged, remaining)) => {
            print_output(output(mode, "triaged", true, status, 1, 1, 0, remaining))
        }
        Ok((AppliedState::Retried, remaining)) => print_output(output(
            mode,
            "retry_scheduled",
            true,
            status,
            1,
            0,
            1,
            remaining,
        )),
        Ok((AppliedState::Stale, remaining)) => {
            print_output(output(mode, "lease_lost", true, status, 1, 0, 0, remaining))
        }
        Err(()) => print_output(output(
            mode,
            "apply_unavailable",
            true,
            status,
            1,
            0,
            0,
            status.queued,
        )),
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingTriageTransport {
        calls: AtomicUsize,
    }

    impl CountingTriageTransport {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl TriageTransport for CountingTriageTransport {
        fn complete(&self, _: &TriageModel, _: &str) -> Result<String, TriageFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(r#"{"decisions":[{"id":"article-c261051fa6e3903794d1f84b1283b8ca","importance":80,"keep":true,"confidence":0.9,"topic":"国际","primaryEntities":["主体"],"time":"2026-08-23","place":"北京","reason":"可由摘要核对"}]}"#.to_string())
        }
    }

    fn setup(path: &std::path::Path) {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch(
            "CREATE TABLE intelligence_articles (article_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,title TEXT NOT NULL,summary TEXT,body TEXT,published_at TEXT,source_name TEXT,triage_state TEXT NOT NULL,triage_attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER,lease_owner TEXT,lease_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
             CREATE TABLE intelligence_article_content_versions (article_id TEXT NOT NULL,record_fingerprint TEXT NOT NULL,body_status TEXT NOT NULL,is_current INTEGER NOT NULL,created_at INTEGER NOT NULL);
             CREATE TABLE intelligence_triage_decisions (article_id TEXT NOT NULL,fingerprint TEXT NOT NULL,model_id TEXT NOT NULL,model_sha TEXT,prompt_version TEXT NOT NULL,status TEXT NOT NULL,importance REAL,confidence REAL,reason TEXT,decision_json TEXT,decided_at INTEGER NOT NULL,PRIMARY KEY(article_id,fingerprint,model_id,prompt_version));
             INSERT INTO intelligence_articles(article_id,fingerprint,title,summary,body,published_at,source_name,triage_state,created_at,updated_at) VALUES('article_1','sha:test','公开标题','公开摘要','完整正文','2026-08-23T00:00:00Z','Example','queued',1,1);
             INSERT INTO intelligence_article_content_versions(article_id,record_fingerprint,body_status,is_current,created_at) VALUES('article_1','sha:test','complete',1,1);"
        ).unwrap();
    }
    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kunpeng-intelligence-worker-{}.sqlite3",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn worker_accepts_only_explicit_no_ui_modes() {
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--status")]),
            Ok(Mode::Status)
        );
        assert_eq!(
            parse_mode([
                OsString::from("worker"),
                OsString::from("--isolated-profile"),
                OsString::from("C:\\fixture-profile"),
                OsString::from("--status"),
            ]),
            Ok(Mode::Status)
        );
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--once")]),
            Ok(Mode::Once)
        );
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--collect-once")]),
            Ok(Mode::CollectOnce)
        );
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--collect-loop")]),
            Ok(Mode::CollectLoop)
        );
        assert_eq!(
            parse_mode([
                OsString::from("worker"),
                OsString::from("--backfill-content-once")
            ]),
            Ok(Mode::BackfillContentOnce)
        );
        assert_eq!(
            parse_mode([
                OsString::from("worker"),
                OsString::from("--relate-batch"),
                OsString::from("4"),
            ]),
            Ok(Mode::RelateBatch(4))
        );
        assert!(parse_mode([
            OsString::from("worker"),
            OsString::from("--relate-batch"),
            OsString::from("0"),
        ])
        .is_err());
        assert!(parse_mode([
            OsString::from("worker"),
            OsString::from("--relate-batch"),
            OsString::from("25"),
        ])
        .is_err());
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--process-once")]),
            Ok(Mode::ProcessOnce)
        );
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--process-loop")]),
            Ok(Mode::ProcessLoop)
        );
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--relay-once")]),
            Ok(Mode::RelayOnce)
        );
        assert_eq!(
            parse_mode([
                OsString::from("worker"),
                OsString::from("--preview-daily"),
                OsString::from("2030-01-02")
            ]),
            Ok(Mode::PreviewDaily(
                NaiveDate::from_ymd_opt(2030, 1, 2).unwrap()
            ))
        );
        assert!(parse_mode([
            OsString::from("worker"),
            OsString::from("--preview-daily"),
            OsString::from("not-a-date")
        ])
        .is_err());
        assert_eq!(
            parse_mode([OsString::from("worker"), OsString::from("--service-loop")]),
            Ok(Mode::ServiceLoop)
        );
        assert_eq!(
            parse_mode([
                OsString::from("worker"),
                OsString::from("--isolated-profile"),
                OsString::from(r"C:\\fixture-profile"),
                OsString::from("--service-loop"),
            ]),
            Ok(Mode::ServiceLoop)
        );
        assert!(parse_mode([OsString::from("worker"), OsString::from("--fetch")]).is_err());
    }
    #[test]
    fn worker_requires_explicit_enable_and_loopback_triage_model() {
        assert_eq!(enable_configuration(None), EnableConfiguration::NotEnabled);
        assert_eq!(
            enable_configuration(Some("1")),
            EnableConfiguration::Enabled
        );
        assert!(matches!(
            triage_configuration(
                Some("http://127.0.0.1:8081/v1"),
                Some("Qwen3-8B-Q4"),
                Some(&"a".repeat(64)),
            ),
            TriageConfiguration::Configured(_)
        ));
        assert!(matches!(
            triage_configuration(
                Some("https://example.test"),
                Some("Qwen3-8B"),
                Some(&"a".repeat(64)),
            ),
            TriageConfiguration::Invalid
        ));
    }
    #[test]
    fn worker_claims_existing_work_and_records_success() {
        let path = temp_path();
        setup(&path);
        let (_, claim, _) = claim_one_at(&path, "worker-test").unwrap();
        let claim = claim.unwrap();
        let model = triage::model_from_parts("http://127.0.0.1:8081/v1", "Qwen3-8B-Q4").unwrap();
        let decision = TriageDecision {
            keep: true,
            importance: 80,
            confidence: 0.9,
            topic: "国际".into(),
            primary_entities: vec!["主体".into()],
            event_time: "2026-08-23".into(),
            place: "北京".into(),
            reason: "可由摘要核对".into(),
        };
        assert_eq!(
            apply_decision_at(&path, &claim, &model, Ok(decision))
                .unwrap()
                .0,
            AppliedState::Triaged
        );
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT triage_state FROM intelligence_articles",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "keep"
        );
        let decision_json: String = connection
            .query_row(
                "SELECT decision_json FROM intelligence_triage_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&decision_json)
                .unwrap()
                .get("time")
                .and_then(serde_json::Value::as_str),
            Some("2026-08-23")
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&decision_json)
                .unwrap()
                .get("place")
                .and_then(serde_json::Value::as_str),
            Some("北京")
        );
        let stored_model_sha: String = connection
            .query_row(
                "SELECT model_sha FROM intelligence_triage_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_model_sha, "0".repeat(64));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn triage_reuses_staged_decision_after_simulated_crash_without_second_model_call() {
        let path = temp_path();
        setup(&path);
        let model = triage::model_from_parts("http://127.0.0.1:8081/v1", "Qwen3-8B-Q4").unwrap();
        let first_claim = ClaimedTriage {
            lease_owner: "first-process".into(),
            handoff: TriageHandoff {
                article_id: "article_1".into(),
                fingerprint: "sha:test".into(),
                title: "公开标题".into(),
                summary: "公开摘要".into(),
                evidence_excerpt: "完整正文".into(),
                published_at: "2026-08-23T00:00:00Z".into(),
                source_name: "Example".into(),
            },
        };
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE intelligence_articles
                 SET triage_state='processing',lease_owner=?1,lease_until=999999999999
                 WHERE article_id='article_1'",
                [&first_claim.lease_owner],
            )
            .unwrap();
        drop(connection);
        let first_transport = CountingTriageTransport {
            calls: AtomicUsize::new(0),
        };

        let first_decision =
            execute_or_reuse_triage_at(&path, &first_claim, &model, &first_transport).unwrap();
        assert_eq!(first_transport.calls(), 1);

        let connection = Connection::open(&path).unwrap();
        let staged: String = connection
            .query_row(
                "SELECT decision_json FROM intelligence_worker_triage_staging",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Crash-recovery data is an already validated decision only, never
        // article evidence or the model's opaque response envelope.
        assert!(!staged.contains("完整正文"));
        assert!(!staged.contains("article_1"));
        connection
            .execute(
                "UPDATE intelligence_articles
                 SET lease_owner='resumed-process',lease_until=999999999999
                 WHERE article_id='article_1'",
                [],
            )
            .unwrap();
        drop(connection);

        let resumed_claim = ClaimedTriage {
            lease_owner: "resumed-process".into(),
            handoff: first_claim.handoff.clone(),
        };
        let resumed_transport = CountingTriageTransport {
            calls: AtomicUsize::new(0),
        };
        let resumed_decision =
            execute_or_reuse_triage_at(&path, &resumed_claim, &model, &resumed_transport).unwrap();
        assert_eq!(resumed_transport.calls(), 0);
        assert_eq!(resumed_decision, first_decision);

        assert_eq!(
            apply_decision_at(&path, &resumed_claim, &model, Ok(resumed_decision))
                .unwrap()
                .0,
            AppliedState::Triaged
        );
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM intelligence_worker_triage_staging",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            0
        );
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn worker_model_failure_returns_claim_to_bounded_retry_queue() {
        let path = temp_path();
        setup(&path);
        let (_, claim, _) = claim_one_at(&path, "worker-test").unwrap();
        let claim = claim.unwrap();
        let model = triage::model_from_parts("http://127.0.0.1:8081/v1", "Qwen3-7B-Q4").unwrap();
        assert_eq!(
            apply_decision_at(&path, &claim, &model, Err(TriageFailure::ModelRequest))
                .unwrap()
                .0,
            AppliedState::Retried
        );
        let connection = Connection::open(&path).unwrap();
        let row: (String, u32, Option<i64>) = connection
            .query_row(
                "SELECT triage_state,triage_attempts,next_retry_at FROM intelligence_articles",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "queued");
        assert_eq!(row.1, 1);
        assert!(row.2.is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn worker_waits_for_a_complete_current_body_before_model_triage() {
        let path = temp_path();
        setup(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE intelligence_article_content_versions SET body_status='unavailable'",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(claim_one_at(&path, "worker-test").unwrap().1.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn triage_evidence_excerpt_covers_long_body_edges_and_middle() {
        let body = format!("BEGIN{}MIDDLE{}END", "a".repeat(6_000), "b".repeat(6_000));
        let evidence = body_evidence_excerpt(&body);
        assert!(evidence.contains("BEGIN"));
        assert!(evidence.contains("MIDDLE"));
        assert!(evidence.contains("END"));
        assert!(evidence.len() < 13_000);
    }
}
