//! One-time, local database migrations that replace obsolete physical data.
//!
//! This module intentionally owns the legacy keyword-index compaction only.
//! It closes both database handles before swapping files, preserves the prior
//! database and WAL sidecars, and verifies the copied core rows before making
//! the new database live. Schema DDL and command-facing [`AppDb`] methods stay
//! outside this lifecycle boundary.

use super::schema::{self, DB_SCHEMA_VERSION};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::time::Duration;

type CoreEntityRow = (String, String, String, i64, i64, String, i64, i64);
type SyncAcknowledgementRow = (String, String, String, String, i64, i64, i64);

#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreSnapshot {
    metadata: Vec<(String, String)>,
    entities: Vec<CoreEntityRow>,
    sync_acknowledgements: Vec<SyncAcknowledgementRow>,
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
}

fn load_core_snapshot(connection: &Connection) -> Result<CoreSnapshot, String> {
    let metadata = {
        let mut statement = connection
            .prepare("SELECT key,value FROM metadata ORDER BY key")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let entities = {
        let mut statement = connection
            .prepare(
                "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty \
                 FROM entities ORDER BY kind,id",
            )
            .map_err(|error| error.to_string())?;
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
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let sync_acknowledgements = if table_exists(connection, "sync_acknowledgements")? {
        let mut statement = connection
            .prepare(
                "SELECT scope,kind,id,device_id,sync_version,updated_at,deleted_at \
                 FROM sync_acknowledgements ORDER BY scope,kind,id",
            )
            .map_err(|error| error.to_string())?;
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
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    Ok(CoreSnapshot {
        metadata,
        entities,
        sync_acknowledgements,
    })
}

fn write_core_snapshot(connection: &mut Connection, snapshot: &CoreSnapshot) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut metadata = transaction
            .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
            .map_err(|error| error.to_string())?;
        for (key, value) in &snapshot.metadata {
            metadata
                .execute(params![key, value])
                .map_err(|error| error.to_string())?;
        }
        let mut entities = transaction
            .prepare(
                "INSERT INTO entities(kind,id,json,updated_at,deleted_at,device_id,sync_version,dirty) \
                 VALUES(?,?,?,?,?,?,?,?)",
            )
            .map_err(|error| error.to_string())?;
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
                .map_err(|error| error.to_string())?;
        }
        let mut acknowledgements = transaction
            .prepare(
                "INSERT INTO sync_acknowledgements(\
                    scope,kind,id,device_id,sync_version,updated_at,deleted_at\
                 ) VALUES(?,?,?,?,?,?,?)",
            )
            .map_err(|error| error.to_string())?;
        for (scope, kind, id, device_id, sync_version, updated_at, deleted_at) in
            &snapshot.sync_acknowledgements
        {
            acknowledgements
                .execute(params![
                    scope,
                    kind,
                    id,
                    device_id,
                    sync_version,
                    updated_at,
                    deleted_at
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub(super) fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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

pub(super) fn compact_legacy_database(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let source = Connection::open(path).map_err(|error| error.to_string())?;
    source
        .busy_timeout(Duration::from_secs(8))
        .map_err(|error| error.to_string())?;
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
        .map_err(|error| error.to_string())?;
    if checkpoint.0 != 0 {
        return Err(format!(
            "reader.db 仍被其他连接占用，WAL 检查点未完成：{checkpoint:?}"
        ));
    }

    let snapshot = load_core_snapshot(&source)?;
    let temporary = migration_sibling(path, "compacting");
    let backup = migration_sibling(path, "pre-v4");
    let mut target = Connection::open(&temporary).map_err(|error| error.to_string())?;
    target
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|error| error.to_string())?;
    target
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| error.to_string())?;
    target
        .execute_batch(schema::core_schema_sql())
        .map_err(|error| error.to_string())?;
    write_core_snapshot(&mut target, &snapshot)?;
    target
        .pragma_update(None, "user_version", DB_SCHEMA_VERSION)
        .map_err(|error| error.to_string())?;
    let check: String = target
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if check != "ok" {
        return Err(format!("紧凑数据库完整性检查失败：{check}"));
    }
    if load_core_snapshot(&target)? != snapshot {
        return Err("紧凑数据库的数据逐行校验失败".to_string());
    }
    target.close().map_err(|(_, error)| error.to_string())?;
    source.close().map_err(|(_, error)| error.to_string())?;

    std::fs::rename(path, &backup).map_err(|error| error.to_string())?;
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

#[cfg(test)]
pub(super) fn table_exists_for_tests(connection: &Connection, name: &str) -> Result<bool, String> {
    table_exists(connection, name)
}
