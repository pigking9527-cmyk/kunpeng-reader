use std::time::Duration;

use anyhow::{Context, Result};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox,
    transport::smtp::authentication::Credentials,
};
use secrecy::ExposeSecret;
use serde_json::Value;
use sqlx::{FromRow, types::Json as SqlJson};
use tokio::{task::JoinHandle, time::sleep};
use uuid::Uuid;

use crate::{
    config::{SmtpConfig, SmtpTlsMode},
    state::AppState,
};

const CLAIM_MS: i64 = 60_000;
const MAX_ATTEMPTS: i32 = 8;
const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, FromRow)]
struct OutboxRow {
    id: Uuid,
    kind: String,
    recipient: String,
    payload: SqlJson<Value>,
    attempts: i32,
}

/// Starts the SMTP outbox worker when mail delivery is configured.
///
/// # Errors
///
/// Returns an error when the SMTP relay or sender address is invalid.
pub fn spawn_worker(state: AppState) -> Result<Option<JoinHandle<()>>> {
    let Some(config) = state.config.smtp.clone() else {
        return Ok(None);
    };
    let _: Mailbox = config.from.parse().context("invalid SMTP from address")?;
    let transport = transport(&config)?;
    Ok(Some(tokio::spawn(async move {
        loop {
            match claim(&state).await {
                Ok(Some(row)) => deliver(&state, &config, &transport, row).await,
                Ok(None) | Err(_) => sleep(Duration::from_secs(2)).await,
            }
        }
    })))
}

fn transport(config: &SmtpConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let mut builder = match config.tls_mode {
        SmtpTlsMode::Implicit => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host),
        SmtpTlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host),
    }
    .context("invalid SMTP relay")?
    .port(config.port);
    if let (Some(username), Some(password)) = (&config.username, &config.password) {
        builder = builder.credentials(Credentials::new(
            username.clone(),
            password.expose_secret().to_owned(),
        ));
    }
    Ok(builder.build())
}

async fn claim(state: &AppState) -> Result<Option<OutboxRow>, sqlx::Error> {
    let now = now_ms();
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM mail_outbox_v4 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM registration_challenges_v4 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM password_reset_challenges_v4 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM account_email_challenges_v5 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM account_email_rebind_grants_v5 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    let row = sqlx::query_as::<_, OutboxRow>(
        "SELECT id,kind,recipient,payload,attempts FROM mail_outbox_v4 \
         WHERE delivered_at=0 AND attempts<$1 AND available_at<=$2 \
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    )
    .bind(MAX_ATTEMPTS)
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(row) = &row {
        sqlx::query("UPDATE mail_outbox_v4 SET attempts=attempts+1,available_at=$2 WHERE id=$1")
            .bind(row.id)
            .bind(now.saturating_add(CLAIM_MS))
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(row)
}

async fn deliver(
    state: &AppState,
    config: &SmtpConfig,
    transport: &AsyncSmtpTransport<Tokio1Executor>,
    row: OutboxRow,
) {
    let Ok(message) = build_message(config, &row) else {
        mark_failure(state, &row).await;
        return;
    };
    let send_result = transport.send(message).await.map(|_| ());
    match send_result {
        Ok(()) => {
            let _ = sqlx::query(
                "UPDATE mail_outbox_v4 SET delivered_at=$2,payload='{}'::jsonb,last_error='' \
                 WHERE id=$1",
            )
            .bind(row.id)
            .bind(now_ms())
            .execute(&state.pool)
            .await;
        }
        Err(_) => mark_failure(state, &row).await,
    }
}

fn build_message(config: &SmtpConfig, row: &OutboxRow) -> Result<Message> {
    let code = row.payload["code"]
        .as_str()
        .context("registration mail code is missing")?;
    let from: Mailbox = config.from.parse().context("invalid SMTP from address")?;
    let to: Mailbox = row.recipient.parse().context("invalid recipient address")?;
    let (subject, body) = match row.kind.as_str() {
        "registration_verification" => (
            "鲲鹏阅读器注册验证码",
            format!("你的注册验证码是：{code}\n\n验证码 15 分钟内有效，请勿转发。"),
        ),
        "password_reset" => (
            "鲲鹏阅读器密码重置验证码",
            format!("你的密码重置验证码是：{code}\n\n验证码 15 分钟内有效，请勿转发。"),
        ),
        "bind_email" => (
            "鲲鹏阅读器绑定邮箱验证码",
            format!("你的绑定邮箱验证码是：{code}\n\n验证码 15 分钟内有效，请勿转发。"),
        ),
        "rebind_old" => (
            "鲲鹏阅读器更换邮箱确认",
            format!(
                "你的旧邮箱验证码是：{code}\n\n验证码 15 分钟内有效。若非本人操作，请修改登录密码。"
            ),
        ),
        "rebind_new" => (
            "鲲鹏阅读器确认新绑定邮箱",
            format!("你的新邮箱验证码是：{code}\n\n验证码 15 分钟内有效，请勿转发。"),
        ),
        _ => anyhow::bail!("unsupported mail outbox kind"),
    };
    Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .body(body)
        .context("failed to build registration email")
}

async fn mark_failure(state: &AppState, row: &OutboxRow) {
    let backoff_ms = i64::from(2_i32.saturating_pow(row.attempts.clamp(1, 10).cast_unsigned()))
        .saturating_mul(1_000)
        .min(15 * 60 * 1_000);
    let _ = sqlx::query("UPDATE mail_outbox_v4 SET available_at=$2,last_error=$3 WHERE id=$1")
        .bind(row.id)
        .bind(now_ms().saturating_add(backoff_ms))
        .bind("delivery failed")
        .execute(&state.pool)
        .await;
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
