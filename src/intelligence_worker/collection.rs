//! Durable, headless collection boundary for the local intelligence host.
//!
//! The desktop page is deliberately not a collector.  A scheduler supplies a
//! [`CollectorPort`] to this module. The binary supports a strict file adapter
//! and an explicit public HTTP source adapter; both run without a WebView,
//! Tauri command, or page-owned credential. Material is recorded in the
//! permanent catalog together with fetch state, validators and failure reason.

use crate::{
    archive,
    intelligence_worker::content_archive::{
        self, ArchiveArticleContentInput, ArchiveImageInput, ArchiveParagraphInput,
        ArchiveVideoInput,
    },
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::Read,
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_BATCH_ITEMS: usize = 500;
/// A feed can contain hundreds of historical entries.  A supervised round
/// only needs its recent window; older entries would otherwise turn one
/// source request into hundreds of serial article and image downloads.
const MAX_FEED_ITEMS_PER_SOURCE: usize = 24;
/// Full-text retrieval is deliberately bounded at collection time.  Missing
/// bodies are persisted as evidence gaps and the durable backfill queue fills
/// them in later rounds, before an item reaches 27B editorial processing.
const MAX_INLINE_CONTENT_ENRICHMENTS_PER_SOURCE: usize = 2;
const MAX_INLINE_IMAGES_PER_ARTICLE: usize = 2;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCES: usize = 128;
const MAX_IMAGES_PER_ARTICLE: usize = 12;
const MAX_VIDEOS_PER_ARTICLE: usize = 12;
const MAX_PUBLIC_REDIRECTS: usize = 5;
/// Bump this only when the strictly-static extractor learns a materially new
/// public markup pattern.  A durable `body_not_found` gap is allowed one new
/// attempt for each revision; it is not a licence to repeatedly re-fetch a
/// publisher page in every worker round.
const PUBLIC_STATIC_EXTRACTOR_REVISION: i64 = 2;
/// Resolver changes are versioned independently from article-body extraction.
/// A Google discovery wrapper that could not safely expose its publisher at an
/// older revision receives exactly one retry after a stronger public resolver
/// ships; it never turns into an unbounded wrapper polling loop.
const GOOGLE_NEWS_WRAPPER_RESOLVER_REVISION: i64 = 2;
const MIN_STATIC_ARTICLE_BODY_CHARS: usize = 120;
const MIN_STATIC_ARTICLE_VISIBLE_CHARS: usize = 80;
/// A Google News wrapper is only inspected far enough to find explicit public
/// publisher metadata. It is not article evidence and must never turn an
/// unbounded wrapper document into a second extraction workload.
const MAX_GOOGLE_WRAPPER_HTML_SCAN_BYTES: usize = 1024 * 1024;
/// A background round must make meaningful progress through a historical
/// archive, but it must not turn a single host into an unbounded crawler.
/// Fetches are split into origin-fair waves below: at most one request to an
/// origin is in flight in a wave, and no more than eight public origins are
/// fetched at once. A lone origin therefore retains the sequential safety
/// property while a mixed-source backlog can use the available time. Durable
/// per-source intervals and circuit breakers still protect slow publishers.
const MAX_CONTENT_BACKFILL_PER_RUN: usize = 32;
const MAX_CONTENT_BACKFILL_CANDIDATE_SCAN: usize = 128;
// Reserve half of the durable candidate page for the newest evidence gaps and
// half for the oldest ones.  New feeds therefore become readable promptly,
// while a continually arriving feed cannot permanently starve legacy rows.
const MAX_CONTENT_BACKFILL_NEWEST_SCAN: usize = MAX_CONTENT_BACKFILL_CANDIDATE_SCAN / 2;
const MAX_CONTENT_BACKFILL_OLDEST_SCAN: usize =
    MAX_CONTENT_BACKFILL_CANDIDATE_SCAN - MAX_CONTENT_BACKFILL_NEWEST_SCAN;
const MAX_CONTENT_BACKFILL_PARALLEL_FETCHES: usize = 8;
const CONTENT_BACKFILL_BASE_DELAY_MS: i64 = 30_000;
const CONTENT_BACKFILL_MAX_DELAY_MS: i64 = 3_600_000;
// A 403, confirmed missing page, or persistent paywall will not become
// readable in the next active host round.  Preserve it as a durable evidence
// gap, but stop repeatedly probing the publisher until a later scheduled
// repair pass.  Network and 5xx failures keep the short exponential retry.
const CONTENT_BACKFILL_TERMINAL_DELAY_MS: i64 = 12 * 60 * 60 * 1_000;
/// A Google News wrapper without a safely discoverable public publisher URL
/// is a discovery record, not article evidence.  Keep that record and its
/// classified state, but never turn it into an infinite wrapper-download
/// loop.  A later feed item with an ordinary publisher URL is a new record.
const CONTENT_BACKFILL_NEVER_RETRY_AT: i64 = i64::MAX;
const CONTENT_BACKFILL_RATE_LIMIT_BASE_DELAY_MS: i64 = 5 * 60 * 1_000;
const CONTENT_HOST_NETWORK_BASE_DELAY_MS: i64 = 30_000;
const CONTENT_HOST_ACCESS_BASE_DELAY_MS: i64 = 30 * 60 * 1_000;
const CONTENT_HOST_MAX_DELAY_MS: i64 = 12 * 60 * 60 * 1_000;
const SOURCE_DEFAULT_INTERVAL_SECONDS: i64 = 300;
const SOURCE_MIN_INTERVAL_SECONDS: i64 = 30;
const SOURCE_MAX_INTERVAL_SECONDS: i64 = 86_400;
const SOURCE_MAX_BACKOFF_SECONDS: i64 = 3_600;
const USER_AGENT: &str =
    "KunpengIntelligenceWorker/1.0 (+https://github.com/pigking9527-cmyk/kunpeng-reader)";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectedArticle {
    pub source_id: String,
    pub guid: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default = "default_fetch_status")]
    pub fetch_status: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub html: Option<String>,
    /// `complete`, `truncated`, or `unavailable`. A source can have been
    /// fetched successfully while its linked article body was unavailable.
    #[serde(default)]
    pub body_status: Option<String>,
    #[serde(default)]
    pub incomplete_reason: Option<String>,
    /// Downloaded public images are handed to the permanent content archive;
    /// videos deliberately remain HTTPS links and are never downloaded.
    #[serde(default)]
    pub images: Vec<ArchiveImageInput>,
    #[serde(default)]
    pub videos: Vec<ArchiveVideoInput>,
}

fn default_fetch_status() -> String {
    "fetched".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectorFileEnvelope {
    #[serde(default)]
    batch_id: Option<String>,
    articles: Vec<CollectedArticle>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpSourceEnvelope {
    #[serde(default)]
    batch_id: Option<String>,
    sources: Vec<HttpSource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpSource {
    source_id: String,
    /// Supported values are rss, atom, json, and web. Web means that the
    /// configured URL itself is the public article to archive.
    kind: String,
    url: String,
    #[serde(default)]
    language: Option<String>,
    /// The worker loop uses the lowest valid source interval. It is ignored by
    /// one-shot collection, which keeps supervised/Task Scheduler use simple.
    #[serde(default)]
    interval_seconds: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct HttpCollector {
    batch_id: String,
    sources: Vec<HttpSource>,
    catalog_path: PathBuf,
}

#[derive(Clone, Debug, Default)]
struct SourceFetchState {
    etag: Option<String>,
    last_modified: Option<String>,
    next_fetch_at: i64,
    failure_count: u32,
}

#[derive(Clone, Debug)]
struct SourceFetchResult {
    articles: Vec<CollectedArticle>,
    etag: Option<String>,
    last_modified: Option<String>,
    failure: Option<String>,
}

/// The single worker-owned article that currently represents a normalized
/// public URL.  Source records remain independent; this is only a durable
/// fetch/model-work reuse hint.  A different canonical body is never folded
/// into this owner merely because the URL matches.
#[derive(Clone, Debug)]
struct UrlAliasOwner {
    article_id: String,
    fingerprint: String,
    current_text_sha256: Option<String>,
}

impl HttpCollector {
    pub(crate) fn from_file(path: &Path) -> Result<Self, ()> {
        let bytes = fs::read(path).map_err(|_| ())?;
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(());
        }
        let envelope: HttpSourceEnvelope = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if envelope.sources.is_empty() || envelope.sources.len() > MAX_SOURCES {
            return Err(());
        }
        for source in &envelope.sources {
            if safe_text(&source.source_id, 200).is_none()
                || public_fetch_url(&source.url).is_err()
                || !matches!(source.kind.trim(), "rss" | "atom" | "json" | "web")
            {
                return Err(());
            }
        }
        let catalog_path = archive::store_path().map_err(|_| ())?;
        let connection = Connection::open(&catalog_path).map_err(|_| ())?;
        ensure_source_state_schema(&connection)?;
        Ok(Self {
            batch_id: envelope
                .batch_id
                .as_deref()
                .and_then(valid_batch_id)
                .unwrap_or_else(new_batch_id),
            sources: envelope.sources,
            catalog_path,
        })
    }

    pub(crate) fn recommended_interval(&self) -> Duration {
        let seconds = self
            .sources
            .iter()
            .filter_map(|source| source.interval_seconds)
            .filter(|seconds| (30..=86_400).contains(seconds))
            .min()
            .unwrap_or(300);
        Duration::from_secs(seconds)
    }
}

/// A scheduler-owned source adapter.  The core accepts pre-fetched public
/// material only, which keeps HTTP/source credentials out of the worker core
/// and makes exact-deduplication fully deterministic in tests.
pub(crate) trait CollectorPort {
    fn collect(&self) -> Result<(String, Vec<CollectedArticle>), ()>;
}

pub(crate) struct FileCollector<'a> {
    path: &'a Path,
}

impl<'a> FileCollector<'a> {
    pub(crate) fn new(path: &'a Path) -> Self {
        Self { path }
    }
}

impl CollectorPort for FileCollector<'_> {
    fn collect(&self) -> Result<(String, Vec<CollectedArticle>), ()> {
        let bytes = fs::read(self.path).map_err(|_| ())?;
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(());
        }
        let envelope: CollectorFileEnvelope = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if envelope.articles.is_empty() || envelope.articles.len() > MAX_BATCH_ITEMS {
            return Err(());
        }
        let batch_id = envelope
            .batch_id
            .as_deref()
            .and_then(valid_batch_id)
            .unwrap_or_else(new_batch_id);
        Ok((batch_id, envelope.articles))
    }
}

/// Network adapter used only by the independently launched worker. The page
/// never instantiates this adapter. Redirects are disabled so a configured
/// public source cannot silently turn into a request to another endpoint.
impl CollectorPort for HttpCollector {
    fn collect(&self) -> Result<(String, Vec<CollectedArticle>), ()> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(35)))
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_recv_response(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(25)))
            .max_redirects(0)
            .build()
            .into();
        let mut articles = Vec::new();
        // This set contains only URLs with immutable, current complete
        // evidence.  It is intentionally not a title/topic dedupe rule:
        // skipping a page fetch is safe only after the archive has already
        // recorded an exact body for that normalized public URL.
        let mut complete_url_aliases = complete_url_aliases(&self.catalog_path).unwrap_or_default();
        for source in &self.sources {
            let state =
                source_fetch_state(&self.catalog_path, &source.source_id).unwrap_or_default();
            if state.next_fetch_at > Utc::now().timestamp() {
                continue;
            }
            let fetch = collect_http_source(&agent, source, &state, &mut complete_url_aliases);
            update_source_fetch_state(&self.catalog_path, source, &state, &fetch).ok();
            let mut entries = fetch.articles;
            if entries.len() > MAX_BATCH_ITEMS.saturating_sub(articles.len()) {
                entries.truncate(MAX_BATCH_ITEMS.saturating_sub(articles.len()));
            }
            articles.extend(entries);
            if articles.len() >= MAX_BATCH_ITEMS {
                break;
            }
        }
        Ok((self.batch_id.clone(), articles))
    }
}

fn read_response(response: &mut ureq::http::Response<ureq::Body>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "network_read_failed".to_string())?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err("response_too_large".into());
    }
    Ok(bytes)
}

fn response_header(response: &ureq::http::Response<ureq::Body>, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| safe_text(value, 4_096))
}

fn source_failure(source: &HttpSource, reason: &str) -> CollectedArticle {
    let normalized = normalized_url(&source.url).unwrap_or_else(|_| source.url.clone());
    let guid = format!("source-fetch:{}", sha256_hex(normalized.as_bytes()));
    CollectedArticle {
        source_id: source.source_id.clone(),
        guid,
        url: source.url.clone(),
        title: format!("来源抓取失败：{}", source.source_id.trim()),
        summary: String::new(),
        published_at: None,
        etag: None,
        last_modified: None,
        fetch_status: "failed".into(),
        language: source.language.clone(),
        body: None,
        html: None,
        body_status: Some("unavailable".into()),
        incomplete_reason: Some(reason.to_owned()),
        images: Vec::new(),
        videos: Vec::new(),
    }
}

fn collect_http_source(
    agent: &ureq::Agent,
    source: &HttpSource,
    state: &SourceFetchState,
    complete_url_aliases: &mut HashSet<String>,
) -> SourceFetchResult {
    let Ok(source_url) = public_fetch_url(&source.url) else {
        return SourceFetchResult {
            articles: vec![source_failure(source, "source_url_not_public")],
            etag: state.etag.clone(),
            last_modified: state.last_modified.clone(),
            failure: Some("source_url_not_public".into()),
        };
    };
    let mut request = agent
        .get(&source_url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/rss+xml,application/atom+xml,application/xml,text/xml,application/json,text/html;q=0.8,*/*;q=0.1");
    if let Some(etag) = state.etag.as_deref() {
        request = request.header("If-None-Match", etag);
    }
    if let Some(last_modified) = state.last_modified.as_deref() {
        request = request.header("If-Modified-Since", last_modified);
    }
    let mut response = match request.call() {
        Ok(response) => response,
        Err(_) => {
            return SourceFetchResult {
                articles: vec![source_failure(source, "network_request_failed")],
                etag: state.etag.clone(),
                last_modified: state.last_modified.clone(),
                failure: Some("network_request_failed".into()),
            }
        }
    };
    let status = response.status().as_u16();
    if status == 304 {
        return SourceFetchResult {
            articles: Vec::new(),
            etag: response_header(&response, "etag").or_else(|| state.etag.clone()),
            last_modified: response_header(&response, "last-modified")
                .or_else(|| state.last_modified.clone()),
            failure: None,
        };
    }
    if !(200..300).contains(&status) {
        let reason = format!("http_status_{status}");
        return SourceFetchResult {
            articles: vec![source_failure(source, &reason)],
            etag: state.etag.clone(),
            last_modified: state.last_modified.clone(),
            failure: Some(reason),
        };
    }
    let etag = response_header(&response, "etag");
    let last_modified = response_header(&response, "last-modified");
    let bytes = match read_response(&mut response) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return SourceFetchResult {
                articles: vec![source_failure(source, &reason)],
                etag,
                last_modified,
                failure: Some(reason),
            }
        }
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let mut entries = match source.kind.trim() {
        "rss" | "atom" => parse_xml_entries(source, &text),
        "json" => parse_json_entries(source, &text),
        "web" => vec![web_article(source, &text)],
        _ => Vec::new(),
    };
    if entries.is_empty() {
        return SourceFetchResult {
            articles: vec![source_failure(source, "source_payload_has_no_articles")],
            etag,
            last_modified,
            failure: Some("source_payload_has_no_articles".into()),
        };
    }
    entries.truncate(MAX_FEED_ITEMS_PER_SOURCE);
    let mut inline_content_remaining = MAX_INLINE_CONTENT_ENRICHMENTS_PER_SOURCE;
    for entry in &mut entries {
        entry.etag = etag.clone();
        entry.last_modified = last_modified.clone();
        if entry.body.is_none() {
            let normalized = normalized_url(&entry.url).ok();
            let already_archived = normalized
                .as_ref()
                .is_some_and(|url| complete_url_aliases.contains(url));
            if already_archived {
                // The later durable collection transaction attaches this
                // source record to the exact URL owner.  Do not download the
                // same public page again just to create a second model job.
                entry.incomplete_reason = Some("url_alias_complete".into());
            } else if inline_content_remaining > 0 {
                inline_content_remaining -= 1;
                enrich_public_article(agent, entry);
            } else {
                // Do not pretend the article has no body.  The permanent
                // archive's bounded backfill lane will retry this evidence
                // gap without re-collecting or re-triaging the feed item.
                entry.incomplete_reason = Some("deferred_content_backfill".into());
            }
        }
        if entry.body_status.as_deref() == Some("complete") {
            let (images, videos) = extract_public_media(
                agent,
                &entry.url,
                entry.html.as_deref().unwrap_or_default(),
                MAX_INLINE_IMAGES_PER_ARTICLE,
            );
            entry.images = images;
            entry.videos = videos;
            if let Ok(normalized) = normalized_url(&entry.url) {
                complete_url_aliases.insert(normalized);
            }
        }
    }
    SourceFetchResult {
        articles: entries,
        etag,
        last_modified,
        failure: None,
    }
}

fn element_value(fragment: &str, tag: &str) -> Option<String> {
    let start = fragment.find(&format!("<{tag}"))?;
    let after = &fragment[start..];
    let content_start = after.find('>')? + 1;
    let after_open = &after[content_start..];
    let end = after_open.find(&format!("</{tag}"))?;
    let text = strip_html(&after_open[..end]);
    safe_text(&text, 64 * 1024)
}

/// Feed publishers use a mixture of RFC 3339, RFC 2822 and bare calendar
/// dates.  The permanent archive and publication bundle have one canonical
/// representation: UTC RFC 3339 to whole seconds.  Keeping that conversion at
/// ingestion prevents an otherwise valid source from becoming ineligible for
/// a later, immutable daily package merely because its feed chose `pubDate`.
/// Unknown formats deliberately remain absent instead of inventing an event
/// time from the collection clock.
fn normalize_published_at(value: Option<String>) -> Option<String> {
    let value = value.and_then(|value| safe_text(&value, 4_096))?;
    let normalized = DateTime::parse_from_rfc3339(&value)
        .or_else(|_| DateTime::parse_from_rfc2822(&value))
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|timestamp| timestamp.and_utc())
                .ok_or(())
        })
        .or_else(|_| {
            value
                .parse::<i64>()
                .ok()
                .and_then(|timestamp| match value.len() {
                    10 => DateTime::from_timestamp(timestamp, 0),
                    13 => DateTime::from_timestamp_millis(timestamp),
                    _ => None,
                })
                .ok_or(())
        })
        .ok()?;
    Some(normalized.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn attribute_value(fragment: &str, tag: &str, attribute: &str) -> Option<String> {
    let start = fragment.find(&format!("<{tag}"))?;
    let element = &fragment[start..fragment[start..].find('>')? + start + 1];
    for quote in ['\"', '\''] {
        let key = format!("{attribute}={quote}");
        if let Some(value) = element
            .split(&key)
            .nth(1)
            .and_then(|tail| tail.split(quote).next())
        {
            if let Some(value) = safe_text(value, 8 * 1024) {
                return Some(value);
            }
        }
    }
    None
}

fn xml_fragments<'a>(xml: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    let mut remaining = xml;
    let mut output = Vec::new();
    while let Some(start) = remaining.find(open) {
        let candidate = &remaining[start..];
        let Some(end) = candidate.find(close) else {
            break;
        };
        let end = end + close.len();
        output.push(&candidate[..end]);
        remaining = &candidate[end..];
        if output.len() >= MAX_BATCH_ITEMS {
            break;
        }
    }
    output
}

fn parse_xml_entries(source: &HttpSource, xml: &str) -> Vec<CollectedArticle> {
    let items = xml_fragments(xml, "<item", "</item>");
    let entries = if items.is_empty() {
        xml_fragments(xml, "<entry", "</entry>")
    } else {
        items
    };
    entries
        .into_iter()
        .filter_map(|fragment| {
            let title = element_value(fragment, "title")?;
            let url = attribute_value(fragment, "link", "href")
                .or_else(|| element_value(fragment, "link"))?;
            let guid = element_value(fragment, "guid")
                .or_else(|| element_value(fragment, "id"))
                .unwrap_or_else(|| sha256_hex(url.as_bytes()));
            // RSS `content:encoded` is frequently the only complete public
            // article body. Treat it as durable evidence immediately instead
            // of throwing it away and later spending one of the scarce page
            // backfill requests on the same source.
            let inline_html = element_value(fragment, "content:encoded")
                .or_else(|| element_value(fragment, "content"));
            let inline_body = inline_html
                .as_deref()
                .map(clean_article_html)
                .map(|html| strip_html(&html))
                .and_then(|body| safe_text(&body, MAX_TEXT_BYTES))
                .filter(|body| body.len() >= 80);
            let summary = element_value(fragment, "description")
                .or_else(|| element_value(fragment, "summary"))
                .or_else(|| inline_body.clone())
                .unwrap_or_default();
            Some(CollectedArticle {
                source_id: source.source_id.clone(),
                guid,
                url,
                title,
                summary,
                published_at: normalize_published_at(
                    element_value(fragment, "pubDate")
                        .or_else(|| element_value(fragment, "updated"))
                        .or_else(|| element_value(fragment, "published")),
                ),
                etag: None,
                last_modified: None,
                fetch_status: "fetched".into(),
                language: source.language.clone(),
                body_status: inline_body.as_ref().map(|_| "complete".into()),
                body: inline_body,
                html: inline_html,
                incomplete_reason: None,
                images: Vec::new(),
                videos: Vec::new(),
            })
        })
        .collect()
}

fn json_string(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(Value::as_str)
            .and_then(|value| safe_text(value, 64 * 1024))
    })
}

fn parse_json_entries(source: &HttpSource, text: &str) -> Vec<CollectedArticle> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let items = value
        .as_array()
        .or_else(|| value.get("items").and_then(Value::as_array))
        .or_else(|| value.get("articles").and_then(Value::as_array))
        .or_else(|| value.get("results").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    items
        .iter()
        .filter_map(|value| {
            let title = json_string(value, &["title", "headline"])?;
            let url = json_string(value, &["url", "link", "canonicalUrl"])?;
            let guid = json_string(value, &["guid", "id", "uuid"])
                .unwrap_or_else(|| sha256_hex(url.as_bytes()));
            Some(CollectedArticle {
                source_id: source.source_id.clone(),
                guid,
                url,
                title,
                summary: json_string(value, &["summary", "description", "excerpt"])
                    .unwrap_or_default(),
                published_at: normalize_published_at(json_string(
                    value,
                    &["publishedAt", "published_at", "date", "updatedAt"],
                )),
                etag: None,
                last_modified: None,
                fetch_status: "fetched".into(),
                language: source.language.clone(),
                body: json_string(value, &["body", "content", "text"]),
                html: json_string(value, &["html", "contentHtml"]),
                body_status: None,
                incomplete_reason: None,
                images: Vec::new(),
                videos: Vec::new(),
            })
        })
        .collect()
}

/// Remove non-evidence markup without executing any page code.  This is the
/// only HTML preprocessing used by the static extractor: it never invokes a
/// browser, runs JavaScript, calls a page-private endpoint, or tries to get
/// around a paywall/interstitial.
fn static_evidence_html(value: &str) -> String {
    let mut cleaned = value.to_owned();
    // These nodes contain scripts, site chrome, ads, recommendation rails or
    // embedded players rather than article evidence. Keep the original HTML
    // blob separately, but exclude them from the cleaned model input.
    for tag in [
        "script", "style", "noscript", "template", "nav", "header", "footer", "aside", "form",
        "svg",
    ] {
        cleaned = remove_html_tag_blocks(&cleaned, tag);
    }
    while let Some(start) = cleaned.find("<!--") {
        let Some(end) = cleaned[start + 4..].find("-->") else {
            cleaned.truncate(start);
            break;
        };
        cleaned.replace_range(start..start + 4 + end + 3, " ");
    }
    cleaned
}

fn noncontent_html(value: &str) -> String {
    let cleaned = static_evidence_html(value);
    let lower = cleaned.to_ascii_lowercase();
    for tag in ["article", "main"] {
        let needle = format!("<{tag}");
        if let Some(start) = lower.find(&needle) {
            if let Some(open_end) = lower[start..].find('>') {
                let body_start = start + open_end + 1;
                if let Some(close_relative) = lower[body_start..].find(&format!("</{tag}>")) {
                    return cleaned[body_start..body_start + close_relative].to_owned();
                }
            }
        }
    }
    cleaned
}

fn remove_html_tag_blocks(value: &str, tag: &str) -> String {
    let mut output = value.to_owned();
    let lower_tag = tag.to_ascii_lowercase();
    loop {
        let lower = output.to_ascii_lowercase();
        let needle = format!("<{lower_tag}");
        let Some(start) = lower.find(&needle) else {
            break;
        };
        let after_name = start + needle.len();
        if lower
            .as_bytes()
            .get(after_name)
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            let next = after_name.saturating_add(1);
            output.replace_range(start..next.min(output.len()), " ");
            continue;
        }
        let Some(open_end) = lower[after_name..].find('>') else {
            output.truncate(start);
            break;
        };
        let body_start = after_name + open_end + 1;
        let closing = format!("</{lower_tag}>");
        let end = lower[body_start..]
            .find(&closing)
            .map(|relative| body_start + relative + closing.len())
            .unwrap_or(body_start);
        output.replace_range(start..end, " ");
    }
    output
}

fn clean_article_html(value: &str) -> String {
    noncontent_html(value)
}

fn strip_html(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug)]
struct StaticBodyCandidate {
    text: String,
    /// Higher values represent a more explicit public article declaration,
    /// not a model confidence score.
    priority: u8,
}

/// Extract article evidence from ordinary public, already-downloaded HTML.
///
/// News sites have several static representations of the same story.  The
/// first version only preferred `article`/`main` plus JSON-LD, which missed
/// many publishers using class-named story containers or a continuous run of
/// visible paragraphs.  Keep those additional candidates bounded and local:
/// they are merely alternative slices of the same response, never a crawler
/// or a script runtime.
fn extract_static_article_body(html: &str) -> Option<String> {
    let cleaned = static_evidence_html(html);
    let mut candidates = Vec::new();

    if let Some(text) = structured_article_body(html) {
        candidates.push(StaticBodyCandidate { text, priority: 4 });
    }
    candidates.extend(semantic_article_body_candidates(&cleaned));
    candidates.extend(class_named_article_body_candidates(&cleaned));
    if let Some(text) = continuous_paragraph_body_candidate(&cleaned) {
        candidates.push(StaticBodyCandidate { text, priority: 1 });
    }
    // Preserve the original conservative `article`/`main` cleaner as a final
    // compatibility candidate.  It is lower priority because it may become a
    // whole cleaned document when a page has no semantic container.
    candidates.push(StaticBodyCandidate {
        text: strip_html(&noncontent_html(html)),
        priority: 0,
    });

    let mut best: Option<StaticBodyCandidate> = None;
    for candidate in candidates {
        let Some(text) = accepted_static_article_body(&candidate.text) else {
            continue;
        };
        let candidate = StaticBodyCandidate {
            text,
            priority: candidate.priority,
        };
        let replace = match best.as_ref() {
            None => true,
            Some(current) => {
                // Prefer an explicit article representation unless it is a
                // teaser-sized fragment.  A much larger candidate may still
                // win, which handles a truncated JSON-LD body without
                // promoting generic chrome of roughly the same size.
                (candidate.priority > current.priority
                    && candidate.text.len().saturating_mul(2) >= current.text.len())
                    || candidate.text.len() >= current.text.len().saturating_mul(3) / 2
            }
        };
        if replace {
            best = Some(candidate);
        }
    }
    best.map(|candidate| candidate.text)
}

fn accepted_static_article_body(value: &str) -> Option<String> {
    let text = strip_html(value);
    let text = safe_text(&text, MAX_TEXT_BYTES)?;
    let characters = text.chars().count();
    let visible = text
        .chars()
        .filter(|character| character.is_alphanumeric() || is_cjk_ideograph(*character))
        .count();
    if characters < MIN_STATIC_ARTICLE_BODY_CHARS || visible < MIN_STATIC_ARTICLE_VISIBLE_CHARS {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let shell_markers = [
        "enable javascript",
        "javascript is required",
        "please enable cookies",
        "subscribe to continue",
        "sign in to continue",
    ];
    if shell_markers.iter().any(|marker| lower.contains(marker)) && text.len() < 1_200 {
        return None;
    }
    Some(text)
}

fn is_cjk_ideograph(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

fn semantic_article_body_candidates(html: &str) -> Vec<StaticBodyCandidate> {
    let mut candidates = Vec::new();
    for tag in ["article", "main", "section", "div"] {
        for (open, inner) in html_tag_blocks(html, tag) {
            let itemprop_is_article_body = element_attribute(open, "itemprop")
                .is_some_and(|value| value.eq_ignore_ascii_case("articleBody"));
            let role_is_article = element_attribute(open, "role").is_some_and(|value| {
                matches!(value.to_ascii_lowercase().as_str(), "article" | "main")
            });
            if !matches!(tag, "article" | "main") && !itemprop_is_article_body && !role_is_article {
                continue;
            }
            candidates.push(StaticBodyCandidate {
                text: strip_html(inner),
                priority: 3,
            });
        }
    }
    candidates
}

fn class_named_article_body_candidates(html: &str) -> Vec<StaticBodyCandidate> {
    let mut candidates = Vec::new();
    for tag in ["article", "main", "section", "div"] {
        for (open, inner) in html_tag_blocks(html, tag) {
            let identity = [
                element_attribute(open, "id"),
                element_attribute(open, "class"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            if class_name_signals_article_body(&identity) {
                candidates.push(StaticBodyCandidate {
                    text: strip_html(inner),
                    priority: 2,
                });
            }
        }
    }
    candidates
}

fn class_name_signals_article_body(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let compact = lower
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    let explicit = [
        "articlebody",
        "articlecontent",
        "storybody",
        "storycontent",
        "postcontent",
        "postbody",
        "entrycontent",
        "entrybody",
        "newsbody",
        "newscontent",
    ];
    if explicit.iter().any(|signal| compact.contains(signal)) {
        return true;
    }
    let tokens = lower
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<HashSet<_>>();
    let semantic = ["article", "story", "post", "entry", "news"];
    let body = ["body", "content", "text"];
    semantic.iter().any(|token| tokens.contains(token))
        && body.iter().any(|token| tokens.contains(token))
}

/// Return a longest continuous public paragraph run.  Tiny navigation or
/// caption paragraphs form a boundary rather than being joined into model
/// evidence.  This covers static templates that use no semantic wrapper but
/// do expose the article as ordinary `<p>` elements.
fn continuous_paragraph_body_candidate(html: &str) -> Option<String> {
    let mut best = String::new();
    let mut current = Vec::new();
    for (_, inner) in html_tag_blocks(html, "p") {
        let text = strip_html(inner);
        let visible = text
            .chars()
            .filter(|character| character.is_alphanumeric() || is_cjk_ideograph(*character))
            .count();
        if text.len() >= 36 && visible >= 24 {
            current.push(text);
            continue;
        }
        let candidate = current.join("\n\n");
        if candidate.len() > best.len() {
            best = candidate;
        }
        current.clear();
    }
    let candidate = current.join("\n\n");
    if candidate.len() > best.len() {
        best = candidate;
    }
    (best.split("\n\n").count() >= 2).then_some(best)
}

/// A deliberately small non-DOM block scanner. It only identifies already
/// present tags in the downloaded document; nested containers are tolerated
/// but never interpreted as executable code.
fn html_tag_blocks<'a>(html: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{tag}");
    let closing = format!("</{tag}>");
    let mut offset = 0;
    let mut output = Vec::new();
    while let Some(position) = lower[offset..].find(&needle) {
        let start = offset + position;
        let after_name = start + needle.len();
        if lower
            .as_bytes()
            .get(after_name)
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            offset = after_name;
            continue;
        }
        let Some(open_end_relative) = lower[after_name..].find('>') else {
            break;
        };
        let open_end = after_name + open_end_relative + 1;
        let Some(close_relative) = lower[open_end..].find(&closing) else {
            offset = open_end;
            continue;
        };
        let close = open_end + close_relative;
        output.push((&html[start..open_end], &html[open_end..close]));
        offset = close + closing.len();
    }
    output
}

fn web_article(source: &HttpSource, html: &str) -> CollectedArticle {
    let title = element_value(html, "title").unwrap_or_else(|| source.source_id.clone());
    let body = strip_html(&clean_article_html(html));
    CollectedArticle {
        source_id: source.source_id.clone(),
        guid: sha256_hex(source.url.as_bytes()),
        url: source.url.clone(),
        title,
        summary: body.chars().take(1_000).collect(),
        published_at: None,
        etag: None,
        last_modified: None,
        fetch_status: "fetched".into(),
        language: source.language.clone(),
        body: safe_text(&body, MAX_TEXT_BYTES),
        html: Some(html.to_owned()),
        body_status: None,
        incomplete_reason: None,
        images: Vec::new(),
        videos: Vec::new(),
    }
}

fn follow_public_article_redirects(
    agent: &ureq::Agent,
    initial_url: &str,
) -> Result<ureq::http::Response<ureq::Body>, &'static str> {
    let mut current = public_fetch_url(initial_url).map_err(|_| "article_url_not_public")?;
    // Google News RSS uses a public wrapper URL.  Keep it as the archived
    // source URL, but require every resolved hop to stay on public HTTPS.
    // Normal HTTP 3xx handling is preferred; the bounded legacy-token decoder
    // below is only a fallback for wrapper pages that answer 2xx instead of a
    // redirect.  We deliberately do not depend on Google's undocumented
    // batchexecute RPC, which is not a stable public content API.
    let google_news_wrapper = google_news_rss_article_token(initial_url).is_some();
    // Decode before the first request so an initial `/rss/articles/...` hop
    // can become `/articles/...` without losing the legacy target.  It is
    // used only if that chain finishes on a Google wrapper page rather than
    // on the publisher's public HTTPS response.
    let google_news_legacy_target = google_news_legacy_public_target(initial_url);
    let mut google_news_wrapper_resolved = false;
    for redirect_count in 0..=MAX_PUBLIC_REDIRECTS {
        let mut response = agent
            .get(&current)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1")
            .call()
            .map_err(|_| "article_network_request_failed")?;
        let status = response.status().as_u16();
        if !(300..400).contains(&status) {
            if google_news_wrapper && is_news_google_url(&current) {
                if google_news_wrapper_resolved {
                    return Err("google_news_discovery_only");
                }
                // Older Google News RSS article IDs encode the public target
                // in their protobuf payload.  Newer wrappers sometimes expose
                // the same public target in their ordinary HTML instead.  Both
                // paths are fetch-only: `article.url` remains the original RSS
                // wrapper for durable identity and audit.
                let html_target = if google_news_legacy_target.is_none() {
                    let html = google_news_wrapper_html(&mut response)
                        .map_err(|_| "google_news_discovery_only")?;
                    google_news_public_target_from_wrapper_html(&current, &html)
                } else {
                    None
                };
                current = google_news_legacy_target
                    .clone()
                    .or(html_target)
                    .ok_or("google_news_discovery_only")?;
                google_news_wrapper_resolved = true;
                continue;
            }
            return Ok(response);
        }
        if redirect_count == MAX_PUBLIC_REDIRECTS {
            return Err("article_redirect_limit");
        }
        let location =
            response_header(&response, "location").ok_or("article_redirect_missing_location")?;
        current = if google_news_wrapper {
            absolute_public_https_url(&current, &location)
        } else {
            absolute_public_url(&current, &location)
        }
        .ok_or("article_redirect_not_public")?;
    }
    Err("article_redirect_limit")
}

fn enrich_public_article(agent: &ureq::Agent, article: &mut CollectedArticle) {
    // Redirect handling is deliberately manual.  Every hop is normalized and
    // revalidated before it can be requested, so a public Google/RSS redirect
    // cannot silently become a loopback or LAN fetch.
    let mut response = match follow_public_article_redirects(agent, &article.url) {
        Ok(response) => response,
        Err(reason) => {
            article.body_status = Some("unavailable".into());
            article.incomplete_reason = Some(reason.into());
            return;
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        article.body_status = Some("unavailable".into());
        article.incomplete_reason = Some(format!("article_http_status_{status}"));
        return;
    }
    let Ok(bytes) = read_response(&mut response) else {
        article.body_status = Some("truncated".into());
        article.incomplete_reason = Some("article_response_too_large_or_unreadable".into());
        return;
    };
    let html = String::from_utf8_lossy(&bytes).into_owned();
    let cleaned_html = clean_article_html(&html);
    // Strictly-static extraction supports explicit JSON-LD/article bodies,
    // semantic containers, class-named story containers and continuous
    // paragraph runs.  It never executes page JavaScript or asks a hidden
    // endpoint for content, so a public JS shell remains an evidence gap.
    let Some(body) = extract_static_article_body(&html) else {
        article.body_status = Some("unavailable".into());
        article.incomplete_reason = Some(article_body_gap_reason(&html).into());
        return;
    };
    article.body = Some(body);
    article.html = Some(cleaned_html);
    article.body_status = Some("complete".into());
}

/// Extract only Schema.org-style `articleBody` values from public JSON script
/// blocks.  This is deliberately a narrow evidence fallback: it does not
/// execute page JavaScript, follow a hidden API, or turn an SEO description
/// into an article body.  Modern sites frequently place the identical public
/// structured record in `application/json`, `__NEXT_DATA__` or `__NUXT_DATA__`
/// instead of JSON-LD, so support those bounded JSON containers as well.
/// The longest eligible body wins because publishers commonly include both a
/// short item and its full `NewsArticle` in one `@graph`.
fn structured_article_body(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut best = None;
    while let Some(relative_start) = lower[cursor..].find("<script") {
        let start = cursor + relative_start;
        let Some(open_relative_end) = lower[start..].find('>') else {
            break;
        };
        let open_end = start + open_relative_end + 1;
        let Some(close_relative) = lower[open_end..].find("</script>") else {
            break;
        };
        let close = open_end + close_relative;
        let open = &lower[start..open_end];
        if structured_json_script(open) {
            if let Ok(value) = serde_json::from_str::<Value>(&html[open_end..close]) {
                collect_json_ld_article_bodies(&value, &mut best);
            }
        }
        cursor = close + "</script>".len();
    }
    best
}

fn structured_json_script(open_tag: &str) -> bool {
    let open_tag = open_tag.to_ascii_lowercase();
    open_tag.contains("application/ld+json")
        || open_tag.contains("application/json")
        || open_tag.contains("application/vnd.api+json")
        || open_tag.contains("id=\"__next_data__\"")
        || open_tag.contains("id='__next_data__'")
        || open_tag.contains("id=\"__nuxt_data__\"")
        || open_tag.contains("id='__nuxt_data__'")
}

fn collect_json_ld_article_bodies(value: &Value, best: &mut Option<String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_json_ld_article_bodies(value, best);
            }
        }
        Value::Object(values) => {
            if let Some(text) = values
                .get("articleBody")
                .and_then(Value::as_str)
                .map(|text| strip_html(text))
                .and_then(|text| safe_text(&text, MAX_TEXT_BYTES))
                .filter(|text| text.len() >= 80)
            {
                if best
                    .as_ref()
                    .is_none_or(|current| text.len() > current.len())
                {
                    *best = Some(text);
                }
            }
            for value in values.values() {
                collect_json_ld_article_bodies(value, best);
            }
        }
        _ => {}
    }
}

/// Keep permanent retry telemetry actionable.  A JS shell and a publisher
/// paywall both lack extractable text, but they need different remediation;
/// the former can be improved by another public evidence adapter while the
/// latter should enter the long repair cadence immediately.
fn article_body_gap_reason(html: &str) -> &'static str {
    let lower = html.to_ascii_lowercase();
    let paywall_markers = [
        "paywall",
        "subscribe to continue",
        "subscription required",
        "sign in to continue",
        "register to continue",
    ];
    if paywall_markers.iter().any(|marker| lower.contains(marker)) {
        "article_paywall_or_interstitial"
    } else {
        "article_body_not_found"
    }
}

/// This deliberately keeps extraction conservative: the permanent archive
/// stores only decodable public images and HTTPS video locations.  Image URLs
/// are downloaded once and content-addressed by the archive layer; video
/// bytes are never fetched or retained.
fn extract_public_media(
    agent: &ureq::Agent,
    article_url: &str,
    html: &str,
    image_limit: usize,
) -> (Vec<ArchiveImageInput>, Vec<ArchiveVideoInput>) {
    let mut images = Vec::new();
    let mut seen_images = std::collections::BTreeSet::new();
    for element in html_elements(html, "img") {
        if images.len() >= image_limit.min(MAX_IMAGES_PER_ARTICLE) {
            break;
        }
        let Some(source) = element_attribute(element, "src")
            .or_else(|| element_attribute(element, "data-src"))
            .or_else(|| {
                element_attribute(element, "srcset").and_then(|value| {
                    value
                        .split(',')
                        .next()
                        .and_then(|candidate| candidate.split_whitespace().next())
                        .map(str::to_owned)
                })
            })
        else {
            continue;
        };
        let Some(url) = absolute_public_url(article_url, &source) else {
            continue;
        };
        if !seen_images.insert(url.clone()) {
            continue;
        }
        let alt = element_attribute(element, "alt");
        let caption = element_attribute(element, "data-caption")
            .or_else(|| element_attribute(element, "title"))
            .or_else(|| alt.clone());
        let credit = element_attribute(element, "data-credit")
            .or_else(|| element_attribute(element, "data-copyright"))
            .or_else(|| element_attribute(element, "credit"));
        if let Some(image) = fetch_public_image(agent, &url, alt, caption, credit) {
            images.push(image);
        }
    }

    let mut videos = Vec::new();
    let mut seen_videos = std::collections::BTreeSet::new();
    for tag in ["video", "source", "iframe"] {
        for element in html_elements(html, tag) {
            if videos.len() >= MAX_VIDEOS_PER_ARTICLE {
                break;
            }
            let Some(raw) = element_attribute(element, "src") else {
                continue;
            };
            let Some(url) = absolute_public_url(article_url, &raw) else {
                continue;
            };
            let known_embed = matches!(tag, "iframe")
                && ["youtube.", "youtu.be", "vimeo.", "dailymotion.", "tiktok."]
                    .iter()
                    .any(|marker| url.contains(marker));
            if (tag == "iframe" && !known_embed) || !seen_videos.insert(url.clone()) {
                continue;
            }
            videos.push(ArchiveVideoInput {
                url,
                paragraph_index: None,
                poster_sha256: None,
            });
        }
    }
    (images, videos)
}

fn html_elements<'a>(html: &'a str, tag: &str) -> Vec<&'a str> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{tag}");
    let mut offset = 0;
    let mut output = Vec::new();
    while let Some(position) = lower[offset..].find(&needle) {
        let start = offset + position;
        let after_name = start + needle.len();
        if lower
            .as_bytes()
            .get(after_name)
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            offset = after_name;
            continue;
        }
        let Some(close) = lower[after_name..].find('>') else {
            break;
        };
        let end = after_name + close + 1;
        output.push(&html[start..end]);
        offset = end;
    }
    output
}

fn element_attribute(element: &str, wanted: &str) -> Option<String> {
    let lower = element.to_ascii_lowercase();
    let wanted = wanted.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(position) = lower[cursor..].find(&wanted) {
        let start = cursor + position;
        let before = lower.as_bytes().get(start.wrapping_sub(1)).copied();
        let after = lower.as_bytes().get(start + wanted.len()).copied();
        if before.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || after
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            cursor = start + wanted.len();
            continue;
        }
        let remaining = &element[start + wanted.len()..];
        let equals = remaining.find('=')?;
        if !remaining[..equals].trim().is_empty() {
            cursor = start + wanted.len();
            continue;
        }
        let value = remaining[equals + 1..].trim_start();
        let value = if let Some(quote) = value
            .chars()
            .next()
            .filter(|quote| *quote == '\"' || *quote == '\'')
        {
            value[quote.len_utf8()..].split(quote).next()?
        } else {
            value.split_whitespace().next()?.trim_end_matches('>')
        };
        return safe_text(value, 8 * 1024);
    }
    None
}

fn absolute_public_url(base: &str, value: &str) -> Option<String> {
    let base = reqwest::Url::parse(base).ok()?;
    let joined = base.join(value.trim()).ok()?;
    public_fetch_url(joined.as_str()).ok()
}

fn absolute_public_https_url(base: &str, value: &str) -> Option<String> {
    let base = reqwest::Url::parse(base).ok()?;
    let joined = base.join(value.trim()).ok()?;
    public_https_fetch_url(joined.as_str()).ok()
}

/// Return the opaque ID carried by a public Google News RSS article wrapper.
/// This is intentionally strict: other Google paths and arbitrary lookalike
/// hosts stay on the ordinary public redirect path.
fn google_news_rss_article_token(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !is_news_google_url(value) {
        return None;
    }
    let mut segments = url.path_segments()?;
    if segments.next()? != "rss" || segments.next()? != "articles" {
        return None;
    }
    let token = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    safe_text(token, 16 * 1024)
}

fn is_news_google_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value.trim()) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("news.google.com"))
}

/// Decode only the legacy Google News RSS protobuf wrapper form.  Recent
/// opaque IDs are intentionally not guessed or sent to a private decoder;
/// normal public HTTPS redirect handling remains their supported path.
fn google_news_legacy_public_target(value: &str) -> Option<String> {
    let token = google_news_rss_article_token(value)?;
    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .or_else(|_| general_purpose::URL_SAFE.decode(token.as_bytes()))
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(token.as_bytes()))
        .or_else(|_| general_purpose::STANDARD.decode(token.as_bytes()))
        .ok()?;
    let start = decoded
        .windows(b"https://".len())
        .position(|slice| slice == b"https://")?;
    let end = decoded[start..]
        .iter()
        .position(|byte| !byte.is_ascii_graphic() || matches!(byte, b'\'' | b'\"' | b'<' | b'>'))
        .unwrap_or(decoded.len() - start);
    let target = std::str::from_utf8(&decoded[start..start + end]).ok()?;
    public_https_fetch_url(target).ok()
}

/// Resolve an ordinary public publisher target from a Google News wrapper
/// document without invoking private Google endpoints. Only canonical links,
/// Open Graph/Twitter URL metadata and HTML refresh targets are considered.
/// Arbitrary HTTPS literals are deliberately not followed: wrapper pages carry
/// analytics, support and static-resource URLs that are not article evidence.
/// The result is revalidated as a non-Google public HTTPS address before the
/// caller fetches it through the normal redirect guard.
fn google_news_public_target_from_wrapper_html(base: &str, html: &str) -> Option<String> {
    if !is_news_google_url(base) {
        return None;
    }
    let mut scan_len = html.len().min(MAX_GOOGLE_WRAPPER_HTML_SCAN_BYTES);
    while scan_len > 0 && !html.is_char_boundary(scan_len) {
        scan_len -= 1;
    }
    let html = &html[..scan_len];

    for link in html_elements(html, "link") {
        let canonical = element_attribute(link, "rel").is_some_and(|rel| {
            rel.split_ascii_whitespace()
                .any(|value| value.eq_ignore_ascii_case("canonical"))
        });
        if canonical {
            if let Some(target) = element_attribute(link, "href")
                .and_then(|value| google_news_public_target_from_value(base, &value))
            {
                return Some(target);
            }
        }
    }

    for meta in html_elements(html, "meta") {
        let publisher_url = element_attribute(meta, "property")
            .or_else(|| element_attribute(meta, "name"))
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("og:url") || value.eq_ignore_ascii_case("twitter:url")
            });
        if publisher_url {
            if let Some(target) = element_attribute(meta, "content")
                .and_then(|value| google_news_public_target_from_value(base, &value))
            {
                return Some(target);
            }
        }
        let refresh = element_attribute(meta, "http-equiv")
            .is_some_and(|value| value.eq_ignore_ascii_case("refresh"));
        if !refresh {
            continue;
        }
        let Some(content) = element_attribute(meta, "content") else {
            continue;
        };
        if let Some(target) = google_news_refresh_target(&content)
            .and_then(|value| google_news_public_target_from_value(base, value))
        {
            return Some(target);
        }
    }

    None
}

fn google_news_wrapper_html(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<String, String> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_GOOGLE_WRAPPER_HTML_SCAN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "google_wrapper_read_failed".to_string())?;
    if bytes.len() > MAX_GOOGLE_WRAPPER_HTML_SCAN_BYTES {
        return Err("google_wrapper_too_large".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn google_news_public_target_from_value(base: &str, value: &str) -> Option<String> {
    let target = absolute_public_https_url(base, value)?;
    (!is_news_google_url(&target)).then_some(target)
}

fn google_news_refresh_target(content: &str) -> Option<&str> {
    let lower = content.to_ascii_lowercase();
    let marker = "url";
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(marker) {
        let start = cursor + relative;
        let before = lower.as_bytes().get(start.wrapping_sub(1)).copied();
        let after = lower.as_bytes().get(start + marker.len()).copied();
        if before.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || after
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            cursor = start + marker.len();
            continue;
        }
        let remainder = content[start + marker.len()..].trim_start();
        let Some(value) = remainder.strip_prefix('=') else {
            cursor = start + marker.len();
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.split('"').next())
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.split('\'').next())
            })
            .unwrap_or_else(|| value.split_ascii_whitespace().next().unwrap_or_default());
        return (!value.is_empty()).then_some(value);
    }
    None
}

fn fetch_public_image(
    agent: &ureq::Agent,
    url: &str,
    alt: Option<String>,
    caption: Option<String>,
    credit: Option<String>,
) -> Option<ArchiveImageInput> {
    let mut response = agent
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.5",
        )
        .call()
        .ok()?;
    if !(200..300).contains(&response.status().as_u16()) {
        return None;
    }
    let mime = response_header(&response, "content-type");
    let bytes = read_response(&mut response).ok()?;
    image::load_from_memory(&bytes).ok()?;
    Some(ArchiveImageInput {
        bytes,
        mime,
        paragraph_index: None,
        alt,
        caption,
        credit,
        source_url: Some(url.to_owned()),
    })
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct CollectionResult {
    pub received: u64,
    pub collected: u64,
    pub duplicates: u64,
    pub failed: u64,
}

/// Aggregate-only result for the bounded legacy evidence backfill.  This is
/// deliberately separate from collection: it must never create a new article
/// fingerprint, requeue triage, or inflate the new-item count.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ContentBackfillResult {
    pub attempted: u64,
    pub completed: u64,
    pub retried: u64,
}

/// A bounded, operator-safe category.  It is stored in the permanent catalog
/// with timestamps and retry schedule, while command output remains aggregate
/// only and never exposes an article URL or body.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ContentBackfillFailure {
    reason: &'static str,
}

impl ContentBackfillFailure {
    fn new(reason: &'static str) -> Self {
        Self { reason }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ContentBackfillCandidate {
    article_id: String,
    fingerprint: String,
    url: String,
    title: String,
    summary: String,
}

#[derive(Debug)]
struct BackfilledEvidence {
    text: String,
    html: Option<String>,
    images: Vec<ArchiveImageInput>,
    videos: Vec<ArchiveVideoInput>,
}

trait ContentBackfillPort: Sync {
    fn fetch(
        &self,
        candidate: &ContentBackfillCandidate,
    ) -> Result<BackfilledEvidence, ContentBackfillFailure>;
}

struct PublicContentBackfillPort {
    agent: ureq::Agent,
}

impl PublicContentBackfillPort {
    fn new() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(45)))
                .timeout_connect(Some(Duration::from_secs(8)))
                .timeout_recv_response(Some(Duration::from_secs(20)))
                .timeout_recv_body(Some(Duration::from_secs(25)))
                // `follow_public_article_redirects` validates every hop.
                .max_redirects(0)
                .build()
                .into(),
        }
    }
}

fn classify_content_backfill_failure(reason: Option<&str>) -> ContentBackfillFailure {
    let reason = reason.unwrap_or_default();
    let category = if reason == "article_url_not_public" {
        "url_not_public"
    } else if reason == "article_network_request_failed" {
        "network_request_failed"
    } else if reason.starts_with("article_http_status_429") {
        "http_rate_limited"
    } else if reason.starts_with("article_http_status_401")
        || reason.starts_with("article_http_status_403")
    {
        "http_access_denied"
    } else if reason.starts_with("article_http_status_404")
        || reason.starts_with("article_http_status_410")
    {
        "http_not_found"
    } else if reason.starts_with("article_http_status_5") {
        "http_server_error"
    } else if reason.starts_with("article_http_status_") {
        "http_status_rejected"
    } else if reason == "article_response_too_large_or_unreadable" {
        "response_unreadable_or_too_large"
    } else if reason == "article_paywall_or_interstitial" {
        "body_paywall_or_interstitial"
    } else if reason == "article_body_not_found" {
        "body_not_found"
    } else if reason == "google_news_discovery_only" {
        // The Google wrapper is valid discovery metadata, but it did not
        // expose a safe public publisher target. Preserve that classified
        // state in the archive instead of retrying the wrapper indefinitely.
        "google_news_discovery_only"
    } else {
        "content_extraction_failed"
    };
    ContentBackfillFailure::new(category)
}

impl ContentBackfillPort for PublicContentBackfillPort {
    fn fetch(
        &self,
        candidate: &ContentBackfillCandidate,
    ) -> Result<BackfilledEvidence, ContentBackfillFailure> {
        let mut article = CollectedArticle {
            source_id: "legacy-content-backfill".into(),
            guid: candidate.article_id.clone(),
            url: candidate.url.clone(),
            title: candidate.title.clone(),
            summary: candidate.summary.clone(),
            published_at: None,
            etag: None,
            last_modified: None,
            fetch_status: "fetched".into(),
            language: None,
            body: None,
            html: None,
            body_status: None,
            incomplete_reason: None,
            images: Vec::new(),
            videos: Vec::new(),
        };
        enrich_public_article(&self.agent, &mut article);
        if article.body_status.as_deref() != Some("complete") {
            return Err(classify_content_backfill_failure(
                article.incomplete_reason.as_deref(),
            ));
        }
        let text = article
            .body
            .take()
            .ok_or_else(|| ContentBackfillFailure::new("content_extraction_failed"))?;
        let html = article.html.take();
        let (images, videos) = html
            .as_deref()
            .map(|html| {
                extract_public_media(&self.agent, &candidate.url, html, MAX_IMAGES_PER_ARTICLE)
            })
            .unwrap_or_default();
        Ok(BackfilledEvidence {
            text,
            html,
            images,
            videos,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn safe_text(value: &str, max: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= max).then(|| value.to_owned())
}

fn valid_batch_id(value: &str) -> Option<String> {
    let value = safe_text(value, 120)?;
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        .then_some(value)
}

fn new_batch_id() -> String {
    format!("collect-{}", uuid::Uuid::new_v4())
}

fn normalized_url(value: &str) -> Result<String, ()> {
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| ())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(());
    }
    url.set_fragment(None);
    if (url.scheme() == "https" && url.port() == Some(443))
        || (url.scheme() == "http" && url.port() == Some(80))
    {
        let _ = url.set_port(None);
    }
    Ok(url.to_string())
}

/// Worker-managed sources must be public Internet locations. This rejects
/// obvious loopback/LAN literal URLs and disabled redirects prevent a public
/// configured endpoint from silently hopping to a different endpoint.
fn public_fetch_url(value: &str) -> Result<String, ()> {
    let normalized = normalized_url(value)?;
    let url = reqwest::Url::parse(&normalized).map_err(|_| ())?;
    let host = url.host_str().ok_or(())?.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let permitted = match ip {
            IpAddr::V4(ip) => {
                !(ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || ip.is_broadcast())
            }
            IpAddr::V6(ip) => {
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || ip.is_unicast_link_local()
                    || ip.is_unique_local())
            }
        };
        if !permitted {
            return Err(());
        }
    }
    Ok(normalized)
}

/// A Google News wrapper must never downgrade the article fetch to cleartext.
/// Other explicitly configured legacy public sources retain the broader
/// `public_fetch_url` compatibility path above.
fn public_https_fetch_url(value: &str) -> Result<String, ()> {
    let normalized = public_fetch_url(value)?;
    (reqwest::Url::parse(&normalized).map_err(|_| ())?.scheme() == "https")
        .then_some(normalized)
        .ok_or(())
}

fn article_identity(source_id: &str, guid: &str, url: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(source_id.as_bytes());
    digest.update([0]);
    digest.update(guid.as_bytes());
    digest.update([0]);
    digest.update(url.as_bytes());
    format!("source:{}", sha256_hex(&digest.finalize()))
}

fn record_fingerprint(article: &CollectedArticle, normalized_url: &str) -> String {
    let canonical = serde_json::json!({
        "sourceId": article.source_id.trim(),
        "guid": article.guid.trim(),
        "normalizedUrl": normalized_url,
        "title": article.title.trim(),
        "summary": article.summary.trim(),
        "publishedAt": article.published_at.as_deref().unwrap_or("").trim(),
        "etag": article.etag.as_deref().unwrap_or("").trim(),
        "lastModified": article.last_modified.as_deref().unwrap_or("").trim(),
        "body": article.body.as_deref().unwrap_or(""),
        "html": article.html.as_deref().unwrap_or(""),
    });
    sha256_hex(
        serde_json::to_string(&canonical)
            .unwrap_or_default()
            .as_bytes(),
    )
}

fn ensure_source_state_schema(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_collection_sources (
                 source_id TEXT PRIMARY KEY,
                 source_url TEXT NOT NULL,
                 source_kind TEXT NOT NULL,
                 etag TEXT,
                 last_modified TEXT,
                 next_fetch_at INTEGER NOT NULL DEFAULT 0,
                 failure_count INTEGER NOT NULL DEFAULT 0,
                 last_success_at INTEGER,
                 last_failure_at INTEGER,
                 last_failure_reason TEXT,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_collection_sources_schedule_idx
                 ON intelligence_collection_sources(next_fetch_at);",
        )
        .map_err(|_| ())
}

fn source_fetch_state(path: &Path, source_id: &str) -> Result<SourceFetchState, ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_source_state_schema(&connection)?;
    connection
        .query_row(
            "SELECT etag,last_modified,next_fetch_at,failure_count
             FROM intelligence_collection_sources WHERE source_id=?1",
            [source_id.trim()],
            |row| {
                Ok(SourceFetchState {
                    etag: row.get(0)?,
                    last_modified: row.get(1)?,
                    next_fetch_at: row.get(2)?,
                    failure_count: row.get::<_, i64>(3)?.clamp(0, i64::from(u32::MAX)) as u32,
                })
            },
        )
        .optional()
        .map(|value| value.unwrap_or_default())
        .map_err(|_| ())
}

fn source_interval_seconds(source: &HttpSource) -> i64 {
    source
        .interval_seconds
        .and_then(|value| i64::try_from(value).ok())
        .filter(|value| (SOURCE_MIN_INTERVAL_SECONDS..=SOURCE_MAX_INTERVAL_SECONDS).contains(value))
        .unwrap_or(SOURCE_DEFAULT_INTERVAL_SECONDS)
}

fn retry_delay_seconds(previous_failures: u32) -> i64 {
    let exponent = previous_failures.min(7);
    let seconds = SOURCE_MIN_INTERVAL_SECONDS.saturating_mul(1_i64 << exponent);
    seconds.min(SOURCE_MAX_BACKOFF_SECONDS)
}

fn update_source_fetch_state(
    path: &Path,
    source: &HttpSource,
    previous: &SourceFetchState,
    result: &SourceFetchResult,
) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_source_state_schema(&connection)?;
    let now = Utc::now().timestamp();
    let (failure_count, next_fetch_at, last_success_at, last_failure_at, last_failure_reason) =
        if let Some(reason) = result.failure.as_deref() {
            let failures = previous.failure_count.saturating_add(1);
            (
                failures,
                now.saturating_add(retry_delay_seconds(failures.saturating_sub(1))),
                None,
                Some(now),
                Some(reason),
            )
        } else {
            (
                0,
                now.saturating_add(source_interval_seconds(source)),
                Some(now),
                None,
                None,
            )
        };
    connection
        .execute(
            "INSERT INTO intelligence_collection_sources(
                 source_id,source_url,source_kind,etag,last_modified,next_fetch_at,failure_count,
                 last_success_at,last_failure_at,last_failure_reason,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(source_id) DO UPDATE SET
                 source_url=excluded.source_url,source_kind=excluded.source_kind,
                 etag=excluded.etag,last_modified=excluded.last_modified,
                 next_fetch_at=excluded.next_fetch_at,failure_count=excluded.failure_count,
                 last_success_at=COALESCE(excluded.last_success_at,intelligence_collection_sources.last_success_at),
                 last_failure_at=excluded.last_failure_at,last_failure_reason=excluded.last_failure_reason,
                 updated_at=excluded.updated_at",
            params![
                source.source_id.trim(), source.url.trim(), source.kind.trim(),
                result.etag.as_deref(), result.last_modified.as_deref(), next_fetch_at,
                i64::from(failure_count), last_success_at, last_failure_at, last_failure_reason, now,
            ],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn ensure_collection_schema(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_collection_records (
                 source_id TEXT NOT NULL,
                 guid TEXT NOT NULL,
                 normalized_url TEXT NOT NULL,
                 article_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 published_at TEXT,
                 etag TEXT,
                 last_modified TEXT,
                 fetch_status TEXT NOT NULL,
                 failure_reason TEXT,
                 language TEXT,
                 batch_id TEXT NOT NULL,
                 record_fingerprint TEXT NOT NULL,
                 collected_at INTEGER NOT NULL,
                 PRIMARY KEY(source_id,guid,normalized_url)
             );
             CREATE INDEX IF NOT EXISTS intelligence_collection_batch_idx
                 ON intelligence_collection_records(batch_id,collected_at);
             CREATE TABLE IF NOT EXISTS intelligence_collection_url_aliases (
                 normalized_url TEXT PRIMARY KEY,
                 canonical_article_id TEXT NOT NULL,
                 first_seen_at INTEGER NOT NULL,
                 last_seen_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_collection_url_alias_owner_idx
                 ON intelligence_collection_url_aliases(canonical_article_id);
             CREATE TABLE IF NOT EXISTS intelligence_collection_batches (
                 batch_id TEXT PRIMARY KEY,
                 received_count INTEGER NOT NULL,
                 collected_count INTEGER NOT NULL,
                 duplicate_count INTEGER NOT NULL,
                 failed_count INTEGER NOT NULL,
                 completed_at INTEGER NOT NULL
             );",
        )
        .map_err(|_| ())?;
    // Catalogs created before failure diagnostics are upgraded in place.
    // SQLite has no portable ADD COLUMN IF NOT EXISTS.
    let _ = connection.execute(
        "ALTER TABLE intelligence_collection_records ADD COLUMN failure_reason TEXT",
        [],
    );
    Ok(())
}

/// Load the normalized URLs that already have immutable, complete evidence.
/// This is called by the headless HTTP adapter before it schedules its bounded
/// inline page fetches.  A missing/old alias table simply yields no reuse; it
/// never causes a URL, body, or source identifier to leave the local catalog.
fn complete_url_aliases(path: &Path) -> Result<HashSet<String>, ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_article_schema(&connection)?;
    ensure_collection_schema(&connection)?;
    content_archive::ensure_catalog_schema_at(path).map_err(|_| ())?;
    let aliases = connection
        .prepare(
            "SELECT alias.normalized_url
             FROM intelligence_collection_url_aliases alias
             INNER JOIN intelligence_articles article
               ON article.article_id=alias.canonical_article_id
             INNER JOIN intelligence_article_content_versions content
               ON content.article_id=article.article_id
              AND content.record_fingerprint=article.fingerprint
              AND content.is_current=1 AND content.body_status='complete'",
        )
        .map_err(|_| ())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| ())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|_| ())?;
    Ok(aliases)
}

/// Resolve a previously collected normalized URL to one local article owner.
/// Existing catalogs predating the alias table are lazily adopted from their
/// canonical article URL, so incremental deployment does not force a rebuild.
fn url_alias_owner(path: &Path, normalized_url: &str) -> Result<Option<UrlAliasOwner>, ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_article_schema(&connection)?;
    ensure_collection_schema(&connection)?;
    content_archive::ensure_catalog_schema_at(path).map_err(|_| ())?;

    let query_owner = |connection: &Connection, sql: &str| {
        connection
            .query_row(sql, [normalized_url], |row| {
                Ok(UrlAliasOwner {
                    article_id: row.get(0)?,
                    fingerprint: row.get(1)?,
                    current_text_sha256: row.get(2)?,
                })
            })
            .optional()
            .map_err(|_| ())
    };
    let from_alias = query_owner(
        &connection,
        "SELECT article.article_id,article.fingerprint,content.text_sha256
         FROM intelligence_collection_url_aliases alias
         INNER JOIN intelligence_articles article
           ON article.article_id=alias.canonical_article_id
         LEFT JOIN intelligence_article_content_versions content
           ON content.article_id=article.article_id
          AND content.record_fingerprint=article.fingerprint
          AND content.is_current=1 AND content.body_status='complete'
         WHERE alias.normalized_url=?1",
    )?;
    if from_alias.is_some() {
        return Ok(from_alias);
    }

    // Do not pick an arbitrary duplicate from an old catalog: prefer the row
    // with complete current evidence, then retain the oldest stable identity.
    let discovered = query_owner(
        &connection,
        "SELECT article.article_id,article.fingerprint,content.text_sha256
         FROM intelligence_articles article
         LEFT JOIN intelligence_article_content_versions content
           ON content.article_id=article.article_id
          AND content.record_fingerprint=article.fingerprint
          AND content.is_current=1 AND content.body_status='complete'
         WHERE article.url=?1
         ORDER BY CASE WHEN content.text_sha256 IS NULL THEN 1 ELSE 0 END,
                  article.created_at ASC,article.article_id ASC LIMIT 1",
    )?;
    if let Some(owner) = discovered.as_ref() {
        store_url_alias(&connection, normalized_url, &owner.article_id)?;
    }
    Ok(discovered)
}

fn store_url_alias(
    connection: &Connection,
    normalized_url: &str,
    canonical_article_id: &str,
) -> Result<(), ()> {
    let now = Utc::now().timestamp_millis();
    connection
        .execute(
            "INSERT INTO intelligence_collection_url_aliases(
                 normalized_url,canonical_article_id,first_seen_at,last_seen_at
             ) VALUES(?1,?2,?3,?3)
             ON CONFLICT(normalized_url) DO UPDATE SET last_seen_at=excluded.last_seen_at",
            params![normalized_url, canonical_article_id, now],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn store_url_alias_at(
    path: &Path,
    normalized_url: &str,
    canonical_article_id: &str,
) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_collection_schema(&connection)?;
    store_url_alias(&connection, normalized_url, canonical_article_id)
}

fn complete_body_text(article: &CollectedArticle) -> Option<String> {
    article
        .body
        .as_deref()
        .and_then(|body| safe_text(body, MAX_TEXT_BYTES))
}

/// URL equality is a fetch reuse hint, never the final content identity.  A
/// feed-provided body may share an existing owner only if there is no current
/// evidence yet (it can fill that gap) or its canonical SHA-256 matches the
/// immutable current evidence.  Different text falls through to its own
/// article and model path instead of being silently merged.
fn can_reuse_url_alias(owner: &UrlAliasOwner, article: &CollectedArticle) -> bool {
    match (
        complete_body_text(article),
        owner.current_text_sha256.as_deref(),
    ) {
        (Some(body), Some(current_sha)) => {
            content_archive::canonical_article_text_sha256(&body) == current_sha
        }
        (Some(_), None) | (None, _) => true,
    }
}

fn hydrate_url_alias_owner(
    path: &Path,
    owner: &UrlAliasOwner,
    article: &CollectedArticle,
) -> Result<(), ()> {
    // Existing complete evidence was checked by `can_reuse_url_alias`; only
    // use a secondary source body to fill an owner that has no current body.
    if owner.current_text_sha256.is_some() {
        return Ok(());
    }
    let Some(body) = complete_body_text(article) else {
        return Ok(());
    };
    content_archive::persist_article_content_at(
        path,
        ArchiveArticleContentInput {
            article_id: owner.article_id.clone(),
            record_fingerprint: owner.fingerprint.clone(),
            text: body.clone(),
            html: article.html.clone(),
            body_status: article
                .body_status
                .clone()
                .or_else(|| Some("complete".into())),
            incomplete_reason: article.incomplete_reason.clone(),
            paragraphs: paragraphs(&body),
            images: article.images.clone(),
            videos: article.videos.clone(),
        },
    )
    .map(|_| ())
    .map_err(|_| ())
}

/// Bootstrap only the tables collection itself needs. The desktop store owns
/// the richer relation/model schema and upgrades this compatible base later.
fn ensure_article_schema(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS intelligence_articles (
            article_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,url TEXT,source_key TEXT,
            source_name TEXT,title TEXT NOT NULL,summary TEXT,body TEXT,evidence_fingerprint TEXT,
            published_at TEXT,language TEXT,media_json TEXT,
            triage_state TEXT NOT NULL DEFAULT 'queued'
              CHECK (triage_state IN ('queued','processing','keep','filter','failed')),
            triage_attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER,lease_owner TEXT,
            lease_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS intelligence_articles_queue_idx
           ON intelligence_articles(triage_state,lease_until,published_at,created_at);
         CREATE INDEX IF NOT EXISTS intelligence_articles_fingerprint_idx
           ON intelligence_articles(fingerprint);
         CREATE VIRTUAL TABLE IF NOT EXISTS intelligence_news_fts USING fts5(
            article_id UNINDEXED,title,summary,body,entities,
            tokenize='unicode61 remove_diacritics 2'
         );",
        )
        .map_err(|_| ())?;
    // The original metadata-only catalog predates the canonical URL column.
    // Add it without rebuilding the permanent table; backfill also has a
    // collection-record fallback for rows that remain null after this upgrade.
    if let Err(error) =
        connection.execute("ALTER TABLE intelligence_articles ADD COLUMN url TEXT", [])
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(());
        }
    }
    Ok(())
}

fn sparse_terms(value: &str) -> String {
    value
        .split_whitespace()
        .take(2_000)
        .collect::<Vec<_>>()
        .join(" ")
}

fn upsert_article(
    path: &Path,
    article_id: &str,
    fingerprint: &str,
    article: &CollectedArticle,
    normalized: &str,
) -> Result<Option<String>, ()> {
    let mut connection = Connection::open(path).map_err(|_| ())?;
    ensure_article_schema(&connection)?;
    let tx = connection.transaction().map_err(|_| ())?;
    let existing = tx
        .query_row(
            "SELECT fingerprint FROM intelligence_articles WHERE article_id=?1",
            [article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ())?;
    let previous_fingerprint = existing
        .as_deref()
        .filter(|existing| *existing != fingerprint)
        .map(str::to_owned);
    let now = Utc::now().timestamp_millis();
    if existing.as_deref() == Some(fingerprint) {
        tx.execute(
            "UPDATE intelligence_articles SET url=?2,source_key=?3,title=?4,summary=?5,
             body=COALESCE(?6,body),published_at=?7,language=?8,updated_at=?9 WHERE article_id=?1",
            params![
                article_id,
                normalized,
                article.source_id.trim(),
                article.title.trim(),
                safe_text(&article.summary, 64 * 1024),
                article.body.as_deref(),
                article.published_at.as_deref(),
                article.language.as_deref(),
                now
            ],
        )
        .map_err(|_| ())?;
    } else {
        tx.execute(
            "INSERT INTO intelligence_articles(article_id,fingerprint,url,source_key,title,summary,body,published_at,language,triage_state,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued',?10,?10)
             ON CONFLICT(article_id) DO UPDATE SET fingerprint=excluded.fingerprint,url=excluded.url,
               source_key=excluded.source_key,title=excluded.title,summary=excluded.summary,body=excluded.body,
               published_at=excluded.published_at,language=excluded.language,triage_state='queued',
               triage_attempts=0,next_retry_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=excluded.updated_at",
            params![article_id, fingerprint, normalized, article.source_id.trim(), article.title.trim(),
              safe_text(&article.summary, 64 * 1024), article.body.as_deref(), article.published_at.as_deref(),
              article.language.as_deref(), now],
        ).map_err(|_| ())?;
    }
    let body: Option<String> = tx
        .query_row(
            "SELECT body FROM intelligence_articles WHERE article_id=?1",
            [article_id],
            |row| row.get(0),
        )
        .map_err(|_| ())?;
    tx.execute(
        "DELETE FROM intelligence_news_fts WHERE article_id=?1",
        [article_id],
    )
    .map_err(|_| ())?;
    tx.execute(
        "INSERT INTO intelligence_news_fts(article_id,title,summary,body,entities) VALUES(?1,?2,?3,?4,?5)",
        params![article_id, article.title.trim(), safe_text(&article.summary, 64 * 1024), body,
          sparse_terms(&format!("{} {}", article.title, article.summary))],
    ).map_err(|_| ())?;
    tx.commit().map_err(|_| ())?;
    Ok(previous_fingerprint)
}

fn paragraphs(body: &str) -> Vec<ArchiveParagraphInput> {
    body.split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|text| ArchiveParagraphInput {
            text: text.to_owned(),
            level: None,
        })
        .collect()
}

fn record_changed(
    path: &Path,
    article: &CollectedArticle,
    normalized: &str,
    fingerprint: &str,
) -> Result<bool, ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_collection_schema(&connection)?;
    let existing = connection
        .query_row(
            "SELECT record_fingerprint FROM intelligence_collection_records
             WHERE source_id=?1 AND guid=?2 AND normalized_url=?3",
            params![article.source_id.trim(), article.guid.trim(), normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| ())?;
    Ok(existing.as_deref() != Some(fingerprint))
}

fn store_record(
    path: &Path,
    batch_id: &str,
    article: &CollectedArticle,
    normalized: &str,
    article_id: &str,
    fingerprint: &str,
) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_collection_schema(&connection)?;
    let now = Utc::now().timestamp_millis();
    connection
        .execute(
            "INSERT INTO intelligence_collection_records(
                 source_id,guid,normalized_url,article_id,title,published_at,etag,last_modified,
                 fetch_status,failure_reason,language,batch_id,record_fingerprint,collected_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(source_id,guid,normalized_url) DO UPDATE SET
                 article_id=excluded.article_id,title=excluded.title,published_at=excluded.published_at,
                 etag=excluded.etag,last_modified=excluded.last_modified,fetch_status=excluded.fetch_status,
                 failure_reason=excluded.failure_reason,
                 language=excluded.language,batch_id=excluded.batch_id,
                 record_fingerprint=excluded.record_fingerprint,collected_at=excluded.collected_at",
            params![
                article.source_id.trim(), article.guid.trim(), normalized, article_id,
                article.title.trim(), article.published_at.as_deref(), article.etag.as_deref(),
                article.last_modified.as_deref(), article.fetch_status.trim(), article.incomplete_reason.as_deref(), article.language.as_deref(),
                batch_id, fingerprint, now,
            ],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn finalize_batch(path: &Path, batch_id: &str, result: CollectionResult) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_collection_schema(&connection)?;
    connection
        .execute(
            "INSERT INTO intelligence_collection_batches(batch_id,received_count,collected_count,duplicate_count,failed_count,completed_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(batch_id) DO UPDATE SET received_count=excluded.received_count,
                 collected_count=excluded.collected_count,duplicate_count=excluded.duplicate_count,
                 failed_count=excluded.failed_count,completed_at=excluded.completed_at",
            params![batch_id, result.received, result.collected, result.duplicates, result.failed, Utc::now().timestamp_millis()],
        )
        .map_err(|_| ())?;
    Ok(())
}

/// Runs exactly one externally scheduled collection batch.  Invalid entries
/// fail closed and do not create a queue item.  Replaying an identical record
/// updates freshness metadata but does not add a second article or triage job.
pub(crate) fn collect_once_with<P: CollectorPort>(collector: &P) -> Result<CollectionResult, ()> {
    let (batch_id, articles) = collector.collect()?;
    let path = archive::store_path().map_err(|_| ())?;
    collect_once_at(&path, &batch_id, articles)
}

fn collect_once_at(
    path: &Path,
    batch_id: &str,
    articles: Vec<CollectedArticle>,
) -> Result<CollectionResult, ()> {
    let mut result = CollectionResult {
        received: articles.len() as u64,
        ..CollectionResult::default()
    };
    for article in articles {
        let source_id = safe_text(&article.source_id, 200);
        let guid = safe_text(&article.guid, 800);
        let title = safe_text(&article.title, 2_000);
        let normalized = normalized_url(&article.url);
        if source_id.is_none() || guid.is_none() || title.is_none() || normalized.is_err() {
            result.failed += 1;
            continue;
        }
        let source_id = source_id.expect("validated");
        let guid = guid.expect("validated");
        let normalized = normalized.expect("validated");
        let article_id = article_identity(&source_id, &guid, &normalized);
        let fingerprint = record_fingerprint(&article, &normalized);
        if article.fetch_status.trim() != "fetched" {
            store_record(
                path,
                batch_id,
                &article,
                &normalized,
                &article_id,
                &fingerprint,
            )?;
            result.failed += 1;
            continue;
        }
        // Source/GUID records remain independent for audit and later source
        // comparison.  Before creating another article/model queue entry,
        // however, reuse an existing owner only for the exact same normalized
        // public URL and (when a body is present) the exact same canonical
        // body SHA-256.  A changed article at a reused URL deliberately falls
        // through to a distinct record instead of becoming an accidental
        // cross-source merge.
        if let Some(owner) = url_alias_owner(path, &normalized)? {
            if owner.article_id != article_id && can_reuse_url_alias(&owner, &article) {
                hydrate_url_alias_owner(path, &owner, &article)?;
                store_record(
                    path,
                    batch_id,
                    &article,
                    &normalized,
                    &owner.article_id,
                    &fingerprint,
                )?;
                store_url_alias_at(path, &normalized, &owner.article_id)?;
                result.duplicates += 1;
                continue;
            }
        }
        let changed = record_changed(path, &article, &normalized, &fingerprint)?;
        let has_complete_body = complete_body_text(&article).is_some();
        let needs_evidence_backfill = !changed
            && has_complete_body
            && !content_archive::has_current_complete_content_at(path, &article_id, &fingerprint)
                .map_err(|_| ())?;
        if !changed && !needs_evidence_backfill {
            store_record(
                path,
                batch_id,
                &article,
                &normalized,
                &article_id,
                &fingerprint,
            )?;
            result.duplicates += 1;
            continue;
        }
        let previous_fingerprint =
            upsert_article(path, &article_id, &fingerprint, &article, &normalized)?;
        let body = complete_body_text(&article);
        // A validator-only feed refresh may repeat a body but omit the rich
        // HTML/media evidence.  Move the verified immutable revision instead
        // of writing a second copy.  If the refresh supplies HTML or media,
        // persist a fresh revision below so a changed caption, image, or video
        // can never be discarded merely because the text is unchanged.
        let advanced_existing_evidence = match (previous_fingerprint.as_deref(), body.as_deref()) {
            (Some(previous_fingerprint), Some(body)) => {
                if article.html.is_none() && article.images.is_empty() && article.videos.is_empty()
                {
                    content_archive::advance_current_complete_content_fingerprint_at(
                        path,
                        &article_id,
                        previous_fingerprint,
                        &fingerprint,
                        body,
                    )
                    .map_err(|_| ())?
                } else {
                    false
                }
            }
            _ => false,
        };
        if let Some(body) = body.filter(|_| !advanced_existing_evidence) {
            content_archive::persist_article_content_at(
                path,
                ArchiveArticleContentInput {
                    article_id: article_id.clone(),
                    record_fingerprint: fingerprint.clone(),
                    text: body.clone(),
                    html: article.html.clone(),
                    body_status: article
                        .body_status
                        .clone()
                        .or_else(|| Some("complete".into())),
                    incomplete_reason: article.incomplete_reason.clone(),
                    paragraphs: paragraphs(&body),
                    images: article.images.clone(),
                    videos: article.videos.clone(),
                },
            )
            .map_err(|_| ())?;
        }
        store_record(
            path,
            batch_id,
            &article,
            &normalized,
            &article_id,
            &fingerprint,
        )?;
        // The first local article that reaches this URL becomes its stable
        // owner.  `ON CONFLICT` intentionally keeps that owner immutable;
        // later same-URL records can reuse it only after their body hashes
        // prove equality, while actual content changes retain their own row.
        store_url_alias_at(path, &normalized, &article_id)?;
        // A legacy content backfill enriches durable evidence for an already
        // known record. It deliberately remains a duplicate in collection
        // accounting, so it cannot inflate the downstream triage queue.
        if needs_evidence_backfill {
            result.duplicates += 1;
        } else {
            result.collected += 1;
        }
    }
    finalize_batch(path, batch_id, result)?;
    Ok(result)
}

/// Fetch a bounded page of legacy records that have no complete immutable
/// evidence revision.  It is intentionally independent of RSS validators:
/// a source returning 304 must not permanently strand old summary-only rows.
pub(crate) fn backfill_missing_content_once() -> Result<ContentBackfillResult, ()> {
    let path = archive::store_path().map_err(|_| ())?;
    let pass_id = std::env::var("KUNPENG_INTELLIGENCE_BACKFILL_PASS_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    backfill_missing_content_once_for_pass_at(
        &path,
        &PublicContentBackfillPort::new(),
        pass_id.as_deref(),
    )
}

fn ensure_content_backfill_schema(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_content_backfill_state (
                 article_id TEXT PRIMARY KEY,
                 attempts INTEGER NOT NULL DEFAULT 0,
                 next_retry_at INTEGER NOT NULL DEFAULT 0,
                 last_failure_at INTEGER,
                 last_failure_reason TEXT,
                 last_success_at INTEGER,
                 last_backfill_pass_id TEXT,
                 extractor_revision INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_content_backfill_schedule_idx
                 ON intelligence_content_backfill_state(next_retry_at);",
        )
        .map_err(|_| ())?;
    // Archives that already ran the original backfill only have attempts and
    // next_retry_at.  Upgrade them in place so operators can finally see why
    // a legacy item is delayed, without rewriting article metadata.
    for statement in [
        "ALTER TABLE intelligence_content_backfill_state ADD COLUMN last_failure_at INTEGER",
        "ALTER TABLE intelligence_content_backfill_state ADD COLUMN last_failure_reason TEXT",
        "ALTER TABLE intelligence_content_backfill_state ADD COLUMN last_success_at INTEGER",
        "ALTER TABLE intelligence_content_backfill_state ADD COLUMN last_backfill_pass_id TEXT",
        "ALTER TABLE intelligence_content_backfill_state ADD COLUMN extractor_revision INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(error) = connection.execute(statement, []) {
            if !error.to_string().contains("duplicate column name") {
                return Err(());
            }
        }
    }
    // Earlier releases classified unresolved wrappers as a long-delay retry.
    // They are discovery-only records, so safely retain the existing article
    // metadata while stopping future wrapper probes after this upgrade.
    connection
        .execute(
            "UPDATE intelligence_content_backfill_state
             SET last_failure_reason='google_news_discovery_only',
                 next_retry_at=?1
             WHERE last_failure_reason='google_news_target_unresolved'",
            [CONTENT_BACKFILL_NEVER_RETRY_AT],
        )
        .map_err(|_| ())?;
    Ok(())
}

/// Per-article retry state prevents a single evidence gap from hot-looping;
/// this separate, local-only table protects a publisher when many historic
/// records point at the same host.  It never leaves the permanent archive and
/// contains no article text or credentials.
fn ensure_content_backfill_host_schema(connection: &Connection) -> Result<(), ()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS intelligence_content_backfill_hosts (
                 host TEXT PRIMARY KEY,
                 failure_count INTEGER NOT NULL DEFAULT 0,
                 next_allowed_at INTEGER NOT NULL DEFAULT 0,
                 last_failure_at INTEGER,
                 last_failure_reason TEXT,
                 last_success_at INTEGER,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS intelligence_content_backfill_hosts_schedule_idx
                 ON intelligence_content_backfill_hosts(next_allowed_at);",
        )
        .map_err(|_| ())
}

/// The legacy Google News wrapper can safely reveal its public HTTPS target
/// for older encoded IDs.  Use that final host for fairness and throttling so
/// a whole mixed-publisher archive is not serialized behind news.google.com.
/// Opaque wrappers retain their wrapper host until a safe resolver succeeds.
fn content_backfill_host(url: &str) -> Option<String> {
    let resolved = google_news_legacy_public_target(url).unwrap_or_else(|| url.to_owned());
    reqwest::Url::parse(&resolved)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .filter(|host| !host.is_empty())
}

fn content_backfill_host_allowed_at(
    path: &Path,
    candidate: &ContentBackfillCandidate,
) -> Result<bool, ()> {
    let Some(host) = content_backfill_host(&candidate.url) else {
        return Ok(false);
    };
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_content_backfill_host_schema(&connection)?;
    let next_allowed_at = connection
        .query_row(
            "SELECT next_allowed_at FROM intelligence_content_backfill_hosts WHERE host=?1",
            [host],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| ())?
        .unwrap_or(0);
    Ok(next_allowed_at <= Utc::now().timestamp_millis())
}

fn content_host_failure_delay_ms(reason: &str, previous_failures: u32) -> Option<i64> {
    let base = match reason {
        "http_rate_limited" => CONTENT_BACKFILL_RATE_LIMIT_BASE_DELAY_MS,
        "http_access_denied" => CONTENT_HOST_ACCESS_BASE_DELAY_MS,
        "network_request_failed" | "http_server_error" => CONTENT_HOST_NETWORK_BASE_DELAY_MS,
        _ => return None,
    };
    Some(
        base.saturating_mul(1_i64 << previous_failures.min(7))
            .min(CONTENT_HOST_MAX_DELAY_MS),
    )
}

fn record_content_backfill_host_failure(
    path: &Path,
    candidate: &ContentBackfillCandidate,
    failure: &ContentBackfillFailure,
) -> Result<(), ()> {
    let Some(host) = content_backfill_host(&candidate.url) else {
        return Ok(());
    };
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_content_backfill_host_schema(&connection)?;
    let previous = connection
        .query_row(
            "SELECT failure_count FROM intelligence_content_backfill_hosts WHERE host=?1",
            [host.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| ())?
        .unwrap_or(0)
        .clamp(0, i64::from(u32::MAX)) as u32;
    let Some(delay_ms) = content_host_failure_delay_ms(failure.reason, previous) else {
        return Ok(());
    };
    let now = Utc::now().timestamp_millis();
    connection
        .execute(
            "INSERT INTO intelligence_content_backfill_hosts(
                 host,failure_count,next_allowed_at,last_failure_at,last_failure_reason,updated_at
             ) VALUES(?1,1,?2,?3,?4,?3)
             ON CONFLICT(host) DO UPDATE SET failure_count=failure_count+1,
               next_allowed_at=excluded.next_allowed_at,last_failure_at=excluded.last_failure_at,
               last_failure_reason=excluded.last_failure_reason,updated_at=excluded.updated_at",
            params![host, now.saturating_add(delay_ms), now, failure.reason],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn record_content_backfill_host_success(
    path: &Path,
    candidate: &ContentBackfillCandidate,
) -> Result<(), ()> {
    let Some(host) = content_backfill_host(&candidate.url) else {
        return Ok(());
    };
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_content_backfill_host_schema(&connection)?;
    let now = Utc::now().timestamp_millis();
    connection
        .execute(
            "INSERT INTO intelligence_content_backfill_hosts(
                 host,failure_count,next_allowed_at,last_success_at,updated_at
             ) VALUES(?1,0,0,?2,?2)
             ON CONFLICT(host) DO UPDATE SET failure_count=0,next_allowed_at=0,
               last_success_at=excluded.last_success_at,updated_at=excluded.updated_at",
            params![host, now],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn next_content_backfill_candidates(path: &Path) -> Result<Vec<ContentBackfillCandidate>, ()> {
    next_content_backfill_candidates_for_pass(path, None)
}

fn next_content_backfill_candidates_for_pass(
    path: &Path,
    pass_id: Option<&str>,
) -> Result<Vec<ContentBackfillCandidate>, ()> {
    content_archive::ensure_catalog_schema_at(path).map_err(|_| ())?;
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_article_schema(&connection)?;
    // Pre-collector permanent catalogs have article metadata but no collection
    // table.  Create the empty compatibility table before the URL fallback
    // subquery so those rows still backfill from `intelligence_articles.url`.
    ensure_collection_schema(&connection)?;
    ensure_content_backfill_schema(&connection)?;
    let now = Utc::now().timestamp_millis();
    // A content version only satisfies the exact article fingerprint it was
    // extracted for.  Feed metadata can legitimately change after a previous
    // version, and treating any current body as complete would make that
    // updated record invisible to the evidence pipeline.
    //
    // Build a source-fair page from both ends of the durable queue.  This is
    // deliberately not a one-time migration cursor: retry state remains the
    // single scheduling truth, and every recurring run can service fresh news
    // *and* make bounded progress over historical gaps.
    let mut statement = connection
        .prepare(
            "WITH eligible AS (
                 SELECT a.article_id,a.fingerprint,
                        COALESCE(NULLIF(a.url,''),(
                            SELECT r.normalized_url FROM intelligence_collection_records r
                            WHERE r.article_id=a.article_id AND r.normalized_url LIKE 'https://%'
                            ORDER BY r.collected_at DESC LIMIT 1
                        ),'') AS url,
                        a.title,COALESCE(a.summary,'') AS summary,
                        COALESCE(a.published_at,'') AS published_at,a.created_at
                 FROM intelligence_articles a
                 LEFT JOIN intelligence_article_content_versions v
                   ON v.article_id=a.article_id AND v.record_fingerprint=a.fingerprint
                  AND v.is_current=1 AND v.body_status='complete'
                 LEFT JOIN intelligence_content_backfill_state b ON b.article_id=a.article_id
                 WHERE v.article_id IS NULL AND (
                       COALESCE(b.next_retry_at,0)<=?1
                       OR (
                           COALESCE(b.last_failure_reason,'')='body_not_found'
                           AND COALESCE(b.extractor_revision,0)<?2
                       )
                       OR (
                           COALESCE(b.last_failure_reason,'')='google_news_discovery_only'
                           AND COALESCE(b.extractor_revision,0)<?3
                       )
                   )
                   AND (?4='' OR COALESCE(b.last_backfill_pass_id,'')<>?4)
                   AND COALESCE(NULLIF(a.url,''),(
                       SELECT r.normalized_url FROM intelligence_collection_records r
                       WHERE r.article_id=a.article_id AND r.normalized_url LIKE 'https://%'
                       ORDER BY r.collected_at DESC LIMIT 1
                   ),'') LIKE 'https://%'
             ), newest AS (
                 SELECT article_id,fingerprint,url,title,summary,0 AS queue_segment FROM eligible
                 ORDER BY published_at DESC,created_at DESC LIMIT ?5
             ), oldest AS (
                 SELECT article_id,fingerprint,url,title,summary,1 AS queue_segment FROM eligible
                 ORDER BY published_at ASC,created_at ASC LIMIT ?6
             )
             SELECT article_id,fingerprint,url,title,summary,queue_segment FROM newest
             UNION ALL
             SELECT article_id,fingerprint,url,title,summary,queue_segment FROM oldest
             WHERE article_id NOT IN (SELECT article_id FROM newest)",
        )
        .map_err(|_| ())?;
    let segmented = statement
        .query_map(
            params![
                now,
                PUBLIC_STATIC_EXTRACTOR_REVISION,
                GOOGLE_NEWS_WRAPPER_RESOLVER_REVISION,
                pass_id.unwrap_or(""),
                MAX_CONTENT_BACKFILL_NEWEST_SCAN as i64,
                MAX_CONTENT_BACKFILL_OLDEST_SCAN as i64
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(5)?,
                    ContentBackfillCandidate {
                        article_id: row.get(0)?,
                        fingerprint: row.get(1)?,
                        url: row.get(2)?,
                        title: row.get(3)?,
                        summary: row.get(4)?,
                    },
                ))
            },
        )
        .map_err(|_| ())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    let mut newest = Vec::new();
    let mut oldest = Vec::new();
    for (segment, candidate) in segmented {
        if segment == 0 {
            newest.push(candidate);
        } else {
            oldest.push(candidate);
        }
    }
    // Check durable publisher circuits before applying the fixed batch cap.
    // If this happened after `fair_backfill_candidates`, 32 temporarily
    // limited publishers could occupy every slot and make the host report an
    // empty backfill pass even though a later ready publisher was already in
    // the scanned page.  The later pre-dispatch check remains necessary: a
    // circuit can open while an earlier wave is in flight.
    let source_ready = source_ready_backfill_candidates(
        path,
        interleave_fresh_and_historical_backfill(newest, oldest),
    )?;
    Ok(fair_backfill_candidates(source_ready))
}

fn source_ready_backfill_candidates(
    path: &Path,
    candidates: Vec<ContentBackfillCandidate>,
) -> Result<Vec<ContentBackfillCandidate>, ()> {
    let mut source_ready = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if content_backfill_host_allowed_at(path, &candidate)? {
            source_ready.push(candidate);
        }
    }
    Ok(source_ready)
}

/// Interleave both durable queue windows before source-fair selection.  Without
/// this step, a catalog with many different publishers would select the first
/// 32 (newest) lanes and leave the historical half of the SQL page unused.
fn interleave_fresh_and_historical_backfill(
    newest: Vec<ContentBackfillCandidate>,
    oldest: Vec<ContentBackfillCandidate>,
) -> Vec<ContentBackfillCandidate> {
    let mut newest = VecDeque::from(newest);
    let mut oldest = VecDeque::from(oldest);
    let mut candidates = Vec::with_capacity(newest.len() + oldest.len());
    while !newest.is_empty() || !oldest.is_empty() {
        if let Some(candidate) = newest.pop_front() {
            candidates.push(candidate);
        }
        if let Some(candidate) = oldest.pop_front() {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Return a conservative source lane for an already validated public article
/// URL.  Using the network host rather than a feed's display name prevents two
/// configured feeds pointing at the same publisher from issuing parallel page
/// fetches.  Invalid URLs never reach this path in production, but are kept in
/// one lane for fail-safe behaviour in old catalogs and tests.
fn backfill_source_lane(url: &str) -> String {
    content_backfill_host(url).unwrap_or_else(|| "unknown-origin".into())
}

/// The SQL priority remains authoritative within each publisher, while the
/// selected page is round-robin across publishers.  This keeps one noisy feed
/// from occupying the complete batch and still lets a one-source archive make
/// progress when it is the only work available.
fn fair_backfill_candidates(
    candidates: Vec<ContentBackfillCandidate>,
) -> Vec<ContentBackfillCandidate> {
    let mut lanes: HashMap<String, VecDeque<ContentBackfillCandidate>> = HashMap::new();
    let mut lane_order = Vec::new();
    for candidate in candidates {
        let lane = backfill_source_lane(&candidate.url);
        if !lanes.contains_key(&lane) {
            lane_order.push(lane.clone());
        }
        lanes.entry(lane).or_default().push_back(candidate);
    }

    let mut selected = Vec::with_capacity(MAX_CONTENT_BACKFILL_PER_RUN);
    while selected.len() < MAX_CONTENT_BACKFILL_PER_RUN {
        let mut progressed = false;
        for lane in &lane_order {
            if selected.len() == MAX_CONTENT_BACKFILL_PER_RUN {
                break;
            }
            if let Some(candidate) = lanes.get_mut(lane).and_then(VecDeque::pop_front) {
                selected.push(candidate);
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    selected
}

/// Partition a fair candidate page into fetch waves.  A wave contains only
/// distinct source lanes, so the host never concurrently requests two pages
/// from the same publisher.  The number of live fetches naturally adapts to
/// the number of distinct ready sources, up to the fixed process-wide cap.
fn backfill_fetch_waves(
    candidates: Vec<ContentBackfillCandidate>,
) -> Vec<Vec<ContentBackfillCandidate>> {
    let mut pending = VecDeque::from(candidates);
    let mut waves = Vec::new();
    while !pending.is_empty() {
        let mut lanes = HashSet::new();
        let mut wave = Vec::with_capacity(MAX_CONTENT_BACKFILL_PARALLEL_FETCHES);
        let scan = pending.len();
        for _ in 0..scan {
            let candidate = pending.pop_front().expect("pending length was checked");
            let lane = backfill_source_lane(&candidate.url);
            if wave.len() < MAX_CONTENT_BACKFILL_PARALLEL_FETCHES && lanes.insert(lane) {
                wave.push(candidate);
            } else {
                pending.push_back(candidate);
            }
        }
        // Every candidate receives a lane key, so an empty wave would mean a
        // programming error.  Keep a defensive fallback so an invalid legacy
        // row cannot leave the background host in a hot loop.
        if wave.is_empty() {
            if let Some(candidate) = pending.pop_front() {
                wave.push(candidate);
            }
        }
        waves.push(wave);
    }
    waves
}

fn fetch_backfill_wave<P: ContentBackfillPort>(
    port: &P,
    candidates: Vec<ContentBackfillCandidate>,
) -> Vec<(
    ContentBackfillCandidate,
    Result<BackfilledEvidence, ContentBackfillFailure>,
)> {
    std::thread::scope(|scope| {
        let mut tasks = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            tasks.push(scope.spawn(move || {
                let evidence = port.fetch(&candidate);
                (candidate, evidence)
            }));
        }
        tasks
            .into_iter()
            .map(|task| task.join().expect("content backfill worker panicked"))
            .collect()
    })
}

fn record_content_backfill_retry(
    path: &Path,
    article_id: &str,
    reason: &ContentBackfillFailure,
    pass_id: Option<&str>,
) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_content_backfill_schema(&connection)?;
    let now = Utc::now().timestamp_millis();
    let previous: i64 = connection
        .query_row(
            "SELECT attempts FROM intelligence_content_backfill_state WHERE article_id=?1",
            [article_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ())?
        .unwrap_or(0)
        .clamp(0, 16);
    let base_delay_ms = match reason.reason {
        "http_access_denied"
        | "http_not_found"
        | "body_paywall_or_interstitial"
        | "body_not_found" => CONTENT_BACKFILL_TERMINAL_DELAY_MS,
        "http_rate_limited" => CONTENT_BACKFILL_RATE_LIMIT_BASE_DELAY_MS,
        _ => CONTENT_BACKFILL_BASE_DELAY_MS,
    };
    let next_retry_at = if reason.reason == "google_news_discovery_only" {
        CONTENT_BACKFILL_NEVER_RETRY_AT
    } else {
        let delay_ms = base_delay_ms
            .saturating_mul(1_i64 << previous.min(7))
            .min(CONTENT_BACKFILL_MAX_DELAY_MS.max(base_delay_ms));
        now.saturating_add(delay_ms)
    };
    let extractor_revision = match reason.reason {
        "body_not_found" => PUBLIC_STATIC_EXTRACTOR_REVISION,
        "google_news_discovery_only" => GOOGLE_NEWS_WRAPPER_RESOLVER_REVISION,
        _ => 0,
    };
    connection
        .execute(
            "INSERT INTO intelligence_content_backfill_state(
                 article_id,attempts,next_retry_at,last_failure_at,last_failure_reason,
                 last_backfill_pass_id,extractor_revision,updated_at
             ) VALUES(?1,1,?2,?3,?4,?5,?6,?3)
             ON CONFLICT(article_id) DO UPDATE SET attempts=attempts+1,
               next_retry_at=excluded.next_retry_at,last_failure_at=excluded.last_failure_at,
               last_failure_reason=excluded.last_failure_reason,
               last_backfill_pass_id=excluded.last_backfill_pass_id,
               extractor_revision=MAX(extractor_revision,excluded.extractor_revision),
               updated_at=excluded.updated_at",
            params![
                article_id,
                next_retry_at,
                now,
                reason.reason,
                pass_id.unwrap_or(""),
                extractor_revision,
            ],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn clear_content_backfill_retry(path: &Path, article_id: &str) -> Result<(), ()> {
    let connection = Connection::open(path).map_err(|_| ())?;
    ensure_content_backfill_schema(&connection)?;
    connection
        .execute(
            "UPDATE intelligence_content_backfill_state
             SET attempts=0,next_retry_at=0,last_failure_at=NULL,last_failure_reason=NULL,
                 last_success_at=?2,updated_at=?2
             WHERE article_id=?1",
            params![article_id, Utc::now().timestamp_millis()],
        )
        .map_err(|_| ())?;
    Ok(())
}

fn backfill_missing_content_once_at<P: ContentBackfillPort>(
    path: &Path,
    port: &P,
) -> Result<ContentBackfillResult, ()> {
    backfill_missing_content_once_for_pass_at(path, port, None)
}

fn backfill_missing_content_once_for_pass_at<P: ContentBackfillPort>(
    path: &Path,
    port: &P,
    pass_id: Option<&str>,
) -> Result<ContentBackfillResult, ()> {
    let candidates = next_content_backfill_candidates_for_pass(path, pass_id)?;
    let mut result = ContentBackfillResult::default();
    for wave in backfill_fetch_waves(candidates) {
        // Host state may have changed after a prior wave (for example a 429
        // from the same publisher). Re-check immediately before dispatch so
        // an already-planned later wave cannot ignore a newly opened circuit.
        let mut allowed = Vec::with_capacity(wave.len());
        for candidate in wave {
            if content_backfill_host_allowed_at(path, &candidate)? {
                allowed.push(candidate);
            }
        }
        result.attempted += allowed.len() as u64;
        for (candidate, fetched) in fetch_backfill_wave(port, allowed) {
            let evidence = match fetched {
                Ok(value) => value,
                Err(failure) => {
                    record_content_backfill_retry(path, &candidate.article_id, &failure, pass_id)?;
                    record_content_backfill_host_failure(path, &candidate, &failure)?;
                    result.retried += 1;
                    continue;
                }
            };
            let persisted = content_archive::persist_article_content_at(
                path,
                ArchiveArticleContentInput {
                    article_id: candidate.article_id.clone(),
                    record_fingerprint: candidate.fingerprint.clone(),
                    text: evidence.text.clone(),
                    html: evidence.html,
                    body_status: Some("complete".into()),
                    incomplete_reason: None,
                    paragraphs: paragraphs(&evidence.text),
                    images: evidence.images,
                    videos: evidence.videos,
                },
            );
            if persisted.is_ok() {
                clear_content_backfill_retry(path, &candidate.article_id)?;
                record_content_backfill_host_success(path, &candidate)?;
                result.completed += 1;
            } else {
                record_content_backfill_retry(
                    path,
                    &candidate.article_id,
                    &ContentBackfillFailure::new("archive_persist_failed"),
                    pass_id,
                )?;
                result.retried += 1;
            }
        }
    }
    Ok(result)
}

pub(crate) fn configured_file_from_environment() -> Option<std::path::PathBuf> {
    let value = std::env::var("KUNPENG_INTELLIGENCE_COLLECTOR_INPUT").ok()?;
    let path = Path::new(value.trim());
    (path.is_absolute() && path.is_file()).then(|| path.to_path_buf())
}

/// An absolute, local JSON configuration file keeps source credentials (if a
/// future supervised adapter needs them) out of command lines and WebView
/// state. The built-in HTTP adapter accepts public endpoints only.
pub(crate) fn configured_http_sources_from_environment() -> Option<PathBuf> {
    let value = std::env::var("KUNPENG_INTELLIGENCE_COLLECTOR_SOURCES").ok()?;
    let path = Path::new(value.trim());
    (path.is_absolute() && path.is_file()).then(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixturePort {
        items: Vec<CollectedArticle>,
    }
    impl CollectorPort for FixturePort {
        fn collect(&self) -> Result<(String, Vec<CollectedArticle>), ()> {
            Ok(("batch.test".into(), self.items.clone()))
        }
    }
    fn item() -> CollectedArticle {
        CollectedArticle {
            source_id: "example".into(),
            guid: "guid-1".into(),
            url: "https://example.test/a#fragment".into(),
            title: "公开标题".into(),
            summary: "公开摘要".into(),
            published_at: Some("2026-08-23T00:00:00Z".into()),
            etag: Some("etag-a".into()),
            last_modified: Some("Sat, 23 Aug 2026 00:00:00 GMT".into()),
            fetch_status: "fetched".into(),
            language: Some("zh".into()),
            body: Some("第一段\n\n第二段".into()),
            html: Some("<p>第一段</p><p>第二段</p>".into()),
            body_status: Some("complete".into()),
            incomplete_reason: None,
            images: Vec::new(),
            videos: Vec::new(),
        }
    }

    fn backfill_candidate(id: &str, url: &str) -> ContentBackfillCandidate {
        ContentBackfillCandidate {
            article_id: id.into(),
            fingerprint: format!("fingerprint-{id}"),
            url: url.into(),
            title: format!("title-{id}"),
            summary: String::new(),
        }
    }

    #[test]
    fn normalized_url_drops_fragment_and_default_https_port() {
        assert_eq!(
            normalized_url("https://Example.TEST:443/a#b").unwrap(),
            "https://example.test/a"
        );
        assert!(normalized_url("file:///private").is_err());
        assert!(public_fetch_url("http://127.0.0.1/private").is_err());
        assert!(public_fetch_url("https://localhost/private").is_err());
        assert!(public_fetch_url("https://example.test/public").is_ok());
    }

    fn legacy_google_rss_wrapper(target: &str) -> String {
        let mut payload = vec![0x08, 0x13, 0x22];
        payload.extend_from_slice(target.as_bytes());
        payload.extend_from_slice(&[0xd2, 0x01, 0x00]);
        let token = general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("https://news.google.com/rss/articles/{token}")
    }

    #[test]
    fn google_news_legacy_wrapper_decodes_only_public_https_target() {
        let wrapper = legacy_google_rss_wrapper("https://publisher.example.test/story?a=1");
        assert_eq!(
            google_news_legacy_public_target(&wrapper).as_deref(),
            Some("https://publisher.example.test/story?a=1")
        );
        // Decoding is a fetch-only operation; the RSS wrapper remains the
        // durable source URL used for identity and audit.
        assert_eq!(
            normalized_url(&wrapper).unwrap(),
            wrapper,
            "the original Google News source must not be replaced"
        );
    }

    #[test]
    fn google_news_legacy_wrapper_rejects_non_https_and_non_public_targets() {
        let insecure = legacy_google_rss_wrapper("http://publisher.example.test/story");
        let loopback = legacy_google_rss_wrapper("https://127.0.0.1/private");
        assert!(google_news_legacy_public_target(&insecure).is_none());
        assert!(google_news_legacy_public_target(&loopback).is_none());
        assert!(
            google_news_legacy_public_target("https://example.test/rss/articles/token").is_none()
        );
        assert!(google_news_rss_article_token("https://news.google.com/read/token").is_none());
    }

    #[test]
    fn google_news_wrapper_html_resolves_only_explicit_public_publisher_targets() {
        let base = "https://news.google.com/rss/articles/opaque-token";
        assert_eq!(
            google_news_public_target_from_wrapper_html(
                base,
                r#"<html><head><link rel="canonical" href="https://publisher.example.test/story?a=1"></head></html>"#,
            )
            .as_deref(),
            Some("https://publisher.example.test/story?a=1")
        );
        assert_eq!(
            google_news_public_target_from_wrapper_html(
                base,
                r#"<meta http-equiv="refresh" content="0; URL='https://publisher.example.test/next'">"#,
            )
            .as_deref(),
            Some("https://publisher.example.test/next")
        );
        assert_eq!(
            google_news_public_target_from_wrapper_html(
                base,
                r#"<meta property="og:url" content="https://publisher.example.test/open-graph">"#,
            )
            .as_deref(),
            Some("https://publisher.example.test/open-graph")
        );
        let late_metadata = format!(
            "{}<meta name=\"twitter:url\" content=\"https://publisher.example.test/late\">",
            "x".repeat(300 * 1024)
        );
        assert_eq!(
            google_news_public_target_from_wrapper_html(base, &late_metadata).as_deref(),
            Some("https://publisher.example.test/late")
        );
    }

    #[test]
    fn google_news_wrapper_html_refuses_unsafe_or_google_targets() {
        let base = "https://news.google.com/rss/articles/opaque-token";
        for html in [
            r#"<link rel="canonical" href="http://publisher.example.test/insecure">"#,
            r#"<meta http-equiv="refresh" content="0; url=https://127.0.0.1/private">"#,
            r#"<link rel="canonical" href="https://news.google.com/read/another-wrapper">"#,
            r#"<p>https://localhost/private</p>"#,
            r#"<script>const analytics = "https://publisher.example.test/not-article";</script>"#,
        ] {
            assert!(google_news_public_target_from_wrapper_html(base, html).is_none());
        }
        assert!(google_news_public_target_from_wrapper_html(
            "https://publisher.example.test/not-a-google-wrapper",
            r#"<link rel="canonical" href="https://other.example.test/story">"#,
        )
        .is_none());
    }

    #[test]
    fn identity_is_deterministic_per_source_guid_and_normalized_url() {
        assert_eq!(
            article_identity("a", "b", "https://example.test/a"),
            article_identity("a", "b", "https://example.test/a")
        );
        assert_ne!(
            article_identity("a", "b", "https://example.test/a"),
            article_identity("a", "c", "https://example.test/a")
        );
    }

    #[test]
    fn source_state_reuses_validators_and_backs_off_failures() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-source-state-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let source = HttpSource {
            source_id: "public-feed".into(),
            kind: "rss".into(),
            url: "https://example.test/feed.xml".into(),
            language: None,
            interval_seconds: Some(600),
        };
        let initial = SourceFetchState::default();
        let failed = SourceFetchResult {
            articles: Vec::new(),
            etag: Some("old-etag".into()),
            last_modified: None,
            failure: Some("network_request_failed".into()),
        };
        update_source_fetch_state(&catalog, &source, &initial, &failed).unwrap();
        let after_failure = source_fetch_state(&catalog, &source.source_id).unwrap();
        assert_eq!(after_failure.etag.as_deref(), Some("old-etag"));
        assert_eq!(after_failure.failure_count, 1);
        assert!(after_failure.next_fetch_at >= Utc::now().timestamp() + 25);

        let success = SourceFetchResult {
            articles: Vec::new(),
            etag: Some("new-etag".into()),
            last_modified: Some("Mon, 24 Aug 2026 00:00:00 GMT".into()),
            failure: None,
        };
        update_source_fetch_state(&catalog, &source, &after_failure, &success).unwrap();
        let after_success = source_fetch_state(&catalog, &source.source_id).unwrap();
        assert_eq!(after_success.etag.as_deref(), Some("new-etag"));
        assert_eq!(after_success.failure_count, 0);
        assert!(after_success.next_fetch_at >= Utc::now().timestamp() + 590);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn media_markup_parser_keeps_safe_relative_urls_and_attributes() {
        let html = r#"<article><img data-src="/image.webp" alt="图示"><iframe src="https://www.youtube.com/embed/x"></iframe></article>"#;
        let image = html_elements(html, "img");
        assert_eq!(image.len(), 1);
        assert_eq!(
            element_attribute(image[0], "data-src").as_deref(),
            Some("/image.webp")
        );
        assert_eq!(element_attribute(image[0], "alt").as_deref(), Some("图示"));
        assert_eq!(
            absolute_public_url("https://example.test/news/a", "/image.webp").as_deref(),
            Some("https://example.test/image.webp")
        );
        assert!(absolute_public_url("https://example.test/news/a", "http://127.0.0.1/a").is_none());
    }

    #[test]
    fn manual_redirect_targets_are_revalidated_at_every_hop() {
        assert_eq!(
            absolute_public_url("https://news.example.test/feed/item", "/article/one").as_deref(),
            Some("https://news.example.test/article/one")
        );
        assert_eq!(
            absolute_public_url(
                "https://news.example.test/feed/item",
                "https://publisher.example.test/article/one"
            )
            .as_deref(),
            Some("https://publisher.example.test/article/one")
        );
        assert!(absolute_public_url(
            "https://news.example.test/feed/item",
            "http://127.0.0.1/private"
        )
        .is_none());
        assert!(absolute_public_url(
            "https://news.example.test/feed/item",
            "http://[::1]/private"
        )
        .is_none());
    }

    #[test]
    fn article_cleaner_excludes_site_chrome_and_keeps_article_evidence() {
        let html = r#"
            <header>站点导航与订阅按钮</header>
            <script>window.tracker = '广告脚本'</script>
            <main><article><p>这是应交给模型的第一段证据。</p><aside>相关推荐</aside><p>这是第二段事实。</p></article></main>
            <footer>版权页脚</footer>
        "#;
        let body = strip_html(&clean_article_html(html));
        assert!(body.contains("第一段证据"));
        assert!(body.contains("第二段事实"));
        assert!(!body.contains("站点导航"));
        assert!(!body.contains("广告脚本"));
        assert!(!body.contains("相关推荐"));
        assert!(!body.contains("版权页脚"));
    }

    #[test]
    fn static_extractor_prefers_semantic_article_over_static_site_chrome() {
        let html = r#"
          <header>导航 导航 导航 订阅 广告</header>
          <article><p>第一段公开报道解释了事件发生的时间、地点和已经由多个来源确认的基本事实，并说明后续调查仍在持续进行。</p>
          <p>第二段继续列出有关部门公开的应对措施、仍待核实的细节，以及读者理解这次进展所需的背景信息。</p>
          <p>第三段补充了与此前报道的联系，明确区分了已经确认的事实与目前尚不能确定的说法。</p></article>
          <footer>隐私 Cookie 帮助</footer>
        "#;
        let body = extract_static_article_body(html).expect("semantic article body");
        assert!(body.contains("多个来源确认"));
        assert!(!body.contains("导航 导航"));
        assert!(!body.contains("隐私 Cookie"));
    }

    #[test]
    fn static_extractor_accepts_public_article_body_attribute_without_script_execution() {
        let html = r#"
          <div itemprop="articleBody"><p>第一段使用公开的 articleBody 语义属性标记，提供了足够完整的事件事实、来源背景以及已经确认的官方信息，能够直接作为静态正文归档。</p>
          <p>第二段继续说明不同主体的公开回应和后续安排，避免仅凭页面标题或搜索摘要推断新闻细节。</p>
          <p>第三段给出关联时间线的必要背景，使后续模型可以基于完整文本判断这是否属于旧事件的发展。</p></div>
          <script>window.privateApi = '/not-requested';</script>
        "#;
        let body = extract_static_article_body(html).expect("itemprop article body");
        assert!(body.contains("articleBody 语义属性"));
        assert!(!body.contains("privateApi"));
    }

    #[test]
    fn static_extractor_accepts_class_named_story_body_and_continuous_paragraphs() {
        let class_named = r#"
          <div class="layout"><div class="story-body article-content">
          <p>第一段由公开页面直接提供，详细说明这项政策变化的适用范围、发布时间和已知影响，长度足以形成独立证据。</p>
          <p>第二段补充了官方回应和市场反应，并清楚说明哪些信息来自确认公告，哪些只是后续观察。</p>
          <p>第三段给出历史背景和下一步时间安排，帮助读者将此次发展与既有事件时间线对应起来。</p>
          </div></div>
        "#;
        let body = extract_static_article_body(class_named).expect("class named body");
        assert!(body.contains("政策变化的适用范围"));

        let paragraphs = r#"
          <div><p>第一段没有使用 article 或 class 标记，但页面静态暴露了连续的长段落，说明这项公开事件的时间和地点以及多个相关主体。</p>
          <p>第二段继续补充官方公开资料、已确认数据和仍在等待独立核验的事项，不能被导航或短摘要替代。</p>
          <p>第三段明确前情和后续计划，使本地归档可以保留完整上下文并交给模型进行后续事件关系判断。</p></div>
        "#;
        let body = extract_static_article_body(paragraphs).expect("continuous paragraphs");
        assert!(body.contains("没有使用 article"));
        assert!(body.contains("后续事件关系判断"));
    }

    #[test]
    fn static_extractor_rejects_teasers_and_static_shells() {
        assert!(extract_static_article_body(
            "<main><p>这是一段很短的摘要，不足以作为完整新闻正文。</p></main>"
        )
        .is_none());
        assert!(extract_static_article_body(
            "<main><p>Please enable JavaScript to continue reading this public page. Please enable JavaScript to continue reading this public page. Please enable JavaScript to continue reading this public page.</p></main>"
        )
        .is_none());
    }

    #[test]
    fn structured_article_body_recovers_public_json_ld_without_executing_page_code() {
        let html = r#"
          <html><head><script type="application/ld+json">
          {"@context":"https://schema.org","@type":"NewsArticle","articleBody":"第一段公开结构化正文，包含足够长的事实描述以便作为新闻证据保留。第二段继续说明公开事件细节。"}
          </script></head><body><main><div id="app"></div></main></body></html>
        "#;
        let body = structured_article_body(html).expect("JSON-LD articleBody should be accepted");
        assert!(body.contains("公开结构化正文"));
        assert!(body.len() >= 80);
    }

    #[test]
    fn structured_article_body_recovers_public_next_data_without_executing_page_code() {
        let html = r#"
          <html><head><script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"article":{"articleBody":"这是公开页面内嵌的完整文章正文，包含足够长的事实描述，以便本机归档和后续模型核验。第二段继续给出可交叉验证的公开细节。"}}}}
          </script></head><body><main><div id="app">加载中</div></main></body></html>
        "#;
        let body =
            structured_article_body(html).expect("public JSON articleBody should be accepted");
        assert!(body.contains("完整文章正文"));
        assert!(body.len() >= 80);
    }

    #[test]
    fn structured_json_script_rejects_executable_script_even_when_its_text_mentions_article_body() {
        assert!(!structured_json_script(
            "<script>window.payload = { articleBody: 'not parsed' }</script>"
        ));
    }

    #[test]
    fn body_gap_reason_separates_paywall_from_missing_public_body() {
        assert_eq!(
            article_body_gap_reason("<html>Subscribe to continue reading</html>"),
            "article_paywall_or_interstitial"
        );
        assert_eq!(
            article_body_gap_reason("<html><div id='app'></div></html>"),
            "article_body_not_found"
        );
    }

    #[test]
    fn injected_port_is_collection_boundary_without_page_or_network() {
        let root = std::env::temp_dir().join(format!("kunpeng-collector-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let port = FixturePort {
            items: vec![item()],
        };
        let (batch_id, articles) = port.collect().unwrap();
        let first = collect_once_at(&catalog, &batch_id, articles).unwrap();
        assert_eq!(
            first,
            CollectionResult {
                received: 1,
                collected: 1,
                duplicates: 0,
                failed: 0
            }
        );
        let (_, replay) = port.collect().unwrap();
        let second = collect_once_at(&catalog, "batch.replay", replay).unwrap();
        assert_eq!(
            second,
            CollectionResult {
                received: 1,
                collected: 0,
                duplicates: 1,
                failed: 0
            }
        );
        let count: u64 = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM intelligence_collection_records",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let queue: u64 = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM intelligence_articles WHERE triage_state='queued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queue, 1);
        assert!(root.join("blobs").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cross_source_same_url_reuses_exact_body_without_a_second_article_or_model_queue() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-url-alias-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let first = item();
        let mut syndicated = first.clone();
        syndicated.source_id = "second-public-source".into();
        syndicated.guid = "second-source-guid".into();
        syndicated.url = "https://example.test/a#same-public-page".into();
        syndicated.body = Some("第一段\r\n\r\n第二段\r\n".into());
        syndicated.html = None;

        let result =
            collect_once_at(&catalog, "batch.url-alias", vec![first.clone(), syndicated]).unwrap();
        assert_eq!(result.collected, 1);
        assert_eq!(result.duplicates, 1);

        let normalized = normalized_url(&first.url).unwrap();
        let owner_id = article_identity(&first.source_id, &first.guid, &normalized);
        let connection = Connection::open(&catalog).unwrap();
        let articles: i64 = connection
            .query_row("SELECT COUNT(*) FROM intelligence_articles", [], |row| {
                row.get(0)
            })
            .unwrap();
        let records: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM intelligence_collection_records WHERE normalized_url=?1",
                [&normalized],
                |row| row.get(0),
            )
            .unwrap();
        let source_record_owner: String = connection
            .query_row(
                "SELECT article_id FROM intelligence_collection_records
                 WHERE source_id='second-public-source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let aliases: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM intelligence_collection_url_aliases
                 WHERE normalized_url=?1 AND canonical_article_id=?2",
                params![normalized, owner_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(articles, 1);
        assert_eq!(records, 2);
        assert_eq!(source_record_owner, owner_id);
        assert_eq!(aliases, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn complete_url_aliases_exposes_only_immutable_current_evidence_to_fetch_scheduler() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-url-alias-prefetch-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let first = item();
        collect_once_at(&catalog, "batch.url-prefetch", vec![first.clone()]).unwrap();
        let normalized = normalized_url(&first.url).unwrap();
        assert!(complete_url_aliases(&catalog)
            .unwrap()
            .contains(&normalized));

        let mut incomplete = first;
        incomplete.url = "https://example.test/no-body".into();
        incomplete.guid = "without-body".into();
        incomplete.body = None;
        incomplete.html = None;
        incomplete.body_status = None;
        incomplete.incomplete_reason = Some("deferred_content_backfill".into());
        collect_once_at(&catalog, "batch.url-incomplete", vec![incomplete.clone()]).unwrap();
        let incomplete_url = normalized_url(&incomplete.url).unwrap();
        assert!(!complete_url_aliases(&catalog)
            .unwrap()
            .contains(&incomplete_url));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_url_with_changed_canonical_body_is_not_merged_by_url_alias() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-url-alias-change-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let first = item();
        let mut updated = first.clone();
        updated.source_id = "independent-public-source".into();
        updated.guid = "updated-guid".into();
        updated.title = "同一 URL 的已更新公共报道".into();
        updated.body = Some("这是不同的完整正文，不能因为 URL 相同而与旧正文合并。".into());
        updated.html = None;

        let result = collect_once_at(&catalog, "batch.url-change", vec![first, updated]).unwrap();
        assert_eq!(result.collected, 2);
        assert_eq!(result.duplicates, 0);
        let connection = Connection::open(&catalog).unwrap();
        let articles: i64 = connection
            .query_row("SELECT COUNT(*) FROM intelligence_articles", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(articles, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn complete_secondary_source_hydrates_incomplete_url_owner_once() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-url-alias-hydrate-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let mut first = item();
        first.body = None;
        first.html = None;
        first.body_status = None;
        first.incomplete_reason = Some("deferred_content_backfill".into());
        let mut second = item();
        second.source_id = "secondary-full-source".into();
        second.guid = "secondary-full-guid".into();

        let result =
            collect_once_at(&catalog, "batch.url-hydrate", vec![first.clone(), second]).unwrap();
        assert_eq!(result.collected, 1);
        assert_eq!(result.duplicates, 1);
        let normalized = normalized_url(&first.url).unwrap();
        let owner_id = article_identity(&first.source_id, &first.guid, &normalized);
        let fingerprint = record_fingerprint(&first, &normalized);
        assert!(content_archive::has_current_complete_content_at(
            &catalog,
            &owner_id,
            &fingerprint
        )
        .unwrap());
        let articles: i64 = Connection::open(&catalog)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM intelligence_articles", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(articles, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unchanged_legacy_record_backfills_complete_evidence_without_requeueing() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let first = item();
        let source_id = first.source_id.clone();
        let normalized = normalized_url(&first.url).unwrap();
        let article_id = article_identity(&source_id, &first.guid, &normalized);
        let fingerprint = record_fingerprint(&first, &normalized);

        // Simulate the pre-full-text archive: the old record and article
        // exist, but no immutable content revision was ever written.
        upsert_article(&catalog, &article_id, &fingerprint, &first, &normalized).unwrap();
        store_record(
            &catalog,
            "batch.legacy",
            &first,
            &normalized,
            &article_id,
            &fingerprint,
        )
        .unwrap();
        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_articles SET triage_state='keep' WHERE article_id=?1",
                [&article_id],
            )
            .unwrap();

        let result = collect_once_at(&catalog, "batch.backfill", vec![first]).unwrap();
        assert_eq!(result.collected, 0);
        assert_eq!(result.duplicates, 1);
        let connection = Connection::open(&catalog).unwrap();
        let state: String = connection
            .query_row(
                "SELECT triage_state FROM intelligence_articles WHERE article_id=?1",
                [&article_id],
                |row| row.get(0),
            )
            .unwrap();
        let complete: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM intelligence_article_content_versions
                 WHERE article_id=?1 AND record_fingerprint=?2
                   AND body_status='complete' AND is_current=1",
                params![article_id, fingerprint],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "keep");
        assert_eq!(complete, 1);
        assert!(content_archive::has_current_complete_content_at(
            &catalog,
            &article_id,
            &fingerprint,
        )
        .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    struct BackfillFixture(Result<BackfilledEvidence, ContentBackfillFailure>);

    impl ContentBackfillPort for BackfillFixture {
        fn fetch(
            &self,
            _: &ContentBackfillCandidate,
        ) -> Result<BackfilledEvidence, ContentBackfillFailure> {
            self.0
                .as_ref()
                .map(|value| BackfilledEvidence {
                    text: value.text.clone(),
                    html: value.html.clone(),
                    images: Vec::new(),
                    videos: Vec::new(),
                })
                .map_err(Clone::clone)
        }
    }

    #[test]
    fn bounded_backfill_persists_legacy_evidence_without_changing_article_fingerprint() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-port-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();
        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_articles SET triage_state='keep' WHERE article_id=?1",
                [&article_id],
            )
            .unwrap();

        let result = backfill_missing_content_once_at(
            &catalog,
            &BackfillFixture(Ok(BackfilledEvidence {
                text: "完整证据第一段。\n\n完整证据第二段。".into(),
                html: Some("<article>完整证据</article>".into()),
                images: Vec::new(),
                videos: Vec::new(),
            })),
        )
        .unwrap();
        assert_eq!(result.attempted, 1);
        assert_eq!(result.completed, 1);
        assert_eq!(result.retried, 0);
        let connection = Connection::open(&catalog).unwrap();
        let row: (String, String, i64) = connection
            .query_row(
                "SELECT a.fingerprint,v.record_fingerprint,v.is_current
                 FROM intelligence_articles a JOIN intelligence_article_content_versions v
                 ON v.article_id=a.article_id WHERE a.article_id=?1",
                [&article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (fingerprint.clone(), fingerprint, 1));
        let state: String = connection
            .query_row(
                "SELECT triage_state FROM intelligence_articles WHERE article_id=?1",
                [&article_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "keep");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_record_fingerprint_requeues_even_when_an_old_body_exists() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-fingerprint-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let mut original = item();
        original.html = None;
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let original_fingerprint = record_fingerprint(&original, &normalized);

        // First persist valid evidence for a prior feed revision.
        assert_eq!(
            collect_once_at(&catalog, "batch.original", vec![original.clone()])
                .unwrap()
                .collected,
            1
        );
        assert!(content_archive::has_current_complete_content_at(
            &catalog,
            &article_id,
            &original_fingerprint,
        )
        .unwrap());

        // The source then edits its record, but the newer feed payload does
        // not carry a full body.  The old revision is still valuable history,
        // not valid evidence for the new fingerprint.
        let mut revised = original;
        revised.summary = "来源补充了新事实，正文稍后回填。".into();
        revised.body = None;
        revised.html = None;
        revised.body_status = None;
        revised.incomplete_reason = Some("deferred_content_backfill".into());
        let revised_fingerprint = record_fingerprint(&revised, &normalized);
        assert_ne!(revised_fingerprint, original_fingerprint);
        upsert_article(
            &catalog,
            &article_id,
            &revised_fingerprint,
            &revised,
            &normalized,
        )
        .unwrap();

        let result = backfill_missing_content_once_at(
            &catalog,
            &BackfillFixture(Ok(BackfilledEvidence {
                text: "更新后的完整证据。".into(),
                html: None,
                images: Vec::new(),
                videos: Vec::new(),
            })),
        )
        .unwrap();
        assert_eq!(result.completed, 1);
        assert!(content_archive::has_current_complete_content_at(
            &catalog,
            &article_id,
            &revised_fingerprint,
        )
        .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validator_refresh_with_same_body_advances_evidence_without_model_requeue() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-validator-refresh-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let mut original = item();
        original.html = None;
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let original_fingerprint = record_fingerprint(&original, &normalized);
        assert_eq!(
            collect_once_at(&catalog, "batch.original", vec![original.clone()])
                .unwrap()
                .collected,
            1
        );
        // Establish the durable canonical identity first, as the worker does
        // before the small-model lease.  The refresh below must become an
        // alias of that identity and must not require a model service.
        super::super::processing::reconcile_canonical_content_at(&catalog).unwrap();

        let mut refreshed = original;
        refreshed.etag = Some("etag-b".into());
        refreshed.last_modified = Some("Sun, 24 Aug 2026 00:00:00 GMT".into());
        let refreshed_fingerprint = record_fingerprint(&refreshed, &normalized);
        assert_ne!(original_fingerprint, refreshed_fingerprint);
        assert_eq!(
            collect_once_at(&catalog, "batch.validator-refresh", vec![refreshed])
                .unwrap()
                .collected,
            1
        );

        let connection = Connection::open(&catalog).unwrap();
        let current: (String, String, i64) = connection
            .query_row(
                "SELECT a.fingerprint,v.record_fingerprint,v.is_current
                 FROM intelligence_articles a JOIN intelligence_article_content_versions v
                   ON v.article_id=a.article_id
                 WHERE a.article_id=?1 AND v.is_current=1",
                [&article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            current,
            (
                refreshed_fingerprint.clone(),
                refreshed_fingerprint.clone(),
                1
            )
        );
        let distinct_text_blobs: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT text_sha256) FROM intelligence_article_content_versions
                 WHERE article_id=?1",
                [&article_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(distinct_text_blobs, 1);
        drop(connection);

        super::super::processing::reconcile_canonical_content_at(&catalog).unwrap();
        let connection = Connection::open(&catalog).unwrap();
        let canonical: (String, String) = connection
            .query_row(
                "SELECT canonical_article_id,canonical_fingerprint
                 FROM intelligence_worker_canonical_aliases
                 WHERE article_id=?1 AND fingerprint=?2",
                params![article_id, refreshed_fingerprint],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(canonical, (article_id.clone(), original_fingerprint));
        drop(connection);
        let (_, handoff, _) =
            super::super::claim_one_at(&catalog, "test-validator-refresh").unwrap();
        assert!(handoff.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backfill_uses_durable_collection_url_when_a_legacy_article_url_is_empty() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-url-fallback-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();
        store_record(
            &catalog,
            "batch.url-fallback",
            &original,
            &normalized,
            &article_id,
            &fingerprint,
        )
        .unwrap();
        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_articles SET url='' WHERE article_id=?1",
                [&article_id],
            )
            .unwrap();

        let result = backfill_missing_content_once_at(
            &catalog,
            &BackfillFixture(Ok(BackfilledEvidence {
                text: "由归档记录恢复的完整正文。".into(),
                html: None,
                images: Vec::new(),
                videos: Vec::new(),
            })),
        )
        .unwrap();
        assert_eq!(result.completed, 1);
        assert!(content_archive::has_current_complete_content_at(
            &catalog,
            &article_id,
            &fingerprint,
        )
        .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_backfill_failures_have_stable_operator_safe_categories() {
        assert_eq!(
            classify_content_backfill_failure(Some("article_http_status_429")).reason,
            "http_rate_limited"
        );
        assert_eq!(
            classify_content_backfill_failure(Some("article_http_status_403")).reason,
            "http_access_denied"
        );
        assert_eq!(
            classify_content_backfill_failure(Some("article_paywall_or_interstitial")).reason,
            "body_paywall_or_interstitial"
        );
        assert_eq!(
            classify_content_backfill_failure(Some("article_network_request_failed")).reason,
            "network_request_failed"
        );
        assert_eq!(
            classify_content_backfill_failure(Some("google_news_discovery_only")).reason,
            "google_news_discovery_only"
        );
    }

    #[test]
    fn backfill_selection_is_source_fair_without_stranding_a_single_source() {
        let mut candidates = vec![
            backfill_candidate("a-1", "https://alpha.example/1"),
            backfill_candidate("a-2", "https://alpha.example/2"),
            backfill_candidate("a-3", "https://alpha.example/3"),
            backfill_candidate("b-1", "https://bravo.example/1"),
            backfill_candidate("b-2", "https://bravo.example/2"),
            backfill_candidate("c-1", "https://charlie.example/1"),
        ];
        let selected = fair_backfill_candidates(candidates.clone());
        assert_eq!(
            selected
                .iter()
                .map(|candidate| candidate.article_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-1", "b-1", "c-1", "a-2", "b-2", "a-3"]
        );

        candidates.extend((0..(MAX_CONTENT_BACKFILL_PER_RUN + 8)).map(|index| {
            backfill_candidate(
                &format!("only-{index}"),
                &format!("https://only.example/{index}"),
            )
        }));
        let single_source = fair_backfill_candidates(
            candidates
                .into_iter()
                .filter(|candidate| backfill_source_lane(&candidate.url) == "only.example")
                .collect(),
        );
        assert_eq!(single_source.len(), MAX_CONTENT_BACKFILL_PER_RUN);
    }

    #[test]
    fn backfill_candidate_page_interleaves_fresh_and_historical_windows() {
        let newest = vec![
            backfill_candidate("new-1", "https://new-1.example/1"),
            backfill_candidate("new-2", "https://new-2.example/2"),
            backfill_candidate("new-3", "https://new-3.example/3"),
        ];
        let oldest = vec![
            backfill_candidate("old-1", "https://old-1.example/1"),
            backfill_candidate("old-2", "https://old-2.example/2"),
        ];
        assert_eq!(
            interleave_fresh_and_historical_backfill(newest, oldest)
                .iter()
                .map(|candidate| candidate.article_id.as_str())
                .collect::<Vec<_>>(),
            vec!["new-1", "old-1", "new-2", "old-2", "new-3"]
        );
    }

    #[test]
    fn backfill_waves_never_parallelize_the_same_publisher() {
        let candidates = vec![
            backfill_candidate("a-1", "https://alpha.example/1"),
            backfill_candidate("a-2", "https://alpha.example/2"),
            backfill_candidate("b-1", "https://bravo.example/1"),
            backfill_candidate("b-2", "https://bravo.example/2"),
            backfill_candidate("c-1", "https://charlie.example/1"),
            backfill_candidate("d-1", "https://delta.example/1"),
            backfill_candidate("e-1", "https://echo.example/1"),
        ];
        let waves = backfill_fetch_waves(candidates.clone());
        assert_eq!(waves.len(), 2);
        assert!(waves
            .iter()
            .all(|wave| wave.len() <= MAX_CONTENT_BACKFILL_PARALLEL_FETCHES));
        let flattened = waves
            .iter()
            .flat_map(|wave| wave.iter().map(|candidate| candidate.article_id.clone()))
            .collect::<Vec<_>>();
        assert_eq!(flattened.len(), candidates.len());
        for wave in waves {
            let lanes = wave
                .iter()
                .map(|candidate| backfill_source_lane(&candidate.url))
                .collect::<HashSet<_>>();
            assert_eq!(lanes.len(), wave.len());
        }
    }

    #[test]
    fn failed_backfill_is_delayed_instead_of_hot_looping() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-retry-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();

        let first = backfill_missing_content_once_at(
            &catalog,
            &BackfillFixture(Err(ContentBackfillFailure::new("http_rate_limited"))),
        )
        .unwrap();
        let second = backfill_missing_content_once_at(
            &catalog,
            &BackfillFixture(Err(ContentBackfillFailure::new("http_rate_limited"))),
        )
        .unwrap();
        assert_eq!(
            first,
            ContentBackfillResult {
                attempted: 1,
                completed: 0,
                retried: 1
            }
        );
        assert_eq!(second.attempted, 0);
        let state: (i64, String, i64, Option<i64>) = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT attempts,last_failure_reason,next_retry_at,last_success_at
                 FROM intelligence_content_backfill_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(state.0, 1);
        assert_eq!(state.1, "http_rate_limited");
        assert!(state.2 > Utc::now().timestamp_millis());
        assert_eq!(state.3, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_host_backfill_pass_never_reclaims_a_failed_article() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-pass-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();

        let first = backfill_missing_content_once_for_pass_at(
            &catalog,
            &BackfillFixture(Err(ContentBackfillFailure::new("http_access_denied"))),
            Some("host-round-a"),
        )
        .unwrap();
        assert_eq!(first.attempted, 1);

        // Model both the per-article retry and the publisher circuit expiring
        // while a later supervised round begins.
        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_content_backfill_state SET next_retry_at=0",
                [],
            )
            .unwrap();
        let same_pass = backfill_missing_content_once_for_pass_at(
            &catalog,
            &BackfillFixture(Err(ContentBackfillFailure::new("http_access_denied"))),
            Some("host-round-a"),
        )
        .unwrap();
        assert_eq!(same_pass.attempted, 0);

        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_content_backfill_hosts SET next_allowed_at=0",
                [],
            )
            .unwrap();

        let next_pass = backfill_missing_content_once_for_pass_at(
            &catalog,
            &BackfillFixture(Err(ContentBackfillFailure::new("http_access_denied"))),
            Some("host-round-b"),
        )
        .unwrap();
        assert_eq!(next_pass.attempted, 1);
        let attempts: i64 = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT attempts FROM intelligence_content_backfill_state WHERE article_id=?1",
                [&article_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_public_content_failures_enter_a_long_cooldown() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-cooldown-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let before = Utc::now().timestamp_millis();
        record_content_backfill_retry(
            &catalog,
            "terminal-article",
            &ContentBackfillFailure::new("body_paywall_or_interstitial"),
            Some("host-round"),
        )
        .unwrap();
        let retry_at: i64 = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT next_retry_at FROM intelligence_content_backfill_state WHERE article_id='terminal-article'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(retry_at >= before + CONTENT_BACKFILL_TERMINAL_DELAY_MS);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn body_not_found_receives_one_retry_after_static_extractor_upgrade() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-extractor-revision-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();
        record_content_backfill_retry(
            &catalog,
            &article_id,
            &ContentBackfillFailure::new("body_not_found"),
            None,
        )
        .unwrap();
        // Model a durable gap created by the immediately preceding extractor
        // revision. Its long terminal delay must not prevent the one upgrade
        // retry, but the new revision must then be recorded durably.
        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_content_backfill_state
                 SET extractor_revision=?2,next_retry_at=?3 WHERE article_id=?1",
                params![
                    article_id,
                    PUBLIC_STATIC_EXTRACTOR_REVISION - 1,
                    CONTENT_BACKFILL_NEVER_RETRY_AT
                ],
            )
            .unwrap();
        let upgraded = next_content_backfill_candidates(&catalog).unwrap();
        assert_eq!(upgraded.len(), 1);
        assert_eq!(upgraded[0].article_id, article_id);

        record_content_backfill_retry(
            &catalog,
            &upgraded[0].article_id,
            &ContentBackfillFailure::new("body_not_found"),
            None,
        )
        .unwrap();
        assert!(next_content_backfill_candidates(&catalog)
            .unwrap()
            .is_empty());
        let revision: i64 = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT extractor_revision FROM intelligence_content_backfill_state WHERE article_id=?1",
                [&article_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, PUBLIC_STATIC_EXTRACTOR_REVISION);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unresolved_google_wrapper_is_retained_once_per_resolver_revision() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-google-discovery-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let original = item();
        let normalized = normalized_url(&original.url).unwrap();
        let article_id = article_identity(&original.source_id, &original.guid, &normalized);
        let fingerprint = record_fingerprint(&original, &normalized);
        upsert_article(&catalog, &article_id, &fingerprint, &original, &normalized).unwrap();
        record_content_backfill_retry(
            &catalog,
            &article_id,
            &ContentBackfillFailure::new("google_news_discovery_only"),
            None,
        )
        .unwrap();
        assert!(next_content_backfill_candidates(&catalog)
            .unwrap()
            .is_empty());
        let state: (String, i64, i64) = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT last_failure_reason,next_retry_at,extractor_revision
                 FROM intelligence_content_backfill_state WHERE article_id=?1",
                [&article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state.0, "google_news_discovery_only");
        assert_eq!(state.1, CONTENT_BACKFILL_NEVER_RETRY_AT);
        assert_eq!(state.2, GOOGLE_NEWS_WRAPPER_RESOLVER_REVISION);

        Connection::open(&catalog)
            .unwrap()
            .execute(
                "UPDATE intelligence_content_backfill_state
                 SET extractor_revision=?2 WHERE article_id=?1",
                params![article_id, GOOGLE_NEWS_WRAPPER_RESOLVER_REVISION - 1],
            )
            .unwrap();
        let upgraded = next_content_backfill_candidates(&catalog).unwrap();
        assert_eq!(upgraded.len(), 1);
        assert_eq!(upgraded[0].article_id, article_id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rate_limited_publisher_opens_a_durable_host_circuit() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-host-circuit-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let first = backfill_candidate("one", "https://publisher.example.test/one");
        let second = backfill_candidate("two", "https://publisher.example.test/two");
        assert!(content_backfill_host_allowed_at(&catalog, &first).unwrap());
        record_content_backfill_host_failure(
            &catalog,
            &first,
            &ContentBackfillFailure::new("http_rate_limited"),
        )
        .unwrap();
        assert!(!content_backfill_host_allowed_at(&catalog, &second).unwrap());
        let state: (i64, String) = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT failure_count,last_failure_reason FROM intelligence_content_backfill_hosts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, (1, "http_rate_limited".into()));
        record_content_backfill_host_success(&catalog, &second).unwrap();
        assert!(content_backfill_host_allowed_at(&catalog, &first).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn candidate_selection_filters_limited_hosts_before_batch_limit() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-backfill-limited-hosts-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let mut candidates = Vec::new();
        for index in 0..MAX_CONTENT_BACKFILL_PER_RUN {
            let candidate = backfill_candidate(
                &format!("limited-{index}"),
                &format!("https://limited-{index}.example.test/story"),
            );
            record_content_backfill_host_failure(
                &catalog,
                &candidate,
                &ContentBackfillFailure::new("http_rate_limited"),
            )
            .unwrap();
            candidates.push(candidate);
        }
        candidates.push(backfill_candidate(
            "ready-after-limited-hosts",
            "https://ready.example.test/story",
        ));

        let source_ready = source_ready_backfill_candidates(&catalog, candidates).unwrap();
        let selected = fair_backfill_candidates(source_ready);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].article_id, "ready-after-limited-hosts");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collected_archived_article_can_be_claimed_and_triaged_without_page_or_network() {
        // This composes the worker's two durable boundaries against one
        // temporary catalog: injected collection writes immutable paragraphs,
        // then the headless worker claims and records a typed 7B/8B decision.
        // Neither half constructs a WebView, opens a listener, or contacts a
        // source/model endpoint.
        let root =
            std::env::temp_dir().join(format!("kunpeng-collector-triage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let result = collect_once_at(&catalog, "batch.triage", vec![item()]).unwrap();
        assert_eq!(result.collected, 1);

        // Collection intentionally has no model-table dependency.  The main
        // permanent-store bootstrap owns this compatible table in production;
        // add only that schema slice here so this remains a local fixture.
        Connection::open(&catalog)
            .unwrap()
            .execute_batch(
                "CREATE TABLE intelligence_triage_decisions (
                    article_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    model_id TEXT NOT NULL, model_sha TEXT, prompt_version TEXT NOT NULL,
                    status TEXT NOT NULL, importance REAL, confidence REAL, reason TEXT,
                    decision_json TEXT, decided_at INTEGER NOT NULL,
                    PRIMARY KEY(article_id,fingerprint,model_id,prompt_version)
                );",
            )
            .unwrap();
        let (_, claim, _) = super::super::claim_one_at(&catalog, "fixture-worker").unwrap();
        let claim = claim.expect("collection creates one queued article");
        let model =
            super::super::triage::model_from_parts("http://127.0.0.1:8081/v1", "Qwen3-8B-Q4")
                .unwrap();
        let decision = super::super::TriageDecision {
            keep: true,
            importance: 82,
            confidence: 0.94,
            topic: "国际".into(),
            primary_entities: vec!["主体".into()],
            event_time: "2026-08-23".into(),
            place: "北京".into(),
            reason: "fixture evidence".into(),
        };
        assert_eq!(
            super::super::apply_decision_at(&catalog, &claim, &model, Ok(decision))
                .unwrap()
                .0,
            super::super::AppliedState::Triaged
        );
        let connection = Connection::open(&catalog).unwrap();
        let paragraphs: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM intelligence_article_paragraphs",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let triaged: String = connection
            .query_row(
                "SELECT triage_state FROM intelligence_articles",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(paragraphs, 2);
        assert_eq!(triaged, "keep");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_port_rejects_empty_or_oversized_batches() {
        let root =
            std::env::temp_dir().join(format!("kunpeng-collector-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("input.json");
        fs::write(&input, r#"{"articles":[]}"#).unwrap();
        assert!(FileCollector::new(&input).collect().is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_feed_parsers_keep_identity_and_do_not_merge_same_topic_items() {
        let source = HttpSource {
            source_id: "fixture-feed".into(),
            kind: "rss".into(),
            url: "https://feeds.example.test/news.xml".into(),
            language: Some("zh".into()),
            interval_seconds: Some(60),
        };
        let xml = r#"<rss><channel><item><guid>same-topic-a</guid><title>同主题的第一件事</title><link>https://news.example.test/a</link><description>摘要 A</description><pubDate>Mon, 24 Aug 2026 01:00:00 +0000</pubDate></item><item><guid>same-topic-b</guid><title>同主题的第二件事</title><link>https://news.example.test/b</link><description>摘要 B</description></item></channel></rss>"#;
        let entries = parse_xml_entries(&source, xml);
        assert_eq!(entries.len(), 2);
        assert_ne!(entries[0].guid, entries[1].guid);
        assert_ne!(entries[0].url, entries[1].url);
        assert_eq!(
            entries[0].published_at.as_deref(),
            Some("2026-08-24T01:00:00Z")
        );

        let json = r#"{"articles":[{"id":"json-1","headline":"JSON 标题","canonicalUrl":"https://news.example.test/json","content":"可公开归档的正文","publishedAt":"2026-08-24"}]}"#;
        let entries = parse_json_entries(&source, json);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].guid, "json-1");
        assert_eq!(entries[0].body.as_deref(), Some("可公开归档的正文"));
        assert_eq!(
            entries[0].published_at.as_deref(),
            Some("2026-08-24T00:00:00Z")
        );
        assert_eq!(
            normalize_published_at(Some("1787312011470".into())).as_deref(),
            Some("2026-08-21T11:33:31Z")
        );
    }

    #[test]
    fn rss_content_encoded_becomes_complete_evidence_without_page_backfill() {
        let source = HttpSource {
            source_id: "fixture-feed".into(),
            kind: "rss".into(),
            url: "https://feeds.example.test/news.xml".into(),
            language: Some("zh".into()),
            interval_seconds: Some(60),
        };
        let xml = r#"<rss><channel><item><guid>full-body</guid><title>含完整正文的 RSS</title><link>https://news.example.test/full</link><content:encoded><![CDATA[<p>这是一段由公开 RSS 直接提供的完整正文，用于验证采集器会优先归档公开内容，而不是把同一文章再次放进受限的网页全文回填队列。它包含足够多的可读文字，以满足正文完整性阈值并保留后续模型需要的原始证据。</p>]]></content:encoded></item></channel></rss>"#;
        let entries = parse_xml_entries(&source, xml);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].body_status.as_deref(), Some("complete"));
        assert!(entries[0]
            .body
            .as_deref()
            .is_some_and(|body| body.contains("公开 RSS 直接提供的完整正文")));
    }

    #[test]
    fn failed_public_source_is_durably_audited_with_a_reason() {
        let root = std::env::temp_dir().join(format!(
            "kunpeng-collector-failure-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.sqlite3");
        let source = HttpSource {
            source_id: "public-feed".into(),
            kind: "rss".into(),
            url: "https://feeds.example.test/fail.xml".into(),
            language: None,
            interval_seconds: None,
        };
        let result = collect_once_at(
            &catalog,
            "batch.failure",
            vec![source_failure(&source, "http_status_503")],
        )
        .unwrap();
        assert_eq!(result.failed, 1);
        let row: (String, String) = Connection::open(&catalog)
            .unwrap()
            .query_row(
                "SELECT fetch_status, failure_reason FROM intelligence_collection_records",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("failed".into(), "http_status_503".into()));
        let _ = fs::remove_dir_all(root);
    }
}
