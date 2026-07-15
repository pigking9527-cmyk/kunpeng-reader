use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

pub(crate) const SEARCH_TEXT_CACHE_BUDGET: usize = 384 * 1024 * 1024;

type TextValue = Arc<Vec<String>>;
type LowerValue = Arc<Vec<Vec<u8>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CacheKey {
    Text(u64),
    Lower(u64),
}

struct CacheEntry<T> {
    mtime: u64,
    value: T,
    bytes: usize,
}

pub(crate) struct SearchTextCache {
    text: HashMap<u64, CacheEntry<TextValue>>,
    lower: HashMap<u64, CacheEntry<LowerValue>>,
    order: VecDeque<CacheKey>,
    bytes: usize,
    budget: usize,
}

impl Default for SearchTextCache {
    fn default() -> Self {
        Self::with_budget(SEARCH_TEXT_CACHE_BUDGET)
    }
}

impl SearchTextCache {
    fn with_budget(budget: usize) -> Self {
        Self {
            text: HashMap::new(),
            lower: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            budget,
        }
    }

    fn touch(&mut self, key: CacheKey) {
        self.order.retain(|existing| *existing != key);
        self.order.push_back(key);
    }

    fn remove(&mut self, key: CacheKey) {
        let removed = match key {
            CacheKey::Text(id) => self.text.remove(&id).map(|entry| entry.bytes),
            CacheKey::Lower(id) => self.lower.remove(&id).map(|entry| entry.bytes),
        };
        if let Some(bytes) = removed {
            self.bytes = self.bytes.saturating_sub(bytes);
        }
        self.order.retain(|existing| *existing != key);
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

    pub(crate) fn get_text(&mut self, id: u64, mtime: u64) -> Option<TextValue> {
        let value = match self.text.get(&id) {
            Some(entry) if entry.mtime == mtime => Some(entry.value.clone()),
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

    pub(crate) fn insert_text(&mut self, id: u64, mtime: u64, value: TextValue) {
        let key = CacheKey::Text(id);
        let bytes = value.iter().map(|chapter| chapter.len()).sum();
        self.remove(key);
        if !self.make_room(bytes) {
            return;
        }
        self.text.insert(
            id,
            CacheEntry {
                mtime,
                value,
                bytes,
            },
        );
        self.bytes += bytes;
        self.touch(key);
    }

    pub(crate) fn get_lower(&mut self, id: u64, mtime: u64) -> Option<LowerValue> {
        let value = match self.lower.get(&id) {
            Some(entry) if entry.mtime == mtime => Some(entry.value.clone()),
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

    pub(crate) fn insert_lower(&mut self, id: u64, mtime: u64, value: LowerValue) {
        let key = CacheKey::Lower(id);
        let bytes = value.iter().map(|chapter| chapter.len()).sum();
        self.remove(key);
        if !self.make_room(bytes) {
            return;
        }
        self.lower.insert(
            id,
            CacheEntry {
                mtime,
                value,
                bytes,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_oldest_entry_and_keeps_exact_byte_count() {
        let mut cache = SearchTextCache::with_budget(10);
        cache.insert_text(1, 1, Arc::new(vec!["123456".to_string()]));
        cache.insert_text(2, 1, Arc::new(vec!["abcdef".to_string()]));
        assert!(cache.get_text(1, 1).is_none());
        assert!(cache.get_text(2, 1).is_some());
        assert_eq!(cache.bytes(), 6);
    }

    #[test]
    fn lru_touch_changes_the_next_eviction_candidate() {
        let mut cache = SearchTextCache::with_budget(12);
        cache.insert_text(1, 1, Arc::new(vec!["111111".to_string()]));
        cache.insert_text(2, 1, Arc::new(vec!["222222".to_string()]));
        assert!(cache.get_text(1, 1).is_some());
        cache.insert_lower(3, 1, Arc::new(vec![b"333333".to_vec()]));
        assert!(cache.get_text(1, 1).is_some());
        assert!(cache.get_text(2, 1).is_none());
        assert!(cache.get_lower(3, 1).is_some());
        assert_eq!(cache.entries(), 2);
    }

    #[test]
    fn stale_entry_is_removed_from_budget() {
        let mut cache = SearchTextCache::with_budget(10);
        cache.insert_text(1, 1, Arc::new(vec!["123456".to_string()]));
        assert!(cache.get_text(1, 2).is_none());
        assert_eq!(cache.bytes(), 0);
        assert_eq!(cache.entries(), 0);
    }
}
