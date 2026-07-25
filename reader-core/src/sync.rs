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

pub fn decide_sync_merge_with_device(
    existing: Option<(SyncMeta, &str)>,
    incoming: SyncMeta,
    incoming_device_id: &str,
) -> MergeDecision {
    let Some((existing, existing_device_id)) = existing else {
        return MergeDecision::AcceptIncoming;
    };
    if incoming.updated_at > existing.updated_at
        || (incoming.updated_at == existing.updated_at
            && incoming.sync_version > existing.sync_version)
        || (incoming.updated_at == existing.updated_at
            && incoming.sync_version == existing.sync_version
            && incoming_device_id > existing_device_id)
    {
        MergeDecision::AcceptIncoming
    } else {
        MergeDecision::KeepExisting
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_device_tiebreaker_converges() {
        let current = SyncMeta {
            updated_at: 2,
            deleted_at: 0,
            sync_version: 1,
        };
        assert_eq!(
            decide_sync_merge_with_device(Some((current, "a")), current, "b"),
            MergeDecision::AcceptIncoming
        );
    }
}
