pub const EDGE_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

pub fn sha256_upper(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02X}")).collect()
}

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn build_edge_ssml(text: &str, voice: &str, rate: i32) -> String {
    let safe_voice = xml_escape(voice);
    let safe_text = xml_escape(text);
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='{safe_voice}'><prosody pitch='+0Hz' rate='{rate:+}%' volume='+0%'>{safe_text}</prosody></voice></speak>"
    )
}

pub fn normalize_word_for_tts(word: &str) -> String {
    word.trim().to_lowercase()
}

pub fn word_cache_key(voice: &str, word: &str) -> String {
    sha256_upper(&format!(
        "{}:{}",
        voice.trim(),
        normalize_word_for_tts(word)
    ))
    .to_lowercase()
}

pub fn frequent_words(source: &str) -> impl Iterator<Item = &str> {
    source
        .lines()
        .map(str::trim)
        .filter(|word| !word.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_upper_is_stable_upper_hex() {
        assert_eq!(
            sha256_upper("abc"),
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        );
    }

    #[test]
    fn xml_escape_escapes_text_and_attribute_sensitive_chars() {
        assert_eq!(
            xml_escape("Tom & 'A' <B> \"C\""),
            "Tom &amp; &apos;A&apos; &lt;B&gt; &quot;C&quot;"
        );
    }

    #[test]
    fn edge_ssml_escapes_voice_and_text() {
        let ssml = build_edge_ssml("a < b & c", "en-US-'Bad'\"Voice\"", -12);
        assert!(ssml.contains("rate='-12%'"));
        assert!(ssml.contains("en-US-&apos;Bad&apos;&quot;Voice&quot;"));
        assert!(ssml.contains("a &lt; b &amp; c"));
        assert!(!ssml.contains("a < b & c"));
    }

    #[test]
    fn word_cache_key_trims_and_lowercases_word() {
        assert_eq!(
            word_cache_key("en-US-JennyNeural", " Hello "),
            word_cache_key("en-US-JennyNeural", "hello")
        );
        assert_ne!(
            word_cache_key("en-US-JennyNeural", "hello"),
            word_cache_key("en-US-GuyNeural", "hello")
        );
    }

    #[test]
    fn frequent_words_trims_and_drops_blank_lines() {
        let words: Vec<&str> = frequent_words(" the \n\n of\r\n and ").collect();
        assert_eq!(words, vec!["the", "of", "and"]);
    }
}
