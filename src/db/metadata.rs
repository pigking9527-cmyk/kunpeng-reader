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
const AUTO_SYNC_GENERATION_KEY: &str = "sync_auto_generation_v1";
const AUTO_SYNC_FIRST_CHANGE_MS_KEY: &str = "sync_auto_first_change_ms_v1";
const AUTO_SYNC_LAST_CHANGE_MS_KEY: &str = "sync_auto_last_change_ms_v1";
const AUTO_SYNC_CLASS_KEY: &str = "sync_auto_class_v1";
const AUTO_SYNC_FAILURES_KEY: &str = "sync_auto_failures_v1";
const AUTO_SYNC_RETRY_AT_MS_KEY: &str = "sync_auto_retry_at_ms_v1";
const AUTO_SYNC_READING_QUIET_MS: u64 = 45_000;
const AUTO_SYNC_ORDINARY_QUIET_MS: u64 = 10_000;
const AUTO_SYNC_MAX_DEFERRAL_MS: u64 = 300_000;
const AUTO_SYNC_INITIAL_RETRY_MS: u64 = 5_000;
const AUTO_SYNC_MAX_RETRY_MS: u64 = 300_000;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalSyncMutationClass {
    Reading,
    Ordinary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AutomaticSyncDue {
    pub generation: u64,
    pub due_at_ms: u64,
}

fn now_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn metadata_value_on(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM metadata WHERE key=?",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn metadata_u64_on(connection: &Connection, key: &str) -> Result<u64, String> {
    Ok(metadata_value_on(connection, key)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0))
}

fn set_metadata_on(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO metadata(key,value) VALUES(?,?) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
        let started = Instant::now();
        let value = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten();
        log_db_operation("metadata_get", started, usize::from(value.is_some()));
        value
    }

    /// Return the next time a persisted local entity mutation may start an
    /// automatic sync.  This deliberately reads metadata only: remote pull,
    /// reconcile and acknowledgement commits never create this marker.
    pub(crate) fn automatic_sync_due(&self) -> Result<Option<AutomaticSyncDue>, String> {
        let generation = metadata_u64_on(&self.conn, AUTO_SYNC_GENERATION_KEY)?;
        if generation == 0 {
            return Ok(None);
        }
        let first_change = metadata_u64_on(&self.conn, AUTO_SYNC_FIRST_CHANGE_MS_KEY)?;
        let last_change = metadata_u64_on(&self.conn, AUTO_SYNC_LAST_CHANGE_MS_KEY)?;
        if first_change == 0 || last_change == 0 {
            return Ok(None);
        }
        let quiet = match metadata_value_on(&self.conn, AUTO_SYNC_CLASS_KEY)?.as_deref() {
            Some("reading") => AUTO_SYNC_READING_QUIET_MS,
            _ => AUTO_SYNC_ORDINARY_QUIET_MS,
        };
        let retry_at = metadata_u64_on(&self.conn, AUTO_SYNC_RETRY_AT_MS_KEY)?;
        let due_at_ms = last_change
            .saturating_add(quiet)
            .min(first_change.saturating_add(AUTO_SYNC_MAX_DEFERRAL_MS))
            .max(retry_at);
        Ok(Some(AutomaticSyncDue {
            generation,
            due_at_ms,
        }))
    }

    /// Do not turn offline edits before first login into background credential
    /// prompts or retry loops. Their durable generation stays queued until a
    /// successful interactive account setup starts the normal immediate sync.
    pub(crate) fn automatic_sync_is_configured(&self) -> bool {
        !self
            .metadata("sync_url")
            .unwrap_or_default()
            .trim()
            .is_empty()
            && !self
                .metadata("sync_user_id")
                .unwrap_or_default()
                .trim()
                .is_empty()
            && (!self
                .metadata("sync_token_protected")
                .unwrap_or_default()
                .trim()
                .is_empty()
                || !self
                    .metadata("sync_token")
                    .unwrap_or_default()
                    .trim()
                    .is_empty())
    }

    /// Record a successful sync only when it observed the latest local
    /// mutation generation.  A write racing an in-flight sync remains durable
    /// and schedules the next trailing run after restart as well.
    pub(crate) fn settle_automatic_sync_generation(
        &mut self,
        observed_generation: u64,
    ) -> Result<bool, String> {
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        let current = metadata_u64_on(&transaction, AUTO_SYNC_GENERATION_KEY)?;
        if current != 0 && current <= observed_generation {
            transaction
                .execute(
                    "DELETE FROM metadata WHERE key IN (?1,?2,?3,?4,?5,?6)",
                    params![
                        AUTO_SYNC_GENERATION_KEY,
                        AUTO_SYNC_FIRST_CHANGE_MS_KEY,
                        AUTO_SYNC_LAST_CHANGE_MS_KEY,
                        AUTO_SYNC_CLASS_KEY,
                        AUTO_SYNC_FAILURES_KEY,
                        AUTO_SYNC_RETRY_AT_MS_KEY,
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(current != 0)
    }

    /// Persist exponential retry state for the exact local generation that
    /// failed.  A newer local edit gets its normal trailing window instead of
    /// inheriting stale failure backoff.
    pub(crate) fn fail_automatic_sync_generation(
        &mut self,
        observed_generation: u64,
    ) -> Result<bool, String> {
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        let current = metadata_u64_on(&transaction, AUTO_SYNC_GENERATION_KEY)?;
        if current == 0 || current != observed_generation {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(current != 0);
        }
        let failures = metadata_u64_on(&transaction, AUTO_SYNC_FAILURES_KEY)?.saturating_add(1);
        let exponent = u32::try_from(failures.saturating_sub(1))
            .unwrap_or(u32::MAX)
            .min(16);
        let delay = AUTO_SYNC_INITIAL_RETRY_MS
            .saturating_mul(1_u64 << exponent)
            .min(AUTO_SYNC_MAX_RETRY_MS);
        set_metadata_on(&transaction, AUTO_SYNC_FAILURES_KEY, &failures.to_string())?;
        set_metadata_on(
            &transaction,
            AUTO_SYNC_RETRY_AT_MS_KEY,
            &now_epoch_millis().saturating_add(delay).to_string(),
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
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
        let started = Instant::now();
        self.conn
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|error| error.to_string())?;
        log_db_operation("metadata_set", started, 1);
        Ok(())
    }

    /// Store a related set of metadata fields atomically. Sync credentials use
    /// this so a crash cannot combine a new token with the previous server or
    /// account id.
    pub fn set_metadata_batch(&mut self, entries: &[(&str, &str)]) -> Result<(), String> {
        let started = Instant::now();
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
        transaction.commit().map_err(|error| error.to_string())?;
        log_db_operation("metadata_set_batch", started, entries.len());
        Ok(())
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
        Self::set_sync_scope_metadata_on(connection, scope, "cursor", next_cursor)
    }

    pub(super) fn record_local_sync_entity_mutation_on(
        connection: &Connection,
        class: LocalSyncMutationClass,
    ) -> Result<(), String> {
        let generation = metadata_u64_on(connection, AUTO_SYNC_GENERATION_KEY)?
            .checked_add(1)
            .ok_or("本地同步变更世代已耗尽")?;
        let now = now_epoch_millis();
        let existing_class = metadata_value_on(connection, AUTO_SYNC_CLASS_KEY)?;
        let class = if matches!(class, LocalSyncMutationClass::Ordinary)
            || existing_class.as_deref() == Some("ordinary")
        {
            "ordinary"
        } else {
            "reading"
        };
        if metadata_u64_on(connection, AUTO_SYNC_FIRST_CHANGE_MS_KEY)? == 0 {
            set_metadata_on(connection, AUTO_SYNC_FIRST_CHANGE_MS_KEY, &now.to_string())?;
        }
        set_metadata_on(
            connection,
            AUTO_SYNC_GENERATION_KEY,
            &generation.to_string(),
        )?;
        set_metadata_on(connection, AUTO_SYNC_LAST_CHANGE_MS_KEY, &now.to_string())?;
        set_metadata_on(connection, AUTO_SYNC_CLASS_KEY, class)?;
        Ok(())
    }

    /// Write account-scoped metadata inside an existing sync commit
    /// transaction.  Pull/reconcile use this for a durable runtime-projection
    /// marker so a crash after advancing the cursor cannot leave downloaded
    /// rows unapplied on the next no-op pull.
    pub(super) fn set_sync_scope_metadata_on(
        connection: &Connection,
        scope: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?,?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![sync_scope_metadata_key(scope, key), value],
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
    use serde_json::json;

    #[test]
    fn metadata_writes_record_fixed_sql_operation_labels() {
        let mut database = AppDb::open_in_memory_for_tests();
        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        database.set_metadata("one", "first").unwrap();
        database
            .set_metadata_batch(&[("two", "second"), ("three", "third")])
            .unwrap();
        assert_eq!(database.metadata("one").as_deref(), Some("first"));
        assert_eq!(database.metadata("two").as_deref(), Some("second"));
        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(4));
    }

    #[test]
    fn metadata_get_records_a_fixed_sql_operation_label() {
        let database = AppDb::open_in_memory_for_tests();
        database
            .set_metadata("sync_url", "https://example.invalid")
            .unwrap();

        let before = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert_eq!(
            database.metadata("sync_url").as_deref(),
            Some("https://example.invalid")
        );
        assert_eq!(database.metadata("missing"), None);
        let after = serde_json::to_value(crate::diagnostics::snapshot()).unwrap()["counters"]
            ["db_sql_operations_total"]
            .as_u64()
            .unwrap();
        assert!(after >= before.saturating_add(2));
    }

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

    #[test]
    fn local_entity_generations_use_reading_and_ordinary_trailing_windows() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[(
                "reading_progress_v1".into(),
                "book".into(),
                json!({"position": 1}),
            )])
            .unwrap();
        let reading = database.automatic_sync_due().unwrap().unwrap();
        let reading_last = metadata_u64_on(&database.conn, AUTO_SYNC_LAST_CHANGE_MS_KEY).unwrap();
        assert_eq!(reading.due_at_ms - reading_last, AUTO_SYNC_READING_QUIET_MS);

        database
            .upsert_json_batch(&[("vocab".into(), "word".into(), json!({"word": "x"}))])
            .unwrap();
        let ordinary = database.automatic_sync_due().unwrap().unwrap();
        let ordinary_last = metadata_u64_on(&database.conn, AUTO_SYNC_LAST_CHANGE_MS_KEY).unwrap();
        assert_eq!(ordinary.generation, reading.generation + 1);
        assert_eq!(
            ordinary.due_at_ms - ordinary_last,
            AUTO_SYNC_ORDINARY_QUIET_MS
        );
    }

    #[test]
    fn successful_auto_sync_never_clears_a_write_that_raced_the_run() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[("vocab".into(), "one".into(), json!({"word": "one"}))])
            .unwrap();
        let first = database.automatic_sync_due().unwrap().unwrap().generation;
        database
            .upsert_json_batch(&[("vocab".into(), "two".into(), json!({"word": "two"}))])
            .unwrap();

        assert!(database.settle_automatic_sync_generation(first).unwrap());
        assert_eq!(
            database.automatic_sync_due().unwrap().unwrap().generation,
            first + 1
        );
    }

    #[test]
    fn failed_auto_sync_persists_exponential_retry_for_same_generation() {
        let mut database = AppDb::open_in_memory_for_tests();
        database
            .upsert_json_batch(&[("vocab".into(), "one".into(), json!({"word": "one"}))])
            .unwrap();
        let before = database.automatic_sync_due().unwrap().unwrap();
        assert!(database
            .fail_automatic_sync_generation(before.generation)
            .unwrap());
        let after = database.automatic_sync_due().unwrap().unwrap();
        assert!(after.due_at_ms >= before.due_at_ms);
        assert_eq!(
            metadata_u64_on(&database.conn, AUTO_SYNC_FAILURES_KEY).unwrap(),
            1
        );
    }
}
