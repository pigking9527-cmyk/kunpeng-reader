//! Recovery-point retention is intentionally independent from filesystem I/O.
//! The parent backup module supplies ordering metadata and performs deletion so
//! that this module remains safe to exercise without touching user data.

use std::path::{Path, PathBuf};

pub(super) const MAX_RECOVERY_BACKUPS: usize = 7;

/// Chooses the oldest recovery directories that must be removed to retain at
/// most [`MAX_RECOVERY_BACKUPS`] entries. A protected directory (the recovery
/// point created by the current operation) can never be selected.
pub(super) fn select_expired_paths(
    mut backups: Vec<PathBuf>,
    protected: Option<&Path>,
    sort_key: impl Fn(&Path) -> i128,
) -> Result<Vec<PathBuf>, String> {
    backups.sort_by(|left, right| {
        sort_key(left)
            .cmp(&sort_key(right))
            .then_with(|| left.cmp(right))
    });

    let remove_count = backups.len().saturating_sub(MAX_RECOVERY_BACKUPS);
    let expired = backups
        .into_iter()
        .filter(|path| protected != Some(path.as_path()))
        .take(remove_count)
        .collect::<Vec<_>>();
    if expired.len() != remove_count {
        return Err("恢复点轮转无法在保护本次快照的同时满足保留数量".into());
    }
    Ok(expired)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named_backups(count: usize) -> Vec<PathBuf> {
        (0..count)
            .map(|index| PathBuf::from(format!("backup-{index:02}")))
            .collect()
    }

    #[test]
    fn selects_oldest_paths_using_the_supplied_order() {
        let expired = select_expired_paths(named_backups(9), None, |path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .trim_start_matches("backup-")
                .parse::<i128>()
                .unwrap()
        })
        .unwrap();

        assert_eq!(
            expired,
            vec![PathBuf::from("backup-00"), PathBuf::from("backup-01")]
        );
    }

    #[test]
    fn never_selects_the_protected_fresh_snapshot() {
        let backups = named_backups(MAX_RECOVERY_BACKUPS + 1);
        let protected = backups[0].clone();

        let expired = select_expired_paths(backups, Some(&protected), |_| 0).unwrap();

        assert_eq!(expired, vec![PathBuf::from("backup-01")]);
        assert!(!expired.contains(&protected));
    }

    #[test]
    fn fails_when_protection_makes_the_required_rotation_impossible() {
        let protected = PathBuf::from("backup-00");
        let backups = vec![protected.clone(); MAX_RECOVERY_BACKUPS + 1];

        let error = select_expired_paths(backups, Some(&protected), |_| 0).unwrap_err();

        assert!(error.contains("无法在保护本次快照"));
    }
}
