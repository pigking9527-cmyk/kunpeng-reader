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
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
});

test("NewsNow is gated behind the local experimental switch", () => {
  const experiments = fs.readFileSync(path.join(ui, "experimental-features.js"), "utf8");
  assert.match(html, /id="experimental-newsnow"/);
  assert.match(html, /<div class="fp-title">实验室<\/div>/);
  assert.match(experiments, /const DEFAULTS = Object\.freeze\(\{ newsnow: false \}\)/);
  assert.match(experiments, /"kunpeng\.reader\.experimental-features\.v1"/);
  assert.match(script, /ReaderExperimentalFeatures\?\.enabled\?\.\("newsnow"\) === true/);
  assert.match(script, /reader-experimental-features-changed/);
  assert.match(script, /if \(!enabled && !page\.hidden\) close\(\{ focus: false \}\)/);
});

test("NewsNow feed keeps news loading separate from startup and overlays safe original links in-app", () => {
  assert.match(script, /function safeHttpUrl/);
  assert.match(script, /url\.protocol === "https:" \? url\.href : ""/);
  assert.match(script, /"newsnow_sources"/);
  assert.match(script, /"newsnow_list"/);
  assert.match(script, /"newsnow_refresh"/);
  assert.match(script, /function withTimeout/);
  assert.match(script, /资讯请求超时/);
  assert.match(html, /id="newsnow-reader"/);
  assert.match(html, /id="newsnow-reader-frame"/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"/);
  assert.match(html, /返回资讯页/);
  assert.match(script, /readerFrame\.src = url/);
  assert.match(script, /articleScrollTop = page\.scrollTop/);
  assert.match(script, /page\.scrollTop = articleScrollTop/);
  assert.doesNotMatch(script, /newsnow_read_article/);
  assert.match(script, /shell\.hidden = true/);
  assert.match(script, /page\.hidden = false/);
  assert.match(script, /ReaderLibraryAiEntry\?\.close\(\)/);
  assert.match(script, /function close\(\{ focus = true \} = \{\}\)/);
  assert.match(script, /page\.hidden = true/);
});

test("NewsNow stores a local, bounded source selection and sends only source IDs", () => {
  assert.match(html, /id="newsnow-source-picker"/);
  assert.match(html, /id="newsnow-source-search"/);
  assert.match(html, /id="newsnow-source-apply"/);
  assert.match(script, /const SOURCE_STORAGE_KEY = "kunpeng\.reader\.news\.sources\.v2"/);
  assert.match(script, /const MAX_SOURCES = 12/);
  assert.match(script, /function allowedSourceIds/);
  assert.match(script, /let sourceQuery = ""/);
  assert.match(script, /sourceSearch\.addEventListener\("input"/);
  assert.match(script, /const request = \{ sourceIds \}/);
  assert.match(script, /最多选择 \$\{MAX_SOURCES\} 个来源/);
});

test("NewsNow has a persisted horizontal and grid layout switch", () => {
  assert.match(html, /id="newsnow-layout-list"/);
  assert.match(html, /id="newsnow-layout-grid"/);
  assert.match(script, /const LAYOUT_STORAGE_KEY = "kunpeng\.reader\.news\.layout\.v1"/);
  assert.match(script, /function setLayout\(nextLayout\)/);
  assert.match(script, /feed\.classList\.toggle\("newsnow-feed-grid", grid\)/);
  assert.match(script, /gridLayout\.addEventListener\("click", \(\) => setLayout\("grid"\)\)/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
});

test("NewsNow toolbar toggles back to the shelf when it is already open", () => {
  assert.match(script, /function toggle\(\) \{\s*if \(page\.hidden\) \{\s*open\(\);\s*\} else \{\s*close\(\);/s);
  assert.match(script, /button\.addEventListener\("click", toggle\)/);
});

test("NewsNow presents a chronological reading feed and stays usable on narrow windows", () => {
  assert.match(styles, /\.newsnow-page\s*\{/);
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card-rail\s*\{/);
  assert.match(styles, /\.newsnow-source-picker\s*\{/);
  assert.match(styles, /\.newsnow-card:hover, \.newsnow-card:focus-visible/);
  assert.match(styles, /\.newsnow-reader\s*\{/);
  assert.match(styles, /\.newsnow-page\.newsnow-reading\s*\{/);
  assert.match(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
