use super::SemBookHits;
use std::collections::HashMap;

pub(super) fn compact_lexical_phrase(query: &str) -> Option<String> {
    let phrase = query
        .trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '《' | '》' | '〈' | '〉'
            )
        })
        .trim();
    let count = phrase.chars().count();
    ((2..=16).contains(&count) && !phrase.chars().any(char::is_whitespace))
        .then(|| phrase.to_lowercase())
}

pub(super) fn lexical_relevance(phrase: &str, text: &str) -> f32 {
    if phrase.is_empty() || text.is_empty() {
        return 0.0;
    }
    let folded = text.to_lowercase();
    if folded.contains(phrase) {
        return 1.0;
    }
    let query_chars = phrase.chars().collect::<Vec<_>>();
    if query_chars.len() < 2 {
        return 0.0;
    }
    let text_chars = folded.chars().collect::<Vec<_>>();
    let bigram_total = query_chars.len() - 1;
    let bigram_matches = query_chars
        .windows(2)
        .filter(|query_pair| text_chars.windows(2).any(|pair| pair == *query_pair))
        .count();
    let char_matches = query_chars
        .iter()
        .filter(|character| text_chars.contains(character))
        .count();
    let bigram_coverage = bigram_matches as f32 / bigram_total as f32;
    let char_coverage = char_matches as f32 / query_chars.len() as f32;
    (bigram_coverage * 0.8 + char_coverage * 0.2).clamp(0.0, 1.0)
}

pub(super) fn hybrid_score(semantic: f32, lexical: f32, compact_phrase: bool) -> f32 {
    let (semantic_weight, lexical_weight) = if compact_phrase {
        (0.65, 0.35)
    } else {
        (0.88, 0.12)
    };
    (semantic.clamp(-1.0, 1.0) * semantic_weight + lexical * lexical_weight).clamp(-1.0, 1.0)
}

/// 融合来自不同检索器的排序，不能直接比较它们的原始分数。RRF 只使用名次，
/// 因此对余弦相似度、全文命中数和后续稀疏检索都稳定；常数 60 是常用的
/// 平滑项，避免一条偶然词面命中压过明显更相关的语义结果。
pub(super) fn apply_rrf(books: &mut [SemBookHits], lexical_ranks: &HashMap<u64, usize>) {
    let dense_ranks: HashMap<u64, usize> = books
        .iter()
        .enumerate()
        .filter_map(|(rank, book)| book.book_id.parse::<u64>().ok().map(|id| (id, rank + 1)))
        .collect();
    for book in books {
        let Ok(id) = book.book_id.parse::<u64>() else {
            continue;
        };
        let dense = dense_ranks
            .get(&id)
            .map(|rank| 1.0 / (60.0 + *rank as f32))
            .unwrap_or(0.0);
        let lexical = lexical_ranks
            .get(&id)
            .map(|rank| 1.0 / (60.0 + *rank as f32))
            .unwrap_or(0.0);
        // 保留少量原始段落分数用于同名次稳定排序；主信号为可比较的排名融合。
        book.score = dense + lexical + book.score.max(0.0) * 0.0001;
    }
}

pub(super) fn rerank_graph_book(book: &mut SemBookHits, lexical_phrase: Option<&str>) {
    let Some(phrase) = lexical_phrase else {
        return;
    };
    for hit in &mut book.hits {
        hit.score = hybrid_score(hit.score, lexical_relevance(phrase, &hit.snippet), true);
    }
    book.hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    book.score = book.hits.first().map(|hit| hit.score).unwrap_or(book.score);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_phrase_accepts_short_terms_and_rejects_sentences() {
        assert_eq!(
            compact_lexical_phrase("“天津教案”").as_deref(),
            Some("天津教案")
        );
        assert_eq!(
            compact_lexical_phrase("天津教案").as_deref(),
            Some("天津教案")
        );
        assert_eq!(compact_lexical_phrase("天津 教案"), None);
        assert_eq!(
            compact_lexical_phrase("请分析天津教案发生的历史背景和影响"),
            None
        );
    }

    #[test]
    fn lexical_relevance_prefers_exact_compound_over_shared_place_name() {
        let exact = lexical_relevance("天津教案", "晚清天津教案的起因与影响");
        let partial = lexical_relevance("天津教案", "天津工业与农业发展");
        let unrelated = lexical_relevance("天津教案", "江南赋税制度");
        assert_eq!(exact, 1.0);
        assert!(exact > partial);
        assert!(partial > unrelated);
    }

    #[test]
    fn hybrid_ranking_can_promote_an_exact_event_name() {
        let exact = hybrid_score(0.48, 1.0, true);
        let generic = hybrid_score(
            0.60,
            lexical_relevance("天津教案", "天津工业与农业发展"),
            true,
        );
        assert!(exact > generic);
    }
}
