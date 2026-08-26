//! EPUB document lifetime, virtual chapters and custom reader protocol.

mod cache_paths;
mod chapter_cache;
mod protocol_path;
mod search_rules;
mod text_conversion;
mod virtual_chapters;

use crate::epub_toc::{epub3_nav_toc, flatten_toc, TocDto};
use crate::html_sanitize::{sanitize_book_html, sanitize_epub_head, sanitize_mobi_html};
use crate::reader_protocol::{
    collect_head_assets, collect_local_stylesheet_links, collect_local_stylesheet_paths,
    extract_body_inner, get_txt_chapters, guess_mime, inline_local_stylesheet_links, is_md,
    is_mobi, md_to_html, percent_decode, rewrite_attrs, rewrite_css_url, strip_tags, txt_body,
    txt_html,
};
use crate::{book, log, reader_page, AppState, RES_BASE};
use cache_paths::{epub_entry_sizes, file_mtime_ms, meta_cache_path, meta_cache_path_for};
use chapter_cache::ProcessedChapterHtml;
use protocol_path::parse_request_path;
use search_rules::find_snippets;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;
use tauri::Manager;
use text_conversion::{convert_reader_html_text, ReaderTextConversion};
#[cfg(test)]
use virtual_chapters::TEST_VIRTUAL_CHAPTER_TARGET_BYTES;
use virtual_chapters::{
    build_virtual_chapter_map, clamp_char_boundary, clamp_highlight_chapter,
    clamp_reading_position_chapter, clamp_virtual_chapter, map_physical_chapter_to_virtual,
    remap_highlight_chapter, remap_reading_position_chapter, split_body_ranges,
    BIG_EPUB_CHAPTER_BYTES,
};

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

pub(crate) const CACHE_VERSION: u32 = 3;
const CACHE_COMPAT_VERSIONS: &[u32] = &[2, 3];
// The unified 120 MiB preload budget reserves roughly 24 MiB for the hidden
// shell and warm inner engine observed on Windows. Book content uses the
// remaining 96 MiB and is evicted by actual retained bytes, not by an arbitrary
// number of books. A repeated book ID still occupies only one LRU position.
pub(crate) const RECENT_READING_CONTENT_CACHE_BOOK_LIMIT: usize = usize::MAX;
pub(crate) const RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT: u64 = 32 * 1024 * 1024;
pub(crate) const RECENT_READING_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT: u64 = 12 * 1024 * 1024;
pub(crate) const RECENT_READING_TEXT_CACHE_BYTE_LIMIT: u64 = 44 * 1024 * 1024;
pub(crate) const RECENT_READING_RESOURCE_CACHE_BYTE_LIMIT: u64 = 8 * 1024 * 1024;
pub(crate) const RECENT_READING_CONTENT_CACHE_BYTE_LIMIT: u64 =
    RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT
        + RECENT_READING_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT
        + RECENT_READING_TEXT_CACHE_BYTE_LIMIT
        + RECENT_READING_RESOURCE_CACHE_BYTE_LIMIT;
const TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT: usize = 1;
const TRANSIENT_CHAPTER_CACHE_BYTE_LIMIT: u64 = 1024 * 1024;
const TRANSIENT_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT: u64 = 512 * 1024;
const TRANSIENT_TEXT_CACHE_BYTE_LIMIT: u64 = 8 * 1024 * 1024;
const TRANSIENT_RESOURCE_CACHE_BYTE_LIMIT: u64 = 512 * 1024;
const PDF_READ_AHEAD_BYTES: u64 = 4 * 1024 * 1024;
const PDF_READ_AHEAD_TAIL_BYTES: u64 = 256 * 1024;
const MAX_PREWARM_STYLESHEETS_PER_CHAPTER: usize = 16;
const MAX_INLINE_STYLESHEET_BYTES: usize = 256 * 1024;
const MAX_INLINE_STYLESHEETS_TOTAL_BYTES: usize = 512 * 1024;
const MAX_INLINE_INITIAL_CHAPTER_BYTES: usize = 512 * 1024;

static READER_RESOURCE_REQUEST_LOGGED: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Serialize, Deserialize)]
struct EpubVirtualChapter {
    spine_idx: usize,
    path: String,
    base_dir: String,
    part: usize,
    body_start: usize,
    body_end: usize,
}

#[derive(Clone)]
struct EpubMetaCache {
    mtime: u64,
    spine_paths: Vec<String>,
    chapter_map: HashMap<String, usize>,
    virtuals: Vec<EpubVirtualChapter>,
    toc: Vec<TocDto>,
    physical_to_virtual: Vec<u32>,
}

#[derive(Serialize, Deserialize)]
struct EpubMetaDiskCache {
    version: u32,
    mtime: u64,
    spine_paths: Vec<String>,
    virtuals: Vec<EpubVirtualChapter>,
    toc: Vec<TocDto>,
    physical_to_virtual: Vec<u32>,
}

#[derive(Serialize)]
pub(crate) struct BookInfo {
    id: String,
    content_id: String,
    title: String,
    format: String,
    word_count: u64,
    url: String,
    chapter_count: u32,
    toc: Vec<TocDto>,
    progress: f32,
    resume_chapter: u32,
    resume_frac: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_position: Option<reader_core::ReadingPosition>,
    bookmarks: Vec<book::Bookmark>,
    highlights: Vec<book::Highlight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_chapter: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub(crate) struct SearchHit {
    chapter: u32,
    snippet: String,
}

pub(crate) struct BookMetadata {
    pub(crate) author: Option<String>,
    pub(crate) description: Option<String>,
}

pub(crate) struct EpubRuntime {
    epubs: Mutex<HashMap<u64, EpubDoc>>,
    meta_cache: Mutex<HashMap<u64, Arc<EpubMetaCache>>>,
    chapter_html_cache: Mutex<ChapterHtmlCache>,
    converted_chapter_cache: Mutex<ConvertedChapterCache>,
    chapter_prepare_locks: Mutex<HashMap<ChapterCacheKey, Weak<Mutex<()>>>>,
    resource_cache: Mutex<EpubResourceCache>,
    recent_reading_content_books: Mutex<VecDeque<u64>>,
    recent_reading_chapter_cache_enabled: AtomicBool,
    prewarm_text_conversion: std::sync::atomic::AtomicU8,
}

type ChapterCacheKey = (u64, u64, usize);

/// The reader only keeps processed source for a small, recent working set.
/// Browser layout itself is intentionally not retained: it is bound to the
/// current viewport and typography, while source preparation is reusable.
#[derive(Default)]
struct ChapterHtmlCache {
    entries: HashMap<ChapterCacheKey, Arc<ProcessedChapterHtml>>,
    entry_order: VecDeque<ChapterCacheKey>,
    book_order: VecDeque<u64>,
    bytes: u64,
}

type ConvertedChapterCacheKey = (u64, u64, usize, u8);

#[derive(Default)]
struct ConvertedChapterCache {
    entries: HashMap<ConvertedChapterCacheKey, Arc<str>>,
    entry_order: VecDeque<ConvertedChapterCacheKey>,
    book_order: VecDeque<u64>,
    bytes: u64,
}

type ResourceCacheKey = (u64, u64, String);

#[derive(Clone)]
struct CachedEpubResource {
    bytes: Arc<[u8]>,
    mime: String,
}

/// Keeps the exact bytes served by the EPUB resource protocol. Resources are
/// neither parsed nor rewritten here, so CSS resolution and image/font bytes
/// remain browser-defined exactly as before. The bounded cache avoids reopening
/// and decompressing the same recent-book assets on every reader-shell reuse.
#[derive(Default)]
struct EpubResourceCache {
    entries: HashMap<ResourceCacheKey, Arc<CachedEpubResource>>,
    entry_order: VecDeque<ResourceCacheKey>,
    book_order: VecDeque<u64>,
    bytes: u64,
}

impl EpubResourceCache {
    fn touch_book(&mut self, book_id: u64) {
        self.book_order.retain(|id| *id != book_id);
        self.book_order.push_back(book_id);
    }

    fn touch_entry(&mut self, key: &ResourceCacheKey) {
        self.entry_order.retain(|existing| existing != key);
        self.entry_order.push_back(key.clone());
    }

    fn get(
        &mut self,
        book_id: u64,
        epub_mtime: u64,
        path: &str,
    ) -> Option<Arc<CachedEpubResource>> {
        let key = (book_id, epub_mtime, path.to_string());
        let resource = Arc::clone(self.entries.get(&key)?);
        self.touch_book(book_id);
        self.touch_entry(&key);
        Some(resource)
    }

    fn contains(&self, book_id: u64, epub_mtime: u64, path: &str) -> bool {
        self.entries
            .contains_key(&(book_id, epub_mtime, path.to_string()))
    }

    fn remove(&mut self, key: &ResourceCacheKey) {
        if let Some(resource) = self.entries.remove(key) {
            self.bytes = self
                .bytes
                .saturating_sub(u64::try_from(resource.bytes.len()).unwrap_or(u64::MAX));
        }
        self.entry_order.retain(|existing| existing != key);
        if !self.entries.keys().any(|existing| existing.0 == key.0) {
            self.book_order.retain(|book_id| *book_id != key.0);
        }
    }

    fn remove_book(&mut self, book_id: u64) {
        let keys: Vec<ResourceCacheKey> = self
            .entries
            .keys()
            .filter(|key| key.0 == book_id)
            .cloned()
            .collect();
        for key in keys {
            self.remove(&key);
        }
        self.book_order.retain(|id| *id != book_id);
    }

    fn insert(
        &mut self,
        book_id: u64,
        epub_mtime: u64,
        path: String,
        resource: Arc<CachedEpubResource>,
        book_limit: usize,
        byte_limit: u64,
    ) {
        let stale_generations: Vec<ResourceCacheKey> = self
            .entries
            .keys()
            .filter(|key| key.0 == book_id && key.2 == path && key.1 != epub_mtime)
            .cloned()
            .collect();
        for stale in stale_generations {
            self.remove(&stale);
        }
        let key = (book_id, epub_mtime, path);
        self.remove(&key);
        self.bytes = self
            .bytes
            .saturating_add(u64::try_from(resource.bytes.len()).unwrap_or(u64::MAX));
        self.entries.insert(key.clone(), resource);
        self.touch_book(book_id);
        self.touch_entry(&key);
        while self.book_order.len() > book_limit {
            if let Some(oldest) = self.book_order.pop_front() {
                self.remove_book(oldest);
            }
        }
        while self.bytes > byte_limit {
            let Some(oldest) = self.entry_order.pop_front() else {
                break;
            };
            self.remove(&oldest);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.entry_order.clear();
        self.book_order.clear();
        self.bytes = 0;
    }
}

impl ChapterHtmlCache {
    fn chapter_bytes(chapter: &ProcessedChapterHtml) -> u64 {
        u64::try_from(chapter.head.len())
            .unwrap_or(u64::MAX)
            .saturating_add(u64::try_from(chapter.body.len()).unwrap_or(u64::MAX))
    }

    fn touch_book(&mut self, book_id: u64) {
        self.book_order.retain(|id| *id != book_id);
        self.book_order.push_back(book_id);
    }

    fn touch_entry(&mut self, key: ChapterCacheKey) {
        self.entry_order.retain(|existing| *existing != key);
        self.entry_order.push_back(key);
    }

    fn get(&mut self, key: ChapterCacheKey) -> Option<Arc<ProcessedChapterHtml>> {
        let chapter = Arc::clone(self.entries.get(&key)?);
        self.touch_book(key.0);
        self.touch_entry(key);
        Some(chapter)
    }

    fn remove(&mut self, key: ChapterCacheKey) {
        if let Some(chapter) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(Self::chapter_bytes(&chapter));
        }
        self.entry_order.retain(|existing| *existing != key);
        if !self.entries.keys().any(|existing| existing.0 == key.0) {
            self.book_order.retain(|book_id| *book_id != key.0);
        }
    }

    fn remove_book(&mut self, book_id: u64) {
        let keys: Vec<ChapterCacheKey> = self
            .entries
            .keys()
            .copied()
            .filter(|key| key.0 == book_id)
            .collect();
        for key in keys {
            self.remove(key);
        }
        self.book_order.retain(|id| *id != book_id);
    }

    fn insert(
        &mut self,
        key: ChapterCacheKey,
        chapter: Arc<ProcessedChapterHtml>,
        book_limit: usize,
        byte_limit: u64,
    ) {
        self.remove(key);
        self.bytes = self.bytes.saturating_add(Self::chapter_bytes(&chapter));
        self.entries.insert(key, chapter);
        self.touch_book(key.0);
        self.touch_entry(key);
        while self.book_order.len() > book_limit {
            if let Some(book_id) = self.book_order.pop_front() {
                self.remove_book(book_id);
            }
        }
        while self.bytes > byte_limit {
            let Some(oldest) = self.entry_order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.entry_order.clear();
        self.book_order.clear();
        self.bytes = 0;
    }
}

impl ConvertedChapterCache {
    fn touch_book(&mut self, book_id: u64) {
        self.book_order.retain(|id| *id != book_id);
        self.book_order.push_back(book_id);
    }

    fn touch_entry(&mut self, key: ConvertedChapterCacheKey) {
        self.entry_order.retain(|existing| *existing != key);
        self.entry_order.push_back(key);
    }

    fn get(&mut self, key: ConvertedChapterCacheKey) -> Option<Arc<str>> {
        let body = Arc::clone(self.entries.get(&key)?);
        self.touch_book(key.0);
        self.touch_entry(key);
        Some(body)
    }

    fn remove(&mut self, key: ConvertedChapterCacheKey) {
        if let Some(body) = self.entries.remove(&key) {
            self.bytes = self
                .bytes
                .saturating_sub(u64::try_from(body.len()).unwrap_or(u64::MAX));
        }
        self.entry_order.retain(|existing| *existing != key);
        if !self.entries.keys().any(|existing| existing.0 == key.0) {
            self.book_order.retain(|book_id| *book_id != key.0);
        }
    }

    fn remove_book(&mut self, book_id: u64) {
        let keys: Vec<ConvertedChapterCacheKey> = self
            .entries
            .keys()
            .copied()
            .filter(|key| key.0 == book_id)
            .collect();
        for key in keys {
            self.remove(key);
        }
        self.book_order.retain(|id| *id != book_id);
    }

    fn insert(
        &mut self,
        key: ConvertedChapterCacheKey,
        body: Arc<str>,
        book_limit: usize,
        byte_limit: u64,
    ) {
        let stale_generations: Vec<ConvertedChapterCacheKey> = self
            .entries
            .keys()
            .copied()
            .filter(|existing| {
                existing.0 == key.0
                    && existing.2 == key.2
                    && existing.3 == key.3
                    && existing.1 != key.1
            })
            .collect();
        for stale in stale_generations {
            self.remove(stale);
        }
        self.remove(key);
        self.bytes = self
            .bytes
            .saturating_add(u64::try_from(body.len()).unwrap_or(u64::MAX));
        self.entries.insert(key, body);
        self.touch_book(key.0);
        self.touch_entry(key);
        while self.book_order.len() > book_limit {
            if let Some(book_id) = self.book_order.pop_front() {
                self.remove_book(book_id);
            }
        }
        while self.bytes > byte_limit {
            let Some(oldest) = self.entry_order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.entry_order.clear();
        self.book_order.clear();
        self.bytes = 0;
    }
}

fn cached_converted_chapter_body(
    state: &AppState,
    key: ChapterCacheKey,
    chapter: &ProcessedChapterHtml,
    conversion: ReaderTextConversion,
) -> Option<Arc<str>> {
    if conversion == ReaderTextConversion::Original {
        return None;
    }
    let converted_key = (key.0, key.1, key.2, conversion.cache_tag());
    if let Some(body) = state
        .epub_runtime
        .converted_chapter_cache
        .lock()
        .unwrap()
        .get(converted_key)
    {
        return Some(body);
    }
    if let Some(body) = chapter_cache::load_converted(
        key.0,
        key.1,
        key.2,
        conversion.cache_tag(),
        CACHE_COMPAT_VERSIONS,
    ) {
        let (book_limit, byte_limit) = state.epub_runtime.converted_chapter_cache_limits();
        state
            .epub_runtime
            .converted_chapter_cache
            .lock()
            .unwrap()
            .insert(converted_key, Arc::clone(&body), book_limit, byte_limit);
        return Some(body);
    }
    let body: Arc<str> = Arc::from(convert_reader_html_text(&chapter.body, conversion));
    chapter_cache::save_converted(
        key.0,
        key.1,
        key.2,
        CACHE_VERSION,
        conversion.cache_tag(),
        &body,
    );
    let (book_limit, byte_limit) = state.epub_runtime.converted_chapter_cache_limits();
    state
        .epub_runtime
        .converted_chapter_cache
        .lock()
        .unwrap()
        .insert(converted_key, Arc::clone(&body), book_limit, byte_limit);
    Some(body)
}

/// A bounded, content-free view of the caches affected by book preparation.
/// The byte count covers retained processed chapters and parsed text-family
/// books; it deliberately does not claim to be the process RSS.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderPreloadCacheStatus {
    epub_documents: u32,
    metadata_entries: u32,
    chapter_entries: u32,
    chapter_html_bytes: u64,
    recent_reading_chapter_cache_enabled: bool,
    recent_reading_chapter_books: u32,
    recent_reading_chapter_limit_bytes: u64,
}

impl Default for EpubRuntime {
    fn default() -> Self {
        Self {
            epubs: Mutex::new(HashMap::new()),
            meta_cache: Mutex::new(HashMap::new()),
            chapter_html_cache: Mutex::new(ChapterHtmlCache::default()),
            converted_chapter_cache: Mutex::new(ConvertedChapterCache::default()),
            chapter_prepare_locks: Mutex::new(HashMap::new()),
            resource_cache: Mutex::new(EpubResourceCache::default()),
            recent_reading_content_books: Mutex::new(VecDeque::new()),
            recent_reading_chapter_cache_enabled: AtomicBool::new(false),
            prewarm_text_conversion: std::sync::atomic::AtomicU8::new(
                ReaderTextConversion::ToSimplified.cache_tag(),
            ),
        }
    }
}

impl EpubRuntime {
    fn chapter_prepare_lock(&self, key: ChapterCacheKey) -> Arc<Mutex<()>> {
        let mut locks = self.chapter_prepare_locks.lock().unwrap();
        // The map keeps only weak references. Completed preparations therefore
        // disappear on the next lookup instead of growing with the library.
        locks.retain(|_, existing| existing.strong_count() > 0);
        if let Some(existing) = locks.get(&key).and_then(Weak::upgrade) {
            return existing;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    pub(crate) fn clear(&self) {
        self.epubs.lock().map(|mut cache| cache.clear()).ok();
        self.meta_cache.lock().map(|mut cache| cache.clear()).ok();
        self.chapter_html_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        self.converted_chapter_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        self.chapter_prepare_locks
            .lock()
            .map(|mut locks| locks.clear())
            .ok();
        self.resource_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        self.recent_reading_content_books
            .lock()
            .map(|mut books| books.clear())
            .ok();
    }

    fn chapter_cache_limits(&self) -> (usize, u64) {
        if self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            (
                RECENT_READING_CONTENT_CACHE_BOOK_LIMIT,
                RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT,
            )
        } else {
            (
                TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT,
                TRANSIENT_CHAPTER_CACHE_BYTE_LIMIT,
            )
        }
    }

    fn converted_chapter_cache_limits(&self) -> (usize, u64) {
        if self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            (
                RECENT_READING_CONTENT_CACHE_BOOK_LIMIT,
                RECENT_READING_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT,
            )
        } else {
            (
                TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT,
                TRANSIENT_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT,
            )
        }
    }

    fn set_prewarm_text_conversion(&self, conversion: ReaderTextConversion) {
        self.prewarm_text_conversion
            .store(conversion.cache_tag(), Ordering::Release);
    }

    fn prewarm_text_conversion(&self) -> ReaderTextConversion {
        ReaderTextConversion::from_cache_tag(self.prewarm_text_conversion.load(Ordering::Acquire))
    }

    fn resource_cache_limits(&self) -> (usize, u64) {
        if self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            (
                RECENT_READING_CONTENT_CACHE_BOOK_LIMIT,
                RECENT_READING_RESOURCE_CACHE_BYTE_LIMIT,
            )
        } else {
            (
                TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT,
                TRANSIENT_RESOURCE_CACHE_BYTE_LIMIT,
            )
        }
    }

    pub(crate) fn text_chapter_cache_limits(&self) -> (usize, u64) {
        if self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            (
                RECENT_READING_CONTENT_CACHE_BOOK_LIMIT,
                RECENT_READING_TEXT_CACHE_BYTE_LIMIT,
            )
        } else {
            (
                TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT,
                TRANSIENT_TEXT_CACHE_BYTE_LIMIT,
            )
        }
    }

    fn set_recent_reading_chapter_cache_enabled(&self, enabled: bool) {
        self.recent_reading_chapter_cache_enabled
            .store(enabled, Ordering::Release);
    }

    fn remember_recent_reading_content_book(&self, id: u64) -> Vec<u64> {
        if !self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            return Vec::new();
        }
        let mut books = self.recent_reading_content_books.lock().unwrap();
        books.retain(|existing| *existing != id);
        books.push_back(id);
        Vec::new()
    }

    fn clear_recent_reading_content_cache(&self) {
        let ids = self
            .recent_reading_content_books
            .lock()
            .map(|mut books| books.drain(..).collect::<Vec<_>>())
            .unwrap_or_default();
        self.chapter_html_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        self.converted_chapter_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        self.resource_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
        if let Ok(mut epubs) = self.epubs.lock() {
            for id in &ids {
                epubs.remove(id);
            }
        }
        if let Ok(mut metadata) = self.meta_cache.lock() {
            for id in &ids {
                metadata.remove(id);
            }
        }
    }

    fn evict_recent_reading_content_book(&self, id: u64) {
        self.chapter_html_cache
            .lock()
            .map(|mut cache| cache.remove_book(id))
            .ok();
        self.converted_chapter_cache
            .lock()
            .map(|mut cache| cache.remove_book(id))
            .ok();
        self.resource_cache
            .lock()
            .map(|mut cache| cache.remove_book(id))
            .ok();
        self.epubs.lock().map(|mut epubs| epubs.remove(&id)).ok();
        self.meta_cache
            .lock()
            .map(|mut metadata| metadata.remove(&id))
            .ok();
    }
}

pub(crate) fn set_recent_reading_content_cache_enabled(
    state: &AppState,
    enabled: bool,
    text_conversion: &str,
) {
    state
        .epub_runtime
        .set_recent_reading_chapter_cache_enabled(enabled);
    state
        .epub_runtime
        .set_prewarm_text_conversion(ReaderTextConversion::parse(text_conversion));
    if !enabled {
        clear_recent_reading_content_cache(state);
    }
}

pub(crate) fn clear_recent_reading_content_cache(state: &AppState) {
    state.epub_runtime.clear_recent_reading_content_cache();
    state
        .txt_chapters
        .lock()
        .map(|mut chapters| chapters.clear())
        .ok();
}

/// Removes only one book from the in-memory reader-preload working set.
/// Benchmarks use this to measure a cold ordinary open without destroying the
/// user's prepared content for every other book or touching persistent caches.
pub(crate) fn evict_recent_reading_content_book(state: &AppState, id: u64) {
    state
        .epub_runtime
        .recent_reading_content_books
        .lock()
        .map(|mut books| books.retain(|existing| *existing != id))
        .ok();
    state.epub_runtime.evict_recent_reading_content_book(id);
    state
        .txt_chapters
        .lock()
        .map(|mut chapters| chapters.remove(id))
        .ok();
}

pub(crate) fn reader_preload_cache_status(state: &AppState) -> ReaderPreloadCacheStatus {
    let epub_documents = state
        .epub_runtime
        .epubs
        .lock()
        .map(|items| items.len())
        .unwrap_or(0);
    let metadata_entries = state
        .epub_runtime
        .meta_cache
        .lock()
        .map(|items| items.len())
        .unwrap_or(0);
    let (chapter_entries, chapter_html_bytes) = state
        .epub_runtime
        .chapter_html_cache
        .lock()
        .map(|items| (items.entries.len(), items.bytes))
        .unwrap_or((0, 0));
    let resource_bytes = state
        .epub_runtime
        .resource_cache
        .lock()
        .map(|items| items.bytes)
        .unwrap_or(0);
    let converted_chapter_bytes = state
        .epub_runtime
        .converted_chapter_cache
        .lock()
        .map(|items| items.bytes)
        .unwrap_or(0);
    let text_chapter_bytes = state
        .txt_chapters
        .lock()
        .map(|items| items.bytes())
        .unwrap_or(0);
    let recent_reading_chapter_books = state
        .epub_runtime
        .recent_reading_content_books
        .lock()
        .map(|books| books.len())
        .unwrap_or(0);
    ReaderPreloadCacheStatus {
        epub_documents: u32::try_from(epub_documents).unwrap_or(u32::MAX),
        metadata_entries: u32::try_from(metadata_entries).unwrap_or(u32::MAX),
        chapter_entries: u32::try_from(chapter_entries).unwrap_or(u32::MAX),
        chapter_html_bytes: chapter_html_bytes
            .saturating_add(converted_chapter_bytes)
            .saturating_add(text_chapter_bytes)
            .saturating_add(resource_bytes),
        recent_reading_chapter_cache_enabled: state
            .epub_runtime
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire),
        recent_reading_chapter_books: u32::try_from(recent_reading_chapter_books)
            .unwrap_or(u32::MAX),
        recent_reading_chapter_limit_bytes: RECENT_READING_CONTENT_CACHE_BYTE_LIMIT,
    }
}

pub(crate) fn read_book_metadata(path: &Path) -> Option<BookMetadata> {
    let doc = EpubDoc::new(path).ok()?;
    Some(BookMetadata {
        author: doc.mdata("creator").map(|metadata| metadata.value.clone()),
        description: doc
            .mdata("description")
            .map(|metadata| crate::html_sanitize::html_to_plain_text(&metadata.value)),
    })
}

fn ensure_epub_loaded(state: &AppState, id: u64) -> Result<(), String> {
    {
        let epubs = state.epub_runtime.epubs.lock().unwrap();
        if epubs.contains_key(&id) {
            return Ok(());
        }
    }
    let path = {
        let library = state.library.lock().unwrap();
        library.get(id).ok_or("找不到这本书")?.path.clone()
    };
    // Opening/parsing an EPUB touches disk and can be slow. Keep that work outside
    // the global EPUB cache lock so concurrent cover/resource requests are not blocked.
    let doc = EpubDoc::new(&path).map_err(|_| "无法打开 EPUB 文件".to_string())?;
    let mut epubs = state.epub_runtime.epubs.lock().unwrap();
    if epubs.contains_key(&id) {
        return Ok(());
    }
    epubs.insert(id, doc);
    Ok(())
}

fn load_epub_meta_disk_cache(id: u64, mtime: u64) -> Option<Arc<EpubMetaCache>> {
    for version in CACHE_COMPAT_VERSIONS {
        let Some(path) = meta_cache_path_for(id, mtime, *version) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(disk) = serde_json::from_slice::<EpubMetaDiskCache>(&bytes) else {
            continue;
        };
        if !CACHE_COMPAT_VERSIONS.contains(&disk.version)
            || disk.mtime != mtime
            || disk.spine_paths.is_empty()
            || disk.virtuals.is_empty()
        {
            continue;
        }
        let chapter_map = build_virtual_chapter_map(&disk.spine_paths, &disk.physical_to_virtual);
        return Some(Arc::new(EpubMetaCache {
            mtime,
            spine_paths: disk.spine_paths,
            chapter_map,
            virtuals: disk.virtuals,
            toc: disk.toc,
            physical_to_virtual: disk.physical_to_virtual,
        }));
    }
    None
}

fn save_epub_meta_disk_cache(id: u64, meta: &EpubMetaCache) {
    let Some(path) = meta_cache_path(id, meta.mtime, CACHE_VERSION) else {
        return;
    };
    let disk = EpubMetaDiskCache {
        version: CACHE_VERSION,
        mtime: meta.mtime,
        spine_paths: meta.spine_paths.clone(),
        virtuals: meta.virtuals.clone(),
        toc: meta.toc.clone(),
        physical_to_virtual: meta.physical_to_virtual.clone(),
    };
    if let Ok(bytes) = serde_json::to_vec(&disk) {
        let _ = std::fs::write(path, bytes);
    }
}

fn extract_head_asset_source(html: &str) -> &str {
    if let Some(body_start) = html.find("<body").or_else(|| html.find("<BODY")) {
        return &html[..body_start];
    }
    html
}

fn build_epub_meta_cache(
    state: &AppState,
    id: u64,
    mtime: u64,
    path: &Path,
) -> Result<Arc<EpubMetaCache>, String> {
    ensure_epub_loaded(state, id)?;
    let mut epubs = state.epub_runtime.epubs.lock().unwrap();
    let doc = epubs.get_mut(&id).ok_or("无法打开 EPUB")?;
    let entry_sizes = epub_entry_sizes(path);

    let spine_paths: Vec<String> = doc
        .spine
        .iter()
        .filter_map(|spine| doc.resources.get(&spine.idref))
        .map(|resource| resource.path.to_string_lossy().replace('\\', "/"))
        .collect();

    let mut virtuals = Vec::new();
    let mut physical_to_virtual = Vec::with_capacity(spine_paths.len());
    for (spine_idx, chapter_path) in spine_paths.iter().enumerate() {
        physical_to_virtual.push(virtuals.len() as u32);
        let base_dir = chapter_path
            .rsplit_once('/')
            .map(|(directory, _)| directory)
            .unwrap_or("")
            .to_string();
        let ranges = if entry_sizes
            .get(chapter_path)
            .copied()
            .is_some_and(|size| size <= BIG_EPUB_CHAPTER_BYTES)
        {
            vec![(0, usize::MAX)]
        } else {
            let html = doc
                .get_resource_str_by_path(chapter_path)
                .unwrap_or_default();
            let body = extract_body_inner(&html);
            split_body_ranges(body, html.len())
        };
        for (part, (body_start, body_end)) in ranges.into_iter().enumerate() {
            virtuals.push(EpubVirtualChapter {
                spine_idx,
                path: chapter_path.clone(),
                base_dir: base_dir.clone(),
                part,
                body_start,
                body_end,
            });
        }
    }

    let chapter_map = build_virtual_chapter_map(&spine_paths, &physical_to_virtual);
    let mut toc = Vec::new();
    flatten_toc(&doc.toc, 0, &chapter_map, &mut toc);
    if toc.is_empty() {
        toc = epub3_nav_toc(doc, &chapter_map);
    }

    let meta = Arc::new(EpubMetaCache {
        mtime,
        spine_paths,
        chapter_map,
        virtuals,
        toc,
        physical_to_virtual,
    });
    save_epub_meta_disk_cache(id, &meta);
    log(&format!(
        "epub_meta id={id} physical={} virtual={} toc={}",
        meta.spine_paths.len(),
        meta.virtuals.len(),
        meta.toc.len()
    ));
    Ok(meta)
}

fn ensure_epub_meta(state: &AppState, id: u64) -> Result<Arc<EpubMetaCache>, String> {
    let path = {
        let library = state.library.lock().unwrap();
        library.get(id).ok_or("找不到这本书")?.path.clone()
    };
    let mtime = file_mtime_ms(&path);
    {
        let cache = state.epub_runtime.meta_cache.lock().unwrap();
        if let Some(meta) = cache.get(&id) {
            if meta.mtime == mtime {
                return Ok(Arc::clone(meta));
            }
        }
    }
    if let Some(meta) = load_epub_meta_disk_cache(id, mtime) {
        state
            .epub_runtime
            .meta_cache
            .lock()
            .unwrap()
            .insert(id, Arc::clone(&meta));
        return Ok(meta);
    }
    let meta = build_epub_meta_cache(state, id, mtime, &path)?;
    state
        .epub_runtime
        .meta_cache
        .lock()
        .unwrap()
        .insert(id, Arc::clone(&meta));
    Ok(meta)
}

pub(crate) fn map_physical_chapter_for_book(
    state: &AppState,
    id: u64,
    chapter: u32,
) -> Result<u32, String> {
    ensure_epub_meta(state, id).map(|meta| map_physical_chapter_to_virtual(&meta, chapter))
}

pub(crate) fn prewarm_book_data(state: &AppState, id: u64) -> Result<(), String> {
    let (format, resume_chapter, chapter_index_version, path) = {
        let library = state.library.lock().unwrap();
        let book = library.get(id).ok_or("找不到这本书")?;
        (
            book.format.clone(),
            book.resume_chapter,
            book.chapter_index_version,
            book.path.clone(),
        )
    };
    if format == "pdf" {
        return prewarm_pdf_source(&path);
    }
    if format != "epub" {
        let chapters = get_txt_chapters(state, id).ok_or_else(|| "无法预热图书内容".to_string())?;
        let chapter_index = usize::try_from(resume_chapter)
            .unwrap_or(usize::MAX)
            .min(chapters.len().saturating_sub(1));
        let chapter = process_text_chapter(state, id, chapter_index, &format)
            .ok_or_else(|| "无法预热续读内容".to_string())?;
        let conversion = state.epub_runtime.prewarm_text_conversion();
        let _ = cached_converted_chapter_body(
            state,
            (id, file_mtime_ms(&path), chapter_index),
            &chapter,
            conversion,
        );
        return Ok(());
    }
    let meta = ensure_epub_meta(state, id)?;
    let chapter_index = if chapter_index_version < CACHE_VERSION {
        map_physical_chapter_to_virtual(&meta, resume_chapter)
    } else {
        clamp_virtual_chapter(&meta, resume_chapter)
    } as usize;
    let chapter = process_virtual_chapter(state, id, chapter_index, &meta)
        .ok_or_else(|| "无法预热续读章节".to_string())?;
    prewarm_chapter_stylesheets(state, id, meta.mtime, &chapter.head);
    let conversion = state.epub_runtime.prewarm_text_conversion();
    let _ =
        cached_converted_chapter_body(state, (id, meta.mtime, chapter_index), &chapter, conversion);
    Ok(())
}

fn prewarm_pdf_source(path: &Path) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let head_bytes = length.min(PDF_READ_AHEAD_BYTES);
    let mut head = vec![0u8; usize::try_from(head_bytes).unwrap_or(0)];
    file.read_exact(&mut head)
        .map_err(|error| error.to_string())?;
    if length > head_bytes {
        let tail_bytes = length.min(PDF_READ_AHEAD_TAIL_BYTES);
        file.seek(SeekFrom::Start(length.saturating_sub(tail_bytes)))
            .map_err(|error| error.to_string())?;
        let mut tail = vec![0u8; usize::try_from(tail_bytes).unwrap_or(0)];
        file.read_exact(&mut tail)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn retain_recent_prepared_book(state: &AppState, id: u64) {
    for evicted in state.epub_runtime.remember_recent_reading_content_book(id) {
        state
            .epub_runtime
            .evict_recent_reading_content_book(evicted);
        state
            .txt_chapters
            .lock()
            .map(|mut chapters| chapters.remove(evicted))
            .ok();
    }
}

fn recent_reading_prewarm_order(mut ids: Vec<(u64, u64)>) -> Vec<u64> {
    ids.sort_unstable_by(|(left_id, left_at), (right_id, right_at)| {
        right_at.cmp(left_at).then_with(|| right_id.cmp(left_id))
    });
    ids.into_iter().map(|(id, _)| id).collect()
}

/// Warms the resume content for the most recently read supported books. EPUB,
/// text, Markdown and MOBI-family books retain processed content; PDF performs
/// bounded file read-ahead without keeping an entire large document in RAM.
pub(crate) fn prewarm_recent_reading_chapters(state: &AppState) {
    if !state
        .epub_runtime
        .recent_reading_chapter_cache_enabled
        .load(Ordering::Acquire)
    {
        return;
    }
    let ids: Vec<(u64, u64)> = state
        .library
        .lock()
        .map(|library| {
            library
                .books
                .iter()
                .filter(|book| book.path.exists())
                .map(|book| (book.id, book.last_read_at))
                .collect()
        })
        .unwrap_or_default();
    // Do expensive I/O newest-first. Successful entries are registered in
    // reverse afterwards so the LRU still ends with the genuinely newest book.
    let recent = recent_reading_prewarm_order(ids);
    let mut prepared = Vec::with_capacity(recent.len());
    for id in recent {
        if crate::window_commands::recent_reading_cache_should_yield()
            || !state
                .epub_runtime
                .recent_reading_chapter_cache_enabled
                .load(Ordering::Acquire)
        {
            break;
        }
        if prewarm_book_data(state, id).is_ok() {
            prepared.push(id);
        }
        if crate::window_commands::recent_reading_cache_should_yield() {
            break;
        }
        std::thread::yield_now();
    }
    for id in prepared.into_iter().rev() {
        retain_recent_prepared_book(state, id);
    }
}

#[tauri::command]
pub(crate) async fn prewarm_book(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // 书架悬停只预热图书的续读内容；隐藏阅读窗口由预加载
    // 开关、主窗口显示和换书补池提前准备，点击图书时直接消费，绝不把
    // 指针悬停变成窗口创建动作。
    let id = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        prewarm_book_data(state.inner(), id)
    })
    .await
    .map_err(|error| format!("图书预热任务失败：{error}"))?
}

fn process_text_chapter(
    state: &AppState,
    id: u64,
    index: usize,
    format: &str,
) -> Option<Arc<ProcessedChapterHtml>> {
    let path = state.library.lock().unwrap().get(id)?.path.clone();
    let key = (id, file_mtime_ms(&path), index);
    {
        let mut cache = state.epub_runtime.chapter_html_cache.lock().unwrap();
        if let Some(chapter) = cache.get(key) {
            return Some(chapter);
        }
    }
    let prepare_lock = state.epub_runtime.chapter_prepare_lock(key);
    let _prepare_guard = prepare_lock.lock().ok()?;
    // Pointer-down prewarming and the reader's real request can arrive within
    // the same 160 ms click window. Only the first caller prepares the chapter;
    // the second reuses its completed cache entry instead of parsing twice.
    {
        let mut cache = state.epub_runtime.chapter_html_cache.lock().unwrap();
        if let Some(chapter) = cache.get(key) {
            return Some(chapter);
        }
    }
    let chapters = get_txt_chapters(state, id)?;
    let raw = chapters.get(index).map(|(_, chapter)| chapter.as_str())?;
    let body = if is_mobi(format) {
        format!("<div class=\"mobi-body\">{}</div>", sanitize_mobi_html(raw))
    } else if is_md(format) {
        format!(
            "<div class=\"md-body\">{}</div>",
            sanitize_book_html(&md_to_html(raw))
        )
    } else {
        txt_body(raw)
    };
    let chapter = Arc::new(ProcessedChapterHtml {
        head: String::new(),
        body,
    });
    let (book_limit, byte_limit) = state.epub_runtime.chapter_cache_limits();
    state
        .epub_runtime
        .chapter_html_cache
        .lock()
        .unwrap()
        .insert(key, Arc::clone(&chapter), book_limit, byte_limit);
    Some(chapter)
}

fn process_virtual_chapter(
    state: &AppState,
    id: u64,
    index: usize,
    meta: &EpubMetaCache,
) -> Option<Arc<ProcessedChapterHtml>> {
    let key = (id, meta.mtime, index);
    {
        let mut cache = state.epub_runtime.chapter_html_cache.lock().unwrap();
        if let Some(chapter) = cache.get(key) {
            return Some(chapter);
        }
    }
    let prepare_lock = state.epub_runtime.chapter_prepare_lock(key);
    let _prepare_guard = prepare_lock.lock().ok()?;
    {
        let mut cache = state.epub_runtime.chapter_html_cache.lock().unwrap();
        if let Some(chapter) = cache.get(key) {
            return Some(chapter);
        }
    }
    if let Some(chapter) = chapter_cache::load(id, meta.mtime, index, CACHE_COMPAT_VERSIONS) {
        let (book_limit, byte_limit) = state.epub_runtime.chapter_cache_limits();
        state
            .epub_runtime
            .chapter_html_cache
            .lock()
            .unwrap()
            .insert(key, Arc::clone(&chapter), book_limit, byte_limit);
        return Some(chapter);
    }

    ensure_epub_loaded(state, id).ok()?;
    let virtual_chapter = meta.virtuals.get(index)?;
    // EpubDoc is stateful, so archive access needs a lock.  Keep it only for
    // the actual ZIP read: sanitising HTML and writing the disk cache can take
    // much longer and used to block every other chapter/resource request.
    let html = {
        let mut epubs = state.epub_runtime.epubs.lock().unwrap();
        let doc = epubs.get_mut(&id)?;
        doc.get_resource_str_by_path(&virtual_chapter.path)
            .unwrap_or_default()
    };
    let head_source = extract_head_asset_source(&html);
    let rewritten_head = rewrite_css_url(
        &rewrite_attrs(
            head_source,
            id,
            &virtual_chapter.base_dir,
            &meta.chapter_map,
        ),
        id,
        &virtual_chapter.base_dir,
    );
    let mut head = String::new();
    let mut seen = std::collections::HashSet::new();
    collect_head_assets(&rewritten_head, &mut head, &mut seen);
    let head = sanitize_epub_head(&head);

    let raw_body = extract_body_inner(&html);
    let start = clamp_char_boundary(raw_body, virtual_chapter.body_start.min(raw_body.len()));
    let end =
        clamp_char_boundary(raw_body, virtual_chapter.body_end.min(raw_body.len())).max(start);
    let fragment = &raw_body[start..end];
    let body = rewrite_css_url(
        &rewrite_attrs(fragment, id, &virtual_chapter.base_dir, &meta.chapter_map),
        id,
        &virtual_chapter.base_dir,
    );
    let body = sanitize_book_html(&body);
    let body = if meta
        .virtuals
        .iter()
        .filter(|chapter| chapter.spine_idx == virtual_chapter.spine_idx)
        .count()
        > 1
    {
        format!(
            "<section class=\"rr-virtual-chapter\" data-spine=\"{}\" data-part=\"{}\">{}</section>",
            virtual_chapter.spine_idx, virtual_chapter.part, body
        )
    } else {
        body
    };
    let chapter = Arc::new(ProcessedChapterHtml { head, body });
    chapter_cache::save(id, meta.mtime, index, CACHE_VERSION, &chapter);
    let (book_limit, byte_limit) = state.epub_runtime.chapter_cache_limits();
    state
        .epub_runtime
        .chapter_html_cache
        .lock()
        .unwrap()
        .insert(key, Arc::clone(&chapter), book_limit, byte_limit);
    Some(chapter)
}

fn cache_epub_resource(
    state: &AppState,
    id: u64,
    epub_mtime: u64,
    path: String,
    bytes: Vec<u8>,
    mime: String,
) {
    let (book_limit, byte_limit) = state.epub_runtime.resource_cache_limits();
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > byte_limit {
        return;
    }
    let resource = Arc::new(CachedEpubResource {
        bytes: Arc::from(bytes),
        mime,
    });
    state
        .epub_runtime
        .resource_cache
        .lock()
        .map(|mut cache| cache.insert(id, epub_mtime, path, resource, book_limit, byte_limit))
        .ok();
}

fn read_epub_resource(state: &AppState, id: u64, path: &str) -> Option<(Vec<u8>, String)> {
    let epub_mtime = {
        let library = state.library.lock().ok()?;
        file_mtime_ms(&library.get(id)?.path)
    };
    if let Some(resource) = state
        .epub_runtime
        .resource_cache
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(id, epub_mtime, path))
    {
        return Some((resource.bytes.as_ref().to_vec(), resource.mime.clone()));
    }

    ensure_epub_loaded(state, id).ok()?;
    let archive_path = PathBuf::from(path);
    let (bytes, mime) = {
        let mut epubs = state.epub_runtime.epubs.lock().unwrap();
        let doc = epubs.get_mut(&id)?;
        let bytes = doc.get_resource_by_path(&archive_path)?;
        let mime = doc
            .get_resource_mime_by_path(&archive_path)
            .unwrap_or_else(|| guess_mime(path));
        (bytes, mime)
    };
    cache_epub_resource(
        state,
        id,
        epub_mtime,
        path.to_string(),
        bytes.clone(),
        mime.clone(),
    );
    Some((bytes, mime))
}

fn prewarm_chapter_stylesheets(state: &AppState, id: u64, epub_mtime: u64, head: &str) {
    let paths: Vec<String> = collect_local_stylesheet_paths(head, id)
        .into_iter()
        .take(MAX_PREWARM_STYLESHEETS_PER_CHAPTER)
        .filter(|path| {
            state
                .epub_runtime
                .resource_cache
                .lock()
                .map(|cache| !cache.contains(id, epub_mtime, path))
                .unwrap_or(false)
        })
        .collect();
    if paths.is_empty() || ensure_epub_loaded(state, id).is_err() {
        return;
    }

    // EpubDoc is stateful. Read all missing top-level styles under one short
    // archive lock, then populate the independent cache after releasing it.
    // CSS contents are not inspected, so @import and relative url() resolution
    // continue through the existing resource protocol unchanged.
    let loaded = {
        let Ok(mut epubs) = state.epub_runtime.epubs.lock() else {
            return;
        };
        let Some(doc) = epubs.get_mut(&id) else {
            return;
        };
        paths
            .into_iter()
            .filter_map(|path| {
                let archive_path = PathBuf::from(&path);
                let bytes = doc.get_resource_by_path(&archive_path)?;
                let mime = doc
                    .get_resource_mime_by_path(&archive_path)
                    .unwrap_or_else(|| guess_mime(&path));
                Some((path, bytes, mime))
            })
            .collect::<Vec<_>>()
    };
    for (path, bytes, mime) in loaded {
        cache_epub_resource(state, id, epub_mtime, path, bytes, mime);
    }
}

fn escape_inline_style_end_tags(css: &str) -> String {
    let lowercase = css.to_ascii_lowercase();
    let mut output = String::with_capacity(css.len());
    let mut offset = 0usize;
    while let Some(relative) = lowercase[offset..].find("</style") {
        let start = offset + relative;
        output.push_str(&css[offset..start]);
        output.push_str("\\3C ");
        offset = start + 1;
    }
    output.push_str(&css[offset..]);
    output
}

fn inline_stylesheet_css(id: u64, path: &str, bytes: &[u8], mime: &str) -> Option<String> {
    if bytes.len() > MAX_INLINE_STYLESHEET_BYTES
        || (!mime.to_ascii_lowercase().starts_with("text/css")
            && !path.to_ascii_lowercase().ends_with(".css"))
    {
        return None;
    }
    let css = String::from_utf8_lossy(bytes);
    // Imported styles can carry their own media graph and relative base. Leave
    // them on the browser's existing link path instead of changing book layout
    // semantics for the sake of the common fast path.
    if css.to_ascii_lowercase().contains("@import") {
        return None;
    }
    let base_dir = path
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let rewritten = rewrite_css_url(&css, id, base_dir);
    // HTML style raw text ends at a literal </style token regardless of CSS
    // quoting. Escape only those terminators, preserving every other '<' used
    // by data URLs or string content.
    Some(escape_inline_style_end_tags(&rewritten))
}

fn chapter_head_with_inline_stylesheets(state: &AppState, id: u64, head: &str) -> String {
    let mut total_bytes = 0usize;
    let mut inlined = HashMap::new();
    for (href, path) in collect_local_stylesheet_links(head, id) {
        if inlined.contains_key(&href) {
            continue;
        }
        let Some((bytes, mime)) = read_epub_resource(state, id, &path) else {
            continue;
        };
        if total_bytes.saturating_add(bytes.len()) > MAX_INLINE_STYLESHEETS_TOTAL_BYTES {
            continue;
        }
        let Some(safe) = inline_stylesheet_css(id, &path, &bytes, &mime) else {
            continue;
        };
        total_bytes = total_bytes.saturating_add(bytes.len());
        inlined.insert(href, safe);
    }
    inline_local_stylesheet_links(head, id, &inlined)
}

fn chapter_head_with_cached_inline_stylesheets(
    state: &AppState,
    id: u64,
    epub_mtime: u64,
    head: &str,
) -> String {
    let links = collect_local_stylesheet_links(head, id);
    let cached = {
        let mut cache = state.epub_runtime.resource_cache.lock().unwrap();
        links
            .into_iter()
            .filter_map(|(href, path)| {
                cache
                    .get(id, epub_mtime, &path)
                    .map(|resource| (href, path, resource))
            })
            .collect::<Vec<_>>()
    };
    let mut total_bytes = 0usize;
    let mut inlined = HashMap::new();
    for (href, path, resource) in cached {
        if total_bytes.saturating_add(resource.bytes.len()) > MAX_INLINE_STYLESHEETS_TOTAL_BYTES {
            continue;
        }
        let Some(safe) = inline_stylesheet_css(id, &path, &resource.bytes, &resource.mime) else {
            continue;
        };
        total_bytes = total_bytes.saturating_add(resource.bytes.len());
        inlined.insert(href, safe);
    }
    inline_local_stylesheet_links(head, id, &inlined)
}

fn escape_json_for_inline_script(json: &str) -> String {
    json.replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn cached_initial_chapter_payload(
    state: &AppState,
    id: u64,
    chapter_index: usize,
    source_mtime: u64,
    inline_epub_styles: bool,
    conversion: ReaderTextConversion,
) -> Option<serde_json::Value> {
    let chapter = state.epub_runtime.chapter_html_cache.lock().unwrap().get((
        id,
        source_mtime,
        chapter_index,
    ));
    let chapter = chapter?;
    if chapter.body.len().saturating_add(chapter.head.len()) > MAX_INLINE_INITIAL_CHAPTER_BYTES {
        return None;
    }
    let head = if inline_epub_styles {
        chapter_head_with_cached_inline_stylesheets(state, id, source_mtime, &chapter.head)
    } else {
        chapter.head.clone()
    };
    let converted_body = cached_converted_chapter_body(
        state,
        (id, source_mtime, chapter_index),
        &chapter,
        conversion,
    );
    let body = converted_body.as_deref().unwrap_or(chapter.body.as_str());
    if body.len().saturating_add(head.len()) > MAX_INLINE_INITIAL_CHAPTER_BYTES {
        return None;
    }
    Some(serde_json::json!({
        "chapter": chapter_index,
        "conversion": conversion.as_str(),
        "inline": true,
        "head": head,
        "body": body,
    }))
}

fn cached_initial_chapter_script(
    state: &AppState,
    id: u64,
    chapter_index: usize,
    source_mtime: u64,
    inline_epub_styles: bool,
    conversion: ReaderTextConversion,
) -> String {
    let Some(payload) = cached_initial_chapter_payload(
        state,
        id,
        chapter_index,
        source_mtime,
        inline_epub_styles,
        conversion,
    ) else {
        return String::new();
    };
    format!(
        "window.__INITIAL_CHAPTER__={};",
        escape_json_for_inline_script(&payload.to_string())
    )
}

#[tauri::command]
pub(crate) async fn book_info(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    include_initial_chapter: Option<bool>,
    text_conversion: Option<String>,
) -> Result<BookInfo, String> {
    let started = Instant::now();
    let label = window.label().to_string();
    log(&format!("book_info label={label}"));
    let window_kind = crate::window_commands::reader_window_diagnostic_kind(&window);
    let visible = window.is_visible().unwrap_or(false);
    let Some(id_num) = crate::window_commands::reader_window_id(&window) else {
        crate::diagnostics::record_native_log(
            file!(),
            &format!(
                "reader_book_info phase=binding_lookup outcome=binding_unbound kind={window_kind} bound=false visible={visible}"
            ),
        );
        return Err("当前窗口未绑定图书".to_string());
    };
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "reader_book_info phase=binding_lookup outcome=binding_bound kind={window_kind} bound=true visible={visible}"
        ),
    );

    let (
        title,
        format,
        word_count,
        progress,
        resume_chapter,
        resume_frac,
        resume_position,
        chapter_index_version,
        bookmarks,
        highlights,
        path,
        content_id,
    ) = {
        let library = state.library.lock().unwrap();
        let Some(book) = library.get(id_num) else {
            crate::diagnostics::record_native_log(
                file!(),
                &format!(
                    "reader_book_info phase=library_lookup outcome=library_missing kind={window_kind} bound=true visible={visible}"
                ),
            );
            return Err("找不到这本书".to_string());
        };
        (
            book.title.clone(),
            book.format.clone(),
            book.word_count,
            book.progress,
            book.resume_chapter,
            book.resume_frac,
            book.resume_position.clone(),
            book.chapter_index_version,
            book.bookmarks.clone(),
            book.highlights.clone(),
            book.path.clone(),
            book.content_id.clone(),
        )
    };

    if !path.exists() {
        return Err("源文件已丢失。请回到书架，对这本书「重新定位」到文件的新位置。".to_string());
    }

    if format != "epub" {
        let url = if format == "pdf" {
            format!("{RES_BASE}/pdf/{id_num}")
        } else {
            format!("{RES_BASE}/book/{id_num}")
        };
        let (chapter_count, toc) = if format == "pdf" {
            (1u32, Vec::new())
        } else {
            let chapters =
                get_txt_chapters(state.inner(), id_num).unwrap_or_else(|| Arc::new(Vec::new()));
            let toc = chapters
                .iter()
                .enumerate()
                .map(|(index, (label, _))| TocDto {
                    label: label.clone(),
                    chapter: index as u32,
                    frag: String::new(),
                    level: 0,
                })
                .collect();
            (chapters.len().max(1) as u32, toc)
        };
        let initial_chapter = if include_initial_chapter.unwrap_or(false) && format != "pdf" {
            let chapter_index = usize::try_from(resume_chapter)
                .unwrap_or(usize::MAX)
                .min(usize::try_from(chapter_count.saturating_sub(1)).unwrap_or(usize::MAX));
            cached_initial_chapter_payload(
                state.inner(),
                id_num,
                chapter_index,
                file_mtime_ms(&path),
                false,
                ReaderTextConversion::parse(text_conversion.as_deref().unwrap_or("original")),
            )
        } else {
            None
        };
        return Ok(BookInfo {
            id: id_num.to_string(),
            content_id,
            title,
            format,
            word_count,
            url,
            chapter_count,
            toc,
            progress,
            resume_chapter,
            resume_frac,
            resume_position,
            bookmarks,
            highlights,
            initial_chapter,
        });
    }

    let meta = ensure_epub_meta(&state, id_num)?;
    let should_map_old_chapters = chapter_index_version < CACHE_VERSION;
    let resume_chapter = if should_map_old_chapters {
        map_physical_chapter_to_virtual(&meta, resume_chapter)
    } else {
        clamp_virtual_chapter(&meta, resume_chapter)
    };
    let resume_position = resume_position.map(|mut position| {
        if should_map_old_chapters {
            remap_reading_position_chapter(&mut position, &meta);
        } else {
            clamp_reading_position_chapter(&mut position, &meta);
        }
        position
    });
    let mut bookmarks = bookmarks;
    for bookmark in &mut bookmarks {
        if should_map_old_chapters {
            bookmark.chapter = map_physical_chapter_to_virtual(&meta, bookmark.chapter);
        } else {
            bookmark.chapter = clamp_virtual_chapter(&meta, bookmark.chapter);
        }
        if let Some(position) = bookmark.position.as_mut() {
            if should_map_old_chapters {
                remap_reading_position_chapter(position, &meta);
            } else {
                clamp_reading_position_chapter(position, &meta);
            }
        }
    }
    let mut highlights = highlights;
    for highlight in &mut highlights {
        if should_map_old_chapters {
            remap_highlight_chapter(highlight, &meta);
        } else {
            clamp_highlight_chapter(highlight, &meta);
        }
    }

    log(&format!(
        "book_info -> {} chapters, {} toc elapsed_ms={}",
        meta.virtuals.len(),
        meta.toc.len(),
        started.elapsed().as_millis()
    ));
    Ok(BookInfo {
        id: id_num.to_string(),
        content_id,
        title,
        format,
        word_count,
        url: format!("{RES_BASE}/book/{id_num}"),
        chapter_count: meta.virtuals.len() as u32,
        toc: meta.toc.clone(),
        progress,
        resume_chapter,
        resume_frac,
        resume_position,
        bookmarks,
        highlights,
        initial_chapter: include_initial_chapter
            .unwrap_or(false)
            .then(|| {
                cached_initial_chapter_payload(
                    state.inner(),
                    id_num,
                    usize::try_from(resume_chapter).unwrap_or(usize::MAX),
                    meta.mtime,
                    true,
                    ReaderTextConversion::parse(text_conversion.as_deref().unwrap_or("original")),
                )
            })
            .flatten(),
    })
}

#[tauri::command]
pub(crate) async fn search_book(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    term: String,
) -> Result<Vec<SearchHit>, ()> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let Some(id) = crate::window_commands::reader_window_id(&window) else {
        return Ok(Vec::new());
    };
    if ensure_epub_loaded(&state, id).is_err() {
        return Ok(Vec::new());
    }
    let spine: Vec<String> = {
        let mut epubs = state.epub_runtime.epubs.lock().unwrap();
        let Some(doc) = epubs.get_mut(&id) else {
            return Ok(Vec::new());
        };
        doc.spine.iter().map(|entry| entry.idref.clone()).collect()
    };
    let mut hits = Vec::new();

    for (chapter_index, idref) in spine.iter().enumerate() {
        // Search can scan an entire book.  Do not keep the EPUB mutex while
        // normalising every chapter, otherwise a reader's next-page fetch has
        // to wait for the full search to finish.
        let html = {
            let mut epubs = state.epub_runtime.epubs.lock().unwrap();
            let Some(doc) = epubs.get_mut(&id) else {
                return Ok(hits);
            };
            doc.get_resource_str(idref).map(|(html, _)| html)
        };
        let Some(html) = html else {
            continue;
        };
        let text = strip_tags(&html);
        for snippet in find_snippets(&text, &term, 300usize.saturating_sub(hits.len())) {
            hits.push(SearchHit {
                chapter: chapter_index as u32,
                snippet,
            });
        }
        if hits.len() >= 300 {
            return Ok(hits);
        }
    }
    Ok(hits)
}

fn handle_request(
    state: &AppState,
    path: &str,
    initial_conversion: ReaderTextConversion,
) -> Option<(Vec<u8>, String)> {
    let decoded = percent_decode(path);
    if let Some(name) = decoded.strip_prefix("/background/") {
        return crate::reader_backgrounds::read_cached_background(name);
    }
    let (kind, id, rest) = parse_request_path(path)?;

    match kind.as_str() {
        "engine" => {
            let shell = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
<script>window.__ID__=0;window.__CH__=0;window.__READER_ENGINE_WARM__=true;</script>{head}</head>\
<body><div id=\"pager\"><div id=\"scroller\"><div id=\"reader-root\" class=\"rr\"></div></div></div><div id=\"measurer\" class=\"rr\"></div></body></html>",
                head = reader_page::READER_PAGE_HEAD
            );
            Some((shell.into_bytes(), "text/html".to_string()))
        }
        "font" => crate::reader_fonts::read_font(id),
        "cover" => {
            let cover = {
                let library = state.library.lock().unwrap();
                library.get(id)?.cover.clone()?
            };
            let bytes = std::fs::read(cover).ok()?;
            Some((bytes, "image/png".to_string()))
        }
        "txt" => {
            let path = {
                let library = state.library.lock().unwrap();
                library.get(id)?.path.clone()
            };
            let bytes = std::fs::read(&path).ok()?;
            let text = book::normalize_text(&book::decode_bytes(&bytes));
            Some((txt_html(&text).into_bytes(), "text/html".to_string()))
        }
        "res" => read_epub_resource(state, id, &rest),
        "book" => {
            let (format, resume_chapter, anchored_chapter, chapter_index_version, source_path) = {
                let library = state.library.lock().unwrap();
                let book = library.get(id)?;
                (
                    book.format.clone(),
                    book.resume_chapter,
                    book.resume_position
                        .as_ref()
                        .filter(|position| position.anchor.is_some())
                        .map(reader_core::ReadingPosition::authoritative_chapter),
                    book.chapter_index_version,
                    book.path.clone(),
                )
            };
            let (count, initial_chapter_script) = if format == "epub" {
                let meta = ensure_epub_meta(state, id).ok()?;
                let stored_chapter = anchored_chapter.unwrap_or(resume_chapter);
                let chapter_index = if chapter_index_version < CACHE_VERSION {
                    map_physical_chapter_to_virtual(&meta, stored_chapter)
                } else {
                    clamp_virtual_chapter(&meta, stored_chapter)
                } as usize;
                (
                    meta.virtuals.len(),
                    cached_initial_chapter_script(
                        state,
                        id,
                        chapter_index,
                        meta.mtime,
                        true,
                        initial_conversion,
                    ),
                )
            } else {
                let count = get_txt_chapters(state, id)
                    .map(|chapters| chapters.len())
                    .unwrap_or(1)
                    .max(1);
                let chapter_index = usize::try_from(anchored_chapter.unwrap_or(resume_chapter))
                    .unwrap_or(usize::MAX)
                    .min(count.saturating_sub(1));
                (
                    count,
                    cached_initial_chapter_script(
                        state,
                        id,
                        chapter_index,
                        file_mtime_ms(&source_path),
                        false,
                        initial_conversion,
                    ),
                )
            };
            let shell = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
<script>window.__ID__='{id}';window.__CH__={count};{initial_chapter_script}</script>{head}</head>\
<body><div id=\"pager\"><div id=\"scroller\"><div id=\"reader-root\" class=\"rr\"></div></div></div><div id=\"measurer\" class=\"rr\"></div></body></html>",
                id = id,
                count = count,
                initial_chapter_script = initial_chapter_script,
                head = reader_page::READER_PAGE_HEAD
            );
            Some((shell.into_bytes(), "text/html".to_string()))
        }
        "chapter" => {
            let (index_text, conversion_text) = rest.split_once('/').unwrap_or((&rest, "original"));
            let index: usize = index_text.parse().ok()?;
            let conversion = ReaderTextConversion::parse(conversion_text);
            let format = state
                .library
                .lock()
                .unwrap()
                .get(id)
                .map(|book| book.format.clone())
                .unwrap_or_default();
            if format != "epub" {
                let chapter = process_text_chapter(state, id, index, &format)?;
                let source_mtime = state
                    .library
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|book| file_mtime_ms(&book.path))
                    .unwrap_or(0);
                let converted_body = cached_converted_chapter_body(
                    state,
                    (id, source_mtime, index),
                    &chapter,
                    conversion,
                );
                let body = converted_body.as_deref().unwrap_or(chapter.body.as_str());
                let json = serde_json::json!({"head": "", "body": body}).to_string();
                return Some((json.into_bytes(), "application/json".to_string()));
            }
            let meta = ensure_epub_meta(state, id).ok()?;
            let chapter = process_virtual_chapter(state, id, index, &meta)?;
            let converted_body =
                cached_converted_chapter_body(state, (id, meta.mtime, index), &chapter, conversion);
            let body = converted_body.as_deref().unwrap_or(chapter.body.as_str());
            let head = chapter_head_with_inline_stylesheets(state, id, &chapter.head);
            let json = serde_json::json!({"head": head, "body": body}).to_string();
            Some((json.into_bytes(), "application/json".to_string()))
        }
        "pdf" => {
            let path = {
                let library = state.library.lock().unwrap();
                library.get(id)?.path.clone()
            };
            let bytes = std::fs::read(&path).ok()?;
            Some((bytes, "application/pdf".to_string()))
        }
        _ => None,
    }
}

pub(crate) fn handle_protocol_request<R: tauri::Runtime>(
    context: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let path = request.uri().path().to_string();
    let initial_conversion = request
        .uri()
        .query()
        .and_then(|query| {
            query.split('&').find_map(|pair| {
                let (name, value) = pair.split_once('=')?;
                (name == "tc").then(|| ReaderTextConversion::parse(&percent_decode(value)))
            })
        })
        .unwrap_or(ReaderTextConversion::Original);
    // 封面是一批高频本地请求；逐张写磁盘日志会反过来拖慢首屏。保留文档和
    // 首个正文资源的诊断信息，封面失败仍由 HTTP 404 表达。
    if path.starts_with("/book/")
        || (path.starts_with("/res/")
            && !READER_RESOURCE_REQUEST_LOGGED.swap(true, Ordering::Relaxed))
    {
        let uri = request.uri().to_string();
        log(&format!("reader_protocol uri={uri} path={path}"));
    }
    // Reader HTML, chapters, styles and images can arrive in a burst. Creating
    // one Windows thread per custom-protocol request amplifies that burst into
    // scheduler and stack-allocation latency. Tauri's blocking pool preserves
    // the asynchronous response boundary while reusing worker threads.
    let _request_task = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state
            .epub_runtime
            .set_prewarm_text_conversion(initial_conversion);
        let response = match handle_request(&state, &path, initial_conversion) {
            Some((bytes, mime)) => {
                let cacheable = path.starts_with("/cover/")
                    || path.starts_with("/res/")
                    || path.starts_with("/font/");
                let cache_control = if cacheable {
                    "public, max-age=604800, immutable"
                } else {
                    "no-cache"
                };
                tauri::http::Response::builder()
                    .status(200)
                    .header(tauri::http::header::CONTENT_TYPE, mime)
                    .header(tauri::http::header::CACHE_CONTROL, cache_control)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap()
            }
            None => tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap(),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_stylesheet_fast_path_rewrites_resources_and_rejects_import_graphs() {
        let css = inline_stylesheet_css(
            7,
            "OPS/css/main.css",
            br#"p{background:url('../images/page.png')}q:after{content:'</style>'}"#,
            "text/css",
        )
        .expect("simple local stylesheet");
        assert!(css.contains(&format!("url('{RES_BASE}/res/7/OPS/images/page.png')")));
        assert!(!css.to_ascii_lowercase().contains("</style"));
        assert!(css.contains("\\3C /style>"));
        assert_eq!(
            escape_inline_style_end_tags("a{content:'<'}"),
            "a{content:'<'}"
        );
        assert!(inline_stylesheet_css(
            7,
            "OPS/css/imported.css",
            br#"@import url('base.css'); p{color:red}"#,
            "text/css"
        )
        .is_none());
    }

    #[test]
    fn inline_chapter_json_cannot_end_the_bootstrap_script() {
        let json = serde_json::json!({
            "chapter": 2,
            "body": "<p>正文</p></script><script>alert(1)</script>",
            "head": "<style>p::before{content:'\u{2028}'}</style>"
        })
        .to_string();
        let escaped = escape_json_for_inline_script(&json);
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('\u{2028}'));
        assert!(escaped.contains("\\u003c/script>"));
        assert!(escaped.contains("\\u2028"));
    }

    #[test]
    fn chapter_preparation_coalesces_concurrent_requests_for_the_same_cache_key() {
        let runtime = EpubRuntime::default();
        let first = runtime.chapter_prepare_lock((7, 11, 3));
        let second = runtime.chapter_prepare_lock((7, 11, 3));
        let other = runtime.chapter_prepare_lock((7, 11, 4));
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    fn chapter_remap_meta() -> EpubMetaCache {
        EpubMetaCache {
            mtime: 0,
            spine_paths: Vec::new(),
            chapter_map: HashMap::new(),
            virtuals: (0..5)
                .map(|part| EpubVirtualChapter {
                    spine_idx: part,
                    path: format!("chapter-{part}.xhtml"),
                    base_dir: String::new(),
                    part: 0,
                    body_start: 0,
                    body_end: 0,
                })
                .collect(),
            toc: Vec::new(),
            // A former physical chapter 1 was split into virtual chapter 3.
            physical_to_virtual: vec![0, 3, 4],
        }
    }

    #[test]
    fn small_chapters_are_not_split() {
        let body = "<p>短章节</p>";
        assert_eq!(split_body_ranges(body, body.len()), vec![(0, body.len())]);
    }

    #[test]
    fn large_chapters_split_on_structure_and_keep_utf8_boundaries() {
        let mut body = "甲".repeat(TEST_VIRTUAL_CHAPTER_TARGET_BYTES / 3 + 128);
        let heading = body.len();
        body.push_str("<h2>第二节</h2>");
        body.push_str(&"乙".repeat(120_000));

        let ranges = split_body_ranges(&body, BIG_EPUB_CHAPTER_BYTES + 1);

        assert!(ranges.len() >= 2);
        assert_eq!(ranges[0], (0, heading));
        assert_eq!(ranges.last().map(|range| range.1), Some(body.len()));
        for (position, (start, end)) in ranges.iter().copied().enumerate() {
            assert!(body.is_char_boundary(start));
            assert!(body.is_char_boundary(end));
            assert!(start < end);
            if position > 0 {
                assert_eq!(ranges[position - 1].1, start);
            }
        }
    }

    #[test]
    fn protocol_paths_decode_resources_without_changing_route_shape() {
        assert_eq!(
            parse_request_path("/res/42/OEBPS%2Fimages%2Fcover.jpg"),
            Some(("res".to_string(), 42, "OEBPS/images/cover.jpg".to_string()))
        );
        assert_eq!(
            parse_request_path("/chapter/7/3"),
            Some(("chapter".to_string(), 7, "3".to_string()))
        );
        assert_eq!(parse_request_path("/chapter/not-a-number/3"), None);
    }

    #[test]
    fn cache_versions_remain_backward_compatible() {
        assert_eq!(CACHE_VERSION, 3);
        assert_eq!(CACHE_COMPAT_VERSIONS, &[2, 3]);
    }

    #[test]
    fn recent_reading_prewarm_prioritizes_newest_without_a_fixed_book_count() {
        let ids = (1..=12).map(|id| (id, id * 10)).collect();
        assert_eq!(
            recent_reading_prewarm_order(ids),
            vec![12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
        );
        assert_eq!(
            recent_reading_prewarm_order(vec![(7, 100), (9, 100), (8, 90)]),
            vec![9, 7, 8]
        );
    }

    #[test]
    fn recent_reading_book_lru_keeps_one_position_per_book() {
        let runtime = EpubRuntime::default();
        runtime.set_recent_reading_chapter_cache_enabled(true);

        assert!(runtime.remember_recent_reading_content_book(7).is_empty());
        assert!(runtime.remember_recent_reading_content_book(7).is_empty());
        assert!(runtime.remember_recent_reading_content_book(9).is_empty());
        assert!(runtime.remember_recent_reading_content_book(7).is_empty());

        assert_eq!(
            runtime
                .recent_reading_content_books
                .lock()
                .unwrap()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![9, 7]
        );
    }

    #[test]
    fn replacing_the_same_cached_chapter_does_not_double_count_bytes() {
        let mut cache = ChapterHtmlCache::default();
        cache.insert((7, 1, 0), cached_chapter(4), usize::MAX, 12);
        cache.insert((7, 1, 0), cached_chapter(4), usize::MAX, 12);

        assert_eq!(cache.entries.len(), 1);
        assert_eq!(
            cache.book_order.iter().copied().collect::<Vec<_>>(),
            vec![7]
        );
        assert_eq!(cache.bytes, 4);
    }

    fn cached_chapter(bytes: usize) -> Arc<ProcessedChapterHtml> {
        Arc::new(ProcessedChapterHtml {
            head: String::new(),
            body: "x".repeat(bytes),
        })
    }

    #[test]
    fn recent_reading_chapter_cache_is_bounded_by_books_and_bytes() {
        let mut cache = ChapterHtmlCache::default();
        cache.insert((1, 1, 0), cached_chapter(4), 3, 12);
        cache.insert((2, 1, 0), cached_chapter(4), 3, 12);
        cache.insert((3, 1, 0), cached_chapter(4), 3, 12);
        assert_eq!(cache.entries.len(), 3);
        assert_eq!(cache.book_order.len(), 3);
        assert_eq!(cache.bytes, 12);

        cache.insert((4, 1, 0), cached_chapter(4), 3, 12);
        assert!(!cache.entries.contains_key(&(1, 1, 0)));
        assert_eq!(cache.entries.len(), 3);
        assert_eq!(cache.book_order.len(), 3);

        cache.insert((4, 1, 1), cached_chapter(13), 3, 12);
        assert!(cache.bytes <= 12);
        assert!(!cache.entries.contains_key(&(4, 1, 1)));
    }

    #[test]
    fn recent_reading_chapter_cache_refreshes_recency_on_read() {
        let mut cache = ChapterHtmlCache::default();
        cache.insert((1, 1, 0), cached_chapter(3), 2, 12);
        cache.insert((2, 1, 0), cached_chapter(3), 2, 12);
        assert!(cache.get((1, 1, 0)).is_some());
        cache.insert((3, 1, 0), cached_chapter(3), 2, 12);
        assert!(cache.entries.contains_key(&(1, 1, 0)));
        assert!(!cache.entries.contains_key(&(2, 1, 0)));
    }

    #[test]
    fn converted_chapter_cache_is_bounded_and_replaces_stale_generation() {
        let mut cache = ConvertedChapterCache::default();
        cache.insert((1, 10, 0, 1), Arc::from("123"), 2, 12);
        cache.insert((2, 10, 0, 1), Arc::from("456"), 2, 12);
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.bytes <= 12);

        assert!(cache.get((1, 10, 0, 1)).is_some());
        cache.insert((3, 10, 0, 1), Arc::from("789"), 2, 12);
        assert!(cache.entries.contains_key(&(1, 10, 0, 1)));
        assert!(!cache.entries.contains_key(&(2, 10, 0, 1)));

        cache.insert((1, 11, 0, 1), Arc::from("new"), 2, 12);
        assert!(!cache.entries.contains_key(&(1, 10, 0, 1)));
        assert!(cache.entries.contains_key(&(1, 11, 0, 1)));
    }

    fn cached_resource(bytes: &[u8], mime: &str) -> Arc<CachedEpubResource> {
        Arc::new(CachedEpubResource {
            bytes: Arc::from(bytes.to_vec()),
            mime: mime.to_string(),
        })
    }

    #[test]
    fn epub_resource_cache_preserves_binary_bytes_mime_and_read_recency() {
        let mut cache = EpubResourceCache::default();
        cache.insert(
            1,
            100,
            "OPS/a.css".to_string(),
            cached_resource(b"@import 'base.css';", "text/css; charset=utf-8"),
            2,
            64,
        );
        cache.insert(
            2,
            200,
            "OPS/figure.webp".to_string(),
            cached_resource(&[0x52, 0x49, 0x46, 0x46, 0x00, 0xff], "image/webp"),
            2,
            64,
        );

        let first = cache.get(1, 100, "OPS/a.css").expect("cached resource");
        assert_eq!(first.bytes.as_ref(), b"@import 'base.css';");
        assert_eq!(first.mime, "text/css; charset=utf-8");

        cache.insert(
            3,
            300,
            "OPS/c.css".to_string(),
            cached_resource(b"body{}", "text/css"),
            2,
            64,
        );
        assert!(cache.contains(1, 100, "OPS/a.css"));
        assert!(!cache.contains(2, 200, "OPS/figure.webp"));
        assert!(cache.contains(3, 300, "OPS/c.css"));
    }

    #[test]
    fn epub_resource_cache_invalidates_an_in_place_epub_update() {
        let mut cache = EpubResourceCache::default();
        cache.insert(
            7,
            1_000,
            "OPS/theme.css".to_string(),
            cached_resource(b"body{color:black}", "text/css"),
            10,
            64,
        );

        assert!(cache.get(7, 2_000, "OPS/theme.css").is_none());
        cache.insert(
            7,
            2_000,
            "OPS/theme.css".to_string(),
            cached_resource(b"body{color:white}", "text/css"),
            10,
            64,
        );

        assert!(cache.get(7, 1_000, "OPS/theme.css").is_none());
        let current = cache
            .get(7, 2_000, "OPS/theme.css")
            .expect("current stylesheet generation");
        assert_eq!(current.bytes.as_ref(), b"body{color:white}");
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn epub_resource_cache_drops_entries_over_its_byte_budget() {
        let mut cache = EpubResourceCache::default();
        cache.insert(
            1,
            100,
            "OPS/large.css".to_string(),
            cached_resource(b"123456789", "text/css"),
            10,
            8,
        );

        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
        assert!(cache.entry_order.is_empty());
        assert!(cache.book_order.is_empty());
    }

    #[test]
    fn reader_conversion_changes_text_without_touching_markup() {
        let source = r#"<p title="开放">开放中文 <a href="/资源/开放">阅读</a></p>"#;
        let converted = convert_reader_html_text(source, ReaderTextConversion::ToTraditional);
        assert!(converted.contains(r#"title="开放""#));
        assert!(converted.contains(r#"href="/资源/开放""#));
        assert!(converted.contains("開放中文"));
        assert!(converted.contains("閱讀"));
        assert_eq!(ReaderTextConversion::Original.as_str(), "original");
        assert_eq!(ReaderTextConversion::ToSimplified.as_str(), "t2s");
        assert_eq!(ReaderTextConversion::ToTraditional.as_str(), "s2t");
        assert_eq!(ReaderTextConversion::Original.cache_tag(), 0);
        assert_eq!(
            ReaderTextConversion::from_cache_tag(1),
            ReaderTextConversion::ToSimplified
        );
        assert_eq!(
            ReaderTextConversion::from_cache_tag(2),
            ReaderTextConversion::ToTraditional
        );
    }

    #[test]
    fn old_epub_chapter_remap_keeps_resume_bookmark_and_highlight_anchors_together() {
        let meta = chapter_remap_meta();
        let anchor = reader_core::ReadingAnchor {
            chapter: 1,
            dom_path: "p:nth-of-type(2)".to_string(),
            text_offset: 17,
            context_before: "前文".to_string(),
            context_after: "后文".to_string(),
            viewport_offset: 0.0,
        };
        let mut position = reader_core::ReadingPosition {
            chapter: 1,
            anchor: Some(anchor.clone()),
            fraction: 0.4,
        };
        remap_reading_position_chapter(&mut position, &meta);
        assert_eq!(position.chapter, 3);
        assert_eq!(position.anchor.as_ref().map(|value| value.chapter), Some(3));

        let mut bookmark = book::Bookmark {
            chapter: 1,
            frac: 0.4,
            label: "续读".to_string(),
            position: Some(reader_core::ReadingPosition {
                chapter: 1,
                anchor: Some(anchor.clone()),
                fraction: 0.4,
            }),
        };
        bookmark.chapter = map_physical_chapter_to_virtual(&meta, bookmark.chapter);
        remap_reading_position_chapter(bookmark.position.as_mut().unwrap(), &meta);
        assert_eq!(bookmark.chapter, 3);
        assert_eq!(bookmark.effective_position().authoritative_chapter(), 3);

        let mut highlight = book::Highlight {
            chapter: 1,
            range_anchor: Some(reader_core::TextRangeAnchor {
                start: Some(anchor.clone()),
                end: Some(reader_core::ReadingAnchor {
                    text_offset: 29,
                    ..anchor
                }),
            }),
            ..Default::default()
        };
        remap_highlight_chapter(&mut highlight, &meta);
        assert_eq!(highlight.chapter, 3);
        let range = highlight.range_anchor.unwrap();
        assert_eq!(range.start.map(|value| value.chapter), Some(3));
        assert_eq!(range.end.map(|value| value.chapter), Some(3));
    }

    #[test]
    fn current_epub_positions_clamp_resume_bookmark_and_highlight_anchors_together() {
        let meta = chapter_remap_meta();
        let anchor = reader_core::ReadingAnchor {
            chapter: 99,
            dom_path: "p:nth-of-type(2)".to_string(),
            text_offset: 17,
            context_before: "前文".to_string(),
            context_after: "后文".to_string(),
            viewport_offset: 0.0,
        };
        let mut position = reader_core::ReadingPosition {
            chapter: 99,
            anchor: Some(anchor.clone()),
            fraction: 0.4,
        };
        clamp_reading_position_chapter(&mut position, &meta);
        assert_eq!(position.chapter, 4);
        assert_eq!(position.anchor.as_ref().map(|value| value.chapter), Some(4));

        let mut bookmark = book::Bookmark {
            chapter: 99,
            frac: 0.4,
            label: "续读".to_string(),
            position: Some(reader_core::ReadingPosition {
                chapter: 99,
                anchor: Some(anchor.clone()),
                fraction: 0.4,
            }),
        };
        bookmark.chapter = clamp_virtual_chapter(&meta, bookmark.chapter);
        clamp_reading_position_chapter(bookmark.position.as_mut().unwrap(), &meta);
        assert_eq!(bookmark.chapter, 4);
        assert_eq!(bookmark.effective_position().authoritative_chapter(), 4);

        let mut highlight = book::Highlight {
            chapter: 99,
            range_anchor: Some(reader_core::TextRangeAnchor {
                start: Some(anchor.clone()),
                end: Some(reader_core::ReadingAnchor {
                    text_offset: 29,
                    ..anchor
                }),
            }),
            ..Default::default()
        };
        clamp_highlight_chapter(&mut highlight, &meta);
        assert_eq!(highlight.chapter, 4);
        let range = highlight.range_anchor.unwrap();
        assert_eq!(range.start.map(|value| value.chapter), Some(4));
        assert_eq!(range.end.map(|value| value.chapter), Some(4));
    }
}
