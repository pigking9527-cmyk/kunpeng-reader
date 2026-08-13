use crate::{book, AppState};
use serde::{Deserialize, Serialize};

mod rules;

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

#[derive(Clone, Default)]
pub(crate) struct VocabStore {
    pub(crate) list: Vec<VocabEntry>,
}

impl VocabStore {
    fn file() -> Option<std::path::PathBuf> {
        let d = crate::profile::app_config_dir()?;
        Some(d.join("vocab.json"))
    }
    pub(crate) fn load() -> Self {
        let list = Self::file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<Vec<VocabEntry>>(&t).ok())
            .unwrap_or_default();
        Self { list }
    }
    pub(crate) fn save(&self) -> Result<(), String> {
        let f = Self::file().ok_or("无法确定生词本数据路径")?;
        crate::atomic_file::write_json(&f, &self.list, false)
    }
    fn add(&mut self, e: VocabIn) -> Result<(), String> {
        rules::add_in_memory(&mut self.list, e, book::now_secs());
        self.save()
    }
    fn remove(&mut self, word: &str, lang: &str) -> Result<(), String> {
        self.list.retain(|x| !(x.word == word && x.lang == lang));
        self.save()
    }
    fn list_lang(&self, lang: &str) -> Vec<VocabEntry> {
        rules::list_lang(&self.list, lang)
    }
    fn set_level(&mut self, word: &str, lang: &str, level: u8) -> Result<(), String> {
        if let Some(x) = self
            .list
            .iter_mut()
            .find(|x| x.word == word && x.lang == lang)
        {
            x.level = level.min(2);
            self.save()?;
        }
        Ok(())
    }
    fn review(&self, lang: &str) -> Vec<VocabEntry> {
        rules::review_entries(&self.list, lang, book::now_secs())
    }
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
pub(crate) fn vocab_add(state: tauri::State<AppState>, entry: VocabIn) -> Result<(), String> {
    state.vocab.lock().unwrap().add(entry)
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
) -> Result<Vec<VocabEntry>, String> {
    let mut v = state.vocab.lock().unwrap();
    v.remove(&word, &lang)?;
    Ok(v.list_lang(&lang))
}

#[tauri::command]
pub(crate) fn vocab_set_level(
    state: tauri::State<AppState>,
    word: String,
    lang: String,
    level: u8,
) -> Result<Vec<VocabEntry>, String> {
    let mut v = state.vocab.lock().unwrap();
    v.set_level(&word, &lang, level)?;
    Ok(v.list_lang(&lang))
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
