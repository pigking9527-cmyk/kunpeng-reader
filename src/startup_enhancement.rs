//! Optional Edge-style warm activation without a tray icon.

use crate::{atomic_file, emit_startup_perf, log, AppState};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Emitter, Manager};

/// 唤醒后的这段时间只服务前台交互，避免索引和补全任务抢占首帧后的操作。
const HOT_ACTIVATION_HIGH_COST_GRACE_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartupEnhancementConfig {
    pub(crate) enabled: bool,
    pub(crate) continue_high_cost: bool,
    pub(crate) launch_at_login: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupEnhancementStatus {
    enabled: bool,
    continue_high_cost: bool,
    launch_at_login: bool,
    launch_at_login_available: bool,
}

pub(crate) struct StartupEnhancementState {
    enabled: AtomicBool,
    continue_high_cost: AtomicBool,
    launch_at_login: AtomicBool,
    backgrounded: AtomicBool,
    high_cost_resume_at_ms: AtomicU64,
}

impl StartupEnhancementState {
    pub(crate) fn load() -> Self {
        let config = load_config().unwrap_or_default();
        Self {
            enabled: AtomicBool::new(config.enabled),
            continue_high_cost: AtomicBool::new(config.continue_high_cost),
            launch_at_login: AtomicBool::new(config.launch_at_login),
            backgrounded: AtomicBool::new(false),
            high_cost_resume_at_ms: AtomicU64::new(0),
        }
    }

    fn config(&self) -> StartupEnhancementConfig {
        StartupEnhancementConfig {
            enabled: self.enabled.load(Ordering::Acquire),
            continue_high_cost: self.continue_high_cost.load(Ordering::Acquire),
            launch_at_login: self.launch_at_login.load(Ordering::Acquire),
        }
    }

    fn update(&self, config: StartupEnhancementConfig) -> Result<(), String> {
        if config.launch_at_login != self.launch_at_login.load(Ordering::Acquire) {
            configure_launch_at_login(config.launch_at_login)?;
        }
        save_config(config)?;
        self.enabled.store(config.enabled, Ordering::Release);
        self.continue_high_cost
            .store(config.continue_high_cost, Ordering::Release);
        self.launch_at_login
            .store(config.launch_at_login, Ordering::Release);
        Ok(())
    }

    fn status(&self) -> StartupEnhancementStatus {
        let config = self.config();
        StartupEnhancementStatus {
            enabled: config.enabled,
            continue_high_cost: config.continue_high_cost,
            launch_at_login: config.launch_at_login,
            launch_at_login_available: cfg!(windows),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub(crate) fn background_work_allowed(&self) -> bool {
        self.background_work_allowed_at(crate::now_ms())
    }

    fn background_work_allowed_at(&self, now_ms: u64) -> bool {
        let in_background = self.backgrounded.load(Ordering::Acquire);
        if in_background && !self.continue_high_cost.load(Ordering::Acquire) {
            return false;
        }
        now_ms >= self.high_cost_resume_at_ms.load(Ordering::Acquire)
    }

    fn begin_hot_activation_grace(&self, now_ms: u64) -> u64 {
        let resume_at_ms = now_ms.saturating_add(HOT_ACTIVATION_HIGH_COST_GRACE_MS);
        self.high_cost_resume_at_ms
            .store(resume_at_ms, Ordering::Release);
        resume_at_ms
    }
}

#[cfg(windows)]
const WINDOWS_RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const WINDOWS_RUN_VALUE: &str = "KunpengReader";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn windows_registry_command() -> Command {
    let mut command = Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn configure_launch_at_login(enabled: bool) -> Result<(), String> {
    if !enabled {
        let exists = windows_registry_command()
            .args(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE])
            .status()
            .map_err(|error| format!("查询开机自启失败：{error}"))?;
        if !exists.success() {
            return Ok(());
        }
        let output = windows_registry_command()
            .args(["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"])
            .output()
            .map_err(|error| format!("关闭开机自启失败：{error}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(format!(
            "关闭开机自启失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let executable =
        std::env::current_exe().map_err(|error| format!("无法确定当前程序路径：{error}"))?;
    let command_line = format!("\"{}\"", executable.display());
    let output = windows_registry_command()
        .args([
            "add",
            WINDOWS_RUN_KEY,
            "/v",
            WINDOWS_RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            &command_line,
            "/f",
        ])
        .output()
        .map_err(|error| format!("开启开机自启失败：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "开启开机自启失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(windows))]
fn configure_launch_at_login(_enabled: bool) -> Result<(), String> {
    Err("当前平台暂不支持开机自启设置".to_string())
}
fn config_path() -> Option<PathBuf> {
    let mut path = dirs::config_dir()?;
    path.push("ebook-reader");
    path.push("startup-enhancement.json");
    Some(path)
}

fn load_config() -> Option<StartupEnhancementConfig> {
    let path = config_path()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_config(config: StartupEnhancementConfig) -> Result<(), String> {
    let path = config_path().ok_or("无法确定应用配置目录")?;
    let parent = path.parent().ok_or("启动增强配置路径无效")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    atomic_file::write_json(&path, &config, true)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundStatePayload {
    backgrounded: bool,
    continue_high_cost: bool,
    high_cost_resume_at_ms: u64,
}

fn emit_background_state(
    app: &tauri::AppHandle,
    backgrounded: bool,
    continue_high_cost: bool,
    high_cost_resume_at_ms: u64,
) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "startup-enhancement-state",
            BackgroundStatePayload {
                backgrounded,
                continue_high_cost,
                high_cost_resume_at_ms,
            },
        );
    }
}

#[tauri::command]
pub(crate) fn startup_enhancement_config(
    state: tauri::State<StartupEnhancementState>,
) -> StartupEnhancementStatus {
    state.status()
}

#[tauri::command]
pub(crate) fn set_startup_enhancement_config(
    state: tauri::State<StartupEnhancementState>,
    request: StartupEnhancementConfig,
) -> Result<StartupEnhancementStatus, String> {
    state.update(request)?;
    Ok(state.status())
}

pub(crate) fn should_keep_running(app: &tauri::AppHandle) -> bool {
    app.state::<StartupEnhancementState>().enabled()
}

pub(crate) fn background_main(app: &tauri::AppHandle) {
    let enhancement = app.state::<StartupEnhancementState>();
    let config = enhancement.config();
    enhancement.backgrounded.store(true, Ordering::Release);
    enhancement
        .high_cost_resume_at_ms
        .store(0, Ordering::Release);

    for (label, reader) in app.webview_windows() {
        if label.starts_with("reader-") {
            let _ = reader.close();
        }
    }
    if !config.continue_high_cost {
        let paused = app
            .state::<AppState>()
            .background_tasks
            .request_pause_high_cost();
        log(&format!(
            "[startup-enhancement] backgrounded paused_high_cost={paused}"
        ));
    }
    emit_background_state(app, true, config.continue_high_cost, 0);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_skip_taskbar(true);
        let _ = main.hide();
    }
}

pub(crate) fn activate_main(app: &tauri::AppHandle, requested_at_ms: u64) {
    let enhancement = app.state::<StartupEnhancementState>();
    enhancement.backgrounded.store(false, Ordering::Release);
    let resume_at_ms = enhancement.begin_hot_activation_grace(crate::now_ms());
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_skip_taskbar(false);
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    emit_background_state(
        app,
        false,
        enhancement.config().continue_high_cost,
        resume_at_ms,
    );
    let elapsed = crate::now_ms().saturating_sub(requested_at_ms);
    emit_startup_perf(
        app,
        "startup-enhancement",
        "activated",
        format!("{elapsed}ms hot activation; high-cost work delayed 15s"),
    );
}

pub(crate) fn background_work_allowed(app: &tauri::AppHandle) -> bool {
    app.state::<StartupEnhancementState>()
        .background_work_allowed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_full_exit_and_paused_background_work() {
        let config = serde_json::from_str::<StartupEnhancementConfig>("{}").unwrap();
        assert_eq!(config, StartupEnhancementConfig::default());
        assert!(!config.enabled);
        assert!(!config.continue_high_cost);
    }

    #[test]
    fn config_uses_camel_case_for_the_settings_boundary() {
        let config = StartupEnhancementConfig {
            enabled: true,
            continue_high_cost: true,
            launch_at_login: true,
        };
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::json!({"enabled": true, "continueHighCost": true, "launchAtLogin": true})
        );
    }

    #[test]
    fn hot_activation_grace_defers_high_cost_work_only_until_its_deadline() {
        let state = StartupEnhancementState {
            enabled: AtomicBool::new(true),
            continue_high_cost: AtomicBool::new(false),
            launch_at_login: AtomicBool::new(false),
            backgrounded: AtomicBool::new(false),
            high_cost_resume_at_ms: AtomicU64::new(110),
        };
        assert!(!state.background_work_allowed_at(109));
        assert!(state.background_work_allowed_at(110));
    }
}
