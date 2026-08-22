//! Container parsing primitives shared by desktop and mobile hosts.
//!
//! Hosts own file picking, cover storage and DRM policy.  This module only
//! opens a supported container, extracts portable metadata and turns its
//! untrusted text into safe plain text for indexing and display metadata.

use std::path::Path;

pub use crate::metadata_text::{count_text_chars, html_to_plain_text};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookMetadata {
    pub title: String,
    pub author: String,
    pub description: String,
    pub word_count: u64,
}

pub fn parse_epub_metadata(path: &Path, fallback_title: String) -> Option<ParsedBookMetadata> {
    let mut doc = epub::doc::EpubDoc::new(path).ok()?;
    let title = doc
        .mdata("title")
        .map(|m| m.value.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_title);
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_default();
    let description = doc
        .mdata("description")
        .map(|m| html_to_plain_text(&m.value))
        .unwrap_or_default();
    let spine: Vec<String> = doc.spine.iter().map(|item| item.idref.clone()).collect();
    let word_count = spine
        .iter()
        .filter_map(|idref| doc.get_resource_str(idref).map(|(html, _)| html))
        .map(|html| count_text_chars(&html) as u64)
        .sum();
    Some(ParsedBookMetadata {
        title,
        author,
        description,
        word_count,
    })
}

/// Parse MOBI/AZW metadata without allowing malformed books to unwind through
/// the host's library lock.  The `mobi` crate can panic on malformed/DRM files.
pub fn parse_mobi_metadata(path: &Path, fallback_title: String) -> Option<ParsedBookMetadata> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let book = mobi::Mobi::from_path(path).ok()?;
        let title = {
            let value = book.title();
            if value.trim().is_empty() {
                fallback_title
            } else {
                value
            }
        };
        Some(ParsedBookMetadata {
            title,
            author: book.author().unwrap_or_default(),
            description: html_to_plain_text(&book.description().unwrap_or_default()),
            word_count: count_text_chars(&book.content_as_string_lossy()) as u64,
        })
    }))
    .ok()
    .flatten()
}
