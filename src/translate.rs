use crate::{db::AppDb, secret_store};
use serde::{Deserialize, Serialize};
use std::time::Duration;

mod language;
mod signing;
use language::{normalize_baidu_lang, normalize_common_lang, normalize_deepl_lang};
use signing::{hmac_sha256, hmac_sha256_hex, md5_hex, sha256_hex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TranslateResult {
    pub ok: bool,
    pub provider: String,
    pub source_lang: String,
    pub target_lang: String,
    pub original: String,
    pub translated: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranslationCredential {
    provider: String,
    api_id: String,
    api_key: String,
}

const TRANSLATION_ACTIVE_PROVIDER_KEY: &str = "translation_active_provider:v1";
const TRANSLATION_PROVIDERS: [&str; 4] = ["baidu", "tencent", "deepl", "google"];

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TranslationCredentialsStatus {
    pub active_provider: String,
    pub profiles: Vec<TranslationCredentialStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TranslationCredentialStatus {
    pub config_id: String,
    pub provider: String,
    pub configured: bool,
}

fn normalize_provider(provider: &str) -> Result<&'static str, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "baidu" => Ok("baidu"),
        "tencent" => Ok("tencent"),
        "deepl" => Ok("deepl"),
        "google" => Ok("google"),
        _ => Err("未知翻译 API".to_string()),
    }
}

fn credential_config_id(provider: &str) -> String {
    format!("translate:{provider}")
}

fn credential_metadata_key(provider: &str) -> String {
    format!("translate_credential_protected:{provider}")
}

fn credential_is_complete(credential: &TranslationCredential) -> bool {
    !credential.api_id.trim().is_empty()
        && (!matches!(credential.provider.as_str(), "baidu" | "tencent")
            || !credential.api_key.trim().is_empty())
}

fn load_translation_credential(
    db: &AppDb,
    config_id: &str,
) -> Result<TranslationCredential, String> {
    let provider = config_id
        .trim()
        .strip_prefix("translate:")
        .ok_or("无效的翻译凭据配置 ID")?;
    let provider = normalize_provider(provider)?;
    let stored = db
        .metadata(&credential_metadata_key(provider))
        .ok_or("尚未配置该翻译服务的凭据")?;
    let json = secret_store::unprotect_secret(&stored)?;
    let credential: TranslationCredential =
        serde_json::from_str(&json).map_err(|e| format!("翻译凭据损坏：{e}"))?;
    if credential.provider != provider || !credential_is_complete(&credential) {
        return Err("翻译凭据配置不完整".to_string());
    }
    Ok(credential)
}

pub(crate) fn export_public_config(db: &AppDb) -> Result<serde_json::Value, String> {
    let providers = TRANSLATION_PROVIDERS
        .into_iter()
        .filter(|provider| {
            translation_credential_status(db, provider)
                .map(|status| status.configured)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "version": 1, "providers": providers }))
}

pub(crate) fn export_secret_configs(db: &AppDb) -> Result<Vec<serde_json::Value>, String> {
    let values = TRANSLATION_PROVIDERS
        .into_iter()
        .filter_map(|provider| {
            let config_id = credential_config_id(provider);
            load_translation_credential(db, &config_id)
                .ok()
                .and_then(|credential| serde_json::to_value(credential).ok())
        })
        .collect::<Vec<_>>();
    Ok(values)
}

pub(crate) fn import_secret_configs(
    db: &AppDb,
    values: &[serde_json::Value],
) -> Result<(), String> {
    for value in values {
        let credential: TranslationCredential = serde_json::from_value(value.clone())
            .map_err(|e| format!("翻译密钥包格式无效：{e}"))?;
        save_translation_credential(
            db,
            &credential.provider,
            &credential.api_id,
            &credential.api_key,
        )?;
    }
    Ok(())
}

pub(crate) fn translation_credential_status(
    db: &AppDb,
    provider: &str,
) -> Result<TranslationCredentialStatus, String> {
    let provider = normalize_provider(provider)?.to_string();
    let config_id = credential_config_id(&provider);
    let configured = load_translation_credential(db, &config_id).is_ok();
    Ok(TranslationCredentialStatus {
        config_id,
        provider,
        configured,
    })
}

pub(crate) fn translation_credentials_status(
    db: &AppDb,
) -> Result<TranslationCredentialsStatus, String> {
    let profiles = TRANSLATION_PROVIDERS
        .into_iter()
        .map(|provider| translation_credential_status(db, provider))
        .collect::<Result<Vec<_>, _>>()?;
    let saved = db
        .metadata(TRANSLATION_ACTIVE_PROVIDER_KEY)
        .unwrap_or_default();
    let active_provider = profiles
        .iter()
        .find(|profile| profile.provider == saved && profile.configured)
        .or_else(|| profiles.iter().find(|profile| profile.configured))
        .map(|profile| profile.provider.clone())
        .unwrap_or_else(|| "baidu".to_string());
    Ok(TranslationCredentialsStatus {
        active_provider,
        profiles,
    })
}

pub(crate) fn set_translation_active_provider(
    db: &AppDb,
    provider: &str,
) -> Result<TranslationCredentialsStatus, String> {
    let provider = normalize_provider(provider)?;
    if !translation_credential_status(db, provider)?.configured {
        return Err("请先在“大模型与翻译 API”中保存该翻译服务的凭据".into());
    }
    db.set_metadata(TRANSLATION_ACTIVE_PROVIDER_KEY, provider)?;
    translation_credentials_status(db)
}

pub(crate) fn save_translation_credential(
    db: &AppDb,
    provider: &str,
    api_id: &str,
    api_key: &str,
) -> Result<TranslationCredentialStatus, String> {
    let provider = normalize_provider(provider)?.to_string();
    let api_id = api_id.trim();
    let api_key = api_key.trim();
    if api_id.len() > 4096 || api_key.len() > 4096 {
        return Err("翻译凭据过长".to_string());
    }
    if api_id.is_empty() || (matches!(provider.as_str(), "baidu" | "tencent") && api_key.is_empty())
    {
        return Err("翻译凭据不完整".to_string());
    }
    let credential = TranslationCredential {
        provider: provider.clone(),
        api_id: api_id.to_string(),
        api_key: api_key.to_string(),
    };
    let json = serde_json::to_string(&credential).map_err(|e| e.to_string())?;
    let protected = secret_store::protect_secret(&json)?;
    db.set_metadata(&credential_metadata_key(&provider), &protected)?;
    translation_credential_status(db, &provider)
}

pub(crate) fn resolve_translation_credential(
    db: &AppDb,
    config_id: &str,
) -> Result<(String, String, String), String> {
    let credential = load_translation_credential(db, config_id)?;
    Ok((credential.provider, credential.api_id, credential.api_key))
}

fn baidu_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    app_id: &str,
    key: &str,
) -> Result<String, String> {
    let app_id = app_id.trim();
    let key = key.trim();
    if app_id.is_empty() || key.is_empty() {
        return Err("请先填写百度翻译 AppID 和密钥。".to_string());
    }
    let from = normalize_baidu_lang(source_lang, "auto");
    let to = normalize_baidu_lang(target_lang, "zh");
    let salt = chrono::Utc::now().timestamp_millis().to_string();
    let sign = md5_hex(format!("{app_id}{text}{salt}{key}").as_bytes());
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .timeout_recv_body(Some(Duration::from_secs(20)))
        .build()
        .into();
    let value = agent
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .header("User-Agent", "kunpeng-reader")
        .send_form([
            ("q", text),
            ("from", &from),
            ("to", &to),
            ("appid", app_id),
            ("salt", &salt),
            ("sign", &sign),
        ])
        .map_err(|e| format!("百度翻译请求失败：{e}"))?
        .body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("百度翻译返回解析失败：{e}"))?;
    if let Some(code) = value.get("error_code").and_then(|v| v.as_str()) {
        let msg = value
            .get("error_msg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("百度翻译错误 {code}：{msg}"));
    }
    let mut out = String::new();
    if let Some(arr) = value.get("trans_result").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(dst) = item.get("dst").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("百度翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn deepl_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 DeepL API Key。".to_string());
    }
    let target = normalize_deepl_lang(target_lang, "ZH", true);
    let source = normalize_deepl_lang(source_lang, "auto", false);
    let url = if api_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .build()
        .into();
    let req = agent
        .post(url)
        .header("User-Agent", "kunpeng-reader")
        .header("Authorization", &format!("DeepL-Auth-Key {api_key}"));
    let mut form = vec![("text", text), ("target_lang", target.as_str())];
    if source != "auto" {
        form.push(("source_lang", source.as_str()));
    }
    let value = req
        .send_form(form)
        .map_err(|e| format!("DeepL 翻译请求失败：{e}"))?
        .body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("DeepL 翻译返回解析失败：{e}"))?;
    let mut out = String::new();
    if let Some(arr) = value.get("translations").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(dst) = item.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("DeepL 翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn google_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 Google API Key。".to_string());
    }
    let source = normalize_common_lang(source_lang, "auto");
    let target = normalize_common_lang(target_lang, "zh-CN");
    let endpoint =
        format!("https://translation.googleapis.com/language/translate/v2?key={api_key}");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut form = vec![("q", text), ("target", target.as_str()), ("format", "text")];
    if source != "auto" {
        form.push(("source", source.as_str()));
    }
    let value = agent
        .post(&endpoint)
        .header("User-Agent", "kunpeng-reader")
        .send_form(form)
        .map_err(|e| format!("Google 翻译请求失败：{e}"))?
        .body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("Google 翻译返回解析失败：{e}"))?;
    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("Google 翻译错误：{msg}"));
    }
    let mut out = String::new();
    if let Some(arr) = value
        .get("data")
        .and_then(|v| v.get("translations"))
        .and_then(|v| v.as_array())
    {
        for item in arr {
            if let Some(dst) = item.get("translatedText").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("Google 翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn tencent_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    secret_id: &str,
    secret_key: &str,
) -> Result<String, String> {
    let secret_id = secret_id.trim();
    let secret_key = secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("请先填写腾讯翻译 SecretId 和 SecretKey。".to_string());
    }
    let endpoint = "https://tmt.tencentcloudapi.com";
    let host = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let action = "TextTranslate";
    let version = "2018-03-21";
    let region = "ap-guangzhou";
    let source = normalize_common_lang(source_lang, "auto");
    let target = normalize_common_lang(target_lang, "zh");
    let timestamp = chrono::Utc::now().timestamp();
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%d")
        .to_string();
    let payload = serde_json::json!({
        "SourceText": text,
        "Source": source,
        "Target": target,
        "ProjectId": 0
    })
    .to_string();
    let hashed_payload = sha256_hex(payload.as_bytes());
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{}\n",
        action.to_ascii_lowercase()
    );
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}");
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hmac_sha256_hex(&secret_signing, string_to_sign.as_bytes());
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .build()
        .into();
    let value = agent
        .post(endpoint)
        .header("Authorization", &authorization)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", host)
        .header("X-TC-Action", action)
        .header("X-TC-Timestamp", &timestamp.to_string())
        .header("X-TC-Version", version)
        .header("X-TC-Region", region)
        .send(payload.as_str())
        .map_err(|e| format!("腾讯翻译请求失败：{e}"))?
        .body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("腾讯翻译返回解析失败：{e}"))?;
    if let Some(err) = value
        .get("Response")
        .and_then(|v| v.get("Error"))
        .and_then(|v| v.as_object())
    {
        let code = err
            .get("Code")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let msg = err
            .get("Message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("腾讯翻译错误 {code}：{msg}"));
    }
    let out = value
        .get("Response")
        .and_then(|v| v.get("TargetText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if out.is_empty() {
        Err("腾讯翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

pub(crate) fn translate_text(
    text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
    provider: Option<String>,
    api_id: Option<String>,
    api_key: Option<String>,
) -> TranslateResult {
    let original = text.trim().to_string();
    let provider = provider.unwrap_or_else(|| "baidu".to_string());
    let source_lang = source_lang.unwrap_or_else(|| "auto".to_string());
    let target_lang = target_lang.unwrap_or_else(|| "zh-CN".to_string());
    if original.is_empty() {
        return TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error: "没有可翻译的文字".to_string(),
        };
    }
    if original.chars().count() > 5000 {
        return TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error: "选中文字过长，请分段翻译".to_string(),
        };
    }
    let api_id = api_id.unwrap_or_default();
    let api_key = api_key.unwrap_or_default();
    let result = match provider.as_str() {
        "baidu" => baidu_translate(&original, &source_lang, &target_lang, &api_id, &api_key),
        "tencent" => tencent_translate(&original, &source_lang, &target_lang, &api_id, &api_key),
        "deepl" => deepl_translate(&original, &source_lang, &target_lang, &api_id),
        "google" => google_translate(&original, &source_lang, &target_lang, &api_id),
        _ => Err("未知翻译 API".to_string()),
    };
    match result {
        Ok(translated) => TranslateResult {
            ok: true,
            provider,
            source_lang,
            target_lang,
            original,
            translated,
            error: String::new(),
        },
        Err(error) => TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error,
        },
    }
}
