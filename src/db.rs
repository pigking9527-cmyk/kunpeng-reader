use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;

mod backup_port;
mod entities;
mod metadata;
mod migration;
mod portable_package;
mod schema;
use entities::IncomingEntity;
pub use entities::SyncEntity;
pub(crate) use metadata::SYNC_IDENTITY_VERIFIED_SCOPE_KEY;
use migration::compact_legacy_database;
#[cfg(test)]
use migration::{sidecar_path, table_exists_for_tests};
#[cfg(test)]
use portable_package::CORE_PACKAGE_ENTITY_KINDS;
pub(crate) use portable_package::MAX_CORE_PACKAGE_BYTES;
use portable_package::{validate_core_package, CORE_PACKAGE_FORMAT, CORE_PACKAGE_VERSION};
#[cfg(test)]
use schema::DB_SCHEMA_VERSION;
const SLOW_DB_OPERATION_MS: u128 = 250;

fn log_db_operation(operation: &str, started: Instant, rows: usize) {
    let elapsed_ms = started.elapsed().as_millis();
    let elapsed_ms_u64 = u64::try_from(elapsed_ms).unwrap_or(u64::MAX);
    crate::diagnostics::record_db_sql_operation(operation, elapsed_ms_u64, rows as u64);
    if elapsed_ms >= SLOW_DB_OPERATION_MS {
        crate::log(&format!(
            "[db] slow_operation={operation} elapsed_ms={elapsed_ms} rows={rows}"
        ));
    }
}

pub(crate) const SUPPORTED_ENTITY_KINDS: &[&str] = &[
    "book_state_v2",
    "reading_progress_v1",
    "reading_data_v1",
    "reading_statistics_v1",
    "model_book_tags_v1",
    "user_book_tags_v1",
    "book_collections_v1",
    "booklist_v1",
    "vocab",
    "reading_bucket_v2",
    "ai_reader_config_v1",
    "translation_config_v1",
    "ai_reader_history_v1",
    "ai_reader_history_entry_v2",
    "secret_bundle_v1",
    "reader_palette_v1",
    "reader_palette_order_v1",
    "app_settings_v1",
];

pub(crate) fn is_supported_entity_kind(kind: &str) -> bool {
    SUPPORTED_ENTITY_KINDS.contains(&kind)
}

pub struct AppDb {
    conn: Connection,
    device_id: String,
}

#[cfg(test)]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sync entity timestamps use Unix milliseconds, matching the server's
/// `server_updated_at` clock.  Do not use the second-based timestamps used by
/// legacy library metadata here: a newly encrypted local secret bundle must
/// be newer than an existing server tombstone during the pull-before-push
/// phase of synchronization.
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(crate) fn database_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let mut d = PathBuf::from("/data/user/0/com.kunpeng.reader/files/ebook-reader");
        d.push("reader.db");
        return Ok(d);
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(crate::profile::app_config_dir()
            .ok_or("无法确定应用配置目录")?
            .join("reader.db"))
    }
}

impl AppDb {
    #[cfg(test)]
    pub(crate) fn open_in_memory_for_tests() -> Self {
        let mut database = Self {
            conn: Connection::open_in_memory().expect("open in-memory SQLite database"),
            device_id: "test-device".to_string(),
        };
        database
            .init()
            .expect("initialize in-memory SQLite database");
        database
    }

    pub fn open() -> Result<Self, String> {
        let path = database_path()?;
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
        Self::initialize_connection(conn)
    }

    /// Open and validate an already-existing database without SQLite's
    /// CREATE flag. Recovery failures must use this path so a missing live
    /// reader.db can never be replaced by a deceptively empty database.
    pub fn open_existing() -> Result<Self, String> {
        let path = database_path()?;
        Self::open_existing_path(&path)
    }

    fn open_existing_path(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("恢复后的 reader.db 不可访问：{error}"))?;
        if !metadata.is_file() {
            return Err("恢复后的 reader.db 不是普通文件".into());
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|error| format!("打开现有 reader.db 失败：{error}"))?;
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|error| format!("检查现有 reader.db 失败：{error}"))?;
        if check != "ok" {
            return Err(format!("现有 reader.db 完整性检查失败：{check}"));
        }
        Self::initialize_connection(conn)
    }

    fn initialize_connection(conn: Connection) -> Result<Self, String> {
        schema::configure_connection(&conn)?;
        let mut db = Self {
            conn,
            device_id: String::new(),
        };
        db.init()?;
        db.device_id = db.ensure_device_id()?;
        Ok(db)
    }

    fn init(&mut self) -> Result<(), String> {
        schema::initialize_schema(&self.conn)
    }

    pub fn device_id(&self) -> String {
        self.device_id.clone()
    }

    pub fn upsert_json_batch(&mut self, items: &[(String, String, Value)]) -> Result<(), String> {
        let started = Instant::now();
        let now = now_millis();
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
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation("upsert_json_batch", started, items.len());
        Ok(())
    }

    #[allow(dead_code)]
    pub fn soft_delete(&self, kind: &str, id: &str) -> Result<(), String> {
        let started = Instant::now();
        let now = now_millis();
        let changed = self
            .conn
            .execute(
                "UPDATE entities SET deleted_at=?, updated_at=?, device_id=?, sync_version=sync_version+1, dirty=1 WHERE kind=? AND id=?",
                params![now, now, self.device_id, kind, id],
            )
            .map_err(|e| e.to_string())?;
        log_db_operation("soft_delete", started, changed);
        Ok(())
    }

    pub fn export_package(&self) -> Result<Value, String> {
        let started = Instant::now();
        let mut stmt = self
            .conn
            .prepare("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE kind IN ('reading_progress_v1','reading_data_v1','reading_statistics_v1','model_book_tags_v1','vocab','reading_bucket_v2') ORDER BY kind,id")
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
        let entity_count = entities.len();
        let package = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": now_millis(),
            "source_device_id": self.device_id,
            "entities": entities,
        });
        // Do not turn an old malformed local row into a portable data leak.
        // Validation also makes the exported representation self-consistent
        // with the import boundary below.
        let bytes = serde_json::to_vec(&package).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_CORE_PACKAGE_BYTES {
            return Err(format!(
                "核心数据包超过 {} MiB 上限",
                MAX_CORE_PACKAGE_BYTES / 1024 / 1024
            ));
        }
        validate_core_package(&package)?;
        log_db_operation("export_package", started, entity_count);
        Ok(package)
    }

    pub fn import_package(&mut self, value: &Value) -> Result<u32, String> {
        let started = Instant::now();
        let items = validate_core_package(value)?;
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut count = 0u32;
        for item in &items {
            if Self::upsert_incoming_entity(
                &transaction,
                &IncomingEntity {
                    kind: &item.kind,
                    id: &item.id,
                    json_text: &item.json_text,
                    updated_at: item.updated_at,
                    deleted_at: item.deleted_at,
                    device_id: &item.device_id,
                    sync_version: item.sync_version,
                },
                1,
            )? {
                count += 1;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation("import_package", started, items.len());
        Ok(count)
    }
    /// Commit one push response atomically. `acknowledged` contains only the
    /// exact local versions explicitly settled by the server; authoritative
    /// conflict rows are merged before the transaction is committed.
    pub fn commit_sync_push(
        &mut self,
        scope: &str,
        acknowledged: &[SyncEntity],
        authoritative: &[SyncEntity],
    ) -> Result<u32, String> {
        let started = Instant::now();
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        Self::ensure_active_sync_scope_on(&transaction, scope)?;
        {
            let mut stmt = transaction
                .prepare(
                    "UPDATE entities SET dirty=0 WHERE kind=? AND id=? AND device_id=? AND sync_version=?",
                )
                .map_err(|e| e.to_string())?;
            for item in acknowledged {
                stmt.execute(params![
                    item.kind,
                    item.id,
                    item.device_id,
                    item.sync_version
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        Self::upsert_sync_acknowledgements(&transaction, scope, acknowledged)?;
        let imported = Self::import_sync_entities_in_transaction(&transaction, authoritative)?;
        Self::upsert_sync_acknowledgements(&transaction, scope, authoritative)?;
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation(
            "commit_sync_push",
            started,
            acknowledged.len() + authoritative.len(),
        );
        Ok(imported)
    }

    #[cfg(test)]
    pub fn import_sync_entities(&mut self, items: &[SyncEntity]) -> Result<u32, String> {
        let started = Instant::now();
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        let count = Self::import_sync_entities_in_transaction(&transaction, items)?;
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation("import_sync_entities", started, items.len());
        Ok(count)
    }

    /// Import one pull page and advance its resume cursor in the same SQLite
    /// transaction. If either step fails, both are rolled back and requesting
    /// the same page again remains safe.
    #[cfg(test)]
    pub fn import_sync_page(
        &mut self,
        scope: &str,
        items: &[SyncEntity],
        next_cursor: &str,
    ) -> Result<u32, String> {
        self.import_sync_page_with_remote_app_settings_priority(scope, items, next_cursor, false)
    }

    /// Import one pull page while optionally giving the account's existing
    /// software-settings entity priority. This is used only when an account is
    /// first connected on this installation: WebViews may already have saved
    /// their local defaults before the initial pull starts, but those defaults
    /// must not win LWW over the account's established cloud preferences.
    pub fn import_sync_page_with_remote_app_settings_priority(
        &mut self,
        scope: &str,
        items: &[SyncEntity],
        next_cursor: &str,
        prefer_remote_app_settings: bool,
    ) -> Result<u32, String> {
        let started = Instant::now();
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        Self::ensure_active_sync_scope_on(&transaction, scope)?;
        let count = Self::import_sync_entities_in_transaction_with_remote_app_settings_priority(
            &transaction,
            items,
            prefer_remote_app_settings,
        )?;
        Self::upsert_sync_acknowledgements(&transaction, scope, items)?;
        let next_cursor = next_cursor.trim();
        if !next_cursor.is_empty() {
            Self::set_sync_cursor_on(&transaction, scope, next_cursor)?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation("import_sync_page", started, items.len());
        Ok(count)
    }

    /// Install authoritative entities returned by the server's inventory
    /// reconciliation without changing the incremental pull cursor. The entity
    /// rows and their exact server acknowledgements commit atomically.
    pub fn import_reconciled_sync_entities(
        &mut self,
        scope: &str,
        items: &[SyncEntity],
    ) -> Result<u32, String> {
        let started = Instant::now();
        let transaction = self.conn.transaction().map_err(|e| e.to_string())?;
        Self::ensure_active_sync_scope_on(&transaction, scope)?;
        let count = Self::import_sync_entities_in_transaction(&transaction, items)?;
        Self::upsert_sync_acknowledgements(&transaction, scope, items)?;
        transaction.commit().map_err(|e| e.to_string())?;
        log_db_operation("import_reconciled_sync_entities", started, items.len());
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn memory_db() -> AppDb {
        AppDb::open_in_memory_for_tests()
    }

    fn activate_sync_scope(db: &AppDb, scope: &str) {
        db.set_metadata(SYNC_IDENTITY_VERIFIED_SCOPE_KEY, scope)
            .unwrap();
    }

    #[test]
    fn schema_sets_user_version() {
        let db = memory_db();
        let version: i64 = db
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DB_SCHEMA_VERSION);
        assert!(!table_exists_for_tests(&db.conn, "keyword_postings").unwrap());
        assert!(!table_exists_for_tests(&db.conn, "keyword_docs").unwrap());
    }

    #[test]
    fn open_existing_never_creates_a_missing_database() {
        let dir = std::env::temp_dir().join(format!(
            "ebook-reader-open-existing-test-{}-{}",
            std::process::id(),
            now_secs()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("missing.db");

        assert!(AppDb::open_existing_path(&path).is_err());
        assert!(!path.exists());

        std::fs::remove_dir_all(dir).unwrap();
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
            "reading_progress_v1".to_string(),
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
    fn sync_entities_by_kind_records_a_fixed_sql_operation_label() {
        let mut db = memory_db();
        db.upsert_json_batch(&[
            (
                "vocab".to_string(),
                "one".to_string(),
                json!({"word": "one"}),
            ),
            (
                "vocab".to_string(),
                "two".to_string(),
                json!({"word": "two"}),
            ),
            (
                "reading_progress_v1".to_string(),
                "other-kind".to_string(),
                json!({"progress": 1}),
            ),
        ])
        .unwrap();

        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        let entities = db.sync_entities_by_kind("vocab").unwrap();
        assert_eq!(
            entities
                .iter()
                .map(|entity| entity.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn sql_timing_keeps_the_entity_query_label_and_complete_row_count() {
        let started = Instant::now() - Duration::from_millis(SLOW_DB_OPERATION_MS as u64);
        log_db_operation("sync_entities_by_kind", started, 2);

        let diagnostics = serde_json::to_value(crate::diagnostics::snapshot()).unwrap();
        let timing = diagnostics["recent_slow_db_timings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|sample| {
                sample["kind"] == "sql_operation"
                    && sample["operation"] == "sync_entities_by_kind"
                    && sample["rows"] == 2
            });
        assert!(timing.is_some());
    }

    #[test]
    fn soft_delete_records_a_fixed_sql_operation_label() {
        let mut db = memory_db();
        db.upsert_json_batch(&[(
            "vocab".to_string(),
            "deleted".to_string(),
            json!({"value": 2}),
        )])
        .unwrap();
        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();

        db.soft_delete("vocab", "deleted").unwrap();

        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(1));
        assert_eq!(db.entity_json("vocab", "deleted").unwrap(), None);
    }

    #[test]
    fn entity_json_many_preserves_order_and_entity_json_visibility() {
        let mut db = memory_db();
        db.upsert_json_batch(&[
            (
                "vocab".to_string(),
                "active".to_string(),
                json!({"value": 1}),
            ),
            (
                "vocab".to_string(),
                "deleted".to_string(),
                json!({"value": 2}),
            ),
        ])
        .unwrap();
        db.soft_delete("vocab", "deleted").unwrap();

        let values = db
            .entity_json_many(&[
                ("vocab", "missing"),
                ("vocab", "active"),
                ("vocab", "deleted"),
                ("vocab", "active"),
            ])
            .unwrap();
        assert_eq!(
            values,
            vec![
                None,
                Some(json!({"value": 1})),
                None,
                Some(json!({"value": 1})),
            ]
        );
    }

    #[test]
    fn entity_json_many_reports_malformed_payloads_like_single_read() {
        let db = memory_db();
        db.conn
            .execute(
                "INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty) \
                 VALUES('vocab','malformed','not-json',1,0,'test-device',1,0)",
                [],
            )
            .unwrap();

        assert!(db.entity_json("vocab", "malformed").is_err());
        assert!(db
            .entity_json_many(&[("vocab", "missing"), ("vocab", "malformed")])
            .is_err());
    }

    #[test]
    fn core_package_is_strict_and_transactional() {
        let mut db = memory_db();
        let legacy_package =
            json!({"format":"kunpeng-reader-data-package","version":2,"entities":[]});
        assert!(db.import_package(&legacy_package).is_err());

        let strict_package = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": 2,
            "source_device_id": "new-device",
            "entities": [
                {
                    "kind":"vocab", "id":"zh:新", "data":{"word":"新"},
                    "updated_at": 20, "deleted_at": 0, "device_id":"new-device", "sync_version":1
                },
                {
                    "kind":"vocab", "id":"zh:bad", "data":{"source_path":"C:/private.epub"},
                    "updated_at": 21, "deleted_at": 0, "device_id":"new-device", "sync_version":1
                }
            ]
        });
        assert!(db.import_package(&strict_package).is_err());
        // The valid first entity must not commit when a later entity fails.
        assert!(db.entity_json("vocab", "zh:新").unwrap().is_none());

        let exported = db.export_package().unwrap();
        assert_eq!(exported["format"], CORE_PACKAGE_FORMAT);
        assert_eq!(exported["version"], CORE_PACKAGE_VERSION);
        assert!(exported["source_device_id"].is_string());
        assert!(exported["entities"].as_array().unwrap().iter().all(|item| {
            CORE_PACKAGE_ENTITY_KINDS.contains(&item["kind"].as_str().unwrap())
                && item.get("data").is_some()
                && item.get("payload").is_none()
        }));

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
    fn core_package_fixture_preserves_unknown_payload_and_tombstones() {
        let mut db = memory_db();
        db.set_metadata("data_generation", "7").unwrap();
        db.set_metadata("sync_cursor", "keep-this-cursor").unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/core-data-package.v1.json"
        ))
        .unwrap();
        assert_eq!(db.import_package(&fixture).unwrap(), 5);
        let imported_dirty: i64 = db
            .conn
            .query_row(
                "SELECT dirty FROM entities WHERE kind='vocab' AND id='zh:迁移示例'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(imported_dirty, 1);
        let state = db
            .entity_json(
                "book_state_v2",
                "1111111111111111111111111111111111111111111111111111111111111111",
            )
            .unwrap()
            .unwrap();
        assert_eq!(state["future_client_field"]["preserved"], true);
        assert_eq!(db.metadata("data_generation").as_deref(), Some("7"));
        assert_eq!(
            db.metadata("sync_cursor").as_deref(),
            Some("keep-this-cursor")
        );

        let forbidden = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": 3,
            "source_device_id": "migration-device",
            "entities": [{
                "kind": "vocab", "id": "zh:forbidden", "data": {"data_generation": 9},
                "updated_at": 30, "deleted_at": 0, "device_id": "migration-device", "sync_version": 1
            }]
        });
        assert!(db.import_package(&forbidden).is_err());
        assert!(db.entity_json("vocab", "zh:forbidden").unwrap().is_none());

        let tombstone = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": 4,
            "source_device_id": "migration-device",
            "entities": [{
                "kind": "vocab", "id": "zh:迁移示例", "data": {},
                "updated_at": 1786129000000i64, "deleted_at": 1786129000000i64,
                "device_id": "migration-device", "sync_version": 2
            }]
        });
        assert_eq!(db.import_package(&tombstone).unwrap(), 1);
        assert!(db.entity_json("vocab", "zh:迁移示例").unwrap().is_none());
    }

    #[test]
    fn core_package_v2_fixture_preserves_split_reading_entities() {
        let mut db = memory_db();
        let fixture: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/core-data-package.v2.json"
        ))
        .unwrap();

        assert_eq!(db.import_package(&fixture).unwrap(), 5);
        let content_id = "2222222222222222222222222222222222222222222222222222222222222222";
        let progress = db
            .entity_json("reading_progress_v1", content_id)
            .unwrap()
            .unwrap();
        assert_eq!(progress["future_client_field"]["preserved"], true);
        assert!(db
            .entity_json("reading_data_v1", content_id)
            .unwrap()
            .is_some());
        assert!(db
            .entity_json("reading_statistics_v1", content_id)
            .unwrap()
            .is_some());
        assert!(db.entity_json("vocab", "zh:已删除示例").unwrap().is_none());
    }

    #[test]
    fn sync_page_commits_entities_and_cursor_idempotently() {
        let mut db = memory_db();
        activate_sync_scope(&db, "test-scope");
        let item = SyncEntity {
            kind: "vocab".into(),
            id: "zh:断点".into(),
            json: json!({"word":"断点"}),
            updated_at: 10,
            deleted_at: 0,
            device_id: "remote".into(),
            sync_version: 2,
        };

        assert_eq!(
            db.import_sync_page("test-scope", std::slice::from_ref(&item), "101")
                .unwrap(),
            1
        );
        assert_eq!(
            db.sync_scope_metadata("test-scope", "cursor").as_deref(),
            Some("101")
        );
        assert_eq!(
            db.import_sync_page("test-scope", std::slice::from_ref(&item), "101")
                .unwrap(),
            0
        );
        assert_eq!(
            db.sync_scope_metadata("test-scope", "cursor").as_deref(),
            Some("101")
        );
        assert!(db.pending_sync_entities("test-scope").unwrap().is_empty());
        assert_eq!(
            db.entity_json("vocab", "zh:断点").unwrap(),
            Some(json!({"word":"断点"}))
        );
    }

    #[test]
    fn first_account_pull_prioritizes_remote_app_settings_over_webview_defaults() {
        let mut db = memory_db();
        let scope = "first-account";
        activate_sync_scope(&db, scope);
        db.upsert_json_batch(&[(
            "app_settings_v1".into(),
            "default".into(),
            json!({"gestureSettings":{"profiles":[]}}),
        )])
        .unwrap();
        let remote = SyncEntity {
            kind: "app_settings_v1".into(),
            id: "default".into(),
            json: json!({"gestureSettings":{"profiles":[{"id":"cloud"}]}}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "remote-device".into(),
            sync_version: 1,
        };

        assert_eq!(
            db.import_sync_page_with_remote_app_settings_priority(
                scope,
                &[remote],
                "cursor-1",
                true,
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.entity_json("app_settings_v1", "default").unwrap(),
            Some(json!({"gestureSettings":{"profiles":[{"id":"cloud"}]}}))
        );
    }

    #[test]
    fn private_entities_are_pushed_but_excluded_from_inventory() {
        let mut db = memory_db();
        activate_sync_scope(&db, "test-scope");
        db.upsert_json_batch(&[(
            "secret_bundle_v1".into(),
            "default".into(),
            json!({"ciphertext":"opaque"}),
        )])
        .unwrap();

        let pending = db.pending_sync_entities("test-scope").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, "secret_bundle_v1");
        assert!(db.all_sync_entities().unwrap().is_empty());

        db.commit_sync_push("test-scope", &pending, &[]).unwrap();
        assert!(db.pending_sync_entities("test-scope").unwrap().is_empty());
    }

    #[test]
    fn newly_encrypted_secret_is_newer_than_a_server_tombstone() {
        let mut db = memory_db();
        let local_start = now_millis();
        let tombstone = SyncEntity {
            kind: "secret_bundle_v1".into(),
            id: "default".into(),
            json: json!({}),
            updated_at: local_start - 1,
            deleted_at: local_start - 1,
            device_id: "server-secret-reset".into(),
            sync_version: 1,
        };
        assert_eq!(
            db.import_sync_entities(std::slice::from_ref(&tombstone))
                .unwrap(),
            1
        );

        db.upsert_json_batch(&[(
            "secret_bundle_v1".into(),
            "default".into(),
            json!({"ciphertext":"fresh"}),
        )])
        .unwrap();
        let local = db.pending_sync_entities("unverified-scope").unwrap();
        assert_eq!(local.len(), 1);
        assert!(local[0].updated_at >= local_start);
        assert_eq!(local[0].sync_version, 2);

        // A normal pull-before-push must retain the locally re-encrypted
        // bundle instead of reinstalling the older server tombstone.
        assert_eq!(db.import_sync_entities(&[tombstone]).unwrap(), 0);
        assert_eq!(
            db.entity_json("secret_bundle_v1", "default").unwrap(),
            Some(json!({"ciphertext":"fresh"}))
        );
    }

    #[test]
    fn stale_account_pull_is_rejected_before_sqlite_import() {
        let mut db = memory_db();
        activate_sync_scope(&db, "scope-b");
        let item = SyncEntity {
            kind: "vocab".into(),
            id: "must-not-cross-accounts".into(),
            json: json!({"word":"隔离"}),
            updated_at: 10,
            deleted_at: 0,
            device_id: "remote-a".into(),
            sync_version: 1,
        };

        assert!(db.import_sync_page("scope-a", &[item], "a-11").is_err());
        assert!(db
            .entity_json("vocab", "must-not-cross-accounts")
            .unwrap()
            .is_none());
        assert!(db.sync_scope_metadata("scope-a", "cursor").is_none());
    }

    #[test]
    fn account_switch_keeps_cursor_and_push_baseline_per_scope() {
        let mut db = memory_db();
        db.upsert_json_batch(&[
            ("vocab".into(), "already-on-a".into(), json!({"word":"甲"})),
            ("vocab".into(), "pending-on-a".into(), json!({"word":"乙"})),
        ])
        .unwrap();
        let initial = db.dirty_sync_entities().unwrap();
        let already_on_a = initial
            .iter()
            .find(|item| item.id == "already-on-a")
            .unwrap()
            .clone();
        db.mark_sync_entities_clean(&[already_on_a]).unwrap();
        db.set_metadata("sync_cursor", "a-cursor-10").unwrap();
        db.set_metadata("sync_last_sync_at", "10").unwrap();

        let scope_a = "scope-a";
        let scope_b = "scope-b";
        assert!(db.migrate_legacy_sync_state(scope_a).unwrap());
        activate_sync_scope(&db, scope_a);
        assert_eq!(
            db.sync_scope_metadata(scope_a, "cursor").as_deref(),
            Some("a-cursor-10")
        );
        assert_eq!(
            db.pending_sync_entities(scope_a)
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending-on-a"]
        );

        // B must start at the beginning and upload every local entity even
        // though A had already marked one (and later both) globally clean.
        assert!(!db.migrate_legacy_sync_state(scope_b).unwrap());
        assert!(db.sync_scope_metadata(scope_b, "cursor").is_none());
        assert!(db.sync_scope_metadata(scope_b, "last_sync_at").is_none());
        let pending_b = db.pending_sync_entities(scope_b).unwrap();
        assert_eq!(pending_b.len(), 2);
        activate_sync_scope(&db, scope_b);
        db.import_sync_page(scope_b, &[], "b-cursor-20").unwrap();
        db.commit_sync_push(scope_b, &pending_b, &[]).unwrap();
        assert!(db.pending_sync_entities(scope_b).unwrap().is_empty());

        // Returning to A resumes A's own cursor and still uploads the version
        // A never acknowledged; B's clean state cannot hide it.
        assert_eq!(
            db.sync_scope_metadata(scope_a, "cursor").as_deref(),
            Some("a-cursor-10")
        );
        let pending_a = db.pending_sync_entities(scope_a).unwrap();
        assert_eq!(pending_a.len(), 1);
        assert_eq!(pending_a[0].id, "pending-on-a");
        activate_sync_scope(&db, scope_a);
        db.commit_sync_push(scope_a, &pending_a, &[]).unwrap();
        assert!(db.pending_sync_entities(scope_a).unwrap().is_empty());
        assert_eq!(
            db.sync_scope_metadata(scope_b, "cursor").as_deref(),
            Some("b-cursor-20")
        );
    }

    #[test]
    fn unverified_legacy_state_is_not_claimed_by_the_next_account() {
        let mut db = memory_db();
        db.set_metadata("sync_cursor", "unknown-owner-cursor")
            .unwrap();

        assert!(db.seal_unclaimed_legacy_sync_state().unwrap());
        assert!(!db.migrate_legacy_sync_state("scope-new-user").unwrap());
        assert!(db.sync_scope_metadata("scope-new-user", "cursor").is_none());
    }

    #[test]
    fn push_commit_marks_only_acknowledged_and_installs_authoritative_conflict() {
        let mut db = memory_db();
        activate_sync_scope(&db, "test-scope");
        db.upsert_json_batch(&[
            (
                "vocab".into(),
                "accepted".into(),
                json!({"value":"local-a"}),
            ),
            (
                "vocab".into(),
                "conflict".into(),
                json!({"value":"local-b"}),
            ),
            (
                "vocab".into(),
                "rejected".into(),
                json!({"value":"local-c"}),
            ),
        ])
        .unwrap();
        let dirty = db.dirty_sync_entities().unwrap();
        let accepted = dirty
            .iter()
            .find(|item| item.id == "accepted")
            .unwrap()
            .clone();
        let conflict = dirty
            .iter()
            .find(|item| item.id == "conflict")
            .unwrap()
            .clone();
        let remote = SyncEntity {
            kind: "vocab".into(),
            id: "conflict".into(),
            json: json!({"value":"remote"}),
            updated_at: conflict.updated_at + 1,
            deleted_at: 0,
            device_id: "remote-z".into(),
            sync_version: conflict.sync_version,
        };

        assert_eq!(
            db.commit_sync_push("test-scope", &[accepted, conflict], &[remote])
                .unwrap(),
            1
        );
        let remaining = db.pending_sync_entities("test-scope").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "rejected");
        assert_eq!(
            db.entity_json("vocab", "conflict").unwrap(),
            Some(json!({"value":"remote"}))
        );
    }

    #[test]
    fn sync_page_rolls_back_entities_when_cursor_checkpoint_fails() {
        let mut db = memory_db();
        activate_sync_scope(&db, "test-scope");
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_sync_cursor BEFORE INSERT ON metadata
                 WHEN NEW.key LIKE 'sync_scope:cursor:%' BEGIN
                   SELECT RAISE(ABORT, 'checkpoint rejected');
                 END;",
            )
            .unwrap();
        let item = SyncEntity {
            kind: "vocab".into(),
            id: "zh:回滚".into(),
            json: json!({"word":"回滚"}),
            updated_at: 10,
            deleted_at: 0,
            device_id: "remote".into(),
            sync_version: 1,
        };

        assert!(db.import_sync_page("test-scope", &[item], "102").is_err());
        assert!(db.entity_json("vocab", "zh:回滚").unwrap().is_none());
        assert!(db.sync_scope_metadata("test-scope", "cursor").is_none());
    }

    #[test]
    fn exact_sync_tie_converges_by_device_id_independent_of_arrival_order() {
        let mut db = memory_db();
        let from_a = SyncEntity {
            kind: "vocab".into(),
            id: "zh:冲突".into(),
            json: json!({"value":"a"}),
            updated_at: 10,
            deleted_at: 0,
            device_id: "device-a".into(),
            sync_version: 2,
        };
        let from_b = SyncEntity {
            json: json!({"value":"b"}),
            device_id: "device-b".into(),
            ..from_a.clone()
        };
        assert_eq!(
            db.import_sync_entities(std::slice::from_ref(&from_a))
                .unwrap(),
            1
        );
        assert_eq!(
            db.import_sync_entities(std::slice::from_ref(&from_b))
                .unwrap(),
            1
        );
        assert_eq!(db.import_sync_entities(&[from_a]).unwrap(), 0);
        assert_eq!(
            db.entity_json("vocab", "zh:冲突").unwrap(),
            Some(json!({"value":"b"}))
        );
    }

    #[test]
    fn purge_legacy_entities_and_backup_preserve_supported_rows() {
        let mut db = memory_db();
        db.upsert_json_batch(&[
            ("book".into(), "old".into(), json!({"path":"local"})),
            ("book_state_v2".into(), "sha".into(), json!({"progress":42})),
            (
                "user_book_tags_v1".into(),
                "sha".into(),
                json!({"tags":["历史"]}),
            ),
            (
                "book_collections_v1".into(),
                "sha".into(),
                json!({"collections":["待读"]}),
            ),
            (
                "ai_reader_config_v1".into(),
                "settings".into(),
                json!({"provider":"compatible"}),
            ),
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
            4
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
        source.execute_batch(schema::core_schema_sql()).unwrap();
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
        assert!(!table_exists_for_tests(&compacted, "keyword_postings").unwrap());
        assert!(!table_exists_for_tests(&compacted, "keyword_docs").unwrap());
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
        assert!(table_exists_for_tests(&original, "keyword_postings").unwrap());
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
