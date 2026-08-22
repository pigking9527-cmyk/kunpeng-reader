//! Pure task classification, lifecycle state, and progress value objects.
//!
//! The parent module owns scheduling, locks, persistence, and RAII.  This
//! module only defines stable values and their policy so registry callers keep
//! the same public `crate::background_tasks` API without coupling to those
//! runtime concerns.

use serde::{Deserialize, Serialize};

/// 统一登记的长任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskKind {
    SemanticModel,
    SemanticVectors,
    Accelerator,
    MultiProfile,
    /// Persistent full-text/Bloom index. It is independent of semantic
    /// vectors and can resume at a completed-book boundary.
    FullTextIndex,
    /// Renderer-side whole-book page measurement, mirrored here so the task
    /// center can expose its lifecycle consistently across platforms.
    PageCount,
    /// Cover extraction or thumbnail regeneration.
    CoverGeneration,
    /// Local, opt-in AI classification for library question-answering. The
    /// generated profiles stay in local metadata and are only retrieval/model
    /// hints; they never become normal shelf tags.
    LibraryClassification,
    Import,
    Sync,
}

impl BackgroundTaskKind {
    pub(super) fn id_prefix(self) -> &'static str {
        match self {
            Self::SemanticModel => "semantic_model",
            Self::SemanticVectors => "semantic_vectors",
            Self::Accelerator => "accelerator",
            Self::MultiProfile => "multi_profile",
            Self::FullTextIndex => "full_text_index",
            Self::PageCount => "page_count",
            Self::CoverGeneration => "cover_generation",
            Self::LibraryClassification => "library_classification",
            Self::Import => "import",
            Self::Sync => "sync",
        }
    }

    pub(crate) fn is_high_cost(self) -> bool {
        matches!(
            self,
            Self::SemanticModel
                | Self::SemanticVectors
                | Self::Accelerator
                | Self::MultiProfile
                | Self::FullTextIndex
                | Self::PageCount
                | Self::CoverGeneration
                | Self::LibraryClassification
        )
    }

    pub(super) fn supports_resume(self) -> bool {
        // Library classification checkpoints each completed book in SQLite and
        // in this registry. It is safe to reconstruct its remaining work after
        // an application restart; treating it as unresumable caused the next
        // click to look like a fresh 0/total pass.
        !matches!(self, Self::Import)
    }
}

/// 对外可见的统一任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskState {
    Queued,
    Running,
    Pausing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl BackgroundTaskState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::Pausing | Self::Paused
        )
    }
}

/// 工作线程在安全边界应采取的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskControlSignal {
    Continue,
    Pause,
    Cancel,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskProgress {
    pub done: u64,
    pub total: u64,
}

impl TaskProgress {
    pub fn fraction(self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            (self.done.min(self.total) as f64) / (self.total as f64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_kind_policy_truth_table_is_complete_and_stable() {
        let cases = [
            (
                BackgroundTaskKind::SemanticModel,
                "semantic_model",
                true,
                true,
            ),
            (
                BackgroundTaskKind::SemanticVectors,
                "semantic_vectors",
                true,
                true,
            ),
            (BackgroundTaskKind::Accelerator, "accelerator", true, true),
            (
                BackgroundTaskKind::MultiProfile,
                "multi_profile",
                true,
                true,
            ),
            (
                BackgroundTaskKind::FullTextIndex,
                "full_text_index",
                true,
                true,
            ),
            (BackgroundTaskKind::PageCount, "page_count", true, true),
            (
                BackgroundTaskKind::CoverGeneration,
                "cover_generation",
                true,
                true,
            ),
            (
                BackgroundTaskKind::LibraryClassification,
                "library_classification",
                true,
                true,
            ),
            (BackgroundTaskKind::Import, "import", false, false),
            (BackgroundTaskKind::Sync, "sync", false, true),
        ];

        for (kind, serialized, high_cost, supports_resume) in cases {
            assert_eq!(kind.id_prefix(), serialized);
            assert_eq!(kind.is_high_cost(), high_cost);
            assert_eq!(kind.supports_resume(), supports_resume);
            assert_eq!(
                serde_json::to_string(&kind).unwrap(),
                format!("\"{serialized}\"")
            );
        }
    }

    #[test]
    fn task_state_policy_truth_table_and_snake_case_are_complete() {
        let cases = [
            (BackgroundTaskState::Queued, "queued", false, true),
            (BackgroundTaskState::Running, "running", false, true),
            (BackgroundTaskState::Pausing, "pausing", false, true),
            (BackgroundTaskState::Paused, "paused", false, true),
            (BackgroundTaskState::Completed, "completed", true, false),
            (BackgroundTaskState::Failed, "failed", true, false),
            (BackgroundTaskState::Cancelled, "cancelled", true, false),
        ];

        for (state, serialized, terminal, active) in cases {
            assert_eq!(state.is_terminal(), terminal);
            assert_eq!(state.is_active(), active);
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{serialized}\"")
            );
        }
    }

    #[test]
    fn progress_fraction_handles_unknown_total_and_clamps_completion() {
        let cases = [
            (TaskProgress { done: 0, total: 0 }, 0.0),
            (TaskProgress { done: 9, total: 0 }, 0.0),
            (TaskProgress { done: 0, total: 10 }, 0.0),
            (TaskProgress { done: 5, total: 10 }, 0.5),
            (
                TaskProgress {
                    done: 12,
                    total: 10,
                },
                1.0,
            ),
        ];

        for (progress, expected) in cases {
            assert!((progress.fraction() - expected).abs() < f64::EPSILON);
        }
    }
}
