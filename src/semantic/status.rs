//! 语义索引状态、容量与任务中心 DTO。
//!
//! 状态扫描可能打开数百个索引元数据文件，因此通过短期快照缓存与实时运行态
//! 合并，避免 UI 轮询阻塞模型下载、向量构建或阅读窗口。

use super::{model, profile};
use crate::semantic_tasks::SemProgress;
use crate::{book, now_ms, set_thread_background, AppState};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const STATUS_CACHE_TTL_MS: u64 = 60_000;
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
    model_supported: bool,
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
    current: String,
    error: String,
}

impl From<&SemProgress> for SemanticProgressDto {
    fn from(progress: &SemProgress) -> Self {
        Self {
            building: progress.building,
            model_downloading: progress.model_downloading,
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
            model_supported: progress.model_supported,
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
            current: progress.current.clone(),
            error: progress.error.clone(),
        }
    }
}

#[derive(Default)]
struct StatusCache {
    snapshot: Option<SemProgress>,
    refreshing: bool,
    updated_at: u64,
}

static STATUS_CACHE: OnceLock<Mutex<StatusCache>> = OnceLock::new();

fn cache() -> &'static Mutex<StatusCache> {
    STATUS_CACHE.get_or_init(|| Mutex::new(StatusCache::default()))
}

fn semantic_book_progress(state: &AppState) -> (u32, u32) {
    let books: Vec<book::Book> = {
        let library = state.library.lock().unwrap();
        library
            .books
            .iter()
            .filter(|book| book.format != "pdf")
            .cloned()
            .collect()
    };
    let total = books.len() as u32;
    let done = books
        .iter()
        .filter(|book| super::sem_index_done_for_book(book))
        .count() as u32;
    (done, total)
}

fn switch_ready_message(label: &str, model_ready: bool, done: u32, total: u32) -> String {
    if !model_ready {
        format!("已切换至 {label}；请下载模型")
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

fn accelerator_progress(state: &AppState) -> (u32, u32, bool, bool) {
    let (ids, source_sig) = super::accelerator::indexed_book_snapshot_cached(state);
    if ids.is_empty() {
        return (0, 0, false, false);
    }
    let total = super::accelerator::estimate_global_shard_total(&ids);
    if super::accelerator::global_index_fresh(state) {
        return (total.max(1), total.max(1), true, false);
    }
    if let Some((done, processed_books)) = super::accelerator::build_progress(&ids, &source_sig) {
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
    progress.model_bytes = model_path
        .as_ref()
        .map(|path| model::directory_size(path))
        .unwrap_or(0);
    progress.model_path = model_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    // 状态刷新绝不能排队等待模型下载。下载过程可能持续数十秒，旧实现会让
    // 整个任务中心一直停在“正在读取模型状态”。只有完整 ONNX 或已载入模型
    // 才算可用，部分下载不能误报为就绪。
    progress.model_ready = model::available(state);

    let (semantic_done, semantic_total) = semantic_book_progress(state);
    progress.semantic_done = semantic_done;
    progress.semantic_total = semantic_total;
    progress.semantic_ready = semantic_total > 0 && semantic_done == semantic_total;
    progress.semantic_bytes = semantic_index_bytes();

    let (accelerator_done, accelerator_total, accelerator_ready, accelerator_resumable) =
        accelerator_progress(state);
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

    let (multi_done, multi_total, multi_ready) = profile::progress(state);
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
    live.model_bytes = cached.model_bytes;
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
    } else if refreshing {
        "正在读取模型状态…".into()
    } else {
        format!(
            "未下载。首次下载约 {} MB。",
            model::active().estimated_download_bytes() / 1024 / 1024
        )
    };
    let vector_detail = if progress.vector_pause_requested {
        format!("{vector_done}/{vector_total} 本，正在取消当前书的未完成索引…")
    } else if progress.vector_paused {
        format!("{vector_done}/{vector_total} 本，已暂停，可续建")
    } else if refreshing && vector_total == 0 {
        "正在读取语义索引状态…".into()
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
    let accelerator_detail = if refreshing && accelerator_total == 0 {
        "正在读取加速索引状态…".into()
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
    let multi_profile_detail = if refreshing && multi_profile_total == 0 {
        "正在读取多中心画像状态…".into()
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
                can_start: progress.model_supported && !busy && !refreshing,
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
                can_start: !busy && !refreshing && progress.model_ready && vector_total > 0,
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
                can_start: !busy && !refreshing && progress.model_ready && vector_done > 0,
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
                can_start: !busy && !refreshing && vector_done > 0,
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
    SemanticProgressDto::from(&snapshot(app, state))
}

pub(super) fn clear() {
    if let Ok(mut cache) = cache().lock() {
        cache.snapshot = None;
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

pub(super) fn snapshot(app: &tauri::AppHandle, state: &AppState) -> SemProgress {
    let mut live = state.sem_progress.lock().unwrap().clone();
    let selected = model::active();
    live.model_id = selected.id().to_string();
    live.model_label = selected.label().to_string();
    live.model_supported = selected.locally_supported();
    let now = now_ms();
    let mut should_refresh = false;
    let cached_snapshot = {
        let mut status_cache = cache().lock().unwrap();
        let snapshot = status_cache.snapshot.clone();
        if status_cache
            .snapshot
            .as_ref()
            .is_none_or(|_| now.saturating_sub(status_cache.updated_at) > STATUS_CACHE_TTL_MS)
            && !status_cache.refreshing
        {
            status_cache.refreshing = true;
            should_refresh = true;
        }
        snapshot
    };
    if should_refresh {
        let app_for_refresh = app.clone();
        std::thread::spawn(move || {
            // 首次打开任务中心可能需要读取数百份逐书元数据。它不能与前台 WebView
            // 抢 CPU 或磁盘优先级，否则窗口即使已渲染出来也会被 Windows 判定为未响应。
            set_thread_background(true);
            let state = app_for_refresh.state::<AppState>();
            let live = state.sem_progress.lock().unwrap().clone();
            let snapshot = enrich(state.inner(), live);
            if let Ok(mut status_cache) = cache().lock() {
                status_cache.snapshot = Some(snapshot);
                status_cache.updated_at = now_ms();
                status_cache.refreshing = false;
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
        live.status_refreshing = true;
    }
    live
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "已切换至 BGE Large 中文（高精度）；请下载模型"
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
