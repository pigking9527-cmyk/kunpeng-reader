//! Pure projection from local AI history records to protocol-v2 sync entities.
//!
//! This boundary constructs history entity identifiers and outbound payloads.
//! It deliberately excludes excerpts, local book IDs, and paths, and has no
//! database, network, clock, or Tauri access.

use super::history_rules::{
    account_history_payloads, clipped_text, cloud_library_history_entries, history_entry_id,
    is_history_tombstone,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn sanitized_sources(entry: &Value) -> Vec<Value> {
    entry
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|source| {
                    let title = source
                        .get("bookTitle")
                        .or_else(|| source.get("book_title"))
                        .and_then(Value::as_str)
                        .map(|value| clipped_text(value, 800))
                        .filter(|value| !value.is_empty())?;
                    let chapter = source.get("chapter").and_then(Value::as_u64).unwrap_or(0);
                    let source_kind = source
                        .get("sourceKind")
                        .or_else(|| source.get("source_kind"))
                        .and_then(Value::as_str)
                        .map(|value| clipped_text(value, 120))
                        .unwrap_or_default();
                    let tags = source
                        .get("tags")
                        .and_then(Value::as_array)
                        .map(|tags| {
                            tags.iter()
                                .filter_map(Value::as_str)
                                .map(|tag| clipped_text(tag, 120))
                                .filter(|tag| !tag.is_empty())
                                .take(20)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(serde_json::json!({
                        "bookTitle": title,
                        "chapter": chapter,
                        "sourceKind": source_kind,
                        "tags": tags,
                    }))
                })
                .take(20)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Produce the only representation allowed to leave this device.
fn sanitized_entry(entry: &Value, scope: &str) -> Option<Value> {
    if is_history_tombstone(entry) {
        return None;
    }
    let id = history_entry_id(entry)?;
    let content = entry
        .get("content")
        .or_else(|| entry.get("answer"))
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 20_000))
        .filter(|value| !value.is_empty())?;
    let mut sanitized = serde_json::json!({
        "id": id,
        "version": 2,
        "scope": scope,
        "content": content,
        "sources": sanitized_sources(entry),
    });
    if let Some(question) = entry
        .get("question")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 4_000))
        .filter(|value| !value.is_empty())
    {
        sanitized["question"] = Value::String(question);
    }
    if let Some(task) = entry
        .get("task")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 32))
        .filter(|value| !value.is_empty())
    {
        sanitized["task"] = Value::String(task);
    }
    if let Some(at) = entry
        .get("at")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 64))
        .filter(|value| !value.is_empty())
    {
        sanitized["at"] = Value::String(at);
    }
    Some(sanitized)
}

pub(super) fn reader_entity_id(content_id: &str, entry_id: &str) -> String {
    format!("reader:{content_id}:{entry_id}")
}

fn library_entity_id(entry_id: &str) -> String {
    format!("library:{entry_id}")
}

pub(super) fn entry_id_from_entity_id(entity_id: &str, scope: &str) -> Option<String> {
    let prefix = if scope == "library" {
        "library:"
    } else {
        "reader:"
    };
    let rest = entity_id.strip_prefix(prefix)?;
    if scope == "library" {
        (!rest.is_empty()).then(|| clipped_text(rest, 160))
    } else {
        let (_, entry_id) = rest.split_once(':')?;
        (!entry_id.is_empty()).then(|| clipped_text(entry_id, 160))
    }
}

pub(super) fn desired_reader_history_entities(
    histories: Vec<(String, Vec<Value>)>,
    sync_mode: &str,
) -> (BTreeMap<String, Value>, BTreeSet<String>) {
    let mut active = BTreeMap::new();
    let mut tombstones = BTreeSet::new();
    for (content_id, entries) in account_history_payloads(histories, sync_mode) {
        for entry in entries {
            let Some(entry_id) = history_entry_id(&entry) else {
                continue;
            };
            let entity_id = reader_entity_id(&content_id, &entry_id);
            if is_history_tombstone(&entry) {
                tombstones.insert(entity_id);
            } else if let Some(entry) = sanitized_entry(&entry, "reader") {
                active.insert(
                    entity_id,
                    serde_json::json!({
                        "version": 2,
                        "scope": "reader",
                        "contentId": content_id,
                        "entry": entry,
                    }),
                );
            }
        }
    }
    (active, tombstones)
}

pub(super) fn desired_library_history_entities(
    entries: Vec<Value>,
    sync_mode: &str,
) -> (BTreeMap<String, Value>, BTreeSet<String>) {
    let mut active = BTreeMap::new();
    let mut tombstones = BTreeSet::new();
    for entry in cloud_library_history_entries(entries, sync_mode) {
        let Some(entry_id) = history_entry_id(&entry) else {
            continue;
        };
        let entity_id = library_entity_id(&entry_id);
        if is_history_tombstone(&entry) {
            tombstones.insert(entity_id);
        } else if let Some(entry) = sanitized_entry(&entry, "library") {
            active.insert(
                entity_id,
                serde_json::json!({
                    "version": 2,
                    "scope": "library",
                    "entry": entry,
                }),
            );
        }
    }
    (active, tombstones)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_projection_never_copies_local_or_body_fields() {
        let content_id = "a".repeat(64);
        let (active, tombstones) = desired_reader_history_entities(
            vec![(
                content_id.clone(),
                vec![serde_json::json!({
                    "id": "answer",
                    "content": "saved answer",
                    "sources": [{
                        "bookId": "local-only",
                        "bookTitle": "title",
                        "chapter": 2,
                        "excerpt": "book body",
                        "path": "/local/book.epub"
                    }]
                })],
            )],
            "recent",
        );
        let payload = &active[&reader_entity_id(&content_id, "answer")];
        assert!(tombstones.is_empty());
        assert_eq!(payload["entry"]["sources"][0]["bookTitle"], "title");
        assert!(payload["entry"]["sources"][0].get("bookId").is_none());
        assert!(payload["entry"]["sources"][0].get("excerpt").is_none());
        assert!(payload["entry"]["sources"][0].get("path").is_none());
    }

    #[test]
    fn entity_id_parser_preserves_entry_colons() {
        assert_eq!(
            entry_id_from_entity_id(
                &format!("reader:{}:legacy:timestamp", "b".repeat(64)),
                "reader"
            )
            .as_deref(),
            Some("legacy:timestamp")
        );
        assert_eq!(
            entry_id_from_entity_id("library:library:one", "library").as_deref(),
            Some("library:one")
        );
    }
}
