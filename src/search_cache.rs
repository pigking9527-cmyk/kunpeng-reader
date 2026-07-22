use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Weak};

type TextValue = Arc<Vec<String>>;
type LowerValue = Arc<Vec<Vec<u8>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CacheKey {
    Text(u64),
    Lower(u64),
}

struct CacheEntry<T> {
    source_sha256: [u8; 32],
    value: T,
    bytes: usize,
    _permit: crate::memory_budget::MemoryPermit,
}

/// Evicting an entry must not release its global memory permit while a search
/// worker still owns an `Arc` clone. Keep only a weak reference plus the permit;
/// the payload itself remains owned by the worker and the permit is released as
/// soon as the last borrower goes away.
enum RetiredCachePermit {
    Text(Weak<Vec<String>>, crate::memory_budget::MemoryPermit),
    Lower(Weak<Vec<Vec<u8>>>, crate::memory_budget::MemoryPermit),
}

impl RetiredCachePermit {
    fn still_borrowed(&self) -> bool {
        match self {
            Self::Text(value, permit) => {
                let _ = permit.bytes();
                value.strong_count() > 0
            }
            Self::Lower(value, permit) => {
                let _ = permit.bytes();
                value.strong_count() > 0
            }
        }
    }
}

pub(crate) struct SearchTextCache {
    text: HashMap<u64, CacheEntry<TextValue>>,
    lower: HashMap<u64, CacheEntry<LowerValue>>,
    order: VecDeque<CacheKey>,
    retired: Vec<RetiredCachePermit>,
    bytes: usize,
    budget: usize,
}

impl Default for SearchTextCache {
    fn default() -> Self {
        Self::with_budget(crate::memory_budget::plan().search_text_bytes as usize)
    }
}

impl SearchTextCache {
    fn with_budget(budget: usize) -> Self {
        Self {
            text: HashMap::new(),
            lower: HashMap::new(),
            order: VecDeque::new(),
            retired: Vec::new(),
            bytes: 0,
            budget,
        }
    }

    fn touch(&mut self, key: CacheKey) {
        self.order.retain(|existing| *existing != key);
        self.order.push_back(key);
    }

    fn sweep_retired(&mut self) {
        self.retired.retain(RetiredCachePermit::still_borrowed);
    }

    fn remove(&mut self, key: CacheKey) {
        match key {
            CacheKey::Text(id) => {
                if let Some(entry) = self.text.remove(&id) {
                    self.bytes = self.bytes.saturating_sub(entry.bytes);
                    if Arc::strong_count(&entry.value) > 1 {
                        self.retired.push(RetiredCachePermit::Text(
                            Arc::downgrade(&entry.value),
                            entry._permit,
                        ));
                    }
                }
            }
            CacheKey::Lower(id) => {
                if let Some(entry) = self.lower.remove(&id) {
                    self.bytes = self.bytes.saturating_sub(entry.bytes);
                    if Arc::strong_count(&entry.value) > 1 {
                        self.retired.push(RetiredCachePermit::Lower(
                            Arc::downgrade(&entry.value),
                            entry._permit,
                        ));
                    }
                }
            }
        }
        self.order.retain(|existing| *existing != key);
        self.sweep_retired();
    }

    fn make_room(&mut self, incoming: usize) -> bool {
        if incoming > self.budget {
            return false;
        }
        while self.bytes.saturating_add(incoming) > self.budget {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
        self.bytes.saturating_add(incoming) <= self.budget
    }

    pub(crate) fn get_text(&mut self, id: u64, source_sha256: [u8; 32]) -> Option<TextValue> {
        self.sweep_retired();
        let value = match self.text.get(&id) {
            Some(entry) if entry.source_sha256 == source_sha256 => Some(entry.value.clone()),
            Some(_) => {
                self.remove(CacheKey::Text(id));
                None
            }
            None => None,
        };
        if value.is_some() {
            self.touch(CacheKey::Text(id));
        }
        value
    }

    pub(crate) fn insert_text(&mut self, id: u64, source_sha256: [u8; 32], value: TextValue) {
        self.sweep_retired();
        let key = CacheKey::Text(id);
        let bytes = value.iter().map(|chapter| chapter.len()).sum();
        self.remove(key);
        if !self.make_room(bytes) {
            return;
        }
        let Ok(permit) = crate::memory_budget::governor().try_acquire(
            crate::memory_budget::MemoryClass::SearchText,
            crate::memory_budget::MemoryUsageKind::Resident,
            bytes as u64,
        ) else {
            return;
        };
        self.text.insert(
            id,
            CacheEntry {
                source_sha256,
                value,
                bytes,
                _permit: permit,
            },
        );
        self.bytes += bytes;
        self.touch(key);
    }

    pub(crate) fn get_lower(&mut self, id: u64, source_sha256: [u8; 32]) -> Option<LowerValue> {
        self.sweep_retired();
        let value = match self.lower.get(&id) {
            Some(entry) if entry.source_sha256 == source_sha256 => Some(entry.value.clone()),
            Some(_) => {
                self.remove(CacheKey::Lower(id));
                None
            }
            None => None,
        };
        if value.is_some() {
            self.touch(CacheKey::Lower(id));
        }
        value
    }

    pub(crate) fn insert_lower(&mut self, id: u64, source_sha256: [u8; 32], value: LowerValue) {
        self.sweep_retired();
        let key = CacheKey::Lower(id);
        let bytes = value.iter().map(|chapter| chapter.len()).sum();
        self.remove(key);
        if !self.make_room(bytes) {
            return;
        }
        let Ok(permit) = crate::memory_budget::governor().try_acquire(
            crate::memory_budget::MemoryClass::SearchText,
            crate::memory_budget::MemoryUsageKind::Resident,
            bytes as u64,
        ) else {
            return;
        };
        self.lower.insert(
            id,
            CacheEntry {
                source_sha256,
                value,
                bytes,
                _permit: permit,
            },
        );
        self.bytes += bytes;
        self.touch(key);
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn entries(&self) -> usize {
        self.text.len() + self.lower.len()
    }

    pub(crate) fn clear(&mut self) {
        let keys = self.order.iter().copied().collect::<Vec<_>>();
        for key in keys {
            self.remove(key);
        }
        // Defensive cleanup for any entry that was not present in `order`.
        for id in self.text.keys().copied().collect::<Vec<_>>() {
            self.remove(CacheKey::Text(id));
        }
        for id in self.lower.keys().copied().collect::<Vec<_>>() {
            self.remove(CacheKey::Lower(id));
        }
        self.sweep_retired();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_oldest_entry_and_keeps_exact_byte_count() {
        let mut cache = SearchTextCache::with_budget(10);
        cache.insert_text(1, [1; 32], Arc::new(vec!["123456".to_string()]));
        cache.insert_text(2, [1; 32], Arc::new(vec!["abcdef".to_string()]));
        assert!(cache.get_text(1, [1; 32]).is_none());
        assert!(cache.get_text(2, [1; 32]).is_some());
        assert_eq!(cache.bytes(), 6);
    }

    #[test]
    fn lru_touch_changes_the_next_eviction_candidate() {
        let mut cache = SearchTextCache::with_budget(12);
        cache.insert_text(1, [1; 32], Arc::new(vec!["111111".to_string()]));
        cache.insert_text(2, [1; 32], Arc::new(vec!["222222".to_string()]));
        assert!(cache.get_text(1, [1; 32]).is_some());
        cache.insert_lower(3, [1; 32], Arc::new(vec![b"333333".to_vec()]));
        assert!(cache.get_text(1, [1; 32]).is_some());
        assert!(cache.get_text(2, [1; 32]).is_none());
        assert!(cache.get_lower(3, [1; 32]).is_some());
        assert_eq!(cache.entries(), 2);
    }

    #[test]
    fn stale_entry_is_removed_from_budget() {
        let mut cache = SearchTextCache::with_budget(10);
        cache.insert_text(1, [1; 32], Arc::new(vec!["123456".to_string()]));
        assert!(cache.get_text(1, [2; 32]).is_none());
        assert_eq!(cache.bytes(), 0);
        assert_eq!(cache.entries(), 0);
    }

    #[test]
    fn eviction_keeps_permit_until_the_last_arc_borrower_drops() {
        let mut cache = SearchTextCache::with_budget(10);
        cache.insert_text(1, [1; 32], Arc::new(vec!["123456".to_string()]));
        let borrowed = cache.get_text(1, [1; 32]).unwrap();
        cache.clear();
        assert_eq!(cache.entries(), 0);
        assert_eq!(cache.retired.len(), 1);
        drop(borrowed);
        cache.sweep_retired();
        assert!(cache.retired.is_empty());
    }
}
