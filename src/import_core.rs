use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn is_supported_book_path(path: &Path) -> bool {
    reader_core::import::is_supported_book_name(&path.to_string_lossy())
}

pub fn filter_new_book_paths(
    found: impl IntoIterator<Item = PathBuf>,
    known: &HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|path| !known.contains(path) && seen.insert(path.clone()))
        .collect()
}

pub fn normalize_import_dirs(dirs: impl IntoIterator<Item = String>) -> Vec<String> {
    reader_core::import::normalize_import_locations(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_book_path_accepts_reader_formats_case_insensitively() {
        for name in [
            "a.epub",
            "b.PDF",
            "c.txt",
            "d.md",
            "e.markdown",
            "f.mobi",
            "g.azw3",
            "h.AZW",
        ] {
            assert!(is_supported_book_path(Path::new(name)), "{name}");
        }
        assert!(!is_supported_book_path(Path::new("cover.jpg")));
        assert!(!is_supported_book_path(Path::new("no_extension")));
    }

    #[test]
    fn filter_new_book_paths_removes_known_and_duplicate_paths() {
        let a = PathBuf::from("a.epub");
        let b = PathBuf::from("b.epub");
        let c = PathBuf::from("c.epub");
        let known = HashSet::from([b.clone()]);
        let out = filter_new_book_paths([a.clone(), b, a.clone(), c.clone()], &known);
        assert_eq!(out, vec![a, c]);
    }

    #[test]
    fn normalize_import_dirs_trims_drops_empty_and_preserves_first_unique() {
        let out = normalize_import_dirs([
            "  C:/Books  ".to_string(),
            "".to_string(),
            "C:/Books".to_string(),
            "D:/More".to_string(),
            "   ".to_string(),
        ]);
        assert_eq!(out, vec!["C:/Books".to_string(), "D:/More".to_string()]);
    }
}
