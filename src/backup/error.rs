use std::{error::Error, fmt, io, path::PathBuf};

pub(crate) type BackupResult<T> = Result<T, BackupError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupErrorCategory {
    Io,
    Json,
    Dependency,
    Invariant,
    Integrity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupRetryability {
    Retryable,
    Never,
    ManualRecovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupIoOperation {
    OpenIntegrityFile,
    ReadIntegrityFile,
    ReadManifest,
    InspectTransactionLog,
    ReadTransactionLog,
    CreateTransactionLog,
    WriteTransactionLog,
    FlushTransactionLog,
    SyncTransactionLog,
    RemoveTransactionLog,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupJsonOperation {
    ParseManifest,
    SerializeTransactionLog,
    ParseTransactionLog,
}

#[derive(Debug)]
pub(crate) enum BackupInvariant {
    InvalidManifestFileName { name: String },
    MissingManifestFile { path: PathBuf },
    UnsupportedManifestFormat { path: PathBuf },
    MissingManifestDatabase { path: PathBuf },
    ManifestIntegrityMismatch { name: String },
    InvalidTransactionVersion { path: PathBuf },
    TransactionPathOutsideDirectory,
    InvalidTransactionTargetName,
    UnsupportedTransactionTarget { target: String },
    InvalidTransactionIntegrity { target: String },
    TransactionStagingNameMismatch,
    TransactionPlanIndex { index: usize },
}

/// Backup-domain failures retain their concrete cause until the outer Tauri
/// command renders the existing Chinese message.  The legacy String facades
/// in individual backup submodules exist only while `backup.rs` is migrated.
#[derive(Debug)]
pub(crate) enum BackupError {
    Io {
        operation: BackupIoOperation,
        path: PathBuf,
        source: io::Error,
    },
    Json {
        operation: BackupJsonOperation,
        path: PathBuf,
        source: serde_json::Error,
    },
    Dependency {
        component: &'static str,
        operation: &'static str,
        source: Box<dyn Error + Send + Sync>,
    },
    Invariant(BackupInvariant),
}

impl BackupError {
    pub(crate) fn category(&self) -> BackupErrorCategory {
        match self {
            Self::Io { .. } => BackupErrorCategory::Io,
            Self::Json { .. } => BackupErrorCategory::Json,
            Self::Dependency { .. } => BackupErrorCategory::Dependency,
            Self::Invariant(BackupInvariant::ManifestIntegrityMismatch { .. }) => {
                BackupErrorCategory::Integrity
            }
            Self::Invariant(_) => BackupErrorCategory::Invariant,
        }
    }

    pub(crate) fn retryability(&self) -> BackupRetryability {
        match self {
            Self::Io { .. } | Self::Dependency { .. } => BackupRetryability::Retryable,
            Self::Invariant(BackupInvariant::InvalidTransactionVersion { .. })
            | Self::Invariant(BackupInvariant::ManifestIntegrityMismatch { .. }) => {
                BackupRetryability::ManualRecovery
            }
            Self::Json { .. } | Self::Invariant(_) => BackupRetryability::Never,
        }
    }

    /// Renders the exact existing Chinese message shape for the legacy parent
    /// flow. New command boundaries should call this only after all internal
    /// backup steps have completed their typed migration.
    pub(crate) fn user_message(&self) -> String {
        // Legacy callers currently consume only the stable Chinese text. Keep
        // the structured metadata live here until the parent exposes it at
        // its typed command boundary in the next migration batch.
        let _metadata = (self.category(), self.retryability());
        match self {
            Self::Io {
                operation: BackupIoOperation::OpenIntegrityFile,
                path,
                source,
            } => format!("打开校验文件失败 {}：{source}", path.display()),
            Self::Io {
                operation: BackupIoOperation::ReadIntegrityFile,
                path,
                source,
            } => format!("读取校验文件失败 {}：{source}", path.display()),
            Self::Io {
                operation: BackupIoOperation::ReadManifest,
                path,
                source,
            } => format!("读取恢复点清单失败 {}：{source}", path.display()),
            Self::Json {
                operation: BackupJsonOperation::ParseManifest,
                path,
                source,
            } => format!("恢复点清单格式无效 {}：{source}", path.display()),
            Self::Json {
                operation: BackupJsonOperation::SerializeTransactionLog,
                source,
                ..
            } => format!("序列化恢复事务日志失败：{source}"),
            Self::Io {
                operation: BackupIoOperation::CreateTransactionLog,
                path,
                source,
            } => format!(
                "创建恢复事务日志失败（可能已有恢复任务）：{}：{source}",
                path.display()
            ),
            Self::Io {
                operation: BackupIoOperation::WriteTransactionLog,
                source,
                ..
            } => format!("写入恢复事务日志失败：{source}"),
            Self::Io {
                operation: BackupIoOperation::FlushTransactionLog,
                source,
                ..
            } => format!("刷新恢复事务日志失败：{source}"),
            Self::Io {
                operation: BackupIoOperation::SyncTransactionLog,
                source,
                ..
            } => format!("同步恢复事务日志失败：{source}"),
            Self::Dependency {
                component: "atomic_file",
                operation: "save_restore_transaction_log",
                source,
            } => format!("保存恢复事务日志失败：{source}"),
            Self::Dependency {
                component,
                operation,
                source,
            } => format!("{component}{operation}失败：{source}"),
            Self::Io {
                operation: BackupIoOperation::RemoveTransactionLog,
                path,
                source,
            } => format!("清理恢复事务日志失败 {}：{source}", path.display()),
            Self::Io {
                operation: BackupIoOperation::InspectTransactionLog,
                path,
                source,
            } => format!("检查恢复事务日志失败 {}：{source}", path.display()),
            Self::Io {
                operation: BackupIoOperation::ReadTransactionLog,
                path,
                source,
            } => format!("读取未完成恢复事务失败 {}：{source}", path.display()),
            Self::Json {
                operation: BackupJsonOperation::ParseTransactionLog,
                source,
                ..
            } => format!("解析未完成恢复事务失败：{source}"),
            Self::Invariant(BackupInvariant::InvalidManifestFileName { name }) => {
                format!("恢复点文件名无效或重复：{name}")
            }
            Self::Invariant(BackupInvariant::MissingManifestFile { path }) => {
                format!("恢复点文件缺失：{}", path.display())
            }
            Self::Invariant(BackupInvariant::UnsupportedManifestFormat { path }) => {
                format!("不支持的恢复点格式：{}", path.display())
            }
            Self::Invariant(BackupInvariant::MissingManifestDatabase { path }) => {
                format!("恢复点缺少 reader.db：{}", path.display())
            }
            Self::Invariant(BackupInvariant::ManifestIntegrityMismatch { name }) => {
                format!("恢复点文件完整性检查失败：{name}")
            }
            Self::Invariant(BackupInvariant::InvalidTransactionVersion { path }) => format!(
                "未完成恢复事务版本无效，请保留数据目录并人工检查：{}",
                path.display()
            ),
            Self::Invariant(BackupInvariant::TransactionPathOutsideDirectory) => {
                "恢复事务包含数据目录之外的路径".to_string()
            }
            Self::Invariant(BackupInvariant::InvalidTransactionTargetName) => {
                "恢复事务目标文件名无效".to_string()
            }
            Self::Invariant(BackupInvariant::UnsupportedTransactionTarget { target }) => {
                format!("恢复事务目标不受支持：{target}")
            }
            Self::Invariant(BackupInvariant::InvalidTransactionIntegrity { target }) => {
                format!("恢复事务文件校验信息无效：{target}")
            }
            Self::Invariant(BackupInvariant::TransactionStagingNameMismatch) => {
                "恢复事务暂存文件名与目标不匹配".to_string()
            }
            Self::Invariant(BackupInvariant::TransactionPlanIndex { index }) => {
                let _ = index;
                "恢复事务计划索引无效".to_string()
            }
        }
    }
}

impl fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.user_message())
    }
}

impl Error for BackupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            Self::Dependency { source, .. } => Some(source.as_ref()),
            Self::Invariant(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_preserves_source_category_retryability_and_message() {
        let error = BackupError::Io {
            operation: BackupIoOperation::OpenIntegrityFile,
            path: PathBuf::from("/tmp/reader.db"),
            source: io::Error::from_raw_os_error(2),
        };

        assert_eq!(error.category(), BackupErrorCategory::Io);
        assert_eq!(error.retryability(), BackupRetryability::Retryable);
        assert!(error.source().is_some());
        assert!(error
            .user_message()
            .starts_with("打开校验文件失败 /tmp/reader.db："));
    }

    #[test]
    fn integrity_error_requires_manual_recovery() {
        let error = BackupError::Invariant(BackupInvariant::ManifestIntegrityMismatch {
            name: "reader.db".to_string(),
        });

        assert_eq!(error.category(), BackupErrorCategory::Integrity);
        assert_eq!(error.retryability(), BackupRetryability::ManualRecovery);
        assert_eq!(error.user_message(), "恢复点文件完整性检查失败：reader.db");
    }
}
