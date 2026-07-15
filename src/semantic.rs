use crate::semantic_core::{
    chunk_text, cosine, dot, index_ram_budget, normalize, shard_est_bytes, SEM_CACHE_BUDGET,
    SEM_MODEL, SEM_QUERY_PREFIX, SEM_VERSION, SHARD_MAX_CHUNKS,
};
use crate::{book, now_ms, search, set_thread_background, AppState, RES_BASE};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;
// ===========================================================================
//  语义检索（向量嵌入）：把段落转成向量，按余弦相似度排序，找“意思相近”的文本
// ===========================================================================

/// 语义模型缓存目录（与探针共用，避免运行时再下载）。
fn sem_model_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("models");
    Some(d)
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn dir_contains_model_file(path: &std::path::Path) -> bool {
    let Ok(rd) = std::fs::read_dir(path) else {
        return false;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if dir_contains_model_file(&p) {
                return true;
            }
        } else if p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("onnx"))
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
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
#[derive(Serialize, Deserialize)]
struct SemProfileMeta {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
    chunks: usize,
}
/// 内存里的一本书向量数据：vecs 为扁平的 [chunk0 dim 维][chunk1 …]，已 L2 归一化
pub(crate) struct SemData {
    dim: usize,
    vecs: Vec<f32>,
    chunks: Vec<SemChunk>,
}
#[derive(Default, Clone, Serialize)]
pub(crate) struct SemProgress {
    building: bool,
    model_downloading: bool,
    status_refreshing: bool,
    active_task: String,
    done: u32,
    total: u32,
    shard_done: u32,
    shard_total: u32,
    model_ready: bool,
    model_path: String,
    model_bytes: u64,
    semantic_done: u32,
    semantic_total: u32,
    semantic_ready: bool,
    semantic_bytes: u64,
    accelerator_done: u32,
    accelerator_total: u32,
    accelerator_ready: bool,
    accelerator_resumable: bool,
    accelerator_bytes: u64,
    multi_profile_done: u32,
    multi_profile_total: u32,
    multi_profile_ready: bool,
    multi_profile_bytes: u64,
    current: String,
    error: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct SemanticTaskItem {
    id: String,
    title: String,
    detail: String,
    status: String,
    done: u32,
    total: u32,
    bytes: u64,
    running: bool,
    ready: bool,
    resumable: bool,
    can_start: bool,
    can_delete: bool,
    primary_label: String,
    delete_label: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct SemanticTaskCenter {
    busy: bool,
    status_refreshing: bool,
    current: String,
    error: String,
    tasks: Vec<SemanticTaskItem>,
    progress: SemProgress,
}

#[derive(Default)]
struct SemStatusCache {
    snapshot: Option<SemProgress>,
    refreshing: bool,
    updated_at: u64,
}

static SEM_STATUS_CACHE: OnceLock<Mutex<SemStatusCache>> = OnceLock::new();
static SEM_QUERY_CACHE: OnceLock<Mutex<SemQueryCache>> = OnceLock::new();
type SemProfileCache = Mutex<HashMap<u64, (u64, Vec<f32>, usize)>>;
static SEM_PROFILE_CACHE: OnceLock<SemProfileCache> = OnceLock::new();
static SEM_MULTI_PROFILE_CACHE: OnceLock<Mutex<Option<Arc<MultiProfileIndex>>>> = OnceLock::new();
static SEM_INDEX_SNAPSHOT_CACHE: OnceLock<Mutex<SemIndexSnapshotCache>> = OnceLock::new();
static SEM_GLOBAL_LOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SEM_EMBED_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SEM_PREPARE_RUNNING: AtomicBool = AtomicBool::new(false);
static SEM_PREPARED: AtomicBool = AtomicBool::new(false);
static SEM_QUERY_ACTIVE: AtomicUsize = AtomicUsize::new(0);
// 全局图尚未载入或只覆盖部分书籍时，用很小的书籍画像先筛选候选。
// 这是冷启动的快速路径：宁可后台继续载入大图，也不让首次查询同步读取数 GB 数据。
const SEM_PROFILE_CANDIDATE_LIMIT: usize = 24;
const SEM_PROFILE_CANDIDATE_MIN: usize = 12;
const SEM_BRUTE_FORCE_READ_BUDGET: u64 = 192 * 1024 * 1024;
const SEM_INDEX_SNAPSHOT_TTL_MS: u64 = 10_000;
const SEM_STATUS_CACHE_TTL_MS: u64 = 60_000;
const SEM_HNSW_HITS_PER_SHARD: usize = 128;
const MULTI_PROFILE_VERSION: u32 = 2;
const LEGACY_MULTI_PROFILE_VERSION: u32 = 1;
const GLOBAL_CACHE_VERSION: u32 = 3;
const LEGACY_GLOBAL_CACHE_VERSION: u32 = 2;
const MULTI_PROFILE_MIN_CENTERS: usize = 4;
const MULTI_PROFILE_MAX_CENTERS: usize = 16;
const MULTI_PROFILE_CHUNKS_PER_CENTER: usize = 256;

#[derive(Default)]
struct SemQueryCache {
    order: VecDeque<String>,
    entries: HashMap<String, (u64, Vec<SemBookHits>)>,
}

#[derive(Default)]
struct SemIndexSnapshotCache {
    updated_at: u64,
    book_ids: Vec<u64>,
    source_sig: Vec<(u64, u64)>,
}

#[derive(Clone, Serialize, Deserialize)]
struct MultiProfileBook {
    mtime: u64,
    dim: usize,
    vector_bytes: u64,
    centers: Vec<f32>,
}

#[derive(Clone, Serialize, Deserialize)]
struct MultiProfileIndex {
    v: u32,
    model: String,
    source_sig: Vec<(u64, u64)>,
    books: HashMap<u64, MultiProfileBook>,
}

struct SemanticQueryActivity;

impl SemanticQueryActivity {
    fn enter() -> Self {
        SEM_QUERY_ACTIVE.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for SemanticQueryActivity {
    fn drop(&mut self) {
        SEM_QUERY_ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

fn sem_status_cache() -> &'static Mutex<SemStatusCache> {
    SEM_STATUS_CACHE.get_or_init(|| Mutex::new(SemStatusCache::default()))
}

fn sem_query_cache() -> &'static Mutex<SemQueryCache> {
    SEM_QUERY_CACHE.get_or_init(|| Mutex::new(SemQueryCache::default()))
}

fn sem_profile_cache() -> &'static SemProfileCache {
    SEM_PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sem_multi_profile_cache() -> &'static Mutex<Option<Arc<MultiProfileIndex>>> {
    SEM_MULTI_PROFILE_CACHE.get_or_init(|| Mutex::new(None))
}

fn sem_index_snapshot_cache() -> &'static Mutex<SemIndexSnapshotCache> {
    SEM_INDEX_SNAPSHOT_CACHE.get_or_init(|| Mutex::new(SemIndexSnapshotCache::default()))
}

fn sem_global_load_lock() -> &'static Mutex<()> {
    SEM_GLOBAL_LOAD_LOCK.get_or_init(|| Mutex::new(()))
}

fn sem_embed_lock() -> &'static Mutex<()> {
    SEM_EMBED_LOCK.get_or_init(|| Mutex::new(()))
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
#[derive(Clone, Serialize, Deserialize)]
struct ShardMeta {
    books: Vec<u64>, // 本分片包含的书（整本归属一片，不跨片）
    chunks: usize,   // 本分片段落数（估算载入内存用）
}
#[derive(Clone, Serialize, Deserialize)]
struct GlobalMeta {
    v: u32,
    model: String,
    dim: usize,
    book_ids: Vec<u64>,          // 参与建图的全部书（排序），用于判断是否过期
    source_sig: Vec<(u64, u64)>, // (书 id, 源文件修改时间)，用于判断源文件变更
    shards: Vec<ShardMeta>,      // 各分片描述
}
#[derive(Serialize, Deserialize)]
struct GlobalBuildMeta {
    v: u32,
    model: String,
    dim: usize,
    book_ids: Vec<u64>,
    source_sig: Vec<(u64, u64)>,
    processed_books: usize,
    shards: Vec<ShardMeta>,
}
/// 已载入内存、可供查询的分片集合。
pub(crate) struct LoadedShards {
    graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)>, // 每片：近邻图 + 段落映射
    covered: std::collections::HashSet<u64>,     // 这些分片覆盖到的书；其余的书查询时退回暴力
    book_ids: Vec<u64>,                          // 建图时的全部书集合（判过期）
    source_sig: Vec<(u64, u64)>,                 // 建图时源文件签名（判过期）
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
fn global_build_meta_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("global.build.json"))
}

fn read_sem_meta(id: u64) -> Option<SemMeta> {
    serde_json::from_str(&std::fs::read_to_string(sem_meta_path(id)?).ok()?).ok()
}

fn sem_meta_is_fresh(meta: &SemMeta, mtime: u64) -> bool {
    meta.v == SEM_VERSION && meta.model == SEM_MODEL && meta.mtime == mtime
}

fn sem_meta_has_vectors(meta: &SemMeta) -> bool {
    meta.dim > 0 && !meta.chunks.is_empty()
}

fn sem_index_can_accelerate(id: u64, mtime: u64) -> bool {
    let Some(meta) = read_sem_meta(id) else {
        return false;
    };
    if !sem_meta_is_fresh(&meta, mtime) || !sem_meta_has_vectors(&meta) {
        return false;
    }
    sem_vec_path(id).map(|p| p.exists()).unwrap_or(false) && read_sem_profile(id, mtime).is_some()
}

/// 当前可进入全库加速分片的书与源文件签名。一次遍历同时产生两份数据，
/// 避免状态检查、建图和首查重复读取数百个逐书元数据文件。
fn indexed_book_snapshot(state: &AppState) -> (Vec<u64>, Vec<(u64, u64)>) {
    let lib = state.library.lock().unwrap();
    let mut snapshot: Vec<(u64, u64)> = lib
        .books
        .iter()
        .filter(|b| b.format != "pdf")
        .filter_map(|b| {
            let mtime = search::file_mtime(&b.path);
            sem_index_can_accelerate(b.id, mtime).then_some((b.id, mtime))
        })
        .collect();
    snapshot.sort_unstable_by_key(|(id, _)| *id);
    let ids = snapshot.iter().map(|(id, _)| *id).collect();
    (ids, snapshot)
}

fn indexed_book_snapshot_cached(state: &AppState) -> (Vec<u64>, Vec<(u64, u64)>) {
    let now = now_ms();
    if let Ok(cache) = sem_index_snapshot_cache().lock() {
        if !cache.book_ids.is_empty()
            && now.saturating_sub(cache.updated_at) <= SEM_INDEX_SNAPSHOT_TTL_MS
        {
            return (cache.book_ids.clone(), cache.source_sig.clone());
        }
    }
    // 合并画像已经携带全部书籍的源签名。优先从一个文件恢复快照，
    // 避免冷启动时读取 777 份 profile 元数据和向量。
    if let Some((book_ids, source_sig)) = merged_profile_snapshot(state) {
        if let Ok(mut cache) = sem_index_snapshot_cache().lock() {
            cache.updated_at = now;
            cache.book_ids = book_ids.clone();
            cache.source_sig = source_sig.clone();
        }
        return (book_ids, source_sig);
    }
    let (book_ids, source_sig) = indexed_book_snapshot(state);
    if let Ok(mut cache) = sem_index_snapshot_cache().lock() {
        cache.updated_at = now;
        cache.book_ids = book_ids.clone();
        cache.source_sig = source_sig.clone();
    }
    (book_ids, source_sig)
}

fn clear_sem_index_snapshot_cache() {
    if let Ok(mut cache) = sem_index_snapshot_cache().lock() {
        *cache = SemIndexSnapshotCache::default();
    }
}

/// 当前可进入全库加速分片的书 id（排序）。
fn indexed_book_ids(state: &AppState) -> Vec<u64> {
    indexed_book_snapshot(state).0
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
fn sem_profile_meta_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.profile.json")))
}
fn sem_profile_vec_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.profile.vec")))
}
fn multi_profile_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("multi_profiles.bin"))
}

fn clear_multi_profile_cache() {
    if let Ok(mut cache) = sem_multi_profile_cache().lock() {
        *cache = None;
    }
}

fn decode_multi_profile_index(bytes: &[u8]) -> Option<(MultiProfileIndex, bool)> {
    if let Ok(index) = rmp_serde::from_slice::<MultiProfileIndex>(bytes) {
        if index.v == MULTI_PROFILE_VERSION && index.model == SEM_MODEL {
            return Some((index, false));
        }
    }
    let index = bincode::deserialize::<MultiProfileIndex>(bytes).ok()?;
    if index.v != LEGACY_MULTI_PROFILE_VERSION || index.model != SEM_MODEL {
        return None;
    }
    Some((index, true))
}

fn load_multi_profile_index() -> Option<Arc<MultiProfileIndex>> {
    if let Ok(cache) = sem_multi_profile_cache().lock() {
        if let Some(index) = cache.as_ref() {
            return Some(index.clone());
        }
    }
    let path = multi_profile_path()?;
    let bytes = std::fs::read(&path).ok()?;
    let (mut index, legacy) = decode_multi_profile_index(&bytes)?;
    if legacy {
        index.v = MULTI_PROFILE_VERSION;
        if let Ok(migrated) = rmp_serde::to_vec(&index) {
            if crate::atomic_file::write(&path, &migrated).is_ok() {
                crate::log(&format!(
                    "semantic_profile_bundle migrated books={} bytes_before={} bytes_after={}",
                    index.books.len(),
                    bytes.len(),
                    migrated.len()
                ));
            }
        }
    }
    let index = Arc::new(index);
    if let Ok(mut cache) = sem_multi_profile_cache().lock() {
        *cache = Some(index.clone());
    }
    Some(index)
}

/// 从单个合并画像文件取得已索引书签名。新增或删除已索引图书时退回完整校验；
/// 原文件内容是否改变仍由后台状态刷新负责，不阻塞前台首次查询。
type IndexedBookSnapshot = (Vec<u64>, Vec<(u64, u64)>);

fn merged_profile_snapshot(state: &AppState) -> Option<IndexedBookSnapshot> {
    let index = load_multi_profile_index()?;
    let library = state.library.lock().ok()?;
    let library_ids = library
        .books
        .iter()
        .filter(|book| book.format != "pdf")
        .map(|book| book.id)
        .collect::<std::collections::HashSet<_>>();

    let mut source_sig = index.source_sig.clone();
    source_sig.sort_unstable_by_key(|(id, _)| *id);
    if source_sig.is_empty()
        || source_sig.len() != index.books.len()
        || source_sig.iter().any(|(id, mtime)| {
            !library_ids.contains(id)
                || index
                    .books
                    .get(id)
                    .map(|profile| profile.mtime != *mtime)
                    .unwrap_or(true)
        })
    {
        return None;
    }

    // 合并文件生成后若又新增了逐书画像，必须退回完整扫描并重建合并文件。
    for book in library.books.iter().filter(|book| book.format != "pdf") {
        if index.books.contains_key(&book.id) {
            continue;
        }
        if sem_profile_meta_path(book.id).is_some_and(|path| path.exists())
            && sem_profile_vec_path(book.id).is_some_and(|path| path.exists())
        {
            return None;
        }
    }
    let book_ids = source_sig.iter().map(|(id, _)| *id).collect();
    Some((book_ids, source_sig))
}

/// 启动后低成本预载合并画像。13 MB 左右的单文件换来首查不再打开上千个小文件。
pub(crate) fn spawn_semantic_profile_warmup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        std::thread::sleep(std::time::Duration::from_secs(6));
        let started = Instant::now();
        let state = app.state::<AppState>();
        let merged = load_multi_profile_index();
        let snapshot = merged_profile_snapshot(state.inner());
        crate::log(&format!(
            "semantic_profile_bundle warm books={} snapshot={} elapsed_ms={}",
            merged.as_ref().map(|index| index.books.len()).unwrap_or(0),
            snapshot.as_ref().map(|(ids, _)| ids.len()).unwrap_or(0),
            started.elapsed().as_millis()
        ));
        set_thread_background(false);

        // 仅供本地兼容性验证；正常用户仍在首次语义查询时后台载入大图。
        if std::env::var_os("KUNPENG_SEMANTIC_PREPARE_ON_START").is_some() {
            let _ = prepare_semantic_search(app);
        }
    });
}

/// 懒加载语义模型（首次会下载到 %LOCALAPPDATA%/ebook-reader/models，约 120MB）。
fn get_embedder(state: &AppState) -> Result<Arc<Mutex<fastembed::TextEmbedding>>, String> {
    let mut slot = state.embedder.lock().unwrap();
    if let Some(m) = slot.as_ref() {
        return Ok(m.clone());
    }
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let mut opt =
        InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
    if let Some(d) = sem_model_dir() {
        let _ = std::fs::create_dir_all(&d);
        opt = opt.with_cache_dir(d);
    }
    let m = TextEmbedding::try_new(opt).map_err(|e| format!("加载语义模型失败：{e}"))?;
    let arc = Arc::new(Mutex::new(m));
    *slot = Some(arc.clone());
    Ok(arc)
}

/// 该书的语义索引是否已是最新（版本/模型/源文件时间都匹配）。
fn sem_is_fresh(id: u64, mtime: u64) -> bool {
    read_sem_meta(id)
        .map(|m| sem_meta_is_fresh(&m, mtime))
        .unwrap_or(false)
}

fn sem_index_done_for_book(id: u64, mtime: u64) -> bool {
    let Some(meta) = read_sem_meta(id) else {
        return false;
    };
    if !sem_meta_is_fresh(&meta, mtime) {
        return false;
    }
    if !sem_meta_has_vectors(&meta) {
        return true;
    }
    sem_vec_path(id).map(|p| p.exists()).unwrap_or(false) && read_sem_profile(id, mtime).is_some()
}

fn sem_profile_from_parts(dim: usize, chunks: usize, vecs: &[f32]) -> Option<Vec<f32>> {
    if dim == 0 || chunks == 0 || vecs.len() < dim * chunks {
        return None;
    }
    let mut profile = vec![0.0f32; dim];
    for i in 0..chunks {
        let base = i * dim;
        for (j, v) in profile.iter_mut().enumerate() {
            *v += vecs[base + j];
        }
    }
    let inv = 1.0f32 / chunks as f32;
    for v in &mut profile {
        *v *= inv;
    }
    normalize(&mut profile);
    Some(profile)
}

fn write_sem_profile(
    id: u64,
    mtime: u64,
    dim: usize,
    chunks: usize,
    profile: &[f32],
) -> Result<(), String> {
    let vec_path = sem_profile_vec_path(id).ok_or("无缓存路径")?;
    if let Some(d) = vec_path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let mut bytes = Vec::with_capacity(profile.len() * 4);
    for x in profile {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    std::fs::write(&vec_path, bytes).map_err(|e| e.to_string())?;
    let meta = SemProfileMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        mtime,
        dim,
        chunks,
    };
    std::fs::write(
        sem_profile_meta_path(id).ok_or("无缓存路径")?,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_sem_profile(id: u64, mtime: u64) -> Option<(Vec<f32>, usize)> {
    if let Ok(cache) = sem_profile_cache().lock() {
        if let Some((cached_mtime, profile, chunks)) = cache.get(&id) {
            if *cached_mtime == mtime {
                return Some((profile.clone(), *chunks));
            }
        }
    }
    let meta: SemProfileMeta =
        serde_json::from_str(&std::fs::read_to_string(sem_profile_meta_path(id)?).ok()?).ok()?;
    if meta.v != SEM_VERSION || meta.model != SEM_MODEL || meta.mtime != mtime || meta.dim == 0 {
        return None;
    }
    let bytes = std::fs::read(sem_profile_vec_path(id)?).ok()?;
    let profile: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if profile.len() != meta.dim {
        return None;
    }
    if let Ok(mut cache) = sem_profile_cache().lock() {
        cache.insert(id, (mtime, profile.clone(), meta.chunks));
    }
    Some((profile, meta.chunks))
}

fn read_or_backfill_sem_profile(state: &AppState, book: &book::Book) -> Option<(Vec<f32>, usize)> {
    let mtime = search::file_mtime(&book.path);
    if let Some(profile) = read_sem_profile(book.id, mtime) {
        return Some(profile);
    }
    let data = get_sem_data(state, book.id)?;
    let profile = sem_book_profile(&data)?;
    let _ = write_sem_profile(book.id, mtime, data.dim, data.chunks.len(), &profile);
    Some((profile, data.chunks.len()))
}

/// 为一本书建立语义索引：切块 → 批量嵌入（归一化）→ 落盘（.vec 原始 f32 + .json 元信息）。
fn sem_build_book(
    embedder: &Mutex<fastembed::TextEmbedding>,
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
        if let Some(p) = sem_profile_vec_path(id) {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = sem_profile_meta_path(id) {
            let _ = std::fs::remove_file(p);
        }
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
    let mut profile_acc: Vec<f32> = Vec::new();
    let mut profile_count = 0usize;
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
        let embs = embedder
            .lock()
            .map_err(|_| "语义模型锁定失败".to_string())?
            .embed(inputs, None)
            .map_err(|e| e.to_string())?;
        // 每批后让一小步，给前台留出调度间隙（稳态下也不至于把 8 核占满）
        std::thread::sleep(std::time::Duration::from_millis(6));
        for (k, (c, t)) in batch.iter().enumerate() {
            let mut v = embs[k].clone();
            normalize(&mut v);
            dim = v.len();
            if profile_acc.is_empty() {
                profile_acc.resize(dim, 0.0);
            }
            if profile_acc.len() == dim {
                for (dst, src) in profile_acc.iter_mut().zip(v.iter()) {
                    *dst += *src;
                }
                profile_count += 1;
            }
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
    if profile_count > 0 && profile_acc.len() == dim {
        let inv = 1.0f32 / profile_count as f32;
        for v in &mut profile_acc {
            *v *= inv;
        }
        normalize(&mut profile_acc);
        write_sem_profile(id, mtime, dim, profile_count, &profile_acc)?;
    }
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
    let cached = {
        let c = state.sem_cache.lock().unwrap();
        c.get(&id).cloned()
    };
    if let Some(data) = cached {
        if let Ok(mut order) = state.sem_cache_order.lock() {
            order.retain(|cached_id| *cached_id != id);
            order.push_back(id);
        }
        return Some(data);
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
    if size <= SEM_CACHE_BUDGET {
        let mut c = state.sem_cache.lock().unwrap();
        let mut order = state.sem_cache_order.lock().unwrap();
        if let Some(existing) = c.get(&id) {
            return Some(existing.clone());
        }
        let mut used = state.sem_cache_bytes.load(Ordering::Relaxed);
        while used + size > SEM_CACHE_BUDGET {
            let Some(old_id) = order.pop_front() else {
                break;
            };
            if let Some(old) = c.remove(&old_id) {
                let old_size = old.vecs.len() * 4;
                used = used.saturating_sub(old_size);
            }
        }
        if used + size <= SEM_CACHE_BUDGET {
            c.insert(id, data.clone());
            order.retain(|cached_id| *cached_id != id);
            order.push_back(id);
            state.sem_cache_bytes.store(used + size, Ordering::Relaxed);
        }
    }
    Some(data)
}

#[derive(Clone, Serialize)]
pub(crate) struct SemHit {
    chapter: u32,
    snippet: String,
    score: f32,
}
#[derive(Clone, Serialize)]
pub(crate) struct SemBookHits {
    book_id: String,
    title: String,
    author: String,
    score: f32,
    hits: Vec<SemHit>,
}

#[derive(Serialize)]
pub(crate) struct SimilarBook {
    id: String,
    title: String,
    author: String,
    cover: Option<String>,
    progress: f32,
    score: f32,
    indexed_chunks: usize,
}

fn sem_book_profile(data: &SemData) -> Option<Vec<f32>> {
    sem_profile_from_parts(data.dim, data.chunks.len(), &data.vecs)
}

fn multi_profile_center_count(chunks: usize) -> usize {
    if chunks == 0 {
        return 0;
    }
    chunks
        .div_ceil(MULTI_PROFILE_CHUNKS_PER_CENTER)
        .clamp(MULTI_PROFILE_MIN_CENTERS, MULTI_PROFILE_MAX_CENTERS)
        .min(chunks)
}

/// 按书内顺序分段求多个主题中心。段落向量已归一化；每个中心求均值后再次归一化。
/// 顺序分段比全书单一均值更能保留局部主题，同时构建只需线性扫描已有向量。
fn multi_profile_centers(data: &SemData) -> Vec<f32> {
    let chunks = data.chunks.len();
    let dim = data.dim;
    let center_count = multi_profile_center_count(chunks);
    if center_count == 0 || dim == 0 || data.vecs.len() < chunks.saturating_mul(dim) {
        return Vec::new();
    }
    let mut centers = vec![0.0f32; center_count * dim];
    let mut counts = vec![0usize; center_count];
    for chunk in 0..chunks {
        let center = (chunk * center_count / chunks).min(center_count - 1);
        let source = &data.vecs[chunk * dim..(chunk + 1) * dim];
        let target = &mut centers[center * dim..(center + 1) * dim];
        for (dst, src) in target.iter_mut().zip(source) {
            *dst += *src;
        }
        counts[center] += 1;
    }
    for (center, count) in counts.into_iter().enumerate() {
        if count == 0 {
            continue;
        }
        let target = &mut centers[center * dim..(center + 1) * dim];
        let inv = 1.0 / count as f32;
        for value in target.iter_mut() {
            *value *= inv;
        }
        normalize(target);
    }
    centers
}

fn multi_profile_score(query: &[f32], profile: &MultiProfileBook) -> Option<f32> {
    if profile.dim == 0 || profile.centers.len() < profile.dim {
        return None;
    }
    profile
        .centers
        .chunks_exact(profile.dim)
        .map(|center| dot(query, center))
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

fn build_multi_profile_file(state: &AppState) -> Result<(usize, usize), String> {
    let (_, source_sig) = indexed_book_snapshot_cached(state);
    if source_sig.is_empty() {
        return Err("请先建立语义索引".into());
    }
    let mtimes: HashMap<u64, u64> = source_sig.iter().copied().collect();
    let books: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|book| mtimes.contains_key(&book.id))
            .cloned()
            .collect()
    };
    {
        let mut progress = state.sem_progress.lock().unwrap();
        progress.total = books.len() as u32;
        progress.done = 0;
    }
    let mut entries = HashMap::with_capacity(books.len());
    let mut built_sig = Vec::with_capacity(books.len());
    for (index, book) in books.iter().enumerate() {
        {
            let mut progress = state.sem_progress.lock().unwrap();
            progress.done = index as u32;
            progress.current = format!("生成多中心画像：{}", book.title);
        }
        let Some(data) = get_sem_data(state, book.id) else {
            continue;
        };
        let centers = multi_profile_centers(&data);
        if centers.is_empty() {
            continue;
        }
        let mtime = mtimes.get(&book.id).copied().unwrap_or(0);
        entries.insert(
            book.id,
            MultiProfileBook {
                mtime,
                dim: data.dim,
                vector_bytes: (data.vecs.len() as u64).saturating_mul(4),
                centers,
            },
        );
        built_sig.push((book.id, mtime));
    }
    built_sig.sort_unstable_by_key(|(id, _)| *id);
    let index = MultiProfileIndex {
        v: MULTI_PROFILE_VERSION,
        model: SEM_MODEL.to_string(),
        source_sig: built_sig,
        books: entries,
    };
    let bytes =
        rmp_serde::to_vec(&index).map_err(|error| format!("序列化多中心画像失败：{error}"))?;
    let path = multi_profile_path().ok_or("无缓存路径")?;
    crate::atomic_file::write(&path, &bytes)?;
    let built = index.books.len();
    if let Ok(mut cache) = sem_multi_profile_cache().lock() {
        *cache = Some(Arc::new(index));
    }
    Ok((built, books.len()))
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
fn global_cache_version_supported(version: u32) -> bool {
    matches!(version, LEGACY_GLOBAL_CACHE_VERSION | GLOBAL_CACHE_VERSION)
}

fn global_index_fresh(state: &AppState) -> bool {
    let Some(p) = global_meta_path() else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    let (book_ids, source_sig) = indexed_book_snapshot_cached(state);
    match serde_json::from_str::<GlobalMeta>(&s) {
        Ok(m) => {
            global_cache_version_supported(m.v)
                && m.model == SEM_MODEL
                && m.book_ids == book_ids
                && m.source_sig == source_sig
                && !m.shards.is_empty()
                && m.shards.iter().enumerate().all(|(k, _)| {
                    global_shard_hnsw_path(k)
                        .map(|p| p.exists())
                        .unwrap_or(false)
                        && global_shard_map_path(k)
                            .map(|p| p.exists())
                            .unwrap_or(false)
                })
        }
        Err(_) => false,
    }
}

fn global_build_meta_compatible(
    m: &GlobalBuildMeta,
    ids: &[u64],
    source_sig: &[(u64, u64)],
) -> bool {
    m.v == GLOBAL_CACHE_VERSION
        && m.model == SEM_MODEL
        && m.book_ids == ids
        && m.source_sig == source_sig
        && m.processed_books <= ids.len()
        && m.shards.iter().enumerate().all(|(k, _)| {
            global_shard_hnsw_path(k)
                .map(|p| p.exists())
                .unwrap_or(false)
                && global_shard_map_path(k)
                    .map(|p| p.exists())
                    .unwrap_or(false)
        })
}

fn read_global_build_meta(ids: &[u64], source_sig: &[(u64, u64)]) -> Option<GlobalBuildMeta> {
    let meta: GlobalBuildMeta =
        serde_json::from_str(&std::fs::read_to_string(global_build_meta_path()?).ok()?).ok()?;
    if global_build_meta_compatible(&meta, ids, source_sig) {
        Some(meta)
    } else {
        None
    }
}

fn write_global_build_meta(meta: &GlobalBuildMeta) -> Result<(), String> {
    let path = global_build_meta_path().ok_or("无缓存路径")?;
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(
        &path,
        serde_json::to_string(meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn remove_global_build_meta() {
    if let Some(p) = global_build_meta_path() {
        let _ = std::fs::remove_file(p);
    }
}

fn estimate_global_shard_total(ids: &[u64]) -> u32 {
    let mut total = 0u32;
    let mut current = 0usize;
    for id in ids {
        let Some(path) = sem_meta_path(*id) else {
            continue;
        };
        let Ok(s) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SemMeta>(&s) else {
            continue;
        };
        if meta.v != SEM_VERSION
            || meta.model != SEM_MODEL
            || meta.dim == 0
            || meta.chunks.is_empty()
        {
            continue;
        }
        let chunks = meta.chunks.len();
        if current > 0 && current + chunks > SHARD_MAX_CHUNKS {
            total += 1;
            current = 0;
        }
        current += chunks;
    }
    if current > 0 {
        total += 1;
    }
    total
}

fn semantic_book_progress(state: &AppState) -> (u32, u32) {
    let books: Vec<(u64, std::path::PathBuf)> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .map(|b| (b.id, b.path.clone()))
            .collect()
    };
    let total = books.len() as u32;
    let done = books
        .iter()
        .filter(|(id, path)| sem_index_done_for_book(*id, search::file_mtime(path)))
        .count() as u32;
    (done, total)
}

fn accelerator_progress(state: &AppState) -> (u32, u32, bool, bool) {
    let (ids, source_sig) = indexed_book_snapshot_cached(state);
    if ids.is_empty() {
        return (0, 0, false, false);
    }
    let total = estimate_global_shard_total(&ids);
    if global_index_fresh(state) {
        return (total.max(1), total.max(1), true, false);
    }
    if let Some(meta) = read_global_build_meta(&ids, &source_sig) {
        let done = meta.shards.len() as u32;
        let total = total.max(done);
        return (done, total, false, done > 0 || meta.processed_books > 0);
    }
    (0, total, false, false)
}

fn multi_profile_progress(state: &AppState) -> (u32, u32, bool) {
    let (_, current_sig) = indexed_book_snapshot_cached(state);
    let total = current_sig.len() as u32;
    let Some(index) = load_multi_profile_index() else {
        return (0, total, false);
    };
    let done = current_sig
        .iter()
        .filter(|(id, mtime)| {
            index
                .books
                .get(id)
                .map(|profile| profile.mtime == *mtime)
                .unwrap_or(false)
        })
        .count() as u32;
    let ready = total > 0 && done == total && index.source_sig == current_sig;
    (done, total, ready)
}

fn multi_profile_bytes() -> u64 {
    multi_profile_path()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn semantic_index_bytes() -> u64 {
    let Some(d) = sem_dir() else {
        return 0;
    };
    let Ok(rd) = std::fs::read_dir(d) else {
        return 0;
    };
    rd.flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("sem_") {
                e.metadata().ok().map(|m| m.len())
            } else {
                None
            }
        })
        .sum()
}

fn accelerator_index_bytes() -> u64 {
    let Some(d) = sem_dir() else {
        return 0;
    };
    let Ok(rd) = std::fs::read_dir(d) else {
        return 0;
    };
    rd.flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("global_")
                || n == "global.json"
                || n == "global.build.json"
                || n == "global.hnsw"
                || n == "global.map"
            {
                e.metadata().ok().map(|m| m.len())
            } else {
                None
            }
        })
        .sum()
}

fn enrich_sem_progress(state: &AppState, mut p: SemProgress) -> SemProgress {
    let model_path = sem_model_dir();
    let model_bytes = model_path.as_ref().map(|p| dir_size(p)).unwrap_or(0);
    p.model_path = model_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.model_bytes = model_bytes;
    p.model_ready = state.embedder.lock().unwrap().is_some()
        || model_path
            .as_ref()
            .map(|p| dir_contains_model_file(p) || model_bytes > 40 * 1024 * 1024)
            .unwrap_or(false);

    let (sem_done, sem_total) = semantic_book_progress(state);
    p.semantic_done = sem_done;
    p.semantic_total = sem_total;
    p.semantic_ready = sem_total > 0 && sem_done == sem_total;
    p.semantic_bytes = semantic_index_bytes();

    let (acc_done, acc_total, acc_ready, acc_resumable) = accelerator_progress(state);
    p.accelerator_done = if p.building && p.shard_total > 0 {
        p.shard_done
    } else {
        acc_done
    };
    p.accelerator_total = if p.building && p.shard_total > 0 {
        p.shard_total
    } else {
        acc_total
    };
    p.accelerator_ready = acc_ready;
    p.accelerator_resumable = acc_resumable;
    p.accelerator_bytes = accelerator_index_bytes();
    let (multi_done, multi_total, multi_ready) = multi_profile_progress(state);
    p.multi_profile_done = multi_done;
    p.multi_profile_total = multi_total;
    p.multi_profile_ready = multi_ready;
    p.multi_profile_bytes = multi_profile_bytes();
    p
}

fn merge_sem_status_snapshot(mut live: SemProgress, cached: &SemProgress) -> SemProgress {
    live.model_ready = cached.model_ready;
    live.model_path = cached.model_path.clone();
    live.model_bytes = cached.model_bytes;
    live.semantic_done = cached.semantic_done;
    live.semantic_total = cached.semantic_total;
    live.semantic_ready = cached.semantic_ready;
    live.semantic_bytes = cached.semantic_bytes;
    live.accelerator_done = cached.accelerator_done;
    live.accelerator_total = cached.accelerator_total;
    live.accelerator_ready = cached.accelerator_ready;
    live.accelerator_resumable = cached.accelerator_resumable;
    live.accelerator_bytes = cached.accelerator_bytes;
    live.multi_profile_done = cached.multi_profile_done;
    live.multi_profile_total = cached.multi_profile_total;
    live.multi_profile_ready = cached.multi_profile_ready;
    live.multi_profile_bytes = cached.multi_profile_bytes;
    if live.building && live.shard_total > 0 {
        live.accelerator_done = live.shard_done;
        live.accelerator_total = live.shard_total;
    }
    live
}

fn task_status(running: bool, ready: bool, resumable: bool) -> String {
    if running {
        "running"
    } else if ready {
        "ready"
    } else if resumable {
        "resumable"
    } else {
        "idle"
    }
    .into()
}

fn semantic_task_center_from_progress(p: SemProgress) -> SemanticTaskCenter {
    let busy = p.building || p.model_downloading;
    let refreshing = p.status_refreshing;
    let active = p.active_task.as_str();
    let vector_live = p.building
        && (active == "semantic_vectors"
            || active == "semantic_full"
            || (active.is_empty() && p.total > 0 && p.shard_total == 0));
    let accelerator_live = p.building
        && (active == "semantic_accelerator"
            || (active == "semantic_full" && p.shard_total > 0)
            || (active.is_empty() && p.shard_total > 0));
    let multi_profile_live = p.building && active == "semantic_multi_profile";

    let vector_done = if vector_live && p.total > 0 {
        p.done
    } else {
        p.semantic_done
    };
    let vector_total = if vector_live && p.total > 0 {
        p.total
    } else {
        p.semantic_total
    };
    let accelerator_done = if accelerator_live && p.shard_total > 0 {
        p.shard_done
    } else {
        p.accelerator_done
    };
    let accelerator_total = if accelerator_live && p.shard_total > 0 {
        p.shard_total
    } else {
        p.accelerator_total
    };
    let multi_profile_done = if multi_profile_live && p.total > 0 {
        p.done
    } else {
        p.multi_profile_done
    };
    let multi_profile_total = if multi_profile_live && p.total > 0 {
        p.total
    } else {
        p.multi_profile_total
    };

    let model_detail = if p.model_downloading {
        "正在下载/加载模型…".into()
    } else if p.model_ready {
        "已就绪".into()
    } else if refreshing {
        "正在读取模型状态…".into()
    } else {
        "未下载。首次下载约 120MB。".into()
    };
    let vector_detail = if refreshing && vector_total == 0 {
        "正在读取语义索引状态…".into()
    } else if vector_total > 0 {
        format!(
            "{}/{} 本{}",
            vector_done,
            vector_total,
            if p.semantic_ready { "，已完成" } else { "" }
        )
    } else {
        "书架中暂无可建立语义索引的图书".into()
    };
    let accelerator_detail = if refreshing && accelerator_total == 0 {
        "正在读取加速索引状态…".into()
    } else if accelerator_total > 0 {
        format!(
            "{}/{} 片{}",
            accelerator_done,
            accelerator_total,
            if p.accelerator_ready {
                "，已完成"
            } else if p.accelerator_resumable {
                "，可续建"
            } else {
                ""
            }
        )
    } else {
        "建立语义索引后可建立加速索引".into()
    };
    let multi_profile_detail = if refreshing && multi_profile_total == 0 {
        "正在读取多中心画像状态…".into()
    } else if multi_profile_total > 0 {
        format!(
            "{}/{} 本{}",
            multi_profile_done,
            multi_profile_total,
            if p.multi_profile_ready {
                "，已完成"
            } else if multi_profile_done > 0 {
                "，需要更新"
            } else {
                ""
            }
        )
    } else {
        "建立语义索引后可生成多中心画像".into()
    };

    SemanticTaskCenter {
        busy,
        status_refreshing: refreshing,
        current: p.current.clone(),
        error: p.error.clone(),
        tasks: vec![
            SemanticTaskItem {
                id: "semantic_model".into(),
                title: "语义模型".into(),
                detail: model_detail,
                status: task_status(p.model_downloading, p.model_ready, false),
                done: if p.model_ready { 1 } else { 0 },
                total: 1,
                bytes: p.model_bytes,
                running: p.model_downloading,
                ready: p.model_ready,
                resumable: false,
                can_start: !busy && !refreshing,
                can_delete: !busy && p.model_ready,
                primary_label: "下载模型".into(),
                delete_label: "删除模型".into(),
            },
            SemanticTaskItem {
                id: "semantic_vectors".into(),
                title: "语义索引".into(),
                detail: vector_detail,
                status: task_status(
                    vector_live,
                    p.semantic_ready,
                    vector_done > 0 && !p.semantic_ready,
                ),
                done: vector_done,
                total: vector_total,
                bytes: p.semantic_bytes,
                running: vector_live,
                ready: p.semantic_ready,
                resumable: vector_done > 0 && !p.semantic_ready,
                can_start: !busy && !refreshing && p.model_ready && vector_total > 0,
                can_delete: !busy && vector_done > 0,
                primary_label: if vector_done > 0 && !p.semantic_ready {
                    "续建语义索引".into()
                } else {
                    "建立语义索引".into()
                },
                delete_label: "删除".into(),
            },
            SemanticTaskItem {
                id: "semantic_accelerator".into(),
                title: "加速索引".into(),
                detail: accelerator_detail,
                status: task_status(
                    accelerator_live,
                    p.accelerator_ready,
                    p.accelerator_resumable,
                ),
                done: accelerator_done,
                total: accelerator_total,
                bytes: p.accelerator_bytes,
                running: accelerator_live,
                ready: p.accelerator_ready,
                resumable: p.accelerator_resumable,
                can_start: !busy && !refreshing && p.model_ready && vector_done > 0,
                can_delete: !busy && (p.accelerator_ready || accelerator_done > 0),
                primary_label: if p.accelerator_resumable {
                    "续建加速索引".into()
                } else {
                    "建立加速索引".into()
                },
                delete_label: "删除".into(),
            },
            SemanticTaskItem {
                id: "semantic_multi_profile".into(),
                title: "多中心画像索引".into(),
                detail: multi_profile_detail,
                status: task_status(
                    multi_profile_live,
                    p.multi_profile_ready,
                    multi_profile_done > 0 && !p.multi_profile_ready,
                ),
                done: multi_profile_done,
                total: multi_profile_total,
                bytes: p.multi_profile_bytes,
                running: multi_profile_live,
                ready: p.multi_profile_ready,
                resumable: multi_profile_done > 0 && !p.multi_profile_ready,
                can_start: !busy && !refreshing && vector_done > 0,
                can_delete: !busy && p.multi_profile_bytes > 0,
                primary_label: if multi_profile_done > 0 && !p.multi_profile_ready {
                    "更新多中心画像".into()
                } else {
                    "建立多中心画像".into()
                },
                delete_label: "删除".into(),
            },
        ],
        progress: p,
    }
}

fn clear_sem_status_cache() {
    if let Ok(mut cache) = sem_status_cache().lock() {
        cache.snapshot = None;
        cache.updated_at = 0;
    }
}

fn update_multi_profile_status_cache(done: u32, total: Option<u32>, ready: bool) -> bool {
    let Ok(mut cache) = sem_status_cache().lock() else {
        return false;
    };
    let Some(snapshot) = cache.snapshot.as_mut() else {
        return false;
    };
    snapshot.multi_profile_done = done;
    if let Some(total) = total {
        snapshot.multi_profile_total = total;
    }
    snapshot.multi_profile_ready = ready;
    snapshot.multi_profile_bytes = multi_profile_bytes();
    cache.updated_at = now_ms();
    cache.refreshing = false;
    true
}

fn clear_sem_query_cache() {
    if let Ok(mut cache) = sem_query_cache().lock() {
        cache.order.clear();
        cache.entries.clear();
    }
}

fn clear_sem_profile_cache() {
    if let Ok(mut cache) = sem_profile_cache().lock() {
        cache.clear();
    }
}

fn sem_query_cache_stamp() -> u64 {
    global_meta_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sem_query_cache_key(query: &str, ids: &Option<Vec<String>>) -> String {
    let mut key = query.trim().to_lowercase();
    if let Some(ids) = ids {
        let mut ids = ids.clone();
        ids.sort();
        key.push_str("\nids=");
        key.push_str(&ids.join(","));
    } else {
        key.push_str("\nids=*");
    }
    key
}

fn get_sem_query_cache(key: &str, stamp: u64) -> Option<Vec<SemBookHits>> {
    let cache = sem_query_cache().lock().ok()?;
    cache
        .entries
        .get(key)
        .and_then(|(s, v)| if *s == stamp { Some(v.clone()) } else { None })
}

fn put_sem_query_cache(key: String, stamp: u64, value: &[SemBookHits]) {
    let Ok(mut cache) = sem_query_cache().lock() else {
        return;
    };
    if !cache.entries.contains_key(&key) {
        cache.order.push_back(key.clone());
    }
    cache.entries.insert(key.clone(), (stamp, value.to_vec()));
    while cache.order.len() > 32 {
        if let Some(old) = cache.order.pop_front() {
            cache.entries.remove(&old);
        }
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
        .all(|(id, path)| sem_index_done_for_book(*id, search::file_mtime(path)))
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
pub(crate) fn semantic_index_done(state: tauri::State<AppState>, ids: Option<Vec<String>>) -> bool {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    semantic_complete(state.inner(), &want)
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
#[tauri::command]
pub(crate) async fn build_semantic_index(
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
            active_task: "semantic_full".into(),
            current: "加载模型…".into(),
            ..Default::default()
        };
    }
    clear_sem_status_cache();
    std::thread::spawn(move || {
        set_thread_background(true); // 后台优先级，绝不和前台抢 CPU
        let state = app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                let mut p = state.sem_progress.lock().unwrap();
                p.building = false;
                p.active_task.clear();
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
            let mtime = search::file_mtime(&b.path);
            if sem_is_fresh(id, mtime) {
                if read_sem_profile(id, mtime).is_none()
                    && read_or_backfill_sem_profile(state.inner(), b).is_none()
                {
                    failures.push(format!("{}：无法生成相似图书缓存", b.title));
                }
                continue;
            }
            match search::get_book_chapters(state.inner(), b) {
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
        clear_sem_query_cache();
        let mut p = state.sem_progress.lock().unwrap();
        p.building = false;
        p.active_task.clear();
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
        drop(p);
        clear_sem_status_cache();
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_semantic_model(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut p = state.sem_progress.lock().unwrap();
        if p.model_downloading {
            return Ok(());
        }
        if p.building {
            return Err("索引任务正在运行，请稍候".into());
        }
        p.model_downloading = true;
        p.active_task = "semantic_model".into();
        p.error.clear();
        p.current = "下载/加载语义模型…".into();
    }
    clear_sem_status_cache();
    std::thread::spawn(move || {
        set_thread_background(true);
        let state = app.state::<AppState>();
        let result = get_embedder(state.inner()).map(|_| ());
        let mut p = state.sem_progress.lock().unwrap();
        p.model_downloading = false;
        p.active_task.clear();
        match result {
            Ok(()) => {
                p.error.clear();
                p.current = "语义模型已就绪".into();
                drop(p);
                clear_sem_status_cache();
            }
            Err(err) => {
                p.error = err;
                p.current.clear();
                drop(p);
                clear_sem_status_cache();
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_semantic_model(state: tauri::State<AppState>) -> Result<(), String> {
    {
        let p = state.sem_progress.lock().unwrap();
        if p.building || p.model_downloading {
            return Err("索引或模型任务正在运行，请稍候".into());
        }
    }
    *state.embedder.lock().unwrap() = None;
    SEM_PREPARED.store(false, Ordering::Release);
    if let Some(dir) = sem_model_dir() {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除模型失败：{e}"))?;
        }
    }
    clear_sem_status_cache();
    let mut p = state.sem_progress.lock().unwrap();
    p.current = "语义模型已删除".into();
    p.error.clear();
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_semantic_index(
    state: tauri::State<AppState>,
    kind: String,
) -> Result<(), String> {
    {
        let p = state.sem_progress.lock().unwrap();
        if p.building || p.model_downloading {
            return Err("索引或模型任务正在运行，请稍候".into());
        }
    }
    let kind = kind.trim();
    if kind == "semantic" {
        if let Some(d) = sem_dir() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.starts_with("sem_") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
        if let Some(path) = multi_profile_path() {
            let _ = std::fs::remove_file(path);
        }
        clear_global_index_files();
        state.sem_cache.lock().unwrap().clear();
        state.sem_cache_order.lock().unwrap().clear();
        state.sem_cache_bytes.store(0, Ordering::Relaxed);
        *state.global_index.lock().unwrap() = None;
        SEM_PREPARED.store(false, Ordering::Release);
        clear_sem_query_cache();
        clear_sem_profile_cache();
        clear_multi_profile_cache();
        clear_sem_index_snapshot_cache();
        clear_sem_status_cache();
        let mut p = state.sem_progress.lock().unwrap();
        p.current = "语义索引和加速索引已删除".into();
        p.error.clear();
        Ok(())
    } else if kind == "multi_profile" {
        if let Some(path) = multi_profile_path() {
            if path.exists() {
                std::fs::remove_file(path)
                    .map_err(|error| format!("删除多中心画像失败：{error}"))?;
            }
        }
        clear_multi_profile_cache();
        clear_sem_query_cache();
        if !update_multi_profile_status_cache(0, None, false) {
            clear_sem_status_cache();
        }
        let mut p = state.sem_progress.lock().unwrap();
        p.current = "多中心画像索引已删除".into();
        p.error.clear();
        Ok(())
    } else if kind == "accelerator" {
        clear_global_index_files();
        *state.global_index.lock().unwrap() = None;
        SEM_PREPARED.store(false, Ordering::Release);
        clear_sem_query_cache();
        clear_sem_index_snapshot_cache();
        clear_sem_status_cache();
        let mut p = state.sem_progress.lock().unwrap();
        p.current = "加速索引已删除".into();
        p.error.clear();
        Ok(())
    } else {
        Err("未知索引类型".into())
    }
}

#[tauri::command]
pub(crate) async fn build_semantic_vectors(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut p = state.sem_progress.lock().unwrap();
        if p.building {
            return Err("正在建立索引，请稍候".into());
        }
        if p.model_downloading {
            return Err("语义模型正在下载，请稍候".into());
        }
        *p = SemProgress {
            building: true,
            active_task: "semantic_vectors".into(),
            current: "加载模型…".into(),
            ..Default::default()
        };
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let state = app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                let mut p = state.sem_progress.lock().unwrap();
                p.building = false;
                p.active_task.clear();
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
            let mtime = search::file_mtime(&b.path);
            if sem_is_fresh(id, mtime) {
                if read_sem_profile(id, mtime).is_none()
                    && read_or_backfill_sem_profile(state.inner(), b).is_none()
                {
                    failures.push(format!("{}：无法生成相似图书缓存", b.title));
                }
                continue;
            }
            match search::get_book_chapters(state.inner(), b) {
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
        let mut p = state.sem_progress.lock().unwrap();
        p.done = p.total;
        p.building = false;
        p.active_task.clear();
        clear_sem_query_cache();
        clear_sem_profile_cache();
        p.current = if failures.is_empty() {
            "语义索引完成".into()
        } else {
            format!(
                "语义索引完成（{} 本失败；{}）",
                failures.len(),
                failures
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("；")
            )
        };
        drop(p);
        clear_sem_status_cache();
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn build_semantic_accelerator(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut p = state.sem_progress.lock().unwrap();
        if p.building {
            return Err("正在建立索引，请稍候".into());
        }
        if p.model_downloading {
            return Err("语义模型正在下载，请稍候".into());
        }
        *p = SemProgress {
            building: true,
            active_task: "semantic_accelerator".into(),
            current: "准备建立加速索引…".into(),
            ..Default::default()
        };
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let state = app.state::<AppState>();
        if indexed_book_ids(state.inner()).is_empty() {
            let mut p = state.sem_progress.lock().unwrap();
            p.building = false;
            p.active_task.clear();
            p.current = "请先建立语义索引".into();
            return;
        }
        let idx_err = build_global_index(state.inner()).err().unwrap_or_default();
        clear_sem_query_cache();
        let mut p = state.sem_progress.lock().unwrap();
        p.building = false;
        p.active_task.clear();
        p.current = if idx_err.is_empty() {
            "加速索引完成".into()
        } else {
            format!("加速索引未建成：{idx_err}")
        };
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn build_semantic_multi_profile(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut progress = state.sem_progress.lock().unwrap();
        if progress.building || progress.model_downloading {
            return Err("索引或模型任务正在运行，请稍候".into());
        }
        *progress = SemProgress {
            building: true,
            active_task: "semantic_multi_profile".into(),
            current: "准备生成多中心画像…".into(),
            ..Default::default()
        };
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let state = app.state::<AppState>();
        let result = build_multi_profile_file(state.inner());
        let cache_update = result
            .as_ref()
            .ok()
            .map(|(built, total)| (*built as u32, *total as u32));
        clear_sem_query_cache();
        let mut progress = state.sem_progress.lock().unwrap();
        progress.done = progress.total;
        progress.building = false;
        progress.active_task.clear();
        match result {
            Ok((built, total)) => {
                progress.error.clear();
                progress.current = if built == total {
                    format!("多中心画像索引完成（{built} 本）")
                } else {
                    format!(
                        "多中心画像索引完成（{built}/{total} 本；缺失图书可重建语义索引后更新）"
                    )
                };
            }
            Err(error) => {
                progress.error = error;
                progress.current.clear();
            }
        }
        drop(progress);
        if let Some((built, total)) = cache_update {
            if !update_multi_profile_status_cache(built, Some(total), built == total && total > 0) {
                clear_sem_status_cache();
            }
        } else {
            clear_sem_status_cache();
        }
        set_thread_background(false);
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
    rmp_serde::encode::write(&mut f, &map).map_err(|e| e.to_string())?;
    f.flush().ok();
    let mp = global_shard_map_path(k).ok_or("无缓存路径")?;
    let mut mf = std::io::BufWriter::new(std::fs::File::create(&mp).map_err(|e| e.to_string())?);
    rmp_serde::encode::write(&mut mf, mapping).map_err(|e| e.to_string())?;
    mf.flush().ok();
    Ok(())
}

fn clear_global_index_files() {
    if let Some(d) = sem_dir() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("global_")
                    || n == "global.hnsw"
                    || n == "global.map"
                    || n == "global.json"
                    || n == "global.build.json"
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

/// 用所有已建索引的书，构建“分片”近邻索引并落盘。一次只建一片→建图内存恒定，
/// 任何机器、任何库大小都不会因此爆内存（再大只是分片更多）。整本书归属同一片，不跨片。
fn build_global_index(state: &AppState) -> Result<(), String> {
    let (ids, source_sig) = indexed_book_snapshot(state);
    if ids.is_empty() {
        return Ok(());
    }
    let shard_total = estimate_global_shard_total(&ids);

    let mut shards: Vec<ShardMeta>;
    let mut processed_books = 0usize;
    let mut dim = 0usize;
    if let Some(meta) = read_global_build_meta(&ids, &source_sig) {
        shards = meta.shards;
        processed_books = meta.processed_books.min(ids.len());
        dim = meta.dim;
    } else {
        clear_global_index_files();
        shards = Vec::new();
    }

    let mut k = shards.len();
    if let Ok(mut p) = state.sem_progress.lock() {
        p.shard_done = k as u32;
        p.shard_total = shard_total;
        p.current = if k > 0 {
            format!(
                "续建加速索引（已完成 {}/{} 片，已处理 {}/{} 本）…",
                k,
                shard_total.max(k as u32),
                processed_books,
                ids.len()
            )
        } else {
            format!(
                "建立加速索引（第 1/{} 片，已处理 0/{} 本）…",
                shard_total.max(1),
                ids.len()
            )
        };
    }

    let mut points: Vec<SemPoint> = Vec::new();
    let mut values: Vec<u32> = Vec::new();
    let mut mapping: Vec<GlobalEntry> = Vec::new();
    let mut shard_books: Vec<u64> = Vec::new();
    for (idx, id) in ids.iter().enumerate().skip(processed_books) {
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
            processed_books = idx;
            write_global_build_meta(&GlobalBuildMeta {
                v: GLOBAL_CACHE_VERSION,
                model: SEM_MODEL.to_string(),
                dim,
                book_ids: ids.clone(),
                source_sig: source_sig.clone(),
                processed_books,
                shards: shards.clone(),
            })?;
            if let Ok(mut p) = state.sem_progress.lock() {
                p.shard_done = k as u32;
                p.shard_total = shard_total;
                p.current = format!(
                    "建立加速索引（已完成 {}/{} 片，已处理 {}/{} 本）…",
                    k,
                    shard_total.max(k as u32),
                    processed_books,
                    ids.len()
                );
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
        if let Ok(mut order) = state.sem_cache_order.lock() {
            order.retain(|cached_id| cached_id != id);
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
        k += 1;
        processed_books = ids.len();
        write_global_build_meta(&GlobalBuildMeta {
            v: GLOBAL_CACHE_VERSION,
            model: SEM_MODEL.to_string(),
            dim,
            book_ids: ids.clone(),
            source_sig: source_sig.clone(),
            processed_books,
            shards: shards.clone(),
        })?;
        if let Ok(mut p) = state.sem_progress.lock() {
            p.shard_done = k as u32;
            p.shard_total = shard_total.max(k as u32);
            p.current = format!(
                "建立加速索引（已完成 {}/{} 片，已处理 {}/{} 本）…",
                k,
                shard_total.max(k as u32),
                processed_books,
                ids.len()
            );
        }
    }
    if shards.is_empty() {
        return Ok(());
    }
    let meta = GlobalMeta {
        v: GLOBAL_CACHE_VERSION,
        model: SEM_MODEL.to_string(),
        dim,
        book_ids: ids,
        source_sig,
        shards,
    };
    std::fs::write(
        global_meta_path().ok_or("无缓存路径")?,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    remove_global_build_meta();
    *state.global_index.lock().unwrap() = None; // 让下次查询重新载入
    SEM_PREPARED.store(false, Ordering::Release);
    clear_sem_index_snapshot_cache();
    Ok(())
}

fn decode_global_hnsw<R: std::io::Read>(version: u32, reader: R) -> Result<GlobalHnsw, String> {
    if version == LEGACY_GLOBAL_CACHE_VERSION {
        bincode::deserialize_from(reader).map_err(|error| error.to_string())
    } else if version == GLOBAL_CACHE_VERSION {
        rmp_serde::decode::from_read(reader).map_err(|error| error.to_string())
    } else {
        Err(format!("不支持的 HNSW 版本：{version}"))
    }
}

fn decode_global_mapping<R: std::io::Read>(
    version: u32,
    reader: R,
) -> Result<Vec<GlobalEntry>, String> {
    if version == LEGACY_GLOBAL_CACHE_VERSION {
        bincode::deserialize_from(reader).map_err(|error| error.to_string())
    } else if version == GLOBAL_CACHE_VERSION {
        rmp_serde::decode::from_read(reader).map_err(|error| error.to_string())
    } else {
        Err(format!("不支持的 HNSW 映射版本：{version}"))
    }
}

/// 载入（并缓存）分片近邻索引。按内存预算尽量多载入分片；与当前已索引书集合不一致则视为过期。
/// 返回 None 表示无索引/过期/损坏（应整体退回暴力）。
fn load_global_index(state: &AppState) -> Option<Arc<LoadedShards>> {
    let _load_guard = sem_global_load_lock().lock().ok()?;
    let (current_ids, current_sig) = indexed_book_snapshot_cached(state);
    {
        let g = state.global_index.lock().unwrap();
        if let Some(a) = g.as_ref() {
            if a.book_ids == current_ids && a.source_sig == current_sig {
                return Some(a.clone());
            }
        }
    }
    let meta: GlobalMeta =
        serde_json::from_str(&std::fs::read_to_string(global_meta_path()?).ok()?).ok()?;
    if !global_cache_version_supported(meta.v) || meta.model != SEM_MODEL {
        return None;
    }
    if meta.book_ids != current_ids || meta.source_sig != current_sig {
        return None; // 索引集合变了 → 过期，退回暴力
    }
    let load_started = Instant::now();
    let budget = index_ram_budget();
    let mut graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)> = Vec::new();
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut used: u64 = 0;
    for (k, sh) in meta.shards.iter().enumerate() {
        let hnsw_path = global_shard_hnsw_path(k)?;
        let map_path = global_shard_map_path(k)?;
        let disk_bytes = std::fs::metadata(&hnsw_path)
            .map(|m| m.len())
            .unwrap_or(0)
            .saturating_add(std::fs::metadata(&map_path).map(|m| m.len()).unwrap_or(0));
        let est = shard_est_bytes(sh.chunks, meta.dim).max(disk_bytes);
        // 预算用尽就停（但至少载入一片，保证有加速）；其余分片的书查询时退回暴力
        if !graphs.is_empty() && used + est > budget {
            break;
        }
        let shard_started = Instant::now();
        let map = match decode_global_hnsw(
            meta.v,
            std::io::BufReader::new(std::fs::File::open(hnsw_path).ok()?),
        ) {
            Ok(map) => map,
            Err(error) => {
                crate::log(&format!(
                    "semantic_index_load failed shard={k} format_v={} stage=hnsw error={error}",
                    meta.v
                ));
                return None;
            }
        };
        let mapping = match decode_global_mapping(
            meta.v,
            std::io::BufReader::new(std::fs::File::open(map_path).ok()?),
        ) {
            Ok(mapping) => mapping,
            Err(error) => {
                crate::log(&format!(
                    "semantic_index_load failed shard={k} format_v={} stage=map error={error}",
                    meta.v
                ));
                return None;
            }
        };
        for id in &sh.books {
            covered.insert(*id);
        }
        graphs.push((map, mapping));
        used += est;
        crate::log(&format!(
            "semantic_index_load shard={k} books={} chunks={} est_mb={} elapsed_ms={}",
            sh.books.len(),
            sh.chunks,
            est / (1024 * 1024),
            shard_started.elapsed().as_millis()
        ));
    }
    if graphs.is_empty() {
        return None;
    }
    let arc = Arc::new(LoadedShards {
        graphs,
        covered,
        book_ids: meta.book_ids,
        source_sig: meta.source_sig,
    });
    *state.global_index.lock().unwrap() = Some(arc.clone());
    crate::log(&format!(
        "semantic_index_load complete format_v={} shards={} covered={} budget_mb={} used_mb={} elapsed_ms={}",
        meta.v,
        arc.graphs.len(),
        arc.covered.len(),
        budget / (1024 * 1024),
        used / (1024 * 1024),
        load_started.elapsed().as_millis()
    ));
    Some(arc)
}

/// 查询线程只使用已经在内存中的全局图，绝不在用户等待期间反序列化数 GB 索引。
/// 索引载入由 prepare_semantic_search 在后台完成；冷启动查询先走画像候选路径。
fn loaded_global_index_if_ready(state: &AppState) -> Option<Arc<LoadedShards>> {
    let loaded = state.global_index.lock().ok()?.clone()?;
    let (current_ids, current_sig) = indexed_book_snapshot_cached(state);
    (loaded.book_ids == current_ids && loaded.source_sig == current_sig).then_some(loaded)
}

fn search_one_graph(
    graph: &GlobalHnsw,
    mapping: &[GlobalEntry],
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    let qp = SemPoint(q.to_vec());
    let mut per: HashMap<u64, Vec<SemHit>> = HashMap::new();
    let mut best: HashMap<u64, f32> = HashMap::new();
    let mut search = instant_distance::Search::default();
    for item in graph.search(&qp, &mut search).take(SEM_HNSW_HITS_PER_SHARD) {
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

fn search_graphs(
    graphs: &[(GlobalHnsw, Vec<GlobalEntry>)],
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    if graphs.len() <= 1 {
        return graphs
            .first()
            .map(|(graph, mapping)| search_one_graph(graph, mapping, q, titles))
            .unwrap_or_default();
    }
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8).min(graphs.len()))
        .unwrap_or(2)
        .max(1);
    let chunk_size = graphs.len().div_ceil(nthreads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = graphs
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .flat_map(|(graph, mapping)| search_one_graph(graph, mapping, q, titles))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    })
}

/// 在已载入内存的分片上做近邻检索，返回每本书的命中聚合。
fn search_loaded_shards(
    li: &LoadedShards,
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    search_graphs(&li.graphs, q, titles)
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

fn profile_candidate_books(
    targets: &[book::Book],
    q: &[f32],
    limit: usize,
) -> (Vec<book::Book>, usize) {
    if targets.len() <= SEM_PROFILE_CANDIDATE_MIN {
        return (targets.to_vec(), 0);
    }
    let multi_profiles = load_multi_profile_index();
    let mut multi_scored = 0usize;
    let mut scored: Vec<(f32, u64, book::Book)> = targets
        .iter()
        .filter_map(|b| {
            if let Some(profile) = multi_profiles
                .as_ref()
                .and_then(|index| index.books.get(&b.id))
            {
                multi_scored += 1;
                return Some((
                    multi_profile_score(q, profile)?,
                    profile.vector_bytes,
                    b.clone(),
                ));
            }
            let mtime = search::file_mtime(&b.path);
            let (profile, _) = read_sem_profile(b.id, mtime)?;
            let bytes = sem_vec_path(b.id)
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|meta| meta.len())
                .unwrap_or(0);
            Some((dot(q, &profile), bytes, b.clone()))
        })
        .collect();
    if scored.is_empty() {
        return (targets.iter().take(limit).cloned().collect(), multi_scored);
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut selected = Vec::with_capacity(limit.min(scored.len()));
    let mut selected_bytes = 0u64;
    for (_, bytes, book) in scored {
        if selected.len() >= limit {
            break;
        }
        if selected.len() >= SEM_PROFILE_CANDIDATE_MIN
            && selected_bytes.saturating_add(bytes) > SEM_BRUTE_FORCE_READ_BUDGET
        {
            continue;
        }
        selected_bytes = selected_bytes.saturating_add(bytes);
        selected.push(book);
    }
    (selected, multi_scored)
}

/// 查询建立语义索引的进度。
fn semantic_status_snapshot(app: &tauri::AppHandle, state: &AppState) -> SemProgress {
    let mut live = state.sem_progress.lock().unwrap().clone();
    let now = now_ms();
    let mut should_refresh = false;
    let cached_snapshot = {
        let mut cache = sem_status_cache().lock().unwrap();
        let snapshot = cache.snapshot.clone();
        if cache
            .snapshot
            .as_ref()
            .is_none_or(|_| now.saturating_sub(cache.updated_at) > SEM_STATUS_CACHE_TTL_MS)
            && !cache.refreshing
        {
            cache.refreshing = true;
            should_refresh = true;
        }
        snapshot
    };
    if should_refresh {
        let app_for_refresh = app.clone();
        std::thread::spawn(move || {
            let state = app_for_refresh.state::<AppState>();
            let live = state.sem_progress.lock().unwrap().clone();
            let snapshot = enrich_sem_progress(state.inner(), live);
            if let Ok(mut cache) = sem_status_cache().lock() {
                cache.snapshot = Some(snapshot);
                cache.updated_at = now_ms();
                cache.refreshing = false;
            }
        });
    }
    if let Some(cached) = cached_snapshot.as_ref() {
        live = merge_sem_status_snapshot(live, cached);
    } else {
        live.status_refreshing = true;
    }
    live
}

#[tauri::command]
pub(crate) fn semantic_status(app: tauri::AppHandle, state: tauri::State<AppState>) -> SemProgress {
    semantic_status_snapshot(&app, state.inner())
}

#[tauri::command]
pub(crate) fn semantic_tasks(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> SemanticTaskCenter {
    semantic_task_center_from_progress(semantic_status_snapshot(&app, state.inner()))
}

/// 用户进入语义检索界面时提前初始化模型、跑一次编码 warmup，并按当前内存预算载入加速分片。
/// 命令立即返回；真正工作在后台线程完成。查询若紧接着到来，会复用同一加载锁而不会重复读 9GB 索引。
#[tauri::command]
pub(crate) fn prepare_semantic_search(app: tauri::AppHandle) -> Result<bool, String> {
    if SEM_PREPARED.load(Ordering::Acquire) {
        return Ok(false);
    }
    if SEM_PREPARE_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(false);
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let total_started = Instant::now();
        let state = app.state::<AppState>();
        let model_started = Instant::now();
        let result = get_embedder(state.inner()).and_then(|embedder| {
            let model_ms = model_started.elapsed().as_millis();
            let warm_started = Instant::now();
            // 已有真实查询在等待时不抢先跑虚拟 warmup；真实查询本身就是 warmup。
            if SEM_QUERY_ACTIVE.load(Ordering::Acquire) == 0 {
                let _guard = sem_embed_lock()
                    .lock()
                    .map_err(|_| "语义编码锁定失败".to_string())?;
                let _ = embedder
                    .lock()
                    .map_err(|_| "语义模型锁定失败".to_string())?
                    .embed(
                        vec![format!("{SEM_QUERY_PREFIX}阅读")],
                        None,
                    )
                    .map_err(|e| e.to_string())?;
            }
            let warm_ms = warm_started.elapsed().as_millis();
            // 首查走轻量画像路径时，避免 9GB 顺序读取与候选向量争抢磁盘。
            // 查询返回后再在后台载入全局图，后续查询即可直接复用。
            while SEM_QUERY_ACTIVE.load(Ordering::Acquire) > 0 {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            let index_started = Instant::now();
            let loaded = load_global_index(state.inner());
            let index_ms = index_started.elapsed().as_millis();
            crate::log(&format!(
                "semantic_prepare model_ms={model_ms} warm_ms={warm_ms} index_ms={index_ms} shards={} covered={} total_ms={}",
                loaded.as_ref().map(|index| index.graphs.len()).unwrap_or(0),
                loaded.as_ref().map(|index| index.covered.len()).unwrap_or(0),
                total_started.elapsed().as_millis()
            ));
            Ok(())
        });
        match result {
            Ok(()) => SEM_PREPARED.store(true, Ordering::Release),
            Err(error) => crate::log(&format!(
                "semantic_prepare failed elapsed_ms={} error={error}",
                total_started.elapsed().as_millis()
            )),
        }
        SEM_PREPARE_RUNNING.store(false, Ordering::Release);
        set_thread_background(false);
    });
    Ok(true)
}

fn semantic_search_inner(
    state: &AppState,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let total_started = Instant::now();
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let query_chars = query.chars().count();
    let cache_key = sem_query_cache_key(&query, &ids);
    let cache_stamp = sem_query_cache_stamp();
    if let Some(cached) = get_sem_query_cache(&cache_key, cache_stamp) {
        crate::log(&format!(
            "semantic_search cache_hit=true query_chars={query_chars} results={} total_ms={}",
            cached.len(),
            total_started.elapsed().as_millis()
        ));
        return Ok(cached);
    }

    let model_started = Instant::now();
    let embedder = get_embedder(state)?;
    let model_ms = model_started.elapsed().as_millis();
    let encode_started = Instant::now();
    let mut q = {
        let _guard = sem_embed_lock()
            .lock()
            .map_err(|_| "语义编码锁定失败".to_string())?;
        embedder
            .lock()
            .map_err(|_| "语义模型锁定失败".to_string())?
            .embed(vec![format!("{SEM_QUERY_PREFIX}{query}")], None)
            .map_err(|e| e.to_string())?
            .remove(0)
    };
    normalize(&mut q);
    let encode_ms = encode_started.elapsed().as_millis();
    let want: Option<std::collections::HashSet<u64>> = ids.map(|values| {
        values
            .iter()
            .filter_map(|id| id.parse::<u64>().ok())
            .collect()
    });

    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut results: Vec<SemBookHits> = Vec::new();
    let mut loaded_shards = 0usize;
    let index_started = Instant::now();
    let loaded_index = if want.is_none() {
        loaded_global_index_if_ready(state)
    } else {
        None
    };
    let index_ms = index_started.elapsed().as_millis();
    let graph_started = Instant::now();
    if let Some(index) = loaded_index {
        let titles: HashMap<u64, (String, String)> = {
            let lib = state.library.lock().unwrap();
            lib.books
                .iter()
                .map(|book| (book.id, (book.title.clone(), book.author.clone())))
                .collect()
        };
        loaded_shards = index.graphs.len();
        covered = index.covered.clone();
        results.extend(search_loaded_shards(&index, &q, &titles));
    }
    let graph_ms = graph_started.elapsed().as_millis();

    let mut targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|book| book.format != "pdf")
            .filter(|book| {
                want.as_ref()
                    .map(|set| set.contains(&book.id))
                    .unwrap_or(true)
            })
            .filter(|book| !covered.contains(&book.id))
            .filter(|book| {
                sem_meta_path(book.id)
                    .map(|path| path.exists())
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    };
    let fallback_books = targets.len();
    let profile_started = Instant::now();
    let mut multi_profile_books = 0usize;
    if want.is_none() {
        let selection = profile_candidate_books(&targets, &q, SEM_PROFILE_CANDIDATE_LIMIT);
        targets = selection.0;
        multi_profile_books = selection.1;
    }
    let profile_ms = profile_started.elapsed().as_millis();
    let candidate_books = targets.len();
    let brute_started = Instant::now();
    results.extend(brute_force_books(state, &targets, &q));
    let brute_ms = brute_started.elapsed().as_millis();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(60);
    put_sem_query_cache(cache_key, cache_stamp, &results);
    crate::log(&format!(
        "semantic_search cache_hit=false query_chars={query_chars} model_ms={model_ms} encode_ms={encode_ms} index_ms={index_ms} graph_ms={graph_ms} profile_ms={profile_ms} brute_ms={brute_ms} shards={loaded_shards} covered={} fallback_books={fallback_books} candidates={candidate_books} multi_profile_books={multi_profile_books} vector_cache_mb={} results={} total_ms={}",
        covered.len(),
        state.sem_cache_bytes.load(Ordering::Relaxed) / (1024 * 1024),
        results.len(),
        total_started.elapsed().as_millis()
    ));
    Ok(results)
}

/// 语义检索：把查询转成向量，在已建索引的图书里按相似度排序返回。
#[tauri::command]
pub(crate) async fn semantic_search(
    app: tauri::AppHandle,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let query_activity = SemanticQueryActivity::enter();
    // 冷启动时后台载入模型和全局图。查询本身不会再等待大图载入，
    // 而是先通过书籍画像给出一批快速结果。
    if ids.is_none() {
        let _ = prepare_semantic_search(app.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _query_activity = query_activity;
        let state = app.state::<AppState>();
        semantic_search_inner(state.inner(), query, ids)
    })
    .await
    .map_err(|error| format!("语义检索任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn similar_books(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<SimilarBook>, String> {
    let source_id = id.parse::<u64>().map_err(|_| "无效图书 id".to_string())?;
    let source_book = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .find(|b| b.id == source_id)
            .cloned()
            .ok_or_else(|| "找不到这本书".to_string())?
    };
    let source_mtime = search::file_mtime(&source_book.path);
    let (source_profile, _) = read_sem_profile(source_book.id, source_mtime)
        .ok_or_else(|| "请先建立或刷新语义索引，以生成相似图书缓存".to_string())?;

    let books: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.id != source_id)
            .filter(|b| b.format != "pdf")
            .filter(|b| sem_meta_path(b.id).map(|p| p.exists()).unwrap_or(false))
            .cloned()
            .collect()
    };

    let mut out = Vec::new();
    for b in books {
        let mtime = search::file_mtime(&b.path);
        let Some((profile, indexed_chunks)) = read_sem_profile(b.id, mtime) else {
            continue;
        };
        let score = dot(&source_profile, &profile).clamp(0.0, 1.0);
        if score <= 0.0 {
            continue;
        }
        let id = b.id;
        out.push(SimilarBook {
            id: id.to_string(),
            title: b.title.clone(),
            author: b.author.clone(),
            cover: b
                .cover
                .as_ref()
                .map(|_| format!("{RES_BASE}/cover/{id}?v={}", b.cover_ver)),
            progress: b.progress,
            score,
            indexed_chunks,
        });
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(5);
    Ok(out)
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
pub(crate) fn sem_probe() {
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
        let mut model = TextEmbedding::try_new(opt).map_err(|e| format!("MODEL ERR: {e}"))?;
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
pub(crate) fn hnsw_probe() {
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
    let bytes = match rmp_serde::to_vec(&map) {
        Ok(b) => b,
        Err(e) => {
            write(&format!("SER ERR: {e}"));
            return;
        }
    };
    let map2: HnswMap<V, u32> = match rmp_serde::from_slice(&bytes) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk() -> SemChunk {
        SemChunk {
            c: 0,
            t: String::new(),
        }
    }

    #[test]
    fn multi_profile_keeps_separate_local_topics() {
        let mut vecs = Vec::new();
        for index in 0..512 {
            if index < 256 {
                vecs.extend_from_slice(&[1.0, 0.0]);
            } else {
                vecs.extend_from_slice(&[0.0, 1.0]);
            }
        }
        let data = SemData {
            dim: 2,
            vecs,
            chunks: (0..512).map(|_| chunk()).collect(),
        };
        let centers = multi_profile_centers(&data);
        assert_eq!(centers.len(), 8);
        let profile = MultiProfileBook {
            mtime: 1,
            dim: 2,
            vector_bytes: 4096,
            centers,
        };
        assert_eq!(multi_profile_score(&[1.0, 0.0], &profile), Some(1.0));
        assert_eq!(multi_profile_score(&[0.0, 1.0], &profile), Some(1.0));
    }

    #[test]
    fn multi_profile_roundtrip_preserves_book_metadata() {
        let mut books = HashMap::new();
        books.insert(
            7,
            MultiProfileBook {
                mtime: 11,
                dim: 2,
                vector_bytes: 16,
                centers: vec![1.0, 0.0, 0.0, 1.0],
            },
        );
        let index = MultiProfileIndex {
            v: MULTI_PROFILE_VERSION,
            model: SEM_MODEL.into(),
            source_sig: vec![(7, 11)],
            books,
        };
        let bytes = rmp_serde::to_vec(&index).unwrap();
        let decoded: MultiProfileIndex = rmp_serde::from_slice(&bytes).unwrap();
        let book = decoded.books.get(&7).unwrap();
        assert_eq!(book.mtime, 11);
        assert_eq!(book.vector_bytes, 16);
        assert_eq!(book.centers.len(), 4);
    }

    #[test]
    fn legacy_multi_profile_decodes_and_is_marked_for_migration() {
        let mut books = HashMap::new();
        books.insert(
            7,
            MultiProfileBook {
                mtime: 11,
                dim: 2,
                vector_bytes: 16,
                centers: vec![1.0, 0.0],
            },
        );
        let legacy = MultiProfileIndex {
            v: LEGACY_MULTI_PROFILE_VERSION,
            model: SEM_MODEL.into(),
            source_sig: vec![(7, 11)],
            books,
        };
        let bytes = bincode::serialize(&legacy).unwrap();
        let (decoded, needs_migration) = decode_multi_profile_index(&bytes).unwrap();
        assert!(needs_migration);
        assert_eq!(decoded.books.len(), 1);
    }

    #[test]
    fn legacy_and_current_hnsw_shards_decode_through_the_same_reader() {
        let points = vec![
            SemPoint(vec![1.0, 0.0]),
            SemPoint(vec![0.0, 1.0]),
            SemPoint(vec![0.9, 0.1]),
        ];
        let values = vec![10u32, 11, 12];
        let map: GlobalHnsw = instant_distance::Builder::default().build(points, values);
        let mapping = vec![GlobalEntry {
            b: 7,
            c: 3,
            t: "测试".into(),
        }];

        let legacy_map = bincode::serialize(&map).unwrap();
        let legacy_mapping = bincode::serialize(&mapping).unwrap();
        let current_map = rmp_serde::to_vec(&map).unwrap();
        let current_mapping = rmp_serde::to_vec(&mapping).unwrap();

        for (version, map_bytes, mapping_bytes) in [
            (
                LEGACY_GLOBAL_CACHE_VERSION,
                legacy_map.as_slice(),
                legacy_mapping.as_slice(),
            ),
            (
                GLOBAL_CACHE_VERSION,
                current_map.as_slice(),
                current_mapping.as_slice(),
            ),
        ] {
            let decoded = decode_global_hnsw(version, std::io::Cursor::new(map_bytes)).unwrap();
            let decoded_mapping =
                decode_global_mapping(version, std::io::Cursor::new(mapping_bytes)).unwrap();
            let mut search = instant_distance::Search::default();
            let hits = decoded
                .search(&SemPoint(vec![1.0, 0.0]), &mut search)
                .take(1)
                .collect::<Vec<_>>();
            assert_eq!(*hits[0].value, 10);
            assert_eq!(decoded_mapping[0].b, 7);
        }
    }
}
