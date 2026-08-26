use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(super) fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| {
            duration.as_secs().saturating_mul(1000) + u64::from(duration.subsec_millis())
        })
        .unwrap_or(0)
}

pub(super) fn epub_entry_sizes(path: &Path) -> HashMap<String, usize> {
    let mut sizes = HashMap::new();
    let Ok(file) = std::fs::File::open(path) else {
        return sizes;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return sizes;
    };
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        let size = entry.size().min(usize::MAX as u64) as usize;
        sizes.insert(entry.name().replace('\\', "/"), size);
    }
    sizes
}

fn epub_cache_dir() -> Option<PathBuf> {
    let mut directory = crate::profile::app_cache_dir()?;
    directory.push("epub-cache");
    let _ = std::fs::create_dir_all(&directory);
    Some(directory)
}

pub(super) fn meta_cache_path_for(id: u64, mtime: u64, version: u32) -> Option<PathBuf> {
    Some(epub_cache_dir()?.join(format!("meta-v{version}-{id}-{mtime}.json")))
}

pub(super) fn meta_cache_path(id: u64, mtime: u64, current_version: u32) -> Option<PathBuf> {
    meta_cache_path_for(id, mtime, current_version)
}

pub(super) fn chapter_cache_path_for(
    id: u64,
    mtime: u64,
    index: usize,
    version: u32,
) -> Option<PathBuf> {
    Some(epub_cache_dir()?.join(format!("chapter-v{version}-{id}-{mtime}-{index}.json")))
}

pub(super) fn chapter_cache_path(
    id: u64,
    mtime: u64,
    index: usize,
    current_version: u32,
) -> Option<PathBuf> {
    chapter_cache_path_for(id, mtime, index, current_version)
}

fn converted_chapter_cache_file_name(
    id: u64,
    mtime: u64,
    index: usize,
    version: u32,
    conversion_tag: u8,
) -> Option<String> {
    if !matches!(conversion_tag, 1 | 2) {
        return None;
    }
    Some(format!(
        "chapter-converted-v{version}-{id}-{mtime}-{index}-{conversion_tag}.json"
    ))
}

pub(super) fn converted_chapter_cache_path_for(
    id: u64,
    mtime: u64,
    index: usize,
    version: u32,
    conversion_tag: u8,
) -> Option<PathBuf> {
    let file_name = converted_chapter_cache_file_name(id, mtime, index, version, conversion_tag)?;
    Some(epub_cache_dir()?.join(file_name))
}

pub(super) fn converted_chapter_cache_path(
    id: u64,
    mtime: u64,
    index: usize,
    current_version: u32,
    conversion_tag: u8,
) -> Option<PathBuf> {
    converted_chapter_cache_path_for(id, mtime, index, current_version, conversion_tag)
}

#[cfg(test)]
mod tests {
    use super::converted_chapter_cache_file_name;

    #[test]
    fn converted_cache_file_name_is_generation_and_mode_specific() {
        assert_eq!(
            converted_chapter_cache_file_name(42, 1_725_000, 7, 3, 1).as_deref(),
            Some("chapter-converted-v3-42-1725000-7-1.json")
        );
        assert_eq!(
            converted_chapter_cache_file_name(42, 1_725_000, 7, 3, 2).as_deref(),
            Some("chapter-converted-v3-42-1725000-7-2.json")
        );
        assert_eq!(converted_chapter_cache_file_name(42, 1, 0, 3, 0), None);
        assert_eq!(converted_chapter_cache_file_name(42, 1, 0, 3, 3), None);
    }
}
