//! Thin Tauri adapters for application utilities that do not own long-lived state.

use crate::{
    background_tasks, diagnostics, dict, external_dict, log, now_ms, translate, url_open, AppState,
};
use serde::Deserialize;

#[tauri::command]
pub(crate) fn reader_perf_log(window: tauri::WebviewWindow, event: String) {
    if event.len() <= 1000 && window.label().starts_with("reader-") {
        log(&format!("reader_perf label={} {event}", window.label()));
    }
}

#[tauri::command]
pub(crate) fn background_task_status(
    state: tauri::State<AppState>,
) -> Vec<background_tasks::BackgroundTaskSnapshot> {
    state.background_tasks.snapshots()
}

#[tauri::command]
pub(crate) fn background_task_cancel(
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), String> {
    state.background_tasks.request_cancel(&id)
}

#[tauri::command]
pub(crate) fn background_task_pause(
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), String> {
    state.background_tasks.request_pause(&id)
}

/// 当前 app 版本号（取自 Cargo.toml，供“检查更新”和“关于”使用，单一来源）。
#[tauri::command]
pub(crate) fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 从 Rust 进程进入 main 开始计算的启动耗时，供书架记录跨 WebView 的完整启动阶段。
#[tauri::command]
pub(crate) fn startup_elapsed_ms() -> u64 {
    crate::runtime_support::process_start_elapsed_ms()
}

#[tauri::command]
pub(crate) fn runtime_diagnostics() -> diagnostics::RuntimeDiagnostics {
    diagnostics::snapshot()
}

#[tauri::command]
pub(crate) fn clear_runtime_diagnostics() -> diagnostics::RuntimeDiagnostics {
    diagnostics::clear()
}

#[tauri::command]
pub(crate) fn save_download_image(name: String, data_url: String) -> Result<String, String> {
    use base64::Engine;

    let comma = data_url
        .find(',')
        .ok_or_else(|| "图片数据格式不正确".to_string())?;
    let (meta, payload) = data_url.split_at(comma);
    if !meta.starts_with("data:image/") || !meta.contains(";base64") {
        return Err("只支持 base64 图片数据".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&payload[1..])
        .map_err(|_| "图片数据解码失败".to_string())?;
    let mut safe_name = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    if safe_name.is_empty() {
        safe_name = "书摘.png".to_string();
    }
    if !safe_name.to_ascii_lowercase().ends_with(".png") {
        safe_name.push_str(".png");
    }
    let mut dir = dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .ok_or_else(|| "找不到下载目录".to_string())?;
    let base = safe_name.trim_end_matches(".png").to_string();
    dir.push(&safe_name);
    if dir.exists() {
        let timestamp = now_ms();
        dir.set_file_name(format!("{base}-{timestamp}.png"));
    }
    std::fs::write(&dir, bytes).map_err(|error| format!("保存图片失败：{error}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

const PROBLEM_TRACE_WINDOW_MS: u64 = 2 * 60 * 1000;
const PROBLEM_TRACE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn validate_problem_trace_checkpoint(snapshot: &serde_json::Value) -> Result<(), String> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| "问题记录数据格式不正确".to_string())?;
    if object
        .get("captured_at")
        .and_then(serde_json::Value::as_str)
        .is_none()
        || !object.get("events").is_none_or(serde_json::Value::is_array)
    {
        return Err("问题记录数据格式不正确".to_string());
    }
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "问题记录数据格式不正确".to_string())?;
    if bytes.is_empty() || bytes.len() > PROBLEM_TRACE_MAX_BYTES {
        return Err("问题记录超过 4 MB，无法缓存".to_string());
    }
    Ok(())
}

static PROBLEM_TRACE_CACHE: std::sync::LazyLock<
    std::sync::Mutex<Option<(u64, serde_json::Value)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Keep the latest redacted reader snapshot in the Rust process so closing the
/// reader WebView does not destroy the only copy before the Bug dialog opens.
#[tauri::command]
pub(crate) fn problem_trace_checkpoint(
    snapshot: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let mut cached = PROBLEM_TRACE_CACHE
        .lock()
        .map_err(|_| "问题记录缓存暂时不可用".to_string())?;
    if let Some(snapshot) = snapshot {
        validate_problem_trace_checkpoint(&snapshot)?;
        *cached = Some((now_ms(), snapshot));
        return Ok(None);
    }
    let Some((stored_at, snapshot)) = cached.as_ref() else {
        return Ok(None);
    };
    if now_ms().saturating_sub(*stored_at) <= PROBLEM_TRACE_WINDOW_MS {
        return Ok(Some(snapshot.clone()));
    }
    *cached = None;
    Ok(None)
}

/// Saves the user-requested, redacted problem-trace attachment directly to the desktop.
/// The UI already enforces the same limit before an attachment can be submitted; validate
/// again here so the command cannot be used to write arbitrary large/non-JSON data.
#[tauri::command]
pub(crate) fn save_problem_trace_to_desktop(name: String, data: String) -> Result<String, String> {
    use base64::Engine;

    if data.len() > PROBLEM_TRACE_MAX_BYTES.saturating_mul(2) {
        return Err("问题记录超过 4 MB，无法保存".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "问题记录数据格式不正确".to_string())?;
    if bytes.is_empty() || bytes.len() > PROBLEM_TRACE_MAX_BYTES {
        return Err("问题记录超过 4 MB，无法保存".to_string());
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| "问题记录不是有效的 JSON".to_string())?;

    let mut safe_name = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    if safe_name.is_empty() {
        safe_name = format!("kunpeng-reader-problem-trace-{}.json", now_ms());
    }
    if !safe_name.to_ascii_lowercase().ends_with(".json") {
        safe_name.push_str(".json");
    }
    let mut path = dirs::desktop_dir().ok_or_else(|| "找不到桌面目录".to_string())?;
    path.push(&safe_name);
    if path.exists() {
        let base = safe_name.trim_end_matches(".json");
        path.set_file_name(format!("{base}-{}.json", now_ms()));
    }
    std::fs::write(&path, bytes).map_err(|error| format!("保存问题记录失败：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 离线词典查词（按中/英自动选库）。
#[tauri::command]
pub(crate) fn dict_lookup(term: String, context: Option<String>) -> dict::DictResult {
    dict::lookup(&term, context.as_deref().unwrap_or(""))
}

#[tauri::command]
pub(crate) fn external_dict_list() -> Result<Vec<external_dict::ExternalDictMeta>, String> {
    external_dict::list()
}

#[tauri::command]
pub(crate) fn external_dict_import(
    paths: Vec<String>,
) -> Result<Vec<external_dict::ExternalDictMeta>, String> {
    external_dict::import(paths)
}

#[tauri::command]
pub(crate) fn external_dict_delete(
    id: String,
) -> Result<Vec<external_dict::ExternalDictMeta>, String> {
    external_dict::delete(id)
}

#[tauri::command]
pub(crate) fn external_dict_set_enabled(
    id: String,
    enabled: bool,
) -> Result<Vec<external_dict::ExternalDictMeta>, String> {
    external_dict::set_enabled(id, enabled)
}

#[tauri::command]
pub(crate) fn external_dict_move_priority(
    id: String,
    dir: i32,
) -> Result<Vec<external_dict::ExternalDictMeta>, String> {
    external_dict::move_priority(id, dir)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslateTextRequest {
    text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
    provider: Option<String>,
    credential_config_id: String,
}

#[tauri::command]
pub(crate) async fn translate_text(
    state: tauri::State<'_, AppState>,
    request: TranslateTextRequest,
) -> Result<translate::TranslateResult, String> {
    let TranslateTextRequest {
        text,
        source_lang,
        target_lang,
        provider,
        credential_config_id,
    } = request;
    let fallback_provider = provider.clone().unwrap_or_else(|| "baidu".to_string());
    let fallback_source = source_lang.clone().unwrap_or_else(|| "auto".to_string());
    let fallback_target = target_lang.clone().unwrap_or_else(|| "zh-CN".to_string());
    // Read credentials before scheduling network work; never hold the sole
    // SQLite connection while the translation provider is running.
    let credential = state.with_db_read("resolve_translation_credential", |db| {
        translate::resolve_translation_credential(db, &credential_config_id)
    });
    let (stored_provider, api_id, api_key) = match credential {
        Ok(value) => value,
        Err(error) => {
            return Ok(translate::TranslateResult {
                ok: false,
                provider: fallback_provider,
                source_lang: fallback_source,
                target_lang: fallback_target,
                original: text,
                translated: String::new(),
                error,
            });
        }
    };
    match tokio::task::spawn_blocking(move || {
        translate::translate_text(
            text,
            source_lang,
            target_lang,
            Some(stored_provider),
            Some(api_id),
            Some(api_key),
        )
    })
    .await
    {
        Ok(result) => Ok(result),
        Err(error) => Ok(translate::TranslateResult {
            ok: false,
            provider: fallback_provider,
            source_lang: fallback_source,
            target_lang: fallback_target,
            original: String::new(),
            translated: String::new(),
            error: format!("翻译任务失败：{error}"),
        }),
    }
}

#[tauri::command]
pub(crate) fn translation_credential_status(
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<translate::TranslationCredentialStatus, String> {
    state.with_db_read("translation_credential_status", |db| {
        translate::translation_credential_status(db, &provider)
    })
}

#[tauri::command]
pub(crate) fn translation_credentials_status(
    state: tauri::State<'_, AppState>,
) -> Result<translate::TranslationCredentialsStatus, String> {
    state.with_db_read(
        "translation_credentials_status",
        translate::translation_credentials_status,
    )
}

#[tauri::command]
pub(crate) fn set_translation_active_provider(
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<translate::TranslationCredentialsStatus, String> {
    state.with_db_write("set_translation_active_provider", |db| {
        translate::set_translation_active_provider(db, &provider)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveTranslationCredentialRequest {
    provider: String,
    api_id: String,
    api_key: String,
}

#[tauri::command]
pub(crate) fn save_translation_credential(
    state: tauri::State<'_, AppState>,
    request: SaveTranslationCredentialRequest,
) -> Result<translate::TranslationCredentialStatus, String> {
    let SaveTranslationCredentialRequest {
        provider,
        api_id,
        api_key,
    } = request;
    state.with_db_write("save_translation_credential", |db| {
        translate::save_translation_credential(db, &provider, &api_id, &api_key)
    })
}

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    url_open::open_https_url(&url)
}

#[tauri::command]
pub(crate) fn open_default_apps_settings() -> Result<String, String> {
    url_open::open_default_apps_settings()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_comes_from_the_package_manifest() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn translation_requests_deserialize_camel_case_fields() {
        let request: TranslateTextRequest = serde_json::from_value(serde_json::json!({
            "text": "hello",
            "sourceLang": "en",
            "targetLang": "zh-CN",
            "provider": "baidu",
            "credentialConfigId": "credential-1"
        }))
        .unwrap();
        assert_eq!(request.source_lang.as_deref(), Some("en"));
        assert_eq!(request.credential_config_id, "credential-1");

        let credential: SaveTranslationCredentialRequest =
            serde_json::from_value(serde_json::json!({
                "provider": "baidu",
                "apiId": "id",
                "apiKey": "key"
            }))
            .unwrap();
        assert_eq!(credential.api_id, "id");
        assert_eq!(credential.api_key, "key");
    }
}
