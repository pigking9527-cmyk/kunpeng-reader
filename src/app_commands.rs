//! Thin Tauri adapters for application utilities that do not own long-lived state.

use crate::{
    background_tasks, diagnostics, dict, external_dict, log, now_ms, translate, url_open, AppState,
};
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) fn reader_perf_log(window: tauri::WebviewWindow, event: String) {
    if event.len() <= 1000 && window.label().starts_with("reader-") {
        if event.starts_with("shell_ready ") {
            crate::window_commands::record_reader_ready(&window);
        }
        crate::window_commands::record_reader_shell_benchmark_phase(&window, &event);
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
const PROBLEM_TRACE_LATEST_FILE: &str = "problem-trace-latest.json";

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

fn problem_trace_checkpoint_path() -> Result<PathBuf, String> {
    let directory =
        crate::profile::app_cache_dir().ok_or_else(|| "问题记录缓存目录不可用".to_string())?;
    Ok(directory.join(PROBLEM_TRACE_LATEST_FILE))
}

fn persist_problem_trace_checkpoint_at(
    path: &Path,
    snapshot: &serde_json::Value,
) -> Result<(), String> {
    validate_problem_trace_checkpoint(snapshot)?;
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "问题记录数据格式不正确".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "问题记录缓存目录不可用".to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| format!("创建问题记录缓存失败：{error}"))?;
    let temporary = directory.join(format!(".{PROBLEM_TRACE_LATEST_FILE}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("写入问题记录缓存失败：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入问题记录缓存失败：{error}"))?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("更新问题记录缓存失败：{error}"))?;
    }
    std::fs::rename(&temporary, path).map_err(|error| format!("更新问题记录缓存失败：{error}"))?;
    Ok(())
}

fn load_problem_trace_checkpoint_at(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取问题记录缓存失败：{error}")),
    };
    if bytes.is_empty() || bytes.len() > PROBLEM_TRACE_MAX_BYTES {
        return Err("问题记录缓存数据不正确".to_string());
    }
    let snapshot = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| "问题记录缓存不是有效的 JSON".to_string())?;
    validate_problem_trace_checkpoint(&snapshot)?;
    Ok(Some(snapshot))
}

fn persist_problem_trace_checkpoint(snapshot: &serde_json::Value) -> Result<(), String> {
    persist_problem_trace_checkpoint_at(&problem_trace_checkpoint_path()?, snapshot)
}

fn load_problem_trace_checkpoint() -> Result<Option<serde_json::Value>, String> {
    load_problem_trace_checkpoint_at(&problem_trace_checkpoint_path()?)
}

fn problem_trace_has_reader_activity(snapshot: &serde_json::Value) -> bool {
    if snapshot
        .get("reader_state")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|state| state.get("frame_ready").and_then(serde_json::Value::as_bool) == Some(true))
    {
        return true;
    }
    snapshot
        .get("events")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|events| {
            events.iter().any(|event| {
                !matches!(
                    event.get("type").and_then(serde_json::Value::as_str),
                    Some("trace_started" | "capture")
                )
            })
        })
}

fn problem_trace_should_replace(previous: &serde_json::Value, incoming: &serde_json::Value) -> bool {
    !problem_trace_has_reader_activity(previous) || problem_trace_has_reader_activity(incoming)
}

/// Keep the latest redacted reader snapshot in memory and in the application
/// cache so closing the reader WebView or the process does not destroy the only
/// diagnostic copy. The file is bounded and replaced rather than accumulated.
#[tauri::command]
pub(crate) fn problem_trace_checkpoint(
    snapshot: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let mut cached = PROBLEM_TRACE_CACHE
        .lock()
        .map_err(|_| "问题记录缓存暂时不可用".to_string())?;
    if let Some(snapshot) = snapshot {
        validate_problem_trace_checkpoint(&snapshot)?;
        let previous = cached
            .as_ref()
            .map(|(_, value)| value.clone())
            .or_else(|| load_problem_trace_checkpoint().ok().flatten());
        if previous
            .as_ref()
            .is_some_and(|existing| !problem_trace_should_replace(existing, &snapshot))
        {
            *cached = Some((now_ms(), previous.expect("checked above")));
        } else {
            *cached = Some((now_ms(), snapshot.clone()));
            if let Err(error) = persist_problem_trace_checkpoint(&snapshot) {
                log(&format!("problem_trace_checkpoint persist_failed {error}"));
            }
        }
        return Ok(None);
    }
    if let Some((stored_at, snapshot)) = cached.as_ref() {
        if now_ms().saturating_sub(*stored_at) <= PROBLEM_TRACE_WINDOW_MS {
            return Ok(Some(snapshot.clone()));
        }
    }
    *cached = None;
    load_problem_trace_checkpoint()
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

    #[test]
    fn problem_trace_checkpoint_is_atomically_replaced_and_reloadable() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-problem-trace-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = directory.join(PROBLEM_TRACE_LATEST_FILE);
        let first = serde_json::json!({
            "schema_version": 1,
            "captured_at": "2026-08-16T12:00:00.000Z",
            "events": [{"type": "page_click", "detail": {"chapter": 2}}]
        });
        persist_problem_trace_checkpoint_at(&path, &first).unwrap();
        assert_eq!(
            load_problem_trace_checkpoint_at(&path).unwrap(),
            Some(first)
        );

        let second = serde_json::json!({
            "schema_version": 1,
            "captured_at": "2026-08-16T12:01:00.000Z",
            "events": []
        });
        persist_problem_trace_checkpoint_at(&path, &second).unwrap();
        assert_eq!(
            load_problem_trace_checkpoint_at(&path).unwrap(),
            Some(second)
        );
        assert!(!directory
            .join(format!(".{PROBLEM_TRACE_LATEST_FILE}.tmp"))
            .exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn problem_trace_keeps_a_recent_reader_diagnostic_when_a_new_window_is_still_loading() {
        let active = serde_json::json!({
            "captured_at": "2026-08-16T12:00:00.000Z",
            "reader_state": {"frame_ready": true},
            "events": [{"type": "page_layout", "detail": {"mac_clip_applied_blank": 24}}]
        });
        let loading = serde_json::json!({
            "captured_at": "2026-08-16T12:00:01.000Z",
            "reader_state": {"frame_ready": false},
            "events": [{"type": "trace_started"}, {"type": "capture"}]
        });
        let next_reader = serde_json::json!({
            "captured_at": "2026-08-16T12:00:02.000Z",
            "reader_state": {"frame_ready": true},
            "events": [{"type": "frame_ready"}]
        });
        assert!(!problem_trace_should_replace(&active, &loading));
        assert!(problem_trace_should_replace(&active, &next_reader));
    }

    #[test]
    fn problem_trace_checkpoint_rejects_invalid_persisted_json() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-problem-trace-invalid-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(PROBLEM_TRACE_LATEST_FILE);
        std::fs::write(&path, b"not-json").unwrap();
        assert!(load_problem_trace_checkpoint_at(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
