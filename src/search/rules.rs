const MAX_HITS: usize = 3000;
const MAX_PAGE_SIZE: usize = 50;

pub(super) fn metadata_match_score(
    folded_title: &str,
    folded_author: &str,
    folded_description: &str,
    folded_query: &str,
) -> u8 {
    if folded_title.contains(folded_query) {
        3
    } else if folded_description.contains(folded_query) {
        2
    } else if folded_author.contains(folded_query) {
        1
    } else {
        0
    }
}

pub(super) fn needs_ascii_case_fold(term: &str) -> bool {
    term.bytes().any(|byte| byte.is_ascii_alphabetic())
}

pub(super) fn hit_page_window(offset: usize, limit: usize) -> (usize, usize) {
    let offset = offset.min(MAX_HITS);
    let limit = limit
        .clamp(1, MAX_PAGE_SIZE)
        .min(MAX_HITS.saturating_sub(offset));
    (offset, limit)
}

pub(super) fn sha256_hex(sha256: &[u8; 32]) -> String {
    sha256.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 3);
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_match_priority_is_stable() {
        assert_eq!(metadata_match_score("query", "query", "query", "query"), 3);
        assert_eq!(metadata_match_score("title", "query", "query", "query"), 2);
        assert_eq!(
            metadata_match_score("title", "query", "summary", "query"),
            1
        );
        assert_eq!(
            metadata_match_score("title", "author", "summary", "query"),
            0
        );
    }

    #[test]
    fn ascii_letters_require_case_folding() {
        assert!(needs_ascii_case_fold("南明 Reader 17"));
        assert!(!needs_ascii_case_fold("南明 17"));
    }

    #[test]
    fn hit_page_window_preserves_existing_caps() {
        assert_eq!(hit_page_window(0, 0), (0, 1));
        assert_eq!(hit_page_window(20, 100), (20, 50));
        assert_eq!(hit_page_window(2990, 50), (2990, 10));
        assert_eq!(hit_page_window(usize::MAX, 50), (3000, 0));
    }

    #[test]
    fn sha256_hex_uses_lowercase_fixed_width_bytes() {
        let mut digest = [0u8; 32];
        digest[0] = 0x0a;
        digest[31] = 0xff;
        assert_eq!(sha256_hex(&digest), format!("0a{}ff", "00".repeat(30)));
    }

    #[test]
    fn percent_encode_escapes_unicode_and_spaces() {
        assert_eq!(percent_encode("南明 a"), "%E5%8D%97%E6%98%8E%20a");
        assert_eq!(percent_encode("a-z_1.~"), "a-z_1.~");
    }
}
