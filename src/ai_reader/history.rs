//! Pure matching and presentation rules for legacy local AI-history sources.
//!
//! The parent module owns the Tauri command, shelf lock and chapter I/O. This
//! module deliberately receives only the minimum local book identity needed
//! to decide whether a legacy citation can be reopened on this device.

#[derive(Debug, Clone, Copy)]
pub(super) struct LocalHistoryBookRef<'a> {
    pub(super) id: u64,
    pub(super) title: &'a str,
}

/// Resolves an old synchronized reference without ever treating a stale local
/// id as authoritative when the historical title is present. A title-less
/// record may use the local id as the compatibility fallback.
pub(super) fn matching_local_book_id<'a>(
    books: impl IntoIterator<Item = LocalHistoryBookRef<'a>>,
    historical_book_id: &str,
    historical_book_title: &str,
) -> Option<u64> {
    let normalized_title = normalize_history_book_title(historical_book_title);
    let books = books.into_iter().collect::<Vec<_>>();
    if !normalized_title.is_empty() {
        return books
            .iter()
            .find(|book| normalize_history_book_title(book.title) == normalized_title)
            .map(|book| book.id);
    }

    books
        .iter()
        .find(|book| book.id.to_string() == historical_book_id)
        .map(|book| book.id)
}

pub(super) fn restored_source_kind(original_kind: &str) -> String {
    let original_kind = original_kind.trim();
    if original_kind.is_empty() {
        "旧记录恢复的章节正文".to_string()
    } else {
        format!("{original_kind}（旧记录恢复的章节正文）")
    }
}

fn normalize_history_book_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(
                    character,
                    '《' | '》'
                        | '〈'
                        | '〉'
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '「'
                        | '」'
                        | '『'
                        | '』'
                        | '"'
                )
        })
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{matching_local_book_id, restored_source_kind, LocalHistoryBookRef};

    fn refs() -> [LocalHistoryBookRef<'static>; 2] {
        [
            LocalHistoryBookRef {
                id: 7,
                title: "《南明史》",
            },
            LocalHistoryBookRef {
                id: 8,
                title: "别的书",
            },
        ]
    }

    #[test]
    fn title_matching_ignores_presentation_punctuation_and_case() {
        assert_eq!(matching_local_book_id(refs(), "8", " 南明史 "), Some(7));
    }

    #[test]
    fn title_prevents_a_stale_local_id_from_opening_another_book() {
        assert_eq!(matching_local_book_id(refs(), "8", "不存在的书"), None);
    }

    #[test]
    fn titleless_legacy_record_can_use_its_local_id() {
        assert_eq!(matching_local_book_id(refs(), "8", "  "), Some(8));
    }

    #[test]
    fn restored_source_kind_preserves_provenance() {
        assert_eq!(restored_source_kind(""), "旧记录恢复的章节正文");
        assert_eq!(
            restored_source_kind("语义片段"),
            "语义片段（旧记录恢复的章节正文）"
        );
    }
}
