//! Launch-profile boundary for the desktop process.
//!
//! The normal installation deliberately keeps using the historic `dirs` paths.
//! `--isolated-profile <absolute-dir>` is an opt-in macOS 14+ test boundary:
//! every application-owned persistent directory, process lock and WKWebView
//! data-store uses a fresh profile identity rooted below that directory.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const APP_DIRECTORY: &str = "ebook-reader";
const MARKER_FILE: &str = ".kunpeng-isolated-profile-v1.json";
const MARKER_VERSION: u8 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
enum LaunchProfile {
    Default,
    Isolated(IsolatedProfile),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct IsolatedProfile {
    root: PathBuf,
    identifier: [u8; 16],
}

#[derive(Deserialize, Serialize)]
struct Marker {
    version: u8,
    identifier_hex: String,
}

static PROFILE: OnceLock<LaunchProfile> = OnceLock::new();

/// Parse and validate the launch option once, before a database, instance lock
/// or native window can be created. Calling this a second time is an error so
/// no component can silently select a different storage boundary later.
pub(crate) fn initialize_from_process_args() -> Result<(), String> {
    let parsed = parse_args(std::env::args_os())?;
    PROFILE
        .set(parsed)
        .map_err(|_| "启动配置已初始化，拒绝重复选择隔离配置".to_string())
}

/// This deliberately happens before [`initialize_from_process_args`].  On an
/// unsupported OS the parser must not create the marker or any profile child.
pub(crate) fn preflight_process_args() -> Result<(), String> {
    let has_isolated_profile = std::env::args_os().any(|argument| argument == "--isolated-profile");
    if !has_isolated_profile {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        if macos_major_version()? >= 14 {
            Ok(())
        } else {
            Err("--isolated-profile 仅支持 macOS 14 及以上；未创建窗口或应用数据".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("--isolated-profile 仅支持 macOS 14 及以上；未创建窗口或应用数据".into())
    }
}

fn current() -> &'static LaunchProfile {
    PROFILE.get().unwrap_or(&LaunchProfile::Default)
}

pub(crate) fn is_isolated() -> bool {
    matches!(current(), LaunchProfile::Isolated(_))
}

pub(crate) fn app_config_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => config_base_dir().map(|directory| directory.join(APP_DIRECTORY)),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("config").join(APP_DIRECTORY)),
    }
}

pub(crate) fn app_cache_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => cache_base_dir().map(|directory| directory.join(APP_DIRECTORY)),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("cache").join(APP_DIRECTORY)),
    }
}

pub(crate) fn app_data_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => data_base_dir().map(|directory| directory.join(APP_DIRECTORY)),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("data").join(APP_DIRECTORY)),
    }
}

pub(crate) fn config_base_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => dirs::config_dir(),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("config")),
    }
}

pub(crate) fn cache_base_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => dirs::cache_dir(),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("cache")),
    }
}

pub(crate) fn data_base_dir() -> Option<PathBuf> {
    match current() {
        LaunchProfile::Default => dirs::data_local_dir(),
        LaunchProfile::Isolated(profile) => Some(profile.root.join("data")),
    }
}

pub(crate) fn instance_scope_key() -> String {
    instance_scope_key_for(current())
}

fn instance_scope_key_for(profile: &LaunchProfile) -> String {
    match profile {
        LaunchProfile::Default => "global".to_string(),
        LaunchProfile::Isolated(profile) => format!("isolated-{}", hex(&profile.identifier)),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
pub(crate) fn keychain_service() -> String {
    keychain_service_for(current())
}

#[cfg(all(target_os = "macos", not(test)))]
pub(crate) fn sync_token_keychain_service() -> String {
    sync_token_keychain_service_for(current(), 11)
}

/// The v2-v10 slots remain readable so an existing login is never discarded
/// merely because the credential storage format changed.  Fresh logins use
/// the current slot above, which lets them recover when an older macOS
/// Keychain item's ACL can no longer be read or updated.
#[cfg(all(target_os = "macos", not(test)))]
pub(crate) fn legacy_sync_token_keychain_service(version: u8) -> String {
    sync_token_keychain_service_for(current(), version)
}

#[cfg(any(all(target_os = "macos", not(test)), test))]
fn keychain_service_for(profile: &LaunchProfile) -> String {
    match profile {
        LaunchProfile::Default => "com.kunpeng.reader.sync".to_string(),
        LaunchProfile::Isolated(profile) => {
            format!(
                "com.kunpeng.reader.sync.isolated.{}",
                hex(&profile.identifier)
            )
        }
    }
}

#[cfg(any(all(target_os = "macos", not(test)), test))]
fn sync_token_keychain_service_for(profile: &LaunchProfile, version: u8) -> String {
    match profile {
        LaunchProfile::Default => format!("com.kunpeng.reader.sync-token.v{version}"),
        LaunchProfile::Isolated(profile) => {
            format!(
                "com.kunpeng.reader.sync-token.v{version}.isolated.{}",
                hex(&profile.identifier)
            )
        }
    }
}

/// The identifier must be passed to every WebView belonging to this process.
/// Tauri maps it to `WKWebsiteDataStore` on macOS 14+; it contains no user path.
#[cfg(target_os = "macos")]
pub(crate) fn webview_data_store_identifier() -> Option<[u8; 16]> {
    match current() {
        LaunchProfile::Default => None,
        LaunchProfile::Isolated(profile) => Some(profile.identifier),
    }
}

#[cfg(target_os = "macos")]
fn macos_major_version() -> Result<u64, String> {
    use std::process::Command;
    let output = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|_| "无法确认 macOS 版本；未创建窗口或应用数据".to_string())?;
    if !output.status.success() {
        return Err("无法确认 macOS 版本；未创建窗口或应用数据".into());
    }
    let version = String::from_utf8(output.stdout)
        .map_err(|_| "无法确认 macOS 版本；未创建窗口或应用数据".to_string())?;
    version
        .trim()
        .split('.')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "无法确认 macOS 版本；未创建窗口或应用数据".to_string())
}

fn parse_args(arguments: impl IntoIterator<Item = OsString>) -> Result<LaunchProfile, String> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let mut roots = Vec::new();
    let mut index = 1;
    while index < arguments.len() {
        if arguments[index] == "--isolated-profile" {
            let root = arguments
                .get(index + 1)
                .ok_or_else(|| "--isolated-profile 缺少绝对目录参数".to_string())?;
            roots.push(PathBuf::from(root));
            index += 2;
        } else {
            index += 1;
        }
    }
    match roots.len() {
        0 => Ok(LaunchProfile::Default),
        1 => prepare_isolated_profile(&roots[0]).map(LaunchProfile::Isolated),
        _ => Err("--isolated-profile 只能指定一次".into()),
    }
}

fn prepare_isolated_profile(root: &Path) -> Result<IsolatedProfile, String> {
    if !root.is_absolute() || root == Path::new("/") {
        return Err("--isolated-profile 必须是非根目录的绝对路径".into());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() {
            return Err("--isolated-profile 不接受符号链接目录".into());
        }
        if !metadata.is_dir() {
            return Err("--isolated-profile 必须指向目录".into());
        }
    } else {
        std::fs::create_dir_all(root).map_err(|error| format!("无法创建隔离配置目录：{error}"))?;
    }
    set_owner_only_permissions(root)?;
    let marker_path = root.join(MARKER_FILE);
    let identifier = match std::fs::read_to_string(&marker_path) {
        Ok(text) => {
            let marker: Marker = serde_json::from_str(&text)
                .map_err(|_| "隔离配置标记无效，拒绝使用该目录".to_string())?;
            if marker.version != MARKER_VERSION {
                return Err("隔离配置标记版本不受支持，拒绝使用该目录".into());
            }
            parse_identifier(&marker.identifier_hex)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if std::fs::read_dir(root)
                .map_err(|error| format!("无法读取隔离配置目录：{error}"))?
                .next()
                .is_some()
            {
                return Err("隔离配置目录非空且没有有效标记，拒绝使用".into());
            }
            let identifier = *uuid::Uuid::new_v4().as_bytes();
            let marker = Marker {
                version: MARKER_VERSION,
                identifier_hex: hex(&identifier),
            };
            let bytes = serde_json::to_vec(&marker).map_err(|error| error.to_string())?;
            crate::atomic_file::write(&marker_path, &bytes)?;
            identifier
        }
        Err(error) => return Err(format!("无法读取隔离配置标记：{error}")),
    };
    for child in ["config", "cache", "data"] {
        let directory = root.join(child);
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建隔离配置子目录：{error}"))?;
        set_owner_only_permissions(&directory)?;
    }
    Ok(IsolatedProfile {
        root: root.to_path_buf(),
        identifier,
    })
}

fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法设置隔离配置目录权限：{error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn parse_identifier(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("隔离配置标记标识无效，拒绝使用该目录".into());
    }
    let mut identifier = [0_u8; 16];
    for (index, byte) in identifier.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "隔离配置标记标识无效，拒绝使用该目录".to_string())?;
    }
    Ok(identifier)
}

fn hex(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_directory(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("kunpeng-profile-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn default_arguments_keep_the_default_profile() {
        assert_eq!(
            parse_args([OsString::from("reader")]).unwrap(),
            LaunchProfile::Default
        );
    }

    #[test]
    fn isolated_profile_creates_marked_owner_only_layout() {
        let root = fresh_directory("layout");
        let profile = prepare_isolated_profile(&root).unwrap();
        assert_eq!(profile.root, root);
        assert!(root.join(MARKER_FILE).is_file());
        for child in ["config", "cache", "data"] {
            assert!(root.join(child).is_dir());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_duplicate_relative_root_and_unmarked_nonempty_directories() {
        assert!(parse_args([
            OsString::from("reader"),
            OsString::from("--isolated-profile")
        ])
        .is_err());
        assert!(prepare_isolated_profile(Path::new("relative")).is_err());
        assert!(prepare_isolated_profile(Path::new("/")).is_err());
        let root = fresh_directory("nonempty");
        std::fs::write(root.join("unrelated"), b"x").unwrap();
        assert!(prepare_isolated_profile(&root).is_err());
        let repeated = vec![
            OsString::from("reader"),
            OsString::from("--isolated-profile"),
            root.clone().into_os_string(),
            OsString::from("--isolated-profile"),
            root.clone().into_os_string(),
        ];
        assert!(parse_args(repeated).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn marker_identity_is_stable_and_scopes_keychain_and_instance_without_path() {
        let root = fresh_directory("identity");
        let first = prepare_isolated_profile(&root).unwrap();
        let second = prepare_isolated_profile(&root).unwrap();
        assert_eq!(first.identifier, second.identifier);
        let id = hex(&first.identifier);
        let launch_profile = LaunchProfile::Isolated(first.clone());
        assert_eq!(
            instance_scope_key_for(&launch_profile),
            format!("isolated-{id}")
        );
        assert_eq!(
            keychain_service_for(&launch_profile),
            format!("com.kunpeng.reader.sync.isolated.{id}")
        );
        assert_eq!(
            sync_token_keychain_service_for(&launch_profile, 10),
            format!("com.kunpeng.reader.sync-token.v10.isolated.{id}")
        );
        assert_eq!(
            first.root.join("config").join(APP_DIRECTORY),
            root.join("config").join(APP_DIRECTORY)
        );
        assert!(!id.contains(&root.display().to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
