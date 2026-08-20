use super::error::{
    BackupError, BackupInvariant, BackupIoOperation, BackupJsonOperation, BackupResult,
};
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

pub(super) fn file_sha256_result(path: &Path) -> BackupResult<(u64, String)> {
    let file = std::fs::File::open(path).map_err(|source| BackupError::Io {
        operation: BackupIoOperation::OpenIntegrityFile,
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|source| BackupError::Io {
            operation: BackupIoOperation::ReadIntegrityFile,
            path: path.to_path_buf(),
            source,
        })?;
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

/// Compatibility facade for the parent restore flow. Keep this only until
/// `backup.rs` accepts `BackupResult` at its internal module boundary.
pub(super) fn file_sha256(path: &Path) -> Result<(u64, String), String> {
    file_sha256_result(path).map_err(|error| error.user_message())
}

pub(super) fn verified_manifest_file_result(
    directory: &Path,
    name: &str,
) -> BackupResult<BackupManifestFile> {
    let (bytes, sha256) = file_sha256_result(&directory.join(name))?;
    Ok(BackupManifestFile::Verified {
        name: name.into(),
        bytes,
        sha256,
    })
}

/// Compatibility facade for the parent backup creation flow.
pub(super) fn verified_manifest_file(
    directory: &Path,
    name: &str,
) -> Result<BackupManifestFile, String> {
    verified_manifest_file_result(directory, name).map_err(|error| error.user_message())
}

pub(super) fn manifest_contains(manifest: &BackupManifest, name: &str) -> bool {
    manifest.files.iter().any(|file| file.name() == name)
}

fn validate_manifest_files_result(path: &Path, manifest: &BackupManifest) -> BackupResult<()> {
    let mut seen = std::collections::HashSet::new();
    for file in &manifest.files {
        let name = file.name();
        if !seen.insert(name) || Path::new(name).components().count() != 1 {
            return Err(BackupError::Invariant(
                BackupInvariant::InvalidManifestFileName {
                    name: name.to_string(),
                },
            ));
        }
        let file_path = path.join(name);
        if !file_path.is_file() {
            return Err(BackupError::Invariant(
                BackupInvariant::MissingManifestFile { path: file_path },
            ));
        }
        if let BackupManifestFile::Verified { bytes, sha256, .. } = file {
            let (actual_bytes, actual_sha256) = file_sha256_result(&file_path)?;
            if actual_bytes != *bytes || actual_sha256 != *sha256 {
                return Err(BackupError::Invariant(
                    BackupInvariant::ManifestIntegrityMismatch {
                        name: name.to_string(),
                    },
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn manifest_for_result(path: &Path) -> BackupResult<BackupManifest> {
    let manifest_path = path.join("manifest.json");
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|source| BackupError::Io {
        operation: BackupIoOperation::ReadManifest,
        path: path.to_path_buf(),
        source,
    })?;
    let manifest: BackupManifest =
        serde_json::from_str(&manifest).map_err(|source| BackupError::Json {
            operation: BackupJsonOperation::ParseManifest,
            path: path.to_path_buf(),
            source,
        })?;
    if manifest.format != "kunpeng-reader-recovery" || manifest.version != BACKUP_FORMAT_VERSION {
        return Err(BackupError::Invariant(
            BackupInvariant::UnsupportedManifestFormat {
                path: path.to_path_buf(),
            },
        ));
    }
    if !manifest_contains(&manifest, "reader.db") {
        return Err(BackupError::Invariant(
            BackupInvariant::MissingManifestDatabase {
                path: path.to_path_buf(),
            },
        ));
    }
    validate_manifest_files_result(path, &manifest)?;
    Ok(manifest)
}

/// Compatibility facade for all current parent backup callers.
pub(super) fn manifest_for(path: &Path) -> Result<BackupManifest, String> {
    manifest_for_result(path).map_err(|error| error.user_message())
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

    #[test]
    fn typed_manifest_reader_keeps_json_source() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-backup-manifest-error-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("manifest.json"), b"not json").unwrap();

        let error = match manifest_for_result(&directory) {
            Err(error) => error,
            Ok(_) => panic!("invalid JSON must not produce a manifest"),
        };
        assert!(matches!(error, BackupError::Json { .. }));
        assert!(std::error::Error::source(&error).is_some());
        let legacy_error = match manifest_for(&directory) {
            Err(error) => error,
            Ok(_) => panic!("invalid JSON must not produce a manifest"),
        };
        assert!(legacy_error.starts_with("恢复点清单格式无效"));

        std::fs::remove_dir_all(directory).unwrap();
    }
}
