//! NVIDIA GPU 的只读兼容性检测。
//!
//! CUDA 的 ONNX Runtime Provider 必须和主程序内置的 Runtime 版本完全匹配；
//! 因此这里刻意只报告硬件是否合格，不会在没有匹配组件时诱导用户安装任意
//! CUDA/CuDNN 包，避免启动时 DLL 冲突。

use serde::Serialize;
use std::process::Command;

const MIN_CUDA_12_DRIVER: (u32, u32) = (527, 41);

#[derive(Serialize)]
pub(crate) struct SemanticGpuStatus {
    pub(crate) detected: bool,
    /// 硬件和驱动是否满足 CUDA 12 的最低门槛。
    pub(crate) supported: bool,
    /// 是否已有经本程序版本校验的可安装组件。
    pub(crate) component_available: bool,
    pub(crate) name: String,
    pub(crate) driver: String,
    pub(crate) message: String,
}

fn driver_is_supported(value: &str) -> bool {
    let mut parts = value
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    (major, minor) >= MIN_CUDA_12_DRIVER
}

#[cfg(target_os = "windows")]
fn query_nvidia_smi() -> Result<(String, String), String> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
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

/// 本版本没有随程序发布可与 ONNX Runtime 精确配套的 CUDA 扩展包。
/// 发布包到位后，这里应当改为校验其 manifest 和 SHA-256，再开放安装入口。
fn matching_component_available() -> bool {
    false
}

#[tauri::command]
pub(crate) fn semantic_gpu_status() -> SemanticGpuStatus {
    #[cfg(not(target_os = "windows"))]
    {
        return SemanticGpuStatus {
            detected: false,
            supported: false,
            component_available: false,
            name: String::new(),
            driver: String::new(),
            message: "当前平台暂未提供 NVIDIA GPU 加速组件。".into(),
        };
    }

    #[cfg(target_os = "windows")]
    match query_nvidia_smi() {
        Ok((name, driver)) if !driver_is_supported(&driver) => SemanticGpuStatus {
            detected: true,
            supported: false,
            component_available: false,
            name,
            driver: driver.clone(),
            message: format!(
                "已检测到 NVIDIA GPU，但驱动 {driver} 低于所需版本 527.41，不能安装 GPU 加速组件。"
            ),
        },
        Ok((name, driver)) => {
            let component_available = matching_component_available();
            let message = if component_available {
                format!("已检测到 {name}（驱动 {driver}），可以安装 GPU 加速组件。")
            } else {
                format!(
                    "已检测到 {name}（驱动 {driver}）。硬件支持加速；当前版本尚未发布与本程序匹配的组件，因此不能安装。"
                )
            };
            SemanticGpuStatus {
                detected: true,
                supported: true,
                component_available,
                name,
                driver,
                message,
            }
        }
        Err(message) => SemanticGpuStatus {
            detected: false,
            supported: false,
            component_available: false,
            name: String::new(),
            driver: String::new(),
            message: format!("{message}，不能安装 GPU 加速组件。"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::driver_is_supported;

    #[test]
    fn cuda_12_driver_gate_is_explicit() {
        assert!(!driver_is_supported("527.40"));
        assert!(driver_is_supported("527.41"));
        assert!(driver_is_supported("610.47"));
    }
}
