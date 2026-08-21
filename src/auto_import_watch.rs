//! 自动导入目录的原生文件系统监听。
//!
//! 原生事件负责低延迟发现变化；五分钟补扫负责覆盖网络盘、部分 Linux
//! 文件系统和休眠恢复后可能漏掉的事件。真正的导入仍由前端调用现有
//! `auto_import_scan`，因此扫描串行化、进度展示和书架增量刷新保持单一入口。

use crate::{log, set_thread_background, AppState};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(1);
const CHANGE_DEBOUNCE: Duration = Duration::from_secs(3);
const WATCH_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const FALLBACK_SCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoImportWatchEvent {
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoImportWatchStatus {
    state: String,
    message: String,
}

fn emit_scan_request(app: &tauri::AppHandle, reason: &str) {
    let _ = app.emit(
        "auto-import-change",
        AutoImportWatchEvent {
            reason: reason.to_owned(),
        },
    );
}

fn emit_status(app: &tauri::AppHandle, state: &str, message: impl Into<String>) {
    let message = message.into();
    log(&format!(
        "auto_import_watch state={state} message={message}"
    ));
    let _ = app.emit(
        "auto-import-watch-status",
        AutoImportWatchStatus {
            state: state.to_owned(),
            message,
        },
    );
}

fn current_config(app: &tauri::AppHandle) -> (bool, Vec<PathBuf>) {
    let state = app.state::<AppState>();
    let library = state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (
        library.auto_import_enabled,
        library.auto_import_dirs.iter().map(PathBuf::from).collect(),
    )
}

fn event_requires_rescan(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Any
            | EventKind::Create(_)
            | EventKind::Modify(_)
            | EventKind::Remove(_)
            | EventKind::Other
    )
}

pub(crate) fn spawn(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("auto-import-watch".into())
        .spawn(move || {
            set_thread_background(true);
            let (event_sender, event_receiver) = mpsc::channel::<notify::Result<Event>>();
            let mut watcher: Option<notify::RecommendedWatcher> = None;
            let mut watched_enabled = false;
            let mut watched_dirs = Vec::<PathBuf>::new();
            let mut watch_degraded = false;
            let mut retry_at = Instant::now();
            let mut pending_scan_at: Option<Instant> = None;
            let mut fallback_at = Instant::now() + FALLBACK_SCAN_INTERVAL;

            loop {
                let now = Instant::now();
                let (enabled, dirs) = current_config(&app);
                let config_changed = enabled != watched_enabled || dirs != watched_dirs;
                let retry_due = enabled && watch_degraded && now >= retry_at;

                if config_changed || retry_due {
                    watcher = None;
                    watched_enabled = enabled;
                    watched_dirs = dirs.clone();
                    watch_degraded = false;
                    retry_at = now + WATCH_RETRY_INTERVAL;
                    fallback_at = now + FALLBACK_SCAN_INTERVAL;

                    if enabled && !dirs.is_empty() {
                        match notify::recommended_watcher(event_sender.clone()) {
                            Ok(mut next_watcher) => {
                                let mut watched = 0usize;
                                let mut errors = Vec::new();
                                for dir in &dirs {
                                    if !dir.is_dir() {
                                        errors.push(format!(
                                            "目录不存在或无法访问：{}",
                                            dir.display()
                                        ));
                                        continue;
                                    }
                                    match next_watcher.watch(dir, RecursiveMode::Recursive) {
                                        Ok(()) => watched += 1,
                                        Err(error) => errors
                                            .push(format!("无法监听 {}：{error}", dir.display())),
                                    }
                                }
                                if watched > 0 {
                                    watcher = Some(next_watcher);
                                }
                                if errors.is_empty() {
                                    emit_status(
                                        &app,
                                        "watching",
                                        format!("正在监测 {watched} 个自动导入目录"),
                                    );
                                } else {
                                    watch_degraded = true;
                                    emit_status(&app, "error", errors.join("；"));
                                }
                                if retry_due && watched > 0 {
                                    pending_scan_at = Some(now + CHANGE_DEBOUNCE);
                                }
                            }
                            Err(error) => {
                                watch_degraded = true;
                                emit_status(&app, "error", format!("启动目录监听失败：{error}"));
                            }
                        }
                    } else if !enabled {
                        emit_status(&app, "disabled", "自动导入已关闭");
                    }
                }

                match event_receiver.recv_timeout(CONFIG_POLL_INTERVAL) {
                    Ok(Ok(event)) if enabled && event_requires_rescan(&event) => {
                        pending_scan_at = Some(Instant::now() + CHANGE_DEBOUNCE);
                    }
                    Ok(Err(error)) => {
                        watch_degraded = true;
                        retry_at = Instant::now() + WATCH_RETRY_INTERVAL;
                        emit_status(&app, "error", format!("目录监听异常：{error}"));
                    }
                    Ok(Ok(_)) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        watch_degraded = true;
                        retry_at = Instant::now() + WATCH_RETRY_INTERVAL;
                    }
                }

                let now = Instant::now();
                if enabled && pending_scan_at.is_some_and(|deadline| now >= deadline) {
                    pending_scan_at = None;
                    emit_scan_request(&app, "检测到自动导入目录变化，正在检查新书…");
                }
                if enabled && !dirs.is_empty() && now >= fallback_at {
                    fallback_at = now + FALLBACK_SCAN_INTERVAL;
                    emit_scan_request(&app, "正在执行自动导入补漏扫描…");
                }

                // 保持 watcher 存活；显式读取可避免未来重构误删这个生命周期所有者。
                let _watcher_active = watcher.is_some();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind};

    #[test]
    fn content_changes_trigger_rescan_but_reads_do_not() {
        assert!(event_requires_rescan(&Event::new(EventKind::Create(
            CreateKind::File
        ))));
        assert!(event_requires_rescan(&Event::new(EventKind::Modify(
            ModifyKind::Any
        ))));
        assert!(!event_requires_rescan(&Event::new(EventKind::Access(
            AccessKind::Any
        ))));
    }

    #[test]
    fn watcher_has_debounce_retry_and_fallback_intervals() {
        assert_eq!(CHANGE_DEBOUNCE, Duration::from_secs(3));
        assert_eq!(WATCH_RETRY_INTERVAL, Duration::from_secs(30));
        assert_eq!(FALLBACK_SCAN_INTERVAL, Duration::from_secs(300));
    }
}
