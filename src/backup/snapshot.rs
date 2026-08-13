use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub(super) const BACKUP_FORMAT_VERSION: u32 = 3;

/// The on-disk recovery-point description. This module intentionally owns
/// snapshot integrity and manifest compatibility only; backup rotation,
/// locking, SQLite lifecycle, and restore transactions remain in the parent.
#[derive(Serialize, Deserialize)]
pub(super) struct BackupManifest {
    pub(super) format: String,
    pub(super) version: u32,
    pub(super) app_version: String,
    pub(super) created_at: String,
    pub(super) files: Vec<BackupManifestFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum BackupManifestFile {
    Legacy(String),
    Verified {
        name: String,
        bytes: u64,
        sha256: String,
    },
}

impl BackupManifestFile {
    fn name(&self) -> &str {
        match self {
            Self::Legacy(name) | Self::Verified { name, .. } => name,
        }
    }
}

pub(super) fn file_sha256(path: &Path) -> Result<(u64, String), String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("打开校验文件失败 {}：{error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取校验文件失败 {}：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read as u64);
    }
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    Ok((total, sha256))
}

pub(super) fn verified_manifest_file(
    directory: &Path,
    name: &str,
) -> Result<BackupManifestFile, String> {
    let (bytes, sha256) = file_sha256(&directory.join(name))?;
    Ok(BackupManifestFile::Verified {
        name: name.into(),
        bytes,
        sha256,
    })
}

pub(super) fn manifest_contains(manifest: &BackupManifest, name: &str) -> bool {
    manifest.files.iter().any(|file| file.name() == name)
}

fn validate_manifest_files(path: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for file in &manifest.files {
        let name = file.name();
        if !seen.insert(name) || Path::new(name).components().count() != 1 {
            return Err(format!("恢复点文件名无效或重复：{name}"));
        }
        let file_path = path.join(name);
        if !file_path.is_file() {
            return Err(format!("恢复点文件缺失：{}", file_path.display()));
        }
        if let BackupManifestFile::Verified { bytes, sha256, .. } = file {
            let (actual_bytes, actual_sha256) = file_sha256(&file_path)?;
            if actual_bytes != *bytes || actual_sha256 != *sha256 {
                return Err(format!("恢复点文件完整性检查失败：{name}"));
            }
        }
    }
    Ok(())
}

pub(super) fn manifest_for(path: &Path) -> Result<BackupManifest, String> {
    let manifest = std::fs::read_to_string(path.join("manifest.json"))
        .map_err(|error| format!("读取恢复点清单失败 {}：{error}", path.display()))?;
    let manifest: BackupManifest = serde_json::from_str(&manifest)
        .map_err(|error| format!("恢复点清单格式无效 {}：{error}", path.display()))?;
    if manifest.format != "kunpeng-reader-recovery" || manifest.version != BACKUP_FORMAT_VERSION {
        return Err(format!("不支持的恢复点格式：{}", path.display()));
    }
    if !manifest_contains(&manifest, "reader.db") {
        return Err(format!("恢复点缺少 reader.db：{}", path.display()));
    }
    validate_manifest_files(path, &manifest)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_file_name_is_single_path_component() {
        assert_eq!(Path::new("reader.db").components().count(), 1);
        assert_ne!(Path::new("nested/reader.db").components().count(), 1);
        assert_ne!(Path::new("../reader.db").components().count(), 1);
    }
}
