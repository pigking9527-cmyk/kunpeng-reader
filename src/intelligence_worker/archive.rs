//! Shared permanent archive location and one-time legacy SQLite migration.
//!
//! Both the desktop process and the headless worker use this narrow module so
//! they cannot disagree about the authoritative catalog path.

use rusqlite::{params, Connection, OpenFlags};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) const LEGACY_STORE_FILE: &str = "intelligence-events-v1.sqlite3";
pub(crate) const ARCHIVE_DIRECTORY: &str = "intelligence-hub";
pub(crate) const ARCHIVE_STORE_FILE: &str = "catalog.sqlite3";
const ARCHIVE_MIGRATION_TEMP_FILE: &str = ".catalog.sqlite3.migrating";

pub(crate) fn store_path() -> Result<PathBuf, String> {
    let data_directory = crate::profile::app_data_dir().ok_or("无法定位本机情报档案目录")?;
    let archive_path = data_directory
        .join(ARCHIVE_DIRECTORY)
        .join(ARCHIVE_STORE_FILE);
    let legacy_path =
        crate::profile::app_cache_dir().map(|directory| directory.join(LEGACY_STORE_FILE));
    migrate_legacy_store_if_needed(&archive_path, legacy_path.as_deref())?;
    ensure_archive_layout(&archive_path)?;
    Ok(archive_path)
}

/// Locate the canonical catalog without creating directories, migrating the
/// legacy cache, or otherwise mutating local state.  Status pages must use
/// this rather than `store_path`: merely opening the desktop workbench must
/// never make an archive look initialized.
pub(crate) fn existing_store_path() -> Result<PathBuf, String> {
    let data_directory = crate::profile::app_data_dir().ok_or("无法定位本机情报档案目录")?;
    Ok(data_directory
        .join(ARCHIVE_DIRECTORY)
        .join(ARCHIVE_STORE_FILE))
}

/// Materialize the permanent archive layout even before the first body is
/// fetched.  Nothing under this tree is a cache: a later reader-page refresh
/// must not recreate or evict evidence based on time-to-live policy.
pub(crate) fn ensure_archive_layout(archive_path: &Path) -> Result<(), String> {
    let root = archive_path.parent().ok_or("本机情报档案目录无效")?;
    for relative in [
        "blobs/text",
        "blobs/html",
        "blobs/images/sha256",
        "indexes",
        "archive",
        "packages/outbox",
        "audit",
    ] {
        fs::create_dir_all(root.join(relative))
            .map_err(|error| format!("创建本机情报永久档案目录失败：{error}"))?;
    }
    Ok(())
}

/// The cache source is never changed or deleted. A completed, checked SQLite
/// snapshot is atomically published in the archive directory. If a process
/// stops during migration, the next run can publish a valid staged image or
/// safely recreate it from the untouched legacy source.
pub(crate) fn migrate_legacy_store_if_needed(
    archive_path: &Path,
    legacy_path: Option<&Path>,
) -> Result<(), String> {
    if archive_path.is_file() {
        return Ok(());
    }
    if archive_path.exists() {
        return Err("本机情报档案路径不是文件，无法打开目录".into());
    }
    let Some(legacy_path) = legacy_path.filter(|path| path.is_file()) else {
        return Ok(());
    };
    let archive_directory = archive_path.parent().ok_or("本机情报档案目录无效")?;
    fs::create_dir_all(archive_directory)
        .map_err(|error| format!("创建情报档案目录失败：{error}"))?;
    let staged_path = archive_directory.join(ARCHIVE_MIGRATION_TEMP_FILE);
    if staged_path.is_file() {
        if sqlite_snapshot_is_healthy(&staged_path) {
            return crate::atomic_file::commit_temp_file(&staged_path, archive_path)
                .map_err(|error| format!("提交本机情报档案迁移失败：{error}"));
        }
        fs::remove_file(&staged_path)
            .map_err(|error| format!("清理未完成的情报档案迁移失败：{error}"))?;
    } else if staged_path.exists() {
        return Err("本机情报档案迁移暂存路径不是文件".into());
    }
    let legacy = Connection::open_with_flags(legacy_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开旧情报档案失败：{error}"))?;
    legacy
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| format!("初始化旧情报档案迁移失败：{error}"))?;
    legacy
        .execute(
            "VACUUM INTO ?1",
            params![staged_path.to_string_lossy().as_ref()],
        )
        .map_err(|error| format!("创建本机情报档案迁移快照失败：{error}"))?;
    if !sqlite_snapshot_is_healthy(&staged_path) {
        let _ = fs::remove_file(&staged_path);
        return Err("本机情报档案迁移快照完整性检查失败".into());
    }
    crate::atomic_file::commit_temp_file(&staged_path, archive_path)
        .map_err(|error| format!("提交本机情报档案迁移失败：{error}"))
}

fn sqlite_snapshot_is_healthy(path: &Path) -> bool {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|connection| {
            connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        })
        .is_ok_and(|result| result == "ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_layout_is_under_catalog_parent_not_cache() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-intelligence-layout-{}",
            uuid::Uuid::new_v4()
        ));
        let catalog = root.join(ARCHIVE_STORE_FILE);
        ensure_archive_layout(&catalog).unwrap();
        for relative in [
            "blobs/text",
            "blobs/html",
            "blobs/images/sha256",
            "indexes",
            "archive",
            "packages/outbox",
            "audit",
        ] {
            assert!(root.join(relative).is_dir());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
