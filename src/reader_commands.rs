use crate::{book, pdf_support, reader_window_id, AppState};
use serde::Serialize;

/// 修改简介（信息弹窗里可编辑）。
#[tauri::command]
pub(crate) fn set_description(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    description: String,
) {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.set_description(id, description);
        lib.save();
    }
}

/// 给当前阅读的书打分（0~5，0.5 刻度，0=清除评分）。
#[tauri::command]
pub(crate) fn set_rating(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    rating: f32,
) {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.set_rating(id, rating);
        lib.save();
    }
}

/// 新增一处高亮/批注，返回该书全部高亮。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn add_highlight(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    chapter: u32,
    start: u32,
    end: u32,
    text: String,
    context: String,
    rects: String,
    color: String,
    note: String,
) -> Vec<book::Highlight> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.add_highlight(
            id,
            book::Highlight {
                chapter,
                start,
                end,
                text,
                context,
                rects,
                color,
                note,
                created_at: book::now_secs(),
            },
        );
        lib.save();
        return lib.highlights(id);
    }
    Vec::new()
}

#[tauri::command]
pub(crate) fn remove_highlight(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    index: usize,
) -> Vec<book::Highlight> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.remove_highlight(id, index);
        lib.save();
        return lib.highlights(id);
    }
    Vec::new()
}

#[tauri::command]
pub(crate) fn set_highlight_note(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    index: usize,
    note: String,
) -> Vec<book::Highlight> {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.set_highlight_note(id, index, note);
        lib.save();
        return lib.highlights(id);
    }
    Vec::new()
}

#[tauri::command]
pub(crate) fn add_bookmark(
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
pub(crate) fn remove_bookmark(
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
pub(crate) struct BookMeta {
    title: String,
    author: String,
    description: String,
    format: String,
    word_count: u64,
    size: u64,   // 文件字节数
    rating: f32, // 用户评分 0~5（0.5 刻度）
}

/// 书籍信息（含字数统计），供阅读页的信息弹窗用。按需调用（不拖慢打开）。
#[tauri::command]
pub(crate) async fn book_meta(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<BookMeta, String> {
    let label = window.label().to_string();
    let id: u64 = label
        .strip_prefix("reader-")
        .and_then(|s| s.parse().ok())
        .ok_or("非阅读窗口")?;

    let (title, mut author, description, format, rating) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id).ok_or("找不到这本书")?;
        (
            b.title.clone(),
            b.author.clone(),
            b.description.clone(),
            b.format.clone(),
            b.rating,
        )
    };

    // 优先用已存的字数（导入/后台已算好），没有才现算并存起来
    let (stored, book_clone) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id).ok_or("找不到这本书")?;
        (b.word_count, b.clone())
    };
    let size = std::fs::metadata(&book_clone.path)
        .map(|m| m.len())
        .unwrap_or(0);
    let word_count = if stored > 0 {
        stored
    } else {
        // PDF 走专门的取文本计数；其它交给 compute_word_count
        let wc = if format == "pdf" {
            pdf_support::pdf_word_count(&book_clone.path)
        } else {
            book::compute_word_count(&book_clone) // 不持锁，慢操作
        };
        if wc > 0 {
            let mut lib = state.library.lock().unwrap();
            lib.set_word_count(id, wc);
            lib.save();
        }
        wc
    };

    // PDF 作者：库里还没有就从 PDF 元数据补一次并存起来
    if format == "pdf" && author.trim().is_empty() {
        let a = pdf_support::pdf_author(&book_clone.path);
        if !a.trim().is_empty() {
            author = a.clone();
            let mut lib = state.library.lock().unwrap();
            if let Some(b) = lib.books.iter_mut().find(|b| b.id == id) {
                b.author = a;
            }
            lib.save();
        }
    }

    Ok(BookMeta {
        title,
        author,
        description,
        format,
        word_count,
        size,
        rating,
    })
}
