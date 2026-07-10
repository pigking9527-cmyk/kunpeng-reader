use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    std::fs::rename(from, to).map_err(|e| format!("原子替换失败：{e}"))
}

pub(crate) fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存路径没有父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let temp = temp_path_for(path)?;
    let result = (|| {
        let mut file: File = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.flush().map_err(|e| format!("刷新临时文件失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(file);
        replace_file(&temp, path)
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
}
