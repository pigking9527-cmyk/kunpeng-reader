use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct AppDb {
    conn: Connection,
    device_id: String,
}

#[derive(Clone, serde::Serialize)]
pub struct DbSearchHit {
    pub book_id: u64,
    pub chapter: u32,
    pub count: u32,
    pub snippets: Vec<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncEntity {
    pub kind: String,
    pub id: String,
    pub json: Value,
    pub updated_at: i64,
    pub deleted_at: i64,
    pub device_id: String,
    pub sync_version: i64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn db_path() -> Option<PathBuf> {
    let mut d = dirs::config_dir()?;
    d.push("ebook-reader");
    Some(d.join("reader.db"))
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
        let mut db = Self { conn, device_id: String::new() };
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
                "#,
            )
            .map_err(|e| e.to_string())
    }

    fn ensure_device_id(&self) -> Result<String, String> {
        if let Some(v) = self
            .conn
            .query_row("SELECT value FROM metadata WHERE key='device_id'", [], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(v);
        }
        let id = new_device_id();
        self.conn
            .execute("INSERT INTO metadata(key,value) VALUES('device_id',?)", params![id])
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn device_id(&self) -> String {
        self.device_id.clone()
    }

    pub fn metadata(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM metadata WHERE key=?", params![key], |r| r.get::<_, String>(0))
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

    pub fn upsert_json(&self, kind: &str, id: &str, value: &Value) -> Result<(), String> {
        let now = now_secs() as i64;
        let txt = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version)
                VALUES(?,?,?,?,0,?,1)
                ON CONFLICT(kind,id) DO UPDATE SET
                    json=excluded.json,
                    updated_at=excluded.updated_at,
                    deleted_at=0,
                    device_id=excluded.device_id,
                    sync_version=entities.sync_version+1
                "#,
                params![kind, id, txt, now, self.device_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn soft_delete(&self, kind: &str, id: &str) -> Result<(), String> {
        let now = now_secs() as i64;
        self.conn
            .execute(
                "UPDATE entities SET deleted_at=?, updated_at=?, device_id=?, sync_version=sync_version+1 WHERE kind=? AND id=?",
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

    pub fn import_package(&self, value: &Value) -> Result<u32, String> {
        let Some(items) = value.get("entities").and_then(|v| v.as_array()) else {
            return Err("数据包缺少 entities".into());
        };
        let mut count = 0u32;
        for item in items {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if kind.is_empty() || id.is_empty() {
                continue;
            }
            let data = item.get("data").or_else(|| item.get("json")).cloned().unwrap_or(Value::Null);
            let updated_at = item.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(now_secs() as i64);
            let deleted_at = item.get("deleted_at").and_then(|v| v.as_i64()).unwrap_or(0);
            let device_id = item.get("device_id").and_then(|v| v.as_str()).unwrap_or(&self.device_id);
            let sync_version = item.get("sync_version").and_then(|v| v.as_i64()).unwrap_or(1);
            let txt = serde_json::to_string(&data).map_err(|e| e.to_string())?;
            self.conn
                .execute(
                    r#"
                    INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(kind,id) DO UPDATE SET
                        json=CASE WHEN excluded.updated_at >= entities.updated_at THEN excluded.json ELSE entities.json END,
                        updated_at=MAX(entities.updated_at, excluded.updated_at),
                        deleted_at=CASE WHEN excluded.updated_at >= entities.updated_at THEN excluded.deleted_at ELSE entities.deleted_at END,
                        device_id=CASE WHEN excluded.updated_at >= entities.updated_at THEN excluded.device_id ELSE entities.device_id END,
                        sync_version=MAX(entities.sync_version, excluded.sync_version)
                    "#,
                    params![kind, id, txt, updated_at, deleted_at, device_id, sync_version],
                )
                .map_err(|e| e.to_string())?;
            count += 1;
        }
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

    pub fn import_sync_entities(&self, items: &[SyncEntity]) -> Result<u32, String> {
        let mut count = 0u32;
        for item in items {
            let txt = serde_json::to_string(&item.json).map_err(|e| e.to_string())?;
            self.conn
                .execute(
                    r#"
                    INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(kind,id) DO UPDATE SET
                        json=CASE
                          WHEN excluded.updated_at > entities.updated_at
                            OR (excluded.updated_at = entities.updated_at AND excluded.sync_version >= entities.sync_version)
                          THEN excluded.json ELSE entities.json END,
                        updated_at=MAX(entities.updated_at, excluded.updated_at),
                        deleted_at=CASE
                          WHEN excluded.updated_at > entities.updated_at
                            OR (excluded.updated_at = entities.updated_at AND excluded.sync_version >= entities.sync_version)
                          THEN excluded.deleted_at ELSE entities.deleted_at END,
                        device_id=CASE
                          WHEN excluded.updated_at > entities.updated_at
                            OR (excluded.updated_at = entities.updated_at AND excluded.sync_version >= entities.sync_version)
                          THEN excluded.device_id ELSE entities.device_id END,
                        sync_version=MAX(entities.sync_version, excluded.sync_version)
                    "#,
                    params![
                        item.kind,
                        item.id,
                        txt,
                        item.updated_at,
                        item.deleted_at,
                        item.device_id,
                        item.sync_version
                    ],
                )
                .map_err(|e| e.to_string())?;
            count += 1;
        }
        Ok(count)
    }

    pub fn clear_keyword_index(&mut self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM keyword_postings", [])
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

    pub fn keyword_search(&self, term: &str, ids: Option<&std::collections::HashSet<u64>>) -> Result<Vec<DbSearchHit>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT book_id,chapter,count,snippets_json FROM keyword_postings WHERE term=?")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![term], |r| {
                let txt: String = r.get(3)?;
                let snippets: Vec<String> = serde_json::from_str(&txt).unwrap_or_default();
                Ok(DbSearchHit {
                    book_id: r.get::<_, i64>(0)? as u64,
                    chapter: r.get::<_, i64>(1)? as u32,
                    count: r.get::<_, i64>(2)? as u32,
                    snippets,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let hit = row.map_err(|e| e.to_string())?;
            if ids.map(|set| set.contains(&hit.book_id)).unwrap_or(true) {
                out.push(hit);
            }
        }
        Ok(out)
    }

    pub fn has_keyword_index(&self) -> bool {
        self.conn
            .query_row("SELECT EXISTS(SELECT 1 FROM keyword_postings LIMIT 1)", [], |r| r.get::<_, i64>(0))
            .map(|v| v != 0)
            .unwrap_or(false)
    }
}
