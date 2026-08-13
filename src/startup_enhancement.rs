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
    pub(crate) launch_at_login_background: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupEnhancementStatus {
    enabled: bool,
    continue_high_cost: bool,
    launch_at_login: bool,
    launch_at_login_available: bool,
    launch_at_login_background: bool,
    launch_at_login_background_available: bool,
}

pub(crate) struct StartupEnhancementState {
    enabled: AtomicBool,
    continue_high_cost: AtomicBool,
    launch_at_login: AtomicBool,
    launch_at_login_background: AtomicBool,
    login_backgrounded: AtomicBool,
    backgrounded: AtomicBool,
    high_cost_resume_at_ms: AtomicU64,
}

impl StartupEnhancementState {
    pub(crate) fn load() -> Self {
        let mut config = load_config().unwrap_or_default();
        // An isolated acceptance profile must never inherit or create a
        // user-level LaunchAgent. Keep the rest of its local UI preferences
        // independent, but force both login-launch switches off in memory.
        if crate::profile::is_isolated() {
            config.launch_at_login = false;
            config.launch_at_login_background = false;
        }
        Self {
            enabled: AtomicBool::new(config.enabled),
            continue_high_cost: AtomicBool::new(config.continue_high_cost),
            launch_at_login: AtomicBool::new(config.launch_at_login),
            launch_at_login_background: AtomicBool::new(config.launch_at_login_background),
            login_backgrounded: AtomicBool::new(login_background_requested()),
            backgrounded: AtomicBool::new(false),
            high_cost_resume_at_ms: AtomicU64::new(0),
        }
    }

    fn config(&self) -> StartupEnhancementConfig {
        StartupEnhancementConfig {
            enabled: self.enabled.load(Ordering::Acquire),
            continue_high_cost: self.continue_high_cost.load(Ordering::Acquire),
            launch_at_login: self.launch_at_login.load(Ordering::Acquire),
            launch_at_login_background: self.launch_at_login_background.load(Ordering::Acquire),
        }
    }

    fn update(
        &self,
        app: &tauri::AppHandle,
        mut config: StartupEnhancementConfig,
    ) -> Result<(), String> {
        config.launch_at_login_background &= config.launch_at_login;
        if crate::profile::is_isolated() {
            config.launch_at_login = false;
            config.launch_at_login_background = false;
        }
        let current = self.config();
        if config.launch_at_login != current.launch_at_login
            || config.launch_at_login_background != current.launch_at_login_background
        {
            configure_launch_at_login(app, config)?;
        }
        save_config(config)?;
        self.enabled.store(config.enabled, Ordering::Release);
        self.continue_high_cost
            .store(config.continue_high_cost, Ordering::Release);
        self.launch_at_login
            .store(config.launch_at_login, Ordering::Release);
        self.launch_at_login_background
            .store(config.launch_at_login_background, Ordering::Release);
        Ok(())
    }

    fn status(&self) -> StartupEnhancementStatus {
        let config = self.config();
        StartupEnhancementStatus {
            enabled: config.enabled,
            continue_high_cost: config.continue_high_cost,
            launch_at_login: config.launch_at_login,
            launch_at_login_available: cfg!(any(target_os = "windows", target_os = "macos"))
                && !crate::profile::is_isolated(),
            launch_at_login_background: config.launch_at_login_background,
            launch_at_login_background_available: cfg!(any(
                target_os = "windows",
                target_os = "macos"
            )) && !crate::profile::is_isolated(),
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
fn configure_launch_at_login(
    _app: &tauri::AppHandle,
    config: StartupEnhancementConfig,
) -> Result<(), String> {
    let enabled = config.launch_at_login;
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
    let background_argument = config
        .launch_at_login_background
        .then_some(LOGIN_BACKGROUND_ARGUMENT)
        .unwrap_or("");
    let command_line = format!("\"{}\" {background_argument}", executable.display());
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

#[cfg(target_os = "macos")]
const MACOS_LAUNCH_AGENT_FILE: &str = "com.kunpeng.reader.plist";
const LOGIN_BACKGROUND_ARGUMENT: &str = "--kunpeng-login-background";

#[cfg(target_os = "macos")]
fn macos_launch_agent_path() -> Result<PathBuf, String> {
    if crate::profile::is_isolated() {
        return Err("隔离配置禁止注册登录后台任务".into());
    }
    let home = dirs::home_dir().ok_or("无法确定当前用户主目录")?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(MACOS_LAUNCH_AGENT_FILE))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_plist(
    executable: &std::path::Path,
    launch_in_background: bool,
) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or("应用程序路径不是有效 UTF-8，无法设置开机自启")?;
    let executable = xml_escape(executable);
    let background_argument = if launch_in_background {
        format!("    <string>{LOGIN_BACKGROUND_ARGUMENT}</string>\n")
    } else {
        String::new()
    };
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kunpeng.reader</string>
  <key>ProgramArguments</key>
  <array>
    <string>{executable}</string>
{background_argument}  </array>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
"#
    ))
}

#[cfg(target_os = "macos")]
fn configure_launch_at_login(
    _app: &tauri::AppHandle,
    config: StartupEnhancementConfig,
) -> Result<(), String> {
    let enabled = config.launch_at_login;
    let path = macos_launch_agent_path()?;
    if !enabled {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("关闭开机自启失败：{error}")),
        };
    }

    let executable =
        std::env::current_exe().map_err(|error| format!("无法确定当前程序路径：{error}"))?;
    let plist = macos_launch_agent_plist(&executable, config.launch_at_login_background)?;
    atomic_file::write(&path, plist.as_bytes())
        .map_err(|error| format!("开启开机自启失败：{error}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn configure_launch_at_login(
    _app: &tauri::AppHandle,
    _config: StartupEnhancementConfig,
) -> Result<(), String> {
    Err("当前平台暂不支持开机自启设置".to_string())
}

fn login_background_requested() -> bool {
    std::env::args().any(|argument| argument == LOGIN_BACKGROUND_ARGUMENT)
}

pub(crate) fn should_start_login_background(app: &tauri::AppHandle) -> bool {
    if crate::profile::is_isolated() {
        return false;
    }
    app.state::<StartupEnhancementState>()
        .login_backgrounded
        .load(Ordering::Acquire)
}

pub(crate) fn begin_login_background(app: &tauri::AppHandle) {
    if !should_start_login_background(app) {
        return;
    }
    background_main(app);
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

fn config_path() -> Option<PathBuf> {
    let mut path = crate::profile::app_config_dir()?;
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
    app: tauri::AppHandle,
    state: tauri::State<StartupEnhancementState>,
    request: StartupEnhancementConfig,
) -> Result<StartupEnhancementStatus, String> {
    state.update(&app, request)?;
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

/// The single native path that turns a hidden main window back into the
/// foreground application. Cold-start first paint, Dock/Finder reopen and warm
/// activation all use this instead of competing `show` calls.
pub(crate) fn reveal_main(app: &tauri::AppHandle) -> Result<(), String> {
    if should_start_login_background(app) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| error.to_string())?;
    let Some(main) = app.get_webview_window("main") else {
        return Ok(());
    };
    main.set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.unminimize().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())
}

pub(crate) fn activate_main(app: &tauri::AppHandle, requested_at_ms: u64) {
    let enhancement = app.state::<StartupEnhancementState>();
    enhancement
        .login_backgrounded
        .store(false, Ordering::Release);
    enhancement.backgrounded.store(false, Ordering::Release);
    let resume_at_ms = enhancement.begin_hot_activation_grace(crate::now_ms());
    let _ = reveal_main(app);
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
            launch_at_login_background: true,
        };
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::json!({"enabled": true, "continueHighCost": true, "launchAtLogin": true, "launchAtLoginBackground": true})
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_plist_uses_the_current_executable_as_its_only_argument() {
        let plist = macos_launch_agent_plist(
            std::path::Path::new("/Applications/鲲鹏 & 阅读器.app/Contents/MacOS/鲲鹏阅读器"),
            true,
        )
        .unwrap();
        assert!(plist.contains("<string>com.kunpeng.reader</string>"));
        assert!(plist.contains(
            "<string>/Applications/鲲鹏 &amp; 阅读器.app/Contents/MacOS/鲲鹏阅读器</string>"
        ));
        assert!(plist.contains("<string>--kunpeng-login-background</string>"));
        assert_eq!(plist.matches("</array>").count(), 1);
        assert!(plist.contains("<false/>"));
    }

    #[test]
    fn hot_activation_grace_defers_high_cost_work_only_until_its_deadline() {
        let state = StartupEnhancementState {
            enabled: AtomicBool::new(true),
            continue_high_cost: AtomicBool::new(false),
            launch_at_login: AtomicBool::new(false),
            launch_at_login_background: AtomicBool::new(false),
            login_backgrounded: AtomicBool::new(false),
            backgrounded: AtomicBool::new(false),
            high_cost_resume_at_ms: AtomicU64::new(110),
        };
        assert!(!state.background_work_allowed_at(109));
        assert!(state.background_work_allowed_at(110));
    }
}
