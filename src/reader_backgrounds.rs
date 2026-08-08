//! Locally cached reader background-image assets.
//!
//! The reader receives only a short immutable `reader://.../background/...`
//! URL. Raw images are decoded once at import, stored as files, and sync uses
//! their SHA-256 references rather than passing data URLs through WebView IPC.
use crate::db::SyncEntity;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderBackgroundAsset {
    pub(crate) asset_id: String,
    pub(crate) sha256: String,
    pub(crate) mime: String,
    pub(crate) byte_size: usize,
    pub(crate) url: String,
}

fn cache_dir() -> Result<PathBuf, String> {
    let mut path = dirs::data_local_dir().ok_or("找不到本机数据目录")?;
    path.push("ebook-reader");
    path.push("reader-backgrounds");
    std::fs::create_dir_all(&path).map_err(|e| format!("创建背景缓存目录失败：{e}"))?;
    Ok(path)
}

fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn mime_for_header(header: &str) -> Option<&'static str> {
    match header {
        "data:image/png;base64" => Some("image/png"),
        "data:image/jpeg;base64" => Some("image/jpeg"),
        "data:image/webp;base64" => Some("image/webp"),
        "data:image/gif;base64" => Some("image/gif"),
        _ => None,
    }
}

fn valid_asset_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn local_url(asset_id: &str, mime: &str) -> Result<String, String> {
    if !valid_asset_id(asset_id) {
        return Err("背景图片资产标识无效".into());
    }
    let ext = extension_for_mime(mime).ok_or("背景图片类型无效")?;
    Ok(format!("{}/background/{asset_id}.{ext}", crate::RES_BASE))
}

fn decode(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (header, encoded) = data_url.trim().split_once(',').ok_or("背景图片格式无效")?;
    let mime = mime_for_header(header).ok_or("背景图片仅支持 PNG、JPG、WebP 或 GIF")?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "背景图片编码无效")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片不能超过 10MB".into());
    }
    Ok((bytes, mime))
}

pub(crate) fn cache_asset_bytes(
    asset_id: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<ReaderBackgroundAsset, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片不能超过 10MB".into());
    }
    let digest = Sha256::digest(bytes);
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if asset_id != sha256 || !valid_asset_id(asset_id) {
        return Err("背景图片校验失败".into());
    }
    let ext = extension_for_mime(mime).ok_or("背景图片类型无效")?;
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
    })
}

#[tauri::command]
pub(crate) fn cache_reader_background_image(
    data_url: String,
) -> Result<ReaderBackgroundAsset, String> {
    let (bytes, mime) = decode(&data_url)?;
    let asset_id = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    cache_asset_bytes(&asset_id, mime, &bytes)
}

#[tauri::command]
pub(crate) fn reader_background_local_url(
    asset_id: String,
    mime: String,
) -> Result<String, String> {
    let ext = extension_for_mime(&mime).ok_or("背景图片类型无效")?;
    let path = cache_dir()?.join(format!("{asset_id}.{ext}"));
    if !path.is_file() {
        return Err("本机尚未缓存该背景图片".into());
    }
    local_url(&asset_id, &mime)
}

pub(crate) fn read_cached_background(name: &str) -> Option<(Vec<u8>, String)> {
    let (asset_id, ext) = name.rsplit_once('.')?;
    if !valid_asset_id(asset_id) {
        return None;
    }
    let mime = match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    Some((
        std::fs::read(cache_dir().ok()?.join(name)).ok()?,
        mime.to_string(),
    ))
}

pub(crate) fn cached_asset_bytes(asset_id: &str, mime: &str) -> Option<Vec<u8>> {
    let ext = extension_for_mime(mime)?;
    std::fs::read(cache_dir().ok()?.join(format!("{asset_id}.{ext}"))).ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetInitResponse {
    complete: bool,
    #[serde(default)]
    received_bytes: usize,
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
        if valid_asset_id(id)
            && extension_for_mime(mime).is_some()
            && size > 0
            && size <= MAX_IMAGE_BYTES
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
            .post(&format!("{base}/sync/assets/init"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({
                "assetId": asset_id, "sha256": asset_id, "mime": mime,
                "byteSize": byte_size, "data_generation": data_generation,
            }))
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
                .put(&format!("{base}/sync/assets/{asset_id}"))
                .header("Authorization", &format!("Bearer {token}"))
                .header("Content-Type", &mime)
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
                .get(&format!("{base}/sync/assets/{asset_id}"))
                .header("Authorization", &format!("Bearer {token}"))
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
