use super::EpubMetaCache;
use crate::book;
use std::collections::HashMap;

pub(super) const BIG_EPUB_CHAPTER_BYTES: usize = 800 * 1024;
const BIG_EPUB_CHAPTER_CHARS: usize = 1_000_000;
const VIRTUAL_CHAPTER_TARGET_BYTES: usize = 520 * 1024;
const VIRTUAL_CHAPTER_SEARCH_BYTES: usize = 160 * 1024;

pub(super) fn clamp_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn first_needle_pos(haystack: &str, needles: &[&str]) -> Option<usize> {
    needles
        .iter()
        .filter_map(|needle| haystack.find(needle))
        .min()
}

fn last_needle_pos(haystack: &str, needles: &[&str]) -> Option<(usize, usize)> {
    needles
        .iter()
        .filter_map(|needle| {
            haystack
                .rfind(needle)
                .map(|position| (position, needle.len()))
        })
        .max_by_key(|(position, _)| *position)
}

fn find_virtual_split(body: &str, start: usize, target: usize) -> usize {
    let len = body.len();
    let target = clamp_char_boundary(body, target.min(len));
    if target >= len {
        return len;
    }

    let forward_end = clamp_char_boundary(body, (target + VIRTUAL_CHAPTER_SEARCH_BYTES).min(len));
    if forward_end > target {
        let window = &body[target..forward_end];
        if let Some(position) = first_needle_pos(
            window,
            &[
                "<h1", "<h2", "<h3", "<h4", "<h5", "<h6", "<p", "<div", "<section", "<H1", "<H2",
                "<H3", "<H4", "<H5", "<H6", "<P", "<DIV", "<SECTION",
            ],
        ) {
            return clamp_char_boundary(body, target + position);
        }
        if let Some((position, needle_len)) =
            first_needle_pos(window, &["</p>", "</P>"]).map(|position| (position, 4usize))
        {
            return clamp_char_boundary(body, target + position + needle_len);
        }
    }

    let backward_start = clamp_char_boundary(
        body,
        target
            .saturating_sub(VIRTUAL_CHAPTER_SEARCH_BYTES)
            .max(start),
    );
    if backward_start < target {
        let window = &body[backward_start..target];
        if let Some((position, needle_len)) = last_needle_pos(
            window,
            &[
                "</p>",
                "</div>",
                "</section>",
                "</h1>",
                "</h2>",
                "</h3>",
                "</P>",
                "</DIV>",
                "</SECTION>",
                "</H1>",
                "</H2>",
                "</H3>",
            ],
        ) {
            let split = backward_start + position + needle_len;
            if split > start {
                return clamp_char_boundary(body, split);
            }
        }
    }

    target
}

pub(super) fn split_body_ranges(body: &str, html_len: usize) -> Vec<(usize, usize)> {
    if html_len <= BIG_EPUB_CHAPTER_BYTES && body.chars().count() <= BIG_EPUB_CHAPTER_CHARS {
        return vec![(0, body.len())];
    }
    let mut ranges = Vec::new();
    let mut start = 0usize;
    let len = body.len();
    while start < len {
        let target = start.saturating_add(VIRTUAL_CHAPTER_TARGET_BYTES).min(len);
        let mut end = find_virtual_split(body, start, target);
        if end <= start {
            end = clamp_char_boundary(body, target);
        }
        if end <= start {
            end = len;
        }
        ranges.push((start, end));
        start = end;
    }
    if ranges.is_empty() {
        ranges.push((0, body.len()));
    }
    ranges
}

pub(super) fn build_virtual_chapter_map(
    spine_paths: &[String],
    physical_to_virtual: &[u32],
) -> HashMap<String, usize> {
    spine_paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            (
                path.clone(),
                physical_to_virtual
                    .get(index)
                    .copied()
                    .unwrap_or(index as u32) as usize,
            )
        })
        .collect()
}

pub(super) fn map_physical_chapter_to_virtual(meta: &EpubMetaCache, chapter: u32) -> u32 {
    let index = chapter as usize;
    if index < meta.physical_to_virtual.len() {
        meta.physical_to_virtual[index]
    } else {
        chapter.min(meta.virtuals.len().saturating_sub(1) as u32)
    }
}

pub(super) fn clamp_virtual_chapter(meta: &EpubMetaCache, chapter: u32) -> u32 {
    chapter.min(meta.virtuals.len().saturating_sub(1) as u32)
}

/// Move both the legacy chapter field and the authoritative text anchor. A
/// `ReadingPosition::normalized` value takes its chapter from the anchor, so
/// changing only the legacy field would silently restore the old physical
/// chapter whenever an anchor exists.
pub(super) fn remap_reading_position_chapter(
    position: &mut reader_core::ReadingPosition,
    meta: &EpubMetaCache,
) {
    position.chapter = map_physical_chapter_to_virtual(meta, position.chapter);
    if let Some(anchor) = position.anchor.as_mut() {
        anchor.chapter = map_physical_chapter_to_virtual(meta, anchor.chapter);
    }
    *position = position.clone().normalized();
}

/// Even a current-format bookmark can point past the final virtual chapter
/// after the underlying EPUB was replaced or re-imported. Keep the legacy
/// field and its authoritative anchor within the same document bounds.
pub(super) fn clamp_reading_position_chapter(
    position: &mut reader_core::ReadingPosition,
    meta: &EpubMetaCache,
) {
    position.chapter = clamp_virtual_chapter(meta, position.chapter);
    if let Some(anchor) = position.anchor.as_mut() {
        anchor.chapter = clamp_virtual_chapter(meta, anchor.chapter);
    }
    *position = position.clone().normalized();
}

pub(super) fn remap_highlight_chapter(highlight: &mut book::Highlight, meta: &EpubMetaCache) {
    highlight.chapter = map_physical_chapter_to_virtual(meta, highlight.chapter);
    if let Some(range) = highlight.range_anchor.as_mut() {
        for anchor in [&mut range.start, &mut range.end].into_iter().flatten() {
            anchor.chapter = map_physical_chapter_to_virtual(meta, anchor.chapter);
        }
    }
}

pub(super) fn clamp_highlight_chapter(highlight: &mut book::Highlight, meta: &EpubMetaCache) {
    highlight.chapter = clamp_virtual_chapter(meta, highlight.chapter);
    if let Some(range) = highlight.range_anchor.as_mut() {
        for anchor in [&mut range.start, &mut range.end].into_iter().flatten() {
            anchor.chapter = clamp_virtual_chapter(meta, anchor.chapter);
        }
    }
}

#[cfg(test)]
pub(super) const TEST_VIRTUAL_CHAPTER_TARGET_BYTES: usize = VIRTUAL_CHAPTER_TARGET_BYTES;
