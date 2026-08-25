//! Durable full-text and media evidence owned by the local intelligence host.
//!
//! This module deliberately has no collector or HTTP client.  A collector hands
//! it already-public, successfully fetched bytes; it then persists immutable
//! body versions below the permanent archive, with catalog rows referencing
//! only content hashes.  Reopening the desktop page can therefore never rely
//! on a cache TTL or refetch an article just to make evidence readable again.

use chrono::Utc;
use image::{DynamicImage, ImageFormat};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
};

const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_HTML_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MEDIA_PER_ARTICLE: usize = 64;
const MAX_PARAGRAPHS_PER_ARTICLE: usize = 20_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveParagraphInput {
    pub text: String,
    pub level: Option<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveImageInput {
    pub bytes: Vec<u8>,
    pub mime: Option<String>,
    pub paragraph_index: Option<u32>,
    pub alt: Option<String>,
    pub caption: Option<String>,
    pub credit: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveVideoInput {
    pub url: String,
    pub paragraph_index: Option<u32>,
    pub poster_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveArticleContentInput {
    pub article_id: String,
    pub record_fingerprint: String,
    pub text: String,
    pub html: Option<String>,
    pub body_status: Option<String>,
    pub incomplete_reason: Option<String>,
    pub paragraphs: Vec<ArchiveParagraphInput>,
    pub images: Vec<ArchiveImageInput>,
    pub videos: Vec<ArchiveVideoInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchivedImage {
    pub sha256: String,
    pub original_path: String,
    pub preview_640_path: Option<String>,
    pub preview_1280_path: Option<String>,
    pub mime: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveContentResult {
    pub article_id: String,
    pub version_sha256: String,
    pub text_sha256: String,
    pub html_sha256: Option<String>,
    pub paragraphs: u64,
    pub images: Vec<ArchivedImage>,
    pub videos: u64,
    pub reused_version: bool,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn required(value: &str, field: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} 不能为空"));
    }
    if value.len() > max {
        return Err(format!("{field} 超过本机永久档案上限"));
    }
    Ok(value.to_owned())
}

fn optional(value: Option<String>, field: &str, max: usize) -> Result<Option<String>, String> {
    value.map(|value| required(&value, field, max)).transpose()
}

/// Produce the one canonical byte representation used for both the permanent
/// text blob and its SHA-256.  Sources routinely change CRLF/LF, trailing
/// spaces, or add an initial BOM without changing the article evidence.  Those
/// transport-only changes must not create a new immutable revision or cause a
/// downstream model cache miss.  Paragraph boundaries remain meaningful, so
/// this deliberately preserves a single empty line between paragraphs.
fn canonical_article_text(value: &str) -> String {
    let value = value
        .strip_prefix('\u{feff}')
        .unwrap_or(value)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut output = String::with_capacity(value.len());
    let mut previous_blank = false;
    for line in value.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !previous_blank && !output.is_empty() {
                output.push('\n');
            }
            previous_blank = true;
        } else {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(line);
            previous_blank = false;
        }
    }
    output.trim().to_owned()
}

/// Return the digest of the exact canonical text representation used by the
/// immutable article archive.  Collection uses this when two independent
/// feeds point at the same normalized public URL: only byte-equivalent
/// canonical evidence may share the already processed article.  Keeping the
/// normalization here avoids a second, subtly different whitespace policy at
/// the collection boundary.
pub(crate) fn canonical_article_text_sha256(value: &str) -> String {
    sha256_hex(canonical_article_text(value).as_bytes())
}

fn ensure_catalog_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_article_content_versions (
                 article_id TEXT NOT NULL,
                 record_fingerprint TEXT NOT NULL,
                 version_sha256 TEXT NOT NULL,
                 text_sha256 TEXT NOT NULL,
                 html_sha256 TEXT,
                 body_status TEXT NOT NULL CHECK(body_status IN ('complete','truncated','unavailable')),
                 incomplete_reason TEXT,
                 is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY(article_id,version_sha256),
                 FOREIGN KEY(article_id) REFERENCES intelligence_articles(article_id) ON DELETE CASCADE
             );
             CREATE UNIQUE INDEX IF NOT EXISTS intelligence_article_content_current_idx
                 ON intelligence_article_content_versions(article_id) WHERE is_current=1;
             CREATE TABLE IF NOT EXISTS intelligence_article_paragraphs (
                 article_id TEXT NOT NULL,
                 version_sha256 TEXT NOT NULL,
                 paragraph_id TEXT NOT NULL,
                 ordinal INTEGER NOT NULL,
                 level INTEGER,
                 text_sha256 TEXT NOT NULL,
                 text_path TEXT NOT NULL,
                 PRIMARY KEY(article_id,version_sha256,ordinal),
                 UNIQUE(article_id,version_sha256,paragraph_id),
                 FOREIGN KEY(article_id,version_sha256)
                     REFERENCES intelligence_article_content_versions(article_id,version_sha256)
                     ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS intelligence_article_paragraph_lookup_idx
                 ON intelligence_article_paragraphs(article_id,paragraph_id);
             CREATE TABLE IF NOT EXISTS intelligence_article_media (
                 article_id TEXT NOT NULL,
                 version_sha256 TEXT NOT NULL,
                 media_index INTEGER NOT NULL,
                 kind TEXT NOT NULL CHECK(kind IN ('image','video')),
                 paragraph_index INTEGER,
                 image_sha256 TEXT,
                 original_path TEXT,
                 preview_640_path TEXT,
                 preview_1280_path TEXT,
                 mime TEXT,
                 video_url TEXT,
                 poster_sha256 TEXT,
                 alt TEXT,
                 caption TEXT,
                 credit TEXT,
                 source_url TEXT,
                 PRIMARY KEY(article_id,version_sha256,media_index),
                 FOREIGN KEY(article_id,version_sha256)
                     REFERENCES intelligence_article_content_versions(article_id,version_sha256)
                     ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS intelligence_article_media_image_idx
                 ON intelligence_article_media(image_sha256);",
        )
        .map_err(|error| format!("初始化本机正文档案结构失败：{error}"))?;
    // Existing permanent archives predate image provenance columns. SQLite has
    // no ADD COLUMN IF NOT EXISTS, so apply additive migrations idempotently.
    for statement in [
        "ALTER TABLE intelligence_article_media ADD COLUMN caption TEXT",
        "ALTER TABLE intelligence_article_media ADD COLUMN credit TEXT",
        "ALTER TABLE intelligence_article_media ADD COLUMN source_url TEXT",
    ] {
        if let Err(error) = connection.execute(statement, []) {
            if !error.to_string().contains("duplicate column name") {
                return Err(format!("升级本机媒体档案结构失败：{error}"));
            }
        }
    }
    Ok(())
}

/// Whether the current immutable evidence revision already contains a complete
/// body for this exact collected record. Collection uses this to backfill
/// legacy/previously interrupted items without treating the source entry as a
/// new article or scheduling model work again.
pub(crate) fn has_current_complete_content_at(
    catalog_path: &Path,
    article_id: &str,
    record_fingerprint: &str,
) -> Result<bool, String> {
    // Collection and immutable-evidence writes use separate transactions. A
    // process interruption between them can leave an otherwise verified body
    // under the previous feed fingerprint. Repair only the exact same body
    // before answering this predicate; a different or absent body remains
    // ineligible and must be fetched again.
    if reconcile_current_complete_content_for_article_at(
        catalog_path,
        article_id,
        record_fingerprint,
    )? {
        return Ok(true);
    }
    let connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    ensure_catalog_schema(&connection)?;
    connection
        .query_row(
            "SELECT 1 FROM intelligence_article_content_versions
             WHERE article_id=?1 AND record_fingerprint=?2
               AND body_status='complete' AND is_current=1",
            params![article_id, record_fingerprint],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| format!("查询本机正文档案失败：{error}"))
}

/// Read the canonical immutable body for the currently collected record.
///
/// The `intelligence_articles.body` column is only an operational projection
/// for compact queue work and can be missing on archives created before that
/// projection was introduced.  Deep 27B processing must use the CAS object
/// addressed by the current content revision, verify its digest, and never
/// silently fall back to a feed summary.
pub(crate) fn load_current_complete_text_at(
    catalog_path: &Path,
    article_id: &str,
    record_fingerprint: &str,
) -> Result<String, String> {
    let connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    ensure_catalog_schema(&connection)?;
    let text_sha256 = connection
        .query_row(
            "SELECT text_sha256 FROM intelligence_article_content_versions
             WHERE article_id=?1 AND record_fingerprint=?2
               AND body_status='complete' AND is_current=1",
            params![article_id, record_fingerprint],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("查询本机正文档案失败：{error}"))?
        .ok_or("本机完整正文版本不存在")?;
    let relative = safe_relative_blob_path("text", &text_sha256, ".txt")?;
    let absolute = archive_root(catalog_path)?.join(relative);
    let bytes = std::fs::read(&absolute).map_err(|_| "本机完整正文对象缺失")?;
    if bytes.is_empty() || bytes.len() > MAX_TEXT_BYTES {
        return Err("本机完整正文对象大小无效".into());
    }
    if sha256_hex(&bytes) != text_sha256 {
        return Err("本机完整正文对象校验失败".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "本机完整正文编码无效")?;
    (!text.trim().is_empty())
        .then_some(text)
        .ok_or_else(|| "本机完整正文为空".into())
}

/// Ensure the evidence schema exists before a bounded background backfill
/// selects legacy rows. This intentionally performs no content write.
pub(crate) fn ensure_catalog_schema_at(catalog_path: &Path) -> Result<(), String> {
    let connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    ensure_catalog_schema(&connection)
}

/// Repair a bounded set of interrupted record/evidence hand-offs.
///
/// A repair is deliberately narrower than content backfill: it is allowed
/// only when the current `intelligence_articles.body` projection hashes to the
/// exact current complete evidence revision. Missing, changed, or malformed
/// bodies are left untouched so downstream claims continue to require a
/// content version for the current record fingerprint.
pub(crate) fn reconcile_current_complete_content_versions_at(
    catalog_path: &Path,
    limit: usize,
) -> Result<u64, String> {
    if limit == 0 {
        return Ok(0);
    }
    let connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    ensure_catalog_schema(&connection)?;
    let limit: i64 = limit
        .min(1_024)
        .try_into()
        .map_err(|_| "正文版本补偿数量无效")?;
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT article.article_id,article.fingerprint
                 FROM intelligence_articles article
                 INNER JOIN intelligence_article_content_versions content
                   ON content.article_id=article.article_id
                  AND content.is_current=1
                  AND content.body_status='complete'
                 WHERE content.record_fingerprint<>article.fingerprint
                 ORDER BY content.created_at ASC,article.article_id ASC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    drop(connection);

    let mut repaired = 0_u64;
    for (article_id, fingerprint) in candidates {
        if reconcile_current_complete_content_for_article_at(
            catalog_path,
            &article_id,
            &fingerprint,
        )? {
            repaired = repaired.saturating_add(1);
        }
    }
    Ok(repaired)
}

/// Attempt one fingerprint hand-off without widening the complete-content
/// claim. It returns `false` for every non-identical or stale state so the
/// normal backfill path remains responsible for acquiring new evidence.
fn reconcile_current_complete_content_for_article_at(
    catalog_path: &Path,
    article_id: &str,
    expected_fingerprint: &str,
) -> Result<bool, String> {
    let article_id = required(article_id, "文章 ID", 200)?;
    let expected_fingerprint = required(expected_fingerprint, "文章记录指纹", 200)?;
    let connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    ensure_catalog_schema(&connection)?;
    let candidate = connection
        .query_row(
            "SELECT article.fingerprint,article.body,content.record_fingerprint,content.text_sha256
             FROM intelligence_articles article
             INNER JOIN intelligence_article_content_versions content
               ON content.article_id=article.article_id
              AND content.is_current=1
              AND content.body_status='complete'
             WHERE article.article_id=?1",
            [&article_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((current_fingerprint, body, previous_fingerprint, text_sha256)) = candidate else {
        return Ok(false);
    };
    if current_fingerprint != expected_fingerprint || previous_fingerprint == expected_fingerprint {
        return Ok(false);
    }
    let Some(body) = body else {
        return Ok(false);
    };
    let canonical_body = canonical_article_text(&body);
    if canonical_body.is_empty() || canonical_body.len() > MAX_TEXT_BYTES {
        return Ok(false);
    }
    if sha256_hex(canonical_body.as_bytes()) != text_sha256 {
        return Ok(false);
    }
    advance_current_complete_content_fingerprint_at(
        catalog_path,
        &article_id,
        &previous_fingerprint,
        &expected_fingerprint,
        &canonical_body,
    )
}

/// Move an already verified complete revision to a refreshed collected-record
/// fingerprint when the collector supplied the exact same canonical body.
///
/// RSS validators occasionally change without changing the public article.
/// The article row must still advance to the refreshed record fingerprint so
/// collection metadata stays truthful, but rewriting its immutable CAS body
/// would create needless evidence churn.  This function performs the catalog
/// portion of that hand-off in one SQLite transaction: the existing paragraph
/// and media provenance is copied to a new immutable revision, while the text
/// and HTML/image CAS objects remain untouched.
///
/// `false` means that no matching current complete revision exists (or its
/// canonical body differs), so the caller must persist the newly fetched
/// evidence normally instead of assuming that it is a validator-only update.
pub(crate) fn advance_current_complete_content_fingerprint_at(
    catalog_path: &Path,
    article_id: &str,
    previous_fingerprint: &str,
    refreshed_fingerprint: &str,
    expected_text: &str,
) -> Result<bool, String> {
    let article_id = required(article_id, "文章 ID", 200)?;
    let previous_fingerprint = required(previous_fingerprint, "旧文章记录指纹", 200)?;
    let refreshed_fingerprint = required(refreshed_fingerprint, "新文章记录指纹", 200)?;
    if previous_fingerprint == refreshed_fingerprint {
        return Ok(false);
    }
    let expected_text = required(
        &canonical_article_text(expected_text),
        "完整正文",
        MAX_TEXT_BYTES,
    )?;
    let expected_text_sha256 = sha256_hex(expected_text.as_bytes());

    let mut connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|error| error.to_string())?;
    ensure_catalog_schema(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let current_fingerprint = transaction
        .query_row(
            "SELECT fingerprint FROM intelligence_articles WHERE article_id=?1",
            [&article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if current_fingerprint.as_deref() != Some(refreshed_fingerprint.as_str()) {
        return Err("文章记录已再次更新，拒绝推进旧正文证据".into());
    }

    let previous = transaction
        .query_row(
            "SELECT version_sha256,text_sha256,html_sha256,body_status,incomplete_reason
             FROM intelligence_article_content_versions
             WHERE article_id=?1 AND record_fingerprint=?2
               AND body_status='complete' AND is_current=1",
            params![article_id, previous_fingerprint],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((previous_version, text_sha256, html_sha256, body_status, incomplete_reason)) =
        previous
    else {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    };
    if text_sha256 != expected_text_sha256 {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let media = {
        let mut statement = transaction
            .prepare(
                "SELECT kind,image_sha256,video_url,poster_sha256,alt,caption,credit,source_url
                 FROM intelligence_article_media
                 WHERE article_id=?1 AND version_sha256=?2 ORDER BY media_index ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![article_id, previous_version], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut version_hasher = Sha256::new();
    version_hasher.update(refreshed_fingerprint.as_bytes());
    version_hasher.update([0]);
    version_hasher.update(text_sha256.as_bytes());
    version_hasher.update([0]);
    version_hasher.update(html_sha256.as_deref().unwrap_or_default().as_bytes());
    for (kind, image_sha256, _, _, alt, caption, credit, source_url) in &media {
        if kind != "image" {
            continue;
        }
        let image_sha256 = image_sha256.as_deref().ok_or("本机图片档案缺少内容哈希")?;
        version_hasher.update([0]);
        version_hasher.update(image_sha256.as_bytes());
        for value in [alt, caption, credit, source_url] {
            version_hasher.update([0]);
            version_hasher.update(value.as_deref().unwrap_or_default().as_bytes());
        }
    }
    for (kind, _, video_url, poster_sha256, _, _, _, _) in &media {
        if kind != "video" {
            continue;
        }
        let video_url = video_url.as_deref().ok_or("本机视频档案缺少地址")?;
        version_hasher.update([0]);
        version_hasher.update(video_url.as_bytes());
        version_hasher.update([0]);
        version_hasher.update(poster_sha256.as_deref().unwrap_or_default().as_bytes());
    }
    let refreshed_version = sha256_hex(&version_hasher.finalize());

    transaction
        .execute(
            "UPDATE intelligence_article_content_versions SET is_current=0 WHERE article_id=?1",
            [&article_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO intelligence_article_content_versions(article_id,record_fingerprint,version_sha256,text_sha256,html_sha256,body_status,incomplete_reason,is_current,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8)
             ON CONFLICT(article_id,version_sha256) DO UPDATE SET
               record_fingerprint=excluded.record_fingerprint,text_sha256=excluded.text_sha256,
               html_sha256=excluded.html_sha256,body_status=excluded.body_status,
               incomplete_reason=excluded.incomplete_reason,is_current=1",
            params![article_id, refreshed_fingerprint, refreshed_version, text_sha256, html_sha256,
              body_status, incomplete_reason, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM intelligence_article_paragraphs WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, refreshed_version],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO intelligence_article_paragraphs(article_id,version_sha256,paragraph_id,ordinal,level,text_sha256,text_path)
             SELECT article_id,?3,paragraph_id,ordinal,level,text_sha256,text_path
             FROM intelligence_article_paragraphs WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, previous_version, refreshed_version],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM intelligence_article_media WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, refreshed_version],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO intelligence_article_media(article_id,version_sha256,media_index,kind,paragraph_index,image_sha256,original_path,preview_640_path,preview_1280_path,mime,video_url,poster_sha256,alt,caption,credit,source_url)
             SELECT article_id,?3,media_index,kind,paragraph_index,image_sha256,original_path,preview_640_path,preview_1280_path,mime,video_url,poster_sha256,alt,caption,credit,source_url
             FROM intelligence_article_media WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, previous_version, refreshed_version],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn archive_root(catalog_path: &Path) -> Result<&Path, String> {
    catalog_path.parent().ok_or("本机情报档案目录无效".into())
}

fn safe_relative_blob_path(kind: &str, hash: &str, suffix: &str) -> Result<PathBuf, String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("本机媒体哈希无效".into());
    }
    if !matches!(kind, "text" | "html" | "images")
        || suffix.contains(['/', '\\'])
        || suffix.contains("..")
    {
        return Err("本机媒体路径无效".into());
    }
    let file = match kind {
        "images" => format!("{hash}{suffix}"),
        _ => format!("{hash}{suffix}"),
    };
    Ok(match kind {
        "images" => PathBuf::from("blobs")
            .join("images")
            .join("sha256")
            .join(&hash[..2])
            .join(file),
        _ => PathBuf::from("blobs")
            .join(kind)
            .join(&hash[..2])
            .join(file),
    })
}

fn write_blob_once(root: &Path, relative: &Path, bytes: &[u8]) -> Result<String, String> {
    let absolute = root.join(relative);
    let parent = absolute.parent().ok_or("本机媒体路径无效")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建本机媒体目录失败：{error}"))?;
    if absolute.exists() {
        let current =
            std::fs::read(&absolute).map_err(|error| format!("读取本机媒体失败：{error}"))?;
        if sha256_hex(&current) != sha256_hex(bytes) {
            return Err("本机媒体 CAS 哈希冲突".into());
        }
    } else {
        crate::atomic_file::write(&absolute, bytes)?;
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn write_text_blob(
    root: &Path,
    kind: &str,
    bytes: &[u8],
    suffix: &str,
) -> Result<(String, String), String> {
    let hash = sha256_hex(bytes);
    let relative = safe_relative_blob_path(kind, &hash, suffix)?;
    let path = write_blob_once(root, &relative, bytes)?;
    Ok((hash, path))
}

fn normalize_paragraph(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn paragraph_id(article_id: &str, normalized: &str, occurrence: u32) -> String {
    let mut digest = Sha256::new();
    digest.update(article_id.as_bytes());
    digest.update([0]);
    digest.update(normalized.as_bytes());
    let hash = digest.finalize();
    let prefix = hash[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("p:{prefix}:{occurrence}")
}

fn validate_https_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "视频链接不是有效 URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("视频只允许无凭据的 HTTPS 链接".into());
    }
    Ok(url.to_string())
}

fn encode_preview(image: &DynamicImage, limit: u32) -> Result<Vec<u8>, String> {
    let preview = image.thumbnail(limit, limit);
    let mut bytes = Cursor::new(Vec::new());
    preview
        .write_to(&mut bytes, ImageFormat::WebP)
        .map_err(|_| "生成本机图片派生版本失败")?;
    Ok(bytes.into_inner())
}

fn archive_image(root: &Path, image: &ArchiveImageInput) -> Result<ArchivedImage, String> {
    if image.bytes.is_empty() || image.bytes.len() > MAX_IMAGE_BYTES {
        return Err("新闻图片大小无效".into());
    }
    let mime = optional(image.mime.clone(), "图片 MIME", 100)?
        .unwrap_or_else(|| "application/octet-stream".into());
    let hash = sha256_hex(&image.bytes);
    let original_relative = safe_relative_blob_path("images", &hash, ".original")?;
    let original_path = write_blob_once(root, &original_relative, &image.bytes)?;
    let decoded = image::load_from_memory(&image.bytes).map_err(|_| "资讯图片格式不受支持")?;
    let preview_640 = encode_preview(&decoded, 640)?;
    let preview_1280 = encode_preview(&decoded, 1280)?;
    let preview_640_path = write_blob_once(
        root,
        &safe_relative_blob_path("images", &hash, ".640.webp")?,
        &preview_640,
    )?;
    let preview_1280_path = write_blob_once(
        root,
        &safe_relative_blob_path("images", &hash, ".1280.webp")?,
        &preview_1280,
    )?;
    Ok(ArchivedImage {
        sha256: hash,
        original_path,
        preview_640_path: Some(preview_640_path),
        preview_1280_path: Some(preview_1280_path),
        mime,
    })
}

/// Persist one complete or explicitly incomplete public article body.  All
/// content bytes are written under `intelligence-hub/blobs`; SQLite retains
/// only stable identifiers, hashes and safe relative paths.
pub(crate) fn persist_article_content_at(
    catalog_path: &Path,
    input: ArchiveArticleContentInput,
) -> Result<ArchiveContentResult, String> {
    let article_id = required(&input.article_id, "文章 ID", 200)?;
    let record_fingerprint = required(&input.record_fingerprint, "文章记录指纹", 200)?;
    let text = required(
        &canonical_article_text(&input.text),
        "完整正文",
        MAX_TEXT_BYTES,
    )?;
    let html = optional(input.html, "原始 HTML", MAX_HTML_BYTES)?;
    if input.paragraphs.len() > MAX_PARAGRAPHS_PER_ARTICLE
        || input.images.len() + input.videos.len() > MAX_MEDIA_PER_ARTICLE
    {
        return Err("文章段落或媒体数量超过本机永久档案上限".into());
    }
    let body_status = input.body_status.unwrap_or_else(|| "complete".into());
    if !matches!(
        body_status.as_str(),
        "complete" | "truncated" | "unavailable"
    ) {
        return Err("正文状态无效".into());
    }
    let incomplete_reason = optional(input.incomplete_reason, "正文不完整原因", 1_000)?;
    if body_status == "complete" && incomplete_reason.is_some() {
        return Err("完整正文不能附带不完整原因".into());
    }
    let root = archive_root(catalog_path)?;
    std::fs::create_dir_all(root).map_err(|error| format!("创建本机情报档案目录失败：{error}"))?;
    // The immutable blob is canonical.  The current article row deliberately
    // keeps the same bounded text as an operational projection for the 8B
    // triage lease; without this update a background backfill would mark a
    // version complete while handing an empty excerpt to the small model.
    let indexed_body = text.clone();
    let text_bytes = text.into_bytes();
    let (text_sha256, _text_path) = write_text_blob(root, "text", &text_bytes, ".txt")?;
    let (html_sha256, _html_path) = match html.as_deref() {
        Some(html) => {
            let (hash, path) = write_text_blob(root, "html", html.as_bytes(), ".html")?;
            (Some(hash), Some(path))
        }
        None => (None, None),
    };
    let mut version_hasher = Sha256::new();
    version_hasher.update(record_fingerprint.as_bytes());
    version_hasher.update([0]);
    version_hasher.update(text_sha256.as_bytes());
    version_hasher.update([0]);
    version_hasher.update(html_sha256.as_deref().unwrap_or_default().as_bytes());
    // Media provenance is part of an immutable evidence revision. A changed
    // caption, credit, source URL or binary therefore cannot silently reuse an
    // older version merely because the article text stayed unchanged.
    for image in &input.images {
        version_hasher.update([0]);
        version_hasher.update(sha256_hex(&image.bytes).as_bytes());
        for value in [&image.alt, &image.caption, &image.credit, &image.source_url] {
            version_hasher.update([0]);
            version_hasher.update(value.as_deref().unwrap_or_default().as_bytes());
        }
    }
    for video in &input.videos {
        version_hasher.update([0]);
        version_hasher.update(video.url.as_bytes());
        version_hasher.update([0]);
        version_hasher.update(
            video
                .poster_sha256
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
    }
    let version_sha256 = sha256_hex(&version_hasher.finalize());
    let mut paragraphs = Vec::with_capacity(input.paragraphs.len());
    let mut paragraph_occurrences = HashMap::<String, u32>::new();
    for (ordinal, paragraph) in input.paragraphs.iter().enumerate() {
        let text = required(
            &canonical_article_text(&paragraph.text),
            "段落正文",
            256 * 1024,
        )?;
        let normalized = normalize_paragraph(&text);
        if normalized.is_empty() {
            return Err("段落正文不能为空".into());
        }
        let occurrence = paragraph_occurrences.entry(normalized.clone()).or_insert(0);
        *occurrence += 1;
        let id = paragraph_id(&article_id, &normalized, *occurrence);
        let (text_sha256, path) = write_text_blob(root, "text", text.as_bytes(), ".paragraph.txt")?;
        paragraphs.push((id, ordinal as i64, paragraph.level, text_sha256, path));
    }
    let images = input
        .images
        .iter()
        .map(|image| archive_image(root, image))
        .collect::<Result<Vec<_>, _>>()?;
    let videos = input
        .videos
        .iter()
        .map(|video| {
            Ok((
                validate_https_url(&video.url)?,
                video.paragraph_index,
                optional(video.poster_sha256.clone(), "视频海报哈希", 100)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut connection =
        Connection::open(catalog_path).map_err(|error| format!("打开本机情报档案失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|error| error.to_string())?;
    ensure_catalog_schema(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let current = transaction
        .query_row(
            "SELECT fingerprint FROM intelligence_articles WHERE article_id=?1",
            [&article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match current {
        Some(fingerprint) if fingerprint == record_fingerprint => {}
        Some(_) => return Err("文章记录已更新，拒绝写入旧正文证据".into()),
        None => return Err("文章记录不存在，不能写入孤立正文证据".into()),
    }
    let existed = transaction.query_row("SELECT 1 FROM intelligence_article_content_versions WHERE article_id=?1 AND version_sha256=?2", params![article_id, version_sha256], |_| Ok(())).optional().map_err(|error| error.to_string())?.is_some();
    transaction
        .execute(
            "UPDATE intelligence_article_content_versions SET is_current=0 WHERE article_id=?1",
            [&article_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO intelligence_article_content_versions(article_id,record_fingerprint,version_sha256,text_sha256,html_sha256,body_status,incomplete_reason,is_current,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8)
         ON CONFLICT(article_id,version_sha256) DO UPDATE SET is_current=1,body_status=excluded.body_status,incomplete_reason=excluded.incomplete_reason",
        params![article_id, record_fingerprint, version_sha256, text_sha256, html_sha256, body_status, incomplete_reason, now_ms()],
    ).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE intelligence_articles SET body=?3,updated_at=?4
             WHERE article_id=?1 AND fingerprint=?2",
            params![article_id, record_fingerprint, indexed_body, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM intelligence_article_paragraphs WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, version_sha256],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM intelligence_article_media WHERE article_id=?1 AND version_sha256=?2",
            params![article_id, version_sha256],
        )
        .map_err(|error| error.to_string())?;
    for (id, ordinal, level, paragraph_sha, path) in &paragraphs {
        transaction.execute("INSERT INTO intelligence_article_paragraphs(article_id,version_sha256,paragraph_id,ordinal,level,text_sha256,text_path) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![article_id, version_sha256, id, ordinal, level, paragraph_sha, path]).map_err(|error| error.to_string())?;
    }
    let mut media_index = 0_i64;
    for (source, archived) in input.images.iter().zip(&images) {
        transaction.execute("INSERT INTO intelligence_article_media(article_id,version_sha256,media_index,kind,paragraph_index,image_sha256,original_path,preview_640_path,preview_1280_path,mime,alt,caption,credit,source_url) VALUES(?1,?2,?3,'image',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![article_id, version_sha256, media_index, source.paragraph_index.map(i64::from), archived.sha256, archived.original_path, archived.preview_640_path, archived.preview_1280_path, archived.mime, optional(source.alt.clone(), "图片说明", 2_000)?, optional(source.caption.clone(), "图片说明", 2_000)?, optional(source.credit.clone(), "图片版权", 2_000)?, optional(source.source_url.clone(), "图片来源", 8_000)?]).map_err(|error| error.to_string())?;
        media_index += 1;
    }
    for (url, paragraph_index, poster_sha256) in &videos {
        transaction.execute("INSERT INTO intelligence_article_media(article_id,version_sha256,media_index,kind,paragraph_index,video_url,poster_sha256) VALUES(?1,?2,?3,'video',?4,?5,?6)", params![article_id, version_sha256, media_index, paragraph_index.map(|value| i64::from(value)), url, poster_sha256]).map_err(|error| error.to_string())?;
        media_index += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ArchiveContentResult {
        article_id,
        version_sha256,
        text_sha256,
        html_sha256,
        paragraphs: paragraphs.len() as u64,
        images,
        videos: videos.len() as u64,
        reused_version: existed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::png::PngEncoder, ColorType, ImageEncoder, RgbaImage};

    struct Fixture {
        root: PathBuf,
        catalog: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("kunpeng-content-archive-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let catalog = root.join("catalog.sqlite3");
            let connection = Connection::open(&catalog).unwrap();
            connection.execute("CREATE TABLE intelligence_articles(article_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,body TEXT,updated_at INTEGER)", []).unwrap();
            connection.execute("INSERT INTO intelligence_articles(article_id,fingerprint) VALUES('a','record-v1')", []).unwrap();
            Self { root, catalog }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn png() -> Vec<u8> {
        let image = RgbaImage::from_pixel(1600, 900, image::Rgba([24, 80, 160, 255]));
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ColorType::Rgba8.into(),
            )
            .unwrap();
        bytes
    }
    fn input() -> ArchiveArticleContentInput {
        ArchiveArticleContentInput {
            article_id: "a".into(),
            record_fingerprint: "record-v1".into(),
            text: "第一段\n\n第二段".into(),
            html: Some("<article><p>第一段</p><p>第二段</p></article>".into()),
            body_status: Some("complete".into()),
            incomplete_reason: None,
            paragraphs: vec![
                ArchiveParagraphInput {
                    text: "第一段".into(),
                    level: Some(1),
                },
                ArchiveParagraphInput {
                    text: "第二段".into(),
                    level: None,
                },
            ],
            images: vec![ArchiveImageInput {
                bytes: png(),
                mime: Some("image/png".into()),
                paragraph_index: Some(0),
                alt: Some("图".into()),
                caption: Some("测试图片说明".into()),
                credit: Some("测试图片版权".into()),
                source_url: Some("https://example.test/image.png".into()),
            }],
            videos: vec![ArchiveVideoInput {
                url: "https://video.example/watch?id=1".into(),
                paragraph_index: Some(1),
                poster_sha256: None,
            }],
        }
    }
    #[test]
    fn persists_immutable_body_paragraphs_images_and_https_videos() {
        let fixture = Fixture::new();
        let result = persist_article_content_at(&fixture.catalog, input()).unwrap();
        assert_eq!(result.paragraphs, 2);
        assert_eq!(result.images.len(), 1);
        assert_eq!(result.videos, 1);
        let image = &result.images[0];
        assert!(fixture.root.join(&image.original_path).is_file());
        assert!(fixture
            .root
            .join(image.preview_640_path.as_ref().unwrap())
            .is_file());
        assert_eq!(
            load_current_complete_text_at(&fixture.catalog, "a", "record-v1").unwrap(),
            "第一段\n\n第二段"
        );
        assert!(fixture
            .root
            .join(image.preview_1280_path.as_ref().unwrap())
            .is_file());
        assert!(image::open(fixture.root.join(image.preview_640_path.as_ref().unwrap())).is_ok());
        let connection = Connection::open(&fixture.catalog).unwrap();
        let provenance: (String, String, String) = connection
            .query_row(
                "SELECT caption,credit,source_url FROM intelligence_article_media WHERE kind='image'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            provenance,
            (
                "测试图片说明".into(),
                "测试图片版权".into(),
                "https://example.test/image.png".into()
            )
        );
        let ids = connection
            .prepare("SELECT paragraph_id FROM intelligence_article_paragraphs ORDER BY ordinal")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert_eq!(
            connection
                .query_row(
                    "SELECT body FROM intelligence_articles WHERE article_id='a'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "第一段\n\n第二段"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT video_url FROM intelligence_article_media WHERE kind='video'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "https://video.example/watch?id=1"
        );
    }
    #[test]
    fn identical_body_reuses_version_and_stable_paragraph_ids() {
        let fixture = Fixture::new();
        let first = persist_article_content_at(&fixture.catalog, input()).unwrap();
        let second = persist_article_content_at(&fixture.catalog, input()).unwrap();
        assert_eq!(first.version_sha256, second.version_sha256);
        assert!(second.reused_version);
        let connection = Connection::open(&fixture.catalog).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM intelligence_article_content_versions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
    #[test]
    fn canonical_body_bytes_reuse_a_revision_across_transport_whitespace() {
        let fixture = Fixture::new();
        let first = persist_article_content_at(&fixture.catalog, input()).unwrap();
        let mut replay = input();
        replay.text = "\u{feff}第一段  \r\n\r\n\r\n第二段\t\r\n".into();
        replay.paragraphs = vec![
            ArchiveParagraphInput {
                text: "第一段  \r\n".into(),
                level: Some(1),
            },
            ArchiveParagraphInput {
                text: "第二段\t".into(),
                level: None,
            },
        ];
        let second = persist_article_content_at(&fixture.catalog, replay).unwrap();
        assert_eq!(first.text_sha256, second.text_sha256);
        assert_eq!(first.version_sha256, second.version_sha256);
        assert!(second.reused_version);
        assert_eq!(
            load_current_complete_text_at(&fixture.catalog, "a", "record-v1").unwrap(),
            "第一段\n\n第二段"
        );
    }
    #[test]
    fn rejects_stale_fingerprint_non_https_video_and_path_escape() {
        let fixture = Fixture::new();
        let mut stale = input();
        stale.record_fingerprint = "old".into();
        assert!(persist_article_content_at(&fixture.catalog, stale).is_err());
        let mut insecure = input();
        insecure.videos[0].url = "http://video.example/one".into();
        assert!(persist_article_content_at(&fixture.catalog, insecure).is_err());
        assert!(safe_relative_blob_path("images", &"a".repeat(64), "/escape").is_err());
    }
    #[test]
    fn retains_prior_versions_and_marks_only_latest_current() {
        let fixture = Fixture::new();
        let first = persist_article_content_at(&fixture.catalog, input()).unwrap();
        let mut second_input = input();
        second_input.text = "新正文".into();
        second_input.paragraphs[0].text = "新正文".into();
        second_input.paragraphs.truncate(1);
        let second = persist_article_content_at(&fixture.catalog, second_input).unwrap();
        assert_ne!(first.version_sha256, second.version_sha256);
        let connection = Connection::open(&fixture.catalog).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM intelligence_article_content_versions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM intelligence_article_content_versions WHERE is_current=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn reconciles_an_interrupted_identical_body_fingerprint_handoff() {
        let fixture = Fixture::new();
        let first = persist_article_content_at(&fixture.catalog, input()).unwrap();
        let connection = Connection::open(&fixture.catalog).unwrap();
        connection
            .execute(
                "UPDATE intelligence_articles
                 SET fingerprint='record-v2',body='第一段\n\n第二段'
                 WHERE article_id='a'",
                [],
            )
            .unwrap();

        assert_eq!(
            reconcile_current_complete_content_versions_at(&fixture.catalog, 64).unwrap(),
            1
        );
        assert!(has_current_complete_content_at(&fixture.catalog, "a", "record-v2").unwrap());
        let (current_fingerprint, current_versions, copied_paragraphs): (String, i64, i64) =
            connection
                .query_row(
                    "SELECT content.record_fingerprint,
                            COUNT(*),
                            (SELECT COUNT(*) FROM intelligence_article_paragraphs
                              WHERE article_id='a' AND version_sha256=content.version_sha256)
                     FROM intelligence_article_content_versions content
                     WHERE content.article_id='a' AND content.is_current=1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        assert_eq!(current_fingerprint, "record-v2");
        assert_eq!(current_versions, 1);
        assert_eq!(copied_paragraphs, first.paragraphs as i64);
    }

    #[test]
    fn does_not_reconcile_a_changed_body_under_a_new_fingerprint() {
        let fixture = Fixture::new();
        persist_article_content_at(&fixture.catalog, input()).unwrap();
        let connection = Connection::open(&fixture.catalog).unwrap();
        connection
            .execute(
                "UPDATE intelligence_articles
                 SET fingerprint='record-v2',body='不同的正文'
                 WHERE article_id='a'",
                [],
            )
            .unwrap();

        assert_eq!(
            reconcile_current_complete_content_versions_at(&fixture.catalog, 64).unwrap(),
            0
        );
        assert!(!has_current_complete_content_at(&fixture.catalog, "a", "record-v2").unwrap());
        let current_fingerprint: String = connection
            .query_row(
                "SELECT record_fingerprint FROM intelligence_article_content_versions
                 WHERE article_id='a' AND is_current=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current_fingerprint, "record-v1");
    }
}
