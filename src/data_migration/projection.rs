//! Read-only classification of durable sync rows for runtime projection.
//!
//! This module deliberately ignores tombstones, malformed known payloads and
//! unknown kinds. It never mutates SQLite, so the opaque source envelopes stay
//! available for LWW and future clients even when this runtime cannot project
//! them.

use super::{
    BookCollectionsV1, ModelBookTagsV1, PortableReadBucketV2, ReadingDataV1, ReadingProgressV1,
    ReadingStatisticsV1, UserBookTagsV1, BOOK_COLLECTIONS_KIND_V1, MODEL_BOOK_TAGS_KIND_V1,
    READING_DATA_KIND_V1, READING_PROGRESS_KIND_V1, READING_STATISTICS_KIND_V1,
    USER_BOOK_TAGS_KIND_V1,
};
use crate::{db::SyncEntity, vocab};

pub(super) struct RuntimeProjectionInput {
    pub(super) progress: Vec<ReadingProgressV1>,
    pub(super) reading_data: Vec<ReadingDataV1>,
    pub(super) statistics: Vec<ReadingStatisticsV1>,
    pub(super) model_tags: Vec<ModelBookTagsV1>,
    pub(super) user_tags: Vec<UserBookTagsV1>,
    pub(super) collections: Vec<BookCollectionsV1>,
    pub(super) vocab: Vec<vocab::VocabEntry>,
    pub(super) buckets: Vec<PortableReadBucketV2>,
}

pub(super) struct PulledBookProjection {
    pub(super) progress: Vec<ReadingProgressV1>,
    pub(super) reading_data: Vec<ReadingDataV1>,
    pub(super) statistics: Vec<ReadingStatisticsV1>,
    pub(super) model_tags: Vec<ModelBookTagsV1>,
}

impl PulledBookProjection {
    pub(super) fn is_empty(&self) -> bool {
        self.progress.is_empty()
            && self.reading_data.is_empty()
            && self.statistics.is_empty()
            && self.model_tags.is_empty()
    }
}

pub(super) fn project_pulled_book_entities(items: &[SyncEntity]) -> PulledBookProjection {
    let mut projection = PulledBookProjection {
        progress: Vec::new(),
        reading_data: Vec::new(),
        statistics: Vec::new(),
        model_tags: Vec::new(),
    };

    for item in items.iter().filter(|item| item.deleted_at == 0) {
        match item.kind.as_str() {
            READING_PROGRESS_KIND_V1 => push_decoded(&mut projection.progress, item),
            READING_DATA_KIND_V1 => push_decoded(&mut projection.reading_data, item),
            READING_STATISTICS_KIND_V1 => push_decoded(&mut projection.statistics, item),
            MODEL_BOOK_TAGS_KIND_V1 => push_decoded(&mut projection.model_tags, item),
            _ => {}
        }
    }

    projection
}

pub(super) fn project_active_entities(items: &[SyncEntity]) -> RuntimeProjectionInput {
    let mut projection = RuntimeProjectionInput {
        progress: Vec::new(),
        reading_data: Vec::new(),
        statistics: Vec::new(),
        model_tags: Vec::new(),
        user_tags: Vec::new(),
        collections: Vec::new(),
        vocab: Vec::new(),
        buckets: Vec::new(),
    };

    for item in items.iter().filter(|item| item.deleted_at == 0) {
        match item.kind.as_str() {
            READING_PROGRESS_KIND_V1 => push_decoded(&mut projection.progress, item),
            READING_DATA_KIND_V1 => push_decoded(&mut projection.reading_data, item),
            READING_STATISTICS_KIND_V1 => push_decoded(&mut projection.statistics, item),
            MODEL_BOOK_TAGS_KIND_V1 => push_decoded(&mut projection.model_tags, item),
            USER_BOOK_TAGS_KIND_V1 => push_decoded(&mut projection.user_tags, item),
            BOOK_COLLECTIONS_KIND_V1 => push_decoded(&mut projection.collections, item),
            "vocab" => push_decoded(&mut projection.vocab, item),
            "reading_bucket_v2" => push_decoded(&mut projection.buckets, item),
            _ => {}
        }
    }

    projection
}

fn push_decoded<T>(target: &mut Vec<T>, item: &SyncEntity)
where
    T: serde::de::DeserializeOwned,
{
    if let Ok(value) = serde_json::from_value(item.json.clone()) {
        target.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entity(kind: &str, deleted_at: i64, json: serde_json::Value) -> SyncEntity {
        SyncEntity {
            kind: kind.to_string(),
            id: "same-content".to_string(),
            json,
            updated_at: 10,
            deleted_at,
            device_id: "test-device".to_string(),
            sync_version: 1,
        }
    }

    #[test]
    fn projection_keeps_only_active_decodable_known_rows() {
        let items = vec![
            entity(
                READING_PROGRESS_KIND_V1,
                0,
                json!({
                    "content_id": "same-content",
                    "progress": 25.0,
                    "future_field": {"preserved_in_source": true}
                }),
            ),
            entity(
                READING_PROGRESS_KIND_V1,
                11,
                json!({"content_id": "tombstoned", "progress": 99.0}),
            ),
            entity(READING_DATA_KIND_V1, 0, json!({"rating": "invalid"})),
            entity(
                "future_entity_v9",
                0,
                json!({"opaque": {"still_in_source": true}}),
            ),
        ];

        let projection = project_active_entities(&items);

        assert_eq!(projection.progress.len(), 1);
        assert_eq!(projection.progress[0].content_id, "same-content");
        assert!(projection.reading_data.is_empty());
        assert_eq!(items[0].json["future_field"]["preserved_in_source"], true);
        assert_eq!(items[3].json["opaque"]["still_in_source"], true);
    }

    #[test]
    fn pulled_book_projection_does_not_treat_organization_as_merge_input() {
        let items = vec![entity(
            USER_BOOK_TAGS_KIND_V1,
            0,
            json!({"content_id": "same-content", "tags": ["史料"]}),
        )];

        assert!(project_pulled_book_entities(&items).is_empty());
    }
}
