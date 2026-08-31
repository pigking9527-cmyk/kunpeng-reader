//! Small, account-level software preferences shared by desktop platforms.
//!
//! Only explicitly allowlisted, non-sensitive fields belong here. The payload
//! preserves unknown fields so a newer desktop client is not damaged by an
//! older Windows, Linux, or macOS build writing its known settings.

pub(crate) mod commands;
mod patch;
mod rules;

use crate::{db::AppDb, AppState};
use patch::{apply_patch, normalize_patch};
use rules::{TOOLBAR_CONTENT_IDS, TOOLBAR_ITEM_IDS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const APP_SETTINGS_KIND: &str = "app_settings_v1";
const DEFAULT_ID: &str = "default";

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
    reader_jump_back_icon_size_px: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_position_x: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_jump_back_position_y: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    epub_layout_engine: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toolbar_icon_size_px: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toolbar_item_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toolbar_hidden_items: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toolbar_content_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toolbar_content_visible: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gesture_settings: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reader_layout_settings: Option<Value>,
}

#[derive(Clone)]
struct AppSettings {
    show_reader_jump_back: bool,
    reader_jump_back_dismiss_mode: String,
    reader_jump_back_dismiss_seconds: u16,
    reader_jump_back_dismiss_pages: u8,
    reader_jump_back_icon_size_px: u8,
    reader_jump_back_position_x: u16,
    reader_jump_back_position_y: u16,
    epub_layout_engine: String,
    news_source_ids: Vec<String>,
    news_tieba_bars: Vec<String>,
    news_enabled_tieba_bars: Vec<String>,
    library_answer_length: String,
    library_history_sync_mode: String,
    library_answer_font_size: u8,
    library_long_context_enabled: bool,
    toolbar_icon_size_px: u8,
    toolbar_item_order: Vec<String>,
    toolbar_hidden_items: Vec<String>,
    toolbar_content_order: Vec<String>,
    toolbar_content_visible: Vec<String>,
    gesture_settings: Option<Value>,
    reader_layout_settings: Option<Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_reader_jump_back: true,
            reader_jump_back_dismiss_mode: "pages".into(),
            reader_jump_back_dismiss_seconds: 30,
            reader_jump_back_dismiss_pages: 3,
            reader_jump_back_icon_size_px: 32,
            reader_jump_back_position_x: 950,
            reader_jump_back_position_y: 500,
            epub_layout_engine: "legacy".into(),
            news_source_ids: Vec::new(),
            news_tieba_bars: Vec::new(),
            news_enabled_tieba_bars: Vec::new(),
            library_answer_length: "short".into(),
            library_history_sync_mode: "off".into(),
            library_answer_font_size: 16,
            library_long_context_enabled: false,
            toolbar_icon_size_px: 36,
            toolbar_item_order: TOOLBAR_ITEM_IDS
                .iter()
                .map(|id| (*id).to_string())
                .collect(),
            toolbar_hidden_items: Vec::new(),
            toolbar_content_order: TOOLBAR_CONTENT_IDS
                .iter()
                .map(|id| (*id).to_string())
                .collect(),
            toolbar_content_visible: vec!["icon".into()],
            gesture_settings: None,
            reader_layout_settings: None,
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
    reader_jump_back_icon_size_px: u8,
    reader_jump_back_position_x: u16,
    reader_jump_back_position_y: u16,
    epub_layout_engine: String,
    has_news_source_settings: bool,
    news_source_ids: Vec<String>,
    news_tieba_bars: Vec<String>,
    news_enabled_tieba_bars: Vec<String>,
    has_library_answer_settings: bool,
    library_answer_length: String,
    library_history_sync_mode: String,
    library_answer_font_size: u8,
    library_long_context_enabled: bool,
    has_toolbar_settings: bool,
    toolbar_icon_size_px: u8,
    toolbar_item_order: Vec<String>,
    toolbar_hidden_items: Vec<String>,
    toolbar_content_order: Vec<String>,
    toolbar_content_visible: Vec<String>,
    has_gesture_settings: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    gesture_settings: Option<Value>,
    has_reader_layout_settings: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reader_layout_settings: Option<Value>,
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
        reader_jump_back_icon_size_px: settings.reader_jump_back_icon_size_px,
        reader_jump_back_position_x: settings.reader_jump_back_position_x,
        reader_jump_back_position_y: settings.reader_jump_back_position_y,
        epub_layout_engine: settings.epub_layout_engine,
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
        has_toolbar_settings: has_any(
            value,
            &[
                "toolbarIconSizePx",
                "toolbarItemOrder",
                "toolbarHiddenItems",
                "toolbarContentOrder",
                "toolbarContentVisible",
            ],
        ),
        toolbar_icon_size_px: settings.toolbar_icon_size_px,
        toolbar_item_order: settings.toolbar_item_order,
        toolbar_hidden_items: settings.toolbar_hidden_items,
        toolbar_content_order: settings.toolbar_content_order,
        toolbar_content_visible: settings.toolbar_content_visible,
        has_gesture_settings: settings.gesture_settings.is_some(),
        gesture_settings: settings.gesture_settings,
        has_reader_layout_settings: settings.reader_layout_settings.is_some(),
        reader_layout_settings: settings.reader_layout_settings,
    }
}

fn merge_payload(existing: Option<Value>, request: AppSettingsSyncRequest) -> Value {
    let request = normalize_patch(request);
    let has_news_patch = request.news_source_ids.is_some()
        || request.news_tieba_bars.is_some()
        || request.news_enabled_tieba_bars.is_some();
    let has_library_patch = request.library_answer_length.is_some()
        || request.library_history_sync_mode.is_some()
        || request.library_answer_font_size.is_some()
        || request.library_long_context_enabled.is_some();
    let has_toolbar_patch = request.toolbar_icon_size_px.is_some()
        || request.toolbar_item_order.is_some()
        || request.toolbar_hidden_items.is_some()
        || request.toolbar_content_order.is_some()
        || request.toolbar_content_visible.is_some();
    let has_gesture_patch = request.gesture_settings.is_some();
    let has_reader_layout_patch = request.reader_layout_settings.is_some();
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
    let has_toolbar_settings = has_any(
        existing.as_ref(),
        &[
            "toolbarIconSizePx",
            "toolbarItemOrder",
            "toolbarHiddenItems",
            "toolbarContentOrder",
            "toolbarContentVisible",
        ],
    ) || has_toolbar_patch;
    let mut settings = existing
        .as_ref()
        .map(settings_from_value)
        .unwrap_or_default();
    apply_patch(&mut settings, request);
    let has_gesture_settings = settings.gesture_settings.is_some() || has_gesture_patch;
    let has_reader_layout_settings =
        settings.reader_layout_settings.is_some() || has_reader_layout_patch;
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
    // Protocol v5 intentionally discards the retired 1–10 level.  It must
    // not survive generic unknown-field preservation after any settings save.
    object.remove("readerJumpBackSizeLevel");
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
    object.insert(
        "epubLayoutEngine".into(),
        json!(settings.epub_layout_engine),
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
    if has_toolbar_settings {
        object.insert(
            "toolbarIconSizePx".into(),
            json!(settings.toolbar_icon_size_px),
        );
        object.insert(
            "toolbarItemOrder".into(),
            json!(settings.toolbar_item_order),
        );
        object.insert(
            "toolbarHiddenItems".into(),
            json!(settings.toolbar_hidden_items),
        );
        object.insert(
            "toolbarContentOrder".into(),
            json!(settings.toolbar_content_order),
        );
        object.insert(
            "toolbarContentVisible".into(),
            json!(settings.toolbar_content_visible),
        );
    }
    if has_gesture_settings {
        if let Some(gesture_settings) = settings.gesture_settings {
            object.insert("gestureSettings".into(), gesture_settings);
        }
    }
    if has_reader_layout_settings {
        if let Some(reader_layout_settings) = settings.reader_layout_settings {
            object.insert("readerLayoutSettings".into(), reader_layout_settings);
        }
    }
    payload
}

fn entity(db: &AppDb) -> Result<Option<Value>, String> {
    db.entity_json(APP_SETTINGS_KIND, DEFAULT_ID)
}

/// Applies the destructive v5 shape to a pre-v5 local entity before it can be
/// selected for upload.  The retired level is never converted: absent or
/// invalid pixel values reset to the v5 default of 32 px.
pub(crate) fn normalize_protocol_v5_entity(state: &AppState) -> Result<(), String> {
    state.with_db_write("app_settings_normalize_protocol_v5", |db| {
        let Some(current) = entity(db)? else {
            return Ok(());
        };
        let needs_normalization = current
            .as_object()
            .map(|object| {
                object.contains_key("readerJumpBackSizeLevel")
                    || !matches!(
                        object
                            .get("readerJumpBackIconSizePx")
                            .and_then(Value::as_u64),
                        Some(30..=160)
                    )
            })
            .unwrap_or(true);
        if !needs_normalization {
            return Ok(());
        }
        let payload = merge_payload(Some(current), AppSettingsSyncRequest::default());
        db.upsert_json_batch(&[(
            APP_SETTINGS_KIND.to_string(),
            DEFAULT_ID.to_string(),
            payload,
        )])
    })
}

fn app_settings_sync_get_inner(state: &AppState) -> Result<AppSettingsSyncSnapshot, String> {
    state.with_db_read("app_settings_sync_get", |db| {
        let current = entity(db)?;
        Ok(snapshot(current.as_ref()))
    })
}

fn app_settings_sync_save_inner(
    state: &AppState,
    request: AppSettingsSyncRequest,
) -> Result<AppSettingsSyncSnapshot, String> {
    state.with_db_write("app_settings_sync_save", |db| {
        let payload = merge_payload(entity(db)?, request);
        db.upsert_json_batch(&[(
            APP_SETTINGS_KIND.to_string(),
            DEFAULT_ID.to_string(),
            payload.clone(),
        )])?;
        Ok(snapshot(Some(&payload)))
    })
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
        assert_eq!(payload["readerJumpBackIconSizePx"], 160);
        assert_eq!(payload["readerJumpBackPositionX"], 1000);
        assert_eq!(payload["readerJumpBackPositionY"], 1000);
    }

    #[test]
    fn retired_icon_size_level_is_removed_on_the_next_settings_write() {
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
        assert_eq!(payload["readerJumpBackIconSizePx"], 32);
        assert!(payload.get("readerJumpBackSizeLevel").is_none());
    }

    #[test]
    fn v5_normalization_removes_the_retired_level_and_resets_missing_pixels() {
        let state = AppState::new(Some(AppDb::open_in_memory_for_tests()));
        state
            .with_db_write("seed_app_settings_v5_normalization", |db| {
                db.upsert_json_batch(&[(
                    APP_SETTINGS_KIND.to_string(),
                    DEFAULT_ID.to_string(),
                    json!({"version": 1, "readerJumpBackSizeLevel": 10}),
                )])
            })
            .unwrap();

        normalize_protocol_v5_entity(&state).unwrap();

        state
            .with_db_read("assert_app_settings_v5_normalization", |db| {
                let payload = entity(db)?.expect("settings entity");
                assert_eq!(payload["readerJumpBackIconSizePx"], 32);
                assert!(payload.get("readerJumpBackSizeLevel").is_none());
                Ok(())
            })
            .unwrap();
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
        assert!(payload.get("readerJumpBackSizeLevel").is_none());
        assert_eq!(payload["readerJumpBackPositionX"], 880);
        assert_eq!(payload["readerJumpBackPositionY"], 360);
        assert_eq!(payload["libraryAnswerLength"], "long");
        assert_eq!(payload["newsTiebaBars"], json!(["阅读"]));
        assert_eq!(payload["newsEnabledTiebaBars"], json!(["阅读"]));
    }

    #[test]
    fn toolbar_patch_clamps_size_locks_settings_visible_and_completes_order() {
        let payload = merge_payload(
            Some(json!({"version": 1, "futureSetting": "keep"})),
            AppSettingsSyncRequest {
                toolbar_icon_size_px: Some(u8::MAX),
                toolbar_item_order: Some(vec![
                    "menu".into(),
                    "search".into(),
                    "search".into(),
                    "not-a-toolbar-item".into(),
                ]),
                toolbar_hidden_items: Some(vec![
                    "settings".into(),
                    "stats".into(),
                    "intelligence-lab".into(),
                    "stats".into(),
                ]),
                toolbar_content_order: Some(vec!["text".into(), "text".into(), "unknown".into()]),
                toolbar_content_visible: Some(Vec::new()),
                ..Default::default()
            },
        );
        assert_eq!(payload["futureSetting"], "keep");
        assert_eq!(payload["toolbarIconSizePx"], 52);
        assert_eq!(
            payload["toolbarItemOrder"],
            json!([
                "account",
                "menu",
                "search",
                "stats",
                "library",
                "news",
                "intelligence-lab",
                "filter",
                "settings"
            ])
        );
        assert_eq!(
            payload["toolbarHiddenItems"],
            json!(["stats", "intelligence-lab"])
        );
        assert_eq!(payload["toolbarContentOrder"], json!(["text", "icon"]));
        assert_eq!(payload["toolbarContentVisible"], json!(["icon"]));
    }

    #[test]
    fn gesture_settings_syncs_normalized_profiles_without_resetting_other_groups() {
        let points = (0..rules::GESTURE_POINT_COUNT)
            .map(|index| json!({ "x": index as f64 / 100.0, "y": 0.0 }))
            .collect::<Vec<_>>();
        let payload = merge_payload(
            Some(json!({
                "version": 1,
                "futureDesktopSetting": "keep",
                "libraryAnswerLength": "long"
            })),
            AppSettingsSyncRequest {
                gesture_settings: Some(json!({
                    "version": 1,
                    "enabled": true,
                    "globalPrecision": "7",
                    "profilesInitialized": true,
                    "profiles": [{
                        "id": "back-home",
                        "name": "返回主页",
                        "scope": "auto",
                        "action": "undo_last",
                        "input": "mouse-right",
                        "enabled": true,
                        "points": points,
                        "precisionMode": "global",
                        "precision": "5",
                        "futureProfileSetting": "keep"
                    }],
                    "hintSettings": {
                        "enabled": true,
                        "fontSize": 99,
                        "backgroundEnabled": true,
                        "background": "#173B6B",
                        "opacity": 1,
                        "positionX": 1.0,
                        "positionY": 0.0,
                        "futureHintSetting": "keep"
                    },
                    "futureGestureSetting": "keep"
                })),
                ..Default::default()
            },
        );
        assert_eq!(payload["futureDesktopSetting"], "keep");
        assert_eq!(payload["libraryAnswerLength"], "long");
        assert_eq!(payload["gestureSettings"]["version"], 1);
        assert_eq!(payload["gestureSettings"]["globalPrecision"], "7");
        assert_eq!(payload["gestureSettings"]["profilesInitialized"], true);
        assert_eq!(
            payload["gestureSettings"]["profiles"][0]["points"]
                .as_array()
                .unwrap()
                .len(),
            rules::GESTURE_POINT_COUNT
        );
        assert_eq!(
            payload["gestureSettings"]["profiles"][0]["action"],
            "undo_last"
        );
        assert_eq!(
            payload["gestureSettings"]["profiles"][0]["futureProfileSetting"],
            "keep"
        );
        assert_eq!(payload["gestureSettings"]["hintSettings"]["fontSize"], 28);
        assert_eq!(payload["gestureSettings"]["hintSettings"]["opacity"], 20);
        assert_eq!(
            payload["gestureSettings"]["hintSettings"]["background"],
            "#173b6b"
        );
        assert_eq!(payload["gestureSettings"]["futureGestureSetting"], "keep");
        let snapshot = snapshot(Some(&payload));
        assert!(snapshot.has_gesture_settings);
        assert_eq!(
            snapshot.gesture_settings.unwrap()["profiles"][0]["name"],
            "返回主页"
        );
    }

    #[test]
    fn legacy_gesture_recovery_actions_are_readable_and_canonicalized() {
        let points = (0..rules::GESTURE_POINT_COUNT)
            .map(|index| json!({ "x": index as f64 / 100.0, "y": 0.0 }))
            .collect::<Vec<_>>();
        let normalized = rules::normalized_gesture_settings(json!({
            "version": 1,
            "enabled": true,
            "globalPrecision": "5",
            "profilesInitialized": true,
            "profiles": [
                {
                    "id": "legacy-reopen",
                    "name": "恢复页面",
                    "scope": "main",
                    "action": "reopen_last",
                    "input": "mouse-right",
                    "enabled": true,
                    "points": points.clone(),
                    "precisionMode": "global",
                    "precision": "5"
                },
                {
                    "id": "legacy-reader-jump",
                    "name": "恢复跳转",
                    "scope": "reader",
                    "action": "restore_jump",
                    "input": "mouse-right",
                    "enabled": true,
                    "points": points,
                    "precisionMode": "global",
                    "precision": "5"
                }
            ],
            "hintSettings": {
                "enabled": false,
                "fontSize": 16,
                "backgroundEnabled": true,
                "background": "#173b6b",
                "opacity": 88,
                "positionX": 1.0,
                "positionY": 0.0
            }
        }))
        .expect("legacy recovery gesture settings remain valid");
        assert_eq!(normalized["profiles"][0]["action"], "undo_last");
        assert_eq!(normalized["profiles"][1]["action"], "undo_last");
    }

    #[test]
    fn reader_layout_settings_clamp_values_and_keep_other_setting_groups() {
        let payload = merge_payload(
            Some(json!({
                "version": 1,
                "futureDesktopSetting": "keep",
                "gestureSettings": { "version": 1, "enabled": false, "globalPrecision": "5", "profiles": [], "hintSettings": { "enabled": false, "fontSize": 16, "backgroundEnabled": true, "background": "#173b6b", "opacity": 88, "positionX": 1.0, "positionY": 0.0 } }
            })),
            AppSettingsSyncRequest {
                reader_layout_settings: Some(json!({
                    "version": 1,
                    "fontFamily": "'SimSun',serif",
                    "styleMode": "local",
                    "textConversion": "s2t",
                    "fontSize": 99,
                    "noteFontSize": 1,
                    "lineHeight": 3.0,
                    "paraSpacing": 0.74,
                    "letterSpacing": 0.74,
                    "marginTop": 999,
                    "marginBottom": 999,
                    "marginLeft": 999,
                    "marginRight": 999,
                    "dualPageGap": 999,
                    "pageMode": "dual",
                    "flowMode": "scroll",
                    "pageTurnEffect": "horizontal",
                    "pageTurnSpeed": 0.54,
                    "imagePagination": "continuous",
                    "futureLayoutSetting": "keep"
                })),
                ..Default::default()
            },
        );
        assert_eq!(payload["futureDesktopSetting"], "keep");
        assert_eq!(payload["gestureSettings"]["version"], 1);
        let layout = &payload["readerLayoutSettings"];
        assert_eq!(layout["fontSize"], 40);
        assert_eq!(layout["noteFontSize"], 10);
        assert_eq!(layout["lineHeight"], 2.6);
        assert_eq!(layout["paraSpacing"], 0.7);
        assert_eq!(layout["letterSpacing"], 0.5);
        assert_eq!(layout["marginTop"], 160);
        assert_eq!(layout["marginLeft"], 240);
        assert_eq!(layout["dualPageGap"], 120);
        assert_eq!(layout["pageMode"], "single");
        assert_eq!(layout["pageTurnSpeed"], 0.5);
        assert_eq!(layout["futureLayoutSetting"], "keep");
        let snapshot = snapshot(Some(&payload));
        assert!(snapshot.has_reader_layout_settings);
        assert_eq!(
            snapshot.reader_layout_settings.unwrap()["textConversion"],
            "s2t"
        );
    }

    #[test]
    fn epub_layout_engine_defaults_to_legacy_and_preserves_unknown_fields() {
        let legacy = snapshot(Some(&json!({
            "version": 1,
            "showReaderJumpBack": true,
            "futureDesktopSetting": "keep"
        })));
        assert_eq!(legacy.epub_layout_engine, "legacy");

        let payload = merge_payload(
            Some(json!({"version": 1, "futureDesktopSetting": "keep"})),
            AppSettingsSyncRequest {
                epub_layout_engine: Some("modern".into()),
                ..Default::default()
            },
        );
        assert_eq!(payload["epubLayoutEngine"], "modern");
        assert_eq!(payload["futureDesktopSetting"], "keep");

        let invalid = merge_payload(
            Some(payload),
            AppSettingsSyncRequest {
                epub_layout_engine: Some("future-engine".into()),
                ..Default::default()
            },
        );
        assert_eq!(invalid["epubLayoutEngine"], "legacy");
    }
}
