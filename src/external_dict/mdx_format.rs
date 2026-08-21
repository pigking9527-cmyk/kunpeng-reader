//! Pure MDX/MDD byte-format helpers.
//!
//! File I/O, decompression, dictionary imports, SQLite and process locks remain
//! in the parent module. These helpers only validate byte ranges and decode
//! header/text fields.

use encoding_rs::Encoding;

pub(super) fn be_u16_at(data: &[u8], pos: usize) -> Result<u16, String> {
    let bytes = data
        .get(pos..pos.saturating_add(2))
        .ok_or("MDX 数据不完整")?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

pub(super) fn be_u32_at(data: &[u8], pos: usize) -> Result<u32, String> {
    let bytes = data
        .get(pos..pos.saturating_add(4))
        .ok_or("MDX 数据不完整")?;
    Ok(u32::from_be_bytes(
        bytes.try_into().expect("length checked"),
    ))
}

pub(super) fn be_u64_at(data: &[u8], pos: usize) -> Result<u64, String> {
    let bytes = data
        .get(pos..pos.saturating_add(8))
        .ok_or("MDX 数据不完整")?;
    Ok(u64::from_be_bytes(
        bytes.try_into().expect("length checked"),
    ))
}

pub(super) fn decode_header(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return text.into_owned();
    }
    let zero_odd = bytes.len() > 2
        && bytes
            .iter()
            .skip(1)
            .step_by(2)
            .take(16)
            .all(|byte| *byte == 0);
    if zero_odd {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return text.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

pub(super) fn decode_text(bytes: &[u8], encoding: &str) -> String {
    let normalized = encoding.to_ascii_uppercase();
    if normalized.contains("UTF-16") || normalized.contains("UTF16") {
        if bytes.starts_with(&[0xfe, 0xff]) || normalized.contains("BE") {
            let (text, _, _) =
                encoding_rs::UTF_16BE.decode(bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(bytes));
            text.into_owned()
        } else {
            let (text, _, _) =
                encoding_rs::UTF_16LE.decode(bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes));
            text.into_owned()
        }
    } else if normalized.contains("GB") || normalized.contains("BIG5") {
        let encoding = Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        let (text, _, _) = encoding.decode(bytes);
        text.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub(super) fn header_attr(header: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"{key}=""#);
    header.find(&pattern).and_then(|index| {
        let rest = &header[index + pattern.len()..];
        rest.find('"').map(|end| rest[..end].trim().to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_readers_reject_truncated_or_overflowed_ranges() {
        assert_eq!(be_u16_at(&[0x12, 0x34], 0).unwrap(), 0x1234);
        assert_eq!(be_u32_at(&[0, 0, 0, 7], 0).unwrap(), 7);
        assert_eq!(be_u64_at(&[0, 0, 0, 0, 0, 0, 0, 9], 0).unwrap(), 9);
        assert_eq!(be_u32_at(&[0, 1, 2], 0).unwrap_err(), "MDX 数据不完整");
        assert_eq!(
            be_u64_at(&[0; 8], usize::MAX).unwrap_err(),
            "MDX 数据不完整"
        );
    }

    #[test]
    fn header_decoder_handles_utf16_bom_and_plain_utf8() {
        assert_eq!(decode_header(&[0xff, 0xfe, b'A', 0]), "A");
        assert_eq!(decode_header(b"Title=plain"), "Title=plain");
    }

    #[test]
    fn header_attribute_is_trimmed_and_missing_values_are_absent() {
        let header = r#"<Dictionary Title="  Reader  " Encoding="UTF-8"/>"#;
        assert_eq!(header_attr(header, "Title").as_deref(), Some("Reader"));
        assert_eq!(header_attr(header, "Missing"), None);
    }
}
