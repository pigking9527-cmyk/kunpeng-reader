//! NVIDIA runtime redistribution is intentionally disabled pending legal review.

pub(crate) const DOWNLOAD_BYTES: u64 = 0;

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn prepare() {}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn install_available() -> bool {
    false
}

pub(crate) fn downloaded_bytes() -> u64 {
    0
}

#[tauri::command]
pub(crate) async fn install_semantic_gpu_runtime(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app;
    Err("NVIDIA GPU 运行库自动下载已暂停，当前版本使用本机已有运行库或 CPU 回退。".into())
}
