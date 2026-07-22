use crate::search_core::{ascii_lower_bytes, snippet_at_with_context, BookSearchBloom};
use crate::search_index::{self, BookIndex, SourceFingerprint, INDEX_VERSION};
use crate::{
    atomic_file, book, emit_startup_perf, interactive_search_workers, reader_protocol::strip_tags,
    set_thread_background, url_open, with_thread_background_priority, AppState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use tauri::{Emitter, Manager};

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

const FILTER_MAGIC: &[u8; 8] = b"KPBLOOM2";
const FILTER_HEADER_LEN: usize = 8 + 4 + 8 + 32 + 4 + 32;

struct CachedBookFilter {
    source: SourceFingerprint,
    bloom: Arc<BookSearchBloom>,
    bytes: usize,
    _permit: crate::memory_budget::MemoryPermit,
}

struct BookFilterCache {
    entries: HashMap<u64, CachedBookFilter>,
    order: VecDeque<u64>,
    retired: Vec<(Weak<BookSearchBloom>, crate::memory_budget::MemoryPermit)>,
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
            budget: crate::memory_budget::plan().search_filter_bytes as usize,
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
        let Ok(permit) = crate::memory_budget::governor().try_acquire(
            crate::memory_budget::MemoryClass::SearchFilter,
            crate::memory_budget::MemoryUsageKind::Resident,
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
// 交互式检索发现缺失索引时会请求后台补建。全局闸门避免多次搜索、导入和启动维护
// 同时解压同一批 EPUB，进而把 WebView 线程饿死。
static INDEX_BUILD_RUNNING: AtomicBool = AtomicBool::new(false);

struct IndexBuildGuard;

impl Drop for IndexBuildGuard {
    fn drop(&mut self) {
        INDEX_BUILD_RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
struct SearchQueryPayload {
    term: String,
    ids: Vec<String>,
}

fn filter_cache() -> &'static Mutex<BookFilterCache> {
    BOOK_FILTER_CACHE.get_or_init(|| Mutex::new(BookFilterCache::default()))
}

pub(crate) fn clear_filter_memory_cache() {
    if let Ok(mut cache) = filter_cache().try_lock() {
        cache.clear();
    }
}

fn encode_book_filter(source: &SourceFingerprint, bloom: &BookSearchBloom) -> Vec<u8> {
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

fn decode_book_filter(
    bytes: &[u8],
    expected_source: &SourceFingerprint,
) -> Option<BookSearchBloom> {
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

fn load_book_filter(id: u64, source: &SourceFingerprint) -> Option<Arc<BookSearchBloom>> {
    if let Ok(mut cache) = filter_cache().lock() {
        if let Some(bloom) = cache.get(id, source) {
            return Some(bloom);
        }
    }
    let bytes = std::fs::read(search_index::filter_path(id)?).ok()?;
    let bloom = Arc::new(decode_book_filter(&bytes, source)?);
    if let Ok(mut cache) = filter_cache().lock() {
        cache.insert(id, source.clone(), bloom.clone());
    }
    Some(bloom)
}

fn save_book_filter(
    id: u64,
    source: &SourceFingerprint,
    chapters: &[String],
) -> Result<(), String> {
    let bloom = Arc::new(BookSearchBloom::from_chapters(chapters));
    let path = search_index::filter_path(id).ok_or("无法确定检索预筛选索引目录")?;
    atomic_file::write(&path, &encode_book_filter(source, &bloom))?;
    let mut cache = filter_cache().lock().map_err(|e| e.to_string())?;
    cache.insert(id, source.clone(), bloom);
    Ok(())
}

/// Returns `None` when the book has no ready Bloom filter. Interactive search
/// must not build one synchronously: extracting a large EPUB here blocks the
/// IPC response and makes the whole shelf window look unresponsive.
fn book_might_contain(book: &book::Book, query: &str) -> Option<bool> {
    let Ok(source) =
        search_index::source_fingerprint_from_content_id(Path::new(&book.path), &book.content_id)
    else {
        return None;
    };
    load_book_filter(book.id, &source).map(|bloom| bloom.might_contain(query))
}

/// 为短中文专名/固定短语补充词面候选。这里只读取常驻 Bloom 过滤器，不解压
/// 全书文本；精确片段会在语义候选书内由混合排序再次验证。
pub(crate) fn semantic_lexical_candidates(
    state: &AppState,
    books: &[book::Book],
    query: &str,
    limit: usize,
) -> Vec<book::Book> {
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let folded_query = query.to_lowercase();
    let mut candidates = books
        .iter()
        .filter(|book| book.format != "pdf")
        .map(|book| {
            let title = book.title.to_lowercase();
            let author = book.author.to_lowercase();
            let description = book.description.to_lowercase();
            let metadata_score = if title.contains(&folded_query) {
                3u8
            } else if description.contains(&folded_query) {
                2
            } else if author.contains(&folded_query) {
                1
            } else {
                0
            };
            let bloom_match = search_index::source_fingerprint_from_content_id(
                Path::new(&book.path),
                &book.content_id,
            )
            .ok()
            .and_then(|source| load_book_filter(book.id, &source))
            .map(|bloom| bloom.might_contain(query))
            .unwrap_or(false);
            (metadata_score, bloom_match, book.clone())
        })
        // 语义查询只复用已经发布的过滤器，不在交互查询中同步建立全文索引。
        // 若过滤器尚未建立，书名、作者或简介的精确命中仍可进入候选。
        .filter(|(metadata_score, bloom_match, _)| *metadata_score > 0 || *bloom_match)
        .collect::<Vec<_>>();
    // Bloom 只负责低成本排除不可能命中的书。对留下的小集合再用现有关键词
    // 索引确认完整短语，并按书名元数据和真实命中数排序，避免 Bloom 假阳性
    // 消耗昂贵的 1792 维向量扫描预算。
    candidates.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.2.title.cmp(&right.2.title))
    });
    candidates.truncate(limit.saturating_mul(4).max(limit));
    let term_lower = ascii_lower_bytes(query);
    let needs_ci = query.bytes().any(|byte| byte.is_ascii_alphabetic());
    let mut ranked = candidates
        .into_iter()
        .filter_map(|(metadata_score, bloom_match, book)| {
            let exact_count = bloom_match
                .then(|| search_one_book(state, &book, &term_lower, needs_ci))
                .flatten()
                .map(|hits| hits.count)
                .unwrap_or(0);
            (exact_count > 0 || metadata_score > 0).then_some((exact_count, metadata_score, book))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        let left_exact = left.0 > 0;
        let right_exact = right.0 > 0;
        right_exact
            .cmp(&left_exact)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.0.cmp(&left.0))
            .then_with(|| left.2.title.cmp(&right.2.title))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, book)| book)
        .collect()
}

fn search_assets_current(book: &book::Book, source: &SourceFingerprint) -> bool {
    search_index::load_index(book.id)
        .map(|(index, _legacy)| index.is_current(source))
        .unwrap_or(false)
        && load_book_filter(book.id, source).is_some()
}

fn ensure_search_assets(book: &book::Book, source: &SourceFingerprint) -> bool {
    let Some(index) = ensure_book_index_with_source(book, source) else {
        return false;
    };
    save_book_filter(book.id, source, &index.chapters).is_ok()
}

fn source_content_id(source: &SourceFingerprint) -> String {
    source
        .sha256
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

fn ensure_book_index_with_source(
    book: &book::Book,
    source: &SourceFingerprint,
) -> Option<BookIndex> {
    if book.format == "pdf" {
        return None;
    }
    let mtime = file_mtime(&book.path);
    if let Some((idx, legacy)) = search_index::load_index(book.id) {
        if idx.is_current(source) {
            if legacy {
                let _ = search_index::save_index(book.id, &idx);
            }
            return Some(idx);
        }
    }
    let chapters = extract_book_text(book);
    if chapters.is_empty() {
        return None;
    }
    // Do not publish an index if the source changed while it was being read.
    if search_index::source_fingerprint(Path::new(&book.path))
        .ok()
        .as_ref()
        != Some(source)
    {
        return None;
    }
    let idx = BookIndex {
        v: INDEX_VERSION,
        mtime,
        source: source.clone(),
        chapters,
    };
    let _ = search_index::save_index(book.id, &idx);
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
    let memory_plan = crate::memory_budget::plan();
    health.memory_limit_bytes = memory_plan
        .search_text_bytes
        .saturating_add(memory_plan.search_filter_bytes);
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
    if INDEX_BUILD_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let _build_guard = IndexBuildGuard;
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
        let mut content_ids_changed = false;
        for mut b in books {
            let Ok(source) = search_index::source_fingerprint(Path::new(&b.path)) else {
                continue;
            };
            let verified_content_id = source_content_id(&source);
            if b.content_id != verified_content_id {
                state
                    .library
                    .lock()
                    .unwrap()
                    .set_content_id(b.id, verified_content_id.clone());
                b.content_id = verified_content_id;
                content_ids_changed = true;
            }
            let already_indexed = search_assets_current(&b, &source);
            if already_indexed {
                skipped += 1;
                continue;
            }
            if ensure_search_assets(&b, &source) {
                indexed += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        if content_ids_changed {
            crate::report_save_error("书架内容标识", state.library.lock().unwrap().save());
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

#[derive(Clone, Serialize)]
pub(crate) struct ChapterHit {
    chapter: u32,
    snippet: String,
    count: u32,
    score: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShelfSearchBookHitsRequest {
    book_id: String,
    term: String,
    offset: usize,
    limit: usize,
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

/// Keyword-search response. `pending_books` are deliberately excluded from
/// the current response when their source text/index is not ready yet; their
/// extraction continues through the single background index task.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShelfSearchResponse {
    results: Vec<ShelfBookHits>,
    pending_books: usize,
}

pub(crate) fn get_book_chapters(state: &AppState, book: &book::Book) -> Option<Arc<Vec<String>>> {
    let id = book.id;
    let source =
        search_index::source_fingerprint_from_content_id(Path::new(&book.path), &book.content_id)
            .ok()?;
    {
        let mut cache = state.search_text_cache.lock().unwrap();
        if let Some(arc) = cache.get_text(id, source.sha256) {
            return Some(arc);
        }
    }
    let idx = ensure_book_index_with_source(book, &source)?;
    let arc = Arc::new(idx.chapters);
    state
        .search_text_cache
        .lock()
        .unwrap()
        .insert_text(id, source.sha256, arc.clone());
    Some(arc)
}

/// Load only an already-published index. This is the interactive counterpart
/// to `get_book_chapters`: it never reads raw book content or writes an index.
fn get_indexed_book_chapters(state: &AppState, book: &book::Book) -> Option<Arc<Vec<String>>> {
    let id = book.id;
    let source =
        search_index::source_fingerprint_from_content_id(Path::new(&book.path), &book.content_id)
            .ok()?;
    {
        let mut cache = state.search_text_cache.lock().unwrap();
        if let Some(arc) = cache.get_text(id, source.sha256) {
            return Some(arc);
        }
    }
    let (idx, _) = search_index::load_index(id)?;
    if !idx.is_current(&source) {
        return None;
    }
    let arc = Arc::new(idx.chapters);
    state
        .search_text_cache
        .lock()
        .unwrap()
        .insert_text(id, source.sha256, arc.clone());
    Some(arc)
}

fn get_lower_book_chapters(
    state: &AppState,
    book: &book::Book,
    chapters: &Arc<Vec<String>>,
) -> Arc<Vec<Vec<u8>>> {
    let id = book.id;
    let source_sha256 =
        search_index::source_fingerprint_from_content_id(Path::new(&book.path), &book.content_id)
            .map(|source| source.sha256)
            .unwrap_or([0; 32]);
    {
        let mut cache = state.search_text_cache.lock().unwrap();
        if let Some(arc) = cache.get_lower(id, source_sha256) {
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
        .insert_lower(id, source_sha256, arc.clone());
    arc
}

fn search_one_book(
    state: &AppState,
    book: &book::Book,
    term_lower: &[u8],
    needs_ci: bool,
) -> Option<ShelfBookHits> {
    let chapters = get_book_chapters(state, book)?;
    search_one_book_chapters(state, book, chapters, term_lower, needs_ci)
}

/// Search a book without falling back to raw-content extraction. Used only by
/// shelf keyword search so a missing index is deferred to background work.
fn search_one_book_indexed(
    state: &AppState,
    book: &book::Book,
    term_lower: &[u8],
    needs_ci: bool,
) -> Option<ShelfBookHits> {
    let chapters = get_indexed_book_chapters(state, book)?;
    search_one_book_chapters(state, book, chapters, term_lower, needs_ci)
}

fn search_one_book_chapters(
    state: &AppState,
    book: &book::Book,
    chapters: Arc<Vec<String>>,
    term_lower: &[u8],
    needs_ci: bool,
) -> Option<ShelfBookHits> {
    let finder = memchr::memmem::Finder::new(term_lower);
    let mut count = 0u32;
    let mut hits: Vec<ChapterHit> = Vec::new();
    if needs_ci {
        let lower_chapters = get_lower_book_chapters(state, book, &chapters);
        for (ci, lower) in lower_chapters.iter().enumerate() {
            let text = &chapters[ci];
            for mb in finder.find_iter(lower) {
                count += 1;
                if hits.len() < 8 {
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
                if hits.len() < 8 {
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

fn search_book_hit_page(
    state: &AppState,
    book: &book::Book,
    term: &str,
    offset: usize,
    limit: usize,
) -> Vec<ChapterHit> {
    let Some(chapters) = get_book_chapters(state, book) else {
        return Vec::new();
    };
    let needs_ci = term.bytes().any(|byte| byte.is_ascii_alphabetic());
    let term_lower = ascii_lower_bytes(term);
    if term_lower.is_empty() {
        return Vec::new();
    }
    let finder = memchr::memmem::Finder::new(&term_lower);
    let offset = offset.min(3000);
    let limit = limit.clamp(1, 50).min(3000usize.saturating_sub(offset));
    let mut seen = 0usize;
    let mut hits = Vec::with_capacity(limit);

    if needs_ci {
        let lower_chapters = get_lower_book_chapters(state, book, &chapters);
        for (chapter, lower) in lower_chapters.iter().enumerate() {
            let text = &chapters[chapter];
            for position in finder.find_iter(lower) {
                if seen >= offset {
                    hits.push(ChapterHit {
                        chapter: chapter as u32,
                        snippet: snippet_at_with_context(text, position, term_lower.len(), 260),
                        count: 1,
                        score: 0.0,
                    });
                    if hits.len() >= limit {
                        return hits;
                    }
                }
                seen += 1;
            }
        }
    } else {
        for (chapter, text) in chapters.iter().enumerate() {
            for position in finder.find_iter(text.as_bytes()) {
                if seen >= offset {
                    hits.push(ChapterHit {
                        chapter: chapter as u32,
                        snippet: snippet_at_with_context(text, position, term_lower.len(), 260),
                        count: 1,
                        score: 0.0,
                    });
                    if hits.len() >= limit {
                        return hits;
                    }
                }
                seen += 1;
            }
        }
    }
    hits
}

/// 关键词结果按书分页取片段。首轮只回传少量预览，用户点击“另有…”时再取
/// 下一批，避免大结果集通过 WebView IPC 一次性传输而卡住输入框。
#[tauri::command]
pub(crate) async fn shelf_search_book_hits(
    app: tauri::AppHandle,
    request: ShelfSearchBookHitsRequest,
) -> Result<Vec<ChapterHit>, String> {
    let book_id = request
        .book_id
        .parse::<u64>()
        .map_err(|_| "图书编号无效".to_string())?;
    let term = request.term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let book = {
        let state = app.state::<AppState>();
        let library = state.library.lock().map_err(|error| error.to_string())?;
        library
            .books
            .iter()
            .find(|book| book.id == book_id)
            .cloned()
            .ok_or_else(|| "图书不存在".to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        with_thread_background_priority(|| {
            let state = app.state::<AppState>();
            search_book_hit_page(state.inner(), &book, &term, request.offset, request.limit)
        })
    })
    .await
    .map_err(|error| format!("加载更多搜索结果失败：{error}"))
}

#[tauri::command]
pub(crate) async fn shelf_search(
    app: tauri::AppHandle,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<ShelfSearchResponse, ()> {
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
) -> Result<ShelfSearchResponse, ()> {
    let started = std::time::Instant::now();
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(ShelfSearchResponse {
            results: Vec::new(),
            pending_books: 0,
        });
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
    let target_count = targets.len();

    let needs_ci = term.bytes().any(|b| b.is_ascii_alphabetic());
    let term_lower = ascii_lower_bytes(&term);

    let st: &AppState = state.inner();
    // 交互搜索只使用已经发布的索引。旧实现会在这里为每本缺失索引的 EPUB
    // 同步抽取全文，首查可能数十秒无响应；现在由后台索引任务补齐并在结果中提示。
    let mut ready_targets = Vec::with_capacity(targets.len());
    let mut pending_books = 0usize;
    for book in targets {
        match book_might_contain(&book, &term) {
            Some(false) => {}
            Some(true) => ready_targets.push(book),
            None => pending_books += 1,
        }
    }
    if pending_books > 0 {
        spawn_build_index(app.clone());
    }

    let nthreads = interactive_search_workers(ready_targets.len());
    let chunk_size = ready_targets.len().div_ceil(nthreads).max(1);

    let mut results: Vec<ShelfBookHits> = std::thread::scope(|scope| {
        let handles: Vec<_> = ready_targets
            .chunks(chunk_size)
            .map(|chunk| {
                let term_lower = &term_lower;
                scope.spawn(move || {
                    with_thread_background_priority(|| {
                        let mut out = Vec::new();
                        for b in chunk {
                            if let Some(h) = search_one_book_indexed(st, b, term_lower, needs_ci) {
                                out.push(h);
                            }
                        }
                        out
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });

    results.sort_by_key(|item| std::cmp::Reverse(item.count));
    let preview_count = results
        .iter()
        .map(|result| result.hits.len())
        .sum::<usize>();
    crate::log(&format!(
        "shelf_search query_chars={} targets={} ready={} pending={} books={} previews={} total_ms={}",
        term.chars().count(),
        target_count,
        ready_targets.len(),
        pending_books,
        results.len(),
        preview_count,
        started.elapsed().as_millis()
    ));
    Ok(ShelfSearchResponse {
        results,
        pending_books,
    })
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

    fn test_source(bytes: &[u8]) -> SourceFingerprint {
        SourceFingerprint {
            v: 1,
            bytes: bytes.len() as u64,
            sha256: Sha256::digest(bytes).into(),
        }
    }

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
    fn bloom_file_roundtrip_checks_source_and_payload_integrity() {
        let bloom = BookSearchBloom::from_chapters(&["中国文史哲 Rust".to_string()]);
        let source = test_source(b"book-A");
        let bytes = encode_book_filter(&source, &bloom);
        let decoded = decode_book_filter(&bytes, &source).unwrap();
        assert!(decoded.might_contain("文史哲"));
        assert!(decoded.might_contain("RUST"));
        assert!(decode_book_filter(&bytes, &test_source(b"book-B")).is_none());
        assert!(decode_book_filter(&bytes[..bytes.len() - 1], &source).is_none());

        let mut flipped = bytes;
        flipped[FILTER_HEADER_LEN] ^= 0x80;
        assert!(decode_book_filter(&flipped, &source).is_none());
    }

    #[test]
    fn filter_eviction_keeps_permit_while_a_search_borrows_the_bloom() {
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
