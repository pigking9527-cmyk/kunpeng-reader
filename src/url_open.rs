pub(crate) fn validate_https_url(url: &str) -> Result<&str, String> {
    let u = url.trim();
    if !u.starts_with("https://") {
        return Err("外部链接必须使用 HTTPS".into());
    }
    if u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("外部链接包含非法空白字符".into());
    }
    Ok(u)
}

pub(crate) fn open_https_url(url: &str) -> Result<(), String> {
    let u = validate_https_url(url)?;
    open_validated_url(u)
}

/// Configures the installed reader as the preferred EPUB/PDF opener.
///
/// Windows owns the association picker, while macOS exposes the equivalent
/// per-content-type preference through Launch Services. Keep this behind one
/// command so the settings row does not promise a Windows-only workflow on
/// macOS.
pub(crate) fn open_default_apps_settings() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        open_validated_url("ms-settings:defaultapps")?;
        Ok("已打开系统默认应用设置。请将 .epub 和 .pdf 设为由“鲲鹏阅读器”打开。".into())
    }
    #[cfg(target_os = "macos")]
    {
        set_macos_default_book_handlers("com.pigking.ebookreader")?;
        Ok("已将 EPUB 和 PDF 设为默认由“鲲鹏阅读器”打开。".into())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Err("当前系统暂不支持从软件内设置默认打开方式".into())
    }
}

#[cfg(target_os = "macos")]
const MACOS_BOOK_CONTENT_TYPES: [&str; 2] = ["org.idpf.epub-container", "com.adobe.pdf"];

/// Launch Services remains the macOS API that persists the user's preferred
/// handler for a Uniform Type Identifier. The newer Swift API does not expose
/// a setter, so this small FFI boundary is intentionally isolated here.
#[cfg(target_os = "macos")]
fn set_macos_default_book_handlers(bundle_id: &str) -> Result<(), String> {
    use std::{ffi::CString, os::raw::c_char, ptr};

    type CfStringRef = *const std::ffi::c_void;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_LS_ROLES_ALL: u32 = 0xffff_ffff;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const std::ffi::c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFRelease(cf: CfStringRef);
    }
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CfStringRef,
            role: u32,
            handler_bundle_id: CfStringRef,
        ) -> i32;
    }

    fn cf_string(value: &str) -> Result<CfStringRef, String> {
        let value = CString::new(value).map_err(|_| "默认应用标识包含非法字符".to_string())?;
        let result = unsafe {
            CFStringCreateWithCString(ptr::null(), value.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if result.is_null() {
            Err("无法创建 macOS 默认应用设置".into())
        } else {
            Ok(result)
        }
    }

    let handler = cf_string(bundle_id)?;
    for content_type in MACOS_BOOK_CONTENT_TYPES {
        let content_type_ref = cf_string(content_type)?;
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(content_type_ref, K_LS_ROLES_ALL, handler)
        };
        unsafe { CFRelease(content_type_ref) };
        if status != 0 {
            unsafe { CFRelease(handler) };
            return Err(format!(
                "无法设置 {content_type} 的默认打开方式（macOS 错误 {status}）"
            ));
        }
    }
    unsafe { CFRelease(handler) };
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_validated_url(url: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[link(name = "Shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let file = wide(url);
    let ret = unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            null(),
            null(),
            1,
        )
    };
    if ret <= 32 {
        return Err(format!("打开链接失败：ShellExecuteW 返回 {ret}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_validated_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_validated_url(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_https_url;

    #[test]
    fn external_urls_must_be_https_without_shell_metachar_spacing() {
        assert_eq!(
            validate_https_url(" https://example.com/release ").unwrap(),
            "https://example.com/release"
        );
        assert!(validate_https_url(concat!("http", "://example.com")).is_err());
        assert!(validate_https_url("file:///C:/Windows").is_err());
        assert!(validate_https_url("https://example.com/a b").is_err());
        assert!(validate_https_url("https://example.com/\ncalc").is_err());
    }
}
