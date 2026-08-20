use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use hmac::{Hmac, KeyInit, Mac};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, types::Json as SqlJson};
use tokio::{task::JoinHandle, time::sleep};
use uuid::Uuid;

use crate::{config::TencentSmsConfig, state::AppState};

const ENDPOINT: &str = "https://sms.tencentcloudapi.com";
const HOST: &str = "sms.tencentcloudapi.com";
const SERVICE: &str = "sms";
const API_VERSION: &str = "2021-01-11";
const CLAIM_MS: i64 = 60_000;
const MAX_ATTEMPTS: i32 = 5;
const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, FromRow)]
struct OutboxRow {
    id: Uuid,
    recipient: String,
    payload: SqlJson<Value>,
    attempts: i32,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SendSmsRequest<'a> {
    phone_number_set: [&'a str; 1],
    sms_sdk_app_id: &'a str,
    sign_name: &'a str,
    template_id: &'a str,
    template_param_set: [&'a str; 2],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SendSmsEnvelope {
    response: SendSmsResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SendSmsResponse {
    #[serde(default)]
    send_status_set: Vec<SendStatus>,
    error: Option<TencentError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SendStatus {
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TencentError {
    code: String,
}

/// Starts the SMS outbox worker only when a provider is fully configured.
///
/// # Errors
///
/// Returns an error when the HTTPS client cannot be created.
pub fn spawn_worker(state: AppState) -> Result<Option<JoinHandle<()>>> {
    let config = state.config.sms.clone();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .https_only(true)
        .build()
        .into();
    Ok(Some(tokio::spawn(async move {
        loop {
            if let Ok(Some(row)) = claim(&state, config.is_some()).await {
                if let Some(config) = &config {
                    deliver(&state, config, &agent, row).await;
                }
            } else {
                let interval = if config.is_some() { 2 } else { 60 };
                sleep(Duration::from_secs(interval)).await;
            }
        }
    })))
}

async fn claim(state: &AppState, delivery_enabled: bool) -> Result<Option<OutboxRow>, sqlx::Error> {
    let now = now_ms();
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM sms_outbox_v5 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM phone_registration_challenges_v5 WHERE created_at<$1")
        .bind(now.saturating_sub(RETENTION_MS))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM sms_daily_usage_v5 WHERE utc_day<$1")
        .bind(utc_day(now).saturating_sub(2))
        .execute(&mut *transaction)
        .await?;
    if !delivery_enabled {
        transaction.commit().await?;
        return Ok(None);
    }
    let row = sqlx::query_as::<_, OutboxRow>(
        "SELECT id,recipient,payload,attempts,created_at FROM sms_outbox_v5 \
         WHERE delivered_at=0 AND attempts<$1 AND available_at<=$2 AND recipient<>'' \
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    )
    .bind(MAX_ATTEMPTS)
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(row) = &row {
        sqlx::query("UPDATE sms_outbox_v5 SET attempts=attempts+1,available_at=$2 WHERE id=$1")
            .bind(row.id)
            .bind(now.saturating_add(CLAIM_MS))
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(row)
}

async fn deliver(state: &AppState, config: &TencentSmsConfig, agent: &ureq::Agent, row: OutboxRow) {
    let Some(code) = row.payload.get("code").and_then(Value::as_str) else {
        mark_terminal_failure(state, row.id).await;
        return;
    };
    let Some(expires_minutes) = row.payload.get("expiresMinutes").and_then(Value::as_str) else {
        mark_terminal_failure(state, row.id).await;
        return;
    };
    let send_config = config.clone();
    let send_agent = agent.clone();
    let phone = row.recipient.clone();
    let code = code.to_owned();
    let expires_minutes = expires_minutes.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        send(&send_config, &send_agent, &phone, &code, &expires_minutes)
    })
    .await
    .unwrap_or(Err(()));
    match result {
        Ok(()) => {
            let now = now_ms();
            if let Ok(mut transaction) = state.pool.begin().await {
                let cleared = sqlx::query(
                    "UPDATE sms_outbox_v5 SET delivered_at=$2,recipient='',payload='{}'::jsonb,last_error='' \
                     WHERE id=$1 AND delivered_at=0",
                )
                .bind(row.id)
                .bind(now)
                .execute(&mut *transaction)
                .await;
                if cleared
                    .as_ref()
                    .is_ok_and(|result| result.rows_affected() == 1)
                {
                    let _ = sqlx::query(
                        "UPDATE sms_daily_usage_v5 SET delivered=delivered+1 WHERE utc_day=$1",
                    )
                    .bind(utc_day(row.created_at))
                    .execute(&mut *transaction)
                    .await;
                    let _ = transaction.commit().await;
                }
            }
        }
        Err(()) if row.attempts + 1 >= MAX_ATTEMPTS => mark_terminal_failure(state, row.id).await,
        Err(()) => {
            let backoff_ms =
                i64::from(2_i32.saturating_pow(row.attempts.clamp(1, 10).cast_unsigned()))
                    .saturating_mul(1_000)
                    .min(15 * 60 * 1_000);
            let _ = sqlx::query(
                "UPDATE sms_outbox_v5 SET available_at=$2,last_error='delivery failed' WHERE id=$1",
            )
            .bind(row.id)
            .bind(now_ms().saturating_add(backoff_ms))
            .execute(&state.pool)
            .await;
        }
    }
}

async fn mark_terminal_failure(state: &AppState, id: Uuid) {
    let _ = sqlx::query(
        "UPDATE sms_outbox_v5 SET recipient='',payload='{}'::jsonb,attempts=$2, \
         last_error='delivery failed' WHERE id=$1",
    )
    .bind(id)
    .bind(MAX_ATTEMPTS)
    .execute(&state.pool)
    .await;
}

fn send(
    config: &TencentSmsConfig,
    agent: &ureq::Agent,
    phone: &str,
    code: &str,
    expires_minutes: &str,
) -> Result<(), ()> {
    let request = SendSmsRequest {
        phone_number_set: [phone],
        sms_sdk_app_id: &config.sdk_app_id,
        sign_name: &config.sign_name,
        template_id: &config.template_id,
        template_param_set: [code, expires_minutes],
    };
    let payload = serde_json::to_vec(&request).map_err(|_| ())?;
    let (timestamp, date) = timestamp_and_date().ok_or(())?;
    let headers = signed_headers(config, &payload, timestamp, &date).map_err(|_| ())?;
    let mut response = agent
        .post(ENDPOINT)
        .header("Authorization", &headers.authorization)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", HOST)
        .header("X-TC-Action", "SendSms")
        .header("X-TC-Timestamp", &timestamp.to_string())
        .header("X-TC-Version", API_VERSION)
        .header("X-TC-Region", &config.region)
        .send(payload.as_slice())
        .map_err(|_| ())?;
    let response: SendSmsEnvelope = response.body_mut().read_json().map_err(|_| ())?;
    if response.response.error.is_some() {
        let _provider_code = response.response.error.as_ref().map(|error| &error.code);
        return Err(());
    }
    response
        .response
        .send_status_set
        .first()
        .filter(|status| status.code == "Ok")
        .map(|_| ())
        .ok_or(())
}

struct SignedHeaders {
    authorization: String,
}

fn signed_headers(
    config: &TencentSmsConfig,
    payload: &[u8],
    timestamp: i64,
    date: &str,
) -> Result<SignedHeaders> {
    let content_type = "application/json; charset=utf-8";
    let action = "sendsms";
    let canonical_headers =
        format!("content-type:{content_type}\nhost:{HOST}\nx-tc-action:{action}\n");
    let signed_headers = "content-type;host;x-tc-action";
    let hashed_payload = hex(&Sha256::digest(payload));
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}");
    let scope = format!("{date}/{SERVICE}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        hex(&Sha256::digest(canonical_request.as_bytes()))
    );
    let secret_date = hmac(
        format!("TC3{}", config.secret_key.expose_secret()).as_bytes(),
        date.as_bytes(),
    )?;
    let secret_service = hmac(&secret_date, SERVICE.as_bytes())?;
    let secret_signing = hmac(&secret_service, b"tc3_request")?;
    let signature = hex(&hmac(&secret_signing, string_to_sign.as_bytes())?);
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        config.secret_id
    );
    Ok(SignedHeaders { authorization })
}

fn hmac(key: &[u8], value: &[u8]) -> Result<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).context("invalid SMS signing key")?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn timestamp_and_date() -> Option<(i64, String)> {
    let timestamp =
        i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()?;
    let date = unix_days_to_date(timestamp.div_euclid(86_400));
    Some((timestamp, date))
}

fn unix_days_to_date(days_since_epoch: i64) -> String {
    // Howard Hinnant's civil-from-days algorithm. TC3 only needs the current
    // UTC date, so a small arithmetic conversion avoids locale and timezone
    // dependencies in the service process.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524
        - day_of_era / 146_096)
        .div_euclid(365);
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2).div_euclid(153);
    let day = day_of_year - (153 * month_prime + 2).div_euclid(5) + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

fn utc_day(now_ms: i64) -> i64 {
    now_ms.div_euclid(24 * 60 * 60 * 1000)
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;

    fn config() -> TencentSmsConfig {
        TencentSmsConfig {
            secret_id: "test-id".to_owned(),
            secret_key: SecretString::from("test-secret-key-value".to_owned()),
            sdk_app_id: "1400000000".to_owned(),
            sign_name: "test".to_owned(),
            template_id: "1000".to_owned(),
            region: "ap-guangzhou".to_owned(),
            daily_send_limit: 100,
        }
    }

    #[test]
    fn tc3_signature_is_deterministic_and_does_not_expose_secret() {
        let headers = signed_headers(&config(), br#"{"test":true}"#, 1_700_000_000, "2023-11-14")
            .expect("signed headers");
        assert!(
            headers
                .authorization
                .starts_with("TC3-HMAC-SHA256 Credential=test-id/2023-11-14/sms/tc3_request")
        );
        assert!(!headers.authorization.contains("test-secret-key-value"));
    }

    #[test]
    fn unix_date_conversion_is_utc_and_leap_year_safe() {
        assert_eq!(unix_days_to_date(0), "1970-01-01");
        assert_eq!(unix_days_to_date(19_782), "2024-02-29");
        assert_eq!(unix_days_to_date(20_089), "2025-01-01");
    }
}
