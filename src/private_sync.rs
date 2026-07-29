//! Optional cross-device sync for AI configuration, history and credentials.
//!
//! Public configuration is intentionally separate from credentials. The sync
//! server only sees JSON for the public options and an opaque AES-GCM envelope
//! for secrets; the password is never stored locally or sent to the server.

use crate::{ai_reader, db::AppDb, sync, translate, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::num::NonZeroU32;
use tauri::Manager;

const OPTIONS_KEY: &str = "private_sync_options_v1";
const HISTORY_PREFIX: &str = "private_sync_ai_history_v1:";
const AI_CONFIG_KIND: &str = "ai_reader_config_v1";
const TRANSLATE_CONFIG_KIND: &str = "translation_config_v1";
const HISTORY_KIND: &str = "ai_reader_history_v1";
const SECRET_KIND: &str = "secret_bundle_v1";
const DEFAULT_ID: &str = "default";
const KDF_ITERATIONS: u32 = 210_000;
const AAD: &[u8] = b"kunpeng-reader:secret_bundle_v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrivateSyncOptions {
    #[serde(default = "default_true")]
    pub sync_configs: bool,
    #[serde(default)]
    pub sync_ai_history: bool,
    #[serde(default)]
    pub sync_secrets: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PrivateSyncOptions {
    fn default() -> Self {
        Self {
            sync_configs: true,
            sync_ai_history: false,
            sync_secrets: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryMergeRequest {
    pub content_id: String,
    pub entries: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrivateSyncStatus {
    #[serde(flatten)]
    pub options: PrivateSyncOptions,
    pub cloud_secret_available: bool,
}

#[derive(Serialize, Deserialize)]
struct SecretBundle {
    version: u8,
    #[serde(default)]
    ai_reader: Option<Value>,
    #[serde(default)]
    translations: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedEnvelope {
    version: u8,
    #[serde(default)]
    epoch: u64,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn options_from_db(db: &AppDb) -> PrivateSyncOptions {
    db.metadata(OPTIONS_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn history_key(content_id: &str) -> String {
    format!("{HISTORY_PREFIX}{content_id}")
}

fn valid_content_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalized_entries(mut entries: Vec<Value>) -> Vec<Value> {
    entries.retain(|entry| {
        entry.is_object()
            && serde_json::to_string(entry)
                .map(|v| v.len() <= 32_000)
                .unwrap_or(false)
    });
    entries.sort_by(|left, right| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    let mut unique = Vec::new();
    for entry in entries {
        let duplicate = unique.iter().any(|known: &Value| {
            known.get("at") == entry.get("at")
                && known.get("question") == entry.get("question")
                && known.get("content") == entry.get("content")
        });
        if !duplicate {
            unique.push(entry);
        }
        if unique.len() == 40 {
            break;
        }
    }
    unique
}

fn read_history(db: &AppDb, content_id: &str) -> Vec<Value> {
    db.metadata(&history_key(content_id))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
        .map(normalized_entries)
        .unwrap_or_default()
}

fn write_history(db: &AppDb, content_id: &str, entries: Vec<Value>) -> Result<(), String> {
    db.set_metadata(
        &history_key(content_id),
        &serde_json::to_string(&serde_json::json!({
            "version": 1,
            "contentId": content_id,
            "entries": normalized_entries(entries),
        }))
        .map_err(|e| e.to_string())?,
    )
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    if password.chars().count() < 10 {
        return Err("同步密码至少需要 10 个字符".into());
    }
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(KDF_ITERATIONS).expect("constant is nonzero"),
        salt,
        password.as_bytes(),
        &mut key,
    );
    Ok(key)
}

fn encrypt_bundle(password: &str, bundle: &SecretBundle, epoch: u64) -> Result<Value, String> {
    if epoch == 0 {
        return Err("云端密钥包世代无效，请稍后重试".into());
    }
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rng.fill(&mut salt).map_err(|_| "无法生成加密随机数")?;
    rng.fill(&mut nonce).map_err(|_| "无法生成加密随机数")?;
    let key = derive_key(password, &salt)?;
    let unbound =
        aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "无法创建加密密钥")?;
    let key = aead::LessSafeKey::new(unbound);
    let mut ciphertext = serde_json::to_vec(bundle).map_err(|e| e.to_string())?;
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(AAD),
        &mut ciphertext,
    )
    .map_err(|_| "密钥包加密失败")?;
    serde_json::to_value(EncryptedEnvelope {
        version: 2,
        epoch,
        kdf: "PBKDF2-HMAC-SHA256/AES-256-GCM".into(),
        iterations: KDF_ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|e| e.to_string())
}

fn decrypt_bundle(password: &str, value: &Value) -> Result<SecretBundle, String> {
    let envelope: EncryptedEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| "云端密钥包格式无效")?;
    if !(envelope.version == 1 || envelope.version == 2)
        || envelope.iterations != KDF_ITERATIONS
        || envelope.kdf != "PBKDF2-HMAC-SHA256/AES-256-GCM"
    {
        return Err("云端密钥包版本不受支持".into());
    }
    let salt = STANDARD
        .decode(envelope.salt)
        .map_err(|_| "云端密钥包盐值无效")?;
    let nonce = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| "云端密钥包随机数无效")?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("云端密钥包长度无效".into());
    }
    let key = derive_key(password, &salt)?;
    let unbound =
        aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "无法创建解密密钥")?;
    let key = aead::LessSafeKey::new(unbound);
    let mut ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| "云端密钥包密文无效")?;
    let plaintext = key
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(&nonce).map_err(|_| "云端密钥包随机数无效")?,
            aead::Aad::from(AAD),
            &mut ciphertext,
        )
        .map_err(|_| "同步密码不正确，或云端密钥包已损坏")?;
    serde_json::from_slice(plaintext).map_err(|_| "云端密钥包内容无效".into())
}

fn envelope_epoch(value: &Value) -> Result<u64, String> {
    let envelope: EncryptedEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| "云端密钥包格式无效")?;
    match envelope.version {
        1 => Ok(1),
        2 if envelope.epoch > 0 => Ok(envelope.epoch),
        _ => Err("云端密钥包世代无效".into()),
    }
}

fn materialize(db: &mut AppDb) -> Result<(), String> {
    let options = options_from_db(db);
    if options.sync_configs {
        let mut entities = Vec::new();
        // A malformed local API configuration must never prevent ordinary
        // reading-state sync. The user can repair it from the reader panel.
        if let Ok(Some(value)) = ai_reader::export_public_config(db) {
            entities.push((AI_CONFIG_KIND.to_string(), DEFAULT_ID.to_string(), value));
        }
        entities.push((
            TRANSLATE_CONFIG_KIND.to_string(),
            DEFAULT_ID.to_string(),
            translate::export_public_config(db)?,
        ));
        db.upsert_json_batch(&entities)?;
    } else {
        db.soft_delete(AI_CONFIG_KIND, DEFAULT_ID)?;
        db.soft_delete(TRANSLATE_CONFIG_KIND, DEFAULT_ID)?;
    }
    for (key, text) in db.metadata_with_prefix(HISTORY_PREFIX)? {
        let Some(content_id) = key.strip_prefix(HISTORY_PREFIX) else {
            continue;
        };
        if options.sync_ai_history {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                db.upsert_json_batch(&[(HISTORY_KIND.to_string(), content_id.to_string(), value)])?;
            }
        } else {
            db.soft_delete(HISTORY_KIND, content_id)?;
        }
    }
    if !options.sync_secrets {
        db.soft_delete(SECRET_KIND, DEFAULT_ID)?;
    }
    Ok(())
}

pub(crate) fn append_sync_entities(db: &mut AppDb) -> Result<(), String> {
    materialize(db)
}

pub(crate) fn apply_downloaded_entities(
    state: &AppState,
    items: &[crate::db::SyncEntity],
) -> Result<(), String> {
    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    let options = options_from_db(db);
    for item in items.iter().filter(|item| item.deleted_at == 0) {
        match item.kind.as_str() {
            AI_CONFIG_KIND if options.sync_configs => {
                ai_reader::import_public_config(db, &item.json)?
            }
            HISTORY_KIND if options.sync_ai_history && valid_content_id(&item.id) => {
                let mut merged = read_history(db, &item.id);
                if let Some(remote) = item.json.get("entries").and_then(Value::as_array) {
                    merged.extend(remote.iter().cloned());
                }
                write_history(db, &item.id, merged)?;
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn private_sync_get_settings(
    state: tauri::State<AppState>,
) -> Result<PrivateSyncStatus, String> {
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(PrivateSyncStatus {
        options: options_from_db(db),
        cloud_secret_available: db.entity_json(SECRET_KIND, DEFAULT_ID)?.is_some(),
    })
}

#[tauri::command]
pub(crate) fn private_sync_set_options(
    state: tauri::State<AppState>,
    options: PrivateSyncOptions,
) -> Result<PrivateSyncStatus, String> {
    let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
    db.set_metadata(
        OPTIONS_KEY,
        &serde_json::to_string(&options).map_err(|e| e.to_string())?,
    )?;
    materialize(db)?;
    Ok(PrivateSyncStatus {
        options,
        cloud_secret_available: db.entity_json(SECRET_KIND, DEFAULT_ID)?.is_some(),
    })
}

#[tauri::command]
pub(crate) fn private_sync_history_list(
    state: tauri::State<AppState>,
    content_id: String,
) -> Result<Vec<Value>, String> {
    if !valid_content_id(&content_id) {
        return Ok(Vec::new());
    }
    let guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(read_history(db, &content_id))
}

#[tauri::command]
pub(crate) fn private_sync_history_merge(
    state: tauri::State<AppState>,
    request: HistoryMergeRequest,
) -> Result<(), String> {
    if !valid_content_id(&request.content_id) {
        return Err("图书同步身份无效；请重新导入原书后再同步智读历史".into());
    }
    let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
    let mut merged = read_history(db, &request.content_id);
    merged.extend(request.entries);
    write_history(db, &request.content_id, merged)?;
    materialize(db)
}

#[tauri::command]
pub(crate) async fn private_sync_set_password(
    app: tauri::AppHandle,
    password: String,
) -> Result<PrivateSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let epoch = sync::private_secret_bundle_state(state.inner())?.secret_bundle_epoch;
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let bundle = SecretBundle {
            version: 1,
            ai_reader: ai_reader::export_secret_config(db)?,
            translations: translate::export_secret_configs(db)?,
        };
        if bundle.ai_reader.is_none() && bundle.translations.is_empty() {
            return Err("本机还没有可同步的智读或翻译密钥".into());
        }
        let encrypted = encrypt_bundle(&password, &bundle, epoch)?;
        db.upsert_json_batch(&[(SECRET_KIND.to_string(), DEFAULT_ID.to_string(), encrypted)])?;
        let mut options = options_from_db(db);
        options.sync_secrets = true;
        db.set_metadata(
            OPTIONS_KEY,
            &serde_json::to_string(&options).map_err(|e| e.to_string())?,
        )?;
        Ok(PrivateSyncStatus {
            options,
            cloud_secret_available: true,
        })
    })
    .await
    .map_err(|e| format!("加密密钥任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn private_sync_unlock_secrets(
    app: tauri::AppHandle,
    password: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let expected_epoch = sync::private_secret_bundle_state(state.inner())?.secret_bundle_epoch;
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let value = db
            .entity_json(SECRET_KIND, DEFAULT_ID)?
            .ok_or("云端没有可解锁的密钥包；请先同步或在拥有密钥的设备重新加密")?;
        if envelope_epoch(&value)? != expected_epoch {
            return Err("云端密钥包已被撤销；请在拥有 API Key 的设备重新设置同步密码".into());
        }
        let bundle = decrypt_bundle(&password, &value)?;
        if let Some(config) = bundle.ai_reader {
            ai_reader::import_secret_config(db, &config)?;
        }
        translate::import_secret_configs(db, &bundle.translations)
    })
    .await
    .map_err(|e| format!("解锁密钥任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn private_sync_forget_password(
    app: tauri::AppHandle,
) -> Result<PrivateSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _state = sync::reset_private_secret_bundle_state(state.inner())?;
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        db.soft_delete(SECRET_KIND, DEFAULT_ID)?;
        let mut options = options_from_db(db);
        options.sync_secrets = false;
        db.set_metadata(
            OPTIONS_KEY,
            &serde_json::to_string(&options).map_err(|e| e.to_string())?,
        )?;
        Ok(PrivateSyncStatus {
            options,
            cloud_secret_available: false,
        })
    })
    .await
    .map_err(|e| format!("撤销云端密钥任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_bundle_is_unreadable_without_the_sync_password() {
        let bundle = SecretBundle {
            version: 1,
            ai_reader: Some(serde_json::json!({"api_key":"secret"})),
            translations: vec![],
        };
        let encrypted = encrypt_bundle("a long enough sync password", &bundle, 1).unwrap();
        assert!(encrypted.get("ciphertext").is_some());
        assert!(decrypt_bundle("wrong long password", &encrypted).is_err());
        let opened = decrypt_bundle("a long enough sync password", &encrypted).unwrap();
        assert_eq!(opened.ai_reader.unwrap()["api_key"], "secret");
    }

    #[test]
    fn history_deduplicates_and_caps_at_forty_entries() {
        let entries = (0..45)
            .map(|i| serde_json::json!({"at": format!("2026-07-29T00:{i:02}:00Z"), "question": "q", "content": i}))
            .collect::<Vec<_>>();
        let normalized = normalized_entries(entries);
        assert_eq!(normalized.len(), 40);
        assert!(valid_content_id(&"a".repeat(64)));
    }
}
