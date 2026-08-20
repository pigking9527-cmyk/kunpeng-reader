//! Pure query formulation for local-library retrieval.
//!
//! Search execution, semantic index access, source selection, and all Tauri
//! command handling intentionally remain in the parent module. Keeping this
//! policy here makes the query expansion rules independently testable without
//! involving a book library, model provider, or persisted configuration.

use std::collections::HashSet;

const LOVE_THEME_TRIGGER_TERMS: [&str; 7] =
    ["情爱", "爱情", "恋爱", "爱恋", "感情", "情感", "相思"];

const LOVE_THEME_TERMS: [&str; 20] = [
    "情爱",
    "爱情",
    "爱恋",
    "恋爱",
    "相思",
    "钟情",
    "倾心",
    "爱慕",
    "相爱",
    "恋人",
    "夫妻",
    "夫妇",
    "婚姻",
    "婚嫁",
    "妻子",
    "丈夫",
    "未婚妻",
    "情人",
    "相守",
    "离别",
];

const LOVE_THEME_RETRIEVAL_QUERY: &str =
    "武侠小说中的情爱、爱情、爱恋、相思、夫妻、婚姻与人物关系描写";

pub(super) fn library_theme_terms(question: &str) -> Option<&'static [&'static str]> {
    let question = question.trim();
    LOVE_THEME_TRIGGER_TERMS
        .iter()
        .any(|term| question.contains(term))
        .then_some(&LOVE_THEME_TERMS)
}

pub(super) fn library_retrieval_queries(question: &str) -> Vec<String> {
    let mut queries = vec![question.trim().to_string()];
    if library_theme_terms(question).is_some() {
        queries.push(LOVE_THEME_RETRIEVAL_QUERY.to_string());
    }
    deduplicate_nonempty_queries(queries)
}

pub(super) fn single_book_retrieval_queries(question: &str, title: &str) -> Vec<String> {
    let title = title.trim();
    deduplicate_nonempty_queries([
        question.trim().to_string(),
        format!("《{title}》的全书主要内容、叙述范围与核心主题"),
        format!("《{title}》的重要人物、事件、论点与结论"),
        format!("《{title}》的目录、章节结构、各章主题与全书结论"),
    ])
}

fn deduplicate_nonempty_queries(queries: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    queries
        .into_iter()
        .filter(|query| !query.trim().is_empty())
        .filter(|query| seen.insert(query.trim().to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{library_retrieval_queries, library_theme_terms, single_book_retrieval_queries};

    #[test]
    fn expands_love_theme_questions_with_a_dedicated_semantic_query() {
        let queries = library_retrieval_queries("武侠小说中的情爱有什么特点");
        assert_eq!(queries.len(), 2);
        assert!(queries[1].contains("人物关系描写"));
        assert!(library_theme_terms("感情描写").is_some());
        assert!(library_theme_terms("武侠小说的叙事特点").is_none());
    }

    #[test]
    fn discards_blank_and_duplicate_queries_without_changing_display_text() {
        assert!(library_retrieval_queries("  ").is_empty());

        let queries = single_book_retrieval_queries("南明史写了什么", " 南明史 ");
        assert_eq!(queries.len(), 4);
        assert_eq!(queries[0], "南明史写了什么");
        assert!(queries.iter().any(|query| query.contains("主要内容")));
    }
}
