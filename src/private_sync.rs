//! Optional cross-device sync for AI configuration, history and credentials.
//!
//! Public configuration is intentionally separate from credentials. The sync
//! server only sees JSON for the public options and an opaque AES-GCM envelope
//! for secrets; the password is never stored locally or sent to the server.

use crate::{ai_reader, db::AppDb, sync, translate, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::num::NonZeroU32;
use tauri::Manager;

const OPTIONS_KEY: &str = "private_sync_options_v1";
const HISTORY_PREFIX: &str = "private_sync_ai_history_v1:";
const READER_HISTORY_SYNC_MODE_KEY: &str = "private_sync_ai_history_sync_mode_v1";
const LIBRARY_HISTORY_KEY: &str = "private_sync_library_ai_history_v1";
const LIBRARY_HISTORY_SYNC_MODE_KEY: &str = "private_sync_library_ai_history_sync_mode_v1";
const AI_CONFIG_KIND: &str = "ai_reader_config_v1";
const TRANSLATE_CONFIG_KIND: &str = "translation_config_v1";
/// Legacy aggregate arrays are read only migration input. New uploads use one
/// entity per history item so a new answer never retransmits the full list.
const HISTORY_KIND: &str = "ai_reader_history_v1";
const HISTORY_ENTRY_KIND: &str = "ai_reader_history_entry_v2";
/// A stable account-level record, intentionally not a local book id or path.
const LIBRARY_HISTORY_ID: &str = "library-v1";
const HISTORY_LIVE_LIMIT: usize = 100;
const HISTORY_TOMBSTONE_LIMIT: usize = 200;
const SECRET_KIND: &str = "secret_bundle_v1";
const DEFAULT_ID: &str = "default";
const KDF_ITERATIONS: u32 = 210_000;
const AAD: &[u8] = b"kunpeng-reader:secret_bundle_v1";
/// A local compare-and-swap generation for secret-bundle operations. It is
/// deliberately independent from the server epoch: a local reset must win
/// over an in-flight, CPU-bound password operation before it can write back.
const SECRET_BUNDLE_WRITE_GENERATION_KEY: &str = "private_sync_secret_bundle_write_generation_v1";
pub(crate) const SYNC_FILTERS_CHANGED_KEY: &str = "sync_content_filters_changed";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrivateSyncOptions {
    #[serde(default = "default_true")]
    pub sync_progress: bool,
    #[serde(default = "default_true")]
    pub sync_reading_data: bool,
    #[serde(default = "default_true")]
    pub sync_vocabulary: bool,
    #[serde(default = "default_true")]
    pub sync_statistics: bool,
    #[serde(default = "default_true")]
    pub sync_software_settings: bool,
    #[serde(default = "default_true")]
    pub sync_model_tags: bool,
    #[serde(default = "default_true")]
    pub sync_reader_palettes: bool,
    #[serde(default = "default_true")]
    pub sync_configs: bool,
    #[serde(default)]
    pub sync_ai_history: bool,
    #[serde(default)]
    pub sync_secrets: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PrivateSyncOptions {
    fn default() -> Self {
        Self {
            sync_progress: true,
            sync_reading_data: true,
            sync_vocabulary: true,
            sync_statistics: true,
            sync_software_settings: true,
            sync_model_tags: true,
            sync_reader_palettes: true,
            sync_configs: true,
            sync_ai_history: false,
            sync_secrets: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryMergeRequest {
    pub content_id: String,
    pub entries: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryDeleteRequest {
    pub content_id: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderHistorySyncModeRequest {
    pub content_id: String,
    pub sync_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderHistoryCloudRequest {
    pub content_id: String,
    pub id: String,
    pub cloud_saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderHistorySnapshot {
    pub entries: Vec<Value>,
    pub sync_enabled: bool,
    pub sync_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistoryMergeRequest {
    pub entries: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistoryDeleteRequest {
    pub id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistorySyncModeRequest {
    pub sync_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistoryCloudRequest {
    pub id: String,
    pub cloud_saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryHistorySnapshot {
    pub entries: Vec<Value>,
    pub sync_enabled: bool,
    pub sync_mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrivateSyncStatus {
    #[serde(flatten)]
    pub options: PrivateSyncOptions,
    pub cloud_secret_available: bool,
}

#[derive(PartialEq, Serialize, Deserialize)]
struct SecretBundle {
    version: u8,
    #[serde(default)]
    ai_reader: Option<Value>,
    #[serde(default)]
    translations: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedEnvelope {
    version: u8,
    #[serde(default)]
    epoch: u64,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn options_from_db(db: &AppDb) -> PrivateSyncOptions {
    db.metadata(OPTIONS_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// A disabled category is a local exchange filter, never a deletion request.
/// The corresponding entity rows are deliberately retained so enabling it
/// again can do a complete pull and recover the cloud copy.
pub(crate) fn is_entity_enabled(db: &AppDb, kind: &str) -> bool {
    let options = options_from_db(db);
    entity_enabled_for_options(&options, kind).unwrap_or(false)
}

pub(crate) fn enabled_inventory_kinds(db: &AppDb) -> Vec<&'static str> {
    const KINDS: &[&str] = &[
        "reading_progress_v1",
        "reading_data_v1",
        "reading_statistics_v1",
        "model_book_tags_v1",
        "user_book_tags_v1",
        "book_collections_v1",
        "booklist_v1",
        "vocab",
        "reading_bucket_v2",
        "ai_reader_history_entry_v2",
        "reader_palette_v1",
        "reader_palette_order_v1",
        "app_settings_v1",
    ];
    KINDS
        .iter()
        .copied()
        .filter(|kind| is_entity_enabled(db, kind))
        .collect()
}

/// Keep the exchange-category map exhaustive. A newly supported entity must
/// be assigned to a visible user choice before it can cross the network.
fn entity_enabled_for_options(options: &PrivateSyncOptions, kind: &str) -> Option<bool> {
    match kind {
        "reading_progress_v1" => Some(options.sync_progress),
        "reading_data_v1" | "user_book_tags_v1" | "book_collections_v1" | "booklist_v1" => {
            Some(options.sync_reading_data)
        }
        "vocab" => Some(options.sync_vocabulary),
        "reading_statistics_v1" | "reading_bucket_v2" => Some(options.sync_statistics),
        "app_settings_v1" => Some(options.sync_software_settings),
        "model_book_tags_v1" => Some(options.sync_model_tags),
        "reader_palette_v1" | "reader_palette_order_v1" => Some(options.sync_reader_palettes),
        AI_CONFIG_KIND | TRANSLATE_CONFIG_KIND => Some(options.sync_configs),
        HISTORY_KIND | HISTORY_ENTRY_KIND => Some(options.sync_ai_history),
        SECRET_KIND => Some(options.sync_secrets),
        // Legacy v1 monolith is retained locally only as a migration seed.
        "book_state_v2" => Some(false),
        _ => None,
    }
}
/// Per-book AI-reading history shares one account-wide cloud budget. The
/// legacy master checkbox remains the opt-out; an installation without a mode
/// key retains the former automatic-recent behaviour.
fn reader_history_sync_mode(db: &AppDb) -> String {
    if !options_from_db(db).sync_ai_history {
        return "off".into();
    }
    match db.metadata(READER_HISTORY_SYNC_MODE_KEY).as_deref() {
        Some("manual") => "manual".into(),
        _ => "recent".into(),
    }
}

fn reader_history_snapshot(db: &AppDb, content_id: &str) -> ReaderHistorySnapshot {
    let sync_mode = reader_history_sync_mode(db);
    let mut entries = read_history(db, content_id);
    if sync_mode != "off" {
        let histories = db
            .metadata_with_prefix(HISTORY_PREFIX)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(key, text)| {
                let content_id = key.strip_prefix(HISTORY_PREFIX)?;
                valid_content_id(content_id).then_some((
                    content_id.to_string(),
                    serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
                        .unwrap_or_default(),
                ))
            })
            .collect();
        let cloud_ids = account_history_payloads(histories, &sync_mode)
            .remove(content_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| !is_history_tombstone(entry))
            .filter_map(|entry| history_entry_id(&entry))
            .collect::<std::collections::BTreeSet<_>>();
        entries = entries
            .into_iter()
            .map(|mut entry| {
                if !is_history_tombstone(&entry) {
                    entry["cloudSaved"] = Value::Bool(
                        history_entry_id(&entry).is_some_and(|id| cloud_ids.contains(&id)),
                    );
                }
                entry
            })
            .collect();
    }
    ReaderHistorySnapshot {
        entries,
        sync_enabled: sync_mode != "off",
        sync_mode,
    }
}
/// The library-answer preference is independent from the per-book AI-reading
/// switch. Old installations did not have this key, so retain their former
/// behaviour until the user chooses a mode in the library-answer settings.
fn library_history_sync_mode(db: &AppDb) -> String {
    match db.metadata(LIBRARY_HISTORY_SYNC_MODE_KEY).as_deref() {
        Some("recent") => "recent".into(),
        Some("manual") => "manual".into(),
        Some("off") => "off".into(),
        _ if options_from_db(db).sync_ai_history => "recent".into(),
        _ => "off".into(),
    }
}

fn library_history_snapshot(db: &AppDb) -> LibraryHistorySnapshot {
    let sync_mode = library_history_sync_mode(db);
    LibraryHistorySnapshot {
        entries: read_library_history(db),
        sync_enabled: sync_mode != "off",
        sync_mode,
    }
}

fn history_key(content_id: &str) -> String {
    format!("{HISTORY_PREFIX}{content_id}")
}

fn valid_content_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn history_entry_id(entry: &Value) -> Option<String> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 160))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            entry
                .get("at")
                .and_then(Value::as_str)
                .map(|at| format!("legacy:{at}"))
        })
}

fn is_history_tombstone(entry: &Value) -> bool {
    entry
        .get("deletedAt")
        .or_else(|| entry.get("deleted_at"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

/// Keep live entries and per-entry tombstones together. Tombstones prevent an
/// older local history cache on another device from recreating a deleted item
/// after the next sync. They contain no answer text or source excerpt.
fn normalized_entries(entries: Vec<Value>) -> Vec<Value> {
    let mut by_id = std::collections::BTreeMap::<String, Value>::new();
    for mut entry in entries {
        if !entry.is_object()
            || !serde_json::to_string(&entry)
                .map(|value| value.len() <= 32_000)
                .unwrap_or(false)
        {
            continue;
        }
        let Some(id) = history_entry_id(&entry) else {
            continue;
        };
        if is_history_tombstone(&entry) {
            let deleted_at = entry
                .get("deletedAt")
                .or_else(|| entry.get("deleted_at"))
                .and_then(Value::as_str)
                .map(|value| clipped_text(value, 64))
                .filter(|value| !value.is_empty());
            let Some(deleted_at) = deleted_at else {
                continue;
            };
            by_id.insert(
                id.clone(),
                serde_json::json!({ "id": id, "deletedAt": deleted_at }),
            );
            continue;
        }
        entry["id"] = Value::String(id.clone());
        match by_id.get(&id) {
            Some(existing) if is_history_tombstone(existing) => {}
            _ => {
                by_id.insert(id, entry);
            }
        }
    }
    let mut live = by_id
        .values()
        .filter(|entry| !is_history_tombstone(entry))
        .cloned()
        .collect::<Vec<_>>();
    live.sort_by(|left, right| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    let mut tombstones = by_id
        .values()
        .filter(|entry| is_history_tombstone(entry))
        .cloned()
        .collect::<Vec<_>>();
    tombstones.sort_by(|left, right| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);
    live.extend(tombstones);
    live
}

fn clipped_text(value: &str, max_bytes: usize) -> String {
    let mut value = value.trim().to_string();
    while value.len() > max_bytes {
        value.pop();
    }
    value
}

/// Select the account-wide cloud subset for per-book AI-reading history.
/// Local per-book history remains available; only the latest records across
/// all books are materialized as sync entities.
fn account_history_payloads(
    histories: Vec<(String, Vec<Value>)>,
    sync_mode: &str,
) -> std::collections::BTreeMap<String, Vec<Value>> {
    let mut live = Vec::<(String, Value)>::new();
    let mut tombstones = Vec::<(String, Value)>::new();
    for (content_id, entries) in histories {
        for entry in normalized_entries(entries) {
            if is_history_tombstone(&entry) {
                tombstones.push((content_id.clone(), entry));
            } else if sync_mode == "recent"
                || entry.get("cloudSaved").and_then(Value::as_bool) == Some(true)
            {
                live.push((content_id.clone(), entry));
            }
        }
    }
    live.sort_by(|(_, left), (_, right)| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    live.truncate(HISTORY_LIVE_LIMIT);
    tombstones.sort_by(|(_, left), (_, right)| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);

    let mut grouped = std::collections::BTreeMap::<String, Vec<Value>>::new();
    for (content_id, entry) in live.into_iter().chain(tombstones) {
        grouped.entry(content_id).or_default().push(entry);
    }
    grouped
}

/// Library answers are saved as user-owned notes.  The source list deliberately
/// excludes `excerpt` and the machine-local `bookId`: a sync entity may carry
/// citations, but never book-body passages or local paths/ids.
fn normalized_library_entries(entries: Vec<Value>) -> Vec<Value> {
    let mut sanitized = Vec::new();
    for entry in entries {
        if is_history_tombstone(&entry) {
            if let Some(id) = history_entry_id(&entry) {
                if let Some(deleted_at) = entry
                    .get("deletedAt")
                    .or_else(|| entry.get("deleted_at"))
                    .and_then(Value::as_str)
                    .map(|value| clipped_text(value, 64))
                    .filter(|value| !value.is_empty())
                {
                    sanitized.push(serde_json::json!({ "id": id, "deletedAt": deleted_at }));
                }
            }
            continue;
        }
        let question = entry
            .get("question")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 4_000))
            .filter(|value| !value.is_empty());
        let content = entry
            .get("content")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 20_000))
            .filter(|value| !value.is_empty());
        let at = entry
            .get("at")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 64))
            .filter(|value| !value.is_empty());
        let (Some(question), Some(content), Some(at)) = (question, content, at) else {
            continue;
        };
        let task = entry
            .get("task")
            .and_then(Value::as_str)
            .map(|value| clipped_text(value, 32))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "question".to_string());
        let sources = entry
            .get("sources")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|source| {
                        let title = source
                            .get("bookTitle")
                            .or_else(|| source.get("book_title"))
                            .and_then(Value::as_str)
                            .map(|value| clipped_text(value, 800))
                            .filter(|value| !value.is_empty())?;
                        let chapter = source.get("chapter").and_then(Value::as_u64).unwrap_or(0);
                        let source_kind = source
                            .get("sourceKind")
                            .or_else(|| source.get("source_kind"))
                            .and_then(Value::as_str)
                            .map(|value| clipped_text(value, 120))
                            .unwrap_or_default();
                        Some(serde_json::json!({
                            "bookTitle": title,
                            "chapter": chapter,
                            "sourceKind": source_kind,
                        }))
                    })
                    .take(20)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let id = history_entry_id(&entry).unwrap_or_else(|| format!("legacy:{at}"));
        let mut normalized = serde_json::json!({
            "id": id,
            "version": 1,
            "scope": "library",
            "task": task,
            "question": question,
            "content": content,
            "sources": sources,
            "at": at,
        });
        if entry.get("cloudSaved").and_then(Value::as_bool) == Some(true) {
            normalized["cloudSaved"] = Value::Bool(true);
        }
        sanitized.push(normalized);
    }
    normalized_entries(sanitized)
}

fn sanitized_history_sources(entry: &Value) -> Vec<Value> {
    entry
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|source| {
                    let title = source
                        .get("bookTitle")
                        .or_else(|| source.get("book_title"))
                        .and_then(Value::as_str)
                        .map(|value| clipped_text(value, 800))
                        .filter(|value| !value.is_empty())?;
                    let chapter = source.get("chapter").and_then(Value::as_u64).unwrap_or(0);
                    let source_kind = source
                        .get("sourceKind")
                        .or_else(|| source.get("source_kind"))
                        .and_then(Value::as_str)
                        .map(|value| clipped_text(value, 120))
                        .unwrap_or_default();
                    let tags = source
                        .get("tags")
                        .and_then(Value::as_array)
                        .map(|tags| {
                            tags.iter()
                                .filter_map(Value::as_str)
                                .map(|tag| clipped_text(tag, 120))
                                .filter(|tag| !tag.is_empty())
                                .take(20)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(serde_json::json!({
                        "bookTitle": title,
                        "chapter": chapter,
                        "sourceKind": source_kind,
                        "tags": tags,
                    }))
                })
                .take(20)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Produce the only representation allowed to leave this device. In
/// particular, `excerpt`, local `bookId` and paths are intentionally never
/// copied from the locally retained history record.
fn sanitized_history_entry(entry: &Value, scope: &str) -> Option<Value> {
    if is_history_tombstone(entry) {
        return None;
    }
    let id = history_entry_id(entry)?;
    let content = entry
        .get("content")
        .or_else(|| entry.get("answer"))
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 20_000))
        .filter(|value| !value.is_empty())?;
    let mut sanitized = serde_json::json!({
        "id": id,
        "version": 2,
        "scope": scope,
        "content": content,
        "sources": sanitized_history_sources(entry),
    });
    if let Some(question) = entry
        .get("question")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 4_000))
        .filter(|value| !value.is_empty())
    {
        sanitized["question"] = Value::String(question);
    }
    if let Some(task) = entry
        .get("task")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 32))
        .filter(|value| !value.is_empty())
    {
        sanitized["task"] = Value::String(task);
    }
    if let Some(at) = entry
        .get("at")
        .and_then(Value::as_str)
        .map(|value| clipped_text(value, 64))
        .filter(|value| !value.is_empty())
    {
        sanitized["at"] = Value::String(at);
    }
    Some(sanitized)
}

fn reader_history_entity_id(content_id: &str, entry_id: &str) -> String {
    format!("reader:{content_id}:{entry_id}")
}

fn library_history_entity_id(entry_id: &str) -> String {
    format!("library:{entry_id}")
}

fn history_entry_id_from_entity_id(entity_id: &str, scope: &str) -> Option<String> {
    let prefix = if scope == "library" {
        "library:"
    } else {
        "reader:"
    };
    let rest = entity_id.strip_prefix(prefix)?;
    if scope == "library" {
        (!rest.is_empty()).then(|| clipped_text(rest, 160))
    } else {
        let (_, entry_id) = rest.split_once(':')?;
        (!entry_id.is_empty()).then(|| clipped_text(entry_id, 160))
    }
}

fn desired_history_entities(
    histories: Vec<(String, Vec<Value>)>,
    sync_mode: &str,
) -> (
    std::collections::BTreeMap<String, Value>,
    std::collections::BTreeSet<String>,
) {
    let mut active = std::collections::BTreeMap::new();
    let mut tombstones = std::collections::BTreeSet::new();
    for (content_id, entries) in account_history_payloads(histories, sync_mode) {
        for entry in entries {
            let Some(entry_id) = history_entry_id(&entry) else {
                continue;
            };
            let entity_id = reader_history_entity_id(&content_id, &entry_id);
            if is_history_tombstone(&entry) {
                tombstones.insert(entity_id);
            } else if let Some(entry) = sanitized_history_entry(&entry, "reader") {
                active.insert(
                    entity_id,
                    serde_json::json!({
                        "version": 2,
                        "scope": "reader",
                        "contentId": content_id,
                        "entry": entry,
                    }),
                );
            }
        }
    }
    (active, tombstones)
}

fn desired_library_history_entities(
    entries: Vec<Value>,
    sync_mode: &str,
) -> (
    std::collections::BTreeMap<String, Value>,
    std::collections::BTreeSet<String>,
) {
    let mut active = std::collections::BTreeMap::new();
    let mut tombstones = std::collections::BTreeSet::new();
    for entry in cloud_library_history_entries(entries, sync_mode) {
        let Some(entry_id) = history_entry_id(&entry) else {
            continue;
        };
        let entity_id = library_history_entity_id(&entry_id);
        if is_history_tombstone(&entry) {
            tombstones.insert(entity_id);
        } else if let Some(entry) = sanitized_history_entry(&entry, "library") {
            active.insert(
                entity_id,
                serde_json::json!({
                    "version": 2,
                    "scope": "library",
                    "entry": entry,
                }),
            );
        }
    }
    (active, tombstones)
}

fn read_history(db: &AppDb, content_id: &str) -> Vec<Value> {
    db.metadata(&history_key(content_id))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
        .map(normalized_entries)
        .unwrap_or_default()
}

fn write_history(db: &AppDb, content_id: &str, entries: Vec<Value>) -> Result<(), String> {
    db.set_metadata(
        &history_key(content_id),
        &serde_json::to_string(&serde_json::json!({
            "version": 1,
            "contentId": content_id,
            "entries": normalized_entries(entries),
        }))
        .map_err(|e| e.to_string())?,
    )
}

fn read_library_history(db: &AppDb) -> Vec<Value> {
    db.metadata(LIBRARY_HISTORY_KEY)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
        .map(normalized_library_entries)
        .unwrap_or_default()
}

fn write_library_history(db: &AppDb, entries: Vec<Value>) -> Result<(), String> {
    db.set_metadata(
        LIBRARY_HISTORY_KEY,
        &serde_json::to_string(&serde_json::json!({
            "version": 1,
            "scope": "library",
            "entries": normalized_library_entries(entries),
        }))
        .map_err(|e| e.to_string())?,
    )
}
/// A local library history may grow without a live-entry cap. Only this
/// compact projection is sent to the cloud, where it remains bounded to 100
/// answers (plus deletion tombstones). In manual mode an answer joins the
/// projection only after the user explicitly selects "云端".
fn cloud_library_history_entries(entries: Vec<Value>, sync_mode: &str) -> Vec<Value> {
    let normalized = normalized_library_entries(entries);
    let mut live = normalized
        .iter()
        .filter(|entry| !is_history_tombstone(entry))
        .filter(|entry| {
            sync_mode == "recent" || entry.get("cloudSaved").and_then(Value::as_bool) == Some(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    live.sort_by(|left, right| {
        right
            .get("at")
            .and_then(Value::as_str)
            .cmp(&left.get("at").and_then(Value::as_str))
    });
    live.truncate(HISTORY_LIVE_LIMIT);
    let mut tombstones = normalized
        .into_iter()
        .filter(is_history_tombstone)
        .collect::<Vec<_>>();
    tombstones.sort_by(|left, right| {
        right
            .get("deletedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("deletedAt").and_then(Value::as_str))
    });
    tombstones.truncate(HISTORY_TOMBSTONE_LIMIT);
    live.extend(tombstones);
    live
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    if password.chars().count() < 10 {
        return Err("同步密码至少需要 10 个字符".into());
    }
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(KDF_ITERATIONS).expect("constant is nonzero"),
        salt,
        password.as_bytes(),
        &mut key,
    );
    Ok(key)
}

fn encrypt_bundle(password: &str, bundle: &SecretBundle, epoch: u64) -> Result<Value, String> {
    if epoch == 0 {
        return Err("云端密钥包世代无效，请稍后重试".into());
    }
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rng.fill(&mut salt).map_err(|_| "无法生成加密随机数")?;
    rng.fill(&mut nonce).map_err(|_| "无法生成加密随机数")?;
    let key = derive_key(password, &salt)?;
    let unbound =
        aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "无法创建加密密钥")?;
    let key = aead::LessSafeKey::new(unbound);
    let mut ciphertext = serde_json::to_vec(bundle).map_err(|e| e.to_string())?;
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(AAD),
        &mut ciphertext,
    )
    .map_err(|_| "密钥包加密失败")?;
    serde_json::to_value(EncryptedEnvelope {
        version: 2,
        epoch,
        kdf: "PBKDF2-HMAC-SHA256/AES-256-GCM".into(),
        iterations: KDF_ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|e| e.to_string())
}

fn decrypt_bundle(password: &str, value: &Value) -> Result<SecretBundle, String> {
    let envelope: EncryptedEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| "云端密钥包格式无效")?;
    if !(envelope.version == 1 || envelope.version == 2)
        || envelope.iterations != KDF_ITERATIONS
        || envelope.kdf != "PBKDF2-HMAC-SHA256/AES-256-GCM"
    {
        return Err("云端密钥包版本不受支持".into());
    }
    let salt = STANDARD
        .decode(envelope.salt)
        .map_err(|_| "云端密钥包盐值无效")?;
    let nonce = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| "云端密钥包随机数无效")?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("云端密钥包长度无效".into());
    }
    let key = derive_key(password, &salt)?;
    let unbound =
        aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "无法创建解密密钥")?;
    let key = aead::LessSafeKey::new(unbound);
    let mut ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| "云端密钥包密文无效")?;
    let plaintext = key
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(&nonce).map_err(|_| "云端密钥包随机数无效")?,
            aead::Aad::from(AAD),
            &mut ciphertext,
        )
        .map_err(|_| "同步密码不正确，或云端密钥包已损坏")?;
    serde_json::from_slice(plaintext).map_err(|_| "云端密钥包内容无效".into())
}

fn envelope_epoch(value: &Value) -> Result<u64, String> {
    let envelope: EncryptedEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| "云端密钥包格式无效")?;
    match envelope.version {
        1 => Ok(1),
        2 if envelope.epoch > 0 => Ok(envelope.epoch),
        _ => Err("云端密钥包世代无效".into()),
    }
}

fn secret_bundle_write_generation(db: &AppDb) -> u64 {
    db.metadata(SECRET_BUNDLE_WRITE_GENERATION_KEY)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn advance_secret_bundle_write_generation(db: &AppDb) -> Result<(), String> {
    let next = secret_bundle_write_generation(db)
        .checked_add(1)
        .ok_or("本机密钥包操作世代已耗尽")?;
    db.set_metadata(SECRET_BUNDLE_WRITE_GENERATION_KEY, &next.to_string())
}

fn ensure_secret_bundle_epoch(state: &AppState, expected_epoch: u64) -> Result<(), String> {
    let actual_epoch = sync::private_secret_bundle_state(state)?.secret_bundle_epoch;
    if actual_epoch != expected_epoch {
        return Err("云端密钥包已被撤销；请重新同步后再设置或解锁".into());
    }
    Ok(())
}

fn materialize(db: &mut AppDb) -> Result<(), String> {
    let options = options_from_db(db);
    if options.sync_configs {
        let mut entities = Vec::new();
        // A malformed local API configuration must never prevent ordinary
        // reading-state sync. The user can repair it from the reader panel.
        if let Ok(Some(value)) = ai_reader::export_public_config(db) {
            entities.push((AI_CONFIG_KIND.to_string(), DEFAULT_ID.to_string(), value));
        }
        entities.push((
            TRANSLATE_CONFIG_KIND.to_string(),
            DEFAULT_ID.to_string(),
            translate::export_public_config(db)?,
        ));
        db.upsert_json_batch(&entities)?;
    }
    let stored_histories = db.metadata_with_prefix(HISTORY_PREFIX)?;
    let mut histories = Vec::new();
    for (key, text) in stored_histories {
        let Some(content_id) = key.strip_prefix(HISTORY_PREFIX) else {
            continue;
        };
        if !valid_content_id(content_id) {
            continue;
        }
        let entries = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        histories.push((content_id.to_string(), entries));
    }
    let reader_history_sync_mode = reader_history_sync_mode(db);
    if reader_history_sync_mode != "off" {
        let (active, tombstones) = desired_history_entities(histories, &reader_history_sync_mode);
        let existing = db.sync_entities_by_kind(HISTORY_ENTRY_KIND)?;
        for entity in existing
            .into_iter()
            .filter(|entity| entity.id.starts_with("reader:"))
        {
            if active.contains_key(&entity.id) {
                continue;
            }
            // A tombstone, an item no longer selected manually, or an item
            // pushed out of the 100-entry recent window must retire only this
            // individual entity.
            if entity.deleted_at == 0 || tombstones.contains(&entity.id) {
                db.soft_delete(HISTORY_ENTRY_KIND, &entity.id)?;
            }
        }
        let writes = active
            .into_iter()
            .map(|(id, payload)| (HISTORY_ENTRY_KIND.to_string(), id, payload))
            .collect::<Vec<_>>();
        db.upsert_json_batch(&writes)?;
    }
    let library_sync_mode = library_history_sync_mode(db);
    if library_sync_mode != "off" {
        let (active, tombstones) =
            desired_library_history_entities(read_library_history(db), &library_sync_mode);
        let existing = db.sync_entities_by_kind(HISTORY_ENTRY_KIND)?;
        for entity in existing
            .into_iter()
            .filter(|entity| entity.id.starts_with("library:"))
        {
            if active.contains_key(&entity.id) {
                continue;
            }
            if entity.deleted_at == 0 || tombstones.contains(&entity.id) {
                db.soft_delete(HISTORY_ENTRY_KIND, &entity.id)?;
            }
        }
        let writes = active
            .into_iter()
            .map(|(id, payload)| (HISTORY_ENTRY_KIND.to_string(), id, payload))
            .collect::<Vec<_>>();
        db.upsert_json_batch(&writes)?;
    }
    Ok(())
}

pub(crate) fn append_sync_entities(db: &mut AppDb) -> Result<(), String> {
    materialize(db)
}

pub(crate) fn apply_downloaded_entities(
    state: &AppState,
    items: &[crate::db::SyncEntity],
) -> Result<(), String> {
    state.with_db_write("private_sync_apply_downloaded_entities", |db| {
        let options = options_from_db(db);
        for item in items {
            match item.kind.as_str() {
            AI_CONFIG_KIND if options.sync_configs && item.deleted_at == 0 => {
                ai_reader::import_public_config(db, &item.json)?
            }
            HISTORY_KIND
                if item.deleted_at == 0
                    && reader_history_sync_mode(db) != "off"
                    && valid_content_id(&item.id) =>
            {
                let mut merged = read_history(db, &item.id);
                let mut cloud_ids = std::collections::BTreeSet::new();
                if let Some(remote) = item.json.get("entries").and_then(Value::as_array) {
                    cloud_ids.extend(remote.iter().filter_map(history_entry_id));
                    merged.extend(remote.iter().cloned());
                }
                if reader_history_sync_mode(db) == "manual" {
                    merged = normalized_entries(merged)
                        .into_iter()
                        .map(|mut entry| {
                            if !is_history_tombstone(&entry) {
                                entry["cloudSaved"] = Value::Bool(
                                    history_entry_id(&entry)
                                        .is_some_and(|id| cloud_ids.contains(&id)),
                                );
                            }
                            entry
                        })
                        .collect();
                }
                write_history(db, &item.id, merged)?;
            }
            HISTORY_KIND
                if item.deleted_at == 0
                    && library_history_sync_mode(db) != "off"
                    && item.id == LIBRARY_HISTORY_ID
                    && item.json.get("scope").and_then(Value::as_str) == Some("library") =>
            {
                let mut merged = read_library_history(db);
                let mut cloud_ids = std::collections::BTreeSet::new();
                if let Some(remote) = item.json.get("entries").and_then(Value::as_array) {
                    cloud_ids.extend(remote.iter().filter_map(history_entry_id));
                    merged.extend(remote.iter().cloned());
                }
                if library_history_sync_mode(db) == "manual" {
                    merged = normalized_library_entries(merged)
                        .into_iter()
                        .map(|mut entry| {
                            if !is_history_tombstone(&entry) {
                                entry["cloudSaved"] = Value::Bool(
                                    history_entry_id(&entry)
                                        .is_some_and(|id| cloud_ids.contains(&id)),
                                );
                            }
                            entry
                        })
                        .collect();
                }
                write_library_history(db, merged)?;
            }
            HISTORY_ENTRY_KIND if reader_history_sync_mode(db) != "off" => {
                let content_id = item.json.get("contentId").and_then(Value::as_str);
                let entry_id = history_entry_id_from_entity_id(&item.id, "reader");
                if item.json.get("scope").and_then(Value::as_str) != Some("reader")
                    || !content_id.is_some_and(valid_content_id)
                    || entry_id.is_none()
                {
                    continue;
                }
                let content_id = content_id.unwrap();
                let entry_id = entry_id.unwrap();
                let mut merged = read_history(db, content_id);
                if item.deleted_at != 0 {
                    merged.push(serde_json::json!({ "id": entry_id, "deletedAt": item.updated_at.to_string() }));
                } else if let Some(mut entry) = item.json.get("entry").cloned() {
                    entry["id"] = Value::String(entry_id);
                    if reader_history_sync_mode(db) == "manual" {
                        entry["cloudSaved"] = Value::Bool(true);
                    }
                    merged.push(entry);
                }
                write_history(db, content_id, merged)?;
            }
            HISTORY_ENTRY_KIND if library_history_sync_mode(db) != "off" => {
                let entry_id = history_entry_id_from_entity_id(&item.id, "library");
                if item.json.get("scope").and_then(Value::as_str) != Some("library")
                    || entry_id.is_none()
                {
                    continue;
                }
                let entry_id = entry_id.unwrap();
                let mut merged = read_library_history(db);
                if item.deleted_at != 0 {
                    merged.push(serde_json::json!({ "id": entry_id, "deletedAt": item.updated_at.to_string() }));
                } else if let Some(mut entry) = item.json.get("entry").cloned() {
                    entry["id"] = Value::String(entry_id);
                    if library_history_sync_mode(db) == "manual" {
                        entry["cloudSaved"] = Value::Bool(true);
                    }
                    merged.push(entry);
                }
                write_library_history(db, merged)?;
            }
                _ => {}
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn private_sync_get_settings(
    state: tauri::State<AppState>,
) -> Result<PrivateSyncStatus, String> {
    state.with_db_read("private_sync_get_settings", |db| {
        Ok(PrivateSyncStatus {
            options: options_from_db(db),
            cloud_secret_available: db.entity_json(SECRET_KIND, DEFAULT_ID)?.is_some(),
        })
    })
}

#[tauri::command]
pub(crate) fn private_sync_set_options(
    state: tauri::State<AppState>,
    options: PrivateSyncOptions,
) -> Result<PrivateSyncStatus, String> {
    state.with_db_write("private_sync_set_options", |db| {
        db.set_metadata(
            OPTIONS_KEY,
            &serde_json::to_string(&options).map_err(|e| e.to_string())?,
        )?;
        db.set_metadata(SYNC_FILTERS_CHANGED_KEY, "1")?;
        materialize(db)?;
        Ok(PrivateSyncStatus {
            options,
            cloud_secret_available: db.entity_json(SECRET_KIND, DEFAULT_ID)?.is_some(),
        })
    })
}

#[tauri::command]
pub(crate) fn private_sync_history_list(
    state: tauri::State<AppState>,
    content_id: String,
) -> Result<Vec<Value>, String> {
    if !valid_content_id(&content_id) {
        return Ok(Vec::new());
    }
    state.with_db_read("private_sync_history_list", |db| {
        Ok(read_history(db, &content_id))
    })
}

#[tauri::command]
pub(crate) fn private_sync_history_merge(
    state: tauri::State<AppState>,
    request: HistoryMergeRequest,
) -> Result<(), String> {
    if !valid_content_id(&request.content_id) {
        return Err("图书同步身份无效；请重新导入原书后再同步智读历史".into());
    }
    state.with_db_write("private_sync_history_merge", |db| {
        let mut merged = read_history(db, &request.content_id);
        merged.extend(request.entries);
        write_history(db, &request.content_id, merged)?;
        materialize(db)
    })
}

#[tauri::command]
pub(crate) fn private_sync_history_delete(
    state: tauri::State<AppState>,
    request: HistoryDeleteRequest,
) -> Result<Vec<Value>, String> {
    if !valid_content_id(&request.content_id) || request.id.trim().is_empty() {
        return Err("智读历史记录身份无效".into());
    }
    state.with_db_write("private_sync_history_delete", |db| {
        let mut merged = read_history(db, &request.content_id);
        merged.push(serde_json::json!({
            "id": clipped_text(&request.id, 160),
            "deletedAt": chrono::Utc::now().to_rfc3339(),
        }));
        write_history(db, &request.content_id, merged)?;
        materialize(db)?;
        Ok(read_history(db, &request.content_id))
    })
}

#[tauri::command]
pub(crate) fn private_sync_reader_history_snapshot(
    state: tauri::State<AppState>,
    content_id: String,
) -> Result<ReaderHistorySnapshot, String> {
    if !valid_content_id(&content_id) {
        return Err("图书同步身份无效；请重新导入原书后再同步智读历史".into());
    }
    state.with_db_read("private_sync_reader_history_snapshot", |db| {
        Ok(reader_history_snapshot(db, &content_id))
    })
}

#[tauri::command]
pub(crate) fn private_sync_set_reader_history_mode(
    state: tauri::State<AppState>,
    request: ReaderHistorySyncModeRequest,
) -> Result<ReaderHistorySnapshot, String> {
    if !valid_content_id(&request.content_id)
        || !matches!(request.sync_mode.as_str(), "recent" | "manual")
    {
        return Err("智读历史同步方式无效".into());
    }
    state.with_db_write("private_sync_set_reader_history_mode", |db| {
        let mut options = options_from_db(db);
        options.sync_ai_history = true;
        db.set_metadata(
            OPTIONS_KEY,
            &serde_json::to_string(&options).map_err(|error| error.to_string())?,
        )?;
        db.set_metadata(READER_HISTORY_SYNC_MODE_KEY, &request.sync_mode)?;
        materialize(db)?;
        Ok(reader_history_snapshot(db, &request.content_id))
    })
}

#[tauri::command]
pub(crate) fn private_sync_set_reader_history_cloud_saved(
    state: tauri::State<AppState>,
    request: ReaderHistoryCloudRequest,
) -> Result<ReaderHistorySnapshot, String> {
    if !valid_content_id(&request.content_id) || request.id.trim().is_empty() {
        return Err("智读历史记录身份无效".into());
    }
    state.with_db_write("private_sync_set_reader_history_cloud_saved", |db| {
        if reader_history_sync_mode(db) != "manual" {
            return Err("请先在智读历史设置中选择手动同步".into());
        }
        let id = clipped_text(&request.id, 160);
        if request.cloud_saved {
            let selected = db
                .metadata_with_prefix(HISTORY_PREFIX)?
                .into_iter()
                .flat_map(|(_, text)| {
                    serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
                        .unwrap_or_default()
                })
                .filter(|entry| !is_history_tombstone(entry))
                .filter(|entry| entry.get("cloudSaved").and_then(Value::as_bool) == Some(true))
                .filter(|entry| history_entry_id(entry).as_deref() != Some(id.as_str()))
                .count();
            if selected >= HISTORY_LIVE_LIMIT {
                return Err("智读与脑图云端共用最多 100 条记录；请先取消一条".into());
            }
        }
        let mut entries = read_history(db, &request.content_id);
        let mut found = false;
        for entry in &mut entries {
            if !is_history_tombstone(entry)
                && history_entry_id(entry).as_deref() == Some(id.as_str())
            {
                entry["cloudSaved"] = Value::Bool(request.cloud_saved);
                found = true;
                break;
            }
        }
        if !found {
            return Err("找不到这条智读记录".into());
        }
        write_history(db, &request.content_id, entries)?;
        materialize(db)?;
        Ok(reader_history_snapshot(db, &request.content_id))
    })
}

#[tauri::command]
pub(crate) fn private_sync_library_history_list(
    state: tauri::State<AppState>,
) -> Result<LibraryHistorySnapshot, String> {
    state.with_db_read("private_sync_library_history_list", |db| {
        Ok(library_history_snapshot(db))
    })
}
#[tauri::command]
pub(crate) fn private_sync_set_library_history_mode(
    state: tauri::State<AppState>,
    request: LibraryHistorySyncModeRequest,
) -> Result<LibraryHistorySnapshot, String> {
    if !matches!(request.sync_mode.as_str(), "off" | "recent" | "manual") {
        return Err("书库问答同步方式无效".into());
    }
    state.with_db_write("private_sync_set_library_history_mode", |db| {
        db.set_metadata(LIBRARY_HISTORY_SYNC_MODE_KEY, &request.sync_mode)?;
        materialize(db)?;
        Ok(library_history_snapshot(db))
    })
}

#[tauri::command]
pub(crate) fn private_sync_library_history_merge(
    state: tauri::State<AppState>,
    request: LibraryHistoryMergeRequest,
) -> Result<LibraryHistorySnapshot, String> {
    state.with_db_write("private_sync_library_history_merge", |db| {
        let mut merged = read_library_history(db);
        merged.extend(request.entries);
        write_library_history(db, merged)?;
        materialize(db)?;
        Ok(library_history_snapshot(db))
    })
}
#[tauri::command]
pub(crate) fn private_sync_set_library_history_cloud_saved(
    state: tauri::State<AppState>,
    request: LibraryHistoryCloudRequest,
) -> Result<LibraryHistorySnapshot, String> {
    if request.id.trim().is_empty() {
        return Err("书库问答记录身份无效".into());
    }
    state.with_db_write("private_sync_set_library_history_cloud_saved", |db| {
        if library_history_sync_mode(db) != "manual" {
            return Err("请先在书库问答设置中选择手动同步".into());
        }
        let id = clipped_text(&request.id, 160);
        let mut entries = read_library_history(db);
        if request.cloud_saved {
            let selected = entries
                .iter()
                .filter(|entry| !is_history_tombstone(entry))
                .filter(|entry| entry.get("cloudSaved").and_then(Value::as_bool) == Some(true))
                .filter(|entry| history_entry_id(entry).as_deref() != Some(id.as_str()))
                .count();
            if selected >= HISTORY_LIVE_LIMIT {
                return Err("云端最多保留 100 条问答；请先取消一条云端记录".into());
            }
        }
        let mut found = false;
        for entry in &mut entries {
            if !is_history_tombstone(entry)
                && history_entry_id(entry).as_deref() == Some(id.as_str())
            {
                entry["cloudSaved"] = Value::Bool(request.cloud_saved);
                found = true;
                break;
            }
        }
        if !found {
            return Err("找不到这条书库问答记录".into());
        }
        write_library_history(db, entries)?;
        materialize(db)?;
        Ok(library_history_snapshot(db))
    })
}

#[tauri::command]
pub(crate) fn private_sync_library_history_delete(
    state: tauri::State<AppState>,
    request: LibraryHistoryDeleteRequest,
) -> Result<LibraryHistorySnapshot, String> {
    if request.id.trim().is_empty() {
        return Err("书库问答记录身份无效".into());
    }
    state.with_db_write("private_sync_library_history_delete", |db| {
        let mut merged = read_library_history(db);
        merged.push(serde_json::json!({
            "id": clipped_text(&request.id, 160),
            "deletedAt": chrono::Utc::now().to_rfc3339(),
        }));
        write_library_history(db, merged)?;
        materialize(db)?;
        Ok(library_history_snapshot(db))
    })
}

#[tauri::command]
pub(crate) async fn private_sync_set_password(
    app: tauri::AppHandle,
    password: String,
) -> Result<PrivateSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let epoch = sync::private_secret_bundle_state(state.inner())?.secret_bundle_epoch;
        let (bundle, write_generation) =
            state.with_db_read("private_sync_set_password.read", |db| {
                Ok((
                    SecretBundle {
                        version: 1,
                        ai_reader: ai_reader::export_secret_config(db)?,
                        translations: translate::export_secret_configs(db)?,
                    },
                    secret_bundle_write_generation(db),
                ))
            })?;
        if bundle.ai_reader.is_none() && bundle.translations.is_empty() {
            return Err("本机还没有可同步的智读或翻译密钥".into());
        }
        // PBKDF2 and AES-GCM intentionally run after with_db_read has dropped
        // the sole SQLite mutex.
        let encrypted = encrypt_bundle(&password, &bundle, epoch)?;
        ensure_secret_bundle_epoch(state.inner(), epoch)?;
        state.with_db_write("private_sync_set_password.write", |db| {
            if secret_bundle_write_generation(db) != write_generation {
                return Err("本机密钥包状态已变化，请重新设置同步密码".into());
            }
            let current_bundle = SecretBundle {
                version: 1,
                ai_reader: ai_reader::export_secret_config(db)?,
                translations: translate::export_secret_configs(db)?,
            };
            if current_bundle != bundle {
                return Err("本机密钥配置已变化，请重新设置同步密码".into());
            }
            db.upsert_json_batch(&[(SECRET_KIND.to_string(), DEFAULT_ID.to_string(), encrypted)])?;
            let mut options = options_from_db(db);
            options.sync_secrets = true;
            db.set_metadata(
                OPTIONS_KEY,
                &serde_json::to_string(&options).map_err(|e| e.to_string())?,
            )?;
            db.set_metadata(SYNC_FILTERS_CHANGED_KEY, "1")?;
            advance_secret_bundle_write_generation(db)?;
            Ok(PrivateSyncStatus {
                options,
                cloud_secret_available: true,
            })
        })
    })
    .await
    .map_err(|e| format!("加密密钥任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn private_sync_unlock_secrets(
    app: tauri::AppHandle,
    password: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let expected_epoch = sync::private_secret_bundle_state(state.inner())?.secret_bundle_epoch;
        let (value, write_generation) =
            state.with_db_read("private_sync_unlock_secrets.read", |db| {
                let value = db
                    .entity_json(SECRET_KIND, DEFAULT_ID)?
                    .ok_or("云端没有可解锁的密钥包；请先同步或在拥有密钥的设备重新加密")?;
                if envelope_epoch(&value)? != expected_epoch {
                    return Err(
                        "云端密钥包已被撤销；请在拥有 API Key 的设备重新设置同步密码".into(),
                    );
                }
                Ok((value, secret_bundle_write_generation(db)))
            })?;
        // PBKDF2 and AES-GCM intentionally run after with_db_read has dropped
        // the sole SQLite mutex.
        let bundle = decrypt_bundle(&password, &value)?;
        ensure_secret_bundle_epoch(state.inner(), expected_epoch)?;
        state.with_db_write("private_sync_unlock_secrets.write", |db| {
            if secret_bundle_write_generation(db) != write_generation {
                return Err("本机密钥包状态已变化，请重新同步后再解锁".into());
            }
            let current = db
                .entity_json(SECRET_KIND, DEFAULT_ID)?
                .ok_or("云端没有可解锁的密钥包；请先同步或在拥有密钥的设备重新加密")?;
            if current != value || envelope_epoch(&current)? != expected_epoch {
                return Err("本机密钥包状态已变化，请重新同步后再解锁".into());
            }
            if let Some(config) = bundle.ai_reader {
                ai_reader::import_secret_config(db, &config)?;
            }
            translate::import_secret_configs(db, &bundle.translations)
        })
    })
    .await
    .map_err(|e| format!("解锁密钥任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn private_sync_forget_password(
    app: tauri::AppHandle,
) -> Result<PrivateSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _state = sync::reset_private_secret_bundle_state(state.inner())?;
        state.with_db_write("private_sync_forget_password.write", |db| {
            db.soft_delete(SECRET_KIND, DEFAULT_ID)?;
            let mut options = options_from_db(db);
            options.sync_secrets = false;
            db.set_metadata(
                OPTIONS_KEY,
                &serde_json::to_string(&options).map_err(|e| e.to_string())?,
            )?;
            db.set_metadata(SYNC_FILTERS_CHANGED_KEY, "1")?;
            advance_secret_bundle_write_generation(db)?;
            Ok(PrivateSyncStatus {
                options,
                cloud_secret_available: false,
            })
        })
    })
    .await
    .map_err(|e| format!("撤销云端密钥任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_entity_has_an_explicit_visible_sync_category() {
        let options = PrivateSyncOptions::default();
        for kind in crate::db::SUPPORTED_ENTITY_KINDS {
            assert!(
                entity_enabled_for_options(&options, kind).is_some(),
                "supported entity {kind} is missing from the sync-content choices"
            );
        }
    }

    #[test]
    fn booklist_metadata_uses_the_reading_data_choice() {
        let mut options = PrivateSyncOptions {
            sync_reading_data: false,
            ..Default::default()
        };
        for kind in [
            "reading_data_v1",
            "user_book_tags_v1",
            "book_collections_v1",
            "booklist_v1",
        ] {
            assert_eq!(entity_enabled_for_options(&options, kind), Some(false));
        }
        options.sync_reading_data = true;
        assert_eq!(
            entity_enabled_for_options(&options, "booklist_v1"),
            Some(true)
        );
    }

    #[test]
    fn secret_bundle_is_unreadable_without_the_sync_password() {
        let bundle = SecretBundle {
            version: 1,
            ai_reader: Some(serde_json::json!({"api_key":"secret"})),
            translations: vec![],
        };
        let encrypted = encrypt_bundle("a long enough sync password", &bundle, 1).unwrap();
        assert!(encrypted.get("ciphertext").is_some());
        assert!(decrypt_bundle("wrong long password", &encrypted).is_err());
        let opened = decrypt_bundle("a long enough sync password", &encrypted).unwrap();
        assert_eq!(opened.ai_reader.unwrap()["api_key"], "secret");
    }

    #[test]
    fn local_history_deduplicates_without_a_live_entry_cap() {
        let entries = (0..105)
            .map(|i| serde_json::json!({"at": format!("2026-07-29T{i:03}:00:00Z"), "question": "q", "content": i}))
            .collect::<Vec<_>>();
        let normalized = normalized_entries(entries);
        assert_eq!(normalized.len(), 105);
        assert!(valid_content_id(&"a".repeat(64)));
    }

    #[test]
    fn reader_cloud_history_is_bounded_across_books() {
        let histories = (0..3)
            .map(|book| {
                let entries = (0..45)
                    .map(|index| {
                        let rank = book * 45 + index;
                        serde_json::json!({
                            "id": format!("reader:{book}:{index}"),
                            "at": format!("2026-08-{rank:03}T00:00:00Z"),
                            "question": "q",
                            "content": "answer"
                        })
                    })
                    .collect::<Vec<_>>();
                (format!("{book:064x}"), entries)
            })
            .collect::<Vec<_>>();
        let payloads = account_history_payloads(histories, "recent");
        assert_eq!(
            payloads.values().map(Vec::len).sum::<usize>(),
            HISTORY_LIVE_LIMIT
        );
        assert!(payloads
            .values()
            .flatten()
            .any(|entry| entry["id"] == "reader:2:44"));
        assert!(!payloads
            .values()
            .flatten()
            .any(|entry| entry["id"] == "reader:0:0"));
    }

    #[test]
    fn reader_manual_cloud_history_is_bounded_across_tasks_and_books() {
        let histories = vec![
            (
                "a".repeat(64),
                vec![
                    serde_json::json!({"id":"question", "at":"2026-08-01T00:00:00Z", "question":"q", "content":"a", "task":"question", "cloudSaved":true}),
                    serde_json::json!({"id":"summary", "at":"2026-08-02T00:00:00Z", "question":"s", "content":"a", "task":"summary", "cloudSaved":true}),
                ],
            ),
            (
                "b".repeat(64),
                vec![
                    serde_json::json!({"id":"mindmap", "at":"2026-08-03T00:00:00Z", "question":"m", "content":"a", "task":"mindmap", "cloudSaved":true}),
                    serde_json::json!({"id":"local", "at":"2026-08-04T00:00:00Z", "question":"l", "content":"a", "task":"question"}),
                ],
            ),
        ];
        let payloads = account_history_payloads(histories, "manual");
        let ids = payloads
            .values()
            .flatten()
            .filter_map(history_entry_id)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            ids,
            std::collections::BTreeSet::from([
                "mindmap".to_string(),
                "question".to_string(),
                "summary".to_string(),
            ])
        );
    }

    #[test]
    fn history_tombstone_wins_over_a_live_entry_with_the_same_id() {
        let normalized = normalized_entries(vec![
            serde_json::json!({
                "id": "reader:one",
                "at": "2026-08-05T00:00:00Z",
                "question": "旧问题",
                "content": "旧回答"
            }),
            serde_json::json!({
                "id": "reader:one",
                "deletedAt": "2026-08-05T01:00:00Z"
            }),
        ]);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["id"], "reader:one");
        assert_eq!(normalized[0]["deletedAt"], "2026-08-05T01:00:00Z");
        assert!(normalized[0].get("content").is_none());
    }

    #[test]
    fn library_history_keeps_answer_and_reference_but_never_book_text_or_local_id() {
        let entries = normalized_library_entries(vec![serde_json::json!({
            "question": "《南明史》说了什么？",
            "content": "保存的回答。",
            "task": "question",
            "at": "2026-08-05T00:00:00Z",
            "sources": [{
                "bookId": "machine-local-book-id",
                "bookTitle": "南明史",
                "chapter": 7,
                "sourceKind": "正文检索",
                "excerpt": "这段书籍正文绝不能进入同步实体"
            }]
        })]);
        assert_eq!(entries.len(), 1);
        let source = &entries[0]["sources"][0];
        assert_eq!(source["bookTitle"], "南明史");
        assert_eq!(source["chapter"], 7);
        assert!(source.get("bookId").is_none());
        assert!(source.get("excerpt").is_none());
        assert_eq!(entries[0]["id"], "legacy:2026-08-05T00:00:00Z");
        assert_eq!(entries[0]["scope"], "library");
    }

    #[test]
    fn library_history_stays_local_without_a_live_entry_cap() {
        let entries = (0..105)
            .map(|index| {
                serde_json::json!({
                    "question": format!("q-{index}"),
                    "content": "answer",
                    "at": format!("2026-08-{index:03}T00:00:00Z"),
                    "sources": []
                })
            })
            .collect::<Vec<_>>();
        let normalized = normalized_library_entries(entries);
        assert_eq!(normalized.len(), 105);
        assert_eq!(normalized[0]["question"], "q-104");
    }

    #[test]
    fn library_cloud_projection_is_bounded_but_local_history_is_not() {
        let entries = (0..105)
            .map(|index| {
                serde_json::json!({
                    "id": format!("library:{index}"),
                    "question": format!("q-{index}"),
                    "content": "answer",
                    "at": format!("2026-08-{index:03}T00:00:00Z"),
                    "cloudSaved": index % 2 == 0,
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(normalized_library_entries(entries.clone()).len(), 105);
        assert_eq!(
            cloud_library_history_entries(entries.clone(), "recent").len(),
            HISTORY_LIVE_LIMIT
        );
        let manual = cloud_library_history_entries(entries, "manual");
        assert_eq!(manual.len(), 53);
        assert!(manual.iter().all(|entry| entry["cloudSaved"] == true));
    }
    #[test]
    fn history_retention_contract_matches_runtime_constants() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/ai-reader-history-retention.v1.json"
        ))
        .unwrap();
        assert_eq!(
            fixture["policy"]["aiReaderLivePerAccount"],
            HISTORY_LIVE_LIMIT
        );
        assert_eq!(
            fixture["policy"]["libraryLivePerAccount"],
            HISTORY_LIVE_LIMIT
        );
        assert_eq!(
            fixture["policy"]["tombstonesPerCategory"],
            HISTORY_TOMBSTONE_LIMIT
        );
        assert_eq!(fixture["policy"]["localLiveEntries"], "unbounded");
        assert_eq!(
            fixture["policy"]["manualCloudSelectionMax"],
            HISTORY_LIVE_LIMIT
        );
    }

    #[test]
    fn reader_history_projection_is_one_sanitized_entity_per_entry() {
        let content_id = "a".repeat(64);
        let (active, tombstones) = desired_history_entities(
            vec![(
                content_id.clone(),
                vec![
                    serde_json::json!({
                        "id": "answer-1", "question": "问题", "content": "回答",
                        "at": "2026-08-09T12:00:00Z",
                        "sources": [{
                            "bookId": "local-only", "bookTitle": "测试书", "chapter": 3,
                            "sourceKind": "正文", "excerpt": "不能上传的正文"
                        }]
                    }),
                    serde_json::json!({ "id": "answer-2", "deletedAt": "2026-08-09T12:01:00Z" }),
                ],
            )],
            "recent",
        );
        let entity_id = reader_history_entity_id(&content_id, "answer-1");
        let payload = active.get(&entity_id).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(payload["version"], 2);
        assert_eq!(payload["entry"]["content"], "回答");
        assert!(payload["entry"]["sources"][0].get("bookId").is_none());
        assert!(payload["entry"]["sources"][0].get("excerpt").is_none());
        assert!(tombstones.contains(&reader_history_entity_id(&content_id, "answer-2")));
    }

    #[test]
    fn history_entry_fixture_matches_protocol_three() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../contracts/fixtures/ai-reader-history-entry.v2.json"
        ))
        .unwrap();
        assert_eq!(fixture["syncProtocolVersion"], 3);
        assert_eq!(fixture["kind"], HISTORY_ENTRY_KIND);
        assert_eq!(
            fixture["policy"]["readerLivePerAccount"],
            HISTORY_LIVE_LIMIT
        );
        assert_eq!(
            fixture["policy"]["tombstonesPerScope"],
            HISTORY_TOMBSTONE_LIMIT
        );
    }
}
