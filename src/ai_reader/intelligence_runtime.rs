use serde::Serialize;
use std::{path::PathBuf, process::Command};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceRuntimeSwitchResult {
    pub(crate) phase: String,
    pub(crate) action: String,
    pub(crate) detail: String,
}

fn runtime_action(phase: &str) -> Result<&'static str, String> {
    match phase.trim().to_ascii_lowercase().as_str() {
        "triage" | "triagegpu" => Ok("TriageGpu"),
        "editorial" | "editorialgpu" => Ok("EditorialGpu"),
        "core" | "coreonly" => Ok("CoreOnly"),
        _ => Err("Unsupported intelligence runtime phase.".to_string()),
    }
}

fn runtime_script_path() -> Result<PathBuf, String> {
    let mut starts = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        for ancestor in start.ancestors().take(6) {
            let candidate = ancestor
                .join("scripts")
                .join("local-intelligence-runtime.ps1");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("The fixed local intelligence runtime controller was not found.".to_string())
}

#[cfg(windows)]
fn switch_runtime_blocking(
    phase: String,
    action: String,
) -> Result<IntelligenceRuntimeSwitchResult, String> {
    let script = runtime_script_path()?;
    let mut last_error = None;
    let mut output = None;
    for shell in ["pwsh.exe", "powershell.exe"] {
        let mut command = Command::new(shell);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .args(["-Action", &action])
            .creation_flags(CREATE_NO_WINDOW);
        match command.output() {
            Ok(value) => {
                output = Some(value);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => last_error = Some(error),
            Err(error) => {
                return Err(format!(
                    "Unable to start the local intelligence runtime controller: {error}"
                ));
            }
        }
    }
    let output = output.ok_or_else(|| {
        format!(
            "Unable to find PowerShell 7 or Windows PowerShell: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no shell candidate was attempted".to_string())
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "Local intelligence runtime switch to {action} failed: {detail}"
        ));
    }
    Ok(IntelligenceRuntimeSwitchResult {
        phase,
        action,
        detail: stdout,
    })
}

#[cfg(not(windows))]
fn switch_runtime_blocking(
    _phase: String,
    _action: String,
) -> Result<IntelligenceRuntimeSwitchResult, String> {
    Err(
        "Automatic local intelligence runtime switching is currently available on Windows only."
            .to_string(),
    )
}

pub(crate) async fn switch_runtime(
    phase: String,
) -> Result<IntelligenceRuntimeSwitchResult, String> {
    let action = runtime_action(&phase)?.to_string();
    if action == "EditorialGpu" {
        // Repeat the 16 GB-class hardware gate at the native phase boundary.
        // The launcher performs a second, post-teardown free-VRAM check after
        // the 8B judge has released the selected GPU.
        super::profiles::validate_intelligence_qwen_27b_hardware()?;
    }
    tokio::task::spawn_blocking(move || switch_runtime_blocking(phase, action))
        .await
        .map_err(|error| format!("The local intelligence runtime switch task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_phase_mapping_is_closed() {
        assert_eq!(runtime_action("triage").unwrap(), "TriageGpu");
        assert_eq!(runtime_action("EditorialGpu").unwrap(), "EditorialGpu");
        assert_eq!(
            runtime_action("core-only").unwrap_err(),
            "Unsupported intelligence runtime phase."
        );
    }

    #[test]
    fn runtime_controller_is_repo_fixed() {
        let path = runtime_script_path().unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("local-intelligence-runtime.ps1")
        );
    }
}
