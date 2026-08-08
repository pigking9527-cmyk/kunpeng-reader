//! 语义模型选择、磁盘布局和运行时装载。
//!
//! 阅读器只保留两种 FastEmbed 内置的 BGE 中文模型：轻量的 Small 与更高
//! 精度的 Large。这样模型下载、索引格式与发布包保持单一路径，不依赖自定义
//! ONNX 转换包或 GPU 运行时。

use super::{accelerator, clear_sem_query_cache, clear_sem_status_cache, gpu, profile, retrieval};
use crate::semantic_core::cosine;
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::AppState;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

pub(super) const DEFAULT_SEM_MODEL: &str = "bge-small-zh-v1.5";
/// FastEmbed 默认只把 BGE-M3 截断到 512 token。书架的常规切块本来就很短，
/// 但“长文精读”会把命中点附近的连续正文交给 M3，因此需要保留模型原生的
/// 8192 token 上限；这不会让短块推理自动填充到 8192。
const M3_MAX_INPUT_TOKENS: usize = 8192;
const SEM_QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";
pub(super) const SEMANTIC_MODEL_MISSING: &str =
    "尚未下载语义模型，请先在书架的语义索引设置中下载模型。";

/// 模型 id 会写入向量索引元数据，避免不同维度的向量被误混用。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SemanticModel {
    BgeSmallZhV15,
    BgeLargeZhV15,
    BgeM3,
    MultilingualE5Small,
}

/// 统一两类 FastEmbed 运行时。BGE-M3 不能只走 TextEmbedding：它的同一次
/// 推理还会给出稀疏词权重与 ColBERT token 向量，供混合检索使用。
pub(crate) enum SemanticEmbedder {
    Text(fastembed::TextEmbedding),
    M3(fastembed::Bgem3Embedding),
}

impl SemanticEmbedder {
    pub(crate) fn embed_dense(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        match self {
            Self::Text(model) => model.embed(texts, None).map_err(|error| error.to_string()),
            Self::M3(model) => model
                .embed(texts, None)
                .map(|out| out.dense)
                .map_err(|error| error.to_string()),
        }
    }

    pub(crate) fn embed_m3(
        &mut self,
        texts: Vec<String>,
    ) -> Result<fastembed::Bgem3EmbeddingOutput, String> {
        match self {
            Self::M3(model) => model.embed(texts, None).map_err(|error| error.to_string()),
            Self::Text(_) => Err("当前模型不提供 BGE-M3 稀疏向量或 ColBERT 输出".into()),
        }
    }
}

impl SemanticModel {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => DEFAULT_SEM_MODEL,
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5",
            Self::BgeM3 => "bge-m3",
            Self::MultilingualE5Small => "multilingual-e5-small",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => "BGE Small 中文（默认，轻量）",
            Self::BgeLargeZhV15 => "BGE Large 中文（高精度）",
            Self::BgeM3 => "BGE-M3（多语言、混合检索）",
            Self::MultilingualE5Small => "Multilingual-E5-Small（多语言，轻量）",
        }
    }

    /// FastEmbed 的模型导出或池化约定改变时，必须更新该值，避免旧向量被
    /// 静默混用。
    pub(super) const fn revision(self) -> &'static str {
        match self {
            Self::BgeSmallZhV15 => "bge-small-zh-v1.5-fastembed-v1",
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5-fastembed-v1",
            Self::BgeM3 => "bge-m3-fastembed-joint-v1",
            Self::MultilingualE5Small => "multilingual-e5-small-fastembed-v1",
        }
    }

    pub(super) const fn dimensions(self) -> usize {
        match self {
            Self::BgeSmallZhV15 => 512,
            Self::BgeLargeZhV15 => 1024,
            Self::BgeM3 => 1024,
            Self::MultilingualE5Small => 384,
        }
    }

    pub(super) const fn locally_supported(self) -> bool {
        true
    }

    pub(super) fn from_id(id: &str) -> Option<Self> {
        match id {
            DEFAULT_SEM_MODEL => Some(Self::BgeSmallZhV15),
            "bge-large-zh-v1.5" => Some(Self::BgeLargeZhV15),
            "bge-m3" => Some(Self::BgeM3),
            "multilingual-e5-small" => Some(Self::MultilingualE5Small),
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
    if selected != SemanticModel::BgeSmallZhV15 {
        dir.push(selected.id());
    }
    Some(dir)
}

fn model_artifact_dir_for(selected: SemanticModel) -> Option<std::path::PathBuf> {
    let base = model_dir_for(selected)?;
    let selected_id = selected.id().to_ascii_lowercase();
    if base
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().contains(&selected_id))
        && directory_contains_model_file(&base)
    {
        return Some(base);
    }
    std::fs::read_dir(&base)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.to_ascii_lowercase().contains(&selected_id))
                && directory_contains_model_file(path)
        })
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
    query_input_for(active(), query)
}

fn query_input_for(selected: SemanticModel, query: &str) -> String {
    match selected {
        SemanticModel::MultilingualE5Small => format!("query: {query}"),
        _ => format!("{SEM_QUERY_PREFIX}{query}"),
    }
}

/// E5 以 query/passage 前缀训练；省略 passage 会显著降低跨语言检索质量。
pub(super) fn document_input(text: &str) -> String {
    document_input_for(active(), text)
}

fn document_input_for(selected: SemanticModel, text: &str) -> String {
    match selected {
        SemanticModel::MultilingualE5Small => format!("passage: {text}"),
        _ => text.to_string(),
    }
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
        || model_artifact_dir_for(active()).is_some()
}

/// 懒加载语义模型（首次会下载到 %LOCALAPPDATA%/ebook-reader/models）。
pub(super) fn embedder(state: &AppState) -> Result<Arc<Mutex<SemanticEmbedder>>, String> {
    let mut slot = state.embedder.lock().unwrap_or_else(|poisoned| {
        crate::log("semantic_model recovered poisoned embedder lock");
        poisoned.into_inner()
    });
    if let Some(model) = slot.as_ref() {
        return Ok(model.clone());
    }
    use fastembed::{
        Bgem3Embedding, Bgem3InitOptions, Bgem3Model, EmbeddingModel, InitOptions, TextEmbedding,
    };
    let selected = active();
    let model_kind = match selected {
        SemanticModel::BgeSmallZhV15 => EmbeddingModel::BGESmallZHV15,
        SemanticModel::BgeLargeZhV15 => EmbeddingModel::BGELargeZHV15,
        SemanticModel::BgeM3 => EmbeddingModel::BGEM3,
        SemanticModel::MultilingualE5Small => EmbeddingModel::MultilingualE5Small,
    };
    let execution_providers = gpu::cuda_execution_providers();
    let model = if selected == SemanticModel::BgeM3 {
        let mut options = Bgem3InitOptions::new(Bgem3Model::BGEM3Q)
            .with_max_length(M3_MAX_INPUT_TOKENS)
            .with_show_download_progress(false)
            .with_execution_providers(execution_providers.clone());
        if let Some(dir) = model_dir() {
            let _ = std::fs::create_dir_all(&dir);
            options = options.with_cache_dir(dir);
        }
        SemanticEmbedder::M3(
            Bgem3Embedding::try_new(options)
                .map_err(|error| format!("加载 BGE-M3 模型失败：{error}"))?,
        )
    } else {
        let mut options = InitOptions::new(model_kind)
            .with_show_download_progress(false)
            .with_execution_providers(execution_providers);
        if let Some(dir) = model_dir() {
            let _ = std::fs::create_dir_all(&dir);
            options = options.with_cache_dir(dir);
        }
        SemanticEmbedder::Text(
            TextEmbedding::try_new(options)
                .map_err(|error| format!("加载语义模型失败：{error}"))?,
        )
    };
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
    if let Some(dir) = model_artifact_dir_for(active()) {
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

/// 切换模型时先把大对象从共享锁中原子取走，再在低优先级线程中析构。
/// ONNX 会话、逐书向量和全局 HNSW 可能占用数百 MB 到数 GB；直接在 Tauri
/// 命令线程中 `clear` 会让下拉框看起来卡住数秒。
fn detach_heavy_runtime_caches(state: &AppState) {
    let old_embedder = state
        .embedder
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let old_sem_cache = {
        let mut cache = state
            .sem_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *cache)
    };
    {
        let mut order = state
            .sem_cache_order
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.clear();
    }
    state
        .sem_cache_bytes
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let old_global_index = state
        .global_index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();

    if old_embedder.is_none() && old_sem_cache.is_empty() && old_global_index.is_none() {
        return;
    }
    std::thread::spawn(move || {
        crate::set_thread_background(true);
        drop((old_embedder, old_sem_cache, old_global_index));
        crate::set_thread_background(false);
    });
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

    detach_heavy_runtime_caches(state.inner());
    let m3_mode_disabled = retrieval::disable_m3_mode_for_non_m3();
    accelerator::mark_unprepared();
    clear_sem_query_cache();
    profile::detach_caches_in_background();
    accelerator::clear_snapshot_cache();
    clear_sem_status_cache();
    let mut progress = state.sem_progress.lock().unwrap();
    progress.current = format!(
        "已切换至 {}{}；正在检查本地模型和语义索引…",
        selected.label(),
        if m3_mode_disabled {
            "；已退出 M3 专属混合检索"
        } else {
            ""
        }
    );
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
        let execution_providers = gpu::strict_cuda_execution_providers();
        probe_write(if execution_providers.is_empty() {
            "starting with CPU..."
        } else {
            "starting with CUDA preference..."
        });
        let mut options = InitOptions::new(EmbeddingModel::BGESmallZHV15)
            .with_show_download_progress(false)
            .with_execution_providers(execution_providers);
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
        for model in [
            SemanticModel::BgeSmallZhV15,
            SemanticModel::BgeLargeZhV15,
            SemanticModel::BgeM3,
            SemanticModel::MultilingualE5Small,
        ] {
            assert_eq!(SemanticModel::from_id(model.id()), Some(model));
            assert!(!model.label().is_empty());
            assert!(!model.revision().is_empty());
            assert!(model.dimensions() > 0);
        }
        assert_eq!(SemanticModel::from_id("unknown"), None);
    }

    #[test]
    fn model_status_and_delete_are_scoped_to_the_selected_artifact() {
        let source = include_str!("model.rs");
        let available = source
            .split("pub(super) fn available")
            .nth(1)
            .and_then(|tail| tail.split("pub(super) fn embedder").next())
            .expect("model availability implementation");
        assert!(available.contains("model_artifact_dir_for(active())"));
        assert!(!available.contains("model_dir().as_deref()"));

        let delete = source
            .split("pub(super) fn delete")
            .nth(1)
            .and_then(|tail| tail.split("fn detach_heavy_runtime_caches").next())
            .expect("model delete implementation");
        assert!(delete.contains("model_artifact_dir_for(active())"));
    }

    #[test]
    fn bge_queries_use_retrieval_instruction() {
        assert!(query_input("天津教案").starts_with(SEM_QUERY_PREFIX));
    }

    #[test]
    fn multilingual_e5_uses_its_document_and_query_prefixes() {
        assert!(query_input_for(SemanticModel::MultilingualE5Small, "hello").starts_with("query: "));
        assert!(
            document_input_for(SemanticModel::MultilingualE5Small, "chapter")
                .starts_with("passage: ")
        );
    }

    #[test]
    fn model_switch_detaches_large_runtime_caches_before_background_drop() {
        let source = include_str!("model.rs");
        let start = source
            .find("fn detach_heavy_runtime_caches")
            .expect("cache detacher must exist");
        let end = start
            + source[start..]
                .find("/// 切换模型只清除内存运行态")
                .expect("model selection must follow the detacher");
        let implementation = &source[start..end];
        assert!(implementation.contains("std::mem::take"));
        assert!(implementation.contains("std::thread::spawn"));
        assert!(implementation.contains("drop((old_embedder, old_sem_cache, old_global_index))"));
    }
}
