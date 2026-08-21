//! Pure normalization and account-level projection rules for synced AI history.
//!
//! No database, Tauri, clock, filesystem, or network access belongs here.

use super::{HISTORY_LIVE_LIMIT, HISTORY_TOMBSTONE_LIMIT};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn valid_content_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn history_entry_id(entry: &Value) -> Option<String> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 160))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            entry
                .get("at")
                .and_then(Value::as_str)
                .map(|at| format!("legacy:{at}"))
        })
}

pub(super) fn is_history_tombstone(entry: &Value) -> bool {
    entry
        .get("deletedAt")
        .or_else(|| entry.get("deleted_at"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

/// Keep live entries and per-entry tombstones together. Tombstones prevent an
/// older local history cache on another device from recreating a deleted item
/// after the next sync. They contain no answer text or source excerpt.
pub(super) fn normalized_entries(entries: Vec<Value>) -> Vec<Value> {
    let mut by_id = BTreeMap::<String, Value>::new();
    for mut entry in entries {
        if !entry.is_object()
            || !serde_json::to_string(&entry)
                .map(|value| value.len() <= 32_000)
                .unwrap_or(false)
        {
            continue;
        }
        let Some(id) = history_entry_id(&entry) else {
            continue;
        };
        if is_history_tombstone(&entry) {
            let deleted_at = entry
                .get("deletedAt")
                .or_else(|| entry.get("deleted_at"))
                .and_then(Value::as_str)
                .map(|value| clipped_text(value, 64))
                .filter(|value| !value.is_empty());
            let Some(deleted_at) = deleted_at else {
                continue;
            };
            by_id.insert(
                id.clone(),
                serde_json::json!({ "id": id, "deletedAt": deleted_at }),
            );
            continue;
        }
        entry["id"] = Value::String(id.clone());
        match by_id.get(&id) {
            Some(existing) if is_history_tombstone(existing) => {}
            _ => {
                by_id.insert(id, entry);
            }
        }
    }
    let mut live = by_id
        .values()
        .filter(|entry| !is_history_tombstone(entry))
        .cloned()
        .collect::<Vec<_>>();
    live.sort_by(|left, right| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    let mut tombstones = by_id
        .values()
        .filter(|entry| is_history_tombstone(entry))
        .cloned()
        .collect::<Vec<_>>();
    tombstones.sort_by(|left, right| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);
    live.extend(tombstones);
    live
}

pub(super) fn clipped_text(value: &str, max_bytes: usize) -> String {
    let mut value = value.trim().to_string();
    while value.len() > max_bytes {
        value.pop();
    }
    value
}

/// Select the account-wide cloud subset for per-book AI-reading history.
/// Local per-book history remains available; only the latest records across
/// all books are materialized as sync entities.
pub(super) fn account_history_payloads(
    histories: Vec<(String, Vec<Value>)>,
    sync_mode: &str,
) -> BTreeMap<String, Vec<Value>> {
    let mut live = Vec::<(String, Value)>::new();
    let mut tombstones = Vec::<(String, Value)>::new();
    for (content_id, entries) in histories {
        for entry in normalized_entries(entries) {
            if is_history_tombstone(&entry) {
                tombstones.push((content_id.clone(), entry));
            } else if sync_mode == "recent"
                || entry.get("cloudSaved").and_then(Value::as_bool) == Some(true)
            {
                live.push((content_id.clone(), entry));
            }
        }
    }
    live.sort_by(|(_, left), (_, right)| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    live.truncate(HISTORY_LIVE_LIMIT);
    tombstones.sort_by(|(_, left), (_, right)| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);

    let mut grouped = BTreeMap::<String, Vec<Value>>::new();
    for (content_id, entry) in live.into_iter().chain(tombstones) {
        grouped.entry(content_id).or_default().push(entry);
    }
    grouped
}

/// Library answers are user-owned notes. Sources deliberately exclude
/// `excerpt` and machine-local `bookId`: citations may sync, book-body text and
/// device-local identity may not.
pub(super) fn normalized_library_entries(entries: Vec<Value>) -> Vec<Value> {
    let mut sanitized = Vec::new();
    for entry in entries {
        if is_history_tombstone(&entry) {
            if let Some(id) = history_entry_id(&entry) {
                if let Some(deleted_at) = entry
                    .get("deletedAt")
                    .or_else(|| entry.get("deleted_at"))
                    .and_then(Value::as_str)
                    .map(|value| clipped_text(value, 64))
                    .filter(|value| !value.is_empty())
                {
                    sanitized.push(serde_json::json!({ "id": id, "deletedAt": deleted_at }));
                }
            }
            continue;
        }
        let question = entry
            .get("question")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 4_000))
            .filter(|value| !value.is_empty());
        let content = entry
            .get("content")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 20_000))
            .filter(|value| !value.is_empty());
        let at = entry
            .get("at")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 64))
            .filter(|value| !value.is_empty());
        let (Some(question), Some(content), Some(at)) = (question, content, at) else {
            continue;
        };
        let task = entry
            .get("task")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 32))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "question".to_string());
        let sources = entry
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
                        Some(serde_json::json!({
                            "bookTitle": title,
                            "chapter": chapter,
                            "sourceKind": source_kind,
                        }))
                    })
                    .take(20)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let id = history_entry_id(&entry).unwrap_or_else(|| format!("legacy:{at}"));
        let mut normalized = serde_json::json!({
            "id": id,
            "version": 1,
            "scope": "library",
            "task": task,
            "question": question,
            "content": content,
            "sources": sources,
            "at": at,
        });
        if entry.get("cloudSaved").and_then(Value::as_bool) == Some(true) {
            normalized["cloudSaved"] = Value::Bool(true);
        }
        sanitized.push(normalized);
    }
    normalized_entries(sanitized)
}

/// A local library history may grow without a live-entry cap. Only this
/// compact projection is sent to the cloud, where it remains bounded to 100
/// answers (plus deletion tombstones). In manual mode an answer joins the
/// projection only after the user explicitly selects it.
pub(super) fn cloud_library_history_entries(entries: Vec<Value>, sync_mode: &str) -> Vec<Value> {
    let normalized = normalized_library_entries(entries);
    let mut live = normalized
        .iter()
        .filter(|entry| !is_history_tombstone(entry))
        .filter(|entry| {
            sync_mode == "recent" || entry.get("cloudSaved").and_then(Value::as_bool) == Some(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    live.sort_by(|left, right| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    live.truncate(HISTORY_LIVE_LIMIT);
    let mut tombstones = normalized
        .into_iter()
        .filter(is_history_tombstone)
        .collect::<Vec<_>>();
    tombstones.sort_by(|left, right| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);
    live.extend(tombstones);
    live
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_or_oversized_entries_are_discarded() {
        let oversized = "x".repeat(32_001);
        let normalized = normalized_entries(vec![
            Value::Null,
            serde_json::json!({"question": "missing identity"}),
            serde_json::json!({"id": "too-large", "content": oversized}),
            serde_json::json!({"id": "valid", "content": "answer"}),
        ]);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["id"], "valid");
    }

    #[test]
    fn tombstone_is_minimal_and_wins_regardless_of_input_order() {
        let normalized = normalized_entries(vec![
            serde_json::json!({"id": "one", "deleted_at": " 2026-08-01T00:00:00Z ", "content": "must not survive"}),
            serde_json::json!({"id": "one", "at": "2026-07-31T00:00:00Z", "content": "old"}),
        ]);
        assert_eq!(
            normalized,
            vec![serde_json::json!({
                "id": "one",
                "deletedAt": "2026-08-01T00:00:00Z"
            })]
        );
    }
}
