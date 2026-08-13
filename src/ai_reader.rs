//! Local BYOK reading assistant. API secrets never enter the sync entity model.
mod commands;
mod context;
mod history;
mod profiles;
mod provider;
mod reading_evidence;
mod retrieval;

use crate::{
    background_tasks::{
        BackgroundTaskKind, BackgroundTaskSnapshot, BackgroundTaskState, TaskControlSignal,
        TaskLogLevel,
    },
    search, secret_store, semantic,
    window_commands::reader_window_id,
    AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    future::Future,
};
use tauri::Manager;
use tokio::sync::watch;

use context::{
    compact_reading_context_for_source_ids, fallback_deep_source_ids,
    library_answer_has_sufficient_synthesis, library_booklist_candidate_context, library_context,
    library_context_for_source_ids, library_question_with_length, parse_deep_source_ids,
};
use history::{matching_local_book_id, restored_source_kind, LocalHistoryBookRef};
use profiles::{
    active_profile, canonicalize_deepseek_config, default_profile_name, has_profile,
    known_provider, normalize_base_url, normalize_profile_assignments, profile_for_purpose,
    profile_summary, status, AiReaderProfileAssignments, AiReaderProfilesStatus, AiReaderStatus,
    AssignAiReaderProfileRequest, SaveAiReaderConfigRequest, SaveAiReaderProfileRequest,
    StoredAiReaderProfile, StoredAiReaderProfiles, StoredConfig,
};
use reading_evidence::{build_reading_evidence_sources, ReadingEvidenceInput};
use retrieval::{library_retrieval_queries, library_theme_terms, single_book_retrieval_queries};

#[doc(hidden)]
pub(crate) use commands::{
    __cmd__ai_reader_profiles, __cmd__ai_reader_status, __cmd__assign_ai_reader_profile,
    __cmd__save_ai_reader_config, __cmd__save_ai_reader_profile, __cmd__select_ai_reader_profile,
};
#[doc(hidden)]
pub(crate) use commands::{
    __tauri_command_name_ai_reader_profiles, __tauri_command_name_ai_reader_status,
    __tauri_command_name_assign_ai_reader_profile, __tauri_command_name_save_ai_reader_config,
    __tauri_command_name_save_ai_reader_profile, __tauri_command_name_select_ai_reader_profile,
};
pub(crate) use commands::{
    ai_reader_profiles, ai_reader_status, assign_ai_reader_profile, save_ai_reader_config,
    save_ai_reader_profile, select_ai_reader_profile,
};

const CONFIG_KEY: &str = "ai_reader_config_protected";
const CONFIG_PROFILES_KEY: &str = "ai_reader_config_profiles_protected:v1";
const MAX_CONTEXT_CHARS: usize = 14_000;
const MAX_CHAPTER_CHARS: usize = 4_500;
const MAX_SELECTED_TEXT_CHARS: usize = 2_400;
const MAX_READING_SESSION_MEMORY_CHARS: usize = 2_800;
const MAX_READING_EVIDENCE_SOURCES: usize = 8;
const MAX_LIBRARY_QUESTION_CHARS: usize = 2_000;
const MAX_LIBRARY_COMPARE_BOOKS: usize = 8;
const MAX_LIBRARY_QUESTION_SOURCES: usize = 20;
const DEFAULT_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT: usize = 20;
const MIN_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT: usize = 5;
const MAX_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT: usize = 100;
const DEFAULT_LIBRARY_RECOMMENDATION_RESULT_LIMIT: usize = 12;
const MIN_LIBRARY_RECOMMENDATION_RESULT_LIMIT: usize = 5;
const MAX_LIBRARY_RECOMMENDATION_RESULT_LIMIT: usize = 30;
const MAX_LIBRARY_DEEP_SOURCES: usize = 10;
/// The three existing answer lengths also control how much surrounding prose
/// the final answer may read. Short keeps its compact citation unchanged.
const LIBRARY_MEDIUM_SOURCE_CONTEXT_CHARS: usize = 800;
const LIBRARY_LONG_SOURCE_CONTEXT_CHARS: usize = 1_200;

// Whole-library questions should synthesize evidence, rather than turn one
// highly-ranked paragraph into a conclusion about an entire genre.
const MIN_LIBRARY_SYNTHESIS_SOURCES: usize = 4;
const MIN_LIBRARY_SYNTHESIS_BOOKS: usize = 3;
const TARGET_LIBRARY_SYNTHESIS_SOURCES: usize = 6;
const MAX_LIBRARY_SINGLE_BOOK_SOURCES: usize = 12;
const MAX_LIBRARY_SINGLE_BOOK_STRUCTURE_SOURCES: usize = 4;
const MAX_LIBRARY_SINGLE_BOOK_CANDIDATE_HITS: usize = 36;
const HISTORY_SOURCE_PREVIEW_CHARS: usize = 1_200;
const MAX_LIBRARY_COMPARE_SOURCES: usize = 8;
const MAX_LIBRARY_COMPARE_SOURCES_PER_BOOK: usize = 2;
// 书库问答会先筛选证据、再生成回答、最后做引用自检。公共模型在高峰期
// 仅排队到首字节就可能超过 45 秒，因此要给每个独立阶段足够的响应窗口。
const READING_PROVIDER_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const READING_PROVIDER_MAX_TOKENS: u16 = 1_600;
// Deep reasoning models may consume most of a small completion allowance
// before emitting `content`. Whole-library synthesis needs room for both that
// hidden reasoning and a cited final answer; ordinary reading tasks remain at
// the smaller budget.
const LIBRARY_SYNTHESIS_PROVIDER_MAX_TOKENS: u16 = 4_096;
// The first pass may include several kinds of evidence. When a compatible
// provider accepts the request but returns an empty completion, retry once
// with only the strongest compact evidence instead of making the reader lose
// an otherwise answerable question.
const MAX_READING_RETRY_CONTEXT_CHARS: usize = 4_800;
const LIBRARY_REQUEST_CANCELLED: &str = "书库问答已取消";
const LIBRARY_PROFILE_PREFIX: &str = "library_ai_profile:v2:";
const LIBRARY_MODEL_TAGS_ENABLED_KEY: &str = "library_ai_use_model_tags:v1";
const LIBRARY_ANSWER_LENGTH_KEY: &str = "library_ai_answer_length:v1";
const LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT_KEY: &str =
    "library_ai_recommendation_candidate_limit:v1";
const LIBRARY_RECOMMENDATION_RESULT_LIMIT_KEY: &str = "library_ai_recommendation_result_limit:v1";
const MAX_LIBRARY_PROFILE_TAGS: usize = 12;
const MAX_LIBRARY_PROFILE_TAG_CHARS: usize = 32;
const MAX_LIBRARY_WEB_PAGE_CHARS: usize = 2_400;
const LIBRARY_WEB_LOOKUP_EVERY_BOOKS: usize = 6;
const LIBRARY_WEB_LOOKUP_DELAY: std::time::Duration = std::time::Duration::from_millis(850);
const LIBRARY_PROFILE_DIMENSIONS: [&str; 8] = [
    "类别", "时代", "体裁", "篇幅", "主题", "地域", "语言", "用途",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderAskRequest {
    /// question | summary | mindmap
    task: String,
    question: String,
    /// 阅读页刚刚上报的位置。它比节流写入数据库的进度更及时。
    #[serde(default)]
    current_chapter: Option<u32>,
    #[serde(default)]
    current_fraction: Option<f32>,
    /// 用户在当前阅读页明确选中的文字，属于已阅读内容而非整书内容。
    #[serde(default)]
    selected_text: Option<String>,
    /// The character offsets are supplied by the reader page together with the
    /// explicit selection. They let us retrieve nearby prose rather than
    /// treating a selected sentence as an isolated search query.
    #[serde(default)]
    selected_start: Option<usize>,
    #[serde(default)]
    selected_end: Option<usize>,
    /// A short, local-only recap of this reader session. It is intentionally
    /// not persisted in or restored from sync history.
    #[serde(default)]
    session_memory: String,
}

/// Local-library RAG request used by the main-window assistant.
///
/// With no `selectedBookIds`, `question` searches the complete locally
/// indexed library. Supplying one id scopes the answer to one book;
/// `compare` requires at least two selected ids. Book files and embeddings are
/// never sent to the sync service: only the small retrieved excerpts below are
/// sent to the user's configured BYOK provider.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryAiReaderAskRequest {
    /// question | compare
    task: String,
    question: String,
    #[serde(default)]
    selected_book_ids: Vec<String>,
    /// A renderer-generated, local-only operation id. It is deliberately not
    /// persisted or included in history/sync payloads.
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryAiReaderCancelRequest {
    request_id: String,
}

/// Whole-library answer length is a local preference, deliberately separate
/// from synced AI service configuration and saved question history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LibraryAnswerLength {
    #[default]
    Short,
    Medium,
    Long,
}

impl LibraryAnswerLength {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "short" => Some(Self::Short),
            "medium" => Some(Self::Medium),
            "long" => Some(Self::Long),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::Medium => "medium",
            Self::Long => "long",
        }
    }

    pub(super) fn source_limit(self) -> usize {
        match self {
            Self::Short => TARGET_LIBRARY_SYNTHESIS_SOURCES,
            Self::Medium => 7,
            Self::Long => MAX_LIBRARY_DEEP_SOURCES,
        }
    }

    pub(super) fn required_books(self) -> usize {
        match self {
            Self::Short => MIN_LIBRARY_SYNTHESIS_BOOKS,
            Self::Medium => 4,
            Self::Long => 5,
        }
    }

    pub(super) fn required_sources(self) -> usize {
        match self {
            Self::Short => MIN_LIBRARY_SYNTHESIS_SOURCES,
            Self::Medium => 6,
            Self::Long => 8,
        }
    }

    pub(super) fn prompt_specification(self) -> &'static str {
        match self {
            Self::Short => {
                "以 700 个汉字以内为目标；关键依据 4—6 条。材料足够时，至少使用 3 部作品、4 个不同来源；解读 2—3 句。"
            }
            Self::Medium => {
                "以 1,300 个汉字以内为目标；关键依据 6—8 条。材料足够时，至少使用 4 部作品、6 个不同来源；解读扩展为 3—4 句，并新增 ## 延展观点，以 2—3 条讨论作品之间的异同、张力或限制。"
            }
            Self::Long => {
                "以 2,100 个汉字以内为目标；关键依据 8—10 条。材料足够时，至少使用 5 部作品、8 个不同来源；解读扩展为 4—6 句，并新增 ## 延展观点（3—5 条）和 ## 边界与反例（1—2 条），分别讨论更丰富的联系与证据边界。"
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryAnswerSettings {
    pub answer_length: LibraryAnswerLength,
    pub recommendation_candidate_limit: usize,
    pub recommendation_result_limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetLibraryAnswerLengthRequest {
    answer_length: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetLibraryRecommendationCandidateLimitRequest {
    candidate_limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetLibraryRecommendationResultLimitRequest {
    result_limit: usize,
}

/// A local-only fallback for older library-Q&A history.  Earlier history
/// versions intentionally synchronized only a title/chapter reference, not
/// book text.  If such a record is opened on the same shelf again, this reads
/// the referenced local chapter so the citation remains usable without ever
/// putting its text into sync storage.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistorySourcePreviewRequest {
    book_id: String,
    #[serde(default)]
    book_title: String,
    chapter: u32,
    #[serde(default)]
    source_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderSource {
    /// Local library id, used by the UI to open the cited chapter. It is not a
    /// cross-device sync identifier and is never uploaded by this command.
    pub(super) book_id: String,
    pub(super) book_title: String,
    pub(super) chapter: u32,
    pub(super) excerpt: String,
    /// Describes how the local excerpt was selected, for example a directory
    /// entry, a chapter opening, or a semantic body passage.
    #[serde(default)]
    pub(super) source_kind: String,
    /// Local AI classification labels are retrieval hints, never source text.
    #[serde(default)]
    pub(super) tags: Vec<String>,
}

struct SingleBookDepthResults {
    semantic_results: Vec<semantic::SemBookHits>,
    structure_sources: Vec<AiReaderSource>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderAnswer {
    ok: bool,
    content: String,
    sources: Vec<AiReaderSource>,
    #[serde(default)]
    single_book: bool,
    /// The stages actually used for this answer. The reader surface renders
    /// this as provenance rather than pretending every answer used the same
    /// opaque one-shot prompt.
    #[serde(default)]
    retrieval_stages: Vec<String>,
    #[serde(default)]
    citation_checked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recommendation: Option<LibraryBooklistRecommendation>,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryBooklistRecommendationItem {
    book_id: String,
    title: String,
    review: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryBooklistRecommendation {
    summary: String,
    items: Vec<LibraryBooklistRecommendationItem>,
}

/// Local classification scheduling/provenance.  The canonical labels are also
/// written to `Book.model_tags`, which sync as a separate entity; they never
/// enter the reader's manual `Book.tags` organization.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LibraryProfile {
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    web_attempted: bool,
    #[serde(default)]
    web_enriched: bool,
}

#[derive(Debug, Default)]
struct LibraryClassificationDecision {
    profile: LibraryProfile,
    needs_web_search: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryProfileCoverageStatus {
    total_books: u64,
    incomplete_books: u64,
    web_pending_books: u64,
    missing_dimensions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryModelTagsSettings {
    enabled: bool,
}

fn trim_to_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect::<String>()
}

fn library_profile_key(book_id: &str) -> String {
    format!("{LIBRARY_PROFILE_PREFIX}{book_id}")
}

fn clean_profile_tag(value: &str) -> Option<String> {
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

fn profile_missing_dimensions(profile: &LibraryProfile) -> Vec<String> {
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

fn profile_has_all_dimensions(profile: &LibraryProfile) -> bool {
    profile_missing_dimensions(profile).is_empty()
}

/// A profile is only considered settled once its eight dimensions are present
/// and any requested public-catalogue lookup has reached a durable outcome.
/// This exact predicate is also used to reconstruct a classification run after
/// interruption, so saved books are never sent through the local model again.
fn profile_is_settled(profile: &LibraryProfile) -> bool {
    profile_has_all_dimensions(profile) && profile.web_attempted
}

fn library_classification_checkpoint(book_id: &str, phase: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "lastBookId": book_id,
        "phase": phase,
    })
    .to_string()
}

/// A paused classification is deliberately *not* considered active here: the
/// next click must call `enqueue_or_resume` and launch its durable continuation.
fn classification_task_blocks_start(state: BackgroundTaskState) -> bool {
    matches!(
        state,
        BackgroundTaskState::Queued | BackgroundTaskState::Running | BackgroundTaskState::Pausing
    )
}

fn parse_library_classification_decision(
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

fn load_library_profiles(state: &AppState) -> Result<HashMap<String, LibraryProfile>, String> {
    let entries = state.with_db_read("ai_reader_load_library_profiles", |db| {
        db.metadata_with_prefix(LIBRARY_PROFILE_PREFIX)
    })?;
    Ok(entries
        .into_iter()
        .filter_map(|(key, value)| {
            let book_id = key.strip_prefix(LIBRARY_PROFILE_PREFIX)?.to_string();
            let profile = serde_json::from_str::<LibraryProfile>(&value).ok()?;
            (!profile.tags.is_empty()).then_some((book_id, profile))
        })
        .collect())
}

fn model_tags_enabled(state: &AppState) -> Result<bool, String> {
    state.with_db_read("ai_reader_model_tags_enabled", |db| {
        Ok(db.metadata(LIBRARY_MODEL_TAGS_ENABLED_KEY).as_deref() != Some("false"))
    })
}

fn model_tags_by_book(state: &AppState) -> Result<HashMap<String, Vec<String>>, String> {
    let library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    Ok(library
        .books
        .iter()
        .filter(|book| !book.model_tags.is_empty())
        .map(|book| (book.id.to_string(), book.model_tags.clone()))
        .collect())
}

fn library_profile_coverage(state: &AppState) -> Result<LibraryProfileCoverageStatus, String> {
    let books = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?
        .books
        .clone();
    let profiles = load_library_profiles(state)?;
    let mut incomplete_books = 0_u64;
    let mut web_pending_books = 0_u64;
    let mut missing_dimensions = BTreeMap::<String, u64>::new();
    for book in &books {
        match profiles.get(&book.id.to_string()).cloned().or_else(|| {
            (!book.model_tags.is_empty()).then(|| LibraryProfile {
                tags: book.model_tags.clone(),
                web_attempted: true,
                web_enriched: false,
            })
        }) {
            Some(profile) => {
                let missing = profile_missing_dimensions(&profile);
                if !missing.is_empty() {
                    incomplete_books += 1;
                    for dimension in missing {
                        *missing_dimensions.entry(dimension).or_default() += 1;
                    }
                }
                if !profile.web_attempted {
                    web_pending_books += 1;
                }
            }
            None => {
                incomplete_books += 1;
                for dimension in LIBRARY_PROFILE_DIMENSIONS {
                    *missing_dimensions.entry(dimension.to_string()).or_default() += 1;
                }
            }
        }
    }
    Ok(LibraryProfileCoverageStatus {
        total_books: books.len() as u64,
        incomplete_books,
        web_pending_books,
        missing_dimensions: missing_dimensions.into_keys().collect(),
    })
}

/// Move pre-existing local classification cache entries into the portable
/// model-tag field before a sync pass. This is intentionally independent of
/// the local "use model tags" switch: disabling use must never discard or
/// suppress a tag that another device can later opt into.
pub(crate) fn materialize_library_profiles_into_model_tags(
    state: &AppState,
) -> Result<u64, String> {
    let profiles = load_library_profiles(state)?;
    if profiles.is_empty() {
        return Ok(0);
    }
    let mut library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let mut changed = 0_u64;
    for book in library.books.clone() {
        if let Some(profile) = profiles.get(&book.id.to_string()) {
            if library.set_model_tags(book.id, profile.tags.clone()) {
                changed += 1;
            }
        }
    }
    if changed > 0 {
        library.save()?;
    }
    Ok(changed)
}

fn tag_value(tag: &str) -> &str {
    tag.split_once('：')
        .or_else(|| tag.split_once(':'))
        .map(|(_, value)| value.trim())
        .unwrap_or(tag)
}

fn matched_profile_tags(question: &str, tags: &[String]) -> Vec<String> {
    let question = question.to_lowercase();
    tags.iter()
        .filter(|tag| {
            let value = tag_value(tag).to_lowercase();
            value.chars().count() >= 2 && question.contains(&value)
        })
        .cloned()
        .collect()
}

fn boost_results_with_profiles(
    results: &mut [semantic::SemBookHits],
    question: &str,
    profiles: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut matched = BTreeMap::<String, usize>::new();
    for result in results.iter_mut() {
        let tags = profiles
            .get(&result.book_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let hits = matched_profile_tags(question, tags);
        for tag in &hits {
            *matched.entry(tag.clone()).or_default() += 1;
        }
        // Keep semantic relevance dominant while allowing a precise metadata
        // match (era, genre, form, length…) to break otherwise weak ties.
        result.score += (hits.len().min(4) as f32) * 0.075;
    }
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    matched.into_keys().collect()
}

fn load_legacy_config(db: &crate::db::AppDb) -> Result<StoredConfig, String> {
    let protected = db.metadata(CONFIG_KEY).unwrap_or_default();
    if protected.is_empty() {
        return Ok(StoredConfig::default());
    }
    let json = secret_store::unprotect_secret(&protected)?;
    serde_json::from_str(&json).map_err(|error| format!("阅读助手配置损坏：{error}"))
}

fn load_profiles(db: &crate::db::AppDb) -> Result<StoredAiReaderProfiles, String> {
    let protected = db.metadata(CONFIG_PROFILES_KEY).unwrap_or_default();
    if !protected.is_empty() {
        let json = secret_store::unprotect_secret(&protected)?;
        let mut store: StoredAiReaderProfiles = serde_json::from_str(&json)
            .map_err(|error| format!("阅读助手配置列表损坏：{error}"))?;
        store
            .profiles
            .retain(|profile| !profile.id.trim().is_empty());
        if store.active_id.is_empty()
            || !store
                .profiles
                .iter()
                .any(|profile| profile.id == store.active_id)
        {
            store.active_id = store
                .profiles
                .first()
                .map(|profile| profile.id.clone())
                .unwrap_or_default();
        }
        normalize_profile_assignments(&mut store);
        return Ok(store);
    }
    let legacy = load_legacy_config(db)?;
    if legacy.provider.is_empty()
        && legacy.base_url.is_empty()
        && legacy.model.is_empty()
        && legacy.api_key.is_empty()
    {
        return Ok(StoredAiReaderProfiles::default());
    }
    Ok(StoredAiReaderProfiles {
        active_id: "default".to_string(),
        assignments: AiReaderProfileAssignments {
            reading_id: "default".to_string(),
            library_id: "default".to_string(),
            other_id: "default".to_string(),
        },
        profiles: vec![StoredAiReaderProfile {
            id: "default".to_string(),
            name: default_profile_name(&legacy),
            config: legacy,
        }],
    })
}

fn persist_profiles(db: &crate::db::AppDb, store: &StoredAiReaderProfiles) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|error| error.to_string())?;
    db.set_metadata(CONFIG_PROFILES_KEY, &secret_store::protect_secret(&json)?)?;
    // Keep the active profile mirrored at the legacy key so older private-sync
    // payloads and clients retain their existing single-config semantics.
    if let Some(profile) = active_profile(store) {
        let json = serde_json::to_string(&profile.config).map_err(|error| error.to_string())?;
        db.set_metadata(CONFIG_KEY, &secret_store::protect_secret(&json)?)?;
    }
    Ok(())
}

fn load_config(db: &crate::db::AppDb) -> Result<StoredConfig, String> {
    load_config_for_purpose(db, "reading")
}

fn load_config_for_purpose(db: &crate::db::AppDb, purpose: &str) -> Result<StoredConfig, String> {
    Ok(profile_for_purpose(&load_profiles(db)?, purpose)
        .map(|profile| profile.config.clone())
        .unwrap_or_default())
}

/// Portable configuration deliberately omits the credential. It is safe to
/// sync by default and lets another device prefill the selected service.
pub(crate) fn export_public_config(
    db: &crate::db::AppDb,
) -> Result<Option<serde_json::Value>, String> {
    let config = canonicalize_deepseek_config(load_config(db)?);
    if config.base_url.is_empty() && config.model.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({
        "version": 1,
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
    })))
}

pub(crate) fn import_public_config(
    db: &crate::db::AppDb,
    value: &serde_json::Value,
) -> Result<(), String> {
    let provider = value
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let base_url = value
        .get("baseUrl")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let model = value
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if base_url.is_empty() || model.is_empty() {
        return Ok(());
    }
    let mut profiles = load_profiles(db)?;
    let active_id = profiles.active_id.clone();
    if let Some(current) = profiles
        .profiles
        .iter_mut()
        .find(|profile| profile.id == active_id)
    {
        current.config.provider = known_provider(provider).to_string();
        current.config.base_url = normalize_base_url(base_url)?;
        current.config.model = model.trim().to_string();
        current.config = canonicalize_deepseek_config(current.config.clone());
        if current.name.trim().is_empty() {
            current.name = default_profile_name(&current.config);
        }
    } else {
        let config = canonicalize_deepseek_config(StoredConfig {
            provider: provider.to_string(),
            base_url: normalize_base_url(base_url)?,
            model: model.trim().to_string(),
            api_key: String::new(),
        });
        profiles.active_id = "default".to_string();
        profiles.profiles.push(StoredAiReaderProfile {
            id: "default".to_string(),
            name: default_profile_name(&config),
            config,
        });
    }
    normalize_profile_assignments(&mut profiles);
    persist_profiles(db, &profiles)
}

pub(crate) fn export_secret_config(
    db: &crate::db::AppDb,
) -> Result<Option<serde_json::Value>, String> {
    let config = canonicalize_deepseek_config(load_config(db)?);
    if config.api_key.is_empty() {
        return Ok(None);
    }
    serde_json::to_value(config)
        .map(Some)
        .map_err(|e| e.to_string())
}

fn config_from_secret_bundle(
    current: &StoredConfig,
    value: &serde_json::Value,
) -> Result<Option<StoredConfig>, String> {
    // Android deliberately puts only api_key into the encrypted envelope. Its
    // provider/base/model values are public sync data, so merge that lightweight
    // package with the current configuration instead of requiring desktop-only
    // StoredConfig fields.
    let api_key = value
        .get("api_key")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if api_key.is_empty() {
        return Ok(None);
    }
    let provider = value
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&current.provider);
    let base_url = value
        .get("base_url")
        .or_else(|| value.get("baseUrl"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&current.base_url);
    let model = value
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&current.model);
    let base_url = if base_url.trim().is_empty() {
        "https://api.deepseek.com/v1"
    } else {
        base_url
    };
    let model = if model.trim().is_empty() {
        "deepseek-v4-flash"
    } else {
        model
    };
    Ok(Some(canonicalize_deepseek_config(StoredConfig {
        provider: provider.to_string(),
        base_url: normalize_base_url(base_url)?,
        model: model.trim().to_string(),
        api_key: api_key.to_string(),
    })))
}

pub(crate) fn import_secret_config(
    db: &crate::db::AppDb,
    value: &serde_json::Value,
) -> Result<(), String> {
    let current = load_config(db)?;
    let Some(config) = config_from_secret_bundle(&current, value)? else {
        return Ok(());
    };
    let mut profiles = load_profiles(db)?;
    let active_id = profiles.active_id.clone();
    if let Some(current) = profiles
        .profiles
        .iter_mut()
        .find(|profile| profile.id == active_id)
    {
        current.config = config;
        if current.name.trim().is_empty() {
            current.name = default_profile_name(&current.config);
        }
    } else {
        profiles.active_id = "default".to_string();
        profiles.profiles.push(StoredAiReaderProfile {
            id: "default".to_string(),
            name: default_profile_name(&config),
            config,
        });
    }
    normalize_profile_assignments(&mut profiles);
    persist_profiles(db, &profiles)
}

fn ai_reader_status_inner(state: &AppState) -> Result<AiReaderStatus, String> {
    state.with_db_read("ai_reader_status", |db| {
        Ok(status(&canonicalize_deepseek_config(load_config(db)?)))
    })
}

fn ai_reader_profiles_inner(state: &AppState) -> Result<AiReaderProfilesStatus, String> {
    state.with_db_read("ai_reader_profiles", |db| {
        let profiles = load_profiles(db)?;
        Ok(AiReaderProfilesStatus {
            active_id: profiles.active_id,
            assignments: profiles.assignments,
            profiles: profiles.profiles.iter().map(profile_summary).collect(),
        })
    })
}

fn select_ai_reader_profile_inner(state: &AppState, id: String) -> Result<AiReaderStatus, String> {
    let id = id.trim();
    state.with_db_write("ai_reader_select_profile", |db| {
        let mut profiles = load_profiles(db)?;
        let profile = profiles
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .ok_or("找不到所选大模型配置")?;
        let selected_id = profile.id.clone();
        let config = canonicalize_deepseek_config(profile.config.clone());
        profiles.active_id = selected_id.clone();
        profiles.assignments.reading_id = selected_id;
        normalize_profile_assignments(&mut profiles);
        persist_profiles(db, &profiles)?;
        Ok(status(&config))
    })
}

fn assign_ai_reader_profile_inner(
    state: &AppState,
    request: AssignAiReaderProfileRequest,
) -> Result<AiReaderProfilesStatus, String> {
    let purpose = request.purpose.trim();
    if !matches!(purpose, "reading" | "library" | "other") {
        return Err("不支持的大模型用途".into());
    }
    let id = request.id.trim();
    state.with_db_write("ai_reader_assign_profile", |db| {
        let mut profiles = load_profiles(db)?;
        if !has_profile(&profiles, id) {
            return Err("找不到所选大模型配置".into());
        }
        match purpose {
            "reading" => profiles.assignments.reading_id = id.to_string(),
            "library" => profiles.assignments.library_id = id.to_string(),
            "other" => profiles.assignments.other_id = id.to_string(),
            _ => unreachable!(),
        }
        normalize_profile_assignments(&mut profiles);
        persist_profiles(db, &profiles)?;
        Ok(AiReaderProfilesStatus {
            active_id: profiles.active_id,
            assignments: profiles.assignments,
            profiles: profiles.profiles.iter().map(profile_summary).collect(),
        })
    })
}

fn save_ai_reader_profile_inner(
    state: &AppState,
    request: SaveAiReaderProfileRequest,
) -> Result<AiReaderProfilesStatus, String> {
    let name = trim_to_chars(request.name.trim(), 80);
    if name.is_empty() {
        return Err("请填写配置名称".into());
    }
    let mut config = canonicalize_deepseek_config(StoredConfig {
        provider: request.provider,
        base_url: normalize_base_url(&request.base_url)?,
        model: request.model.trim().to_string(),
        api_key: request.api_key.trim().to_string(),
    });
    if config.model.is_empty() {
        return Err("请填写模型名".into());
    }
    if config.model.len() > 200 || config.api_key.len() > 2_000 {
        return Err("模型名或 API Key 过长".into());
    }
    state.with_db_write("ai_reader_save_profile", |db| {
        let mut profiles = load_profiles(db)?;
        let id = if request.id.trim().is_empty() {
            format!("profile-{}", crate::runtime_support::now_ms())
        } else {
            request.id.trim().to_string()
        };
        if let Some(existing) = profiles
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
        {
            if config.api_key.is_empty() {
                config.api_key = existing.config.api_key.clone();
            }
            existing.name = name;
            existing.config = config;
        } else {
            if config.api_key.is_empty() {
                return Err("请填写 API Key".into());
            }
            profiles.profiles.push(StoredAiReaderProfile {
                id: id.clone(),
                name,
                config,
            });
        }
        profiles.active_id = id.clone();
        profiles.assignments.reading_id = id;
        normalize_profile_assignments(&mut profiles);
        persist_profiles(db, &profiles)?;
        Ok(AiReaderProfilesStatus {
            active_id: profiles.active_id,
            assignments: profiles.assignments,
            profiles: profiles.profiles.iter().map(profile_summary).collect(),
        })
    })
}

fn save_ai_reader_config_inner(
    state: &AppState,
    request: SaveAiReaderConfigRequest,
) -> Result<AiReaderStatus, String> {
    let config = canonicalize_deepseek_config(StoredConfig {
        provider: request.provider,
        base_url: normalize_base_url(&request.base_url)?,
        model: request.model.trim().to_string(),
        api_key: request.api_key.trim().to_string(),
    });
    if config.model.is_empty() || config.api_key.is_empty() {
        return Err("请填写模型名和 API Key".into());
    }
    if config.model.len() > 200 || config.api_key.len() > 2_000 {
        return Err("模型名或 API Key 过长".into());
    }
    state.with_db_write("ai_reader_save_config", |db| {
        let mut profiles = load_profiles(db)?;
        let active_id = profiles.active_id.clone();
        if let Some(profile) = profiles
            .profiles
            .iter_mut()
            .find(|profile| profile.id == active_id)
        {
            profile.config = config.clone();
            if profile.name.trim().is_empty() {
                profile.name = default_profile_name(&config);
            }
        } else {
            profiles.active_id = "default".to_string();
            profiles.profiles.push(StoredAiReaderProfile {
                id: "default".to_string(),
                name: default_profile_name(&config),
                config: config.clone(),
            });
        }
        normalize_profile_assignments(&mut profiles);
        persist_profiles(db, &profiles)?;
        Ok(status(&config))
    })
}

fn normalize_selected_book_ids(
    ids: Vec<String>,
    max_books: Option<usize>,
) -> Result<Option<Vec<String>>, String> {
    let mut unique = HashSet::new();
    let mut normalized = Vec::new();
    for raw_id in ids {
        let id = raw_id
            .trim()
            .parse::<u64>()
            .map_err(|_| "图书范围中包含无效的图书 ID".to_string())?
            .to_string();
        if unique.insert(id.clone()) {
            normalized.push(id);
        }
    }
    if let Some(max_books) = max_books.filter(|max| normalized.len() > *max) {
        return Err(format!("一次最多选择 {max_books} 本图书"));
    }
    Ok((!normalized.is_empty()).then_some(normalized))
}

fn explicit_book_titles(question: &str) -> Vec<String> {
    let mut rest = question;
    let mut titles = Vec::new();
    while let Some(start) = rest.find('《') {
        let after_start = &rest[start + '《'.len_utf8()..];
        let Some(end) = after_start.find('》') else {
            break;
        };
        let title = after_start[..end].trim();
        if !title.is_empty() {
            titles.push(title.to_string());
        }
        rest = &after_start[end + '》'.len_utf8()..];
    }
    titles
}

fn title_matches_explicit_question(book_title: &str, requested_title: &str) -> bool {
    let book = book_title.split_whitespace().collect::<String>();
    let requested = requested_title.split_whitespace().collect::<String>();
    book == requested
        || book.starts_with(&format!("{requested}（"))
        || book.starts_with(&format!("{requested}("))
}

/// An explicit 《书名》 in an otherwise unscoped question is a user-friendly
/// single-book intent. Resolve it only when there is exactly one matching local
/// book, so same-title editions remain a normal whole-library question unless
/// the user chooses one in the list.
fn implicit_single_book_id(state: &AppState, question: &str) -> Result<Option<String>, String> {
    let requested_titles = explicit_book_titles(question);
    if requested_titles.is_empty() {
        return Ok(None);
    }
    let library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let matches = library
        .books
        .iter()
        .filter(|book| {
            requested_titles
                .iter()
                .any(|title| title_matches_explicit_question(&book.title, title))
        })
        .map(|book| book.id.to_string())
        .collect::<HashSet<_>>();
    Ok((matches.len() == 1).then(|| matches.into_iter().next().unwrap()))
}

/// An empty question-mode selection means an exact scan over every local book
/// that has semantic data. Passing the explicit id list bypasses the fast
/// profile-candidate shortcut used by interactive search, which is necessary
/// before reporting the library-wide top matches to the user.
fn full_library_semantic_scope(state: &AppState) -> Result<Vec<String>, String> {
    let library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    Ok(library
        .books
        .iter()
        .map(|book| book.id.to_string())
        .collect())
}

fn library_source(book: &semantic::SemBookHits, hit: &semantic::SemHit) -> Option<AiReaderSource> {
    let excerpt = hit.snippet.trim();
    (!excerpt.is_empty()).then(|| AiReaderSource {
        book_id: book.book_id.clone(),
        book_title: book.title.clone(),
        chapter: hit.chapter,
        excerpt: trim_to_chars(excerpt, 360),
        source_kind: "正文检索".into(),
        tags: Vec::new(),
    })
}

fn library_source_context_chars(answer_length: LibraryAnswerLength) -> Option<usize> {
    match answer_length {
        LibraryAnswerLength::Short => None,
        LibraryAnswerLength::Medium => Some(LIBRARY_MEDIUM_SOURCE_CONTEXT_CHARS),
        LibraryAnswerLength::Long => Some(LIBRARY_LONG_SOURCE_CONTEXT_CHARS),
    }
}

/// Compact passages decide which evidence is relevant. Only selected evidence
/// is then widened to its bounded, chapter-local prose so medium and long
/// answers retain qualifications and counterexamples without sending every
/// candidate passage to the configured reading service.
fn expand_library_semantic_sources(
    app: &tauri::AppHandle,
    sources: &mut [AiReaderSource],
    source_ids: &[usize],
    answer_length: LibraryAnswerLength,
) {
    let Some(max_chars) = library_source_context_chars(answer_length) else {
        return;
    };
    for source_id in source_ids {
        let Some(source) = sources.get_mut(source_id.saturating_sub(1)) else {
            continue;
        };
        if source.source_kind != "正文检索" {
            continue;
        }
        let Some(context) = semantic::semantic_context_around(
            app,
            &source.book_id,
            source.chapter,
            &source.excerpt,
            max_chars,
        ) else {
            continue;
        };
        if context.chars().count() > source.excerpt.chars().count() {
            source.excerpt = context;
            source.source_kind = "正文检索（连续上下文）".into();
        }
    }
}

fn source_key(source: &AiReaderSource) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        source.book_id, source.chapter, source.excerpt
    )
}

fn push_ai_source(
    sources: &mut Vec<AiReaderSource>,
    seen: &mut HashSet<String>,
    source: AiReaderSource,
    max_sources: usize,
) {
    if seen.insert(source_key(&source)) && sources.len() < max_sources {
        sources.push(source);
    }
}

fn push_library_source(
    sources: &mut Vec<AiReaderSource>,
    seen: &mut HashSet<String>,
    book: &semantic::SemBookHits,
    hit: &semantic::SemHit,
    max_sources: usize,
) {
    let Some(source) = library_source(book, hit) else {
        return;
    };
    push_ai_source(sources, seen, source, max_sources);
}

fn hit_matches_library_theme(hit: &semantic::SemHit, terms: &[&str]) -> bool {
    terms.iter().any(|term| hit.snippet.contains(term))
}

fn library_semantic_hit_key(book_id: &str, hit: &semantic::SemHit) -> String {
    format!("{book_id}\u{1f}{}\u{1f}{}", hit.chapter, hit.snippet)
}

struct MergedLibrarySearchResults {
    results: Vec<semantic::SemBookHits>,
    // The dedicated thematic query may find a genuine relationship scene that
    // does not literally say \"爱情\" (for example, a character choosing to
    // give up everything for \"她\"). Keep that local retrieval signal until
    // the evidence-filter stage instead of discarding it with a word match.
    thematic_hit_keys: HashSet<String>,
}

fn merge_library_search_results(
    batches: Vec<(Vec<semantic::SemBookHits>, bool)>,
) -> MergedLibrarySearchResults {
    let mut merged = HashMap::<String, semantic::SemBookHits>::new();
    let mut thematic_hit_keys = HashSet::new();
    for (batch, is_thematic_query) in batches {
        for mut book in batch {
            if is_thematic_query {
                for hit in &book.hits {
                    thematic_hit_keys.insert(library_semantic_hit_key(&book.book_id, hit));
                }
            }
            if let Some(existing) = merged.get_mut(&book.book_id) {
                existing.score = existing.score.max(book.score);
                existing.hits.append(&mut book.hits);
                existing.hits.sort_by(|left, right| {
                    right
                        .score
                        .partial_cmp(&left.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let mut seen = HashSet::new();
                existing
                    .hits
                    .retain(|hit| seen.insert((hit.chapter, hit.snippet.clone())));
                existing
                    .hits
                    .truncate(MAX_LIBRARY_SINGLE_BOOK_CANDIDATE_HITS);
            } else {
                merged.insert(book.book_id.clone(), book);
            }
        }
    }
    let mut results = merged.into_values().collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    MergedLibrarySearchResults {
        results,
        thematic_hit_keys,
    }
}

/// A library question reports the top twenty ranked books, one excerpt each.
/// A comparison instead reserves one excerpt for every selected book, so a
/// high-scoring volume cannot crowd the other side out of the model context.
fn select_library_sources_with_limit(
    results: &[semantic::SemBookHits],
    selected_ids: Option<&[String]>,
    compare: bool,
    question: &str,
    thematic_hit_keys: Option<&HashSet<String>>,
    question_source_limit: usize,
) -> Result<Vec<AiReaderSource>, String> {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();

    if compare {
        let selected = selected_ids.ok_or("跨书对比至少需要选择两本图书")?;
        if selected.len() < 2 {
            return Err("跨书对比至少需要选择两本图书".into());
        }
        for id in selected {
            if let Some(book) = results.iter().find(|book| book.book_id == *id) {
                if let Some(hit) = book.hits.first() {
                    push_library_source(
                        &mut sources,
                        &mut seen,
                        book,
                        hit,
                        MAX_LIBRARY_COMPARE_SOURCES,
                    );
                }
            }
        }
        let covered = sources
            .iter()
            .map(|source| source.book_id.as_str())
            .collect::<HashSet<_>>();
        if covered.len() < 2 {
            return Err("所选图书中至少两本需要先建立语义索引，才能进行对比".into());
        }
        for book in results {
            for hit in book.hits.iter().take(MAX_LIBRARY_COMPARE_SOURCES_PER_BOOK) {
                push_library_source(
                    &mut sources,
                    &mut seen,
                    book,
                    hit,
                    MAX_LIBRARY_COMPARE_SOURCES,
                );
            }
        }
    } else if let Some(terms) = library_theme_terms(question) {
        // For a themed literature question, an unrelated martial-arts scene is
        // worse than a smaller evidence set. Reserve one relevant passage per
        // book first, then add a second relevant location only after the first
        // pass has covered the available works.
        let mut relevant_books = HashSet::new();
        for book in results {
            if !relevant_books.insert(book.book_id.clone()) {
                continue;
            }
            if let Some(hit) = book.hits.iter().find(|hit| {
                hit_matches_library_theme(hit, terms)
                    || thematic_hit_keys.is_some_and(|keys| {
                        keys.contains(&library_semantic_hit_key(&book.book_id, hit))
                    })
            }) {
                push_library_source(&mut sources, &mut seen, book, hit, question_source_limit);
            }
        }
        if !sources.is_empty() {
            for book in results {
                for hit in book
                    .hits
                    .iter()
                    .filter(|hit| {
                        hit_matches_library_theme(hit, terms)
                            || thematic_hit_keys.is_some_and(|keys| {
                                keys.contains(&library_semantic_hit_key(&book.book_id, hit))
                            })
                    })
                    .skip(1)
                {
                    push_library_source(&mut sources, &mut seen, book, hit, question_source_limit);
                }
            }
        }
    } else {
        let mut selected_book_ids = HashSet::new();
        for book in results {
            // `semantic_search` already merges graph and fallback hits by id,
            // but this guard keeps the RAG contract true if a future search
            // path ever returns the same book more than once.
            if !selected_book_ids.insert(book.book_id.clone()) {
                continue;
            }
            if let Some(hit) = book.hits.first() {
                push_library_source(&mut sources, &mut seen, book, hit, question_source_limit);
            }
        }
    }
    if sources.is_empty() {
        return Err("没有找到可用的本地语义索引内容；请先为图书建立语义索引".into());
    }
    Ok(sources)
}

fn select_library_sources(
    results: &[semantic::SemBookHits],
    selected_ids: Option<&[String]>,
    compare: bool,
    question: &str,
    thematic_hit_keys: Option<&HashSet<String>>,
) -> Result<Vec<AiReaderSource>, String> {
    select_library_sources_with_limit(
        results,
        selected_ids,
        compare,
        question,
        thematic_hit_keys,
        MAX_LIBRARY_QUESTION_SOURCES,
    )
}

/// A question scoped to one selected book has a different goal from a
/// whole-library question: it should explain that book, not merely return its
/// one most query-adjacent sentence. The preselected chapter openings provide
/// the book-level structure; semantic body hits then fill in distinct chapters.
fn source_looks_like_front_or_back_matter(text: &str) -> bool {
    let head = trim_to_chars(text.trim(), 180).replace(char::is_whitespace, "");
    [
        "前言",
        "序言",
        "自序",
        "代序",
        "后记",
        "跋",
        "编后",
        "出版说明",
        "译者",
        "致谢",
        "参考文献",
        "附录",
        "索引",
    ]
    .iter()
    .any(|marker| head.contains(marker))
}

fn question_requests_front_or_back_matter(question: &str) -> bool {
    [
        "前言",
        "序言",
        "后记",
        "跋",
        "作者自述",
        "出版说明",
        "附录",
        "参考文献",
    ]
    .iter()
    .any(|marker| question.contains(marker))
}

fn chapter_looks_like_catalog(text: &str) -> bool {
    trim_to_chars(text.trim(), 120)
        .replace(char::is_whitespace, "")
        .contains("目录")
}

fn evenly_spaced_positions(length: usize, wanted: usize) -> Vec<usize> {
    let wanted = wanted.min(length);
    if wanted == 0 {
        return Vec::new();
    }
    if wanted == 1 {
        return vec![0];
    }
    (0..wanted)
        .map(|slot| slot * (length - 1) / (wanted - 1))
        .collect()
}

/// Sample the already-published local search index. This deliberately does not
/// read a raw book file or build an index in the user's query path.
fn single_book_structure_sources(
    state: &AppState,
    book: &crate::book::Book,
) -> Vec<AiReaderSource> {
    let Some(chapters) = search::get_indexed_book_chapters(state, book) else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    if let Some((index, chapter)) = chapters
        .iter()
        .enumerate()
        .find(|(_, chapter)| chapter_looks_like_catalog(chapter))
    {
        let source = AiReaderSource {
            book_id: book.id.to_string(),
            book_title: book.title.clone(),
            chapter: index as u32,
            excerpt: trim_to_chars(chapter.trim(), 360),
            source_kind: "目录".into(),
            tags: Vec::new(),
        };
        push_ai_source(
            &mut sources,
            &mut seen,
            source,
            MAX_LIBRARY_SINGLE_BOOK_STRUCTURE_SOURCES,
        );
    }
    let body_chapters = chapters
        .iter()
        .enumerate()
        .filter(|(_, chapter)| !chapter.trim().is_empty())
        .filter(|(_, chapter)| !source_looks_like_front_or_back_matter(chapter))
        .collect::<Vec<_>>();
    let remaining = MAX_LIBRARY_SINGLE_BOOK_STRUCTURE_SOURCES.saturating_sub(sources.len());
    for position in evenly_spaced_positions(body_chapters.len(), remaining) {
        let (index, chapter) = body_chapters[position];
        let source = AiReaderSource {
            book_id: book.id.to_string(),
            book_title: book.title.clone(),
            chapter: index as u32,
            excerpt: trim_to_chars(chapter.trim(), 360),
            source_kind: "正文开篇".into(),
            tags: Vec::new(),
        };
        push_ai_source(
            &mut sources,
            &mut seen,
            source,
            MAX_LIBRARY_SINGLE_BOOK_STRUCTURE_SOURCES,
        );
    }
    sources
}

fn select_single_book_sources(
    results: &[semantic::SemBookHits],
    book_id: &str,
    question: &str,
    structure_sources: Vec<AiReaderSource>,
) -> Result<Vec<AiReaderSource>, String> {
    let book = results
        .iter()
        .find(|book| book.book_id == book_id)
        .ok_or("所选图书尚未建立可用的语义索引")?;
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for source in structure_sources {
        push_ai_source(
            &mut sources,
            &mut seen,
            source,
            MAX_LIBRARY_SINGLE_BOOK_SOURCES,
        );
    }
    let allow_front_or_back_matter = question_requests_front_or_back_matter(question);
    let mut seen_chapters = HashSet::new();
    for hit in &book.hits {
        if (allow_front_or_back_matter || !source_looks_like_front_or_back_matter(&hit.snippet))
            && seen_chapters.insert(hit.chapter)
        {
            push_library_source(
                &mut sources,
                &mut seen,
                book,
                hit,
                MAX_LIBRARY_SINGLE_BOOK_SOURCES,
            );
        }
    }
    for hit in &book.hits {
        if allow_front_or_back_matter || !source_looks_like_front_or_back_matter(&hit.snippet) {
            push_library_source(
                &mut sources,
                &mut seen,
                book,
                hit,
                MAX_LIBRARY_SINGLE_BOOK_SOURCES,
            );
        }
    }
    // A question explicitly about a preface/afterword may need it; otherwise
    // these lower-priority passages only fill spare evidence slots.
    if allow_front_or_back_matter || sources.len() < MAX_LIBRARY_SINGLE_BOOK_SOURCES {
        for hit in &book.hits {
            push_library_source(
                &mut sources,
                &mut seen,
                book,
                hit,
                MAX_LIBRARY_SINGLE_BOOK_SOURCES,
            );
        }
    }
    if sources.is_empty() {
        return Err("所选图书没有可用的正文片段；请先建立语义索引".into());
    }
    Ok(sources)
}

fn merge_single_book_depth_results(
    book_id: &str,
    batches: Vec<Vec<semantic::SemBookHits>>,
) -> Vec<semantic::SemBookHits> {
    let mut title = String::new();
    let mut author = String::new();
    let mut score = f32::MIN;
    let mut hits = Vec::new();
    for batch in batches {
        for book in batch.into_iter().filter(|book| book.book_id == book_id) {
            if title.is_empty() {
                title = book.title.clone();
                author = book.author.clone();
            }
            score = score.max(book.score);
            hits.extend(book.hits);
        }
    }
    if hits.is_empty() {
        return Vec::new();
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen = HashSet::new();
    hits.retain(|hit| seen.insert((hit.chapter, hit.snippet.clone())));
    hits.truncate(MAX_LIBRARY_SINGLE_BOOK_CANDIDATE_HITS);
    vec![semantic::SemBookHits {
        book_id: book_id.to_string(),
        title,
        author,
        score,
        hits,
    }]
}

async fn single_book_depth_search(
    app: tauri::AppHandle,
    question: &str,
    book_id: &str,
) -> Result<SingleBookDepthResults, String> {
    let state = app.state::<AppState>();
    let book = {
        let library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        library
            .books
            .iter()
            .find(|book| book.id.to_string() == book_id)
            .cloned()
            .ok_or("找不到所选图书")?
    };
    let title = book.title.clone();
    let structure_sources = single_book_structure_sources(state.inner(), &book);
    let mut batches = Vec::new();
    for query in single_book_retrieval_queries(question, &title) {
        batches.push(
            semantic::semantic_search(app.clone(), query, Some(vec![book_id.to_string()])).await?,
        );
    }
    let mut semantic_results = merge_single_book_depth_results(book_id, batches);
    if semantic_results.is_empty() && !structure_sources.is_empty() {
        semantic_results.push(semantic::SemBookHits {
            book_id: book_id.to_string(),
            title: book.title.clone(),
            author: book.author.clone(),
            score: 0.0,
            hits: Vec::new(),
        });
    }
    Ok(SingleBookDepthResults {
        semantic_results,
        structure_sources,
    })
}

fn parse_library_booklist_recommendation(
    response: &str,
    candidates: &[AiReaderSource],
    result_limit: usize,
) -> Result<LibraryBooklistRecommendation, String> {
    let response = response.trim().trim_matches('`').trim();
    let value = serde_json::from_str::<serde_json::Value>(response)
        .or_else(|_| {
            let start = response.find('{').ok_or_else(|| {
                serde_json::Error::io(std::io::Error::other("missing JSON object"))
            })?;
            let end = response.rfind('}').ok_or_else(|| {
                serde_json::Error::io(std::io::Error::other("missing JSON object"))
            })?;
            serde_json::from_str(&response[start..=end])
        })
        .map_err(|_| "推荐模型没有返回可用 JSON，请重试".to_string())?;
    let candidate_by_id = candidates
        .iter()
        .map(|candidate| (candidate.book_id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let items = value
        .get("items")
        .or_else(|| value.get("books"))
        .and_then(serde_json::Value::as_array)
        .ok_or("推荐模型没有返回 items 数组，请重试")?;
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for item in items {
        let Some(book_id) = item
            .get("bookId")
            .or_else(|| item.get("book_id"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(candidate) = candidate_by_id.get(book_id) else {
            continue;
        };
        if !seen.insert(book_id) {
            continue;
        }
        let review = item
            .get("review")
            .or_else(|| item.get("comment"))
            .or_else(|| item.get("reason"))
            .and_then(serde_json::Value::as_str)
            .map(|value| trim_to_chars(value.trim(), 1000))
            .unwrap_or_default();
        if review.is_empty() {
            continue;
        }
        normalized.push(LibraryBooklistRecommendationItem {
            book_id: candidate.book_id.clone(),
            title: candidate.book_title.clone(),
            review,
        });
        if normalized.len() >= result_limit.min(candidates.len()) {
            break;
        }
    }
    if normalized.is_empty() {
        return Err("推荐模型没有从本地候选中选出带评语的图书，请重试".to_string());
    }
    let summary = value
        .get("summary")
        .or_else(|| value.get("description"))
        .and_then(serde_json::Value::as_str)
        .map(|value| trim_to_chars(value.trim(), 1000))
        .unwrap_or_default();
    Ok(LibraryBooklistRecommendation {
        summary,
        items: normalized,
    })
}

/// The evidence model is useful for ranking relevance, but it occasionally
/// returns a single very strong-looking paragraph for a deliberately broad
/// library question. Keep that paragraph, then add the best available
/// independent books so the answer model can make a real synthesis. This is
/// deliberately a no-op when the local result set itself cannot support that
/// breadth (for example, a narrowly indexed collection).
fn ensure_library_synthesis_source_ids(
    sources: &[AiReaderSource],
    source_ids: Vec<usize>,
    question: &str,
    answer_length: LibraryAnswerLength,
) -> Vec<usize> {
    let mut ids = source_ids
        .into_iter()
        .filter(|id| (1..=sources.len()).contains(id))
        .collect::<Vec<_>>();
    let mut seen_ids = HashSet::new();
    ids.retain(|id| seen_ids.insert(*id));

    let available_books = sources
        .iter()
        .map(|source| source.book_id.as_str())
        .collect::<HashSet<_>>();
    if sources.len() < answer_length.required_sources()
        || available_books.len() < answer_length.required_books()
    {
        ids.truncate(answer_length.source_limit());
        return ids;
    }
    if library_theme_terms(question).is_none() {
        return ids;
    }
    let mut covered_books = ids
        .iter()
        .filter_map(|id| sources.get(id.saturating_sub(1)))
        .map(|source| source.book_id.as_str())
        .collect::<HashSet<_>>();
    for (index, source) in sources.iter().enumerate() {
        if covered_books.len() >= answer_length.required_books() {
            break;
        }
        let id = index + 1;
        if seen_ids.insert(id) && covered_books.insert(source.book_id.as_str()) {
            ids.push(id);
        }
    }
    for (index, _) in sources.iter().enumerate() {
        if ids.len() >= answer_length.source_limit() {
            break;
        }
        let id = index + 1;
        if seen_ids.insert(id) {
            ids.push(id);
        }
    }
    ids.truncate(answer_length.source_limit());
    ids
}

fn system_prompt(task: &str) -> &'static str {
    match task {
        "summary" => {
            "你是严谨的阅读助手。只依据提供的章节内容，用中文给出精炼摘要、关键人物/概念和待思考问题；不要补充原文不存在的事实。末尾标注依据的章节号。"
        }
        "mindmap" => {
            "你是严谨的阅读助手。只依据提供的章节内容，输出一个合法 JSON 对象，格式固定为 {\"title\":\"主题\",\"children\":[{\"title\":\"分支\",\"children\":[]}]}; 不要使用 Markdown 代码块，不要补充原文不存在的内容。"
        }
        "reading_evidence_filter" => {
            "你是阅读中的证据筛选器。候选材料全部来自读者已经读到的同一本书，来源 N 标有材料类型：当前已选文字、选句邻近正文、本章开篇或已读正文检索。先看用户问题；若有选句，优先保留它和真正解释它的邻文；再保留不同位置、能补足人物、事件、概念或论证的正文。不要因为词语相同就选择无关段落，也不要把本章开篇当作具体事实的唯一证据。不要回答问题，不要解释。只输出 JSON 对象，格式严格为 {\"sourceIds\":[1,3,5]}，选择 2—6 条，按证据强度排序。"
        }
        "reading_question" => {
            "你是贴着正在阅读的文本工作的深度阅读助手。只能依据带 [来源 N] 的已读材料回答，绝不使用后文或书外事实。必须使用以下结构：\n\n## 直接解释\n先直接回答用户的问题或解释选句，2—4 句；若用户选了句子，第一句必须回应该句在当前语境中的意思。\n\n## 文本依据\n列出 2—4 条，不复述大段原文。每条说明“这段文字说了什么、为什么支撑回答”，并在句末标 [来源 N]。\n\n## 放回本章\n用一小段说明这段话与本章已读部分的关系；这是解读时要明确用“可以理解为”等措辞，不能伪装成原文事实。\n\n仅在已读材料确实不足时写 `## 未能确认`，具体说明缺少的是哪一段或哪一项信息。输出前逐条检查：每个事实性判断都必须有 [来源 N]，不得引用不存在的来源。"
        }
        "reading_summary" => {
            "你是严谨的阅读助手。只根据带 [来源 N] 的已读材料总结，不得补充未读内容。输出 `## 已读摘要`（3—5 条有重点的进展）和 `## 人物与线索`（人物、概念、因果或待验证问题）；每一条事实性内容都在末尾标 [来源 N]。不要把章节开篇或选句本身误写成全书结论。"
        }
        "reading_question_verify" | "reading_summary_verify" => {
            "你是阅读助手的引用审校人。根据用户问题、候选来源和回答草稿，直接输出修订后的完整回答，不要写审核过程。删除任何不由 [来源 N] 直接支持的事实性结论；每个保留的来源编号必须真实存在且支撑其所在句。若草稿把选句、章节开篇或局部材料说成全书结论，改成与当前已读范围相称的表述。保留原有 Markdown 标题和清晰的直接回答。"
        }
        "library_evidence_filter" => {
            "你是本地书库的证据审稿器。候选段落会编号为来源 N，并标注书名、章节和材料类型。只选择能直接支撑用户问题的段落，优先正文、具体人物关系、情节、观点或可靠评论；剔除只因词语相近而命中的序言、泛泛创作谈、无关文体或题材材料。对于“X 有什么特点”“某类作品如何表现”这类宽问题，若候选中有足够材料，必须优先选来自至少两部不同作品的 3—6 条正文证据；作者自述、前言或评论只能补充，不能单独支撑对一类作品的结论。避免只挑同一段话的重复表述；若只有一部作品确实相关，保留最强正文证据即可，后续回答会说明范围。不要回答问题，不要解释。只输出 JSON 对象，格式严格为 {\"sourceIds\":[1,4,7]}；最多 10 个，按证据强度排序。"
        }
        "library_booklist_recommend" => {
            "你是本地书库的书单编辑。候选材料全部来自本地检索，标题中含“本地书籍 ID”。根据用户问题和【推荐数量】要求，从候选中精选指定数量的最相关、互补图书；绝不能推荐候选之外的书，不能改写或猜测 ID。候选不足 5 本时仍按实际候选数量继续，不得以数量不足为由拒绝。每本书写一段 45—160 字的中文评语，必须直接回答它为什么适合这个问题，并只依据该书附带的命中片段和标签，不能编造书外情节或知识。只输出一个 JSON 对象，不要 Markdown 或解释，格式固定为 {\"summary\":\"这份书单怎样回应问题\",\"items\":[{\"bookId\":\"7\",\"review\":\"与问题相关的短评\"}]}。"
        }
        "library_single_book_evidence_filter" => {
            "你是单本书深度解读的证据审稿器。候选段落全部来自同一本书，来源 N 标有“目录、正文开篇、正文检索”等材料类型。用户问“这本书写了什么”或任何单书问题时，先用目录或章节开篇确定全书范围，再优先选择能说明核心人物/事件/论点、结构或结论的正文检索片段；目录不能单独替代正文证据，前言、后记、作者闲谈只有用户明确询问时才选。选择 4—10 条彼此覆盖不同章节的证据；若材料确实没有全书概述，选择最能拼出主题和重点的正文。不要回答问题，不要解释。只输出 JSON 对象，格式严格为 {\"sourceIds\":[1,4,7]}，按覆盖全书的重要性排序。"
        }
        "library_question" => {
            "你是本地书库问答助手。直接给读者答案，不得展示思考、检索、核对、审校或草稿过程。全篇力求 700 个汉字以内，信息密度优先，不能用重复结论凑篇幅。必须使用以下 Markdown 结构：\n\n## 直接回答\n用 2—4 句直接回答问题，先给清晰结论；宽泛问题要明确“以下依据本次命中的作品片段”。\n\n## 关键依据\n列出 4—6 条彼此不同的短条目。每一条必须严格采用“`- **一句重点。** 随后的证据说明`”这一形式：先用不超过 18 个汉字的完整重点句概括一个特点，句号放在加粗内；再紧接着写《书名》中的具体人物、情节、观点或叙述如何证明这句重点，并在句末标注 [来源 N]。重点句不能只写书名或“特点如下”，也不能与后文证据脱节。对“某类作品有什么特点”等宽问题，只要上下文有至少三部作品，必须使用至少三部不同作品、四条不同来源；不要把同一段话拆成多条，也不要以作者自述、前言或评论替代相关作品本身的证据。\n\n## 解读\n用 2—3 句把前述不同作品的证据连接成解释；用“这意味着”或“可以理解为”明确这是分析，并指出哪些结论只适用于本次命中的片段。\n\n仅当证据确实不足时，附加“## 保留意见”并具体说明材料范围；不得以“未找到专门论述”代替回答。来源标题中的标签只能辅助组织，绝不能当作正文引文或具体情节证据。不得杜撰未提供的具体情节、人物、引文或书中观点。不得用“某人、某部作品、某来源、材料中”代替书名、作者、人物名或情节；若片段没有名字，就明确说“该片段未提供姓名”，不要编故事。严禁输出“草稿、核对、审核、审校、终审、让我、我需要、来源 N：包含”等过程性文字。输出前逐条核对：每个 [来源 N] 必须真实支撑其所在结论；证据不足就删掉引用。"
        }
        "library_question_repair" => {
            "只输出最终给读者看的书库问答，第一行必须是 `## 直接回答`。不要写任何推理、核对、审校、草稿、来源逐条验真或自我对话。严格使用 `## 直接回答`、`## 关键依据`、`## 解读` 三段；若作答规格要求，还必须保留 `## 延展观点` 或 `## 边界与反例`。关键依据的每一条必须写成 `- **一句重点。** 紧接着的证据说明 [来源 N]`：重点句不超过 18 个汉字、加粗且有句号，后半句必须以《书名》、人物、情节或观点证明这句重点。上下文有至少三部作品时，关键依据必须使用至少三部不同作品和四个不同 [来源 N]，不可重复解释同一段。不能写“某人、某部作品、某来源、材料中”。证据不够时只在最后写简短的 `## 保留意见`，不要猜测。"
        }
        "library_single_book_question" => {
            "你是单本书深度解读助手。用户明确只问一本书，首要任务是回答这本书实际写了什么，不能围绕边缘材料兜圈子。必须使用以下 Markdown 结构：\n\n## 直接回答\n开头先用 2—4 句说明全书对象、范围、主线和最重要的内容；不要先讲检索限制或材料过程。\n\n## 这本书具体写了什么\n列出 3—5 点，尽量覆盖不同章节中的人物、事件、论证、叙述阶段或结论；每点必须带 [来源 N]。\n\n## 解读\n用一段解释这些内容如何共同构成这本书的重点；分析必须和“书写了什么”相连，不能用无关背景代替内容。\n\n仅当现有段落确实无法确定某项时才写 `## 保留意见`。不得杜撰书外知识、具体情节或章节；来源标题中的标签只能辅助组织，不能当正文证据。输出前逐条检查：删掉不直接说明本书内容的材料和无证据结论。"
        }
        "library_single_book_verify" => {
            "你是单本书问答的终审编辑。给出的上下文全部来自同一本书，用户问题和一份回答草稿会一起提供。请直接输出修订后的完整 Markdown 回答，不要写审核过程。第一段必须正面说明这本书写了什么；删除围绕边缘材料、检索过程或泛泛背景的内容。每个事实性要点必须由 [来源 N] 支撑，且不得引入上下文外事实。保留结构 `## 直接回答`、`## 这本书具体写了什么`、`## 解读`；只有确有必要才保留 `## 保留意见`。"
        }
        "library_question_verify" => {
            "你只输出给读者看的最终书库问答，不是审核报告。给出的上下文与回答草稿会一起提供：直接改写成完整 Markdown 答案，绝不解释你的核对过程，绝不出现“草稿、核对、审核、审校、终审、来源 N：包含、让我、我需要”等词。保留 ## 直接回答、## 关键依据、## 解读 三个结构；若作答规格要求，还必须保留 ## 延展观点 或 ## 边界与反例。直接回答 2—4 句；关键依据每条必须先写 `**一句重点。**`（不超过 18 个汉字，加粗内含句号），后接《书名》中的人物、情节或观点作为论据，并在句末标 [来源 N]。若草稿没有这个“重点在前、论据在后”的形式，必须改写成该形式。上下文有至少三部作品时，必须使用多个相关作品和不同来源，不能用同一段反复凑条目；具体数量以作答规格为准。删除任何不由同编号 [来源 N] 直接支撑的事实性结论；分析要明确写成“这意味着”或“可以理解为”。不得引用不存在的来源，也不得把目录标签、作者自述或泛泛评论当作某类作品的唯一证据。"
        }
        "library_compare" => {
            "你是严谨的跨书对比助手。只依据给出的本地检索片段，用中文归纳各书的共同点、差异与证据不足之处；每个关键结论后标注 [来源 N]。来源标题中的本地自动“标签”可用于建立时代、类别、体裁和篇幅的比较框架，但不能替代正文证据或被说成原文事实。不得用片段外知识补全观点，也不得把未出现的书说成参与了对比。"
        }
        "library_compare_verify" => {
            "你是跨书对比的终审编辑。给出的上下文与回答草稿会一起提供。请直接输出修订后的完整 Markdown 回答，不要写审核过程。逐条核对比较结论：共同点、差异、归因都必须由相应 [来源 N] 直接支撑；没有两边证据的比较必须删去或明确标为证据不足。不得引用不存在的来源，也不得把标签当作正文事实。"
        }
        "library_book_classify" => {
            "你是本地阅读器的书籍目录员。仅根据给出的书名、作者、格式、简介、字数和已有手工标签，为单本书生成保守的本地暗标签；不要编造作者、情节或出版史。只输出 JSON 对象，不要 Markdown 或解释，格式固定为 {\"tags\":[\"类别：小说\",\"时代：明清\",\"体裁：章回体\",\"篇幅：长篇\",\"主题：待确认\",\"地域：待确认\",\"语言：中文\",\"用途：文学阅读\"],\"needsWebSearch\":false}。必须且只能各输出一条“类别、时代、体裁、篇幅、主题、地域、语言、用途”八个维度的标签；每条必须是“分类：值”。无法可靠判断时仍须保留该维度并填“待确认”。若本地资料不足以可靠完成这八维，needsWebSearch 必须为 true。"
        }
        "library_book_classify_web" => {
            "你是本地阅读器的书籍目录员。根据本地书目信息与后附的百度、豆瓣读书公开检索摘要，为单本书生成保守的本地暗标签。检索摘要可能混有同名书或导航文本，只有书名、作者等能对应时才采用；冲突或不足时填“待确认”，不要编造情节、出版史或精确年份。只输出 JSON 对象，不要 Markdown 或解释，格式固定为 {\"tags\":[\"类别：小说\",\"时代：明清\",\"体裁：章回体\",\"篇幅：长篇\",\"主题：待确认\",\"地域：待确认\",\"语言：中文\",\"用途：文学阅读\"],\"needsWebSearch\":false}。必须且只能各输出一条“类别、时代、体裁、篇幅、主题、地域、语言、用途”八个维度的标签；每条必须是“分类：值”。"
        }
        _ => {
            "你是严谨的阅读助手。只依据提供的章节内容回答中文问题；无法从内容确认时必须说“提供的内容中未找到依据”。回答末尾列出依据章节号。"
        }
    }
}

fn provider_max_tokens(task: &str) -> u16 {
    matches!(
        task,
        "library_question"
            | "library_question_verify"
            | "library_question_repair"
            | "library_single_book_question"
            | "library_single_book_verify"
            | "library_compare"
            | "library_compare_verify"
            | "library_booklist_recommend"
    )
    .then_some(LIBRARY_SYNTHESIS_PROVIDER_MAX_TOKENS)
    .unwrap_or(READING_PROVIDER_MAX_TOKENS)
}

/// Retry one answer generation with a compact, bounded context when a
/// compatible provider accepts the initial request but returns no normal text.
/// Source markers are preserved because the compact form is a prefix of the
/// same numbered context used for final citation verification.
async fn call_library_answer_with_retry(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<String, String> {
    let primary = await_library_provider(
        cancellation.clone(),
        call_reading_provider_async(
            config.clone(),
            task.clone(),
            question.clone(),
            context.clone(),
        ),
    )
    .await;
    match primary {
        Ok(answer) => Ok(answer),
        Err(primary_error) => {
            if primary_error == LIBRARY_REQUEST_CANCELLED {
                return Err(primary_error);
            }
            let retry_context = trim_to_chars(&context, MAX_READING_RETRY_CONTEXT_CHARS);
            let retry_context = if retry_context.trim().is_empty() {
                context
            } else {
                retry_context
            };
            let retry = await_library_provider(
                cancellation,
                call_reading_provider_async(config, task, question, retry_context),
            )
            .await;
            retry.map_err(|retry_error| {
                if retry_error == LIBRARY_REQUEST_CANCELLED {
                    return retry_error;
                }
                format!(
                    "接口没有返回可用回答：首次请求为 {primary_error}；精简证据重试为 {retry_error}"
                )
            })
        }
    }
}

async fn await_library_provider<T, F>(
    cancellation: Option<watch::Receiver<bool>>,
    work: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let Some(mut cancellation) = cancellation else {
        return work.await;
    };
    if *cancellation.borrow() {
        return Err(LIBRARY_REQUEST_CANCELLED.to_string());
    }
    tokio::select! {
        result = work => result,
        changed = cancellation.changed() => {
            let _ = changed;
            Err(LIBRARY_REQUEST_CANCELLED.to_string())
        }
    }
}

async fn call_reading_provider_async(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
) -> Result<String, String> {
    provider::call_async(provider_request(&config, &task, &question, &context)).await
}

fn call_reading_provider(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
) -> Result<String, String> {
    provider::call(provider_request(&config, &task, &question, &context))
}

fn provider_request<'a>(
    config: &'a StoredConfig,
    task: &'a str,
    question: &'a str,
    context: &'a str,
) -> provider::Request<'a> {
    provider::Request {
        provider: &config.provider,
        base_url: &config.base_url,
        model: &config.model,
        api_key: &config.api_key,
        task,
        prompt: system_prompt(task),
        question,
        context,
        max_tokens: provider_max_tokens(task),
        response_timeout: READING_PROVIDER_RESPONSE_TIMEOUT,
    }
}

fn library_classification_context(book: &crate::book::Book) -> String {
    let manual_tags = if book.tags.is_empty() {
        "（无）".to_string()
    } else {
        book.tags.join("、")
    };
    format!(
        "书名：{}\n作者：{}\n格式：{}\n字数：{}\n简介：{}\n已有手工标签：{}",
        trim_to_chars(&book.title, 160),
        trim_to_chars(&book.author, 100),
        trim_to_chars(&book.format, 24),
        book.word_count,
        trim_to_chars(&book.description, 700),
        trim_to_chars(&manual_tags, 360),
    )
}

fn local_metadata_is_sparse(book: &crate::book::Book) -> bool {
    book.author.trim().is_empty() && book.description.trim().is_empty() && book.tags.is_empty()
}

fn percent_encode_query(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 3);
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn catalog_search_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(std::time::Duration::from_secs(6)))
        .timeout_recv_response(Some(std::time::Duration::from_secs(12)))
        .timeout_recv_body(Some(std::time::Duration::from_secs(12)))
        .build()
        .into()
}

fn catalog_page_text(agent: &ureq::Agent, source: &str, url: &str) -> Result<String, String> {
    let response = agent
        .get(url)
        .header(
            "User-Agent",
            "KunpengReader/1.10 (local book classification)",
        )
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|error| format!("{source} 请求失败：{error}"))?;
    let status = response.status().as_u16();
    let html = response
        .into_body()
        .read_to_string()
        .map_err(|error| format!("{source} 返回读取失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("{source} 返回 HTTP {status}"));
    }
    let text = crate::html_sanitize::html_to_plain_text(&html);
    let text = trim_to_chars(&text, MAX_LIBRARY_WEB_PAGE_CHARS);
    if text.trim().is_empty() {
        Err(format!("{source} 未返回可用书目信息"))
    } else {
        Ok(text)
    }
}

fn public_catalog_evidence(book: &crate::book::Book) -> (String, Vec<String>) {
    let query = format!(
        "{} {}",
        trim_to_chars(&book.title, 120),
        trim_to_chars(&book.author, 80)
    )
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ");
    if query.is_empty() {
        return (String::new(), Vec::new());
    }
    let encoded = percent_encode_query(&query);
    let sources = [
        ("百度", format!("https://www.baidu.com/s?wd={encoded}&rn=5")),
        (
            "豆瓣读书",
            format!("https://book.douban.com/subject_search?search_text={encoded}&cat=1001"),
        ),
    ];
    let agent = catalog_search_agent();
    let mut evidence = String::new();
    let mut available_sources = Vec::new();
    for (source, url) in sources {
        match catalog_page_text(&agent, source, &url) {
            Ok(text) => {
                available_sources.push(source.to_string());
                evidence.push_str(&format!("[{source} 检索摘要]\n{text}\n\n"));
            }
            Err(error) => crate::log(&format!("library_catalog_search skipped: {error}")),
        }
    }
    (
        trim_to_chars(&evidence, MAX_CONTEXT_CHARS / 2),
        available_sources,
    )
}

#[derive(Clone)]
struct PendingLibraryWebClassification {
    book: crate::book::Book,
    profile: LibraryProfile,
}

fn save_library_profile(
    state: &AppState,
    book_id: &str,
    profile: &LibraryProfile,
) -> Result<(), String> {
    let encoded =
        serde_json::to_string(profile).map_err(|error| format!("分类序列化失败：{error}"))?;
    state.with_db_write("ai_reader_save_library_profile", |db| {
        db.set_metadata(&library_profile_key(book_id), &encoded)
    })?;
    let id = book_id
        .parse::<u64>()
        .map_err(|_| "分类图书 ID 无效".to_string())?;
    let mut library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    if library.set_model_tags(id, profile.tags.clone()) {
        library.save()?;
    }
    Ok(())
}

fn supplement_library_profile_from_web(
    state: &AppState,
    config: &StoredConfig,
    task: &crate::background_tasks::TaskRunGuard,
    pending: &mut PendingLibraryWebClassification,
    completed_local: u64,
    total: u64,
    waiting: usize,
) -> Result<bool, String> {
    let _ = task.update_progress(
        completed_local,
        total,
        format!(
            "正在联网补全（剩余 {}）：《{}》",
            waiting,
            trim_to_chars(&pending.book.title, 44)
        ),
    );
    // Do not send a burst of catalogue requests. The local classifier keeps
    // moving while this queue is drained at a deliberate, stable pace.
    std::thread::sleep(LIBRARY_WEB_LOOKUP_DELAY);
    let (web_evidence, _sources) = public_catalog_evidence(&pending.book);
    pending.profile.web_attempted = true;
    if web_evidence.is_empty() {
        let _ = task.log(
            TaskLogLevel::Warning,
            format!(
                "《{}》百度、豆瓣均未返回可用书目信息，已保留本地标签",
                trim_to_chars(&pending.book.title, 80)
            ),
        );
        save_library_profile(state, &pending.book.id.to_string(), &pending.profile)?;
        return Ok(false);
    }
    let web_context = format!(
        "{}\n\n以下是联网检索到的公开书目信息，仅用于补全目录标签：\n{}",
        library_classification_context(&pending.book),
        web_evidence
    );
    match call_reading_provider(
        config.clone(),
        "library_book_classify_web".to_string(),
        format!(
            "请依据本地资料和联网摘要为《{}》生成暗标签",
            trim_to_chars(&pending.book.title, 160)
        ),
        web_context,
    )
    .and_then(|response| parse_library_classification_decision(&response))
    {
        Ok(web_decision) => {
            pending.profile = web_decision.profile;
            pending.profile.web_attempted = true;
            pending.profile.web_enriched = true;
        }
        Err(error) => {
            let _ = task.log(
                TaskLogLevel::Warning,
                format!(
                    "《{}》联网分类失败，已保留本地标签：{error}",
                    trim_to_chars(&pending.book.title, 80)
                ),
            );
        }
    }
    let enriched = pending.profile.web_enriched;
    save_library_profile(state, &pending.book.id.to_string(), &pending.profile)?;
    Ok(enriched)
}

fn classify_library_books(
    state: &AppState,
    config: StoredConfig,
    task: crate::background_tasks::TaskRunGuard,
) {
    let books = match state.library.lock() {
        Ok(library) => library.books.clone(),
        Err(_) => {
            let _ = task.fail("书架锁定失败");
            return;
        }
    };
    let total = books.len() as u64;
    if total == 0 {
        let _ = task.update_progress(0, 0, "书架中没有图书");
        let _ = task.complete();
        return;
    }
    let profiles = match load_library_profiles(state) {
        Ok(profiles) => profiles,
        Err(error) => {
            let _ = task.fail(format!("读取已分类图书失败：{error}"));
            return;
        }
    };
    let pending_books = books
        .iter()
        .filter(|book| {
            !profiles
                .get(&book.id.to_string())
                .cloned()
                .or_else(|| {
                    (!book.model_tags.is_empty()).then(|| LibraryProfile {
                        tags: book.model_tags.clone(),
                        web_attempted: true,
                        web_enriched: false,
                    })
                })
                .is_some_and(|profile| profile_is_settled(&profile))
        })
        .cloned()
        .collect::<Vec<_>>();
    let resumed = task.checkpoint_value().is_some();
    let settled_before = total.saturating_sub(pending_books.len() as u64);
    if pending_books.is_empty() {
        let summary = format!("完成：{total} 本图书的分类均已保存（本次无需重做）");
        let _ = task.checkpoint(
            total,
            total,
            summary.clone(),
            library_classification_checkpoint("", "complete"),
        );
        let _ = task.complete();
        return;
    }
    let initial_label = format!(
        "正在{} {}/{}：已保存的分类将直接跳过",
        if resumed { "续建" } else { "分类" },
        settled_before,
        total
    );
    if let Err(error) = task.checkpoint(
        settled_before,
        total,
        initial_label,
        library_classification_checkpoint("", "resume"),
    ) {
        let _ = task.fail(format!("无法保存分类续建点：{error}"));
        return;
    }
    let mut classified = 0_u64;
    let skipped = settled_before;
    let mut failed = 0_u64;
    let mut web_enriched = 0_u64;
    let mut pending_web = VecDeque::new();
    for (index, book) in pending_books.iter().enumerate() {
        match task.control_signal() {
            TaskControlSignal::Cancel => {
                let _ = task.cancel();
                return;
            }
            TaskControlSignal::Pause => {
                let _ = task.pause();
                return;
            }
            TaskControlSignal::Continue => {}
        }
        let done = settled_before + index as u64;
        let _ = task.update_progress(
            done,
            total,
            format!(
                "正在{} {}/{}：《{}》",
                if resumed { "续建" } else { "分类" },
                done + 1,
                total,
                trim_to_chars(&book.title, 44)
            ),
        );
        let existing_profile = profiles.get(&book.id.to_string()).cloned();
        if let Some(profile) = existing_profile.filter(|profile| !profile.web_attempted) {
            // The local phase was already saved before interruption. Resume at
            // its deferred network phase instead of asking the model again.
            pending_web.push_back(PendingLibraryWebClassification {
                book: book.clone(),
                profile,
            });
        } else {
            let context = library_classification_context(book);
            let response = call_reading_provider(
                config.clone(),
                "library_book_classify".to_string(),
                format!("请为《{}》生成本地暗标签", trim_to_chars(&book.title, 160)),
                context,
            );
            match response.and_then(|response| parse_library_classification_decision(&response)) {
                Ok(decision) => {
                    let mut profile = decision.profile;
                    let should_search_web =
                        decision.needs_web_search || local_metadata_is_sparse(book);
                    profile.web_attempted = !should_search_web;
                    if let Err(error) = save_library_profile(state, &book.id.to_string(), &profile)
                    {
                        failed += 1;
                        let _ = task.log(
                            TaskLogLevel::Warning,
                            format!(
                                "《{}》保存分类失败：{error}",
                                trim_to_chars(&book.title, 80)
                            ),
                        );
                    } else {
                        classified += 1;
                        if should_search_web {
                            pending_web.push_back(PendingLibraryWebClassification {
                                book: book.clone(),
                                profile,
                            });
                        }
                    }
                }
                Err(error) => {
                    failed += 1;
                    let _ = task.log(
                        TaskLogLevel::Warning,
                        format!("《{}》分类失败：{error}", trim_to_chars(&book.title, 80)),
                    );
                }
            }
        }

        // Stagger public lookups behind several normal local classifications so
        // a large sparse library never opens with a burst of remote requests.
        if (index + 1) % LIBRARY_WEB_LOOKUP_EVERY_BOOKS == 0 {
            if let Some(mut pending) = pending_web.pop_front() {
                let waiting = pending_web.len() + 1;
                match supplement_library_profile_from_web(
                    state,
                    &config,
                    &task,
                    &mut pending,
                    done + 1,
                    total,
                    waiting,
                ) {
                    Ok(true) => web_enriched += 1,
                    Ok(false) => {}
                    Err(error) => {
                        failed += 1;
                        let _ = task.log(
                            TaskLogLevel::Warning,
                            format!(
                                "《{}》保存联网分类失败：{error}",
                                trim_to_chars(&pending.book.title, 80)
                            ),
                        );
                    }
                }
            }
        }
        if let Err(error) = task.checkpoint(
            done + 1,
            total,
            format!("已保存 {}/{} 本的分类，可随时续建", done + 1, total),
            library_classification_checkpoint(&book.id.to_string(), "local"),
        ) {
            let _ = task.fail(format!("无法保存分类续建点：{error}"));
            return;
        }
    }

    while let Some(mut pending) = pending_web.pop_front() {
        match task.control_signal() {
            TaskControlSignal::Cancel => {
                let _ = task.cancel();
                return;
            }
            TaskControlSignal::Pause => {
                let _ = task.pause();
                return;
            }
            TaskControlSignal::Continue => {}
        }
        let waiting = pending_web.len() + 1;
        match supplement_library_profile_from_web(
            state,
            &config,
            &task,
            &mut pending,
            total,
            total,
            waiting,
        ) {
            Ok(true) => web_enriched += 1,
            Ok(false) => {}
            Err(error) => {
                failed += 1;
                let _ = task.log(
                    TaskLogLevel::Warning,
                    format!(
                        "《{}》保存联网分类失败：{error}",
                        trim_to_chars(&pending.book.title, 80)
                    ),
                );
            }
        }
        if let Err(error) = task.checkpoint(
            total,
            total,
            format!("已保存 {}/{} 本分类，继续联网补全", total, total),
            library_classification_checkpoint(&pending.book.id.to_string(), "web"),
        ) {
            let _ = task.fail(format!("无法保存分类续建点：{error}"));
            return;
        }
    }
    let summary = format!(
        "完成：分类 {classified} 本，联网补全 {web_enriched} 本，已存在 {skipped} 本，失败 {failed} 本"
    );
    let _ = task.update_progress(total, total, summary.clone());
    if classified == 0 && skipped == 0 && failed > 0 {
        let _ = task.fail(summary);
    } else {
        let _ = task.complete();
    }
}

#[tauri::command]
pub(crate) fn library_profile_status(
    state: tauri::State<AppState>,
) -> Option<BackgroundTaskSnapshot> {
    state
        .background_tasks
        .latest_for_kind(BackgroundTaskKind::LibraryClassification)
}

#[tauri::command]
pub(crate) fn library_profile_coverage_status(
    state: tauri::State<AppState>,
) -> Result<LibraryProfileCoverageStatus, String> {
    library_profile_coverage(state.inner())
}

#[tauri::command]
pub(crate) fn library_model_tags_settings(
    state: tauri::State<AppState>,
) -> Result<LibraryModelTagsSettings, String> {
    Ok(LibraryModelTagsSettings {
        enabled: model_tags_enabled(state.inner())?,
    })
}

fn library_answer_length(db: &crate::db::AppDb) -> LibraryAnswerLength {
    db.metadata(LIBRARY_ANSWER_LENGTH_KEY)
        .as_deref()
        .and_then(LibraryAnswerLength::parse)
        .unwrap_or_default()
}

fn library_recommendation_candidate_limit(db: &crate::db::AppDb) -> usize {
    db.metadata(LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT_KEY)
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| {
            value.clamp(
                MIN_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT,
                MAX_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT,
            )
        })
        .unwrap_or(DEFAULT_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT)
}

fn library_recommendation_result_limit(db: &crate::db::AppDb) -> usize {
    db.metadata(LIBRARY_RECOMMENDATION_RESULT_LIMIT_KEY)
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| {
            value.clamp(
                MIN_LIBRARY_RECOMMENDATION_RESULT_LIMIT,
                MAX_LIBRARY_RECOMMENDATION_RESULT_LIMIT,
            )
        })
        .unwrap_or(DEFAULT_LIBRARY_RECOMMENDATION_RESULT_LIMIT)
}

fn library_answer_settings_from_db(db: &crate::db::AppDb) -> LibraryAnswerSettings {
    LibraryAnswerSettings {
        answer_length: library_answer_length(db),
        recommendation_candidate_limit: library_recommendation_candidate_limit(db),
        recommendation_result_limit: library_recommendation_result_limit(db),
    }
}

#[tauri::command]
pub(crate) fn library_answer_settings(
    state: tauri::State<AppState>,
) -> Result<LibraryAnswerSettings, String> {
    state.with_db_read("ai_reader_library_answer_settings", |db| {
        Ok(library_answer_settings_from_db(db))
    })
}

#[tauri::command]
pub(crate) fn set_library_answer_length(
    state: tauri::State<AppState>,
    request: SetLibraryAnswerLengthRequest,
) -> Result<LibraryAnswerSettings, String> {
    let answer_length = LibraryAnswerLength::parse(&request.answer_length)
        .ok_or("作答长度只支持 short、medium 或 long")?;
    state.with_db_write("ai_reader_set_answer_length", |db| {
        db.set_metadata(LIBRARY_ANSWER_LENGTH_KEY, answer_length.as_str())?;
        Ok(library_answer_settings_from_db(db))
    })
}

#[tauri::command]
pub(crate) fn set_library_recommendation_candidate_limit(
    state: tauri::State<AppState>,
    request: SetLibraryRecommendationCandidateLimitRequest,
) -> Result<LibraryAnswerSettings, String> {
    if !(MIN_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT..=MAX_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT)
        .contains(&request.candidate_limit)
    {
        return Err(format!(
            "推荐书单粗选数量只支持 {MIN_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT}–{MAX_LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT} 本"
        ));
    }
    state.with_db_write("ai_reader_set_recommendation_candidate_limit", |db| {
        db.set_metadata(
            LIBRARY_RECOMMENDATION_CANDIDATE_LIMIT_KEY,
            &request.candidate_limit.to_string(),
        )?;
        Ok(library_answer_settings_from_db(db))
    })
}

#[tauri::command]
pub(crate) fn set_library_recommendation_result_limit(
    state: tauri::State<AppState>,
    request: SetLibraryRecommendationResultLimitRequest,
) -> Result<LibraryAnswerSettings, String> {
    if !(MIN_LIBRARY_RECOMMENDATION_RESULT_LIMIT..=MAX_LIBRARY_RECOMMENDATION_RESULT_LIMIT)
        .contains(&request.result_limit)
    {
        return Err(format!(
            "大模型精选数量只支持 {MIN_LIBRARY_RECOMMENDATION_RESULT_LIMIT}–{MAX_LIBRARY_RECOMMENDATION_RESULT_LIMIT} 本"
        ));
    }
    state.with_db_write("ai_reader_set_recommendation_result_limit", |db| {
        db.set_metadata(
            LIBRARY_RECOMMENDATION_RESULT_LIMIT_KEY,
            &request.result_limit.to_string(),
        )?;
        Ok(library_answer_settings_from_db(db))
    })
}

#[tauri::command]
pub(crate) fn set_library_model_tags_enabled(
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<LibraryModelTagsSettings, String> {
    state.with_db_write("ai_reader_set_model_tags_enabled", |db| {
        db.set_metadata(
            LIBRARY_MODEL_TAGS_ENABLED_KEY,
            if enabled { "true" } else { "false" },
        )
    })?;
    Ok(LibraryModelTagsSettings { enabled })
}

#[tauri::command]
pub(crate) fn start_library_auto_classification(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<BackgroundTaskSnapshot, String> {
    let config = state.with_db_read("ai_reader_start_library_classification", |db| {
        Ok(canonicalize_deepseek_config(load_config_for_purpose(
            db, "other",
        )?))
    })?;
    if !status(&config).configured {
        return Err("请先在任意阅读页的“智读”中配置接口、模型和 API Key".into());
    }
    if state
        .background_tasks
        .latest_for_kind(BackgroundTaskKind::LibraryClassification)
        .is_some_and(|task| classification_task_blocks_start(task.state))
    {
        return Err("书籍分类正在进行中".into());
    }
    let handle = state.background_tasks.enqueue_or_resume(
        BackgroundTaskKind::LibraryClassification,
        "书籍分类：生成本地暗标签",
    );
    let snapshot = handle.snapshot().ok_or("无法建立书籍分类任务")?;
    let app = app.clone();
    handle.spawn_detached("library-ai-classification", move |task| {
        let state = app.state::<AppState>();
        classify_library_books(state.inner(), config, task);
    })?;
    Ok(snapshot)
}

/// Inputs to the verification pass. Keeping them together prevents call sites
/// from swapping the draft, evidence context, or cancellation channel.
struct LibraryAnswerVerification<'a> {
    config: StoredConfig,
    task: &'a str,
    question: &'a str,
    draft: String,
    context: String,
    evidence_sources: Option<&'a [AiReaderSource]>,
    answer_length: LibraryAnswerLength,
    cancellation: Option<watch::Receiver<bool>>,
}

/// Re-read a completed answer against exactly the cited local context. A
/// provider failure must not discard an otherwise usable answer, so callers
/// receive the draft as a safe fallback.
async fn verify_library_answer(
    verification: LibraryAnswerVerification<'_>,
) -> Result<String, String> {
    let LibraryAnswerVerification {
        config,
        task,
        question,
        draft,
        context,
        evidence_sources,
        answer_length,
        cancellation,
    } = verification;
    let is_readable_final = |answer: &str| is_final_library_verification(task, answer);
    let accepts = |answer: &str| {
        is_readable_final(answer)
            && evidence_sources.is_none_or(|sources| {
                task != "library_question_verify"
                    || library_answer_has_sufficient_synthesis(answer, sources, answer_length)
            })
    };
    let verify_question = format!(
        "用户问题：{question}\n\n作答规格：{}\n\n待审草稿：\n{draft}",
        answer_length.prompt_specification()
    );
    let verify_task = task.to_string();
    let verified = match await_library_provider(
        cancellation.clone(),
        call_reading_provider_async(
            config.clone(),
            verify_task.clone(),
            verify_question,
            context.clone(),
        ),
    )
    .await
    {
        Ok(answer) => Some(answer),
        Err(error) if error == LIBRARY_REQUEST_CANCELLED => return Err(error),
        Err(_) => None,
    };
    if let Some(answer) = verified.as_deref().filter(|answer| accepts(answer)) {
        return Ok(answer.to_string());
    }
    if accepts(&draft) {
        return Ok(draft);
    }

    let repair_task =
        (verify_task == "library_question_verify").then_some("library_question_repair");
    let repaired = if let Some(repair_task) = repair_task {
        let repair_question = format!(
            "用户问题：{question}\n\n作答规格：{}\n\n请只输出最终答案，并严格遵守该作答规格。",
            answer_length.prompt_specification()
        );
        match await_library_provider(
            cancellation,
            call_reading_provider_async(config, repair_task.to_string(), repair_question, context),
        )
        .await
        {
            Ok(answer) => Some(answer),
            Err(error) if error == LIBRARY_REQUEST_CANCELLED => return Err(error),
            Err(_) => None,
        }
    } else {
        None
    };
    if let Some(answer) = repaired.as_deref().filter(|answer| accepts(answer)) {
        return Ok(answer.to_string());
    }

    // Evidence breadth is an improvement target, not a reason to erase a
    // reader-facing answer. If every rewrite misses the enhanced threshold,
    // retain the best structurally safe answer; audit transcripts and malformed
    // output still remain blocked by `is_readable_final`.
    for answer in [
        repaired.as_deref(),
        verified.as_deref(),
        Some(draft.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        if is_readable_final(answer) {
            return Ok(answer.to_string());
        }
    }
    Ok("本次回答未通过格式与引用校验，请重新提问。".to_string())
}

/// Do not replace a usable draft with a model audit transcript. This check
/// validates fixed answer shapes; compare answers have no fixed headings but
/// still reject known internal-review language.
fn is_final_library_verification(task: &str, answer: &str) -> bool {
    let answer = answer.trim();
    if answer.is_empty() {
        return false;
    }
    let internal_markers = [
        "草稿声称",
        "现在核对",
        "让我仔细核对",
        "作为终审编辑",
        "我需要决定",
        "审核过程",
        "来源 1：包含",
        "用户的问题是",
        "原始文本",
        "依据 1 和 2",
        "因此，我",
        "需要修正",
        "某来源",
        "某部作品",
        "某人",
    ];
    if internal_markers
        .iter()
        .any(|marker| answer.contains(marker))
    {
        return false;
    }
    match task {
        "library_question_verify" => ["## 直接回答", "## 关键依据", "## 解读"]
            .iter()
            .all(|heading| answer.contains(heading)),
        "library_single_book_verify" => ["## 直接回答", "## 这本书具体写了什么", "## 解读"]
            .iter()
            .all(|heading| answer.contains(heading)),
        _ => true,
    }
}

/// Reading-mode verification has the same fail-safe behaviour as library
/// verification: an unavailable provider must not discard a useful draft, but
/// whenever it is available the final text is checked against the exact local
/// passages that were selected for this request.
async fn verify_reading_answer(
    config: StoredConfig,
    task: &str,
    question: &str,
    draft: String,
    context: String,
) -> String {
    let verify_question = format!("用户问题：{question}\n\n待审草稿：\n{draft}");
    let task = task.to_string();
    match tokio::task::spawn_blocking(move || {
        call_reading_provider(config, task, verify_question, context)
    })
    .await
    {
        Ok(Ok(verified)) if !verified.trim().is_empty() => verified,
        _ => draft,
    }
}

#[tauri::command]
pub(crate) fn library_history_source_preview(
    state: tauri::State<'_, AppState>,
    request: LibraryHistorySourcePreviewRequest,
) -> Result<AiReaderSource, String> {
    let book = {
        let library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败，暂时无法读取引用正文".to_string())?;
        let local_id = matching_local_book_id(
            library.books.iter().map(|book| LocalHistoryBookRef {
                id: book.id,
                title: &book.title,
            }),
            &request.book_id,
            &request.book_title,
        );
        local_id
            .and_then(|id| library.books.iter().find(|book| book.id == id))
            .cloned()
            .ok_or_else(|| "原书未加入本机书架或已被移除，无法显示引用正文".to_string())?
    };
    let chapters = search::get_book_chapters(state.inner(), &book)
        .ok_or_else(|| "无法读取本机书籍的章节正文".to_string())?;
    let chapter_index = request.chapter as usize;
    let chapter = chapters
        .get(chapter_index)
        .ok_or_else(|| format!("《{}》没有第 {} 章", book.title, chapter_index + 1))?;
    let excerpt = trim_to_chars(chapter.trim(), HISTORY_SOURCE_PREVIEW_CHARS);
    if excerpt.is_empty() {
        return Err("该章节没有可显示的正文".to_string());
    }
    Ok(AiReaderSource {
        book_id: book.id.to_string(),
        book_title: book.title,
        chapter: request.chapter,
        excerpt,
        source_kind: restored_source_kind(&request.source_kind),
        tags: Vec::new(),
    })
}

/// Answer a question from the locally indexed library (one selected book, the
/// whole library, or a selected cross-book comparison). The retrieval phase
/// only reads existing local vector/index files; it does not build an index,
/// open raw book files, or synchronize any RAG data.
fn library_request_id(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("书库问答请求标识无效".to_string());
    }
    Ok(Some(value.to_string()))
}

#[tauri::command]
pub(crate) async fn ask_library_assistant(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: LibraryAiReaderAskRequest,
) -> Result<AiReaderAnswer, String> {
    let request_id = library_request_id(request.request_id.as_deref())?;
    let request_guard = request_id
        .map(|id| state.begin_library_ai_request(id))
        .transpose()?;
    let cancellation = request_guard.as_ref().map(|guard| guard.cancellation());
    let task = request.task.trim().to_ascii_lowercase();
    if !matches!(task.as_str(), "question" | "compare" | "recommend") {
        return Err("书库问答只支持 question、compare 或 recommend 任务".into());
    }
    let question = request.question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题".into());
    }
    if question.chars().count() > MAX_LIBRARY_QUESTION_CHARS {
        return Err(format!("问题不能超过 {MAX_LIBRARY_QUESTION_CHARS} 个字符"));
    }
    let compare = task == "compare";
    let recommend = task == "recommend";
    let mut selected_ids = normalize_selected_book_ids(
        request.selected_book_ids,
        if compare {
            Some(MAX_LIBRARY_COMPARE_BOOKS)
        } else {
            None
        },
    )?;
    if compare && selected_ids.as_ref().is_none_or(|ids| ids.len() < 2) {
        return Err("跨书对比至少需要选择两本图书".into());
    }
    if !compare && !recommend && selected_ids.is_none() {
        if let Some(book_id) = implicit_single_book_id(state.inner(), &question)? {
            selected_ids = Some(vec![book_id]);
        }
    }
    let single_book =
        !compare && !recommend && selected_ids.as_ref().is_some_and(|ids| ids.len() == 1);
    let search_scope = if compare || selected_ids.is_some() {
        selected_ids.clone()
    } else {
        Some(full_library_semantic_scope(state.inner())?)
    };
    let (config, answer_length, recommendation_candidate_limit, recommendation_result_limit) =
        state.with_db_read("ai_reader_library_answer_config", |db| {
            Ok((
                canonicalize_deepseek_config(load_config_for_purpose(db, "library")?),
                library_answer_length(db),
                library_recommendation_candidate_limit(db),
                library_recommendation_result_limit(db),
            ))
        })?;
    if !status(&config).configured {
        return Err("请先在阅读助手中配置接口、模型和 API Key".into());
    }

    let (mut results, structure_sources, thematic_hit_keys) = if single_book {
        let depth = single_book_depth_search(
            app.clone(),
            &question,
            selected_ids
                .as_ref()
                .and_then(|ids| ids.first())
                .ok_or("单书深度检索缺少图书 ID")?,
        )
        .await?;
        (depth.semantic_results, depth.structure_sources, None)
    } else {
        let mut batches = Vec::new();
        for (index, query) in library_retrieval_queries(&question).into_iter().enumerate() {
            batches.push((
                semantic::semantic_search(app.clone(), query, search_scope.clone()).await?,
                index > 0,
            ));
        }
        let merged = merge_library_search_results(batches);
        (merged.results, Vec::new(), Some(merged.thematic_hit_keys))
    };
    // 大模型标签始终参与问答的检索和提示词；设置开关只影响用户在左侧
    // 范围筛选时是否看见、选择这些分类标签。
    let model_tags = model_tags_by_book(state.inner())?;
    let _matched_tags = boost_results_with_profiles(&mut results, &question, &model_tags);
    let mut sources = if single_book {
        select_single_book_sources(
            &results,
            selected_ids
                .as_ref()
                .and_then(|ids| ids.first())
                .ok_or("单书深度检索缺少图书 ID")?,
            &question,
            structure_sources,
        )?
    } else {
        if recommend {
            select_library_sources_with_limit(
                &results,
                selected_ids.as_deref(),
                false,
                &question,
                thematic_hit_keys.as_ref(),
                recommendation_candidate_limit,
            )?
        } else {
            select_library_sources(
                &results,
                selected_ids.as_deref(),
                compare,
                &question,
                thematic_hit_keys.as_ref(),
            )?
        }
    };
    for source in &mut sources {
        source.tags = model_tags.get(&source.book_id).cloned().unwrap_or_default();
    }
    if recommend {
        let context = library_booklist_candidate_context(&sources);
        if context.is_empty() {
            return Err("没有可发送的本地候选片段".into());
        }
        let effective_result_limit = recommendation_result_limit.min(sources.len());
        let recommendation_question = format!(
            "{question}\n\n【推荐数量】当前有 {} 本本地候选，请精选 {effective_result_limit} 本；若候选少于 5 本，这个数字就是实际候选数，继续推荐且不要拒绝。",
            sources.len()
        );
        let generated = call_library_answer_with_retry(
            config,
            "library_booklist_recommend".to_string(),
            recommendation_question,
            context,
            cancellation.clone(),
        )
        .await?;
        let recommendation =
            parse_library_booklist_recommendation(&generated, &sources, effective_result_limit)?;
        return Ok(AiReaderAnswer {
            ok: true,
            content: recommendation.summary.clone(),
            sources,
            single_book: false,
            retrieval_stages: vec!["本地语义粗选".into(), "大模型精选与评语".into()],
            citation_checked: false,
            recommendation: Some(recommendation),
            error: String::new(),
        });
    }
    let content = if compare {
        let context = library_context(&sources);
        if context.is_empty() {
            return Err("没有可发送的检索片段".into());
        }
        let draft = call_library_answer_with_retry(
            config.clone(),
            "library_compare".to_string(),
            library_question_with_length(&question, answer_length),
            context.clone(),
            cancellation.clone(),
        )
        .await?;
        verify_library_answer(LibraryAnswerVerification {
            config,
            task: "library_compare_verify",
            question: &question,
            draft,
            context,
            evidence_sources: None,
            answer_length,
            cancellation: cancellation.clone(),
        })
        .await?
    } else {
        let candidate_context = library_context(&sources);
        if candidate_context.is_empty() {
            return Err("没有可发送的检索片段".into());
        }
        let filter_task = if single_book {
            "library_single_book_evidence_filter"
        } else {
            "library_evidence_filter"
        };
        let filtered = await_library_provider(
            cancellation.clone(),
            call_reading_provider_async(
                config.clone(),
                filter_task.to_string(),
                question.clone(),
                candidate_context,
            ),
        )
        .await;
        if matches!(filtered.as_ref(), Err(error) if error == LIBRARY_REQUEST_CANCELLED) {
            return Err(LIBRARY_REQUEST_CANCELLED.to_string());
        }
        let mut source_ids = filtered
            .ok()
            .map(|response| parse_deep_source_ids(&response, sources.len()))
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| fallback_deep_source_ids(sources.len()));
        source_ids.truncate(answer_length.source_limit());
        let source_ids = if single_book {
            source_ids
        } else {
            ensure_library_synthesis_source_ids(&sources, source_ids, &question, answer_length)
        };
        expand_library_semantic_sources(&app, &mut sources, &source_ids, answer_length);
        let context = library_context_for_source_ids(&sources, &source_ids);
        if context.is_empty() {
            return Err("没有可发送的深度解读证据".into());
        }
        let answer_task = if single_book {
            "library_single_book_question"
        } else {
            "library_question"
        };
        let draft = call_library_answer_with_retry(
            config.clone(),
            answer_task.to_string(),
            library_question_with_length(&question, answer_length),
            context.clone(),
            cancellation.clone(),
        )
        .await?;
        let verify_task = if single_book {
            "library_single_book_verify"
        } else {
            "library_question_verify"
        };
        verify_library_answer(LibraryAnswerVerification {
            config,
            task: verify_task,
            question: &question,
            draft,
            context,
            evidence_sources: (!single_book).then_some(sources.as_slice()),
            answer_length,
            cancellation,
        })
        .await?
    };
    Ok(AiReaderAnswer {
        ok: true,
        content,
        sources,
        single_book,
        retrieval_stages: vec!["语义检索".into(), "证据筛选".into(), "引用自检".into()],
        citation_checked: true,
        recommendation: None,
        error: String::new(),
    })
}

/// Cancel one active local-library provider request. Dropping the corresponding
/// reqwest future closes the in-flight HTTP exchange; completed/unknown ids are
/// harmless so a late UI cleanup cannot surface a misleading error.
#[tauri::command]
pub(crate) fn cancel_library_assistant(
    state: tauri::State<'_, AppState>,
    request: LibraryAiReaderCancelRequest,
) -> Result<(), String> {
    let Some(request_id) = library_request_id(Some(&request.request_id))? else {
        return Ok(());
    };
    let _ = state.cancel_library_ai_request(&request_id)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ask_reading_assistant(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: AiReaderAskRequest,
) -> Result<AiReaderAnswer, String> {
    let book_id = reader_window_id(&window).ok_or("请在阅读窗口使用阅读助手")?;
    let task = request.task.trim().to_lowercase();
    if !matches!(task.as_str(), "question" | "summary" | "mindmap") {
        return Err("不支持的阅读助手任务".into());
    }
    let (book, saved_current, saved_fraction) = {
        let library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let book = library.get(book_id).cloned().ok_or("找不到当前图书")?;
        (
            book.clone(),
            book.resume_chapter as usize,
            book.resume_frac.clamp(0.0, 1.0),
        )
    };
    let chapters = search::get_book_chapters(state.inner(), &book).ok_or("无法读取这本书的正文")?;
    let current = request
        .current_chapter
        .map(|chapter| chapter as usize)
        .unwrap_or(saved_current)
        .min(chapters.len().saturating_sub(1));
    let current_fraction = request
        .current_fraction
        .unwrap_or(saved_fraction)
        .clamp(0.0, 1.0);
    // 智读只能检索已经读完的章节，以及当前章节已经读到的部分，避免后续内容剧透。
    let readable_end = current.min(chapters.len().saturating_sub(1));
    let mut readable = chapters[..readable_end].to_vec();
    if let Some(current_chapter) = chapters.get(readable_end) {
        let readable_chars =
            ((current_chapter.chars().count() as f32) * current_fraction).floor() as usize;
        let current_excerpt: String = current_chapter.chars().take(readable_chars).collect();
        if !current_excerpt.trim().is_empty() {
            readable.push(current_excerpt);
        }
    }
    let selected_text = request
        .selected_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| trim_to_chars(text, MAX_SELECTED_TEXT_CHARS))
        .unwrap_or_default();
    let readable_current = readable.len().saturating_sub(1);
    let book_id = book.id.to_string();
    let mut sources = build_reading_evidence_sources(ReadingEvidenceInput {
        readable: &readable,
        current: readable_current,
        question: &request.question,
        selected_text: &selected_text,
        selected_start: request.selected_start,
        selected_end: request.selected_end,
        book_id: &book_id,
        book_title: &book.title,
    });
    let candidate_context = library_context(&sources);
    if candidate_context.is_empty() {
        return Err("当前图书没有可发送的正文内容".into());
    }
    let config = state.with_db_read("ai_reader_reading_answer_config", |db| {
        Ok(canonicalize_deepseek_config(load_config_for_purpose(
            db, "reading",
        )?))
    })?;
    if !status(&config).configured {
        return Err("请先在阅读助手中配置接口、模型和 API Key".into());
    }
    let question = request.question.trim().to_string();
    let session_memory = trim_to_chars(
        request.session_memory.trim(),
        MAX_READING_SESSION_MEMORY_CHARS,
    );
    let filter_question = if session_memory.is_empty() {
        question.clone()
    } else {
        format!("{question}\n\n[本机阅读会话记忆，仅作连贯性提示]\n{session_memory}")
    };
    let evidence_config = config.clone();
    let evidence_question = filter_question.clone();
    let evidence_context = candidate_context.clone();
    let filtered = tokio::task::spawn_blocking(move || {
        call_reading_provider(
            evidence_config,
            "reading_evidence_filter".to_string(),
            evidence_question,
            evidence_context,
        )
    })
    .await
    .map_err(|error| format!("智读证据筛选任务失败：{error}"))?;
    let source_ids = filtered
        .ok()
        .map(|response| parse_deep_source_ids(&response, sources.len()))
        .filter(|ids| !ids.is_empty())
        .unwrap_or_else(|| fallback_deep_source_ids(sources.len()));
    let context = library_context_for_source_ids(&sources, &source_ids);
    if context.is_empty() {
        return Err("当前已读内容中没有可用的智读依据".into());
    }
    let answer_task = match task.as_str() {
        "summary" => "reading_summary",
        "mindmap" => "mindmap",
        _ => "reading_question",
    }
    .to_string();
    let answer_prompt = format!("《{}》：{}", book.title, filter_question);
    let answer_config = config.clone();
    let answer_context = context.clone();
    let answer_task_for_primary = answer_task.clone();
    let answer_prompt_for_primary = answer_prompt.clone();
    let primary = tokio::task::spawn_blocking(move || {
        call_reading_provider(
            answer_config,
            answer_task_for_primary,
            answer_prompt_for_primary,
            answer_context,
        )
    })
    .await
    .map_err(|error| format!("阅读助手任务失败：{error}"))?;
    let draft = match primary {
        Ok(answer) => answer,
        Err(primary_error) => {
            // Some OpenAI-compatible endpoints occasionally acknowledge a
            // long structured prompt but emit an empty `content`. Retry once
            // with the same task and source numbering, constrained to the
            // strongest few passages. This keeps citations usable and avoids
            // turning a transient empty completion into a visible failure.
            let retry_context = compact_reading_context_for_source_ids(&sources, &source_ids);
            let retry_context = if retry_context.is_empty() {
                context.clone()
            } else {
                retry_context
            };
            let retry_config = config.clone();
            let retry_task = answer_task;
            let retry_prompt = answer_prompt;
            tokio::task::spawn_blocking(move || {
                call_reading_provider(retry_config, retry_task, retry_prompt, retry_context)
            })
            .await
            .map_err(|error| format!("智读精简重试任务失败：{error}"))?
            .map_err(|retry_error| {
                format!("智读未能生成回答：{primary_error}；精简证据重试也失败：{retry_error}")
            })?
        }
    };
    let citation_checked = task != "mindmap";
    let content = if citation_checked {
        let verify_task = if task == "summary" {
            "reading_summary_verify"
        } else {
            "reading_question_verify"
        };
        verify_reading_answer(config, verify_task, &question, draft, context).await
    } else {
        draft
    };
    // Retain the candidate order so [来源 N] in the answer always maps to the
    // visible source list. The evidence filter decides which numbers the model
    // may cite; the list keeps surrounding provenance inspectable.
    if !source_ids.is_empty() {
        for source in &mut sources {
            if source.source_kind == "已读正文检索" {
                source.source_kind = "已读正文混合检索".into();
            }
        }
    }
    Ok(AiReaderAnswer {
        ok: true,
        content,
        sources,
        single_book: false,
        retrieval_stages: vec![
            "选句与邻近正文".into(),
            "已读范围混合检索".into(),
            "证据筛选与重排".into(),
            if citation_checked {
                "引用自检".into()
            } else {
                "脑图依据核对".into()
            },
        ],
        citation_checked,
        recommendation: None,
        error: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_length_controls_continuous_source_windows() {
        assert_eq!(
            library_source_context_chars(LibraryAnswerLength::Short),
            None
        );
        assert_eq!(
            library_source_context_chars(LibraryAnswerLength::Medium),
            Some(800)
        );
        assert_eq!(
            library_source_context_chars(LibraryAnswerLength::Long),
            Some(1_200)
        );
    }

    #[test]
    fn normalizes_full_chat_completions_url_to_a_base_url() {
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/chat/completions/").unwrap(),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn provider_error_keeps_actionable_message_without_a_secret() {
        let error =
            provider::error_summary(400, r#"{\"error\":{\"message\":\"Model Not Exist\"}}"#);
        assert!(error.contains("Model Not Exist"));
        assert!(error.contains("模型名"));
        assert!(!error.contains("Bearer"));
    }

    #[test]
    fn profile_summary_never_exposes_the_api_key() {
        let profile = StoredAiReaderProfile {
            id: "primary".into(),
            name: "主模型".into(),
            config: StoredConfig {
                provider: "compatible".into(),
                base_url: "https://example.test/v1".into(),
                model: "example-model".into(),
                api_key: "secret-must-not-reach-ui".into(),
            },
        };
        let summary = profile_summary(&profile);
        let json = serde_json::to_string(&summary).unwrap();
        assert!(summary.configured);
        assert!(!json.contains("secret-must-not-reach-ui"));
    }

    #[test]
    fn model_assignments_are_independent_and_keep_reading_as_legacy_active() {
        let profile = |id: &str, model: &str| StoredAiReaderProfile {
            id: id.into(),
            name: id.into(),
            config: StoredConfig {
                provider: "compatible".into(),
                base_url: "https://example.test/v1".into(),
                model: model.into(),
                api_key: "key".into(),
            },
        };
        let mut profiles = StoredAiReaderProfiles {
            active_id: "read".into(),
            assignments: AiReaderProfileAssignments {
                reading_id: "read".into(),
                library_id: "library".into(),
                other_id: "other".into(),
            },
            profiles: vec![
                profile("read", "reading-model"),
                profile("library", "library-model"),
                profile("other", "tag-model"),
            ],
        };
        normalize_profile_assignments(&mut profiles);
        assert_eq!(profiles.active_id, "read");
        assert_eq!(
            profile_for_purpose(&profiles, "reading")
                .unwrap()
                .config
                .model,
            "reading-model"
        );
        assert_eq!(
            profile_for_purpose(&profiles, "library")
                .unwrap()
                .config
                .model,
            "library-model"
        );
        assert_eq!(
            profile_for_purpose(&profiles, "other")
                .unwrap()
                .config
                .model,
            "tag-model"
        );
    }

    #[test]
    fn upgrades_legacy_model_for_official_deepseek_only() {
        let official = canonicalize_deepseek_config(StoredConfig {
            provider: String::new(),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            api_key: "unused".into(),
        });
        assert_eq!(official.model, "deepseek-v4-flash");

        let compatible_provider = canonicalize_deepseek_config(StoredConfig {
            provider: String::new(),
            base_url: "https://example.test/v1".into(),
            model: "deepseek-chat".into(),
            api_key: "unused".into(),
        });
        assert_eq!(compatible_provider.model, "deepseek-chat");
    }

    #[test]
    fn recognizes_provider_and_uses_the_correct_protocol_endpoint() {
        assert_eq!(
            profiles::infer_provider("https://api.openai.com/v1"),
            "openai"
        );
        assert_eq!(
            profiles::infer_provider("https://api.anthropic.com"),
            "anthropic"
        );
        assert_eq!(
            provider::endpoint_for("https://api.anthropic.com", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            provider::endpoint_for("https://api.anthropic.com/v1", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn accepts_android_key_only_secret_bundle() {
        let config = config_from_secret_bundle(
            &StoredConfig::default(),
            &serde_json::json!({"api_key": "android-key"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.api_key, "android-key");
        assert_eq!(config.provider, "deepseek");
        assert_eq!(config.base_url, "https://api.deepseek.com/v1");
        assert_eq!(config.model, "deepseek-v4-flash");
    }

    #[test]
    fn android_key_only_bundle_keeps_synced_public_provider() {
        let config = config_from_secret_bundle(
            &StoredConfig {
                provider: "openai".into(),
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-5.4-mini".into(),
                api_key: String::new(),
            },
            &serde_json::json!({"api_key": "android-key"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.provider, "openai");
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert_eq!(config.model, "gpt-5.4-mini");
    }

    #[test]
    fn reading_prompts_require_evidence_selection_and_citation_audit() {
        assert!(system_prompt("reading_evidence_filter").contains("sourceIds"));
        assert!(system_prompt("reading_question").contains("## 直接解释"));
        assert!(system_prompt("reading_question").contains("[来源 N]"));
        assert!(system_prompt("reading_question_verify").contains("引用审校人"));
        assert!(system_prompt("reading_summary").contains("## 已读摘要"));
    }

    #[test]
    fn openai_compatible_responses_accept_text_blocks_as_well_as_strings() {
        let string_response = serde_json::json!({
            "choices": [{"message": {"content": "  直接回答  "}}]
        });
        assert_eq!(
            provider::openai_compatible_content(&string_response).as_deref(),
            Some("直接回答")
        );
        let block_response = serde_json::json!({
            "choices": [{"message": {"content": [
                {"type": "text", "text": "第一段"},
                {"type": "text", "text": "第二段"}
            ]}}]
        });
        assert_eq!(
            provider::openai_compatible_content(&block_response).as_deref(),
            Some("第一段\n第二段")
        );
        let wrapped_response = serde_json::json!({
            "data": {"choices": [{"message": {"content": "包装后的回答"}}]}
        });
        assert_eq!(
            provider::openai_compatible_content(&wrapped_response).as_deref(),
            Some("包装后的回答")
        );
        let reasoning_only_response = serde_json::json!({
            "choices": [{"message": {"content": "", "reasoning_content": "内部推理，不应展示"}}]
        });
        assert_eq!(
            provider::openai_compatible_content(&reasoning_only_response),
            None
        );
        let capitalized_response = serde_json::json!({
            "Response": {"Choices": [{"Message": {"Content": "大写包装回答"}}]}
        });
        assert_eq!(
            provider::openai_compatible_content(&capitalized_response).as_deref(),
            Some("大写包装回答")
        );
    }

    #[test]
    fn library_synthesis_has_room_for_reasoning_and_a_final_answer() {
        assert_eq!(
            provider_max_tokens("library_question"),
            LIBRARY_SYNTHESIS_PROVIDER_MAX_TOKENS
        );
        assert_eq!(
            provider_max_tokens("library_question_verify"),
            LIBRARY_SYNTHESIS_PROVIDER_MAX_TOKENS
        );
        assert_eq!(
            provider_max_tokens("library_evidence_filter"),
            READING_PROVIDER_MAX_TOKENS
        );
        assert_eq!(
            provider_max_tokens("reading_question"),
            READING_PROVIDER_MAX_TOKENS
        );
    }

    fn sem_book(id: &str, title: &str, chapters: &[(u32, &str)]) -> semantic::SemBookHits {
        semantic::SemBookHits {
            book_id: id.to_string(),
            title: title.to_string(),
            author: String::new(),
            score: 1.0,
            hits: chapters
                .iter()
                .map(|(chapter, snippet)| semantic::SemHit {
                    chapter: *chapter,
                    snippet: (*snippet).to_string(),
                    score: 1.0,
                })
                .collect(),
        }
    }

    #[test]
    fn library_selection_preserves_book_metadata_and_bounds_context() {
        let results = vec![
            sem_book("7", "甲书", &[(2, "甲书的证据"), (3, "甲书的第二段")]),
            sem_book("8", "乙书", &[(4, "乙书的证据")]),
        ];
        let sources = select_library_sources(&results, None, false, "关键问题", None).unwrap();
        assert_eq!(sources[0].book_id, "7");
        assert_eq!(sources[0].book_title, "甲书");
        assert_eq!(sources[0].chapter, 2);
        let context = library_context(&sources);
        assert!(context.contains("[来源 1｜《甲书》｜第 3 章｜材料：正文检索｜本地书籍 ID 7]"));
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
    }

    #[test]
    fn library_question_keeps_the_top_twenty_distinct_books() {
        let results = (1..=25)
            .map(|id| sem_book(&id.to_string(), &format!("第{id}本"), &[(0, "证据")]))
            .collect::<Vec<_>>();
        let sources = select_library_sources(&results, None, false, "关键问题", None).unwrap();
        assert_eq!(sources.len(), MAX_LIBRARY_QUESTION_SOURCES);
        assert_eq!(sources[0].book_id, "1");
        assert_eq!(sources[19].book_id, "20");
        assert_eq!(
            sources
                .iter()
                .map(|source| source.book_id.as_str())
                .collect::<HashSet<_>>()
                .len(),
            MAX_LIBRARY_QUESTION_SOURCES
        );
    }

    #[test]
    fn library_recommendation_respects_the_configured_candidate_limit() {
        let results = (1..=12)
            .map(|id| sem_book(&id.to_string(), &format!("第{id}本"), &[(0, "证据")]))
            .collect::<Vec<_>>();
        let sources =
            select_library_sources_with_limit(&results, None, false, "关键问题", None, 7).unwrap();
        assert_eq!(sources.len(), 7);
        assert_eq!(sources[6].book_id, "7");
    }

    #[test]
    fn library_question_never_repeats_a_book_when_results_are_duplicated() {
        let results = vec![
            sem_book("7", "甲书", &[(0, "甲书的第一段")]),
            sem_book("7", "甲书", &[(1, "甲书的重复候选")]),
            sem_book("8", "乙书", &[(0, "乙书的第一段")]),
        ];
        let sources = select_library_sources(&results, None, false, "关键问题", None).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].book_id, "7");
        assert_eq!(sources[1].book_id, "8");
    }

    #[test]
    fn themed_library_search_keeps_semantically_matched_love_passages_without_word_match() {
        let results = vec![
            sem_book(
                "1",
                "英雄志",
                &[(0, "他从此不做官，也不做侠，人生只剩下她。")],
            ),
            sem_book("2", "兵器谱", &[(0, "众人争夺灵道石色，武功决定胜负。")]),
            sem_book("3", "江湖旧事", &[(0, "夫妻在乱世中离别后仍相守。")]),
        ];
        let thematic_hit_keys = [library_semantic_hit_key("1", &results[0].hits[0])]
            .into_iter()
            .collect::<HashSet<_>>();
        let sources = select_library_sources(
            &results,
            None,
            false,
            "武侠小说中的情爱有什么特点",
            Some(&thematic_hit_keys),
        )
        .unwrap();
        assert_eq!(
            sources
                .iter()
                .map(|source| source.book_title.as_str())
                .collect::<Vec<_>>(),
            vec!["英雄志", "江湖旧事"]
        );
        assert!(!sources.iter().any(|source| source.book_title == "兵器谱"));
        assert_eq!(
            library_retrieval_queries("武侠小说中的情爱有什么特点").len(),
            2
        );
        assert_eq!(library_retrieval_queries("武侠小说的叙事特点").len(), 1);
    }

    #[test]
    fn single_book_depth_retrieval_uses_multiple_queries_and_chapters() {
        let queries = single_book_retrieval_queries("南明史写了什么", "南明史");
        assert_eq!(queries.len(), 4);
        assert!(queries.iter().any(|query| query.contains("主要内容")));
        let results = vec![sem_book(
            "7",
            "南明史",
            &[(1, "第一章证据"), (2, "第二章证据"), (3, "第三章证据")],
        )];
        let sources =
            select_single_book_sources(&results, "7", "南明史写了什么", Vec::new()).unwrap();
        assert_eq!(sources.len(), 3);
        assert_eq!(
            sources
                .iter()
                .map(|source| source.chapter)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn single_book_sources_prioritize_structure_then_body_over_preface() {
        let results = vec![sem_book(
            "7",
            "南明史",
            &[
                (0, "前言：这里说明本书写作缘起。"),
                (1, "第一章正文：南明政权的建立与局势。"),
                (2, "第二章正文：各方力量的冲突与变化。"),
            ],
        )];
        let structure = vec![AiReaderSource {
            book_id: "7".into(),
            book_title: "南明史".into(),
            chapter: 9,
            excerpt: "目录：第一章、第二章、第三章。".into(),
            source_kind: "目录".into(),
            tags: Vec::new(),
        }];
        let sources =
            select_single_book_sources(&results, "7", "南明史写了什么", structure).unwrap();
        assert_eq!(sources[0].source_kind, "目录");
        assert_eq!(sources[1].chapter, 1);
        assert_eq!(sources[2].chapter, 2);
        assert_eq!(sources[3].chapter, 0);
        assert!(source_looks_like_front_or_back_matter("前言：写作缘起"));
        assert!(!source_looks_like_front_or_back_matter("第一章 正文内容"));
    }

    #[test]
    fn deep_evidence_selection_keeps_valid_unique_source_ids() {
        assert_eq!(
            parse_deep_source_ids("```json\n{\"sourceIds\":[7,2,7,99,0]}\n```", 20),
            vec![7, 2]
        );
        assert!(parse_deep_source_ids("无法确定", 20).is_empty());
        assert_eq!(fallback_deep_source_ids(3), vec![1, 2, 3]);
    }

    #[test]
    fn booklist_recommendation_only_accepts_local_candidates_with_reviews() {
        let candidates = vec![
            AiReaderSource {
                book_id: "7".into(),
                book_title: "甲书".into(),
                chapter: 0,
                excerpt: "甲书的本地命中片段".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
            AiReaderSource {
                book_id: "8".into(),
                book_title: "乙书".into(),
                chapter: 0,
                excerpt: "乙书的本地命中片段".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
        ];
        let recommendation = parse_library_booklist_recommendation(
            r#"```json
            {"summary":"围绕问题的读法","items":[
              {"bookId":"999","review":"候选外图书"},
              {"bookId":"7","review":"直接回应问题。"},
              {"bookId":"7","review":"重复项"},
              {"bookId":"8","review":"补足另一侧材料。"}
            ]}
            ```"#,
            &candidates,
            12,
        )
        .unwrap();
        assert_eq!(recommendation.items.len(), 2);
        assert_eq!(recommendation.items[0].title, "甲书");
        assert_eq!(recommendation.items[1].book_id, "8");
    }

    #[test]
    fn library_booklist_recommendation_keeps_fewer_than_five_candidates() {
        let candidates = (1..=3)
            .map(|id| AiReaderSource {
                book_id: id.to_string(),
                book_title: format!("第{id}本"),
                chapter: 0,
                excerpt: format!("第{id}本的本地命中片段"),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            })
            .collect::<Vec<_>>();
        let recommendation = parse_library_booklist_recommendation(
            r#"{"items":[
              {"bookId":"1","review":"第一本适合。"},
              {"bookId":"2","review":"第二本适合。"},
              {"bookId":"3","review":"第三本适合。"}
            ]}"#,
            &candidates,
            candidates.len(),
        )
        .unwrap();
        assert_eq!(recommendation.items.len(), 3);
    }

    #[test]
    fn compact_booklist_context_keeps_all_one_hundred_candidates() {
        let candidates = (1..=100)
            .map(|id| AiReaderSource {
                book_id: id.to_string(),
                book_title: format!("第{id}本候选图书"),
                chapter: 0,
                excerpt: "用于推荐判断的本地命中片段，内容会按候选数量自动压缩。".repeat(4),
                source_kind: "正文检索".into(),
                tags: vec!["主题：测试".into()],
            })
            .collect::<Vec<_>>();
        let context = library_booklist_candidate_context(&candidates);
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("[候选100｜本地书籍 ID 100"));
    }

    #[test]
    fn broad_library_questions_fill_a_single_selected_example_with_diverse_evidence() {
        let sources = vec![
            AiReaderSource {
                book_id: "1".into(),
                book_title: "甲书".into(),
                chapter: 0,
                excerpt: "甲书写人物相思与相守。".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
            AiReaderSource {
                book_id: "2".into(),
                book_title: "乙书".into(),
                chapter: 1,
                excerpt: "乙书写夫妻在乱世中离别。".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
            AiReaderSource {
                book_id: "3".into(),
                book_title: "丙书".into(),
                chapter: 2,
                excerpt: "丙书写恋人因恩怨相爱。".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
            AiReaderSource {
                book_id: "4".into(),
                book_title: "丁书".into(),
                chapter: 3,
                excerpt: "丁书写婚姻与江湖选择。".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
        ];
        let ids = ensure_library_synthesis_source_ids(
            &sources,
            vec![1],
            "武侠小说中的情爱有什么特点",
            LibraryAnswerLength::Short,
        );
        assert_eq!(ids, vec![1, 2, 3, 4]);
        assert!(library_answer_has_sufficient_synthesis(
            "## 直接回答\n结论。[来源 1]\n\n## 关键依据\n- 《甲书》。[来源 1]\n- 《乙书》。[来源 2]\n- 《丙书》。[来源 3]\n- 《丁书》。[来源 4]\n\n## 解读\n这意味着。",
            &sources,
            LibraryAnswerLength::Short,
        ));
        assert!(!library_answer_has_sufficient_synthesis(
            "## 直接回答\n结论。[来源 1]\n\n## 关键依据\n- 《甲书》。[来源 1]\n\n## 解读\n这意味着。",
            &sources,
            LibraryAnswerLength::Short,
        ));
    }

    #[test]
    fn small_library_does_not_require_unavailable_cross_book_evidence() {
        let sources = vec![AiReaderSource {
            book_id: "1".into(),
            book_title: "甲书".into(),
            chapter: 0,
            excerpt: "甲书片段".into(),
            source_kind: "正文检索".into(),
            tags: Vec::new(),
        }];
        assert_eq!(
            ensure_library_synthesis_source_ids(
                &sources,
                vec![1],
                "武侠小说中的情爱有什么特点",
                LibraryAnswerLength::Short,
            ),
            vec![1]
        );
        assert!(library_answer_has_sufficient_synthesis(
            "简答 [来源 1]",
            &sources,
            LibraryAnswerLength::Short,
        ));
    }

    #[test]
    fn library_answer_lengths_scale_sources_and_prompt_requirements() {
        assert_eq!(LibraryAnswerLength::default(), LibraryAnswerLength::Short);
        assert_eq!(
            LibraryAnswerLength::parse("medium"),
            Some(LibraryAnswerLength::Medium)
        );
        assert_eq!(
            LibraryAnswerLength::Long.source_limit(),
            MAX_LIBRARY_DEEP_SOURCES
        );
        assert!(LibraryAnswerLength::Medium
            .prompt_specification()
            .contains("1,300"));
        assert!(LibraryAnswerLength::Long
            .prompt_specification()
            .contains("8—10"));
        let question =
            library_question_with_length("武侠小说中的情爱有什么特点", LibraryAnswerLength::Long);
        assert!(question.contains("【作答规格】"));
        assert!(question.contains("2,100"));
    }

    #[test]
    fn local_profile_parses_only_compact_category_labels() {
        let decision = parse_library_classification_decision(
            r#"```json
            {"tags":["类别: 小说", "时代：明清", "这不是分类"],"needsWebSearch":true}
            ```"#,
        )
        .unwrap();
        assert_eq!(decision.profile.tags, vec!["类别：小说", "时代：明清"]);
        assert!(decision.needs_web_search);
    }

    #[test]
    fn catalog_query_encoding_preserves_safe_bytes() {
        assert_eq!(
            percent_encode_query("三国志 A-1"),
            "%E4%B8%89%E5%9B%BD%E5%BF%97%20A-1"
        );
    }

    #[test]
    fn incomplete_profiles_are_eligible_for_reclassification() {
        let incomplete = LibraryProfile {
            tags: vec!["类别：小说".into(), "时代：明清".into()],
            web_attempted: true,
            web_enriched: false,
        };
        assert_eq!(
            profile_missing_dimensions(&incomplete),
            vec!["体裁", "篇幅", "主题", "地域", "语言", "用途"]
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
        assert!(profile_has_all_dimensions(&complete));
    }

    #[test]
    fn paused_library_classification_can_be_started_as_a_resume() {
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
    fn relevant_profile_tags_boost_the_matching_book() {
        let mut results = vec![
            sem_book("1", "一般书", &[(0, "相同片段")]),
            sem_book("2", "明清小说", &[(0, "相同片段")]),
        ];
        let profiles = HashMap::from([(
            "2".to_string(),
            vec!["时代：明清".to_string(), "类别：小说".to_string()],
        )]);
        let matched = boost_results_with_profiles(&mut results, "明清小说有什么不同", &profiles);
        assert_eq!(results[0].book_id, "2");
        assert_eq!(matched, vec!["时代：明清", "类别：小说"]);
    }

    #[test]
    fn deep_context_preserves_original_footnote_numbers() {
        let sources = vec![
            AiReaderSource {
                book_id: "1".into(),
                book_title: "甲书".into(),
                chapter: 0,
                excerpt: "甲书片段".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
            AiReaderSource {
                book_id: "2".into(),
                book_title: "乙书".into(),
                chapter: 3,
                excerpt: "乙书片段".into(),
                source_kind: "正文检索".into(),
                tags: Vec::new(),
            },
        ];
        let context = library_context_for_source_ids(&sources, &[2]);
        assert!(context.contains("[来源 2｜《乙书》｜第 4 章"));
        assert!(!context.contains("来源 1"));
    }

    #[test]
    fn deep_library_prompt_allows_labeled_interpretation_but_requires_citation_audit() {
        let prompt = system_prompt("library_question");
        assert!(prompt.contains("## 直接回答"));
        assert!(prompt.contains("## 关键依据"));
        assert!(prompt.contains("## 解读"));
        assert!(prompt.contains("700 个汉字以内"));
        assert!(prompt.contains("不得用“某人、某部作品、某来源、材料中”"));
        assert!(prompt.contains("至少三部不同作品、四条不同来源"));
        assert!(prompt.contains("一句重点。"));
        assert!(prompt.contains("不超过 18 个汉字"));
        assert!(prompt.contains("逐条核对"));
        let evidence_filter = system_prompt("library_evidence_filter");
        assert!(evidence_filter.contains("sourceIds"));
        assert!(evidence_filter.contains("至少两部不同作品"));
        assert!(system_prompt("library_single_book_question").contains("这本书具体写了什么"));
        assert!(system_prompt("library_single_book_verify").contains("终审编辑"));
        assert!(system_prompt("library_question_verify").contains("最终书库问答"));
        assert!(system_prompt("library_question_verify").contains("重点在前、论据在后"));
        assert!(system_prompt("library_compare_verify").contains("两边证据"));
    }

    #[test]
    fn library_verifier_rejects_audit_transcripts_and_requires_final_headings() {
        let audit = "那么，让我仔细核对这些事实与原文。草稿声称：来源 1：包含……";
        assert!(!is_final_library_verification(
            "library_question_verify",
            audit
        ));
        let missing_heading = "## 直接回答\n简答\n\n## 关键依据\n- 依据 [来源 1]";
        assert!(!is_final_library_verification(
            "library_question_verify",
            missing_heading
        ));
        let placeholder = "## 直接回答\n某人如何如何。\n\n## 关键依据\n- 某来源提到某部作品。 [来源 1]\n\n## 解读\n这意味着……";
        assert!(!is_final_library_verification(
            "library_question_verify",
            placeholder
        ));
        let final_answer = "## 直接回答\n简答。\n\n## 关键依据\n- 《甲书》的情节。 [来源 1]\n\n## 解读\n这意味着……";
        assert!(is_final_library_verification(
            "library_question_verify",
            final_answer
        ));
        let scope_note = "## 直接回答\n本次仅根据材料中命中的片段作答。\n\n## 关键依据\n- 《甲书》的情节。 [来源 1]\n\n## 解读\n这意味着……";
        assert!(is_final_library_verification(
            "library_question_verify",
            scope_note
        ));
    }

    #[test]
    fn comparison_reserves_a_source_for_each_selected_book() {
        let results = (1..=MAX_LIBRARY_COMPARE_BOOKS)
            .map(|id| sem_book(&id.to_string(), &format!("第{id}本"), &[(0, "证据")]))
            .collect::<Vec<_>>();
        let selected = (1..=MAX_LIBRARY_COMPARE_BOOKS)
            .rev()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        let sources =
            select_library_sources(&results, Some(&selected), true, "跨书对比", None).unwrap();
        assert_eq!(sources.len(), MAX_LIBRARY_COMPARE_BOOKS);
        assert_eq!(sources[0].book_id, "8");
        assert_eq!(sources[7].book_id, "1");
    }

    #[test]
    fn comparison_rejects_when_only_one_indexed_book_is_available() {
        let results = vec![sem_book("7", "甲书", &[(0, "甲书第一段")])];
        let selected = vec!["7".to_string(), "8".to_string()];
        let error =
            select_library_sources(&results, Some(&selected), true, "跨书对比", None).unwrap_err();
        assert!(error.contains("至少两本"));
    }

    #[test]
    fn selected_book_ids_are_unique_and_bounded() {
        assert_eq!(
            normalize_selected_book_ids(vec![" 8 ".into(), "8".into(), "7".into()], Some(2))
                .unwrap(),
            Some(vec!["8".into(), "7".into()])
        );
        assert!(normalize_selected_book_ids(vec!["not-an-id".into()], None).is_err());
        assert!(
            normalize_selected_book_ids(vec!["1".into(), "2".into(), "3".into()], Some(2))
                .unwrap_err()
                .contains("最多选择 2 本")
        );
        assert!(
            normalize_selected_book_ids((0..64).map(|id| id.to_string()).collect(), None).is_ok()
        );
    }

    #[test]
    fn explicit_question_title_can_request_a_unique_single_book() {
        assert_eq!(explicit_book_titles("《南明史》说了什么"), vec!["南明史"]);
        assert!(title_matches_explicit_question(
            "南明史（全二册）",
            "南明史"
        ));
        assert!(!title_matches_explicit_question("明史", "南明史"));
        assert!(explicit_book_titles("南明史说了什么").is_empty());
    }

    #[test]
    fn library_request_id_is_local_bounded_and_nonempty() {
        assert_eq!(library_request_id(None).unwrap(), None);
        assert_eq!(
            library_request_id(Some("library-abc_123")).unwrap(),
            Some("library-abc_123".to_string())
        );
        assert!(library_request_id(Some("")).is_err());
        assert!(library_request_id(Some("library id")).is_err());
        assert!(library_request_id(Some(&"a".repeat(97))).is_err());
    }

    #[tokio::test]
    async fn cancellation_drops_an_inflight_library_provider_future() {
        let (sender, receiver) = watch::channel(false);
        let pending = async { std::future::pending::<Result<(), String>>().await };
        let task = tokio::spawn(await_library_provider(Some(receiver), pending));
        tokio::task::yield_now().await;
        sender.send(true).expect("receiver remains active");
        assert_eq!(
            task.await.expect("task joins"),
            Err(LIBRARY_REQUEST_CANCELLED.to_string())
        );
    }
}
