fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2A6DF
            | 0x2A700..=0x2B73F
            | 0x2B740..=0x2B81F
            | 0x2B820..=0x2CEAF
    )
}

/// 提取 ASCII 英数字词，返回 (小写词, 起始字节偏移, 字节长度)。
/// 只索引长度 >= 2 的词，避免 a/i 等噪声词撑爆索引。
pub fn ascii_terms(text: &str) -> Vec<(String, usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && !bytes[i].is_ascii_alphanumeric() {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
            i += 1;
        }
        if i > start + 1 {
            let term = text[start..i].to_ascii_lowercase();
            out.push((term, start, i - start));
        }
    }
    out
}

/// 只把 ASCII 大写转小写（多字节 UTF-8/中文保持原字节，长度不变 → 字节偏移仍有效）。
pub fn ascii_lower_bytes(s: &str) -> Vec<u8> {
    s.bytes().map(|b| b.to_ascii_lowercase()).collect()
}

/// 提取连续 CJK 文本的 2/3 字 ngram，返回 (ngram, 起始字节偏移, 字节长度)。
/// 这样中文查询可以走倒排索引，而不是每次全库扫描。
pub fn cjk_ngrams(text: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut run: Vec<(char, usize, usize)> = Vec::new();
    let flush = |run: &mut Vec<(char, usize, usize)>, out: &mut Vec<(String, usize, usize)>| {
        if run.len() < 2 {
            run.clear();
            return;
        }
        for n in 2..=3 {
            if run.len() < n {
                continue;
            }
            for win in run.windows(n) {
                let mut term = String::new();
                for (ch, _, _) in win {
                    term.push(*ch);
                }
                let start = win[0].1;
                let end = win[n - 1].2;
                out.push((term, start, end - start));
            }
        }
        run.clear();
    };
    for (idx, ch) in text.char_indices() {
        let end = idx + ch.len_utf8();
        if is_cjk(ch) {
            run.push((ch, idx, end));
        } else {
            flush(&mut run, &mut out);
        }
    }
    flush(&mut run, &mut out);
    out
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
pub fn snippet_at(text: &str, mb: usize, ml: usize) -> String {
    snippet_at_with_context(text, mb, ml, 80)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeywordPostingDraft {
    pub term: String,
    pub count: u32,
    pub snippets: Vec<String>,
}

/// 为单章文本生成倒排索引入库前的中间结果。调用方负责补 book_id/chapter 并写库。
pub fn keyword_postings_for_chapter(text: &str) -> Vec<KeywordPostingDraft> {
    let mut map: std::collections::HashMap<String, (u32, Vec<String>)> =
        std::collections::HashMap::new();
    for (term, pos, len) in ascii_terms(text).into_iter().chain(cjk_ngrams(text)) {
        let entry = map.entry(term).or_insert((0, Vec::new()));
        entry.0 = entry.0.saturating_add(1);
        if entry.1.len() < 6 {
            entry.1.push(snippet_at(text, pos, len));
        }
    }
    let mut out: Vec<KeywordPostingDraft> = map
        .into_iter()
        .map(|(term, (count, snippets))| KeywordPostingDraft {
            term,
            count,
            snippets,
        })
        .collect();
    out.sort_by(|a, b| a.term.cmp(&b.term));
    out
}

#[cfg(test)]
mod tests {
    use super::{
        ascii_lower_bytes, ascii_terms, cjk_ngrams, keyword_postings_for_chapter, snippet_at,
        snippet_at_with_context,
    };

    #[test]
    fn ascii_terms_extract_words_with_byte_offsets() {
        let terms = ascii_terms("Hi, ASP.NET Core 8 与 Rust2026!");
        assert_eq!(terms[0], ("hi".to_string(), 0, 2));
        assert_eq!(terms[1], ("asp".to_string(), 4, 3));
        assert_eq!(terms[2], ("net".to_string(), 8, 3));
        assert_eq!(terms[3], ("core".to_string(), 12, 4));
        assert_eq!(terms[4].0, "rust2026");
    }

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
    fn keyword_postings_count_terms_and_limit_snippets() {
        let text = "Rust rust RUST go a ".to_string() + &"term ".repeat(12);
        let postings = keyword_postings_for_chapter(&text);
        let rust = postings.iter().find(|p| p.term == "rust").unwrap();
        assert_eq!(rust.count, 3);
        assert_eq!(rust.snippets.len(), 3);
        let term = postings.iter().find(|p| p.term == "term").unwrap();
        assert_eq!(term.count, 12);
        assert_eq!(term.snippets.len(), 6);
        assert!(postings.iter().all(|p| p.term != "a"));
    }

    #[test]
    fn cjk_ngrams_extracts_bigrams_and_trigrams_with_offsets() {
        let text = "南明史，清史";
        let grams = cjk_ngrams(text);
        assert!(grams.iter().any(|g| g.0 == "南明"));
        assert!(grams.iter().any(|g| g.0 == "明史"));
        assert!(grams.iter().any(|g| g.0 == "南明史"));
        let nanming = grams.iter().find(|g| g.0 == "南明").unwrap();
        assert_eq!(&text[nanming.1..nanming.1 + nanming.2], "南明");
    }
}
