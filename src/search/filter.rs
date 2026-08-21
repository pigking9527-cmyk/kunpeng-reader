//! Persistent Bloom filters used to cheaply exclude impossible full-text hits.
//!
//! This module owns only the untrusted on-disk format and its bounded in-memory
//! cache. Search orchestration remains in the parent module so interactive
//! requests never synchronously extract a book or build an index.

use crate::search_core::BookSearchBloom;
use crate::search_index::{self, SourceFingerprint};
use crate::{atomic_file, memory_budget};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, Weak};

const FILTER_MAGIC: &[u8; 8] = b"KPBLOOM2";
const FILTER_HEADER_LEN: usize = 8 + 4 + 8 + 32 + 4 + 32;

struct CachedBookFilter {
    source: SourceFingerprint,
    bloom: Arc<BookSearchBloom>,
    bytes: usize,
    _permit: memory_budget::MemoryPermit,
}

struct BookFilterCache {
    entries: HashMap<u64, CachedBookFilter>,
    order: VecDeque<u64>,
    retired: Vec<(Weak<BookSearchBloom>, memory_budget::MemoryPermit)>,
    bytes: usize,
    budget: usize,
}

impl Default for BookFilterCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            retired: Vec::new(),
            bytes: 0,
            budget: memory_budget::plan().search_filter_bytes as usize,
        }
    }
}

impl BookFilterCache {
    fn sweep_retired(&mut self) {
        self.retired.retain(|(value, permit)| {
            let _ = permit.bytes();
            value.strong_count() > 0
        });
    }

    fn get(&mut self, id: u64, source: &SourceFingerprint) -> Option<Arc<BookSearchBloom>> {
        self.sweep_retired();
        let value = match self.entries.get(&id) {
            Some(entry) if entry.source == *source => Some(entry.bloom.clone()),
            Some(_) => {
                self.remove(id);
                None
            }
            None => None,
        };
        if value.is_some() {
            self.touch(id);
        }
        value
    }

    fn touch(&mut self, id: u64) {
        self.order.retain(|existing| *existing != id);
        self.order.push_back(id);
    }

    fn remove(&mut self, id: u64) {
        if let Some(entry) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
            if Arc::strong_count(&entry.bloom) > 1 {
                self.retired
                    .push((Arc::downgrade(&entry.bloom), entry._permit));
            }
        }
        self.order.retain(|existing| *existing != id);
        self.sweep_retired();
    }

    fn insert(&mut self, id: u64, source: SourceFingerprint, bloom: Arc<BookSearchBloom>) {
        self.sweep_retired();
        self.remove(id);
        let bytes = bloom.bits().len();
        if bytes > self.budget {
            return;
        }
        while self.bytes.saturating_add(bytes) > self.budget {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
        let Ok(permit) = memory_budget::governor().try_acquire(
            memory_budget::MemoryClass::SearchFilter,
            memory_budget::MemoryUsageKind::Resident,
            bytes as u64,
        ) else {
            return;
        };
        self.entries.insert(
            id,
            CachedBookFilter {
                source,
                bloom,
                bytes,
                _permit: permit,
            },
        );
        self.bytes += bytes;
        self.touch(id);
    }

    fn clear(&mut self) {
        for id in self.entries.keys().copied().collect::<Vec<_>>() {
            self.remove(id);
        }
        self.order.clear();
        self.bytes = 0;
        self.sweep_retired();
    }
}

static BOOK_FILTER_CACHE: OnceLock<Mutex<BookFilterCache>> = OnceLock::new();

fn cache() -> &'static Mutex<BookFilterCache> {
    BOOK_FILTER_CACHE.get_or_init(|| Mutex::new(BookFilterCache::default()))
}

pub(super) fn clear_memory_cache() {
    if let Ok(mut cache) = cache().try_lock() {
        cache.clear();
    }
}

pub(super) fn memory_usage() -> (u64, u32) {
    cache()
        .lock()
        .map(|cache| (cache.bytes as u64, cache.entries.len() as u32))
        .unwrap_or_default()
}

fn encode(source: &SourceFingerprint, bloom: &BookSearchBloom) -> Vec<u8> {
    let bits = bloom.bits();
    let bits_sha256: [u8; 32] = Sha256::digest(bits).into();
    let mut bytes = Vec::with_capacity(FILTER_HEADER_LEN + bits.len());
    bytes.extend_from_slice(FILTER_MAGIC);
    bytes.extend_from_slice(&source.v.to_le_bytes());
    bytes.extend_from_slice(&source.bytes.to_le_bytes());
    bytes.extend_from_slice(&source.sha256);
    bytes.extend_from_slice(&(bits.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&bits_sha256);
    bytes.extend_from_slice(bits);
    bytes
}

fn decode(bytes: &[u8], expected_source: &SourceFingerprint) -> Option<BookSearchBloom> {
    if bytes.len() < FILTER_HEADER_LEN || &bytes[..8] != FILTER_MAGIC {
        return None;
    }
    let stored_source = SourceFingerprint {
        v: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
        bytes: u64::from_le_bytes(bytes[12..20].try_into().ok()?),
        sha256: bytes[20..52].try_into().ok()?,
    };
    let length = u32::from_le_bytes(bytes[52..56].try_into().ok()?) as usize;
    let expected_bits_sha256: [u8; 32] = bytes[56..88].try_into().ok()?;
    if stored_source != *expected_source || bytes.len() != FILTER_HEADER_LEN.checked_add(length)? {
        return None;
    }
    let bits = &bytes[FILTER_HEADER_LEN..];
    let actual_bits_sha256: [u8; 32] = Sha256::digest(bits).into();
    if actual_bits_sha256 != expected_bits_sha256 {
        return None;
    }
    BookSearchBloom::from_bits(bits.to_vec())
}

pub(super) fn load(id: u64, source: &SourceFingerprint) -> Option<Arc<BookSearchBloom>> {
    if let Ok(mut cache) = cache().lock() {
        if let Some(bloom) = cache.get(id, source) {
            return Some(bloom);
        }
    }
    let bytes = std::fs::read(search_index::filter_path(id)?).ok()?;
    let bloom = Arc::new(decode(&bytes, source)?);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(id, source.clone(), bloom.clone());
    }
    Some(bloom)
}

pub(super) fn save(id: u64, source: &SourceFingerprint, chapters: &[String]) -> Result<(), String> {
    let bloom = Arc::new(BookSearchBloom::from_chapters(chapters));
    let path = search_index::filter_path(id).ok_or("无法确定检索预筛选索引目录")?;
    atomic_file::write(&path, &encode(source, &bloom))?;
    let mut cache = cache().lock().map_err(|error| error.to_string())?;
    cache.insert(id, source.clone(), bloom);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_source(bytes: &[u8]) -> SourceFingerprint {
        SourceFingerprint {
            v: 1,
            bytes: bytes.len() as u64,
            sha256: Sha256::digest(bytes).into(),
        }
    }

    #[test]
    fn file_roundtrip_checks_source_and_payload_integrity() {
        let bloom = BookSearchBloom::from_chapters(&["中国文史哲 Rust".to_string()]);
        let source = test_source(b"book-A");
        let bytes = encode(&source, &bloom);
        let decoded = decode(&bytes, &source).unwrap();
        assert!(decoded.might_contain("文史哲"));
        assert!(decoded.might_contain("RUST"));
        assert!(decode(&bytes, &test_source(b"book-B")).is_none());
        assert!(decode(&bytes[..bytes.len() - 1], &source).is_none());

        let mut flipped = bytes;
        flipped[FILTER_HEADER_LEN] ^= 0x80;
        assert!(decode(&flipped, &source).is_none());
    }

    #[test]
    fn eviction_keeps_permit_while_a_search_borrows_the_bloom() {
        let mut cache = BookFilterCache::default();
        let source = test_source(b"book");
        cache.insert(
            7,
            source.clone(),
            Arc::new(BookSearchBloom::from_chapters(&["中国文史哲".to_string()])),
        );
        let borrowed = cache.get(7, &source).unwrap();
        cache.clear();
        assert_eq!(cache.retired.len(), 1);
        drop(borrowed);
        cache.sweep_retired();
        assert!(cache.retired.is_empty());
    }
}
