use crate::{
    book, data_migration, epub_runtime, html_sanitize, log, report_save_error, search,
    search_index, window_commands, AppState, RES_BASE,
};
use book::Library;
use presentation::{project_book_reading_timeline, title_initial, BookReadingTimeline};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;
use tauri::{Emitter, Manager};

mod presentation;

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
    reading_seconds: u64,
    missing: bool, // 源文件是否已找不到
    path: String,  // 文件完整路径（用于"按存储目录"排序）
    rating: f32,   // 用户评分 0~5（0.5 刻度，用于书架按评分过滤）
    tags: Vec<String>,
    model_tags: Vec<String>,
    collections: Vec<String>,
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
pub(crate) struct BookListDto {
    id: String,
    name: String,
    description: String,
    cover_book_id: String,
    cover: Option<String>,
    book_ids: Vec<String>,
    reviews: HashMap<String, String>,
    saved: bool,
}

fn booklist_snapshot(lib: &Library) -> Vec<BookListDto> {
    lib.booklists
        .iter()
        .map(|list| {
            let cover_book = lib.get(list.cover_book_id);
            BookListDto {
                id: list.id.clone(),
                name: list.name.clone(),
                description: list.description.clone(),
                cover_book_id: list.cover_book_id.to_string(),
                cover: cover_book.and_then(|book| {
                    book.cover
                        .as_ref()
                        .map(|_| format!("{RES_BASE}/cover/{}?v={}", book.id, book.cover_ver))
                }),
                book_ids: list.book_order.iter().map(u64::to_string).collect(),
                reviews: list
                    .reviews
                    .iter()
                    .map(|(id, review)| (id.to_string(), review.clone()))
                    .collect(),
                saved: list.saved,
            }
        })
        .collect()
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
        reading_seconds: b.reading_seconds,
        // 不在书架首屏为每本书做磁盘 exists() 检查；慢盘/移动盘/同步盘会偶发卡住启动。
        // 真正打开失败时仍会提示用户重新定位。
        missing: false,
        path: b.path.to_string_lossy().into_owned(),
        rating: b.rating,
        tags: b.tags.clone(),
        model_tags: b.model_tags.clone(),
        collections: b.collections.clone(),
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

/// 文件大小只在用户选择“按大小排序”时按需读取。大型书架可能位于移动盘、
/// 网络盘或同步盘，不能把数百次 metadata() 访问塞进启动期书单快照。
#[tauri::command]
pub(crate) async fn book_file_sizes(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, u64>, ()> {
    let targets: Vec<(String, std::path::PathBuf)> = {
        let library = state.library.lock().map_err(|_| ())?;
        library
            .books
            .iter()
            .map(|book| (book.id.to_string(), book.path.clone()))
            .collect()
    };
    tauri::async_runtime::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|(id, path)| {
                let bytes = std::fs::metadata(path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                (id, bytes)
            })
            .collect()
    })
    .await
    .map_err(|_| ())
}

/// 设置一册图书的标签与收藏夹。收藏夹仅是逻辑归类，不会移动或删除文件。
#[tauri::command]
pub(crate) fn set_book_organization(
    state: tauri::State<AppState>,
    id: String,
    tags: Vec<String>,
    collections: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    let id = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    let (changed, result) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        if lib.get(id).is_none() {
            return Err("找不到这本书".to_string());
        }
        let changed = lib.set_organization(id, tags, collections);
        if changed {
            lib.save()?;
        }
        (changed, snapshot(&lib))
    };
    if changed {
        data_migration::persist_book_organization_entities(
            state.inner(),
            &HashSet::from([id]),
            true,
            true,
        )?;
    }
    Ok(result)
}

/// 批量追加标签或收藏夹。与 set_book_organization 不同，它不会覆盖每本书原有的分类。
#[tauri::command]
pub(crate) fn add_books_organization(
    state: tauri::State<AppState>,
    ids: Vec<String>,
    field: String,
    names: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    if !matches!(field.as_str(), "tag" | "collection") {
        return Err("无效的分类类型".to_string());
    }
    let ids = ids
        .into_iter()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "无效的图书 ID".to_string())
        })
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    if ids.is_empty() {
        return Err("请先选择图书".to_string());
    }
    let (changed, result) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let changed = lib.add_organization_to_books(&ids, &field, names);
        if changed {
            lib.save()?;
        }
        (changed, snapshot(&lib))
    };
    if changed {
        data_migration::persist_book_organization_entities(
            state.inner(),
            &ids,
            field == "tag",
            field == "collection",
        )?;
    }
    Ok(result)
}

/// 重命名全书架范围内的一个标签或收藏夹。
#[tauri::command]
pub(crate) fn rename_book_organization(
    state: tauri::State<AppState>,
    kind: String,
    name: String,
    new_name: String,
) -> Result<Vec<BookDto>, String> {
    if !matches!(kind.as_str(), "tag" | "collection") {
        return Err("无效的分类类型".to_string());
    }
    let (changed_ids, result) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let before = lib
            .books
            .iter()
            .map(|book| (book.id, (book.tags.clone(), book.collections.clone())))
            .collect::<HashMap<_, _>>();
        if lib.rename_organization(&kind, &name, new_name) {
            lib.save()?;
        }
        let changed_ids = lib
            .books
            .iter()
            .filter(|book| {
                before.get(&book.id).is_some_and(|(tags, collections)| {
                    *tags != book.tags || *collections != book.collections
                })
            })
            .map(|book| book.id)
            .collect::<HashSet<_>>();
        (changed_ids, snapshot(&lib))
    };
    data_migration::persist_book_organization_entities(
        state.inner(),
        &changed_ids,
        kind == "tag",
        kind == "collection",
    )?;
    Ok(result)
}

/// 删除全书架范围内的一个标签或收藏夹；仅移除关联，不会删除图书。
#[tauri::command]
pub(crate) fn delete_book_organization(
    state: tauri::State<AppState>,
    kind: String,
    name: String,
) -> Result<Vec<BookDto>, String> {
    if !matches!(kind.as_str(), "tag" | "collection") {
        return Err("无效的分类类型".to_string());
    }
    let deleted_booklist_id = if kind == "collection" {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        lib.reconcile_booklists();
        lib.booklists
            .iter()
            .find(|list| list.name == name)
            .map(|list| list.id.clone())
    } else {
        None
    };
    let (changed_ids, result) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let before = lib
            .books
            .iter()
            .map(|book| (book.id, (book.tags.clone(), book.collections.clone())))
            .collect::<HashMap<_, _>>();
        if lib.delete_organization(&kind, &name) {
            lib.save()?;
        }
        let changed_ids = lib
            .books
            .iter()
            .filter(|book| {
                before.get(&book.id).is_some_and(|(tags, collections)| {
                    *tags != book.tags || *collections != book.collections
                })
            })
            .map(|book| book.id)
            .collect::<HashSet<_>>();
        (changed_ids, snapshot(&lib))
    };
    data_migration::persist_book_organization_entities(
        state.inner(),
        &changed_ids,
        kind == "tag",
        kind == "collection",
    )?;
    if let Some(id) = deleted_booklist_id {
        crate::booklist_sync::tombstone_booklist(state.inner(), &id)?;
    }
    Ok(result)
}

/// 独立书单页面所需的简介、封面和手动顺序。
#[tauri::command]
pub(crate) fn list_booklists(state: tauri::State<AppState>) -> Result<Vec<BookListDto>, String> {
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    lib.reconcile_booklists();
    Ok(booklist_snapshot(&lib))
}

#[tauri::command]
pub(crate) fn update_booklist(
    state: tauri::State<AppState>,
    name: String,
    description: String,
    cover_book_id: String,
    book_ids: Vec<String>,
    reviews: Option<HashMap<String, String>>,
) -> Result<Vec<BookListDto>, String> {
    let cover_book_id = cover_book_id.parse::<u64>().unwrap_or(0);
    let book_order = book_ids
        .into_iter()
        .filter_map(|id| id.parse::<u64>().ok())
        .collect::<Vec<_>>();
    let reviews = reviews.map(|reviews| {
        reviews
            .into_iter()
            .filter_map(|(id, review)| id.parse::<u64>().ok().map(|id| (id, review)))
            .collect()
    });
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    if !lib
        .booklists
        .iter()
        .any(|list| list.name.eq_ignore_ascii_case(name.trim()))
    {
        lib.reconcile_booklists();
    }
    lib.reconcile_booklists();
    if !lib
        .booklists
        .iter()
        .any(|list| list.name.eq_ignore_ascii_case(name.trim()))
    {
        return Err("找不到这个书单".to_string());
    }
    let list_id = lib
        .booklists
        .iter()
        .find(|list| list.name.eq_ignore_ascii_case(name.trim()))
        .map(|list| list.id.clone())
        .ok_or("找不到书单")?;
    if lib.update_booklist(&name, description, cover_book_id, book_order, reviews) {
        lib.save()?;
    }
    let snapshot = booklist_snapshot(&lib);
    drop(lib);
    crate::booklist_sync::persist_booklist(state.inner(), &list_id)?;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn create_booklist(
    state: tauri::State<AppState>,
    name: String,
) -> Result<Vec<BookListDto>, String> {
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let list_id = lib.create_booklist(name).ok_or("书单名称不能为空")?;
    lib.save()?;
    let snapshot = booklist_snapshot(&lib);
    drop(lib);
    crate::booklist_sync::persist_booklist(state.inner(), &list_id)?;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn delete_booklist(
    state: tauri::State<AppState>,
    id: String,
) -> Result<Vec<BookListDto>, String> {
    let (changed_ids, snapshot) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let (_name, changed_ids) = lib.delete_booklist(id.trim()).ok_or("找不到书单")?;
        lib.save()?;
        (
            changed_ids.into_iter().collect::<HashSet<_>>(),
            booklist_snapshot(&lib),
        )
    };
    if !changed_ids.is_empty() {
        data_migration::persist_book_organization_entities(
            state.inner(),
            &changed_ids,
            false,
            true,
        )?;
    }
    crate::booklist_sync::tombstone_booklist(state.inner(), id.trim())?;
    Ok(snapshot)
}

/// Save a model-selected list into the same collection/booklist model as
/// manually created lists. The model is never trusted with a title outside the
/// locally retrieved candidate IDs because the UI only submits validated IDs.
#[tauri::command]
pub(crate) fn save_recommended_booklist(
    state: tauri::State<AppState>,
    name: String,
    description: String,
    book_ids: Vec<String>,
    reviews: HashMap<String, String>,
) -> Result<Vec<BookListDto>, String> {
    let mut seen = HashSet::new();
    let order = book_ids
        .into_iter()
        .filter_map(|id| id.parse::<u64>().ok())
        .filter(|id| seen.insert(*id))
        .collect::<Vec<_>>();
    let selected = order.iter().copied().collect::<HashSet<_>>();
    if selected.is_empty() {
        return Err("请至少保留一本推荐图书".to_string());
    }
    let (changed_ids, list_id, snapshot) = {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        let list_id = lib
            .create_booklist(name.clone())
            .ok_or("书单名称不能为空")?;
        let list_name = lib
            .booklists
            .iter()
            .find(|list| list.id == list_id)
            .map(|list| list.name.clone())
            .ok_or("找不到新建书单")?;
        let before = lib
            .books
            .iter()
            .filter(|book| selected.contains(&book.id))
            .map(|book| (book.id, book.collections.clone()))
            .collect::<HashMap<_, _>>();
        lib.add_organization_to_books(&selected, "collection", vec![list_name.clone()]);
        let normalized_reviews = reviews
            .into_iter()
            .filter_map(|(id, review)| id.parse::<u64>().ok().map(|id| (id, review)))
            .collect::<BTreeMap<_, _>>();
        lib.update_booklist(&list_name, description, 0, order, Some(normalized_reviews));
        lib.save()?;
        let changed_ids = lib
            .books
            .iter()
            .filter(|book| {
                before
                    .get(&book.id)
                    .is_some_and(|old| *old != book.collections)
            })
            .map(|book| book.id)
            .collect::<HashSet<_>>();
        (changed_ids, list_id, booklist_snapshot(&lib))
    };
    data_migration::persist_book_organization_entities(state.inner(), &changed_ids, false, true)?;
    crate::booklist_sync::persist_booklist(state.inner(), &list_id)?;
    Ok(snapshot)
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
    let library = state.library.lock().unwrap();
    let book = library.get(id_num).ok_or("图书不存在")?;
    let stats = state.stats.lock().unwrap();
    Ok(project_book_reading_timeline(book, &stats.map))
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
    #[serde(default)]
    anchor: Option<reader_core::ReadingAnchor>,
    #[serde(default)]
    sequence: u64,
}

#[tauri::command]
pub(crate) async fn set_progress(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: SetProgressRequest,
) -> Result<(), String> {
    let SetProgressRequest {
        progress,
        chapter,
        frac,
        anchor,
        sequence,
    } = request;
    let id = window_commands::reader_window_id(&window).ok_or_else(|| {
        let label = window.label();
        crate::runtime_support::log(&format!(
            "set_progress rejected: invalid reader window label={label}"
        ));
        "无法识别当前阅读窗口".to_string()
    })?;
    let anchor_offset = anchor.as_ref().map(|value| value.text_offset);
    let mut lib = state.library.lock().unwrap();
    let mut changed = lib.set_position_with_anchor(id, progress, chapter, frac, anchor);
    let handoff_content_id = lib
        .books
        .iter()
        .find(|book| book.id == id)
        .map(|book| book.content_id.clone())
        .unwrap_or_default();
    if let Some(book) = lib.books.iter_mut().find(|b| b.id == id) {
        if book.format == "epub" && book.chapter_index_version != epub_runtime::CACHE_VERSION {
            book.chapter_index_version = epub_runtime::CACHE_VERSION;
            changed = true;
        }
    }
    if changed {
        lib.save().map_err(|error| {
            crate::runtime_support::log(&format!(
                "set_progress save failed id={id} seq={sequence} chapter={chapter} frac={frac:.6} progress={progress:.4} anchor_offset={}: {error}",
                anchor_offset
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
            format!("保存阅读位置失败：{error}")
        })?;
    }
    drop(lib);
    state.with_db_write("set_progress_reading_handoff", |db| {
        crate::private_sync::record_reading_handoff(db, &handoff_content_id)
    })?;
    crate::runtime_support::log(&format!(
        "set_progress ok id={id} seq={sequence} chapter={chapter} frac={frac:.6} progress={progress:.4} anchor_offset={} changed={changed}",
        anchor_offset
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string())
    ));
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
        crate::with_thread_background_priority(|| {
            let started = Instant::now();
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
            crate::log(&format!(
                "fingerprint-fill start background pending={}",
                pending.len()
            ));
            let mut changed = false;
            for (id, path, need_fingerprint, need_content_id) in pending {
                // 指纹计算会读取整本文件。阅读期间宁可延后，也不能和章节加载争抢磁盘。
                while window_commands::any_reader_window_open(&app) {
                    crate::log("fingerprint-fill paused: reader window open");
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
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
            crate::log(&format!(
                "fingerprint-fill end elapsed_ms={} changed={changed}",
                started.elapsed().as_millis()
            ));
            // The full-text index relies on content IDs to avoid rehashing
            // every source file. Start it only after this migration finishes;
            // the former fixed 15-second delay could run both full-library
            // scans concurrently and freeze otherwise unrelated UI actions.
            search::spawn_build_index(app.clone(), false);
        });
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
    fn navigation_requests_deserialize_as_one_object() {
        let progress: SetProgressRequest = serde_json::from_value(serde_json::json!({
            "progress": 42.5,
            "chapter": 6,
            "frac": 0.25
        }))
        .unwrap();
        assert_eq!(progress.chapter, 6);
        assert_eq!(progress.frac, 0.25);
        assert_eq!(progress.sequence, 0);

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
