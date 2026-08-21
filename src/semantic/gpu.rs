//! NVIDIA CUDA 加速的硬件、驱动与随包运行时检测。
//!
//! Windows/Linux 正式包携带与主程序同一次构建产生的 ONNX Runtime CUDA
//! Provider。只有显卡、驱动和 Provider 文件都满足条件时，语义模型才尝试
//! 注册 CUDA；注册失败会安全回退 CPU，不影响普通设备启动。

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::process::Command;

#[cfg(target_os = "windows")]
const MIN_CUDA_12_DRIVER: (u32, u32) = (527, 41);
#[cfg(target_os = "linux")]
const MIN_CUDA_12_DRIVER: (u32, u32) = (525, 60);

#[derive(Serialize)]
pub(crate) struct SemanticGpuStatus {
    pub(crate) detected: bool,
    /// 硬件和驱动是否满足 CUDA 12 的最低门槛。
    pub(crate) supported: bool,
    /// 当前安装目录是否已经包含与程序同次构建的 CUDA Provider。
    pub(crate) component_available: bool,
    /// CUDA Provider 是否已经通过真实注册测试。
    pub(crate) runtime_ready: bool,
    /// 当前平台是否支持由应用自动安装大体积运行依赖。
    pub(crate) runtime_install_available: bool,
    /// 自动安装需要下载的总字节数。
    pub(crate) runtime_download_bytes: u64,
    /// 已完整保存在本地、可用于断点续传的字节数。
    pub(crate) runtime_downloaded_bytes: u64,
    pub(crate) name: String,
    pub(crate) driver: String,
    pub(crate) message: String,
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn driver_meets_minimum(value: &str, minimum: (u32, u32)) -> bool {
    let mut parts = value
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    (major, minor) >= minimum
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn query_nvidia_smi() -> Result<(String, String), String> {
    let mut command = Command::new("nvidia-smi");
    command.args(["--query-gpu=name,driver_version", "--format=csv,noheader"]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = command
        .output()
        .map_err(|_| "未检测到 NVIDIA GPU 或 NVIDIA 驱动".to_string())?;
    if !output.status.success() {
        return Err("未检测到可用的 NVIDIA GPU 或驱动".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "NVIDIA 驱动没有返回设备信息".to_string())?;
    let (name, driver) = line
        .rsplit_once(',')
        .ok_or_else(|| "NVIDIA 驱动返回的设备信息无法识别".to_string())?;
    Ok((name.trim().to_string(), driver.trim().to_string()))
}

#[cfg(target_os = "windows")]
const PROVIDER_FILES: &[(&str, u64)] = &[
    ("onnxruntime.dll", 15_374_408),
    ("onnxruntime_providers_cuda.dll", 312_607_776),
    ("onnxruntime_providers_shared.dll", 22_048),
];
#[cfg(target_os = "linux")]
const PROVIDER_FILES: &[&str] = &[
    "libonnxruntime_providers_cuda.so",
    "libonnxruntime_providers_shared.so",
];

#[cfg(target_os = "windows")]
fn provider_component_present() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .is_some_and(|dir| {
            PROVIDER_FILES.iter().all(|(name, expected_size)| {
                std::fs::metadata(dir.join(name))
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() == *expected_size)
            })
        })
}

#[cfg(target_os = "linux")]
fn provider_component_present() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .is_some_and(|dir| PROVIDER_FILES.iter().all(|name| dir.join(name).is_file()))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn cuda_runtime_ready() -> Result<(), String> {
    use ort::ep::ExecutionProvider;

    super::gpu_runtime::prepare();
    let mut builder = ort::session::Session::builder().map_err(|error| error.to_string())?;
    ort::ep::CUDA::default()
        .register(&mut builder)
        .map_err(|error| error.to_string())
}
#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn cuda_runtime_error_summary(error: &str) -> String {
    const DEPENDENCIES: &[&str] = &[
        "cublasLt64_12.dll",
        "cublas64_12.dll",
        "cufft64_11.dll",
        "cudart64_12.dll",
        "cudnn64_9.dll",
        "cudnn_adv64_9.dll",
        "cudnn_cnn64_9.dll",
        "cudnn_engines_precompiled64_9.dll",
        "cudnn_engines_runtime_compiled64_9.dll",
        "cudnn_graph64_9.dll",
        "cudnn_heuristic64_9.dll",
        "cudnn_ops64_9.dll",
        "nvJitLink_120_0.dll",
        "libcublasLt.so.12",
        "libcublas.so.12",
        "libcufft.so.11",
        "libcudart.so.12",
        "libcudnn.so.9",
    ];
    if let Some(name) = DEPENDENCIES.iter().find(|name| error.contains(**name)) {
        return format!("缺少 {name}");
    }
    "CUDA 12 或 cuDNN 动态库加载失败".into()
}
/// FastEmbed 创建会话时使用的 CUDA Provider。Provider 注册默认允许失败并
/// 回退 CPU，避免用户只安装了驱动、尚未安装 CUDA/cuDNN 运行依赖时打不开模型。
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn cuda_execution_providers_with_mode(
    error_on_failure: bool,
) -> Vec<fastembed::ExecutionProviderDispatch> {
    let supported = query_nvidia_smi()
        .map(|(_, driver)| driver_meets_minimum(&driver, MIN_CUDA_12_DRIVER))
        .unwrap_or(false);
    if !supported || !provider_component_present() {
        return Vec::new();
    }
    super::gpu_runtime::prepare();
    let provider = ort::ep::CUDA::default().build();
    vec![if error_on_failure {
        provider.error_on_failure()
    } else {
        provider.fail_silently()
    }]
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    cuda_execution_providers_with_mode(false)
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn strict_cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    cuda_execution_providers_with_mode(true)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(super) fn cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    Vec::new()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(super) fn strict_cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    Vec::new()
}

fn semantic_gpu_status_blocking() -> SemanticGpuStatus {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        SemanticGpuStatus {
            detected: false,
            supported: false,
            component_available: false,
            runtime_ready: false,
            runtime_install_available: false,
            runtime_download_bytes: super::gpu_runtime::DOWNLOAD_BYTES,
            runtime_downloaded_bytes: super::gpu_runtime::downloaded_bytes(),
            name: String::new(),
            driver: String::new(),
            message: "当前平台不支持 NVIDIA CUDA 加速，语义模型使用 CPU。".into(),
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    match query_nvidia_smi() {
        Ok((name, driver)) if !driver_meets_minimum(&driver, MIN_CUDA_12_DRIVER) => {
            let minimum = format!("{}.{}", MIN_CUDA_12_DRIVER.0, MIN_CUDA_12_DRIVER.1);
            SemanticGpuStatus {
                detected: true,
                supported: false,
                component_available: false,
                runtime_ready: false,
                runtime_install_available: false,
                runtime_download_bytes: super::gpu_runtime::DOWNLOAD_BYTES,
                runtime_downloaded_bytes: super::gpu_runtime::downloaded_bytes(),
                name,
                driver: driver.clone(),
                message: format!(
                    "已检测到 NVIDIA GPU，但驱动 {driver} 低于 CUDA 12 所需版本 {minimum}，当前使用 CPU。"
                ),
            }
        }
        Ok((name, driver)) => {
            let component_available = provider_component_present();
            let runtime_result = if component_available {
                cuda_runtime_ready()
            } else {
                Err("CUDA Provider 未安装".into())
            };
            let runtime_ready = runtime_result.is_ok();
            let runtime_install_available =
                super::gpu_runtime::install_available() && component_available && !runtime_ready;
            let message = if !component_available {
                format!(
                    "已检测到 {name}（驱动 {driver}），但当前安装目录缺少匹配的 CUDA Provider 文件；请更新或重新安装同版本正式包。"
                )
            } else if runtime_ready {
                format!(
                    "已检测到 {name}（驱动 {driver}）。CUDA 组件与运行依赖均已就绪，语义模型会优先使用 GPU。"
                )
            } else {
                let detail = cuda_runtime_error_summary(&runtime_result.unwrap_err());
                if runtime_install_available {
                    "缺少 CUDA 组件".into()
                } else {
                    format!(
                        "已检测到 {name}（驱动 {driver}）。CUDA Provider 已安装，但 CUDA 12/cuDNN 系统依赖未就绪，当前自动使用 CPU。详情：{detail}"
                    )
                }
            };
            SemanticGpuStatus {
                detected: true,
                supported: true,
                component_available,
                runtime_ready,
                runtime_install_available,
                runtime_download_bytes: super::gpu_runtime::DOWNLOAD_BYTES,
                runtime_downloaded_bytes: super::gpu_runtime::downloaded_bytes(),
                name,
                driver,
                message,
            }
        }
        Err(message) => SemanticGpuStatus {
            detected: false,
            supported: false,
            component_available: false,
            runtime_ready: false,
            runtime_install_available: false,
            runtime_download_bytes: super::gpu_runtime::DOWNLOAD_BYTES,
            runtime_downloaded_bytes: super::gpu_runtime::downloaded_bytes(),
            name: String::new(),
            driver: String::new(),
            message: format!("{message}，当前使用 CPU。"),
        },
    }
}

#[tauri::command]
pub(crate) async fn semantic_gpu_status() -> Result<SemanticGpuStatus, String> {
    tauri::async_runtime::spawn_blocking(semantic_gpu_status_blocking)
        .await
        .map_err(|error| format!("GPU 检测任务失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{cuda_runtime_error_summary, driver_meets_minimum, semantic_gpu_status_blocking};

    #[test]
    fn runtime_error_summary_keeps_only_the_actionable_dependency() {
        let raw =
            r#"D:\a\ort\provider_bridge.cc depends on \"cublasLt64_12.dll\" which is missing"#;
        assert_eq!(cuda_runtime_error_summary(raw), "缺少 cublasLt64_12.dll");
        assert!(!cuda_runtime_error_summary(raw).contains("D:\\a"));
    }

    #[test]
    fn runtime_error_summary_covers_direct_windows_dependencies() {
        for dependency in [
            "cublasLt64_12.dll",
            "cublas64_12.dll",
            "cufft64_11.dll",
            "cudart64_12.dll",
            "cudnn64_9.dll",
        ] {
            assert_eq!(
                cuda_runtime_error_summary(&format!("load failed: {dependency}")),
                format!("缺少 {dependency}")
            );
        }
    }

    #[test]
    fn gpu_status_never_claims_a_supported_component_is_unpublished() {
        assert!(!semantic_gpu_status_blocking().message.contains("尚未发布"));
    }
    #[test]
    fn cuda_driver_gate_is_explicit_for_each_platform_minimum() {
        assert!(!driver_meets_minimum("527.40", (527, 41)));
        assert!(driver_meets_minimum("527.41", (527, 41)));
        assert!(!driver_meets_minimum("525.59", (525, 60)));
        assert!(driver_meets_minimum("525.60", (525, 60)));
        assert!(driver_meets_minimum("610.47", (527, 41)));
    }
}
