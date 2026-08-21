use chardetng::EncodingDetector;

/// Decode a text document without assuming a host filesystem or OS path.
pub fn decode_text_bytes(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let (text, _, _) = detector.guess(None, true).decode(bytes);
    text.into_owned()
}

pub fn normalize_text(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut newlines = 0;
    for character in unified.chars() {
        if character == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
        } else {
            newlines = 0;
            out.push(character);
        }
    }
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_line_endings_and_runs() {
        assert_eq!(normalize_text("a\r\n\r\n\r\nb"), "a\n\nb");
    }
}
