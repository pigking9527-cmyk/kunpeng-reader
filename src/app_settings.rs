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
const MAX_GESTURE_PROFILES: usize = 24;
const GESTURE_POINT_COUNT: usize = 48;
const READER_FONT_FAMILIES: &[&str] = &[
    "",
    "'Microsoft YaHei',sans-serif",
    "'SimSun',serif",
    "'SimHei',sans-serif",
    "'KaiTi',serif",
    "'Kunpeng LXGW WenKai Lite','Microsoft YaHei',sans-serif",
    "'Kunpeng Source Han Serif SC','SimSun',serif",
    "'Kunpeng Zhuque Fangsong','FangSong','SimSun',serif",
    "serif",
    "sans-serif",
];
const TOOLBAR_ITEM_IDS: &[&str] = &[
    "account", "search", "stats", "library", "news", "filter", "settings", "menu",
];
const TOOLBAR_CONTENT_IDS: &[&str] = &["icon", "text"];

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

fn normalized_toolbar_order(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut order = values
        .into_iter()
        .filter(|value| TOOLBAR_ITEM_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    if seen.insert("account".to_string()) {
        order.insert(0, "account".to_string());
    }
    for id in TOOLBAR_ITEM_IDS {
        if seen.insert((*id).to_string()) {
            order.push((*id).to_string());
        }
    }
    order
}

fn normalized_toolbar_hidden(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| value != "settings" && TOOLBAR_ITEM_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn normalized_toolbar_content_order(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut order = values
        .into_iter()
        .filter(|value| TOOLBAR_CONTENT_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    for id in TOOLBAR_CONTENT_IDS {
        if seen.insert((*id).to_string()) {
            order.push((*id).to_string());
        }
    }
    order
}

fn normalized_toolbar_content_visible(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let visible = values
        .into_iter()
        .filter(|value| TOOLBAR_CONTENT_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    if visible.is_empty() {
        vec!["icon".into()]
    } else {
        visible
    }
}

fn valid_gesture_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max_chars && !value.chars().any(char::is_control)
}

fn normalized_gesture_settings(value: Value) -> Option<Value> {
    let source = value.as_object()?;
    if source.get("version")?.as_u64()? != 1 {
        return None;
    }
    let enabled = source.get("enabled")?.as_bool()?;
    let global_precision = source.get("globalPrecision")?.as_str()?;
    if !matches!(
        global_precision,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
    ) {
        return None;
    }
    let hint = source.get("hintSettings")?.as_object()?;
    let hint_enabled = hint.get("enabled")?.as_bool()?;
    let hint_font_size = hint.get("fontSize")?.as_u64()?.clamp(12, 28);
    let hint_background_enabled = hint.get("backgroundEnabled")?.as_bool()?;
    let hint_background = hint.get("background")?.as_str()?.to_ascii_lowercase();
    if hint_background.len() != 7
        || !hint_background.starts_with('#')
        || !hint_background[1..]
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return None;
    }
    let hint_opacity = hint.get("opacity")?.as_u64()?.clamp(20, 100);
    let hint_position_x = hint.get("positionX")?.as_f64()?;
    let hint_position_y = hint.get("positionY")?.as_f64()?;
    if !hint_position_x.is_finite()
        || !hint_position_y.is_finite()
        || !(0.0..=1.0).contains(&hint_position_x)
        || !(0.0..=1.0).contains(&hint_position_y)
    {
        return None;
    }

    let source_profiles = source.get("profiles")?.as_array()?;
    if source_profiles.len() > MAX_GESTURE_PROFILES {
        return None;
    }
    let mut ids = HashSet::new();
    let mut profiles = Vec::with_capacity(source_profiles.len());
    for raw in source_profiles {
        let profile = raw.as_object()?;
        let id = profile.get("id")?.as_str()?.to_string();
        let name = profile.get("name")?.as_str()?.trim().to_string();
        if !valid_gesture_text(&id, 64) || !valid_gesture_text(&name, 24) || !ids.insert(id.clone())
        {
            return None;
        }
        let action = profile.get("action")?.as_str()?;
        if !matches!(
            action,
            "back" | "book_info" | "reopen_last" | "restore_jump"
        ) {
            return None;
        }
        let scope = profile.get("scope")?.as_str()?;
        if !matches!(scope, "auto" | "main" | "reader")
            || (action == "restore_jump" && scope != "reader")
        {
            return None;
        }
        if profile.get("input")?.as_str()? != "mouse-right" {
            return None;
        }
        let profile_enabled = profile.get("enabled")?.as_bool()?;
        let precision_mode = profile.get("precisionMode")?.as_str()?;
        if !matches!(precision_mode, "global" | "independent") {
            return None;
        }
        let precision = profile.get("precision")?.as_str()?;
        if !matches!(
            precision,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
        ) {
            return None;
        }
        let source_points = profile.get("points")?.as_array()?;
        if source_points.len() != GESTURE_POINT_COUNT {
            return None;
        }
        let mut points = Vec::with_capacity(GESTURE_POINT_COUNT);
        for point in source_points {
            let point = point.as_object()?;
            let x = point.get("x")?.as_f64()?;
            let y = point.get("y")?.as_f64()?;
            if !x.is_finite() || !y.is_finite() || x.abs() > 1.5 || y.abs() > 1.5 {
                return None;
            }
            points.push(json!({ "x": x, "y": y }));
        }
        let mut normalized_profile = profile.clone();
        normalized_profile.insert("id".into(), json!(id));
        normalized_profile.insert("name".into(), json!(name));
        normalized_profile.insert("scope".into(), json!(scope));
        normalized_profile.insert("action".into(), json!(action));
        normalized_profile.insert("input".into(), json!("mouse-right"));
        normalized_profile.insert("enabled".into(), json!(profile_enabled));
        normalized_profile.insert("points".into(), json!(points));
        normalized_profile.insert("precisionMode".into(), json!(precision_mode));
        normalized_profile.insert("precision".into(), json!(precision));
        profiles.push(Value::Object(normalized_profile));
    }
    let mut normalized_hint = hint.clone();
    normalized_hint.insert("enabled".into(), json!(hint_enabled));
    normalized_hint.insert("fontSize".into(), json!(hint_font_size));
    normalized_hint.insert("backgroundEnabled".into(), json!(hint_background_enabled));
    normalized_hint.insert("background".into(), json!(hint_background));
    normalized_hint.insert("opacity".into(), json!(hint_opacity));
    normalized_hint.insert("positionX".into(), json!(hint_position_x));
    normalized_hint.insert("positionY".into(), json!(hint_position_y));
    let mut normalized = source.clone();
    normalized.insert("version".into(), json!(1));
    normalized.insert("enabled".into(), json!(enabled));
    normalized.insert("globalPrecision".into(), json!(global_precision));
    normalized.insert("profiles".into(), json!(profiles));
    normalized.insert("hintSettings".into(), Value::Object(normalized_hint));
    Some(Value::Object(normalized))
}

fn normalized_reader_layout_settings(value: Value) -> Option<Value> {
    let source = value.as_object()?;
    if source.get("version")?.as_u64()? != 1 {
        return None;
    }
    let font_family = source.get("fontFamily")?.as_str()?;
    if !READER_FONT_FAMILIES.contains(&font_family) {
        return None;
    }
    let style_mode = source.get("styleMode")?.as_str()?;
    if !matches!(style_mode, "local" | "book") {
        return None;
    }
    let text_conversion = source.get("textConversion")?.as_str()?;
    if !matches!(text_conversion, "t2s" | "s2t") {
        return None;
    }
    let normalized_step = |key: &str, min: f64, max: f64, step: f64| -> Option<f64> {
        let value = source.get(key)?.as_f64()?;
        if !value.is_finite() {
            return None;
        }
        Some(((value.clamp(min, max) / step).round() * step * 10.0).round() / 10.0)
    };
    let font_size = source.get("fontSize")?.as_u64()?.clamp(12, 40);
    let note_font_size = source.get("noteFontSize")?.as_u64()?.clamp(10, 22);
    let line_height = normalized_step("lineHeight", 1.0, 2.6, 0.1)?;
    let para_spacing = normalized_step("paraSpacing", 0.0, 2.0, 0.1)?;
    let letter_spacing = normalized_step("letterSpacing", 0.0, 5.0, 0.5)?;
    let margin_top = source.get("marginTop")?.as_u64()?.clamp(0, 160);
    let margin_bottom = source.get("marginBottom")?.as_u64()?.clamp(0, 160);
    let margin_left = source.get("marginLeft")?.as_u64()?.clamp(0, 240);
    let margin_right = source.get("marginRight")?.as_u64()?.clamp(0, 240);
    let dual_page_gap = source.get("dualPageGap")?.as_u64()?.clamp(0, 120);
    let flow_mode = source.get("flowMode")?.as_str()?;
    if !matches!(flow_mode, "paged" | "scroll") {
        return None;
    }
    let mut page_mode = source.get("pageMode")?.as_str()?;
    if !matches!(page_mode, "single" | "dual") {
        return None;
    }
    if flow_mode == "scroll" {
        page_mode = "single";
    }
    let page_turn_effect = source.get("pageTurnEffect")?.as_str()?;
    if !matches!(page_turn_effect, "off" | "horizontal") {
        return None;
    }
    let page_turn_speed = normalized_step("pageTurnSpeed", 0.5, 2.0, 0.1)?;
    let image_pagination = source.get("imagePagination")?.as_str()?;
    if !matches!(image_pagination, "next-page" | "continuous") {
        return None;
    }
    let mut normalized = source.clone();
    normalized.insert("version".into(), json!(1));
    normalized.insert("fontFamily".into(), json!(font_family));
    normalized.insert("styleMode".into(), json!(style_mode));
    normalized.insert("textConversion".into(), json!(text_conversion));
    normalized.insert("fontSize".into(), json!(font_size));
    normalized.insert("noteFontSize".into(), json!(note_font_size));
    normalized.insert("lineHeight".into(), json!(line_height));
    normalized.insert("paraSpacing".into(), json!(para_spacing));
    normalized.insert("letterSpacing".into(), json!(letter_spacing));
    normalized.insert("marginTop".into(), json!(margin_top));
    normalized.insert("marginBottom".into(), json!(margin_bottom));
    normalized.insert("marginLeft".into(), json!(margin_left));
    normalized.insert("marginRight".into(), json!(margin_right));
    normalized.insert("dualPageGap".into(), json!(dual_page_gap));
    normalized.insert("pageMode".into(), json!(page_mode));
    normalized.insert("flowMode".into(), json!(flow_mode));
    normalized.insert("pageTurnEffect".into(), json!(page_turn_effect));
    normalized.insert("pageTurnSpeed".into(), json!(page_turn_speed));
    normalized.insert("imagePagination".into(), json!(image_pagination));
    Some(Value::Object(normalized))
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
    if let Some(size) = request.toolbar_icon_size_px.as_mut() {
        *size = (*size).clamp(28, 52);
    }
    if let Some(order) = request.toolbar_item_order.take() {
        request.toolbar_item_order = Some(normalized_toolbar_order(order));
    }
    if let Some(hidden) = request.toolbar_hidden_items.take() {
        request.toolbar_hidden_items = Some(normalized_toolbar_hidden(hidden));
    }
    if let Some(order) = request.toolbar_content_order.take() {
        request.toolbar_content_order = Some(normalized_toolbar_content_order(order));
    }
    if let Some(visible) = request.toolbar_content_visible.take() {
        request.toolbar_content_visible = Some(normalized_toolbar_content_visible(visible));
    }
    if let Some(settings) = request.gesture_settings.take() {
        request.gesture_settings = normalized_gesture_settings(settings);
    }
    if let Some(settings) = request.reader_layout_settings.take() {
        request.reader_layout_settings = normalized_reader_layout_settings(settings);
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
    if let Some(value) = request.toolbar_icon_size_px {
        settings.toolbar_icon_size_px = value;
    }
    if let Some(value) = request.toolbar_item_order {
        settings.toolbar_item_order = value;
    }
    if let Some(value) = request.toolbar_hidden_items {
        settings.toolbar_hidden_items = value;
    }
    if let Some(value) = request.toolbar_content_order {
        settings.toolbar_content_order = value;
    }
    if let Some(value) = request.toolbar_content_visible {
        settings.toolbar_content_visible = value;
    }
    if let Some(value) = request.gesture_settings {
        settings.gesture_settings = Some(value);
    }
    if let Some(value) = request.reader_layout_settings {
        settings.reader_layout_settings = Some(value);
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
                toolbar_hidden_items: Some(vec!["settings".into(), "stats".into(), "stats".into()]),
                toolbar_content_order: Some(vec!["text".into(), "text".into(), "unknown".into()]),
                toolbar_content_visible: Some(Vec::new()),
                ..Default::default()
            },
        );
        assert_eq!(payload["futureSetting"], "keep");
        assert_eq!(payload["toolbarIconSizePx"], 52);
        assert_eq!(
            payload["toolbarItemOrder"],
            json!(["account", "menu", "search", "stats", "library", "news", "filter", "settings"])
        );
        assert_eq!(payload["toolbarHiddenItems"], json!(["stats"]));
        assert_eq!(payload["toolbarContentOrder"], json!(["text", "icon"]));
        assert_eq!(payload["toolbarContentVisible"], json!(["icon"]));
    }

    #[test]
    fn gesture_settings_syncs_normalized_profiles_without_resetting_other_groups() {
        let points = (0..GESTURE_POINT_COUNT)
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
                    "profiles": [{
                        "id": "back-home",
                        "name": "返回主页",
                        "scope": "auto",
                        "action": "back",
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
        assert_eq!(
            payload["gestureSettings"]["profiles"][0]["points"]
                .as_array()
                .unwrap()
                .len(),
            GESTURE_POINT_COUNT
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
}
