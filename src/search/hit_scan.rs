const MAX_BOOK_HITS: u32 = 3000;
const MAX_PREVIEW_HITS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct HitLocation {
    pub(super) chapter: usize,
    pub(super) byte_offset: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct BookHitScan {
    pub(super) count: u32,
    pub(super) previews: Vec<HitLocation>,
}

fn chapter_bytes<'a>(
    chapters: &'a [String],
    folded_chapters: Option<&'a [Vec<u8>]>,
    chapter: usize,
) -> &'a [u8] {
    folded_chapters
        .map(|folded| folded[chapter].as_slice())
        .unwrap_or_else(|| chapters[chapter].as_bytes())
}

/// Scan one book in stable chapter/byte order, retaining only the preview
/// locations needed by the first response while preserving the total-hit cap.
pub(super) fn scan_book_hits(
    chapters: &[String],
    folded_chapters: Option<&[Vec<u8>]>,
    term: &[u8],
) -> BookHitScan {
    let finder = memchr::memmem::Finder::new(term);
    let mut count = 0u32;
    let mut previews = Vec::new();
    for chapter in 0..chapters.len() {
        for byte_offset in finder.find_iter(chapter_bytes(chapters, folded_chapters, chapter)) {
            count += 1;
            if previews.len() < MAX_PREVIEW_HITS {
                previews.push(HitLocation {
                    chapter,
                    byte_offset,
                });
            }
            if count >= MAX_BOOK_HITS {
                return BookHitScan { count, previews };
            }
        }
    }
    BookHitScan { count, previews }
}

/// Return a stable page of hit locations. Offset and limit are normalized by
/// the caller so this function owns only the ordered scan and page projection.
pub(super) fn scan_hit_page(
    chapters: &[String],
    folded_chapters: Option<&[Vec<u8>]>,
    term: &[u8],
    offset: usize,
    limit: usize,
) -> Vec<HitLocation> {
    let finder = memchr::memmem::Finder::new(term);
    let mut seen = 0usize;
    let mut hits = Vec::with_capacity(limit);
    for chapter in 0..chapters.len() {
        for byte_offset in finder.find_iter(chapter_bytes(chapters, folded_chapters, chapter)) {
            if seen >= offset {
                hits.push(HitLocation {
                    chapter,
                    byte_offset,
                });
                if hits.len() >= limit {
                    return hits;
                }
            }
            seen += 1;
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_scan_preserves_chapter_order_and_preview_cap() {
        let chapters = vec!["aa aa".to_string(), "aa ".repeat(10)];
        let scan = scan_book_hits(&chapters, None, b"aa");

        assert_eq!(scan.count, 12);
        assert_eq!(scan.previews.len(), 8);
        assert_eq!(
            &scan.previews[..3],
            &[
                HitLocation {
                    chapter: 0,
                    byte_offset: 0,
                },
                HitLocation {
                    chapter: 0,
                    byte_offset: 3,
                },
                HitLocation {
                    chapter: 1,
                    byte_offset: 0,
                },
            ]
        );
    }

    #[test]
    fn book_scan_caps_total_hits_at_existing_limit() {
        let chapters = vec!["a".repeat(4000)];
        let scan = scan_book_hits(&chapters, None, b"a");
        assert_eq!(scan.count, MAX_BOOK_HITS);
        assert_eq!(scan.previews.len(), MAX_PREVIEW_HITS);
    }

    #[test]
    fn page_scan_applies_offset_and_limit_in_stable_order() {
        let chapters = vec!["aa aa".to_string(), "aa aa".to_string()];
        assert_eq!(
            scan_hit_page(&chapters, None, b"aa", 1, 2),
            vec![
                HitLocation {
                    chapter: 0,
                    byte_offset: 3,
                },
                HitLocation {
                    chapter: 1,
                    byte_offset: 0,
                },
            ]
        );
    }

    #[test]
    fn folded_scan_uses_folded_offsets_without_changing_projection() {
        let chapters = vec!["Rust RUST".to_string()];
        let folded = vec![b"rust rust".to_vec()];
        let scan = scan_book_hits(&chapters, Some(&folded), b"rust");
        assert_eq!(
            scan.previews,
            vec![
                HitLocation {
                    chapter: 0,
                    byte_offset: 0,
                },
                HitLocation {
                    chapter: 0,
                    byte_offset: 5,
                },
            ]
        );
    }
}
