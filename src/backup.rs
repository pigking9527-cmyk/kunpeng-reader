use crate::{atomic_file, db, stats::StatsStore, vocab::VocabStore, AppState};
use chrono::Local;
use serde::{Deserialize, Serialize};
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
    backups: Vec<BackupEntry>,
}

#[derive(Clone, Serialize)]
pub(crate) struct BackupEntry {
    id: String,
    created_at: String,
    total_bytes: u64,
}

#[derive(Serialize, Deserialize)]
struct BackupManifest {
    format: String,
    version: u32,
    app_version: String,
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

fn manifest_for(path: &Path) -> Result<BackupManifest, String> {
    let manifest = std::fs::read_to_string(path.join("manifest.json"))
        .map_err(|e| format!("读取恢复点清单失败 {}：{e}", path.display()))?;
    let manifest: BackupManifest = serde_json::from_str(&manifest)
        .map_err(|e| format!("恢复点清单格式无效 {}：{e}", path.display()))?;
    if manifest.format != "kunpeng-reader-recovery" || manifest.version != 1 {
        return Err(format!("不支持的恢复点格式：{}", path.display()));
    }
    if !manifest.files.iter().any(|name| name == "reader.db") {
        return Err(format!("恢复点缺少 reader.db：{}", path.display()));
    }
    Ok(manifest)
}

fn backup_entry(path: &Path) -> BackupEntry {
    let id = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let created_at = manifest_for(path)
        .map(|manifest| manifest.created_at)
        .unwrap_or_else(|_| id.clone());
    BackupEntry {
        id,
        created_at,
        total_bytes: directory_bytes(path),
    }
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
        backups: backups
            .iter()
            .rev()
            .map(|path| backup_entry(path))
            .collect(),
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
                format: "kunpeng-reader-recovery".to_string(),
                version: 1,
                app_version: env!("CARGO_PKG_VERSION").to_string(),
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

fn safe_backup_id(id: &str) -> bool {
    !id.is_empty()
        && std::path::Path::new(id).components().count() == 1
        && !id.contains(['/', '\\'])
        && !id.starts_with('.')
}

fn recovery_directory(id: &str) -> Result<PathBuf, String> {
    if !safe_backup_id(id) {
        return Err("恢复点标识无效".to_string());
    }
    let path = backup_root()?.join(id);
    if !path.is_dir() {
        return Err("所选恢复点不存在或已被清理".to_string());
    }
    Ok(path)
}

fn staging_path(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("无法确定恢复目标目录：{}", destination.display()))?;
    let name = destination
        .file_name()
        .ok_or_else(|| format!("恢复目标无文件名：{}", destination.display()))?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{label}-{}", std::process::id())))
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("恢复点文件缺失：{}", source.display()));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let staged = staging_path(destination, "restore-new")?;
    let previous = staging_path(destination, "restore-previous")?;
    let _ = std::fs::remove_file(&staged);
    let _ = std::fs::remove_file(&previous);
    std::fs::copy(source, &staged)
        .map_err(|e| format!("复制恢复点文件失败 {}：{e}", source.display()))?;

    let had_previous = destination.exists();
    if had_previous {
        std::fs::rename(destination, &previous)
            .map_err(|e| format!("暂存当前文件失败 {}：{e}", destination.display()))?;
    }
    if let Err(error) = std::fs::rename(&staged, destination) {
        if had_previous {
            let _ = std::fs::rename(&previous, destination);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!(
            "提交恢复文件失败 {}：{error}",
            destination.display()
        ));
    }
    let _ = std::fs::remove_file(&previous);
    Ok(())
}

fn remove_sqlite_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        let _ = std::fs::remove_file(sidecar);
    }
}

/// Restore a recovery point after first capturing the current state. The
/// database connection is deliberately reopened before returning so the UI can
/// immediately reload the recovered shelf without asking users to restart.
pub(crate) fn restore(state: &AppState, id: &str) -> Result<BackupStatus, String> {
    let recovery = recovery_directory(id)?;
    let manifest = manifest_for(&recovery)?;
    let snapshot_db = recovery.join("reader.db");
    let snapshot = rusqlite::Connection::open(&snapshot_db)
        .map_err(|e| format!("打开恢复点数据库失败：{e}"))?;
    let quick_check: String = snapshot
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("检查恢复点数据库失败：{e}"))?;
    if quick_check != "ok" {
        return Err(format!("恢复点数据库完整性检查失败：{quick_check}"));
    }
    drop(snapshot);

    // Never overwrite the current state without a fresh, independently
    // verified recovery point that the user can return to.
    create(state, true)?;
    let _operation = BACKUP_LOCK
        .lock()
        .map_err(|_| "恢复点任务锁定失败".to_string())?;

    let config = config_dir()?;
    let database_path = db::database_path()?;
    {
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        *guard = None;
    }
    remove_sqlite_sidecars(&database_path);
    replace_file(&snapshot_db, &database_path)?;

    for name in PORTABLE_FILES.iter().chain(SQLITE_FILES.iter()) {
        if manifest.files.iter().any(|file| file == name) {
            let destination = config.join(name);
            if *name == "external-dicts.db" {
                remove_sqlite_sidecars(&destination);
            }
            replace_file(&recovery.join(name), &destination)?;
        }
    }

    {
        let mut guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        *guard = Some(db::AppDb::open()?);
    }
    *state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())? = crate::book::Library::load();
    *state.stats.lock().map_err(|_| "统计锁定失败".to_string())? = StatsStore::load();
    *state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())? = VocabStore::load();
    state.reset_runtime_caches_after_restore();
    status()
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

    #[test]
    fn recovery_ids_cannot_escape_the_backup_directory() {
        assert!(safe_backup_id("20260720-185825-180"));
        assert!(!safe_backup_id("../reader.db"));
        assert!(!safe_backup_id("a/b"));
        assert!(!safe_backup_id(".temporary"));
    }
}
