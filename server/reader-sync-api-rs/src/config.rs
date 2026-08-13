use std::{net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Context, Result, bail};
use secrecy::SecretString;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: SecretString,
    pub token_hmac_key: SecretString,
    pub database_max_connections: u32,
    pub max_concurrent_requests: usize,
    pub max_concurrent_password_operations: usize,
    pub request_timeout: Duration,
    pub body_limit_bytes: usize,
    pub run_migrations: bool,
    pub trust_loopback_proxy_headers: bool,
    pub smtp: Option<SmtpConfig>,
}

#[derive(Clone, Debug)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls_mode: SmtpTlsMode,
    pub from: String,
    pub username: Option<String>,
    pub password: Option<SecretString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SmtpTlsMode {
    Implicit,
    StartTls,
}

impl FromStr for SmtpTlsMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "implicit" => Ok(Self::Implicit),
            "starttls" => Ok(Self::StartTls),
            _ => bail!("SMTP TLS mode must be implicit or starttls"),
        }
    }
}

impl Config {
    /// Loads and validates the service configuration from the environment.
    ///
    /// # Errors
    ///
    /// Returns an error when a required value is missing, malformed, or does
    /// not meet the minimum secret length.
    pub fn from_env() -> Result<Self> {
        let bind: SocketAddr = value("KUNPENG_SYNC_BIND", "127.0.0.1:8788")
            .parse()
            .context("KUNPENG_SYNC_BIND must be a socket address")?;
        if !bind.ip().is_loopback() && !boolean("KUNPENG_SYNC_ALLOW_PUBLIC_BIND", false)? {
            bail!("KUNPENG_SYNC_BIND must be loopback unless KUNPENG_SYNC_ALLOW_PUBLIC_BIND=1");
        }
        let database_url = required("KUNPENG_SYNC_DATABASE_URL")?;
        let token_hmac_key = required("KUNPENG_SYNC_TOKEN_HMAC_KEY")?;
        if token_hmac_key.len() < 32 {
            bail!("KUNPENG_SYNC_TOKEN_HMAC_KEY must contain at least 32 bytes");
        }

        let smtp = smtp_config()?;
        Ok(Self {
            bind,
            database_url: SecretString::from(database_url),
            token_hmac_key: SecretString::from(token_hmac_key),
            database_max_connections: parsed_positive(
                "KUNPENG_SYNC_DATABASE_MAX_CONNECTIONS",
                "16",
            )?,
            max_concurrent_requests: parsed_positive("KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS", "64")?,
            max_concurrent_password_operations: parsed_positive(
                "KUNPENG_SYNC_MAX_CONCURRENT_PASSWORD_OPERATIONS",
                "4",
            )?,
            request_timeout: Duration::from_secs(parsed_positive(
                "KUNPENG_SYNC_REQUEST_TIMEOUT_SECONDS",
                "15",
            )?),
            body_limit_bytes: parsed_positive("KUNPENG_SYNC_BODY_LIMIT_BYTES", "16777216")?,
            run_migrations: boolean("KUNPENG_SYNC_RUN_MIGRATIONS", false)?,
            trust_loopback_proxy_headers: boolean(
                "KUNPENG_SYNC_TRUST_LOOPBACK_PROXY_HEADERS",
                false,
            )?,
            smtp,
        })
    }

    #[doc(hidden)]
    #[must_use]
    pub fn for_test(database_url: &str) -> Self {
        Self {
            bind: SocketAddr::from_str("127.0.0.1:0").expect("test bind address"),
            database_url: SecretString::from(database_url.to_owned()),
            token_hmac_key: SecretString::from("test-only-key-with-at-least-32-bytes".to_owned()),
            database_max_connections: 2,
            max_concurrent_requests: 8,
            max_concurrent_password_operations: 2,
            request_timeout: Duration::from_secs(2),
            body_limit_bytes: 1024 * 1024,
            run_migrations: false,
            trust_loopback_proxy_headers: false,
            smtp: Some(SmtpConfig {
                host: "smtp.invalid".to_owned(),
                port: 587,
                tls_mode: SmtpTlsMode::StartTls,
                from: "noreply@example.invalid".to_owned(),
                username: None,
                password: None,
            }),
        }
    }
}

fn smtp_config() -> Result<Option<SmtpConfig>> {
    let Ok(host) = std::env::var("KUNPENG_SYNC_SMTP_HOST") else {
        return Ok(None);
    };
    if host.trim().is_empty() {
        bail!("KUNPENG_SYNC_SMTP_HOST must not be empty");
    }
    let from = required("KUNPENG_SYNC_SMTP_FROM")?;
    let username = std::env::var("KUNPENG_SYNC_SMTP_USERNAME")
        .ok()
        .filter(|value| !value.is_empty());
    let password = std::env::var("KUNPENG_SYNC_SMTP_PASSWORD")
        .ok()
        .filter(|value| !value.is_empty())
        .map(SecretString::from);
    if username.is_some() != password.is_some() {
        bail!("KUNPENG_SYNC_SMTP_USERNAME and KUNPENG_SYNC_SMTP_PASSWORD must be set together");
    }
    Ok(Some(SmtpConfig {
        host,
        port: parsed_positive("KUNPENG_SYNC_SMTP_PORT", "587")?,
        tls_mode: value("KUNPENG_SYNC_SMTP_TLS_MODE", "starttls")
            .parse()
            .context("KUNPENG_SYNC_SMTP_TLS_MODE has an invalid value")?,
        from,
        username,
        password,
    }))
}

fn required(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        bail!("{name} must not be empty");
    }
    Ok(value)
}

fn value(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn parsed<T>(name: &str, default: &str) -> Result<T>
where
    T: FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    value(name, default)
        .parse()
        .with_context(|| format!("{name} has an invalid value"))
}

fn parsed_positive<T>(name: &str, default: &str) -> Result<T>
where
    T: FromStr + Default + PartialEq,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    let parsed = parsed(name, default)?;
    if parsed == T::default() {
        bail!("{name} must be greater than zero");
    }
    Ok(parsed)
}

fn boolean(name: &str, default: bool) -> Result<bool> {
    match value(name, if default { "1" } else { "0" }).as_str() {
        "1" | "true" | "yes" => Ok(true),
        "0" | "false" | "no" => Ok(false),
        _ => bail!("{name} must be 0/1, true/false, or yes/no"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_does_not_expose_secrets_in_debug() {
        let config = Config::for_test("postgresql://user:password@localhost/database");
        let debug = format!("{config:?}");
        assert!(!debug.contains("postgresql://user:password"));
        assert!(!debug.contains("test-only-key"));
    }

    #[test]
    fn test_smtp_tls_mode_is_explicit_and_secure() {
        assert_eq!(
            "implicit".parse::<SmtpTlsMode>().unwrap(),
            SmtpTlsMode::Implicit
        );
        assert_eq!(
            "starttls".parse::<SmtpTlsMode>().unwrap(),
            SmtpTlsMode::StartTls
        );
        assert!("plaintext".parse::<SmtpTlsMode>().is_err());
    }
}
