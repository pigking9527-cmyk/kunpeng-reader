//! Locally cached reader background-image assets.
//!
//! The reader receives only a short immutable `reader://.../background/...`
//! URL. Raw images are decoded once at import, stored as files, and sync uses
//! their SHA-256 references rather than passing data URLs through WebView IPC.
use crate::{atomic_file, db::SyncEntity, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

mod rules;

pub(crate) const RECOVERY_ASSET_BUNDLE_FILE: &str = "reader-background-assets-v1.json";
const ORPHAN_INDEX_FILE: &str = "reader-background-orphans-v1.json";
const ORPHAN_GRACE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Default, Deserialize, Serialize)]
struct LocalOrphanIndex {
    version: u8,
    #[serde(default)]
    first_unreferenced_at: BTreeMap<String, i64>,
}

#[derive(Serialize, Deserialize)]
struct RecoveryAssetBundle {
    version: u32,
    assets: Vec<RecoveryAsset>,
}

#[derive(Serialize, Deserialize)]
struct RecoveryAsset {
    asset_id: String,
    mime: String,
    data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderBackgroundAsset {
    pub(crate) asset_id: String,
    pub(crate) sha256: String,
    pub(crate) mime: String,
    pub(crate) byte_size: usize,
    pub(crate) url: String,
    pub(crate) compressed: bool,
}

fn cache_dir() -> Result<PathBuf, String> {
    let mut path = crate::profile::app_data_dir().ok_or("找不到本机数据目录")?;
    path.push("reader-backgrounds");
    std::fs::create_dir_all(&path).map_err(|e| format!("创建背景缓存目录失败：{e}"))?;
    Ok(path)
}

fn recovery_bundle_path() -> Result<PathBuf, String> {
    let mut path = crate::profile::app_config_dir().ok_or("找不到应用配置目录")?;
    path.push(RECOVERY_ASSET_BUNDLE_FILE);
    Ok(path)
}

fn orphan_index_path() -> Result<PathBuf, String> {
    let mut path = crate::profile::app_config_dir().ok_or("找不到应用配置目录")?;
    path.push(ORPHAN_INDEX_FILE);
    Ok(path)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

fn load_orphan_index() -> LocalOrphanIndex {
    let Ok(path) = orphan_index_path() else {
        return LocalOrphanIndex::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return LocalOrphanIndex::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn cached_asset_name(name: &str) -> bool {
    let Some((asset_id, extension)) = name.rsplit_once('.') else {
        return false;
    };
    rules::valid_asset_id(asset_id) && matches!(extension, "png" | "jpg" | "webp" | "gif")
}

const fn orphan_grace_elapsed(now: i64, first_unreferenced_at: i64) -> bool {
    now.saturating_sub(first_unreferenced_at) >= ORPHAN_GRACE_MS
}

/// Delays deletion for seven days so a freshly deleted theme can still be
/// restored from a local undo/backup before its no-longer-referenced image is
/// reclaimed. The index contains only cache file names and timestamps.
pub(crate) fn prune_unreferenced_cached_assets(state: &AppState) -> Result<usize, String> {
    let references = state.with_db_read("reader_background_orphan_references", |db| {
        Ok(referenced_assets(&db.all_sync_entities()?)
            .into_iter()
            .filter_map(|(asset_id, mime, _)| {
                rules::extension_for_mime(&mime).map(|extension| format!("{asset_id}.{extension}"))
            })
            .collect::<BTreeSet<_>>())
    })?;
    let directory = cache_dir()?;
    let now = now_ms();
    let mut index = load_orphan_index();
    index.version = 1;
    let mut deleted = 0;
    let mut cached_names = BTreeSet::new();

    for entry in
        std::fs::read_dir(&directory).map_err(|error| format!("读取背景缓存目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取背景缓存文件失败：{error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("读取背景缓存文件类型失败：{error}"))?
            .is_file()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !cached_asset_name(&name) {
            continue;
        }
        cached_names.insert(name.clone());
        if references.contains(&name) {
            index.first_unreferenced_at.remove(&name);
            continue;
        }
        let first_unreferenced_at = *index
            .first_unreferenced_at
            .entry(name.clone())
            .or_insert(now);
        if orphan_grace_elapsed(now, first_unreferenced_at) {
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("清理孤立背景图片失败：{error}"))?;
            index.first_unreferenced_at.remove(&name);
            deleted += 1;
        }
    }
    index
        .first_unreferenced_at
        .retain(|name, _| cached_names.contains(name) && !references.contains(name));
    atomic_file::write_json(&orphan_index_path()?, &index, true)?;
    Ok(deleted)
}

const SYNC_PROTOCOL_HEADER: &str = "X-Sync-Protocol-Version";
const SYNC_PROTOCOL_VERSION: &str = "5";

pub(crate) fn local_url(asset_id: &str, mime: &str) -> Result<String, String> {
    if !rules::valid_asset_id(asset_id) {
        return Err("背景图片资产标识无效".into());
    }
    let ext = rules::extension_for_mime(mime).ok_or("背景图片类型无效")?;
    Ok(format!("{}/background/{asset_id}.{ext}", crate::RES_BASE))
}

pub(crate) fn cache_asset_bytes(
    asset_id: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<ReaderBackgroundAsset, String> {
    rules::validate_cached_image_bytes(bytes)?;
    let sha256 = rules::sha256_hex(bytes);
    if asset_id != sha256 || !rules::valid_asset_id(asset_id) {
        return Err("背景图片校验失败".into());
    }
    let ext = rules::extension_for_mime(mime).ok_or("背景图片类型无效")?;
    let path = cache_dir()?.join(format!("{asset_id}.{ext}"));
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|e| format!("保存背景图片失败：{e}"))?;
    }
    Ok(ReaderBackgroundAsset {
        asset_id: asset_id.to_string(),
        sha256,
        mime: mime.to_string(),
        byte_size: bytes.len(),
        url: local_url(asset_id, mime)?,
        compressed: false,
    })
}

#[tauri::command]
pub(crate) fn cache_reader_background_image(
    data_url: String,
) -> Result<ReaderBackgroundAsset, String> {
    let (bytes, mime) = rules::decode_import_data_url(&data_url)?;
    let normalized = rules::normalize_import_image(bytes, mime)?;
    let asset_id = rules::sha256_hex(&normalized.bytes);
    let mut asset = cache_asset_bytes(&asset_id, normalized.mime, &normalized.bytes)?;
    asset.compressed = normalized.compressed;
    Ok(asset)
}

#[tauri::command]
pub(crate) fn reader_background_local_url(
    asset_id: String,
    mime: String,
) -> Result<String, String> {
    if cached_asset_bytes(&asset_id, &mime).is_none()
        && !restore_cached_asset_from_bundle(&asset_id, &mime)?
    {
        return Err("本机尚未缓存该背景图片".into());
    }
    local_url(&asset_id, &mime)
}

pub(crate) fn read_cached_background(name: &str) -> Option<(Vec<u8>, String)> {
    let (asset_id, ext) = name.rsplit_once('.')?;
    if !rules::valid_asset_id(asset_id) {
        return None;
    }
    let mime = match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let bytes = std::fs::read(cache_dir().ok()?.join(name)).ok()?;
    (bytes.len() <= rules::MAX_IMPORTED_IMAGE_BYTES).then_some((bytes, mime.to_string()))
}

pub(crate) fn cached_asset_bytes(asset_id: &str, mime: &str) -> Option<Vec<u8>> {
    let ext = rules::extension_for_mime(mime)?;
    let bytes = std::fs::read(cache_dir().ok()?.join(format!("{asset_id}.{ext}"))).ok()?;
    (bytes.len() <= rules::MAX_IMPORTED_IMAGE_BYTES).then_some(bytes)
}

fn collect_asset_references(value: &Value, assets: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            if let (Some(id), Some(mime)) = (
                map.get("backgroundAssetId").and_then(Value::as_str),
                map.get("backgroundAssetMime").and_then(Value::as_str),
            ) {
                if rules::valid_asset_id(id) && rules::extension_for_mime(mime).is_some() {
                    assets
                        .entry(id.to_ascii_lowercase())
                        .or_insert_with(|| mime.to_string());
                }
            }
            for value in map.values() {
                collect_asset_references(value, assets);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_asset_references(value, assets);
            }
        }
        Value::String(text) if text.starts_with('{') || text.starts_with('[') => {
            if let Ok(value) = serde_json::from_str(text) {
                collect_asset_references(&value, assets);
            }
        }
        _ => {}
    }
}

/// Writes just the background files referenced by saved user settings. The
/// base64 payload only lives in the local recovery file; it is never exposed
/// to a reader URL, postMessage, or dynamic stylesheet.
pub(crate) fn write_recovery_asset_bundle(
    path: &std::path::Path,
    snapshots: &[Value],
) -> Result<(), String> {
    let mut references = BTreeMap::new();
    for snapshot in snapshots {
        collect_asset_references(snapshot, &mut references);
    }
    let assets = references
        .into_iter()
        .filter_map(|(asset_id, mime)| {
            cached_asset_bytes(&asset_id, &mime).map(|bytes| RecoveryAsset {
                asset_id,
                mime,
                data_base64: STANDARD.encode(bytes),
            })
        })
        .collect();
    atomic_file::write_json(path, &RecoveryAssetBundle { version: 1, assets }, true)
}

fn restore_cached_asset_from_bundle(asset_id: &str, mime: &str) -> Result<bool, String> {
    let bytes = match std::fs::read(recovery_bundle_path()?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取恢复背景图片失败：{error}")),
    };
    let bundle: RecoveryAssetBundle =
        serde_json::from_slice(&bytes).map_err(|error| format!("恢复背景图片清单无效：{error}"))?;
    if bundle.version != 1 {
        return Err("恢复背景图片清单版本无效".into());
    }
    let Some(asset) = bundle
        .assets
        .into_iter()
        .find(|asset| asset.asset_id.eq_ignore_ascii_case(asset_id) && asset.mime == mime)
    else {
        return Ok(false);
    };
    let bytes = STANDARD
        .decode(asset.data_base64)
        .map_err(|_| "恢复背景图片编码无效".to_string())?;
    cache_asset_bytes(asset_id, mime, &bytes)?;
    Ok(true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetInitResponse {
    complete: bool,
    received_bytes: usize,
}

fn asset_init_payload(asset_id: &str, mime: &str, byte_size: usize, data_generation: i64) -> Value {
    serde_json::json!({
        "assetId": asset_id,
        "sha256": asset_id,
        "mime": mime,
        "byteSize": byte_size,
        "dataGeneration": data_generation,
    })
}

fn referenced_assets(entities: &[SyncEntity]) -> Vec<(String, String, usize)> {
    let mut assets = Vec::new();
    for entity in entities
        .iter()
        .filter(|entity| entity.kind == "reader_palette_v1" && entity.deleted_at == 0)
    {
        let Some(id) = entity
            .json
            .get("backgroundAssetId")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(mime) = entity
            .json
            .get("backgroundAssetMime")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let size = entity
            .json
            .get("backgroundAssetBytes")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize;
        if rules::valid_asset_id(id)
            && rules::extension_for_mime(mime).is_some()
            && size > 0
            && size <= rules::MAX_IMPORTED_IMAGE_BYTES
            && !assets.iter().any(|(known, _, _)| known == id)
        {
            assets.push((id.to_string(), mime.to_string(), size));
        }
    }
    assets
}

/// Upload each referenced asset before its palette entity is pushed. The server
/// reports the durable offset, so retrying after a disconnect resumes at the
/// next 1 MiB chunk rather than retransmitting a ten-megabyte image.
pub(crate) fn sync_upload_referenced_assets(
    agent: &ureq::Agent,
    base: &str,
    token: &str,
    data_generation: i64,
    entities: &[SyncEntity],
) -> Result<(), String> {
    for (asset_id, mime, byte_size) in referenced_assets(entities) {
        let init: AssetInitResponse = agent
            .post(&format!("{base}/v1/sync/assets/init"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
            .send_json(asset_init_payload(
                &asset_id,
                &mime,
                byte_size,
                data_generation,
            ))
            .map_err(|e| format!("背景图片上传初始化失败：{e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("背景图片上传初始化解析失败：{e}"))?;
        if init.complete {
            continue;
        }
        let bytes = cached_asset_bytes(&asset_id, &mime)
            .ok_or("本机缺少待同步的背景图片；请重新导入图片后再同步")?;
        if bytes.len() != byte_size {
            return Err("本机背景图片大小与主题引用不一致".into());
        }
        let mut offset = init.received_bytes;
        if offset > bytes.len() {
            return Err("服务器背景图片续传偏移无效".into());
        }
        while offset < bytes.len() {
            let end = (offset + 1024 * 1024).min(bytes.len());
            agent
                .put(&format!("{base}/v1/sync/assets/{asset_id}"))
                .header("Authorization", &format!("Bearer {token}"))
                .header("Content-Type", &mime)
                .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                .header("X-Data-Generation", data_generation.to_string())
                .header(
                    "Content-Range",
                    format!("bytes {offset}-{}/{}", end - 1, bytes.len()),
                )
                .send(bytes[offset..end].to_vec())
                .map_err(|e| format!("背景图片分块上传失败：{e}"))?;
            offset = end;
        }
    }
    Ok(())
}

/// Fetch remote assets in small range requests. It deliberately caches only a
/// verified complete hash, so a partial network response can never be rendered.
pub(crate) fn sync_download_referenced_assets(
    agent: &ureq::Agent,
    base: &str,
    token: &str,
    entities: &[SyncEntity],
) -> Result<(), String> {
    for (asset_id, mime, byte_size) in referenced_assets(entities) {
        if cached_asset_bytes(&asset_id, &mime).is_some() {
            continue;
        }
        let mut bytes = Vec::with_capacity(byte_size);
        let mut offset = 0usize;
        while offset < byte_size {
            let end = (offset + 1024 * 1024).min(byte_size);
            let mut response = agent
                .get(&format!("{base}/v1/sync/assets/{asset_id}"))
                .header("Authorization", &format!("Bearer {token}"))
                .header(SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION)
                .header("Range", format!("bytes={offset}-{}", end - 1))
                .call()
                .map_err(|e| format!("背景图片下载失败：{e}"))?;
            let chunk = response
                .body_mut()
                .read_to_vec()
                .map_err(|e| format!("背景图片下载读取失败：{e}"))?;
            if chunk.is_empty() || chunk.len() != end - offset {
                return Err("背景图片下载分块长度无效".into());
            }
            bytes.extend_from_slice(&chunk);
            offset = end;
        }
        cache_asset_bytes(&asset_id, &mime, &bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn recovery_bundle_scans_nested_serialized_preferences() {
        let id = "a".repeat(64);
        let value = serde_json::json!({
            "settings": {
                "readerCustomPalettesV1": format!(
                    "[{{\"backgroundAssetId\":\"{id}\",\"backgroundAssetMime\":\"image/png\"}}]"
                )
            }
        });
        let mut found = BTreeMap::new();
        collect_asset_references(&value, &mut found);
        assert_eq!(found.get(&id), Some(&"image/png".to_string()));
    }

    #[test]
    fn asset_init_payload_uses_the_v5_camel_case_generation_field() {
        let body = asset_init_payload(&"a".repeat(64), "image/png", 7, 2);
        assert_eq!(body["dataGeneration"], 2);
        assert!(body.get("data_generation").is_none());
    }

    #[test]
    fn orphan_cleanup_waits_a_full_seven_days() {
        assert!(!orphan_grace_elapsed(ORPHAN_GRACE_MS - 1, 0));
        assert!(orphan_grace_elapsed(ORPHAN_GRACE_MS, 0));
    }
}
