//! Serialized cache records for sanitized chapter HTML.
//!
//! EPUB archive access, HTML sanitizing, resource rewriting, virtual chapter
//! selection and the in-memory cache remain in the runtime orchestrator. This
//! module only owns the best-effort disk representation and version fallback.

use super::cache_paths::{chapter_cache_path, chapter_cache_path_for};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ProcessedChapterHtml {
    pub(super) head: String,
    pub(super) body: String,
}

pub(super) fn load(
    id: u64,
    mtime: u64,
    index: usize,
    compatible_versions: &[u32],
) -> Option<Arc<ProcessedChapterHtml>> {
    for version in compatible_versions {
        let Some(path) = chapter_cache_path_for(id, mtime, index, *version) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if let Ok(chapter) = serde_json::from_slice::<ProcessedChapterHtml>(&bytes) {
            return Some(Arc::new(chapter));
        }
    }
    None
}

pub(super) fn save(
    id: u64,
    mtime: u64,
    index: usize,
    current_version: u32,
    chapter: &ProcessedChapterHtml,
) {
    let Some(path) = chapter_cache_path(id, mtime, index, current_version) else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec(chapter) {
        let _ = std::fs::write(path, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_shape_remains_head_and_body() {
        let value = serde_json::to_value(ProcessedChapterHtml {
            head: "<style>p{color:black}</style>".to_string(),
            body: "<p>正文</p>".to_string(),
        })
        .unwrap();

        assert_eq!(value["head"], "<style>p{color:black}</style>");
        assert_eq!(value["body"], "<p>正文</p>");
        assert_eq!(value.as_object().map(serde_json::Map::len), Some(2));
    }
}
