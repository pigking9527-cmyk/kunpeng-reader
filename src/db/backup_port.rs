//! The narrow SQLite-facing port used by the backup and legacy-data
//! convergence workflows.
//!
//! This module deliberately creates only a standalone SQLite image or removes
//! superseded entity rows.  Directory staging, portable files, transaction
//! logs, rollback and exclusive `AppState` connection ownership stay in
//! `crate::backup`; callers must retain that lifecycle before invoking these
//! `AppDb` methods.

use super::{log_db_operation, AppDb};
use rusqlite::{params, Connection};
use std::path::Path;
use std::time::Instant;

impl AppDb {
    /// Create a transactionally consistent standalone database snapshot. The
    /// destination must not already exist; recovery points are assembled in a
    /// new temporary directory before being atomically renamed into place.
    pub fn backup_to(&self, path: &Path) -> Result<(), String> {
        let started = Instant::now();
        if path.exists() {
            return Err(format!("备份目标已存在：{}", path.display()));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        self.conn
            .execute("VACUUM INTO ?1", params![path.to_string_lossy().as_ref()])
            .map_err(|error| format!("创建 SQLite 快照失败：{error}"))?;
        let snapshot = Connection::open(path).map_err(|error| error.to_string())?;
        let check: String = snapshot
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if check != "ok" {
            return Err(format!("SQLite 快照完整性检查失败：{check}"));
        }
        log_db_operation("backup_to", started, 1);
        Ok(())
    }

    /// Remove superseded v1 entity rows after a recovery point has been made.
    ///
    /// The caller owns the recovery-point ordering. This port cannot create a
    /// recovery point itself because that requires the application-wide
    /// exclusive backup lifecycle in `crate::backup`.
    pub fn purge_legacy_entities(&mut self) -> Result<u32, String> {
        let started = Instant::now();
        let count = self
            .conn
            .execute(
                "DELETE FROM entities WHERE kind NOT IN ('book_state_v2','reading_progress_v1','reading_data_v1','reading_statistics_v1','model_book_tags_v1','user_book_tags_v1','book_collections_v1','booklist_v1','vocab','reading_bucket_v2','ai_reader_config_v1','translation_config_v1','ai_reader_history_v1','ai_reader_history_entry_v2','secret_bundle_v1','reader_palette_v1','reader_palette_order_v1','app_settings_v1','reading_handoff_v1','news_subscriptions_v1')",
                [],
            )
            .map(|count| count as u32)
            .map_err(|error| error.to_string())?;
        log_db_operation("purge_legacy_entities", started, count as usize);
        Ok(count)
    }
}
