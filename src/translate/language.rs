pub(super) fn normalize_baidu_lang(lang: &str, fallback: &str) -> String {
    let s = lang.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("system") {
        return fallback.to_string();
    }
    match s.to_ascii_lowercase().as_str() {
        "auto" => "auto".to_string(),
        "zh" | "zh-cn" | "cn" => "zh".to_string(),
        "zh-tw" | "cht" | "tw" => "cht".to_string(),
        "en" | "en-us" | "en-gb" => "en".to_string(),
        "ja" | "jp" => "jp".to_string(),
        "ko" | "kr" => "kor".to_string(),
        "fr" => "fra".to_string(),
        "de" => "de".to_string(),
        "es" => "spa".to_string(),
        "ru" => "ru".to_string(),
        _ => fallback.to_string(),
    }
}

pub(super) fn normalize_common_lang(lang: &str, fallback: &str) -> String {
    let s = lang.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("system") {
        return fallback.to_string();
    }
    match s.to_ascii_lowercase().as_str() {
        "auto" => "auto".to_string(),
        "zh" | "zh-cn" | "cn" => "zh".to_string(),
        "zh-tw" | "cht" | "tw" => "zh-TW".to_string(),
        "en" | "en-us" | "en-gb" => "en".to_string(),
        "ja" | "jp" => "ja".to_string(),
        "ko" | "kr" => "ko".to_string(),
        "fr" => "fr".to_string(),
        "de" => "de".to_string(),
        "es" => "es".to_string(),
        "ru" => "ru".to_string(),
        _ => fallback.to_string(),
    }
}

pub(super) fn normalize_deepl_lang(lang: &str, fallback: &str, is_target: bool) -> String {
    let normalized = normalize_common_lang(lang, fallback);
    match normalized.as_str() {
        "auto" if is_target => fallback.to_string(),
        "zh" => "ZH".to_string(),
        "zh-TW" => "ZH-HANT".to_string(),
        "en" if is_target => "EN-US".to_string(),
        "en" => "EN".to_string(),
        "ja" => "JA".to_string(),
        "ko" => "KO".to_string(),
        "fr" => "FR".to_string(),
        "de" => "DE".to_string(),
        "es" => "ES".to_string(),
        "ru" => "RU".to_string(),
        _ => normalized.to_ascii_uppercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_baidu_lang, normalize_common_lang, normalize_deepl_lang};

    #[test]
    fn normalizes_provider_language_aliases() {
        let baidu_cases = [
            ("zh-CN", "en", "zh"),
            ("ja", "zh", "jp"),
            ("ko", "zh", "kor"),
        ];
        for (lang, fallback, expected) in baidu_cases {
            assert_eq!(normalize_baidu_lang(lang, fallback), expected);
        }

        let common_cases = [
            ("system", "zh", "zh"),
            ("zh-CN", "en", "zh"),
            ("ja", "en", "ja"),
            ("ko", "en", "ko"),
            ("zh-TW", "en", "zh-TW"),
            ("unknown", "en", "en"),
        ];
        for (lang, fallback, expected) in common_cases {
            assert_eq!(normalize_common_lang(lang, fallback), expected);
        }
    }

    #[test]
    fn normalizes_deepl_source_and_target_locales() {
        let cases = [
            ("zh-CN", "en", true, "ZH"),
            ("zh-TW", "en", true, "ZH-HANT"),
            ("en", "zh", true, "EN-US"),
            ("ja", "en", false, "JA"),
            ("auto", "ZH", true, "ZH"),
            ("auto", "ZH", false, "AUTO"),
        ];
        for (lang, fallback, is_target, expected) in cases {
            assert_eq!(normalize_deepl_lang(lang, fallback, is_target), expected);
        }
    }
}
