//! Daily publication builder and outbound-only publisher.
//!
//! The permanent archive remains the source of truth.  This module creates a
//! signed-by-content daily projection only after full text has been processed,
//! uploads referenced local images by SHA-256, and publishes it through the
//! account-gated server API.  Tokens are passed only by the headless worker
//! from its protected lifecycle record; they are never stored here, printed,
//! or placed in a command line.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Days, NaiveDate, Utc};
use image::GenericImageView;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_EVENTS: usize = 30;
const MAX_NOTES: usize = 16;
const MAX_PARAGRAPHS: usize = 64;
const MAX_ASSETS: usize = 1_024;
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES: usize = 1_024 * 1_024;

#[derive(Clone, Debug)]
pub(crate) struct PublisherConfiguration {
    base_url: String,
    publisher_token: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PublishOutcome {
    /// The immutable local daily draft exists and can be published unchanged
    /// after the workstation is paired.  This is intentionally distinct from
    /// an outbound publication acknowledgement.
    PreparedLocally,
    NoCompletedEvents,
    AlreadyPublished,
    Published,
    TransportUnavailable,
    Failed,
}

/// A local, read-only projection check.  It intentionally never creates a
/// publication log row, uploads an asset, or needs a publisher credential.
/// Operators use it to prove that a historical day can form a formal package
/// before enabling the outbound publication capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DailyPreviewOutcome {
    Ready { events: u64, assets: u64 },
    NoCompletedEvents,
    Invalid,
}

#[derive(Clone, Debug)]
struct AssetPayload {
    asset_id: String,
    sha256: String,
    mime: String,
    bytes: Vec<u8>,
    width: Option<u32>,
    height: Option<u32>,
    archive_path: String,
}

#[derive(Clone, Debug)]
struct PublicationDraft {
    day: String,
    bundle: Value,
    canonical_sha256: String,
    assets: Vec<AssetPayload>,
}

pub(crate) fn configuration_from_parts(
    base_url: Option<&str>,
    publisher_token: Option<&str>,
) -> Option<PublisherConfiguration> {
    let base_url = base_url?.trim().trim_end_matches('/');
    let publisher_token = publisher_token?.trim();
    (base_url.starts_with("https://")
        && base_url.len() <= 2_048
        && base_url.is_ascii()
        && !base_url.contains(['@', '?', '#'])
        && !base_url.chars().any(char::is_whitespace)
        && !publisher_token.is_empty()
        && publisher_token.len() <= 4_096
        && publisher_token.is_ascii()
        && !publisher_token.chars().any(char::is_whitespace))
    .then(|| PublisherConfiguration {
        base_url: base_url.to_owned(),
        publisher_token: publisher_token.to_owned(),
    })
}

/// Finalizes yesterday's UTC daily package locally first, then publishes that
/// exact immutable draft when the operator has paired a publisher capability.
pub(crate) fn publish_completed_daily(
    configuration: Option<&PublisherConfiguration>,
    catalog: &Path,
) -> PublishOutcome {
    let Some(day) = Utc::now().date_naive().checked_sub_days(Days::new(1)) else {
        return PublishOutcome::Failed;
    };
    publish_day(configuration, catalog, day)
}

pub(crate) fn preview_daily_bundle(catalog: &Path, day: NaiveDate) -> DailyPreviewOutcome {
    match build_daily_bundle_at(catalog, day) {
        Ok(Some(draft)) => DailyPreviewOutcome::Ready {
            events: draft
                .bundle
                .get("events")
                .and_then(Value::as_array)
                .map_or(0, |events| events.len() as u64),
            assets: draft.assets.len() as u64,
        },
        Ok(None) => DailyPreviewOutcome::NoCompletedEvents,
        Err(()) => DailyPreviewOutcome::Invalid,
    }
}

fn publish_day(
    configuration: Option<&PublisherConfiguration>,
    catalog: &Path,
    day: NaiveDate,
) -> PublishOutcome {
    let draft = match load_or_prepare_daily_draft(catalog, day) {
        Ok(Some(value)) => value,
        Ok(None) => return PublishOutcome::NoCompletedEvents,
        Err(()) => return PublishOutcome::Failed,
    };
    let connection = match Connection::open(catalog) {
        Ok(value) => value,
        Err(_) => return PublishOutcome::Failed,
    };
    if ensure_publication_storage(&connection).is_err() {
        return PublishOutcome::Failed;
    }
    let existing = connection
        .query_row(
            "SELECT bundle_sha256 FROM intelligence_daily_publications WHERE day=?1",
            [&draft.day],
            |row| row.get::<_, String>(0),
        )
        .optional();
    // One date has one immutable daily package.  Re-running the local worker
    // must reuse it rather than re-uploading different same-day content.
    match existing {
        Ok(Some(existing_sha)) if existing_sha == draft.canonical_sha256 => {
            return PublishOutcome::AlreadyPublished
        }
        // A different hash for the same immutable day indicates local storage
        // corruption or an operator mismatch; never overwrite that receipt.
        Ok(Some(_)) => return PublishOutcome::Failed,
        Ok(None) => {}
        Err(_) => return PublishOutcome::Failed,
    }
    let Some(configuration) = configuration else {
        return PublishOutcome::PreparedLocally;
    };
    let transport = HttpsPublisher;
    for asset in &draft.assets {
        if transport
            .upload_asset(configuration, &draft.day, asset)
            .is_err()
        {
            return PublishOutcome::TransportUnavailable;
        }
    }
    if transport
        .upload_bundle(configuration, &draft.day, &draft.bundle)
        .is_err()
    {
        return PublishOutcome::TransportUnavailable;
    }
    if connection
        .execute(
            "INSERT INTO intelligence_daily_publications(day,publication_id,bundle_sha256,published_at)
             VALUES(?1,?2,?3,strftime('%s','now')*1000)
             ON CONFLICT(day) DO UPDATE SET publication_id=excluded.publication_id,
                 bundle_sha256=excluded.bundle_sha256,published_at=excluded.published_at",
            params![
                draft.day,
                draft
                    .bundle
                    .get("publicationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                draft.canonical_sha256
            ],
        )
        .is_err()
    {
        return PublishOutcome::Failed;
    }
    PublishOutcome::Published
}

fn ensure_publication_storage(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_daily_publications (
                 day TEXT PRIMARY KEY,
                 publication_id TEXT NOT NULL,
                 bundle_sha256 TEXT NOT NULL,
                 published_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_daily_drafts (
                 day TEXT PRIMARY KEY,
                 bundle_json TEXT NOT NULL,
                 bundle_sha256 TEXT NOT NULL,
                 prepared_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS intelligence_daily_draft_assets (
                 day TEXT NOT NULL,
                 asset_id TEXT NOT NULL,
                 sha256 TEXT NOT NULL,
                 mime TEXT NOT NULL,
                 bytes INTEGER NOT NULL,
                 width INTEGER,
                 height INTEGER,
                 archive_path TEXT NOT NULL,
                 PRIMARY KEY(day,asset_id)
             );",
        )
        .map_err(|_| ())
}

/// Stores a local, immutable snapshot before any credential or network call.
/// The permanent archive remains authoritative for assets, while the package
/// body, references and issue timestamp are frozen per day.  Later runs reuse
/// this exact JSON so a delayed pairing cannot silently publish a changed day.
fn load_or_prepare_daily_draft(
    catalog: &Path,
    day: NaiveDate,
) -> Result<Option<PublicationDraft>, ()> {
    let connection = Connection::open(catalog).map_err(|_| ())?;
    ensure_publication_storage(&connection)?;
    let day_text = day.format("%F").to_string();
    let existing = connection
        .query_row(
            "SELECT bundle_json,bundle_sha256 FROM intelligence_daily_drafts WHERE day=?1",
            [&day_text],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| ())?;
    let Some((bundle_json, canonical_sha256)) = existing else {
        drop(connection);
        return build_and_store_daily_draft(catalog, day);
    };
    let parsed_bundle = serde_json::from_str::<Value>(&bundle_json).ok();
    let draft_is_valid = parsed_bundle.as_ref().is_some_and(|bundle| {
        valid_sha256(&canonical_sha256)
            && bundle
                .get("bundleSha256")
                .and_then(Value::as_str)
                .filter(|value| *value == canonical_sha256)
                .is_some()
            && canonical_without_bundle_sha(bundle)
                .map(|canonical| sha256_hex(&canonical) == canonical_sha256)
                .unwrap_or(false)
    });
    if !draft_is_valid {
        // An unpublished local draft is a cache, not an externally observable
        // publication. Older workstation builds may have written a draft
        // before the current canonical package rules existed. Replace that
        // invalid cache atomically so a successful 27B synthesis can still be
        // prepared for the day. Once a receipt exists, fail closed: published
        // packages remain immutable even if a local cache is damaged.
        let published: Option<String> = connection
            .query_row(
                "SELECT bundle_sha256 FROM intelligence_daily_publications WHERE day=?1",
                [&day_text],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ())?;
        if published.is_some() {
            return Err(());
        }
        let transaction = connection.unchecked_transaction().map_err(|_| ())?;
        transaction
            .execute(
                "DELETE FROM intelligence_daily_draft_assets WHERE day=?1",
                [&day_text],
            )
            .map_err(|_| ())?;
        transaction
            .execute(
                "DELETE FROM intelligence_daily_drafts WHERE day=?1",
                [&day_text],
            )
            .map_err(|_| ())?;
        transaction.commit().map_err(|_| ())?;
        drop(connection);
        return build_and_store_daily_draft(catalog, day);
    }
    let bundle = parsed_bundle.ok_or(())?;
    // The persisted asset mapping, rather than the current event projection,
    // is authoritative for a frozen day.  Reopening a draft therefore never
    // rebuilds a changed event or asks a model to synthesize it again.
    let assets =
        match load_persisted_assets(&connection, catalog.parent().ok_or(())?, &day_text, &bundle) {
            Ok(assets) => assets,
            Err(()) => {
                // A pre-asset-map workstation could leave an otherwise canonical
                // unpublished bundle behind. It cannot be safely published: the
                // JSON declares images whose pinned archive payloads are absent.
                // Treat it like the legacy invalid-cache path above and rebuild
                // from the still-present local event archive. A published daily
                // package is immutable, so that case still fails closed.
                let published: Option<String> = connection
                    .query_row(
                        "SELECT bundle_sha256 FROM intelligence_daily_publications WHERE day=?1",
                        [&day_text],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| ())?;
                if published.is_some() {
                    return Err(());
                }
                let transaction = connection.unchecked_transaction().map_err(|_| ())?;
                transaction
                    .execute(
                        "DELETE FROM intelligence_daily_draft_assets WHERE day=?1",
                        [&day_text],
                    )
                    .map_err(|_| ())?;
                transaction
                    .execute(
                        "DELETE FROM intelligence_daily_drafts WHERE day=?1",
                        [&day_text],
                    )
                    .map_err(|_| ())?;
                transaction.commit().map_err(|_| ())?;
                drop(connection);
                return build_and_store_daily_draft(catalog, day);
            }
        };
    Ok(Some(PublicationDraft {
        day: day_text,
        bundle,
        canonical_sha256,
        assets,
    }))
}

fn build_and_store_daily_draft(
    catalog: &Path,
    day: NaiveDate,
) -> Result<Option<PublicationDraft>, ()> {
    let fresh = match build_daily_bundle_at(catalog, day)? {
        Some(draft) => draft,
        None => return Ok(None),
    };
    let connection = Connection::open(catalog).map_err(|_| ())?;
    ensure_publication_storage(&connection)?;
    let transaction = connection.unchecked_transaction().map_err(|_| ())?;
    transaction
        .execute(
            "INSERT INTO intelligence_daily_drafts(day,bundle_json,bundle_sha256,prepared_at)
             VALUES(?1,?2,?3,strftime('%s','now')*1000)",
            params![fresh.day, fresh.bundle.to_string(), fresh.canonical_sha256],
        )
        .map_err(|_| ())?;
    for asset in &fresh.assets {
        transaction
            .execute(
                "INSERT INTO intelligence_daily_draft_assets(day,asset_id,sha256,mime,bytes,width,height,archive_path)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    fresh.day,
                    asset.asset_id,
                    asset.sha256,
                    asset.mime,
                    asset.bytes.len() as i64,
                    asset.width.map(i64::from),
                    asset.height.map(i64::from),
                    asset.archive_path,
                ],
            )
            .map_err(|_| ())?;
    }
    transaction.commit().map_err(|_| ())?;
    Ok(Some(fresh))
}

fn load_persisted_assets(
    connection: &Connection,
    root: &Path,
    day: &str,
    bundle: &Value,
) -> Result<Vec<AssetPayload>, ()> {
    let declarations = bundle.get("assets").and_then(Value::as_array).ok_or(())?;
    let mut expected = BTreeMap::new();
    for declaration in declarations {
        let asset_id = declaration
            .get("assetId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or(())?;
        let sha256 = declaration
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| valid_sha256(value))
            .ok_or(())?;
        let mime = declaration
            .get("mime")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "image/jpeg" | "image/png" | "image/webp"))
            .ok_or(())?;
        let bytes = declaration
            .get("bytes")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0 && *value <= MAX_ASSET_BYTES as u64)
            .ok_or(())?;
        let width = declaration.get("width").and_then(Value::as_u64);
        let height = declaration.get("height").and_then(Value::as_u64);
        if width.is_some_and(|value| value == 0 || value > 16_384)
            || height.is_some_and(|value| value == 0 || value > 16_384)
            || expected
                .insert(
                    asset_id.to_owned(),
                    (sha256.to_owned(), mime.to_owned(), bytes, width, height),
                )
                .is_some()
        {
            return Err(());
        }
    }
    let mut statement = connection
        .prepare(
            "SELECT asset_id,sha256,mime,bytes,width,height,archive_path
             FROM intelligence_daily_draft_assets WHERE day=?1 ORDER BY asset_id",
        )
        .map_err(|_| ())?;
    let rows = statement
        .query_map([day], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| ())?;
    let mut assets = Vec::with_capacity(expected.len());
    for row in rows {
        let (asset_id, sha256, mime, declared_bytes, width, height, archive_path) =
            row.map_err(|_| ())?;
        let Some((expected_sha, expected_mime, expected_bytes, expected_width, expected_height)) =
            expected.remove(&asset_id)
        else {
            return Err(());
        };
        let width = width.and_then(|value| u32::try_from(value).ok());
        let height = height.and_then(|value| u32::try_from(value).ok());
        if sha256 != expected_sha
            || mime != expected_mime
            || declared_bytes < 1
            || declared_bytes as u64 != expected_bytes
            || width.map(u64::from) != expected_width
            || height.map(u64::from) != expected_height
        {
            return Err(());
        }
        let path = safe_archive_file(root, &archive_path)?;
        let bytes = std::fs::read(&path).map_err(|_| ())?;
        if bytes.len() as i64 != declared_bytes || sha256_hex(&bytes) != sha256 {
            return Err(());
        }
        let (actual_width, actual_height) = image::load_from_memory(&bytes)
            .map_err(|_| ())?
            .dimensions();
        if width != Some(actual_width) || height != Some(actual_height) {
            return Err(());
        }
        assets.push(AssetPayload {
            asset_id,
            sha256,
            mime,
            bytes,
            width,
            height,
            archive_path,
        });
    }
    expected.is_empty().then_some(assets).ok_or(())
}

fn build_daily_bundle_at(catalog: &Path, day: NaiveDate) -> Result<Option<PublicationDraft>, ()> {
    let connection =
        Connection::open_with_flags(catalog, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ())?;
    let day_text = day.format("%F").to_string();
    let mut events = connection
        .prepare(
            "SELECT e.event_id,e.series_id,e.title,e.occurred_at,e.current_revision,r.body,r.revision_json
             FROM intelligence_events e
             JOIN intelligence_event_revisions r
               ON r.event_id=e.event_id AND r.revision_no=e.current_revision
             WHERE date(e.updated_at / 1000, 'unixepoch')=?1
             ORDER BY COALESCE(e.importance,0) DESC,e.updated_at DESC,e.event_id ASC
             LIMIT ?2",
        )
        .map_err(|_| ())?;
    let rows = events
        .query_map(params![day_text, MAX_EVENTS as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            ))
        })
        .map_err(|_| ())?;
    let root = catalog.parent().ok_or(())?;
    let mut projection = Vec::new();
    let mut assets = Vec::new();
    for row in rows {
        let (event_id, series_id, title, occurred_at, revision_no, _body, revision_json) =
            row.map_err(|_| ())?;
        let Some((notes, media_ids, video_url, event_assets)) =
            source_projection(&connection, root, &event_id, &mut assets)?
        else {
            continue;
        };
        assets.extend(event_assets);
        if assets.len() > MAX_ASSETS {
            return Err(());
        }
        let blocks = revision_blocks_projection(&revision_json, &notes, media_ids, video_url)?;
        let mut event = Map::new();
        event.insert("eventId".into(), Value::String(event_id));
        event.insert("revisionNo".into(), Value::from(revision_no));
        if let Some(series_id) = series_id.filter(|value| valid_id(value)) {
            event.insert("seriesId".into(), Value::String(series_id));
        }
        event.insert("title".into(), Value::String(model_text(&title, 2_048)?));
        event.insert(
            "occurredAt".into(),
            occurred_at
                .and_then(|value| canonical_timestamp(&value))
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        event.insert("blocks".into(), Value::Array(blocks));
        event.insert("notes".into(), Value::Array(notes));
        projection.push(Value::Object(event));
    }
    if projection.is_empty() {
        return Ok(None);
    }
    let published_at = format!("{day_text}T00:00:00Z");
    let expires_at = day
        .checked_add_days(Days::new(30))
        .ok_or(())?
        .format("%F")
        .to_string()
        + "T00:00:00Z";
    let mut bundle = json!({
        "schemaVersion": 1,
        "publicationId": format!("daily:{day_text}:host"),
        "kind": "daily",
        "publishedAt": published_at,
        "expiresAt": expires_at,
        "issuedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "events": projection,
        "assets": assets.iter().map(asset_declaration).collect::<Vec<_>>(),
        "bundleSha256": ""
    });
    let canonical_sha256 = sha256_hex(&canonical_without_bundle_sha(&bundle)?);
    bundle["bundleSha256"] = Value::String(canonical_sha256.clone());
    Ok(Some(PublicationDraft {
        day: day_text,
        bundle,
        canonical_sha256,
        assets,
    }))
}

/// Project only the revision's already validated structured synthesis.  Older
/// free-text revisions deliberately cannot become formal packages: guessing a
/// citation for a whole paragraph would violate the per-segment evidence rule.
fn revision_blocks_projection(
    revision_json: &str,
    notes: &[Value],
    media_ids: Vec<Value>,
    video_url: Option<String>,
) -> Result<Vec<Value>, ()> {
    let revision: Value = serde_json::from_str(revision_json).map_err(|_| ())?;
    let blocks = revision
        .get("synthesis")
        .and_then(|value| value.get("blocks"))
        .and_then(Value::as_array)
        .filter(|blocks| !blocks.is_empty())
        .ok_or(())?;
    let available_notes = notes
        .iter()
        .filter_map(|note| note.get("noteId").and_then(Value::as_str))
        .collect::<std::collections::BTreeSet<_>>();
    let available_media = media_ids
        .iter()
        .filter_map(Value::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let mut seen_blocks = std::collections::BTreeSet::new();
    let mut projected = Vec::with_capacity(blocks.len());
    for block in blocks {
        let object = block.as_object().ok_or(())?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "blockId" | "segments" | "mediaIds"))
        {
            return Err(());
        }
        let block_id = block
            .get("blockId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or(())?;
        if !seen_blocks.insert(block_id) {
            return Err(());
        }
        let segments = block
            .get("segments")
            .and_then(Value::as_array)
            .filter(|segments| !segments.is_empty())
            .ok_or(())?;
        let mut safe_segments = Vec::with_capacity(segments.len());
        for segment in segments {
            let text = segment
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| model_text(text, 16 * 1024).is_ok())
                .ok_or(())?;
            let note_ids = segment
                .get("noteIds")
                .and_then(Value::as_array)
                .filter(|ids| !ids.is_empty())
                .ok_or(())?;
            if note_ids
                .iter()
                .any(|id| id.as_str().map_or(true, |id| !available_notes.contains(id)))
            {
                return Err(());
            }
            safe_segments.push(json!({"text": text, "noteIds": note_ids}));
        }
        let requested_media = block.get("mediaIds").and_then(Value::as_array).ok_or(())?;
        if requested_media
            .iter()
            .any(|id| id.as_str().map_or(true, |id| !available_media.contains(id)))
        {
            return Err(());
        }
        projected
            .push(json!({"blockId":block_id,"segments":safe_segments,"mediaIds":requested_media}));
    }
    // Images are archive-derived rather than model-selected in V1. Attach the
    // verified set to the first paragraph only when no controlled block chose
    // one; this preserves image visibility without inventing an image URL.
    if let Some(first) = projected.first_mut().and_then(Value::as_object_mut) {
        if first
            .get("mediaIds")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
            && !media_ids.is_empty()
        {
            first.insert("mediaIds".into(), Value::Array(media_ids));
        }
        if let Some(url) = video_url {
            first.insert("videoUrl".into(), Value::String(url));
        }
    }
    Ok(projected)
}

/// Returns note projections plus event-local media.  Every note points to a
/// persisted paragraph hash; the server never receives a source body.
fn source_projection(
    connection: &Connection,
    root: &Path,
    event_id: &str,
    all_assets: &mut Vec<AssetPayload>,
) -> Result<Option<(Vec<Value>, Vec<Value>, Option<String>, Vec<AssetPayload>)>, ()> {
    let mut sources = connection
        .prepare(
            "SELECT a.article_id,COALESCE(a.source_name,''),a.title,COALESCE(a.summary,''),
                    a.url,COALESCE(a.published_at,''),v.version_sha256
             FROM intelligence_event_articles ea
             JOIN intelligence_articles a ON a.article_id=ea.article_id
             JOIN intelligence_article_content_versions v
               ON v.article_id=a.article_id AND v.is_current=1 AND v.body_status='complete'
             WHERE ea.event_id=?1 AND a.url LIKE 'https://%'
             ORDER BY a.published_at,a.article_id LIMIT ?2",
        )
        .map_err(|_| ())?;
    let rows = sources
        .query_map(params![event_id, MAX_NOTES as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| ())?;
    let mut notes = Vec::new();
    let mut media_ids: Vec<Value> = Vec::new();
    let mut video_url = None;
    let mut event_assets = Vec::new();
    for row in rows {
        let (article_id, publisher, title, summary, url, published_at, source_sha256) =
            row.map_err(|_| ())?;
        let Some(published_at) = canonical_timestamp(&published_at) else {
            continue;
        };
        let Some(url) = public_https_url(&url) else {
            continue;
        };
        if !valid_id(&article_id) || !valid_sha256(&source_sha256) {
            continue;
        }
        let paragraphs = paragraph_evidence(connection, &article_id, MAX_PARAGRAPHS)?;
        if paragraphs.is_empty() {
            continue;
        }
        let note_id = format!("note:{}", &sha256_hex(article_id.as_bytes())[..16]);
        notes.push(json!({
            "noteId": note_id,
            "sourceId": article_id,
            "sourceSha256": source_sha256,
            "publisher": limited_nonempty(&publisher, "公开来源", 256),
            "title": limited_nonempty(&title, "未命名来源", 2048),
            "originalUrl": url,
            "publishedAt": published_at,
            "paragraphs": paragraphs,
            "fallbackExcerpt": limited_nonempty(&summary, &title, 4096),
        }));
        if media_ids.len() < 16 && all_assets.len() + event_assets.len() < MAX_ASSETS {
            if let Some(asset) = first_image_asset(connection, root, &article_id)? {
                let asset_id = asset_id_for_sha256(&asset.sha256)?;
                if !all_assets
                    .iter()
                    .chain(event_assets.iter())
                    .any(|item| item.sha256 == asset.sha256)
                {
                    event_assets.push(asset);
                }
                if !media_ids
                    .iter()
                    .any(|id| id.as_str() == Some(asset_id.as_str()))
                {
                    media_ids.push(Value::String(asset_id));
                }
            }
        }
        if video_url.is_none() {
            video_url = first_video_url(connection, &article_id)?;
        }
    }
    Ok((!notes.is_empty()).then_some((notes, media_ids, video_url, event_assets)))
}

fn paragraph_evidence(
    connection: &Connection,
    article_id: &str,
    limit: usize,
) -> Result<Vec<Value>, ()> {
    let mut statement = connection
        .prepare(
            "SELECT p.paragraph_id,p.text_sha256 FROM intelligence_article_paragraphs p
             JOIN intelligence_article_content_versions v
               ON v.article_id=p.article_id AND v.version_sha256=p.version_sha256 AND v.is_current=1
             WHERE p.article_id=?1 ORDER BY p.ordinal LIMIT ?2",
        )
        .map_err(|_| ())?;
    let paragraphs = statement
        .query_map(params![article_id, limit as i64], |row| {
            Ok(json!({"paragraphId":row.get::<_, String>(0)?,"sha256":row.get::<_, String>(1)?}))
        })
        .map_err(|_| ())?
        .filter_map(Result::ok)
        .filter(|value| {
            valid_id(value["paragraphId"].as_str().unwrap_or_default())
                && valid_sha256(value["sha256"].as_str().unwrap_or_default())
        })
        .collect::<Vec<_>>();
    Ok(paragraphs)
}

fn first_image_asset(
    connection: &Connection,
    root: &Path,
    article_id: &str,
) -> Result<Option<AssetPayload>, ()> {
    let row = connection
        .query_row(
            "SELECT preview_1280_path FROM intelligence_article_media m
             JOIN intelligence_article_content_versions v
               ON v.article_id=m.article_id AND v.version_sha256=m.version_sha256 AND v.is_current=1
             WHERE m.article_id=?1 AND m.kind='image' AND m.preview_1280_path IS NOT NULL
             ORDER BY m.media_index LIMIT 1",
            [article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ())?;
    let Some(relative) = row else { return Ok(None) };
    let path = safe_archive_file(root, &relative)?;
    let bytes = std::fs::read(path).map_err(|_| ())?;
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
        return Err(());
    }
    let (width, height) = image::load_from_memory(&bytes)
        .map_err(|_| ())?
        .dimensions();
    Ok(Some(AssetPayload {
        asset_id: asset_id_for_sha256(&sha256_hex(&bytes))?,
        sha256: sha256_hex(&bytes),
        mime: "image/webp".into(),
        bytes,
        width: Some(width),
        height: Some(height),
        archive_path: relative,
    }))
}

fn first_video_url(connection: &Connection, article_id: &str) -> Result<Option<String>, ()> {
    let value = connection
        .query_row(
            "SELECT video_url FROM intelligence_article_media m
         JOIN intelligence_article_content_versions v
           ON v.article_id=m.article_id AND v.version_sha256=m.version_sha256 AND v.is_current=1
         WHERE m.article_id=?1 AND m.kind='video' AND m.video_url LIKE 'https://%'
         ORDER BY m.media_index LIMIT 1",
            [article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ())?;
    Ok(value.and_then(|value| public_https_url(&value)))
}

fn safe_archive_file(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || !relative.starts_with("blobs/images/sha256")
    {
        return Err(());
    }
    Ok(root.join(relative))
}

fn limited_nonempty(value: &str, fallback: &str, max: usize) -> String {
    let value = value.trim();
    let value = if value.is_empty() {
        fallback.trim()
    } else {
        value
    };
    value
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn model_text(value: &str, max: usize) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty() || value.contains("https://") || value.contains("http://") {
        return Err(());
    }
    let result = value
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned();
    (!result.is_empty()).then_some(result).ok_or(())
}

/// Source and video links come only from the archive, but still need the same
/// strict public HTTPS shape required by the distribution contract.  The
/// model never sees or produces these values.
fn public_https_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4_096 || value.chars().any(char::is_whitespace) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn asset_declaration(asset: &AssetPayload) -> Value {
    let mut value = json!({"assetId":asset.asset_id,"kind":"image","sha256":asset.sha256,"mime":asset.mime,"bytes":asset.bytes.len()});
    if let Some(width) = asset.width {
        value["width"] = Value::from(width);
    }
    if let Some(height) = asset.height {
        value["height"] = Value::from(height);
    }
    value
}

fn asset_id_for_sha256(sha256: &str) -> Result<String, ()> {
    valid_sha256(sha256)
        .then(|| format!("image:{sha256}"))
        .ok_or(())
}

struct HttpsPublisher;

impl HttpsPublisher {
    fn upload_asset(
        &self,
        configuration: &PublisherConfiguration,
        day: &str,
        asset: &AssetPayload,
    ) -> Result<(), ()> {
        let init = self.call(
            configuration,
            "POST",
            "/v1/intelligence/assets/init",
            &format!("daily:{day}:asset:{}:init", asset.sha256),
            Some(json!({"sha256":asset.sha256,"mime":asset.mime,"totalBytes":asset.bytes.len()})),
        )?;
        if !init
            .get("complete")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            for (chunk_index, chunk) in asset.bytes.chunks(UPLOAD_CHUNK_BYTES).enumerate() {
                let offset = chunk_index.checked_mul(UPLOAD_CHUNK_BYTES).ok_or(())?;
                self.call(configuration, "PUT", &format!("/v1/intelligence/assets/{}", asset.sha256), &format!("daily:{day}:asset:{}:{chunk_index}", asset.sha256), Some(json!({"offset":offset,"contentBase64":STANDARD.encode(chunk),"chunkSha256":sha256_hex(chunk)})))?;
            }
            self.call(
                configuration,
                "POST",
                &format!("/v1/intelligence/assets/{}/complete", asset.sha256),
                &format!("daily:{day}:asset:{}:complete", asset.sha256),
                Some(json!({})),
            )?;
        }
        Ok(())
    }

    fn upload_bundle(
        &self,
        configuration: &PublisherConfiguration,
        day: &str,
        bundle: &Value,
    ) -> Result<(), ()> {
        let id = bundle
            .get("publicationId")
            .and_then(Value::as_str)
            .ok_or(())?;
        self.call(
            configuration,
            "POST",
            "/v1/intelligence/uploads/init",
            &format!("daily:{day}:init"),
            Some(bundle.clone()),
        )?;
        self.call(
            configuration,
            "POST",
            &format!("/v1/intelligence/uploads/{id}/complete"),
            &format!("daily:{day}:complete"),
            Some(json!({})),
        )?;
        Ok(())
    }

    fn call(
        &self,
        configuration: &PublisherConfiguration,
        method: &str,
        suffix: &str,
        key: &str,
        body: Option<Value>,
    ) -> Result<Value, ()> {
        if !suffix.starts_with('/') || suffix.contains(['\r', '\n']) || key.len() > 128 {
            return Err(());
        }
        let endpoint = format!("{}{}", configuration.base_url, suffix);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_recv_response(Some(Duration::from_secs(35)))
            .timeout_recv_body(Some(Duration::from_secs(35)))
            .build()
            .into();
        let authorization = format!("Bearer {}", configuration.publisher_token);
        let request = match method {
            "POST" => agent.post(&endpoint),
            "PUT" => agent.put(&endpoint),
            _ => return Err(()),
        }
        .header("Authorization", &authorization)
        .header("Idempotency-Key", key)
        .header("Content-Type", "application/json");
        let response = request
            .send_json(body.unwrap_or_else(|| json!({})))
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        response.into_body().read_json::<Value>().map_err(|_| ())
    }
}

fn canonical_without_bundle_sha(value: &Value) -> Result<Vec<u8>, ()> {
    let mut clone = value.clone();
    clone.as_object_mut().ok_or(())?.remove("bundleSha256");
    let mut output = String::new();
    canonical_value(&clone, &mut output);
    Ok(output.into_bytes())
}

fn canonical_value(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("string serializes"))
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_value(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let ordered: BTreeMap<_, _> = values.iter().collect();
            for (index, (key, value)) in ordered.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("key serializes"));
                output.push(':');
                canonical_value(value, output);
            }
            output.push('}');
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn valid_id(value: &str) -> bool {
    let mut chars = value.bytes();
    matches!(chars.next(), Some(value) if value.is_ascii_alphanumeric())
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
/// Accept legacy public-feed timestamps at projection time as well as the
/// canonical RFC 3339 form written by current collectors.  This safely makes
/// already archived RFC 2822 or date-only evidence publishable without
/// mutating the immutable source archive; formats we cannot parse remain
/// excluded rather than gaining a guessed timestamp.
fn canonical_timestamp(value: &str) -> Option<String> {
    let value = value.trim();
    let parsed = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_rfc2822(value))
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|timestamp| timestamp.and_utc())
                .ok_or(())
        })
        .or_else(|_| {
            value
                .parse::<i64>()
                .ok()
                .and_then(|timestamp| match value.len() {
                    10 => DateTime::from_timestamp(timestamp, 0),
                    13 => DateTime::from_timestamp_millis(timestamp),
                    _ => None,
                })
                .ok_or(())
        })
        .ok()?;
    Some(parsed.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn daily_bundle_uses_only_persisted_source_evidence() {
        let root =
            std::env::temp_dir().join(format!("kunpeng-publication-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("catalog.sqlite3");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE intelligence_events(event_id TEXT PRIMARY KEY,series_id TEXT,title TEXT,importance REAL,occurred_at TEXT,current_revision INTEGER,updated_at INTEGER);CREATE TABLE intelligence_event_revisions(event_id TEXT,revision_no INTEGER,body TEXT,revision_json TEXT);CREATE TABLE intelligence_event_articles(event_id TEXT,article_id TEXT);CREATE TABLE intelligence_articles(article_id TEXT PRIMARY KEY,source_name TEXT,title TEXT,summary TEXT,url TEXT,published_at TEXT);CREATE TABLE intelligence_article_content_versions(article_id TEXT,version_sha256 TEXT,body_status TEXT,is_current INTEGER);CREATE TABLE intelligence_article_paragraphs(article_id TEXT,version_sha256 TEXT,paragraph_id TEXT,text_sha256 TEXT,ordinal INTEGER);CREATE TABLE intelligence_article_media(article_id TEXT,version_sha256 TEXT,kind TEXT,preview_1280_path TEXT,video_url TEXT,media_index INTEGER);").unwrap();
        c.execute("INSERT INTO intelligence_events VALUES('event-a',NULL,'事件标题',90,'2030-01-02T02:00:00Z',1,?1)",[chrono::DateTime::parse_from_rfc3339("2030-01-02T05:00:00Z").unwrap().timestamp_millis()]).unwrap();
        let note_id = format!("note:{}", &sha256_hex(b"source-a")[..16]);
        c.execute(
            "INSERT INTO intelligence_event_revisions VALUES('event-a',1,'整合后的正文，不含链接。',?1)",
            [json!({"synthesis":{"blocks":[{"blockId":"b1","segments":[{"text":"整合后的正文，不含链接。","noteIds":[note_id]}],"mediaIds":[]}]}}).to_string()],
        ).unwrap();
        c.execute(
            "INSERT INTO intelligence_event_articles VALUES('event-a','source-a')",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO intelligence_articles VALUES('source-a','Example','来源标题','来源摘要','https://example.test/a','2030-01-02')",[]).unwrap();
        c.execute(
            "INSERT INTO intelligence_article_content_versions VALUES('source-a',?1,'complete',1)",
            ["a".repeat(64)],
        )
        .unwrap();
        c.execute(
            "INSERT INTO intelligence_article_paragraphs VALUES('source-a',?1,'p:one:1',?2,0)",
            params!["a".repeat(64), "b".repeat(64)],
        )
        .unwrap();
        let mut encoded_image = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 1)
            .write_to(&mut encoded_image, image::ImageFormat::WebP)
            .unwrap();
        let image_bytes = encoded_image.into_inner();
        let preview_relative = "blobs/images/sha256/ff/frozen-preview.1280.webp";
        let preview_path = root.join(preview_relative);
        std::fs::create_dir_all(preview_path.parent().unwrap()).unwrap();
        std::fs::write(&preview_path, &image_bytes).unwrap();
        c.execute(
            "INSERT INTO intelligence_article_media VALUES('source-a',?1,'image',?2,NULL,0)",
            params!["a".repeat(64), preview_relative],
        )
        .unwrap();
        let draft = build_daily_bundle_at(&path, NaiveDate::from_ymd_opt(2030, 1, 2).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(draft.bundle["events"].as_array().unwrap().len(), 1);
        assert_eq!(draft.assets.len(), 1);
        assert_eq!(draft.bundle["assets"].as_array().unwrap().len(), 1);
        assert_eq!(
            draft.bundle["events"][0]["notes"][0]["originalUrl"],
            "https://example.test/a"
        );
        assert_eq!(
            draft.bundle["events"][0]["notes"][0]["publishedAt"],
            "2030-01-02T00:00:00Z"
        );
        assert!(valid_sha256(draft.bundle["bundleSha256"].as_str().unwrap()));
        assert_eq!(
            preview_daily_bundle(&path, NaiveDate::from_ymd_opt(2030, 1, 2).unwrap()),
            DailyPreviewOutcome::Ready {
                events: 1,
                assets: 1
            }
        );
        let day = NaiveDate::from_ymd_opt(2030, 1, 2).unwrap();
        assert_eq!(
            publish_day(None, &path, day),
            PublishOutcome::PreparedLocally
        );
        let stored_sha: String = c
            .query_row(
                "SELECT bundle_sha256 FROM intelligence_daily_drafts WHERE day='2030-01-02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stored_asset_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM intelligence_daily_draft_assets WHERE day='2030-01-02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_asset_count, 1);
        // A draft created by an old workstation build can be invalid before
        // it was ever published. Rebuild only that local cache from the
        // still-present canonical event; no external receipt is changed.
        c.execute(
            "UPDATE intelligence_daily_drafts SET bundle_json='not-json',bundle_sha256=?1 WHERE day='2030-01-02'",
            ["f".repeat(64)],
        )
        .unwrap();
        assert_eq!(
            publish_day(None, &path, day),
            PublishOutcome::PreparedLocally
        );
        let repaired_sha: String = c
            .query_row(
                "SELECT bundle_sha256 FROM intelligence_daily_drafts WHERE day='2030-01-02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repaired_sha, stored_sha);
        // Some old local drafts had a valid canonical bundle but predated the
        // durable per-asset rows. They are no safer to publish than malformed
        // JSON: rebuild only while there is no external publication receipt.
        c.execute(
            "DELETE FROM intelligence_daily_draft_assets WHERE day='2030-01-02'",
            [],
        )
        .unwrap();
        assert_eq!(
            publish_day(None, &path, day),
            PublishOutcome::PreparedLocally
        );
        let repaired_asset_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM intelligence_daily_draft_assets WHERE day='2030-01-02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repaired_asset_count, 1);
        // A frozen package must remain usable even if its event/source rows
        // are later compacted or replaced.  It must not rebuild from current
        // data merely because the publisher is retried another day.
        c.execute("DELETE FROM intelligence_event_articles", [])
            .unwrap();
        c.execute("DELETE FROM intelligence_event_revisions", [])
            .unwrap();
        c.execute("DELETE FROM intelligence_events", []).unwrap();
        assert_eq!(
            publish_day(None, &path, day),
            PublishOutcome::PreparedLocally
        );
        let draft_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM intelligence_daily_drafts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let persisted_sha: String = c
            .query_row(
                "SELECT bundle_sha256 FROM intelligence_daily_drafts WHERE day='2030-01-02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(draft_count, 1);
        assert_eq!(persisted_sha, stored_sha);
        // After a publication receipt exists, the same corruption must fail
        // closed instead of rebuilding a package that may already be visible
        // to an account on another device.
        c.execute(
            "INSERT INTO intelligence_daily_publications(day,publication_id,bundle_sha256,published_at)
             VALUES('2030-01-02','daily:2030-01-02:host',?1,1)",
            [&stored_sha],
        )
        .unwrap();
        c.execute(
            "UPDATE intelligence_daily_drafts SET bundle_sha256=?1 WHERE day='2030-01-02'",
            ["e".repeat(64)],
        )
        .unwrap();
        assert_eq!(publish_day(None, &path, day), PublishOutcome::Failed);
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn canonical_timestamp_normalizes_public_feed_formats_without_guessing() {
        assert_eq!(
            canonical_timestamp("Mon, 24 Aug 2026 01:00:00 +0000").as_deref(),
            Some("2026-08-24T01:00:00Z")
        );
        assert_eq!(
            canonical_timestamp("2026-08-24").as_deref(),
            Some("2026-08-24T00:00:00Z")
        );
        assert_eq!(
            canonical_timestamp("1787312011470").as_deref(),
            Some("2026-08-21T11:33:31Z")
        );
        assert!(canonical_timestamp("not-a-publication-time").is_none());
    }
    #[test]
    fn publisher_configuration_rejects_non_https_and_empty_secret() {
        assert!(configuration_from_parts(Some("http://127.0.0.1"), Some("a")).is_none());
        assert!(configuration_from_parts(Some("https://example.test"), Some("")).is_none());
    }

    #[test]
    fn archive_links_require_public_https_without_credentials() {
        assert_eq!(
            public_https_url("https://example.test/path").as_deref(),
            Some("https://example.test/path")
        );
        assert!(public_https_url("http://example.test/path").is_none());
        assert!(public_https_url("https://user@example.test/path").is_none());
        assert!(public_https_url("https://example.test/has space").is_none());
    }
}
