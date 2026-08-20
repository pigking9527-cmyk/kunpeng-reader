//! Pure library-classification profile rules.
//!
//! Persistence, model calls, public-catalogue access, and background task
//! orchestration remain in the parent module. Keeping the profile shape and
//! parsing rules here makes their compatibility boundary directly testable.

use crate::background_tasks::BackgroundTaskState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_LIBRARY_PROFILE_TAGS: usize = 12;
const MAX_LIBRARY_PROFILE_TAG_CHARS: usize = 32;
pub(super) const LIBRARY_PROFILE_DIMENSIONS: [&str; 8] = [
    "类别", "时代", "体裁", "篇幅", "主题", "地域", "语言", "用途",
];

/// Local classification scheduling/provenance. The canonical labels are also
/// written to `Book.model_tags`, which sync separately from manual shelf tags.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibraryProfile {
    #[serde(default)]
    pub(super) tags: Vec<String>,
    #[serde(default)]
    pub(super) web_attempted: bool,
    #[serde(default)]
    pub(super) web_enriched: bool,
}

#[derive(Debug, Default)]
pub(super) struct LibraryClassificationDecision {
    pub(super) profile: LibraryProfile,
    pub(super) needs_web_search: bool,
}

fn trim_to_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub(super) fn clean_profile_tag(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let value = trim_to_chars(value.trim(), MAX_LIBRARY_PROFILE_TAG_CHARS);
    // A model label must carry a category and a value, for example
    // “时代：明清” or “体裁：章回体”. This keeps the tag cloud useful and
    // prevents free-form explanations from becoming shelf tags later.
    let (category, detail) = value.split_once(['：', ':'])?;
    let category = category.trim();
    let detail = detail.trim();
    (!category.is_empty() && !detail.is_empty()).then(|| format!("{category}：{detail}"))
}

pub(super) fn profile_missing_dimensions(profile: &LibraryProfile) -> Vec<String> {
    let present = profile
        .tags
        .iter()
        .filter_map(|tag| tag.split_once('：').or_else(|| tag.split_once(':')))
        .map(|(category, _)| category.trim())
        .collect::<HashSet<_>>();
    LIBRARY_PROFILE_DIMENSIONS
        .iter()
        .filter(|dimension| !present.contains(**dimension))
        .map(|dimension| (*dimension).to_string())
        .collect()
}

pub(super) fn profile_has_all_dimensions(profile: &LibraryProfile) -> bool {
    profile_missing_dimensions(profile).is_empty()
}

/// A profile is only settled once all dimensions are present and any requested
/// public-catalogue lookup has reached a durable outcome.
pub(super) fn profile_is_settled(profile: &LibraryProfile) -> bool {
    profile_has_all_dimensions(profile) && profile.web_attempted
}

pub(super) fn library_classification_checkpoint(book_id: &str, phase: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "lastBookId": book_id,
        "phase": phase,
    })
    .to_string()
}

/// A paused classification is deliberately not active: a new request resumes
/// its durable continuation.
pub(super) fn classification_task_blocks_start(state: BackgroundTaskState) -> bool {
    matches!(
        state,
        BackgroundTaskState::Queued | BackgroundTaskState::Running | BackgroundTaskState::Pausing
    )
}

pub(super) fn parse_library_classification_decision(
    response: &str,
) -> Result<LibraryClassificationDecision, String> {
    let response = response.trim().trim_matches('`').trim();
    let json = serde_json::from_str::<serde_json::Value>(response)
        .or_else(|_| {
            let start = response.find('{').ok_or_else(|| {
                serde_json::Error::io(std::io::Error::other("missing JSON object"))
            })?;
            let end = response.rfind('}').ok_or_else(|| {
                serde_json::Error::io(std::io::Error::other("missing JSON object"))
            })?;
            serde_json::from_str(&response[start..=end])
        })
        .map_err(|_| "分类模型没有返回可用 JSON".to_string())?;
    let tags = json
        .get("tags")
        .or_else(|| json.get("labels"))
        .and_then(serde_json::Value::as_array)
        .ok_or("分类模型没有返回 tags 数组")?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter_map(clean_profile_tag)
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let tags = tags
        .into_iter()
        .filter(|tag| seen.insert(tag.to_lowercase()))
        .take(MAX_LIBRARY_PROFILE_TAGS)
        .collect::<Vec<_>>();
    if tags.is_empty() {
        return Err("分类模型没有返回规范的分类标签".into());
    }
    Ok(LibraryClassificationDecision {
        profile: LibraryProfile {
            tags,
            web_attempted: false,
            web_enriched: false,
        },
        needs_web_search: json
            .get("needsWebSearch")
            .or_else(|| json.get("needs_web_search"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_compact_category_labels() {
        let decision = parse_library_classification_decision(
            r#"```json
            {"tags":["类别: 小说", "时代：明清", "这不是分类"],"needsWebSearch":true}
            ```"#,
        )
        .unwrap();
        assert_eq!(decision.profile.tags, ["类别：小说", "时代：明清"]);
        assert!(decision.needs_web_search);
    }

    #[test]
    fn profile_dimensions_and_settlement_are_independent_of_persistence() {
        let incomplete = LibraryProfile {
            tags: vec!["类别：小说".into(), "时代：明清".into()],
            web_attempted: true,
            web_enriched: false,
        };
        assert_eq!(
            profile_missing_dimensions(&incomplete),
            ["体裁", "篇幅", "主题", "地域", "语言", "用途"]
        );
        assert!(!profile_has_all_dimensions(&incomplete));

        let complete = LibraryProfile {
            tags: LIBRARY_PROFILE_DIMENSIONS
                .iter()
                .map(|dimension| format!("{dimension}：待确认"))
                .collect(),
            web_attempted: true,
            web_enriched: false,
        };
        assert!(profile_is_settled(&complete));
    }

    #[test]
    fn preserves_checkpoint_wire_shape_and_resume_gate() {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&library_classification_checkpoint(
                "42", "web"
            ))
            .unwrap(),
            serde_json::json!({"schemaVersion": 1, "lastBookId": "42", "phase": "web"})
        );
        assert!(!classification_task_blocks_start(
            BackgroundTaskState::Paused
        ));
        assert!(classification_task_blocks_start(
            BackgroundTaskState::Queued
        ));
        assert!(classification_task_blocks_start(
            BackgroundTaskState::Running
        ));
    }

    #[test]
    fn rejects_free_form_labels_after_normalization() {
        assert_eq!(
            clean_profile_tag("  主题 :  历史   小说  "),
            Some("主题：历史 小说".into())
        );
        assert_eq!(clean_profile_tag("没有类别的解释"), None);
    }

    #[test]
    fn preserves_profile_storage_field_names_and_defaults() {
        let profile = LibraryProfile {
            tags: vec!["类别：小说".into()],
            web_attempted: true,
            web_enriched: false,
        };
        assert_eq!(
            serde_json::to_value(profile).unwrap(),
            serde_json::json!({
                "tags": ["类别：小说"],
                "webAttempted": true,
                "webEnriched": false,
            })
        );
        let restored = serde_json::from_value::<LibraryProfile>(serde_json::json!({
            "tags": ["类别：小说"]
        }))
        .unwrap();
        assert!(!restored.web_attempted);
        assert!(!restored.web_enriched);
    }
}
