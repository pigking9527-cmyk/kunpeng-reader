//! A privacy-preserving, reader-oriented adapter for the public NewsNow API.
//!
//! News content is deliberately transient: it never enters the reader database,
//! search index, backup, or sync payload.  The WebView can only request IDs from
//! the local source catalogue, while the Rust side fetches and validates HTTPS
//! article URLs before handing them back to the UI.

mod html;
mod preview_rules;

use crate::url_open;
use base64::Engine;
use flate2::read::GzDecoder;
use html::{
    absolute_image_url, balanced_element_with_class, element_with_class, html_attribute, html_text,
    list_item_blocks, preview_image_from_html, section_from_marker, tag_with_class,
};
use image::codecs::jpeg::JpegEncoder;
use image::GenericImageView;
use preview_rules::{
    compact_preview_image_url, https_text, juejin_article_image_from_json, safe_remote_item_id,
    source_image_map_from_json, value_to_text,
};
use quick_xml::{events::Event, Reader, XmlVersion};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    fs,
    io::Read,
    net::IpAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, LazyLock, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Emitter, Manager, WebviewBuilder, WebviewUrl,
};

const DEFAULT_BASE_URL: &str = "https://newsnow.busiyi.world";
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
// Selection is not product-capped; this only bounds an untrusted request and
// still exceeds the entire built-in catalogue.
const MAX_SELECTED_SOURCES: usize = 1024;
const MAX_CUSTOM_SOURCES: usize = 200;
const MAX_CUSTOM_SOURCE_NAME_CHARS: usize = 80;
const MAX_CUSTOM_SOURCE_CATEGORY_CHARS: usize = 48;
const MAX_CUSTOM_SOURCE_URL_BYTES: usize = 2_048;
const CUSTOM_SUBSCRIPTIONS_METADATA_KEY: &str = "newsnow_custom_subscriptions_v1";
const MAX_TIEBA_BARS: usize = 8;
const MAX_TIEBA_BAR_CHARS: usize = 48;
// 已选来源按 12 路批次抓取，避免把所有上游请求和本机连接池一次性打满；
// 图片下载另有独立的 6 路上限。
const MAX_REFRESH_CONCURRENCY: usize = 12;
// 慢源只影响自己的结果，不能用与正文、图片相同的长超时阻塞后续批次，
// 使已选来源在界面端整体超时。
const NEWS_FEED_SOURCE_TIMEOUT: Duration = Duration::from_secs(6);
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
const NEWS_CACHE_VERSION: u8 = 10;
const INTELLIGENCE_SNAPSHOT_CACHE_VERSION: u64 = 1;
const INTELLIGENCE_SNAPSHOT_MAX_BYTES: usize = 24 * 1024 * 1024;
const INTELLIGENCE_SNAPSHOT_MAX_ITEMS: usize = 30_000;
const INTELLIGENCE_SNAPSHOT_MAX_SOURCE_IDS: usize = 1_024;
const INTELLIGENCE_SNAPSHOT_MAX_FIELDS_PER_ITEM: usize = 16;
const INTELLIGENCE_SNAPSHOT_MAX_TEXT_BYTES: usize = 2_048;
const MAX_TEXT_CHARS: usize = 500;
const NEWS_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
// 原始封面随后会缩到 640px；输入上限适当高于常见手机照片，避免真实
// 封面因原图超过旧的 1.5MB 门槛被误判为“无图”，并发内存仍保持有界。
const PREVIEW_IMAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const ARTICLE_MAX_BYTES: u64 = 2 * 1024 * 1024;
// Intelligence article enrichment is deliberately a separate, bounded local
// cache. It contains public source material only; it is never mixed into the
// reader database, backup or sync entities.
const INTELLIGENCE_ARTICLE_CACHE_VERSION: u8 = 1;
const INTELLIGENCE_ARTICLE_CACHE_MAX_ENTRIES: usize = 120;
const INTELLIGENCE_ARTICLE_CACHE_MAX_BYTES: u64 = 48 * 1024 * 1024;
const INTELLIGENCE_ARTICLE_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const INTELLIGENCE_ENRICHMENT_MAX_ARTICLES: usize = 12;
// Keep the cleaned article, not just an RSS-sized preview. The editorial
// pipeline map-reduces this text in bounded chunks before the 27B final pass;
// this guard is only for pathological pages and remains well below the native
// store's 2 MiB per-article limit.
const INTELLIGENCE_ENRICHMENT_MAX_BODY_CHARS: usize = 96_000;
const INTELLIGENCE_ENRICHMENT_MAX_IMAGES: usize = 6;
const INTELLIGENCE_ENRICHMENT_MAX_VIDEOS: usize = 3;
const INTELLIGENCE_ENRICHMENT_IMAGE_MAX_BYTES: u64 = 480 * 1024;
const INTELLIGENCE_ENRICHMENT_IMAGE_MAX_DIMENSION: u32 = 560;
// The article surface is deliberately reused so the reader shell can appear
// immediately. Stop an unfinished prior document before assigning the child to
// the next article; otherwise WebView2 may continue its network work and delay
// the next top-level navigation behind it.
const ARTICLE_STOP_LOADING_SCRIPT: &str = "window.stop();";
const TOMSGUIDE_RSS_MAX_BYTES: u64 = 2 * 1024 * 1024;
const TOMSGUIDE_RSS_URL: &str = "https://www.tomsguide.com/feeds/articletype/news";
const TOMSGUIDE_ARTICLE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const TOMSGUIDE_MAX_ITEMS: usize = 96;
// Horizon's two public no-credential feeds and WorldMonitor's direct JSON/RSS
// signals have explicit parsers and bounded response bodies.  The larger
// WorldMonitor RSS catalogue below uses the same generic bounded RSS/Atom
// adapter rather than proxying either upstream product.
const DIRECT_SOURCE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DIRECT_SOURCE_MAX_ITEMS: usize = 64;
const HORIZON_RELIEFWEB_RSS_URL: &str = "https://reliefweb.int/updates/rss.xml";
const HORIZON_CISA_RSS_URL: &str = "https://www.cisa.gov/cybersecurity-advisories/all.xml";
const HORIZON_SIMON_WILLISON_ATOM_URL: &str = "https://simonwillison.net/atom/everything/";
const HORIZON_VLLM_RSS_URL: &str = "https://vllm.ai/blog/rss.xml";
const HORIZON_CNBC_FINANCE_RSS_URL: &str =
    "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664";
const HORIZON_NVIDIA_CUDA_RSS_URL: &str = "https://developer.nvidia.com/blog/tag/cuda/feed/";
const WORLDMONITOR_USGS_URL: &str =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson";
const WORLDMONITOR_EONET_URL: &str =
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=50";
const WORLDMONITOR_GDACS_RSS_URL: &str = "https://www.gdacs.org/xml/rss.xml";
// Generated from WorldMonitor's public direct-RSS catalogue.  It is compressed
// solely to keep this single-source Rust module reviewable; decoding happens
// once per process and never contacts a WorldMonitor proxy or API.
const WORLDMONITOR_PUBLIC_RSS_CATALOG_GZIP_BASE64: &str = "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";
const SOURCE_IMAGE_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const NEWSNOW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36";
const ARTICLE_WEBVIEW_LABEL: &str = "newsnow-article";
// The article surface follows the same pool-and-reuse lifecycle as the book
// reader shell. It stays local and hidden between articles, so a click only
// needs to reveal an already-created WebView and start navigation.
const ARTICLE_SHELL_URL: &str = "http://tauri.localhost/newsnow-article-shell.html";
const ARTICLE_RETURN_URL: &str = "https://reader.localhost/__kunpeng_news_return__";
const ARTICLE_LOADING_EVENT: &str = "newsnow-article-loading";
const ARTICLE_READY_EVENT: &str = "newsnow-article-ready";
const ARTICLE_WEBVIEW_IDLE: u8 = 0;
const ARTICLE_WEBVIEW_LOADING: u8 = 1;
const ARTICLE_WEBVIEW_READY: u8 = 2;

static ARTICLE_WEBVIEW_STATE: LazyLock<Arc<AtomicU8>> =
    LazyLock::new(|| Arc::new(AtomicU8::new(ARTICLE_WEBVIEW_IDLE)));
static ARTICLE_WEBVIEW_INITIALIZATION_SCRIPT: LazyLock<Mutex<String>> =
    LazyLock::new(|| Mutex::new(String::new()));
static ARTICLE_WEBVIEW_PREPARE_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArticleWebviewPhase {
    Loading,
    Ready,
}

fn article_webview_phase(event: PageLoadEvent) -> ArticleWebviewPhase {
    match event {
        PageLoadEvent::Started => ArticleWebviewPhase::Loading,
        PageLoadEvent::Finished => ArticleWebviewPhase::Ready,
    }
}

#[cfg(test)]
fn article_shell_url() -> Result<tauri::Url, String> {
    tauri::Url::parse(ARTICLE_SHELL_URL).map_err(|_| "资讯预加载外壳地址无效".to_string())
}

type NewsSourceParser = fn(NewsSource, &str) -> Vec<NewsNowItem>;
const ARTICLE_RETURN_SCRIPT: &str = r##"
(() => {
  if (window.top !== window) return;
  const returnUrl = "https://reader.localhost/__kunpeng_news_return__";
  const hideReturnIcon = __KUNPENG_HIDE_RETURN_ICON__;
  const navigateHere = (value) => {
    try {
      const target = new URL(String(value || ""), window.location.href);
      if (target.protocol !== "https:") return false;
      window.location.assign(target.href);
      return true;
    } catch (_) { return false; }
  };
  const install = () => {
    if (hideReturnIcon || document.getElementById("kunpeng-news-return")) return;
    const button = document.createElement("button");
    button.id = "kunpeng-news-return";
    button.type = "button";
    button.title = "返回资讯页；也可以通过手势关闭页面";
    button.setAttribute("aria-label", "返回资讯页；也可以通过手势关闭页面");
    button.textContent = "←";
    button.style.cssText = "position:fixed;z-index:2147483647;top:50%;right:18px;width:44px;height:44px;transform:translateY(-50%);border:1px solid #9ab9e6;border-radius:50%;color:#1e64c4;background:rgba(255,255,255,.96);box-shadow:0 4px 16px rgba(44,92,158,.24);font:25px/1 system-ui;cursor:pointer;";
    button.addEventListener("mouseenter", () => { button.style.background = "#f2f7ff"; });
    button.addEventListener("mouseleave", () => { button.style.background = "rgba(255,255,255,.96)"; });
    button.addEventListener("click", () => { window.location.assign(returnUrl); });
    document.body.appendChild(button);
  };
  // 今日头条等站点会用 target=_blank/window.open 打开正文卡片，而嵌入式
  // 子 WebView 不创建第二层弹窗；统一改为在当前资讯子页继续导航。
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link || !navigateHere(link.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.open = (value) => { navigateHere(value); return window; };
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
const ARTICLE_GESTURE_SCRIPT: &str = r##"
(() => {
  if (window.top !== window) return;
  const reference = __KUNPENG_GESTURE_POINTS__;
  const matchThreshold = __KUNPENG_GESTURE_THRESHOLD__;
  if (!Array.isArray(reference) || reference.length < 16) return;
  const returnUrl = "https://reader.localhost/__kunpeng_news_return__";
  const clean = (points) => points.map((point) => ({ x: Number(point.x), y: Number(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).slice(0, 320);
  const length = (points) => points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  const normalize = (points) => {
    const list = clean(points), total = length(list), count = reference.length;
    if (list.length < 2 || total < 64) return [];
    const interval = total / (count - 1), sampled = [{ ...list[0] }];
    let traversed = 0, previous = { ...list[0] };
    for (let index = 1; index < list.length && sampled.length < count; index += 1) {
      const current = list[index]; let segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      if (!segment) continue;
      while (traversed + segment >= interval && sampled.length < count) {
        const ratio = (interval - traversed) / segment;
        previous = { x: previous.x + (current.x - previous.x) * ratio, y: previous.y + (current.y - previous.y) * ratio };
        sampled.push({ ...previous }); segment = Math.hypot(current.x - previous.x, current.y - previous.y); traversed = 0;
      }
      traversed += segment; previous = { ...current };
    }
    while (sampled.length < count) sampled.push({ ...list[list.length - 1] });
    const xs = sampled.map((point) => point.x), ys = sampled.map((point) => point.y), scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (!Number.isFinite(scale) || scale < 1) return [];
    const centerX = xs.reduce((sum, value) => sum + value, 0) / count, centerY = ys.reduce((sum, value) => sum + value, 0) / count;
    return sampled.map((point) => ({ x: (point.x - centerX) / scale, y: (point.y - centerY) / scale }));
  };
  const score = (points) => {
    const current = normalize(points); if (!current.length) return 0;
    const distance = (list) => list.reduce((sum, point, index) => sum + Math.hypot(point.x - reference[index][0], point.y - reference[index][1]), 0) / list.length;
    return Math.max(0, Math.min(1, 1 - Math.min(distance(current), distance(current.slice().reverse())) / 0.72));
  };
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:none;position:fixed;z-index:2147483646;inset:0;width:100vw;height:100vh;pointer-events:none";
  const mountCanvas = () => { if (!canvas.isConnected) (document.documentElement || document.body)?.appendChild(canvas); };
  mountCanvas();
  if (!canvas.isConnected) document.addEventListener("DOMContentLoaded", mountCanvas, { once: true });
  let active = null, suppressUntil = 0;
  const draw = () => {
    mountCanvas();
    const ratio = Math.max(1, window.devicePixelRatio || 1), width = window.innerWidth, height = window.innerHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); canvas.style.display = "block";
    const context = canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!active || active.length < 2) return;
    context.beginPath(); active.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = "#3478d4"; context.lineWidth = 5; context.lineCap = "round"; context.lineJoin = "round"; context.shadowColor = "rgba(19,67,131,.28)"; context.shadowBlur = 5; context.stroke();
  };
  const finish = (cancelled) => {
    if (!active) return; const points = active; active = null; canvas.style.display = "none";
    const matched = !cancelled && score(points) >= matchThreshold; if (points.length > 1) suppressUntil = Date.now() + 450;
    if (matched) window.location.assign(returnUrl);
  };
  window.addEventListener("mousedown", (event) => { if (event.button !== 2) return; event.preventDefault(); active = [{ x: event.clientX, y: event.clientY }]; draw(); }, true);
  window.addEventListener("mousemove", (event) => { if (!active) return; event.preventDefault(); const previous = active[active.length - 1]; if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 4) return; active.push({ x: event.clientX, y: event.clientY }); draw(); }, true);
  window.addEventListener("mouseup", (event) => { if (event.button === 2) finish(false); }, true);
  window.addEventListener("blur", () => finish(true));
  window.addEventListener("contextmenu", (event) => { if (active || Date.now() < suppressUntil) event.preventDefault(); }, true);
})();
"##;

fn article_initialization_script(request: &NewsNowOpenRequest) -> String {
    let points = if request.gesture_enabled
        && (16..=96).contains(&request.gesture_points.len())
        && request
            .gesture_points
            .iter()
            .flatten()
            .all(|value| value.is_finite() && value.abs() <= 1.5)
    {
        request.gesture_points.as_slice()
    } else {
        &[]
    };
    let json = serde_json::to_string(points).unwrap_or_else(|_| "[]".to_string());
    let gesture_threshold = if (0.55..=0.98).contains(&request.gesture_threshold) {
        request.gesture_threshold
    } else {
        0.78
    };
    let return_script = ARTICLE_RETURN_SCRIPT.replace(
        "__KUNPENG_HIDE_RETURN_ICON__",
        if request.hide_return_icon {
            "true"
        } else {
            "false"
        },
    );
    format!(
        "{return_script}\n{}",
        ARTICLE_GESTURE_SCRIPT
            .replace("__KUNPENG_GESTURE_POINTS__", &json)
            .replace(
                "__KUNPENG_GESTURE_THRESHOLD__",
                &format!("{gesture_threshold:.2}")
            )
    )
}

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
        id: "tomsguide",
        name: "Tom's Guide",
        category: "综合",
        color: "#d71920",
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
    // Horizon is a compact, reader-safe brief of public global/cyber signals.
    // It deliberately uses the upstream public APIs directly rather than
    // relaying a private Horizon service through the desktop app.
    NewsSource {
        id: "horizon-reliefweb-updates",
        name: "ReliefWeb 人道动态",
        category: "国际",
        color: "#6f5bd3",
        default_enabled: false,
    },
    NewsSource {
        id: "horizon-cisa-advisories",
        name: "CISA 网络安全公告",
        category: "安全",
        color: "#2563a8",
        default_enabled: false,
    },
    // Direct, no-credential RSS/Atom feeds from Horizon's checked-in example
    // configuration. Sources requiring tokens, a subscriber key or a proxy
    // remain user-configurable rather than being silently bundled here.
    NewsSource {
        id: "horizon-simon-willison",
        name: "Simon Willison",
        category: "人工智能",
        color: "#6f5bd3",
        default_enabled: false,
    },
    NewsSource {
        id: "horizon-vllm-blog",
        name: "vLLM Blog",
        category: "人工智能",
        color: "#6f5bd3",
        default_enabled: false,
    },
    NewsSource {
        id: "horizon-cnbc-finance",
        name: "CNBC Finance",
        category: "财经",
        color: "#2f6fce",
        default_enabled: false,
    },
    NewsSource {
        id: "horizon-nvidia-cuda",
        name: "NVIDIA CUDA Technical Blog",
        category: "开发",
        color: "#356df3",
        default_enabled: false,
    },
    // WorldMonitor has a much wider, separately operated catalogue.  These
    // three official/public feeds are the no-key sources that can be fetched,
    // parsed, and health-checked locally today.
    NewsSource {
        id: "worldmonitor-usgs-earthquakes",
        name: "USGS 显著地震",
        category: "自然事件",
        color: "#c05a41",
        default_enabled: false,
    },
    NewsSource {
        id: "worldmonitor-nasa-eonet",
        name: "NASA 自然事件",
        category: "自然事件",
        color: "#1f5f98",
        default_enabled: false,
    },
    NewsSource {
        id: "worldmonitor-gdacs-alerts",
        name: "GDACS 灾害预警",
        category: "自然事件",
        color: "#b76a2b",
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

#[derive(Default)]
struct TomsGuideRssEntry {
    title: String,
    url: String,
    summary: String,
    guid: String,
    published_at: String,
    image_url: String,
    content_html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowSource {
    pub id: String,
    pub name: String,
    pub category: String,
    /// `reader`, `horizon`, or `worldmonitor`; stable for UI grouping.
    pub provider: String,
    /// Stable source payload class, such as `news` or `natural_event`.
    pub kind: String,
    pub color: String,
    pub default_enabled: bool,
}

impl From<NewsSource> for NewsNowSource {
    fn from(source: NewsSource) -> Self {
        Self {
            id: source.id.to_string(),
            name: source.name.to_string(),
            category: source.category.to_string(),
            provider: source_provider(source).to_string(),
            kind: source_kind(source).to_string(),
            color: source.color.to_string(),
            default_enabled: source.default_enabled,
        }
    }
}

fn source_provider(source: NewsSource) -> &'static str {
    if source.id.starts_with("horizon-") {
        "horizon"
    } else if source.id.starts_with("worldmonitor-") {
        "worldmonitor"
    } else {
        "reader"
    }
}

fn source_kind(source: NewsSource) -> &'static str {
    if find_worldmonitor_public_rss_source(source).is_some() {
        return "rss";
    }
    match source.id {
        "horizon-cisa-advisories" => "advisory",
        "worldmonitor-usgs-earthquakes" => "earthquake",
        "worldmonitor-nasa-eonet" => "natural_event",
        "worldmonitor-gdacs-alerts" => "disaster_alert",
        _ => "news",
    }
}

#[derive(Clone, Copy)]
struct PublicRssSource {
    source: NewsSource,
    url: &'static str,
}

fn worldmonitor_public_rss_sources() -> &'static [PublicRssSource] {
    static SOURCES: OnceLock<Vec<PublicRssSource>> = OnceLock::new();
    SOURCES
        .get_or_init(|| {
            let Ok(compressed) = base64::engine::general_purpose::STANDARD
                .decode(WORLDMONITOR_PUBLIC_RSS_CATALOG_GZIP_BASE64)
            else {
                return Vec::new();
            };
            let mut decoded = String::new();
            if GzDecoder::new(compressed.as_slice())
                .read_to_string(&mut decoded)
                .is_err()
            {
                return Vec::new();
            }
            decoded
                .lines()
                .filter_map(|line| {
                    let mut fields = line.splitn(4, '\t');
                    let (Some(id), Some(category), Some(name), Some(url)) =
                        (fields.next(), fields.next(), fields.next(), fields.next())
                    else {
                        return None;
                    };
                    if id.is_empty()
                        || name.is_empty()
                        || url_open::validate_https_url(url).is_err()
                    {
                        return None;
                    }
                    Some(PublicRssSource {
                        source: NewsSource {
                            id: Box::leak(id.to_string().into_boxed_str()),
                            name: Box::leak(name.to_string().into_boxed_str()),
                            category: Box::leak(category.to_string().into_boxed_str()),
                            color: worldmonitor_source_color(category),
                            default_enabled: false,
                        },
                        url: Box::leak(url.to_string().into_boxed_str()),
                    })
                })
                .collect()
        })
        .as_slice()
}

fn worldmonitor_source_color(category: &str) -> &'static str {
    match category {
        "科技" | "人工智能" | "开发" => "#356df3",
        "财经" | "能源" => "#2f6fce",
        "安全" => "#2563a8",
        "自然" | "人道" => "#b76a2b",
        "创业" | "产品" => "#8c5fc4",
        "科学" => "#258b83",
        _ => "#64748b",
    }
}

fn find_worldmonitor_public_rss_source(source: NewsSource) -> Option<&'static PublicRssSource> {
    worldmonitor_public_rss_sources()
        .iter()
        .find(|candidate| candidate.source.id == source.id)
}

fn all_sources() -> impl Iterator<Item = NewsSource> {
    CURATED_SOURCES.iter().copied().chain(
        worldmonitor_public_rss_sources()
            .iter()
            .map(|source| source.source),
    )
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowRequest {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub tieba_bars: Vec<String>,
    /// Keep separate source records that share an article URL. This is used
    /// by the local intelligence workspace so it can retain source evidence
    /// before presentation-layer event grouping.
    #[serde(default)]
    pub preserve_evidence: bool,
    /// User supplied RSS/Atom feeds. These are validated on every request and
    /// never enter the built-in catalogue, cache metadata, logs, or article
    /// history. Their definitions enter sync only through the separate,
    /// default-off subscription option.
    #[serde(default)]
    pub custom_sources: Vec<NewsNowCustomSourceRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowCustomSourceRequest {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowCustomSubscriptionsRequest {
    #[serde(default)]
    pub sources: Vec<NewsNowCustomSourceRequest>,
}

#[derive(Debug, Clone)]
struct CustomNewsSource {
    id: String,
    name: String,
    url: String,
    category: String,
}

#[derive(Clone)]
enum SelectedNewsSource {
    Builtin(NewsSource),
    Custom(CustomNewsSource),
}

impl SelectedNewsSource {
    fn id(&self) -> &str {
        match self {
            Self::Builtin(source) => source.id,
            Self::Custom(source) => &source.id,
        }
    }

    fn is_tieba(&self) -> bool {
        matches!(self, Self::Builtin(source) if source.id == "tieba")
    }

    fn is_gateway_source(&self) -> bool {
        matches!(self, Self::Builtin(source) if source_uses_newsnow_gateway(*source))
    }

    fn metadata(&self) -> NewsSourceMeta<'_> {
        match self {
            Self::Builtin(source) => (*source).into(),
            Self::Custom(source) => source.into(),
        }
    }
}

#[derive(Clone, Copy)]
struct NewsSourceMeta<'a> {
    id: &'a str,
    name: &'a str,
    category: &'a str,
    color: &'a str,
}

impl From<NewsSource> for NewsSourceMeta<'static> {
    fn from(source: NewsSource) -> Self {
        Self {
            id: source.id,
            name: source.name,
            category: source.category,
            color: source.color,
        }
    }
}

impl<'a> From<&'a CustomNewsSource> for NewsSourceMeta<'a> {
    fn from(source: &'a CustomNewsSource) -> Self {
        Self {
            id: &source.id,
            name: &source.name,
            category: &source.category,
            color: "#66758a",
        }
    }
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

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowOpenRequest {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub gesture_enabled: bool,
    #[serde(default)]
    pub gesture_points: Vec<[f64; 2]>,
    #[serde(default)]
    pub gesture_threshold: f64,
    #[serde(default)]
    pub hide_return_icon: bool,
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

/// A public article selected by the intelligence workspace for local
/// enrichment. The request deliberately carries only already-visible feed
/// metadata; no reader data, account data or local paths are accepted.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowIntelligenceArticleRequest {
    pub url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub image_url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowIntelligenceEnrichmentRequest {
    #[serde(default)]
    pub articles: Vec<NewsNowIntelligenceArticleRequest>,
}

/// Locally cached public evidence for one source article. `body` is cleaned
/// plain text for the model; `lead_image_data_url` is a bounded local preview
/// for the prepared article surface. Videos remain URLs so the existing reader
/// article path retains control over playback and navigation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewsNowIntelligenceArticleEnrichment {
    pub url: String,
    pub source: String,
    pub title: String,
    pub published_at: String,
    pub body: String,
    #[serde(default)]
    pub lead_image_url: String,
    #[serde(default)]
    pub lead_image_data_url: String,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub video_urls: Vec<String>,
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntelligenceArticleCacheEntry {
    version: u8,
    fetched_at: i64,
    article: NewsNowIntelligenceArticleEnrichment,
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
    let directory = crate::profile::app_cache_dir()?;
    Some(directory.join("newsnow-feed-v1.json"))
}

fn intelligence_snapshot_path() -> Option<PathBuf> {
    let directory = crate::profile::app_cache_dir()?;
    Some(directory.join("newsnow-intelligence-snapshot-v1.json"))
}

fn valid_intelligence_snapshot(snapshot: &Value) -> bool {
    let Some(object) = snapshot.as_object() else {
        return false;
    };
    if object.get("version").and_then(Value::as_u64) != Some(INTELLIGENCE_SNAPSHOT_CACHE_VERSION) {
        return false;
    }
    let Some(source_ids) = object.get("sourceIds").and_then(Value::as_array) else {
        return false;
    };
    if source_ids.is_empty() || source_ids.len() > INTELLIGENCE_SNAPSHOT_MAX_SOURCE_IDS {
        return false;
    }
    if source_ids.iter().any(|id| {
        id.as_str().is_none_or(|value| {
            value.is_empty() || value.len() > INTELLIGENCE_SNAPSHOT_MAX_TEXT_BYTES
        })
    }) {
        return false;
    }
    let Some(items) = object.get("items").and_then(Value::as_array) else {
        return false;
    };
    if items.len() > INTELLIGENCE_SNAPSHOT_MAX_ITEMS {
        return false;
    }
    if items.iter().any(|item| {
        item.as_object().is_none_or(|fields| {
            fields.len() > INTELLIGENCE_SNAPSHOT_MAX_FIELDS_PER_ITEM
                || fields.values().any(|value| {
                    value
                        .as_str()
                        .is_none_or(|text| text.len() > INTELLIGENCE_SNAPSHOT_MAX_TEXT_BYTES)
                })
        })
    }) {
        return false;
    }
    serde_json::to_vec(snapshot).is_ok_and(|bytes| bytes.len() <= INTELLIGENCE_SNAPSHOT_MAX_BYTES)
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

fn intelligence_article_cache_dir() -> Option<PathBuf> {
    crate::profile::app_cache_dir()
        .map(|directory| directory.join("newsnow-intelligence-articles-v1"))
}

fn intelligence_article_cache_path(url: &str) -> Option<PathBuf> {
    let directory = intelligence_article_cache_dir()?;
    let mut digest = Sha256::new();
    digest.update(url.as_bytes());
    let mut filename = String::with_capacity(64 + 5);
    for byte in digest.finalize() {
        let _ = write!(filename, "{byte:02x}");
    }
    filename.push_str(".json");
    Some(directory.join(filename))
}

fn read_intelligence_article_cache(url: &str) -> Option<NewsNowIntelligenceArticleEnrichment> {
    let path = intelligence_article_cache_path(url)?;
    let bytes = fs::read(path).ok()?;
    let entry = serde_json::from_slice::<IntelligenceArticleCacheEntry>(&bytes).ok()?;
    let age_millis = now_millis().saturating_sub(entry.fetched_at);
    (entry.version == INTELLIGENCE_ARTICLE_CACHE_VERSION
        && age_millis >= 0
        && age_millis <= INTELLIGENCE_ARTICLE_CACHE_TTL.as_millis() as i64
        && entry.article.url == url
        && !entry.article.body.trim().is_empty())
    .then_some(NewsNowIntelligenceArticleEnrichment {
        cached: true,
        ..entry.article
    })
}

fn prune_intelligence_article_cache(directory: &PathBuf) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(UNIX_EPOCH),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut total = files.iter().map(|(_, bytes, _)| *bytes).sum::<u64>();
    while files.len() > INTELLIGENCE_ARTICLE_CACHE_MAX_ENTRIES
        || total > INTELLIGENCE_ARTICLE_CACHE_MAX_BYTES
    {
        let Some((path, bytes, _)) = files.first().cloned() else {
            break;
        };
        let _ = fs::remove_file(path);
        total = total.saturating_sub(bytes);
        files.remove(0);
    }
}

fn save_intelligence_article_cache(article: &NewsNowIntelligenceArticleEnrichment) {
    let Some(path) = intelligence_article_cache_path(&article.url) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    let entry = IntelligenceArticleCacheEntry {
        version: INTELLIGENCE_ARTICLE_CACHE_VERSION,
        fetched_at: now_millis(),
        article: NewsNowIntelligenceArticleEnrichment {
            cached: false,
            ..article.clone()
        },
    };
    if crate::atomic_file::write_json(&path, &entry, false).is_ok() {
        prune_intelligence_article_cache(&directory.to_path_buf());
    }
}

fn remove_html_element(mut value: String, tag: &str) -> String {
    let needle = format!("<{tag}");
    let closing = format!("</{tag}>");
    loop {
        let lower = value.to_ascii_lowercase();
        let Some(start) = lower.find(&needle) else {
            return value;
        };
        let Some(open_end) = lower[start..].find('>').map(|offset| start + offset + 1) else {
            return value;
        };
        let end = lower[open_end..]
            .find(&closing)
            .map(|offset| open_end + offset + closing.len())
            .unwrap_or(open_end);
        value.replace_range(start..end, " ");
    }
}

fn article_text_container(html: &str) -> &str {
    let mut best = balanced_element_with_class(html, "article", "")
        .or_else(|| balanced_element_with_class(html, "main", ""))
        .map(|(_, content)| content)
        .unwrap_or_default();
    for class in [
        "article-body",
        "article-content",
        "entry-content",
        "post-content",
        "story-body",
        "content-body",
    ] {
        if let Some((_, candidate)) = balanced_element_with_class(html, "div", class) {
            if html_text(candidate).chars().count() > html_text(best).chars().count() {
                best = candidate;
            }
        }
    }
    if best.is_empty() {
        balanced_element_with_class(html, "body", "")
            .map(|(_, content)| content)
            .unwrap_or(html)
    } else {
        best
    }
}

fn cleaned_article_text(html: &str) -> String {
    let mut content = article_text_container(html).to_string();
    for tag in [
        "script", "style", "noscript", "svg", "template", "nav", "footer", "form",
    ] {
        content = remove_html_element(content, tag);
    }
    trim_chars(&html_text(&content), INTELLIGENCE_ENRICHMENT_MAX_BODY_CHARS)
}

fn deduplicated_media_urls(html: &str, page_url: &str, tags: &[&str], limit: usize) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for tag_name in tags {
        let needle = format!("<{tag_name}");
        let mut cursor = 0;
        while let Some(found) = lower[cursor..].find(&needle) {
            let start = cursor + found;
            let Some(end) = html[start..].find('>').map(|offset| start + offset + 1) else {
                break;
            };
            let tag = &html[start..end];
            if *tag_name == "source"
                && !html_attribute(tag, "type")
                    .is_some_and(|media_type| media_type.to_ascii_lowercase().starts_with("video/"))
            {
                cursor = end;
                continue;
            }
            for attribute in ["data-src", "data-original", "data-lazy-src", "src"] {
                let Some(raw_url) = html_attribute(tag, attribute) else {
                    continue;
                };
                let url = absolute_image_url(page_url, &raw_url);
                if !url.is_empty() && seen.insert(url.clone()) {
                    urls.push(url);
                    if urls.len() >= limit {
                        return urls;
                    }
                }
            }
            cursor = end;
        }
    }
    urls
}

fn intelligence_image_data_url(page_url: &str, image_url: &str) -> Result<String, String> {
    let mut response = intelligence_article_agent()
        .get(image_url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Referer", page_url)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        )
        .call()
        .map_err(|_| "无法请求资讯图片".to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(INTELLIGENCE_ENRICHMENT_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取资讯图片".to_string())?;
    if bytes.len() as u64 > INTELLIGENCE_ENRICHMENT_IMAGE_MAX_BYTES {
        return Err("资讯图片过大".to_string());
    }
    let decoded =
        image::load_from_memory(&bytes).map_err(|_| "资讯图片格式不受支持".to_string())?;
    let (width, height) = decoded.dimensions();
    let scaled = if width > INTELLIGENCE_ENRICHMENT_IMAGE_MAX_DIMENSION
        || height > INTELLIGENCE_ENRICHMENT_IMAGE_MAX_DIMENSION
    {
        decoded.thumbnail(
            INTELLIGENCE_ENRICHMENT_IMAGE_MAX_DIMENSION,
            INTELLIGENCE_ENRICHMENT_IMAGE_MAX_DIMENSION,
        )
    } else {
        decoded
    };
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, 74)
        .encode_image(&scaled)
        .map_err(|_| "无法压缩资讯图片".to_string())?;
    if encoded.len() as u64 > INTELLIGENCE_ENRICHMENT_IMAGE_MAX_BYTES {
        return Err("资讯图片压缩后仍然过大".to_string());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    ))
}

fn enrichment_fallback(
    request: &NewsNowIntelligenceArticleRequest,
    url: String,
) -> NewsNowIntelligenceArticleEnrichment {
    let title = trim_chars(request.title.trim(), 320);
    let summary = trim_chars(
        request.summary.trim(),
        INTELLIGENCE_ENRICHMENT_MAX_BODY_CHARS,
    );
    let body = [title.as_str(), summary.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    NewsNowIntelligenceArticleEnrichment {
        url,
        source: trim_chars(request.source.trim(), 160),
        title,
        published_at: trim_chars(request.published_at.trim(), 100),
        body,
        degraded: true,
        ..Default::default()
    }
}

fn fetch_intelligence_article_enrichment(
    request: NewsNowIntelligenceArticleRequest,
) -> NewsNowIntelligenceArticleEnrichment {
    let Ok(canonical_url) = canonical_news_article_url(&request.url) else {
        return enrichment_fallback(&request, String::new());
    };
    let Some(url) = validate_custom_feed_url(&canonical_url) else {
        return enrichment_fallback(&request, String::new());
    };
    if let Some(cached) = read_intelligence_article_cache(&url) {
        return cached;
    }
    let fallback = enrichment_fallback(&request, url.clone());
    let Ok(mut response) = intelligence_article_agent()
        .get(&url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
    else {
        return fallback;
    };
    let mut bytes = Vec::new();
    if response
        .body_mut()
        .as_reader()
        .take(ARTICLE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > ARTICLE_MAX_BYTES
    {
        return fallback;
    }
    let html = String::from_utf8_lossy(&bytes);
    let mut body = cleaned_article_text(&html);
    if body.chars().count() < 80 {
        return fallback;
    }
    let mut image_urls =
        deduplicated_media_urls(&html, &url, &["img"], INTELLIGENCE_ENRICHMENT_MAX_IMAGES);
    let lead_image_url = if request.image_url.trim().is_empty() {
        preview_image_from_html(&html, &url)
    } else {
        url_open::validate_https_url(request.image_url.trim())
            .map(str::to_string)
            .unwrap_or_default()
    };
    if !lead_image_url.is_empty() {
        image_urls.retain(|image| image != &lead_image_url);
        image_urls.insert(0, lead_image_url.clone());
        image_urls.truncate(INTELLIGENCE_ENRICHMENT_MAX_IMAGES);
    }
    let video_urls = deduplicated_media_urls(
        &html,
        &url,
        &["video", "source"],
        INTELLIGENCE_ENRICHMENT_MAX_VIDEOS,
    );
    let lead_image_data_url = if lead_image_url.is_empty() {
        String::new()
    } else {
        intelligence_image_data_url(&url, &lead_image_url).unwrap_or_default()
    };
    let title = trim_chars(request.title.trim(), 320);
    if body.starts_with(&title) && body.chars().count() > title.chars().count() + 4 {
        body = body[title.len()..].trim_start().to_string();
    }
    let article = NewsNowIntelligenceArticleEnrichment {
        url,
        source: trim_chars(request.source.trim(), 160),
        title,
        published_at: trim_chars(request.published_at.trim(), 100),
        body,
        lead_image_url,
        lead_image_data_url,
        image_urls,
        video_urls,
        cached: false,
        degraded: false,
    };
    save_intelligence_article_cache(&article);
    article
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

// Intelligence enrichment fetches arbitrary public publisher URLs selected
// from feeds. Do not follow a server-provided redirect after initial URL
// validation: that could redirect the local fetcher toward a private target.
// A failed redirect simply falls back to the RSS evidence.
fn intelligence_article_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(NEWS_REQUEST_TIMEOUT))
        .timeout_connect(Some(Duration::from_secs(6)))
        .timeout_recv_response(Some(Duration::from_secs(12)))
        .timeout_recv_body(Some(Duration::from_secs(12)))
        .max_redirects(0)
        .build()
        .into()
}

fn news_feed_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .timeout_connect(Some(Duration::from_secs(4)))
        .timeout_recv_response(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .timeout_recv_body(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .build()
        .into()
}

/// User supplied feeds must not follow redirects: a public HTTPS URL may
/// otherwise redirect to an unvalidated scheme or local target.
fn custom_news_feed_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .timeout_connect(Some(Duration::from_secs(4)))
        .timeout_recv_response(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .timeout_recv_body(Some(NEWS_FEED_SOURCE_TIMEOUT))
        .max_redirects(0)
        .build()
        .into()
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
        fetch_prefetched_image_data_url(&url, &image_url).unwrap_or_default()
    };
    Ok(NewsNowPreview {
        image_url,
        image_data_url,
    })
}

fn remember_preview_attempt(url: &str, image_data_url: &str) {
    ensure_disk_cache_loaded();
    let Ok(mut cached) = cache().lock() else {
        return;
    };
    let Some(item) = cached.items.iter_mut().find(|item| item.url == url) else {
        return;
    };
    item.preview_attempted = true;
    if !image_data_url.is_empty() {
        item.preview_data_url = image_data_url.to_string();
    }
}

#[cfg(test)]
fn selected_sources(request: Option<NewsNowRequest>) -> Vec<NewsSource> {
    let requested = request.unwrap_or_default().source_ids;
    if requested.is_empty() {
        return all_sources()
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
            all_sources().find(|source| source.id == id)
        })
        .take(MAX_SELECTED_SOURCES)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        all_sources()
            .filter(|source| source.default_enabled)
            .collect()
    } else {
        selected
    }
}

fn normalized_custom_sources(request: Option<&NewsNowRequest>) -> Vec<CustomNewsSource> {
    let mut ids = HashSet::new();
    let mut hosts = HashSet::new();
    request
        .map(|request| request.custom_sources.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|source| {
            let id = source.id.trim();
            let name = source.name.trim();
            let category = source.category.trim();
            if id.is_empty()
                || name.is_empty()
                || id.len() > MAX_CUSTOM_SOURCE_NAME_CHARS
                || name.chars().count() > MAX_CUSTOM_SOURCE_NAME_CHARS
                || category.chars().count() > MAX_CUSTOM_SOURCE_CATEGORY_CHARS
                || source.url.len() > MAX_CUSTOM_SOURCE_URL_BYTES
                || id
                    .chars()
                    .any(|character| !matches!(character, 'a'..='z' | '0'..='9' | '-' | '_'))
                || name.chars().any(char::is_control)
                || category.chars().any(char::is_control)
                || !ids.insert(id.to_string())
            {
                return None;
            }
            let url = validate_custom_feed_url(&source.url)?;
            let host = tauri::Url::parse(&url)
                .ok()?
                .host_str()?
                .to_ascii_lowercase();
            if !hosts.insert(host) {
                return None;
            }
            Some(CustomNewsSource {
                id: format!("custom:{id}"),
                name: name.to_string(),
                url,
                category: if category.is_empty() {
                    "自定义".to_string()
                } else {
                    category.to_string()
                },
            })
        })
        .take(MAX_CUSTOM_SOURCES)
        .collect()
}

fn normalized_custom_source_requests(
    sources: &[NewsNowCustomSourceRequest],
) -> Vec<NewsNowCustomSourceRequest> {
    let request = NewsNowRequest {
        custom_sources: sources.to_vec(),
        ..Default::default()
    };
    normalized_custom_sources(Some(&request))
        .into_iter()
        .filter_map(|source| {
            Some(NewsNowCustomSourceRequest {
                id: source.id.strip_prefix("custom:")?.to_string(),
                name: source.name,
                url: source.url,
                category: source.category,
            })
        })
        .collect()
}

fn stored_custom_subscriptions(db: &crate::db::AppDb) -> Vec<NewsNowCustomSourceRequest> {
    db.metadata(CUSTOM_SUBSCRIPTIONS_METADATA_KEY)
        .and_then(|value| serde_json::from_str::<Vec<NewsNowCustomSourceRequest>>(&value).ok())
        .map(|sources| normalized_custom_source_requests(&sources))
        .unwrap_or_default()
}

/// Materialize only after the user has explicitly opted into subscription
/// sync.  The resulting envelope contains feed definitions, never fetched
/// articles, cache entries, source-health results or browser history.
pub(crate) fn append_custom_subscriptions_sync_entity(
    db: &mut crate::db::AppDb,
) -> Result<(), String> {
    let sources = stored_custom_subscriptions(db);
    db.upsert_json_batch(&[(
        crate::private_sync::NEWS_SUBSCRIPTIONS_KIND.to_string(),
        "default".to_string(),
        serde_json::json!({ "version": 1, "sources": sources }),
    )])
}

pub(crate) fn apply_downloaded_custom_subscriptions(
    db: &crate::db::AppDb,
    payload: &Value,
) -> Result<(), String> {
    let sources = payload
        .get("sources")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<NewsNowCustomSourceRequest>>(value).ok())
        .unwrap_or_default();
    let normalized = normalized_custom_source_requests(&sources);
    db.set_metadata(
        CUSTOM_SUBSCRIPTIONS_METADATA_KEY,
        &serde_json::to_string(&normalized).map_err(|error| error.to_string())?,
    )
}

fn validate_custom_feed_url(value: &str) -> Option<String> {
    let value = url_open::validate_https_url(value).ok()?;
    let mut url = tauri::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port(), None | Some(443))
    {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return None;
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_feed_ip(address) {
            return None;
        }
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn is_public_feed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_unspecified()
                || address.is_multicast())
        }
        IpAddr::V6(address) => {
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_unicast_link_local()
                || address.is_unique_local())
        }
    }
}

fn selected_feed_sources(request: Option<&NewsNowRequest>) -> Vec<SelectedNewsSource> {
    let requested = request
        .map(|request| request.source_ids.as_slice())
        .unwrap_or_default();
    let custom_sources = normalized_custom_sources(request);
    if requested.is_empty() {
        return all_sources()
            .filter(|source| source.default_enabled)
            .map(SelectedNewsSource::Builtin)
            .collect();
    }

    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for requested_id in requested {
        let requested_id = requested_id.trim();
        if requested_id.is_empty() || !seen.insert(requested_id.to_string()) {
            continue;
        }
        if let Some(source) = all_sources().find(|source| source.id == requested_id) {
            selected.push(SelectedNewsSource::Builtin(source));
        } else {
            let custom_id = requested_id.strip_prefix("custom:").unwrap_or(requested_id);
            if let Some(source) = custom_sources
                .iter()
                .find(|source| source.id == format!("custom:{custom_id}"))
            {
                selected.push(SelectedNewsSource::Custom(source.clone()));
            }
        }
        if selected.len() >= MAX_SELECTED_SOURCES {
            break;
        }
    }
    if selected.is_empty() {
        all_sources()
            .filter(|source| source.default_enabled)
            .map(SelectedNewsSource::Builtin)
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

fn selected_feed_ids(sources: &[SelectedNewsSource], tieba_bars: &[String]) -> Vec<String> {
    let mut ids = sources
        .iter()
        .map(|source| source.id().to_string())
        .collect::<Vec<_>>();
    if sources.iter().any(SelectedNewsSource::is_tieba) {
        ids.extend(tieba_bars.iter().map(|bar| format!("tieba:{bar}")));
    }
    ids
}

fn cached_news(
    source_ids: &[String],
    source_count: usize,
    include_stale: bool,
) -> Option<NewsNowList> {
    ensure_disk_cache_loaded();
    let cached = cache().lock().ok()?;
    if cached.source_ids.as_slice() != source_ids || cached.items.is_empty() {
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
        source_count,
        stale,
        // 缓存是否过期只用于决定后台刷新，不在资讯页显示过程提示。
        message: String::new(),
        ..Default::default()
    })
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

fn direct_news_item_for_source(
    source: NewsSourceMeta<'_>,
    remote_id: String,
    title: String,
    url: String,
    summary: String,
    published_at: String,
    image_url: String,
) -> Option<NewsNowItem> {
    let title = trim_chars(&title, MAX_TEXT_CHARS);
    let url = url_open::validate_https_url(url.trim()).ok()?.to_string();
    if title.is_empty() {
        return None;
    }
    let remote_id = trim_chars(&remote_id, 240);
    Some(NewsNowItem {
        id: if remote_id.is_empty() {
            format!("{}:{url}", source.id)
        } else {
            format!("{}:{remote_id}", source.id)
        },
        title,
        url,
        source: source.name.to_string(),
        source_id: source.id.to_string(),
        source_color: source.color.to_string(),
        summary: trim_chars(&summary, MAX_TEXT_CHARS),
        published_at,
        image_url: url_open::validate_https_url(image_url.trim())
            .map(|safe| safe.to_string())
            .unwrap_or_default(),
        preview_data_url: String::new(),
        preview_attempted: false,
        category: source.category.to_string(),
    })
}

fn direct_news_item(
    source: NewsSource,
    remote_id: String,
    title: String,
    url: String,
    summary: String,
    published_at: String,
    image_url: String,
) -> Option<NewsNowItem> {
    direct_news_item_for_source(
        source.into(),
        remote_id,
        title,
        url,
        summary,
        published_at,
        image_url,
    )
}

fn timestamp_millis_to_rfc3339(value: Option<i64>) -> String {
    value
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

fn feed_timestamp_to_rfc3339(value: &str) -> String {
    chrono::DateTime::parse_from_rfc2822(value)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(value))
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|_| trim_chars(value, 80))
}

fn parse_worldmonitor_usgs(source: NewsSource, response: Value) -> Vec<NewsNowItem> {
    response
        .get("features")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|feature| {
            let properties = feature.get("properties")?;
            let magnitude = properties
                .get("mag")
                .and_then(Value::as_f64)
                .map(|value| format!("M {value:.1}"))
                .unwrap_or_else(|| "地震".to_string());
            let place = value_to_text(properties.get("place"));
            let alert = value_to_text(properties.get("alert"));
            let mut summary = if place.is_empty() {
                magnitude
            } else {
                format!("{magnitude} · {place}")
            };
            if !alert.is_empty() {
                summary.push_str(&format!(" · USGS {alert} 预警"));
            }
            direct_news_item(
                source,
                value_to_text(feature.get("id")),
                value_to_text(properties.get("title")),
                https_text(properties.get("url")),
                summary,
                timestamp_millis_to_rfc3339(properties.get("time").and_then(Value::as_i64)),
                String::new(),
            )
        })
        .take(DIRECT_SOURCE_MAX_ITEMS)
        .collect()
}

fn parse_worldmonitor_eonet(source: NewsSource, response: Value) -> Vec<NewsNowItem> {
    response
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|event| {
            let categories = event
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|category| value_to_text(category.get("title")))
                .filter(|title| !title.is_empty())
                .collect::<Vec<_>>();
            let source_url = event
                .get("sources")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|item| https_text(item.get("url")))
                .find(|url| !url.is_empty())
                .unwrap_or_else(|| https_text(event.get("link")));
            let published_at = event
                .get("geometry")
                .and_then(Value::as_array)
                .and_then(|items| items.last())
                .map(|geometry| value_to_text(geometry.get("date")))
                .map(|date| feed_timestamp_to_rfc3339(&date))
                .unwrap_or_default();
            direct_news_item(
                source,
                value_to_text(event.get("id")),
                value_to_text(event.get("title")),
                source_url,
                if categories.is_empty() {
                    "NASA EONET 正在跟踪的自然事件。".to_string()
                } else {
                    format!("NASA EONET · {}", categories.join("、"))
                },
                published_at,
                String::new(),
            )
        })
        .take(DIRECT_SOURCE_MAX_ITEMS)
        .collect()
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

fn tomsguide_article_url(value: &str) -> Option<String> {
    let url = tauri::Url::parse(value.trim()).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.tomsguide.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    let mut url = url;
    url.set_fragment(None);
    Some(url.to_string())
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn push_xml_text(target: &mut String, value: &str) {
    if !target.is_empty() && !target.ends_with(char::is_whitespace) {
        target.push(' ');
    }
    target.push_str(value);
}

fn finish_tomsguide_entry(
    source: NewsSource,
    entry: &mut TomsGuideRssEntry,
) -> Option<NewsNowItem> {
    let url = tomsguide_article_url(&entry.url)?;
    let title = trim_chars(&html_text(&entry.title), MAX_TEXT_CHARS);
    if title.is_empty() {
        return None;
    }
    let summary = trim_chars(&html_text(&entry.summary), MAX_TEXT_CHARS);
    let image_url = if entry
        .image_url
        .starts_with("https://cdn.mos.cms.futurecdn.net/")
    {
        entry.image_url.clone()
    } else {
        preview_image_from_html(&entry.content_html, &url)
    };
    let guid = trim_chars(&html_text(&entry.guid), 180);
    Some(NewsNowItem {
        id: if guid.is_empty() {
            format!("{}:{url}", source.id)
        } else {
            format!("{}:{guid}", source.id)
        },
        title,
        url,
        source: source.name.to_string(),
        source_id: source.id.to_string(),
        source_color: source.color.to_string(),
        summary,
        published_at: chrono::DateTime::parse_from_rfc2822(&html_text(&entry.published_at))
            .map(|date| date.to_rfc3339())
            .unwrap_or_default(),
        image_url,
        preview_data_url: String::new(),
        preview_attempted: false,
        category: source.category.to_string(),
    })
}

fn parse_tomsguide_rss(source: NewsSource, xml: &str) -> Vec<NewsNowItem> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut entry = None::<TomsGuideRssEntry>;
    let mut fields = Vec::<Vec<u8>>::new();
    let mut items = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if local == b"item" {
                    entry = Some(TomsGuideRssEntry::default());
                    fields.clear();
                } else if entry.is_some() {
                    fields.push(local.to_vec());
                    if matches!(local, b"enclosure" | b"thumbnail" | b"content") {
                        for attribute in tag.attributes().flatten() {
                            if xml_local_name(attribute.key.as_ref()) != b"url" {
                                continue;
                            }
                            if let Ok(value) = attribute.decoded_and_normalized_value(
                                XmlVersion::default(),
                                reader.decoder(),
                            ) {
                                if value.starts_with("https://cdn.mos.cms.futurecdn.net/") {
                                    entry.as_mut().unwrap().image_url = value.into_owned();
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(tag)) if entry.is_some() => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if matches!(local, b"enclosure" | b"thumbnail" | b"content") {
                    for attribute in tag.attributes().flatten() {
                        if xml_local_name(attribute.key.as_ref()) != b"url" {
                            continue;
                        }
                        if let Ok(value) = attribute
                            .decoded_and_normalized_value(XmlVersion::default(), reader.decoder())
                        {
                            if value.starts_with("https://cdn.mos.cms.futurecdn.net/") {
                                entry.as_mut().unwrap().image_url = value.into_owned();
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(text)) if entry.is_some() => {
                if let Ok(value) = text.decode() {
                    let entry = entry.as_mut().unwrap();
                    match fields.last().map(Vec::as_slice).unwrap_or_default() {
                        b"title" => push_xml_text(&mut entry.title, &value),
                        b"link" => push_xml_text(&mut entry.url, &value),
                        b"description" => push_xml_text(&mut entry.summary, &value),
                        b"guid" => push_xml_text(&mut entry.guid, &value),
                        b"pubDate" => push_xml_text(&mut entry.published_at, &value),
                        b"encoded" => push_xml_text(&mut entry.content_html, &value),
                        _ => {}
                    }
                }
            }
            Ok(Event::CData(text)) if entry.is_some() => {
                if let Ok(value) = text.decode() {
                    let entry = entry.as_mut().unwrap();
                    match fields.last().map(Vec::as_slice).unwrap_or_default() {
                        b"title" => push_xml_text(&mut entry.title, &value),
                        b"link" => push_xml_text(&mut entry.url, &value),
                        b"description" => push_xml_text(&mut entry.summary, &value),
                        b"guid" => push_xml_text(&mut entry.guid, &value),
                        b"pubDate" => push_xml_text(&mut entry.published_at, &value),
                        b"encoded" => push_xml_text(&mut entry.content_html, &value),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(tag)) => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if local == b"item" {
                    if let Some(mut finished) = entry.take() {
                        if let Some(item) = finish_tomsguide_entry(source, &mut finished) {
                            items.push(item);
                            if items.len() >= TOMSGUIDE_MAX_ITEMS {
                                break;
                            }
                        }
                    }
                    fields.clear();
                } else if entry.is_some() {
                    fields.pop();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return Vec::new(),
            _ => {}
        }
    }
    items
}

#[derive(Default)]
struct PublicRssEntry {
    title: String,
    url: String,
    summary: String,
    guid: String,
    published_at: String,
    image_url: String,
}

fn finish_public_rss_entry(
    source: NewsSourceMeta<'_>,
    entry: &mut PublicRssEntry,
) -> Option<NewsNowItem> {
    direct_news_item_for_source(
        source,
        html_text(&entry.guid).or_else_if_empty(|| entry.url.clone()),
        html_text(&entry.title),
        entry.url.clone(),
        html_text(&entry.summary),
        feed_timestamp_to_rfc3339(&html_text(&entry.published_at)),
        entry.image_url.clone(),
    )
}

fn feed_attribute_article_url(
    attributes: quick_xml::events::attributes::Attributes<'_>,
    reader: &Reader<&[u8]>,
) -> Option<String> {
    let mut href = None::<String>;
    let mut relation = String::new();
    let mut media_type = String::new();
    for attribute in attributes.flatten() {
        let key = xml_local_name(attribute.key.as_ref());
        if !matches!(key, b"href" | b"rel" | b"type") {
            continue;
        }
        let Ok(value) =
            attribute.decoded_and_normalized_value(XmlVersion::default(), reader.decoder())
        else {
            continue;
        };
        match key {
            b"href" => href = Some(value.into_owned()),
            b"rel" => relation = value.into_owned(),
            b"type" => media_type = value.into_owned(),
            _ => {}
        }
    }

    // Atom defaults an omitted relation to `alternate`.  Links such as
    // `self` and WordPress' two `replies` entries are feed metadata, not the
    // article.  In particular, the final replies link often ends in `/feed/`
    // and previously overwrote the real HTML article URL parsed just before it.
    let relation = relation.trim().to_ascii_lowercase();
    if !relation.is_empty() && relation != "alternate" {
        return None;
    }
    let media_type = media_type.trim().to_ascii_lowercase();
    if !media_type.is_empty() && media_type != "text/html" && media_type != "application/xhtml+xml"
    {
        return None;
    }
    let href = href?;
    url_open::validate_https_url(&href).ok().map(str::to_string)
}

fn parse_public_rss_for_source(source: NewsSourceMeta<'_>, xml: &str) -> Vec<NewsNowItem> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut entry = None::<PublicRssEntry>;
    let mut fields = Vec::<Vec<u8>>::new();
    let mut items = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if matches!(local, b"item" | b"entry") {
                    entry = Some(PublicRssEntry::default());
                    fields.clear();
                } else if entry.is_some() {
                    fields.push(local.to_vec());
                    if local == b"link" {
                        if let Some(url) = feed_attribute_article_url(tag.attributes(), &reader) {
                            entry.as_mut().unwrap().url = url;
                        }
                    }
                    if matches!(local, b"enclosure" | b"thumbnail" | b"content") {
                        for attribute in tag.attributes().flatten() {
                            if xml_local_name(attribute.key.as_ref()) != b"url" {
                                continue;
                            }
                            if let Ok(value) = attribute.decoded_and_normalized_value(
                                XmlVersion::default(),
                                reader.decoder(),
                            ) {
                                let url = value.into_owned();
                                if url_open::validate_https_url(&url).is_ok() {
                                    entry.as_mut().unwrap().image_url = url;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(tag)) if entry.is_some() => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if local == b"link" {
                    if let Some(url) = feed_attribute_article_url(tag.attributes(), &reader) {
                        entry.as_mut().unwrap().url = url;
                    }
                }
                if matches!(local, b"enclosure" | b"thumbnail" | b"content") {
                    for attribute in tag.attributes().flatten() {
                        if xml_local_name(attribute.key.as_ref()) != b"url" {
                            continue;
                        }
                        if let Ok(value) = attribute
                            .decoded_and_normalized_value(XmlVersion::default(), reader.decoder())
                        {
                            let url = value.into_owned();
                            if url_open::validate_https_url(&url).is_ok() {
                                entry.as_mut().unwrap().image_url = url;
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(text)) if entry.is_some() => {
                if let Ok(value) = text.decode() {
                    let entry = entry.as_mut().unwrap();
                    match fields.last().map(Vec::as_slice).unwrap_or_default() {
                        b"title" => push_xml_text(&mut entry.title, &value),
                        b"link" => push_xml_text(&mut entry.url, &value),
                        b"description" | b"summary" | b"content" => {
                            push_xml_text(&mut entry.summary, &value)
                        }
                        b"guid" | b"id" => push_xml_text(&mut entry.guid, &value),
                        b"pubDate" | b"dateadded" | b"updated" | b"published" => {
                            push_xml_text(&mut entry.published_at, &value)
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::CData(text)) if entry.is_some() => {
                if let Ok(value) = text.decode() {
                    let entry = entry.as_mut().unwrap();
                    match fields.last().map(Vec::as_slice).unwrap_or_default() {
                        b"title" => push_xml_text(&mut entry.title, &value),
                        b"link" => push_xml_text(&mut entry.url, &value),
                        b"description" | b"summary" | b"content" => {
                            push_xml_text(&mut entry.summary, &value)
                        }
                        b"guid" | b"id" => push_xml_text(&mut entry.guid, &value),
                        b"pubDate" | b"dateadded" | b"updated" | b"published" => {
                            push_xml_text(&mut entry.published_at, &value)
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(tag)) => {
                let name = tag.name();
                let local = xml_local_name(name.as_ref());
                if matches!(local, b"item" | b"entry") {
                    if let Some(mut finished) = entry.take() {
                        if let Some(item) = finish_public_rss_entry(source, &mut finished) {
                            items.push(item);
                            if items.len() >= DIRECT_SOURCE_MAX_ITEMS {
                                break;
                            }
                        }
                    }
                    fields.clear();
                } else if entry.is_some() {
                    fields.pop();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return Vec::new(),
            _ => {}
        }
    }
    items
}

#[cfg(test)]
fn parse_public_rss(source: NewsSource, xml: &str) -> Vec<NewsNowItem> {
    parse_public_rss_for_source(source.into(), xml)
}

fn read_direct_response(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(DIRECT_SOURCE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取公开资讯来源".to_string())?;
    if bytes.len() as u64 > DIRECT_SOURCE_MAX_BYTES {
        return Err("公开资讯来源响应过大".to_string());
    }
    Ok(bytes)
}

fn fetch_public_rss_for_source(
    agent: &ureq::Agent,
    source: NewsSourceMeta<'_>,
    url: &str,
) -> Result<Vec<NewsNowItem>, String> {
    let mut response = agent
        .get(url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "application/rss+xml,application/xml,text/xml")
        .call()
        .map_err(|_| source.name.to_string())?;
    let bytes = read_direct_response(&mut response).map_err(|_| source.name.to_string())?;
    let items = parse_public_rss_for_source(source, &String::from_utf8_lossy(&bytes));
    if items.is_empty() {
        Err(source.name.to_string())
    } else {
        Ok(items)
    }
}

fn fetch_public_rss_source(
    agent: &ureq::Agent,
    source: NewsSource,
    url: &str,
) -> Result<Vec<NewsNowItem>, String> {
    fetch_public_rss_for_source(agent, source.into(), url)
}

fn fetch_custom_rss_source(source: &CustomNewsSource) -> Result<Vec<NewsNowItem>, String> {
    fetch_public_rss_for_source(&custom_news_feed_agent(), source.into(), &source.url)
}

fn fetch_direct_json_source(
    agent: &ureq::Agent,
    source: NewsSource,
    url: &str,
    parser: fn(NewsSource, Value) -> Vec<NewsNowItem>,
) -> Result<Vec<NewsNowItem>, String> {
    let mut response = agent
        .get(url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "application/json,text/plain,*/*")
        .call()
        .map_err(|_| source.name.to_string())?;
    let bytes = read_direct_response(&mut response).map_err(|_| source.name.to_string())?;
    let value = serde_json::from_slice::<Value>(&bytes).map_err(|_| source.name.to_string())?;
    let items = parser(source, value);
    if items.is_empty() {
        Err(source.name.to_string())
    } else {
        Ok(items)
    }
}

fn fetch_horizon_or_worldmonitor_source(
    agent: &ureq::Agent,
    source: NewsSource,
) -> Result<Vec<NewsNowItem>, String> {
    if let Some(public_feed) = find_worldmonitor_public_rss_source(source) {
        return fetch_public_rss_source(agent, source, public_feed.url);
    }
    match source.id {
        "horizon-reliefweb-updates" => {
            fetch_public_rss_source(agent, source, HORIZON_RELIEFWEB_RSS_URL)
        }
        "horizon-cisa-advisories" => fetch_public_rss_source(agent, source, HORIZON_CISA_RSS_URL),
        "horizon-simon-willison" => {
            fetch_public_rss_source(agent, source, HORIZON_SIMON_WILLISON_ATOM_URL)
        }
        "horizon-vllm-blog" => fetch_public_rss_source(agent, source, HORIZON_VLLM_RSS_URL),
        "horizon-cnbc-finance" => {
            fetch_public_rss_source(agent, source, HORIZON_CNBC_FINANCE_RSS_URL)
        }
        "horizon-nvidia-cuda" => {
            fetch_public_rss_source(agent, source, HORIZON_NVIDIA_CUDA_RSS_URL)
        }
        "worldmonitor-usgs-earthquakes" => fetch_direct_json_source(
            agent,
            source,
            WORLDMONITOR_USGS_URL,
            parse_worldmonitor_usgs,
        ),
        "worldmonitor-nasa-eonet" => fetch_direct_json_source(
            agent,
            source,
            WORLDMONITOR_EONET_URL,
            parse_worldmonitor_eonet,
        ),
        "worldmonitor-gdacs-alerts" => {
            fetch_public_rss_source(agent, source, WORLDMONITOR_GDACS_RSS_URL)
        }
        _ => Err(source.name.to_string()),
    }
}

fn fetch_tomsguide_source(
    agent: &ureq::Agent,
    source: NewsSource,
) -> Result<Vec<NewsNowItem>, String> {
    let mut response = agent
        .get(TOMSGUIDE_RSS_URL)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "application/rss+xml,application/xml,text/xml")
        .call()
        .map_err(|_| source.name.to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(TOMSGUIDE_RSS_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| source.name.to_string())?;
    if bytes.len() as u64 > TOMSGUIDE_RSS_MAX_BYTES {
        return Err(source.name.to_string());
    }
    let items = parse_tomsguide_rss(source, &String::from_utf8_lossy(&bytes));
    if items.is_empty() {
        Err(source.name.to_string())
    } else {
        Ok(items)
    }
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
    if matches!(source_provider(source), "horizon" | "worldmonitor") {
        return fetch_horizon_or_worldmonitor_source(agent, source);
    }
    if source.id == "tomsguide" {
        return fetch_tomsguide_source(agent, source);
    }
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

fn fetch_selected_source(
    agent: &ureq::Agent,
    base: &str,
    source: &SelectedNewsSource,
    latest: bool,
    tieba_bars: &[String],
) -> Result<Vec<NewsNowItem>, String> {
    match source {
        SelectedNewsSource::Builtin(source) => {
            fetch_source(agent, base, *source, latest, tieba_bars)
        }
        SelectedNewsSource::Custom(source) => fetch_custom_rss_source(source),
    }
}

fn source_uses_newsnow_gateway(source: NewsSource) -> bool {
    source_provider(source) == "reader"
        && !matches!(
            source.id,
            "tomsguide" | "3dm-news" | "gamersky-news" | "tieba"
        )
}

fn sort_and_deduplicate(items: &mut Vec<NewsNowItem>, preserve_evidence: bool) {
    if !preserve_evidence {
        let mut urls = HashSet::new();
        items.retain(|item| urls.insert(item.url.clone()));
    }
    items.sort_by(|left, right| {
        right
            .published_at
            .cmp(&left.published_at)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.title.cmp(&right.title))
    });
}

fn fetch_news(request: Option<NewsNowRequest>, force_refresh: bool) -> NewsNowList {
    let preserve_evidence = request
        .as_ref()
        .is_some_and(|request| request.preserve_evidence);
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    let sources = selected_feed_sources(request.as_ref());
    let source_ids = selected_feed_ids(&sources, &tieba_bars);
    // Custom URLs are local user configuration.  Keep them out of both the
    // in-memory and disk cache keys so a local feed address is never persisted
    // as news cache metadata.  Built-in selections retain the normal cache.
    let cacheable = sources
        .iter()
        .all(|source| matches!(source, SelectedNewsSource::Builtin(_)));
    ensure_disk_cache_loaded();
    if cacheable && !force_refresh {
        if let Some(cached) = cached_news(&source_ids, sources.len(), false) {
            return cached;
        }
    }

    // Direct public Horizon/WorldMonitor sources must remain usable even when
    // the optional NewsNow gateway has not been configured.  Gateway-backed
    // Reader sources fail independently below instead of blocking the whole
    // selection.
    let base = base_url().unwrap_or_default();
    let mut items = Vec::new();
    let mut failed_sources = Vec::new();
    // 刷新最多保留十二路网络请求。来源可多选，但不会在一个客户端上同时打满 24 个上游。
    for batch in sources.chunks(MAX_REFRESH_CONCURRENCY) {
        let threads = batch
            .iter()
            .map(|source| {
                let base = base.clone();
                let source = source.clone();
                let tieba_bars = tieba_bars.clone();
                std::thread::spawn(move || {
                    if base.is_empty() && source.is_gateway_source() {
                        return Err(source.metadata().name.to_string());
                    }
                    fetch_selected_source(
                        &news_feed_agent(),
                        &base,
                        &source,
                        force_refresh,
                        &tieba_bars,
                    )
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
    sort_and_deduplicate(&mut items, preserve_evidence);
    // 刷新资讯文本时复用同一篇文章已经压缩好的封面，避免每五分钟重新下载。
    // 普通后台刷新也保留“已尝试但无图”的状态，让下一批继续向后推进；
    // 用户主动刷新时则允许这些失败项重试，以恢复临时网络或站点错误。
    reuse_cached_preview_state(&source_ids, &mut items, !force_refresh);

    if cacheable && items.is_empty() {
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
    if cacheable && !items.is_empty() {
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

fn parse_tomsguide_article(html: &str, url: &str) -> Result<NewsNowArticle, String> {
    let title = element_with_class(html, "h1", "")
        .map(|(_, content)| trim_chars(&html_text(content), 240))
        .filter(|title| !title.is_empty())
        .ok_or_else(|| "Tom's Guide 文章缺少标题".to_string())?;
    let published_at = tag_with_class(html, "time", "relative-date")
        .and_then(|tag| html_attribute(tag, "datetime"))
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date.trim()).ok())
        .map(|date| date.to_rfc3339())
        .unwrap_or_default();
    let body = balanced_element_with_class(html, "div", "text-copy")
        .map(|(_, content)| content)
        .ok_or_else(|| "Tom's Guide 文章缺少正文".to_string())?;
    let content_html = crate::html_sanitize::sanitize_book_html(body);
    if content_html.trim().is_empty() {
        return Err("Tom's Guide 文章正文为空".to_string());
    }
    Ok(NewsNowArticle {
        local: true,
        title,
        source: "Tom's Guide".to_string(),
        published_at,
        content_html,
        url: url.to_string(),
    })
}

fn fetch_tomsguide_article(url: &str) -> Result<NewsNowArticle, String> {
    let mut response = http_agent()
        .get(url)
        .header("User-Agent", NEWSNOW_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|_| "无法请求 Tom's Guide 文章".to_string())?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(TOMSGUIDE_ARTICLE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 Tom's Guide 文章".to_string())?;
    if bytes.len() as u64 > TOMSGUIDE_ARTICLE_MAX_BYTES {
        return Err("Tom's Guide 文章内容过大".to_string());
    }
    parse_tomsguide_article(&String::from_utf8_lossy(&bytes), url)
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
    let sources = selected_feed_sources(request.as_ref());
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    let source_ids = selected_feed_ids(&sources, &tieba_bars);
    let cacheable = sources
        .iter()
        .all(|source| matches!(source, SelectedNewsSource::Builtin(_)));
    let mut result = fetch_news(request, force_refresh);
    if result.items.is_empty() {
        return result;
    }
    prefetch_preview_images(&mut result.items);
    if cacheable {
        if let Ok(mut cache) = cache().lock() {
            cache.source_ids = source_ids.clone();
            cache.fetched_at = result.fetched_at;
            cache.fetched_instant = Some(Instant::now());
            cache.items = result.items.clone();
        }
        save_disk_cache(&source_ids, result.fetched_at, &result.items);
    }
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
    all_sources().map(NewsNowSource::from).collect()
}

/// The intelligence workspace is a local, transient research cache.  It is
/// deliberately separate from the reader database, search index, backup and
/// sync payload so a large public-source collection can resume after restart
/// without turning news history into reader data.
#[tauri::command]
pub(crate) fn newsnow_intelligence_snapshot_get() -> Option<Value> {
    let path = intelligence_snapshot_path()?;
    let bytes = fs::read(path).ok()?;
    let snapshot = serde_json::from_slice::<Value>(&bytes).ok()?;
    valid_intelligence_snapshot(&snapshot).then_some(snapshot)
}

#[tauri::command]
pub(crate) fn newsnow_intelligence_snapshot_save(snapshot: Value) -> Result<(), String> {
    if !valid_intelligence_snapshot(&snapshot) {
        return Err("情报快照格式或大小无效".to_string());
    }
    let path = intelligence_snapshot_path().ok_or_else(|| "无法定位情报快照目录".to_string())?;
    crate::atomic_file::write_json(&path, &snapshot, false)
        .map_err(|error| format!("无法保存情报快照：{error}"))
}

/// Fetch and locally cache cleaned public evidence for the source articles
/// selected by an intelligence brief. This deliberately returns per-source
/// fallbacks instead of failing the entire batch when one publisher blocks a
/// request or exposes no readable HTML.
#[tauri::command]
pub(crate) async fn newsnow_intelligence_enrich_articles(
    request: NewsNowIntelligenceEnrichmentRequest,
) -> Result<Vec<NewsNowIntelligenceArticleEnrichment>, String> {
    if request.articles.len() > INTELLIGENCE_ENRICHMENT_MAX_ARTICLES {
        return Err(format!(
            "单次最多增强 {INTELLIGENCE_ENRICHMENT_MAX_ARTICLES} 条资讯来源"
        ));
    }
    tokio::task::spawn_blocking(move || {
        Ok(request
            .articles
            .into_iter()
            .map(fetch_intelligence_article_enrichment)
            .collect())
    })
    .await
    .map_err(|error| format!("资讯正文增强任务失败：{error}"))?
}

#[tauri::command]
pub(crate) fn newsnow_custom_sources_get(
    state: tauri::State<crate::AppState>,
) -> Result<Vec<NewsNowCustomSourceRequest>, String> {
    state.with_db_read("newsnow_custom_sources_get", |db| {
        Ok(stored_custom_subscriptions(db))
    })
}

#[tauri::command]
pub(crate) fn newsnow_custom_sources_save(
    state: tauri::State<crate::AppState>,
    request: NewsNowCustomSubscriptionsRequest,
) -> Result<Vec<NewsNowCustomSourceRequest>, String> {
    let sources = normalized_custom_source_requests(&request.sources);
    if sources.len() != request.sources.len() {
        return Err("自定义来源包含无效或重复的 HTTPS RSS / Atom 地址".into());
    }
    state.with_db_write("newsnow_custom_sources_save", |db| {
        db.set_metadata(
            CUSTOM_SUBSCRIPTIONS_METADATA_KEY,
            &serde_json::to_string(&sources).map_err(|error| error.to_string())?,
        )?;
        if crate::private_sync::is_entity_enabled(db, crate::private_sync::NEWS_SUBSCRIPTIONS_KIND)
        {
            append_custom_subscriptions_sync_entity(db)?;
        }
        Ok(sources)
    })
}

#[tauri::command]
pub(crate) async fn newsnow_list(request: Option<NewsNowRequest>) -> NewsNowList {
    let sources = selected_feed_sources(request.as_ref());
    let tieba_bars = normalized_tieba_bars(request.as_ref());
    let source_ids = selected_feed_ids(&sources, &tieba_bars);
    if sources
        .iter()
        .all(|source| matches!(source, SelectedNewsSource::Builtin(_)))
    {
        if let Some(cached) = cached_news(&source_ids, sources.len(), true) {
            return cached;
        }
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
    tokio::task::spawn_blocking(move || {
        let url = request.url.clone();
        let result = fetch_preview_image(request);
        remember_preview_attempt(
            &url,
            result
                .as_ref()
                .map(|preview| preview.image_data_url.as_str())
                .unwrap_or_default(),
        );
        result
    })
    .await
    .map_err(|error| format!("资讯缩略图任务失败：{error}"))?
}

fn canonical_news_article_url(value: &str) -> Result<String, String> {
    let url = url_open::validate_https_url(value.trim())?.to_string();
    const NVIDIA_BLOG_PREFIX: &str = "https://developer.nvidia.com/blog/";
    if let Some(article_slug) = url
        .strip_prefix(NVIDIA_BLOG_PREFIX)
        .and_then(|path| path.strip_suffix("/feed/"))
    {
        // Only repair the single-slug WordPress comment feed emitted inside
        // an entry.  Do not rewrite the blog feed or tag/category feeds.
        if !article_slug.is_empty() && !article_slug.contains('/') {
            return Ok(format!("{NVIDIA_BLOG_PREFIX}{article_slug}/"));
        }
    }
    Ok(url)
}

fn ensure_article_webview(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview(ARTICLE_WEBVIEW_LABEL).is_some() {
        return Ok(());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let parent = main.as_ref().window();
    let navigation_app = app.clone();
    let loading_app = app.clone();
    let page_load_state = Arc::clone(&ARTICLE_WEBVIEW_STATE);
    let article_webview = parent
        .add_child(
            WebviewBuilder::new(
                ARTICLE_WEBVIEW_LABEL,
                WebviewUrl::App("newsnow-article-shell.html".into()),
            )
            .auto_resize()
            .on_page_load(move |webview, payload| {
                // The hidden local shell also emits page-load events. Only
                // publish events for an article navigation requested by the
                // visible reader surface.
                if page_load_state.load(Ordering::Acquire) == ARTICLE_WEBVIEW_IDLE {
                    let _ = webview.hide();
                    return;
                }
                match article_webview_phase(payload.event()) {
                    ArticleWebviewPhase::Loading => {
                        if let Ok(script) = ARTICLE_WEBVIEW_INITIALIZATION_SCRIPT.lock() {
                            if !script.is_empty() {
                                let _ = webview.eval(script.clone());
                            }
                        }
                        page_load_state.store(ARTICLE_WEBVIEW_LOADING, Ordering::Release);
                        // Keep the native child hidden until its first usable
                        // document is ready. The main reader already exposes a
                        // returnable loading shell synchronously on click;
                        // showing this child here would either flash the prior
                        // article or cover that shell with WebView2's blank
                        // first paint.
                        let _ = webview.hide();
                        let _ = loading_app.emit(ARTICLE_LOADING_EVENT, ());
                    }
                    ArticleWebviewPhase::Ready => {
                        page_load_state.store(ARTICLE_WEBVIEW_READY, Ordering::Release);
                        let _ = webview.show();
                        let _ = loading_app.emit(ARTICLE_READY_EVENT, ());
                    }
                }
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_navigation(move |target| {
                if target.as_str() == ARTICLE_SHELL_URL {
                    return true;
                }
                if target.as_str() != ARTICLE_RETURN_URL {
                    return target.scheme() == "https";
                }
                // The main UI owns the close transition and hides the child
                // after receiving this event. Do not enqueue a local-shell
                // navigation here: the following article click would race it
                // with its external navigation and WebView2 serializes those
                // requests, which made every second open appear to hang.
                ARTICLE_WEBVIEW_STATE.store(ARTICLE_WEBVIEW_IDLE, Ordering::Release);
                let _ = navigation_app.emit("newsnow-return-to-feed", ());
                false
            }),
            tauri::LogicalPosition::new(0, 0),
            parent
                .inner_size()
                .map_err(|error| format!("无法读取主窗口大小：{error}"))?,
        )
        .map_err(|error| format!("无法在主窗口打开资讯原文：{error}"))?;
    ARTICLE_WEBVIEW_STATE.store(ARTICLE_WEBVIEW_IDLE, Ordering::Release);
    let _ = article_webview.hide();
    Ok(())
}

#[tauri::command]
pub(crate) fn newsnow_prepare_article_shell(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview(ARTICLE_WEBVIEW_LABEL).is_some()
        || ARTICLE_WEBVIEW_PREPARE_SCHEDULED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return Ok(());
    }
    // This command is issued while the main document is still initializing.
    // Creating a child WebView synchronously from that IPC can stall WebView2's
    // first paint. Mirror the reader-shell pool: return immediately and build
    // the hidden article shell shortly after the host becomes responsive.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        let _ = ensure_article_webview(&app);
        ARTICLE_WEBVIEW_PREPARE_SCHEDULED.store(false, Ordering::Release);
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn newsnow_open_article(
    app: tauri::AppHandle,
    request: NewsNowOpenRequest,
) -> Result<NewsNowArticle, String> {
    let url = canonical_news_article_url(&request.url)?;
    if url.len() > 2_000 {
        return Err("资讯原文地址过长".to_string());
    }
    if is_sspai_article_url(&url) {
        return tokio::task::spawn_blocking(move || fetch_sspai_article(&url))
            .await
            .map_err(|error| format!("少数派文章任务失败：{error}"))?;
    }
    if tomsguide_article_url(&url).is_some() {
        let article_url = url.clone();
        let request_title = trim_chars(request.title.trim(), 240);
        let request_published_at = trim_chars(request.published_at.trim(), 80);
        if let Ok(Ok(mut article)) =
            tokio::task::spawn_blocking(move || fetch_tomsguide_article(&article_url)).await
        {
            // RSS 已提供解码后的标题和日期，优先复用列表中的值；网页标题仍作为
            // 直接打开链接时的兜底，避免 `&mdash;` 等实体泄漏到阅读界面。
            if !request_title.is_empty() {
                article.title = request_title;
            }
            if !request_published_at.is_empty() {
                article.published_at = request_published_at;
            }
            return Ok(article);
        }
        // 个别直播页或超长促销页可能不具备标准正文结构。保留与其他来源
        // 相同的内嵌原文兜底，不能因为本地清洗失败而让文章完全打不开。
    }
    if let Some(article) = restricted_source_article(&request, &url) {
        return Ok(article);
    }
    {
        let mut script = ARTICLE_WEBVIEW_INITIALIZATION_SCRIPT.lock().unwrap();
        *script = article_initialization_script(&request);
    }
    ensure_article_webview(&app)?;
    let article_url = url.parse().map_err(|_| "资讯原文地址无效".to_string())?;
    let article_webview = app
        .get_webview(ARTICLE_WEBVIEW_LABEL)
        .ok_or_else(|| "资讯预加载外壳不可用".to_string())?;
    ARTICLE_WEBVIEW_STATE.store(ARTICLE_WEBVIEW_LOADING, Ordering::Release);
    // The main reader switches to its returnable loading surface before this
    // command is awaited. Hide the reusable child so its previous page cannot
    // flash. Also stop its unfinished network/document work before submitting
    // exactly one external navigation; hiding alone leaves that work alive and
    // makes later opens wait behind the previous page in WebView2.
    let _ = article_webview.hide();
    let _ = article_webview.eval(ARTICLE_STOP_LOADING_SCRIPT);
    article_webview
        .navigate(article_url)
        .map_err(|error| format!("无法打开资讯原文：{error}"))?;
    Ok(NewsNowArticle {
        url,
        ..Default::default()
    })
}

#[tauri::command]
pub(crate) fn newsnow_close_article(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(ARTICLE_WEBVIEW_LABEL) {
        ARTICLE_WEBVIEW_STATE.store(ARTICLE_WEBVIEW_IDLE, Ordering::Release);
        // A hidden child keeps loading its current external page. Cancel it at
        // close time so the next click can use the warm WebView immediately.
        let _ = webview.eval(ARTICLE_STOP_LOADING_SCRIPT);
        webview
            .hide()
            .map_err(|error| format!("无法隐藏资讯原文：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::preview_rules::source_item_id;
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
    fn article_preload_shell_uses_only_the_local_bundled_page() {
        let url = article_shell_url().expect("bundled shell URL should parse");
        assert_eq!(url.as_str(), ARTICLE_SHELL_URL);
        assert_eq!(url.host_str(), Some("tauri.localhost"));
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.path(), "/newsnow-article-shell.html");
    }

    #[test]
    fn custom_subscription_payload_keeps_only_validated_definitions() {
        let mut db = crate::db::AppDb::open_in_memory_for_tests();
        let sources = vec![NewsNowCustomSourceRequest {
            id: "my_feed".into(),
            name: "My feed".into(),
            url: "https://example.com/feed.xml#fragment".into(),
            category: "科技".into(),
        }];
        db.set_metadata(
            CUSTOM_SUBSCRIPTIONS_METADATA_KEY,
            &serde_json::to_string(&sources).unwrap(),
        )
        .unwrap();
        append_custom_subscriptions_sync_entity(&mut db).unwrap();
        let payload = db
            .entity_json(crate::private_sync::NEWS_SUBSCRIPTIONS_KIND, "default")
            .unwrap()
            .unwrap();
        assert_eq!(payload["version"], 1);
        assert_eq!(payload["sources"][0]["url"], "https://example.com/feed.xml");
        assert!(payload.get("items").is_none());
    }

    #[test]
    fn only_aggregated_sources_need_the_newsnow_gateway() {
        let ithome = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "ithome")
            .unwrap();
        let tomsguide = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "tomsguide")
            .unwrap();
        let tieba = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "tieba")
            .unwrap();
        assert!(source_uses_newsnow_gateway(ithome));
        assert!(!source_uses_newsnow_gateway(tomsguide));
        assert!(!source_uses_newsnow_gateway(tieba));

        let horizon = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "horizon-reliefweb-updates")
            .unwrap();
        let worldmonitor = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "worldmonitor-usgs-earthquakes")
            .unwrap();
        assert!(!source_uses_newsnow_gateway(horizon));
        assert!(!source_uses_newsnow_gateway(worldmonitor));
    }

    #[test]
    fn source_catalogue_marks_real_horizon_and_worldmonitor_providers() {
        let catalogue = newsnow_sources();
        assert!(catalogue.len() >= CURATED_SOURCES.len() + 600);
        let horizon = catalogue
            .iter()
            .find(|source| source.id == "horizon-reliefweb-updates")
            .expect("Horizon ReliefWeb source should be catalogued");
        assert_eq!(horizon.provider, "horizon");
        assert_eq!(horizon.kind, "news");

        let cisa = catalogue
            .iter()
            .find(|source| source.id == "horizon-cisa-advisories")
            .expect("Horizon CISA source should be catalogued");
        assert_eq!(cisa.provider, "horizon");
        assert_eq!(cisa.kind, "advisory");

        let simon = catalogue
            .iter()
            .find(|source| source.id == "horizon-simon-willison")
            .expect("Horizon public Atom source should be catalogued");
        assert_eq!(simon.provider, "horizon");
        assert_eq!(simon.kind, "news");

        let usgs = catalogue
            .iter()
            .find(|source| source.id == "worldmonitor-usgs-earthquakes")
            .expect("WorldMonitor USGS source should be catalogued");
        assert_eq!(usgs.provider, "worldmonitor");
        assert_eq!(usgs.kind, "earthquake");

        let reader = catalogue
            .iter()
            .find(|source| source.id == "ithome")
            .expect("Reader source should remain catalogued");
        assert_eq!(reader.provider, "reader");
        assert_eq!(reader.kind, "news");

        let public_rss = catalogue
            .iter()
            .find(|source| source.id.starts_with("worldmonitor-tech-"))
            .expect("WorldMonitor direct RSS sources should be catalogued");
        assert_eq!(public_rss.provider, "worldmonitor");
        assert_eq!(public_rss.kind, "rss");
    }

    #[test]
    fn custom_rss_sources_are_bounded_safe_and_parse_atom() {
        let request = NewsNowRequest {
            source_ids: vec!["custom:example".to_string()],
            custom_sources: vec![
                NewsNowCustomSourceRequest {
                    id: "example".to_string(),
                    name: "Example Atom".to_string(),
                    url: "https://feeds.example.test/atom.xml#drop-me".to_string(),
                    category: "测试".to_string(),
                },
                // A second URL on the same host cannot cause another local
                // network target to be selected by the same request.
                NewsNowCustomSourceRequest {
                    id: "duplicate-host".to_string(),
                    name: "Duplicate".to_string(),
                    url: "https://feeds.example.test/another.xml".to_string(),
                    category: String::new(),
                },
                NewsNowCustomSourceRequest {
                    id: "local".to_string(),
                    name: "Local".to_string(),
                    url: "https://localhost/feed.xml".to_string(),
                    category: String::new(),
                },
            ],
            ..Default::default()
        };
        let selected = selected_feed_sources(Some(&request));
        assert_eq!(selected.len(), 1);
        let SelectedNewsSource::Custom(source) = &selected[0] else {
            panic!("custom source should be selected");
        };
        assert_eq!(source.id, "custom:example");
        assert_eq!(source.url, "https://feeds.example.test/atom.xml");

        let atom = r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>entry-1</id><title>Atom title</title><link href="https://example.test/articles/1"/><summary>Atom summary</summary><updated>2026-08-16T12:34:56Z</updated></entry></feed>"#;
        let items = parse_public_rss_for_source(source.into(), atom);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://example.test/articles/1");
        assert_eq!(items[0].title, "Atom title");
        assert_eq!(items[0].source_id, "custom:example");
    }

    #[test]
    fn atom_parser_keeps_the_html_alternate_instead_of_comment_feeds() {
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "horizon-nvidia-cuda")
            .unwrap();
        let items = parse_public_rss(
            source,
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry>
              <id>https://developer.nvidia.com/blog/?p=116726</id>
              <title>Accelerated X-Ray Analysis</title>
              <link rel="alternate" type="text/html" href="https://developer.nvidia.com/blog/accelerated-x-ray-analysis/" />
              <link rel="replies" type="text/html" href="https://developer.nvidia.com/blog/accelerated-x-ray-analysis/#comments" />
              <link rel="replies" type="application/atom+xml" href="https://developer.nvidia.com/blog/accelerated-x-ray-analysis/feed/" />
            </entry></feed>"#,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].url,
            "https://developer.nvidia.com/blog/accelerated-x-ray-analysis/"
        );
    }

    #[test]
    fn cached_nvidia_comment_feed_urls_open_the_article_without_recollecting() {
        assert_eq!(
            canonical_news_article_url(
                "https://developer.nvidia.com/blog/accelerated-x-ray-analysis/feed/"
            )
            .unwrap(),
            "https://developer.nvidia.com/blog/accelerated-x-ray-analysis/"
        );
        assert_eq!(
            canonical_news_article_url("https://developer.nvidia.com/blog/tag/cuda/feed/").unwrap(),
            "https://developer.nvidia.com/blog/tag/cuda/feed/"
        );
        assert_eq!(
            canonical_news_article_url("https://example.test/article/feed/").unwrap(),
            "https://example.test/article/feed/"
        );
    }

    #[test]
    fn public_worldmonitor_parsers_keep_only_safe_items() {
        let usgs = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "worldmonitor-usgs-earthquakes")
            .unwrap();
        let earthquakes = parse_worldmonitor_usgs(
            usgs,
            json!({"features":[{"id":"us123","properties":{"title":"M 6.0 - Test","url":"https://earthquake.usgs.gov/event","mag":6.0,"place":"Test location","time":1786881600000i64,"alert":"green"}}]}),
        );
        assert_eq!(earthquakes.len(), 1);
        assert!(earthquakes[0].summary.contains("M 6.0"));
        assert!(earthquakes[0].published_at.starts_with("2026-08-16T"));

        let eonet = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "worldmonitor-nasa-eonet")
            .unwrap();
        let events = parse_worldmonitor_eonet(
            eonet,
            json!({"events":[{"id":"EONET_1","title":"Test storm","link":"https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1","categories":[{"title":"Severe Storms"}],"geometry":[{"date":"2026-08-16T12:00:00Z"}],"sources":[{"url":"https://www.noaa.gov/storm"}]}]}),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].url, "https://www.noaa.gov/storm");
        assert!(events[0].summary.contains("Severe Storms"));
    }

    #[test]
    fn public_rss_parser_supports_advisories_and_disaster_alerts() {
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "worldmonitor-gdacs-alerts")
            .unwrap();
        let unsafe_url = ["http", "://example.test/"].concat();
        let rss = r#"<rss><channel><item>
              <title><![CDATA[Green earthquake]]></title>
              <link>https://www.gdacs.org/report.aspx?eventid=1</link>
              <description><![CDATA[Potential impact]]></description>
              <guid>EQ1</guid>
              <pubDate>Sun, 16 Aug 2026 03:39:13 GMT</pubDate>
              <enclosure url="https://www.gdacs.org/image.png" />
            </item><item><title>Unsafe</title><link>__UNSAFE_URL__</link></item></channel></rss>"#
            .replace("__UNSAFE_URL__", &unsafe_url);
        let items = parse_public_rss(source, &rss);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "worldmonitor-gdacs-alerts:EQ1");
        assert_eq!(items[0].image_url, "https://www.gdacs.org/image.png");
        assert_eq!(items[0].published_at, "2026-08-16T03:39:13+00:00");

        let horizon = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "horizon-reliefweb-updates")
            .unwrap();
        let humanitarian_updates = parse_public_rss(
            horizon,
            r#"<rss><channel><item><title>Situation update</title><link>https://reliefweb.int/report/test</link><guid>test-update</guid></item></channel></rss>"#,
        );
        assert_eq!(humanitarian_updates.len(), 1);
        assert_eq!(
            humanitarian_updates[0].id,
            "horizon-reliefweb-updates:test-update"
        );
    }

    #[test]
    fn article_return_control_is_only_injected_into_the_top_page() {
        assert!(ARTICLE_RETURN_SCRIPT.contains("if (window.top !== window) return;"));
        assert!(ARTICLE_RETURN_SCRIPT.contains("kunpeng-news-return"));
        assert!(ARTICLE_RETURN_SCRIPT.contains("event.target.closest"));
        assert!(ARTICLE_RETURN_SCRIPT.contains("window.open ="));

        let disabled = article_initialization_script(&NewsNowOpenRequest::default());
        assert!(disabled.contains("const reference = [];"));
        assert!(disabled.contains("const matchThreshold = 0.78;"));
        let enabled = article_initialization_script(&NewsNowOpenRequest {
            gesture_enabled: true,
            gesture_threshold: 0.62,
            gesture_points: (0..48)
                .map(|index| [index as f64 / 96.0 - 0.25, index as f64 / 192.0 - 0.125])
                .collect(),
            ..Default::default()
        });
        assert!(enabled.contains("const reference = [["));
        assert!(enabled.contains("const matchThreshold = 0.62;"));
        assert!(enabled.contains("event.button !== 2"));
        assert!(enabled.contains("canvas.style.display = \"none\""));
    }

    #[test]
    fn external_article_hides_while_a_page_is_loading() {
        assert_eq!(
            article_webview_phase(PageLoadEvent::Started),
            ArticleWebviewPhase::Loading
        );
        assert_eq!(
            article_webview_phase(PageLoadEvent::Finished),
            ArticleWebviewPhase::Ready
        );
    }

    #[test]
    fn intelligence_enrichment_keeps_readable_text_and_safe_media_metadata() {
        let url = "https://news.example/articles/42";
        let html = r#"
            <html><body><nav>site navigation</nav><article>
              <h1>Example event</h1><p>First confirmed detail.</p>
              <p>Second complementary detail.</p><script>secret-script-content</script>
              <img src="/images/lead.jpg"><img data-src="https://cdn.example/second.png">
              <picture><source type="image/webp" src="https://cdn.example/cover.webp"></picture>
              <video src="https://media.example/video.mp4"></video>
              <video><source type="video/webm" src="https://media.example/video.webm"></video>
            </article><footer>footer content</footer></body></html>
        "#;
        let body = cleaned_article_text(html);
        assert!(body.contains("First confirmed detail."));
        assert!(body.contains("Second complementary detail."));
        assert!(!body.contains("site navigation"));
        assert!(!body.contains("secret-script-content"));

        let images = deduplicated_media_urls(html, url, &["img"], 6);
        assert_eq!(
            images,
            vec![
                "https://news.example/images/lead.jpg".to_string(),
                "https://cdn.example/second.png".to_string(),
            ]
        );
        let videos = deduplicated_media_urls(html, url, &["video", "source"], 3);
        assert_eq!(
            videos,
            vec![
                "https://media.example/video.mp4".to_string(),
                "https://media.example/video.webm".to_string(),
            ]
        );
    }

    #[test]
    fn intelligence_enrichment_keeps_long_article_tail_for_chunked_evidence() {
        let long_section = "可核验正文。".repeat(4_000);
        let html = format!(
            "<html><body><article><p>{long_section}</p><p>长文末尾唯一事实标记。</p></article></body></html>"
        );
        let body = cleaned_article_text(&html);
        assert!(body.chars().count() > 14_000);
        assert!(body.contains("长文末尾唯一事实标记。"));
    }

    #[test]
    fn intelligence_enrichment_fallback_keeps_feed_evidence_without_claiming_full_text() {
        let request = NewsNowIntelligenceArticleRequest {
            url: "https://news.example/article".to_string(),
            source: "Example source".to_string(),
            title: "Feed title".to_string(),
            summary: "Feed summary supplied before enrichment.".to_string(),
            published_at: "2026-08-22T00:00:00Z".to_string(),
            image_url: String::new(),
        };
        let fallback = enrichment_fallback(&request, request.url.clone());
        assert!(fallback.degraded);
        assert!(fallback.body.contains("Feed title"));
        assert!(fallback
            .body
            .contains("Feed summary supplied before enrichment."));
        assert!(fallback.lead_image_data_url.is_empty());
        assert!(fallback.video_urls.is_empty());
    }

    #[test]
    fn intelligence_enrichment_rejects_private_targets_before_fetching() {
        let request = NewsNowIntelligenceArticleRequest {
            url: "https://127.0.0.1/private".to_string(),
            title: "Safe fallback".to_string(),
            summary: "No local request should be sent.".to_string(),
            ..Default::default()
        };
        let result = fetch_intelligence_article_enrichment(request);
        assert!(result.degraded);
        assert!(result.url.is_empty());
        assert!(result.body.contains("Safe fallback"));
    }

    #[test]
    fn intelligence_article_cache_key_is_stable_and_does_not_expose_the_url() {
        let path = intelligence_article_cache_path("https://news.example/article?query=value")
            .expect("cache path");
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        assert_eq!(filename.len(), 69);
        assert!(filename.ends_with(".json"));
        assert!(!filename.contains("news.example"));
    }

    #[test]
    fn reusable_article_webview_stops_the_previous_document_before_reuse() {
        assert_eq!(ARTICLE_STOP_LOADING_SCRIPT, "window.stop();");
    }

    #[test]
    fn intelligence_snapshot_only_accepts_bounded_local_news_records() {
        assert!(valid_intelligence_snapshot(&json!({
            "version": INTELLIGENCE_SNAPSHOT_CACHE_VERSION,
            "sourceIds": ["worldmonitor-usgs-earthquakes"],
            "items": [{
                "title": "M 5.9 - 270 km WSW of Yanglong, China",
                "source": "USGS",
                "url": "https://earthquake.usgs.gov/example"
            }],
            "attemptedSources": 1,
            "failedSources": 0,
            "nextBatch": 0,
            "completed": true,
            "updatedAt": 1
        })));
        assert!(!valid_intelligence_snapshot(&json!({
            "version": INTELLIGENCE_SNAPSHOT_CACHE_VERSION,
            "sourceIds": [],
            "items": []
        })));
        assert!(!valid_intelligence_snapshot(&json!({
            "version": INTELLIGENCE_SNAPSHOT_CACHE_VERSION,
            "sourceIds": ["source"],
            "items": [{"title": "x".repeat(INTELLIGENCE_SNAPSHOT_MAX_TEXT_BYTES + 1)}]
        })));
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
    fn tomsguide_article_is_extracted_sanitized_and_rejects_spoofed_hosts() {
        let url = "https://www.tomsguide.com/home/smart-home/test-story";
        let html = r#"
            <main>
              <h1>Tom's Guide &amp; test</h1>
              <time datetime="2026-08-13T01:09:52Z" class="relative-date"></time>
              <div id="article-body" class="text-copy bodyCopy auto">
                <p>First paragraph.</p>
                <div><h2>Nested section</h2><p>Last paragraph.</p></div>
                <img src="https://cdn.mos.cms.futurecdn.net/article.jpg" onerror="bad()">
                <script>bad()</script><iframe src="https://embed.example"></iframe>
              </div>
            </main>
        "#;
        let article = parse_tomsguide_article(html, url).unwrap();
        assert!(article.local);
        assert_eq!(article.title, "Tom's Guide & test");
        assert_eq!(article.source, "Tom's Guide");
        assert_eq!(article.published_at, "2026-08-13T01:09:52+00:00");
        assert!(article.content_html.contains("Nested section"));
        assert!(article.content_html.contains("Last paragraph."));
        assert!(article
            .content_html
            .contains("https://cdn.mos.cms.futurecdn.net/article.jpg"));
        assert!(!article.content_html.contains("onerror"));
        assert!(!article.content_html.contains("<script"));
        assert!(!article.content_html.contains("<iframe"));
        assert_eq!(tomsguide_article_url(url).as_deref(), Some(url));
        assert!(tomsguide_article_url("https://www.tomsguide.com:444/news/story").is_none());
        assert!(tomsguide_article_url("https://www.tomsguide.com.evil.test/news/story").is_none());
        assert!(tomsguide_article_url("https://user@www.tomsguide.com/news/story").is_none());
        assert!(
            tomsguide_article_url(concat!("http", "://www.tomsguide.com/news/story")).is_none()
        );
    }

    #[test]
    fn tomsguide_rss_includes_all_official_news_categories() {
        let source = *CURATED_SOURCES
            .iter()
            .find(|source| source.id == "tomsguide")
            .expect("Tom's Guide 来源应在目录中");
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
          <rss xmlns:content="http://purl.org/rss/1.0/modules/content/"
               xmlns:media="http://search.yahoo.com/mrss/">
            <channel>
              <item>
                <title><![CDATA[Smart home news]]></title>
                <link>https://www.tomsguide.com/home/smart-home/story-one#section</link>
                <description><![CDATA[A <strong>home</strong> summary.]]></description>
                <guid isPermaLink="false">story-one</guid>
                <pubDate>Thu, 13 Aug 2026 01:09:52 +0000</pubDate>
                <media:thumbnail url="https://cdn.mos.cms.futurecdn.net/home.jpg" />
                <content:encoded><![CDATA[<article><p>Home body.</p></article>]]></content:encoded>
              </item>
              <item>
                <title><![CDATA[Fitness news]]></title>
                <link>https://www.tomsguide.com/wellness/fitness/story-two</link>
                <description><![CDATA[A fitness summary.]]></description>
                <guid isPermaLink="false">story-two</guid>
                <pubDate>Wed, 12 Aug 2026 20:00:00 +0000</pubDate>
                <enclosure url="https://cdn.mos.cms.futurecdn.net/fitness.png" />
              </item>
              <item>
                <title><![CDATA[Spoofed host]]></title>
                <link>https://www.tomsguide.com.evil.test/computing/story-three</link>
                <guid isPermaLink="false">story-three</guid>
              </item>
            </channel>
          </rss>"#;
        let items = parse_tomsguide_rss(source, xml);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Smart home news");
        assert_eq!(
            items[0].url,
            "https://www.tomsguide.com/home/smart-home/story-one"
        );
        assert_eq!(items[0].summary, "A home summary.");
        assert_eq!(
            items[0].image_url,
            "https://cdn.mos.cms.futurecdn.net/home.jpg"
        );
        assert_eq!(items[0].published_at, "2026-08-13T01:09:52+00:00");
        assert_eq!(items[1].title, "Fitness news");
        assert_eq!(items[1].category, "综合");
        assert_eq!(items[1].source_id, "tomsguide");
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
        assert_eq!(selected.len(), CURATED_SOURCES.len());
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
        assert_eq!(MAX_REFRESH_CONCURRENCY, 12);
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
    fn preview_scheduler_stays_bounded_under_ten_thousand_items() {
        let mut items = (0..10_000)
            .map(|index| NewsNowItem {
                id: format!("stress-{index}"),
                source_id: format!("source-{}", index % 24),
                url: format!("https://stress.example/{index}"),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let mut rounds = 0;
        loop {
            let batch = take_preview_requests(&mut items);
            assert!(batch.len() <= MAX_PREFETCH_PREVIEW_IMAGES);
            if batch.is_empty() {
                break;
            }
            rounds += 1;
            for (_, request) in batch {
                assert!(seen.insert(request.item_id));
            }
        }
        assert_eq!(seen.len(), 10_000);
        assert_eq!(rounds, 10_000_usize.div_ceil(MAX_PREFETCH_PREVIEW_IMAGES));
        assert!(items.iter().all(|item| item.preview_attempted));
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
        assert!(CURATED_SOURCES.iter().any(|source| {
            source.id == "tomsguide"
                && source.name == "Tom's Guide"
                && source.category == "综合"
                && !source.default_enabled
        }));
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
            ..Default::default()
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

        let hupu = r#"
            <img class="post-user-avatar" src="https://i1.hoopchina.com.cn/user/avatar.jpg">
            <div class="thread-content-detail"><p><img data-origin="https://i3.hoopchina.com.cn/original.jpg" src="https://i3.hoopchina.com.cn/post.jpg"></p></div>
        "#;
        assert_eq!(
            preview_image_from_html(hupu, "https://bbs.hupu.com/123.html"),
            "https://i3.hoopchina.com.cn/post.jpg"
        );
        assert!(preview_image_from_html(
            r#"<img class="post-user-avatar" src="https://i1.hoopchina.com.cn/user/avatar.jpg"><div class="thread-content-detail"><p>纯文字主帖</p></div>"#,
            "https://bbs.hupu.com/456.html"
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
        sort_and_deduplicate(&mut items, false);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "new");
    }

    #[test]
    fn sort_and_deduplicate_preserves_same_url_source_evidence_when_requested() {
        let mut items = vec![
            NewsNowItem {
                title: "first source".to_string(),
                url: "https://example.test/shared".to_string(),
                source_id: "source-a".to_string(),
                published_at: "2026-08-05 12:00".to_string(),
                ..Default::default()
            },
            NewsNowItem {
                title: "second source".to_string(),
                url: "https://example.test/shared".to_string(),
                source_id: "source-b".to_string(),
                published_at: "2026-08-05 13:00".to_string(),
                ..Default::default()
            },
        ];

        sort_and_deduplicate(&mut items, true);

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].source_id, "source-b");
        assert_eq!(items[1].source_id, "source-a");
    }

    #[test]
    fn evidence_preservation_request_flag_defaults_off_and_uses_camel_case_wire_name() {
        let default_request = serde_json::from_value::<NewsNowRequest>(json!({})).unwrap();
        assert!(!default_request.preserve_evidence);

        let intelligence_request =
            serde_json::from_value::<NewsNowRequest>(json!({ "preserveEvidence": true })).unwrap();
        assert!(intelligence_request.preserve_evidence);
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
        sort_and_deduplicate(&mut items, false);
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
