use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(all(target_os = "macos", not(test)))]
use std::sync::atomic::{AtomicBool, Ordering};

const DPAPI_PREFIX: &str = "dpapi:";
const KEYCHAIN_MARKER: &str = "keychain:v1";
// Development signing can bind a Keychain item's partition to an earlier
// local build. Keep older slots readable for compatibility, but write fresh
// logins and explicit-recovery migrations to the current service so an
// inaccessible item cannot block recovery after the user has authorized once.
const LEGACY_SYNC_KEYCHAIN_MARKER_V2: &str = "keychain:sync-token:v2";
const LEGACY_SYNC_KEYCHAIN_MARKER_V3: &str = "keychain:sync-token:v3";
const LEGACY_SYNC_KEYCHAIN_MARKER_V4: &str = "keychain:sync-token:v4";
const LEGACY_SYNC_KEYCHAIN_MARKER_V5: &str = "keychain:sync-token:v5";
const SYNC_KEYCHAIN_MARKER: &str = "keychain:sync-token:v6";
const SECRET_TOOL_MARKER: &str = "secret-service:v1";
const KEYCHAIN_ACCESS_DENIED: &str = "已取消或拒绝访问 macOS 钥匙串；本次启动不再重复请求";
const LEGACY_SYNC_CREDENTIAL: &str =
    "旧版同步凭据已停用；请退出后重新登录一次，之后同步不再重复请求钥匙串";
#[cfg(all(target_os = "macos", not(test)))]
static KEYCHAIN_ACCESS_DENIED_FOR_PROCESS: AtomicBool = AtomicBool::new(false);

pub(crate) fn credential_access_was_denied(error: &str) -> bool {
    error == KEYCHAIN_ACCESS_DENIED
}

/// An explicit user action may retry a previously cancelled Keychain read.
/// Background work deliberately retains the denial for the process lifetime so
/// it cannot keep reopening macOS authorization prompts on its own.
pub(crate) fn allow_explicit_sync_secret_retry() {
    #[cfg(all(target_os = "macos", not(test)))]
    KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.store(false, Ordering::Release);
}

pub(crate) fn protect_sync_secret(secret: &str) -> Result<String, String> {
    #[cfg(test)]
    return Ok(if secret.is_empty() {
        String::new()
    } else {
        format!("test:{}", STANDARD.encode(secret))
    });
    #[cfg(all(target_os = "macos", not(test)))]
    {
        if secret.is_empty() {
            macos_keychain_delete_sync()?;
            return Ok(String::new());
        }
        macos_keychain_store_sync(secret)?;
        Ok(SYNC_KEYCHAIN_MARKER.into())
    }
    #[cfg(all(not(target_os = "macos"), not(test)))]
    protect_secret(secret)
}

pub(crate) fn unprotect_sync_secret(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if stored == KEYCHAIN_MARKER && cfg!(target_os = "macos") {
        return Err(LEGACY_SYNC_CREDENTIAL.into());
    }
    #[cfg(all(target_os = "macos", not(test)))]
    if is_sync_keychain_marker(stored) {
        return macos_keychain_read_sync(stored);
    }
    unprotect_secret(stored)
}

/// Read the remembered sync credential only when macOS can supply it without
/// displaying an authorization prompt.  Startup work uses this so an existing
/// login resumes automatically after restart, while a locked or unapproved
/// Keychain item remains a user-initiated decision.
pub(crate) fn unprotect_sync_secret_without_interaction(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if stored == KEYCHAIN_MARKER && cfg!(target_os = "macos") {
        return Err(LEGACY_SYNC_CREDENTIAL.into());
    }
    #[cfg(all(target_os = "macos", not(test)))]
    if is_sync_keychain_marker(stored) {
        return macos_keychain_read_sync_without_interaction(stored);
    }
    unprotect_secret(stored)
}

pub(crate) fn is_sync_secret_protected(stored: &str) -> bool {
    stored.is_empty()
        || stored == KEYCHAIN_MARKER && cfg!(target_os = "macos")
        || is_sync_keychain_marker(stored) && cfg!(target_os = "macos")
        || stored.starts_with(DPAPI_PREFIX) && cfg!(windows)
        || stored == SECRET_TOOL_MARKER && cfg!(all(unix, not(target_os = "macos")))
        || cfg!(test) && stored.starts_with("test:")
}

/// Whether a protected marker is already in the current platform slot.
/// Older macOS slots are intentionally migrated only after their token has
/// been read through an explicit user action.
pub(crate) fn is_current_sync_secret_platform_marker(stored: &str) -> bool {
    #[cfg(all(target_os = "macos", not(test)))]
    return stored == SYNC_KEYCHAIN_MARKER;
    #[cfg(any(not(target_os = "macos"), test))]
    is_sync_secret_protected(stored)
}

fn is_sync_keychain_marker(stored: &str) -> bool {
    matches!(
        stored,
        SYNC_KEYCHAIN_MARKER
            | LEGACY_SYNC_KEYCHAIN_MARKER_V5
            | LEGACY_SYNC_KEYCHAIN_MARKER_V4
            | LEGACY_SYNC_KEYCHAIN_MARKER_V3
            | LEGACY_SYNC_KEYCHAIN_MARKER_V2
    )
}

pub(crate) fn clear_sync_secret_for_logout() -> Result<(), String> {
    #[cfg(test)]
    return Ok(());
    #[cfg(all(target_os = "macos", not(test)))]
    return macos_keychain_delete_sync();
    #[cfg(all(not(target_os = "macos"), not(test)))]
    clear_platform_secret()
}

pub(crate) fn protect_secret(secret: &str) -> Result<String, String> {
    #[cfg(test)]
    return Ok(if secret.is_empty() {
        String::new()
    } else {
        format!("test:{}", STANDARD.encode(secret))
    });
    #[cfg(not(test))]
    {
        if secret.is_empty() {
            clear_platform_secret()?;
            return Ok(String::new());
        }
        protect_platform_secret(secret)
    }
}

pub(crate) fn unprotect_secret(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    #[cfg(test)]
    if let Some(encoded) = stored.strip_prefix("test:") {
        return STANDARD
            .decode(encoded)
            .map_err(|e| format!("测试凭据解码失败：{e}"))
            .and_then(|value| String::from_utf8(value).map_err(|e| e.to_string()));
    }
    if stored == KEYCHAIN_MARKER || stored == SECRET_TOOL_MARKER {
        return read_platform_secret(stored);
    }
    let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) else {
        // Backward compatibility for tokens saved before OS credential storage.
        return Ok(stored.to_string());
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| format!("凭据解码失败：{e}"))?;
    let plain = unprotect_bytes(&bytes)?;
    String::from_utf8(plain).map_err(|e| format!("凭据不是有效 UTF-8：{e}"))
}

#[cfg(test)]
fn read_platform_secret(_stored: &str) -> Result<String, String> {
    Err("测试环境没有操作系统凭据项".into())
}

#[cfg(windows)]
fn protect_platform_secret(secret: &str) -> Result<String, String> {
    protect_bytes(secret.as_bytes())
        .map(|bytes| format!("{DPAPI_PREFIX}{}", STANDARD.encode(bytes)))
}

#[cfg(windows)]
fn read_platform_secret(stored: &str) -> Result<String, String> {
    Err(format!("当前平台不支持凭据标记：{stored}"))
}

#[cfg(windows)]
fn clear_platform_secret() -> Result<(), String> {
    Ok(())
}

#[cfg(all(target_os = "macos", not(test)))]
fn protect_platform_secret(secret: &str) -> Result<String, String> {
    macos_keychain_store(secret)?;
    Ok(KEYCHAIN_MARKER.into())
}

#[cfg(all(target_os = "macos", not(test)))]
fn read_platform_secret(stored: &str) -> Result<String, String> {
    if stored != KEYCHAIN_MARKER {
        return Err("同步凭据存储类型与当前平台不匹配".into());
    }
    macos_keychain_read()
}

#[cfg(all(target_os = "macos", not(test)))]
fn clear_platform_secret() -> Result<(), String> {
    macos_keychain_delete()
}

#[cfg(all(target_os = "macos", not(test)))]
mod macos_keychain {
    use std::ffi::{c_char, c_void};
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};

    type OsStatus = i32;
    type SecKeychainItemRef = *mut c_void;
    type SecKeychainSearchRef = *mut c_void;
    const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25300;
    const ERR_SEC_USER_CANCELED: OsStatus = -128;
    const ERR_SEC_AUTH_FAILED: OsStatus = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: OsStatus = -25308;
    const GENERIC_PASSWORD_ITEM_CLASS: u32 = u32::from_be_bytes(*b"genp");
    const ACCOUNT_ITEM_ATTR: u32 = u32::from_be_bytes(*b"acct");
    const SERVICE_ITEM_ATTR: u32 = u32::from_be_bytes(*b"svce");
    const ACCOUNT: &[u8] = b"sync-token";
    static OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[repr(C)]
    struct SecKeychainAttribute {
        tag: u32,
        length: u32,
        data: *mut c_void,
    }

    #[repr(C)]
    struct SecKeychainAttributeList {
        count: u32,
        attr: *mut SecKeychainAttribute,
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_name_length: u32,
            service_name: *const c_char,
            account_name_length: u32,
            account_name: *const c_char,
            password_length: *mut u32,
            password_data: *mut *mut c_void,
            item_ref: *mut SecKeychainItemRef,
        ) -> OsStatus;
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_name_length: u32,
            service_name: *const c_char,
            account_name_length: u32,
            account_name: *const c_char,
            password_length: u32,
            password_data: *const c_void,
            item_ref: *mut SecKeychainItemRef,
        ) -> OsStatus;
        fn SecKeychainItemModifyAttributesAndData(
            item_ref: SecKeychainItemRef,
            attr_list: *const c_void,
            length: u32,
            data: *const c_void,
        ) -> OsStatus;
        fn SecKeychainItemFreeContent(attr_list: *const c_void, data: *mut c_void) -> OsStatus;
        fn SecKeychainItemDelete(item_ref: SecKeychainItemRef) -> OsStatus;
        fn SecKeychainSearchCreateFromAttributes(
            keychain_or_array: *const c_void,
            item_class: u32,
            attr_list: *const SecKeychainAttributeList,
            search_ref: *mut SecKeychainSearchRef,
        ) -> OsStatus;
        fn SecKeychainSearchCopyNext(
            search_ref: SecKeychainSearchRef,
            item_ref: *mut SecKeychainItemRef,
        ) -> OsStatus;
        fn SecKeychainSetUserInteractionAllowed(state: u8) -> OsStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }

    fn service() -> Vec<u8> {
        crate::profile::keychain_service().into_bytes()
    }

    fn sync_service() -> Vec<u8> {
        crate::profile::sync_token_keychain_service().into_bytes()
    }

    fn operation_lock() -> &'static Mutex<()> {
        OPERATION_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn find(
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut SecKeychainItemRef,
    ) -> OsStatus {
        find_for_service(&service(), password_length, password_data, item_ref)
    }

    fn find_sync(
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut SecKeychainItemRef,
    ) -> OsStatus {
        find_for_service(&sync_service(), password_length, password_data, item_ref)
    }

    fn find_for_service(
        service: &[u8],
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut SecKeychainItemRef,
    ) -> OsStatus {
        unsafe {
            SecKeychainFindGenericPassword(
                null(),
                service.len() as u32,
                service.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                password_length,
                password_data,
                item_ref,
            )
        }
    }

    fn release_item(item: SecKeychainItemRef) {
        if !item.is_null() {
            unsafe { CFRelease(item.cast()) };
        }
    }

    /// Locate the generic-password record by public metadata only. Unlike
    /// `SecKeychainFindGenericPassword`, this does not request the protected
    /// password bytes and therefore logout can delete the local credential
    /// without displaying an authorization prompt.
    fn find_item_without_secret_for(
        mut service: Vec<u8>,
    ) -> Result<Option<SecKeychainItemRef>, OsStatus> {
        let mut account = ACCOUNT.to_vec();
        let mut attrs = [
            SecKeychainAttribute {
                tag: SERVICE_ITEM_ATTR,
                length: service.len() as u32,
                data: service.as_mut_ptr().cast(),
            },
            SecKeychainAttribute {
                tag: ACCOUNT_ITEM_ATTR,
                length: account.len() as u32,
                data: account.as_mut_ptr().cast(),
            },
        ];
        let list = SecKeychainAttributeList {
            count: attrs.len() as u32,
            attr: attrs.as_mut_ptr(),
        };
        let mut search = null_mut();
        let created = unsafe {
            SecKeychainSearchCreateFromAttributes(
                null(),
                GENERIC_PASSWORD_ITEM_CLASS,
                &list,
                &mut search,
            )
        };
        if created != 0 {
            return Err(created);
        }
        let mut item = null_mut();
        let found = unsafe { SecKeychainSearchCopyNext(search, &mut item) };
        if !search.is_null() {
            unsafe { CFRelease(search.cast()) };
        }
        match found {
            0 => Ok(Some(item)),
            ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            status => Err(status),
        }
    }

    fn access_was_denied(status: OsStatus) -> bool {
        matches!(
            status,
            ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED
        )
    }

    pub(super) fn store(secret: &str) -> Result<(), String> {
        store_for(secret, service(), find)
    }

    pub(super) fn store_sync(secret: &str) -> Result<(), String> {
        store_for(secret, sync_service(), find_sync)
    }

    fn store_for(
        secret: &str,
        service: Vec<u8>,
        find_item: fn(*mut u32, *mut *mut c_void, *mut SecKeychainItemRef) -> OsStatus,
    ) -> Result<(), String> {
        let _operation = operation_lock()
            .lock()
            .map_err(|_| "macOS 钥匙串操作锁不可用".to_string())?;
        let bytes = secret.as_bytes();
        let length = u32::try_from(bytes.len()).map_err(|_| "同步凭据过大".to_string())?;
        let mut old_length = 0;
        let mut old_data = null_mut();
        let mut item = null_mut();
        let status = find_item(&mut old_length, &mut old_data, &mut item);
        if status == 0 {
            if !old_data.is_null() {
                unsafe { SecKeychainItemFreeContent(null(), old_data) };
            }
            let updated = unsafe {
                SecKeychainItemModifyAttributesAndData(item, null(), length, bytes.as_ptr().cast())
            };
            release_item(item);
            return if updated == 0 {
                Ok(())
            } else {
                Err("macOS 钥匙串更新失败".into())
            };
        }
        release_item(item);
        if status != ERR_SEC_ITEM_NOT_FOUND {
            return Err("macOS 钥匙串访问失败".into());
        }
        let mut created_item = null_mut();
        let added = unsafe {
            SecKeychainAddGenericPassword(
                null(),
                service.len() as u32,
                service.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                length,
                bytes.as_ptr().cast(),
                &mut created_item,
            )
        };
        if added == 0 {
            release_item(created_item);
            Ok(())
        } else {
            release_item(created_item);
            Err("macOS 钥匙串写入失败".into())
        }
    }

    pub(super) fn read() -> Result<String, String> {
        read_with(find, true)
    }

    pub(super) fn read_sync_for_service(
        service: Vec<u8>,
        interaction_allowed: bool,
    ) -> Result<String, String> {
        read_with(
            move |password_length, password_data, item_ref| {
                find_for_service(&service, password_length, password_data, item_ref)
            },
            interaction_allowed,
        )
    }

    fn read_with<F>(find_item: F, interaction_allowed: bool) -> Result<String, String>
    where
        F: Fn(*mut u32, *mut *mut c_void, *mut SecKeychainItemRef) -> OsStatus,
    {
        let _operation = operation_lock()
            .lock()
            .map_err(|_| "macOS 钥匙串操作锁不可用".to_string())?;
        let interaction_disabled = if interaction_allowed {
            false
        } else {
            let status = unsafe { SecKeychainSetUserInteractionAllowed(0) };
            if status != 0 {
                return Err("macOS 钥匙串无法切换为无交互模式".into());
            }
            true
        };
        let result = read_with_current_interaction_setting(find_item);
        if interaction_disabled {
            let restored = unsafe { SecKeychainSetUserInteractionAllowed(1) };
            if restored != 0 && result.is_ok() {
                return Err("macOS 钥匙串交互状态恢复失败".into());
            }
        }
        result
    }

    fn read_with_current_interaction_setting<F>(find_item: F) -> Result<String, String>
    where
        F: Fn(*mut u32, *mut *mut c_void, *mut SecKeychainItemRef) -> OsStatus,
    {
        let mut length = 0;
        let mut data = null_mut();
        let mut item = null_mut();
        let status = find_item(&mut length, &mut data, &mut item);
        if status != 0 {
            release_item(item);
            return if access_was_denied(status) {
                Err(super::KEYCHAIN_ACCESS_DENIED.into())
            } else {
                Err("无法从 macOS 钥匙串读取同步凭据".into())
            };
        }
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) };
        let result = String::from_utf8(bytes.to_vec())
            .map_err(|_| "macOS 钥匙串中的同步凭据格式无效".to_string());
        if !data.is_null() {
            unsafe { SecKeychainItemFreeContent(null(), data) };
        }
        release_item(item);
        result
    }

    pub(super) fn delete() -> Result<(), String> {
        delete_for(service())
    }

    pub(super) fn delete_sync() -> Result<(), String> {
        delete_for(sync_service())
    }

    fn delete_for(service: Vec<u8>) -> Result<(), String> {
        let _operation = operation_lock()
            .lock()
            .map_err(|_| "macOS 钥匙串操作锁不可用".to_string())?;
        let disabled = unsafe { SecKeychainSetUserInteractionAllowed(0) };
        if disabled != 0 {
            return Err("macOS 钥匙串无法切换为无交互模式".into());
        }
        let result = delete_with_interaction_disabled(service);
        let restored = unsafe { SecKeychainSetUserInteractionAllowed(1) };
        if restored != 0 {
            return Err("macOS 钥匙串交互状态恢复失败".into());
        }
        result
    }

    fn delete_with_interaction_disabled(service: Vec<u8>) -> Result<(), String> {
        let Some(item) = find_item_without_secret_for(service).map_err(|status| {
            if access_was_denied(status) {
                super::KEYCHAIN_ACCESS_DENIED.to_string()
            } else {
                "macOS 钥匙串访问失败".to_string()
            }
        })?
        else {
            return Ok(());
        };
        let deleted = unsafe { SecKeychainItemDelete(item) };
        release_item(item);
        if deleted == 0 {
            Ok(())
        } else {
            Err("macOS 钥匙串删除失败".into())
        }
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_store(secret: &str) -> Result<(), String> {
    let result = macos_keychain::store(secret);
    if result.is_ok() {
        KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.store(false, Ordering::Release);
    }
    result
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_read() -> Result<String, String> {
    if KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.load(Ordering::Acquire) {
        return Err(KEYCHAIN_ACCESS_DENIED.into());
    }
    let result = macos_keychain::read();
    if result
        .as_deref()
        .err()
        .is_some_and(|error| credential_access_was_denied(error))
    {
        KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.store(true, Ordering::Release);
    }
    result
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_delete() -> Result<(), String> {
    macos_keychain::delete()
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_store_sync(secret: &str) -> Result<(), String> {
    let result = macos_keychain::store_sync(secret);
    if result.is_ok() {
        KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.store(false, Ordering::Release);
    }
    result
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_read_sync(marker: &str) -> Result<String, String> {
    if KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.load(Ordering::Acquire) {
        return Err(KEYCHAIN_ACCESS_DENIED.into());
    }
    let result = macos_keychain::read_sync_for_service(
        macos_sync_keychain_service(marker)?.into_bytes(),
        true,
    );
    if result
        .as_deref()
        .err()
        .is_some_and(|error| credential_access_was_denied(error))
    {
        KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.store(true, Ordering::Release);
    }
    result
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_read_sync_without_interaction(marker: &str) -> Result<String, String> {
    if KEYCHAIN_ACCESS_DENIED_FOR_PROCESS.load(Ordering::Acquire) {
        return Err(KEYCHAIN_ACCESS_DENIED.into());
    }
    // A non-interactive read can be rejected simply because a fresh process
    // is not yet authorised to show a Keychain dialog.  That is not a user
    // cancellation.  Do not poison the process-wide interactive path here:
    // a subsequent explicit Sync click must still be allowed to ask macOS.
    macos_keychain::read_sync_for_service(macos_sync_keychain_service(marker)?.into_bytes(), false)
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_sync_keychain_service(marker: &str) -> Result<String, String> {
    match marker {
        SYNC_KEYCHAIN_MARKER => Ok(crate::profile::sync_token_keychain_service()),
        LEGACY_SYNC_KEYCHAIN_MARKER_V5 => Ok(crate::profile::legacy_sync_token_keychain_service(5)),
        LEGACY_SYNC_KEYCHAIN_MARKER_V4 => Ok(crate::profile::legacy_sync_token_keychain_service(4)),
        LEGACY_SYNC_KEYCHAIN_MARKER_V3 => Ok(crate::profile::legacy_sync_token_keychain_service(3)),
        LEGACY_SYNC_KEYCHAIN_MARKER_V2 => Ok(crate::profile::legacy_sync_token_keychain_service(2)),
        _ => Err("同步凭据存储类型与当前平台不匹配".into()),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_delete_sync() -> Result<(), String> {
    macos_keychain::delete_sync()
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn protect_platform_secret(secret: &str) -> Result<String, String> {
    platform_command_store(
        "secret-tool",
        &[
            "store",
            "--label=鲲鹏阅读器同步",
            "application",
            "kunpeng-reader",
            "purpose",
            "sync-token",
        ],
        secret,
        "系统 Secret Service 不可用；请安装并启动 libsecret/密钥环后重试",
    )?;
    Ok(SECRET_TOOL_MARKER.into())
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn read_platform_secret(stored: &str) -> Result<String, String> {
    if stored != SECRET_TOOL_MARKER {
        return Err("同步凭据存储类型与当前平台不匹配".into());
    }
    platform_command_read(
        "secret-tool",
        &[
            "lookup",
            "application",
            "kunpeng-reader",
            "purpose",
            "sync-token",
        ],
        "无法从系统 Secret Service 读取同步凭据",
    )
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn clear_platform_secret() -> Result<(), String> {
    platform_command_delete(
        "secret-tool",
        &[
            "clear",
            "application",
            "kunpeng-reader",
            "purpose",
            "sync-token",
        ],
    )
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn platform_command_store(
    program: &str,
    args: &[&str],
    secret: &str,
    message: &str,
) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| message.to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| message.to_string())?
        .write_all(format!("{secret}\n").as_bytes())
        .map_err(|_| message.to_string())?;
    let output = child.wait_with_output().map_err(|_| message.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(message.into())
    }
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn platform_command_read(program: &str, args: &[&str], message: &str) -> Result<String, String> {
    use std::process::Command;
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|_| message.to_string())?;
    if !output.status.success() {
        return Err(message.into());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim_end_matches(['\r', '\n']).to_string())
        .map_err(|_| message.into())
}

#[cfg(all(unix, not(target_os = "macos"), not(test)))]
fn platform_command_delete(program: &str, args: &[&str]) -> Result<(), String> {
    use std::process::Command;
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => Ok(()),
        // A missing item is already the desired state. Do not prevent logout.
        Ok(_) => Ok(()),
        Err(_) => Ok(()),
    }
}

#[cfg(windows)]
fn protect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    win_dpapi(input, true)
}

#[cfg(windows)]
fn unprotect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    win_dpapi(input, false)
}

#[cfg(windows)]
fn win_dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *mut DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *mut DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *mut DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *mut DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(hmem: *mut c_void) -> *mut c_void;
    }

    if input.len() > u32::MAX as usize {
        return Err("凭据过大，无法保护".into());
    }
    let mut in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_ptr() as *mut u8,
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut in_blob,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
                0,
                &mut out_blob,
            )
        } else {
            CryptUnprotectData(
                &mut in_blob,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                0,
                &mut out_blob,
            )
        }
    };
    if ok == 0 {
        return Err("Windows 凭据保护失败".into());
    }
    let out = unsafe {
        let copy = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec();
        LocalFree(out_blob.pb_data as *mut c_void);
        copy
    };
    Ok(out)
}

#[cfg(not(windows))]
fn unprotect_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    // Read legacy Base64-wrapped values so a successful login can migrate them
    // into the OS credential store. New non-Windows writes never use this path.
    Ok(input.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_plaintext_and_wrapped_tokens_remain_readable() {
        assert_eq!(unprotect_secret("legacy-token").unwrap(), "legacy-token");
        #[cfg(not(windows))]
        assert_eq!(
            unprotect_secret("dpapi:bGVnYWN5LXRva2Vu").unwrap(),
            "legacy-token"
        );
    }

    #[test]
    fn platform_markers_never_contain_the_secret() {
        assert!(!KEYCHAIN_MARKER.contains("new-token"));
        assert!(!SYNC_KEYCHAIN_MARKER.contains("new-token"));
        assert!(!SECRET_TOOL_MARKER.contains("new-token"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn legacy_macos_sync_marker_is_rejected_without_keychain_access() {
        let error = unprotect_sync_secret(KEYCHAIN_MARKER).unwrap_err();
        assert_eq!(error, LEGACY_SYNC_CREDENTIAL);
    }

    #[test]
    fn sync_secret_test_roundtrip_uses_an_opaque_marker() {
        let protected = protect_sync_secret("new-token").unwrap();
        assert_ne!(protected, "new-token");
        assert_eq!(unprotect_sync_secret(&protected).unwrap(), "new-token");
        assert!(is_sync_secret_protected(&protected));
    }
}
