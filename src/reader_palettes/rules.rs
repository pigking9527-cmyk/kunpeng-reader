//! Pure reader-palette validation and normalization rules.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(super) const MAX_CUSTOM_PALETTES: usize = 10;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_DATA_URL_BYTES: usize = 15 * 1024 * 1024;
const BUILTIN_IDS: &[&str] = &["light", "dark", "paper"];

fn valid_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 4 || bytes.len() == 7)
        && bytes.first() == Some(&b'#')
        && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn clipped_text(value: &str, max_bytes: usize) -> String {
    let mut result = value.trim().to_string();
    while result.len() > max_bytes {
        result.pop();
    }
    result
}

fn string_field(value: &Value, field: &str, max_bytes: usize) -> Result<String, String> {
    let value = value
        .get(field)
        .and_then(Value::as_str)
        .map(|text| clipped_text(text, max_bytes))
        .unwrap_or_default();
    if value.is_empty() {
        Err(format!("配色缺少有效的 {field}"))
    } else {
        Ok(value)
    }
}

fn validated_background_image(value: Option<&str>) -> Result<String, String> {
    let image = value.unwrap_or("").trim();
    if image.is_empty() {
        return Ok(String::new());
    }
    if image.len() > MAX_DATA_URL_BYTES {
        return Err("背景图片编码过大，单张图片不能超过 10MB".into());
    }
    let Some((header, encoded)) = image.split_once(',') else {
        return Err("背景图片格式无效".into());
    };
    if !matches!(
        header,
        "data:image/png;base64"
            | "data:image/jpeg;base64"
            | "data:image/webp;base64"
            | "data:image/gif;base64"
    ) {
        return Err("背景图片仅支持 PNG、JPG、WebP 或 GIF".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "背景图片编码无效".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片不能超过 10MB".into());
    }
    Ok(image.to_string())
}

fn valid_asset_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn normalize_palette(value: &Value) -> Result<Value, String> {
    let id = string_field(value, "id", 80)?;
    if !id.starts_with("custom-") {
        return Err("自定义配色 ID 无效".into());
    }
    let name = string_field(value, "name", 96)?;
    let background = string_field(value, "background", 16)?;
    let text = string_field(value, "text", 16)?;
    let link = string_field(value, "link", 16)?;
    let selection = string_field(value, "selection", 16)?;
    let footnote = string_field(value, "footnote", 16)?;
    let border = string_field(value, "border", 16)?;
    if ![&background, &text, &link, &selection, &footnote, &border]
        .iter()
        .all(|color| valid_color(color))
    {
        return Err("配色包含无效颜色值".into());
    }
    let theme = match value.get("theme").and_then(Value::as_str) {
        Some("dark") => "dark",
        Some("sepia") => "sepia",
        _ => "light",
    };
    let legacy_background_image =
        validated_background_image(value.get("backgroundImage").and_then(Value::as_str))?;
    let asset_id = value
        .get("backgroundAssetId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let asset = if asset_id.is_empty() {
        None
    } else {
        let sha256 = value
            .get("backgroundAssetSha256")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mime = value
            .get("backgroundAssetMime")
            .and_then(Value::as_str)
            .unwrap_or("");
        let byte_size = value
            .get("backgroundAssetBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if !valid_asset_id(asset_id)
            || sha256 != asset_id
            || !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            )
            || byte_size == 0
            || byte_size > MAX_IMAGE_BYTES as u64
        {
            return Err("背景图片资产引用无效".into());
        }
        Some((asset_id, sha256, mime, byte_size))
    };
    let mut normalized = json!({
        "version": 1, "id": id, "name": name, "background": background,
        // This field is compatibility-only. New code never writes an image here.
        "backgroundImage": legacy_background_image,
        "text": text, "link": link, "selection": selection, "footnote": footnote,
        "border": border, "theme": theme,
    });
    if let Some((asset_id, sha256, mime, byte_size)) = asset {
        normalized["backgroundAssetId"] = json!(asset_id);
        normalized["backgroundAssetSha256"] = json!(sha256);
        normalized["backgroundAssetMime"] = json!(mime);
        normalized["backgroundAssetBytes"] = json!(byte_size);
    }
    Ok(normalized)
}

pub(super) fn normalized_order(order: Vec<String>, palette_ids: &HashSet<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    order
        .into_iter()
        .map(|id| clipped_text(&id, 80))
        .filter(|id| !id.is_empty())
        .filter(|id| BUILTIN_IDS.contains(&id.as_str()) || palette_ids.contains(id))
        .filter(|id| seen.insert(id.clone()))
        .take(BUILTIN_IDS.len() + MAX_CUSTOM_PALETTES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_valid_palette_and_asset_reference() {
        let asset_id = "a".repeat(64);
        let normalized = normalize_palette(&json!({
            "id": " custom-spring ", "name": " Spring ",
            "background": "#fff", "text": "#111", "link": "#123456",
            "selection": "#abc", "footnote": "#def", "border": "#012345",
            "theme": "sepia", "backgroundAssetId": asset_id,
            "backgroundAssetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "backgroundAssetMime": "image/png", "backgroundAssetBytes": 42,
        }))
        .expect("valid palette");

        assert_eq!(normalized["id"], "custom-spring");
        assert_eq!(normalized["theme"], "sepia");
        assert_eq!(normalized["backgroundImage"], "");
        assert_eq!(normalized["backgroundAssetBytes"], 42);
    }

    #[test]
    fn rejects_invalid_color_and_asset_reference() {
        let invalid_color = json!({
            "id": "custom-broken", "name": "Broken", "background": "white",
            "text": "#111", "link": "#111", "selection": "#111",
            "footnote": "#111", "border": "#111",
        });
        assert_eq!(
            normalize_palette(&invalid_color),
            Err("配色包含无效颜色值".into())
        );

        let invalid_asset = json!({
            "id": "custom-broken", "name": "Broken", "background": "#fff",
            "text": "#111", "link": "#111", "selection": "#111",
            "footnote": "#111", "border": "#111", "backgroundAssetId": "a".repeat(64),
            "backgroundAssetSha256": "a".repeat(64), "backgroundAssetMime": "image/svg+xml",
            "backgroundAssetBytes": 1,
        });
        assert_eq!(
            normalize_palette(&invalid_asset),
            Err("背景图片资产引用无效".into())
        );
    }

    #[test]
    fn normalizes_order_to_known_unique_ids() {
        let ids = HashSet::from(["custom-spring".to_string()]);
        assert_eq!(
            normalized_order(
                vec![
                    " dark ".into(),
                    "custom-spring".into(),
                    "dark".into(),
                    "unknown".into(),
                ],
                &ids,
            ),
            vec!["dark", "custom-spring"],
        );
    }
}
