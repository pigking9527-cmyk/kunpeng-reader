//! Stateless validation and canonicalization for account-level setting groups.
//!
//! This module deliberately has no Tauri, SQLite, or app-state dependency.  The
//! parent module owns payload merging, protocol-v5 retirement, and persistence.

use serde_json::{json, Value};
use std::collections::HashSet;

// All currently shipped built-in sources fit below this defensive transport
// ceiling. The product does not impose a selectable-source limit.
pub(super) const MAX_NEWS_SOURCES: usize = 1024;
pub(super) const MAX_TIEBA_BARS: usize = 8;
const MAX_GESTURE_PROFILES: usize = 24;
pub(super) const GESTURE_POINT_COUNT: usize = 48;
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
pub(super) const TOOLBAR_ITEM_IDS: &[&str] = &[
    "account",
    "search",
    "stats",
    "library",
    "news",
    "intelligence-lab",
    "favorites",
    "filter",
    "settings",
    "menu",
];
pub(super) const TOOLBAR_CONTENT_IDS: &[&str] = &["icon", "text"];

pub(super) fn clipped_unique(
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

pub(super) fn normalized_toolbar_order(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut order = values
        .into_iter()
        .filter(|value| TOOLBAR_ITEM_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    let had_intelligence_lab = seen.contains("intelligence-lab");
    let had_favorites = seen.contains("favorites");
    if seen.insert("account".to_string()) {
        order.insert(0, "account".to_string());
    }
    for id in TOOLBAR_ITEM_IDS {
        if seen.insert((*id).to_string()) {
            order.push((*id).to_string());
        }
    }
    if !had_intelligence_lab {
        let current_index = order.iter().position(|value| value == "intelligence-lab");
        let news_index = order.iter().position(|value| value == "news");
        if let (Some(current_index), Some(news_index)) = (current_index, news_index) {
            if current_index != news_index + 1 {
                let item = order.remove(current_index);
                let insert_at = order
                    .iter()
                    .position(|value| value == "news")
                    .map_or(order.len(), |index| index + 1);
                order.insert(insert_at, item);
            }
        }
    }
    if !had_favorites {
        let current_index = order.iter().position(|value| value == "favorites");
        let intelligence_index = order.iter().position(|value| value == "intelligence-lab");
        if let (Some(current_index), Some(intelligence_index)) = (current_index, intelligence_index)
        {
            if current_index != intelligence_index + 1 {
                let item = order.remove(current_index);
                let insert_at = order
                    .iter()
                    .position(|value| value == "intelligence-lab")
                    .map_or(order.len(), |index| index + 1);
                order.insert(insert_at, item);
            }
        }
    }
    order
}

pub(super) fn normalized_toolbar_hidden(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| value != "settings" && TOOLBAR_ITEM_IDS.contains(&value.as_str()))
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub(super) fn normalized_toolbar_content_order(values: Vec<String>) -> Vec<String> {
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

pub(super) fn normalized_toolbar_content_visible(values: Vec<String>) -> Vec<String> {
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

pub(super) fn normalized_gesture_settings(value: Value) -> Option<Value> {
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
        let source_action = profile.get("action")?.as_str()?;
        // `undo_last` is the current cross-surface recovery action. Keep the
        // former names readable so an older desktop can still sync its saved
        // profile, but always write the current canonical action back.
        let action = match source_action {
            "back" | "book_info" => source_action,
            "undo_last" | "reopen_last" | "restore_jump" => "undo_last",
            _ => return None,
        };
        let scope = profile.get("scope")?.as_str()?;
        if !matches!(scope, "auto" | "main" | "reader")
            || (source_action == "restore_jump" && scope != "reader")
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
    // This marker is unrelated to the retired jump-back size. It retains the
    // established meaning of an intentional empty gesture list.
    if source
        .get("profilesInitialized")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        normalized.insert("profilesInitialized".into(), json!(true));
    } else {
        normalized.remove("profilesInitialized");
    }
    normalized.insert("hintSettings".into(), Value::Object(normalized_hint));
    Some(Value::Object(normalized))
}

pub(super) fn normalized_reader_layout_settings(value: Value) -> Option<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolbar_rules_complete_order_and_keep_settings_visible() {
        assert_eq!(
            normalized_toolbar_order(vec!["menu".into(), "search".into(), "search".into()]),
            vec![
                "account",
                "menu",
                "search",
                "stats",
                "library",
                "news",
                "intelligence-lab",
                "favorites",
                "filter",
                "settings"
            ]
        );
        assert_eq!(
            normalized_toolbar_hidden(vec![
                "settings".into(),
                "stats".into(),
                "intelligence-lab".into(),
                "stats".into(),
            ]),
            vec!["stats", "intelligence-lab"]
        );
        assert_eq!(
            normalized_toolbar_order(
                ["account", "search", "stats", "library", "news", "filter", "settings", "menu",]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            ),
            vec![
                "account",
                "search",
                "stats",
                "library",
                "news",
                "intelligence-lab",
                "favorites",
                "filter",
                "settings",
                "menu"
            ]
        );
        assert_eq!(normalized_toolbar_content_visible(Vec::new()), vec!["icon"]);
    }

    #[test]
    fn layout_rules_normalize_scroll_to_single_page_mode() {
        let input = json!({
            "version": 1,
            "fontFamily": "serif",
            "styleMode": "local",
            "textConversion": "t2s",
            "fontSize": 20,
            "noteFontSize": 15,
            "lineHeight": 1.8,
            "paraSpacing": 0.7,
            "letterSpacing": 0.5,
            "marginTop": 20,
            "marginBottom": 20,
            "marginLeft": 20,
            "marginRight": 20,
            "dualPageGap": 20,
            "pageMode": "dual",
            "flowMode": "scroll",
            "pageTurnEffect": "horizontal",
            "pageTurnSpeed": 1.0,
            "imagePagination": "next-page"
        });
        let normalized = normalized_reader_layout_settings(input).unwrap();
        assert_eq!(normalized["pageMode"], "single");
    }
}
