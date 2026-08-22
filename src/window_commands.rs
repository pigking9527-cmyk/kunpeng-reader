use crate::{
    book::{Library, WinGeom},
    log, now_ms, report_save_error, AppState,
};
use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
#[cfg(target_os = "windows")]
mod windows_activation {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    #[link(name = "user32")]
    extern "system" {
        #[link_name = "BringWindowToTop"]
        fn bring_window_to_top(window: Hwnd) -> i32;
        #[link_name = "GetForegroundWindow"]
        fn get_foreground_window() -> Hwnd;
        #[link_name = "SetActiveWindow"]
        fn set_active_window(window: Hwnd) -> Hwnd;
        #[link_name = "SetFocus"]
        fn set_focus(window: Hwnd) -> Hwnd;
        #[link_name = "SetForegroundWindow"]
        fn set_foreground_window(window: Hwnd) -> i32;
        #[link_name = "ShowWindowAsync"]
        fn show_window_async(window: Hwnd, command: i32) -> i32;
    }

    pub(super) fn activate(window: Hwnd) -> bool {
        const SW_RESTORE: i32 = 9;
        // SAFETY: Tauri supplied this HWND for a live WebviewWindow owned by
        // this process. All calls are synchronous and do not retain it.
        unsafe {
            let _ = show_window_async(window, SW_RESTORE);
            let _ = bring_window_to_top(window);
            let _ = set_active_window(window);
            let _ = set_focus(window);
            let _ = set_foreground_window(window);
            get_foreground_window() == window
        }
    }
}

static CLOSING_READER_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static REPLACING_READER_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static READER_WINDOW_BOOK_IDS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static READY_READER_SHELLS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static READER_SHELL_BUILD_SCHEDULED: AtomicBool = AtomicBool::new(false);
static READER_SHELL_PRELOAD_ENABLED: AtomicBool = AtomicBool::new(false);
static READER_SHELL_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static READER_SHELL_BENCHMARK_PHASES: LazyLock<
    Mutex<HashMap<String, ReaderShellBenchmarkListener>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));
static READER_OPEN_STARTED_AT: LazyLock<Mutex<HashMap<String, (Instant, &'static str)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING_READER_SWITCH_STARTED_AT: LazyLock<Mutex<HashMap<u64, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// A target book can start loading in an invisible pooled shell while the
// currently visible reader persists its final position. The map is keyed by
// target book ID so complete_reader_switch can reveal exactly that shell.
static PREPARED_READER_SWITCH_SHELLS: LazyLock<Mutex<HashMap<u64, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// A reader that has just been hidden after its WebView confirmed the final
// position does not need to persist that exact position again if the user
// immediately chooses another book. Keep this per-window, never per-book: a
// same-book reopen clears the marker before the reader can be used again.
static RECENTLY_SAVED_HIDDEN_READER_SHELLS: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// This flag is set only by the explicit user-facing exit command. Ordinary
// close and Cmd+Q continue to follow startup-enhancement hide behavior.
static EXPLICIT_APPLICATION_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

fn set_reader_window_closing(label: &str, closing: bool) {
    let mut labels = CLOSING_READER_WINDOWS.lock().unwrap();
    if closing {
        labels.insert(label.to_string());
    } else {
        labels.remove(label);
    }
}

fn reader_window_is_closing(label: &str) -> bool {
    CLOSING_READER_WINDOWS.lock().unwrap().contains(label)
}

const RECENT_HIDDEN_READER_SAVE_WINDOW: Duration = Duration::from_secs(15);

fn reader_was_recently_hidden_after_save(window: &tauri::WebviewWindow) -> bool {
    let label = window.label();
    let mut recently_saved = RECENTLY_SAVED_HIDDEN_READER_SHELLS.lock().unwrap();
    recently_saved.retain(|_, saved_at| saved_at.elapsed() <= RECENT_HIDDEN_READER_SAVE_WINDOW);
    recently_saved.contains_key(label)
}

fn clear_recent_hidden_reader_save(label: &str) {
    RECENTLY_SAVED_HIDDEN_READER_SHELLS
        .lock()
        .unwrap()
        .remove(label);
}

fn is_reader_shell_label(label: &str) -> bool {
    label.starts_with("reader-pool-")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderShellPreloadStatus {
    enabled: bool,
    pooled_shells: u32,
    ready_shells: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_resident_bytes: Option<u64>,
    cache: crate::epub_runtime::ReaderPreloadCacheStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderShellBenchmarkSample {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover_url: Option<String>,
    regular: ReaderShellBenchmarkTiming,
    preloaded: ReaderShellBenchmarkTiming,
    improvement_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderShellBenchmarkTiming {
    shell_ms: u32,
    layout_ms: u32,
    display_ms: u32,
    total_ms: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderShellPreloadBenchmark {
    regular_median_ms: u32,
    preloaded_median_ms: u32,
    improvement_median_ms: i64,
    samples: Vec<ReaderShellBenchmarkSample>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaderShellBenchmarkPhase {
    ShellBootstrap(u32),
    ShellPrepared,
    FrameReady(u32),
    PageLayoutReady(u32),
    FirstPageDisplayed(u32),
    MacFirstPageRendered(u32),
}

#[derive(Clone)]
struct ReaderShellBenchmarkListener {
    sender: mpsc::Sender<ReaderShellBenchmarkPhase>,
    started_at: Instant,
}

#[derive(Clone, Debug)]
struct ReaderShellBenchmarkBook {
    id: u64,
    title: String,
    file_bytes: u64,
    cover_url: Option<String>,
}

#[cfg(target_os = "macos")]
fn process_resident_bytes() -> Option<u64> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()?;
    let kib = String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    kib.checked_mul(1024)
}

#[cfg(target_os = "linux")]
fn process_resident_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let kib = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    kib.checked_mul(1024)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_resident_bytes() -> Option<u64> {
    None
}

fn reader_shell_preload_status_for(
    app: &tauri::AppHandle,
    state: &AppState,
) -> ReaderShellPreloadStatus {
    let pooled_labels: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            (is_reader_shell_label(&label) && reader_window_id(&window).is_none()).then_some(label)
        })
        .collect();
    let ready = READY_READER_SHELLS.lock().unwrap();
    let ready_shells = pooled_labels
        .iter()
        .filter(|label| ready.contains(*label))
        .count();
    ReaderShellPreloadStatus {
        enabled: READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire),
        pooled_shells: u32::try_from(pooled_labels.len()).unwrap_or(u32::MAX),
        ready_shells: u32::try_from(ready_shells).unwrap_or(u32::MAX),
        process_resident_bytes: process_resident_bytes(),
        cache: crate::epub_runtime::reader_preload_cache_status(state),
    }
}

#[tauri::command]
pub(crate) fn reader_shell_preload_status(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> ReaderShellPreloadStatus {
    reader_shell_preload_status_for(&app, state.inner())
}

#[tauri::command]
pub(crate) fn set_reader_shell_preload_enabled(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> ReaderShellPreloadStatus {
    READER_SHELL_PRELOAD_ENABLED.store(enabled, Ordering::Release);
    if enabled {
        schedule_clean_reader_shell(&app);
        schedule_recent_reading_chapter_cache(&app);
    } else {
        // The subordinate cache is intentionally released with the master
        // preload switch. Its preference stays in the settings UI and will be
        // restored only after the user turns preloading back on.
        state
            .epub_runtime
            .set_recent_reading_chapter_cache_enabled(false);
        let pooled: Vec<(String, tauri::WebviewWindow)> = app
            .webview_windows()
            .into_iter()
            .filter_map(|(label, window)| {
                (is_reader_shell_label(&label) && reader_window_id(&window).is_none())
                    .then_some((label, window))
            })
            .collect();
        {
            let mut ready = READY_READER_SHELLS.lock().unwrap();
            for (label, _) in &pooled {
                ready.remove(label);
            }
        }
        for (_, window) in pooled {
            let _ = window.destroy();
        }
    }
    reader_shell_preload_status_for(&app, state.inner())
}

fn schedule_recent_reading_chapter_cache(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        crate::epub_runtime::prewarm_recent_reading_chapters(state.inner());
    });
}

#[tauri::command]
pub(crate) fn set_recent_reading_chapter_cache_enabled(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> ReaderShellPreloadStatus {
    state
        .epub_runtime
        .set_recent_reading_chapter_cache_enabled(enabled);
    if enabled && READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
        schedule_recent_reading_chapter_cache(&app);
    }
    reader_shell_preload_status_for(&app, state.inner())
}

#[tauri::command]
pub(crate) fn clear_recent_reading_chapter_cache(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> ReaderShellPreloadStatus {
    state.epub_runtime.clear_recent_reading_chapter_cache();
    reader_shell_preload_status_for(&app, state.inner())
}

fn benchmark_percentile(sorted: &[u32], numerator: usize, denominator: usize) -> u32 {
    let Some(last) = sorted.len().checked_sub(1) else {
        return 0;
    };
    let index = last.saturating_mul(numerator).div_ceil(denominator);
    sorted.get(index).copied().unwrap_or(0)
}

fn largest_epub_benchmark_books(state: &AppState) -> Vec<ReaderShellBenchmarkBook> {
    let candidates: Vec<(u64, String, std::path::PathBuf, Option<String>)> = state
        .library
        .lock()
        .map(|library| {
            library
                .books
                .iter()
                .filter(|book| book.format.eq_ignore_ascii_case("epub"))
                .map(|book| {
                    (
                        book.id,
                        book.title.clone(),
                        book.path.clone(),
                        book.cover.as_ref().map(|_| {
                            format!(
                                "{}/cover/{}?v={}",
                                crate::runtime_support::RES_BASE,
                                book.id,
                                book.cover_ver
                            )
                        }),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut books: Vec<ReaderShellBenchmarkBook> = candidates
        .into_iter()
        .filter_map(|(id, title, path, cover_url)| {
            std::fs::metadata(path)
                .ok()
                .map(|metadata| ReaderShellBenchmarkBook {
                    id,
                    title,
                    file_bytes: metadata.len(),
                    cover_url,
                })
        })
        .collect();
    books.sort_by_key(|book| std::cmp::Reverse(book.file_bytes));
    books.truncate(10);
    books
}

fn benchmark_phase_from_perf_event(event: &str) -> Option<ReaderShellBenchmarkPhase> {
    if event == "shell_prepared" {
        return Some(ReaderShellBenchmarkPhase::ShellPrepared);
    }
    let (prefix, phase): (&str, fn(u32) -> ReaderShellBenchmarkPhase) =
        if event.starts_with("shell_bootstrap ") {
            (
                "shell_bootstrap elapsed_ms=",
                ReaderShellBenchmarkPhase::ShellBootstrap,
            )
        } else if event.starts_with("shell_ready ") {
            (
                "shell_ready elapsed_ms=",
                ReaderShellBenchmarkPhase::FrameReady,
            )
        } else if event == "page_layout_ready" {
            return Some(ReaderShellBenchmarkPhase::PageLayoutReady(0));
        } else if event == "page_displayed" {
            return Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(0));
        } else {
            return None;
        };
    let millis = event
        .strip_prefix(prefix)?
        .trim()
        .parse::<f64>()
        .ok()?
        .clamp(0.0, f64::from(u32::MAX))
        .round() as u32;
    Some(phase(millis))
}

fn is_first_page_render_event(event: &str) -> bool {
    event.starts_with("mac_page_render ")
        && event.split_ascii_whitespace().any(|part| part == "page=1")
}

/// Receives the existing reader-shell phase telemetry only for the invisible
/// benchmark windows. Normal reader telemetry keeps its original log path.
pub(crate) fn record_reader_shell_benchmark_phase(window: &tauri::WebviewWindow, event: &str) {
    let listener = READER_SHELL_BENCHMARK_PHASES
        .lock()
        .ok()
        .and_then(|phases| phases.get(window.label()).cloned());
    let Some(listener) = listener else {
        return;
    };
    let elapsed_ms = listener
        .started_at
        .elapsed()
        .as_millis()
        .min(u128::from(u32::MAX)) as u32;
    let phase = match benchmark_phase_from_perf_event(event) {
        Some(ReaderShellBenchmarkPhase::PageLayoutReady(_)) => {
            Some(ReaderShellBenchmarkPhase::PageLayoutReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(_)) => {
            Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(elapsed_ms))
        }
        Some(phase) => Some(phase),
        None => is_first_page_render_event(event)
            .then_some(ReaderShellBenchmarkPhase::MacFirstPageRendered(elapsed_ms)),
    };
    if let Some(phase) = phase {
        let _ = listener.sender.send(phase);
    }
}

fn build_benchmark_reader_window(
    app: &tauri::AppHandle,
    label: &str,
    path: &str,
) -> Result<tauri::WebviewWindow, String> {
    let url = tauri::WebviewUrl::App(path.into());
    let builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title("阅读打开测速")
        .visible(false)
        .decorations(false)
        .resizable(true)
        .inner_size(880.0, 760.0)
        .min_inner_size(420.0, 320.0);
    #[cfg(target_os = "macos")]
    let builder = if let Some(identifier) = crate::profile::webview_data_store_identifier() {
        builder.data_store_identifier(identifier)
    } else {
        builder
    };
    builder.build().map_err(|error| error.to_string())
}

fn benchmark_timing(
    shell_bootstrap_ms: Option<u32>,
    page_layout_ready_ms: u32,
    first_page_displayed_ms: u32,
    shell_preloaded: bool,
) -> ReaderShellBenchmarkTiming {
    let shell_ms = if shell_preloaded {
        0
    } else {
        shell_bootstrap_ms
            .unwrap_or_default()
            .min(page_layout_ready_ms.max(first_page_displayed_ms))
    };
    let layout_finished_ms = page_layout_ready_ms.max(shell_ms);
    let total_ms = first_page_displayed_ms.max(layout_finished_ms);
    ReaderShellBenchmarkTiming {
        shell_ms,
        layout_ms: layout_finished_ms.saturating_sub(shell_ms),
        display_ms: total_ms.saturating_sub(layout_finished_ms),
        total_ms,
    }
}

fn wait_for_benchmark_timing(
    receiver: &mpsc::Receiver<ReaderShellBenchmarkPhase>,
    shell_preloaded: bool,
) -> Result<ReaderShellBenchmarkTiming, String> {
    // 首章排版可能要等字体与图片解码；仍串行执行，避免测速本身争抢内存和 I/O。
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut shell_bootstrap_ms = None;
    let mut frame_ready_ms = None;
    let mut page_layout_ready_ms = None;
    let mut first_page_displayed_ms = None;
    let mut mac_first_page_rendered_ms = None;
    loop {
        if let (Some(page_layout_ready), Some(first_page_displayed)) =
            (page_layout_ready_ms, first_page_displayed_ms)
        {
            return Ok(benchmark_timing(
                shell_bootstrap_ms,
                page_layout_ready,
                first_page_displayed,
                shell_preloaded,
            ));
        }
        // 旧内页或非 macOS 路径没有分阶段遥测时，已有首帧/ready 仍可作为回退，
        // 且不能把设置页按钮永久留在“测速中”。
        let fallback_ready = page_layout_ready_ms
            .or(mac_first_page_rendered_ms)
            .or(frame_ready_ms);
        let fallback_deadline = fallback_ready.map(|_| Instant::now() + Duration::from_millis(450));
        let receive_until = fallback_deadline.map_or(deadline, |fallback| fallback.min(deadline));
        let remaining = receive_until.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(ReaderShellBenchmarkPhase::ShellBootstrap(millis)) => {
                shell_bootstrap_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::FrameReady(millis)) => {
                frame_ready_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::PageLayoutReady(millis)) => {
                page_layout_ready_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::FirstPageDisplayed(millis)) => {
                first_page_displayed_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::MacFirstPageRendered(millis)) => {
                mac_first_page_rendered_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::ShellPrepared) => {}
            Err(mpsc::RecvTimeoutError::Timeout) if fallback_ready.is_some() => {
                let page_layout_ready = page_layout_ready_ms
                    .or(mac_first_page_rendered_ms)
                    .or(frame_ready_ms)
                    .unwrap_or_default();
                let first_page_displayed = first_page_displayed_ms
                    .or(mac_first_page_rendered_ms)
                    .or(frame_ready_ms)
                    .unwrap_or(page_layout_ready);
                return Ok(benchmark_timing(
                    shell_bootstrap_ms,
                    page_layout_ready,
                    first_page_displayed,
                    shell_preloaded,
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("首页在 45 秒内未完成显示".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("测速窗口已提前关闭".to_string());
            }
        }
    }
}

fn wait_for_benchmark_shell_prepared(
    receiver: &mpsc::Receiver<ReaderShellBenchmarkPhase>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver
            .recv_timeout(remaining)
            .map_err(|_| "预加载窗口在 10 秒内未就绪".to_string())?
        {
            ReaderShellBenchmarkPhase::ShellPrepared => return Ok(()),
            ReaderShellBenchmarkPhase::ShellBootstrap(_)
            | ReaderShellBenchmarkPhase::FrameReady(_)
            | ReaderShellBenchmarkPhase::PageLayoutReady(_)
            | ReaderShellBenchmarkPhase::FirstPageDisplayed(_)
            | ReaderShellBenchmarkPhase::MacFirstPageRendered(_) => {}
        }
    }
}

fn replace_benchmark_listener_start(label: &str, sender: mpsc::Sender<ReaderShellBenchmarkPhase>) {
    if let Ok(mut phases) = READER_SHELL_BENCHMARK_PHASES.lock() {
        phases.insert(
            label.to_string(),
            ReaderShellBenchmarkListener {
                sender,
                started_at: Instant::now(),
            },
        );
    }
}

fn clear_benchmark_reader_window(label: &str, window: &tauri::WebviewWindow) {
    READER_SHELL_BENCHMARK_PHASES
        .lock()
        .ok()
        .map(|mut phases| phases.remove(label));
    READER_WINDOW_BOOK_IDS
        .lock()
        .ok()
        .map(|mut ids| ids.remove(label));
    let _ = window.destroy();
}

fn benchmark_regular_reader_open(
    app: &tauri::AppHandle,
    book: &ReaderShellBenchmarkBook,
) -> Result<ReaderShellBenchmarkTiming, String> {
    let label = format!(
        "reader-{}-benchmark-{}",
        book.id,
        READER_SHELL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::channel();
    replace_benchmark_listener_start(&label, sender);
    let window = match build_benchmark_reader_window(app, &label, "reader.html?benchmark=1") {
        Ok(window) => window,
        Err(error) => {
            READER_SHELL_BENCHMARK_PHASES
                .lock()
                .ok()
                .map(|mut phases| phases.remove(&label));
            return Err(error);
        }
    };
    READER_WINDOW_BOOK_IDS
        .lock()
        .map_err(|_| "打开测速状态不可用".to_string())?
        .insert(label.clone(), book.id);
    let result = wait_for_benchmark_timing(&receiver, false);
    clear_benchmark_reader_window(&label, &window);
    result
}

fn benchmark_preloaded_reader_open(
    app: &tauri::AppHandle,
    book: &ReaderShellBenchmarkBook,
) -> Result<ReaderShellBenchmarkTiming, String> {
    let label = format!(
        "reader-{}-preload-benchmark-{}",
        book.id,
        READER_SHELL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::channel();
    replace_benchmark_listener_start(&label, sender.clone());
    let window = match build_benchmark_reader_window(app, &label, "reader.html?pool=1&benchmark=1")
    {
        Ok(window) => window,
        Err(error) => {
            READER_SHELL_BENCHMARK_PHASES
                .lock()
                .ok()
                .map(|mut phases| phases.remove(&label));
            return Err(error);
        }
    };
    let result = (|| {
        wait_for_benchmark_shell_prepared(&receiver)?;
        // 从用户点击阅读到首页绘制的计时，必须从已就绪外壳被绑定图书这一刻开始。
        replace_benchmark_listener_start(&label, sender);
        READER_WINDOW_BOOK_IDS
            .lock()
            .map_err(|_| "打开测速状态不可用".to_string())?
            .insert(label.clone(), book.id);
        window
            .emit("reader-shell-activate", ())
            .map_err(|error| error.to_string())?;
        wait_for_benchmark_timing(&receiver, true)
    })();
    clear_benchmark_reader_window(&label, &window);
    result
}

/// Opens a bounded set of larger EPUBs in short-lived invisible shells. It
/// measures shell loading, first-page layout and display without showing a
/// window, marking a book read, or saving reading progress.
#[tauri::command]
pub(crate) async fn benchmark_reader_shell_opening(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ReaderShellPreloadBenchmark, String> {
    if !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
        return Err("请先开启预加载，再进行打开测速。".to_string());
    }
    let books = largest_epub_benchmark_books(state.inner());
    if books.is_empty() {
        return Err("书架中没有可测速的 EPUB 图书。".to_string());
    }
    let app_for_benchmark = app.clone();
    let samples = tauri::async_runtime::spawn_blocking(move || {
        books
            .iter()
            .map(|book| {
                let regular_open_ms = benchmark_regular_reader_open(&app_for_benchmark, book)?;
                let preloaded_open_ms = benchmark_preloaded_reader_open(&app_for_benchmark, book)?;
                Ok(ReaderShellBenchmarkSample {
                    title: book.title.clone(),
                    cover_url: book.cover_url.clone(),
                    improvement_ms: i64::from(regular_open_ms.total_ms)
                        - i64::from(preloaded_open_ms.total_ms),
                    regular: regular_open_ms,
                    preloaded: preloaded_open_ms,
                })
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| format!("图书打开测速任务失败：{error}"))??;
    let mut regular_times: Vec<u32> = samples
        .iter()
        .map(|sample| sample.regular.total_ms)
        .collect();
    let mut preloaded_times: Vec<u32> = samples
        .iter()
        .map(|sample| sample.preloaded.total_ms)
        .collect();
    regular_times.sort_unstable();
    preloaded_times.sort_unstable();
    let regular_median_ms = benchmark_percentile(&regular_times, 1, 2);
    let preloaded_median_ms = benchmark_percentile(&preloaded_times, 1, 2);
    Ok(ReaderShellPreloadBenchmark {
        regular_median_ms,
        preloaded_median_ms,
        improvement_median_ms: i64::from(regular_median_ms) - i64::from(preloaded_median_ms),
        samples,
    })
}

pub(crate) fn record_reader_ready(window: &tauri::WebviewWindow) {
    if let Some((started, source)) = READER_OPEN_STARTED_AT
        .lock()
        .unwrap()
        .remove(window.label())
    {
        log(&format!(
            "reader_open_total label={} source={source} elapsed_ms={}",
            window.label(),
            started.elapsed().as_millis()
        ));
    }
}

fn emit_reader_window_trace(
    app: &tauri::AppHandle,
    phase: &str,
    outcome: &str,
    duration: Duration,
) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "reader-window-trace",
            serde_json::json!({
                "phase": phase,
                "outcome": outcome,
                "durationMs": duration.as_millis().min(u128::from(u32::MAX)) as u32,
            }),
        );
    }
}

fn activate_shelf_after_reader_close(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if !main.is_visible().unwrap_or(false) {
        emit_reader_window_trace(app, "focus_restore", "skipped_hidden", Duration::ZERO);
        return;
    }
    let _ = main.unminimize();
    let window_focus_requested = main.set_focus().is_ok();
    #[cfg(target_os = "windows")]
    let focus_confirmed = main
        .hwnd()
        .ok()
        .map(|window| windows_activation::activate(window.0))
        .unwrap_or(false);
    #[cfg(not(target_os = "windows"))]
    let focus_confirmed = false;
    // WebviewWindow::set_focus only focuses the native top-level window. The
    // embedded WebView has its own focus dispatcher (WebView2 MoveFocus on
    // Windows); without this call the first shelf click is consumed merely to
    // reactivate the document and never reaches the book-card handler.
    let webview_focus_requested = main.as_ref().set_focus().is_ok();
    let outcome = if focus_confirmed && webview_focus_requested {
        "focused"
    } else if window_focus_requested || webview_focus_requested {
        "requested"
    } else {
        "failed"
    };
    emit_reader_window_trace(app, "focus_restore", outcome, Duration::ZERO);
}
fn schedule_shelf_activation_after_reader_close(app: &tauri::AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(300);
        while app.get_webview_window(&label).is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if app.get_webview_window(&label).is_some() {
            emit_reader_window_trace(&app, "focus_restore", "unregister_timeout", Duration::ZERO);
            return;
        }
        if any_reader_window_open(&app) {
            emit_reader_window_trace(&app, "focus_restore", "skipped_reader_open", Duration::ZERO);
            return;
        }
        let focus_app = app.clone();
        if app
            .run_on_main_thread(move || {
                if any_reader_window_open(&focus_app) {
                    emit_reader_window_trace(
                        &focus_app,
                        "focus_restore",
                        "skipped_reader_open",
                        Duration::ZERO,
                    );
                } else {
                    activate_shelf_after_reader_close(&focus_app);
                }
            })
            .is_err()
        {
            emit_reader_window_trace(&app, "focus_restore", "dispatch_failed", Duration::ZERO);
        }
    });
}
pub(crate) fn persist_main_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let state = app.state::<AppState>();
    let previous_geom = state
        .library
        .try_lock()
        .ok()
        .and_then(|library| library.main_geom.clone());
    let closing_geom = capture_geom(previous_geom, window);
    if let Ok(mut library) = state.library.try_lock() {
        library.main_geom = Some(closing_geom);
        report_save_error("书架", library.save());
    } else {
        log("[close] shelf save deferred because the library is busy");
    }
    if let Ok(mut stats) = state.stats.try_lock() {
        report_save_error("统计", stats.save());
    } else {
        log("[close] stats save deferred because the statistics store is busy");
    };
}

#[tauri::command]
pub(crate) fn main_window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn main_window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub(crate) fn main_window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label().starts_with("reader-") {
        let app = window.app_handle().clone();
        let state = app.state::<AppState>();
        if let Some(id) = reader_window_id(&window) {
            if let Some(task) = state.page_count_tasks.lock().unwrap().remove(&id) {
                let _ = task.pause();
            }
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit(
                    "reader-closed-for-reopen",
                    serde_json::json!({ "bookId": id.to_string() }),
                );
            }
        }
        {
            let mut library = state.library.lock().unwrap();
            update_reader_geom(&mut library, &window);
            report_save_error("书架", library.save());
        }
        report_save_error("统计", state.stats.lock().unwrap().save());
        window.hide().map_err(|error| error.to_string())?;
        emit_reader_window_trace(&app, "close_command", "hidden_cached", Duration::ZERO);
        activate_shelf_after_reader_close(&app);
        return Ok(());
    }
    let app = window.app_handle().clone();
    if crate::startup_enhancement::should_keep_running(&app) {
        persist_main_window_state(&app, &window);
        crate::startup_enhancement::background_main(&app);
        return Ok(());
    }
    window.close().map_err(|e| e.to_string())
}

/// Records that the reader WebView itself confirmed its final position before
/// the native window was hidden. This is deliberately a separate command from
/// `main_window_close`: OS/window-manager closes do not provide that
/// confirmation and must keep the conservative save path on the next switch.
#[tauri::command]
pub(crate) fn reader_shell_hidden_after_save(window: tauri::WebviewWindow) -> Result<(), String> {
    if reader_window_id(&window).is_none()
        || window.is_visible().map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    RECENTLY_SAVED_HIDDEN_READER_SHELLS
        .lock()
        .unwrap()
        .insert(window.label().to_string(), Instant::now());
    emit_reader_window_trace(
        window.app_handle(),
        "close_command",
        "saved_hidden_cached",
        Duration::ZERO,
    );
    Ok(())
}

/// End the application after an explicit user action. This must not be folded
/// into `main_window_close`: with startup enhancement enabled that command is
/// deliberately a hide-and-keep-running action.
#[tauri::command]
pub(crate) fn main_window_exit(app: tauri::AppHandle) -> Result<(), String> {
    EXPLICIT_APPLICATION_EXIT_REQUESTED.store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

/// Consumed by the application event loop when an exit request arrives.
pub(crate) fn take_explicit_application_exit_request() -> bool {
    EXPLICIT_APPLICATION_EXIT_REQUESTED.swap(false, Ordering::AcqRel)
}

/// 主窗口以隐藏状态创建，等待书架完成首帧绘制后再由前端调用。
/// 这能避免 WebView2 在默认左上位置短暂显示白色空窗口。
#[tauri::command]
pub(crate) fn main_window_show(window: tauri::WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    crate::startup_enhancement::reveal_main(&app)?;
    schedule_clean_reader_shell(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn main_window_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

fn parse_resize_direction(direction: &str) -> Option<tauri_runtime::ResizeDirection> {
    use tauri_runtime::ResizeDirection;

    match direction {
        "north" => Some(ResizeDirection::North),
        "north-east" => Some(ResizeDirection::NorthEast),
        "east" => Some(ResizeDirection::East),
        "south-east" => Some(ResizeDirection::SouthEast),
        "south" => Some(ResizeDirection::South),
        "south-west" => Some(ResizeDirection::SouthWest),
        "west" => Some(ResizeDirection::West),
        "north-west" => Some(ResizeDirection::NorthWest),
        _ => None,
    }
}

/// 无边框窗口没有由 Linux 窗口管理器提供的可拖动边框。前端的八方向
/// 命中区在按下鼠标时调用此命令，把后续拖动交还给系统窗口管理器处理。
#[tauri::command]
pub(crate) fn main_window_start_resize_dragging(
    window: tauri::WebviewWindow,
    direction: String,
) -> Result<(), String> {
    let direction = parse_resize_direction(&direction)
        .ok_or_else(|| format!("invalid resize direction: {direction}"))?;
    window
        .as_ref()
        .window()
        .start_resize_dragging(direction)
        .map_err(|error| error.to_string())
}

pub(crate) fn any_reader_window_open(app: &tauri::AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        label.starts_with("reader-")
            && reader_window_id(&window).is_some()
            && window.is_visible().unwrap_or(false)
    })
}

pub(crate) fn any_bound_reader_window(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .into_values()
        .any(|window| reader_window_id(&window).is_some())
}

#[tauri::command]
pub(crate) fn reader_window_open(app: tauri::AppHandle) -> bool {
    any_reader_window_open(&app)
}

fn reader_id_from_label(label: &str) -> Option<u64> {
    label
        .strip_prefix("reader-")
        .and_then(|id| id.split('-').next())
        .and_then(|id| id.parse().ok())
}

/// 从阅读窗口 label 取图书 id。
pub(crate) fn reader_window_id(window: &tauri::WebviewWindow) -> Option<u64> {
    READER_WINDOW_BOOK_IDS
        .lock()
        .unwrap()
        .get(window.label())
        .copied()
        .or_else(|| reader_id_from_label(window.label()))
}

fn install_reader_window_lifecycle(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let event_app = app.clone();
    let event_label = window.label().to_string();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let bound_reader = event_app
                .get_webview_window(&event_label)
                .is_some_and(|window| reader_window_id(&window).is_some());
            if bound_reader {
                api.prevent_close();
                if let Some(closing) = event_app.get_webview_window(&event_label) {
                    let _ = closing.emit("reader-hide-request", ());
                }
                emit_reader_window_trace(
                    &event_app,
                    "close_requested",
                    "save_requested",
                    Duration::ZERO,
                );
            }
        } else if let tauri::WindowEvent::Destroyed = event {
            let was_replacing = REPLACING_READER_WINDOWS
                .lock()
                .unwrap()
                .remove(&event_label);
            READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&event_label);
            clear_recent_hidden_reader_save(&event_label);
            READY_READER_SHELLS.lock().unwrap().remove(&event_label);
            READER_OPEN_STARTED_AT.lock().unwrap().remove(&event_label);
            PREPARED_READER_SWITCH_SHELLS
                .lock()
                .unwrap()
                .retain(|_, prepared_label| prepared_label != &event_label);
            emit_reader_window_trace(&event_app, "destroyed", "closed", Duration::ZERO);
            if !was_replacing {
                schedule_shelf_activation_after_reader_close(&event_app, &event_label);
            }
        }
    });
}

fn mark_reader_opened(app: &tauri::AppHandle, state: &AppState, id_num: u64) {
    let last_read_at = {
        let mut library = state.library.lock().unwrap();
        library.mark_read(id_num);
        library
            .get(id_num)
            .map(|book| book.last_read_at)
            .unwrap_or(0)
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "shelf-book-read",
            serde_json::json!({
                "id": id_num.to_string(),
                "lastReadAt": last_read_at,
            }),
        );
    }
    let save_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let state = save_app.state::<AppState>();
        report_save_error("书架", state.library.lock().unwrap().save());
    });
    schedule_recent_reading_chapter_cache(app);
}

fn spawn_clean_reader_shell(app: &tauri::AppHandle) -> Result<(), String> {
    if !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
        return Ok(());
    }
    if app
        .webview_windows()
        .into_iter()
        .any(|(label, window)| is_reader_shell_label(&label) && reader_window_id(&window).is_none())
    {
        return Ok(());
    }
    let label = format!(
        "reader-pool-{}",
        READER_SHELL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let url = tauri::WebviewUrl::App("reader.html?pool=1".into());
    let builder = tauri::WebviewWindowBuilder::new(app, &label, url)
        .title("阅读")
        .visible(false)
        .decorations(false)
        .resizable(true)
        .inner_size(880.0, 760.0)
        .min_inner_size(420.0, 320.0);
    #[cfg(target_os = "macos")]
    let builder = if let Some(identifier) = crate::profile::webview_data_store_identifier() {
        builder.data_store_identifier(identifier)
    } else {
        builder
    };
    let window = builder.build().map_err(|error| error.to_string())?;
    install_reader_window_lifecycle(app, &window);
    log(&format!("reader_shell_pool built label={label}"));
    Ok(())
}

pub(crate) fn schedule_clean_reader_shell(app: &tauri::AppHandle) {
    if !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
        return;
    }
    if app
        .webview_windows()
        .into_iter()
        .any(|(label, window)| is_reader_shell_label(&label) && reader_window_id(&window).is_none())
        || READER_SHELL_BUILD_SCHEDULED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        if let Err(error) = spawn_clean_reader_shell(&app) {
            log(&format!("reader_shell_pool build_failed error={error}"));
        }
        READER_SHELL_BUILD_SCHEDULED.store(false, Ordering::Release);
    });
}

#[tauri::command]
pub(crate) fn reader_shell_pool_ready(window: tauri::WebviewWindow) {
    if is_reader_shell_label(window.label()) {
        READY_READER_SHELLS
            .lock()
            .unwrap()
            .insert(window.label().to_string());
        log(&format!("reader_shell_pool ready label={}", window.label()));
    }
}

fn take_clean_reader_shell(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let ready_labels = READY_READER_SHELLS.lock().unwrap().clone();
    let shell = app
        .webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            (is_reader_shell_label(&label) && ready_labels.contains(&label)).then_some(window)
        });
    if let Some(window) = shell.as_ref() {
        READY_READER_SHELLS.lock().unwrap().remove(window.label());
    }
    shell
}

fn take_prepared_reader_switch_shell(
    app: &tauri::AppHandle,
    id_num: u64,
) -> Option<tauri::WebviewWindow> {
    let label = PREPARED_READER_SWITCH_SHELLS
        .lock()
        .unwrap()
        .remove(&id_num)?;
    let window = app.get_webview_window(&label)?;
    (reader_window_id(&window) == Some(id_num)).then_some(window)
}

#[tauri::command]
pub(crate) fn prepare_reader_switch_target(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    id: String,
) -> Result<bool, String> {
    let id_num = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    // Only a bound, visible reader may claim a target. This rejects a stale
    // event from an empty pool shell before it can attempt a meaningless
    // chapter-0 progress write.
    if reader_window_id(&window).is_none() || !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire)
    {
        return Ok(false);
    }
    let app = window.app_handle().clone();
    if let Some(label) = PREPARED_READER_SWITCH_SHELLS
        .lock()
        .unwrap()
        .get(&id_num)
        .cloned()
    {
        if app.get_webview_window(&label).is_some() {
            return Ok(true);
        }
        PREPARED_READER_SWITCH_SHELLS
            .lock()
            .unwrap()
            .remove(&id_num);
    }
    let open_started = PENDING_READER_SWITCH_STARTED_AT
        .lock()
        .unwrap()
        .get(&id_num)
        .copied()
        .filter(|started| started.elapsed() <= Duration::from_secs(15))
        .unwrap_or_else(Instant::now);
    let (title, is_pdf, path_exists) = {
        let library = state.library.lock().unwrap();
        let book = library.get(id_num).ok_or("找不到这本书")?;
        (book.title.clone(), book.format == "pdf", book.path.exists())
    };
    if !path_exists {
        return Err("源文件已丢失，请在书架上对这本书重新定位。".to_string());
    }
    let geom = {
        let library = state.library.lock().unwrap();
        if is_pdf {
            library.reader_geom_pdf.clone()
        } else {
            library.reader_geom.clone()
        }
    };
    let on_screen = geom
        .as_ref()
        .map(|saved| {
            app.get_webview_window("main")
                .map(|main| position_on_screen(&main, saved))
                .unwrap_or(true)
        })
        .unwrap_or(false);
    let Some(shell) = take_clean_reader_shell(&app) else {
        emit_reader_window_trace(&app, "open_pool", "unavailable", open_started.elapsed());
        schedule_clean_reader_shell(&app);
        return Ok(false);
    };
    let shell_label = shell.label().to_string();
    READER_WINDOW_BOOK_IDS
        .lock()
        .unwrap()
        .insert(shell_label.clone(), id_num);
    if let Err(error) = shell.set_title(&title) {
        READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&shell_label);
        let _ = shell.destroy();
        schedule_clean_reader_shell(&app);
        return Err(error.to_string());
    }
    if let Some(saved) = geom
        .as_ref()
        .filter(|saved| saved.w >= 300.0 && saved.h >= 300.0)
    {
        let _ = shell.set_size(tauri::LogicalSize::new(saved.w, saved.h));
        if on_screen {
            let _ = shell.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
        }
    } else {
        let _ = shell.set_size(tauri::LogicalSize::new(880.0, 760.0));
    }
    READER_OPEN_STARTED_AT
        .lock()
        .unwrap()
        .insert(shell_label.clone(), (open_started, "pooled_shell"));
    if let Err(error) = shell.emit("reader-shell-activate", ()) {
        READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&shell_label);
        READER_OPEN_STARTED_AT.lock().unwrap().remove(&shell_label);
        let _ = shell.destroy();
        schedule_clean_reader_shell(&app);
        return Err(error.to_string());
    }
    PREPARED_READER_SWITCH_SHELLS
        .lock()
        .unwrap()
        .insert(id_num, shell_label);
    emit_reader_window_trace(&app, "open_pool", "binding", open_started.elapsed());
    schedule_clean_reader_shell(&app);
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_prepared_reader_switch_target(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    let id_num = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    let app = window.app_handle();
    PENDING_READER_SWITCH_STARTED_AT
        .lock()
        .unwrap()
        .remove(&id_num);
    if let Some(prepared) = take_prepared_reader_switch_shell(app, id_num) {
        READER_WINDOW_BOOK_IDS
            .lock()
            .unwrap()
            .remove(prepared.label());
        READER_OPEN_STARTED_AT
            .lock()
            .unwrap()
            .remove(prepared.label());
        let _ = prepared.destroy();
        schedule_clean_reader_shell(app);
    }
    Ok(())
}

/// 创建/聚焦某本书的阅读窗口，恢复上次几何位置；返回该窗口。
pub(crate) fn ensure_reader_window(
    app: &tauri::AppHandle,
    state: &AppState,
    id_num: u64,
) -> Result<tauri::WebviewWindow, String> {
    let open_started = PENDING_READER_SWITCH_STARTED_AT
        .lock()
        .unwrap()
        .remove(&id_num)
        .filter(|started| started.elapsed() <= Duration::from_secs(15))
        .unwrap_or_else(Instant::now);
    let label = format!("reader-{id_num}");
    if let Some((_, window)) = app
        .webview_windows()
        .into_iter()
        .find(|(reader_label, window)| {
            reader_label.starts_with("reader-")
                && !reader_window_is_closing(reader_label)
                && reader_window_id(window) == Some(id_num)
        })
    {
        clear_recent_hidden_reader_save(window.label());
        let _ = window.show();
        let _ = window.unminimize();
        let focused = window.set_focus().is_ok();
        let _ = window.emit("reader-shell-resume", ());
        emit_reader_window_trace(
            app,
            "open_existing",
            if focused { "focused" } else { "shown" },
            open_started.elapsed(),
        );
        log(&format!(
            "reader_open_total label={} source=same_book elapsed_ms={}",
            window.label(),
            open_started.elapsed().as_millis()
        ));
        return Ok(window);
    }
    // 同一本书直接复用隐藏的 WebView；切换到另一本书时，旧页先保存精确位置，
    // complete_reader_switch 再销毁旧 WebView 并创建新窗口。WebKit 的同页 navigate
    // 可能保留旧 iframe，绝不能冒险把旧书正文绑定到新书 ID。
    if let Some((_, window)) = app
        .webview_windows()
        .into_iter()
        .find(|(other_label, window)| {
            other_label.starts_with("reader-")
                && !reader_window_is_closing(other_label)
                && reader_window_id(window).is_some()
        })
    {
        let skip_final_save =
            !window.is_visible().unwrap_or(true) && reader_was_recently_hidden_after_save(&window);
        // 旧阅读页保存位置、阅读时长和生词时通常需要一段时间。若用户开启了
        // 预加载，就在这段等待里并行准备一枚干净外壳；complete_reader_switch
        // 销毁旧页后即可直接取用，避免每次换书都退回到冷启动。
        if READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
            schedule_clean_reader_shell(app);
            emit_reader_window_trace(app, "open_pool", "preparing", open_started.elapsed());
        }
        PENDING_READER_SWITCH_STARTED_AT
            .lock()
            .unwrap()
            .insert(id_num, open_started);
        if let Err(error) = window.emit(
            "reader-switch-request",
            serde_json::json!({
                "bookId": id_num.to_string(),
                "skipFinalSave": skip_final_save,
            }),
        ) {
            PENDING_READER_SWITCH_STARTED_AT
                .lock()
                .unwrap()
                .remove(&id_num);
            return Err(error.to_string());
        }
        emit_reader_window_trace(app, "open_reuse", "save_requested", open_started.elapsed());
        return Ok(window);
    }
    if let Some(window) = app.get_webview_window(&label) {
        if !reader_window_is_closing(&label) && reader_window_id(&window) == Some(id_num) {
            clear_recent_hidden_reader_save(window.label());
            let shown = window.show().is_ok();
            let restored = window.unminimize().is_ok();
            let focused = window.set_focus().is_ok();
            let _ = window.emit("reader-shell-resume", ());
            emit_reader_window_trace(
                app,
                "open_existing",
                if shown || restored || focused {
                    "focused"
                } else {
                    "failed"
                },
                open_started.elapsed(),
            );
            return Ok(window);
        }
        // CloseRequested 到 Destroyed 之间，同名窗口仍会短暂留在 Tauri 注册表中。
        // 必须一直保留 closing 标记到注册项真正消失；Destroyed 事件早于注销，
        // 若在那里清标记，第一次点击会误聚焦已销毁的旧 WebView 并返回成功。
        emit_reader_window_trace(app, "open_wait", "started", open_started.elapsed());
        log(&format!(
            "open_book waiting for closing window label={label}"
        ));
        // WebView2 偶发会在 CloseRequested 后迟迟不从 Tauri 注册表注销。用户
        // 已明确关闭窗口，因此短暂等待后可以销毁这个旧句柄；否则第一次书架点击
        // 会只等到超时，必须再点一次才会真正创建新窗口。
        let graceful_deadline = Instant::now() + Duration::from_millis(700);
        while app.get_webview_window(&label).is_some() && Instant::now() < graceful_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(stale_window) = app.get_webview_window(&label) {
            emit_reader_window_trace(app, "open_wait", "force_destroy", open_started.elapsed());
            log(&format!(
                "open_book force destroying stale closing window label={label}"
            ));
            let _ = stale_window.destroy();
            let destroy_deadline = Instant::now() + Duration::from_millis(1800);
            while app.get_webview_window(&label).is_some() && Instant::now() < destroy_deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if app.get_webview_window(&label).is_some() {
            emit_reader_window_trace(app, "open_wait", "timeout", open_started.elapsed());
            return Err("阅读窗口仍在关闭，请稍候再试。".to_string());
        }
        set_reader_window_closing(&label, false);
        emit_reader_window_trace(app, "open_wait", "unregistered", open_started.elapsed());
    } else if reader_window_is_closing(&label) {
        // Destroyed 早于 Tauri 注销；若此时已经查不到同名注册项，说明旧窗口
        // 已完整退出。由本次打开原子地清标记并继续创建，不启动会误碰新窗口
        // 的后台清理线程。
        set_reader_window_closing(&label, false);
        emit_reader_window_trace(
            app,
            "open_wait",
            "already_unregistered",
            open_started.elapsed(),
        );
    }
    // 新开窗口期间，暂停语义索引几秒，把 CPU 让给 WebView2 冷启动 → 窗口秒开
    state
        .index_resume_at
        .store(now_ms() + 6000, Ordering::Relaxed);

    // 只读一下书名（快），先把窗口建出来，优先让页面打开
    let title = {
        let library = state.library.lock().unwrap();
        library
            .get(id_num)
            .map(|book| book.title.clone())
            .unwrap_or_else(|| "阅读".to_string())
    };

    // 读取上次阅读窗口的大小/位置，本次按它恢复（EPUB 与 PDF 分开记，各自适应）
    let is_pdf = state
        .library
        .lock()
        .unwrap()
        .get(id_num)
        .map(|book| book.format == "pdf")
        .unwrap_or(false);
    let geom = {
        let library = state.library.lock().unwrap();
        if is_pdf {
            library.reader_geom_pdf.clone()
        } else {
            library.reader_geom.clone()
        }
    };
    // 用主窗口的显示器信息判断保存的位置是否还在屏幕内（防止阅读窗口跑到屏幕外）
    let on_screen = geom
        .as_ref()
        .map(|saved| {
            app.get_webview_window("main")
                .map(|main| position_on_screen(&main, saved))
                .unwrap_or(true)
        })
        .unwrap_or(false);

    let pooled_shell = take_clean_reader_shell(app);
    if pooled_shell.is_none() && READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
        // 这条诊断能让问题记录区分“预加载已关闭”和“已开启但外壳尚未就绪”。
        // 同时补排一个新外壳，供下一次打开或本次保存完成后的换书使用。
        emit_reader_window_trace(app, "open_pool", "unavailable", open_started.elapsed());
        schedule_clean_reader_shell(app);
    }
    if let Some(window) = pooled_shell {
        let pooled_label = window.label().to_string();
        READER_WINDOW_BOOK_IDS
            .lock()
            .unwrap()
            .insert(pooled_label.clone(), id_num);
        if let Err(error) = window.set_title(&title) {
            READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&pooled_label);
            let _ = window.destroy();
            schedule_clean_reader_shell(app);
            return Err(error.to_string());
        }
        if let Some(saved) = geom
            .as_ref()
            .filter(|saved| saved.w >= 300.0 && saved.h >= 300.0)
        {
            let _ = window.set_size(tauri::LogicalSize::new(saved.w, saved.h));
            if on_screen {
                let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
            }
        } else {
            let _ = window.set_size(tauri::LogicalSize::new(880.0, 760.0));
        }
        READER_OPEN_STARTED_AT
            .lock()
            .unwrap()
            .insert(pooled_label.clone(), (open_started, "pooled_shell"));
        if let Err(error) = window.emit("reader-shell-activate", ()) {
            READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&pooled_label);
            READER_OPEN_STARTED_AT.lock().unwrap().remove(&pooled_label);
            let _ = window.destroy();
            schedule_clean_reader_shell(app);
            return Err(error.to_string());
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if !on_screen {
            let _ = window.center();
        }
        if geom.as_ref().map(|saved| saved.maximized).unwrap_or(false) {
            let _ = window.maximize();
        }
        mark_reader_opened(app, state, id_num);
        log(&format!(
            "open_book pooled_shell label={pooled_label} elapsed_ms={}",
            open_started.elapsed().as_millis()
        ));
        emit_reader_window_trace(app, "open_pool", "activated", open_started.elapsed());
        schedule_clean_reader_shell(app);
        return Ok(window);
    }

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("reader.html".into()))
            .title(title)
            .decorations(false)
            .resizable(true)
            .min_inner_size(420.0, 320.0);
    #[cfg(target_os = "macos")]
    if let Some(identifier) = crate::profile::webview_data_store_identifier() {
        builder = builder.data_store_identifier(identifier);
    }
    match &geom {
        Some(saved) if saved.w >= 300.0 && saved.h >= 300.0 => {
            builder = builder.inner_size(saved.w, saved.h);
            if on_screen {
                builder = builder.position(saved.x, saved.y);
            }
        }
        _ => {
            builder = builder.inner_size(880.0, 760.0);
        }
    }
    let result = builder.build();
    log(&format!("open_book built ok={}", result.is_ok()));
    emit_reader_window_trace(
        app,
        "open_build",
        if result.is_ok() { "ok" } else { "failed" },
        open_started.elapsed(),
    );
    let window = result.map_err(|error| error.to_string())?;
    READER_WINDOW_BOOK_IDS
        .lock()
        .unwrap()
        .insert(label.clone(), id_num);
    READER_OPEN_STARTED_AT
        .lock()
        .unwrap()
        .insert(label.clone(), (open_started, "new_shell"));
    // macOS may create a new WebView window behind the shelf when the command
    // originates from an already-active app. Explicitly restore and focus it:
    // a successful build must result in a visible reader, not a background one.
    let shown = window.show().is_ok();
    let restored = window.unminimize().is_ok();
    let focused = window.set_focus().is_ok();
    log(&format!(
        "open_book activate shown={shown} restored={restored} focused={focused}"
    ));
    if !on_screen {
        let _ = window.center(); // 上次坐标已不在任何屏幕内 → 回到屏幕中央
    }
    if geom.as_ref().map(|saved| saved.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }

    // 只在关闭阅读窗口时保存几何信息。
    // Moved/Resized 在拖窗期间会高频触发；每次都跨 Rust 取位置并锁书库，会让阅读页拖动周期性卡顿。
    install_reader_window_lifecycle(app, &window);

    // 先只更新内存里的“最近阅读”。旧实现此处持有书架锁同步写盘，恰好会
    // 挡住新 WebView 紧接着发出的 book_info，导致窗口出现后仍长时间空白。
    mark_reader_opened(app, state, id_num);
    Ok(window)
}

#[tauri::command]
pub(crate) fn complete_reader_switch(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), String> {
    let started = Instant::now();
    let id_num = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    let path = {
        let library = state.library.lock().unwrap();
        let book = library.get(id_num).ok_or("找不到这本书")?;
        book.path.clone()
    };
    if !path.exists() {
        return Err("源文件已丢失，请在书架上对这本书重新定位。".to_string());
    }
    let app = window.app_handle().clone();
    let old_label = window.label().to_string();
    let old_id = reader_window_id(&window);
    if let Some(old_id) = old_id {
        if let Some(task) = state.page_count_tasks.lock().unwrap().remove(&old_id) {
            let _ = task.pause();
        }
    }
    // 通常这一步已经在 reader-switch-request 时触发；保留这里作为 IPC
    // 直接进入 complete_reader_switch 时的兜底，确保目标书始终有机会复用池。
    schedule_clean_reader_shell(&app);
    set_reader_window_closing(&old_label, true);
    REPLACING_READER_WINDOWS
        .lock()
        .unwrap()
        .insert(old_label.clone());
    READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&old_label);
    if let Err(error) = window.destroy() {
        REPLACING_READER_WINDOWS.lock().unwrap().remove(&old_label);
        set_reader_window_closing(&old_label, false);
        if let Some(old_id) = old_id {
            READER_WINDOW_BOOK_IDS
                .lock()
                .unwrap()
                .insert(old_label, old_id);
        }
        return Err(error.to_string());
    }
    // 目标书使用不同的窗口标签，可以立刻创建。不要在这条同步 IPC 中等待
    // macOS 主线程注销旧 WebView；注销事件本身也需要主线程，等待会形成互锁。
    if let Some(prepared) = take_prepared_reader_switch_shell(&app, id_num) {
        let switch_started = PENDING_READER_SWITCH_STARTED_AT
            .lock()
            .unwrap()
            .remove(&id_num)
            .filter(|pending| pending.elapsed() <= Duration::from_secs(15))
            .unwrap_or(started);
        let prepared_label = prepared.label().to_string();
        let shown = prepared.show().is_ok();
        let restored = prepared.unminimize().is_ok();
        let focused = prepared.set_focus().is_ok();
        if !shown {
            return Err("预加载阅读窗口无法显示。".to_string());
        }
        if !restored || !focused {
            log(&format!(
                "reader_switch prepared_activate label={prepared_label} restored={restored} focused={focused}"
            ));
        }
        mark_reader_opened(&app, &state, id_num);
        emit_reader_window_trace(&app, "open_pool", "activated", switch_started.elapsed());
        schedule_clean_reader_shell(&app);
    } else {
        ensure_reader_window(&app, &state, id_num)?;
    }
    emit_reader_window_trace(&app, "open_replace", "rebuilt", started.elapsed());
    Ok(())
}

/// 根据窗口当前状态算出几何信息（逻辑像素）。最大化时只更新 maximized 标志，
/// 保留之前的还原尺寸/位置，避免把全屏尺寸当成正常大小。
pub(crate) fn capture_geom(prev: Option<WinGeom>, window: &tauri::WebviewWindow) -> WinGeom {
    let mut geom = prev.unwrap_or_default();
    // 最小化时 Windows 把窗口坐标报成 -32000 之类的哨兵值，绝不能采集，否则下次打开会跑到屏幕外
    if window.is_minimized().unwrap_or(false) {
        return geom;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let maximized = window.is_maximized().unwrap_or(false);
    geom.maximized = maximized;
    if !maximized {
        if let Ok(size) = window.inner_size() {
            let logical = size.to_logical::<f64>(scale);
            if logical.width > 100.0 && logical.height > 100.0 {
                geom.w = logical.width;
                geom.h = logical.height;
            }
        }
        if let Ok(position) = window.outer_position() {
            let logical = position.to_logical::<f64>(scale);
            // 再保险一层：明显越界的坐标不采集
            if logical.x > -10000.0 && logical.y > -10000.0 {
                geom.x = logical.x;
                geom.y = logical.y;
            }
        }
    }
    geom
}

/// 主显示器的逻辑尺寸（宽,高）。
fn primary_logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let monitor = window.primary_monitor().ok().flatten().or_else(|| {
        window
            .available_monitors()
            .ok()
            .and_then(|monitors| monitors.into_iter().next())
    })?;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// 在主显示器上居中放置一个 w×h 窗口时的左上角逻辑坐标。
fn centered_position(window: &tauri::WebviewWindow, w: f64, h: f64) -> Option<(f64, f64)> {
    let monitor = window.primary_monitor().ok().flatten().or_else(|| {
        window
            .available_monitors()
            .ok()
            .and_then(|monitors| monitors.into_iter().next())
    })?;
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let (mx, my) = (position.x as f64 / scale, position.y as f64 / scale);
    let (mw, mh) = (size.width as f64 / scale, size.height as f64 / scale);
    Some((mx + (mw - w).max(0.0) / 2.0, my + (mh - h).max(0.0) / 2.0))
}

/// 把当前阅读窗口的大小/位置写入内存中的书库（不立即落盘，关闭时再统一保存）。
/// EPUB 与 PDF 各存各的，互不影响。
fn update_reader_geom(library: &mut Library, window: &tauri::WebviewWindow) {
    let is_pdf = reader_window_id(window)
        .and_then(|id| library.get(id).map(|book| book.format == "pdf"))
        .unwrap_or(false);
    if is_pdf {
        library.reader_geom_pdf = Some(capture_geom(library.reader_geom_pdf.clone(), window));
    } else {
        library.reader_geom = Some(capture_geom(library.reader_geom.clone(), window));
    }
}

fn overlaps_visible_area(window: (f64, f64, f64, f64), monitor: (f64, f64, f64, f64)) -> bool {
    let (wx, wy, ww, wh) = window;
    let (mx, my, mw, mh) = monitor;
    let overlap_x = (wx + ww).min(mx + mw) - wx.max(mx);
    let overlap_y = (wy + wh).min(my + mh) - wy.max(my);
    overlap_x > 100.0 && overlap_y > 60.0
}

/// 判断保存的几何位置是否还落在某个显示器内（避免窗口跑到屏幕外、只剩任务栏图标）。
/// 任一显示器与窗口矩形有足够重叠即认为可见。
fn position_on_screen(window: &tauri::WebviewWindow, geom: &WinGeom) -> bool {
    let monitors = match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        _ => return false,
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let window_rect = (
        geom.x * scale,
        geom.y * scale,
        geom.w * scale,
        geom.h * scale,
    );
    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        overlaps_visible_area(
            window_rect,
            (
                position.x as f64,
                position.y as f64,
                size.width as f64,
                size.height as f64,
            ),
        )
    })
}

/// 安全地把保存的几何信息应用到窗口：尺寸超屏会收缩，位置越界则真正居中（不依赖 center()）。
pub(crate) fn apply_geom_safe(window: &tauri::WebviewWindow, geom: &Option<WinGeom>) {
    // Geometry is applied while hidden. This is also important on macOS, where
    // AppKit may animate a maximization that was requested after a window was
    // already visible.
    let _ = window.hide();
    let _ = window.unminimize();
    if let Some(saved) = geom {
        // 目标尺寸，超过主屏幕则收缩，避免窗口比屏幕还大
        let (mut width, mut height) = (saved.w, saved.h);
        if let Some((monitor_width, monitor_height)) = primary_logical_size(window) {
            if width > monitor_width {
                width = (monitor_width - 40.0).max(300.0);
            }
            if height > monitor_height {
                height = (monitor_height - 60.0).max(300.0);
            }
        }
        if width >= 300.0 && height >= 300.0 {
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
            if position_on_screen(window, saved) {
                let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
            } else if let Some((x, y)) = centered_position(window, width, height) {
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
            }
        }
        if saved.maximized {
            let _ = window.maximize();
        }
    }
    // 首帧绘制之前保持隐藏；前端在书架渲染完后调用 main_window_show。
    let _ = window.unminimize();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_labels_only_accept_numeric_reader_windows() {
        assert_eq!(reader_id_from_label("reader-42"), Some(42));
        assert_eq!(reader_id_from_label("reader-42-benchmark-9"), Some(42));
        assert_eq!(reader_id_from_label("reader-"), None);
        assert_eq!(reader_id_from_label("reader-settings"), None);
        assert_eq!(reader_id_from_label("main"), None);
    }

    #[test]
    fn screen_visibility_requires_meaningful_overlap() {
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        assert!(overlaps_visible_area(
            (1800.0, 1000.0, 400.0, 300.0),
            monitor
        ));
        assert!(!overlaps_visible_area(
            (1850.0, 1000.0, 400.0, 300.0),
            monitor
        ));
        assert!(!overlaps_visible_area(
            (-400.0, -300.0, 200.0, 200.0),
            monitor
        ));
    }

    #[test]
    fn resize_directions_accept_only_the_eight_window_edges() {
        use tauri_runtime::ResizeDirection;

        assert_eq!(
            parse_resize_direction("north"),
            Some(ResizeDirection::North)
        );
        assert_eq!(
            parse_resize_direction("south-east"),
            Some(ResizeDirection::SouthEast)
        );
        assert_eq!(
            parse_resize_direction("north-west"),
            Some(ResizeDirection::NorthWest)
        );
        assert_eq!(parse_resize_direction("center"), None);
        assert_eq!(parse_resize_direction(""), None);
    }

    #[test]
    fn benchmark_telemetry_accepts_only_existing_shell_phases() {
        assert!(matches!(
            benchmark_phase_from_perf_event("shell_bootstrap elapsed_ms=12.4"),
            Some(ReaderShellBenchmarkPhase::ShellBootstrap(12))
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("shell_ready elapsed_ms=93.5"),
            Some(ReaderShellBenchmarkPhase::FrameReady(94))
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("shell_prepared"),
            Some(ReaderShellBenchmarkPhase::ShellPrepared)
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("page_layout_ready"),
            Some(ReaderShellBenchmarkPhase::PageLayoutReady(0))
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("page_displayed"),
            Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(0))
        ));
        assert_eq!(
            benchmark_phase_from_perf_event("chapter_ready elapsed_ms=1"),
            None
        );
        assert!(is_first_page_render_event(
            "mac_page_render chapter=1 page=1 virtual=0 items=3"
        ));
        assert!(!is_first_page_render_event(
            "mac_page_render chapter=1 page=2 virtual=0 items=3"
        ));
        assert_eq!(benchmark_percentile(&[5, 9, 14, 21], 1, 2), 14);

        let regular = benchmark_timing(Some(35), 240, 275, false);
        assert_eq!(regular.shell_ms, 35);
        assert_eq!(regular.layout_ms, 205);
        assert_eq!(regular.display_ms, 35);
        assert_eq!(regular.total_ms, 275);
        let preloaded = benchmark_timing(None, 240, 275, true);
        assert_eq!(preloaded.shell_ms, 0);
        assert_eq!(preloaded.layout_ms, 240);
        assert_eq!(preloaded.display_ms, 35);
    }
}
