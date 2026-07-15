use crate::atomic_file;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub(crate) const INDEX_VERSION: u32 = 3;
pub(crate) const INDEX_DISK_BUDGET: u64 = 3 * 1024 * 1024 * 1024;
const INDEX_MAGIC: &[u8; 8] = b"KPIDX003";

#[derive(Serialize, Deserialize)]
pub(crate) struct BookIndex {
    pub(crate) v: u32,
    pub(crate) mtime: u64,
    pub(crate) chapters: Vec<String>,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct SearchIndexDiskHealth {
    pub(crate) binary_files: u32,
    pub(crate) filter_files: u32,
    pub(crate) legacy_files: u32,
    pub(crate) orphan_files: u32,
    pub(crate) disk_bytes: u64,
    pub(crate) removed_files: u32,
    pub(crate) disk_limit_bytes: u64,
    pub(crate) memory_bytes: u64,
    pub(crate) memory_entries: u32,
    pub(crate) memory_limit_bytes: u64,
}

struct Asset {
    path: PathBuf,
    id: u64,
    bytes: u64,
    modified: u64,
}

pub(crate) fn index_dir() -> Option<PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("ebook-reader");
    dir.push("index");
    Some(dir)
}

pub(crate) fn index_path(id: u64) -> Option<PathBuf> {
    Some(index_dir()?.join(format!("idx_{id}.kpi")))
}

pub(crate) fn legacy_index_path(id: u64) -> Option<PathBuf> {
    Some(index_dir()?.join(format!("idx_{id}.json")))
}

pub(crate) fn filter_path(id: u64) -> Option<PathBuf> {
    Some(index_dir()?.join(format!("idx_{id}.bf1")))
}

fn encode_index(index: &BookIndex) -> Result<Vec<u8>, String> {
    let payload = rmp_serde::to_vec_named(index).map_err(|e| format!("索引序列化失败：{e}"))?;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(&payload)
        .map_err(|e| format!("索引压缩失败：{e}"))?;
    let compressed = encoder.finish().map_err(|e| format!("索引压缩失败：{e}"))?;
    let mut bytes = Vec::with_capacity(INDEX_MAGIC.len() + compressed.len());
    bytes.extend_from_slice(INDEX_MAGIC);
    bytes.extend_from_slice(&compressed);
    Ok(bytes)
}

fn decode_index(bytes: &[u8]) -> Option<BookIndex> {
    if bytes.len() <= INDEX_MAGIC.len() || &bytes[..INDEX_MAGIC.len()] != INDEX_MAGIC {
        return None;
    }
    let mut decoder = ZlibDecoder::new(&bytes[INDEX_MAGIC.len()..]);
    let mut payload = Vec::new();
    decoder.read_to_end(&mut payload).ok()?;
    rmp_serde::from_slice(&payload).ok()
}

pub(crate) fn load_index(id: u64) -> Option<(BookIndex, bool)> {
    if let Some(path) = index_path(id) {
        if let Ok(bytes) = std::fs::read(path) {
            if let Some(index) = decode_index(&bytes) {
                return Some((index, false));
            }
        }
    }
    let legacy = legacy_index_path(id)?;
    let index = serde_json::from_str(&std::fs::read_to_string(legacy).ok()?).ok()?;
    Some((index, true))
}

pub(crate) fn save_index(id: u64, index: &BookIndex) -> Result<(), String> {
    let path = index_path(id).ok_or("无法确定全文索引目录")?;
    atomic_file::write(&path, &encode_index(index)?)?;
    if let Some(legacy) = legacy_index_path(id) {
        let _ = std::fs::remove_file(legacy);
    }
    Ok(())
}

fn asset_identity(path: &Path) -> Option<(u64, &str)> {
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix("idx_")?;
    let (id, extension) = rest.rsplit_once('.')?;
    if !matches!(extension, "kpi" | "json" | "bf1") {
        return None;
    }
    Some((id.parse().ok()?, extension))
}

fn scan_assets(valid_ids: &HashSet<u64>) -> (SearchIndexDiskHealth, Vec<Asset>) {
    let mut health = SearchIndexDiskHealth {
        disk_limit_bytes: INDEX_DISK_BUDGET,
        ..SearchIndexDiskHealth::default()
    };
    let mut assets = Vec::new();
    let Some(dir) = index_dir() else {
        return (health, assets);
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (health, assets);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some((id, extension)) = asset_identity(&path) else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let bytes = metadata.len();
        health.disk_bytes = health.disk_bytes.saturating_add(bytes);
        match extension {
            "kpi" => health.binary_files += 1,
            "json" => health.legacy_files += 1,
            "bf1" => health.filter_files += 1,
            _ => {}
        }
        if !valid_ids.contains(&id) {
            health.orphan_files += 1;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        assets.push(Asset {
            path,
            id,
            bytes,
            modified,
        });
    }
    (health, assets)
}

pub(crate) fn inspect(valid_ids: &HashSet<u64>) -> SearchIndexDiskHealth {
    scan_assets(valid_ids).0
}

pub(crate) fn maintain(valid_ids: &HashSet<u64>, enforce_quota: bool) -> SearchIndexDiskHealth {
    let (_, assets) = scan_assets(valid_ids);
    let mut removed = 0u32;
    for asset in assets.iter().filter(|asset| !valid_ids.contains(&asset.id)) {
        if std::fs::remove_file(&asset.path).is_ok() {
            removed += 1;
        }
    }

    if enforce_quota {
        let (_, remaining) = scan_assets(valid_ids);
        let mut total: u64 = remaining.iter().map(|asset| asset.bytes).sum();
        if total > INDEX_DISK_BUDGET {
            let mut groups: HashMap<u64, Vec<&Asset>> = HashMap::new();
            for asset in &remaining {
                groups.entry(asset.id).or_default().push(asset);
            }
            let mut groups = groups.into_values().collect::<Vec<_>>();
            groups.sort_by_key(|group| group.iter().map(|asset| asset.modified).max().unwrap_or(0));
            for group in groups {
                if total <= INDEX_DISK_BUDGET {
                    break;
                }
                for asset in group {
                    if std::fs::remove_file(&asset.path).is_ok() {
                        total = total.saturating_sub(asset.bytes);
                        removed += 1;
                    }
                }
            }
        }
    }
    let mut health = inspect(valid_ids);
    health.removed_files = removed;
    health
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_index_roundtrip_preserves_chapters() {
        let index = BookIndex {
            v: INDEX_VERSION,
            mtime: 42,
            chapters: vec!["中国历史".repeat(200), "philosophy".repeat(200)],
        };
        let bytes = encode_index(&index).unwrap();
        let decoded = decode_index(&bytes).unwrap();
        assert_eq!(decoded.v, INDEX_VERSION);
        assert_eq!(decoded.mtime, 42);
        assert_eq!(decoded.chapters, index.chapters);
        assert!(bytes.len() < serde_json::to_vec(&index).unwrap().len());
    }

    #[test]
    fn asset_identity_accepts_only_managed_index_files() {
        assert_eq!(asset_identity(Path::new("idx_12.kpi")), Some((12, "kpi")));
        assert_eq!(asset_identity(Path::new("idx_12.bf1")), Some((12, "bf1")));
        assert_eq!(asset_identity(Path::new("idx_12.json")), Some((12, "json")));
        assert_eq!(asset_identity(Path::new("other.json")), None);
        assert_eq!(asset_identity(Path::new("idx_bad.kpi")), None);
    }
}
