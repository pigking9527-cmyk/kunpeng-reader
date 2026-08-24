//! Offline validation and projection for a model-produced intelligence synthesis.
//!
//! This module deliberately has no network, UI, database, or serialization dependency.
//! A model may name only a controlled `(sourceId, noteId)` pair and controlled media IDs.
//! The caller owns projection of archival metadata such as publisher and URL after this
//! boundary has accepted the report.

use std::collections::{BTreeMap, BTreeSet};

const MAX_TEXT_BYTES: usize = 16_384;
const MAX_BLOCKS: usize = 1_024;
const MAX_SEGMENTS_PER_BLOCK: usize = 128;
const MAX_NOTES_PER_SEGMENT: usize = 16;
const MAX_MEDIA_PER_BLOCK: usize = 16;

/// A citation that the caller has already resolved from its permanent archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlledCitation {
    pub source_id: String,
    pub note_id: String,
}

/// Closed input vocabulary made available to the model for one synthesis.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ControlledSynthesisInput {
    pub citations: Vec<ControlledCitation>,
    pub media_ids: Vec<String>,
}

/// The only citation-shaped value a model may return. It intentionally has no URL field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCitationRef {
    pub source_id: String,
    pub note_id: String,
}

/// A model text segment before citation projection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSegment {
    pub text: String,
    pub citations: Vec<ModelCitationRef>,
}

/// A model text block. `media_ids` are IDs, not paths or URLs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelBlock {
    pub block_id: String,
    pub segments: Vec<ModelSegment>,
    pub media_ids: Vec<String>,
}

/// Closed model result used as the input for validation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSynthesis {
    pub title: String,
    pub blocks: Vec<ModelBlock>,
}

/// A validated segment ready for the publication layer's `noteIds` shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedSegment {
    pub text: String,
    pub note_ids: Vec<String>,
}

/// A validated block ready for publication projection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedBlock {
    pub block_id: String,
    pub segments: Vec<ProjectedSegment>,
    pub media_ids: Vec<String>,
}

/// A URL-free, structured synthesis. URLs and source metadata remain archival-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedSynthesis {
    pub title: String,
    pub blocks: Vec<ProjectedBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SynthesisError {
    Empty(&'static str),
    TooMany(&'static str),
    InvalidId {
        field: &'static str,
        value: String,
    },
    DuplicateControlledNoteId(String),
    DuplicateControlledMediaId(String),
    DuplicateBlockId(String),
    DuplicateNoteReference(String),
    DuplicateMediaReference(String),
    UnknownNoteId(String),
    SourceIdMismatch {
        note_id: String,
        expected_source_id: String,
        actual_source_id: String,
    },
    UncontrolledMediaId(String),
    UrlForbidden(&'static str),
}

/// Validate an untrusted, closed model result and project citations to `noteIds`.
///
/// No model-provided URL can cross this boundary: the public model types have no URL
/// field, text/title URL-like values are rejected, and IDs use the contract-safe ID
/// alphabet. A segment containing text always receives at least one archive-approved
/// note ID.
pub fn validate_and_project(
    input: &ControlledSynthesisInput,
    model: &ModelSynthesis,
) -> Result<ProjectedSynthesis, SynthesisError> {
    let citations = controlled_citations(input)?;
    let media_ids = controlled_media_ids(input)?;
    validate_text(&model.title, "title")?;
    if model.blocks.is_empty() {
        return Err(SynthesisError::Empty("blocks"));
    }
    if model.blocks.len() > MAX_BLOCKS {
        return Err(SynthesisError::TooMany("blocks"));
    }

    let mut block_ids = BTreeSet::new();
    let mut blocks = Vec::with_capacity(model.blocks.len());
    for block in &model.blocks {
        validate_id(&block.block_id, "blockId")?;
        if !block_ids.insert(block.block_id.as_str()) {
            return Err(SynthesisError::DuplicateBlockId(block.block_id.clone()));
        }
        if block.segments.is_empty() {
            return Err(SynthesisError::Empty("segments"));
        }
        if block.segments.len() > MAX_SEGMENTS_PER_BLOCK {
            return Err(SynthesisError::TooMany("segments"));
        }
        if block.media_ids.len() > MAX_MEDIA_PER_BLOCK {
            return Err(SynthesisError::TooMany("mediaIds"));
        }

        let mut seen_media = BTreeSet::new();
        for media_id in &block.media_ids {
            validate_id(media_id, "mediaId")?;
            if !seen_media.insert(media_id.as_str()) {
                return Err(SynthesisError::DuplicateMediaReference(media_id.clone()));
            }
            if !media_ids.contains(media_id) {
                return Err(SynthesisError::UncontrolledMediaId(media_id.clone()));
            }
        }

        let mut segments = Vec::with_capacity(block.segments.len());
        for segment in &block.segments {
            validate_text(&segment.text, "segment.text")?;
            if segment.citations.is_empty() {
                return Err(SynthesisError::Empty("segment.noteIds"));
            }
            if segment.citations.len() > MAX_NOTES_PER_SEGMENT {
                return Err(SynthesisError::TooMany("segment.noteIds"));
            }

            let mut seen_notes = BTreeSet::new();
            let mut note_ids = Vec::with_capacity(segment.citations.len());
            for citation in &segment.citations {
                validate_id(&citation.source_id, "sourceId")?;
                validate_id(&citation.note_id, "noteId")?;
                if !seen_notes.insert(citation.note_id.as_str()) {
                    return Err(SynthesisError::DuplicateNoteReference(
                        citation.note_id.clone(),
                    ));
                }
                let Some(expected_source_id) = citations.get(&citation.note_id) else {
                    return Err(SynthesisError::UnknownNoteId(citation.note_id.clone()));
                };
                if expected_source_id != &citation.source_id {
                    return Err(SynthesisError::SourceIdMismatch {
                        note_id: citation.note_id.clone(),
                        expected_source_id: expected_source_id.clone(),
                        actual_source_id: citation.source_id.clone(),
                    });
                }
                note_ids.push(citation.note_id.clone());
            }

            segments.push(ProjectedSegment {
                text: segment.text.clone(),
                note_ids,
            });
        }
        blocks.push(ProjectedBlock {
            block_id: block.block_id.clone(),
            segments,
            media_ids: block.media_ids.clone(),
        });
    }

    Ok(ProjectedSynthesis {
        title: model.title.clone(),
        blocks,
    })
}

fn controlled_citations(
    input: &ControlledSynthesisInput,
) -> Result<BTreeMap<String, String>, SynthesisError> {
    let mut citations = BTreeMap::new();
    for citation in &input.citations {
        validate_id(&citation.source_id, "controlled.sourceId")?;
        validate_id(&citation.note_id, "controlled.noteId")?;
        if citations
            .insert(citation.note_id.clone(), citation.source_id.clone())
            .is_some()
        {
            return Err(SynthesisError::DuplicateControlledNoteId(
                citation.note_id.clone(),
            ));
        }
    }
    Ok(citations)
}

fn controlled_media_ids(
    input: &ControlledSynthesisInput,
) -> Result<BTreeSet<String>, SynthesisError> {
    let mut media_ids = BTreeSet::new();
    for media_id in &input.media_ids {
        validate_id(media_id, "controlled.mediaId")?;
        if !media_ids.insert(media_id.clone()) {
            return Err(SynthesisError::DuplicateControlledMediaId(media_id.clone()));
        }
    }
    Ok(media_ids)
}

fn validate_text(value: &str, field: &'static str) -> Result<(), SynthesisError> {
    if value.trim().is_empty() {
        return Err(SynthesisError::Empty(field));
    }
    if value.len() > MAX_TEXT_BYTES {
        return Err(SynthesisError::TooMany(field));
    }
    if contains_url(value) {
        return Err(SynthesisError::UrlForbidden(field));
    }
    Ok(())
}

fn validate_id(value: &str, field: &'static str) -> Result<(), SynthesisError> {
    let bytes = value.as_bytes();
    let first_is_valid = bytes.first().is_some_and(u8::is_ascii_alphanumeric);
    let rest_are_valid = bytes
        .iter()
        .skip(1)
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'));
    if value.len() > 128 || !first_is_valid || !rest_are_valid {
        return Err(SynthesisError::InvalidId {
            field,
            value: value.to_owned(),
        });
    }
    Ok(())
}

fn contains_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("://") || lower.contains("www.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controlled_input() -> ControlledSynthesisInput {
        ControlledSynthesisInput {
            citations: vec![
                ControlledCitation {
                    source_id: "source-reuters".into(),
                    note_id: "note-1".into(),
                },
                ControlledCitation {
                    source_id: "source-ap".into(),
                    note_id: "note-2".into(),
                },
            ],
            media_ids: vec!["image-640".into()],
        }
    }

    fn valid_model() -> ModelSynthesis {
        ModelSynthesis {
            title: "制裁措施更新".into(),
            blocks: vec![ModelBlock {
                block_id: "block-1".into(),
                segments: vec![ModelSegment {
                    text: "财政部门公布了新的制裁措施。".into(),
                    citations: vec![ModelCitationRef {
                        source_id: "source-reuters".into(),
                        note_id: "note-1".into(),
                    }],
                }],
                media_ids: vec!["image-640".into()],
            }],
        }
    }

    #[test]
    fn projects_blocks_segments_and_note_ids_from_controlled_citations() {
        let projected = validate_and_project(&controlled_input(), &valid_model()).unwrap();
        assert_eq!(projected.blocks.len(), 1);
        assert_eq!(projected.blocks[0].segments.len(), 1);
        assert_eq!(projected.blocks[0].segments[0].note_ids, ["note-1"]);
        assert_eq!(projected.blocks[0].media_ids, ["image-640"]);
    }

    #[test]
    fn rejects_unknown_note_and_source_note_mismatch() {
        let mut unknown = valid_model();
        unknown.blocks[0].segments[0].citations[0].note_id = "note-missing".into();
        assert_eq!(
            validate_and_project(&controlled_input(), &unknown),
            Err(SynthesisError::UnknownNoteId("note-missing".into()))
        );

        let mut mismatch = valid_model();
        mismatch.blocks[0].segments[0].citations[0].source_id = "source-ap".into();
        assert_eq!(
            validate_and_project(&controlled_input(), &mismatch),
            Err(SynthesisError::SourceIdMismatch {
                note_id: "note-1".into(),
                expected_source_id: "source-reuters".into(),
                actual_source_id: "source-ap".into(),
            })
        );
    }

    #[test]
    fn rejects_url_like_model_title_or_text() {
        let mut title_url = valid_model();
        title_url.title = "https://untrusted.invalid".into();
        assert_eq!(
            validate_and_project(&controlled_input(), &title_url),
            Err(SynthesisError::UrlForbidden("title"))
        );

        let mut text_url = valid_model();
        text_url.blocks[0].segments[0].text = "查看 www.untrusted.invalid".into();
        assert_eq!(
            validate_and_project(&controlled_input(), &text_url),
            Err(SynthesisError::UrlForbidden("segment.text"))
        );
    }

    #[test]
    fn rejects_nonempty_segment_without_an_approved_note() {
        let mut model = valid_model();
        model.blocks[0].segments[0].citations.clear();
        assert_eq!(
            validate_and_project(&controlled_input(), &model),
            Err(SynthesisError::Empty("segment.noteIds"))
        );
    }

    #[test]
    fn rejects_uncontrolled_or_duplicate_media() {
        let mut uncontrolled = valid_model();
        uncontrolled.blocks[0].media_ids = vec!["unknown-image".into()];
        assert_eq!(
            validate_and_project(&controlled_input(), &uncontrolled),
            Err(SynthesisError::UncontrolledMediaId("unknown-image".into()))
        );

        let mut duplicate = valid_model();
        duplicate.blocks[0].media_ids.push("image-640".into());
        assert_eq!(
            validate_and_project(&controlled_input(), &duplicate),
            Err(SynthesisError::DuplicateMediaReference("image-640".into()))
        );
    }

    #[test]
    fn rejects_url_shaped_ids_before_they_can_be_references() {
        let mut model = valid_model();
        model.blocks[0].segments[0].citations[0].source_id = "https://bad.invalid".into();
        assert!(matches!(
            validate_and_project(&controlled_input(), &model),
            Err(SynthesisError::InvalidId {
                field: "sourceId",
                ..
            })
        ));
    }
}
