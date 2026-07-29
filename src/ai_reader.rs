//! Local BYOK reading assistant. API secrets never enter the sync entity model.
use crate::{search, secret_store, window_commands::reader_window_id, AppState};
use serde::{Deserialize, Serialize};

const CONFIG_KEY: &str = "ai_reader_config_protected";
const MAX_CONTEXT_CHARS: usize = 14_000;
const MAX_CHAPTER_CHARS: usize = 4_500;
const MAX_SELECTED_TEXT_CHARS: usize = 2_400;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderSource {
    chapter: u32,
    excerpt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderAnswer {
    ok: bool,
    content: String,
    sources: Vec<AiReaderSource>,
    error: String,
}

fn trim_to_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect::<String>()
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

pub(crate) fn import_secret_config(
    db: &crate::db::AppDb,
    value: &serde_json::Value,
) -> Result<(), String> {
    let config: StoredConfig =
        serde_json::from_value(value.clone()).map_err(|e| format!("智读密钥包格式无效：{e}"))?;
    if config.api_key.trim().is_empty() {
        return Ok(());
    }
    let config = canonicalize_deepseek_config(StoredConfig {
        provider: config.provider,
        base_url: normalize_base_url(&config.base_url)?,
        model: config.model.trim().to_string(),
        api_key: config.api_key.trim().to_string(),
    });
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
            chapter: index as u32,
            excerpt: trim_to_chars(&excerpt, 180),
        });
    }
    (context, sources)
}

fn system_prompt(task: &str) -> &'static str {
    match task {
        "summary" => "你是严谨的阅读助手。只依据提供的章节内容，用中文给出精炼摘要、关键人物/概念和待思考问题；不要补充原文不存在的事实。末尾标注依据的章节号。",
        "mindmap" => "你是严谨的阅读助手。只依据提供的章节内容，输出一个合法 JSON 对象，格式固定为 {\"title\":\"主题\",\"children\":[{\"title\":\"分支\",\"children\":[]}]}; 不要使用 Markdown 代码块，不要补充原文不存在的内容。",
        _ => "你是严谨的阅读助手。只依据提供的章节内容回答中文问题；无法从内容确认时必须说“提供的内容中未找到依据”。回答末尾列出依据章节号。",
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
    );
    // 选区来自用户当前可见、已阅读的页面。它可弥补翻页模式下 800ms 的进度写盘节流，
    // 也避免模型只拿到章节开头而找不到用户刚刚划出的段落。
    let context = if selected_text.is_empty() {
        read_context
    } else {
        sources.insert(
            0,
            AiReaderSource {
                chapter: readable_end as u32,
                excerpt: trim_to_chars(&selected_text, 180),
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
    fn context_prefers_current_chapter_and_stays_bounded() {
        let chapters = vec![
            "甲".repeat(5_000),
            "乙乙乙 关键问题".to_string(),
            "丙".repeat(5_000),
        ];
        let (context, sources) = select_context(&chapters, 1, "关键问题", MAX_CONTEXT_CHARS);
        assert!(context.contains("第 2 章"));
        assert_eq!(sources[0].chapter, 1);
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS + 100);
    }
}
