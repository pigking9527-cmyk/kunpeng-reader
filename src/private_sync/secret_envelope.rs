//! Password-based encryption for the opaque private-sync secret bundle.
//!
//! This module is deliberately free of database, Tauri, and network access.
//! Callers own server-epoch validation and the local compare-and-swap guard;
//! this boundary only validates and transforms the serialized envelope.

use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::num::NonZeroU32;

const KDF_ITERATIONS: u32 = 210_000;
const AAD: &[u8] = b"kunpeng-reader:secret_bundle_v1";

#[derive(PartialEq, Serialize, Deserialize)]
pub(super) struct SecretBundle {
    pub(super) version: u8,
    #[serde(default)]
    pub(super) ai_reader: Option<Value>,
    #[serde(default)]
    pub(super) translations: Vec<Value>,
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

pub(super) fn encrypt_bundle(
    password: &str,
    bundle: &SecretBundle,
    epoch: u64,
) -> Result<Value, String> {
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

pub(super) fn decrypt_bundle(password: &str, value: &Value) -> Result<SecretBundle, String> {
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

pub(super) fn envelope_epoch(value: &Value) -> Result<u64, String> {
    let envelope: EncryptedEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| "云端密钥包格式无效")?;
    match envelope.version {
        1 => Ok(1),
        2 if envelope.epoch > 0 => Ok(envelope.epoch),
        _ => Err("云端密钥包世代无效".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_password_shorter_than_ten_characters() {
        let bundle = SecretBundle {
            version: 1,
            ai_reader: None,
            translations: Vec::new(),
        };
        assert_eq!(
            encrypt_bundle("too-short", &bundle, 1).unwrap_err(),
            "同步密码至少需要 10 个字符"
        );
    }

    #[test]
    fn requires_a_positive_epoch_for_new_envelopes() {
        let bundle = SecretBundle {
            version: 1,
            ai_reader: None,
            translations: Vec::new(),
        };
        assert_eq!(
            encrypt_bundle("a long enough sync password", &bundle, 0).unwrap_err(),
            "云端密钥包世代无效，请稍后重试"
        );
    }

    #[test]
    fn legacy_envelope_maps_to_epoch_one() {
        let value = serde_json::json!({
            "version": 1,
            "kdf": "PBKDF2-HMAC-SHA256/AES-256-GCM",
            "iterations": KDF_ITERATIONS,
            "salt": "",
            "nonce": "",
            "ciphertext": ""
        });
        assert_eq!(envelope_epoch(&value).unwrap(), 1);
    }
}
