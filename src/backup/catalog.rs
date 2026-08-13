//! Read-only recovery-point catalogue.
//!
//! This module only discovers existing recovery directories and projects their
//! status. Creating, rotating, restoring and deleting recovery points remain
//! in the parent module, where they participate in the exclusive backup and
//! SQLite lifecycle.

use super::snapshot::manifest_for;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize)]
pub(crate) struct BackupStatus {
    pub(super) directory: String,
    pub(super) latest: String,
    pub(super) count: u32,
    pub(super) total_bytes: u64,
    pub(super) created: bool,
    pub(super) backups: Vec<BackupEntry>,
}

#[derive(Clone, Serialize)]
pub(super) struct BackupEntry {
    pub(super) id: String,
    pub(super) created_at: String,
    pub(super) total_bytes: u64,
}

pub(super) fn directory_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_bytes(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

pub(super) fn backup_directories(root: &Path) -> Vec<PathBuf> {
    let mut backups = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_dir()
                        && !path
                            .file_name()
                            .is_some_and(|name| name.to_string_lossy().starts_with('.'))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    backups.sort();
    backups
}

fn backup_entry(path: &Path) -> BackupEntry {
    let id = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let created_at = manifest_for(path)
        .map(|manifest| manifest.created_at)
        .unwrap_or_else(|_| id.clone());
    BackupEntry {
        id,
        created_at,
        total_bytes: directory_bytes(path),
    }
}

pub(super) fn status(root: &Path) -> BackupStatus {
    let backups = backup_directories(root);
    BackupStatus {
        directory: root.to_string_lossy().into_owned(),
        latest: backups
            .last()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        count: backups.len() as u32,
        total_bytes: backups.iter().map(|path| directory_bytes(path)).sum(),
        created: false,
        backups: backups
            .iter()
            .rev()
            .map(|path| backup_entry(path))
            .collect(),
    }
}

pub(super) fn backup_sort_key(path: &Path) -> i128 {
    if let Ok(manifest) = manifest_for(path) {
        if let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&manifest.created_at) {
            return created_at.timestamp_millis() as i128;
        }
    }
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i128)
        .unwrap_or(i128::MIN)
}

pub(super) fn is_safe_backup_id(id: &str) -> bool {
    !id.is_empty()
        && Path::new(id).components().count() == 1
        && !id.contains(['/', '\\'])
        && !id.starts_with('.')
}

pub(super) fn recovery_directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_safe_backup_id(id) {
        return Err("恢复点标识无效".to_string());
    }
    let path = root.join(id);
    if !path.is_dir() {
        return Err("所选恢复点不存在或已被清理".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_ids_are_single_visible_directory_names() {
        assert!(is_safe_backup_id("20260813-135012-123"));
        assert!(!is_safe_backup_id(""));
        assert!(!is_safe_backup_id("../reader.db"));
        assert!(!is_safe_backup_id("a/b"));
        assert!(!is_safe_backup_id(".temporary"));
    }

    #[test]
    fn catalogue_ignores_hidden_staging_directories() {
        let root =
            std::env::temp_dir().join(format!("kunpeng-backup-catalogue-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("20260813-135012-123")).unwrap();
        std::fs::create_dir_all(root.join(".20260813-135012-123.tmp")).unwrap();

        let directories = backup_directories(&root);

        assert_eq!(directories, vec![root.join("20260813-135012-123")]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
