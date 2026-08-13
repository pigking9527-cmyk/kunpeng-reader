//! Local-only decisions used by the inventory reconciliation loop.
//!
//! HTTP, SQLite transactions, runtime migration and account lifecycle remain
//! in the parent synchronizer. This module only builds the wire payload from
//! already-loaded entities and selects a safe repair set from a server request.

use super::protocol::{SyncEntityKey, SyncManifestEntry, SyncReconcileResponse};
use crate::db;
use std::collections::{HashMap, HashSet};

pub(super) fn reconcile_request_body(
    data_generation: i64,
    enabled_kinds: &[String],
    local: &[db::SyncEntity],
) -> serde_json::Value {
    let manifest = local
        .iter()
        .map(SyncManifestEntry::from)
        .collect::<Vec<_>>();
    serde_json::json!({
        "dataGeneration": data_generation,
        "kinds": enabled_kinds,
        "manifest": manifest,
    })
}

/// Select the exact local entities that the server asked the client to repair.
///
/// A request for a row absent from the local inventory means the two snapshots
/// are no longer coherent. Returning an error is safer than treating that as
/// an implicit tombstone or sending an unrelated pending row.
pub(super) fn reconcile_upload_entities(
    local: &[db::SyncEntity],
    response: &SyncReconcileResponse,
) -> Result<Vec<db::SyncEntity>, String> {
    let upload_keys = response
        .upload
        .iter()
        .map(sync_entity_key)
        .collect::<HashSet<_>>();
    if upload_keys.is_empty() {
        return Ok(Vec::new());
    }

    let local_by_key = local
        .iter()
        .map(|entity| ((entity.kind.as_str(), entity.id.as_str()), entity.clone()))
        .collect::<HashMap<_, _>>();
    if upload_keys
        .iter()
        .any(|key| !local_by_key.contains_key(key))
    {
        return Err("服务器请求补传的实体已不在本地，请重新同步".into());
    }

    // Preserve the previous repair semantics (one entity per requested key),
    // while using local order to make payloads reproducible for diagnostics.
    Ok(local
        .iter()
        .filter(|entity| upload_keys.contains(&(entity.kind.as_str(), entity.id.as_str())))
        .cloned()
        .collect())
}

fn sync_entity_key(item: &SyncEntityKey) -> (&str, &str) {
    (item.kind.as_str(), item.id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(kind: &str, id: &str) -> db::SyncEntity {
        db::SyncEntity {
            kind: kind.into(),
            id: id.into(),
            json: serde_json::json!({}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "device-a".into(),
            sync_version: 1,
        }
    }

    fn response(upload: &[(&str, &str)]) -> SyncReconcileResponse {
        SyncReconcileResponse {
            server_time: 1,
            data_generation: 1,
            entity_count: 0,
            inventory_digest: String::new(),
            revision: String::new(),
            upload: upload
                .iter()
                .map(|(kind, id)| SyncEntityKey {
                    kind: (*kind).into(),
                    id: (*id).into(),
                })
                .collect(),
            entities: Vec::new(),
        }
    }

    #[test]
    fn reconcile_request_contains_only_manifest_and_enabled_scope() {
        let body = reconcile_request_body(
            7,
            &["vocab".into()],
            &[entity("vocab", "word"), entity("book_state_v2", "book")],
        );

        assert!(body.get("schema_version").is_none());
        assert_eq!(body["dataGeneration"], 7);
        assert_eq!(body["kinds"], serde_json::json!(["vocab"]));
        assert_eq!(body["manifest"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn repair_selection_deduplicates_requests_and_keeps_local_order() {
        let local = vec![entity("vocab", "first"), entity("vocab", "second")];
        let response = response(&[("vocab", "second"), ("vocab", "second"), ("vocab", "first")]);

        let selected = reconcile_upload_entities(&local, &response).unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn repair_selection_rejects_missing_local_entity() {
        let result = reconcile_upload_entities(
            &[entity("vocab", "present")],
            &response(&[("vocab", "missing")]),
        );
        let error = match result {
            Ok(_) => panic!("missing repair entity must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("已不在本地"));
    }
}
