use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use hmac::{Hmac, KeyInit, Mac};
use rand::{TryRng, rngs::SysRng};
use secrecy::{ExposeSecret, SecretString};
use sha2::Sha256;
use subtle::ConstantTimeEq;

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credential hashing failed")]
    Hashing,
    #[error("operating system random generator failed")]
    Random,
}

/// Hashes a new password with the service Argon2id policy.
///
/// # Errors
///
/// Returns an error if the operating system RNG or Argon2 implementation fails.
pub fn hash_password(password: &SecretString) -> Result<String, CredentialError> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    argon2()
        .hash_password(password.expose_secret().as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| CredentialError::Hashing)
}

#[must_use]
pub fn verify_password(password: &SecretString, encoded: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded) else {
        return false;
    };
    argon2()
        .verify_password(password.expose_secret().as_bytes(), &hash)
        .is_ok()
}

/// Generates a 384-bit opaque session token encoded as lowercase hex.
///
/// # Errors
///
/// Returns an error if the operating system RNG is unavailable.
pub fn new_session_token() -> Result<SecretString, CredentialError> {
    let mut bytes = [0_u8; 48];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| CredentialError::Random)?;
    Ok(SecretString::from(hex(&bytes)))
}

/// Generates an opaque, one-time account rebind grant.
///
/// # Errors
///
/// Returns an error if the operating system RNG is unavailable.
pub fn new_rebind_grant() -> Result<SecretString, CredentialError> {
    new_session_token()
}

/// Computes the domain-separated database digest of an opaque session token.
///
/// # Errors
///
/// Returns an error if the HMAC implementation rejects the configured key.
pub fn session_token_digest(
    key: &SecretString,
    token: &SecretString,
) -> Result<[u8; 32], CredentialError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose_secret().as_bytes())
        .map_err(|_| CredentialError::Hashing)?;
    mac.update(b"reader-sync/session-token/v4\0");
    mac.update(token.expose_secret().as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

/// Generates a uniformly random six-digit account verification code.
///
/// # Errors
///
/// Returns an error if the operating system RNG is unavailable.
pub fn new_verification_code() -> Result<SecretString, CredentialError> {
    let mut bytes = [0_u8; 4];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| CredentialError::Random)?;
    let value = u32::from_le_bytes(bytes) % 1_000_000;
    Ok(SecretString::from(format!("{value:06}")))
}

/// Computes a domain-separated digest for a short-lived verification code.
///
/// # Errors
///
/// Returns an error if the configured HMAC key is rejected.
pub fn verification_code_digest(
    key: &SecretString,
    challenge_id: uuid::Uuid,
    code: &SecretString,
) -> Result<[u8; 32], CredentialError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose_secret().as_bytes())
        .map_err(|_| CredentialError::Hashing)?;
    mac.update(b"reader-sync/verification-code/v4\0");
    mac.update(challenge_id.as_bytes());
    mac.update(code.expose_secret().as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

/// Computes the database digest of a one-time email-rebind grant.
///
/// # Errors
///
/// Returns an error if the configured HMAC key is rejected.
pub fn rebind_grant_digest(
    key: &SecretString,
    grant: &SecretString,
) -> Result<[u8; 32], CredentialError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose_secret().as_bytes())
        .map_err(|_| CredentialError::Hashing)?;
    mac.update(b"reader-sync/email-rebind-grant/v5\0");
    mac.update(grant.expose_secret().as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

/// Computes a domain-separated digest for a rate-limit subject.
///
/// # Errors
///
/// Returns an error if the configured HMAC key is rejected.
pub fn rate_limit_subject_digest(
    key: &SecretString,
    scope: &str,
    subject: &str,
) -> Result<[u8; 32], CredentialError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose_secret().as_bytes())
        .map_err(|_| CredentialError::Hashing)?;
    mac.update(b"reader-sync/rate-limit/v4\0");
    mac.update(scope.as_bytes());
    mac.update(b"\0");
    mac.update(subject.as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

#[must_use]
pub fn digest_matches(expected: &[u8; 32], actual: &[u8; 32]) -> bool {
    bool::from(expected.ct_eq(actual))
}

#[must_use]
pub fn bytes_match(expected: &[u8], actual: &[u8]) -> bool {
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual))
}

fn argon2() -> Argon2<'static> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).expect("valid Argon2 policy");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_round_trip_uses_argon2id() {
        let password = SecretString::from("correct horse battery staple".to_owned());
        let encoded = hash_password(&password).expect("hash password");
        assert!(encoded.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"));
        assert!(verify_password(&password, &encoded));
        assert!(!verify_password(
            &SecretString::from("wrong".to_owned()),
            &encoded
        ));
    }

    #[test]
    fn token_is_random_and_database_digest_is_domain_separated() {
        let key = SecretString::from("test-key-with-more-than-thirty-two-bytes".to_owned());
        let first = new_session_token().expect("first token");
        let second = new_session_token().expect("second token");
        assert_eq!(first.expose_secret().len(), 96);
        assert_ne!(first.expose_secret(), second.expose_secret());
        let digest = session_token_digest(&key, &first).expect("first digest");
        let same = session_token_digest(&key, &first).expect("same digest");
        assert!(digest_matches(&digest, &same));
        let other = session_token_digest(&key, &second).expect("other digest");
        assert!(!digest_matches(&digest, &other));
    }

    #[test]
    fn verification_code_has_six_digits_and_stable_digest() {
        let key = SecretString::from("test-key-with-more-than-thirty-two-bytes".to_owned());
        let code = new_verification_code().expect("verification code");
        assert_eq!(code.expose_secret().len(), 6);
        assert!(
            code.expose_secret()
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        );
        let id = uuid::Uuid::new_v4();
        let first = verification_code_digest(&key, id, &code).expect("code digest");
        let second = verification_code_digest(&key, id, &code).expect("same digest");
        assert!(digest_matches(&first, &second));
    }
}
