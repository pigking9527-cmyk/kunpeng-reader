//! Process startup, file-association forwarding and single-instance support.

use crate::{
    atomic_file, emit_startup_perf, import_core, library_commands, log, search,
    set_thread_background, window_commands,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

pub(crate) struct StartupBookPaths(Mutex<Vec<String>>);

impl StartupBookPaths {
    pub(crate) fn new(paths: Vec<String>) -> Self {
        Self(Mutex::new(paths))
    }
}

#[derive(Serialize, Deserialize)]
struct AssociatedBookRequest {
    id: u64,
    paths: Vec<String>,
}

static NEXT_ASSOCIATED_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static PRIMARY_INSTANCE_STARTED_AT: AtomicU64 = AtomicU64::new(0);

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn associated_book_paths(args: &[String], cwd: &Path) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    args.iter()
        .skip(1)
        .filter_map(|arg| {
            let path = PathBuf::from(arg);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            (path.is_file() && import_core::is_supported_book_path(&path))
                .then(|| path.to_string_lossy().into_owned())
        })
        .filter(|path| seen.insert(path.to_ascii_lowercase()))
        .collect()
}

pub(crate) fn startup_book_paths() -> Vec<String> {
    let args = std::env::args().collect::<Vec<_>>();
    let cwd = std::env::current_dir().unwrap_or_default();
    associated_book_paths(&args, &cwd)
}

fn associated_book_request_path() -> Option<PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("ebook-reader");
    dir.push("associated-book-request.json");
    Some(dir)
}

fn next_associated_request_id() -> u64 {
    let now = unix_time_ms();
    loop {
        let previous = NEXT_ASSOCIATED_REQUEST_ID.load(Ordering::Relaxed);
        let next = now.max(previous.saturating_add(1));
        if NEXT_ASSOCIATED_REQUEST_ID
            .compare_exchange(previous, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

fn forward_associated_book_paths(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let Some(path) = associated_book_request_path() else {
        log("转发关联文件失败：无法确定缓存目录");
        return;
    };
    let request = AssociatedBookRequest {
        id: next_associated_request_id(),
        paths,
    };
    if let Err(error) = atomic_file::write_json(&path, &request, false) {
        log(&format!("转发关联文件失败：{error}"));
    }
}

pub(crate) fn spawn_associated_book_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // A second process can finish forwarding while the primary process is
        // still constructing Tauri. Use the instant at which the process lock
        // was acquired as the lower bound instead of "now", otherwise that
        // early request would be mistaken for an old one and never delivered.
        let request_floor = PRIMARY_INSTANCE_STARTED_AT.load(Ordering::Relaxed);
        let mut seen_id = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let Some(path) = associated_book_request_path() else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            let Ok(request) = serde_json::from_str::<AssociatedBookRequest>(&text) else {
                continue;
            };
            if request.id >= request_floor && request.id > seen_id {
                seen_id = request.id;
                let _ = app.emit("associated-book-open", request.paths);
            }
        }
    });
}

/// 主窗口单实例（Windows 原生，命名互斥量）：已有实例在运行时，把关联文件路径交给它并聚焦。
#[cfg(windows)]
pub(crate) fn ensure_single_instance(startup_book_paths: Vec<String>) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::AtomicPtr;
    type Handle = *mut core::ffi::c_void;
    static SINGLE_INSTANCE_MUTEX: AtomicPtr<core::ffi::c_void> =
        AtomicPtr::new(std::ptr::null_mut());
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attr: *const core::ffi::c_void, owner: i32, name: *const u16) -> Handle;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> Handle;
        fn SetForegroundWindow(hwnd: Handle) -> i32;
        fn ShowWindow(hwnd: Handle, cmd: i32) -> i32;
        fn IsIconic(hwnd: Handle) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;
    let instance_started_at = unix_time_ms();
    unsafe {
        let name = wide("KunpengReader_SingleInstance_Mutex");
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if h.is_null() {
            log(&format!(
                "初始化单实例互斥量失败（Windows 错误码 {}），为避免并发写入已终止启动",
                GetLastError()
            ));
            return false;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            forward_associated_book_paths(startup_book_paths);
            let title = wide("鲲鹏阅读器");
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                SetForegroundWindow(hwnd);
            }
            return false;
        }
        PRIMARY_INSTANCE_STARTED_AT.store(instance_started_at, Ordering::Relaxed);
        SINGLE_INSTANCE_MUTEX.store(h, Ordering::Relaxed);
        true
    }
}

/// Unix（包括 macOS）使用内核 `flock`。文件对象保存在进程级静态变量中，
/// 因而锁会一直持有到进程退出；崩溃后内核会自动释放锁，遗留的空文件无害。
#[cfg(unix)]
pub(crate) fn ensure_single_instance(startup_book_paths: Vec<String>) -> bool {
    use std::fs::{File, OpenOptions};
    use std::os::fd::AsRawFd;

    const LOCK_EX: core::ffi::c_int = 2;
    const LOCK_NB: core::ffi::c_int = 4;
    static SINGLE_INSTANCE_FILE: Mutex<Option<File>> = Mutex::new(None);

    extern "C" {
        fn flock(fd: core::ffi::c_int, operation: core::ffi::c_int) -> core::ffi::c_int;
    }

    let instance_started_at = unix_time_ms();
    let Some(mut lock_path) = dirs::cache_dir() else {
        log("初始化单实例文件锁失败：无法确定缓存目录；为避免并发写入已终止启动");
        return false;
    };
    lock_path.push("ebook-reader");
    if let Err(error) = std::fs::create_dir_all(&lock_path) {
        log(&format!(
            "初始化单实例文件锁失败：无法创建锁目录：{error}；为避免并发写入已终止启动"
        ));
        return false;
    }
    lock_path.push("single-instance.lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(error) => {
            log(&format!(
                "初始化单实例文件锁失败（{}）：{error}；为避免并发写入已终止启动",
                lock_path.display()
            ));
            return false;
        }
    };

    // SAFETY: `file` owns a valid descriptor for the whole call. On success it
    // is moved into `SINGLE_INSTANCE_FILE`, which keeps that descriptor alive
    // (and therefore keeps the advisory lock held) until process shutdown.
    let result = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            forward_associated_book_paths(startup_book_paths);
        } else {
            log(&format!(
                "获取单实例文件锁失败（{}）：{error}；为避免并发写入已终止启动",
                lock_path.display()
            ));
        }
        return false;
    }

    let mut retained = match SINGLE_INSTANCE_FILE.lock() {
        Ok(retained) => retained,
        Err(error) => {
            log(&format!(
                "保存单实例文件锁失败：{error}；为避免并发写入已终止启动"
            ));
            return false;
        }
    };
    if retained.is_some() {
        log("单实例文件锁被重复初始化；为避免锁状态不明已终止启动");
        return false;
    }
    *retained = Some(file);
    PRIMARY_INSTANCE_STARTED_AT.store(instance_started_at, Ordering::Relaxed);
    true
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn ensure_single_instance(_startup_book_paths: Vec<String>) -> bool {
    log("当前平台没有可用的单实例锁实现；为避免并发写入已终止启动");
    false
}

#[tauri::command]
pub(crate) fn take_startup_book_paths(state: tauri::State<StartupBookPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// 延迟执行可中断的低优先级维护任务，避免与首屏和阅读窗口争抢资源。
pub(crate) fn spawn_maintenance(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        set_thread_background(true);
        emit_startup_perf(
            &app,
            "startup-maintenance",
            "scheduled",
            "background delay=45s",
        );
        // 让首屏渲染、封面加载、窗口拖动和账号状态先稳定下来。
        std::thread::sleep(std::time::Duration::from_secs(45));
        while window_commands::any_reader_window_open(&app) {
            emit_startup_perf(&app, "startup-maintenance", "paused", "reader window open");
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        emit_startup_perf(&app, "fingerprint-fill", "start", "background");
        library_commands::spawn_fingerprint_fill(app.clone());
        std::thread::sleep(std::time::Duration::from_secs(15));
        while window_commands::any_reader_window_open(&app) {
            emit_startup_perf(&app, "keyword-index", "paused", "reader window open");
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        search::spawn_build_index(app.clone());
        emit_startup_perf(
            &app,
            "startup-maintenance",
            "end",
            "spawned background jobs",
        );
        set_thread_background(false);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn associated_paths_keep_supported_existing_files_once() {
        let unique = format!(
            "kunpeng-reader-startup-{}-{}",
            std::process::id(),
            next_associated_request_id()
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).unwrap();
        let book = root.join("sample.EPUB");
        let ignored = root.join("sample.exe");
        std::fs::write(&book, b"book").unwrap();
        std::fs::write(&ignored, b"program").unwrap();
        let args = vec![
            "reader.exe".to_string(),
            "sample.EPUB".to_string(),
            book.to_string_lossy().into_owned(),
            "sample.exe".to_string(),
            "missing.pdf".to_string(),
        ];

        let paths = associated_book_paths(&args, &root);

        assert_eq!(paths, vec![book.to_string_lossy().into_owned()]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn associated_request_ids_are_strictly_monotonic() {
        assert!(next_associated_request_id() < next_associated_request_id());
    }

    #[cfg(unix)]
    #[test]
    fn unix_process_lock_rejects_a_second_process() {
        const CHILD_MARKER: &str = "KUNPENG_SINGLE_INSTANCE_TEST_CHILD";
        if std::env::var_os(CHILD_MARKER).is_some() {
            assert!(!ensure_single_instance(Vec::new()));
            return;
        }

        assert!(ensure_single_instance(Vec::new()));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "startup::tests::unix_process_lock_rejects_a_second_process",
            ])
            .env(CHILD_MARKER, "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
