use crate::{book, db::SyncEntity, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) const BOOKLIST_KIND_V1: &str = "booklist_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BooklistItemV1 {
    content_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    review: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BooklistV1 {
    version: u8,
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover_content_id: Option<String>,
    #[serde(default)]
    items: Vec<BooklistItemV1>,
}

fn clipped_text(value: &str, limit: usize) -> String {
    crate::html_sanitize::html_to_plain_text(value)
        .trim()
        .chars()
        .take(limit)
        .collect()
}

fn payload_from_list(library: &book::Library, list: &book::BookList) -> BooklistV1 {
    let mut seen = HashSet::new();
    let items = list
        .book_order
        .iter()
        .filter_map(|id| library.get(*id))
        .filter(|entry| !entry.content_id.trim().is_empty())
        .filter(|entry| seen.insert(entry.content_id.clone()))
        .map(|entry| BooklistItemV1 {
            content_id: entry.content_id.clone(),
            review: list
                .reviews
                .get(&entry.id)
                .map(|value| clipped_text(value, 1000))
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let cover_content_id = library
        .get(list.cover_book_id)
        .and_then(|book| (!book.content_id.trim().is_empty()).then(|| book.content_id.clone()));
    BooklistV1 {
        version: 1,
        id: list.id.clone(),
        name: clipped_text(&list.name, 96),
        description: clipped_text(&list.description, 1000),
        cover_content_id,
        items,
    }
}

fn merge_known_payload(existing: Option<Value>, payload: &BooklistV1) -> Result<Value, String> {
    let patch = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    let mut next = existing.unwrap_or_else(|| json!({}));
    if !next.is_object() {
        next = json!({});
    }
    let target = next.as_object_mut().expect("object guarded above");
    for (key, value) in patch.as_object().expect("serialized object") {
        target.insert(key.clone(), value.clone());
    }
    Ok(next)
}

/// Upsert one presentation entity. Existing future-client fields are retained.
pub(crate) fn persist_booklist(state: &AppState, list_id: &str) -> Result<(), String> {
    let (id, payload) = {
        let mut library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        library.reconcile_booklists();
        let list = library
            .booklists
            .iter()
            .find(|list| list.id == list_id)
            .cloned()
            .ok_or("找不到书单")?;
        (list.id.clone(), payload_from_list(&library, &list))
    };
    state.with_db_write("persist_booklist", |db| {
        let value = merge_known_payload(db.entity_json(BOOKLIST_KIND_V1, &id)?, &payload)?;
        db.upsert_json_batch(&[(BOOKLIST_KIND_V1.to_string(), id, value)])
    })
}

/// Persist every local booklist after a collection-level edit.  Booklist
/// membership remains its own entity, while this keeps list names, order and
/// reviews in step with it.
pub(crate) fn persist_all_booklists(state: &AppState) -> Result<(), String> {
    let ids = {
        let mut library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        library.reconcile_booklists();
        library
            .booklists
            .iter()
            .map(|list| list.id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        persist_booklist(state, &id)?;
    }
    Ok(())
}

/// Seed current local booklists once without overwriting an already downloaded
/// entity. This keeps pre-ADR booklist descriptions and manual order.
pub(crate) fn seed_local_booklists(state: &AppState) -> Result<(), String> {
    let lists = {
        let mut library = state
            .library
            .lock()
            .map_err(|_| "书架锁定失败".to_string())?;
        library.reconcile_booklists();
        library
            .booklists
            .iter()
            .map(|list| (list.id.clone(), payload_from_list(&library, list)))
            .collect::<Vec<_>>()
    };
    if lists.is_empty() {
        return Ok(());
    }
    state.with_db_write("seed_local_booklists", |db| {
        let mut batch = Vec::new();
        for (id, payload) in lists {
            if db.entity_json(BOOKLIST_KIND_V1, &id)?.is_none() {
                batch.push((
                    BOOKLIST_KIND_V1.to_string(),
                    id,
                    serde_json::to_value(payload).map_err(|error| error.to_string())?,
                ));
            }
        }
        if batch.is_empty() {
            Ok(())
        } else {
            db.upsert_json_batch(&batch)
        }
    })
}

pub(crate) fn tombstone_booklist(state: &AppState, list_id: &str) -> Result<(), String> {
    state.with_db_write("tombstone_booklist", |db| {
        db.soft_delete(BOOKLIST_KIND_V1, list_id)
    })
}

/// Apply only durable presentation data to books already present locally.
/// Membership is separately projected from `book_collections_v1`.
pub(crate) fn apply_downloaded_booklists(
    library: &mut book::Library,
    entities: &[SyncEntity],
) -> bool {
    let by_content = library
        .books
        .iter()
        .filter(|book| !book.content_id.trim().is_empty())
        .map(|book| (book.content_id.clone(), book.id))
        .collect::<HashMap<_, _>>();
    let mut changed = false;
    let deleted_ids = entities
        .iter()
        .filter(|entity| entity.kind == BOOKLIST_KIND_V1 && entity.deleted_at != 0)
        .map(|entity| entity.id.as_str())
        .collect::<HashSet<_>>();
    if !deleted_ids.is_empty() {
        let before = library.booklists.len();
        library
            .booklists
            .retain(|list| !deleted_ids.contains(list.id.as_str()));
        changed |= library.booklists.len() != before;
    }
    for entity in entities
        .iter()
        .filter(|entity| entity.kind == BOOKLIST_KIND_V1 && entity.deleted_at == 0)
    {
        let Ok(remote) = serde_json::from_value::<BooklistV1>(entity.json.clone()) else {
            continue;
        };
        if remote.version != 1 || remote.id.trim().is_empty() || remote.name.trim().is_empty() {
            continue;
        }
        let name = book::normalize_organization_names(vec![remote.name.clone()])
            .into_iter()
            .next()
            .unwrap_or_else(|| remote.name.trim().chars().take(96).collect());
        if name.is_empty() {
            continue;
        }
        let index = library
            .booklists
            .iter()
            .position(|list| list.id == remote.id)
            .or_else(|| {
                library
                    .booklists
                    .iter()
                    .position(|list| list.name.eq_ignore_ascii_case(&name))
            });
        let mut seen = HashSet::new();
        let mut order = Vec::new();
        let mut reviews = BTreeMap::new();
        for item in remote.items.iter().take(500) {
            let Some(local_id) = by_content.get(&item.content_id).copied() else {
                continue;
            };
            if seen.insert(local_id) {
                order.push(local_id);
                let review = clipped_text(&item.review, 1000);
                if !review.is_empty() {
                    reviews.insert(local_id, review);
                }
            }
        }
        let cover = remote
            .cover_content_id
            .as_ref()
            .and_then(|content_id| by_content.get(content_id).copied())
            .filter(|id| order.contains(id))
            .unwrap_or_else(|| order.first().copied().unwrap_or(0));
        let description = clipped_text(&remote.description, 1000);
        if let Some(index) = index {
            let list = &mut library.booklists[index];
            if list.id != remote.id
                || list.name != name
                || list.description != description
                || list.cover_book_id != cover
                || list.book_order != order
                || list.reviews != reviews
                || !list.saved
            {
                list.id = remote.id;
                list.name = name;
                list.description = description;
                list.cover_book_id = cover;
                list.book_order = order;
                list.reviews = reviews;
                list.saved = true;
                changed = true;
            }
        } else {
            library.booklists.push(book::BookList {
                id: remote.id,
                name,
                description,
                cover_book_id: cover,
                book_order: order,
                reviews,
                saved: true,
            });
            changed = true;
        }
    }
    changed
}
