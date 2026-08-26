//! MiniMax-H3 本地伴读运行边界。
//!
//! 权重、推理服务和结果都只允许位于本机。桌面端只调用固定回环地址，
//! 不接受远程端点，也不包含 API Key、区域或云端回退路径。

use crate::{atomic_file, profile};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MODEL_ID: &str = "MiniMaxAI/MiniMax-H3";
const LOCAL_BASE_URL: &str = "http://127.0.0.1:8095";
const COMPANION_SETTINGS_FILE: &str = "reader-companion-settings-v1.json";
const MAX_BOOK_ID_LEN: usize = 256;
const MAX_STYLE_PROMPT_LEN: usize = 2_000;
const MAX_NEGATIVE_PROMPT_LEN: usize = 2_000;
const MAX_CHARACTER_NOTES_LEN: usize = 8_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntelligenceRuntimeSnapshot {
    phase: String,
    healthy: bool,
}

#[derive(Clone, Debug)]
struct ReaderMediaGenerationLease {
    cycle_id: String,
    previous_phase: String,
    h3_started_by_cycle: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaGenerationCycle {
    pub cycle_id: String,
    pub previous_phase: String,
    pub h3_started_by_cycle: bool,
    pub runtime_ready: bool,
    pub message: String,
}

static GENERATION_CYCLE: OnceLock<Mutex<Option<ReaderMediaGenerationLease>>> = OnceLock::new();

fn generation_cycle() -> &'static Mutex<Option<ReaderMediaGenerationLease>> {
    GENERATION_CYCLE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaStatus {
    pub configured: bool,
    pub model_ready: bool,
    pub runtime_ready: bool,
    pub hardware_supported: bool,
    pub model_id: String,
    pub runtime_device: String,
    pub total_ram_mib: u64,
    pub required_ram_mib: u64,
    pub total_vram_mib: u64,
    pub required_vram_mib: u64,
    #[serde(default)]
    pub available_disk_mib: u64,
    #[serde(default)]
    pub required_disk_mib: u64,
    #[serde(default)]
    pub installation_state: String,
    #[serde(default)]
    pub installation_step: String,
    #[serde(default)]
    pub installation_root: String,
    #[serde(default)]
    pub selected_preset: String,
    pub message: String,
}

/// A user-selected, local ComfyUI API workflow for the quantized H3 route.
/// The paths stay local and are intentionally not part of sync settings.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderMediaComfyUiConfig {
    pub comfy_ui_root: String,
    pub workflow_path: String,
    #[serde(default)]
    pub python_path: String,
    #[serde(default)]
    pub endpoint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderMediaImageRequest {
    pub prompt: String,
    #[serde(default = "default_image_ratio")]
    pub aspect_ratio: String,
    #[serde(default = "default_one")]
    pub n: u8,
    #[serde(default = "default_true")]
    pub prompt_optimizer: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaCachedAsset {
    pub absolute_path: String,
    pub cache_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaImageResult {
    pub request_id: Option<String>,
    pub images: Vec<ReaderMediaCachedAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderMediaVideoRequest {
    pub prompt: String,
    #[serde(default = "default_video_resolution")]
    pub resolution: String,
    #[serde(default = "default_video_duration")]
    pub duration: u8,
    #[serde(default = "default_video_ratio")]
    pub ratio: String,
    #[serde(default)]
    pub first_frame_image: Option<String>,
    #[serde(default)]
    pub last_frame_image: Option<String>,
    #[serde(default)]
    pub reference_images: Vec<String>,
    #[serde(default)]
    pub reference_videos: Vec<String>,
    #[serde(default)]
    pub reference_audios: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaVideoCreated {
    pub task_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderMediaVideoStatus {
    pub task_id: String,
    pub status: String,
    pub absolute_path: Option<String>,
    pub cache_key: Option<String>,
    pub message: String,
}

/// Per-book visual guidance for Companion. This is deliberately a local
/// configuration file: it is never included in sync entities or sent to a
/// media service by this module.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderCompanionSettings {
    pub book_id: String,
    #[serde(default)]
    pub style_prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default)]
    pub character_notes: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReaderCompanionSettingsFile {
    version: u8,
    #[serde(default)]
    books: BTreeMap<String, ReaderCompanionSettings>,
}

fn default_image_ratio() -> String {
    "16:9".into()
}
fn default_video_ratio() -> String {
    "16:9".into()
}
fn default_video_resolution() -> String {
    "544P".into()
}

fn companion_settings_path() -> Result<PathBuf, String> {
    Ok(profile::app_config_dir()
        .ok_or("找不到本机配置目录")?
        .join(COMPANION_SETTINGS_FILE))
}

fn validate_companion_text(value: String, label: &str, max_len: usize) -> Result<String, String> {
    let trimmed = value.trim().to_string();
    if trimmed.chars().count() > max_len {
        return Err(format!("{label}不能超过 {max_len} 个字符"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{label}不能包含控制字符"));
    }
    Ok(trimmed)
}

fn normalized_companion_settings(
    settings: ReaderCompanionSettings,
) -> Result<ReaderCompanionSettings, String> {
    let book_id = validate_companion_text(settings.book_id, "图书标识", MAX_BOOK_ID_LEN)?;
    if book_id.is_empty() {
        return Err("未打开图书，无法保存伴读设定".into());
    }
    Ok(ReaderCompanionSettings {
        book_id,
        style_prompt: validate_companion_text(
            settings.style_prompt,
            "画风提示词",
            MAX_STYLE_PROMPT_LEN,
        )?,
        negative_prompt: validate_companion_text(
            settings.negative_prompt,
            "负面提示词",
            MAX_NEGATIVE_PROMPT_LEN,
        )?,
        character_notes: validate_companion_text(
            settings.character_notes,
            "人物设定",
            MAX_CHARACTER_NOTES_LEN,
        )?,
    })
}

fn load_companion_settings_from_path(path: &Path) -> ReaderCompanionSettingsFile {
    let Ok(bytes) = std::fs::read(path) else {
        return ReaderCompanionSettingsFile {
            version: 1,
            ..ReaderCompanionSettingsFile::default()
        };
    };
    let Ok(mut parsed) = serde_json::from_slice::<ReaderCompanionSettingsFile>(&bytes) else {
        return ReaderCompanionSettingsFile {
            version: 1,
            ..ReaderCompanionSettingsFile::default()
        };
    };
    if parsed.version != 1 {
        return ReaderCompanionSettingsFile {
            version: 1,
            ..ReaderCompanionSettingsFile::default()
        };
    }
    parsed.books.retain(|book_id, settings| {
        normalized_companion_settings(ReaderCompanionSettings {
            book_id: book_id.clone(),
            style_prompt: settings.style_prompt.clone(),
            negative_prompt: settings.negative_prompt.clone(),
            character_notes: settings.character_notes.clone(),
        })
        .is_ok()
    });
    parsed
}

fn save_companion_settings_to_path(
    path: &Path,
    settings: ReaderCompanionSettings,
) -> Result<ReaderCompanionSettings, String> {
    let settings = normalized_companion_settings(settings)?;
    let mut file = load_companion_settings_from_path(path);
    file.version = 1;
    file.books
        .insert(settings.book_id.clone(), settings.clone());
    atomic_file::write_json(path, &file, true)?;
    Ok(settings)
}

#[tauri::command]
pub async fn reader_companion_settings_get(
    book_id: String,
) -> Result<ReaderCompanionSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let book_id = validate_companion_text(book_id, "图书标识", MAX_BOOK_ID_LEN)?;
        if book_id.is_empty() {
            return Err("未打开图书，无法读取伴读设定".into());
        }
        let file = load_companion_settings_from_path(&companion_settings_path()?);
        Ok(file
            .books
            .get(&book_id)
            .cloned()
            .unwrap_or(ReaderCompanionSettings {
                book_id,
                ..ReaderCompanionSettings::default()
            }))
    })
    .await
    .map_err(|error| format!("读取本机伴读设定失败：{error}"))?
}

#[tauri::command]
pub async fn reader_companion_settings_save(
    settings: ReaderCompanionSettings,
) -> Result<ReaderCompanionSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_companion_settings_to_path(&companion_settings_path()?, settings)
    })
    .await
    .map_err(|error| format!("保存本机伴读设定失败：{error}"))?
}
fn default_video_duration() -> u8 {
    5
}
fn default_one() -> u8 {
    1
}
fn default_true() -> bool {
    true
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
        for ancestor in start.ancestors().take(7) {
            let candidate = ancestor.join("scripts").join("local-minimax-h3.ps1");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("找不到固定的 MiniMax-H3 本地运行脚本".into())
}

fn intelligence_runtime_script_path() -> Result<PathBuf, String> {
    let mut starts = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        for ancestor in start.ancestors().take(7) {
            let candidate = ancestor
                .join("scripts")
                .join("local-intelligence-runtime.ps1");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("找不到固定的本地智能模型运行脚本".into())
}

fn restorable_phase(snapshot: &IntelligenceRuntimeSnapshot) -> Result<&str, String> {
    match snapshot.phase.as_str() {
        "TriageGpu" | "EditorialGpu" | "CalibrationCpu" | "CoreOnly" if snapshot.healthy => {
            Ok(snapshot.phase.as_str())
        }
        "Stopped" => Ok("Stopped"),
        "Partial" => Err("本地智能模型处于不完整运行状态，无法安全切换到伴读".into()),
        _ => Err("本地智能模型状态无法确认，已拒绝切换显存".into()),
    }
}

fn restore_action(previous_phase: &str) -> Result<&str, String> {
    match previous_phase {
        "TriageGpu" | "EditorialGpu" | "CalibrationCpu" | "CoreOnly" => Ok(previous_phase),
        "Stopped" => Ok("StopAll"),
        _ => Err("伴读记录的恢复阶段无效".into()),
    }
}

fn valid_cycle_id(cycle_id: &str) -> bool {
    uuid::Uuid::parse_str(cycle_id).is_ok()
}

/// `nvidia-smi --query-compute-apps` has no header with the flags used below.
/// We intentionally return only a boolean: process names and paths are local
/// diagnostic data and do not need to cross the reader-media boundary.
fn gpu_compute_output_has_processes(output: &str) -> bool {
    output.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.eq_ignore_ascii_case("no running processes found")
    })
}

#[cfg(windows)]
fn unmanaged_gpu_compute_processes_present() -> Result<bool, String> {
    let output = Command::new("nvidia-smi.exe")
        .args([
            "--query-compute-apps=pid,process_name,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "无法检查其他 GPU 推理进程；未启动伴读以避免显存冲突".to_string())?;
    if !output.status.success() {
        return Err("无法检查其他 GPU 推理进程；未启动伴读以避免显存冲突".into());
    }
    Ok(gpu_compute_output_has_processes(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(not(windows))]
fn unmanaged_gpu_compute_processes_present() -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn invoke_intelligence_runtime_action(action: &str) -> Result<IntelligenceRuntimeSnapshot, String> {
    if !matches!(
        action,
        "Status" | "TriageGpu" | "EditorialGpu" | "CalibrationCpu" | "CoreOnly" | "StopAll"
    ) {
        return Err("本地智能模型切换目标无效".into());
    }
    let script = intelligence_runtime_script_path()?;
    let output = Command::new("pwsh.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", action])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "无法启动本地智能模型运行管理器；需要 PowerShell 7".to_string())?;
    if !output.status.success() {
        return Err(match action {
            "Status" => "读取本地智能模型运行阶段失败",
            "StopAll" => "停止本地智能模型失败，未启动 MiniMax-H3",
            _ => "恢复本地智能模型运行阶段失败",
        }
        .into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "本地智能模型运行管理器返回了无效状态".to_string())
}

#[cfg(not(windows))]
fn invoke_intelligence_runtime_action(
    _action: &str,
) -> Result<IntelligenceRuntimeSnapshot, String> {
    Err("本地智能模型显存轮换当前仅支持 Windows".into())
}

#[cfg(windows)]
fn invoke_runtime_action(action: &str) -> Result<ReaderMediaStatus, String> {
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
        .args(["-Action", action]);
    // 状态检查也把实际自动安装目录交给脚本，避免只检查系统盘而漏掉
    // 阅读器所在磁盘的可用空间。路径只在本机子进程参数中使用，不会回传 UI。
    if action == "Status" {
        if let Ok(install_root) = reader_media_install_root() {
            command.args(["-InstallRoot"]).arg(install_root);
        }
    }
    let output = command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "无法启动 MiniMax-H3 本地模型管理器；需要 PowerShell 7".to_string())?;
    if !output.status.success() {
        return Err(match action {
            "InstallAsync" => {
                "无法检查本机 ComfyUI/GGUF 准备状态；请确认已选择本机安装目录和 API 工作流"
            }
            "Start" => "MiniMax-H3 本地服务启动失败，请重新检测硬件和模型文件",
            "Stop" => "MiniMax-H3 本地服务停止失败",
            _ => "读取 MiniMax-H3 本机状态失败",
        }
        .into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "MiniMax-H3 本地模型管理器返回了无效状态".to_string())
}

#[cfg(windows)]
fn reader_media_install_root() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|_| "无法定位当前阅读器安装位置".to_string())?;
    let parent = executable
        .parent()
        .ok_or_else(|| "无法定位当前阅读器安装目录".to_string())?;
    Ok(parent.join("reader-media"))
}

#[cfg(windows)]
fn invoke_runtime_install() -> Result<ReaderMediaStatus, String> {
    let script = runtime_script_path()?;
    let install_root = reader_media_install_root()?;
    let output = Command::new("pwsh.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", "InstallAsync", "-InstallRoot"])
        .arg(install_root)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "无法启动 MiniMax-H3 一键安装器；需要 PowerShell 7".to_string())?;
    if !output.status.success() {
        return Err("MiniMax-H3 一键安装器无法启动；请确认阅读器安装目录可写且磁盘空间充足".into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "MiniMax-H3 一键安装器返回了无效状态".to_string())
}

#[cfg(windows)]
fn invoke_runtime_configure(config: ReaderMediaComfyUiConfig) -> Result<ReaderMediaStatus, String> {
    if config.comfy_ui_root.trim().is_empty() || config.workflow_path.trim().is_empty() {
        return Err("需要选择本机 ComfyUI 目录和 API 工作流文件".into());
    }
    let script = runtime_script_path()?;
    let endpoint = if config.endpoint.trim().is_empty() {
        "http://127.0.0.1:8188"
    } else {
        config.endpoint.trim()
    };
    let output = Command::new("pwsh.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", "ConfigureComfyUi", "-ComfyUiRoot"])
        .arg(config.comfy_ui_root.trim())
        .args(["-WorkflowPath"])
        .arg(config.workflow_path.trim())
        .args(["-PythonPath"])
        .arg(config.python_path.trim())
        .args(["-Endpoint"])
        .arg(endpoint)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "无法启动本机 ComfyUI 配置管理器；需要 PowerShell 7".to_string())?;
    if !output.status.success() {
        return Err(
            "ComfyUI/GGUF 本机配置无效；请检查目录、专用 Python 和 API 工作流占位符".into(),
        );
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "ComfyUI/GGUF 本机配置管理器返回了无效状态".to_string())
}

#[cfg(not(windows))]
fn invoke_runtime_action(_action: &str) -> Result<ReaderMediaStatus, String> {
    Err("MiniMax-H3 自动下载与管理当前仅支持 Windows".into())
}

#[cfg(not(windows))]
fn invoke_runtime_configure(
    _config: ReaderMediaComfyUiConfig,
) -> Result<ReaderMediaStatus, String> {
    Err("ComfyUI/GGUF 本机配置当前仅支持 Windows".into())
}

#[tauri::command]
pub async fn reader_media_status() -> Result<ReaderMediaStatus, String> {
    tauri::async_runtime::spawn_blocking(|| invoke_runtime_action("Status"))
        .await
        .map_err(|error| format!("MiniMax-H3 状态任务失败：{error}"))?
}

#[tauri::command]
pub async fn install_reader_media_model() -> Result<ReaderMediaStatus, String> {
    #[cfg(windows)]
    let installation = tauri::async_runtime::spawn_blocking(invoke_runtime_install);
    #[cfg(not(windows))]
    let installation =
        tauri::async_runtime::spawn_blocking(|| invoke_runtime_action("InstallAsync"));

    installation
        .await
        .map_err(|error| format!("MiniMax-H3 一键安装任务启动失败：{error}"))?
}

/// Saves only a local ComfyUI/GGUF path configuration after the manager has
/// verified it is loopback-only and contains the required API workflow tokens.
#[tauri::command]
pub async fn configure_reader_media_comfyui(
    config: ReaderMediaComfyUiConfig,
) -> Result<ReaderMediaStatus, String> {
    tauri::async_runtime::spawn_blocking(move || invoke_runtime_configure(config))
        .await
        .map_err(|error| format!("ComfyUI/GGUF 本机配置任务失败：{error}"))?
}

#[tauri::command]
pub async fn start_reader_media_runtime() -> Result<ReaderMediaStatus, String> {
    if generation_cycle()
        .lock()
        .map_err(|_| "伴读显存轮换状态不可用".to_string())?
        .is_some()
    {
        return reader_media_status().await;
    }
    tauri::async_runtime::spawn_blocking(|| invoke_runtime_action("Start"))
        .await
        .map_err(|error| format!("MiniMax-H3 启动任务失败：{error}"))?
}

#[tauri::command]
pub async fn stop_reader_media_runtime() -> Result<ReaderMediaStatus, String> {
    if generation_cycle()
        .lock()
        .map_err(|_| "伴读显存轮换状态不可用".to_string())?
        .is_some()
    {
        return Err("伴读正在批量生成，结束本轮后才能单独停止 MiniMax-H3".into());
    }
    tauri::async_runtime::spawn_blocking(|| invoke_runtime_action("Stop"))
        .await
        .map_err(|error| format!("MiniMax-H3 停止任务失败：{error}"))?
}

fn begin_generation_cycle_blocking() -> Result<ReaderMediaGenerationCycle, String> {
    let cycle_id = uuid::Uuid::new_v4().to_string();
    let mut active = generation_cycle()
        .lock()
        .map_err(|_| "伴读显存轮换状态不可用".to_string())?;
    if active.is_some() {
        return Err("已有一轮伴读正在生成；同一时间只能运行一个本地生成批次".into());
    }

    let before = invoke_intelligence_runtime_action("Status")?;
    let previous_phase = restorable_phase(&before)?.to_string();
    let h3_before = invoke_runtime_action("Status")?;
    if h3_before.model_id != MODEL_ID {
        return Err("MiniMax-H3 本地运行状态中的模型身份不匹配".into());
    }
    if !h3_before.hardware_supported {
        return Err(h3_before.message);
    }
    if !h3_before.model_ready {
        return Err("MiniMax-H3 尚未下载完成，未暂停当前本地智能模型".into());
    }
    if h3_before.runtime_ready && previous_phase != "Stopped" {
        return Err(
            "MiniMax-H3 已在本轮之外运行，且本地智能模型仍占用运行阶段；请先停止 H3 后重试".into(),
        );
    }

    if previous_phase != "Stopped" {
        let stopped = invoke_intelligence_runtime_action("StopAll")?;
        if stopped.phase != "Stopped" {
            return Err(rollback_failed_begin(
                &cycle_id,
                &previous_phase,
                false,
                "受管本地智能模型未能完全停止；未启动 MiniMax-H3".into(),
                &mut active,
            ));
        }
    }
    if !h3_before.runtime_ready && unmanaged_gpu_compute_processes_present()? {
        return Err(rollback_failed_begin(
            &cycle_id,
            &previous_phase,
            false,
            "检测到未受本阅读器管理的 GPU 推理进程；请先停止外部 llama-server、ComfyUI 或其他 GPU 推理任务后再启动伴读".into(),
            &mut active,
        ));
    }

    let mut started_by_cycle = false;
    let h3_status = if h3_before.runtime_ready {
        h3_before
    } else {
        started_by_cycle = true;
        match invoke_runtime_action("Start") {
            Ok(status) if status.runtime_ready && status.model_id == MODEL_ID => status,
            Ok(_) => {
                let start_error = "MiniMax-H3 启动后未通过本机健康检查".to_string();
                return Err(rollback_failed_begin(
                    &cycle_id,
                    &previous_phase,
                    started_by_cycle,
                    start_error,
                    &mut active,
                ));
            }
            Err(error) => {
                return Err(rollback_failed_begin(
                    &cycle_id,
                    &previous_phase,
                    started_by_cycle,
                    error,
                    &mut active,
                ));
            }
        }
    };

    *active = Some(ReaderMediaGenerationLease {
        cycle_id: cycle_id.clone(),
        previous_phase: previous_phase.clone(),
        h3_started_by_cycle: started_by_cycle,
    });
    Ok(ReaderMediaGenerationCycle {
        cycle_id,
        previous_phase,
        h3_started_by_cycle: started_by_cycle,
        runtime_ready: h3_status.runtime_ready,
        message: if started_by_cycle {
            "本地智能模型已暂停，MiniMax-H3 已接管显存；请在本批次结束时调用结束接口".into()
        } else {
            "已接管当前 MiniMax-H3 本地运行实例；本批次结束后不会停止原有实例".into()
        },
    })
}

fn rollback_failed_begin(
    cycle_id: &str,
    previous_phase: &str,
    h3_started_by_cycle: bool,
    start_error: String,
    active: &mut Option<ReaderMediaGenerationLease>,
) -> String {
    let mut cleanup_errors = Vec::new();
    let mut h3_still_owned = h3_started_by_cycle;
    if h3_started_by_cycle {
        match invoke_runtime_action("Stop") {
            Ok(_) => h3_still_owned = false,
            Err(error) => cleanup_errors.push(error),
        }
    }
    if !h3_still_owned {
        if let Ok(action) = restore_action(previous_phase) {
            if let Err(error) = invoke_intelligence_runtime_action(action) {
                cleanup_errors.push(error);
            }
        }
    } else {
        cleanup_errors.push("MiniMax-H3 尚未停止，为避免显存冲突，未恢复本地智能模型".into());
    }
    if cleanup_errors.is_empty() {
        format!("MiniMax-H3 启动失败，已恢复之前的本地智能模型阶段：{start_error}")
    } else {
        *active = Some(ReaderMediaGenerationLease {
            cycle_id: cycle_id.to_string(),
            previous_phase: previous_phase.to_string(),
            h3_started_by_cycle: h3_still_owned,
        });
        format!(
            "MiniMax-H3 启动失败，且自动恢复未完成；恢复标识 {cycle_id}，请调用结束接口重试清理：{}",
            cleanup_errors.join("；")
        )
    }
}

fn finish_generation_cycle_blocking(
    cycle_id: String,
) -> Result<ReaderMediaGenerationCycle, String> {
    if !valid_cycle_id(&cycle_id) {
        return Err("伴读生成批次编号无效".into());
    }
    let mut active = generation_cycle()
        .lock()
        .map_err(|_| "伴读显存轮换状态不可用".to_string())?;
    let lease = active.as_mut().ok_or("当前没有正在运行的伴读生成批次")?;
    if lease.cycle_id != cycle_id {
        return Err("伴读生成批次编号不匹配，已拒绝释放其他批次".into());
    }

    let h3_was_started_by_cycle = lease.h3_started_by_cycle;
    if h3_was_started_by_cycle {
        invoke_runtime_action("Stop")?;
        lease.h3_started_by_cycle = false;
    }
    let action = restore_action(&lease.previous_phase)?;
    let restored = invoke_intelligence_runtime_action(action)?;
    restorable_phase(&restored)?;
    if restored.phase != lease.previous_phase {
        return Err("本地智能模型恢复后的运行阶段与轮换前不一致".into());
    }

    let previous_phase = lease.previous_phase.clone();
    *active = None;
    Ok(ReaderMediaGenerationCycle {
        cycle_id,
        previous_phase,
        h3_started_by_cycle: false,
        runtime_ready: !h3_was_started_by_cycle,
        message: "伴读批次已结束，轮换前的本地智能模型阶段已恢复".into(),
    })
}

#[tauri::command]
pub async fn begin_reader_media_generation_cycle() -> Result<ReaderMediaGenerationCycle, String> {
    tauri::async_runtime::spawn_blocking(begin_generation_cycle_blocking)
        .await
        .map_err(|error| format!("伴读显存轮换启动任务失败：{error}"))?
}

#[tauri::command]
pub async fn finish_reader_media_generation_cycle(
    cycle_id: String,
) -> Result<ReaderMediaGenerationCycle, String> {
    tauri::async_runtime::spawn_blocking(move || finish_generation_cycle_blocking(cycle_id))
        .await
        .map_err(|error| format!("伴读显存轮换结束任务失败：{error}"))?
}

fn validate_prompt(prompt: &str, max_chars: usize) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("生成描述不能为空".into());
    }
    if prompt.chars().count() > max_chars {
        return Err(format!("生成描述不能超过 {max_chars} 个字符"));
    }
    Ok(prompt.to_string())
}

fn validate_local_reference(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        return Err("本地 MiniMax-H3 不接受网络媒体地址，请先保存到本机".into());
    }
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_file() {
        return Err("参考媒体必须是已存在的本机文件".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn validate_video_request(
    mut request: ReaderMediaVideoRequest,
) -> Result<ReaderMediaVideoRequest, String> {
    request.prompt = validate_prompt(&request.prompt, 7000)?;
    if !["544P", "768P"].contains(&request.resolution.as_str())
        || !(4..=15).contains(&request.duration)
    {
        return Err("本地视频分辨率或时长无效".into());
    }
    if !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].contains(&request.ratio.as_str()) {
        return Err("视频比例无效".into());
    }
    request.first_frame_image = request
        .first_frame_image
        .as_deref()
        .map(validate_local_reference)
        .transpose()?;
    request.last_frame_image = request
        .last_frame_image
        .as_deref()
        .map(validate_local_reference)
        .transpose()?;
    request.reference_images = request
        .reference_images
        .iter()
        .map(|v| validate_local_reference(v))
        .collect::<Result<Vec<_>, _>>()?;
    request.reference_videos = request
        .reference_videos
        .iter()
        .map(|v| validate_local_reference(v))
        .collect::<Result<Vec<_>, _>>()?;
    request.reference_audios = request
        .reference_audios
        .iter()
        .map(|v| validate_local_reference(v))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(request)
}

fn local_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        // A local ComfyUI image request may legitimately take several minutes
        // while quantized blocks are swapped. Video stays asynchronous.
        .timeout(Duration::from_secs(35 * 60))
        .build()
        .map_err(|_| "无法初始化 MiniMax-H3 本机客户端".to_string())
}

async fn ensure_runtime_ready() -> Result<(), String> {
    let status = reader_media_status().await?;
    if status.model_id != MODEL_ID {
        return Err("MiniMax-H3 本地服务模型身份不匹配".into());
    }
    if !status.hardware_supported {
        return Err(status.message);
    }
    if !status.model_ready {
        return Err("MiniMax-H3 尚未下载完成，请先在智能设置中准备本地模型".into());
    }
    if !status.runtime_ready {
        return Err("MiniMax-H3 本地服务尚未启动".into());
    }
    Ok(())
}

fn media_cache_root() -> Result<PathBuf, String> {
    profile::app_cache_dir()
        .ok_or_else(|| "无法定位应用缓存目录".to_string())
        .map(|path| path.join("reader-media"))
}

fn validate_cached_path(path: &str) -> Result<PathBuf, String> {
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "MiniMax-H3 返回的本机结果不存在".to_string())?;
    let root = media_cache_root()?;
    std::fs::create_dir_all(&root).map_err(|_| "无法创建伴读缓存".to_string())?;
    let root = root
        .canonicalize()
        .map_err(|_| "无法验证伴读缓存目录".to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("MiniMax-H3 返回了缓存目录外的文件，已拒绝读取".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn generate_reader_media_image(
    request: ReaderMediaImageRequest,
) -> Result<ReaderMediaImageResult, String> {
    ensure_runtime_ready().await?;
    let prompt = validate_prompt(&request.prompt, 1500)?;
    if !["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]
        .contains(&request.aspect_ratio.as_str())
        || request.n != 1
    {
        return Err("本地 H3 代表帧只支持一次生成一张".into());
    }
    let response = local_client()?.post(format!("{LOCAL_BASE_URL}/v1/generate/image"))
        .json(&serde_json::json!({"prompt": prompt, "aspectRatio": request.aspect_ratio, "extractFromVideo": true, "promptOptimizer": request.prompt_optimizer}))
        .send().await.map_err(|_| "无法连接 MiniMax-H3 本地服务".to_string())?;
    if !response.status().is_success() {
        return Err("MiniMax-H3 本地代表帧任务创建失败".into());
    }
    let mut result: ReaderMediaImageResult = response
        .json()
        .await
        .map_err(|_| "MiniMax-H3 本地代表帧响应无效".to_string())?;
    for image in &mut result.images {
        let path = validate_cached_path(&image.absolute_path)?;
        image.absolute_path = path.to_string_lossy().into_owned();
        image.cache_key = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
    }
    Ok(result)
}

#[tauri::command]
pub async fn create_reader_media_video(
    request: ReaderMediaVideoRequest,
) -> Result<ReaderMediaVideoCreated, String> {
    ensure_runtime_ready().await?;
    let request = validate_video_request(request)?;
    let response = local_client()?
        .post(format!("{LOCAL_BASE_URL}/v1/generate/video"))
        .json(&request)
        .send()
        .await
        .map_err(|_| "无法连接 MiniMax-H3 本地服务".to_string())?;
    if !response.status().is_success() {
        return Err("MiniMax-H3 本地视频任务创建失败".into());
    }
    let result: ReaderMediaVideoCreated = response
        .json()
        .await
        .map_err(|_| "MiniMax-H3 本地视频任务响应无效".to_string())?;
    if !valid_task_id(&result.task_id) {
        return Err("MiniMax-H3 返回的本地任务编号无效".into());
    }
    Ok(result)
}

fn valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 128
        && task_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
}

#[tauri::command]
pub async fn query_reader_media_video(task_id: String) -> Result<ReaderMediaVideoStatus, String> {
    if !valid_task_id(&task_id) {
        return Err("视频任务编号无效".into());
    }
    ensure_runtime_ready().await?;
    let response = local_client()?
        .get(format!("{LOCAL_BASE_URL}/v1/tasks/{task_id}"))
        .send()
        .await
        .map_err(|_| "无法连接 MiniMax-H3 本地服务".to_string())?;
    if !response.status().is_success() {
        return Err("无法读取 MiniMax-H3 本地任务".into());
    }
    let mut result: ReaderMediaVideoStatus = response
        .json()
        .await
        .map_err(|_| "MiniMax-H3 本地任务响应无效".to_string())?;
    if result.task_id != task_id {
        return Err("MiniMax-H3 返回了不匹配的本地任务编号".into());
    }
    if result.status == "success" {
        let path = validate_cached_path(
            result
                .absolute_path
                .as_deref()
                .ok_or("MiniMax-H3 本地任务完成但结果文件缺失")?,
        )?;
        result.absolute_path = Some(path.to_string_lossy().into_owned());
        result.cache_key = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_runtime_is_fixed_to_loopback_and_official_model_id() {
        assert_eq!(MODEL_ID, "MiniMaxAI/MiniMax-H3");
        assert_eq!(LOCAL_BASE_URL, "http://127.0.0.1:8095");
        assert!(!LOCAL_BASE_URL.contains("minimax.io"));
        assert!(!LOCAL_BASE_URL.contains("minimaxi.com"));
    }

    #[test]
    fn status_contract_has_no_cloud_region_or_api_key() {
        let status = ReaderMediaStatus {
            configured: false,
            model_ready: false,
            runtime_ready: false,
            hardware_supported: false,
            model_id: MODEL_ID.into(),
            runtime_device: "not-running".into(),
            total_ram_mib: 32_000,
            required_ram_mib: 76_800,
            total_vram_mib: 16_303,
            required_vram_mib: 12_288,
            available_disk_mib: 0,
            required_disk_mib: 0,
            installation_state: "not_installed".into(),
            installation_step: String::new(),
            installation_root: String::new(),
            selected_preset: String::new(),
            message: "硬件不足".into(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("modelReady"));
        assert!(json.contains("hardwareSupported"));
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("region"));
    }

    #[test]
    fn comfyui_configuration_keeps_only_local_paths_and_no_credentials() {
        let config = ReaderMediaComfyUiConfig {
            comfy_ui_root: r"C:\ComfyUI".into(),
            workflow_path: r"C:\ComfyUI\workflows\minimax-h3-api.json".into(),
            python_path: r"C:\ComfyUI\venv\Scripts\python.exe".into(),
            endpoint: "http://127.0.0.1:8188".into(),
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("comfyUiRoot"));
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn external_media_references_are_rejected() {
        assert!(validate_local_reference("https://example.com/a.png").is_err());
        assert!(validate_local_reference("http://127.0.0.1/a.png").is_err());
    }

    #[test]
    fn task_ids_are_strict_and_bounded() {
        assert!(valid_task_id("local-h3_123"));
        assert!(!valid_task_id("../escape"));
        assert!(!valid_task_id(&"a".repeat(129)));
    }

    #[test]
    fn only_known_healthy_intelligence_phases_can_be_restored() {
        for phase in ["TriageGpu", "EditorialGpu", "CalibrationCpu", "CoreOnly"] {
            let snapshot = IntelligenceRuntimeSnapshot {
                phase: phase.into(),
                healthy: true,
            };
            assert_eq!(restorable_phase(&snapshot).unwrap(), phase);
            assert_eq!(restore_action(phase).unwrap(), phase);
        }
        let stopped = IntelligenceRuntimeSnapshot {
            phase: "Stopped".into(),
            healthy: false,
        };
        assert_eq!(restorable_phase(&stopped).unwrap(), "Stopped");
        assert_eq!(restore_action("Stopped").unwrap(), "StopAll");
    }

    #[test]
    fn partial_or_unhealthy_intelligence_phases_are_rejected() {
        for (phase, healthy) in [("Partial", false), ("EditorialGpu", false), ("Other", true)] {
            let snapshot = IntelligenceRuntimeSnapshot {
                phase: phase.into(),
                healthy,
            };
            assert!(restorable_phase(&snapshot).is_err());
        }
        assert!(restore_action("Partial").is_err());
    }

    #[test]
    fn generation_cycle_ids_are_uuid_only() {
        assert!(valid_cycle_id(&uuid::Uuid::new_v4().to_string()));
        assert!(!valid_cycle_id("../other-cycle"));
        assert!(!valid_cycle_id(""));
    }

    #[test]
    fn gpu_compute_gate_only_treats_real_rows_as_active_processes() {
        assert!(!gpu_compute_output_has_processes(""));
        assert!(!gpu_compute_output_has_processes(
            "No running processes found\n"
        ));
        assert!(gpu_compute_output_has_processes(
            "1234, llama-server.exe, 8192\n"
        ));
    }

    #[test]
    fn companion_settings_are_saved_per_book_in_a_local_file() {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-reader-companion-settings-{}-{}",
            std::process::id(),
            crate::atomic_file::test_nonce()
        ));
        let path = directory.join(COMPANION_SETTINGS_FILE);
        let first = save_companion_settings_to_path(
            &path,
            ReaderCompanionSettings {
                book_id: "content-a".into(),
                style_prompt: "水墨写意".into(),
                negative_prompt: "避免水印".into(),
                character_notes: "林舟：短发，青色斗篷".into(),
            },
        )
        .unwrap();
        assert_eq!(first.style_prompt, "水墨写意");
        save_companion_settings_to_path(
            &path,
            ReaderCompanionSettings {
                book_id: "content-b".into(),
                style_prompt: "电影写实".into(),
                ..ReaderCompanionSettings::default()
            },
        )
        .unwrap();
        let saved = load_companion_settings_from_path(&path);
        assert_eq!(saved.version, 1);
        assert_eq!(saved.books.len(), 2);
        assert_eq!(
            saved.books["content-a"].character_notes,
            "林舟：短发，青色斗篷"
        );
        assert_eq!(saved.books["content-b"].style_prompt, "电影写实");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn companion_settings_reject_empty_book_or_oversized_visual_notes() {
        assert!(normalized_companion_settings(ReaderCompanionSettings::default()).is_err());
        assert!(normalized_companion_settings(ReaderCompanionSettings {
            book_id: "book".into(),
            character_notes: "a".repeat(MAX_CHARACTER_NOTES_LEN + 1),
            ..ReaderCompanionSettings::default()
        })
        .is_err());
    }
}
