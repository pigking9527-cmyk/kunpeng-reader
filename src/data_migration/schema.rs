use crate::book;
use serde::{Deserialize, Serialize};

pub(crate) const BOOK_STATE_KIND_V2: &str = "book_state_v2";
/// Protocol v2 splits the former monolithic book_state_v2 so each user-facing
/// category can be selected independently in sync settings.
pub(crate) const READING_PROGRESS_KIND_V1: &str = "reading_progress_v1";
pub(crate) const READING_DATA_KIND_V1: &str = "reading_data_v1";
pub(crate) const READING_STATISTICS_KIND_V1: &str = "reading_statistics_v1";
pub(crate) const MODEL_BOOK_TAGS_KIND_V1: &str = "model_book_tags_v1";
pub(crate) const USER_BOOK_TAGS_KIND_V1: &str = "user_book_tags_v1";
pub(crate) const BOOK_COLLECTIONS_KIND_V1: &str = "book_collections_v1";

/// Cross-device state for one book. Machine-local paths and cover-cache paths
/// never leave the device; the full file hash is the stable identity.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BookSyncStateV2 {
    #[serde(default = "book_state_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) fingerprint: u64,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) author: String,
    #[serde(default)]
    pub(super) description: String,
    #[serde(default)]
    pub(super) format: String,
    #[serde(default)]
    pub(super) last_read_at: u64,
    #[serde(default)]
    pub(super) progress: f32,
    #[serde(default)]
    pub(super) resume_chapter: u32,
    #[serde(default)]
    pub(super) resume_frac: f32,
    #[serde(default)]
    pub(super) resume_position: Option<reader_core::ReadingPosition>,
    #[serde(default)]
    pub(super) chapter_index_version: u32,
    #[serde(default)]
    pub(super) bookmarks: Vec<book::Bookmark>,
    #[serde(default)]
    pub(super) highlights: Vec<book::Highlight>,
    #[serde(default)]
    pub(super) reading_seconds: u64,
    #[serde(default)]
    pub(super) words_read: u64,
    #[serde(default)]
    pub(super) finished_at: u64,
    #[serde(default)]
    pub(super) rating: f32,
    #[serde(default)]
    pub(super) tags: Vec<String>,
    #[serde(default)]
    pub(super) collections: Vec<String>,
    #[serde(default)]
    pub(super) progress_history: Vec<book::ProgressTimelineEntry>,
}

fn book_state_schema_version() -> u32 {
    4
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct PortableReadBucketV2 {
    pub(super) day: u32,
    pub(super) hour: u8,
    pub(super) content_id: String,
    pub(super) secs: u32,
    pub(super) words: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ReadingProgressV1 {
    #[serde(default = "organization_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) last_read_at: u64,
    #[serde(default)]
    pub(super) progress: f32,
    #[serde(default)]
    pub(super) resume_chapter: u32,
    #[serde(default)]
    pub(super) resume_frac: f32,
    #[serde(default)]
    pub(super) resume_position: Option<reader_core::ReadingPosition>,
    #[serde(default)]
    pub(super) chapter_index_version: u32,
    #[serde(default)]
    pub(super) progress_history: Vec<book::ProgressTimelineEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ReadingDataV1 {
    #[serde(default = "organization_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) bookmarks: Vec<book::Bookmark>,
    #[serde(default)]
    pub(super) highlights: Vec<book::Highlight>,
    #[serde(default)]
    pub(super) rating: f32,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ReadingStatisticsV1 {
    #[serde(default = "organization_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) reading_seconds: u64,
    #[serde(default)]
    pub(super) words_read: u64,
    #[serde(default)]
    pub(super) finished_at: u64,
}

/// Sync model-derived labels in an independent entity. This keeps old clients
/// from rewriting an entire book state without fields they do not yet know,
/// and never conflates the reader's own `tags` with automatic classification.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ModelBookTagsV1 {
    #[serde(default = "model_book_tags_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) tags: Vec<String>,
}

fn model_book_tags_schema_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct UserBookTagsV1 {
    #[serde(default = "organization_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct BookCollectionsV1 {
    #[serde(default = "organization_schema_version")]
    pub(super) schema_version: u32,
    pub(super) content_id: String,
    #[serde(default)]
    pub(super) collections: Vec<String>,
}

fn organization_schema_version() -> u32 {
    1
}
