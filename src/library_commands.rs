use crate::{
    book, epub_runtime, html_sanitize, log, report_save_error, search, search_index,
    window_commands, AppState, RES_BASE,
};
use book::Library;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;
use tauri::{Emitter, Manager};

// ---------------------------------------------------------------------------
//  传给前端的数据结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct BookDto {
    id: String,
    title: String,
    author: String,
    description: String,
    format: String,
    cover: Option<String>, // 封面图 URL（没有则前端画占位封面）
    progress: f32,
    added_at: u64,
    last_read_at: u64,
    missing: bool,   // 源文件是否已找不到
    path: String,    // 文件完整路径（用于"按存储目录"排序）
    rating: f32,     // 用户评分 0~5（0.5 刻度，用于书架按评分过滤）
    initial: String, // 书名拼音首字母（A~Z / #），用于"按书名"分组
}

#[derive(Serialize)]
struct LibraryHealthBook {
    id: String,
    title: String,
    format: String,
    path: String,
}

#[derive(Serialize)]
struct LibraryDuplicateGroup {
    books: Vec<LibraryHealthBook>,
}

#[derive(Serialize)]
pub(crate) struct LibraryHealthReport {
    total: u32,
    healthy: u32,
    missing: Vec<LibraryHealthBook>,
    duplicates: Vec<LibraryDuplicateGroup>,
    search_index: search_index::SearchIndexDiskHealth,
}

#[derive(Serialize)]
struct ProgressTimelinePoint {
    at: u64,
    progress: f32,
    chapter: u32,
    frac: f32,
}

#[derive(Serialize)]
struct ReadingTimelineBucket {
    day: u32,
    hour: u8,
    seconds: u32,
    words: u32,
}

#[derive(Serialize)]
pub(crate) struct BookReadingTimeline {
    title: String,
    events: Vec<ProgressTimelinePoint>,
    buckets: Vec<ReadingTimelineBucket>,
}

/// 一个汉字的拼音首字母（GB2312 编码区间法，覆盖绝大多数常用字）；非常用字/非汉字返回 None。
fn pinyin_initial(c: char) -> Option<char> {
    if c.is_ascii_alphabetic() {
        return Some(c.to_ascii_uppercase());
    }
    if !('\u{4e00}'..='\u{9fff}').contains(&c) {
        return None;
    }
    let mut buf = [0u8; 4];
    let s = c.encode_utf8(&mut buf);
    let (bytes, _, _) = encoding_rs::GBK.encode(s);
    if bytes.len() != 2 {
        return None;
    }
    let code = ((bytes[0] as u16) << 8) | (bytes[1] as u16);
    // 各拼音首字母在 GB2312 里的起始码
    const T: [(u16, char); 23] = [
        (0xB0A1, 'A'),
        (0xB0C5, 'B'),
        (0xB2C1, 'C'),
        (0xB4EE, 'D'),
        (0xB6EA, 'E'),
        (0xB7A2, 'F'),
        (0xB8C1, 'G'),
        (0xB9FE, 'H'),
        (0xBBF7, 'J'),
        (0xBFA6, 'K'),
        (0xC0AC, 'L'),
        (0xC2E8, 'M'),
        (0xC4C3, 'N'),
        (0xC5B6, 'O'),
        (0xC5BE, 'P'),
        (0xC6DA, 'Q'),
        (0xC8BB, 'R'),
        (0xC8F6, 'S'),
        (0xCBFA, 'T'),
        (0xCDDA, 'W'),
        (0xCEF4, 'X'),
        (0xD1B9, 'Y'),
        (0xD4D1, 'Z'),
    ];
    if code < T[0].0 || code > 0xD7F9 {
        return None;
    }
    let mut ans = 'A';
    for (start, ch) in T.iter() {
        if code >= *start {
            ans = *ch;
        } else {
            break;
        }
    }
    Some(ans)
}

fn is_skip_punct(c: char) -> bool {
    matches!(
        c,
        '《' | '》'
            | '「'
            | '」'
            | '『'
            | '』'
            | '【'
            | '】'
            | '('
            | ')'
            | '（'
            | '）'
            | '['
            | ']'
            | '"'
            | '\''
            | '“'
            | '”'
            | '‘'
            | '’'
            | '·'
            | '…'
            | '—'
            | '-'
            | '_'
            | '.'
            | '、'
            | ','
            | '，'
            | '*'
            | '#'
    )
}

/// 书名的分组首字母：跳过前导标点/书名号，取第一个有效字符的拼音首字母；数字/其它符号归 '#'。
fn title_initial(title: &str) -> char {
    for c in title.chars() {
        if c.is_whitespace() || is_skip_punct(c) {
            continue;
        }
        return pinyin_initial(c).unwrap_or('#');
    }
    '#'
}

fn to_dto(b: &book::Book) -> BookDto {
    let id = b.id;
    BookDto {
        id: id.to_string(),
        title: b.title.clone(),
        author: b.author.clone(),
        description: html_sanitize::html_to_plain_text(&b.description),
        format: b.format.clone(),
        // 用封面版本号做缓存破坏参数：换封面后 cover_ver+1 → URL 变化 → 书架刷新新图。
        // 不再每次渲染都去 stat 封面文件（几百本书时那是持锁的几百次系统调用，拖慢封面加载）。
        cover: b
            .cover
            .as_ref()
            .map(|_| format!("{RES_BASE}/cover/{id}?v={}", b.cover_ver)),
        progress: b.progress,
        added_at: b.added_at,
        last_read_at: b.last_read_at,
        // 不在书架首屏为每本书做磁盘 exists() 检查；慢盘/移动盘/同步盘会偶发卡住启动。
        // 真正打开失败时仍会提示用户重新定位。
        missing: false,
        path: b.path.to_string_lossy().into_owned(),
        rating: b.rating,
        initial: title_initial(&b.title).to_string(),
    }
}

pub(crate) fn snapshot(lib: &Library) -> Vec<BookDto> {
    lib.books.iter().map(to_dto).collect()
}

#[tauri::command]
pub(crate) fn list_books(state: tauri::State<AppState>) -> Vec<BookDto> {
    snapshot(&state.library.lock().unwrap())
}

#[tauri::command]
pub(crate) fn maintain_search_index(
    state: tauri::State<AppState>,
) -> search_index::SearchIndexDiskHealth {
    search::maintain_index(state.inner(), true)
}

#[tauri::command]
pub(crate) fn library_health(state: tauri::State<AppState>) -> LibraryHealthReport {
    let search_index = search::index_health(state.inner());
    let lib = state.library.lock().unwrap();
    let compact = |b: &book::Book| LibraryHealthBook {
        id: b.id.to_string(),
        title: b.title.clone(),
        format: b.format.clone(),
        path: b.path.to_string_lossy().into_owned(),
    };
    let missing: Vec<LibraryHealthBook> = lib
        .books
        .iter()
        .filter(|b| !b.path.is_file())
        .map(compact)
        .collect();
    let mut grouped: HashMap<String, Vec<&book::Book>> = HashMap::new();
    for b in &lib.books {
        let key = if !b.content_id.is_empty() {
            format!("content:{}", b.content_id)
        } else if b.fingerprint != 0 {
            format!("fingerprint:{}", b.fingerprint)
        } else {
            continue;
        };
        grouped.entry(key).or_default().push(b);
    }
    let mut duplicates: Vec<LibraryDuplicateGroup> = grouped
        .into_values()
        .filter(|group| group.len() > 1)
        .map(|group| LibraryDuplicateGroup {
            books: group.into_iter().map(compact).collect(),
        })
        .collect();
    duplicates.sort_by(|a, b| a.books[0].title.cmp(&b.books[0].title));
    LibraryHealthReport {
        total: lib.books.len() as u32,
        healthy: lib.books.len().saturating_sub(missing.len()) as u32,
        missing,
        duplicates,
        search_index,
    }
}

#[tauri::command]
pub(crate) fn merge_duplicate_books(
    state: tauri::State<AppState>,
    ids: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    let ids: Vec<u64> = ids
        .into_iter()
        .map(|id| id.parse().map_err(|_| "无效的图书 ID".to_string()))
        .collect::<Result<_, _>>()?;
    let mut lib = state.library.lock().unwrap();
    lib.merge_duplicates(&ids)?;
    lib.save()?;
    Ok(snapshot(&lib))
}

#[tauri::command]
pub(crate) fn book_reading_timeline(
    state: tauri::State<AppState>,
    id: String,
) -> Result<BookReadingTimeline, String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    reading_timeline_for_book(&state, id_num)
}

fn reading_timeline_for_book(state: &AppState, id_num: u64) -> Result<BookReadingTimeline, String> {
    let (title, events) = {
        let lib = state.library.lock().unwrap();
        let book = lib.get(id_num).ok_or("图书不存在")?;
        (
            book.title.clone(),
            book.progress_history
                .iter()
                .map(|event| ProgressTimelinePoint {
                    at: event.at,
                    progress: event.progress,
                    chapter: event.chapter,
                    frac: event.frac,
                })
                .collect(),
        )
    };
    let mut buckets: Vec<ReadingTimelineBucket> = state
        .stats
        .lock()
        .unwrap()
        .map
        .iter()
        .filter_map(|(&(day, hour, book), &(seconds, words))| {
            (book == id_num).then_some(ReadingTimelineBucket {
                day,
                hour,
                seconds,
                words,
            })
        })
        .collect();
    buckets.sort_by_key(|bucket| (bucket.day, bucket.hour));
    Ok(BookReadingTimeline {
        title,
        events,
        buckets,
    })
}

/// 首次加载：回填旧书缺失的作者（重读 EPUB 元数据）和导入时间，然后返回书单。
/// 之后的刷新走 list_books（快，不再重读）。
#[tauri::command]
pub(crate) async fn shelf_books(state: tauri::State<'_, AppState>) -> Result<Vec<BookDto>, ()> {
    if !state
        .backfilled
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        let mut lib = state.library.lock().unwrap();
        let mut changed = false;
        for b in lib.books.iter_mut() {
            let plain_description = html_sanitize::html_to_plain_text(&b.description);
            if plain_description != b.description {
                b.description = plain_description;
                changed = true;
            }
            if b.meta_done {
                continue; // 已回填过的书，永不再重读（解决每次启动卡顿）
            }
            if b.added_at == 0 {
                b.added_at = book::now_secs();
            }
            if b.format == "epub" {
                let path = b.path.clone();
                if let Some(metadata) = epub_runtime::read_book_metadata(&path) {
                    if b.author.trim().is_empty() {
                        if let Some(author) = metadata.author {
                            b.author = author;
                        }
                    }
                    if b.description.trim().is_empty() {
                        if let Some(description) = metadata.description {
                            b.description = description;
                        }
                    }
                }
            }
            b.meta_done = true; // 标记为已处理，下次启动跳过
            changed = true;
        }
        if changed {
            report_save_error("书架", lib.save());
        }
    }
    Ok(snapshot(&state.library.lock().unwrap()))
}

/// 阅读窗口上报阅读位置（进度% + 章节 + 章内比例）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetProgressRequest {
    progress: f32,
    chapter: u32,
    frac: f32,
}

#[tauri::command]
pub(crate) async fn set_progress(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: SetProgressRequest,
) -> Result<(), ()> {
    let SetProgressRequest {
        progress,
        chapter,
        frac,
    } = request;
    if let Some(id) = window_commands::reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        let mut changed = lib.set_position(id, progress, chapter, frac);
        if let Some(book) = lib.books.iter_mut().find(|b| b.id == id) {
            if book.format == "epub" && book.chapter_index_version != epub_runtime::CACHE_VERSION {
                book.chapter_index_version = epub_runtime::CACHE_VERSION;
                changed = true;
            }
        }
        if changed {
            report_save_error("书架", lib.save());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn remove_book(state: tauri::State<AppState>, id: String) -> Vec<BookDto> {
    if let Ok(id_num) = id.parse::<u64>() {
        let mut lib = state.library.lock().unwrap();
        lib.remove(id_num);
        report_save_error("书架", lib.save());
    }
    snapshot(&state.library.lock().unwrap())
}

/// 用用户挑选的图片更换某本书的封面。
#[tauri::command]
pub(crate) fn set_cover(
    state: tauri::State<AppState>,
    id: String,
    path: String,
) -> Result<Vec<BookDto>, String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    let cover = book::make_cover_from_image(std::path::Path::new(&path), id_num)
        .ok_or_else(|| "无法处理这张图片（支持 png/jpg/webp 等）".to_string())?;
    let mut lib = state.library.lock().unwrap();
    if let Some(b) = lib.books.iter_mut().find(|b| b.id == id_num) {
        b.cover = Some(cover);
        b.cover_ver += 1; // 换图后让前端缓存失效，立即显示新封面
    }
    report_save_error("书架", lib.save());
    Ok(snapshot(&lib))
}

/// 批量删除选中的书。
#[tauri::command]
pub(crate) fn remove_books(state: tauri::State<AppState>, ids: Vec<String>) -> Vec<BookDto> {
    {
        let mut lib = state.library.lock().unwrap();
        for id in ids {
            if let Ok(n) = id.parse::<u64>() {
                lib.remove(n);
            }
        }
        report_save_error("书架", lib.save());
    }
    snapshot(&state.library.lock().unwrap())
}

/// 在独立窗口里打开一本书（已打开则聚焦）。
/// 必须是 async：同步命令在主线程执行，而创建窗口也需要主线程事件循环，
/// 会造成“主线程等自己”的死锁。async 让命令在工作线程发起，主线程去建窗口。
#[tauri::command]
pub(crate) async fn open_book(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let started = Instant::now();
    log(&format!("open_book id={id}"));
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    // 源文件丢失则不开空窗，直接给出可读的提示
    {
        let lib = state.library.lock().unwrap();
        if let Some(b) = lib.get(id_num) {
            if !b.path.exists() {
                return Err("源文件已丢失，请在书架上对这本书「重新定位」。".to_string());
            }
        }
    }
    let result = window_commands::ensure_reader_window(&app, state.inner(), id_num).map(|_| ());
    log(&format!(
        "open_book complete id={id_num} ok={} elapsed_ms={}",
        result.is_ok(),
        started.elapsed().as_millis()
    ));
    result
}

/// 书架全文检索点击结果：打开（或聚焦）这本书，并跳到命中所在章节、高亮搜索词。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenBookAtRequest {
    id: String,
    chapter: u32,
    term: String,
}

#[tauri::command]
pub(crate) async fn open_book_at(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: OpenBookAtRequest,
) -> Result<(), String> {
    let OpenBookAtRequest { id, chapter, term } = request;
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    let chapter = {
        let format = state
            .library
            .lock()
            .unwrap()
            .get(id_num)
            .map(|b| b.format.clone())
            .unwrap_or_default();
        if format == "epub" {
            epub_runtime::map_physical_chapter_for_book(&state, id_num, chapter).unwrap_or(chapter)
        } else {
            chapter
        }
    };
    let label = format!("reader-{id_num}");
    let existed = app.get_webview_window(&label).is_some();
    if !existed {
        // 新开的窗口：页面就绪后会主动 take_pending_jump 取走
        state
            .pending_jump
            .lock()
            .unwrap()
            .insert(id_num, (chapter, term.clone()));
    }
    let w = window_commands::ensure_reader_window(&app, state.inner(), id_num)?;
    // 已开着的窗口：直接事件通知它跳转
    let _ = w.emit("shelf-jump", JumpPayload { chapter, term });
    Ok(())
}

/// 阅读窗口加载后取走（并清除）待跳转位置。
#[tauri::command]
pub(crate) fn take_pending_jump(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Option<JumpPayload> {
    let id = window_commands::reader_window_id(&window)?;
    state
        .pending_jump
        .lock()
        .unwrap()
        .remove(&id)
        .map(|(chapter, term)| JumpPayload { chapter, term })
}

/// 跳转/检索用的载荷类型。
#[derive(Clone, Serialize)]
pub(crate) struct JumpPayload {
    chapter: u32,
    term: String,
}

/// 文件丢失后把某本书重新指向新路径，返回更新后的书单。
#[tauri::command]
pub(crate) fn relocate_book(
    state: tauri::State<AppState>,
    id: String,
    path: String,
) -> Vec<BookDto> {
    if let Ok(id_num) = id.parse::<u64>() {
        let mut lib = state.library.lock().unwrap();
        if lib.relocate(id_num, std::path::PathBuf::from(path)) {
            report_save_error("书架", lib.save());
        }
    }
    snapshot(&state.library.lock().unwrap())
}

/// 后台为旧书补算内容指纹（让"移动后重新导入即识别为同一本书"对存量书也生效）。
pub(crate) fn spawn_fingerprint_fill(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let pending: Vec<(u64, std::path::PathBuf, bool, bool)> = {
            let lib = state.library.lock().unwrap();
            lib.books
                .iter()
                .filter(|b| b.fingerprint == 0 || b.content_id.is_empty())
                .map(|b| {
                    (
                        b.id,
                        b.path.clone(),
                        b.fingerprint == 0,
                        b.content_id.is_empty(),
                    )
                })
                .collect()
        };
        let mut changed = false;
        for (id, path, need_fingerprint, need_content_id) in pending {
            if need_fingerprint {
                let fp = book::compute_fingerprint(&path);
                if fp != 0 {
                    state.library.lock().unwrap().set_fingerprint(id, fp);
                    changed = true;
                }
            }
            if need_content_id {
                let content_id = book::compute_content_id(&path);
                if !content_id.is_empty() {
                    state.library.lock().unwrap().set_content_id(id, content_id);
                    changed = true;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if changed {
            report_save_error("书架", state.library.lock().unwrap().save());
        }
    });
}

/// 既不占主线程、也不占 tokio 命令线程池，每本之间略作停顿，绝不卡界面。
#[tauri::command]
pub(crate) fn compute_word_counts(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let pending: Vec<(u64, book::Book)> = {
            let lib = state.library.lock().unwrap();
            lib.books
                .iter()
                .filter(|b| b.word_count == 0)
                .map(|b| (b.id, b.clone()))
                .collect()
        };
        let mut changed = false;
        for (id, b) in pending {
            while window_commands::any_reader_window_open(&app) {
                std::thread::sleep(std::time::Duration::from_secs(10));
            }
            let wc = book::compute_word_count(&b); // 不持锁
            if wc > 0 {
                state.library.lock().unwrap().set_word_count(id, wc);
                changed = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25)); // 温和，别抢资源
        }
        if changed {
            report_save_error("书架", state.library.lock().unwrap().save());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_initial_skips_book_punctuation_and_handles_ascii() {
        assert_eq!(title_initial("  《hello》"), 'H');
        assert_eq!(title_initial("【中文】"), 'Z');
        assert_eq!(title_initial("123"), '#');
        assert_eq!(title_initial("---"), '#');
    }

    #[test]
    fn navigation_requests_deserialize_as_one_object() {
        let progress: SetProgressRequest = serde_json::from_value(serde_json::json!({
            "progress": 42.5,
            "chapter": 6,
            "frac": 0.25
        }))
        .unwrap();
        assert_eq!(progress.chapter, 6);
        assert_eq!(progress.frac, 0.25);

        let jump: OpenBookAtRequest = serde_json::from_value(serde_json::json!({
            "id": "123",
            "chapter": 7,
            "term": "检索词"
        }))
        .unwrap();
        assert_eq!(jump.id, "123");
        assert_eq!(jump.term, "检索词");
    }
}
