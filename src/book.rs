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

/// 一处高亮/批注：章节 + 章内字符区间 [start,end)，附文本、颜色、批注。
#[derive(Clone, Serialize, Deserialize)]
pub struct Highlight {
    #[serde(default)]
    pub chapter: u32,
    #[serde(default)]
    pub start: u32,
    #[serde(default)]
    pub end: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub context: String, // 被高亮文字所在段落（用于批注页展示上下文）
    #[serde(default)]
    pub rects: String, // PDF 专用：归一化矩形 JSON（[[x,y,w,h],...]）；EPUB 为空
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created_at: u64,
}

/// 书架上的一本书。
#[derive(Clone, Serialize, Deserialize)]
pub struct Book {
    #[serde(default)]
    pub id: u64, // 稳定 id（导入时分配，之后即使文件移动也不变；0=旧数据待迁移）
    #[serde(default)]
    pub fingerprint: u64, // 内容指纹（大小+首尾采样），用于"换了位置的同一本书"去重/重定位
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
    pub highlights: Vec<Highlight>,
    #[serde(default)]
    pub reading_seconds: u64, // 累计阅读时长（秒）
    #[serde(default)]
    pub words_read: u64, // 累计"真正读过"的字数（停留若干秒+逐页翻过的页才计入）
    #[serde(default)]
    pub finished_at: u64, // 首次读完（进度≥99%）的 unix 秒，0=未读完
    #[serde(default)]
    pub cover_ver: u64, // 封面版本号：换封面时 +1，用于刷新前端缓存（避免每次渲染都去 stat 封面文件）
    #[serde(default)]
    pub rating: f32, // 用户评分 0~5，0.5 为刻度（0=未评分）
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
            highlights: Vec::new(),
            reading_seconds: 0,
            words_read: 0,
            finished_at: 0,
            cover_ver: 0,
            rating: 0.0,
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

/// 整个书架，序列化成 JSON 持久化。
#[derive(Default, Serialize, Deserialize)]
pub struct Library {
    pub books: Vec<Book>,
    #[serde(default)]
    pub reader_geom: Option<WinGeom>, // 上次 EPUB 阅读窗口的大小/位置
    #[serde(default)]
    pub reader_geom_pdf: Option<WinGeom>, // 上次 PDF 阅读窗口的大小/位置（与 EPUB 分开记）
    #[serde(default)]
    pub main_geom: Option<WinGeom>, // 上次主窗口（书架）的大小/位置
    #[serde(default)]
    pub auto_import_dir: Option<String>, // 旧：单个自动导入目录（已迁移到 auto_import_dirs）
    #[serde(default)]
    pub auto_import_dirs: Vec<String>, // 自动导入目录列表（启动时扫描其中的电子书加入书架）
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
    }

    pub fn get(&self, id: u64) -> Option<&Book> {
        self.books.iter().find(|b| b.id == id)
    }

    /// 把某本书重新指向一个新文件（文件丢失后用户重新定位）。返回是否成功。
    pub fn relocate(&mut self, id: u64, new_path: PathBuf) -> bool {
        let fp = compute_fingerprint(&new_path);
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.path = new_path;
            if fp != 0 {
                b.fingerprint = fp;
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
            b.description = desc;
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

    pub fn add_bookmark(&mut self, id: u64, chapter: u32, frac: f32, label: String) {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            b.bookmarks.push(Bookmark {
                chapter,
                frac,
                label,
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
    pub fn highlights(&self, id: u64) -> Vec<Highlight> {
        self.get(id)
            .map(|b| b.highlights.clone())
            .unwrap_or_default()
    }

    /// 更新阅读位置（进度% + 续读章节/章内比例）；进度变化足够大才返回 true（决定是否写盘）。
    pub fn set_position(&mut self, id: u64, progress: f32, chapter: u32, frac: f32) -> bool {
        if let Some(b) = self.books.iter_mut().find(|b| b.id == id) {
            let changed = (b.progress - progress).abs() >= 0.05
                || b.resume_chapter != chapter
                || (b.resume_frac - frac).abs() >= 0.02;
            b.progress = progress;
            b.resume_chapter = chapter;
            b.resume_frac = frac;
            if progress >= 99.0 && b.finished_at == 0 {
                b.finished_at = now_secs(); // 首次读完打时间戳，供"本月/本年读完了哪些书"
            }
            return changed;
        }
        false
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
        for b in &mut lib.books {
            if b.id == 0 {
                b.id = id_for_path(&b.path);
            }
        }
        // 迁移：旧的单目录字段 → 目录列表
        if lib.auto_import_dirs.is_empty() {
            if let Some(d) = lib.auto_import_dir.take() {
                if !d.trim().is_empty() {
                    lib.auto_import_dirs.push(d);
                }
            }
        }
        lib
    }

    pub fn save(&self) {
        let Some(file) = Self::data_file() else {
            return;
        };
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

fn cover_cache_dir() -> Option<PathBuf> {
    let mut dir = Library::cache_dir()?;
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
        id: id_for_path(path),
        fingerprint: compute_fingerprint(path),
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
        highlights: Vec::new(),
        reading_seconds: 0,
        words_read: 0,
        finished_at: 0,
        cover_ver: 0,
        rating: 0.0,
    })
}

/// 导入 MOBI/AZW3：读出书名/作者/简介与字数（封面暂用占位）。
/// mobi 库对个别文件可能 panic（DRM/KF8 异常等）；用 catch_unwind 兜住，
/// 避免在持有书架锁时 panic 把 Mutex 毒化、导致全局崩溃（封面/打开书全失效）。
fn prepare_mobi(path: &Path) -> Option<Book> {
    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let m = mobi::Mobi::from_path(path).ok()?;
        let title = {
            let t = m.title();
            if t.trim().is_empty() {
                title_from_path(path)
            } else {
                t
            }
        };
        Some((
            title,
            m.author().unwrap_or_default(),
            m.description().unwrap_or_default(),
            count_text_chars(&m.content_as_string_lossy()) as u64,
        ))
    }))
    .ok()
    .flatten()?;
    let (title, author, description, word_count) = parsed;
    Some(Book {
        id: id_for_path(path),
        fingerprint: compute_fingerprint(path),
        path: path.to_owned(),
        title,
        format: ext_lower(path),
        cover: None,
        author,
        description,
        added_at: now_secs(),
        last_read_at: 0,
        progress: 0.0,
        resume_chapter: 0,
        resume_frac: 0.0,
        meta_done: true,
        word_count,
        bookmarks: Vec::new(),
        highlights: Vec::new(),
        reading_seconds: 0,
        words_read: 0,
        finished_at: 0,
        cover_ver: 0,
        rating: 0.0,
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

#[cfg(test)]
mod tests {
    use super::{compute_fingerprint, Book, Highlight, Library};
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
    fn description_and_rating_update_reader_metadata() {
        let dir = TempDir::new("reader-metadata");
        let path = dir.file("book.txt", "正文");
        let mut lib = Library::default();
        assert!(lib.add_prepared(Book::prepare(path)));
        let id = lib.books[0].id;

        lib.set_description(id, "新的简介".to_string());
        lib.set_rating(id, 7.5);
        assert_eq!(lib.books[0].description, "新的简介");
        assert_eq!(lib.books[0].rating, 5.0);

        lib.set_rating(id, -2.0);
        assert_eq!(lib.books[0].rating, 0.0);
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
                context: "上下文".to_string(),
                rects: String::new(),
                color: "#ffee88".to_string(),
                note: String::new(),
                created_at: 1,
            },
        );
        assert_eq!(lib.highlights(id).len(), 1);
        assert_eq!(lib.highlights(id)[0].text, "高亮");

        lib.set_highlight_note(id, 0, "批注".to_string());
        lib.set_highlight_note(id, 9, "越界".to_string());
        assert_eq!(lib.highlights(id)[0].note, "批注");

        lib.remove_highlight(id, 9);
        assert_eq!(lib.highlights(id).len(), 1);
        lib.remove_highlight(id, 0);
        assert!(lib.highlights(id).is_empty());
    }
}
