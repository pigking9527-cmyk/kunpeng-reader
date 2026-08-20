//! Deterministic validation for local sync configuration and account scope.
//!
//! This module deliberately has no HTTP, SQLite, Tauri, token, or account
//! recovery ownership.  It preserves the existing user-facing errors while
//! keeping base-address and data-generation decisions independently testable.

use reader_core::sync::sync_scope_id;

pub(super) fn default_data_generation() -> i64 {
    1
}

pub(super) fn ensure_data_generation(expected: i64, actual: i64) -> Result<(), String> {
    if actual < 1 {
        return Err("服务器返回的云端数据版本无效".into());
    }
    if expected.max(1) == actual {
        Ok(())
    } else {
        Err("云端数据版本已经变化；请在“数据与隐私”中清除此设备数据后重新登录".into())
    }
}

fn is_local_http_base(base: &str) -> bool {
    base == "http://localhost"
        || base.starts_with("http://localhost:")
        || base == "http://127.0.0.1"
        || base.starts_with("http://127.0.0.1:")
        || base == "http://[::1]"
        || base.starts_with("http://[::1]:")
}

pub(super) fn normalize_sync_base(input: &str) -> Result<String, String> {
    let base = input.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先在同步设置中填写 HTTPS 服务器地址".into());
    }
    if base.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("同步服务器地址包含非法空白字符".into());
    }
    if base.starts_with("https://") {
        return Ok(base);
    }
    if base.starts_with("http://") {
        // Only loopback addresses are permitted for explicit local debugging.
        if is_local_http_base(&base) {
            return Ok(base);
        }
        return Err("同步服务器必须使用 HTTPS；只有本机调试地址允许 HTTP".into());
    }
    Err("同步服务器地址必须以 https:// 开头".into())
}

pub(super) fn normalize_auth_base(input: &str, default_sync_url: &str) -> Result<String, String> {
    let input = input.trim();
    let value = if input.is_empty() {
        let default_sync_url = default_sync_url.trim();
        if default_sync_url.is_empty() {
            return Err(
                "此客户端尚未配置同步服务，暂时无法注册或登录；请联系服务提供方或使用已配置服务的版本"
                    .into(),
            );
        }
        default_sync_url
    } else {
        input
    };
    normalize_sync_base(value)
}

pub(super) fn account_sync_scope(base: &str, user_id: &str) -> Result<String, String> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err("同步账户身份缺失，请重新登录".into());
    }
    Ok(sync_scope_id(base, user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_base_requires_https_except_explicit_loopback() {
        assert_eq!(
            normalize_sync_base(" https://reader.example.com/ ").unwrap(),
            "https://reader.example.com"
        );
        assert_eq!(
            normalize_sync_base("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_sync_base("http://example.com").is_err());
        assert!(normalize_sync_base("http://localhost.example").is_err());
        assert!(normalize_sync_base("ftp://example.com").is_err());
        assert!(normalize_sync_base("https://example.com/a b").is_err());
    }

    #[test]
    fn auth_base_uses_default_only_for_empty_input() {
        assert_eq!(
            normalize_auth_base("", "https://reader.example").unwrap(),
            "https://reader.example"
        );
        assert_eq!(
            normalize_auth_base("", "").unwrap_err(),
            "此客户端尚未配置同步服务，暂时无法注册或登录；请联系服务提供方或使用已配置服务的版本"
        );
        assert_eq!(
            normalize_auth_base("https://custom.example", "https://reader.example").unwrap(),
            "https://custom.example"
        );
    }

    #[test]
    fn generation_and_account_scope_reject_invalid_identity() {
        assert_eq!(default_data_generation(), 1);
        assert!(ensure_data_generation(1, 0).is_err());
        assert!(ensure_data_generation(1, 2).is_err());
        assert!(ensure_data_generation(0, 1).is_ok());
        assert!(account_sync_scope("https://reader.example", "  ").is_err());
        assert_eq!(
            account_sync_scope("https://reader.example", " user-1 ").unwrap(),
            sync_scope_id("https://reader.example", "user-1")
        );
    }
}
