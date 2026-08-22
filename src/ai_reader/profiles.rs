//! Pure configuration and profile rules for the local BYOK reading assistant.
//!
//! Persistence, credential encryption, Tauri commands, and provider requests
//! deliberately stay in the parent module. This module only owns in-memory
//! shapes plus normalization and presentation rules.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct StoredConfig {
    #[serde(default)]
    pub(super) provider: String,
    pub(super) base_url: String,
    pub(super) model: String,
    pub(super) api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct StoredAiReaderProfile {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(flatten)]
    pub(super) config: StoredConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct StoredAiReaderProfiles {
    #[serde(default)]
    pub(super) active_id: String,
    #[serde(default)]
    pub(super) assignments: AiReaderProfileAssignments,
    #[serde(default)]
    pub(super) profiles: Vec<StoredAiReaderProfile>,
}

/// The legacy active profile remains the reading-assistant profile. Keeping
/// that mirror lets existing private-sync payloads and older clients keep
/// their single-profile behaviour while new installs can choose per feature.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderProfileAssignments {
    #[serde(default)]
    pub reading_id: String,
    #[serde(default)]
    pub library_id: String,
    #[serde(default)]
    pub other_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderProfileSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReaderProfilesStatus {
    pub active_id: String,
    pub assignments: AiReaderProfileAssignments,
    pub profiles: Vec<AiReaderProfileSummary>,
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
    pub(super) provider: String,
    pub(super) base_url: String,
    pub(super) model: String,
    pub(super) api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAiReaderProfileRequest {
    #[serde(default)]
    pub(super) id: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) provider: String,
    pub(super) base_url: String,
    pub(super) model: String,
    /// Leaving this blank while updating an existing profile keeps its key.
    #[serde(default)]
    pub(super) api_key: String,
}

/// A deliberately separate, local-only model configuration for the
/// intelligence workspace. It is not part of a BYOK profile assignment and
/// never participates in the portable/synchronised reader configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct IntelligenceLocalModelConfig {
    pub(super) base_url: String,
    pub(super) model: String,
    #[serde(default)]
    pub(super) api_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceLocalModelStatus {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveIntelligenceLocalModelRequest {
    pub(super) base_url: String,
    pub(super) model: String,
    #[serde(default)]
    pub(super) api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssignAiReaderProfileRequest {
    /// reading | library | other
    pub(super) purpose: String,
    pub(super) id: String,
}

pub(super) fn normalize_base_url(value: &str) -> Result<String, String> {
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

/// Intelligence processing must never route public-news evidence to a remote
/// endpoint. The normal BYOK configuration intentionally supports HTTPS
/// providers; this narrower validator accepts only loopback HTTP services such
/// as llama.cpp's or LM Studio's OpenAI-compatible server.
pub(super) fn normalize_intelligence_local_base_url(value: &str) -> Result<String, String> {
    let normalized = normalize_base_url(value)?;
    let authority_and_path = normalized
        .strip_prefix("http://")
        .ok_or("情报模型接口只能使用本机 HTTP 服务")?;
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err("情报模型接口必须是 localhost、127.0.0.1 或 ::1".into());
    }
    let local = if let Some(rest) = authority.strip_prefix('[') {
        let Some((host, port)) = rest.split_once(']') else {
            return Err("情报模型接口的 IPv6 地址格式无效".into());
        };
        host == "::1" && valid_optional_port(port)
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, ""), |(host, port)| (host, port));
        matches!(host, "localhost" | "127.0.0.1") && (port.is_empty() || valid_port(port))
    };
    if !local {
        return Err("情报模型接口只能使用 localhost、127.0.0.1 或 ::1".into());
    }
    Ok(normalized)
}

fn valid_optional_port(value: &str) -> bool {
    value.strip_prefix(':').is_some_and(valid_port) || value.is_empty()
}

fn valid_port(value: &str) -> bool {
    value.parse::<u16>().is_ok_and(|port| port > 0)
}

/// A model name is a user-declared compatibility label, not proof of the
/// loaded weights. The local server API cannot reliably expose quantisation, so
/// keep the constraint explicit and reject accidental remote/smaller profiles.
pub(super) fn validate_intelligence_qwen_27b_q3_model(value: &str) -> Result<String, String> {
    let model = value.trim();
    if model.is_empty() || model.len() > 200 {
        return Err("情报模型名不能为空且不能超过 200 个字节".into());
    }
    let normalized = model.to_ascii_lowercase();
    if !(normalized.contains("qwen") && normalized.contains("27b") && normalized.contains("q3")) {
        return Err("情报模型名必须明确标识为 Qwen 27B Q3；名称校验不能证明实际权重或量化".into());
    }
    Ok(model.to_string())
}

pub(super) fn intelligence_local_model_status(
    config: &IntelligenceLocalModelConfig,
) -> IntelligenceLocalModelStatus {
    IntelligenceLocalModelStatus {
        configured: normalize_intelligence_local_base_url(&config.base_url).is_ok()
            && validate_intelligence_qwen_27b_q3_model(&config.model).is_ok(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
    }
}

pub(super) fn known_provider(value: &str) -> &'static str {
    match value.trim() {
        "deepseek" => "deepseek",
        "openai" => "openai",
        "anthropic" => "anthropic",
        _ => "compatible",
    }
}

pub(super) fn infer_provider(base_url: &str) -> &'static str {
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

pub(super) fn canonicalize_deepseek_config(mut config: StoredConfig) -> StoredConfig {
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

pub(super) fn default_profile_name(config: &StoredConfig) -> String {
    let provider = match known_provider(&config.provider) {
        "deepseek" => "DeepSeek",
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        _ => "兼容接口",
    };
    if config.model.trim().is_empty() {
        provider.to_string()
    } else {
        format!("{provider} · {}", trim_to_chars(config.model.trim(), 48))
    }
}

pub(super) fn has_profile(store: &StoredAiReaderProfiles, id: &str) -> bool {
    !id.trim().is_empty() && store.profiles.iter().any(|profile| profile.id == id)
}

pub(super) fn normalize_profile_assignments(store: &mut StoredAiReaderProfiles) {
    if !has_profile(store, &store.active_id) {
        store.active_id = store
            .profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default();
    }
    let fallback = store.active_id.clone();
    // Each capability always needs a model. Empty or stale bindings repair to
    // the legacy active model, including users who briefly tried the old
    // click-again-to-cancel interaction.
    if !has_profile(store, &store.assignments.reading_id) {
        store.assignments.reading_id = fallback.clone();
    }
    if !has_profile(store, &store.assignments.library_id) {
        store.assignments.library_id = fallback.clone();
    }
    if !has_profile(store, &store.assignments.other_id) {
        store.assignments.other_id = fallback.clone();
    }
    // `active_id` is deliberately the old one-model representation of
    // reading, so importing an old client remains predictable.
    store.active_id = store.assignments.reading_id.clone();
}

pub(super) fn active_profile(store: &StoredAiReaderProfiles) -> Option<&StoredAiReaderProfile> {
    store
        .profiles
        .iter()
        .find(|profile| profile.id == store.active_id)
}

pub(super) fn profile_for_purpose<'a>(
    store: &'a StoredAiReaderProfiles,
    purpose: &str,
) -> Option<&'a StoredAiReaderProfile> {
    let id = match purpose {
        "reading" => &store.assignments.reading_id,
        "library" => &store.assignments.library_id,
        "other" => &store.assignments.other_id,
        _ => &store.active_id,
    };
    store
        .profiles
        .iter()
        .find(|profile| profile.id == *id)
        .or_else(|| active_profile(store))
}

pub(super) fn profile_summary(profile: &StoredAiReaderProfile) -> AiReaderProfileSummary {
    let config = canonicalize_deepseek_config(profile.config.clone());
    AiReaderProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        configured: !config.base_url.is_empty()
            && !config.model.is_empty()
            && !config.api_key.is_empty(),
        provider: config.provider,
        base_url: config.base_url,
        model: config.model,
    }
}

pub(super) fn status(config: &StoredConfig) -> AiReaderStatus {
    AiReaderStatus {
        configured: !config.base_url.is_empty()
            && !config.model.is_empty()
            && !config.api_key.is_empty(),
        provider: config.provider.clone(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
    }
}

fn trim_to_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intelligence_model_accepts_only_loopback_http_and_declared_qwen_27b_q3() {
        assert_eq!(
            normalize_intelligence_local_base_url("http://127.0.0.1:8080/v1/").unwrap(),
            "http://127.0.0.1:8080/v1"
        );
        assert_eq!(
            normalize_intelligence_local_base_url("http://[::1]:1234/v1").unwrap(),
            "http://[::1]:1234/v1"
        );
        assert!(normalize_intelligence_local_base_url("https://api.example.test/v1").is_err());
        assert!(normalize_intelligence_local_base_url("http://192.168.1.2:8080/v1").is_err());
        assert_eq!(
            validate_intelligence_qwen_27b_q3_model("Qwen3-27B-UD-Q3_K_XL").unwrap(),
            "Qwen3-27B-UD-Q3_K_XL"
        );
        assert!(validate_intelligence_qwen_27b_q3_model("Qwen3-14B-Q4_K_M").is_err());
    }

    #[test]
    fn intelligence_status_does_not_require_a_local_api_key() {
        let status = intelligence_local_model_status(&IntelligenceLocalModelConfig {
            base_url: "http://localhost:8080/v1".into(),
            model: "Qwen3-27B-UD-Q3_K_XL".into(),
            api_key: String::new(),
        });
        assert!(status.configured);
        assert_eq!(status.model, "Qwen3-27B-UD-Q3_K_XL");
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
    fn canonicalizes_official_deepseek_and_validates_local_http_only() {
        let official = canonicalize_deepseek_config(StoredConfig {
            provider: String::new(),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            api_key: "unused".into(),
        });
        assert_eq!(official.model, "deepseek-v4-flash");
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/chat/completions/").unwrap(),
            "https://api.deepseek.com/v1"
        );
        let public_http = ["http", "://example.test/v1"].concat();
        assert!(normalize_base_url(&public_http).is_err());
        assert_eq!(
            normalize_base_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
    }
}
