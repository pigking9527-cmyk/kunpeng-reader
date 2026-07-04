use crate::{book, pdf_support, reader_window_id, AppState};
use serde::Serialize;

/// 修改指定书籍的书名（主窗口图书信息页使用）。
#[tauri::command]
pub(crate) fn set_book_title(
    state: tauri::State<AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("书名不能为空".to_string());
    }
    let mut lib = state.library.lock().unwrap();
    if lib.get(id_num).is_none() {
        return Err("找不到这本书".to_string());
    }
    lib.set_title(id_num, title);
    lib.save();
    Ok(())
}

/// 修改指定书籍简介（主窗口图书信息页使用）。
#[tauri::command]
pub(crate) fn set_book_description(
    state: tauri::State<AppState>,
    id: String,
    description: String,
) -> Result<(), String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    let mut lib = state.library.lock().unwrap();
    if lib.get(id_num).is_none() {
        return Err("找不到这本书".to_string());
    }
    lib.set_description(id_num, description);
    lib.save();
    Ok(())
}

/// 修改指定书籍评分（主窗口图书信息页使用）。
#[tauri::command]
pub(crate) fn set_book_rating(
    state: tauri::State<AppState>,
    id: String,
    rating: f32,
) -> Result<(), String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    let mut lib = state.library.lock().unwrap();
    if lib.get(id_num).is_none() {
        return Err("找不到这本书".to_string());
    }
    lib.set_rating(id_num, rating);
    lib.save();
    Ok(())
}

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

async fn book_meta_for_id(state: &AppState, id: u64) -> Result<BookMeta, String> {
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
    book_meta_for_id(state.inner(), id).await
}

/// 书籍信息（含字数统计），供主窗口选中书籍后打开信息页使用。
#[tauri::command]
pub(crate) async fn book_meta_by_id(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<BookMeta, String> {
    let id_num: u64 = id.parse().map_err(|_| "无效的图书 ID".to_string())?;
    book_meta_for_id(state.inner(), id_num).await
}
