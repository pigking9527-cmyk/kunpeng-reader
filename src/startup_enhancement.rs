//! Optional Edge-style warm activation without a tray icon.

use crate::{atomic_file, emit_startup_perf, log, AppState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartupEnhancementConfig {
    pub(crate) enabled: bool,
    pub(crate) continue_high_cost: bool,
}

pub(crate) struct StartupEnhancementState {
    enabled: AtomicBool,
    continue_high_cost: AtomicBool,
    backgrounded: AtomicBool,
}

impl StartupEnhancementState {
    pub(crate) fn load() -> Self {
        let config = load_config().unwrap_or_default();
        Self {
            enabled: AtomicBool::new(config.enabled),
            continue_high_cost: AtomicBool::new(config.continue_high_cost),
            backgrounded: AtomicBool::new(false),
        }
    }

    fn config(&self) -> StartupEnhancementConfig {
        StartupEnhancementConfig {
            enabled: self.enabled.load(Ordering::Acquire),
            continue_high_cost: self.continue_high_cost.load(Ordering::Acquire),
        }
    }

    fn update(&self, config: StartupEnhancementConfig) -> Result<(), String> {
        save_config(config)?;
        self.enabled.store(config.enabled, Ordering::Release);
        self.continue_high_cost
            .store(config.continue_high_cost, Ordering::Release);
        Ok(())
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub(crate) fn background_work_allowed(&self) -> bool {
        !self.backgrounded.load(Ordering::Acquire)
            || self.continue_high_cost.load(Ordering::Acquire)
    }
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
}

fn emit_background_state(app: &tauri::AppHandle, backgrounded: bool, continue_high_cost: bool) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "startup-enhancement-state",
            BackgroundStatePayload {
                backgrounded,
                continue_high_cost,
            },
        );
    }
}

#[tauri::command]
pub(crate) fn startup_enhancement_config(
    state: tauri::State<StartupEnhancementState>,
) -> StartupEnhancementConfig {
    state.config()
}

#[tauri::command]
pub(crate) fn set_startup_enhancement_config(
    state: tauri::State<StartupEnhancementState>,
    request: StartupEnhancementConfig,
) -> Result<(), String> {
    state.update(request)
}

pub(crate) fn should_keep_running(app: &tauri::AppHandle) -> bool {
    app.state::<StartupEnhancementState>().enabled()
}

pub(crate) fn background_main(app: &tauri::AppHandle) {
    let enhancement = app.state::<StartupEnhancementState>();
    let config = enhancement.config();
    enhancement.backgrounded.store(true, Ordering::Release);

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
    emit_background_state(app, true, config.continue_high_cost);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_skip_taskbar(true);
        let _ = main.hide();
    }
}

pub(crate) fn activate_main(app: &tauri::AppHandle, requested_at_ms: u64) {
    let enhancement = app.state::<StartupEnhancementState>();
    enhancement.backgrounded.store(false, Ordering::Release);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_skip_taskbar(false);
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    emit_background_state(app, false, enhancement.config().continue_high_cost);
    let elapsed = crate::now_ms().saturating_sub(requested_at_ms);
    emit_startup_perf(
        app,
        "startup-enhancement",
        "activated",
        format!("{elapsed}ms hot activation"),
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
        };
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::json!({"enabled": true, "continueHighCost": true})
        );
    }
}
