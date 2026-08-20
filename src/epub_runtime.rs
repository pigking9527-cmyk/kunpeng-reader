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
    collect_head_assets, extract_body_inner, get_txt_chapters, guess_mime, is_md, is_mobi,
    md_to_html, percent_decode, rewrite_attrs, rewrite_css_url, strip_tags, txt_body, txt_html,
};
use crate::{book, log, reader_page, AppState, RES_BASE};
use cache_paths::{epub_entry_sizes, file_mtime_ms, meta_cache_path, meta_cache_path_for};
use chapter_cache::ProcessedChapterHtml;
use protocol_path::parse_request_path;
use search_rules::find_snippets;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
pub(crate) const RECENT_READING_CHAPTER_CACHE_BOOK_LIMIT: usize = 3;
pub(crate) const RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT: u64 = 6 * 1024 * 1024;
const TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT: usize = 1;
const TRANSIENT_CHAPTER_CACHE_BYTE_LIMIT: u64 = 1024 * 1024;

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
    recent_reading_chapter_cache_enabled: AtomicBool,
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

/// A bounded, content-free view of the caches affected by book preparation.
/// The byte count is the UTF-8 payload currently retained for sanitized EPUB
/// chapter HTML; it deliberately does not claim to be the process RSS.
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
            recent_reading_chapter_cache_enabled: AtomicBool::new(false),
        }
    }
}

impl EpubRuntime {
    pub(crate) fn clear(&self) {
        self.epubs.lock().map(|mut cache| cache.clear()).ok();
        self.meta_cache.lock().map(|mut cache| cache.clear()).ok();
        self.chapter_html_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
    }

    fn chapter_cache_limits(&self) -> (usize, u64) {
        if self
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire)
        {
            (
                RECENT_READING_CHAPTER_CACHE_BOOK_LIMIT,
                RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT,
            )
        } else {
            (
                TRANSIENT_CHAPTER_CACHE_BOOK_LIMIT,
                TRANSIENT_CHAPTER_CACHE_BYTE_LIMIT,
            )
        }
    }

    pub(crate) fn set_recent_reading_chapter_cache_enabled(&self, enabled: bool) {
        self.recent_reading_chapter_cache_enabled
            .store(enabled, Ordering::Release);
        if !enabled {
            self.chapter_html_cache
                .lock()
                .map(|mut cache| cache.clear())
                .ok();
        }
    }

    pub(crate) fn clear_recent_reading_chapter_cache(&self) {
        self.chapter_html_cache
            .lock()
            .map(|mut cache| cache.clear())
            .ok();
    }
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
    let (chapter_entries, chapter_html_bytes, recent_reading_chapter_books) = state
        .epub_runtime
        .chapter_html_cache
        .lock()
        .map(|items| (items.entries.len(), items.bytes, items.book_order.len()))
        .unwrap_or((0, 0, 0));
    ReaderPreloadCacheStatus {
        epub_documents: u32::try_from(epub_documents).unwrap_or(u32::MAX),
        metadata_entries: u32::try_from(metadata_entries).unwrap_or(u32::MAX),
        chapter_entries: u32::try_from(chapter_entries).unwrap_or(u32::MAX),
        chapter_html_bytes,
        recent_reading_chapter_cache_enabled: state
            .epub_runtime
            .recent_reading_chapter_cache_enabled
            .load(Ordering::Acquire),
        recent_reading_chapter_books: u32::try_from(recent_reading_chapter_books)
            .unwrap_or(u32::MAX),
        recent_reading_chapter_limit_bytes: RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT,
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
    let (format, resume_chapter, chapter_index_version) = {
        let library = state.library.lock().unwrap();
        let book = library.get(id).ok_or("找不到这本书")?;
        (
            book.format.clone(),
            book.resume_chapter,
            book.chapter_index_version,
        )
    };
    if format != "epub" {
        return Ok(());
    }
    let meta = ensure_epub_meta(state, id)?;
    let chapter = if chapter_index_version < CACHE_VERSION {
        map_physical_chapter_to_virtual(&meta, resume_chapter)
    } else {
        clamp_virtual_chapter(&meta, resume_chapter)
    } as usize;
    process_virtual_chapter(state, id, chapter, &meta)
        .map(|_| ())
        .ok_or_else(|| "无法预热续读章节".to_string())
}

/// Warms the resume chapter for the most recently read EPUBs. This is source
/// preparation only: it never creates a reader WebView or retains decoded
/// images, so it is safe to run while the shelf remains responsive.
pub(crate) fn prewarm_recent_reading_chapters(state: &AppState) {
    if !state
        .epub_runtime
        .recent_reading_chapter_cache_enabled
        .load(Ordering::Acquire)
    {
        return;
    }
    let mut ids: Vec<(u64, u64)> = state
        .library
        .lock()
        .map(|library| {
            library
                .books
                .iter()
                .filter(|book| book.format.eq_ignore_ascii_case("epub") && book.path.exists())
                .map(|book| (book.id, book.last_read_at))
                .collect()
        })
        .unwrap_or_default();
    ids.sort_unstable_by(|left, right| right.cmp(left));
    for (id, _) in ids
        .into_iter()
        .take(RECENT_READING_CHAPTER_CACHE_BOOK_LIMIT)
    {
        let _ = prewarm_book_data(state, id);
    }
}

#[tauri::command]
pub(crate) async fn prewarm_book(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // 书架悬停只预热 EPUB 的续读章节和正文缓存；隐藏阅读窗口由预加载
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

#[tauri::command]
pub(crate) async fn book_info(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<BookInfo, String> {
    let started = Instant::now();
    let label = window.label().to_string();
    log(&format!("book_info label={label}"));
    let id_num = crate::window_commands::reader_window_id(&window).ok_or("当前窗口未绑定图书")?;

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
        let book = library.get(id_num).ok_or("找不到这本书")?;
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

fn handle_request(state: &AppState, path: &str) -> Option<(Vec<u8>, String)> {
    let decoded = percent_decode(path);
    if let Some(name) = decoded.strip_prefix("/background/") {
        return crate::reader_backgrounds::read_cached_background(name);
    }
    let (kind, id, rest) = parse_request_path(path)?;

    match kind.as_str() {
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
        "res" => {
            ensure_epub_loaded(state, id).ok()?;
            let mut epubs = state.epub_runtime.epubs.lock().unwrap();
            let doc = epubs.get_mut(&id)?;
            let path = PathBuf::from(&rest);
            let bytes = doc.get_resource_by_path(&path)?;
            let mime = doc
                .get_resource_mime_by_path(&path)
                .unwrap_or_else(|| guess_mime(&rest));
            Some((bytes, mime))
        }
        "book" => {
            let format = state
                .library
                .lock()
                .unwrap()
                .get(id)
                .map(|book| book.format.clone())
                .unwrap_or_default();
            let count = if format == "epub" {
                ensure_epub_meta(state, id)
                    .map(|meta| meta.virtuals.len())
                    .unwrap_or(0)
            } else {
                get_txt_chapters(state, id)
                    .map(|chapters| chapters.len())
                    .unwrap_or(1)
            };
            let shell = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
<script>window.__ID__='{id}';window.__CH__={count};</script>{head}</head>\
<body><div id=\"pager\"><div id=\"scroller\"><div id=\"reader-root\" class=\"rr\"></div></div></div><div id=\"measurer\" class=\"rr\"></div></body></html>",
                id = id,
                count = count,
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
                let chapters = get_txt_chapters(state, id)?;
                let raw = chapters
                    .get(index)
                    .map(|(_, chapter)| chapter.clone())
                    .unwrap_or_default();
                let body = if is_mobi(&format) {
                    format!(
                        "<div class=\"mobi-body\">{}</div>",
                        sanitize_mobi_html(&raw)
                    )
                } else if is_md(&format) {
                    format!(
                        "<div class=\"md-body\">{}</div>",
                        sanitize_book_html(&md_to_html(&raw))
                    )
                } else {
                    txt_body(&raw)
                };
                let body = convert_reader_html_text(&body, conversion);
                let json = serde_json::json!({"head": "", "body": body}).to_string();
                return Some((json.into_bytes(), "application/json".to_string()));
            }
            let meta = ensure_epub_meta(state, id).ok()?;
            let chapter = process_virtual_chapter(state, id, index, &meta)?;
            let body = convert_reader_html_text(&chapter.body, conversion);
            let json = serde_json::json!({"head": chapter.head, "body": body}).to_string();
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
    // 封面是一批高频本地请求；逐张写磁盘日志会反过来拖慢首屏。保留文档和
    // 首个正文资源的诊断信息，封面失败仍由 HTTP 404 表达。
    if path.starts_with("/book/")
        || (path.starts_with("/res/")
            && !READER_RESOURCE_REQUEST_LOGGED.swap(true, Ordering::Relaxed))
    {
        let uri = request.uri().to_string();
        log(&format!("reader_protocol uri={uri} path={path}"));
    }
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let response = match handle_request(&state, &path) {
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
    fn reader_conversion_changes_text_without_touching_markup() {
        let source = r#"<p title="开放">开放中文 <a href="/资源/开放">阅读</a></p>"#;
        let converted = convert_reader_html_text(source, ReaderTextConversion::ToTraditional);
        assert!(converted.contains(r#"title="开放""#));
        assert!(converted.contains(r#"href="/资源/开放""#));
        assert!(converted.contains("開放中文"));
        assert!(converted.contains("閱讀"));
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
