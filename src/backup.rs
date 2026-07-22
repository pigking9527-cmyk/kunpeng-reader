use crate::{atomic_file, db, stats::StatsStore, vocab::VocabStore, AppState};
use chrono::Local;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_RECOVERY_BACKUPS: usize = 7;
const BACKUP_METADATA_KEY: &str = "last_recovery_backup_day";
const PORTABLE_FILES: &[&str] = &["library.json", "stats.json", "vocab.json"];
const SQLITE_FILES: &[&str] = &["external-dicts.db"];
const RESTORE_TRANSACTION_FILE: &str = ".restore-transaction.json";
const RESTORE_TRANSACTION_VERSION: u32 = 2;
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
    files: Vec<BackupManifestFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum BackupManifestFile {
    Legacy(String),
    Verified {
        name: String,
        bytes: u64,
        sha256: String,
    },
}

impl BackupManifestFile {
    fn name(&self) -> &str {
        match self {
            Self::Legacy(name) | Self::Verified { name, .. } => name,
        }
    }
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

fn file_sha256(path: &Path) -> Result<(u64, String), String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("打开校验文件失败 {}：{error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取校验文件失败 {}：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read as u64);
    }
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    Ok((total, sha256))
}

fn verified_manifest_file(directory: &Path, name: &str) -> Result<BackupManifestFile, String> {
    let (bytes, sha256) = file_sha256(&directory.join(name))?;
    Ok(BackupManifestFile::Verified {
        name: name.into(),
        bytes,
        sha256,
    })
}

fn manifest_contains(manifest: &BackupManifest, name: &str) -> bool {
    manifest.files.iter().any(|file| file.name() == name)
}

fn validate_manifest_files(path: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for file in &manifest.files {
        let name = file.name();
        if !seen.insert(name) || std::path::Path::new(name).components().count() != 1 {
            return Err(format!("恢复点文件名无效或重复：{name}"));
        }
        let file_path = path.join(name);
        if !file_path.is_file() {
            return Err(format!("恢复点文件缺失：{}", file_path.display()));
        }
        if let BackupManifestFile::Verified { bytes, sha256, .. } = file {
            let (actual_bytes, actual_sha256) = file_sha256(&file_path)?;
            if actual_bytes != *bytes || actual_sha256 != *sha256 {
                return Err(format!("恢复点文件完整性检查失败：{name}"));
            }
        }
    }
    Ok(())
}

fn manifest_for(path: &Path) -> Result<BackupManifest, String> {
    let manifest = std::fs::read_to_string(path.join("manifest.json"))
        .map_err(|e| format!("读取恢复点清单失败 {}：{e}", path.display()))?;
    let manifest: BackupManifest = serde_json::from_str(&manifest)
        .map_err(|e| format!("恢复点清单格式无效 {}：{e}", path.display()))?;
    if manifest.format != "kunpeng-reader-recovery" || !matches!(manifest.version, 1 | 2) {
        return Err(format!("不支持的恢复点格式：{}", path.display()));
    }
    if !manifest_contains(&manifest, "reader.db") {
        return Err(format!("恢复点缺少 reader.db：{}", path.display()));
    }
    validate_manifest_files(path, &manifest)?;
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

fn backup_sort_key(path: &Path) -> i128 {
    if let Ok(manifest) = manifest_for(path) {
        if let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&manifest.created_at) {
            return created_at.timestamp_millis() as i128;
        }
    }
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i128)
        .unwrap_or(i128::MIN)
}

fn rotate_backup_paths(mut backups: Vec<PathBuf>, protected: Option<&Path>) -> Result<(), String> {
    backups.sort_by(|left, right| {
        backup_sort_key(left)
            .cmp(&backup_sort_key(right))
            .then_with(|| left.cmp(right))
    });
    let remove_count = backups.len().saturating_sub(MAX_RECOVERY_BACKUPS);
    let removable = backups
        .into_iter()
        .filter(|path| protected != Some(path.as_path()))
        .take(remove_count)
        .collect::<Vec<_>>();
    if removable.len() != remove_count {
        return Err("恢复点轮转无法在保护本次快照的同时满足保留数量".into());
    }
    for path in removable {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("删除旧恢复点失败 {}：{e}", path.display()))?;
    }
    Ok(())
}

fn rotate_backups(protected: Option<&Path>) -> Result<(), String> {
    rotate_backup_paths(backup_directories()?, protected)
}

struct LockedCoreData<'a> {
    library: std::sync::MutexGuard<'a, crate::book::Library>,
    stats: std::sync::MutexGuard<'a, StatsStore>,
    vocab: std::sync::MutexGuard<'a, VocabStore>,
    db: std::sync::MutexGuard<'a, Option<db::AppDb>>,
}

fn lock_core_data(state: &AppState) -> Result<LockedCoreData<'_>, String> {
    // Fixed order for every multi-file snapshot/restore. Holding the complete
    // set prevents imports, sync, reading stats and shelf edits from crossing
    // the snapshot/installation boundary.
    let library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let stats = state.stats.lock().map_err(|_| "统计锁定失败".to_string())?;
    let vocab = state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())?;
    let db = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    Ok(LockedCoreData {
        library,
        stats,
        vocab,
        db,
    })
}

fn create_locked_with_data(
    data: &mut LockedCoreData<'_>,
    force: bool,
) -> Result<BackupStatus, String> {
    let day = Local::now().format("%Y-%m-%d").to_string();
    let db = data.db.as_ref().ok_or("SQLite 数据库不可用")?;
    if !force && db.metadata(BACKUP_METADATA_KEY).as_deref() == Some(day.as_str()) {
        return status();
    }

    data.library.save()?;
    data.stats.save()?;
    data.vocab.save()?;

    let root = backup_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建恢复点目录失败：{e}"))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let final_dir = root.join(&stamp);
    let temp_dir = root.join(format!(".{stamp}.tmp-{}", std::process::id()));
    std::fs::create_dir(&temp_dir).map_err(|e| format!("创建临时恢复点失败：{e}"))?;

    let result = (|| {
        db.backup_to(&temp_dir.join("reader.db"))?;
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
        let files = files
            .iter()
            .map(|name| verified_manifest_file(&temp_dir, name))
            .collect::<Result<Vec<_>, _>>()?;
        atomic_file::write_json(
            &temp_dir.join("manifest.json"),
            &BackupManifest {
                format: "kunpeng-reader-recovery".to_string(),
                version: 2,
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                created_at: Local::now().to_rfc3339(),
                files,
            },
            true,
        )?;
        std::fs::rename(&temp_dir, &final_dir).map_err(|e| format!("提交恢复点失败：{e}"))?;
        db.set_metadata(BACKUP_METADATA_KEY, &day)?;
        rotate_backups(Some(&final_dir))?;
        manifest_for(&final_dir).map(|_| ())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    result?;
    let mut current = status()?;
    current.created = true;
    Ok(current)
}

fn create_locked(state: &AppState, force: bool) -> Result<BackupStatus, String> {
    let mut data = lock_core_data(state)?;
    create_locked_with_data(&mut data, force)
}

pub(crate) fn create(state: &AppState, force: bool) -> Result<BackupStatus, String> {
    let _operation = BACKUP_LOCK
        .lock()
        .map_err(|_| "恢复点任务锁定失败".to_string())?;
    let _external_dict = crate::external_dict::maintenance_lock();
    create_locked(state, force)
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

struct RestoreFilePlan {
    destination: PathBuf,
    staged: PathBuf,
    previous: PathBuf,
    had_previous: bool,
    expected_bytes: u64,
    expected_sha256: String,
    original_bytes: Option<u64>,
    original_sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RestoreTransactionPhase {
    Installing,
    Validated,
}

#[derive(Serialize, Deserialize)]
struct RestoreTransactionManifest {
    version: u32,
    phase: RestoreTransactionPhase,
    plans: Vec<RestoreTransactionPlanState>,
}

#[derive(Serialize, Deserialize)]
struct RestoreTransactionPlanState {
    destination: PathBuf,
    staged: PathBuf,
    previous: PathBuf,
    had_previous: bool,
    expected_bytes: u64,
    expected_sha256: String,
    original_bytes: Option<u64>,
    original_sha256: Option<String>,
    original_moved: bool,
    new_committed: bool,
}

struct RestoreTransactionLog {
    path: PathBuf,
    manifest: RestoreTransactionManifest,
}

impl RestoreTransactionLog {
    fn begin(plans: &[RestoreFilePlan]) -> Result<Self, String> {
        let directory = restore_plan_directory(plans)?;
        let path = directory.join(RESTORE_TRANSACTION_FILE);
        let transaction = Self {
            path,
            manifest: RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: plans
                    .iter()
                    .map(|plan| RestoreTransactionPlanState {
                        destination: plan.destination.clone(),
                        staged: plan.staged.clone(),
                        previous: plan.previous.clone(),
                        had_previous: plan.had_previous,
                        expected_bytes: plan.expected_bytes,
                        expected_sha256: plan.expected_sha256.clone(),
                        original_bytes: plan.original_bytes,
                        original_sha256: plan.original_sha256.clone(),
                        original_moved: false,
                        new_committed: false,
                    })
                    .collect(),
            },
        };
        transaction.persist_new()?;
        Ok(transaction)
    }

    fn persist_new(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.manifest)
            .map_err(|error| format!("序列化恢复事务日志失败：{error}"))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
            .map_err(|error| {
                format!(
                    "创建恢复事务日志失败（可能已有恢复任务）：{}：{error}",
                    self.path.display()
                )
            })?;
        let result = (|| {
            file.write_all(&bytes)
                .map_err(|error| format!("写入恢复事务日志失败：{error}"))?;
            file.flush()
                .map_err(|error| format!("刷新恢复事务日志失败：{error}"))?;
            file.sync_all()
                .map_err(|error| format!("同步恢复事务日志失败：{error}"))
        })();
        drop(file);
        if result.is_err() {
            let _ = std::fs::remove_file(&self.path);
        }
        result
    }

    fn persist(&self) -> Result<(), String> {
        atomic_file::write_json(&self.path, &self.manifest, false)
            .map_err(|error| format!("保存恢复事务日志失败：{error}"))
    }

    fn mark_original_moved(&mut self, index: usize) -> Result<(), String> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or("恢复事务计划索引无效")?;
        plan.original_moved = true;
        self.persist()
    }

    fn mark_new_committed(&mut self, index: usize) -> Result<(), String> {
        let plan = self
            .manifest
            .plans
            .get_mut(index)
            .ok_or("恢复事务计划索引无效")?;
        plan.new_committed = true;
        self.persist()
    }

    fn refresh_committed_integrity(&mut self) -> Result<(), String> {
        for plan in &mut self.manifest.plans {
            let (bytes, sha256) = file_sha256(&plan.destination)?;
            plan.expected_bytes = bytes;
            plan.expected_sha256 = sha256;
        }
        self.persist()
    }

    fn mark_validated(&mut self) -> Result<(), String> {
        self.manifest.phase = RestoreTransactionPhase::Validated;
        self.persist()
    }

    fn finish(self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "清理恢复事务日志失败 {}：{error}",
                self.path.display()
            )),
        }
    }
}

fn restore_plan_directory(plans: &[RestoreFilePlan]) -> Result<PathBuf, String> {
    let directory = plans
        .first()
        .and_then(|plan| plan.destination.parent())
        .ok_or("恢复事务没有有效目标目录")?
        .to_path_buf();
    if plans.iter().any(|plan| {
        plan.destination.parent() != Some(directory.as_path())
            || plan.staged.parent() != Some(directory.as_path())
            || plan.previous.parent() != Some(directory.as_path())
    }) {
        return Err("恢复事务文件必须位于同一数据目录".into());
    }
    Ok(directory)
}

fn valid_restore_target_name(name: &str) -> bool {
    name == "reader.db" || PORTABLE_FILES.contains(&name) || SQLITE_FILES.contains(&name)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_restore_transaction_plan(
    directory: &Path,
    plan: &RestoreTransactionPlanState,
) -> Result<(), String> {
    if plan.destination.parent() != Some(directory)
        || plan.staged.parent() != Some(directory)
        || plan.previous.parent() != Some(directory)
    {
        return Err("恢复事务包含数据目录之外的路径".into());
    }
    let destination_name = plan
        .destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("恢复事务目标文件名无效")?;
    if !valid_restore_target_name(destination_name) {
        return Err(format!("恢复事务目标不受支持：{destination_name}"));
    }
    if !valid_sha256(&plan.expected_sha256)
        || plan.original_bytes.is_some() != plan.original_sha256.is_some()
        || plan
            .original_sha256
            .as_deref()
            .is_some_and(|hash| !valid_sha256(hash))
        || plan.had_previous != plan.original_sha256.is_some()
    {
        return Err(format!("恢复事务文件校验信息无效：{destination_name}"));
    }
    let staged_name = plan
        .staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let previous_name = plan
        .previous
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !staged_name.starts_with(&format!(".{destination_name}.restore-new-"))
        || !previous_name.starts_with(&format!(".{destination_name}.restore-previous-"))
    {
        return Err("恢复事务暂存文件名与目标不匹配".into());
    }
    Ok(())
}

fn remove_file_if_present(path: &Path, context: &str) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{context} {}：{error}", path.display())),
    }
}

fn try_exists(path: &Path, context: &str) -> Result<bool, String> {
    path.try_exists()
        .map_err(|error| format!("{context} {}：{error}", path.display()))
}

fn file_matches_integrity(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<bool, String> {
    if !try_exists(path, "检查恢复文件是否存在失败")? {
        return Ok(false);
    }
    let (bytes, sha256) = file_sha256(path)?;
    Ok(bytes == expected_bytes && sha256.eq_ignore_ascii_case(expected_sha256))
}

fn copy_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    let mut reader = std::fs::File::open(source)
        .map_err(|error| format!("打开回滚副本失败 {}：{error}", source.display()))?;
    atomic_file::write_with(destination, |writer| {
        std::io::copy(&mut reader, writer)
            .map(|_| ())
            .map_err(|error| format!("复制回滚副本失败：{error}"))
    })
}

fn recover_legacy_restore_artifacts(directory: &Path) -> Result<(), String> {
    let targets = std::iter::once("reader.db")
        .chain(PORTABLE_FILES.iter().copied())
        .chain(SQLITE_FILES.iter().copied())
        .collect::<Vec<_>>();
    let mut artifacts: Vec<(String, &'static str, PathBuf, String)> = Vec::new();
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("扫描旧版恢复事务失败 {}：{error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧版恢复事务目录项失败：{error}"))?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        for target in &targets {
            for (label, kind) in [
                (format!(".{target}.restore-previous-"), "previous"),
                (format!(".{target}.restore-new-"), "staged"),
            ] {
                if let Some(suffix) = file_name.strip_prefix(&label) {
                    if suffix.is_empty() {
                        return Err(format!("旧版恢复事务文件名无效：{file_name}"));
                    }
                    artifacts.push((
                        (*target).to_string(),
                        kind,
                        entry.path(),
                        suffix.to_string(),
                    ));
                }
            }
        }
    }
    if artifacts.is_empty() {
        return Ok(());
    }
    let suffixes = artifacts
        .iter()
        .map(|(_, _, _, suffix)| suffix.as_str())
        .collect::<std::collections::HashSet<_>>();
    if suffixes.len() != 1 {
        return Err("发现多组旧版恢复事务，无法安全自动拼接，已阻止启动".into());
    }

    for target in targets {
        let destination = directory.join(target);
        let previous = artifacts
            .iter()
            .filter(|(name, kind, _, _)| name == target && *kind == "previous")
            .map(|(_, _, path, _)| path)
            .collect::<Vec<_>>();
        let staged = artifacts
            .iter()
            .filter(|(name, kind, _, _)| name == target && *kind == "staged")
            .map(|(_, _, path, _)| path)
            .collect::<Vec<_>>();
        if previous.len() > 1 || staged.len() > 1 {
            return Err(format!("旧版恢复事务文件重复：{}", destination.display()));
        }
        let destination_exists = try_exists(&destination, "检查旧版恢复目标失败")?;
        if let Some(previous) = previous.first() {
            if destination_exists {
                if file_sha256(previous)? != file_sha256(&destination)? {
                    return Err(format!(
                        "旧版恢复的当前文件与回滚副本同时存在且内容不同，已阻止覆盖：{}",
                        destination.display()
                    ));
                }
            } else {
                copy_file_atomically(previous, &destination)?;
            }
        } else if !staged.is_empty() && !destination_exists {
            return Err(format!(
                "恢复目标缺失且只发现未验证的旧版暂存文件，已阻止创建空数据：{}",
                destination.display()
            ));
        }
    }
    for (_, _, path, _) in artifacts {
        remove_file_if_present(&path, "清理旧版恢复事务文件失败")?;
    }
    Ok(())
}

fn cleanup_manifest_artifacts(manifest: &RestoreTransactionManifest) -> Result<(), String> {
    let mut failures = Vec::new();
    for plan in &manifest.plans {
        for path in [&plan.staged, &plan.previous] {
            if let Err(error) = remove_file_if_present(path, "清理恢复事务文件失败") {
                failures.push(error);
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

fn rollback_manifest_plans(manifest: &RestoreTransactionManifest) -> Result<(), String> {
    // Preflight the whole group before changing any live path. Unknown content
    // is never silently deleted or combined with files from another snapshot.
    for plan in &manifest.plans {
        if plan.had_previous {
            let original_bytes = plan.original_bytes.ok_or("恢复事务缺少原文件大小")?;
            let original_sha256 = plan
                .original_sha256
                .as_deref()
                .ok_or("恢复事务缺少原文件校验值")?;
            let previous_exists = try_exists(&plan.previous, "检查恢复回滚副本失败")?;
            let live_exists = try_exists(&plan.destination, "检查恢复目标失败")?;
            let live_is_original =
                file_matches_integrity(&plan.destination, original_bytes, original_sha256)?;
            let live_is_expected = file_matches_integrity(
                &plan.destination,
                plan.expected_bytes,
                &plan.expected_sha256,
            )?;
            if previous_exists
                && !file_matches_integrity(&plan.previous, original_bytes, original_sha256)?
            {
                return Err(format!(
                    "恢复回滚副本校验失败，已保留事务供人工检查：{}",
                    plan.previous.display()
                ));
            }
            if !previous_exists && !live_is_original {
                return Err(format!(
                    "原文件与回滚副本均不可验证，已阻止自动恢复：{}",
                    plan.destination.display()
                ));
            }
            if live_exists && !live_is_original && !live_is_expected {
                return Err(format!(
                    "恢复目标包含事务外的未知内容，已阻止自动覆盖：{}",
                    plan.destination.display()
                ));
            }
        } else if try_exists(&plan.destination, "检查恢复新增目标失败")?
            && !file_matches_integrity(
                &plan.destination,
                plan.expected_bytes,
                &plan.expected_sha256,
            )?
        {
            return Err(format!(
                "无旧文件的恢复目标包含未知内容，已阻止自动删除：{}",
                plan.destination.display()
            ));
        }
    }

    for plan in &manifest.plans {
        let target_name = plan
            .destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if matches!(target_name, "reader.db" | "external-dicts.db") {
            remove_sqlite_sidecars(&plan.destination)?;
        }
    }

    for plan in &manifest.plans {
        if plan.had_previous {
            let original_bytes = plan.original_bytes.ok_or("恢复事务缺少原文件大小")?;
            let original_sha256 = plan
                .original_sha256
                .as_deref()
                .ok_or("恢复事务缺少原文件校验值")?;
            if !file_matches_integrity(&plan.destination, original_bytes, original_sha256)? {
                copy_file_atomically(&plan.previous, &plan.destination)?;
            }
            if !file_matches_integrity(&plan.destination, original_bytes, original_sha256)? {
                return Err(format!(
                    "恢复原文件后校验失败：{}",
                    plan.destination.display()
                ));
            }
        } else if try_exists(&plan.destination, "检查待移除恢复目标失败")? {
            remove_file_if_present(&plan.destination, "移除未完成恢复新增的文件失败")?;
        }
    }
    cleanup_manifest_artifacts(manifest)
}

fn validated_live_files_match(manifest: &RestoreTransactionManifest) -> Result<bool, String> {
    for plan in &manifest.plans {
        if !file_matches_integrity(
            &plan.destination,
            plan.expected_bytes,
            &plan.expected_sha256,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn recover_interrupted_restore_in_dir(directory: &Path) -> Result<(), String> {
    let transaction_path = directory.join(RESTORE_TRANSACTION_FILE);
    if !try_exists(&transaction_path, "检查恢复事务日志失败")? {
        return recover_legacy_restore_artifacts(directory);
    }
    let bytes = std::fs::read(&transaction_path).map_err(|error| {
        format!(
            "读取未完成恢复事务失败 {}：{error}",
            transaction_path.display()
        )
    })?;
    let manifest: RestoreTransactionManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析未完成恢复事务失败：{error}"))?;
    if manifest.version != RESTORE_TRANSACTION_VERSION || manifest.plans.is_empty() {
        return Err(format!(
            "未完成恢复事务版本无效，请保留数据目录并人工检查：{}",
            transaction_path.display()
        ));
    }
    for plan in &manifest.plans {
        validate_restore_transaction_plan(directory, plan)?;
    }

    match manifest.phase {
        RestoreTransactionPhase::Installing => rollback_manifest_plans(&manifest)?,
        RestoreTransactionPhase::Validated => {
            if validated_live_files_match(&manifest)? {
                cleanup_manifest_artifacts(&manifest)?;
            } else {
                rollback_manifest_plans(&manifest)?;
            }
        }
    }
    remove_file_if_present(&transaction_path, "清理恢复事务日志失败")
}

/// Must run before AppDb::open. If the previous process died while replacing
/// reader.db, this replays the durable transaction log before SQLite gets a
/// chance to create a new empty database at the missing live path.
pub(crate) fn recover_interrupted_restore() -> Result<(), String> {
    let _operation = BACKUP_LOCK
        .lock()
        .map_err(|_| "恢复事务锁定失败".to_string())?;
    let directory = config_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    recover_interrupted_restore_in_dir(&directory)
}

fn cleanup_restore_plans(plans: &[RestoreFilePlan]) {
    for plan in plans {
        let _ = std::fs::remove_file(&plan.staged);
    }
}

/// Restore every live target touched by a failed restore attempt.
///
/// `prepared` is the number of plans whose pre-commit check/rename completed;
/// `commit_attempted` includes the commit that returned an error because an OS
/// replacement can fail after it has already made the destination visible.
#[cfg(test)]
fn rollback_restore_plans(
    plans: &[RestoreFilePlan],
    prepared: usize,
    commit_attempted: usize,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        if plan.had_previous && index < prepared {
            if plan.previous.exists() {
                if plan.destination.exists() {
                    if let Err(error) = std::fs::remove_file(&plan.destination) {
                        failures.push(format!(
                            "移除未完成恢复文件失败 {}：{error}",
                            plan.destination.display()
                        ));
                    }
                }
                if !plan.destination.exists() {
                    if let Err(error) = std::fs::rename(&plan.previous, &plan.destination) {
                        failures.push(format!(
                            "恢复原文件失败 {}：{error}",
                            plan.destination.display()
                        ));
                    }
                }
            } else {
                failures.push(format!("原文件回滚副本缺失：{}", plan.previous.display()));
            }
        } else if !plan.had_previous && index < commit_attempted && plan.destination.exists() {
            if let Err(error) = std::fs::remove_file(&plan.destination) {
                failures.push(format!(
                    "移除新增恢复文件失败 {}：{error}",
                    plan.destination.display()
                ));
            }
        }
        if let Err(error) = std::fs::remove_file(&plan.staged) {
            if error.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "清理恢复暂存文件失败 {}：{error}",
                    plan.staged.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

fn stage_restore_file(source: &Path, destination: &Path) -> Result<RestoreFilePlan, String> {
    let source_metadata = std::fs::metadata(source)
        .map_err(|error| format!("读取恢复点文件失败 {}：{error}", source.display()))?;
    if !source_metadata.is_file() {
        return Err(format!("恢复点文件缺失：{}", source.display()));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建恢复目标目录失败 {}：{error}", parent.display()))?;
    }
    let staged = staging_path(destination, "restore-new")?;
    let previous = staging_path(destination, "restore-previous")?;
    if let Err(error) = std::fs::remove_file(&staged) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!(
                "清理旧恢复暂存文件失败 {}：{error}",
                staged.display()
            ));
        }
    }
    if try_exists(&previous, "检查旧恢复回滚副本失败")? {
        if try_exists(destination, "检查恢复目标失败")? {
            return Err(format!(
                "检测到未完成恢复的原文件副本，请保留并检查：{}",
                previous.display()
            ));
        }
        std::fs::rename(&previous, destination).map_err(|error| {
            format!(
                "恢复上次未完成事务的原文件失败 {}：{error}",
                destination.display()
            )
        })?;
    }
    let source_integrity = file_sha256(source)?;
    let stage_result = (|| {
        std::fs::copy(source, &staged)
            .map_err(|error| format!("复制恢复点文件失败 {}：{error}", source.display()))?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("同步恢复暂存文件失败 {}：{error}", staged.display()))?;
        // The manifest verifies the source; this second comparison also catches
        // a short/torn copy before any live file is renamed.
        let staged_integrity = file_sha256(&staged)?;
        if staged_integrity != source_integrity {
            return Err(format!("恢复暂存文件校验失败：{}", staged.display()));
        }
        Ok(())
    })();
    if let Err(error) = stage_result {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    let destination_exists = try_exists(destination, "检查恢复目标失败")?;
    let original_integrity = if destination_exists {
        Some(file_sha256(destination)?)
    } else {
        None
    };
    Ok(RestoreFilePlan {
        destination: destination.to_path_buf(),
        staged,
        previous,
        had_previous: destination_exists,
        expected_bytes: source_integrity.0,
        expected_sha256: source_integrity.1,
        original_bytes: original_integrity.as_ref().map(|integrity| integrity.0),
        original_sha256: original_integrity.map(|integrity| integrity.1),
    })
}

fn stage_restore_files(pairs: &[(PathBuf, PathBuf)]) -> Result<Vec<RestoreFilePlan>, String> {
    let mut plans = Vec::with_capacity(pairs.len());
    for (source, destination) in pairs {
        match stage_restore_file(source, destination) {
            Ok(plan) => plans.push(plan),
            Err(error) => {
                cleanup_restore_plans(&plans);
                return Err(error);
            }
        }
    }
    Ok(plans)
}

/// Publish all staged files but retain every `.restore-previous-*` file until
/// the caller has reopened and validated the restored database.
#[cfg(test)]
fn commit_restore_plans_with<F>(plans: &[RestoreFilePlan], mut commit_file: F) -> Result<(), String>
where
    F: FnMut(usize, &RestoreFilePlan) -> Result<(), String>,
{
    commit_restore_plans_with_log(plans, None, &mut commit_file)
}

#[cfg(test)]
fn commit_restore_plans_with_log<F>(
    plans: &[RestoreFilePlan],
    mut transaction: Option<&mut RestoreTransactionLog>,
    mut commit_file: F,
) -> Result<(), String>
where
    F: FnMut(usize, &RestoreFilePlan) -> Result<(), String>,
{
    for (index, plan) in plans.iter().enumerate() {
        if plan.had_previous {
            if let Err(error) = std::fs::rename(&plan.destination, &plan.previous) {
                let primary = format!("暂存当前文件失败 {}：{error}", plan.destination.display());
                return match rollback_restore_plans(plans, index, 0) {
                    Ok(()) => Err(primary),
                    Err(rollback) => Err(format!("{primary}；回滚也失败：{rollback}")),
                };
            }
            if let Some(log) = transaction.as_deref_mut() {
                if let Err(error) = log.mark_original_moved(index) {
                    let primary = format!(
                        "记录原文件暂存状态失败 {}：{error}",
                        plan.destination.display()
                    );
                    return match rollback_restore_plans(plans, index + 1, 0) {
                        Ok(()) => Err(primary),
                        Err(rollback) => Err(format!("{primary}；回滚也失败：{rollback}")),
                    };
                }
            }
        } else if plan.destination.exists() {
            // The target did not exist while staging but another writer created
            // it before commit. Never overwrite or later delete that new file.
            let primary = format!(
                "恢复目标在提交前被其他任务创建：{}",
                plan.destination.display()
            );
            return match rollback_restore_plans(plans, index, 0) {
                Ok(()) => Err(primary),
                Err(rollback) => Err(format!("{primary}；回滚也失败：{rollback}")),
            };
        }
    }
    for (index, plan) in plans.iter().enumerate() {
        if let Err(error) = commit_file(index, plan) {
            let primary = format!("提交恢复文件失败 {}：{error}", plan.destination.display());
            return match rollback_restore_plans(plans, plans.len(), index + 1) {
                Ok(()) => Err(primary),
                Err(rollback) => Err(format!("{primary}；回滚也失败：{rollback}")),
            };
        }
        if let Some(log) = transaction.as_deref_mut() {
            if let Err(error) = log.mark_new_committed(index) {
                let primary = format!(
                    "记录恢复文件提交状态失败 {}：{error}",
                    plan.destination.display()
                );
                return match rollback_restore_plans(plans, plans.len(), index + 1) {
                    Ok(()) => Err(primary),
                    Err(rollback) => Err(format!("{primary}；回滚也失败：{rollback}")),
                };
            }
        }
    }
    Ok(())
}

fn rollback_durable_restore(
    _plans: &[RestoreFilePlan],
    _prepared: usize,
    _commit_attempted: usize,
    transaction: RestoreTransactionLog,
    primary: String,
) -> Result<(), String> {
    match rollback_manifest_plans(&transaction.manifest) {
        Ok(()) => match transaction.finish() {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(format!("{primary}；清理事务日志失败：{cleanup}")),
        },
        Err(rollback) => {
            // Keep the durable manifest and any remaining previous copies. The
            // next process will retry recovery before AppDb::open.
            Err(format!("{primary}；回滚也失败：{rollback}"))
        }
    }
}

fn commit_restore_plans_durable_with<F>(
    plans: &[RestoreFilePlan],
    transaction: &mut Option<RestoreTransactionLog>,
    mut commit_file: F,
) -> Result<(), String>
where
    F: FnMut(usize, &RestoreFilePlan) -> Result<(), String>,
{
    for (index, plan) in plans.iter().enumerate() {
        if plan.had_previous {
            if let Err(error) = std::fs::rename(&plan.destination, &plan.previous) {
                let primary = format!("暂存当前文件失败 {}：{error}", plan.destination.display());
                let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
                return rollback_durable_restore(plans, index, 0, transaction, primary);
            }
            if let Some(log) = transaction.as_mut() {
                if let Err(error) = log.mark_original_moved(index) {
                    let primary = format!(
                        "记录原文件暂存状态失败 {}：{error}",
                        plan.destination.display()
                    );
                    let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
                    return rollback_durable_restore(plans, index + 1, 0, transaction, primary);
                }
            }
        } else if plan.destination.exists() {
            let primary = format!(
                "恢复目标在提交前被其他任务创建：{}",
                plan.destination.display()
            );
            let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
            return rollback_durable_restore(plans, index, 0, transaction, primary);
        }
    }
    for (index, plan) in plans.iter().enumerate() {
        if let Err(error) = commit_file(index, plan) {
            let primary = format!("提交恢复文件失败 {}：{error}", plan.destination.display());
            let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
            return rollback_durable_restore(plans, plans.len(), index + 1, transaction, primary);
        }
        if let Some(log) = transaction.as_mut() {
            if let Err(error) = log.mark_new_committed(index) {
                let primary = format!(
                    "记录恢复文件提交状态失败 {}：{error}",
                    plan.destination.display()
                );
                let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
                return rollback_durable_restore(
                    plans,
                    plans.len(),
                    index + 1,
                    transaction,
                    primary,
                );
            }
        }
    }
    Ok(())
}

fn restore_plans_still_match_original(plans: &[RestoreFilePlan]) -> Result<(), String> {
    for plan in plans {
        if plan.had_previous {
            let original_bytes = plan.original_bytes.ok_or("恢复计划缺少原文件大小")?;
            let original_sha256 = plan
                .original_sha256
                .as_deref()
                .ok_or("恢复计划缺少原文件校验值")?;
            if !file_matches_integrity(&plan.destination, original_bytes, original_sha256)? {
                return Err(format!(
                    "恢复目标在提交前已被其他任务修改：{}",
                    plan.destination.display()
                ));
            }
        } else if try_exists(&plan.destination, "检查恢复目标失败")? {
            return Err(format!(
                "恢复目标在提交前被其他任务创建：{}",
                plan.destination.display()
            ));
        }
    }
    Ok(())
}

fn finalize_restore_plans(plans: &[RestoreFilePlan]) -> Result<(), String> {
    let mut failures = Vec::new();
    for plan in plans {
        for path in [&plan.staged, &plan.previous] {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("清理恢复事务文件失败 {}：{error}", path.display()));
                }
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

#[cfg(test)]
fn replace_files_transactionally_with_commit<F>(
    pairs: &[(PathBuf, PathBuf)],
    commit_file: F,
) -> Result<(), String>
where
    F: FnMut(usize, &RestoreFilePlan) -> Result<(), String>,
{
    let plans = stage_restore_files(pairs)?;
    commit_restore_plans_with(&plans, commit_file)?;
    finalize_restore_plans(&plans)
}

#[cfg(test)]
fn replace_files_transactionally(pairs: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    replace_files_transactionally_with_commit(pairs, |_index, plan| {
        atomic_file::commit_temp_file(&plan.staged, &plan.destination)
    })
}

fn remove_sqlite_sidecars(path: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if let Err(error) = std::fs::remove_file(&sidecar) {
            if error.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!(
                    "删除 SQLite 辅助文件失败 {}：{error}",
                    sidecar.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

fn install_restore_plans_with_validation<C, V>(
    plans: &[RestoreFilePlan],
    sqlite_paths: &[PathBuf],
    commit_file: C,
    validate: V,
) -> Result<(), String>
where
    C: FnMut(usize, &RestoreFilePlan) -> Result<(), String>,
    V: FnOnce() -> Result<(), String>,
{
    let mut transaction = match RestoreTransactionLog::begin(plans) {
        Ok(transaction) => Some(transaction),
        Err(error) => {
            cleanup_restore_plans(plans);
            return Err(error);
        }
    };
    if let Err(error) = restore_plans_still_match_original(plans) {
        cleanup_restore_plans(plans);
        let cleanup = transaction.take().ok_or("恢复事务日志缺失")?.finish();
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}；{cleanup}")),
        };
    }
    for path in sqlite_paths {
        if let Err(error) = remove_sqlite_sidecars(path) {
            cleanup_restore_plans(plans);
            let cleanup = transaction.take().ok_or("恢复事务日志缺失")?.finish();
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}；{cleanup}")),
            };
        }
    }
    commit_restore_plans_durable_with(plans, &mut transaction, commit_file)?;
    match validate() {
        Ok(()) => {
            if let Some(log) = transaction.as_mut() {
                if let Err(error) = log.refresh_committed_integrity() {
                    let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
                    let error = rollback_durable_restore(
                        plans,
                        plans.len(),
                        plans.len(),
                        transaction,
                        format!("记录恢复文件最终校验值失败：{error}"),
                    )
                    .expect_err("durable rollback always returns the primary error");
                    return Err(error);
                }
                if let Err(error) = log.mark_validated() {
                    let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
                    let error = rollback_durable_restore(
                        plans,
                        plans.len(),
                        plans.len(),
                        transaction,
                        format!("记录恢复验证成功状态失败：{error}"),
                    )
                    .expect_err("durable rollback always returns the primary error");
                    return Err(error);
                }
            }
            // The restored database is usable now. Cleanup failure is reported
            // diagnostically but must not turn a successful restore into an
            // apparent failure after the live state has already changed. A
            // validated manifest remains so the next process can retry cleanup.
            match finalize_restore_plans(plans) {
                Ok(()) => {
                    if let Some(log) = transaction.take() {
                        if let Err(error) = log.finish() {
                            eprintln!(
                                "[backup] restored successfully but transaction cleanup failed: {error}"
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("[backup] restored successfully but cleanup failed: {error}");
                }
            }
            Ok(())
        }
        Err(validation_error) => {
            let mut recovery_errors = Vec::new();
            for path in sqlite_paths {
                if let Err(error) = remove_sqlite_sidecars(path) {
                    recovery_errors.push(error);
                }
            }
            let primary = if recovery_errors.is_empty() {
                format!("恢复后的数据库无法打开，已还原恢复前文件：{validation_error}")
            } else {
                format!(
                    "恢复后的数据库无法打开：{validation_error}；辅助文件清理失败：{}",
                    recovery_errors.join("；")
                )
            };
            let transaction = transaction.take().ok_or("恢复事务日志缺失")?;
            let error =
                rollback_durable_restore(plans, plans.len(), plans.len(), transaction, primary)
                    .expect_err("durable rollback always returns the primary error");
            Err(error)
        }
    }
}

/// Restore a recovery point after first capturing the current state. The
/// database connection is deliberately reopened before returning so the UI can
/// immediately reload the recovered shelf without asking users to restart.
pub(crate) fn restore(state: &AppState, id: &str) -> Result<BackupStatus, String> {
    // Hold the backup lock across validation, staging, the recovery-before-
    // restore snapshot and commit. This prevents another daily/manual backup
    // from rotating the selected directory between those phases.
    let _operation = BACKUP_LOCK
        .lock()
        .map_err(|_| "恢复点任务锁定失败".to_string())?;
    let _external_dict = crate::external_dict::maintenance_lock();
    let config = config_dir()?;
    std::fs::create_dir_all(&config).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    recover_interrupted_restore_in_dir(&config)?;
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

    let database_path = db::database_path()?;
    let mut replacements = vec![(snapshot_db.clone(), database_path.clone())];
    for name in PORTABLE_FILES.iter().chain(SQLITE_FILES.iter()) {
        if manifest_contains(&manifest, name) {
            replacements.push((recovery.join(name), config.join(name)));
        }
    }
    // Copy the selected recovery point out of its rotating directory before
    // creating the mandatory recovery-before-restore snapshot. When seven
    // backups already exist, rotation is allowed to remove the selected oldest
    // directory; these same-directory staged copies remain valid.
    let plans = stage_restore_files(&replacements)?;

    let mut data = lock_core_data(state)?;
    // Never overwrite the current state without a fresh, independently
    // verified recovery point that the user can return to. Keep all core
    // state locks from this snapshot through runtime reload.
    if let Err(error) = create_locked_with_data(&mut data, true) {
        cleanup_restore_plans(&plans);
        return Err(error);
    }
    // AppDb owns the application's only reader.db connection. Dropping it while
    // retaining the mutex checkpoints WAL and prevents any command from opening
    // a second connection during installation.
    *data.db = None;
    let mut sqlite_paths = vec![database_path.clone()];
    if manifest_contains(&manifest, "external-dicts.db") {
        sqlite_paths.push(config.join("external-dicts.db"));
    }

    let installed = install_restore_plans_with_validation(
        &plans,
        &sqlite_paths,
        |_index, plan| atomic_file::commit_temp_file(&plan.staged, &plan.destination),
        || {
            let database = db::AppDb::open_existing()?;
            drop(database);
            Ok(())
        },
    );
    let restored_db = match installed {
        Ok(()) => db::AppDb::open_existing()
            .map_err(|error| format!("恢复已验证但重新打开数据库失败：{error}"))?,
        Err(primary) => {
            // A durable manifest means recovery is still pending. Never call a
            // SQLite open mode that can CREATE in this state.
            if try_exists(
                &config.join(RESTORE_TRANSACTION_FILE),
                "检查失败恢复事务状态失败",
            )? {
                return Err(format!("{primary}；恢复事务仍待自救，数据库保持关闭"));
            }
            let reopen = db::AppDb::open_existing();
            return match reopen {
                Ok(database) => {
                    *data.db = Some(database);
                    Err(primary)
                }
                Err(reopen_error) => Err(format!(
                    "{primary}；恢复前数据库也无法重新打开：{reopen_error}"
                )),
            };
        }
    };
    *data.db = Some(restored_db);
    *data.library = crate::book::Library::load();
    *data.stats = StatsStore::load();
    *data.vocab = VocabStore::load();
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

    fn temp_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kunpeng-backup-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn assert_no_restore_artifacts(directory: &Path) {
        let artifacts = std::fs::read_dir(directory)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                name.contains(".restore-new-")
                    || name.contains(".restore-previous-")
                    || name == RESTORE_TRANSACTION_FILE
            })
            .collect::<Vec<_>>();
        assert!(
            artifacts.is_empty(),
            "restore artifacts remain: {artifacts:?}"
        );
    }

    fn test_integrity(bytes: &[u8]) -> (u64, String) {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let sha256 = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        (bytes.len() as u64, sha256)
    }

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

    #[test]
    fn verified_manifest_rejects_a_same_size_bit_flip() {
        let dir = temp_test_dir("manifest");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("reader.db"), b"valid-database").unwrap();
        let manifest = BackupManifest {
            format: "kunpeng-reader-recovery".into(),
            version: 2,
            app_version: "test".into(),
            created_at: "now".into(),
            files: vec![verified_manifest_file(&dir, "reader.db").unwrap()],
        };
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(manifest_for(&dir).is_ok());
        std::fs::write(dir.join("reader.db"), b"valid-databasf").unwrap();
        assert!(manifest_for(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn multi_file_restore_replaces_every_file_together() {
        let dir = temp_test_dir("replace");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("reader.db"), b"new-db").unwrap();
        std::fs::write(source.join("library.json"), b"new-json").unwrap();
        std::fs::write(destination.join("reader.db"), b"old-db").unwrap();
        std::fs::write(destination.join("library.json"), b"old-json").unwrap();

        replace_files_transactionally(&[
            (source.join("reader.db"), destination.join("reader.db")),
            (
                source.join("library.json"),
                destination.join("library.json"),
            ),
        ])
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join("reader.db")).unwrap(),
            b"new-db"
        );
        assert_eq!(
            std::fs::read(destination.join("library.json")).unwrap(),
            b"new-json"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn staged_oldest_recovery_survives_rotation_of_seven_existing_backups() {
        let dir = temp_test_dir("rotate-selected");
        let backup_root = dir.join("backups");
        let destination = dir.join("live");
        std::fs::create_dir_all(&backup_root).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let mut backups = Vec::new();
        for index in 0..MAX_RECOVERY_BACKUPS {
            let backup = backup_root.join(format!("20260701-00000{index}-000"));
            std::fs::create_dir_all(&backup).unwrap();
            std::fs::write(backup.join("reader.db"), format!("snapshot-{index}")).unwrap();
            backups.push(backup);
        }
        let selected = backups[0].clone();
        let live_database = destination.join("reader.db");
        std::fs::write(&live_database, b"current").unwrap();
        let plans =
            stage_restore_files(&[(selected.join("reader.db"), live_database.clone())]).unwrap();

        let newest = backup_root.join("20260701-000007-000");
        std::fs::create_dir_all(&newest).unwrap();
        std::fs::write(newest.join("reader.db"), b"current-snapshot").unwrap();
        backups.push(newest);
        rotate_backup_paths(backups, None).unwrap();
        assert!(
            !selected.exists(),
            "the selected oldest directory should rotate"
        );

        commit_restore_plans_with(&plans, |_index, plan| {
            atomic_file::commit_temp_file(&plan.staged, &plan.destination)
        })
        .unwrap();
        finalize_restore_plans(&plans).unwrap();
        assert_eq!(std::fs::read(&live_database).unwrap(), b"snapshot-0");
        assert_no_restore_artifacts(&destination);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rotation_never_deletes_the_fresh_protected_snapshot() {
        let dir = temp_test_dir("rotate-protected");
        std::fs::create_dir_all(&dir).unwrap();
        let mut backups = Vec::new();
        for index in 0..=MAX_RECOVERY_BACKUPS {
            let path = dir.join(format!("backup-{index:02}"));
            std::fs::create_dir_all(&path).unwrap();
            backups.push(path);
        }
        let protected = backups[0].clone();

        rotate_backup_paths(backups, Some(&protected)).unwrap();

        assert!(protected.exists());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            MAX_RECOVERY_BACKUPS
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn database_reopen_failure_rolls_back_all_files_and_new_sidecars() {
        let dir = temp_test_dir("reopen-rollback");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let database = destination.join("reader.db");
        let library = destination.join("library.json");
        std::fs::write(source.join("reader.db"), b"new-db").unwrap();
        std::fs::write(source.join("library.json"), b"new-json").unwrap();
        std::fs::write(&database, b"old-db").unwrap();
        std::fs::write(&library, b"old-json").unwrap();
        let plans = stage_restore_files(&[
            (source.join("reader.db"), database.clone()),
            (source.join("library.json"), library.clone()),
        ])
        .unwrap();
        let mut wal = database.as_os_str().to_os_string();
        wal.push("-wal");
        let wal = PathBuf::from(wal);

        let result = install_restore_plans_with_validation(
            &plans,
            std::slice::from_ref(&database),
            |_index, plan| atomic_file::commit_temp_file(&plan.staged, &plan.destination),
            || {
                assert_eq!(std::fs::read(&database).unwrap(), b"new-db");
                assert_eq!(std::fs::read(&library).unwrap(), b"new-json");
                assert!(plans.iter().all(|plan| plan.previous.exists()));
                std::fs::write(&wal, b"new-database-wal").unwrap();
                Err::<(), _>("injected AppDb::open failure".to_string())
            },
        );

        assert!(result.unwrap_err().contains("已还原恢复前文件"));
        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert_eq!(std::fs::read(&library).unwrap(), b"old-json");
        assert!(!wal.exists());
        assert_no_restore_artifacts(&destination);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sidecar_delete_failure_aborts_before_any_live_file_is_replaced() {
        let dir = temp_test_dir("sidecar-failure");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let database = destination.join("reader.db");
        std::fs::write(source.join("reader.db"), b"new-db").unwrap();
        std::fs::write(&database, b"old-db").unwrap();
        let plans = stage_restore_files(&[(source.join("reader.db"), database.clone())]).unwrap();
        let mut wal = database.as_os_str().to_os_string();
        wal.push("-wal");
        let wal = PathBuf::from(wal);
        std::fs::create_dir(&wal).unwrap();
        let mut commit_called = false;

        let result = install_restore_plans_with_validation(
            &plans,
            std::slice::from_ref(&database),
            |_index, _plan| {
                commit_called = true;
                Ok(())
            },
            || Ok(()),
        );

        assert!(result.unwrap_err().contains("删除 SQLite 辅助文件失败"));
        assert!(!commit_called);
        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert_no_restore_artifacts(&destination);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn second_commit_failure_restores_all_existing_targets_and_cleans_artifacts() {
        let dir = temp_test_dir("rollback-existing");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let first = destination.join("reader.db");
        let second = destination.join("library.json");
        std::fs::write(source.join("reader.db"), b"new-db").unwrap();
        std::fs::write(source.join("library.json"), b"new-json").unwrap();
        std::fs::write(&first, b"old-db").unwrap();
        std::fs::write(&second, b"old-json").unwrap();

        let mut saw_first_commit = false;
        let result = replace_files_transactionally_with_commit(
            &[
                (source.join("reader.db"), first.clone()),
                (source.join("library.json"), second.clone()),
            ],
            |index, plan| {
                if index == 1 {
                    assert_eq!(std::fs::read(&first).unwrap(), b"new-db");
                    saw_first_commit = true;
                    return Err("injected second commit failure".into());
                }
                atomic_file::commit_temp_file(&plan.staged, &plan.destination)
            },
        );

        assert!(result.is_err());
        assert!(saw_first_commit);
        assert_eq!(std::fs::read(&first).unwrap(), b"old-db");
        assert_eq!(std::fs::read(&second).unwrap(), b"old-json");
        assert_no_restore_artifacts(&destination);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rollback_removes_a_committed_target_that_did_not_exist_before() {
        let dir = temp_test_dir("rollback-new-target");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let new_target = destination.join("library.json");
        let existing_target = destination.join("stats.json");
        std::fs::write(source.join("library.json"), b"new-library").unwrap();
        std::fs::write(source.join("stats.json"), b"new-stats").unwrap();
        std::fs::write(&existing_target, b"old-stats").unwrap();

        let result = replace_files_transactionally_with_commit(
            &[
                (source.join("library.json"), new_target.clone()),
                (source.join("stats.json"), existing_target.clone()),
            ],
            |index, plan| {
                if index == 1 {
                    assert_eq!(std::fs::read(&new_target).unwrap(), b"new-library");
                    return Err("injected second commit failure".into());
                }
                atomic_file::commit_temp_file(&plan.staged, &plan.destination)
            },
        );

        assert!(result.is_err());
        assert!(!new_target.exists());
        assert_eq!(std::fs::read(&existing_target).unwrap(), b"old-stats");
        assert_no_restore_artifacts(&destination);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_previous_copy_is_not_deleted_when_the_live_target_still_exists() {
        let dir = temp_test_dir("stale-previous");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let source_file = source.join("reader.db");
        let destination_file = destination.join("reader.db");
        let previous = staging_path(&destination_file, "restore-previous").unwrap();
        let staged = staging_path(&destination_file, "restore-new").unwrap();
        std::fs::write(&source_file, b"snapshot").unwrap();
        std::fs::write(&destination_file, b"current-live-data").unwrap();
        std::fs::write(&previous, b"recoverable-old-data").unwrap();

        let result = stage_restore_file(&source_file, &destination_file);

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(&destination_file).unwrap(),
            b"current-live-data"
        );
        assert_eq!(std::fs::read(&previous).unwrap(), b"recoverable-old-data");
        assert!(!staged.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn next_process_rolls_back_partial_multi_file_restore_from_foreign_pid_manifest() {
        let dir = temp_test_dir("crash-foreign-pid");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        let library = dir.join("library.json");
        let database_previous = dir.join(".reader.db.restore-previous-424242");
        let database_staged = dir.join(".reader.db.restore-new-424242");
        let library_previous = dir.join(".library.json.restore-previous-424242");
        let library_staged = dir.join(".library.json.restore-new-424242");

        // Simulate a crash after reader.db was committed but before
        // library.json was committed. The artifact PID intentionally differs
        // from the current process.
        std::fs::write(&database, b"new-db").unwrap();
        std::fs::write(&database_previous, b"old-db").unwrap();
        std::fs::write(&library_previous, b"old-library").unwrap();
        std::fs::write(&library_staged, b"new-library").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![
                    RestoreTransactionPlanState {
                        destination: database.clone(),
                        staged: database_staged,
                        previous: database_previous,
                        had_previous: true,
                        expected_bytes: test_integrity(b"new-db").0,
                        expected_sha256: test_integrity(b"new-db").1,
                        original_bytes: Some(test_integrity(b"old-db").0),
                        original_sha256: Some(test_integrity(b"old-db").1),
                        original_moved: true,
                        new_committed: true,
                    },
                    RestoreTransactionPlanState {
                        destination: library.clone(),
                        staged: library_staged,
                        previous: library_previous,
                        had_previous: true,
                        expected_bytes: test_integrity(b"new-library").0,
                        expected_sha256: test_integrity(b"new-library").1,
                        original_bytes: Some(test_integrity(b"old-library").0),
                        original_sha256: Some(test_integrity(b"old-library").1),
                        original_moved: true,
                        new_committed: false,
                    },
                ],
            },
            false,
        )
        .unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert_eq!(std::fs::read(&library).unwrap(), b"old-library");
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn next_process_finishes_cleanup_after_validated_restore() {
        let dir = temp_test_dir("crash-after-validation");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        let previous = dir.join(".reader.db.restore-previous-777777");
        let staged = dir.join(".reader.db.restore-new-777777");
        std::fs::write(&database, b"validated-new-db").unwrap();
        std::fs::write(&previous, b"old-db").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Validated,
                plans: vec![RestoreTransactionPlanState {
                    destination: database.clone(),
                    staged,
                    previous,
                    had_previous: true,
                    expected_bytes: test_integrity(b"validated-new-db").0,
                    expected_sha256: test_integrity(b"validated-new-db").1,
                    original_bytes: Some(test_integrity(b"old-db").0),
                    original_sha256: Some(test_integrity(b"old-db").1),
                    original_moved: true,
                    new_committed: true,
                }],
            },
            false,
        )
        .unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert_eq!(std::fs::read(&database).unwrap(), b"validated-new-db");
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validated_manifest_rolls_back_when_live_database_disappeared() {
        let dir = temp_test_dir("validated-live-missing");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        let previous = dir.join(".reader.db.restore-previous-717171");
        let staged = dir.join(".reader.db.restore-new-717171");
        std::fs::write(&previous, b"old-db").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Validated,
                plans: vec![RestoreTransactionPlanState {
                    destination: database.clone(),
                    staged,
                    previous,
                    had_previous: true,
                    expected_bytes: test_integrity(b"new-db").0,
                    expected_sha256: test_integrity(b"new-db").1,
                    original_bytes: Some(test_integrity(b"old-db").0),
                    original_sha256: Some(test_integrity(b"old-db").1),
                    original_moved: true,
                    new_committed: true,
                }],
            },
            false,
        )
        .unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn installing_recovery_is_idempotent_after_previous_copy_was_cleaned() {
        let dir = temp_test_dir("rollback-idempotent");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        std::fs::write(&database, b"old-db").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![RestoreTransactionPlanState {
                    destination: database.clone(),
                    staged: dir.join(".reader.db.restore-new-727272"),
                    previous: dir.join(".reader.db.restore-previous-727272"),
                    had_previous: true,
                    expected_bytes: test_integrity(b"new-db").0,
                    expected_sha256: test_integrity(b"new-db").1,
                    original_bytes: Some(test_integrity(b"old-db").0),
                    original_sha256: Some(test_integrity(b"old-db").1),
                    original_moved: true,
                    new_committed: true,
                }],
            },
            false,
        )
        .unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commit_before_log_for_new_target_is_detected_by_hash_and_removed() {
        let dir = temp_test_dir("new-target-commit-before-log");
        std::fs::create_dir_all(&dir).unwrap();
        let dictionary = dir.join("external-dicts.db");
        std::fs::write(&dictionary, b"new-dictionary").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![RestoreTransactionPlanState {
                    destination: dictionary.clone(),
                    staged: dir.join(".external-dicts.db.restore-new-737373"),
                    previous: dir.join(".external-dicts.db.restore-previous-737373"),
                    had_previous: false,
                    expected_bytes: test_integrity(b"new-dictionary").0,
                    expected_sha256: test_integrity(b"new-dictionary").1,
                    original_bytes: None,
                    original_sha256: None,
                    original_moved: false,
                    new_committed: false,
                }],
            },
            false,
        )
        .unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert!(!dictionary.exists());
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_new_target_content_is_never_deleted_automatically() {
        let dir = temp_test_dir("new-target-unknown-content");
        std::fs::create_dir_all(&dir).unwrap();
        let dictionary = dir.join("external-dicts.db");
        std::fs::write(&dictionary, b"unrelated-user-data").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![RestoreTransactionPlanState {
                    destination: dictionary.clone(),
                    staged: dir.join(".external-dicts.db.restore-new-747474"),
                    previous: dir.join(".external-dicts.db.restore-previous-747474"),
                    had_previous: false,
                    expected_bytes: test_integrity(b"restored-dictionary").0,
                    expected_sha256: test_integrity(b"restored-dictionary").1,
                    original_bytes: None,
                    original_sha256: None,
                    original_moved: false,
                    new_committed: false,
                }],
            },
            false,
        )
        .unwrap();

        let error = recover_interrupted_restore_in_dir(&dir).unwrap_err();

        assert!(error.contains("未知内容"));
        assert_eq!(std::fs::read(&dictionary).unwrap(), b"unrelated-user-data");
        assert!(dir.join(RESTORE_TRANSACTION_FILE).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_existing_target_and_sidecars_are_preserved_for_manual_recovery() {
        let dir = temp_test_dir("existing-target-unknown-content");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        let previous = dir.join(".reader.db.restore-previous-757575");
        let staged = dir.join(".reader.db.restore-new-757575");
        let wal = dir.join("reader.db-wal");
        let shm = dir.join("reader.db-shm");
        std::fs::write(&database, b"unrelated-user-data").unwrap();
        std::fs::write(&previous, b"old-db").unwrap();
        std::fs::write(&wal, b"unknown-wal").unwrap();
        std::fs::write(&shm, b"unknown-shm").unwrap();
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![RestoreTransactionPlanState {
                    destination: database.clone(),
                    staged,
                    previous: previous.clone(),
                    had_previous: true,
                    expected_bytes: test_integrity(b"restored-db").0,
                    expected_sha256: test_integrity(b"restored-db").1,
                    original_bytes: Some(test_integrity(b"old-db").0),
                    original_sha256: Some(test_integrity(b"old-db").1),
                    original_moved: true,
                    new_committed: true,
                }],
            },
            false,
        )
        .unwrap();

        let error = recover_interrupted_restore_in_dir(&dir).unwrap_err();

        assert!(error.contains("事务外的未知内容"));
        assert_eq!(std::fs::read(&database).unwrap(), b"unrelated-user-data");
        assert_eq!(std::fs::read(&previous).unwrap(), b"old-db");
        assert_eq!(std::fs::read(&wal).unwrap(), b"unknown-wal");
        assert_eq!(std::fs::read(&shm).unwrap(), b"unknown-shm");
        assert!(dir.join(RESTORE_TRANSACTION_FILE).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unrecoverable_missing_database_keeps_manifest_and_refuses_empty_recreation() {
        let dir = temp_test_dir("crash-missing-both");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        atomic_file::write_json(
            &dir.join(RESTORE_TRANSACTION_FILE),
            &RestoreTransactionManifest {
                version: RESTORE_TRANSACTION_VERSION,
                phase: RestoreTransactionPhase::Installing,
                plans: vec![RestoreTransactionPlanState {
                    destination: database,
                    staged: dir.join(".reader.db.restore-new-888888"),
                    previous: dir.join(".reader.db.restore-previous-888888"),
                    had_previous: true,
                    expected_bytes: test_integrity(b"new-db").0,
                    expected_sha256: test_integrity(b"new-db").1,
                    original_bytes: Some(test_integrity(b"old-db").0),
                    original_sha256: Some(test_integrity(b"old-db").1),
                    original_moved: true,
                    new_committed: false,
                }],
            },
            false,
        )
        .unwrap();

        let error = recover_interrupted_restore_in_dir(&dir).unwrap_err();

        assert!(error.contains("原文件与回滚副本均不可验证"));
        assert!(dir.join(RESTORE_TRANSACTION_FILE).exists());
        assert!(!dir.join("reader.db").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn next_process_recovers_legacy_foreign_pid_artifacts_without_manifest() {
        let dir = temp_test_dir("legacy-foreign-pid");
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("reader.db");
        let previous = dir.join(".reader.db.restore-previous-999999");
        let staged = dir.join(".reader.db.restore-new-999999");
        std::fs::write(&previous, b"old-db").unwrap();
        std::fs::write(&staged, b"unvalidated-new-db").unwrap();

        recover_interrupted_restore_in_dir(&dir).unwrap();

        assert_eq!(std::fs::read(&database).unwrap(), b"old-db");
        assert!(!previous.exists());
        assert!(!staged.exists());
        assert_no_restore_artifacts(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_artifacts_from_different_transactions_are_not_mixed() {
        let dir = temp_test_dir("legacy-mixed-pids");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".reader.db.restore-previous-111111"), b"old-db").unwrap();
        std::fs::write(
            dir.join(".library.json.restore-previous-222222"),
            b"old-library",
        )
        .unwrap();

        let error = recover_interrupted_restore_in_dir(&dir).unwrap_err();

        assert!(error.contains("多组旧版恢复事务"));
        assert!(!dir.join("reader.db").exists());
        assert!(!dir.join("library.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_restore_source_does_not_modify_existing_files() {
        let dir = temp_test_dir("missing");
        let source = dir.join("source");
        let destination = dir.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("reader.db"), b"new-db").unwrap();
        std::fs::write(destination.join("reader.db"), b"old-db").unwrap();
        std::fs::write(destination.join("library.json"), b"old-json").unwrap();

        assert!(replace_files_transactionally(&[
            (source.join("reader.db"), destination.join("reader.db")),
            (
                source.join("missing.json"),
                destination.join("library.json"),
            ),
        ])
        .is_err());
        assert_eq!(
            std::fs::read(destination.join("reader.db")).unwrap(),
            b"old-db"
        );
        assert_eq!(
            std::fs::read(destination.join("library.json")).unwrap(),
            b"old-json"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
