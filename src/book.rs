// ============================================================================
//  book.rs —— 图书馆（持久化）、图书元信息、封面缩略图、文本解码
// ============================================================================

use reader_core::{ReadingAnchor, ReadingPosition};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub use reader_core::{Bookmark, Highlight, ProgressTimelineEntry};

fn organization_name_key(value: &str) -> String {
    reader_core::domain::organization_name_key(value)
}

/// 书架上的一本书。
#[derive(Clone, Serialize, Deserialize)]
pub struct Book {
    #[serde(default)]
    pub id: u64, // 稳定 id（导入时分配，之后即使文件移动也不变；0=旧数据待迁移）
    #[serde(default)]
    pub fingerprint: u64, // 内容指纹（大小+首尾采样），用于"换了位置的同一本书"去重/重定位
    #[serde(default)]
    pub content_id: String, // 跨设备稳定身份：完整文件 SHA-256；本机路径不参与同步主键
    pub path: PathBuf,
    pub title: String,
    pub format: String,
    #[serde(default)]
    pub cover: Option<PathBuf>, // 封面缩略图缓存路径（EPUB）
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String, // 简介（EPUB dc:description），搜索用
    #[serde(default)]
    pub added_at: u64, // 导入时间（unix 秒）
    #[serde(default)]
    pub last_read_at: u64, // 最近阅读时间（unix 秒）
    #[serde(default)]
    pub progress: f32, // 阅读进度 0~100（用于书架显示/排序/统计）
    #[serde(default)]
    pub resume_chapter: u32, // 续读：上次所在章节
    #[serde(default)]
    pub resume_frac: f32, // 续读：上次章内比例 0~1
    /// 独立于排版的正文锚点；旧版字段保留用于兼容与无法取 DOM 锚点的文档。
    #[serde(default)]
    pub resume_position: Option<ReadingPosition>,
    #[serde(default)]
    pub chapter_index_version: u32, // 章节索引版本：EPUB 大章拆分后用于区分旧物理章号/新虚拟章号
    #[serde(default)]
    pub meta_done: bool, // 元数据（作者/简介）是否已回填过，避免每次启动重读
    #[serde(default)]
    pub word_count: u64, // 字数（0 表示尚未统计）
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    #[serde(default)]
    pub reading_seconds: u64, // 累计阅读时长（秒）
    #[serde(default)]
    pub words_read: u64, // 累计"真正读过"的字数（停留若干秒+逐页翻过的页才计入）
    #[serde(default)]
    pub finished_at: u64, // 首次读完（进度≥99%）的 unix 秒，0=未读完
    #[serde(default)]
    pub progress_history: Vec<ProgressTimelineEntry>, // 单本书每日最后阅读位置摘要
    #[serde(default)]
    pub cover_ver: u64, // 封面版本号：换封面时 +1，用于刷新前端缓存（避免每次渲染都去 stat 封面文件）
    #[serde(default)]
    pub rating: f32, // 用户评分 0~5，0.5 为刻度（0=未评分）
    #[serde(default)]
    pub tags: Vec<String>, // 多个标签；用于书架多维筛选
    /// 由大模型生成的独立书目标签。它绝不覆盖 `tags` 中的用户手工标签，
    /// 可以作为可选同步实体在多端复用。
    #[serde(default)]
    pub model_tags: Vec<String>,
    #[serde(default)]
    pub collections: Vec<String>, // 多个收藏夹；不会改变图书在“全部书架”中的位置
}

/// 当前 unix 时间戳（秒）。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn normalize_organization_names(values: Vec<String>) -> Vec<String> {
    reader_core::domain::normalize_names(values)
}

fn local_day_key(secs: u64) -> u32 {
    use chrono::{Datelike, Local, TimeZone};
    Local
        .timestamp_opt(secs as i64, 0)
        .single()
        .map(|time| time.year() as u32 * 10000 + time.month() * 100 + time.day())
        .unwrap_or(0)
}

/// 合并并压缩每日位置摘要：同一天只保留时间更晚的那条，最多保留十年。
pub(crate) fn merge_daily_progress_history(
    target: &mut Vec<ProgressTimelineEntry>,
    incoming: &[ProgressTimelineEntry],
) {
    let mut days = std::collections::BTreeMap::<u32, ProgressTimelineEntry>::new();
    for entry in target.iter().chain(incoming.iter()) {
        let day = local_day_key(entry.at);
        if days.get(&day).is_none_or(|old| entry.at >= old.at) {
            days.insert(day, entry.clone());
        }
    }
    const MAX_DAILY_PROGRESS_HISTORY: usize = 3650;
    let skip = days.len().saturating_sub(MAX_DAILY_PROGRESS_HISTORY);
    *target = days.into_values().skip(skip).collect();
}

impl Book {
    /// 导入一个文件：EPUB 顺便读出书名、提取封面缩略图（只在导入时做一次）。
    pub fn prepare(path: PathBuf) -> Self {
        let ext = ext_lower(&path);
        if ext == "epub" {
            if let Some(book) = prepare_epub(&path) {
                return book;
            }
        } else if matches!(ext.as_str(), "mobi" | "azw3" | "azw") {
            if let Some(book) = prepare_mobi(&path) {
                return book;
            }
        }
        Self::from_path(path)
    }

    pub fn from_path(path: PathBuf) -> Self {
        let title = title_from_path(&path);
        let format = ext_lower(&path);
        // txt/md 导入时顺手算好字数（epub/pdf 不在这里算）
        let word_count = if format == "epub" || format == "pdf" {
            0
        } else {
            std::fs::read(&path)
                .ok()
                .map(|b| {
                    normalize_text(&decode_bytes(&b))
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .count() as u64
                })
                .unwrap_or(0)
        };
        Self {
            id: id_for_path(&path),
            fingerprint: compute_fingerprint(&path),
            content_id: compute_content_id(&path),
            path,
            title,
            format,
            cover: None,
            author: String::new(),
            description: String::new(),
            added_at: now_secs(),
            last_read_at: 0,
            progress: 0.0,
            resume_chapter: 0,
            resume_frac: 0.0,
            resume_position: None,
            chapter_index_version: 0,
            meta_done: true, // 新建/txt 无需回填
            word_count,
            bookmarks: Vec::new(),
            highlights: Vec::new(),
            reading_seconds: 0,
            words_read: 0,
            finished_at: 0,
            progress_history: Vec::new(),
            cover_ver: 0,
            rating: 0.0,
            tags: Vec::new(),
            model_tags: Vec::new(),
            collections: Vec::new(),
        }
    }
}

/// 统计 HTML 正文的非空白字符数（粗略去标签）。
pub(crate) fn count_text_chars(html: &str) -> usize {
    let mut count = 0;
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag && !c.is_whitespace() => count += 1,
            _ => {}
        }
    }
    count
}

/// 计算一本书的字数（非空白字符数）。会打开文件，较慢，宜在后台/导入时调用。
pub fn compute_word_count(book: &Book) -> u64 {
    if book.format == "pdf" {
        return 0; // PDF 不统计字数
    }
    if matches!(book.format.as_str(), "mobi" | "azw3" | "azw") {
        let p = book.path.clone();
        return std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            mobi::Mobi::from_path(&p)
                .ok()
                .map(|m| count_text_chars(&m.content_as_string_lossy()) as u64)
                .unwrap_or(0)
        }))
        .unwrap_or(0);
    }
    if book.format == "epub" {
        if let Ok(mut doc) = epub::doc::EpubDoc::new(&book.path) {
            let spine: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
            let mut n = 0usize;
            for idref in spine {
                if let Some((s, _)) = doc.get_resource_str(&idref) {
                    n += count_text_chars(&s);
                }
            }
            return n as u64;
        }
        0
    } else {
        match std::fs::read(&book.path) {
            Ok(b) => normalize_text(&decode_bytes(&b))
                .chars()
                .filter(|c| !c.is_whitespace())
                .count() as u64,
            Err(_) => 0,
        }
    }
}

/// 阅读窗口的几何信息（逻辑像素）：位置 + 大小 + 是否最大化。
/// 全局共享——下次打开任意一本书都恢复到上次关闭阅读窗口时的大小与位置。
#[derive(Clone, Serialize, Deserialize)]
pub struct WinGeom {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WinGeom {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 880.0,
            h: 760.0,
            maximized: false,
        }
    }
}

/// 收藏夹的展示元数据。成员关系仍存放在 Book.collections 中，以保持现有同步协议兼容。
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct BookList {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cover_book_id: u64,
    #[serde(default)]
    pub book_order: Vec<u64>,
}

/// 整个书架，序列化成 JSON 持久化。
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Library {
    pub books: Vec<Book>,
    #[serde(default)]
    pub booklists: Vec<BookList>,
    #[serde(default)]
    pub reader_geom: Option<WinGeom>, // 上次 EPUB 阅读窗口的大小/位置
    #[serde(default)]
    pub reader_geom_pdf: Option<WinGeom>, // 上次 PDF 阅读窗口的大小/位置（与 EPUB 分开记）
    #[serde(default)]
    pub main_geom: Option<WinGeom>, // 上次主窗口（书架）的大小/位置
    #[serde(default)]
    pub auto_import_dir: Option<String>, // 旧：单个自动导入目录（已迁移到 auto_import_dirs）
    #[serde(default)]
    pub auto_import_dirs: Vec<String>, // 自动导入目录列表（持续监测并把其中的电子书加入书架）
    #[serde(default)]
    pub auto_import_enabled: bool, // 是否开启自动导入
}

impl Library {
    /// 添加一本书。已存在（同路径或同内容指纹）则不重复添加；
    /// 指纹相同但路径变了（同一本书被移动后重新导入）→ 更新路径，保留进度/书签/高亮。
    /// 插入锁外已解析好的书籍。调用方可先在锁外做 Book::prepare，锁内只做去重/重定位。
    pub fn add_prepared(&mut self, book: Book) -> bool {
        if self.books.iter().any(|b| b.path == book.path) {
            return false;
        }
        if !book.content_id.is_empty() {
            if let Some(existing) = self
                .books
                .iter_mut()
                .find(|b| b.content_id == book.content_id)
            {
                existing.path = book.path;
                return true;
            }
        }
        if book.fingerprint != 0 {
            if let Some(existing) = self
                .books
                .iter_mut()
                .find(|b| b.fingerprint == book.fingerprint)
            {
                existing.path = book.path;
                return true;
            }
        }
        self.books.push(book);
        true
    }

    pub fn remove(&mut self, id: u64) {
        self.books.retain(|b| b.id != id);
        for list in &mut self.booklists {
            list.book_order.retain(|book_id| *book_id != id);
            if list.cover_book_id == id {
                list.cover_book_id = list.book_order.first().copied().unwrap_or(0);
            }
        }
    }

    pub fn get(&self, id: u64) -> Option<&Book> {
        self.books.iter().find(|b| b.id == id)
    }

    /// 把某本书重新指向一个新文件（文件丢失后用户重新定位）。返回是否成功。
    pub fn relocate(&mut self, id: u64, new_path: PathBuf) -> bool {
        let fp = compute_fingerprint(&new_path);
        let content_id = compute_content_id(&new_path);
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.path = new_path;
            if fp != 0 {
                b.fingerprint = fp;
            }
            if !content_id.is_empty() {
                b.content_id = content_id;
            }
            return true;
        }
        false
    }

    /// 标记某本书“刚刚被打开”（更新最近阅读时间）。
    pub fn mark_read(&mut self, id: u64) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.last_read_at = now_secs();
        }
    }

    pub fn set_description(&mut self, id: u64, desc: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.description = crate::html_sanitize::html_to_plain_text(&desc);
        }
    }

    pub fn set_title(&mut self, id: u64, title: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.title = title;
        }
    }

    pub fn set_rating(&mut self, id: u64, rating: f32) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.rating = rating.clamp(0.0, 5.0);
        }
    }

    /// 设置一本书的标签与收藏夹。名称在本地与同步载荷中都保持规范、去重。
    pub fn set_organization(
        &mut self,
        id: u64,
        tags: Vec<String>,
        collections: Vec<String>,
    ) -> bool {
        let tags = normalize_organization_names(tags);
        let collections = normalize_organization_names(collections);
        let changed = if let Some(book) = self.books.iter_mut().find(|book| book.id == id) {
            let changed = book.tags != tags || book.collections != collections;
            book.tags = tags;
            book.collections = collections;
            changed
        } else {
            false
        };
        if changed {
            self.reconcile_booklists();
        }
        changed
    }

    /// Save model-generated catalogue labels separately from the reader's own
    /// organization. `false` means the incoming normalized labels were
    /// identical and therefore do not need a sync write.
    pub fn set_model_tags(&mut self, id: u64, tags: Vec<String>) -> bool {
        let tags = normalize_organization_names(tags);
        if let Some(book) = self.books.iter_mut().find(|book| book.id == id) {
            if book.model_tags != tags {
                book.model_tags = tags;
                return true;
            }
        }
        false
    }

    /// 为多本图书追加标签或收藏夹。此操作只增加成员关系，不会覆盖已有分类，
    /// 因而适合书架的批量“添加标签 / 加入收藏书单”。
    pub fn add_organization_to_books(
        &mut self,
        ids: &HashSet<u64>,
        kind: &str,
        names: Vec<String>,
    ) -> bool {
        if ids.is_empty() || !matches!(kind, "tag" | "collection") {
            return false;
        }
        let names = normalize_organization_names(names);
        if names.is_empty() {
            return false;
        }
        let mut changed = false;
        for book in &mut self.books {
            if !ids.contains(&book.id) {
                continue;
            }
            let values = if kind == "tag" {
                &mut book.tags
            } else {
                &mut book.collections
            };
            let mut next = values.clone();
            next.extend(names.iter().cloned());
            let next = normalize_organization_names(next);
            if *values != next {
                *values = next;
                changed = true;
            }
        }
        if changed && kind == "collection" {
            self.reconcile_booklists();
        }
        changed
    }

    /// 管理全书架范围内的一个标签或收藏夹：重命名时同时更新所有关联图书。
    pub fn rename_organization(&mut self, kind: &str, from: &str, to: String) -> bool {
        let from = organization_name_key(from);
        let to = normalize_organization_names(vec![to]).into_iter().next();
        let Some(to) = to else {
            return false;
        };
        if from.is_empty() {
            return false;
        }
        let mut changed = false;
        for book in &mut self.books {
            let values = if kind == "tag" {
                &mut book.tags
            } else {
                &mut book.collections
            };
            let replaced = values
                .iter()
                .map(|name| {
                    if organization_name_key(name) == from {
                        to.clone()
                    } else {
                        name.clone()
                    }
                })
                .collect::<Vec<_>>();
            let normalized = normalize_organization_names(replaced);
            if *values != normalized {
                *values = normalized;
                changed = true;
            }
        }
        if changed && kind == "collection" {
            if let Some(existing) = self
                .booklists
                .iter_mut()
                .find(|list| organization_name_key(&list.name) == from)
            {
                existing.name = to;
            }
            self.reconcile_booklists();
        }
        changed
    }

    /// 从所有图书中移除一个标签或收藏夹；不删除图书本身。
    pub fn delete_organization(&mut self, kind: &str, name: &str) -> bool {
        let name = organization_name_key(name);
        if name.is_empty() {
            return false;
        }
        let mut changed = false;
        for book in &mut self.books {
            let values = if kind == "tag" {
                &mut book.tags
            } else {
                &mut book.collections
            };
            let next = values
                .iter()
                .filter(|value| organization_name_key(value) != name)
                .cloned()
                .collect::<Vec<_>>();
            if *values != next {
                *values = next;
                changed = true;
            }
        }
        if changed && kind == "collection" {
            self.booklists
                .retain(|list| organization_name_key(&list.name) != name);
            self.reconcile_booklists();
        }
        changed
    }

    /// 让书单元数据与图书成员关系保持一致，同时保留用户手动排列的已有成员。
    pub fn reconcile_booklists(&mut self) {
        let mut names = Vec::<String>::new();
        let mut seen = HashSet::new();
        for book in &self.books {
            for name in &book.collections {
                let key = organization_name_key(name);
                if !key.is_empty() && seen.insert(key) {
                    names.push(name.clone());
                }
            }
        }
        self.booklists.retain(|list| {
            names
                .iter()
                .any(|name| organization_name_key(name) == organization_name_key(&list.name))
        });
        for name in names {
            let key = organization_name_key(&name);
            if !self
                .booklists
                .iter()
                .any(|list| organization_name_key(&list.name) == key)
            {
                self.booklists.push(BookList {
                    name: name.clone(),
                    ..BookList::default()
                });
            }
            let members = self
                .books
                .iter()
                .filter(|book| {
                    book.collections
                        .iter()
                        .any(|value| organization_name_key(value) == key)
                })
                .map(|book| book.id)
                .collect::<Vec<_>>();
            if let Some(list) = self
                .booklists
                .iter_mut()
                .find(|list| organization_name_key(&list.name) == key)
            {
                list.name = name;
                list.book_order.retain(|id| members.contains(id));
                for id in members {
                    if !list.book_order.contains(&id) {
                        list.book_order.push(id);
                    }
                }
                if !list.book_order.contains(&list.cover_book_id) {
                    list.cover_book_id = list.book_order.first().copied().unwrap_or(0);
                }
            }
        }
    }

    pub fn update_booklist(
        &mut self,
        name: &str,
        description: String,
        cover_book_id: u64,
        book_order: Vec<u64>,
    ) -> bool {
        self.reconcile_booklists();
        let key = organization_name_key(name);
        let Some(list) = self
            .booklists
            .iter_mut()
            .find(|list| organization_name_key(&list.name) == key)
        else {
            return false;
        };
        let members = self
            .books
            .iter()
            .filter(|book| {
                book.collections
                    .iter()
                    .any(|value| organization_name_key(value) == key)
            })
            .map(|book| book.id)
            .collect::<HashSet<_>>();
        let mut seen = HashSet::new();
        let mut order = book_order
            .into_iter()
            .filter(|id| members.contains(id) && seen.insert(*id))
            .collect::<Vec<_>>();
        for id in &list.book_order {
            if members.contains(id) && seen.insert(*id) {
                order.push(*id);
            }
        }
        let description = crate::html_sanitize::html_to_plain_text(&description);
        let cover_book_id = if members.contains(&cover_book_id) {
            cover_book_id
        } else {
            order.first().copied().unwrap_or(0)
        };
        let changed = list.description != description
            || list.cover_book_id != cover_book_id
            || list.book_order != order;
        list.description = description;
        list.cover_book_id = cover_book_id;
        list.book_order = order;
        changed
    }

    pub fn set_word_count(&mut self, id: u64, wc: u64) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.word_count = wc;
        }
    }

    pub fn set_fingerprint(&mut self, id: u64, fp: u64) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.fingerprint = fp;
        }
    }

    pub fn set_content_id(&mut self, id: u64, content_id: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.content_id = content_id;
        }
    }

    #[cfg(test)]
    pub fn add_bookmark(&mut self, id: u64, chapter: u32, frac: f32, label: String) {
        self.add_bookmark_at(id, chapter, frac, label, None);
    }

    pub fn add_bookmark_at(
        &mut self,
        id: u64,
        chapter: u32,
        frac: f32,
        label: String,
        position: Option<ReadingPosition>,
    ) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.bookmarks.push(Bookmark {
                chapter,
                frac,
                label,
                position: position.or_else(|| b.resume_position.clone()),
            });
        }
    }
    pub fn remove_bookmark(&mut self, id: u64, index: usize) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            if index < b.bookmarks.len() {
                b.bookmarks.remove(index);
            }
        }
    }
    pub fn bookmarks(&self, id: u64) -> Vec<Bookmark> {
        self.get(id)
            .map(|b| b.bookmarks.clone())
            .unwrap_or_default()
    }

    pub fn add_highlight(&mut self, id: u64, h: Highlight) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.highlights.push(h);
        }
    }
    pub fn remove_highlight(&mut self, id: u64, index: usize) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            if index < b.highlights.len() {
                b.highlights.remove(index);
            }
        }
    }
    pub fn set_highlight_note(&mut self, id: u64, index: usize, note: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            if let Some(h) = b.highlights.get_mut(index) {
                h.note = note;
            }
        }
    }
    pub fn set_highlight_text(&mut self, id: u64, index: usize, text: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            if let Some(h) = b.highlights.get_mut(index) {
                h.corrected_text = text;
            }
        }
    }
    pub fn set_highlight_color(&mut self, id: u64, index: usize, color: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            if let Some(h) = b.highlights.get_mut(index) {
                h.color = color;
            }
        }
    }
    pub fn highlights(&self, id: u64) -> Vec<Highlight> {
        self.get(id)
            .map(|b| b.highlights.clone())
            .unwrap_or_default()
    }

    /// Legacy position update. New readers should call `set_position_with_anchor`
    /// so width, font and side-panel changes can restore the same source text.
    #[cfg(test)]
    pub fn set_position(&mut self, id: u64, progress: f32, chapter: u32, frac: f32) -> bool {
        self.set_position_with_anchor(id, progress, chapter, frac, None)
    }

    /// Update reading progress with an optional source-text anchor. Page number
    /// is deliberately absent here: it is only a renderer-derived value.
    pub fn set_position_with_anchor(
        &mut self,
        id: u64,
        progress: f32,
        chapter: u32,
        frac: f32,
        anchor: Option<ReadingAnchor>,
    ) -> bool {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            let position = ReadingPosition {
                chapter,
                anchor,
                fraction: frac,
            }
            .normalized();
            // 分页测量会在同一源码锚点上得到不同的页数/百分比。源码位置没有
            // 变化时，后一次只是派生值重算，绝不能覆盖已保存的续读位置。
            let same_source_anchor = b
                .resume_position
                .as_ref()
                .and_then(|saved| saved.anchor.as_ref())
                .zip(position.anchor.as_ref())
                .is_some_and(|(saved, incoming)| {
                    saved.chapter == incoming.chapter && saved.text_offset == incoming.text_offset
                });
            if same_source_anchor {
                return false;
            }
            let anchor_changed =
                position.anchor.is_some() && b.resume_position.as_ref() != Some(&position);
            let changed = (b.progress - progress).abs() >= 0.05
                || b.resume_chapter != chapter
                || (b.resume_frac - frac).abs() >= 0.02
                || anchor_changed;
            b.progress = progress;
            b.resume_chapter = position.authoritative_chapter();
            b.resume_frac = position.fraction;
            // Older clients keep reporting fraction-only positions. Do not let
            // them erase a newer source anchor saved by another device.
            if position.anchor.is_some() {
                b.resume_position = Some(position.clone());
            }
            if changed {
                let at = now_secs();
                let entry = ProgressTimelineEntry {
                    at,
                    progress: progress.clamp(0.0, 100.0),
                    chapter: position.authoritative_chapter(),
                    frac: position.fraction,
                    position: position.anchor.is_some().then_some(position),
                };
                if b.progress_history
                    .last()
                    .is_some_and(|last| local_day_key(last.at) == local_day_key(at))
                {
                    *b.progress_history.last_mut().unwrap() = entry;
                } else {
                    b.progress_history.push(entry);
                }
                merge_daily_progress_history(&mut b.progress_history, &[]);
            }
            if progress >= 99.0 && b.finished_at == 0 {
                b.finished_at = now_secs(); // 首次读完打时间戳，供"本月/本年读完了哪些书"
            }
            return changed;
        }
        false
    }

    /// 合并同一内容的重复书架条目，返回被保留的书籍 id。
    /// 只接受内容 ID（旧数据则文件指纹）完全相同的一组，避免误合并相近书名。
    pub fn merge_duplicates(&mut self, ids: &[u64]) -> Result<u64, String> {
        if ids.len() < 2 {
            return Err("至少选择两本重复书籍".to_string());
        }
        let wanted: HashSet<u64> = ids.iter().copied().collect();
        if wanted.len() != ids.len() {
            return Err("重复的图书 ID".to_string());
        }
        let mut candidates: Vec<Book> = self
            .books
            .iter()
            .filter(|book| wanted.contains(&book.id))
            .cloned()
            .collect();
        if candidates.len() != wanted.len() {
            return Err("有图书已不存在".to_string());
        }
        let first = &candidates[0];
        let same_content = if !first.content_id.is_empty() {
            candidates
                .iter()
                .all(|book| book.content_id == first.content_id)
        } else if first.fingerprint != 0 {
            candidates
                .iter()
                .all(|book| book.content_id.is_empty() && book.fingerprint == first.fingerprint)
        } else {
            false
        };
        if !same_content {
            return Err("只能合并检测为相同内容的书籍".to_string());
        }

        // 优先保留文件仍在、最近阅读、进度更靠后的条目。
        candidates.sort_by(|a, b| {
            let a_present = a.path.is_file();
            let b_present = b.path.is_file();
            b_present
                .cmp(&a_present)
                .then_with(|| b.last_read_at.cmp(&a.last_read_at))
                .then_with(|| {
                    b.progress
                        .partial_cmp(&a.progress)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        let mut merged = candidates.remove(0);
        let keep_id = merged.id;
        let mut bookmark_keys: HashSet<String> = merged
            .bookmarks
            .iter()
            .filter_map(|item| serde_json::to_string(item).ok())
            .collect();
        let mut highlight_keys: HashSet<String> = merged
            .highlights
            .iter()
            .filter_map(|item| serde_json::to_string(item).ok())
            .collect();

        for book in candidates {
            if book.last_read_at > merged.last_read_at {
                merged.last_read_at = book.last_read_at;
                merged.progress = book.progress;
                merged.resume_chapter = book.resume_chapter;
                merged.resume_frac = book.resume_frac;
            }
            merged.reading_seconds = merged.reading_seconds.max(book.reading_seconds);
            merged.words_read = merged.words_read.max(book.words_read);
            merged.word_count = merged.word_count.max(book.word_count);
            merged.rating = merged.rating.max(book.rating);
            if merged.author.trim().is_empty() {
                merged.author = book.author;
            }
            if merged.description.trim().is_empty() {
                merged.description = book.description;
            }
            if merged.finished_at == 0
                || (book.finished_at != 0 && book.finished_at < merged.finished_at)
            {
                merged.finished_at = book.finished_at;
            }
            for item in book.bookmarks {
                if let Ok(key) = serde_json::to_string(&item) {
                    if bookmark_keys.insert(key) {
                        merged.bookmarks.push(item);
                    }
                }
            }
            for item in book.highlights {
                if let Ok(key) = serde_json::to_string(&item) {
                    if highlight_keys.insert(key) {
                        merged.highlights.push(item);
                    }
                }
            }
            for item in book.progress_history {
                merged.progress_history.push(item);
            }
        }
        merge_daily_progress_history(&mut merged.progress_history, &[]);
        self.books.retain(|book| !wanted.contains(&book.id));
        self.books.push(merged);
        Ok(keep_id)
    }

    fn app_config_dir() -> Option<PathBuf> {
        #[cfg(target_os = "android")]
        {
            return Some(PathBuf::from(
                "/data/user/0/com.pigking.ebookreader/files/ebook-reader",
            ));
        }
        #[cfg(not(target_os = "android"))]
        {
            let mut dir = dirs::config_dir()?;
            dir.push("ebook-reader");
            Some(dir)
        }
    }

    fn data_file() -> Option<PathBuf> {
        let dir = Self::app_config_dir()?;
        Some(dir.join("library.json"))
    }

    pub fn cache_dir() -> Option<PathBuf> {
        #[cfg(target_os = "android")]
        {
            return Some(PathBuf::from(
                "/data/user/0/com.pigking.ebookreader/cache/ebook-reader",
            ));
        }
        #[cfg(not(target_os = "android"))]
        {
            let mut dir = dirs::cache_dir()?;
            dir.push("ebook-reader");
            Some(dir)
        }
    }

    pub fn load() -> Self {
        let Some(file) = Self::data_file() else {
            return Self::default();
        };
        let mut lib: Self = match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        };
        // 迁移：旧数据没有稳定 id，用原来的"路径哈希"补上（与已有缓存文件名一致，无缝）。
        let mut compacted_daily_history = false;
        for b in &mut lib.books {
            if b.id == 0 {
                b.id = id_for_path(&b.path);
            }
            let before = b.progress_history.clone();
            merge_daily_progress_history(&mut b.progress_history, &[]);
            compacted_daily_history |= before.len() != b.progress_history.len();
        }
        // 迁移：旧的单目录字段 → 目录列表
        if lib.auto_import_dirs.is_empty() {
            if let Some(d) = lib.auto_import_dir.take() {
                if !d.trim().is_empty() {
                    lib.auto_import_dirs.push(d);
                }
            }
        }
        if compacted_daily_history {
            let _ = lib.save();
        }
        lib
    }

    pub fn save(&self) -> Result<(), String> {
        let file = Self::data_file().ok_or("无法确定书架数据路径")?;
        crate::atomic_file::write_json(&file, self, true)
    }
}

// ---------------------------------------------------------------------------
//  工具
// ---------------------------------------------------------------------------

pub fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名".to_string())
}

pub fn ext_lower(path: &Path) -> String {
    path.extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// 由文件路径稳定地算出 u64 ID（仅在导入时用来"铸造"一次 id，之后存盘不再依赖路径）。
pub fn id_for_path(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

/// 内容指纹：文件大小 + 首尾各 64KB 采样的哈希。够快，且对"同一本书换了路径"稳定。
/// 失败（文件不存在等）返回 0。
pub fn compute_fingerprint(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    use std::io::{Read, Seek, SeekFrom};
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let len = meta.len();
    let Ok(mut f) = std::fs::File::open(path) else {
        return 0;
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    len.hash(&mut hasher);
    let mut head = vec![0u8; 65536.min(len as usize)];
    if f.read_exact(&mut head).is_ok() {
        head.hash(&mut hasher);
    }
    if len > 131072 {
        let mut tail = vec![0u8; 65536];
        if f.seek(SeekFrom::End(-65536)).is_ok() && f.read_exact(&mut tail).is_ok() {
            tail.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// 完整文件 SHA-256，作为跨设备同步身份。只在导入、迁移或重新定位时计算一次。
pub fn compute_content_id(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return String::new();
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn cover_cache_dir() -> Option<PathBuf> {
    let mut dir = Library::cache_dir()?;
    dir.push("covers");
    Some(dir)
}

fn prepare_epub(path: &Path) -> Option<Book> {
    let parsed = reader_core::parser::parse_epub_metadata(path, title_from_path(path))?;
    let mut doc = epub::doc::EpubDoc::new(path).ok()?;
    let cover = extract_cover_thumbnail(&mut doc, path);
    Some(Book {
        id: id_for_path(path),
        fingerprint: compute_fingerprint(path),
        content_id: compute_content_id(path),
        path: path.to_owned(),
        title: parsed.title,
        format: "epub".to_owned(),
        cover,
        author: parsed.author,
        description: parsed.description,
        added_at: now_secs(),
        last_read_at: 0,
        progress: 0.0,
        resume_chapter: 0,
        resume_frac: 0.0,
        resume_position: None,
        chapter_index_version: 0,
        meta_done: true, // 导入时已读取元数据
        word_count: parsed.word_count,
        bookmarks: Vec::new(),
        highlights: Vec::new(),
        reading_seconds: 0,
        words_read: 0,
        finished_at: 0,
        progress_history: Vec::new(),
        cover_ver: 0,
        rating: 0.0,
        tags: Vec::new(),
        model_tags: Vec::new(),
        collections: Vec::new(),
    })
}

/// 导入 MOBI/AZW3：读出书名/作者/简介与字数（封面暂用占位）。
/// mobi 库对个别文件可能 panic（DRM/KF8 异常等）；用 catch_unwind 兜住，
/// 避免在持有书架锁时 panic 把 Mutex 毒化、导致全局崩溃（封面/打开书全失效）。
fn prepare_mobi(path: &Path) -> Option<Book> {
    let parsed = reader_core::parser::parse_mobi_metadata(path, title_from_path(path))?;
    Some(Book {
        id: id_for_path(path),
        fingerprint: compute_fingerprint(path),
        content_id: compute_content_id(path),
        path: path.to_owned(),
        title: parsed.title,
        format: ext_lower(path),
        cover: None,
        author: parsed.author,
        description: parsed.description,
        added_at: now_secs(),
        last_read_at: 0,
        progress: 0.0,
        resume_chapter: 0,
        resume_frac: 0.0,
        resume_position: None,
        chapter_index_version: 0,
        meta_done: true,
        word_count: parsed.word_count,
        bookmarks: Vec::new(),
        highlights: Vec::new(),
        reading_seconds: 0,
        words_read: 0,
        finished_at: 0,
        progress_history: Vec::new(),
        cover_ver: 0,
        rating: 0.0,
        tags: Vec::new(),
        model_tags: Vec::new(),
        collections: Vec::new(),
    })
}

/// 用用户挑选的图片做封面：缩略后存到封面缓存目录，返回新封面路径。覆盖同名文件→mtime 变化用于刷新。
pub fn make_cover_from_image(src: &Path, id: u64) -> Option<PathBuf> {
    let image = image::open(src).ok()?;
    let thumb = image.thumbnail(320, 480);
    let dir = cover_cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let out = dir.join(format!("cover_user_{id}.png"));
    thumb.save(&out).ok()?;
    Some(out)
}

fn extract_cover_thumbnail<R: std::io::Read + std::io::Seek>(
    doc: &mut epub::doc::EpubDoc<R>,
    path: &Path,
) -> Option<PathBuf> {
    let (bytes, _mime) = doc.get_cover()?;
    let image = image::load_from_memory(&bytes).ok()?;
    let thumb = image.thumbnail(320, 480);
    let dir = cover_cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let out = dir.join(format!("cover_{}.png", id_for_path(path)));
    thumb.save(&out).ok()?;
    Some(out)
}

// ---------------------------------------------------------------------------
//  纯文本解码（GBK/UTF-8 自动识别 + 换行规整），供 txt/md 阅读用
// ---------------------------------------------------------------------------

pub fn decode_bytes(bytes: &[u8]) -> String {
    reader_core::text::decode_text_bytes(bytes)
}

pub fn normalize_text(s: &str) -> String {
    reader_core::text::normalize_text(s)
}

#[cfg(test)]
mod tests {
    use super::{
        compute_content_id, compute_fingerprint, merge_daily_progress_history, Book, Bookmark,
        Highlight, Library, ProgressTimelineEntry, ReadingAnchor,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("kunpeng-reader-test-{name}-{stamp}"));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.path.join(name);
            fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn path_str(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn add_same_path_only_once() {
        let dir = TempDir::new("same-path");
        let book = dir.file("same.txt", "第一章\n正文");
        let mut lib = Library::default();

        assert!(lib.add_prepared(Book::prepare(book.clone())));
        assert!(!lib.add_prepared(Book::prepare(book.clone())));
        assert_eq!(lib.books.len(), 1);
        assert_eq!(path_str(&lib.books[0].path), path_str(&book));
    }

    #[test]
    fn add_same_fingerprint_relocates_existing_book_and_keeps_progress() {
        let dir = TempDir::new("same-fingerprint");
        let old_path = dir.file("old.txt", "同一本书内容\n第二行");
        let new_path = dir.file("new.txt", "同一本书内容\n第二行");
        let mut lib = Library::default();

        assert!(lib.add_prepared(Book::prepare(old_path.clone())));
        lib.books[0].progress = 42.0;
        lib.books[0].resume_chapter = 3;
        let original_id = lib.books[0].id;
        let original_fp = lib.books[0].fingerprint;

        assert!(lib.add_prepared(Book::prepare(new_path.clone())));
        assert_eq!(lib.books.len(), 1);
        assert_eq!(lib.books[0].id, original_id);
        assert_eq!(lib.books[0].fingerprint, original_fp);
        assert_eq!(lib.books[0].progress, 42.0);
        assert_eq!(lib.books[0].resume_chapter, 3);
        assert_eq!(path_str(&lib.books[0].path), path_str(&new_path));
    }

    #[test]
    fn content_id_is_stable_across_different_paths() {
        let first_dir = TempDir::new("content-id-a");
        let second_dir = TempDir::new("content-id-b");
        let first = first_dir.file("a.epub", "same bytes");
        let second = second_dir.file("renamed.epub", "same bytes");
        assert_eq!(compute_content_id(&first), compute_content_id(&second));
        assert_eq!(compute_content_id(&first).len(), 64);
    }

    #[test]
    fn add_different_content_creates_new_book() {
        let dir = TempDir::new("different-content");
        let first = dir.file("first.txt", "第一本书");
        let second = dir.file("second.txt", "第二本书");
        let mut lib = Library::default();

        assert!(lib.add_prepared(Book::prepare(first)));
        assert!(lib.add_prepared(Book::prepare(second)));
        assert_eq!(lib.books.len(), 2);
        assert_ne!(lib.books[0].fingerprint, lib.books[1].fingerprint);
    }

    #[test]
    fn relocate_updates_path_and_nonzero_fingerprint() {
        let dir = TempDir::new("relocate");
        let old_path = dir.file("old.txt", "旧内容");
        let new_path = dir.file("new.txt", "新内容更多一点");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(old_path)));
        let id = lib.books[0].id;
        let expected_fp = compute_fingerprint(&new_path);

        assert!(lib.relocate(id, new_path.clone()));
        assert_eq!(path_str(&lib.books[0].path), path_str(&new_path));
        assert_eq!(lib.books[0].fingerprint, expected_fp);
        assert_ne!(lib.books[0].fingerprint, 0);
    }

    #[test]
    fn set_position_ignores_tiny_progress_and_fraction_jitter() {
        let dir = TempDir::new("position-jitter");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        assert!(lib.set_position(id, 10.0, 2, 0.50));
        assert!(!lib.set_position(id, 10.03, 2, 0.51));
        assert_eq!(lib.books[0].progress, 10.03);
        assert_eq!(lib.books[0].resume_chapter, 2);
        assert!((lib.books[0].resume_frac - 0.51).abs() < f32::EPSILON);
    }

    #[test]
    fn set_position_reports_meaningful_progress_and_chapter_changes() {
        let dir = TempDir::new("position-changed");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        assert!(lib.set_position(id, 1.0, 1, 0.10));
        assert!(lib.set_position(id, 1.06, 1, 0.10));
        assert!(lib.set_position(id, 1.06, 2, 0.10));
        assert!(lib.set_position(id, 1.06, 2, 0.13));
        assert_eq!(lib.books[0].resume_chapter, 2);
        assert!((lib.books[0].resume_frac - 0.13).abs() < f32::EPSILON);
    }

    #[test]
    fn anchored_position_is_saved_independently_of_physical_page_fraction() {
        let dir = TempDir::new("anchored-position");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;
        let anchor = ReadingAnchor {
            chapter: 4,
            dom_path: "p:3/span:0".into(),
            text_offset: 1024,
            context_before: "前文".into(),
            context_after: "后文".into(),
            viewport_offset: 18.0,
        };

        assert!(lib.set_position_with_anchor(id, 42.0, 4, 0.31, Some(anchor)));
        let saved = lib.books[0]
            .resume_position
            .as_ref()
            .expect("source anchor saved");
        assert_eq!(saved.authoritative_chapter(), 4);
        assert_eq!(saved.anchor.as_ref().unwrap().text_offset, 1024);
        assert!((lib.books[0].resume_frac - 0.31).abs() < f32::EPSILON);
    }

    #[test]
    fn anchored_position_ignores_later_relayout_progress_for_the_same_source_text() {
        let dir = TempDir::new("anchored-position-relayout");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;
        let anchor = ReadingAnchor {
            chapter: 40,
            dom_path: "p:8/span:1".into(),
            text_offset: 2414,
            context_before: "前文".into(),
            context_after: "后文".into(),
            viewport_offset: 18.0,
        };

        assert!(lib.set_position_with_anchor(id, 87.267, 40, 0.143, Some(anchor.clone())));
        assert!(!lib.set_position_with_anchor(id, 83.026, 40, 0.143, Some(anchor)));
        assert!((lib.books[0].progress - 87.267).abs() < f32::EPSILON);
        assert_eq!(
            lib.books[0]
                .resume_position
                .as_ref()
                .and_then(|position| position.anchor.as_ref())
                .map(|saved| saved.text_offset),
            Some(2414)
        );
    }

    #[test]
    fn set_position_marks_finished_only_once() {
        let dir = TempDir::new("position-finished");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        assert!(lib.set_position(id, 99.0, 9, 0.90));
        let first_finished_at = lib.books[0].finished_at;
        assert!(first_finished_at > 0);
        lib.books[0].finished_at = 12345;
        assert!(lib.set_position(id, 100.0, 9, 1.0));
        assert_eq!(lib.books[0].finished_at, 12345);
    }

    #[test]
    fn daily_progress_history_keeps_only_the_latest_position_per_day() {
        let base = 1_700_000_000;
        let mut history = vec![
            ProgressTimelineEntry {
                at: base,
                progress: 10.0,
                chapter: 1,
                frac: 0.1,
                ..Default::default()
            },
            ProgressTimelineEntry {
                at: base + 60,
                progress: 20.0,
                chapter: 2,
                frac: 0.2,
                ..Default::default()
            },
            ProgressTimelineEntry {
                at: base + 86_400,
                progress: 30.0,
                chapter: 3,
                frac: 0.3,
                ..Default::default()
            },
        ];

        merge_daily_progress_history(&mut history, &[]);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].progress, 20.0);
        assert_eq!(history[1].progress, 30.0);
    }

    #[test]
    fn merge_duplicates_keeps_latest_position_and_unions_annotations() {
        let dir = TempDir::new("merge-duplicates");
        let first_path = dir.file("first.txt", "same book content");
        let second_path = dir.file("renamed.txt", "same book content");
        let mut first = Book::prepare(first_path);
        let mut second = Book::prepare(second_path);
        first.id = 1;
        second.id = 2;
        first.last_read_at = 100;
        first.progress = 20.0;
        first.bookmarks.push(Bookmark {
            chapter: 1,
            frac: 0.2,
            label: "first".into(),
            ..Default::default()
        });
        second.last_read_at = 200;
        second.progress = 60.0;
        second.resume_chapter = 6;
        second.bookmarks.push(Bookmark {
            chapter: 2,
            frac: 0.4,
            label: "second".into(),
            ..Default::default()
        });
        let mut lib = Library {
            books: vec![first, second],
            ..Default::default()
        };

        assert_eq!(lib.merge_duplicates(&[1, 2]).unwrap(), 2);
        assert_eq!(lib.books.len(), 1);
        assert_eq!(lib.books[0].progress, 60.0);
        assert_eq!(lib.books[0].resume_chapter, 6);
        assert_eq!(lib.books[0].bookmarks.len(), 2);
    }

    #[test]
    fn description_and_rating_update_reader_metadata() {
        let dir = TempDir::new("reader-metadata");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        lib.set_description(id, "<h3>新的简介</h3><p>正文 &amp; 补充</p>".to_string());
        lib.set_rating(id, 7.5);
        assert_eq!(lib.books[0].description, "新的简介\n正文 & 补充");
        assert_eq!(lib.books[0].rating, 5.0);

        lib.set_rating(id, -2.0);
        assert_eq!(lib.books[0].rating, 0.0);
    }

    #[test]
    fn collections_gain_booklist_metadata_and_keep_manual_order() {
        let dir = TempDir::new("booklists");
        let mut first = Book::prepare(dir.file("first.txt", "第一本"));
        let mut second = Book::prepare(dir.file("second.txt", "第二本"));
        first.id = 101;
        second.id = 202;
        let mut lib = Library {
            books: vec![first, second],
            ..Default::default()
        };

        assert!(lib.set_organization(101, vec!["历史".into()], vec!["明清".into()]));
        assert!(lib.set_organization(202, Vec::new(), vec!["明清".into()]));
        assert_eq!(lib.booklists.len(), 1);
        assert_eq!(lib.booklists[0].book_order, vec![101, 202]);

        assert!(lib.update_booklist("明清", "<b>按时代阅读</b>".into(), 202, vec![202, 101],));
        assert_eq!(lib.booklists[0].description, "按时代阅读");
        assert_eq!(lib.booklists[0].cover_book_id, 202);
        assert_eq!(lib.booklists[0].book_order, vec![202, 101]);

        assert!(lib.rename_organization("collection", "明清", "明清史".into()));
        assert_eq!(lib.booklists[0].name, "明清史");
        assert_eq!(lib.booklists[0].book_order, vec![202, 101]);
    }

    #[test]
    fn batch_organization_adds_without_overwriting_existing_values() {
        let dir = TempDir::new("batch-organization");
        let mut first = Book::prepare(dir.file("first.txt", "第一本"));
        let mut second = Book::prepare(dir.file("second.txt", "第二本"));
        first.id = 101;
        second.id = 202;
        let mut lib = Library {
            books: vec![first, second],
            ..Default::default()
        };
        assert!(lib.set_organization(101, vec!["古文".into()], vec!["已读".into()]));
        assert!(lib.set_organization(202, vec!["历史".into()], Vec::new()));

        let ids = [101, 202]
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        assert!(lib.add_organization_to_books(&ids, "tag", vec!["历史".into(), "军事".into()]));
        assert_eq!(lib.get(101).unwrap().tags, vec!["古文", "历史", "军事"]);
        assert_eq!(lib.get(202).unwrap().tags, vec!["历史", "军事"]);

        assert!(lib.add_organization_to_books(&ids, "collection", vec!["专题".into()]));
        assert_eq!(lib.get(101).unwrap().collections, vec!["已读", "专题"]);
        assert_eq!(lib.get(202).unwrap().collections, vec!["专题"]);
        assert_eq!(lib.booklists.len(), 2);
    }

    #[test]
    fn bookmarks_can_be_added_removed_and_ignore_out_of_range() {
        let dir = TempDir::new("bookmarks");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        lib.add_bookmark(id, 3, 0.25, "第三章".to_string());
        lib.add_bookmark(id, 4, 0.50, "第四章".to_string());
        assert_eq!(lib.bookmarks(id).len(), 2);
        assert_eq!(lib.bookmarks(id)[0].label, "第三章");

        lib.remove_bookmark(id, 99);
        assert_eq!(lib.bookmarks(id).len(), 2);
        lib.remove_bookmark(id, 0);
        let remaining = lib.bookmarks(id);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].chapter, 4);
    }

    #[test]
    fn highlights_can_be_added_noted_removed_and_ignore_out_of_range() {
        let dir = TempDir::new("highlights");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        lib.add_highlight(
            id,
            Highlight {
                chapter: 2,
                start: 10,
                end: 14,
                text: "高亮".to_string(),
                corrected_text: String::new(),
                context: "上下文".to_string(),
                rects: String::new(),
                color: "#ffee88".to_string(),
                note: String::new(),
                created_at: 1,
                ..Default::default()
            },
        );
        assert_eq!(lib.highlights(id).len(), 1);
        assert_eq!(lib.highlights(id)[0].text, "高亮");

        lib.set_highlight_note(id, 0, "批注".to_string());
        lib.set_highlight_note(id, 9, "越界".to_string());
        assert_eq!(lib.highlights(id)[0].note, "批注");

        lib.set_highlight_text(id, 0, "改错".to_string());
        lib.set_highlight_text(id, 9, "越界".to_string());
        assert_eq!(lib.highlights(id)[0].corrected_text, "改错");

        lib.remove_highlight(id, 9);
        assert_eq!(lib.highlights(id).len(), 1);
        lib.remove_highlight(id, 0);
        assert!(lib.highlights(id).is_empty());
    }
}
