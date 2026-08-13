//! Reader appearance palette synchronization.
//!
//! Custom palettes are independent LWW entities so two devices changing
//! different palettes do not overwrite one another. New images are immutable
//! local/remote assets referenced by SHA-256; legacy data URLs remain readable
//! only for the migration window.

use crate::{db::AppDb, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const READER_PALETTE_KIND: &str = "reader_palette_v1";
pub(crate) const READER_PALETTE_ORDER_KIND: &str = "reader_palette_order_v1";
const DEFAULT_ID: &str = "default";
const MAX_CUSTOM_PALETTES: usize = 10;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_DATA_URL_BYTES: usize = 15 * 1024 * 1024;
const BUILTIN_IDS: &[&str] = &["light", "dark", "paper"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderPaletteSyncRequest {
    palettes: Vec<Value>,
    #[serde(default)]
    order: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderPaletteSyncSnapshot {
    palettes: Vec<Value>,
    order: Vec<String>,
}

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

fn normalize_palette(value: &Value) -> Result<Value, String> {
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

fn externalize_legacy_background(mut palette: Value) -> Result<Value, String> {
    let image = palette
        .get("backgroundImage")
        .and_then(Value::as_str)
        .unwrap_or("");
    if image.is_empty() || palette.get("backgroundAssetId").is_some() {
        return Ok(palette);
    }
    let asset = crate::reader_backgrounds::cache_reader_background_image(image.to_string())?;
    palette["backgroundImage"] = json!("");
    palette["backgroundAssetId"] = json!(asset.asset_id);
    palette["backgroundAssetSha256"] = json!(asset.sha256);
    palette["backgroundAssetMime"] = json!(asset.mime);
    palette["backgroundAssetBytes"] = json!(asset.byte_size);
    Ok(palette)
}

fn migrate_legacy_backgrounds(db: &mut AppDb) -> Result<(), String> {
    let mut writes = Vec::new();
    for entity in db
        .sync_entities_by_kind(READER_PALETTE_KIND)?
        .into_iter()
        .filter(|entity| entity.deleted_at == 0)
    {
        let palette = normalize_palette(&entity.json)?;
        let externalized = externalize_legacy_background(palette)?;
        if externalized != entity.json {
            writes.push((READER_PALETTE_KIND.to_string(), entity.id, externalized));
        }
    }
    if !writes.is_empty() {
        db.upsert_json_batch(&writes)?;
    }
    Ok(())
}

fn normalized_order(order: Vec<String>, palette_ids: &HashSet<String>) -> Vec<String> {
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

fn snapshot(db: &AppDb) -> Result<ReaderPaletteSyncSnapshot, String> {
    let palettes = db
        .sync_entities_by_kind(READER_PALETTE_KIND)?
        .into_iter()
        .filter(|item| item.deleted_at == 0)
        .filter_map(|item| normalize_palette(&item.json).ok())
        .take(MAX_CUSTOM_PALETTES)
        .collect::<Vec<_>>();
    let palette_ids = palettes
        .iter()
        .filter_map(|palette| {
            palette
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<HashSet<_>>();
    let order = db
        .entity_json(READER_PALETTE_ORDER_KIND, DEFAULT_ID)?
        .and_then(|value| value.get("order").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    Ok(ReaderPaletteSyncSnapshot {
        palettes,
        order: normalized_order(order, &palette_ids),
    })
}

#[tauri::command]
pub(crate) fn reader_palette_sync_get(
    state: tauri::State<AppState>,
) -> Result<ReaderPaletteSyncSnapshot, String> {
    state.with_db_write("reader_palette_sync_get", |db| {
        migrate_legacy_backgrounds(db)?;
        snapshot(db)
    })
}

#[tauri::command]
pub(crate) fn reader_palette_sync_save(
    state: tauri::State<AppState>,
    request: ReaderPaletteSyncRequest,
) -> Result<ReaderPaletteSyncSnapshot, String> {
    if request.palettes.len() > MAX_CUSTOM_PALETTES {
        return Err("自定义配色最多同步 10 个".into());
    }
    let mut ids = HashSet::new();
    let mut palettes = Vec::new();
    for palette in &request.palettes {
        let palette = externalize_legacy_background(normalize_palette(palette)?)?;
        let id = palette
            .get("id")
            .and_then(Value::as_str)
            .ok_or("自定义配色 ID 无效")?
            .to_string();
        if !ids.insert(id) {
            return Err("自定义配色 ID 重复".into());
        }
        palettes.push(palette);
    }
    let order = normalized_order(request.order, &ids);
    state.with_db_write("reader_palette_sync_save", |db| {
        let existing = db.sync_entities_by_kind(READER_PALETTE_KIND)?;
        for item in existing.into_iter().filter(|item| item.deleted_at == 0) {
            if !ids.contains(&item.id) {
                db.soft_delete(READER_PALETTE_KIND, &item.id)?;
            }
        }
        let mut writes = palettes
            .into_iter()
            .filter_map(|palette| {
                let id = palette.get("id").and_then(Value::as_str)?.to_string();
                Some((READER_PALETTE_KIND.to_string(), id, palette))
            })
            .collect::<Vec<_>>();
        writes.push((
            READER_PALETTE_ORDER_KIND.to_string(),
            DEFAULT_ID.to_string(),
            json!({ "version": 1, "order": order }),
        ));
        db.upsert_json_batch(&writes)?;
        snapshot(db)
    })
}
