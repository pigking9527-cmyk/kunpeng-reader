//! Thin SQLite persistence boundary for projected granular history entities.
//!
//! The caller owns the surrounding lock/transaction and preserves ordering
//! relative to public configuration materialization. Within a scope this
//! function retains the original query, retire, then batch-upsert order.

use super::HISTORY_ENTRY_KIND;
use crate::db::{AppDb, SyncEntity};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn should_retire(
    entity: &SyncEntity,
    active: &BTreeMap<String, Value>,
    tombstones: &BTreeSet<String>,
) -> bool {
    !active.contains_key(&entity.id) && (entity.deleted_at == 0 || tombstones.contains(&entity.id))
}

pub(super) fn store_history_projection(
    db: &mut AppDb,
    scope_prefix: &str,
    active: BTreeMap<String, Value>,
    tombstones: &BTreeSet<String>,
) -> Result<(), String> {
    let existing = db.sync_entities_by_kind(HISTORY_ENTRY_KIND)?;
    for entity in existing
        .into_iter()
        .filter(|entity| entity.id.starts_with(scope_prefix))
    {
        // A tombstone, an item no longer selected manually, or an item pushed
        // out of the recent window retires only this individual entity.
        if should_retire(&entity, &active, tombstones) {
            db.soft_delete(HISTORY_ENTRY_KIND, &entity.id)?;
        }
    }
    let writes = active
        .into_iter()
        .map(|(id, payload)| (HISTORY_ENTRY_KIND.to_string(), id, payload))
        .collect::<Vec<_>>();
    db.upsert_json_batch(&writes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: &str, deleted_at: i64) -> SyncEntity {
        SyncEntity {
            kind: HISTORY_ENTRY_KIND.into(),
            id: id.into(),
            json: Value::Null,
            updated_at: 1,
            deleted_at,
            device_id: "test-device".into(),
            sync_version: 1,
        }
    }

    #[test]
    fn active_entity_is_never_retired() {
        let active = BTreeMap::from([("reader:one".into(), Value::Null)]);
        assert!(!should_retire(
            &entity("reader:one", 0),
            &active,
            &BTreeSet::new()
        ));
    }

    #[test]
    fn absent_live_or_explicit_tombstone_entity_is_retired() {
        assert!(should_retire(
            &entity("reader:live", 0),
            &BTreeMap::new(),
            &BTreeSet::new()
        ));
        assert!(should_retire(
            &entity("reader:deleted", 7),
            &BTreeMap::new(),
            &BTreeSet::from(["reader:deleted".into()])
        ));
    }

    #[test]
    fn already_deleted_entity_outside_current_tombstone_window_is_unchanged() {
        assert!(!should_retire(
            &entity("reader:old-deleted", 7),
            &BTreeMap::new(),
            &BTreeSet::new()
        ));
    }
}
