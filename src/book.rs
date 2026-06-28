// ============================================================================
//  book.rs —— 图书馆（持久化）、图书元信息、封面缩略图、文本解码
// ============================================================================

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 一个书签：定位到 章节 + 章内比例（虚拟化按章渲染下稳定），label 仅作显示。
#[derive(Clone, Serialize, Deserialize)]
pub struct Bookmark {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub frac: f32,
    pub label: String,
}

/// 书架上的一本书。
#[derive(Clone, Serialize, Deserialize)]
pub struct Book {
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
    #[serde(default)]
    pub meta_done: bool, // 元数据（作者/简介）是否已回填过，避免每次启动重读
    #[serde(default)]
    pub word_count: u64, // 字数（0 表示尚未统计）
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
    #[serde(default)]
    pub reading_seconds: u64, // 累计阅读时长（秒）
}

/// 当前 unix 时间戳（秒）。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Book {
    /// 导入一个文件：EPUB 顺便读出书名、提取封面缩略图（只在导入时做一次）。
    pub fn prepare(path: PathBuf) -> Self {
        if ext_lower(&path) == "epub" {
            if let Some(book) = prepare_epub(&path) {
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
            meta_done: true, // 新建/txt 无需回填
            word_count,
            bookmarks: Vec::new(),
            reading_seconds: 0,
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
        Self { x: 0.0, y: 0.0, w: 880.0, h: 760.0, maximized: false }
    }
}

/// 整个书架，序列化成 JSON 持久化。
#[derive(Default, Serialize, Deserialize)]
pub struct Library {
    pub books: Vec<Book>,
    #[serde(default)]
    pub reader_geom: Option<WinGeom>, // 上次阅读窗口的大小/位置
    #[serde(default)]
    pub main_geom: Option<WinGeom>, // 上次主窗口（书架）的大小/位置
}

impl Library {
    /// 添加一本书（按路径去重）。返回 true 表示确实新增。
    pub fn add(&mut self, path: PathBuf) -> bool {
        if self.books.iter().any(|b| b.path == path) {
            return false;
        }
        self.books.push(Book::prepare(path));
        true
    }

    pub fn remove(&mut self, id: u64) {
        self.books.retain(|b| id_for_path(&b.path) != id);
    }

    pub fn get(&self, id: u64) -> Option<&Book> {
        self.books.iter().find(|b| id_for_path(&b.path) == id)
    }

    /// 标记某本书“刚刚被打开”（更新最近阅读时间）。
    pub fn mark_read(&mut self, id: u64) {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            b.last_read_at = now_secs();
        }
    }

    pub fn set_description(&mut self, id: u64, desc: String) {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            b.description = desc;
        }
    }

    pub fn set_word_count(&mut self, id: u64, wc: u64) {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            b.word_count = wc;
        }
    }

    pub fn add_bookmark(&mut self, id: u64, chapter: u32, frac: f32, label: String) {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            b.bookmarks.push(Bookmark {
                chapter,
                frac,
                label,
            });
        }
    }
    pub fn remove_bookmark(&mut self, id: u64, index: usize) {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            if index < b.bookmarks.len() {
                b.bookmarks.remove(index);
            }
        }
    }
    pub fn bookmarks(&self, id: u64) -> Vec<Bookmark> {
        self.get(id).map(|b| b.bookmarks.clone()).unwrap_or_default()
    }

    /// 更新阅读位置（进度% + 续读章节/章内比例）；进度变化足够大才返回 true（决定是否写盘）。
    pub fn set_position(&mut self, id: u64, progress: f32, chapter: u32, frac: f32) -> bool {
        if let Some(b) = self.books.iter_mut().find(|b| id_for_path(&b.path) == id) {
            let changed = (b.progress - progress).abs() >= 0.05
                || b.resume_chapter != chapter
                || (b.resume_frac - frac).abs() >= 0.02;
            b.progress = progress;
            b.resume_chapter = chapter;
            b.resume_frac = frac;
            return changed;
        }
        false
    }

    fn data_file() -> Option<PathBuf> {
        let mut dir = dirs::config_dir()?;
        dir.push("ebook-reader");
        Some(dir.join("library.json"))
    }

    pub fn load() -> Self {
        let Some(file) = Self::data_file() else {
            return Self::default();
        };
        match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) {
        let Some(file) = Self::data_file() else { return };
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&file, text);
        }
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

/// 由文件路径稳定地算出 u64 ID。
pub fn id_for_path(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

fn cover_cache_dir() -> Option<PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("ebook-reader");
    dir.push("covers");
    Some(dir)
}

fn prepare_epub(path: &Path) -> Option<Book> {
    let mut doc = epub::doc::EpubDoc::new(path).ok()?;
    let title = doc
        .mdata("title")
        .map(|m| m.value.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| title_from_path(path));
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_default();
    let description = doc
        .mdata("description")
        .map(|m| m.value.clone())
        .unwrap_or_default();
    let cover = extract_cover_thumbnail(&mut doc, path);
    // 导入时顺手统计字数（doc 已打开）
    let word_count = {
        let spine: Vec<String> = doc.spine.iter().map(|s| s.idref.clone()).collect();
        let mut n = 0usize;
        for idref in spine {
            if let Some((s, _)) = doc.get_resource_str(&idref) {
                n += count_text_chars(&s);
            }
        }
        n as u64
    };
    Some(Book {
        path: path.to_owned(),
        title,
        format: "epub".to_owned(),
        cover,
        author,
        description,
        added_at: now_secs(),
        last_read_at: 0,
        progress: 0.0,
        resume_chapter: 0,
        resume_frac: 0.0,
        meta_done: true, // 导入时已读取元数据
        word_count,
        bookmarks: Vec::new(),
        reading_seconds: 0,
    })
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
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

pub fn normalize_text(s: &str) -> String {
    let unified = s.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut newline_run = 0;
    for ch in unified.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push('\n');
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out.trim().to_owned()
}
