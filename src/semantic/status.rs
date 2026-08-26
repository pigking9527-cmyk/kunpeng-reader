//! 语义索引状态、容量与任务中心 DTO。
//!
//! 状态扫描可能打开数百个索引元数据文件，因此通过短期快照缓存与实时运行态
//! 合并，避免 UI 轮询阻塞模型下载、向量构建或阅读窗口。

use super::{device, m3, model, profile, retrieval, solution};
use crate::background_tasks::{BackgroundTaskKind, BackgroundTaskSnapshot, BackgroundTaskState};
use crate::semantic_tasks::SemProgress;
use crate::{now_ms, set_thread_background, AppState};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const STATUS_CACHE_TTL_MS: u64 = 5 * 60_000;
const STATUS_REFRESH_TIMEOUT_MS: u64 = 15_000;
const SWITCH_STATUS_CHECKING: &str = "正在检查本地模型和语义索引…";

#[derive(Clone, Serialize)]
pub(crate) struct SemanticTaskItem {
    id: String,
    title: String,
    detail: String,
    status: String,
    done: u32,
    total: u32,
    bytes: u64,
    running: bool,
    ready: bool,
    resumable: bool,
    can_start: bool,
    can_delete: bool,
    primary_label: String,
    delete_label: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct SemanticTaskCenter {
    busy: bool,
    status_refreshing: bool,
    current: String,
    error: String,
    tasks: Vec<SemanticTaskItem>,
    progress: SemanticProgressDto,
}

/// 前端稳定状态契约。运行期互斥用的 `background_task_id` 和本机模型绝对路径
/// 不属于 UI 协议，不能随着内部 `SemProgress` 一并泄露。
#[derive(Clone, Serialize)]
pub(crate) struct SemanticProgressDto {
    building: bool,
    model_downloading: bool,
    reranker_loading: bool,
    vector_pause_requested: bool,
    vector_paused: bool,
    status_refreshing: bool,
    active_task: String,
    done: u32,
    total: u32,
    shard_done: u32,
    shard_total: u32,
    model_ready: bool,
    model_id: String,
    model_label: String,
    solution_switching: bool,
    pending_model_id: String,
    pending_model_label: String,
    pending_retrieval_mode: String,
    model_supported: bool,
    model_runtime_device: String,
    model_runtime_device_label: String,
    device_policy: String,
    actual_device: String,
    model_bytes: u64,
    semantic_done: u32,
    semantic_total: u32,
    semantic_ready: bool,
    semantic_bytes: u64,
    accelerator_done: u32,
    accelerator_total: u32,
    accelerator_ready: bool,
    accelerator_resumable: bool,
    accelerator_bytes: u64,
    multi_profile_done: u32,
    multi_profile_total: u32,
    multi_profile_ready: bool,
    multi_profile_bytes: u64,
    retrieval_mode: String,
    retrieval_mode_label: String,
    reranker_ready: bool,
    reranker_downloaded: bool,
    reranker_partial: bool,
    m3_long_context_enabled: bool,
    m3_index_done: u32,
    m3_index_total: u32,
    m3_index_ready: bool,
    current: String,
    error: String,
}

impl From<&SemProgress> for SemanticProgressDto {
    fn from(progress: &SemProgress) -> Self {
        let pending = solution::pending();
        let pending_model = pending
            .as_ref()
            .and_then(|(model_id, _)| model::SemanticModel::from_id(model_id));
        let pending_mode = pending
            .as_ref()
            .and_then(|(_, mode)| retrieval::RetrievalMode::from_id(mode));
        Self {
            building: progress.building,
            model_downloading: progress.model_downloading,
            reranker_loading: progress.reranker_loading,
            vector_pause_requested: progress.vector_pause_requested,
            vector_paused: progress.vector_paused,
            status_refreshing: progress.status_refreshing,
            active_task: progress.active_task.clone(),
            done: progress.done,
            total: progress.total,
            shard_done: progress.shard_done,
            shard_total: progress.shard_total,
            model_ready: progress.model_ready,
            model_id: progress.model_id.clone(),
            model_label: progress.model_label.clone(),
            solution_switching: pending.is_some(),
            pending_model_id: pending
                .as_ref()
                .map(|(model_id, _)| model_id.clone())
                .unwrap_or_default(),
            pending_model_label: pending_model
                .map(|model| model.label().to_string())
                .unwrap_or_default(),
            pending_retrieval_mode: pending_mode
                .map(|mode| mode.id().to_string())
                .unwrap_or_default(),
            model_supported: progress.model_supported,
            model_runtime_device: model::effective_runtime_device().id().into(),
            model_runtime_device_label: model::effective_runtime_device().label().into(),
            device_policy: device::active().id().into(),
            actual_device: model::effective_runtime_device().actual_id().into(),
            model_bytes: progress.model_bytes,
            semantic_done: progress.semantic_done,
            semantic_total: progress.semantic_total,
            semantic_ready: progress.semantic_ready,
            semantic_bytes: progress.semantic_bytes,
            accelerator_done: progress.accelerator_done,
            accelerator_total: progress.accelerator_total,
            accelerator_ready: progress.accelerator_ready,
            accelerator_resumable: progress.accelerator_resumable,
            accelerator_bytes: progress.accelerator_bytes,
            multi_profile_done: progress.multi_profile_done,
            multi_profile_total: progress.multi_profile_total,
            multi_profile_ready: progress.multi_profile_ready,
            multi_profile_bytes: progress.multi_profile_bytes,
            retrieval_mode: retrieval::active_mode().id().into(),
            retrieval_mode_label: retrieval::active_mode().label().into(),
            reranker_ready: progress.reranker_ready,
            reranker_downloaded: retrieval::reranker_available_disk(),
            reranker_partial: retrieval::reranker_download_partial(),
            m3_long_context_enabled: retrieval::long_context_enabled(),
            m3_index_done: if progress.m3_index_done > 0 {
                progress.m3_index_done
            } else {
                m3::indexed_books()
            },
            m3_index_total: if progress.m3_index_total > 0 {
                progress.m3_index_total
            } else {
                m3::indexed_books()
            },
            m3_index_ready: progress.m3_index_ready || m3::is_ready(),
            current: progress.current.clone(),
            error: progress.error.clone(),
        }
    }
}

#[derive(Default)]
struct StatusCache {
    snapshot: Option<SemProgress>,
    refreshing: bool,
    refresh_id: u64,
    refresh_started_at: u64,
    last_attempt_at: u64,
    updated_at: u64,
}

static STATUS_CACHE: OnceLock<Mutex<StatusCache>> = OnceLock::new();

fn cache() -> &'static Mutex<StatusCache> {
    STATUS_CACHE.get_or_init(|| Mutex::new(StatusCache::default()))
}

/// 首屏只能安全地知道书架中有多少本书可建立索引。元数据文件名不代表索引
/// 仍然有效：模型切换、图书移动、旧版格式或损坏文件都可能留下同名文件。
/// 因此后台精确核对完成前绝不预判任何一本已经建立。
fn provisional_semantic_book_total(state: &AppState) -> u32 {
    state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .books
        .iter()
        .filter(|book| book.format != "pdf")
        .count() as u32
}

fn active_vector_task_progress(task: &BackgroundTaskSnapshot) -> Option<u32> {
    // 向量构建会在段落编码期间更新任务的显示进度，但耐久检查点仍保留
    // 已完整完成的书本数；语义页应以它恢复“本”的进度，避免把段数误标成本数。
    task.checkpoint
        .as_deref()
        .and_then(|checkpoint| serde_json::from_str::<serde_json::Value>(checkpoint).ok())
        .and_then(|value| value.get("completed")?.as_u64())
        .and_then(|completed| u32::try_from(completed).ok())
}

/// 后台任务注册表比弹窗内存状态更耐久。弹窗关闭、WebView 重绘或状态快照尚未
/// 建立时，仍应从它恢复运行中或已暂停的语义任务。暂停不是运行态：它必须
/// 恢复为“可续建”，而不是继续禁用续建按钮。
fn hydrate_vector_task(state: &AppState, progress: &mut SemProgress) {
    let Some(task) = state
        .background_tasks
        .snapshots()
        .into_iter()
        .filter(|task| {
            task.kind == BackgroundTaskKind::SemanticVectors
                && matches!(
                    task.state,
                    BackgroundTaskState::Queued
                        | BackgroundTaskState::Running
                        | BackgroundTaskState::Pausing
                        | BackgroundTaskState::Paused
                )
        })
        .max_by_key(|task| task.created_at_ms)
    else {
        return;
    };
    let total = provisional_semantic_book_total(state);
    let completed = active_vector_task_progress(&task)
        .unwrap_or_else(|| u32::try_from(task.progress.done).unwrap_or(u32::MAX))
        .min(total);
    let paused = task.state == BackgroundTaskState::Paused;
    progress.building = !paused;
    progress.active_task = if !paused {
        "semantic_vectors".into()
    } else {
        String::new()
    };
    progress.background_task_id = if !paused { task.id } else { String::new() };
    progress.vector_pause_requested =
        task.state == BackgroundTaskState::Pausing || task.pause_requested;
    progress.vector_paused = paused;
    progress.done = completed;
    progress.total = total;
    progress.semantic_done = completed;
    progress.semantic_total = total;
    progress.semantic_ready = false;
    progress.current = if paused {
        "语义索引已暂停；可从未完成图书继续建立".into()
    } else if !task.current.is_empty() {
        task.current
    } else {
        progress.current.clone()
    };
    progress.error = task.error.unwrap_or_default();
}

fn provisional_snapshot(state: &AppState, mut progress: SemProgress) -> SemProgress {
    let selected = model::active();
    progress.model_id = selected.id().to_string();
    progress.model_label = selected.label().to_string();
    progress.model_supported = selected.locally_supported();
    progress.model_ready = model::available(state);
    progress.model_path = model::model_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    let total = provisional_semantic_book_total(state);
    // 构建线程在每本书完整发布后用严格的 `vector::is_complete` 计数写回
    // `SemProgress`。状态缓存刚被清除时（特别是最后一册完成后），保留这一份
    // 同进程的已验证部分进度，避免 UI 短暂倒退为“尚未建立”。应用重启后这里
    // 仍是默认 0，必须等待后台逐书核对，绝不从文件名猜测完成度。
    progress.semantic_done = progress.semantic_done.min(total);
    progress.semantic_total = total;
    progress.semantic_ready = total > 0 && progress.semantic_done == total;
    progress.accelerator_done = 0;
    progress.accelerator_total = 0;
    progress.accelerator_ready = false;
    progress.accelerator_resumable = false;
    progress.accelerator_bytes = 0;
    progress.multi_profile_done = 0;
    progress.multi_profile_total = 0;
    progress.multi_profile_ready = false;
    progress.multi_profile_bytes = 0;
    if progress.current.contains(SWITCH_STATUS_CHECKING) {
        progress.current = format!("已切换至 {}；正在后台核对索引状态", selected.label());
    }
    progress
}

fn switch_ready_message(label: &str, model_ready: bool, done: u32, total: u32) -> String {
    if !model_ready {
        format!("已切换至 {label}")
    } else if total == 0 {
        format!("已切换至 {label}；模型已就绪，书架暂无可建立语义索引的图书")
    } else if done == total {
        format!("已切换至 {label}；模型和语义索引已就绪")
    } else if done == 0 {
        format!("已切换至 {label}；模型已就绪，请建立语义索引")
    } else {
        format!("已切换至 {label}；模型已就绪，语义索引 {done}/{total} 本，可继续建立")
    }
}

fn settle_switch_status(progress: &mut SemProgress) {
    if !progress.current.contains(SWITCH_STATUS_CHECKING) {
        return;
    }
    progress.current = switch_ready_message(
        model::active().label(),
        progress.model_ready,
        progress.semantic_done,
        progress.semantic_total,
    );
}

fn accelerator_progress(
    ids: &[u64],
    source_sig: &[super::vector::IndexSourceSignature],
) -> (u32, u32, bool, bool) {
    if ids.is_empty() {
        return (0, 0, false, false);
    }
    let total = super::accelerator::estimate_global_shard_total(ids);
    if super::accelerator::global_index_fresh_for_status(ids, source_sig) {
        return (total.max(1), total.max(1), true, false);
    }
    if let Some((done, processed_books)) =
        super::accelerator::build_progress_for_status(ids, source_sig)
    {
        let total = total.max(done);
        return (done, total, false, done > 0 || processed_books > 0);
    }
    (0, total, false, false)
}

fn semantic_asset(name: &str) -> bool {
    name.starts_with("sem_")
}

fn accelerator_asset(name: &str) -> bool {
    name.starts_with("global_")
        || matches!(
            name,
            "global.json" | "global.build.json" | "global.hnsw" | "global.map"
        )
}

fn indexed_bytes(matches: impl Fn(&str) -> bool) -> u64 {
    let Some(dir) = super::sem_dir() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            matches(&name.to_string_lossy())
                .then(|| entry.metadata().ok().map(|meta| meta.len()))?
        })
        .sum()
}

pub(super) fn semantic_index_bytes() -> u64 {
    indexed_bytes(semantic_asset)
}

fn accelerator_index_bytes() -> u64 {
    indexed_bytes(accelerator_asset)
}

fn enrich(state: &AppState, mut progress: SemProgress) -> SemProgress {
    let selected = model::active();
    progress.model_id = selected.id().to_string();
    progress.model_label = selected.label().to_string();
    progress.model_supported = selected.locally_supported();
    let model_path = model::model_dir();
    // 模型缓存目录可能混有历史模型，递归容量既拖慢状态页，也不能准确归属到
    // 当前模型。界面不再展示该歧义数字，状态刷新也不再遍历整个模型缓存。
    progress.model_bytes = 0;
    progress.model_path = model_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    // 状态刷新绝不能排队等待模型下载。下载过程可能持续数十秒，旧实现会让
    // 整个任务中心一直停在“正在读取模型状态”。只有完整 ONNX 或已载入模型
    // 才算可用，部分下载不能误报为就绪。
    progress.model_ready = model::available(state);

    let (semantic_done, semantic_total, semantic_bytes, indexed_signatures) =
        super::vector::management_status_snapshot_fast(state);
    progress.semantic_done = semantic_done;
    progress.semantic_total = semantic_total;
    progress.semantic_ready = semantic_total > 0 && semantic_done == semantic_total;
    progress.semantic_bytes = semantic_bytes;

    let indexed_ids = indexed_signatures
        .iter()
        .map(|signature| signature.book_id)
        .collect::<Vec<_>>();
    let (accelerator_done, accelerator_total, accelerator_ready, accelerator_resumable) =
        accelerator_progress(&indexed_ids, &indexed_signatures);
    progress.accelerator_done = if progress.building && progress.shard_total > 0 {
        progress.shard_done
    } else {
        accelerator_done
    };
    progress.accelerator_total = if progress.building && progress.shard_total > 0 {
        progress.shard_total
    } else {
        accelerator_total
    };
    progress.accelerator_ready = accelerator_ready;
    progress.accelerator_resumable = accelerator_resumable;
    progress.accelerator_bytes = accelerator_index_bytes();

    let (multi_done, multi_total, multi_ready) =
        profile::progress_for_signatures(&indexed_signatures);
    progress.multi_profile_done = multi_done;
    progress.multi_profile_total = multi_total;
    progress.multi_profile_ready = multi_ready;
    progress.multi_profile_bytes = profile::disk_bytes();
    settle_switch_status(&mut progress);
    progress
}

fn merge(mut live: SemProgress, cached: &SemProgress) -> SemProgress {
    live.model_ready = cached.model_ready;
    live.model_path = cached.model_path.clone();
    // 下载中的文件大小每次轮询都来自当前缓存目录，不能被旧快照覆盖。
    if !live.model_downloading {
        live.model_bytes = cached.model_bytes;
    }
    live.semantic_done = cached.semantic_done;
    live.semantic_total = cached.semantic_total;
    live.semantic_ready = cached.semantic_ready;
    live.semantic_bytes = cached.semantic_bytes;
    live.accelerator_done = cached.accelerator_done;
    live.accelerator_total = cached.accelerator_total;
    live.accelerator_ready = cached.accelerator_ready;
    live.accelerator_resumable = cached.accelerator_resumable;
    live.accelerator_bytes = cached.accelerator_bytes;
    live.multi_profile_done = cached.multi_profile_done;
    live.multi_profile_total = cached.multi_profile_total;
    live.multi_profile_ready = cached.multi_profile_ready;
    live.multi_profile_bytes = cached.multi_profile_bytes;
    if live.building && live.shard_total > 0 {
        live.accelerator_done = live.shard_done;
        live.accelerator_total = live.shard_total;
    }
    // 模型切换后首次状态扫描才知道本机是否已有模型、以及逐书索引是否仍
    // 新鲜；把扫描结论带回实时状态，而不是让“正在检查”永久停在底部。
    if live.current.contains(SWITCH_STATUS_CHECKING) {
        live.current = cached.current.clone();
    }
    live
}

fn task_status(running: bool, ready: bool, resumable: bool) -> String {
    if running {
        "running"
    } else if ready {
        "ready"
    } else if resumable {
        "resumable"
    } else {
        "idle"
    }
    .into()
}

pub(super) fn task_center(progress: SemProgress) -> SemanticTaskCenter {
    let busy = progress.building || progress.model_downloading;
    let refreshing = progress.status_refreshing;
    let active = progress.active_task.as_str();
    let vector_live = progress.building
        && (active == "semantic_vectors"
            || active == "semantic_full"
            || (active.is_empty() && progress.total > 0 && progress.shard_total == 0));
    let accelerator_live = progress.building
        && (active == "semantic_accelerator"
            || (active == "semantic_full" && progress.shard_total > 0)
            || (active.is_empty() && progress.shard_total > 0));
    let multi_profile_live = progress.building && active == "semantic_multi_profile";

    let vector_done = if vector_live && progress.total > 0 {
        progress.done
    } else {
        progress.semantic_done
    };
    let vector_total = if vector_live && progress.total > 0 {
        progress.total
    } else {
        progress.semantic_total
    };
    let accelerator_done = if accelerator_live && progress.shard_total > 0 {
        progress.shard_done
    } else {
        progress.accelerator_done
    };
    let accelerator_total = if accelerator_live && progress.shard_total > 0 {
        progress.shard_total
    } else {
        progress.accelerator_total
    };
    let multi_profile_done = if multi_profile_live && progress.total > 0 {
        progress.done
    } else {
        progress.multi_profile_done
    };
    let multi_profile_total = if multi_profile_live && progress.total > 0 {
        progress.total
    } else {
        progress.multi_profile_total
    };

    let model_detail = if !progress.model_supported {
        "当前模型暂不可在本地运行".into()
    } else if progress.model_downloading {
        "正在下载/加载模型…".into()
    } else if progress.model_ready {
        "已就绪".into()
    } else {
        "未下载".into()
    };
    let vector_detail = if progress.vector_pause_requested {
        format!("{vector_done}/{vector_total} 本，正在取消当前书的未完成索引…")
    } else if progress.vector_paused {
        format!("{vector_done}/{vector_total} 本，已暂停，可续建")
    } else if refreshing {
        format!("{vector_done}/{vector_total} 本，后台核对中")
    } else if vector_total > 0 {
        format!(
            "{}/{} 本{}",
            vector_done,
            vector_total,
            if progress.semantic_ready {
                "，已完成"
            } else {
                ""
            }
        )
    } else {
        "书架中暂无可建立语义索引的图书".into()
    };
    let accelerator_detail = if refreshing {
        "后台核对中".into()
    } else if accelerator_total > 0 {
        format!(
            "{}/{} 片{}",
            accelerator_done,
            accelerator_total,
            if progress.accelerator_ready {
                "，已完成"
            } else if progress.accelerator_resumable {
                "，可续建"
            } else {
                ""
            }
        )
    } else {
        "建立语义索引后可建立加速索引".into()
    };
    let multi_profile_detail = if refreshing {
        "后台核对中".into()
    } else if multi_profile_total > 0 {
        format!(
            "{}/{} 本{}",
            multi_profile_done,
            multi_profile_total,
            if progress.multi_profile_ready {
                "，已完成"
            } else if multi_profile_done > 0 {
                "，需要更新"
            } else {
                ""
            }
        )
    } else {
        "建立语义索引后可生成多中心画像".into()
    };

    SemanticTaskCenter {
        busy,
        status_refreshing: refreshing,
        current: progress.current.clone(),
        error: progress.error.clone(),
        tasks: vec![
            SemanticTaskItem {
                id: "semantic_model".into(),
                title: "语义模型".into(),
                detail: model_detail,
                status: task_status(progress.model_downloading, progress.model_ready, false),
                done: u32::from(progress.model_ready),
                total: 1,
                bytes: progress.model_bytes,
                running: progress.model_downloading,
                ready: progress.model_ready,
                resumable: false,
                can_start: progress.model_supported && !busy && !progress.model_ready,
                can_delete: !busy && progress.model_ready,
                primary_label: "下载模型".into(),
                delete_label: "删除模型".into(),
            },
            SemanticTaskItem {
                id: "semantic_vectors".into(),
                title: "语义索引".into(),
                detail: vector_detail,
                status: task_status(
                    vector_live,
                    progress.semantic_ready,
                    vector_done > 0 && !progress.semantic_ready,
                ),
                done: vector_done,
                total: vector_total,
                bytes: progress.semantic_bytes,
                running: vector_live,
                ready: progress.semantic_ready,
                resumable: vector_done > 0 && !progress.semantic_ready,
                can_start: !busy && progress.model_ready && vector_total > 0,
                can_delete: !busy && vector_done > 0,
                primary_label: if vector_done > 0 && !progress.semantic_ready {
                    "续建语义索引".into()
                } else {
                    "建立语义索引".into()
                },
                delete_label: "删除".into(),
            },
            SemanticTaskItem {
                id: "semantic_accelerator".into(),
                title: "加速索引".into(),
                detail: accelerator_detail,
                status: task_status(
                    accelerator_live,
                    progress.accelerator_ready,
                    progress.accelerator_resumable,
                ),
                done: accelerator_done,
                total: accelerator_total,
                bytes: progress.accelerator_bytes,
                running: accelerator_live,
                ready: progress.accelerator_ready,
                resumable: progress.accelerator_resumable,
                can_start: !busy && progress.model_ready && vector_done > 0,
                can_delete: !busy && (progress.accelerator_ready || accelerator_done > 0),
                primary_label: if progress.accelerator_resumable {
                    "续建加速索引".into()
                } else {
                    "建立加速索引".into()
                },
                delete_label: "删除".into(),
            },
            SemanticTaskItem {
                id: "semantic_multi_profile".into(),
                title: "多中心画像索引".into(),
                detail: multi_profile_detail,
                status: task_status(
                    multi_profile_live,
                    progress.multi_profile_ready,
                    multi_profile_done > 0 && !progress.multi_profile_ready,
                ),
                done: multi_profile_done,
                total: multi_profile_total,
                bytes: progress.multi_profile_bytes,
                running: multi_profile_live,
                ready: progress.multi_profile_ready,
                resumable: multi_profile_done > 0 && !progress.multi_profile_ready,
                can_start: !busy && vector_done > 0,
                can_delete: !busy && progress.multi_profile_bytes > 0,
                primary_label: if multi_profile_done > 0 && !progress.multi_profile_ready {
                    "更新多中心画像".into()
                } else {
                    "建立多中心画像".into()
                },
                delete_label: "删除".into(),
            },
        ],
        progress: SemanticProgressDto::from(&progress),
    }
}

pub(super) fn public_snapshot(app: &tauri::AppHandle, state: &AppState) -> SemanticProgressDto {
    SemanticProgressDto::from(&snapshot(app, state, false))
}

pub(super) fn clear() {
    if let Ok(mut cache) = cache().lock() {
        cache.refresh_id = cache.refresh_id.wrapping_add(1);
        cache.snapshot = None;
        cache.refreshing = false;
        cache.refresh_started_at = 0;
        cache.last_attempt_at = 0;
        cache.updated_at = 0;
    }
}

pub(super) fn update_multi_profile(done: u32, total: Option<u32>, ready: bool) -> bool {
    let Ok(mut cache) = cache().lock() else {
        return false;
    };
    let Some(snapshot) = cache.snapshot.as_mut() else {
        return false;
    };
    snapshot.multi_profile_done = done;
    if let Some(total) = total {
        snapshot.multi_profile_total = total;
    }
    snapshot.multi_profile_ready = ready;
    snapshot.multi_profile_bytes = profile::disk_bytes();
    cache.updated_at = now_ms();
    cache.refreshing = false;
    true
}

/// 轻量快照绝不扫描逐书索引文件。只有用户明确要求核对状态时才启动低优先级扫描，
/// 避免打开设置页与阅读、关闭窗口等前台交互抢占资源。
pub(super) fn snapshot(app: &tauri::AppHandle, state: &AppState, reconcile: bool) -> SemProgress {
    let mut live = state.sem_progress.lock().unwrap().clone();
    let selected = model::active();
    live.model_id = selected.id().to_string();
    live.model_label = selected.label().to_string();
    live.model_supported = selected.locally_supported();
    if live.model_downloading {
        live.model_bytes = model::downloaded_bytes();
    }
    let now = now_ms();
    let mut refresh_id = None;
    let cached_snapshot = {
        let mut status_cache = cache().lock().unwrap();
        if status_cache.refreshing
            && now.saturating_sub(status_cache.refresh_started_at) > STATUS_REFRESH_TIMEOUT_MS
        {
            status_cache.refreshing = false;
            crate::log("semantic_status refresh timed out; keeping the last non-blocking snapshot");
        }
        let snapshot = status_cache.snapshot.clone();
        let snapshot_expired = status_cache
            .snapshot
            .as_ref()
            .is_none_or(|_| now.saturating_sub(status_cache.updated_at) > STATUS_CACHE_TTL_MS);
        let retry_due = status_cache.last_attempt_at == 0
            || now.saturating_sub(status_cache.last_attempt_at) > STATUS_CACHE_TTL_MS;
        // 正在构建时，进度来自任务检查点；不要同时逐书扫描数百个元数据文件。
        // 稍后轮询会在任务结束、缓存清空后自动启动这次核对。
        if reconcile && !live.building && snapshot_expired && !status_cache.refreshing && retry_due
        {
            status_cache.refreshing = true;
            status_cache.refresh_started_at = now;
            status_cache.last_attempt_at = now;
            status_cache.refresh_id = status_cache.refresh_id.wrapping_add(1);
            refresh_id = Some(status_cache.refresh_id);
        }
        snapshot
    };
    if let Some(refresh_id) = refresh_id {
        let app_for_refresh = app.clone();
        std::thread::spawn(move || {
            // 首次打开任务中心可能需要读取数百份逐书元数据。它不能与前台 WebView
            // 抢 CPU 或磁盘优先级，否则窗口即使已渲染出来也会被 Windows 判定为未响应。
            set_thread_background(true);
            let state = app_for_refresh.state::<AppState>();
            let live = state.sem_progress.lock().unwrap().clone();
            let refreshed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                enrich(state.inner(), live)
            }));
            if let Ok(mut status_cache) = cache().lock() {
                if status_cache.refresh_id == refresh_id {
                    if let Ok(snapshot) = refreshed {
                        status_cache.snapshot = Some(snapshot);
                        status_cache.updated_at = now_ms();
                    } else {
                        crate::log("semantic_status refresh panicked; previous snapshot preserved");
                    }
                    status_cache.refreshing = false;
                    status_cache.refresh_started_at = 0;
                }
            }
            set_thread_background(false);
        });
    }
    if let Some(cached) = cached_snapshot
        .as_ref()
        .filter(|cached| cached.model_id.is_empty() || cached.model_id == model::active_id())
    {
        live = merge(live, cached);
    } else {
        live = provisional_snapshot(state, live);
        live.status_refreshing = true;
    }
    // 这一步必须在缓存/临时快照之后执行，确保它不会被“尚未建立”的保守
    // 首屏状态覆盖。后台任务仍在运行时，重开弹窗立即显示真实运行态。
    hydrate_vector_task(state, &mut live);
    live
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clearing_status_drops_the_previous_snapshot() {
        {
            let mut status_cache = cache().lock().unwrap();
            status_cache.snapshot = Some(SemProgress {
                semantic_done: 22,
                semantic_total: 781,
                ..Default::default()
            });
            status_cache.updated_at = now_ms();
        }
        clear();
        let status_cache = cache().lock().unwrap();
        assert!(status_cache.snapshot.is_none());
        assert_eq!(status_cache.updated_at, 0);
    }

    #[test]
    fn task_status_precedence_is_stable() {
        assert_eq!(task_status(true, true, true), "running");
        assert_eq!(task_status(false, true, true), "ready");
        assert_eq!(task_status(false, false, true), "resumable");
        assert_eq!(task_status(false, false, false), "idle");
    }

    #[test]
    fn switch_message_matches_actual_model_and_vector_state() {
        assert_eq!(
            switch_ready_message("BGE Large 中文（高精度）", true, 781, 781),
            "已切换至 BGE Large 中文（高精度）；模型和语义索引已就绪"
        );
        assert_eq!(
            switch_ready_message("BGE Large 中文（高精度）", false, 0, 781),
            "已切换至 BGE Large 中文（高精度）"
        );
        assert_eq!(
            switch_ready_message("BGE Large 中文（高精度）", true, 94, 781),
            "已切换至 BGE Large 中文（高精度）；模型已就绪，语义索引 94/781 本，可继续建立"
        );
    }

    #[test]
    fn task_center_keeps_command_schema() {
        let progress = SemProgress {
            model_ready: true,
            model_supported: true,
            semantic_done: 2,
            semantic_total: 3,
            semantic_bytes: 10,
            accelerator_done: 1,
            accelerator_total: 2,
            accelerator_resumable: true,
            multi_profile_done: 1,
            multi_profile_total: 3,
            multi_profile_bytes: 20,
            ..Default::default()
        };
        let json = serde_json::to_value(task_center(progress)).unwrap();
        assert_eq!(json["tasks"].as_array().map(Vec::len), Some(4));
        let ids = json["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "semantic_model",
                "semantic_vectors",
                "semantic_accelerator",
                "semantic_multi_profile"
            ]
        );
        for field in [
            "id",
            "title",
            "detail",
            "status",
            "done",
            "total",
            "bytes",
            "running",
            "ready",
            "resumable",
            "can_start",
            "can_delete",
            "primary_label",
            "delete_label",
        ] {
            assert!(json["tasks"][0].get(field).is_some(), "missing {field}");
        }
    }

    #[test]
    fn cached_snapshot_keeps_cached_assets_but_live_shard_progress_wins() {
        let live = SemProgress {
            building: true,
            shard_done: 3,
            shard_total: 7,
            ..Default::default()
        };
        let cached = SemProgress {
            accelerator_done: 1,
            accelerator_total: 2,
            ..Default::default()
        };
        let merged = merge(live, &cached);
        assert_eq!(merged.accelerator_done, 3);
        assert_eq!(merged.accelerator_total, 7);
    }

    #[test]
    fn capacity_classification_matches_published_index_families() {
        assert!(semantic_asset("sem_42.vec"));
        assert!(semantic_asset("sem_42.profile.json"));
        assert!(!semantic_asset("global_0.hnsw"));
        assert!(accelerator_asset("global_0.hnsw"));
        assert!(accelerator_asset("global.build.json"));
        assert!(!accelerator_asset("multi_profiles.bin"));
    }

    #[test]
    fn management_status_never_runs_full_vector_hashing() {
        let source = include_str!("status.rs");
        let implementation = source
            .split("#[cfg(test)]")
            .next()
            .expect("status implementation");
        assert!(implementation.contains("management_status_snapshot_fast"));
        assert!(implementation.contains("global_index_fresh_for_status"));
        assert!(implementation.contains("build_progress_for_status"));
        assert!(implementation.contains("STATUS_REFRESH_TIMEOUT_MS"));
        assert!(implementation.contains("catch_unwind"));
        assert!(
            !implementation.contains("accelerator::indexed_book_snapshot_cached"),
            "the management dialog must not trigger the strong whole-library hash path"
        );
    }

    #[test]
    fn provisional_management_status_never_guesses_from_index_files() {
        let source = include_str!("status.rs");
        let start = source
            .find("fn provisional_semantic_book_total")
            .expect("provisional status must exist");
        let end = start
            + source[start..]
                .find("fn provisional_snapshot")
                .expect("provisional snapshot must follow progress");
        let implementation = &source[start..end];
        assert!(!implementation.contains("std::fs::read_dir"));
        assert!(!implementation.contains("read_metadata"));
        assert!(!implementation.contains("sem_index_done_for_book"));
        assert!(!implementation.contains("strip_prefix(\"sem_\")"));
    }

    #[test]
    fn provisional_snapshot_keeps_only_in_memory_committed_progress() {
        let source = include_str!("status.rs");
        let start = source
            .find("fn provisional_snapshot")
            .expect("provisional snapshot must exist");
        let end = start
            + source[start..]
                .find("fn switch_ready_message")
                .expect("switch message must follow provisional snapshot");
        let implementation = &source[start..end];
        assert!(
            implementation.contains("progress.semantic_done = progress.semantic_done.min(total)")
        );
        assert!(implementation
            .contains("progress.semantic_ready = total > 0 && progress.semantic_done == total"));
        assert!(implementation.contains("progress.accelerator_total = 0"));
        assert!(implementation.contains("progress.multi_profile_total = 0"));
    }

    #[test]
    fn background_verification_does_not_disable_management_actions() {
        let source = include_str!("status.rs");
        let start = source
            .find("pub(super) fn task_center")
            .expect("task center");
        let end = start
            + source[start..]
                .find("pub(super) fn public_snapshot")
                .expect("task center end");
        let implementation = &source[start..end];
        assert!(!implementation.contains("!refreshing"));
        assert!(!implementation.contains("正在读取模型状态"));
        assert!(!implementation.contains("正在读取语义索引状态"));
    }

    #[test]
    fn status_implementation_stays_out_of_the_parent_module() {
        let parent = include_str!("../semantic.rs");
        for forbidden in [
            "struct SemanticTaskItem",
            "struct SemanticTaskCenter",
            "struct SemStatusCache",
            "fn enrich_sem_progress",
            "fn semantic_task_center_from_progress",
            "fn semantic_status_snapshot",
        ] {
            assert!(
                !parent.contains(forbidden),
                "status boundary regressed: {forbidden}"
            );
        }
        assert!(parent.contains("status::snapshot"));
        assert!(parent.contains("status::task_center"));
    }
}
