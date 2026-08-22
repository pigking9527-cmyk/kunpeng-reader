//! Pure restore-plan invariants.
//!
//! This module deliberately does not open, copy, rename, delete, or validate
//! live files. The parent backup module owns those mutations together with the
//! SQLite exclusive lifecycle and rollback orchestration.

use super::transaction_log::RestoreTransactionPlanState;
use std::path::{Path, PathBuf};

pub(super) struct RestoreFilePlan {
    pub(super) destination: PathBuf,
    pub(super) staged: PathBuf,
    pub(super) previous: PathBuf,
    pub(super) had_previous: bool,
    pub(super) expected_bytes: u64,
    pub(super) expected_sha256: String,
    pub(super) original_bytes: Option<u64>,
    pub(super) original_sha256: Option<String>,
}

pub(super) fn staging_path(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("无法确定恢复目标目录：{}", destination.display()))?;
    let name = destination
        .file_name()
        .ok_or_else(|| format!("恢复目标无文件名：{}", destination.display()))?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{label}-{}", std::process::id())))
}

pub(super) fn runtime_projection_names_are_exact(
    files: &[(&str, Vec<u8>)],
    required: &[&str],
) -> bool {
    files.len() == required.len()
        && files.iter().all(|(name, _)| required.contains(name))
        && files
            .iter()
            .map(|(name, _)| *name)
            .collect::<std::collections::HashSet<_>>()
            .len()
            == files.len()
}

pub(super) fn transaction_plan_states(
    plans: &[RestoreFilePlan],
) -> Vec<RestoreTransactionPlanState> {
    plans
        .iter()
        .map(|plan| RestoreTransactionPlanState {
            destination: plan.destination.clone(),
            staged: plan.staged.clone(),
            previous: plan.previous.clone(),
            had_previous: plan.had_previous,
            expected_bytes: plan.expected_bytes,
            expected_sha256: plan.expected_sha256.clone(),
            original_bytes: plan.original_bytes,
            original_sha256: plan.original_sha256.clone(),
            original_moved: false,
            new_committed: false,
        })
        .collect()
}

pub(super) fn transaction_directory(plans: &[RestoreFilePlan]) -> Result<PathBuf, String> {
    let directory = plans
        .first()
        .and_then(|plan| plan.destination.parent())
        .ok_or("恢复事务没有有效目标目录")?
        .to_path_buf();
    if plans.iter().any(|plan| {
        plan.destination.parent() != Some(directory.as_path())
            || plan.staged.parent() != Some(directory.as_path())
            || plan.previous.parent() != Some(directory.as_path())
    }) {
        return Err("恢复事务文件必须位于同一数据目录".into());
    }
    Ok(directory)
}

pub(super) fn is_sqlite_target(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("reader.db" | "external-dicts.db")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(directory: &Path, name: &str) -> RestoreFilePlan {
        RestoreFilePlan {
            destination: directory.join(name),
            staged: directory.join(format!(".{name}.restore-new-test")),
            previous: directory.join(format!(".{name}.restore-previous-test")),
            had_previous: false,
            expected_bytes: 0,
            expected_sha256: "0".repeat(64),
            original_bytes: None,
            original_sha256: None,
        }
    }

    #[test]
    fn runtime_projection_names_require_one_of_each_required_file() {
        let required = ["library.json", "stats.json", "vocab.json"];
        assert!(runtime_projection_names_are_exact(
            &[
                ("library.json", vec![]),
                ("stats.json", vec![]),
                ("vocab.json", vec![])
            ],
            &required,
        ));
        assert!(!runtime_projection_names_are_exact(
            &[
                ("library.json", vec![]),
                ("library.json", vec![]),
                ("vocab.json", vec![])
            ],
            &required,
        ));
    }

    #[test]
    fn transaction_directory_rejects_mixed_parent_directories() {
        let first = Path::new("/tmp/restore-one");
        let second = Path::new("/tmp/restore-two");
        let plans = [plan(first, "reader.db"), plan(second, "library.json")];

        assert!(transaction_directory(&plans).is_err());
    }

    #[test]
    fn sqlite_sidecar_cleanup_is_limited_to_known_database_targets() {
        assert!(is_sqlite_target(Path::new("reader.db")));
        assert!(is_sqlite_target(Path::new("external-dicts.db")));
        assert!(!is_sqlite_target(Path::new("library.json")));
    }
}
