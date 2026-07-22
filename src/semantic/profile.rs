//! 书籍语义画像。
//!
//! 单中心画像用于相似图书与无全局图时的快速候选筛选；多中心画像保留一本
//! 书中的多个局部主题。这里拥有画像的文件格式、缓存、逐书检查点和构建流程，
//! 只通过 `(维度, 段落数, 向量切片)` 读取上层向量数据。

use super::{model, vector};
use crate::semantic_core::{dot, normalize, SEM_CHUNK_PIPELINE_REVISION, SEM_VERSION};
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::{book, search, set_thread_background, AppState, RES_BASE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;

const PROFILE_CANDIDATE_MIN: usize = 12;
const BRUTE_FORCE_READ_BUDGET: u64 = 192 * 1024 * 1024;
const MULTI_PROFILE_VERSION: u32 = 3;
const MULTI_PROFILE_PART_VERSION: u32 = 2;
const PREVIOUS_MULTI_PROFILE_VERSION: u32 = 2;
const LEGACY_MULTI_PROFILE_VERSION: u32 = 1;
const MULTI_PROFILE_MIN_CENTERS: usize = 4;
const MULTI_PROFILE_MAX_CENTERS: usize = 16;
const MULTI_PROFILE_CHUNKS_PER_CENTER: usize = 256;
const MULTI_PROFILE_PAUSED: &str = "__semantic_multi_profile_paused__";
const MULTI_PROFILE_CANCELLED: &str = "__semantic_multi_profile_cancelled__";

#[derive(Serialize, Deserialize)]
struct SingleProfileMeta {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
    chunks: usize,
    #[serde(default)]
    vector_bytes: u64,
    #[serde(default)]
    vector_sha256: String,
    #[serde(default)]
    model_revision: String,
    #[serde(default)]
    chunk_revision: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct MultiProfileBook {
    mtime: u64,
    dim: usize,
    #[serde(default)]
    vector_bytes: u64,
    centers: Vec<f32>,
}

#[derive(Serialize, Deserialize)]
struct MultiProfileIndex {
    v: u32,
    model: String,
    model_revision: String,
    chunk_revision: u32,
    source_sig: Vec<vector::IndexSourceSignature>,
    books: HashMap<u64, MultiProfileBook>,
}

#[derive(Serialize, Deserialize)]
struct MultiProfilePart {
    v: u32,
    model: String,
    model_revision: String,
    chunk_revision: u32,
    book_id: u64,
    source_sig: vector::IndexSourceSignature,
    book: MultiProfileBook,
}

/// 只用于解码旧文件；弱 `(id, mtime)` 签名不会被迁移为强签名。
#[derive(Serialize, Deserialize)]
struct LegacyMultiProfileIndex {
    v: u32,
    model: String,
    #[serde(default)]
    source_sig: Vec<(u64, u64)>,
    books: HashMap<u64, MultiProfileBook>,
}

type SingleProfileCache = Mutex<HashMap<u64, (u64, Vec<f32>, usize)>>;
static SINGLE_PROFILE_CACHE: OnceLock<SingleProfileCache> = OnceLock::new();
static MULTI_PROFILE_CACHE: OnceLock<Mutex<Option<Arc<MultiProfileIndex>>>> = OnceLock::new();
type IndexedBookSnapshot = (Vec<u64>, Vec<vector::IndexSourceSignature>);

fn single_cache() -> &'static SingleProfileCache {
    SINGLE_PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn multi_cache() -> &'static Mutex<Option<Arc<MultiProfileIndex>>> {
    MULTI_PROFILE_CACHE.get_or_init(|| Mutex::new(None))
}

fn single_meta_path(id: u64) -> Option<std::path::PathBuf> {
    Some(super::sem_dir()?.join(format!("sem_{id}.profile.json")))
}

fn single_vector_path(id: u64) -> Option<std::path::PathBuf> {
    Some(super::sem_dir()?.join(format!("sem_{id}.profile.vec")))
}

fn multi_path() -> Option<std::path::PathBuf> {
    Some(super::sem_dir()?.join("multi_profiles.bin"))
}

fn multi_part_path(id: u64) -> Option<std::path::PathBuf> {
    Some(super::sem_dir()?.join(format!(".multi_profile_{id}.part")))
}

pub(super) fn clear_single_cache() {
    if let Ok(mut cache) = single_cache().lock() {
        cache.clear();
    }
}

pub(super) fn clear_multi_cache() {
    if let Ok(mut cache) = multi_cache().lock() {
        *cache = None;
    }
}

pub(super) fn clear_caches() {
    clear_single_cache();
    clear_multi_cache();
}

pub(super) fn discard_single(id: u64) {
    if let Some(path) = single_vector_path(id) {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = single_meta_path(id) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(mut cache) = single_cache().lock() {
        cache.remove(&id);
    }
}

fn clear_multi_parts() {
    let Some(dir) = super::sem_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".multi_profile_") && name.ends_with(".part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(super) fn delete_multi_files() -> Result<(), String> {
    if let Some(path) = multi_path() {
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| format!("删除多中心画像失败：{error}"))?;
        }
    }
    clear_multi_parts();
    clear_multi_cache();
    Ok(())
}

pub(super) fn delete_all_files() {
    let Some(dir) = super::sem_dir() else {
        clear_caches();
        return;
    };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(".profile.")
                || name == "multi_profiles.bin"
                || (name.starts_with(".multi_profile_") && name.ends_with(".part"))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    clear_caches();
}

pub(super) fn single_center(dim: usize, chunks: usize, vectors: &[f32]) -> Option<Vec<f32>> {
    let expected = dim.checked_mul(chunks)?;
    if dim == 0 || chunks == 0 || vectors.len() < expected {
        return None;
    }
    let mut profile = vec![0.0f32; dim];
    for chunk in 0..chunks {
        let base = chunk * dim;
        for (column, value) in profile.iter_mut().enumerate() {
            *value += vectors[base + column];
        }
    }
    let inverse = 1.0f32 / chunks as f32;
    for value in &mut profile {
        *value *= inverse;
    }
    normalize(&mut profile);
    Some(profile)
}

pub(super) fn write_single(
    id: u64,
    mtime: u64,
    dim: usize,
    chunks: usize,
    profile: &[f32],
) -> Result<(), String> {
    let vector_path = single_vector_path(id).ok_or("无缓存路径")?;
    if let Some(dir) = vector_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut bytes = Vec::with_capacity(profile.len() * 4);
    for value in profile {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let meta = SingleProfileMeta {
        v: SEM_VERSION,
        model: model::active_id().to_string(),
        mtime,
        dim,
        chunks,
        vector_bytes: bytes.len() as u64,
        vector_sha256: super::sha256_hex(&bytes),
        model_revision: model::active().revision().into(),
        chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
    };
    // 元信息最后提交：崩溃留下的新向量和旧元信息时，哈希校验会拒绝读取。
    crate::atomic_file::write(&vector_path, &bytes)?;
    crate::atomic_file::write_json(&single_meta_path(id).ok_or("无缓存路径")?, &meta, false)?;
    if let Ok(mut cache) = single_cache().lock() {
        cache.insert(id, (mtime, profile.to_vec(), chunks));
    }
    Ok(())
}

pub(super) fn read_single(id: u64, mtime: u64) -> Option<(Vec<f32>, usize)> {
    if let Ok(cache) = single_cache().lock() {
        if let Some((cached_mtime, profile, chunks)) = cache.get(&id) {
            if *cached_mtime == mtime {
                return Some((profile.clone(), *chunks));
            }
        }
    }
    let meta: SingleProfileMeta =
        serde_json::from_str(&std::fs::read_to_string(single_meta_path(id)?).ok()?).ok()?;
    if meta.v != SEM_VERSION
        || meta.model != model::active_id()
        || meta.mtime != mtime
        || meta.dim == 0
        || (!meta.model_revision.is_empty() && meta.model_revision != model::active().revision())
        || (meta.chunk_revision != 0 && meta.chunk_revision != SEM_CHUNK_PIPELINE_REVISION)
    {
        return None;
    }
    let bytes = std::fs::read(single_vector_path(id)?).ok()?;
    if bytes.len() != meta.dim.checked_mul(4)?
        || (meta.vector_bytes != 0 && meta.vector_bytes != bytes.len() as u64)
        || (!meta.vector_sha256.is_empty() && super::sha256_hex(&bytes) != meta.vector_sha256)
    {
        return None;
    }
    let profile: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect();
    if profile.len() != meta.dim {
        return None;
    }
    if let Ok(mut cache) = single_cache().lock() {
        cache.insert(id, (mtime, profile.clone(), meta.chunks));
    }
    Some((profile, meta.chunks))
}

pub(super) fn read_or_backfill(state: &AppState, book: &book::Book) -> Option<(Vec<f32>, usize)> {
    let mtime = search::file_mtime(&book.path);
    if let Some(profile) = read_single(book.id, mtime) {
        return Some(profile);
    }
    let data = super::get_sem_data(state, book.id)?;
    let (dim, chunks, vectors) = super::sem_data_vector_parts(&data);
    let profile = single_center(dim, chunks, vectors)?;
    let _ = write_single(book.id, mtime, dim, chunks, &profile);
    Some((profile, chunks))
}

fn read_multi_part(id: u64, source_sig: &vector::IndexSourceSignature) -> Option<MultiProfileBook> {
    let bytes = std::fs::read(multi_part_path(id)?).ok()?;
    let part: MultiProfilePart = rmp_serde::from_slice(&bytes).ok()?;
    if part.v != MULTI_PROFILE_PART_VERSION
        || part.model != model::active_id()
        || part.model_revision != model::active().revision()
        || part.chunk_revision != SEM_CHUNK_PIPELINE_REVISION
        || part.book_id != id
        || part.source_sig != *source_sig
        || part.book.mtime != source_sig.mtime
        || part.book.dim != source_sig.dim
        || part.book.vector_bytes != source_sig.vector_bytes
        || part.book.dim == 0
        || part.book.centers.len() < part.book.dim
    {
        return None;
    }
    Some(part.book)
}

fn write_multi_part(
    id: u64,
    source_sig: &vector::IndexSourceSignature,
    book: &MultiProfileBook,
) -> Result<(), String> {
    let part = MultiProfilePart {
        v: MULTI_PROFILE_PART_VERSION,
        model: model::active_id().into(),
        model_revision: model::active().revision().into(),
        chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
        book_id: id,
        source_sig: source_sig.clone(),
        book: book.clone(),
    };
    let bytes =
        rmp_serde::to_vec(&part).map_err(|error| format!("序列化多中心画像检查点失败：{error}"))?;
    crate::atomic_file::write(&multi_part_path(id).ok_or("无缓存路径")?, &bytes)
}

fn decode_multi_index(bytes: &[u8]) -> Option<(MultiProfileIndex, bool)> {
    if let Ok(index) = rmp_serde::from_slice::<MultiProfileIndex>(bytes) {
        if index.v == MULTI_PROFILE_VERSION {
            return Some((index, false));
        }
    }
    let legacy = rmp_serde::from_slice::<LegacyMultiProfileIndex>(bytes)
        .ok()
        .filter(|index| index.v == PREVIOUS_MULTI_PROFILE_VERSION)
        .or_else(|| {
            bincode::deserialize::<LegacyMultiProfileIndex>(bytes)
                .ok()
                .filter(|index| index.v == LEGACY_MULTI_PROFILE_VERSION)
        })?;
    Some((
        MultiProfileIndex {
            v: legacy.v,
            model: legacy.model,
            model_revision: String::new(),
            chunk_revision: 0,
            // 弱签名仅表示“这个旧文件可读”；绝不推导或伪造强签名。
            source_sig: Vec::new(),
            books: legacy.books,
        },
        true,
    ))
}

fn load_multi_index() -> Option<Arc<MultiProfileIndex>> {
    if let Ok(cache) = multi_cache().lock() {
        if let Some(index) = cache.as_ref() {
            return Some(index.clone());
        }
    }
    let bytes = std::fs::read(multi_path()?).ok()?;
    let (index, legacy) = decode_multi_index(&bytes)?;
    if legacy
        || index.v != MULTI_PROFILE_VERSION
        || index.model != model::active_id()
        || index.model_revision != model::active().revision()
        || index.chunk_revision != SEM_CHUNK_PIPELINE_REVISION
        || index.source_sig.is_empty()
    {
        return None;
    }
    let index = Arc::new(index);
    if let Ok(mut cache) = multi_cache().lock() {
        *cache = Some(index.clone());
    }
    Some(index)
}

/// 合并画像只能与当前 Library + 已完整校验的逐书向量快照比较，不能用自己
/// 保存的签名反向证明当前性。
pub(super) fn merged_snapshot(state: &AppState) -> Option<IndexedBookSnapshot> {
    let index = load_multi_index()?;
    let source_sig = vector::index_source_snapshot(state);
    if source_sig.is_empty()
        || source_sig != index.source_sig
        || source_sig.len() != index.books.len()
        || source_sig.iter().any(|signature| {
            index
                .books
                .get(&signature.book_id)
                .map(|profile| {
                    profile.mtime != signature.mtime
                        || profile.dim != signature.dim
                        || profile.vector_bytes != signature.vector_bytes
                })
                .unwrap_or(true)
        })
    {
        return None;
    }
    let book_ids = source_sig
        .iter()
        .map(|signature| signature.book_id)
        .collect();
    Some((book_ids, source_sig))
}

/// 启动后低成本预载合并画像。13 MB 左右的单文件换来首查不再打开上千个小文件。
pub(super) fn spawn_warmup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        std::thread::sleep(std::time::Duration::from_secs(6));
        let started = Instant::now();
        let state = app.state::<AppState>();
        let merged = load_multi_index();
        let snapshot = merged_snapshot(state.inner());
        crate::log(&format!(
            "semantic_profile_bundle warm books={} snapshot={} elapsed_ms={}",
            merged.as_ref().map(|index| index.books.len()).unwrap_or(0),
            snapshot.as_ref().map(|(ids, _)| ids.len()).unwrap_or(0),
            started.elapsed().as_millis()
        ));
        set_thread_background(false);

        // 启动阶段预热模型会与书架和任务中心争用资源，导致窗口“未响应”。
        // 常规使用改为在首次真实语义查询时后台惰性加载；仅保留环境变量供
        // 性能测试/诊断显式开启。
        if std::env::var_os("KUNPENG_SEMANTIC_WARM_MODEL_ON_START").is_some() {
            let _ = super::search::warm_model(app.clone());
        }

        // 仅供本地兼容性验证；正常用户仍在首次语义查询时后台载入大图。
        if std::env::var_os("KUNPENG_SEMANTIC_PREPARE_ON_START").is_some() {
            let _ = super::prepare_semantic_search(app);
        }
    });
}

fn center_count(chunks: usize) -> usize {
    if chunks == 0 {
        return 0;
    }
    chunks
        .div_ceil(MULTI_PROFILE_CHUNKS_PER_CENTER)
        .clamp(MULTI_PROFILE_MIN_CENTERS, MULTI_PROFILE_MAX_CENTERS)
        .min(chunks)
}

/// 按书内顺序分段求多个主题中心。段落向量已归一化；每个中心求均值后再次归一化。
fn multi_centers(dim: usize, chunks: usize, vectors: &[f32]) -> Vec<f32> {
    let centers_count = center_count(chunks);
    if centers_count == 0 || dim == 0 || vectors.len() < chunks.saturating_mul(dim) {
        return Vec::new();
    }
    let mut centers = vec![0.0f32; centers_count * dim];
    let mut counts = vec![0usize; centers_count];
    for chunk in 0..chunks {
        let center = (chunk * centers_count / chunks).min(centers_count - 1);
        let source = &vectors[chunk * dim..(chunk + 1) * dim];
        let target = &mut centers[center * dim..(center + 1) * dim];
        for (destination, source) in target.iter_mut().zip(source) {
            *destination += *source;
        }
        counts[center] += 1;
    }
    for (center, count) in counts.into_iter().enumerate() {
        if count == 0 {
            continue;
        }
        let target = &mut centers[center * dim..(center + 1) * dim];
        let inverse = 1.0 / count as f32;
        for value in target.iter_mut() {
            *value *= inverse;
        }
        normalize(target);
    }
    centers
}

fn multi_score(query: &[f32], profile: &MultiProfileBook) -> Option<f32> {
    if profile.dim == 0 || profile.centers.len() < profile.dim {
        return None;
    }
    profile
        .centers
        .chunks_exact(profile.dim)
        .map(|center| dot(query, center))
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
}

fn task_control(task: Option<&crate::background_tasks::TaskRunGuard>) -> Result<(), String> {
    match task.map(|task| task.control_signal()) {
        Some(crate::background_tasks::TaskControlSignal::Pause) => Err(MULTI_PROFILE_PAUSED.into()),
        Some(crate::background_tasks::TaskControlSignal::Cancel) => {
            Err(MULTI_PROFILE_CANCELLED.into())
        }
        _ => Ok(()),
    }
}

fn build_multi_file(
    state: &AppState,
    task: Option<&crate::background_tasks::TaskRunGuard>,
) -> Result<(usize, usize), String> {
    task_control(task)?;
    let source_sig = vector::index_source_snapshot(state);
    if source_sig.is_empty() {
        return Err("请先建立语义索引".into());
    }
    let sources: HashMap<u64, vector::IndexSourceSignature> = source_sig
        .iter()
        .map(|signature| (signature.book_id, signature.clone()))
        .collect();
    let mut books: Vec<book::Book> = {
        let library = state.library.lock().unwrap();
        library
            .books
            .iter()
            .filter(|book| sources.contains_key(&book.id))
            .cloned()
            .collect()
    };
    books.sort_unstable_by_key(|book| book.id);
    {
        let mut progress = state.sem_progress.lock().unwrap();
        progress.total = books.len() as u32;
        progress.done = 0;
    }
    let mut entries = HashMap::with_capacity(books.len());
    let mut built_sig = Vec::with_capacity(books.len());
    for (index, book) in books.iter().enumerate() {
        task_control(task)?;
        {
            let mut progress = state.sem_progress.lock().unwrap();
            progress.done = index as u32;
            progress.current = format!("生成多中心画像：{}", book.title);
        }
        let source = sources
            .get(&book.id)
            .ok_or_else(|| format!("图书 {} 的向量来源签名已丢失", book.id))?;
        let profile = if let Some(profile) = read_multi_part(book.id, source) {
            profile
        } else {
            let Some(data) = super::get_sem_data(state, book.id) else {
                continue;
            };
            let (dim, chunks, vectors) = super::sem_data_vector_parts(&data);
            let centers = multi_centers(dim, chunks, vectors);
            if centers.is_empty() {
                continue;
            }
            let profile = MultiProfileBook {
                mtime: source.mtime,
                dim,
                vector_bytes: (vectors.len() as u64).saturating_mul(4),
                centers,
            };
            if profile.dim != source.dim || profile.vector_bytes != source.vector_bytes {
                return Err(format!(
                    "图书 {} 在生成多中心画像期间向量已变化，请重新续建",
                    book.id
                ));
            }
            write_multi_part(book.id, source, &profile)?;
            profile
        };
        entries.insert(book.id, profile);
        built_sig.push(source.clone());
        if let Some(task) = task {
            task.checkpoint(
                (index + 1) as u64,
                books.len() as u64,
                book.title.clone(),
                format!(r#"{{"book_id":{},"book_index":{index}}}"#, book.id),
            )?;
        }
    }
    built_sig.sort_unstable_by_key(|signature| signature.book_id);
    let index = MultiProfileIndex {
        v: MULTI_PROFILE_VERSION,
        model: model::active_id().to_string(),
        model_revision: model::active().revision().to_string(),
        chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
        source_sig: built_sig,
        books: entries,
    };
    let bytes =
        rmp_serde::to_vec(&index).map_err(|error| format!("序列化多中心画像失败：{error}"))?;
    task_control(task)?;
    crate::atomic_file::write(&multi_path().ok_or("无缓存路径")?, &bytes)?;
    let built = index.books.len();
    if let Ok(mut cache) = multi_cache().lock() {
        *cache = Some(Arc::new(index));
    }
    clear_multi_parts();
    Ok((built, books.len()))
}

pub(super) async fn build(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let task_handle = begin_semantic_task(
        state.inner(),
        "semantic_multi_profile",
        "准备生成多中心画像…",
        false,
    )?;
    let worker_app = app.clone();
    if let Err(error) = task_handle.spawn_detached("semantic-multi-profile", move |task| {
        let state = worker_app.state::<AppState>();
        let result = build_multi_file(state.inner(), Some(&task));
        if matches!(result.as_ref(), Err(error) if error == MULTI_PROFILE_PAUSED) {
            finish_semantic_task(state.inner(), "多中心画像已暂停，可续建", None);
            let _ = task.pause();
            return;
        }
        if matches!(result.as_ref(), Err(error) if error == MULTI_PROFILE_CANCELLED) {
            finish_semantic_task(state.inner(), "多中心画像已取消", None);
            let _ = task.cancel();
            return;
        }
        let cache_update = result
            .as_ref()
            .ok()
            .map(|(built, total)| (*built as u32, *total as u32));
        super::clear_sem_query_cache();
        let mut progress = state.sem_progress.lock().unwrap();
        progress.done = progress.total;
        progress.building = false;
        progress.active_task.clear();
        progress.background_task_id.clear();
        let task_error = result.as_ref().err().cloned();
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
            if !super::status::update_multi_profile(built, Some(total), built == total && total > 0)
            {
                super::clear_sem_status_cache();
            }
        } else {
            super::clear_sem_status_cache();
        }
        if let Some(error) = task_error {
            let _ = task.fail(error);
        } else {
            let _ = task.complete();
        }
    }) {
        finish_semantic_task(
            app.state::<AppState>().inner(),
            "多中心画像未启动",
            Some(error.clone()),
        );
        return Err(error);
    }
    Ok(())
}

pub(super) fn progress(state: &AppState) -> (u32, u32, bool) {
    let (_, current_sig) = super::indexed_book_snapshot_cached(state);
    let total = current_sig.len() as u32;
    let Some(index) = load_multi_index() else {
        return (0, total, false);
    };
    let done = current_sig
        .iter()
        .filter(|signature| {
            index
                .source_sig
                .binary_search_by_key(&signature.book_id, |source| source.book_id)
                .ok()
                .and_then(|position| index.source_sig.get(position))
                == Some(*signature)
                && index
                    .books
                    .get(&signature.book_id)
                    .map(|profile| {
                        profile.mtime == signature.mtime
                            && profile.dim == signature.dim
                            && profile.vector_bytes == signature.vector_bytes
                    })
                    .unwrap_or(false)
        })
        .count() as u32;
    let ready = total > 0 && done == total && index.source_sig == current_sig;
    (done, total, ready)
}

pub(super) fn disk_bytes() -> u64 {
    multi_path()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

pub(super) fn candidate_books(
    targets: &[book::Book],
    query: &[f32],
    limit: usize,
) -> (Vec<book::Book>, usize) {
    if targets.len() <= PROFILE_CANDIDATE_MIN {
        return (targets.to_vec(), 0);
    }
    let multi_profiles = load_multi_index();
    let mut multi_scored = 0usize;
    let mut scored: Vec<(f32, u64, book::Book)> = targets
        .iter()
        .filter_map(|book| {
            let current_multi_profile = multi_profiles.as_ref().and_then(|index| {
                // 只有合并多中心画像实际存在时才校验强向量签名。旧实现即使
                // multi_profiles=None 也会首次遍历并 SHA-256 读取全部向量文件，
                // 大型书架会因此多读数十 GB。
                let signature = vector::index_source_signature_fast(book)?;
                let position = index
                    .source_sig
                    .binary_search_by_key(&book.id, |source| source.book_id)
                    .ok()?;
                (index.source_sig.get(position) == Some(&signature))
                    .then(|| index.books.get(&book.id))
                    .flatten()
            });
            if let Some(profile) = current_multi_profile {
                multi_scored += 1;
                return Some((
                    multi_score(query, profile)?,
                    profile.vector_bytes,
                    book.clone(),
                ));
            }
            let mtime = search::file_mtime(&book.path);
            let (profile, _) = read_single(book.id, mtime)?;
            let bytes = super::sem_vec_path(book.id)
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Some((dot(query, &profile), bytes, book.clone()))
        })
        .collect();
    if scored.is_empty() {
        return (targets.iter().take(limit).cloned().collect(), multi_scored);
    }
    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut selected = Vec::with_capacity(limit.min(scored.len()));
    let mut selected_bytes = 0u64;
    for (_, bytes, book) in scored {
        if selected.len() >= limit {
            break;
        }
        if selected.len() >= PROFILE_CANDIDATE_MIN
            && selected_bytes.saturating_add(bytes) > BRUTE_FORCE_READ_BUDGET
        {
            continue;
        }
        selected_bytes = selected_bytes.saturating_add(bytes);
        selected.push(book);
    }
    (selected, multi_scored)
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

pub(super) async fn similar_books(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<SimilarBook>, String> {
    let source_id = id.parse::<u64>().map_err(|_| "无效图书 id".to_string())?;
    let source_book = {
        let library = state.library.lock().unwrap();
        library
            .books
            .iter()
            .find(|book| book.id == source_id)
            .cloned()
            .ok_or_else(|| "找不到这本书".to_string())?
    };
    let source_mtime = search::file_mtime(&source_book.path);
    let (source_profile, _) = read_single(source_book.id, source_mtime)
        .ok_or_else(|| "请先建立或刷新语义索引，以生成相似图书缓存".to_string())?;

    let books: Vec<book::Book> = {
        let library = state.library.lock().unwrap();
        library
            .books
            .iter()
            .filter(|book| book.id != source_id)
            .filter(|book| book.format != "pdf")
            .filter(|book| {
                super::sem_meta_path(book.id)
                    .map(|path| path.exists())
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    };

    let mut output = Vec::new();
    for book in books {
        let mtime = search::file_mtime(&book.path);
        let Some((profile, indexed_chunks)) = read_single(book.id, mtime) else {
            continue;
        };
        let score = dot(&source_profile, &profile).clamp(0.0, 1.0);
        if score <= 0.0 {
            continue;
        }
        let id = book.id;
        output.push(SimilarBook {
            id: id.to_string(),
            title: book.title.clone(),
            author: book.author.clone(),
            cover: book
                .cover
                .as_ref()
                .map(|_| format!("{RES_BASE}/cover/{id}?v={}", book.cover_ver)),
            progress: book.progress,
            score,
            indexed_chunks,
        });
    }
    output.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    output.truncate(5);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signature(book_id: u64, vector_sha256: &str) -> vector::IndexSourceSignature {
        vector::IndexSourceSignature {
            book_id,
            mtime: 11,
            content_id: format!("content-{book_id}"),
            source_bytes: 128,
            vector_bytes: 16,
            vector_sha256: vector_sha256.into(),
            dim: 2,
            chunks: 2,
            model_id: model::active_id().into(),
            model_revision: model::active().revision().into(),
            chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
        }
    }

    #[test]
    fn multi_profile_keeps_separate_local_topics() {
        let mut vectors = Vec::new();
        for index in 0..512 {
            if index < 256 {
                vectors.extend_from_slice(&[1.0, 0.0]);
            } else {
                vectors.extend_from_slice(&[0.0, 1.0]);
            }
        }
        let centers = multi_centers(2, 512, &vectors);
        assert_eq!(centers.len(), 8);
        let profile = MultiProfileBook {
            mtime: 1,
            dim: 2,
            vector_bytes: 4096,
            centers,
        };
        assert_eq!(multi_score(&[1.0, 0.0], &profile), Some(1.0));
        assert_eq!(multi_score(&[0.0, 1.0], &profile), Some(1.0));
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
            model: model::active_id().into(),
            model_revision: model::active().revision().into(),
            chunk_revision: SEM_CHUNK_PIPELINE_REVISION,
            source_sig: vec![signature(7, &"A".repeat(64))],
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
        let legacy = LegacyMultiProfileIndex {
            v: LEGACY_MULTI_PROFILE_VERSION,
            model: model::active_id().into(),
            source_sig: vec![(7, 11)],
            books,
        };
        let bytes = bincode::serialize(&legacy).unwrap();
        let (decoded, needs_migration) = decode_multi_index(&bytes).unwrap();
        assert!(needs_migration);
        assert_eq!(decoded.books.len(), 1);
        assert!(decoded.source_sig.is_empty());
        assert!(decoded.model_revision.is_empty());
        assert_eq!(decoded.chunk_revision, 0);
    }

    #[test]
    fn multi_profile_source_changes_even_when_mtime_is_unchanged() {
        let baseline = signature(7, &"A".repeat(64));
        let mut changed_content = baseline.clone();
        changed_content.content_id = "new-content".into();
        let mut changed_vector = baseline.clone();
        changed_vector.vector_sha256 = "B".repeat(64);
        let mut changed_model = baseline.clone();
        changed_model.model_revision = "new-model-revision".into();

        assert_ne!(baseline, changed_content);
        assert_ne!(baseline, changed_vector);
        assert_ne!(baseline, changed_model);
        assert_eq!(baseline.mtime, changed_content.mtime);
        assert_eq!(baseline.mtime, changed_vector.mtime);
        assert_eq!(baseline.mtime, changed_model.mtime);
    }

    #[test]
    fn single_center_is_normalized_and_rejects_incomplete_vectors() {
        let center = single_center(2, 2, &[1.0, 0.0, 0.0, 1.0]).unwrap();
        let expected = 1.0 / 2.0f32.sqrt();
        assert!((center[0] - expected).abs() < 1e-6);
        assert!((center[1] - expected).abs() < 1e-6);
        assert!(single_center(2, 2, &[1.0, 0.0]).is_none());
    }
}
