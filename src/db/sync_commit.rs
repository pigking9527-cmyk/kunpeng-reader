//! Atomic commit boundaries for responses received from the sync service.
//!
//! Row-level LWW, tombstone and opaque JSON handling remain in `entities`;
//! account-scope and cursor SQL remain in `metadata`. This module only keeps
//! each response's related writes inside one SQLite transaction.

use super::{log_db_operation, AppDb, SyncEntity};
use rusqlite::params;
use std::time::Instant;

const RUNTIME_PROJECTION_PENDING_KEY: &str = "runtime_projection_pending";

impl AppDb {
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
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        Self::ensure_active_sync_scope_on(&transaction, scope)?;
        {
            let mut statement = transaction
                .prepare(
                    "UPDATE entities SET dirty=0 WHERE kind=? AND id=? AND device_id=? AND sync_version=?",
                )
                .map_err(|error| error.to_string())?;
            for item in acknowledged {
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
        Self::upsert_sync_acknowledgements(&transaction, scope, acknowledged)?;
        let imported = Self::import_sync_entities_in_transaction(&transaction, authoritative)?;
        Self::upsert_sync_acknowledgements(&transaction, scope, authoritative)?;
        if !authoritative.is_empty() {
            Self::set_sync_scope_metadata_on(
                &transaction,
                scope,
                RUNTIME_PROJECTION_PENDING_KEY,
                "1",
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
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
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        let count = Self::import_sync_entities_in_transaction(&transaction, items)?;
        transaction.commit().map_err(|error| error.to_string())?;
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
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
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
        if !items.is_empty() {
            Self::set_sync_scope_metadata_on(
                &transaction,
                scope,
                RUNTIME_PROJECTION_PENDING_KEY,
                "1",
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
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
        let transaction = self.conn.transaction().map_err(|error| error.to_string())?;
        Self::ensure_active_sync_scope_on(&transaction, scope)?;
        let count = Self::import_sync_entities_in_transaction(&transaction, items)?;
        Self::upsert_sync_acknowledgements(&transaction, scope, items)?;
        if !items.is_empty() {
            Self::set_sync_scope_metadata_on(
                &transaction,
                scope,
                RUNTIME_PROJECTION_PENDING_KEY,
                "1",
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        log_db_operation("import_reconciled_sync_entities", started, items.len());
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn push_commit_rolls_back_acknowledgement_when_authoritative_import_fails() {
        let mut database = AppDb::open_in_memory_for_tests();
        let scope = "atomic-push-scope";
        database
            .set_metadata(super::super::SYNC_IDENTITY_VERIFIED_SCOPE_KEY, scope)
            .unwrap();
        database
            .upsert_json_batch(&[(
                "vocab".to_string(),
                "accepted".to_string(),
                json!({"word": "local"}),
            )])
            .unwrap();
        let acknowledged = database.dirty_sync_entities().unwrap().remove(0);
        database
            .conn
            .execute_batch(
                "CREATE TRIGGER reject_authoritative_entity BEFORE INSERT ON entities
                 WHEN NEW.id='rejected-authoritative' BEGIN
                   SELECT RAISE(ABORT, 'authoritative import rejected');
                 END;",
            )
            .unwrap();
        let authoritative = SyncEntity {
            kind: "vocab".to_string(),
            id: "rejected-authoritative".to_string(),
            json: json!({"word": "remote"}),
            updated_at: acknowledged.updated_at + 1,
            deleted_at: 0,
            device_id: "remote-device".to_string(),
            sync_version: 1,
        };

        assert!(database
            .commit_sync_push(scope, std::slice::from_ref(&acknowledged), &[authoritative])
            .is_err());
        let pending = database.pending_sync_entities(scope).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, acknowledged.id);
        assert!(database
            .entity_json("vocab", "rejected-authoritative")
            .unwrap()
            .is_none());
        assert!(database
            .sync_scope_metadata(scope, RUNTIME_PROJECTION_PENDING_KEY)
            .is_none());
    }

    #[test]
    fn remote_commits_durably_mark_runtime_projection_before_cursor_advances() {
        let mut database = AppDb::open_in_memory_for_tests();
        let scope = "projection-scope";
        database
            .set_metadata(super::super::SYNC_IDENTITY_VERIFIED_SCOPE_KEY, scope)
            .unwrap();
        let remote = SyncEntity {
            kind: "vocab".into(),
            id: "remote".into(),
            json: json!({"word": "remote"}),
            updated_at: 11,
            deleted_at: 0,
            device_id: "remote-device".into(),
            sync_version: 1,
        };

        database
            .import_sync_page(scope, std::slice::from_ref(&remote), "11")
            .unwrap();
        assert_eq!(
            database
                .sync_scope_metadata(scope, RUNTIME_PROJECTION_PENDING_KEY)
                .as_deref(),
            Some("1")
        );
        assert_eq!(
            database.sync_scope_metadata(scope, "cursor").as_deref(),
            Some("11")
        );

        database.commit_sync_push(scope, &[], &[remote]).unwrap();
        assert_eq!(
            database
                .sync_scope_metadata(scope, RUNTIME_PROJECTION_PENDING_KEY)
                .as_deref(),
            Some("1")
        );
    }
}
