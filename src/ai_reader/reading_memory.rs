//! Local-only, incremental facts remembered after a chapter is completed.
//!
//! This module deliberately stores model-produced, bounded facts rather than
//! chapter text. It is excluded from reader sync and portable backup because
//! it is derived from the user's private reading progress.

use super::{
    trim_to_chars, Digest, Sha256, MAX_READING_MEMORY_ITEMS, MAX_READING_MEMORY_SUMMARY_CHARS,
    READING_MEMORY_PREFIX,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadingChapterMemory {
    #[serde(default)]
    pub(crate) chapter: u32,
    #[serde(default)]
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) people: Vec<String>,
    #[serde(default)]
    pub(crate) relationship_changes: Vec<String>,
    #[serde(default)]
    pub(crate) events: Vec<String>,
    #[serde(default)]
    pub(crate) timeline: Vec<String>,
    #[serde(default)]
    pub(crate) places_and_organizations: Vec<String>,
    #[serde(default)]
    pub(crate) unresolved_clues: Vec<String>,
    #[serde(default)]
    pub(crate) known_facts: Vec<String>,
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) generated_at: i64,
}

/// Keep SQLite metadata keys free of book ids and other user supplied values.
/// A digest is stable within the local installation and makes per-book prefix
/// scans cheap without exposing titles or paths in debug DB inspection.
pub(crate) fn book_memory_prefix(book_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(book_id.as_bytes());
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{READING_MEMORY_PREFIX}{digest}:")
}

pub(crate) fn chapter_memory_key(book_id: &str, chapter: u32) -> String {
    format!("{}{chapter:08}", book_memory_prefix(book_id))
}

pub(crate) fn normalize_memory(
    chapter: u32,
    model: &str,
    generated_at: i64,
    raw: &str,
) -> ReadingChapterMemory {
    let json = raw
        .find('{')
        .zip(raw.rfind('}'))
        .filter(|(start, end)| start < end)
        .and_then(|(start, end)| {
            serde_json::from_str::<ReadingChapterMemory>(&raw[start..=end]).ok()
        });
    let mut memory = json.unwrap_or_else(|| ReadingChapterMemory {
        summary: trim_to_chars(raw.trim(), MAX_READING_MEMORY_SUMMARY_CHARS),
        ..ReadingChapterMemory::default()
    });
    memory.chapter = chapter;
    memory.model = trim_to_chars(model.trim(), 160);
    memory.generated_at = generated_at;
    memory.summary = trim_to_chars(memory.summary.trim(), MAX_READING_MEMORY_SUMMARY_CHARS);
    memory.people = normalize_items(memory.people, 160);
    memory.relationship_changes = normalize_items(memory.relationship_changes, 260);
    memory.events = normalize_items(memory.events, 300);
    memory.timeline = normalize_items(memory.timeline, 240);
    memory.places_and_organizations = normalize_items(memory.places_and_organizations, 160);
    memory.unresolved_clues = normalize_items(memory.unresolved_clues, 260);
    memory.known_facts = normalize_items(memory.known_facts, 300);
    memory
}

fn normalize_items(items: Vec<String>, max_chars: usize) -> Vec<String> {
    items
        .into_iter()
        .map(|item| trim_to_chars(item.trim(), max_chars))
        .filter(|item| !item.is_empty())
        .take(MAX_READING_MEMORY_ITEMS)
        .collect()
}

/// A bounded projection can be appended to a normal question so later answers
/// can use prior completed chapters without re-reading every byte of the book.
pub(crate) fn memory_context(entries: &[ReadingChapterMemory]) -> String {
    entries
        .iter()
        .map(|entry| {
            let mut parts = Vec::new();
            if !entry.summary.is_empty() {
                parts.push(format!("摘要：{}", entry.summary));
            }
            append(&mut parts, "人物", &entry.people);
            append(&mut parts, "关系变化", &entry.relationship_changes);
            append(&mut parts, "事件", &entry.events);
            append(&mut parts, "时间线", &entry.timeline);
            append(&mut parts, "地点与组织", &entry.places_and_organizations);
            append(&mut parts, "待解线索", &entry.unresolved_clues);
            append(&mut parts, "已知事实", &entry.known_facts);
            format!("[已读第 {} 章记忆] {}", entry.chapter + 1, parts.join("；"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn append(parts: &mut Vec<String>, label: &str, values: &[String]) {
    if !values.is_empty() {
        parts.push(format!("{label}：{}", values.join("、")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_keys_do_not_expose_book_ids() {
        let key = chapter_memory_key("C:\\private\\book.epub", 7);
        assert!(key.starts_with(READING_MEMORY_PREFIX));
        assert!(key.ends_with(":00000007"));
        assert!(!key.contains("book.epub"));
    }

    #[test]
    fn memory_normalization_bounds_and_projects_facts() {
        let memory = normalize_memory(
            2,
            "local-8b",
            42,
            r#"{"summary":"章节推进","people":["甲","乙"],"events":["抵达城堡"]}"#,
        );
        assert_eq!(memory.chapter, 2);
        assert_eq!(memory.model, "local-8b");
        let context = memory_context(&[memory]);
        assert!(context.contains("已读第 3 章记忆"));
        assert!(context.contains("人物：甲、乙"));
    }
}
