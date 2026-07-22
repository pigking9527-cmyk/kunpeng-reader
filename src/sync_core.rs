#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncMeta {
    pub updated_at: i64,
    pub deleted_at: i64,
    pub sync_version: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeDecision {
    AcceptIncoming,
    KeepExisting,
}

/// Stable, collision-free identity for one remote sync account. `base` must
/// already have passed the client URL normalizer; the length prefix prevents
/// delimiter characters in either component from aliasing another account.
pub fn sync_scope_id(base: &str, user_id: &str) -> String {
    let user_id = user_id.trim();
    format!(
        "sync-scope-v1|{}|{}|{}|{}",
        base.len(),
        base,
        user_id.len(),
        user_id
    )
}

#[cfg(test)]
pub fn decide_sync_merge(existing: Option<SyncMeta>, incoming: SyncMeta) -> MergeDecision {
    decide_sync_merge_with_device(existing.map(|meta| (meta, "")), incoming, "")
}

/// 当时间戳与版本完全相同时，用稳定 device_id 作最终裁决，使两台设备无论
/// 以何种拉取顺序合并都收敛到同一实体。较大的 UTF-8 字典序胜出。
pub fn decide_sync_merge_with_device(
    existing: Option<(SyncMeta, &str)>,
    incoming: SyncMeta,
    incoming_device_id: &str,
) -> MergeDecision {
    let Some(existing) = existing else {
        return MergeDecision::AcceptIncoming;
    };
    let (existing, existing_device_id) = existing;
    if incoming.updated_at > existing.updated_at {
        return MergeDecision::AcceptIncoming;
    }
    if incoming.updated_at == existing.updated_at && incoming.sync_version > existing.sync_version {
        return MergeDecision::AcceptIncoming;
    }
    if incoming.updated_at == existing.updated_at
        && incoming.sync_version == existing.sync_version
        && incoming_device_id > existing_device_id
    {
        return MergeDecision::AcceptIncoming;
    }
    MergeDecision::KeepExisting
}

#[cfg(test)]
pub fn incoming_wins(existing: SyncMeta, incoming: SyncMeta) -> bool {
    decide_sync_merge(Some(existing), incoming) == MergeDecision::AcceptIncoming
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(updated_at: i64, sync_version: i64, deleted_at: i64) -> SyncMeta {
        SyncMeta {
            updated_at,
            sync_version,
            deleted_at,
        }
    }

    #[test]
    fn accepts_when_no_existing_entity() {
        assert_eq!(
            decide_sync_merge(None, meta(10, 1, 0)),
            MergeDecision::AcceptIncoming
        );
    }

    #[test]
    fn newer_updated_at_wins() {
        assert!(incoming_wins(meta(10, 5, 0), meta(11, 1, 0)));
    }

    #[test]
    fn older_updated_at_is_ignored_even_with_higher_version() {
        assert!(!incoming_wins(meta(10, 1, 0), meta(9, 99, 0)));
    }

    #[test]
    fn higher_sync_version_breaks_same_timestamp_tie() {
        assert!(incoming_wins(meta(10, 1, 0), meta(10, 2, 0)));
    }

    #[test]
    fn same_timestamp_and_same_version_keeps_existing() {
        assert!(!incoming_wins(meta(10, 2, 0), meta(10, 2, 0)));
    }

    #[test]
    fn device_id_deterministically_breaks_an_exact_metadata_tie() {
        let existing = meta(10, 2, 0);
        let incoming = meta(10, 2, 0);
        assert_eq!(
            decide_sync_merge_with_device(Some((existing, "device-a")), incoming, "device-b"),
            MergeDecision::AcceptIncoming
        );
        assert_eq!(
            decide_sync_merge_with_device(Some((existing, "device-b")), incoming, "device-a"),
            MergeDecision::KeepExisting
        );
    }

    #[test]
    fn tombstone_wins_when_it_is_newer() {
        assert!(incoming_wins(meta(10, 3, 0), meta(11, 1, 11)));
    }

    #[test]
    fn sync_scope_is_stable_and_separates_server_and_account() {
        let account_a = sync_scope_id("https://reader.example", "user-a");
        assert_eq!(
            account_a,
            sync_scope_id("https://reader.example", " user-a ")
        );
        assert_ne!(account_a, sync_scope_id("https://reader.example", "user-b"));
        assert_ne!(
            account_a,
            sync_scope_id("https://reader-2.example", "user-a")
        );
    }
}
