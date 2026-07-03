use crate::{book, AppState};
use serde::{Deserialize, Serialize};

// ---- 生词本：记录查过的词（中/英分开），同词不重复、累计次数 ----
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct VocabEntry {
    pub(crate) word: String,
    pub(crate) lang: String, // "zh" / "en"
    #[serde(default)]
    pub(crate) def: String,
    #[serde(default)]
    pub(crate) def_en: String,
    #[serde(default)]
    pub(crate) phonetic: String,
    #[serde(default)]
    pub(crate) count: u32,
    #[serde(default)]
    pub(crate) added_at: u64,
    #[serde(default)]
    pub(crate) last_at: u64,
    #[serde(default)]
    pub(crate) level: u8, // 0=陌生, 1=认识, 2=掌握
    #[serde(default)]
    pub(crate) example: String,
    #[serde(default)]
    pub(crate) book_id: u64,
    #[serde(default)]
    pub(crate) book_title: String,
}

#[derive(Default)]
pub(crate) struct VocabStore {
    pub(crate) list: Vec<VocabEntry>,
}

impl VocabStore {
    fn file() -> Option<std::path::PathBuf> {
        let mut d = dirs::config_dir()?;
        d.push("ebook-reader");
        Some(d.join("vocab.json"))
    }
    pub(crate) fn load() -> Self {
        let list = Self::file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<Vec<VocabEntry>>(&t).ok())
            .unwrap_or_default();
        Self { list }
    }
    pub(crate) fn save(&self) {
        let Some(f) = Self::file() else { return };
        if let Some(p) = f.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Ok(t) = serde_json::to_string(&self.list) {
            let _ = std::fs::write(f, t);
        }
    }
    fn add(&mut self, e: VocabIn) {
        self.add_in_memory(e, book::now_secs());
        self.save();
    }
    fn add_in_memory(&mut self, e: VocabIn, now: u64) {
        let word = e.word.trim().to_string();
        if word.is_empty() {
            return;
        }
        if let Some(x) = self
            .list
            .iter_mut()
            .find(|x| x.word == word && x.lang == e.lang)
        {
            x.count += 1;
            x.last_at = now;
            if !e.def.is_empty() {
                x.def = e.def;
            }
            if !e.def_en.is_empty() {
                x.def_en = e.def_en;
            }
            if !e.phonetic.is_empty() {
                x.phonetic = e.phonetic;
            }
            if !e.example.is_empty() {
                x.example = e.example;
            }
            if e.book_id != 0 {
                x.book_id = e.book_id;
            }
            if !e.book_title.is_empty() {
                x.book_title = e.book_title;
            }
        } else {
            self.list.push(VocabEntry {
                word,
                lang: e.lang,
                def: e.def,
                def_en: e.def_en,
                phonetic: e.phonetic,
                count: 1,
                added_at: now,
                last_at: now,
                level: 0,
                example: e.example,
                book_id: e.book_id,
                book_title: e.book_title,
            });
        }
    }
    fn remove(&mut self, word: &str, lang: &str) {
        self.list.retain(|x| !(x.word == word && x.lang == lang));
        self.save();
    }
    fn list_lang(&self, lang: &str) -> Vec<VocabEntry> {
        let mut v: Vec<VocabEntry> = self
            .list
            .iter()
            .filter(|x| x.lang == lang)
            .cloned()
            .collect();
        v.sort_by(|a, b| b.last_at.cmp(&a.last_at)); // 最近查的在前
        v
    }
    fn set_level(&mut self, word: &str, lang: &str, level: u8) {
        if let Some(x) = self
            .list
            .iter_mut()
            .find(|x| x.word == word && x.lang == lang)
        {
            x.level = level.min(2);
            self.save();
        }
    }
    fn review(&self, lang: &str) -> Vec<VocabEntry> {
        let now = book::now_secs();
        let mut v: Vec<VocabEntry> = self
            .list
            .iter()
            .filter(|x| x.lang == lang && x.level < 2)
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            let sa = review_score(a, now);
            let sb = review_score(b, now);
            sb.cmp(&sa).then_with(|| a.last_at.cmp(&b.last_at))
        });
        v.truncate(30);
        v
    }
}

fn review_score(e: &VocabEntry, now: u64) -> u64 {
    let age_days = now.saturating_sub(e.last_at) / 86_400;
    let level_weight = match e.level {
        0 => 80,
        1 => 25,
        _ => 0,
    };
    level_weight + (e.count as u64 * 3) + age_days.min(30)
}

#[derive(Deserialize)]
pub(crate) struct VocabIn {
    pub(crate) word: String,
    pub(crate) lang: String,
    #[serde(default)]
    pub(crate) def: String,
    #[serde(default)]
    pub(crate) def_en: String,
    #[serde(default)]
    pub(crate) phonetic: String,
    #[serde(default)]
    pub(crate) example: String,
    #[serde(default)]
    pub(crate) book_id: u64,
    #[serde(default)]
    pub(crate) book_title: String,
}

#[tauri::command]
pub(crate) fn vocab_add(state: tauri::State<AppState>, entry: VocabIn) {
    state.vocab.lock().unwrap().add(entry);
}

#[tauri::command]
pub(crate) fn vocab_list(state: tauri::State<AppState>, lang: String) -> Vec<VocabEntry> {
    state.vocab.lock().unwrap().list_lang(&lang)
}

#[tauri::command]
pub(crate) fn vocab_remove(
    state: tauri::State<AppState>,
    word: String,
    lang: String,
) -> Vec<VocabEntry> {
    let mut v = state.vocab.lock().unwrap();
    v.remove(&word, &lang);
    v.list_lang(&lang)
}

#[tauri::command]
pub(crate) fn vocab_set_level(
    state: tauri::State<AppState>,
    word: String,
    lang: String,
    level: u8,
) -> Vec<VocabEntry> {
    let mut v = state.vocab.lock().unwrap();
    v.set_level(&word, &lang, level);
    v.list_lang(&lang)
}

#[tauri::command]
pub(crate) fn vocab_review(state: tauri::State<AppState>, lang: String) -> Vec<VocabEntry> {
    state.vocab.lock().unwrap().review(&lang)
}

#[derive(Serialize)]
pub(crate) struct BookNotesSummary {
    id: u64,
    title: String,
    highlights: Vec<book::Highlight>,
    vocab: Vec<VocabEntry>,
}

#[tauri::command]
pub(crate) fn notes_summary(state: tauri::State<AppState>) -> Vec<BookNotesSummary> {
    let books = state.library.lock().unwrap().books.clone();
    let vocab = state.vocab.lock().unwrap().list.clone();
    let mut out = Vec::new();
    for b in books {
        let words: Vec<VocabEntry> = vocab
            .iter()
            .filter(|v| v.book_id == b.id || (!v.book_title.is_empty() && v.book_title == b.title))
            .cloned()
            .collect();
        if b.highlights.is_empty() && words.is_empty() {
            continue;
        }
        out.push(BookNotesSummary {
            id: b.id,
            title: b.title,
            highlights: b.highlights,
            vocab: words,
        });
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(word: &str, lang: &str, def: &str) -> VocabIn {
        VocabIn {
            word: word.to_string(),
            lang: lang.to_string(),
            def: def.to_string(),
            def_en: String::new(),
            phonetic: String::new(),
            example: String::new(),
            book_id: 0,
            book_title: String::new(),
        }
    }

    fn entry(word: &str, lang: &str, count: u32, last_at: u64, level: u8) -> VocabEntry {
        VocabEntry {
            word: word.to_string(),
            lang: lang.to_string(),
            def: String::new(),
            def_en: String::new(),
            phonetic: String::new(),
            count,
            added_at: last_at,
            last_at,
            level,
            example: String::new(),
            book_id: 0,
            book_title: String::new(),
        }
    }

    #[test]
    fn add_in_memory_merges_same_word_and_keeps_non_empty_updates() {
        let mut store = VocabStore::default();
        store.add_in_memory(input(" recap ", "en", "old"), 100);
        let mut newer = input("recap", "en", "new");
        newer.phonetic = "ri:'kaep".to_string();
        newer.example = "A short recap.".to_string();
        newer.book_id = 7;
        newer.book_title = "Book".to_string();
        store.add_in_memory(newer, 200);

        assert_eq!(store.list.len(), 1);
        let item = &store.list[0];
        assert_eq!(item.word, "recap");
        assert_eq!(item.count, 2);
        assert_eq!(item.def, "new");
        assert_eq!(item.phonetic, "ri:'kaep");
        assert_eq!(item.example, "A short recap.");
        assert_eq!(item.book_id, 7);
        assert_eq!(item.last_at, 200);
        assert_eq!(item.added_at, 100);
    }

    #[test]
    fn list_lang_filters_language_and_sorts_recent_first() {
        let store = VocabStore {
            list: vec![
                entry("old", "en", 1, 10, 0),
                entry("zh", "zh", 1, 30, 0),
                entry("new", "en", 1, 20, 0),
            ],
        };
        let words: Vec<String> = store.list_lang("en").into_iter().map(|x| x.word).collect();
        assert_eq!(words, vec!["new", "old"]);
    }

    #[test]
    fn review_ignores_mastered_words_and_prioritizes_unknown_frequent_old_items() {
        let now = book::now_secs();
        let store = VocabStore {
            list: vec![
                entry("known", "en", 99, now, 2),
                entry("fresh", "en", 1, now, 0),
                entry("older", "en", 2, now.saturating_sub(10 * 86_400), 0),
                entry("seen", "en", 20, now.saturating_sub(86_400), 1),
            ],
        };
        let words: Vec<String> = store.review("en").into_iter().map(|x| x.word).collect();
        assert!(!words.contains(&"known".to_string()));
        assert_eq!(words.first().map(String::as_str), Some("older"));
        assert!(words.iter().position(|x| x == "seen") < words.iter().position(|x| x == "fresh"));
    }
}
