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
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct StatsRange {
    pub total_seconds: u64,
    pub total_words: u64,
    pub hours: Vec<u64>,
    pub days: Vec<DayStat>,
    pub books: Vec<BookStat>,
    pub finished: Vec<BookStat>,
    pub book_count: u32,
    pub finished_count: u32,
    pub total_highlights: u32,
    pub total_notes: u32,
}

pub fn summarize_books(books: &[BookStatInput]) -> StatsSummary {
    let mut out = StatsSummary {
        total_seconds: 0,
        total_words: 0,
        total_books: books.len() as u32,
        started: 0,
        finished: 0,
    };
    for b in books {
        out.total_seconds += b.reading_seconds;
        out.total_words += b.words_read;
        if b.progress > 0.5 {
            out.started += 1;
        }
        if b.progress >= 99.0 {
            out.finished += 1;
        }
    }
    out
}

pub fn aggregate_stats_range(
    buckets: &HashMap<(u32, u8, u64), (u32, u32)>,
    books: &[BookStatInput],
    from: u32,
    to: u32,
) -> StatsRange {
    let mut hours = vec![0u64; 24];
    let mut per_book: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut per_day: HashMap<u32, u64> = HashMap::new();
    let mut total_seconds = 0u64;
    let mut total_words = 0u64;
    for (&(day, hour, book), &(secs, words)) in buckets.iter() {
        if day < from || day > to {
            continue;
        }
        total_seconds += secs as u64;
        total_words += words as u64;
        hours[hour.min(23) as usize] += secs as u64;
        *per_day.entry(day).or_insert(0) += secs as u64;
        let e = per_book.entry(book).or_insert((0, 0));
        e.0 += secs as u64;
        e.1 += words as u64;
    }

    let mut title_by_id: HashMap<u64, String> = HashMap::new();
    let mut hl_count: HashMap<u64, (u32, u32)> = HashMap::new();
    let mut total_highlights = 0u32;
    let mut total_notes = 0u32;
    let mut finished_in_range: HashSet<u64> = HashSet::new();

    for b in books {
        title_by_id.insert(b.id, b.title.clone());
        for h in &b.highlights {
            if h.day >= from && h.day <= to {
                let e = hl_count.entry(b.id).or_insert((0, 0));
                e.0 += 1;
                total_highlights += 1;
                if h.has_note {
                    e.1 += 1;
                    total_notes += 1;
                }
            }
        }
        if b.finished_day >= from && b.finished_day <= to {
            finished_in_range.insert(b.id);
        }
    }

    let make_book = |id: u64, secs: u64, words: u64| {
        let (highlights, notes) = hl_count.get(&id).copied().unwrap_or((0, 0));
        BookStat {
            id: id.to_string(),
            title: title_by_id
                .get(&id)
                .cloned()
                .unwrap_or_else(|| "（已删除）".to_string()),
            seconds: secs,
            words,
            highlights,
            notes,
            finished: finished_in_range.contains(&id),
        }
    };

    let mut books_out: Vec<BookStat> = per_book
        .iter()
        .map(|(&id, &(seconds, words))| make_book(id, seconds, words))
        .collect();
    books_out.sort_by(|a, b| {
        b.seconds
            .cmp(&a.seconds)
            .then_with(|| a.title.cmp(&b.title))
    });

    let mut finished: Vec<BookStat> = finished_in_range
        .iter()
        .map(|&id| {
            let (seconds, words) = per_book.get(&id).copied().unwrap_or((0, 0));
            make_book(id, seconds, words)
        })
        .collect();
    finished.sort_by(|a, b| a.title.cmp(&b.title));

    let mut days: Vec<DayStat> = per_day
        .into_iter()
        .map(|(day, seconds)| DayStat { day, seconds })
        .collect();
    days.sort_by_key(|d| d.day);

    StatsRange {
        total_seconds,
        total_words,
        hours,
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

        let s = summarize_books(&[a, b, c]);
        assert_eq!(s.total_books, 3);
        assert_eq!(s.total_seconds, 60);
        assert_eq!(s.total_words, 600);
        assert_eq!(s.started, 2);
        assert_eq!(s.finished, 1);
    }

    #[test]
    fn aggregate_range_filters_days_and_fills_hours_books_days() {
        let mut buckets = HashMap::new();
        buckets.insert((20260701, 1, 1), (30, 300));
        buckets.insert((20260701, 25, 2), (40, 400));
        buckets.insert((20260703, 2, 1), (50, 500));
        let books = vec![book(1, "alpha", 10.0), book(2, "beta", 20.0)];

        let r = aggregate_stats_range(&buckets, &books, 20260701, 20260702);
        assert_eq!(r.total_seconds, 70);
        assert_eq!(r.total_words, 700);
        assert_eq!(r.hours[1], 30);
        assert_eq!(r.hours[23], 40);
        assert_eq!(
            r.days,
            vec![DayStat {
                day: 20260701,
                seconds: 70
            }]
        );
        assert_eq!(r.books[0].title, "beta");
        assert_eq!(r.books[1].title, "alpha");
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

        let r = aggregate_stats_range(&buckets, &[b], 20260702, 20260702);
        assert_eq!(r.finished_count, 1);
        assert_eq!(r.total_highlights, 2);
        assert_eq!(r.total_notes, 1);
        assert!(r.finished[0].finished);
        assert_eq!(r.books[0].highlights, 2);
        assert_eq!(r.books[0].notes, 1);
    }
}
