use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
pub(crate) fn test_nonce() -> u64 {
    TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn temp_path_for(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("保存路径没有父目录")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("保存文件名不是有效 UTF-8")?;
    let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.tmp-{}-{nonce}", std::process::id())))
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain([0]).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain([0]).collect();
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(format!("原子替换失败：{}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("原子替换失败：{e}"))?;
    // 文件内容已 sync 后，再同步父目录，确保断电恢复时目录项替换也持久化。
    let parent = to.parent().ok_or("保存路径没有父目录")?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("同步数据目录失败：{e}"))
}

/// 提交已经在目标同目录中完整写好的临时文件。适用于无法一次放进内存的大向量；
/// 提交前同步文件内容，随后使用与 `write` 相同的原子替换语义。
pub(crate) fn commit_temp_file(temp: &Path, path: &Path) -> Result<(), String> {
    if temp.parent() != path.parent() {
        return Err("临时文件必须与目标文件位于同一目录".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp)
        .map_err(|e| format!("打开临时文件失败：{e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步临时文件失败：{e}"))?;
    drop(file);
    let result = replace_file(temp, path);
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

pub(crate) fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_with(path, |file| {
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        Ok(())
    })
}

/// Stream a large value into a same-directory temporary file and publish it
/// atomically only after the writer, flush and durability sync all succeed.
/// The closure may return checksums/lengths so callers do not need a second
/// full read or an in-memory serialized copy.
pub(crate) fn write_with<T, F>(path: &Path, writer: F) -> Result<T, String>
where
    F: FnOnce(&mut File) -> Result<T, String>,
{
    let parent = path.parent().ok_or("保存路径没有父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let temp = temp_path_for(path)?;
    let result = (|| {
        let mut file: File = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        let value = writer(&mut file)?;
        file.flush().map_err(|e| format!("刷新临时文件失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(file);
        replace_file(&temp, path)?;
        Ok(value)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T, pretty: bool) -> Result<(), String> {
    let bytes = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    }
    .map_err(|e| format!("序列化 JSON 失败：{e}"))?;
    write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomically_replaces_existing_contents() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-atomic-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = dir.join("data.json");
        write(&path, b"old").unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commits_a_streamed_temp_file_over_an_existing_target() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-atomic-stream-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vectors.bin");
        let temp = dir.join(".vectors.pending");
        write(&path, b"old").unwrap();
        std::fs::write(&temp, b"new-streamed-content").unwrap();
        commit_temp_file(&temp, &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new-streamed-content");
        assert!(!temp.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_stream_keeps_previous_target_and_removes_temporary_file() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-atomic-failed-stream-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = dir.join("index.bin");
        write(&path, b"stable").unwrap();
        let result = write_with(&path, |file| {
            file.write_all(b"partial").unwrap();
            Err::<(), _>("injected serialization failure".to_string())
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"stable");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
