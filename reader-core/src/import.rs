use std::collections::HashSet;

/// Source format names are platform-neutral.  Platform adapters decide how a
/// user selects or persists a document; the core only decides whether it is a
/// supported reading source.
pub fn extension_lower(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_supported_book_name(name: &str) -> bool {
    matches!(
        extension_lower(name).as_str(),
        "epub" | "pdf" | "txt" | "md" | "markdown" | "mobi" | "azw3" | "azw"
    )
}

pub fn normalize_import_locations(locations: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    locations
        .into_iter()
        .map(|location| location.trim().to_string())
        .filter(|location| !location.is_empty() && seen.insert(location.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_case_insensitive_reader_formats() {
        assert!(is_supported_book_name("book.EPUB"));
        assert!(is_supported_book_name("archive.azw3"));
        assert!(!is_supported_book_name("cover.png"));
    }
}
