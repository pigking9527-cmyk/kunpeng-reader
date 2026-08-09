//! Small, account-level software preferences shared by desktop platforms.
//!
//! Only explicitly allowlisted, non-sensitive fields belong here. The payload
//! preserves unknown fields so a newer desktop client is not damaged by an
//! older Windows, Linux, or macOS build writing its known settings.

use crate::{db::AppDb, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const APP_SETTINGS_KIND: &str = "app_settings_v1";
const DEFAULT_ID: &str = "default";
const MAX_NEWS_SOURCES: usize = 24;
const MAX_TIEBA_BARS: usize = 8;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsSyncRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    show_reader_jump_back: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_dismiss_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_dismiss_seconds: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_dismiss_pages: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_size_level: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_icon_size_px: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_position_x: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_position_y: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    news_source_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    news_tieba_bars: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    news_enabled_tieba_bars: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_answer_length: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_history_sync_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_answer_font_size: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_long_context_enabled: Option<bool>,
}

#[derive(Clone)]
struct AppSettings {
    show_reader_jump_back: bool,
    reader_jump_back_dismiss_mode: String,
    reader_jump_back_dismiss_seconds: u16,
    reader_jump_back_dismiss_pages: u8,
    reader_jump_back_size_level: u8,
    reader_jump_back_icon_size_px: u8,
    reader_jump_back_position_x: u16,
    reader_jump_back_position_y: u16,
    news_source_ids: Vec<String>,
    news_tieba_bars: Vec<String>,
    news_enabled_tieba_bars: Vec<String>,
    library_answer_length: String,
    library_history_sync_mode: String,
    library_answer_font_size: u8,
    library_long_context_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_reader_jump_back: true,
            reader_jump_back_dismiss_mode: "pages".into(),
            reader_jump_back_dismiss_seconds: 30,
            reader_jump_back_dismiss_pages: 3,
            reader_jump_back_size_level: 1,
            reader_jump_back_icon_size_px: 32,
            reader_jump_back_position_x: 950,
            reader_jump_back_position_y: 500,
            news_source_ids: Vec::new(),
            news_tieba_bars: Vec::new(),
            news_enabled_tieba_bars: Vec::new(),
            library_answer_length: "short".into(),
            library_history_sync_mode: "off".into(),
            library_answer_font_size: 16,
            library_long_context_enabled: false,
        }
    }
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
    reader_jump_back_icon_size_px: u8,
    reader_jump_back_position_x: u16,
    reader_jump_back_position_y: u16,
    has_news_source_settings: bool,
    news_source_ids: Vec<String>,
    news_tieba_bars: Vec<String>,
    news_enabled_tieba_bars: Vec<String>,
    has_library_answer_settings: bool,
    library_answer_length: String,
    library_history_sync_mode: String,
    library_answer_font_size: u8,
    library_long_context_enabled: bool,
}

fn clipped_unique(
    values: Vec<String>,
    limit: usize,
    max_len: usize,
    strip_tieba_suffix: bool,
) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| {
            let trimmed = value.trim();
            if strip_tieba_suffix {
                trimmed
                    .strip_suffix('吧')
                    .unwrap_or(trimmed)
                    .trim()
                    .to_string()
            } else {
                trimmed.to_string()
            }
        })
        .filter(|value| {
            !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
        })
        .filter(|value| seen.insert(value.clone()))
        .take(limit)
        .collect()
}

fn icon_size_px_from_legacy_level(level: u8) -> u8 {
    let level = level.clamp(1, 10) as u16;
    ((32 * (9 + (level - 1) * 4) + 4) / 9) as u8
}

fn legacy_level_from_icon_size_px(size: u8) -> u8 {
    let size = size.clamp(30, 160) as i16;
    (((size * 9 - 32 * 9 + 64) / (32 * 4)) + 1).clamp(1, 10) as u8
}

fn normalize_patch(mut request: AppSettingsSyncRequest) -> AppSettingsSyncRequest {
    if let Some(mode) = request.reader_jump_back_dismiss_mode.as_mut() {
        *mode = if mode == "time" {
            "time".into()
        } else {
            "pages".into()
        };
    }
    if let Some(seconds) = request.reader_jump_back_dismiss_seconds.as_mut() {
        *seconds = (*seconds).clamp(1, 600);
    }
    if let Some(pages) = request.reader_jump_back_dismiss_pages.as_mut() {
        *pages = (*pages).clamp(1, 100);
    }
    if let Some(size) = request.reader_jump_back_size_level.as_mut() {
        *size = (*size).clamp(1, 10);
    }
    if let Some(size) = request.reader_jump_back_icon_size_px.as_mut() {
        *size = (*size).clamp(30, 160);
    }
    if let Some(position) = request.reader_jump_back_position_x.as_mut() {
        *position = (*position).clamp(0, 1000);
    }
    if let Some(position) = request.reader_jump_back_position_y.as_mut() {
        *position = (*position).clamp(0, 1000);
    }
    if let Some(ids) = request.news_source_ids.take() {
        request.news_source_ids = Some(clipped_unique(ids, MAX_NEWS_SOURCES, 64, false));
    }
    if let Some(bars) = request.news_tieba_bars.take() {
        request.news_tieba_bars = Some(clipped_unique(bars, MAX_TIEBA_BARS, 48, true));
    }
    if let Some(enabled) = request.news_enabled_tieba_bars.take() {
        request.news_enabled_tieba_bars = Some(clipped_unique(enabled, MAX_TIEBA_BARS, 48, true));
    }
    if let Some(length) = request.library_answer_length.as_mut() {
        *length = match length.as_str() {
            "medium" => "medium".into(),
            "long" => "long".into(),
            _ => "short".into(),
        };
    }
    if let Some(mode) = request.library_history_sync_mode.as_mut() {
        *mode = match mode.as_str() {
            "recent" => "recent".into(),
            "manual" => "manual".into(),
            _ => "off".into(),
        };
    }
    if let Some(size) = request.library_answer_font_size.as_mut() {
        *size = (*size).clamp(14, 22);
    }
    request
}

fn apply_patch(settings: &mut AppSettings, request: AppSettingsSyncRequest) {
    let request = normalize_patch(request);
    if let Some(value) = request.show_reader_jump_back {
        settings.show_reader_jump_back = value;
    }
    if let Some(value) = request.reader_jump_back_dismiss_mode {
        settings.reader_jump_back_dismiss_mode = value;
    }
    if let Some(value) = request.reader_jump_back_dismiss_seconds {
        settings.reader_jump_back_dismiss_seconds = value;
    }
    if let Some(value) = request.reader_jump_back_dismiss_pages {
        settings.reader_jump_back_dismiss_pages = value;
    }
    let legacy_size_level = request.reader_jump_back_size_level;
    if let Some(value) = legacy_size_level {
        settings.reader_jump_back_size_level = value;
    }
    if let Some(value) = request.reader_jump_back_icon_size_px {
        settings.reader_jump_back_icon_size_px = value;
        settings.reader_jump_back_size_level = legacy_level_from_icon_size_px(value);
    } else if let Some(value) = legacy_size_level {
        settings.reader_jump_back_icon_size_px = icon_size_px_from_legacy_level(value);
    }
    if let Some(value) = request.reader_jump_back_position_x {
        settings.reader_jump_back_position_x = value;
    }
    if let Some(value) = request.reader_jump_back_position_y {
        settings.reader_jump_back_position_y = value;
    }
    if let Some(value) = request.news_source_ids {
        settings.news_source_ids = value;
    }
    if let Some(value) = request.news_tieba_bars {
        settings.news_tieba_bars = value;
    }
    if let Some(value) = request.news_enabled_tieba_bars {
        let available = settings
            .news_tieba_bars
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        settings.news_enabled_tieba_bars = value
            .into_iter()
            .filter(|name| available.contains(name))
            .collect();
    }
    if let Some(value) = request.library_answer_length {
        settings.library_answer_length = value;
    }
    if let Some(value) = request.library_history_sync_mode {
        settings.library_history_sync_mode = value;
    }
    if let Some(value) = request.library_answer_font_size {
        settings.library_answer_font_size = value;
    }
    if let Some(value) = request.library_long_context_enabled {
        settings.library_long_context_enabled = value;
    }
}

fn settings_from_value(value: &Value) -> AppSettings {
    let mut settings = AppSettings::default();
    if let Ok(request) = serde_json::from_value::<AppSettingsSyncRequest>(value.clone()) {
        apply_patch(&mut settings, request);
    }
    settings
}

fn has_any(payload: Option<&Value>, keys: &[&str]) -> bool {
    payload
        .and_then(Value::as_object)
        .is_some_and(|object| keys.iter().any(|key| object.contains_key(*key)))
}

fn snapshot(value: Option<&Value>) -> AppSettingsSyncSnapshot {
    let settings = value.map(settings_from_value).unwrap_or_default();
    AppSettingsSyncSnapshot {
        exists: value.is_some(),
        show_reader_jump_back: settings.show_reader_jump_back,
        reader_jump_back_dismiss_mode: settings.reader_jump_back_dismiss_mode,
        reader_jump_back_dismiss_seconds: settings.reader_jump_back_dismiss_seconds,
        reader_jump_back_dismiss_pages: settings.reader_jump_back_dismiss_pages,
        reader_jump_back_size_level: settings.reader_jump_back_size_level,
        reader_jump_back_icon_size_px: settings.reader_jump_back_icon_size_px,
        reader_jump_back_position_x: settings.reader_jump_back_position_x,
        reader_jump_back_position_y: settings.reader_jump_back_position_y,
        has_news_source_settings: has_any(
            value,
            &["newsSourceIds", "newsTiebaBars", "newsEnabledTiebaBars"],
        ),
        news_source_ids: settings.news_source_ids,
        news_tieba_bars: settings.news_tieba_bars,
        news_enabled_tieba_bars: settings.news_enabled_tieba_bars,
        has_library_answer_settings: has_any(
            value,
            &[
                "libraryAnswerLength",
                "libraryHistorySyncMode",
                "libraryAnswerFontSize",
                "libraryLongContextEnabled",
            ],
        ),
        library_answer_length: settings.library_answer_length,
        library_history_sync_mode: settings.library_history_sync_mode,
        library_answer_font_size: settings.library_answer_font_size,
        library_long_context_enabled: settings.library_long_context_enabled,
    }
}

fn merge_payload(existing: Option<Value>, request: AppSettingsSyncRequest) -> Value {
    let has_news_patch = request.news_source_ids.is_some()
        || request.news_tieba_bars.is_some()
        || request.news_enabled_tieba_bars.is_some();
    let has_library_patch = request.library_answer_length.is_some()
        || request.library_history_sync_mode.is_some()
        || request.library_answer_font_size.is_some()
        || request.library_long_context_enabled.is_some();
    let has_news_settings = has_any(
        existing.as_ref(),
        &["newsSourceIds", "newsTiebaBars", "newsEnabledTiebaBars"],
    ) || has_news_patch;
    let has_library_settings = has_any(
        existing.as_ref(),
        &[
            "libraryAnswerLength",
            "libraryHistorySyncMode",
            "libraryAnswerFontSize",
            "libraryLongContextEnabled",
        ],
    ) || has_library_patch;
    let mut settings = existing
        .as_ref()
        .map(settings_from_value)
        .unwrap_or_default();
    apply_patch(&mut settings, request);
    let mut payload = existing
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let object = payload
        .as_object_mut()
        .expect("object was normalized above");
    object.insert("version".into(), json!(1));
    object.insert(
        "showReaderJumpBack".into(),
        json!(settings.show_reader_jump_back),
    );
    object.insert(
        "readerJumpBackDismissMode".into(),
        json!(settings.reader_jump_back_dismiss_mode),
    );
    object.insert(
        "readerJumpBackDismissSeconds".into(),
        json!(settings.reader_jump_back_dismiss_seconds),
    );
    object.insert(
        "readerJumpBackDismissPages".into(),
        json!(settings.reader_jump_back_dismiss_pages),
    );
    object.insert(
        "readerJumpBackSizeLevel".into(),
        json!(settings.reader_jump_back_size_level),
    );
    object.insert(
        "readerJumpBackIconSizePx".into(),
        json!(settings.reader_jump_back_icon_size_px),
    );
    object.insert(
        "readerJumpBackPositionX".into(),
        json!(settings.reader_jump_back_position_x),
    );
    object.insert(
        "readerJumpBackPositionY".into(),
        json!(settings.reader_jump_back_position_y),
    );
    if has_news_settings {
        object.insert("newsSourceIds".into(), json!(settings.news_source_ids));
        object.insert("newsTiebaBars".into(), json!(settings.news_tieba_bars));
        object.insert(
            "newsEnabledTiebaBars".into(),
            json!(settings.news_enabled_tieba_bars),
        );
    }
    if has_library_settings {
        object.insert(
            "libraryAnswerLength".into(),
            json!(settings.library_answer_length),
        );
        object.insert(
            "libraryHistorySyncMode".into(),
            json!(settings.library_history_sync_mode),
        );
        object.insert(
            "libraryAnswerFontSize".into(),
            json!(settings.library_answer_font_size),
        );
        object.insert(
            "libraryLongContextEnabled".into(),
            json!(settings.library_long_context_enabled),
        );
    }
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
    fn patch_normalizes_bounds_and_preserves_unknown_fields() {
        let payload = merge_payload(
            Some(json!({"version": 1, "futureSetting": "keep"})),
            AppSettingsSyncRequest {
                reader_jump_back_dismiss_mode: Some("unknown".into()),
                reader_jump_back_dismiss_seconds: Some(0),
                reader_jump_back_dismiss_pages: Some(255),
                reader_jump_back_size_level: Some(42),
                reader_jump_back_icon_size_px: Some(u8::MAX),
                reader_jump_back_position_x: Some(u16::MAX),
                reader_jump_back_position_y: Some(u16::MAX),
                ..Default::default()
            },
        );
        assert_eq!(payload["futureSetting"], "keep");
        assert_eq!(payload["readerJumpBackDismissMode"], "pages");
        assert_eq!(payload["readerJumpBackDismissSeconds"], 1);
        assert_eq!(payload["readerJumpBackDismissPages"], 100);
        assert_eq!(payload["readerJumpBackSizeLevel"], 10);
        assert_eq!(payload["readerJumpBackIconSizePx"], 160);
        assert_eq!(payload["readerJumpBackPositionX"], 1000);
        assert_eq!(payload["readerJumpBackPositionY"], 1000);
    }

    #[test]
    fn legacy_icon_size_level_is_converted_to_pixels_and_kept_as_a_mirror() {
        let payload = merge_payload(
            Some(json!({
                "version": 1,
                "showReaderJumpBack": true,
                "readerJumpBackDismissMode": "pages",
                "readerJumpBackDismissSeconds": 30,
                "readerJumpBackDismissPages": 3,
                "readerJumpBackSizeLevel": 3
            })),
            AppSettingsSyncRequest {
                news_source_ids: Some(vec!["zhihu".into()]),
                ..Default::default()
            },
        );
        assert_eq!(payload["readerJumpBackIconSizePx"], 60);
        assert_eq!(payload["readerJumpBackSizeLevel"], 3);
    }

    #[test]
    fn partial_news_patch_does_not_reset_reader_or_library_settings() {
        let payload = merge_payload(
            Some(json!({
                "version": 1,
                "showReaderJumpBack": false,
                "readerJumpBackDismissMode": "time",
                "readerJumpBackDismissSeconds": 45,
                "readerJumpBackDismissPages": 6,
                "readerJumpBackSizeLevel": 4,
                "readerJumpBackIconSizePx": 60,
                "readerJumpBackPositionX": 880,
                "readerJumpBackPositionY": 360,
                "libraryAnswerLength": "long",
                "libraryHistorySyncMode": "manual",
                "libraryAnswerFontSize": 21,
                "libraryLongContextEnabled": true
            })),
            AppSettingsSyncRequest {
                news_source_ids: Some(vec!["zhihu".into(), "tieba".into()]),
                news_tieba_bars: Some(vec!["阅读吧".into(), "阅读吧".into()]),
                news_enabled_tieba_bars: Some(vec!["阅读".into()]),
                ..Default::default()
            },
        );
        assert_eq!(payload["showReaderJumpBack"], false);
        assert_eq!(payload["readerJumpBackDismissMode"], "time");
        assert_eq!(payload["readerJumpBackIconSizePx"], 60);
        assert_eq!(payload["readerJumpBackSizeLevel"], 3);
        assert_eq!(payload["readerJumpBackPositionX"], 880);
        assert_eq!(payload["readerJumpBackPositionY"], 360);
        assert_eq!(payload["libraryAnswerLength"], "long");
        assert_eq!(payload["newsTiebaBars"], json!(["阅读"]));
        assert_eq!(payload["newsEnabledTiebaBars"], json!(["阅读"]));
    }
}
