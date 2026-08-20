//! SQLite schema and connection configuration.
//!
//! This module contains only idempotent DDL and in-place schema compatibility
//! work. Opening files, legacy compaction, backup/restore lifecycle, and the
//! command-facing [`AppDb`](super::AppDb) API remain in the parent module.

use rusqlite::Connection;
use std::time::Duration;

pub(super) const DB_SCHEMA_VERSION: i64 = 4;
const WAL_AUTOCHECKPOINT_PAGES: i64 = 1_000;
const WAL_JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

pub(super) fn core_schema_sql() -> &'static str {
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
    CREATE TABLE IF NOT EXISTS sync_acknowledgements (
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sync_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope, kind, id)
    );
    "#
}

pub(super) fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_size_limit", WAL_JOURNAL_SIZE_LIMIT)
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())
}

pub(super) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(core_schema_sql())
        .map_err(|error| error.to_string())?;
    if !entities_has_dirty_column(conn)? {
        conn.execute(
            "ALTER TABLE entities ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    conn.pragma_update(None, "user_version", DB_SCHEMA_VERSION)
        .map_err(|error| error.to_string())
}

fn entities_has_dirty_column(conn: &Connection) -> Result<bool, String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(entities)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for column in columns {
        if column.map_err(|error| error.to_string())? == "dirty" {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_adds_dirty_column_to_pre_v4_entities() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE entities (\
                    kind TEXT NOT NULL,\
                    id TEXT NOT NULL,\
                    json TEXT NOT NULL,\
                    updated_at INTEGER NOT NULL,\
                    deleted_at INTEGER NOT NULL DEFAULT 0,\
                    device_id TEXT NOT NULL,\
                    sync_version INTEGER NOT NULL DEFAULT 1,\
                    PRIMARY KEY(kind, id)\
                );",
            )
            .unwrap();

        initialize_schema(&connection).unwrap();

        let dirty_exists: i64 = connection
            .query_row(
                "SELECT EXISTS(\
                    SELECT 1 FROM pragma_table_info('entities') WHERE name='dirty'\
                )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(dirty_exists, 1);
        assert_eq!(version, DB_SCHEMA_VERSION);
    }
}
