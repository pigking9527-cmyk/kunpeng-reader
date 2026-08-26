//! Qwen3 本地向量与精排服务适配器。
//!
//! 模型由固定脚本下载、校验并通过 llama-server 仅监听 127.0.0.1。
//! 这里不接受任意 URL，也不会把图书正文发往外部服务。

use serde::Deserialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) const EMBEDDING_06_ID: &str = "qwen3-embedding-0.6b";
pub(super) const EMBEDDING_8_ID: &str = "qwen3-embedding-8b";
const EMBEDDING_06_ALIAS: &str = "Qwen3-Embedding-0.6B-Q8_0";
const EMBEDDING_8_ALIAS: &str = "Qwen3-Embedding-8B-Q4_K_M";
const RERANKER_06_ALIAS: &str = "Qwen3-Reranker-0.6B-Q8_0";
const RERANKER_06_FILE: &str = "Qwen3-Reranker-0.6B-Q8_0.gguf";
const RERANKER_06_BYTES: u64 = 639_153_184;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QwenEmbeddingModel {
    Embedding06,
    Embedding8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QwenServiceDevice {
    Cpu,
    Gpu,
    Unknown,
}

impl QwenEmbeddingModel {
    pub(super) const fn alias(self) -> &'static str {
        match self {
            Self::Embedding06 => EMBEDDING_06_ALIAS,
            Self::Embedding8 => EMBEDDING_8_ALIAS,
        }
    }

    pub(super) const fn dimensions(self) -> usize {
        match self {
            Self::Embedding06 => 1024,
            Self::Embedding8 => 4096,
        }
    }

    const fn port(self) -> u16 {
        match self {
            Self::Embedding06 => 8082,
            Self::Embedding8 => 8084,
        }
    }
}

pub(crate) struct QwenEmbeddingClient {
    model: QwenEmbeddingModel,
    device: QwenServiceDevice,
    agent: ureq::Agent,
}

impl QwenEmbeddingClient {
    pub(super) fn connect(model: QwenEmbeddingModel) -> Result<Self, String> {
        if !embedding_available(model) {
            return Err(format!(
                "{} 本地服务未启动，请先下载并准备搜索方案",
                model.alias()
            ));
        }
        let device = managed_service_device(model);
        match (super::device::active(), device) {
            (super::device::SemanticDevicePolicy::Gpu, QwenServiceDevice::Gpu)
            | (super::device::SemanticDevicePolicy::Cpu, QwenServiceDevice::Cpu)
            | (super::device::SemanticDevicePolicy::Auto, _) => {}
            (super::device::SemanticDevicePolicy::Gpu, _) => {
                return Err(format!(
                    "{} 当前不是 GPU 模式；已强制使用 GPU，请重新准备模型",
                    model.alias()
                ));
            }
            (super::device::SemanticDevicePolicy::Cpu, _) => {
                return Err(format!(
                    "{} 当前不是 CPU 模式；已强制使用 CPU，请重新准备模型",
                    model.alias()
                ));
            }
        }
        Ok(Self {
            model,
            device,
            agent: local_agent(Duration::from_secs(180)),
        })
    }

    pub(super) const fn runtime_device(&self) -> QwenServiceDevice {
        self.device
    }

    pub(crate) fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let endpoint = format!("http://127.0.0.1:{}/v1/embeddings", self.model.port());
        let response = self
            .agent
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .send_json(serde_json::json!({
                "model": self.model.alias(),
                "input": texts,
            }))
            .map_err(|error| format!("请求本地 Qwen3 Embedding 失败：{error}"))?;
        let body: EmbeddingResponse = response
            .into_body()
            .read_json()
            .map_err(|error| format!("解析本地 Qwen3 Embedding 响应失败：{error}"))?;
        let mut data = body.data;
        data.sort_by_key(|item| item.index);
        if data
            .iter()
            .any(|item| item.embedding.len() != self.model.dimensions())
        {
            return Err(format!(
                "{} 返回了错误的向量维度，预期 {} 维",
                self.model.alias(),
                self.model.dimensions()
            ));
        }
        Ok(data.into_iter().map(|item| item.embedding).collect())
    }
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelItem>,
}

#[derive(Deserialize)]
struct ModelItem {
    id: String,
}

#[derive(Deserialize)]
struct RerankResponse {
    results: Vec<RerankItem>,
}

#[derive(Deserialize)]
pub(super) struct RerankItem {
    pub(super) index: usize,
    pub(super) relevance_score: f32,
}

fn local_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(true)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_recv_response(Some(timeout))
        .timeout_recv_body(Some(timeout))
        .build()
        .into()
}

fn model_is_served(port: u16, alias: &str) -> bool {
    let endpoint = format!("http://127.0.0.1:{port}/v1/models");
    local_agent(Duration::from_secs(3))
        .get(&endpoint)
        .call()
        .ok()
        .and_then(|response| response.into_body().read_json::<ModelList>().ok())
        .is_some_and(|models| models.data.iter().any(|model| model.id == alias))
}

pub(super) fn embedding_available(model: QwenEmbeddingModel) -> bool {
    model_is_served(model.port(), model.alias())
}

pub(super) fn reranker_available() -> bool {
    model_is_served(8083, RERANKER_06_ALIAS)
}

pub(super) fn reranker_installed() -> bool {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| {
            root.join("kunpeng-reader")
                .join("local-llm")
                .join("models")
                .join(RERANKER_06_ALIAS)
                .join(RERANKER_06_FILE)
        })
        .and_then(|path| std::fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file() && metadata.len() == RERANKER_06_BYTES)
}

#[derive(Deserialize)]
struct ManagedServiceState {
    mode: String,
}

fn managed_service_device(model: QwenEmbeddingModel) -> QwenServiceDevice {
    let key = match model {
        QwenEmbeddingModel::Embedding06 => "embedding06",
        QwenEmbeddingModel::Embedding8 => "embedding8",
    };
    managed_service_device_by_key(key)
}

pub(super) fn service_device(model: QwenEmbeddingModel) -> QwenServiceDevice {
    if embedding_available(model) {
        managed_service_device(model)
    } else {
        QwenServiceDevice::Unknown
    }
}

fn managed_service_device_by_key(key: &str) -> QwenServiceDevice {
    let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return QwenServiceDevice::Unknown;
    };
    let state_path = root
        .join("kunpeng-reader")
        .join("local-llm")
        .join("services")
        .join(format!("intelligence-{key}"))
        .join("server-state.json");
    let Ok(bytes) = std::fs::read(state_path) else {
        return QwenServiceDevice::Unknown;
    };
    match serde_json::from_slice::<ManagedServiceState>(&bytes)
        .ok()
        .map(|state| state.mode.to_ascii_lowercase())
        .as_deref()
    {
        Some("cpu") => QwenServiceDevice::Cpu,
        Some("gpu") => QwenServiceDevice::Gpu,
        _ => QwenServiceDevice::Unknown,
    }
}

pub(super) fn rerank(query: &str, documents: &[String]) -> Result<Vec<RerankItem>, String> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let response = local_agent(Duration::from_secs(180))
        .post("http://127.0.0.1:8083/v1/rerank")
        .header("Content-Type", "application/json")
        .send_json(serde_json::json!({
            "model": RERANKER_06_ALIAS,
            "query": query,
            "documents": documents,
            "top_n": documents.len(),
        }))
        .map_err(|error| format!("请求本地 Qwen3 Reranker 失败：{error}"))?;
    response
        .into_body()
        .read_json::<RerankResponse>()
        .map(|body| body.results)
        .map_err(|error| format!("解析本地 Qwen3 Reranker 响应失败：{error}"))
}

fn runtime_script_path() -> Result<PathBuf, String> {
    let mut starts = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        for ancestor in start.ancestors().take(6) {
            let candidate = ancestor
                .join("scripts")
                .join("local-intelligence-retrieval-models.ps1");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("找不到固定的 Qwen3 本地检索运行脚本".into())
}

#[cfg(windows)]
fn invoke_runtime_action(
    action: &str,
    policy: super::device::SemanticDevicePolicy,
) -> Result<String, String> {
    let script = runtime_script_path()?;
    let mut command = Command::new("pwsh.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", action, "-DevicePolicy", policy.id()])
        // `StartCore`/`StartCalibration` use PowerShell `Start-Process` to
        // launch a long-lived llama-server. Captured stdout/stderr pipes can be
        // inherited by that grandchild, so `Command::output()` may wait for EOF
        // until the model service itself exits even though pwsh has completed.
        // The fixed manager writes its service diagnostics to local bounded log
        // files; this boundary therefore deliberately inherits no input and
        // captures no output from the process tree.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let status = command.status().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "本地 Qwen3 检索模型需要 PowerShell 7（pwsh.exe）".to_string()
        } else {
            "无法启动本地 Qwen3 检索模型管理器".to_string()
        }
    })?;
    if status.success() {
        Ok(String::new())
    } else {
        let exit_code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "异常终止".into());
        Err(format!(
            "本地 Qwen3 检索模型管理器执行失败（操作：{}，退出状态：{exit_code}）；请重新检测模型状态后重试",
            runtime_action_label(action)
        ))
    }
}

#[cfg(windows)]
fn runtime_action_label(action: &str) -> &'static str {
    match action {
        "InstallCore" => "准备标准模型",
        "StartCore" => "启动标准模型",
        "InstallCalibration" => "准备高精度模型",
        "StartCalibration" => "启动高精度模型",
        _ => "管理本地模型",
    }
}

#[cfg(not(windows))]
fn invoke_runtime_action(
    _action: &str,
    _policy: super::device::SemanticDevicePolicy,
) -> Result<String, String> {
    Err("Qwen3 本地检索模型自动管理目前仅支持 Windows".into())
}

pub(super) fn install_and_start(model: QwenEmbeddingModel) -> Result<(), String> {
    let policy = super::device::active();
    match model {
        QwenEmbeddingModel::Embedding06 => {
            invoke_runtime_action("InstallCore", policy)?;
            invoke_runtime_action("StartCore", policy)?;
        }
        QwenEmbeddingModel::Embedding8 => {
            invoke_runtime_action("InstallCalibration", policy)?;
            invoke_runtime_action("StartCalibration", policy)?;
        }
    }
    if embedding_available(model) {
        Ok(())
    } else {
        Err(format!("{} 启动后未通过本机接口校验", model.alias()))
    }
}

pub(super) fn ensure_reranker() -> Result<(), String> {
    let policy = super::device::active();
    let existing_matches = matches!(
        (policy, managed_service_device_by_key("reranker06")),
        (super::device::SemanticDevicePolicy::Auto, _)
            | (
                super::device::SemanticDevicePolicy::Gpu,
                QwenServiceDevice::Gpu
            )
            | (
                super::device::SemanticDevicePolicy::Cpu,
                QwenServiceDevice::Cpu
            )
    );
    if reranker_available() && existing_matches {
        return Ok(());
    }
    invoke_runtime_action("InstallCore", policy)?;
    invoke_runtime_action("StartCore", policy)?;
    if reranker_available() {
        Ok(())
    } else {
        Err("Qwen3 Reranker 0.6B 启动后未通过本机接口校验".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwen_embedding_profiles_have_stable_dimensions() {
        assert_eq!(QwenEmbeddingModel::Embedding06.dimensions(), 1024);
        assert_eq!(QwenEmbeddingModel::Embedding8.dimensions(), 4096);
        assert_ne!(EMBEDDING_06_ID, EMBEDDING_8_ID);
    }

    #[test]
    fn retrieval_runtime_script_is_repo_fixed() {
        let path = runtime_script_path().unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("local-intelligence-retrieval-models.ps1")
        );
        let source = std::fs::read_to_string(path).unwrap();
        assert!(source.contains("[ValidateSet('auto', 'gpu', 'cpu')]"));
        assert!(source.contains("function Start-ModelByPolicy"));
        assert!(source.contains("if ($Policy -eq 'cpu') { Start-Model $Definition cpu; return }"));
        assert!(source.contains("if ($Policy -eq 'gpu') { Start-Model $Definition gpu; return }"));
        assert!(source.contains("retrying CPU"));
    }

    #[cfg(windows)]
    #[test]
    fn runtime_manager_never_captures_long_lived_service_pipes() {
        let source = include_str!("qwen.rs");
        let start = source.find("fn invoke_runtime_action(").unwrap();
        let end = source[start..]
            .find("#[cfg(not(windows))]")
            .map(|offset| start + offset)
            .unwrap();
        let implementation = &source[start..end];
        assert!(implementation.contains(".stdin(Stdio::null())"));
        assert!(implementation.contains(".stdout(Stdio::null())"));
        assert!(implementation.contains(".stderr(Stdio::null())"));
        assert!(implementation.contains("command.status()"));
        assert!(!implementation.contains("command.output()"));
    }

    #[cfg(windows)]
    #[test]
    fn runtime_action_errors_use_bounded_safe_labels() {
        assert_eq!(runtime_action_label("InstallCore"), "准备标准模型");
        assert_eq!(runtime_action_label("StartCalibration"), "启动高精度模型");
        assert_eq!(
            runtime_action_label("unexpected-path-or-secret"),
            "管理本地模型"
        );
    }
}
