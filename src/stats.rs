use crate::book::Library;
use crate::stats_core::{
    aggregate_stats_range, summarize_books, BookStatInput, HighlightStatInput, ReadBucket,
    StatsRange, StatsSummary,
};
use crate::{window_commands::reader_window_id, AppState};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::Manager;

static READING_STATS_SAVE_SCHEDULED: AtomicBool = AtomicBool::new(false);
static READING_STATS_SAVE_EPOCH: AtomicU64 = AtomicU64::new(0);

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

    pub(crate) fn save(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        let p = stats_path().ok_or("无法确定统计数据路径")?;
        self.save_to(&p)
    }

    fn save_to(&mut self, path: &std::path::Path) -> Result<(), String> {
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
        crate::atomic_file::write_json(path, &v, false)?;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_save_keeps_dirty_until_a_successful_retry() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-stats-test-{}-{}",
            std::process::id(),
            READING_STATS_SAVE_EPOCH.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let blocked_parent = root.join("not-a-directory");
        std::fs::write(&blocked_parent, b"file").unwrap();

        let mut store = StatsStore::default();
        store.map.insert((20260710, 12, 7), (60, 1000));
        store.dirty = true;
        assert!(store.save_to(&blocked_parent.join("stats.json")).is_err());
        assert!(store.dirty);

        store.save_to(&root.join("stats.json")).unwrap();
        assert!(!store.dirty);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn schedule_reading_stats_save(app: tauri::AppHandle) {
    READING_STATS_SAVE_EPOCH.fetch_add(1, Ordering::AcqRel);
    if READING_STATS_SAVE_SCHEDULED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    std::thread::spawn(move || loop {
        let before_wait = READING_STATS_SAVE_EPOCH.load(Ordering::Acquire);
        std::thread::sleep(Duration::from_secs(5));
        if app
            .webview_windows()
            .keys()
            .any(|label| label.starts_with("reader-"))
        {
            std::thread::sleep(Duration::from_secs(25));
            continue;
        }
        {
            let state = app.state::<AppState>();
            crate::report_save_error("书架", state.library.lock().unwrap().save());
            crate::report_save_error("统计", state.stats.lock().unwrap().save());
        }
        let after_save = READING_STATS_SAVE_EPOCH.load(Ordering::Acquire);
        READING_STATS_SAVE_SCHEDULED.store(false, Ordering::Release);
        if after_save == before_wait {
            break;
        }
        if READING_STATS_SAVE_SCHEDULED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            break;
        }
    });
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
        }
        state.stats.lock().unwrap().add(id, seconds as u32, 0); // 累进当前小时桶
        schedule_reading_stats_save(window.app_handle().clone());
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
        }
        state.stats.lock().unwrap().add(id, 0, words as u32);
        schedule_reading_stats_save(window.app_handle().clone());
    }
    Ok(())
}
