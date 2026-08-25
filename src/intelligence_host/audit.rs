//! Bounded, read-only per-article audit projection for the loopback host page.
//!
//! It intentionally exposes the operator-visible processing state, rather than
//! article bodies, source URLs, raw model prompts/reasons, vectors or any local
//! archive path.  The processing workstation can therefore investigate why a
//! story is waiting or was grouped without turning its control page into an
//! unbounded archive browser.

use crate::archive;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

const PAGE_SIZE: usize = 24;
const MAX_HANDLE_BYTES: usize = 160;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArticleAuditList {
    pub items: Vec<ArticleAuditItem>,
    pub limit: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArticleAuditItem {
    pub handle: String,
    pub title: String,
    pub source: String,
    pub published_at: Option<String>,
    pub triage_state: String,
    pub full_text: StageCount,
    pub media: MediaCount,
    pub dedupe: DedupeState,
    pub semantic: SemanticState,
    pub editorial: EditorialState,
    pub publication: PublicationState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArticleAuditDetail {
    #[serde(flatten)]
    pub item: ArticleAuditItem,
    pub triage: TriageState,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageCount {
    pub status: String,
    pub versions: i64,
    pub paragraphs: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaCount {
    pub images: i64,
    pub videos: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DedupeState {
    pub role: String,
    pub aliases: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SemanticState {
    pub vector_ready: bool,
    pub vector_dimensions: Option<i64>,
    pub relation_candidates: i64,
    pub relation_state: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditorialState {
    pub state: String,
    pub event_linked: bool,
    pub event_title: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicationState {
    pub state: String,
    pub day: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TriageState {
    pub state: String,
    pub model: Option<String>,
    pub importance: Option<i64>,
    pub confidence_percent: Option<i64>,
}

pub(super) fn list_articles() -> Result<ArticleAuditList, String> {
    let connection = open_catalog()?;
    let mut statement = connection
        .prepare(
            "SELECT article_id FROM intelligence_articles
             ORDER BY updated_at DESC, created_at DESC LIMIT ?1",
        )
        .map_err(|_| "无法读取本机新闻审计队列".to_string())?;
    let ids = statement
        .query_map([PAGE_SIZE as i64], |row| row.get::<_, String>(0))
        .map_err(|_| "无法读取本机新闻审计队列".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取本机新闻审计队列".to_string())?;
    let items = ids
        .into_iter()
        .filter_map(|article_id| load_item(&connection, &article_id).ok())
        .collect();
    Ok(ArticleAuditList {
        items,
        limit: PAGE_SIZE,
    })
}

pub(super) fn article_detail(handle: &str) -> Result<ArticleAuditDetail, String> {
    let article_id = decode_handle(handle).ok_or_else(|| "新闻审计引用无效".to_string())?;
    let connection = open_catalog()?;
    let item = load_item(&connection, &article_id)?;
    let triage = load_triage(&connection, &article_id).unwrap_or_default();
    Ok(ArticleAuditDetail { item, triage })
}

fn open_catalog() -> Result<Connection, String> {
    let path = archive::existing_store_path()?;
    if !path.is_file() {
        return Err("本机永久档案尚未初始化".into());
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法只读打开本机永久档案".to_string())
}

fn load_item(connection: &Connection, article_id: &str) -> Result<ArticleAuditItem, String> {
    let (title, source, published_at, triage_state, fingerprint): (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = connection
        .query_row(
            "SELECT title,source_name,published_at,triage_state,fingerprint
             FROM intelligence_articles WHERE article_id=?1",
            [article_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "无法读取新闻审计记录".to_string())?
        .ok_or_else(|| "新闻审计记录不存在或已被清理".to_string())?;

    let full_text = load_full_text(connection, article_id, &fingerprint);
    let media = load_media(connection, article_id, &fingerprint);
    let dedupe = load_dedupe(connection, article_id, &fingerprint);
    let semantic = load_semantic(connection, article_id, &fingerprint);
    let editorial = load_editorial(connection, article_id, &fingerprint);
    let publication = load_publication(connection);
    Ok(ArticleAuditItem {
        handle: encode_handle(article_id),
        title: bounded_text(&title, 240),
        source: bounded_text(source.as_deref().unwrap_or("未标注来源"), 96),
        published_at,
        triage_state: safe_state(&triage_state),
        full_text,
        media,
        dedupe,
        semantic,
        editorial,
        publication,
    })
}

fn load_full_text(connection: &Connection, article_id: &str, fingerprint: &str) -> StageCount {
    let row = connection.query_row(
        "SELECT body_status, COUNT(*),
          (SELECT COUNT(*) FROM intelligence_article_paragraphs p
           WHERE p.article_id=v.article_id AND p.version_sha256=v.version_sha256)
         FROM intelligence_article_content_versions v
         WHERE v.article_id=?1 AND v.record_fingerprint=?2 AND v.is_current=1",
        params![article_id, fingerprint],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    );
    match row {
        Ok((status, versions, paragraphs)) => StageCount {
            status: safe_state(&status),
            versions,
            paragraphs,
        },
        Err(_) => StageCount {
            status: "waiting".into(),
            ..StageCount::default()
        },
    }
}

fn load_media(connection: &Connection, article_id: &str, fingerprint: &str) -> MediaCount {
    connection
        .query_row(
            "SELECT
           COALESCE(SUM(CASE WHEN m.kind='image' THEN 1 ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN m.kind='video' THEN 1 ELSE 0 END),0)
         FROM intelligence_article_media m JOIN intelligence_article_content_versions v
           ON v.article_id=m.article_id AND v.version_sha256=m.version_sha256
         WHERE v.article_id=?1 AND v.record_fingerprint=?2 AND v.is_current=1",
            params![article_id, fingerprint],
            |row| {
                Ok(MediaCount {
                    images: row.get(0)?,
                    videos: row.get(1)?,
                })
            },
        )
        .unwrap_or_default()
}

fn load_dedupe(connection: &Connection, article_id: &str, fingerprint: &str) -> DedupeState {
    let canonical = connection
        .query_row(
            "SELECT canonical_article_id FROM intelligence_worker_canonical_aliases
         WHERE article_id=?1 AND fingerprint=?2",
            params![article_id, fingerprint],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(canonical) = canonical else {
        return DedupeState {
            role: "waiting".into(),
            aliases: 0,
        };
    };
    let aliases = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_worker_canonical_aliases
         WHERE canonical_article_id=?1",
            [canonical.as_str()],
            |row| row.get(0),
        )
        .unwrap_or(0);
    DedupeState {
        role: if canonical == article_id {
            "canonical"
        } else {
            "alias"
        }
        .into(),
        aliases,
    }
}

fn load_semantic(connection: &Connection, article_id: &str, fingerprint: &str) -> SemanticState {
    let vector_dimensions = connection
        .query_row(
            "SELECT e.dimensions FROM intelligence_worker_canonical_aliases a
         JOIN intelligence_worker_embeddings e ON e.canonical_text_sha256=a.canonical_text_sha256
         WHERE a.article_id=?1 AND a.fingerprint=?2 ORDER BY e.created_at DESC LIMIT 1",
            params![article_id, fingerprint],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten();
    let candidates = connection
        .query_row(
            "SELECT COUNT(*) FROM intelligence_worker_relation_staging
         WHERE left_article_id=?1 OR right_article_id=?1",
            [article_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let relation_state = connection
        .query_row(
            "SELECT status FROM intelligence_worker_processed_articles
         WHERE article_id=?1 AND fingerprint=?2",
            params![article_id, fingerprint],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|value| safe_state(&value))
        .unwrap_or_else(|| {
            if vector_dimensions.is_some() {
                "vector_ready".into()
            } else {
                "waiting".into()
            }
        });
    SemanticState {
        vector_ready: vector_dimensions.is_some(),
        vector_dimensions,
        relation_candidates: candidates,
        relation_state,
    }
}

fn load_editorial(connection: &Connection, article_id: &str, fingerprint: &str) -> EditorialState {
    let state = connection.query_row(
        "SELECT status FROM intelligence_worker_processed_articles WHERE article_id=?1 AND fingerprint=?2",
        params![article_id, fingerprint], |row| row.get::<_, String>(0),
    ).optional().ok().flatten().map(|value| safe_state(&value)).unwrap_or_else(|| "waiting".into());
    let event_title = connection.query_row(
        "SELECT e.title FROM intelligence_event_articles ea JOIN intelligence_events e ON e.event_id=ea.event_id
         WHERE ea.article_id=?1 ORDER BY e.updated_at DESC LIMIT 1", [article_id], |row| row.get::<_, String>(0),
    ).optional().ok().flatten().map(|value| bounded_text(&value, 180));
    EditorialState {
        state,
        event_linked: event_title.is_some(),
        event_title,
    }
}

fn load_publication(connection: &Connection) -> PublicationState {
    connection
        .query_row(
            "SELECT day FROM intelligence_daily_drafts ORDER BY prepared_at DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|day| PublicationState {
            state: "prepared_locally".into(),
            day: Some(day),
        })
        .unwrap_or_else(|| PublicationState {
            state: "not_prepared".into(),
            day: None,
        })
}

fn load_triage(connection: &Connection, article_id: &str) -> Option<TriageState> {
    connection
        .query_row(
            "SELECT status,model_id,importance,confidence FROM intelligence_triage_decisions
         WHERE article_id=?1 ORDER BY decided_at DESC LIMIT 1",
            [article_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
        .map(|(state, model, importance, confidence)| TriageState {
            state: safe_state(&state),
            model: Some(bounded_text(&model, 96)),
            importance: importance.map(|value| value.round().clamp(0.0, 100.0) as i64),
            confidence_percent: confidence
                .map(|value| (value * 100.0).round().clamp(0.0, 100.0) as i64),
        })
}

fn bounded_text(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    let mut output = trimmed.chars().take(max).collect::<String>();
    if trimmed.chars().nth(max).is_some() {
        output.push('…');
    }
    output
}

fn safe_state(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(48)
        .collect::<String>()
        .if_empty("unknown")
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> Self;
}
impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> Self {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

fn encode_handle(article_id: &str) -> String {
    article_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn decode_handle(handle: &str) -> Option<String> {
    if handle.is_empty()
        || handle.len() % 2 != 0
        || handle.len() / 2 > MAX_HANDLE_BYTES
        || !handle.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return None;
    }
    let bytes = (0..handle.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&handle[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_handle_round_trip_is_bounded_and_rejects_invalid_input() {
        let handle = encode_handle("article-01");
        assert_eq!(decode_handle(&handle).as_deref(), Some("article-01"));
        assert!(decode_handle("oops").is_none());
        assert!(decode_handle(&"aa".repeat(MAX_HANDLE_BYTES + 1)).is_none());
    }
    #[test]
    fn visible_states_and_titles_are_bounded() {
        assert_eq!(safe_state("keep<script>"), "keepscript");
        assert_eq!(bounded_text("  title  ", 10), "title");
    }
}
