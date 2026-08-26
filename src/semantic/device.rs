//! 语义模型运行设备策略。
//!
//! 这是用户偏好而不是硬件探测结果：`auto` 可以在 CUDA 初始化失败时回退
//! CPU，`gpu` 必须失败即报错，`cpu` 则完全不尝试注册 CUDA Provider。

use super::{clear_sem_query_cache, clear_sem_status_cache, model};
use crate::AppState;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum SemanticDevicePolicy {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

impl SemanticDevicePolicy {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Gpu => "gpu",
            Self::Cpu => "cpu",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Auto => "自动选择",
            Self::Gpu => "仅 NVIDIA GPU",
            Self::Cpu => "仅 CPU",
        }
    }

    pub(super) fn from_id(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "gpu" => Some(Self::Gpu),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }
}

fn settings_path() -> Option<std::path::PathBuf> {
    let mut path = crate::profile::app_config_dir().or_else(crate::profile::app_cache_dir)?;
    path.push("semantic-device-policy.txt");
    Some(path)
}

fn slot() -> &'static Mutex<SemanticDevicePolicy> {
    static SLOT: OnceLock<Mutex<SemanticDevicePolicy>> = OnceLock::new();
    SLOT.get_or_init(|| {
        let policy = settings_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|value| SemanticDevicePolicy::from_id(&value))
            .unwrap_or_default();
        Mutex::new(policy)
    })
}

pub(super) fn initialize() {
    let policy = active();
    if let Some(path) = settings_path() {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if SemanticDevicePolicy::from_id(&current).is_none() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = crate::atomic_file::write(&path, policy.id().as_bytes());
        }
    }
}

pub(super) fn active() -> SemanticDevicePolicy {
    *slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn select(state: tauri::State<AppState>, value: &str) -> Result<(), String> {
    let policy = SemanticDevicePolicy::from_id(value).ok_or("未知的语义模型运行设备")?;
    {
        let progress = state
            .sem_progress
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if progress.building || progress.model_downloading || progress.reranker_loading {
            return Err("模型或索引任务正在运行，请完成后再切换运行设备".into());
        }
    }
    if policy == active() {
        return Ok(());
    }
    let path = settings_path().ok_or("无法确定运行设备设置路径")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("保存运行设备设置失败：{error}"))?;
    }
    crate::atomic_file::write(&path, policy.id().as_bytes())?;
    *slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = policy;

    // 已加载的 ONNX 会话不能原地更换执行 Provider。这里只卸载阅读器内的
    // 重资源；受管 Qwen 服务会在下一次显式启动时按新策略重建。状态同时
    // 返回设置值与实际设备，因此运行中的服务不会被误报成已经切换。
    model::reset_runtime_for_device_policy(state.inner());
    clear_sem_query_cache();
    clear_sem_status_cache();
    let mut progress = state
        .sem_progress
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.current = format!("已将语义模型运行设备设为{}；下次加载时生效", policy.label());
    progress.error.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_policy_ids_are_stable_and_strict() {
        assert_eq!(
            SemanticDevicePolicy::from_id("auto"),
            Some(SemanticDevicePolicy::Auto)
        );
        assert_eq!(
            SemanticDevicePolicy::from_id(" GPU "),
            Some(SemanticDevicePolicy::Gpu)
        );
        assert_eq!(
            SemanticDevicePolicy::from_id("cpu"),
            Some(SemanticDevicePolicy::Cpu)
        );
        assert_eq!(SemanticDevicePolicy::from_id("cuda"), None);
        assert_eq!(SemanticDevicePolicy::Auto.id(), "auto");
        assert_eq!(SemanticDevicePolicy::Gpu.id(), "gpu");
        assert_eq!(SemanticDevicePolicy::Cpu.id(), "cpu");
    }
}
