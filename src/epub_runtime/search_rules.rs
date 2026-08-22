const CONTEXT_CHARS: usize = 30;

/// Return bounded, character-safe snippets while preserving the reader's
/// historical ASCII-only case folding. Archive I/O and chapter ordering stay
/// in the EPUB runtime; this function is deliberately pure.
pub(super) fn find_snippets(text: &str, term: &str, limit: usize) -> Vec<String> {
    if limit == 0 || term.is_empty() {
        return Vec::new();
    }

    let text_chars: Vec<char> = text.chars().collect();
    let lowercase: Vec<char> = text_chars
        .iter()
        .map(|character| character.to_ascii_lowercase())
        .collect();
    let query: Vec<char> = term
        .chars()
        .map(|character| character.to_ascii_lowercase())
        .collect();
    if query.is_empty() || query.len() > lowercase.len() {
        return Vec::new();
    }

    let mut snippets = Vec::new();
    let mut index = 0usize;
    while index + query.len() <= lowercase.len() && snippets.len() < limit {
        if lowercase[index..index + query.len()] == query[..] {
            let start = index.saturating_sub(CONTEXT_CHARS);
            let end = (index + query.len() + CONTEXT_CHARS).min(text_chars.len());
            snippets.push(
                text_chars[start..end]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string(),
            );
            index += query.len();
        } else {
            index += 1;
        }
    }
    snippets
}

#[cfg(test)]
mod tests {
    use super::find_snippets;

    #[test]
    fn matches_ascii_case_without_splitting_unicode_context() {
        let text = format!("{}Rust阅读器{}RUST语言", "甲".repeat(35), "乙".repeat(35));
        let snippets = find_snippets(&text, "rust", 10);

        assert_eq!(snippets.len(), 2);
        assert!(snippets[0].contains("Rust阅读器"));
        assert!(snippets[1].contains("RUST语言"));
        assert!(snippets.iter().all(|snippet| snippet.chars().count() <= 64));
    }

    #[test]
    fn preserves_non_overlapping_matches_and_honours_the_limit() {
        assert_eq!(find_snippets("aaaa", "aa", 10).len(), 2);
        assert_eq!(find_snippets("a a a", "a", 2).len(), 2);
        assert!(find_snippets("a", "a", 0).is_empty());
        assert!(find_snippets("a", "", 10).is_empty());
    }
}
