//! HTTP transport and response parsing for BYOK reading providers.
//!
//! This module deliberately knows nothing about Tauri commands, persisted
//! profiles, retrieval, or answer policy. The parent passes an already
//! selected request and remains responsible for cancellation/retry policy.

use std::time::Duration;

type ProviderResult<T> = Result<T, ProviderError>;

/// Provider-internal failures.  The parent deliberately consumes only the
/// rendered Chinese message, so transport implementation details never leak
/// into Tauri commands or their public return types.
#[derive(Debug)]
enum ProviderError {
    ClientBuild(reqwest::Error),
    AsyncRequest(reqwest::Error),
    SyncRequest(ureq::Error),
    AsyncResponseRead(reqwest::Error),
    SyncResponseRead(ureq::Error),
    Rejected { status: u16, body: String },
    ResponseParse(serde_json::Error),
    EmptyAnswer { anthropic: bool },
}

impl ProviderError {
    fn user_message(self) -> String {
        match self {
            Self::ClientBuild(error) => format!("阅读助手客户端不可用：{error}"),
            Self::AsyncRequest(error) => format!("阅读助手请求失败：{error}"),
            Self::SyncRequest(error) => format!("阅读助手请求失败：{error}"),
            Self::AsyncResponseRead(error) => format!("阅读助手响应读取失败：{error}"),
            Self::SyncResponseRead(error) => format!("阅读助手响应读取失败：{error}"),
            Self::Rejected { status, body } => {
                format!("阅读助手请求失败：{}", error_summary(status, &body))
            }
            Self::ResponseParse(error) => format!("阅读助手响应解析失败：{error}"),
            Self::EmptyAnswer { anthropic: true } => "Claude 接口没有返回可用回答".to_string(),
            Self::EmptyAnswer { anthropic: false } => "接口没有返回可用回答".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Request<'a> {
    pub(super) provider: &'a str,
    pub(super) base_url: &'a str,
    pub(super) model: &'a str,
    pub(super) api_key: &'a str,
    pub(super) task: &'a str,
    pub(super) prompt: &'a str,
    pub(super) question: &'a str,
    pub(super) context: &'a str,
    pub(super) max_tokens: u16,
    pub(super) response_timeout: Duration,
}

pub(super) async fn call_async(request: Request<'_>) -> Result<String, String> {
    call_async_inner(request)
        .await
        .map_err(ProviderError::user_message)
}

/// Verify that an OpenAI-compatible loopback server is alive *and* advertises
/// the model selected for a deep local task.  This deliberately sends no
/// reader text and does not start a completion: it is safe to use when
/// choosing between the normal 8B profile and the optional 27B runtime.
pub(super) async fn local_model_health_check(
    base_url: &str,
    api_key: &str,
    expected_model: &str,
) -> Result<(), String> {
    let endpoint = endpoint_for(base_url, "/models");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| "本机模型健康检查无法创建连接".to_string())?;
    let mut call = client.get(endpoint);
    if has_api_key(api_key) {
        call = call.bearer_auth(api_key);
    }
    let response = call
        .send()
        .await
        .map_err(|_| "本机模型服务未响应".to_string())?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| "本机模型健康检查未能读取响应".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "本机模型健康检查失败：{}",
            error_summary(status, &body)
        ));
    }
    let models = model_ids_from_response(&body)
        .ok_or_else(|| "本机模型服务未返回 OpenAI 兼容的模型列表".to_string())?;
    if models.is_empty() {
        return Err("本机模型服务未返回已加载模型".to_string());
    }
    if !models
        .iter()
        .any(|model| compatible_model_id(model, expected_model))
    {
        return Err("本机模型服务已响应，但未加载所选的深度理解模型".to_string());
    }
    Ok(())
}

async fn call_async_inner(request: Request<'_>) -> ProviderResult<String> {
    let endpoint = endpoint_for(
        request.base_url,
        if request.provider == "anthropic" {
            "/v1/messages"
        } else {
            "/chat/completions"
        },
    );
    let payload = payload(request);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(request.response_timeout)
        .build()
        .map_err(ProviderError::ClientBuild)?;
    let mut call = client.post(endpoint).json(&payload);
    if request.provider == "anthropic" {
        call = call
            .header("x-api-key", request.api_key)
            .header("anthropic-version", "2023-06-01");
    } else if has_api_key(request.api_key) {
        call = call.bearer_auth(request.api_key);
    }
    let response = call.send().await.map_err(ProviderError::AsyncRequest)?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(ProviderError::AsyncResponseRead)?;
    parse_response(request.provider, status, &body)
}

pub(super) fn call(request: Request<'_>) -> Result<String, String> {
    call_inner(request).map_err(ProviderError::user_message)
}

fn call_inner(request: Request<'_>) -> ProviderResult<String> {
    let endpoint = endpoint_for(
        request.base_url,
        if request.provider == "anthropic" {
            "/v1/messages"
        } else {
            "/chat/completions"
        },
    );
    let payload = payload(request);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        // Keep the 4xx/5xx body: compatible providers put useful diagnostics
        // there (invalid model, quota, malformed request).
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_recv_response(Some(request.response_timeout))
        .timeout_recv_body(Some(request.response_timeout))
        .build()
        .into();
    let mut call = agent
        .post(&endpoint)
        .header("Content-Type", "application/json");
    if request.provider == "anthropic" {
        call = call
            .header("x-api-key", request.api_key)
            .header("anthropic-version", "2023-06-01");
    } else if has_api_key(request.api_key) {
        call = call.header("Authorization", &format!("Bearer {}", request.api_key));
    }
    let response = call
        .send_json(payload)
        .map_err(ProviderError::SyncRequest)?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .read_to_string()
        .map_err(ProviderError::SyncResponseRead)?;
    parse_response(request.provider, status, &body)
}

fn payload(request: Request<'_>) -> serde_json::Value {
    let user_content = format!(
        "阅读内容：{}\n\n任务：{}\n问题：{}",
        request.context, request.task, request.question
    );
    if request.provider == "anthropic" {
        serde_json::json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "temperature": 0.2,
            "system": request.prompt,
            "messages": [{"role": "user", "content": user_content}]
        })
    } else {
        let mut payload = serde_json::json!({
            "model": request.model,
            "stream": false,
            "max_tokens": request.max_tokens,
            "messages": [
                {"role": "system", "content": request.prompt},
                {"role": "user", "content": user_content}
            ]
        });
        // llama-server implements the OpenAI JSON-object constraint.  Use it
        // only for the local intelligence editorial pass, where a malformed
        // response must never be rendered as a completed news article.
        if matches!(
            request.task,
            "intelligence_generate_brief"
                | "intelligence_judge_event_pairs"
                | "intelligence_triage_articles"
        ) {
            payload["temperature"] = serde_json::json!(0.1);
            payload["response_format"] = serde_json::json!({"type": "json_object"});
        }
        payload
    }
}

fn has_api_key(value: &str) -> bool {
    !value.trim().is_empty()
}

fn model_ids_from_response(body: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let values = value.get("data")?.as_array()?;
    Some(
        values
            .iter()
            .filter_map(|item| item.get("id").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    )
}

fn compatible_model_id(advertised: &str, expected: &str) -> bool {
    let normalize = |value: &str| {
        value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let advertised = normalize(advertised);
    let expected = normalize(expected);
    !advertised.is_empty()
        && !expected.is_empty()
        && (advertised == expected
            || advertised.contains(&expected)
            || expected.contains(&advertised))
}

fn parse_response(provider: &str, status: u16, body: &str) -> ProviderResult<String> {
    if !(200..300).contains(&status) {
        return Err(ProviderError::Rejected {
            status,
            body: body.to_string(),
        });
    }
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(ProviderError::ResponseParse)?;
    if provider == "anthropic" {
        anthropic_content(&value).ok_or(ProviderError::EmptyAnswer { anthropic: true })
    } else {
        openai_compatible_content(&value).ok_or(ProviderError::EmptyAnswer { anthropic: false })
    }
}

pub(super) fn endpoint_for(base_url: &str, suffix: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with(suffix) {
        return base_url.to_string();
    }
    if suffix == "/v1/messages" && base_url.ends_with("/v1") {
        return format!("{base_url}/messages");
    }
    format!("{base_url}{suffix}")
}

pub(super) fn error_summary(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
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

fn anthropic_content(value: &serde_json::Value) -> Option<String> {
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
}

pub(super) fn openai_compatible_content(value: &serde_json::Value) -> Option<String> {
    // Reasoning fields are internal traces, never reader-facing answers.
    let first_choice = value
        .pointer("/choices/0/message/content")
        .and_then(json_text_content)
        .or_else(|| value.pointer("/choices/0/text").and_then(json_text_content))
        .or_else(|| {
            value
                .pointer("/choices/0/delta/content")
                .and_then(json_text_content)
        })
        .or_else(|| {
            value
                .pointer("/choices/0/content")
                .and_then(json_text_content)
        });
    first_choice
        .or_else(|| {
            value
                .pointer("/data/choices/0/message/content")
                .and_then(json_text_content)
        })
        .or_else(|| {
            value
                .pointer("/response/choices/0/message/content")
                .and_then(json_text_content)
        })
        .or_else(|| {
            value
                .pointer("/Response/Choices/0/Message/Content")
                .and_then(json_text_content)
        })
        .or_else(|| value.get("output_text").and_then(json_text_content))
        .or_else(|| value.get("output").and_then(json_text_content))
}

fn json_text_content(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        serde_json::Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(json_text_content)
                .collect::<Vec<_>>()
                .join("\n");
            let joined = joined.trim();
            (!joined.is_empty()).then(|| joined.to_string())
        }
        serde_json::Value::Object(_) => value
            .get("text")
            .or_else(|| value.get("value"))
            .or_else(|| value.get("content"))
            .and_then(json_text_content),
        _ => None,
    }
}

fn trim_to_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_anthropic_v1_endpoint() {
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
    fn empty_local_key_does_not_request_bearer_authentication() {
        assert!(!has_api_key(" \t "));
        assert!(has_api_key("local-token"));
    }

    #[test]
    fn provider_error_keeps_actionable_message_without_a_secret() {
        let error = error_summary(400, r#"{"error":{"message":"Model Not Exist"}}"#);
        assert!(error.contains("Model Not Exist"));
        assert!(error.contains("模型名"));
        assert!(!error.contains("Bearer"));
    }

    #[test]
    fn structured_rejection_keeps_existing_chinese_boundary_message() {
        let error = parse_response("compatible", 401, r#"{"error":{"message":"invalid key"}}"#)
            .unwrap_err()
            .user_message();
        assert!(error.starts_with("阅读助手请求失败：HTTP 401：invalid key"));
        assert!(error.contains("API Key 是否有效"));
    }

    #[test]
    fn structured_empty_answer_preserves_provider_specific_guidance() {
        let anthropic = parse_response("anthropic", 200, r#"{"content":[]}"#)
            .unwrap_err()
            .user_message();
        let compatible = parse_response("compatible", 200, r#"{"choices":[]}"#)
            .unwrap_err()
            .user_message();
        assert_eq!(anthropic, "Claude 接口没有返回可用回答");
        assert_eq!(compatible, "接口没有返回可用回答");
    }

    #[test]
    fn structured_parse_error_keeps_existing_chinese_boundary_message() {
        let error = parse_response("compatible", 200, "not json")
            .unwrap_err()
            .user_message();
        assert!(error.starts_with("阅读助手响应解析失败："));
    }

    #[test]
    fn response_parser_ignores_reasoning_only_content() {
        let value = serde_json::json!({
            "choices": [{"message": {"reasoning_content": "private trace"}}]
        });
        assert!(openai_compatible_content(&value).is_none());
    }

    #[test]
    fn response_parser_accepts_compatible_text_envelopes() {
        let value = serde_json::json!({"output": [{"content": [{"text": " answer "}]}]});
        assert_eq!(openai_compatible_content(&value).as_deref(), Some("answer"));
    }

    #[test]
    fn intelligence_editor_requests_constrained_json_from_compatible_servers() {
        let request = Request {
            provider: "compatible",
            base_url: "http://127.0.0.1:8080/v1",
            model: "local-qwen",
            api_key: "",
            task: "intelligence_generate_brief",
            prompt: "system",
            question: "question",
            context: "context",
            max_tokens: 768,
            response_timeout: Duration::from_secs(30),
        };
        let body = payload(request);
        assert_eq!(
            body.pointer("/response_format/type")
                .and_then(|value| value.as_str()),
            Some("json_object")
        );
        assert_eq!(
            body.pointer("/temperature")
                .and_then(|value| value.as_f64()),
            Some(0.1)
        );
        let triage = payload(Request {
            task: "intelligence_triage_articles",
            ..request
        });
        assert_eq!(
            triage
                .pointer("/response_format/type")
                .and_then(|value| value.as_str()),
            Some("json_object")
        );
    }

    #[test]
    fn local_health_check_requires_an_advertised_matching_model() {
        let body = r#"{"data":[{"id":"Qwen3.8-27B-UD-Q3_K_XL.gguf"}]}"#;
        let ids = model_ids_from_response(body).unwrap();
        assert!(ids
            .iter()
            .any(|id| compatible_model_id(id, "Qwen3.8-27B-UD-Q3_K_XL")));
        assert!(!ids
            .iter()
            .any(|id| compatible_model_id(id, "Qwen3-8B-Instruct")));
        assert!(model_ids_from_response(r#"{"data":[]}"#)
            .unwrap()
            .is_empty());
        assert!(model_ids_from_response(r#"{"models":[]}"#).is_none());
    }
}
