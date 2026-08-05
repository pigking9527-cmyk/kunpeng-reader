//! A privacy-preserving, reader-oriented adapter for the public NewsNow API.
//!
//! News content is deliberately transient: it never enters the reader database,
//! search index, backup, or sync payload.  The WebView can only request IDs from
//! the local source catalogue, while the Rust side fetches and validates HTTPS
//! article URLs before handing them back to the UI.

use crate::{html_sanitize, url_open};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_BASE_URL: &str = "https://newsnow.busiyi.world";
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_SELECTED_SOURCES: usize = 12;
const MAX_ITEMS_PER_SOURCE: usize = 16;
const MAX_TOTAL_ITEMS: usize = 90;
const MAX_TEXT_CHARS: usize = 500;
const NEWS_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const ARTICLE_MAX_BYTES: u64 = 3 * 1024 * 1024;
const NEWSNOW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36";

/// This intentionally small catalogue is the product default, rather than an
/// unfiltered dump of every NewsNow source.  It is also the allowlist for
/// WebView requests, so a compromised page cannot turn the app into a general
/// HTTPS proxy.
const CURATED_SOURCES: &[NewsSource] = &[
    NewsSource {
        id: "weibo",
        name: "微博热搜",
        category: "热点",
        color: "#e95057",
        default_enabled: true,
    },
    NewsSource {
        id: "zhihu",
        name: "知乎热榜",
        category: "热点",
        color: "#4385f5",
        default_enabled: false,
    },
    NewsSource {
        id: "thepaper",
        name: "澎湃新闻",
        category: "热点",
        color: "#687487",
        default_enabled: true,
    },
    NewsSource {
        id: "baidu",
        name: "百度热搜",
        category: "热点",
        color: "#356df3",
        default_enabled: false,
    },
    NewsSource {
        id: "ithome",
        name: "IT之家",
        category: "科技",
        color: "#db3d35",
        default_enabled: true,
    },
    NewsSource {
        id: "hackernews",
        name: "Hacker News",
        category: "科技",
        color: "#f26922",
        default_enabled: false,
    },
    NewsSource {
        id: "github",
        name: "GitHub Trending",
        category: "科技",
        color: "#57606a",
        default_enabled: true,
    },
    NewsSource {
        id: "sspai",
        name: "少数派",
        category: "科技",
        color: "#d63b42",
        default_enabled: false,
    },
    NewsSource {
        id: "wallstreetcn-quick",
        name: "华尔街见闻",
        category: "财经",
        color: "#2f6fce",
        default_enabled: true,
    },
    NewsSource {
        id: "cls-telegraph",
        name: "财联社电报",
        category: "财经",
        color: "#de4f4f",
        default_enabled: false,
    },
    NewsSource {
        id: "zaobao",
        name: "联合早报",
        category: "国际",
        color: "#c9433d",
        default_enabled: true,
    },
    NewsSource {
        id: "cankaoxiaoxi",
        name: "参考消息",
        category: "国际",
        color: "#c0392b",
        default_enabled: false,
    },
    NewsSource {
        id: "36kr-quick",
        name: "36氪快讯",
        category: "科技",
        color: "#3671c9",
        default_enabled: false,
    },
    NewsSource {
        id: "coolapk",
        name: "酷安热榜",
        category: "科技",
        color: "#36a46c",
        default_enabled: false,
    },
    NewsSource {
        id: "aihot",
        name: "AIHOT",
        category: "科技",
        color: "#4385f5",
        default_enabled: false,
    },
    NewsSource {
        id: "juejin",
        name: "稀土掘金",
        category: "科技",
        color: "#3f7ad9",
        default_enabled: false,
    },
    NewsSource {
        id: "producthunt",
        name: "Product Hunt",
        category: "科技",
        color: "#dc4b32",
        default_enabled: false,
    },
    NewsSource {
        id: "bilibili-hot-search",
        name: "哔哩哔哩热搜",
        category: "热点",
        color: "#1687bc",
        default_enabled: false,
    },
    NewsSource {
        id: "douban",
        name: "豆瓣热门",
        category: "文化",
        color: "#15866b",
        default_enabled: false,
    },
    NewsSource {
        id: "hupu",
        name: "虎扑热帖",
        category: "体育",
        color: "#ce4d4d",
        default_enabled: false,
    },
    NewsSource {
        id: "dongqiudi",
        name: "懂球帝",
        category: "体育",
        color: "#349767",
        default_enabled: false,
    },
    NewsSource {
        id: "xueqiu-hotstock",
        name: "雪球热门股票",
        category: "财经",
        color: "#4584d9",
        default_enabled: false,
    },
    NewsSource {
        id: "jin10",
        name: "金十数据",
        category: "财经",
        color: "#3473d2",
        default_enabled: false,
    },
    NewsSource {
        id: "mktnews-flash",
        name: "MKTNews 快讯",
        category: "财经",
        color: "#4b59a7",
        default_enabled: false,
    },
    NewsSource {
        id: "gelonghui",
        name: "格隆汇",
        category: "财经",
        color: "#3d78c5",
        default_enabled: false,
    },
    NewsSource {
        id: "kaopu",
        name: "靠谱新闻",
        category: "国际",
        color: "#64748b",
        default_enabled: false,
    },
    NewsSource {
        id: "steam",
        name: "Steam 在线人数",
        category: "游戏",
        color: "#315a88",
        default_enabled: false,
    },
    NewsSource {
        id: "freebuf",
        name: "FreeBuf 网络安全",
        category: "科技",
        color: "#2e9a69",
        default_enabled: false,
    },
    NewsSource {
        id: "v2ex-share",
        name: "V2EX 最新分享",
        category: "科技",
        color: "#596579",
        default_enabled: false,
    },
    NewsSource {
        id: "tieba",
        name: "百度贴吧热议",
        category: "热点",
        color: "#3c78c8",
        default_enabled: false,
    },
    NewsSource {
        id: "toutiao",
        name: "今日头条热榜",
        category: "热点",
        color: "#d4473f",
        default_enabled: false,
    },
];

#[derive(Clone, Copy)]
struct NewsSource {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    color: &'static str,
    default_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowSource {
    pub id: String,
    pub name: String,
    pub category: String,
    pub color: String,
    pub default_enabled: bool,
}

impl From<NewsSource> for NewsNowSource {
    fn from(source: NewsSource) -> Self {
        Self {
            id: source.id.to_string(),
            name: source.name.to_string(),
            category: source.category.to_string(),
            color: source.color.to_string(),
            default_enabled: source.default_enabled,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowRequest {
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source: String,
    pub source_id: String,
    pub source_color: String,
    pub summary: String,
    pub published_at: String,
    pub image_url: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowList {
    pub items: Vec<NewsNowItem>,
    pub fetched_at: i64,
    pub message: String,
    pub source_count: usize,
    pub failed_sources: Vec<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowStatus {
    pub configured: bool,
    pub base_url: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowArticleRequest {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowArticle {
    pub url: String,
    pub title: String,
    pub source: String,
    pub published_at: String,
    pub content_html: String,
}

#[derive(Default)]
struct NewsCache {
    source_ids: Vec<String>,
    fetched_at: i64,
    fetched_instant: Option<Instant>,
    items: Vec<NewsNowItem>,
}

fn cache() -> &'static Mutex<NewsCache> {
    static CACHE: OnceLock<Mutex<NewsCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(NewsCache::default()))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn trim_chars(value: &str, limit: usize) -> String {
    let mut out = value.chars().take(limit).collect::<String>();
    if value.chars().nth(limit).is_some() {
        out.push('…');
    }
    out
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let rest = value
        .strip_prefix("https://")
        .ok_or_else(|| "资讯服务地址必须使用 HTTPS".to_string())?;
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("资讯服务地址无效".to_string());
    }
    if value.len() > 500 {
        return Err("资讯服务地址过长".to_string());
    }
    Ok(value.to_string())
}

fn base_url() -> Result<String, String> {
    validate_base_url(option_env!("KUNPENG_NEWSNOW_BASE_URL").unwrap_or(DEFAULT_BASE_URL))
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(NEWS_REQUEST_TIMEOUT))
        .timeout_connect(Some(Duration::from_secs(6)))
        .timeout_recv_response(Some(Duration::from_secs(12)))
        .timeout_recv_body(Some(Duration::from_secs(12)))
        .build()
        .into()
}

fn tag_block(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let start = lower.find(&open)?;
    let after_open = start + lower[start..].find('>')? + 1;
    let end = after_open + lower[after_open..].find(&close)?;
    Some(html[after_open..end].to_string())
}

fn semantic_div_block(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(found) = lower[offset..].find("<div") {
        let start = offset + found;
        let open_end = start + lower[start..].find('>')? + 1;
        let opening = &lower[start..open_end];
        if [
            "article",
            "post-content",
            "article-content",
            "entry-content",
            "news-content",
            "detail-content",
        ]
        .iter()
        .any(|marker| opening.contains(marker))
        {
            if let Some(close) = lower[open_end..].find("</div") {
                return Some(html[open_end..open_end + close].to_string());
            }
        }
        offset = open_end;
    }
    None
}

fn strip_tag_blocks(mut html: String) -> String {
    for tag in [
        "script", "style", "noscript", "header", "nav", "footer", "aside", "form", "dialog",
    ] {
        loop {
            let lower = html.to_ascii_lowercase();
            let open = format!("<{tag}");
            let close = format!("</{tag}");
            let Some(start) = lower.find(&open) else {
                break;
            };
            let Some(after_open) = lower[start..].find('>').map(|end| start + end + 1) else {
                break;
            };
            let Some(end) = lower[after_open..].find(&close).map(|end| after_open + end) else {
                break;
            };
            let Some(close_end) = lower[end..].find('>').map(|offset| end + offset + 1) else {
                break;
            };
            html.replace_range(start..close_end, "");
        }
    }
    html
}

fn article_candidate(html: &str) -> String {
    tag_block(html, "article")
        .or_else(|| tag_block(html, "main"))
        .or_else(|| semantic_div_block(html))
        .or_else(|| tag_block(html, "body"))
        .unwrap_or_else(|| html.to_string())
}

fn article_absolute_url(page_url: &str, value: &str) -> String {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('#')
        || value.starts_with("data:")
        || value.starts_with("mailto:")
        || value.starts_with("tel:")
        || value.contains(':')
    {
        return value.to_string();
    }
    let Some(rest) = page_url.strip_prefix("https://") else {
        return value.to_string();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("https://{}", &rest[..authority_end]);
    if let Some(path) = value.strip_prefix("//") {
        return format!("https://{path}");
    }
    if value.starts_with('/') {
        return format!("{origin}{value}");
    }
    let page_path = rest[authority_end..]
        .split(['?', '#'])
        .next()
        .unwrap_or("/");
    let directory = page_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    format!("{origin}{directory}/{value}")
}

fn rewrite_url_attribute(html: &str, attribute: &str, page_url: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let needle = format!("{attribute}=");
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(&needle) {
        let start = cursor + found;
        let value_start = start + needle.len();
        let bytes = html.as_bytes();
        if value_start >= bytes.len() {
            break;
        }
        let quote = bytes[value_start];
        let (content_start, content_end, attribute_end) = if quote == b'\'' || quote == b'"' {
            let content_start = value_start + 1;
            let Some(relative_end) = html[content_start..].find(quote as char) else {
                break;
            };
            let content_end = content_start + relative_end;
            (content_start, content_end, content_end + 1)
        } else {
            let relative_end = html[value_start..]
                .find(|ch: char| ch.is_whitespace() || ch == '>')
                .unwrap_or(html.len() - value_start);
            (
                value_start,
                value_start + relative_end,
                value_start + relative_end,
            )
        };
        out.push_str(&html[cursor..content_start]);
        out.push_str(&article_absolute_url(
            page_url,
            &html[content_start..content_end],
        ));
        out.push_str(&html[content_end..attribute_end]);
        cursor = attribute_end;
    }
    out.push_str(&html[cursor..]);
    out
}

fn extract_article_html(html: &str, page_url: &str) -> String {
    let candidate = strip_tag_blocks(article_candidate(html));
    let candidate = rewrite_url_attribute(&candidate, "src", page_url);
    let candidate = rewrite_url_attribute(&candidate, "href", page_url);
    html_sanitize::sanitize_web_article_html(&candidate)
}

fn fetch_article(request: NewsNowArticleRequest) -> Result<NewsNowArticle, String> {
    let url = url_open::validate_https_url(request.url.trim())?.to_string();
    if url.len() > 2_000 {
        return Err("资讯原文地址过长".to_string());
    }
    let mut response = http_agent()
        .get(&url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|_| "无法请求资讯原文".to_string())?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.contains("html") {
        return Err("该链接不是可阅读的网页".to_string());
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(ARTICLE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取资讯原文".to_string())?;
    if bytes.len() as u64 > ARTICLE_MAX_BYTES {
        return Err("资讯原文过大，已停止加载".to_string());
    }
    let raw = String::from_utf8_lossy(&bytes);
    let content_html = extract_article_html(&raw, &url);
    if html_sanitize::html_to_plain_text(&content_html)
        .chars()
        .count()
        < 40
    {
        return Err("未能从该网页提取足够正文，可打开原网页阅读".to_string());
    }
    Ok(NewsNowArticle {
        url,
        title: trim_chars(request.title.trim(), MAX_TEXT_CHARS),
        source: trim_chars(request.source.trim(), 120),
        published_at: trim_chars(request.published_at.trim(), 120),
        content_html,
    })
}

fn selected_sources(request: Option<NewsNowRequest>) -> Vec<NewsSource> {
    let requested = request.unwrap_or_default().source_ids;
    if requested.is_empty() {
        return CURATED_SOURCES
            .iter()
            .copied()
            .filter(|source| source.default_enabled)
            .collect();
    }

    let mut seen = HashSet::new();
    let selected = requested
        .iter()
        .filter_map(|id| {
            let id = id.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            CURATED_SOURCES
                .iter()
                .copied()
                .find(|source| source.id == id)
        })
        .take(MAX_SELECTED_SOURCES)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        CURATED_SOURCES
            .iter()
            .copied()
            .filter(|source| source.default_enabled)
            .collect()
    } else {
        selected
    }
}

fn selected_ids(sources: &[NewsSource]) -> Vec<String> {
    sources.iter().map(|source| source.id.to_string()).collect()
}

fn value_to_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn https_text(value: Option<&Value>) -> String {
    let value = value_to_text(value);
    url_open::validate_https_url(&value)
        .map(str::to_string)
        .unwrap_or_default()
}

fn image_url(item: &Value) -> String {
    let icon = item.pointer("/extra/icon");
    match icon {
        Some(Value::String(_)) => https_text(icon),
        Some(Value::Object(icon)) => https_text(icon.get("url")),
        _ => String::new(),
    }
}

fn parse_source_response(source: NewsSource, response: Value) -> Vec<NewsNowItem> {
    let items = response.get("items").and_then(Value::as_array);
    let Some(items) = items else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS_PER_SOURCE)
        .filter_map(|item| {
            let title = trim_chars(&value_to_text(item.get("title")), MAX_TEXT_CHARS);
            let url =
                https_text(item.get("mobileUrl")).or_else_if_empty(|| https_text(item.get("url")));
            if title.is_empty() || url.is_empty() {
                return None;
            }
            let id = value_to_text(item.get("id"));
            let published_at = value_to_text(item.get("pubDate"));
            let summary = trim_chars(&value_to_text(item.pointer("/extra/hover")), MAX_TEXT_CHARS);
            Some(NewsNowItem {
                id: if id.is_empty() {
                    format!("{}:{url}", source.id)
                } else {
                    format!("{}:{id}", source.id)
                },
                title,
                url,
                source: source.name.to_string(),
                source_id: source.id.to_string(),
                source_color: source.color.to_string(),
                summary,
                published_at,
                image_url: image_url(item),
                category: source.category.to_string(),
            })
        })
        .collect()
}

trait EmptyStringFallback {
    fn or_else_if_empty(self, fallback: impl FnOnce() -> String) -> String;
}

impl EmptyStringFallback for String {
    fn or_else_if_empty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn fetch_source(
    agent: &ureq::Agent,
    base: &str,
    source: NewsSource,
    latest: bool,
) -> Result<Vec<NewsNowItem>, String> {
    let suffix = if latest { "&latest=true" } else { "" };
    let endpoint = format!("{base}/api/s?id={}{}", source.id, suffix);
    let mut response = agent
        .get(&endpoint)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "application/json,text/plain,*/*")
        .call()
        .map_err(|_| source.name.to_string())?;
    let response = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|_| source.name.to_string())?;
    Ok(parse_source_response(source, response))
}

fn sort_and_deduplicate(items: &mut Vec<NewsNowItem>) {
    let mut urls = HashSet::new();
    items.retain(|item| urls.insert(item.url.clone()));
    items.sort_by(|left, right| {
        right
            .published_at
            .cmp(&left.published_at)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.title.cmp(&right.title))
    });
    items.truncate(MAX_TOTAL_ITEMS);
}

fn fetch_news(request: Option<NewsNowRequest>, force_refresh: bool) -> NewsNowList {
    let sources = selected_sources(request);
    let source_ids = selected_ids(&sources);
    if !force_refresh {
        if let Ok(cache) = cache().lock() {
            if cache.source_ids == source_ids
                && cache
                    .fetched_instant
                    .is_some_and(|fetched| fetched.elapsed() < CACHE_TTL)
            {
                return NewsNowList {
                    items: cache.items.clone(),
                    fetched_at: cache.fetched_at,
                    source_count: sources.len(),
                    ..Default::default()
                };
            }
        }
    }

    let base = match base_url() {
        Ok(base) => base,
        Err(error) => {
            return NewsNowList {
                message: error,
                source_count: sources.len(),
                ..Default::default()
            }
        }
    };
    let mut threads = Vec::new();
    for source in &sources {
        let base = base.clone();
        let source = *source;
        threads.push(std::thread::spawn(move || {
            fetch_source(&http_agent(), &base, source, force_refresh)
        }));
    }

    let mut items = Vec::new();
    let mut failed_sources = Vec::new();
    for thread in threads {
        match thread.join() {
            Ok(Ok(mut source_items)) => items.append(&mut source_items),
            Ok(Err(source)) => failed_sources.push(source),
            Err(_) => failed_sources.push("一个资讯来源".to_string()),
        }
    }
    sort_and_deduplicate(&mut items);

    if items.is_empty() {
        if let Ok(cache) = cache().lock() {
            if cache.source_ids == source_ids && !cache.items.is_empty() {
                return NewsNowList {
                    items: cache.items.clone(),
                    fetched_at: cache.fetched_at,
                    source_count: sources.len(),
                    failed_sources,
                    stale: true,
                    message: "暂时无法刷新，正在显示上次成功获取的资讯。".to_string(),
                };
            }
        }
    }

    let fetched_at = now_millis();
    let message = if items.is_empty() {
        "暂时没有可显示的资讯，请稍后重试或调整来源。".to_string()
    } else if failed_sources.is_empty() {
        String::new()
    } else {
        format!("已更新，{} 个来源暂时不可用。", failed_sources.len())
    };
    if !items.is_empty() {
        if let Ok(mut cache) = cache().lock() {
            cache.source_ids = source_ids;
            cache.fetched_at = fetched_at;
            cache.fetched_instant = Some(Instant::now());
            cache.items = items.clone();
        }
    }
    NewsNowList {
        items,
        fetched_at,
        message,
        source_count: sources.len(),
        failed_sources,
        stale: false,
    }
}

#[tauri::command]
pub(crate) fn newsnow_status() -> NewsNowStatus {
    match base_url() {
        Ok(base_url) => NewsNowStatus {
            configured: true,
            base_url,
            message: "资讯内容来自公开 NewsNow 源；不会发送同步账号、图书或阅读数据。".to_string(),
        },
        Err(error) => NewsNowStatus {
            configured: false,
            base_url: String::new(),
            message: error,
        },
    }
}

#[tauri::command]
pub(crate) fn newsnow_sources() -> Vec<NewsNowSource> {
    CURATED_SOURCES
        .iter()
        .copied()
        .map(NewsNowSource::from)
        .collect()
}

#[tauri::command]
pub(crate) async fn newsnow_list(request: Option<NewsNowRequest>) -> NewsNowList {
    tokio::task::spawn_blocking(move || fetch_news(request, false))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯任务失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_refresh(request: Option<NewsNowRequest>) -> NewsNowList {
    tokio::task::spawn_blocking(move || fetch_news(request, true))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯刷新失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_read_article(
    request: NewsNowArticleRequest,
) -> Result<NewsNowArticle, String> {
    tokio::task::spawn_blocking(move || fetch_article(request))
        .await
        .map_err(|error| format!("资讯正文任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn newsnow_base_requires_safe_https() {
        assert_eq!(
            validate_base_url(" https://news.example/path/ ").unwrap(),
            "https://news.example/path"
        );
        assert!(validate_base_url(concat!("http", "://news.example")).is_err());
        assert!(validate_base_url("https://user@news.example").is_err());
        assert!(validate_base_url("https://news.example/\nnext").is_err());
    }

    #[test]
    fn selected_sources_ignore_unknown_duplicate_and_excess_ids() {
        let ids = CURATED_SOURCES
            .iter()
            .map(|source| source.id.to_string())
            .chain(std::iter::once("unknown".to_string()))
            .chain(std::iter::once("weibo".to_string()))
            .collect();
        let selected = selected_sources(Some(NewsNowRequest { source_ids: ids }));
        assert_eq!(selected.len(), MAX_SELECTED_SOURCES);
        assert_eq!(selected[0].id, "weibo");
        assert!(!selected.iter().any(|source| source.id == "unknown"));
    }

    #[test]
    fn source_catalog_has_a_broad_but_bounded_selection() {
        assert!(CURATED_SOURCES.len() >= 30);
        assert!(CURATED_SOURCES.len() <= 48);
        assert!(CURATED_SOURCES
            .iter()
            .all(|source| !source.id.is_empty() && !source.name.is_empty()));
    }

    #[test]
    fn parser_only_exposes_https_news_items_and_source_metadata() {
        let insecure_url = concat!("http", "://example.com/b");
        let response = json!({
            "items": [
                {"id": 7, "title": "  一条新闻  ", "url": "https://example.com/a", "pubDate": 42,
                  "extra": {"hover": "摘要", "icon": {"url": "https://example.com/icon.png"}}},
                {"id": 8, "title": "不安全", "url": insecure_url},
                {"id": 9, "title": "移动端优先", "url": "https://example.com/c", "mobileUrl": "https://m.example.com/c"}
            ]
        });
        let items = parse_source_response(CURATED_SOURCES[0], response);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "weibo:7");
        assert_eq!(items[0].source_id, "weibo");
        assert_eq!(items[0].summary, "摘要");
        assert_eq!(items[1].url, "https://m.example.com/c");
    }

    #[test]
    fn article_extraction_keeps_body_and_drops_publisher_chrome() {
        let raw = r#"<html><body><nav>站点顶栏</nav><article class="publisher-theme"><header>文章头</header><p>这是足够长的正文内容，用于确认资讯页面只保留正文而不带网站导航。</p><img src="https://img.example/a.jpg"><script>bad()</script></article><footer>页脚</footer></body></html>"#;
        let extracted = extract_article_html(raw, "https://news.example/path/story.html");
        assert!(extracted.contains("足够长的正文内容"));
        assert!(extracted.contains("https://img.example/a.jpg"));
        assert!(!extracted.contains("站点顶栏"));
        assert!(!extracted.contains("文章头"));
        assert!(!extracted.contains("publisher-theme"));
        assert!(!extracted.contains("script"));
    }

    #[test]
    fn article_extraction_resolves_relative_images_and_links() {
        let raw = r#"<article><p>这是足够长的正文内容，用于确认相对资源会在阅读器中保持可访问。</p><img src="images/a.jpg"><a href="/next">后续报道</a></article>"#;
        let extracted = extract_article_html(raw, "https://news.example/path/story.html");
        assert!(extracted.contains(r#"src="https://news.example/path/images/a.jpg""#));
        assert!(extracted.contains(r#"href="https://news.example/next""#));
    }

    #[test]
    fn sort_and_deduplicate_prefers_newer_distinct_articles() {
        let mut items = vec![
            NewsNowItem {
                title: "old".to_string(),
                url: "https://a.example".to_string(),
                published_at: "2026-08-04 12:00".to_string(),
                ..Default::default()
            },
            NewsNowItem {
                title: "new".to_string(),
                url: "https://b.example".to_string(),
                published_at: "2026-08-05 12:00".to_string(),
                ..Default::default()
            },
            NewsNowItem {
                title: "duplicate".to_string(),
                url: "https://a.example".to_string(),
                published_at: "2026-08-06 12:00".to_string(),
                ..Default::default()
            },
        ];
        sort_and_deduplicate(&mut items);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "new");
    }
}
