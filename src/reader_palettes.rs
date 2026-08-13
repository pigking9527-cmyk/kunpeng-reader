//! Reader appearance palette synchronization.
//!
//! Custom palettes are independent LWW entities so two devices changing
//! different palettes do not overwrite one another. New images are immutable
//! local/remote assets referenced by SHA-256; legacy data URLs remain readable
//! only for the migration window.

use crate::{db::AppDb, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

mod rules;

use rules::{normalize_palette, normalized_order, MAX_CUSTOM_PALETTES};

pub(crate) const READER_PALETTE_KIND: &str = "reader_palette_v1";
pub(crate) const READER_PALETTE_ORDER_KIND: &str = "reader_palette_order_v1";
const DEFAULT_ID: &str = "default";

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
