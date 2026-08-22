//! Pure merge rules for downloaded legacy and granular AI history entities.
//!
//! Callers retain validation, database reads/writes, transaction lifetime, and
//! match ordering. These helpers only merge already-authorized payloads into
//! the current local entry list.

use super::history_rules::{
    history_entry_id, is_history_tombstone, normalized_entries, normalized_library_entries,
};
use serde_json::Value;
use std::collections::BTreeSet;

fn remote_entries(payload: &Value) -> Vec<Value> {
    payload
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn mark_manual_cloud_selection(entries: Vec<Value>, cloud_ids: &BTreeSet<String>) -> Vec<Value> {
    entries
        .into_iter()
        .map(|mut entry| {
            if !is_history_tombstone(&entry) {
                entry["cloudSaved"] =
                    Value::Bool(history_entry_id(&entry).is_some_and(|id| cloud_ids.contains(&id)));
            }
            entry
        })
        .collect()
}

pub(super) fn merge_legacy_reader_history(
    mut local: Vec<Value>,
    payload: &Value,
    manual: bool,
) -> Vec<Value> {
    let remote = remote_entries(payload);
    let cloud_ids = remote
        .iter()
        .filter_map(history_entry_id)
        .collect::<BTreeSet<_>>();
    local.extend(remote);
    if manual {
        mark_manual_cloud_selection(normalized_entries(local), &cloud_ids)
    } else {
        local
    }
}

pub(super) fn merge_legacy_library_history(
    mut local: Vec<Value>,
    payload: &Value,
    manual: bool,
) -> Vec<Value> {
    let remote = remote_entries(payload);
    let cloud_ids = remote
        .iter()
        .filter_map(history_entry_id)
        .collect::<BTreeSet<_>>();
    local.extend(remote);
    if manual {
        mark_manual_cloud_selection(normalized_library_entries(local), &cloud_ids)
    } else {
        local
    }
}

pub(super) fn merge_granular_entry(
    mut local: Vec<Value>,
    entry_id: String,
    remote_entry: Option<Value>,
    deleted_at: i64,
    updated_at: i64,
    manual: bool,
) -> Vec<Value> {
    if deleted_at != 0 {
        local.push(serde_json::json!({
            "id": entry_id,
            "deletedAt": updated_at.to_string(),
        }));
    } else if let Some(mut entry) = remote_entry {
        entry["id"] = Value::String(entry_id);
        if manual {
            entry["cloudSaved"] = Value::Bool(true);
        }
        local.push(entry);
    }
    local
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_legacy_merge_marks_only_remote_live_entries() {
        let merged = merge_legacy_reader_history(
            vec![
                serde_json::json!({"id":"local", "content":"local answer", "cloudSaved":true}),
                serde_json::json!({"id":"deleted", "deletedAt":"2026-08-01T00:00:00Z"}),
            ],
            &serde_json::json!({
                "entries": [
                    {"id":"remote", "content":"remote answer"},
                    {"id":"remote-deleted", "deletedAt":"2026-08-02T00:00:00Z"}
                ]
            }),
            true,
        );
        let local = merged.iter().find(|entry| entry["id"] == "local").unwrap();
        let remote = merged.iter().find(|entry| entry["id"] == "remote").unwrap();
        let tombstones = merged
            .iter()
            .filter(|entry| is_history_tombstone(entry))
            .collect::<Vec<_>>();
        assert_eq!(local["cloudSaved"], false);
        assert_eq!(remote["cloudSaved"], true);
        assert_eq!(tombstones.len(), 2);
        assert!(tombstones
            .iter()
            .all(|entry| entry.get("cloudSaved").is_none()));
    }

    #[test]
    fn granular_tombstone_wins_over_an_attached_entry() {
        let merged = merge_granular_entry(
            Vec::new(),
            "answer".into(),
            Some(serde_json::json!({"content":"must be ignored"})),
            1,
            1_723_000_000,
            true,
        );
        assert_eq!(
            merged,
            vec![serde_json::json!({
                "id": "answer",
                "deletedAt": "1723000000"
            })]
        );
    }

    #[test]
    fn manual_granular_entry_is_marked_as_cloud_saved() {
        let merged = merge_granular_entry(
            Vec::new(),
            "answer".into(),
            Some(serde_json::json!({"content":"saved"})),
            0,
            1,
            true,
        );
        assert_eq!(merged[0]["id"], "answer");
        assert_eq!(merged[0]["cloudSaved"], true);
    }
}
