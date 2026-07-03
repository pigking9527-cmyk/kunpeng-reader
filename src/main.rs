// 防止 Windows release 构建弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod book;
mod data_migration;
mod db;
mod dict;
mod epub_toc;
mod html_sanitize;
mod import;
mod import_core;
mod pdf_support;
mod reader_protocol;
mod reader_page;
mod reader_commands;
mod search;
mod search_core;
mod secret_store;
mod semantic;
mod semantic_core;
mod stats;
mod stats_core;
mod sync;
mod sync_core;
mod text_chapters;
mod tts;
mod tts_core;
mod update;
mod url_open;
mod vocab;
mod window_commands;

#[cfg(test)]
mod smoke_tests;

use book::{Library, WinGeom};
use epub_toc::{epub3_nav_toc, flatten_toc, TocDto};
use html_sanitize::sanitize_mobi_html;
use reader_protocol::{
    collect_head_assets, extract_body_inner, get_txt_chapters, guess_mime, is_md, is_mobi,
    md_to_html, percent_decode, rewrite_attrs, rewrite_css_url, txt_body, txt_html,
};
use serde::Serialize;
use stats::StatsStore;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// 自定义协议的基地址（Windows 下 WebView2 把自定义协议映射到 http://<scheme>.localhost）
pub(crate) const RES_BASE: &str = "http://reader.localhost";
pub(crate) const DEFAULT_SYNC_URL: &str = "https://sync.example.invalid";

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

/// 调试日志：写到 %LOCALAPPDATA%\ebook-reader\debug.log（windows 子系统下没有 stderr）。
fn log(msg: &str) {
    if let Some(mut dir) = dirs::cache_dir() {
        dir.push("ebook-reader");
        let _ = std::fs::create_dir_all(&dir);
        dir.push("debug.log");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dir)
        {
            let _ = writeln!(f, "{msg}");
        }
    }
}

#[derive(Serialize, Clone)]
struct StartupPerfEvent {
    name: String,
    phase: String,
    detail: String,
}

fn emit_startup_perf(app: &tauri::AppHandle, name: &str, phase: &str, detail: impl Into<String>) {
    let detail = detail.into();
    log(&format!("[startup] {name} {phase} {detail}"));
    let _ = app.emit(
        "startup-perf",
        StartupPerfEvent {
            name: name.to_string(),
            phase: phase.to_string(),
            detail,
        },
    );
}
fn any_reader_window_open(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| label.starts_with("reader-"))
}

#[tauri::command]
fn reader_window_open(app: tauri::AppHandle) -> bool {
    any_reader_window_open(&app)
}

/// 全局状态：书架 + 已打开的 EPUB 缓存（避免每个资源请求都重新解压）。
pub(crate) struct AppState {
    pub(crate) library: Mutex<Library>,
    pub(crate) db: Mutex<Option<db::AppDb>>,
    epubs: Mutex<HashMap<u64, EpubDoc>>,
    backfilled: std::sync::atomic::AtomicBool, // 是否已回填旧书的作者/导入时间
    pending_jump: Mutex<HashMap<u64, (u32, String)>>, // 书架检索点击 → 阅读窗口待跳转位置
    pub(crate) text_cache: Mutex<HashMap<u64, (u64, Arc<Vec<String>>)>>, // 检索用：内存缓存的逐章纯文本 (mtime, 章节)
    pub(crate) lower_text_cache: Mutex<HashMap<u64, (u64, Arc<Vec<Vec<u8>>>)>>, // 英文检索用：ASCII 小写后的章节字节
    pub(crate) txt_chapters: Mutex<HashMap<u64, Arc<Vec<(String, String)>>>>, // txt 阅读用：切分好的章节 (标题, 正文)
    pub(crate) cache_bytes: AtomicUsize, // 已缓存的总字节数（限额用）
    pub(crate) embedder: Mutex<Option<Arc<fastembed::TextEmbedding>>>, // 语义模型（懒加载，首次会下载）
    pub(crate) sem_cache: Mutex<HashMap<u64, Arc<semantic::SemData>>>, // 语义检索：内存缓存的向量
    pub(crate) sem_cache_bytes: AtomicUsize,
    pub(crate) sem_progress: Mutex<semantic::SemProgress>, // 建立语义索引的进度
    pub(crate) global_index: Mutex<Option<Arc<semantic::LoadedShards>>>, // 全库近邻索引：已载入内存的分片集合
    pub(crate) index_resume_at: AtomicU64, // 语义索引“让路”截止时刻(ms,0=不暂停)：打开阅读窗口时临时暂停建索引，让窗口秒开
    pub(crate) stats: Mutex<StatsStore>,   // 详细阅读统计的小时桶
    pub(crate) vocab: Mutex<vocab::VocabStore>, // 生词本：查过的词
    word_pack: Mutex<tts::WordPackState>,  // 高频词语音包后台生成状态
}

/// 当前时刻（毫秒）。用于语义索引的“让路”节流。
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把当前线程降到“后台优先级”，让前台（阅读/书架窗口）优先拿到 CPU。仅 Windows，尽力而为。
#[cfg(windows)]
pub(crate) fn set_thread_background(on: bool) {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> isize;
        fn SetThreadPriority(h: isize, p: i32) -> i32;
    }
    // THREAD_MODE_BACKGROUND_BEGIN=0x00010000 / END=0x00020000：同时降低 CPU 与 I/O 优先级
    let p: i32 = if on { 0x0001_0000 } else { 0x0002_0000 };
    unsafe {
        SetThreadPriority(GetCurrentThread(), p);
    }
}
#[cfg(not(windows))]
pub(crate) fn set_thread_background(_on: bool) {}

/// 内存缓存上限：超过后不再缓存新书（避免超大书库吃光内存）。

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

#[derive(Serialize)]
struct BookInfo {
    id: String,
    title: String,
    format: String,
    url: String,        // 要加载的页面（EPUB=整本合并页，txt=文本页）
    chapter_count: u32, // 章节数（供上一章/下一章用，锚点为 chap-0..chap-(n-1)）
    toc: Vec<TocDto>,
    progress: f32,
    resume_chapter: u32, // 续读：章节
    resume_frac: f32,    // 续读：章内比例
    bookmarks: Vec<book::Bookmark>,
    highlights: Vec<book::Highlight>,
}

fn to_dto(b: &book::Book) -> BookDto {
    let id = b.id;
    BookDto {
        id: id.to_string(),
        title: b.title.clone(),
        author: b.author.clone(),
        description: b.description.clone(),
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

// ---------------------------------------------------------------------------
//  命令
// ---------------------------------------------------------------------------

pub(crate) fn snapshot(lib: &Library) -> Vec<BookDto> {
    lib.books.iter().map(to_dto).collect()
}

#[tauri::command]
fn list_books(state: tauri::State<AppState>) -> Vec<BookDto> {
    snapshot(&state.library.lock().unwrap())
}

/// 当前 app 版本号（取自 Cargo.toml，供"检查更新"和"关于"使用，单一来源）。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 离线词典查词（按中/英自动选库）。
#[tauri::command]
fn dict_lookup(term: String) -> dict::DictResult {
    dict::lookup(&term)
}

#[tauri::command]
fn migrate_data_to_sqlite(state: tauri::State<AppState>) -> Result<(), String> {
    data_migration::migrate_json_to_sqlite(state.inner());
    Ok(())
}

#[tauri::command]
fn export_data_package(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    data_migration::migrate_json_to_sqlite(state.inner());
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    let package = db.export_package()?;
    let text = serde_json::to_string_pretty(&package).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_data_package(state: tauri::State<AppState>, path: String) -> Result<u32, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    db.import_package(&value)
}

/// 首次加载：回填旧书缺失的作者（重读 EPUB 元数据）和导入时间，然后返回书单。
/// 之后的刷新走 list_books（快，不再重读）。
#[tauri::command]
async fn shelf_books(state: tauri::State<'_, AppState>) -> Result<Vec<BookDto>, ()> {
    if !state
        .backfilled
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        let mut lib = state.library.lock().unwrap();
        let mut changed = false;
        for b in lib.books.iter_mut() {
            if b.meta_done {
                continue; // 已回填过的书，永不再重读（解决每次启动卡顿）
            }
            if b.added_at == 0 {
                b.added_at = book::now_secs();
            }
            if b.format == "epub" {
                let path = b.path.clone();
                if let Ok(doc) = EpubDoc::new(&path) {
                    if b.author.trim().is_empty() {
                        if let Some(m) = doc.mdata("creator") {
                            b.author = m.value.clone();
                        }
                    }
                    if b.description.trim().is_empty() {
                        if let Some(m) = doc.mdata("description") {
                            b.description = m.value.clone();
                        }
                    }
                }
            }
            b.meta_done = true; // 标记为已处理，下次启动跳过
            changed = true;
        }
        if changed {
            lib.save();
        }
    }
    Ok(snapshot(&state.library.lock().unwrap()))
}

/// 阅读窗口上报阅读位置（进度% + 章节 + 章内比例）。
#[tauri::command]
async fn set_progress(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    progress: f32,
    chapter: u32,
    frac: f32,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        if lib.set_position(id, progress, chapter, frac) {
            lib.save();
        }
    }
    Ok(())
}

#[tauri::command]
fn remove_book(state: tauri::State<AppState>, id: String) -> Vec<BookDto> {
    if let Ok(id_num) = id.parse::<u64>() {
        let mut lib = state.library.lock().unwrap();
        lib.remove(id_num);
        lib.save();
    }
    snapshot(&state.library.lock().unwrap())
}

/// 用用户挑选的图片更换某本书的封面。
#[tauri::command]
fn set_cover(
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
    lib.save();
    Ok(snapshot(&lib))
}

/// 批量删除选中的书。
#[tauri::command]
fn remove_books(state: tauri::State<AppState>, ids: Vec<String>) -> Vec<BookDto> {
    {
        let mut lib = state.library.lock().unwrap();
        for id in ids {
            if let Ok(n) = id.parse::<u64>() {
                lib.remove(n);
            }
        }
        lib.save();
    }
    snapshot(&state.library.lock().unwrap())
}

/// 在独立窗口里打开一本书（已打开则聚焦）。
/// 必须是 async：同步命令在主线程执行，而创建窗口也需要主线程事件循环，
/// 会造成“主线程等自己”的死锁。async 让命令在工作线程发起，主线程去建窗口。
#[tauri::command]
async fn open_book(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
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
    ensure_reader_window(&app, state.inner(), id_num).map(|_| ())
}

/// 书架全文检索点击结果：打开（或聚焦）这本书，并跳到命中所在章节、高亮搜索词。
#[tauri::command]
async fn open_book_at(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    chapter: u32,
    term: String,
) -> Result<(), String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
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
    let w = ensure_reader_window(&app, state.inner(), id_num)?;
    // 已开着的窗口：直接事件通知它跳转
    let _ = w.emit("shelf-jump", JumpPayload { chapter, term });
    Ok(())
}

/// 阅读窗口加载后取走（并清除）待跳转位置。
#[tauri::command]
fn take_pending_jump(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Option<JumpPayload> {
    let id = reader_window_id(&window)?;
    state
        .pending_jump
        .lock()
        .unwrap()
        .remove(&id)
        .map(|(chapter, term)| JumpPayload { chapter, term })
}

/// 创建/聚焦某本书的阅读窗口，恢复上次几何位置；返回该窗口。
fn ensure_reader_window(
    app: &tauri::AppHandle,
    state: &AppState,
    id_num: u64,
) -> Result<tauri::WebviewWindow, String> {
    let label = format!("reader-{id_num}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(w);
    }
    // 禁止多开：打开新书前，关掉其它已打开的阅读窗口（始终只保留一个阅读窗口）
    for (lbl, win) in app.webview_windows() {
        if lbl.starts_with("reader-") && lbl != label {
            let _ = win.close();
        }
    }

    // 新开窗口期间，暂停语义索引几秒，把 CPU 让给 WebView2 冷启动 → 窗口秒开
    state
        .index_resume_at
        .store(now_ms() + 6000, Ordering::Relaxed);

    // 只读一下书名（快），先把窗口建出来，优先让页面打开
    let title = {
        let lib = state.library.lock().unwrap();
        lib.get(id_num)
            .map(|b| b.title.clone())
            .unwrap_or_else(|| "阅读".to_string())
    };

    // 读取上次阅读窗口的大小/位置，本次按它恢复（EPUB 与 PDF 分开记，各自适应）
    let is_pdf = {
        state
            .library
            .lock()
            .unwrap()
            .get(id_num)
            .map(|b| b.format == "pdf")
            .unwrap_or(false)
    };
    let geom = {
        let lib = state.library.lock().unwrap();
        if is_pdf {
            lib.reader_geom_pdf.clone()
        } else {
            lib.reader_geom.clone()
        }
    };
    // 用主窗口的显示器信息判断保存的位置是否还在屏幕内（防止阅读窗口跑到屏幕外）
    let on_screen = geom
        .as_ref()
        .map(|g| {
            app.get_webview_window("main")
                .map(|mw| position_on_screen(&mw, g))
                .unwrap_or(true)
        })
        .unwrap_or(false);

    let mut builder =
        tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::App("reader.html".into()),
        )
            .title(title)
            .decorations(false)
            .min_inner_size(420.0, 320.0);
    match &geom {
        Some(g) if g.w >= 300.0 && g.h >= 300.0 => {
            builder = builder.inner_size(g.w, g.h);
            if on_screen {
                builder = builder.position(g.x, g.y);
            }
        }
        _ => {
            builder = builder.inner_size(880.0, 760.0);
        }
    }
    let r = builder.build();
    log(&format!("open_book built ok={}", r.is_ok()));
    let w = r.map_err(|e| e.to_string())?;
    if !on_screen {
        let _ = w.center(); // 上次坐标已不在任何屏幕内 → 回到屏幕中央
    }
    if geom.as_ref().map(|g| g.maximized).unwrap_or(false) {
        let _ = w.maximize();
    }

    // 只在关闭阅读窗口时保存几何信息。
    // Moved/Resized 在拖窗期间会高频触发；每次都跨 Rust 取位置并锁书库，会让阅读页拖动周期性卡顿。
    let app_ev = app.clone();
    let label_ev = label.clone();
    w.on_window_event(move |ev| match ev {
        tauri::WindowEvent::CloseRequested { .. } => {
            if let Some(win) = app_ev.get_webview_window(&label_ev) {
                let st = app_ev.state::<AppState>();
                let mut lib = st.library.lock().unwrap();
                update_reader_geom(&mut lib, &win);
                lib.save();
                st.stats.lock().unwrap().save();
            }
        }
        _ => {}
    });

    // 窗口建好后再记录“最近阅读”并写盘（不拖慢打开）
    {
        let mut lib = state.library.lock().unwrap();
        lib.mark_read(id_num);
        lib.save();
    }
    Ok(w)
}

/// 根据窗口当前状态算出几何信息（逻辑像素）。最大化时只更新 maximized 标志，
/// 保留之前的还原尺寸/位置，避免把全屏尺寸当成正常大小。
fn capture_geom(prev: Option<WinGeom>, win: &tauri::WebviewWindow) -> WinGeom {
    let mut g = prev.unwrap_or_default();
    // 最小化时 Windows 把窗口坐标报成 -32000 之类的哨兵值，绝不能采集，否则下次打开会跑到屏幕外
    if win.is_minimized().unwrap_or(false) {
        return g;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let maximized = win.is_maximized().unwrap_or(false);
    g.maximized = maximized;
    if !maximized {
        if let Ok(size) = win.inner_size() {
            let s = size.to_logical::<f64>(scale);
            if s.width > 100.0 && s.height > 100.0 {
                g.w = s.width;
                g.h = s.height;
            }
        }
        if let Ok(pos) = win.outer_position() {
            let p = pos.to_logical::<f64>(scale);
            // 再保险一层：明显越界的坐标不采集
            if p.x > -10000.0 && p.y > -10000.0 {
                g.x = p.x;
                g.y = p.y;
            }
        }
    }
    g
}

/// 主显示器的逻辑尺寸（宽,高）。
fn primary_logical_size(win: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let m = win.primary_monitor().ok().flatten().or_else(|| {
        win.available_monitors()
            .ok()
            .and_then(|v| v.into_iter().next())
    })?;
    let scale = m.scale_factor();
    let ms = m.size();
    Some((ms.width as f64 / scale, ms.height as f64 / scale))
}

/// 在主显示器上居中放置一个 w×h 窗口时的左上角逻辑坐标。
fn centered_position(win: &tauri::WebviewWindow, w: f64, h: f64) -> Option<(f64, f64)> {
    let m = win.primary_monitor().ok().flatten().or_else(|| {
        win.available_monitors()
            .ok()
            .and_then(|v| v.into_iter().next())
    })?;
    let scale = m.scale_factor();
    let mp = m.position();
    let ms = m.size();
    let (mx, my) = (mp.x as f64 / scale, mp.y as f64 / scale);
    let (mw, mh) = (ms.width as f64 / scale, ms.height as f64 / scale);
    Some((mx + (mw - w).max(0.0) / 2.0, my + (mh - h).max(0.0) / 2.0))
}

/// 把当前阅读窗口的大小/位置写入内存中的书库（不立即落盘，关闭时再统一保存）。
/// EPUB 与 PDF 各存各的，互不影响。
fn update_reader_geom(lib: &mut Library, win: &tauri::WebviewWindow) {
    let is_pdf = reader_window_id(win)
        .and_then(|id| lib.get(id).map(|b| b.format == "pdf"))
        .unwrap_or(false);
    if is_pdf {
        lib.reader_geom_pdf = Some(capture_geom(lib.reader_geom_pdf.clone(), win));
    } else {
        lib.reader_geom = Some(capture_geom(lib.reader_geom.clone(), win));
    }
}

/// 判断保存的几何位置是否还落在某个显示器内（避免窗口跑到屏幕外、只剩任务栏图标）。
/// 任一显示器与窗口矩形有足够重叠即认为可见。
fn position_on_screen(win: &tauri::WebviewWindow, g: &WinGeom) -> bool {
    let monitors = match win.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return false,
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let (wx, wy, ww, wh) = (g.x * scale, g.y * scale, g.w * scale, g.h * scale);
    for m in &monitors {
        let mp = m.position();
        let ms = m.size();
        let (mx, my, mw, mh) = (mp.x as f64, mp.y as f64, ms.width as f64, ms.height as f64);
        let ox = (wx + ww).min(mx + mw) - wx.max(mx); // 水平重叠
        let oy = (wy + wh).min(my + mh) - wy.max(my); // 垂直重叠
        if ox > 100.0 && oy > 60.0 {
            return true;
        }
    }
    false
}

/// 安全地把保存的几何信息应用到窗口：尺寸超屏会收缩，位置越界则真正居中（不依赖 center()）。
fn apply_geom_safe(win: &tauri::WebviewWindow, geom: &Option<WinGeom>) {
    let _ = win.unminimize();
    if let Some(g) = geom {
        // 目标尺寸，超过主屏幕则收缩，避免窗口比屏幕还大
        let (mut w, mut h) = (g.w, g.h);
        if let Some((mw, mh)) = primary_logical_size(win) {
            if w > mw {
                w = (mw - 40.0).max(300.0);
            }
            if h > mh {
                h = (mh - 60.0).max(300.0);
            }
        }
        if w >= 300.0 && h >= 300.0 {
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
            if position_on_screen(win, g) {
                let _ = win.set_position(tauri::LogicalPosition::new(g.x, g.y));
            } else if let Some((cx, cy)) = centered_position(win, w, h) {
                let _ = win.set_position(tauri::LogicalPosition::new(cx, cy));
            }
        }
        if g.maximized {
            let _ = win.maximize();
        }
    }
    // 确保可见、未最小化、并取得焦点
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

/// 返回一本书的阅读信息：章节列表（spine 顺序）+ 目录。
/// 图书 ID 直接从调用窗口的 label（"reader-<id>"）推导，前端无需传参。
/// async：解析 EPUB（spine/toc）较慢，必须在主线程之外，否则卡死 UI。
#[tauri::command]
async fn book_info(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<BookInfo, String> {
    let label = window.label().to_string();
    log(&format!("book_info label={label}"));
    let id = label
        .strip_prefix("reader-")
        .ok_or("当前窗口不是阅读窗口")?
        .to_string();
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;

    let (title, format, progress, resume_chapter, resume_frac, bookmarks, highlights, path) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id_num).ok_or("找不到这本书")?;
        (
            b.title.clone(),
            b.format.clone(),
            b.progress,
            b.resume_chapter,
            b.resume_frac,
            b.bookmarks.clone(),
            b.highlights.clone(),
            b.path.clone(),
        )
    };

    if !path.exists() {
        return Err("源文件已丢失。请回到书架，对这本书「重新定位」到文件的新位置。".to_string());
    }

    if format != "epub" {
        // pdf 用 WebView2 自带阅读器；txt/md 走与 EPUB 相同的合并阅读页（整本当作单章），
        // 这样才有翻页/设置/进度/书签，且会上报 {ready} 隐藏加载圈
        let url = if format == "pdf" {
            format!("{RES_BASE}/pdf/{id_num}")
        } else {
            format!("{RES_BASE}/book/{id_num}")
        };
        // txt/md：用切分好的章节做目录与章数（网文按"第X章"切，否则按节切）
        let (chapter_count, toc) = if format == "pdf" {
            (1u32, Vec::new())
        } else {
            let chs =
                get_txt_chapters(state.inner(), id_num).unwrap_or_else(|| Arc::new(Vec::new()));
            let toc: Vec<TocDto> = chs
                .iter()
                .enumerate()
                .map(|(i, (label, _))| TocDto {
                    label: label.clone(),
                    chapter: i as u32,
                    frag: String::new(),
                    level: 0,
                })
                .collect();
            (chs.len().max(1) as u32, toc)
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

    ensure_epub_loaded(&state, id_num)?;
    let mut epubs = state.epubs.lock().unwrap();
    let doc = epubs.get_mut(&id_num).ok_or("无法打开 EPUB")?;

    // spine 各章节的归档路径 -> 序号，用于把目录/链接映射成页面内锚点
    let spine_paths: Vec<String> = doc
        .spine
        .iter()
        .filter_map(|s| doc.resources.get(&s.idref))
        .map(|r| r.path.to_string_lossy().replace('\\', "/"))
        .collect();
    let chapter_map: HashMap<String, usize> = spine_paths
        .iter()
        .enumerate()
        .map(|(i, p)| (p.clone(), i))
        .collect();

    let mut toc = Vec::new();
    flatten_toc(&doc.toc, 0, &chapter_map, &mut toc);
    if toc.is_empty() {
        toc = epub3_nav_toc(doc, &chapter_map);
    }

    log(&format!(
        "book_info -> {} chapters, {} toc",
        spine_paths.len(),
        toc.len()
    ));
    Ok(BookInfo {
        id: id_num.to_string(),
        title,
        format,
        url: format!("{RES_BASE}/book/{id_num}"),
        chapter_count: spine_paths.len() as u32,
        toc,
        progress,
        resume_chapter,
        resume_frac,
        bookmarks,
        highlights,
    })
}

/// 从阅读窗口 label 取图书 id。
pub(crate) fn reader_window_id(window: &tauri::WebviewWindow) -> Option<u64> {
    window
        .label()
        .strip_prefix("reader-")
        .and_then(|s| s.parse().ok())
}

/// 去掉 HTML 标签，得到纯文本（合并连续空白）。
pub(crate) fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut last_ws = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        if ch.is_whitespace() {
            if !last_ws {
                out.push(' ');
                last_ws = true;
            }
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    out
}

/// 跳转/检索用的载荷类型。
#[derive(Clone, Serialize)]
struct JumpPayload {
    chapter: u32,
    term: String,
}

/// 文件丢失后把某本书重新指向新路径，返回更新后的书单。
#[tauri::command]
fn relocate_book(state: tauri::State<AppState>, id: String, path: String) -> Vec<BookDto> {
    if let Ok(id_num) = id.parse::<u64>() {
        let mut lib = state.library.lock().unwrap();
        if lib.relocate(id_num, std::path::PathBuf::from(path)) {
            lib.save();
        }
    }
    snapshot(&state.library.lock().unwrap())
}

/// 后台为旧书补算内容指纹（让"移动后重新导入即识别为同一本书"对存量书也生效）。
fn spawn_fingerprint_fill(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let pending: Vec<(u64, std::path::PathBuf)> = {
            let lib = state.library.lock().unwrap();
            lib.books
                .iter()
                .filter(|b| b.fingerprint == 0)
                .map(|b| (b.id, b.path.clone()))
                .collect()
        };
        let mut changed = false;
        for (id, path) in pending {
            let fp = book::compute_fingerprint(&path);
            if fp != 0 {
                state.library.lock().unwrap().set_fingerprint(id, fp);
                changed = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if changed {
            state.library.lock().unwrap().save();
        }
    });
}

#[derive(Serialize)]
struct SearchHit {
    chapter: u32,
    snippet: String,
}

/// 全书搜索：逐章读取纯文本，返回包含搜索词的上下文片段 + 章节序号。
#[tauri::command]
async fn search_book(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    term: String,
) -> Result<Vec<SearchHit>, ()> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let Some(id) = reader_window_id(&window) else {
        return Ok(Vec::new());
    };
    if ensure_epub_loaded(&state, id).is_err() {
        return Ok(Vec::new());
    }
    let mut epubs = state.epubs.lock().unwrap();
    let Some(doc) = epubs.get_mut(&id) else {
        return Ok(Vec::new());
    };
    let spine: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
    let tq: Vec<char> = term.chars().map(|c| c.to_ascii_lowercase()).collect();
    let m = tq.len();
    let mut hits: Vec<SearchHit> = Vec::new();

    for (ci, idref) in spine.iter().enumerate() {
        let Some((html, _)) = doc.get_resource_str(idref) else {
            continue;
        };
        let text = strip_tags(&html);
        let tchars: Vec<char> = text.chars().collect();
        let lchars: Vec<char> = tchars.iter().map(|c| c.to_ascii_lowercase()).collect();
        let n = lchars.len();
        let mut i = 0;
        while i + m <= n {
            if lchars[i..i + m] == tq[..] {
                let s = i.saturating_sub(30);
                let e = (i + m + 30).min(n);
                let snippet: String = tchars[s..e].iter().collect();
                hits.push(SearchHit {
                    chapter: ci as u32,
                    snippet: snippet.trim().to_string(),
                });
                i += m;
                if hits.len() >= 300 {
                    return Ok(hits);
                }
            } else {
                i += 1;
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    url_open::open_https_url(&url)
}

/// 既不占主线程、也不占 tokio 命令线程池，每本之间略作停顿，绝不卡界面。
#[tauri::command]
fn compute_word_counts(app: tauri::AppHandle) {
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
            while any_reader_window_open(&app) {
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
            state.library.lock().unwrap().save();
        }
    });
}

// ---------------------------------------------------------------------------
//  自定义协议 reader:// —— 把图书资源喂给 WebView
//    /res/<id>/<resPath>  EPUB 内部资源（章节 xhtml、图片、css、字体…）
//    /txt/<id>            txt/md 生成的阅读页
//    /cover/<id>          封面缩略图
// ---------------------------------------------------------------------------

fn ensure_epub_loaded(state: &AppState, id: u64) -> Result<(), String> {
    {
        let epubs = state.epubs.lock().unwrap();
        if epubs.contains_key(&id) {
            return Ok(());
        }
    }
    let path = {
        let lib = state.library.lock().unwrap();
        lib.get(id).ok_or("找不到这本书")?.path.clone()
    };
    // Opening/parsing an EPUB touches disk and can be slow. Keep that work outside
    // the global EPUB cache lock so concurrent cover/resource requests are not blocked.
    let doc = EpubDoc::new(&path).map_err(|_| "无法打开 EPUB 文件".to_string())?;
    let mut epubs = state.epubs.lock().unwrap();
    if epubs.contains_key(&id) {
        return Ok(());
    }
    epubs.insert(id, doc);
    Ok(())
}

fn handle_request(state: &AppState, path: &str) -> Option<(Vec<u8>, String)> {
    let decoded = percent_decode(path);
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next()?;
    let id: u64 = parts.next()?.parse().ok()?;
    let rest = parts.next().unwrap_or("");

    match kind {
        "cover" => {
            // 取到封面路径后立刻放锁，再读盘——否则每个封面请求都会在读 167KB 图片
            // 时一直占着书架全局锁，几百张封面并发时会全部挤在一把锁上、严重变慢。
            let cover = {
                let lib = state.library.lock().unwrap();
                lib.get(id)?.cover.clone()?
            };
            let bytes = std::fs::read(cover).ok()?;
            Some((bytes, "image/png".to_string()))
        }
        "txt" => {
            let path = {
                let lib = state.library.lock().unwrap();
                lib.get(id)?.path.clone()
            };
            let bytes = std::fs::read(&path).ok()?;
            let text = book::normalize_text(&book::decode_bytes(&bytes));
            Some((txt_html(&text).into_bytes(), "text/html".to_string()))
        }
        "res" => {
            ensure_epub_loaded(state, id).ok()?;
            let mut epubs = state.epubs.lock().unwrap();
            let doc = epubs.get_mut(&id)?;
            let p = std::path::PathBuf::from(rest);
            let bytes = doc.get_resource_by_path(&p)?;
            let mime = doc
                .get_resource_mime_by_path(&p)
                .unwrap_or_else(|| guess_mime(rest));
            Some((bytes, mime))
        }
        "book" => {
            // 返回一个空壳页面（含分页+渐进加载脚本）；正文由前端逐章 fetch 追加
            let format = {
                state
                    .library
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|b| b.format.clone())
                    .unwrap_or_default()
            };
            let count = if format == "epub" {
                ensure_epub_loaded(state, id).ok()?;
                let mut epubs = state.epubs.lock().unwrap();
                epubs.get_mut(&id).map(|d| d.spine.len()).unwrap_or(0)
            } else {
                get_txt_chapters(state, id).map(|c| c.len()).unwrap_or(1) // txt/md：切分后的章数
            };
            let shell = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
<script>window.__ID__='{id}';window.__CH__={count};</script>{head}</head>\
<body><div id=\"pager\"><div id=\"reader-root\" class=\"rr\"></div></div><div id=\"measurer\" class=\"rr\"></div></body></html>",
                id = id,
                count = count,
                head = reader_page::READER_PAGE_HEAD
            );
            Some((shell.into_bytes(), "text/html".to_string()))
        }
        "chapter" => {
            // 单章内容（虚拟化：一次只渲染一章）。返回 JSON {head, body}
            let idx: usize = rest.parse().ok()?;
            let format = {
                state
                    .library
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|b| b.format.clone())
                    .unwrap_or_default()
            };
            if format != "epub" {
                // txt/md：取第 idx 个切分章节。md 渲染 markdown；txt 段落化。
                let chapters = get_txt_chapters(state, id)?;
                let raw = chapters
                    .get(idx)
                    .map(|(_, c)| c.clone())
                    .unwrap_or_default();
                let body = if is_mobi(&format) {
                    format!(
                        "<div class=\"mobi-body\">{}</div>",
                        sanitize_mobi_html(&raw)
                    )
                } else if is_md(&format) {
                    format!("<div class=\"md-body\">{}</div>", md_to_html(&raw))
                } else {
                    txt_body(&raw)
                };
                let json = serde_json::json!({"head": "", "body": body}).to_string();
                return Some((json.into_bytes(), "application/json".to_string()));
            }
            ensure_epub_loaded(state, id).ok()?;
            let mut epubs = state.epubs.lock().unwrap();
            let doc = epubs.get_mut(&id)?;
            let spine_paths: Vec<String> = doc
                .spine
                .iter()
                .filter_map(|s| doc.resources.get(&s.idref))
                .map(|r| r.path.to_string_lossy().replace('\\', "/"))
                .collect();
            let chapter_map: HashMap<String, usize> = spine_paths
                .iter()
                .enumerate()
                .map(|(i, p)| (p.clone(), i))
                .collect();
            let cpath = spine_paths.get(idx)?.clone();
            let html = doc.get_resource_str_by_path(&cpath).unwrap_or_default();
            let base_dir = cpath.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            let rewritten = rewrite_css_url(
                &rewrite_attrs(&html, id, base_dir, &chapter_map),
                id,
                base_dir,
            );
            let mut head = String::new();
            let mut seen = std::collections::HashSet::new();
            collect_head_assets(&rewritten, &mut head, &mut seen);
            let body = extract_body_inner(&rewritten).to_string();
            let json = serde_json::json!({"head": head, "body": body}).to_string();
            Some((json.into_bytes(), "application/json".to_string()))
        }
        "pdf" => {
            let path = {
                let lib = state.library.lock().unwrap();
                lib.get(id)?.path.clone()
            };
            let bytes = std::fs::read(&path).ok()?;
            Some((bytes, "application/pdf".to_string()))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------

fn spawn_startup_maintenance(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        emit_startup_perf(
            &app,
            "startup-maintenance",
            "scheduled",
            "background delay=45s",
        );
        // 让首屏渲染、封面加载、窗口拖动和账号状态先稳定下来。
        std::thread::sleep(std::time::Duration::from_secs(45));
        while any_reader_window_open(&app) {
            emit_startup_perf(
                &app,
                "startup-maintenance",
                "paused",
                "reader window open",
            );
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        emit_startup_perf(&app, "fingerprint-fill", "start", "background");
        spawn_fingerprint_fill(app.clone());
        std::thread::sleep(std::time::Duration::from_secs(15));
        while any_reader_window_open(&app) {
            emit_startup_perf(
                &app,
                "keyword-index",
                "paused",
                "reader window open",
            );
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        search::spawn_build_index(app.clone());
        emit_startup_perf(
            &app,
            "startup-maintenance",
            "end",
            "spawned background jobs",
        );
        set_thread_background(false);
    });
}

/// 主窗口单实例（Windows 原生，命名互斥量）：已有实例在跑则把它的主窗口拉到前台，返回 false。
#[cfg(windows)]
fn ensure_single_instance() -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::AtomicPtr;
    type Handle = *mut core::ffi::c_void;
    static SINGLE_INSTANCE_MUTEX: AtomicPtr<core::ffi::c_void> =
        AtomicPtr::new(std::ptr::null_mut());
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attr: *const core::ffi::c_void, owner: i32, name: *const u16) -> Handle;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> Handle;
        fn SetForegroundWindow(hwnd: Handle) -> i32;
        fn ShowWindow(hwnd: Handle, cmd: i32) -> i32;
        fn IsIconic(hwnd: Handle) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;
    unsafe {
        let name = wide("KunpengReader_SingleInstance_Mutex");
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if !h.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
            // 已有实例 → 把它的主窗口（标题“鲲鹏阅读器”）拉到前台
            let title = wide("鲲鹏阅读器");
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                SetForegroundWindow(hwnd);
            }
            return false;
        }
        SINGLE_INSTANCE_MUTEX.store(h, Ordering::Relaxed); // 保持互斥量句柄存活到进程退出
        true
    }
}
#[cfg(not(windows))]
fn ensure_single_instance() -> bool {
    true
}

fn main() {
    if std::env::args().any(|a| a == "--sem-probe") {
        semantic::sem_probe();
        return;
    }
    if std::env::args().any(|a| a == "--hnsw-probe") {
        semantic::hnsw_probe();
        return;
    }
    // 主窗口只允许一个实例：已有实例在运行 → 聚焦它并退出本次启动
    if !ensure_single_instance() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            library: Mutex::new(Library::load()),
            db: Mutex::new(db::AppDb::open().ok()),
            epubs: Mutex::new(HashMap::new()),
            backfilled: std::sync::atomic::AtomicBool::new(false),
            pending_jump: Mutex::new(HashMap::new()),
            text_cache: Mutex::new(HashMap::new()),
            lower_text_cache: Mutex::new(HashMap::new()),
            txt_chapters: Mutex::new(HashMap::new()),
            cache_bytes: AtomicUsize::new(0),
            embedder: Mutex::new(None),
            sem_cache: Mutex::new(HashMap::new()),
            sem_cache_bytes: AtomicUsize::new(0),
            sem_progress: Mutex::new(semantic::SemProgress::default()),
            global_index: Mutex::new(None),
            index_resume_at: AtomicU64::new(0),
            stats: Mutex::new(StatsStore::load()),
            vocab: Mutex::new(vocab::VocabStore::load()),
            word_pack: Mutex::new(tts::WordPackState::default()),
        })
        // 主窗口（书架）：恢复上次的大小/位置，并在移动/缩放/关闭时记忆
        .setup(|app| {
            {
                let state = app.state::<AppState>();
                data_migration::migrate_json_to_sqlite(state.inner());
            }
            spawn_startup_maintenance(app.handle().clone()); // 延后低抢占维护任务，避免刚打开窗口拖动卡顿
            if let Some(win) = app.get_webview_window("main") {
                let geom = {
                    app.state::<AppState>()
                        .library
                        .lock()
                        .unwrap()
                        .main_geom
                        .clone()
                };
                // 先在隐藏状态下摆好位置/大小再显示（避免闪动）；位置越界则回到屏幕中央
                apply_geom_safe(&win, &geom);
                let app_ev = app.handle().clone();
                win.on_window_event(move |ev| match ev {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        if let Some(w) = app_ev.get_webview_window("main") {
                            let st = app_ev.state::<AppState>();
                            let mut lib = st.library.lock().unwrap();
                            lib.main_geom = Some(capture_geom(lib.main_geom.clone(), &w));
                        }
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        if let Some(w) = app_ev.get_webview_window("main") {
                            let st = app_ev.state::<AppState>();
                            let mut lib = st.library.lock().unwrap();
                            lib.main_geom = Some(capture_geom(lib.main_geom.clone(), &w));
                            lib.save();
                            st.stats.lock().unwrap().save();
                        }
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        // 异步协议：在后台线程处理，绝不阻塞 UI 主线程（避免空白/卡死）
        .register_asynchronous_uri_scheme_protocol("reader", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                let response = match handle_request(&state, &path) {
                    Some((bytes, mime)) => {
                        // 封面/EPUB 内嵌资源是稳定内容（封面换图时 URL 带 ?v= mtime 会自动失效），
                        // 让 WebView2 缓存它们：再次渲染书架时直接命中缓存、不再走异步协议重取，
                        // 避免封面“先黑一下再出图”。
                        let cacheable = path.starts_with("/cover/") || path.starts_with("/res/");
                        let cache_ctl = if cacheable {
                            "public, max-age=604800, immutable"
                        } else {
                            "no-cache"
                        };
                        tauri::http::Response::builder()
                            .status(200)
                            .header(tauri::http::header::CONTENT_TYPE, mime)
                            .header(tauri::http::header::CACHE_CONTROL, cache_ctl)
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
        })
        .invoke_handler(tauri::generate_handler![
            window_commands::main_window_minimize,
            window_commands::main_window_toggle_maximize,
            window_commands::main_window_close,
            window_commands::main_window_start_dragging,
            list_books,
            reader_window_open,
            app_version,
            dict_lookup,
            vocab::vocab_add,
            vocab::vocab_list,
            vocab::vocab_remove,
            vocab::vocab_set_level,
            vocab::vocab_review,
            vocab::notes_summary,
            sync::sync_get_settings,
            sync::sync_set_settings,
            sync::auth_register,
            sync::auth_login,
            sync::auth_logout,
            sync::sync_now,
            migrate_data_to_sqlite,
            export_data_package,
            import_data_package,
            update::check_update,
            update::release_notes,
            shelf_books,
            import::add_books,
            remove_book,
            remove_books,
            set_cover,
            import::get_auto_import,
            import::set_auto_import,
            import::auto_import_scan,
            open_book,
            book_info,
            reader_commands::book_meta,
            compute_word_counts,
            set_progress,
            reader_commands::add_bookmark,
            reader_commands::remove_bookmark,
            stats::reading_stats,
            stats::reading_stats_range,
            stats::add_reading_time,
            stats::add_read_words,
            open_url,
            tts::edge_tts,
            tts::word_tts,
            tts::word_tts_cache_size,
            tts::clear_word_tts_cache,
            tts::word_tts_pack_status,
            tts::word_tts_pack_missing,
            tts::clear_word_tts_pack,
            tts::start_word_tts_pack,
            tts::pause_word_tts_pack,
            pdf_support::get_page_cache,
            pdf_support::save_page_cache,
            pdf_support::get_pdf_state,
            pdf_support::set_pdf_state,
            search_book,
            reader_commands::set_description,
            reader_commands::set_rating,
            search::web_search,
            open_book_at,
            take_pending_jump,
            search::shelf_search,
            search::build_shelf_index,
            search::open_search_window,
            semantic::build_semantic_index,
            semantic::semantic_index_done,
            semantic::semantic_status,
            semantic::semantic_search,
            reader_commands::add_highlight,
            reader_commands::remove_highlight,
            reader_commands::set_highlight_note,
            relocate_book
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 失败");
}
