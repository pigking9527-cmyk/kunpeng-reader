//! Pure spoiler-safe candidate selection for the reading assistant.
//!
//! The parent module owns book I/O, Tauri, state and provider calls. This
//! module only turns already-readable chapter text and an explicit selection
//! into bounded local evidence candidates.

use std::collections::HashSet;

use super::{
    trim_to_chars, AiReaderSource, MAX_CHAPTER_CHARS, MAX_CONTEXT_CHARS,
    MAX_READING_EVIDENCE_SOURCES, MAX_SELECTED_TEXT_CHARS,
};

pub(super) struct ReadingEvidenceInput<'a> {
    pub(super) readable: &'a [String],
    pub(super) current: usize,
    pub(super) question: &'a str,
    pub(super) selected_text: &'a str,
    pub(super) selected_start: Option<usize>,
    pub(super) selected_end: Option<usize>,
    pub(super) book_id: &'a str,
    pub(super) book_title: &'a str,
}

pub(super) fn build_reading_evidence_sources(
    input: ReadingEvidenceInput<'_>,
) -> Vec<AiReaderSource> {
    let ReadingEvidenceInput {
        readable,
        current,
        question,
        selected_text,
        selected_start,
        selected_end,
        book_id,
        book_title,
    } = input;
    let mut sources = Vec::new();
    if !selected_text.is_empty() {
        sources.push(AiReaderSource {
            book_id: book_id.to_string(),
            book_title: book_title.to_string(),
            chapter: current as u32,
            excerpt: selected_text.to_string(),
            source_kind: "当前已选文字".into(),
            tags: Vec::new(),
        });
    }
    if let Some(chapter) = readable.get(current) {
        if let Some(source) = reading_anchor_source(
            chapter,
            selected_start,
            selected_end,
            book_id,
            book_title,
            current,
        ) {
            sources.push(source);
        }
        if let Some(source) = reading_chapter_opening_source(chapter, book_id, book_title, current)
        {
            sources.push(source);
        }
    }
    let (_, lexical_sources) = select_context(
        readable,
        current.min(readable.len().saturating_sub(1)),
        question,
        MAX_CONTEXT_CHARS.saturating_sub(MAX_SELECTED_TEXT_CHARS + 2_600),
        book_id,
        book_title,
    );
    sources.extend(lexical_sources);
    let mut seen = HashSet::new();
    sources.retain(|source| seen.insert(source_key(source)) && !source.excerpt.trim().is_empty());
    sources.truncate(MAX_READING_EVIDENCE_SOURCES);
    sources
}

fn select_context(
    chapters: &[String],
    current: usize,
    question: &str,
    max_context_chars: usize,
    book_id: &str,
    book_title: &str,
) -> (String, Vec<AiReaderSource>) {
    let query = question.trim().to_lowercase();
    let mut ranked: Vec<(usize, i32)> = chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| {
            let haystack = chapter.to_lowercase();
            let hits = (!query.is_empty() && haystack.contains(&query)) as i32 * 10;
            let overlap = query
                .chars()
                .filter(|ch| !ch.is_whitespace() && haystack.contains(*ch))
                .count() as i32;
            (index, hits + overlap + if index == current { 6 } else { 0 })
        })
        .collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let mut total = 0usize;
    let mut context = String::new();
    let mut sources = Vec::new();
    for (index, _) in ranked.into_iter().take(4) {
        if total >= max_context_chars {
            break;
        }
        let excerpt = trim_to_chars(
            &chapters[index],
            MAX_CHAPTER_CHARS.min(max_context_chars - total),
        );
        if excerpt.trim().is_empty() {
            continue;
        }
        total += excerpt.chars().count();
        context.push_str(&format!("\n\n[第 {} 章]\n{}", index + 1, excerpt));
        sources.push(AiReaderSource {
            book_id: book_id.to_string(),
            book_title: book_title.to_string(),
            chapter: index as u32,
            excerpt,
            source_kind: "已读正文检索".into(),
            tags: Vec::new(),
        });
    }
    (context, sources)
}

fn chars_window(value: &str, start: usize, end: usize, padding: usize) -> String {
    let len = value.chars().count();
    if len == 0 {
        return String::new();
    }
    let start = start.min(len);
    let end = end.max(start).min(len);
    let from = start.saturating_sub(padding);
    let to = end.saturating_add(padding).min(len);
    value
        .chars()
        .skip(from)
        .take(to.saturating_sub(from))
        .collect()
}

fn reading_anchor_source(
    chapter: &str,
    start: Option<usize>,
    end: Option<usize>,
    book_id: &str,
    book_title: &str,
    chapter_index: usize,
) -> Option<AiReaderSource> {
    let (start, end) = (start?, end?);
    let excerpt = chars_window(chapter, start, end, 900);
    (!excerpt.trim().is_empty()).then(|| AiReaderSource {
        book_id: book_id.to_string(),
        book_title: book_title.to_string(),
        chapter: chapter_index as u32,
        excerpt,
        source_kind: "选句邻近正文".into(),
        tags: Vec::new(),
    })
}

fn reading_chapter_opening_source(
    chapter: &str,
    book_id: &str,
    book_title: &str,
    chapter_index: usize,
) -> Option<AiReaderSource> {
    let excerpt = trim_to_chars(chapter.trim(), 700);
    (!excerpt.trim().is_empty()).then(|| AiReaderSource {
        book_id: book_id.to_string(),
        book_title: book_title.to_string(),
        chapter: chapter_index as u32,
        excerpt,
        source_kind: "本章开篇（范围提示）".into(),
        tags: Vec::new(),
    })
}

fn source_key(source: &AiReaderSource) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        source.book_id, source.chapter, source.excerpt
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_prefers_current_chapter_and_stays_bounded() {
        let chapters = vec![
            "甲".repeat(5_000),
            "乙乙乙 关键问题".to_string(),
            "丙".repeat(5_000),
        ];
        let (context, sources) =
            select_context(&chapters, 1, "关键问题", MAX_CONTEXT_CHARS, "42", "测试书");
        assert!(context.contains("第 2 章"));
        assert_eq!(sources[0].chapter, 1);
        assert_eq!(sources[0].book_id, "42");
        assert_eq!(sources[0].book_title, "测试书");
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS + 100);
    }

    #[test]
    fn evidence_keeps_selection_neighbours_structure_and_lexical_candidates() {
        let chapters = vec![
            "第一章开篇说明人物甲与城中局势。随后甲离开故乡，决定入城。".repeat(30),
            "第二章开篇。乙说局势危险，甲却坚持前行。后来两人在城门相见并商议退路。".repeat(30),
        ];
        let sources = build_reading_evidence_sources(ReadingEvidenceInput {
            readable: &chapters,
            current: 1,
            question: "局势为什么危险",
            selected_text: "局势危险，甲却坚持前行",
            selected_start: Some(5),
            selected_end: Some(16),
            book_id: "42",
            book_title: "测试书",
        });
        assert!(sources
            .iter()
            .any(|source| source.source_kind == "当前已选文字"));
        assert!(sources
            .iter()
            .any(|source| source.source_kind == "选句邻近正文"));
        assert!(sources
            .iter()
            .any(|source| source.source_kind == "本章开篇（范围提示）"));
        assert!(sources
            .iter()
            .any(|source| source.source_kind == "已读正文检索"));
        assert!(sources.len() <= MAX_READING_EVIDENCE_SOURCES);
    }

    #[test]
    fn bounds_selection_and_deduplicates_empty_or_identical_evidence() {
        let chapters = vec![String::new(), "同一段正文".repeat(2_000)];
        let sources = build_reading_evidence_sources(ReadingEvidenceInput {
            readable: &chapters,
            current: 99,
            question: "",
            selected_text: "",
            selected_start: Some(usize::MAX),
            selected_end: Some(usize::MAX),
            book_id: "42",
            book_title: "测试书",
        });
        assert!(sources
            .iter()
            .all(|source| !source.excerpt.trim().is_empty()));
        assert!(sources.len() <= MAX_READING_EVIDENCE_SOURCES);
        assert!(sources.iter().all(|source| source.chapter <= 1));
    }
}
