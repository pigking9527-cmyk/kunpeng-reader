// ============================================================================
//  dict.rs —— 离线词典：内嵌 gzip 词库（英中 ECDICT 常用词 + 汉语词语），
//  运行时解压建表（懒加载）。按选中文字的语种自动选库。
// ============================================================================

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

const EN_GZ: &[u8] = include_bytes!("dict/english.tsv.gz"); // word \t phonetic \t 中文释义（ECDICT）
const ZH_CC_GZ: &[u8] = include_bytes!("dict/zh_cc.tsv.gz"); // 词/字(简) \t 拼音 \t 中文释义（萌典·国语辞典，繁→简）
const ZH_WORD_GZ: &[u8] = include_bytes!("dict/zh_word.tsv.gz"); // 词(简/繁) \t 拼音 \t 英文释义（CC-CEDICT）

static EN: OnceLock<HashMap<String, (String, String, String)>> = OnceLock::new(); // 词→(音标, 中文翻译, 英文释义)
static ZH_CC: OnceLock<HashMap<String, (String, String)>> = OnceLock::new();
static ZH_WORD: OnceLock<HashMap<String, (String, String)>> = OnceLock::new();

#[derive(Serialize, Default)]
pub struct DictResult {
    pub found: bool,
    pub lang: String,     // "en" / "zh" / ""
    pub word: String,     // 实际命中的词（可能是词根/前缀）
    pub phonetic: String, // 英文音标 / 中文拼音
    pub def: String,      // 主释义：英文词→中文翻译；中文词→中中释义
    pub def_en: String,   // 中文词的中英释义（CC-CEDICT），供切换；英文词为空
}

fn gunzip(data: &[u8]) -> String {
    let mut s = String::new();
    let _ = flate2::read::GzDecoder::new(data).read_to_string(&mut s);
    s
}

fn en_map() -> &'static HashMap<String, (String, String, String)> {
    EN.get_or_init(|| {
        let text = gunzip(EN_GZ);
        let mut m = HashMap::with_capacity(60_000);
        for line in text.lines() {
            let mut it = line.splitn(4, '\t'); // word \t 音标 \t 中文翻译 \t 英文释义
            if let (Some(w), Some(p), Some(t)) = (it.next(), it.next(), it.next()) {
                let e = it.next().unwrap_or("");
                m.insert(w.to_string(), (p.to_string(), t.to_string(), e.to_string()));
            }
        }
        m
    })
}

// 通用：解析 "key \t phonetic \t def" 三列表
fn load_triple(gz: &[u8], cap: usize) -> HashMap<String, (String, String)> {
    let text = gunzip(gz);
    let mut m = HashMap::with_capacity(cap);
    for line in text.lines() {
        let mut it = line.splitn(3, '\t');
        if let (Some(w), Some(p), Some(d)) = (it.next(), it.next(), it.next()) {
            m.insert(w.to_string(), (p.to_string(), d.to_string()));
        }
    }
    m
}
fn zh_cc_map() -> &'static HashMap<String, (String, String)> {
    ZH_CC.get_or_init(|| load_triple(ZH_CC_GZ, 160_000))
}
fn zh_word_map() -> &'static HashMap<String, (String, String)> {
    ZH_WORD.get_or_init(|| load_triple(ZH_WORD_GZ, 200_000))
}

/// 英文简易词形还原：原词查不到时，按常见后缀规则生成候选词根再试。
fn en_lemmas(w: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |s: String| {
        if s.len() >= 2 && !out.contains(&s) {
            out.push(s);
        }
    };
    if let Some(b) = w.strip_suffix("ies") {
        push(format!("{b}y"));
    }
    if let Some(b) = w.strip_suffix("es") {
        push(b.to_string());
    }
    if let Some(b) = w.strip_suffix("s") {
        push(b.to_string());
    }
    if let Some(b) = w.strip_suffix("ing") {
        push(b.to_string());
        push(format!("{b}e"));
    }
    if let Some(b) = w.strip_suffix("ed") {
        push(b.to_string());
        push(format!("{b}e"));
        if let Some(b2) = b.strip_suffix("i") {
            push(format!("{b2}y"));
        }
    }
    if let Some(b) = w.strip_suffix("ly") {
        push(b.to_string());
    }
    if let Some(b) = w.strip_suffix("er") {
        push(b.to_string());
        push(format!("{b}e"));
    }
    if let Some(b) = w.strip_suffix("est") {
        push(b.to_string());
        push(format!("{b}e"));
    }
    // 去重叠尾字母（running -> run）
    let bytes = w.as_bytes();
    let n = bytes.len();
    if n >= 4 && bytes[n - 1] == bytes[n - 2] {
        push(w[..n - 1].to_string());
    }
    out
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 查词：自动按语种选库。中文按"整段→前缀"逐步缩短；英文做小写 + 词形还原回退。
pub fn lookup(term: &str) -> DictResult {
    let t = term.trim();
    if t.is_empty() {
        return DictResult::default();
    }
    if has_cjk(t) {
        let cc = zh_cc_map(); // 中中（萌典）
        let zw = zh_word_map(); // 中英（CC-CEDICT）
        let chars: Vec<char> = t.chars().collect();
        // 整段优先，再取越来越短的前缀；命中即返回中中+中英两种释义供切换
        for len in (1..=chars.len()).rev() {
            let sub: String = chars[..len].iter().collect();
            let m_cc = cc.get(&sub);
            let m_en = zw.get(&sub);
            if m_cc.is_some() || m_en.is_some() {
                let phonetic = m_cc
                    .map(|(p, _)| p.clone())
                    .filter(|p| !p.is_empty())
                    .or_else(|| m_en.map(|(p, _)| p.clone()))
                    .unwrap_or_default();
                return DictResult {
                    found: true,
                    lang: "zh".into(),
                    word: sub,
                    phonetic,
                    def: m_cc.map(|(_, d)| d.clone()).unwrap_or_default(),
                    def_en: m_en.map(|(_, d)| d.clone()).unwrap_or_default(),
                };
            }
        }
        DictResult {
            lang: "zh".into(),
            word: t.to_string(),
            ..Default::default()
        }
    } else {
        let en = en_map();
        let key: String = t.to_lowercase();
        let hit = en.get(&key).map(|v| (key.clone(), v));
        let hit = hit.or_else(|| {
            en_lemmas(&key)
                .into_iter()
                .find_map(|b| en.get(&b).map(|v| (b, v)))
        });
        if let Some((w, (p, trans, endef))) = hit {
            return DictResult {
                found: true,
                lang: "en".into(),
                word: w,
                phonetic: p.clone(),
                def: trans.clone(),    // 英中
                def_en: endef.clone(), // 英英
            };
        }
        DictResult {
            lang: "en".into(),
            word: t.to_string(),
            ..Default::default()
        }
    }
}
