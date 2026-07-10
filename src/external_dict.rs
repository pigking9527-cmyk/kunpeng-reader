use encoding_rs::Encoding;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExternalDictMeta {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub format: String,
    pub source_path: String,
    pub enabled: bool,
    pub priority: i64,
    pub entry_count: i64,
    pub size_bytes: u64,
    pub imported_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExternalDictHit {
    pub dict_id: String,
    pub source_name: String,
    pub word: String,
    pub lang: String,
    pub phonetic: String,
    pub def: String,
    pub def_en: String,
}

#[derive(Default)]
struct ImportEntry {
    word: String,
    lang: String,
    phonetic: String,
    def: String,
    def_en: String,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn dict_dir() -> Result<PathBuf, String> {
    let mut d = dirs::config_dir().ok_or_else(|| "无法确定配置目录".to_string())?;
    d.push("ebook-reader");
    fs::create_dir_all(&d).map_err(|e| format!("创建词典目录失败：{e}"))?;
    Ok(d)
}

fn db_path() -> Result<PathBuf, String> {
    Ok(dict_dir()?.join("external-dicts.db"))
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| format!("打开外置词典数据库失败：{e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS dictionaries (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lang TEXT NOT NULL,
            format TEXT NOT NULL,
            source_path TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL,
            entry_count INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            imported_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS entries (
            dict_id TEXT NOT NULL,
            word TEXT NOT NULL,
            word_norm TEXT NOT NULL,
            lang TEXT NOT NULL,
            phonetic TEXT NOT NULL DEFAULT '',
            def TEXT NOT NULL DEFAULT '',
            def_en TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_external_dict_entries
            ON entries(word_norm, dict_id);
        CREATE INDEX IF NOT EXISTS idx_external_dict_entries_dict
            ON entries(dict_id);
        "#,
    )
    .map_err(|e| format!("初始化外置词典数据库失败：{e}"))?;
    Ok(conn)
}

fn normalize_word(w: &str, lang: &str) -> String {
    let s = w.trim();
    if lang == "en" || !has_cjk(s) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

fn guess_lang(word: &str, explicit: &str) -> String {
    let e = explicit.trim().to_lowercase();
    if e.starts_with("zh") || e == "cn" || e == "chinese" || e == "中" {
        return "zh".to_string();
    }
    if e.starts_with("en") || e == "english" || e == "英" {
        return "en".to_string();
    }
    if has_cjk(word) {
        "zh".to_string()
    } else {
        "en".to_string()
    }
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return s.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return s.into_owned();
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (s, _, had_err) = enc.decode(bytes);
    if !had_err {
        s.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取词典文件失败：{e}"))?;
    Ok(decode_text(&bytes))
}

fn split_delimited(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = line.chars().peekable();
    let mut quoted = false;
    while let Some(c) = chars.next() {
        if c == '"' {
            if quoted && chars.peek() == Some(&'"') {
                cur.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c == delim && !quoted {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn column_index(headers: &[String], names: &[&str]) -> Option<usize> {
    headers.iter().position(|h| {
        let k = h.trim().trim_start_matches('\u{feff}').to_lowercase();
        names.iter().any(|n| k == *n)
    })
}

fn parse_delimited(path: &Path, delim: char) -> Result<Vec<ImportEntry>, String> {
    let text = read_text(path)?;
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let first = match lines.next() {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let first_cols = split_delimited(first, delim);
    let has_header = first_cols.iter().any(|c| {
        let k = c.trim().trim_start_matches('\u{feff}').to_lowercase();
        matches!(
            k.as_str(),
            "word" | "term" | "key" | "headword" | "词" | "词条" | "definition" | "def" | "释义"
        )
    });
    let (headers, rows): (Vec<String>, Vec<Vec<String>>) = if has_header {
        let mut rows = Vec::new();
        for line in lines {
            rows.push(split_delimited(line, delim));
        }
        (first_cols, rows)
    } else {
        let mut rows = vec![first_cols];
        for line in lines {
            rows.push(split_delimited(line, delim));
        }
        (Vec::new(), rows)
    };
    let wi = if has_header {
        column_index(&headers, &["word", "term", "key", "headword", "词", "词条"]).unwrap_or(0)
    } else {
        0
    };
    let pi = if has_header {
        column_index(&headers, &["phonetic", "pron", "pinyin", "音标", "拼音"])
    } else if rows.first().map(|r| r.len()).unwrap_or(0) >= 3 {
        Some(1)
    } else {
        None
    };
    let di = if has_header {
        column_index(
            &headers,
            &["def", "definition", "translation", "释义", "解释", "中文"],
        )
        .or(if headers.len() > 1 { Some(1) } else { None })
    } else if rows.first().map(|r| r.len()).unwrap_or(0) >= 3 {
        Some(2)
    } else {
        Some(1)
    };
    let dei = if has_header {
        column_index(&headers, &["def_en", "english", "en_def", "英文", "英释"])
    } else if rows.first().map(|r| r.len()).unwrap_or(0) >= 4 {
        Some(3)
    } else {
        None
    };
    let li = if has_header {
        column_index(&headers, &["lang", "language", "语言"])
    } else {
        None
    };
    let mut out = Vec::new();
    for r in rows {
        let word = r.get(wi).map(|s| s.trim()).unwrap_or("");
        if word.is_empty() {
            continue;
        }
        let lang = guess_lang(
            word,
            li.and_then(|i| r.get(i)).map(|s| s.as_str()).unwrap_or(""),
        );
        let def = di.and_then(|i| r.get(i)).cloned().unwrap_or_default();
        let def_en = dei.and_then(|i| r.get(i)).cloned().unwrap_or_default();
        if def.trim().is_empty() && def_en.trim().is_empty() {
            continue;
        }
        out.push(ImportEntry {
            word: word.to_string(),
            lang,
            phonetic: pi.and_then(|i| r.get(i)).cloned().unwrap_or_default(),
            def,
            def_en,
        });
    }
    Ok(out)
}

fn parse_json(path: &Path) -> Result<Vec<ImportEntry>, String> {
    let text = read_text(path)?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("JSON 词典格式错误：{e}"))?;
    let mut out = Vec::new();
    fn entry_from_obj(
        o: &serde_json::Map<String, Value>,
        fallback_word: Option<&str>,
    ) -> Option<ImportEntry> {
        let word = o
            .get("word")
            .or_else(|| o.get("term"))
            .or_else(|| o.get("key"))
            .and_then(|v| v.as_str())
            .or(fallback_word)
            .unwrap_or("")
            .trim();
        if word.is_empty() {
            return None;
        }
        let lang_raw = o
            .get("lang")
            .or_else(|| o.get("language"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let lang = guess_lang(word, lang_raw);
        let phonetic = o
            .get("phonetic")
            .or_else(|| o.get("pron"))
            .or_else(|| o.get("pinyin"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let def = o
            .get("def")
            .or_else(|| o.get("definition"))
            .or_else(|| o.get("translation"))
            .or_else(|| o.get("zh"))
            .and_then(value_to_text)
            .unwrap_or_default();
        let def_en = o
            .get("def_en")
            .or_else(|| o.get("english"))
            .or_else(|| o.get("en"))
            .and_then(value_to_text)
            .unwrap_or_default();
        if def.trim().is_empty() && def_en.trim().is_empty() {
            return None;
        }
        Some(ImportEntry {
            word: word.to_string(),
            lang,
            phonetic,
            def,
            def_en,
        })
    }
    match v {
        Value::Array(arr) => {
            for item in arr {
                if let Value::Object(o) = item {
                    if let Some(e) = entry_from_obj(&o, None) {
                        out.push(e);
                    }
                }
            }
        }
        Value::Object(map) => {
            if map.contains_key("entries") {
                if let Some(Value::Array(arr)) = map.get("entries") {
                    for item in arr {
                        if let Value::Object(o) = item {
                            if let Some(e) = entry_from_obj(o, None) {
                                out.push(e);
                            }
                        }
                    }
                }
            } else {
                for (word, val) in map {
                    match val {
                        Value::String(s) => out.push(ImportEntry {
                            lang: guess_lang(&word, ""),
                            word,
                            phonetic: String::new(),
                            def: s,
                            def_en: String::new(),
                        }),
                        Value::Object(o) => {
                            if let Some(e) = entry_from_obj(&o, Some(&word)) {
                                out.push(e);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    Ok(out)
}

fn value_to_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().filter_map(value_to_text).collect();
            Some(parts.join("\n"))
        }
        Value::Object(_) => Some(v.to_string()),
        _ => None,
    }
}

fn parse_ifo(path: &Path) -> Result<HashMap<String, String>, String> {
    let text = read_text(path)?;
    let mut m = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            m.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Ok(m)
}

fn parse_stardict(path: &Path) -> Result<(String, Vec<ImportEntry>), String> {
    let ifo = if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("ifo"))
        .unwrap_or(false)
    {
        path.to_path_buf()
    } else {
        let mut p = path.to_path_buf();
        p.set_extension("ifo");
        p
    };
    let base = ifo.with_extension("");
    let idx = base.with_extension("idx");
    let dict = base.with_extension("dict");
    let dict_dz = base.with_extension("dict.dz");
    if !ifo.exists() || !idx.exists() || (!dict.exists() && !dict_dz.exists()) {
        return Err("StarDict 需要同名 .ifo、.idx、.dict 或 .dict.dz 文件".to_string());
    }
    let meta = parse_ifo(&ifo)?;
    let name = meta.get("bookname").cloned().unwrap_or_else(|| {
        base.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("StarDict")
            .to_string()
    });
    let idx_bytes = fs::read(&idx).map_err(|e| format!("读取 StarDict idx 失败：{e}"))?;
    let dict_bytes = if dict.exists() {
        fs::read(&dict).map_err(|e| format!("读取 StarDict dict 失败：{e}"))?
    } else {
        let f = fs::File::open(&dict_dz).map_err(|e| format!("读取 StarDict dict.dz 失败：{e}"))?;
        let mut gz = flate2::read::GzDecoder::new(f);
        let mut data = Vec::new();
        gz.read_to_end(&mut data)
            .map_err(|e| format!("解压 StarDict dict.dz 失败：{e}"))?;
        data
    };
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < idx_bytes.len() {
        let start = i;
        while i < idx_bytes.len() && idx_bytes[i] != 0 {
            i += 1;
        }
        if i >= idx_bytes.len() {
            break;
        }
        let word = decode_text(&idx_bytes[start..i]).trim().to_string();
        i += 1;
        if i + 8 > idx_bytes.len() {
            break;
        }
        let off = u32::from_be_bytes([
            idx_bytes[i],
            idx_bytes[i + 1],
            idx_bytes[i + 2],
            idx_bytes[i + 3],
        ]) as usize;
        let len = u32::from_be_bytes([
            idx_bytes[i + 4],
            idx_bytes[i + 5],
            idx_bytes[i + 6],
            idx_bytes[i + 7],
        ]) as usize;
        i += 8;
        if word.is_empty() || off >= dict_bytes.len() {
            continue;
        }
        let end = off.saturating_add(len).min(dict_bytes.len());
        let mut def = decode_text(&dict_bytes[off..end]);
        if let Some(seq) = meta.get("sametypesequence") {
            if seq.len() == 1 && !def.is_empty() && def.as_bytes()[0].is_ascii_alphabetic() {
                def = def.chars().skip(1).collect();
            }
        }
        let lang = guess_lang(&word, "");
        entries.push(ImportEntry {
            word,
            lang,
            phonetic: String::new(),
            def: def.trim_matches('\0').trim().to_string(),
            def_en: String::new(),
        });
    }
    Ok((name, entries))
}

fn parse_mdx_or_mdd(path: &Path) -> Result<(String, Vec<ImportEntry>), String> {
    let bytes = fs::read(path).map_err(|e| format!("读取 MDX/MDD 失败：{e}"))?;
    let parsed = MdxParser::new(path, &bytes)?.parse()?;
    Ok(parsed)
}

struct MdxHeader {
    title: String,
    encoding: String,
    version: f32,
    encrypted: bool,
    is_mdd: bool,
}

struct MdxParser<'a> {
    bytes: &'a [u8],
    pos: usize,
    header: MdxHeader,
}

impl<'a> MdxParser<'a> {
    fn new(path: &'a Path, bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() < 8 {
            return Err("MDX/MDD 文件过小".to_string());
        }
        let header_len = be_u32_at(bytes, 0)? as usize;
        if 4 + header_len + 4 > bytes.len() {
            return Err("MDX/MDD 头部长度异常".to_string());
        }
        let header_bytes = &bytes[4..4 + header_len];
        let header_text = decode_mdx_header(header_bytes);
        let version = mdx_attr(&header_text, "GeneratedByEngineVersion")
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(2.0);
        let encoding = mdx_attr(&header_text, "Encoding").unwrap_or_else(|| "UTF-8".to_string());
        let title = mdx_attr(&header_text, "Title")
            .or_else(|| mdx_attr(&header_text, "Description"))
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("MDX")
                    .to_string()
            });
        let encrypted = mdx_attr(&header_text, "Encrypted")
            .map(|v| v != "0" && v.to_lowercase() != "no" && v.to_lowercase() != "false")
            .unwrap_or(false);
        let is_mdd = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("mdd"))
            .unwrap_or(false);
        Ok(Self {
            bytes,
            pos: 4 + header_len + 4,
            header: MdxHeader {
                title,
                encoding,
                version,
                encrypted,
                is_mdd,
            },
        })
    }

    fn parse(mut self) -> Result<(String, Vec<ImportEntry>), String> {
        if self.header.encrypted {
            return Err(format!(
                "MDX/MDD「{}」启用了加密，当前无法导入",
                self.header.title
            ));
        }
        if self.header.version < 2.0 {
            return Err("暂不支持 MDict 1.x 词典，请转换为新版 MDX 或 StarDict".to_string());
        }
        let key_block_count = self.read_u64()? as usize;
        let entry_count = self.read_u64()? as usize;
        let key_info_decomp_size = self.read_u64()? as usize;
        let key_info_comp_size = self.read_u64()? as usize;
        let key_blocks_size = self.read_u64()? as usize;
        let _key_info_checksum = self.read_u32()?;
        if key_block_count == 0 || entry_count == 0 {
            return Ok((self.header.title, Vec::new()));
        }
        let key_info_comp = self.take(key_info_comp_size)?;
        let key_info = decompress_mdx_block(key_info_comp, key_info_decomp_size)?;
        let key_block_infos = self.parse_key_block_info(&key_info, key_block_count)?;
        let key_blocks_start = self.pos;
        let key_blocks_end = key_blocks_start
            .checked_add(key_blocks_size)
            .ok_or_else(|| "MDX key block 大小溢出".to_string())?;
        if key_blocks_end > self.bytes.len() {
            return Err("MDX key block 超出文件范围".to_string());
        }
        let key_blocks = &self.bytes[key_blocks_start..key_blocks_end];
        self.pos = key_blocks_end;
        let keys = self.parse_key_blocks(key_blocks, &key_block_infos)?;
        let record_block_count = self.read_u64()? as usize;
        let _record_entry_count = self.read_u64()? as usize;
        let record_info_size = self.read_u64()? as usize;
        let record_blocks_size = self.read_u64()? as usize;
        let record_info = self.take(record_info_size)?;
        let record_infos = parse_record_info(record_info, record_block_count)?;
        let record_blocks = self.take(record_blocks_size)?;
        let records = parse_record_blocks(record_blocks, &record_infos)?;
        let entries = self.entries_from_records(keys, records);
        Ok((self.header.title, entries))
    }

    fn parse_key_block_info(&self, data: &[u8], count: usize) -> Result<Vec<KeyBlockInfo>, String> {
        let mut r = SliceReader::new(data);
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let entries = r.u64()? as usize;
            let first_len = r.text_len()?;
            let first_raw = r.take(first_len)?;
            r.skip_text_term();
            let last_len = r.text_len()?;
            let last_raw = r.take(last_len)?;
            r.skip_text_term();
            let comp_size = r.u64()? as usize;
            let decomp_size = r.u64()? as usize;
            let first = self.decode_key(first_raw);
            let last = self.decode_key(last_raw);
            out.push(KeyBlockInfo {
                entries,
                first,
                last,
                comp_size,
                decomp_size,
            });
        }
        Ok(out)
    }

    fn parse_key_blocks(&self, data: &[u8], infos: &[KeyBlockInfo]) -> Result<Vec<MdxKey>, String> {
        let mut pos = 0usize;
        let mut out = Vec::new();
        for info in infos {
            let end = pos
                .checked_add(info.comp_size)
                .ok_or_else(|| "MDX key block 偏移溢出".to_string())?;
            if end > data.len() {
                return Err("MDX key block 数据不完整".to_string());
            }
            let block = decompress_mdx_block(&data[pos..end], info.decomp_size)?;
            pos = end;
            let mut r = SliceReader::new(&block);
            for _ in 0..info.entries {
                let record_offset = r.u64()?;
                let key_raw = r.take_until_term(self.key_unit())?;
                let key = self.decode_key(key_raw).trim_matches('\0').to_string();
                if !key.is_empty() {
                    out.push(MdxKey { key, record_offset });
                }
            }
            let _ = (&info.first, &info.last);
        }
        out.sort_by_key(|k| k.record_offset);
        Ok(out)
    }

    fn entries_from_records(&self, keys: Vec<MdxKey>, records: Vec<u8>) -> Vec<ImportEntry> {
        if self.header.is_mdd {
            return Vec::new();
        }
        let mut out = Vec::new();
        for i in 0..keys.len() {
            let start = keys[i].record_offset as usize;
            let end = keys
                .get(i + 1)
                .map(|k| k.record_offset as usize)
                .unwrap_or(records.len());
            if start >= records.len() || end <= start || end > records.len() {
                continue;
            }
            let word = keys[i].key.trim().to_string();
            if word.is_empty() {
                continue;
            }
            let raw = &records[start..end];
            let def = decode_mdx_text(raw, &self.header.encoding)
                .trim_matches('\0')
                .trim()
                .to_string();
            if def.is_empty() {
                continue;
            }
            let lang = guess_lang(&word, "");
            out.push(ImportEntry {
                word,
                lang,
                phonetic: String::new(),
                def,
                def_en: String::new(),
            });
        }
        out
    }

    fn decode_key(&self, bytes: &[u8]) -> String {
        decode_mdx_text(bytes, &self.header.encoding)
            .trim_matches('\0')
            .to_string()
    }

    fn key_unit(&self) -> usize {
        if self.header.encoding.to_ascii_uppercase().contains("UTF-16") {
            2
        } else {
            1
        }
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let v = be_u32_at(self.bytes, self.pos)?;
        self.pos += 4;
        Ok(v)
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let v = be_u64_at(self.bytes, self.pos)?;
        self.pos += 8;
        Ok(v)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "MDX 偏移溢出".to_string())?;
        if end > self.bytes.len() {
            return Err("MDX 数据不完整".to_string());
        }
        let s = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(s)
    }
}

struct KeyBlockInfo {
    entries: usize,
    first: String,
    last: String,
    comp_size: usize,
    decomp_size: usize,
}

struct RecordBlockInfo {
    comp_size: usize,
    decomp_size: usize,
}

struct MdxKey {
    key: String,
    record_offset: u64,
}

struct SliceReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> SliceReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn u64(&mut self) -> Result<u64, String> {
        let v = be_u64_at(self.data, self.pos)?;
        self.pos += 8;
        Ok(v)
    }
    fn text_len(&mut self) -> Result<usize, String> {
        let v = be_u16_at(self.data, self.pos)? as usize;
        self.pos += 2;
        Ok(v)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "MDX 字段偏移溢出".to_string())?;
        if end > self.data.len() {
            return Err("MDX 字段超出范围".to_string());
        }
        let s = &self.data[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn skip_text_term(&mut self) {
        if self.pos + 2 <= self.data.len()
            && self.data[self.pos] == 0
            && self.data[self.pos + 1] == 0
        {
            self.pos += 2;
        } else if self.pos < self.data.len() && self.data[self.pos] == 0 {
            self.pos += 1;
        }
    }
    fn take_until_term(&mut self, unit: usize) -> Result<&'a [u8], String> {
        let start = self.pos;
        if unit == 2 {
            while self.pos + 1 < self.data.len() {
                if self.data[self.pos] == 0 && self.data[self.pos + 1] == 0 {
                    let s = &self.data[start..self.pos];
                    self.pos += 2;
                    return Ok(s);
                }
                self.pos += 2;
            }
        } else {
            while self.pos < self.data.len() {
                if self.data[self.pos] == 0 {
                    let s = &self.data[start..self.pos];
                    self.pos += 1;
                    return Ok(s);
                }
                self.pos += 1;
            }
        }
        if start <= self.data.len() {
            Ok(&self.data[start..])
        } else {
            Err("MDX key 字符串越界".to_string())
        }
    }
}

fn be_u16_at(data: &[u8], pos: usize) -> Result<u16, String> {
    if pos + 2 > data.len() {
        return Err("MDX 数据不完整".to_string());
    }
    Ok(u16::from_be_bytes([data[pos], data[pos + 1]]))
}

fn be_u32_at(data: &[u8], pos: usize) -> Result<u32, String> {
    if pos + 4 > data.len() {
        return Err("MDX 数据不完整".to_string());
    }
    Ok(u32::from_be_bytes([
        data[pos],
        data[pos + 1],
        data[pos + 2],
        data[pos + 3],
    ]))
}

fn be_u64_at(data: &[u8], pos: usize) -> Result<u64, String> {
    if pos + 8 > data.len() {
        return Err("MDX 数据不完整".to_string());
    }
    Ok(u64::from_be_bytes([
        data[pos],
        data[pos + 1],
        data[pos + 2],
        data[pos + 3],
        data[pos + 4],
        data[pos + 5],
        data[pos + 6],
        data[pos + 7],
    ]))
}

fn decode_mdx_header(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return s.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return s.into_owned();
    }
    let zero_odd = bytes.len() > 2 && bytes.iter().skip(1).step_by(2).take(16).all(|b| *b == 0);
    if zero_odd {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return s.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_mdx_text(bytes: &[u8], enc: &str) -> String {
    let e = enc.to_ascii_uppercase();
    if e.contains("UTF-16") || e.contains("UTF16") {
        if bytes.starts_with(&[0xfe, 0xff]) || e.contains("BE") {
            let (s, _, _) =
                encoding_rs::UTF_16BE.decode(bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(bytes));
            s.into_owned()
        } else {
            let (s, _, _) =
                encoding_rs::UTF_16LE.decode(bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes));
            s.into_owned()
        }
    } else if e.contains("GB") || e.contains("BIG5") {
        let enc = Encoding::for_label(enc.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        let (s, _, _) = enc.decode(bytes);
        s.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn mdx_attr(header: &str, key: &str) -> Option<String> {
    let pat = format!(r#"{key}=""#);
    header.find(&pat).and_then(|i| {
        let rest = &header[i + pat.len()..];
        rest.find('"').map(|j| rest[..j].trim().to_string())
    })
}

fn decompress_mdx_block(block: &[u8], expected: usize) -> Result<Vec<u8>, String> {
    if block.len() < 8 {
        return Err("MDX 压缩块过短".to_string());
    }
    let typ = &block[..4];
    let body = &block[8..];
    let out = if typ == [0, 0, 0, 0] {
        body.to_vec()
    } else if typ == [0, 0, 0, 2] {
        let mut z = flate2::read::ZlibDecoder::new(body);
        let mut out = Vec::with_capacity(expected);
        z.read_to_end(&mut out)
            .map_err(|e| format!("解压 MDX zlib 块失败：{e}"))?;
        out
    } else if typ == [0, 0, 0, 1] {
        return Err("该 MDX/MDD 使用 LZO 压缩，当前版本暂不支持".to_string());
    } else {
        return Err("未知 MDX/MDD 压缩块类型".to_string());
    };
    if expected > 0 && out.len() != expected {
        // Some dictionaries contain a stale size field; keep parsing if the block is non-empty.
        if out.is_empty() {
            return Err("MDX 解压结果为空".to_string());
        }
    }
    Ok(out)
}

fn parse_record_info(data: &[u8], count: usize) -> Result<Vec<RecordBlockInfo>, String> {
    let mut r = SliceReader::new(data);
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(RecordBlockInfo {
            comp_size: r.u64()? as usize,
            decomp_size: r.u64()? as usize,
        });
    }
    Ok(out)
}

fn parse_record_blocks(data: &[u8], infos: &[RecordBlockInfo]) -> Result<Vec<u8>, String> {
    let mut pos = 0usize;
    let total: usize = infos.iter().map(|i| i.decomp_size).sum();
    let mut out = Vec::with_capacity(total);
    for info in infos {
        let end = pos
            .checked_add(info.comp_size)
            .ok_or_else(|| "MDX record block 偏移溢出".to_string())?;
        if end > data.len() {
            return Err("MDX record block 数据不完整".to_string());
        }
        let block = decompress_mdx_block(&data[pos..end], info.decomp_size)?;
        out.extend(block);
        pos = end;
    }
    Ok(out)
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn stardict_total_size(path: &Path) -> u64 {
    let ifo = if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("ifo"))
        .unwrap_or(false)
    {
        path.to_path_buf()
    } else {
        let mut p = path.to_path_buf();
        p.set_extension("ifo");
        p
    };
    let base = ifo.with_extension("");
    file_size(&ifo)
        + file_size(&base.with_extension("idx"))
        + file_size(&base.with_extension("dict"))
        + file_size(&base.with_extension("dict.dz"))
}

fn import_entries(path: &Path) -> Result<(String, String, Vec<ImportEntry>, u64), String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("外置词典")
        .to_string();
    match ext.as_str() {
        "tsv" => Ok((
            stem,
            "TSV".to_string(),
            parse_delimited(path, '\t')?,
            file_size(path),
        )),
        "csv" => Ok((
            stem,
            "CSV".to_string(),
            parse_delimited(path, ',')?,
            file_size(path),
        )),
        "json" => Ok((stem, "JSON".to_string(), parse_json(path)?, file_size(path))),
        "ifo" | "idx" | "dict" | "dz" => {
            let (name, entries) = parse_stardict(path)?;
            Ok((
                name,
                "StarDict".to_string(),
                entries,
                stardict_total_size(path),
            ))
        }
        "mdx" | "mdd" => {
            let (name, entries) = parse_mdx_or_mdd(path)?;
            Ok((name, ext.to_uppercase(), entries, file_size(path)))
        }
        _ => Err("不支持的词典格式。请选择 TSV、CSV、JSON、StarDict、MDX 或 MDD。".to_string()),
    }
}

fn dict_id_for(path: &Path) -> String {
    let mut h = Sha256::new();
    h.update(path.to_string_lossy().as_bytes());
    if let Ok(meta) = fs::metadata(path) {
        h.update(meta.len().to_le_bytes());
        if let Ok(m) = meta.modified() {
            if let Ok(d) = m.duration_since(UNIX_EPOCH) {
                h.update(d.as_secs().to_le_bytes());
            }
        }
    }
    let hex = format!("{:x}", h.finalize());
    hex[..16].to_string()
}

pub fn list() -> Result<Vec<ExternalDictMeta>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id,name,lang,format,source_path,enabled,priority,entry_count,size_bytes,imported_at
             FROM dictionaries ORDER BY priority ASC, imported_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ExternalDictMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                lang: r.get(2)?,
                format: r.get(3)?,
                source_path: r.get(4)?,
                enabled: r.get::<_, i64>(5)? != 0,
                priority: r.get(6)?,
                entry_count: r.get(7)?,
                size_bytes: r.get::<_, i64>(8)? as u64,
                imported_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn import(paths: Vec<String>) -> Result<Vec<ExternalDictMeta>, String> {
    let mut conn = open_db()?;
    let max_pri: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(priority),0) FROM dictionaries",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (next_pri, p) in (max_pri + 1..).zip(paths) {
        let path = PathBuf::from(&p);
        let (name, format, entries, size_bytes) = import_entries(&path)?;
        if entries.is_empty() {
            return Err(format!("词典「{name}」没有可导入词条"));
        }
        let id = dict_id_for(&path);
        let zh = entries.iter().filter(|e| e.lang == "zh").count();
        let lang = if zh * 2 >= entries.len() { "zh" } else { "en" };
        tx.execute("DELETE FROM entries WHERE dict_id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM dictionaries WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO dictionaries (id,name,lang,format,source_path,enabled,priority,entry_count,size_bytes,imported_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                name,
                lang,
                format,
                path.to_string_lossy().to_string(),
                1i64,
                next_pri,
                entries.len() as i64,
                size_bytes as i64,
                now_secs()
            ],
        )
        .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO entries (dict_id,word,word_norm,lang,phonetic,def,def_en)
                     VALUES (?,?,?,?,?,?,?)",
                )
                .map_err(|e| e.to_string())?;
            for e in entries {
                let norm = normalize_word(&e.word, &e.lang);
                stmt.execute(params![
                    id, e.word, norm, e.lang, e.phonetic, e.def, e.def_en
                ])
                .map_err(|err| err.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    list()
}

pub fn delete(id: String) -> Result<Vec<ExternalDictMeta>, String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM entries WHERE dict_id=?", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dictionaries WHERE id=?", params![id])
        .map_err(|e| e.to_string())?;
    list()
}

pub fn set_enabled(id: String, enabled: bool) -> Result<Vec<ExternalDictMeta>, String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE dictionaries SET enabled=? WHERE id=?",
        params![if enabled { 1i64 } else { 0i64 }, id],
    )
    .map_err(|e| e.to_string())?;
    list()
}

pub fn move_priority(id: String, dir: i32) -> Result<Vec<ExternalDictMeta>, String> {
    let conn = open_db()?;
    let rows = list()?;
    let Some(pos) = rows.iter().position(|d| d.id == id) else {
        return Ok(rows);
    };
    let new_pos = if dir < 0 {
        pos.saturating_sub(1)
    } else {
        (pos + 1).min(rows.len().saturating_sub(1))
    };
    if pos == new_pos {
        return Ok(rows);
    }
    let a = &rows[pos];
    let b = &rows[new_pos];
    conn.execute(
        "UPDATE dictionaries SET priority=? WHERE id=?",
        params![b.priority, a.id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE dictionaries SET priority=? WHERE id=?",
        params![a.priority, b.id],
    )
    .map_err(|e| e.to_string())?;
    list()
}

pub fn lookup(_term: &str, candidates: &[String]) -> Vec<ExternalDictHit> {
    let Ok(conn) = open_db() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut stmt = match conn.prepare(
        "SELECT d.id,d.name,e.word,e.lang,e.phonetic,e.def,e.def_en
         FROM entries e JOIN dictionaries d ON d.id=e.dict_id
         WHERE d.enabled=1 AND e.word_norm=?
         ORDER BY d.priority ASC, d.imported_at ASC
         LIMIT 12",
    ) {
        Ok(s) => s,
        Err(_) => return out,
    };
    for c in candidates {
        let norm = normalize_word(c, if has_cjk(c) { "zh" } else { "en" });
        let rows = match stmt.query_map(params![norm], |r| {
            Ok(ExternalDictHit {
                dict_id: r.get(0)?,
                source_name: r.get(1)?,
                word: r.get(2)?,
                lang: r.get(3)?,
                phonetic: r.get(4)?,
                def: r.get(5)?,
                def_en: r.get(6)?,
            })
        }) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for row in rows.flatten() {
            if !out
                .iter()
                .any(|h: &ExternalDictHit| h.dict_id == row.dict_id && h.word == row.word)
            {
                out.push(row);
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}
