//! Optional Edge-style warm activation without a tray icon.

use crate::{atomic_file, emit_startup_perf, log, AppState};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
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
    visibility_epoch: AtomicU64,
    high_cost_resume_at_ms: AtomicU64,
}

#[derive(Clone, Copy)]
struct BackgroundTransition {
    visibility_epoch: u64,
    config: StartupEnhancementConfig,
}

/// The main window can be temporarily absent from Tauri's label lookup while
/// hidden on Windows. Retain the native handle created during setup so close
/// to background and single-instance activation always address the same
/// window instead of relying on that transient lookup.
#[derive(Default)]
pub(crate) struct MainWindowRuntime {
    window: Mutex<Option<tauri::Window>>,
}

impl MainWindowRuntime {
    pub(crate) fn retain(&self, window: tauri::Window) {
        *self.window.lock().unwrap() = Some(window);
    }

    fn window(&self) -> Option<tauri::Window> {
        self.window.lock().unwrap().clone()
    }
}

pub(crate) fn retain_main_window(app: &tauri::AppHandle, window: tauri::Window) {
    app.state::<MainWindowRuntime>().retain(window);
}

fn main_window(app: &tauri::AppHandle) -> Option<tauri::Window> {
    app.state::<MainWindowRuntime>()
        .window()
        .or_else(|| app.get_window("main"))
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
            visibility_epoch: AtomicU64::new(0),
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

    fn begin_background(&self) -> BackgroundTransition {
        let config = self.config();
        let visibility_epoch = self.visibility_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.backgrounded.store(true, Ordering::Release);
        self.high_cost_resume_at_ms.store(0, Ordering::Release);
        BackgroundTransition {
            visibility_epoch,
            config,
        }
    }

    fn activate_window(&self) -> u64 {
        let visibility_epoch = self.visibility_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.login_backgrounded.store(false, Ordering::Release);
        self.backgrounded.store(false, Ordering::Release);
        visibility_epoch
    }

    fn background_is_current(&self, transition: BackgroundTransition) -> bool {
        self.visibility_epoch.load(Ordering::Acquire) == transition.visibility_epoch
            && self.backgrounded.load(Ordering::Acquire)
    }

    fn activation_is_current(&self, visibility_epoch: u64) -> bool {
        self.visibility_epoch.load(Ordering::Acquire) == visibility_epoch
            && !self.backgrounded.load(Ordering::Acquire)
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
#[allow(clippy::obfuscated_if_else)]
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
    if let Some(main) = main_window(app) {
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

fn should_destroy_reader_shell_on_main_background(is_bound_reader: bool) -> bool {
    !is_bound_reader
}

fn finish_background_main(
    app: &tauri::AppHandle,
    enhancement: &StartupEnhancementState,
    transition: BackgroundTransition,
    hide_main: bool,
) {
    if !enhancement.background_is_current(transition) {
        return;
    }

    for (label, reader) in app.webview_windows() {
        if !enhancement.background_is_current(transition) {
            return;
        }
        if label.starts_with("reader-")
            && should_destroy_reader_shell_on_main_background(
                crate::window_commands::reader_window_id(&reader).is_some(),
            )
        {
            // A bound shell is the user's active reading page. Backgrounding
            // the shelf must not turn it into a close request; only an unused
            // preloaded shell is disposable here.
            let _ = reader.destroy();
        }
    }
    if !enhancement.background_is_current(transition) {
        return;
    }
    if !transition.config.continue_high_cost {
        let paused = app
            .state::<AppState>()
            .background_tasks
            .request_pause_high_cost();
        log(&format!(
            "[startup-enhancement] backgrounded paused_high_cost={paused}"
        ));
    }
    if !enhancement.background_is_current(transition) {
        return;
    }
    emit_background_state(app, true, transition.config.continue_high_cost, 0);
    if hide_main && enhancement.background_is_current(transition) {
        let Some(main) = main_window(app) else {
            return;
        };
        let _ = main.set_skip_taskbar(true);
        let _ = main.hide();
    }
}

pub(crate) fn background_main(app: &tauri::AppHandle) {
    let enhancement = app.state::<StartupEnhancementState>();
    let transition = enhancement.begin_background();
    finish_background_main(app, &enhancement, transition, true);
}

/// Backgrounds the injected main window. The transition starts before hide,
/// so a concurrent single-instance activation invalidates this stale hide
/// rather than letting a previous close win after the user reopens the app.
pub(crate) fn background_main_from_window(
    app: &tauri::AppHandle,
    window: &tauri::Window,
) -> Result<(), String> {
    let enhancement = app.state::<StartupEnhancementState>();
    let transition = enhancement.begin_background();
    let _ = window.set_skip_taskbar(true);
    window.hide().map_err(|error| error.to_string())?;
    finish_background_main(app, &enhancement, transition, false);
    Ok(())
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
    let Some(main) = main_window(app) else {
        return Err("主窗口不可用".to_string());
    };
    let _ = main.set_skip_taskbar(false);
    let _ = main.unminimize();
    main.show().map_err(|error| error.to_string())?;
    let _ = main.set_focus();
    Ok(())
}

fn complete_activation_on_main_thread(
    app: tauri::AppHandle,
    visibility_epoch: u64,
    requested_at_ms: u64,
    retry: bool,
) {
    let queued_app = app.clone();
    if app
        .run_on_main_thread(move || {
            let enhancement = queued_app.state::<StartupEnhancementState>();
            if !enhancement.activation_is_current(visibility_epoch) {
                return;
            }
            let resume_at_ms = enhancement.begin_hot_activation_grace(crate::now_ms());
            if reveal_main(&queued_app).is_err() {
                // Keep the activation trace privacy-safe: native errors can include
                // platform details, while this fixed marker is enough to distinguish
                // a delivered single-instance request from a failed window restore.
                log("[startup-enhancement] activation reveal_failed");
                if !retry {
                    let retry_app = queued_app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        complete_activation_on_main_thread(
                            retry_app,
                            visibility_epoch,
                            requested_at_ms,
                            true,
                        );
                    });
                }
                return;
            }
            crate::window_commands::schedule_clean_reader_shell(&queued_app);
            emit_background_state(
                &queued_app,
                false,
                enhancement.config().continue_high_cost,
                resume_at_ms,
            );
            let elapsed = crate::now_ms().saturating_sub(requested_at_ms);
            emit_startup_perf(
                &queued_app,
                "startup-enhancement",
                "activated",
                format!("{elapsed}ms hot activation; high-cost work delayed 15s"),
            );
        })
        .is_err()
    {
        log("[startup-enhancement] activation main_thread_dispatch_failed");
    }
}

pub(crate) fn activate_main(app: &tauri::AppHandle, requested_at_ms: u64) {
    let enhancement = app.state::<StartupEnhancementState>();
    let visibility_epoch = enhancement.activate_window();
    complete_activation_on_main_thread(app.clone(), visibility_epoch, requested_at_ms, false);
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

    #[test]
    fn backgrounding_the_main_window_keeps_the_bound_reader_open() {
        assert!(!should_destroy_reader_shell_on_main_background(true));
        assert!(should_destroy_reader_shell_on_main_background(false));
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
            visibility_epoch: AtomicU64::new(0),
            high_cost_resume_at_ms: AtomicU64::new(110),
        };
        assert!(!state.background_work_allowed_at(109));
        assert!(state.background_work_allowed_at(110));
    }

    #[test]
    fn later_activation_invalidates_an_inflight_background_transition() {
        let state = StartupEnhancementState {
            enabled: AtomicBool::new(true),
            continue_high_cost: AtomicBool::new(false),
            launch_at_login: AtomicBool::new(false),
            launch_at_login_background: AtomicBool::new(false),
            login_backgrounded: AtomicBool::new(false),
            backgrounded: AtomicBool::new(false),
            visibility_epoch: AtomicU64::new(0),
            high_cost_resume_at_ms: AtomicU64::new(0),
        };
        let background = state.begin_background();
        assert!(state.background_is_current(background));
        state.activate_window();
        assert!(!state.background_is_current(background));
    }
}
