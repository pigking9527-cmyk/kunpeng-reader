//! 通用后台任务注册器。
//!
//! 这里同时拥有后台任务的生命周期、可观察状态和执行调度。调用方先用
//! [`BackgroundTaskRegistry::enqueue`] 建立任务，再通过
//! [`TaskHandle::spawn_detached`] 或 [`TaskHandle::run_blocking`] 交给统一调度器。
//! 工作函数应定期调用 [`TaskRunGuard::control_signal`]，并在安全边界响应暂停或
//! 取消；不应再自行选择 Tokio 或创建系统线程。

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_LOG_LIMIT: usize = 200;
const DEFAULT_FINISHED_TASK_LIMIT: usize = 64;
const MAX_LABEL_CHARS: usize = 256;
const MAX_CURRENT_CHARS: usize = 1_024;
const MAX_CHECKPOINT_CHARS: usize = 4_096;
const MAX_ERROR_CHARS: usize = 4_096;
const MAX_LOG_MESSAGE_CHARS: usize = 2_048;
const PERSISTENCE_VERSION: u32 = 1;
const PERSIST_THROTTLE_MS: u64 = 1_000;
static PERSISTENCE_CLOCK: OnceLock<Instant> = OnceLock::new();
static SHARED_EXECUTOR: OnceLock<Result<Arc<SharedExecutor>, String>> = OnceLock::new();

type ScheduledWorker = Box<dyn FnOnce() + Send + 'static>;

struct ScheduledJob {
    label: String,
    worker: ScheduledWorker,
}

/// 进程内唯一的后台工作池。
///
/// 语义模型本身会在单个任务内部使用 Rayon 并行；这里刻意只保留很少的
/// 调度线程，避免同时启动多项重活时把 CPU、磁盘和内存全部打满。队列中的任务
/// 继续保持 `queued`，因此取消请求可以在真正开始前立即生效。
struct SharedExecutor {
    queue: Mutex<VecDeque<ScheduledJob>>,
    wake: Condvar,
}

impl SharedExecutor {
    fn create() -> Result<Arc<Self>, String> {
        let available = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(2);
        let worker_count = available.saturating_sub(1).clamp(1, 2);
        let executor = Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
        });
        for index in 0..worker_count {
            let shared = Arc::clone(&executor);
            std::thread::Builder::new()
                .name(format!("reader-background-{}", index + 1))
                .spawn(move || shared.worker_loop())
                .map_err(|error| format!("创建共享后台工作线程失败：{error}"))?;
        }
        Ok(executor)
    }

    fn submit(&self, job: ScheduledJob) {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.push_back(job);
        self.wake.notify_one();
    }

    fn worker_loop(&self) {
        loop {
            let job = {
                let mut queue = self
                    .queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while queue.is_empty() {
                    queue = self
                        .wake
                        .wait(queue)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                queue.pop_front().expect("non-empty scheduler queue")
            };
            let label = job.label;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_with_background_priority(job.worker)
            }));
            if result.is_err() {
                crate::log(&format!(
                    "background_task_scheduler panic label={}",
                    truncate_chars(label, MAX_LABEL_CHARS)
                ));
            }
        }
    }
}

fn shared_executor() -> Result<Arc<SharedExecutor>, String> {
    SHARED_EXECUTOR
        .get_or_init(SharedExecutor::create)
        .as_ref()
        .map(Arc::clone)
        .map_err(Clone::clone)
}

/// 统一登记的长任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskKind {
    SemanticModel,
    SemanticVectors,
    Accelerator,
    MultiProfile,
    Import,
    Sync,
}

impl BackgroundTaskKind {
    fn id_prefix(self) -> &'static str {
        match self {
            Self::SemanticModel => "semantic_model",
            Self::SemanticVectors => "semantic_vectors",
            Self::Accelerator => "accelerator",
            Self::MultiProfile => "multi_profile",
            Self::Import => "import",
            Self::Sync => "sync",
        }
    }

    fn supports_resume(self) -> bool {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskLogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskLogEntry {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub level: TaskLogLevel,
    pub message: String,
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

/// 可直接返回给前端的只读任务快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackgroundTaskSnapshot {
    pub id: String,
    pub kind: BackgroundTaskKind,
    pub state: BackgroundTaskState,
    pub label: String,
    pub current: String,
    pub progress: TaskProgress,
    pub checkpoint: Option<String>,
    pub error: Option<String>,
    pub cancel_requested: bool,
    pub pause_requested: bool,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub updated_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub logs: Vec<TaskLogEntry>,
}

/// 工作线程可廉价轮询的取消令牌。
#[derive(Clone, Debug)]
pub struct TaskCancellationToken {
    requested: Arc<AtomicBool>,
}

impl TaskCancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
}

/// 工作线程在安全边界应采取的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskControlSignal {
    Continue,
    Pause,
    Cancel,
}

#[derive(Clone)]
pub struct BackgroundTaskRegistry {
    shared: Arc<RegistryShared>,
}

struct RegistryShared {
    inner: Mutex<RegistryInner>,
    log_limit: usize,
    finished_task_limit: usize,
    persistence_path: Option<PathBuf>,
    /// `Some` means production requested durable task state but it could not
    /// be initialized (or a later atomic write failed).  A plain in-memory
    /// registry created through `new()` intentionally leaves this as `None`
    /// so focused unit tests and non-production callers can still checkpoint.
    durability_unavailable: Mutex<Option<String>>,
    last_persisted_elapsed_ms: AtomicU64,
}

#[derive(Debug)]
enum PersistenceLoadError {
    Io(String),
    Corrupt(String),
    Unsupported(String),
}

impl PersistenceLoadError {
    fn message(&self) -> &str {
        match self {
            Self::Io(message) | Self::Corrupt(message) | Self::Unsupported(message) => message,
        }
    }
}

#[derive(Default)]
struct RegistryInner {
    next_task_sequence: u64,
    tasks: HashMap<String, TaskRecord>,
}

struct TaskRecord {
    sequence: u64,
    id: String,
    kind: BackgroundTaskKind,
    state: BackgroundTaskState,
    label: String,
    current: String,
    progress: TaskProgress,
    checkpoint: Option<String>,
    error: Option<String>,
    cancel_requested: Arc<AtomicBool>,
    pause_requested: Arc<AtomicBool>,
    created_at_ms: u64,
    started_at_ms: Option<u64>,
    updated_at_ms: u64,
    finished_at_ms: Option<u64>,
    next_log_sequence: u64,
    logs: VecDeque<TaskLogEntry>,
}

#[derive(Serialize, Deserialize)]
struct PersistedRegistry {
    version: u32,
    next_task_sequence: u64,
    tasks: Vec<PersistedTaskRecord>,
}

#[derive(Serialize, Deserialize)]
struct PersistedTaskRecord {
    sequence: u64,
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
    fn snapshot(&self) -> BackgroundTaskSnapshot {
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

    fn persisted(&self) -> PersistedTaskRecord {
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

impl Default for BackgroundTaskRegistry {
    fn default() -> Self {
        Self::with_limits(DEFAULT_LOG_LIMIT, DEFAULT_FINISHED_TASK_LIMIT)
    }
}

impl BackgroundTaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Production registry backed by an atomic JSON snapshot beside reader.db.
    /// If persistence cannot be initialized, task execution remains available
    /// in memory, but resumable workers receive an explicit checkpoint error.
    pub fn new_persistent_default() -> Self {
        let Some(mut path) = dirs::config_dir() else {
            let reason = "无法取得系统配置目录";
            crate::log(&format!(
                "background_task_persistence disabled reason={reason}"
            ));
            return Self::with_unavailable_durability(reason);
        };
        path.push("ebook-reader");
        path.push("background-tasks.json");
        Self::new_production_persistent(path)
    }

    fn new_production_persistent(path: PathBuf) -> Self {
        Self::new_production_persistent_with(path, |registry, inner| {
            registry.persist_locked(inner, true)
        })
    }

    fn new_production_persistent_with<F>(path: PathBuf, initial_persist: F) -> Self
    where
        F: FnOnce(&Self, &RegistryInner) -> Result<(), String>,
    {
        let log_limit = DEFAULT_LOG_LIMIT;
        let finished_task_limit = DEFAULT_FINISHED_TASK_LIMIT;
        let mut inner = match load_persisted_registry_classified(&path, log_limit) {
            Ok(inner) => inner,
            Err(PersistenceLoadError::Io(error) | PersistenceLoadError::Unsupported(error)) => {
                crate::log(&format!(
                    "background_task_persistence unavailable error={error}"
                ));
                return Self::with_unavailable_durability(error);
            }
            Err(PersistenceLoadError::Corrupt(error)) => {
                crate::log(&format!(
                    "background_task_persistence corrupt error={error}"
                ));
                let quarantine = path.with_extension(format!("corrupt-{}.json", timestamp_ms()));
                if let Err(rename_error) = std::fs::rename(&path, &quarantine) {
                    let reason = format!("隔离损坏状态失败：{rename_error}");
                    crate::log(&format!(
                        "background_task_persistence quarantine_failed error={rename_error}"
                    ));
                    return Self::with_unavailable_durability(reason);
                }
                crate::log(&format!(
                    "background_task_persistence quarantined path={}",
                    quarantine.display()
                ));
                RegistryInner::default()
            }
        };
        prune_finished(&mut inner, finished_task_limit);
        let registry = Self::from_inner(inner, log_limit, finished_task_limit, Some(path), None);
        let initial_persist = {
            let inner = registry.lock_inner();
            initial_persist(&registry, &inner)
        };
        if let Err(error) = initial_persist {
            registry.mark_durability_unavailable(error.clone());
            crate::log(&format!(
                "background_task_persistence initial_write_failed error={error}"
            ));
        }
        registry
    }

    /// `log_limit` 和 `finished_task_limit` 至少为 1，防止错误配置导致状态完全不可诊断。
    pub fn with_limits(log_limit: usize, finished_task_limit: usize) -> Self {
        Self::from_inner(
            RegistryInner::default(),
            log_limit,
            finished_task_limit,
            None,
            None,
        )
    }

    fn with_unavailable_durability(reason: impl Into<String>) -> Self {
        Self::from_inner(
            RegistryInner::default(),
            DEFAULT_LOG_LIMIT,
            DEFAULT_FINISHED_TASK_LIMIT,
            None,
            Some(reason.into()),
        )
    }

    fn from_inner(
        inner: RegistryInner,
        log_limit: usize,
        finished_task_limit: usize,
        persistence_path: Option<PathBuf>,
        durability_unavailable: Option<String>,
    ) -> Self {
        Self {
            shared: Arc::new(RegistryShared {
                inner: Mutex::new(inner),
                log_limit: log_limit.max(1),
                finished_task_limit: finished_task_limit.max(1),
                persistence_path,
                durability_unavailable: Mutex::new(durability_unavailable),
                last_persisted_elapsed_ms: AtomicU64::new(0),
            }),
        }
    }

    pub fn with_persistence(path: PathBuf) -> Result<Self, String> {
        Self::with_persistence_and_limits(path, DEFAULT_LOG_LIMIT, DEFAULT_FINISHED_TASK_LIMIT)
    }

    fn with_persistence_and_limits(
        path: PathBuf,
        log_limit: usize,
        finished_task_limit: usize,
    ) -> Result<Self, String> {
        let log_limit = log_limit.max(1);
        let finished_task_limit = finished_task_limit.max(1);
        let mut inner = load_persisted_registry(&path, log_limit)?;
        prune_finished(&mut inner, finished_task_limit);
        let registry = Self::from_inner(inner, log_limit, finished_task_limit, Some(path), None);
        {
            let inner = registry.lock_inner();
            registry.persist_locked(&inner, true)?;
        }
        Ok(registry)
    }

    /// 建立一个处于 `queued` 状态的任务。登记本身不会启动线程。
    pub fn enqueue(&self, kind: BackgroundTaskKind, label: impl Into<String>) -> TaskHandle {
        let now = timestamp_ms();
        let mut inner = self.lock_inner();
        inner.next_task_sequence = inner.next_task_sequence.saturating_add(1);
        let sequence = inner.next_task_sequence;
        let id = format!("{}-{now}-{sequence}", kind.id_prefix());
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let pause_requested = Arc::new(AtomicBool::new(false));
        let record = TaskRecord {
            sequence,
            id: id.clone(),
            kind,
            state: BackgroundTaskState::Queued,
            label: truncate_chars(label.into(), MAX_LABEL_CHARS),
            current: String::new(),
            progress: TaskProgress::default(),
            checkpoint: None,
            error: None,
            cancel_requested: Arc::clone(&cancel_requested),
            pause_requested,
            created_at_ms: now,
            started_at_ms: None,
            updated_at_ms: now,
            finished_at_ms: None,
            next_log_sequence: 0,
            logs: VecDeque::new(),
        };
        inner.tasks.insert(id.clone(), record);
        prune_finished(&mut inner, self.shared.finished_task_limit);
        self.persist_best_effort(&inner, true);
        drop(inner);
        TaskHandle {
            id,
            registry: self.clone(),
            cancellation_token: TaskCancellationToken {
                requested: cancel_requested,
            },
        }
    }

    /// Reuse the latest paused task of this kind, preserving its progress,
    /// checkpoint and log history.  Callers rebuild transient worker state from
    /// their durable checkpoint, while the task center keeps one stable id
    /// instead of accumulating a new forever-paused record on every resume.
    pub fn enqueue_or_resume(
        &self,
        kind: BackgroundTaskKind,
        label: impl Into<String>,
    ) -> TaskHandle {
        let label = truncate_chars(label.into(), MAX_LABEL_CHARS);
        let now = timestamp_ms();
        let mut inner = self.lock_inner();
        let latest_paused = inner
            .tasks
            .values()
            .filter(|record| {
                record.kind == kind
                    && record.state == BackgroundTaskState::Paused
                    && !record.cancel_requested.load(Ordering::Acquire)
            })
            .max_by_key(|record| record.sequence)
            .map(|record| record.id.clone());
        if let Some(id) = latest_paused {
            let record = inner
                .tasks
                .get_mut(&id)
                .expect("paused task selected from the same registry");
            record.pause_requested.store(false, Ordering::Release);
            record.state = BackgroundTaskState::Queued;
            record.label = label;
            record.current = "准备从检查点继续".into();
            record.error = None;
            record.finished_at_ms = None;
            record.updated_at_ms = now;
            push_log(
                record,
                self.shared.log_limit,
                TaskLogLevel::Info,
                "任务已从暂停检查点重新排队",
                now,
            );
            let cancellation_token = TaskCancellationToken {
                requested: Arc::clone(&record.cancel_requested),
            };
            self.persist_best_effort(&inner, true);
            drop(inner);
            return TaskHandle {
                id,
                registry: self.clone(),
                cancellation_token,
            };
        }
        drop(inner);
        self.enqueue(kind, label)
    }

    pub fn snapshot(&self, id: &str) -> Option<BackgroundTaskSnapshot> {
        self.lock_inner().tasks.get(id).map(TaskRecord::snapshot)
    }

    /// 按创建顺序返回快照，便于前端保持稳定排序。
    pub fn snapshots(&self) -> Vec<BackgroundTaskSnapshot> {
        let inner = self.lock_inner();
        let mut records: Vec<_> = inner.tasks.values().collect();
        records.sort_by_key(|record| record.sequence);
        records.into_iter().map(TaskRecord::snapshot).collect()
    }

    pub fn active_snapshots(&self) -> Vec<BackgroundTaskSnapshot> {
        self.snapshots()
            .into_iter()
            .filter(|snapshot| snapshot.state.is_active())
            .collect()
    }

    pub fn latest_for_kind(&self, kind: BackgroundTaskKind) -> Option<BackgroundTaskSnapshot> {
        self.lock_inner()
            .tasks
            .values()
            .filter(|record| record.kind == kind)
            .max_by_key(|record| record.sequence)
            .map(TaskRecord::snapshot)
    }

    pub fn request_cancel(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if record.state.is_terminal() {
            return Ok(());
        }
        record.cancel_requested.store(true, Ordering::Release);
        record.pause_requested.store(false, Ordering::Release);
        let now = timestamp_ms();
        record.updated_at_ms = now;
        push_log(
            record,
            self.shared.log_limit,
            TaskLogLevel::Info,
            "已请求取消任务",
            now,
        );
        if matches!(
            record.state,
            BackgroundTaskState::Queued | BackgroundTaskState::Paused
        ) {
            set_terminal(record, BackgroundTaskState::Cancelled, None, now);
        }
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    pub fn request_pause(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if !record.kind.supports_resume() {
            return Err(format!("任务 {id} 不支持暂停；可以取消后重新开始"));
        }
        match record.state {
            BackgroundTaskState::Queued => {
                record.pause_requested.store(true, Ordering::Release);
                record.state = BackgroundTaskState::Paused;
            }
            BackgroundTaskState::Running => {
                record.pause_requested.store(true, Ordering::Release);
                record.state = BackgroundTaskState::Pausing;
            }
            BackgroundTaskState::Pausing | BackgroundTaskState::Paused => return Ok(()),
            state if state.is_terminal() => {
                return Err(format!("任务 {id} 已结束，不能暂停"));
            }
            _ => unreachable!("all task states are covered"),
        }
        let now = timestamp_ms();
        record.updated_at_ms = now;
        push_log(
            record,
            self.shared.log_limit,
            TaskLogLevel::Info,
            "已请求暂停任务",
            now,
        );
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    /// 将已暂停任务放回队列。调用方随后重新安排线程并调用 `start`。
    pub fn resume(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if record.state != BackgroundTaskState::Paused {
            return Err(format!("任务 {id} 当前不是已暂停状态"));
        }
        if record.cancel_requested.load(Ordering::Acquire) {
            return Err(format!("任务 {id} 已请求取消，不能续建"));
        }
        record.pause_requested.store(false, Ordering::Release);
        record.state = BackgroundTaskState::Queued;
        record.updated_at_ms = timestamp_ms();
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    fn start(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if record.state != BackgroundTaskState::Queued {
            return Err(format!("任务 {id} 不是等待运行状态"));
        }
        if record.cancel_requested.load(Ordering::Acquire) {
            let now = timestamp_ms();
            set_terminal(record, BackgroundTaskState::Cancelled, None, now);
            self.persist_best_effort(&inner, true);
            return Err(format!("任务 {id} 已取消"));
        }
        let now = timestamp_ms();
        record.pause_requested.store(false, Ordering::Release);
        record.state = BackgroundTaskState::Running;
        record.started_at_ms.get_or_insert(now);
        record.updated_at_ms = now;
        record.finished_at_ms = None;
        record.error = None;
        push_log(
            record,
            self.shared.log_limit,
            TaskLogLevel::Info,
            "任务开始运行",
            now,
        );
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    fn update_progress(
        &self,
        id: &str,
        done: u64,
        total: u64,
        current: Option<String>,
        checkpoint: Option<String>,
    ) -> Result<(), String> {
        if let Some(checkpoint) = checkpoint.as_ref() {
            let checkpoint_chars = checkpoint.chars().count();
            if checkpoint_chars > MAX_CHECKPOINT_CHARS {
                return Err(format!(
                    "任务检查点过长：{checkpoint_chars} 个字符，最多允许 {MAX_CHECKPOINT_CHARS} 个字符"
                ));
            }
        }
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if !matches!(
            record.state,
            BackgroundTaskState::Running | BackgroundTaskState::Pausing
        ) {
            return Err(format!("任务 {id} 当前不能更新进度"));
        }
        let durable_checkpoint = checkpoint.is_some();
        let previous = durable_checkpoint.then(|| {
            (
                record.progress,
                record.current.clone(),
                record.checkpoint.clone(),
                record.updated_at_ms,
            )
        });
        record.progress = TaskProgress {
            done: if total == 0 { done } else { done.min(total) },
            total,
        };
        if let Some(current) = current {
            record.current = truncate_chars(current, MAX_CURRENT_CHARS);
        }
        if let Some(checkpoint) = checkpoint {
            record.checkpoint = Some(checkpoint);
        }
        record.updated_at_ms = timestamp_ms();
        if durable_checkpoint {
            // A caller that advertises resumability must know when the durable
            // checkpoint could not be written; otherwise the UI can claim a
            // resume point that disappears after a crash.
            if let Err(error) = self.persist_locked(&inner, true) {
                if let Some((progress, current, checkpoint, updated_at_ms)) = previous {
                    let record = find_record_mut(&mut inner, id)?;
                    record.progress = progress;
                    record.current = current;
                    record.checkpoint = checkpoint;
                    record.updated_at_ms = updated_at_ms;
                }
                return Err(error);
            }
        } else {
            self.persist_best_effort(&inner, false);
        }
        Ok(())
    }

    fn append_log(
        &self,
        id: &str,
        level: TaskLogLevel,
        message: impl Into<String>,
    ) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        let now = timestamp_ms();
        push_log(record, self.shared.log_limit, level, message.into(), now);
        record.updated_at_ms = now;
        self.persist_best_effort(&inner, false);
        Ok(())
    }

    fn acknowledge_pause(&self, id: &str) -> Result<(), String> {
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if !matches!(
            record.state,
            BackgroundTaskState::Running | BackgroundTaskState::Pausing
        ) {
            return Err(format!("任务 {id} 当前不能进入暂停状态"));
        }
        record.pause_requested.store(true, Ordering::Release);
        record.state = BackgroundTaskState::Paused;
        record.updated_at_ms = timestamp_ms();
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    fn finish(
        &self,
        id: &str,
        state: BackgroundTaskState,
        error: Option<String>,
    ) -> Result<(), String> {
        debug_assert!(state.is_terminal());
        let mut inner = self.lock_inner();
        let record = find_record_mut(&mut inner, id)?;
        if record.state.is_terminal() {
            return Ok(());
        }
        let now = timestamp_ms();
        set_terminal(record, state, error, now);
        let (level, message) = match state {
            BackgroundTaskState::Completed => (TaskLogLevel::Info, "任务已完成"),
            BackgroundTaskState::Failed => (TaskLogLevel::Error, "任务失败"),
            BackgroundTaskState::Cancelled => (TaskLogLevel::Info, "任务已取消"),
            _ => unreachable!("finish only accepts terminal states"),
        };
        push_log(record, self.shared.log_limit, level, message, now);
        prune_finished(&mut inner, self.shared.finished_task_limit);
        self.persist_best_effort(&inner, true);
        Ok(())
    }

    fn persist_best_effort(&self, inner: &RegistryInner, force: bool) {
        // Initialization and the first failed write already record the reason.
        // Batch-level progress can be very frequent, so do not turn a known
        // disk outage into an unbounded debug.log stream.
        if self.durability_unavailable_reason().is_some() {
            return;
        }
        if let Err(error) = self.persist_locked(inner, force) {
            crate::log(&format!(
                "background_task_persistence write_failed error={error}"
            ));
        }
    }

    fn persist_locked(&self, inner: &RegistryInner, force: bool) -> Result<(), String> {
        if let Some(reason) = self.durability_unavailable_reason() {
            return Err(format!("后台任务持久化不可用：{reason}"));
        }
        let Some(path) = self.shared.persistence_path.as_deref() else {
            return Ok(());
        };
        // Throttling is process-local, so use a monotonic clock. Wall-clock
        // corrections must never suppress persistence for an arbitrary time.
        let now = persistence_elapsed_ms();
        let previous = self
            .shared
            .last_persisted_elapsed_ms
            .load(Ordering::Acquire);
        if !force && now.saturating_sub(previous) < PERSIST_THROTTLE_MS {
            return Ok(());
        }
        let mut tasks: Vec<_> = inner.tasks.values().map(TaskRecord::persisted).collect();
        tasks.sort_by_key(|record| record.sequence);
        if let Err(error) = crate::atomic_file::write_json(
            path,
            &PersistedRegistry {
                version: PERSISTENCE_VERSION,
                next_task_sequence: inner.next_task_sequence,
                tasks,
            },
            false,
        ) {
            self.mark_durability_unavailable(error.clone());
            return Err(error);
        }
        self.shared
            .last_persisted_elapsed_ms
            .store(now, Ordering::Release);
        Ok(())
    }

    fn mark_durability_unavailable(&self, reason: String) {
        *self
            .shared
            .durability_unavailable
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason);
    }

    fn durability_unavailable_reason(&self) -> Option<String> {
        self.shared
            .durability_unavailable
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.shared
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 可跨线程移动和复制的任务句柄。
#[derive(Clone)]
pub struct TaskHandle {
    id: String,
    registry: BackgroundTaskRegistry,
    cancellation_token: TaskCancellationToken,
}

impl TaskHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn cancellation_token(&self) -> TaskCancellationToken {
        self.cancellation_token.clone()
    }

    pub fn snapshot(&self) -> Option<BackgroundTaskSnapshot> {
        self.registry.snapshot(&self.id)
    }

    pub fn request_cancel(&self) -> Result<(), String> {
        self.registry.request_cancel(&self.id)
    }

    pub fn request_pause(&self) -> Result<(), String> {
        self.registry.request_pause(&self.id)
    }

    pub fn resume(&self) -> Result<(), String> {
        self.registry.resume(&self.id)
    }

    /// 线程真正开始执行任务时取得 RAII guard。
    fn start(&self) -> Result<TaskRunGuard, String> {
        self.registry.start(&self.id)?;
        Ok(TaskRunGuard {
            handle: self.clone(),
            resolved: false,
        })
    }

    /// 在统一的固定大小工作池中执行无需等待返回值的长任务。
    ///
    /// 调度器负责排队和后台优先级；任务函数只负责业务检查点和最终状态。若任务
    /// 函数 panic，`TaskRunGuard` 的 RAII 收口会将任务标记失败。
    pub fn spawn_detached<F>(self, thread_name: impl Into<String>, worker: F) -> Result<(), String>
    where
        F: FnOnce(TaskRunGuard) + Send + 'static,
    {
        let executor = match shared_executor() {
            Ok(executor) => executor,
            Err(error) => {
                let _ = self.registry.finish(
                    self.id(),
                    BackgroundTaskState::Failed,
                    Some(error.clone()),
                );
                return Err(error);
            }
        };
        let label = truncate_chars(thread_name.into(), MAX_LABEL_CHARS);
        let task_handle = self.clone();
        executor.submit(ScheduledJob {
            label,
            worker: Box::new(move || match task_handle.start() {
                Ok(task) => worker(task),
                Err(error) => {
                    if task_handle
                        .snapshot()
                        .is_some_and(|snapshot| !snapshot.state.is_terminal())
                    {
                        let _ = task_handle.registry.finish(
                            task_handle.id(),
                            BackgroundTaskState::Failed,
                            Some(error),
                        );
                    }
                }
            }),
        });
        Ok(())
    }

    /// 在同一固定大小工作池中执行需要把结果返回给命令调用方的长任务。
    ///
    /// 和 `spawn_detached` 一样，这里统一排队、获取运行 guard 并设置后台优先级；
    /// 结果通过一次性通道异步返回，不占用 Tauri 的异步执行线程。
    pub async fn run_blocking<T, F>(self, worker: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(TaskRunGuard) -> Result<T, String> + Send + 'static,
    {
        let executor = match shared_executor() {
            Ok(executor) => executor,
            Err(error) => {
                let _ = self.registry.finish(
                    self.id(),
                    BackgroundTaskState::Failed,
                    Some(error.clone()),
                );
                return Err(error);
            }
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let task_handle = self.clone();
        let label = self
            .snapshot()
            .map(|snapshot| snapshot.label)
            .unwrap_or_else(|| self.id().to_owned());
        executor.submit(ScheduledJob {
            label,
            worker: Box::new(move || {
                let result = match task_handle.start() {
                    Ok(task) => worker(task),
                    Err(error) => Err(error),
                };
                let _ = sender.send(result);
            }),
        });
        receiver
            .await
            .map_err(|_| "后台任务异常终止，未返回结果".to_string())?
    }
}

struct BackgroundPriorityGuard;

impl Drop for BackgroundPriorityGuard {
    fn drop(&mut self) {
        crate::set_thread_background(false);
    }
}

fn run_with_background_priority<T>(worker: impl FnOnce() -> T) -> T {
    crate::set_thread_background(true);
    let _priority = BackgroundPriorityGuard;
    worker()
}

/// 任务运行期 guard。
///
/// 正常路径必须调用 `complete`、`fail`、`cancel` 或 `pause`。若调用方提前返回，
/// Drop 会自动标记失败；若正在展开 panic，则记录为 panic 失败；若此前收到了暂停或
/// 取消请求，则分别落到 `paused` 或 `cancelled`，不会永久残留 `running`。
pub struct TaskRunGuard {
    handle: TaskHandle,
    resolved: bool,
}

impl TaskRunGuard {
    pub fn id(&self) -> &str {
        self.handle.id()
    }

    pub fn cancellation_token(&self) -> TaskCancellationToken {
        self.handle.cancellation_token()
    }

    pub fn control_signal(&self) -> TaskControlSignal {
        let Some(snapshot) = self.handle.snapshot() else {
            return TaskControlSignal::Cancel;
        };
        if snapshot.cancel_requested {
            TaskControlSignal::Cancel
        } else if snapshot.pause_requested || snapshot.state == BackgroundTaskState::Pausing {
            TaskControlSignal::Pause
        } else {
            TaskControlSignal::Continue
        }
    }

    pub fn update_progress(
        &self,
        done: u64,
        total: u64,
        current: impl Into<String>,
    ) -> Result<(), String> {
        self.handle
            .registry
            .update_progress(self.id(), done, total, Some(current.into()), None)
    }

    /// 同时更新可恢复检查点；检查点应是调用方可反序列化的小型字符串（通常 JSON）。
    pub fn checkpoint(
        &self,
        done: u64,
        total: u64,
        current: impl Into<String>,
        checkpoint: impl Into<String>,
    ) -> Result<(), String> {
        self.handle.registry.update_progress(
            self.id(),
            done,
            total,
            Some(current.into()),
            Some(checkpoint.into()),
        )
    }

    pub fn log(&self, level: TaskLogLevel, message: impl Into<String>) -> Result<(), String> {
        self.handle.registry.append_log(self.id(), level, message)
    }

    pub fn complete(mut self) -> Result<(), String> {
        let result = self
            .handle
            .registry
            .finish(self.id(), BackgroundTaskState::Completed, None);
        self.resolved = result.is_ok();
        result
    }

    pub fn fail(mut self, error: impl Into<String>) -> Result<(), String> {
        let error = truncate_chars(error.into(), MAX_ERROR_CHARS);
        let result =
            self.handle
                .registry
                .finish(self.id(), BackgroundTaskState::Failed, Some(error));
        self.resolved = result.is_ok();
        result
    }

    pub fn cancel(mut self) -> Result<(), String> {
        let result = self
            .handle
            .registry
            .finish(self.id(), BackgroundTaskState::Cancelled, None);
        self.resolved = result.is_ok();
        result
    }

    pub fn pause(mut self) -> Result<(), String> {
        let result = self.handle.registry.acknowledge_pause(self.id());
        self.resolved = result.is_ok();
        result
    }
}

impl Drop for TaskRunGuard {
    fn drop(&mut self) {
        if self.resolved {
            return;
        }
        let Some(snapshot) = self.handle.snapshot() else {
            return;
        };
        if snapshot.state.is_terminal() || snapshot.state == BackgroundTaskState::Paused {
            return;
        }
        let result = if snapshot.cancel_requested {
            self.handle
                .registry
                .finish(self.id(), BackgroundTaskState::Cancelled, None)
        } else if snapshot.pause_requested || snapshot.state == BackgroundTaskState::Pausing {
            self.handle.registry.acknowledge_pause(self.id())
        } else {
            let error = if std::thread::panicking() {
                "后台任务发生未捕获的 panic"
            } else {
                "后台任务提前返回，未上报完成状态"
            };
            self.handle
                .registry
                .finish(self.id(), BackgroundTaskState::Failed, Some(error.into()))
        };
        if let Err(error) = result {
            eprintln!(
                "[background-task] guard cleanup failed for {}: {error}",
                self.id()
            );
        }
    }
}

fn load_persisted_registry(path: &Path, log_limit: usize) -> Result<RegistryInner, String> {
    load_persisted_registry_classified(path, log_limit).map_err(|error| error.message().to_owned())
}

fn load_persisted_registry_classified(
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

fn find_record_mut<'a>(
    inner: &'a mut RegistryInner,
    id: &str,
) -> Result<&'a mut TaskRecord, String> {
    inner
        .tasks
        .get_mut(id)
        .ok_or_else(|| format!("未找到后台任务 {id}"))
}

fn set_terminal(
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

fn push_log(
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

fn prune_finished(inner: &mut RegistryInner, limit: usize) {
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

fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn persistence_elapsed_ms() -> u64 {
    PERSISTENCE_CLOCK
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn state(handle: &TaskHandle) -> BackgroundTaskState {
        handle.snapshot().expect("task snapshot").state
    }

    #[test]
    fn kinds_and_states_serialize_as_stable_snake_case_values() {
        assert_eq!(
            serde_json::to_string(&BackgroundTaskKind::SemanticVectors).unwrap(),
            "\"semantic_vectors\""
        );
        assert_eq!(
            serde_json::to_string(&BackgroundTaskKind::SemanticModel).unwrap(),
            "\"semantic_model\""
        );
        assert_eq!(
            serde_json::to_string(&BackgroundTaskState::Pausing).unwrap(),
            "\"pausing\""
        );
    }

    #[test]
    fn all_required_task_kinds_can_be_registered() {
        let registry = BackgroundTaskRegistry::new();
        for kind in [
            BackgroundTaskKind::SemanticModel,
            BackgroundTaskKind::SemanticVectors,
            BackgroundTaskKind::Accelerator,
            BackgroundTaskKind::MultiProfile,
            BackgroundTaskKind::Import,
            BackgroundTaskKind::Sync,
        ] {
            registry.enqueue(kind, kind.id_prefix());
        }
        let snapshots = registry.snapshots();
        assert_eq!(snapshots.len(), 6);
        assert!(snapshots
            .iter()
            .all(|snapshot| snapshot.state == BackgroundTaskState::Queued));
    }

    #[test]
    fn complete_lifecycle_preserves_progress_checkpoint_and_logs() {
        let registry = BackgroundTaskRegistry::with_limits(10, 10);
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立向量");
        let guard = handle.start().unwrap();
        guard
            .checkpoint(7, 10, "第 7 本", r#"{"book_id":7}"#)
            .unwrap();
        guard.log(TaskLogLevel::Info, "向量已写盘").unwrap();
        guard.complete().unwrap();

        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Completed);
        assert_eq!(snapshot.progress, TaskProgress { done: 7, total: 10 });
        assert_eq!(snapshot.checkpoint.as_deref(), Some(r#"{"book_id":7}"#));
        assert_eq!(snapshot.current, "第 7 本");
        assert!(snapshot.started_at_ms.is_some());
        assert!(snapshot.finished_at_ms.is_some());
        assert!(snapshot.logs.iter().any(|log| log.message == "向量已写盘"));
    }

    #[test]
    fn shared_scheduler_owns_worker_start_and_lifecycle() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Accelerator, "建立加速索引");
        let observed = handle.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        handle
            .spawn_detached("shared-task-test", move |task| {
                task.update_progress(1, 1, "完成").unwrap();
                let thread_name = std::thread::current().name().map(str::to_owned);
                task.complete().unwrap();
                sender.send(thread_name).unwrap();
            })
            .unwrap();
        let worker_name = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .expect("shared scheduler worker has a stable name");
        assert!(worker_name.starts_with("reader-background-"));
        assert_eq!(state(&observed), BackgroundTaskState::Completed);
    }

    #[test]
    fn non_resumable_import_rejects_pause_without_changing_state() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Import, "导入图书");
        let error = handle.request_pause().unwrap_err();
        assert!(error.contains("不支持暂停"));
        assert_eq!(state(&handle), BackgroundTaskState::Queued);
    }

    #[test]
    fn shared_scheduler_returns_blocking_results_and_finishes_task() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Sync, "同步");
        let observed = handle.clone();
        let result = tauri::async_runtime::block_on(handle.run_blocking(|task| {
            task.update_progress(3, 3, "完成").unwrap();
            task.complete().unwrap();
            Ok(42_u32)
        }))
        .unwrap();
        assert_eq!(result, 42);
        assert_eq!(state(&observed), BackgroundTaskState::Completed);
    }

    #[test]
    fn running_cancel_is_visible_to_token_and_guard_resolves_cancelled() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Sync, "同步");
        let guard = handle.start().unwrap();
        let token = guard.cancellation_token();
        handle.request_cancel().unwrap();
        assert!(token.is_cancelled());
        assert_eq!(guard.control_signal(), TaskControlSignal::Cancel);
        drop(guard);
        assert_eq!(state(&handle), BackgroundTaskState::Cancelled);
    }

    #[test]
    fn queued_cancel_is_immediately_terminal() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Import, "导入");
        handle.request_cancel().unwrap();
        assert_eq!(state(&handle), BackgroundTaskState::Cancelled);
        assert!(handle.cancellation_token().is_cancelled());
        assert!(handle.start().is_err());
    }

    #[test]
    fn pause_acknowledge_and_resume_form_a_valid_checkpoint_cycle() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Accelerator, "加速索引");
        let guard = handle.start().unwrap();
        guard.checkpoint(2, 6, "第 2 片", "shard=2").unwrap();
        handle.request_pause().unwrap();
        assert_eq!(state(&handle), BackgroundTaskState::Pausing);
        assert_eq!(guard.control_signal(), TaskControlSignal::Pause);
        guard.pause().unwrap();
        assert_eq!(state(&handle), BackgroundTaskState::Paused);

        handle.resume().unwrap();
        assert_eq!(state(&handle), BackgroundTaskState::Queued);
        let resumed = handle.start().unwrap();
        assert_eq!(resumed.control_signal(), TaskControlSignal::Continue);
        resumed.complete().unwrap();
        assert_eq!(state(&handle), BackgroundTaskState::Completed);
        assert_eq!(
            handle.snapshot().unwrap().checkpoint.as_deref(),
            Some("shard=2")
        );
    }

    #[test]
    fn enqueue_or_resume_reuses_paused_id_and_preserves_checkpoint() {
        let registry = BackgroundTaskRegistry::new();
        let first = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立向量");
        let guard = first.start().unwrap();
        guard
            .checkpoint(12, 100, "第 12 本", r#"{"book_id":12}"#)
            .unwrap();
        first.request_pause().unwrap();
        guard.pause().unwrap();

        let resumed =
            registry.enqueue_or_resume(BackgroundTaskKind::SemanticVectors, "续建语义索引");
        assert_eq!(resumed.id(), first.id());
        let snapshot = resumed.snapshot().unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Queued);
        assert_eq!(
            snapshot.progress,
            TaskProgress {
                done: 12,
                total: 100
            }
        );
        assert_eq!(snapshot.checkpoint.as_deref(), Some(r#"{"book_id":12}"#));
        assert!(snapshot
            .logs
            .iter()
            .any(|entry| entry.message.contains("重新排队")));

        resumed.start().unwrap().complete().unwrap();
        assert_eq!(state(&resumed), BackgroundTaskState::Completed);
    }

    #[test]
    fn dropping_unresolved_guard_marks_early_return_as_failed() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::MultiProfile, "多中心画像");
        {
            let _guard = handle.start().unwrap();
        }
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Failed);
        assert!(snapshot.error.unwrap().contains("提前返回"));
    }

    #[test]
    fn guard_marks_task_failed_while_unwinding_a_panic() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "panic test");
        let unwind = catch_unwind(AssertUnwindSafe({
            let handle = handle.clone();
            move || {
                let _guard = handle.start().unwrap();
                panic!("simulated worker panic");
            }
        }));
        assert!(unwind.is_err());
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Failed);
        assert!(snapshot.error.unwrap().contains("panic"));
    }

    #[test]
    fn logs_are_bounded_and_keep_the_newest_entries() {
        let registry = BackgroundTaskRegistry::with_limits(3, 10);
        let handle = registry.enqueue(BackgroundTaskKind::Import, "导入");
        let guard = handle.start().unwrap();
        for index in 0..5 {
            guard
                .log(TaskLogLevel::Info, format!("log-{index}"))
                .unwrap();
        }
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.logs.len(), 3);
        assert_eq!(snapshot.logs[0].message, "log-2");
        assert_eq!(snapshot.logs[2].message, "log-4");
        guard.complete().unwrap();
    }

    #[test]
    fn long_utf8_fields_are_truncated_without_splitting_characters() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Sync, "中".repeat(MAX_LABEL_CHARS + 10));
        let guard = handle.start().unwrap();
        guard.fail("错".repeat(MAX_ERROR_CHARS + 10)).unwrap();
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.label.chars().count(), MAX_LABEL_CHARS);
        assert_eq!(snapshot.error.unwrap().chars().count(), MAX_ERROR_CHARS);
    }

    #[test]
    fn completed_history_is_bounded_but_active_tasks_are_never_pruned() {
        let registry = BackgroundTaskRegistry::with_limits(5, 2);
        let active = registry.enqueue(BackgroundTaskKind::Sync, "active");
        let _active_guard = active.start().unwrap();
        for index in 0..4 {
            let task = registry.enqueue(BackgroundTaskKind::Import, format!("done-{index}"));
            task.start().unwrap().complete().unwrap();
        }
        let snapshots = registry.snapshots();
        assert_eq!(snapshots.len(), 3);
        assert!(registry.snapshot(active.id()).is_some());
        assert_eq!(
            snapshots
                .iter()
                .filter(|snapshot| snapshot.state.is_terminal())
                .count(),
            2
        );
    }

    #[test]
    fn progress_never_exceeds_a_known_total() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::Import, "import");
        let guard = handle.start().unwrap();
        guard.update_progress(12, 10, "overflow").unwrap();
        assert_eq!(
            handle.snapshot().unwrap().progress,
            TaskProgress {
                done: 10,
                total: 10
            }
        );
        guard.complete().unwrap();
    }

    #[test]
    fn persistent_registry_restores_checkpoint_and_reuses_the_same_task_id() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-persist-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        let original_id;
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
            original_id = handle.id().to_string();
            let guard = handle.start().unwrap();
            guard
                .checkpoint(17, 100, "已完成 17 本", r#"{"book_id":17}"#)
                .unwrap();
            handle.request_pause().unwrap();
            guard.pause().unwrap();
        }

        let restored = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
        let snapshot = restored.snapshot(&original_id).unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Paused);
        assert_eq!(
            snapshot.progress,
            TaskProgress {
                done: 17,
                total: 100
            }
        );
        assert_eq!(snapshot.checkpoint.as_deref(), Some(r#"{"book_id":17}"#));
        let resumed =
            restored.enqueue_or_resume(BackgroundTaskKind::SemanticVectors, "续建语义索引");
        assert_eq!(resumed.id(), original_id);
        assert_eq!(
            resumed.snapshot().unwrap().state,
            BackgroundTaskState::Queued
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn durable_checkpoint_reports_persistence_failure_to_worker() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-checkpoint-failure-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
            let guard = handle.start().unwrap();

            // Replace the snapshot file with a directory so the next atomic
            // rename cannot succeed on any supported desktop platform.
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
            let error = guard
                .checkpoint(1, 10, "已完成 1 本", r#"{"book_id":1}"#)
                .unwrap_err();
            assert!(!error.trim().is_empty());
            guard.complete().unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn production_memory_fallback_rejects_durable_checkpoint() {
        let registry = BackgroundTaskRegistry::with_unavailable_durability("injected outage");
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
        let guard = handle.start().unwrap();
        let error = guard
            .checkpoint(1, 10, "已完成 1 本", r#"{"book_id":1}"#)
            .unwrap_err();
        assert!(error.contains("持久化不可用"));
        assert!(error.contains("injected outage"));
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.progress, TaskProgress::default());
        assert!(snapshot.checkpoint.is_none());
        guard.complete().unwrap();
    }

    #[test]
    fn oversized_checkpoint_is_rejected_without_truncation_or_state_change() {
        let registry = BackgroundTaskRegistry::new();
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
        let guard = handle.start().unwrap();
        guard
            .checkpoint(1, 10, "已完成 1 本", "stable-checkpoint")
            .unwrap();
        let error = guard
            .checkpoint(2, 10, "不应生效", "检".repeat(MAX_CHECKPOINT_CHARS + 1))
            .unwrap_err();
        assert!(error.contains("检查点过长"));
        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.progress, TaskProgress { done: 1, total: 10 });
        assert_eq!(snapshot.current, "已完成 1 本");
        assert_eq!(snapshot.checkpoint.as_deref(), Some("stable-checkpoint"));
        guard.complete().unwrap();
    }

    #[test]
    fn persisted_oversized_checkpoint_is_rejected_as_schema_damage() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-oversized-load-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
            let guard = handle.start().unwrap();
            guard.checkpoint(1, 2, "第一本", "valid").unwrap();
            guard.complete().unwrap();
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["tasks"][0]["checkpoint"] =
            serde_json::Value::String("界".repeat(MAX_CHECKPOINT_CHARS + 1));
        let oversized = serde_json::to_vec(&value).unwrap();
        std::fs::write(&path, &oversized).unwrap();

        let error = BackgroundTaskRegistry::with_persistence(path.clone())
            .err()
            .expect("oversized persisted checkpoint must be rejected");
        assert!(error.contains("检查点过长"));
        assert_eq!(std::fs::read(&path).unwrap(), oversized);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn production_quarantines_corruption_but_preserves_read_failures() {
        let corrupt_dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-corrupt-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        std::fs::create_dir_all(&corrupt_dir).unwrap();
        let corrupt_path = corrupt_dir.join("tasks.json");
        std::fs::write(&corrupt_path, b"{not-json").unwrap();
        let registry = BackgroundTaskRegistry::new_production_persistent(corrupt_path.clone());
        drop(registry);
        assert!(serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(&corrupt_path).unwrap()
        )
        .is_ok());
        assert!(std::fs::read_dir(&corrupt_dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("tasks.corrupt-")
        }));
        std::fs::remove_dir_all(corrupt_dir).unwrap();

        let io_dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-read-failure-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let io_path = io_dir.join("tasks.json");
        std::fs::create_dir_all(&io_path).unwrap();
        let registry = BackgroundTaskRegistry::new_production_persistent(io_path.clone());
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
        let guard = handle.start().unwrap();
        assert!(guard.checkpoint(1, 2, "第一本", "book=1").is_err());
        assert!(io_path.is_dir());
        assert!(!std::fs::read_dir(&io_dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("tasks.corrupt-")
        }));
        guard.complete().unwrap();
        std::fs::remove_dir_all(io_dir).unwrap();
    }

    #[test]
    fn first_write_failure_preserves_valid_snapshot_and_disables_durability() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-first-write-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        let task_id;
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
            task_id = handle.id().to_owned();
            let guard = handle.start().unwrap();
            guard.checkpoint(7, 10, "已完成 7 本", "book=7").unwrap();
            handle.request_pause().unwrap();
            guard.pause().unwrap();
        }
        let valid_snapshot = std::fs::read(&path).unwrap();

        let registry = BackgroundTaskRegistry::new_production_persistent_with(
            path.clone(),
            |_registry, _inner| Err("injected initial write failure".into()),
        );
        assert_eq!(std::fs::read(&path).unwrap(), valid_snapshot);
        let restored = registry.snapshot(&task_id).unwrap();
        assert_eq!(restored.state, BackgroundTaskState::Paused);
        assert_eq!(restored.checkpoint.as_deref(), Some("book=7"));
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
        let guard = handle.start().unwrap();
        let error = guard.checkpoint(1, 2, "第一本", "book=1").unwrap_err();
        assert!(error.contains("injected initial write failure"));
        guard.complete().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsupported_snapshot_version_is_preserved_without_quarantine() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-future-version-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");
        let future = br#"{"version":999,"next_task_sequence":0,"tasks":[]}"#;
        std::fs::write(&path, future).unwrap();

        let registry = BackgroundTaskRegistry::new_production_persistent(path.clone());
        assert_eq!(std::fs::read(&path).unwrap(), future);
        assert!(!std::fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("tasks.corrupt-")
        }));
        let handle = registry.enqueue(BackgroundTaskKind::SemanticVectors, "建立语义索引");
        let guard = handle.start().unwrap();
        let error = guard.checkpoint(1, 2, "第一本", "book=1").unwrap_err();
        assert!(error.contains("不支持的后台任务状态版本"));
        guard.complete().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_running_task_is_normalized_to_paused_after_restart() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-interrupted-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        let task_id;
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::Accelerator, "建立加速索引");
            task_id = handle.id().to_string();
            registry.start(&task_id).unwrap();
            assert_eq!(
                handle.snapshot().unwrap().state,
                BackgroundTaskState::Running
            );
        }

        let restored = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
        let snapshot = restored.snapshot(&task_id).unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Paused);
        assert!(snapshot.pause_requested);
        assert!(snapshot.current.contains("上次退出"));
        assert!(snapshot
            .logs
            .iter()
            .any(|entry| entry.message.contains("未完成")));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_import_is_failed_instead_of_becoming_an_unresumable_pause() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-background-task-import-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let path = dir.join("tasks.json");
        let task_id;
        {
            let registry = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
            let handle = registry.enqueue(BackgroundTaskKind::Import, "导入图书");
            task_id = handle.id().to_string();
            registry.start(&task_id).unwrap();
        }

        let restored = BackgroundTaskRegistry::with_persistence(path.clone()).unwrap();
        let snapshot = restored.snapshot(&task_id).unwrap();
        assert_eq!(snapshot.state, BackgroundTaskState::Failed);
        assert!(!snapshot.pause_requested);
        assert!(snapshot.error.unwrap().contains("不支持跨重启续建"));

        std::fs::remove_dir_all(dir).unwrap();
    }
}
