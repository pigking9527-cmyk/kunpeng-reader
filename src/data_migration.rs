use crate::{book, stats_core::ReadBucket, vocab, AppState};

pub(crate) fn migrate_json_to_sqlite(state: &AppState) {
    let library_snapshot = state.library.lock().ok().map(|lib| {
        let settings = serde_json::json!({
            "main_geom": lib.main_geom,
            "reader_geom": lib.reader_geom,
            "reader_geom_pdf": lib.reader_geom_pdf,
            "auto_import_dirs": lib.auto_import_dirs,
            "auto_import_enabled": lib.auto_import_enabled,
        });
        (lib.books.clone(), settings)
    });
    let vocab_snapshot = state
        .vocab
        .lock()
        .ok()
        .map(|v| v.list.clone())
        .unwrap_or_default();
    let stats_snapshot: Vec<ReadBucket> = state
        .stats
        .lock()
        .ok()
        .map(|stats| {
            stats
                .map
                .iter()
                .map(|(&(day, hour, book), &(secs, words))| ReadBucket {
                    day,
                    hour,
                    book,
                    secs,
                    words,
                })
                .collect()
        })
        .unwrap_or_default();

    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    if let Some((books, settings)) = library_snapshot {
        for b in &books {
            if let Ok(v) = serde_json::to_value(b) {
                let _ = db.upsert_json("book", &b.id.to_string(), &v);
            }
            for (i, h) in b.highlights.iter().enumerate() {
                let v = serde_json::json!({
                    "book_id": b.id,
                    "book_title": b.title,
                    "highlight": h,
                });
                let _ = db.upsert_json("highlight", &format!("{}:{i}", b.id), &v);
                if !h.note.trim().is_empty() {
                    let _ = db.upsert_json("annotation", &format!("{}:{i}", b.id), &v);
                }
            }
            for (i, bm) in b.bookmarks.iter().enumerate() {
                let v = serde_json::json!({
                    "book_id": b.id,
                    "book_title": b.title,
                    "bookmark": bm,
                });
                let _ = db.upsert_json("bookmark", &format!("{}:{i}", b.id), &v);
            }
        }
        let _ = db.upsert_json("settings", "library", &settings);
    }
    for e in &vocab_snapshot {
        if let Ok(v) = serde_json::to_value(e) {
            let _ = db.upsert_json("vocab", &format!("{}:{}", e.lang, e.word), &v);
        }
    }
    for bucket in &stats_snapshot {
        if let Ok(v) = serde_json::to_value(bucket) {
            let _ = db.upsert_json(
                "reading_bucket",
                &format!("{}:{}:{}", bucket.day, bucket.hour, bucket.book),
                &v,
            );
        }
    }
}

pub(crate) fn apply_sqlite_to_runtime(state: &AppState) {
    let Ok(db_guard) = state.db.lock() else {
        return;
    };
    let Some(db) = db_guard.as_ref() else { return };
    let Ok(items) = db.all_sync_entities() else {
        return;
    };
    let mut books: Vec<book::Book> = Vec::new();
    let mut vocab: Vec<vocab::VocabEntry> = Vec::new();
    let mut buckets: Vec<ReadBucket> = Vec::new();
    for item in items {
        if item.deleted_at != 0 {
            continue;
        }
        match item.kind.as_str() {
            "book" => {
                if let Ok(b) = serde_json::from_value::<book::Book>(item.json.clone()) {
                    books.push(b);
                }
            }
            "vocab" => {
                if let Ok(v) = serde_json::from_value::<vocab::VocabEntry>(item.json.clone()) {
                    vocab.push(v);
                }
            }
            "reading_bucket" => {
                if let Ok(b) = serde_json::from_value::<ReadBucket>(item.json.clone()) {
                    buckets.push(b);
                }
            }
            _ => {}
        }
    }
    if !books.is_empty() {
        if let Ok(mut lib) = state.library.lock() {
            books.sort_by(|a, b| {
                b.last_read_at
                    .cmp(&a.last_read_at)
                    .then_with(|| a.title.cmp(&b.title))
            });
            lib.books = books;
            lib.save();
        }
    }
    if let Ok(mut vs) = state.vocab.lock() {
        vs.list = vocab;
        vs.save();
    }
    if let Ok(mut st) = state.stats.lock() {
        st.map.clear();
        for b in buckets {
            st.map.insert((b.day, b.hour, b.book), (b.secs, b.words));
        }
        st.dirty = true;
        st.save();
    }
}
