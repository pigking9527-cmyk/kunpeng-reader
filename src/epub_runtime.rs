//! EPUB document lifetime, virtual chapters and custom reader protocol.

use crate::epub_toc::{epub3_nav_toc, flatten_toc, TocDto};
use crate::html_sanitize::{sanitize_book_html, sanitize_epub_head, sanitize_mobi_html};
use crate::reader_protocol::{
    collect_head_assets, extract_body_inner, get_txt_chapters, guess_mime, is_md, is_mobi,
    md_to_html, percent_decode, rewrite_attrs, rewrite_css_url, strip_tags, txt_body, txt_html,
};
use crate::{book, log, reader_page, AppState, RES_BASE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Manager;

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

const BIG_EPUB_CHAPTER_BYTES: usize = 800 * 1024;
const BIG_EPUB_CHAPTER_CHARS: usize = 1_000_000;
const VIRTUAL_CHAPTER_TARGET_BYTES: usize = 520 * 1024;
const VIRTUAL_CHAPTER_SEARCH_BYTES: usize = 160 * 1024;
pub(crate) const CACHE_VERSION: u32 = 3;
const CACHE_COMPAT_VERSIONS: &[u32] = &[2, 3];

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

#[derive(Clone, Serialize, Deserialize)]
struct ProcessedChapterHtml {
    head: String,
    body: String,
}

#[derive(Serialize)]
pub(crate) struct BookInfo {
    id: String,
    title: String,
    format: String,
    url: String,
    chapter_count: u32,
    toc: Vec<TocDto>,
    progress: f32,
    resume_chapter: u32,
    resume_frac: f32,
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
    chapter_html_cache: Mutex<HashMap<(u64, u64, usize), Arc<ProcessedChapterHtml>>>,
}

impl Default for EpubRuntime {
    fn default() -> Self {
        Self {
            epubs: Mutex::new(HashMap::new()),
            meta_cache: Mutex::new(HashMap::new()),
            chapter_html_cache: Mutex::new(HashMap::new()),
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

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| {
            duration.as_secs().saturating_mul(1000) + u64::from(duration.subsec_millis())
        })
        .unwrap_or(0)
}

fn epub_entry_sizes(path: &Path) -> HashMap<String, usize> {
    let mut sizes = HashMap::new();
    let Ok(file) = std::fs::File::open(path) else {
        return sizes;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return sizes;
    };
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        let size = entry.size().min(usize::MAX as u64) as usize;
        sizes.insert(entry.name().replace('\\', "/"), size);
    }
    sizes
}

fn epub_cache_dir() -> Option<PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("ebook-reader");
    dir.push("epub-cache");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn meta_cache_path_for(id: u64, mtime: u64, version: u32) -> Option<PathBuf> {
    Some(epub_cache_dir()?.join(format!("meta-v{version}-{id}-{mtime}.json")))
}

fn meta_cache_path(id: u64, mtime: u64) -> Option<PathBuf> {
    meta_cache_path_for(id, mtime, CACHE_VERSION)
}

fn chapter_cache_path_for(id: u64, mtime: u64, index: usize, version: u32) -> Option<PathBuf> {
    Some(epub_cache_dir()?.join(format!("chapter-v{version}-{id}-{mtime}-{index}.json")))
}

fn chapter_cache_path(id: u64, mtime: u64, index: usize) -> Option<PathBuf> {
    chapter_cache_path_for(id, mtime, index, CACHE_VERSION)
}

fn build_virtual_chapter_map(
    spine_paths: &[String],
    physical_to_virtual: &[u32],
) -> HashMap<String, usize> {
    spine_paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            (
                path.clone(),
                physical_to_virtual
                    .get(index)
                    .copied()
                    .unwrap_or(index as u32) as usize,
            )
        })
        .collect()
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
    let Some(path) = meta_cache_path(id, meta.mtime) else {
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

fn clamp_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn first_needle_pos(haystack: &str, needles: &[&str]) -> Option<usize> {
    needles
        .iter()
        .filter_map(|needle| haystack.find(needle))
        .min()
}

fn last_needle_pos(haystack: &str, needles: &[&str]) -> Option<(usize, usize)> {
    needles
        .iter()
        .filter_map(|needle| {
            haystack
                .rfind(needle)
                .map(|position| (position, needle.len()))
        })
        .max_by_key(|(position, _)| *position)
}

fn find_virtual_split(body: &str, start: usize, target: usize) -> usize {
    let len = body.len();
    let target = clamp_char_boundary(body, target.min(len));
    if target >= len {
        return len;
    }

    let forward_end = clamp_char_boundary(body, (target + VIRTUAL_CHAPTER_SEARCH_BYTES).min(len));
    if forward_end > target {
        let window = &body[target..forward_end];
        if let Some(position) = first_needle_pos(
            window,
            &[
                "<h1", "<h2", "<h3", "<h4", "<h5", "<h6", "<p", "<div", "<section", "<H1", "<H2",
                "<H3", "<H4", "<H5", "<H6", "<P", "<DIV", "<SECTION",
            ],
        ) {
            return clamp_char_boundary(body, target + position);
        }
        if let Some((position, needle_len)) =
            first_needle_pos(window, &["</p>", "</P>"]).map(|position| (position, 4usize))
        {
            return clamp_char_boundary(body, target + position + needle_len);
        }
    }

    let backward_start = clamp_char_boundary(
        body,
        target
            .saturating_sub(VIRTUAL_CHAPTER_SEARCH_BYTES)
            .max(start),
    );
    if backward_start < target {
        let window = &body[backward_start..target];
        if let Some((position, needle_len)) = last_needle_pos(
            window,
            &[
                "</p>",
                "</div>",
                "</section>",
                "</h1>",
                "</h2>",
                "</h3>",
                "</P>",
                "</DIV>",
                "</SECTION>",
                "</H1>",
                "</H2>",
                "</H3>",
            ],
        ) {
            let split = backward_start + position + needle_len;
            if split > start {
                return clamp_char_boundary(body, split);
            }
        }
    }

    target
}

fn split_body_ranges(body: &str, html_len: usize) -> Vec<(usize, usize)> {
    if html_len <= BIG_EPUB_CHAPTER_BYTES && body.chars().count() <= BIG_EPUB_CHAPTER_CHARS {
        return vec![(0, body.len())];
    }
    let mut ranges = Vec::new();
    let mut start = 0usize;
    let len = body.len();
    while start < len {
        let target = start.saturating_add(VIRTUAL_CHAPTER_TARGET_BYTES).min(len);
        let mut end = find_virtual_split(body, start, target);
        if end <= start {
            end = clamp_char_boundary(body, target);
        }
        if end <= start {
            end = len;
        }
        ranges.push((start, end));
        start = end;
    }
    if ranges.is_empty() {
        ranges.push((0, body.len()));
    }
    ranges
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

fn map_physical_chapter_to_virtual(meta: &EpubMetaCache, chapter: u32) -> u32 {
    let index = chapter as usize;
    if index < meta.physical_to_virtual.len() {
        meta.physical_to_virtual[index]
    } else {
        chapter.min(meta.virtuals.len().saturating_sub(1) as u32)
    }
}

pub(crate) fn map_physical_chapter_for_book(
    state: &AppState,
    id: u64,
    chapter: u32,
) -> Result<u32, String> {
    ensure_epub_meta(state, id).map(|meta| map_physical_chapter_to_virtual(&meta, chapter))
}

fn load_processed_chapter_disk_cache(
    id: u64,
    mtime: u64,
    index: usize,
) -> Option<Arc<ProcessedChapterHtml>> {
    for version in CACHE_COMPAT_VERSIONS {
        let Some(path) = chapter_cache_path_for(id, mtime, index, *version) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if let Ok(chapter) = serde_json::from_slice::<ProcessedChapterHtml>(&bytes) {
            return Some(Arc::new(chapter));
        }
    }
    None
}

fn save_processed_chapter_disk_cache(
    id: u64,
    mtime: u64,
    index: usize,
    chapter: &ProcessedChapterHtml,
) {
    let Some(path) = chapter_cache_path(id, mtime, index) else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec(chapter) {
        let _ = std::fs::write(path, bytes);
    }
}

fn process_virtual_chapter(
    state: &AppState,
    id: u64,
    index: usize,
    meta: &EpubMetaCache,
) -> Option<Arc<ProcessedChapterHtml>> {
    let key = (id, meta.mtime, index);
    {
        let cache = state.epub_runtime.chapter_html_cache.lock().unwrap();
        if let Some(chapter) = cache.get(&key) {
            return Some(Arc::clone(chapter));
        }
    }
    if let Some(chapter) = load_processed_chapter_disk_cache(id, meta.mtime, index) {
        state
            .epub_runtime
            .chapter_html_cache
            .lock()
            .unwrap()
            .insert(key, Arc::clone(&chapter));
        return Some(chapter);
    }

    ensure_epub_loaded(state, id).ok()?;
    let virtual_chapter = meta.virtuals.get(index)?;
    let mut epubs = state.epub_runtime.epubs.lock().unwrap();
    let doc = epubs.get_mut(&id)?;
    let html = doc
        .get_resource_str_by_path(&virtual_chapter.path)
        .unwrap_or_default();
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
    save_processed_chapter_disk_cache(id, meta.mtime, index, &chapter);
    state
        .epub_runtime
        .chapter_html_cache
        .lock()
        .unwrap()
        .insert(key, Arc::clone(&chapter));
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
    let id = label
        .strip_prefix("reader-")
        .ok_or("当前窗口不是阅读窗口")?
        .to_string();
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;

    let (
        title,
        format,
        progress,
        resume_chapter,
        resume_frac,
        chapter_index_version,
        bookmarks,
        highlights,
        path,
    ) = {
        let library = state.library.lock().unwrap();
        let book = library.get(id_num).ok_or("找不到这本书")?;
        (
            book.title.clone(),
            book.format.clone(),
            book.progress,
            book.resume_chapter,
            book.resume_frac,
            book.chapter_index_version,
            book.bookmarks.clone(),
            book.highlights.clone(),
            book.path.clone(),
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
            title,
            format,
            url,
            chapter_count,
            toc,
            progress,
            resume_chapter,
            resume_frac,
            bookmarks,
            highlights,
        });
    }

    let meta = ensure_epub_meta(&state, id_num)?;
    let should_map_old_chapters = chapter_index_version < CACHE_VERSION;
    let resume_chapter = if should_map_old_chapters {
        map_physical_chapter_to_virtual(&meta, resume_chapter)
    } else {
        resume_chapter.min(meta.virtuals.len().saturating_sub(1) as u32)
    };
    let mut bookmarks = bookmarks;
    if should_map_old_chapters {
        for bookmark in &mut bookmarks {
            bookmark.chapter = map_physical_chapter_to_virtual(&meta, bookmark.chapter);
        }
    }
    let mut highlights = highlights;
    if should_map_old_chapters {
        for highlight in &mut highlights {
            highlight.chapter = map_physical_chapter_to_virtual(&meta, highlight.chapter);
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
        title,
        format,
        url: format!("{RES_BASE}/book/{id_num}"),
        chapter_count: meta.virtuals.len() as u32,
        toc: meta.toc.clone(),
        progress,
        resume_chapter,
        resume_frac,
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
    let mut epubs = state.epub_runtime.epubs.lock().unwrap();
    let Some(doc) = epubs.get_mut(&id) else {
        return Ok(Vec::new());
    };
    let spine: Vec<String> = doc.spine.iter().map(|entry| entry.idref.clone()).collect();
    let query: Vec<char> = term
        .chars()
        .map(|character| character.to_ascii_lowercase())
        .collect();
    let query_len = query.len();
    let mut hits = Vec::new();

    for (chapter_index, idref) in spine.iter().enumerate() {
        let Some((html, _)) = doc.get_resource_str(idref) else {
            continue;
        };
        let text = strip_tags(&html);
        let text_chars: Vec<char> = text.chars().collect();
        let lowercase: Vec<char> = text_chars
            .iter()
            .map(|character| character.to_ascii_lowercase())
            .collect();
        let mut index = 0usize;
        while index + query_len <= lowercase.len() {
            if lowercase[index..index + query_len] == query[..] {
                let start = index.saturating_sub(30);
                let end = (index + query_len + 30).min(lowercase.len());
                let snippet: String = text_chars[start..end].iter().collect();
                hits.push(SearchHit {
                    chapter: chapter_index as u32,
                    snippet: snippet.trim().to_string(),
                });
                index += query_len;
                if hits.len() >= 300 {
                    return Ok(hits);
                }
            } else {
                index += 1;
            }
        }
    }
    Ok(hits)
}

fn parse_request_path(path: &str) -> Option<(String, u64, String)> {
    let decoded = percent_decode(path);
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next()?.to_string();
    let id = parts.next()?.parse().ok()?;
    let rest = parts.next().unwrap_or("").to_string();
    Some((kind, id, rest))
}

fn handle_request(state: &AppState, path: &str) -> Option<(Vec<u8>, String)> {
    let (kind, id, rest) = parse_request_path(path)?;

    match kind.as_str() {
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
            let index: usize = rest.parse().ok()?;
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
                let json = serde_json::json!({"head": "", "body": body}).to_string();
                return Some((json.into_bytes(), "application/json".to_string()));
            }
            let meta = ensure_epub_meta(state, id).ok()?;
            let chapter = process_virtual_chapter(state, id, index, &meta)?;
            let json = serde_json::json!({"head": chapter.head, "body": chapter.body}).to_string();
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
    let uri = request.uri().to_string();
    let path = request.uri().path().to_string();
    if path.starts_with("/cover/")
        || path.starts_with("/book/")
        || (path.starts_with("/res/")
            && !READER_RESOURCE_REQUEST_LOGGED.swap(true, Ordering::Relaxed))
    {
        log(&format!("reader_protocol uri={uri} path={path}"));
    }
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let response = match handle_request(&state, &path) {
            Some((bytes, mime)) => {
                let cacheable = path.starts_with("/cover/") || path.starts_with("/res/");
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
    fn small_chapters_are_not_split() {
        let body = "<p>短章节</p>";
        assert_eq!(split_body_ranges(body, body.len()), vec![(0, body.len())]);
    }

    #[test]
    fn large_chapters_split_on_structure_and_keep_utf8_boundaries() {
        let mut body = "甲".repeat(VIRTUAL_CHAPTER_TARGET_BYTES / 3 + 128);
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
}
