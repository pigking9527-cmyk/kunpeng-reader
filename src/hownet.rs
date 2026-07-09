use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::OnceLock;

const HOWNET_GZ: &[u8] = include_bytes!("dict/hownet.tsv.gz");

#[derive(Clone, Debug)]
struct SenseRow {
    word: String,
    pos: String,
    def: String,
    examples: String,
    sememes: Vec<String>,
}

#[derive(Default)]
struct HowNetStore {
    by_word: HashMap<String, Vec<usize>>,
    by_sememe: HashMap<String, Vec<usize>>,
    rows: Vec<SenseRow>,
    antonym_sememes: HashMap<String, Vec<String>>,
    hypernym_sememes: HashMap<String, Vec<String>>,
}

#[derive(Clone, Serialize, Default)]
pub struct HowNetEnhancement {
    pub plain: String,
    pub sense: String,
    pub confidence: f32,
    pub synonyms: Vec<String>,
    pub antonyms: Vec<String>,
    pub hypernyms: Vec<String>,
    pub example_note: String,
}

static STORE: OnceLock<HowNetStore> = OnceLock::new();

fn gunzip(data: &[u8]) -> String {
    let mut s = String::new();
    let _ = flate2::read::GzDecoder::new(data).read_to_string(&mut s);
    s
}

fn store() -> &'static HowNetStore {
    STORE.get_or_init(|| {
        let text = gunzip(HOWNET_GZ);
        let mut rows = Vec::new();
        let mut by_word: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_sememe: HashMap<String, Vec<usize>> = HashMap::new();
        let mut antonym_sememes: HashMap<String, Vec<String>> = HashMap::new();
        let mut hypernym_sememes: HashMap<String, Vec<String>> = HashMap::new();

        for line in text.lines() {
            if line.trim().is_empty() || line.starts_with('#') {
                continue;
            }
            let mut it = line.splitn(7, '\t');
            let kind = it.next().unwrap_or("");
            if kind == "S" {
                let word = it.next().unwrap_or("").trim();
                if word.is_empty() {
                    continue;
                }
                let pos = it.next().unwrap_or("").trim().to_string();
                let def = it.next().unwrap_or("").trim().to_string();
                let examples = it.next().unwrap_or("").trim().to_string();
                let sememes: Vec<String> = it
                    .next()
                    .unwrap_or("")
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                let idx = rows.len();
                rows.push(SenseRow {
                    word: word.to_string(),
                    pos,
                    def,
                    examples,
                    sememes: sememes.clone(),
                });
                by_word.entry(word.to_string()).or_default().push(idx);
                for s in sememes {
                    by_sememe.entry(s).or_default().push(idx);
                }
            } else if kind == "R" {
                let head = it.next().unwrap_or("").trim().to_string();
                let rel = it.next().unwrap_or("").trim();
                let tail = it.next().unwrap_or("").trim().to_string();
                if head.is_empty() || tail.is_empty() {
                    continue;
                }
                match rel {
                    "antonym" => antonym_sememes.entry(head).or_default().push(tail),
                    "hypernym" => hypernym_sememes.entry(head).or_default().push(tail),
                    "hyponym" => hypernym_sememes.entry(tail).or_default().push(head),
                    _ => {}
                }
            }
        }

        HowNetStore {
            by_word,
            by_sememe,
            rows,
            antonym_sememes,
            hypernym_sememes,
        }
    })
}

fn cjk_terms(s: &str) -> HashSet<String> {
    let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = HashSet::new();
    for n in 1..=4 {
        if chars.len() < n {
            continue;
        }
        for win in chars.windows(n) {
            out.insert(win.iter().collect::<String>());
        }
    }
    out
}

fn score_sense(row: &SenseRow, context: &str, context_terms: &HashSet<String>) -> i32 {
    let mut score = 0;
    for s in &row.sememes {
        if context.contains(s) {
            score += 6;
        }
        if context_terms.contains(s) {
            score += 4;
        }
    }
    for ex in row.examples.split(['，', '。', '；', ';', ',', '~']) {
        let ex = ex.trim();
        if ex.len() >= 2 && context.contains(ex) {
            score += 3;
        }
    }
    if !row.examples.is_empty() {
        for term in cjk_terms(&row.examples) {
            if term.len() >= 2 && context_terms.contains(&term) {
                score += 1;
            }
        }
    }
    score
}

fn dedup_push(out: &mut Vec<String>, value: &str, self_word: &str, limit: usize) {
    let value = value.trim();
    if value.is_empty() || value == self_word || out.iter().any(|v| v == value) {
        return;
    }
    out.push(value.to_string());
    if out.len() > limit {
        out.truncate(limit);
    }
}

fn words_for_sememes(
    st: &HowNetStore,
    sememes: &[String],
    self_word: &str,
    limit: usize,
) -> Vec<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for sem in sememes {
        if let Some(ids) = st.by_sememe.get(sem) {
            for &idx in ids.iter().take(220) {
                let w = st.rows[idx].word.as_str();
                if w != self_word {
                    *counts.entry(w).or_insert(0) += 1;
                }
            }
        }
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.len().cmp(&b.0.len())));
    let mut out = Vec::new();
    for (w, _) in ranked {
        dedup_push(&mut out, w, self_word, limit);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn relation_words(
    st: &HowNetStore,
    sememes: &[String],
    rel_map: &HashMap<String, Vec<String>>,
    self_word: &str,
    limit: usize,
) -> Vec<String> {
    let mut target_sememes = Vec::new();
    for sem in sememes {
        if let Some(items) = rel_map.get(sem) {
            for item in items {
                if !target_sememes.iter().any(|x| x == item) {
                    target_sememes.push(item.clone());
                }
            }
        }
    }
    words_for_sememes(st, &target_sememes, self_word, limit)
}

fn sememe_zh(s: &str) -> &str {
    s.split('|').nth(1).unwrap_or(s).trim()
}

fn pos_zh(pos: &str) -> &str {
    match pos {
        "verb" | "v" => "动作",
        "noun" | "n" => "事物",
        "adj" | "adjective" => "性质",
        "adv" | "adverb" => "状态",
        "time" => "时间",
        "place" => "地点",
        _ => "含义",
    }
}

fn plain_text(row: &SenseRow) -> String {
    let core: Vec<&str> = row.sememes.iter().take(3).map(|s| sememe_zh(s)).collect();
    if core.is_empty() {
        return String::new();
    }
    format!(
        "更白话地说，这里把“{}”理解成一种{}，核心意思接近：{}。",
        row.word,
        pos_zh(&row.pos),
        core.join("、")
    )
}

fn example_note(row: &SenseRow, context: &str) -> String {
    let example = row
        .examples
        .split(['，', '。', '；', ';'])
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("");
    if context.trim().is_empty() {
        if example.is_empty() {
            return String::new();
        }
        return format!("可以把例句“{}”理解为这个义项的用法。", example.replace('~', &row.word));
    }
    let sememes: Vec<&str> = row.sememes.iter().take(2).map(|s| sememe_zh(s)).collect();
    if sememes.is_empty() {
        format!("在当前句子里，“{}”更可能取这个义项。", row.word)
    } else {
        format!(
            "结合当前句子，“{}”更可能围绕“{}”来理解。",
            row.word,
            sememes.join("、")
        )
    }
}

pub fn enhance(word: &str, context: &str) -> Option<HowNetEnhancement> {
    let st = store();
    let ids = st.by_word.get(word)?;
    if ids.is_empty() {
        return None;
    }
    let terms = cjk_terms(context);
    let mut scored: Vec<(usize, i32)> = ids
        .iter()
        .map(|&idx| (idx, score_sense(&st.rows[idx], context, &terms)))
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    let (best_idx, best_score) = scored[0];
    let row = &st.rows[best_idx];
    let confidence = if context.trim().is_empty() {
        0.35
    } else {
        (0.45 + (best_score.max(0) as f32 / 24.0)).min(0.92)
    };
    let sememe_names: Vec<String> = row.sememes.iter().take(5).map(|s| sememe_zh(s).to_string()).collect();
    let synonyms = words_for_sememes(st, &row.sememes, &row.word, 6);
    let antonyms = relation_words(st, &row.sememes, &st.antonym_sememes, &row.word, 6);
    let mut hypernyms: Vec<String> = row
        .sememes
        .iter()
        .take(4)
        .map(|s| sememe_zh(s).to_string())
        .collect();
    for w in relation_words(st, &row.sememes, &st.hypernym_sememes, &row.word, 6) {
        dedup_push(&mut hypernyms, &w, &row.word, 6);
    }

    Some(HowNetEnhancement {
        plain: plain_text(row),
        sense: if sememe_names.is_empty() {
            row.def.clone()
        } else {
            format!("可能义项：{}；义原：{}。", pos_zh(&row.pos), sememe_names.join("、"))
        },
        confidence,
        synonyms,
        antonyms,
        hypernyms,
        example_note: example_note(row, context),
    })
}

#[cfg(test)]
mod tests {
    use super::enhance;

    #[test]
    fn enhances_common_chinese_word() {
        let h = enhance("编", "这本书由多人整理编辑成册。").expect("OpenHowNet entry for 编");
        assert!(!h.plain.is_empty());
        assert!(!h.sense.is_empty());
        assert!(!h.example_note.is_empty());
        assert!(h.confidence > 0.0);
        assert!(!h.synonyms.is_empty() || !h.hypernyms.is_empty());
    }

    #[test]
    fn missing_word_returns_none() {
        assert!(enhance("不存在的超长测试词条", "").is_none());
    }
}
