//! 语义模型选择、磁盘布局和运行时装载。
//!
//! BGE-M3 的稠密向量使用 BAAI 发布的非量化 ONNX：有可用 CUDA Provider 时
//! 优先 GPU，初始化失败则用同一份 FP32 图回退 CPU。稀疏/ColBERT 继续使用
//! FastEmbed 的联合 INT8 图并固定在 CPU，避免把 CPU 量化算子误交给 CUDA。

use super::{
    accelerator, clear_sem_query_cache, clear_sem_status_cache, device, gpu, m3, profile,
    retrieval, solution,
};
use crate::semantic_core::cosine;
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::AppState;
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard};
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
    Qwen3Embedding06,
    Qwen3Embedding8,
    BgeSmallZhV15,
    BgeLargeZhV15,
    BgeM3,
    MultilingualE5Small,
}

/// 统一两类 FastEmbed 运行时。BGE-M3 不能只走 TextEmbedding：它的同一次
/// 推理还会给出稀疏词权重与 ColBERT token 向量，供混合检索使用。
pub(crate) enum SemanticEmbedder {
    Text(Box<fastembed::TextEmbedding>),
    Qwen(super::qwen::QwenEmbeddingClient),
    M3 {
        dense: Box<fastembed::TextEmbedding>,
        joint: Box<fastembed::Bgem3Embedding>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum SemanticRuntimeDevice {
    #[default]
    NotLoaded,
    Cpu,
    Cuda,
    /// 由仅监听 127.0.0.1 的受管 llama-server 提供；具体 CPU/GPU 模式
    /// 由本地运行控制器决定。
    LocalService,
    LocalServiceCpu,
    LocalServiceCuda,
    /// BGE-M3 稠密向量走 CUDA；稀疏与 ColBERT 联合图固定走 CPU。
    CudaDenseCpuJoint,
}

impl SemanticRuntimeDevice {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::NotLoaded => "not_loaded",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::LocalService => "local_service",
            Self::LocalServiceCpu => "cpu",
            Self::LocalServiceCuda => "cuda",
            Self::CudaDenseCpuJoint => "cuda_dense_cpu_joint",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::NotLoaded => "尚未加载",
            Self::Cpu => "CPU",
            Self::Cuda => "NVIDIA GPU",
            Self::LocalService => "本机 Qwen 服务",
            Self::LocalServiceCpu => "本机 Qwen 服务（CPU）",
            Self::LocalServiceCuda => "本机 Qwen 服务（NVIDIA GPU）",
            Self::CudaDenseCpuJoint => "NVIDIA GPU（稠密）+ CPU（M3 增强）",
        }
    }

    pub(super) const fn actual_id(self) -> &'static str {
        match self {
            Self::NotLoaded => "not_loaded",
            Self::Cpu | Self::LocalServiceCpu => "cpu",
            Self::Cuda | Self::LocalServiceCuda => "gpu",
            Self::LocalService => "local_service",
            Self::CudaDenseCpuJoint => "mixed",
        }
    }
}

fn runtime_device_slot() -> &'static Mutex<SemanticRuntimeDevice> {
    static SLOT: OnceLock<Mutex<SemanticRuntimeDevice>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(SemanticRuntimeDevice::NotLoaded))
}

pub(super) fn runtime_device() -> SemanticRuntimeDevice {
    *runtime_device_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn effective_runtime_device() -> SemanticRuntimeDevice {
    let loaded = runtime_device();
    if loaded != SemanticRuntimeDevice::NotLoaded {
        return loaded;
    }
    let qwen_model = match active() {
        SemanticModel::Qwen3Embedding06 => Some(super::qwen::QwenEmbeddingModel::Embedding06),
        SemanticModel::Qwen3Embedding8 => Some(super::qwen::QwenEmbeddingModel::Embedding8),
        _ => None,
    };
    match qwen_model.map(super::qwen::service_device) {
        Some(super::qwen::QwenServiceDevice::Cpu) => SemanticRuntimeDevice::LocalServiceCpu,
        Some(super::qwen::QwenServiceDevice::Gpu) => SemanticRuntimeDevice::LocalServiceCuda,
        Some(super::qwen::QwenServiceDevice::Unknown) | None => loaded,
    }
}

fn set_runtime_device(device: SemanticRuntimeDevice) {
    *runtime_device_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = device;
}

impl SemanticEmbedder {
    pub(crate) fn embed_dense(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        match self {
            Self::Text(model) => model.embed(texts, None).map_err(|error| error.to_string()),
            Self::Qwen(model) => model.embed(texts),
            Self::M3 { dense, .. } => dense.embed(texts, None).map_err(|error| error.to_string()),
        }
    }

    pub(crate) fn embed_m3(
        &mut self,
        texts: Vec<String>,
    ) -> Result<fastembed::Bgem3EmbeddingOutput, String> {
        match self {
            Self::M3 { joint, .. } => joint.embed(texts, None).map_err(|error| error.to_string()),
            Self::Text(_) | Self::Qwen(_) => {
                Err("当前模型不提供 BGE-M3 稀疏向量或 ColBERT 输出".into())
            }
        }
    }
}

impl SemanticModel {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Qwen3Embedding06 => super::qwen::EMBEDDING_06_ID,
            Self::Qwen3Embedding8 => super::qwen::EMBEDDING_8_ID,
            Self::BgeSmallZhV15 => DEFAULT_SEM_MODEL,
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5",
            Self::BgeM3 => "bge-m3",
            Self::MultilingualE5Small => "multilingual-e5-small",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Qwen3Embedding06 => "Qwen3 Embedding 0.6B（轻量）",
            Self::Qwen3Embedding8 => "Qwen3 Embedding 8B（高精度）",
            Self::BgeSmallZhV15 => "BGE Small 中文（默认，轻量）",
            Self::BgeLargeZhV15 => "BGE Large 中文（高精度）",
            Self::BgeM3 => "BGE-M3（GPU 优先、CPU 兼容）",
            Self::MultilingualE5Small => "Multilingual-E5-Small（多语言，轻量）",
        }
    }

    /// FastEmbed 的模型导出或池化约定改变时，必须更新该值，避免旧向量被
    /// 静默混用。
    pub(super) const fn revision(self) -> &'static str {
        match self {
            Self::Qwen3Embedding06 => "qwen3-embedding-0.6b-q8_0-llama-b10549-v1",
            Self::Qwen3Embedding8 => "qwen3-embedding-8b-q4_k_m-llama-b10549-v1",
            Self::BgeSmallZhV15 => "bge-small-zh-v1.5-fastembed-v1",
            Self::BgeLargeZhV15 => "bge-large-zh-v1.5-fastembed-v1",
            // v2 的稠密向量来自 BAAI FP32 图，不得与旧 BGEM3Q INT8 稠密
            // 向量混用。CPU/GPU 使用同一图、同一池化，因此设备切换不要求
            // 再次重建；稀疏/ColBERT 仍沿用 joint-v1。
            Self::BgeM3 => "bge-m3-baai-fp32-dense-v2+fastembed-joint-v1",
            Self::MultilingualE5Small => "multilingual-e5-small-fastembed-v1",
        }
    }

    pub(super) const fn dimensions(self) -> usize {
        match self {
            Self::Qwen3Embedding06 => 1024,
            Self::Qwen3Embedding8 => 4096,
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
            super::qwen::EMBEDDING_06_ID => Some(Self::Qwen3Embedding06),
            super::qwen::EMBEDDING_8_ID => Some(Self::Qwen3Embedding8),
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

/// 只在模型下载期间读取当前模型缓存目录的文件大小，用于向界面显示文本进度。
/// 这不是已安装模型的精确占用统计：下载结束后状态页仍避免展示混有旧缓存的
/// 容量，防止用户误把历史模型文件当成当前模型的一部分。
pub(super) fn downloaded_bytes() -> u64 {
    fn tree_bytes(path: &std::path::Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(path) else {
            return 0;
        };
        entries.flatten().fold(0u64, |total, entry| {
            let bytes = entry
                .metadata()
                .ok()
                .map(|metadata| {
                    if metadata.is_dir() {
                        tree_bytes(&entry.path())
                    } else if metadata.is_file() {
                        metadata.len()
                    } else {
                        0
                    }
                })
                .unwrap_or(0);
            total.saturating_add(bytes)
        })
    }

    match active() {
        // Qwen3 检索权重由受控的本机运行时脚本维护，不在旧 ONNX 模型目录。
        // 只读取当前 embedding 文件，避免把同批准备的 reranker 误算进语义模型
        // 的 610 MB 下载进度。
        SemanticModel::Qwen3Embedding06 => qwen_downloaded_bytes(
            "Qwen3-Embedding-0.6B-Q8_0",
            "Qwen3-Embedding-0.6B-Q8_0.gguf",
        ),
        SemanticModel::Qwen3Embedding8 => qwen_downloaded_bytes(
            "Qwen3-Embedding-8B-Q4_K_M",
            "Qwen3-Embedding-8B-Q4_K_M.gguf",
        ),
        _ => model_dir().map_or(0, |path| tree_bytes(&path)),
    }
}

fn qwen_downloaded_bytes(alias: &str, file: &str) -> u64 {
    let Ok(local_app_data) = std::env::var("LOCALAPPDATA") else {
        return 0;
    };
    std::path::Path::new(&local_app_data)
        .join("kunpeng-reader")
        .join("local-llm")
        .join("models")
        .join(alias)
        .join(file)
        .metadata()
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn model_dir_for(selected: SemanticModel) -> Option<std::path::PathBuf> {
    let mut dir = crate::profile::app_cache_dir()?;
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
    let mut path = crate::profile::app_config_dir().or_else(crate::profile::app_cache_dir)?;
    path.push("semantic-model.txt");
    Some(path)
}

fn selected_slot() -> &'static Mutex<SemanticModel> {
    static SLOT: OnceLock<Mutex<SemanticModel>> = OnceLock::new();
    SLOT.get_or_init(|| {
        let model = solution::load()
            .and_then(|solution| SemanticModel::from_id(&solution.committed_model))
            .or_else(|| {
                selection_path()
                    .and_then(|path| std::fs::read_to_string(path).ok())
                    .and_then(|id| SemanticModel::from_id(id.trim()))
            })
            // 已移除模型的旧选择会安全回退到默认轻量模型。
            .unwrap_or(SemanticModel::BgeSmallZhV15);
        Mutex::new(model)
    })
}

/// 方案提交只在建库完成时短暂取得写锁；一次检索从查询向量编码到读取逐书/
/// 全局索引都持有读锁。这样切换不会出现“新模型 id + 旧 embedder/索引”的
/// 瞬时混槽，已经开始的检索仍完整使用旧 committed 方案。
fn runtime_transition_lock() -> &'static RwLock<()> {
    static LOCK: OnceLock<RwLock<()>> = OnceLock::new();
    LOCK.get_or_init(|| RwLock::new(()))
}

pub(super) fn runtime_read_guard() -> RwLockReadGuard<'static, ()> {
    runtime_transition_lock()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

fn persist_legacy_selection(selected: SemanticModel) -> Result<(), String> {
    let path = selection_path().ok_or("无法确定模型设置路径")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("保存模型设置失败：{error}"))?;
    }
    crate::atomic_file::write(&path, selected.id().as_bytes())
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
        SemanticModel::Qwen3Embedding06 | SemanticModel::Qwen3Embedding8 => format!(
            "Instruct: Given a search query, retrieve relevant passages from a multilingual local library.\nQuery: {query}"
        ),
        SemanticModel::MultilingualE5Small => format!("query: {query}"),
        _ => format!("{SEM_QUERY_PREFIX}{query}"),
    }
}

/// E5 以 query/passage 前缀训练；省略 passage 会显著降低跨语言检索质量。
pub(super) fn document_input(text: &str) -> String {
    document_input_for(active(), text)
}

pub(super) fn document_input_for(selected: SemanticModel, text: &str) -> String {
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

fn find_file_named(path: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_dir() {
            if let Some(found) = find_file_named(&candidate, name) {
                return Some(found);
            }
        } else if candidate
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == name)
        {
            return Some(candidate);
        }
    }
    None
}

fn tokenizer_files_present(snapshot: &std::path::Path) -> bool {
    [
        "tokenizer.json",
        "config.json",
        "special_tokens_map.json",
        "tokenizer_config.json",
    ]
    .iter()
    .all(|name| snapshot.join(name).is_file())
}

/// BGE-M3 的可用性必须同时覆盖主稠密图和 M3 联合增强图。两者来自不同
/// Hugging Face 仓库；只看到任意一个 ONNX 文件不能宣称整个模型已就绪。
fn bge_m3_artifacts_ready(base: &std::path::Path) -> bool {
    let dense_graph = find_file_named(base, "model.onnx").filter(|path| {
        path.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some("onnx")
    });
    let dense_ready = dense_graph.is_some_and(|graph| {
        let Some(onnx_dir) = graph.parent() else {
            return false;
        };
        let Some(snapshot) = onnx_dir.parent() else {
            return false;
        };
        onnx_dir.join("model.onnx_data").is_file()
            && onnx_dir.join("Constant_7_attr__value").is_file()
            && tokenizer_files_present(snapshot)
    });

    let joint_ready = find_file_named(base, "model_quantized.onnx")
        .is_some_and(|graph| graph.parent().is_some_and(tokenizer_files_present));
    dense_ready && joint_ready
}

/// 只检查本地状态，不等待模型下载互斥锁，也不触发联网下载。
pub(super) fn available(state: &AppState) -> bool {
    state
        .embedder
        .try_lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
        || if active() == SemanticModel::Qwen3Embedding06 {
            super::qwen::embedding_available(super::qwen::QwenEmbeddingModel::Embedding06)
        } else if active() == SemanticModel::Qwen3Embedding8 {
            super::qwen::embedding_available(super::qwen::QwenEmbeddingModel::Embedding8)
        } else if active() == SemanticModel::BgeM3 {
            model_dir().is_some_and(|path| bge_m3_artifacts_ready(&path))
        } else {
            model_artifact_dir_for(active()).is_some()
        }
}

fn create_text_embedding(
    selected: SemanticModel,
    model_kind: fastembed::EmbeddingModel,
    execution_providers: Vec<fastembed::ExecutionProviderDispatch>,
) -> Result<fastembed::TextEmbedding, String> {
    use fastembed::{InitOptions, TextEmbedding};
    let mut options = InitOptions::new(model_kind)
        .with_show_download_progress(false)
        .with_execution_providers(execution_providers);
    if let Some(dir) = model_dir_for(selected) {
        let _ = std::fs::create_dir_all(&dir);
        options = options.with_cache_dir(dir);
    }
    TextEmbedding::try_new(options).map_err(|error| error.to_string())
}

fn create_text_embedding_with_cpu_fallback(
    selected: SemanticModel,
    model_kind: fastembed::EmbeddingModel,
) -> Result<(fastembed::TextEmbedding, SemanticRuntimeDevice), String> {
    match device::active() {
        device::SemanticDevicePolicy::Cpu => {
            create_text_embedding(selected, model_kind, Vec::new())
                .map(|model| (model, SemanticRuntimeDevice::Cpu))
        }
        device::SemanticDevicePolicy::Gpu => {
            let cuda = gpu::strict_cuda_execution_providers();
            if cuda.is_empty() {
                return Err("已强制使用 NVIDIA GPU，但 CUDA Provider、驱动或运行组件不可用".into());
            }
            create_text_embedding(selected, model_kind, cuda)
                .map(|model| (model, SemanticRuntimeDevice::Cuda))
                .map_err(|error| format!("已强制使用 NVIDIA GPU，CUDA 模型初始化失败：{error}"))
        }
        device::SemanticDevicePolicy::Auto => {
            let cuda = gpu::strict_cuda_execution_providers();
            if !cuda.is_empty() {
                match create_text_embedding(selected, model_kind.clone(), cuda) {
                    Ok(model) => return Ok((model, SemanticRuntimeDevice::Cuda)),
                    Err(error) => crate::log(&format!(
                        "semantic_model cuda_init_failed model={} policy=auto fallback=cpu error={error}",
                        selected.id()
                    )),
                }
            }
            create_text_embedding(selected, model_kind, Vec::new())
                .map(|model| (model, SemanticRuntimeDevice::Cpu))
        }
    }
}

fn create_m3_joint_cpu() -> Result<fastembed::Bgem3Embedding, String> {
    use fastembed::{Bgem3Embedding, Bgem3InitOptions, Bgem3Model};
    // FastEmbed 明确说明 BGEM3Q 是 CPU 优化的动态 INT8 图，传入 CUDA EP
    // 会失败。它只负责稀疏/ColBERT 增强；持久稠密向量由 FP32 主图生成。
    let mut options = Bgem3InitOptions::new(Bgem3Model::BGEM3Q)
        .with_max_length(M3_MAX_INPUT_TOKENS)
        .with_show_download_progress(false)
        .with_execution_providers(Vec::new());
    if let Some(dir) = model_dir_for(SemanticModel::BgeM3) {
        let _ = std::fs::create_dir_all(&dir);
        options = options.with_cache_dir(dir);
    }
    Bgem3Embedding::try_new(options).map_err(|error| error.to_string())
}

fn load_embedder_for(
    selected: SemanticModel,
) -> Result<(SemanticEmbedder, SemanticRuntimeDevice), String> {
    use fastembed::EmbeddingModel;
    if matches!(
        selected,
        SemanticModel::Qwen3Embedding06 | SemanticModel::Qwen3Embedding8
    ) {
        let qwen_model = if selected == SemanticModel::Qwen3Embedding06 {
            super::qwen::QwenEmbeddingModel::Embedding06
        } else {
            super::qwen::QwenEmbeddingModel::Embedding8
        };
        let client = super::qwen::QwenEmbeddingClient::connect(qwen_model)?;
        let runtime_device = match client.runtime_device() {
            super::qwen::QwenServiceDevice::Cpu => SemanticRuntimeDevice::LocalServiceCpu,
            super::qwen::QwenServiceDevice::Gpu => SemanticRuntimeDevice::LocalServiceCuda,
            super::qwen::QwenServiceDevice::Unknown => SemanticRuntimeDevice::LocalService,
        };
        return Ok((SemanticEmbedder::Qwen(client), runtime_device));
    }
    let model_kind = match selected {
        SemanticModel::Qwen3Embedding06 | SemanticModel::Qwen3Embedding8 => unreachable!(),
        SemanticModel::BgeSmallZhV15 => EmbeddingModel::BGESmallZHV15,
        SemanticModel::BgeLargeZhV15 => EmbeddingModel::BGELargeZHV15,
        SemanticModel::BgeM3 => EmbeddingModel::BGEM3,
        SemanticModel::MultilingualE5Small => EmbeddingModel::MultilingualE5Small,
    };
    let (model, runtime_device) = if selected == SemanticModel::BgeM3 {
        let (dense, dense_device) =
            create_text_embedding_with_cpu_fallback(selected, EmbeddingModel::BGEM3)
                .map_err(|error| format!("加载 BGE-M3 稠密模型失败：{error}"))?;
        let joint = create_m3_joint_cpu()
            .map_err(|error| format!("加载 BGE-M3 混合检索模型失败：{error}"))?;
        let device = if dense_device == SemanticRuntimeDevice::Cuda {
            SemanticRuntimeDevice::CudaDenseCpuJoint
        } else {
            SemanticRuntimeDevice::Cpu
        };
        (
            SemanticEmbedder::M3 {
                dense: Box::new(dense),
                joint: Box::new(joint),
            },
            device,
        )
    } else {
        let (model, device) = create_text_embedding_with_cpu_fallback(selected, model_kind)
            .map_err(|error| format!("加载语义模型失败：{error}"))?;
        (SemanticEmbedder::Text(Box::new(model)), device)
    };
    Ok((model, runtime_device))
}

/// 为 pending 方案创建独立运行时。它不会写入 AppState 的 committed embedder
/// 槽，也不会改变状态页的实际设备；失败时搜索仍继续使用旧模型。
pub(super) fn prepare_pending_embedder(
    selected: SemanticModel,
) -> Result<(Arc<Mutex<SemanticEmbedder>>, SemanticRuntimeDevice), String> {
    match selected {
        SemanticModel::Qwen3Embedding06 => {
            super::qwen::install_and_start(super::qwen::QwenEmbeddingModel::Embedding06)?;
        }
        SemanticModel::Qwen3Embedding8 => {
            super::qwen::install_and_start(super::qwen::QwenEmbeddingModel::Embedding8)?;
        }
        _ => {}
    }
    let (model, device) = load_embedder_for(selected)?;
    Ok((Arc::new(Mutex::new(model)), device))
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
    let selected = active();
    let (model, runtime_device) = load_embedder_for(selected)?;
    let model = Arc::new(Mutex::new(model));
    *slot = Some(model.clone());
    set_runtime_device(runtime_device);
    crate::log(&format!(
        "semantic_model loaded model={} revision={} device={}",
        selected.id(),
        selected.revision(),
        runtime_device.id()
    ));
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
        let selected = active();
        let preparation = match selected {
            SemanticModel::Qwen3Embedding06 => {
                super::qwen::install_and_start(super::qwen::QwenEmbeddingModel::Embedding06)
            }
            SemanticModel::Qwen3Embedding8 => {
                super::qwen::install_and_start(super::qwen::QwenEmbeddingModel::Embedding8)
            }
            _ => Ok(()),
        };
        if let Err(error) = preparation {
            finish_semantic_task(state.inner(), "语义模型未就绪", Some(error.clone()));
            let _ = task.fail(error);
            return;
        }
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
    if matches!(
        active(),
        SemanticModel::Qwen3Embedding06 | SemanticModel::Qwen3Embedding8
    ) {
        return Err(
            "Qwen3 向量模型与情报中心共用；请在高级模型管理中统一清理，避免中断情报处理".into(),
        );
    }
    *state.embedder.lock().unwrap() = None;
    set_runtime_device(SemanticRuntimeDevice::NotLoaded);
    accelerator::mark_unprepared();
    if !matches!(
        active(),
        SemanticModel::Qwen3Embedding06 | SemanticModel::Qwen3Embedding8
    ) {
        if let Some(dir) = model_artifact_dir_for(active()) {
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|error| format!("删除模型失败：{error}"))?;
            }
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
    set_runtime_device(SemanticRuntimeDevice::NotLoaded);
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

pub(super) fn reset_runtime_for_device_policy(state: &AppState) {
    let old_reranker = state
        .reranker
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    detach_heavy_runtime_caches(state);
    if let Some(old_reranker) = old_reranker {
        std::thread::spawn(move || {
            crate::set_thread_background(true);
            drop(old_reranker);
            crate::set_thread_background(false);
        });
    }
}

/// 把模型和检索模式作为一个智能搜索方案提交。磁盘向量仍按模型 id/revision
/// 隔离保留；提交成功前不改变任何进程内运行态。
fn validate_solution(
    model_id: &str,
    retrieval_mode: &str,
) -> Result<(SemanticModel, retrieval::RetrievalMode), String> {
    let selected = SemanticModel::from_id(model_id.trim()).ok_or("未知的语义模型")?;
    let mode = retrieval::RetrievalMode::from_id(retrieval_mode).ok_or("未知的检索策略")?;
    if mode == retrieval::RetrievalMode::M3Hybrid && selected != SemanticModel::BgeM3 {
        return Err("实验性 M3 混合检索只能与 BGE-M3 模型组成方案".into());
    }
    Ok((selected, mode))
}

fn activate_solution_runtime(
    state: &AppState,
    selected: SemanticModel,
    mode: retrieval::RetrievalMode,
) {
    let previous_model = active();
    let previous_mode = retrieval::active_mode();
    *selected_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = selected;
    retrieval::commit_mode_in_memory(mode);

    if selected != previous_model {
        detach_heavy_runtime_caches(state);
        m3::clear_memory_cache();
        accelerator::mark_unprepared();
        profile::detach_caches_in_background();
        accelerator::clear_snapshot_cache();
        clear_sem_status_cache();
    }
    if selected != previous_model || mode != previous_mode {
        clear_sem_query_cache();
    }
}

pub(super) fn promote_pending_runtime(
    state: &AppState,
    selected: SemanticModel,
    mode: retrieval::RetrievalMode,
    prepared: Option<(Arc<Mutex<SemanticEmbedder>>, SemanticRuntimeDevice)>,
) {
    let _transition = runtime_transition_lock()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = persist_legacy_selection(selected) {
        crate::log(&format!(
            "semantic_solution legacy_model_mirror_failed error={error}"
        ));
    }
    if let Err(error) = retrieval::persist_legacy_mode(mode) {
        crate::log(&format!(
            "semantic_solution legacy_mode_mirror_failed error={error}"
        ));
    }
    activate_solution_runtime(state, selected, mode);
    if let Some((embedder, device)) = prepared {
        *state
            .embedder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(embedder);
        set_runtime_device(device);
    }
}

pub(super) async fn request_solution(
    app: tauri::AppHandle,
    model_id: &str,
    retrieval_mode: &str,
) -> Result<(), String> {
    let (selected, mode) = validate_solution(model_id, retrieval_mode)?;
    if let Some((pending_model, pending_mode)) = solution::pending() {
        let pending_label = SemanticModel::from_id(&pending_model)
            .map(|model| model.label())
            .unwrap_or(pending_model.as_str());
        if pending_model == selected.id() && pending_mode == mode.id() {
            return Err(format!("{pending_label} 新搜索库正在后台建立，请等待完成"));
        }
        return Err(format!(
            "{pending_label} 新搜索库正在后台建立；旧搜索库仍可使用，请等待完成或失败后再切换"
        ));
    }
    if selected == active() {
        let state = app.state::<AppState>();
        return select_solution(state.inner(), selected.id(), mode.id());
    }
    super::build::build_pending_solution(app, selected, mode).await
}

pub(super) fn select_solution(
    state: &AppState,
    model_id: &str,
    retrieval_mode: &str,
) -> Result<(), String> {
    let (selected, mode) = validate_solution(model_id, retrieval_mode)?;
    let _transaction = solution::transaction_guard();
    {
        let progress = state.sem_progress.lock().unwrap();
        if progress.building || progress.model_downloading {
            return Err("模型下载或索引任务正在运行，请完成后再切换智能搜索方案".into());
        }
    }
    let model_changed = selected != active();
    // 单个 JSON 原子替换是唯一提交点。旧的两个文本文件只做兼容镜像；镜像
    // 失败不会让下次启动回到一个半新半旧的组合。
    solution::commit(selected.id(), mode.id())?;
    promote_pending_runtime(state, selected, mode, None);
    let mut progress = state.sem_progress.lock().unwrap();
    progress.current = format!(
        "已提交智能搜索方案：{}；{}{}",
        selected.label(),
        mode.label(),
        if model_changed {
            "；正在检查本地模型和对应语义索引…"
        } else {
            ""
        }
    );
    progress.error.clear();
    Ok(())
}

/// 兼容旧前端的单独模型命令。离开 BGE-M3 时沿用原有的自动退出专属模式
/// 行为；新前端应直接调用 `select_semantic_solution`。
pub(super) fn select(state: tauri::State<AppState>, model_id: String) -> Result<(), String> {
    let selected = SemanticModel::from_id(model_id.trim()).ok_or("未知的语义模型")?;
    let mut mode = retrieval::active_mode();
    if selected != SemanticModel::BgeM3 && mode == retrieval::RetrievalMode::M3Hybrid {
        mode = retrieval::RetrievalMode::Standard;
    }
    select_solution(state.inner(), selected.id(), mode.id())
}

fn probe_file() -> std::path::PathBuf {
    let mut dir = crate::profile::app_cache_dir().unwrap_or_else(std::env::temp_dir);
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
    use fastembed::EmbeddingModel;
    let _ = std::fs::remove_file(probe_file());
    std::panic::set_hook(Box::new(|info| probe_write(&format!("PANIC: {info}"))));
    let run = std::panic::catch_unwind(|| {
        let (mut model, runtime_device) = create_text_embedding_with_cpu_fallback(
            SemanticModel::BgeSmallZhV15,
            EmbeddingModel::BGESmallZHV15,
        )
        .map_err(|error| format!("MODEL ERR: {error}"))?;
        probe_write(&format!(
            "starting with policy={} actual={}...",
            device::active().id(),
            runtime_device.id()
        ));
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
            SemanticModel::Qwen3Embedding06,
            SemanticModel::Qwen3Embedding8,
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
        assert!(
            SemanticModel::BgeM3
                .revision()
                .contains("baai-fp32-dense-v2"),
            "GPU/CPU 共用的 FP32 稠密图必须使用新 revision，避免混入旧 INT8 向量"
        );
    }

    #[test]
    fn semantic_solution_validates_the_pair_before_commit() {
        assert_eq!(
            validate_solution("bge-m3", "m3_hybrid"),
            Ok((SemanticModel::BgeM3, retrieval::RetrievalMode::M3Hybrid))
        );
        assert_eq!(
            validate_solution(super::super::qwen::EMBEDDING_06_ID, "high_precision"),
            Ok((
                SemanticModel::Qwen3Embedding06,
                retrieval::RetrievalMode::HighPrecision
            ))
        );
        assert!(validate_solution("bge-small-zh-v1.5", "m3_hybrid")
            .unwrap_err()
            .contains("只能与 BGE-M3"));
        assert_eq!(
            validate_solution("unknown", "standard").unwrap_err(),
            "未知的语义模型"
        );
        assert_eq!(
            validate_solution("bge-m3", "unknown").unwrap_err(),
            "未知的检索策略"
        );
    }

    #[test]
    fn bge_m3_readiness_requires_dense_joint_and_both_tokenizers() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-bge-m3-artifacts-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let dense_snapshot = root.join("models--BAAI--bge-m3/snapshots/test");
        let joint_snapshot = root.join("models--gpahal--bge-m3-onnx-int8/snapshots/test");
        std::fs::create_dir_all(dense_snapshot.join("onnx")).unwrap();
        std::fs::create_dir_all(&joint_snapshot).unwrap();
        for snapshot in [&dense_snapshot, &joint_snapshot] {
            for name in [
                "tokenizer.json",
                "config.json",
                "special_tokens_map.json",
                "tokenizer_config.json",
            ] {
                std::fs::write(snapshot.join(name), b"ready").unwrap();
            }
        }
        for name in ["model.onnx", "model.onnx_data", "Constant_7_attr__value"] {
            std::fs::write(dense_snapshot.join("onnx").join(name), b"ready").unwrap();
        }
        assert!(!bge_m3_artifacts_ready(&root));
        std::fs::write(joint_snapshot.join("model_quantized.onnx"), b"ready").unwrap();
        assert!(bge_m3_artifacts_ready(&root));
        std::fs::remove_file(dense_snapshot.join("onnx/model.onnx_data")).unwrap();
        assert!(!bge_m3_artifacts_ready(&root));
        let _ = std::fs::remove_dir_all(root);
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
        assert!(
            query_input_for(SemanticModel::BgeSmallZhV15, "天津教案").starts_with(SEM_QUERY_PREFIX)
        );
        assert!(query_input_for(SemanticModel::BgeM3, "天津教案").starts_with(SEM_QUERY_PREFIX));
        assert!(
            query_input_for(SemanticModel::Qwen3Embedding06, "天津教案").starts_with("Instruct:")
        );
        assert!(query_input_for(SemanticModel::Qwen3Embedding8, "天津教案")
            .contains("\nQuery: 天津教案"));
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
