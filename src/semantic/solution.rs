//! 语义模型与检索策略的单文件提交记录。
//!
//! 旧版本分别写 `semantic-model.txt` 和 `semantic-retrieval-mode.txt`，进程在
//! 两次写入之间退出时可能留下不兼容组合。新命令只把这个 JSON 作为提交点；
//! 两个旧文件仅作为向后兼容镜像，不再是新版本的首选事实来源。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

const SEMANTIC_SOLUTION_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(super) struct PersistedSemanticSolution {
    schema_version: u32,
    pub(super) committed_model: String,
    pub(super) committed_retrieval_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_retrieval_mode: Option<String>,
}

impl PersistedSemanticSolution {
    fn new(model_id: &str, retrieval_mode: &str) -> Self {
        Self {
            schema_version: SEMANTIC_SOLUTION_SCHEMA_VERSION,
            committed_model: model_id.to_string(),
            committed_retrieval_mode: retrieval_mode.to_string(),
            pending_model: None,
            pending_retrieval_mode: None,
        }
    }

    fn supported(&self) -> bool {
        self.schema_version == SEMANTIC_SOLUTION_SCHEMA_VERSION
    }
}

fn path() -> Option<PathBuf> {
    let mut path = crate::profile::app_config_dir().or_else(crate::profile::app_cache_dir)?;
    path.push("semantic-solution.json");
    Some(path)
}

/// 串行化一次方案的“持久化提交 + 进程内切换”，避免两个并发 Tauri 命令
/// 各自提交合法组合后又把内存中的模型与模式交叉覆盖。
pub(super) fn transaction_guard() -> MutexGuard<'static, ()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn load() -> Option<PersistedSemanticSolution> {
    let bytes = std::fs::read(path()?).ok()?;
    let solution: PersistedSemanticSolution = serde_json::from_slice(&bytes).ok()?;
    solution.supported().then_some(solution)
}

/// 单次原子替换是模型与检索策略的唯一提交点。调用方必须先完成模型、模式及
/// 组合兼容性校验，不能把未知值写进提交记录。
pub(super) fn commit(model_id: &str, retrieval_mode: &str) -> Result<(), String> {
    if load().is_some_and(|current| {
        current.committed_model == model_id
            && current.committed_retrieval_mode == retrieval_mode
            && current.pending_model.is_none()
            && current.pending_retrieval_mode.is_none()
    }) {
        return Ok(());
    }
    let path = path().ok_or("无法确定智能搜索方案设置路径")?;
    crate::atomic_file::write_json(
        &path,
        &PersistedSemanticSolution::new(model_id, retrieval_mode),
        true,
    )
    .map_err(|error| format!("保存智能搜索方案失败：{error}"))
}

pub(super) fn pending() -> Option<(String, String)> {
    let solution = load()?;
    Some((solution.pending_model?, solution.pending_retrieval_mode?))
}

pub(super) fn stage_pending(
    committed_model: &str,
    committed_retrieval_mode: &str,
    pending_model: &str,
    pending_retrieval_mode: &str,
) -> Result<(), String> {
    let path = path().ok_or("无法确定智能搜索方案设置路径")?;
    let mut solution = PersistedSemanticSolution::new(committed_model, committed_retrieval_mode);
    solution.pending_model = Some(pending_model.into());
    solution.pending_retrieval_mode = Some(pending_retrieval_mode.into());
    crate::atomic_file::write_json(&path, &solution, true)
        .map_err(|error| format!("保存待切换智能搜索方案失败：{error}"))
}

pub(super) fn clear_pending() -> Result<(), String> {
    let Some(mut solution) = load() else {
        return Ok(());
    };
    if solution.pending_model.is_none() && solution.pending_retrieval_mode.is_none() {
        return Ok(());
    }
    solution.pending_model = None;
    solution.pending_retrieval_mode = None;
    let path = path().ok_or("无法确定智能搜索方案设置路径")?;
    crate::atomic_file::write_json(&path, &solution, true)
        .map_err(|error| format!("清理待切换智能搜索方案失败：{error}"))
}

pub(super) fn promote_pending(model_id: &str, retrieval_mode: &str) -> Result<(), String> {
    let current = load().ok_or("待切换智能搜索方案记录不存在")?;
    if current.pending_model.as_deref() != Some(model_id)
        || current.pending_retrieval_mode.as_deref() != Some(retrieval_mode)
    {
        return Err("待切换智能搜索方案已变化，拒绝提交过期建库结果".into());
    }
    commit(model_id, retrieval_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_solution_round_trips_as_one_document() {
        let solution = PersistedSemanticSolution::new("bge-m3", "m3_hybrid");
        let bytes = serde_json::to_vec(&solution).unwrap();
        let decoded: PersistedSemanticSolution = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, solution);
        assert!(decoded.supported());
    }

    #[test]
    fn future_schema_is_not_treated_as_committed() {
        let mut solution = PersistedSemanticSolution::new("bge-m3", "standard");
        solution.schema_version += 1;
        assert!(!solution.supported());
    }

    #[test]
    fn pending_slot_does_not_replace_committed_fields() {
        let mut solution = PersistedSemanticSolution::new("bge-small-zh-v1.5", "standard");
        solution.pending_model = Some("bge-m3".into());
        solution.pending_retrieval_mode = Some("m3_hybrid".into());
        let decoded: PersistedSemanticSolution =
            serde_json::from_slice(&serde_json::to_vec(&solution).unwrap()).unwrap();
        assert_eq!(decoded.committed_model, "bge-small-zh-v1.5");
        assert_eq!(decoded.committed_retrieval_mode, "standard");
        assert_eq!(decoded.pending_model.as_deref(), Some("bge-m3"));
        assert_eq!(decoded.pending_retrieval_mode.as_deref(), Some("m3_hybrid"));
    }
}
