//! Optional cross-device sync for AI configuration, history and credentials.
//!
//! Public configuration is intentionally separate from credentials. The sync
//! server only sees JSON for the public options and an opaque AES-GCM envelope
//! for secrets; the password is never stored locally or sent to the server.

mod downloaded_history;
mod history_materialize;
mod history_projection;
mod history_rules;
mod history_storage;
mod secret_envelope;

use self::downloaded_history::{
    merge_granular_entry, merge_legacy_library_history, merge_legacy_reader_history,
};
use self::history_materialize::store_history_projection;
use self::history_projection::{
    desired_library_history_entities, desired_reader_history_entities as desired_history_entities,
    entry_id_from_entity_id as history_entry_id_from_entity_id,
};
use self::history_rules::{
    account_history_payloads, clipped_text, history_entry_id, is_history_tombstone,
    valid_content_id,
};
use self::history_storage::{
    read_library_history, read_reader_histories, read_reader_history as read_history,
    write_library_history, write_reader_history as write_history,
};
use self::secret_envelope::{decrypt_bundle, encrypt_bundle, envelope_epoch, SecretBundle};
use crate::{ai_reader, db::AppDb, sync, translate, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
pub(crate) const READING_HANDOFF_KIND: &str = "reading_handoff_v1";
pub(crate) const NEWS_SUBSCRIPTIONS_KIND: &str = "news_subscriptions_v1";
const DEFAULT_ID: &str = "default";
const READING_HANDOFF_CONTENT_ID_KEY: &str = "private_sync_reading_handoff_content_id_v1";
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
    /// Custom RSS/Atom URLs are intentionally separate from ordinary app
    /// settings: enabling this is an explicit consent to exchange them.
    #[serde(default)]
    pub sync_news_subscriptions: bool,
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
            sync_news_subscriptions: false,
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
        READING_HANDOFF_KIND,
        NEWS_SUBSCRIPTIONS_KIND,
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
        READING_HANDOFF_KIND => Some(options.sync_progress),
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
        NEWS_SUBSCRIPTIONS_KIND => Some(options.sync_news_subscriptions),
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
        let histories = read_reader_histories(db).unwrap_or_default();
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
    if options.sync_progress {
        if let Some(content_id) = db.metadata(READING_HANDOFF_CONTENT_ID_KEY) {
            if valid_content_id(&content_id) {
                db.upsert_json_batch(&[(
                    READING_HANDOFF_KIND.to_string(),
                    DEFAULT_ID.to_string(),
                    serde_json::json!({ "version": 1, "contentId": content_id }),
                )])?;
            }
        }
    }
    if options.sync_news_subscriptions {
        crate::newsnow::append_custom_subscriptions_sync_entity(db)?;
    }
    let histories = read_reader_histories(db)?;
    let reader_history_sync_mode = reader_history_sync_mode(db);
    if reader_history_sync_mode != "off" {
        let (active, tombstones) = desired_history_entities(histories, &reader_history_sync_mode);
        store_history_projection(db, "reader:", active, &tombstones)?;
    }
    let library_sync_mode = library_history_sync_mode(db);
    if library_sync_mode != "off" {
        let (active, tombstones) =
            desired_library_history_entities(read_library_history(db), &library_sync_mode);
        store_history_projection(db, "library:", active, &tombstones)?;
    }
    Ok(())
}

pub(crate) fn append_sync_entities(db: &mut AppDb) -> Result<(), String> {
    materialize(db)
}

/// Record the portable identity of the book currently being read.  The file,
/// title, local id and path are deliberately not copied; another device can
/// offer the handoff only after the same content has been imported there.
pub(crate) fn record_reading_handoff(db: &mut AppDb, content_id: &str) -> Result<(), String> {
    if !valid_content_id(content_id) {
        return Ok(());
    }
    db.set_metadata(READING_HANDOFF_CONTENT_ID_KEY, content_id)?;
    if options_from_db(db).sync_progress {
        db.upsert_json_batch(&[(
            READING_HANDOFF_KIND.to_string(),
            DEFAULT_ID.to_string(),
            serde_json::json!({ "version": 1, "contentId": content_id }),
        )])?;
    }
    Ok(())
}

pub(crate) fn apply_downloaded_entities(
    state: &AppState,
    items: &[crate::db::SyncEntity],
) -> Result<(), String> {
    state.with_db_write("private_sync_apply_downloaded_entities", |db| {
        let options = options_from_db(db);
        for item in items {
            match item.kind.as_str() {
                READING_HANDOFF_KIND
                    if options.sync_progress && item.deleted_at == 0 && item.id == DEFAULT_ID =>
                {
                    if let Some(content_id) = item.json.get("contentId").and_then(Value::as_str) {
                        if valid_content_id(content_id) {
                            db.set_metadata(READING_HANDOFF_CONTENT_ID_KEY, content_id)?;
                        }
                    }
                }
                NEWS_SUBSCRIPTIONS_KIND
                    if options.sync_news_subscriptions
                        && item.deleted_at == 0
                        && item.id == DEFAULT_ID =>
                {
                    crate::newsnow::apply_downloaded_custom_subscriptions(db, &item.json)?;
                }
                AI_CONFIG_KIND if options.sync_configs && item.deleted_at == 0 => {
                    ai_reader::import_public_config(db, &item.json)?
                }
                HISTORY_KIND
                    if item.deleted_at == 0
                        && reader_history_sync_mode(db) != "off"
                        && valid_content_id(&item.id) =>
                {
                    let merged = merge_legacy_reader_history(
                        read_history(db, &item.id),
                        &item.json,
                        reader_history_sync_mode(db) == "manual",
                    );
                    write_history(db, &item.id, merged)?;
                }
                HISTORY_KIND
                    if item.deleted_at == 0
                        && library_history_sync_mode(db) != "off"
                        && item.id == LIBRARY_HISTORY_ID
                        && item.json.get("scope").and_then(Value::as_str) == Some("library") =>
                {
                    let merged = merge_legacy_library_history(
                        read_library_history(db),
                        &item.json,
                        library_history_sync_mode(db) == "manual",
                    );
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
                    let merged = merge_granular_entry(
                        read_history(db, content_id),
                        entry_id,
                        item.json.get("entry").cloned(),
                        item.deleted_at,
                        item.updated_at,
                        reader_history_sync_mode(db) == "manual",
                    );
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
                    let merged = merge_granular_entry(
                        read_library_history(db),
                        entry_id,
                        item.json.get("entry").cloned(),
                        item.deleted_at,
                        item.updated_at,
                        library_history_sync_mode(db) == "manual",
                    );
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
    fn handoff_is_scoped_to_progress_and_never_contains_a_local_book_id() {
        let mut db = AppDb::open_in_memory_for_tests();
        let content_id = "a".repeat(64);
        record_reading_handoff(&mut db, &content_id).unwrap();
        let payload = db
            .entity_json(READING_HANDOFF_KIND, DEFAULT_ID)
            .unwrap()
            .expect("handoff entity");
        assert_eq!(payload["contentId"], content_id);
        assert!(payload.get("bookId").is_none());
        assert!(payload.get("path").is_none());

        let disabled = PrivateSyncOptions {
            sync_progress: false,
            ..PrivateSyncOptions::default()
        };
        assert_eq!(
            entity_enabled_for_options(&disabled, READING_HANDOFF_KIND),
            Some(false)
        );
    }

    #[test]
    fn custom_subscriptions_are_default_off() {
        assert_eq!(
            entity_enabled_for_options(&PrivateSyncOptions::default(), NEWS_SUBSCRIPTIONS_KIND),
            Some(false)
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
        let normalized = history_rules::normalized_entries(entries);
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
        let normalized = history_rules::normalized_entries(vec![
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
        let entries = history_rules::normalized_library_entries(vec![serde_json::json!({
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
        let normalized = history_rules::normalized_library_entries(entries);
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
        assert_eq!(
            history_rules::normalized_library_entries(entries.clone()).len(),
            105
        );
        assert_eq!(
            history_rules::cloud_library_history_entries(entries.clone(), "recent").len(),
            HISTORY_LIVE_LIMIT
        );
        let manual = history_rules::cloud_library_history_entries(entries, "manual");
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
        let entity_id = history_projection::reader_entity_id(&content_id, "answer-1");
        let payload = active.get(&entity_id).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(payload["version"], 2);
        assert_eq!(payload["entry"]["content"], "回答");
        assert!(payload["entry"]["sources"][0].get("bookId").is_none());
        assert!(payload["entry"]["sources"][0].get("excerpt").is_none());
        assert!(tombstones.contains(&history_projection::reader_entity_id(
            &content_id,
            "answer-2"
        )));
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
