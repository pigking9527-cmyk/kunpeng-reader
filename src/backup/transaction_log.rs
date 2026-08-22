use super::{
    atomic_file,
    error::{BackupError, BackupInvariant, BackupIoOperation, BackupJsonOperation, BackupResult},
    snapshot::file_sha256_result,
};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const RESTORE_TRANSACTION_FILE: &str = ".restore-transaction.json";
pub(super) const RESTORE_TRANSACTION_VERSION: u32 = 2;

/// `atomic_file` predates backup's typed domain errors and returns its own
/// rendered message. Keep it as a source object rather than duplicating its
/// temp-file and platform-specific replacement implementation here.
#[derive(Debug)]
struct AtomicFileFailure(String);

impl fmt::Display for AtomicFileFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for AtomicFileFailure {}

/// Durable state for one file replacement. The parent backup module owns the
/// actual filesystem moves; this record only makes their state recoverable.
#[derive(Serialize, Deserialize)]
pub(super) struct RestoreTransactionPlanState {
    pub(super) destination: PathBuf,
    pub(super) staged: PathBuf,
    pub(super) previous: PathBuf,
    pub(super) had_previous: bool,
    pub(super) expected_bytes: u64,
    pub(super) expected_sha256: String,
    pub(super) original_bytes: Option<u64>,
    pub(super) original_sha256: Option<String>,
    pub(super) original_moved: bool,
    pub(super) new_committed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RestoreTransactionPhase {
    Installing,
    Validated,
}

#[derive(Serialize, Deserialize)]
pub(super) struct RestoreTransactionManifest {
    pub(super) version: u32,
    pub(super) phase: RestoreTransactionPhase,
    pub(super) plans: Vec<RestoreTransactionPlanState>,
}

/// Owns only the durable JSON log. Staging, rename, validation and rollback
/// remain in the parent because they participate in the live restore lifecycle.
pub(super) struct RestoreTransactionLog {
    path: PathBuf,
    manifest: RestoreTransactionManifest,
}

impl RestoreTransactionLog {
    pub(super) fn begin(
        directory: PathBuf,
        plans: Vec<RestoreTransactionPlanState>,
    ) -> Result<Self, String> {
        Self::begin_result(directory, plans).map_err(|error| error.user_message())
    }

    /// Typed transaction-log creation for the in-progress backup-domain
    /// migration. The String-returning `begin` remains only for `backup.rs`.
    pub(super) fn begin_result(
        directory: PathBuf,
        plans: Vec<RestoreTransactionPlanState>,
    ) -> BackupResult<Self> {
        let transaction = Self {
            path: directory.join(RESTORE_TRANSACTION_FILE),
            manifest: RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans,
            },
        };
        transaction.persist_new_result()?;
        Ok(transaction)
    }

    pub(super) fn manifest(&self) -> &RestoreTransactionManifest {
        &self.manifest
    }

    fn persist_new_result(&self) -> BackupResult<()> {
        let bytes = serde_json::to_vec(&self.manifest).map_err(|source| BackupError::Json {
            operation: BackupJsonOperation::SerializeTransactionLog,
            path: self.path.clone(),
            source,
        })?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
            .map_err(|source| BackupError::Io {
                operation: BackupIoOperation::CreateTransactionLog,
                path: self.path.clone(),
                source,
            })?;
        let result = (|| {
            file.write_all(&bytes).map_err(|source| BackupError::Io {
                operation: BackupIoOperation::WriteTransactionLog,
                path: self.path.clone(),
                source,
            })?;
            file.flush().map_err(|source| BackupError::Io {
                operation: BackupIoOperation::FlushTransactionLog,
                path: self.path.clone(),
                source,
            })?;
            file.sync_all().map_err(|source| BackupError::Io {
                operation: BackupIoOperation::SyncTransactionLog,
                path: self.path.clone(),
                source,
            })
        })();
        drop(file);
        if result.is_err() {
            let _ = std::fs::remove_file(&self.path);
        }
        result
    }

    fn persist_result(&self) -> BackupResult<()> {
        atomic_file::write_json(&self.path, &self.manifest, false).map_err(|message| {
            BackupError::Dependency {
                component: "atomic_file",
                operation: "save_restore_transaction_log",
                source: Box::new(AtomicFileFailure(message)),
            }
        })
    }

    pub(super) fn mark_original_moved(&mut self, index: usize) -> Result<(), String> {
        self.mark_original_moved_result(index)
            .map_err(|error| error.user_message())
    }

    pub(super) fn mark_original_moved_result(&mut self, index: usize) -> BackupResult<()> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or(BackupError::Invariant(
                BackupInvariant::TransactionPlanIndex { index },
            ))?;
        plan.original_moved = true;
        self.persist_result()
    }

    pub(super) fn mark_new_committed(&mut self, index: usize) -> Result<(), String> {
        self.mark_new_committed_result(index)
            .map_err(|error| error.user_message())
    }

    pub(super) fn mark_new_committed_result(&mut self, index: usize) -> BackupResult<()> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or(BackupError::Invariant(
                BackupInvariant::TransactionPlanIndex { index },
            ))?;
        plan.new_committed = true;
        self.persist_result()
    }

    pub(super) fn refresh_committed_integrity(&mut self) -> Result<(), String> {
        self.refresh_committed_integrity_result()
            .map_err(|error| error.user_message())
    }

    pub(super) fn refresh_committed_integrity_result(&mut self) -> BackupResult<()> {
        for plan in &mut self.manifest.plans {
            let (bytes, sha256) = file_sha256_result(&plan.destination)?;
            plan.expected_bytes = bytes;
            plan.expected_sha256 = sha256;
        }
        self.persist_result()
    }

    pub(super) fn mark_validated(&mut self) -> Result<(), String> {
        self.mark_validated_result()
            .map_err(|error| error.user_message())
    }

    pub(super) fn mark_validated_result(&mut self) -> BackupResult<()> {
        self.manifest.phase = RestoreTransactionPhase::Validated;
        self.persist_result()
    }

    pub(super) fn finish(self) -> Result<(), String> {
        self.finish_result().map_err(|error| error.user_message())
    }

    pub(super) fn finish_result(self) -> BackupResult<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(BackupError::Io {
                operation: BackupIoOperation::RemoveTransactionLog,
                path: self.path,
                source,
            }),
        }
    }
}

/// Reads and validates only the durable log envelope and path invariants. The
/// caller retains recovery policy and every live-file mutation.
pub(super) fn load_manifest(
    directory: &Path,
    allowed_targets: &[&str],
) -> Result<Option<RestoreTransactionManifest>, String> {
    load_manifest_result(directory, allowed_targets).map_err(|error| error.user_message())
}

/// Typed durable-log loader for callers that have completed the backup-domain
/// migration. The String facade above keeps the existing parent flow stable.
pub(super) fn load_manifest_result(
    directory: &Path,
    allowed_targets: &[&str],
) -> BackupResult<Option<RestoreTransactionManifest>> {
    let path = directory.join(RESTORE_TRANSACTION_FILE);
    let exists = path.try_exists().map_err(|source| BackupError::Io {
        operation: BackupIoOperation::InspectTransactionLog,
        path: path.clone(),
        source,
    })?;
    if !exists {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|source| BackupError::Io {
        operation: BackupIoOperation::ReadTransactionLog,
        path: path.clone(),
        source,
    })?;
    let manifest: RestoreTransactionManifest =
        serde_json::from_slice(&bytes).map_err(|source| BackupError::Json {
            operation: BackupJsonOperation::ParseTransactionLog,
            path: path.clone(),
            source,
        })?;
    if manifest.version != RESTORE_TRANSACTION_VERSION || manifest.plans.is_empty() {
        return Err(BackupError::Invariant(
            BackupInvariant::InvalidTransactionVersion { path },
        ));
    }
    for plan in &manifest.plans {
        validate_plan(directory, allowed_targets, plan)?;
    }
    Ok(Some(manifest))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_plan(
    directory: &Path,
    allowed_targets: &[&str],
    plan: &RestoreTransactionPlanState,
) -> BackupResult<()> {
    if plan.destination.parent() != Some(directory)
        || plan.staged.parent() != Some(directory)
        || plan.previous.parent() != Some(directory)
    {
        return Err(BackupError::Invariant(
            BackupInvariant::TransactionPathOutsideDirectory,
        ));
    }
    let destination_name = plan
        .destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(BackupError::Invariant(
            BackupInvariant::InvalidTransactionTargetName,
        ))?;
    if !allowed_targets.contains(&destination_name) {
        return Err(BackupError::Invariant(
            BackupInvariant::UnsupportedTransactionTarget {
                target: destination_name.to_string(),
            },
        ));
    }
    if !valid_sha256(&plan.expected_sha256)
        || plan.original_bytes.is_some() != plan.original_sha256.is_some()
        || plan
            .original_sha256
            .as_deref()
            .is_some_and(|hash| !valid_sha256(hash))
        || plan.had_previous != plan.original_sha256.is_some()
    {
        return Err(BackupError::Invariant(
            BackupInvariant::InvalidTransactionIntegrity {
                target: destination_name.to_string(),
            },
        ));
    }
    let staged_name = plan
        .staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let previous_name = plan
        .previous
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !staged_name.starts_with(&format!(".{destination_name}.restore-new-"))
        || !previous_name.starts_with(&format!(".{destination_name}.restore-previous-"))
    {
        return Err(BackupError::Invariant(
            BackupInvariant::TransactionStagingNameMismatch,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_outside_restore_directory() {
        let directory = Path::new("/tmp/restore");
        let plan = RestoreTransactionPlanState {
            destination: PathBuf::from("/tmp/elsewhere/reader.db"),
            staged: PathBuf::from("/tmp/restore/.reader.db.restore-new-1"),
            previous: PathBuf::from("/tmp/restore/.reader.db.restore-previous-1"),
            had_previous: false,
            expected_bytes: 1,
            expected_sha256: "0".repeat(64),
            original_bytes: None,
            original_sha256: None,
            original_moved: false,
            new_committed: false,
        };

        assert!(validate_plan(directory, &["reader.db"], &plan).is_err());
    }

    #[test]
    fn rejects_unknown_restore_target() {
        let directory = Path::new("/tmp/restore");
        let plan = RestoreTransactionPlanState {
            destination: directory.join("other.db"),
            staged: directory.join(".other.db.restore-new-1"),
            previous: directory.join(".other.db.restore-previous-1"),
            had_previous: false,
            expected_bytes: 1,
            expected_sha256: "0".repeat(64),
            original_bytes: None,
            original_sha256: None,
            original_moved: false,
            new_committed: false,
        };

        assert!(validate_plan(directory, &["reader.db"], &plan).is_err());
    }

    #[test]
    fn typed_loader_keeps_json_source_and_legacy_message() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-restore-log-error-{}-{}",
            std::process::id(),
            crate::atomic_file::test_nonce()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(RESTORE_TRANSACTION_FILE), b"not json").unwrap();

        let error = match load_manifest_result(&directory, &["reader.db"]) {
            Err(error) => error,
            Ok(_) => panic!("invalid JSON must not produce a transaction manifest"),
        };
        assert!(matches!(error, BackupError::Json { .. }));
        assert!(std::error::Error::source(&error).is_some());
        let legacy_error = match load_manifest(&directory, &["reader.db"]) {
            Err(error) => error,
            Ok(_) => panic!("invalid JSON must not produce a transaction manifest"),
        };
        assert!(legacy_error.starts_with("解析未完成恢复事务失败"));

        std::fs::remove_dir_all(directory).unwrap();
    }
}
