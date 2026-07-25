//! Container parsing primitives shared by desktop and mobile hosts.
//!
//! Hosts own file picking, cover storage and DRM policy.  This module only
//! opens a supported container, extracts portable metadata and turns its
//! untrusted text into safe plain text for indexing and display metadata.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookMetadata {
    pub title: String,
    pub author: String,
    pub description: String,
    pub word_count: u64,
}

/// Strip untrusted markup before exposing book metadata to any platform UI.
///
/// The desktop renderer applies a stricter, renderer-specific allowlist to
/// chapter HTML.  This portable version is intentionally for metadata and
/// indexing text where no markup needs to survive.
pub fn html_to_plain_text(input: &str) -> String {
    if input.trim().is_empty() {
        return String::new();
    }
    let safe = ammonia::Builder::empty().clean(input).to_string();
    safe.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Count visible, non-whitespace characters in HTML-ish book content.
pub fn count_text_chars(html: &str) -> usize {
    let mut count = 0;
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag && !c.is_whitespace() => count += 1,
            _ => {}
        }
    }
    count
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

#[cfg(test)]
mod tests {
    use super::{count_text_chars, html_to_plain_text};

    #[test]
    fn metadata_text_is_plain_and_safe() {
        assert_eq!(
            html_to_plain_text("<p>甲&nbsp;<script>alert(1)</script>乙</p>"),
            "甲 乙"
        );
    }

    #[test]
    fn character_counter_ignores_markup_and_space() {
        assert_eq!(count_text_chars("<p>甲 乙</p>"), 2);
    }
}
