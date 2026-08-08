use crate::{
    book::{Library, WinGeom},
    log, now_ms, report_save_error, AppState,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, LazyLock, Mutex},
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
static READER_CLOSE_STARTED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn mark_reader_close_started(label: &str) {
    READER_CLOSE_STARTED
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_insert_with(Instant::now);
}

fn take_reader_close_elapsed(label: &str) -> Duration {
    READER_CLOSE_STARTED
        .lock()
        .unwrap()
        .remove(label)
        .map(|started| started.elapsed())
        .unwrap_or(Duration::ZERO)
}

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
        if reader_window_is_closing(window.label()) {
            return Ok(());
        }
        mark_reader_close_started(window.label());
        set_reader_window_closing(window.label(), true);
        emit_reader_window_trace(
            window.app_handle(),
            "close_command",
            "requested",
            Duration::ZERO,
        );
        // 网页关闭按钮已经等待精确阅读位置写盘，直接沿用正常销毁流程。
        // Destroyed 后等待旧窗口从注册表移除，再恢复书架焦点。
        if let Err(error) = window.close() {
            set_reader_window_closing(window.label(), false);
            let _ = take_reader_close_elapsed(window.label());
            emit_reader_window_trace(
                window.app_handle(),
                "close_command",
                "failed",
                Duration::ZERO,
            );
            return Err(error.to_string());
        }
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
    app.webview_windows()
        .keys()
        .any(|label| label.starts_with("reader-"))
}

#[tauri::command]
pub(crate) fn reader_window_open(app: tauri::AppHandle) -> bool {
    any_reader_window_open(&app)
}

fn reader_id_from_label(label: &str) -> Option<u64> {
    label.strip_prefix("reader-").and_then(|id| id.parse().ok())
}

/// 从阅读窗口 label 取图书 id。
pub(crate) fn reader_window_id(window: &tauri::WebviewWindow) -> Option<u64> {
    reader_id_from_label(window.label())
}

/// 创建/聚焦某本书的阅读窗口，恢复上次几何位置；返回该窗口。
pub(crate) fn ensure_reader_window(
    app: &tauri::AppHandle,
    state: &AppState,
    id_num: u64,
) -> Result<tauri::WebviewWindow, String> {
    let open_started = Instant::now();
    let label = format!("reader-{id_num}");
    if let Some(window) = app.get_webview_window(&label) {
        if !reader_window_is_closing(&label) {
            let result = window.set_focus().map_err(|error| error.to_string());
            emit_reader_window_trace(
                app,
                "open_existing",
                if result.is_ok() { "focused" } else { "failed" },
                open_started.elapsed(),
            );
            return result.map(|_| window);
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
    // 禁止多开：打开新书前，关掉其它已打开的阅读窗口（始终只保留一个阅读窗口）
    for (other_label, window) in app.webview_windows() {
        if other_label.starts_with("reader-") && other_label != label {
            let _ = window.close();
        }
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

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("reader.html".into()))
            .title(title)
            .decorations(false)
            .resizable(true)
            .min_inner_size(420.0, 320.0);
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
    if !on_screen {
        let _ = window.center(); // 上次坐标已不在任何屏幕内 → 回到屏幕中央
    }
    if geom.as_ref().map(|saved| saved.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }

    // 只在关闭阅读窗口时保存几何信息。
    // Moved/Resized 在拖窗期间会高频触发；每次都跨 Rust 取位置并锁书库，会让阅读页拖动周期性卡顿。
    let event_app = app.clone();
    let event_label = label.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            mark_reader_close_started(&event_label);
            set_reader_window_closing(&event_label, true);
            emit_reader_window_trace(&event_app, "close_requested", "saving", Duration::ZERO);
            if let Some(closing) = event_app.get_webview_window(&event_label) {
                let state = event_app.state::<AppState>();
                // 页数测量的实际工作在这个 WebView 中。关闭时把已经落盘的
                // 逐章缓存当作检查点暂停，不能让统一任务中心遗留 running 记录。
                if let Some(task) = state.page_count_tasks.lock().unwrap().remove(&id_num) {
                    let _ = task.pause();
                }
                let mut library = state.library.lock().unwrap();
                update_reader_geom(&mut library, &closing);
                report_save_error("书架", library.save());
                report_save_error("统计", state.stats.lock().unwrap().save());
            }
            // 此时阅读窗口仍持有 Windows 前台资格，先把输入焦点交还书架；
            // 等到 Destroyed 后再请求往往已经太晚，API 会成功但实际焦点不变。
            activate_shelf_after_reader_close(&event_app);
        } else if let tauri::WindowEvent::Destroyed = event {
            emit_reader_window_trace(
                &event_app,
                "destroyed",
                "closed",
                take_reader_close_elapsed(&event_label),
            );
            schedule_shelf_activation_after_reader_close(&event_app, &event_label);
            // 不在后台按标签轮询并清 closing：同名新窗口可能已经创建。
            // 下一次 ensure_reader_window 会在确认旧注册项消失后原子地清理。
        }
    });

    // 先只更新内存里的“最近阅读”。旧实现此处持有书架锁同步写盘，恰好会
    // 挡住新 WebView 紧接着发出的 book_info，导致窗口出现后仍长时间空白。
    let last_read_at = {
        let mut library = state.library.lock().unwrap();
        library.mark_read(id_num);
        library
            .get(id_num)
            .map(|book| book.last_read_at)
            .unwrap_or(0)
    };
    // 主窗口不必等重新获得焦点后再请求整份书架；打开成功时立即把这一项
    // 的最近阅读时间推过去，使“按最近阅读”在阅读窗口出现前就已重排。
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
        std::thread::sleep(std::time::Duration::from_secs(2));
        let state = save_app.state::<AppState>();
        report_save_error("书架", state.library.lock().unwrap().save());
    });
    Ok(window)
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
    // 确保可见、未最小化、并取得焦点
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_labels_only_accept_numeric_reader_windows() {
        assert_eq!(reader_id_from_label("reader-42"), Some(42));
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
}
