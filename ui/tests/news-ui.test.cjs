const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const script = fs.readFileSync(path.join(ui, "news-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");
const backend = fs.readFileSync(path.join(ui, "..", "src", "newsnow.rs"), "utf8");

test("NewsNow has a shelf toolbar entry and an independently mounted news page", () => {
  assert.match(html, /id="newsnow-toolbar-btn"[^>]*hidden/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="newsnow-back"/);
  assert.match(html, /<div class="newsnow-toolbar-actions">\s*<div class="newsnow-actions">\s*<span id="newsnow-updated"/);
  assert.match(html, /id="newsnow-order-source"[\s\S]*?<button id="newsnow-back"/);
  assert.doesNotMatch(html, /<header class="newsnow-head">/);
  assert.doesNotMatch(backend, /正在显示本地缓存，后台正在更新/);
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<\/section>\s*<section id="newsnow-reader"/);
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
  assert.doesNotMatch(html, /class="newsnow-title-row"/);
  assert.doesNotMatch(html, />READING BRIEF</);
  assert.doesNotMatch(html, />今日资讯</);
  assert.doesNotMatch(html, /按时间归并的轻量资讯流/);
  assert.doesNotMatch(html, /id="newsnow-source-summary"/);
  assert.doesNotMatch(script, /renderSourceSummary/);
  assert.doesNotMatch(html, /<div class="newsnow-layout-control"[^>]*>\s*<span[^>]*>布局<\/span>/);
});

test("NewsNow is gated behind the local experimental switch", () => {
  const experiments = fs.readFileSync(path.join(ui, "experimental-features.js"), "utf8");
  assert.match(html, /id="experimental-newsnow"/);
  assert.match(html, /id="experimental-newsnow-gear"/);
  assert.match(html, /id="newsnow-settings-modal" class="modal"/);
  assert.match(html, /id="newsnow-settings-close"/);
  assert.match(html, /id="experimental-newsnow-prefetch"/);
  assert.match(html, /<section class="experimental-settings" aria-label="资讯">/);
  assert.doesNotMatch(html, /<div class="fp-title">实验室<\/div>/);
  assert.match(experiments, /const DEFAULTS = Object\.freeze\(\{ newsnow: false, newsnowPrefetch: true \}\)/);
  assert.match(experiments, /set\("newsnowPrefetch", prefetch\.checked\)/);
  assert.match(experiments, /settingsModal\.classList\.add\("show"\)/);
  assert.match(experiments, /settingsModal\.classList\.remove\("show"\)/);
  assert.doesNotMatch(experiments, /fp-settings-modal/);
  assert.match(experiments, /"kunpeng\.reader\.experimental-features\.v1"/);
  assert.match(script, /ReaderExperimentalFeatures\?\.enabled\?\.\("newsnow"\) === true/);
  assert.match(script, /reader-experimental-features-changed/);
  assert.match(script, /if \(!enabled && \(!page\.hidden \|\| !reader\.hidden\)\) close\(\{ focus: false \}\)/);
});

test("NewsNow opens source pages and renders extracted local articles with a stable return control", () => {
  assert.match(script, /function safeHttpUrl/);
  assert.match(script, /url\.protocol === "https:" \? url\.href : ""/);
  assert.match(script, /page\.hidden = false; shell\.hidden = true/);
  assert.match(script, /newsnow_open_article/);
  assert.match(script, /title: text\(item\.title \|\| item\.name\)/);
  assert.match(script, /summary: text\(item\.summary \|\| item\.description/);
  assert.match(script, /function withTimeout/);
  assert.match(script, /资讯请求超时/);
  assert.match(script, /reader\.hidden = !visible; page\.hidden = visible/);
  assert.match(script, /ReaderLibraryAiEntry\?\.close\(\)/);
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(html, /id="newsnow-reader-content"/);
  assert.match(html, /id="newsnow-reader-original"/);
  assert.match(script, /if \(article\?\.local\) renderLocalArticle\(article\)/);
  assert.match(script, /readerContent\.innerHTML = text\(article\?\.contentHtml/);
  assert.match(script, /readerBack\.addEventListener\("click"/);
  assert.match(script, /invoke\("open_url", \{ url: currentArticleUrl \}\)/);
  assert.doesNotMatch(html, /id="newsnow-reader-frame"/);
});

test("NewsNow stores a local, bounded source selection and optional local Tieba bar names", () => {
  assert.match(html, /id="newsnow-source-picker"/);
  assert.match(html, /id="newsnow-source-search"/);
  assert.match(html, /id="newsnow-source-apply"/);
  assert.match(script, /const SOURCE_STORAGE_KEY = "kunpeng\.reader\.news\.sources\.v2"/);
  assert.match(script, /const MAX_SOURCES = 24/);
  assert.match(script, /function allowedSourceIds/);
  assert.match(script, /sourceQuery = ""/);
  assert.match(script, /sourceSearch\.addEventListener\("input"/);
  assert.match(html, /id="newsnow-tieba-bar-form"/);
  assert.doesNotMatch(html, /id="newsnow-tieba-enabled"/);
  assert.match(html, /id="newsnow-tieba-bar-input"/);
  assert.match(html, /id="newsnow-tieba-add-toggle"/);
  assert.match(html, /id="newsnow-tieba-bar-cancel"/);
  assert.match(html, /id="newsnow-tieba-bar-list"/);
  assert.match(script, /const TIEBA_BARS_STORAGE_KEY = "kunpeng\.reader\.news\.tieba-bars\.v1"/);
  assert.match(script, /const TIEBA_ENABLED_BARS_STORAGE_KEY = "kunpeng\.reader\.news\.tieba-enabled-bars\.v1"/);
  assert.match(script, /const MAX_TIEBA_BARS = 8/);
  assert.match(script, /function normalizeTiebaBars/);
  assert.match(script, /function setTiebaAddOpen/);
  assert.match(script, /text\(source\.id\) !== "tieba"/);
  assert.match(script, /function syncPendingTiebaSource/);
  assert.match(script, /enabled\.type = "checkbox"/);
  assert.match(script, /pendingTiebaEnabledBarNames/);
  assert.match(script, /function newsRequest\(\) \{ return \{ sourceIds, tiebaBars:/);
  assert.match(script, /left === "tieba" \? 0 : 1/);
  assert.match(script, /tiebaBarForm\.addEventListener\("submit"/);
  assert.match(script, /format\("maxSources", "最多选择 \{max\} 个来源。", \{ max: MAX_SOURCES \}\)/);
  assert.match(script, /app-language-changed/);
});

test("NewsNow has a persisted horizontal and grid layout switch", () => {
  assert.match(html, /id="newsnow-layout-list"/);
  assert.match(html, /id="newsnow-layout-grid"/);
  assert.match(script, /const LAYOUT_STORAGE_KEY = "kunpeng\.reader\.news\.layout\.v1"/);
  assert.match(script, /function setLayout\(next\)/);
  assert.match(script, /feed\.classList\.toggle\("newsnow-feed-grid", grid\)/);
  assert.match(script, /newsnow-card-image/);
  assert.match(script, /safeImageDataUrl/);
  assert.match(script, /item\.previewDataUrl \|\| item\.preview_data_url/);
  assert.doesNotMatch(script, /newsnow_preview_image/);
  assert.match(script, /gridLayout\.addEventListener\("click", \(\) => setLayout\("grid"\)\)/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon::before\s*\{[^}]*width: 9px[^}]*height: 9px[^}]*box-shadow: 11px 0 currentColor, 0 11px currentColor, 11px 11px currentColor/s);
  assert.match(script, /function masonryColumnCount\(\)/);
  assert.match(script, /className = "newsnow-masonry-column"/);
  assert.match(script, /function estimatedCardHeight\(item, columnCount\)/);
  assert.match(script, /const columnHeights = Array\.from/);
  assert.match(script, /renderedMasonryColumnCount = columnCount/);
  assert.match(script, /if \(page\.hidden\) \{ feedRenderPending = true; return; \}/);
  assert.match(script, /if \(feedRenderPending \|\| layout === "grid"\) renderFeed\(\)/);
  assert.match(script, /renderedMasonryColumnCount \|\| 1/);
  assert.match(script, /global\.addEventListener\("resize"/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*repeat\(var\(--newsnow-grid-columns, 1\)/s);
  assert.match(styles, /\.newsnow-masonry-column\s*\{[^}]*flex-direction: column/s);
  assert.doesNotMatch(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*column-width/s);
  assert.match(styles, /\.newsnow-card-image\s*\{/);
  assert.match(styles, /\.newsnow-card-image\[hidden\]\s*\{\s*display: none/);
  assert.doesNotMatch(styles, /\.newsnow-feed\.newsnow-feed-grid \.newsnow-card\s*\{[^}]*height: 222px/s);
  assert.match(styles, /\.newsnow-card h2\s*\{[^}]*-webkit-line-clamp: 4/s);
});

test("NewsNow prefetches enabled sources in the background and renders cached images without reflow", () => {
  assert.match(script, /const BACKGROUND_PREFETCH_DELAY_MS = 30 \* 1000/);
  assert.match(script, /const BACKGROUND_PREFETCH_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(script, /const BACKGROUND_PREFETCH_BATCHES = 4/);
  assert.match(script, /function scheduleBackgroundPrefetch\(\)/);
  assert.match(script, /function refreshIfIdle\(\)/);
  assert.match(script, /Date\.now\(\) - lastUserActivityAt < BACKGROUND_PREFETCH_DELAY_MS/);
  assert.match(script, /invoke\("newsnow_prefetch", \{ request: newsRequest\(\) \}\)/);
  assert.match(script, /function previewAttempted\(item\)/);
  assert.match(script, /function hasPendingPreviews\(result\)/);
  assert.match(script, /batch < BACKGROUND_PREFETCH_BATCHES/);
  assert.match(script, /const needsPreviewCache = hasPendingPreviews\(result\)/);
  assert.match(script, /if \(result\?\.stale \|\| needsPreviewCache\) void refreshInBackground\(\{ announce: true \}\)/);
  assert.match(script, /masonryColumnCount\(\) === renderedMasonryColumnCount/);
  assert.match(styles, /\.experimental-settings\s*\{[^}]*padding: 0;[^}]*border: 0/s);
  assert.doesNotMatch(styles, /\.experimental-settings \.fp-set-row\s*\{/);
  assert.match(styles, /\.experimental-settings \+ \.default-apps-setting\s*\{[^}]*border-top: 0/s);
});

test("NewsNow persists mixed or source-grouped ordering", () => {
  assert.match(html, /id="newsnow-order-mixed"/);
  assert.match(html, /id="newsnow-order-source"/);
  assert.match(script, /const ORDER_STORAGE_KEY = "kunpeng\.reader\.news\.order\.v1"/);
  assert.match(script, /function setOrder\(next\)/);
  assert.match(script, /newsnow-feed-by-source/);
  assert.match(styles, /\.newsnow-source-section\s*\{/);
});

test("NewsNow toolbar toggles the main-window news page", () => {
  assert.match(script, /button\.addEventListener\("click", \(\) => \{ if \(!page\.hidden \|\| !reader\.hidden\) close/);
  assert.match(script, /page\.hidden = false; shell\.hidden = true/);
});

test("NewsNow presents a chronological reading feed and stays usable on narrow windows", () => {
  assert.match(styles, /\.newsnow-page\s*\{/);
  assert.match(styles, /\.newsnow-toolbar\s*\{[^}]*max-width: 1280px/s);
  assert.match(styles, /\.newsnow-categories\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card-rail\s*\{/);
  assert.match(styles, /\.newsnow-source-picker\s*\{/);
  assert.match(styles, /\.newsnow-card:hover, \.newsnow-card:focus-visible/);
  assert.match(styles, /\.newsnow-reader\s*\{/);
  assert.match(styles, /\.newsnow-reader\[hidden\]\s*\{\s*display: none/);
  assert.match(styles, /\.newsnow-reader\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /\.newsnow-reader-content\s*\{/);
  assert.match(styles, /\.newsnow-source-notice\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
