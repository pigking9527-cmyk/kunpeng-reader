use serde::{Deserialize, Serialize};

/// A durable position in logical source text, independent of page width,
/// font size, side panels and single/double-page layout.
///
/// `dom_path` is a stable path from the chapter root to the text-bearing DOM
/// node.  `text_offset` is an offset within that node.  The context strings
/// allow a renderer to recover after an EPUB producer changes harmless DOM
/// wrappers while retaining the surrounding text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReadingAnchor {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub dom_path: String,
    #[serde(default)]
    pub text_offset: u32,
    #[serde(default)]
    pub context_before: String,
    #[serde(default)]
    pub context_after: String,
    /// CSS pixels from the top of the visible reading viewport.  This is a
    /// visual refinement only; source text remains the authoritative anchor.
    #[serde(default)]
    pub viewport_offset: f32,
}

impl ReadingAnchor {
    pub fn normalized(mut self) -> Self {
        self.dom_path = self.dom_path.trim().to_string();
        self.context_before = trim_context(&self.context_before);
        self.context_after = trim_context(&self.context_after);
        if !self.viewport_offset.is_finite() {
            self.viewport_offset = 0.0;
        }
        self.viewport_offset = self.viewport_offset.clamp(-10_000.0, 10_000.0);
        self
    }

    pub fn is_usable(&self) -> bool {
        !self.dom_path.is_empty()
            || !self.context_before.is_empty()
            || !self.context_after.is_empty()
    }
}

fn trim_context(value: &str) -> String {
    const MAX_CONTEXT_CHARS: usize = 160;
    value.chars().take(MAX_CONTEXT_CHARS).collect()
}

/// The canonical saved reading position.  `fraction` is retained as a legacy
/// fallback for documents rendered by an older client; it is never the source
/// of truth once an anchor is available.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReadingPosition {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub anchor: Option<ReadingAnchor>,
    #[serde(default)]
    pub fraction: f32,
}

impl ReadingPosition {
    pub fn normalized(mut self) -> Self {
        self.fraction = if self.fraction.is_finite() {
            self.fraction.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.anchor = self.anchor.take().map(ReadingAnchor::normalized);
        if let Some(anchor) = &self.anchor {
            self.chapter = anchor.chapter;
        }
        self
    }

    pub fn authoritative_chapter(&self) -> u32 {
        self.anchor
            .as_ref()
            .map(|anchor| anchor.chapter)
            .unwrap_or(self.chapter)
    }

    pub fn has_text_anchor(&self) -> bool {
        self.anchor.as_ref().is_some_and(ReadingAnchor::is_usable)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TextRangeAnchor {
    #[serde(default)]
    pub start: Option<ReadingAnchor>,
    #[serde(default)]
    pub end: Option<ReadingAnchor>,
}

/// A bookmark keeps legacy fields for existing JSON/sync payloads and adds a
/// source-text position for all newly saved bookmarks.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub frac: f32,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub position: Option<ReadingPosition>,
}

impl Bookmark {
    pub fn effective_position(&self) -> ReadingPosition {
        self.position
            .clone()
            .unwrap_or(ReadingPosition {
                chapter: self.chapter,
                anchor: None,
                fraction: self.frac,
            })
            .normalized()
    }
}

/// A highlight or annotation.  The integer offsets remain compatible with
/// previous releases; the optional range anchor makes the selection resilient
/// to future layout changes and is used by new renderers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Highlight {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub start: u32,
    #[serde(default)]
    pub end: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub corrected_text: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub rects: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub range_anchor: Option<TextRangeAnchor>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProgressTimelineEntry {
    #[serde(default)]
    pub at: u64,
    #[serde(default)]
    pub progress: f32,
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub frac: f32,
    #[serde(default)]
    pub position: Option<ReadingPosition>,
}

/// Tags and booklists belong to the portable domain; UI-specific filtering and
/// dialogs live in a platform adapter.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookOrganization {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub booklists: Vec<String>,
}

impl BookOrganization {
    pub fn normalized(mut self) -> Self {
        self.tags = normalize_names(self.tags);
        self.booklists = normalize_names(self.booklists);
        self
    }
}

pub fn normalize_names(values: Vec<String>) -> Vec<String> {
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let value = value.trim().to_string();
            let key = value.to_lowercase();
            (!key.is_empty() && value.chars().count() <= 32 && seen.insert(key)).then_some(value)
        })
        .take(32)
        .collect()
}

/// Canonical comparison key for user-visible organization names.  Keep this
/// in the portable core so desktop and future mobile clients merge tags and
/// booklists under the same case-insensitive rule.
pub fn organization_name_key(value: &str) -> String {
    value.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchored_position_uses_anchor_chapter_and_clamps_visual_offset() {
        let position = ReadingPosition {
            chapter: 1,
            anchor: Some(ReadingAnchor {
                chapter: 7,
                dom_path: "0/3/1".into(),
                text_offset: 42,
                context_before: "a".repeat(300),
                context_after: String::new(),
                viewport_offset: f32::INFINITY,
            }),
            fraction: 2.0,
        }
        .normalized();
        assert_eq!(position.authoritative_chapter(), 7);
        assert!(position.has_text_anchor());
        assert_eq!(position.fraction, 1.0);
        assert_eq!(position.anchor.unwrap().context_before.chars().count(), 160);
    }

    #[test]
    fn organization_normalizes_case_insensitive_duplicates() {
        let value = BookOrganization {
            tags: vec![" 历史 ".into(), "历史".into(), "".into()],
            booklists: vec!["书单 A".into(), "书单 a".into()],
        }
        .normalized();
        assert_eq!(value.tags, vec!["历史"]);
        assert_eq!(value.booklists, vec!["书单 A"]);
    }
}
