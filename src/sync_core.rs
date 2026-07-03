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

pub fn decide_sync_merge(existing: Option<SyncMeta>, incoming: SyncMeta) -> MergeDecision {
    let Some(existing) = existing else {
        return MergeDecision::AcceptIncoming;
    };
    if incoming.updated_at > existing.updated_at {
        return MergeDecision::AcceptIncoming;
    }
    if incoming.updated_at == existing.updated_at && incoming.sync_version > existing.sync_version {
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
    fn tombstone_wins_when_it_is_newer() {
        assert!(incoming_wins(meta(10, 3, 0), meta(11, 1, 11)));
    }
}
