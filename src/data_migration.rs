use crate::{book, vocab, AppState};
use reader_core::stats::ReadBucket;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(crate) const BOOK_STATE_KIND_V2: &str = "book_state_v2";
/// Protocol v2 splits the former monolithic book_state_v2 so each user-facing
/// category can be selected independently in sync settings.
pub(crate) const READING_PROGRESS_KIND_V1: &str = "reading_progress_v1";
pub(crate) const READING_DATA_KIND_V1: &str = "reading_data_v1";
pub(crate) const READING_STATISTICS_KIND_V1: &str = "reading_statistics_v1";
pub(crate) const MODEL_BOOK_TAGS_KIND_V1: &str = "model_book_tags_v1";
pub(crate) const USER_BOOK_TAGS_KIND_V1: &str = "user_book_tags_v1";
pub(crate) const BOOK_COLLECTIONS_KIND_V1: &str = "book_collections_v1";
const ENTITY_MODEL_VERSION_KEY: &str = "entity_model_version";
const ENTITY_MODEL_VERSION: &str = "3";

/// Cross-device state for one book. Machine-local paths and cover-cache paths
/// never leave the device; the full file hash is the stable identity.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BookSyncStateV2 {
    #[serde(default = "book_state_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    fingerprint: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    last_read_at: u64,
    #[serde(default)]
    progress: f32,
    #[serde(default)]
    resume_chapter: u32,
    #[serde(default)]
    resume_frac: f32,
    #[serde(default)]
    resume_position: Option<reader_core::ReadingPosition>,
    #[serde(default)]
    chapter_index_version: u32,
    #[serde(default)]
    bookmarks: Vec<book::Bookmark>,
    #[serde(default)]
    highlights: Vec<book::Highlight>,
    #[serde(default)]
    reading_seconds: u64,
    #[serde(default)]
    words_read: u64,
    #[serde(default)]
    finished_at: u64,
    #[serde(default)]
    rating: f32,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    collections: Vec<String>,
    #[serde(default)]
    progress_history: Vec<book::ProgressTimelineEntry>,
}

fn book_state_schema_version() -> u32 {
    4
}

#[derive(Clone, Serialize, Deserialize)]
struct PortableReadBucketV2 {
    day: u32,
    hour: u8,
    content_id: String,
    secs: u32,
    words: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct ReadingProgressV1 {
    #[serde(default = "organization_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    last_read_at: u64,
    #[serde(default)]
    progress: f32,
    #[serde(default)]
    resume_chapter: u32,
    #[serde(default)]
    resume_frac: f32,
    #[serde(default)]
    resume_position: Option<reader_core::ReadingPosition>,
    #[serde(default)]
    chapter_index_version: u32,
    #[serde(default)]
    progress_history: Vec<book::ProgressTimelineEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ReadingDataV1 {
    #[serde(default = "organization_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    bookmarks: Vec<book::Bookmark>,
    #[serde(default)]
    highlights: Vec<book::Highlight>,
    #[serde(default)]
    rating: f32,
}

#[derive(Clone, Serialize, Deserialize)]
struct ReadingStatisticsV1 {
    #[serde(default = "organization_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    reading_seconds: u64,
    #[serde(default)]
    words_read: u64,
    #[serde(default)]
    finished_at: u64,
}

/// Sync model-derived labels in an independent entity. This keeps old clients
/// from rewriting an entire book state without fields they do not yet know,
/// and never conflates the reader's own `tags` with automatic classification.
#[derive(Clone, Serialize, Deserialize)]
struct ModelBookTagsV1 {
    #[serde(default = "model_book_tags_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn model_book_tags_schema_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize)]
struct UserBookTagsV1 {
    #[serde(default = "organization_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BookCollectionsV1 {
    #[serde(default = "organization_schema_version")]
    schema_version: u32,
    content_id: String,
    #[serde(default)]
    collections: Vec<String>,
}

fn organization_schema_version() -> u32 {
    1
}

impl UserBookTagsV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            tags: book.tags.clone(),
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        if self.content_id == target.content_id {
            target.tags = book::normalize_organization_names(self.tags.clone());
        }
    }
}

impl BookCollectionsV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            collections: book.collections.clone(),
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        if self.content_id == target.content_id {
            target.collections = book::normalize_organization_names(self.collections.clone());
        }
    }
}

impl ModelBookTagsV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            tags: book.model_tags.clone(),
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        if self.content_id == target.content_id {
            target.model_tags = self.tags.clone();
        }
    }
}

#[allow(dead_code)] // v2 rows remain readable only as an upgrade fallback.
impl BookSyncStateV2 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 4,
            content_id: book.content_id.clone(),
            fingerprint: book.fingerprint,
            title: book.title.clone(),
            author: book.author.clone(),
            description: book.description.clone(),
            format: book.format.clone(),
            last_read_at: book.last_read_at,
            progress: book.progress,
            resume_chapter: book.resume_chapter,
            resume_frac: book.resume_frac,
            resume_position: book.resume_position.clone(),
            chapter_index_version: book.chapter_index_version,
            bookmarks: book.bookmarks.clone(),
            highlights: book.highlights.clone(),
            reading_seconds: book.reading_seconds,
            words_read: book.words_read,
            finished_at: book.finished_at,
            rating: book.rating,
            tags: book.tags.clone(),
            collections: book.collections.clone(),
            progress_history: book.progress_history.clone(),
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        // Keep the local id/path/cover and imported file metadata. Only portable
        // reading state is authoritative across devices.
        if !self.title.trim().is_empty() {
            target.title = self.title.clone();
        }
        if !self.author.trim().is_empty() {
            target.author = self.author.clone();
        }
        if !self.description.trim().is_empty() {
            target.description = self.description.clone();
        }
        target.last_read_at = self.last_read_at;
        target.progress = self.progress.clamp(0.0, 100.0);
        target.resume_chapter = self.resume_chapter;
        target.resume_frac = self.resume_frac.clamp(0.0, 1.0);
        target.resume_position = self
            .resume_position
            .clone()
            .map(reader_core::ReadingPosition::normalized);
        target.chapter_index_version = self.chapter_index_version;
        target.bookmarks = self.bookmarks.clone();
        target.highlights = self.highlights.clone();
        target.reading_seconds = self.reading_seconds;
        target.words_read = self.words_read;
        target.finished_at = self.finished_at;
        target.rating = self.rating.clamp(0.0, 5.0);
        book::merge_daily_progress_history(&mut target.progress_history, &self.progress_history);
    }

    fn apply_legacy_organization_to_book(
        &self,
        target: &mut book::Book,
        apply_tags: bool,
        apply_collections: bool,
    ) {
        if apply_tags {
            target.tags = book::normalize_organization_names(self.tags.clone());
        }
        if apply_collections {
            target.collections = book::normalize_organization_names(self.collections.clone());
        }
    }

    fn merge_into_book(&self, target: &mut book::Book) {
        if self.last_read_at > target.last_read_at
            || (self.last_read_at == target.last_read_at && self.progress > target.progress)
        {
            target.last_read_at = self.last_read_at;
            target.progress = self.progress.clamp(0.0, 100.0);
            target.resume_chapter = self.resume_chapter;
            target.resume_frac = self.resume_frac.clamp(0.0, 1.0);
            target.resume_position = self
                .resume_position
                .clone()
                .map(reader_core::ReadingPosition::normalized);
            target.chapter_index_version = self.chapter_index_version;
        }
        if target.title.trim().is_empty() && !self.title.trim().is_empty() {
            target.title = self.title.clone();
        }
        if target.author.trim().is_empty() && !self.author.trim().is_empty() {
            target.author = self.author.clone();
        }
        if target.description.trim().is_empty() && !self.description.trim().is_empty() {
            target.description = self.description.clone();
        }
        merge_unique_json(&mut target.bookmarks, &self.bookmarks);
        merge_unique_json(&mut target.highlights, &self.highlights);
        target.reading_seconds = target.reading_seconds.max(self.reading_seconds);
        target.words_read = target.words_read.max(self.words_read);
        target.finished_at = match (target.finished_at, self.finished_at) {
            (0, remote) => remote,
            (local, 0) => local,
            (local, remote) => local.min(remote),
        };
        if target.rating == 0.0 && self.rating > 0.0 {
            target.rating = self.rating.clamp(0.0, 5.0);
        }
        if target.tags.is_empty() && !self.tags.is_empty() {
            target.tags = self.tags.clone();
        }
        if target.collections.is_empty() && !self.collections.is_empty() {
            target.collections = self.collections.clone();
        }
        book::merge_daily_progress_history(&mut target.progress_history, &self.progress_history);
    }
}

impl ReadingProgressV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            last_read_at: book.last_read_at,
            progress: book.progress,
            resume_chapter: book.resume_chapter,
            resume_frac: book.resume_frac,
            resume_position: book.resume_position.clone(),
            chapter_index_version: book.chapter_index_version,
            progress_history: book.progress_history.clone(),
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        target.last_read_at = self.last_read_at;
        target.progress = self.progress.clamp(0.0, 100.0);
        target.resume_chapter = self.resume_chapter;
        target.resume_frac = self.resume_frac.clamp(0.0, 1.0);
        target.resume_position = self
            .resume_position
            .clone()
            .map(reader_core::ReadingPosition::normalized);
        target.chapter_index_version = self.chapter_index_version;
        book::merge_daily_progress_history(&mut target.progress_history, &self.progress_history);
    }

    fn merge_into_book(&self, target: &mut book::Book) {
        if self.last_read_at > target.last_read_at
            || (self.last_read_at == target.last_read_at && self.progress > target.progress)
        {
            self.apply_to_book(target);
        } else {
            book::merge_daily_progress_history(
                &mut target.progress_history,
                &self.progress_history,
            );
        }
    }
}

impl ReadingDataV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            bookmarks: book.bookmarks.clone(),
            highlights: book.highlights.clone(),
            rating: book.rating,
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        target.bookmarks = self.bookmarks.clone();
        target.highlights = self.highlights.clone();
        target.rating = self.rating.clamp(0.0, 5.0);
    }

    fn merge_into_book(&self, target: &mut book::Book) {
        merge_unique_json(&mut target.bookmarks, &self.bookmarks);
        merge_unique_json(&mut target.highlights, &self.highlights);
        if target.rating == 0.0 && self.rating > 0.0 {
            target.rating = self.rating.clamp(0.0, 5.0);
        }
    }
}

impl ReadingStatisticsV1 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 1,
            content_id: book.content_id.clone(),
            reading_seconds: book.reading_seconds,
            words_read: book.words_read,
            finished_at: book.finished_at,
        }
    }

    fn apply_to_book(&self, target: &mut book::Book) {
        target.reading_seconds = self.reading_seconds;
        target.words_read = self.words_read;
        target.finished_at = self.finished_at;
    }

    fn merge_into_book(&self, target: &mut book::Book) {
        target.reading_seconds = target.reading_seconds.max(self.reading_seconds);
        target.words_read = target.words_read.max(self.words_read);
        target.finished_at = match (target.finished_at, self.finished_at) {
            (0, remote) => remote,
            (local, 0) => local,
            (local, remote) => local.min(remote),
        };
    }
}

fn merge_unique_json<T>(target: &mut Vec<T>, incoming: &[T])
where
    T: Clone + Serialize,
{
    let mut known = target
        .iter()
        .filter_map(|value| serde_json::to_string(value).ok())
        .collect::<std::collections::HashSet<_>>();
    for value in incoming {
        if let Ok(key) = serde_json::to_string(value) {
            if known.insert(key) {
                target.push(value.clone());
            }
        }
    }
}

/// Merge portable book fields before entity-level LWW is applied. This avoids
/// a freshly imported zero-progress book overwriting an older remote position.
pub(crate) fn merge_pulled_book_states(
    state: &AppState,
    items: &[crate::db::SyncEntity],
) -> Result<(), String> {
    let progress = items
        .iter()
        .filter(|item| item.kind == READING_PROGRESS_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<ReadingProgressV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    let reading_data = items
        .iter()
        .filter(|item| item.kind == READING_DATA_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<ReadingDataV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    let statistics = items
        .iter()
        .filter(|item| item.kind == READING_STATISTICS_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<ReadingStatisticsV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    let model_tags = items
        .iter()
        .filter(|item| item.kind == MODEL_BOOK_TAGS_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<ModelBookTagsV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    if progress.is_empty()
        && reading_data.is_empty()
        && statistics.is_empty()
        && model_tags.is_empty()
    {
        return Ok(());
    }
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    for remote in progress {
        if let Some(local) = lib
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in reading_data {
        if let Some(local) = lib
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in statistics {
        if let Some(local) = lib
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in model_tags {
        if let Some(local) = lib
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    lib.save()
}

/// Manual sync may run before the delayed background migration. Hash missing
/// files outside the library lock so the UI remains responsive.
pub(crate) fn ensure_content_ids_for_sync(state: &AppState) -> Result<(), String> {
    let pending = {
        let lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        lib.books
            .iter()
            .filter(|book| book.content_id.is_empty() && book.path.is_file())
            .map(|book| (book.id, book.path.clone()))
            .collect::<Vec<_>>()
    };
    if pending.is_empty() {
        return Ok(());
    }
    let hashes = pending
        .into_iter()
        .map(|(id, path)| (id, book::compute_content_id(&path)))
        .filter(|(_, hash)| !hash.is_empty())
        .collect::<Vec<_>>();
    if hashes.is_empty() {
        return Ok(());
    }
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    for (id, hash) in hashes {
        lib.set_content_id(id, hash);
    }
    lib.save()
}

pub(crate) fn migrate_json_to_sqlite(state: &AppState) -> Result<(), String> {
    let books = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?
        .books
        .clone();
    let vocab_snapshot = state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())?
        .list
        .clone();
    let stats = state.stats.lock().map_err(|_| "统计锁定失败".to_string())?;
    let stats_snapshot: Vec<ReadBucket> = stats
        .map
        .iter()
        .map(|(&(day, hour, book), &(secs, words))| ReadBucket {
            day,
            hour,
            book,
            secs,
            words,
        })
        .collect();
    drop(stats);

    let content_ids_by_local_book: HashMap<u64, String> = books
        .iter()
        .filter(|book| !book.content_id.is_empty())
        .map(|book| (book.id, book.content_id.clone()))
        .collect();
    let mut batch = Vec::new();
    let mut organization_seeds = Vec::new();
    for book in &books {
        if !book.content_id.is_empty() {
            batch.push((
                READING_PROGRESS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(ReadingProgressV1::from_book(book))
                    .map_err(|e| e.to_string())?,
            ));
            batch.push((
                READING_DATA_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(ReadingDataV1::from_book(book)).map_err(|e| e.to_string())?,
            ));
            batch.push((
                READING_STATISTICS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(ReadingStatisticsV1::from_book(book))
                    .map_err(|e| e.to_string())?,
            ));
        }
        if !book.content_id.is_empty() && !book.model_tags.is_empty() {
            batch.push((
                MODEL_BOOK_TAGS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(ModelBookTagsV1::from_book(book))
                    .map_err(|e| e.to_string())?,
            ));
        }
        if !book.content_id.is_empty() && !book.tags.is_empty() {
            organization_seeds.push((
                USER_BOOK_TAGS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(UserBookTagsV1::from_book(book)).map_err(|e| e.to_string())?,
            ));
        }
        if !book.content_id.is_empty() && !book.collections.is_empty() {
            organization_seeds.push((
                BOOK_COLLECTIONS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(BookCollectionsV1::from_book(book))
                    .map_err(|e| e.to_string())?,
            ));
        }
    }
    for entry in &vocab_snapshot {
        let value = serde_json::to_value(entry).map_err(|e| e.to_string())?;
        batch.push((
            "vocab".to_string(),
            format!("{}:{}", entry.lang, entry.word),
            value,
        ));
    }
    for bucket in &stats_snapshot {
        let Some(content_id) = content_ids_by_local_book.get(&bucket.book) else {
            continue;
        };
        let portable = PortableReadBucketV2 {
            day: bucket.day,
            hour: bucket.hour,
            content_id: content_id.clone(),
            secs: bucket.secs,
            words: bucket.words,
        };
        let value = serde_json::to_value(portable).map_err(|e| e.to_string())?;
        batch.push((
            "reading_bucket_v2".to_string(),
            format!("{}:{}:{}", bucket.day, bucket.hour, content_id),
            value,
        ));
    }
    state.with_db_write("seed_entity_model", |db| {
        db.upsert_json_batch(&batch)?;
        // Seed split organization entities only once from legacy state. A startup
        // projection is not proof of an intentional edit and cannot clear them.
        let organization_seeds = organization_seeds
            .into_iter()
            .filter_map(|item| match db.entity_json(&item.0, &item.1) {
                Ok(None) => Some(Ok(item)),
                Ok(Some(_)) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        db.upsert_json_batch(&organization_seeds)?;
        crate::private_sync::append_sync_entities(db)
    })?;
    crate::booklist_sync::seed_local_booklists(state)
}

/// Persist an explicit user organization edit. Unlike startup migration, this
/// writes an empty array as an intentional clear.
pub(crate) fn persist_book_organization_entities(
    state: &AppState,
    ids: &HashSet<u64>,
    persist_tags: bool,
    persist_collections: bool,
) -> Result<(), String> {
    if ids.is_empty() || (!persist_tags && !persist_collections) {
        return Ok(());
    }
    let books = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?
        .books
        .iter()
        .filter(|book| ids.contains(&book.id) && !book.content_id.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    let mut batch = Vec::new();
    for book in &books {
        if persist_tags {
            batch.push((
                USER_BOOK_TAGS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(UserBookTagsV1::from_book(book))
                    .map_err(|error| error.to_string())?,
            ));
        }
        if persist_collections {
            batch.push((
                BOOK_COLLECTIONS_KIND_V1.to_string(),
                book.content_id.clone(),
                serde_json::to_value(BookCollectionsV1::from_book(book))
                    .map_err(|error| error.to_string())?,
            ));
        }
    }
    state.with_db_write("persist_book_organization_entities", |db| {
        db.upsert_json_batch(&batch)
    })?;
    if persist_collections {
        crate::booklist_sync::persist_all_booklists(state)?;
    }
    Ok(())
}

/// Rehydrate organization fields before any startup projection can publish a
/// library file previously saved by an old or incomplete executable.
pub(crate) fn apply_local_organization_entities(state: &AppState) -> Result<(), String> {
    let items = state.with_db_read("apply_local_organization_entities", |db| {
        db.all_sync_entities()
    })?;
    let user_tags = items
        .iter()
        .filter(|item| item.kind == USER_BOOK_TAGS_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<UserBookTagsV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    let collections = items
        .iter()
        .filter(|item| item.kind == BOOK_COLLECTIONS_KIND_V1 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<BookCollectionsV1>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    let has_booklist_entity = items
        .iter()
        .any(|item| item.kind == crate::booklist_sync::BOOKLIST_KIND_V1);
    if user_tags.is_empty() && collections.is_empty() && !has_booklist_entity {
        return Ok(());
    }
    let mut library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let before = library
        .books
        .iter()
        .map(|book| (book.id, (book.tags.clone(), book.collections.clone())))
        .collect::<HashMap<_, _>>();
    for remote in &user_tags {
        if let Some(local) = library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    for remote in &collections {
        if let Some(local) = library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    let mut changed = library.books.iter().any(|book| {
        before.get(&book.id).is_some_and(|(tags, collections)| {
            *tags != book.tags || *collections != book.collections
        })
    });
    library.reconcile_booklists();
    changed |= crate::booklist_sync::apply_downloaded_booklists(&mut library, &items);
    if changed {
        library.save()?;
    }
    Ok(())
}

/// Apply a state that was downloaded before the corresponding local file was
/// imported. The row remains in SQLite, so it can be applied days later.
pub(crate) fn apply_pending_book_state(
    state: &AppState,
    target: &mut book::Book,
) -> Result<bool, String> {
    if target.content_id.is_empty() {
        return Ok(false);
    }
    let (progress, reading_data, statistics, book_state, model_tags, user_tags, collections) = state
        .with_db_read("apply_pending_book_state", |db| {
        let values = db.entity_json_many(&[
            (READING_PROGRESS_KIND_V1, &target.content_id),
            (READING_DATA_KIND_V1, &target.content_id),
            (READING_STATISTICS_KIND_V1, &target.content_id),
            (BOOK_STATE_KIND_V2, &target.content_id),
            (MODEL_BOOK_TAGS_KIND_V1, &target.content_id),
            (USER_BOOK_TAGS_KIND_V1, &target.content_id),
            (BOOK_COLLECTIONS_KIND_V1, &target.content_id),
        ])?;
        let [progress, reading_data, statistics, book_state, model_tags, user_tags, collections] =
            values
                .try_into()
                .map_err(|_| "批量读取图书同步状态数量不一致".to_string())?;
        Ok((
            progress,
            reading_data,
            statistics,
            book_state,
            model_tags,
            user_tags,
            collections,
        ))
    })?;
    let has_split_state = progress.is_some() || reading_data.is_some() || statistics.is_some();
    if !has_split_state
        && book_state.is_none()
        && model_tags.is_none()
        && user_tags.is_none()
        && collections.is_none()
    {
        return Ok(false);
    }
    if let Some(value) = progress {
        let synced: ReadingProgressV1 = serde_json::from_value(value).map_err(|e| e.to_string())?;
        synced.apply_to_book(target);
    }
    if let Some(value) = reading_data {
        let synced: ReadingDataV1 = serde_json::from_value(value).map_err(|e| e.to_string())?;
        synced.apply_to_book(target);
    }
    if let Some(value) = statistics {
        let synced: ReadingStatisticsV1 =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        synced.apply_to_book(target);
    }
    // Local installations created before protocol v2 may still have this row.
    // It is never uploaded by v2, and is only a one-time seed fallback.
    if !has_split_state {
        if let Some(value) = book_state {
            let synced: BookSyncStateV2 =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            synced.apply_to_book(target);
            synced.apply_legacy_organization_to_book(
                target,
                user_tags.is_none(),
                collections.is_none(),
            );
        }
    }
    if let Some(value) = model_tags {
        if let Ok(tags) = serde_json::from_value::<ModelBookTagsV1>(value) {
            tags.apply_to_book(target);
        }
    }
    if let Some(value) = user_tags {
        if let Ok(tags) = serde_json::from_value::<UserBookTagsV1>(value) {
            tags.apply_to_book(target);
        }
    }
    if let Some(value) = collections {
        if let Ok(collections) = serde_json::from_value::<BookCollectionsV1>(value) {
            collections.apply_to_book(target);
        }
    }
    Ok(true)
}

pub(crate) fn apply_sqlite_to_runtime(state: &AppState) -> Result<(), String> {
    // Acquire the installation gate before any in-memory core lock. Backup and
    // restore take the same gate before their locks, so this cannot deadlock
    // with a recovery operation while we hold the complete projection boundary.
    let _installation = crate::backup::core_installation_lock()?;
    let items = state.with_db_read("apply_sqlite_to_runtime", |db| db.all_sync_entities())?;
    let mut progress: Vec<ReadingProgressV1> = Vec::new();
    let mut reading_data: Vec<ReadingDataV1> = Vec::new();
    let mut statistics: Vec<ReadingStatisticsV1> = Vec::new();
    let mut model_tags: Vec<ModelBookTagsV1> = Vec::new();
    let mut user_tags: Vec<UserBookTagsV1> = Vec::new();
    let mut collections: Vec<BookCollectionsV1> = Vec::new();
    let mut vocab: Vec<vocab::VocabEntry> = Vec::new();
    let mut buckets: Vec<PortableReadBucketV2> = Vec::new();
    for item in &items {
        if item.deleted_at != 0 {
            continue;
        }
        match item.kind.as_str() {
            READING_PROGRESS_KIND_V1 => {
                if let Ok(value) = serde_json::from_value::<ReadingProgressV1>(item.json.clone()) {
                    progress.push(value);
                }
            }
            READING_DATA_KIND_V1 => {
                if let Ok(value) = serde_json::from_value::<ReadingDataV1>(item.json.clone()) {
                    reading_data.push(value);
                }
            }
            READING_STATISTICS_KIND_V1 => {
                if let Ok(value) = serde_json::from_value::<ReadingStatisticsV1>(item.json.clone())
                {
                    statistics.push(value);
                }
            }
            MODEL_BOOK_TAGS_KIND_V1 => {
                if let Ok(tags) = serde_json::from_value::<ModelBookTagsV1>(item.json.clone()) {
                    model_tags.push(tags);
                }
            }
            USER_BOOK_TAGS_KIND_V1 => {
                if let Ok(tags) = serde_json::from_value::<UserBookTagsV1>(item.json.clone()) {
                    user_tags.push(tags);
                }
            }
            BOOK_COLLECTIONS_KIND_V1 => {
                if let Ok(value) = serde_json::from_value::<BookCollectionsV1>(item.json.clone()) {
                    collections.push(value);
                }
            }
            "vocab" => {
                if let Ok(value) = serde_json::from_value::<vocab::VocabEntry>(item.json.clone()) {
                    vocab.push(value);
                }
            }
            "reading_bucket_v2" => {
                if let Ok(value) = serde_json::from_value::<PortableReadBucketV2>(item.json.clone())
                {
                    buckets.push(value);
                }
            }
            _ => {}
        }
    }

    // This can only affect private-sync entity kinds, which a core migration
    // package rejects. Keep it before the file installation anyway: a future
    // error here therefore cannot leave a newly written runtime projection.
    crate::private_sync::apply_downloaded_entities(state, &items)?;

    // Work on copies while holding every runtime store in the same fixed order
    // as backup/restore. Only replace live memory after the files have passed
    // the durable three-file installation transaction below.
    let mut library = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    let mut stats = state.stats.lock().map_err(|_| "统计锁定失败".to_string())?;
    let mut vocab_store = state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())?;
    let mut next_library = library.clone();
    let mut next_stats = stats.clone();
    let mut next_vocab = vocab_store.clone();

    for remote in &progress {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in &reading_data {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in &statistics {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
        }
    }
    for remote in &model_tags {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    for remote in &user_tags {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    for remote in &collections {
        if let Some(local) = next_library
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.apply_to_book(local);
        }
    }
    next_library.reconcile_booklists();
    crate::booklist_sync::apply_downloaded_booklists(&mut next_library, &items);
    // Unmatched states are intentionally left in SQLite as pending; do not
    // create broken shelf entries with another computer's file path.
    next_vocab.list = vocab;
    let local_ids_by_content: HashMap<String, u64> = next_library
        .books
        .iter()
        .filter(|book| !book.content_id.is_empty())
        .map(|book| (book.content_id.clone(), book.id))
        .collect();
    next_stats.map.clear();
    for bucket in buckets {
        if let Some(local_id) = local_ids_by_content.get(&bucket.content_id) {
            next_stats.map.insert(
                (bucket.day, bucket.hour, *local_id),
                (bucket.secs, bucket.words),
            );
        }
    }
    let persisted_stats: Vec<ReadBucket> = next_stats
        .map
        .iter()
        .map(|(&(day, hour, book), &(secs, words))| ReadBucket {
            day,
            hour,
            book,
            secs,
            words,
        })
        .collect();
    let projections = vec![
        (
            "library.json",
            serde_json::to_vec_pretty(&next_library).map_err(|error| error.to_string())?,
        ),
        (
            "stats.json",
            serde_json::to_vec(&persisted_stats).map_err(|error| error.to_string())?,
        ),
        (
            "vocab.json",
            serde_json::to_vec(&next_vocab.list).map_err(|error| error.to_string())?,
        ),
    ];
    crate::backup::install_runtime_projections_locked(&projections)?;
    next_stats.dirty = false;
    *library = next_library;
    *stats = next_stats;
    *vocab_store = next_vocab;
    Ok(())
}

/// Converge the local store once all portable v2 rows have been materialized.
pub(crate) fn converge_entity_model(state: &AppState) -> Result<u32, String> {
    if state.with_db_read("converge_entity_model_check", |db| {
        Ok(db.metadata(ENTITY_MODEL_VERSION_KEY).as_deref() == Some(ENTITY_MODEL_VERSION))
    })? {
        return Ok(0);
    }

    // Never discard a legacy row until a complete recovery point exists.
    crate::backup::create(state, true)?;
    state.with_db_write("converge_entity_model", |db| {
        let removed = db.purge_legacy_entities()?;
        db.set_metadata(ENTITY_MODEL_VERSION_KEY, ENTITY_MODEL_VERSION)?;
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_book(path: &str) -> book::Book {
        let mut book = book::Book::from_path(PathBuf::from(path));
        book.content_id = "same-content".into();
        book.progress = 64.0;
        book.resume_chapter = 9;
        book.resume_frac = 0.4;
        book
    }

    #[test]
    fn v2_state_keeps_local_path_and_id() {
        let source = sample_book("remote.epub");
        let state = BookSyncStateV2::from_book(&source);
        let mut local = sample_book("local.epub");
        let local_id = local.id;
        let local_path = local.path.clone();
        local.progress = 0.0;
        state.apply_to_book(&mut local);
        assert_eq!(local.id, local_id);
        assert_eq!(local.path, local_path);
        assert_eq!(local.progress, 64.0);
        assert_eq!(local.resume_chapter, 9);
    }

    #[test]
    fn legacy_state_can_seed_organization_when_independent_entities_are_absent() {
        let mut source = sample_book("remote.epub");
        source.tags = vec!["史料".into(), "明史".into()];
        source.collections = vec!["待读".into()];
        let state = BookSyncStateV2::from_book(&source);
        let mut local = sample_book("local.epub");
        state.apply_to_book(&mut local);
        state.apply_legacy_organization_to_book(&mut local, true, true);
        assert_eq!(local.tags, vec!["史料", "明史"]);
        assert_eq!(local.collections, vec!["待读"]);
    }

    #[test]
    fn independent_organization_entities_override_legacy_and_support_clear() {
        let mut legacy_source = sample_book("remote.epub");
        legacy_source.tags = vec!["旧标签".into()];
        legacy_source.collections = vec!["旧书单".into()];
        let legacy = BookSyncStateV2::from_book(&legacy_source);
        let mut local = sample_book("local.epub");
        local.tags = vec!["保留标签".into()];
        local.collections = vec!["保留书单".into()];

        legacy.apply_to_book(&mut local);
        assert_eq!(local.tags, vec!["保留标签"]);
        assert_eq!(local.collections, vec!["保留书单"]);

        UserBookTagsV1 {
            schema_version: 1,
            content_id: local.content_id.clone(),
            tags: Vec::new(),
        }
        .apply_to_book(&mut local);
        BookCollectionsV1 {
            schema_version: 1,
            content_id: local.content_id.clone(),
            collections: vec!["权威书单".into()],
        }
        .apply_to_book(&mut local);
        assert!(local.tags.is_empty());
        assert_eq!(local.collections, vec!["权威书单"]);
    }

    #[test]
    fn model_tags_are_a_separate_portable_entity() {
        let mut source = sample_book("remote.epub");
        source.tags = vec!["手工：史料".into()];
        source.model_tags = vec!["时代：明清".into(), "类别：小说".into()];
        let state = ModelBookTagsV1::from_book(&source);
        let mut local = sample_book("local.epub");
        local.tags = vec!["用户：待读".into()];
        state.apply_to_book(&mut local);
        assert_eq!(local.tags, vec!["用户：待读"]);
        assert_eq!(local.model_tags, vec!["时代：明清", "类别：小说"]);
    }

    #[test]
    fn v2_merge_preserves_newer_position_and_unions_annotations() {
        let mut local = sample_book("local.epub");
        local.last_read_at = 200;
        local.progress = 80.0;
        local.bookmarks.push(book::Bookmark {
            chapter: 1,
            frac: 0.2,
            label: "local".into(),
            ..Default::default()
        });
        let mut remote_book = sample_book("remote.epub");
        remote_book.last_read_at = 100;
        remote_book.progress = 20.0;
        remote_book.bookmarks.push(book::Bookmark {
            chapter: 2,
            frac: 0.3,
            label: "remote".into(),
            ..Default::default()
        });
        BookSyncStateV2::from_book(&remote_book).merge_into_book(&mut local);
        assert_eq!(local.progress, 80.0);
        assert_eq!(local.bookmarks.len(), 2);
    }
}
