use crate::atomic_file;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub(crate) const INDEX_VERSION: u32 = 4;
pub(crate) const INDEX_DISK_BUDGET: u64 = 3 * 1024 * 1024 * 1024;
const INDEX_MAGIC: &[u8; 8] = b"KPIDX004";
const INDEX_HEADER_LEN: usize = INDEX_MAGIC.len() + 8 + 32;
const SOURCE_FINGERPRINT_VERSION: u32 = 1;

/// A content identity for the exact source bytes used to build an index.
/// `mtime` is deliberately not part of the identity: callers may replace a
/// book while preserving its timestamp, and that must still invalidate every
/// derived search asset.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct SourceFingerprint {
    pub(crate) v: u32,
    pub(crate) bytes: u64,
    pub(crate) sha256: [u8; 32],
}

pub(crate) fn source_fingerprint(path: &Path) -> Result<SourceFingerprint, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("打开图书计算索引指纹失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取图书计算索引指纹失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    Ok(SourceFingerprint {
        v: SOURCE_FINGERPRINT_VERSION,
        bytes,
        sha256: hasher.finalize().into(),
    })
}

/// 交互式检索复用图书入库时已经计算好的完整 SHA-256，避免每次按键检索都把
/// 整个书架的原文件重新读一遍。文件长度仍取当前元数据；长度变化会立刻使旧索引
/// 失效。后台索引维护继续调用 `source_fingerprint` 做完整字节校验。
pub(crate) fn source_fingerprint_from_content_id(
    path: &Path,
    content_id: &str,
) -> Result<SourceFingerprint, String> {
    let content_id = content_id.trim();
    if content_id.len() != 64 {
        return source_fingerprint(path);
    }
    let mut sha256 = [0u8; 32];
    for (index, byte) in sha256.iter_mut().enumerate() {
        let offset = index * 2;
        let Ok(value) = u8::from_str_radix(&content_id[offset..offset + 2], 16) else {
            return source_fingerprint(path);
        };
        *byte = value;
    }
    let bytes = std::fs::metadata(path)
        .map_err(|error| format!("读取图书索引元数据失败：{error}"))?
        .len();
    Ok(SourceFingerprint {
        v: SOURCE_FINGERPRINT_VERSION,
        bytes,
        sha256,
    })
}

#[derive(Serialize, Deserialize)]
pub(crate) struct BookIndex {
    pub(crate) v: u32,
    pub(crate) mtime: u64,
    pub(crate) source: SourceFingerprint,
    pub(crate) chapters: Vec<String>,
}

impl BookIndex {
    pub(crate) fn is_current(&self, source: &SourceFingerprint) -> bool {
        self.v == INDEX_VERSION && self.source == *source
    }
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
    let compressed_sha256: [u8; 32] = Sha256::digest(&compressed).into();
    let mut bytes = Vec::with_capacity(INDEX_HEADER_LEN + compressed.len());
    bytes.extend_from_slice(INDEX_MAGIC);
    bytes.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&compressed_sha256);
    bytes.extend_from_slice(&compressed);
    Ok(bytes)
}

fn decode_index(bytes: &[u8]) -> Option<BookIndex> {
    if bytes.len() < INDEX_HEADER_LEN || &bytes[..INDEX_MAGIC.len()] != INDEX_MAGIC {
        return None;
    }
    let compressed_len = u64::from_le_bytes(bytes[8..16].try_into().ok()?) as usize;
    if bytes.len() != INDEX_HEADER_LEN.checked_add(compressed_len)? {
        return None;
    }
    let expected_sha256: [u8; 32] = bytes[16..48].try_into().ok()?;
    let compressed = &bytes[INDEX_HEADER_LEN..];
    let actual_sha256: [u8; 32] = Sha256::digest(compressed).into();
    if actual_sha256 != expected_sha256 {
        return None;
    }
    let mut decoder = ZlibDecoder::new(compressed);
    let mut payload = Vec::new();
    decoder.read_to_end(&mut payload).ok()?;
    let index: BookIndex = rmp_serde::from_slice(&payload).ok()?;
    (index.v == INDEX_VERSION && index.source.v == SOURCE_FINGERPRINT_VERSION).then_some(index)
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

    fn fingerprint(bytes: &[u8]) -> SourceFingerprint {
        SourceFingerprint {
            v: SOURCE_FINGERPRINT_VERSION,
            bytes: bytes.len() as u64,
            sha256: Sha256::digest(bytes).into(),
        }
    }

    fn sample_index(source: &[u8]) -> BookIndex {
        BookIndex {
            v: INDEX_VERSION,
            mtime: 42,
            source: fingerprint(source),
            chapters: vec!["中国历史".repeat(200), "philosophy".repeat(200)],
        }
    }

    #[test]
    fn compressed_index_roundtrip_preserves_chapters() {
        let index = sample_index(b"source book bytes");
        let bytes = encode_index(&index).unwrap();
        let decoded = decode_index(&bytes).unwrap();
        assert_eq!(decoded.v, INDEX_VERSION);
        assert_eq!(decoded.mtime, 42);
        assert_eq!(decoded.source, index.source);
        assert_eq!(decoded.chapters, index.chapters);
        assert!(bytes.len() < serde_json::to_vec(&index).unwrap().len());
    }

    #[test]
    fn index_rejects_bit_flips_truncation_and_trailing_bytes() {
        let encoded = encode_index(&sample_index(b"stable source")).unwrap();
        let mut flipped = encoded.clone();
        let position = INDEX_HEADER_LEN + (flipped.len() - INDEX_HEADER_LEN) / 2;
        flipped[position] ^= 0x40;
        assert!(decode_index(&flipped).is_none());
        assert!(decode_index(&encoded[..encoded.len() - 1]).is_none());
        let mut extended = encoded;
        extended.push(0);
        assert!(decode_index(&extended).is_none());
    }

    #[test]
    fn equal_mtime_and_size_do_not_hide_source_content_changes() {
        let first = fingerprint(b"book-A");
        let replacement = fingerprint(b"book-B");
        assert_eq!(first.bytes, replacement.bytes);
        assert_ne!(first.sha256, replacement.sha256);

        let index = BookIndex {
            v: INDEX_VERSION,
            mtime: 1_700_000_000,
            source: first,
            chapters: vec!["old text".into()],
        };
        // Even when a filesystem reports the exact same timestamp and length,
        // the content identity invalidates the old index.
        assert!(!index.is_current(&replacement));
    }

    #[test]
    fn imported_content_id_reuses_the_full_hash_without_reading_book_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-search-known-source-{}-{}",
            std::process::id(),
            crate::atomic_file::test_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.txt");
        std::fs::write(&path, b"known source").unwrap();
        let full = source_fingerprint(&path).unwrap();
        let content_id = full
            .sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            source_fingerprint_from_content_id(&path, &content_id).unwrap(),
            full
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_atomic_publication_keeps_the_previous_valid_index() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-search-index-atomic-{}-{}",
            std::process::id(),
            crate::atomic_file::test_nonce()
        ));
        let path = dir.join("idx_7.kpi");
        let stable = encode_index(&sample_index(b"stable source")).unwrap();
        atomic_file::write(&path, &stable).unwrap();

        let result = atomic_file::write_with(&path, |file| {
            file.write_all(b"partial replacement").unwrap();
            Err::<(), _>("injected index build failure".into())
        });
        assert!(result.is_err());
        let published = std::fs::read(&path).unwrap();
        assert_eq!(published, stable);
        assert!(decode_index(&published).is_some());
        std::fs::remove_dir_all(dir).unwrap();
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
