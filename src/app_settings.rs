//! Small, account-level software preferences shared by desktop platforms.
//!
//! Only explicitly allowlisted, non-sensitive fields belong here. The payload
//! preserves unknown fields so a newer desktop client is not damaged by an
//! older Windows, Linux, or macOS build writing its known settings.

use crate::{db::AppDb, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const APP_SETTINGS_KIND: &str = "app_settings_v1";
const DEFAULT_ID: &str = "default";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsSyncRequest {
    #[serde(default = "default_true")]
    show_reader_jump_back: bool,
    #[serde(default = "default_dismiss_mode")]
    reader_jump_back_dismiss_mode: String,
    #[serde(default = "default_dismiss_seconds")]
    reader_jump_back_dismiss_seconds: u16,
    #[serde(default = "default_dismiss_pages")]
    reader_jump_back_dismiss_pages: u8,
    #[serde(default = "default_size_level")]
    reader_jump_back_size_level: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsSyncSnapshot {
    exists: bool,
    show_reader_jump_back: bool,
    reader_jump_back_dismiss_mode: String,
    reader_jump_back_dismiss_seconds: u16,
    reader_jump_back_dismiss_pages: u8,
    reader_jump_back_size_level: u8,
}

fn default_true() -> bool {
    true
}
fn default_dismiss_mode() -> String {
    "pages".into()
}
fn default_dismiss_seconds() -> u16 {
    30
}
fn default_dismiss_pages() -> u8 {
    3
}
fn default_size_level() -> u8 {
    1
}

impl Default for AppSettingsSyncRequest {
    fn default() -> Self {
        Self {
            show_reader_jump_back: true,
            reader_jump_back_dismiss_mode: default_dismiss_mode(),
            reader_jump_back_dismiss_seconds: default_dismiss_seconds(),
            reader_jump_back_dismiss_pages: default_dismiss_pages(),
            reader_jump_back_size_level: default_size_level(),
        }
    }
}

fn normalize(mut request: AppSettingsSyncRequest) -> AppSettingsSyncRequest {
    request.reader_jump_back_dismiss_mode = if request.reader_jump_back_dismiss_mode == "time" {
        "time".into()
    } else {
        "pages".into()
    };
    request.reader_jump_back_dismiss_seconds =
        request.reader_jump_back_dismiss_seconds.clamp(1, 600);
    request.reader_jump_back_dismiss_pages = request.reader_jump_back_dismiss_pages.clamp(1, 100);
    request.reader_jump_back_size_level = request.reader_jump_back_size_level.clamp(1, 10);
    request
}

fn request_from_value(value: &Value) -> AppSettingsSyncRequest {
    normalize(serde_json::from_value(value.clone()).unwrap_or_default())
}

fn snapshot(value: Option<&Value>) -> AppSettingsSyncSnapshot {
    let settings = value.map(request_from_value).unwrap_or_default();
    AppSettingsSyncSnapshot {
        exists: value.is_some(),
        show_reader_jump_back: settings.show_reader_jump_back,
        reader_jump_back_dismiss_mode: settings.reader_jump_back_dismiss_mode,
        reader_jump_back_dismiss_seconds: settings.reader_jump_back_dismiss_seconds,
        reader_jump_back_dismiss_pages: settings.reader_jump_back_dismiss_pages,
        reader_jump_back_size_level: settings.reader_jump_back_size_level,
    }
}

fn merge_payload(existing: Option<Value>, request: AppSettingsSyncRequest) -> Value {
    let request = normalize(request);
    let mut payload = existing
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let object = payload
        .as_object_mut()
        .expect("object was normalized above");
    object.insert("version".into(), json!(1));
    object.insert(
        "showReaderJumpBack".into(),
        json!(request.show_reader_jump_back),
    );
    object.insert(
        "readerJumpBackDismissMode".into(),
        json!(request.reader_jump_back_dismiss_mode),
    );
    object.insert(
        "readerJumpBackDismissSeconds".into(),
        json!(request.reader_jump_back_dismiss_seconds),
    );
    object.insert(
        "readerJumpBackDismissPages".into(),
        json!(request.reader_jump_back_dismiss_pages),
    );
    object.insert(
        "readerJumpBackSizeLevel".into(),
        json!(request.reader_jump_back_size_level),
    );
    payload
}

fn entity(db: &AppDb) -> Result<Option<Value>, String> {
    db.entity_json(APP_SETTINGS_KIND, DEFAULT_ID)
}

#[tauri::command]
pub(crate) fn app_settings_sync_get(
    state: tauri::State<AppState>,
) -> Result<AppSettingsSyncSnapshot, String> {
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    let current = entity(db)?;
    Ok(snapshot(current.as_ref()))
}

#[tauri::command]
pub(crate) fn app_settings_sync_save(
    state: tauri::State<AppState>,
    request: AppSettingsSyncRequest,
) -> Result<AppSettingsSyncSnapshot, String> {
    let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
    let payload = merge_payload(entity(db)?, request);
    db.upsert_json_batch(&[(
        APP_SETTINGS_KIND.to_string(),
        DEFAULT_ID.to_string(),
        payload.clone(),
    )])?;
    Ok(snapshot(Some(&payload)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bounds_and_preserves_unknown_fields() {
        let payload = merge_payload(
            Some(json!({"version": 1, "futureSetting": "keep"})),
            AppSettingsSyncRequest {
                show_reader_jump_back: false,
                reader_jump_back_dismiss_mode: "unknown".into(),
                reader_jump_back_dismiss_seconds: 0,
                reader_jump_back_dismiss_pages: 255,
                reader_jump_back_size_level: 42,
            },
        );
        assert_eq!(payload["futureSetting"], "keep");
        assert_eq!(payload["readerJumpBackDismissMode"], "pages");
        assert_eq!(payload["readerJumpBackDismissSeconds"], 1);
        assert_eq!(payload["readerJumpBackDismissPages"], 100);
        assert_eq!(payload["readerJumpBackSizeLevel"], 10);
    }
}
