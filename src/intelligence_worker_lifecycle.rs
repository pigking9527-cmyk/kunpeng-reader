//! Local lifecycle boundary for the Windows intelligence publisher worker.
//!
//! Pairing never places capability credentials in a command line, environment
//! variable, log line, WebView response or the Windows Run registry value.
//! The only persisted record contains DPAPI-protected blobs.  The headless
//! worker opens that record for itself on every service-loop pass, so a local
//! revoke takes effect without trusting a still-running reader window.

use crate::{atomic_file, profile};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "intelligence-worker-v1.json";
const CONFIG_SCHEMA_VERSION: u8 = 1;
const MAX_BASE_URL_BYTES: usize = 2048;
const MAX_CREDENTIAL_BYTES: usize = 4096;

#[cfg(windows)]
const WINDOWS_RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const WINDOWS_RUN_VALUE: &str = "KunpengReaderIntelligenceWorker";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredWorkerConfiguration {
    schema_version: u8,
    enabled: bool,
    launch_at_login: bool,
    base_url: String,
    protected_publish_credential: String,
    protected_relay_credential: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntelligenceWorkerPairingRequest {
    pub(crate) base_url: String,
    pub(crate) publish_credential: String,
    pub(crate) relay_credential: String,
    #[serde(default = "default_launch_at_login")]
    pub(crate) launch_at_login: bool,
}

const fn default_launch_at_login() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntelligenceWorkerCredentialRevokeRequest {
    /// `publish`, `relay`, or `all`.  This deliberately describes a local
    /// revocation: the server continues enforcing its own `revoked_at` gate.
    pub(crate) capability: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceWorkerLifecycleStatus {
    paired: bool,
    enabled: bool,
    launch_at_login: bool,
    publish_credential_present: bool,
    relay_credential_present: bool,
    worker_binary_available: bool,
}

/// Secret-bearing projection for the headless process only.  It is not
/// serializable and must not cross a Tauri command boundary.
#[derive(Clone, Debug)]
pub(crate) struct WorkerRuntimeCredentials {
    pub(crate) base_url: String,
    pub(crate) publish_credential: Option<String>,
    pub(crate) relay_credential: Option<String>,
}

/// Process-lifetime guard used only by the headless `--service-loop` sidecar.
/// A login Run entry and a reader-started worker can race; Windows owns this
/// kernel mutex and releases it automatically if the process crashes.
pub(crate) struct WorkerServiceLoopGuard {
    #[cfg(windows)]
    handle: *mut core::ffi::c_void,
}

#[cfg(windows)]
impl Drop for WorkerServiceLoopGuard {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        }
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// `Ok(None)` means another service-loop process is already active.  This is
/// deliberately separate from the reader application's single-instance
/// mutex: hiding or closing the reader must not stop the worker.
pub(crate) fn acquire_service_loop_guard() -> Result<Option<WorkerServiceLoopGuard>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        type Handle = *mut core::ffi::c_void;
        const ERROR_ALREADY_EXISTS: u32 = 183;
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(
                attributes: *const core::ffi::c_void,
                initial_owner: i32,
                name: *const u16,
            ) -> Handle;
            fn GetLastError() -> u32;
            fn CloseHandle(handle: Handle) -> i32;
        }
        let scope = profile::instance_scope_key();
        let name = if scope == "global" {
            "Local\\KunpengReaderIntelligenceWorkerV1".to_owned()
        } else {
            format!("Local\\KunpengReaderIntelligenceWorkerV1-{scope}")
        };
        let name = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("无法初始化情报后台 worker 单实例保护".into());
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Ok(None);
        }
        return Ok(Some(WorkerServiceLoopGuard { handle }));
    }
    #[cfg(not(windows))]
    Ok(Some(WorkerServiceLoopGuard {}))
}

fn config_path() -> Result<PathBuf, String> {
    let directory = profile::app_config_dir().ok_or("无法定位情报 worker 配置目录")?;
    Ok(directory.join(CONFIG_FILE))
}

fn valid_base_url(value: &str) -> bool {
    let value = value.trim().trim_end_matches('/');
    value.starts_with("https://")
        && value.len() <= MAX_BASE_URL_BYTES
        && value.is_ascii()
        && value[8..].contains('.')
        && !value.contains('@')
        && !value.contains('?')
        && !value.contains('#')
        && !value.chars().any(char::is_whitespace)
}

fn valid_credential(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_CREDENTIAL_BYTES
        && !value.chars().any(char::is_whitespace)
        && value.is_ascii()
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    valid_base_url(value)
        .then(|| value.to_owned())
        .ok_or("情报发布服务器必须是有效的 HTTPS 地址".to_string())
}

fn read_configuration_at(path: &Path) -> Result<Option<StoredWorkerConfiguration>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本机情报 worker 配置".into()),
    };
    let value: StoredWorkerConfiguration =
        serde_json::from_slice(&bytes).map_err(|_| "本机情报 worker 配置已损坏".to_string())?;
    if value.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_base_url(&value.base_url)
        || (!value.protected_publish_credential.is_empty()
            && !crate::secret_store::is_sync_secret_protected(&value.protected_publish_credential))
        || (!value.protected_relay_credential.is_empty()
            && !crate::secret_store::is_sync_secret_protected(&value.protected_relay_credential))
    {
        return Err("本机情报 worker 配置无效".into());
    }
    Ok(Some(value))
}

fn write_configuration_at(path: &Path, value: &StoredWorkerConfiguration) -> Result<(), String> {
    let parent = path.parent().ok_or("本机情报 worker 配置路径无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建本机情报 worker 配置目录")?;
    atomic_file::write_json(path, value, true).map_err(|_| "无法保存本机情报 worker 配置".into())
}

fn status_for(
    configuration: Option<&StoredWorkerConfiguration>,
) -> IntelligenceWorkerLifecycleStatus {
    let publish = configuration.is_some_and(|value| !value.protected_publish_credential.is_empty());
    let relay = configuration.is_some_and(|value| !value.protected_relay_credential.is_empty());
    IntelligenceWorkerLifecycleStatus {
        paired: publish || relay,
        enabled: configuration.is_some_and(|value| value.enabled && (publish || relay)),
        launch_at_login: configuration.is_some_and(|value| value.launch_at_login),
        publish_credential_present: publish,
        relay_credential_present: relay,
        worker_binary_available: worker_binary_path().is_ok_and(|path| path.is_file()),
    }
}

pub(crate) fn lifecycle_status() -> Result<IntelligenceWorkerLifecycleStatus, String> {
    read_configuration_at(&config_path()?).map(|value| status_for(value.as_ref()))
}

/// Available only to the worker process.  Callers receive a fixed error rather
/// than a platform or decryption detail, so an accidental stderr capture can
/// never include a protected-credential implementation detail.
pub(crate) fn runtime_credentials() -> Result<Option<WorkerRuntimeCredentials>, String> {
    let Some(value) = read_configuration_at(&config_path()?)? else {
        return Ok(None);
    };
    runtime_credentials_for(value)
}

fn runtime_credentials_for(
    value: StoredWorkerConfiguration,
) -> Result<Option<WorkerRuntimeCredentials>, String> {
    if !value.enabled {
        return Ok(None);
    }
    let publish_credential = if value.protected_publish_credential.is_empty() {
        None
    } else {
        let credential = crate::secret_store::unprotect_secret(&value.protected_publish_credential)
            .map_err(|_| "无法读取情报 worker 凭据".to_string())?;
        valid_credential(&credential)
            .then_some(credential)
            .ok_or("本机情报 worker 凭据无效")
            .map(Some)?
    };
    let relay_credential = if value.protected_relay_credential.is_empty() {
        None
    } else {
        let credential = crate::secret_store::unprotect_secret(&value.protected_relay_credential)
            .map_err(|_| "无法读取情报 worker 凭据".to_string())?;
        valid_credential(&credential)
            .then_some(credential)
            .ok_or("本机情报 worker 凭据无效")
            .map(Some)?
    };
    if publish_credential.is_none() && relay_credential.is_none() {
        return Ok(None);
    }
    Ok(Some(WorkerRuntimeCredentials {
        base_url: normalize_base_url(&value.base_url)?,
        publish_credential,
        relay_credential,
    }))
}

#[cfg(windows)]
fn worker_binary_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|_| "无法定位阅读器安装目录")?;
    let directory = current.parent().ok_or("阅读器安装目录无效")?;
    let file = "kunpeng-intelligence-worker.exe";
    // Fast local delivery keeps companions beside the reader executable;
    // NSIS places declared bundle resources under `resources`.  Probe only
    // these two installation-owned locations, never PATH or the working dir.
    [directory.join(file), directory.join("resources").join(file)]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("情报后台 worker 未随当前安装提供".into())
}

#[cfg(not(windows))]
fn worker_binary_path() -> Result<PathBuf, String> {
    Err("情报 worker 登录启动目前仅支持 Windows".into())
}

#[cfg(windows)]
fn windows_registry_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn configure_login_startup(worker: &Path, enabled: bool) -> Result<(), String> {
    if profile::is_isolated() {
        // An isolated fixture must never replace the real user's Run entry.
        // It is intentionally a one-shot/process-local test boundary.
        return (!enabled)
            .then_some(())
            .ok_or("隔离情报配置不支持登录启动".into());
    }
    if !enabled {
        let _ = windows_registry_command()
            .args(["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"])
            .output();
        return Ok(());
    }
    if !worker.is_file() {
        return Err("情报后台 worker 未随当前安装提供，无法设置登录启动".into());
    }
    let profile_args = crate::profile::child_profile_args()
        .into_iter()
        .map(|value| format!("\"{}\"", value.to_string_lossy().replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ");
    let command_line =
        format!("\"{}\" {} --service-loop", worker.display(), profile_args).replace("  ", " ");
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
        .map_err(|_| "无法设置情报后台登录启动".to_string())?;
    output
        .status
        .success()
        .then_some(())
        .ok_or("无法设置情报后台登录启动".into())
}

#[cfg(not(windows))]
fn configure_login_startup(_worker: &Path, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn spawn_worker(worker: &Path) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::Stdio};
    std::process::Command::new(worker)
        .args(crate::profile::child_profile_args())
        .arg("--service-loop")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法启动情报后台 worker".into())
}

#[cfg(not(windows))]
fn spawn_worker(_worker: &Path) -> Result<(), String> {
    Ok(())
}

/// Start only after a verified local pairing has been persisted.  The sidecar
/// receives no secret argument or environment variable; it must decrypt the
/// local record itself.  A worker-side single-instance guard owns duplicate
/// suppression, because a Windows login launch may race the reader launch.
pub(crate) fn spawn_configured_worker() -> Result<(), String> {
    let Some(configuration) = read_configuration_at(&config_path()?)? else {
        return Ok(());
    };
    if !configuration.enabled
        || (configuration.protected_publish_credential.is_empty()
            && configuration.protected_relay_credential.is_empty())
    {
        return Ok(());
    }
    let worker = worker_binary_path()?;
    spawn_worker(&worker)
}

#[tauri::command]
pub(crate) fn intelligence_worker_lifecycle_status(
) -> Result<IntelligenceWorkerLifecycleStatus, String> {
    lifecycle_status()
}

/// Explicit post-login pairing command.  It accepts capability credentials
/// only as an inbound native request, stores DPAPI blobs, and returns a status
/// projection with no secret, URL, account ID, file path or process ID.
/// Persist a pairing only after the desktop command has already proved that
/// `connection_base_url` belongs to the authenticated account.  Keeping the
/// Tauri/sync wrapper outside this module is intentional: the exact same
/// credential reader is compiled into the headless sidecar, without pulling
/// a WebView command boundary into that executable.
pub(crate) fn pair_intelligence_worker_for_connection(
    connection_base_url: &str,
    request: IntelligenceWorkerPairingRequest,
) -> Result<IntelligenceWorkerLifecycleStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (connection_base_url, request);
        return Err("情报后台 worker 配对目前仅支持 Windows".into());
    }
    #[cfg(windows)]
    {
        pair_intelligence_worker(request, Some(connection_base_url))
    }
}

/// Pair a dedicated local processing host from its own loopback-only operator
/// page.  Unlike the reader command, this page has no reader account session
/// to compare against; it is deliberately a separate local administrator
/// surface.  It still accepts credentials only in this process, persists only
/// DPAPI blobs, and is never exposed on a LAN address.
pub(crate) fn pair_intelligence_worker_for_local_operator(
    request: IntelligenceWorkerPairingRequest,
) -> Result<IntelligenceWorkerLifecycleStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = request;
        return Err("情报后台 worker 配对目前仅支持 Windows".into());
    }
    #[cfg(windows)]
    {
        pair_intelligence_worker(request, None)
    }
}

#[cfg(windows)]
fn pair_intelligence_worker(
    request: IntelligenceWorkerPairingRequest,
    expected_base_url: Option<&str>,
) -> Result<IntelligenceWorkerLifecycleStatus, String> {
    if crate::profile::is_isolated() && request.launch_at_login {
        return Err("隔离情报配置不支持登录启动".into());
    }
    let base_url = normalize_base_url(&request.base_url)?;
    if let Some(expected_base_url) = expected_base_url {
        if normalize_base_url(expected_base_url)? != base_url {
            return Err("情报配对服务器必须与当前登录账户一致".into());
        }
    }
    if !valid_credential(&request.publish_credential)
        || !valid_credential(&request.relay_credential)
    {
        return Err("情报发布凭据格式无效".into());
    }
    let worker = worker_binary_path()?;
    if !worker.is_file() {
        return Err("情报后台 worker 未随当前安装提供，无法完成配对".into());
    }
    let configuration = StoredWorkerConfiguration {
        schema_version: CONFIG_SCHEMA_VERSION,
        enabled: true,
        launch_at_login: request.launch_at_login,
        base_url,
        protected_publish_credential: crate::secret_store::protect_secret(
            request.publish_credential.trim(),
        )?,
        protected_relay_credential: crate::secret_store::protect_secret(
            request.relay_credential.trim(),
        )?,
    };
    let path = config_path()?;
    write_configuration_at(&path, &configuration)?;
    if let Err(error) = configure_login_startup(&worker, configuration.launch_at_login) {
        // Do not leave a credential enabled when the requested durability
        // guarantee could not be installed.
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    spawn_worker(&worker)?;
    Ok(status_for(Some(&configuration)))
}

fn apply_local_credential_revoke(
    configuration: &mut StoredWorkerConfiguration,
    capability: &str,
) -> Result<(), String> {
    match capability.trim() {
        "publish" => configuration.protected_publish_credential.clear(),
        "relay" => configuration.protected_relay_credential.clear(),
        "all" => {
            configuration.protected_publish_credential.clear();
            configuration.protected_relay_credential.clear();
        }
        _ => return Err("只能撤销 publish、relay 或 all 情报 worker 凭据".into()),
    }
    configuration.enabled = !configuration.protected_publish_credential.is_empty()
        || !configuration.protected_relay_credential.is_empty();
    if !configuration.enabled {
        configuration.launch_at_login = false;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn revoke_intelligence_worker_credential(
    request: IntelligenceWorkerCredentialRevokeRequest,
) -> Result<IntelligenceWorkerLifecycleStatus, String> {
    let path = config_path()?;
    let Some(mut configuration) = read_configuration_at(&path)? else {
        return Ok(status_for(None));
    };
    apply_local_credential_revoke(&mut configuration, &request.capability)?;
    if configuration.enabled {
        write_configuration_at(&path, &configuration)?;
        // Revocation must remain possible even if an installation repair has
        // removed the sidecar.  The worker re-reads this record, so persisting
        // the reduced capability set is the security boundary; a missing Run
        // update can only prevent a future launch, never restore a token.
        if let Ok(worker) = worker_binary_path() {
            let _ = configure_login_startup(&worker, configuration.launch_at_login);
        }
    } else {
        // On Windows each credential is self-contained DPAPI ciphertext; the
        // only persistent reference is this record, so deleting it revokes
        // local access without touching any unrelated credential slot.
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法移除已撤销的情报 worker 凭据".into()),
        }
        let worker = worker_binary_path().unwrap_or_default();
        configure_login_startup(&worker, false)?;
    }
    lifecycle_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_configuration() -> StoredWorkerConfiguration {
        StoredWorkerConfiguration {
            schema_version: CONFIG_SCHEMA_VERSION,
            enabled: true,
            launch_at_login: true,
            base_url: "https://intelligence.example.test".into(),
            protected_publish_credential: "test:cHVibGlzaA==".into(),
            protected_relay_credential: "test:cmVsYXk=".into(),
        }
    }

    #[test]
    fn paired_configuration_never_serializes_plaintext_credentials() {
        let root =
            std::env::temp_dir().join(format!("kunpeng-worker-lifecycle-{}", uuid::Uuid::new_v4()));
        let path = root.join(CONFIG_FILE);
        let configuration = test_configuration();
        write_configuration_at(&path, &configuration).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("publish\""));
        assert!(!text.contains("relay\""));
        assert!(text.contains("protectedPublishCredential"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_plaintext_configuration_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-worker-lifecycle-invalid-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(CONFIG_FILE);
        let mut configuration = test_configuration();
        configuration.protected_relay_credential = "plaintext-token".into();
        atomic_file::write_json(&path, &configuration, true).unwrap();
        assert!(read_configuration_at(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lifecycle_status_is_secret_free_and_capability_scoped() {
        let configuration = test_configuration();
        let status = status_for(Some(&configuration));
        let json = serde_json::to_string(&status).unwrap();
        assert!(
            status.paired && status.publish_credential_present && status.relay_credential_present
        );
        assert!(!json.contains("publish\""));
        assert!(!json.contains("relay\""));
        assert!(!json.contains("https://"));
    }

    #[test]
    fn runtime_credentials_are_available_only_to_the_headless_projection() {
        let runtime = runtime_credentials_for(test_configuration())
            .unwrap()
            .unwrap();
        assert_eq!(runtime.base_url, "https://intelligence.example.test");
        assert_eq!(runtime.publish_credential.as_deref(), Some("publish"));
        assert_eq!(runtime.relay_credential.as_deref(), Some("relay"));
        // The public status type intentionally cannot carry these fields.
        let public = serde_json::to_string(&status_for(Some(&test_configuration()))).unwrap();
        assert!(!public.contains("\"publish\""));
        assert!(!public.contains("\"relay\""));
    }

    #[test]
    fn only_safe_https_endpoint_and_ascii_nonblank_credentials_are_accepted() {
        assert!(valid_base_url("https://intelligence.example.test"));
        assert!(!valid_base_url("http://intelligence.example.test"));
        assert!(!valid_base_url("https://token@example.test"));
        assert!(valid_credential("abc.DEF_123"));
        assert!(!valid_credential("secret with whitespace"));
        assert!(!valid_credential("秘密"));
    }

    #[test]
    fn local_revoke_removes_only_the_requested_capability() {
        let mut configuration = test_configuration();
        apply_local_credential_revoke(&mut configuration, "publish").unwrap();
        assert!(configuration.protected_publish_credential.is_empty());
        assert!(!configuration.protected_relay_credential.is_empty());
        assert!(configuration.enabled);
        apply_local_credential_revoke(&mut configuration, "all").unwrap();
        assert!(!configuration.enabled);
        assert!(!configuration.launch_at_login);
    }
}
