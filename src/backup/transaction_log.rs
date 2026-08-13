use super::{atomic_file, snapshot::file_sha256};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const RESTORE_TRANSACTION_FILE: &str = ".restore-transaction.json";
pub(super) const RESTORE_TRANSACTION_VERSION: u32 = 2;

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
        let transaction = Self {
            path: directory.join(RESTORE_TRANSACTION_FILE),
            manifest: RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans,
            },
        };
        transaction.persist_new()?;
        Ok(transaction)
    }

    pub(super) fn manifest(&self) -> &RestoreTransactionManifest {
        &self.manifest
    }

    fn persist_new(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.manifest)
            .map_err(|error| format!("序列化恢复事务日志失败：{error}"))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
            .map_err(|error| {
                format!(
                    "创建恢复事务日志失败（可能已有恢复任务）：{}：{error}",
                    self.path.display()
                )
            })?;
        let result = (|| {
            file.write_all(&bytes)
                .map_err(|error| format!("写入恢复事务日志失败：{error}"))?;
            file.flush()
                .map_err(|error| format!("刷新恢复事务日志失败：{error}"))?;
            file.sync_all()
                .map_err(|error| format!("同步恢复事务日志失败：{error}"))
        })();
        drop(file);
        if result.is_err() {
            let _ = std::fs::remove_file(&self.path);
        }
        result
    }

    fn persist(&self) -> Result<(), String> {
        atomic_file::write_json(&self.path, &self.manifest, false)
            .map_err(|error| format!("保存恢复事务日志失败：{error}"))
    }

    pub(super) fn mark_original_moved(&mut self, index: usize) -> Result<(), String> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or("恢复事务计划索引无效")?;
        plan.original_moved = true;
        self.persist()
    }

    pub(super) fn mark_new_committed(&mut self, index: usize) -> Result<(), String> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or("恢复事务计划索引无效")?;
        plan.new_committed = true;
        self.persist()
    }

    pub(super) fn refresh_committed_integrity(&mut self) -> Result<(), String> {
        for plan in &mut self.manifest.plans {
            let (bytes, sha256) = file_sha256(&plan.destination)?;
            plan.expected_bytes = bytes;
            plan.expected_sha256 = sha256;
        }
        self.persist()
    }

    pub(super) fn mark_validated(&mut self) -> Result<(), String> {
        self.manifest.phase = RestoreTransactionPhase::Validated;
        self.persist()
    }

    pub(super) fn finish(self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "清理恢复事务日志失败 {}：{error}",
                self.path.display()
            )),
        }
    }
}

/// Reads and validates only the durable log envelope and path invariants. The
/// caller retains recovery policy and every live-file mutation.
pub(super) fn load_manifest(
    directory: &Path,
    allowed_targets: &[&str],
) -> Result<Option<RestoreTransactionManifest>, String> {
    let path = directory.join(RESTORE_TRANSACTION_FILE);
    let exists = path
        .try_exists()
        .map_err(|error| format!("检查恢复事务日志失败 {}：{error}", path.display()))?;
    if !exists {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("读取未完成恢复事务失败 {}：{error}", path.display()))?;
    let manifest: RestoreTransactionManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析未完成恢复事务失败：{error}"))?;
    if manifest.version != RESTORE_TRANSACTION_VERSION || manifest.plans.is_empty() {
        return Err(format!(
            "未完成恢复事务版本无效，请保留数据目录并人工检查：{}",
            path.display()
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
) -> Result<(), String> {
    if plan.destination.parent() != Some(directory)
        || plan.staged.parent() != Some(directory)
        || plan.previous.parent() != Some(directory)
    {
        return Err("恢复事务包含数据目录之外的路径".into());
    }
    let destination_name = plan
        .destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("恢复事务目标文件名无效")?;
    if !allowed_targets.contains(&destination_name) {
        return Err(format!("恢复事务目标不受支持：{destination_name}"));
    }
    if !valid_sha256(&plan.expected_sha256)
        || plan.original_bytes.is_some() != plan.original_sha256.is_some()
        || plan
            .original_sha256
            .as_deref()
            .is_some_and(|hash| !valid_sha256(hash))
        || plan.had_previous != plan.original_sha256.is_some()
    {
        return Err(format!("恢复事务文件校验信息无效：{destination_name}"));
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
        return Err("恢复事务暂存文件名与目标不匹配".into());
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
}
