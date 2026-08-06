//! A privacy-preserving, reader-oriented adapter for the public NewsNow API.
//!
//! News content is deliberately transient: it never enters the reader database,
//! search index, backup, or sync payload.  The WebView can only request IDs from
//! the local source catalogue, while the Rust side fetches and validates HTTPS
//! article URLs before handing them back to the UI.

use crate::url_open;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    fs,
    io::Read,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};

const DEFAULT_BASE_URL: &str = "https://newsnow.busiyi.world";
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_SELECTED_SOURCES: usize = 24;
const MAX_TIEBA_BARS: usize = 8;
const MAX_TIEBA_BAR_CHARS: usize = 48;
const MAX_REFRESH_CONCURRENCY: usize = 6;
// 覆盖首屏和紧邻的滚动内容；手动刷新也会等待这批图片完成，因此不能把
// 整个资讯流都串进一次请求，否则列表会长期停在“刷新中”。
const MAX_PREFETCH_PREVIEW_IMAGES: usize = 36;
const PREFETCH_IMAGE_CONCURRENCY: usize = 6;
const PREFETCH_IMAGE_MAX_BYTES: u64 = 900 * 1024;
const PREFETCH_IMAGE_MAX_DIMENSION: u32 = 640;
// 贴吧首页常带有多年以前的置顶/热门帖。优先把它作为近期动态来源；没有
// 新帖时仅留少量兜底，避免历史帖反复占据信息流。
const TIEBA_RECENT_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
const TIEBA_OLD_FALLBACK_PER_BAR: usize = 2;
const NEWS_CACHE_VERSION: u8 = 9;
const MAX_TEXT_CHARS: usize = 500;
const NEWS_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const PREVIEW_IMAGE_MAX_BYTES: u64 = 1_500_000;
const ARTICLE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const SOURCE_IMAGE_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const NEWSNOW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36";
const ARTICLE_WEBVIEW_LABEL: &str = "newsnow-article";
const ARTICLE_RETURN_URL: &str = "https://reader.localhost/__kunpeng_news_return__";
type NewsSourceParser = fn(NewsSource, &str) -> Vec<NewsNowItem>;
const ARTICLE_RETURN_SCRIPT: &str = r##"
(() => {
  if (window.top !== window) return;
  const returnUrl = "https://reader.localhost/__kunpeng_news_return__";
  const install = () => {
    if (document.getElementById("kunpeng-news-return")) return;
    const button = document.createElement("button");
    button.id = "kunpeng-news-return";
    button.type = "button";
    button.title = "返回资讯页";
    button.setAttribute("aria-label", "返回资讯页");
    button.textContent = "←";
    button.style.cssText = "position:fixed;z-index:2147483647;top:50%;right:18px;width:44px;height:44px;transform:translateY(-50%);border:1px solid #9ab9e6;border-radius:50%;color:#1e64c4;background:rgba(255,255,255,.96);box-shadow:0 4px 16px rgba(44,92,158,.24);font:25px/1 system-ui;cursor:pointer;";
    button.addEventListener("mouseenter", () => { button.style.background = "#f2f7ff"; });
    button.addEventListener("mouseleave", () => { button.style.background = "rgba(255,255,255,.96)"; });
    button.addEventListener("click", () => { window.location.assign(returnUrl); });
    document.body.appendChild(button);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    window.location.assign(returnUrl);
  }, true);
})();
"##;

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
        id: "3dm-news",
        name: "3DM 游戏新闻",
        category: "游戏",
        color: "#d86632",
        default_enabled: false,
    },
    NewsSource {
        id: "gamersky-news",
        name: "游民星空新闻",
        category: "游戏",
        color: "#3979ba",
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
        name: "百度贴吧",
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
    #[serde(default)]
    pub tieba_bars: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    #[serde(default)]
    pub preview_data_url: String,
    #[serde(default)]
    pub preview_attempted: bool,
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
pub(crate) struct NewsNowPreviewRequest {
    pub url: String,
    #[serde(default)]
    pub image_url: String,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowOpenRequest {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowArticle {
    pub local: bool,
    pub title: String,
    pub source: String,
    pub published_at: String,
    pub content_html: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowPreview {
    pub image_url: String,
    pub image_data_url: String,
}

#[derive(Default)]
struct NewsCache {
    source_ids: Vec<String>,
    fetched_at: i64,
    fetched_instant: Option<Instant>,
    items: Vec<NewsNowItem>,
    disk_loaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DiskNewsCache {
    version: u8,
    source_ids: Vec<String>,
    fetched_at: i64,
    items: Vec<NewsNowItem>,
}

#[derive(Default)]
struct SourceImageCache {
    fetched_instant: Option<Instant>,
    images: HashMap<String, String>,
}

fn cache() -> &'static Mutex<NewsCache> {
    static CACHE: OnceLock<Mutex<NewsCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(NewsCache::default()))
}

fn disk_cache_path() -> Option<PathBuf> {
    let mut directory = dirs::cache_dir()?;
    directory.push("ebook-reader");
    Some(directory.join("newsnow-feed-v1.json"))
}

fn load_disk_cache() -> Option<DiskNewsCache> {
    let path = disk_cache_path()?;
    let bytes = fs::read(path).ok()?;
    let saved = serde_json::from_slice::<DiskNewsCache>(&bytes).ok()?;
    if saved.version != NEWS_CACHE_VERSION
        || saved.source_ids.is_empty()
        || saved.source_ids.len() > MAX_SELECTED_SOURCES
        || saved.items.is_empty()
    {
        return None;
    }
    Some(saved)
}

fn ensure_disk_cache_loaded() {
    let Ok(mut cached) = cache().lock() else {
        return;
    };
    if cached.disk_loaded {
        return;
    }
    cached.disk_loaded = true;
    let Some(saved) = load_disk_cache() else {
        return;
    };
    cached.source_ids = saved.source_ids;
    cached.fetched_at = saved.fetched_at;
    cached.items = saved.items;
}

fn save_disk_cache(source_ids: &[String], fetched_at: i64, items: &[NewsNowItem]) {
    let Some(path) = disk_cache_path() else {
        return;
    };
    let saved = DiskNewsCache {
        version: NEWS_CACHE_VERSION,
        source_ids: source_ids.to_vec(),
        fetched_at,
        items: items.to_vec(),
    };
    let _ = crate::atomic_file::write_json(&path, &saved, false);
}

fn reuse_cached_preview_state(
    source_ids: &[String],
    items: &mut [NewsNowItem],
    preserve_failed_attempts: bool,
) {
    let previous = cache()
        .lock()
        .ok()
        .filter(|cached| cached.source_ids == source_ids)
        .map(|cached| {
            cached
                .items
                .iter()
                .map(|item| {
                    (
                        item.url.clone(),
                        (item.preview_data_url.clone(), item.preview_attempted),
                    )
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    for item in items {
        let Some((preview_data_url, preview_attempted)) = previous.get(&item.url) else {
            continue;
        };
        if !preview_data_url.is_empty() {
            item.preview_data_url.clone_from(preview_data_url);
            item.preview_attempted = true;
        } else if preserve_failed_attempts {
            item.preview_attempted = *preview_attempted;
        }
    }
}

fn source_image_cache(source_id: &'static str) -> &'static Mutex<SourceImageCache> {
    static ZHIHU: OnceLock<Mutex<SourceImageCache>> = OnceLock::new();
    static TOUTIAO: OnceLock<Mutex<SourceImageCache>> = OnceLock::new();
    match source_id {
        "zhihu" => ZHIHU.get_or_init(|| Mutex::new(SourceImageCache::default())),
        "toutiao" => TOUTIAO.get_or_init(|| Mutex::new(SourceImageCache::default())),
        _ => unreachable!("only cached image sources may request an image cache"),
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
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

fn html_attribute(tag: &str, attribute: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(attribute) {
        let start = cursor + found;
        let before = lower.as_bytes().get(start.wrapping_sub(1)).copied();
        let after = lower.as_bytes().get(start + attribute.len()).copied();
        if before.is_none_or(|ch| ch.is_ascii_whitespace() || ch == b'<')
            && after.is_some_and(|ch| ch.is_ascii_whitespace() || ch == b'=')
        {
            let mut value_start = start + attribute.len();
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            if lower.as_bytes().get(value_start) != Some(&b'=') {
                cursor = value_start;
                continue;
            }
            value_start += 1;
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            let quote = *tag.as_bytes().get(value_start)?;
            if quote != b'\'' && quote != b'"' {
                return None;
            }
            let value_start = value_start + 1;
            let end = tag[value_start..].find(quote as char)? + value_start;
            return Some(tag[value_start..end].trim().to_string());
        }
        cursor = start + attribute.len();
    }
    None
}

fn absolute_image_url(page_url: &str, value: &str) -> String {
    let decoded = value
        .trim()
        .replace("&amp;", "&")
        .replace("&#x26;", "&")
        .replace("&#X26;", "&")
        .replace("&#38;", "&");
    let value = decoded.trim();
    if let Ok(url) = url_open::validate_https_url(value) {
        return url.to_string();
    }
    let Some(rest) = page_url.strip_prefix("https://") else {
        return String::new();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("https://{}", &rest[..authority_end]);
    let candidate = if let Some(value) = value.strip_prefix("//") {
        format!("https://{value}")
    } else if value.starts_with('/') {
        format!("{origin}{value}")
    } else {
        return String::new();
    };
    url_open::validate_https_url(&candidate)
        .map(str::to_string)
        .unwrap_or_default()
}

fn is_site_chrome_image(tag: &str, value: &str) -> bool {
    let tag = tag.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    ["logo", "favicon", "avatar", "qrcode", "qr-code"]
        .iter()
        .any(|marker| tag.contains(marker) || value.contains(marker))
}

fn image_from_tag_with_class(html: &str, page_url: &str, class: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let class = class.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<img") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        if html_attribute(tag, "class")
            .is_some_and(|value| value.to_ascii_lowercase().contains(&class))
        {
            for attribute in ["data-src", "data-original", "data-lazy-src", "src"] {
                if let Some(value) = html_attribute(tag, attribute) {
                    let image = absolute_image_url(page_url, &value);
                    if !image.is_empty() {
                        return image;
                    }
                }
            }
        }
        cursor = end;
    }
    String::new()
}

fn json_script_by_id(html: &str, id: &str) -> Option<Value> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<script") {
        let start = cursor + found;
        let tag_end = html[start..].find('>').map(|offset| start + offset + 1)?;
        let tag = &html[start..tag_end];
        if html_attribute(tag, "id").is_some_and(|value| value.eq_ignore_ascii_case(id)) {
            let content_end = lower[tag_end..]
                .find("</script>")
                .map(|offset| tag_end + offset)?;
            return serde_json::from_str(&html[tag_end..content_end]).ok();
        }
        cursor = tag_end;
    }
    None
}

fn thepaper_preview_image_from_html(html: &str, page_url: &str) -> String {
    let from_data = json_script_by_id(html, "__NEXT_DATA__")
        .and_then(|data| {
            [
                "/props/pageProps/detailData/contentDetail/sharePic",
                "/props/pageProps/detailData/contentDetail/pic",
                "/props/pageProps/detailData/contentDetail/voiceInfo/imgSrc",
            ]
            .into_iter()
            .map(|pointer| https_text(data.pointer(pointer)))
            .find(|image| !image.is_empty())
        })
        .unwrap_or_default();
    if !from_data.is_empty() {
        return from_data;
    }
    image_from_tag_with_class(html, page_url, "img_default")
}

fn javascript_string_property(html: &str, property: &str) -> Option<String> {
    let marker = format!("{property}:\"");
    let value = html.split_once(&marker)?.1;
    let mut chars = value.chars();
    let mut output = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(output),
            '\\' => match chars.next()? {
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                '/' => output.push('/'),
                'b' => output.push('\u{0008}'),
                'f' => output.push('\u{000c}'),
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                'u' => {
                    let digits = chars.by_ref().take(4).collect::<String>();
                    if digits.len() != 4 {
                        return None;
                    }
                    if let Some(decoded) = u32::from_str_radix(&digits, 16)
                        .ok()
                        .and_then(char::from_u32)
                    {
                        output.push(decoded);
                    }
                }
                escaped => output.push(escaped),
            },
            _ => output.push(ch),
        }
    }
    None
}

fn first_non_chrome_image(html: &str, page_url: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<img") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        for attribute in ["data-src", "data-original", "data-lazy-src", "src"] {
            if let Some(value) = html_attribute(tag, attribute) {
                if is_site_chrome_image(tag, &value) {
                    continue;
                }
                let image = absolute_image_url(page_url, &value);
                if !image.is_empty() {
                    return image;
                }
            }
        }
        cursor = end;
    }
    String::new()
}

fn juejin_preview_image_from_html(html: &str, page_url: &str) -> String {
    javascript_string_property(html, "web_html_content")
        .map(|content| first_non_chrome_image(&content, page_url))
        .unwrap_or_default()
}

fn is_juejin_article_url(url: &str) -> bool {
    tauri::Url::parse(url).ok().is_some_and(|url| {
        matches!(url.host_str(), Some("juejin.cn" | "www.juejin.cn"))
            && url.path().starts_with("/post/")
    })
}

fn preview_image_from_html(html: &str, page_url: &str) -> String {
    // 这些站点的通用首图经常是导航 Logo。仅使用它们已确认的正文结构；
    // 找不到真实正文图就明确无图，不再猜测。
    if page_url.contains("thepaper.cn/") {
        return thepaper_preview_image_from_html(html, page_url);
    }
    if page_url.contains("coolapk.com/") {
        return image_from_tag_with_class(html, page_url, "message-image");
    }
    if is_juejin_article_url(page_url) {
        return juejin_preview_image_from_html(html, page_url);
    }
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("<meta") {
        let start = cursor + found;
        let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let tag = &html[start..end];
        let kind = html_attribute(tag, "property")
            .or_else(|| html_attribute(tag, "name"))
            .or_else(|| html_attribute(tag, "itemprop"));
        if kind.is_some_and(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "og:image" | "twitter:image" | "twitter:image:src" | "image"
            )
        }) {
            if let Some(content) = html_attribute(tag, "content") {
                let image = absolute_image_url(page_url, &content);
                if !image.is_empty() {
                    return image;
                }
            }
        }
        cursor = end;
    }
    first_non_chrome_image(html, page_url)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

// 少数派的 OG 图经常是原始 PNG，单张可超过数 MB。资讯流只需要卡片缩略图，
// rssfile 支持在同一资源上请求受控尺寸的 WebP；这样既保留真实封面，也不会
// 为了个别原图而放宽全局内存上限。
fn compact_preview_image_url(image_url: &str) -> String {
    let Some(path) = image_url.strip_prefix("https://rssfile.sspai.com/") else {
        return image_url.to_string();
    };
    let Some((path, _)) = path.split_once('?') else {
        return image_url.to_string();
    };
    format!("https://rssfile.sspai.com/{path}?imageView2/2/w/800/h/450/format/webp/q/85")
}

fn source_item_id(source_id: &str, item_id: &str) -> String {
    item_id
        .strip_prefix(&format!("{source_id}:"))
        .unwrap_or(item_id)
        .trim()
        .to_string()
}

fn safe_remote_item_id(source_id: &str, item_id: &str) -> String {
    let id = source_item_id(source_id, item_id);
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        String::new()
    } else {
        id
    }
}

fn fetch_douban_cover(agent: &ureq::Agent, item_id: &str) -> String {
    let item_id = safe_remote_item_id("douban", item_id);
    if item_id.is_empty() {
        return String::new();
    }
    let endpoint = format!("https://m.douban.com/rexxar/api/v2/subject/{item_id}");
    let Ok(mut response) = agent
        .get(&endpoint)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Referer", "https://m.douban.com/")
        .header("Accept", "application/json,text/plain,*/*")
        .call()
    else {
        return String::new();
    };
    let Ok(data) = response.body_mut().read_json::<Value>() else {
        return String::new();
    };
    for pointer in ["/pic/normal", "/pic/large", "/cover_url"] {
        let image = https_text(data.pointer(pointer));
        if !image.is_empty() {
            return image;
        }
    }
    String::new()
}

fn markdown_first_image(markdown: &str) -> String {
    let mut cursor = 0;
    while let Some(found) = markdown[cursor..].find("![") {
        let start = cursor + found;
        let Some(url_start) = markdown[start..]
            .find("](")
            .map(|offset| start + offset + 2)
        else {
            break;
        };
        let Some(url_end) = markdown[url_start..]
            .find(')')
            .map(|offset| url_start + offset)
        else {
            break;
        };
        let candidate = markdown[url_start..url_end]
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default();
        let image = absolute_image_url("https://juejin.cn/", candidate);
        if !image.is_empty() {
            return image;
        }
        cursor = url_end + 1;
    }
    String::new()
}

fn juejin_article_image_from_json(data: &Value) -> String {
    let article = data.pointer("/data/article_info");
    let cover = https_text(article.and_then(|article| article.get("cover_image")));
    if !cover.is_empty() {
        return cover;
    }
    let markdown = value_to_text(article.and_then(|article| article.get("mark_content")));
    let image = markdown_first_image(&markdown);
    if !image.is_empty() {
        return image;
    }
    let html = value_to_text(article.and_then(|article| article.get("web_html_content")));
    first_non_chrome_image(&html, "https://juejin.cn/")
}

fn fetch_juejin_article_image(agent: &ureq::Agent, item_id: &str) -> String {
    let item_id = safe_remote_item_id("juejin", item_id);
    if item_id.is_empty() {
        return String::new();
    }
    let referer = format!("https://juejin.cn/post/{item_id}");
    let Ok(mut response) = agent
        .post("https://api.juejin.cn/content_api/v1/article/detail")
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Origin", "https://juejin.cn")
        .header("Referer", &referer)
        .header("Accept", "application/json,text/plain,*/*")
        .send_json(serde_json::json!({
            "article_id": item_id,
            "client_type": 2608
        }))
    else {
        return String::new();
    };
    response
        .body_mut()
        .read_json::<Value>()
        .ok()
        .map(|data| juejin_article_image_from_json(&data))
        .unwrap_or_default()
}

fn fetch_source_image_map(agent: &ureq::Agent, source_id: &'static str) -> HashMap<String, String> {
    let endpoint = match source_id {
        "zhihu" => "https://api.zhihu.com/topstory/hot-lists/total?limit=50&desktop=true",
        "toutiao" => "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
        _ => return HashMap::new(),
    };
    let referer = match source_id {
        "zhihu" => "https://www.zhihu.com/",
        "toutiao" => "https://www.toutiao.com/",
        _ => return HashMap::new(),
    };
    let Ok(mut response) = agent
        .get(endpoint)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Referer", referer)
        .header("Accept", "application/json,text/plain,*/*")
        .call()
    else {
        return HashMap::new();
    };
    let Ok(data) = response.body_mut().read_json::<Value>() else {
        return HashMap::new();
    };
    source_image_map_from_json(source_id, &data)
}

fn source_image_map_from_json(source_id: &str, data: &Value) -> HashMap<String, String> {
    let entries = data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    let mut images = HashMap::new();
    for entry in entries {
        let (id, image) = match source_id {
            "zhihu" => (
                value_to_text(entry.pointer("/target/id")),
                https_text(entry.pointer("/children/0/thumbnail"))
                    .or_else_if_empty(|| https_text(entry.pointer("/target/image_area/url"))),
            ),
            "toutiao" => (
                value_to_text(entry.pointer("/ClusterIdStr"))
                    .or_else_if_empty(|| value_to_text(entry.pointer("/ClusterId"))),
                https_text(entry.pointer("/Image/url")),
            ),
            _ => unreachable!(),
        };
        if !id.is_empty() && !image.is_empty() {
            images.insert(id, image);
        }
    }
    images
}

fn cached_source_image_map(
    agent: &ureq::Agent,
    source_id: &'static str,
) -> HashMap<String, String> {
    let cache = source_image_cache(source_id);
    if let Ok(cache) = cache.lock() {
        if cache
            .fetched_instant
            .is_some_and(|fetched| fetched.elapsed() < SOURCE_IMAGE_CACHE_TTL)
        {
            return cache.images.clone();
        }
    }
    let images = fetch_source_image_map(agent, source_id);
    if let Ok(mut cache) = cache.lock() {
        cache.fetched_instant = Some(Instant::now());
        cache.images = images.clone();
    }
    images
}

fn source_preview_image(agent: &ureq::Agent, source_id: &str, item_id: &str) -> String {
    match source_id {
        "douban" => fetch_douban_cover(agent, item_id),
        "juejin" => fetch_juejin_article_image(agent, item_id),
        "zhihu" | "toutiao" => {
            let id = safe_remote_item_id(source_id, item_id);
            if id.is_empty() {
                return String::new();
            }
            let cache_source = if source_id == "zhihu" {
                "zhihu"
            } else {
                "toutiao"
            };
            cached_source_image_map(agent, cache_source)
                .remove(&id)
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn fetch_image_data_url(page_url: &str, image_url: &str) -> Result<String, String> {
    let mut response = http_agent()
        .get(image_url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Referer", page_url)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .call()
        .map_err(|_| "无法请求资讯图片".to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(PREVIEW_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取资讯图片".to_string())?;
    if bytes.len() as u64 > PREVIEW_IMAGE_MAX_BYTES {
        return Err("资讯图片过大".to_string());
    }
    let mime = image_mime(&bytes).ok_or_else(|| "资讯图片格式不受支持".to_string())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn resolve_preview_image_url(request: &NewsNowPreviewRequest) -> Result<(String, String), String> {
    let url = url_open::validate_https_url(request.url.trim())?.to_string();
    if url.len() > 2_000 {
        return Err("资讯原文地址过长".to_string());
    }
    let source_image = source_preview_image(&http_agent(), &request.source_id, &request.item_id);
    let image_url = if !request.image_url.trim().is_empty() {
        url_open::validate_https_url(request.image_url.trim())?.to_string()
    } else if !source_image.is_empty() {
        source_image
    } else {
        let mut response = http_agent()
            .get(&url)
            .header("User-Agent", NEWSNOW_USER_AGENT)
            .header("Accept", "text/html,application/xhtml+xml")
            .call()
            .map_err(|_| "无法请求资讯原文".to_string())?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(PREVIEW_MAX_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取资讯原文".to_string())?;
        preview_image_from_html(&String::from_utf8_lossy(&bytes), &url)
    };
    Ok((url, compact_preview_image_url(&image_url)))
}

fn fetch_prefetched_image_data_url(page_url: &str, image_url: &str) -> Result<String, String> {
    let mut response = http_agent()
        .get(image_url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Referer", page_url)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .call()
        .map_err(|_| "无法请求资讯图片".to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(PREVIEW_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取资讯图片".to_string())?;
    if bytes.len() as u64 > PREVIEW_IMAGE_MAX_BYTES {
        return Err("资讯图片过大".to_string());
    }
    let decoded =
        image::load_from_memory(&bytes).map_err(|_| "资讯图片格式不受支持".to_string())?;
    let (width, height) = decoded.dimensions();
    let scaled = if width > PREFETCH_IMAGE_MAX_DIMENSION || height > PREFETCH_IMAGE_MAX_DIMENSION {
        decoded.thumbnail(PREFETCH_IMAGE_MAX_DIMENSION, PREFETCH_IMAGE_MAX_DIMENSION)
    } else {
        decoded
    };
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, 76)
        .encode_image(&scaled)
        .map_err(|_| "无法压缩资讯图片".to_string())?;
    if encoded.len() as u64 > PREFETCH_IMAGE_MAX_BYTES {
        return Err("资讯图片压缩后仍然过大".to_string());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    ))
}

fn fetch_prefetched_preview_image(request: NewsNowPreviewRequest) -> Result<String, String> {
    let (page_url, image_url) = resolve_preview_image_url(&request)?;
    if image_url.is_empty() {
        return Ok(String::new());
    }
    fetch_prefetched_image_data_url(&page_url, &image_url)
}

fn fetch_preview_image(request: NewsNowPreviewRequest) -> Result<NewsNowPreview, String> {
    let (url, image_url) = resolve_preview_image_url(&request)?;
    let image_data_url = if image_url.is_empty() {
        String::new()
    } else {
        fetch_image_data_url(&url, &image_url).unwrap_or_default()
    };
    Ok(NewsNowPreview {
        image_url,
        image_data_url,
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

fn normalized_tieba_bars(request: Option<&NewsNowRequest>) -> Vec<String> {
    let mut seen = HashSet::new();
    request
        .map(|request| request.tieba_bars.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|name| name.trim().trim_end_matches('吧').trim())
        .filter(|name| {
            !name.is_empty()
                && name.chars().count() <= MAX_TIEBA_BAR_CHARS
                && !name.chars().any(|character| character.is_control())
        })
        .filter(|name| seen.insert(name.to_string()))
        .take(MAX_TIEBA_BARS)
        .map(str::to_string)
        .collect()
}

fn selected_ids(sources: &[NewsSource], tieba_bars: &[String]) -> Vec<String> {
    let mut ids = sources
        .iter()
        .map(|source| source.id.to_string())
        .collect::<Vec<_>>();
    if sources.iter().any(|source| source.id == "tieba") {
        ids.extend(tieba_bars.iter().map(|bar| format!("tieba:{bar}")));
    }
    ids
}

fn cached_news(
    sources: &[NewsSource],
    tieba_bars: &[String],
    include_stale: bool,
) -> Option<NewsNowList> {
    ensure_disk_cache_loaded();
    let source_ids = selected_ids(sources, tieba_bars);
    let cached = cache().lock().ok()?;
    if cached.source_ids != source_ids || cached.items.is_empty() {
        return None;
    }
    let stale = cached
        .fetched_instant
        .is_none_or(|fetched| fetched.elapsed() >= CACHE_TTL);
    if stale && !include_stale {
        return None;
    }
    Some(NewsNowList {
        items: cached.items.clone(),
        fetched_at: cached.fetched_at,
        source_count: sources.len(),
        stale,
        // 缓存是否过期只用于决定后台刷新，不在资讯页显示过程提示。
        message: String::new(),
        ..Default::default()
    })
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
    for pointer in [
        "/extra/image",
        "/extra/cover",
        "/extra/thumbnail",
        "/image",
        "/imageUrl",
        "/thumbnail",
    ] {
        let value = item.pointer(pointer);
        let url = match value {
            Some(Value::String(_)) => https_text(value),
            Some(Value::Object(object)) => https_text(object.get("url")),
            _ => String::new(),
        };
        if !url.is_empty() {
            return url;
        }
    }
    String::new()
}

fn parse_source_response(source: NewsSource, response: Value) -> Vec<NewsNowItem> {
    let items = response.get("items").and_then(Value::as_array);
    let Some(items) = items else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let title = trim_chars(&value_to_text(item.get("title")), MAX_TEXT_CHARS);
            // 财联社的 mobileUrl 指向带版本号的 App 分享页；该页面会随
            // 分享协议过期而显示“版本过低”。其 canonical detail URL 则是
            // 正常的公开文章页。其他来源仍优先使用各自的移动端链接。
            let url = if source.id == "cls-telegraph" {
                https_text(item.get("url")).or_else_if_empty(|| https_text(item.get("mobileUrl")))
            } else {
                https_text(item.get("mobileUrl")).or_else_if_empty(|| https_text(item.get("url")))
            };
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
                preview_data_url: String::new(),
                preview_attempted: false,
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

fn class_contains(tag: &str, expected: &str) -> bool {
    html_attribute(tag, "class").is_some_and(|classes| {
        classes
            .split_ascii_whitespace()
            .any(|class| class.eq_ignore_ascii_case(expected))
    })
}

fn html_text(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// Tieba's public mobile client endpoint checks this legacy MD5 request checksum.
// It is only a protocol compatibility checksum, never used for credential storage.
fn tieba_md5_hex(input: &str) -> String {
    const SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const CONSTANTS: [u32; 64] = [
        0xd76a_a478,
        0xe8c7_b756,
        0x2420_70db,
        0xc1bd_ceee,
        0xf57c_0faf,
        0x4787_c62a,
        0xa830_4613,
        0xfd46_9501,
        0x6980_98d8,
        0x8b44_f7af,
        0xffff_5bb1,
        0x895c_d7be,
        0x6b90_1122,
        0xfd98_7193,
        0xa679_438e,
        0x49b4_0821,
        0xf61e_2562,
        0xc040_b340,
        0x265e_5a51,
        0xe9b6_c7aa,
        0xd62f_105d,
        0x0244_1453,
        0xd8a1_e681,
        0xe7d3_fbc8,
        0x21e1_cde6,
        0xc337_07d6,
        0xf4d5_0d87,
        0x455a_14ed,
        0xa9e3_e905,
        0xfcef_a3f8,
        0x676f_02d9,
        0x8d2a_4c8a,
        0xfffa_3942,
        0x8771_f681,
        0x6d9d_6122,
        0xfde5_380c,
        0xa4be_ea44,
        0x4bde_cfa9,
        0xf6bb_4b60,
        0xbebf_bc70,
        0x289b_7ec6,
        0xeaa1_27fa,
        0xd4ef_3085,
        0x0488_1d05,
        0xd9d4_d039,
        0xe6db_99e5,
        0x1fa2_7cf8,
        0xc4ac_5665,
        0xf429_2244,
        0x432a_ff97,
        0xab94_23a7,
        0xfc93_a039,
        0x655b_59c3,
        0x8f0c_cc92,
        0xffef_f47d,
        0x8584_5dd1,
        0x6fa8_7e4f,
        0xfe2c_e6e0,
        0xa301_4314,
        0x4e08_11a1,
        0xf753_7e82,
        0xbd3a_f235,
        0x2ad7_d2bb,
        0xeb86_d391,
    ];

    let mut bytes = input.as_bytes().to_vec();
    let bit_length = (bytes.len() as u64).wrapping_mul(8);
    bytes.push(0x80);
    while bytes.len() % 64 != 56 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bit_length.to_le_bytes());

    let mut a0 = 0x6745_2301u32;
    let mut b0 = 0xefcd_ab89u32;
    let mut c0 = 0x98ba_dcfeu32;
    let mut d0 = 0x1032_5476u32;
    for chunk in bytes.chunks_exact(64) {
        let mut words = [0u32; 16];
        for (index, word) in words.iter_mut().enumerate() {
            *word = u32::from_le_bytes(chunk[index * 4..index * 4 + 4].try_into().unwrap());
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for index in 0..64 {
            let (f, g) = match index {
                0..=15 => ((b & c) | (!b & d), index),
                16..=31 => ((d & b) | (!d & c), (5 * index + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * index + 5) % 16),
                _ => (c ^ (b | !d), (7 * index) % 16),
            };
            let next = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(CONSTANTS[index])
                    .wrapping_add(words[g])
                    .rotate_left(SHIFTS[index]),
            );
            (a, d, c, b) = (d, c, b, next);
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut output = String::with_capacity(32);
    for word in [a0, b0, c0, d0] {
        for byte in word.to_le_bytes() {
            write!(&mut output, "{byte:02x}").expect("write to string");
        }
    }
    output
}

fn tieba_https_url(value: &str) -> String {
    let insecure_prefix = ["http", "://tieba.baidu.com/"].concat();
    let https = value
        .trim()
        .replacen(&insecure_prefix, "https://tieba.baidu.com/", 1);
    url_open::validate_https_url(&https)
        .map(str::to_string)
        .unwrap_or_default()
}

fn tieba_content_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_tieba_response(source: NewsSource, bar: &str, response: Value) -> Vec<NewsNowItem> {
    let oldest_recent_timestamp = now_unix_seconds().saturating_sub(TIEBA_RECENT_WINDOW_SECS);
    let mut recent = Vec::new();
    let mut older = Vec::new();
    for (timestamp, item) in response
        .get("thread_list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let title = trim_chars(&value_to_text(item.get("title")), MAX_TEXT_CHARS);
            let tid =
                value_to_text(item.get("tid")).or_else_if_empty(|| value_to_text(item.get("id")));
            let url = tieba_https_url(&value_to_text(item.get("thread_share_link")))
                .or_else_if_empty(|| {
                    if tid.is_empty() {
                        String::new()
                    } else {
                        format!("https://tieba.baidu.com/p/{tid}")
                    }
                });
            if title.is_empty() || url.is_empty() {
                return None;
            }
            let summary = trim_chars(
                &tieba_content_text(item.get("abstract"))
                    .or_else_if_empty(|| tieba_content_text(item.get("first_post_content"))),
                MAX_TEXT_CHARS,
            );
            let timestamp = item
                .get("last_time_int")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let published_at = chrono::DateTime::from_timestamp(timestamp, 0)
                .map(|time| time.to_rfc3339())
                .unwrap_or_default();
            Some((
                timestamp,
                NewsNowItem {
                    id: format!("tieba:{bar}:{tid}"),
                    title,
                    url,
                    source: format!("{bar}吧"),
                    source_id: source.id.to_string(),
                    source_color: source.color.to_string(),
                    summary,
                    published_at,
                    image_url: tieba_https_url(&value_to_text(item.get("meizhi_pic"))),
                    preview_data_url: String::new(),
                    preview_attempted: false,
                    category: source.category.to_string(),
                },
            ))
        })
    {
        if timestamp >= oldest_recent_timestamp {
            recent.push((timestamp, item));
        } else {
            older.push((timestamp, item));
        }
    }
    recent.sort_by_key(|item| std::cmp::Reverse(item.0));
    older.sort_by_key(|item| std::cmp::Reverse(item.0));
    recent
        .into_iter()
        .chain(older.into_iter().take(TIEBA_OLD_FALLBACK_PER_BAR))
        .map(|(_, item)| item)
        .collect()
}

fn fetch_tieba_source(
    agent: &ureq::Agent,
    source: NewsSource,
    bars: &[String],
) -> Result<Vec<NewsNowItem>, String> {
    if bars.is_empty() {
        return Err("百度贴吧（请先添加吧名）".to_string());
    }
    let mut per_bar_items = Vec::new();
    for bar in bars {
        let form = [
            ("BDUSS", "".to_string()),
            ("_client_id", "wappc_1391906375532_83".to_string()),
            ("_client_type", "2".to_string()),
            ("_client_version", "4.5.3".to_string()),
            ("_phone_imei", "862663020162818".to_string()),
            ("from", "tiebawap_bottom".to_string()),
            ("kw", bar.to_string()),
            ("net_type", "3".to_string()),
            ("pn", "1".to_string()),
            ("st_type", "tb_forumlist".to_string()),
        ];
        let signature_text = form
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<String>();
        let mut signed_form = form.to_vec();
        signed_form.push((
            "sign",
            tieba_md5_hex(&format!("{signature_text}tiebaclient!!!")),
        ));
        let result = agent
            .post("https://c.tieba.baidu.com/c/f/frs/page")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Mobile Safari/537.36",
            )
            .header("Accept", "application/json")
            .send_form(signed_form)
            .ok()
            .and_then(|mut response| response.body_mut().read_to_string().ok())
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .map(|response| parse_tieba_response(source, bar, response))
            .filter(|items| !items.is_empty());
        if let Some(items) = result {
            per_bar_items.push(items);
        }
    }
    let mut items = Vec::new();
    let longest_bar = per_bar_items.iter().map(Vec::len).max().unwrap_or_default();
    for index in 0..longest_bar {
        for bar_items in &per_bar_items {
            if let Some(item) = bar_items.get(index) {
                items.push(item.clone());
            }
        }
    }
    if items.is_empty() {
        Err("百度贴吧".to_string())
    } else {
        Ok(items)
    }
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    html[start..].find('>').map(|offset| start + offset + 1)
}

fn tag_start(lower: &str, tag: &str, cursor: usize) -> Option<usize> {
    let needle = format!("<{tag}");
    let mut cursor = cursor;
    while let Some(found) = lower[cursor..].find(&needle) {
        let start = cursor + found;
        if lower
            .as_bytes()
            .get(start + needle.len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
        {
            return Some(start);
        }
        cursor = start + needle.len();
    }
    None
}

fn element_with_class<'a>(html: &'a str, tag: &str, class: &str) -> Option<(&'a str, &'a str)> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let end = tag_end(html, start)?;
        let opening = &html[start..end];
        if class.is_empty() || class_contains(opening, class) {
            let close = format!("</{tag}>");
            let content_end = lower[end..].find(&close).map(|offset| end + offset)?;
            return Some((opening, &html[end..content_end]));
        }
        cursor = end;
    }
    None
}

fn balanced_element_with_class<'a>(
    html: &'a str,
    tag: &str,
    class: &str,
) -> Option<(&'a str, &'a str)> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let opening_end = tag_end(html, start)?;
        let opening = &html[start..opening_end];
        if !class_contains(opening, class) {
            cursor = opening_end;
            continue;
        }
        let closing = format!("</{tag}>");
        let mut depth = 1usize;
        let mut scan = opening_end;
        while depth > 0 {
            let next_open = tag_start(&lower, tag, scan);
            let next_close = lower[scan..].find(&closing).map(|offset| scan + offset);
            match (next_open, next_close) {
                (_, Some(close)) if next_open.is_none_or(|open| close < open) => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((opening, &html[opening_end..close]));
                    }
                    scan = close + closing.len();
                }
                (Some(open), _) => {
                    depth += 1;
                    scan = tag_end(html, open)?;
                }
                _ => return None,
            }
        }
    }
    None
}

fn tag_with_class<'a>(html: &'a str, tag: &str, class: &str) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(start) = tag_start(&lower, tag, cursor) {
        let end = tag_end(html, start)?;
        let opening = &html[start..end];
        if class.is_empty() || class_contains(opening, class) {
            return Some(opening);
        }
        cursor = end;
    }
    None
}

fn list_item_blocks(html: &str) -> Vec<&str> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut blocks = Vec::new();
    while let Some(start) = tag_start(&lower, "li", cursor) {
        let Some(end) = lower[start..]
            .find("</li>")
            .map(|offset| start + offset + 5)
        else {
            break;
        };
        blocks.push(&html[start..end]);
        cursor = end;
    }
    blocks
}

fn section_from_marker<'a>(html: &'a str, marker: &str, before_marker: bool) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let marker = marker.to_ascii_lowercase();
    let marker_start = lower.find(&marker)?;
    let list_start = if before_marker {
        lower[..marker_start].rfind("<ul")?
    } else {
        marker_start + lower[marker_start..].find("<ul")?
    };
    let list_end = lower[list_start..]
        .find("</ul>")
        .map(|offset| list_start + offset + 5)?;
    Some(&html[list_start..list_end])
}

fn game_news_item(
    source: NewsSource,
    title: String,
    url: String,
    image_url: String,
    published_at: String,
) -> Option<NewsNowItem> {
    let title = trim_chars(&title, MAX_TEXT_CHARS);
    let url = absolute_image_url(&url, &url);
    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(NewsNowItem {
        id: format!("{}:{url}", source.id),
        title,
        url,
        source: source.name.to_string(),
        source_id: source.id.to_string(),
        source_color: source.color.to_string(),
        summary: String::new(),
        published_at,
        image_url,
        preview_data_url: String::new(),
        preview_attempted: false,
        category: source.category.to_string(),
    })
}

fn parse_3dm_news_html(source: NewsSource, html: &str) -> Vec<NewsNowItem> {
    let Some(section) = section_from_marker(html, "revision_list", false) else {
        return Vec::new();
    };
    list_item_blocks(section)
        .into_iter()
        .filter(|item| tag_with_class(item, "li", "selectpost").is_some())
        .filter_map(|item| {
            let image_link = tag_with_class(item, "a", "img")?;
            let title_link = element_with_class(item, "a", "bt")?;
            let image_tag = tag_with_class(item, "img", "")?;
            let time = element_with_class(item, "span", "time")?;
            let url = absolute_image_url(
                "https://www.3dmgame.com/news/",
                &html_attribute(image_link, "href")?,
            );
            let image_url = absolute_image_url(
                "https://www.3dmgame.com/news/",
                &html_attribute(image_tag, "data-original")?,
            );
            game_news_item(
                source,
                html_text(title_link.1),
                url,
                image_url,
                html_text(time.1),
            )
        })
        .collect()
}

fn parse_gamersky_news_html(source: NewsSource, html: &str) -> Vec<NewsNowItem> {
    let Some(section) = section_from_marker(html, "data-nodeid=\"129\"", true) else {
        return Vec::new();
    };
    list_item_blocks(section)
        .into_iter()
        .filter_map(|item| {
            let title_link = element_with_class(item, "a", "tt")?;
            let image_tag = tag_with_class(item, "img", "pe_u_thumb")?;
            let time = element_with_class(item, "div", "time")?;
            let url = absolute_image_url(
                "https://www.gamersky.com/news/",
                &html_attribute(title_link.0, "href")?,
            );
            let image_url = absolute_image_url(
                "https://www.gamersky.com/news/",
                &html_attribute(image_tag, "src")?,
            );
            game_news_item(
                source,
                html_text(title_link.1),
                url,
                image_url,
                html_text(time.1),
            )
        })
        .collect()
}

fn fetch_game_news_source(
    agent: &ureq::Agent,
    source: NewsSource,
) -> Result<Vec<NewsNowItem>, String> {
    let (url, parser): (&str, NewsSourceParser) = match source.id {
        "3dm-news" => ("https://www.3dmgame.com/news/", parse_3dm_news_html),
        "gamersky-news" => ("https://www.gamersky.com/news/", parse_gamersky_news_html),
        _ => return Err(source.name.to_string()),
    };
    let mut response = agent
        .get(url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|_| source.name.to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(PREVIEW_MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| source.name.to_string())?;
    let items = parser(source, &String::from_utf8_lossy(&bytes));
    if items.is_empty() {
        Err(source.name.to_string())
    } else {
        Ok(items)
    }
}

fn fetch_source(
    agent: &ureq::Agent,
    base: &str,
    source: NewsSource,
    latest: bool,
    tieba_bars: &[String],
) -> Result<Vec<NewsNowItem>, String> {
    if matches!(source.id, "3dm-news" | "gamersky-news") {
        return fetch_game_news_source(agent, source);
    }
    if source.id == "tieba" {
        return fetch_tieba_source(agent, source, tieba_bars);
    }
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
}

fn fetch_news(request: Option<NewsNowRequest>, force_refresh: bool) -> NewsNowList {
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    let sources = selected_sources(request);
    let source_ids = selected_ids(&sources, &tieba_bars);
    ensure_disk_cache_loaded();
    if !force_refresh {
        if let Some(cached) = cached_news(&sources, &tieba_bars, false) {
            return cached;
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
    let mut items = Vec::new();
    let mut failed_sources = Vec::new();
    // 刷新最多保留六路网络请求。来源可多选，但不会在一个客户端上同时打满 24 个上游。
    for batch in sources.chunks(MAX_REFRESH_CONCURRENCY) {
        let threads = batch
            .iter()
            .map(|source| {
                let base = base.clone();
                let source = *source;
                let tieba_bars = tieba_bars.clone();
                std::thread::spawn(move || {
                    fetch_source(&http_agent(), &base, source, force_refresh, &tieba_bars)
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            match thread.join() {
                Ok(Ok(mut source_items)) => items.append(&mut source_items),
                Ok(Err(source)) => failed_sources.push(source),
                Err(_) => failed_sources.push("一个资讯来源".to_string()),
            }
        }
    }
    sort_and_deduplicate(&mut items);
    // 刷新资讯文本时复用同一篇文章已经压缩好的封面，避免每五分钟重新下载。
    // 普通后台刷新也保留“已尝试但无图”的状态，让下一批继续向后推进；
    // 用户主动刷新时则允许这些失败项重试，以恢复临时网络或站点错误。
    reuse_cached_preview_state(&source_ids, &mut items, !force_refresh);

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
            cache.source_ids = source_ids.clone();
            cache.fetched_at = fetched_at;
            cache.fetched_instant = Some(Instant::now());
            cache.items = items.clone();
        }
        save_disk_cache(&source_ids, fetched_at, &items);
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

fn is_sspai_article_url(url: &str) -> bool {
    tauri::Url::parse(url).ok().is_some_and(|url| {
        matches!(url.host_str(), Some("sspai.com" | "www.sspai.com"))
            && url.path().starts_with("/post/")
    })
}

fn restricted_source_article(request: &NewsNowOpenRequest, url: &str) -> Option<NewsNowArticle> {
    let parsed = tauri::Url::parse(url).ok()?;
    let (source, unavailable_message) = match parsed.host_str()? {
        "s.weibo.com" | "weibo.com" | "www.weibo.com" => (
            "微博热搜",
            "微博要求登录后查看搜索结果，阅读器已拦截登录页。",
        ),
        "coolapk.com" | "www.coolapk.com" => (
            "酷安热榜",
            "酷安的桌面分享页只提供 App 扫码入口，阅读器已拦截扫码页。",
        ),
        _ => return None,
    };
    let query_title = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "q").then(|| value.into_owned()))
        .unwrap_or_default();
    let title_text = if request.title.trim().is_empty() {
        query_title.trim().trim_matches('#')
    } else {
        request.title.trim()
    };
    let title = trim_chars(title_text, 180);
    let title = if title.is_empty() {
        format!("{source}资讯")
    } else {
        title
    };
    let summary = trim_chars(request.summary.trim(), 1_000);
    let mut content_html = String::new();
    let _ = write!(
        content_html,
        "<section class=\"newsnow-source-notice\"><h2>{}</h2>",
        crate::reader_protocol::html_escape(&title)
    );
    if !summary.is_empty() {
        let _ = write!(
            content_html,
            "<p class=\"newsnow-source-summary\">{}</p>",
            crate::reader_protocol::html_escape(&summary)
        );
    }
    let _ = write!(
        content_html,
        "<p>{} 当前来源没有向桌面网页提供免登录、可直接读取的完整正文。需要时可使用右上角“浏览器打开原文”。</p></section>",
        crate::reader_protocol::html_escape(unavailable_message)
    );
    Some(NewsNowArticle {
        local: true,
        title,
        source: source.to_string(),
        published_at: trim_chars(request.published_at.trim(), 80),
        content_html: crate::html_sanitize::sanitize_book_html(&content_html),
        url: url.to_string(),
    })
}

fn parse_sspai_article(html: &str, url: &str) -> Result<NewsNowArticle, String> {
    let title = element_with_class(html, "h1", "article__header__title")
        .map(|(_, content)| html_text(content))
        .filter(|title| !title.is_empty())
        .ok_or_else(|| "少数派文章缺少标题".to_string())?;
    let published_at = element_with_class(html, "span", "article__header__date")
        .map(|(_, content)| html_text(content))
        .unwrap_or_default();
    let body = balanced_element_with_class(html, "div", "article__main__content")
        .map(|(_, content)| content)
        .ok_or_else(|| "少数派文章缺少正文".to_string())?;
    let content_html = crate::html_sanitize::sanitize_book_html(body);
    if content_html.trim().is_empty() {
        return Err("少数派文章正文为空".to_string());
    }
    Ok(NewsNowArticle {
        local: true,
        title,
        source: "少数派".to_string(),
        published_at,
        content_html,
        url: url.to_string(),
    })
}

fn fetch_sspai_article(url: &str) -> Result<NewsNowArticle, String> {
    let mut response = http_agent()
        .get(url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|_| "无法请求少数派文章".to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(ARTICLE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取少数派文章".to_string())?;
    if bytes.len() as u64 > ARTICLE_MAX_BYTES {
        return Err("少数派文章内容过大".to_string());
    }
    parse_sspai_article(&String::from_utf8_lossy(&bytes), url)
}

fn take_preview_requests(items: &mut [NewsNowItem]) -> Vec<(usize, NewsNowPreviewRequest)> {
    let candidates = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            !item.preview_attempted
                && item.preview_data_url.is_empty()
                && !item.url.trim().is_empty()
                && item.url.starts_with("https://")
        })
        .map(|(index, item)| (index, item.source_id.clone()))
        .collect::<Vec<_>>();
    let mut groups = Vec::<(String, Vec<usize>, usize)>::new();
    let mut group_indexes = HashMap::<String, usize>::new();
    for (index, source_id) in candidates {
        let group_index = *group_indexes.entry(source_id.clone()).or_insert_with(|| {
            groups.push((source_id, Vec::new(), 0));
            groups.len() - 1
        });
        groups[group_index].1.push(index);
    }

    let mut selected = Vec::new();
    // 掘金需要进入正文数据才能判断是否有图，知乎则有稳定的热榜缩略图接口。
    // 先为它们预热几条，避免来源较多时只轮到第一篇无图文章，用户误以为
    // 整个来源都不支持图片；剩余名额仍按来源轮询，不能让前面的来源独占。
    for (source_id, indexes, cursor) in &mut groups {
        if !matches!(source_id.as_str(), "juejin" | "zhihu") {
            continue;
        }
        while *cursor < indexes.len() && *cursor < 4 && selected.len() < MAX_PREFETCH_PREVIEW_IMAGES
        {
            selected.push(indexes[*cursor]);
            *cursor += 1;
        }
    }
    while selected.len() < MAX_PREFETCH_PREVIEW_IMAGES {
        let mut advanced = false;
        for (_, indexes, cursor) in &mut groups {
            if *cursor >= indexes.len() || selected.len() >= MAX_PREFETCH_PREVIEW_IMAGES {
                continue;
            }
            selected.push(indexes[*cursor]);
            *cursor += 1;
            advanced = true;
        }
        if !advanced {
            break;
        }
    }

    let requests = selected
        .into_iter()
        .filter_map(|index| {
            let item = items.get(index)?;
            Some((
                index,
                NewsNowPreviewRequest {
                    url: item.url.clone(),
                    image_url: item.image_url.clone(),
                    source_id: item.source_id.clone(),
                    item_id: item.id.clone(),
                },
            ))
        })
        .collect::<Vec<_>>();
    // 无论最终能否从网页取到真实正文图，本轮都必须标记为已尝试。
    // 否则几个确实无图或临时失败的条目会永远占住前 36 个位置，后面的
    // 文章即使正文中有图也永远不会进入预取队列。
    for (index, _) in &requests {
        if let Some(item) = items.get_mut(*index) {
            item.preview_attempted = true;
        }
    }
    requests
}

fn prefetch_preview_images(items: &mut [NewsNowItem]) {
    let requests = take_preview_requests(items);
    for batch in requests.chunks(PREFETCH_IMAGE_CONCURRENCY) {
        let workers = batch
            .iter()
            .cloned()
            .map(|(index, request)| {
                std::thread::spawn(move || {
                    (
                        index,
                        fetch_prefetched_preview_image(request).unwrap_or_default(),
                    )
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            if let Ok((index, image_data_url)) = worker.join() {
                if !image_data_url.is_empty() {
                    if let Some(item) = items.get_mut(index) {
                        item.preview_data_url = image_data_url;
                    }
                }
            }
        }
    }
}

fn prefetch_news(request: Option<NewsNowRequest>, force_refresh: bool) -> NewsNowList {
    let sources = selected_sources(request.clone());
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    let source_ids = selected_ids(&sources, &tieba_bars);
    let mut result = fetch_news(request, force_refresh);
    if result.items.is_empty() {
        return result;
    }
    prefetch_preview_images(&mut result.items);
    if let Ok(mut cache) = cache().lock() {
        cache.source_ids = source_ids.clone();
        cache.fetched_at = result.fetched_at;
        cache.fetched_instant = Some(Instant::now());
        cache.items = result.items.clone();
    }
    save_disk_cache(&source_ids, result.fetched_at, &result.items);
    result
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
    let sources = selected_sources(request.clone());
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    if let Some(cached) = cached_news(&sources, &tieba_bars, true) {
        return cached;
    }
    tokio::task::spawn_blocking(move || fetch_news(request, false))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯任务失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_prefetch(request: Option<NewsNowRequest>) -> NewsNowList {
    tokio::task::spawn_blocking(move || prefetch_news(request, false))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯后台刷新失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_refresh(request: Option<NewsNowRequest>) -> NewsNowList {
    // 用户主动刷新时也先把首批封面写入同一份结果；网页端不再临时插图，
    // 所以返回的卡片从第一帧就有正确高度。
    tokio::task::spawn_blocking(move || prefetch_news(request, true))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯刷新失败：{error}"),
            ..Default::default()
        })
}

#[tauri::command]
pub(crate) async fn newsnow_preview_image(
    request: NewsNowPreviewRequest,
) -> Result<NewsNowPreview, String> {
    tokio::task::spawn_blocking(move || fetch_preview_image(request))
        .await
        .map_err(|error| format!("资讯缩略图任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn newsnow_open_article(
    app: tauri::AppHandle,
    request: NewsNowOpenRequest,
) -> Result<NewsNowArticle, String> {
    let url = url_open::validate_https_url(request.url.trim())?.to_string();
    if url.len() > 2_000 {
        return Err("资讯原文地址过长".to_string());
    }
    if is_sspai_article_url(&url) {
        return tokio::task::spawn_blocking(move || fetch_sspai_article(&url))
            .await
            .map_err(|error| format!("少数派文章任务失败：{error}"))?;
    }
    if let Some(article) = restricted_source_article(&request, &url) {
        return Ok(article);
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let parent = main.as_ref().window();
    if let Some(existing) = app.get_webview(ARTICLE_WEBVIEW_LABEL) {
        let _ = existing.close();
    }
    let article_url = url.parse().map_err(|_| "资讯原文地址无效".to_string())?;
    let navigation_app = app.clone();
    parent
        .add_child(
            WebviewBuilder::new(ARTICLE_WEBVIEW_LABEL, WebviewUrl::External(article_url))
                .auto_resize()
                .initialization_script(ARTICLE_RETURN_SCRIPT)
                .on_navigation(move |target| {
                    if target.as_str() != ARTICLE_RETURN_URL {
                        return true;
                    }
                    let app = navigation_app.clone();
                    std::thread::spawn(move || {
                        if let Some(webview) = app.get_webview(ARTICLE_WEBVIEW_LABEL) {
                            let _ = webview.close();
                        }
                        let _ = app.emit("newsnow-return-to-feed", ());
                    });
                    false
                }),
            tauri::LogicalPosition::new(0, 0),
            parent
                .inner_size()
                .map_err(|error| format!("无法读取主窗口大小：{error}"))?,
        )
        .map_err(|error| format!("无法在主窗口打开资讯原文：{error}"))?;
    Ok(NewsNowArticle {
        url,
        ..Default::default()
    })
}

#[tauri::command]
pub(crate) fn newsnow_close_article(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(ARTICLE_WEBVIEW_LABEL) {
        webview
            .close()
            .map_err(|error| format!("无法关闭资讯原文：{error}"))?;
    }
    Ok(())
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
    fn article_return_control_is_only_injected_into_the_top_page() {
        assert!(ARTICLE_RETURN_SCRIPT.contains("if (window.top !== window) return;"));
        assert!(ARTICLE_RETURN_SCRIPT.contains("kunpeng-news-return"));
    }

    #[test]
    fn sspai_article_is_extracted_sanitized_and_keeps_nested_body_content() {
        let html = r#"
            <article class="normal-article">
              <span class="article__header__date">2026年08月06日</span>
              <h1 class="article__header__title">少数派测试文章</h1>
              <div class="article__main__content wangEditor-txt">
                <div><p>第一段</p><div><p>嵌套正文</p></div></div>
                <img src="https://cdnfile.sspai.com/article.jpg" onerror="bad()">
                <script>bad()</script><iframe src="https://embed.example"></iframe>
                <p>最后一段</p>
              </div>
            </article>
        "#;
        let article = parse_sspai_article(html, "https://sspai.com/post/123").unwrap();
        assert!(article.local);
        assert_eq!(article.title, "少数派测试文章");
        assert_eq!(article.published_at, "2026年08月06日");
        assert!(article.content_html.contains("嵌套正文"));
        assert!(article.content_html.contains("最后一段"));
        assert!(article
            .content_html
            .contains("https://cdnfile.sspai.com/article.jpg"));
        assert!(!article.content_html.contains("onerror"));
        assert!(!article.content_html.contains("<script"));
        assert!(!article.content_html.contains("<iframe"));
        assert!(is_sspai_article_url("https://sspai.com/post/123"));
        assert!(!is_sspai_article_url(
            "https://sspai.com.evil.test/post/123"
        ));
    }

    #[test]
    fn login_and_app_only_sources_render_a_safe_local_explanation() {
        let weibo = restricted_source_article(
            &NewsNowOpenRequest {
                url: "https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%E8%AF%9D%E9%A2%98%23"
                    .to_string(),
                title: String::new(),
                summary: "摘要<script>bad()</script>".to_string(),
                published_at: "2026-08-06".to_string(),
            },
            "https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%E8%AF%9D%E9%A2%98%23",
        )
        .unwrap();
        assert!(weibo.local);
        assert_eq!(weibo.title, "测试话题");
        assert_eq!(weibo.source, "微博热搜");
        assert!(weibo.content_html.contains("拦截登录页"));
        assert!(weibo.content_html.contains("摘要&lt;script&gt;bad()"));
        assert!(!weibo.content_html.contains("<script>"));

        let coolapk = restricted_source_article(
            &NewsNowOpenRequest {
                url: "https://www.coolapk.com/feed/123".to_string(),
                title: "酷安动态".to_string(),
                summary: String::new(),
                published_at: String::new(),
            },
            "https://www.coolapk.com/feed/123",
        )
        .unwrap();
        assert!(coolapk.local);
        assert_eq!(coolapk.title, "酷安动态");
        assert_eq!(coolapk.source, "酷安热榜");
        assert!(coolapk.content_html.contains("拦截扫码页"));
        assert!(restricted_source_article(
            &NewsNowOpenRequest {
                url: "https://coolapk.com.evil.test/feed/123".to_string(),
                title: String::new(),
                summary: String::new(),
                published_at: String::new(),
            },
            "https://coolapk.com.evil.test/feed/123",
        )
        .is_none());
    }

    #[test]
    fn selected_sources_ignore_unknown_duplicate_and_excess_ids() {
        let ids = CURATED_SOURCES
            .iter()
            .map(|source| source.id.to_string())
            .chain(std::iter::once("unknown".to_string()))
            .chain(std::iter::once("weibo".to_string()))
            .collect();
        let selected = selected_sources(Some(NewsNowRequest {
            source_ids: ids,
            ..Default::default()
        }));
        assert_eq!(selected.len(), MAX_SELECTED_SOURCES);
        assert_eq!(selected[0].id, "weibo");
        assert!(!selected.iter().any(|source| source.id == "unknown"));
    }

    #[test]
    fn disk_cache_snapshot_keeps_every_fetched_news_item() {
        let saved = DiskNewsCache {
            version: NEWS_CACHE_VERSION,
            source_ids: vec!["weibo".to_string()],
            fetched_at: 42,
            items: (0..1_004)
                .map(|index| NewsNowItem {
                    title: format!("item-{index}"),
                    ..Default::default()
                })
                .collect(),
        };
        let parsed = serde_json::from_slice::<DiskNewsCache>(
            &serde_json::to_vec(&saved).expect("serialize disk cache"),
        )
        .expect("parse disk cache");
        assert_eq!(parsed.version, NEWS_CACHE_VERSION);
        assert_eq!(parsed.items.len(), 1_004);
        assert_eq!(MAX_REFRESH_CONCURRENCY, 6);
    }

    #[test]
    fn preview_batches_advance_past_items_that_have_no_image() {
        let mut items = (0..80)
            .map(|index| NewsNowItem {
                id: format!("item-{index}"),
                url: format!("https://news.example/{index}"),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let first = take_preview_requests(&mut items);
        assert_eq!(first.len(), MAX_PREFETCH_PREVIEW_IMAGES);
        assert_eq!(first.first().map(|(index, _)| *index), Some(0));
        assert_eq!(first.last().map(|(index, _)| *index), Some(35));

        // 即使第一批请求最后没有拿到图片，它们也不能再次堵住队首。
        let second = take_preview_requests(&mut items);
        assert_eq!(second.len(), MAX_PREFETCH_PREVIEW_IMAGES);
        assert_eq!(second.first().map(|(index, _)| *index), Some(36));
        assert_eq!(second.last().map(|(index, _)| *index), Some(71));
        assert!(items[..72].iter().all(|item| item.preview_attempted));
        assert!(items[72..].iter().all(|item| !item.preview_attempted));
    }

    #[test]
    fn preview_batches_warm_image_capable_sources_and_round_robin_the_rest() {
        let mut items = Vec::new();
        for source_id in ["dated-a", "dated-b", "juejin", "zhihu"] {
            for index in 0..20 {
                items.push(NewsNowItem {
                    id: format!("{source_id}:{index}"),
                    source_id: source_id.to_string(),
                    url: format!("https://{source_id}.example/{index}"),
                    ..Default::default()
                });
            }
        }
        let requests = take_preview_requests(&mut items);
        assert_eq!(requests.len(), MAX_PREFETCH_PREVIEW_IMAGES);
        assert_eq!(
            requests
                .iter()
                .filter(|(_, request)| request.source_id == "juejin")
                .count(),
            11
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(_, request)| request.source_id == "zhihu")
                .count(),
            11
        );
        assert!(requests
            .iter()
            .any(|(_, request)| request.source_id == "dated-a"));
        assert!(requests
            .iter()
            .any(|(_, request)| request.source_id == "dated-b"));
    }

    #[test]
    fn source_catalog_has_a_broad_but_bounded_selection() {
        assert!(CURATED_SOURCES.len() >= 30);
        assert!(CURATED_SOURCES.len() <= 48);
        assert!(CURATED_SOURCES
            .iter()
            .all(|source| !source.id.is_empty() && !source.name.is_empty()));
        assert!(CURATED_SOURCES
            .iter()
            .any(|source| source.id == "3dm-news" && source.category == "游戏"));
        assert!(CURATED_SOURCES
            .iter()
            .any(|source| source.id == "gamersky-news" && source.category == "游戏"));
        assert!(CURATED_SOURCES
            .iter()
            .any(|source| source.id == "tieba" && source.name == "百度贴吧"));
    }

    #[test]
    fn tieba_bars_are_local_request_data_and_stay_bounded() {
        let bars = normalized_tieba_bars(Some(&NewsNowRequest {
            source_ids: vec!["tieba".to_string()],
            tieba_bars: vec![
                "原神吧".to_string(),
                " 原神 ".to_string(),
                "崩坏：星穹铁道".to_string(),
                "\n".to_string(),
            ],
        }));
        assert_eq!(bars, vec!["原神", "崩坏：星穹铁道"]);
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "tieba")
            .unwrap();
        assert_eq!(tieba_md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
        let items = parse_tieba_response(
            source,
            "原神",
            json!({"thread_list": [{
                "tid": "123",
                "title": "一条帖子",
                "thread_share_link": concat!("http", "://tieba.baidu.com/p/123"),
                "abstract": [{"text": "帖子摘要"}],
                "last_time_int": 1785995216,
                "meizhi_pic": ""
            }]}),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "原神吧");
        assert_eq!(items[0].source_id, "tieba");
        assert_eq!(items[0].url, "https://tieba.baidu.com/p/123");
    }

    #[test]
    fn tieba_prefers_recent_posts_and_limits_old_fallback() {
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "tieba")
            .unwrap();
        let now = now_unix_seconds();
        let items = parse_tieba_response(
            source,
            "静读天下",
            json!({"thread_list": [
                {"tid": "fresh", "title": "最新帖", "last_time_int": now - 10},
                {"tid": "recent", "title": "稍早新帖", "last_time_int": now - 20},
                {"tid": "old-1", "title": "旧帖一", "last_time_int": now - TIEBA_RECENT_WINDOW_SECS - 300},
                {"tid": "old-2", "title": "旧帖二", "last_time_int": now - TIEBA_RECENT_WINDOW_SECS - 200},
                {"tid": "old-3", "title": "旧帖三", "last_time_int": now - TIEBA_RECENT_WINDOW_SECS - 100}
            ]}),
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            vec!["最新帖", "稍早新帖", "旧帖三", "旧帖二"]
        );
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
    fn parser_prefers_an_article_image_over_the_source_icon() {
        let response = json!({
            "items": [{
                "id": 7,
                "title": "带图片的资讯",
                "url": "https://example.com/a",
                "extra": {
                    "image": {"url": "https://example.com/cover.jpg"},
                    "icon": {"url": "https://example.com/icon.png"}
                }
            }]
        });
        let items = parse_source_response(CURATED_SOURCES[0], response);
        assert_eq!(items[0].image_url, "https://example.com/cover.jpg");
    }

    #[test]
    fn parser_does_not_use_a_source_icon_as_an_article_thumbnail() {
        let response = json!({
            "items": [{
                "id": 7,
                "title": "无缩略图的资讯",
                "url": "https://example.com/a",
                "extra": {"icon": {"url": "https://example.com/icon.png"}}
            }]
        });
        assert!(parse_source_response(CURATED_SOURCES[0], response)[0]
            .image_url
            .is_empty());
    }

    #[test]
    fn game_site_adapters_extract_only_their_current_news_sections() {
        let source_3dm = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "3dm-news")
            .expect("3DM 来源应在目录中");
        let html_3dm = r#"
          <div class="Revision_list"><ul>
            <li class="selectpost"><a class="img" href="/news/202608/3949968.html"><img data-original="https://img.3dmgame.com/cover.jpg"></a><div class="text"><a class="bt">最新 3DM 新闻</a></div><span class="time">2026-08-05 20:24:30</span></li>
          </ul></div>
        "#;
        let parsed_3dm = parse_3dm_news_html(source_3dm, html_3dm);
        assert_eq!(parsed_3dm.len(), 1);
        assert_eq!(parsed_3dm[0].title, "最新 3DM 新闻");
        assert_eq!(
            parsed_3dm[0].url,
            "https://www.3dmgame.com/news/202608/3949968.html"
        );
        assert_eq!(parsed_3dm[0].image_url, "https://img.3dmgame.com/cover.jpg");

        let source_gamersky = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "gamersky-news")
            .expect("游民来源应在目录中");
        let html_gamersky = r#"
          <ul class="pictxt contentpaging" data-nodeid="129">
            <li><div class="img"><img class="pe_u_thumb" src="https://imgs.gamersky.com/cover.jpg"></div><div class="tit"><a class="tt" href="/news/202608/2183920.shtml">游民星空新闻</a></div><div class="con"><div class="tem"><div class="time">2026-08-05 20:44</div></div></div></li>
          </ul>
        "#;
        let parsed_gamersky = parse_gamersky_news_html(source_gamersky, html_gamersky);
        assert_eq!(parsed_gamersky.len(), 1);
        assert_eq!(parsed_gamersky[0].title, "游民星空新闻");
        assert_eq!(
            parsed_gamersky[0].url,
            "https://www.gamersky.com/news/202608/2183920.shtml"
        );
        assert_eq!(
            parsed_gamersky[0].image_url,
            "https://imgs.gamersky.com/cover.jpg"
        );
    }

    #[test]
    fn parser_uses_canonical_cls_article_instead_of_expiring_share_page() {
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "cls-telegraph")
            .expect("财联社来源应在目录中");
        let response = json!({
            "items": [{
                "id": 7,
                "title": "财联社电报",
                "url": "https://www.cls.cn/detail/123456",
                "mobileUrl": "https://api3.cls.cn/share/article/123456?os=web&sv=7.7.5&app="
            }]
        });
        let items = parse_source_response(source, response);
        assert_eq!(items[0].url, "https://www.cls.cn/detail/123456");
    }

    #[test]
    fn preview_image_reads_open_graph_metadata_and_resolves_root_path() {
        let html = r#"<meta property="og:image" content="/cover.jpg"><meta name="twitter:image" content="https://example.com/other.jpg">"#;
        assert_eq!(
            preview_image_from_html(html, "https://news.example/path/story"),
            "https://news.example/cover.jpg"
        );
    }

    #[test]
    fn preview_image_falls_back_to_article_image_and_skips_site_chrome() {
        let html = r#"<meta itemprop="image" content="/meta.jpg"><img class="site-logo" src="/logo.png"><img data-src="/body.jpg">"#;
        assert_eq!(
            preview_image_from_html(html, "https://news.example/path/story"),
            "https://news.example/meta.jpg"
        );
        assert_eq!(
            preview_image_from_html(
                r#"<img class="site-logo" src="/logo.png"><img data-src="/body.jpg">"#,
                "https://news.example/path/story"
            ),
            "https://news.example/body.jpg"
        );
        assert_eq!(
            preview_image_from_html(
                r#"<img data-lazy-src="/body.jpg">"#,
                "https://news.example/path/story"
            ),
            "https://news.example/body.jpg"
        );
    }

    #[test]
    fn sspai_preview_uses_a_compact_real_cover_variant() {
        assert_eq!(
            compact_preview_image_url(
                "https://rssfile.sspai.com/2026/07/25/cover.png?imageMogr2/auto-orient"
            ),
            "https://rssfile.sspai.com/2026/07/25/cover.png?imageView2/2/w/800/h/450/format/webp/q/85"
        );
        assert_eq!(
            compact_preview_image_url("https://images.example/cover.png?width=1600"),
            "https://images.example/cover.png?width=1600"
        );
    }

    #[test]
    fn source_specific_preview_extractors_only_accept_real_article_images() {
        let thepaper = r#"
            <img class="site-logo" src="/logo.png">
            <script id="__NEXT_DATA__" type="application/json">
              {"props":{"pageProps":{"detailData":{"contentDetail":{"sharePic":"https://imgpai.thepaper.cn/cover.jpg"}}}}}
            </script>
        "#;
        assert_eq!(
            preview_image_from_html(thepaper, "https://www.thepaper.cn/newsDetail_forward_123"),
            "https://imgpai.thepaper.cn/cover.jpg"
        );
        let coolapk = r#"
            <img class="header-art" src="/header.jpg">
            <img class="message-image" src="//image.coolapk.com/feed/real.jpg.m.jpg">
        "#;
        assert_eq!(
            preview_image_from_html(coolapk, "https://www.coolapk.com/feed/123"),
            "https://image.coolapk.com/feed/real.jpg.m.jpg"
        );
        assert!(preview_image_from_html(
            r#"<img class="header-art" src="/header.jpg">"#,
            "https://www.coolapk.com/feed/123"
        )
        .is_empty());

        let juejin = r#"
            <meta itemprop="image" content="https://p1-jj.byteimg.com/gold-assets/icon/icon-128.png">
            <script>window.__NUXT__={article_info:{web_html_content:"\u003Cp\u003E正文\u003C\u002Fp\u003E\u003Cimg src=\u0022https:\u002F\u002Fp3-xtjj-sign.byteimg.com\u002Farticle.awebp?x=1&#x26;y=2\u0022\u003E"}}</script>
        "#;
        assert_eq!(
            preview_image_from_html(juejin, "https://juejin.cn/post/123"),
            "https://p3-xtjj-sign.byteimg.com/article.awebp?x=1&y=2"
        );
        assert!(preview_image_from_html(
            r#"<meta itemprop="image" content="https://p1-jj.byteimg.com/gold-assets/icon/icon-128.png"><script>window.__NUXT__={article_info:{web_html_content:"\u003Cp\u003E纯文字正文\u003C\u002Fp\u003E"}}</script>"#,
            "https://juejin.cn/post/456"
        )
        .is_empty());
    }

    #[test]
    fn remote_cover_lookup_only_accepts_numeric_source_item_ids() {
        assert_eq!(source_item_id("zhihu", "zhihu:123"), "123");
        assert_eq!(safe_remote_item_id("zhihu", "zhihu:123"), "123");
        assert!(safe_remote_item_id("zhihu", "zhihu:123/evil").is_empty());
        assert!(safe_remote_item_id("douban", "douban:cover").is_empty());
    }

    #[test]
    fn source_cover_maps_use_article_level_fields_not_icons() {
        let zhihu = source_image_map_from_json(
            "zhihu",
            &json!({"data": [{
                "target": {"id": 123, "image_area": {"url": "https://images.example/fallback.jpg"}},
                "children": [{"thumbnail": "https://images.example/answer.jpg"}]
            }]}),
        );
        assert_eq!(
            zhihu.get("123"),
            Some(&"https://images.example/answer.jpg".to_string())
        );
        let toutiao = source_image_map_from_json(
            "toutiao",
            &json!({"data": [{
                "ClusterIdStr": "456",
                "Image": {"url": "https://images.example/topic.jpg"},
                "LabelUri": "https://images.example/label.png"
            }]}),
        );
        assert_eq!(
            toutiao.get("456"),
            Some(&"https://images.example/topic.jpg".to_string())
        );

        let juejin = juejin_article_image_from_json(&json!({
            "data": {"article_info": {
                "cover_image": "",
                "mark_content": "正文\n\n![真实首图](https://images.example/juejin.webp?x=1&y=2)\n",
                "web_html_content": null
            }}
        }));
        assert_eq!(juejin, "https://images.example/juejin.webp?x=1&y=2");
        let juejin_cover = juejin_article_image_from_json(&json!({
            "data": {"article_info": {
                "cover_image": "https://images.example/cover.png",
                "mark_content": "![正文图](https://images.example/body.png)"
            }}
        }));
        assert_eq!(juejin_cover, "https://images.example/cover.png");
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

    #[test]
    fn sort_and_deduplicate_keeps_the_full_selected_source_feed() {
        let mut items = (0..1_100)
            .map(|index| NewsNowItem {
                title: format!("dated-{index}"),
                url: format!("https://dated.example/{index}"),
                source_id: "dated".to_string(),
                published_at: format!("2026-08-05 12:{index:02}"),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        for source_id in ["weibo", "zhihu", "tieba"] {
            for index in 0..80 {
                items.push(NewsNowItem {
                    title: format!("{source_id}-{index}"),
                    url: format!("https://{source_id}.example/{index}"),
                    source_id: source_id.to_string(),
                    ..Default::default()
                });
            }
        }
        sort_and_deduplicate(&mut items);
        assert_eq!(items.len(), 1_340);
        for source_id in ["weibo", "zhihu", "tieba"] {
            assert_eq!(
                items
                    .iter()
                    .filter(|item| item.source_id == source_id)
                    .count(),
                80
            );
        }
        assert_eq!(
            items
                .iter()
                .filter(|item| item.source_id == "dated")
                .count(),
            1_100
        );
    }
}
