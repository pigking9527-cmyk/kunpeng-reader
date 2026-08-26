//! Local-only cryptographic primitives for the optional intelligence-host relay.
//!
//! This module deliberately has no HTTP, database, logging, Tauri command, or
//! configuration surface.  It only builds and opens the encrypted envelope
//! described by `contracts/intelligence/host-inference-v1.md`; callers must keep
//! private keys in the OS secret store and must never put [`PrivatePayloadV1`]
//! into a sync entity, diagnostic, or public publication bundle.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(test)]
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, setup_receiver, setup_sender, OpModeR, OpModeS,
};
use hpke::{
    kem::{Kem as _, X25519HkdfSha256},
    Deserializable, Serializable,
};
#[cfg(test)]
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use sha2::{Digest, Sha256};

#[cfg(test)]
const PROTOCOL_LABEL: &[u8] = b"kunpeng-intelligence-host-inference-v1";
#[cfg(test)]
pub const HPKE_SUITE: &str = "HPKE-v1-X25519-HKDF-SHA256-CHACHA20POLY1305";
#[cfg(test)]
const PAYLOAD_SCHEMA_VERSION: u8 = 1;
#[cfg(test)]
const NONCE_BYTES: usize = 24;

type Kem = X25519HkdfSha256;
#[cfg(test)]
type Aead = ChaCha20Poly1305;
#[cfg(test)]
type Kdf = HkdfSha256;

/// Deliberately stable, content-free errors.  In particular, these errors never
/// render ciphertext, a key, a task ID, or decrypted data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostInferenceCryptoError {
    #[cfg(test)]
    InvalidBinding,
    InvalidKey,
    #[cfg(test)]
    InvalidEnvelope,
    #[cfg(test)]
    IntegrityMismatch,
    #[cfg(test)]
    EncryptionFailed,
    #[cfg(test)]
    DecryptionFailed,
    #[cfg(test)]
    PrivatePayloadMismatch,
}

impl std::fmt::Display for HostInferenceCryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            #[cfg(test)]
            Self::InvalidBinding => "主机推理加密绑定无效",
            Self::InvalidKey => "主机推理密钥无效",
            #[cfg(test)]
            Self::InvalidEnvelope => "主机推理密文信封无效",
            #[cfg(test)]
            Self::IntegrityMismatch => "主机推理密文完整性校验失败",
            #[cfg(test)]
            Self::EncryptionFailed => "主机推理加密失败",
            #[cfg(test)]
            Self::DecryptionFailed => "主机推理解密失败",
            #[cfg(test)]
            Self::PrivatePayloadMismatch => "主机推理私有载荷与任务绑定不一致",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for HostInferenceCryptoError {}

/// A public, pairing-scoped key identifier.  It is safe to serialize as part of
/// the relay envelope, unlike [`HostInferencePrivateKey`].
#[derive(Clone, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HostInferenceKeyId(String);

impl HostInferenceKeyId {
    pub fn parse(value: impl Into<String>) -> Result<Self, HostInferenceCryptoError> {
        let value = value.into();
        let suffix = value
            .strip_prefix("key:")
            .ok_or(HostInferenceCryptoError::InvalidKey)?;
        if suffix.is_empty()
            || suffix.len() > 120
            || !suffix.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(HostInferenceCryptoError::InvalidKey);
        }
        Ok(Self(value))
    }

    // The worker-side protocol tests only parse key IDs; pairing uses this
    // accessor in the desktop binary when it persists public metadata.
    #[allow(dead_code)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A public X25519 key received during authenticated account pairing.
#[derive(Clone)]
pub struct HostInferencePublicKey {
    key_id: HostInferenceKeyId,
    encoded: [u8; 32],
}

// The headless worker tests do not perform pairing serialization; desktop
// pairing owns these conversions for the same shared key type.
#[allow(dead_code)]
impl HostInferencePublicKey {
    pub fn from_base64url(
        key_id: HostInferenceKeyId,
        encoded: &str,
    ) -> Result<Self, HostInferenceCryptoError> {
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| HostInferenceCryptoError::InvalidKey)?;
        let encoded: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| HostInferenceCryptoError::InvalidKey)?;
        // Reject malformed curve encodings as early as pairing time.
        <Kem as hpke::Kem>::PublicKey::from_bytes(&encoded)
            .map_err(|_| HostInferenceCryptoError::InvalidKey)?;
        Ok(Self { key_id, encoded })
    }

    pub fn key_id(&self) -> &HostInferenceKeyId {
        &self.key_id
    }

    pub fn base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.encoded)
    }

    #[cfg(test)]
    fn hpke_key(&self) -> Result<<Kem as hpke::Kem>::PublicKey, HostInferenceCryptoError> {
        <Kem as hpke::Kem>::PublicKey::from_bytes(&self.encoded)
            .map_err(|_| HostInferenceCryptoError::InvalidKey)
    }
}

/// An in-memory static X25519 identity key.  It intentionally does not
/// implement `Serialize`, `Deserialize`, `Debug`, `Display`, or any byte export
/// method.  Runtime persistence belongs in the platform secret store, not here.
pub struct HostInferencePrivateKey {
    key_id: HostInferenceKeyId,
    key: <Kem as hpke::Kem>::PrivateKey,
}

#[allow(dead_code)]
impl HostInferencePrivateKey {
    pub fn generate(key_id: HostInferenceKeyId) -> Self {
        let (key, _) = Kem::gen_keypair();
        Self { key_id, key }
    }

    /// Rehydrate an X25519 private key only after its bytes have been read
    /// from the platform secret store.  This type deliberately still has no
    /// serde implementation, `Debug`, or `Display`; callers must never put
    /// this value into a command response, log entry, or regular metadata.
    pub(crate) fn from_platform_secret(
        key_id: HostInferenceKeyId,
        encoded: &str,
    ) -> Result<Self, HostInferenceCryptoError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| HostInferenceCryptoError::InvalidKey)?;
        let key = <Kem as hpke::Kem>::PrivateKey::from_bytes(&bytes)
            .map_err(|_| HostInferenceCryptoError::InvalidKey)?;
        Ok(Self { key_id, key })
    }

    /// Encode solely for an immediately following platform-secret write.
    /// Keeping this crate-visible avoids accidentally advertising private key
    /// export as an application or WebView API.
    pub(crate) fn encode_for_platform_secret(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.to_bytes())
    }

    pub fn key_id(&self) -> &HostInferenceKeyId {
        &self.key_id
    }

    pub fn public_key(&self) -> HostInferencePublicKey {
        let public_key = Kem::sk_to_pk(&self.key);
        let bytes = public_key.to_bytes();
        let encoded: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .expect("X25519 HPKE public keys always serialize to 32 bytes");
        HostInferencePublicKey {
            key_id: self.key_id.clone(),
            encoded,
        }
    }
}

/// Operations accepted by the V1 relay.  Keeping this an enum prevents a caller
/// from accidentally turning the opaque server operation field into a prompt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostInferenceOperation {
    LibraryAnswer,
    LibraryCompare,
    ReadingDeepAnalysis,
    ReadingMemory,
    NewsPreference,
    NewsEvidenceReview,
    CompanionPrompt,
}

/// The direction is authenticated in AAD and repeated inside the private
/// payload, so a result cannot be replayed as a request (or the reverse).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostInferenceDirection {
    Request,
    Result,
}

/// Public task metadata that both ends use to derive exactly the same AAD.
/// These fields are intentionally separate from the encrypted private payload.
#[cfg(test)]
#[derive(Clone, Eq, PartialEq)]
pub struct HostInferenceTaskBinding {
    task_id: String,
    pair_id: String,
    operation: HostInferenceOperation,
    capability_revision: u32,
}

#[cfg(test)]
impl HostInferenceTaskBinding {
    pub fn new(
        task_id: impl Into<String>,
        pair_id: impl Into<String>,
        operation: HostInferenceOperation,
        capability_revision: u32,
    ) -> Result<Self, HostInferenceCryptoError> {
        let task_id = task_id.into();
        let pair_id = pair_id.into();
        if !is_contract_id(&task_id) || !is_contract_id(&pair_id) || capability_revision == 0 {
            return Err(HostInferenceCryptoError::InvalidBinding);
        }
        Ok(Self {
            task_id,
            pair_id,
            operation,
            capability_revision,
        })
    }

    #[allow(dead_code)]
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    #[allow(dead_code)]
    pub fn pair_id(&self) -> &str {
        &self.pair_id
    }

    pub fn operation(&self) -> HostInferenceOperation {
        self.operation
    }

    #[allow(dead_code)]
    pub fn capability_revision(&self) -> u32 {
        self.capability_revision
    }
}

/// Only encrypted fields are serializable.  It exactly mirrors
/// `$defs.encryptedEnvelope` in the V1 contract.
#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEnvelopeV1 {
    pub schema_version: u8,
    pub suite: String,
    pub recipient_key_id: HostInferenceKeyId,
    pub sender_key_id: HostInferenceKeyId,
    pub enc: String,
    pub ciphertext: String,
    pub ciphertext_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression: Option<EnvelopeCompression>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeCompression {
    None,
    Zstd,
}

/// Private JSON that only exists before sealing and after opening.  Do not add
/// `Debug` or a serde conversion to any public relay DTO.
#[cfg(test)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivatePayloadV1 {
    schema_version: u8,
    task_id: String,
    pair_id: String,
    direction: HostInferenceDirection,
    nonce: String,
    payload: serde_json::Value,
}

#[cfg(test)]
impl PrivatePayloadV1 {
    pub fn new(
        binding: &HostInferenceTaskBinding,
        direction: HostInferenceDirection,
        payload: serde_json::Value,
    ) -> Result<Self, HostInferenceCryptoError> {
        let mut nonce = [0_u8; NONCE_BYTES];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| HostInferenceCryptoError::EncryptionFailed)?;
        Ok(Self {
            schema_version: PAYLOAD_SCHEMA_VERSION,
            task_id: binding.task_id.clone(),
            pair_id: binding.pair_id.clone(),
            direction,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            payload,
        })
    }

    pub fn payload(&self) -> &serde_json::Value {
        &self.payload
    }

    fn matches(
        &self,
        binding: &HostInferenceTaskBinding,
        direction: HostInferenceDirection,
    ) -> bool {
        self.schema_version == PAYLOAD_SCHEMA_VERSION
            && self.task_id == binding.task_id
            && self.pair_id == binding.pair_id
            && self.direction == direction
            && URL_SAFE_NO_PAD
                .decode(&self.nonce)
                .map(|nonce| nonce.len() >= 16)
                .unwrap_or(false)
    }
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalAad<'a> {
    task_id: &'a str,
    pair_id: &'a str,
    operation: HostInferenceOperation,
    capability_revision: u32,
    direction: HostInferenceDirection,
}

/// The exact V1 AAD bytes: the fixed protocol label followed immediately by
/// compact canonical JSON with the contract's field order.  This function is
/// public for a future independently implemented host, but it never accepts or
/// returns private content.
#[cfg(test)]
pub fn canonical_aad(
    binding: &HostInferenceTaskBinding,
    direction: HostInferenceDirection,
) -> Result<Vec<u8>, HostInferenceCryptoError> {
    let encoded = serde_json::to_vec(&CanonicalAad {
        task_id: &binding.task_id,
        pair_id: &binding.pair_id,
        operation: binding.operation,
        capability_revision: binding.capability_revision,
        direction,
    })
    .map_err(|_| HostInferenceCryptoError::InvalidBinding)?;
    let mut aad = Vec::with_capacity(PROTOCOL_LABEL.len() + encoded.len());
    aad.extend_from_slice(PROTOCOL_LABEL);
    aad.extend_from_slice(&encoded);
    Ok(aad)
}

/// Seal a client-to-host request.  Both the X25519 sender identity and the task
/// binding are authenticated; the relay server only receives the returned
/// ciphertext envelope.
#[cfg(test)]
pub fn seal_request(
    binding: &HostInferenceTaskBinding,
    client_key: &HostInferencePrivateKey,
    host_key: &HostInferencePublicKey,
    payload: &PrivatePayloadV1,
) -> Result<EncryptedEnvelopeV1, HostInferenceCryptoError> {
    seal_payload(
        binding,
        HostInferenceDirection::Request,
        client_key,
        host_key,
        payload,
    )
}

/// Open a client-to-host request after the host has claimed the task and checked
/// its pairing/capability state.
#[cfg(test)]
pub fn open_request(
    binding: &HostInferenceTaskBinding,
    host_key: &HostInferencePrivateKey,
    client_key: &HostInferencePublicKey,
    envelope: &EncryptedEnvelopeV1,
) -> Result<PrivatePayloadV1, HostInferenceCryptoError> {
    open_payload(
        binding,
        HostInferenceDirection::Request,
        host_key,
        client_key,
        envelope,
    )
}

/// Seal a host-to-client result.  It uses the same V1 suite but a distinct AAD
/// direction, so it cannot be accepted by [`open_request`].
#[cfg(test)]
pub fn seal_result(
    binding: &HostInferenceTaskBinding,
    host_key: &HostInferencePrivateKey,
    client_key: &HostInferencePublicKey,
    payload: &PrivatePayloadV1,
) -> Result<EncryptedEnvelopeV1, HostInferenceCryptoError> {
    seal_payload(
        binding,
        HostInferenceDirection::Result,
        host_key,
        client_key,
        payload,
    )
}

/// Open a host-to-client result after the client has checked task state and
/// capability revision.
#[cfg(test)]
pub fn open_result(
    binding: &HostInferenceTaskBinding,
    client_key: &HostInferencePrivateKey,
    host_key: &HostInferencePublicKey,
    envelope: &EncryptedEnvelopeV1,
) -> Result<PrivatePayloadV1, HostInferenceCryptoError> {
    open_payload(
        binding,
        HostInferenceDirection::Result,
        client_key,
        host_key,
        envelope,
    )
}

#[cfg(test)]
fn seal_payload(
    binding: &HostInferenceTaskBinding,
    direction: HostInferenceDirection,
    sender_key: &HostInferencePrivateKey,
    recipient_key: &HostInferencePublicKey,
    payload: &PrivatePayloadV1,
) -> Result<EncryptedEnvelopeV1, HostInferenceCryptoError> {
    if !payload.matches(binding, direction) {
        return Err(HostInferenceCryptoError::PrivatePayloadMismatch);
    }
    let recipient = recipient_key.hpke_key()?;
    let sender_public = Kem::sk_to_pk(&sender_key.key);
    let sender_mode = OpModeS::Auth((sender_key.key.clone(), sender_public));
    let aad = canonical_aad(binding, direction)?;
    let plaintext =
        serde_json::to_vec(payload).map_err(|_| HostInferenceCryptoError::EncryptionFailed)?;
    let (enc, mut context) =
        setup_sender::<Aead, Kdf, Kem>(&sender_mode, &recipient, PROTOCOL_LABEL)
            .map_err(|_| HostInferenceCryptoError::EncryptionFailed)?;
    let ciphertext = context
        .seal(&plaintext, &aad)
        .map_err(|_| HostInferenceCryptoError::EncryptionFailed)?;

    Ok(EncryptedEnvelopeV1 {
        schema_version: 1,
        suite: HPKE_SUITE.to_owned(),
        recipient_key_id: recipient_key.key_id.clone(),
        sender_key_id: sender_key.key_id.clone(),
        enc: URL_SAFE_NO_PAD.encode(enc.to_bytes()),
        ciphertext_sha256: sha256_hex(&ciphertext),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        compression: Some(EnvelopeCompression::None),
    })
}

#[cfg(test)]
fn open_payload(
    binding: &HostInferenceTaskBinding,
    direction: HostInferenceDirection,
    recipient_key: &HostInferencePrivateKey,
    sender_key: &HostInferencePublicKey,
    envelope: &EncryptedEnvelopeV1,
) -> Result<PrivatePayloadV1, HostInferenceCryptoError> {
    if envelope.schema_version != 1
        || envelope.suite != HPKE_SUITE
        || envelope.recipient_key_id != recipient_key.key_id
        || envelope.sender_key_id != sender_key.key_id
    {
        return Err(HostInferenceCryptoError::InvalidEnvelope);
    }
    let encapsulated = URL_SAFE_NO_PAD
        .decode(&envelope.enc)
        .map_err(|_| HostInferenceCryptoError::InvalidEnvelope)?;
    let encapsulated = <Kem as hpke::Kem>::EncappedKey::from_bytes(&encapsulated)
        .map_err(|_| HostInferenceCryptoError::InvalidEnvelope)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| HostInferenceCryptoError::InvalidEnvelope)?;
    if !is_lower_hex_sha256(&envelope.ciphertext_sha256)
        || sha256_hex(&ciphertext) != envelope.ciphertext_sha256
    {
        return Err(HostInferenceCryptoError::IntegrityMismatch);
    }
    let sender_public = sender_key.hpke_key()?;
    let receiver_mode = OpModeR::Auth(sender_public);
    let aad = canonical_aad(binding, direction)?;
    let mut context = setup_receiver::<Aead, Kdf, Kem>(
        &receiver_mode,
        &recipient_key.key,
        &encapsulated,
        PROTOCOL_LABEL,
    )
    .map_err(|_| HostInferenceCryptoError::DecryptionFailed)?;
    let plaintext = context
        .open(&ciphertext, &aad)
        .map_err(|_| HostInferenceCryptoError::DecryptionFailed)?;
    let payload: PrivatePayloadV1 = serde_json::from_slice(&plaintext)
        .map_err(|_| HostInferenceCryptoError::DecryptionFailed)?;
    if !payload.matches(binding, direction) {
        return Err(HostInferenceCryptoError::PrivatePayloadMismatch);
    }
    Ok(payload)
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest.as_slice() {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
fn is_contract_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(id: &str, seed: u8) -> HostInferencePrivateKey {
        let (private, _) = Kem::derive_keypair(&[seed; 32]);
        HostInferencePrivateKey {
            key_id: HostInferenceKeyId::parse(id).unwrap(),
            key: private,
        }
    }

    fn binding(task_id: &str) -> HostInferenceTaskBinding {
        HostInferenceTaskBinding::new(
            task_id,
            "pair-demo-1",
            HostInferenceOperation::LibraryAnswer,
            7,
        )
        .unwrap()
    }

    #[test]
    fn canonical_aad_is_deterministic_and_contract_ordered() {
        let aad = canonical_aad(&binding("task-demo-1"), HostInferenceDirection::Request).unwrap();
        assert_eq!(
            String::from_utf8(aad).unwrap(),
            "kunpeng-intelligence-host-inference-v1{\"taskId\":\"task-demo-1\",\"pairId\":\"pair-demo-1\",\"operation\":\"library_answer\",\"capabilityRevision\":7,\"direction\":\"request\"}"
        );
    }

    #[test]
    fn authenticated_request_and_result_interoperate_with_fixed_pair_keys() {
        let client = key("key:client-demo-1", 3);
        let host = key("key:host-demo-1", 9);
        let binding = binding("task-demo-1");

        let request_payload = PrivatePayloadV1::new(
            &binding,
            HostInferenceDirection::Request,
            json!({"question": "秘密正文"}),
        )
        .unwrap();
        let request =
            seal_request(&binding, &client, &host.public_key(), &request_payload).unwrap();
        assert_eq!(request.suite, HPKE_SUITE);
        assert!(!serde_json::to_string(&request)
            .unwrap()
            .contains("秘密正文"));
        let opened_request = open_request(&binding, &host, &client.public_key(), &request).unwrap();
        assert_eq!(opened_request.payload(), request_payload.payload());

        let result_payload = PrivatePayloadV1::new(
            &binding,
            HostInferenceDirection::Result,
            json!({"answer": "仅本机回答"}),
        )
        .unwrap();
        let result = seal_result(&binding, &host, &client.public_key(), &result_payload).unwrap();
        let opened_result = open_result(&binding, &client, &host.public_key(), &result).unwrap();
        assert_eq!(opened_result.payload(), result_payload.payload());
    }

    #[test]
    fn rejects_ciphertext_tampering_even_when_attacker_rehashes_it() {
        let client = key("key:client-demo-1", 3);
        let host = key("key:host-demo-1", 9);
        let binding = binding("task-demo-1");
        let payload =
            PrivatePayloadV1::new(&binding, HostInferenceDirection::Request, json!({"v": 1}))
                .unwrap();
        let mut envelope = seal_request(&binding, &client, &host.public_key(), &payload).unwrap();
        let mut ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
        ciphertext[0] ^= 0x80;
        envelope.ciphertext = URL_SAFE_NO_PAD.encode(&ciphertext);
        envelope.ciphertext_sha256 = sha256_hex(&ciphertext);
        assert!(matches!(
            open_request(&binding, &host, &client.public_key(), &envelope),
            Err(HostInferenceCryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn rejects_cross_task_and_cross_direction_replay() {
        let client = key("key:client-demo-1", 3);
        let host = key("key:host-demo-1", 9);
        let original = binding("task-demo-1");
        let payload =
            PrivatePayloadV1::new(&original, HostInferenceDirection::Request, json!({"v": 1}))
                .unwrap();
        let envelope = seal_request(&original, &client, &host.public_key(), &payload).unwrap();

        assert!(matches!(
            open_request(
                &binding("task-demo-2"),
                &host,
                &client.public_key(),
                &envelope
            ),
            Err(HostInferenceCryptoError::DecryptionFailed)
        ));
        assert!(matches!(
            open_payload(
                &original,
                HostInferenceDirection::Result,
                &host,
                &client.public_key(),
                &envelope,
            ),
            Err(HostInferenceCryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn rejects_sender_identity_substitution_before_decryption() {
        let client = key("key:client-demo-1", 3);
        let unexpected_client = key("key:client-demo-2", 5);
        let host = key("key:host-demo-1", 9);
        let binding = binding("task-demo-1");
        let payload =
            PrivatePayloadV1::new(&binding, HostInferenceDirection::Request, json!({"v": 1}))
                .unwrap();
        let envelope = seal_request(&binding, &client, &host.public_key(), &payload).unwrap();
        assert!(matches!(
            open_request(&binding, &host, &unexpected_client.public_key(), &envelope),
            Err(HostInferenceCryptoError::InvalidEnvelope)
        ));
    }
}
