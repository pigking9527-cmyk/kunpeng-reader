//! Explicit, non-sensitive WebView preference snapshots for recovery points.
//!
//! WebView browser storage also contains cookies and possible credentials, so a
//! recovery point must never copy the browser profile as a whole.  Instead the
//! two application origins periodically persist a bounded, filtered snapshot.

mod rules;

use crate::atomic_file;
use rules::sanitize_settings;
use serde_json::Value;
use std::path::PathBuf;

pub(crate) const MAIN_SNAPSHOT_FILE: &str = "web-settings-main-v1.json";
pub(crate) const READER_SNAPSHOT_FILE: &str = "web-settings-reader-v1.json";
const RESTORE_PENDING_FILE: &str = "web-settings-restore-pending-v1.json";

fn config_dir() -> Result<PathBuf, String> {
    crate::profile::app_config_dir().ok_or("无法确定应用配置目录".into())
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
            atomic_file::write_json(
                &path,
                &sanitize_settings(Value::Object(serde_json::Map::new()))?,
                true,
            )?;
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
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
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
