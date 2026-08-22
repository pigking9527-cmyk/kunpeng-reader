//! Pure evidence-context formatting and citation rules for the local reader.
//!
//! This module does not load books, touch SQLite, invoke a provider, or expose
//! a Tauri command. The parent orchestrates those effects and supplies the
//! already selected local evidence.

use std::collections::HashSet;

use super::{
    trim_to_chars, AiReaderSource, LibraryAnswerLength, MAX_CONTEXT_CHARS,
    MAX_LIBRARY_DEEP_SOURCES, MAX_READING_RETRY_CONTEXT_CHARS,
};

pub(super) fn library_context_entries<'a>(
    entries: impl IntoIterator<Item = (usize, &'a AiReaderSource)>,
) -> String {
    let mut context = String::new();
    let mut remaining = MAX_CONTEXT_CHARS;
    for (source_id, source) in entries {
        if remaining == 0 {
            break;
        }
        let labels = if source.tags.is_empty() {
            String::new()
        } else {
            format!(
                "｜标签：{}",
                source
                    .tags
                    .iter()
                    .take(6)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("、")
            )
        };
        let source_kind = if source.source_kind.is_empty() {
            String::new()
        } else {
            format!("｜材料：{}", source.source_kind)
        };
        let header = format!(
            "[来源 {}｜《{}》｜第 {} 章{}{}｜本地书籍 ID {}]\n",
            source_id,
            source.book_title,
            source.chapter + 1,
            labels,
            source_kind,
            source.book_id
        );
        let header_chars = header.chars().count();
        const ENTRY_SEPARATOR_CHARS: usize = 2;
        if header_chars + ENTRY_SEPARATOR_CHARS >= remaining {
            break;
        }
        let excerpt = trim_to_chars(
            &source.excerpt,
            remaining - header_chars - ENTRY_SEPARATOR_CHARS,
        );
        if excerpt.trim().is_empty() {
            continue;
        }
        context.push_str(&header);
        context.push_str(&excerpt);
        context.push_str("\n\n");
        remaining = remaining
            .saturating_sub(header_chars + excerpt.chars().count() + ENTRY_SEPARATOR_CHARS);
    }
    context
}

pub(super) fn library_context(sources: &[AiReaderSource]) -> String {
    library_context_entries(
        sources
            .iter()
            .enumerate()
            .map(|(index, source)| (index + 1, source)),
    )
}

/// Recommendation can expose up to one hundred locally ranked books. The
/// ordinary evidence context deliberately gives a few sources long excerpts,
/// which would silently omit the tail of such a candidate pool. This compact
/// one-line form budgets space per book so every selected candidate, including
/// the last one, reaches the model within the same privacy-safe context cap.
pub(super) fn library_booklist_candidate_context(sources: &[AiReaderSource]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let per_source_budget = (MAX_CONTEXT_CHARS / sources.len()).max(72);
    let mut context = String::new();
    for (index, source) in sources.iter().enumerate() {
        let title = trim_to_chars(&source.book_title, 32);
        let tags = trim_to_chars(
            &source
                .tags
                .iter()
                .take(4)
                .cloned()
                .collect::<Vec<_>>()
                .join("、"),
            28,
        );
        let prefix = format!(
            "[候选{}｜本地书籍 ID {}｜《{}》{}] ",
            index + 1,
            source.book_id,
            title,
            if tags.is_empty() {
                String::new()
            } else {
                format!("｜标签：{tags}")
            }
        );
        let excerpt_budget = per_source_budget
            .saturating_sub(prefix.chars().count() + 1)
            .max(12);
        let line = format!(
            "{}{}\n",
            prefix,
            trim_to_chars(&source.excerpt, excerpt_budget)
        );
        if context.chars().count() + line.chars().count() > MAX_CONTEXT_CHARS {
            // The fixed title/ID prefix is intentionally retained for every
            // candidate; if unusually long IDs consume the final budget, use
            // a final tightly bounded line rather than dropping the book.
            let remaining = MAX_CONTEXT_CHARS.saturating_sub(context.chars().count());
            if remaining > 0 {
                context.push_str(&trim_to_chars(&line, remaining));
            }
            break;
        }
        context.push_str(&line);
    }
    context
}

pub(super) fn library_context_for_source_ids(
    sources: &[AiReaderSource],
    source_ids: &[usize],
) -> String {
    library_context_entries(source_ids.iter().filter_map(|source_id| {
        sources
            .get(source_id.saturating_sub(1))
            .map(|source| (*source_id, source))
    }))
}

pub(super) fn compact_reading_context_for_source_ids(
    sources: &[AiReaderSource],
    source_ids: &[usize],
) -> String {
    let mut context = String::new();
    let mut remaining = MAX_READING_RETRY_CONTEXT_CHARS;
    for source_id in source_ids.iter().copied().take(3) {
        let Some(source) = sources.get(source_id.saturating_sub(1)) else {
            continue;
        };
        let header = format!(
            "[来源 {}｜第 {} 章｜材料：{}]\n",
            source_id,
            source.chapter + 1,
            source.source_kind
        );
        let header_chars = header.chars().count();
        const ENTRY_SEPARATOR_CHARS: usize = 2;
        if header_chars + ENTRY_SEPARATOR_CHARS >= remaining {
            break;
        }
        let excerpt = trim_to_chars(
            &source.excerpt,
            (remaining - header_chars - ENTRY_SEPARATOR_CHARS).min(1_600),
        );
        if excerpt.trim().is_empty() {
            continue;
        }
        context.push_str(&header);
        context.push_str(&excerpt);
        context.push_str("\n\n");
        remaining = remaining
            .saturating_sub(header_chars + excerpt.chars().count() + ENTRY_SEPARATOR_CHARS);
    }
    context
}

pub(super) fn parse_deep_source_ids(response: &str, source_count: usize) -> Vec<usize> {
    let response = response.trim().trim_matches('`').trim();
    let json = serde_json::from_str::<serde_json::Value>(response).or_else(|_| {
        let start = response
            .find('{')
            .ok_or_else(|| serde_json::Error::io(std::io::Error::other("missing JSON object")))?;
        let end = response
            .rfind('}')
            .ok_or_else(|| serde_json::Error::io(std::io::Error::other("missing JSON object")))?;
        serde_json::from_str(&response[start..=end])
    });
    let Ok(json) = json else {
        return Vec::new();
    };
    let ids = json
        .get("sourceIds")
        .or_else(|| json.get("source_ids"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_u64)
        .filter_map(|id| usize::try_from(id).ok())
        .filter(|id| (1..=source_count).contains(id));
    let mut seen = HashSet::new();
    ids.filter(|id| seen.insert(*id))
        .take(MAX_LIBRARY_DEEP_SOURCES)
        .collect()
}

pub(super) fn fallback_deep_source_ids(source_count: usize) -> Vec<usize> {
    (1..=source_count.min(MAX_LIBRARY_DEEP_SOURCES)).collect()
}

pub(super) fn cited_library_source_ids(answer: &str, source_count: usize) -> Vec<usize> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for (start, _) in answer.match_indices("[来源 ") {
        let after_marker = &answer[start + "[来源 ".len()..];
        let Some(end) = after_marker.find(']') else {
            continue;
        };
        let Ok(id) = after_marker[..end].trim().parse::<usize>() else {
            continue;
        };
        if (1..=source_count).contains(&id) && seen.insert(id) {
            ids.push(id);
        }
    }
    ids
}

pub(super) fn library_answer_has_sufficient_synthesis(
    answer: &str,
    sources: &[AiReaderSource],
    answer_length: LibraryAnswerLength,
) -> bool {
    let available_books = sources
        .iter()
        .map(|source| source.book_id.as_str())
        .collect::<HashSet<_>>();
    if sources.len() < answer_length.required_sources()
        || available_books.len() < answer_length.required_books()
    {
        return true;
    }
    let cited = cited_library_source_ids(answer, sources.len());
    if cited.len() < answer_length.required_sources() {
        return false;
    }
    cited
        .iter()
        .filter_map(|id| sources.get(id.saturating_sub(1)))
        .map(|source| source.book_id.as_str())
        .collect::<HashSet<_>>()
        .len()
        >= answer_length.required_books()
}

pub(super) fn library_question_with_length(
    question: &str,
    answer_length: LibraryAnswerLength,
) -> String {
    format!(
        "{question}\n\n【作答规格】{} 这条规格覆盖提示词中任何冲突的篇幅、依据条数和来源数量要求。",
        answer_length.prompt_specification()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, title: &str, chapter: u32, excerpt: &str) -> AiReaderSource {
        AiReaderSource {
            book_id: id.into(),
            book_title: title.into(),
            chapter,
            excerpt: excerpt.into(),
            source_kind: "正文检索".into(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn context_keeps_original_source_numbers_and_respects_the_budget() {
        let sources = vec![
            source("1", "甲书", 0, &"甲".repeat(MAX_CONTEXT_CHARS)),
            source("2", "乙书", 3, "乙书片段"),
        ];
        let selected = library_context_for_source_ids(&sources, &[2]);
        assert!(selected.contains("[来源 2｜《乙书》｜第 4 章"));
        assert!(!selected.contains("来源 1"));
        assert!(library_context(&sources).chars().count() <= MAX_CONTEXT_CHARS);
    }

    #[test]
    fn source_id_rules_reject_invalid_duplicates_and_require_synthesis_when_available() {
        assert_eq!(
            parse_deep_source_ids("```json\n{\"sourceIds\":[7,2,7,99,0]}\n```", 20),
            vec![7, 2]
        );
        assert_eq!(fallback_deep_source_ids(3), vec![1, 2, 3]);
        let sources = vec![
            source("1", "甲书", 0, "甲"),
            source("2", "乙书", 0, "乙"),
            source("3", "丙书", 0, "丙"),
            source("4", "丁书", 0, "丁"),
        ];
        assert!(library_answer_has_sufficient_synthesis(
            "[来源 1] [来源 2] [来源 3] [来源 4]",
            &sources,
            LibraryAnswerLength::Short
        ));
        assert!(!library_answer_has_sufficient_synthesis(
            "[来源 1]",
            &sources,
            LibraryAnswerLength::Short
        ));
    }
}
