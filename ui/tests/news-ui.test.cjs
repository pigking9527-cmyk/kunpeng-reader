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
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<\/section>\s*<section id="newsnow-reader"/);
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
});

test("NewsNow is gated behind the local experimental switch", () => {
  const experiments = fs.readFileSync(path.join(ui, "experimental-features.js"), "utf8");
  assert.match(html, /id="experimental-newsnow"/);
  assert.match(html, /<section class="experimental-settings" aria-label="资讯">/);
  assert.doesNotMatch(html, /<div class="fp-title">实验室<\/div>/);
  assert.match(experiments, /const DEFAULTS = Object\.freeze\(\{ newsnow: false \}\)/);
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
  assert.match(script, /最多选择 \$\{MAX_SOURCES\} 个来源/);
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
  assert.match(script, /gridLayout\.addEventListener\("click", \(\) => setLayout\("grid"\)\)/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*minmax\(210px, 1fr\)/s);
  assert.match(styles, /\.newsnow-card-image\s*\{/);
  assert.doesNotMatch(styles, /\.newsnow-feed\.newsnow-feed-grid \.newsnow-card\s*\{[^}]*height: 222px/s);
  assert.match(styles, /\.newsnow-card h2\s*\{[^}]*-webkit-line-clamp: 4/s);
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
  assert.match(styles, /\.newsnow-reader\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
