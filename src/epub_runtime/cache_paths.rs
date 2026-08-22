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
