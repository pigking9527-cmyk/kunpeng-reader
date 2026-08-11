//! macOS 为阅读器整屏模式保留直接触控板输入、丢弃惯性尾流。
//!
//! WebKit 的 JavaScript `WheelEvent` 不暴露 AppKit 的 `momentumPhase`。
//! 若在网页层用时间间隔猜测手势结束，快速轻扫的惯性事件会要么再次翻页，
//! 要么持续占用翻页锁。这里在原生事件到达 WebView 前过滤尾流；仅当阅读器
//! 处于整屏模式时启用，因此常规滚动和书架不会改变系统滚动行为。

#[cfg(target_os = "macos")]
use std::{
    ptr::{self, NonNull},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};

#[cfg(target_os = "macos")]
static PAGED_READER_MOMENTUM_FILTER_ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub fn set_paged_reader_momentum_filter(enabled: bool) {
    PAGED_READER_MOMENTUM_FILTER_ENABLED.store(enabled, Ordering::Release);
}

#[tauri::command]
pub fn set_reader_paged_wheel_momentum_filter(enabled: bool) {
    #[cfg(target_os = "macos")]
    set_paged_reader_momentum_filter(enabled);
    #[cfg(not(target_os = "macos"))]
    let _ = enabled;
}

#[cfg(target_os = "macos")]
pub fn install_paged_reader_wheel_monitor() {
    let handler = RcBlock::new(|event: NonNull<NSEvent>| {
        let raw_event = event.as_ptr();
        // `momentumPhase` is populated for trackpad and Magic Mouse inertia;
        // ordinary wheel hardware reports `None` and remains untouched.
        let is_momentum = unsafe { event.as_ref() }.momentumPhase() != NSEventPhase::None;
        if PAGED_READER_MOMENTUM_FILTER_ENABLED.load(Ordering::Acquire) && is_momentum {
            ptr::null_mut()
        } else {
            raw_event
        }
    });
    // AppKit retains an installed monitor until `removeMonitor:`. The reader
    // lives for the process lifetime, so intentionally retain this tiny token
    // for the same duration instead of risking a monitor disappearing early.
    if let Some(monitor) = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
    } {
        std::mem::forget(monitor);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install_paged_reader_wheel_monitor() {}
