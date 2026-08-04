//! Local BYOK reading assistant. API secrets never enter the sync entity model.
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
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use tauri::Manager;

const CONFIG_KEY: &str = "ai_reader_config_protected";
const MAX_CONTEXT_CHARS: usize = 14_000;
const MAX_CHAPTER_CHARS: usize = 4_500;
const MAX_SELECTED_TEXT_CHARS: usize = 2_400;
const MAX_LIBRARY_QUESTION_CHARS: usize = 2_000;
const MAX_LIBRARY_COMPARE_BOOKS: usize = 8;
const MAX_LIBRARY_QUESTION_SOURCES: usize = 20;
const MAX_LIBRARY_DEEP_SOURCES: usize = 10;
const MAX_LIBRARY_SINGLE_BOOK_SOURCES: usize = 12;
const MAX_LIBRARY_SINGLE_BOOK_STRUCTURE_SOURCES: usize = 4;
const MAX_LIBRARY_SINGLE_BOOK_CANDIDATE_HITS: usize = 36;
const MAX_LIBRARY_COMPARE_SOURCES: usize = 8;
const MAX_LIBRARY_COMPARE_SOURCES_PER_BOOK: usize = 2;
const LIBRARY_PROFILE_PREFIX: &str = "library_ai_profile:v2:";
const LIBRARY_MODEL_TAGS_ENABLED_KEY: &str = "library_ai_use_model_tags:v1";
const MAX_LIBRARY_PROFILE_TAGS: usize = 12;
const MAX_LIBRARY_PROFILE_TAG_CHARS: usize = 32;
const MAX_LIBRARY_WEB_PAGE_CHARS: usize = 2_400;
const LIBRARY_WEB_LOOKUP_EVERY_BOOKS: usize = 6;
const LIBRARY_WEB_LOOKUP_DELAY: std::time::Duration = std::time::Duration::from_millis(850);
const LIBRARY_PROFILE_DIMENSIONS: [&str; 8] = [
    "类别", "时代", "体裁", "篇幅", "主题", "地域", "语言", "用途",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredConfig {
    #[serde(default)]
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderStatus {
    pub configured: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAiReaderConfigRequest {
    #[serde(default)]
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
}

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderSource {
    /// Local library id, used by the UI to open the cited chapter. It is not a
    /// cross-device sync identifier and is never uploaded by this command.
    book_id: String,
    book_title: String,
    chapter: u32,
    excerpt: String,
    /// Describes how the local excerpt was selected, for example a directory
    /// entry, a chapter opening, or a semantic body passage.
    #[serde(default)]
    source_kind: String,
    /// Local AI classification labels are retrieval hints, never source text.
    #[serde(default)]
    tags: Vec<String>,
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
    error: String,
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
    let db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db.as_ref().ok_or("SQLite 数据库不可用")?;
    let entries = db.metadata_with_prefix(LIBRARY_PROFILE_PREFIX)?;
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
    let db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(db.metadata(LIBRARY_MODEL_TAGS_ENABLED_KEY).as_deref() != Some("false"))
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

fn normalize_base_url(value: &str) -> Result<String, String> {
    // OpenAI compatible providers normally ask for a base URL ending in `/v1`,
    // but it is natural for users to paste the full chat-completions URL from
    // their provider's documentation. Store one canonical base either way so
    // we never emit `.../chat/completions/chat/completions`.
    let value = value.trim().trim_end_matches('/');
    let value = value
        .strip_suffix("/chat/completions")
        .or_else(|| value.strip_suffix("/v1/messages"))
        .unwrap_or(value)
        .trim_end_matches('/');
    const LOCAL_HTTP_PREFIX: &str = concat!("http", "://");
    let local_http = if let Some(local_value) = value.strip_prefix(LOCAL_HTTP_PREFIX) {
        let authority = local_value.split('/').next().unwrap_or_default();
        let host = if authority.starts_with('[') {
            authority
                .split_once(']')
                .map(|(host, _)| host.trim_start_matches('['))
                .unwrap_or_default()
        } else {
            authority.split(':').next().unwrap_or_default()
        };
        !authority.contains('@') && matches!(host, "localhost" | "127.0.0.1" | "::1")
    } else {
        false
    };
    if !(value.starts_with("https://") || local_http) {
        return Err("接口地址必须使用 HTTPS；仅本机服务可使用 HTTP".into());
    }
    if value.len() > 500 {
        return Err("接口地址过长".into());
    }
    Ok(value.to_string())
}

fn known_provider(value: &str) -> &'static str {
    match value.trim() {
        "deepseek" => "deepseek",
        "openai" => "openai",
        "anthropic" => "anthropic",
        _ => "compatible",
    }
}

fn infer_provider(base_url: &str) -> &'static str {
    let base_url = base_url.trim().to_ascii_lowercase();
    if base_url.starts_with("https://api.deepseek.com") {
        "deepseek"
    } else if base_url.starts_with("https://api.openai.com") {
        "openai"
    } else if base_url.starts_with("https://api.anthropic.com") {
        "anthropic"
    } else {
        "compatible"
    }
}

fn canonicalize_deepseek_config(mut config: StoredConfig) -> StoredConfig {
    // DeepSeek retired the old `deepseek-chat` / `deepseek-reasoner` names on
    // 2026-07-24. Keep compatibility only for the official endpoint; third
    // party OpenAI-compatible servers may intentionally still expose them.
    let provider = if config.provider.trim().is_empty() {
        infer_provider(&config.base_url)
    } else {
        known_provider(&config.provider)
    };
    config.provider = provider.to_string();
    let official_base = provider == "deepseek";
    if official_base && matches!(config.model.trim(), "deepseek-chat" | "deepseek-reasoner") {
        config.model = "deepseek-v4-flash".to_string();
    }
    config
}

fn endpoint_for(base_url: &str, suffix: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with(suffix) {
        return base_url.to_string();
    }
    if suffix == "/v1/messages" && base_url.ends_with("/v1") {
        return format!("{base_url}/messages");
    }
    format!("{base_url}{suffix}")
}

fn provider_error_summary(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            let message = value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)?;
            Some(message.to_string())
        })
        .unwrap_or_else(|| body.to_string())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let message = trim_to_chars(&message, 600);
    let hint = match status {
        400 => "请检查接口地址、模型名和请求参数；若服务端列出了可用模型，请直接使用其中之一。",
        401 | 403 => "请检查 API Key 是否有效、是否属于这个接口账户。",
        404 => "请检查接口地址；地址应填到 /v1，不必填写 /chat/completions。",
        429 => "接口当前限流或余额不足，请稍后重试并检查账户额度。",
        _ => "请稍后重试；若持续出现，请保留本提示中的服务端说明。",
    };
    if message.is_empty() {
        format!("HTTP {status}。{hint}")
    } else {
        format!("HTTP {status}：{message}。{hint}")
    }
}

fn load_config(db: &crate::db::AppDb) -> Result<StoredConfig, String> {
    let protected = db.metadata(CONFIG_KEY).unwrap_or_default();
    if protected.is_empty() {
        return Ok(StoredConfig::default());
    }
    let json = secret_store::unprotect_secret(&protected)?;
    serde_json::from_str(&json).map_err(|error| format!("阅读助手配置损坏：{error}"))
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
    let mut current = load_config(db)?;
    current.provider = known_provider(provider).to_string();
    current.base_url = normalize_base_url(base_url)?;
    current.model = model.trim().to_string();
    let current = canonicalize_deepseek_config(current);
    let json = serde_json::to_string(&current).map_err(|e| e.to_string())?;
    db.set_metadata(CONFIG_KEY, &secret_store::protect_secret(&json)?)
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
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    db.set_metadata(CONFIG_KEY, &secret_store::protect_secret(&json)?)
}

fn status(config: &StoredConfig) -> AiReaderStatus {
    AiReaderStatus {
        configured: !config.base_url.is_empty()
            && !config.model.is_empty()
            && !config.api_key.is_empty(),
        provider: config.provider.clone(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
    }
}

#[tauri::command]
pub(crate) fn ai_reader_status(
    state: tauri::State<'_, AppState>,
) -> Result<AiReaderStatus, String> {
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(status(&canonicalize_deepseek_config(load_config(db)?)))
}

#[tauri::command]
pub(crate) fn save_ai_reader_config(
    state: tauri::State<'_, AppState>,
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
    let json = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    let protected = secret_store::protect_secret(&json)?;
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    db.set_metadata(CONFIG_KEY, &protected)?;
    Ok(status(&config))
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
            excerpt: trim_to_chars(&excerpt, 180),
            source_kind: "当前章节".into(),
            tags: Vec::new(),
        });
    }
    (context, sources)
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

/// A library question reports the top twenty ranked books, one excerpt each.
/// A comparison instead reserves one excerpt for every selected book, so a
/// high-scoring volume cannot crowd the other side out of the model context.
fn select_library_sources(
    results: &[semantic::SemBookHits],
    selected_ids: Option<&[String]>,
    compare: bool,
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
                push_library_source(
                    &mut sources,
                    &mut seen,
                    book,
                    hit,
                    MAX_LIBRARY_QUESTION_SOURCES,
                );
            }
        }
    }
    if sources.is_empty() {
        return Err("没有找到可用的本地语义索引内容；请先为图书建立语义索引".into());
    }
    Ok(sources)
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

fn single_book_retrieval_queries(question: &str, title: &str) -> Vec<String> {
    let title = title.trim();
    let candidates = [
        question.trim().to_string(),
        format!("《{title}》的全书主要内容、叙述范围与核心主题"),
        format!("《{title}》的重要人物、事件、论点与结论"),
        format!("《{title}》的目录、章节结构、各章主题与全书结论"),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|query| !query.trim().is_empty())
        .filter(|query| seen.insert(query.trim().to_lowercase()))
        .collect()
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

fn library_context_entries<'a>(
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
        if header_chars >= remaining {
            break;
        }
        let excerpt = trim_to_chars(&source.excerpt, remaining - header_chars);
        if excerpt.trim().is_empty() {
            continue;
        }
        context.push_str(&header);
        context.push_str(&excerpt);
        context.push_str("\n\n");
        remaining = remaining.saturating_sub(header_chars + excerpt.chars().count() + 2);
    }
    context
}

fn library_context(sources: &[AiReaderSource]) -> String {
    library_context_entries(
        sources
            .iter()
            .enumerate()
            .map(|(index, source)| (index + 1, source)),
    )
}

fn library_context_for_source_ids(sources: &[AiReaderSource], source_ids: &[usize]) -> String {
    library_context_entries(source_ids.iter().filter_map(|source_id| {
        sources
            .get(source_id.saturating_sub(1))
            .map(|source| (*source_id, source))
    }))
}

fn parse_deep_source_ids(response: &str, source_count: usize) -> Vec<usize> {
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

fn fallback_deep_source_ids(source_count: usize) -> Vec<usize> {
    (1..=source_count.min(MAX_LIBRARY_DEEP_SOURCES)).collect()
}

fn system_prompt(task: &str) -> &'static str {
    match task {
        "summary" => {
            "你是严谨的阅读助手。只依据提供的章节内容，用中文给出精炼摘要、关键人物/概念和待思考问题；不要补充原文不存在的事实。末尾标注依据的章节号。"
        }
        "mindmap" => {
            "你是严谨的阅读助手。只依据提供的章节内容，输出一个合法 JSON 对象，格式固定为 {\"title\":\"主题\",\"children\":[{\"title\":\"分支\",\"children\":[]}]}; 不要使用 Markdown 代码块，不要补充原文不存在的内容。"
        }
        "library_evidence_filter" => {
            "你是本地书库的证据审稿器。候选段落会编号为来源 N，并标注其材料类型。只选择能直接支撑用户问题的段落，优先正文、具体人物关系、情节、观点或可靠评论；剔除只因词语相近而命中的序言、泛泛创作谈、无关文体或题材材料。对于“X 说了什么”“X 有什么特点”这类宽问题，优先选同时覆盖核心对象、关键论点和不同材料类型的段落，避免只挑同一段话的重复表述。不要回答问题，不要解释。只输出 JSON 对象，格式严格为 {\"sourceIds\":[1,4,7]}；最多 10 个，按证据强度排序。"
        }
        "library_single_book_evidence_filter" => {
            "你是单本书深度解读的证据审稿器。候选段落全部来自同一本书，来源 N 标有“目录、正文开篇、正文检索”等材料类型。用户问“这本书写了什么”或任何单书问题时，先用目录或章节开篇确定全书范围，再优先选择能说明核心人物/事件/论点、结构或结论的正文检索片段；目录不能单独替代正文证据，前言、后记、作者闲谈只有用户明确询问时才选。选择 4—10 条彼此覆盖不同章节的证据；若材料确实没有全书概述，选择最能拼出主题和重点的正文。不要回答问题，不要解释。只输出 JSON 对象，格式严格为 {\"sourceIds\":[1,4,7]}，按覆盖全书的重要性排序。"
        }
        "library_question" => {
            "你是兼顾证据与洞见的本地书库深度解读助手。必须使用以下 Markdown 结构，不能添加开场套话或重复同一结论：\n\n## 直接回答\n先用 2—3 句正面回答问题，给出清晰主张；如果问题宽泛，先说明本次材料实际覆盖的对象与范围。\n\n## 关键依据\n列出 2—4 条彼此不同、能推进回答的论点。每条先写短小的论点，再说明材料事实，并在句末标注 [来源 N]。不要逐条复述检索片段；同一来源只在确有新证据时重复使用。\n\n## 解读\n只写一段，把前述证据连接成有解释力的理解；可以结合常识和文学/历史分析，但必须用“这意味着”“可以理解为”等措辞明确它是分析，不能伪装成书库原文事实。\n\n仅当证据确实不足时，附加 `## 保留意见`，具体说明缺少什么材料；不得以“未找到专门论述”代替回答。每个来源标题可能带有“标签”：它是目录信号，可用于组织时代、类别、体裁和篇幅的比较框架，却绝不能当作正文引文或具体情节证据。不得杜撰未提供的具体情节、人物、引文或书中观点。输出前逐条核对：每个 [来源 N] 必须真实支撑其所在结论；证据不足就删掉引用。"
        }
        "library_single_book_question" => {
            "你是单本书深度解读助手。用户明确只问一本书，首要任务是回答这本书实际写了什么，不能围绕边缘材料兜圈子。必须使用以下 Markdown 结构：\n\n## 直接回答\n开头先用 2—4 句说明全书对象、范围、主线和最重要的内容；不要先讲检索限制或材料过程。\n\n## 这本书具体写了什么\n列出 3—5 点，尽量覆盖不同章节中的人物、事件、论证、叙述阶段或结论；每点必须带 [来源 N]。\n\n## 解读\n用一段解释这些内容如何共同构成这本书的重点；分析必须和“书写了什么”相连，不能用无关背景代替内容。\n\n仅当现有段落确实无法确定某项时才写 `## 保留意见`。不得杜撰书外知识、具体情节或章节；来源标题中的标签只能辅助组织，不能当正文证据。输出前逐条检查：删掉不直接说明本书内容的材料和无证据结论。"
        }
        "library_single_book_verify" => {
            "你是单本书问答的终审编辑。给出的上下文全部来自同一本书，用户问题和一份回答草稿会一起提供。请直接输出修订后的完整 Markdown 回答，不要写审核过程。第一段必须正面说明这本书写了什么；删除围绕边缘材料、检索过程或泛泛背景的内容。每个事实性要点必须由 [来源 N] 支撑，且不得引入上下文外事实。保留结构 `## 直接回答`、`## 这本书具体写了什么`、`## 解读`；只有确有必要才保留 `## 保留意见`。"
        }
        "library_question_verify" => {
            "你是本地书库问答的终审编辑。给出的上下文与回答草稿会一起提供。请直接输出修订后的完整 Markdown 回答，不要写审核过程。逐条核对所有事实性结论：每一项都必须由同编号 [来源 N] 的原文直接支撑；不能支撑就删除、改成明确的分析性表述，或写入 `## 保留意见`。不得引用不存在的来源，不得把目录标签当正文事实。保留 `## 直接回答`、`## 关键依据`、`## 解读` 的结构。"
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

fn call_openai_compatible(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
) -> Result<String, String> {
    let endpoint = endpoint_for(&config.base_url, "/chat/completions");
    let payload = serde_json::json!({
        "model": config.model,
        "stream": false,
        "messages": [
            {"role":"system", "content": system_prompt(&task)},
            {"role":"user", "content": format!("阅读内容：{}\n\n任务：{}\n问题：{}", context, task, question)}
        ]
    });
    let agent: ureq::Agent = ureq::Agent::config_builder()
        // We must keep the response body for 4xx/5xx. Providers such as
        // DeepSeek return the actionable reason there (invalid model, quota,
        // malformed request, etc.); the default ureq behavior loses it.
        .http_status_as_error(false)
        .timeout_connect(Some(std::time::Duration::from_secs(8)))
        .timeout_recv_response(Some(std::time::Duration::from_secs(45)))
        .timeout_recv_body(Some(std::time::Duration::from_secs(45)))
        .build()
        .into();
    let response = agent
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|error| format!("阅读助手请求失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .read_to_string()
        .map_err(|error| format!("阅读助手响应读取失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "阅读助手请求失败：{}",
            provider_error_summary(status, &body)
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("阅读助手响应解析失败：{error}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "接口没有返回可用回答".to_string())
}

fn call_anthropic_messages(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
) -> Result<String, String> {
    let endpoint = endpoint_for(&config.base_url, "/v1/messages");
    let payload = serde_json::json!({
        "model": config.model,
        "max_tokens": 2400,
        "temperature": 0.2,
        "system": system_prompt(&task),
        "messages": [{
            "role": "user",
            "content": format!("阅读内容：{}\n\n任务：{}\n问题：{}", context, task, question)
        }]
    });
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(std::time::Duration::from_secs(8)))
        .timeout_recv_response(Some(std::time::Duration::from_secs(45)))
        .timeout_recv_body(Some(std::time::Duration::from_secs(45)))
        .build()
        .into();
    let response = agent
        .post(&endpoint)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|error| format!("阅读助手请求失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .read_to_string()
        .map_err(|error| format!("阅读助手响应读取失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "阅读助手请求失败：{}",
            provider_error_summary(status, &body)
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("阅读助手响应解析失败：{error}"))?;
    value
        .get("content")
        .and_then(serde_json::Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                (block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(serde_json::Value::as_str))
                    .flatten()
            })
        })
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Claude 接口没有返回可用回答".to_string())
}

fn call_reading_provider(
    config: StoredConfig,
    task: String,
    question: String,
    context: String,
) -> Result<String, String> {
    if config.provider == "anthropic" {
        call_anthropic_messages(config, task, question, context)
    } else {
        call_openai_compatible(config, task, question, context)
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
    let db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    db.as_ref()
        .ok_or("SQLite 数据库不可用")?
        .set_metadata(&library_profile_key(book_id), &encoded)?;
    drop(db);
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

#[tauri::command]
pub(crate) fn set_library_model_tags_enabled(
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<LibraryModelTagsSettings, String> {
    let mut db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    db.as_mut().ok_or("SQLite 数据库不可用")?.set_metadata(
        LIBRARY_MODEL_TAGS_ENABLED_KEY,
        if enabled { "true" } else { "false" },
    )?;
    Ok(LibraryModelTagsSettings { enabled })
}

#[tauri::command]
pub(crate) fn start_library_auto_classification(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<BackgroundTaskSnapshot, String> {
    let config = {
        let db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        canonicalize_deepseek_config(load_config(db.as_ref().ok_or("SQLite 数据库不可用")?)?)
    };
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

/// Re-read a completed answer against exactly the cited local context. A
/// provider failure must not discard an otherwise usable answer, so callers
/// receive the draft as a safe fallback.
async fn verify_library_answer(
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

/// Answer a question from the locally indexed library (one selected book, the
/// whole library, or a selected cross-book comparison). The retrieval phase
/// only reads existing local vector/index files; it does not build an index,
/// open raw book files, or synchronize any RAG data.
#[tauri::command]
pub(crate) async fn ask_library_assistant(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: LibraryAiReaderAskRequest,
) -> Result<AiReaderAnswer, String> {
    let task = request.task.trim().to_ascii_lowercase();
    if !matches!(task.as_str(), "question" | "compare") {
        return Err("书库问答只支持 question 或 compare 任务".into());
    }
    let question = request.question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题".into());
    }
    if question.chars().count() > MAX_LIBRARY_QUESTION_CHARS {
        return Err(format!("问题不能超过 {MAX_LIBRARY_QUESTION_CHARS} 个字符"));
    }
    let compare = task == "compare";
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
    if !compare && selected_ids.is_none() {
        if let Some(book_id) = implicit_single_book_id(state.inner(), &question)? {
            selected_ids = Some(vec![book_id]);
        }
    }
    let single_book = !compare && selected_ids.as_ref().is_some_and(|ids| ids.len() == 1);
    let search_scope = if compare || selected_ids.is_some() {
        selected_ids.clone()
    } else {
        Some(full_library_semantic_scope(state.inner())?)
    };
    let config = {
        let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        canonicalize_deepseek_config(load_config(guard.as_ref().ok_or("SQLite 数据库不可用")?)?)
    };
    if !status(&config).configured {
        return Err("请先在阅读助手中配置接口、模型和 API Key".into());
    }

    let (mut results, structure_sources) = if single_book {
        let depth = single_book_depth_search(
            app.clone(),
            &question,
            selected_ids
                .as_ref()
                .and_then(|ids| ids.first())
                .ok_or("单书深度检索缺少图书 ID")?,
        )
        .await?;
        (depth.semantic_results, depth.structure_sources)
    } else {
        (
            semantic::semantic_search(app, question.clone(), search_scope).await?,
            Vec::new(),
        )
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
        select_library_sources(&results, selected_ids.as_deref(), compare)?
    };
    for source in &mut sources {
        source.tags = model_tags.get(&source.book_id).cloned().unwrap_or_default();
    }
    let content = if compare {
        let context = library_context(&sources);
        if context.is_empty() {
            return Err("没有可发送的检索片段".into());
        }
        let answer_config = config.clone();
        let answer_question = question.clone();
        let answer_context = context.clone();
        let draft = tokio::task::spawn_blocking(move || {
            call_reading_provider(
                answer_config,
                "library_compare".to_string(),
                answer_question,
                answer_context,
            )
        })
        .await
        .map_err(|error| format!("书库问答任务失败：{error}"))??;
        verify_library_answer(config, "library_compare_verify", &question, draft, context).await
    } else {
        let candidate_context = library_context(&sources);
        if candidate_context.is_empty() {
            return Err("没有可发送的检索片段".into());
        }
        let selection_question = question.clone();
        let filter_config = config.clone();
        let filter_task = if single_book {
            "library_single_book_evidence_filter"
        } else {
            "library_evidence_filter"
        };
        let filtered = tokio::task::spawn_blocking(move || {
            call_reading_provider(
                filter_config,
                filter_task.to_string(),
                selection_question,
                candidate_context,
            )
        })
        .await
        .map_err(|error| format!("书库证据筛选任务失败：{error}"))?;
        let source_ids = filtered
            .ok()
            .map(|response| parse_deep_source_ids(&response, sources.len()))
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| fallback_deep_source_ids(sources.len()));
        let context = library_context_for_source_ids(&sources, &source_ids);
        if context.is_empty() {
            return Err("没有可发送的深度解读证据".into());
        }
        let answer_task = if single_book {
            "library_single_book_question"
        } else {
            "library_question"
        };
        let answer_config = config.clone();
        let answer_question = question.clone();
        let answer_context = context.clone();
        let draft = tokio::task::spawn_blocking(move || {
            call_reading_provider(
                answer_config,
                answer_task.to_string(),
                answer_question,
                answer_context,
            )
        })
        .await
        .map_err(|error| format!("书库深度解读任务失败：{error}"))??;
        let verify_task = if single_book {
            "library_single_book_verify"
        } else {
            "library_question_verify"
        };
        verify_library_answer(config, verify_task, &question, draft, context).await
    };
    Ok(AiReaderAnswer {
        ok: true,
        content,
        sources,
        single_book,
        error: String::new(),
    })
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
    let selected_len = selected_text.chars().count();
    let (read_context, mut sources) = select_context(
        &readable,
        readable_end.min(readable.len().saturating_sub(1)),
        &request.question,
        MAX_CONTEXT_CHARS.saturating_sub(selected_len),
        &book.id.to_string(),
        &book.title,
    );
    // 选区来自用户当前可见、已阅读的页面。它可弥补翻页模式下 800ms 的进度写盘节流，
    // 也避免模型只拿到章节开头而找不到用户刚刚划出的段落。
    let context = if selected_text.is_empty() {
        read_context
    } else {
        sources.insert(
            0,
            AiReaderSource {
                book_id: book.id.to_string(),
                book_title: book.title.clone(),
                chapter: readable_end as u32,
                excerpt: trim_to_chars(&selected_text, 180),
                source_kind: "当前已选文字".into(),
                tags: Vec::new(),
            },
        );
        format!("[当前已选文字]\n{selected_text}\n\n{read_context}")
    };
    if context.is_empty() {
        return Err("当前图书没有可发送的正文内容".into());
    }
    let config = {
        let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        canonicalize_deepseek_config(load_config(guard.as_ref().ok_or("SQLite 数据库不可用")?)?)
    };
    if !status(&config).configured {
        return Err("请先在阅读助手中配置接口、模型和 API Key".into());
    }
    let title = book.title;
    let question = request.question.trim().to_string();
    let content = tokio::task::spawn_blocking(move || {
        call_reading_provider(config, task, format!("《{title}》：{question}"), context)
    })
    .await
    .map_err(|error| format!("阅读助手任务失败：{error}"))??;
    Ok(AiReaderAnswer {
        ok: true,
        content,
        sources,
        single_book: false,
        error: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_full_chat_completions_url_to_a_base_url() {
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/chat/completions/").unwrap(),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn provider_error_keeps_actionable_message_without_a_secret() {
        let error = provider_error_summary(400, r#"{\"error\":{\"message\":\"Model Not Exist\"}}"#);
        assert!(error.contains("Model Not Exist"));
        assert!(error.contains("模型名"));
        assert!(!error.contains("Bearer"));
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
        assert_eq!(infer_provider("https://api.openai.com/v1"), "openai");
        assert_eq!(infer_provider("https://api.anthropic.com"), "anthropic");
        assert_eq!(
            endpoint_for("https://api.anthropic.com", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            endpoint_for("https://api.anthropic.com/v1", "/v1/messages"),
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
        let sources = select_library_sources(&results, None, false).unwrap();
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
        let sources = select_library_sources(&results, None, false).unwrap();
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
    fn library_question_never_repeats_a_book_when_results_are_duplicated() {
        let results = vec![
            sem_book("7", "甲书", &[(0, "甲书的第一段")]),
            sem_book("7", "甲书", &[(1, "甲书的重复候选")]),
            sem_book("8", "乙书", &[(0, "乙书的第一段")]),
        ];
        let sources = select_library_sources(&results, None, false).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].book_id, "7");
        assert_eq!(sources[1].book_id, "8");
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
        assert!(prompt.contains("逐条核对"));
        let evidence_filter = system_prompt("library_evidence_filter");
        assert!(evidence_filter.contains("sourceIds"));
        assert!(evidence_filter.contains("重复表述"));
        assert!(system_prompt("library_single_book_question").contains("这本书具体写了什么"));
        assert!(system_prompt("library_single_book_verify").contains("终审编辑"));
        assert!(system_prompt("library_question_verify").contains("逐条核对"));
        assert!(system_prompt("library_compare_verify").contains("两边证据"));
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
        let sources = select_library_sources(&results, Some(&selected), true).unwrap();
        assert_eq!(sources.len(), MAX_LIBRARY_COMPARE_BOOKS);
        assert_eq!(sources[0].book_id, "8");
        assert_eq!(sources[7].book_id, "1");
    }

    #[test]
    fn comparison_rejects_when_only_one_indexed_book_is_available() {
        let results = vec![sem_book("7", "甲书", &[(0, "甲书第一段")])];
        let selected = vec!["7".to_string(), "8".to_string()];
        let error = select_library_sources(&results, Some(&selected), true).unwrap_err();
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
}
