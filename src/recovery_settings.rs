//! Explicit, non-sensitive WebView preference snapshots for recovery points.
//!
//! WebView browser storage also contains cookies and possible credentials, so a
//! recovery point must never copy the browser profile as a whole.  Instead the
//! two application origins periodically persist a bounded, filtered snapshot.

use crate::atomic_file;
use serde_json::{Map, Value};
use std::path::PathBuf;

pub(crate) const MAIN_SNAPSHOT_FILE: &str = "web-settings-main-v1.json";
pub(crate) const READER_SNAPSHOT_FILE: &str = "web-settings-reader-v1.json";
const RESTORE_PENDING_FILE: &str = "web-settings-restore-pending-v1.json";
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SETTING_COUNT: usize = 2048;
const MAX_KEY_BYTES: usize = 256;

fn config_dir() -> Result<PathBuf, String> {
    let mut dir = dirs::config_dir().ok_or("无法确定应用配置目录")?;
    dir.push("ebook-reader");
    Ok(dir)
}

fn snapshot_name(scope: &str) -> Result<&'static str, String> {
    match scope {
        "main" => Ok(MAIN_SNAPSHOT_FILE),
        "reader" => Ok(READER_SNAPSHOT_FILE),
        _ => Err("网页设置范围无效".into()),
    }
}

fn snapshot_path(scope: &str) -> Result<PathBuf, String> {
    Ok(config_dir()?.join(snapshot_name(scope)?))
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(RESTORE_PENDING_FILE))
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "password",
        "secret",
        "api_key",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn sanitize_settings(settings: Value) -> Result<Value, String> {
    let source = settings.as_object().ok_or("网页设置快照必须是键值对象")?;
    if source.len() > MAX_SETTING_COUNT {
        return Err("网页设置项过多，未保存".into());
    }
    let mut filtered = Map::new();
    for (key, value) in source {
        if key.is_empty() || key.len() > MAX_KEY_BYTES || is_sensitive_key(key) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        filtered.insert(key.clone(), Value::String(value.to_string()));
    }
    let snapshot = serde_json::json!({ "version": 1, "settings": filtered });
    if serde_json::to_vec(&snapshot)
        .map_err(|error| format!("序列化网页设置失败：{error}"))?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err("网页设置过大，未保存".into());
    }
    Ok(snapshot)
}

pub(crate) fn snapshot_values() -> Vec<Value> {
    ["main", "reader"]
        .into_iter()
        .filter_map(|scope| std::fs::read(snapshot_path(scope).ok()?).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

pub(crate) fn ensure_snapshot_files() -> Result<(), String> {
    for scope in ["main", "reader"] {
        let path = snapshot_path(scope)?;
        if !path.is_file() {
            atomic_file::write_json(&path, &sanitize_settings(Value::Object(Map::new()))?, true)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn recovery_web_settings_save(scope: String, settings: Value) -> Result<(), String> {
    let snapshot = sanitize_settings(settings)?;
    atomic_file::write_json(&snapshot_path(&scope)?, &snapshot, true)
}

#[tauri::command]
pub(crate) fn recovery_web_settings_take_restored(scope: String) -> Result<Option<Value>, String> {
    snapshot_name(&scope)?;
    let path = pending_path()?;
    let mut pending = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Vec<String>>(&bytes)
            .map_err(|error| format!("恢复网页设置标记无效：{error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取恢复网页设置标记失败：{error}")),
    };
    if !pending.iter().any(|item| item == &scope) {
        return Ok(None);
    }
    let bytes = std::fs::read(snapshot_path(&scope)?)
        .map_err(|error| format!("读取恢复网页设置失败：{error}"))?;
    let snapshot: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("恢复网页设置格式无效：{error}"))?;
    let settings = sanitize_settings(snapshot.get("settings").cloned().unwrap_or(Value::Null))?
        .get("settings")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    pending.retain(|item| item != &scope);
    if pending.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("清理恢复网页设置标记失败：{error}")),
        }
    } else {
        atomic_file::write_json(&path, &pending, true)?;
    }
    Ok(Some(settings))
}

pub(crate) fn mark_restore_pending() -> Result<(), String> {
    atomic_file::write_json(&pending_path()?, &vec!["main", "reader"], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_preferences_but_removes_credentials() {
        let value = sanitize_settings(serde_json::json!({
            "readerSettings": "{}", "translateApiKey": "private", "syncToken": "private",
            "empty": 4,
        }))
        .unwrap();
        let settings = value.get("settings").and_then(Value::as_object).unwrap();
        assert!(settings.contains_key("readerSettings"));
        assert!(!settings.contains_key("translateApiKey"));
        assert!(!settings.contains_key("syncToken"));
        assert!(!settings.contains_key("empty"));
    }
}
