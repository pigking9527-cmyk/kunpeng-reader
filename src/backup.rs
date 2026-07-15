use crate::{atomic_file, AppState};
use chrono::Local;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_RECOVERY_BACKUPS: usize = 7;
const BACKUP_METADATA_KEY: &str = "last_recovery_backup_day";
const PORTABLE_FILES: &[&str] = &["library.json", "stats.json", "vocab.json"];
const SQLITE_FILES: &[&str] = &["external-dicts.db"];
static BACKUP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Default, Serialize)]
pub(crate) struct BackupStatus {
    directory: String,
    latest: String,
    count: u32,
    total_bytes: u64,
    created: bool,
}

#[derive(Serialize)]
struct BackupManifest {
    format: &'static str,
    version: u32,
    app_version: &'static str,
    created_at: String,
    files: Vec<String>,
}

fn config_dir() -> Result<PathBuf, String> {
    let mut dir = dirs::config_dir().ok_or("无法确定应用配置目录")?;
    dir.push("ebook-reader");
    Ok(dir)
}

fn backup_root() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("backups"))
}

fn directory_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_bytes(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn backup_directories() -> Result<Vec<PathBuf>, String> {
    let root = backup_root()?;
    let mut backups = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_dir()
                        && !path
                            .file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    backups.sort();
    Ok(backups)
}

pub(crate) fn status() -> Result<BackupStatus, String> {
    let root = backup_root()?;
    let backups = backup_directories()?;
    Ok(BackupStatus {
        directory: root.to_string_lossy().into_owned(),
        latest: backups
            .last()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        count: backups.len() as u32,
        total_bytes: backups.iter().map(|path| directory_bytes(path)).sum(),
        created: false,
    })
}

fn rotate_backups() -> Result<(), String> {
    let backups = backup_directories()?;
    let remove_count = backups.len().saturating_sub(MAX_RECOVERY_BACKUPS);
    for path in backups.into_iter().take(remove_count) {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("删除旧恢复点失败 {}：{e}", path.display()))?;
    }
    Ok(())
}

pub(crate) fn create(state: &AppState, force: bool) -> Result<BackupStatus, String> {
    let _operation = BACKUP_LOCK
        .lock()
        .map_err(|_| "恢复点任务锁定失败".to_string())?;
    let day = Local::now().format("%Y-%m-%d").to_string();
    if !force {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        if db.metadata(BACKUP_METADATA_KEY).as_deref() == Some(day.as_str()) {
            return status();
        }
    }

    state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?
        .save()?;
    state
        .stats
        .lock()
        .map_err(|_| "统计锁定失败".to_string())?
        .save()?;
    state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())?
        .save()?;

    let root = backup_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建恢复点目录失败：{e}"))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let final_dir = root.join(&stamp);
    let temp_dir = root.join(format!(".{stamp}.tmp-{}", std::process::id()));
    std::fs::create_dir(&temp_dir).map_err(|e| format!("创建临时恢复点失败：{e}"))?;

    let result = (|| {
        {
            let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
            db.backup_to(&temp_dir.join("reader.db"))?;
        }
        let config = config_dir()?;
        let mut files = vec!["reader.db".to_string()];
        for name in PORTABLE_FILES {
            let source = config.join(name);
            if source.is_file() {
                std::fs::copy(&source, temp_dir.join(name))
                    .map_err(|e| format!("备份 {name} 失败：{e}"))?;
                files.push((*name).to_string());
            }
        }
        for name in SQLITE_FILES {
            let source = config.join(name);
            if !source.is_file() {
                continue;
            }
            let destination = temp_dir.join(name);
            let connection = rusqlite::Connection::open(&source)
                .map_err(|e| format!("打开 {name} 失败：{e}"))?;
            connection
                .execute(
                    "VACUUM INTO ?1",
                    rusqlite::params![destination.to_string_lossy().as_ref()],
                )
                .map_err(|e| format!("备份 {name} 失败：{e}"))?;
            files.push((*name).to_string());
        }
        atomic_file::write_json(
            &temp_dir.join("manifest.json"),
            &BackupManifest {
                format: "kunpeng-reader-recovery",
                version: 1,
                app_version: env!("CARGO_PKG_VERSION"),
                created_at: Local::now().to_rfc3339(),
                files,
            },
            true,
        )?;
        std::fs::rename(&temp_dir, &final_dir).map_err(|e| format!("提交恢复点失败：{e}"))?;
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.set_metadata(BACKUP_METADATA_KEY, &day)?;
        rotate_backups()
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    result?;
    let mut current = status()?;
    current.created = true;
    Ok(current)
}

pub(crate) fn spawn_daily(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        let state = app.state::<AppState>();
        if let Err(error) = create(state.inner(), false) {
            eprintln!("[backup] daily recovery point failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_limit_is_small_and_bounded() {
        assert_eq!(MAX_RECOVERY_BACKUPS, 7);
        assert!(PORTABLE_FILES.contains(&"library.json"));
        assert!(PORTABLE_FILES.contains(&"stats.json"));
        assert!(PORTABLE_FILES.contains(&"vocab.json"));
        assert!(SQLITE_FILES.contains(&"external-dicts.db"));
    }
}
