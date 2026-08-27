//! Local-only persistence for the intelligence pipeline.
//!
//! This database is a local-only permanent archive below
//! `profile::app_data_dir()/intelligence-hub`.  The historic cache database is
//! retained untouched and is only read as the source of a one-time, resumable
//! migration; after the permanent catalog is published it is authoritative, so
//! a later stale cache copy can never split writes between two databases.
//!
//! The archive is not referenced by reader backup, portable packages, sync
//! entities, or the remote sync service. Commands open short-lived WAL
//! connections so the audit UI never waits on model inference or a long-lived
//! application lock.

#[path = "../intelligence_worker/archive.rs"]
mod permanent_archive;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[cfg(test)]
const STORE_FILE: &str = permanent_archive::LEGACY_STORE_FILE;
#[cfg(test)]
const ARCHIVE_DIRECTORY: &str = permanent_archive::ARCHIVE_DIRECTORY;
#[cfg(test)]
const ARCHIVE_STORE_FILE: &str = permanent_archive::ARCHIVE_STORE_FILE;
const STORE_VERSION: i64 = 2;
const MAX_ARTICLES_PER_BATCH: usize = 500;
const MAX_DECISIONS_PER_BATCH: usize = 500;
const MAX_RELATIONS_PER_BATCH: usize = 1_000;
const MAX_REVIEWS_PER_BATCH: usize = 500;
const MAX_QUERY_IDS: usize = 500;
const MAX_AUDIT_PAGE: u32 = 200;
const MAX_ARTICLE_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 512 * 1024;
const PIPELINE_RECALL_MAX_ARTICLES: usize = 500;
const PIPELINE_RECALL_TOP_K: usize = 12;
const PIPELINE_RECALL_MAX_PAIRS: usize = PIPELINE_RECALL_MAX_ARTICLES * PIPELINE_RECALL_TOP_K;
const PIPELINE_HISTORY_TOP_K: usize = 6;
const QWEN3_EMBEDDING_MODEL: &str = "Qwen3-Embedding-0.6B-Q8_0";
const QWEN3_EMBEDDING_REVISION: &str = "qwen3-embedding-0.6b-gguf-q8_0-v1";
const QWEN3_EMBEDDING_INSTRUCTION: &str =
    "Represent this news article for retrieving related events.";
const QWEN3_RERANKER_MODEL: &str = "Qwen3-Reranker-0.6B-Q8_0";
const QWEN3_RERANKER_REVISION: &str = "qwen3-reranker-0.6b-gguf-q8_0-v1";
const QWEN3_CALIBRATION_MODEL: &str = "Qwen3-Embedding-8B-Q4_K_M";
const QWEN3_CALIBRATION_REVISION: &str = "qwen3-embedding-8b-gguf-q4_k_m-v1";
const QWEN3_EMBEDDING_BASE_URL: &str = "http://127.0.0.1:8082/v1";
const QWEN3_RERANKER_BASE_URL: &str = "http://127.0.0.1:8083/v1";
const QWEN3_CALIBRATION_BASE_URL: &str = "http://127.0.0.1:8084/v1";
const PIPELINE_CALIBRATION_MAX_PAIRS: usize = 64;
const PIPELINE_JUDGE_TOP_K_PER_QUERY: usize = 3;
const PIPELINE_JUDGE_MIN_SCORE: f32 = 0.45;

pub(crate) const AUDIT_STAGES: [&str; 9] = [
    "collected",
    "exact-dedupe",
    "article-triage",
    "relation-recall",
    "relation-judge",
    "historical-recall",
    "qwen-review",
    "final-events",
    "series-timeline",
];

const RELATION_TAXONOMY: [&str; 8] = [
    "exact_duplicate",
    "syndicated_copy",
    "same_event",
    "event_update",
    "same_series",
    "background",
    "correction",
    "unrelated",
];

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn bounded(value: &str, field: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{field} 超过本机情报存储上限"));
    }
    Ok(())
}

fn required(value: &str, field: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} 不能为空"));
    }
    bounded(value, field, max)?;
    Ok(value.to_string())
}

fn optional(value: Option<String>, field: &str, max: usize) -> Result<Option<String>, String> {
    value
        .map(|value| {
            let value = value.trim();
            if value.is_empty() {
                Ok(None)
            } else {
                bounded(value, field, max)?;
                Ok(Some(value.to_string()))
            }
        })
        .transpose()
        .map(Option::flatten)
}

fn json_text(value: Option<Value>, field: &str) -> Result<Option<String>, String> {
    value
        .map(|value| {
            let encoded = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            bounded(&encoded, field, MAX_JSON_BYTES)?;
            Ok(encoded)
        })
        .transpose()
}

fn parse_json(value: Option<String>) -> Option<Value> {
    value.and_then(|value| serde_json::from_str(&value).ok())
}

fn validate_stage(stage: &str) -> Result<&str, String> {
    AUDIT_STAGES
        .contains(&stage)
        .then_some(stage)
        .ok_or_else(|| "未知的情报审计阶段".to_string())
}

fn validate_relation(relation: &str) -> Result<&str, String> {
    RELATION_TAXONOMY
        .contains(&relation)
        .then_some(relation)
        .ok_or_else(|| "未知的情报关系分类".to_string())
}

fn store_path() -> Result<PathBuf, String> {
    // Resolve the non-mutating canonical location first, then let the shared
    // archive layer create or migrate it. This protects the desktop adapter
    // from ever accepting a migration result rooted somewhere else.
    let expected = permanent_archive::existing_store_path()?;
    let prepared = permanent_archive::store_path()?;
    (prepared == expected)
        .then_some(prepared)
        .ok_or_else(|| "本机情报档案路径与预期位置不一致".to_string())
}

/// Publish the former cache database as a permanent catalog without changing
/// the source. `VACUUM INTO` reads a consistent SQLite/WAL snapshot; the
/// completed image is checked before an atomic same-directory publish. If an
/// earlier process stopped after creating the staged image, a valid image is
/// simply published on the next run. An invalid stage is discarded and the
/// untouched legacy database is copied again.
#[cfg(test)]
fn migrate_legacy_store_if_needed(
    archive_path: &Path,
    legacy_path: Option<&Path>,
) -> Result<(), String> {
    permanent_archive::migrate_legacy_store_if_needed(archive_path, legacy_path)
}

fn open_store_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建情报档案目录失败：{error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("打开情报数据库失败：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA temp_store=MEMORY;",
        )
        .map_err(|error| format!("初始化情报数据库连接失败：{error}"))?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn open_store() -> Result<Connection, String> {
    open_store_at(&store_path()?)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_articles (
                 article_id TEXT PRIMARY KEY,
                 fingerprint TEXT NOT NULL,
                 url TEXT,
                 source_key TEXT,
                 source_name TEXT,
                 title TEXT NOT NULL,
                 summary TEXT,
                 body TEXT,
                 evidence_fingerprint TEXT,
                 published_at TEXT,
                 language TEXT,
                 media_json TEXT,
                 triage_state TEXT NOT NULL DEFAULT 'queued'
                     CHECK (triage_state IN ('queued','processing','keep','filter','failed')),
                 triage_attempts INTEGER NOT NULL DEFAULT 0,
                 next_retry_at INTEGER,
                 lease_owner TEXT,
                 lease_until INTEGER,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_articles_queue_idx
                 ON intelligence_articles(triage_state, lease_until, published_at, created_at);
             CREATE INDEX IF NOT EXISTS intelligence_articles_fingerprint_idx
                 ON intelligence_articles(fingerprint);
             CREATE VIRTUAL TABLE IF NOT EXISTS intelligence_news_fts USING fts5(
                 article_id UNINDEXED,
                 title,
                 summary,
                 body,
                 entities,
                 tokenize='unicode61 remove_diacritics 2'
             );
             CREATE TABLE IF NOT EXISTS intelligence_news_vectors (
                 article_id TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 model_id TEXT NOT NULL,
                 dimension INTEGER NOT NULL,
                 instruction TEXT NOT NULL DEFAULT '',
                 revision TEXT NOT NULL DEFAULT '',
                 vector_blob BLOB NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(article_id, fingerprint, model_id),
                 FOREIGN KEY(article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS intelligence_retrieval_profile (
                 profile_id INTEGER PRIMARY KEY CHECK(profile_id=1),
                 embedding_model TEXT NOT NULL,
                 dimension INTEGER NOT NULL,
                 instruction TEXT NOT NULL,
                 revision TEXT NOT NULL,
                 calibration_embedding_model TEXT,
                 calibration_dimension INTEGER,
                 calibration_revision TEXT,
                 calibration_status TEXT NOT NULL DEFAULT 'not_configured',
                 calibrated_pairs INTEGER NOT NULL DEFAULT 0,
                 reranker_model TEXT,
                 reranker_revision TEXT,
                 mode TEXT NOT NULL,
                 degraded INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_triage_decisions (
                 article_id TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 model_id TEXT NOT NULL,
                 model_sha TEXT,
                 prompt_version TEXT NOT NULL,
                 status TEXT NOT NULL CHECK (status IN ('keep','filter','failed')),
                 importance REAL,
                 confidence REAL,
                 reason TEXT,
                 decision_json TEXT,
                 decided_at INTEGER NOT NULL,
                 PRIMARY KEY(article_id, fingerprint, model_id, prompt_version),
                 FOREIGN KEY(article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS intelligence_triage_latest_idx
                 ON intelligence_triage_decisions(article_id, decided_at DESC);
             CREATE TABLE IF NOT EXISTS intelligence_relations (
                 relation_id TEXT PRIMARY KEY,
                 left_article_id TEXT NOT NULL,
                 right_article_id TEXT NOT NULL,
                 stage TEXT NOT NULL,
                 relation TEXT NOT NULL,
                 confidence REAL,
                 model_id TEXT,
                 evidence_json TEXT,
                 updated_at INTEGER NOT NULL,
                 UNIQUE(left_article_id, right_article_id, stage),
                 FOREIGN KEY(left_article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE,
                 FOREIGN KEY(right_article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS intelligence_relations_stage_idx
                 ON intelligence_relations(stage, relation, confidence);
             CREATE TABLE IF NOT EXISTS intelligence_series (
                 series_id TEXT PRIMARY KEY,
                 title TEXT NOT NULL,
                 summary TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_events (
                 event_id TEXT PRIMARY KEY,
                 series_id TEXT,
                 title TEXT NOT NULL,
                 summary TEXT,
                 importance REAL,
                 occurred_at TEXT,
                 current_revision INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 FOREIGN KEY(series_id) REFERENCES intelligence_series(series_id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_events_series_idx
                 ON intelligence_events(series_id, occurred_at, updated_at);
             CREATE TABLE IF NOT EXISTS intelligence_event_articles (
                 event_id TEXT NOT NULL,
                 article_id TEXT NOT NULL,
                 PRIMARY KEY(event_id, article_id),
                 FOREIGN KEY(event_id) REFERENCES intelligence_events(event_id) ON DELETE CASCADE,
                 FOREIGN KEY(article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS intelligence_event_revisions (
                 event_id TEXT NOT NULL,
                 revision_no INTEGER NOT NULL,
                 body TEXT,
                 revision_json TEXT,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY(event_id, revision_no),
                 FOREIGN KEY(event_id) REFERENCES intelligence_events(event_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS intelligence_series_events (
                 series_id TEXT NOT NULL,
                 event_id TEXT NOT NULL,
                 position INTEGER NOT NULL DEFAULT 0,
                 relative_to_event_id TEXT,
                 relation_type TEXT,
                 relation_reason TEXT,
                 relation_confidence REAL,
                 PRIMARY KEY(series_id, event_id),
                 FOREIGN KEY(series_id) REFERENCES intelligence_series(series_id) ON DELETE CASCADE,
                 FOREIGN KEY(event_id) REFERENCES intelligence_events(event_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS intelligence_quality_reviews (
                 review_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 target_kind TEXT NOT NULL,
                 target_id TEXT NOT NULL,
                 sampled INTEGER NOT NULL,
                 verdict TEXT NOT NULL,
                 confidence REAL,
                 model_id TEXT NOT NULL,
                 detail_json TEXT,
                 reviewed_at INTEGER NOT NULL,
                 review_epoch INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS intelligence_quality_reviews_latest_idx
                 ON intelligence_quality_reviews(reviewed_at DESC, target_kind);
             CREATE TABLE IF NOT EXISTS intelligence_quality_gate_state (
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                 review_mode TEXT NOT NULL DEFAULT 'full'
                     CHECK(review_mode IN ('full','sample')),
                 review_epoch INTEGER NOT NULL DEFAULT 0,
                 stable_relation_batches INTEGER NOT NULL DEFAULT 0,
                 last_transition_reason TEXT NOT NULL DEFAULT 'initial_calibration',
                 last_transition_at INTEGER NOT NULL DEFAULT 0
             );
             INSERT OR IGNORE INTO intelligence_quality_gate_state(
                 singleton,review_mode,review_epoch,stable_relation_batches,
                 last_transition_reason,last_transition_at
             ) VALUES(1,'full',0,0,'initial_calibration',0);
             CREATE TABLE IF NOT EXISTS intelligence_pipeline_runs (
                 run_id TEXT PRIMARY KEY,
                 status TEXT NOT NULL,
                 started_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_pipeline_stage_checkpoints (
                 run_id TEXT NOT NULL,
                 stage TEXT NOT NULL,
                 status TEXT NOT NULL
                     CHECK (status IN ('started','completed','failed','cancelled')),
                 started_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(run_id, stage),
                 FOREIGN KEY(run_id) REFERENCES intelligence_pipeline_runs(run_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS intelligence_audit_items (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 run_id TEXT NOT NULL,
                 stage TEXT NOT NULL,
                 unit_kind TEXT NOT NULL,
                 item_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 detail_json TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 UNIQUE(run_id, stage, unit_kind, item_id),
                 FOREIGN KEY(run_id) REFERENCES intelligence_pipeline_runs(run_id) ON DELETE CASCADE
             );",
        )
        .map_err(|error| format!("初始化情报数据库结构失败：{error}"))?;
    migrate_audit_run_id(connection)?;
    ensure_column(
        connection,
        "intelligence_articles",
        "triage_attempts",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "intelligence_articles",
        "next_retry_at",
        "INTEGER",
    )?;
    ensure_column(
        connection,
        "intelligence_articles",
        "evidence_fingerprint",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "intelligence_retrieval_profile",
        "calibration_status",
        "TEXT NOT NULL DEFAULT 'not_configured'",
    )?;
    ensure_column(
        connection,
        "intelligence_retrieval_profile",
        "calibrated_pairs",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "intelligence_series_events",
        "relative_to_event_id",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "intelligence_series_events",
        "relation_type",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "intelligence_series_events",
        "relation_reason",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "intelligence_series_events",
        "relation_confidence",
        "REAL",
    )?;
    ensure_column(
        connection,
        "intelligence_quality_reviews",
        "review_epoch",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    connection
        .execute_batch(
            "DROP INDEX IF EXISTS intelligence_quality_reviews_latest_idx;
             CREATE INDEX IF NOT EXISTS intelligence_quality_reviews_latest_idx
                 ON intelligence_quality_reviews(review_epoch, reviewed_at DESC, target_kind);",
        )
        .map_err(|error| error.to_string())?;
    // Review writes are resumable. Reopening the intelligence page must not
    // count the same model verdict twice.
    connection
        .execute(
            "DELETE FROM intelligence_quality_reviews
             WHERE review_id NOT IN (
                 SELECT MAX(review_id) FROM intelligence_quality_reviews
                 GROUP BY target_kind,target_id,model_id
             )",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS intelligence_quality_reviews_identity_idx
                 ON intelligence_quality_reviews(target_kind,target_id,model_id);",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE intelligence_articles SET triage_state='queued',next_retry_at=0
             WHERE triage_state='failed'",
            [],
        )
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    connection
        .execute(
            "INSERT INTO intelligence_pipeline_runs(run_id,status,started_at,updated_at)
             VALUES(?1,'running',?2,?2)
             ON CONFLICT(run_id) DO NOTHING",
            params![pipeline_run_id(), timestamp],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS intelligence_audit_stage_idx
                 ON intelligence_audit_items(run_id,stage,id DESC);",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO intelligence_metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [STORE_VERSION.to_string()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if columns.iter().any(|candidate| candidate == column) {
        return Ok(());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))
        .map_err(|error| format!("迁移情报字段 {table}.{column} 失败：{error}"))
}

fn migrate_audit_run_id(connection: &Connection) -> Result<(), String> {
    let has_run_id = {
        let mut statement = connection
            .prepare("PRAGMA table_info(intelligence_audit_items)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        columns.iter().any(|column| column == "run_id")
    };
    if has_run_id {
        return Ok(());
    }
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             BEGIN IMMEDIATE;
             ALTER TABLE intelligence_audit_items RENAME TO intelligence_audit_items_legacy;
             CREATE TABLE intelligence_audit_items (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 run_id TEXT NOT NULL,
                 stage TEXT NOT NULL,
                 unit_kind TEXT NOT NULL,
                 item_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 detail_json TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 UNIQUE(run_id,stage,unit_kind,item_id)
             );
             INSERT INTO intelligence_audit_items(
                 id,run_id,stage,unit_kind,item_id,status,detail_json,created_at,updated_at
             ) SELECT id,'legacy',stage,unit_kind,item_id,status,detail_json,created_at,updated_at
               FROM intelligence_audit_items_legacy;
             DROP TABLE intelligence_audit_items_legacy;
             COMMIT;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|error| format!("迁移情报审计批次失败：{error}"))?;
    Ok(())
}

fn mark_stage_started(
    connection: &Connection,
    run_id: &str,
    stage: &str,
    timestamp: i64,
) -> Result<(), String> {
    let stage_index = AUDIT_STAGES
        .iter()
        .position(|candidate| *candidate == stage)
        .ok_or_else(|| "未知的情报审计阶段".to_string())?;
    // A downstream stage can only start after every earlier stage has
    // finished, including legitimate zero-output stages. Persist that fact
    // once instead of reconstructing it later from audit row counts.
    for completed_stage in &AUDIT_STAGES[..stage_index] {
        connection
            .execute(
                "INSERT INTO intelligence_pipeline_stage_checkpoints(
                     run_id,stage,status,started_at,updated_at
                 ) VALUES(?1,?2,'completed',?3,?3)
                 ON CONFLICT(run_id,stage) DO UPDATE SET
                     status=CASE
                         WHEN intelligence_pipeline_stage_checkpoints.status='started'
                         THEN 'completed'
                         ELSE intelligence_pipeline_stage_checkpoints.status
                     END,
                     updated_at=CASE
                         WHEN intelligence_pipeline_stage_checkpoints.status='started'
                         THEN excluded.updated_at
                         ELSE intelligence_pipeline_stage_checkpoints.updated_at
                     END",
                params![run_id, completed_stage, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "INSERT INTO intelligence_pipeline_stage_checkpoints(
                 run_id,stage,status,started_at,updated_at
             ) VALUES(?1,?2,'started',?3,?3)
             ON CONFLICT(run_id,stage) DO UPDATE SET
                 updated_at=CASE
                     WHEN intelligence_pipeline_stage_checkpoints.status='started'
                     THEN excluded.updated_at
                     ELSE intelligence_pipeline_stage_checkpoints.updated_at
                 END",
            params![run_id, stage, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn finish_stage_checkpoints(
    connection: &Connection,
    run_id: &str,
    run_status: &str,
    timestamp: i64,
) -> Result<(), String> {
    match run_status {
        "completed" => {
            // A completed run proves that even stages with zero accepted rows
            // finished successfully. Record all nine explicit checkpoints.
            for stage in AUDIT_STAGES {
                connection
                    .execute(
                        "INSERT INTO intelligence_pipeline_stage_checkpoints(
                             run_id,stage,status,started_at,updated_at
                         ) VALUES(?1,?2,'completed',?3,?3)
                         ON CONFLICT(run_id,stage) DO UPDATE SET
                             status='completed',updated_at=excluded.updated_at",
                        params![run_id, stage, timestamp],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        "failed" | "cancelled" => {
            let changed = connection
                .execute(
                    "UPDATE intelligence_pipeline_stage_checkpoints
                     SET status=?2,updated_at=?3
                     WHERE run_id=?1 AND status='started'",
                    params![run_id, run_status, timestamp],
                )
                .map_err(|error| error.to_string())?;
            if changed == 0 {
                // Preserve an explicit terminal checkpoint even if startup
                // failed before the first item could be audited.
                connection
                    .execute(
                        "INSERT INTO intelligence_pipeline_stage_checkpoints(
                             run_id,stage,status,started_at,updated_at
                         ) VALUES(?1,'collected',?2,?3,?3)
                         ON CONFLICT(run_id,stage) DO UPDATE SET
                             status=excluded.status,updated_at=excluded.updated_at",
                        params![run_id, run_status, timestamp],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        _ => return Err("未知的情报批次结束状态".into()),
    }
    Ok(())
}

fn audit_item(
    transaction: &Transaction<'_>,
    stage: &str,
    unit_kind: &str,
    item_id: &str,
    status: &str,
    detail_json: Option<&str>,
    timestamp: i64,
) -> Result<(), String> {
    validate_stage(stage)?;
    let run_id = pipeline_run_id();
    mark_stage_started(transaction, &run_id, stage, timestamp)?;
    transaction
        .execute(
            "INSERT INTO intelligence_audit_items(
                 run_id, stage, unit_kind, item_id, status, detail_json, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(run_id, stage, unit_kind, item_id) DO UPDATE SET
                 status=excluded.status,
                 detail_json=excluded.detail_json,
                 updated_at=excluded.updated_at",
            params![
                run_id,
                stage,
                unit_kind,
                item_id,
                status,
                detail_json,
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArticleInput {
    pub article_id: String,
    pub fingerprint: String,
    pub url: Option<String>,
    pub source_key: Option<String>,
    pub source_name: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub language: Option<String>,
    pub media_json: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertArticlesRequest {
    pub articles: Vec<IntelligenceArticleInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertResult {
    pub received: u64,
    pub inserted: u64,
    pub updated: u64,
    pub unchanged: u64,
    /// Newly queued by this request (inserted + changed fingerprints).
    pub queued: u64,
    /// Durable queue size across all runs, for diagnostics only.
    pub queue_total: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArticleEvidenceInput {
    pub article_id: String,
    /// Fingerprint of the stored feed record.  This guards against attaching
    /// asynchronously fetched evidence to a newer version of the article.
    #[serde(alias = "fingerprint", alias = "expectedFingerprint")]
    pub record_fingerprint: String,
    /// Fingerprint of the fetched body/media evidence.  It is deliberately
    /// independent from `record_fingerprint`, because enriching evidence must
    /// not reset triage or detach a stable event projection.
    pub evidence_fingerprint: Option<String>,
    pub body: Option<String>,
    pub media_json: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArticleEvidenceUpdateResult {
    pub received: u64,
    pub updated: u64,
    pub skipped: u64,
    pub missing: u64,
    pub mismatched: u64,
    pub applied_article_ids: Vec<String>,
    pub missing_article_ids: Vec<String>,
    pub mismatched_article_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreClaimTriageRequest {
    pub limit: Option<u32>,
    pub lease_owner: Option<String>,
    pub lease_seconds: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoredArticle {
    pub article_id: String,
    pub fingerprint: String,
    pub url: Option<String>,
    pub source_key: Option<String>,
    pub source_name: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub language: Option<String>,
    pub media_json: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreClaimTriageResult {
    pub lease_owner: String,
    pub articles: Vec<IntelligenceStoredArticle>,
    pub remaining: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceTriageDecisionInput {
    pub article_id: String,
    pub fingerprint: String,
    pub status: String,
    pub importance: Option<f64>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub decision_json: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreApplyTriageRequest {
    pub lease_owner: String,
    pub model_id: String,
    pub model_sha: Option<String>,
    pub prompt_version: String,
    pub decisions: Vec<IntelligenceTriageDecisionInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreApplyTriageResult {
    pub received: u64,
    pub applied: u64,
    pub stale: u64,
    pub kept: u64,
    pub filtered: u64,
    pub failed: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreTriageDecisionsRequest {
    pub article_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoredTriageDecision {
    pub article_id: String,
    pub fingerprint: String,
    pub status: String,
    pub importance: Option<f64>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub decision_json: Option<Value>,
    pub model_id: String,
    pub prompt_version: String,
    pub decided_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreTriageDecisionsResult {
    pub decisions: Vec<IntelligenceStoredTriageDecision>,
}

fn normalize_article(input: IntelligenceArticleInput) -> Result<IntelligenceArticleInput, String> {
    Ok(IntelligenceArticleInput {
        article_id: required(&input.article_id, "文章 ID", 200)?,
        fingerprint: required(&input.fingerprint, "文章指纹", 200)?,
        url: optional(input.url, "文章网址", 4_096)?,
        source_key: optional(input.source_key, "来源标识", 200)?,
        source_name: optional(input.source_name, "来源名称", 300)?,
        title: required(&input.title, "文章标题", 2_000)?,
        summary: optional(input.summary, "文章摘要", 64 * 1024)?,
        body: optional(input.body, "文章正文", MAX_ARTICLE_BODY_BYTES)?,
        published_at: optional(input.published_at, "发布时间", 100)?,
        language: optional(input.language, "语言", 40)?,
        media_json: input.media_json,
    })
}

fn upsert_articles_at(
    path: &Path,
    request: IntelligenceStoreUpsertArticlesRequest,
) -> Result<IntelligenceStoreUpsertResult, String> {
    if request.articles.is_empty() || request.articles.len() > MAX_ARTICLES_PER_BATCH {
        return Err(format!(
            "每批文章数量必须在 1 到 {MAX_ARTICLES_PER_BATCH} 之间"
        ));
    }
    let articles = request
        .articles
        .into_iter()
        .map(normalize_article)
        .collect::<Result<Vec<_>, _>>()?;
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let mut inserted = 0_u64;
    let mut updated = 0_u64;
    let mut unchanged = 0_u64;
    for article in &articles {
        let media_json = json_text(article.media_json.clone(), "媒体信息")?;
        let existing = transaction
            .query_row(
                "SELECT fingerprint FROM intelligence_articles WHERE article_id=?1",
                [&article.article_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let status = match existing {
            None => {
                transaction
                    .execute(
                        "INSERT INTO intelligence_articles(
                             article_id, fingerprint, url, source_key, source_name, title, summary,
                             body, published_at, language, media_json, triage_state, created_at, updated_at
                         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'queued',?12,?12)",
                        params![
                            article.article_id,
                            article.fingerprint,
                            article.url,
                            article.source_key,
                            article.source_name,
                            article.title,
                            article.summary,
                            article.body,
                            article.published_at,
                            article.language,
                            media_json,
                            timestamp,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                inserted += 1;
                "queued"
            }
            Some(fingerprint) if fingerprint == article.fingerprint => {
                transaction
                    .execute(
                        "UPDATE intelligence_articles SET
                             url=?2, source_key=?3, source_name=?4, title=?5, summary=?6,
                             body=COALESCE(?7,body), published_at=?8, language=?9,
                             media_json=COALESCE(?10,media_json), updated_at=?11
                         WHERE article_id=?1",
                        params![
                            article.article_id,
                            article.url,
                            article.source_key,
                            article.source_name,
                            article.title,
                            article.summary,
                            article.body,
                            article.published_at,
                            article.language,
                            media_json,
                            timestamp,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                unchanged += 1;
                "unchanged"
            }
            Some(_) => {
                transaction
                    .execute(
                        "UPDATE intelligence_articles SET
                             fingerprint=?2, url=?3, source_key=?4, source_name=?5, title=?6,
                             summary=?7, body=?8, published_at=?9, language=?10, media_json=?11,
                             evidence_fingerprint=NULL,
                             triage_state='queued', triage_attempts=0, next_retry_at=NULL,
                             lease_owner=NULL, lease_until=NULL, updated_at=?12
                         WHERE article_id=?1",
                        params![
                            article.article_id,
                            article.fingerprint,
                            article.url,
                            article.source_key,
                            article.source_name,
                            article.title,
                            article.summary,
                            article.body,
                            article.published_at,
                            article.language,
                            media_json,
                            timestamp,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "DELETE FROM intelligence_relations
                         WHERE left_article_id=?1 OR right_article_id=?1",
                        [&article.article_id],
                    )
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "DELETE FROM intelligence_event_articles WHERE article_id=?1",
                        [&article.article_id],
                    )
                    .map_err(|error| error.to_string())?;
                updated += 1;
                "queued"
            }
        };
        let stored_body = transaction
            .query_row(
                "SELECT body FROM intelligence_articles WHERE article_id=?1",
                [&article.article_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM intelligence_news_fts WHERE article_id=?1",
                [&article.article_id],
            )
            .map_err(|error| error.to_string())?;
        let sparse_entities = sparse_terms(&format!(
            "{} {} {}",
            article.title,
            article.summary.as_deref().unwrap_or_default(),
            stored_body.as_deref().unwrap_or_default()
        ))
        .join(" ");
        transaction
            .execute(
                "INSERT INTO intelligence_news_fts(article_id, title, summary, body, entities)
                 VALUES(?1,?2,?3,?4,?5)",
                params![
                    article.article_id,
                    article.title,
                    article.summary,
                    stored_body,
                    sparse_entities,
                ],
            )
            .map_err(|error| error.to_string())?;
        let audit_detail = serde_json::to_string(&serde_json::json!({
            "articleId": article.article_id,
            "title": article.title,
            "sourceName": article.source_name,
            "publishedAt": article.published_at,
            "recordStatus": status,
        }))
        .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "collected",
            "articles",
            &article.article_id,
            "stored",
            Some(&audit_detail),
            timestamp,
        )?;
        audit_item(
            &transaction,
            "exact-dedupe",
            "articles",
            &article.article_id,
            status,
            Some(&audit_detail),
            timestamp,
        )?;
        if status == "queued" {
            audit_item(
                &transaction,
                "article-triage",
                "articles",
                &article.article_id,
                "queued",
                Some(&audit_detail),
                timestamp,
            )?;
        }
    }
    let queue_total = transaction
        .query_row(
            "SELECT COUNT(*) FROM intelligence_articles WHERE triage_state='queued'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligenceStoreUpsertResult {
        received: articles.len() as u64,
        inserted,
        updated,
        unchanged,
        queued: inserted + updated,
        queue_total,
    })
}

fn update_article_evidence_at(
    path: &Path,
    articles: Vec<IntelligenceArticleEvidenceInput>,
) -> Result<IntelligenceArticleEvidenceUpdateResult, String> {
    if articles.is_empty() || articles.len() > MAX_ARTICLES_PER_BATCH {
        return Err(format!(
            "每批正文证据数量必须在 1 到 {MAX_ARTICLES_PER_BATCH} 之间"
        ));
    }
    let received = articles.len() as u64;
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let mut updated = 0_u64;
    let mut applied_article_ids = Vec::new();
    let mut missing_article_ids = Vec::new();
    let mut mismatched_article_ids = Vec::new();
    for input in articles {
        let article_id = required(&input.article_id, "文章 ID", 200)?;
        let record_fingerprint = required(&input.record_fingerprint, "文章记录指纹", 200)?;
        let body = optional(input.body, "文章正文", MAX_ARTICLE_BODY_BYTES)?;
        let media_json = json_text(input.media_json, "媒体信息")?;
        if body.is_none() && media_json.is_none() {
            continue;
        }
        let Some(current_fingerprint) = transaction
            .query_row(
                "SELECT fingerprint FROM intelligence_articles WHERE article_id=?1",
                [&article_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
        else {
            missing_article_ids.push(article_id);
            continue;
        };
        if current_fingerprint != record_fingerprint {
            mismatched_article_ids.push(article_id);
            continue;
        }
        let evidence_fingerprint = match optional(input.evidence_fingerprint, "正文证据指纹", 200)?
        {
            Some(value) => value,
            None => {
                let mut digest = Sha256::new();
                digest.update(body.as_deref().unwrap_or_default().as_bytes());
                digest.update([0_u8]);
                digest.update(media_json.as_deref().unwrap_or_default().as_bytes());
                let digest = digest.finalize();
                format!(
                    "sha256:{}",
                    digest
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                )
            }
        };
        let changed = transaction
            .execute(
                "UPDATE intelligence_articles SET
                     body=COALESCE(?3,body),media_json=COALESCE(?4,media_json),
                     evidence_fingerprint=?5,updated_at=?6
                 WHERE article_id=?1 AND fingerprint=?2",
                params![
                    article_id,
                    record_fingerprint,
                    body,
                    media_json,
                    evidence_fingerprint,
                    timestamp
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            mismatched_article_ids.push(article_id);
            continue;
        }
        let (title, summary, current_body) = transaction
            .query_row(
                "SELECT title,summary,body FROM intelligence_articles WHERE article_id=?1",
                [&article_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM intelligence_news_fts WHERE article_id=?1",
                [&article_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO intelligence_news_fts(article_id,title,summary,body,entities)
                 VALUES(?1,?2,?3,?4,'')",
                params![article_id, title, summary, current_body],
            )
            .map_err(|error| error.to_string())?;
        updated += 1;
        applied_article_ids.push(article_id);
    }
    transaction.commit().map_err(|error| error.to_string())?;
    let missing = missing_article_ids.len() as u64;
    let mismatched = mismatched_article_ids.len() as u64;
    Ok(IntelligenceArticleEvidenceUpdateResult {
        received,
        updated,
        skipped: received.saturating_sub(updated),
        missing,
        mismatched,
        applied_article_ids,
        missing_article_ids,
        mismatched_article_ids,
    })
}

fn claim_triage_at(
    path: &Path,
    request: IntelligenceStoreClaimTriageRequest,
) -> Result<IntelligenceStoreClaimTriageResult, String> {
    let limit = request.limit.unwrap_or(24).clamp(1, 100) as usize;
    let lease_seconds = request.lease_seconds.unwrap_or(600).clamp(30, 3_600) as i64;
    let lease_owner = request
        .lease_owner
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("triage:{}", uuid::Uuid::new_v4()));
    bounded(&lease_owner, "租约标识", 200)?;
    let timestamp = now_ms();
    let lease_until = timestamp + lease_seconds * 1_000;
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE intelligence_articles SET triage_state='queued', lease_owner=NULL, lease_until=NULL
             WHERE triage_state='processing' AND lease_until < ?1",
            [timestamp],
        )
        .map_err(|error| error.to_string())?;
    let ids = {
        let mut statement = transaction
            .prepare(
                "SELECT article_id FROM intelligence_articles
                 WHERE triage_state='queued' AND COALESCE(next_retry_at,0) <= ?2
                 ORDER BY CASE WHEN published_at IS NULL THEN 1 ELSE 0 END,
                          published_at DESC, created_at ASC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit as i64, timestamp], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for id in &ids {
        transaction
            .execute(
                "UPDATE intelligence_articles SET
                     triage_state='processing', lease_owner=?2, lease_until=?3, updated_at=?4
                 WHERE article_id=?1 AND triage_state='queued'",
                params![id, lease_owner, lease_until, timestamp],
            )
            .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "article-triage",
            "articles",
            id,
            "processing",
            None,
            timestamp,
        )?;
    }
    let mut articles = Vec::with_capacity(ids.len());
    {
        let mut statement = transaction
            .prepare(
                "SELECT article_id, fingerprint, url, source_key, source_name, title, summary,
                        body, published_at, language, media_json
                 FROM intelligence_articles WHERE article_id=?1 AND lease_owner=?2",
            )
            .map_err(|error| error.to_string())?;
        for id in &ids {
            let article = statement
                .query_row(params![id, lease_owner], |row| {
                    Ok(IntelligenceStoredArticle {
                        article_id: row.get(0)?,
                        fingerprint: row.get(1)?,
                        url: row.get(2)?,
                        source_key: row.get(3)?,
                        source_name: row.get(4)?,
                        title: row.get(5)?,
                        summary: row.get(6)?,
                        body: row.get(7)?,
                        published_at: row.get(8)?,
                        language: row.get(9)?,
                        media_json: parse_json(row.get(10)?),
                    })
                })
                .map_err(|error| error.to_string())?;
            articles.push(article);
        }
    }
    let remaining = transaction
        .query_row(
            "SELECT COUNT(*) FROM intelligence_articles WHERE triage_state='queued'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligenceStoreClaimTriageResult {
        lease_owner,
        articles,
        remaining,
    })
}

fn apply_triage_at(
    path: &Path,
    request: IntelligenceStoreApplyTriageRequest,
) -> Result<IntelligenceStoreApplyTriageResult, String> {
    if request.decisions.is_empty() || request.decisions.len() > MAX_DECISIONS_PER_BATCH {
        return Err(format!(
            "每批初筛结果数量必须在 1 到 {MAX_DECISIONS_PER_BATCH} 之间"
        ));
    }
    let lease_owner = required(&request.lease_owner, "租约标识", 200)?;
    let model_id = required(&request.model_id, "模型标识", 300)?;
    let model_sha = optional(request.model_sha, "模型 SHA", 200)?;
    let prompt_version = required(&request.prompt_version, "提示词版本", 200)?;
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let mut result = IntelligenceStoreApplyTriageResult {
        received: request.decisions.len() as u64,
        applied: 0,
        stale: 0,
        kept: 0,
        filtered: 0,
        failed: 0,
    };
    for decision in request.decisions {
        let article_id = required(&decision.article_id, "文章 ID", 200)?;
        let fingerprint = required(&decision.fingerprint, "文章指纹", 200)?;
        let status = decision.status.trim();
        if !matches!(status, "keep" | "filter" | "failed") {
            return Err("初筛状态只能是 keep、filter 或 failed".into());
        }
        if decision.importance.is_some_and(|value| !value.is_finite())
            || decision.confidence.is_some_and(|value| !value.is_finite())
        {
            return Err("初筛分数必须是有限数值".into());
        }
        let reason = optional(decision.reason, "初筛原因", 16 * 1024)?;
        let decision_json = json_text(decision.decision_json, "初筛详情")?;
        let attempt = transaction
            .query_row(
                "SELECT triage_attempts,title FROM intelligence_articles
                 WHERE article_id=?1 AND fingerprint=?2 AND triage_state='processing'
                   AND lease_owner=?3",
                params![article_id, fingerprint, lease_owner],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((attempts, article_title)) = attempt else {
            result.stale += 1;
            continue;
        };
        let retry_at = if status == "failed" {
            let exponent = attempts.min(6);
            Some(timestamp + (30_000_i64 << exponent))
        } else {
            None
        };
        let stored_state = if status == "failed" { "queued" } else { status };
        let applied = transaction
            .execute(
                "UPDATE intelligence_articles SET
                     triage_state=?4,
                     triage_attempts=CASE WHEN ?6='failed' THEN triage_attempts+1 ELSE triage_attempts END,
                     next_retry_at=?7, lease_owner=NULL, lease_until=NULL, updated_at=?5
                 WHERE article_id=?1 AND fingerprint=?2 AND triage_state='processing'
                   AND lease_owner=?3",
                params![
                    article_id,
                    fingerprint,
                    lease_owner,
                    stored_state,
                    timestamp,
                    status,
                    retry_at
                ],
            )
            .map_err(|error| error.to_string())?;
        if applied == 0 {
            result.stale += 1;
            continue;
        }
        transaction
            .execute(
                "INSERT INTO intelligence_triage_decisions(
                     article_id, fingerprint, model_id, model_sha, prompt_version, status,
                     importance, confidence, reason, decision_json, decided_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(article_id, fingerprint, model_id, prompt_version) DO UPDATE SET
                     model_sha=excluded.model_sha, status=excluded.status,
                     importance=excluded.importance, confidence=excluded.confidence,
                     reason=excluded.reason, decision_json=excluded.decision_json,
                     decided_at=excluded.decided_at",
                params![
                    article_id,
                    fingerprint,
                    model_id,
                    model_sha,
                    prompt_version,
                    status,
                    decision.importance,
                    decision.confidence,
                    reason,
                    decision_json,
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        let audit_detail = serde_json::to_string(&serde_json::json!({
            "articleId": article_id,
            "title": article_title,
            "model": model_id,
            "status": status,
            "importance": decision.importance,
            "confidence": decision.confidence,
            "reason": reason,
            "decision": parse_json(decision_json.clone()),
            "attempts": attempts,
            "nextRetryAt": retry_at,
        }))
        .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "article-triage",
            "articles",
            &article_id,
            if status == "failed" { "retry" } else { status },
            Some(&audit_detail),
            timestamp,
        )?;
        result.applied += 1;
        match status {
            "keep" => result.kept += 1,
            "filter" => result.filtered += 1,
            _ => result.failed += 1,
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

fn triage_decisions_at(
    path: &Path,
    request: IntelligenceStoreTriageDecisionsRequest,
) -> Result<IntelligenceStoreTriageDecisionsResult, String> {
    if request.article_ids.is_empty() || request.article_ids.len() > MAX_QUERY_IDS {
        return Err(format!("查询文章数量必须在 1 到 {MAX_QUERY_IDS} 之间"));
    }
    let connection = open_store_at(path)?;
    let mut statement = connection
        .prepare(
            "SELECT article_id, fingerprint, status, importance, confidence, reason,
                    decision_json, model_id, prompt_version, decided_at
             FROM intelligence_triage_decisions
             WHERE article_id=?1
             ORDER BY decided_at DESC LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut decisions = Vec::new();
    for article_id in request.article_ids {
        let article_id = required(&article_id, "文章 ID", 200)?;
        let decision = statement
            .query_row([article_id], |row| {
                Ok(IntelligenceStoredTriageDecision {
                    article_id: row.get(0)?,
                    fingerprint: row.get(1)?,
                    status: row.get(2)?,
                    importance: row.get(3)?,
                    confidence: row.get(4)?,
                    reason: row.get(5)?,
                    decision_json: parse_json(row.get(6)?),
                    model_id: row.get(7)?,
                    prompt_version: row.get(8)?,
                    decided_at: row.get(9)?,
                })
            })
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(decision) = decision {
            decisions.push(decision);
        }
    }
    Ok(IntelligenceStoreTriageDecisionsResult { decisions })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceRelationInput {
    pub left_article_id: String,
    pub right_article_id: String,
    pub relation: String,
    pub confidence: Option<f64>,
    pub stage: String,
    pub model_id: Option<String>,
    pub evidence_json: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertRelationsRequest {
    pub relations: Vec<IntelligenceRelationInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreWriteResult {
    pub received: u64,
    pub applied: u64,
}

fn relation_pair(left: &str, right: &str) -> (String, String, String) {
    let (left, right) = if left <= right {
        (left.to_string(), right.to_string())
    } else {
        (right.to_string(), left.to_string())
    };
    let relation_id = format!("{left}\u{1f}{right}");
    (left, right, relation_id)
}

fn upsert_relations_at(
    path: &Path,
    request: IntelligenceStoreUpsertRelationsRequest,
) -> Result<IntelligenceStoreWriteResult, String> {
    if request.relations.is_empty() || request.relations.len() > MAX_RELATIONS_PER_BATCH {
        return Err(format!(
            "每批关系数量必须在 1 到 {MAX_RELATIONS_PER_BATCH} 之间"
        ));
    }
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let received = request.relations.len() as u64;
    for relation in request.relations {
        let left = required(&relation.left_article_id, "左侧文章 ID", 200)?;
        let right = required(&relation.right_article_id, "右侧文章 ID", 200)?;
        if left == right {
            return Err("不能保存文章与自身的关系".into());
        }
        let stage = validate_stage(relation.stage.trim())?;
        if !matches!(
            stage,
            "relation-recall" | "relation-judge" | "historical-recall"
        ) {
            return Err("文章关系只能写入召回、判定或历史召回阶段".into());
        }
        let relation_kind = validate_relation(relation.relation.trim())?;
        if relation.confidence.is_some_and(|value| !value.is_finite()) {
            return Err("关系置信度必须是有限数值".into());
        }
        let model_id = optional(relation.model_id, "关系模型标识", 300)?;
        let evidence_json = json_text(relation.evidence_json, "关系证据")?;
        let (left, right, relation_id) = relation_pair(&left, &right);
        let (left_title, right_title) = (
            transaction
                .query_row(
                    "SELECT title FROM intelligence_articles WHERE article_id=?1",
                    [&left],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?,
            transaction
                .query_row(
                    "SELECT title FROM intelligence_articles WHERE article_id=?1",
                    [&right],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?,
        );
        transaction
            .execute(
                "INSERT INTO intelligence_relations(
                     relation_id, left_article_id, right_article_id, stage, relation,
                     confidence, model_id, evidence_json, updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(left_article_id, right_article_id, stage) DO UPDATE SET
                     relation_id=excluded.relation_id, relation=excluded.relation,
                     confidence=excluded.confidence, model_id=excluded.model_id,
                     evidence_json=excluded.evidence_json, updated_at=excluded.updated_at",
                params![
                    relation_id,
                    left,
                    right,
                    stage,
                    relation_kind,
                    relation.confidence,
                    model_id,
                    evidence_json,
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        let evidence = parse_json(evidence_json.clone());
        let reason = evidence
            .as_ref()
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str);
        let audit_detail = serde_json::to_string(&serde_json::json!({
            "leftArticleId": left,
            "rightArticleId": right,
            "leftTitle": left_title,
            "rightTitle": right_title,
            "model": model_id,
            "relation": relation_kind,
            "confidence": relation.confidence,
            "reason": reason,
            "evidence": evidence,
        }))
        .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            stage,
            "pairs",
            &relation_id,
            relation_kind,
            Some(&audit_detail),
            timestamp,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligenceStoreWriteResult {
        received,
        applied: received,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertEventRequest {
    pub event_id: Option<String>,
    pub series_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub importance: Option<f64>,
    pub occurred_at: Option<String>,
    pub article_ids: Vec<String>,
    pub revision_body: Option<String>,
    pub revision_json: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEventProjection {
    pub event_id: String,
    pub series_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub importance: Option<f64>,
    pub occurred_at: Option<String>,
    pub current_revision: u64,
    /// Numeric alias used by prepared-news links and persisted candidates.
    pub revision: u64,
    pub article_ids: Vec<String>,
    pub revision_body: Option<String>,
    pub revision_json: Option<Value>,
    pub updated_at: i64,
}

fn event_projection(
    connection: &Connection,
    event_id: &str,
) -> Result<Option<IntelligenceEventProjection>, String> {
    event_projection_at_revision(connection, event_id, None)
}

fn event_projection_at_revision(
    connection: &Connection,
    event_id: &str,
    selected_revision: Option<u64>,
) -> Result<Option<IntelligenceEventProjection>, String> {
    let event = connection
        .query_row(
            "SELECT event_id, series_id, title, summary, importance, occurred_at,
                    current_revision, updated_at
             FROM intelligence_events WHERE event_id=?1",
            [event_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, u64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((
        event_id,
        series_id,
        title,
        summary,
        importance,
        occurred_at,
        current_revision,
        updated_at,
    )) = event
    else {
        return Ok(None);
    };
    let article_ids = {
        let mut statement = connection
            .prepare(
                "SELECT article_id FROM intelligence_event_articles
                 WHERE event_id=?1 ORDER BY article_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&event_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let revision = selected_revision.unwrap_or(current_revision);
    if selected_revision.is_some() && (revision == 0 || revision > current_revision) {
        return Err(format!("事件修订版本必须在 1 到 {current_revision} 之间"));
    }
    let (revision_body, revision_json) = if revision == 0 {
        (None, None)
    } else {
        let stored = connection
            .query_row(
                "SELECT body, revision_json FROM intelligence_event_revisions
                 WHERE event_id=?1 AND revision_no=?2",
                params![event_id, revision],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        parse_json(row.get::<_, Option<String>>(1)?),
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        stored.ok_or_else(|| format!("事件修订 {revision} 不存在"))?
    };
    Ok(Some(IntelligenceEventProjection {
        event_id,
        series_id,
        title,
        summary,
        importance,
        occurred_at,
        current_revision,
        revision,
        article_ids,
        revision_body,
        revision_json,
        updated_at,
    }))
}

fn upsert_event_at(
    path: &Path,
    request: IntelligenceStoreUpsertEventRequest,
) -> Result<IntelligenceEventProjection, String> {
    let event_id = request
        .event_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("event:{}", uuid::Uuid::new_v4()));
    let event_id = required(&event_id, "事件 ID", 200)?;
    let series_id = optional(request.series_id, "系列 ID", 200)?;
    let title = required(&request.title, "事件标题", 2_000)?;
    let summary = optional(request.summary, "事件摘要", 128 * 1024)?;
    let occurred_at = optional(request.occurred_at, "事件时间", 100)?;
    if request.importance.is_some_and(|value| !value.is_finite()) {
        return Err("事件重要性必须是有限数值".into());
    }
    if request.article_ids.len() > MAX_QUERY_IDS {
        return Err(format!("事件来源不能超过 {MAX_QUERY_IDS} 篇文章"));
    }
    let mut article_ids = request
        .article_ids
        .into_iter()
        .map(|value| required(&value, "文章 ID", 200))
        .collect::<Result<Vec<_>, _>>()?;
    let revision_body = optional(
        request.revision_body,
        "事件修订正文",
        MAX_ARTICLE_BODY_BYTES,
    )?;
    let revision_json = json_text(request.revision_json, "事件修订详情")?;
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    if let Some(series_id) = &series_id {
        transaction
            .execute(
                "INSERT INTO intelligence_series(series_id,title,created_at,updated_at)
                 VALUES(?1,?1,?2,?2) ON CONFLICT(series_id) DO NOTHING",
                params![series_id, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    let current_revision = transaction
        .query_row(
            "SELECT current_revision FROM intelligence_events WHERE event_id=?1",
            [&event_id],
            |row| row.get::<_, u64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    let (current_revision_body, current_revision_json) = if current_revision == 0 {
        (None, None)
    } else {
        transaction
            .query_row(
                "SELECT body,revision_json FROM intelligence_event_revisions
                 WHERE event_id=?1 AND revision_no=?2",
                params![event_id, current_revision],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or((None, None))
    };
    let existing = {
        let mut statement = transaction
            .prepare(
                "SELECT article_id FROM intelligence_event_articles
                 WHERE event_id=?1 ORDER BY article_id",
            )
            .map_err(|error| error.to_string())?;
        let article_ids = statement
            .query_map([&event_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        article_ids
    };
    for article_id in existing {
        if !article_ids.contains(&article_id) {
            article_ids.push(article_id);
        }
    }
    // Membership/summary projection metadata is not a publishable editorial
    // revision. Only a non-empty, changed body can advance the readable cache.
    let creates_editorial_revision = revision_body.is_some()
        && (revision_body != current_revision_body || revision_json != current_revision_json);
    let new_revision = if creates_editorial_revision {
        current_revision + 1
    } else {
        current_revision
    };
    transaction
        .execute(
            "INSERT INTO intelligence_events(
                 event_id, series_id, title, summary, importance, occurred_at,
                 current_revision, created_at, updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)
             ON CONFLICT(event_id) DO UPDATE SET
                 series_id=excluded.series_id, title=excluded.title, summary=excluded.summary,
                 importance=excluded.importance, occurred_at=excluded.occurred_at,
                 current_revision=excluded.current_revision, updated_at=excluded.updated_at",
            params![
                event_id,
                series_id,
                title,
                summary,
                request.importance,
                occurred_at,
                new_revision,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    for article_id in &article_ids {
        transaction
            .execute(
                "INSERT OR IGNORE INTO intelligence_event_articles(event_id,article_id) VALUES(?1,?2)",
                params![event_id, article_id],
            )
            .map_err(|error| format!("保存事件来源失败：{error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM intelligence_series_events WHERE event_id=?1",
            [&event_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(series_id) = &series_id {
        transaction
            .execute(
                "INSERT INTO intelligence_series_events(series_id,event_id,position)
                 VALUES(?1,?2,?3)",
                params![series_id, event_id, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    if new_revision > current_revision {
        transaction
            .execute(
                "INSERT INTO intelligence_event_revisions(
                     event_id,revision_no,body,revision_json,created_at
                 ) VALUES(?1,?2,?3,?4,?5)",
                params![
                    event_id,
                    new_revision,
                    revision_body,
                    revision_json,
                    timestamp
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    let event_audit_detail = serde_json::to_string(&serde_json::json!({
        "eventId": event_id,
        "seriesId": series_id,
        "title": title,
        "importance": request.importance,
        "occurredAt": occurred_at,
        "sourceCount": article_ids.len(),
        "revision": new_revision,
        "revisionMeta": parse_json(revision_json.clone()),
    }))
    .map_err(|error| error.to_string())?;
    if creates_editorial_revision {
        audit_item(
            &transaction,
            "final-events",
            "events",
            &event_id,
            "ready",
            Some(&event_audit_detail),
            timestamp,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    event_projection(&connection, &event_id)?.ok_or("事件保存后无法读取".into())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreEventsByArticlesRequest {
    pub article_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEventByArticleProjection {
    pub article_id: String,
    pub event_id: String,
    pub series_id: Option<String>,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEventsByArticlesResult {
    pub projections: Vec<IntelligenceEventByArticleProjection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEventSourceEvidence {
    pub article_id: String,
    pub record_fingerprint: String,
    pub evidence_fingerprint: Option<String>,
    pub url: Option<String>,
    pub source_name: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub language: Option<String>,
    pub media_json: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEventSourcesPage {
    pub event_id: String,
    pub current_revision: u64,
    pub sources: Vec<IntelligenceEventSourceEvidence>,
    pub total: u64,
    pub next_cursor: Option<u32>,
}

fn event_sources_page_at(
    path: &Path,
    event_id: &str,
    cursor: Option<u32>,
    limit: Option<u32>,
) -> Result<IntelligenceEventSourcesPage, String> {
    let event_id = required(event_id, "事件 ID", 200)?;
    let offset = cursor.unwrap_or(0);
    let limit = limit.unwrap_or(32).clamp(1, 64);
    let connection = open_store_at(path)?;
    let current_revision = connection
        .query_row(
            "SELECT current_revision FROM intelligence_events WHERE event_id=?1",
            [&event_id],
            |row| row.get::<_, u64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("事件不存在")?;
    let total = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_event_articles WHERE event_id=?1",
            [&event_id],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT a.article_id,a.fingerprint,a.evidence_fingerprint,a.url,a.source_name,
                    a.title,a.summary,a.body,a.published_at,a.language,a.media_json
             FROM intelligence_event_articles ea
             JOIN intelligence_articles a ON a.article_id=ea.article_id
             WHERE ea.event_id=?1
             ORDER BY CASE WHEN a.published_at IS NULL THEN 1 ELSE 0 END,
                      a.published_at,a.article_id
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|error| error.to_string())?;
    let sources = statement
        .query_map(params![event_id, limit, offset], |row| {
            Ok(IntelligenceEventSourceEvidence {
                article_id: row.get(0)?,
                record_fingerprint: row.get(1)?,
                evidence_fingerprint: row.get(2)?,
                url: row.get(3)?,
                source_name: row.get(4)?,
                title: row.get(5)?,
                summary: row.get(6)?,
                body: row.get(7)?,
                published_at: row.get(8)?,
                language: row.get(9)?,
                media_json: parse_json(row.get(10)?),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let consumed = offset.saturating_add(sources.len() as u32);
    Ok(IntelligenceEventSourcesPage {
        event_id,
        current_revision,
        sources,
        total,
        next_cursor: (u64::from(consumed) < total).then_some(consumed),
    })
}

fn events_by_articles_at(
    path: &Path,
    request: IntelligenceStoreEventsByArticlesRequest,
) -> Result<IntelligenceEventsByArticlesResult, String> {
    if request.article_ids.is_empty() || request.article_ids.len() > MAX_QUERY_IDS {
        return Err(format!("查询文章数量必须在 1 到 {MAX_QUERY_IDS} 之间"));
    }
    let connection = open_store_at(path)?;
    let mut statement = connection
        .prepare(
            "SELECT ea.article_id,e.event_id,e.series_id,e.current_revision,e.title,e.summary,e.occurred_at
             FROM intelligence_event_articles ea
             JOIN intelligence_events e ON e.event_id=ea.event_id
             WHERE ea.article_id=?1 ORDER BY e.updated_at DESC LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut projections = Vec::new();
    for article_id in request.article_ids {
        let article_id = required(&article_id, "文章 ID", 200)?;
        let projection = statement
            .query_row([article_id], |row| {
                Ok(IntelligenceEventByArticleProjection {
                    article_id: row.get(0)?,
                    event_id: row.get(1)?,
                    series_id: row.get(2)?,
                    revision: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    occurred_at: row.get(6)?,
                })
            })
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(projection) = projection {
            projections.push(projection);
        }
    }
    Ok(IntelligenceEventsByArticlesResult { projections })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSeriesEventRelationInput {
    pub event_id: String,
    pub relative_to_event_id: Option<String>,
    pub relation: String,
    pub reason: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertSeriesRequest {
    pub series_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub event_ids: Vec<String>,
    #[serde(default)]
    pub event_relations: Vec<IntelligenceSeriesEventRelationInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSeriesProjection {
    pub series_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub event_ids: Vec<String>,
    pub updated_at: i64,
}

fn upsert_series_at(
    path: &Path,
    request: IntelligenceStoreUpsertSeriesRequest,
) -> Result<IntelligenceSeriesProjection, String> {
    let series_id = request
        .series_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("series:{}", uuid::Uuid::new_v4()));
    let series_id = required(&series_id, "系列 ID", 200)?;
    let title = required(&request.title, "系列标题", 2_000)?;
    let summary = optional(request.summary, "系列摘要", 128 * 1024)?;
    if request.event_ids.len() > MAX_QUERY_IDS {
        return Err(format!("系列事件不能超过 {MAX_QUERY_IDS} 条"));
    }
    let requested_event_ids = request
        .event_ids
        .into_iter()
        .map(|value| required(&value, "事件 ID", 200))
        .collect::<Result<Vec<_>, _>>()?;
    let requested_event_id_set = requested_event_ids.iter().cloned().collect::<HashSet<_>>();
    let mut event_relations =
        HashMap::<String, (Option<String>, String, Option<String>, Option<f64>)>::new();
    for relation in request.event_relations {
        let event_id = required(&relation.event_id, "关系事件 ID", 200)?;
        if !requested_event_id_set.contains(&event_id) {
            return Err("系列关系只能描述本次提交的事件".into());
        }
        let relative_to_event_id = optional(relation.relative_to_event_id, "关系参照事件 ID", 200)?;
        if relative_to_event_id.as_deref() == Some(event_id.as_str()) {
            return Err("系列事件不能以自身作为关系参照".into());
        }
        let relation_type = validate_relation(relation.relation.trim())?.to_string();
        let reason = optional(relation.reason, "系列关系理由", 8 * 1024)?;
        if relation
            .confidence
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err("系列关系置信度必须在 0 到 1 之间".into());
        }
        if event_relations
            .insert(
                event_id,
                (
                    relative_to_event_id,
                    relation_type,
                    reason,
                    relation.confidence,
                ),
            )
            .is_some()
        {
            return Err("同一系列事件不能重复提交关系".into());
        }
    }
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO intelligence_series(series_id,title,summary,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?4)
             ON CONFLICT(series_id) DO UPDATE SET
                 title=excluded.title, summary=excluded.summary, updated_at=excluded.updated_at",
            params![series_id, title, summary, timestamp],
        )
        .map_err(|error| error.to_string())?;
    let next_position = transaction
        .query_row(
            "SELECT COALESCE(MAX(position),-1)+1 FROM intelligence_series_events WHERE series_id=?1",
            [&series_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    for (position, event_id) in requested_event_ids.iter().enumerate() {
        let relation = event_relations.get(event_id);
        if let Some((Some(relative_to_event_id), _, _, _)) = relation {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM intelligence_events WHERE event_id=?1",
                    [relative_to_event_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some();
            if !exists {
                return Err("系列关系参照事件不存在".into());
            }
        }
        let (relative_to_event_id, relation_type, relation_reason, relation_confidence) = relation
            .map(
                |(relative_to_event_id, relation_type, reason, confidence)| {
                    (
                        relative_to_event_id.as_deref(),
                        Some(relation_type.as_str()),
                        reason.as_deref(),
                        *confidence,
                    )
                },
            )
            .unwrap_or((None, None, None, None));
        transaction
            .execute(
                "INSERT INTO intelligence_series_events(
                     series_id,event_id,position,relative_to_event_id,relation_type,
                     relation_reason,relation_confidence
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(series_id,event_id) DO UPDATE SET
                     relative_to_event_id=COALESCE(excluded.relative_to_event_id,relative_to_event_id),
                     relation_type=COALESCE(excluded.relation_type,relation_type),
                     relation_reason=COALESCE(excluded.relation_reason,relation_reason),
                     relation_confidence=COALESCE(excluded.relation_confidence,relation_confidence)",
                params![
                    series_id,
                    event_id,
                    next_position + position as i64,
                    relative_to_event_id,
                    relation_type,
                    relation_reason,
                    relation_confidence,
                ],
            )
            .map_err(|error| format!("保存系列事件失败：{error}"))?;
        transaction
            .execute(
                "UPDATE intelligence_events SET series_id=?1, updated_at=?3 WHERE event_id=?2",
                params![series_id, event_id, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    audit_item(
        &transaction,
        "series-timeline",
        "series",
        &series_id,
        "ready",
        None,
        timestamp,
    )?;
    let event_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT event_id FROM intelligence_series_events
                 WHERE series_id=?1 ORDER BY position,event_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&series_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligenceSeriesProjection {
        series_id,
        title,
        summary,
        event_ids,
        updated_at: timestamp,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreSeriesTimelineRequest {
    pub series_id: Option<String>,
    pub event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSeriesTimelineEvent {
    #[serde(flatten)]
    pub event: IntelligenceEventProjection,
    pub relative_to_event_id: Option<String>,
    pub relation: Option<String>,
    pub relation_label: Option<String>,
    pub relation_reason: Option<String>,
    pub relation_confidence: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSeriesTimeline {
    pub series_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub current_event_id: Option<String>,
    pub events: Vec<IntelligenceSeriesTimelineEvent>,
    pub background: Vec<IntelligenceSeriesTimelineEvent>,
    pub subsequent: Vec<IntelligenceSeriesTimelineEvent>,
}

fn timeline_relation_label(relation: &str) -> Option<String> {
    let label = match relation {
        "exact_duplicate" => "精确重复",
        "syndicated_copy" => "转载稿",
        "same_event" => "同一事件",
        "event_update" => "事件进展",
        "same_series" => "同一系列",
        "background" => "背景资料",
        "correction" => "更正",
        "unrelated" => "无关",
        _ => return None,
    };
    Some(label.into())
}

fn series_timeline_at(
    path: &Path,
    request: IntelligenceStoreSeriesTimelineRequest,
) -> Result<Option<IntelligenceSeriesTimeline>, String> {
    let connection = open_store_at(path)?;
    let requested_event_id = optional(request.event_id, "事件 ID", 200)?;
    let series_id = if let Some(series_id) = optional(request.series_id, "系列 ID", 200)? {
        Some(series_id)
    } else if let Some(event_id) = requested_event_id.as_deref() {
        connection
            .query_row(
                "SELECT series_id FROM intelligence_events WHERE event_id=?1",
                [event_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten()
    } else {
        return Err("需要 seriesId 或 eventId".into());
    };
    let Some(series_id) = series_id else {
        return Ok(None);
    };
    let series = connection
        .query_row(
            "SELECT title,summary FROM intelligence_series WHERE series_id=?1",
            [&series_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((title, summary)) = series else {
        return Ok(None);
    };
    let event_rows = {
        let mut statement = connection
            .prepare(
                "SELECT se.event_id,se.relative_to_event_id,se.relation_type,
                        se.relation_reason,se.relation_confidence
                 FROM intelligence_series_events se
                  JOIN intelligence_events e ON e.event_id=se.event_id
                  WHERE se.series_id=?1
                  ORDER BY CASE WHEN e.occurred_at IS NULL THEN 1 ELSE 0 END,
                          e.occurred_at, se.position, e.created_at",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&series_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut events = Vec::with_capacity(event_rows.len());
    for (event_id, relative_to_event_id, relation, relation_reason, relation_confidence) in
        event_rows
    {
        if let Some(event) = event_projection(&connection, &event_id)? {
            let relation_label = relation.as_deref().and_then(timeline_relation_label);
            events.push(IntelligenceSeriesTimelineEvent {
                event,
                relative_to_event_id,
                relation,
                relation_label,
                relation_reason,
                relation_confidence,
            });
        }
    }
    let current_event_id = requested_event_id
        .filter(|requested| {
            events
                .iter()
                .any(|event| event.event.event_id == *requested)
        })
        .or_else(|| events.last().map(|event| event.event.event_id.clone()));
    let current_index = current_event_id.as_ref().and_then(|current| {
        events
            .iter()
            .position(|event| event.event.event_id == *current)
    });
    // `events` is already ordered chronologically by the persisted series
    // query. Only the strict prefix may be called background; the suffix is
    // returned separately as later progress and can never leak into 前情提要.
    let background = current_index
        .map(|index| events[..index].to_vec())
        .unwrap_or_default();
    let subsequent = current_index
        .map(|index| events[index.saturating_add(1)..].to_vec())
        .unwrap_or_default();
    Ok(Some(IntelligenceSeriesTimeline {
        series_id,
        title,
        summary,
        current_event_id,
        events,
        background,
        subsequent,
    }))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceQualityReviewInput {
    pub target_kind: String,
    pub target_id: String,
    #[serde(default)]
    pub sampled: bool,
    pub verdict: String,
    pub confidence: Option<f64>,
    pub model_id: String,
    pub detail_json: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreRecordReviewsRequest {
    pub reviews: Vec<IntelligenceQualityReviewInput>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceReviewKindSummary {
    pub target_kind: String,
    pub sampled: u64,
    pub correct: u64,
    pub incorrect: u64,
    pub uncertain: u64,
    pub accuracy: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceReviewGateSummary {
    pub sampled: u64,
    pub correct: u64,
    pub incorrect: u64,
    pub uncertain: u64,
    pub accuracy: Option<f64>,
    pub minimum_samples: u64,
    /// 7B/8B relation decisions that were independently checked by the 27B
    /// reviewer in the current qualification epoch.
    pub relation_accuracy_samples: u64,
    pub relation_accuracy: Option<f64>,
    pub full_relation_review_target: u64,
    pub full_relation_reviews_remaining: u64,
    pub important_recall_samples: u64,
    pub important_recall: Option<f64>,
    pub important_recall_threshold: f64,
    pub merge_precision_samples: u64,
    pub merge_precision: Option<f64>,
    pub false_merge_samples: u64,
    pub false_merge_rate: Option<f64>,
    pub false_merge_errors: u64,
    pub json_compliance_samples: u64,
    pub json_compliance: Option<f64>,
    pub review_mode: String,
    pub review_epoch: u64,
    pub stable_relation_batches: u64,
    pub required_stable_relation_batches: u64,
    pub mandatory_random_sample_rate: f64,
    pub fallback_accuracy_threshold: f64,
    pub last_transition_reason: String,
    pub by_target_kind: Vec<IntelligenceReviewKindSummary>,
    pub eligible_for_reduced_review: bool,
}

const FULL_RELATION_REVIEW_TARGET: u64 = 500;
const MINIMUM_IMPORTANT_RECALL_SAMPLES: u64 = 50;
const MINIMUM_MERGE_PRECISION_SAMPLES: u64 = 50;
const MINIMUM_FALSE_MERGE_SAMPLES: u64 = 50;
const MINIMUM_JSON_COMPLIANCE_SAMPLES: u64 = 50;
const REQUIRED_STABLE_RELATION_BATCHES: u64 = 3;
const QUALITY_ACCURACY_THRESHOLD: f64 = 0.97;
const QUALITY_FALLBACK_ACCURACY_THRESHOLD: f64 = 0.95;
const MANDATORY_RANDOM_RELATION_SAMPLE_RATE: f64 = 0.10;

#[derive(Clone, Debug)]
struct IntelligenceQualityGateState {
    review_mode: String,
    review_epoch: u64,
    stable_relation_batches: u64,
    last_transition_reason: String,
}

fn quality_gate_state(connection: &Connection) -> Result<IntelligenceQualityGateState, String> {
    connection
        .query_row(
            "SELECT review_mode,review_epoch,stable_relation_batches,last_transition_reason
             FROM intelligence_quality_gate_state WHERE singleton=1",
            [],
            |row| {
                Ok(IntelligenceQualityGateState {
                    review_mode: row.get(0)?,
                    review_epoch: row.get(1)?,
                    stable_relation_batches: row.get(2)?,
                    last_transition_reason: row.get(3)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn save_quality_gate_state(
    connection: &Connection,
    state: &IntelligenceQualityGateState,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE intelligence_quality_gate_state SET
                 review_mode=?1,review_epoch=?2,stable_relation_batches=?3,
                 last_transition_reason=?4,last_transition_at=?5
             WHERE singleton=1",
            params![
                state.review_mode,
                state.review_epoch,
                state.stable_relation_batches,
                state.last_transition_reason,
                now_ms(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn review_gate(connection: &Connection) -> Result<IntelligenceReviewGateSummary, String> {
    const POSITIVE: &str = "'correct','pass','accepted','compliant','no_false_merge'";
    const NEGATIVE: &str = "'incorrect','fail','rejected','noncompliant','false_merge'";
    let gate_state = quality_gate_state(connection)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT target_kind,
                 COALESCE(SUM(CASE WHEN sampled=1 THEN 1 ELSE 0 END),0),
                 COALESCE(SUM(CASE WHEN sampled=1 AND verdict IN ({POSITIVE}) THEN 1 ELSE 0 END),0),
                 COALESCE(SUM(CASE WHEN sampled=1 AND verdict IN ({NEGATIVE}) THEN 1 ELSE 0 END),0),
                 COALESCE(SUM(CASE WHEN sampled=1 AND verdict NOT IN ({POSITIVE},{NEGATIVE}) THEN 1 ELSE 0 END),0)
             FROM intelligence_quality_reviews
             WHERE review_epoch = ?1
             GROUP BY target_kind ORDER BY target_kind"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([gate_state.review_epoch], |row| {
            let sampled = row.get::<_, u64>(1)?;
            let correct = row.get::<_, u64>(2)?;
            let incorrect = row.get::<_, u64>(3)?;
            let decided = correct + incorrect;
            Ok(IntelligenceReviewKindSummary {
                target_kind: row.get(0)?,
                sampled,
                correct,
                incorrect,
                uncertain: row.get(4)?,
                accuracy: (decided > 0).then_some(correct as f64 / decided as f64),
            })
        })
        .map_err(|error| error.to_string())?;
    let by_target_kind = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    // Editorial/final-writing reviews are deliberately excluded: fluent copy
    // is not evidence that the triage and merge classifiers are accurate.
    let gate_kinds = by_target_kind.iter().filter(|summary| {
        !matches!(
            summary.target_kind.as_str(),
            "events" | "series" | "writing" | "editorial"
        )
    });
    let (sampled, correct, incorrect, uncertain) =
        gate_kinds.fold((0_u64, 0_u64, 0_u64, 0_u64), |acc, summary| {
            (
                acc.0 + summary.sampled,
                acc.1 + summary.correct,
                acc.2 + summary.incorrect,
                acc.3 + summary.uncertain,
            )
        });
    let decided = correct + incorrect;
    let accuracy = (decided > 0).then_some(correct as f64 / decided as f64);
    let metric = |kinds: &[&str]| {
        let (right, wrong) = by_target_kind
            .iter()
            .filter(|summary| kinds.contains(&summary.target_kind.as_str()))
            .fold((0_u64, 0_u64), |acc, summary| {
                (acc.0 + summary.correct, acc.1 + summary.incorrect)
            });
        let samples = right + wrong;
        (
            samples,
            (samples > 0).then_some(right as f64 / samples as f64),
        )
    };
    let (important_recall_samples, important_recall) =
        metric(&["important_recall", "article_importance"]);
    let (relation_accuracy_samples, relation_accuracy) = metric(&["relation_accuracy"]);
    let (merge_precision_samples, merge_precision) = metric(&["merge_precision"]);
    let (false_merge_samples, no_false_merge_rate) = metric(&["false_merge"]);
    let false_merge_rate = no_false_merge_rate.map(|value| 1.0 - value);
    let false_merge_errors = by_target_kind
        .iter()
        .find(|summary| summary.target_kind == "false_merge")
        .map_or(0, |summary| summary.incorrect);
    let (json_compliance_samples, json_compliance) = metric(&["json_compliance"]);
    // Qualification is deliberately stricter than the fallback trigger.  In
    // particular, a single false merge can never be averaged away.
    let meets_quality_thresholds = sampled >= FULL_RELATION_REVIEW_TARGET
        && relation_accuracy_samples >= FULL_RELATION_REVIEW_TARGET
        && accuracy.is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && relation_accuracy.is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && important_recall_samples >= MINIMUM_IMPORTANT_RECALL_SAMPLES
        && important_recall.is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && merge_precision_samples >= MINIMUM_MERGE_PRECISION_SAMPLES
        && merge_precision.is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && false_merge_samples >= MINIMUM_FALSE_MERGE_SAMPLES
        && false_merge_errors == 0
        && json_compliance_samples >= MINIMUM_JSON_COMPLIANCE_SAMPLES
        && json_compliance.is_some_and(|value| value >= 1.0);
    Ok(IntelligenceReviewGateSummary {
        sampled,
        correct,
        incorrect,
        uncertain,
        accuracy,
        minimum_samples: FULL_RELATION_REVIEW_TARGET,
        relation_accuracy_samples,
        relation_accuracy,
        full_relation_review_target: FULL_RELATION_REVIEW_TARGET,
        full_relation_reviews_remaining: FULL_RELATION_REVIEW_TARGET
            .saturating_sub(relation_accuracy_samples),
        important_recall_samples,
        important_recall,
        important_recall_threshold: QUALITY_ACCURACY_THRESHOLD,
        merge_precision_samples,
        merge_precision,
        false_merge_samples,
        false_merge_rate,
        false_merge_errors,
        json_compliance_samples,
        json_compliance,
        review_mode: gate_state.review_mode.clone(),
        review_epoch: gate_state.review_epoch,
        stable_relation_batches: gate_state.stable_relation_batches,
        required_stable_relation_batches: REQUIRED_STABLE_RELATION_BATCHES,
        mandatory_random_sample_rate: MANDATORY_RANDOM_RELATION_SAMPLE_RATE,
        fallback_accuracy_threshold: QUALITY_FALLBACK_ACCURACY_THRESHOLD,
        last_transition_reason: gate_state.last_transition_reason,
        by_target_kind,
        eligible_for_reduced_review: gate_state.review_mode == "sample"
            && meets_quality_thresholds
            && gate_state.stable_relation_batches >= REQUIRED_STABLE_RELATION_BATCHES,
    })
}

fn quality_gate_meets_thresholds(summary: &IntelligenceReviewGateSummary) -> bool {
    summary.sampled >= FULL_RELATION_REVIEW_TARGET
        && summary.relation_accuracy_samples >= FULL_RELATION_REVIEW_TARGET
        && summary
            .accuracy
            .is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && summary
            .relation_accuracy
            .is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && summary.important_recall_samples >= MINIMUM_IMPORTANT_RECALL_SAMPLES
        && summary
            .important_recall
            .is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && summary.merge_precision_samples >= MINIMUM_MERGE_PRECISION_SAMPLES
        && summary
            .merge_precision
            .is_some_and(|value| value >= QUALITY_ACCURACY_THRESHOLD)
        && summary.false_merge_samples >= MINIMUM_FALSE_MERGE_SAMPLES
        && summary.false_merge_errors == 0
        && summary.json_compliance_samples >= MINIMUM_JSON_COMPLIANCE_SAMPLES
        && summary.json_compliance.is_some_and(|value| value >= 1.0)
}

fn quality_gate_fallback_reason(summary: &IntelligenceReviewGateSummary) -> Option<&'static str> {
    if summary.false_merge_errors > 0 {
        return Some("false_merge_detected");
    }
    let below_fallback =
        |value: Option<f64>| value.is_some_and(|value| value < QUALITY_FALLBACK_ACCURACY_THRESHOLD);
    if below_fallback(summary.accuracy) {
        Some("overall_accuracy_below_95")
    } else if below_fallback(summary.relation_accuracy) {
        Some("relation_accuracy_below_95")
    } else if below_fallback(summary.important_recall) {
        Some("important_recall_below_95")
    } else if below_fallback(summary.merge_precision) {
        Some("merge_precision_below_95")
    } else {
        None
    }
}

fn advance_quality_gate(
    connection: &Connection,
    relation_reviews_in_batch: u64,
) -> Result<IntelligenceReviewGateSummary, String> {
    let mut state = quality_gate_state(connection)?;
    let summary = review_gate(connection)?;
    // Any confirmed false merge is a hard latch.  Start a fresh qualification
    // epoch so a later clean 500-pair run is required before sampling resumes.
    // Low accuracy only resets an already-sampled gate; initial calibration is
    // expected to contain failures and remains visibly in full-review mode.
    let fallback_reason = quality_gate_fallback_reason(&summary);
    if fallback_reason.is_some_and(|_| summary.false_merge_errors > 0)
        || (state.review_mode == "sample" && fallback_reason.is_some())
    {
        state.review_mode = "full".into();
        state.review_epoch = state.review_epoch.saturating_add(1);
        state.stable_relation_batches = 0;
        state.last_transition_reason = fallback_reason.unwrap_or("quality_fallback").into();
        save_quality_gate_state(connection, &state)?;
        return review_gate(connection);
    }

    if relation_reviews_in_batch > 0 {
        if quality_gate_meets_thresholds(&summary) {
            state.stable_relation_batches = state.stable_relation_batches.saturating_add(1);
        } else if state.review_mode == "full" {
            state.stable_relation_batches = 0;
        }
    }
    if state.review_mode == "full"
        && quality_gate_meets_thresholds(&summary)
        && state.stable_relation_batches >= REQUIRED_STABLE_RELATION_BATCHES
    {
        state.review_mode = "sample".into();
        state.last_transition_reason = "qualified_500_relations_97pct_stable".into();
    }
    save_quality_gate_state(connection, &state)?;
    review_gate(connection)
}

fn record_reviews_at(
    path: &Path,
    request: IntelligenceStoreRecordReviewsRequest,
) -> Result<IntelligenceReviewGateSummary, String> {
    if request.reviews.is_empty() || request.reviews.len() > MAX_REVIEWS_PER_BATCH {
        return Err(format!(
            "每批复核数量必须在 1 到 {MAX_REVIEWS_PER_BATCH} 之间"
        ));
    }
    let mut connection = open_store_at(path)?;
    let gate_state = quality_gate_state(&connection)?;
    let relation_reviews_in_batch = request
        .reviews
        .iter()
        .filter(|review| review.sampled && review.target_kind.trim() == "relation_accuracy")
        .count() as u64;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    for review in request.reviews {
        let target_kind = required(&review.target_kind, "复核对象类型", 40)?;
        if !matches!(
            target_kind.as_str(),
            "articles"
                | "pairs"
                | "events"
                | "series"
                | "important_recall"
                | "article_importance"
                | "relation_accuracy"
                | "merge_precision"
                | "false_merge"
                | "json_compliance"
                | "writing"
                | "editorial"
        ) {
            return Err("未知的复核对象类型".into());
        }
        let target_id = required(&review.target_id, "复核对象 ID", 500)?;
        let verdict = required(&review.verdict, "复核结论", 80)?;
        let model_id = required(&review.model_id, "复核模型标识", 300)?;
        if review.confidence.is_some_and(|value| !value.is_finite()) {
            return Err("复核置信度必须是有限数值".into());
        }
        let detail_json = json_text(review.detail_json, "复核详情")?;
        transaction
            .execute(
                "INSERT INTO intelligence_quality_reviews(
                     target_kind,target_id,sampled,verdict,confidence,model_id,detail_json,reviewed_at
                     ,review_epoch
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(target_kind,target_id,model_id) DO UPDATE SET
                     sampled=excluded.sampled,verdict=excluded.verdict,
                     confidence=excluded.confidence,detail_json=excluded.detail_json,
                     reviewed_at=excluded.reviewed_at,review_epoch=excluded.review_epoch",
                params![
                    target_kind,
                    target_id,
                    i64::from(review.sampled),
                    verdict,
                    review.confidence,
                    model_id,
                    detail_json,
                    timestamp,
                    gate_state.review_epoch,
                ],
            )
            .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "qwen-review",
            &target_kind,
            &target_id,
            &verdict,
            detail_json.as_deref(),
            timestamp,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    advance_quality_gate(&connection, relation_reviews_in_batch)
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceQueueStatus {
    pub queued: u64,
    pub processing: u64,
    pub kept: u64,
    pub filtered: u64,
    pub failed: u64,
    pub total: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSaveRetrievalProfileRequest {
    pub embedding_model: String,
    pub dimension: u32,
    pub instruction: String,
    pub revision: String,
    pub calibration_embedding_model: Option<String>,
    pub calibration_dimension: Option<u32>,
    pub calibration_revision: Option<String>,
    pub calibration_status: Option<String>,
    pub calibrated_pairs: Option<u64>,
    pub reranker_model: Option<String>,
    pub reranker_revision: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceRetrievalProfile {
    pub embedding_model: String,
    pub dimension: u32,
    pub instruction: String,
    pub revision: String,
    pub calibration_embedding_model: Option<String>,
    pub calibration_dimension: Option<u32>,
    pub calibration_revision: Option<String>,
    pub calibration_status: String,
    pub calibrated_pairs: u64,
    pub reranker_model: Option<String>,
    pub reranker_revision: Option<String>,
    pub mode: String,
    pub degraded: bool,
    pub updated_at: i64,
}

fn retrieval_profile_from_connection(
    connection: &Connection,
) -> Result<Option<IntelligenceRetrievalProfile>, String> {
    connection
        .query_row(
            "SELECT embedding_model,dimension,instruction,revision,
                    calibration_embedding_model,calibration_dimension,calibration_revision,
                    calibration_status,calibrated_pairs,
                    reranker_model,reranker_revision,mode,degraded,updated_at
             FROM intelligence_retrieval_profile WHERE profile_id=1",
            [],
            |row| {
                Ok(IntelligenceRetrievalProfile {
                    embedding_model: row.get(0)?,
                    dimension: row.get(1)?,
                    instruction: row.get(2)?,
                    revision: row.get(3)?,
                    calibration_embedding_model: row.get(4)?,
                    calibration_dimension: row.get(5)?,
                    calibration_revision: row.get(6)?,
                    calibration_status: row.get(7)?,
                    calibrated_pairs: row.get(8)?,
                    reranker_model: row.get(9)?,
                    reranker_revision: row.get(10)?,
                    mode: row.get(11)?,
                    degraded: row.get::<_, i64>(12)? != 0,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn save_retrieval_profile_at(
    path: &Path,
    request: IntelligenceSaveRetrievalProfileRequest,
) -> Result<IntelligenceRetrievalProfile, String> {
    let embedding_model = required(&request.embedding_model, "向量模型", 300)?;
    if request.dimension == 0 || request.dimension > 8_192 {
        return Err("主向量模型维数必须在 1–8192 之间".into());
    }
    let instruction = required_or_empty(&request.instruction, "向量指令", 2_000)?;
    let revision = required(&request.revision, "向量模型修订", 200)?;
    let calibration_embedding_model =
        optional(request.calibration_embedding_model, "校准向量模型", 300)?;
    if request
        .calibration_dimension
        .is_some_and(|value| value == 0 || value > 8_192)
    {
        return Err("校准向量模型维数必须在 1–8192 之间".into());
    }
    if calibration_embedding_model.is_some() != request.calibration_dimension.is_some() {
        return Err("校准向量模型及其维数必须同时提供".into());
    }
    let calibration_revision = optional(request.calibration_revision, "校准模型修订", 200)?;
    let calibration_status = optional(request.calibration_status, "校准状态", 80)?
        .unwrap_or_else(|| "not_configured".into());
    if !matches!(
        calibration_status.as_str(),
        "not_configured" | "not_needed" | "applied" | "unavailable"
    ) {
        return Err("未知的校准状态".into());
    }
    let calibrated_pairs = request.calibrated_pairs.unwrap_or(0);
    let reranker_model = optional(request.reranker_model, "重排模型", 300)?;
    let reranker_revision = optional(request.reranker_revision, "重排模型修订", 200)?;
    if reranker_model.is_some() != reranker_revision.is_some() {
        return Err("重排模型及其修订必须同时提供".into());
    }
    let mode = required(&request.mode, "检索模式", 80)?;
    let connection = open_store_at(path)?;
    let timestamp = now_ms();
    connection
        .execute(
            "INSERT INTO intelligence_retrieval_profile(
                 profile_id,embedding_model,dimension,instruction,revision,
                 calibration_embedding_model,calibration_dimension,calibration_revision,
                 calibration_status,calibrated_pairs,
                 reranker_model,reranker_revision,mode,degraded,updated_at
             ) VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(profile_id) DO UPDATE SET
                 embedding_model=excluded.embedding_model,dimension=excluded.dimension,
                 instruction=excluded.instruction,revision=excluded.revision,
                 calibration_embedding_model=excluded.calibration_embedding_model,
                  calibration_dimension=excluded.calibration_dimension,
                  calibration_revision=excluded.calibration_revision,
                  calibration_status=excluded.calibration_status,
                  calibrated_pairs=excluded.calibrated_pairs,
                 reranker_model=excluded.reranker_model,
                 reranker_revision=excluded.reranker_revision,
                 mode=excluded.mode,degraded=excluded.degraded,updated_at=excluded.updated_at",
            params![
                embedding_model,
                request.dimension,
                instruction,
                revision,
                calibration_embedding_model,
                request.calibration_dimension,
                calibration_revision,
                calibration_status,
                calibrated_pairs,
                reranker_model,
                reranker_revision,
                mode,
                i64::from(request.degraded),
                timestamp,
            ],
        )
        .map_err(|error| format!("保存情报检索配置失败：{error}"))?;
    retrieval_profile_from_connection(&connection)?.ok_or("保存后无法读取检索配置".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceAuditStageSummary {
    pub id: String,
    /// Compatibility status consumed by the existing audit UI.
    pub status: String,
    /// Durable lifecycle state; absent means this run never entered the stage.
    pub checkpoint_status: Option<String>,
    pub articles: u64,
    pub pairs: u64,
    pub events: u64,
    pub series: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreSnapshot {
    pub database_version: u64,
    pub run_id: String,
    pub active_run_id: String,
    pub run_status: String,
    pub retrieval_mode: String,
    pub retrieval_degraded: bool,
    pub retrieval_index_type: String,
    pub indexed_vectors: u64,
    pub retrieval_profile: Option<IntelligenceRetrievalProfile>,
    pub stages: Vec<IntelligenceAuditStageSummary>,
    pub queue: IntelligenceQueueStatus,
    pub review_gate: IntelligenceReviewGateSummary,
}

#[cfg(test)]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntelligenceWorkerQueueStatus {
    archive_present: bool,
    queued: u64,
    processing: u64,
    remaining: u64,
}

#[cfg(test)]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntelligenceWorkerClaimResult {
    archive_present: bool,
    claimed: u64,
    remaining: u64,
}

fn queue_status(connection: &Connection) -> Result<IntelligenceQueueStatus, String> {
    let mut status = IntelligenceQueueStatus::default();
    let mut statement = connection
        .prepare("SELECT triage_state,COUNT(*) FROM intelligence_articles GROUP BY triage_state")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (state, count) = row.map_err(|error| error.to_string())?;
        match state.as_str() {
            "queued" => status.queued = count,
            "processing" => status.processing = count,
            "keep" => status.kept = count,
            "filter" => status.filtered = count,
            "failed" => status.failed = count,
            _ => {}
        }
    }
    status.total =
        status.queued + status.processing + status.kept + status.filtered + status.failed;
    Ok(status)
}

#[cfg(test)]
fn worker_queue_status_at(path: &Path) -> Result<IntelligenceWorkerQueueStatus, String> {
    if !path.is_file() {
        return Ok(IntelligenceWorkerQueueStatus::default());
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    let queue = queue_status(&connection)?;
    Ok(IntelligenceWorkerQueueStatus {
        archive_present: true,
        queued: queue.queued,
        processing: queue.processing,
        remaining: queue.queued,
    })
}

#[cfg(test)]
fn worker_claim_one_at(
    path: &Path,
    lease_owner: &str,
) -> Result<IntelligenceWorkerClaimResult, String> {
    if !path.is_file() {
        return Ok(IntelligenceWorkerClaimResult::default());
    }
    let result = claim_triage_at(
        path,
        IntelligenceStoreClaimTriageRequest {
            limit: Some(1),
            lease_owner: Some(lease_owner.to_string()),
            lease_seconds: Some(30),
        },
    )?;
    Ok(IntelligenceWorkerClaimResult {
        archive_present: true,
        claimed: result.articles.len() as u64,
        remaining: result.remaining,
    })
}

fn snapshot_at(path: &Path) -> Result<IntelligenceStoreSnapshot, String> {
    let connection = open_store_at(path)?;
    let active_run_id = pipeline_run_id();
    let queue = queue_status(&connection)?;
    let run_status = connection
        .query_row(
            "SELECT status FROM intelligence_pipeline_runs WHERE run_id=?1",
            [&active_run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| "running".into());
    let vector_count = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_news_vectors",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    let mut counts = BTreeMap::<(String, String), u64>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT stage,unit_kind,COUNT(*) FROM intelligence_audit_items
                 WHERE run_id=?1 GROUP BY stage,unit_kind",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&active_run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (stage, unit, count) = row.map_err(|error| error.to_string())?;
            counts.insert((stage, unit), count);
        }
    }
    let mut checkpoint_statuses = HashMap::<String, String>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT stage,status FROM intelligence_pipeline_stage_checkpoints
                 WHERE run_id=?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&active_run_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (stage, status) = row.map_err(|error| error.to_string())?;
            checkpoint_statuses.insert(stage, status);
        }
    }
    let stages = AUDIT_STAGES
        .iter()
        .map(|stage| {
            let count = |unit: &str| {
                counts
                    .get(&(stage.to_string(), unit.to_string()))
                    .copied()
                    .unwrap_or(0)
            };
            let articles = count("articles");
            let pairs = count("pairs");
            let events = count("events");
            let series = count("series");
            let checkpoint_status = checkpoint_statuses.get(*stage).cloned();
            let status = match checkpoint_status.as_deref() {
                Some("started") => "running",
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("cancelled") => "warning",
                _ => "pending",
            };
            IntelligenceAuditStageSummary {
                id: stage.to_string(),
                status: status.to_string(),
                checkpoint_status,
                articles,
                pairs,
                events,
                series,
            }
        })
        .collect();
    let retrieval_profile = retrieval_profile_from_connection(&connection)?;
    let (retrieval_mode, retrieval_degraded) = match (&retrieval_profile, vector_count) {
        (Some(profile), count) if count > 0 => (profile.mode.clone(), profile.degraded),
        (Some(_), _) => ("sparse_only".into(), true),
        (None, count) if count > 0 => ("dense_sparse".into(), true),
        (None, _) => ("sparse_only".into(), true),
    };
    Ok(IntelligenceStoreSnapshot {
        database_version: STORE_VERSION as u64,
        run_id: active_run_id.clone(),
        active_run_id,
        run_status,
        // Never claim the configured hybrid/rerank mode until at least one
        // model-versioned dense vector is present. FTS5 is the conservative
        // local fallback and an absent reranker remains explicitly degraded.
        retrieval_mode,
        retrieval_degraded,
        retrieval_index_type: if vector_count > 0 {
            "instant-distance-hnsw-memory/sqlite-vectors".into()
        } else {
            "fts5-sparse-only".into()
        },
        indexed_vectors: vector_count,
        retrieval_profile,
        stages,
        queue,
        review_gate: review_gate(&connection)?,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRunProjection {
    pub run_id: String,
    pub status: String,
    pub started_at: i64,
    pub updated_at: i64,
}

fn start_pipeline_run_at(
    path: &Path,
    requested_run_id: Option<String>,
) -> Result<IntelligencePipelineRunProjection, String> {
    let run_id = match requested_run_id {
        Some(run_id) => required(&run_id, "情报批次", 200)?,
        None => format!("run-{}", uuid::Uuid::new_v4()),
    };
    set_pipeline_run_id(run_id.clone())?;
    let mut connection = open_store_at(path)?;
    let timestamp = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO intelligence_pipeline_runs(run_id,status,started_at,updated_at)
             VALUES(?1,'running',?2,?2)
             ON CONFLICT(run_id) DO UPDATE SET status='running',updated_at=excluded.updated_at",
            params![run_id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    mark_stage_started(&transaction, &run_id, "collected", timestamp)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligencePipelineRunProjection {
        run_id,
        status: "running".into(),
        started_at: timestamp,
        updated_at: timestamp,
    })
}

fn finish_pipeline_run_at(
    path: &Path,
    requested_run_id: Option<String>,
    requested_status: Option<String>,
) -> Result<IntelligencePipelineRunProjection, String> {
    let run_id = optional(requested_run_id, "情报批次", 200)?.unwrap_or_else(pipeline_run_id);
    let status = optional(requested_status, "批次状态", 40)?.unwrap_or_else(|| "completed".into());
    if !matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        return Err("结束批次状态必须是 completed、failed 或 cancelled".into());
    }
    let mut connection = open_store_at(path)?;
    let timestamp = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE intelligence_pipeline_runs SET status=?2,updated_at=?3 WHERE run_id=?1",
            params![run_id, status, timestamp],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("情报批次不存在".into());
    }
    finish_stage_checkpoints(&transaction, &run_id, &status, timestamp)?;
    let started_at = transaction
        .query_row(
            "SELECT started_at FROM intelligence_pipeline_runs WHERE run_id=?1",
            [&run_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(IntelligencePipelineRunProjection {
        run_id,
        status,
        started_at,
        updated_at: timestamp,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreAuditPageRequest {
    pub run_id: Option<String>,
    pub stage: String,
    pub cursor: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceAuditItem {
    pub id: i64,
    pub title: String,
    pub meta: String,
    pub stage: String,
    pub unit_kind: String,
    pub item_id: String,
    pub status: String,
    pub detail_json: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreAuditPage {
    pub items: Vec<IntelligenceAuditItem>,
    pub next_cursor: Option<i64>,
    pub total: u64,
}

fn audit_display_strings(
    unit_kind: &str,
    item_id: &str,
    detail: Option<&Value>,
) -> (String, String) {
    let text = |key: &str| {
        detail
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    };
    let title = text("title")
        .or_else(|| text("eventTitle"))
        .or_else(|| text("newArticleTitle"))
        .map(str::to_string)
        .or_else(|| match (text("leftTitle"), text("rightTitle")) {
            (Some(left), Some(right)) => Some(format!("{left} ↔ {right}")),
            _ => None,
        })
        .unwrap_or_else(|| item_id.to_string());
    let mut meta = Vec::new();
    if let Some(model) = text("model") {
        meta.push(model.to_string());
    }
    if let Some(relation) = text("relation") {
        meta.push(relation.to_string());
    }
    for key in ["importance", "confidence", "score", "sourceCount"] {
        if let Some(value) = detail.and_then(|value| value.get(key)) {
            if !value.is_null() {
                meta.push(format!("{key}={value}"));
            }
        }
    }
    if let Some(reason) = text("reason") {
        meta.push(reason.chars().take(180).collect());
    }
    if meta.is_empty() {
        meta.push(unit_kind.to_string());
    }
    (title.chars().take(300).collect(), meta.join(" · "))
}

fn audit_page_at(
    path: &Path,
    request: IntelligenceStoreAuditPageRequest,
) -> Result<IntelligenceStoreAuditPage, String> {
    let stage = validate_stage(request.stage.trim())?;
    let run_id =
        optional(request.run_id, "审计批次", 200)?.unwrap_or_else(|| pipeline_run_id().to_string());
    let limit = request.limit.unwrap_or(40).clamp(1, MAX_AUDIT_PAGE) as usize;
    let connection = open_store_at(path)?;
    let total = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_audit_items WHERE run_id=?1 AND stage=?2",
            params![run_id, stage],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,stage,unit_kind,item_id,status,detail_json,created_at,updated_at
             FROM intelligence_audit_items
             WHERE run_id=?1 AND stage=?2
             ORDER BY id DESC LIMIT ?4 OFFSET ?3",
        )
        .map_err(|error| error.to_string())?;
    let offset = request.cursor.unwrap_or(0).max(0);
    let rows = statement
        .query_map(params![run_id, stage, offset, (limit + 1) as i64], |row| {
            let unit_kind = row.get::<_, String>(2)?;
            let item_id = row.get::<_, String>(3)?;
            let detail_json = parse_json(row.get(5)?);
            let (title, meta) = audit_display_strings(&unit_kind, &item_id, detail_json.as_ref());
            Ok(IntelligenceAuditItem {
                id: row.get(0)?,
                title,
                meta,
                stage: row.get(1)?,
                unit_kind,
                item_id,
                status: row.get(4)?,
                detail_json,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = has_more.then_some(offset + limit as i64);
    Ok(IntelligenceStoreAuditPage {
        items,
        next_cursor,
        total,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceEmbeddingInput {
    pub article_id: String,
    pub fingerprint: String,
    pub embedding_model: String,
    pub dimension: u32,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub revision: String,
    pub vector: Vec<f32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreUpsertEmbeddingsRequest {
    pub embeddings: Vec<IntelligenceEmbeddingInput>,
}

fn encode_vector(vector: &[f32]) -> Result<Vec<u8>, String> {
    if vector.is_empty() || vector.len() > 8_192 || vector.iter().any(|value| !value.is_finite()) {
        return Err("情报向量必须包含 1–8192 个有限数值".into());
    }
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(bytes)
}

fn decode_vector(bytes: &[u8], dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension.checked_mul(4)? {
        return None;
    }
    Some(
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect(),
    )
}

#[derive(Clone, Serialize, Deserialize)]
struct IntelligenceAnnPoint(Vec<f32>);

impl instant_distance::Point for IntelligenceAnnPoint {
    fn distance(&self, other: &Self) -> f32 {
        1.0 - self
            .0
            .iter()
            .zip(&other.0)
            .map(|(left, right)| left * right)
            .sum::<f32>()
    }
}

type IntelligenceAnnGraph = instant_distance::HnswMap<IntelligenceAnnPoint, u32>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct IntelligenceAnnKey {
    path: PathBuf,
    model: String,
    dimension: u32,
    instruction: String,
    revision: String,
    count: u64,
    max_updated_at: i64,
    bytes: u64,
}

struct IntelligenceAnnCache {
    key: IntelligenceAnnKey,
    graph: IntelligenceAnnGraph,
    article_ids: Vec<String>,
}

static INTELLIGENCE_ANN_CACHE: OnceLock<Mutex<Option<IntelligenceAnnCache>>> = OnceLock::new();

static INTELLIGENCE_PIPELINE_RUN_ID: OnceLock<Mutex<String>> = OnceLock::new();

fn pipeline_run_id() -> String {
    INTELLIGENCE_PIPELINE_RUN_ID
        .get_or_init(|| Mutex::new(format!("run-{}", uuid::Uuid::new_v4())))
        .lock()
        .map(|run_id| run_id.clone())
        .unwrap_or_else(|_| format!("run-{}", uuid::Uuid::new_v4()))
}

fn set_pipeline_run_id(run_id: String) -> Result<(), String> {
    let mut active = INTELLIGENCE_PIPELINE_RUN_ID
        .get_or_init(|| Mutex::new(format!("run-{}", uuid::Uuid::new_v4())))
        .lock()
        .map_err(|_| "情报批次状态锁已损坏".to_string())?;
    *active = run_id;
    Ok(())
}

fn ann_cache() -> &'static Mutex<Option<IntelligenceAnnCache>> {
    INTELLIGENCE_ANN_CACHE.get_or_init(|| Mutex::new(None))
}

fn invalidate_ann_cache() {
    if let Ok(mut cache) = ann_cache().lock() {
        *cache = None;
    }
}

fn normalize_vector(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return None;
    }
    for value in &mut vector {
        *value /= norm;
    }
    Some(vector)
}

fn ann_key(
    path: &Path,
    connection: &Connection,
    model: &str,
    dimension: u32,
    instruction: &str,
    revision: &str,
) -> Result<IntelligenceAnnKey, String> {
    let (count, max_updated_at, bytes) = connection
        .query_row(
            "SELECT COUNT(*),COALESCE(MAX(updated_at),0),COALESCE(SUM(LENGTH(vector_blob)),0)
             FROM intelligence_news_vectors
             WHERE model_id=?1 AND dimension=?2 AND instruction=?3 AND revision=?4",
            params![model, dimension, instruction, revision],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(IntelligenceAnnKey {
        path: path.to_path_buf(),
        model: model.to_string(),
        dimension,
        instruction: instruction.to_string(),
        revision: revision.to_string(),
        count,
        max_updated_at,
        bytes,
    })
}

fn ann_search_at(
    path: &Path,
    request: &IntelligenceStoreDenseSearchRequest,
) -> Result<Vec<IntelligenceRetrievalHit>, String> {
    let model = required(&request.embedding_model, "向量模型", 300)?;
    let instruction = required_or_empty(&request.instruction, "向量指令", 2_000)?;
    let revision = required_or_empty(&request.revision, "向量修订", 200)?;
    if request.dimension == 0
        || request.dimension as usize != request.vector.len()
        || request.dimension > 8_192
        || request.vector.iter().any(|value| !value.is_finite())
    {
        return Err("检索向量维数或数值无效".into());
    }
    let query = normalize_vector(request.vector.clone()).ok_or("检索向量不能为零向量")?;
    let limit = request.limit.unwrap_or(20).clamp(1, 100) as usize;
    let exclude = request.exclude_article_id.as_deref();
    let connection = open_store_at(path)?;
    let key = ann_key(
        path,
        &connection,
        &model,
        request.dimension,
        &instruction,
        &revision,
    )?;
    if key.count == 0 {
        return Ok(Vec::new());
    }

    let mut cache = ann_cache()
        .lock()
        .map_err(|_| "情报 ANN 索引锁定失败".to_string())?;
    if cache.as_ref().is_none_or(|cached| cached.key != key) {
        let mut statement = connection
            .prepare(
                "SELECT article_id,dimension,vector_blob FROM intelligence_news_vectors
                 WHERE model_id=?1 AND dimension=?2 AND instruction=?3 AND revision=?4
                 ORDER BY article_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![model, request.dimension, instruction, revision],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, usize>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        let mut article_ids = Vec::with_capacity(key.count as usize);
        let mut points = Vec::with_capacity(key.count as usize);
        for row in rows {
            let (article_id, dimension, blob) = row.map_err(|error| error.to_string())?;
            let Some(vector) = decode_vector(&blob, dimension).and_then(normalize_vector) else {
                continue;
            };
            article_ids.push(article_id);
            points.push(IntelligenceAnnPoint(vector));
        }
        if points.is_empty() {
            return Ok(Vec::new());
        }
        let values = (0..points.len() as u32).collect::<Vec<_>>();
        let graph = instant_distance::Builder::default()
            .ef_construction(if request.dimension >= 768 && points.len() >= 8_000 {
                80
            } else {
                100
            })
            .ef_search(100)
            .seed(0x494E_5445_4C4C_4947)
            .build(points, values);
        *cache = Some(IntelligenceAnnCache {
            key: key.clone(),
            graph,
            article_ids,
        });
    }
    let cached = cache.as_ref().ok_or("情报 ANN 索引未建立")?;
    let mut search = instant_distance::Search::default();
    let query = IntelligenceAnnPoint(query);
    let mut hits = Vec::with_capacity(limit);
    for item in cached
        .graph
        .search(&query, &mut search)
        .take((limit + usize::from(exclude.is_some())).min(cached.article_ids.len()))
    {
        let Some(article_id) = cached.article_ids.get(*item.value as usize) else {
            continue;
        };
        if exclude == Some(article_id.as_str()) {
            continue;
        }
        hits.push(IntelligenceRetrievalHit {
            article_id: article_id.clone(),
            score: (1.0 - item.distance).clamp(-1.0, 1.0),
            mode: "hnsw_dense".into(),
        });
        if hits.len() == limit {
            break;
        }
    }
    Ok(hits)
}

fn upsert_embeddings_at(
    path: &Path,
    request: IntelligenceStoreUpsertEmbeddingsRequest,
) -> Result<IntelligenceStoreWriteResult, String> {
    if request.embeddings.is_empty() || request.embeddings.len() > MAX_ARTICLES_PER_BATCH {
        return Err(format!(
            "每批向量数量必须在 1 到 {MAX_ARTICLES_PER_BATCH} 之间"
        ));
    }
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let received = request.embeddings.len() as u64;
    for embedding in request.embeddings {
        let article_id = required(&embedding.article_id, "文章 ID", 200)?;
        let fingerprint = required(&embedding.fingerprint, "文章指纹", 200)?;
        let model = required(&embedding.embedding_model, "向量模型", 300)?;
        let instruction = required_or_empty(&embedding.instruction, "向量指令", 2_000)?;
        let revision = required_or_empty(&embedding.revision, "向量修订", 200)?;
        if embedding.dimension == 0
            || embedding.dimension as usize != embedding.vector.len()
            || embedding.dimension > 8_192
        {
            return Err("向量维数与实际向量长度不一致".into());
        }
        let blob = encode_vector(&embedding.vector)?;
        transaction
            .execute(
                "INSERT INTO intelligence_news_vectors(
                     article_id,fingerprint,model_id,dimension,instruction,revision,vector_blob,updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(article_id,fingerprint,model_id) DO UPDATE SET
                     dimension=excluded.dimension,instruction=excluded.instruction,
                     revision=excluded.revision,vector_blob=excluded.vector_blob,
                     updated_at=excluded.updated_at",
                params![
                    article_id,
                    fingerprint,
                    model,
                    embedding.dimension,
                    instruction,
                    revision,
                    blob,
                    timestamp,
                ],
            )
            .map_err(|error| format!("保存情报向量失败：{error}"))?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    invalidate_ann_cache();
    Ok(IntelligenceStoreWriteResult {
        received,
        applied: received,
    })
}

fn required_or_empty(value: &str, field: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    bounded(value, field, max)?;
    Ok(value.to_string())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreDenseSearchRequest {
    pub embedding_model: String,
    pub dimension: u32,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub revision: String,
    pub vector: Vec<f32>,
    pub limit: Option<u32>,
    pub exclude_article_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceRetrievalHit {
    pub article_id: String,
    pub score: f32,
    pub mode: String,
}

#[cfg(test)]
fn dense_search_at(
    path: &Path,
    request: IntelligenceStoreDenseSearchRequest,
) -> Result<Vec<IntelligenceRetrievalHit>, String> {
    let model = required(&request.embedding_model, "向量模型", 300)?;
    let instruction = required_or_empty(&request.instruction, "向量指令", 2_000)?;
    let revision = required_or_empty(&request.revision, "向量修订", 200)?;
    if request.dimension == 0
        || request.dimension as usize != request.vector.len()
        || request.dimension > 8_192
        || request.vector.iter().any(|value| !value.is_finite())
    {
        return Err("检索向量维数或数值无效".into());
    }
    let limit = request.limit.unwrap_or(20).clamp(1, 100) as usize;
    let exclude = optional(request.exclude_article_id, "排除文章 ID", 200)?;
    let query_norm = request
        .vector
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if query_norm <= f32::EPSILON {
        return Err("检索向量不能为零向量".into());
    }
    let connection = open_store_at(path)?;
    let mut statement = connection
        .prepare(
            "SELECT article_id,dimension,vector_blob FROM intelligence_news_vectors
             WHERE model_id=?1 AND instruction=?2 AND revision=?3 AND dimension=?4",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![model, instruction, revision, request.dimension],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, usize>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let mut hits = Vec::new();
    for row in rows {
        let (article_id, dimension, blob) = row.map_err(|error| error.to_string())?;
        if exclude.as_deref() == Some(article_id.as_str()) {
            continue;
        }
        let Some(vector) = decode_vector(&blob, dimension) else {
            continue;
        };
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm <= f32::EPSILON {
            continue;
        }
        let score = request
            .vector
            .iter()
            .zip(&vector)
            .map(|(left, right)| left * right)
            .sum::<f32>()
            / (query_norm * norm);
        hits.push(IntelligenceRetrievalHit {
            article_id,
            score,
            mode: "dense".into(),
        });
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.article_id.cmp(&right.article_id))
    });
    hits.truncate(limit);
    Ok(hits)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceStoreSparseSearchRequest {
    pub query: String,
    pub limit: Option<u32>,
}

fn fts_query(value: &str) -> Result<String, String> {
    let tokens = sparse_terms(value)
        .into_iter()
        .take(24)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err("稀疏检索词不能为空".into());
    }
    Ok(tokens.join(" OR "))
}

fn sparse_terms(value: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut latin = String::new();
    let mut cjk = String::new();
    let flush = |terms: &mut Vec<String>, latin: &mut String, cjk: &mut String| {
        if !latin.is_empty() {
            terms.push(std::mem::take(latin).to_ascii_lowercase());
        }
        let chars = cjk.chars().collect::<Vec<_>>();
        if chars.len() == 1 {
            terms.push(chars[0].to_string());
        } else {
            terms.extend(chars.windows(2).map(|pair| pair.iter().collect::<String>()));
        }
        cjk.clear();
    };
    for character in value.chars().take(16_000) {
        if character.is_ascii_alphanumeric() || character == '_' {
            if !cjk.is_empty() {
                flush(&mut terms, &mut latin, &mut cjk);
            }
            latin.push(character);
        } else if ('\u{3400}'..='\u{9fff}').contains(&character) {
            if !latin.is_empty() {
                flush(&mut terms, &mut latin, &mut cjk);
            }
            cjk.push(character);
        } else {
            flush(&mut terms, &mut latin, &mut cjk);
        }
    }
    flush(&mut terms, &mut latin, &mut cjk);
    terms.sort();
    terms.dedup();
    terms
}

fn sparse_search_at(
    path: &Path,
    request: IntelligenceStoreSparseSearchRequest,
) -> Result<Vec<IntelligenceRetrievalHit>, String> {
    bounded(&request.query, "稀疏检索词", 4_000)?;
    let query = fts_query(&request.query)?;
    let limit = request.limit.unwrap_or(20).clamp(1, 100);
    let connection = open_store_at(path)?;
    let mut statement = connection
        .prepare(
            "SELECT article_id, -bm25(intelligence_news_fts, 0.0, 5.0, 2.0, 1.0, 4.0)
             FROM intelligence_news_fts WHERE intelligence_news_fts MATCH ?1
             ORDER BY bm25(intelligence_news_fts, 0.0, 5.0, 2.0, 1.0, 4.0)
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let hits = statement
        .query_map(params![query, limit], |row| {
            Ok(IntelligenceRetrievalHit {
                article_id: row.get(0)?,
                score: row.get(1)?,
                mode: "sparse".into(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(hits)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRecallArticle {
    pub article_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRecallPair {
    pub id: String,
    pub left_article_id: String,
    pub right_article_id: String,
    pub left: IntelligencePipelineRecallArticle,
    pub right: IntelligencePipelineRecallArticle,
    pub score: f32,
    pub reason: String,
    pub calibrated_score: Option<f32>,
    pub calibration_engine: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineHistoricalCandidate {
    pub new_article_id: String,
    pub event_id: String,
    pub series_id: Option<String>,
    pub latest_revision: u64,
    pub score: f32,
    pub reason: String,
    pub title: String,
    pub summary: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRecallEngineProfile {
    pub embedding_model: String,
    pub dimension: u32,
    pub instruction: String,
    pub revision: String,
    pub ann_index: String,
    pub reranker_model: String,
    pub reranker_revision: String,
    pub calibration_model: String,
    pub calibration_dimension: u32,
    pub calibration_revision: String,
    pub calibration_status: String,
    pub calibrated_pairs: u64,
    pub mode: String,
    pub degraded: bool,
    pub degraded_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRecallResult {
    /// Human-readable engine label retained for the existing audit renderer.
    pub engine: String,
    pub engine_profile: IntelligencePipelineRecallEngineProfile,
    pub pairs: Vec<IntelligencePipelineRecallPair>,
    pub historical_candidates: Vec<IntelligencePipelineHistoricalCandidate>,
    pub degraded: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineJudgeCandidate {
    #[serde(alias = "id")]
    pub article_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub source_names: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub series_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineJudgePair {
    pub id: String,
    pub left: IntelligencePipelineJudgeCandidate,
    pub right: IntelligencePipelineJudgeCandidate,
    #[serde(default, rename = "retrievalScore")]
    _retrieval_score: f32,
    #[serde(default, rename = "retrievalReason")]
    _retrieval_reason: String,
}

fn bounded_pipeline_judge_candidate(
    candidate: &IntelligencePipelineJudgeCandidate,
) -> super::IntelligenceEventPairCandidate {
    // Recall candidates ultimately come from public feeds and historical
    // event titles. Keep the external relation API strict, but make the
    // all-catalogue pipeline project those fields into the model boundary so
    // one oversized RSS headline cannot block every later relation batch.
    super::IntelligenceEventPairCandidate {
        id: candidate.article_id.clone(),
        title: super::intelligence_model_text_bounded(
            &candidate.title,
            super::INTELLIGENCE_EVENT_JUDGE_TITLE_CHARS,
            super::MAX_INTELLIGENCE_BRIEF_TITLE_BYTES,
        ),
        summary: super::intelligence_model_text_bounded(
            &candidate.summary,
            super::INTELLIGENCE_EVENT_JUDGE_SUMMARY_CHARS,
            super::MAX_INTELLIGENCE_BRIEF_SUMMARY_BYTES,
        ),
        published_at: super::intelligence_model_text_bounded(
            &candidate.published_at,
            super::MAX_INTELLIGENCE_BRIEF_PUBLISHED_AT_BYTES,
            super::MAX_INTELLIGENCE_BRIEF_PUBLISHED_AT_BYTES,
        ),
        source_names: candidate
            .source_names
            .iter()
            .take(super::MAX_INTELLIGENCE_EVENT_JUDGE_SOURCE_NAMES)
            .map(|name| {
                super::intelligence_model_text_bounded(
                    name,
                    super::INTELLIGENCE_EVENT_JUDGE_SOURCE_NAME_CHARS,
                    super::MAX_INTELLIGENCE_BRIEF_SOURCE_NAME_BYTES,
                )
            })
            .collect(),
        url: candidate.url.clone(),
        fingerprint: candidate.fingerprint.clone(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRelationDecision {
    pub id: String,
    pub relation: String,
    pub proposed_relation: String,
    pub confidence: f32,
    pub reason: String,
    pub requires_qwen_review: bool,
    pub left_article_id: String,
    pub right_article_id: String,
    pub left_event_id: Option<String>,
    pub right_event_id: Option<String>,
    pub left_series_id: Option<String>,
    pub right_series_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligencePipelineRelationJudgements {
    pub model: String,
    pub decisions: Vec<IntelligencePipelineRelationDecision>,
}

fn normalize_pipeline_recall_articles(
    articles: Vec<IntelligencePipelineRecallArticle>,
) -> Result<Vec<IntelligencePipelineRecallArticle>, String> {
    if articles.is_empty() || articles.len() > PIPELINE_RECALL_MAX_ARTICLES {
        return Err(format!(
            "关系召回每批文章数量必须在 1 到 {PIPELINE_RECALL_MAX_ARTICLES} 之间"
        ));
    }
    let mut ids = HashSet::with_capacity(articles.len());
    articles
        .into_iter()
        .map(|article| {
            let article_id = required(&article.article_id, "文章 ID", 200)?;
            if !ids.insert(article_id.clone()) {
                return Err("关系召回文章 ID 不能重复".into());
            }
            Ok(IntelligencePipelineRecallArticle {
                article_id,
                title: required(&article.title, "文章标题", 2_000)?,
                summary: required_or_empty(&article.summary, "文章摘要", 64 * 1024)?,
                published_at: required_or_empty(&article.published_at, "发布时间", 100)?,
            })
        })
        .collect()
}

fn pipeline_article_text(article: &IntelligencePipelineRecallArticle) -> String {
    let summary = article.summary.chars().take(2_400).collect::<String>();
    format!(
        "Instruct: {QWEN3_EMBEDDING_INSTRUCTION}\nQuery: {}\n{}\n{}",
        article.title, summary, article.published_at
    )
}

fn pair_id(left: &str, right: &str) -> String {
    let (left, right) = if left <= right {
        (left, right)
    } else {
        (right, left)
    };
    let digest = Sha256::digest(format!("{left}\u{1f}{right}").as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("pair-{suffix}")
}

fn recall_pair(
    left: IntelligencePipelineRecallArticle,
    right: IntelligencePipelineRecallArticle,
    score: f32,
    reason: &str,
) -> IntelligencePipelineRecallPair {
    // The id is canonical for cross-batch de-duplication, but reranking is
    // directional: `left` is the query article and `right` is its recalled
    // neighbour. Sorting the payload by id silently changed the reranker query.
    IntelligencePipelineRecallPair {
        id: pair_id(&left.article_id, &right.article_id),
        left_article_id: left.article_id.clone(),
        right_article_id: right.article_id.clone(),
        left,
        right,
        score,
        reason: reason.into(),
        calibrated_score: None,
        calibration_engine: None,
    }
}

fn stored_recall_article(
    connection: &Connection,
    article_id: &str,
) -> Result<Option<IntelligencePipelineRecallArticle>, String> {
    connection
        .query_row(
            "SELECT article_id,title,summary,published_at FROM intelligence_articles
             WHERE article_id=?1",
            [article_id],
            |row| {
                Ok(IntelligencePipelineRecallArticle {
                    article_id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    published_at: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn embedding_endpoint() -> String {
    format!("{QWEN3_EMBEDDING_BASE_URL}/embeddings")
}

fn calibration_embedding_endpoint() -> String {
    format!("{QWEN3_CALIBRATION_BASE_URL}/embeddings")
}

fn reranker_endpoint() -> String {
    format!("{QWEN3_RERANKER_BASE_URL}/rerank")
}

async fn fetch_pipeline_embeddings(
    client: &reqwest::Client,
    articles: &[IntelligencePipelineRecallArticle],
) -> Result<Vec<Vec<f32>>, String> {
    fetch_named_embeddings(
        client,
        articles,
        embedding_endpoint(),
        QWEN3_EMBEDDING_MODEL,
        "Qwen3 Embedding",
    )
    .await
}

async fn fetch_named_embeddings(
    client: &reqwest::Client,
    articles: &[IntelligencePipelineRecallArticle],
    endpoint: String,
    model: &str,
    label: &str,
) -> Result<Vec<Vec<f32>>, String> {
    let mut embeddings = Vec::with_capacity(articles.len());
    for chunk in articles.chunks(64) {
        let response = client
            .post(&endpoint)
            .json(&serde_json::json!({
                "model": model,
                "input": chunk.iter().map(pipeline_article_text).collect::<Vec<_>>(),
            }))
            .send()
            .await
            .map_err(|error| format!("{label} 服务不可用：{error}"))?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|error| format!("{label} 响应无效：{error}"))?;
        if !status.is_success() {
            return Err(format!("{label} 返回 HTTP {status}"));
        }
        let mut rows = body
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{label} 响应缺少 data"))?
            .iter()
            .map(|item| {
                let index = item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let vector = item
                    .get("embedding")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("{label} 响应缺少 embedding"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_f64()
                            .map(|value| value as f32)
                            .filter(|value| value.is_finite())
                            .ok_or_else(|| "Qwen3 Embedding 返回了无效数值".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((index, vector))
            })
            .collect::<Result<Vec<_>, String>>()?;
        rows.sort_by_key(|(index, _)| *index);
        if rows.len() != chunk.len() {
            return Err(format!("{label} 返回的向量数量不匹配"));
        }
        embeddings.extend(rows.into_iter().map(|(_, vector)| vector));
    }
    let dimension = embeddings.first().map(Vec::len).unwrap_or(0);
    if dimension == 0
        || dimension > 8_192
        || embeddings.iter().any(|vector| vector.len() != dimension)
    {
        return Err(format!("{label} 返回的向量维数不一致"));
    }
    Ok(embeddings)
}

async fn rerank_pipeline_pairs(
    client: &reqwest::Client,
    pairs: &mut [IntelligencePipelineRecallPair],
) -> Result<(), String> {
    let mut by_left = BTreeMap::<String, Vec<usize>>::new();
    for (index, pair) in pairs.iter().enumerate() {
        by_left
            .entry(pair.left_article_id.clone())
            .or_default()
            .push(index);
    }
    for (_left_id, indices) in by_left {
        let Some(left) = indices.first().map(|index| &pairs[*index].left) else {
            continue;
        };
        let documents = indices
            .iter()
            .map(|index| &pairs[*index].right)
            .map(pipeline_article_text)
            .collect::<Vec<_>>();
        if documents.is_empty() {
            continue;
        }
        let response = client
            .post(reranker_endpoint())
            .json(&serde_json::json!({
                "model": QWEN3_RERANKER_MODEL,
                "query": pipeline_article_text(left),
                "documents": documents,
                "top_n": indices.len(),
            }))
            .send()
            .await
            .map_err(|error| format!("Qwen3 Reranker 服务不可用：{error}"))?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Qwen3 Reranker 响应无效：{error}"))?;
        if !status.is_success() {
            return Err(format!("Qwen3 Reranker 返回 HTTP {status}"));
        }
        let results = body
            .get("results")
            .or_else(|| body.get("data"))
            .and_then(Value::as_array)
            .ok_or("Qwen3 Reranker 响应缺少 results")?;
        for result in results {
            let Some(local_index) = result.get("index").and_then(Value::as_u64) else {
                continue;
            };
            let Some(pair_index) = indices.get(local_index as usize) else {
                continue;
            };
            let score = result
                .get("relevance_score")
                .or_else(|| result.get("score"))
                .and_then(Value::as_f64)
                .unwrap_or(pairs[*pair_index].score as f64) as f32;
            pairs[*pair_index].score = score.clamp(0.0, 1.0);
            pairs[*pair_index].reason =
                "Qwen3 Embedding HNSW 近邻召回，经 Qwen3 Reranker 候选重排；仍须 8B 关系判定"
                    .into();
        }
    }
    pairs.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(())
}

async fn calibrate_boundary_pairs(
    client: &reqwest::Client,
    pairs: &mut [IntelligencePipelineRecallPair],
) -> Result<(u64, u32), String> {
    let indices = pairs
        .iter()
        .enumerate()
        .filter(|(_, pair)| (0.45..=0.80).contains(&pair.score))
        .map(|(index, _)| index)
        .take(PIPELINE_CALIBRATION_MAX_PAIRS)
        .collect::<Vec<_>>();
    if indices.is_empty() {
        return Ok((0, 0));
    }
    let mut articles = BTreeMap::<String, IntelligencePipelineRecallArticle>::new();
    for index in &indices {
        let pair = &pairs[*index];
        articles
            .entry(pair.left.article_id.clone())
            .or_insert_with(|| pair.left.clone());
        articles
            .entry(pair.right.article_id.clone())
            .or_insert_with(|| pair.right.clone());
    }
    let articles = articles.into_values().collect::<Vec<_>>();
    let embeddings = fetch_named_embeddings(
        client,
        &articles,
        calibration_embedding_endpoint(),
        QWEN3_CALIBRATION_MODEL,
        "Qwen3 Embedding 8B 校准",
    )
    .await?;
    let dimension = embeddings.first().map(Vec::len).unwrap_or(0) as u32;
    let vectors = articles
        .iter()
        .zip(embeddings)
        .filter_map(|(article, vector)| {
            normalize_vector(vector).map(|vector| (article.article_id.clone(), vector))
        })
        .collect::<HashMap<_, _>>();
    let mut calibrated = 0_u64;
    for index in indices {
        let pair = &mut pairs[index];
        let (Some(left), Some(right)) = (
            vectors.get(&pair.left.article_id),
            vectors.get(&pair.right.article_id),
        ) else {
            continue;
        };
        let calibrated_score = left
            .iter()
            .zip(right)
            .map(|(left, right)| left * right)
            .sum::<f32>()
            .clamp(0.0, 1.0);
        let reranker_score = pair.score;
        pair.calibrated_score = Some(calibrated_score);
        pair.calibration_engine = Some(QWEN3_CALIBRATION_MODEL.into());
        pair.score = (reranker_score * 0.55 + calibrated_score * 0.45).clamp(0.0, 1.0);
        pair.reason = format!(
            "Qwen3-Embedding-0.6B HNSW + 0.6B Reranker；边界候选经 8B Embedding 实际校准（rerank={reranker_score:.4}, calibration={calibrated_score:.4}），仍须 8B Instruct 判定"
        );
        calibrated += 1;
    }
    pairs.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok((calibrated, dimension))
}

fn prune_pairs_for_relation_judge(pairs: &mut Vec<IntelligencePipelineRecallPair>) -> usize {
    let before = pairs.len();
    pairs.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut per_query = HashMap::<String, usize>::new();
    pairs.retain(|pair| {
        if pair.score < PIPELINE_JUDGE_MIN_SCORE {
            return false;
        }
        let count = per_query.entry(pair.left_article_id.clone()).or_default();
        if *count >= PIPELINE_JUDGE_TOP_K_PER_QUERY {
            return false;
        }
        *count += 1;
        true
    });
    before.saturating_sub(pairs.len())
}

fn load_article_fingerprints(
    path: &Path,
    article_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let connection = open_store_at(path)?;
    let mut statement = connection
        .prepare("SELECT fingerprint FROM intelligence_articles WHERE article_id=?1")
        .map_err(|error| error.to_string())?;
    let mut fingerprints = HashMap::new();
    for article_id in article_ids {
        if let Some(fingerprint) = statement
            .query_row([article_id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|error| error.to_string())?
        {
            fingerprints.insert(article_id.clone(), fingerprint);
        }
    }
    Ok(fingerprints)
}

fn recall_sparse_candidates_at(
    path: &Path,
    articles: &[IntelligencePipelineRecallArticle],
    include_history: bool,
) -> Result<
    (
        Vec<IntelligencePipelineRecallPair>,
        Vec<IntelligencePipelineHistoricalCandidate>,
    ),
    String,
> {
    let current = articles
        .iter()
        .map(|article| article.article_id.as_str())
        .collect::<HashSet<_>>();
    let current_articles = articles
        .iter()
        .cloned()
        .map(|article| (article.article_id.clone(), article))
        .collect::<HashMap<_, _>>();
    let mut pair_ids = HashSet::new();
    let mut pairs = Vec::new();
    let mut history = HashMap::<(String, String), IntelligencePipelineHistoricalCandidate>::new();
    let connection = open_store_at(path)?;
    for article in articles {
        let hits = sparse_search_at(
            path,
            IntelligenceStoreSparseSearchRequest {
                query: format!("{} {}", article.title, article.summary),
                limit: Some(PIPELINE_RECALL_TOP_K as u32),
            },
        )
        .unwrap_or_default();
        for (rank, hit) in hits.into_iter().enumerate() {
            if hit.article_id == article.article_id {
                continue;
            }
            let score = (0.62 - rank as f32 * 0.025).max(0.35);
            if current.contains(hit.article_id.as_str()) {
                if let Some(right) = current_articles.get(&hit.article_id) {
                    let pair = recall_pair(
                        article.clone(),
                        right.clone(),
                        score,
                        "FTS5 稀疏候选召回（向量服务降级）；仍须 8B 关系判定",
                    );
                    if pair_ids.insert(pair.id.clone()) {
                        pairs.push(pair);
                    }
                }
            } else if include_history {
                let historical = historical_candidate_for_article(
                    &connection,
                    &article.article_id,
                    &hit.article_id,
                    score,
                    "FTS5 历史候选召回（向量服务降级）；不得自动挂接",
                )?;
                if let Some(candidate) = historical {
                    history
                        .entry((candidate.new_article_id.clone(), candidate.event_id.clone()))
                        .and_modify(|existing| existing.score = existing.score.max(score))
                        .or_insert(candidate);
                } else if let Some(right) = stored_recall_article(&connection, &hit.article_id)? {
                    let pair = recall_pair(
                        article.clone(),
                        right,
                        score,
                        "FTS5 跨批候选召回（向量服务降级）；仍须 8B 关系判定",
                    );
                    if pair_ids.insert(pair.id.clone()) {
                        pairs.push(pair);
                    }
                }
            }
        }
    }
    pairs.truncate(PIPELINE_RECALL_MAX_PAIRS);
    let mut history = history.into_values().collect::<Vec<_>>();
    history.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    history.truncate(articles.len().saturating_mul(PIPELINE_HISTORY_TOP_K));
    Ok((pairs, history))
}

fn historical_candidate_for_article(
    connection: &Connection,
    new_article_id: &str,
    historical_article_id: &str,
    score: f32,
    reason: &str,
) -> Result<Option<IntelligencePipelineHistoricalCandidate>, String> {
    connection
        .query_row(
            "SELECT e.event_id,e.series_id,e.current_revision,e.title,e.summary,e.occurred_at
             FROM intelligence_event_articles ea
             JOIN intelligence_events e ON e.event_id=ea.event_id
             WHERE ea.article_id=?1 ORDER BY e.updated_at DESC LIMIT 1",
            [historical_article_id],
            |row| {
                Ok(IntelligencePipelineHistoricalCandidate {
                    new_article_id: new_article_id.to_string(),
                    event_id: row.get(0)?,
                    series_id: row.get(1)?,
                    latest_revision: row.get(2)?,
                    score,
                    reason: reason.to_string(),
                    title: row.get(3)?,
                    summary: row.get(4)?,
                    occurred_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn recall_ann_candidates_at(
    path: &Path,
    articles: &[IntelligencePipelineRecallArticle],
    embeddings: &[Vec<f32>],
    include_history: bool,
) -> Result<
    (
        Vec<IntelligencePipelineRecallPair>,
        Vec<IntelligencePipelineHistoricalCandidate>,
    ),
    String,
> {
    let dimension = embeddings.first().map(Vec::len).unwrap_or(0) as u32;
    let current = articles
        .iter()
        .map(|article| article.article_id.as_str())
        .collect::<HashSet<_>>();
    let current_articles = articles
        .iter()
        .cloned()
        .map(|article| (article.article_id.clone(), article))
        .collect::<HashMap<_, _>>();
    let mut pair_ids = HashSet::new();
    let mut pairs = Vec::new();
    let mut history = HashMap::<(String, String), IntelligencePipelineHistoricalCandidate>::new();
    let connection = open_store_at(path)?;
    for (article, vector) in articles.iter().zip(embeddings) {
        let hits = ann_search_at(
            path,
            &IntelligenceStoreDenseSearchRequest {
                embedding_model: QWEN3_EMBEDDING_MODEL.into(),
                dimension,
                instruction: QWEN3_EMBEDDING_INSTRUCTION.into(),
                revision: QWEN3_EMBEDDING_REVISION.into(),
                vector: vector.clone(),
                limit: Some(PIPELINE_RECALL_TOP_K as u32),
                exclude_article_id: Some(article.article_id.clone()),
            },
        )?;
        for hit in hits {
            if hit.score < 0.35 {
                continue;
            }
            if current.contains(hit.article_id.as_str()) {
                if let Some(right) = current_articles.get(&hit.article_id) {
                    let pair = recall_pair(
                        article.clone(),
                        right.clone(),
                        hit.score.clamp(0.0, 1.0),
                        "Qwen3 Embedding HNSW Top-K 候选召回；尚未判定关系",
                    );
                    if pair_ids.insert(pair.id.clone()) {
                        pairs.push(pair);
                    }
                }
            } else if include_history {
                let historical = historical_candidate_for_article(
                    &connection,
                    &article.article_id,
                    &hit.article_id,
                    hit.score.clamp(0.0, 1.0),
                    "Qwen3 Embedding HNSW 历史候选召回；须 8B 判定后才能挂接",
                )?;
                if let Some(candidate) = historical {
                    history
                        .entry((candidate.new_article_id.clone(), candidate.event_id.clone()))
                        .and_modify(|existing| existing.score = existing.score.max(hit.score))
                        .or_insert(candidate);
                } else if let Some(right) = stored_recall_article(&connection, &hit.article_id)? {
                    let pair = recall_pair(
                        article.clone(),
                        right,
                        hit.score.clamp(0.0, 1.0),
                        "Qwen3 Embedding HNSW 跨批候选召回；仍须 8B 关系判定",
                    );
                    if pair_ids.insert(pair.id.clone()) {
                        pairs.push(pair);
                    }
                }
            }
        }
    }
    pairs.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    pairs.truncate(PIPELINE_RECALL_MAX_PAIRS);
    let mut history = history.into_values().collect::<Vec<_>>();
    history.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    history.truncate(articles.len().saturating_mul(PIPELINE_HISTORY_TOP_K));
    Ok((pairs, history))
}

fn persist_recall_audit(
    path: &Path,
    pairs: &[IntelligencePipelineRecallPair],
    history: &[IntelligencePipelineHistoricalCandidate],
    discarded_pairs: usize,
) -> Result<(), String> {
    let mut connection = open_store_at(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    let pruning_detail = serde_json::to_string(&serde_json::json!({
        "title": "关系判定候选裁剪",
        "retainedCount": pairs.len(),
        "discardedCount": discarded_pairs,
        "minimumScore": PIPELINE_JUDGE_MIN_SCORE,
        "maxPerQuery": PIPELINE_JUDGE_TOP_K_PER_QUERY,
        "reason": "仅将每篇文章重排后得分最高的候选送入 8B 关系判定；裁剪不代表自动去重或合并",
    }))
    .map_err(|error| error.to_string())?;
    audit_item(
        &transaction,
        "relation-recall",
        "summary",
        "judge-pruning",
        "completed",
        Some(&pruning_detail),
        timestamp,
    )?;
    for pair in pairs.iter().take(PIPELINE_RECALL_MAX_PAIRS) {
        let detail = serde_json::to_string(&serde_json::json!({
            "leftArticleId": pair.left_article_id,
            "rightArticleId": pair.right_article_id,
            "leftTitle": pair.left.title,
            "rightTitle": pair.right.title,
            "model": QWEN3_EMBEDDING_MODEL,
            "reranker": QWEN3_RERANKER_MODEL,
            "score": pair.score,
            "calibratedScore": pair.calibrated_score,
            "calibrationEngine": pair.calibration_engine,
            "reason": pair.reason,
        }))
        .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "relation-recall",
            "pairs",
            &pair.id,
            "candidate",
            Some(&detail),
            timestamp,
        )?;
    }
    for candidate in history
        .iter()
        .take(PIPELINE_RECALL_MAX_ARTICLES * PIPELINE_HISTORY_TOP_K)
    {
        let item_id = format!("{}:{}", candidate.new_article_id, candidate.event_id);
        let new_title = transaction
            .query_row(
                "SELECT title FROM intelligence_articles WHERE article_id=?1",
                [&candidate.new_article_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let detail = serde_json::to_string(&serde_json::json!({
            "newArticleId": candidate.new_article_id,
            "newArticleTitle": new_title,
            "eventId": candidate.event_id,
            "seriesId": candidate.series_id,
            "latestRevision": candidate.latest_revision,
            "eventTitle": candidate.title,
            "eventSummary": candidate.summary,
            "occurredAt": candidate.occurred_at,
            "score": candidate.score,
            "reason": candidate.reason,
            "model": QWEN3_EMBEDDING_MODEL,
        }))
        .map_err(|error| error.to_string())?;
        audit_item(
            &transaction,
            "historical-recall",
            "events",
            &item_id,
            "candidate",
            Some(&detail),
            timestamp,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

async fn pipeline_recall_relations_at(
    path: &Path,
    articles: Vec<IntelligencePipelineRecallArticle>,
    include_history: bool,
) -> Result<IntelligencePipelineRecallResult, String> {
    let articles = normalize_pipeline_recall_articles(articles)?;
    let article_ids = articles
        .iter()
        .map(|article| article.article_id.clone())
        .collect::<Vec<_>>();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let embedding_result = fetch_pipeline_embeddings(&client, &articles).await;
    let mut degraded_reason = None;
    let (mut pairs, history, dimension, mut reranker_available) = match embedding_result {
        Ok(embeddings) => {
            let dimension = embeddings.first().map(Vec::len).unwrap_or(0) as u32;
            let fingerprints = load_article_fingerprints(path, &article_ids)?;
            let to_store = articles
                .iter()
                .zip(&embeddings)
                .filter_map(|(article, vector)| {
                    fingerprints.get(&article.article_id).map(|fingerprint| {
                        IntelligenceEmbeddingInput {
                            article_id: article.article_id.clone(),
                            fingerprint: fingerprint.clone(),
                            embedding_model: QWEN3_EMBEDDING_MODEL.into(),
                            dimension,
                            instruction: QWEN3_EMBEDDING_INSTRUCTION.into(),
                            revision: QWEN3_EMBEDDING_REVISION.into(),
                            vector: vector.clone(),
                        }
                    })
                })
                .collect::<Vec<_>>();
            if !to_store.is_empty() {
                for chunk in to_store.chunks(MAX_ARTICLES_PER_BATCH) {
                    upsert_embeddings_at(
                        path,
                        IntelligenceStoreUpsertEmbeddingsRequest {
                            embeddings: chunk.to_vec(),
                        },
                    )?;
                }
            }
            let (pairs, history) =
                recall_ann_candidates_at(path, &articles, &embeddings, include_history)?;
            (pairs, history, dimension, true)
        }
        Err(error) => {
            degraded_reason = Some(error);
            let (pairs, history) = recall_sparse_candidates_at(path, &articles, include_history)?;
            (pairs, history, 0, false)
        }
    };

    if reranker_available && !pairs.is_empty() {
        if let Err(error) = rerank_pipeline_pairs(&client, &mut pairs).await {
            reranker_available = false;
            degraded_reason = Some(error);
        }
    }
    let has_boundary_candidates = pairs.iter().any(|pair| (0.45..=0.80).contains(&pair.score));
    let (calibrated_pairs, calibration_dimension, calibration_status, calibration_failed) =
        if dimension > 0 && reranker_available && has_boundary_candidates {
            match calibrate_boundary_pairs(&client, &mut pairs).await {
                Ok((count, calibration_dimension)) if count > 0 => {
                    (count, calibration_dimension, "applied", false)
                }
                Ok(_) => (0, 0, "not_needed", false),
                Err(error) => {
                    degraded_reason = Some(match degraded_reason.take() {
                        Some(existing) => format!("{existing}；8B 校准不可用：{error}"),
                        None => format!("8B 校准不可用：{error}"),
                    });
                    (0, 0, "unavailable", true)
                }
            }
        } else {
            (0, 0, "not_needed", false)
        };
    let degraded = dimension == 0 || !reranker_available || calibration_failed;
    let mode = if dimension == 0 {
        "fts5_sparse_only"
    } else if calibrated_pairs > 0 {
        "qwen3_hnsw_dense_rerank_8b_calibrated"
    } else if reranker_available {
        "qwen3_hnsw_dense_rerank"
    } else {
        "qwen3_hnsw_dense_no_rerank"
    };
    let profile = IntelligencePipelineRecallEngineProfile {
        embedding_model: QWEN3_EMBEDDING_MODEL.into(),
        dimension,
        instruction: QWEN3_EMBEDDING_INSTRUCTION.into(),
        revision: QWEN3_EMBEDDING_REVISION.into(),
        ann_index: if dimension == 0 {
            "none".into()
        } else {
            "instant-distance-hnsw-memory/sqlite-vectors".into()
        },
        reranker_model: QWEN3_RERANKER_MODEL.into(),
        reranker_revision: QWEN3_RERANKER_REVISION.into(),
        calibration_model: QWEN3_CALIBRATION_MODEL.into(),
        calibration_dimension: if calibration_dimension > 0 {
            calibration_dimension
        } else {
            4_096
        },
        calibration_revision: QWEN3_CALIBRATION_REVISION.into(),
        calibration_status: calibration_status.into(),
        calibrated_pairs,
        mode: mode.into(),
        degraded,
        degraded_reason: degraded_reason.clone(),
    };
    let discarded_pairs = prune_pairs_for_relation_judge(&mut pairs);
    save_retrieval_profile_at(
        path,
        IntelligenceSaveRetrievalProfileRequest {
            embedding_model: profile.embedding_model.clone(),
            dimension: profile.dimension.max(1),
            instruction: profile.instruction.clone(),
            revision: profile.revision.clone(),
            calibration_embedding_model: Some(profile.calibration_model.clone()),
            calibration_dimension: Some(profile.calibration_dimension),
            calibration_revision: Some(profile.calibration_revision.clone()),
            calibration_status: Some(profile.calibration_status.clone()),
            calibrated_pairs: Some(profile.calibrated_pairs),
            reranker_model: Some(profile.reranker_model.clone()),
            reranker_revision: Some(profile.reranker_revision.clone()),
            mode: profile.mode.clone(),
            degraded,
        },
    )?;
    persist_recall_audit(path, &pairs, &history, discarded_pairs)?;
    Ok(IntelligencePipelineRecallResult {
        engine: if degraded {
            format!(
                "Qwen3 新闻召回（{}，降级：{}）",
                mode,
                degraded_reason.as_deref().unwrap_or("重排未完成")
            )
        } else if calibrated_pairs > 0 {
            format!(
                "Qwen3-Embedding-0.6B HNSW + 0.6B Reranker + 8B Embedding 边界校准（{calibrated_pairs} 对）"
            )
        } else {
            "Qwen3-Embedding-0.6B HNSW + Qwen3-Reranker-0.6B（本批无边界候选）".into()
        },
        engine_profile: profile,
        pairs,
        historical_candidates: history,
        degraded,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_upsert_articles(
    articles: Vec<IntelligenceArticleInput>,
) -> Result<IntelligenceStoreUpsertResult, String> {
    upsert_articles_at(
        &store_path()?,
        IntelligenceStoreUpsertArticlesRequest { articles },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_update_article_evidence(
    articles: Vec<IntelligenceArticleEvidenceInput>,
) -> Result<IntelligenceArticleEvidenceUpdateResult, String> {
    update_article_evidence_at(&store_path()?, articles)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_claim_triage(
    limit: Option<u32>,
    lease_owner: Option<String>,
    lease_seconds: Option<u32>,
) -> Result<IntelligenceStoreClaimTriageResult, String> {
    claim_triage_at(
        &store_path()?,
        IntelligenceStoreClaimTriageRequest {
            limit,
            lease_owner,
            lease_seconds,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_apply_triage(
    lease_owner: String,
    model_id: String,
    model_sha: Option<String>,
    prompt_version: String,
    decisions: Vec<IntelligenceTriageDecisionInput>,
) -> Result<IntelligenceStoreApplyTriageResult, String> {
    apply_triage_at(
        &store_path()?,
        IntelligenceStoreApplyTriageRequest {
            lease_owner,
            model_id,
            model_sha,
            prompt_version,
            decisions,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_triage_decisions(
    article_ids: Vec<String>,
) -> Result<IntelligenceStoreTriageDecisionsResult, String> {
    triage_decisions_at(
        &store_path()?,
        IntelligenceStoreTriageDecisionsRequest { article_ids },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_upsert_relations(
    relations: Vec<IntelligenceRelationInput>,
) -> Result<IntelligenceStoreWriteResult, String> {
    upsert_relations_at(
        &store_path()?,
        IntelligenceStoreUpsertRelationsRequest { relations },
    )
}

#[tauri::command(rename_all = "camelCase")]
#[expect(
    clippy::too_many_arguments,
    reason = "This is the stable flat Tauri invoke shape used by the existing desktop UI; values are immediately grouped into the validated request object."
)]
pub(crate) fn intelligence_store_upsert_event(
    event_id: Option<String>,
    series_id: Option<String>,
    title: String,
    summary: Option<String>,
    importance: Option<f64>,
    occurred_at: Option<String>,
    article_ids: Vec<String>,
    revision_body: Option<String>,
    revision_json: Option<Value>,
) -> Result<IntelligenceEventProjection, String> {
    intelligence_store_upsert_event_request(IntelligenceStoreUpsertEventRequest {
        event_id,
        series_id,
        title,
        summary,
        importance,
        occurred_at,
        article_ids,
        revision_body,
        revision_json,
    })
}

fn intelligence_store_upsert_event_request(
    request: IntelligenceStoreUpsertEventRequest,
) -> Result<IntelligenceEventProjection, String> {
    upsert_event_at(&store_path()?, request)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_event_get(
    event_id: String,
    revision: Option<u64>,
) -> Result<Option<IntelligenceEventProjection>, String> {
    let event_id = required(&event_id, "事件 ID", 200)?;
    event_projection_at_revision(&open_store()?, &event_id, revision)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_event_sources(
    event_id: String,
    cursor: Option<u32>,
    limit: Option<u32>,
) -> Result<IntelligenceEventSourcesPage, String> {
    event_sources_page_at(&store_path()?, &event_id, cursor, limit)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_events_by_articles(
    article_ids: Vec<String>,
) -> Result<IntelligenceEventsByArticlesResult, String> {
    events_by_articles_at(
        &store_path()?,
        IntelligenceStoreEventsByArticlesRequest { article_ids },
    )
}

/// Explicit projection alias used by the resumable pipeline.  Unchanged
/// articles can skip recall and model judgement when this returns a stable
/// event id; changed fingerprints have already had their old mapping removed
/// by `upsert_articles_at`.
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_event_projections(
    article_ids: Vec<String>,
) -> Result<IntelligenceEventsByArticlesResult, String> {
    events_by_articles_at(
        &store_path()?,
        IntelligenceStoreEventsByArticlesRequest { article_ids },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_upsert_series(
    series_id: Option<String>,
    title: String,
    summary: Option<String>,
    event_ids: Vec<String>,
    event_relations: Option<Vec<IntelligenceSeriesEventRelationInput>>,
) -> Result<IntelligenceSeriesProjection, String> {
    upsert_series_at(
        &store_path()?,
        IntelligenceStoreUpsertSeriesRequest {
            series_id,
            title,
            summary,
            event_ids,
            event_relations: event_relations.unwrap_or_default(),
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_series_timeline(
    series_id: Option<String>,
    event_id: Option<String>,
) -> Result<Option<IntelligenceSeriesTimeline>, String> {
    series_timeline_at(
        &store_path()?,
        IntelligenceStoreSeriesTimelineRequest {
            series_id,
            event_id,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_record_quality_review(
    reviews: Vec<IntelligenceQualityReviewInput>,
) -> Result<IntelligenceReviewGateSummary, String> {
    record_reviews_at(
        &store_path()?,
        IntelligenceStoreRecordReviewsRequest { reviews },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_record_reviews(
    reviews: Vec<IntelligenceQualityReviewInput>,
) -> Result<IntelligenceReviewGateSummary, String> {
    record_reviews_at(
        &store_path()?,
        IntelligenceStoreRecordReviewsRequest { reviews },
    )
}

#[tauri::command]
pub(crate) fn intelligence_store_snapshot() -> Result<IntelligenceStoreSnapshot, String> {
    snapshot_at(&store_path()?)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_start_run(
    run_id: Option<String>,
) -> Result<IntelligencePipelineRunProjection, String> {
    start_pipeline_run_at(&store_path()?, run_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_finish_run(
    run_id: Option<String>,
    status: Option<String>,
) -> Result<IntelligencePipelineRunProjection, String> {
    finish_pipeline_run_at(&store_path()?, run_id, status)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_retrieval_profile_save(
    request: IntelligenceSaveRetrievalProfileRequest,
) -> Result<IntelligenceRetrievalProfile, String> {
    save_retrieval_profile_at(&store_path()?, request)
}

#[tauri::command]
pub(crate) fn intelligence_store_retrieval_profile_get(
) -> Result<Option<IntelligenceRetrievalProfile>, String> {
    retrieval_profile_from_connection(&open_store()?)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_audit_page(
    run_id: Option<String>,
    stage: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<IntelligenceStoreAuditPage, String> {
    let cursor = cursor
        .map(|value| value.parse::<i64>().map_err(|_| "审计游标无效".to_string()))
        .transpose()?;
    audit_page_at(
        &store_path()?,
        IntelligenceStoreAuditPageRequest {
            run_id,
            stage,
            cursor,
            limit,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_upsert_embeddings(
    embeddings: Vec<IntelligenceEmbeddingInput>,
) -> Result<IntelligenceStoreWriteResult, String> {
    upsert_embeddings_at(
        &store_path()?,
        IntelligenceStoreUpsertEmbeddingsRequest { embeddings },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_dense_search(
    embedding_model: String,
    dimension: u32,
    instruction: String,
    revision: String,
    vector: Vec<f32>,
    limit: Option<u32>,
    exclude_article_id: Option<String>,
) -> Result<Vec<IntelligenceRetrievalHit>, String> {
    ann_search_at(
        &store_path()?,
        &IntelligenceStoreDenseSearchRequest {
            embedding_model,
            dimension,
            instruction,
            revision,
            vector,
            limit,
            exclude_article_id,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn intelligence_store_sparse_search(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<IntelligenceRetrievalHit>, String> {
    sparse_search_at(
        &store_path()?,
        IntelligenceStoreSparseSearchRequest { query, limit },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn intelligence_pipeline_recall_relations(
    articles: Vec<IntelligencePipelineRecallArticle>,
    include_history: Option<bool>,
) -> Result<IntelligencePipelineRecallResult, String> {
    pipeline_recall_relations_at(&store_path()?, articles, include_history.unwrap_or(true)).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn intelligence_pipeline_judge_relations(
    state: tauri::State<'_, crate::AppState>,
    pairs: Vec<IntelligencePipelineJudgePair>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<IntelligencePipelineRelationJudgements, String> {
    if pairs.is_empty() || pairs.len() > PIPELINE_RECALL_MAX_PAIRS {
        return Err(format!(
            "关系判定候选数量必须在 1 到 {PIPELINE_RECALL_MAX_PAIRS} 对之间"
        ));
    }
    let base_url = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8081/v1".into());
    let model = model
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Qwen3-8B-Q4_K_M".into());
    let mut decisions = Vec::with_capacity(pairs.len());
    for chunk in pairs.chunks(super::MAX_INTELLIGENCE_EVENT_JUDGE_PAIRS) {
        let request = super::IntelligenceJudgeEventPairsRequest {
            pairs: chunk
                .iter()
                .map(|pair| super::IntelligenceEventPair {
                    id: pair.id.clone(),
                    left: bounded_pipeline_judge_candidate(&pair.left),
                    right: bounded_pipeline_judge_candidate(&pair.right),
                })
                .collect(),
            base_url: Some(base_url.clone()),
            model: Some(model.clone()),
        };
        let judged = super::intelligence_judge_event_pairs_inner(state.inner(), request).await?;
        let by_id = chunk
            .iter()
            .map(|pair| (pair.id.as_str(), pair))
            .collect::<HashMap<_, _>>();
        for decision in judged.decisions {
            let pair = by_id
                .get(decision.id.as_str())
                .ok_or("关系模型返回了请求外的 pair id")?;
            let proposed_relation = decision.relation.clone();
            let low_confidence = decision.confidence < 0.65
                && !matches!(decision.relation.as_str(), "unrelated" | "background");
            decisions.push(IntelligencePipelineRelationDecision {
                id: decision.id,
                relation: if low_confidence {
                    "unrelated".into()
                } else {
                    decision.relation
                },
                proposed_relation,
                confidence: decision.confidence,
                reason: if low_confidence {
                    format!("{}；置信度低于自动挂接阈值，保守保持独立", decision.reason)
                } else {
                    decision.reason
                },
                requires_qwen_review: decision.requires_qwen_review || low_confidence,
                left_article_id: pair.left.article_id.clone(),
                right_article_id: pair.right.article_id.clone(),
                left_event_id: pair.left.event_id.clone(),
                right_event_id: pair.right.event_id.clone(),
                left_series_id: pair.left.series_id.clone(),
                right_series_id: pair.right.series_id.clone(),
            });
        }
    }
    Ok(IntelligencePipelineRelationJudgements { model, decisions })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStore {
        path: std::path::PathBuf,
    }

    impl TestStore {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kunpeng-intelligence-store-{name}-{}.sqlite3",
                uuid::Uuid::new_v4()
            ));
            Self { path }
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(format!("{}-wal", self.path.display()));
            let _ = fs::remove_file(format!("{}-shm", self.path.display()));
        }
    }

    struct TestArchivePaths {
        root: PathBuf,
        legacy: PathBuf,
        archive: PathBuf,
    }

    impl TestArchivePaths {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "kunpeng-intelligence-archive-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            let legacy = root.join("cache").join(STORE_FILE);
            let archive = root
                .join("data")
                .join(ARCHIVE_DIRECTORY)
                .join(ARCHIVE_STORE_FILE);
            Self {
                root,
                legacy,
                archive,
            }
        }
    }

    impl Drop for TestArchivePaths {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn article(id: &str, fingerprint: &str, title: &str) -> IntelligenceArticleInput {
        IntelligenceArticleInput {
            article_id: id.into(),
            fingerprint: fingerprint.into(),
            url: Some(format!("https://example.com/{id}")),
            source_key: Some("test".into()),
            source_name: Some("Test News".into()),
            title: title.into(),
            summary: Some("共同事实与来源独有细节".into()),
            body: Some("这是用于本机测试的公开资讯正文。".into()),
            published_at: Some("2026-08-23T01:00:00Z".into()),
            language: Some("zh".into()),
            media_json: Some(serde_json::json!({"images": []})),
        }
    }

    fn seed_two(store: &TestStore) {
        upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![
                    article("a", "sha:a", "阿拉斯加雷达站附近坠机"),
                    article("b", "sha:b", "包机事故造成八人遇难"),
                ],
            },
        )
        .unwrap();
    }

    #[test]
    fn legacy_cache_database_is_migrated_to_the_permanent_archive_path() {
        let paths = TestArchivePaths::new("path-migration");
        upsert_articles_at(
            &paths.legacy,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("legacy", "sha:legacy", "旧档案")],
            },
        )
        .unwrap();

        migrate_legacy_store_if_needed(&paths.archive, Some(&paths.legacy)).unwrap();

        assert!(paths.archive.is_file());
        assert!(paths.legacy.is_file());
        let archive_count = open_store_at(&paths.archive)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM intelligence_articles", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(archive_count, 1);
    }

    #[test]
    fn repeating_legacy_migration_keeps_the_published_archive_authoritative() {
        let paths = TestArchivePaths::new("repeat-migration");
        upsert_articles_at(
            &paths.legacy,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("legacy", "sha:legacy", "旧档案")],
            },
        )
        .unwrap();
        migrate_legacy_store_if_needed(&paths.archive, Some(&paths.legacy)).unwrap();
        upsert_articles_at(
            &paths.archive,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("archive", "sha:archive", "新档案")],
            },
        )
        .unwrap();

        migrate_legacy_store_if_needed(&paths.archive, Some(&paths.legacy)).unwrap();

        let connection = open_store_at(&paths.archive).unwrap();
        let article_ids = connection
            .prepare("SELECT article_id FROM intelligence_articles ORDER BY article_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(article_ids, ["archive", "legacy"]);
    }

    #[test]
    fn legacy_database_remains_readable_after_archive_migration() {
        let paths = TestArchivePaths::new("legacy-readable");
        upsert_articles_at(
            &paths.legacy,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("legacy", "sha:legacy", "旧档案")],
            },
        )
        .unwrap();
        migrate_legacy_store_if_needed(&paths.archive, Some(&paths.legacy)).unwrap();

        let legacy_title =
            Connection::open_with_flags(&paths.legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
                .query_row(
                    "SELECT title FROM intelligence_articles WHERE article_id='legacy'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap();
        assert_eq!(legacy_title, "旧档案");
    }

    #[test]
    fn worker_queue_projection_is_content_free_and_claims_only_existing_work() {
        let missing = std::env::temp_dir().join(format!(
            "kunpeng-intelligence-worker-missing-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let idle = worker_queue_status_at(&missing).unwrap();
        assert!(!idle.archive_present);
        assert_eq!(idle.queued, 0);
        assert_eq!(
            worker_claim_one_at(&missing, "worker-test")
                .unwrap()
                .claimed,
            0
        );

        let store = TestStore::new("worker-claim");
        upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("queued", "sha:queued", "等待处理")],
            },
        )
        .unwrap();
        let before = worker_queue_status_at(&store.path).unwrap();
        assert!(before.archive_present);
        assert_eq!(before.queued, 1);
        let claim = worker_claim_one_at(&store.path, "worker-test").unwrap();
        assert_eq!(claim.claimed, 1);
        assert_eq!(claim.remaining, 0);
        let after = worker_queue_status_at(&store.path).unwrap();
        assert_eq!(after.queued, 0);
        assert_eq!(after.processing, 1);
        let serialized = serde_json::to_value(after).unwrap();
        assert!(serialized.get("title").is_none());
        assert!(serialized.get("body").is_none());
        assert!(serialized.get("url").is_none());
    }

    #[test]
    fn unchanged_articles_reuse_triage_and_changed_fingerprints_requeue() {
        let store = TestStore::new("triage-cache");
        seed_two(&store);
        let claim = claim_triage_at(
            &store.path,
            IntelligenceStoreClaimTriageRequest {
                limit: Some(2),
                lease_owner: Some("worker-a".into()),
                lease_seconds: None,
            },
        )
        .unwrap();
        assert_eq!(claim.articles.len(), 2);
        let decisions = claim
            .articles
            .iter()
            .map(|article| IntelligenceTriageDecisionInput {
                article_id: article.article_id.clone(),
                fingerprint: article.fingerprint.clone(),
                status: "keep".into(),
                importance: Some(90.0),
                confidence: Some(0.99),
                reason: Some("重大公共事件".into()),
                decision_json: Some(serde_json::json!({"subject": "plane"})),
            })
            .collect();
        let applied = apply_triage_at(
            &store.path,
            IntelligenceStoreApplyTriageRequest {
                lease_owner: "worker-a".into(),
                model_id: "qwen3-8b-instruct".into(),
                model_sha: Some("model-sha".into()),
                prompt_version: "triage-v1".into(),
                decisions,
            },
        )
        .unwrap();
        assert_eq!(applied.kept, 2);
        let audit = audit_page_at(
            &store.path,
            IntelligenceStoreAuditPageRequest {
                run_id: None,
                stage: "article-triage".into(),
                cursor: None,
                limit: Some(10),
            },
        )
        .unwrap();
        assert!(audit.items.iter().any(|item| {
            item.title == "阿拉斯加雷达站附近坠机"
                && item.meta.contains("qwen3-8b-instruct")
                && item.meta.contains("重大公共事件")
        }));

        let unchanged = upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("a", "sha:a", "阿拉斯加雷达站附近坠机")],
            },
        )
        .unwrap();
        assert_eq!(unchanged.unchanged, 1);
        assert_eq!(unchanged.queued, 0);

        let changed = upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("a", "sha:a2", "事故原因调查有新进展")],
            },
        )
        .unwrap();
        assert_eq!(changed.updated, 1);
        assert_eq!(changed.queued, 1);
    }

    #[test]
    fn evidence_enrichment_uses_record_guard_without_requeue_or_detach() {
        let store = TestStore::new("evidence-enrichment");
        seed_two(&store);
        let event = upsert_event_at(
            &store.path,
            IntelligenceStoreUpsertEventRequest {
                event_id: Some("event:evidence".into()),
                series_id: None,
                title: "证据更新测试".into(),
                summary: None,
                importance: Some(80.0),
                occurred_at: None,
                article_ids: vec!["a".into()],
                revision_body: Some("revision one".into()),
                revision_json: None,
            },
        )
        .unwrap();
        assert_eq!(event.revision, 1);
        let before_state = open_store_at(&store.path)
            .unwrap()
            .query_row(
                "SELECT triage_state FROM intelligence_articles WHERE article_id='a'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let updated = update_article_evidence_at(
            &store.path,
            vec![IntelligenceArticleEvidenceInput {
                article_id: "a".into(),
                record_fingerprint: "sha:a".into(),
                evidence_fingerprint: Some("evidence:v2".into()),
                body: Some("下载后的完整正文与媒体证据".into()),
                media_json: Some(serde_json::json!({"images": ["cached-image"]})),
            }],
        )
        .unwrap();
        assert_eq!(updated.updated, 1);
        assert_eq!(updated.applied_article_ids, ["a"]);
        let connection = open_store_at(&store.path).unwrap();
        let (after_state, evidence_fingerprint, body) = connection
            .query_row(
                "SELECT triage_state,evidence_fingerprint,body FROM intelligence_articles WHERE article_id='a'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .unwrap();
        assert_eq!(after_state, before_state);
        assert_eq!(evidence_fingerprint, "evidence:v2");
        assert_eq!(body, "下载后的完整正文与媒体证据");
        let projections = events_by_articles_at(
            &store.path,
            IntelligenceStoreEventsByArticlesRequest {
                article_ids: vec!["a".into()],
            },
        )
        .unwrap();
        assert_eq!(projections.projections[0].event_id, "event:evidence");

        let stale = update_article_evidence_at(
            &store.path,
            vec![IntelligenceArticleEvidenceInput {
                article_id: "a".into(),
                record_fingerprint: "sha:stale".into(),
                evidence_fingerprint: Some("evidence:wrong".into()),
                body: Some("不应写入".into()),
                media_json: None,
            }],
        )
        .unwrap();
        assert_eq!(stale.updated, 0);
        assert_eq!(stale.mismatched_article_ids, ["a"]);
        let body = connection
            .query_row(
                "SELECT body FROM intelligence_articles WHERE article_id='a'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(body, "下载后的完整正文与媒体证据");
    }

    #[test]
    fn event_revision_selection_and_source_append_preserve_stable_id() {
        let store = TestStore::new("revision-selection");
        seed_two(&store);
        let first = upsert_event_at(
            &store.path,
            IntelligenceStoreUpsertEventRequest {
                event_id: Some("event:stable".into()),
                series_id: None,
                title: "稳定事件".into(),
                summary: None,
                importance: Some(88.0),
                occurred_at: None,
                article_ids: vec!["a".into()],
                revision_body: Some("body1".into()),
                revision_json: Some(serde_json::json!({"version": 1})),
            },
        )
        .unwrap();
        assert_eq!(first.revision, 1);
        let second = upsert_event_at(
            &store.path,
            IntelligenceStoreUpsertEventRequest {
                event_id: Some("event:stable".into()),
                series_id: None,
                title: "稳定事件（更新）".into(),
                summary: None,
                importance: Some(90.0),
                occurred_at: None,
                article_ids: vec!["b".into()],
                revision_body: Some("body2".into()),
                revision_json: Some(serde_json::json!({"version": 2})),
            },
        )
        .unwrap();
        assert_eq!(second.event_id, "event:stable");
        assert_eq!(second.revision, 2);
        assert_eq!(second.article_ids, ["a", "b"]);
        let connection = open_store_at(&store.path).unwrap();
        let revision_one = event_projection_at_revision(&connection, "event:stable", Some(1))
            .unwrap()
            .unwrap();
        assert_eq!(revision_one.current_revision, 2);
        assert_eq!(revision_one.revision, 1);
        assert_eq!(revision_one.revision_body.as_deref(), Some("body1"));
        let latest = event_projection_at_revision(&connection, "event:stable", None)
            .unwrap()
            .unwrap();
        assert_eq!(latest.revision, 2);
        assert_eq!(latest.revision_body.as_deref(), Some("body2"));
        assert!(event_projection_at_revision(&connection, "event:stable", Some(3)).is_err());
        drop(connection);
        let metadata_only = upsert_event_at(
            &store.path,
            IntelligenceStoreUpsertEventRequest {
                event_id: Some("event:stable".into()),
                series_id: None,
                title: "稳定事件（仅投影更新）".into(),
                summary: Some("成员或摘要变化不能产生空正文修订".into()),
                importance: Some(91.0),
                occurred_at: None,
                article_ids: vec!["a".into(), "b".into()],
                revision_body: None,
                revision_json: Some(serde_json::json!({"projectionOnly": true})),
            },
        )
        .unwrap();
        assert_eq!(metadata_only.revision, 2);
        assert_eq!(metadata_only.revision_body.as_deref(), Some("body2"));
        let first_page = event_sources_page_at(&store.path, "event:stable", None, Some(1)).unwrap();
        assert_eq!(first_page.total, 2);
        assert_eq!(first_page.sources.len(), 1);
        assert_eq!(first_page.next_cursor, Some(1));
        assert!(first_page.sources[0].body.is_some());
        let second_page =
            event_sources_page_at(&store.path, "event:stable", first_page.next_cursor, Some(1))
                .unwrap();
        assert_eq!(second_page.sources.len(), 1);
        assert_eq!(second_page.next_cursor, None);
        assert_ne!(
            first_page.sources[0].article_id,
            second_page.sources[0].article_id
        );
    }

    #[test]
    fn series_upsert_is_incremental_and_keeps_older_timeline_events() {
        let store = TestStore::new("series-union");
        seed_two(&store);
        for (event_id, article_id) in [("event:one", "a"), ("event:two", "b")] {
            upsert_event_at(
                &store.path,
                IntelligenceStoreUpsertEventRequest {
                    event_id: Some(event_id.into()),
                    series_id: None,
                    title: event_id.into(),
                    summary: None,
                    importance: Some(70.0),
                    occurred_at: None,
                    article_ids: vec![article_id.into()],
                    revision_body: Some(format!("body:{event_id}")),
                    revision_json: None,
                },
            )
            .unwrap();
        }
        upsert_series_at(
            &store.path,
            IntelligenceStoreUpsertSeriesRequest {
                series_id: Some("series:incremental".into()),
                title: "长期系列".into(),
                summary: None,
                event_ids: vec!["event:one".into()],
                event_relations: Vec::new(),
            },
        )
        .unwrap();
        let second = upsert_series_at(
            &store.path,
            IntelligenceStoreUpsertSeriesRequest {
                series_id: Some("series:incremental".into()),
                title: "长期系列".into(),
                summary: None,
                event_ids: vec!["event:two".into()],
                event_relations: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(second.event_ids, ["event:one", "event:two"]);
    }

    #[test]
    fn batched_upsert_reports_queue_delta_not_repeated_global_total() {
        let store = TestStore::new("queue-delta");
        let first = upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("batch-a", "sha:a", "第一批")],
            },
        )
        .unwrap();
        let second = upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("batch-b", "sha:b", "第二批")],
            },
        )
        .unwrap();
        assert_eq!(first.queued, 1);
        assert_eq!(first.queue_total, 1);
        assert_eq!(second.queued, 1);
        assert_eq!(second.queue_total, 2);
    }

    #[test]
    fn transient_triage_failure_returns_to_retry_queue() {
        let store = TestStore::new("triage-retry");
        upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![article("retry", "sha:retry", "待重试文章")],
            },
        )
        .unwrap();
        let claim = claim_triage_at(
            &store.path,
            IntelligenceStoreClaimTriageRequest {
                limit: Some(1),
                lease_owner: Some("worker-retry".into()),
                lease_seconds: None,
            },
        )
        .unwrap();
        let result = apply_triage_at(
            &store.path,
            IntelligenceStoreApplyTriageRequest {
                lease_owner: claim.lease_owner,
                model_id: "qwen3-8b".into(),
                model_sha: None,
                prompt_version: "triage-v2".into(),
                decisions: vec![IntelligenceTriageDecisionInput {
                    article_id: "retry".into(),
                    fingerprint: "sha:retry".into(),
                    status: "failed".into(),
                    importance: None,
                    confidence: None,
                    reason: Some("transport timeout".into()),
                    decision_json: None,
                }],
            },
        )
        .unwrap();
        assert_eq!(result.failed, 1);
        let connection = open_store_at(&store.path).unwrap();
        let (state, attempts, retry_at) = connection
            .query_row(
                "SELECT triage_state,triage_attempts,next_retry_at FROM intelligence_articles WHERE article_id='retry'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, i64>(2)?)),
            )
            .unwrap();
        assert_eq!(state, "queued");
        assert_eq!(attempts, 1);
        assert!(retry_at > now_ms());
        connection
            .execute(
                "UPDATE intelligence_articles SET next_retry_at=0 WHERE article_id='retry'",
                [],
            )
            .unwrap();
        let retry = claim_triage_at(
            &store.path,
            IntelligenceStoreClaimTriageRequest {
                limit: Some(1),
                lease_owner: Some("worker-retry-2".into()),
                lease_seconds: None,
            },
        )
        .unwrap();
        assert_eq!(retry.articles[0].article_id, "retry");
    }

    #[test]
    fn recall_pair_keeps_query_orientation_while_id_is_canonical() {
        let query = IntelligencePipelineRecallArticle {
            article_id: "z-query".into(),
            title: "query".into(),
            summary: String::new(),
            published_at: String::new(),
        };
        let neighbor = IntelligencePipelineRecallArticle {
            article_id: "a-neighbor".into(),
            title: "neighbor".into(),
            summary: String::new(),
            published_at: String::new(),
        };
        let pair = recall_pair(query, neighbor, 0.7, "test");
        assert_eq!(pair.left_article_id, "z-query");
        assert_eq!(pair.right_article_id, "a-neighbor");
        assert_eq!(pair.id, pair_id("a-neighbor", "z-query"));
    }

    #[test]
    fn pipeline_relation_judge_bounds_oversized_public_candidate_fields() {
        let candidate = IntelligencePipelineJudgeCandidate {
            article_id: "article-long".into(),
            title: "超长关系候选标题".repeat(120),
            summary: "公开摘要".repeat(500),
            published_at: "2026-08-23T08:00:00Z-extra".repeat(20),
            source_names: vec!["超长公开来源".repeat(80); 8],
            url: "https://example.test/story".into(),
            fingerprint: "sha:long".into(),
            event_id: None,
            series_id: None,
        };
        let bounded = bounded_pipeline_judge_candidate(&candidate);
        assert_eq!(bounded.id, "article-long");
        assert!(bounded.title.len() <= super::super::MAX_INTELLIGENCE_BRIEF_TITLE_BYTES);
        assert!(bounded.summary.len() <= super::super::MAX_INTELLIGENCE_BRIEF_SUMMARY_BYTES);
        assert!(
            bounded.published_at.len() <= super::super::MAX_INTELLIGENCE_BRIEF_PUBLISHED_AT_BYTES
        );
        assert_eq!(
            bounded.source_names.len(),
            super::super::MAX_INTELLIGENCE_EVENT_JUDGE_SOURCE_NAMES
        );
        assert!(bounded
            .source_names
            .iter()
            .all(|name| { name.len() <= super::super::MAX_INTELLIGENCE_BRIEF_SOURCE_NAME_BYTES }));
        assert_eq!(bounded.url, candidate.url);
        assert_eq!(bounded.fingerprint, candidate.fingerprint);
    }

    #[test]
    fn relation_judge_candidates_are_fairly_capped_per_query_at_scale() {
        let mut pairs = Vec::new();
        for query_index in 0..500 {
            for neighbor_index in 0..12 {
                let query = IntelligencePipelineRecallArticle {
                    article_id: format!("query-{query_index:03}"),
                    title: format!("query {query_index}"),
                    summary: String::new(),
                    published_at: String::new(),
                };
                let neighbor = IntelligencePipelineRecallArticle {
                    article_id: format!("neighbor-{query_index:03}-{neighbor_index:02}"),
                    title: format!("neighbor {neighbor_index}"),
                    summary: String::new(),
                    published_at: String::new(),
                };
                pairs.push(recall_pair(
                    query,
                    neighbor,
                    0.95 - neighbor_index as f32 * 0.02,
                    "scale-test",
                ));
            }
        }
        let discarded = prune_pairs_for_relation_judge(&mut pairs);
        assert_eq!(pairs.len(), 500 * PIPELINE_JUDGE_TOP_K_PER_QUERY);
        assert_eq!(discarded, 500 * (12 - PIPELINE_JUDGE_TOP_K_PER_QUERY));
        let mut counts = HashMap::<String, usize>::new();
        for pair in pairs {
            *counts.entry(pair.left_article_id).or_default() += 1;
        }
        assert!(counts.values().all(|count| *count <= 3));
    }

    #[test]
    fn relations_events_series_and_audit_keep_units_separate() {
        let store = TestStore::new("event-series");
        seed_two(&store);
        upsert_relations_at(
            &store.path,
            IntelligenceStoreUpsertRelationsRequest {
                relations: vec![IntelligenceRelationInput {
                    left_article_id: "a".into(),
                    right_article_id: "b".into(),
                    relation: "same_event".into(),
                    confidence: Some(0.97),
                    stage: "relation-judge".into(),
                    model_id: Some("qwen3-8b-instruct".into()),
                    evidence_json: Some(serde_json::json!({"shared": ["location", "casualties"]})),
                }],
            },
        )
        .unwrap();
        let event = upsert_event_at(
            &store.path,
            IntelligenceStoreUpsertEventRequest {
                event_id: Some("event:plane".into()),
                series_id: None,
                title: "阿拉斯加包机事故".into(),
                summary: Some("多来源确认八人遇难".into()),
                importance: Some(92.0),
                occurred_at: Some("2026-08-22".into()),
                article_ids: vec!["a".into(), "b".into()],
                revision_body: Some("综合报道正文".into()),
                revision_json: Some(serde_json::json!({"deltas": []})),
            },
        )
        .unwrap();
        assert_eq!(event.current_revision, 1);
        let series = upsert_series_at(
            &store.path,
            IntelligenceStoreUpsertSeriesRequest {
                series_id: Some("series:plane".into()),
                title: "阿拉斯加航空安全".into(),
                summary: Some("事故及后续调查".into()),
                event_ids: vec![event.event_id.clone()],
                event_relations: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(series.event_ids, ["event:plane"]);
        let timeline = series_timeline_at(
            &store.path,
            IntelligenceStoreSeriesTimelineRequest {
                series_id: Some("series:plane".into()),
                event_id: None,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(timeline.events.len(), 1);
        let snapshot = snapshot_at(&store.path).unwrap();
        let pair_stage = snapshot
            .stages
            .iter()
            .find(|stage| stage.id == "relation-judge")
            .unwrap();
        assert_eq!(pair_stage.pairs, 1);
        assert_eq!(pair_stage.articles, 0);
        assert_eq!(pair_stage.status, "completed");
        let final_stage = snapshot
            .stages
            .iter()
            .find(|stage| stage.id == "final-events")
            .unwrap();
        assert_eq!(final_stage.events, 1);
        let series_stage = snapshot
            .stages
            .iter()
            .find(|stage| stage.id == "series-timeline")
            .unwrap();
        assert_eq!(series_stage.series, 1);
        assert_eq!(series_stage.status, "running");
        assert_eq!(series_stage.checkpoint_status.as_deref(), Some("started"));
        finish_pipeline_run_at(
            &store.path,
            Some(snapshot.run_id.clone()),
            Some("completed".into()),
        )
        .unwrap();
        let completed = snapshot_at(&store.path).unwrap();
        assert_eq!(
            completed
                .stages
                .iter()
                .find(|stage| stage.id == "series-timeline")
                .unwrap()
                .status,
            "completed"
        );
        assert_eq!(completed.run_status, "completed");
        assert_eq!(
            completed
                .stages
                .iter()
                .find(|stage| stage.id == "qwen-review")
                .unwrap()
                .status,
            "completed"
        );
    }

    #[test]
    fn failed_and_cancelled_runs_keep_explicit_terminal_stage_checkpoints() {
        let failed_store = TestStore::new("failed-stage-checkpoint");
        let failed_run_id = snapshot_at(&failed_store.path).unwrap().run_id;
        seed_two(&failed_store);
        upsert_relations_at(
            &failed_store.path,
            IntelligenceStoreUpsertRelationsRequest {
                relations: vec![IntelligenceRelationInput {
                    left_article_id: "a".into(),
                    right_article_id: "b".into(),
                    relation: "same_event".into(),
                    confidence: Some(0.91),
                    stage: "relation-judge".into(),
                    model_id: Some("qwen3-8b".into()),
                    evidence_json: None,
                }],
            },
        )
        .unwrap();
        finish_pipeline_run_at(
            &failed_store.path,
            Some(failed_run_id.clone()),
            Some("failed".into()),
        )
        .unwrap();
        // Opening the store for a read-only snapshot reruns the idempotent
        // schema guard. It must not make a terminal run look newer than its
        // actual finish operation.
        let terminal_updated_at = 1_234_567_i64;
        Connection::open(&failed_store.path)
            .unwrap()
            .execute(
                "UPDATE intelligence_pipeline_runs SET updated_at=?2 WHERE run_id=?1",
                params![failed_run_id, terminal_updated_at],
            )
            .unwrap();
        let failed = snapshot_at(&failed_store.path).unwrap();
        let persisted_updated_at = Connection::open(&failed_store.path)
            .unwrap()
            .query_row(
                "SELECT updated_at FROM intelligence_pipeline_runs WHERE run_id=?1",
                [&failed.run_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(persisted_updated_at, terminal_updated_at);
        assert_eq!(failed.run_status, "failed");
        assert_eq!(
            failed
                .stages
                .iter()
                .find(|stage| stage.id == "relation-judge")
                .unwrap()
                .status,
            "failed"
        );
        assert_eq!(
            failed
                .stages
                .iter()
                .find(|stage| stage.id == "relation-judge")
                .unwrap()
                .checkpoint_status
                .as_deref(),
            Some("failed")
        );
        assert_eq!(
            failed
                .stages
                .iter()
                .find(|stage| stage.id == "qwen-review")
                .unwrap()
                .status,
            "pending"
        );

        let cancelled_store = TestStore::new("cancelled-stage-checkpoint");
        let cancelled_run_id = snapshot_at(&cancelled_store.path).unwrap().run_id;
        finish_pipeline_run_at(
            &cancelled_store.path,
            Some(cancelled_run_id),
            Some("cancelled".into()),
        )
        .unwrap();
        let cancelled = snapshot_at(&cancelled_store.path).unwrap();
        assert_eq!(cancelled.run_status, "cancelled");
        assert_eq!(cancelled.stages[0].status, "warning");
        assert_eq!(
            cancelled.stages[0].checkpoint_status.as_deref(),
            Some("cancelled")
        );
        assert!(cancelled.stages[1..]
            .iter()
            .all(|stage| stage.status == "pending"));
    }

    #[test]
    fn timeline_separates_strict_background_from_future_progress_with_relation_metadata() {
        let store = TestStore::new("timeline-relations");
        upsert_articles_at(
            &store.path,
            IntelligenceStoreUpsertArticlesRequest {
                articles: vec![
                    article("a", "sha:a", "最初事件"),
                    article("b", "sha:b", "调查进展"),
                    article("c", "sha:c", "后续更正"),
                ],
            },
        )
        .unwrap();
        for (event_id, article_id, occurred_at) in [
            ("event:one", "a", "2026-08-20T08:00:00Z"),
            ("event:two", "b", "2026-08-21T08:00:00Z"),
            ("event:three", "c", "2026-08-22T08:00:00Z"),
        ] {
            upsert_event_at(
                &store.path,
                IntelligenceStoreUpsertEventRequest {
                    event_id: Some(event_id.into()),
                    series_id: None,
                    title: event_id.into(),
                    summary: Some(format!("summary:{event_id}")),
                    importance: Some(80.0),
                    occurred_at: Some(occurred_at.into()),
                    article_ids: vec![article_id.into()],
                    revision_body: Some(format!("body:{event_id}")),
                    revision_json: None,
                },
            )
            .unwrap();
        }
        upsert_series_at(
            &store.path,
            IntelligenceStoreUpsertSeriesRequest {
                series_id: Some("series:timeline".into()),
                title: "事件系列".into(),
                summary: Some("按时间推进".into()),
                event_ids: vec!["event:one".into(), "event:two".into(), "event:three".into()],
                event_relations: vec![
                    IntelligenceSeriesEventRelationInput {
                        event_id: "event:two".into(),
                        relative_to_event_id: Some("event:one".into()),
                        relation: "event_update".into(),
                        reason: Some("调查披露了新增事实".into()),
                        confidence: Some(0.94),
                    },
                    IntelligenceSeriesEventRelationInput {
                        event_id: "event:three".into(),
                        relative_to_event_id: Some("event:two".into()),
                        relation: "correction".into(),
                        reason: Some("官方更正早期数字".into()),
                        confidence: Some(0.97),
                    },
                ],
            },
        )
        .unwrap();
        let timeline = series_timeline_at(
            &store.path,
            IntelligenceStoreSeriesTimelineRequest {
                series_id: None,
                event_id: Some("event:two".into()),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(timeline.current_event_id.as_deref(), Some("event:two"));
        assert_eq!(timeline.events.len(), 3);
        assert_eq!(
            timeline
                .background
                .iter()
                .map(|event| event.event.event_id.as_str())
                .collect::<Vec<_>>(),
            ["event:one"]
        );
        assert_eq!(
            timeline
                .subsequent
                .iter()
                .map(|event| event.event.event_id.as_str())
                .collect::<Vec<_>>(),
            ["event:three"]
        );
        let current = timeline
            .events
            .iter()
            .find(|event| event.event.event_id == "event:two")
            .unwrap();
        assert_eq!(current.relation.as_deref(), Some("event_update"));
        assert_eq!(current.relation_label.as_deref(), Some("事件进展"));
        assert_eq!(
            current.relation_reason.as_deref(),
            Some("调查披露了新增事实")
        );
        assert_eq!(current.relation_confidence, Some(0.94));
        assert_eq!(current.relative_to_event_id.as_deref(), Some("event:one"));
        let json = serde_json::to_value(timeline).unwrap();
        assert_eq!(json["currentEventId"], "event:two");
        assert_eq!(json["background"][0]["eventId"], "event:one");
        assert_eq!(json["subsequent"][0]["eventId"], "event:three");
    }

    #[test]
    fn model_agnostic_vectors_and_sparse_search_report_real_mode() {
        let store = TestStore::new("retrieval");
        seed_two(&store);
        let before = snapshot_at(&store.path).unwrap();
        assert_eq!(before.retrieval_mode, "sparse_only");
        assert!(before.retrieval_degraded);
        let sparse = sparse_search_at(
            &store.path,
            IntelligenceStoreSparseSearchRequest {
                query: "阿拉斯加 坠机".into(),
                limit: Some(5),
            },
        )
        .unwrap();
        assert_eq!(sparse.first().map(|hit| hit.article_id.as_str()), Some("a"));
        upsert_embeddings_at(
            &store.path,
            IntelligenceStoreUpsertEmbeddingsRequest {
                embeddings: vec![
                    IntelligenceEmbeddingInput {
                        article_id: "a".into(),
                        fingerprint: "sha:a".into(),
                        embedding_model: "Qwen3-Embedding-0.6B".into(),
                        dimension: 3,
                        instruction: "Represent news for event retrieval".into(),
                        revision: "r1".into(),
                        vector: vec![1.0, 0.0, 0.0],
                    },
                    IntelligenceEmbeddingInput {
                        article_id: "b".into(),
                        fingerprint: "sha:b".into(),
                        embedding_model: "Qwen3-Embedding-0.6B".into(),
                        dimension: 3,
                        instruction: "Represent news for event retrieval".into(),
                        revision: "r1".into(),
                        vector: vec![0.9, 0.1, 0.0],
                    },
                ],
            },
        )
        .unwrap();
        let hits = dense_search_at(
            &store.path,
            IntelligenceStoreDenseSearchRequest {
                embedding_model: "Qwen3-Embedding-0.6B".into(),
                dimension: 3,
                instruction: "Represent news for event retrieval".into(),
                revision: "r1".into(),
                vector: vec![1.0, 0.0, 0.0],
                limit: Some(5),
                exclude_article_id: Some("a".into()),
            },
        )
        .unwrap();
        assert_eq!(hits.first().map(|hit| hit.article_id.as_str()), Some("b"));
        save_retrieval_profile_at(
            &store.path,
            IntelligenceSaveRetrievalProfileRequest {
                embedding_model: "Qwen3-Embedding-0.6B".into(),
                dimension: 3,
                instruction: "Represent news for event retrieval".into(),
                revision: "r1".into(),
                calibration_embedding_model: Some("Qwen3-Embedding-8B".into()),
                calibration_dimension: Some(3),
                calibration_revision: Some("r1".into()),
                calibration_status: Some("not_needed".into()),
                calibrated_pairs: Some(0),
                reranker_model: Some("Qwen3-Reranker-0.6B".into()),
                reranker_revision: Some("r1".into()),
                mode: "qwen3_dense_sparse_rerank".into(),
                degraded: false,
            },
        )
        .unwrap();
        let after = snapshot_at(&store.path).unwrap();
        assert_eq!(after.retrieval_mode, "qwen3_dense_sparse_rerank");
        assert!(!after.retrieval_degraded);
        assert_eq!(
            after
                .retrieval_profile
                .as_ref()
                .and_then(|profile| profile.reranker_model.as_deref()),
            Some("Qwen3-Reranker-0.6B")
        );
    }

    #[test]
    fn qwen_review_gate_requires_500_full_relations_and_stable_batches() {
        let store = TestStore::new("reviews");
        seed_two(&store);
        let review =
            |target_kind: &str, target_id: String, verdict: &str| IntelligenceQualityReviewInput {
                target_kind: target_kind.into(),
                target_id,
                sampled: true,
                verdict: verdict.into(),
                confidence: Some(0.99),
                model_id: "Qwen3.8-27B".into(),
                detail_json: None,
            };
        let mut first_batch = (0..200)
            .map(|index| review("relation_accuracy", format!("relation-{index}"), "correct"))
            .collect::<Vec<_>>();
        for target_kind in [
            "important_recall",
            "merge_precision",
            "false_merge",
            "json_compliance",
        ] {
            for index in 0..50 {
                let verdict = if target_kind == "false_merge" {
                    "no_false_merge"
                } else if target_kind == "json_compliance" {
                    "compliant"
                } else {
                    "correct"
                };
                first_batch.push(review(
                    target_kind,
                    format!("{target_kind}-{index}"),
                    verdict,
                ));
            }
        }
        let first = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: first_batch,
            },
        )
        .unwrap();
        assert_eq!(first.review_mode, "full");
        assert_eq!(first.full_relation_reviews_remaining, 300);
        assert!(!first.eligible_for_reduced_review);

        let second = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: (200..400)
                    .map(|index| {
                        review("relation_accuracy", format!("relation-{index}"), "correct")
                    })
                    .collect(),
            },
        )
        .unwrap();
        assert_eq!(second.full_relation_reviews_remaining, 100);
        assert_eq!(second.stable_relation_batches, 0);
        let third = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: (400..500)
                    .map(|index| {
                        review("relation_accuracy", format!("relation-{index}"), "correct")
                    })
                    .collect(),
            },
        )
        .unwrap();
        assert_eq!(third.full_relation_reviews_remaining, 0);
        assert_eq!(third.stable_relation_batches, 1);
        assert_eq!(third.review_mode, "full");
        let fourth = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: vec![review(
                    "relation_accuracy",
                    "relation-500".into(),
                    "correct",
                )],
            },
        )
        .unwrap();
        assert_eq!(fourth.stable_relation_batches, 2);
        let gate = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: vec![review(
                    "relation_accuracy",
                    "relation-501".into(),
                    "correct",
                )],
            },
        )
        .unwrap();
        assert_eq!(gate.accuracy, Some(1.0));
        assert_eq!(gate.minimum_samples, 500);
        assert_eq!(gate.json_compliance, Some(1.0));
        assert_eq!(gate.review_mode, "sample");
        assert!(gate.eligible_for_reduced_review);
        let page = audit_page_at(
            &store.path,
            IntelligenceStoreAuditPageRequest {
                run_id: None,
                stage: "qwen-review".into(),
                cursor: None,
                limit: Some(5),
            },
        )
        .unwrap();
        assert_eq!(page.items.len(), 5);
        assert!(page.total >= 700);
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn false_merge_and_sub_95_accuracy_reopen_full_review_epoch() {
        let store = TestStore::new("review-fallback");
        let review =
            |target_kind: &str, target_id: String, verdict: &str| IntelligenceQualityReviewInput {
                target_kind: target_kind.into(),
                target_id,
                sampled: true,
                verdict: verdict.into(),
                confidence: Some(0.99),
                model_id: "Qwen3.8-27B".into(),
                detail_json: None,
            };
        // Keep this setup deliberately compact: all prerequisites are durable,
        // then three relation batches promote the gate to sampled mode.
        let mut setup = (0..500)
            .map(|index| review("relation_accuracy", format!("relation-{index}"), "correct"))
            .collect::<Vec<_>>();
        for target_kind in [
            "important_recall",
            "merge_precision",
            "false_merge",
            "json_compliance",
        ] {
            for index in 0..50 {
                let verdict = if target_kind == "false_merge" {
                    "no_false_merge"
                } else if target_kind == "json_compliance" {
                    "compliant"
                } else {
                    "correct"
                };
                setup.push(review(
                    target_kind,
                    format!("{target_kind}-{index}"),
                    verdict,
                ));
            }
        }
        for chunk in setup.chunks(MAX_REVIEWS_PER_BATCH) {
            record_reviews_at(
                &store.path,
                IntelligenceStoreRecordReviewsRequest {
                    reviews: chunk.to_vec(),
                },
            )
            .unwrap();
        }
        // The first 500 happened before the supporting metrics were written;
        // add three fresh, independently reviewed batches to prove stability.
        for index in 500..503 {
            record_reviews_at(
                &store.path,
                IntelligenceStoreRecordReviewsRequest {
                    reviews: vec![review(
                        "relation_accuracy",
                        format!("relation-{index}"),
                        "correct",
                    )],
                },
            )
            .unwrap();
        }
        assert_eq!(
            review_gate(&open_store_at(&store.path).unwrap())
                .unwrap()
                .review_mode,
            "sample"
        );

        let false_merge = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: vec![review(
                    "false_merge",
                    "false-merge-critical".into(),
                    "false_merge",
                )],
            },
        )
        .unwrap();
        assert_eq!(false_merge.review_mode, "full");
        assert_eq!(false_merge.review_epoch, 1);
        assert_eq!(false_merge.last_transition_reason, "false_merge_detected");
        assert_eq!(false_merge.full_relation_reviews_remaining, 500);

        // Rebuild a clean qualifying epoch, then an ordinary relation accuracy
        // collapse below 95% must also force a fresh full-review epoch.
        let mut clean = (0..500)
            .map(|index| {
                review(
                    "relation_accuracy",
                    format!("clean-relation-{index}"),
                    "correct",
                )
            })
            .collect::<Vec<_>>();
        for target_kind in [
            "important_recall",
            "merge_precision",
            "false_merge",
            "json_compliance",
        ] {
            for index in 0..50 {
                let verdict = if target_kind == "false_merge" {
                    "no_false_merge"
                } else if target_kind == "json_compliance" {
                    "compliant"
                } else {
                    "correct"
                };
                clean.push(review(
                    target_kind,
                    format!("clean-{target_kind}-{index}"),
                    verdict,
                ));
            }
        }
        for chunk in clean.chunks(MAX_REVIEWS_PER_BATCH) {
            record_reviews_at(
                &store.path,
                IntelligenceStoreRecordReviewsRequest {
                    reviews: chunk.to_vec(),
                },
            )
            .unwrap();
        }
        for index in 500..503 {
            record_reviews_at(
                &store.path,
                IntelligenceStoreRecordReviewsRequest {
                    reviews: vec![review(
                        "relation_accuracy",
                        format!("clean-relation-{index}"),
                        "correct",
                    )],
                },
            )
            .unwrap();
        }
        assert_eq!(
            review_gate(&open_store_at(&store.path).unwrap())
                .unwrap()
                .review_mode,
            "sample"
        );
        let low_accuracy = record_reviews_at(
            &store.path,
            IntelligenceStoreRecordReviewsRequest {
                reviews: (0..30)
                    .map(|index| {
                        review(
                            "relation_accuracy",
                            format!("clean-bad-{index}"),
                            "incorrect",
                        )
                    })
                    .collect(),
            },
        )
        .unwrap();
        assert_eq!(low_accuracy.review_mode, "full");
        assert_eq!(low_accuracy.review_epoch, 2);
        assert_eq!(
            low_accuracy.last_transition_reason,
            "relation_accuracy_below_95"
        );
    }
}
