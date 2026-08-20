use super::{VocabEntry, VocabIn};

pub(super) fn add_in_memory(list: &mut Vec<VocabEntry>, entry: VocabIn, now: u64) {
    let word = entry.word.trim().to_string();
    if word.is_empty() {
        return;
    }
    if let Some(existing) = list
        .iter_mut()
        .find(|existing| existing.word == word && existing.lang == entry.lang)
    {
        existing.count += 1;
        existing.last_at = now;
        if !entry.def.is_empty() {
            existing.def = entry.def;
        }
        if !entry.def_en.is_empty() {
            existing.def_en = entry.def_en;
        }
        if !entry.phonetic.is_empty() {
            existing.phonetic = entry.phonetic;
        }
        if !entry.example.is_empty() {
            existing.example = entry.example;
        }
        if entry.book_id != 0 {
            existing.book_id = entry.book_id;
        }
        if !entry.book_title.is_empty() {
            existing.book_title = entry.book_title;
        }
        return;
    }

    list.push(VocabEntry {
        word,
        lang: entry.lang,
        def: entry.def,
        def_en: entry.def_en,
        phonetic: entry.phonetic,
        count: 1,
        added_at: now,
        last_at: now,
        level: 0,
        example: entry.example,
        book_id: entry.book_id,
        book_title: entry.book_title,
    });
}

pub(super) fn list_lang(entries: &[VocabEntry], lang: &str) -> Vec<VocabEntry> {
    let mut filtered: Vec<VocabEntry> = entries
        .iter()
        .filter(|entry| entry.lang == lang)
        .cloned()
        .collect();
    filtered.sort_by_key(|entry| std::cmp::Reverse(entry.last_at));
    filtered
}

pub(super) fn review_entries(entries: &[VocabEntry], lang: &str, now: u64) -> Vec<VocabEntry> {
    let mut reviewable: Vec<VocabEntry> = entries
        .iter()
        .filter(|entry| entry.lang == lang && entry.level < 2)
        .cloned()
        .collect();
    reviewable.sort_by(|a, b| {
        review_score(b, now)
            .cmp(&review_score(a, now))
            .then_with(|| a.last_at.cmp(&b.last_at))
    });
    reviewable.truncate(30);
    reviewable
}

pub(super) fn review_score(entry: &VocabEntry, now: u64) -> u64 {
    let age_days = now.saturating_sub(entry.last_at) / 86_400;
    let level_weight = match entry.level {
        0 => 80,
        1 => 25,
        _ => 0,
    };
    level_weight + (entry.count as u64 * 3) + age_days.min(30)
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
        let mut entries = Vec::new();
        add_in_memory(&mut entries, input(" recap ", "en", "old"), 100);
        let mut newer = input("recap", "en", "new");
        newer.phonetic = "ri:'kaep".to_string();
        newer.example = "A short recap.".to_string();
        newer.book_id = 7;
        newer.book_title = "Book".to_string();
        add_in_memory(&mut entries, newer, 200);

        assert_eq!(entries.len(), 1);
        let item = &entries[0];
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
        let entries = vec![
            entry("old", "en", 1, 10, 0),
            entry("zh", "zh", 1, 30, 0),
            entry("new", "en", 1, 20, 0),
        ];
        let words: Vec<String> = list_lang(&entries, "en")
            .into_iter()
            .map(|x| x.word)
            .collect();
        assert_eq!(words, vec!["new", "old"]);
    }

    #[test]
    fn review_ignores_mastered_words_and_prioritizes_unknown_frequent_old_items() {
        let now = 20 * 86_400;
        let entries = vec![
            entry("known", "en", 99, now, 2),
            entry("fresh", "en", 1, now, 0),
            entry("older", "en", 2, now - 10 * 86_400, 0),
            entry("seen", "en", 20, now - 86_400, 1),
        ];
        let words: Vec<String> = review_entries(&entries, "en", now)
            .into_iter()
            .map(|x| x.word)
            .collect();
        assert!(!words.contains(&"known".to_string()));
        assert_eq!(words.first().map(String::as_str), Some("older"));
        assert!(words.iter().position(|x| x == "seen") < words.iter().position(|x| x == "fresh"));
    }

    #[test]
    fn review_score_uses_oldest_entry_to_break_equal_scores_and_limits_the_result() {
        let now = 100 * 86_400;
        let mut entries = vec![
            entry("newer-tie", "en", 2, now, 0),
            entry("older-tie", "en", 1, now - 3 * 86_400, 0),
        ];
        entries.extend((0..30).map(|index| entry(&format!("word-{index}"), "en", 1, now, 0)));

        assert_eq!(
            review_score(&entries[0], now),
            review_score(&entries[1], now)
        );
        let review = review_entries(&entries, "en", now);
        assert_eq!(review.len(), 30);
        assert_eq!(
            review.first().map(|entry| entry.word.as_str()),
            Some("older-tie")
        );
    }
}
