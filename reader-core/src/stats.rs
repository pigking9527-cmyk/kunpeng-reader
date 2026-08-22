use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct StatsSummary {
    pub total_seconds: u64,
    pub total_words: u64,
    pub total_books: u32,
    pub started: u32,
    pub finished: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ReadBucket {
    pub day: u32,
    pub hour: u8,
    pub book: u64,
    pub secs: u32,
    pub words: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightStatInput {
    pub day: u32,
    pub has_note: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookStatInput {
    pub id: u64,
    pub title: String,
    pub cover: Option<String>,
    pub reading_seconds: u64,
    pub words_read: u64,
    pub progress: f32,
    pub finished_day: u32,
    pub highlights: Vec<HighlightStatInput>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BookStat {
    pub id: String,
    pub title: String,
    pub cover: Option<String>,
    pub seconds: u64,
    pub words: u64,
    pub highlights: u32,
    pub notes: u32,
    pub finished: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DayStat {
    pub day: u32,
    pub seconds: u64,
    pub words: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct StatsRange {
    pub total_seconds: u64,
    pub total_words: u64,
    pub hours: Vec<u64>,
    pub hours_words: Vec<u64>,
    pub days: Vec<DayStat>,
    pub books: Vec<BookStat>,
    pub finished: Vec<BookStat>,
    pub book_count: u32,
    pub finished_count: u32,
    pub total_highlights: u32,
    pub total_notes: u32,
}

pub fn summarize_books(books: &[BookStatInput]) -> StatsSummary {
    let mut summary = StatsSummary {
        total_seconds: 0,
        total_words: 0,
        total_books: books.len() as u32,
        started: 0,
        finished: 0,
    };
    for book in books {
        summary.total_seconds += book.reading_seconds;
        summary.total_words += book.words_read;
        if book.progress > 0.5 {
            summary.started += 1;
        }
        if book.progress >= 99.0 {
            summary.finished += 1;
        }
    }
    summary
}

pub fn aggregate_stats_range(
    buckets: &HashMap<(u32, u8, u64), (u32, u32)>,
    books: &[BookStatInput],
    from: u32,
    to: u32,
) -> StatsRange {
    let mut hours = vec![0; 24];
    let mut hours_words = vec![0; 24];
    let mut per_book = HashMap::<u64, (u64, u64)>::new();
    let mut per_day = HashMap::<u32, (u64, u64)>::new();
    let mut total_seconds = 0;
    let mut total_words = 0;
    for (&(day, hour, book), &(secs, words)) in buckets {
        if day < from || day > to {
            continue;
        }
        total_seconds += secs as u64;
        total_words += words as u64;
        hours[hour.min(23) as usize] += secs as u64;
        hours_words[hour.min(23) as usize] += words as u64;
        let day_entry = per_day.entry(day).or_insert((0, 0));
        day_entry.0 += secs as u64;
        day_entry.1 += words as u64;
        let book_entry = per_book.entry(book).or_insert((0, 0));
        book_entry.0 += secs as u64;
        book_entry.1 += words as u64;
    }
    let mut titles = HashMap::new();
    let mut covers = HashMap::new();
    let mut hl_counts = HashMap::<u64, (u32, u32)>::new();
    let mut total_highlights = 0;
    let mut total_notes = 0;
    let mut finished_ids = HashSet::new();
    for book in books {
        titles.insert(book.id, book.title.clone());
        if let Some(cover) = &book.cover {
            covers.insert(book.id, cover.clone());
        }
        for highlight in &book.highlights {
            if highlight.day >= from && highlight.day <= to {
                let value = hl_counts.entry(book.id).or_insert((0, 0));
                value.0 += 1;
                total_highlights += 1;
                if highlight.has_note {
                    value.1 += 1;
                    total_notes += 1;
                }
            }
        }
        if book.finished_day >= from && book.finished_day <= to {
            finished_ids.insert(book.id);
        }
    }
    let make_book = |id: u64, seconds: u64, words: u64| {
        let (highlights, notes) = hl_counts.get(&id).copied().unwrap_or((0, 0));
        BookStat {
            id: id.to_string(),
            title: titles
                .get(&id)
                .cloned()
                .unwrap_or_else(|| "（已删除）".into()),
            cover: covers.get(&id).cloned(),
            seconds,
            words,
            highlights,
            notes,
            finished: finished_ids.contains(&id),
        }
    };
    let mut books_out: Vec<_> = per_book
        .iter()
        .map(|(&id, &(seconds, words))| make_book(id, seconds, words))
        .collect();
    books_out.sort_by(|a, b| {
        b.seconds
            .cmp(&a.seconds)
            .then_with(|| a.title.cmp(&b.title))
    });
    let mut finished: Vec<_> = finished_ids
        .iter()
        .map(|&id| {
            let (seconds, words) = per_book.get(&id).copied().unwrap_or((0, 0));
            make_book(id, seconds, words)
        })
        .collect();
    finished.sort_by(|a, b| a.title.cmp(&b.title));
    let mut days: Vec<_> = per_day
        .into_iter()
        .map(|(day, (seconds, words))| DayStat {
            day,
            seconds,
            words,
        })
        .collect();
    days.sort_by_key(|item| item.day);
    StatsRange {
        total_seconds,
        total_words,
        hours,
        hours_words,
        days,
        book_count: books_out.len() as u32,
        finished_count: finished.len() as u32,
        books: books_out,
        finished,
        total_highlights,
        total_notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(id: u64, title: &str, progress: f32) -> BookStatInput {
        BookStatInput {
            id,
            title: title.to_string(),
            cover: None,
            reading_seconds: 0,
            words_read: 0,
            progress,
            finished_day: 0,
            highlights: Vec::new(),
        }
    }

    #[test]
    fn summary_counts_started_finished_time_and_words() {
        let mut a = book(1, "a", 0.0);
        a.reading_seconds = 10;
        a.words_read = 100;
        let mut b = book(2, "b", 50.0);
        b.reading_seconds = 20;
        b.words_read = 200;
        let mut c = book(3, "c", 99.0);
        c.reading_seconds = 30;
        c.words_read = 300;

        let summary = summarize_books(&[a, b, c]);
        assert_eq!(summary.total_books, 3);
        assert_eq!(summary.total_seconds, 60);
        assert_eq!(summary.total_words, 600);
        assert_eq!(summary.started, 2);
        assert_eq!(summary.finished, 1);
    }

    #[test]
    fn aggregate_range_filters_days_and_fills_hours_books_days() {
        let mut buckets = HashMap::new();
        buckets.insert((20260701, 1, 1), (30, 300));
        buckets.insert((20260701, 25, 2), (40, 400));
        buckets.insert((20260703, 2, 1), (50, 500));
        let books = vec![book(1, "alpha", 10.0), book(2, "beta", 20.0)];

        let range = aggregate_stats_range(&buckets, &books, 20260701, 20260702);
        assert_eq!(range.total_seconds, 70);
        assert_eq!(range.total_words, 700);
        assert_eq!(range.hours[1], 30);
        assert_eq!(range.hours[23], 40);
        assert_eq!(
            range.days,
            vec![DayStat {
                day: 20260701,
                seconds: 70,
                words: 700
            }]
        );
        assert_eq!(range.books[0].title, "beta");
        assert_eq!(range.books[1].title, "alpha");
    }

    #[test]
    fn aggregate_range_counts_highlights_notes_and_finished_books() {
        let mut buckets = HashMap::new();
        buckets.insert((20260702, 3, 1), (60, 600));
        let mut b = book(1, "done", 100.0);
        b.finished_day = 20260702;
        b.highlights = vec![
            HighlightStatInput {
                day: 20260702,
                has_note: false,
            },
            HighlightStatInput {
                day: 20260702,
                has_note: true,
            },
            HighlightStatInput {
                day: 20260703,
                has_note: true,
            },
        ];

        let range = aggregate_stats_range(&buckets, &[b], 20260702, 20260702);
        assert_eq!(range.finished_count, 1);
        assert_eq!(range.total_highlights, 2);
        assert_eq!(range.total_notes, 1);
        assert!(range.finished[0].finished);
        assert_eq!(range.books[0].highlights, 2);
        assert_eq!(range.books[0].notes, 1);
    }
}
