use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::webp::WebPEncoder, imageops::FilterType, DynamicImage, ExtendedColorType, ImageEncoder,
    ImageFormat, ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use std::io::Cursor;

/// New theme-background assets are capped at 5 MiB so one custom theme cannot
/// consume a disproportionate part of the account's sync quota.
pub(super) const MAX_IMPORTED_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// The original file is allowed to be larger because it is normalized locally
/// before it is saved or offered to sync. This also limits Tauri IPC memory.
pub(super) const MAX_IMPORT_SOURCE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMPORT_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMPORT_DECODE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct NormalizedImportImage {
    pub(super) bytes: Vec<u8>,
    pub(super) mime: &'static str,
    pub(super) compressed: bool,
}

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

pub(super) fn validate_cached_image_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_IMAGE_BYTES {
        return Err("背景图片不能超过 5MB".into());
    }
    Ok(())
}

pub(super) fn decode_import_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (header, encoded) = data_url.trim().split_once(',').ok_or("背景图片格式无效")?;
    let mime = mime_for_header(header).ok_or("背景图片仅支持 PNG、JPG、WebP 或 GIF")?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "背景图片编码无效")?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORT_SOURCE_BYTES {
        return Err("背景图片原文件不能超过 25MB".into());
    }
    Ok((bytes, mime))
}

fn image_format_for_mime(mime: &str) -> ImageFormat {
    match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        "image/gif" => ImageFormat::Gif,
        _ => unreachable!("supported MIME is checked before decoding"),
    }
}

fn decode_for_normalization(bytes: &[u8], mime: &str) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), image_format_for_mime(mime));
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMPORT_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMPORT_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMPORT_DECODE_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "背景图片无法解码或尺寸过大".to_string())
}

fn encode_lossless_webp(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let rgba = image.to_rgba8();
    let mut output = Vec::new();
    WebPEncoder::new_lossless(&mut output)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|_| "背景图片压缩失败".to_string())?;
    Ok(output)
}

/// Keep small files byte-for-byte intact. Larger imports are decoded once and
/// progressively downscaled into lossless WebP until their stored/synced form
/// fits the 5 MiB limit. Alpha is preserved; an oversized animated GIF becomes
/// the decoded first frame, which is appropriate for a non-animated page
/// background and avoids transmitting an oversized animation.
pub(super) fn normalize_import_image(
    bytes: Vec<u8>,
    mime: &'static str,
) -> Result<NormalizedImportImage, String> {
    if bytes.len() <= MAX_IMPORTED_IMAGE_BYTES {
        return Ok(NormalizedImportImage {
            bytes,
            mime,
            compressed: false,
        });
    }

    let source = decode_for_normalization(&bytes, mime)?;
    let mut width = source.width();
    let mut height = source.height();
    for _ in 0..20 {
        let resized = if width == source.width() && height == source.height() {
            source.clone()
        } else {
            source.resize(width, height, FilterType::Lanczos3)
        };
        let compressed = encode_lossless_webp(&resized)?;
        if compressed.len() <= MAX_IMPORTED_IMAGE_BYTES {
            return Ok(NormalizedImportImage {
                bytes: compressed,
                mime: "image/webp",
                compressed: true,
            });
        }
        if width == 1 || height == 1 {
            break;
        }
        width = (width.saturating_mul(3) / 4).max(1);
        height = (height.saturating_mul(3) / 4).max(1);
    }
    Err("背景图片压缩后仍超过 5MB".into())
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
        let (bytes, mime) = decode_import_data_url(" data:image/png;base64,aGk= ").unwrap();
        assert_eq!(bytes, b"hi");
        assert_eq!(mime, "image/png");
        assert!(decode_import_data_url("data:image/png;base64,").is_err());
        assert!(decode_import_data_url("data:image/svg+xml;base64,aGk=").is_err());
        assert!(decode_import_data_url("data:image/png;base64,not-base64").is_err());
    }

    #[test]
    fn bytes_are_bounded_and_hashes_are_lowercase_hex() {
        assert!(validate_cached_image_bytes(&[]).is_err());
        assert!(validate_cached_image_bytes(&vec![0; MAX_IMPORTED_IMAGE_BYTES + 1]).is_err());
        assert_eq!(
            sha256_hex(b"hi"),
            "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"
        );
    }

    #[test]
    fn oversized_import_is_downscaled_to_a_five_mib_webp_asset() {
        let image = image::RgbaImage::from_fn(1_700, 1_700, |x, y| {
            image::Rgba([
                ((x.wrapping_mul(17) ^ y.wrapping_mul(29)) & 0xff) as u8,
                ((x.wrapping_mul(41) ^ y.wrapping_mul(11)) & 0xff) as u8,
                ((x.wrapping_mul(7) ^ y.wrapping_mul(53)) & 0xff) as u8,
                255,
            ])
        });
        let mut source = Vec::new();
        image::codecs::png::PngEncoder::new(&mut source)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        assert!(source.len() > MAX_IMPORTED_IMAGE_BYTES);

        let normalized = normalize_import_image(source, "image/png").unwrap();
        assert!(normalized.compressed);
        assert_eq!(normalized.mime, "image/webp");
        assert!(normalized.bytes.len() <= MAX_IMPORTED_IMAGE_BYTES);
        assert!(image::load_from_memory_with_format(&normalized.bytes, ImageFormat::WebP).is_ok());
    }
}
