//! 从图书源文件派生标题、格式、本机身份、内容身份和纯文本的边界。
//!
//! 这里只读取调用方明确传入的文件，不访问书架、数据库或 Tauri 状态。

use sha2::{Digest, Sha256};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名".to_string())
}

pub fn ext_lower(path: &Path) -> String {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// 由文件路径稳定地算出 u64 ID（仅在导入时用来“铸造”一次 id，之后存盘不再依赖路径）。
pub fn id_for_path(path: &Path) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

/// 内容指纹：文件大小 + 首尾各 64KB 采样的哈希。够快，且对“同一本书换了路径”稳定。
/// 失败（文件不存在等）返回 0。
pub fn compute_fingerprint(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::metadata(path) else {
        return 0;
    };
    let length = metadata.len();
    let Ok(mut file) = std::fs::File::open(path) else {
        return 0;
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    length.hash(&mut hasher);
    let mut head = vec![0_u8; 65_536.min(length as usize)];
    if file.read_exact(&mut head).is_ok() {
        head.hash(&mut hasher);
    }
    if length > 131_072 {
        let mut tail = vec![0_u8; 65_536];
        if file.seek(SeekFrom::End(-65_536)).is_ok() && file.read_exact(&mut tail).is_ok() {
            tail.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// 完整文件 SHA-256，作为跨设备同步身份。只在导入、迁移或重新定位时计算一次。
pub fn compute_content_id(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return String::new();
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// GBK/UTF-8 自动识别，供 txt/md 图书解码。
pub fn decode_bytes(bytes: &[u8]) -> String {
    reader_core::text::decode_text_bytes(bytes)
}

/// 归一化 txt/md 图书的换行和文本。
pub fn normalize_text(text: &str) -> String {
    reader_core::text::normalize_text(text)
}

#[cfg(test)]
mod tests {
    use super::{
        compute_content_id, compute_fingerprint, decode_bytes, ext_lower, id_for_path,
        normalize_text, title_from_path,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("kunpeng-book-source-{stamp}"));
            fs::create_dir_all(&path).expect("create temp directory");
            Self(path)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).expect("write test source");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn derives_display_metadata_without_reading_the_file() {
        let path = Path::new("/books/书名.EPUB");
        assert_eq!(title_from_path(path), "书名");
        assert_eq!(ext_lower(path), "epub");
        assert_eq!(title_from_path(Path::new("/")), "未命名");
        assert!(ext_lower(Path::new("/books/无扩展名")).is_empty());
    }

    #[test]
    fn path_id_depends_on_path_while_content_id_depends_on_bytes() {
        let directory = TempDir::new();
        let first = directory.file("first.txt", b"same bytes");
        let second = directory.file("second.txt", b"same bytes");

        assert_ne!(id_for_path(&first), id_for_path(&second));
        assert_eq!(compute_content_id(&first), compute_content_id(&second));
        assert_eq!(
            compute_content_id(&first),
            "58100dc8fc06562ce3e578231dc948e083520ee49c4b4ee5a5a28bb4b4003feb"
        );
    }

    #[test]
    fn fingerprint_samples_the_tail_of_large_files() {
        let directory = TempDir::new();
        let mut first_bytes = vec![b'a'; 140_000];
        let mut second_bytes = first_bytes.clone();
        first_bytes[139_999] = b'x';
        second_bytes[139_999] = b'y';
        let first = directory.file("first.bin", &first_bytes);
        let second = directory.file("second.bin", &second_bytes);

        assert_ne!(compute_fingerprint(&first), compute_fingerprint(&second));
        assert_eq!(compute_fingerprint(&directory.0.join("missing")), 0);
        assert!(compute_content_id(&directory.0.join("missing")).is_empty());
    }

    #[test]
    fn delegates_plain_text_decoding_and_normalization() {
        assert_eq!(decode_bytes(b"hello"), "hello");
        assert_eq!(normalize_text("a\r\nb\r"), "a\nb");
    }
}
