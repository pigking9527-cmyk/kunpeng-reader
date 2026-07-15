use crate::search_core::{ascii_lower_bytes, snippet_at_with_context, BookSearchBloom};
use crate::search_index::{self, BookIndex, INDEX_VERSION};
use crate::{
    atomic_file, book, emit_startup_perf, set_thread_background, strip_tags, url_open, AppState,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

const FILTER_MAGIC: &[u8; 8] = b"KPBLOOM1";
const FILTER_HEADER_LEN: usize = 8 + 8 + 4;

const FILTER_CACHE_BUDGET: usize = 128 * 1024 * 1024;

struct CachedBookFilter {
    mtime: u64,
    bloom: Arc<BookSearchBloom>,
    bytes: usize,
}

#[derive(Default)]
struct BookFilterCache {
    entries: HashMap<u64, CachedBookFilter>,
    order: VecDeque<u64>,
    bytes: usize,
}

impl BookFilterCache {
    fn get(&mut self, id: u64, mtime: u64) -> Option<Arc<BookSearchBloom>> {
        let value = match self.entries.get(&id) {
            Some(entry) if entry.mtime == mtime => Some(entry.bloom.clone()),
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
        }
        self.order.retain(|existing| *existing != id);
    }

    fn insert(&mut self, id: u64, mtime: u64, bloom: Arc<BookSearchBloom>) {
        self.remove(id);
        let bytes = bloom.bits().len();
        if bytes > FILTER_CACHE_BUDGET {
            return;
        }
        while self.bytes.saturating_add(bytes) > FILTER_CACHE_BUDGET {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
        self.entries.insert(
            id,
            CachedBookFilter {
                mtime,
                bloom,
                bytes,
            },
        );
        self.bytes += bytes;
        self.touch(id);
    }
}

static BOOK_FILTER_CACHE: OnceLock<Mutex<BookFilterCache>> = OnceLock::new();

#[derive(Clone, Serialize)]
struct SearchQueryPayload {
    term: String,
    ids: Vec<String>,
}

fn filter_cache() -> &'static Mutex<BookFilterCache> {
    BOOK_FILTER_CACHE.get_or_init(|| Mutex::new(BookFilterCache::default()))
}

fn encode_book_filter(mtime: u64, bloom: &BookSearchBloom) -> Vec<u8> {
    let bits = bloom.bits();
    let mut bytes = Vec::with_capacity(FILTER_HEADER_LEN + bits.len());
    bytes.extend_from_slice(FILTER_MAGIC);
    bytes.extend_from_slice(&mtime.to_le_bytes());
    bytes.extend_from_slice(&(bits.len() as u32).to_le_bytes());
    bytes.extend_from_slice(bits);
    bytes
}

fn decode_book_filter(bytes: &[u8], expected_mtime: u64) -> Option<BookSearchBloom> {
    if bytes.len() < FILTER_HEADER_LEN || &bytes[..8] != FILTER_MAGIC {
        return None;
    }
    let mtime = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let length = u32::from_le_bytes(bytes[16..20].try_into().ok()?) as usize;
    if mtime != expected_mtime || bytes.len() != FILTER_HEADER_LEN + length {
        return None;
    }
    BookSearchBloom::from_bits(bytes[FILTER_HEADER_LEN..].to_vec())
}

fn load_book_filter(id: u64, mtime: u64) -> Option<Arc<BookSearchBloom>> {
    if let Ok(mut cache) = filter_cache().lock() {
        if let Some(bloom) = cache.get(id, mtime) {
            return Some(bloom);
        }
    }
    let bytes = std::fs::read(search_index::filter_path(id)?).ok()?;
    let bloom = Arc::new(decode_book_filter(&bytes, mtime)?);
    if let Ok(mut cache) = filter_cache().lock() {
        cache.insert(id, mtime, bloom.clone());
    }
    Some(bloom)
}

fn save_book_filter(id: u64, mtime: u64, chapters: &[String]) -> Result<(), String> {
    let bloom = Arc::new(BookSearchBloom::from_chapters(chapters));
    let path = search_index::filter_path(id).ok_or("无法确定检索预筛选索引目录")?;
    atomic_file::write(&path, &encode_book_filter(mtime, &bloom))?;
    let mut cache = filter_cache().lock().map_err(|e| e.to_string())?;
    cache.insert(id, mtime, bloom);
    Ok(())
}

fn book_might_contain(book: &book::Book, query: &str) -> bool {
    let mtime = file_mtime(&book.path);
    load_book_filter(book.id, mtime)
        .map(|bloom| bloom.might_contain(query))
        .unwrap_or(true)
}

fn search_assets_current(book: &book::Book, mtime: u64) -> bool {
    search_index::index_path(book.id)
        .map(|path| path.exists())
        .unwrap_or(false)
        && load_book_filter(book.id, mtime).is_some()
}

fn ensure_search_assets(book: &book::Book, mtime: u64) -> bool {
    let Some(index) = ensure_book_index(book) else {
        return false;
    };
    save_book_filter(book.id, mtime, &index.chapters).is_ok()
}

pub(crate) fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 抽取一本书的逐章纯文本。epub=spine 顺序去标签；txt/md=单章；pdf=空（不支持）。
fn extract_book_text(book: &book::Book) -> Vec<String> {
    match book.format.as_str() {
        "epub" => {
            let Ok(mut doc) = EpubDoc::new(&book.path) else {
                return Vec::new();
            };
            let spine: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
            spine
                .iter()
                .map(|idref| {
                    doc.get_resource_str(idref)
                        .map(|(h, _)| strip_tags(&h))
                        .unwrap_or_default()
                })
                .collect()
        }
        "pdf" => extract_pdf_pages(&book.path),
        _ => match std::fs::read(&book.path) {
            Ok(b) => vec![book::normalize_text(&book::decode_bytes(&b))],
            Err(_) => Vec::new(),
        },
    }
}

pub(crate) fn extract_pdf_pages(path: &Path) -> Vec<String> {
    let path = path.to_owned();
    let res = std::panic::catch_unwind(move || {
        pdf_extract::extract_text_by_pages(&path).unwrap_or_default()
    });
    match res {
        Ok(pages) => pages
            .into_iter()
            .map(|p| book::normalize_text(&p))
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn ensure_book_index(book: &book::Book) -> Option<BookIndex> {
    if book.format == "pdf" {
        return None;
    }
    let id = book.id;
    let mtime = file_mtime(&book.path);
    if let Some((mut idx, legacy)) = search_index::load_index(id) {
        if idx.mtime == mtime && (idx.v == INDEX_VERSION || idx.v == 2) {
            if legacy || idx.v != INDEX_VERSION {
                idx.v = INDEX_VERSION;
                let _ = search_index::save_index(id, &idx);
            }
            return Some(idx);
        }
    }
    let chapters = extract_book_text(book);
    if chapters.is_empty() {
        return None;
    }
    let idx = BookIndex {
        v: INDEX_VERSION,
        mtime,
        chapters,
    };
    let _ = search_index::save_index(id, &idx);
    Some(idx)
}

fn valid_index_ids(state: &AppState) -> HashSet<u64> {
    state
        .library
        .lock()
        .map(|library| library.books.iter().map(|book| book.id).collect())
        .unwrap_or_default()
}

fn attach_memory_health(
    state: &AppState,
    mut health: search_index::SearchIndexDiskHealth,
) -> search_index::SearchIndexDiskHealth {
    health.memory_limit_bytes =
        (crate::search_cache::SEARCH_TEXT_CACHE_BUDGET + FILTER_CACHE_BUDGET) as u64;
    if let Ok(cache) = state.search_text_cache.lock() {
        health.memory_bytes = cache.bytes() as u64;
        health.memory_entries = cache.entries() as u32;
    }
    if let Ok(cache) = filter_cache().lock() {
        health.memory_bytes = health.memory_bytes.saturating_add(cache.bytes as u64);
        health.memory_entries = health
            .memory_entries
            .saturating_add(cache.entries.len() as u32);
    }
    health
}

pub(crate) fn index_health(state: &AppState) -> search_index::SearchIndexDiskHealth {
    let valid_ids = valid_index_ids(state);
    attach_memory_health(state, search_index::inspect(&valid_ids))
}

pub(crate) fn maintain_index(
    state: &AppState,
    enforce_quota: bool,
) -> search_index::SearchIndexDiskHealth {
    let valid_ids = valid_index_ids(state);
    attach_memory_health(state, search_index::maintain(&valid_ids, enforce_quota))
}
/// 后台为全书架建立/更新索引。只补缺失，避免启动时全量重建抢 UI。
pub(crate) fn spawn_build_index(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        let started = std::time::Instant::now();
        emit_startup_perf(&app, "keyword-index", "start", "background incremental");
        let state = app.state::<AppState>();
        let books: Vec<book::Book> = { state.library.lock().unwrap().books.clone() };
        let valid_ids: HashSet<u64> = books.iter().map(|book| book.id).collect();
        let _ = search_index::maintain(&valid_ids, false);
        let total = books.len();
        let mut skipped = 0usize;
        let mut indexed = 0usize;
        for b in books {
            let mtime = file_mtime(&b.path);
            let already_indexed = search_assets_current(&b, mtime);
            if already_indexed {
                skipped += 1;
                continue;
            }
            if ensure_search_assets(&b, mtime) {
                indexed += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let maintenance = search_index::maintain(&valid_ids, true);
        emit_startup_perf(
            &app,
            "keyword-index",
            "end",
            format!(
                "{}ms total={} indexed={} skipped={} removed={} disk_mb={}",
                started.elapsed().as_millis(),
                total,
                indexed,
                skipped,
                maintenance.removed_files,
                maintenance.disk_bytes / (1024 * 1024)
            ),
        );
        set_thread_background(false);
    });
}

#[tauri::command]
pub(crate) fn build_shelf_index(app: tauri::AppHandle) {
    spawn_build_index(app);
}

#[derive(Serialize)]
struct ChapterHit {
    chapter: u32,
    snippet: String,
    count: u32,
    score: f64,
}

#[derive(Serialize)]
pub(crate) struct ShelfBookHits {
    book_id: String,
    title: String,
    author: String,
    count: u32,
    score: f64,
    hits: Vec<ChapterHit>,
}

pub(crate) fn get_book_chapters(state: &AppState, book: &book::Book) -> Option<Arc<Vec<String>>> {
    let id = book.id;
    let mtime = file_mtime(&book.path);
    {
        let mut cache = state.search_text_cache.lock().unwrap();
        if let Some(arc) = cache.get_text(id, mtime) {
            return Some(arc);
        }
    }
    let idx = ensure_book_index(book)?;
    let arc = Arc::new(idx.chapters);
    state
        .search_text_cache
        .lock()
        .unwrap()
        .insert_text(id, mtime, arc.clone());
    Some(arc)
}

fn get_lower_book_chapters(
    state: &AppState,
    book: &book::Book,
    chapters: &Arc<Vec<String>>,
) -> Arc<Vec<Vec<u8>>> {
    let id = book.id;
    let mtime = file_mtime(&book.path);
    {
        let mut cache = state.search_text_cache.lock().unwrap();
        if let Some(arc) = cache.get_lower(id, mtime) {
            return arc;
        }
    }
    let arc = Arc::new(
        chapters
            .iter()
            .map(|s| ascii_lower_bytes(s))
            .collect::<Vec<_>>(),
    );
    state
        .search_text_cache
        .lock()
        .unwrap()
        .insert_lower(id, mtime, arc.clone());
    arc
}

fn search_one_book(
    state: &AppState,
    book: &book::Book,
    term_lower: &[u8],
    needs_ci: bool,
) -> Option<ShelfBookHits> {
    let chapters = get_book_chapters(state, book)?;
    let finder = memchr::memmem::Finder::new(term_lower);
    let mut count = 0u32;
    let mut hits: Vec<ChapterHit> = Vec::new();
    if needs_ci {
        let lower_chapters = get_lower_book_chapters(state, book, &chapters);
        for (ci, lower) in lower_chapters.iter().enumerate() {
            let text = &chapters[ci];
            for mb in finder.find_iter(lower) {
                count += 1;
                if hits.len() < 60 {
                    hits.push(ChapterHit {
                        chapter: ci as u32,
                        snippet: snippet_at_with_context(text, mb, term_lower.len(), 260),
                        count: 1,
                        score: 0.0,
                    });
                }
                if count >= 3000 {
                    break;
                }
            }
            if count >= 3000 {
                break;
            }
        }
    } else {
        for (ci, text) in chapters.iter().enumerate() {
            for mb in finder.find_iter(text.as_bytes()) {
                count += 1;
                if hits.len() < 60 {
                    hits.push(ChapterHit {
                        chapter: ci as u32,
                        snippet: snippet_at_with_context(text, mb, term_lower.len(), 260),
                        count: 1,
                        score: 0.0,
                    });
                }
                if count >= 3000 {
                    break;
                }
            }
            if count >= 3000 {
                break;
            }
        }
    }
    if count == 0 {
        return None;
    }
    Some(ShelfBookHits {
        book_id: book.id.to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        count,
        score: count as f64,
        hits,
    })
}

#[tauri::command]
pub(crate) async fn shelf_search(
    app: tauri::AppHandle,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<ShelfBookHits>, ()> {
    tauri::async_runtime::spawn_blocking(move || {
        set_thread_background(true);
        let result = shelf_search_blocking(&app, term, ids);
        set_thread_background(false);
        result
    })
    .await
    .map_err(|_| ())?
}

fn shelf_search_blocking(
    app: &tauri::AppHandle,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<ShelfBookHits>, ()> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let state = app.state::<AppState>();
    let want: Option<HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    let targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .cloned()
            .collect()
    };

    let needs_ci = term.bytes().any(|b| b.is_ascii_alphabetic());
    let term_lower = ascii_lower_bytes(&term);

    let st: &AppState = state.inner();
    // 先以精确原文扫描保证结果完整。当前倒排索引仍可能是部分索引或旧索引，
    // 直接采用会导致书架全文检索/阅读页跨书搜索漏书、漏命中。
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .max(1);
    let chunk_size = targets.len().div_ceil(nthreads).max(1);

    let query = &term;
    let mut results: Vec<ShelfBookHits> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                let term_lower = &term_lower;
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for b in chunk {
                        if !book_might_contain(b, query) {
                            continue;
                        }
                        if let Some(h) = search_one_book(st, b, term_lower, needs_ci) {
                            out.push(h);
                        }
                    }
                    out
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });

    results.sort_by_key(|item| std::cmp::Reverse(item.count));
    Ok(results)
}

#[tauri::command]
pub(crate) async fn open_search_window(
    app: tauri::AppHandle,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    let label = "shelf-search";
    let ids_vec = ids.unwrap_or_default();
    let ids_csv = ids_vec.join(",");
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_focus();
        let _ = w.emit(
            "shelf-search-query",
            SearchQueryPayload {
                term: term.clone(),
                ids: ids_vec,
            },
        );
        return Ok(());
    }
    let url = format!(
        "search.html?q={}&ids={}",
        url_encode(&term),
        url_encode(&ids_csv)
    );
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title("书架全文检索")
        .inner_size(1000.0, 760.0)
        .min_inner_size(520.0, 400.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn web_search(term: String) -> Result<(), String> {
    let t = term.trim();
    if t.is_empty() {
        return Ok(());
    }
    let url = format!("https://www.baidu.com/s?wd={}", url_encode(t));
    url_open::open_https_url(&url)
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_escapes_unicode_and_spaces() {
        assert_eq!(url_encode("南明 a"), "%E5%8D%97%E6%98%8E%20a");
    }

    #[test]
    fn file_mtime_returns_zero_for_missing_path() {
        assert_eq!(
            file_mtime(Path::new("__definitely_missing_kunpeng_reader__")),
            0
        );
    }
    #[test]
    fn bloom_file_roundtrip_checks_mtime_and_payload_length() {
        let bloom = BookSearchBloom::from_chapters(&["中国文史哲 Rust".to_string()]);
        let bytes = encode_book_filter(42, &bloom);
        let decoded = decode_book_filter(&bytes, 42).unwrap();
        assert!(decoded.might_contain("文史哲"));
        assert!(decoded.might_contain("RUST"));
        assert!(decode_book_filter(&bytes, 43).is_none());
        assert!(decode_book_filter(&bytes[..bytes.len() - 1], 42).is_none());
    }
}
