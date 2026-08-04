//! Read-only NewsNow adapter.
//!
//! News is deliberately kept outside the reader's database and sync entity
//! model.  The application asks a NewsNow-compatible HTTPS endpoint for a
//! small, curated set of public source feeds and only keeps the result in
//! process memory.  A user who deploys NewsNow themselves can override the
//! endpoint at build time with `KUNPENG_NEWSNOW_BASE_URL`.

use crate::url_open;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_BASE_URL: &str = "https://newsnow.busiyi.world";
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ITEMS_PER_SOURCE: usize = 12;
const MAX_TOTAL_ITEMS: usize = 60;
const MAX_TEXT_CHARS: usize = 500;
const NEWS_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const NEWSNOW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36";

/// These source IDs are maintained by NewsNow.  Keeping the list local avoids
/// accepting an arbitrary endpoint or source ID from the webview.
const CURATED_SOURCES: &[NewsSource] = &[
    NewsSource {
        id: "zhihu",
        name: "知乎",
        category: "热点",
    },
    NewsSource {
        id: "weibo",
        name: "微博",
        category: "热点",
    },
    NewsSource {
        id: "ithome",
        name: "IT之家",
        category: "科技",
    },
    NewsSource {
        id: "36kr",
        name: "36氪",
        category: "科技",
    },
    NewsSource {
        id: "hackernews",
        name: "Hacker News",
        category: "科技",
    },
];

#[derive(Clone, Copy)]
struct NewsSource {
    id: &'static str,
    name: &'static str,
    category: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source: String,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowStatus {
    pub configured: bool,
    pub base_url: String,
    pub message: String,
}

#[derive(Default)]
struct NewsCache {
    fetched_at: i64,
    fetched_instant: Option<Instant>,
    items: Vec<NewsNowItem>,
    message: String,
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
    // The endpoint is public content only. It is intentionally unrelated to
    // the reading-sync URL and never inherits account cookies or credentials.
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
                    format!("{}:{}", source.id, url)
                } else {
                    format!("{}:{id}", source.id)
                },
                title,
                url,
                source: source.name.to_string(),
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
        // The public NewsNow demo is protected by Cloudflare and rejects
        // non-browser user agents even though this is a read-only JSON route.
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "application/json,text/plain,*/*")
        .call()
        .map_err(|error| format!("{}：{error}", source.name))?;
    let response = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| format!("{}：返回内容无效：{error}", source.name))?;
    Ok(parse_source_response(source, response))
}

fn fetch_news(force_refresh: bool) -> NewsNowList {
    if !force_refresh {
        if let Ok(cache) = cache().lock() {
            if cache
                .fetched_instant
                .is_some_and(|fetched| fetched.elapsed() < CACHE_TTL)
            {
                return NewsNowList {
                    items: cache.items.clone(),
                    fetched_at: cache.fetched_at,
                    message: cache.message.clone(),
                };
            }
        }
    }

    let base = match base_url() {
        Ok(base) => base,
        Err(error) => {
            return NewsNowList {
                message: error,
                ..Default::default()
            }
        }
    };
    let mut threads = Vec::new();
    for source in CURATED_SOURCES {
        let base = base.clone();
        let source = *source;
        threads.push(std::thread::spawn(move || {
            fetch_source(&http_agent(), &base, source, force_refresh)
        }));
    }

    let mut items = Vec::new();
    let mut errors = Vec::new();
    for thread in threads {
        match thread.join() {
            Ok(Ok(mut source_items)) => items.append(&mut source_items),
            Ok(Err(error)) => errors.push(error),
            Err(_) => errors.push("资讯请求线程异常结束".to_string()),
        }
    }
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.url.clone()));
    items.truncate(MAX_TOTAL_ITEMS);
    let message = if items.is_empty() {
        if errors.is_empty() {
            "暂无可显示的资讯".to_string()
        } else {
            format!("资讯服务暂不可用：{}", errors.join("；"))
        }
    } else if errors.is_empty() {
        String::new()
    } else {
        format!("部分来源暂不可用（{}）", errors.join("；"))
    };
    let fetched_at = now_millis();
    if let Ok(mut cache) = cache().lock() {
        cache.fetched_at = fetched_at;
        cache.fetched_instant = Some(Instant::now());
        cache.items = items.clone();
        cache.message = message.clone();
    }
    NewsNowList {
        items,
        fetched_at,
        message,
    }
}

#[tauri::command]
pub(crate) fn newsnow_status() -> NewsNowStatus {
    match base_url() {
        Ok(base_url) => NewsNowStatus {
            configured: true,
            base_url,
            message: "资讯内容来自 NewsNow；阅读器不会发送同步账号、图书或阅读数据。".to_string(),
        },
        Err(error) => NewsNowStatus {
            configured: false,
            base_url: String::new(),
            message: error,
        },
    }
}

#[tauri::command]
pub(crate) async fn newsnow_list() -> NewsNowList {
    tokio::task::spawn_blocking(|| fetch_news(false))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯任务失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_refresh() -> NewsNowList {
    tokio::task::spawn_blocking(|| fetch_news(true))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯刷新失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) fn newsnow_open(url: String) -> Result<(), String> {
    // NewsNow item URLs are external untrusted content.  Open them in the OS
    // browser after requiring HTTPS, never inside the privileged app WebView.
    url_open::open_https_url(&url)
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
    fn parser_only_exposes_https_news_items() {
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
        assert_eq!(items[0].id, "zhihu:7");
        assert_eq!(items[0].summary, "摘要");
        assert_eq!(items[0].image_url, "https://example.com/icon.png");
        assert_eq!(items[1].url, "https://m.example.com/c");
    }

    #[test]
    fn parser_bounds_untrusted_text() {
        let response = json!({
            "items": [{"id": "a", "title": "x".repeat(900), "url": "https://example.com/a"}]
        });
        let items = parse_source_response(CURATED_SOURCES[0], response);
        assert_eq!(items[0].title.chars().count(), MAX_TEXT_CHARS + 1);
        assert!(items[0].title.ends_with('…'));
    }
}
