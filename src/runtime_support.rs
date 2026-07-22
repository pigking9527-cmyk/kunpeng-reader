use serde::Serialize;
use tauri::Emitter;

/// 自定义协议的基地址。
/// Windows WebView2 把它映射到 `http://<scheme>.localhost`，而 Apple WebKit
/// 使用注册时的原生 scheme URL。其他平台暂时保留既有地址，避免改变行为。
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) const RES_BASE: &str = "reader://localhost";
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) const RES_BASE: &str = "http://reader.localhost";

pub(crate) const DEFAULT_SYNC_URL: &str = "";

/// 调试日志：写到 %LOCALAPPDATA%\ebook-reader\debug.log（windows 子系统下没有 stderr）。
pub(crate) fn log(msg: &str) {
    if let Some(mut dir) = dirs::cache_dir() {
        dir.push("ebook-reader");
        let _ = std::fs::create_dir_all(&dir);
        dir.push("debug.log");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dir)
        {
            let _ = writeln!(f, "{msg}");
        }
    }
}

pub(crate) fn report_save_error(context: &str, result: Result<(), String>) {
    if let Err(error) = result {
        log(&format!("{context}保存失败：{error}"));
    }
}

#[derive(Serialize, Clone)]
struct StartupPerfEvent {
    name: String,
    phase: String,
    detail: String,
}

pub(crate) fn emit_startup_perf(
    app: &tauri::AppHandle,
    name: &str,
    phase: &str,
    detail: impl Into<String>,
) {
    let detail = detail.into();
    log(&format!("[startup] {name} {phase} {detail}"));
    let _ = app.emit(
        "startup-perf",
        StartupPerfEvent {
            name: name.to_string(),
            phase: phase.to_string(),
            detail,
        },
    );
}

/// 当前时刻（毫秒）。用于后台调度、缓存失效与语义索引让路。
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 交互式搜索必须给 WebView、窗口合成和输入法预留 CPU。搜索只在书或分片数量
/// 足够时并行，最多使用 2 个后台工作线程；避免大索引解压和内存扫描与 WebView
/// 争抢内存带宽。四核机器保留两个核心，双核退回单线程。
pub(crate) fn interactive_search_workers(task_count: usize) -> usize {
    if task_count <= 1 {
        return 1;
    }
    let available = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2);
    interactive_search_workers_for(available, task_count)
}

fn interactive_search_workers_for(available: usize, task_count: usize) -> usize {
    available
        .saturating_sub(2)
        .clamp(1, 2)
        .min(task_count.max(1))
}

struct BackgroundPriorityGuard;

impl Drop for BackgroundPriorityGuard {
    fn drop(&mut self) {
        set_thread_background(false);
    }
}

pub(crate) fn with_thread_background_priority<T>(worker: impl FnOnce() -> T) -> T {
    set_thread_background(true);
    let _priority = BackgroundPriorityGuard;
    worker()
}

/// 把当前线程降到“后台优先级”，让前台（阅读/书架窗口）优先拿到 CPU。仅 Windows，尽力而为。
#[cfg(windows)]
pub(crate) fn set_thread_background(on: bool) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};

    static BEGIN_FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);
    static END_FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> isize;
        fn SetThreadPriority(h: isize, p: i32) -> i32;
        fn GetLastError() -> u32;
    }
    // THREAD_MODE_BACKGROUND_BEGIN=0x00010000 / END=0x00020000：同时降低 CPU 与 I/O 优先级
    let priority: i32 = if on { 0x0001_0000 } else { 0x0002_0000 };
    let ok = unsafe { SetThreadPriority(GetCurrentThread(), priority) != 0 };
    if !ok {
        let reported = if on {
            &BEGIN_FAILURE_REPORTED
        } else {
            &END_FAILURE_REPORTED
        };
        if !reported.swap(true, Ordering::AcqRel) {
            let error = unsafe { GetLastError() };
            log(&format!(
                "background_priority_failed mode={} windows_error={error}",
                if on { "begin" } else { "end" }
            ));
        }
    }
    ok
}

#[cfg(not(windows))]
pub(crate) fn set_thread_background(_on: bool) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_nonzero_and_resource_base_matches_platform() {
        assert!(now_ms() > 0);
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        assert_eq!(RES_BASE, "reader://localhost");
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        assert_eq!(RES_BASE, "http://reader.localhost");
    }

    #[test]
    fn interactive_search_preserves_foreground_cpu_and_respects_work_size() {
        assert_eq!(interactive_search_workers_for(1, 100), 1);
        assert_eq!(interactive_search_workers_for(2, 100), 1);
        assert_eq!(interactive_search_workers_for(4, 100), 2);
        assert_eq!(interactive_search_workers_for(8, 100), 2);
        assert_eq!(interactive_search_workers_for(32, 100), 2);
        assert_eq!(interactive_search_workers_for(32, 2), 2);
        assert_eq!(interactive_search_workers_for(32, 0), 1);
    }
}
