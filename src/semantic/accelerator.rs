//! 全局语义加速索引（分片 HNSW）的构建、恢复、完整性校验与查询。
//!
//! 逐书向量由 vector 模块拥有；本模块按内存预算收集向量并发布可恢复分片。

use super::{index_runtime, model, profile, vector, SemBookHits, SemHit};
use crate::semantic_core::{index_ram_budget, shard_est_bytes, SHARD_MAX_CHUNKS};
use crate::{now_ms, AppState};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

pub(super) const PAUSED: &str = "__semantic_accelerator_paused__";
pub(super) const CANCELLED: &str = "__semantic_accelerator_cancelled__";

static INDEX_SNAPSHOT_CACHE: OnceLock<Mutex<SemIndexSnapshotCache>> = OnceLock::new();
static GLOBAL_LOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PREPARE_RUNNING: AtomicBool = AtomicBool::new(false);
static PREPARED: AtomicBool = AtomicBool::new(false);

const INDEX_SNAPSHOT_TTL_MS: u64 = 10_000;
const HNSW_HITS_PER_SHARD: usize = 128;
const GLOBAL_CACHE_VERSION: u32 = 6;
const PREVIOUS_GLOBAL_CACHE_VERSION: u32 = 5;
const HISTORIC_GLOBAL_CACHE_VERSION: u32 = 4;
const OLDER_GLOBAL_CACHE_VERSION: u32 = 3;
const LEGACY_GLOBAL_CACHE_VERSION: u32 = 2;
const BUILD_WORKING_SET_MULTIPLIER: u64 = 10;
const BUILD_MIN_CHUNKS: usize = 1_000;

#[derive(Default)]
struct SemIndexSnapshotCache {
    updated_at: u64,
    book_ids: Vec<u64>,
    source_sig: Vec<vector::IndexSourceSignature>,
}

fn snapshot_cache() -> &'static Mutex<SemIndexSnapshotCache> {
    INDEX_SNAPSHOT_CACHE.get_or_init(|| Mutex::new(SemIndexSnapshotCache::default()))
}

fn global_load_lock() -> &'static Mutex<()> {
    GLOBAL_LOAD_LOCK.get_or_init(|| Mutex::new(()))
}

fn task_control(task: Option<&crate::background_tasks::TaskRunGuard>) -> Result<(), String> {
    match task.map(|task| task.control_signal()) {
        Some(crate::background_tasks::TaskControlSignal::Pause) => Err(PAUSED.into()),
        Some(crate::background_tasks::TaskControlSignal::Cancel) => Err(CANCELLED.into()),
        _ => Ok(()),
    }
}

pub(super) fn is_prepared() -> bool {
    PREPARED.load(Ordering::Acquire)
}

pub(super) fn begin_prepare() -> bool {
    PREPARE_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

pub(super) fn finish_prepare(success: bool) {
    if success {
        PREPARED.store(true, Ordering::Release);
    }
    PREPARE_RUNNING.store(false, Ordering::Release);
}

pub(super) fn mark_unprepared() {
    PREPARED.store(false, Ordering::Release);
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
    books: Vec<u64>, // 本分片覆盖的书；超大书可跨多个连续分片
    chunks: usize,   // 本分片段落数（估算载入内存用）
    #[serde(default)]
    graph_bytes: u64,
    #[serde(default)]
    graph_sha256: String,
    #[serde(default)]
    map_bytes: u64,
    #[serde(default)]
    map_sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct GlobalMeta {
    v: u32,
    model: String,
    #[serde(default)]
    model_revision: String,
    #[serde(default)]
    chunk_revision: u32,
    dim: usize,
    book_ids: Vec<u64>, // 参与建图的全部书（排序），用于判断是否过期
    #[serde(default, deserialize_with = "deserialize_source_sig_compat")]
    source_sig: Vec<vector::IndexSourceSignature>,
    shards: Vec<ShardMeta>, // 各分片描述
}
#[derive(Serialize, Deserialize)]
struct GlobalBuildMeta {
    v: u32,
    model: String,
    #[serde(default)]
    model_revision: String,
    #[serde(default)]
    chunk_revision: u32,
    dim: usize,
    book_ids: Vec<u64>,
    #[serde(default, deserialize_with = "deserialize_source_sig_compat")]
    source_sig: Vec<vector::IndexSourceSignature>,
    processed_books: usize,
    shards: Vec<ShardMeta>,
}
/// 已载入内存、可供查询的分片集合。
pub(crate) struct LoadedShards {
    graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)>, // 每片：近邻图 + 段落映射
    covered: std::collections::HashSet<u64>,     // 这些分片覆盖到的书；其余的书查询时退回暴力
    book_ids: Vec<u64>,                          // 建图时的全部书集合（判过期）
    source_sig: Vec<vector::IndexSourceSignature>, // 建图时的强来源签名（判过期）
    _memory_permit: crate::memory_budget::MemoryPermit,
}

fn deserialize_source_sig_compat<'de, D>(
    deserializer: D,
) -> Result<Vec<vector::IndexSourceSignature>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum CompatibleSourceSignatures {
        Strong(Vec<vector::IndexSourceSignature>),
        Legacy(Vec<(u64, u64)>),
    }

    Ok(
        match CompatibleSourceSignatures::deserialize(deserializer)? {
            CompatibleSourceSignatures::Strong(signatures) => signatures,
            // 旧 `(id, mtime)` 仍可解码，以便明确识别并安全重建；它缺少强
            // 完整性承诺，绝不能转换为当前签名或参与续建。
            CompatibleSourceSignatures::Legacy(_signatures) => Vec::new(),
        },
    )
}

impl LoadedShards {
    pub(super) fn shard_count(&self) -> usize {
        self.graphs.len()
    }

    pub(super) fn covered_ids(&self) -> HashSet<u64> {
        self.covered.clone()
    }
}

fn global_shard_hnsw_path(k: usize) -> Option<std::path::PathBuf> {
    Some(vector::directory()?.join(format!("global_{k}.hnsw")))
}
fn global_shard_map_path(k: usize) -> Option<std::path::PathBuf> {
    Some(vector::directory()?.join(format!("global_{k}.map")))
}
fn global_meta_path() -> Option<std::path::PathBuf> {
    Some(vector::directory()?.join("global.json"))
}

pub(super) fn cache_stamp() -> u64 {
    global_meta_path()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
fn global_build_meta_path() -> Option<std::path::PathBuf> {
    Some(vector::directory()?.join("global.build.json"))
}

fn indexed_book_snapshot(state: &AppState) -> (Vec<u64>, Vec<vector::IndexSourceSignature>) {
    let snapshot = vector::index_source_snapshot(state);
    let ids = snapshot.iter().map(|signature| signature.book_id).collect();
    (ids, snapshot)
}

pub(super) fn indexed_book_snapshot_cached(
    state: &AppState,
) -> (Vec<u64>, Vec<vector::IndexSourceSignature>) {
    let now = now_ms();
    if let Ok(cache) = snapshot_cache().lock() {
        if !cache.book_ids.is_empty()
            && now.saturating_sub(cache.updated_at) <= INDEX_SNAPSHOT_TTL_MS
        {
            return (cache.book_ids.clone(), cache.source_sig.clone());
        }
    }
    // 快照必须从当前 Library 与逐书向量完整性校验生成。合并画像本身是
    // 派生数据，不能反过来为自己的来源“作证”。
    let (book_ids, source_sig) = indexed_book_snapshot(state);
    if let Ok(mut cache) = snapshot_cache().lock() {
        cache.updated_at = now;
        cache.book_ids = book_ids.clone();
        cache.source_sig = source_sig.clone();
    }
    (book_ids, source_sig)
}

pub(super) fn clear_snapshot_cache() {
    if let Ok(mut cache) = snapshot_cache().lock() {
        *cache = SemIndexSnapshotCache::default();
    }
}

/// 当前可进入全库加速分片的书 id（排序）。
pub(super) fn indexed_book_ids(state: &AppState) -> Vec<u64> {
    indexed_book_snapshot(state).0
}

fn global_shard_shape_valid(version: u32, k: usize, shard: &ShardMeta) -> bool {
    let Some(graph_path) = global_shard_hnsw_path(k) else {
        return false;
    };
    let Some(map_path) = global_shard_map_path(k) else {
        return false;
    };
    let graph_len = std::fs::metadata(graph_path).map(|m| m.len()).unwrap_or(0);
    let map_len = std::fs::metadata(map_path).map(|m| m.len()).unwrap_or(0);
    if graph_len == 0 || map_len == 0 {
        return false;
    }
    if version == GLOBAL_CACHE_VERSION {
        shard.graph_bytes != 0
            && shard.map_bytes != 0
            && !shard.graph_sha256.is_empty()
            && !shard.map_sha256.is_empty()
            && graph_len == shard.graph_bytes
            && map_len == shard.map_bytes
    } else {
        true
    }
}

fn file_integrity_valid(
    path: &std::path::Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> bool {
    if expected_bytes == 0
        || expected_sha256.len() != 64
        || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || std::fs::metadata(path).map(|metadata| metadata.len()).ok() != Some(expected_bytes)
    {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 256 * 1024];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            return false;
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    actual == expected_sha256
}

/// 检查点只有在两个分片文件的真实 SHA-256 都匹配后才可续建。
fn global_shard_integrity_valid(version: u32, k: usize, shard: &ShardMeta) -> bool {
    if version != GLOBAL_CACHE_VERSION || !global_shard_shape_valid(version, k, shard) {
        return false;
    }
    let Some(graph_path) = global_shard_hnsw_path(k) else {
        return false;
    };
    let Some(map_path) = global_shard_map_path(k) else {
        return false;
    };
    file_integrity_valid(&graph_path, shard.graph_bytes, &shard.graph_sha256)
        && file_integrity_valid(&map_path, shard.map_bytes, &shard.map_sha256)
}

pub(super) fn global_index_fresh(state: &AppState) -> bool {
    let Some(p) = global_meta_path() else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    let (book_ids, source_sig) = indexed_book_snapshot_cached(state);
    match serde_json::from_str::<GlobalMeta>(&s) {
        Ok(m) => {
            m.v == GLOBAL_CACHE_VERSION
                && m.model == model::active_id()
                && m.model_revision == model::active().revision()
                && m.chunk_revision == crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION
                && m.book_ids == book_ids
                && m.source_sig == source_sig
                && !m.shards.is_empty()
                && m.shards
                    .iter()
                    .enumerate()
                    .all(|(k, shard)| global_shard_shape_valid(m.v, k, shard))
        }
        Err(_) => false,
    }
}

fn global_build_meta_compatible(
    m: &GlobalBuildMeta,
    ids: &[u64],
    source_sig: &[vector::IndexSourceSignature],
) -> bool {
    m.v == GLOBAL_CACHE_VERSION
        && m.model == model::active_id()
        && m.model_revision == model::active().revision()
        && m.chunk_revision == crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION
        && m.book_ids == ids
        && m.source_sig == source_sig
        && m.processed_books <= ids.len()
        && m.shards
            .iter()
            .enumerate()
            .all(|(k, shard)| global_shard_integrity_valid(m.v, k, shard))
}

/// 返回旧检查点与当前书目完全相同的最长前缀。加速索引的每片都只包含一段
/// 连续前缀；因此书库后来补进一本书、或后半段某本书的向量更新时，前面已落盘
/// 的片仍然可直接复用，无须从第 1 片重建。
fn global_build_common_prefix(
    old_ids: &[u64],
    old_source_sig: &[vector::IndexSourceSignature],
    ids: &[u64],
    source_sig: &[vector::IndexSourceSignature],
) -> usize {
    old_ids
        .iter()
        .zip(old_source_sig)
        .zip(ids.iter().zip(source_sig))
        .take_while(|((old_id, old_sig), (id, sig))| old_id == id && old_sig == sig)
        .count()
}

/// 在书目快照变化后，保留仍然位于未变化前缀中的完整分片。只复用“整片”，
/// 绝不把新旧书目里的半片混在一起；任何已变化书之前的片照常保留，变化处起
/// 重新建立。
fn recover_global_build_meta(
    m: &GlobalBuildMeta,
    ids: &[u64],
    source_sig: &[vector::IndexSourceSignature],
) -> Option<GlobalBuildMeta> {
    if m.v != GLOBAL_CACHE_VERSION
        || m.model != model::active_id()
        || m.model_revision != model::active().revision()
        || m.chunk_revision != crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION
        || m.dim == 0
        || m.processed_books > m.book_ids.len()
    {
        return None;
    }
    let common = global_build_common_prefix(&m.book_ids, &m.source_sig, ids, source_sig);
    let mut processed_books = 0usize;
    let mut shards = Vec::new();
    for (k, shard) in m.shards.iter().enumerate() {
        let count = shard.books.len();
        if count == 0
            || processed_books.saturating_add(count) > common
            || processed_books.saturating_add(count) > m.processed_books
            || m.book_ids.get(processed_books..processed_books + count)
                != Some(shard.books.as_slice())
            || !global_shard_integrity_valid(m.v, k, shard)
        {
            break;
        }
        shards.push(shard.clone());
        processed_books += count;
    }
    if shards.is_empty() {
        return None;
    }
    Some(GlobalBuildMeta {
        v: GLOBAL_CACHE_VERSION,
        model: model::active_id().to_string(),
        model_revision: model::active().revision().to_string(),
        chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
        dim: m.dim,
        book_ids: ids.to_vec(),
        source_sig: source_sig.to_vec(),
        processed_books,
        shards,
    })
}

fn read_global_build_meta(
    ids: &[u64],
    source_sig: &[vector::IndexSourceSignature],
) -> Option<GlobalBuildMeta> {
    let meta: GlobalBuildMeta =
        serde_json::from_str(&std::fs::read_to_string(global_build_meta_path()?).ok()?).ok()?;
    if global_build_meta_compatible(&meta, ids, source_sig) {
        Some(meta)
    } else {
        recover_global_build_meta(&meta, ids, source_sig)
    }
}

pub(super) fn build_progress(
    ids: &[u64],
    source_sig: &[vector::IndexSourceSignature],
) -> Option<(u32, usize)> {
    let metadata = read_global_build_meta(ids, source_sig)?;
    Some((metadata.shards.len() as u32, metadata.processed_books))
}

fn write_global_build_meta(meta: &GlobalBuildMeta) -> Result<(), String> {
    let path = global_build_meta_path().ok_or("无缓存路径")?;
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let bytes = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&path, &bytes)
}

fn remove_global_build_meta() {
    if let Some(p) = global_build_meta_path() {
        let _ = std::fs::remove_file(p);
    }
}

pub(super) fn estimate_global_shard_total(ids: &[u64]) -> u32 {
    let mut total = 0u32;
    let mut current = 0usize;
    for id in ids {
        let Some((dim, chunks)) = vector::stored_shape(*id) else {
            continue;
        };
        let limit = global_build_shard_chunk_limit(dim);
        let mut remaining = chunks;
        while remaining > 0 {
            if current == limit {
                total += 1;
                current = 0;
            }
            let take = remaining.min(limit.saturating_sub(current).max(1));
            current = current.saturating_add(take);
            remaining = remaining.saturating_sub(take);
        }
    }
    if current > 0 {
        total += 1;
    }
    total
}

fn build_working_set(chunks: usize, dim: usize) -> u64 {
    shard_est_bytes(chunks, dim).saturating_mul(BUILD_WORKING_SET_MULTIPLIER)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShardAdmission {
    Add { target_bytes: u64 },
    FlushThenAdd { target_bytes: u64 },
    RejectBook { required_bytes: u64 },
}

fn plan_shard_admission(
    current_chunks: usize,
    book_chunks: usize,
    dim: usize,
    budget: u64,
    chunk_limit: usize,
) -> ShardAdmission {
    let book_bytes = build_working_set(book_chunks, dim);
    if book_bytes > budget {
        return ShardAdmission::RejectBook {
            required_bytes: book_bytes,
        };
    }
    let target_chunks = current_chunks.saturating_add(book_chunks);
    let target_bytes = build_working_set(target_chunks, dim);
    if current_chunks > 0 && (target_chunks > chunk_limit || target_bytes > budget) {
        ShardAdmission::FlushThenAdd {
            target_bytes: book_bytes,
        }
    } else {
        ShardAdmission::Add { target_bytes }
    }
}

fn acquire_build_permit(bytes: u64) -> Result<crate::memory_budget::MemoryPermit, String> {
    crate::memory_budget::governor()
        .try_acquire(
            crate::memory_budget::MemoryClass::SemanticGraph,
            crate::memory_budget::MemoryUsageKind::Transient,
            bytes,
        )
        .map_err(|error| format!("加速索引构图内存预算不足：需要 {bytes} 字节；{error}"))
}

/// 建图的 HNSW 需要多份向量和图结构临时内存；按当前可用内存与实际维度限制
/// 每片大小。维度越高时会自动细分，以满足构图期间的内存预算。
fn global_build_shard_chunk_limit(dim: usize) -> usize {
    global_build_shard_chunk_limit_for_budget(dim, index_ram_budget())
}

fn global_build_shard_chunk_limit_for_budget(dim: usize, budget: u64) -> usize {
    if dim == 0 {
        return SHARD_MAX_CHUNKS;
    }
    let bytes_per_chunk = (dim as u64).saturating_mul(4).saturating_add(400);
    let safe = budget
        .saturating_div(bytes_per_chunk.saturating_mul(BUILD_WORKING_SET_MULTIPLIER))
        .min(SHARD_MAX_CHUNKS as u64) as usize;
    safe.clamp(BUILD_MIN_CHUNKS, SHARD_MAX_CHUNKS)
}

fn write_shard(
    k: usize,
    points: Vec<SemPoint>,
    values: Vec<u32>,
    mapping: &[GlobalEntry],
) -> Result<(u64, String, u64, String), String> {
    let hp = global_shard_hnsw_path(k).ok_or("无缓存路径")?;
    if let Some(d) = hp.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let dimensions = points.first().map(|point| point.0.len()).unwrap_or(0);
    let point_count = points.len();
    let build_started = Instant::now();
    let map: GlobalHnsw = index_runtime::install(move || {
        index_runtime::builder_for(dimensions, point_count).build(points, values)
    });
    crate::log(&format!(
        "semantic_accelerator stage=build_graph shard={k} points={point_count} dimensions={dimensions} elapsed_ms={}",
        build_started.elapsed().as_millis()
    ));
    let mp = global_shard_map_path(k).ok_or("无缓存路径")?;
    // 直接流式序列化到同目录临时文件，同时计算长度与哈希；不再额外持有两份
    // 数 GB Vec。只有两个文件都提交成功，调用方才发布 build checkpoint。
    let serialize_started = Instant::now();
    let (graph_len, graph_sha256) = super::write_rmp_hashed(&hp, &map)?;
    let (map_len, map_sha256) = super::write_rmp_hashed(&mp, mapping)?;
    crate::log(&format!(
        "semantic_accelerator stage=serialize shard={k} graph_bytes={graph_len} map_bytes={map_len} elapsed_ms={}",
        serialize_started.elapsed().as_millis()
    ));
    Ok((graph_len, graph_sha256, map_len, map_sha256))
}

fn clear_global_index_files() {
    if let Some(d) = vector::directory() {
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

pub(super) fn delete_index(state: &AppState) {
    clear_global_index_files();
    *state.global_index.lock().unwrap() = None;
    mark_unprepared();
    clear_snapshot_cache();
}

/// 从 `first` 开始移除未被检查点引用的旧分片。书目变化后只保留完整前缀，
/// 其余旧分片既不能参与查询，也不能计入容量或误当作下次续建的成果。
fn remove_global_shards_from(first: usize) {
    let Some(d) = vector::directory() else {
        return;
    };
    let Ok(rd) = std::fs::read_dir(&d) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let shard_index = name
            .strip_prefix("global_")
            .and_then(|rest| rest.split('.').next())
            .and_then(|index| index.parse::<usize>().ok());
        if shard_index.is_some_and(|index| index >= first)
            || name == "global.hnsw"
            || name == "global.map"
            || name == "global.json"
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 校验或解码发现坏片时，只丢弃该片及其后缀；当前格式中此前完整片会重新写成
/// build checkpoint，下一次“续建”从坏片开始。旧格式没有哈希承诺，安全起见整体重建。
fn invalidate_global_index_from(meta: &GlobalMeta, first_bad: usize, reason: &str) {
    crate::log(&format!(
        "semantic_index_invalidated first_bad_shard={first_bad} format_v={} reason={reason}",
        meta.v
    ));
    if meta.v == GLOBAL_CACHE_VERSION && first_bad > 0 && first_bad <= meta.shards.len() {
        let shards = meta.shards[..first_bad].to_vec();
        let processed_books = shards.iter().map(|shard| shard.books.len()).sum();
        let checkpoint = GlobalBuildMeta {
            v: GLOBAL_CACHE_VERSION,
            model: meta.model.clone(),
            model_revision: meta.model_revision.clone(),
            chunk_revision: meta.chunk_revision,
            dim: meta.dim,
            book_ids: meta.book_ids.clone(),
            source_sig: meta.source_sig.clone(),
            processed_books,
            shards,
        };
        if write_global_build_meta(&checkpoint).is_ok() {
            remove_global_shards_from(first_bad);
            return;
        }
    }
    clear_global_index_files();
}

/// 用所有已建索引的书，构建“分片”近邻索引并落盘。一次只建一片→建图内存恒定，
/// 任何机器、任何库大小都不会因此爆内存（再大只是分片更多）。整本书归属同一片，不跨片。
pub(super) fn build_global_index(
    state: &AppState,
    task: Option<&crate::background_tasks::TaskRunGuard>,
) -> Result<(), String> {
    task_control(task)?;
    if global_index_fresh(state) {
        return Ok(());
    }
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
        // `read_global_build_meta` 可能刚把旧快照的完整前缀恢复为当前快照。
        // 立即持久化新的快照并清理后面的旧片，之后再次关闭程序也仍能从这里续建。
        remove_global_shards_from(shards.len());
        write_global_build_meta(&GlobalBuildMeta {
            v: GLOBAL_CACHE_VERSION,
            model: model::active_id().to_string(),
            model_revision: model::active().revision().to_string(),
            chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
            dim,
            book_ids: ids.clone(),
            source_sig: source_sig.clone(),
            processed_books,
            shards: shards.clone(),
        })?;
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
    let build_budget = index_ram_budget().min(crate::memory_budget::governor().hard_limit_bytes());
    let mut build_permit: Option<crate::memory_budget::MemoryPermit> = None;
    for (idx, id) in ids.iter().enumerate().skip(processed_books) {
        task_control(task)?;
        let Some((book_dim, book_chunks)) = vector::stored_shape(*id) else {
            continue;
        };
        let shard_limit = global_build_shard_chunk_limit(book_dim);
        let previous_permit_bytes = build_permit
            .as_ref()
            .map(crate::memory_budget::MemoryPermit::bytes)
            .unwrap_or(0);
        let admission = plan_shard_admission(
            mapping.len(),
            book_chunks,
            book_dim,
            build_budget,
            shard_limit,
        );
        if let ShardAdmission::RejectBook { .. } = admission {
            // 这本书本身就大于图构建预算。先提交前一片，再按连续段落范围
            // 流式读取它的 `.vec`；同一本书可以覆盖多个分片，但查询端仍按书 id
            // 聚合命中，因此不会损失召回。
            if !mapping.is_empty() {
                task_control(task)?;
                let n = mapping.len();
                let (graph_bytes, graph_sha256, map_bytes, map_sha256) = write_shard(
                    k,
                    std::mem::take(&mut points),
                    std::mem::take(&mut values),
                    &mapping,
                )?;
                shards.push(ShardMeta {
                    books: std::mem::take(&mut shard_books),
                    chunks: n,
                    graph_bytes,
                    graph_sha256,
                    map_bytes,
                    map_sha256,
                });
                mapping.clear();
                k += 1;
                processed_books = idx;
                write_global_build_meta(&GlobalBuildMeta {
                    v: GLOBAL_CACHE_VERSION,
                    model: model::active_id().to_string(),
                    model_revision: model::active().revision().to_string(),
                    chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
                    dim,
                    book_ids: ids.clone(),
                    source_sig: source_sig.clone(),
                    processed_books,
                    shards: shards.clone(),
                })?;
                if let Some(task) = task {
                    task.checkpoint(
                        processed_books as u64,
                        ids.len() as u64,
                        format!("加速索引已完成第 {k} 片"),
                        format!(r#"{{"shard":{k},"processed_books":{processed_books}}}"#),
                    )?;
                }
                drop(build_permit.take());
            }

            let mut start = 0usize;
            while start < book_chunks {
                task_control(task)?;
                let take = (book_chunks - start).min(shard_limit);
                let range_bytes = build_working_set(take, book_dim);
                let _range_permit = acquire_build_permit(range_bytes).map_err(|error| {
                    format!(
                        "超大图书 {id} 的第 {} 段无法取得构图内存：{error}",
                        start + 1
                    )
                })?;
                if let Ok(mut p) = state.sem_progress.lock() {
                    p.current = format!(
                        "建立加速索引（超大书分片 {}/{}：第 {}-{} 段，图书 {}/{}）…",
                        k + 1,
                        shard_total.max(k as u32 + 1),
                        start + 1,
                        start + take,
                        idx + 1,
                        ids.len()
                    );
                }
                let (stream_dim, read) =
                    vector::visit_entries_range(*id, start, take, |chapter, text, vector| {
                        values.push(mapping.len() as u32);
                        points.push(SemPoint(vector.to_vec()));
                        mapping.push(GlobalEntry {
                            b: *id,
                            c: chapter,
                            t: text.to_string(),
                        });
                    })
                    .ok_or_else(|| format!("无法流式读取超大图书 {id} 的语义向量"))?;
                if read == 0 || mapping.is_empty() {
                    return Err(format!("超大图书 {id} 没有可用于加速索引的段落"));
                }
                dim = stream_dim;
                let n = mapping.len();
                let (graph_bytes, graph_sha256, map_bytes, map_sha256) = write_shard(
                    k,
                    std::mem::take(&mut points),
                    std::mem::take(&mut values),
                    &mapping,
                )?;
                shards.push(ShardMeta {
                    books: vec![*id],
                    chunks: n,
                    graph_bytes,
                    graph_sha256,
                    map_bytes,
                    map_sha256,
                });
                mapping.clear();
                k += 1;
                // 仅在整本书的所有范围均已写入后推进 processed_books；中断后
                // 最多重建当前超大书，不会把半本书伪装成已完成。
                let complete_book = start.saturating_add(read) >= book_chunks;
                let checkpoint_books = if complete_book { idx + 1 } else { idx };
                if complete_book {
                    // 仅在整本书完成后写检查点。中途暂停时，下次会删掉未登记的
                    // 半本分片并从本书开头重建，绝不会把重复分片混进全局图。
                    write_global_build_meta(&GlobalBuildMeta {
                        v: GLOBAL_CACHE_VERSION,
                        model: model::active_id().to_string(),
                        model_revision: model::active().revision().to_string(),
                        chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
                        dim,
                        book_ids: ids.clone(),
                        source_sig: source_sig.clone(),
                        processed_books: checkpoint_books,
                        shards: shards.clone(),
                    })?;
                    if let Some(task) = task {
                        task.checkpoint(
                            checkpoint_books as u64,
                            ids.len() as u64,
                            format!("超大书加速索引已完成第 {k} 片"),
                            format!(r#"{{"shard":{k},"processed_books":{checkpoint_books}}}"#),
                        )?;
                    }
                }
                if let Ok(mut p) = state.sem_progress.lock() {
                    p.shard_done = k as u32;
                    p.shard_total = shard_total.max(k as u32);
                    p.current = format!(
                        "建立加速索引（超大书已完成 {}/{} 段，已处理 {}/{} 本）…",
                        start + read,
                        book_chunks,
                        checkpoint_books,
                        ids.len()
                    );
                }
                start = start.saturating_add(read);
            }
            continue;
        }
        let book_bytes = build_working_set(book_chunks, book_dim);
        let target_bytes = match admission {
            ShardAdmission::RejectBook { .. } => unreachable!("超大书已走流式分片"),
            ShardAdmission::Add { target_bytes } => target_bytes,
            ShardAdmission::FlushThenAdd { target_bytes } => target_bytes,
        };
        let mut should_flush = matches!(admission, ShardAdmission::FlushThenAdd { .. });
        if !should_flush {
            if let Some(permit) = build_permit.as_mut() {
                let additional = target_bytes.saturating_sub(permit.bytes());
                if let Err(error) = permit.try_grow(additional) {
                    if mapping.is_empty() {
                        return Err(format!("单本图书 {id} 无法取得加速索引构图内存：{error}"));
                    }
                    crate::log(&format!(
                        "semantic_accelerator stage=admission action=flush book={id} reason=memory_budget target_bytes={target_bytes} error={error}"
                    ));
                    should_flush = true;
                }
            } else {
                build_permit =
                    Some(acquire_build_permit(target_bytes).map_err(|error| {
                        format!("单本图书 {id} 无法取得加速索引构图内存：{error}")
                    })?);
            }
        }
        // 当前片再加这本会超过静态分片上限、估算预算或实时全局硬上限，先落盘。
        if should_flush {
            task_control(task)?;
            let n = mapping.len();
            if let Ok(mut p) = state.sem_progress.lock() {
                p.current = format!(
                    "建立加速索引（正在建第 {}/{} 片，{} 段，已收集 {}/{} 本）…",
                    k + 1,
                    shard_total.max(k as u32 + 1),
                    n,
                    idx,
                    ids.len()
                );
            }
            let (graph_bytes, graph_sha256, map_bytes, map_sha256) = write_shard(
                k,
                std::mem::take(&mut points),
                std::mem::take(&mut values),
                &mapping,
            )?;
            shards.push(ShardMeta {
                books: std::mem::take(&mut shard_books),
                chunks: n,
                graph_bytes,
                graph_sha256,
                map_bytes,
                map_sha256,
            });
            mapping.clear();
            k += 1;
            processed_books = idx;
            write_global_build_meta(&GlobalBuildMeta {
                v: GLOBAL_CACHE_VERSION,
                model: model::active_id().to_string(),
                model_revision: model::active().revision().to_string(),
                chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
                dim,
                book_ids: ids.clone(),
                source_sig: source_sig.clone(),
                processed_books,
                shards: shards.clone(),
            })?;
            if let Some(task) = task {
                task.checkpoint(
                    processed_books as u64,
                    ids.len() as u64,
                    format!("加速索引已完成第 {k} 片"),
                    format!(r#"{{"shard":{k},"processed_books":{processed_books}}}"#),
                )?;
            }
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
            // 覆盖本片实际 points/HNSW/序列化生命周期的 permit 在片落盘后释放，
            // 再为下一本申请一张新片，避免两个分片工作集同时计费或驻留。
            drop(build_permit.take());
            build_permit = Some(
                acquire_build_permit(book_bytes)
                    .map_err(|error| format!("单本图书 {id} 无法取得加速索引构图内存：{error}"))?,
            );
        }
        let rollback_bytes = if should_flush {
            0
        } else {
            previous_permit_bytes
        };
        let Some(data) = vector::load(state, *id) else {
            if let Some(permit) = build_permit.as_mut() {
                permit.shrink_to(rollback_bytes);
            }
            if rollback_bytes == 0 {
                build_permit = None;
            }
            continue;
        };
        if data.is_empty() {
            if let Some(permit) = build_permit.as_mut() {
                permit.shrink_to(rollback_bytes);
            }
            if rollback_bytes == 0 {
                build_permit = None;
            }
            continue;
        }
        dim = data.dimensions();
        for (chapter, text, vector) in data.entries() {
            values.push(mapping.len() as u32);
            points.push(SemPoint(vector.to_vec()));
            mapping.push(GlobalEntry {
                b: *id,
                c: chapter,
                t: text.to_string(),
            });
        }
        shard_books.push(*id);
        // 收集向量也可能耗时很久，片内每本书都更新一次，让界面不再长期停在 0 本。
        if let Ok(mut p) = state.sem_progress.lock() {
            p.current = format!(
                "建立加速索引（收集第 {}/{} 片：{}/{} 本，{} / {} 段）…",
                k + 1,
                shard_total.max(k as u32 + 1),
                idx + 1,
                ids.len(),
                mapping.len(),
                shard_limit
            );
        }
        // 建图阶段不长期占用逐书缓存，加完即释放
        vector::evict_cached(state, *id);
    }
    if !mapping.is_empty() {
        task_control(task)?;
        let n = mapping.len();
        if let Ok(mut p) = state.sem_progress.lock() {
            p.current = format!(
                "建立加速索引（正在建第 {}/{} 片，{} 段，已收集 {}/{} 本）…",
                k + 1,
                shard_total.max(k as u32 + 1),
                n,
                ids.len(),
                ids.len()
            );
        }
        let (graph_bytes, graph_sha256, map_bytes, map_sha256) = write_shard(
            k,
            std::mem::take(&mut points),
            std::mem::take(&mut values),
            &mapping,
        )?;
        drop(build_permit.take());
        shards.push(ShardMeta {
            books: std::mem::take(&mut shard_books),
            chunks: n,
            graph_bytes,
            graph_sha256,
            map_bytes,
            map_sha256,
        });
        k += 1;
        processed_books = ids.len();
        write_global_build_meta(&GlobalBuildMeta {
            v: GLOBAL_CACHE_VERSION,
            model: model::active_id().to_string(),
            model_revision: model::active().revision().to_string(),
            chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
            dim,
            book_ids: ids.clone(),
            source_sig: source_sig.clone(),
            processed_books,
            shards: shards.clone(),
        })?;
        if let Some(task) = task {
            task.checkpoint(
                processed_books as u64,
                ids.len() as u64,
                format!("加速索引已完成第 {k} 片"),
                format!(r#"{{"shard":{k},"processed_books":{processed_books}}}"#),
            )?;
        }
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
        model: model::active_id().to_string(),
        model_revision: model::active().revision().to_string(),
        chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
        dim,
        book_ids: ids,
        source_sig,
        shards,
    };
    let meta_path = global_meta_path().ok_or("无缓存路径")?;
    let meta_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&meta_path, &meta_bytes)?;
    remove_global_build_meta();
    *state.global_index.lock().unwrap() = None; // 让下次查询重新载入
    PREPARED.store(false, Ordering::Release);
    clear_snapshot_cache();
    Ok(())
}

fn decode_global_hnsw<R: std::io::Read>(version: u32, reader: R) -> Result<GlobalHnsw, String> {
    if version == LEGACY_GLOBAL_CACHE_VERSION {
        bincode::deserialize_from(reader).map_err(|error| error.to_string())
    } else if matches!(
        version,
        OLDER_GLOBAL_CACHE_VERSION
            | HISTORIC_GLOBAL_CACHE_VERSION
            | PREVIOUS_GLOBAL_CACHE_VERSION
            | GLOBAL_CACHE_VERSION
    ) {
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
    } else if matches!(
        version,
        OLDER_GLOBAL_CACHE_VERSION
            | HISTORIC_GLOBAL_CACHE_VERSION
            | PREVIOUS_GLOBAL_CACHE_VERSION
            | GLOBAL_CACHE_VERSION
    ) {
        rmp_serde::decode::from_read(reader).map_err(|error| error.to_string())
    } else {
        Err(format!("不支持的 HNSW 映射版本：{version}"))
    }
}

struct IntegrityReader<R> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
}

impl<R> IntegrityReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        let hash = self
            .hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        (self.bytes, hash)
    }
}

impl<R: Read> Read for IntegrityReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        if read > 0 {
            self.hasher.update(&buffer[..read]);
            self.bytes = self.bytes.saturating_add(read as u64);
        }
        Ok(read)
    }
}

fn decode_global_file<T>(
    version: u32,
    path: &std::path::Path,
    expected_bytes: u64,
    expected_sha256: &str,
    decode: impl FnOnce(&mut IntegrityReader<std::io::BufReader<std::fs::File>>) -> Result<T, String>,
) -> Result<T, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = IntegrityReader::new(std::io::BufReader::new(file));
    let value = decode(&mut reader)?;
    // 解码器通常正好读到对象末尾；继续读至 EOF，确保追加垃圾和整个文件哈希也被校验。
    std::io::copy(&mut reader, &mut std::io::sink()).map_err(|error| error.to_string())?;
    let (actual_bytes, actual_sha256) = reader.finish();
    if version == GLOBAL_CACHE_VERSION
        && (actual_bytes != expected_bytes || actual_sha256 != expected_sha256)
    {
        return Err(format!(
            "完整性校验失败：期望 {expected_bytes} 字节/{expected_sha256}，实际 {actual_bytes} 字节/{actual_sha256}"
        ));
    }
    Ok(value)
}

/// HNSW 是最大的可选驻留对象。系统进入内存压力时先释放所有可重建的轻量缓存；
/// 若释放后仍紧张，调用方会跳过 HNSW，查询继续走画像和逐书向量路径。
fn trim_evictable_caches_for_graph_load(state: &AppState) {
    if !crate::memory_budget::memory_pressure_high() {
        return;
    }
    if let Ok(mut cache) = state.search_text_cache.lock() {
        cache.clear();
    }
    crate::search::clear_filter_memory_cache();
    vector::clear_memory_cache(state);
    super::clear_sem_query_cache();
    profile::clear_caches();
    crate::log("memory_pressure evicted=text,filter,semantic_vector,semantic_aux");
}

/// 载入（并缓存）分片近邻索引。按内存预算尽量多载入分片；与当前已索引书集合不一致则视为过期。
/// 返回 None 表示无索引/过期/损坏（应整体退回暴力）。
pub(super) fn load_global_index(state: &AppState) -> Option<Arc<LoadedShards>> {
    let _load_guard = global_load_lock().lock().ok()?;
    let (current_ids, current_sig) = indexed_book_snapshot_cached(state);
    {
        let mut g = state.global_index.lock().unwrap();
        if let Some(a) = g.as_ref() {
            if a.book_ids == current_ids && a.source_sig == current_sig {
                if crate::memory_budget::memory_pressure_high() {
                    *g = None;
                } else {
                    return Some(a.clone());
                }
            }
        }
    }
    let meta: GlobalMeta =
        serde_json::from_str(&std::fs::read_to_string(global_meta_path()?).ok()?).ok()?;
    if meta.v != GLOBAL_CACHE_VERSION
        || meta.model != model::active_id()
        || meta.model_revision != model::active().revision()
        || meta.chunk_revision != crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION
    {
        return None;
    }
    if meta.book_ids != current_ids || meta.source_sig != current_sig {
        return None; // 索引集合变了 → 过期，退回暴力
    }
    trim_evictable_caches_for_graph_load(state);
    if crate::memory_budget::memory_pressure_high() {
        crate::log("semantic_index_load skipped reason=memory_pressure");
        return None;
    }
    let load_started = Instant::now();
    let budget = index_ram_budget();
    let mut memory_permit = crate::memory_budget::governor()
        .try_acquire(
            crate::memory_budget::MemoryClass::SemanticGraph,
            crate::memory_budget::MemoryUsageKind::Resident,
            0,
        )
        .ok()?;
    let mut graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)> = Vec::new();
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut used: u64 = 0;
    for (k, sh) in meta.shards.iter().enumerate() {
        if !global_shard_shape_valid(meta.v, k, sh) {
            invalidate_global_index_from(&meta, k, "file_shape");
            *state.global_index.lock().unwrap() = None;
            return None;
        }
        let hnsw_path = global_shard_hnsw_path(k)?;
        let map_path = global_shard_map_path(k)?;
        let disk_bytes = std::fs::metadata(&hnsw_path)
            .map(|m| m.len())
            .unwrap_or(0)
            .saturating_add(std::fs::metadata(&map_path).map(|m| m.len()).unwrap_or(0));
        let est = shard_est_bytes(sh.chunks, meta.dim).max(disk_bytes);
        // 预算不足时绝不强载第一片；退回画像/逐书检索比把进程推入换页更可靠。
        if used.saturating_add(est) > budget {
            break;
        }
        if let Err(error) = memory_permit.try_grow(est) {
            crate::log(&format!(
                "semantic_index_load stopped shard={k} reason=memory_budget bytes={est} error={error}"
            ));
            break;
        }
        let shard_started = Instant::now();
        let map = match decode_global_file(
            meta.v,
            &hnsw_path,
            sh.graph_bytes,
            &sh.graph_sha256,
            |reader| decode_global_hnsw(meta.v, reader),
        ) {
            Ok(map) => map,
            Err(error) => {
                crate::log(&format!(
                    "semantic_index_load failed shard={k} format_v={} stage=hnsw error={error}",
                    meta.v
                ));
                invalidate_global_index_from(&meta, k, "hnsw_decode_or_hash");
                *state.global_index.lock().unwrap() = None;
                return None;
            }
        };
        let mapping =
            match decode_global_file(meta.v, &map_path, sh.map_bytes, &sh.map_sha256, |reader| {
                decode_global_mapping(meta.v, reader)
            }) {
                Ok(mapping) => mapping,
                Err(error) => {
                    crate::log(&format!(
                        "semantic_index_load failed shard={k} format_v={} stage=map error={error}",
                        meta.v
                    ));
                    invalidate_global_index_from(&meta, k, "map_decode_or_hash");
                    *state.global_index.lock().unwrap() = None;
                    return None;
                }
            };
        if mapping.len() != sh.chunks {
            crate::log(&format!(
                "semantic_index_load failed shard={k} stage=shape expected_chunks={} actual_chunks={}",
                sh.chunks,
                mapping.len()
            ));
            invalidate_global_index_from(&meta, k, "mapping_chunk_count");
            *state.global_index.lock().unwrap() = None;
            return None;
        }
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
        _memory_permit: memory_permit,
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
pub(super) fn loaded_global_index_if_ready(state: &AppState) -> Option<Arc<LoadedShards>> {
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
    for item in graph.search(&qp, &mut search).take(HNSW_HITS_PER_SHARD) {
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
    let nthreads = crate::interactive_search_workers(graphs.len());
    let chunk_size = graphs.len().div_ceil(nthreads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = graphs
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    crate::with_thread_background_priority(|| {
                        chunk
                            .iter()
                            .flat_map(|(graph, mapping)| {
                                search_one_graph(graph, mapping, q, titles)
                            })
                            .collect::<Vec<_>>()
                    })
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
pub(super) fn search_loaded_shards(
    li: &LoadedShards,
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    search_graphs(&li.graphs, q, titles)
}

pub(super) fn probe() {
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

    fn source_signature(
        book_id: u64,
        mtime: u64,
        content_id: &str,
        vector_sha256: &str,
        model_revision: &str,
    ) -> vector::IndexSourceSignature {
        vector::IndexSourceSignature {
            book_id,
            mtime,
            content_id: content_id.into(),
            source_bytes: 1_024,
            vector_bytes: 32,
            vector_sha256: vector_sha256.into(),
            dim: 4,
            chunks: 2,
            model_id: model::active_id().into(),
            model_revision: model_revision.into(),
            chunk_revision: crate::semantic_core::SEM_CHUNK_PIPELINE_REVISION,
        }
    }

    fn signature(book_id: u64) -> vector::IndexSourceSignature {
        source_signature(
            book_id,
            1,
            &format!("content-{book_id}"),
            &"A".repeat(64),
            model::active().revision(),
        )
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
                PREVIOUS_GLOBAL_CACHE_VERSION,
                current_map.as_slice(),
                current_mapping.as_slice(),
            ),
            (
                HISTORIC_GLOBAL_CACHE_VERSION,
                current_map.as_slice(),
                current_mapping.as_slice(),
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

    #[test]
    fn global_checkpoint_keeps_the_unchanged_prefix_after_a_book_is_added() {
        let old_ids = vec![10, 20, 30, 40];
        let old_sig = old_ids.iter().copied().map(signature).collect::<Vec<_>>();
        // 新书位于已完成分片之后，前 3 本对应的分片应可无损复用。
        let ids = vec![10, 20, 30, 35, 40];
        let source_sig = ids.iter().copied().map(signature).collect::<Vec<_>>();
        assert_eq!(
            global_build_common_prefix(&old_ids, &old_sig, &ids, &source_sig),
            3
        );
    }

    #[test]
    fn global_checkpoint_stops_before_a_changed_book() {
        let ids = vec![10, 20, 30];
        let old_sig = ids.iter().copied().map(signature).collect::<Vec<_>>();
        let mut changed_sig = old_sig.clone();
        changed_sig[1].mtime = 2;
        assert_eq!(
            global_build_common_prefix(&ids, &old_sig, &ids, &changed_sig),
            1
        );
    }

    #[test]
    fn strong_source_signature_invalidates_same_mtime_content_vector_and_model_changes() {
        let ids = vec![10, 20];
        let baseline = ids.iter().copied().map(signature).collect::<Vec<_>>();

        let mut changed_content = baseline.clone();
        changed_content[0].content_id = "different-content".into();
        assert_eq!(
            global_build_common_prefix(&ids, &baseline, &ids, &changed_content),
            0
        );

        let mut changed_vector = baseline.clone();
        changed_vector[0].vector_sha256 = "B".repeat(64);
        assert_eq!(
            global_build_common_prefix(&ids, &baseline, &ids, &changed_vector),
            0
        );

        let mut changed_model = baseline.clone();
        changed_model[0].model_revision = "new-export-revision".into();
        assert_eq!(
            global_build_common_prefix(&ids, &baseline, &ids, &changed_model),
            0
        );
        assert!(baseline.iter().all(|signature| signature.mtime == 1));
    }

    #[test]
    fn current_global_file_rejects_same_length_bit_flip() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-global-integrity-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("global.map");
        let entries = vec![GlobalEntry {
            b: 7,
            c: 3,
            t: "测试片段".into(),
        }];
        let mut bytes = rmp_serde::to_vec(&entries).unwrap();
        let expected_hash = super::super::sha256_hex(&bytes);
        std::fs::write(&path, &bytes).unwrap();
        assert!(file_integrity_valid(
            &path,
            bytes.len() as u64,
            &expected_hash
        ));
        let decoded = decode_global_file(
            GLOBAL_CACHE_VERSION,
            &path,
            bytes.len() as u64,
            &expected_hash,
            |reader| decode_global_mapping(GLOBAL_CACHE_VERSION, reader),
        )
        .unwrap();
        assert_eq!(decoded.len(), 1);

        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(!file_integrity_valid(
            &path,
            bytes.len() as u64,
            &expected_hash
        ));
        assert!(decode_global_file(
            GLOBAL_CACHE_VERSION,
            &path,
            bytes.len() as u64,
            &expected_hash,
            |reader| decode_global_mapping(GLOBAL_CACHE_VERSION, reader),
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_weak_source_signature_decodes_but_cannot_be_current() {
        let json = format!(
            r#"{{"v":{},"model":"{}","dim":4,"book_ids":[7],"source_sig":[[7,11]],"shards":[]}}"#,
            PREVIOUS_GLOBAL_CACHE_VERSION,
            model::active_id()
        );
        let decoded: GlobalMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.v, PREVIOUS_GLOBAL_CACHE_VERSION);
        assert!(decoded.source_sig.is_empty());
        assert_ne!(decoded.v, GLOBAL_CACHE_VERSION);
        assert!(decoded.model_revision.is_empty());
        assert_eq!(decoded.chunk_revision, 0);
    }

    #[test]
    fn high_dimension_shard_limit_respects_small_memory_budgets() {
        let low_memory = global_build_shard_chunk_limit_for_budget(1792, 64 * 1024 * 1024);
        let comfortable = global_build_shard_chunk_limit_for_budget(1792, 4 * 1024 * 1024 * 1024);
        assert_eq!(low_memory, BUILD_MIN_CHUNKS);
        assert!(low_memory < 32_000);
        assert!(comfortable > low_memory);
        assert!(comfortable <= SHARD_MAX_CHUNKS);
    }

    #[test]
    fn admission_flushes_before_exceeding_the_working_set_budget() {
        let budget = build_working_set(100, 8);
        assert_eq!(
            plan_shard_admission(80, 30, 8, budget, SHARD_MAX_CHUNKS),
            ShardAdmission::FlushThenAdd {
                target_bytes: build_working_set(30, 8)
            }
        );
    }

    #[test]
    fn admission_rejects_a_single_book_larger_than_the_budget() {
        let required = build_working_set(101, 8);
        assert_eq!(
            plan_shard_admission(0, 101, 8, build_working_set(100, 8), SHARD_MAX_CHUNKS),
            ShardAdmission::RejectBook {
                required_bytes: required
            }
        );
    }

    #[test]
    fn accelerator_implementation_stays_out_of_the_parent_module() {
        let parent = include_str!("../semantic.rs");
        let build = include_str!("build.rs");
        let accelerator = include_str!("accelerator.rs");
        for forbidden in [
            "struct SemPoint",
            "struct GlobalEntry",
            "struct ShardMeta",
            "struct GlobalMeta",
            "struct GlobalBuildMeta",
            "pub(crate) struct LoadedShards",
            "fn build_global_index",
            "fn load_global_index",
            "fn search_loaded_shards",
        ] {
            assert!(
                !parent.contains(forbidden),
                "accelerator boundary regressed: {forbidden}"
            );
        }
        assert!(parent.contains("pub(crate) use accelerator::LoadedShards"));
        assert!(build.contains("accelerator::build_global_index"));
        assert!(parent.contains("struct IntegrityWriter"));
        assert!(parent.contains("fn write_rmp_hashed"));
        assert!(accelerator.contains("MemoryClass::SemanticGraph"));
        assert!(accelerator.contains("MemoryUsageKind::Transient"));
    }
}
