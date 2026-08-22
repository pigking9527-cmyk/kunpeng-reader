//! Plain-text helpers for portable book metadata and indexing.
//!
//! These functions deliberately do not know about EPUB or MOBI containers so
//! every host can use the same safe metadata representation.

/// Strip untrusted markup before exposing book metadata to any platform UI.
///
/// The desktop renderer applies a stricter, renderer-specific allowlist to
/// chapter HTML. This portable version is intentionally for metadata and
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
