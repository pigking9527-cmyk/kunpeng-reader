use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Default)]
pub(super) struct ImportEntry {
    pub(super) word: String,
    pub(super) lang: String,
    pub(super) phonetic: String,
    pub(super) def: String,
    pub(super) def_en: String,
}

pub(super) fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

pub(super) fn guess_lang(word: &str, explicit: &str) -> String {
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

pub(super) fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return s.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return s.into_owned();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        text.into_owned()
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取词典文件失败：{e}"))?;
    Ok(decode_text(&bytes))
}

fn split_delimited(line: &str, delimiter: char) -> Vec<String> {
    let mut columns = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quoted = false;
    while let Some(character) = chars.next() {
        if character == '"' {
            if quoted && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if character == delimiter && !quoted {
            columns.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(character);
        }
    }
    columns.push(current.trim().to_string());
    columns
}

fn column_index(headers: &[String], names: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let key = header.trim().trim_start_matches('\u{feff}').to_lowercase();
        names.iter().any(|name| key == *name)
    })
}

fn parse_delimited_text(text: &str, delimiter: char) -> Vec<ImportEntry> {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let Some(first) = lines.next() else {
        return Vec::new();
    };
    let first_columns = split_delimited(first, delimiter);
    let has_header = first_columns.iter().any(|column| {
        let key = column.trim().trim_start_matches('\u{feff}').to_lowercase();
        matches!(
            key.as_str(),
            "word" | "term" | "key" | "headword" | "词" | "词条" | "definition" | "def" | "释义"
        )
    });
    let (headers, rows): (Vec<String>, Vec<Vec<String>>) = if has_header {
        (
            first_columns,
            lines.map(|line| split_delimited(line, delimiter)).collect(),
        )
    } else {
        let mut rows = vec![first_columns];
        rows.extend(lines.map(|line| split_delimited(line, delimiter)));
        (Vec::new(), rows)
    };
    let word_index = if has_header {
        column_index(&headers, &["word", "term", "key", "headword", "词", "词条"]).unwrap_or(0)
    } else {
        0
    };
    let phonetic_index = if has_header {
        column_index(&headers, &["phonetic", "pron", "pinyin", "音标", "拼音"])
    } else if rows.first().map(|row| row.len()).unwrap_or(0) >= 3 {
        Some(1)
    } else {
        None
    };
    let definition_index = if has_header {
        column_index(
            &headers,
            &["def", "definition", "translation", "释义", "解释", "中文"],
        )
        .or((headers.len() > 1).then_some(1))
    } else if rows.first().map(|row| row.len()).unwrap_or(0) >= 3 {
        Some(2)
    } else {
        Some(1)
    };
    let english_definition_index = if has_header {
        column_index(&headers, &["def_en", "english", "en_def", "英文", "英释"])
    } else if rows.first().map(|row| row.len()).unwrap_or(0) >= 4 {
        Some(3)
    } else {
        None
    };
    let language_index = has_header
        .then(|| column_index(&headers, &["lang", "language", "语言"]))
        .flatten();

    rows.into_iter()
        .filter_map(|row| {
            let word = row.get(word_index).map(|value| value.trim()).unwrap_or("");
            if word.is_empty() {
                return None;
            }
            let definition = definition_index
                .and_then(|index| row.get(index))
                .cloned()
                .unwrap_or_default();
            let english_definition = english_definition_index
                .and_then(|index| row.get(index))
                .cloned()
                .unwrap_or_default();
            if definition.trim().is_empty() && english_definition.trim().is_empty() {
                return None;
            }
            Some(ImportEntry {
                word: word.to_string(),
                lang: guess_lang(
                    word,
                    language_index
                        .and_then(|index| row.get(index))
                        .map(String::as_str)
                        .unwrap_or(""),
                ),
                phonetic: phonetic_index
                    .and_then(|index| row.get(index))
                    .cloned()
                    .unwrap_or_default(),
                def: definition,
                def_en: english_definition,
            })
        })
        .collect()
}

pub(super) fn parse_delimited(path: &Path, delimiter: char) -> Result<Vec<ImportEntry>, String> {
    Ok(parse_delimited_text(&read_text(path)?, delimiter))
}

fn entry_from_object(
    object: &serde_json::Map<String, Value>,
    fallback_word: Option<&str>,
) -> Option<ImportEntry> {
    let word = object
        .get("word")
        .or_else(|| object.get("term"))
        .or_else(|| object.get("key"))
        .and_then(Value::as_str)
        .or(fallback_word)
        .unwrap_or("")
        .trim();
    if word.is_empty() {
        return None;
    }
    let definition = object
        .get("def")
        .or_else(|| object.get("definition"))
        .or_else(|| object.get("translation"))
        .or_else(|| object.get("zh"))
        .and_then(value_to_text)
        .unwrap_or_default();
    let english_definition = object
        .get("def_en")
        .or_else(|| object.get("english"))
        .or_else(|| object.get("en"))
        .and_then(value_to_text)
        .unwrap_or_default();
    if definition.trim().is_empty() && english_definition.trim().is_empty() {
        return None;
    }
    Some(ImportEntry {
        word: word.to_string(),
        lang: guess_lang(
            word,
            object
                .get("lang")
                .or_else(|| object.get("language"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        phonetic: object
            .get("phonetic")
            .or_else(|| object.get("pron"))
            .or_else(|| object.get("pinyin"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        def: definition,
        def_en: english_definition,
    })
}

fn parse_json_text(text: &str) -> Result<Vec<ImportEntry>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("JSON 词典格式错误：{error}"))?;
    let mut entries = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                if let Value::Object(object) = item {
                    if let Some(entry) = entry_from_object(&object, None) {
                        entries.push(entry);
                    }
                }
            }
        }
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get("entries") {
                for item in items {
                    if let Value::Object(object) = item {
                        if let Some(entry) = entry_from_object(object, None) {
                            entries.push(entry);
                        }
                    }
                }
            } else {
                for (word, value) in map {
                    match value {
                        Value::String(definition) => entries.push(ImportEntry {
                            lang: guess_lang(&word, ""),
                            word,
                            phonetic: String::new(),
                            def: definition,
                            def_en: String::new(),
                        }),
                        Value::Object(object) => {
                            if let Some(entry) = entry_from_object(&object, Some(&word)) {
                                entries.push(entry);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    Ok(entries)
}

pub(super) fn parse_json(path: &Path) -> Result<Vec<ImportEntry>, String> {
    parse_json_text(&read_text(path)?)
}

fn value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(value_to_text)
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Object(_) => Some(value.to_string()),
        _ => None,
    }
}

pub(super) fn parse_ifo(path: &Path) -> Result<HashMap<String, String>, String> {
    let text = read_text(path)?;
    let mut values = HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delimited_parser_handles_header_quotes_and_language() {
        let entries = parse_delimited_text(
            "word,phonetic,definition,lang\nhello,/həˈləʊ/,\"greeting, salutation\",en\n你好,,问候,zh-CN",
            ',',
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].def, "greeting, salutation");
        assert_eq!(entries[1].lang, "zh");
    }

    #[test]
    fn json_parser_supports_entries_and_dictionary_maps() {
        let entries =
            parse_json_text(r#"{"entries":[{"term":"book","en":["volume","text"]}]}"#).unwrap();
        assert_eq!(entries[0].def_en, "volume\ntext");

        let entries = parse_json_text(r#"{"你好":"问候","book":{"definition":"text"}}"#).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.word == "你好" && entry.lang == "zh"));
        assert!(entries.iter().any(|entry| entry.word == "book"));
    }

    #[test]
    fn utf16_bom_and_language_aliases_are_decoded() {
        assert_eq!(decode_text(&[0xff, 0xfe, b'a', 0]), "a");
        assert_eq!(guess_lang("term", "英"), "en");
        assert_eq!(guess_lang("词条", ""), "zh");
    }
}
