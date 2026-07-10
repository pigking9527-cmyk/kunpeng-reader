use crate::sync_core::{decide_sync_merge, MergeDecision, SyncMeta};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

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
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
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
            .execute_batch(
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
                CREATE TABLE IF NOT EXISTS keyword_postings (
                    term TEXT NOT NULL,
                    book_id INTEGER NOT NULL,
                    chapter INTEGER NOT NULL,
                    count INTEGER NOT NULL,
                    snippets_json TEXT NOT NULL,
                    PRIMARY KEY(term, book_id, chapter)
                );
                CREATE INDEX IF NOT EXISTS idx_keyword_postings_term
                    ON keyword_postings(term);
                CREATE TABLE IF NOT EXISTS keyword_docs (
                    book_id INTEGER NOT NULL,
                    chapter INTEGER NOT NULL,
                    length INTEGER NOT NULL,
                    PRIMARY KEY(book_id, chapter)
                );
                CREATE INDEX IF NOT EXISTS idx_keyword_docs_book
                    ON keyword_docs(book_id);
                "#,
            )
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
            .pragma_update(None, "user_version", 2)
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
            .prepare("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities ORDER BY kind,id")
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
            "version": 1,
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
            if kind.is_empty() || id.is_empty() {
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
            .prepare("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities ORDER BY kind,id")
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
    pub fn has_keyword_index_for_book(&self, book_id: u64) -> bool {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM keyword_postings WHERE book_id=? LIMIT 1)",
                params![book_id as i64],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(false)
    }

    pub fn clear_keyword_index_for_book(&self, book_id: u64) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM keyword_postings WHERE book_id=?",
                params![book_id as i64],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM keyword_docs WHERE book_id=?",
                params![book_id as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn has_keyword_doc_for_book(&self, book_id: u64) -> bool {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM keyword_docs WHERE book_id=? LIMIT 1)",
                params![book_id as i64],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(false)
    }

    pub fn upsert_keyword_doc(
        &self,
        book_id: u64,
        chapter: u32,
        length: u32,
    ) -> Result<(), String> {
        self.conn
            .execute(
                r#"
                INSERT INTO keyword_docs(book_id,chapter,length)
                VALUES(?,?,?)
                ON CONFLICT(book_id,chapter) DO UPDATE SET
                    length=excluded.length
                "#,
                params![book_id as i64, chapter as i64, length as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_keyword_posting(
        &self,
        term: &str,
        book_id: u64,
        chapter: u32,
        count: u32,
        snippets: &[String],
    ) -> Result<(), String> {
        let txt = serde_json::to_string(snippets).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO keyword_postings(term,book_id,chapter,count,snippets_json)
                VALUES(?,?,?,?,?)
                ON CONFLICT(term,book_id,chapter) DO UPDATE SET
                    count=excluded.count,
                    snippets_json=excluded.snippets_json
                "#,
                params![term, book_id as i64, chapter as i64, count as i64, txt],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
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
        assert_eq!(version, 2);
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
}
