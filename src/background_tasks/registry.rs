//! Durable task-registry value objects and normalization rules.
//!
//! This module deliberately has no scheduler, Tauri command, or mutex
//! lifecycle knowledge.  The parent registry owns those concerns and calls
//! these helpers while it already holds its short-lived registry lock.

use super::{
    timestamp_ms, BackgroundTaskKind, BackgroundTaskSnapshot, BackgroundTaskState, TaskLogEntry,
    TaskLogLevel, TaskProgress,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub(super) const MAX_LABEL_CHARS: usize = 256;
pub(super) const MAX_CURRENT_CHARS: usize = 1_024;
pub(super) const MAX_CHECKPOINT_CHARS: usize = 4_096;
pub(super) const MAX_ERROR_CHARS: usize = 4_096;
const MAX_LOG_MESSAGE_CHARS: usize = 2_048;
pub(super) const PERSISTENCE_VERSION: u32 = 1;

#[derive(Debug)]
pub(super) enum PersistenceLoadError {
    Io(String),
    Corrupt(String),
    Unsupported(String),
}

impl PersistenceLoadError {
    pub(super) fn message(&self) -> &str {
        match self {
            Self::Io(message) | Self::Corrupt(message) | Self::Unsupported(message) => message,
        }
    }
}

#[derive(Default)]
pub(super) struct RegistryInner {
    pub(super) next_task_sequence: u64,
    pub(super) tasks: HashMap<String, TaskRecord>,
}

pub(super) struct TaskRecord {
    pub(super) sequence: u64,
    pub(super) id: String,
    pub(super) kind: BackgroundTaskKind,
    pub(super) state: BackgroundTaskState,
    pub(super) label: String,
    pub(super) current: String,
    pub(super) progress: TaskProgress,
    pub(super) checkpoint: Option<String>,
    pub(super) error: Option<String>,
    pub(super) cancel_requested: Arc<AtomicBool>,
    pub(super) pause_requested: Arc<AtomicBool>,
    pub(super) created_at_ms: u64,
    pub(super) started_at_ms: Option<u64>,
    pub(super) updated_at_ms: u64,
    pub(super) finished_at_ms: Option<u64>,
    pub(super) next_log_sequence: u64,
    pub(super) logs: VecDeque<TaskLogEntry>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct PersistedRegistry {
    pub(super) version: u32,
    pub(super) next_task_sequence: u64,
    pub(super) tasks: Vec<PersistedTaskRecord>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct PersistedTaskRecord {
    pub(super) sequence: u64,
    id: String,
    kind: BackgroundTaskKind,
    state: BackgroundTaskState,
    label: String,
    current: String,
    progress: TaskProgress,
    checkpoint: Option<String>,
    error: Option<String>,
    cancel_requested: bool,
    pause_requested: bool,
    created_at_ms: u64,
    started_at_ms: Option<u64>,
    updated_at_ms: u64,
    finished_at_ms: Option<u64>,
    next_log_sequence: u64,
    logs: Vec<TaskLogEntry>,
}

impl TaskRecord {
    pub(super) fn snapshot(&self) -> BackgroundTaskSnapshot {
        BackgroundTaskSnapshot {
            id: self.id.clone(),
            kind: self.kind,
            state: self.state,
            label: self.label.clone(),
            current: self.current.clone(),
            progress: self.progress,
            checkpoint: self.checkpoint.clone(),
            error: self.error.clone(),
            cancel_requested: self.cancel_requested.load(Ordering::Acquire),
            pause_requested: self.pause_requested.load(Ordering::Acquire),
            created_at_ms: self.created_at_ms,
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            finished_at_ms: self.finished_at_ms,
            logs: self.logs.iter().cloned().collect(),
        }
    }

    pub(super) fn persisted(&self) -> PersistedTaskRecord {
        PersistedTaskRecord {
            sequence: self.sequence,
            id: self.id.clone(),
            kind: self.kind,
            state: self.state,
            label: self.label.clone(),
            current: self.current.clone(),
            progress: self.progress,
            checkpoint: self.checkpoint.clone(),
            error: self.error.clone(),
            cancel_requested: self.cancel_requested.load(Ordering::Acquire),
            pause_requested: self.pause_requested.load(Ordering::Acquire),
            created_at_ms: self.created_at_ms,
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            finished_at_ms: self.finished_at_ms,
            next_log_sequence: self.next_log_sequence,
            logs: self.logs.iter().cloned().collect(),
        }
    }
}

impl PersistedTaskRecord {
    fn into_record(mut self, log_limit: usize, now: u64) -> TaskRecord {
        self.next_log_sequence = self.next_log_sequence.max(
            self.logs
                .iter()
                .map(|entry| entry.sequence)
                .max()
                .unwrap_or(0),
        );
        let interrupted = matches!(
            self.state,
            BackgroundTaskState::Queued
                | BackgroundTaskState::Running
                | BackgroundTaskState::Pausing
        );
        if (interrupted || self.state == BackgroundTaskState::Paused)
            && !self.kind.supports_resume()
        {
            self.state = BackgroundTaskState::Failed;
            self.pause_requested = false;
            self.cancel_requested = false;
            self.finished_at_ms = Some(now);
            self.updated_at_ms = now;
            self.current = "应用上次退出，任务未完成，请重新执行".into();
            self.error = Some("此任务不支持跨重启续建".into());
            self.next_log_sequence = self.next_log_sequence.saturating_add(1);
            self.logs.push(TaskLogEntry {
                sequence: self.next_log_sequence,
                timestamp_ms: now,
                level: TaskLogLevel::Error,
                message: "检测到未完成且不可续建的任务，已标记失败".into(),
            });
        } else if interrupted {
            self.state = BackgroundTaskState::Paused;
            self.pause_requested = true;
            self.cancel_requested = false;
            self.finished_at_ms = None;
            self.updated_at_ms = now;
            self.current = "应用上次退出，任务已恢复为暂停，可从检查点续建".into();
            self.next_log_sequence = self.next_log_sequence.saturating_add(1);
            self.logs.push(TaskLogEntry {
                sequence: self.next_log_sequence,
                timestamp_ms: now,
                level: TaskLogLevel::Warning,
                message: "检测到未完成任务，已恢复为暂停状态".into(),
            });
        }
        if self.state == BackgroundTaskState::Paused {
            self.pause_requested = true;
            self.cancel_requested = false;
            self.finished_at_ms = None;
        }
        let mut logs: VecDeque<_> = self.logs.into();
        while logs.len() > log_limit {
            logs.pop_front();
        }
        TaskRecord {
            sequence: self.sequence,
            id: self.id,
            kind: self.kind,
            state: self.state,
            label: truncate_chars(self.label, MAX_LABEL_CHARS),
            current: truncate_chars(self.current, MAX_CURRENT_CHARS),
            progress: TaskProgress {
                done: if self.progress.total == 0 {
                    self.progress.done
                } else {
                    self.progress.done.min(self.progress.total)
                },
                total: self.progress.total,
            },
            checkpoint: self.checkpoint,
            error: self
                .error
                .map(|value| truncate_chars(value, MAX_ERROR_CHARS)),
            cancel_requested: Arc::new(AtomicBool::new(self.cancel_requested)),
            pause_requested: Arc::new(AtomicBool::new(self.pause_requested)),
            created_at_ms: self.created_at_ms,
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            finished_at_ms: self.finished_at_ms,
            next_log_sequence: self.next_log_sequence,
            logs,
        }
    }
}

pub(super) fn load_persisted_registry(
    path: &Path,
    log_limit: usize,
) -> Result<RegistryInner, String> {
    load_persisted_registry_classified(path, log_limit).map_err(|error| error.message().to_owned())
}

pub(super) fn load_persisted_registry_classified(
    path: &Path,
    log_limit: usize,
) -> Result<RegistryInner, PersistenceLoadError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryInner::default());
        }
        Err(error) => {
            return Err(PersistenceLoadError::Io(format!(
                "读取后台任务状态失败（{}）：{error}",
                path.display()
            )));
        }
    };
    let persisted: PersistedRegistry = serde_json::from_slice(&bytes).map_err(|error| {
        PersistenceLoadError::Corrupt(format!(
            "解析后台任务状态失败（{}）：{error}",
            path.display()
        ))
    })?;
    if persisted.version != PERSISTENCE_VERSION {
        return Err(PersistenceLoadError::Unsupported(format!(
            "不支持的后台任务状态版本：{}（当前 {}）",
            persisted.version, PERSISTENCE_VERSION
        )));
    }
    let now = timestamp_ms();
    let mut inner = RegistryInner {
        next_task_sequence: persisted.next_task_sequence,
        tasks: HashMap::new(),
    };
    for persisted_record in persisted.tasks {
        if persisted_record.id.trim().is_empty() {
            return Err(PersistenceLoadError::Corrupt(
                "后台任务状态包含空任务 ID".into(),
            ));
        }
        if let Some(checkpoint) = persisted_record.checkpoint.as_ref() {
            let checkpoint_chars = checkpoint.chars().count();
            if checkpoint_chars > MAX_CHECKPOINT_CHARS {
                return Err(PersistenceLoadError::Corrupt(format!(
                    "后台任务 {} 的检查点过长：{checkpoint_chars} 个字符，最多允许 {MAX_CHECKPOINT_CHARS} 个字符",
                    persisted_record.id
                )));
            }
        }
        let record = persisted_record.into_record(log_limit, now);
        inner.next_task_sequence = inner.next_task_sequence.max(record.sequence);
        if inner.tasks.insert(record.id.clone(), record).is_some() {
            return Err(PersistenceLoadError::Corrupt(
                "后台任务状态包含重复任务 ID".into(),
            ));
        }
    }
    Ok(inner)
}

pub(super) fn find_record_mut<'a>(
    inner: &'a mut RegistryInner,
    id: &str,
) -> Result<&'a mut TaskRecord, String> {
    inner
        .tasks
        .get_mut(id)
        .ok_or_else(|| format!("未找到后台任务 {id}"))
}

pub(super) fn set_terminal(
    record: &mut TaskRecord,
    state: BackgroundTaskState,
    error: Option<String>,
    now: u64,
) {
    record.state = state;
    record.error = error.map(|value| truncate_chars(value, MAX_ERROR_CHARS));
    record.pause_requested.store(false, Ordering::Release);
    if state == BackgroundTaskState::Cancelled {
        record.cancel_requested.store(true, Ordering::Release);
    }
    record.updated_at_ms = now;
    record.finished_at_ms = Some(now);
}

pub(super) fn push_log(
    record: &mut TaskRecord,
    limit: usize,
    level: TaskLogLevel,
    message: impl Into<String>,
    timestamp_ms: u64,
) {
    record.next_log_sequence = record.next_log_sequence.saturating_add(1);
    record.logs.push_back(TaskLogEntry {
        sequence: record.next_log_sequence,
        timestamp_ms,
        level,
        message: truncate_chars(message.into(), MAX_LOG_MESSAGE_CHARS),
    });
    while record.logs.len() > limit {
        record.logs.pop_front();
    }
}

pub(super) fn prune_finished(inner: &mut RegistryInner, limit: usize) {
    let mut finished: Vec<_> = inner
        .tasks
        .values()
        .filter(|record| record.state.is_terminal())
        .map(|record| (record.sequence, record.id.clone()))
        .collect();
    if finished.len() <= limit {
        return;
    }
    finished.sort_by_key(|(sequence, _)| *sequence);
    let remove_count = finished.len() - limit;
    for (_, id) in finished.into_iter().take(remove_count) {
        inner.tasks.remove(&id);
    }
}

pub(super) fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}
