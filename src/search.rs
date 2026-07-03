use crate::search_core::{
    ascii_lower_bytes, keyword_postings_for_chapter, simple_ascii_query_key, snippet_at,
};
use crate::{book, emit_startup_perf, set_thread_background, strip_tags, url_open, AppState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager};

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

const INDEX_VERSION: u32 = 1;
const TEXT_CACHE_BUDGET: usize = 700 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct BookIndex {
    v: u32,
    mtime: u64,
    chapters: Vec<String>,
}

#[derive(Clone, Serialize)]
struct SearchQueryPayload {
    term: String,
    ids: Vec<String>,
}

fn index_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("index");
    Some(d)
}

fn index_path(id: u64) -> Option<std::path::PathBuf> {
    Some(index_dir()?.join(format!("idx_{id}.json")))
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

fn load_index(id: u64) -> Option<BookIndex> {
    let p = index_path(id)?;
    serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()
}

fn save_index(id: u64, idx: &BookIndex) {
    let Some(p) = index_path(id) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(idx) {
        let _ = std::fs::write(&p, s);
    }
}

fn index_book_keywords(state: &AppState, book: &book::Book, chapters: &[String]) {
    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    for (ci, text) in chapters.iter().enumerate() {
        for posting in keyword_postings_for_chapter(text) {
            let _ = db.upsert_keyword_posting(
                &posting.term,
                book.id,
                ci as u32,
                posting.count,
                &posting.snippets,
            );
        }
    }
}

fn ensure_book_index(book: &book::Book) -> Option<BookIndex> {
    if book.format == "pdf" {
        return None;
    }
    let id = book.id;
    let mtime = file_mtime(&book.path);
    if let Some(idx) = load_index(id) {
        if idx.v == INDEX_VERSION && idx.mtime == mtime {
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
    save_index(id, &idx);
    Some(idx)
}

/// 后台为全书架建立/更新索引。只补缺失，避免启动时全量重建抢 UI。
pub(crate) fn spawn_build_index(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        let started = std::time::Instant::now();
        emit_startup_perf(&app, "keyword-index", "start", "background incremental");
        let state = app.state::<AppState>();
        let books: Vec<book::Book> = { state.library.lock().unwrap().books.clone() };
        let total = books.len();
        let mut skipped = 0usize;
        let mut indexed = 0usize;
        for b in books {
            let already_indexed = state
                .db
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|db| db.has_keyword_index_for_book(b.id)))
                .unwrap_or(false);
            if already_indexed {
                skipped += 1;
                continue;
            }
            if let Some(idx) = ensure_book_index(&b) {
                if let Ok(db_guard) = state.db.lock() {
                    if let Some(db) = db_guard.as_ref() {
                        let _ = db.clear_keyword_index_for_book(b.id);
                    }
                }
                index_book_keywords(state.inner(), &b, &idx.chapters);
                indexed += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        emit_startup_perf(
            &app,
            "keyword-index",
            "end",
            format!(
                "{}ms total={} indexed={} skipped={}",
                started.elapsed().as_millis(),
                total,
                indexed,
                skipped
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
}

#[derive(Serialize)]
pub(crate) struct ShelfBookHits {
    book_id: String,
    title: String,
    author: String,
    count: u32,
    hits: Vec<ChapterHit>,
}

pub(crate) fn get_book_chapters(state: &AppState, book: &book::Book) -> Option<Arc<Vec<String>>> {
    let id = book.id;
    let mtime = file_mtime(&book.path);
    {
        let cache = state.text_cache.lock().unwrap();
        if let Some((mt, arc)) = cache.get(&id) {
            if *mt == mtime {
                return Some(arc.clone());
            }
        }
    }
    let idx = ensure_book_index(book)?;
    let arc = Arc::new(idx.chapters);
    let size: usize = arc.iter().map(|s| s.len()).sum();
    {
        let mut cache = state.text_cache.lock().unwrap();
        if state.cache_bytes.load(Ordering::Relaxed) + size <= TEXT_CACHE_BUDGET {
            cache.insert(id, (mtime, arc.clone()));
            state.cache_bytes.fetch_add(size, Ordering::Relaxed);
        }
    }
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
        let cache = state.lower_text_cache.lock().unwrap();
        if let Some((mt, arc)) = cache.get(&id) {
            if *mt == mtime {
                return arc.clone();
            }
        }
    }
    let arc = Arc::new(
        chapters
            .iter()
            .map(|s| ascii_lower_bytes(s))
            .collect::<Vec<_>>(),
    );
    let size: usize = arc.iter().map(|s| s.len()).sum();
    {
        let mut cache = state.lower_text_cache.lock().unwrap();
        if state.cache_bytes.load(Ordering::Relaxed) + size <= TEXT_CACHE_BUDGET {
            cache.insert(id, (mtime, arc.clone()));
            state.cache_bytes.fetch_add(size, Ordering::Relaxed);
        }
    }
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
                        snippet: snippet_at(text, mb, term_lower.len()),
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
                        snippet: snippet_at(text, mb, term_lower.len()),
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
        hits,
    })
}

fn search_keyword_index(
    state: &AppState,
    targets: &[book::Book],
    term: &str,
    want: Option<&HashSet<u64>>,
) -> Option<Vec<ShelfBookHits>> {
    let key = simple_ascii_query_key(term)?;
    let db_guard = state.db.lock().ok()?;
    let db = db_guard.as_ref()?;
    let rows = db.keyword_search(&key, want).ok()?;
    if rows.is_empty() && !db.has_keyword_index() {
        return None;
    }
    let mut titles: HashMap<u64, (&str, &str)> = HashMap::new();
    for b in targets {
        titles.insert(b.id, (&b.title, &b.author));
    }
    let mut grouped: HashMap<u64, ShelfBookHits> = HashMap::new();
    for row in rows {
        let (title, author) = titles.get(&row.book_id).copied().unwrap_or(("", ""));
        let entry = grouped.entry(row.book_id).or_insert_with(|| ShelfBookHits {
            book_id: row.book_id.to_string(),
            title: title.to_string(),
            author: author.to_string(),
            count: 0,
            hits: Vec::new(),
        });
        entry.count = entry.count.saturating_add(row.count);
        for snippet in row.snippets {
            if entry.hits.len() < 60 {
                entry.hits.push(ChapterHit {
                    chapter: row.chapter,
                    snippet,
                });
            }
        }
    }
    let mut out: Vec<ShelfBookHits> = grouped.into_values().collect();
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Some(out)
}

#[tauri::command]
pub(crate) async fn shelf_search(
    state: tauri::State<'_, AppState>,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<ShelfBookHits>, ()> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let want: Option<HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    let targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .cloned()
            .collect()
    };

    let needs_ci = term.bytes().any(|b| b.is_ascii_alphabetic());
    let term_lower = ascii_lower_bytes(&term);

    let st: &AppState = state.inner();
    if let Some(results) = search_keyword_index(st, &targets, &term, want.as_ref()) {
        return Ok(results);
    }
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .max(1);
    let chunk_size = targets.len().div_ceil(nthreads).max(1);

    let mut results: Vec<ShelfBookHits> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                let term_lower = &term_lower;
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for b in chunk {
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

    results.sort_by(|a, b| b.count.cmp(&a.count));
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
}
