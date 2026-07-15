use crate::sync_core::{decide_sync_merge, MergeDecision, SyncMeta};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DB_SCHEMA_VERSION: i64 = 3;
const WAL_AUTOCHECKPOINT_PAGES: i64 = 1_000;
const WAL_JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

pub(crate) const SUPPORTED_ENTITY_KINDS: &[&str] = &["book_state_v2", "vocab", "reading_bucket_v2"];

pub(crate) fn is_supported_entity_kind(kind: &str) -> bool {
    SUPPORTED_ENTITY_KINDS.contains(&kind)
}

type CoreEntityRow = (String, String, String, i64, i64, String, i64, i64);

#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreSnapshot {
    metadata: Vec<(String, String)>,
    entities: Vec<CoreEntityRow>,
}

pub struct AppDb {
    conn: Connection,
    device_id: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncEntity {
    pub kind: String,
    pub id: String,
    pub json: Value,
    pub updated_at: i64,
    #[serde(default, deserialize_with = "deserialize_nullable_i64")]
    pub deleted_at: i64,
    pub device_id: String,
    pub sync_version: i64,
}

fn deserialize_nullable_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<i64>::deserialize(deserializer)?.unwrap_or(0))
}

struct IncomingEntity<'a> {
    kind: &'a str,
    id: &'a str,
    json_text: &'a str,
    updated_at: i64,
    deleted_at: i64,
    device_id: &'a str,
    sync_version: i64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn core_schema_sql() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL DEFAULT 0,
        device_id TEXT NOT NULL,
        sync_version INTEGER NOT NULL DEFAULT 1,
        dirty INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_kind_updated
        ON entities(kind, updated_at);
    "#
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_size_limit", WAL_JOURNAL_SIZE_LIMIT)
        .map_err(|e| e.to_string())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| e.to_string())
}

fn load_core_snapshot(conn: &Connection) -> Result<CoreSnapshot, String> {
    let metadata = {
        let mut statement = conn
            .prepare("SELECT key,value FROM metadata ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let entities = {
        let mut statement = conn
            .prepare(
                "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty FROM entities ORDER BY kind,id",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(CoreSnapshot { metadata, entities })
}

fn write_core_snapshot(conn: &mut Connection, snapshot: &CoreSnapshot) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut metadata = transaction
            .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
            .map_err(|e| e.to_string())?;
        for (key, value) in &snapshot.metadata {
            metadata
                .execute(params![key, value])
                .map_err(|e| e.to_string())?;
        }
        let mut entities = transaction
            .prepare(
                "INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty) VALUES(?,?,?,?,?,?,?,?)",
            )
            .map_err(|e| e.to_string())?;
        for (kind, id, json, updated_at, deleted_at, device_id, sync_version, dirty) in
            &snapshot.entities
        {
            entities
                .execute(params![
                    kind,
                    id,
                    json,
                    updated_at,
                    deleted_at,
                    device_id,
                    sync_version,
                    dirty
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn migration_sibling(path: &Path, label: &str) -> PathBuf {
    let file = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("reader.db");
    path.with_file_name(format!(
        "{file}.{label}-{}-{}",
        now_secs(),
        std::process::id()
    ))
}

fn compact_legacy_database(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let source = Connection::open(path).map_err(|e| e.to_string())?;
    source
        .busy_timeout(Duration::from_secs(8))
        .map_err(|e| e.to_string())?;
    if !table_exists(&source, "keyword_postings")? && !table_exists(&source, "keyword_docs")? {
        return Ok(None);
    }
    let checkpoint = source
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    if checkpoint.0 != 0 {
        return Err(format!(
            "reader.db 仍被其他连接占用，WAL 检查点未完成：{checkpoint:?}"
        ));
    }
    let snapshot = load_core_snapshot(&source)?;
    let temporary = migration_sibling(path, "compacting");
    let backup = migration_sibling(path, "pre-v3");
    let mut target = Connection::open(&temporary).map_err(|e| e.to_string())?;
    target
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|e| e.to_string())?;
    target
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|e| e.to_string())?;
    target
        .execute_batch(core_schema_sql())
        .map_err(|e| e.to_string())?;
    write_core_snapshot(&mut target, &snapshot)?;
    target
        .pragma_update(None, "user_version", DB_SCHEMA_VERSION)
        .map_err(|e| e.to_string())?;
    let check: String = target
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("紧凑数据库完整性检查失败：{check}"));
    }
    let copied = load_core_snapshot(&target)?;
    if copied != snapshot {
        return Err("紧凑数据库的数据逐行校验失败".to_string());
    }
    target.close().map_err(|(_, error)| error.to_string())?;
    source.close().map_err(|(_, error)| error.to_string())?;

    std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    let mut moved_sidecars = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let from = sidecar_path(path, suffix);
        if !from.exists() {
            continue;
        }
        let to = sidecar_path(&backup, suffix);
        if let Err(error) = std::fs::rename(&from, &to) {
            for (moved_from, moved_to) in moved_sidecars.into_iter().rev() {
                let _ = std::fs::rename(moved_to, moved_from);
            }
            let _ = std::fs::rename(&backup, path);
            return Err(error.to_string());
        }
        moved_sidecars.push((from, to));
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        for (from, to) in moved_sidecars.into_iter().rev() {
            let _ = std::fs::rename(to, from);
        }
        let _ = std::fs::rename(&backup, path);
        return Err(error.to_string());
    }
    Ok(Some(backup))
}
fn db_path() -> Option<PathBuf> {
    #[cfg(target_os = "android")]
    {
        let mut d = PathBuf::from("/data/user/0/com.pigking.ebookreader/files/ebook-reader");
        d.push("reader.db");
        return Some(d);
    }
    #[cfg(not(target_os = "android"))]
    {
        let mut d = dirs::config_dir()?;
        d.push("ebook-reader");
        Some(d.join("reader.db"))
    }
}

fn new_device_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("dev-{}-{}", std::process::id(), ts)
}

impl AppDb {
    pub fn open() -> Result<Self, String> {
        let path = db_path().ok_or("无法确定数据库路径")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match compact_legacy_database(&path) {
            Ok(Some(backup)) => eprintln!(
                "reader.db 已完成紧凑迁移，旧数据库保留于 {}",
                backup.display()
            ),
            Ok(None) => {}
            Err(error) => eprintln!("reader.db 紧凑迁移已安全跳过：{error}"),
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        configure_connection(&conn)?;
        let mut db = Self {
            conn,
            device_id: String::new(),
        };
        db.init()?;
        db.device_id = db.ensure_device_id()?;
        Ok(db)
    }

    fn init(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch(core_schema_sql())
            .map_err(|e| e.to_string())?;
        let has_dirty = {
            let mut stmt = self
                .conn
                .prepare("PRAGMA table_info(entities)")
                .map_err(|e| e.to_string())?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            let mut found = false;
            for column in columns {
                if column.map_err(|e| e.to_string())? == "dirty" {
                    found = true;
                    break;
                }
            }
            found
        };
        if !has_dirty {
            self.conn
                .execute(
                    "ALTER TABLE entities ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        self.conn
            .pragma_update(None, "user_version", DB_SCHEMA_VERSION)
            .map_err(|e| e.to_string())
    }

    fn ensure_device_id(&self) -> Result<String, String> {
        if let Some(v) = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE key='device_id'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(v);
        }
        let id = new_device_id();
        self.conn
            .execute(
                "INSERT INTO metadata(key,value) VALUES('device_id',?)",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn device_id(&self) -> String {
        self.device_id.clone()
    }

    pub fn metadata(&self, key: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Create a transactionally consistent standalone database snapshot. The
    /// destination must not already exist; recovery points are assembled in a
    /// new temporary directory before being atomically renamed into place.
    pub fn backup_to(&self, path: &Path) -> Result<(), String> {
        if path.exists() {
            return Err(format!("备份目标已存在：{}", path.display()));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        self.conn
            .execute("VACUUM INTO ?1", params![path.to_string_lossy().as_ref()])
            .map_err(|e| format!("创建 SQLite 快照失败：{e}"))?;
        let snapshot = Connection::open(path).map_err(|e| e.to_string())?;
        let check: String = snapshot
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("SQLite 快照完整性检查失败：{check}"));
        }
        Ok(())
    }

    /// Remove superseded v1 entity rows after a recovery point has been made.
    pub fn purge_legacy_entities(&mut self) -> Result<u32, String> {
        self.conn
            .execute(
                "DELETE FROM entities WHERE kind NOT IN ('book_state_v2','vocab','reading_bucket_v2')",
                [],
            )
            .map(|count| count as u32)
            .map_err(|e| e.to_string())
    }

    pub fn upsert_json_batch(&mut self, items: &[(String, String, Value)]) -> Result<(), String> {
        let now = now_secs() as i64;
        let device_id = self.device_id.clone();
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut statement = transaction
                .prepare(
                    r#"
                    INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty)
                    VALUES(?,?,?,?,0,?,1,1)
                    ON CONFLICT(kind,id) DO UPDATE SET
                        json=excluded.json,
                        updated_at=excluded.updated_at,
                        deleted_at=0,
                        device_id=excluded.device_id,
                        sync_version=entities.sync_version+1,
                        dirty=1
                    WHERE entities.json <> excluded.json OR entities.deleted_at <> 0
                    "#,
                )
                .map_err(|e| e.to_string())?;
            for (kind, id, value) in items {
                let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
                statement
                    .execute(params![kind, id, json, now, device_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    #[allow(dead_code)]
    pub fn soft_delete(&self, kind: &str, id: &str) -> Result<(), String> {
        let now = now_secs() as i64;
        self.conn
            .execute(
                "UPDATE entities SET deleted_at=?, updated_at=?, device_id=?, sync_version=sync_version+1, dirty=1 WHERE kind=? AND id=?",
                params![now, now, self.device_id, kind, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn export_package(&self) -> Result<Value, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE kind IN ('book_state_v2','vocab','reading_bucket_v2') ORDER BY kind,id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let txt: String = r.get(2)?;
                let data: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
                Ok(json!({
                    "kind": r.get::<_, String>(0)?,
                    "id": r.get::<_, String>(1)?,
                    "data": data,
                    "updated_at": r.get::<_, i64>(3)?,
                    "deleted_at": r.get::<_, i64>(4)?,
                    "device_id": r.get::<_, String>(5)?,
                    "sync_version": r.get::<_, i64>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut entities = Vec::new();
        for row in rows {
            entities.push(row.map_err(|e| e.to_string())?);
        }
        Ok(json!({
            "format": "kunpeng-reader-data-package",
            "version": 2,
            "exported_at": now_secs(),
            "device_id": self.device_id,
            "entities": entities,
        }))
    }

    fn existing_sync_meta(
        conn: &Connection,
        kind: &str,
        id: &str,
    ) -> Result<Option<SyncMeta>, String> {
        conn.query_row(
            "SELECT updated_at, deleted_at, sync_version FROM entities WHERE kind=? AND id=?",
            params![kind, id],
            |r| {
                Ok(SyncMeta {
                    updated_at: r.get(0)?,
                    deleted_at: r.get(1)?,
                    sync_version: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    fn upsert_incoming_entity(
        conn: &Connection,
        item: &IncomingEntity<'_>,
    ) -> Result<bool, String> {
        let incoming = SyncMeta {
            updated_at: item.updated_at,
            deleted_at: item.deleted_at,
            sync_version: item.sync_version,
        };
        let existing = Self::existing_sync_meta(conn, item.kind, item.id)?;
        if decide_sync_merge(existing, incoming) == MergeDecision::KeepExisting {
            return Ok(false);
        }
        conn.execute(
            r#"
                INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty)
                VALUES(?,?,?,?,?,?,?,0)
                ON CONFLICT(kind,id) DO UPDATE SET
                    json=excluded.json,
                    updated_at=excluded.updated_at,
                    deleted_at=excluded.deleted_at,
                    device_id=excluded.device_id,
                    sync_version=excluded.sync_version,
                    dirty=0
                "#,
            params![
                item.kind,
                item.id,
                item.json_text,
                item.updated_at,
                item.deleted_at,
                item.device_id,
                item.sync_version
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn import_package(&mut self, value: &Value) -> Result<u32, String> {
        let Some(items) = value.get("entities").and_then(|v| v.as_array()) else {
            return Err("数据包缺少 entities".into());
        };
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut count = 0u32;
        for item in items {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !is_supported_entity_kind(kind) || id.is_empty() {
                continue;
            }
            let data = item
                .get("data")
                .or_else(|| item.get("json"))
                .cloned()
                .unwrap_or(Value::Null);
            let updated_at = item
                .get("updated_at")
                .and_then(|v| v.as_i64())
                .unwrap_or(now_secs() as i64);
            let deleted_at = item.get("deleted_at").and_then(|v| v.as_i64()).unwrap_or(0);
            let device_id = item
                .get("device_id")
                .and_then(|v| v.as_str())
                .unwrap_or(&self.device_id);
            let sync_version = item
                .get("sync_version")
                .and_then(|v| v.as_i64())
                .unwrap_or(1);
            let txt = serde_json::to_string(&data).map_err(|e| e.to_string())?;
            if Self::upsert_incoming_entity(
                &transaction,
                &IncomingEntity {
                    kind,
                    id,
                    json_text: &txt,
                    updated_at,
                    deleted_at,
                    device_id,
                    sync_version,
                },
            )? {
                count += 1;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(count)
    }
    pub fn all_sync_entities(&self) -> Result<Vec<SyncEntity>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE kind IN ('book_state_v2','vocab','reading_bucket_v2') ORDER BY kind,id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let txt: String = r.get(2)?;
                let data: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
                Ok(SyncEntity {
                    kind: r.get(0)?,
                    id: r.get(1)?,
                    json: data,
                    updated_at: r.get(3)?,
                    deleted_at: r.get(4)?,
                    device_id: r.get(5)?,
                    sync_version: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Only local changes are uploaded. V2 deliberately excludes full `book`
    /// rows because they contain machine-local paths and cover-cache paths.
    pub fn dirty_sync_entities(&self) -> Result<Vec<SyncEntity>, String> {
        self.sync_entities_where(
            "dirty=1 AND kind IN ('book_state_v2','vocab','reading_bucket_v2')",
        )
    }

    fn sync_entities_where(&self, predicate: &str) -> Result<Vec<SyncEntity>, String> {
        let sql = format!(
            "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE {predicate} ORDER BY kind,id"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let txt: String = r.get(2)?;
                let data: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
                Ok(SyncEntity {
                    kind: r.get(0)?,
                    id: r.get(1)?,
                    json: data,
                    updated_at: r.get(3)?,
                    deleted_at: r.get(4)?,
                    device_id: r.get(5)?,
                    sync_version: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn mark_sync_entities_clean(&mut self, items: &[SyncEntity]) -> Result<(), String> {
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = transaction
                .prepare(
                    "UPDATE entities SET dirty=0 WHERE kind=? AND id=? AND device_id=? AND sync_version=?",
                )
                .map_err(|e| e.to_string())?;
            for item in items {
                stmt.execute(params![
                    item.kind,
                    item.id,
                    item.device_id,
                    item.sync_version
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn entity_json(&self, kind: &str, id: &str) -> Result<Option<Value>, String> {
        let text = self
            .conn
            .query_row(
                "SELECT json FROM entities WHERE kind=? AND id=? AND deleted_at=0",
                params![kind, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        text.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            .transpose()
    }

    pub fn import_sync_entities(&mut self, items: &[SyncEntity]) -> Result<u32, String> {
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut count = 0u32;
        for item in items {
            if !is_supported_entity_kind(&item.kind) {
                continue;
            }
            let txt = serde_json::to_string(&item.json).map_err(|e| e.to_string())?;
            if Self::upsert_incoming_entity(
                &transaction,
                &IncomingEntity {
                    kind: &item.kind,
                    id: &item.id,
                    json_text: &txt,
                    updated_at: item.updated_at,
                    deleted_at: item.deleted_at,
                    device_id: &item.device_id,
                    sync_version: item.sync_version,
                },
            )? {
                count += 1;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> AppDb {
        let mut db = AppDb {
            conn: Connection::open_in_memory().unwrap(),
            device_id: "test-device".to_string(),
        };
        db.init().unwrap();
        db
    }

    #[test]
    fn schema_sets_user_version() {
        let db = memory_db();
        let version: i64 = db
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DB_SCHEMA_VERSION);
        assert!(!table_exists(&db.conn, "keyword_postings").unwrap());
        assert!(!table_exists(&db.conn, "keyword_docs").unwrap());
    }

    #[test]
    fn json_batch_rolls_back_every_row_on_failure() {
        let mut db = memory_db();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_bad_kind BEFORE INSERT ON entities
                 WHEN NEW.kind='bad' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
            )
            .unwrap();
        let batch = vec![
            ("book".to_string(), "1".to_string(), json!({"ok": true})),
            ("bad".to_string(), "2".to_string(), json!({"ok": false})),
        ];
        assert!(db.upsert_json_batch(&batch).is_err());
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM entities", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn unchanged_json_does_not_create_another_sync_version() {
        let mut db = memory_db();
        let row = vec![(
            "book_state_v2".to_string(),
            "sha".to_string(),
            json!({"progress": 12}),
        )];
        db.upsert_json_batch(&row).unwrap();
        let first = db.dirty_sync_entities().unwrap().remove(0);
        db.mark_sync_entities_clean(std::slice::from_ref(&first))
            .unwrap();
        db.upsert_json_batch(&row).unwrap();
        assert!(db.dirty_sync_entities().unwrap().is_empty());
    }

    #[test]
    fn package_and_sync_import_ignore_legacy_entity_kinds() {
        let mut db = memory_db();
        let package = json!({"entities": [
            {"kind":"book","id":"old","data":{"path":"C:/private.epub"}},
            {"kind":"vocab","id":"zh:词","data":{"word":"词"}}
        ]});
        assert_eq!(db.import_package(&package).unwrap(), 1);
        assert!(db.entity_json("book", "old").unwrap().is_none());
        assert!(db.entity_json("vocab", "zh:词").unwrap().is_some());

        let legacy = SyncEntity {
            kind: "reading_bucket".into(),
            id: "old".into(),
            json: json!({}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "remote".into(),
            sync_version: 1,
        };
        assert_eq!(db.import_sync_entities(&[legacy]).unwrap(), 0);
    }

    #[test]
    fn purge_legacy_entities_and_backup_preserve_supported_rows() {
        let mut db = memory_db();
        db.upsert_json_batch(&[
            ("book".into(), "old".into(), json!({"path":"local"})),
            ("book_state_v2".into(), "sha".into(), json!({"progress":42})),
        ])
        .unwrap();
        assert_eq!(db.purge_legacy_entities().unwrap(), 1);

        let path = std::env::temp_dir().join(format!(
            "ebook-reader-recovery-test-{}-{}.db",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_file(&path);
        db.backup_to(&path).unwrap();
        let copy = Connection::open(&path).unwrap();
        assert_eq!(
            copy.query_row("SELECT COUNT(*) FROM entities", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        copy.close().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_keyword_database_is_compacted_without_losing_core_rows() {
        let path = std::env::temp_dir().join(format!(
            "ebook-reader-db-v3-test-{}-{}.db",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_file(&path);
        let source = Connection::open(&path).unwrap();
        source.execute_batch(core_schema_sql()).unwrap();
        source
            .execute_batch(
                r#"
                CREATE TABLE keyword_postings (
                    term TEXT NOT NULL,
                    book_id INTEGER NOT NULL,
                    chapter INTEGER NOT NULL,
                    count INTEGER NOT NULL,
                    snippets_json TEXT NOT NULL,
                    PRIMARY KEY(term, book_id, chapter)
                );
                CREATE TABLE keyword_docs (
                    book_id INTEGER NOT NULL,
                    chapter INTEGER NOT NULL,
                    length INTEGER NOT NULL,
                    PRIMARY KEY(book_id, chapter)
                );
                INSERT INTO metadata(key,value) VALUES('device_id','device-1');
                INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty)
                    VALUES('book_state_v2','sha','{"progress":12}',10,0,'device-1',7,1);
                INSERT INTO keyword_docs(book_id,chapter,length) VALUES(1,0,100);
                INSERT INTO keyword_postings(term,book_id,chapter,count,snippets_json)
                    VALUES('南明',1,0,2,'["片段"]');
                PRAGMA user_version=2;
                "#,
            )
            .unwrap();
        source.close().unwrap();

        let backup = compact_legacy_database(&path).unwrap().unwrap();
        let compacted = Connection::open(&path).unwrap();
        assert_eq!(
            compacted
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            DB_SCHEMA_VERSION
        );
        assert!(!table_exists(&compacted, "keyword_postings").unwrap());
        assert!(!table_exists(&compacted, "keyword_docs").unwrap());
        assert_eq!(
            compacted
                .query_row(
                    "SELECT json FROM entities WHERE kind='book_state_v2'",
                    [],
                    |row| { row.get::<_, String>(0) }
                )
                .unwrap(),
            "{\"progress\":12}"
        );
        assert_eq!(
            compacted
                .query_row(
                    "SELECT value FROM metadata WHERE key='device_id'",
                    [],
                    |row| { row.get::<_, String>(0) }
                )
                .unwrap(),
            "device-1"
        );
        compacted.close().unwrap();
        let original = Connection::open(&backup).unwrap();
        assert!(table_exists(&original, "keyword_postings").unwrap());
        original.close().unwrap();

        for file in [
            path.clone(),
            sidecar_path(&path, "-wal"),
            sidecar_path(&path, "-shm"),
            backup.clone(),
            sidecar_path(&backup, "-wal"),
            sidecar_path(&backup, "-shm"),
        ] {
            let _ = std::fs::remove_file(file);
        }
    }
}
