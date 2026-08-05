//! A privacy-preserving, reader-oriented adapter for the public NewsNow API.
//!
//! News content is deliberately transient: it never enters the reader database,
//! search index, backup, or sync payload.  The WebView can only request IDs from
//! the local source catalogue, while the Rust side fetches and validates HTTPS
//! article URLs before handing them back to the UI.

use crate::url_open;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
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
const MAX_REFRESH_CONCURRENCY: usize = 6;
const MAX_ITEMS_PER_SOURCE: usize = 16;
const MAX_TOTAL_ITEMS: usize = 90;
const MIN_ITEMS_PER_SOURCE: usize = 3;
const MAX_TEXT_CHARS: usize = 500;
const NEWS_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const PREVIEW_IMAGE_MAX_BYTES: u64 = 1_500_000;
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
    let mut saved = serde_json::from_slice::<DiskNewsCache>(&bytes).ok()?;
    if saved.version != 1
        || saved.source_ids.is_empty()
        || saved.source_ids.len() > MAX_SELECTED_SOURCES
        || saved.items.is_empty()
    {
        return None;
    }
    saved.items.truncate(MAX_TOTAL_ITEMS);
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
        version: 1,
        source_ids: source_ids.to_vec(),
        fetched_at,
        items: items.to_vec(),
    };
    let _ = crate::atomic_file::write_json(&path, &saved, false);
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
    let value = value.trim();
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

fn preview_image_from_html(html: &str, page_url: &str) -> String {
    // 这些站点的通用首图经常是导航 Logo。仅使用它们已确认的正文结构；
    // 找不到真实正文图就明确无图，不再猜测。
    if page_url.contains("thepaper.cn/") {
        return thepaper_preview_image_from_html(html, page_url);
    }
    if page_url.contains("coolapk.com/") {
        return image_from_tag_with_class(html, page_url, "message-image");
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

fn fetch_preview_image(request: NewsNowPreviewRequest) -> Result<NewsNowPreview, String> {
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
    let image_url = compact_preview_image_url(&image_url);
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

fn selected_ids(sources: &[NewsSource]) -> Vec<String> {
    sources.iter().map(|source| source.id.to_string()).collect()
}

fn cached_news(sources: &[NewsSource], include_stale: bool) -> Option<NewsNowList> {
    ensure_disk_cache_loaded();
    let source_ids = selected_ids(sources);
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
        message: if stale {
            "正在显示本地缓存，后台正在更新。".to_string()
        } else {
            String::new()
        },
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
        .take(MAX_ITEMS_PER_SOURCE)
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
        .take(MAX_ITEMS_PER_SOURCE)
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
        .take(MAX_ITEMS_PER_SOURCE)
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
) -> Result<Vec<NewsNowItem>, String> {
    if matches!(source.id, "3dm-news" | "gamersky-news") {
        return fetch_game_news_source(agent, source);
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
    if items.len() <= MAX_TOTAL_ITEMS {
        return;
    }
    // 热榜类来源没有发布时间。若只按时间截断，它们会在多来源刷新时被
    // 全部挤掉；先为每个成功来源保留少量条目，再用最新内容填满余量。
    let mut per_source = std::collections::HashMap::<&str, usize>::new();
    let mut retained_urls = HashSet::new();
    for item in items.iter() {
        let count = per_source.entry(&item.source_id).or_default();
        if *count < MIN_ITEMS_PER_SOURCE {
            retained_urls.insert(item.url.clone());
            *count += 1;
        }
    }
    for item in items.iter() {
        if retained_urls.len() >= MAX_TOTAL_ITEMS {
            break;
        }
        retained_urls.insert(item.url.clone());
    }
    items.retain(|item| retained_urls.contains(&item.url));
}

fn fetch_news(request: Option<NewsNowRequest>, force_refresh: bool) -> NewsNowList {
    let sources = selected_sources(request);
    let source_ids = selected_ids(&sources);
    ensure_disk_cache_loaded();
    if !force_refresh {
        if let Some(cached) = cached_news(&sources, false) {
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
                std::thread::spawn(move || {
                    fetch_source(&http_agent(), &base, source, force_refresh)
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
    if let Some(cached) = cached_news(&sources, true) {
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
    tokio::task::spawn_blocking(move || fetch_news(request, false))
        .await
        .unwrap_or_else(|error| NewsNowList {
            message: format!("资讯后台刷新失败：{error}"),
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
) -> Result<(), String> {
    let url = url_open::validate_https_url(request.url.trim())?.to_string();
    if url.len() > 2_000 {
        return Err("资讯原文地址过长".to_string());
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
    Ok(())
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
    fn disk_cache_snapshot_keeps_only_bounded_news_items() {
        let saved = DiskNewsCache {
            version: 1,
            source_ids: vec!["weibo".to_string()],
            fetched_at: 42,
            items: (0..(MAX_TOTAL_ITEMS + 4))
                .map(|index| NewsNowItem {
                    title: format!("item-{index}"),
                    ..Default::default()
                })
                .collect(),
        };
        let mut parsed = serde_json::from_slice::<DiskNewsCache>(
            &serde_json::to_vec(&saved).expect("serialize disk cache"),
        )
        .expect("parse disk cache");
        parsed.items.truncate(MAX_TOTAL_ITEMS);
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.items.len(), MAX_TOTAL_ITEMS);
        assert_eq!(MAX_REFRESH_CONCURRENCY, 6);
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
    fn sort_and_deduplicate_keeps_undated_hot_sources_under_total_limit() {
        let mut items = (0..88)
            .map(|index| NewsNowItem {
                title: format!("dated-{index}"),
                url: format!("https://dated.example/{index}"),
                source_id: "dated".to_string(),
                published_at: format!("2026-08-05 12:{index:02}"),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        for source_id in ["weibo", "zhihu"] {
            for index in 0..3 {
                items.push(NewsNowItem {
                    title: format!("{source_id}-{index}"),
                    url: format!("https://{source_id}.example/{index}"),
                    source_id: source_id.to_string(),
                    ..Default::default()
                });
            }
        }
        sort_and_deduplicate(&mut items);
        assert_eq!(items.len(), MAX_TOTAL_ITEMS);
        for source_id in ["weibo", "zhihu"] {
            assert_eq!(
                items
                    .iter()
                    .filter(|item| item.source_id == source_id)
                    .count(),
                MIN_ITEMS_PER_SOURCE
            );
        }
    }
}
