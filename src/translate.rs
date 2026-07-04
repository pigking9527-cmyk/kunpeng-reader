use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TranslateResult {
    pub ok: bool,
    pub provider: String,
    pub source_lang: String,
    pub target_lang: String,
    pub original: String,
    pub translated: String,
    pub error: String,
}

fn md5_hex(input: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14,
        20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
        16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let bit_len = (input.len() as u64) * 8;
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0 = 0x67452301u32;
    let mut b0 = 0xefcdab89u32;
    let mut c0 = 0x98badcfeu32;
    let mut d0 = 0x10325476u32;

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            let j = i * 4;
            *word = u32::from_le_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&a0.to_le_bytes());
    out.extend_from_slice(&b0.to_le_bytes());
    out.extend_from_slice(&c0.to_le_bytes());
    out.extend_from_slice(&d0.to_le_bytes());
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn normalize_baidu_lang(lang: &str, fallback: &str) -> String {
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

fn sha256_hex(input: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(input);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let mut h = Sha256::new();
        h.update(key);
        let digest = h.finalize();
        key_block[..32].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut o_key_pad = [0x5cu8; BLOCK_SIZE];
    let mut i_key_pad = [0x36u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        o_key_pad[i] ^= key_block[i];
        i_key_pad[i] ^= key_block[i];
    }
    let mut inner = Sha256::new();
    inner.update(i_key_pad);
    inner.update(data);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(o_key_pad);
    outer.update(inner_hash);
    outer.finalize().to_vec()
}

fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    hmac_sha256(key, data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn normalize_common_lang(lang: &str, fallback: &str) -> String {
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

fn normalize_deepl_lang(lang: &str, fallback: &str, is_target: bool) -> String {
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

fn baidu_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    app_id: &str,
    key: &str,
) -> Result<String, String> {
    let app_id = app_id.trim();
    let key = key.trim();
    if app_id.is_empty() || key.is_empty() {
        return Err("请先填写百度翻译 AppID 和密钥。".to_string());
    }
    let from = normalize_baidu_lang(source_lang, "auto");
    let to = normalize_baidu_lang(target_lang, "zh");
    let salt = chrono::Utc::now().timestamp_millis().to_string();
    let sign = md5_hex(format!("{app_id}{text}{salt}{key}").as_bytes());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(20))
        .build();
    let value = agent
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .set("User-Agent", "kunpeng-reader")
        .send_form(&[
            ("q", text),
            ("from", &from),
            ("to", &to),
            ("appid", app_id),
            ("salt", &salt),
            ("sign", &sign),
        ])
        .map_err(|e| format!("百度翻译请求失败：{e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("百度翻译返回解析失败：{e}"))?;
    if let Some(code) = value.get("error_code").and_then(|v| v.as_str()) {
        let msg = value
            .get("error_msg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("百度翻译错误 {code}：{msg}"));
    }
    let mut out = String::new();
    if let Some(arr) = value.get("trans_result").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(dst) = item.get("dst").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("百度翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn deepl_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 DeepL API Key。".to_string());
    }
    let target = normalize_deepl_lang(target_lang, "ZH", true);
    let source = normalize_deepl_lang(source_lang, "auto", false);
    let url = if api_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .build();
    let req = agent
        .post(url)
        .set("User-Agent", "kunpeng-reader")
        .set("Authorization", &format!("DeepL-Auth-Key {api_key}"));
    let mut form = vec![("text", text), ("target_lang", target.as_str())];
    if source != "auto" {
        form.push(("source_lang", source.as_str()));
    }
    let value = req
        .send_form(&form)
        .map_err(|e| format!("DeepL 翻译请求失败：{e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("DeepL 翻译返回解析失败：{e}"))?;
    let mut out = String::new();
    if let Some(arr) = value.get("translations").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(dst) = item.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("DeepL 翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn google_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 Google API Key。".to_string());
    }
    let source = normalize_common_lang(source_lang, "auto");
    let target = normalize_common_lang(target_lang, "zh-CN");
    let endpoint = format!("https://translation.googleapis.com/language/translate/v2?key={api_key}");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .build();
    let mut form = vec![("q", text), ("target", target.as_str()), ("format", "text")];
    if source != "auto" {
        form.push(("source", source.as_str()));
    }
    let value = agent
        .post(&endpoint)
        .set("User-Agent", "kunpeng-reader")
        .send_form(&form)
        .map_err(|e| format!("Google 翻译请求失败：{e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("Google 翻译返回解析失败：{e}"))?;
    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("Google 翻译错误：{msg}"));
    }
    let mut out = String::new();
    if let Some(arr) = value
        .get("data")
        .and_then(|v| v.get("translations"))
        .and_then(|v| v.as_array())
    {
        for item in arr {
            if let Some(dst) = item.get("translatedText").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(dst);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        Err("Google 翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

fn tencent_translate(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    secret_id: &str,
    secret_key: &str,
) -> Result<String, String> {
    let secret_id = secret_id.trim();
    let secret_key = secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("请先填写腾讯翻译 SecretId 和 SecretKey。".to_string());
    }
    let endpoint = "https://tmt.tencentcloudapi.com";
    let host = "tmt.tencentcloudapi.com";
    let service = "tmt";
    let action = "TextTranslate";
    let version = "2018-03-21";
    let region = "ap-guangzhou";
    let source = normalize_common_lang(source_lang, "auto");
    let target = normalize_common_lang(target_lang, "zh");
    let timestamp = chrono::Utc::now().timestamp();
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%d")
        .to_string();
    let payload = serde_json::json!({
        "SourceText": text,
        "Source": source,
        "Target": target,
        "ProjectId": 0
    })
    .to_string();
    let hashed_payload = sha256_hex(payload.as_bytes());
    let canonical_headers =
        format!("content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{}\n", action.to_ascii_lowercase());
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
    );
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hmac_sha256_hex(&secret_signing, string_to_sign.as_bytes());
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .build();
    let value = agent
        .post(endpoint)
        .set("Authorization", &authorization)
        .set("Content-Type", "application/json; charset=utf-8")
        .set("Host", host)
        .set("X-TC-Action", action)
        .set("X-TC-Timestamp", &timestamp.to_string())
        .set("X-TC-Version", version)
        .set("X-TC-Region", region)
        .send_string(&payload)
        .map_err(|e| format!("腾讯翻译请求失败：{e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("腾讯翻译返回解析失败：{e}"))?;
    if let Some(err) = value
        .get("Response")
        .and_then(|v| v.get("Error"))
        .and_then(|v| v.as_object())
    {
        let code = err.get("Code").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let msg = err
            .get("Message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("腾讯翻译错误 {code}：{msg}"));
    }
    let out = value
        .get("Response")
        .and_then(|v| v.get("TargetText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if out.is_empty() {
        Err("腾讯翻译结果为空".to_string())
    } else {
        Ok(out)
    }
}

pub(crate) fn translate_text(
    text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
    provider: Option<String>,
    api_id: Option<String>,
    api_key: Option<String>,
    baidu_app_id: Option<String>,
    baidu_key: Option<String>,
) -> TranslateResult {
    let original = text.trim().to_string();
    let provider = provider.unwrap_or_else(|| "baidu".to_string());
    let source_lang = source_lang.unwrap_or_else(|| "auto".to_string());
    let target_lang = target_lang.unwrap_or_else(|| "zh-CN".to_string());
    if original.is_empty() {
        return TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error: "没有可翻译的文字".to_string(),
        };
    }
    if original.chars().count() > 5000 {
        return TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error: "选中文字过长，请分段翻译".to_string(),
        };
    }
    let api_id = api_id.unwrap_or_default();
    let api_key = api_key.unwrap_or_default();
    let result = match provider.as_str() {
        "baidu" => baidu_translate(
            &original,
            &source_lang,
            &target_lang,
            baidu_app_id.as_deref().unwrap_or(api_id.as_str()),
            baidu_key.as_deref().unwrap_or(api_key.as_str()),
        ),
        "tencent" => tencent_translate(&original, &source_lang, &target_lang, &api_id, &api_key),
        "deepl" => deepl_translate(&original, &source_lang, &target_lang, &api_id),
        "google" => google_translate(&original, &source_lang, &target_lang, &api_id),
        _ => Err("未知翻译 API".to_string()),
    };
    match result {
        Ok(translated) => TranslateResult {
            ok: true,
            provider,
            source_lang,
            target_lang,
            original,
            translated,
            error: String::new(),
        },
        Err(error) => TranslateResult {
            ok: false,
            provider,
            source_lang,
            target_lang,
            original,
            translated: String::new(),
            error,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{md5_hex, normalize_baidu_lang};

    #[test]
    fn md5_matches_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn normalize_baidu_lang_maps_common_aliases() {
        assert_eq!(normalize_baidu_lang("zh-CN", "en"), "zh");
        assert_eq!(normalize_baidu_lang("ja", "zh"), "jp");
        assert_eq!(normalize_baidu_lang("ko", "zh"), "kor");
    }
}
