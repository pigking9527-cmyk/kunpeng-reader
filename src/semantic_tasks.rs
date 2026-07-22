//! 语义后台任务的共享生命周期。
//!
//! 任务状态不再与向量编码、磁盘索引、查询算法混在一个模块里。后续导入或同步
//! 需要相同的“启动-排他-结束-错误可见”规则时可直接复用这一层。

use crate::{
    background_tasks::{BackgroundTaskKind, TaskHandle},
    semantic::clear_sem_status_cache,
    AppState,
};
use serde::Serialize;

#[derive(Default, Clone, Serialize)]
pub(crate) struct SemProgress {
    pub(crate) building: bool,
    pub(crate) model_downloading: bool,
    pub(crate) vector_pause_requested: bool,
    pub(crate) vector_paused: bool,
    pub(crate) status_refreshing: bool,
    pub(crate) active_task: String,
    pub(crate) background_task_id: String,
    pub(crate) done: u32,
    pub(crate) total: u32,
    pub(crate) shard_done: u32,
    pub(crate) shard_total: u32,
    pub(crate) model_ready: bool,
    pub(crate) model_id: String,
    pub(crate) model_label: String,
    pub(crate) model_supported: bool,
    pub(crate) model_path: String,
    pub(crate) model_bytes: u64,
    pub(crate) semantic_done: u32,
    pub(crate) semantic_total: u32,
    pub(crate) semantic_ready: bool,
    pub(crate) semantic_bytes: u64,
    pub(crate) accelerator_done: u32,
    pub(crate) accelerator_total: u32,
    pub(crate) accelerator_ready: bool,
    pub(crate) accelerator_resumable: bool,
    pub(crate) accelerator_bytes: u64,
    pub(crate) multi_profile_done: u32,
    pub(crate) multi_profile_total: u32,
    pub(crate) multi_profile_ready: bool,
    pub(crate) multi_profile_bytes: u64,
    pub(crate) current: String,
    pub(crate) error: String,
}

/// 所有长任务的排他入口：在工作线程启动前发布可观察快照。
pub(crate) fn begin_semantic_task(
    state: &AppState,
    task_id: &str,
    current: &str,
    model_download: bool,
) -> Result<TaskHandle, String> {
    let mut progress = state
        .sem_progress
        .lock()
        .map_err(|_| "语义任务状态锁定失败")?;
    if progress.building || progress.model_downloading {
        return Err("索引或模型任务正在运行，请稍候".into());
    }
    let kind = match task_id {
        "semantic_model" => BackgroundTaskKind::SemanticModel,
        "semantic_accelerator" => BackgroundTaskKind::Accelerator,
        "semantic_multi_profile" => BackgroundTaskKind::MultiProfile,
        _ => BackgroundTaskKind::SemanticVectors,
    };
    let task = state.background_tasks.enqueue_or_resume(kind, current);
    *progress = SemProgress {
        building: !model_download,
        model_downloading: model_download,
        active_task: task_id.into(),
        background_task_id: task.id().into(),
        current: current.into(),
        ..Default::default()
    };
    drop(progress);
    clear_sem_status_cache();
    Ok(task)
}

/// 所有非暂停结束路径的唯一收口，避免 UI 卡在“运行中”。
pub(crate) fn finish_semantic_task(
    state: &AppState,
    current: impl Into<String>,
    error: Option<String>,
) {
    let current = current.into();
    if let Some(error) = error.as_deref() {
        eprintln!("[semantic] task failed: {error}");
    }
    let mut progress = state
        .sem_progress
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.building = false;
    progress.model_downloading = false;
    progress.active_task.clear();
    progress.background_task_id.clear();
    progress.current = current;
    match error {
        Some(error) => progress.error = error,
        None => progress.error.clear(),
    }
    drop(progress);
    clear_sem_status_cache();
}
