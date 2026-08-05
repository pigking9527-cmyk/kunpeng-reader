const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const script = fs.readFileSync(path.join(ui, "news-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");

test("NewsNow has a shelf toolbar entry and an independently mounted news page", () => {
  assert.match(html, /id="newsnow-toolbar-btn"[^>]*hidden/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="newsnow-back"/);
  assert.match(html, /<div class="newsnow-actions">\s*<button id="newsnow-back"/);
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<\/section>\s*<section id="newsnow-reader"/);
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
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

test("NewsNow opens a full source webpage in a main-window child browser", () => {
  assert.match(script, /function safeHttpUrl/);
  assert.match(script, /url\.protocol === "https:" \? url\.href : ""/);
  assert.match(script, /page\.hidden = false; shell\.hidden = true/);
  assert.match(script, /newsnow_open_article/);
  assert.match(script, /function withTimeout/);
  assert.match(script, /资讯请求超时/);
  assert.match(script, /reader\.hidden = !visible; page\.hidden = visible/);
  assert.match(script, /ReaderLibraryAiEntry\?\.close\(\)/);
  assert.doesNotMatch(html, /id="newsnow-reader-frame"/);
  assert.doesNotMatch(script, /newsnow_read_article/);
});

test("NewsNow stores a local, bounded source selection and sends only source IDs", () => {
  assert.match(html, /id="newsnow-source-picker"/);
  assert.match(html, /id="newsnow-source-search"/);
  assert.match(html, /id="newsnow-source-apply"/);
  assert.match(script, /const SOURCE_STORAGE_KEY = "kunpeng\.reader\.news\.sources\.v2"/);
  assert.match(script, /const MAX_SOURCES = 24/);
  assert.match(script, /function allowedSourceIds/);
  assert.match(script, /sourceQuery = ""/);
  assert.match(script, /sourceSearch\.addEventListener\("input"/);
  assert.match(script, /request: \{ sourceIds \}/);
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
  assert.match(script, /newsnow_preview_image/);
  assert.match(script, /safeImageDataUrl/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /sourceId: request\.sourceId, itemId: request\.itemId/);
  assert.match(script, /schedulePreviewImage\(url, imageUrl, sourceId\(item\), text\(item\.id\)/);
  assert.match(script, /gridLayout\.addEventListener\("click", \(\) => setLayout\("grid"\)\)/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon::before\s*\{[^}]*width: 9px[^}]*height: 9px[^}]*box-shadow: 11px 0 currentColor, 0 11px currentColor, 11px 11px currentColor/s);
  assert.match(script, /function masonryColumnCount\(\)/);
  assert.match(script, /className = "newsnow-masonry-column"/);
  assert.match(script, /items\.forEach\(\(item, index\) => columns\[index % columns\.length\]/);
  assert.match(script, /global\.addEventListener\("resize"/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*repeat\(var\(--newsnow-grid-columns, 1\)/s);
  assert.match(styles, /\.newsnow-masonry-column\s*\{[^}]*flex-direction: column/s);
  assert.doesNotMatch(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*column-width/s);
  assert.match(styles, /\.newsnow-card-image\s*\{/);
  assert.match(styles, /\.newsnow-card-image\[hidden\]\s*\{\s*display: none/);
  assert.doesNotMatch(styles, /\.newsnow-feed\.newsnow-feed-grid \.newsnow-card\s*\{[^}]*height: 222px/s);
  assert.match(styles, /\.newsnow-card h2\s*\{[^}]*-webkit-line-clamp: 4/s);
});

test("NewsNow prefetches enabled sources in the background without eager image downloads", () => {
  assert.match(script, /const BACKGROUND_PREFETCH_DELAY_MS = 30 \* 1000/);
  assert.match(script, /const BACKGROUND_PREFETCH_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(script, /function scheduleBackgroundPrefetch\(\)/);
  assert.match(script, /function refreshIfIdle\(\)/);
  assert.match(script, /Date\.now\(\) - lastUserActivityAt < BACKGROUND_PREFETCH_DELAY_MS/);
  assert.match(script, /invoke\("newsnow_prefetch", \{ request: \{ sourceIds \} \}\)/);
  assert.match(script, /if \(!force && result\?\.stale\) void refreshInBackground\(\{ announce: true \}\)/);
  assert.match(script, /IntersectionObserver/);
  assert.match(styles, /\.experimental-settings\s*\{[^}]*border: 0/s);
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
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card-rail\s*\{/);
  assert.match(styles, /\.newsnow-source-picker\s*\{/);
  assert.match(styles, /\.newsnow-card:hover, \.newsnow-card:focus-visible/);
  assert.match(styles, /\.newsnow-reader\s*\{/);
  assert.match(styles, /\.newsnow-reader\[hidden\]\s*\{\s*display: none/);
  assert.match(styles, /\.newsnow-reader\s*\{[^}]*flex: 1 1 auto/s);
  assert.doesNotMatch(html, /id="newsnow-reader-back"/);
  assert.doesNotMatch(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
