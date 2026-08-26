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
    /// `nvidia-smi` reported physical framebuffer capacity, in MiB.
    pub(crate) total_vram_mib: Option<u64>,
    /// `nvidia-smi` reported currently free framebuffer capacity, in MiB.
    pub(crate) free_vram_mib: Option<u64>,
    /// 已加载语义模型实际采用的执行路径，而不是仅凭硬件推测的能力。
    pub(crate) active_model_device: String,
    pub(crate) active_model_device_label: String,
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

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn parse_nvidia_smi_line(line: &str) -> Result<(String, String, u64, u64), String> {
    let mut fields = line.rsplitn(4, ',').map(str::trim);
    let free_vram_mib = fields
        .next()
        .ok_or_else(|| "NVIDIA 驱动没有返回空闲显存".to_string())?
        .parse::<u64>()
        .map_err(|_| "NVIDIA 驱动返回的空闲显存无法识别".to_string())?;
    let total_vram_mib = fields
        .next()
        .ok_or_else(|| "NVIDIA 驱动没有返回总显存".to_string())?
        .parse::<u64>()
        .map_err(|_| "NVIDIA 驱动返回的总显存无法识别".to_string())?;
    let driver = fields
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "NVIDIA 驱动没有返回驱动版本".to_string())?;
    let name = fields
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "NVIDIA 驱动没有返回设备名称".to_string())?;
    Ok((
        name.to_string(),
        driver.to_string(),
        total_vram_mib,
        free_vram_mib,
    ))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn query_nvidia_smi() -> Result<(String, String, u64, u64), String> {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=name,driver_version,memory.total,memory.free",
        "--format=csv,noheader,nounits",
    ]);
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
    parse_nvidia_smi_line(line)
}

#[cfg(target_os = "windows")]
const PROVIDER_FILES: &[&str] = &[
    "onnxruntime_providers_cuda.dll",
    "onnxruntime_providers_shared.dll",
];
#[cfg(target_os = "linux")]
const PROVIDER_FILES: &[&str] = &[
    "libonnxruntime_providers_cuda.so",
    "libonnxruntime_providers_shared.so",
];

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn provider_component_present_in(dir: &std::path::Path) -> bool {
    // 文件尺寸会随 ONNX Runtime 补丁和构建方式变化，不能作为版本身份。
    // 此处只做廉价先验；随后 `cuda_runtime_ready` 的真实 Provider 注册才是
    // 是否可用的权威判断。
    PROVIDER_FILES.iter().all(|name| {
        std::fs::metadata(dir.join(name))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    })
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn provider_component_present() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .is_some_and(|dir| provider_component_present_in(&dir))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn cuda_runtime_ready() -> Result<(), String> {
    use ort::ep::ExecutionProvider;

    super::gpu_runtime::prepare()?;
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
/// FastEmbed 创建会话时使用的 CUDA Provider。这里要求注册失败必须返回
/// 错误；模型层捕获错误后会用同一模型显式重试 CPU，因而状态不会把静默
/// 回退误报为正在使用 GPU。
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn strict_cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    let supported = query_nvidia_smi()
        .map(|(_, driver, _, _)| driver_meets_minimum(&driver, MIN_CUDA_12_DRIVER))
        .unwrap_or(false);
    if !supported || !provider_component_present() {
        return Vec::new();
    }
    if let Err(error) = super::gpu_runtime::prepare() {
        crate::log(&format!(
            "semantic_gpu local_runtime_prepare_failed fallback=cpu error={error}"
        ));
        return Vec::new();
    }
    vec![ort::ep::CUDA::default().build().error_on_failure()]
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(super) fn strict_cuda_execution_providers() -> Vec<fastembed::ExecutionProviderDispatch> {
    Vec::new()
}

fn semantic_gpu_status_blocking() -> SemanticGpuStatus {
    let active_device = super::model::effective_runtime_device();
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
            total_vram_mib: None,
            free_vram_mib: None,
            active_model_device: active_device.id().into(),
            active_model_device_label: active_device.label().into(),
            message: "当前平台不支持 NVIDIA CUDA 加速，语义模型使用 CPU。".into(),
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    match query_nvidia_smi() {
        Ok((name, driver, total_vram_mib, free_vram_mib))
            if !driver_meets_minimum(&driver, MIN_CUDA_12_DRIVER) =>
        {
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
                total_vram_mib: Some(total_vram_mib),
                free_vram_mib: Some(free_vram_mib),
                active_model_device: active_device.id().into(),
                active_model_device_label: active_device.label().into(),
                message: format!(
                    "已检测到 NVIDIA GPU，但驱动 {driver} 低于 CUDA 12 所需版本 {minimum}，当前使用 CPU。"
                ),
            }
        }
        Ok((name, driver, total_vram_mib, free_vram_mib)) => {
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
                    format!(
                        "已检测到 {name}（驱动 {driver}）。已在本机其他软件中找到完整 CUDA 12/cuDNN 9 组件，可点击加载；加载前仍使用 CPU。详情：{detail}"
                    )
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
                total_vram_mib: Some(total_vram_mib),
                free_vram_mib: Some(free_vram_mib),
                active_model_device: active_device.id().into(),
                active_model_device_label: active_device.label().into(),
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
            total_vram_mib: None,
            free_vram_mib: None,
            active_model_device: active_device.id().into(),
            active_model_device_label: active_device.label().into(),
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
    use super::{
        cuda_runtime_error_summary, driver_meets_minimum, parse_nvidia_smi_line,
        semantic_gpu_status_blocking,
    };

    #[test]
    fn parses_gpu_identity_and_memory_from_one_nvidia_smi_sample() {
        assert_eq!(
            parse_nvidia_smi_line("NVIDIA GeForce RTX 5070 Ti, 610.47, 16303, 7133").unwrap(),
            (
                "NVIDIA GeForce RTX 5070 Ti".into(),
                "610.47".into(),
                16_303,
                7_133,
            )
        );
    }

    #[test]
    fn rejects_incomplete_or_non_numeric_gpu_memory_samples() {
        assert!(parse_nvidia_smi_line("NVIDIA GPU, 610.47, 16303").is_err());
        assert!(parse_nvidia_smi_line("NVIDIA GPU, 610.47, total, free").is_err());
    }

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

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    #[test]
    fn provider_preflight_accepts_nonempty_files_without_pinning_brittle_sizes() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-semantic-provider-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in super::PROVIDER_FILES {
            std::fs::write(dir.join(name), b"runtime-version-specific").unwrap();
        }
        assert!(super::provider_component_present_in(&dir));
        std::fs::write(dir.join(super::PROVIDER_FILES[0]), []).unwrap();
        assert!(!super::provider_component_present_in(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }
}
