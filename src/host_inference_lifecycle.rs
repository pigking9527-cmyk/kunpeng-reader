//! Local safety boundary for the optional encrypted intelligence host.
//!
//! A route may use a host only after three independent checks succeed:
//! a DPAPI-protected local pairing record is intact, the current logged-in
//! account reaches the same HTTPS service, and that service confirms the
//! exact pair, key fingerprint, capability revision, and operations.  This
//! module deliberately has no Tauri pairing UI and never serializes a private
//! key, bearer token, service URL, or host public key.

use std::{
    collections::BTreeSet,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    atomic_file,
    host_inference_crypto::{
        HostInferenceKeyId, HostInferenceOperation, HostInferencePrivateKey, HostInferencePublicKey,
    },
    profile, sync, AppState,
};

const CONFIG_FILE: &str = "intelligence-host-client-v1.json";
const PENDING_CONFIG_FILE: &str = "intelligence-host-pairing-pending-v1.json";
const CONFIG_SCHEMA_VERSION: u8 = 1;
const PREFLIGHT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const INVITE_CODE_PREFIX: &str = "KIR1.";
const CONFIRMATION_CODE_PREFIX: &str = "KIR1C.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HostRouteAvailability {
    pub(crate) available: bool,
    pub(crate) reason: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceHostPreflight {
    pub(crate) configured: bool,
    pub(crate) reachable: bool,
    pub(crate) compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) capability_revision: Option<u32>,
    pub(crate) message: String,
}

/// The only secret-shaped value allowed to cross the WebView boundary in the
/// pairing flow. It is a short-lived, single-use invite intended for a direct
/// user transfer to their own host. It is deliberately returned once only and
/// is never written to disk, logged, or accepted back by this client.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceHostPairingInvite {
    pub(crate) offer_id: String,
    pub(crate) expires_at: String,
    pub(crate) invite_code: String,
}

/// Public confirmation supplied by the host after it has claimed an invite.
/// It contains only public identity material; the desktop still verifies every
/// field against the authenticated service before persisting a pairing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntelligenceHostPairingConfirmRequest {
    confirmation_code: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceHostPairingSummary {
    pub(crate) pair_id: String,
    pub(crate) state: String,
    pub(crate) host_installation_id: String,
    pub(crate) host_key_fingerprint: String,
    pub(crate) capability_revision: u32,
    pub(crate) capabilities: Vec<HostInferenceOperation>,
    pub(crate) local: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceHostPairingsStatus {
    pub(crate) pending_confirmation: bool,
    pub(crate) pairings: Vec<IntelligenceHostPairingSummary>,
    pub(crate) message: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InviteCodePayload {
    schema_version: u8,
    base_url: String,
    offer_id: String,
    offer_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmationCodePayload {
    schema_version: u8,
    offer_id: String,
    pair_id: String,
    host_installation_id: String,
    host_key_id: String,
    host_public_key: String,
    capability_revision: u32,
}

/// Only a future authenticated offer/claim flow may construct this input.  It
/// has no serde implementation, so raw keys cannot arrive from a WebView
/// command or drift into a settings JSON record.
pub(crate) struct ConfirmedHostPairing {
    pub(crate) base_url: String,
    pub(crate) pair_id: String,
    pub(crate) host_installation_id: String,
    pub(crate) host_public_key: HostInferencePublicKey,
    pub(crate) host_key_fingerprint: String,
    pub(crate) client_private_key: HostInferencePrivateKey,
    pub(crate) capability_revision: u32,
    pub(crate) capabilities: Vec<HostInferenceOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredHostPairing {
    schema_version: u8,
    base_url: String,
    pair_id: String,
    host_installation_id: String,
    host_key_id: String,
    host_public_key: String,
    host_key_fingerprint: String,
    client_key_id: String,
    protected_client_private_key: String,
    capability_revision: u32,
    capabilities: Vec<HostInferenceOperation>,
}

/// Secret-bearing, DPAPI/keychain-protected local state kept only until the
/// host returns a public confirmation code. The offer token is intentionally
/// absent: losing the displayed invite means issuing a new offer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPendingPairing {
    schema_version: u8,
    base_url: String,
    offer_id: String,
    expires_at: String,
    client_key_id: String,
    protected_client_private_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemotePairing {
    schema_version: u8,
    pair_id: String,
    state: String,
    host_installation_id: String,
    host_key_id: String,
    host_key_fingerprint: String,
    client_key_id: String,
    capability_revision: u32,
    capabilities: Vec<HostInferenceOperation>,
}

#[derive(Clone)]
struct SuccessfulPreflight {
    pair_id: String,
    capability_revision: u32,
    capabilities: Vec<HostInferenceOperation>,
    checked_at: Instant,
}

fn preflight_cache() -> &'static Mutex<Option<SuccessfulPreflight>> {
    static CACHE: OnceLock<Mutex<Option<SuccessfulPreflight>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn config_path() -> Result<PathBuf, String> {
    let directory = profile::app_config_dir().ok_or("无法定位情报主机本机配置目录")?;
    Ok(directory.join(CONFIG_FILE))
}

fn pending_config_path() -> Result<PathBuf, String> {
    let directory = profile::app_config_dir().ok_or("无法定位情报主机本机配置目录")?;
    Ok(directory.join(PENDING_CONFIG_FILE))
}

fn valid_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(value) if value.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn normalize_https_origin(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "情报主机服务地址无效")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return Err("情报主机服务必须使用根路径 HTTPS 地址".into());
    }
    let origin = url.origin().ascii_serialization();
    (origin != "null")
        .then_some(origin)
        .ok_or("情报主机服务地址无效".into())
}

fn fingerprint(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn capability_set(values: &[HostInferenceOperation]) -> BTreeSet<String> {
    values
        .iter()
        .map(|value| {
            serde_json::to_value(value)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default()
        })
        .collect()
}

fn required_operations(capability: &str) -> Option<&'static [HostInferenceOperation]> {
    use HostInferenceOperation as Operation;
    match capability {
        // Search owns a local corpus, and therefore has no host route in V1.
        "search" => None,
        "understanding" => Some(&[Operation::LibraryAnswer, Operation::ReadingMemory]),
        "news_preference" => Some(&[Operation::NewsPreference, Operation::NewsEvidenceReview]),
        "deep_analysis" => Some(&[Operation::ReadingDeepAnalysis]),
        "companion" => Some(&[Operation::CompanionPrompt]),
        _ => None,
    }
}

fn supports_capability(capabilities: &[HostInferenceOperation], capability: &str) -> bool {
    let Some(required) = required_operations(capability) else {
        return false;
    };
    required
        .iter()
        .all(|operation| capabilities.contains(operation))
}

fn read_pairing_at(path: &Path) -> Result<Option<StoredHostPairing>, String> {
    let bytes = match std::fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本机情报主机安全配置".into()),
    };
    let pairing: StoredHostPairing =
        serde_json::from_slice(&bytes).map_err(|_| "本机情报主机安全配置已损坏")?;
    validate_stored_pairing(&pairing)?;
    Ok(Some(pairing))
}

fn read_pending_at(path: &Path) -> Result<Option<StoredPendingPairing>, String> {
    let bytes = match std::fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本机情报主机配对状态".into()),
    };
    let pending: StoredPendingPairing =
        serde_json::from_slice(&bytes).map_err(|_| "本机情报主机配对状态已损坏")?;
    validate_pending_pairing(&pending)?;
    Ok(Some(pending))
}

fn validate_stored_pairing(pairing: &StoredHostPairing) -> Result<(), String> {
    if pairing.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_id(&pairing.pair_id)
        || !valid_id(&pairing.host_installation_id)
        || pairing.capability_revision == 0
        || pairing.capabilities.is_empty()
        || pairing.capabilities.len() > 32
        || capability_set(&pairing.capabilities).len() != pairing.capabilities.len()
        || !crate::secret_store::is_sync_secret_protected(&pairing.protected_client_private_key)
    {
        return Err("本机情报主机安全配置无效".into());
    }
    let base = normalize_https_origin(&pairing.base_url)?;
    if base != pairing.base_url {
        return Err("本机情报主机安全配置无效".into());
    }
    let host_key_id = HostInferenceKeyId::parse(pairing.host_key_id.clone())
        .map_err(|_| "本机情报主机安全配置无效")?;
    let host_key = HostInferencePublicKey::from_base64url(host_key_id, &pairing.host_public_key)
        .map_err(|_| "本机情报主机安全配置无效")?;
    if host_key.base64url() != pairing.host_public_key
        || fingerprint(&pairing.host_public_key) != pairing.host_key_fingerprint
        || HostInferenceKeyId::parse(pairing.client_key_id.clone()).is_err()
    {
        return Err("本机情报主机安全配置无效".into());
    }
    Ok(())
}

fn validate_pending_pairing(pending: &StoredPendingPairing) -> Result<(), String> {
    if pending.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_id(&pending.offer_id)
        || pending.expires_at.trim().is_empty()
        || pending.expires_at.len() > 64
        || !crate::secret_store::is_sync_secret_protected(&pending.protected_client_private_key)
        || HostInferenceKeyId::parse(pending.client_key_id.clone()).is_err()
    {
        return Err("本机情报主机配对状态无效".into());
    }
    let base = normalize_https_origin(&pending.base_url)?;
    if base != pending.base_url {
        return Err("本机情报主机配对状态无效".into());
    }
    let key = crate::secret_store::unprotect_secret(&pending.protected_client_private_key)
        .map_err(|_| "无法读取本机情报主机配对状态")?;
    let key_id = HostInferenceKeyId::parse(pending.client_key_id.clone())
        .map_err(|_| "本机情报主机配对状态无效")?;
    let private = HostInferencePrivateKey::from_platform_secret(key_id, &key)
        .map_err(|_| "本机情报主机配对状态无效")?;
    if private.key_id().as_str() != pending.client_key_id {
        return Err("本机情报主机配对状态无效".into());
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清除本机情报主机安全配置".into()),
    }
}

fn validate_private_key(pairing: &StoredHostPairing) -> Result<(), String> {
    let secret = crate::secret_store::unprotect_secret(&pairing.protected_client_private_key)
        .map_err(|_| "无法读取本机情报主机安全配置")?;
    let key_id = HostInferenceKeyId::parse(pairing.client_key_id.clone())
        .map_err(|_| "本机情报主机安全配置无效")?;
    let key = HostInferencePrivateKey::from_platform_secret(key_id, &secret)
        .map_err(|_| "本机情报主机安全配置无效")?;
    // Also prove that the secret corresponds to the advertised client key ID.
    if key.key_id().as_str() != pairing.client_key_id {
        return Err("本机情报主机安全配置无效".into());
    }
    Ok(())
}

/// Persist a pairing only after a future authenticated offer/claim flow has
/// verified the server response and shown the public host-key fingerprint to
/// the user.  This is intentionally not a Tauri command: it prevents pages or
/// tests from injecting a raw private key through JSON.
pub(crate) fn persist_confirmed_pairing(pairing: ConfirmedHostPairing) -> Result<(), String> {
    let base_url = normalize_https_origin(&pairing.base_url)?;
    if !valid_id(&pairing.pair_id)
        || !valid_id(&pairing.host_installation_id)
        || pairing.capability_revision == 0
        || pairing.capabilities.is_empty()
        || pairing.capabilities.len() > 32
        || capability_set(&pairing.capabilities).len() != pairing.capabilities.len()
        || pairing.host_key_fingerprint != fingerprint(&pairing.host_public_key.base64url())
    {
        return Err("已确认的情报主机配对信息无效".into());
    }
    let stored = StoredHostPairing {
        schema_version: CONFIG_SCHEMA_VERSION,
        base_url,
        pair_id: pairing.pair_id,
        host_installation_id: pairing.host_installation_id,
        host_key_id: pairing.host_public_key.key_id().as_str().to_owned(),
        host_public_key: pairing.host_public_key.base64url(),
        host_key_fingerprint: pairing.host_key_fingerprint,
        client_key_id: pairing.client_private_key.key_id().as_str().to_owned(),
        protected_client_private_key: crate::secret_store::protect_secret(
            &pairing.client_private_key.encode_for_platform_secret(),
        )?,
        capability_revision: pairing.capability_revision,
        capabilities: pairing.capabilities,
    };
    validate_stored_pairing(&stored)?;
    let path = config_path()?;
    let parent = path.parent().ok_or("本机情报主机配置路径无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建本机情报主机配置目录")?;
    atomic_file::write_json(&path, &stored, true).map_err(|_| "无法保存本机情报主机安全配置")?;
    if let Ok(mut cache) = preflight_cache().lock() {
        *cache = None;
    }
    Ok(())
}

/// Read-only status adapter used by Smart Management.  It performs no network
/// I/O.  A successful authenticated preflight is required within a short TTL,
/// so a saved host ID can never by itself become an available route.
pub(crate) fn route_availability(capability: &str, host_id: Option<&str>) -> HostRouteAvailability {
    let pairing = match config_path().and_then(|path| read_pairing_at(&path)) {
        Ok(Some(pairing)) => pairing,
        Ok(None) => {
            return HostRouteAvailability {
                available: false,
                reason: "此设备尚未完成情报主机安全配对",
            }
        }
        Err(_) => {
            return HostRouteAvailability {
                available: false,
                reason: "本机情报主机安全配置不可用",
            }
        }
    };
    availability_for_pairing(&pairing, capability, host_id)
}

fn availability_for_pairing(
    pairing: &StoredHostPairing,
    capability: &str,
    host_id: Option<&str>,
) -> HostRouteAvailability {
    let Some(_required) = required_operations(capability) else {
        return HostRouteAvailability {
            available: false,
            reason: "情报主机不能承载本机搜索库",
        };
    };
    if host_id != Some(pairing.pair_id.as_str()) {
        return HostRouteAvailability {
            available: false,
            reason: "所选情报主机未在此设备完成安全配对",
        };
    }
    if !supports_capability(&pairing.capabilities, capability) {
        return HostRouteAvailability {
            available: false,
            reason: "情报主机未声明此智能能力",
        };
    }
    let Ok(cache) = preflight_cache().lock() else {
        return HostRouteAvailability {
            available: false,
            reason: "情报主机运行时状态暂不可用",
        };
    };
    let fresh = cache.as_ref().is_some_and(|value| {
        value.pair_id == pairing.pair_id
            && value.capability_revision == pairing.capability_revision
            && value.checked_at.elapsed() <= PREFLIGHT_TTL
            && value.capabilities == pairing.capabilities
    });
    if fresh {
        HostRouteAvailability {
            available: true,
            reason: "",
        }
    } else {
        HostRouteAvailability {
            available: false,
            reason: "情报主机尚未完成运行时检查",
        }
    }
}

trait PairingFetcher {
    fn list_pairings(&self, origin: &str, bearer: &str) -> Result<Vec<RemotePairing>, ()>;
}

struct UreqPairingFetcher;

impl PairingFetcher for UreqPairingFetcher {
    fn list_pairings(&self, origin: &str, bearer: &str) -> Result<Vec<RemotePairing>, ()> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(8)))
            .build()
            .into();
        let mut response = agent
            .get(&format!("{origin}/v1/intelligence/host-pairings"))
            .header("Accept", "application/json")
            .header("Authorization", &format!("Bearer {bearer}"))
            .call()
            .map_err(|_| ())?;
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| ())?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(());
        }
        serde_json::from_slice(&body).map_err(|_| ())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfferResponse {
    schema_version: u8,
    offer_id: String,
    expires_at: String,
}

/// Account-authenticated endpoint adapter. All request bodies remain inside
/// Rust; errors are intentionally content-free so an invite token, account
/// bearer, public key, or server address can never leak into a WebView error.
trait PairingApi {
    fn create_offer(
        &self,
        origin: &str,
        bearer: &str,
        offer_token: &str,
        client_key: &HostInferencePublicKey,
    ) -> Result<OfferResponse, ()>;
    fn list_pairings(&self, origin: &str, bearer: &str) -> Result<Vec<RemotePairing>, ()>;
    fn revoke_pairing(&self, origin: &str, bearer: &str, pair_id: &str) -> Result<(), ()>;
}

struct UreqPairingApi;

fn pairing_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into()
}

fn read_pairing_response(mut response: ureq::http::Response<ureq::Body>) -> Result<Vec<u8>, ()> {
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| ())?;
    (body.len() <= MAX_RESPONSE_BYTES).then_some(body).ok_or(())
}

impl PairingApi for UreqPairingApi {
    fn create_offer(
        &self,
        origin: &str,
        bearer: &str,
        offer_token: &str,
        client_key: &HostInferencePublicKey,
    ) -> Result<OfferResponse, ()> {
        let body = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": CONFIG_SCHEMA_VERSION,
            "offerToken": offer_token,
            "clientKeyId": client_key.key_id().as_str(),
            "clientPublicKey": client_key.base64url(),
        }))
        .map_err(|_| ())?;
        let response = pairing_agent()
            .post(&format!("{origin}/v1/intelligence/host-pairings/offers"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Authorization", &format!("Bearer {bearer}"))
            .header("Idempotency-Key", &Uuid::new_v4().to_string())
            .send(&body)
            .map_err(|_| ())?;
        if response.status().as_u16() != 201 {
            return Err(());
        }
        serde_json::from_slice(&read_pairing_response(response)?).map_err(|_| ())
    }

    fn list_pairings(&self, origin: &str, bearer: &str) -> Result<Vec<RemotePairing>, ()> {
        UreqPairingFetcher.list_pairings(origin, bearer)
    }

    fn revoke_pairing(&self, origin: &str, bearer: &str, pair_id: &str) -> Result<(), ()> {
        if !valid_id(pair_id) {
            return Err(());
        }
        let response = pairing_agent()
            .delete(&format!("{origin}/v1/intelligence/host-pairings/{pair_id}"))
            .header("Authorization", &format!("Bearer {bearer}"))
            .header("Idempotency-Key", &Uuid::new_v4().to_string())
            .call()
            .map_err(|_| ())?;
        (response.status().as_u16() == 204).then_some(()).ok_or(())
    }
}

fn random_offer_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "无法生成情报主机一次性邀请")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn encode_invite(payload: &InviteCodePayload) -> Result<String, String> {
    let bytes = serde_json::to_vec(payload).map_err(|_| "无法生成情报主机一次性邀请")?;
    Ok(format!(
        "{INVITE_CODE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn decode_confirmation(code: &str) -> Result<ConfirmationCodePayload, String> {
    let encoded = code
        .trim()
        .strip_prefix(CONFIRMATION_CODE_PREFIX)
        .ok_or("情报主机确认码无效")?;
    if encoded.is_empty() || encoded.len() > 16 * 1024 {
        return Err("情报主机确认码无效".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "情报主机确认码无效")?;
    let confirmation: ConfirmationCodePayload =
        serde_json::from_slice(&bytes).map_err(|_| "情报主机确认码无效")?;
    if confirmation.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_id(&confirmation.offer_id)
        || !valid_id(&confirmation.pair_id)
        || !valid_id(&confirmation.host_installation_id)
        || confirmation.capability_revision == 0
        || HostInferenceKeyId::parse(confirmation.host_key_id.clone()).is_err()
    {
        return Err("情报主机确认码无效".into());
    }
    Ok(confirmation)
}

fn persist_pending_pairing(pending: &StoredPendingPairing) -> Result<(), String> {
    validate_pending_pairing(pending)?;
    let path = pending_config_path()?;
    atomic_file::write_json(&path, pending, true)
        .map_err(|_| "无法保存本机情报主机配对状态".to_owned())
}

fn pairing_summary(
    remote: RemotePairing,
    local_pair_id: Option<&str>,
) -> IntelligenceHostPairingSummary {
    IntelligenceHostPairingSummary {
        pair_id: remote.pair_id.clone(),
        state: remote.state,
        host_installation_id: remote.host_installation_id,
        host_key_fingerprint: remote.host_key_fingerprint,
        capability_revision: remote.capability_revision,
        capabilities: remote.capabilities,
        local: local_pair_id == Some(remote.pair_id.as_str()),
    }
}

fn list_pairings_with_api(
    state: &AppState,
    api: &impl PairingApi,
) -> Result<IntelligenceHostPairingsStatus, String> {
    let connection = sync::intelligence_connection(state)?;
    let remote = api
        .list_pairings(&connection.base, &connection.token)
        .map_err(|_| "情报主机服务不可达、未授权或尚未启用")?;
    let local_pair_id = config_path()
        .and_then(|path| read_pairing_at(&path))?
        .map(|pairing| pairing.pair_id);
    let pending_confirmation = pending_config_path()
        .and_then(|path| read_pending_at(&path))?
        .is_some();
    let pairings = remote
        .into_iter()
        .filter(|pairing| pairing.schema_version == CONFIG_SCHEMA_VERSION)
        .map(|pairing| pairing_summary(pairing, local_pair_id.as_deref()))
        .collect::<Vec<_>>();
    let message = if pending_confirmation {
        "已创建一次性邀请，等待主机确认".into()
    } else if pairings.is_empty() {
        "当前账户尚未配对情报主机".into()
    } else {
        "已读取当前账户的情报主机配对状态".into()
    };
    Ok(IntelligenceHostPairingsStatus {
        pending_confirmation,
        pairings,
        message,
    })
}

fn begin_pairing_with_api(
    state: &AppState,
    api: &impl PairingApi,
) -> Result<IntelligenceHostPairingInvite, String> {
    let connection = sync::intelligence_connection(state)?;
    let client_key_id = HostInferenceKeyId::parse(format!("key:client-{}", Uuid::new_v4()))
        .map_err(|_| "无法生成情报主机配对密钥")?;
    let client_private_key = HostInferencePrivateKey::generate(client_key_id);
    let client_public_key = client_private_key.public_key();
    let offer_token = random_offer_token()?;
    let response = api
        .create_offer(
            &connection.base,
            &connection.token,
            &offer_token,
            &client_public_key,
        )
        .map_err(|_| "无法创建情报主机一次性邀请")?;
    if response.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_id(&response.offer_id)
        || response.expires_at.trim().is_empty()
        || response.expires_at.len() > 64
    {
        return Err("情报主机服务返回的邀请无效".into());
    }
    persist_pending_pairing(&StoredPendingPairing {
        schema_version: CONFIG_SCHEMA_VERSION,
        base_url: connection.base.clone(),
        offer_id: response.offer_id.clone(),
        expires_at: response.expires_at.clone(),
        client_key_id: client_private_key.key_id().as_str().into(),
        protected_client_private_key: crate::secret_store::protect_secret(
            &client_private_key.encode_for_platform_secret(),
        )?,
    })?;
    let invite_code = encode_invite(&InviteCodePayload {
        schema_version: CONFIG_SCHEMA_VERSION,
        base_url: connection.base,
        offer_id: response.offer_id.clone(),
        offer_token,
    })?;
    Ok(IntelligenceHostPairingInvite {
        offer_id: response.offer_id,
        expires_at: response.expires_at,
        invite_code,
    })
}

fn confirm_pairing_with_api(
    state: &AppState,
    request: IntelligenceHostPairingConfirmRequest,
    api: &impl PairingApi,
) -> Result<IntelligenceHostPairingSummary, String> {
    let pending_path = pending_config_path()?;
    let pending = read_pending_at(&pending_path)?.ok_or("当前没有等待确认的情报主机邀请")?;
    let confirmation = decode_confirmation(&request.confirmation_code)?;
    if confirmation.offer_id != pending.offer_id {
        return Err("情报主机确认码不属于当前邀请".into());
    }
    let connection = sync::intelligence_connection(state)?;
    if connection.base != pending.base_url {
        return Err("当前登录账户与情报主机配对服务器不一致".into());
    }
    let host_key_id = HostInferenceKeyId::parse(confirmation.host_key_id.clone())
        .map_err(|_| "情报主机确认码无效")?;
    let host_public_key =
        HostInferencePublicKey::from_base64url(host_key_id, &confirmation.host_public_key)
            .map_err(|_| "情报主机确认码无效")?;
    let host_key_fingerprint = fingerprint(&host_public_key.base64url());
    let remote = api
        .list_pairings(&connection.base, &connection.token)
        .map_err(|_| "情报主机服务不可达、未授权或尚未启用")?;
    let matched = remote
        .into_iter()
        .find(|pairing| {
            pairing.schema_version == CONFIG_SCHEMA_VERSION
                && pairing.state == "ACTIVE"
                && pairing.pair_id == confirmation.pair_id
                && pairing.host_installation_id == confirmation.host_installation_id
                && pairing.host_key_id == confirmation.host_key_id
                && pairing.host_key_fingerprint == host_key_fingerprint
                && pairing.client_key_id == pending.client_key_id
                && pairing.capability_revision == confirmation.capability_revision
        })
        .ok_or("情报主机确认尚未生效或已变更")?;
    let private_secret =
        crate::secret_store::unprotect_secret(&pending.protected_client_private_key)
            .map_err(|_| "无法读取本机情报主机配对状态")?;
    let client_key_id = HostInferenceKeyId::parse(pending.client_key_id.clone())
        .map_err(|_| "本机情报主机配对状态无效")?;
    let client_private_key =
        HostInferencePrivateKey::from_platform_secret(client_key_id, &private_secret)
            .map_err(|_| "本机情报主机配对状态无效")?;
    let capabilities = matched.capabilities.clone();
    persist_confirmed_pairing(ConfirmedHostPairing {
        base_url: pending.base_url,
        pair_id: matched.pair_id.clone(),
        host_installation_id: matched.host_installation_id.clone(),
        host_public_key,
        host_key_fingerprint,
        client_private_key,
        capability_revision: confirmation.capability_revision,
        capabilities,
    })?;
    remove_file_if_present(&pending_path)?;
    Ok(pairing_summary(matched, Some(&confirmation.pair_id)))
}

fn revoke_pairing_with_api(
    state: &AppState,
    pair_id: String,
    api: &impl PairingApi,
) -> Result<IntelligenceHostPairingsStatus, String> {
    if !valid_id(pair_id.trim()) {
        return Err("情报主机标识无效".into());
    }
    let connection = sync::intelligence_connection(state)?;
    api.revoke_pairing(&connection.base, &connection.token, pair_id.trim())
        .map_err(|_| "无法撤销情报主机配对")?;
    if let Some(local) = config_path().and_then(|path| read_pairing_at(&path))? {
        if local.pair_id == pair_id.trim() {
            remove_file_if_present(&config_path()?)?;
            if let Ok(mut cache) = preflight_cache().lock() {
                *cache = None;
            }
        }
    }
    list_pairings_with_api(state, api)
}

pub(crate) fn begin_pairing(state: &AppState) -> Result<IntelligenceHostPairingInvite, String> {
    begin_pairing_with_api(state, &UreqPairingApi)
}

pub(crate) fn confirm_pairing(
    state: &AppState,
    request: IntelligenceHostPairingConfirmRequest,
) -> Result<IntelligenceHostPairingSummary, String> {
    confirm_pairing_with_api(state, request, &UreqPairingApi)
}

pub(crate) fn list_pairings(state: &AppState) -> Result<IntelligenceHostPairingsStatus, String> {
    list_pairings_with_api(state, &UreqPairingApi)
}

pub(crate) fn revoke_pairing(
    state: &AppState,
    pair_id: String,
) -> Result<IntelligenceHostPairingsStatus, String> {
    revoke_pairing_with_api(state, pair_id, &UreqPairingApi)
}

fn pairing_matches(local: &StoredHostPairing, remote: &RemotePairing) -> bool {
    remote.schema_version == CONFIG_SCHEMA_VERSION
        && remote.state == "ACTIVE"
        && remote.pair_id == local.pair_id
        && remote.host_installation_id == local.host_installation_id
        && remote.host_key_id == local.host_key_id
        && remote.host_key_fingerprint == local.host_key_fingerprint
        && remote.client_key_id == local.client_key_id
        && remote.capability_revision == local.capability_revision
        && capability_set(&remote.capabilities) == capability_set(&local.capabilities)
}

fn checked_pairing_with_fetcher(
    pairing: &StoredHostPairing,
    connection: &sync::IntelligenceConnection,
    fetcher: &impl PairingFetcher,
) -> IntelligenceHostPreflight {
    if connection.base != pairing.base_url {
        return unavailable_preflight(pairing, false, "当前登录账户与情报主机配对服务器不一致");
    }
    if validate_private_key(pairing).is_err() {
        return unavailable_preflight(pairing, false, "本机情报主机安全配置不可用");
    }
    let Ok(remote) = fetcher.list_pairings(&connection.base, &connection.token) else {
        return unavailable_preflight(pairing, false, "情报主机服务不可达或未授权");
    };
    if !remote.iter().any(|value| pairing_matches(pairing, value)) {
        return unavailable_preflight(pairing, true, "情报主机配对或能力协商已变更");
    }
    if let Ok(mut cache) = preflight_cache().lock() {
        *cache = Some(SuccessfulPreflight {
            pair_id: pairing.pair_id.clone(),
            capability_revision: pairing.capability_revision,
            capabilities: pairing.capabilities.clone(),
            checked_at: Instant::now(),
        });
    }
    IntelligenceHostPreflight {
        configured: true,
        reachable: true,
        compatible: true,
        host_id: Some(pairing.pair_id.clone()),
        capability_revision: Some(pairing.capability_revision),
        message: "情报主机已完成安全检查，可用于已声明的能力".into(),
    }
}

fn unavailable_preflight(
    pairing: &StoredHostPairing,
    reachable: bool,
    message: &str,
) -> IntelligenceHostPreflight {
    if let Ok(mut cache) = preflight_cache().lock() {
        *cache = None;
    }
    IntelligenceHostPreflight {
        configured: true,
        reachable,
        compatible: false,
        host_id: Some(pairing.pair_id.clone()),
        capability_revision: Some(pairing.capability_revision),
        message: message.into(),
    }
}

/// Authenticated, explicit runtime check.  This is the only network operation
/// in this module.  It uses the current in-memory account token internally and
/// returns only a safe status projection to the WebView.
pub(crate) fn preflight(state: &AppState) -> Result<IntelligenceHostPreflight, String> {
    let Some(pairing) = read_pairing_at(&config_path()?)? else {
        return Ok(IntelligenceHostPreflight {
            configured: false,
            reachable: false,
            compatible: false,
            host_id: None,
            capability_revision: None,
            message: "此设备尚未完成情报主机安全配对".into(),
        });
    };
    let connection = match sync::intelligence_connection(state) {
        Ok(connection) => connection,
        Err(_) => {
            return Ok(unavailable_preflight(
                &pairing,
                false,
                "请先登录后检查情报主机",
            ))
        }
    };
    Ok(checked_pairing_with_fetcher(
        &pairing,
        &connection,
        &UreqPairingFetcher,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFetcher(Result<Vec<RemotePairing>, ()>);

    impl PairingFetcher for FakeFetcher {
        fn list_pairings(&self, _origin: &str, _bearer: &str) -> Result<Vec<RemotePairing>, ()> {
            self.0.clone()
        }
    }

    fn clear_cache() {
        *preflight_cache().lock().unwrap() = None;
    }

    // The production cache is deliberately process-global.  Serialize these
    // focused tests so parallel test workers cannot clear another case's
    // authenticated preflight result.
    fn test_cache_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn pairing() -> (ConfirmedHostPairing, HostInferencePrivateKey) {
        let client =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:client").unwrap());
        let host =
            HostInferencePrivateKey::generate(HostInferenceKeyId::parse("key:host").unwrap());
        let host_public_key = host.public_key();
        let pairing = ConfirmedHostPairing {
            base_url: "https://intelligence.example.test".into(),
            pair_id: "pair-demo-1".into(),
            host_installation_id: "host-demo-1".into(),
            host_key_fingerprint: fingerprint(&host_public_key.base64url()),
            host_public_key,
            client_private_key: client,
            capability_revision: 3,
            capabilities: vec![
                HostInferenceOperation::LibraryAnswer,
                HostInferenceOperation::ReadingMemory,
                HostInferenceOperation::ReadingDeepAnalysis,
            ],
        };
        (pairing, host)
    }

    fn stored(pairing: ConfirmedHostPairing) -> StoredHostPairing {
        StoredHostPairing {
            schema_version: CONFIG_SCHEMA_VERSION,
            base_url: pairing.base_url,
            pair_id: pairing.pair_id,
            host_installation_id: pairing.host_installation_id,
            host_key_id: pairing.host_public_key.key_id().as_str().into(),
            host_public_key: pairing.host_public_key.base64url(),
            host_key_fingerprint: pairing.host_key_fingerprint,
            client_key_id: pairing.client_private_key.key_id().as_str().into(),
            protected_client_private_key: crate::secret_store::protect_secret(
                &pairing.client_private_key.encode_for_platform_secret(),
            )
            .unwrap(),
            capability_revision: pairing.capability_revision,
            capabilities: pairing.capabilities,
        }
    }

    fn remote(local: &StoredHostPairing) -> RemotePairing {
        RemotePairing {
            schema_version: 1,
            pair_id: local.pair_id.clone(),
            state: "ACTIVE".into(),
            host_installation_id: local.host_installation_id.clone(),
            host_key_id: local.host_key_id.clone(),
            host_key_fingerprint: local.host_key_fingerprint.clone(),
            client_key_id: local.client_key_id.clone(),
            capability_revision: local.capability_revision,
            capabilities: local.capabilities.clone(),
        }
    }

    fn connection() -> sync::IntelligenceConnection {
        sync::IntelligenceConnection {
            base: "https://intelligence.example.test".into(),
            account_id: "account-demo".into(),
            token: "account-token-not-serialized".into(),
        }
    }

    #[test]
    fn local_record_is_secret_safe_and_requires_a_runtime_check() {
        let _guard = test_cache_lock().lock().unwrap();
        clear_cache();
        let (pairing, _) = pairing();
        let raw_key = pairing.client_private_key.encode_for_platform_secret();
        let local = stored(pairing);
        validate_stored_pairing(&local).unwrap();
        let json = serde_json::to_string(&local).unwrap();
        assert!(!json.contains(&raw_key));
        assert!(!json.contains("client_private_key"));
        assert!(!availability_for_pairing(&local, "deep_analysis", Some(&local.pair_id)).available);
    }

    #[test]
    fn matching_authenticated_pairing_enables_only_its_declared_routes() {
        let _guard = test_cache_lock().lock().unwrap();
        clear_cache();
        let (pairing, _) = pairing();
        let local = stored(pairing);
        let status = checked_pairing_with_fetcher(
            &local,
            &connection(),
            &FakeFetcher(Ok(vec![remote(&local)])),
        );
        assert!(status.compatible);
        assert!(availability_for_pairing(&local, "deep_analysis", Some(&local.pair_id)).available);
        assert!(availability_for_pairing(&local, "understanding", Some(&local.pair_id)).available);
        assert!(
            !availability_for_pairing(&local, "news_preference", Some(&local.pair_id)).available
        );
        assert!(!availability_for_pairing(&local, "search", Some(&local.pair_id)).available);
    }

    #[test]
    fn changed_revision_clears_cached_host_availability() {
        let _guard = test_cache_lock().lock().unwrap();
        clear_cache();
        let (pairing, _) = pairing();
        let local = stored(pairing);
        let _ = checked_pairing_with_fetcher(
            &local,
            &connection(),
            &FakeFetcher(Ok(vec![remote(&local)])),
        );
        let mut changed = remote(&local);
        changed.capability_revision += 1;
        let status =
            checked_pairing_with_fetcher(&local, &connection(), &FakeFetcher(Ok(vec![changed])));
        assert!(!status.compatible);
        assert!(!availability_for_pairing(&local, "deep_analysis", Some(&local.pair_id)).available);
    }

    #[test]
    fn account_service_mismatch_never_contacts_or_enables_the_host() {
        let _guard = test_cache_lock().lock().unwrap();
        clear_cache();
        let (pairing, _) = pairing();
        let local = stored(pairing);
        let mut connection = connection();
        connection.base = "https://other.example.test".into();
        let status = checked_pairing_with_fetcher(&local, &connection, &FakeFetcher(Err(())));
        assert!(!status.reachable);
        assert!(status.message.contains("不一致"));
    }
}
