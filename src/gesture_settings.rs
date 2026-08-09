//! Durable bridge for gesture profiles between the main and reader WebViews.
//!
//! On Windows they use different localhost origins, so browser localStorage is
//! intentionally isolated.  This small, bounded preference file is the shared
//! source used by a newly opened reader window.

use crate::atomic_file;
use serde_json::Value;
use std::path::PathBuf;

const MAX_SETTINGS_BYTES: usize = 96 * 1024;

fn settings_path() -> Option<PathBuf> {
    let mut path = dirs::config_dir().or_else(dirs::cache_dir)?;
    path.push("ebook-reader");
    path.push("gesture-settings-v1.json");
    Some(path)
}

#[tauri::command]
pub(crate) fn reader_gesture_settings_save(settings: Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(&settings).map_err(|error| format!("序列化手势设置失败：{error}"))?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("手势设置过大，未保存".to_string());
    }
    let path = settings_path().ok_or("无法确定手势设置路径")?;
    atomic_file::write(&path, &bytes)
}

#[tauri::command]
pub(crate) fn reader_gesture_settings_load() -> Result<Option<Value>, String> {
    let Some(path) = settings_path() else {
        return Ok(None);
    };
    let bytes = match std::fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取手势设置失败：{error}")),
    };
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("手势设置文件过大，已忽略".to_string());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("手势设置格式无效：{error}"))
}
