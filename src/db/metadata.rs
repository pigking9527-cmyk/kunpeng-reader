//! Application metadata and account-scoped sync checkpoints.
//!
//! The command-facing API remains on [`AppDb`], while direct access to the
//! metadata table stays within this focused storage module.

use super::{log_db_operation, AppDb};
use rusqlite::{params, Connection, OptionalExtension};
use std::time::Instant;

const SYNC_SCOPE_MIGRATION_OWNER_KEY: &str = "sync_scope_migration_owner_v1";
const UNCLAIMED_SYNC_SCOPE: &str = "sync-scope-v1-unclaimed";
pub(crate) const SYNC_IDENTITY_VERIFIED_SCOPE_KEY: &str = "sync_identity_verified_scope_v1";
const LEGACY_SYNC_PROGRESS_KEYS: &[(&str, &str)] = &[
    ("sync_cursor", "cursor"),
    ("sync_last_sync_at", "last_sync_at"),
    ("sync_last_pushed", "last_pushed"),
    ("sync_last_pulled", "last_pulled"),
    ("sync_last_accepted", "last_accepted"),
    ("sync_last_ignored", "last_ignored"),
];

fn sync_scope_metadata_key(scope: &str, key: &str) -> String {
    format!("sync_scope:{key}:{scope}")
}

fn legacy_sync_progress_key(key: &str) -> Option<&'static str> {
    LEGACY_SYNC_PROGRESS_KEYS
        .iter()
        .find_map(|(legacy, scoped)| (*scoped == key).then_some(*legacy))
}

fn new_device_id() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("dev-{}-{timestamp}", std::process::id())
}

impl AppDb {
    pub(super) fn ensure_device_id(&self) -> Result<String, String> {
        if let Some(value) = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE key='device_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            return Ok(value);
        }
        let id = new_device_id();
        self.conn
            .execute(
                "INSERT INTO metadata(key,value) VALUES('device_id',?)",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        Ok(id)
    }

    pub fn metadata(&self, key: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Enumerate application-owned metadata without exposing the SQLite
    /// connection to feature modules. Callers must use a stable, narrow
    /// prefix; this is used for opt-in per-book AI history only.
    pub fn metadata_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>, String> {
        let like = format!("{prefix}%");
        let started = Instant::now();
        let mut statement = self
            .conn
            .prepare("SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![like], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        let entries = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        log_db_operation("metadata_with_prefix", started, entries.len());
        Ok(entries)
    }

    pub fn set_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Store a related set of metadata fields atomically. Sync credentials use
    /// this so a crash cannot combine a new token with the previous server or
    /// account id.
    pub fn set_metadata_batch(&mut self, entries: &[(&str, &str)]) -> Result<(), String> {
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO metadata(key,value) VALUES(?,?) \
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                )
                .map_err(|error| error.to_string())?;
            for (key, value) in entries {
                statement
                    .execute(params![key, value])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    /// Read progress for one normalized server/account pair. Before the one-time
    /// migration is claimed, the current legacy account can still see the old
    /// global fields; once claimed, no other account may inherit them.
    pub fn sync_scope_metadata(&self, scope: &str, key: &str) -> Option<String> {
        let scoped_key = sync_scope_metadata_key(scope, key);
        if let Some(value) = self.metadata(&scoped_key) {
            return Some(value);
        }
        let owner = self.metadata(SYNC_SCOPE_MIGRATION_OWNER_KEY);
        if owner.as_deref().is_some_and(|owner| owner != scope) {
            return None;
        }
        legacy_sync_progress_key(key).and_then(|legacy| self.metadata(legacy))
    }

    pub fn set_sync_scope_metadata(
        &self,
        scope: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.set_metadata(&sync_scope_metadata_key(scope, key), value)
    }

    pub(super) fn set_sync_cursor_on(
        connection: &Connection,
        scope: &str,
        next_cursor: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![sync_scope_metadata_key(scope, "cursor"), next_cursor],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(super) fn ensure_active_sync_scope_on(
        connection: &Connection,
        scope: &str,
    ) -> Result<(), String> {
        let active_scope = connection
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                params![SYNC_IDENTITY_VERIFIED_SCOPE_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if active_scope.as_deref() != Some(scope) {
            return Err("同步账户已切换，已丢弃旧账户的网络响应".into());
        }
        Ok(())
    }

    pub fn ensure_active_sync_scope(&self, scope: &str) -> Result<(), String> {
        Self::ensure_active_sync_scope_on(&self.conn, scope)
    }

    /// Claim pre-v4 global cursor/clean flags for the account that was saved at
    /// upgrade time. This is transactional and may happen only once, so a later
    /// account or server can never inherit the legacy account's resume state.
    pub fn migrate_legacy_sync_state(&mut self, scope: &str) -> Result<bool, String> {
        if scope.trim().is_empty() {
            return Err("同步账户命名空间为空".to_string());
        }
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        let owner = transaction
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                params![SYNC_SCOPE_MIGRATION_OWNER_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if owner.is_some() {
            return Ok(false);
        }

        transaction
            .execute(
                "INSERT INTO sync_acknowledgements(\
                    scope,kind,id,device_id,sync_version,updated_at,deleted_at\
                 ) \
                 SELECT ?1,kind,id,device_id,sync_version,updated_at,deleted_at \
                 FROM entities \
                 WHERE dirty=0 AND kind IN ('reading_progress_v1','reading_data_v1','reading_statistics_v1','model_book_tags_v1','vocab','reading_bucket_v2') \
                 ON CONFLICT(scope,kind,id) DO UPDATE SET \
                    device_id=excluded.device_id, \
                    sync_version=excluded.sync_version, \
                    updated_at=excluded.updated_at, \
                    deleted_at=excluded.deleted_at",
                params![scope],
            )
            .map_err(|error| error.to_string())?;

        for (legacy_key, scoped_key) in LEGACY_SYNC_PROGRESS_KEYS {
            let value = transaction
                .query_row(
                    "SELECT value FROM metadata WHERE key=?",
                    params![legacy_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(value) = value {
                transaction
                    .execute(
                        "INSERT INTO metadata(key,value) VALUES(?,?) \
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![sync_scope_metadata_key(scope, scoped_key), value],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?)",
                params![SYNC_SCOPE_MIGRATION_OWNER_KEY, scope],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
    }

    /// Retire unscoped pre-v4 state when its account can no longer be verified.
    /// This intentionally prefers a complete resync over assigning another
    /// user's cursor or clean baseline to the next login.
    pub fn seal_unclaimed_legacy_sync_state(&mut self) -> Result<bool, String> {
        let changed = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)",
                params![SYNC_SCOPE_MIGRATION_OWNER_KEY, UNCLAIMED_SYNC_SCOPE],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_prefix_query_records_a_fixed_sql_operation_label() {
        let database = AppDb::open_in_memory_for_tests();
        database
            .set_metadata("ai_history:book:one", "first")
            .unwrap();
        database
            .set_metadata("ai_history:book:two", "second")
            .unwrap();
        database.set_metadata("unrelated", "ignore").unwrap();

        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        let entries = database.metadata_with_prefix("ai_history:").unwrap();
        assert_eq!(
            entries,
            vec![
                ("ai_history:book:one".to_string(), "first".to_string()),
                ("ai_history:book:two".to_string(), "second".to_string()),
            ]
        );
        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(1));
    }
}
