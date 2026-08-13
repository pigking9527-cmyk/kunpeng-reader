//! Sync-entity persistence and JSON projections.
//!
//! This module owns the SQLite representation of sync entities while keeping
//! the command-facing [`AppDb`] API stable. Schema setup, database lifecycle,
//! package import/export and account checkpoint rules intentionally remain in
//! their respective modules.

use super::{is_supported_entity_kind, log_db_operation, AppDb};
use reader_core::sync::{decide_sync_merge_with_device, MergeDecision, SyncMeta};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;

const ALL_SYNC_ENTITY_KINDS: &str = "'reading_progress_v1','reading_data_v1','reading_statistics_v1','model_book_tags_v1','user_book_tags_v1','book_collections_v1','booklist_v1','vocab','reading_bucket_v2','ai_reader_history_entry_v2','reader_palette_v1','reader_palette_order_v1','app_settings_v1'";
const PENDING_SYNC_ENTITY_KINDS: &str = "'reading_progress_v1','reading_data_v1','reading_statistics_v1','model_book_tags_v1','user_book_tags_v1','book_collections_v1','booklist_v1','vocab','reading_bucket_v2','ai_reader_config_v1','translation_config_v1','ai_reader_history_entry_v2','secret_bundle_v1','reader_palette_v1','reader_palette_order_v1','app_settings_v1'";
// Protocol v5 uses Unix milliseconds. Older desktop releases wrote these
// envelope fields in seconds; the bounded range keeps the repair from
// reinterpreting arbitrary or already-canonical values.
const MIN_PROTOCOL_EPOCH_SECONDS: i64 = 946_684_800;
const MAX_PROTOCOL_EPOCH_SECONDS: i64 = 4_102_444_800;

/// A JSON-envelope sync entity. Unknown JSON fields stay opaque so clients
/// cannot accidentally discard fields introduced by newer protocol versions.
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

pub(super) struct IncomingEntity<'a> {
    pub(super) kind: &'a str,
    pub(super) id: &'a str,
    pub(super) json_text: &'a str,
    pub(super) updated_at: i64,
    pub(super) deleted_at: i64,
    pub(super) device_id: &'a str,
    pub(super) sync_version: i64,
}

fn sync_entity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncEntity> {
    let text: String = row.get(2)?;
    Ok(SyncEntity {
        kind: row.get(0)?,
        id: row.get(1)?,
        json: serde_json::from_str(&text).unwrap_or(Value::Null),
        updated_at: row.get(3)?,
        deleted_at: row.get(4)?,
        device_id: row.get(5)?,
        sync_version: row.get(6)?,
    })
}

impl AppDb {
    /// Repairs legacy second-based sync-envelope timestamps before a v5 push.
    ///
    /// The payload is intentionally untouched. Marking repaired rows dirty
    /// makes the upgraded envelope eligible for a fresh acknowledgement.
    pub fn normalize_protocol_v5_entity_timestamps(&mut self) -> Result<usize, String> {
        let started = Instant::now();
        let changed = self
            .conn
            .execute(
                "UPDATE entities SET \
                    updated_at=CASE WHEN updated_at BETWEEN ?1 AND ?2 THEN updated_at * 1000 ELSE updated_at END, \
                    deleted_at=CASE WHEN deleted_at BETWEEN ?1 AND ?2 THEN deleted_at * 1000 ELSE deleted_at END, \
                    dirty=1 \
                 WHERE updated_at BETWEEN ?1 AND ?2 OR deleted_at BETWEEN ?1 AND ?2",
                params![MIN_PROTOCOL_EPOCH_SECONDS, MAX_PROTOCOL_EPOCH_SECONDS],
            )
            .map_err(|error| error.to_string())?;
        log_db_operation("normalize_protocol_v5_timestamps", started, changed);
        Ok(changed)
    }

    pub(super) fn existing_sync_meta(
        conn: &Connection,
        kind: &str,
        id: &str,
    ) -> Result<Option<(SyncMeta, String)>, String> {
        conn.query_row(
            "SELECT updated_at, deleted_at, sync_version, device_id FROM entities WHERE kind=? AND id=?",
            params![kind, id],
            |row| {
                Ok((
                    SyncMeta {
                        updated_at: row.get(0)?,
                        deleted_at: row.get(1)?,
                        sync_version: row.get(2)?,
                    },
                    row.get(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub(super) fn upsert_incoming_entity(
        conn: &Connection,
        item: &IncomingEntity<'_>,
        dirty: i64,
    ) -> Result<bool, String> {
        let incoming = SyncMeta {
            updated_at: item.updated_at,
            deleted_at: item.deleted_at,
            sync_version: item.sync_version,
        };
        let existing = Self::existing_sync_meta(conn, item.kind, item.id)?;
        let existing = existing
            .as_ref()
            .map(|(metadata, device_id)| (*metadata, device_id.as_str()));
        if decide_sync_merge_with_device(existing, incoming, item.device_id)
            == MergeDecision::KeepExisting
        {
            return Ok(false);
        }
        Self::upsert_incoming_entity_unconditionally(conn, item, dirty)
    }

    pub(super) fn upsert_incoming_entity_unconditionally(
        conn: &Connection,
        item: &IncomingEntity<'_>,
        dirty: i64,
    ) -> Result<bool, String> {
        conn.execute(
            r#"
                INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(kind,id) DO UPDATE SET
                    json=excluded.json,
                    updated_at=excluded.updated_at,
                    deleted_at=excluded.deleted_at,
                    device_id=excluded.device_id,
                    sync_version=excluded.sync_version,
                    dirty=excluded.dirty
                "#,
            params![
                item.kind,
                item.id,
                item.json_text,
                item.updated_at,
                item.deleted_at,
                item.device_id,
                item.sync_version,
                dirty
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub fn all_sync_entities(&self) -> Result<Vec<SyncEntity>, String> {
        self.sync_entities_where(
            &format!("kind IN ({ALL_SYNC_ENTITY_KINDS})"),
            "all_sync_entities",
        )
    }

    pub fn sync_entities_by_kind(&self, kind: &str) -> Result<Vec<SyncEntity>, String> {
        let started = Instant::now();
        let mut statement = self.conn.prepare(
            "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE kind=? ORDER BY id",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![kind], sync_entity_from_row)
            .map_err(|error| error.to_string())?;
        let entities = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        log_db_operation("sync_entities_by_kind", started, entities.len());
        Ok(entities)
    }

    pub(super) fn upsert_sync_acknowledgements(
        connection: &Connection,
        scope: &str,
        items: &[SyncEntity],
    ) -> Result<(), String> {
        let started = Instant::now();
        let mut statement = connection
            .prepare(
                "INSERT INTO sync_acknowledgements(\
                    scope,kind,id,device_id,sync_version,updated_at,deleted_at\
                 ) VALUES(?,?,?,?,?,?,?) \
                 ON CONFLICT(scope,kind,id) DO UPDATE SET \
                    device_id=excluded.device_id, \
                    sync_version=excluded.sync_version, \
                    updated_at=excluded.updated_at, \
                    deleted_at=excluded.deleted_at",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = 0usize;
        for item in items
            .iter()
            .filter(|item| is_supported_entity_kind(&item.kind))
        {
            statement
                .execute(params![
                    scope,
                    item.kind,
                    item.id,
                    item.device_id,
                    item.sync_version,
                    item.updated_at,
                    item.deleted_at
                ])
                .map_err(|error| error.to_string())?;
            rows += 1;
        }
        log_db_operation("sync_acknowledgements_upsert", started, rows);
        Ok(())
    }

    /// Entities whose exact current version has not been confirmed by this
    /// server/account. A clean acknowledgement belonging to another account is
    /// intentionally irrelevant.
    pub fn pending_sync_entities(&self, scope: &str) -> Result<Vec<SyncEntity>, String> {
        let started = Instant::now();
        let sql = format!(
            "SELECT e.kind,e.id,e.json,e.updated_at,e.deleted_at,e.device_id,e.sync_version \
             FROM entities e \
             LEFT JOIN sync_acknowledgements a \
               ON a.scope=?1 AND a.kind=e.kind AND a.id=e.id \
             WHERE e.kind IN ({PENDING_SYNC_ENTITY_KINDS}) \
               AND (a.kind IS NULL \
                 OR a.device_id<>e.device_id \
                 OR a.sync_version<>e.sync_version \
                 OR a.updated_at<>e.updated_at \
                 OR a.deleted_at<>e.deleted_at) \
             ORDER BY e.kind,e.id"
        );
        let mut statement = self.conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![scope], sync_entity_from_row)
            .map_err(|error| error.to_string())?;
        let entities = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        log_db_operation("pending_sync_entities", started, entities.len());
        Ok(entities)
    }

    /// Only local changes are uploaded. V2 deliberately excludes full `book`
    /// rows because they contain machine-local paths and cover-cache paths.
    #[cfg(test)]
    pub fn dirty_sync_entities(&self) -> Result<Vec<SyncEntity>, String> {
        self.sync_entities_where(
            &format!("dirty=1 AND kind IN ({ALL_SYNC_ENTITY_KINDS})"),
            "dirty_sync_entities",
        )
    }

    fn sync_entities_where(
        &self,
        predicate: &str,
        operation: &'static str,
    ) -> Result<Vec<SyncEntity>, String> {
        let started = Instant::now();
        let sql = format!(
            "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE {predicate} ORDER BY kind,id"
        );
        let mut statement = self.conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], sync_entity_from_row)
            .map_err(|error| error.to_string())?;
        let entities = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        log_db_operation(operation, started, entities.len());
        Ok(entities)
    }

    #[cfg(test)]
    pub fn mark_sync_entities_clean(&mut self, items: &[SyncEntity]) -> Result<(), String> {
        let started = Instant::now();
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        {
            let mut statement = transaction
                .prepare(
                    "UPDATE entities SET dirty=0 WHERE kind=? AND id=? AND device_id=? AND sync_version=?",
                )
                .map_err(|error| error.to_string())?;
            for item in items {
                statement
                    .execute(params![
                        item.kind,
                        item.id,
                        item.device_id,
                        item.sync_version
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        log_db_operation("mark_sync_entities_clean", started, items.len());
        Ok(())
    }

    pub fn entity_json(&self, kind: &str, id: &str) -> Result<Option<Value>, String> {
        let started = Instant::now();
        let text = self
            .conn
            .query_row(
                "SELECT json FROM entities WHERE kind=? AND id=? AND deleted_at=0",
                params![kind, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let entity = text
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()?;
        log_db_operation("entity_json", started, usize::from(entity.is_some()));
        Ok(entity)
    }

    /// Read several active entity payloads in one query. Results retain the
    /// input order, including duplicate keys; a missing or tombstoned entity
    /// remains `None`, exactly as with [`Self::entity_json`].
    pub fn entity_json_many(&self, keys: &[(&str, &str)]) -> Result<Vec<Option<Value>>, String> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let requested_rows = (0..keys.len())
            .map(|position| format!("({position}, ?, ?)"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "WITH requested(position, kind, id) AS (VALUES {requested_rows}) \
             SELECT requested.position, entities.json \
             FROM requested \
             LEFT JOIN entities \
               ON entities.kind=requested.kind \
              AND entities.id=requested.id \
              AND entities.deleted_at=0 \
             ORDER BY requested.position"
        );
        let mut statement = self.conn.prepare(&sql).map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(params_from_iter(
                keys.iter().flat_map(|&(kind, id)| [kind, id]),
            ))
            .map_err(|error| error.to_string())?;
        let mut result = Vec::with_capacity(keys.len());
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let text: Option<String> = row.get(1).map_err(|error| error.to_string())?;
            result.push(
                text.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
                    .transpose()?,
            );
        }
        log_db_operation("entity_json_many", started, result.len());
        Ok(result)
    }

    pub(super) fn import_sync_entities_in_transaction(
        transaction: &Connection,
        items: &[SyncEntity],
    ) -> Result<u32, String> {
        Self::import_sync_entities_in_transaction_with_remote_app_settings_priority(
            transaction,
            items,
            false,
        )
    }

    pub(super) fn import_sync_entities_in_transaction_with_remote_app_settings_priority(
        transaction: &Connection,
        items: &[SyncEntity],
        prefer_remote_app_settings: bool,
    ) -> Result<u32, String> {
        let started = Instant::now();
        let mut count = 0u32;
        for item in items {
            if !is_supported_entity_kind(&item.kind) {
                continue;
            }
            let json_text = serde_json::to_string(&item.json).map_err(|error| error.to_string())?;
            let incoming = IncomingEntity {
                kind: &item.kind,
                id: &item.id,
                json_text: &json_text,
                updated_at: item.updated_at,
                deleted_at: item.deleted_at,
                device_id: &item.device_id,
                sync_version: item.sync_version,
            };
            let imported = if prefer_remote_app_settings
                && item.kind == "app_settings_v1"
                && item.id == "default"
            {
                Self::upsert_incoming_entity_unconditionally(transaction, &incoming, 0)?
            } else {
                Self::upsert_incoming_entity(transaction, &incoming, 0)?
            };
            if imported {
                count += 1;
            }
        }
        log_db_operation(
            "sync_entities_import_batch",
            started,
            usize::try_from(count).unwrap_or(usize::MAX),
        );
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_v5_timestamp_repair_converts_only_legacy_seconds() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[
                (
                    "vocab".to_string(),
                    "seconds".to_string(),
                    json!({"word": "old"}),
                ),
                (
                    "vocab".to_string(),
                    "millis".to_string(),
                    json!({"word": "new"}),
                ),
            ])
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE entities SET updated_at=?1, deleted_at=?2, dirty=0 WHERE kind='vocab' AND id='seconds'",
                params![1_783_690_277_i64, 1_783_690_278_i64],
            )
            .unwrap();
        let canonical_updated_at: i64 = database
            .conn
            .query_row(
                "SELECT updated_at FROM entities WHERE kind='vocab' AND id='millis'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            database.normalize_protocol_v5_entity_timestamps().unwrap(),
            1
        );

        let repaired: (i64, i64, i64) = database
            .conn
            .query_row(
                "SELECT updated_at, deleted_at, dirty FROM entities WHERE kind='vocab' AND id='seconds'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(repaired, (1_783_690_277_000, 1_783_690_278_000, 1));
        let untouched_updated_at: i64 = database
            .conn
            .query_row(
                "SELECT updated_at FROM entities WHERE kind='vocab' AND id='millis'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(untouched_updated_at, canonical_updated_at);
    }

    #[test]
    fn entity_json_reads_record_fixed_sql_timing_labels() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[(
                "vocab".to_string(),
                "visible".to_string(),
                json!({"ok": true}),
            )])
            .unwrap();
        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();

        assert_eq!(
            database.entity_json("vocab", "visible").unwrap(),
            Some(json!({"ok": true}))
        );
        assert_eq!(
            database
                .entity_json_many(&[("vocab", "missing"), ("vocab", "visible")])
                .unwrap(),
            vec![None, Some(json!({"ok": true}))]
        );

        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(2));
    }

    #[test]
    fn sync_entity_batches_record_fixed_sql_timing_labels_and_rows() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[(
                "vocab".to_string(),
                "visible".to_string(),
                json!({"ok": true}),
            )])
            .unwrap();
        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();

        let local = database.all_sync_entities().unwrap();
        assert_eq!(local.len(), 1);
        let transaction = database.conn.transaction().unwrap();
        AppDb::upsert_sync_acknowledgements(&transaction, "test-scope", &local).unwrap();
        AppDb::import_sync_entities_in_transaction(
            &transaction,
            &[SyncEntity {
                kind: "vocab".into(),
                id: "remote".into(),
                json: json!({"word": "remote"}),
                updated_at: 10,
                deleted_at: 0,
                device_id: "remote-device".into(),
                sync_version: 1,
            }],
        )
        .unwrap();
        transaction.commit().unwrap();

        let acknowledged_rows: i64 = database
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sync_acknowledgements WHERE scope='test-scope'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(acknowledged_rows, 1);
        assert_eq!(
            database.entity_json("vocab", "remote").unwrap(),
            Some(json!({"word": "remote"}))
        );
        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(4));
    }
}
