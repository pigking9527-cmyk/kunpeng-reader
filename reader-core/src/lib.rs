//! Platform-neutral reader domain.
//!
//! This crate deliberately has no Tauri, filesystem picker, window, tray or
//! platform-path dependency.  Desktop and mobile hosts adapt their own file
//! handles and storage locations at the boundary, while the reading model,
//! anchoring, sync merge rules and text decoding stay reusable.

pub mod domain;
pub mod import;
pub mod parser;
pub mod stats;
pub mod sync;
pub mod text;

pub use domain::{
    BookOrganization, Bookmark, Highlight, ProgressTimelineEntry, ReadingAnchor, ReadingPosition,
    TextRangeAnchor,
};
