// 防止 Windows release 构建弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod book;
mod db;
mod dict;

use book::{Library, WinGeom};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// 自定义协议的基地址（Windows 下 WebView2 把自定义协议映射到 http://<scheme>.localhost）
const RES_BASE: &str = "http://reader.localhost";
const DEFAULT_SYNC_URL: &str = "http://sync.example.invalid";

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

/// 全局状态：书架 + 已打开的 EPUB 缓存（避免每个资源请求都重新解压）。
struct AppState {
    library: Mutex<Library>,
    db: Mutex<Option<db::AppDb>>,
    epubs: Mutex<HashMap<u64, EpubDoc>>,
    backfilled: std::sync::atomic::AtomicBool, // 是否已回填旧书的作者/导入时间
    pending_jump: Mutex<HashMap<u64, (u32, String)>>, // 书架检索点击 → 阅读窗口待跳转位置
    text_cache: Mutex<HashMap<u64, (u64, Arc<Vec<String>>)>>, // 检索用：内存缓存的逐章纯文本 (mtime, 章节)
    lower_text_cache: Mutex<HashMap<u64, (u64, Arc<Vec<Vec<u8>>>)>>, // 英文检索用：ASCII 小写后的章节字节
    txt_chapters: Mutex<HashMap<u64, Arc<Vec<(String, String)>>>>, // txt 阅读用：切分好的章节 (标题, 正文)
    cache_bytes: AtomicUsize,                                      // 已缓存的总字节数（限额用）
    embedder: Mutex<Option<Arc<fastembed::TextEmbedding>>>,        // 语义模型（懒加载，首次会下载）
    sem_cache: Mutex<HashMap<u64, Arc<SemData>>>,                  // 语义检索：内存缓存的向量
    sem_cache_bytes: AtomicUsize,
    sem_progress: Mutex<SemProgress>, // 建立语义索引的进度
    global_index: Mutex<Option<Arc<LoadedShards>>>, // 全库近邻索引：已载入内存的分片集合
    index_resume_at: AtomicU64, // 语义索引“让路”截止时刻(ms,0=不暂停)：打开阅读窗口时临时暂停建索引，让窗口秒开
    stats: Mutex<StatsStore>,   // 详细阅读统计的小时桶
    vocab: Mutex<VocabStore>,   // 生词本：查过的词
    word_pack: Mutex<WordPackState>, // 高频词语音包后台生成状态
}

/// 当前时刻（毫秒）。用于语义索引的“让路”节流。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把当前线程降到“后台优先级”，让前台（阅读/书架窗口）优先拿到 CPU。仅 Windows，尽力而为。
#[cfg(windows)]
fn set_thread_background(on: bool) {
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
fn set_thread_background(_on: bool) {}

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
struct TocDto {
    label: String,
    chapter: u32, // 目标章节序号
    frag: String, // 章内锚点 id（可空）
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

fn snapshot(lib: &Library) -> Vec<BookDto> {
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

// ---- 生词本：记录查过的词（中/英分开），同词不重复、累计次数 ----
#[derive(Serialize, Deserialize, Clone, Default)]
struct VocabEntry {
    word: String,
    lang: String, // "zh" / "en"
    #[serde(default)]
    def: String,
    #[serde(default)]
    def_en: String,
    #[serde(default)]
    phonetic: String,
    #[serde(default)]
    count: u32,
    #[serde(default)]
    added_at: u64,
    #[serde(default)]
    last_at: u64,
    #[serde(default)]
    level: u8, // 0=陌生, 1=认识, 2=掌握
    #[serde(default)]
    example: String,
    #[serde(default)]
    book_id: u64,
    #[serde(default)]
    book_title: String,
}

#[derive(Default)]
struct VocabStore {
    list: Vec<VocabEntry>,
}

impl VocabStore {
    fn file() -> Option<std::path::PathBuf> {
        let mut d = dirs::config_dir()?;
        d.push("ebook-reader");
        Some(d.join("vocab.json"))
    }
    fn load() -> Self {
        let list = Self::file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<Vec<VocabEntry>>(&t).ok())
            .unwrap_or_default();
        Self { list }
    }
    fn save(&self) {
        let Some(f) = Self::file() else { return };
        if let Some(p) = f.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Ok(t) = serde_json::to_string(&self.list) {
            let _ = std::fs::write(f, t);
        }
    }
    fn add(&mut self, e: VocabIn) {
        let word = e.word.trim().to_string();
        if word.is_empty() {
            return;
        }
        let now = book::now_secs();
        if let Some(x) = self
            .list
            .iter_mut()
            .find(|x| x.word == word && x.lang == e.lang)
        {
            x.count += 1;
            x.last_at = now;
            if !e.def.is_empty() {
                x.def = e.def;
            }
            if !e.def_en.is_empty() {
                x.def_en = e.def_en;
            }
            if !e.phonetic.is_empty() {
                x.phonetic = e.phonetic;
            }
            if !e.example.is_empty() {
                x.example = e.example;
            }
            if e.book_id != 0 {
                x.book_id = e.book_id;
            }
            if !e.book_title.is_empty() {
                x.book_title = e.book_title;
            }
        } else {
            self.list.push(VocabEntry {
                word,
                lang: e.lang,
                def: e.def,
                def_en: e.def_en,
                phonetic: e.phonetic,
                count: 1,
                added_at: now,
                last_at: now,
                level: 0,
                example: e.example,
                book_id: e.book_id,
                book_title: e.book_title,
            });
        }
        self.save();
    }
    fn remove(&mut self, word: &str, lang: &str) {
        self.list.retain(|x| !(x.word == word && x.lang == lang));
        self.save();
    }
    fn list_lang(&self, lang: &str) -> Vec<VocabEntry> {
        let mut v: Vec<VocabEntry> = self
            .list
            .iter()
            .filter(|x| x.lang == lang)
            .cloned()
            .collect();
        v.sort_by(|a, b| b.last_at.cmp(&a.last_at)); // 最近查的在前
        v
    }
    fn set_level(&mut self, word: &str, lang: &str, level: u8) {
        if let Some(x) = self
            .list
            .iter_mut()
            .find(|x| x.word == word && x.lang == lang)
        {
            x.level = level.min(2);
            self.save();
        }
    }
    fn review(&self, lang: &str) -> Vec<VocabEntry> {
        let now = book::now_secs();
        let mut v: Vec<VocabEntry> = self
            .list
            .iter()
            .filter(|x| x.lang == lang && x.level < 2)
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            let sa = review_score(a, now);
            let sb = review_score(b, now);
            sb.cmp(&sa).then_with(|| a.last_at.cmp(&b.last_at))
        });
        v.truncate(30);
        v
    }
}

fn review_score(e: &VocabEntry, now: u64) -> u64 {
    let age_days = now.saturating_sub(e.last_at) / 86_400;
    let level_weight = match e.level {
        0 => 80,
        1 => 25,
        _ => 0,
    };
    level_weight + (e.count as u64 * 3) + age_days.min(30)
}

#[derive(Deserialize)]
struct VocabIn {
    word: String,
    lang: String,
    #[serde(default)]
    def: String,
    #[serde(default)]
    def_en: String,
    #[serde(default)]
    phonetic: String,
    #[serde(default)]
    example: String,
    #[serde(default)]
    book_id: u64,
    #[serde(default)]
    book_title: String,
}

#[tauri::command]
fn vocab_add(state: tauri::State<AppState>, entry: VocabIn) {
    state.vocab.lock().unwrap().add(entry);
}

#[tauri::command]
fn vocab_list(state: tauri::State<AppState>, lang: String) -> Vec<VocabEntry> {
    state.vocab.lock().unwrap().list_lang(&lang)
}

#[tauri::command]
fn vocab_remove(state: tauri::State<AppState>, word: String, lang: String) -> Vec<VocabEntry> {
    let mut v = state.vocab.lock().unwrap();
    v.remove(&word, &lang);
    v.list_lang(&lang)
}

#[tauri::command]
fn vocab_set_level(
    state: tauri::State<AppState>,
    word: String,
    lang: String,
    level: u8,
) -> Vec<VocabEntry> {
    let mut v = state.vocab.lock().unwrap();
    v.set_level(&word, &lang, level);
    v.list_lang(&lang)
}

#[tauri::command]
fn vocab_review(state: tauri::State<AppState>, lang: String) -> Vec<VocabEntry> {
    state.vocab.lock().unwrap().review(&lang)
}

#[derive(Serialize)]
struct BookNotesSummary {
    id: u64,
    title: String,
    highlights: Vec<book::Highlight>,
    vocab: Vec<VocabEntry>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct SyncSettings {
    url: String,
    token: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    last_sync_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AuthUser {
    id: String,
    username: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AuthResponse {
    #[serde(default)]
    ok: bool,
    token: String,
    user: AuthUser,
}

#[derive(Serialize)]
struct SyncReport {
    ok: bool,
    message: String,
    pushed: usize,
    pulled: usize,
    server_time: i64,
}

#[derive(Deserialize)]
struct SyncPushResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    accepted_count: u32,
    #[serde(default)]
    ignored_count: u32,
}

#[derive(Deserialize)]
struct SyncPullResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
}

#[tauri::command]
fn notes_summary(state: tauri::State<AppState>) -> Vec<BookNotesSummary> {
    let books = state.library.lock().unwrap().books.clone();
    let vocab = state.vocab.lock().unwrap().list.clone();
    let mut out = Vec::new();
    for b in books {
        let words: Vec<VocabEntry> = vocab
            .iter()
            .filter(|v| v.book_id == b.id || (!v.book_title.is_empty() && v.book_title == b.title))
            .cloned()
            .collect();
        if b.highlights.is_empty() && words.is_empty() {
            continue;
        }
        out.push(BookNotesSummary {
            id: b.id,
            title: b.title,
            highlights: b.highlights,
            vocab: words,
        });
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

fn migrate_json_to_sqlite(state: &AppState) {
    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    if let Ok(lib) = state.library.lock() {
        for b in &lib.books {
            if let Ok(v) = serde_json::to_value(b) {
                let _ = db.upsert_json("book", &b.id.to_string(), &v);
            }
            for (i, h) in b.highlights.iter().enumerate() {
                let v = serde_json::json!({
                    "book_id": b.id,
                    "book_title": b.title,
                    "highlight": h,
                });
                let _ = db.upsert_json("highlight", &format!("{}:{i}", b.id), &v);
                if !h.note.trim().is_empty() {
                    let _ = db.upsert_json("annotation", &format!("{}:{i}", b.id), &v);
                }
            }
            for (i, bm) in b.bookmarks.iter().enumerate() {
                let v = serde_json::json!({
                    "book_id": b.id,
                    "book_title": b.title,
                    "bookmark": bm,
                });
                let _ = db.upsert_json("bookmark", &format!("{}:{i}", b.id), &v);
            }
        }
        let settings = serde_json::json!({
            "main_geom": lib.main_geom,
            "reader_geom": lib.reader_geom,
            "reader_geom_pdf": lib.reader_geom_pdf,
            "auto_import_dirs": lib.auto_import_dirs,
            "auto_import_enabled": lib.auto_import_enabled,
        });
        let _ = db.upsert_json("settings", "library", &settings);
    }
    if let Ok(vocab) = state.vocab.lock() {
        for e in &vocab.list {
            if let Ok(v) = serde_json::to_value(e) {
                let _ = db.upsert_json("vocab", &format!("{}:{}", e.lang, e.word), &v);
            }
        }
    }
    if let Ok(stats) = state.stats.lock() {
        for (&(day, hour, book), &(secs, words)) in &stats.map {
            let bucket = ReadBucket {
                day,
                hour,
                book,
                secs,
                words,
            };
            if let Ok(v) = serde_json::to_value(&bucket) {
                let _ = db.upsert_json("reading_bucket", &format!("{day}:{hour}:{book}"), &v);
            }
        }
    }
}

fn sync_settings_from_db(db: &db::AppDb) -> SyncSettings {
    SyncSettings {
        url: db
            .metadata("sync_url")
            .unwrap_or_else(|| DEFAULT_SYNC_URL.to_string()),
        token: db.metadata("sync_token").unwrap_or_default(),
        username: db.metadata("sync_username").unwrap_or_default(),
        user_id: db.metadata("sync_user_id").unwrap_or_default(),
        last_sync_at: db
            .metadata("sync_last_sync_at")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0),
    }
}

fn save_auth_response(db: &db::AppDb, res: &AuthResponse) -> Result<(), String> {
    if res.token.trim().is_empty() {
        return Err("服务器没有返回登录 token".into());
    }
    db.set_metadata("sync_token", res.token.trim())?;
    db.set_metadata("sync_username", res.user.username.trim())?;
    db.set_metadata("sync_user_id", res.user.id.trim())?;
    Ok(())
}

fn auth_request_inner(
    state: &AppState,
    endpoint: &str,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    let base = if url.trim().is_empty() {
        DEFAULT_SYNC_URL.to_string()
    } else {
        url.trim().trim_end_matches('/').to_string()
    };
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".into());
    }
    {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.set_metadata("sync_url", &base)?;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let body = serde_json::json!({
        "username": username,
        "password": password,
    });
    let res: AuthResponse = agent
        .post(&format!("{base}{endpoint}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("认证请求失败：{e}"))?
        .into_json()
        .map_err(|e| format!("认证返回解析失败：{e}"))?;
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    save_auth_response(db, &res)?;
    Ok(res)
}

fn apply_sqlite_to_runtime(state: &AppState) {
    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    let Ok(items) = db.all_sync_entities() else {
        return;
    };
    let mut books: Vec<book::Book> = Vec::new();
    let mut vocab: Vec<VocabEntry> = Vec::new();
    let mut buckets: Vec<ReadBucket> = Vec::new();
    for item in items {
        if item.deleted_at != 0 {
            continue;
        }
        match item.kind.as_str() {
            "book" => {
                if let Ok(b) = serde_json::from_value::<book::Book>(item.json.clone()) {
                    books.push(b);
                }
            }
            "vocab" => {
                if let Ok(v) = serde_json::from_value::<VocabEntry>(item.json.clone()) {
                    vocab.push(v);
                }
            }
            "reading_bucket" => {
                if let Ok(b) = serde_json::from_value::<ReadBucket>(item.json.clone()) {
                    buckets.push(b);
                }
            }
            _ => {}
        }
    }
    if !books.is_empty() {
        if let Ok(mut lib) = state.library.lock() {
            books.sort_by(|a, b| {
                b.last_read_at
                    .cmp(&a.last_read_at)
                    .then_with(|| a.title.cmp(&b.title))
            });
            lib.books = books;
            lib.save();
        }
    }
    if let Ok(mut vs) = state.vocab.lock() {
        vs.list = vocab;
        vs.save();
    }
    if let Ok(mut st) = state.stats.lock() {
        st.map.clear();
        for b in buckets {
            st.map.insert((b.day, b.hour, b.book), (b.secs, b.words));
        }
        st.dirty = true;
        st.save();
    }
}

#[tauri::command]
fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(sync_settings_from_db(db))
}

#[tauri::command]
fn sync_set_settings(
    state: tauri::State<AppState>,
    url: String,
    token: String,
) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    db.set_metadata("sync_url", url.trim().trim_end_matches('/'))?;
    db.set_metadata("sync_token", token.trim())?;
    Ok(sync_settings_from_db(db))
}

#[tauri::command]
fn auth_logout(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    db.set_metadata("sync_token", "")?;
    db.set_metadata("sync_username", "")?;
    db.set_metadata("sync_user_id", "")?;
    Ok(sync_settings_from_db(db))
}

#[tauri::command]
async fn auth_register(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/register", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

#[tauri::command]
async fn auth_login(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/login", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

fn sync_now_inner(state: &AppState) -> Result<SyncReport, String> {
    migrate_json_to_sqlite(state);
    let (settings, device_id, entities) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        let settings = sync_settings_from_db(db);
        if settings.url.trim().is_empty() || settings.token.trim().is_empty() {
            return Err("请先登录账号".into());
        }
        (settings, db.device_id(), db.all_sync_entities()?)
    };
    let base = settings.url.trim().trim_end_matches('/').to_string();
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let push_body = serde_json::json!({
        "device_id": device_id,
        "entities": entities,
    });
    let push: SyncPushResponse = agent
        .post(&format!("{base}/sync/push"))
        .set("Authorization", &format!("Bearer {}", settings.token))
        .set("Content-Type", "application/json")
        .send_json(push_body)
        .map_err(|e| format!("push 失败：{e}"))?
        .into_json()
        .map_err(|e| format!("push 返回解析失败：{e}"))?;

    let pull: SyncPullResponse = agent
        .get(&format!("{base}/sync/pull"))
        .query("since", &settings.last_sync_at.to_string())
        .set("Authorization", &format!("Bearer {}", settings.token))
        .call()
        .map_err(|e| format!("pull 失败：{e}"))?
        .into_json()
        .map_err(|e| format!("pull 返回解析失败：{e}"))?;

    let (pulled, server_time) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        if !push.entities.is_empty() {
            let _ = db.import_sync_entities(&push.entities)?;
        }
        let pulled = db.import_sync_entities(&pull.entities)?;
        let server_time = push.server_time.max(pull.server_time);
        db.set_metadata("sync_last_sync_at", &server_time.to_string())?;
        (pulled, server_time)
    };
    apply_sqlite_to_runtime(state);
    Ok(SyncReport {
        ok: true,
        message: format!(
            "同步完成：推送 {} 条，服务端接受 {} 条，忽略 {} 条，拉取 {} 条",
            entities.len(),
            push.accepted_count,
            push.ignored_count,
            pulled
        ),
        pushed: entities.len(),
        pulled: pulled as usize,
        server_time,
    })
}

#[tauri::command]
async fn sync_now(app: tauri::AppHandle) -> Result<SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        sync_now_inner(state.inner())
    })
    .await
    .map_err(|e| format!("同步任务失败：{e}"))?
}

#[tauri::command]
fn migrate_data_to_sqlite(state: tauri::State<AppState>) -> Result<(), String> {
    migrate_json_to_sqlite(state.inner());
    Ok(())
}

#[tauri::command]
fn export_data_package(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    migrate_json_to_sqlite(state.inner());
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

// ---- 检查更新：后端发请求（避免前端跨域被拦），方便以后扩展多个源 ----
const GITHUB_REPO: &str = "pigking9527-cmyk/kunpeng-reader";
const UPDATE_MANIFEST_URL: &str = "http://sync.example.invalid/kunpeng-reader/update.json";

#[derive(Serialize, Default)]
struct UpdateInfo {
    ok: bool,         // 是否成功联网取到信息
    current: String,  // 当前版本（去掉前导 v）
    latest: String,   // 最新版本（去掉前导 v）
    notes: String,    // 最新版更新说明
    url: String,      // 下载/发布页（来自命中的源）
    source: String,   // 命中的源（目前 github）
    has_update: bool, // 是否有更新
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(6))
        .timeout_read(std::time::Duration::from_secs(8))
        .build()
}

/// 版本号比较：a 比 b 新返回 true（如 1.6.0 > 1.5.0）。
fn ver_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split('.')
            .map(|x| x.trim().parse().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0),
            pb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

fn fetch_json(agent: &ureq::Agent, url: &str) -> Option<serde_json::Value> {
    agent
        .get(url)
        .set("User-Agent", "kunpeng-reader")
        .set("Accept", "application/json")
        .call()
        .ok()?
        .into_json::<serde_json::Value>()
        .ok()
}

fn rel_tag(v: &serde_json::Value) -> String {
    v.get("tag_name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("version").and_then(|x| x.as_str()))
        .or_else(|| v.get("latest").and_then(|x| x.as_str()))
        .or_else(|| v.get("name").and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn rel_notes(v: &serde_json::Value) -> String {
    v.get("body")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("notes").and_then(|x| x.as_str()))
        .or_else(|| v.get("release_notes").and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn rel_url(v: &serde_json::Value, fallback: &str) -> String {
    v.get("html_url")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("url").and_then(|x| x.as_str()))
        .or_else(|| v.get("download_url").and_then(|x| x.as_str()))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

#[tauri::command]
async fn check_update() -> UpdateInfo {
    tokio::task::spawn_blocking(check_update_blocking)
        .await
        .unwrap_or_default()
}

fn check_update_blocking() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let agent = http_agent();
    let sources = [
        (
            "github",
            format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest"),
            format!("https://github.com/{GITHUB_REPO}/releases/latest"),
        ),
        (
            "server",
            UPDATE_MANIFEST_URL.to_string(),
            UPDATE_MANIFEST_URL.to_string(),
        ),
    ];
    for (name, api, page) in sources {
        if let Some(v) = fetch_json(&agent, &api) {
            let tag = rel_tag(&v);
            if tag.is_empty() {
                continue;
            }
            let latest = tag.trim_start_matches(['v', 'V']).to_string();
            let notes = rel_notes(&v);
            let url = rel_url(&v, &page);
            return UpdateInfo {
                ok: true,
                has_update: ver_gt(&latest, &current),
                latest,
                notes,
                url,
                source: name.to_string(),
                current,
            };
        }
    }
    UpdateInfo {
        current,
        ..Default::default()
    }
}

/// 取某个版本（tag）的更新说明，供"关于"里"本版更新内容"用。多源尝试，失败返回空串。
#[tauri::command]
async fn release_notes(tag: String) -> String {
    tokio::task::spawn_blocking(move || release_notes_blocking(&tag))
        .await
        .unwrap_or_default()
}

fn release_notes_blocking(tag: &str) -> String {
    let agent = http_agent();
    let urls = [
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}"),
        UPDATE_MANIFEST_URL.to_string(),
    ];
    let want = tag.trim_start_matches(['v', 'V']);
    for url in urls {
        if let Some(v) = fetch_json(&agent, &url) {
            let got = rel_tag(&v);
            if !got.is_empty() && got.trim_start_matches(['v', 'V']) != want {
                continue;
            }
            let notes = rel_notes(&v);
            if !notes.is_empty() {
                return notes;
            }
        }
    }
    String::new()
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

// ---- 自动导入目录 ----
#[derive(Serialize)]
struct AutoImportCfg {
    enabled: bool,
    dirs: Vec<String>,
}

/// 递归扫描目录里支持的电子书文件（限深 8 层，防符号链接/超深目录）。
fn scan_dir_books(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, depth: u32) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            scan_dir_books(&p, out, depth + 1);
        } else if matches!(
            book::ext_lower(&p).as_str(),
            "epub" | "pdf" | "txt" | "md" | "markdown" | "mobi" | "azw3" | "azw"
        ) {
            out.push(p);
        }
    }
}

/// 把自动导入目录里的新书加入书架（已存在的由 lib.add 去重）。返回是否有新增。
/// 关键：扫描目录、过滤已知书都在锁外做，绝不在持锁状态下遍历整个目录，
/// 否则封面等请求会因为抢不到书架锁而一直加载不出来（稳态下根本不取写锁）。
fn run_auto_import(state: &AppState) -> bool {
    use std::collections::HashSet;
    // 1) 短暂持锁，取出目录列表 + 已知书的路径集合
    let (dirs, known): (Vec<String>, HashSet<std::path::PathBuf>) = {
        let lib = state.library.lock().unwrap();
        if !lib.auto_import_enabled {
            return false;
        }
        (
            lib.auto_import_dirs.clone(),
            lib.books.iter().map(|b| b.path.clone()).collect(),
        )
    };
    if dirs.is_empty() {
        return false;
    }
    // 2) 锁外扫描目录
    let mut found = Vec::new();
    for d in &dirs {
        scan_dir_books(std::path::Path::new(d), &mut found, 0);
    }
    // 3) 锁外过滤掉路径已在书架里的（稳态：没有新文件 → 候选为空，下面整段都不取写锁）
    let candidates: Vec<std::path::PathBuf> =
        found.into_iter().filter(|p| !known.contains(p)).collect();
    if candidates.is_empty() {
        return false;
    }
    // 4) 只为真正的新书逐本短暂持锁，给封面等请求留出穿插的间隙
    let mut changed = false;
    for p in candidates {
        let mut lib = state.library.lock().unwrap();
        if lib.add(p) {
            changed = true;
        }
    }
    if changed {
        state.library.lock().unwrap().save();
    }
    changed
}

#[tauri::command]
fn get_auto_import(state: tauri::State<AppState>) -> AutoImportCfg {
    let lib = state.library.lock().unwrap();
    AutoImportCfg {
        enabled: lib.auto_import_enabled,
        dirs: lib.auto_import_dirs.clone(),
    }
}

/// 设置自动导入开关 / 目录列表。改完立即扫描一次并返回更新后的书单。
#[tauri::command]
async fn set_auto_import(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    dirs: Vec<String>,
) -> Result<Vec<BookDto>, String> {
    {
        let mut lib = state.library.lock().unwrap();
        lib.auto_import_enabled = enabled;
        // 去重 + 去空
        let mut seen = std::collections::HashSet::new();
        lib.auto_import_dirs = dirs
            .into_iter()
            .filter(|d| !d.trim().is_empty() && seen.insert(d.clone()))
            .collect();
        lib.auto_import_dir = None; // 清掉已迁移的旧字段
        lib.save();
    }
    run_auto_import(state.inner());
    Ok(snapshot(&state.library.lock().unwrap()))
}

/// 启动/回到书架时调用：若开启自动导入则扫描目录，返回最新书单。
#[tauri::command]
async fn auto_import_scan(app: tauri::AppHandle) -> Result<Vec<BookDto>, ()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_auto_import(state.inner());
        let books = snapshot(&state.library.lock().unwrap());
        books
    })
    .await
    .map_err(|_| ())
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
        highlights,
    })
}

/// 从阅读窗口 label 取图书 id。
fn reader_window_id(window: &tauri::WebviewWindow) -> Option<u64> {
    window
        .label()
        .strip_prefix("reader-")
        .and_then(|s| s.parse().ok())
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
fn set_description(
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
fn set_rating(window: tauri::WebviewWindow, state: tauri::State<AppState>, rating: f32) {
    if let Some(id) = reader_window_id(&window) {
        let mut lib = state.library.lock().unwrap();
        lib.set_rating(id, rating);
        lib.save();
    }
}

/// 新增一处高亮/批注，返回该书全部高亮。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_highlight(
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
fn remove_highlight(
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
fn set_highlight_note(
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
        s.total_words += b.words_read; // 真正读过的字数（逐页+停留计入），不再用"进度×字数"高估
        if b.progress > 0.5 {
            s.started += 1;
        }
        if b.progress >= 99.0 {
            s.finished += 1;
        }
    }
    s
}

// ===========================================================================
//  详细阅读统计：按 (本地日 yyyymmdd, 小时 0–23, 书 id) 累成"小时桶"。
//  日/月/年/总 全部由桶按日期区间聚合得到；高亮/批注用其 created_at，读完用书的 finished_at。
// ===========================================================================
#[derive(Serialize, Deserialize, Clone)]
struct ReadBucket {
    day: u32,
    hour: u8,
    book: u64,
    secs: u32,
    words: u32,
}
#[derive(Default)]
struct StatsStore {
    map: HashMap<(u32, u8, u64), (u32, u32)>, // (day,hour,book) -> (secs,words)
    dirty: bool,
}
fn stats_path() -> Option<std::path::PathBuf> {
    let mut d = dirs::config_dir()?; // 和 library.json 同处（%APPDATA%），属持久用户数据
    d.push("ebook-reader");
    Some(d.join("stats.json"))
}
fn local_day_hour() -> (u32, u8) {
    use chrono::{Datelike, Local, Timelike};
    let n = Local::now();
    (
        n.year() as u32 * 10000 + n.month() * 100 + n.day(),
        n.hour() as u8,
    )
}
fn unix_to_local_day(secs: u64) -> u32 {
    use chrono::{Datelike, Local, TimeZone};
    match Local.timestamp_opt(secs as i64, 0).single() {
        Some(t) => t.year() as u32 * 10000 + t.month() * 100 + t.day(),
        None => 0,
    }
}
impl StatsStore {
    fn load() -> Self {
        let mut s = StatsStore::default();
        if let Some(p) = stats_path() {
            if let Ok(txt) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Vec<ReadBucket>>(&txt) {
                    for b in v {
                        s.map.insert((b.day, b.hour, b.book), (b.secs, b.words));
                    }
                }
            }
        }
        s
    }
    fn add(&mut self, book: u64, secs: u32, words: u32) {
        let (day, hour) = local_day_hour();
        let e = self.map.entry((day, hour, book)).or_insert((0, 0));
        e.0 = e.0.saturating_add(secs);
        e.1 = e.1.saturating_add(words);
        self.dirty = true;
    }
    fn save(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(p) = stats_path() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let v: Vec<ReadBucket> = self
                .map
                .iter()
                .map(|(&(day, hour, book), &(secs, words))| ReadBucket {
                    day,
                    hour,
                    book,
                    secs,
                    words,
                })
                .collect();
            if let Ok(j) = serde_json::to_string(&v) {
                let _ = std::fs::write(p, j);
            }
        }
        self.dirty = false;
    }
}

#[derive(Serialize)]
struct BookStat {
    id: String,
    title: String,
    seconds: u64,
    words: u64,
    highlights: u32,
    notes: u32,
    finished: bool,
}
#[derive(Serialize)]
struct DayStat {
    day: u32,
    seconds: u64,
}
#[derive(Serialize)]
struct StatsRange {
    total_seconds: u64,
    total_words: u64,
    hours: Vec<u64>,         // 24 个，时段分布
    days: Vec<DayStat>,      // 该区间每个有阅读的天
    books: Vec<BookStat>,    // 该区间读过的书（按时长降序）
    finished: Vec<BookStat>, // 该区间读完的书
    book_count: u32,
    finished_count: u32,
    total_highlights: u32,
    total_notes: u32,
}

/// 按本地日期区间 [from,to]（yyyymmdd）聚合阅读统计。日/月/年/总都用它，前端算好区间即可。
#[tauri::command]
fn reading_stats_range(state: tauri::State<AppState>, from: u32, to: u32) -> StatsRange {
    let stats = state.stats.lock().unwrap();
    let lib = state.library.lock().unwrap();
    let mut hours = vec![0u64; 24];
    let mut per_book: HashMap<u64, (u64, u64)> = HashMap::new(); // book -> (secs, words)
    let mut per_day: HashMap<u32, u64> = HashMap::new();
    let mut total_seconds = 0u64;
    let mut total_words = 0u64;
    for (&(day, hour, book), &(secs, words)) in stats.map.iter() {
        if day < from || day > to {
            continue;
        }
        total_seconds += secs as u64;
        total_words += words as u64;
        hours[hour.min(23) as usize] += secs as u64;
        *per_day.entry(day).or_insert(0) += secs as u64;
        let e = per_book.entry(book).or_insert((0, 0));
        e.0 += secs as u64;
        e.1 += words as u64;
    }
    // 高亮/批注（按 created_at 落在区间）与"读完"，从书库取
    let title_of = |id: u64| {
        lib.get(id)
            .map(|b| b.title.clone())
            .unwrap_or_else(|| "（已删除）".into())
    };
    let mut hl_count: HashMap<u64, (u32, u32)> = HashMap::new(); // book -> (highlights, notes)
    let mut total_highlights = 0u32;
    let mut total_notes = 0u32;
    for b in &lib.books {
        for h in &b.highlights {
            let d = unix_to_local_day(h.created_at);
            if d >= from && d <= to {
                let e = hl_count.entry(b.id).or_insert((0, 0));
                e.0 += 1;
                total_highlights += 1;
                if !h.note.trim().is_empty() {
                    e.1 += 1;
                    total_notes += 1;
                }
            }
        }
    }
    let finished_in_range: std::collections::HashSet<u64> = lib
        .books
        .iter()
        .filter(|b| {
            b.finished_at > 0 && {
                let d = unix_to_local_day(b.finished_at);
                d >= from && d <= to
            }
        })
        .map(|b| b.id)
        .collect();
    let mk = |id: u64, secs: u64, words: u64| {
        let (hl, nt) = hl_count.get(&id).copied().unwrap_or((0, 0));
        BookStat {
            id: id.to_string(),
            title: title_of(id),
            seconds: secs,
            words,
            highlights: hl,
            notes: nt,
            finished: finished_in_range.contains(&id),
        }
    };
    let mut books: Vec<BookStat> = per_book.iter().map(|(&id, &(s, w))| mk(id, s, w)).collect();
    books.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    let finished: Vec<BookStat> = finished_in_range
        .iter()
        .map(|&id| {
            let (s, w) = per_book.get(&id).copied().unwrap_or((0, 0));
            mk(id, s, w)
        })
        .collect();
    let mut days: Vec<DayStat> = per_day
        .into_iter()
        .map(|(day, seconds)| DayStat { day, seconds })
        .collect();
    days.sort_by_key(|d| d.day);
    StatsRange {
        total_seconds,
        total_words,
        hours,
        days,
        book_count: books.len() as u32,
        finished_count: finished.len() as u32,
        books,
        finished,
        total_highlights,
        total_notes,
    }
}

/// 阅读窗口定时上报阅读时长（秒）。
#[tauri::command]
async fn add_reading_time(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    seconds: u64,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        {
            let mut lib = state.library.lock().unwrap();
            if let Some(b) = lib.books.iter_mut().find(|b| b.id == id) {
                b.reading_seconds += seconds;
            }
            lib.save();
        }
        let mut st = state.stats.lock().unwrap();
        st.add(id, seconds as u32, 0); // 累进当前小时桶
        st.save(); // 15 秒一次，文件很小
    }
    Ok(())
}

/// 阅读窗口上报"真正读过"的字数：仅停留若干秒、且逐页翻过的页才会累加（前端判定）。
#[tauri::command]
async fn add_read_words(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    words: u64,
) -> Result<(), ()> {
    if words == 0 {
        return Ok(());
    }
    if let Some(id) = reader_window_id(&window) {
        {
            let mut lib = state.library.lock().unwrap();
            if let Some(b) = lib.books.iter_mut().find(|b| b.id == id) {
                b.words_read += words;
            }
            lib.save();
        }
        state.stats.lock().unwrap().add(id, 0, words as u32); // 累进字数（落盘交给 15s 的 add_reading_time）
    }
    Ok(())
}

/// 每本书的"页数缓存"：版式签名 + 各章页数。版式（窗口尺寸/字体/边距…）一致就直接复用，免重算。
#[derive(Serialize, Deserialize)]
struct PageCacheData {
    sig: String,
    pages: Vec<u32>,
}
fn pages_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("pages");
    Some(d)
}
fn page_cache_path(id: u64) -> Option<std::path::PathBuf> {
    Some(pages_dir()?.join(format!("{id}.json")))
}
/// 读取这本书已缓存的页数（阅读窗口就绪后取，交给合并页判断版式是否一致）。
#[tauri::command]
fn get_page_cache(window: tauri::WebviewWindow) -> Option<PageCacheData> {
    let id = reader_window_id(&window)?;
    let s = std::fs::read_to_string(page_cache_path(id)?).ok()?;
    serde_json::from_str(&s).ok()
}
/// 合并页测完整书页数后落盘缓存。
#[tauri::command]
fn save_page_cache(window: tauri::WebviewWindow, sig: String, pages: Vec<u32>) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        if let Some(p) = page_cache_path(id) {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            if let Ok(j) = serde_json::to_string(&PageCacheData { sig, pages }) {
                let _ = std::fs::write(p, j);
            }
        }
    }
    Ok(())
}

/// 每本 PDF 的视图状态：缩放倍数 + 是否双页。让 PDF 记住自己上次的缩放。
#[derive(Serialize, Deserialize)]
struct PdfState {
    scale: f32,
    dual: bool,
}
fn pdf_state_path(id: u64) -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("pdfstate");
    Some(d.join(format!("{id}.json")))
}
/// 读取这本 PDF 上次的缩放/双页状态（打开时取，用来恢复视图）。
#[tauri::command]
fn get_pdf_state(window: tauri::WebviewWindow) -> Option<PdfState> {
    let id = reader_window_id(&window)?;
    let s = std::fs::read_to_string(pdf_state_path(id)?).ok()?;
    serde_json::from_str(&s).ok()
}
/// 保存这本 PDF 的缩放/双页状态（缩放或切换双页时调用）。
#[tauri::command]
fn set_pdf_state(window: tauri::WebviewWindow, scale: f32, dual: bool) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        if let Some(p) = pdf_state_path(id) {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            if let Ok(j) = serde_json::to_string(&PdfState { scale, dual }) {
                let _ = std::fs::write(p, j);
            }
        }
    }
    Ok(())
}

/// 在系统默认浏览器打开一个 URL（用于"关于"里的 GitHub 链接，不在 WebView 里跳转）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("非法链接".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", u])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(u)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ===========================================================================
//  edge-tts：用微软 Edge 在线朗读端点合成（免费、Azure 级中文音色）。
//  返回整段 MP3(base64) + 词边界时间戳，前端播放并按时间高亮当前词。
// ===========================================================================
#[derive(Serialize)]
struct TtsMark {
    at: u32, // 音频时间(ms)
    word: String,
}
#[derive(Serialize)]
struct TtsAudio {
    audio: String, // base64 mp3
    marks: Vec<TtsMark>,
}
const EDGE_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
fn sha256_upper(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02X}")).collect()
}
fn sec_ms_gec() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut ticks = now + 11_644_473_600; // Windows 纪元偏移
    ticks -= ticks % 300; // 向下取整到 5 分钟
    let ticks = (ticks as u128) * 10_000_000; // 转 100ns
    sha256_upper(&format!("{ticks}{EDGE_TOKEN}"))
}

#[tauri::command]
async fn edge_tts(text: String, voice: String, rate: i32) -> Result<TtsAudio, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let voice = if voice.trim().is_empty() {
        "zh-CN-XiaoxiaoNeural".to_string()
    } else {
        voice
    };
    let gec = sec_ms_gec();
    // ConnectionId：每次连接唯一的 32 位十六进制（缺它/版本过旧都会 403）
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let cid = sha256_upper(&format!("{nanos}conn"))[..32].to_lowercase();
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={EDGE_TOKEN}&ConnectionId={cid}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-143.0.3650.75"
    );
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    {
        let h = req.headers_mut();
        h.insert("Pragma", "no-cache".parse().unwrap());
        h.insert("Cache-Control", "no-cache".parse().unwrap());
        h.insert(
            "Origin",
            "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
                .parse()
                .unwrap(),
        );
        h.insert(
            "Accept-Encoding",
            "gzip, deflate, br, zstd".parse().unwrap(),
        );
        h.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
        h.insert("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0".parse().unwrap());
    }
    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("连接微软语音失败：{e}"))?;

    let ts = chrono::Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string();
    let cfg = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    let config_msg = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{cfg}"
    );
    ws.send(Message::Text(config_msg))
        .await
        .map_err(|e| e.to_string())?;

    let rid = sha256_upper(&format!("{ts}{text}"))[..32].to_lowercase();
    let safe = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='{voice}'><prosody pitch='+0Hz' rate='{rate:+}%' volume='+0%'>{safe}</prosody></voice></speak>"
    );
    let ssml_msg = format!(
        "X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}\r\nPath:ssml\r\n\r\n{ssml}"
    );
    ws.send(Message::Text(ssml_msg))
        .await
        .map_err(|e| e.to_string())?;

    let mut audio: Vec<u8> = Vec::new();
    let mut marks: Vec<TtsMark> = Vec::new();
    while let Some(msg) = ws.next().await {
        match msg.map_err(|e| e.to_string())? {
            Message::Text(t) => {
                if t.contains("Path:turn.end") {
                    break;
                }
                if t.contains("Path:audio.metadata") {
                    if let Some(idx) = t.find("\r\n\r\n") {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t[idx + 4..]) {
                            if let Some(arr) = v.get("Metadata").and_then(|m| m.as_array()) {
                                for it in arr {
                                    if it.get("Type").and_then(|x| x.as_str())
                                        == Some("WordBoundary")
                                    {
                                        let off = it
                                            .pointer("/Data/Offset")
                                            .and_then(|x| x.as_u64())
                                            .unwrap_or(0);
                                        let word = it
                                            .pointer("/Data/text/Text")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        marks.push(TtsMark {
                                            at: (off / 10000) as u32,
                                            word,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Message::Binary(b) => {
                if b.len() >= 2 {
                    let hlen = ((b[0] as usize) << 8) | (b[1] as usize);
                    let start = 2 + hlen;
                    if start <= b.len() {
                        audio.extend_from_slice(&b[start..]);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    if audio.is_empty() {
        return Err("没有取到音频（可能网络/地区限制）".into());
    }
    use base64::Engine;
    Ok(TtsAudio {
        audio: base64::engine::general_purpose::STANDARD.encode(&audio),
        marks,
    })
}

fn word_tts_cache_dir() -> Result<std::path::PathBuf, String> {
    let mut dir = dirs::config_dir().ok_or("无法确定用户配置目录")?;
    dir.push("ebook-reader");
    dir.push("word-tts-cache");
    Ok(dir)
}

fn word_tts_cache_path(word: &str) -> Result<std::path::PathBuf, String> {
    let key =
        sha256_upper(&format!("en-US-JennyNeural:{}", word.trim().to_lowercase())).to_lowercase();
    Ok(word_tts_cache_dir()?.join(format!("{key}.mp3")))
}

#[tauri::command]
async fn word_tts(text: String, cache: bool) -> Result<TtsAudio, String> {
    use base64::Engine;

    let word = text.trim();
    if word.is_empty() {
        return Err("单词为空".into());
    }
    let cache_path = word_tts_cache_path(word)?;
    if cache {
        if let Ok(audio) = std::fs::read(&cache_path) {
            if !audio.is_empty() {
                return Ok(TtsAudio {
                    audio: base64::engine::general_purpose::STANDARD.encode(audio),
                    marks: Vec::new(),
                });
            }
        }
    }

    let result = edge_tts(word.to_string(), "en-US-JennyNeural".into(), 0).await?;
    if cache {
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建语音缓存目录失败：{e}"))?;
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(&result.audio)
            .map_err(|e| format!("解码语音缓存失败：{e}"))?;
        std::fs::write(&cache_path, audio).map_err(|e| format!("写入语音缓存失败：{e}"))?;
    }
    Ok(result)
}

#[tauri::command]
fn word_tts_cache_size() -> u64 {
    let Ok(dir) = word_tts_cache_dir() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[tauri::command]
fn clear_word_tts_cache() -> Result<(), String> {
    let dir = word_tts_cache_dir()?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("mp3") {
            std::fs::remove_file(&path).map_err(|e| format!("删除语音缓存失败：{e}"))?;
        }
    }
    Ok(())
}

const FREQUENT_EN_10000: &str = include_str!("dict/frequent_en_10000.txt");

fn frequent_en_words() -> impl Iterator<Item = &'static str> {
    FREQUENT_EN_10000.lines().filter(|word| !word.is_empty())
}

#[derive(Serialize)]
struct WordTtsPackStatus {
    total: usize,
    cached: usize,
    bytes: u64,
    running: bool,
    current: String,
    message: String,
}

#[derive(Default)]
struct WordPackState {
    running: bool,
    stop: bool,
    current: String,
    message: String,
}

#[tauri::command]
fn word_tts_pack_status(state: tauri::State<AppState>) -> WordTtsPackStatus {
    let mut total = 0;
    let mut cached = 0;
    let mut bytes = 0;
    for word in frequent_en_words() {
        total += 1;
        if let Ok(path) = word_tts_cache_path(word) {
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.is_file() && meta.len() > 0 {
                    cached += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    let pack = state.word_pack.lock().unwrap();
    WordTtsPackStatus {
        total,
        cached,
        bytes,
        running: pack.running,
        current: pack.current.clone(),
        message: pack.message.clone(),
    }
}

#[tauri::command]
fn word_tts_pack_missing() -> Vec<String> {
    frequent_en_words()
        .filter(|word| {
            word_tts_cache_path(word)
                .ok()
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|meta| !meta.is_file() || meta.len() == 0)
                .unwrap_or(true)
        })
        .map(str::to_string)
        .collect()
}

#[tauri::command]
fn clear_word_tts_pack() -> Result<(), String> {
    for word in frequent_en_words() {
        let path = word_tts_cache_path(word)?;
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| format!("删除高频词语音包失败：{e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn pause_word_tts_pack(state: tauri::State<AppState>) {
    let mut pack = state.word_pack.lock().unwrap();
    pack.stop = true;
    if pack.running {
        pack.message = "正在暂停，当前请求完成后停止…".into();
    }
}

#[tauri::command]
fn start_word_tts_pack(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut pack = state.word_pack.lock().unwrap();
        if pack.running {
            return Ok(());
        }
        pack.running = true;
        pack.stop = false;
        pack.current.clear();
        pack.message = "准备生成…".into();
    }

    tauri::async_runtime::spawn(async move {
        use base64::Engine;

        for word in frequent_en_words() {
            let state = app.state::<AppState>();
            {
                let mut pack = state.word_pack.lock().unwrap();
                if pack.stop {
                    pack.running = false;
                    pack.current.clear();
                    pack.message = "已暂停".into();
                    return;
                }
                pack.current = word.to_string();
                pack.message = format!("生成中：{word}");
            }

            let path = match word_tts_cache_path(word) {
                Ok(p) => p,
                Err(err) => {
                    let mut pack = state.word_pack.lock().unwrap();
                    pack.message = err;
                    continue;
                }
            };
            if path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                continue;
            }

            loop {
                let state = app.state::<AppState>();
                if state.word_pack.lock().unwrap().stop {
                    let mut pack = state.word_pack.lock().unwrap();
                    pack.running = false;
                    pack.current.clear();
                    pack.message = "已暂停".into();
                    return;
                }
                match edge_tts(word.to_string(), "en-US-JennyNeural".into(), 0).await {
                    Ok(result) => {
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        match base64::engine::general_purpose::STANDARD.decode(&result.audio) {
                            Ok(audio) => {
                                let _ = std::fs::write(&path, audio);
                                break;
                            }
                            Err(err) => {
                                let mut pack = state.word_pack.lock().unwrap();
                                pack.message = format!("解码失败：{word} · {err}");
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        {
                            let mut pack = state.word_pack.lock().unwrap();
                            pack.message = format!("请求失败：{word} · 3 秒后重试");
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                }
            }
        }

        let state = app.state::<AppState>();
        let mut pack = state.word_pack.lock().unwrap();
        pack.running = false;
        pack.stop = false;
        pack.current.clear();
        pack.message = "已完成".into();
    });
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
    size: u64,   // 文件字节数
    rating: f32, // 用户评分 0~5（0.5 刻度）
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
            pdf_word_count(&book_clone.path)
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
        let a = pdf_author(&book_clone.path);
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

/// PDF 字数：抽取每页文本，统计非空白字符数。
fn pdf_word_count(path: &Path) -> u64 {
    extract_pdf_pages(path)
        .iter()
        .map(|s| s.chars().filter(|c| !c.is_whitespace()).count() as u64)
        .sum()
}

/// 从 PDF 的 Info 字典读 /Author（支持 UTF-16BE BOM 与普通编码）。读不到返回空串。
fn pdf_author(path: &Path) -> String {
    let Ok(doc) = lopdf::Document::load(path) else {
        return String::new();
    };
    let Ok(info_obj) = doc.trailer.get(b"Info") else {
        return String::new();
    };
    let dict = match info_obj.as_reference().and_then(|r| doc.get_dictionary(r)) {
        Ok(d) => d,
        Err(_) => match info_obj.as_dict() {
            Ok(d) => d,
            Err(_) => return String::new(),
        },
    };
    match dict.get(b"Author") {
        Ok(lopdf::Object::String(bytes, _)) => decode_pdf_string(bytes),
        _ => String::new(),
    }
}

/// 解码 PDF 文本串：FE FF 开头→UTF-16BE；否则按 Latin-1/UTF-8 兜底。
fn decode_pdf_string(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let u16s: Vec<u16> = b[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s).trim().to_string()
    } else if let Ok(s) = std::str::from_utf8(b) {
        s.trim().to_string()
    } else {
        b.iter()
            .map(|&c| c as char)
            .collect::<String>()
            .trim()
            .to_string()
    }
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
                .map(|b| (b.id, b.clone()))
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
                head = READER_PAGE_HEAD
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
                    format!("<div class=\"mobi-body\">{raw}</div>") // mobi 内容本就是 HTML，直接渲染
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
.rr{height:100vh;box-sizing:border-box;column-fill:auto;overflow-wrap:break-word;word-break:break-word;text-align:justify}
.rr img{max-width:100%;max-height:86vh;height:auto}
/* 任何内容都不得超过一栏宽，否则该栏会变宽、后续页码错位导致正文整体右移 */
.rr *{max-width:100%}
.rr pre{white-space:pre-wrap;word-break:break-word}
.rr table{table-layout:fixed;width:100%}
/* markdown 渲染样式 */
.md-body h1{font-size:1.6em;margin:.6em 0 .4em;font-weight:700;line-height:1.3}
.md-body h2{font-size:1.35em;margin:.6em 0 .4em;font-weight:700;line-height:1.3}
.md-body h3{font-size:1.15em;margin:.5em 0 .3em;font-weight:700}
.md-body h4,.md-body h5,.md-body h6{margin:.5em 0 .3em;font-weight:700}
.md-body p{margin:.5em 0}
.md-body ul,.md-body ol{margin:.4em 0;padding-left:1.6em}
.md-body li{margin:.2em 0}
.md-body blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid #bbb;color:#666}
.md-body code{font-family:Consolas,Menlo,monospace;background:rgba(135,131,120,.15);border-radius:4px;padding:.1em .3em;font-size:.92em}
.md-body pre{background:rgba(135,131,120,.12);border-radius:6px;padding:.7em .9em;overflow:auto;white-space:pre-wrap}
.md-body pre code{background:none;padding:0}
.md-body a{color:#2b6cff;text-decoration:none}
.md-body hr{border:none;border-top:1px solid #ccc;margin:1em 0}
.md-body table{border-collapse:collapse;width:auto}
.md-body th,.md-body td{border:1px solid #ccc;padding:4px 8px}
.md-body h1,.md-body h2,.md-body h3{break-after:avoid;-webkit-column-break-after:avoid}
body.theme-dark .md-body blockquote{color:#aaa;border-color:#555}
body.theme-dark .md-body code,body.theme-dark .md-body pre{background:rgba(255,255,255,.08)}
body.theme-dark .md-body hr{border-color:#444}
body.theme-dark .md-body th,body.theme-dark .md-body td{border-color:#555}
/* MOBI/AZW3：内容本就是 HTML；按记录号引用的图片无法解析 src，隐藏避免破图 */
.mobi-body img:not([src]){display:none}
.mobi-body p{margin:.5em 0}
.rr-end{break-before:column;-webkit-column-break-before:always;width:1px;height:1px;font-size:0}
#measurer{position:fixed;left:-99999px;top:0;overflow:hidden;pointer-events:none}
mark.search-hit{background:#ffe58a;color:inherit}
::highlight(tts){background:#ffd54a;color:#111}
mark.search-hit.cur{background:#ff9f40}
mark.hl{background:#fff3a0;color:inherit;border-radius:2px;cursor:pointer;box-shadow:inset 0 -2px 0 rgba(214,170,30,.5)}
mark.hl.has-note{box-shadow:inset 0 -2px 0 rgba(43,108,255,.6)}
#sel-menu{position:fixed;display:none;z-index:99999}
#sel-menu button{font:12px/1 system-ui,'Microsoft YaHei',sans-serif;color:#4a463e;background:#faf8f2;border:1px solid #e4ddcd;border-radius:6px;padding:5px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);white-space:nowrap}
#sel-menu button:hover{background:#f1ebdc}
#sel-menu button+button{margin-left:4px}
#hl-menu{position:fixed;display:none;z-index:99999}
#hl-menu button{font:12px/1 system-ui,'Microsoft YaHei',sans-serif;color:#4a463e;background:#faf8f2;border:1px solid #e4ddcd;border-radius:6px;padding:5px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);white-space:nowrap}
#hl-menu button:hover{background:#f1ebdc}
#hl-menu button+button{margin-left:4px}
#fn-pop{position:fixed;display:none;z-index:100001;left:8px;right:8px;max-height:58vh;overflow:auto;background:#fff7c0;border:1px solid #e6d77a;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:12px 16px 16px;font-size:16px;line-height:1.85;color:#3a3320;font-family:system-ui,'Microsoft YaHei',sans-serif}
#fn-pop .fn-close{float:right;cursor:pointer;color:#8a7a30;font-size:20px;line-height:1;margin:-2px -4px 0 10px}
#fn-pop .fn-body p{margin:0 0 .5em}
#fn-pop a{color:#2b6cff;text-decoration:none}
#dict-pop{position:fixed;display:none;z-index:100002;left:8px;right:8px;max-width:560px;margin:0 auto;max-height:52vh;overflow:auto;background:#fff;border:1px solid #e2e2e6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.28);padding:12px 16px 14px;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#222}
#dict-pop .dc-close{float:right;cursor:pointer;color:#aaa;font-size:18px;line-height:1;margin:-2px -4px 0 10px}
#dict-pop .dc-word{font-size:18px;font-weight:700;color:#1a1a1a}
#dict-pop .dc-phon{font-size:14px;color:#2b6cff;margin-left:8px;font-weight:400}
#dict-pop .dc-spk{cursor:pointer;margin-left:10px;font-size:16px;user-select:none;vertical-align:-1px}
#dict-pop .dc-spk:hover{opacity:.7}
#dict-pop .dc-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;padding-right:24px}
#dict-pop .dc-toggle{margin-left:auto;align-self:center;display:inline-flex;border:1px solid #d8d8de;border-radius:6px;overflow:hidden}
#dict-pop .dc-toggle .dt{cursor:pointer;font-size:12px;padding:2px 9px;color:#666;user-select:none}
#dict-pop .dc-toggle .dt.on{background:#2b6cff;color:#fff}
body.theme-dark #dict-pop .dc-toggle{border-color:#555}
body.theme-dark #dict-pop .dc-toggle .dt{color:#bbb}
#dict-pop .dc-def{font-size:15px;line-height:1.85;color:#333;margin-top:8px;text-align:left;text-align-last:left}
#dict-pop .dc-defblk{white-space:pre-wrap;margin-top:8px;text-align:left;text-align-last:left}
#dict-pop .dc-defblk:first-child{margin-top:0}
#dict-pop .dc-lb{display:inline-block;font-size:11px;color:#fff;background:#9aa3b2;border-radius:4px;padding:0 6px;margin-right:6px;vertical-align:2px}
#dict-pop .dc-miss{color:#999}
body.theme-dark #dict-pop .dc-def{color:#cfcfcf}
body.theme-dark #dict-pop{background:#2a2a2e;border-color:#444;color:#ddd}
body.theme-dark #dict-pop .dc-word{color:#fff}
body.theme-dark #dict-pop .dc-def{color:#cfcfcf}
body.theme-sepia #dict-pop{background:#fbf5e3;border-color:#e4ddcd}
#hl-note{position:fixed;display:none;z-index:100000;width:400px;max-width:92vw;background:#fffdf5;border:1px solid #e4ddcd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.22);padding:14px;font-family:system-ui,'Microsoft YaHei',sans-serif}
#hl-note .ctx{font-size:15px;line-height:1.8;color:#444;max-height:150px;overflow:auto;margin-bottom:10px;padding:10px 12px;background:#fbf5e3;border-radius:8px}
#hl-note .ctx mark.hl{background:#ffd95a;color:inherit;box-shadow:none}
#hl-note textarea{width:100%;box-sizing:border-box;font-size:16px;line-height:1.65;min-height:100px;border:1px solid #ddd;border-radius:8px;padding:10px;resize:vertical;font-family:inherit;outline:none}
#hl-note textarea:focus{border-color:#5aa0ff}
#hl-note .row{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
#hl-note button.act{font:14px/1 system-ui,'Microsoft YaHei',sans-serif;padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
#hl-note button.save{background:#2b6cff;color:#fff;border-color:#2b6cff}
#hl-note button.del{color:#c0392b;border-color:#e2b6ae;background:#fff}
</style>
<script>
var S={fontFamily:"",fontSize:18,lineHeight:1.7,paraSpacing:0.6,letterSpacing:0,marginTop:18,marginBottom:24,marginLeft:28,marginRight:28};
var root,pager,curCh=0,pageInCh=0,pagesInCh=1,pageStep=1,headSeen={},chapChars=0;
var downX=null,downY=null,didDrag=false;
var overlayOpen=false; // 外壳里搜索框/设置面板是否打开（打开时正文点击只用于关闭它）
var ttsOn=false,ttsMap=[],ttsText='',ttsSents=[],ttsVoice=null,ttsRate=1,ttsSi=0,ttsGen=0,ttsAudioEl=null,ttsCache={},ttsWaiting=-1,ttsPlayedAny=false; // 朗读状态
function userNav(){parent.postMessage({userNav:1},'*');} // 用户主动翻页（键盘/滚轮）通知外壳关闭浮层
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null,pageSig='';
// 版式签名：窗口尺寸+字体/字号/行距/段距/字间距/页边距 都一致才能复用缓存的页数
function layoutSig(){return [window.innerWidth,window.innerHeight,S.fontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight].join('|');}
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
  var c='.rr{padding:'+mg(S.marginTop)+'px '+mg(S.marginRight)+'px '+mg(S.marginBottom)+'px '+mg(S.marginLeft)+'px;';
  if(S.fontSize)c+='font-size:'+S.fontSize+'px;';
  if(S.lineHeight)c+='line-height:'+S.lineHeight+';';
  c+='letter-spacing:'+S.letterSpacing+'px;';
  if(S.fontFamily)c+='font-family:'+S.fontFamily+';';
  c+='}';
  if(S.fontFamily)c+='.rr *{font-family:'+S.fontFamily+' !important;}';
  if(S.lineHeight)c+='.rr p,.rr div,.rr li{line-height:'+S.lineHeight+';}';
  c+='.rr p{margin-top:0;margin-bottom:'+S.paraSpacing+'em;}';
  // 有些书给每个元素写死了内联 font-size（如本书 16px），会压过阅读器字号设置 → 让其继承（正文跟随设置）
  if(S.fontSize){
    c+='.rr [style*="font-size"]{font-size:inherit !important;}';
    c+='.rr h1{font-size:1.7em;} .rr h2{font-size:1.4em;} .rr h3{font-size:1.2em;} .rr h4{font-size:1.1em;}';
    c+='.rr sup,.rr sub{font-size:.75em;}'; // 上下标（注释角标）仍保持小一号
  }
  var bg='#fff',fg='#222';
  if(S.theme==='dark'){bg='#1c1c1e';fg='#d2d2d2';}
  else if(S.theme==='sepia'){bg='#f4ecd8';fg='#5b4636';}
  c+='html,body{background:'+bg+' !important;}';
  if(S.theme&&S.theme!=='light'){c+='.rr,.rr *{color:'+fg+' !important;}';}
  // 强制横排：有些书自带 -epub-writing-mode:vertical-rl（竖排），覆盖成横排左→右
  c+='html,body,.rr,.rr *{writing-mode:horizontal-tb !important;-webkit-writing-mode:horizontal-tb !important;-epub-writing-mode:horizontal-tb !important;text-orientation:mixed !important;}.rr{direction:ltr !important;}';
  st.textContent=c;
}
// 页边距夹到非负且有上限：负内边距会破坏分栏排版（正文溢出/整体变形）
function mg(v){v=parseInt(v,10);if(isNaN(v)||v<0)return 0;return v>240?240:v;}
function applyCols(){
  var vw=window.innerWidth, vh=window.innerHeight, ml=mg(S.marginLeft), mr=mg(S.marginRight), colW=Math.max(100, vw-ml-mr);
  root.style.height=vh+'px';root.style.columnWidth=colW+'px';root.style.columnGap=(ml+mr)+'px';
  // 末尾有一个强制分栏的占位空栏（rr-end），让滚动条能到达真正的最后一页；页数要减掉它
  pageStep=vw;pagesInCh=Math.max(1,Math.round(pager.scrollWidth/vw)-1);
}
function report(){
  var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  var gP=0,gT=0;
  if(measureDone){for(var i=0;i<CH;i++)gT+=chapterPages[i]||1;for(var j=0;j<curCh;j++)gP+=chapterPages[j]||1;gP+=pageInCh+1;}
  // 进度优先按“整书页位置”算（章节大小不均时仍平滑）；未测量完再退回按章节估算
  // 用 0 基：首页(gP=1)=0%、末页(gP=gT)=100%
  var prog;
  if(measureDone&&gT>0)prog=gT>1?((gP-1)/(gT-1))*100:0;
  else prog=CH>0?((curCh+chFrac)/CH)*100:0;
  var L=computeLogical();
  var pageChars=pagesInCh>0?Math.round(chapChars/pagesInCh):chapChars; // 当前页约略字数（按本章字数/页数均摊）
  parent.postMessage({chapter:curCh,chFrac:chFrac,page:pageInCh+1,total:pagesInCh,totalCh:CH,progress:prog,gPage:gP,gTotal:gT,logicalCh:L.lc,logicalTotal:L.lt,pageChars:pageChars},'*');
  // 注意：不在这里记录锚点。report() 也会被 relayout() 调到；若每次都重取锚点，
  // 拖动字号滑块时会把“重排后已偏移的顶部”当成新锚点，逐步累积漂移→整页跑掉。
  // 锚点只在用户“导航”（翻页/跳章/跳搜索命中）时更新，见 captureAnchor()。
}
// 记录当前页顶部锚点（精确到字符）。仅在用户主动导航后调用，供之后的重排锁定位置。
function captureAnchor(){curTopAnchor=topAnchor();}
function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=window.innerWidth,vh=window.innerHeight,colW=Math.max(100,vw-S.marginLeft-S.marginRight);
  measurer.style.width=vw+'px';measurer.style.height=vh+'px';measurer.style.columnWidth=colW+'px';measurer.style.columnGap=(S.marginLeft+S.marginRight)+'px';
  measurer.innerHTML=html;
  return Math.max(1,Math.round(measurer.scrollWidth/vw));
}
function measureAll(){
  if(measureDone&&pageSig===layoutSig())return; // 版式没变、已有页数 → 不重算
  var tok=++measureToken;measureDone=false;chapterPages=new Array(CH).fill(0);
  var i=0;
  function step(){
    if(tok!==measureToken)return;
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;pageSig=layoutSig();report();
      parent.postMessage({measured:{sig:pageSig,pages:chapterPages.slice()}},'*');return;} // 测完落盘缓存
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;chapterPages[i]=measureChapterPages(d.body||'');i++;setTimeout(step,0);
    }).catch(function(){chapterPages[i]=1;i++;setTimeout(step,0);});
  }
  step();
}
// 外壳送来缓存的页数：版式签名一致就直接采用，跳过测量
function applyPageCache(pc){
  if(!pc||!pc.pages||pc.pages.length!==CH)return;
  if(pc.sig!==layoutSig())return; // 版式变了，缓存作废，照常测量
  measureToken++; // 作废可能在跑的测量
  chapterPages=pc.pages.slice();measureDone=true;pageSig=pc.sig;
  if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
  report();
}
function scheduleMeasure(){if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,1200);}
// 滚动条按“全书页位置”精确定位：已测量完→映射到具体章+页（同章直接翻页，平滑；跨章才加载）；
// 未测量完→退回按章节粗跳。这样点滑块附近不再原地跳，拖动也能平滑跟随。
function gotoGlobalFrac(frac){
  frac=Math.max(0,Math.min(1,frac));
  if(measureDone){
    var gt=0,i;for(i=0;i<CH;i++)gt+=chapterPages[i]||1;if(gt<1)gt=1;
    var gp=Math.round(frac*(gt-1)),acc=0,tc=CH-1,tp=0;
    for(i=0;i<CH;i++){var cp=chapterPages[i]||1;if(gp<acc+cp){tc=i;tp=gp-acc;break;}acc+=cp;}
    if(tc===curCh)gotoPage(tp);else showChapter(tc,tp);
  }else{
    showChapter(Math.min(CH-1,Math.floor(frac*CH)),'start');
  }
}
function gotoPage(p){pageInCh=Math.max(0,Math.min(pagesInCh-1,p));pager.scrollLeft=pageInCh*pageStep;report();captureAnchor();}
function pageOf(el){var r=el.getBoundingClientRect(),pr=pager.getBoundingClientRect();var x=r.left-pr.left+pager.scrollLeft;return Math.floor((x+1)/pageStep);}
function showChapter(i,where,frag){
  i=Math.max(0,Math.min(CH-1,i));
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    curCh=i;if(d.head)injectHead(d.head,headSeen);root.innerHTML=(d.body||'')+'<div class="rr-end"></div>';chapChars=(root.textContent||'').replace(/\s/g,'').length;applyStyle();applyCols();applyHighlights();
    pageInCh=0;
    if(where==='end')pageInCh=pagesInCh-1;else if(typeof where==='number')pageInCh=Math.max(0,Math.min(pagesInCh-1,where));
    if(frag){var el=document.getElementById(frag);if(el)pageInCh=pageOf(el);}
    pager.scrollLeft=pageInCh*pageStep;report();captureAnchor();
  }).catch(function(){});
}
var curTopAnchor=null; // 实时记录的当前页顶部锚点（精确到字符）
// 视口左上角对应的"字符级"锚点。长段落跨多列时，元素级锚点的 left 是段首所在列，
// 会让重排后跳回段首（如金庸全集的超长段落）；用 caret 定位到具体字符即可避免。
function topAnchor(){
  var x=Math.max(2,(S.marginLeft||0)+8), y=Math.max(2,(S.marginTop||0)+8);
  var rng=null;
  if(document.caretRangeFromPoint){ rng=document.caretRangeFromPoint(x,y); }
  else if(document.caretPositionFromPoint){ var cp=document.caretPositionFromPoint(x,y); if(cp){rng=document.createRange();rng.setStart(cp.offsetNode,cp.offset);rng.collapse(true);} }
  if(rng){
    try{var n=rng.startContainer,o=rng.startOffset;if(n.nodeType===3&&o<n.nodeValue.length)rng.setEnd(n,o+1);}catch(e){}
    return {range:rng};
  }
  var el=document.elementFromPoint(x,y);
  while(el&&el!==root&&el.nodeType===1){ if((el.textContent||'').trim()) return {el:el}; el=el.parentNode; }
  return null;
}
function anchorValid(a){
  if(!a)return false;
  if(a.range){var n=a.range.startContainer;return !!(n&&n.isConnected);}
  if(a.el){return !!a.el.isConnected;}
  return false;
}
function anchorPage(a){
  var r=null;
  if(a.range){ r=a.range.getBoundingClientRect(); if(r&&!r.width&&!r.height&&!r.left&&!r.top){var rs=a.range.getClientRects();if(rs&&rs.length)r=rs[0];} }
  else if(a.el){ r=a.el.getBoundingClientRect(); }
  if(!r)return pageInCh;
  var pr=pager.getBoundingClientRect();
  var x=r.left-pr.left+pager.scrollLeft;
  return Math.max(0,Math.min(pagesInCh-1,Math.floor((x+1)/pageStep)));
}
function relayout(){
  if(!root)return;
  // 用"重排前"就记好的锚点（resize 时浏览器已先重排，临时再取就晚了）
  var anchor=anchorValid(curTopAnchor)?curTopAnchor:topAnchor();
  applyStyle();applyCols();
  if(anchor){ pageInCh=anchorPage(anchor); }
  else if(pageInCh>pagesInCh-1){ pageInCh=pagesInCh-1; }
  pager.scrollLeft=pageInCh*pageStep;report();
}
function nextPage(){if(pageInCh<pagesInCh-1)gotoPage(pageInCh+1);else if(curCh<CH-1)showChapter(curCh+1,'start');}
function prevPage(){if(pageInCh>0)gotoPage(pageInCh-1);else if(curCh>0)showChapter(curCh-1,'end');}
function reveal(){document.body.classList.add('ready');}
// ---- 高亮/批注 ----
var HL=[]; // 全书高亮 [{chapter,start,end,text,note}]，数组下标即后端 index
function clearHighlights(){
  if(!root)return;var ms=root.querySelectorAll('mark.hl');
  for(var i=0;i<ms.length;i++){var m=ms[i];if(m.parentNode)m.parentNode.replaceChild(document.createTextNode(m.textContent),m);}
  root.normalize();
}
function wrapRange(s,e,idx,note){
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
  var pos=0,node,segs=[];
  while(node=walker.nextNode()){
    var len=node.nodeValue.length,ns=pos,ne=pos+len;pos=ne;
    var a=Math.max(s,ns),b=Math.min(e,ne);
    if(a<b)segs.push({node:node,from:a-ns,to:b-ns});
    if(ne>=e)break;
  }
  for(var i=segs.length-1;i>=0;i--){var w=segs[i];try{
    var r=document.createRange();r.setStart(w.node,w.from);r.setEnd(w.node,w.to);
    var mk=document.createElement('mark');mk.className='hl'+(note?' has-note':'');mk.setAttribute('data-hi',idx);if(note)mk.title=note;
    r.surroundContents(mk);
  }catch(_){}}
}
function applyHighlights(){
  if(!root)return;
  for(var i=0;i<HL.length;i++){var h=HL[i];if(h.chapter===curCh)wrapRange(h.start,h.end,i,h.note||'');}
}
function refreshHighlights(){clearHighlights();applyHighlights();}
function selOffsets(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  var r=sel.getRangeAt(0);var t=r.toString();if(!t||!t.length)return null;
  var pre=document.createRange();pre.selectNodeContents(root);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch(e){return null;}
  var start=pre.toString().length;
  return {start:start,end:start+t.length,text:t};
}
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
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;if(e.detail>1)e.preventDefault();}); // e.detail>1：双击/三击 → 阻止浏览器选词/选段（连点翻页常被当双击而误选）
  document.addEventListener('mousemove',function(e){if(downX!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  document.addEventListener('click',function(e){
    parent.postMessage({uiClick:1},'*');
    if(overlayOpen){return;} // 有搜索框/设置浮层时，点击正文只用于关闭浮层，不翻页/不弹菜单
    // 点到已高亮的文字 → 出高亮菜单，不翻页
    var hm=e.target.closest?e.target.closest('mark.hl'):null;
    if(hm){e.stopPropagation();showHlMenu(parseInt(hm.getAttribute('data-hi'),10));return;}
    if(e.target.closest&&e.target.closest('#fn-pop'))return; // 注释弹窗内点击：不翻页
    var a=e.target.closest?e.target.closest('a'):null;
    if(a){var href=a.getAttribute('href')||'';
      if(href.charAt(0)==='#'){e.preventDefault();
        var m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        var frag=m?m[2]:href.slice(1), ciT=m?parseInt(m[1],10):curCh;
        if(isNoteLink(a)&&frag){showFootnote(a,ciT,frag);return;} // 注释角标 → 弹注释正文
        if(m){var ci=ciT,fr=frag;if(ci===curCh){if(fr){var el=document.getElementById(fr);if(el)gotoPage(pageOf(el));}}else showChapter(ci,'start',fr);}
        else{var el2=document.getElementById(href.slice(1));if(el2)gotoPage(pageOf(el2));}
      }
      return;
    }
    hideFn(); // 点别处 → 收起注释弹窗
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    var sel=window.getSelection?window.getSelection():null;
    if(didDrag||(sel&&!sel.isCollapsed&&sel.toString().trim())){return;}
    var x=e.clientX;if(x>window.innerWidth*0.6)nextPage();else if(x<window.innerWidth*0.4)prevPage();else parent.postMessage({centerTap:1},'*');
  });
  document.addEventListener('keydown',function(e){if(((e.ctrlKey||e.metaKey)&&(e.key==='f'||e.key==='F'))||e.key==='F3')e.preventDefault();},true); // 禁用浏览器自带查找
  document.addEventListener('keydown',function(e){
    if(e.key==='PageDown'||e.key==='ArrowRight'||(e.key===' '&&!e.shiftKey)){e.preventDefault();userNav();nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||(e.key===' '&&e.shiftKey)){e.preventDefault();userNav();prevPage();}
  });
  var wheelLock=false;
  document.addEventListener('wheel',function(e){e.preventDefault();if(wheelLock)return;if(Math.abs(e.deltaY)<4&&Math.abs(e.deltaX)<4)return;userNav();if(e.deltaY>0||e.deltaX>0)nextPage();else prevPage();wheelLock=true;setTimeout(function(){wheelLock=false;},220);},{passive:false});
  window.addEventListener('resize',function(){relayout();scheduleMeasure();});
  setupSelMenu();
  setupHlUi();
  setupFn();
  setupDict();
  document.addEventListener('contextmenu',function(e){e.preventDefault();}); // 禁用浏览器右键菜单
}
// 选中文字后弹出“web搜索”菜单 → 通知父窗口用浏览器搜索
var selMenu=null;
function hideSelMenu(){if(selMenu)selMenu.style.display='none';}
function setupSelMenu(){
  selMenu=document.createElement('div');selMenu.id='sel-menu';
  var btn=document.createElement('button');btn.type='button';btn.textContent='🔍 web搜索';
  var btnDict=document.createElement('button');btnDict.type='button';btnDict.textContent='📖 词典';
  var btnHL=document.createElement('button');btnHL.type='button';btnHL.textContent='🖍 高亮';
  var btnNote=document.createElement('button');btnNote.type='button';btnNote.textContent='📝 批注';
  var btnBm=document.createElement('button');btnBm.type='button';btnBm.textContent='🔖 书签';
  selMenu.appendChild(btn);selMenu.appendChild(btnDict);selMenu.appendChild(btnHL);selMenu.appendChild(btnNote);selMenu.appendChild(btnBm);
  document.body.appendChild(selMenu);
  [btn,btnDict,btnHL,btnNote,btnBm].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  btnDict.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)openDict(t,getSelContext());
    hideSelMenu();
  });
  btnBm.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    var frac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
    parent.postMessage({addBookmark:{chapter:curCh,frac:frac,label:t.slice(0,40)}},'*');
    hideSelMenu();
  });
  btn.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)parent.postMessage({webSearch:t},'*');
    hideSelMenu();
  });
  btnHL.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();parent.postMessage({addHighlight:o},'*');}
    hideSelMenu();
  });
  btnNote.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();parent.postMessage({addHighlightNote:o},'*');}
    hideSelMenu();
  });
  function showSelMenuAtSelection(){
    var sel=window.getSelection?window.getSelection():null;
    var t=sel?sel.toString().trim():'';
    if(!t){hideSelMenu();return;}
    hideHlMenu(); // 出选区菜单时，先收起"已高亮"菜单，保证同时只有一个
    var rect;try{rect=sel.getRangeAt(0).getBoundingClientRect();}catch(_){hideSelMenu();return;}
    if(!rect||(!rect.width&&!rect.height)){hideSelMenu();return;}
    selMenu.style.display='block';
    var mw=selMenu.offsetWidth||100,mh=selMenu.offsetHeight||34;
    var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
    var top=rect.top-mh-8;if(top<6)top=rect.bottom+8;
    selMenu.style.left=left+'px';selMenu.style.top=top+'px';
  }
  document.addEventListener('mouseup',function(e){
    if(selMenu&&selMenu.contains(e.target))return; // 在选区菜单上松开（如点"高亮"按钮）：保留选区，别清
    if((dictPop&&dictPop.contains(e.target))||(fnPop&&fnPop.contains(e.target)))return; // 在词典/注释弹窗内选字：正常选中、不弹高亮菜单
    setTimeout(function(){
      // 非拖动（单击/双击/连点翻页）：清掉任何选区并收菜单，避免单击误选/误高亮文本
      if(!didDrag){if(window.getSelection)window.getSelection().removeAllRanges();hideSelMenu();return;}
      showSelMenuAtSelection(); // 只有按住拖动选择才弹菜单
    },0);
  });
  document.addEventListener('mousedown',function(e){if(selMenu&&!selMenu.contains(e.target))hideSelMenu();});
  document.addEventListener('wheel',hideSelMenu,{passive:true});
  document.addEventListener('keydown',hideSelMenu);
}

// ---- 点击/悬停"已高亮文字" → 一个菜单（web搜索 / 取消高亮 / 批注）；批注用父窗口的大批注页 ----
var hlMenu=null,activeHi=-1,hlHideTimer=null;
function mkBtn(txt){var b=document.createElement('button');b.type='button';b.textContent=txt;return b;}
function hideHlMenu(){if(hlMenu)hlMenu.style.display='none';}
function markEl(idx){return root?root.querySelector('mark.hl[data-hi="'+idx+'"]'):null;}
function selActive(){var s=window.getSelection?window.getSelection():null;return !!(s&&!s.isCollapsed&&s.toString().trim());}
function showHlMenu(idx){
  if(selActive())return;          // 还在选字（如刚高亮完）就不弹，避免和选区菜单同时出现
  hideSelMenu();                  // 任何时候只保留一个工具栏
  activeHi=idx;var el=markEl(idx);if(!el)return;
  hlMenu.style.display='block';
  var rect=el.getBoundingClientRect();
  var mw=hlMenu.offsetWidth||200,mh=hlMenu.offsetHeight||34;
  var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
  var top=rect.top-mh-8;if(top<6)top=rect.bottom+8;
  hlMenu.style.left=left+'px';hlMenu.style.top=top+'px';
}
function setupHlUi(){
  hlMenu=document.createElement('div');hlMenu.id='hl-menu';
  var mWeb=mkBtn('🔍 web搜索'),mDict=mkBtn('📖 词典'),mDel=mkBtn('🗑 取消高亮'),mNote=mkBtn('📝 批注');
  hlMenu.append(mWeb,mDict,mDel,mNote);document.body.appendChild(hlMenu);
  [mWeb,mDict,mDel,mNote].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  mWeb.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({webSearch:h.text},'*');hideHlMenu();});
  mDict.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)openDict(h.text,h.context||'');hideHlMenu();});
  mDel.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({removeHighlight:activeHi},'*');hideHlMenu();});
  mNote.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({openAnnotations:activeHi},'*');hideHlMenu();});
  hlMenu.addEventListener('mouseenter',function(){if(hlHideTimer)clearTimeout(hlHideTimer);});
  hlMenu.addEventListener('mouseleave',function(){hlHideTimer=setTimeout(hideHlMenu,400);});

  // 悬停高亮 → 出菜单；移开延时收起
  root.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10));}});
  root.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
  document.addEventListener('mousedown',function(e){if(hlMenu&&!hlMenu.contains(e.target))hideHlMenu();});
  document.addEventListener('wheel',function(){hideHlMenu();},{passive:true});
}
// 取选区所在"整段"的纯文本（作为批注上下文，存起来供大批注页展示）
function getSelContext(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return '';
  var node=sel.getRangeAt(0).startContainer;var el=node.nodeType===1?node:node.parentNode;
  // 优先取最近的段落元素 <p>，没有再退回其它块级元素
  var block=el&&el.closest?(el.closest('p')||el.closest('li,blockquote,td,div,section')):el;
  var txt=((block||el).textContent||'').replace(/\s+/g,' ').trim();
  return txt.length>800?txt.slice(0,800)+'…':txt; // 整段，过长才截断
}

// ---- 注释/脚注：点角标 → 就地弹出注释正文（而不是跳过去）----
var fnPop=null;
function hideFn(){if(fnPop)fnPop.style.display='none';}
function setupFn(){
  fnPop=document.createElement('div');fnPop.id='fn-pop';
  fnPop.innerHTML='<span class="fn-close">✕</span><div class="fn-body"></div>';
  document.body.appendChild(fnPop);
  fnPop.querySelector('.fn-close').addEventListener('click',function(e){e.stopPropagation();hideFn();});
  fnPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  fnPop.addEventListener('click',function(e){e.stopPropagation();if(e.target.closest&&e.target.closest('a'))e.preventDefault();}); // 弹窗内点击不翻页/不跳锚
  document.addEventListener('mousedown',function(e){if(fnPop&&fnPop.style.display==='block'&&!fnPop.contains(e.target))hideFn();});
  document.addEventListener('wheel',hideFn,{passive:true});
}
// ---- 离线词典：选中文字/已高亮 → 就地弹释义（释义由外壳查后端再回传）----
var dictPop=null,dictRect=null,dictContext='';
function hideDict(){if(dictPop)dictPop.style.display='none';}
function setupDict(){
  dictPop=document.createElement('div');dictPop.id='dict-pop';
  dictPop.innerHTML='<span class="dc-close">✕</span><div class="dc-head"></div><div class="dc-def"></div>';
  document.body.appendChild(dictPop);
  dictPop.querySelector('.dc-close').addEventListener('click',function(e){e.stopPropagation();hideDict();});
  dictPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  dictPop.addEventListener('click',function(e){e.stopPropagation();});
  document.addEventListener('mousedown',function(e){if(dictPop&&dictPop.style.display==='block'&&!dictPop.contains(e.target))hideDict();});
  document.addEventListener('wheel',function(){hideDict();},{passive:true});
}
function placeDict(){
  dictPop.style.display='block';
  var ph=dictPop.offsetHeight,r=dictRect;
  var top=(r?r.bottom:120)+10;
  if(top+ph>window.innerHeight-8)top=(r?r.top:120)-ph-10;
  if(top<8)top=8;
  dictPop.style.top=top+'px';
}
function openDict(term,context){
  if(!dictPop)setupDict();
  try{var s=window.getSelection();dictRect=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){dictRect=null;}
  dictContext=(context||'').replace(/\s+/g,' ').trim();
  if(!dictContext)dictContext=getSelContext();
  dictPop.querySelector('.dc-head').textContent='查词中…';
  dictPop.querySelector('.dc-def').textContent='';dictPop.querySelector('.dc-def').className='dc-def';
  placeDict();
  parent.postMessage({dict:term},'*');
}
function speakWord(w){
  try{
    if(!w)return;
    parent.postMessage({dictSpeak:w},'*');
  }catch(_){}
}
// 释义来源多选记忆（按语种分开）：中文词 中=中中/英=中英；英文词 中=英中/英=英英
var lastDict=null;
function dictSel(lang){try{var v=localStorage.getItem('dictSel_'+lang);return v?v.split(','):null;}catch(_){return null;}}
function setDictSel(lang,a){try{localStorage.setItem('dictSel_'+lang,a.join(','));}catch(_){}}
function renderDict(){
  if(!dictPop||!lastDict)return;
  var r=lastDict,head=dictPop.querySelector('.dc-head'),def=dictPop.querySelector('.dc-def');
  head.innerHTML='';def.innerHTML='';
  var w=document.createElement('span');w.className='dc-word';w.textContent=r.word||'';head.appendChild(w);
  if(!r.found){def.textContent='（未找到该词的释义）';def.className='dc-def dc-miss';return;}
  if(r.phonetic){var ph=document.createElement('span');ph.className='dc-phon';ph.textContent=(r.lang==='en')?('['+r.phonetic+']'):r.phonetic;head.appendChild(ph);}
  if(r.lang==='en'){
    parent.postMessage({dictPrefetch:r.word},'*');
    var spk=document.createElement('span');spk.className='dc-spk';spk.textContent='🔊';spk.title='发音';
    spk.addEventListener('click',function(e){e.stopPropagation();speakWord(r.word);});head.appendChild(spk);
  }
  var sources=[];
  if(r.def)sources.push({k:'c',label:'中',text:r.def});
  if(r.def_en)sources.push({k:'e',label:'英',text:r.def_en});
  if(!sources.length){def.textContent='（无释义）';def.className='dc-def dc-miss';return;}
  var avail=sources.map(function(s){return s.k;});
  var sel=dictSel(r.lang)||[sources[0].k];
  sel=sel.filter(function(k){return avail.indexOf(k)>=0;});
  if(!sel.length)sel=[sources[0].k];
  if(sources.length>1){ // 两种释义都有 → 显示多选切换键（可同时选中）
    var tg=document.createElement('span');tg.className='dc-toggle';
    sources.forEach(function(s){
      var b=document.createElement('span');b.className='dt'+(sel.indexOf(s.k)>=0?' on':'');b.textContent=s.label;
      b.addEventListener('click',function(e){e.stopPropagation();
        var i=sel.indexOf(s.k);
        if(i>=0){if(sel.length>1)sel.splice(i,1);}else{sel.push(s.k);}
        setDictSel(r.lang,sel);renderDict();
      });
      tg.appendChild(b);
    });
    head.appendChild(tg);
  }
  var multi=sel.length>1;
  sources.forEach(function(s){
    if(sel.indexOf(s.k)<0)return;
    var blk=document.createElement('div');blk.className='dc-defblk';
    if(multi){var lb=document.createElement('span');lb.className='dc-lb';lb.textContent=s.label;blk.appendChild(lb);}
    var tx=document.createElement('span');tx.textContent=s.text;blk.appendChild(tx);
    def.appendChild(blk);
  });
  def.className='dc-def';
}
function showDictResult(r){
  if(!dictPop)setupDict();
  lastDict=r;renderDict();
  if(r&&r.found&&r.lang==='en'&&r.autoSpeak)speakWord(r.word); // 按生词本设置决定是否自动读一次
  if(r&&r.found)parent.postMessage({vocabAdd:{word:r.word,lang:r.lang,def:r.def||'',def_en:r.def_en||'',phonetic:r.phonetic||'',example:dictContext||''}},'*'); // 记入生词本
  placeDict();
}
// 是否是"注释角标"链接：epub:type/role/class 含 note，或链接文字形如 [23] / (3) / 23
function isNoteLink(a){
  var ty=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+(a.className||'')).toLowerCase();
  if(/note|footnote|endnote|annoref/.test(ty))return true;
  var t=(a.textContent||'').trim();
  return /^[\[【（(]?\s*\d{1,4}\s*[\]】）)]?$/.test(t);
}
function fnSelector(frag){return '[id="'+String(frag).replace(/"/g,'\\"')+'"]';}
function popFootnote(a,html){
  if(!fnPop)setupFn();
  fnPop.querySelector('.fn-body').innerHTML=html;
  fnPop.style.display='block';
  var rect=a.getBoundingClientRect();
  var ph=fnPop.offsetHeight;
  var top=rect.bottom+10;
  if(top+ph>window.innerHeight-8)top=rect.top-ph-10; // 下方放不下 → 放上方
  if(top<8)top=8;
  fnPop.style.top=top+'px';
}
// 取注释正文：id 常落在内联回链角标(<a>/<sup>)上，其内容只是"[n]"，正文是它的兄弟
// → 此时取它所在的块（p/li/aside…）的内容；id 本身就在块上则直接用。
function noteHtml(el){
  var block=el;
  if(el.nodeType===1&&/^(A|SUP|SPAN|B|I|EM|FONT|SMALL)$/.test(el.nodeName)){
    block=(el.closest&&el.closest('p,li,div,dd,aside,section,td,blockquote'))||el.parentNode||el;
  }
  var h=(block.innerHTML||'').trim();
  return h||el.innerHTML||'';
}
function showFootnote(a,ci,frag){
  if(ci===curCh){
    var el=document.querySelector(fnSelector(frag));
    if(el){popFootnote(a,noteHtml(el));return;}
  }
  popFootnote(a,'加载中…');
  fetch(location.origin+'/chapter/'+ID+'/'+ci).then(function(r){return r.json();}).then(function(d){
    var tmp=document.createElement('div');tmp.innerHTML=d.body||'';
    var el=tmp.querySelector(fnSelector(frag));
    popFootnote(a,el?noteHtml(el):'（未找到注释内容）');
  }).catch(function(){popFootnote(a,'（注释加载失败）');});
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
// ---- 朗读：Web Speech API + 当前词高亮(CSS Highlight) + 自动翻页/跳章 ----
function ttsPickVoice(){
  var vs=(window.speechSynthesis&&speechSynthesis.getVoices())||[];
  var zh=null;for(var i=0;i<vs.length;i++){if(/zh|chinese|中文|普通话/i.test((vs[i].lang||'')+(vs[i].name||''))){zh=vs[i];break;}}
  ttsVoice=zh||vs[0]||null;return {count:vs.length,zh:!!zh};
}
function ttsBuildChapter(){
  var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    var p=n.parentNode?n.parentNode.nodeName:'';if(p==='SCRIPT'||p==='STYLE')return NodeFilter.FILTER_REJECT;
    return n.nodeValue&&n.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}});
  ttsMap=[];var node,base=0,t='';
  while(node=w.nextNode()){ttsMap.push({node:node,start:base,end:base+node.nodeValue.length});t+=node.nodeValue;base+=node.nodeValue.length;}
  ttsText=t;
  // 切句（中文标点/换行/过长断开），记录每句在全文的起始偏移
  ttsSents=[];var cur='',cb=0;
  for(var i=0;i<t.length;i++){var ch=t[i];cur+=ch;
    if('。！？!?…\n'.indexOf(ch)>=0||cur.length>=120){if(cur.trim())ttsSents.push({text:cur,base:cb});cb=i+1;cur='';}}
  if(cur.trim())ttsSents.push({text:cur,base:cb});
}
function ttsHighlight(gs,len){
  len=len||1;
  var seg=null;for(var i=0;i<ttsMap.length;i++){if(gs>=ttsMap[i].start&&gs<ttsMap[i].end){seg=ttsMap[i];break;}}
  if(!seg)return;var node=seg.node,o=gs-seg.start;
  try{var r=document.createRange();r.setStart(node,o);r.setEnd(node,Math.min(node.nodeValue.length,o+len));
    if(window.CSS&&CSS.highlights)CSS.highlights.set('tts',new Highlight(r));
    var rr=r.getBoundingClientRect(),pr=pager.getBoundingClientRect();
    var x=rr.left-pr.left+pager.scrollLeft,pg=Math.floor((x+1)/pageStep);
    if(pg>=0&&pg<pagesInCh&&pg!==pageInCh)gotoPage(pg);
  }catch(_){}
}
function ttsCurrentOffset(){
  var a=topAnchor();if(a&&a.range){var n=a.range.startContainer,o=a.range.startOffset;
    for(var i=0;i<ttsMap.length;i++){if(ttsMap[i].node===n)return ttsMap[i].start+o;}}
  return 0;
}
function ttsAdvance(edge){ // 本章读完 → 下一章
  if(curCh<CH-1){showChapter(curCh+1,'start').then(function(){if(ttsOn){ttsBuildChapter();if(edge){ttsCache={};ttsPlayIndex(0);}else ttsSpeakFrom(0);}});}else ttsStop();
}
function ttsSpeakFrom(i){ // 系统语音
  if(!ttsOn)return;
  if(i>=ttsSents.length){ttsAdvance(false);return;}
  ttsSi=i;var s=ttsSents[i],u=new SpeechSynthesisUtterance(s.text);
  if(ttsVoice)u.voice=ttsVoice;u.lang='zh-CN';u.rate=ttsRate;
  u.onboundary=function(e){if(e.charIndex!=null)ttsHighlight(s.base+e.charIndex);};
  u.onend=function(){if(ttsOn)ttsSpeakFrom(i+1);};
  speechSynthesis.speak(u);
}
// edge-tts：流水线——边读边预取后两句，句间几乎无缝
function ttsReq(i){
  if(i<0||i>=ttsSents.length)return;
  if(ttsCache[i]!==undefined)return; // null=请求中，对象=已到
  ttsCache[i]=null;
  var rate=Math.round(((S.ttsRate||1)-1)*100);
  parent.postMessage({ttsSynth:{seq:ttsGen,idx:i,text:ttsSents[i].text,voice:S.ttsVoice||'',rate:rate}},'*');
}
function ttsPlayIndex(i){
  if(!ttsOn)return;
  if(i>=ttsSents.length){ttsAdvance(true);return;}
  ttsSi=i;ttsReq(i);ttsReq(i+1);ttsReq(i+2); // 预取后两句
  var c=ttsCache[i];
  if(c&&c.err){ttsPlayIndex(i+1);return;} // 这句取音失败 → 跳过
  if(c)ttsRenderAudio(i,c);else ttsWaiting=i;
}
function ttsRenderAudio(i,a){
  if(!ttsOn)return;ttsWaiting=-1;ttsSi=i;ttsPlayedAny=true;
  var s=ttsSents[i],marks=[],cur=0;
  for(var k=0;k<a.marks.length;k++){var w=a.marks[k].word||'';var idx=w?s.text.indexOf(w,cur):-1;if(idx<0)idx=cur;marks.push({at:a.marks[k].at,off:s.base+idx,len:Math.max(1,w.length)});cur=idx+Math.max(1,w.length);}
  var au=new Audio('data:audio/mpeg;base64,'+a.audio);ttsAudioEl=au;var mi=0;
  au.ontimeupdate=function(){var ms=au.currentTime*1000,hl=-1;for(var k=mi;k<marks.length;k++){if(marks[k].at<=ms)hl=k;else break;}if(hl>=0){mi=hl+1;ttsHighlight(marks[hl].off,marks[hl].len);}};
  au.onended=function(){if(ttsOn)ttsPlayIndex(i+1);};
  au.onerror=function(){if(ttsOn)ttsPlayIndex(i+1);};
  au.play().catch(function(){if(ttsOn)ttsPlayIndex(i+1);});
  ttsReq(i+1);ttsReq(i+2);
}
function ttsIsEdge(){return (S.ttsSource||'edge')==='edge';}
function ttsBegin(){
  parent.postMessage({ttsState:1},'*');
  var off=ttsCurrentOffset(),si=0;
  for(var k=0;k<ttsSents.length;k++){if(ttsSents[k].base+ttsSents[k].text.length>off){si=k;break;}}
  if(ttsIsEdge()){ttsCache={};ttsWaiting=-1;ttsPlayedAny=false;ttsPlayIndex(si);}else ttsSpeakFrom(si);
}
function ttsStart(){
  ttsOn=true;ttsBuildChapter();
  if(ttsIsEdge()){ttsBegin();return;} // 在线音源不需要本地语音
  if(!window.speechSynthesis){parent.postMessage({ttsErr:1},'*');ttsOn=false;return;}
  var pv=ttsPickVoice();
  if(pv.count===0){speechSynthesis.onvoiceschanged=function(){if(ttsOn){var p2=ttsPickVoice();if(!p2.zh)parent.postMessage({ttsNoZh:1},'*');ttsBegin();speechSynthesis.onvoiceschanged=null;}};return;}
  if(!pv.zh)parent.postMessage({ttsNoZh:1},'*');
  ttsBegin();
}
function ttsStop(){
  ttsOn=false;ttsGen++;ttsCache={};ttsWaiting=-1;
  try{speechSynthesis.cancel();}catch(_){}
  if(ttsAudioEl){try{ttsAudioEl.pause();}catch(_){}ttsAudioEl=null;}
  if(window.CSS&&CSS.highlights)CSS.highlights.delete('tts');
  parent.postMessage({ttsState:0},'*');
}
window.addEventListener('message',function(e){
  if(!e.data)return;
  if(e.data.settings){S=Object.assign(S,e.data.settings);relayout();scheduleMeasure();}
  if(e.data.tts){if(e.data.tts==='start')ttsStart();else ttsStop();}
  if(e.data.ttsAudio){var a=e.data.ttsAudio;if(ttsOn&&a.seq===ttsGen){ttsCache[a.idx]=a;if(ttsWaiting===a.idx)ttsRenderAudio(a.idx,a);}}
  if(e.data.ttsAudioErr){var er=e.data.ttsAudioErr;if(ttsOn&&er.seq===ttsGen){ttsCache[er.idx]={err:1};if(ttsWaiting===er.idx){ttsWaiting=-1;if(!ttsPlayedAny){parent.postMessage({ttsErr:er.err||2},'*');ttsStop();}else ttsPlayIndex(er.idx+1);}}}
  if(e.data.overlayOpen!==undefined){overlayOpen=!!e.data.overlayOpen;}
  if(e.data.pageCache){applyPageCache(e.data.pageCache);}
  if(e.data.clearMarks){clearMarksKeepPage();}
  if(e.data.gotoChapter!==undefined){var cf=e.data.chFrac,fr=e.data.frag,sq=e.data.search;showChapter(e.data.gotoChapter,'start',fr).then(function(){if(cf!==undefined&&cf>0)gotoPage(Math.round(cf*(pagesInCh-1)));if(sq)doSearch(sq);});}
  if(e.data.gotoFrac!==undefined){gotoGlobalFrac(e.data.gotoFrac);}
  if(e.data.pageTurn){if(e.data.pageTurn>0)nextPage();else prevPage();}
  if(e.data.reveal){reveal();}
  if(e.data.search!==undefined){doSearch(e.data.search);}
  if(e.data.searchNav){searchNav(e.data.searchNav);}
  if(e.data.vchaps){VC=e.data.vchaps;report();}
  if(e.data.highlights){HL=e.data.highlights;refreshHighlights();}
  if(e.data.showHlMenuFor!==undefined){var si=e.data.showHlMenuFor;setTimeout(function(){if(window.getSelection)window.getSelection().removeAllRanges();showHlMenu(si);},40);}
  if(e.data.dictResult!==undefined){showDictResult(e.data.dictResult);}
  if(e.data.gotoHighlight!==undefined){var hi=e.data.gotoHighlight,h=HL[hi];if(h){showChapter(h.chapter,'start').then(function(){var el=root.querySelector('mark.hl[data-hi="'+hi+'"]');if(el)gotoPage(pageOf(el));});}}
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
fn collect_head_assets(
    html: &str,
    head: &mut String,
    seen: &mut std::collections::HashSet<String>,
) {
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
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
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
/// 一行是否像章节标题（中文网文："第X章/节/回 …"，或独立的"楔子/序章/番外"等短行）。
fn is_txt_heading(line: &str) -> bool {
    let t = line.trim();
    let cc = t.chars().count();
    if cc == 0 || cc > 40 {
        return false;
    }
    let head: String = t.chars().take(14).collect();
    if t.starts_with('第') && (head.contains('章') || head.contains('节') || head.contains('回'))
    {
        return true;
    }
    matches!(
        t,
        "楔子" | "序" | "序章" | "序言" | "前言" | "引子" | "后记" | "尾声" | "番外"
    )
}

fn txt_chapter_is_heading_only(text: &str) -> bool {
    let mut non_empty = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = match non_empty.next() {
        Some(line) => line,
        None => return false,
    };
    non_empty.next().is_none() && is_txt_heading(first)
}

fn first_non_empty_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn merge_title_only_txt_chapters(chapters: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::with_capacity(chapters.len());
    let mut pending: Option<(String, String)> = None;

    for (title, body) in chapters {
        if txt_chapter_is_heading_only(&body) {
            pending = Some(match pending.take() {
                Some((pending_title, mut pending_body)) => {
                    if !pending_body.ends_with('\n') {
                        pending_body.push('\n');
                    }
                    pending_body.push_str(&body);
                    (pending_title, pending_body)
                }
                None => (title, body),
            });
            continue;
        }

        if let Some((pending_title, mut pending_body)) = pending.take() {
            let pending_line = first_non_empty_line(&pending_body).unwrap_or("");
            let body_line = first_non_empty_line(&body).unwrap_or("");
            if pending_line == body_line {
                out.push((pending_title, body));
            } else {
                if !pending_body.ends_with('\n') {
                    pending_body.push('\n');
                }
                pending_body.push_str(&body);
                out.push((pending_title, pending_body));
            }
        } else {
            out.push((title, body));
        }
    }

    if let Some(item) = pending {
        out.push(item);
    }
    out
}

/// 把整本 txt 切成章节 (标题, 正文)。优先按"第X章"标题切（网文）；否则按 ~5 万字切块。
/// 切块是为了"虚拟化加载"——打开只排第一章，秒开；其余在后台测量。
fn build_txt_chapters(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let heads: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| is_txt_heading(l))
        .map(|(i, _)| i)
        .collect();
    // 标题足够多、又不至于每行都是 → 按标题切
    if heads.len() >= 5 && heads.len() < lines.len() / 2 {
        let mut out: Vec<(String, String)> = Vec::new();
        if heads[0] > 0 {
            let pre = lines[..heads[0]].join("\n");
            if !pre.trim().is_empty() {
                out.push(("卷首".to_string(), pre));
            }
        }
        for (k, &h) in heads.iter().enumerate() {
            let end = if k + 1 < heads.len() {
                heads[k + 1]
            } else {
                lines.len()
            };
            out.push((lines[h].trim().to_string(), lines[h..end].join("\n")));
        }
        return merge_title_only_txt_chapters(out);
    }
    // 否则按 ~5 万字切块
    let mut out: Vec<(String, String)> = Vec::new();
    let mut cur = String::new();
    let mut n = 0usize;
    for line in &lines {
        cur.push_str(line);
        cur.push('\n');
        n += line.chars().count() + 1;
        if n >= 50000 {
            out.push((format!("第 {} 节", out.len() + 1), std::mem::take(&mut cur)));
            n = 0;
        }
    }
    if !cur.trim().is_empty() {
        out.push((format!("第 {} 节", out.len() + 1), cur));
    }
    if out.is_empty() {
        out.push(("正文".to_string(), text.to_string()));
    }
    out
}

fn is_md(format: &str) -> bool {
    matches!(format, "md" | "markdown")
}

/// markdown → HTML（用 pulldown-cmark，开启表格/删除线/任务列表）。
fn md_to_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, opts));
    out
}

/// 取一行的 markdown 一级/二级标题文字（# 或 ##），否则 None。
fn md_heading_title(line: &str) -> Option<String> {
    let t = line.trim_start();
    if t.starts_with("# ") || t.starts_with("## ") {
        Some(t.trim_start_matches('#').trim().to_string())
    } else {
        None
    }
}

/// markdown 文件按 # / ## 标题切章；标题不足 2 个则整篇一章。
fn build_md_chapters(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let heads: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| md_heading_title(l).is_some())
        .map(|(i, _)| i)
        .collect();
    if heads.len() < 2 {
        return vec![("正文".to_string(), text.to_string())];
    }
    let mut out: Vec<(String, String)> = Vec::new();
    if heads[0] > 0 {
        let pre = lines[..heads[0]].join("\n");
        if !pre.trim().is_empty() {
            out.push(("开头".to_string(), pre));
        }
    }
    for (k, &h) in heads.iter().enumerate() {
        let end = if k + 1 < heads.len() {
            heads[k + 1]
        } else {
            lines.len()
        };
        let title = md_heading_title(lines[h]).unwrap_or_default();
        out.push((title, lines[h..end].join("\n")));
    }
    out
}

fn is_mobi(format: &str) -> bool {
    matches!(format, "mobi" | "azw3" | "azw")
}

/// 取 HTML 片段里第一个标题（h1~h3）的文字，作章节标题。
fn mobi_chunk_title(html: &str) -> Option<String> {
    for tag in ["h1", "h2", "h3"] {
        let open = format!("<{tag}");
        if let Some(s) = html.find(&open) {
            if let Some(gt) = html[s..].find('>') {
                let inner = s + gt + 1;
                if let Some(e) = html[inner..].find(&format!("</{tag}>")) {
                    let t = strip_tags(&html[inner..inner + e]);
                    let t = t.trim();
                    if !t.is_empty() {
                        return Some(t.chars().take(40).collect());
                    }
                }
            }
        }
    }
    None
}

/// 把 MOBI/AZW3 整本 HTML 按分页符 <mbp:pagebreak> 切成章节；切不出就整本一章。
fn split_mobi_html(html: &str) -> Vec<(String, String)> {
    let parts: Vec<&str> = html.split("<mbp:pagebreak").collect();
    let chunks: Vec<String> = if parts.len() >= 3 {
        parts
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if i == 0 {
                    (*p).to_string()
                } else {
                    // 段首残留 "/>…" 或 " …/>…"，去掉到第一个 '>'
                    match p.find('>') {
                        Some(j) => p[j + 1..].to_string(),
                        None => (*p).to_string(),
                    }
                }
            })
            .filter(|s| !s.trim().is_empty())
            .collect()
    } else {
        vec![html.to_string()]
    };
    let mut out = Vec::new();
    for (i, c) in chunks.into_iter().enumerate() {
        let title = mobi_chunk_title(&c).unwrap_or_else(|| format!("第 {} 章", i + 1));
        out.push((title, c));
    }
    if out.is_empty() {
        out.push(("正文".to_string(), html.to_string()));
    }
    out
}

/// 读取并切分 MOBI/AZW3 内容为章节 (标题, HTML)。mobi 解析对个别文件可能 panic，用 catch_unwind 兜住。
fn mobi_chapters(path: &std::path::Path) -> Vec<(String, String)> {
    let p = path.to_path_buf();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let Ok(m) = mobi::Mobi::from_path(&p) else {
            return vec![(
                "正文".to_string(),
                "<p>无法解析该 MOBI/AZW3 文件。</p>".to_string(),
            )];
        };
        let content = m.content_as_string_lossy();
        let body = extract_body_inner(&content);
        let body = if body.trim().is_empty() {
            content.as_str()
        } else {
            body
        };
        split_mobi_html(body)
    }))
    .unwrap_or_else(|_| {
        vec![(
            "正文".to_string(),
            "<p>解析该 MOBI/AZW3 文件时出错（可能是 DRM 或暂不支持的格式）。</p>".to_string(),
        )]
    })
}

/// 取（并缓存）一本 txt/md/mobi 的切分章节（md 按标题切，mobi 按分页符切，txt 按"第X章"或字数切）。
fn get_txt_chapters(state: &AppState, id: u64) -> Option<Arc<Vec<(String, String)>>> {
    {
        let c = state.txt_chapters.lock().unwrap();
        if let Some(v) = c.get(&id) {
            return Some(v.clone());
        }
    }
    let (path, format) = {
        let lib = state.library.lock().unwrap();
        let b = lib.get(id)?;
        (b.path.clone(), b.format.clone())
    };
    let chapters = if is_mobi(&format) {
        mobi_chapters(&path)
    } else {
        let bytes = std::fs::read(&path).ok()?;
        let text = book::normalize_text(&book::decode_bytes(&bytes));
        if is_md(&format) {
            build_md_chapters(&text)
        } else {
            build_txt_chapters(&text)
        }
    };
    let arc = Arc::new(chapters);
    state.txt_chapters.lock().unwrap().insert(id, arc.clone());
    Some(arc)
}

/// 把纯文本段落化为合并阅读页用的正文 HTML（每段一个 <p>，首行缩进）。
fn txt_body(text: &str) -> String {
    let mut body = String::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        body.push_str("<p style=\"text-indent:2em\">");
        body.push_str(&html_escape(para));
        body.push_str("</p>\n");
    }
    body
}

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
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
        "pdf" => extract_pdf_pages(&book.path),
        _ => match std::fs::read(&book.path) {
            Ok(b) => vec![book::normalize_text(&book::decode_bytes(&b))],
            Err(_) => Vec::new(),
        },
    }
}

/// 抽取 PDF 每页文字（数字版有效；扫描版/无文字层返回空）。pdf-extract 可能 panic，做兜底。
fn extract_pdf_pages(path: &Path) -> Vec<String> {
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

fn simple_ascii_query_key(term: &str) -> Option<String> {
    let t = term.trim();
    if t.len() < 2 || !t.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(t.to_ascii_lowercase())
}

fn ascii_terms(text: &str) -> Vec<(String, usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && !bytes[i].is_ascii_alphanumeric() {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
            i += 1;
        }
        if i > start + 1 {
            let term = text[start..i].to_ascii_lowercase();
            out.push((term, start, i - start));
        }
    }
    out
}

fn index_book_keywords(state: &AppState, book: &book::Book, chapters: &[String]) {
    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    for (ci, text) in chapters.iter().enumerate() {
        let mut map: HashMap<String, (u32, Vec<String>)> = HashMap::new();
        for (term, pos, len) in ascii_terms(text) {
            let entry = map.entry(term).or_insert((0, Vec::new()));
            entry.0 = entry.0.saturating_add(1);
            if entry.1.len() < 8 {
                entry.1.push(snippet_at(text, pos, len));
            }
        }
        for (term, (count, snippets)) in map {
            let _ = db.upsert_keyword_posting(&term, book.id, ci as u32, count, &snippets);
        }
    }
}

/// 确保某书索引存在且新鲜，返回它（pdf 或抽取失败返回 None）。
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

/// 后台为全书架建立/更新索引（导入新书或启动时调用，温和不抢资源）。
fn spawn_build_index(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let books: Vec<book::Book> = { state.library.lock().unwrap().books.clone() };
        if let Ok(mut db_guard) = state.db.lock() {
            if let Some(db) = db_guard.as_mut() {
                let _ = db.clear_keyword_index();
            }
        }
        for b in books {
            if let Some(idx) = ensure_book_index(&b) {
                index_book_keywords(state.inner(), &b, &idx.chapters);
            }
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
    want: Option<&std::collections::HashSet<u64>>,
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
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .cloned()
            .collect()
    };

    // 中文（无 ASCII 字母）时无需大小写折叠，可直接按原字节匹配，省一次复制
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
    b: u64,    // 书 id
    c: u32,    // 章节
    t: String, // 片段
}
type GlobalHnsw = instant_distance::HnswMap<SemPoint, u32>;
#[derive(Serialize, Deserialize)]
struct ShardMeta {
    books: Vec<u64>, // 本分片包含的书（整本归属一片，不跨片）
    chunks: usize,   // 本分片段落数（估算载入内存用）
}
#[derive(Serialize, Deserialize)]
struct GlobalMeta {
    v: u32,
    model: String,
    dim: usize,
    book_ids: Vec<u64>,          // 参与建图的全部书（排序），用于判断是否过期
    source_sig: Vec<(u64, u64)>, // (书 id, 源文件修改时间)，用于判断源文件变更
    shards: Vec<ShardMeta>,      // 各分片描述
}
/// 已载入内存、可供查询的分片集合。
struct LoadedShards {
    graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)>, // 每片：近邻图 + 段落映射
    covered: std::collections::HashSet<u64>,     // 这些分片覆盖到的书；其余的书查询时退回暴力
    book_ids: Vec<u64>,                          // 建图时的全部书集合（判过期）
}
/// 单个分片的段落上限——决定“建图峰值内存”，与整库大小无关。
/// 60万×512维f32≈1.2GB 向量，建图峰值约 2~3GB，8GB 内存的机器也安全。
/// 库再大只是分片更多、建图更久，绝不会因此爆内存（这正是分片的意义）。
const SHARD_MAX_CHUNKS: usize = 600_000;

/// 物理内存总量 / 可用量（字节）。Windows 用 GlobalMemoryStatusEx；其它平台给保守默认。
#[cfg(windows)]
fn ram_total_avail() -> (u64, u64) {
    #[repr(C)]
    struct MemStatusEx {
        length: u32,
        mem_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page: u64,
        avail_page: u64,
        total_virt: u64,
        avail_virt: u64,
        avail_ext_virt: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(p: *mut MemStatusEx) -> i32;
    }
    let mut m: MemStatusEx = unsafe { std::mem::zeroed() };
    m.length = std::mem::size_of::<MemStatusEx>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
        (m.total_phys, m.avail_phys)
    } else {
        (8 << 30, 4 << 30)
    }
}
#[cfg(not(windows))]
fn ram_total_avail() -> (u64, u64) {
    (8 << 30, 4 << 30)
}

/// 载入近邻索引可用的内存预算（字节）：物理一半 与 (可用-1GB)的七成 取较小，至少 512MB。
fn index_ram_budget() -> u64 {
    let (total, avail) = ram_total_avail();
    (total / 2)
        .min(avail.saturating_sub(1 << 30) * 7 / 10)
        .max(512 << 20)
}
/// 估算一个分片载入内存后的占用（向量 + 段落文本 + 图结构的粗略经验值）。
fn shard_est_bytes(chunks: usize, dim: usize) -> u64 {
    chunks as u64 * (dim as u64 * 4 + 400)
}

fn global_shard_hnsw_path(k: usize) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("global_{k}.hnsw")))
}
fn global_shard_map_path(k: usize) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("global_{k}.map")))
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
        .map(|b| b.id)
        .filter(|id| sem_meta_path(*id).map(|p| p.exists()).unwrap_or(false))
        .collect();
    v.sort_unstable();
    v
}

fn indexed_book_signature(state: &AppState) -> Vec<(u64, u64)> {
    let lib = state.library.lock().unwrap();
    let mut v: Vec<(u64, u64)> = lib
        .books
        .iter()
        .filter(|b| b.format != "pdf")
        .filter(|b| sem_meta_path(b.id).map(|p| p.exists()).unwrap_or(false))
        .map(|b| (b.id, file_mtime(&b.path)))
        .collect();
    v.sort_unstable_by_key(|(id, _)| *id);
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
    resume_at: &AtomicU64,
) -> Result<(), String> {
    use std::io::Write;
    let mut items: Vec<(u32, String)> = Vec::new();
    for (ci, text) in chapters.iter().enumerate() {
        for c in chunk_text(text) {
            items.push((ci as u32, c));
        }
    }
    let vec_path = sem_vec_path(id).ok_or("无缓存路径")?;
    if let Some(d) = vec_path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if items.is_empty() {
        let _ = std::fs::write(&vec_path, []);
        let meta = SemMeta {
            v: SEM_VERSION,
            model: SEM_MODEL.to_string(),
            mtime,
            dim: 0,
            chunks: Vec::new(),
        };
        let mp = sem_meta_path(id).ok_or("无缓存路径")?;
        std::fs::write(
            &mp,
            serde_json::to_string(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut vf =
        std::io::BufWriter::new(std::fs::File::create(&vec_path).map_err(|e| e.to_string())?);
    let mut meta_chunks: Vec<SemChunk> = Vec::with_capacity(items.len());
    let mut dim = 0usize;
    for batch in items.chunks(128) {
        // 若正在“让路”（用户刚打开阅读窗口），先等到截止时刻，把 CPU 留给窗口冷启动
        loop {
            let r = resume_at.load(Ordering::Relaxed);
            let now = now_ms();
            if now >= r {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis((r - now).min(200)));
        }
        // bge 段落不加前缀，直接用原文
        let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let embs = embedder.embed(inputs, None).map_err(|e| e.to_string())?;
        // 每批后让一小步，给前台留出调度间隙（稳态下也不至于把 8 核占满）
        std::thread::sleep(std::time::Duration::from_millis(6));
        for (k, (c, t)) in batch.iter().enumerate() {
            let mut v = embs[k].clone();
            normalize(&mut v);
            dim = v.len();
            for x in &v {
                vf.write_all(&x.to_le_bytes()).map_err(|e| e.to_string())?;
            }
            meta_chunks.push(SemChunk {
                c: *c,
                t: t.clone(),
            });
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
    std::fs::write(
        &mp,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
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
    let id = book.id;
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

/// 全库分片快速索引是否存在且新鲜（版本/模型/参与书集合都匹配当前已索引的书）。
fn global_index_fresh(state: &AppState) -> bool {
    let Some(p) = global_meta_path() else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    match serde_json::from_str::<GlobalMeta>(&s) {
        Ok(m) => {
            m.v == SEM_VERSION
                && m.model == SEM_MODEL
                && m.book_ids == indexed_book_ids(state)
                && m.source_sig == indexed_book_signature(state)
        }
        Err(_) => false,
    }
}

/// 给定范围（want=None 表示全库）的语义索引是否“已完整”：每本逐书索引都新鲜；
/// 若是全库范围，还要求分片快速索引也已建好且新鲜。完整则无需重建。
fn semantic_complete(state: &AppState, want: &Option<std::collections::HashSet<u64>>) -> bool {
    let books: Vec<(u64, std::path::PathBuf)> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .map(|b| (b.id, b.path.clone()))
            .collect()
    };
    if books.is_empty() {
        return false;
    }
    if !books
        .iter()
        .all(|(id, path)| sem_is_fresh(*id, file_mtime(path)))
    {
        return false;
    }
    if want.is_none() && !global_index_fresh(state) {
        return false; // 全库范围：缺分片快速索引也算没完成
    }
    true
}

/// 查询某范围的语义索引是否已建立完成（供 UI 在点“建立”前判断、避免重复建立）。
#[tauri::command]
fn semantic_index_done(state: tauri::State<AppState>, ids: Option<Vec<String>>) -> bool {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    semantic_complete(state.inner(), &want)
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
#[tauri::command]
async fn build_semantic_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    // 已是最新（每本都新鲜 + 全库分片图新鲜）→ 不重建，直接报“已完成”
    if semantic_complete(state.inner(), &want) {
        let mut p = state.sem_progress.lock().unwrap();
        if !p.building {
            p.error = String::new();
            p.current = "语义索引已是最新，无需重建".into();
        }
        return Ok(());
    }
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
    std::thread::spawn(move || {
        set_thread_background(true); // 后台优先级，绝不和前台抢 CPU
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
                .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
                .cloned()
                .collect()
        };
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.total = books.len() as u32;
        }
        let mut failures: Vec<String> = Vec::new();
        for (i, b) in books.iter().enumerate() {
            {
                let mut p = state.sem_progress.lock().unwrap();
                p.done = i as u32;
                p.current = b.title.clone();
            }
            let id = b.id;
            let mtime = file_mtime(&b.path);
            if sem_is_fresh(id, mtime) {
                continue;
            }
            match get_book_chapters(state.inner(), b) {
                Some(ch) => {
                    if let Err(err) =
                        sem_build_book(&embedder, id, mtime, &ch, &state.index_resume_at)
                    {
                        failures.push(format!("{}：{}", b.title, err));
                    }
                }
                None => failures.push(format!("{}：无法读取正文", b.title)),
            }
        }
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.done = p.total;
            p.current = "建立加速索引（分片）…".into();
        }
        // 注意：加速索引建不成「不算失败」——逐书向量已就绪、检索照常可用，只是慢一点。
        // 因此这里绝不写 p.error（p.error 只留给模型加载等真正的失败）。
        let idx_err = build_global_index(state.inner()).err().unwrap_or_default();
        let mut p = state.sem_progress.lock().unwrap();
        p.building = false;
        p.current = if !failures.is_empty() {
            format!(
                "完成（{} 本未建立索引；{}）",
                failures.len(),
                failures
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("；")
            )
        } else if idx_err.is_empty() {
            "完成".into()
        } else {
            format!("完成（检索可用；加速索引未建成：{idx_err}）")
        };
    });
    Ok(())
}

/// 把一片的向量建图并落盘（global_{k}.hnsw 图 + global_{k}.map 映射）。
fn write_shard(
    k: usize,
    points: Vec<SemPoint>,
    values: Vec<u32>,
    mapping: &[GlobalEntry],
) -> Result<(), String> {
    use std::io::Write;
    let hp = global_shard_hnsw_path(k).ok_or("无缓存路径")?;
    if let Some(d) = hp.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let map: GlobalHnsw = instant_distance::Builder::default().build(points, values);
    let mut f = std::io::BufWriter::new(std::fs::File::create(&hp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut f, &map).map_err(|e| e.to_string())?;
    f.flush().ok();
    let mp = global_shard_map_path(k).ok_or("无缓存路径")?;
    let mut mf = std::io::BufWriter::new(std::fs::File::create(&mp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut mf, &mapping).map_err(|e| e.to_string())?;
    mf.flush().ok();
    Ok(())
}

/// 用所有已建索引的书，构建“分片”近邻索引并落盘。一次只建一片→建图内存恒定，
/// 任何机器、任何库大小都不会因此爆内存（再大只是分片更多）。整本书归属同一片，不跨片。
fn build_global_index(state: &AppState) -> Result<(), String> {
    let ids = indexed_book_ids(state);
    // 先清掉旧的全库索引文件（含上一版单图的 global.hnsw/global.map）
    if let Some(d) = sem_dir() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("global_")
                    || n == "global.hnsw"
                    || n == "global.map"
                    || n == "global.json"
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    let mut shards: Vec<ShardMeta> = Vec::new();
    let mut dim = 0usize;
    let mut points: Vec<SemPoint> = Vec::new();
    let mut values: Vec<u32> = Vec::new();
    let mut mapping: Vec<GlobalEntry> = Vec::new();
    let mut shard_books: Vec<u64> = Vec::new();
    let mut k = 0usize;
    for id in &ids {
        let Some(data) = get_sem_data(state, *id) else {
            continue;
        };
        if data.dim == 0 {
            continue;
        }
        dim = data.dim;
        // 当前片再加这本会超额 → 先把当前片落盘，开新片
        if !mapping.is_empty() && mapping.len() + data.chunks.len() > SHARD_MAX_CHUNKS {
            let n = mapping.len();
            write_shard(
                k,
                std::mem::take(&mut points),
                std::mem::take(&mut values),
                &mapping,
            )?;
            shards.push(ShardMeta {
                books: std::mem::take(&mut shard_books),
                chunks: n,
            });
            mapping.clear();
            k += 1;
            if let Ok(mut p) = state.sem_progress.lock() {
                p.current = format!("建立加速索引（第 {} 片）…", k + 1);
            }
        }
        for (i, chunk) in data.chunks.iter().enumerate() {
            let v = data.vecs[i * data.dim..(i + 1) * data.dim].to_vec();
            values.push(mapping.len() as u32);
            points.push(SemPoint(v));
            mapping.push(GlobalEntry {
                b: *id,
                c: chunk.c,
                t: chunk.t.clone(),
            });
        }
        shard_books.push(*id);
        // 建图阶段不长期占用逐书缓存，加完即释放
        if let Ok(mut c) = state.sem_cache.lock() {
            if let Some(old) = c.remove(id) {
                state
                    .sem_cache_bytes
                    .fetch_sub(old.vecs.len() * 4, Ordering::Relaxed);
            }
        }
    }
    if !mapping.is_empty() {
        let n = mapping.len();
        write_shard(
            k,
            std::mem::take(&mut points),
            std::mem::take(&mut values),
            &mapping,
        )?;
        shards.push(ShardMeta {
            books: std::mem::take(&mut shard_books),
            chunks: n,
        });
    }
    if shards.is_empty() {
        return Ok(());
    }
    let meta = GlobalMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        dim,
        book_ids: ids,
        source_sig: indexed_book_signature(state),
        shards,
    };
    std::fs::write(
        global_meta_path().ok_or("无缓存路径")?,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    *state.global_index.lock().unwrap() = None; // 让下次查询重新载入
    Ok(())
}

/// 载入（并缓存）分片近邻索引。按内存预算尽量多载入分片；与当前已索引书集合不一致则视为过期。
/// 返回 None 表示无索引/过期/损坏（应整体退回暴力）。
fn load_global_index(state: &AppState) -> Option<Arc<LoadedShards>> {
    {
        let g = state.global_index.lock().unwrap();
        if let Some(a) = g.as_ref() {
            if a.book_ids == indexed_book_ids(state) {
                return Some(a.clone());
            }
        }
    }
    let meta: GlobalMeta =
        serde_json::from_str(&std::fs::read_to_string(global_meta_path()?).ok()?).ok()?;
    if meta.v != SEM_VERSION || meta.model != SEM_MODEL {
        return None;
    }
    if meta.book_ids != indexed_book_ids(state) || meta.source_sig != indexed_book_signature(state)
    {
        return None; // 索引集合变了 → 过期，退回暴力
    }
    let budget = index_ram_budget();
    let mut graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)> = Vec::new();
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut used: u64 = 0;
    for (k, sh) in meta.shards.iter().enumerate() {
        let est = shard_est_bytes(sh.chunks, meta.dim);
        // 预算用尽就停（但至少载入一片，保证有加速）；其余分片的书查询时退回暴力
        if !graphs.is_empty() && used + est > budget {
            break;
        }
        let map: GlobalHnsw = bincode::deserialize_from(std::io::BufReader::new(
            std::fs::File::open(global_shard_hnsw_path(k)?).ok()?,
        ))
        .ok()?;
        let mapping: Vec<GlobalEntry> = bincode::deserialize_from(std::io::BufReader::new(
            std::fs::File::open(global_shard_map_path(k)?).ok()?,
        ))
        .ok()?;
        for id in &sh.books {
            covered.insert(*id);
        }
        graphs.push((map, mapping));
        used += est;
    }
    if graphs.is_empty() {
        return None;
    }
    let arc = Arc::new(LoadedShards {
        graphs,
        covered,
        book_ids: meta.book_ids,
    });
    *state.global_index.lock().unwrap() = Some(arc.clone());
    Some(arc)
}

/// 在已载入内存的分片上做近邻检索，返回每本书的命中聚合。
fn search_loaded_shards(
    li: &LoadedShards,
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    let qp = SemPoint(q.to_vec());
    let mut per: HashMap<u64, Vec<SemHit>> = HashMap::new();
    let mut best: HashMap<u64, f32> = HashMap::new();
    for (graph, mapping) in &li.graphs {
        let mut search = instant_distance::Search::default();
        for item in graph.search(&qp, &mut search).take(400) {
            let gid = *item.value as usize;
            let Some(e) = mapping.get(gid) else { continue };
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
    }
    per.into_iter()
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
        .collect()
}

/// 对一组书做并行暴力语义检索（无近邻图、或分片没覆盖到的书走这里）。
fn brute_force_books(state: &AppState, targets: &[book::Book], q: &[f32]) -> Vec<SemBookHits> {
    if targets.is_empty() {
        return Vec::new();
    }
    let qref: &[f32] = q;
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .max(1);
    let chunk_size = targets.len().div_ceil(nthreads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for b in chunk {
                        if let Some(h) = sem_search_book(state, b, qref) {
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
    })
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

    let st: &AppState = state.inner();
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());

    // 全库查询：已载入的分片走近邻（毫秒级）；分片没覆盖到的书（内存装不下/未建索引）退回暴力，合并。
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut results: Vec<SemBookHits> = Vec::new();
    if want.is_none() {
        if let Some(li) = load_global_index(st) {
            let titles: HashMap<u64, (String, String)> = {
                let lib = st.library.lock().unwrap();
                lib.books
                    .iter()
                    .map(|b| (b.id, (b.title.clone(), b.author.clone())))
                    .collect()
            };
            covered = li.covered.clone();
            results.extend(search_loaded_shards(&li, &q, &titles));
        }
    }

    // 需要暴力的书：限定集合内（或全库）中，已建索引、且未被已载入分片覆盖的书
    let targets: Vec<book::Book> = {
        let lib = st.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .filter(|b| !covered.contains(&b.id))
            .filter(|b| sem_meta_path(b.id).map(|p| p.exists()).unwrap_or(false))
            .cloned()
            .collect()
    };
    results.extend(brute_force_books(st, &targets, &q));

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
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
        let e = model
            .embed(texts, None)
            .map_err(|e| format!("EMBED ERR: {e}"))?;
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
        sem_probe();
        return;
    }
    if std::env::args().any(|a| a == "--hnsw-probe") {
        hnsw_probe();
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
            sem_progress: Mutex::new(SemProgress::default()),
            global_index: Mutex::new(None),
            index_resume_at: AtomicU64::new(0),
            stats: Mutex::new(StatsStore::load()),
            vocab: Mutex::new(VocabStore::load()),
            word_pack: Mutex::new(WordPackState::default()),
        })
        // 主窗口（书架）：恢复上次的大小/位置，并在移动/缩放/关闭时记忆
        .setup(|app| {
            {
                let state = app.state::<AppState>();
                migrate_json_to_sqlite(state.inner());
            }
            spawn_build_index(app.handle().clone()); // 后台建立/更新全文检索索引
            spawn_fingerprint_fill(app.handle().clone()); // 后台为旧书补内容指纹
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
            list_books,
            app_version,
            dict_lookup,
            vocab_add,
            vocab_list,
            vocab_remove,
            vocab_set_level,
            vocab_review,
            notes_summary,
            sync_get_settings,
            sync_set_settings,
            auth_register,
            auth_login,
            auth_logout,
            sync_now,
            migrate_data_to_sqlite,
            export_data_package,
            import_data_package,
            check_update,
            release_notes,
            shelf_books,
            add_books,
            remove_book,
            remove_books,
            set_cover,
            get_auto_import,
            set_auto_import,
            auto_import_scan,
            open_book,
            book_info,
            book_meta,
            compute_word_counts,
            set_progress,
            add_bookmark,
            remove_bookmark,
            reading_stats,
            reading_stats_range,
            add_reading_time,
            add_read_words,
            open_url,
            edge_tts,
            word_tts,
            word_tts_cache_size,
            clear_word_tts_cache,
            word_tts_pack_status,
            word_tts_pack_missing,
            clear_word_tts_pack,
            start_word_tts_pack,
            pause_word_tts_pack,
            get_page_cache,
            save_page_cache,
            get_pdf_state,
            set_pdf_state,
            search_book,
            set_description,
            set_rating,
            web_search,
            open_book_at,
            take_pending_jump,
            shelf_search,
            build_shelf_index,
            open_search_window,
            build_semantic_index,
            semantic_index_done,
            semantic_status,
            semantic_search,
            add_highlight,
            remove_highlight,
            set_highlight_note,
            relocate_book
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 失败");
}
