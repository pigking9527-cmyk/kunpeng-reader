use std::{net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Context, Result, bail};
use secrecy::SecretString;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    /// TCP accept queue depth. This is intentionally independent from the
    /// HTTP execution semaphores: a short connection burst should wait in the
    /// kernel queue rather than be dropped before middleware can apply its
    /// bounded request queue.
    pub listen_backlog: u32,
    pub database_url: SecretString,
    pub token_hmac_key: SecretString,
    pub database_max_connections: u32,
    /// Bound `PostgreSQL` pool acquisition so a saturated pool fails before it
    /// can dominate request P99 behind an otherwise short HTTP queue. The
    /// default 300 ms budget tolerates a brief connection handoff without
    /// turning sustained saturation into unbounded handler work.
    pub database_acquire_timeout: Duration,
    /// Maximum concurrently executing ordinary safe/read-only HTTP requests.
    ///
    /// The default read/checkpoint/write budgets are 12/18/10, so at most 40
    /// requests execute across all three protected lanes. The split follows
    /// the measured catch-up mix while keeping one lane from consuming the
    /// complete service budget.
    pub max_concurrent_requests: usize,
    /// Maximum concurrent lightweight checkpoint requests.
    ///
    /// Checkpoints are intentionally isolated from pull and inventory reads:
    /// during catch-up traffic, a small progress probe must stay cheap and
    /// available without allowing it to consume the entire read budget.
    pub max_concurrent_checkpoint_requests: usize,
    /// Maximum safe/read-only requests allowed to wait for an execution slot.
    ///
    /// This is deliberately independent of the execution limit.  Once full,
    /// the API sheds new read work instead of accumulating unbounded futures
    /// while `PostgreSQL` is under pressure.
    pub max_queued_read_requests: usize,
    /// Maximum lightweight checkpoint requests allowed to wait for their
    /// dedicated execution slots.
    pub max_queued_checkpoint_requests: usize,
    /// Maximum concurrently executing state-changing HTTP requests.
    pub max_concurrent_write_requests: usize,
    /// Maximum state-changing requests allowed to wait for an execution slot.
    ///
    /// The default 48-slot bounded waiting room absorbs a short synchronized
    /// push burst without increasing the 10-request write execution budget.
    /// It remains smaller than the read queue so backlogged writes cannot
    /// displace checkpoint, pull, and account-overview reads.
    pub max_queued_write_requests: usize,
    /// Maximum authenticated requests one account may make in a fixed minute.
    ///
    /// This is a persistent, PostgreSQL-backed admission gate rather than a
    /// per-process cache, so a burst cannot evade it by reaching another API
    /// instance.
    pub max_authenticated_account_requests_per_minute: i32,
    pub max_concurrent_password_operations: usize,
    /// How long a request may wait for an execution slot.
    ///
    /// This is deliberately short: overload is surfaced as retryable 503
    /// instead of accumulating enough queued work to dominate tail latency.
    pub request_queue_timeout: Duration,
    pub request_timeout: Duration,
    pub body_limit_bytes: usize,
    pub run_migrations: bool,
    pub trust_loopback_proxy_headers: bool,
    pub smtp: Option<SmtpConfig>,
    pub sms: Option<TencentSmsConfig>,
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

#[derive(Clone)]
pub struct TencentSmsConfig {
    pub secret_id: String,
    pub secret_key: SecretString,
    pub sdk_app_id: String,
    pub sign_name: String,
    pub template_id: String,
    pub region: String,
    pub daily_send_limit: u32,
}

impl std::fmt::Debug for TencentSmsConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TencentSmsConfig")
            .field("credentials", &"[REDACTED]")
            .field("region", &self.region)
            .field("daily_send_limit", &self.daily_send_limit)
            .finish_non_exhaustive()
    }
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
        let sms = sms_config()?;
        Ok(Self {
            bind,
            listen_backlog: parsed_positive::<u32>("KUNPENG_SYNC_LISTEN_BACKLOG", "1024")?,
            database_url: SecretString::from(database_url),
            token_hmac_key: SecretString::from(token_hmac_key),
            database_max_connections: parsed_positive(
                "KUNPENG_SYNC_DATABASE_MAX_CONNECTIONS",
                "16",
            )?,
            database_acquire_timeout: Duration::from_millis(parsed_positive(
                "KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS",
                "300",
            )?),
            max_concurrent_requests: parsed_positive("KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS", "12")?,
            max_concurrent_checkpoint_requests: parsed_positive(
                "KUNPENG_SYNC_MAX_CONCURRENT_CHECKPOINT_REQUESTS",
                "18",
            )?,
            max_queued_read_requests: parsed_positive(
                "KUNPENG_SYNC_MAX_QUEUED_READ_REQUESTS",
                "64",
            )?,
            max_queued_checkpoint_requests: parsed_positive(
                "KUNPENG_SYNC_MAX_QUEUED_CHECKPOINT_REQUESTS",
                "24",
            )?,
            max_concurrent_write_requests: parsed_positive(
                "KUNPENG_SYNC_MAX_CONCURRENT_WRITE_REQUESTS",
                "10",
            )?,
            max_queued_write_requests: parsed_positive(
                "KUNPENG_SYNC_MAX_QUEUED_WRITE_REQUESTS",
                "48",
            )?,
            max_authenticated_account_requests_per_minute: parsed_positive(
                "KUNPENG_SYNC_MAX_AUTHENTICATED_ACCOUNT_REQUESTS_PER_MINUTE",
                "600",
            )?,
            max_concurrent_password_operations: parsed_positive(
                "KUNPENG_SYNC_MAX_CONCURRENT_PASSWORD_OPERATIONS",
                "4",
            )?,
            request_queue_timeout: Duration::from_millis(parsed_positive(
                "KUNPENG_SYNC_REQUEST_QUEUE_TIMEOUT_MILLIS",
                "200",
            )?),
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
            sms,
        })
    }

    #[doc(hidden)]
    #[must_use]
    pub fn for_test(database_url: &str) -> Self {
        Self {
            bind: SocketAddr::from_str("127.0.0.1:0").expect("test bind address"),
            listen_backlog: 128,
            database_url: SecretString::from(database_url.to_owned()),
            token_hmac_key: SecretString::from("test-only-key-with-at-least-32-bytes".to_owned()),
            database_max_connections: 2,
            database_acquire_timeout: Duration::from_millis(100),
            max_concurrent_requests: 8,
            max_concurrent_checkpoint_requests: 2,
            max_queued_read_requests: 16,
            max_queued_checkpoint_requests: 4,
            max_concurrent_write_requests: 4,
            max_queued_write_requests: 8,
            max_authenticated_account_requests_per_minute: 600,
            max_concurrent_password_operations: 2,
            request_queue_timeout: Duration::from_millis(100),
            // Password authentication deliberately uses a memory-hard Argon2id
            // verification.  Keep the integration-test router aligned with the
            // production request budget so a low-spec CI/isolated PostgreSQL
            // runner does not turn a valid login into a synthetic 504.
            request_timeout: Duration::from_secs(15),
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
            sms: None,
        }
    }
}

fn sms_config() -> Result<Option<TencentSmsConfig>> {
    let Some(secret_id) = optional("KUNPENG_SYNC_TENCENT_SMS_SECRET_ID") else {
        for name in [
            "KUNPENG_SYNC_TENCENT_SMS_SECRET_KEY",
            "KUNPENG_SYNC_TENCENT_SMS_SDK_APP_ID",
            "KUNPENG_SYNC_TENCENT_SMS_SIGN_NAME",
            "KUNPENG_SYNC_TENCENT_SMS_TEMPLATE_ID",
        ] {
            if optional(name).is_some() {
                bail!("{name} requires KUNPENG_SYNC_TENCENT_SMS_SECRET_ID");
            }
        }
        return Ok(None);
    };
    let secret_key = required("KUNPENG_SYNC_TENCENT_SMS_SECRET_KEY")?;
    if secret_key.len() < 16 {
        bail!("KUNPENG_SYNC_TENCENT_SMS_SECRET_KEY must contain at least 16 bytes");
    }
    Ok(Some(TencentSmsConfig {
        secret_id,
        secret_key: SecretString::from(secret_key),
        sdk_app_id: required("KUNPENG_SYNC_TENCENT_SMS_SDK_APP_ID")?,
        sign_name: required("KUNPENG_SYNC_TENCENT_SMS_SIGN_NAME")?,
        template_id: required("KUNPENG_SYNC_TENCENT_SMS_TEMPLATE_ID")?,
        region: value("KUNPENG_SYNC_TENCENT_SMS_REGION", "ap-guangzhou"),
        daily_send_limit: parsed_positive("KUNPENG_SYNC_TENCENT_SMS_DAILY_SEND_LIMIT", "100")?,
    }))
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

fn optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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
        let mut config = Config::for_test("postgresql://user:password@localhost/database");
        config.sms = Some(TencentSmsConfig {
            secret_id: "secret-id-must-not-leak".to_owned(),
            secret_key: SecretString::from("secret-key-must-not-leak".to_owned()),
            sdk_app_id: "sdk-app-id-must-not-leak".to_owned(),
            sign_name: "sign-name-must-not-leak".to_owned(),
            template_id: "template-id-must-not-leak".to_owned(),
            region: "ap-guangzhou".to_owned(),
            daily_send_limit: 10,
        });
        let debug = format!("{config:?}");
        assert!(!debug.contains("postgresql://user:password"));
        assert!(!debug.contains("test-only-key"));
        for sensitive in [
            "secret-id",
            "secret-key",
            "sdk-app-id",
            "sign-name",
            "template-id",
        ] {
            assert!(!debug.contains(sensitive));
        }
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
