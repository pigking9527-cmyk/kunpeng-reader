//! 书籍阅读位置的纯领域规则。
//!
//! 本模块不查询书架、不读取时钟；调用方负责选择图书并提供当前时间，因而同步
//! 合并与阅读器位置更新能共享完全相同的每日历史压缩规则。

use super::{Book, ProgressTimelineEntry};
use reader_core::{ReadingAnchor, ReadingPosition};

fn local_day_key(secs: u64) -> u32 {
    use chrono::{Datelike, Local, TimeZone};
    Local
        .timestamp_opt(secs as i64, 0)
        .single()
        .map(|time| time.year() as u32 * 10000 + time.month() * 100 + time.day())
        .unwrap_or(0)
}

/// 合并并压缩每日位置摘要：同一天只保留时间更晚的那条，最多保留十年。
pub(crate) fn merge_daily_progress_history(
    target: &mut Vec<ProgressTimelineEntry>,
    incoming: &[ProgressTimelineEntry],
) {
    let mut days = std::collections::BTreeMap::<u32, ProgressTimelineEntry>::new();
    for entry in target.iter().chain(incoming.iter()) {
        let day = local_day_key(entry.at);
        if days.get(&day).is_none_or(|old| entry.at >= old.at) {
            days.insert(day, entry.clone());
        }
    }
    const MAX_DAILY_PROGRESS_HISTORY: usize = 3650;
    let skip = days.len().saturating_sub(MAX_DAILY_PROGRESS_HISTORY);
    *target = days.into_values().skip(skip).collect();
}

/// Apply one renderer-reported position to a single book.
///
/// `now_secs` is supplied by the library boundary so this rule remains
/// deterministic and does not own clock access or book lookup.
pub(crate) fn apply_reading_position(
    book: &mut Book,
    progress: f32,
    chapter: u32,
    frac: f32,
    anchor: Option<ReadingAnchor>,
    now_secs: u64,
) -> bool {
    let position = ReadingPosition {
        chapter,
        anchor,
        fraction: frac,
    }
    .normalized();
    // 分页测量会在同一源码锚点上得到不同的页数/百分比。源码位置没有
    // 变化时，后一次只是派生值重算，绝不能覆盖已保存的续读位置。
    let same_source_anchor = book
        .resume_position
        .as_ref()
        .and_then(|saved| saved.anchor.as_ref())
        .zip(position.anchor.as_ref())
        .is_some_and(|(saved, incoming)| {
            saved.chapter == incoming.chapter && saved.text_offset == incoming.text_offset
        });
    if same_source_anchor {
        return false;
    }

    let anchor_changed =
        position.anchor.is_some() && book.resume_position.as_ref() != Some(&position);
    let changed = (book.progress - progress).abs() >= 0.05
        || book.resume_chapter != chapter
        || (book.resume_frac - frac).abs() >= 0.02
        || anchor_changed;
    book.progress = progress;
    book.resume_chapter = position.authoritative_chapter();
    book.resume_frac = position.fraction;
    // Older clients keep reporting fraction-only positions. Do not let them
    // erase a newer source anchor saved by another device.
    if position.anchor.is_some() {
        book.resume_position = Some(position.clone());
    }
    if changed {
        let entry = ProgressTimelineEntry {
            at: now_secs,
            progress: progress.clamp(0.0, 100.0),
            chapter: position.authoritative_chapter(),
            frac: position.fraction,
            position: position.anchor.is_some().then_some(position),
        };
        if book
            .progress_history
            .last()
            .is_some_and(|last| local_day_key(last.at) == local_day_key(now_secs))
        {
            *book
                .progress_history
                .last_mut()
                .expect("last entry checked") = entry;
        } else {
            book.progress_history.push(entry);
        }
        merge_daily_progress_history(&mut book.progress_history, &[]);
    }
    if progress >= 99.0 && book.finished_at == 0 {
        // 首次读完打时间戳，供"本月/本年读完了哪些书"。
        book.finished_at = now_secs;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::apply_reading_position;
    use crate::book::Book;
    use reader_core::ReadingAnchor;
    use std::path::PathBuf;

    #[test]
    fn applies_a_position_with_a_caller_supplied_timestamp() {
        let mut book = Book::from_path(PathBuf::from("progress-rule.txt"));
        let at = 1_700_000_000;

        assert!(apply_reading_position(&mut book, 99.2, 7, 1.4, None, at));
        assert_eq!(book.resume_chapter, 7);
        assert_eq!(book.resume_frac, 1.0);
        assert_eq!(book.progress_history.len(), 1);
        assert_eq!(book.progress_history[0].at, at);
        assert_eq!(book.progress_history[0].frac, 1.0);
        assert_eq!(book.finished_at, at);
    }

    #[test]
    fn keeps_the_saved_position_when_a_relayout_reports_the_same_anchor() {
        let mut book = Book::from_path(PathBuf::from("progress-anchor-rule.txt"));
        let anchor = ReadingAnchor {
            chapter: 3,
            dom_path: "p:2/span:0".into(),
            text_offset: 99,
            context_before: "前文".into(),
            context_after: "后文".into(),
            viewport_offset: 12.0,
        };

        assert!(apply_reading_position(
            &mut book,
            48.0,
            3,
            0.4,
            Some(anchor.clone()),
            1_700_000_000,
        ));
        assert!(!apply_reading_position(
            &mut book,
            46.0,
            3,
            0.4,
            Some(anchor),
            1_700_000_060,
        ));
        assert_eq!(book.progress, 48.0);
        assert_eq!(book.progress_history.len(), 1);
    }
}
