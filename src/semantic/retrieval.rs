//! 检索策略与可选交叉编码器。
//!
//! 默认路径始终是本地全文候选与稠密向量的融合；重排模型只有用户选择
//! “高精度”后才会参与，并且只处理融合后的很小候选集。

use super::{
    model,
    search::{SemBookHits, SemHit},
    vector,
};
use crate::semantic_core::{dot, normalize};
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::AppState;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

const M3_LONG_CONTEXT_MAX_CHARS: usize = 6_000;
const M3_LONG_CONTEXT_CANDIDATES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RetrievalMode {
    Standard,
    HighPrecision,
    M3Hybrid,
}

impl RetrievalMode {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::HighPrecision => "high_precision",
            Self::M3Hybrid => "m3_hybrid",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Standard => "标准：全文与语义结果自动融合",
            Self::HighPrecision => "高精度：全文＋语义融合，并使用重排模型",
            Self::M3Hybrid => "实验性：BGE-M3 稠密、稀疏与 ColBERT 混合",
        }
    }

    fn from_id(value: &str) -> Option<Self> {
        match value.trim() {
            "standard" => Some(Self::Standard),
            "high_precision" => Some(Self::HighPrecision),
            "m3_hybrid" => Some(Self::M3Hybrid),
            _ => None,
        }
    }

    pub(super) fn uses_reranker(self) -> bool {
        matches!(self, Self::HighPrecision | Self::M3Hybrid)
    }
}

fn settings_path() -> Option<PathBuf> {
    let mut path = dirs::config_dir().or_else(dirs::cache_dir)?;
    path.push("ebook-reader");
    path.push("semantic-retrieval-mode.txt");
    Some(path)
}

fn long_context_settings_path() -> Option<PathBuf> {
    let mut path = dirs::config_dir().or_else(dirs::cache_dir)?;
    path.push("ebook-reader");
    path.push("semantic-m3-long-context.txt");
    Some(path)
}

fn long_context_slot() -> &'static Mutex<bool> {
    static SLOT: OnceLock<Mutex<bool>> = OnceLock::new();
    SLOT.get_or_init(|| {
        let enabled = long_context_settings_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|value| value.trim() == "1");
        Mutex::new(enabled)
    })
}

fn slot() -> &'static Mutex<RetrievalMode> {
    static SLOT: OnceLock<Mutex<RetrievalMode>> = OnceLock::new();
    SLOT.get_or_init(|| {
        let mode = settings_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|value| RetrievalMode::from_id(&value))
            .unwrap_or(RetrievalMode::Standard);
        Mutex::new(mode)
    })
}

pub(super) fn initialize() {
    let mode = active_mode();
    if let Some(path) = settings_path() {
        if std::fs::read_to_string(&path)
            .ok()
            .as_deref()
            .map(str::trim)
            != Some(mode.id())
        {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = crate::atomic_file::write(&path, mode.id().as_bytes());
        }
    }
    let _ = long_context_enabled();
}

pub(super) fn active_mode() -> RetrievalMode {
    let selected = *slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // M3 的稀疏向量与 ColBERT 输出只能由 BGE-M3 生成。历史设置若在切换
    // 到其他模型后仍保留，也必须安全回退，不能在 UI 隐藏后继续走 M3 路径。
    if selected == RetrievalMode::M3Hybrid && super::model::active_id() != "bge-m3" {
        RetrievalMode::Standard
    } else {
        selected
    }
}

pub(super) fn long_context_enabled() -> bool {
    *long_context_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn set_long_context_enabled(
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    if enabled && model::active_id() != "bge-m3" {
        return Err("长文精读仅在选择 BGE-M3 时可启用".into());
    }
    let path = long_context_settings_path().ok_or("无法确定长文精读设置目录")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("保存长文精读设置失败：{error}"))?;
    }
    crate::atomic_file::write(&path, if enabled { b"1" } else { b"0" })?;
    *long_context_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = enabled;
    super::clear_sem_query_cache();
    let mut progress = state
        .sem_progress
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.current = if enabled {
        "已启用 BGE-M3 长文精读：只精读少量候选，不需要重建基础索引".into()
    } else {
        "已关闭 BGE-M3 长文精读".into()
    };
    progress.error.clear();
    Ok(())
}

/// 切走 BGE-M3 时将持久化的专属模式回退为标准融合。返回是否发生了回退。
pub(super) fn disable_m3_mode_for_non_m3() -> bool {
    if super::model::active_id() == "bge-m3" {
        return false;
    }
    let mut selected = slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *selected != RetrievalMode::M3Hybrid {
        return false;
    }
    if let Some(path) = settings_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = crate::atomic_file::write(&path, RetrievalMode::Standard.id().as_bytes());
    }
    *selected = RetrievalMode::Standard;
    true
}

pub(super) fn select_mode(state: tauri::State<AppState>, value: &str) -> Result<(), String> {
    let mode = RetrievalMode::from_id(value).ok_or("未知的检索策略")?;
    if mode == RetrievalMode::M3Hybrid && super::model::active_id() != "bge-m3" {
        return Err("实验性 M3 混合检索需要先选择 BGE-M3 模型".into());
    }
    if let Some(path) = settings_path() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("保存检索策略失败：{error}"))?;
        }
        crate::atomic_file::write(&path, mode.id().as_bytes())?;
    }
    *slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
    super::clear_sem_query_cache();
    let mut progress = state
        .sem_progress
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.current = format!("已启用{}", mode.label());
    progress.error.clear();
    Ok(())
}

fn reranker_dir() -> Option<PathBuf> {
    let mut path = dirs::cache_dir()?;
    path.push("ebook-reader");
    path.push("reranker");
    Some(path)
}

fn contains_onnx(path: &std::path::Path) -> bool {
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let child = entry.path();
            child.is_dir() && contains_onnx(&child)
                || child
                    .extension()
                    .and_then(|v| v.to_str())
                    .is_some_and(|v| v.eq_ignore_ascii_case("onnx"))
        })
}

pub(super) fn reranker_available(state: &AppState) -> bool {
    state
        .reranker
        .try_lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
        || reranker_dir().as_deref().is_some_and(contains_onnx)
}

pub(super) fn reranker_available_disk() -> bool {
    reranker_dir().as_deref().is_some_and(contains_onnx)
}

fn reranker(state: &AppState) -> Result<Arc<Mutex<fastembed::TextRerank>>, String> {
    let mut slot = state
        .reranker
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(model) = slot.as_ref() {
        return Ok(model.clone());
    }
    let mut options = fastembed::RerankInitOptions::new(fastembed::RerankerModel::BGERerankerV2M3)
        .with_show_download_progress(false);
    if let Some(dir) = reranker_dir() {
        let _ = std::fs::create_dir_all(&dir);
        options = options.with_cache_dir(dir);
    }
    let model = fastembed::TextRerank::try_new(options)
        .map_err(|error| format!("加载 BGE Reranker v2-M3 失败：{error}"))?;
    let model = Arc::new(Mutex::new(model));
    *slot = Some(model.clone());
    if let Ok(mut progress) = state.sem_progress.lock() {
        progress.reranker_ready = true;
    }
    Ok(model)
}

pub(super) async fn download_reranker(app: tauri::AppHandle) -> Result<(), String> {
    let handle = begin_semantic_task(
        app.state::<AppState>().inner(),
        "semantic_reranker",
        "下载/加载重排模型…",
        true,
    )?;
    let worker_app = app.clone();
    handle
        .spawn_detached("semantic-reranker", move |task| {
            let state = worker_app.state::<AppState>();
            match reranker(state.inner()) {
                Ok(_) => {
                    if let Ok(mut progress) = state.sem_progress.lock() {
                        progress.reranker_ready = true;
                    }
                    finish_semantic_task(state.inner(), "重排模型已就绪", None);
                    let _ = task.complete();
                }
                Err(error) => {
                    finish_semantic_task(state.inner(), "重排模型未就绪", Some(error.clone()));
                    let _ = task.fail(error);
                }
            }
        })
        .inspect_err(|error| {
            finish_semantic_task(
                app.state::<AppState>().inner(),
                "重排模型未就绪",
                Some(error.clone()),
            );
        })?;
    Ok(())
}

pub(super) fn delete_reranker(state: tauri::State<AppState>) -> Result<(), String> {
    if state
        .sem_progress
        .lock()
        .map_err(|_| "语义任务状态锁定失败")?
        .building
    {
        return Err("索引任务正在运行，请稍候".into());
    }
    *state
        .reranker
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    if let Some(dir) = reranker_dir() {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|error| format!("删除重排模型失败：{error}"))?;
        }
    }
    super::clear_sem_query_cache();
    let mut progress = state
        .sem_progress
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.current = "重排模型已删除".into();
    progress.reranker_ready = false;
    progress.error.clear();
    Ok(())
}

/// 只对前 30 个“已融合候选”做交叉编码器。使用排名而非原始 logits 与语义
/// 分数混合，避免不同模型量纲改变排序。
pub(super) fn rerank_hits(state: &AppState, query: &str, books: &mut [SemBookHits]) {
    if !active_mode().uses_reranker() || !reranker_available(state) {
        return;
    }
    let mut refs = Vec::<(usize, usize)>::new();
    let mut docs = Vec::<String>::new();
    for (book_index, book) in books.iter().enumerate() {
        for (hit_index, hit) in book.hits.iter().enumerate() {
            if docs.len() >= 30 {
                break;
            }
            refs.push((book_index, hit_index));
            docs.push(hit.snippet.clone());
        }
        if docs.len() >= 30 {
            break;
        }
    }
    if docs.is_empty() {
        return;
    }
    let Ok(model) = reranker(state) else {
        return;
    };
    let document_refs = docs.iter().map(String::as_str).collect::<Vec<_>>();
    let Some(ranked) = model
        .lock()
        .ok()
        .and_then(|mut m| m.rerank(query, document_refs, false, Some(8)).ok())
    else {
        return;
    };
    let total = ranked.len().max(1) as f32;
    for (rank, result) in ranked.into_iter().enumerate() {
        let Some(&(book_index, hit_index)) = refs.get(result.index) else {
            continue;
        };
        let bonus = (total - rank as f32) / total;
        let hit: &mut SemHit = &mut books[book_index].hits[hit_index];
        hit.score = hit.score * 0.35 + bonus * 0.65;
    }
    for book in books {
        book.score = book
            .hits
            .iter()
            .map(|hit| hit.score)
            .fold(0.0_f32, f32::max);
    }
}

/// BGE-M3 的长上下文能力只用于第二阶段：基础小块负责快速、精确地召回；这里
/// 再把命中点周围的连续正文临时合并，并对最多八个候选作一次长文重排。
/// 没有额外持久化索引，也不改变书库中已有的小块向量。
pub(super) fn rerank_long_context_hits(state: &AppState, query: &str, books: &mut [SemBookHits]) {
    if !long_context_enabled() || model::active_id() != "bge-m3" {
        return;
    }
    let mut refs = Vec::<(usize, usize)>::new();
    let mut contexts = Vec::<String>::new();
    for (book_index, book) in books.iter().enumerate() {
        let Ok(id) = book.book_id.parse::<u64>() else {
            continue;
        };
        let Some(data) = vector::load(state, id) else {
            continue;
        };
        for (hit_index, hit) in book.hits.iter().enumerate() {
            if contexts.len() >= M3_LONG_CONTEXT_CANDIDATES {
                break;
            }
            if let Some(context) =
                data.context_around(hit.chapter, &hit.snippet, M3_LONG_CONTEXT_MAX_CHARS)
            {
                refs.push((book_index, hit_index));
                contexts.push(context);
            }
        }
        if contexts.len() >= M3_LONG_CONTEXT_CANDIDATES {
            break;
        }
    }
    if contexts.is_empty() {
        return;
    }
    let Ok(embedder) = model::embedder(state) else {
        return;
    };
    let mut query_output = match embedder
        .lock()
        .ok()
        .and_then(|mut model| model.embed_m3(vec![query.to_string()]).ok())
    {
        Some(output) => output,
        None => return,
    };
    let Some(mut query_vector) = query_output.dense.pop() else {
        return;
    };
    normalize(&mut query_vector);
    let contexts_output = match embedder
        .lock()
        .ok()
        .and_then(|mut model| model.embed_m3(contexts).ok())
    {
        Some(output) => output,
        None => return,
    };
    let scores = contexts_output
        .dense
        .into_iter()
        .map(|mut vector| {
            normalize(&mut vector);
            dot(&query_vector, &vector)
        })
        .collect::<Vec<_>>();
    if scores.len() != refs.len() {
        return;
    }
    let mut order = (0..scores.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| scores[*right].total_cmp(&scores[*left]));
    let mut rank = vec![0usize; scores.len()];
    for (position, index) in order.into_iter().enumerate() {
        rank[index] = position;
    }
    let total = scores.len() as f32;
    for (index, (book_index, hit_index)) in refs.into_iter().enumerate() {
        let bonus = (total - rank[index] as f32) / total;
        let hit = &mut books[book_index].hits[hit_index];
        hit.score = hit.score * 0.55 + bonus * 0.45;
    }
    for book in books {
        book.score = book
            .hits
            .iter()
            .map(|hit| hit.score)
            .fold(0.0_f32, f32::max);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const _: () = assert!(M3_LONG_CONTEXT_MAX_CHARS >= 4_000);
    const _: () = assert!(M3_LONG_CONTEXT_MAX_CHARS <= 8_192);

    #[test]
    fn retrieval_modes_have_stable_persisted_ids() {
        for mode in [
            RetrievalMode::Standard,
            RetrievalMode::HighPrecision,
            RetrievalMode::M3Hybrid,
        ] {
            assert_eq!(RetrievalMode::from_id(mode.id()), Some(mode));
            assert!(!mode.label().is_empty());
        }
    }

    #[test]
    fn long_context_has_a_bounded_second_stage_budget() {
        assert_eq!(M3_LONG_CONTEXT_CANDIDATES, 8);
    }
}
