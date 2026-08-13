use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

pub(super) const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub(super) fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

pub(super) fn mime_for_header(header: &str) -> Option<&'static str> {
    match header {
        "data:image/png;base64" => Some("image/png"),
        "data:image/jpeg;base64" => Some("image/jpeg"),
        "data:image/webp;base64" => Some("image/webp"),
        "data:image/gif;base64" => Some("image/gif"),
        _ => None,
    }
}

pub(super) fn valid_asset_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn validate_image_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片不能超过 10MB".into());
    }
    Ok(())
}

pub(super) fn decode_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (header, encoded) = data_url.trim().split_once(',').ok_or("背景图片格式无效")?;
    let mime = mime_for_header(header).ok_or("背景图片仅支持 PNG、JPG、WebP 或 GIF")?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "背景图片编码无效")?;
    validate_image_bytes(&bytes)?;
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_mimes_have_stable_extensions_and_data_url_headers() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(extension_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(
            mime_for_header("data:image/webp;base64"),
            Some("image/webp")
        );
        assert_eq!(mime_for_header("data:image/svg+xml;base64"), None);
    }

    #[test]
    fn asset_ids_require_exactly_64_hex_characters() {
        assert!(valid_asset_id(&"a".repeat(64)));
        assert!(valid_asset_id(&"A".repeat(64)));
        assert!(!valid_asset_id(&"a".repeat(63)));
        assert!(!valid_asset_id(&format!("{}g", "a".repeat(63))));
    }

    #[test]
    fn decoding_only_accepts_supported_non_empty_limited_data_urls() {
        let (bytes, mime) = decode_data_url(" data:image/png;base64,aGk= ").unwrap();
        assert_eq!(bytes, b"hi");
        assert_eq!(mime, "image/png");
        assert!(decode_data_url("data:image/png;base64,").is_err());
        assert!(decode_data_url("data:image/svg+xml;base64,aGk=").is_err());
        assert!(decode_data_url("data:image/png;base64,not-base64").is_err());
    }

    #[test]
    fn bytes_are_bounded_and_hashes_are_lowercase_hex() {
        assert!(validate_image_bytes(&[]).is_err());
        assert!(validate_image_bytes(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
        assert_eq!(
            sha256_hex(b"hi"),
            "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"
        );
    }
}
