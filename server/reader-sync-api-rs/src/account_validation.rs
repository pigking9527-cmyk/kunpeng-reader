//! Shared account-identity and password boundaries.
//!
//! New credentials use a human-facing character count. Existing credentials
//! retain the previous byte ceiling during login and confirmation actions so a
//! policy tightening cannot lock an already registered user out.

pub const USERNAME_MIN_CHARS: usize = 3;
pub const USERNAME_MAX_CHARS: usize = 32;
pub const NEW_PASSWORD_MIN_CHARS: usize = 8;
pub const NEW_PASSWORD_MAX_CHARS: usize = 32;
const LEGACY_PASSWORD_MAX_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidUsername;

/// Normalizes a username and its case-insensitive lookup key.
///
/// # Errors
///
/// Returns [`InvalidUsername`] when the supplied value is outside the
/// documented identifier alphabet or character range.
pub fn normalize_username(username: &str) -> Result<(String, String), InvalidUsername> {
    let username = username.trim();
    if !(USERNAME_MIN_CHARS..=USERNAME_MAX_CHARS).contains(&username.chars().count())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(InvalidUsername);
    }
    Ok((username.to_owned(), username.to_ascii_lowercase()))
}

#[must_use]
pub fn valid_new_password(password: &str) -> bool {
    (NEW_PASSWORD_MIN_CHARS..=NEW_PASSWORD_MAX_CHARS).contains(&password.chars().count())
}

#[must_use]
pub fn valid_existing_password(password: &str) -> bool {
    !password.is_empty() && password.len() <= LEGACY_PASSWORD_MAX_BYTES
}

#[cfg(test)]
mod tests {
    use super::{normalize_username, valid_existing_password, valid_new_password};

    #[test]
    fn username_accepts_only_the_documented_ascii_identifier_range() {
        assert_eq!(
            normalize_username(" Reader_01 ").expect("valid username"),
            ("Reader_01".to_owned(), "reader_01".to_owned())
        );
        assert!(normalize_username("ab").is_err());
        assert!(normalize_username(&"a".repeat(33)).is_err());
        assert!(normalize_username("阅读器").is_err());
    }

    #[test]
    fn new_password_uses_a_unicode_character_not_byte_boundary() {
        assert!(valid_new_password("密".repeat(8).as_str()));
        assert!(!valid_new_password("密".repeat(7).as_str()));
        assert!(valid_new_password("a".repeat(32).as_str()));
        assert!(!valid_new_password("a".repeat(33).as_str()));
    }

    #[test]
    fn legacy_password_boundary_is_only_for_existing_password_proofs() {
        assert!(valid_existing_password("legacy"));
        assert!(valid_existing_password(&"a".repeat(1024)));
        assert!(!valid_existing_password(""));
        assert!(!valid_existing_password(&"a".repeat(1025)));
    }
}
