//! BGE-M3 的本地稀疏倒排索引与按需 ColBERT 重排。
//!
//! ColBERT 若为全书库保存每个 token 的 1024 维向量，磁盘占用会远超正文和
//! 稠密索引。因此这里把它用于融合候选的按需 late-interaction 重排；持久化的
//! 是真正用于召回的 M3 稀疏倒排索引。

use super::{model, vector};
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::{book, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const VERSION: u32 = 1;
const MAX_SPARSE_TERMS: usize = 96;
const MAX_COLBERT_TOKENS: usize = 32;

#[derive(Clone, Serialize, Deserialize)]
struct SparseChunk {
    indices: Vec<u32>,
    values: Vec<f32>,
}
#[derive(Clone, Serialize, Deserialize)]
struct SparseBook {
    version: u32,
    chunks: Vec<SparseChunk>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Posting {
    book_id: u64,
    chunk: u32,
    weight: f32,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct SparseGlobal {
    version: u32,
    postings: HashMap<u32, Vec<Posting>>,
}

static GLOBAL: OnceLock<Mutex<Option<SparseGlobal>>> = OnceLock::new();
fn global_cache() -> &'static Mutex<Option<SparseGlobal>> {
    GLOBAL.get_or_init(|| Mutex::new(None))
}

fn directory_for_model(selected: model::SemanticModel) -> Option<std::path::PathBuf> {
    vector::directory_for_model(selected).map(|dir| dir.join("m3-hybrid"))
}
fn directory() -> Option<std::path::PathBuf> {
    directory_for_model(model::active())
}
fn book_path_for_model(selected: model::SemanticModel, id: u64) -> Option<std::path::PathBuf> {
    Some(directory_for_model(selected)?.join(format!("m3_{id}.rmp")))
}
fn book_path(id: u64) -> Option<std::path::PathBuf> {
    book_path_for_model(model::active(), id)
}
fn global_path_for_model(selected: model::SemanticModel) -> Option<std::path::PathBuf> {
    Some(directory_for_model(selected)?.join("sparse-global.rmp"))
}
fn global_path() -> Option<std::path::PathBuf> {
    global_path_for_model(model::active())
}

fn trim_sparse(indices: &[usize], values: &[f32]) -> SparseChunk {
    let mut terms = indices
        .iter()
        .copied()
        .zip(values.iter().copied())
        .collect::<Vec<_>>();
    terms.sort_by(|a, b| b.1.total_cmp(&a.1));
    terms.truncate(MAX_SPARSE_TERMS);
    terms.sort_by_key(|term| term.0);
    SparseChunk {
        indices: terms.iter().map(|(id, _)| *id as u32).collect(),
        values: terms.iter().map(|(_, value)| *value).collect(),
    }
}

fn write_book_for_model(
    selected: model::SemanticModel,
    id: u64,
    chunks: Vec<SparseChunk>,
) -> Result<(), String> {
    let path = book_path_for_model(selected, id).ok_or("无法确定 M3 索引目录")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = rmp_serde::to_vec(&SparseBook {
        version: VERSION,
        chunks,
    })
    .map_err(|e| e.to_string())?;
    crate::atomic_file::write(&path, &bytes)
}

fn write_book(id: u64, chunks: Vec<SparseChunk>) -> Result<(), String> {
    write_book_for_model(model::active(), id, chunks)
}

fn read_book_for_model(selected: model::SemanticModel, id: u64) -> Option<SparseBook> {
    let book: SparseBook =
        rmp_serde::from_slice(&std::fs::read(book_path_for_model(selected, id)?).ok()?).ok()?;
    (book.version == VERSION).then_some(book)
}

fn rebuild_global_for_model(
    selected: model::SemanticModel,
    ids: &[u64],
    publish_cache: bool,
) -> Result<(), String> {
    let mut global = SparseGlobal {
        version: VERSION,
        postings: HashMap::new(),
    };
    for &id in ids {
        let Some(book) = read_book_for_model(selected, id) else {
            continue;
        };
        for (chunk, sparse) in book.chunks.iter().enumerate() {
            for (&term, &weight) in sparse.indices.iter().zip(&sparse.values) {
                global.postings.entry(term).or_default().push(Posting {
                    book_id: id,
                    chunk: chunk as u32,
                    weight,
                });
            }
        }
    }
    let path = global_path_for_model(selected).ok_or("无法确定 M3 索引目录")?;
    let bytes = rmp_serde::to_vec(&global).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&path, &bytes)?;
    if publish_cache {
        *global_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(global);
    }
    Ok(())
}

fn rebuild_global(ids: &[u64]) -> Result<(), String> {
    rebuild_global_for_model(model::active(), ids, true)
}

fn load_global() -> Option<SparseGlobal> {
    if let Some(index) = global_cache().lock().ok()?.as_ref().cloned() {
        return Some(index);
    }
    let index: SparseGlobal = rmp_serde::from_slice(&std::fs::read(global_path()?).ok()?).ok()?;
    if index.version != VERSION {
        return None;
    }
    *global_cache().lock().ok()? = Some(index.clone());
    Some(index)
}

pub(super) fn is_ready() -> bool {
    load_global().is_some()
}
pub(super) fn indexed_books() -> u32 {
    let Some(dir) = directory() else {
        return 0;
    };
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("m3_"))
        .count() as u32
}

pub(super) fn clear_memory_cache() {
    *global_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

pub(super) fn build_pending(
    embedder: &Mutex<model::SemanticEmbedder>,
    selected: model::SemanticModel,
    books: &[book::Book],
    state: &AppState,
    task: &crate::background_tasks::TaskRunGuard,
) -> Result<(), String> {
    if selected != model::SemanticModel::BgeM3 {
        return Err("M3 pending 索引只能使用 BGE-M3 模型".into());
    }
    for (book_index, book) in books.iter().enumerate() {
        if !matches!(
            task.control_signal(),
            crate::background_tasks::TaskControlSignal::Continue
        ) {
            return Err("M3 pending 索引已停止".into());
        }
        let data = vector::load_uncached_for_model(selected, book.id)
            .ok_or_else(|| format!("{}：无法读取 pending 稠密向量", book.title))?;
        let texts = data
            .entries()
            .map(|(_, text, _)| text.to_string())
            .collect::<Vec<_>>();
        let mut chunks = Vec::with_capacity(texts.len());
        for batch in texts.chunks(8) {
            let output = embedder
                .lock()
                .map_err(|_| "BGE-M3 pending 模型锁定失败".to_string())?
                .embed_m3(batch.to_vec())?;
            chunks.extend(
                output
                    .sparse
                    .iter()
                    .map(|sparse| trim_sparse(&sparse.indices, &sparse.values)),
            );
        }
        if chunks.len() != texts.len() {
            return Err(format!("{}：M3 pending 稀疏输出数量不完整", book.title));
        }
        write_book_for_model(selected, book.id, chunks)?;
        let mut progress = state
            .sem_progress
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        progress.current = format!(
            "正在校验 M3 混合索引 {}/{}：{}；原方案继续服务",
            book_index + 1,
            books.len(),
            book.title
        );
    }
    let ids = books.iter().map(|book| book.id).collect::<Vec<_>>();
    rebuild_global_for_model(selected, &ids, false)?;
    for book in books {
        let sparse = read_book_for_model(selected, book.id)
            .ok_or_else(|| format!("{}：M3 pending 索引复核失败", book.title))?;
        let dense = vector::load_uncached_for_model(selected, book.id)
            .ok_or_else(|| format!("{}：pending 稠密向量复核失败", book.title))?;
        if sparse.chunks.len() != dense.len() {
            return Err(format!("{}：M3 pending 块数量不一致", book.title));
        }
    }
    let global: SparseGlobal = rmp_serde::from_slice(
        &std::fs::read(global_path_for_model(selected).ok_or("无法确定 M3 全局索引路径")?)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if global.version != VERSION {
        return Err("M3 pending 全局索引版本校验失败".into());
    }
    Ok(())
}

pub(super) async fn build(app: tauri::AppHandle) -> Result<(), String> {
    if model::active_id() != "bge-m3" {
        return Err("请先选择 BGE-M3 模型，再建立 M3 索引".into());
    }
    let handle = begin_semantic_task(
        app.state::<AppState>().inner(),
        "semantic_m3",
        "准备建立 BGE-M3 稀疏索引…",
        false,
    )?;
    let worker_app = app.clone();
    handle
        .spawn_detached("semantic-m3-index", move |task| {
            let state = worker_app.state::<AppState>();
            let model = match model::embedder(state.inner()) {
                Ok(model) => model,
                Err(error) => {
                    finish_semantic_task(state.inner(), "M3 索引未启动", Some(error.clone()));
                    let _ = task.fail(error);
                    return;
                }
            };
            let books = state
                .library
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .books
                .iter()
                .filter(|book| book.format != "pdf" && vector::metadata_exists(book.id))
                .cloned()
                .collect::<Vec<book::Book>>();
            let mut completed = 0u32;
            for book in &books {
                let Some(data) = vector::load(state.inner(), book.id) else {
                    continue;
                };
                let texts = data
                    .entries()
                    .map(|(_, text, _)| text.to_string())
                    .collect::<Vec<_>>();
                let mut chunks = Vec::with_capacity(texts.len());
                for batch in texts.chunks(8) {
                    let output = match model
                        .lock()
                        .map_err(|_| "BGE-M3 模型锁定失败".to_string())
                        .and_then(|mut model| model.embed_m3(batch.to_vec()))
                    {
                        Ok(output) => output,
                        Err(error) => {
                            finish_semantic_task(
                                state.inner(),
                                "M3 索引未完成",
                                Some(error.clone()),
                            );
                            let _ = task.fail(error);
                            return;
                        }
                    };
                    chunks.extend(
                        output
                            .sparse
                            .iter()
                            .map(|sparse| trim_sparse(&sparse.indices, &sparse.values)),
                    );
                }
                if let Err(error) = write_book(book.id, chunks) {
                    finish_semantic_task(state.inner(), "M3 索引未完成", Some(error.clone()));
                    let _ = task.fail(error);
                    return;
                }
                completed += 1;
                {
                    let mut progress = state.sem_progress.lock().unwrap_or_else(|p| p.into_inner());
                    progress.done = completed;
                    progress.total = books.len() as u32;
                    progress.m3_index_done = completed;
                    progress.m3_index_total = books.len() as u32;
                    progress.current = format!("正在建立 M3 稀疏索引：{}", book.title);
                }
                let _ = task.update_progress(
                    completed as u64,
                    books.len() as u64,
                    format!("M3 稀疏索引 {completed}/{}", books.len()),
                );
                if !matches!(
                    task.control_signal(),
                    crate::background_tasks::TaskControlSignal::Continue
                ) {
                    finish_semantic_task(state.inner(), "M3 索引已停止，可重新建立", None);
                    let _ = task.pause();
                    return;
                }
            }
            let ids = books.iter().map(|book| book.id).collect::<Vec<_>>();
            match rebuild_global(&ids) {
                Ok(()) => {
                    let mut progress = state.sem_progress.lock().unwrap_or_else(|p| p.into_inner());
                    progress.m3_index_done = completed;
                    progress.m3_index_total = books.len() as u32;
                    progress.m3_index_ready = true;
                    drop(progress);
                    finish_semantic_task(
                        state.inner(),
                        "BGE-M3 稀疏索引已完成；ColBERT 会按需重排候选",
                        None,
                    );
                    let _ = task.complete();
                }
                Err(error) => {
                    finish_semantic_task(state.inner(), "M3 稀疏索引未完成", Some(error.clone()));
                    let _ = task.fail(error);
                }
            }
        })
        .inspect_err(|error| {
            finish_semantic_task(
                app.state::<AppState>().inner(),
                "M3 索引未启动",
                Some(error.clone()),
            );
        })?;
    Ok(())
}

pub(super) fn delete(state: tauri::State<AppState>) -> Result<(), String> {
    if state
        .sem_progress
        .lock()
        .map_err(|_| "语义任务状态锁定失败")?
        .building
    {
        return Err("索引任务正在运行，请稍候".into());
    }
    if let Some(dir) = directory() {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| format!("删除 M3 索引失败：{e}"))?;
        }
    }
    *global_cache().lock().unwrap_or_else(|p| p.into_inner()) = None;
    let mut progress = state.sem_progress.lock().unwrap_or_else(|p| p.into_inner());
    progress.m3_index_done = 0;
    progress.m3_index_total = 0;
    progress.m3_index_ready = false;
    progress.current = "BGE-M3 稀疏索引已删除".into();
    progress.error.clear();
    super::clear_sem_query_cache();
    Ok(())
}

pub(super) fn delete_files() -> Result<(), String> {
    if let Some(dir) = directory() {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| format!("删除 M3 索引失败：{e}"))?;
        }
    }
    *global_cache().lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(())
}

/// 稠密切块或正文变化后，旧稀疏词权重不能继续参与召回。逐书文件和全局倒排
/// 一起失效，避免“显示已建立但命中上一版正文”。
pub(super) fn invalidate_book(id: u64) {
    if let Some(path) = book_path(id) {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = global_path() {
        let _ = std::fs::remove_file(path);
    }
    *global_cache().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// 稀疏倒排的返回值是“应补进稠密候选池的书籍 ID”。候选仍会走已有逐段
/// 向量读取，保证返回的章节、引用和权限检查保持同一条路径。
pub(super) fn sparse_candidate_books(state: &AppState, query: &str, limit: usize) -> Vec<u64> {
    if model::active_id() != "bge-m3" || !is_ready() || limit == 0 {
        return Vec::new();
    }
    let Ok(embedder) = model::embedder(state) else {
        return Vec::new();
    };
    let output = match embedder
        .lock()
        .ok()
        .and_then(|mut model| model.embed_m3(vec![query.to_string()]).ok())
    {
        Some(output) => output,
        None => return Vec::new(),
    };
    let Some(query_sparse) = output.sparse.first() else {
        return Vec::new();
    };
    let Some(index) = load_global() else {
        return Vec::new();
    };
    let mut scores = HashMap::<u64, f32>::new();
    for (&term, &weight) in query_sparse.indices.iter().zip(&query_sparse.values) {
        if let Some(postings) = index.postings.get(&(term as u32)) {
            for posting in postings {
                *scores.entry(posting.book_id).or_default() += weight * posting.weight;
            }
        }
    }
    let mut ranked = scores.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.into_iter().take(limit).map(|(id, _)| id).collect()
}

fn colbert_score(query: &[Vec<f32>], doc: &[Vec<f32>]) -> f32 {
    query
        .iter()
        .take(MAX_COLBERT_TOKENS)
        .map(|q| {
            doc.iter()
                .take(MAX_COLBERT_TOKENS)
                .map(|d| q.iter().zip(d).map(|(a, b)| a * b).sum::<f32>())
                .fold(f32::NEG_INFINITY, f32::max)
        })
        .filter(|score| score.is_finite())
        .sum()
}

pub(super) fn colbert_rerank(
    state: &AppState,
    query: &str,
    books: &mut [super::search::SemBookHits],
) {
    if model::active_id() != "bge-m3" || !is_ready() {
        return;
    }
    let docs = books
        .iter()
        .flat_map(|book| book.hits.iter().map(|hit| hit.snippet.clone()))
        .take(20)
        .collect::<Vec<_>>();
    if docs.is_empty() {
        return;
    }
    let Ok(embedder) = model::embedder(state) else {
        return;
    };
    let output = match embedder
        .lock()
        .ok()
        .and_then(|mut model| model.embed_m3(vec![query.to_string()]).ok())
    {
        Some(output) => output,
        None => return,
    };
    let Some(query_colbert) = output.colbert.first() else {
        return;
    };
    let docs_out = match embedder
        .lock()
        .ok()
        .and_then(|mut model| model.embed_m3(docs).ok())
    {
        Some(output) => output,
        None => return,
    };
    let scores = docs_out
        .colbert
        .iter()
        .map(|doc| colbert_score(query_colbert, doc))
        .collect::<Vec<_>>();
    let mut order = (0..scores.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    let mut rank = vec![0usize; scores.len()];
    for (position, index) in order.into_iter().enumerate() {
        rank[index] = position;
    }
    let mut at = 0usize;
    for book in books {
        for hit in &mut book.hits {
            if at >= scores.len() {
                break;
            }
            hit.score =
                hit.score * 0.4 + (scores.len() - rank[at]) as f32 / scores.len() as f32 * 0.6;
            at += 1;
        }
        book.score = book.hits.iter().map(|hit| hit.score).fold(0.0, f32::max);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_terms_are_capped_and_kept_in_token_order() {
        let indices = (0..(MAX_SPARSE_TERMS + 5)).collect::<Vec<_>>();
        let values = indices
            .iter()
            .map(|value| *value as f32)
            .collect::<Vec<_>>();
        let sparse = trim_sparse(&indices, &values);
        assert_eq!(sparse.indices.len(), MAX_SPARSE_TERMS);
        assert!(sparse.indices.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(sparse.indices[0], 5);
    }

    #[test]
    fn colbert_uses_late_interaction_maximum_per_query_token() {
        let query = vec![vec![1.0, 0.0], vec![0.0, 1.0]];
        let document = vec![vec![0.8, 0.2], vec![0.1, 0.9]];
        assert!((colbert_score(&query, &document) - 1.7).abs() < 0.001);
    }
}
