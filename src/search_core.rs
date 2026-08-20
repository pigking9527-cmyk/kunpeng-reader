/// 只把 ASCII 大写转小写（多字节 UTF-8/中文保持原字节，长度不变 → 字节偏移仍有效）。
pub fn ascii_lower_bytes(s: &str) -> Vec<u8> {
    s.bytes().map(|b| b.to_ascii_lowercase()).collect()
}

const BLOOM_MIN_BYTES: usize = 16 * 1024;
const BLOOM_MAX_BYTES: usize = 1024 * 1024;
const BLOOM_SOURCE_BYTES_PER_FILTER_BYTE: usize = 16;

#[derive(Debug, Clone)]
pub struct BookSearchBloom {
    bits: Vec<u8>,
}

fn bloom_storage_bytes(source_bytes: usize) -> usize {
    source_bytes
        .div_ceil(BLOOM_SOURCE_BYTES_PER_FILTER_BYTE)
        .clamp(BLOOM_MIN_BYTES, BLOOM_MAX_BYTES)
}

fn normalized_search_char(ch: char) -> u32 {
    if ch.is_ascii_uppercase() {
        ch.to_ascii_lowercase() as u32
    } else {
        ch as u32
    }
}

fn bigram_hash(first: char, second: char) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for value in [
        normalized_search_char(first),
        normalized_search_char(second),
    ] {
        hash ^= value as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
        hash ^= (value as u64).rotate_left(17);
        hash = hash.wrapping_mul(0x9e37_79b1_85eb_ca87);
    }
    hash
}

impl BookSearchBloom {
    pub fn from_chapters(chapters: &[String]) -> Self {
        let source_bytes = chapters.iter().map(String::len).sum();
        let mut bloom = Self {
            bits: vec![0; bloom_storage_bytes(source_bytes)],
        };
        for chapter in chapters {
            let mut chars = chapter.chars();
            let Some(mut previous) = chars.next() else {
                continue;
            };
            for current in chars {
                bloom.insert_bigram(previous, current);
                previous = current;
            }
        }
        bloom
    }

    pub fn from_bits(bits: Vec<u8>) -> Option<Self> {
        if !(BLOOM_MIN_BYTES..=BLOOM_MAX_BYTES).contains(&bits.len()) {
            return None;
        }
        Some(Self { bits })
    }

    pub fn bits(&self) -> &[u8] {
        &self.bits
    }

    pub fn might_contain(&self, query: &str) -> bool {
        let mut chars = query.chars();
        let Some(mut previous) = chars.next() else {
            return true;
        };
        for current in chars {
            if !self.contains_bigram(previous, current) {
                return false;
            }
            previous = current;
        }
        true
    }

    fn positions(&self, first: char, second: char) -> (usize, usize) {
        let bit_count = self.bits.len() * 8;
        let hash = bigram_hash(first, second);
        let first = (hash % bit_count as u64) as usize;
        let mut second =
            ((hash.rotate_left(29) ^ 0x9e37_79b9_7f4a_7c15) % bit_count as u64) as usize;
        if second == first {
            second = (second + 1) % bit_count;
        }
        (first, second)
    }

    fn insert_bigram(&mut self, first: char, second: char) {
        let (first, second) = self.positions(first, second);
        for position in [first, second] {
            self.bits[position / 8] |= 1 << (position % 8);
        }
    }

    fn contains_bigram(&self, first: char, second: char) -> bool {
        let (first, second) = self.positions(first, second);
        [first, second]
            .into_iter()
            .all(|position| self.bits[position / 8] & (1 << (position % 8)) != 0)
    }
}
fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    let n = s.len();
    while i < n && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// 命中位置（字节偏移）前后取一段上下文；保持 UTF-8 边界安全。
pub fn snippet_at_with_context(text: &str, mb: usize, ml: usize, context: usize) -> String {
    let s = floor_char_boundary(text, mb.saturating_sub(context));
    let e = ceil_char_boundary(text, (mb + ml + context).min(text.len()));
    text[s..e].trim().to_string()
}

/// 命中位置（字节偏移）前后各取约 80 字节作为上下文片段；保持 UTF-8 边界安全。
#[cfg(test)]
pub fn snippet_at(text: &str, mb: usize, ml: usize) -> String {
    snippet_at_with_context(text, mb, ml, 80)
}

#[cfg(test)]
mod tests {
    use super::{
        ascii_lower_bytes, bloom_storage_bytes, snippet_at, snippet_at_with_context,
        BookSearchBloom, BLOOM_MAX_BYTES, BLOOM_MIN_BYTES,
    };

    #[test]
    fn ascii_lower_keeps_utf8_byte_shape() {
        let text = "A南B明";
        let lowered = ascii_lower_bytes(text);
        assert_eq!(lowered.len(), text.len());
        assert_eq!(String::from_utf8(lowered).unwrap(), "a南b明");
    }

    #[test]
    fn snippet_does_not_cut_multibyte_chars() {
        let text = "开头".repeat(60) + "南明史" + &"结尾".repeat(60);
        let mb = text.find("南明史").unwrap();
        let s = snippet_at(&text, mb + 1, "南明史".len());
        assert!(s.contains("南明史"));
        assert!(std::str::from_utf8(s.as_bytes()).is_ok());
    }

    #[test]
    fn long_context_snippet_keeps_more_cross_book_text() {
        let text = "前文".repeat(120) + "毛泽东" + &"后文".repeat(120);
        let mb = text.find("毛泽东").unwrap();
        let short = snippet_at(text.as_str(), mb, "毛泽东".len());
        let long = snippet_at_with_context(text.as_str(), mb, "毛泽东".len(), 260);
        assert!(long.contains("毛泽东"));
        assert!(long.len() > short.len());
        assert!(std::str::from_utf8(long.as_bytes()).is_ok());
    }
    #[test]
    fn bloom_never_rejects_real_substrings_and_normalizes_ascii_case() {
        let text = "中国文史哲大辞典 Rust Language 南明史".to_string();
        let bloom = BookSearchBloom::from_chapters(std::slice::from_ref(&text));
        let chars: Vec<char> = text.chars().collect();
        for width in 2..=8 {
            for window in chars.windows(width) {
                let query: String = window.iter().collect();
                assert!(bloom.might_contain(&query), "false negative: {query}");
            }
        }
        assert!(bloom.might_contain("RUST"));
        assert!(!bloom.might_contain("量子纠缠"));
    }

    #[test]
    fn bloom_storage_is_strictly_bounded() {
        assert_eq!(bloom_storage_bytes(0), BLOOM_MIN_BYTES);
        assert_eq!(bloom_storage_bytes(16 * 100_000), 100_000);
        assert_eq!(bloom_storage_bytes(usize::MAX), BLOOM_MAX_BYTES);
    }
}
