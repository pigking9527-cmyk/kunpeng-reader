//! Canonical patch application for the allowlisted account settings payload.
//!
//! This boundary is intentionally free of Tauri, SQLite and app state. The
//! parent module owns persistence and unknown-field-preserving serialization;
//! this module only normalizes a request and applies it to the typed state.

use super::rules::{
    clipped_unique, normalized_gesture_settings, normalized_reader_layout_settings,
    normalized_toolbar_content_order, normalized_toolbar_content_visible,
    normalized_toolbar_hidden, normalized_toolbar_order, MAX_NEWS_SOURCES, MAX_TIEBA_BARS,
};
use super::{AppSettings, AppSettingsSyncRequest};
use std::collections::HashSet;

pub(super) fn normalize_patch(mut request: AppSettingsSyncRequest) -> AppSettingsSyncRequest {
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
    if let Some(size) = request.reader_jump_back_icon_size_px.as_mut() {
        *size = (*size).clamp(30, 160);
    }
    if let Some(position) = request.reader_jump_back_position_x.as_mut() {
        *position = (*position).clamp(0, 1000);
    }
    if let Some(position) = request.reader_jump_back_position_y.as_mut() {
        *position = (*position).clamp(0, 1000);
    }
    if let Some(engine) = request.epub_layout_engine.as_mut() {
        *engine = if engine == "modern" {
            "modern".into()
        } else {
            "legacy".into()
        };
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

pub(super) fn apply_patch(settings: &mut AppSettings, request: AppSettingsSyncRequest) {
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
    if let Some(value) = request.reader_jump_back_icon_size_px {
        settings.reader_jump_back_icon_size_px = value;
    }
    if let Some(value) = request.reader_jump_back_position_x {
        settings.reader_jump_back_position_x = value;
    }
    if let Some(value) = request.reader_jump_back_position_y {
        settings.reader_jump_back_position_y = value;
    }
    if let Some(value) = request.epub_layout_engine {
        settings.epub_layout_engine = value;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_tieba_bars_are_bounded_by_the_normalized_available_set() {
        let mut settings = AppSettings::default();
        apply_patch(
            &mut settings,
            AppSettingsSyncRequest {
                news_tieba_bars: Some(vec!["阅读吧".into(), "小说吧".into()]),
                news_enabled_tieba_bars: Some(vec![
                    "阅读".into(),
                    "不存在".into(),
                    "小说吧".into(),
                ]),
                ..Default::default()
            },
        );
        assert_eq!(settings.news_tieba_bars, ["阅读", "小说"]);
        assert_eq!(settings.news_enabled_tieba_bars, ["阅读", "小说"]);
    }

    #[test]
    fn invalid_modes_fall_back_without_touching_unpatched_groups() {
        let mut settings = AppSettings {
            library_long_context_enabled: true,
            ..Default::default()
        };
        apply_patch(
            &mut settings,
            AppSettingsSyncRequest {
                reader_jump_back_dismiss_mode: Some("future".into()),
                epub_layout_engine: Some("future".into()),
                library_answer_length: Some("future".into()),
                library_history_sync_mode: Some("future".into()),
                ..Default::default()
            },
        );
        assert_eq!(settings.reader_jump_back_dismiss_mode, "pages");
        assert_eq!(settings.epub_layout_engine, "legacy");
        assert_eq!(settings.library_answer_length, "short");
        assert_eq!(settings.library_history_sync_mode, "off");
        assert!(settings.library_long_context_enabled);
    }
}
