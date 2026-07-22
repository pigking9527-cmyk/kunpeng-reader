//! 语义模型选择、磁盘布局和运行时装载。
//!
//! 阅读器只保留两种 FastEmbed 内置的 BGE 中文模型：轻量的 Small 与更高
//! 精度的 Large。这样模型下载、索引格式与发布包保持单一路径，不依赖自定义
//! ONNX 转换包或 GPU 运行时。

use super::{
    accelerator, clear_multi_profile_cache, clear_sem_profile_cache, clear_sem_query_cache,
    clear_sem_status_cache,
};
use crate::semantic_core::cosine;
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::AppState;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

pub(super) const DEFAULT_SEM_MODEL: &str = "bge-small-zh-v1.5";
const SEM_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";
pub(super) const SEMANTIC_MODEL_MISSING: &str =
    "尚未下载语义模型，请先在书架的语义索引设置中下载模型。";

/// 模型 id 会写入向量索引元数据，避免不同维度的向量被误混用。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SemanticModel {
    BgeSmallZhV15,
    BgeLargeZhV15,
}

impl SemanticModel {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => DEFAULT_SEM_MODEL,
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => "BGE Small 中文（默认，轻量）",
            Self::BgeLargeZhV15 => "BGE Large 中文（高精度）",
        }
    }

    /// FastEmbed 的模型导出或池化约定改变时，必须更新该值，避免旧向量被
    /// 静默混用。
    pub(super) const fn revision(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => "bge-small-zh-v1.5-fastembed-v1",
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5-fastembed-v1",
        }
    }

    pub(super) const fn estimated_download_bytes(self) -> u64 {
        match self {
            Self::BgeSmallZhV15 => 120 * 1024 * 1024,
            Self::BgeLargeZhV15 => 1_300 * 1024 * 1024,
        }
    }

    pub(super) const fn dimensions(self) -> usize {
        match self {
            Self::BgeSmallZhV15 => 512,
            Self::BgeLargeZhV15 => 1024,
        }
    }

    pub(super) const fn locally_supported(self) -> bool {
        true
    }

    pub(super) fn from_id(id: &str) -> Option<Self> {
        match id {
            DEFAULT_SEM_MODEL => Some(Self::BgeSmallZhV15),
            "bge-large-zh-v1.5" => Some(Self::BgeLargeZhV15),
            _ => None,
        }
    }
}

/// 语义模型缓存目录（与探针共用，避免运行时再下载）。
pub(super) fn model_dir() -> Option<std::path::PathBuf> {
    model_dir_for(active())
}

fn model_dir_for(selected: SemanticModel) -> Option<std::path::PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("ebook-reader");
    dir.push("models");
    // 旧版 bge-small 缓存就在 models 根目录；保留它避免升级后重复下载。
    if selected == SemanticModel::BgeLargeZhV15 {
        dir.push(selected.id());
    }
    Some(dir)
}

fn selection_path() -> Option<std::path::PathBuf> {
    let mut path = dirs::config_dir().or_else(dirs::cache_dir)?;
    path.push("ebook-reader");
    path.push("semantic-model.txt");
    Some(path)
}

fn selected_slot() -> &'static Mutex<SemanticModel> {
    static SLOT: OnceLock<Mutex<SemanticModel>> = OnceLock::new();
    SLOT.get_or_init(|| {
        let model = selection_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|id| SemanticModel::from_id(id.trim()))
            // 已移除模型的旧选择会安全回退到默认轻量模型。
            .unwrap_or(SemanticModel::BgeSmallZhV15);
        Mutex::new(model)
    })
}

pub(super) fn initialize_selection() {
    let selected = active();
    // 迁移旧配置：不再保留指向已移除模型的选择值。
    if let Some(path) = selection_path() {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if SemanticModel::from_id(current.trim()).is_none() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = crate::atomic_file::write(&path, selected.id().as_bytes());
        }
    }
}

pub(super) fn active() -> SemanticModel {
    *selected_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn active_id() -> &'static str {
    active().id()
}

pub(super) fn query_input(query: &str) -> String {
    format!("{SEM_QUERY_PREFIX}{query}")
}

pub(super) fn directory_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn directory_contains_model_file(path: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if directory_contains_model_file(&path) {
                return true;
            }
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
        {
            return true;
        }
    }
    false
}

/// 只检查本地状态，不等待模型下载互斥锁，也不触发联网下载。
pub(super) fn available(state: &AppState) -> bool {
    state
        .embedder
        .try_lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
        || model_dir()
            .as_deref()
            .is_some_and(directory_contains_model_file)
}

/// 懒加载语义模型（首次会下载到 %LOCALAPPDATA%/ebook-reader/models）。
pub(super) fn embedder(state: &AppState) -> Result<Arc<Mutex<fastembed::TextEmbedding>>, String> {
    let mut slot = state.embedder.lock().unwrap();
    if let Some(model) = slot.as_ref() {
        return Ok(model.clone());
    }
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let model_kind = match active() {
        SemanticModel::BgeSmallZhV15 => EmbeddingModel::BGESmallZHV15,
        SemanticModel::BgeLargeZhV15 => EmbeddingModel::BGELargeZHV15,
    };
    let mut options = InitOptions::new(model_kind).with_show_download_progress(false);
    if let Some(dir) = model_dir() {
        let _ = std::fs::create_dir_all(&dir);
        options = options.with_cache_dir(dir);
    }
    let model =
        TextEmbedding::try_new(options).map_err(|error| format!("加载语义模型失败：{error}"))?;
    let model = Arc::new(Mutex::new(model));
    *slot = Some(model.clone());
    Ok(model)
}

pub(super) async fn download(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state
        .sem_progress
        .lock()
        .map_err(|_| "语义任务状态锁定失败")?
        .model_downloading
    {
        return Ok(());
    }
    let task_handle =
        begin_semantic_task(state.inner(), "semantic_model", "下载/加载语义模型…", true)?;
    let worker_app = app.clone();
    if let Err(error) = task_handle.spawn_detached("semantic-model", move |task| {
        let state = worker_app.state::<AppState>();
        match embedder(state.inner()) {
            Ok(_) => {
                finish_semantic_task(state.inner(), "语义模型已就绪", None);
                let _ = task.complete();
            }
            Err(error) => {
                finish_semantic_task(state.inner(), "语义模型未就绪", Some(error.clone()));
                let _ = task.fail(error);
            }
        }
    }) {
        finish_semantic_task(
            app.state::<AppState>().inner(),
            "语义模型未就绪",
            Some(error.clone()),
        );
        return Err(error);
    }
    Ok(())
}

pub(super) fn delete(state: tauri::State<AppState>) -> Result<(), String> {
    {
        let progress = state.sem_progress.lock().unwrap();
        if progress.building || progress.model_downloading {
            return Err("索引或模型任务正在运行，请稍候".into());
        }
    }
    *state.embedder.lock().unwrap() = None;
    accelerator::mark_unprepared();
    if let Some(dir) = model_dir() {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|error| format!("删除模型失败：{error}"))?;
        }
    }
    clear_sem_status_cache();
    let mut progress = state.sem_progress.lock().unwrap();
    progress.current = "语义模型已删除".into();
    progress.error.clear();
    Ok(())
}

/// 切换模型只清除内存运行态；磁盘向量按模型目录保留，因此切回时不必重新
/// 下载模型。索引元数据会严格比较模型 id，不能混用不同维度的向量。
pub(super) fn select(state: tauri::State<AppState>, model_id: String) -> Result<(), String> {
    let selected = SemanticModel::from_id(model_id.trim()).ok_or("未知的语义模型")?;
    {
        let progress = state.sem_progress.lock().unwrap();
        if progress.building || progress.model_downloading {
            return Err("模型下载或索引任务正在运行，请完成后再切换模型".into());
        }
    }
    if selected == active() {
        return Ok(());
    }
    let path = selection_path().ok_or("无法确定模型设置路径")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("保存模型设置失败：{error}"))?;
    }
    crate::atomic_file::write(&path, selected.id().as_bytes())?;
    *selected_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = selected;

    *state.embedder.lock().unwrap() = None;
    state.sem_cache.lock().unwrap().clear();
    state.sem_cache_order.lock().unwrap().clear();
    state
        .sem_cache_bytes
        .store(0, std::sync::atomic::Ordering::Relaxed);
    *state.global_index.lock().unwrap() = None;
    accelerator::mark_unprepared();
    clear_sem_query_cache();
    clear_sem_profile_cache();
    clear_multi_profile_cache();
    accelerator::clear_snapshot_cache();
    clear_sem_status_cache();
    let mut progress = state.sem_progress.lock().unwrap();
    progress.current = format!("已切换至 {}；正在检查本地模型和语义索引…", selected.label());
    progress.error.clear();
    Ok(())
}

fn probe_file() -> std::path::PathBuf {
    let mut dir = dirs::cache_dir().unwrap_or(std::env::temp_dir());
    dir.push("ebook-reader");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("sem_probe.txt");
    dir
}

fn probe_write(message: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(probe_file())
    {
        let _ = writeln!(file, "{message}");
    }
}

/// 验证 BGE 运行时和基本语义质量。结果写到
/// `%LOCALAPPDATA%/ebook-reader/sem_probe.txt`。
pub(super) fn probe() {
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let _ = std::fs::remove_file(probe_file());
    std::panic::set_hook(Box::new(|info| probe_write(&format!("PANIC: {info}"))));
    let run = std::panic::catch_unwind(|| {
        probe_write("starting...");
        let mut options =
            InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
        if let Some(dir) = model_dir_for(SemanticModel::BgeSmallZhV15) {
            let _ = std::fs::create_dir_all(&dir);
            options = options.with_cache_dir(dir);
        }
        let mut model =
            TextEmbedding::try_new(options).map_err(|error| format!("MODEL ERR: {error}"))?;
        let texts = vec![
            query_input("高兴"),
            "开心".to_string(),
            "万念俱灰".to_string(),
            "木头桌子".to_string(),
        ];
        let embeddings = model
            .embed(texts, None)
            .map_err(|error| format!("EMBED ERR: {error}"))?;
        probe_write(&format!(
            "OK dim={} 高兴~开心={:.3} 高兴~万念俱灰={:.3} 高兴~桌子={:.3}",
            embeddings[0].len(),
            cosine(&embeddings[0], &embeddings[1]),
            cosine(&embeddings[0], &embeddings[2]),
            cosine(&embeddings[0], &embeddings[3]),
        ));
        Ok::<(), String>(())
    });
    match run {
        Ok(Ok(())) => {}
        Ok(Err(message)) => probe_write(&message),
        Err(_) => probe_write("CAUGHT PANIC (see above)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_roundtrip_and_unknown_ids_are_rejected() {
        for model in [SemanticModel::BgeSmallZhV15, SemanticModel::BgeLargeZhV15] {
            assert_eq!(SemanticModel::from_id(model.id()), Some(model));
            assert!(!model.label().is_empty());
            assert!(!model.revision().is_empty());
            assert!(model.dimensions() > 0);
        }
        assert_eq!(SemanticModel::from_id("unknown"), None);
    }

    #[test]
    fn bge_queries_use_retrieval_instruction() {
        assert!(query_input("天津教案").starts_with(SEM_QUERY_PREFIX));
    }
}
