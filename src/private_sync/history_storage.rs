//! Thin metadata persistence boundary for private AI history.
//!
//! The parent module owns SQLite lock lifetimes and command transactions. This
//! module only maps stable metadata records to normalized in-memory entries.

use super::{
    history_rules::{normalized_entries, normalized_library_entries, valid_content_id},
    HISTORY_PREFIX, LIBRARY_HISTORY_KEY,
};
use crate::db::AppDb;
use serde_json::Value;

fn reader_history_key(content_id: &str) -> String {
    format!("{HISTORY_PREFIX}{content_id}")
}

fn entries_from_metadata(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

pub(super) fn read_reader_histories(db: &AppDb) -> Result<Vec<(String, Vec<Value>)>, String> {
    Ok(db
        .metadata_with_prefix(HISTORY_PREFIX)?
        .into_iter()
        .filter_map(|(key, text)| {
            let content_id = key.strip_prefix(HISTORY_PREFIX)?;
            valid_content_id(content_id)
                .then(|| (content_id.to_string(), entries_from_metadata(&text)))
        })
        .collect())
}

pub(super) fn read_reader_history(db: &AppDb, content_id: &str) -> Vec<Value> {
    db.metadata(&reader_history_key(content_id))
        .map(|text| normalized_entries(entries_from_metadata(&text)))
        .unwrap_or_default()
}

pub(super) fn write_reader_history(
    db: &AppDb,
    content_id: &str,
    entries: Vec<Value>,
) -> Result<(), String> {
    db.set_metadata(
        &reader_history_key(content_id),
        &serde_json::to_string(&serde_json::json!({
            "version": 1,
            "contentId": content_id,
            "entries": normalized_entries(entries),
        }))
        .map_err(|e| e.to_string())?,
    )
}

pub(super) fn read_library_history(db: &AppDb) -> Vec<Value> {
    db.metadata(LIBRARY_HISTORY_KEY)
        .map(|text| normalized_library_entries(entries_from_metadata(&text)))
        .unwrap_or_default()
}

pub(super) fn write_library_history(db: &AppDb, entries: Vec<Value>) -> Result<(), String> {
    db.set_metadata(
        LIBRARY_HISTORY_KEY,
        &serde_json::to_string(&serde_json::json!({
            "version": 1,
            "scope": "library",
            "entries": normalized_library_entries(entries),
        }))
        .map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_metadata_has_no_entries() {
        assert!(entries_from_metadata("not json").is_empty());
        assert!(entries_from_metadata(r#"{"version":1}"#).is_empty());
    }
}
