use crate::book::Library;
use crate::stats_core::{
    aggregate_stats_range, summarize_books, BookStatInput, HighlightStatInput, ReadBucket,
    StatsRange, StatsSummary,
};
use crate::{reader_window_id, AppState};
use std::collections::HashMap;

fn unix_to_local_day(secs: u64) -> u32 {
    use chrono::{Datelike, Local, TimeZone};
    match Local.timestamp_opt(secs as i64, 0).single() {
        Some(t) => t.year() as u32 * 10000 + t.month() * 100 + t.day(),
        None => 0,
    }
}

fn stats_book_inputs(lib: &Library) -> Vec<BookStatInput> {
    lib.books
        .iter()
        .map(|b| BookStatInput {
            id: b.id,
            title: b.title.clone(),
            reading_seconds: b.reading_seconds,
            words_read: b.words_read,
            progress: b.progress,
            finished_day: if b.finished_at > 0 {
                unix_to_local_day(b.finished_at)
            } else {
                0
            },
            highlights: b
                .highlights
                .iter()
                .map(|h| HighlightStatInput {
                    day: unix_to_local_day(h.created_at),
                    has_note: !h.note.trim().is_empty(),
                })
                .collect(),
        })
        .collect()
}

/// 全局阅读统计，给书架主窗口展示。
#[tauri::command]
pub(crate) fn reading_stats(state: tauri::State<AppState>) -> StatsSummary {
    let inputs = {
        let lib = state.library.lock().unwrap();
        stats_book_inputs(&lib)
    };
    summarize_books(&inputs)
}

#[derive(Default)]
pub(crate) struct StatsStore {
    pub(crate) map: HashMap<(u32, u8, u64), (u32, u32)>, // (day,hour,book) -> (secs,words)
    pub(crate) dirty: bool,
}

fn stats_path() -> Option<std::path::PathBuf> {
    let mut d = dirs::config_dir()?; // 和 library.json 同处（%APPDATA%），属持久用户数据
    d.push("ebook-reader");
    Some(d.join("stats.json"))
}

fn local_day_hour() -> (u32, u8) {
    use chrono::{Datelike, Local, Timelike};
    let n = Local::now();
    (
        n.year() as u32 * 10000 + n.month() * 100 + n.day(),
        n.hour() as u8,
    )
}

impl StatsStore {
    pub(crate) fn load() -> Self {
        let mut s = StatsStore::default();
        if let Some(p) = stats_path() {
            if let Ok(txt) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Vec<ReadBucket>>(&txt) {
                    for b in v {
                        s.map.insert((b.day, b.hour, b.book), (b.secs, b.words));
                    }
                }
            }
        }
        s
    }

    pub(crate) fn add(&mut self, book: u64, secs: u32, words: u32) {
        let (day, hour) = local_day_hour();
        let e = self.map.entry((day, hour, book)).or_insert((0, 0));
        e.0 = e.0.saturating_add(secs);
        e.1 = e.1.saturating_add(words);
        self.dirty = true;
    }

    pub(crate) fn save(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(p) = stats_path() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let v: Vec<ReadBucket> = self
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
            if let Ok(j) = serde_json::to_string(&v) {
                let _ = std::fs::write(p, j);
            }
        }
        self.dirty = false;
    }
}

/// 按本地日期区间 [from,to]（yyyymmdd）聚合阅读统计。日/月/年/总都用它，前端算好区间即可。
#[tauri::command]
pub(crate) fn reading_stats_range(state: tauri::State<AppState>, from: u32, to: u32) -> StatsRange {
    let buckets = {
        let stats = state.stats.lock().unwrap();
        stats.map.clone()
    };
    let books = {
        let lib = state.library.lock().unwrap();
        stats_book_inputs(&lib)
    };
    aggregate_stats_range(&buckets, &books, from, to)
}

/// 阅读窗口定时上报阅读时长（秒）。
#[tauri::command]
pub(crate) async fn add_reading_time(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    seconds: u64,
) -> Result<(), ()> {
    if let Some(id) = reader_window_id(&window) {
        {
            let mut lib = state.library.lock().unwrap();
            if let Some(b) = lib.books.iter_mut().find(|b| b.id == id) {
                b.reading_seconds += seconds;
            }
            lib.save();
        }
        let mut st = state.stats.lock().unwrap();
        st.add(id, seconds as u32, 0); // 累进当前小时桶
        st.save(); // 15 秒一次，文件很小
    }
    Ok(())
}

/// 阅读窗口上报"真正读过"的字数：仅停留若干秒、且逐页翻过的页才会累加（前端判定）。
#[tauri::command]
pub(crate) async fn add_read_words(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    words: u64,
) -> Result<(), ()> {
    if words == 0 {
        return Ok(());
    }
    if let Some(id) = reader_window_id(&window) {
        {
            let mut lib = state.library.lock().unwrap();
            if let Some(b) = lib.books.iter_mut().find(|b| b.id == id) {
                b.words_read += words;
            }
            lib.save();
        }
        state.stats.lock().unwrap().add(id, 0, words as u32); // 累进字数（落盘交给 15s 的 add_reading_time）
    }
    Ok(())
}
