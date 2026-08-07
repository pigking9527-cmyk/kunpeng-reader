pub const SEM_VERSION: u32 = 2;
pub const SEM_CHUNK_PIPELINE_REVISION: u32 = 2;
pub const SHARD_MAX_CHUNKS: usize = 600_000;

const CHUNK_TARGET_MIN_CHARS: usize = 220;
const CHUNK_TARGET_MAX_CHARS: usize = 320;
const CHUNK_HARD_MAX_CHARS: usize = 450;
const CHUNK_OVERLAP_CHARS: usize = 60;

pub fn is_current_chunk_revision(revision: u32) -> bool {
    revision == SEM_CHUNK_PIPELINE_REVISION
}

pub fn index_ram_budget() -> u64 {
    crate::memory_budget::plan().semantic_graph_bytes
}

pub fn shard_est_bytes(chunks: usize, dim: usize) -> u64 {
    chunks as u64 * (dim as u64 * 4 + 400)
}

pub fn normalize(v: &mut [f32]) {
    let mut n = 0.0f32;
    for x in v.iter() {
        n += x * x;
    }
    let n = n.sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut s = 0.0f32;
    for i in 0..a.len().min(b.len()) {
        s += a[i] * b[i];
    }
    s
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut aa = 0.0;
    let mut bb = 0.0;
    let mut ab = 0.0;
    for i in 0..a.len().min(b.len()) {
        aa += a[i] * a[i];
        bb += b[i] * b[i];
        ab += a[i] * b[i];
    }
    if aa == 0.0 || bb == 0.0 {
        0.0
    } else {
        ab / (aa.sqrt() * bb.sqrt())
    }
}

#[derive(Clone, Debug)]
struct TextUnit {
    text: String,
    paragraph_end: bool,
}

fn char_count(value: &str) -> usize {
    value.chars().count()
}

fn is_sentence_end(chars: &[char], index: usize) -> bool {
    match chars[index] {
        '。' | '！' | '？' | '!' | '?' | '；' | ';' | '…' => true,
        // 小数、版本号和英文缩写内部的点不应被当成句末。
        '.' => {
            let previous = index.checked_sub(1).and_then(|at| chars.get(at));
            let next = chars.get(index + 1);
            !matches!((previous, next), (Some(a), Some(b)) if a.is_alphanumeric() && b.is_alphanumeric())
        }
        _ => false,
    }
}

fn is_sentence_tail(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '。' | '！'
                | '？'
                | '!'
                | '?'
                | '；'
                | ';'
                | '…'
                | '.'
                | '”'
                | '’'
                | '"'
                | '\''
                | ')'
                | '）'
                | ']'
                | '】'
                | '》'
                | '」'
                | '』'
        )
}

fn sentence_parts(paragraph: &str) -> Vec<String> {
    let chars: Vec<char> = paragraph.chars().collect();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut pending_end = false;
    for (index, ch) in chars.iter().copied().enumerate() {
        if pending_end && !is_sentence_tail(ch) {
            let value = current.trim();
            if !value.is_empty() {
                parts.push(value.to_string());
            }
            current.clear();
            pending_end = false;
        }
        current.push(ch);
        if is_sentence_end(&chars, index) {
            pending_end = true;
        }
    }
    let value = current.trim();
    if !value.is_empty() {
        parts.push(value.to_string());
    }
    parts
}

fn is_soft_split(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '，' | ',' | '、' | '：' | ':' | '；' | ';')
}

/// 极长的单句按 220—320 字之间最后一个次级标点切分；找不到时才在 320 字处
/// 兜底。这样任何输入都不会因为缺少句号而突破硬上限。
fn split_long_part(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= CHUNK_TARGET_MAX_CHARS {
        return vec![value.trim().to_string()];
    }
    let mut parts = Vec::new();
    let mut start = 0usize;
    while chars.len().saturating_sub(start) > CHUNK_TARGET_MAX_CHARS {
        let preferred_end = (start + CHUNK_TARGET_MAX_CHARS).min(chars.len());
        let soft_start = (start + CHUNK_TARGET_MIN_CHARS).min(preferred_end);
        let end = (soft_start..preferred_end)
            .rev()
            .find(|index| is_soft_split(chars[*index]))
            .map(|index| index + 1)
            .unwrap_or(preferred_end);
        let part: String = chars[start..end].iter().collect();
        let part = part.trim();
        if !part.is_empty() {
            parts.push(part.to_string());
        }
        start = end;
    }
    let tail: String = chars[start..].iter().collect();
    let tail = tail.trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn text_units(text: &str) -> Vec<TextUnit> {
    let paragraphs: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let mut units = Vec::new();
    for paragraph in paragraphs {
        let sentences = sentence_parts(paragraph);
        let sentence_count = sentences.len();
        for (sentence_index, sentence) in sentences.into_iter().enumerate() {
            let parts = split_long_part(&sentence);
            let part_count = parts.len();
            for (part_index, part) in parts.into_iter().enumerate() {
                units.push(TextUnit {
                    text: part,
                    paragraph_end: sentence_index + 1 == sentence_count
                        && part_index + 1 == part_count,
                });
            }
        }
    }
    // 某些旧全文索引把整个章节压成一行；句子拆分仍能提供稳定边界。
    if units.is_empty() {
        let value = text.trim();
        if !value.is_empty() {
            units.push(TextUnit {
                text: value.to_string(),
                paragraph_end: true,
            });
        }
    }
    units
}

fn suffix_chars(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    chars[chars.len().saturating_sub(limit)..].iter().collect()
}

fn separator(previous_paragraph_end: bool, left: &str, right: &str) -> &'static str {
    if previous_paragraph_end {
        "\n"
    } else if left.chars().last().is_some_and(char::is_alphanumeric)
        && right.chars().next().is_some_and(char::is_alphanumeric)
    {
        " "
    } else {
        ""
    }
}

/// 章节内结构优先的第二代切块：短段落按句子合并，220 字后优先在自然段末切，
/// 320 字后在句末切，450 字为硬上限；相邻块携带上一块末句最多 60 字的重叠。
pub fn chunk_text(text: &str) -> Vec<String> {
    let units = text_units(text);
    if units.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;
    let mut previous_paragraph_end = false;
    let mut last_unit = String::new();
    let mut has_new_content = false;

    for unit in units {
        let joiner = if current.is_empty() {
            ""
        } else {
            separator(previous_paragraph_end, &current, &unit.text)
        };
        let added_chars = char_count(joiner) + char_count(&unit.text);
        if !current.is_empty() && current_chars + added_chars > CHUNK_HARD_MAX_CHARS {
            if has_new_content {
                chunks.push(current.trim().to_string());
            }
            current = suffix_chars(&last_unit, CHUNK_OVERLAP_CHARS);
            current_chars = char_count(&current);
            previous_paragraph_end = false;
            if current_chars + char_count(&unit.text) > CHUNK_HARD_MAX_CHARS {
                current.clear();
                current_chars = 0;
            }
        }

        let joiner = if current.is_empty() {
            ""
        } else {
            separator(previous_paragraph_end, &current, &unit.text)
        };
        current.push_str(joiner);
        current.push_str(&unit.text);
        current_chars += char_count(joiner) + char_count(&unit.text);
        previous_paragraph_end = unit.paragraph_end;
        last_unit = unit.text;
        has_new_content = true;

        if current_chars >= CHUNK_TARGET_MIN_CHARS
            && (previous_paragraph_end || current_chars >= CHUNK_TARGET_MAX_CHARS)
        {
            chunks.push(current.trim().to_string());
            current = suffix_chars(&last_unit, CHUNK_OVERLAP_CHARS);
            current_chars = char_count(&current);
            previous_paragraph_end = false;
            has_new_content = false;
        }
    }
    if has_new_content {
        let value = current.trim();
        if !value.is_empty() {
            chunks.push(value.to_string());
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_zero_and_normalizes_nonzero_vector() {
        let mut zero = [0.0, 0.0];
        normalize(&mut zero);
        assert_eq!(zero, [0.0, 0.0]);

        let mut v = [3.0, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 0.0001);
        assert!((v[1] - 0.8).abs() < 0.0001);
    }

    #[test]
    fn dot_and_cosine_use_common_prefix_dimensions() {
        assert_eq!(dot(&[1.0, 2.0, 3.0], &[4.0, 5.0]), 14.0);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 0.0001);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn chunk_text_keeps_short_structural_text_and_splits_long_text() {
        assert_eq!(chunk_text("序章"), vec!["序章"]);
        let long = "这是一段足够长的句子，用来测试语义切块不会丢失有效内容。".repeat(30);
        let chunks = chunk_text(&long);
        assert!(chunks.len() >= 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= CHUNK_HARD_MAX_CHARS));
    }

    #[test]
    fn chunk_text_uses_newlines_as_boundaries_when_segment_is_long_enough() {
        let a = "第一段内容足够长，用来确认换行可以形成独立语义片段。".repeat(10);
        let b = "第二段内容也足够长，用来确认后续内容不会被前一段吞掉。".repeat(10);
        let chunks = chunk_text(&format!("{a}\n{b}"));
        assert!(chunks.len() >= 2);
        assert!(chunks.first().unwrap().contains("第一段内容"));
        assert!(chunks.last().unwrap().contains("第二段内容"));
    }

    #[test]
    fn chunk_text_merges_short_paragraphs_and_keeps_a_sentence_overlap() {
        let first = format!("{}第一段结束。", "甲".repeat(230));
        let second = format!("{}第二段结束。", "乙".repeat(230));
        let chunks = chunk_text(&format!("{first}\n{second}"));
        assert_eq!(chunks.len(), 2);
        let overlap = suffix_chars(&first, CHUNK_OVERLAP_CHARS);
        assert!(chunks[1].starts_with(&overlap));
        assert!(chunks[1].contains("第二段结束"));
    }

    #[test]
    fn chunk_text_does_not_split_decimal_points_as_sentence_boundaries() {
        let value = "版本 2.10 保留在同一句中，后面继续说明。".repeat(20);
        let chunks = chunk_text(&value);
        assert!(chunks.iter().all(|chunk| !chunk.contains("版本 2.\n")));
        assert!(chunks.iter().any(|chunk| chunk.contains("2.10")));
    }

    #[test]
    fn shard_estimate_scales_with_chunks_and_dimensions() {
        assert_eq!(shard_est_bytes(2, 3), 824);
        assert_eq!(
            index_ram_budget(),
            crate::memory_budget::plan().semantic_graph_bytes
        );
    }

    #[test]
    fn chunk_revision_two_invalidates_every_older_pipeline() {
        assert!(is_current_chunk_revision(SEM_CHUNK_PIPELINE_REVISION));
        assert!(!is_current_chunk_revision(1));
        assert!(!is_current_chunk_revision(0));
    }
}
