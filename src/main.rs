// 防止 Windows release 构建弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod book;

use book::{id_for_path, Library, WinGeom};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// 自定义协议的基地址（Windows 下 WebView2 把自定义协议映射到 http://<scheme>.localhost）
const RES_BASE: &str = "http://reader.localhost";

type EpubDoc = epub::doc::EpubDoc<std::io::BufReader<std::fs::File>>;

/// 调试日志：写到 %LOCALAPPDATA%\ebook-reader\debug.log（windows 子系统下没有 stderr）。
fn log(msg: &str) {
    if let Some(mut dir) = dirs::cache_dir() {
        dir.push("ebook-reader");
        let _ = std::fs::create_dir_all(&dir);
        dir.push("debug.log");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&dir) {
            let _ = writeln!(f, "{msg}");
        }
    }
}

/// 全局状态：书架 + 已打开的 EPUB 缓存（避免每个资源请求都重新解压）。
struct AppState {
    library: Mutex<Library>,
    epubs: Mutex<HashMap<u64, EpubDoc>>,
    backfilled: std::sync::atomic::AtomicBool, // 是否已回填旧书的作者/导入时间
    pending_jump: Mutex<HashMap<u64, (u32, String)>>, // 书架检索点击 → 阅读窗口待跳转位置
    text_cache: Mutex<HashMap<u64, (u64, Arc<Vec<String>>)>>, // 检索用：内存缓存的逐章纯文本 (mtime, 章节)
    cache_bytes: AtomicUsize,                                 // 已缓存的总字节数（限额用）
    embedder: Mutex<Option<Arc<fastembed::TextEmbedding>>>,   // 语义模型（懒加载，首次会下载）
    sem_cache: Mutex<HashMap<u64, Arc<SemData>>>,             // 语义检索：内存缓存的向量
    sem_cache_bytes: AtomicUsize,
    sem_progress: Mutex<SemProgress>, // 建立语义索引的进度
    global_hnsw: Mutex<Option<Arc<(GlobalHnsw, Vec<GlobalEntry>, Vec<u64>)>>>, // (图, 映射, 参与的书id)
}

/// 内存缓存上限：超过后不再缓存新书（避免超大书库吃光内存）。
const TEXT_CACHE_BUDGET: usize = 700 * 1024 * 1024;
const SEM_CACHE_BUDGET: usize = 1200 * 1024 * 1024;

// ---------------------------------------------------------------------------
//  传给前端的数据结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct BookDto {
    id: String,
    title: String,
    author: String,
    description: String,
    format: String,
    cover: Option<String>, // 封面图 URL（没有则前端画占位封面）
    progress: f32,
    added_at: u64,
    last_read_at: u64,
}

#[derive(Serialize)]
struct TocDto {
    label: String,
    chapter: u32,  // 目标章节序号
    frag: String,  // 章内锚点 id（可空）
    level: u8,
}

#[derive(Serialize)]
struct BookInfo {
    title: String,
    format: String,
    url: String,        // 要加载的页面（EPUB=整本合并页，txt=文本页）
    chapter_count: u32, // 章节数（供上一章/下一章用，锚点为 chap-0..chap-(n-1)）
    toc: Vec<TocDto>,
    progress: f32,
    resume_chapter: u32, // 续读：章节
    resume_frac: f32,    // 续读：章内比例
    bookmarks: Vec<book::Bookmark>,
}

fn to_dto(b: &book::Book) -> BookDto {
    let id = id_for_path(&b.path);
    BookDto {
        id: id.to_string(),
        title: b.title.clone(),
        author: b.author.clone(),
        description: b.description.clone(),
        format: b.format.clone(),
        cover: b.cover.as_ref().map(|_| format!("{RES_BASE}/cover/{id}")),
        progress: b.progress,
        added_at: b.added_at,
        last_read_at: b.last_read_at,
    }
}

// ---------------------------------------------------------------------------
//  命令
// ---------------------------------------------------------------------------

fn snapshot(lib: &Library) -> Vec<BookDto> {
    lib.books.iter().map(to_dto).collect()
}

#[tauri::command]
fn list_books(state: tauri::State<AppState>) -> Vec<BookDto> {
    snapshot(&state.library.lock().unwrap())
}

/// 首次加载：回填旧书缺失的作者（重读 EPUB 元数据）和导入时间，然后返回书单。
/// 之后的刷新走 list_books（快，不再重读）。
#[tauri::command]
async fn shelf_books(state: tauri::State<'_, AppState>) -> Result<Vec<BookDto>, ()> {
    if !state.backfilled.swap(true, std::sync::atomic::Ordering::SeqCst) {
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

// async：导入要解析 EPUB、提取封面（慢），必须在主线程之外执行，否则卡死 UI
#[tauri::command]
async fn add_books(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    let mut lib = state.library.lock().unwrap();
    let mut changed = false;
    for p in paths {
        if lib.add(std::path::PathBuf::from(p)) {
            changed = true;
        }
    }
    if changed {
        lib.save();
    }
    Ok(snapshot(&lib))
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
fn take_pending_jump(window: tauri::WebviewWindow, state: tauri::State<AppState>) -> Option<JumpPayload> {
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

    // 只读一下书名（快），先把窗口建出来，优先让页面打开
    let title = {
        let lib = state.library.lock().unwrap();
        lib.get(id_num)
            .map(|b| b.title.clone())
            .unwrap_or_else(|| "阅读".to_string())
    };

    // 读取上次阅读窗口的大小/位置，本次按它恢复
    let geom = { state.library.lock().unwrap().reader_geom.clone() };
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
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("reader.html".into()))
            .title(title)
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

    // 监听窗口移动/缩放/关闭：把几何信息持久化，供下次打开恢复
    let app_ev = app.clone();
    let label_ev = label.clone();
    w.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
            if let Some(win) = app_ev.get_webview_window(&label_ev) {
                let st = app_ev.state::<AppState>();
                let mut lib = st.library.lock().unwrap();
                update_reader_geom(&mut lib, &win);
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            if let Some(win) = app_ev.get_webview_window(&label_ev) {
                let st = app_ev.state::<AppState>();
                let mut lib = st.library.lock().unwrap();
                update_reader_geom(&mut lib, &win);
                lib.save();
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
    let m = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| win.available_monitors().ok().and_then(|v| v.into_iter().next()))?;
    let scale = m.scale_factor();
    let ms = m.size();
    Some((ms.width as f64 / scale, ms.height as f64 / scale))
}

/// 在主显示器上居中放置一个 w×h 窗口时的左上角逻辑坐标。
fn centered_position(win: &tauri::WebviewWindow, w: f64, h: f64) -> Option<(f64, f64)> {
    let m = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| win.available_monitors().ok().and_then(|v| v.into_iter().next()))?;
    let scale = m.scale_factor();
    let mp = m.position();
    let ms = m.size();
    let (mx, my) = (mp.x as f64 / scale, mp.y as f64 / scale);
    let (mw, mh) = (ms.width as f64 / scale, ms.height as f64 / scale);
    Some((mx + (mw - w).max(0.0) / 2.0, my + (mh - h).max(0.0) / 2.0))
}

/// 把当前阅读窗口的大小/位置写入内存中的书库（不立即落盘，关闭时再统一保存）。
fn update_reader_geom(lib: &mut Library, win: &tauri::WebviewWindow) {
    lib.reader_geom = Some(capture_geom(lib.reader_geom.clone(), win));
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

    let (title, format, progress, resume_chapter, resume_frac, bookmarks) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id_num).ok_or("找不到这本书")?;
        (
            b.title.clone(),
            b.format.clone(),
            b.progress,
            b.resume_chapter,
            b.resume_frac,
            b.bookmarks.clone(),
        )
    };

    if format != "epub" {
        // pdf 用 WebView2 自带阅读器；txt/md 用生成的文本页
        let url = if format == "pdf" {
            format!("{RES_BASE}/pdf/{id_num}")
        } else {
            format!("{RES_BASE}/txt/{id_num}")
        };
        return Ok(BookInfo {
            title,
            format,
            url,
            chapter_count: 1,
            toc: Vec::new(),
            progress,
            resume_chapter,
            resume_frac,
            bookmarks,
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

    log(&format!(
        "book_info -> {} chapters, {} toc",
        spine_paths.len(),
        toc.len()
    ));
    Ok(BookInfo {
        title,
        format,
        url: format!("{RES_BASE}/book/{id_num}"),
        chapter_count: spine_paths.len() as u32,
        toc,
        progress,
        resume_chapter,
        resume_frac,
        bookmarks,
    })
}

/// 从阅读窗口 label 取图书 id。
fn reader_window_id(window: &tauri::WebviewWindow) -> Option<u64> {
    window.label().strip_prefix("reader-").and_then(|s| s.parse().ok())
}

/// 去掉 HTML 标签，得到纯文本（合并连续空白）。
fn strip_tags(html: &str) -> String {
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

/// 修改简介（信息弹窗里可编辑）。
#[tauri::command]
fn set_description(window: tauri::WebviewWindow, state: tauri::State<AppState>, description: String) {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.set_description(id, description);
        lib.save();
    }
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

#[derive(Serialize)]
struct Stats {
    total_seconds: u64,
    total_words: u64, // 累计已读字数（≈ 进度 × 字数 之和）
    total_books: u32,
    started: u32,
    finished: u32,
}

/// 全局阅读统计，给书架主窗口展示。
#[tauri::command]
fn reading_stats(state: tauri::State<AppState>) -> Stats {
    let lib = state.library.lock().unwrap();
    let mut s = Stats {
        total_seconds: 0,
        total_words: 0,
        total_books: 0,
        started: 0,
        finished: 0,
    };
    for b in &lib.books {
        s.total_books += 1;
        s.total_seconds += b.reading_seconds;
        s.total_words += (b.progress as f64 / 100.0 * b.word_count as f64) as u64;
        if b.progress > 0.5 {
            s.started += 1;
        }
        if b.progress >= 99.0 {
            s.finished += 1;
        }
    }
    s
}

/// 阅读窗口定时上报阅读时长（秒）。
#[tauri::command]
async fn add_reading_time(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    seconds: u64,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        if let Some(b) = lib.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            b.reading_seconds += seconds;
        }
        lib.save();
    }
    Ok(())
}

#[tauri::command]
fn add_bookmark(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    chapter: u32,
    frac: f32,
    label: String,
) -> Vec<book::Bookmark> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.add_bookmark(id, chapter, frac, label);
        lib.save();
        return lib.bookmarks(id);
    }
    Vec::new()
}

#[tauri::command]
fn remove_bookmark(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    index: usize,
) -> Vec<book::Bookmark> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.remove_bookmark(id, index);
        lib.save();
        return lib.bookmarks(id);
    }
    Vec::new()
}

#[derive(Serialize)]
struct BookMeta {
    title: String,
    author: String,
    description: String,
    format: String,
    word_count: u64,
    size: u64, // 文件字节数
}

/// 书籍信息（含字数统计），供阅读页的信息弹窗用。按需调用（不拖慢打开）。
#[tauri::command]
async fn book_meta(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<BookMeta, String> {
    let label = window.label().to_string();
    let id: u64 = label
        .strip_prefix("reader-")
        .and_then(|s| s.parse().ok())
        .ok_or("非阅读窗口")?;

    let (title, author, description, format) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id).ok_or("找不到这本书")?;
        (
            b.title.clone(),
            b.author.clone(),
            b.description.clone(),
            b.format.clone(),
        )
    };

    // 优先用已存的字数（导入/后台已算好），没有才现算并存起来
    let (stored, book_clone) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id).ok_or("找不到这本书")?;
        (b.word_count, b.clone())
    };
    let size = std::fs::metadata(&book_clone.path).map(|m| m.len()).unwrap_or(0);
    let word_count = if stored > 0 {
        stored
    } else {
        let wc = book::compute_word_count(&book_clone); // 不持锁，慢操作
        if wc > 0 {
            let mut lib = state.library.lock().unwrap();
            lib.set_word_count(id, wc);
            lib.save();
        }
        wc
    };

    Ok(BookMeta {
        title,
        author,
        description,
        format,
        word_count,
        size,
    })
}

/// 后台批量统计还没字数的书。立刻返回，真正的统计放到独立后台线程，
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
                .map(|b| (id_for_path(&b.path), b.clone()))
                .collect()
        };
        let mut changed = false;
        for (id, b) in pending {
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

fn flatten_toc(
    navs: &[epub::doc::NavPoint],
    level: u8,
    chapter_map: &HashMap<String, usize>,
    out: &mut Vec<TocDto>,
) {
    for np in navs {
        let (chapter, frag) = toc_target(&np.content, chapter_map);
        out.push(TocDto {
            label: np.label.clone(),
            chapter,
            frag,
            level,
        });
        flatten_toc(&np.children, level + 1, chapter_map, out);
    }
}

/// 把目录项指向的资源换算成 (章节序号, 章内锚点)。
fn toc_target(content: &Path, chapter_map: &HashMap<String, usize>) -> (u32, String) {
    let s = content.to_string_lossy().replace('\\', "/");
    let (path_part, frag) = match s.split_once('#') {
        Some((p, f)) => (p, f.to_string()),
        None => (s.as_str(), String::new()),
    };
    let chapter = chapter_map.get(path_part).copied().unwrap_or(0) as u32;
    (chapter, frag)
}

// ---------------------------------------------------------------------------
//  自定义协议 reader:// —— 把图书资源喂给 WebView
//    /res/<id>/<resPath>  EPUB 内部资源（章节 xhtml、图片、css、字体…）
//    /txt/<id>            txt/md 生成的阅读页
//    /cover/<id>          封面缩略图
// ---------------------------------------------------------------------------

fn ensure_epub_loaded(state: &AppState, id: u64) -> Result<(), String> {
    let mut epubs = state.epubs.lock().unwrap();
    if epubs.contains_key(&id) {
        return Ok(());
    }
    let path = {
        let lib = state.library.lock().unwrap();
        lib.get(id).ok_or("找不到这本书")?.path.clone()
    };
    let doc = EpubDoc::new(&path).map_err(|_| "无法打开 EPUB 文件".to_string())?;
    epubs.insert(id, doc);
    Ok(())
}

fn handle_request(state: &AppState, path: &str) -> Option<(Vec<u8>, String)> {
    log(&format!("request {path}"));
    let decoded = percent_decode(path);
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next()?;
    let id: u64 = parts.next()?.parse().ok()?;
    let rest = parts.next().unwrap_or("");

    match kind {
        "cover" => {
            let lib = state.library.lock().unwrap();
            let cover = lib.get(id)?.cover.clone()?;
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
            ensure_epub_loaded(state, id).ok()?;
            let count = {
                let mut epubs = state.epubs.lock().unwrap();
                epubs.get_mut(&id).map(|d| d.spine.len()).unwrap_or(0)
            };
            let shell = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
<script>window.__ID__='{id}';window.__CH__={count};</script>{head}</head>\
<body><div id=\"pager\"><div id=\"reader-root\" class=\"rr\"></div></div><div id=\"measurer\" class=\"rr\"></div></body></html>",
                id = id,
                count = count,
                head = READER_PAGE_HEAD
            );
            Some((shell.into_bytes(), "text/html".to_string()))
        }
        "chapter" => {
            // 单章内容（虚拟化：一次只渲染一章）。返回 JSON {head, body}
            let idx: usize = rest.parse().ok()?;
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
            let rewritten =
                rewrite_css_url(&rewrite_attrs(&html, id, base_dir, &chapter_map), id, base_dir);
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


/// 合并页的基础样式 + 分页脚本。
///  - CSS 多栏(column)把整本内容按“一屏一栏”排版，行只会在栏间断开 → 永不切字。
///  - 用 pager.scrollLeft 一页页翻；向父窗口上报 当前页/总页/进度。
///  - 监听父窗口消息：settings（阅读设置）、gotoAnchor（目录跳转）、pageTurn（翻页）。
const READER_PAGE_HEAD: &str = r##"<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff}
body{opacity:0;transition:opacity .12s ease}
body.ready{opacity:1}
*::-webkit-scrollbar{width:0;height:0;display:none}
#pager{position:fixed;inset:0;overflow:hidden}
.rr{height:100vh;box-sizing:border-box;column-fill:auto;overflow-wrap:break-word;word-break:break-word}
.rr img{max-width:100%;max-height:86vh;height:auto}
/* 任何内容都不得超过一栏宽，否则该栏会变宽、后续页码错位导致正文整体右移 */
.rr *{max-width:100%}
.rr pre{white-space:pre-wrap;word-break:break-word}
.rr table{table-layout:fixed;width:100%}
.rr-end{break-before:column;-webkit-column-break-before:always;width:1px;height:1px;font-size:0}
#measurer{position:fixed;left:-99999px;top:0;overflow:hidden;pointer-events:none}
mark.search-hit{background:#ffe58a;color:inherit}
mark.search-hit.cur{background:#ff9f40}
#sel-menu{position:fixed;display:none;z-index:99999}
#sel-menu button{font:12px/1 system-ui,'Microsoft YaHei',sans-serif;color:#4a463e;background:#faf8f2;border:1px solid #e4ddcd;border-radius:6px;padding:5px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);white-space:nowrap}
#sel-menu button:hover{background:#f1ebdc}
</style>
<script>
var S={fontFamily:"",fontSize:18,lineHeight:1.7,paraSpacing:0.6,letterSpacing:0,marginTop:18,marginBottom:24,marginLeft:28,marginRight:28};
var root,pager,curCh=0,pageInCh=0,pagesInCh=1,pageStep=1,headSeen={};
var downX=null,downY=null,didDrag=false;
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null;
var CH=window.__CH__||0, ID=window.__ID__||0;
var VC=null; // 虚拟章节列表 [{ch:spine序号, frag:锚点}]（按目录顺序），用于在大文件内细分逻辑章节
// 算出“当前在第几个逻辑章节（0 基）”：取目录顺序中位置 <= 当前阅读位置的最后一条
function computeLogical(){
  if(!VC||!VC.length)return {lc:curCh,lt:CH};
  var idx=0;
  for(var k=0;k<VC.length;k++){
    var v=VC[k];
    if(v.ch<curCh){idx=k;}
    else if(v.ch===curCh){
      var pg=0;if(v.frag){var el=document.getElementById(v.frag);if(el)pg=pageOf(el);}
      if(pg<=pageInCh){idx=k;}else{break;}
    }else{break;}
  }
  return {lc:idx,lt:VC.length};
}
function applyStyle(){
  var st=document.getElementById('user-style');
  if(!st){st=document.createElement('style');st.id='user-style';document.head.appendChild(st);}
  var c='.rr{padding:'+S.marginTop+'px '+S.marginRight+'px '+S.marginBottom+'px '+S.marginLeft+'px;';
  if(S.fontSize)c+='font-size:'+S.fontSize+'px;';
  if(S.lineHeight)c+='line-height:'+S.lineHeight+';';
  c+='letter-spacing:'+S.letterSpacing+'px;';
  if(S.fontFamily)c+='font-family:'+S.fontFamily+';';
  c+='}';
  if(S.fontFamily)c+='.rr *{font-family:'+S.fontFamily+' !important;}';
  if(S.lineHeight)c+='.rr p,.rr div,.rr li{line-height:'+S.lineHeight+';}';
  c+='.rr p{margin-top:0;margin-bottom:'+S.paraSpacing+'em;}';
  var bg='#fff',fg='#222';
  if(S.theme==='dark'){bg='#1c1c1e';fg='#d2d2d2';}
  else if(S.theme==='sepia'){bg='#f4ecd8';fg='#5b4636';}
  c+='html,body{background:'+bg+' !important;}';
  if(S.theme&&S.theme!=='light'){c+='.rr,.rr *{color:'+fg+' !important;}';}
  // 强制横排：有些书自带 -epub-writing-mode:vertical-rl（竖排），覆盖成横排左→右
  c+='html,body,.rr,.rr *{writing-mode:horizontal-tb !important;-webkit-writing-mode:horizontal-tb !important;-epub-writing-mode:horizontal-tb !important;text-orientation:mixed !important;}.rr{direction:ltr !important;}';
  st.textContent=c;
}
function applyCols(){
  var vw=window.innerWidth, vh=window.innerHeight, colW=Math.max(100, vw-S.marginLeft-S.marginRight);
  root.style.height=vh+'px';root.style.columnWidth=colW+'px';root.style.columnGap=(S.marginLeft+S.marginRight)+'px';
  // 末尾有一个强制分栏的占位空栏（rr-end），让滚动条能到达真正的最后一页；页数要减掉它
  pageStep=vw;pagesInCh=Math.max(1,Math.round(pager.scrollWidth/vw)-1);
}
function report(){
  var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  var gP=0,gT=0;
  if(measureDone){for(var i=0;i<CH;i++)gT+=chapterPages[i]||1;for(var j=0;j<curCh;j++)gP+=chapterPages[j]||1;gP+=pageInCh+1;}
  // 进度优先按“整书页位置”算（章节大小不均时仍平滑）；未测量完再退回按章节估算
  var prog;
  if(measureDone&&gT>0)prog=(gP/gT)*100;
  else prog=CH>0?((curCh+chFrac)/CH)*100:0;
  var L=computeLogical();
  parent.postMessage({chapter:curCh,chFrac:chFrac,page:pageInCh+1,total:pagesInCh,totalCh:CH,progress:prog,gPage:gP,gTotal:gT,logicalCh:L.lc,logicalTotal:L.lt},'*');
}
function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=window.innerWidth,vh=window.innerHeight,colW=Math.max(100,vw-S.marginLeft-S.marginRight);
  measurer.style.width=vw+'px';measurer.style.height=vh+'px';measurer.style.columnWidth=colW+'px';measurer.style.columnGap=(S.marginLeft+S.marginRight)+'px';
  measurer.innerHTML=html;
  return Math.max(1,Math.round(measurer.scrollWidth/vw));
}
function measureAll(){
  var tok=++measureToken;measureDone=false;chapterPages=new Array(CH).fill(0);
  var i=0;
  function step(){
    if(tok!==measureToken)return;
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;report();return;}
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;chapterPages[i]=measureChapterPages(d.body||'');i++;setTimeout(step,0);
    }).catch(function(){chapterPages[i]=1;i++;setTimeout(step,0);});
  }
  step();
}
function scheduleMeasure(){if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,1200);}
function gotoPage(p){pageInCh=Math.max(0,Math.min(pagesInCh-1,p));pager.scrollLeft=pageInCh*pageStep;report();}
function pageOf(el){var r=el.getBoundingClientRect(),pr=pager.getBoundingClientRect();var x=r.left-pr.left+pager.scrollLeft;return Math.floor((x+1)/pageStep);}
function showChapter(i,where,frag){
  i=Math.max(0,Math.min(CH-1,i));
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    curCh=i;if(d.head)injectHead(d.head,headSeen);root.innerHTML=(d.body||'')+'<div class="rr-end"></div>';applyStyle();applyCols();
    pageInCh=0;
    if(where==='end')pageInCh=pagesInCh-1;else if(typeof where==='number')pageInCh=Math.max(0,Math.min(pagesInCh-1,where));
    if(frag){var el=document.getElementById(frag);if(el)pageInCh=pageOf(el);}
    pager.scrollLeft=pageInCh*pageStep;report();
  }).catch(function(){});
}
function relayout(){if(!root)return;applyStyle();applyCols();if(pageInCh>pagesInCh-1)pageInCh=pagesInCh-1;pager.scrollLeft=pageInCh*pageStep;report();}
function nextPage(){if(pageInCh<pagesInCh-1)gotoPage(pageInCh+1);else if(curCh<CH-1)showChapter(curCh+1,'start');}
function prevPage(){if(pageInCh>0)gotoPage(pageInCh-1);else if(curCh>0)showChapter(curCh-1,'end');}
function reveal(){document.body.classList.add('ready');}
function injectHead(htmlStr,seen){
  var tmp=document.createElement('div');tmp.innerHTML=htmlStr;
  var nodes=tmp.querySelectorAll('link,style');
  for(var i=0;i<nodes.length;i++){var key=nodes[i].outerHTML;if(seen[key])continue;seen[key]=1;document.head.appendChild(nodes[i]);}
}
function loadInit(){
  var p=new URLSearchParams(location.search);
  try{S=Object.assign(S,JSON.parse(decodeURIComponent(p.get('s')||'{}')));}catch(e){}
  var rc=parseInt(p.get('rc')||'0',10)||0, rf=parseFloat(p.get('rf')||'0')||0;
  showChapter(rc,'start').then(function(){
    if(rf>0.005)gotoPage(Math.round(rf*(pagesInCh-1)));
    reveal();parent.postMessage({ready:1},'*');
    scheduleMeasure(); // 后台测量全书页数
  });
}
function init(){
  pager=document.getElementById('pager');root=document.getElementById('reader-root');measurer=document.getElementById('measurer');
  loadInit();
  setTimeout(function(){reveal();parent.postMessage({ready:1},'*');},8000); // 兜底
  // 记录是否发生了拖动（用于区分“单击翻页”与“拖动选字”）
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;});
  document.addEventListener('mousemove',function(e){if(downX!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  document.addEventListener('click',function(e){
    parent.postMessage({uiClick:1},'*');
    var a=e.target.closest?e.target.closest('a'):null;
    if(a){var href=a.getAttribute('href')||'';
      if(href.charAt(0)==='#'){e.preventDefault();
        var m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        if(m){var ci=parseInt(m[1],10),fr=m[2];if(ci===curCh){if(fr){var el=document.getElementById(fr);if(el)gotoPage(pageOf(el));}}else showChapter(ci,'start',fr);}
        else{var el2=document.getElementById(href.slice(1));if(el2)gotoPage(pageOf(el2));}
      }
      return;
    }
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    var sel=window.getSelection?window.getSelection():null;
    if(didDrag||(sel&&!sel.isCollapsed&&sel.toString().trim())){return;}
    var x=e.clientX;if(x>window.innerWidth*0.6)nextPage();else if(x<window.innerWidth*0.4)prevPage();
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='PageDown'||e.key==='ArrowRight'||(e.key===' '&&!e.shiftKey)){e.preventDefault();nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||(e.key===' '&&e.shiftKey)){e.preventDefault();prevPage();}
  });
  var wheelLock=false;
  document.addEventListener('wheel',function(e){e.preventDefault();if(wheelLock)return;if(Math.abs(e.deltaY)<4&&Math.abs(e.deltaX)<4)return;if(e.deltaY>0||e.deltaX>0)nextPage();else prevPage();wheelLock=true;setTimeout(function(){wheelLock=false;},220);},{passive:false});
  window.addEventListener('resize',function(){relayout();scheduleMeasure();});
  setupSelMenu();
}
// 选中文字后弹出“web搜索”菜单 → 通知父窗口用浏览器搜索
var selMenu=null;
function hideSelMenu(){if(selMenu)selMenu.style.display='none';}
function setupSelMenu(){
  selMenu=document.createElement('div');selMenu.id='sel-menu';
  var btn=document.createElement('button');btn.type='button';btn.textContent='🔍 web搜索';
  selMenu.appendChild(btn);document.body.appendChild(selMenu);
  btn.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});
  btn.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)parent.postMessage({webSearch:t},'*');
    hideSelMenu();
  });
  document.addEventListener('mouseup',function(){
    setTimeout(function(){
      var sel=window.getSelection?window.getSelection():null;
      var t=sel?sel.toString().trim():'';
      if(!t){hideSelMenu();return;}
      var rect;try{rect=sel.getRangeAt(0).getBoundingClientRect();}catch(_){hideSelMenu();return;}
      if(!rect||(!rect.width&&!rect.height)){hideSelMenu();return;}
      selMenu.style.display='block';
      var mw=selMenu.offsetWidth||100,mh=selMenu.offsetHeight||34;
      var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
      var top=rect.top-mh-8;if(top<6)top=rect.bottom+8;
      selMenu.style.left=left+'px';selMenu.style.top=top+'px';
    },0);
  });
  document.addEventListener('mousedown',function(e){if(selMenu&&!selMenu.contains(e.target))hideSelMenu();});
  document.addEventListener('wheel',hideSelMenu,{passive:true});
  document.addEventListener('keydown',hideSelMenu);
}
var sMarks=[],sIdx=-1;
function clearSearch(){
  for(var i=0;i<sMarks.length;i++){var m=sMarks[i];if(m.parentNode){m.parentNode.replaceChild(document.createTextNode(m.textContent),m);}}
  sMarks=[];sIdx=-1;
}
// 清除高亮后把视图重新钉回当前页：删 <mark> 会让浏览器把横向滚动跑掉，需重新定位
function clearMarksKeepPage(){
  clearSearch();
  if(!root)return;
  applyCols();
  if(pageInCh>pagesInCh-1)pageInCh=pagesInCh-1;
  pager.scrollLeft=pageInCh*pageStep;
  report();
}
function doSearch(term){
  clearSearch();
  term=(term||'').trim();
  if(!term){relayout();parent.postMessage({searchPos:0,searchCount:0},'*');return;}
  var low=term.toLowerCase(),len=term.length;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    if(!n.nodeValue)return NodeFilter.FILTER_REJECT;
    var p=n.parentNode?n.parentNode.nodeName:'';
    if(p==='SCRIPT'||p==='STYLE'||p==='MARK')return NodeFilter.FILTER_REJECT;
    return n.nodeValue.toLowerCase().indexOf(low)>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
  }});
  var nodes=[],nd;while(nd=walker.nextNode())nodes.push(nd);
  for(var k=0;k<nodes.length;k++){
    var node=nodes[k],text=node.nodeValue,lowt=text.toLowerCase(),idx,last=0,frag=document.createDocumentFragment();
    while((idx=lowt.indexOf(low,last))>=0){
      if(idx>last)frag.appendChild(document.createTextNode(text.slice(last,idx)));
      var mk=document.createElement('mark');mk.className='search-hit';mk.textContent=text.slice(idx,idx+len);
      frag.appendChild(mk);sMarks.push(mk);last=idx+len;
    }
    if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
    if(node.parentNode)node.parentNode.replaceChild(frag,node);
  }
  applyCols();
  if(sMarks.length){sIdx=0;focusMatch();}else{parent.postMessage({searchPos:0,searchCount:0},'*');}
}
function focusMatch(){
  for(var i=0;i<sMarks.length;i++)sMarks[i].classList.toggle('cur',i===sIdx);
  if(sIdx>=0&&sMarks[sIdx])gotoPage(pageOf(sMarks[sIdx]));
  parent.postMessage({searchPos:sIdx+1,searchCount:sMarks.length},'*');
}
function searchNav(d){if(!sMarks.length)return;sIdx=(sIdx+d+sMarks.length)%sMarks.length;focusMatch();}
window.addEventListener('message',function(e){
  if(!e.data)return;
  if(e.data.settings){S=Object.assign(S,e.data.settings);relayout();scheduleMeasure();}
  if(e.data.clearMarks){clearMarksKeepPage();}
  if(e.data.gotoChapter!==undefined){var cf=e.data.chFrac,fr=e.data.frag,sq=e.data.search;showChapter(e.data.gotoChapter,'start',fr).then(function(){if(cf!==undefined&&cf>0)gotoPage(Math.round(cf*(pagesInCh-1)));if(sq)doSearch(sq);});}
  if(e.data.gotoFrac!==undefined){showChapter(Math.min(CH-1,Math.floor(e.data.gotoFrac*CH)),'start');}
  if(e.data.pageTurn){if(e.data.pageTurn>0)nextPage();else prevPage();}
  if(e.data.reveal){reveal();}
  if(e.data.search!==undefined){doSearch(e.data.search);}
  if(e.data.searchNav){searchNav(e.data.searchNav);}
  if(e.data.vchaps){VC=e.data.vchaps;report();}
  if(e.data.resolveToc){
    // 在当前章里，找出当前页或之前最近的一个目录锚点
    var frags=e.data.resolveToc,bestFrag=frags.length?frags[0]:'',bestPage=-1;
    for(var i=0;i<frags.length;i++){
      var f=frags[i],pg;
      if(!f){pg=0;}else{var el=document.getElementById(f);if(!el){continue;}pg=pageOf(el);}
      if(pg<=pageInCh&&pg>=bestPage){bestPage=pg;bestFrag=f;}
    }
    parent.postMessage({tocResolved:{chapter:curCh,frag:bestFrag}},'*');
  }
});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
</script>"##;

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/// 把相对路径 rel 基于 base_dir 解析成归档内的绝对路径（处理 ./ 和 ../）。
fn resolve_rel(base_dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// 把一个资源/链接的相对 URL 重写为合并页可用的地址。
/// is_href=true 表示这是导航链接（<a href>）：指向某章节则改为页面内锚点。
fn rewrite_url(
    value: &str,
    is_href: bool,
    id: u64,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> String {
    let v = value.trim();
    if v.is_empty()
        || v.starts_with("http:")
        || v.starts_with("https:")
        || v.starts_with("data:")
        || v.starts_with("blob:")
        || v.starts_with("mailto:")
        || v.starts_with("tel:")
        || v.starts_with("//")
        || v.starts_with('#')
    {
        return value.to_string();
    }
    let (path_part, frag) = match v.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (v, None),
    };
    let abs = resolve_rel(base_dir, path_part);
    if is_href {
        if let Some(idx) = chapter_map.get(&abs) {
            // 站内导航：编码成 章节(+章内锚点)，前端据此加载对应章
            return match frag {
                Some(f) => format!("#c{idx}~{f}"),
                None => format!("#c{idx}"),
            };
        }
    }
    let mut url = format!("{RES_BASE}/res/{id}/{}", encode_path(&abs));
    if let Some(f) = frag {
        url.push('#');
        url.push_str(f);
    }
    url
}

/// 重写 HTML 里 src/href/xlink:href/poster 等属性中的相对 URL。
fn rewrite_attrs(
    html: &str,
    id: u64,
    base_dir: &str,
    chapter_map: &HashMap<String, usize>,
) -> String {
    const PATTERNS: [(&str, char); 7] = [
        (" src=\"", '"'),
        (" src='", '\''),
        (" href=\"", '"'),
        (" href='", '\''),
        (" xlink:href=\"", '"'),
        (" xlink:href='", '\''),
        (" poster=\"", '"'),
    ];
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    'outer: while i < html.len() {
        for (pat, quote) in PATTERNS.iter() {
            if html[i..].starts_with(pat) {
                out.push_str(pat);
                let vstart = i + pat.len();
                if let Some(end) = html[vstart..].find(*quote) {
                    let value = &html[vstart..vstart + end];
                    let is_href = pat.contains("href");
                    out.push_str(&rewrite_url(value, is_href, id, base_dir, chapter_map));
                    out.push(*quote);
                    i = vstart + end + 1;
                } else {
                    i = vstart;
                }
                continue 'outer;
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 重写 CSS 里 url(...) 中的相对地址（内联 style 与 <style> 块）。
fn rewrite_css_url(html: &str, id: u64, base_dir: &str) -> String {
    let empty = HashMap::new();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if html[i..].starts_with("url(") {
            if let Some(end) = html[i + 4..].find(')') {
                let raw = html[i + 4..i + 4 + end].trim();
                let (q, inner) = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
                    ("\"", &raw[1..raw.len() - 1])
                } else if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
                    ("'", &raw[1..raw.len() - 1])
                } else {
                    ("", raw)
                };
                out.push_str("url(");
                out.push_str(q);
                out.push_str(&rewrite_url(inner, false, id, base_dir, &empty));
                out.push_str(q);
                out.push(')');
                i = i + 4 + end + 1;
                continue;
            }
        }
        let ch = html[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 取属性值（在单个标签字符串里）。
fn attr_value(tag: &str, key: &str) -> Option<String> {
    for q in ['"', '\''] {
        let needle = format!("{key}={q}");
        if let Some(p) = tag.find(&needle) {
            let s = p + needle.len();
            if let Some(e) = tag[s..].find(q) {
                return Some(tag[s..s + e].to_string());
            }
        }
    }
    None
}

/// 从一章 HTML 里收集 <link rel=stylesheet> 与 <style> 块到合并页头部（去重）。
fn collect_head_assets(html: &str, head: &mut String, seen: &mut std::collections::HashSet<String>) {
    // <link ...>
    let mut i = 0;
    while let Some(p) = html[i..].find("<link") {
        let start = i + p;
        if let Some(e) = html[start..].find('>') {
            let tag = &html[start..start + e + 1];
            let key = attr_value(tag, "href").unwrap_or_else(|| tag.to_string());
            if seen.insert(format!("link:{key}")) {
                head.push_str(tag);
                head.push('\n');
            }
            i = start + e + 1;
        } else {
            break;
        }
    }
    // <style>...</style>
    let mut j = 0;
    while let Some(p) = html[j..].find("<style") {
        let start = j + p;
        if let Some(e) = html[start..].find("</style>") {
            let block = &html[start..start + e + "</style>".len()];
            if seen.insert(format!("style:{block}")) {
                head.push_str(block);
                head.push('\n');
            }
            j = start + e + "</style>".len();
        } else {
            break;
        }
    }
}

/// 取 <body> 内部内容；没有 body 标签则返回整段。
fn extract_body_inner(html: &str) -> &str {
    if let Some(bs) = html.find("<body") {
        if let Some(gt) = html[bs..].find('>') {
            let start = bs + gt + 1;
            if let Some(be) = html[start..].find("</body>") {
                return &html[start..start + be];
            }
            return &html[start..];
        }
    }
    html
}

fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn guess_mime(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let m = match ext.as_str() {
        "html" | "xhtml" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    m.to_string()
}

/// 把纯文本包成一个排版好看的 HTML 阅读页。
fn txt_html(text: &str) -> String {
    let mut body = String::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        body.push_str("<p>");
        body.push_str(&html_escape(para));
        body.push_str("</p>\n");
    }
    format!(
        "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">\
<style>html{{font-size:18px}}body{{font-family:'Microsoft YaHei',serif;line-height:1.85;\
max-width:42em;margin:0 auto;padding:28px 24px;color:#222;background:#fff;}}\
p{{margin:0 0 0.7em;text-indent:2em;}}</style></head><body>{body}</body></html>"
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// ---------------------------------------------------------------------------
//  书架全文检索（方案 B：每本书预先抽取逐章纯文本，缓存为索引文件）
// ---------------------------------------------------------------------------

const INDEX_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct BookIndex {
    v: u32,
    mtime: u64,            // 源文件最后修改时间（秒），用于判断索引是否过期
    chapters: Vec<String>, // 逐章纯文本（epub 按 spine 顺序；txt/md 为单章）
}

/// 跳转/检索用的载荷类型
#[derive(Clone, Serialize)]
struct JumpPayload {
    chapter: u32,
    term: String,
}

/// 复用检索窗口时，主窗口发来的新查询
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

fn file_mtime(path: &Path) -> u64 {
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
        "pdf" => Vec::new(),
        _ => match std::fs::read(&book.path) {
            Ok(b) => vec![book::normalize_text(&book::decode_bytes(&b))],
            Err(_) => Vec::new(),
        },
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

/// 确保某书索引存在且新鲜，返回它（pdf 或抽取失败返回 None）。
fn ensure_book_index(book: &book::Book) -> Option<BookIndex> {
    if book.format == "pdf" {
        return None;
    }
    let id = id_for_path(&book.path);
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

/// 后台为全书架建立/更新索引（导入新书或启动时调用，温和不抢资源）。
fn spawn_build_index(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let books: Vec<book::Book> = { state.library.lock().unwrap().books.clone() };
        for b in books {
            ensure_book_index(&b);
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    });
}

/// 前端可主动触发（导入后）建立索引。
#[tauri::command]
fn build_shelf_index(app: tauri::AppHandle) {
    spawn_build_index(app);
}

#[derive(Serialize)]
struct ChapterHit {
    chapter: u32,
    snippet: String,
}

#[derive(Serialize)]
struct ShelfBookHits {
    book_id: String,
    title: String,
    author: String,
    count: u32,            // 该书真实命中总数
    hits: Vec<ChapterHit>, // 截断后的片段（用于展示）
}

/// 取一本书的逐章纯文本：优先内存缓存；未命中则读索引文件并（在限额内）缓存。
fn get_book_chapters(state: &AppState, book: &book::Book) -> Option<Arc<Vec<String>>> {
    let id = id_for_path(&book.path);
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

/// 只把 ASCII 大写转小写（多字节 UTF-8/中文保持原字节，长度不变 → 字节偏移仍有效）。
fn ascii_lower_bytes(s: &str) -> Vec<u8> {
    s.bytes().map(|b| b.to_ascii_lowercase()).collect()
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    let n = s.len();
    while i < n && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}
/// 命中位置（字节偏移）前后各取约 80 字节（≈26 个汉字）作为上下文片段。
fn snippet_at(text: &str, mb: usize, ml: usize) -> String {
    let s = floor_char_boundary(text, mb.saturating_sub(80));
    let e = ceil_char_boundary(text, (mb + ml + 80).min(text.len()));
    text[s..e].trim().to_string()
}

/// 在一本书里检索 term，返回该书命中（已截断片段 + 真实总数）。
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
    for (ci, text) in chapters.iter().enumerate() {
        if needs_ci {
            let lower = ascii_lower_bytes(text);
            for mb in finder.find_iter(&lower) {
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
        } else {
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
        }
        if count >= 3000 {
            break;
        }
    }
    if count == 0 {
        return None;
    }
    Some(ShelfBookHits {
        book_id: id_for_path(&book.path).to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        count,
        hits,
    })
}

/// 书架全文检索：ids 为空 → 全部图书；否则只搜选定的几本。多线程 + 字节级匹配 + 内存缓存。
#[tauri::command]
async fn shelf_search(
    state: tauri::State<'_, AppState>,
    term: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<ShelfBookHits>, ()> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    let targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| {
                want.as_ref()
                    .map(|w| w.contains(&id_for_path(&b.path)))
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    };

    // 中文（无 ASCII 字母）时无需大小写折叠，可直接按原字节匹配，省一次复制
    let needs_ci = term.bytes().any(|b| b.is_ascii_alphabetic());
    let term_lower = ascii_lower_bytes(&term);

    let st: &AppState = state.inner();
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

/// 打开（或聚焦）书架全文检索结果窗口，初始查询经 URL 传入。
#[tauri::command]
async fn open_search_window(
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
    let url = format!("search.html?q={}&ids={}", url_encode(&term), url_encode(&ids_csv));
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title("书架全文检索")
        .inner_size(1000.0, 760.0)
        .min_inner_size(520.0, 400.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 用系统默认浏览器，通过百度搜索选中的文字。
#[tauri::command]
async fn web_search(term: String) -> Result<(), String> {
    let t = term.trim();
    if t.is_empty() {
        return Ok(());
    }
    let url = format!("https://www.baidu.com/s?wd={}", url_encode(t));
    open_in_browser(&url).map_err(|e| e.to_string())
}

/// 百分号编码：除非保留字符外一律转义，确保 URL 安全（中文也能正确搜索）。
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

/// 用系统默认程序打开一个 URL（Windows：cmd /C start，隐藏控制台窗口）。
fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------

// ===========================================================================
//  语义检索（向量嵌入）：把段落转成向量，按余弦相似度排序，找“意思相近”的文本
// ===========================================================================

const SEM_VERSION: u32 = 2;
const SEM_MODEL: &str = "bge-small-zh-v1.5";
/// bge 系列检索时给“查询”加的指令前缀（段落不加）。
const SEM_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";

/// 语义模型缓存目录（与探针共用，避免运行时再下载）。
fn sem_model_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("models");
    Some(d)
}

#[derive(Serialize, Deserialize)]
struct SemChunk {
    c: u32,    // 章节序号
    t: String, // 段落文本（展示用）
}
#[derive(Serialize, Deserialize)]
struct SemMeta {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
    chunks: Vec<SemChunk>,
}
/// 内存里的一本书向量数据：vecs 为扁平的 [chunk0 dim 维][chunk1 …]，已 L2 归一化
struct SemData {
    dim: usize,
    vecs: Vec<f32>,
    chunks: Vec<SemChunk>,
}
#[derive(Default, Clone, Serialize)]
struct SemProgress {
    building: bool,
    done: u32,
    total: u32,
    current: String,
    error: String,
}

// 全库 HNSW 近邻索引：把所有书的向量合到一张图里，查询走近邻、毫秒级。
#[derive(Clone, Serialize, Deserialize)]
struct SemPoint(Vec<f32>);
impl instant_distance::Point for SemPoint {
    fn distance(&self, other: &Self) -> f32 {
        let mut s = 0.0f32;
        let n = self.0.len().min(other.0.len());
        for i in 0..n {
            s += self.0[i] * other.0[i];
        }
        1.0 - s // 归一化向量：余弦距离 = 1 - 点积
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct GlobalEntry {
    b: u64, // 书 id
    c: u32, // 章节
    t: String, // 片段
}
#[derive(Serialize, Deserialize)]
struct GlobalMeta {
    v: u32,
    model: String,
    book_ids: Vec<u64>, // 参与建图的书（排序），用于判断是否过期
}
type GlobalHnsw = instant_distance::HnswMap<SemPoint, u32>;
/// 同时建图的段落数上限：超过则不建全库 HNSW（内存吃不消），检索退回并行暴力。
const HNSW_MAX_CHUNKS: usize = 2_000_000;

fn global_hnsw_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("global.hnsw"))
}
fn global_map_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("global.map"))
}
fn global_meta_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("global.json"))
}

/// 当前已建立语义索引的书 id（排序）。
fn indexed_book_ids(state: &AppState) -> Vec<u64> {
    let lib = state.library.lock().unwrap();
    let mut v: Vec<u64> = lib
        .books
        .iter()
        .filter(|b| b.format != "pdf")
        .map(|b| id_for_path(&b.path))
        .filter(|id| sem_meta_path(*id).map(|p| p.exists()).unwrap_or(false))
        .collect();
    v.sort_unstable();
    v
}

fn sem_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("sem");
    Some(d)
}
fn sem_meta_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.json")))
}
fn sem_vec_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.vec")))
}

fn normalize(v: &mut [f32]) {
    let mut n = 0.0f32;
    for x in v.iter() {
        n += x * x;
    }
    let n = n.sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut s = 0.0f32;
    for i in 0..a.len().min(b.len()) {
        s += a[i] * b[i];
    }
    s
}

/// 把一章纯文本切成 ~200–400 字的语义块（按句末标点合并；去标签后无换行，故主要靠标点/长度）。
fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        cur.push(ch);
        count += 1;
        let is_end = matches!(ch, '。' | '！' | '？' | '!' | '?' | '\n' | '…' | '.');
        if (is_end && count >= 200) || count >= 400 {
            let t = cur.trim();
            if t.chars().count() >= 8 {
                chunks.push(t.to_string());
            }
            cur.clear();
            count = 0;
        }
    }
    let t = cur.trim();
    if t.chars().count() >= 8 {
        chunks.push(t.to_string());
    }
    chunks
}

/// 懒加载语义模型（首次会下载到 %LOCALAPPDATA%/ebook-reader/models，约 120MB）。
fn get_embedder(state: &AppState) -> Result<Arc<fastembed::TextEmbedding>, String> {
    {
        let g = state.embedder.lock().unwrap();
        if let Some(m) = g.as_ref() {
            return Ok(m.clone());
        }
    }
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let mut opt =
        InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
    if let Some(d) = sem_model_dir() {
        let _ = std::fs::create_dir_all(&d);
        opt = opt.with_cache_dir(d);
    }
    let m = TextEmbedding::try_new(opt).map_err(|e| format!("加载语义模型失败：{e}"))?;
    let arc = Arc::new(m);
    *state.embedder.lock().unwrap() = Some(arc.clone());
    Ok(arc)
}

/// 该书的语义索引是否已是最新（版本/模型/源文件时间都匹配）。
fn sem_is_fresh(id: u64, mtime: u64) -> bool {
    let Some(p) = sem_meta_path(id) else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    match serde_json::from_str::<SemMeta>(&s) {
        Ok(m) => m.v == SEM_VERSION && m.model == SEM_MODEL && m.mtime == mtime,
        Err(_) => false,
    }
}

/// 为一本书建立语义索引：切块 → 批量嵌入（归一化）→ 落盘（.vec 原始 f32 + .json 元信息）。
fn sem_build_book(
    embedder: &fastembed::TextEmbedding,
    id: u64,
    mtime: u64,
    chapters: &[String],
) -> Result<(), String> {
    use std::io::Write;
    let mut items: Vec<(u32, String)> = Vec::new();
    for (ci, text) in chapters.iter().enumerate() {
        for c in chunk_text(text) {
            items.push((ci as u32, c));
        }
    }
    if items.is_empty() {
        return Ok(());
    }
    let vec_path = sem_vec_path(id).ok_or("无缓存路径")?;
    if let Some(d) = vec_path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let mut vf = std::io::BufWriter::new(std::fs::File::create(&vec_path).map_err(|e| e.to_string())?);
    let mut meta_chunks: Vec<SemChunk> = Vec::with_capacity(items.len());
    let mut dim = 0usize;
    for batch in items.chunks(128) {
        // bge 段落不加前缀，直接用原文
        let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let embs = embedder.embed(inputs, None).map_err(|e| e.to_string())?;
        for (k, (c, t)) in batch.iter().enumerate() {
            let mut v = embs[k].clone();
            normalize(&mut v);
            dim = v.len();
            for x in &v {
                vf.write_all(&x.to_le_bytes()).map_err(|e| e.to_string())?;
            }
            meta_chunks.push(SemChunk { c: *c, t: t.clone() });
        }
    }
    vf.flush().ok();
    let meta = SemMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        mtime,
        dim,
        chunks: meta_chunks,
    };
    let mp = sem_meta_path(id).ok_or("无缓存路径")?;
    std::fs::write(&mp, serde_json::to_string(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 取一本书的向量数据（内存缓存 → 否则读 .vec/.json）。
fn get_sem_data(state: &AppState, id: u64) -> Option<Arc<SemData>> {
    {
        let c = state.sem_cache.lock().unwrap();
        if let Some(d) = c.get(&id) {
            return Some(d.clone());
        }
    }
    let meta: SemMeta =
        serde_json::from_str(&std::fs::read_to_string(sem_meta_path(id)?).ok()?).ok()?;
    let bytes = std::fs::read(sem_vec_path(id)?).ok()?;
    let vecs: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let data = Arc::new(SemData {
        dim: meta.dim,
        vecs,
        chunks: meta.chunks,
    });
    let size = data.vecs.len() * 4;
    {
        let mut c = state.sem_cache.lock().unwrap();
        if state.sem_cache_bytes.load(Ordering::Relaxed) + size <= SEM_CACHE_BUDGET {
            c.insert(id, data.clone());
            state.sem_cache_bytes.fetch_add(size, Ordering::Relaxed);
        }
    }
    Some(data)
}

#[derive(Serialize)]
struct SemHit {
    chapter: u32,
    snippet: String,
    score: f32,
}
#[derive(Serialize)]
struct SemBookHits {
    book_id: String,
    title: String,
    author: String,
    score: f32,
    hits: Vec<SemHit>,
}

/// 在一本书里做语义检索，返回该书最相近的前若干段。
fn sem_search_book(state: &AppState, book: &book::Book, q: &[f32]) -> Option<SemBookHits> {
    let id = id_for_path(&book.path);
    let data = get_sem_data(state, id)?;
    let dim = data.dim;
    if dim == 0 || data.chunks.is_empty() {
        return None;
    }
    let n = data.chunks.len();
    let mut scored: Vec<(f32, usize)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = &data.vecs[i * dim..(i + 1) * dim];
        scored.push((dot(q, v), i));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored[0].0;
    let hits: Vec<SemHit> = scored
        .iter()
        .take(8)
        .map(|(s, i)| {
            let c = &data.chunks[*i];
            SemHit {
                chapter: c.c,
                snippet: c.t.clone(),
                score: *s,
            }
        })
        .collect();
    Some(SemBookHits {
        book_id: id.to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        score: best,
        hits,
    })
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
#[tauri::command]
async fn build_semantic_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    {
        let mut p = state.sem_progress.lock().unwrap();
        if p.building {
            return Err("正在建立索引，请稍候".into());
        }
        *p = SemProgress {
            building: true,
            current: "加载模型…".into(),
            ..Default::default()
        };
    }
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                let mut p = state.sem_progress.lock().unwrap();
                p.building = false;
                p.error = err;
                return;
            }
        };
        let books: Vec<book::Book> = {
            state
                .library
                .lock()
                .unwrap()
                .books
                .iter()
                .filter(|b| b.format != "pdf")
                .filter(|b| {
                    want.as_ref()
                        .map(|w| w.contains(&id_for_path(&b.path)))
                        .unwrap_or(true)
                })
                .cloned()
                .collect()
        };
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.total = books.len() as u32;
        }
        for (i, b) in books.iter().enumerate() {
            {
                let mut p = state.sem_progress.lock().unwrap();
                p.done = i as u32;
                p.current = b.title.clone();
            }
            let id = id_for_path(&b.path);
            let mtime = file_mtime(&b.path);
            if sem_is_fresh(id, mtime) {
                continue;
            }
            if let Some(ch) = get_book_chapters(state.inner(), b) {
                let _ = sem_build_book(&embedder, id, mtime, &ch);
            }
        }
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.done = p.total;
            p.current = "建立全库快速索引（HNSW）…".into();
        }
        let hnsw_err = build_global_hnsw(state.inner()).err().unwrap_or_default();
        let mut p = state.sem_progress.lock().unwrap();
        p.building = false;
        p.current = "完成".into();
        if !hnsw_err.is_empty() {
            p.error = hnsw_err;
        }
    });
    Ok(())
}

/// 用所有已建索引的书，构建一张全库 HNSW 近邻图并落盘（供毫秒级检索）。
fn build_global_hnsw(state: &AppState) -> Result<(), String> {
    use std::io::Write;
    let ids = indexed_book_ids(state);
    if ids.is_empty() {
        return Ok(());
    }
    let mut points: Vec<SemPoint> = Vec::new();
    let mut values: Vec<u32> = Vec::new();
    let mut mapping: Vec<GlobalEntry> = Vec::new();
    for id in &ids {
        let Some(data) = get_sem_data(state, *id) else {
            continue;
        };
        let dim = data.dim;
        if dim == 0 {
            continue;
        }
        for (i, chunk) in data.chunks.iter().enumerate() {
            if mapping.len() >= HNSW_MAX_CHUNKS {
                return Err(format!(
                    "段落数超过 {} 万，未建全库快速索引（检索将用并行暴力）",
                    HNSW_MAX_CHUNKS / 10000
                ));
            }
            let v = data.vecs[i * dim..(i + 1) * dim].to_vec();
            values.push(mapping.len() as u32);
            points.push(SemPoint(v));
            mapping.push(GlobalEntry {
                b: *id,
                c: chunk.c,
                t: chunk.t.clone(),
            });
        }
        // 建图阶段不长期占用逐书缓存，建完即释放
        let _ = state.sem_cache.lock().map(|mut c| c.remove(id));
    }
    if points.is_empty() {
        return Ok(());
    }
    let map: GlobalHnsw = instant_distance::Builder::default().build(points, values);

    let hp = global_hnsw_path().ok_or("无缓存路径")?;
    if let Some(d) = hp.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let mut f = std::io::BufWriter::new(std::fs::File::create(&hp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut f, &map).map_err(|e| e.to_string())?;
    f.flush().ok();
    let mp = global_map_path().ok_or("无缓存路径")?;
    let mut mf = std::io::BufWriter::new(std::fs::File::create(&mp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut mf, &mapping).map_err(|e| e.to_string())?;
    mf.flush().ok();
    let meta = GlobalMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        book_ids: ids,
    };
    std::fs::write(
        global_meta_path().ok_or("无缓存路径")?,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    *state.global_hnsw.lock().unwrap() = None; // 让下次查询重新载入
    Ok(())
}

/// 载入（并缓存）全库 HNSW 图；与当前已索引书集合不一致则视为过期，返回 None。
fn get_global_hnsw(state: &AppState) -> Option<Arc<(GlobalHnsw, Vec<GlobalEntry>, Vec<u64>)>> {
    {
        let g = state.global_hnsw.lock().unwrap();
        if let Some(a) = g.as_ref() {
            if a.2 == indexed_book_ids(state) {
                return Some(a.clone());
            }
        }
    }
    let meta: GlobalMeta =
        serde_json::from_str(&std::fs::read_to_string(global_meta_path()?).ok()?).ok()?;
    if meta.v != SEM_VERSION || meta.model != SEM_MODEL {
        return None;
    }
    if meta.book_ids != indexed_book_ids(state) {
        return None; // 索引集合变了 → 过期，退回暴力
    }
    let map: GlobalHnsw = bincode::deserialize_from(std::io::BufReader::new(
        std::fs::File::open(global_hnsw_path()?).ok()?,
    ))
    .ok()?;
    let mapping: Vec<GlobalEntry> = bincode::deserialize_from(std::io::BufReader::new(
        std::fs::File::open(global_map_path()?).ok()?,
    ))
    .ok()?;
    let arc = Arc::new((map, mapping, meta.book_ids));
    *state.global_hnsw.lock().unwrap() = Some(arc.clone());
    Some(arc)
}

/// 用全库 HNSW 检索（仅在全库查询、且图新鲜时）。返回 None 表示无图/过期，应退回暴力。
fn sem_search_global(state: &AppState, q: &[f32]) -> Option<Vec<SemBookHits>> {
    let g = get_global_hnsw(state)?;
    let titles: HashMap<u64, (String, String)> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .map(|b| (id_for_path(&b.path), (b.title.clone(), b.author.clone())))
            .collect()
    };
    let qp = SemPoint(q.to_vec());
    let mut search = instant_distance::Search::default();
    let mut per: HashMap<u64, Vec<SemHit>> = HashMap::new();
    let mut best: HashMap<u64, f32> = HashMap::new();
    for item in g.0.search(&qp, &mut search).take(400) {
        let gid = *item.value as usize;
        let Some(e) = g.1.get(gid) else { continue };
        let sim = 1.0 - item.distance;
        let v = per.entry(e.b).or_default();
        if v.len() < 8 {
            v.push(SemHit {
                chapter: e.c,
                snippet: e.t.clone(),
                score: sim,
            });
        }
        let bb = best.entry(e.b).or_insert(sim);
        if sim > *bb {
            *bb = sim;
        }
    }
    let mut out: Vec<SemBookHits> = per
        .into_iter()
        .map(|(id, hits)| {
            let (title, author) = titles.get(&id).cloned().unwrap_or_default();
            SemBookHits {
                book_id: id.to_string(),
                title,
                author,
                score: *best.get(&id).unwrap_or(&0.0),
                hits,
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(60);
    Some(out)
}

/// 查询建立语义索引的进度。
#[tauri::command]
fn semantic_status(state: tauri::State<AppState>) -> SemProgress {
    state.sem_progress.lock().unwrap().clone()
}

/// 语义检索：把查询转成向量，在已建索引的图书里按相似度排序返回。
#[tauri::command]
async fn semantic_search(
    state: tauri::State<'_, AppState>,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let embedder = get_embedder(state.inner())?;
    let mut q = embedder
        .embed(vec![format!("{SEM_QUERY_PREFIX}{query}")], None)
        .map_err(|e| e.to_string())?
        .remove(0);
    normalize(&mut q);

    // 全库查询（未限定书）优先走 HNSW 近邻索引（毫秒级）；无图/过期则退回并行暴力
    if ids.is_none() {
        if let Some(res) = sem_search_global(state.inner(), &q) {
            return Ok(res);
        }
    }

    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    let targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| {
                want.as_ref()
                    .map(|w| w.contains(&id_for_path(&b.path)))
                    .unwrap_or(true)
            })
            .filter(|b| sem_meta_path(id_for_path(&b.path)).map(|p| p.exists()).unwrap_or(false))
            .cloned()
            .collect()
    };
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let st: &AppState = state.inner();
    let qref: &[f32] = &q;
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .max(1);
    let chunk_size = targets.len().div_ceil(nthreads).max(1);
    let mut results: Vec<SemBookHits> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for b in chunk {
                        if let Some(h) = sem_search_book(st, b, qref) {
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
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(60);
    Ok(results)
}

/// 余弦相似度
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// 验证嵌入运行时是否可用 + 语义质量。结果写到 %LOCALAPPDATA%/ebook-reader/sem_probe.txt。
fn sem_probe_file() -> std::path::PathBuf {
    let mut d = dirs::cache_dir().unwrap_or(std::env::temp_dir());
    d.push("ebook-reader");
    let _ = std::fs::create_dir_all(&d);
    d.push("sem_probe.txt");
    d
}
fn sem_probe_write(s: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sem_probe_file())
    {
        let _ = writeln!(f, "{s}");
    }
}
fn sem_probe() {
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let _ = std::fs::remove_file(sem_probe_file());
    // 把任何 panic 写进文件（窗口子系统下没有控制台）
    std::panic::set_hook(Box::new(|info| {
        sem_probe_write(&format!("PANIC: {info}"));
    }));
    let run = std::panic::catch_unwind(|| {
        sem_probe_write("starting...");
        let mut opt =
            InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
        if let Some(d) = sem_model_dir() {
            let _ = std::fs::create_dir_all(&d);
            opt = opt.with_cache_dir(d);
        }
        let model = TextEmbedding::try_new(opt).map_err(|e| format!("MODEL ERR: {e}"))?;
        sem_probe_write("model loaded, embedding...");
        let texts = vec![
            format!("{SEM_QUERY_PREFIX}高兴"),
            "开心".to_string(),
            "万念俱灰".to_string(),
            "木头桌子".to_string(),
        ];
        let e = model.embed(texts, None).map_err(|e| format!("EMBED ERR: {e}"))?;
        sem_probe_write(&format!(
            "OK dim={} 高兴~开心={:.3} 高兴~万念俱灰={:.3} 高兴~桌子={:.3}",
            e[0].len(),
            cosine(&e[0], &e[1]),
            cosine(&e[0], &e[2]),
            cosine(&e[0], &e[3]),
        ));
        Ok::<(), String>(())
    });
    match run {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => sem_probe_write(&msg),
        Err(_) => sem_probe_write("CAUGHT PANIC (see above)"),
    }
}

/// 验证 instant-distance（HNSW 近邻索引）API：建图 → 序列化 → 反序列化 → 查询。
fn hnsw_probe() {
    use instant_distance::{Builder, HnswMap, Point, Search};
    #[derive(Clone, Serialize, Deserialize)]
    struct V(Vec<f32>);
    impl Point for V {
        fn distance(&self, other: &Self) -> f32 {
            let mut s = 0.0f32;
            for i in 0..self.0.len().min(other.0.len()) {
                s += self.0[i] * other.0[i];
            }
            1.0 - s // 归一化向量：余弦距离 = 1 - 点积
        }
    }
    let write = |s: &str| {
        let mut d = dirs::cache_dir().unwrap_or(std::env::temp_dir());
        d.push("ebook-reader");
        let _ = std::fs::create_dir_all(&d);
        d.push("hnsw_probe.txt");
        let _ = std::fs::write(&d, s);
    };
    let pts = vec![
        V(vec![1.0, 0.0, 0.0]),
        V(vec![0.0, 1.0, 0.0]),
        V(vec![0.0, 0.0, 1.0]),
        V(vec![0.9, 0.1, 0.0]),
    ];
    let vals: Vec<u32> = vec![10, 11, 12, 13];
    let map: HnswMap<V, u32> = Builder::default().build(pts, vals);
    let bytes = match bincode::serialize(&map) {
        Ok(b) => b,
        Err(e) => {
            write(&format!("SER ERR: {e}"));
            return;
        }
    };
    let map2: HnswMap<V, u32> = match bincode::deserialize(&bytes) {
        Ok(m) => m,
        Err(e) => {
            write(&format!("DE ERR: {e}"));
            return;
        }
    };
    let q = V(vec![0.95, 0.05, 0.0]);
    let mut search = Search::default();
    let mut got = Vec::new();
    for item in map2.search(&q, &mut search).take(2) {
        got.push((*item.value, item.distance));
    }
    write(&format!("OK bytes={} top={:?}", bytes.len(), got));
}

fn main() {
    if std::env::args().any(|a| a == "--sem-probe") {
        sem_probe();
        return;
    }
    if std::env::args().any(|a| a == "--hnsw-probe") {
        hnsw_probe();
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            library: Mutex::new(Library::load()),
            epubs: Mutex::new(HashMap::new()),
            backfilled: std::sync::atomic::AtomicBool::new(false),
            pending_jump: Mutex::new(HashMap::new()),
            text_cache: Mutex::new(HashMap::new()),
            cache_bytes: AtomicUsize::new(0),
            embedder: Mutex::new(None),
            sem_cache: Mutex::new(HashMap::new()),
            sem_cache_bytes: AtomicUsize::new(0),
            sem_progress: Mutex::new(SemProgress::default()),
            global_hnsw: Mutex::new(None),
        })
        // 主窗口（书架）：恢复上次的大小/位置，并在移动/缩放/关闭时记忆
        .setup(|app| {
            spawn_build_index(app.handle().clone()); // 后台建立/更新全文检索索引
            if let Some(win) = app.get_webview_window("main") {
                let geom = { app.state::<AppState>().library.lock().unwrap().main_geom.clone() };
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
                        log(&format!("  -> 200 {} bytes, {}", bytes.len(), mime));
                        tauri::http::Response::builder()
                            .status(200)
                            .header(tauri::http::header::CONTENT_TYPE, mime)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(bytes)
                            .unwrap()
                    }
                    None => {
                        log(&format!("  -> 404 {path}"));
                        tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new())
                            .unwrap()
                    }
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            shelf_books,
            add_books,
            remove_book,
            remove_books,
            open_book,
            book_info,
            book_meta,
            compute_word_counts,
            set_progress,
            add_bookmark,
            remove_bookmark,
            reading_stats,
            add_reading_time,
            search_book,
            set_description,
            web_search,
            open_book_at,
            take_pending_jump,
            shelf_search,
            build_shelf_index,
            open_search_window,
            build_semantic_index,
            semantic_status,
            semantic_search
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 失败");
}
