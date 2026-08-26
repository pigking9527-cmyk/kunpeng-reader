//! Local NVIDIA CUDA runtime discovery and activation.
//!
//! CUDA/cuDNN redistribution remains disabled pending legal review（自动下载已暂停）. On Windows,
//! an explicit user action may instead reuse an already installed CUDA 12 +
//! cuDNN 9 runtime (for example the one shipped with a local PyTorch install).
//! The selected directory is validated and remembered, but no DLL is copied
//! into the application, repository, cache or installer.

use crate::AppState;
use std::path::{Path, PathBuf};

pub(crate) const DOWNLOAD_BYTES: u64 = 0;

const SETTINGS_FILE: &str = "semantic-gpu-runtime-path.txt";

#[cfg(target_os = "windows")]
const REQUIRED_WINDOWS_DLLS: &[&str] = &[
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cufft64_11.dll",
    "cudnn64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_graph64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_ops64_9.dll",
    "nvJitLink_120_0.dll",
    "zlibwapi.dll",
];

#[cfg(target_os = "windows")]
const WINDOWS_PRELOAD_ORDER: &[&str] = &[
    "nvJitLink_120_0.dll",
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cufft64_11.dll",
    "zlibwapi.dll",
    "cudnn_ops64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_graph64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn64_9.dll",
];

fn settings_path() -> Option<PathBuf> {
    let mut path = crate::profile::app_config_dir().or_else(crate::profile::app_cache_dir)?;
    path.push(SETTINGS_FILE);
    Some(path)
}

#[cfg(target_os = "windows")]
fn validate_runtime_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "选择的 CUDA 组件目录不存在或无法访问".to_string())?;
    if !canonical.is_dir() {
        return Err("请选择包含 CUDA 12 和 cuDNN 9 DLL 的文件夹".into());
    }
    let missing = REQUIRED_WINDOWS_DLLS
        .iter()
        .copied()
        .filter(|name| {
            std::fs::metadata(canonical.join(name))
                .map(|metadata| !metadata.is_file() || metadata.len() == 0)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(canonical)
    } else {
        Err(format!(
            "选择的目录不是完整的 CUDA 12/cuDNN 9 运行组件，缺少：{}",
            missing.join("、")
        ))
    }
}

#[cfg(target_os = "windows")]
fn configured_runtime_dir() -> Option<PathBuf> {
    let value = settings_path()
        .and_then(|path| std::fs::read_to_string(path).ok())?
        .trim()
        .to_string();
    if value.is_empty() {
        return None;
    }
    validate_runtime_dir(Path::new(&value)).ok()
}

#[cfg(target_os = "windows")]
fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !candidates.iter().any(|item| item == &path) {
        candidates.push(path);
    }
}

#[cfg(target_os = "windows")]
fn runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = configured_runtime_dir() {
        push_candidate(&mut candidates, path);
    }

    for name in ["CUDA_PATH", "CONDA_PREFIX"] {
        if let Some(root) = std::env::var_os(name).map(PathBuf::from) {
            if name == "CUDA_PATH" {
                push_candidate(&mut candidates, root.join("bin"));
            } else {
                push_candidate(&mut candidates, root.join("Lib/site-packages/torch/lib"));
                push_candidate(&mut candidates, root.join("Library/bin"));
            }
        }
    }
    for (name, value) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("CUDA_PATH_V12")
        {
            push_candidate(&mut candidates, PathBuf::from(value).join("bin"));
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for distribution in ["anaconda3", "miniconda3"] {
            let root = profile.join(distribution);
            push_candidate(&mut candidates, root.join("Lib/site-packages/torch/lib"));
            push_candidate(&mut candidates, root.join("Library/bin"));
        }
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA").map(PathBuf::from) {
        for distribution in ["anaconda3", "miniconda3"] {
            let root = program_data.join(distribution);
            push_candidate(&mut candidates, root.join("Lib/site-packages/torch/lib"));
            push_candidate(&mut candidates, root.join("Library/bin"));
        }
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let toolkit_root = program_files.join("NVIDIA GPU Computing Toolkit/CUDA");
        if let Ok(entries) = std::fs::read_dir(toolkit_root) {
            let mut versions = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("v12"))
                })
                .collect::<Vec<_>>();
            versions.sort_by(|left, right| right.cmp(left));
            for version in versions {
                push_candidate(&mut candidates, version.join("bin"));
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            push_candidate(&mut candidates, entry);
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn discover_runtime_dir() -> Option<PathBuf> {
    runtime_candidates()
        .into_iter()
        .find_map(|path| validate_runtime_dir(&path).ok())
}

#[cfg(target_os = "windows")]
mod windows_loader {
    use super::{validate_runtime_dir, Path, PathBuf, WINDOWS_PRELOAD_ORDER};
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::{Mutex, OnceLock};

    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(file_name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    #[derive(Default)]
    struct LoadedRuntime {
        directory: Option<PathBuf>,
        // Handles remain loaded for the lifetime of the process. Unloading CUDA
        // while ONNX sessions may still reference it is unsafe.
        handles: Vec<usize>,
    }

    fn loaded_runtime() -> &'static Mutex<LoadedRuntime> {
        static SLOT: OnceLock<Mutex<LoadedRuntime>> = OnceLock::new();
        SLOT.get_or_init(|| Mutex::new(LoadedRuntime::default()))
    }

    pub(super) fn load(path: &Path) -> Result<PathBuf, String> {
        let canonical = validate_runtime_dir(path)?;
        let mut loaded = loaded_runtime()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if loaded.directory.as_ref() == Some(&canonical) {
            return Ok(canonical);
        }
        if loaded.directory.is_some() {
            return Err("本次运行已加载另一组 CUDA 组件；请重启阅读器后再切换目录".into());
        }

        let mut handles = Vec::with_capacity(WINDOWS_PRELOAD_ORDER.len());
        for name in WINDOWS_PRELOAD_ORDER {
            let file = canonical.join(name);
            let wide = file
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            // SAFETY: `wide` is NUL-terminated and remains alive for the call;
            // the absolute path was canonicalized and validated above.
            let handle = unsafe {
                LoadLibraryExW(
                    wide.as_ptr(),
                    std::ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
            };
            if handle.is_null() {
                // SAFETY: GetLastError has no preconditions and is read directly
                // after the failed Windows loader call.
                let code = unsafe { GetLastError() };
                return Err(format!("加载 {name} 失败（Windows 错误 {code}）"));
            }
            handles.push(handle as usize);
        }
        loaded.directory = Some(canonical.clone());
        loaded.handles = handles;
        Ok(canonical)
    }
}

/// Load an already approved local runtime before ONNX Runtime registers CUDA.
/// Absence of a configured directory is not an error: system-installed DLLs may
/// already be discoverable through the normal Windows loader path.
#[cfg(target_os = "windows")]
pub(crate) fn prepare() -> Result<(), String> {
    if let Some(path) = configured_runtime_dir() {
        windows_loader::load(&path)?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn prepare() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn install_available() -> bool {
    discover_runtime_dir().is_some()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_available() -> bool {
    false
}

pub(crate) fn downloaded_bytes() -> u64 {
    0
}

#[cfg(target_os = "windows")]
fn activate_runtime_dir(path: &Path) -> Result<(), String> {
    let canonical = windows_loader::load(path)?;
    // A real Provider registration is the authority; file presence alone must
    // never be reported as usable GPU acceleration.
    super::gpu::cuda_runtime_ready()?;
    let config = settings_path().ok_or("无法确定 CUDA 组件设置路径")?;
    if let Some(parent) = config.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("保存 CUDA 组件设置失败：{error}"))?;
    }
    crate::atomic_file::write(&config, canonical.to_string_lossy().as_bytes())
}

fn reset_loaded_semantic_model(state: &AppState) {
    super::model::reset_runtime_for_device_policy(state);
    super::clear_sem_query_cache();
    super::clear_sem_status_cache();
}

/// Reuse the first complete local CUDA 12/cuDNN 9 installation found in a
/// small set of conventional, local-only locations. This command performs no
/// network access and copies no files; invoking it is the user's explicit
/// approval to load those local DLLs into the reader process.
#[tauri::command]
pub(crate) async fn install_semantic_gpu_runtime(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path = discover_runtime_dir().ok_or(
            "没有找到完整的本机 CUDA 12/cuDNN 9 组件；可手动定位 PyTorch 的 torch\\lib 或 CUDA 的 bin 目录",
        )?;
        activate_runtime_dir(&path)?;
        reset_loaded_semantic_model(state.inner());
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("当前平台暂不支持从其他本机软件定位 CUDA 组件".into())
    }
}

/// Save and activate a directory explicitly selected by the user. The UI may
/// expose this through a folder picker when automatic local discovery fails.
#[tauri::command]
pub(crate) async fn select_semantic_gpu_runtime(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        activate_runtime_dir(Path::new(path.trim()))?;
        reset_loaded_semantic_model(state.inner());
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, path);
        Err("当前平台暂不支持手动定位 CUDA 组件".into())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::{validate_runtime_dir, REQUIRED_WINDOWS_DLLS};

    #[cfg(target_os = "windows")]
    #[test]
    fn runtime_directory_requires_the_complete_reviewed_dependency_set() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-cuda-runtime-validation-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(validate_runtime_dir(&root).is_err());
        for name in REQUIRED_WINDOWS_DLLS {
            std::fs::write(root.join(name), b"local-runtime-component").unwrap();
        }
        assert_eq!(
            validate_runtime_dir(&root).unwrap(),
            root.canonicalize().unwrap()
        );
        std::fs::write(root.join(REQUIRED_WINDOWS_DLLS[0]), []).unwrap();
        assert!(validate_runtime_dir(&root).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn redistribution_remains_disabled() {
        assert_eq!(super::DOWNLOAD_BYTES, 0);
        assert_eq!(super::downloaded_bytes(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires a complete local CUDA 12/cuDNN 9 runtime"]
    fn local_runtime_registers_with_onnx_cuda_provider() {
        let path = super::discover_runtime_dir().expect("local CUDA runtime candidate");
        super::windows_loader::load(&path).expect("preload local CUDA runtime");
        super::super::gpu::cuda_runtime_ready().expect("register ONNX CUDA provider");
    }
}
