use crate::{
    book::{Library, PhysicalWinGeom, WinGeom},
    log, now_ms, report_save_error, AppState,
};
use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
        #[link_name = "SetForegroundWindow"]
        fn set_foreground_window(window: Hwnd) -> i32;
        #[link_name = "SetWindowPos"]
        fn set_window_pos(
            window: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        #[link_name = "GetGUIThreadInfo"]
        fn get_gui_thread_info(thread_id: u32, info: *mut GuiThreadInfo) -> i32;
        #[link_name = "GetWindowThreadProcessId"]
        fn get_window_thread_process_id(window: Hwnd, process_id: *mut u32) -> u32;
        #[link_name = "IsChild"]
        fn is_child(parent: Hwnd, child: Hwnd) -> i32;
        #[link_name = "ShowWindowAsync"]
        fn show_window_async(window: Hwnd, command: i32) -> i32;
    }

    pub(super) fn set_outer_geometry(
        window: Hwnd,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        resize: bool,
        reposition: bool,
    ) -> bool {
        const SWP_NOSIZE: u32 = 0x0001;
        const SWP_NOMOVE: u32 = 0x0002;
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        let mut flags = SWP_NOZORDER | SWP_NOACTIVATE;
        if !resize {
            flags |= SWP_NOSIZE;
        }
        if !reposition {
            flags |= SWP_NOMOVE;
        }
        if !resize && !reposition {
            return true;
        }
        // SAFETY: Tauri supplied this HWND for a live window. SetWindowPos
        // copies the numeric rectangle and does not retain any pointer.
        unsafe {
            set_window_pos(
                window,
                std::ptr::null_mut(),
                x,
                y,
                i32::try_from(width).unwrap_or(i32::MAX),
                i32::try_from(height).unwrap_or(i32::MAX),
                flags,
            ) != 0
        }
    }

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct GuiThreadInfo {
        cb_size: u32,
        flags: u32,
        active: Hwnd,
        focused: Hwnd,
        captured: Hwnd,
        menu_owner: Hwnd,
        move_size: Hwnd,
        caret: Hwnd,
        caret_rect: Rect,
    }

    pub(super) fn activate(window: Hwnd) -> bool {
        const SW_RESTORE: i32 = 9;
        const SWP_NOSIZE: u32 = 0x0001;
        const SWP_NOMOVE: u32 = 0x0002;
        const SWP_SHOWWINDOW: u32 = 0x0040;
        // SAFETY: Tauri supplied this HWND for a live WebviewWindow owned by
        // this process. All calls are synchronous and do not retain it.
        unsafe {
            let _ = show_window_async(window, SW_RESTORE);
            let _ = bring_window_to_top(window);
            let _ = set_active_window(window);
            let _ = set_foreground_window(window);
            if get_foreground_window() != window {
                // Windows can reject SetForegroundWindow while the shelf owns
                // the foreground. A topmost -> non-topmost bounce raises the
                // already visible reader without leaving it permanently pinned.
                let flags = SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW;
                let _ = set_window_pos(window, -1_isize as Hwnd, 0, 0, 0, 0, flags);
                let _ = set_window_pos(window, -2_isize as Hwnd, 0, 0, 0, 0, flags);
                let _ = bring_window_to_top(window);
                let _ = set_active_window(window);
                let _ = set_foreground_window(window);
            }
            get_foreground_window() == window
        }
    }

    /// `SetForegroundWindow` only proves that the top-level frame owns the
    /// foreground. It does not prove that keyboard focus left the non-client
    /// title bar and entered WebView2. Query the GUI thread's focused child so
    /// a close handoff is only considered complete after the shelf WebView is
    /// actually ready to receive the first click.
    pub(super) fn webview_has_focus(window: Hwnd) -> bool {
        // SAFETY: `window` is a live Tauri HWND. GetGUIThreadInfo only writes
        // the fixed-size structure supplied here and IsChild retains no
        // pointers.
        unsafe {
            if get_foreground_window() != window {
                return false;
            }
            let thread_id = get_window_thread_process_id(window, std::ptr::null_mut());
            if thread_id == 0 {
                return false;
            }
            let mut info = GuiThreadInfo {
                cb_size: std::mem::size_of::<GuiThreadInfo>() as u32,
                flags: 0,
                active: std::ptr::null_mut(),
                focused: std::ptr::null_mut(),
                captured: std::ptr::null_mut(),
                menu_owner: std::ptr::null_mut(),
                move_size: std::ptr::null_mut(),
                caret: std::ptr::null_mut(),
                caret_rect: Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
            };
            get_gui_thread_info(thread_id, &mut info) != 0
                && !info.focused.is_null()
                && info.focused != window
                && is_child(window, info.focused) != 0
        }
    }
}

static CLOSING_READER_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static REPLACING_READER_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
// Completing a cross-book switch may destroy one WebView and synchronously ask
// the UI event loop to create another. Keep that work off the command's main
// thread and serialize it so rapid shelf opens cannot overlap native WebView
// teardown/construction.
static READER_SWITCH_COMPLETION_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static READER_WINDOW_BOOK_IDS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static READY_READER_SHELLS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static READY_READER_INNER_ENGINES: LazyLock<Mutex<HashMap<String, Option<u64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static READER_SHELL_BUILD_SCHEDULED: AtomicBool = AtomicBool::new(false);
static RECENT_READING_CACHE_SCHEDULED: AtomicBool = AtomicBool::new(false);
static RECENT_READING_CACHE_YIELD_REQUESTED: AtomicBool = AtomicBool::new(false);
static READER_MARK_SAVE_SCHEDULED: AtomicBool = AtomicBool::new(false);
static READER_MARK_SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);
static READER_SHELL_PRELOAD_ENABLED: AtomicBool = AtomicBool::new(false);
static READER_SHELL_SEQUENCE: AtomicU64 = AtomicU64::new(1);
// A new reader open invalidates any delayed shelf-focus retry left behind by
// the reader that was just hidden. This prevents WebView2 focus work for two
// different windows from overlapping on the native UI thread.
static SHELF_FOCUS_HANDOFF_GENERATION: AtomicU64 = AtomicU64::new(1);
static READER_SHELL_BENCHMARK_PHASES: LazyLock<
    Mutex<HashMap<String, ReaderShellBenchmarkListener>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));
static READER_OPEN_STARTED_AT: LazyLock<Mutex<HashMap<String, (Instant, &'static str)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RECENT_ACTUAL_READER_OPENS: LazyLock<Mutex<VecDeque<ReaderActualOpenSample>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
static PENDING_READER_SWITCH_STARTED_AT: LazyLock<Mutex<HashMap<u64, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Keeps the cross-book transition visible to the open-completion watcher until
/// the replacement window has finished its native build/restore/show sequence.
///
/// `WebviewWindowBuilder::build` registers a new window while it is still
/// deliberately hidden. Removing the pending marker before `show()` completes
/// lets the watcher mistake that short-lived state for a user-cancelled open.
/// The guard also clears the marker on every error return from the switch.
struct PendingReaderSwitchGuard {
    id_num: u64,
    started_at: Option<Instant>,
}

impl PendingReaderSwitchGuard {
    fn new(id_num: u64) -> Self {
        let started_at = PENDING_READER_SWITCH_STARTED_AT
            .lock()
            .unwrap()
            .get(&id_num)
            .copied();
        Self { id_num, started_at }
    }

    fn started_at(&self) -> Option<Instant> {
        self.started_at
    }
}

impl Drop for PendingReaderSwitchGuard {
    fn drop(&mut self) {
        let Some(started_at) = self.started_at else {
            return;
        };
        let mut pending = PENDING_READER_SWITCH_STARTED_AT.lock().unwrap();
        if pending.get(&self.id_num) == Some(&started_at) {
            pending.remove(&self.id_num);
        }
    }
}
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
static READER_GEOMETRY_EVENT_LAST_AT: LazyLock<Mutex<HashMap<(String, &'static str), Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// This flag is set only by the explicit user-facing exit command. Ordinary
// close and Cmd+Q continue to follow startup-enhancement hide behavior.
static EXPLICIT_APPLICATION_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

const RECENT_READING_CACHE_IDLE_DELAY: Duration = Duration::from_millis(900);
const RECENT_READING_CACHE_BUSY_RETRY_DELAY: Duration = Duration::from_millis(350);
const READER_MARK_SAVE_IDLE_DELAY: Duration = Duration::from_secs(2);
const RECENT_ACTUAL_READER_OPEN_LIMIT: usize = 12;

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
    inner_engine_ready_shells: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    inner_engine_heap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_resident_bytes: Option<u64>,
    preload_memory_limit_bytes: u64,
    cache: crate::epub_runtime::ReaderPreloadCacheStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    recent_open: Option<ReaderActualOpenStatus>,
}

#[derive(Clone, Debug)]
struct ReaderActualOpenSample {
    format: &'static str,
    preload_path: &'static str,
    click_to_first_screen_ms: u32,
    first_screen_to_refill_ms: u32,
    click_to_complete_ms: u32,
    refill_outcome: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderActualOpenStatus {
    sample_count: u32,
    format: &'static str,
    preload_path: &'static str,
    click_to_first_screen_ms: u32,
    first_screen_to_refill_ms: u32,
    click_to_complete_ms: u32,
    refill_outcome: &'static str,
    p50_first_screen_ms: u32,
    p95_first_screen_ms: u32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReaderOpenCompletionTiming {
    click_to_first_screen_ms: u32,
    first_screen_to_refill_ms: u32,
    click_to_complete_ms: u32,
    refill_outcome: &'static str,
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
    content_ms: u32,
    styles_ms: u32,
    dom_ms: u32,
    resources_ms: u32,
    pagination_ms: u32,
    layout_ms: u32,
    display_ms: u32,
    total_ms: u32,
    p95_ms: u32,
    detailed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderShellPreloadBenchmark {
    regular_median_ms: u32,
    preloaded_median_ms: u32,
    regular_p95_ms: u32,
    preloaded_p95_ms: u32,
    improvement_median_ms: i64,
    rounds: u32,
    samples: Vec<ReaderShellBenchmarkSample>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaderShellBenchmarkPhase {
    ShellBootstrap(u32),
    ShellPrepared,
    FrameReady(u32),
    ChapterPayloadReady(u32),
    ChapterStylesReady(u32),
    ChapterDomReady(u32),
    ChapterResourcesReady(u32),
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

const READER_SHELL_BENCHMARK_BOOK_LIMIT: usize = 4;
const READER_SHELL_BENCHMARK_ROUNDS: usize = 3;
const READER_PRELOAD_MEMORY_LIMIT_BYTES: u64 = 120 * 1024 * 1024;

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
    let inner_engines = READY_READER_INNER_ENGINES.lock().unwrap();
    let inner_engine_ready_shells = pooled_labels
        .iter()
        .filter(|label| inner_engines.contains_key(*label))
        .count();
    let measured_inner_heaps = pooled_labels
        .iter()
        .filter_map(|label| inner_engines.get(label).copied().flatten())
        .collect::<Vec<_>>();
    ReaderShellPreloadStatus {
        enabled: READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire),
        pooled_shells: u32::try_from(pooled_labels.len()).unwrap_or(u32::MAX),
        ready_shells: u32::try_from(ready_shells).unwrap_or(u32::MAX),
        inner_engine_ready_shells: u32::try_from(inner_engine_ready_shells).unwrap_or(u32::MAX),
        inner_engine_heap_bytes: (!measured_inner_heaps.is_empty())
            .then(|| measured_inner_heaps.into_iter().sum()),
        process_resident_bytes: process_resident_bytes(),
        preload_memory_limit_bytes: READER_PRELOAD_MEMORY_LIMIT_BYTES,
        cache: crate::epub_runtime::reader_preload_cache_status(state),
        recent_open: recent_actual_reader_open_status(),
    }
}

fn elapsed_ms(duration: Duration) -> u32 {
    duration.as_millis().min(u128::from(u32::MAX)) as u32
}

fn actual_open_percentile(values: &mut [u32], numerator: usize, denominator: usize) -> u32 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let rank = values
        .len()
        .saturating_mul(numerator)
        .saturating_add(denominator.saturating_sub(1))
        / denominator.max(1);
    values[rank.saturating_sub(1).min(values.len() - 1)]
}

fn recent_actual_reader_open_status() -> Option<ReaderActualOpenStatus> {
    let samples = RECENT_ACTUAL_READER_OPENS.lock().ok()?;
    let latest = samples.back()?.clone();
    let matching: Vec<&ReaderActualOpenSample> = samples
        .iter()
        .filter(|sample| {
            sample.format == latest.format && sample.preload_path == latest.preload_path
        })
        .collect();
    let mut p50_values: Vec<u32> = matching
        .iter()
        .map(|sample| sample.click_to_first_screen_ms)
        .collect();
    let mut p95_values = p50_values.clone();
    Some(ReaderActualOpenStatus {
        sample_count: u32::try_from(matching.len()).unwrap_or(u32::MAX),
        format: latest.format,
        preload_path: latest.preload_path,
        click_to_first_screen_ms: latest.click_to_first_screen_ms,
        first_screen_to_refill_ms: latest.first_screen_to_refill_ms,
        click_to_complete_ms: latest.click_to_complete_ms,
        refill_outcome: latest.refill_outcome,
        p50_first_screen_ms: actual_open_percentile(&mut p50_values, 1, 2),
        p95_first_screen_ms: actual_open_percentile(&mut p95_values, 95, 100),
    })
}

pub(crate) fn record_actual_reader_open(
    app: &tauri::AppHandle,
    id_num: u64,
    format: &str,
    timing: ReaderOpenCompletionTiming,
) {
    let normalized_format = if format.eq_ignore_ascii_case("pdf") {
        "PDF"
    } else if format.eq_ignore_ascii_case("epub") {
        "EPUB"
    } else {
        "其它格式"
    };
    let preload_path = if normalized_format == "PDF" {
        "pdf_bypass"
    } else {
        app.webview_windows()
            .into_values()
            .find(|window| reader_window_id(window) == Some(id_num))
            .map(|window| {
                if is_reader_shell_label(window.label()) {
                    "preloaded_hit"
                } else {
                    "cold_window"
                }
            })
            .unwrap_or("unknown")
    };
    if let Ok(mut samples) = RECENT_ACTUAL_READER_OPENS.lock() {
        samples.push_back(ReaderActualOpenSample {
            format: normalized_format,
            preload_path,
            click_to_first_screen_ms: timing.click_to_first_screen_ms,
            first_screen_to_refill_ms: timing.first_screen_to_refill_ms,
            click_to_complete_ms: timing.click_to_complete_ms,
            refill_outcome: timing.refill_outcome,
        });
        while samples.len() > RECENT_ACTUAL_READER_OPEN_LIMIT {
            samples.pop_front();
        }
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
    text_conversion: Option<String>,
) -> ReaderShellPreloadStatus {
    READER_SHELL_PRELOAD_ENABLED.store(enabled, Ordering::Release);
    crate::epub_runtime::set_recent_reading_content_cache_enabled(
        state.inner(),
        enabled,
        text_conversion.as_deref().unwrap_or("t2s"),
    );
    if enabled {
        schedule_clean_reader_shell(&app);
        schedule_recent_reading_chapter_cache(&app);
    } else {
        // The single master switch owns every idle preload resource, including
        // recent content. Turning it off releases all three as one operation.
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
            let mut inner_engines = READY_READER_INNER_ENGINES.lock().unwrap();
            for (label, _) in &pooled {
                ready.remove(label);
                inner_engines.remove(label);
            }
        }
        for (_, window) in pooled {
            let _ = window.destroy();
        }
    }
    reader_shell_preload_status_for(&app, state.inner())
}

fn recent_reading_cache_can_run(
    shell_preload_enabled: bool,
    visible_reader: bool,
    reader_open_started: bool,
    reader_switch_pending: bool,
) -> bool {
    shell_preload_enabled && !visible_reader && !reader_open_started && !reader_switch_pending
}

fn recent_reading_cache_foreground_busy(app: &tauri::AppHandle) -> bool {
    !recent_reading_cache_can_run(
        READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire),
        any_reader_window_open(app),
        !READER_OPEN_STARTED_AT.lock().unwrap().is_empty(),
        !PENDING_READER_SWITCH_STARTED_AT.lock().unwrap().is_empty(),
    )
}

/// Returns true when a foreground reader open asked the current background
/// batch to stop between books. The batch owns no UI state and may resume once
/// the shelf becomes idle again.
pub(crate) fn recent_reading_cache_should_yield() -> bool {
    RECENT_READING_CACHE_YIELD_REQUESTED.load(Ordering::Acquire)
}

fn request_recent_reading_cache_yield() {
    RECENT_READING_CACHE_YIELD_REQUESTED.store(true, Ordering::Release);
}

fn schedule_recent_reading_chapter_cache(app: &tauri::AppHandle) {
    if !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire)
        || RECENT_READING_CACHE_SCHEDULED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Coalesce startup, preference and mark-read requests. Opening a reader
        // is latency-sensitive, so a visible/in-flight reader keeps this one
        // low-cost worker asleep instead of spawning overlapping cache-fill jobs.
        std::thread::sleep(RECENT_READING_CACHE_IDLE_DELAY);
        while READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
            if recent_reading_cache_foreground_busy(&app) {
                std::thread::sleep(RECENT_READING_CACHE_BUSY_RETRY_DELAY);
                continue;
            }
            // A foreground request can land between the busy-state snapshot
            // above and the first book. Consume that edge, then require one
            // more quiet interval instead of clearing it underneath the open.
            if RECENT_READING_CACHE_YIELD_REQUESTED.swap(false, Ordering::AcqRel) {
                std::thread::sleep(RECENT_READING_CACHE_IDLE_DELAY);
                continue;
            }
            let state = app.state::<AppState>();
            crate::epub_runtime::prewarm_recent_reading_chapters(state.inner());
            if !recent_reading_cache_should_yield() {
                break;
            }
        }
        RECENT_READING_CACHE_SCHEDULED.store(false, Ordering::Release);
    });
}

#[tauri::command]
pub(crate) fn set_recent_reading_chapter_cache_enabled(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
    text_conversion: Option<String>,
) -> ReaderShellPreloadStatus {
    crate::epub_runtime::set_recent_reading_content_cache_enabled(
        state.inner(),
        enabled,
        text_conversion.as_deref().unwrap_or("t2s"),
    );
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
    crate::epub_runtime::clear_recent_reading_content_cache(state.inner());
    reader_shell_preload_status_for(&app, state.inner())
}

fn benchmark_percentile(sorted: &[u32], numerator: usize, denominator: usize) -> u32 {
    let index = benchmark_percentile_index(sorted.len(), numerator, denominator);
    sorted.get(index).copied().unwrap_or(0)
}

fn benchmark_percentile_index(length: usize, numerator: usize, denominator: usize) -> usize {
    let Some(last) = length.checked_sub(1) else {
        return 0;
    };
    last.saturating_mul(numerator).div_ceil(denominator)
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
    books.truncate(READER_SHELL_BENCHMARK_BOOK_LIMIT);
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
        } else if event == "chapter_payload_ready" {
            return Some(ReaderShellBenchmarkPhase::ChapterPayloadReady(0));
        } else if event == "chapter_styles_ready" {
            return Some(ReaderShellBenchmarkPhase::ChapterStylesReady(0));
        } else if event == "chapter_dom_ready" {
            return Some(ReaderShellBenchmarkPhase::ChapterDomReady(0));
        } else if event == "chapter_resources_ready" {
            return Some(ReaderShellBenchmarkPhase::ChapterResourcesReady(0));
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

fn benchmark_phase_at_native_elapsed(
    event: &str,
    elapsed_ms: u32,
) -> Option<ReaderShellBenchmarkPhase> {
    match benchmark_phase_from_perf_event(event) {
        // Frontend values begin only after WebView JavaScript is running. The
        // native listener clock also includes Tauri window construction,
        // WebView startup and navigation for a regular cold opening.
        Some(ReaderShellBenchmarkPhase::ShellBootstrap(_)) => {
            Some(ReaderShellBenchmarkPhase::ShellBootstrap(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::FrameReady(_)) => {
            Some(ReaderShellBenchmarkPhase::FrameReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::ChapterPayloadReady(_)) => {
            Some(ReaderShellBenchmarkPhase::ChapterPayloadReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::ChapterStylesReady(_)) => {
            Some(ReaderShellBenchmarkPhase::ChapterStylesReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::ChapterDomReady(_)) => {
            Some(ReaderShellBenchmarkPhase::ChapterDomReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::ChapterResourcesReady(_)) => {
            Some(ReaderShellBenchmarkPhase::ChapterResourcesReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::PageLayoutReady(_)) => {
            Some(ReaderShellBenchmarkPhase::PageLayoutReady(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(_)) => {
            Some(ReaderShellBenchmarkPhase::FirstPageDisplayed(elapsed_ms))
        }
        Some(ReaderShellBenchmarkPhase::ShellPrepared) => {
            Some(ReaderShellBenchmarkPhase::ShellPrepared)
        }
        None => is_first_page_render_event(event)
            .then_some(ReaderShellBenchmarkPhase::MacFirstPageRendered(elapsed_ms)),
        Some(ReaderShellBenchmarkPhase::MacFirstPageRendered(_)) => None,
    }
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
    let phase = benchmark_phase_at_native_elapsed(event, elapsed_ms);
    if let Some(phase) = phase {
        let _ = listener.sender.send(phase);
    }
}

fn build_benchmark_reader_window(
    app: &tauri::AppHandle,
    label: &str,
    path: &str,
    initially_visible: bool,
) -> Result<tauri::WebviewWindow, String> {
    let url = tauri::WebviewUrl::App(path.into());
    let builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title("阅读打开测速")
        // A hidden WebView is allowed to throttle requestAnimationFrame, which
        // made the old "first screen" number measure scheduler delay rather
        // than paint. Keep the benchmark paintable without taking focus or a
        // taskbar slot. Pooled shells stay hidden until their activation phase.
        .visible(initially_visible)
        .focused(false)
        .skip_taskbar(true)
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

#[derive(Clone, Copy)]
struct BenchmarkTimingInput {
    shell_bootstrap_ms: Option<u32>,
    chapter_payload_ready_ms: Option<u32>,
    chapter_styles_ready_ms: Option<u32>,
    chapter_dom_ready_ms: Option<u32>,
    chapter_resources_ready_ms: Option<u32>,
    page_layout_ready_ms: u32,
    first_page_displayed_ms: u32,
    shell_preloaded: bool,
}

fn benchmark_timing(input: BenchmarkTimingInput) -> ReaderShellBenchmarkTiming {
    let BenchmarkTimingInput {
        shell_bootstrap_ms,
        chapter_payload_ready_ms,
        chapter_styles_ready_ms,
        chapter_dom_ready_ms,
        chapter_resources_ready_ms,
        page_layout_ready_ms,
        first_page_displayed_ms,
        shell_preloaded,
    } = input;
    let shell_ms = if shell_preloaded {
        0
    } else {
        shell_bootstrap_ms
            .unwrap_or_default()
            .min(page_layout_ready_ms.max(first_page_displayed_ms))
    };
    let layout_finished_ms = page_layout_ready_ms.max(shell_ms);
    let total_ms = first_page_displayed_ms.max(layout_finished_ms);
    let detailed = chapter_payload_ready_ms.is_some()
        && chapter_styles_ready_ms.is_some()
        && chapter_dom_ready_ms.is_some()
        && chapter_resources_ready_ms.is_some();
    let content_ready_ms = chapter_payload_ready_ms
        .unwrap_or(shell_ms)
        .clamp(shell_ms, layout_finished_ms);
    let styles_ready_ms = chapter_styles_ready_ms
        .unwrap_or(content_ready_ms)
        .clamp(content_ready_ms, layout_finished_ms);
    let dom_ready_ms = chapter_dom_ready_ms
        .unwrap_or(styles_ready_ms)
        .clamp(styles_ready_ms, layout_finished_ms);
    let resources_ready_ms = chapter_resources_ready_ms
        .unwrap_or(dom_ready_ms)
        .clamp(dom_ready_ms, layout_finished_ms);
    ReaderShellBenchmarkTiming {
        shell_ms,
        content_ms: content_ready_ms.saturating_sub(shell_ms),
        styles_ms: styles_ready_ms.saturating_sub(content_ready_ms),
        dom_ms: dom_ready_ms.saturating_sub(styles_ready_ms),
        resources_ms: resources_ready_ms.saturating_sub(dom_ready_ms),
        pagination_ms: layout_finished_ms.saturating_sub(resources_ready_ms),
        layout_ms: layout_finished_ms.saturating_sub(shell_ms),
        display_ms: total_ms.saturating_sub(layout_finished_ms),
        total_ms,
        p95_ms: total_ms,
        detailed,
    }
}

fn aggregate_benchmark_timings(runs: &[ReaderShellBenchmarkTiming]) -> ReaderShellBenchmarkTiming {
    let mut ordered: Vec<&ReaderShellBenchmarkTiming> = runs.iter().collect();
    ordered.sort_unstable_by_key(|timing| timing.total_ms);
    let mut representative = ordered
        .get(benchmark_percentile_index(ordered.len(), 1, 2))
        .copied()
        .cloned()
        .unwrap_or_else(|| {
            benchmark_timing(BenchmarkTimingInput {
                shell_bootstrap_ms: None,
                chapter_payload_ready_ms: None,
                chapter_styles_ready_ms: None,
                chapter_dom_ready_ms: None,
                chapter_resources_ready_ms: None,
                page_layout_ready_ms: 0,
                first_page_displayed_ms: 0,
                shell_preloaded: true,
            })
        });
    representative.p95_ms = ordered
        .get(benchmark_percentile_index(ordered.len(), 95, 100))
        .map_or(0, |timing| timing.total_ms);
    representative
}

fn wait_for_benchmark_timing(
    receiver: &mpsc::Receiver<ReaderShellBenchmarkPhase>,
    shell_preloaded: bool,
) -> Result<ReaderShellBenchmarkTiming, String> {
    // 首章排版可能要等字体与图片解码；仍串行执行，避免测速本身争抢内存和 I/O。
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut shell_bootstrap_ms = None;
    let mut frame_ready_ms = None;
    let mut chapter_payload_ready_ms = None;
    let mut chapter_styles_ready_ms = None;
    let mut chapter_dom_ready_ms = None;
    let mut chapter_resources_ready_ms = None;
    let mut page_layout_ready_ms = None;
    let mut first_page_displayed_ms = None;
    let mut mac_first_page_rendered_ms = None;
    loop {
        if let (Some(page_layout_ready), Some(first_page_displayed)) =
            (page_layout_ready_ms, first_page_displayed_ms)
        {
            return Ok(benchmark_timing(BenchmarkTimingInput {
                shell_bootstrap_ms,
                chapter_payload_ready_ms,
                chapter_styles_ready_ms,
                chapter_dom_ready_ms,
                chapter_resources_ready_ms,
                page_layout_ready_ms: page_layout_ready,
                first_page_displayed_ms: first_page_displayed,
                shell_preloaded,
            }));
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
            Ok(ReaderShellBenchmarkPhase::ChapterPayloadReady(millis)) => {
                chapter_payload_ready_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::ChapterStylesReady(millis)) => {
                chapter_styles_ready_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::ChapterDomReady(millis)) => {
                chapter_dom_ready_ms = Some(millis);
            }
            Ok(ReaderShellBenchmarkPhase::ChapterResourcesReady(millis)) => {
                chapter_resources_ready_ms = Some(millis);
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
                return Ok(benchmark_timing(BenchmarkTimingInput {
                    shell_bootstrap_ms,
                    chapter_payload_ready_ms,
                    chapter_styles_ready_ms,
                    chapter_dom_ready_ms,
                    chapter_resources_ready_ms,
                    page_layout_ready_ms: page_layout_ready,
                    first_page_displayed_ms: first_page_displayed,
                    shell_preloaded,
                }));
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
            | ReaderShellBenchmarkPhase::ChapterPayloadReady(_)
            | ReaderShellBenchmarkPhase::ChapterStylesReady(_)
            | ReaderShellBenchmarkPhase::ChapterDomReady(_)
            | ReaderShellBenchmarkPhase::ChapterResourcesReady(_)
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
    // Keep the book binding alive until the short-lived WebView is hidden and
    // unregistered. Removing it first let the still-paintable benchmark page
    // issue one last `book_info` call as an unbound reader, leaving the user
    // with a visible startup-error shell after the benchmark completed.
    let was_bound = reader_window_id(window).is_some();
    let was_visible = window.is_visible().unwrap_or(false);
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "reader_benchmark_cleanup phase=start outcome=requested kind={} bound={was_bound} visible={was_visible}",
            reader_window_diagnostic_kind(window),
        ),
    );
    let hidden = window.hide().is_ok();
    let destroyed = window.destroy().is_ok();
    let app = window.app_handle();
    let unregister_deadline = Instant::now() + Duration::from_secs(2);
    while app.get_webview_window(label).is_some() && Instant::now() < unregister_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let registered = app.get_webview_window(label).is_some();
    READER_WINDOW_BOOK_IDS
        .lock()
        .ok()
        .map(|mut ids| ids.remove(label));
    READY_READER_SHELLS.lock().unwrap().remove(label);
    READY_READER_INNER_ENGINES.lock().unwrap().remove(label);
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "reader_benchmark_cleanup phase=finish outcome={} kind={} bound={was_bound} visible={was_visible} registered={registered} success={}",
            if registered { "still_registered" } else { "unregistered" },
            reader_window_diagnostic_kind(window),
            hidden && destroyed && !registered,
        ),
    );
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
    let window = match build_benchmark_reader_window(app, &label, "reader.html?benchmark=1", true) {
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
    let window =
        match build_benchmark_reader_window(app, &label, "reader.html?pool=1&benchmark=1", false) {
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
        window.show().map_err(|error| error.to_string())?;
        // `Emitter::emit` is application-wide even when called on a WebviewWindow,
        // and Tauri's global JS event listener targets `Any`. A broadcast here
        // used to activate the ordinary idle preload shell too; that unbound
        // shell entered its error page and was later reused for a real book.
        // Address lifecycle commands to one label; the shared JS transport also
        // binds listeners to the current WebviewWindow rather than `Any`.
        app.emit_to(&label, "reader-shell-activate", ())
            .map_err(|error| error.to_string())?;
        wait_for_benchmark_timing(&receiver, true)
    })();
    clear_benchmark_reader_window(&label, &window);
    result
}

fn benchmark_cold_regular_reader_open(
    app: &tauri::AppHandle,
    book: &ReaderShellBenchmarkBook,
) -> Result<ReaderShellBenchmarkTiming, String> {
    crate::epub_runtime::evict_recent_reading_content_book(
        app.state::<AppState>().inner(),
        book.id,
    );
    benchmark_regular_reader_open(app, book)
}

fn benchmark_fully_preloaded_reader_open(
    app: &tauri::AppHandle,
    book: &ReaderShellBenchmarkBook,
) -> Result<ReaderShellBenchmarkTiming, String> {
    crate::epub_runtime::prewarm_book_data(app.state::<AppState>().inner(), book.id)?;
    benchmark_preloaded_reader_open(app, book)
}

struct BenchmarkBookCacheRestore<'a> {
    app: &'a tauri::AppHandle,
    book_id: u64,
}

impl Drop for BenchmarkBookCacheRestore<'_> {
    fn drop(&mut self) {
        // A cold sample may fail after eviction. Refill on every exit path so
        // running the benchmark never leaves a shelf book colder than before.
        let _ = crate::epub_runtime::prewarm_book_data(
            self.app.state::<AppState>().inner(),
            self.book_id,
        );
    }
}

/// Opens a bounded set of larger EPUBs in short-lived, non-focused windows.
/// Keeping the benchmark paintable prevents hidden-WebView frame throttling;
/// it never marks a book read or saves reading progress.
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
    let (samples, mut regular_times, mut preloaded_times) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut samples = Vec::with_capacity(books.len());
            let mut all_regular_times =
                Vec::with_capacity(books.len().saturating_mul(READER_SHELL_BENCHMARK_ROUNDS));
            let mut all_preloaded_times =
                Vec::with_capacity(books.len().saturating_mul(READER_SHELL_BENCHMARK_ROUNDS));
            for (book_index, book) in books.iter().enumerate() {
                let _cache_restore = BenchmarkBookCacheRestore {
                    app: &app_for_benchmark,
                    book_id: book.id,
                };
                // Prime process-level WebView code once without counting it.
                // Every measured ordinary sample then evicts this book's
                // in-memory reading data, while every full-preload sample warms
                // that data again. The two columns therefore represent the
                // complete user-visible feature difference rather than sharing
                // the recent-reading cache.
                let _ = benchmark_fully_preloaded_reader_open(&app_for_benchmark, book)?;
                let mut regular_runs = Vec::with_capacity(READER_SHELL_BENCHMARK_ROUNDS);
                let mut preloaded_runs = Vec::with_capacity(READER_SHELL_BENCHMARK_ROUNDS);
                for round in 0..READER_SHELL_BENCHMARK_ROUNDS {
                    // Prepare the required cache state immediately before each
                    // sample, then alternate order so neither path consistently
                    // benefits from running second.
                    let (regular, preloaded) = match (book_index + round) % 2 {
                        0 => (
                            benchmark_cold_regular_reader_open(&app_for_benchmark, book)?,
                            benchmark_fully_preloaded_reader_open(&app_for_benchmark, book)?,
                        ),
                        _ => {
                            let preloaded =
                                benchmark_fully_preloaded_reader_open(&app_for_benchmark, book)?;
                            let regular =
                                benchmark_cold_regular_reader_open(&app_for_benchmark, book)?;
                            (regular, preloaded)
                        }
                    };
                    all_regular_times.push(regular.total_ms);
                    all_preloaded_times.push(preloaded.total_ms);
                    regular_runs.push(regular);
                    preloaded_runs.push(preloaded);
                }
                let regular = aggregate_benchmark_timings(&regular_runs);
                let preloaded = aggregate_benchmark_timings(&preloaded_runs);
                samples.push(ReaderShellBenchmarkSample {
                    title: book.title.clone(),
                    cover_url: book.cover_url.clone(),
                    improvement_ms: i64::from(regular.total_ms) - i64::from(preloaded.total_ms),
                    regular,
                    preloaded,
                });
            }
            Ok::<_, String>((samples, all_regular_times, all_preloaded_times))
        })
        .await
        .map_err(|error| format!("图书打开测速任务失败：{error}"))??;
    regular_times.sort_unstable();
    preloaded_times.sort_unstable();
    let regular_median_ms = benchmark_percentile(&regular_times, 1, 2);
    let preloaded_median_ms = benchmark_percentile(&preloaded_times, 1, 2);
    let regular_p95_ms = benchmark_percentile(&regular_times, 95, 100);
    let preloaded_p95_ms = benchmark_percentile(&preloaded_times, 95, 100);
    Ok(ReaderShellPreloadBenchmark {
        regular_median_ms,
        preloaded_median_ms,
        regular_p95_ms,
        preloaded_p95_ms,
        improvement_median_ms: i64::from(regular_median_ms) - i64::from(preloaded_median_ms),
        rounds: u32::try_from(READER_SHELL_BENCHMARK_ROUNDS).unwrap_or(u32::MAX),
        samples,
    })
}

pub(crate) fn record_reader_ready(window: &tauri::WebviewWindow) {
    let opening = READER_OPEN_STARTED_AT
        .lock()
        .unwrap()
        .remove(window.label());
    if let Some((started, source)) = opening {
        log(&format!(
            "reader_open_total label={} source={source} elapsed_ms={}",
            window.label(),
            started.elapsed().as_millis()
        ));
        // Refill only after this reader has produced its first stable page.
        // The old fixed 180 ms refill routinely overlapped content/image work
        // and the final paint, while still being too late for a rapid next
        // open. Starting here avoids that contention and gives the shelf's
        // single-flight queue a precise readiness boundary.
        if reader_window_id(window).is_some() && !window.label().contains("-benchmark-") {
            schedule_clean_reader_shell_now(window.app_handle());
        }
    }
}

fn emit_reader_window_trace(
    app: &tauri::AppHandle,
    phase: &str,
    outcome: &str,
    duration: Duration,
) {
    // Use the application event bus. The main page installs a global Tauri
    // listener, while a WebviewWindow-scoped emit is not guaranteed to reach
    // it when the originating reader is being hidden in the same IPC turn.
    let _ = app.emit(
        "reader-window-trace",
        serde_json::json!({
            "phase": phase,
            "outcome": outcome,
            "durationMs": duration.as_millis().min(u128::from(u32::MAX)) as u32,
        }),
    );
    crate::app_commands::schedule_problem_trace_native_refresh();
}

/// Emits only numeric window geometry and fixed lifecycle labels.  The event
/// is deliberately free of a book title, path, window label, monitor name, or
/// any WebView content so it can safely enter the local problem trace.
fn emit_reader_geometry_trace(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    phase: &'static str,
    source: &'static str,
    outcome: &'static str,
    requested: Option<&WinGeom>,
    restore: Option<GeometryRestoreReport>,
) {
    let current = preferred_physical_geometry_from_window(window);
    let current_inner = physical_geometry_from_window(window);
    let requested = requested.and_then(preferred_saved_physical_geometry);
    let frame_width = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.w.saturating_sub(inner.w))
        .unwrap_or(0);
    let frame_height = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.h.saturating_sub(inner.h))
        .unwrap_or(0);
    let current_or_default = current.clone().unwrap_or_default();
    let inner_or_default = current_inner.unwrap_or_default();
    let requested_or_default = requested.cloned().unwrap_or_default();
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "reader_geometry phase={phase} source={source} outcome={outcome} geometry_available={} requested_available={} x={} y={} width={} height={} inner_width={} inner_height={} frame_width={frame_width} frame_height={frame_height} requested_x={} requested_y={} requested_width={} requested_height={} scale_milli={} maximized={} minimized={} visible={}",
            current.is_some(),
            requested.is_some(),
            current_or_default.x,
            current_or_default.y,
            current_or_default.w,
            current_or_default.h,
            inner_or_default.w,
            inner_or_default.h,
            requested_or_default.x,
            requested_or_default.y,
            requested_or_default.w,
            requested_or_default.h,
            (window.scale_factor().unwrap_or(1.0) * 1000.0).round() as i64,
            window.is_maximized().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window.is_visible().unwrap_or(false),
        ),
    );
    let restore = restore.map(|report| {
        serde_json::json!({
            "space": report.space,
            "size_applied": report.size_applied,
            "position_applied": report.position_applied,
            "clamped": report.clamped,
            "target_width": report.target.map(|target| target.w),
            "target_height": report.target.map(|target| target.h),
        })
    });
    let _ = app.emit(
        "reader-window-trace",
        serde_json::json!({
            "phase": phase,
            "source": source,
            "outcome": outcome,
            "geometry": current.map(|geom| physical_geometry_json(&geom)),
            "requested": requested.map(physical_geometry_json),
            "restore": restore,
        }),
    );
    crate::app_commands::schedule_problem_trace_native_refresh();
}

/// Records the shelf window with the same bounded geometry vocabulary used for
/// reader windows.  No title, path, shelf contents, or monitor identifier is
/// included in the local problem trace.
pub(crate) fn emit_main_geometry_trace(
    _app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    phase: &'static str,
    source: &'static str,
    outcome: &'static str,
    requested: Option<&WinGeom>,
) {
    let current = preferred_physical_geometry_from_window(window);
    let current_inner = physical_geometry_from_window(window);
    let requested = requested.and_then(preferred_saved_physical_geometry);
    let frame_width = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.w.saturating_sub(inner.w))
        .unwrap_or(0);
    let frame_height = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.h.saturating_sub(inner.h))
        .unwrap_or(0);
    let current_or_default = current.unwrap_or_default();
    let inner_or_default = current_inner.unwrap_or_default();
    let requested_or_default = requested.cloned().unwrap_or_default();
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "main_geometry phase={phase} source={source} outcome={outcome} geometry_available={} requested_available={} x={} y={} width={} height={} inner_width={} inner_height={} frame_width={frame_width} frame_height={frame_height} requested_x={} requested_y={} requested_width={} requested_height={} scale_milli={} maximized={} minimized={} visible={}",
            current_or_default.w > 0,
            requested.is_some(),
            current_or_default.x,
            current_or_default.y,
            current_or_default.w,
            current_or_default.h,
            inner_or_default.w,
            inner_or_default.h,
            requested_or_default.x,
            requested_or_default.y,
            requested_or_default.w,
            requested_or_default.h,
            (window.scale_factor().unwrap_or(1.0) * 1000.0).round() as i64,
            window.is_maximized().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window.is_visible().unwrap_or(false),
        ),
    );
    crate::app_commands::schedule_problem_trace_native_refresh();
}

fn schedule_main_geometry_observations(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    requested: Option<&WinGeom>,
) {
    let app = app.clone();
    let window = window.clone();
    let requested = requested.cloned();
    tauri::async_runtime::spawn(async move {
        let mut elapsed = 0_u64;
        for (delay, outcome) in [
            (50_u64, "after_50ms"),
            (250, "after_250ms"),
            (800, "after_800ms"),
        ] {
            tokio::time::sleep(Duration::from_millis(delay.saturating_sub(elapsed))).await;
            elapsed = delay;
            emit_main_geometry_trace(
                &app,
                &window,
                "geometry_observed",
                "main_show",
                outcome,
                requested.as_ref(),
            );
        }
    });
}

/// Windows/WebView2 may adjust the native rectangle shortly after a hidden
/// reader is shown. Capture three bounded readbacks so a support snapshot can
/// distinguish a delayed OS resize from a bad saved rectangle. These samples
/// contain only numeric geometry and fixed labels.
fn schedule_reader_geometry_observations(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    source: &'static str,
    requested: Option<&WinGeom>,
) {
    let app = app.clone();
    let window = window.clone();
    let requested = requested.cloned();
    tauri::async_runtime::spawn(async move {
        let mut elapsed_ms = 0_u64;
        for target_ms in [50_u64, 250, 800] {
            tokio::time::sleep(Duration::from_millis(target_ms - elapsed_ms)).await;
            elapsed_ms = target_ms;
            if app.get_webview_window(window.label()).is_none() {
                return;
            }
            let outcome = match target_ms {
                50 => "after_50ms",
                250 => "after_250ms",
                _ => "after_800ms",
            };
            emit_reader_geometry_trace(
                &app,
                &window,
                "geometry_observed",
                source,
                outcome,
                requested.as_ref(),
                None,
            );
        }
    });
}

fn emit_reader_geometry_event_throttled(
    app: &tauri::AppHandle,
    label: &str,
    source: &'static str,
    force: bool,
) {
    let now = Instant::now();
    let should_record = {
        let mut samples = READER_GEOMETRY_EVENT_LAST_AT.lock().unwrap();
        let key = (label.to_string(), source);
        let recent = samples
            .get(&key)
            .is_some_and(|previous| now.duration_since(*previous) < Duration::from_millis(120));
        if force || !recent {
            samples.insert(key, now);
            true
        } else {
            false
        }
    };
    if !should_record {
        return;
    }
    if let Some(window) = app.get_webview_window(label) {
        emit_reader_geometry_trace(
            app,
            &window,
            "geometry_event",
            source,
            "observed",
            None,
            None,
        );
    }
}

#[derive(Clone, Copy)]
struct ShelfFocusRequest {
    window_requested: bool,
    native_foreground: bool,
    webview_requested: bool,
    webview_confirmed: bool,
}

fn shelf_focus_outcome(request: ShelfFocusRequest) -> &'static str {
    if request.webview_confirmed {
        "focused"
    } else if request.window_requested || request.native_foreground || request.webview_requested {
        "requested"
    } else {
        "failed"
    }
}

fn request_shelf_focus(main: &tauri::WebviewWindow) -> ShelfFocusRequest {
    let _ = main.unminimize();
    let window_requested = main.set_focus().is_ok();
    #[cfg(target_os = "windows")]
    let (native_foreground, webview_confirmed_before) = main
        .hwnd()
        .ok()
        .map(|window| {
            (
                windows_activation::activate(window.0),
                windows_activation::webview_has_focus(window.0),
            )
        })
        .unwrap_or((false, false));
    #[cfg(not(target_os = "windows"))]
    let (native_foreground, webview_confirmed_before) = (false, false);
    // Window::set_focus targets only the top-level frame. Webview::set_focus
    // dispatches WebView2 MoveFocus and is the step that prevents the first
    // shelf click from being consumed as a mere activation click.
    let webview_requested = main.as_ref().set_focus().is_ok();
    #[cfg(target_os = "windows")]
    let webview_confirmed = webview_confirmed_before
        || main
            .hwnd()
            .ok()
            .is_some_and(|window| windows_activation::webview_has_focus(window.0));
    #[cfg(not(target_os = "windows"))]
    let webview_confirmed = webview_requested;
    ShelfFocusRequest {
        window_requested,
        native_foreground,
        webview_requested,
        webview_confirmed,
    }
}

/// Records only fixed focus outcomes and booleans. This deliberately avoids
/// HWND values, window labels, titles, paths and document content.
fn emit_shelf_focus_trace(
    app: &tauri::AppHandle,
    outcome: &'static str,
    duration: Duration,
    attempt: u32,
    request: ShelfFocusRequest,
    visible: bool,
) {
    let duration_ms = duration.as_millis().min(u128::from(u32::MAX)) as u32;
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "reader_window phase=focus_restore outcome={outcome} duration_ms={duration_ms} attempt={attempt} window_requested={} native_focused={} webview_requested={} webview_focused={} visible={visible}",
            request.window_requested,
            request.native_foreground,
            request.webview_requested,
            request.webview_confirmed,
        ),
    );
    let _ = app.emit(
        "reader-window-trace",
        serde_json::json!({
            "phase": "focus_restore",
            "outcome": outcome,
            "durationMs": duration_ms,
            "attempt": attempt,
            "windowRequested": request.window_requested,
            "nativeFocused": request.native_foreground,
            "webviewRequested": request.webview_requested,
            "webviewFocused": request.webview_confirmed,
            "visible": visible,
        }),
    );
}

fn activate_shelf_after_reader_close(app: &tauri::AppHandle) -> bool {
    let Some(main) = app.get_webview_window("main") else {
        return false;
    };
    let visible = main.is_visible().unwrap_or(false);
    if !visible {
        emit_reader_window_trace(app, "focus_restore", "skipped_hidden", Duration::ZERO);
        return false;
    }
    let request = request_shelf_focus(&main);
    let outcome = shelf_focus_outcome(request);
    emit_shelf_focus_trace(app, outcome, Duration::ZERO, 0, request, visible);
    request.webview_confirmed
}

/// A reader-close command originates inside the reader WebView. Its final
/// browser focus bookkeeping can run after the Rust command returns and steal
/// back the focus requested above. On Windows, retry briefly after that IPC
/// turn and stop only when the focused HWND is a child of the shelf frame.
#[cfg(target_os = "windows")]
fn schedule_shelf_focus_handoff_after_hidden_reader(app: &tauri::AppHandle) {
    // WebView2 can finish the reader command's focus bookkeeping several
    // frames after the window is hidden. Keep retrying for about one second so
    // the first real shelf click is not spent merely activating the WebView.
    const RETRY_DELAYS_MS: [u64; 7] = [16, 32, 64, 96, 160, 240, 320];
    let generation = SHELF_FOCUS_HANDOFF_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut last_request = ShelfFocusRequest {
            window_requested: false,
            native_foreground: false,
            webview_requested: false,
            webview_confirmed: false,
        };
        for (index, delay_ms) in RETRY_DELAYS_MS.into_iter().enumerate() {
            let attempt = (index + 1) as u32;
            std::thread::sleep(Duration::from_millis(delay_ms));
            if SHELF_FOCUS_HANDOFF_GENERATION.load(Ordering::Acquire) != generation {
                emit_reader_window_trace(
                    &app,
                    "focus_restore",
                    "cancelled_reader_open",
                    started.elapsed(),
                );
                return;
            }
            if any_reader_window_open(&app) {
                emit_reader_window_trace(
                    &app,
                    "focus_restore",
                    "skipped_reader_open",
                    started.elapsed(),
                );
                return;
            }
            let focus_app = app.clone();
            let (result_sender, result_receiver) = mpsc::channel();
            if app
                .run_on_main_thread(move || {
                    let request =
                        if SHELF_FOCUS_HANDOFF_GENERATION.load(Ordering::Acquire) != generation {
                            last_request
                        } else if let Some(main) = focus_app.get_webview_window("main") {
                            if main.is_visible().unwrap_or(false) {
                                request_shelf_focus(&main)
                            } else {
                                last_request
                            }
                        } else {
                            last_request
                        };
                    let _ = result_sender.send(request);
                })
                .is_err()
            {
                emit_reader_window_trace(
                    &app,
                    "focus_restore",
                    "dispatch_failed",
                    started.elapsed(),
                );
                return;
            }
            if let Ok(request) = result_receiver.recv_timeout(Duration::from_millis(100)) {
                last_request = request;
            }
            if SHELF_FOCUS_HANDOFF_GENERATION.load(Ordering::Acquire) != generation {
                emit_reader_window_trace(
                    &app,
                    "focus_restore",
                    "cancelled_reader_open",
                    started.elapsed(),
                );
                return;
            }
            // Both Tauri focus calls enqueue main-loop work. Give that work a
            // frame before checking the actual focused child HWND.
            std::thread::sleep(Duration::from_millis(16));
            let confirmed = app
                .get_webview_window("main")
                .and_then(|main| main.hwnd().ok())
                .is_some_and(|window| windows_activation::webview_has_focus(window.0));
            last_request.webview_confirmed |= confirmed;
            if confirmed {
                if let Some(main) = app.get_webview_window("main") {
                    emit_shelf_focus_trace(
                        &app,
                        "focused_after_retry",
                        started.elapsed(),
                        attempt,
                        last_request,
                        main.is_visible().unwrap_or(false),
                    );
                }
                return;
            }
        }
        let visible = app
            .get_webview_window("main")
            .is_some_and(|main| main.is_visible().unwrap_or(false));
        emit_shelf_focus_trace(
            &app,
            "unconfirmed",
            started.elapsed(),
            RETRY_DELAYS_MS.len() as u32,
            last_request,
            visible,
        );
    });
}

#[cfg(not(target_os = "windows"))]
fn schedule_shelf_focus_handoff_after_hidden_reader(_app: &tauri::AppHandle) {}

fn cancel_shelf_focus_handoff_for_reader_open() {
    SHELF_FOCUS_HANDOFF_GENERATION.fetch_add(1, Ordering::AcqRel);
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
                    let _ = activate_shelf_after_reader_close(&focus_app);
                }
            })
            .is_err()
        {
            emit_reader_window_trace(&app, "focus_restore", "dispatch_failed", Duration::ZERO);
        }
    });
}

fn reader_reveal_outcome(
    visible: bool,
    shown: bool,
    restored: bool,
    window_focused: bool,
    native_focused: bool,
    webview_focused: bool,
) -> &'static str {
    if visible && (native_focused || window_focused || webview_focused) {
        "focused"
    } else if visible || shown || restored {
        "shown"
    } else {
        "failed"
    }
}

fn reveal_existing_reader_window(window: &tauri::WebviewWindow) -> &'static str {
    let shown = window.show().is_ok();
    let restored = window.unminimize().is_ok();
    let taskbar = window.set_skip_taskbar(false).is_ok();
    let window_focused = window.set_focus().is_ok();
    #[cfg(target_os = "windows")]
    let native_focused = window
        .hwnd()
        .ok()
        .map(|handle| windows_activation::activate(handle.0))
        .unwrap_or(false);
    #[cfg(not(target_os = "windows"))]
    let native_focused = false;
    let webview_focused = window.as_ref().set_focus().is_ok();
    let visible = window.is_visible().unwrap_or(false);
    let outcome = reader_reveal_outcome(
        visible,
        shown,
        restored,
        window_focused,
        native_focused,
        webview_focused,
    );
    log(&format!(
        "reader_reveal outcome={outcome} shown={shown} restored={restored} taskbar={taskbar} window_focused={window_focused} native_focused={native_focused} webview_focused={webview_focused} visible={visible}"
    ));
    outcome
}
fn emit_main_native_geometry_trace(
    _app: &tauri::AppHandle,
    window: &tauri::Window,
    phase: &'static str,
    outcome: &'static str,
    requested: Option<&WinGeom>,
) {
    #[cfg(target_os = "windows")]
    let current = physical_outer_geometry_from_native_window(window);
    #[cfg(not(target_os = "windows"))]
    let current = physical_geometry_from_native_window(window);
    let current_inner = physical_geometry_from_native_window(window);
    let requested = requested.and_then(preferred_saved_physical_geometry);
    let frame_width = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.w.saturating_sub(inner.w))
        .unwrap_or(0);
    let frame_height = current
        .as_ref()
        .zip(current_inner.as_ref())
        .map(|(outer, inner)| outer.h.saturating_sub(inner.h))
        .unwrap_or(0);
    let geometry_available = current.is_some();
    let current_or_default = current.unwrap_or_default();
    let inner_or_default = current_inner.unwrap_or_default();
    let requested_or_default = requested.cloned().unwrap_or_default();
    crate::diagnostics::record_native_log(
        file!(),
        &format!(
            "main_geometry phase={phase} source=main_close outcome={outcome} geometry_available={geometry_available} requested_available={} x={} y={} width={} height={} inner_width={} inner_height={} frame_width={frame_width} frame_height={frame_height} requested_x={} requested_y={} requested_width={} requested_height={} scale_milli={} maximized={} minimized={} visible={}",
            requested.is_some(),
            current_or_default.x,
            current_or_default.y,
            current_or_default.w,
            current_or_default.h,
            inner_or_default.w,
            inner_or_default.h,
            requested_or_default.x,
            requested_or_default.y,
            requested_or_default.w,
            requested_or_default.h,
            (window.scale_factor().unwrap_or(1.0) * 1000.0).round() as i64,
            window.is_maximized().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window.is_visible().unwrap_or(false),
        ),
    );
    crate::app_commands::schedule_problem_trace_native_refresh();
}

pub(crate) fn persist_main_window_state(app: &tauri::AppHandle, window: &tauri::Window) {
    let state = app.state::<AppState>();
    let previous_geom = state
        .library
        .try_lock()
        .ok()
        .and_then(|library| library.main_geom.clone());
    let closing_geom = capture_main_window_geom(previous_geom, window);
    emit_main_native_geometry_trace(
        app,
        window,
        "geometry_capture",
        "captured",
        Some(&closing_geom),
    );
    let saved = if let Ok(mut library) = state.library.try_lock() {
        library.main_geom = Some(closing_geom.clone());
        let result = library.save();
        let saved = result.is_ok();
        report_save_error("书架", result);
        saved
    } else {
        log("[close] shelf save deferred because the library is busy");
        false
    };
    emit_main_native_geometry_trace(
        app,
        window,
        "geometry_save",
        if saved { "ok" } else { "failed" },
        Some(&closing_geom),
    );
    if let Ok(mut stats) = state.stats.try_lock() {
        report_save_error("统计", stats.save());
    } else {
        log("[close] stats save deferred because the statistics store is busy");
    };
}

/// Saves every bound reader before the shelf transitions to the background.
/// External Windows close requests can arrive before the reader WebView has a
/// chance to handle its asynchronous close event, so relying on that event
/// would make geometry persistence race with background cleanup.
pub(crate) fn persist_reader_window_states_before_main_close(app: &tauri::AppHandle) -> bool {
    let readers = app
        .webview_windows()
        .into_values()
        .filter(|window| reader_window_id(window).is_some())
        .collect::<Vec<_>>();
    if readers.is_empty() {
        return true;
    }
    let state = app.state::<AppState>();
    let captured = {
        let mut library = state.library.lock().unwrap();
        let captures = readers
            .iter()
            .map(|reader| (reader.clone(), update_reader_geom(&mut library, reader)))
            .collect::<Vec<_>>();
        let result = library.save();
        report_save_error("书架", result.clone());
        (captures, result.is_ok())
    };
    for (reader, geom) in &captured.0 {
        emit_reader_geometry_trace(
            app,
            reader,
            "geometry_capture",
            "main_close",
            "captured",
            Some(geom),
            None,
        );
        emit_reader_geometry_trace(
            app,
            reader,
            "geometry_save",
            "main_close",
            if captured.1 { "ok" } else { "failed" },
            Some(geom),
            None,
        );
    }
    captured.1
}

/// Emits only fixed lifecycle labels for the main-window close route. This is
/// diagnostic state, not an error message, window label, path, or user data.
fn emit_main_window_close_trace(
    app: &tauri::AppHandle,
    phase: &'static str,
    outcome: &'static str,
) {
    log(&format!("[window-close] phase={phase} outcome={outcome}"));
    let _ = app.emit(
        "main-window-close-trace",
        serde_json::json!({ "phase": phase, "outcome": outcome }),
    );
}

#[tauri::command]
pub(crate) fn main_window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn main_window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub(crate) fn main_window_close(webview: tauri::Webview) -> Result<(), String> {
    let app = webview.app_handle().clone();
    let label = webview.label();
    let window = webview.window();
    if label.starts_with("reader-") {
        let reader = app
            .get_webview_window(label)
            .ok_or_else(|| "当前阅读窗口不可用".to_string())?;
        let state = app.state::<AppState>();
        let Some(closed_book_id) = reader_window_id(&reader) else {
            // `reader-hide-request` can be observed by an idle preloaded shell
            // as well as the bound reader. An unbound shell has the default
            // 880x760 geometry; persisting it here would overwrite the real
            // reader rectangle immediately after the correct close save.
            let _ = window.hide();
            emit_reader_window_trace(
                &app,
                "close_command",
                "ignored_unbound_shell",
                Duration::ZERO,
            );
            return Ok(());
        };
        if let Some(task) = state
            .page_count_tasks
            .lock()
            .unwrap()
            .remove(&closed_book_id)
        {
            let _ = task.pause();
        }
        // Windows 隐藏后的 WebView2 有时会把 outer_position 回报为默认值。
        // 因此先在窗口仍可见时采集几何；实际磁盘写入仍放到 hide 之后，既保留
        // 关闭的即时反馈，也不会让下一次打开丢掉用户刚调整的大小和位置。
        let closing_geom = {
            let mut library = state.library.lock().unwrap();
            update_reader_geom(&mut library, &reader)
        };
        emit_reader_geometry_trace(
            &app,
            &reader,
            "geometry_capture",
            "close_command",
            "captured",
            Some(&closing_geom),
            None,
        );
        // 关闭按钮的首要反馈是让阅读页立即消失。窗口会被隐藏缓存，后续继续
        // 完成书架、统计与阅读位置的持久化，无需让用户看着它等待。
        window.hide().map_err(|error| error.to_string())?;
        emit_reader_window_trace(&app, "close_command", "hidden_cached", Duration::ZERO);
        let _ = activate_shelf_after_reader_close(&app);
        schedule_shelf_focus_handoff_after_hidden_reader(&app);
        let undo_checkpoint = match app.emit(
            "reader-closed-for-reopen",
            serde_json::json!({ "bookId": closed_book_id.to_string() }),
        ) {
            Ok(()) => "sent",
            Err(_) => "failed",
        };
        emit_reader_window_trace(&app, "undo_checkpoint", undo_checkpoint, Duration::ZERO);
        let library_saved = {
            let library = state.library.lock().unwrap();
            let result = library.save();
            report_save_error("书架", result.clone());
            result.is_ok()
        };
        emit_reader_geometry_trace(
            &app,
            &reader,
            "geometry_save",
            "close_command",
            if library_saved { "ok" } else { "failed" },
            Some(&closing_geom),
            None,
        );
        report_save_error("统计", state.stats.lock().unwrap().save());
        return Ok(());
    }
    if crate::startup_enhancement::should_keep_running(&app) {
        emit_main_window_close_trace(&app, "received", "background");
        let reader_saved = persist_reader_window_states_before_main_close(&app);
        emit_main_window_close_trace(
            &app,
            "reader_geometry",
            if reader_saved { "ok" } else { "failed" },
        );
        persist_main_window_state(&app, &window);
        emit_main_window_close_trace(&app, "state_persisted", "ok");
        // The close transition is started before hide so a rapid icon click
        // invalidates this background request instead of being hidden again
        // by stale cleanup after the user has reopened the application.
        if let Err(error) = crate::startup_enhancement::background_main_from_window(&app, &window) {
            emit_main_window_close_trace(&app, "hide", "failed");
            return Err(error.to_string());
        }
        emit_main_window_close_trace(&app, "hide", "ok");
        emit_main_window_close_trace(&app, "background_cleanup", "ok");
        return Ok(());
    }
    emit_main_window_close_trace(&app, "received", "exit");
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
    let requested = app
        .state::<AppState>()
        .library
        .lock()
        .unwrap()
        .main_geom
        .clone();
    crate::startup_enhancement::reveal_main(&app)?;
    emit_main_geometry_trace(
        &app,
        &window,
        "geometry_observed",
        "main_show",
        "shown",
        requested.as_ref(),
    );
    schedule_main_geometry_observations(&app, &window, requested.as_ref());
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

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct ReaderWindowDiagnosticState {
    window_role: &'static str,
    window_visible: bool,
    book_bound: bool,
    registered: bool,
}

/// Returns only fixed window lifecycle state for local problem traces.
#[tauri::command]
pub(crate) fn reader_window_diagnostic_state(
    window: tauri::WebviewWindow,
) -> ReaderWindowDiagnosticState {
    let app = window.app_handle();
    ReaderWindowDiagnosticState {
        window_role: reader_window_diagnostic_kind(&window),
        window_visible: window.is_visible().unwrap_or(false),
        book_bound: reader_window_id(&window).is_some(),
        registered: app.get_webview_window(window.label()).is_some(),
    }
}

fn reader_id_from_label(label: &str) -> Option<u64> {
    let id = label.strip_prefix("reader-")?;
    // Only the canonical `reader-<book id>` label may recover its binding
    // from the name. Benchmark and pooled windows are explicitly bound in the
    // map; treating `reader-42-benchmark-*` as a real reader after cleanup was
    // enough to hijack later shelf opens while WebView2 was unregistering it.
    (!id.is_empty() && !id.contains('-'))
        .then(|| id.parse().ok())
        .flatten()
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

/// Fixed, non-identifying role used by local diagnostics. Never expose labels or book ids.
pub(crate) fn reader_window_diagnostic_kind(window: &tauri::WebviewWindow) -> &'static str {
    let label = window.label();
    if label.contains("-preload-benchmark-") {
        "benchmark_preloaded"
    } else if label.contains("-benchmark-") {
        "benchmark_regular"
    } else if is_reader_shell_label(label) && reader_window_id(window).is_none() {
        "preload_pool"
    } else if is_reader_shell_label(label) {
        "reader_window"
    } else {
        "other_window"
    }
}

fn install_reader_window_lifecycle(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let event_app = app.clone();
    let event_label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            emit_reader_geometry_event_throttled(&event_app, &event_label, "native_resize", false);
        } else if matches!(event, tauri::WindowEvent::Moved(_)) {
            emit_reader_geometry_event_throttled(&event_app, &event_label, "native_move", false);
        } else if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
            emit_reader_geometry_event_throttled(&event_app, &event_label, "native_scale", true);
        } else if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let bound_reader = event_app
                .get_webview_window(&event_label)
                .is_some_and(|window| reader_window_id(&window).is_some());
            if bound_reader {
                api.prevent_close();
                if event_app.get_webview_window(&event_label).is_some() {
                    let _ = event_app.emit_to(&event_label, "reader-hide-request", ());
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
            READY_READER_INNER_ENGINES
                .lock()
                .unwrap()
                .remove(&event_label);
            READER_GEOMETRY_EVENT_LAST_AT
                .lock()
                .unwrap()
                .retain(|(label, _), _| label != &event_label);
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

fn schedule_reader_mark_save(app: &tauri::AppHandle) {
    READER_MARK_SAVE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if READER_MARK_SAVE_SCHEDULED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let save_app = app.clone();
    std::thread::spawn(move || loop {
        let observed_generation = READER_MARK_SAVE_GENERATION.load(Ordering::Acquire);
        std::thread::sleep(READER_MARK_SAVE_IDLE_DELAY);
        // 连续开书会不断刷新代次。保持同一个低成本 worker 等到两秒静默，
        // 避免每本书各建一个休眠线程并在同一时刻争抢完整书库保存锁。
        if READER_MARK_SAVE_GENERATION.load(Ordering::Acquire) != observed_generation {
            continue;
        }
        let state = save_app.state::<AppState>();
        report_save_error("书架", state.library.lock().unwrap().save());
        READER_MARK_SAVE_SCHEDULED.store(false, Ordering::Release);
        if READER_MARK_SAVE_GENERATION.load(Ordering::Acquire) == observed_generation {
            break;
        }
        // 若 mark_read 恰好发生在保存完成与 scheduled 清零之间，由当前 worker
        // 重新取得所有权；若另一个调用已启动新 worker，则本 worker 直接退出。
        if READER_MARK_SAVE_SCHEDULED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            break;
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
    // The shelf listens on Tauri's application event bus. A window-scoped
    // emit can be missed while focus is moving to the reader, leaving the
    // visible order stale until the next list_books refresh or disk save.
    let _ = app.emit(
        "shelf-book-read",
        serde_json::json!({
            "id": id_num.to_string(),
            "lastReadAt": last_read_at,
        }),
    );
    schedule_reader_mark_save(app);
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

fn schedule_clean_reader_shell_after(app: &tauri::AppHandle, delay: Duration) {
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
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        if let Err(error) = spawn_clean_reader_shell(&app) {
            log(&format!("reader_shell_pool build_failed error={error}"));
        }
        READER_SHELL_BUILD_SCHEDULED.store(false, Ordering::Release);
    });
}

pub(crate) fn schedule_clean_reader_shell(app: &tauri::AppHandle) {
    schedule_clean_reader_shell_after(app, Duration::from_millis(180));
}

fn schedule_clean_reader_shell_now(app: &tauri::AppHandle) {
    schedule_clean_reader_shell_after(app, Duration::ZERO);
}

#[tauri::command]
pub(crate) fn reader_shell_pool_ready(window: tauri::WebviewWindow) {
    if is_reader_shell_label(window.label()) && reader_window_id(&window).is_none() {
        READY_READER_SHELLS
            .lock()
            .unwrap()
            .insert(window.label().to_string());
        log(&format!("reader_shell_pool ready label={}", window.label()));
    }
}

#[tauri::command]
pub(crate) fn reader_shell_inner_engine_url() -> String {
    format!("{}/engine/0", crate::runtime_support::RES_BASE)
}

#[tauri::command]
pub(crate) fn reader_shell_inner_engine_ready(
    window: tauri::WebviewWindow,
    heap_bytes: Option<u64>,
) {
    if !is_reader_shell_label(window.label()) || reader_window_id(&window).is_some() {
        return;
    }
    READY_READER_SHELLS
        .lock()
        .unwrap()
        .insert(window.label().to_string());
    READY_READER_INNER_ENGINES.lock().unwrap().insert(
        window.label().to_string(),
        heap_bytes.filter(|bytes| *bytes > 0),
    );
    log(&format!(
        "reader_shell_inner_engine ready label={} heap_bytes={}",
        window.label(),
        heap_bytes.unwrap_or_default()
    ));
}

fn take_clean_reader_shell(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let ready_labels = READY_READER_SHELLS.lock().unwrap().clone();
    let prepared_labels = PREPARED_READER_SWITCH_SHELLS
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<HashSet<_>>();
    let shell = app
        .webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            (is_reader_shell_label(&label)
                && ready_labels.contains(&label)
                && !prepared_labels.contains(&label)
                && reader_window_id(&window).is_none()
                && !window.is_visible().unwrap_or(true))
            .then_some(window)
        });
    if let Some(window) = shell.as_ref() {
        READY_READER_SHELLS.lock().unwrap().remove(window.label());
        READY_READER_INNER_ENGINES
            .lock()
            .unwrap()
            .remove(window.label());
    }
    shell
}

fn show_pooled_reader_shell(window: &tauri::WebviewWindow) -> Result<bool, String> {
    window
        .show()
        .map_err(|error| format!("预加载阅读窗口无法显示：{error}"))?;
    Ok(window.unminimize().is_ok())
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
    request_recent_reading_cache_yield();
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
    let (title, path_exists, format) = {
        let library = state.library.lock().unwrap();
        let book = library.get(id_num).ok_or("找不到这本书")?;
        (book.title.clone(), book.path.exists(), book.format.clone())
    };
    if !path_exists {
        return Err("源文件已丢失，请在书架上对这本书重新定位。".to_string());
    }
    // The warm inner engine is the reflowable reader-page runtime. PDF owns a
    // separate PDF.js document/worker lifecycle and must start in an ordinary
    // shell; navigating a bound warm iframe into pdfview can leave WebView2 at
    // the static "PDF loading" page without ever requesting the document.
    if format.eq_ignore_ascii_case("pdf") {
        emit_reader_window_trace(&app, "open_pool", "bypass_pdf", open_started.elapsed());
        return Ok(false);
    }
    let geom = {
        let library = state.library.lock().unwrap();
        reader_geom_for_book(&library, id_num)
    };
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
    let restore = apply_geom_safe(&shell, &geom);
    emit_reader_geometry_trace(
        &app,
        &shell,
        "geometry_restore",
        "prepared_pool",
        "requested",
        geom.as_ref(),
        Some(restore),
    );
    READER_OPEN_STARTED_AT
        .lock()
        .unwrap()
        .insert(shell_label.clone(), (open_started, "pooled_shell"));
    // Load the target behind the current reader. complete_reader_switch owns
    // the only focus transition after destroying the old WebView.
    let restored = match show_pooled_reader_shell(&shell) {
        Ok(outcome) => outcome,
        Err(error) => {
            READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&shell_label);
            READER_OPEN_STARTED_AT.lock().unwrap().remove(&shell_label);
            let _ = shell.destroy();
            schedule_clean_reader_shell(&app);
            return Err(error);
        }
    };
    if !restored {
        log(&format!(
            "reader_switch prepared_reveal label={shell_label} restored={restored}"
        ));
    }
    emit_reader_window_trace(&app, "open_pool", "visible", open_started.elapsed());
    if let Err(error) = app.emit_to(&shell_label, "reader-shell-activate", ()) {
        READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&shell_label);
        READER_OPEN_STARTED_AT.lock().unwrap().remove(&shell_label);
        let _ = shell.destroy();
        schedule_clean_reader_shell(&app);
        return Err(error.to_string());
    }
    emit_reader_window_trace(
        &app,
        "open_pool",
        "activate_emitted",
        open_started.elapsed(),
    );
    PREPARED_READER_SWITCH_SHELLS
        .lock()
        .unwrap()
        .insert(id_num, shell_label);
    emit_reader_window_trace(&app, "open_pool", "binding", open_started.elapsed());
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
    cancel_shelf_focus_handoff_for_reader_open();
    request_recent_reading_cache_yield();
    // Do not remove this marker here. During a cold PDF build Tauri registers
    // the new window while it is still intentionally hidden; the completion
    // watcher must continue treating that interval as an active transition.
    // `complete_reader_switch` owns the guard and clears it after show/restore.
    let open_started = PENDING_READER_SWITCH_STARTED_AT
        .lock()
        .unwrap()
        .get(&id_num)
        .copied()
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
        // 隐藏窗口在 Windows 上可能被系统恢复为创建时的默认几何。即使同一本书
        // 复用同一 WebView，也必须在 show 之前重新应用刚刚落盘的几何，而不能
        // 假设 hide/show 会原样保留原生窗口大小和坐标。
        let geom = {
            let library = state.library.lock().unwrap();
            reader_geom_for_book(&library, id_num)
        };
        let restore = apply_geom_safe(&window, &geom);
        emit_reader_geometry_trace(
            app,
            &window,
            "geometry_restore",
            "same_book",
            "requested",
            geom.as_ref(),
            Some(restore),
        );
        let _ = app.emit_to(window.label(), "reader-shell-resume", ());
        let outcome = reveal_existing_reader_window(&window);
        emit_reader_geometry_trace(
            app,
            &window,
            "geometry_observed",
            "same_book",
            outcome,
            geom.as_ref(),
            None,
        );
        schedule_reader_geometry_observations(app, &window, "same_book", geom.as_ref());
        emit_reader_window_trace(app, "open_existing", outcome, open_started.elapsed());
        mark_reader_opened(app, state, id_num);
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
        if let Err(error) = app.emit_to(
            window.label(),
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
            let _ = app.emit_to(window.label(), "reader-shell-resume", ());
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
            mark_reader_opened(app, state, id_num);
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
    let (title, book_format) = {
        let library = state.library.lock().unwrap();
        library
            .get(id_num)
            .map(|book| (book.title.clone(), book.format.clone()))
            .unwrap_or_else(|| ("阅读".to_string(), String::new()))
    };

    // 读取上次阅读窗口的大小/位置，本次按它恢复（EPUB 与 PDF 分开记，各自适应）
    let geom = {
        let library = state.library.lock().unwrap();
        reader_geom_for_book(&library, id_num)
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

    let can_use_reflowable_pool = !book_format.eq_ignore_ascii_case("pdf");
    let pooled_shell = can_use_reflowable_pool
        .then(|| take_clean_reader_shell(app))
        .flatten();
    if !can_use_reflowable_pool {
        emit_reader_window_trace(app, "open_pool", "bypass_pdf", open_started.elapsed());
    } else if pooled_shell.is_none() && READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
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
        let restore = apply_geom_safe(&window, &geom);
        emit_reader_geometry_trace(
            app,
            &window,
            "geometry_restore",
            "pooled_shell",
            "requested",
            geom.as_ref(),
            Some(restore),
        );
        READER_OPEN_STARTED_AT
            .lock()
            .unwrap()
            .insert(pooled_label.clone(), (open_started, "pooled_shell"));
        let restored = match show_pooled_reader_shell(&window) {
            Ok(outcome) => outcome,
            Err(error) => {
                READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&pooled_label);
                READER_OPEN_STARTED_AT.lock().unwrap().remove(&pooled_label);
                let _ = window.destroy();
                schedule_clean_reader_shell(app);
                return Err(error);
            }
        };
        let focused = window.set_focus().is_ok();
        if !restored || !focused {
            log(&format!(
                "open_book pooled_reveal label={pooled_label} restored={restored} focused={focused}"
            ));
        }
        emit_reader_window_trace(app, "open_pool", "visible", open_started.elapsed());
        if let Err(error) = app.emit_to(&pooled_label, "reader-shell-activate", ()) {
            READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&pooled_label);
            READER_OPEN_STARTED_AT.lock().unwrap().remove(&pooled_label);
            let _ = window.destroy();
            schedule_clean_reader_shell(app);
            return Err(error.to_string());
        }
        emit_reader_window_trace(app, "open_pool", "activate_emitted", open_started.elapsed());
        emit_reader_geometry_trace(
            app,
            &window,
            "geometry_observed",
            "pooled_shell",
            "shown",
            geom.as_ref(),
            None,
        );
        schedule_reader_geometry_observations(app, &window, "pooled_shell", geom.as_ref());
        mark_reader_opened(app, state, id_num);
        log(&format!(
            "open_book pooled_shell label={pooled_label} elapsed_ms={}",
            open_started.elapsed().as_millis()
        ));
        emit_reader_window_trace(app, "open_pool", "activated", open_started.elapsed());
        return Ok(window);
    }

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("reader.html".into()))
            .title(title)
            .decorations(false)
            .resizable(true)
            .visible(false)
            .min_inner_size(420.0, 320.0);
    #[cfg(target_os = "macos")]
    if let Some(identifier) = crate::profile::webview_data_store_identifier() {
        builder = builder.data_store_identifier(identifier);
    }
    match &geom {
        Some(saved)
            if saved.physical.is_none()
                && saved.physical_outer.is_none()
                && saved.w >= 300.0
                && saved.h >= 300.0 =>
        {
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
    // 新建窗口也走同一条安全恢复路径：预加载池、同本书复用、冷启动三种打开
    // 方式都使用同一套尺寸、位置、越界回中与最大化规则。
    let restore = apply_geom_safe(&window, &geom);
    emit_reader_geometry_trace(
        app,
        &window,
        "geometry_restore",
        "new_shell",
        "requested",
        geom.as_ref(),
        Some(restore),
    );
    // macOS may create a new WebView window behind the shelf when the command
    // originates from an already-active app. Explicitly restore and focus it:
    // a successful build must result in a visible reader, not a background one.
    let shown = window.show().is_ok();
    let restored = window.unminimize().is_ok();
    let focused = window.set_focus().is_ok();
    emit_reader_geometry_trace(
        app,
        &window,
        "geometry_observed",
        "new_shell",
        if shown { "shown" } else { "show_failed" },
        geom.as_ref(),
        None,
    );
    schedule_reader_geometry_observations(app, &window, "new_shell", geom.as_ref());
    log(&format!(
        "open_book activate shown={shown} restored={restored} focused={focused}"
    ));

    // 只在关闭阅读窗口时保存几何信息。
    // Moved/Resized 在拖窗期间会高频触发；每次都跨 Rust 取位置并锁书库，会让阅读页拖动周期性卡顿。
    install_reader_window_lifecycle(app, &window);

    // 先只更新内存里的“最近阅读”。旧实现此处持有书架锁同步写盘，恰好会
    // 挡住新 WebView 紧接着发出的 book_info，导致窗口出现后仍长时间空白。
    mark_reader_opened(app, state, id_num);
    Ok(window)
}

fn reader_open_has_completed(app: &tauri::AppHandle, id_num: u64) -> bool {
    if PENDING_READER_SWITCH_STARTED_AT
        .lock()
        .unwrap()
        .contains_key(&id_num)
        || !REPLACING_READER_WINDOWS.lock().unwrap().is_empty()
    {
        return false;
    }
    let target = app.webview_windows().into_values().find(|window| {
        !reader_window_is_closing(window.label())
            && reader_window_id(window) == Some(id_num)
            && window.is_visible().unwrap_or(false)
    });
    target.is_some_and(|window| {
        !READER_OPEN_STARTED_AT
            .lock()
            .unwrap()
            .contains_key(window.label())
    })
}

fn clean_reader_shell_is_ready(app: &tauri::AppHandle) -> bool {
    let ready = READY_READER_SHELLS.lock().unwrap().clone();
    app.webview_windows().into_iter().any(|(label, window)| {
        is_reader_shell_label(&label)
            && ready.contains(&label)
            && reader_window_id(&window).is_none()
            && !window.is_visible().unwrap_or(true)
    })
}

/// `ensure_reader_window` may return after it has only dispatched a switch to
/// the existing reader. Keep the shelf's single-flight guard until the target
/// window has actually taken over; otherwise clicks on different cards can
/// overlap WebView2 destruction and creation.
pub(crate) async fn wait_for_reader_open_completion(
    app: &tauri::AppHandle,
    id_num: u64,
    request_started: Instant,
) -> Result<ReaderOpenCompletionTiming, String> {
    let wait_started = Instant::now();
    let deadline = wait_started + Duration::from_secs(15);
    let mut first_screen_completed_at = None;
    while Instant::now() < deadline {
        if reader_open_has_completed(app, id_num) {
            let completed_at = *first_screen_completed_at.get_or_insert_with(|| {
                emit_reader_window_trace(
                    app,
                    "open_complete",
                    "visible",
                    request_started.elapsed(),
                );
                Instant::now()
            });
            if !READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire)
                || clean_reader_shell_is_ready(app)
            {
                let completed = request_started.elapsed();
                let first_screen = completed_at.duration_since(request_started);
                emit_reader_window_trace(app, "open_refill", "ready", completed);
                return Ok(ReaderOpenCompletionTiming {
                    click_to_first_screen_ms: elapsed_ms(first_screen),
                    first_screen_to_refill_ms: elapsed_ms(completed.saturating_sub(first_screen)),
                    click_to_complete_ms: elapsed_ms(completed),
                    refill_outcome: if READER_SHELL_PRELOAD_ENABLED.load(Ordering::Acquire) {
                        "ready"
                    } else {
                        "disabled"
                    },
                });
            }
            // The current book is already visible. Give the just-started pool
            // refill a bounded chance to finish so a queued rapid open can use
            // it; never turn a successful visible open into an error merely
            // because an idle optimization did not become ready.
            if completed_at.elapsed() >= Duration::from_millis(800) {
                let completed = request_started.elapsed();
                let first_screen = completed_at.duration_since(request_started);
                emit_reader_window_trace(app, "open_refill", "timeout", completed);
                return Ok(ReaderOpenCompletionTiming {
                    click_to_first_screen_ms: elapsed_ms(first_screen),
                    first_screen_to_refill_ms: elapsed_ms(completed.saturating_sub(first_screen)),
                    click_to_complete_ms: elapsed_ms(completed),
                    refill_outcome: "timeout",
                });
            }
        } else {
            let transition_pending = PENDING_READER_SWITCH_STARTED_AT
                .lock()
                .unwrap()
                .contains_key(&id_num)
                || !REPLACING_READER_WINDOWS.lock().unwrap().is_empty();
            if !transition_pending {
                let target = app.webview_windows().into_values().find(|window| {
                    !reader_window_is_closing(window.label())
                        && reader_window_id(window) == Some(id_num)
                });
                if let Some(target) = target {
                    if !target.is_visible().unwrap_or(false) {
                        let label = target.label().to_string();
                        READER_OPEN_STARTED_AT.lock().unwrap().remove(&label);
                        READER_WINDOW_BOOK_IDS.lock().unwrap().remove(&label);
                        let _ = target.destroy();
                        schedule_clean_reader_shell(app);
                        emit_reader_window_trace(
                            app,
                            "open_complete",
                            "cancelled_hidden",
                            request_started.elapsed(),
                        );
                        return Err("阅读窗口已在正文启动前关闭。".to_string());
                    }
                } else if wait_started.elapsed() >= Duration::from_millis(250) {
                    emit_reader_window_trace(
                        app,
                        "open_complete",
                        "target_missing",
                        request_started.elapsed(),
                    );
                    return Err("阅读窗口未能完成创建。".to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    emit_reader_window_trace(app, "open_complete", "timeout", request_started.elapsed());
    Err("阅读窗口打开超时，请重试。".to_string())
}

#[tauri::command]
pub(crate) async fn complete_reader_switch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let _completion_guard = READER_SWITCH_COMPLETION_LOCK.lock().await;
    let started = Instant::now();
    let id_num = id.parse::<u64>().map_err(|_| "无效的图书 ID".to_string())?;
    // Keep PENDING_READER_SWITCH_STARTED_AT populated until this command has
    // finished showing the replacement. Its Drop implementation also covers
    // missing files, destroy failures and cold-window build errors.
    let pending_switch = PendingReaderSwitchGuard::new(id_num);
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
    // 目标书使用不同的窗口标签，可以立刻创建。这个命令必须保持 async，
    // 否则无可用预加载外壳时，ensure_reader_window 会在主线程等待主线程
    // 自己创建 WebView，形成互锁。
    if let Some(prepared) = take_prepared_reader_switch_shell(&app, id_num) {
        let switch_started = pending_switch
            .started_at()
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
    } else {
        ensure_reader_window(&app, &state, id_num)?;
    }
    emit_reader_window_trace(&app, "open_replace", "rebuilt", started.elapsed());
    Ok(())
}

/// 根据窗口当前状态算出几何信息（逻辑像素）。最大化时只更新 maximized 标志，
/// 保留之前的还原尺寸/位置，避免把全屏尺寸当成正常大小。
fn capture_main_window_geom(prev: Option<WinGeom>, window: &tauri::Window) -> WinGeom {
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
        if let Some(physical) = physical_geometry_from_native_window(window) {
            geom.physical = Some(physical);
        }
        #[cfg(target_os = "windows")]
        if let Some(physical_outer) = physical_outer_geometry_from_native_window(window) {
            geom.physical_outer = Some(physical_outer);
        }
    }
    geom
}

fn physical_geometry_from_native_window(window: &tauri::Window) -> Option<PhysicalWinGeom> {
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    if size.width < 100 || size.height < 100 || position.x <= -10_000 || position.y <= -10_000 {
        return None;
    }
    Some(PhysicalWinGeom {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
    })
}

#[cfg(target_os = "windows")]
fn physical_outer_geometry_from_native_window(window: &tauri::Window) -> Option<PhysicalWinGeom> {
    let size = window.outer_size().ok()?;
    let position = window.outer_position().ok()?;
    if size.width < 100 || size.height < 100 || position.x <= -10_000 || position.y <= -10_000 {
        return None;
    }
    Some(PhysicalWinGeom {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
    })
}

#[derive(Clone, Copy)]
struct MonitorBounds {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct GeometryRestoreReport {
    space: &'static str,
    size_applied: bool,
    position_applied: bool,
    clamped: bool,
    target: Option<MonitorBounds>,
}

fn physical_geometry_json(geom: &PhysicalWinGeom) -> serde_json::Value {
    serde_json::json!({ "x": geom.x, "y": geom.y, "w": geom.w, "h": geom.h })
}

fn physical_geometry_from_window(window: &tauri::WebviewWindow) -> Option<PhysicalWinGeom> {
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    if size.width < 100 || size.height < 100 || position.x <= -10_000 || position.y <= -10_000 {
        return None;
    }
    Some(PhysicalWinGeom {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
    })
}

#[cfg(target_os = "windows")]
fn physical_outer_geometry_from_window(window: &tauri::WebviewWindow) -> Option<PhysicalWinGeom> {
    let size = window.outer_size().ok()?;
    let position = window.outer_position().ok()?;
    if size.width < 100 || size.height < 100 || position.x <= -10_000 || position.y <= -10_000 {
        return None;
    }
    Some(PhysicalWinGeom {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
    })
}

fn preferred_physical_geometry_from_window(
    window: &tauri::WebviewWindow,
) -> Option<PhysicalWinGeom> {
    #[cfg(target_os = "windows")]
    {
        physical_outer_geometry_from_window(window)
    }
    #[cfg(not(target_os = "windows"))]
    {
        physical_geometry_from_window(window)
    }
}

fn preferred_saved_physical_geometry(geom: &WinGeom) -> Option<&PhysicalWinGeom> {
    geom.physical_outer.as_ref().or(geom.physical.as_ref())
}

/// 根据窗口当前状态算出几何信息。最大化时只更新最大化标志，保留之前的还原
/// 尺寸/位置；新记录同时保留物理像素，避免不同 DPI 显示器之间重复缩放。
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
        if let Some(physical) = physical_geometry_from_window(window) {
            geom.physical = Some(physical);
        }
        #[cfg(target_os = "windows")]
        if let Some(physical_outer) = physical_outer_geometry_from_window(window) {
            geom.physical_outer = Some(physical_outer);
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
fn update_reader_geom(library: &mut Library, window: &tauri::WebviewWindow) -> WinGeom {
    let is_pdf = reader_window_id(window)
        .and_then(|id| library.get(id).map(|book| book.format == "pdf"))
        .unwrap_or(false);
    if is_pdf {
        let geom = capture_geom(library.reader_geom_pdf.clone(), window);
        library.reader_geom_pdf = Some(geom.clone());
        geom
    } else {
        let geom = capture_geom(library.reader_geom.clone(), window);
        library.reader_geom = Some(geom.clone());
        geom
    }
}

fn reader_geom_for_book(library: &Library, id: u64) -> Option<WinGeom> {
    if library
        .get(id)
        .map(|book| book.format == "pdf")
        .unwrap_or(false)
    {
        library.reader_geom_pdf.clone()
    } else {
        library.reader_geom.clone()
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

fn monitor_bounds_for_physical_geom(
    window: &tauri::WebviewWindow,
    geom: &PhysicalWinGeom,
) -> Option<MonitorBounds> {
    let rect_right = i64::from(geom.x) + i64::from(geom.w);
    let rect_bottom = i64::from(geom.y) + i64::from(geom.h);
    let mut best: Option<(u64, MonitorBounds)> = None;
    for monitor in window.available_monitors().ok()? {
        let position = monitor.position();
        let size = monitor.size();
        let right = i64::from(position.x) + i64::from(size.width);
        let bottom = i64::from(position.y) + i64::from(size.height);
        let overlap_w =
            (rect_right.min(right) - i64::from(geom.x).max(i64::from(position.x))).max(0);
        let overlap_h =
            (rect_bottom.min(bottom) - i64::from(geom.y).max(i64::from(position.y))).max(0);
        let overlap = (overlap_w as u64).saturating_mul(overlap_h as u64);
        let bounds = MonitorBounds {
            x: position.x,
            y: position.y,
            w: size.width,
            h: size.height,
        };
        if best.is_none_or(|(current, _)| overlap > current) {
            best = Some((overlap, bounds));
        }
    }
    best.and_then(|(overlap, bounds)| (overlap > 0).then_some(bounds))
        .or_else(|| {
            window.primary_monitor().ok().flatten().map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                MonitorBounds {
                    x: position.x,
                    y: position.y,
                    w: size.width,
                    h: size.height,
                }
            })
        })
}

fn clamp_physical_geom(geom: &PhysicalWinGeom, target: MonitorBounds) -> (PhysicalWinGeom, bool) {
    let max_width = target.w.saturating_sub(40).max(300);
    let max_height = target.h.saturating_sub(60).max(300);
    let w = geom.w.min(max_width);
    let h = geom.h.min(max_height);
    let max_x = i64::from(target.x) + i64::from(target.w.saturating_sub(w));
    let max_y = i64::from(target.y) + i64::from(target.h.saturating_sub(h));
    let x = i64::from(geom.x).clamp(i64::from(target.x), max_x) as i32;
    let y = i64::from(geom.y).clamp(i64::from(target.y), max_y) as i32;
    let clamped = x != geom.x || y != geom.y || w != geom.w || h != geom.h;
    (PhysicalWinGeom { x, y, w, h }, clamped)
}

fn physical_size_matches(current: Option<&PhysicalWinGeom>, target: &PhysicalWinGeom) -> bool {
    current.is_some_and(|current| current.w == target.w && current.h == target.h)
}

fn physical_position_matches(current: Option<&PhysicalWinGeom>, target: &PhysicalWinGeom) -> bool {
    current.is_some_and(|current| current.x == target.x && current.y == target.y)
}

#[cfg(target_os = "windows")]
fn legacy_inner_geometry_as_outer(
    saved: &PhysicalWinGeom,
    current_inner: Option<&PhysicalWinGeom>,
    current_outer: Option<&PhysicalWinGeom>,
) -> PhysicalWinGeom {
    let frame_width = current_inner
        .zip(current_outer)
        .map(|(inner, outer)| outer.w.saturating_sub(inner.w))
        .unwrap_or(0);
    let frame_height = current_inner
        .zip(current_outer)
        .map(|(inner, outer)| outer.h.saturating_sub(inner.h))
        .unwrap_or(0);
    PhysicalWinGeom {
        x: saved.x,
        y: saved.y,
        w: saved.w.saturating_add(frame_width),
        h: saved.h.saturating_add(frame_height),
    }
}

fn apply_legacy_logical_geometry(
    window: &tauri::WebviewWindow,
    saved: &WinGeom,
    report: &mut GeometryRestoreReport,
) {
    report.space = "legacy_logical_v0";
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
        report.size_applied = window
            .set_size(tauri::LogicalSize::new(width, height))
            .is_ok();
        if position_on_screen(window, saved) {
            report.position_applied = window
                .set_position(tauri::LogicalPosition::new(saved.x, saved.y))
                .is_ok();
        } else if let Some((x, y)) = centered_position(window, width, height) {
            report.position_applied = window
                .set_position(tauri::LogicalPosition::new(x, y))
                .is_ok();
        }
    }
}

/// 安全地把保存的几何信息应用到窗口：尺寸超屏会收缩，位置越界则真正居中（不依赖 center()）。
pub(crate) fn apply_geom_safe(
    window: &tauri::WebviewWindow,
    geom: &Option<WinGeom>,
) -> GeometryRestoreReport {
    // Geometry is applied while hidden. This is also important on macOS, where
    // AppKit may animate a maximization that was requested after a window was
    // already visible.
    let _ = window.hide();
    let _ = window.unminimize();
    let mut report = GeometryRestoreReport {
        space: "none",
        size_applied: false,
        position_applied: false,
        clamped: false,
        target: None,
    };
    if let Some(saved) = geom {
        #[cfg(target_os = "windows")]
        {
            if saved.physical_outer.is_some() || saved.physical.is_some() {
                let current_inner = physical_geometry_from_window(window);
                let current_outer = physical_outer_geometry_from_window(window);
                let requested = saved.physical_outer.clone().or_else(|| {
                    saved.physical.as_ref().map(|physical| {
                        legacy_inner_geometry_as_outer(
                            physical,
                            current_inner.as_ref(),
                            current_outer.as_ref(),
                        )
                    })
                });
                report.space = if saved.physical_outer.is_some() {
                    "physical_outer_v2"
                } else {
                    "physical_inner_v1"
                };
                report.target = requested
                    .as_ref()
                    .and_then(|physical| monitor_bounds_for_physical_geom(window, physical));
                if let (Some(requested), Some(target)) = (requested.as_ref(), report.target) {
                    let (target_geom, clamped) = clamp_physical_geom(requested, target);
                    report.clamped = clamped;
                    if target_geom.w >= 300 && target_geom.h >= 300 {
                        let size_matches =
                            physical_size_matches(current_outer.as_ref(), &target_geom);
                        let position_matches =
                            physical_position_matches(current_outer.as_ref(), &target_geom);
                        let applied = window.hwnd().ok().is_some_and(|handle| {
                            windows_activation::set_outer_geometry(
                                handle.0,
                                target_geom.x,
                                target_geom.y,
                                target_geom.w,
                                target_geom.h,
                                !size_matches,
                                !position_matches,
                            )
                        });
                        report.size_applied = size_matches || applied;
                        report.position_applied = position_matches || applied;
                    }
                }
            } else {
                apply_legacy_logical_geometry(window, saved, &mut report);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Some(physical) = saved.physical.as_ref() {
                report.space = "physical_inner_v1";
                report.target = monitor_bounds_for_physical_geom(window, physical);
                if let Some(target) = report.target {
                    let (target_geom, clamped) = clamp_physical_geom(physical, target);
                    report.clamped = clamped;
                    if target_geom.w >= 300 && target_geom.h >= 300 {
                        let current = physical_geometry_from_window(window);
                        report.size_applied = physical_size_matches(current.as_ref(), &target_geom)
                            || window
                                .set_size(tauri::PhysicalSize::new(target_geom.w, target_geom.h))
                                .is_ok();
                        report.position_applied =
                            physical_position_matches(current.as_ref(), &target_geom)
                                || window
                                    .set_position(tauri::PhysicalPosition::new(
                                        target_geom.x,
                                        target_geom.y,
                                    ))
                                    .is_ok();
                    }
                }
            } else {
                apply_legacy_logical_geometry(window, saved, &mut report);
            }
        }
        if saved.maximized {
            let _ = window.maximize();
        }
    }
    // 首帧绘制之前保持隐藏；前端在书架渲染完后调用 main_window_show。
    let _ = window.unminimize();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_lifecycle_commands_are_never_broadcast_to_idle_preload_shells() {
        let full_source = include_str!("window_commands.rs");
        let tests_start = full_source.find("mod tests {").unwrap();
        let source = &full_source[..tests_start];
        for event in [
            "reader-shell-activate",
            "reader-shell-resume",
            "reader-switch-request",
            "reader-hide-request",
        ] {
            let needle = format!("\"{event}\"");
            let positions: Vec<_> = source.match_indices(&needle).collect();
            assert!(!positions.is_empty(), "missing lifecycle event {event}");
            for (index, _) in positions {
                let prefix = &source[index.saturating_sub(160)..index];
                assert!(
                    prefix.contains("emit_to("),
                    "reader lifecycle event {event} must target one window"
                );
            }
        }
    }

    #[test]
    fn recent_reading_cache_only_runs_while_the_reader_foreground_is_idle() {
        assert!(recent_reading_cache_can_run(true, false, false, false));
        assert!(!recent_reading_cache_can_run(false, false, false, false));
        assert!(!recent_reading_cache_can_run(true, true, false, false));
        assert!(!recent_reading_cache_can_run(true, false, true, false));
        assert!(!recent_reading_cache_can_run(true, false, false, true));
    }

    #[test]
    fn reader_open_paths_request_background_cache_yield_before_work() {
        let source = include_str!("window_commands.rs");
        for entry in [
            "pub(crate) fn prepare_reader_switch_target",
            "pub(crate) fn ensure_reader_window",
        ] {
            let start = source.find(entry).unwrap();
            let body = &source[start..];
            let request = body.find("request_recent_reading_cache_yield()").unwrap();
            let parse_or_open = body
                .find("let id_num")
                .or_else(|| body.find("let open_started"))
                .unwrap();
            assert!(request < parse_or_open);
        }
    }

    #[test]
    fn pending_reader_switch_guard_keeps_the_transition_visible_until_drop() {
        let id_num = u64::MAX - 17;
        let started_at = Instant::now();
        PENDING_READER_SWITCH_STARTED_AT
            .lock()
            .unwrap()
            .insert(id_num, started_at);

        {
            let guard = PendingReaderSwitchGuard::new(id_num);
            assert_eq!(guard.started_at(), Some(started_at));
            assert_eq!(
                PENDING_READER_SWITCH_STARTED_AT
                    .lock()
                    .unwrap()
                    .get(&id_num)
                    .copied(),
                Some(started_at)
            );
        }

        assert!(!PENDING_READER_SWITCH_STARTED_AT
            .lock()
            .unwrap()
            .contains_key(&id_num));
    }

    #[test]
    fn cold_reader_build_does_not_clear_the_pending_switch_before_show() {
        let source = include_str!("window_commands.rs");
        let ensure_start = source.find("pub(crate) fn ensure_reader_window").unwrap();
        let ensure_prefix_end = source[ensure_start..]
            .find("let label = format!")
            .map(|offset| ensure_start + offset)
            .unwrap();
        let ensure_prefix = &source[ensure_start..ensure_prefix_end];
        assert!(ensure_prefix.contains(".get(&id_num)"));
        assert!(!ensure_prefix.contains(".remove(&id_num)"));

        let switch_start = source
            .find("pub(crate) async fn complete_reader_switch")
            .unwrap();
        let switch_end = source[switch_start..]
            .find("fn capture_main_window_geom")
            .map(|offset| switch_start + offset)
            .unwrap();
        let switch_source = &source[switch_start..switch_end];
        let guard = switch_source
            .find("PendingReaderSwitchGuard::new(id_num)")
            .unwrap();
        let build_and_show = switch_source
            .find("ensure_reader_window(&app, &state, id_num)")
            .unwrap();
        assert!(guard < build_and_show);
    }

    #[test]
    fn shelf_focus_outcome_requires_confirmed_webview_focus_for_success() {
        assert_eq!(
            shelf_focus_outcome(ShelfFocusRequest {
                window_requested: true,
                native_foreground: true,
                webview_requested: true,
                webview_confirmed: false,
            }),
            "requested"
        );
        assert_eq!(
            shelf_focus_outcome(ShelfFocusRequest {
                window_requested: false,
                native_foreground: false,
                webview_requested: false,
                webview_confirmed: true,
            }),
            "focused"
        );
        assert_eq!(
            shelf_focus_outcome(ShelfFocusRequest {
                window_requested: false,
                native_foreground: false,
                webview_requested: false,
                webview_confirmed: false,
            }),
            "failed"
        );
    }

    #[test]
    fn hidden_reader_close_retries_focus_until_the_shelf_webview_is_confirmed() {
        let source = include_str!("window_commands.rs");
        let close_start = source
            .find("pub(crate) fn main_window_close(webview: tauri::Webview)")
            .unwrap();
        let close_end = source[close_start..]
            .find("pub(crate) fn reader_shell_hidden_after_save")
            .map(|offset| close_start + offset)
            .unwrap();
        let close_source = &source[close_start..close_end];
        let hide = close_source.find("window.hide()").unwrap();
        let activate = close_source
            .find("activate_shelf_after_reader_close(&app)")
            .unwrap();
        let retry = close_source
            .find("schedule_shelf_focus_handoff_after_hidden_reader(&app)")
            .unwrap();
        assert!(hide < activate);
        assert!(activate < retry);

        let retry_start = source
            .find("fn schedule_shelf_focus_handoff_after_hidden_reader")
            .unwrap();
        let retry_source = &source[retry_start..close_start];
        assert!(retry_source.contains("windows_activation::webview_has_focus"));
        assert!(retry_source.contains("\"focused_after_retry\""));
        assert!(retry_source.contains("\"unconfirmed\""));
        assert!(retry_source.contains("const RETRY_DELAYS_MS: [u64; 7]"));
    }

    #[test]
    fn reader_focus_trace_uses_the_app_bus_and_keeps_only_bounded_focus_evidence() {
        let source = include_str!("window_commands.rs");
        let lifecycle_start = source.find("fn emit_reader_window_trace").unwrap();
        let lifecycle_end = source[lifecycle_start..]
            .find("fn emit_reader_geometry_trace")
            .map(|offset| lifecycle_start + offset)
            .unwrap();
        let lifecycle_source = &source[lifecycle_start..lifecycle_end];
        assert!(lifecycle_source.contains("let _ = app.emit("));
        assert!(!lifecycle_source.contains("main.emit("));

        let focus_start = source.find("fn emit_shelf_focus_trace").unwrap();
        let focus_end = source[focus_start..]
            .find("fn activate_shelf_after_reader_close")
            .map(|offset| focus_start + offset)
            .unwrap();
        let focus_source = &source[focus_start..focus_end];
        assert!(focus_source.contains("windowRequested"));
        assert!(focus_source.contains("nativeFocused"));
        assert!(focus_source.contains("webviewRequested"));
        assert!(focus_source.contains("webviewFocused"));
        assert!(!focus_source.contains("bookId"));
        assert!(!focus_source.contains("title"));
        assert!(!focus_source.contains("path"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_activation_does_not_leave_keyboard_focus_on_the_titlebar() {
        let source = include_str!("window_commands.rs");
        let module_start = source.find("mod windows_activation").unwrap();
        let module_end = source[module_start..]
            .find("static CLOSING_READER_WINDOWS")
            .map(|offset| module_start + offset)
            .unwrap();
        let module_source = &source[module_start..module_end];
        assert!(!module_source.contains("fn set_focus(window: Hwnd)"));
        assert!(module_source.contains("fn get_gui_thread_info"));
        assert!(module_source.contains("is_child(window, info.focused) != 0"));
        assert!(module_source.contains("set_window_pos(window, -1_isize as Hwnd"));
        assert!(module_source.contains("set_window_pos(window, -2_isize as Hwnd"));
    }

    #[test]
    fn reader_close_broadcasts_undo_checkpoint_after_hiding() {
        let source = include_str!("window_commands.rs");
        let close_start = source
            .find("pub(crate) fn main_window_close(webview: tauri::Webview)")
            .unwrap();
        let close_end = source[close_start..]
            .find("pub(crate) fn reader_shell_hidden_after_save")
            .map(|offset| close_start + offset)
            .unwrap();
        let close_source = &source[close_start..close_end];
        let capture = close_source
            .find("update_reader_geom(&mut library, &reader)")
            .unwrap();
        let hidden = close_source[capture..]
            .find("window.hide()")
            .map(|offset| capture + offset)
            .unwrap();
        let save = close_source.find("let library_saved").unwrap();
        let broadcast = close_source.find("\"reader-closed-for-reopen\"").unwrap();
        assert!(capture < hidden);
        assert!(hidden < broadcast);
        assert!(hidden < save);
        assert!(close_source.contains("\"undo_checkpoint\""));
        let unbound = close_source.find("ignored_unbound_shell").unwrap();
        assert!(unbound < capture);
        assert!(!close_source.contains("\"missing_book\""));
    }

    #[test]
    fn main_close_saves_bound_readers_before_backgrounding_the_shelf() {
        let source = include_str!("window_commands.rs");
        let close_start = source
            .find("pub(crate) fn main_window_close(webview: tauri::Webview)")
            .unwrap();
        let close_source = &source[close_start..];
        let save_readers = close_source
            .find("persist_reader_window_states_before_main_close(&app)")
            .unwrap();
        let save_main = close_source
            .find("persist_main_window_state(&app, &window)")
            .unwrap();
        let background = close_source
            .find("background_main_from_window(&app, &window)")
            .unwrap();
        assert!(save_readers < save_main);
        assert!(save_main < background);
        assert!(source.contains("\"main_close\""));
    }

    #[test]
    fn hidden_reader_reveal_distinguishes_focus_show_and_failure() {
        assert_eq!(
            reader_reveal_outcome(true, true, true, false, true, false),
            "focused"
        );
        assert_eq!(
            reader_reveal_outcome(true, true, true, false, false, false),
            "shown"
        );
        assert_eq!(
            reader_reveal_outcome(false, false, false, false, false, false),
            "failed"
        );
    }

    #[test]
    fn hidden_reader_reopen_reapplies_saved_geometry_before_showing() {
        let source = include_str!("window_commands.rs");
        let start = source.find("pub(crate) fn ensure_reader_window").unwrap();
        let end = source[start..]
            .find("// 同一本书直接复用隐藏的 WebView")
            .map(|offset| start + offset)
            .unwrap();
        let existing = &source[start..end];
        let apply = existing.find("apply_geom_safe(&window, &geom)").unwrap();
        let reveal = existing
            .find("reveal_existing_reader_window(&window)")
            .unwrap();
        assert!(apply < reveal);
        assert!(existing.contains("reader_geom_for_book(&library, id_num)"));
    }

    #[test]
    fn every_successful_existing_reader_reopen_updates_recent_reading_time() {
        let source = include_str!("window_commands.rs");
        let start = source.find("pub(crate) fn ensure_reader_window").unwrap();
        let end = source[start..]
            .find("pub(crate) async fn complete_reader_switch")
            .map(|offset| start + offset)
            .unwrap();
        let ensure_source = &source[start..end];

        let same_book_end = ensure_source
            .find("// 同一本书直接复用隐藏的 WebView")
            .unwrap();
        let same_book = &ensure_source[..same_book_end];
        let recent = same_book
            .rfind("mark_reader_opened(app, state, id_num)")
            .unwrap();
        let returned = same_book.rfind("return Ok(window)").unwrap();
        assert!(recent < returned);

        let fallback_start = ensure_source
            .find("if let Some(window) = app.get_webview_window(&label)")
            .unwrap();
        let fallback_end = ensure_source[fallback_start..]
            .find("// CloseRequested 到 Destroyed")
            .map(|offset| fallback_start + offset)
            .unwrap();
        let fallback = &ensure_source[fallback_start..fallback_end];
        let recent = fallback
            .find("mark_reader_opened(app, state, id_num)")
            .unwrap();
        let returned = fallback.find("return Ok(window)").unwrap();
        assert!(recent < returned);
    }

    #[test]
    fn rapid_reader_marks_share_one_debounced_save_worker() {
        let source = include_str!("window_commands.rs");
        let scheduler_start = source.find("fn schedule_reader_mark_save").unwrap();
        let mark_start = source.find("fn mark_reader_opened").unwrap();
        let scheduler = &source[scheduler_start..mark_start];
        assert!(scheduler.contains("READER_MARK_SAVE_GENERATION.fetch_add"));
        assert!(scheduler.contains("READER_MARK_SAVE_SCHEDULED"));
        assert!(scheduler.contains("compare_exchange(false, true"));
        assert!(scheduler.contains("std::thread::sleep(READER_MARK_SAVE_IDLE_DELAY)"));
        assert!(scheduler.contains("!= observed_generation"));

        let mark_end = source[mark_start..]
            .find("fn spawn_clean_reader_shell")
            .map(|offset| mark_start + offset)
            .unwrap();
        let mark = &source[mark_start..mark_end];
        assert!(mark.contains("schedule_reader_mark_save(app)"));
        assert!(!mark.contains("std::thread::spawn"));
        assert!(!mark.contains("Duration::from_secs(2)"));
    }

    #[test]
    fn close_command_keeps_the_invoking_webview_window_context() {
        let source = include_str!("window_commands.rs");
        assert!(source.contains("pub(crate) fn main_window_close(webview: tauri::Webview)"));
        assert!(source.contains("let label = webview.label();"));
        assert!(source.contains("let window = webview.window();"));
    }

    #[test]
    fn reader_labels_only_accept_numeric_reader_windows() {
        assert_eq!(reader_id_from_label("reader-42"), Some(42));
        assert_eq!(reader_id_from_label("reader-42-benchmark-9"), None);
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
    fn physical_geometry_preserves_valid_size_and_only_clamps_a_missing_or_small_screen() {
        let saved = PhysicalWinGeom {
            x: 263,
            y: 104,
            w: 1508,
            h: 880,
        };
        let current_monitor = MonitorBounds {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        };
        assert_eq!(
            physical_geometry_json(&clamp_physical_geom(&saved, current_monitor).0),
            physical_geometry_json(&saved)
        );
        assert!(!clamp_physical_geom(&saved, current_monitor).1);

        let smaller_monitor = MonitorBounds {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        };
        let (clamped, changed) = clamp_physical_geom(&saved, smaller_monitor);
        assert!(changed);
        assert_eq!((clamped.w, clamped.h), (1240, 660));
        assert!((0..=40).contains(&clamped.x));
        assert!((0..=60).contains(&clamped.y));
    }

    #[test]
    fn cached_reader_skips_noop_physical_resize_and_move() {
        let current = PhysicalWinGeom {
            x: 120,
            y: 80,
            w: 1280,
            h: 800,
        };
        assert!(physical_size_matches(Some(&current), &current));
        assert!(physical_position_matches(Some(&current), &current));

        let moved = PhysicalWinGeom { x: 140, ..current };
        assert!(physical_size_matches(Some(&current), &moved));
        assert!(!physical_position_matches(Some(&current), &moved));
    }

    #[test]
    fn main_window_capture_persists_physical_outer_geometry() {
        let source = include_str!("window_commands.rs");
        let start = source.find("fn capture_main_window_geom").unwrap();
        let end = source[start..]
            .find("fn physical_geometry_from_native_window")
            .map(|offset| start + offset)
            .unwrap();
        let capture = &source[start..end];
        assert!(capture.contains("geom.physical = Some(physical)"));
        assert!(capture.contains("geom.physical_outer = Some(physical_outer)"));

        let main = include_str!("main.rs");
        assert!(main.contains("saved.physical.is_none()"));
        assert!(main.contains("saved.physical_outer.is_none()"));
        assert!(main.contains("emit_main_geometry_trace"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn legacy_client_geometry_is_migrated_to_one_stable_outer_rectangle() {
        let saved = PhysicalWinGeom {
            x: 639,
            y: 60,
            w: 3015,
            h: 2100,
        };
        let current_inner = PhysicalWinGeom {
            x: 0,
            y: 0,
            w: 880,
            h: 760,
        };
        let current_outer = PhysicalWinGeom {
            x: 0,
            y: 0,
            w: 896,
            h: 799,
        };
        let migrated =
            legacy_inner_geometry_as_outer(&saved, Some(&current_inner), Some(&current_outer));
        assert_eq!((migrated.x, migrated.y), (639, 60));
        assert_eq!((migrated.w, migrated.h), (3031, 2139));
        assert_eq!(
            legacy_inner_geometry_as_outer(&saved, None, None).w,
            saved.w
        );
    }

    #[test]
    fn cold_reader_builder_does_not_treat_physical_pixels_as_logical_pixels() {
        let source = include_str!("window_commands.rs");
        let ensure = source.find("pub(crate) fn ensure_reader_window").unwrap();
        let start = source[ensure..]
            .find("let mut builder =")
            .map(|offset| ensure + offset)
            .unwrap();
        let end = source[start..]
            .find("let result = builder.build()")
            .map(|offset| start + offset)
            .unwrap();
        let builder = &source[start..end];
        assert!(builder.contains("saved.physical.is_none()"));
        assert!(builder.contains("saved.physical_outer.is_none()"));
        assert!(builder.contains(".visible(false)"));
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
        assert_eq!(
            benchmark_phase_at_native_elapsed("shell_bootstrap elapsed_ms=3.2", 187),
            Some(ReaderShellBenchmarkPhase::ShellBootstrap(187))
        );
        assert_eq!(
            benchmark_phase_at_native_elapsed("shell_ready elapsed_ms=93.5", 421),
            Some(ReaderShellBenchmarkPhase::FrameReady(421))
        );
        assert!(matches!(
            benchmark_phase_from_perf_event("shell_prepared"),
            Some(ReaderShellBenchmarkPhase::ShellPrepared)
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("chapter_payload_ready"),
            Some(ReaderShellBenchmarkPhase::ChapterPayloadReady(0))
        ));
        assert!(matches!(
            benchmark_phase_from_perf_event("chapter_resources_ready"),
            Some(ReaderShellBenchmarkPhase::ChapterResourcesReady(0))
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

        let regular = benchmark_timing(BenchmarkTimingInput {
            shell_bootstrap_ms: Some(35),
            chapter_payload_ready_ms: Some(80),
            chapter_styles_ready_ms: Some(100),
            chapter_dom_ready_ms: Some(135),
            chapter_resources_ready_ms: Some(175),
            page_layout_ready_ms: 240,
            first_page_displayed_ms: 275,
            shell_preloaded: false,
        });
        assert_eq!(regular.shell_ms, 35);
        assert_eq!(regular.content_ms, 45);
        assert_eq!(regular.styles_ms, 20);
        assert_eq!(regular.dom_ms, 35);
        assert_eq!(regular.resources_ms, 40);
        assert_eq!(regular.pagination_ms, 65);
        assert_eq!(regular.layout_ms, 205);
        assert_eq!(regular.display_ms, 35);
        assert_eq!(regular.total_ms, 275);
        assert!(regular.detailed);
        let preloaded = benchmark_timing(BenchmarkTimingInput {
            shell_bootstrap_ms: None,
            chapter_payload_ready_ms: None,
            chapter_styles_ready_ms: None,
            chapter_dom_ready_ms: None,
            chapter_resources_ready_ms: None,
            page_layout_ready_ms: 240,
            first_page_displayed_ms: 275,
            shell_preloaded: true,
        });
        assert_eq!(preloaded.shell_ms, 0);
        assert_eq!(preloaded.layout_ms, 240);
        assert_eq!(preloaded.pagination_ms, 240);
        assert_eq!(preloaded.display_ms, 35);
        assert!(!preloaded.detailed);

        let aggregate = aggregate_benchmark_timings(&[
            benchmark_timing(BenchmarkTimingInput {
                shell_bootstrap_ms: None,
                chapter_payload_ready_ms: None,
                chapter_styles_ready_ms: None,
                chapter_dom_ready_ms: None,
                chapter_resources_ready_ms: None,
                page_layout_ready_ms: 100,
                first_page_displayed_ms: 105,
                shell_preloaded: true,
            }),
            benchmark_timing(BenchmarkTimingInput {
                shell_bootstrap_ms: None,
                chapter_payload_ready_ms: None,
                chapter_styles_ready_ms: None,
                chapter_dom_ready_ms: None,
                chapter_resources_ready_ms: None,
                page_layout_ready_ms: 80,
                first_page_displayed_ms: 90,
                shell_preloaded: true,
            }),
            benchmark_timing(BenchmarkTimingInput {
                shell_bootstrap_ms: None,
                chapter_payload_ready_ms: None,
                chapter_styles_ready_ms: None,
                chapter_dom_ready_ms: None,
                chapter_resources_ready_ms: None,
                page_layout_ready_ms: 120,
                first_page_displayed_ms: 140,
                shell_preloaded: true,
            }),
        ]);
        assert_eq!(aggregate.total_ms, 105);
        assert_eq!(aggregate.p95_ms, 140);
    }
}
