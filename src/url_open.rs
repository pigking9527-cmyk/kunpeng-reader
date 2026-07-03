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

#[cfg(not(target_os = "windows"))]
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
