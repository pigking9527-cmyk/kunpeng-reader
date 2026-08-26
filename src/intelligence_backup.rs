//! Safe, local-only snapshots of the permanent intelligence archive.
//!
//! A backup always creates a new, immutable directory below an explicitly
//! supplied existing destination. It never overwrites or rotates anything in
//! either the source archive or destination. The SQLite catalog is copied via
//! `VACUUM INTO`, while every ordinary archive file is hashed before and after
//! copying. A final source recheck rejects a backup if the archive changed
//! during the operation, rather than publishing a mixed snapshot.

use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const ARCHIVE_DIRECTORY: &str = "intelligence-hub";
const CATALOG_FILE: &str = "catalog.sqlite3";
const MANIFEST_FILE: &str = "archive-backup-manifest.json";
const FORMAT: &str = "kunpeng-intelligence-archive-backup";
const VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceArchiveBackupReport {
    /// A child directory name below the explicit backup destination. It is a
    /// name rather than an absolute local path so commands never expose local
    /// archive layout to the UI.
    pub snapshot_id: String,
    pub files: u64,
    pub bytes: u64,
    pub catalog_sha256: String,
    pub manifest_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBackupManifest {
    format: &'static str,
    version: u32,
    created_at: String,
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[tauri::command]
pub(crate) fn intelligence_archive_backup(
    target_directory: String,
) -> Result<IntelligenceArchiveBackupReport, String> {
    let source = crate::profile::app_data_dir()
        .ok_or("无法定位本机情报档案目录")?
        .join(ARCHIVE_DIRECTORY);
    backup_archive_to(&source, Path::new(&target_directory))
}

fn backup_archive_to(
    source_directory: &Path,
    target_directory: &Path,
) -> Result<IntelligenceArchiveBackupReport, String> {
    let source_directory = canonical_archive_source(source_directory)?;
    let target_directory = validated_target_directory(target_directory, &source_directory)?;
    backup_archive_from_to(&source_directory, &target_directory)
}

fn canonical_archive_source(source_directory: &Path) -> Result<PathBuf, String> {
    if !source_directory.is_dir() {
        return Err("本机情报永久档案尚未创建，无法备份".into());
    }
    let source = source_directory
        .canonicalize()
        .map_err(|_| "无法解析本机情报档案目录".to_string())?;
    if !source.join(CATALOG_FILE).is_file() {
        return Err("本机情报档案缺少目录数据库，无法备份".into());
    }
    Ok(source)
}

fn validated_target_directory(
    target_directory: &Path,
    source_directory: &Path,
) -> Result<PathBuf, String> {
    if !target_directory.is_absolute() {
        return Err("情报档案备份目标必须是明确的绝对目录或 NAS 路径".into());
    }
    if !target_directory.is_dir() {
        return Err("情报档案备份目标必须是已存在的目录或 NAS 路径".into());
    }
    let target = target_directory
        .canonicalize()
        .map_err(|_| "无法解析情报档案备份目标".to_string())?;
    if is_filesystem_root(&target) || is_home_directory(&target) {
        return Err("情报档案备份目标过于宽泛，请选择专用备份目录".into());
    }
    if source_directory == target
        || source_directory.starts_with(&target)
        || target.starts_with(source_directory)
    {
        return Err("情报档案备份目标不能与档案目录重叠或包含档案目录".into());
    }
    Ok(target)
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn is_home_directory(path: &Path) -> bool {
    dirs::home_dir()
        .and_then(|home| home.canonicalize().ok())
        .is_some_and(|home| home == path)
}

/// Creates a complete staging directory and makes it visible with one
/// same-parent rename only after every hash and SQLite check succeeds.
fn backup_archive_from_to(
    source_directory: &Path,
    target_directory: &Path,
) -> Result<IntelligenceArchiveBackupReport, String> {
    let catalog_source = source_directory.join(CATALOG_FILE);
    let source_catalog = open_catalog_readonly(&catalog_source)?;
    let source_catalog_version = catalog_data_version(&source_catalog)?;
    let (inventory_before, directories_before) = archive_layout(source_directory)?;
    if !inventory_before.contains(Path::new(CATALOG_FILE)) {
        return Err("本机情报档案缺少目录数据库，无法备份".into());
    }

    let unique = Uuid::new_v4().simple().to_string();
    let staged_directory =
        target_directory.join(format!(".kunpeng-intelligence-backup-staging-{unique}"));
    fs::create_dir(&staged_directory).map_err(|_| "无法创建情报档案备份暂存目录".to_string())?;

    let snapshot_id = format!(
        "kunpeng-intelligence-archive-{}-{unique}",
        Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let final_directory = target_directory.join(&snapshot_id);
    if final_directory.exists() {
        return Err("情报档案备份目录已存在，请重试".into());
    }

    for relative in &directories_before {
        fs::create_dir_all(staged_directory.join(relative))
            .map_err(|_| "无法创建情报档案备份子目录".to_string())?;
    }

    let mut files = Vec::with_capacity(inventory_before.len());
    for relative in &inventory_before {
        if relative == Path::new(CATALOG_FILE) {
            continue;
        }
        let source = source_directory.join(relative);
        let destination = staged_directory.join(relative);
        let (bytes, sha256) = copy_and_verify_unchanged(&source, &destination)?;
        files.push(ManifestFile {
            path: portable_relative_path(relative)?,
            bytes,
            sha256,
        });
    }

    let catalog_destination = staged_directory.join(CATALOG_FILE);
    source_catalog
        .execute(
            "VACUUM INTO ?1",
            [catalog_destination.to_string_lossy().as_ref()],
        )
        .map_err(|_| "创建情报目录数据库快照失败".to_string())?;
    validate_catalog(&catalog_destination)?;
    let (catalog_bytes, catalog_sha256) = sha256_file(&catalog_destination)?;
    files.push(ManifestFile {
        path: CATALOG_FILE.into(),
        bytes: catalog_bytes,
        sha256: catalog_sha256.clone(),
    });

    let (inventory_after, directories_after) = archive_layout(source_directory)?;
    if inventory_before != inventory_after || directories_before != directories_after {
        return Err("情报档案在备份期间发生文件变化，请稍后重试".into());
    }
    for relative in &inventory_before {
        if relative == Path::new(CATALOG_FILE) {
            continue;
        }
        let relative_path = portable_relative_path(relative)?;
        let expected = files
            .iter()
            .find(|file| file.path == relative_path)
            .ok_or("情报档案备份清单不完整")?;
        let (bytes, sha256) = sha256_file(&source_directory.join(relative))?;
        if bytes != expected.bytes || sha256 != expected.sha256 {
            return Err("情报档案在备份期间发生内容变化，请稍后重试".into());
        }
    }
    if catalog_data_version(&source_catalog)? != source_catalog_version {
        return Err("情报目录数据库在备份期间发生变化，请稍后重试".into());
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = ArchiveBackupManifest {
        format: FORMAT,
        version: VERSION,
        created_at: Utc::now().to_rfc3339(),
        files,
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| "生成情报档案备份清单失败".to_string())?;
    let manifest_path = staged_directory.join(MANIFEST_FILE);
    write_new_synced_file(&manifest_path, &manifest_bytes)?;
    let (_, manifest_sha256) = sha256_file(&manifest_path)?;

    fs::rename(&staged_directory, &final_directory)
        .map_err(|_| "原子发布情报档案备份失败，原档案未被修改".to_string())?;

    let total_bytes = manifest.files.iter().map(|file| file.bytes).sum();
    Ok(IntelligenceArchiveBackupReport {
        snapshot_id,
        files: manifest.files.len() as u64,
        bytes: total_bytes,
        catalog_sha256,
        manifest_sha256,
    })
}

fn archive_layout(
    source_directory: &Path,
) -> Result<(BTreeSet<PathBuf>, BTreeSet<PathBuf>), String> {
    let mut files = BTreeSet::new();
    let mut directories = BTreeSet::new();
    collect_inventory(
        source_directory,
        Path::new(""),
        &mut files,
        &mut directories,
    )?;
    Ok((files, directories))
}

fn collect_inventory(
    root: &Path,
    relative: &Path,
    files: &mut BTreeSet<PathBuf>,
    directories: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let directory = root.join(relative);
    for entry in fs::read_dir(&directory).map_err(|_| "无法读取情报档案目录".to_string())?
    {
        let entry = entry.map_err(|_| "无法读取情报档案目录项".to_string())?;
        let child_relative = relative.join(entry.file_name());
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| "无法读取情报档案文件属性".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("情报档案包含链接文件，拒绝进行不安全备份".into());
        }
        if metadata.is_dir() {
            directories.insert(child_relative.clone());
            collect_inventory(root, &child_relative, files, directories)?;
        } else if metadata.is_file() {
            if is_sqlite_runtime_sidecar(&child_relative)
                || is_migration_staging_file(&child_relative)
            {
                continue;
            }
            files.insert(child_relative);
        } else {
            return Err("情报档案包含不受支持的文件类型，拒绝备份".into());
        }
    }
    Ok(())
}

fn is_sqlite_runtime_sidecar(relative: &Path) -> bool {
    relative == Path::new("catalog.sqlite3-wal") || relative == Path::new("catalog.sqlite3-shm")
}

fn is_migration_staging_file(relative: &Path) -> bool {
    relative == Path::new(".catalog.sqlite3.migrating")
}

fn copy_and_verify_unchanged(source: &Path, destination: &Path) -> Result<(u64, String), String> {
    let parent = destination.parent().ok_or("情报档案备份目标无效")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建情报档案备份子目录".to_string())?;
    let source_file = File::open(source).map_err(|_| "无法读取情报档案文件".to_string())?;
    let destination_file = File::options()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "无法创建情报档案备份文件".to_string())?;
    let mut reader = BufReader::new(source_file);
    let mut writer = BufWriter::new(destination_file);
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "读取情报档案文件失败".to_string())?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|_| "写入情报档案备份文件失败".to_string())?;
        hasher.update(&buffer[..count]);
        bytes = bytes.saturating_add(count as u64);
    }
    writer
        .flush()
        .and_then(|()| writer.get_ref().sync_all())
        .map_err(|_| "同步情报档案备份文件失败".to_string())?;
    let sha256 = hex_digest(hasher.finalize());
    let (destination_bytes, destination_sha256) = sha256_file(destination)?;
    if bytes != destination_bytes || sha256 != destination_sha256 {
        return Err("情报档案备份文件校验失败".into());
    }
    Ok((bytes, sha256))
}

fn write_new_synced_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "无法写入情报档案备份清单".to_string())?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(bytes)
        .and_then(|()| writer.flush())
        .and_then(|()| writer.get_ref().sync_all())
        .map_err(|_| "无法同步情报档案备份清单".to_string())
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let file = File::open(path).map_err(|_| "无法读取情报档案备份文件".to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "读取情报档案备份文件失败".to_string())?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        hasher.update(&buffer[..count]);
    }
    Ok((bytes, hex_digest(hasher.finalize())))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

fn open_catalog_readonly(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法打开本机情报目录数据库".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "无法初始化本机情报目录数据库".to_string())?;
    validate_catalog_connection(&connection)?;
    Ok(connection)
}

fn validate_catalog(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法打开情报目录数据库快照".to_string())?;
    validate_catalog_connection(&connection)
}

fn validate_catalog_connection(connection: &Connection) -> Result<(), String> {
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| "情报目录数据库完整性检查失败".to_string())?;
    if quick_check != "ok" {
        return Err("情报目录数据库完整性检查失败".into());
    }
    Ok(())
}

fn catalog_data_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|_| "无法读取情报目录数据库版本".to_string())
}

fn portable_relative_path(relative: &Path) -> Result<String, String> {
    let mut components = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(value) = component else {
            return Err("情报档案包含不安全的相对路径".into());
        };
        components.push(value.to_string_lossy().into_owned());
    }
    if components.is_empty() {
        return Err("情报档案包含空路径".into());
    }
    Ok(components.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "kunpeng-intelligence-backup-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn create_archive(directory: &Path) {
        fs::create_dir_all(directory.join("blobs/text")).unwrap();
        fs::create_dir_all(directory.join("audit/empty")).unwrap();
        fs::write(directory.join("blobs/text/example.txt"), b"archive blob").unwrap();
        let connection = Connection::open(directory.join(CATALOG_FILE)).unwrap();
        connection
            .execute("CREATE TABLE archive_probe(value TEXT NOT NULL)", [])
            .unwrap();
        connection
            .execute("INSERT INTO archive_probe(value) VALUES ('ok')", [])
            .unwrap();
    }

    #[test]
    fn creates_verified_catalog_and_blob_snapshot_without_overwriting_target() {
        let root = test_directory("snapshot");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep-existing.txt"), b"keep").unwrap();
        create_archive(&source);
        let source_blob = sha256_file(&source.join("blobs/text/example.txt")).unwrap();
        let source_catalog = sha256_file(&source.join(CATALOG_FILE)).unwrap();

        let report = backup_archive_from_to(&source, &target).unwrap();
        let snapshot = target.join(&report.snapshot_id);
        assert!(snapshot.is_dir());
        assert_eq!(fs::read(target.join("keep-existing.txt")).unwrap(), b"keep");
        assert_eq!(
            sha256_file(&source.join("blobs/text/example.txt")).unwrap(),
            source_blob
        );
        assert_eq!(
            sha256_file(&source.join(CATALOG_FILE)).unwrap(),
            source_catalog
        );
        assert_eq!(
            fs::read(snapshot.join("blobs/text/example.txt")).unwrap(),
            b"archive blob"
        );
        assert!(snapshot.join("audit/empty").is_dir());
        validate_catalog(&snapshot.join(CATALOG_FILE)).unwrap();
        let (_, catalog_hash) = sha256_file(&snapshot.join(CATALOG_FILE)).unwrap();
        assert_eq!(catalog_hash, report.catalog_sha256);
        let (_, manifest_hash) = sha256_file(&snapshot.join(MANIFEST_FILE)).unwrap();
        assert_eq!(manifest_hash, report.manifest_sha256);
        assert_eq!(report.files, 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_target_that_contains_or_is_inside_source_archive() {
        let root = test_directory("overlap");
        let source = root.join("source");
        create_archive(&source);
        let inside_source = source.join("backup");
        fs::create_dir_all(&inside_source).unwrap();

        let source = canonical_archive_source(&source).unwrap();
        assert!(validated_target_directory(&root, &source).is_err());
        assert!(validated_target_directory(&inside_source, &source).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relative_and_missing_targets_before_copying() {
        let root = test_directory("target-validation");
        let source = root.join("source");
        create_archive(&source);
        let source = canonical_archive_source(&source).unwrap();

        assert!(validated_target_directory(Path::new("relative-backup"), &source).is_err());
        assert!(validated_target_directory(&root.join("missing"), &source).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
