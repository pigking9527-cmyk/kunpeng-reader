use base64::{engine::general_purpose::STANDARD, Engine as _};

const DPAPI_PREFIX: &str = "dpapi:";
const KEYCHAIN_MARKER: &str = "keychain:v1";
const SECRET_TOOL_MARKER: &str = "secret-service:v1";

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

pub(crate) fn is_platform_protected(stored: &str) -> bool {
    stored.is_empty()
        || stored.starts_with(DPAPI_PREFIX) && cfg!(windows)
        || stored == KEYCHAIN_MARKER && cfg!(target_os = "macos")
        || stored == SECRET_TOOL_MARKER && cfg!(all(unix, not(target_os = "macos")))
        || cfg!(test) && stored.starts_with("test:")
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

    type OsStatus = i32;
    type SecKeychainItemRef = *mut c_void;
    const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25300;
    const ACCOUNT: &[u8] = b"sync-token";

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
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }

    fn service() -> Vec<u8> {
        crate::profile::keychain_service().into_bytes()
    }

    fn find(
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut SecKeychainItemRef,
    ) -> OsStatus {
        let service = service();
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

    pub(super) fn store(secret: &str) -> Result<(), String> {
        let bytes = secret.as_bytes();
        let length = u32::try_from(bytes.len()).map_err(|_| "同步凭据过大".to_string())?;
        let mut old_length = 0;
        let mut old_data = null_mut();
        let mut item = null_mut();
        let status = find(&mut old_length, &mut old_data, &mut item);
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
        let service = service();
        let added = unsafe {
            SecKeychainAddGenericPassword(
                null(),
                service.len() as u32,
                service.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                length,
                bytes.as_ptr().cast(),
                null_mut(),
            )
        };
        if added == 0 {
            Ok(())
        } else {
            Err("macOS 钥匙串写入失败".into())
        }
    }

    pub(super) fn read() -> Result<String, String> {
        let mut length = 0;
        let mut data = null_mut();
        let mut item = null_mut();
        let status = find(&mut length, &mut data, &mut item);
        if status != 0 {
            release_item(item);
            return Err("无法从 macOS 钥匙串读取同步凭据".into());
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
        let mut length = 0;
        let mut data = null_mut();
        let mut item = null_mut();
        let status = find(&mut length, &mut data, &mut item);
        if status == ERR_SEC_ITEM_NOT_FOUND {
            return Ok(());
        }
        if status != 0 {
            release_item(item);
            return Err("macOS 钥匙串访问失败".into());
        }
        if !data.is_null() {
            unsafe { SecKeychainItemFreeContent(null(), data) };
        }
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
    macos_keychain::store(secret)
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_read() -> Result<String, String> {
    macos_keychain::read()
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_keychain_delete() -> Result<(), String> {
    macos_keychain::delete()
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
        assert!(!SECRET_TOOL_MARKER.contains("new-token"));
    }
}
