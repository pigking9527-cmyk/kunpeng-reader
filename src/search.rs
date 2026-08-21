use crate::search_core::{ascii_lower_bytes, snippet_at_with_context};
use crate::search_index::{self, BookIndex, SourceFingerprint, INDEX_VERSION};
use crate::{
    background_tasks::{BackgroundTaskKind, TaskControlSignal},
    book, emit_startup_perf, html_sanitize, interactive_search_workers,
    reader_protocol::strip_tags,
    set_thread_background, url_open, window_commands, with_thread_background_priority, AppState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager};

mod filter;
mod hit_scan;
mod rules;

use hit_scan::{scan_book_hits, scan_hit_page};
use rules::{
    hit_page_window, metadata_match_score, needs_ascii_case_fold, percent_encode, sha256_hex,
};

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;
// 交互式检索发现缺失索引时会请求后台补建。全局闸门避免多次搜索、导入和启动维护
// 同时解压同一批 EPUB，进而把 WebView 线程饿死。
static INDEX_BUILD_RUNNING: AtomicBool = AtomicBool::new(false);
// 用户正在等待全文检索时，索引任务不应因另一个阅读窗口而无限暂停。
// 它仍使用后台线程和全局单任务闸门，只提升已有任务的调度优先级。
static INDEX_BUILD_INTERACTIVE: AtomicBool = AtomicBool::new(false);

struct IndexBuildGuard;

impl Drop for IndexBuildGuard {
    fn drop(&mut self) {
        INDEX_BUILD_RUNNING.store(false, Ordering::Release);
        INDEX_BUILD_INTERACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
struct SearchQueryPayload {
    term: String,
    ids: Vec<String>,
}

pub(crate) fn clear_filter_memory_cache() {
    filter::clear_memory_cache();
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
    filter::load(book.id, &source).map(|bloom| bloom.might_contain(query))
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
            let metadata_score = metadata_match_score(&title, &author, &description, &folded_query);
            let bloom_match = search_index::source_fingerprint_from_content_id(
                Path::new(&book.path),
                &book.content_id,
            )
            .ok()
            .and_then(|source| filter::load(book.id, &source))
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
    let needs_ci = needs_ascii_case_fold(query);
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
        && filter::load(book.id, source).is_some()
}

fn ensure_search_assets(book: &book::Book, source: &SourceFingerprint) -> bool {
    let Some(index) = ensure_book_index_with_source(book, source) else {
        return false;
    };
    filter::save(book.id, source, &index.chapters).is_ok()
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
    let (filter_bytes, filter_entries) = filter::memory_usage();
    health.memory_bytes = health.memory_bytes.saturating_add(filter_bytes);
    health.memory_entries = health.memory_entries.saturating_add(filter_entries);
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
pub(crate) fn spawn_build_index(app: tauri::AppHandle, interactive: bool) {
    if interactive {
        INDEX_BUILD_INTERACTIVE.store(true, Ordering::Release);
    }
    if INDEX_BUILD_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let state = app.state::<AppState>();
    let task = state
        .background_tasks
        .enqueue_or_resume(BackgroundTaskKind::FullTextIndex, "建立关键词索引");
    let task_id = task.id().to_string();
    if let Err(error) = task.spawn_detached("keyword-index", move |task| {
        let _build_guard = IndexBuildGuard;
        let started = std::time::Instant::now();
        emit_startup_perf(&app, "keyword-index", "start", "background incremental");
        let state = app.state::<AppState>();
        let books: Vec<book::Book> = { state.library.lock().unwrap().books.clone() };
        let valid_ids: HashSet<u64> = books.iter().map(|book| book.id).collect();
        let _ = search_index::maintain(&valid_ids, false);
        let total = books.len();
        let resume_from = task
            .checkpoint_value()
            .and_then(|checkpoint| checkpoint.parse::<usize>().ok())
            .unwrap_or(0)
            .min(total);
        let mut skipped = 0usize;
        let mut indexed = 0usize;
        let mut content_ids_changed = false;
        for (index, mut b) in books.into_iter().enumerate().skip(resume_from) {
            // 关键词维护会逐本读取源文件；让阅读窗口优先，避免在章节切换时抢磁盘。
            while window_commands::any_reader_window_open(&app)
                && !INDEX_BUILD_INTERACTIVE.load(Ordering::Acquire)
            {
                emit_startup_perf(&app, "keyword-index", "paused", "reader window open");
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            match task.control_signal() {
                TaskControlSignal::Continue => {}
                TaskControlSignal::Pause => {
                    let _ = task.checkpoint(
                        index as u64,
                        total as u64,
                        format!("已完成 {index}/{total} 本"),
                        index.to_string(),
                    );
                    let _ = task.pause();
                    return;
                }
                TaskControlSignal::Cancel => {
                    let _ = task.cancel();
                    return;
                }
            }
            let Ok(source) = search_index::source_fingerprint(Path::new(&b.path)) else {
                let _ = task.checkpoint(
                    (index + 1) as u64,
                    total as u64,
                    format!("跳过无效图书 {}/{}", index + 1, total),
                    (index + 1).to_string(),
                );
                continue;
            };
            let verified_content_id = sha256_hex(&source.sha256);
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
                let _ = task.checkpoint(
                    (index + 1) as u64,
                    total as u64,
                    format!("已检查 {}/{} 本", index + 1, total),
                    (index + 1).to_string(),
                );
                continue;
            }
            if ensure_search_assets(&b, &source) {
                indexed += 1;
            }
            let _ = task.checkpoint(
                (index + 1) as u64,
                total as u64,
                format!("已建立 {}/{} 本", index + 1, total),
                (index + 1).to_string(),
            );
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
        let _ = task.complete();
    }) {
        INDEX_BUILD_RUNNING.store(false, Ordering::Release);
        crate::log(&format!(
            "keyword index task {task_id} could not start: {error}"
        ));
    }
}

#[tauri::command]
pub(crate) fn build_shelf_index(app: tauri::AppHandle) {
    spawn_build_index(app, false);
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

/// 语义切块需要自然段边界。旧全文索引为了关键词扫描把 EPUB 的连续空白压成
/// 单个空格，因此这里只在建立语义向量时重新抽取 EPUB，并保留块级标签换行；
/// TXT/Markdown 等格式继续复用全文索引中的逐章文本。
pub(crate) fn get_semantic_book_chapters(
    state: &AppState,
    book: &book::Book,
) -> Option<Arc<Vec<String>>> {
    if book.format != "epub" {
        return get_book_chapters(state, book);
    }
    let mut doc = EpubDoc::new(&book.path).ok()?;
    let spine: Vec<String> = doc.spine.iter().map(|item| item.idref.clone()).collect();
    let chapters = spine
        .iter()
        .map(|idref| {
            doc.get_resource_str(idref)
                .map(|(html, _)| html_sanitize::html_to_plain_text(&html))
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    (!chapters.is_empty()).then(|| Arc::new(chapters))
}

/// Load only an already-published index. This is the interactive counterpart
/// to `get_book_chapters`: it never reads raw book content or writes an index.
///
/// The library RAG uses this to sample a selected book's directory and chapter
/// openings before it asks the semantic index for detailed passages.
pub(crate) fn get_indexed_book_chapters(
    state: &AppState,
    book: &book::Book,
) -> Option<Arc<Vec<String>>> {
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
    let lower_chapters = needs_ci.then(|| get_lower_book_chapters(state, book, &chapters));
    let scan = scan_book_hits(
        &chapters,
        lower_chapters.as_deref().map(Vec::as_slice),
        term_lower,
    );
    if scan.count == 0 {
        return None;
    }
    let hits = scan
        .previews
        .into_iter()
        .map(|location| ChapterHit {
            chapter: location.chapter as u32,
            snippet: snippet_at_with_context(
                &chapters[location.chapter],
                location.byte_offset,
                term_lower.len(),
                260,
            ),
            count: 1,
            score: 0.0,
        })
        .collect();
    Some(ShelfBookHits {
        book_id: book.id.to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        count: scan.count,
        score: scan.count as f64,
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
    let needs_ci = needs_ascii_case_fold(term);
    let term_lower = ascii_lower_bytes(term);
    if term_lower.is_empty() {
        return Vec::new();
    }
    let (offset, limit) = hit_page_window(offset, limit);
    let lower_chapters = needs_ci.then(|| get_lower_book_chapters(state, book, &chapters));
    scan_hit_page(
        &chapters,
        lower_chapters.as_deref().map(Vec::as_slice),
        &term_lower,
        offset,
        limit,
    )
    .into_iter()
    .map(|location| ChapterHit {
        chapter: location.chapter as u32,
        snippet: snippet_at_with_context(
            &chapters[location.chapter],
            location.byte_offset,
            term_lower.len(),
            260,
        ),
        count: 1,
        score: 0.0,
    })
    .collect()
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

    let needs_ci = needs_ascii_case_fold(&term);
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
        spawn_build_index(app.clone(), true);
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
        percent_encode(&term),
        percent_encode(&ids_csv)
    );
    let builder = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title("书架全文检索")
        .inner_size(1000.0, 760.0)
        .min_inner_size(520.0, 400.0);
    #[cfg(target_os = "macos")]
    let builder = if let Some(identifier) = crate::profile::webview_data_store_identifier() {
        builder.data_store_identifier(identifier)
    } else {
        builder
    };
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn web_search(term: String, engine: Option<String>) -> Result<(), String> {
    let t = term.trim();
    if t.is_empty() {
        return Ok(());
    }
    let url = if engine.as_deref() == Some("google") {
        format!("https://www.google.com/search?q={}", percent_encode(t))
    } else {
        format!("https://www.baidu.com/s?wd={}", percent_encode(t))
    };
    url_open::open_https_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_mtime_returns_zero_for_missing_path() {
        assert_eq!(
            file_mtime(Path::new("__definitely_missing_kunpeng_reader__")),
            0
        );
    }
}
