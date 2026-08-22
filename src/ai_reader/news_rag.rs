//! Ephemeral semantic recall for public intelligence candidates.
//!
//! This deliberately is not another book-RAG index.  It embeds a small,
//! bounded news batch in memory, uses the resulting neighbours to refine event
//! clusters, and drops the vectors before returning.  No book ID, book text,
//! semantic shard, global index, sync entity, or cache file participates.

use crate::{semantic, semantic_core::dot, AppState};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

const MAX_INTELLIGENCE_SEMANTIC_CANDIDATES: usize = 120;
const MAX_INTELLIGENCE_SEMANTIC_ID_BYTES: usize = 80;
const MAX_INTELLIGENCE_SEMANTIC_TITLE_BYTES: usize = 480;
const MAX_INTELLIGENCE_SEMANTIC_SUMMARY_BYTES: usize = 1_600;
const MAX_INTELLIGENCE_SEMANTIC_PUBLISHED_AT_BYTES: usize = 80;
const SEMANTIC_EVENT_SIMILARITY: f32 = 0.86;
const SEMANTIC_EVENT_STRONG_SIMILARITY: f32 = 0.93;
const MIN_LEXICAL_JACCARD: f32 = 0.12;
const MIN_STRONG_LEXICAL_JACCARD: f32 = 0.04;
const MAX_EVENT_DATE_DISTANCE_DAYS: i32 = 4;

/// The public, bounded input accepted by the semantic news pass.  It is kept
/// separate from the richer editorial candidate: source URLs and article
/// bodies do not improve vector grouping and are intentionally excluded.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSemanticCandidate {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) published_at: String,
}

/// A deterministic connected event group.  `representative_id` is the first
/// input item in the cluster, so callers retain their existing ranking and do
/// not need to accept an opaque native re-ordering.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSemanticCluster {
    pub(crate) representative_id: String,
    pub(crate) member_ids: Vec<String>,
    pub(crate) semantic_score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSemanticClusterResult {
    pub(crate) clusters: Vec<IntelligenceSemanticCluster>,
}

/// Runs one in-memory semantic recall pass over current public-news
/// candidates.  The already-installed reader semantic model is reused, but a
/// missing model returns an error so the caller can keep its existing rule
/// clustering without triggering a download.
pub(crate) fn cluster_intelligence_news_semantically(
    state: &AppState,
    candidates: &[IntelligenceSemanticCandidate],
) -> Result<IntelligenceSemanticClusterResult, String> {
    validate_candidates(candidates)?;
    let documents = candidates
        .iter()
        .map(candidate_embedding_text)
        .collect::<Vec<_>>();
    let vectors = semantic::embed_public_news_documents(state, &documents)?;
    Ok(cluster_from_vectors(candidates, &vectors))
}

fn validate_candidates(candidates: &[IntelligenceSemanticCandidate]) -> Result<(), String> {
    if candidates.len() < 2 || candidates.len() > MAX_INTELLIGENCE_SEMANTIC_CANDIDATES {
        return Err(format!(
            "资讯语义召回一次只能处理 2–{MAX_INTELLIGENCE_SEMANTIC_CANDIDATES} 条候选"
        ));
    }
    let mut seen = HashSet::with_capacity(candidates.len());
    for candidate in candidates {
        let id = candidate.id.trim();
        if id.is_empty()
            || id.len() > MAX_INTELLIGENCE_SEMANTIC_ID_BYTES
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("资讯语义候选 id 只能使用 1–80 位 ASCII 字母、数字、连字符或下划线".into());
        }
        if !seen.insert(id) {
            return Err("资讯语义候选 id 不能重复".into());
        }
        bounded_nonempty(
            &candidate.title,
            "title",
            MAX_INTELLIGENCE_SEMANTIC_TITLE_BYTES,
        )?;
        bounded_optional(
            &candidate.summary,
            "summary",
            MAX_INTELLIGENCE_SEMANTIC_SUMMARY_BYTES,
        )?;
        if candidate.published_at.len() > MAX_INTELLIGENCE_SEMANTIC_PUBLISHED_AT_BYTES {
            return Err(format!(
                "资讯语义候选的 publishedAt 不能超过 {MAX_INTELLIGENCE_SEMANTIC_PUBLISHED_AT_BYTES} 个字节"
            ));
        }
    }
    Ok(())
}

fn bounded_nonempty(value: &str, field: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("资讯语义候选的 {field} 不能为空"));
    }
    bounded_optional(value, field, max_bytes)
}

fn bounded_optional(value: &str, field: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!(
            "资讯语义候选的 {field} 不能超过 {max_bytes} 个字节"
        ));
    }
    Ok(())
}

fn candidate_embedding_text(candidate: &IntelligenceSemanticCandidate) -> String {
    // Repeating the title gives the short event name a little more weight than
    // a noisy feed excerpt, while still allowing the summary to distinguish
    // otherwise similar headlines.
    format!(
        "{}\n{}\n{}",
        candidate.title.trim(),
        candidate.title.trim(),
        candidate.summary.trim()
    )
}

fn cluster_from_vectors(
    candidates: &[IntelligenceSemanticCandidate],
    vectors: &[Vec<f32>],
) -> IntelligenceSemanticClusterResult {
    if candidates.len() != vectors.len() {
        return IntelligenceSemanticClusterResult {
            clusters: candidates
                .iter()
                .map(|candidate| IntelligenceSemanticCluster {
                    representative_id: candidate.id.clone(),
                    member_ids: vec![candidate.id.clone()],
                    semantic_score: 1.0,
                })
                .collect(),
        };
    }
    let token_sets = candidates
        .iter()
        .map(|candidate| event_tokens(&format!("{} {}", candidate.title, candidate.summary)))
        .collect::<Vec<_>>();
    let mut groups = DisjointSets::new(candidates.len());
    for left in 0..candidates.len() {
        for right in (left + 1)..candidates.len() {
            let similarity = dot(&vectors[left], &vectors[right]).clamp(-1.0, 1.0);
            let lexical = token_jaccard(&token_sets[left], &token_sets[right]);
            if within_event_time_window(&candidates[left], &candidates[right])
                && is_same_event(similarity, lexical)
            {
                groups.union(left, right);
            }
        }
    }

    let mut clusters: Vec<Vec<usize>> = Vec::new();
    let mut cluster_index_by_root = std::collections::BTreeMap::new();
    for index in 0..candidates.len() {
        let root = groups.find(index);
        let cluster_index = if let Some(existing) = cluster_index_by_root.get(&root) {
            *existing
        } else {
            let next = clusters.len();
            clusters.push(Vec::new());
            cluster_index_by_root.insert(root, next);
            next
        };
        clusters[cluster_index].push(index);
    }

    IntelligenceSemanticClusterResult {
        clusters: clusters
            .into_iter()
            .map(|members| {
                let semantic_score = members
                    .iter()
                    .enumerate()
                    .flat_map(|(offset, left)| {
                        members
                            .iter()
                            .skip(offset + 1)
                            .map(move |right| dot(&vectors[*left], &vectors[*right]))
                    })
                    .fold(1.0f32, |best, score| best.min(score.clamp(-1.0, 1.0)));
                IntelligenceSemanticCluster {
                    representative_id: candidates[members[0]].id.clone(),
                    member_ids: members
                        .iter()
                        .map(|index| candidates[*index].id.clone())
                        .collect(),
                    semantic_score,
                }
            })
            .collect(),
    }
}

fn is_same_event(semantic: f32, lexical: f32) -> bool {
    (semantic >= SEMANTIC_EVENT_SIMILARITY && lexical >= MIN_LEXICAL_JACCARD)
        || (semantic >= SEMANTIC_EVENT_STRONG_SIMILARITY && lexical >= MIN_STRONG_LEXICAL_JACCARD)
}

fn event_tokens(value: &str) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    let mut latin = String::new();
    let mut cjk_run = String::new();
    let mut flush = |latin: &mut String, cjk_run: &mut String| {
        if latin.chars().count() >= 2 {
            tokens.insert(std::mem::take(latin).to_ascii_lowercase());
        } else {
            latin.clear();
        }
        let chars = cjk_run.chars().collect::<Vec<_>>();
        if chars.len() == 1 {
            tokens.insert(chars[0].to_string());
        } else {
            for pair in chars.windows(2) {
                tokens.insert(pair.iter().collect());
            }
        }
        cjk_run.clear();
    };
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            if !cjk_run.is_empty() {
                flush(&mut latin, &mut cjk_run);
            }
            latin.push(ch);
        } else if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            if !latin.is_empty() {
                flush(&mut latin, &mut cjk_run);
            }
            cjk_run.push(ch);
        } else {
            flush(&mut latin, &mut cjk_run);
        }
    }
    flush(&mut latin, &mut cjk_run);
    tokens
}

fn token_jaccard(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(right).count() as f32;
    let total = left.union(right).count() as f32;
    if total > 0.0 {
        shared / total
    } else {
        0.0
    }
}

fn within_event_time_window(
    left: &IntelligenceSemanticCandidate,
    right: &IntelligenceSemanticCandidate,
) -> bool {
    match (
        calendar_day(&left.published_at),
        calendar_day(&right.published_at),
    ) {
        (Some(left), Some(right)) => (left - right).abs() <= MAX_EVENT_DATE_DISTANCE_DAYS,
        // Feeds without a valid date remain eligible.  The lexical gate keeps
        // a broad semantic relationship from becoming an accidental merge.
        _ => true,
    }
}

fn calendar_day(value: &str) -> Option<i32> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = std::str::from_utf8(&bytes[0..4])
        .ok()?
        .parse::<i32>()
        .ok()?;
    let month = std::str::from_utf8(&bytes[5..7])
        .ok()?
        .parse::<i32>()
        .ok()?;
    let day = std::str::from_utf8(&bytes[8..10])
        .ok()?
        .parse::<i32>()
        .ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let days_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + days_of_era)
}

fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.rem_euclid(4) == 0
            && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0) =>
        {
            29
        }
        2 => 28,
        _ => 0,
    }
}

struct DisjointSets {
    parents: Vec<usize>,
}

impl DisjointSets {
    fn new(length: usize) -> Self {
        Self {
            parents: (0..length).collect(),
        }
    }

    fn find(&mut self, index: usize) -> usize {
        let parent = self.parents[index];
        if parent != index {
            let root = self.find(parent);
            self.parents[index] = root;
        }
        self.parents[index]
    }

    fn union(&mut self, left: usize, right: usize) {
        let left_root = self.find(left);
        let right_root = self.find(right);
        if left_root != right_root {
            self.parents[right_root] = left_root;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        id: &str,
        title: &str,
        summary: &str,
        published_at: &str,
    ) -> IntelligenceSemanticCandidate {
        IntelligenceSemanticCandidate {
            id: id.into(),
            title: title.into(),
            summary: summary.into(),
            published_at: published_at.into(),
        }
    }

    #[test]
    fn groups_semantic_neighbours_only_with_a_lexical_event_anchor() {
        let candidates = vec![
            candidate(
                "plane-a",
                "阿拉斯加偏远雷达站附近坠机",
                "8 人遇难",
                "2026-08-21",
            ),
            candidate(
                "plane-b",
                "Alaska charter plane crash kills eight",
                "remote radar site",
                "2026-08-21",
            ),
            candidate(
                "market",
                "美国市场关注航空板块",
                "投资者评估运输公司",
                "2026-08-21",
            ),
        ];
        let result = cluster_from_vectors(
            &candidates,
            &[vec![1.0, 0.0], vec![0.99, 0.1], vec![0.99, 0.1]],
        );
        assert_eq!(
            result.clusters.len(),
            3,
            "cross-language lexical guard is intentionally conservative"
        );

        let same_language = vec![
            candidate("a", "阿拉斯加偏远雷达站附近坠机", "8 人遇难", "2026-08-21"),
            candidate(
                "b",
                "阿拉斯加雷达站附近包机坠毁",
                "机上八人死亡",
                "2026-08-21",
            ),
            candidate(
                "c",
                "美国市场关注航空板块",
                "投资者评估运输公司",
                "2026-08-21",
            ),
        ];
        let result = cluster_from_vectors(
            &same_language,
            &[vec![1.0, 0.0], vec![0.99, 0.1], vec![0.99, 0.1]],
        );
        assert_eq!(result.clusters.len(), 2);
        assert_eq!(result.clusters[0].member_ids, ["a", "b"]);
    }

    #[test]
    fn refuses_to_merge_a_similar_but_stale_event() {
        let candidates = vec![
            candidate(
                "recent",
                "阿拉斯加雷达站附近包机坠毁",
                "8 人遇难",
                "2026-08-21",
            ),
            candidate(
                "old",
                "阿拉斯加雷达站附近包机坠毁",
                "8 人遇难",
                "2026-07-21",
            ),
        ];
        let result = cluster_from_vectors(&candidates, &[vec![1.0, 0.0], vec![1.0, 0.0]]);
        assert_eq!(result.clusters.len(), 2);
    }

    #[test]
    fn validates_the_bounded_public_input() {
        let invalid = vec![
            candidate("duplicate", "标题", "", ""),
            candidate("duplicate", "另一个标题", "", ""),
        ];
        assert!(validate_candidates(&invalid).is_err());
        let one = vec![candidate("one", "标题", "", "")];
        assert!(validate_candidates(&one).is_err());
    }

    #[test]
    fn calendar_day_handles_leap_years() {
        assert_eq!(
            calendar_day("2024-02-29"),
            calendar_day("2024-03-01").map(|day| day - 1)
        );
        assert_eq!(calendar_day("2025-02-29"), None);
    }
}
