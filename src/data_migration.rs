use crate::{book, stats_core::ReadBucket, vocab, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(crate) const BOOK_STATE_KIND_V2: &str = "book_state_v2";
const ENTITY_MODEL_VERSION_KEY: &str = "entity_model_version";
const ENTITY_MODEL_VERSION: &str = "2";

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
    progress_history: Vec<book::ProgressTimelineEntry>,
}

fn book_state_schema_version() -> u32 {
    2
}

#[derive(Clone, Serialize, Deserialize)]
struct PortableReadBucketV2 {
    day: u32,
    hour: u8,
    content_id: String,
    secs: u32,
    words: u32,
}

impl BookSyncStateV2 {
    fn from_book(book: &book::Book) -> Self {
        Self {
            schema_version: 2,
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
            chapter_index_version: book.chapter_index_version,
            bookmarks: book.bookmarks.clone(),
            highlights: book.highlights.clone(),
            reading_seconds: book.reading_seconds,
            words_read: book.words_read,
            finished_at: book.finished_at,
            rating: book.rating,
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
        target.chapter_index_version = self.chapter_index_version;
        target.bookmarks = self.bookmarks.clone();
        target.highlights = self.highlights.clone();
        target.reading_seconds = self.reading_seconds;
        target.words_read = self.words_read;
        target.finished_at = self.finished_at;
        target.rating = self.rating.clamp(0.0, 5.0);
        book::merge_daily_progress_history(&mut target.progress_history, &self.progress_history);
    }

    fn merge_into_book(&self, target: &mut book::Book) {
        if self.last_read_at > target.last_read_at
            || (self.last_read_at == target.last_read_at && self.progress > target.progress)
        {
            target.last_read_at = self.last_read_at;
            target.progress = self.progress.clamp(0.0, 100.0);
            target.resume_chapter = self.resume_chapter;
            target.resume_frac = self.resume_frac.clamp(0.0, 1.0);
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
        book::merge_daily_progress_history(&mut target.progress_history, &self.progress_history);
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
    let remote = items
        .iter()
        .filter(|item| item.kind == BOOK_STATE_KIND_V2 && item.deleted_at == 0)
        .filter_map(|item| serde_json::from_value::<BookSyncStateV2>(item.json.clone()).ok())
        .collect::<Vec<_>>();
    if remote.is_empty() {
        return Ok(());
    }
    let mut lib = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?;
    for remote in remote {
        if let Some(local) = lib
            .books
            .iter_mut()
            .find(|book| book.content_id == remote.content_id)
        {
            remote.merge_into_book(local);
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
    for book in &books {
        if !book.content_id.is_empty() {
            let state = BookSyncStateV2::from_book(book);
            batch.push((
                BOOK_STATE_KIND_V2.to_string(),
                book.content_id.clone(),
                serde_json::to_value(state).map_err(|e| e.to_string())?,
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
    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    db.upsert_json_batch(&batch)
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
    let value = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.entity_json(BOOK_STATE_KIND_V2, &target.content_id)?
    };
    let Some(value) = value else {
        return Ok(false);
    };
    let synced: BookSyncStateV2 = serde_json::from_value(value).map_err(|e| e.to_string())?;
    synced.apply_to_book(target);
    Ok(true)
}

pub(crate) fn apply_sqlite_to_runtime(state: &AppState) -> Result<(), String> {
    let items = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.all_sync_entities()?
    };
    let mut remote_books: Vec<BookSyncStateV2> = Vec::new();
    let mut vocab: Vec<vocab::VocabEntry> = Vec::new();
    let mut buckets: Vec<PortableReadBucketV2> = Vec::new();
    for item in items {
        if item.deleted_at != 0 {
            continue;
        }
        match item.kind.as_str() {
            BOOK_STATE_KIND_V2 => {
                if let Ok(book) = serde_json::from_value::<BookSyncStateV2>(item.json) {
                    remote_books.push(book);
                }
            }
            "vocab" => {
                if let Ok(value) = serde_json::from_value::<vocab::VocabEntry>(item.json) {
                    vocab.push(value);
                }
            }
            "reading_bucket_v2" => {
                if let Ok(value) = serde_json::from_value::<PortableReadBucketV2>(item.json) {
                    buckets.push(value);
                }
            }
            _ => {}
        }
    }
    if !remote_books.is_empty() {
        let mut lib = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        for remote in &remote_books {
            if let Some(local) = lib
                .books
                .iter_mut()
                .find(|book| book.content_id == remote.content_id)
            {
                remote.merge_into_book(local);
            }
        }
        // Unmatched states are intentionally left in SQLite as pending; do not
        // create broken shelf entries with another computer's file path.
        lib.save()?;
    }
    let mut vocab_store = state
        .vocab
        .lock()
        .map_err(|_| "生词本锁定失败".to_string())?;
    vocab_store.list = vocab;
    vocab_store.save()?;
    drop(vocab_store);
    let local_ids_by_content: HashMap<String, u64> = state
        .library
        .lock()
        .map_err(|_| "书架锁定失败".to_string())?
        .books
        .iter()
        .filter(|book| !book.content_id.is_empty())
        .map(|book| (book.content_id.clone(), book.id))
        .collect();
    let mut stats = state.stats.lock().map_err(|_| "统计锁定失败".to_string())?;
    stats.map.clear();
    for bucket in buckets {
        if let Some(local_id) = local_ids_by_content.get(&bucket.content_id) {
            stats.map.insert(
                (bucket.day, bucket.hour, *local_id),
                (bucket.secs, bucket.words),
            );
        }
    }
    stats.dirty = true;
    stats.save()?;
    Ok(())
}

/// Converge the local store once all portable v2 rows have been materialized.
pub(crate) fn converge_entity_model(state: &AppState) -> Result<u32, String> {
    {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        if db.metadata(ENTITY_MODEL_VERSION_KEY).as_deref() == Some(ENTITY_MODEL_VERSION) {
            return Ok(0);
        }
    }

    // Never discard a legacy row until a complete recovery point exists.
    crate::backup::create(state, true)?;
    let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
    let removed = db.purge_legacy_entities()?;
    db.set_metadata(ENTITY_MODEL_VERSION_KEY, ENTITY_MODEL_VERSION)?;
    Ok(removed)
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
    fn v2_merge_preserves_newer_position_and_unions_annotations() {
        let mut local = sample_book("local.epub");
        local.last_read_at = 200;
        local.progress = 80.0;
        local.bookmarks.push(book::Bookmark {
            chapter: 1,
            frac: 0.2,
            label: "local".into(),
        });
        let mut remote_book = sample_book("remote.epub");
        remote_book.last_read_at = 100;
        remote_book.progress = 20.0;
        remote_book.bookmarks.push(book::Bookmark {
            chapter: 2,
            frac: 0.3,
            label: "remote".into(),
        });
        BookSyncStateV2::from_book(&remote_book).merge_into_book(&mut local);
        assert_eq!(local.progress, 80.0);
        assert_eq!(local.bookmarks.len(), 2);
    }
}
