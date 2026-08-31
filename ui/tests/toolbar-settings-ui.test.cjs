const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const source = fs.readFileSync(
  path.join(root, "generated-ts", "toolbar-settings-ui.js"),
  "utf8",
);
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const shelf = fs.readFileSync(path.join(root, "generated-ts", "shelf-ui.js"), "utf8");
const annotations = require("./reader-page-test-source.cjs").compact;

test("main toolbar exposes a dedicated customizable action set", () => {
  for (const id of ["account", "search", "stats", "library", "news", "intelligence-lab", "filter", "settings", "menu"]) {
    assert.match(html, new RegExp(`data-toolbar-item="${id}"`));
  }
  assert.match(html, /data-settings-section="toolbar"/);
  assert.match(html, /id="toolbar-settings-list"/);
  assert.match(html, /id="toolbar-icon-size"/);
  assert.match(html, /id="toolbar-content-list"/);
  assert.match(html, /id="toolbar-leading-action"/);
});

test("library QA and news use distinct monochrome toolbar glyphs", () => {
  const library = html.match(/id="library-ai-toolbar-btn"[\s\S]*?<\/button>/)?.[0] || "";
  const news = html.match(/id="newsnow-toolbar-btn"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(library, /M4\.5 5\.5c2\.3-1\.2/);
  assert.match(library, /M15\.2 9\.2a1\.9/);
  assert.match(news, /<rect\s+x="4\.5"\s+y="5"\s+width="15"\s+height="14"/);
  assert.match(news, /M13 8h3\.5/);
  assert.doesNotMatch(library + news, /fill="#fff"/);
});

test("toolbar settings keep settings visible and reflow neighboring actions", () => {
  assert.match(source, /const TOOLBAR_ITEM_IDS = Object\.freeze\(\[/);
  assert.match(source, /id !== "settings"/);
  assert.match(source, /const leading = document\.getElementById\([\s\S]*?"toolbar-leading-action"/);
  assert.match(source, /\(index === 0 && leading \? leading : root\)\.append\(item\)/);
  assert.match(source, /item\.animate\(/);
  assert.match(source, /app_settings_sync_save/);
  assert.match(source, /account: \["账户", "登录、同步与账户管理"\]/);
  assert.match(source, /"intelligence-lab": \["情报中心", "打开情报中心测试"\]/);
  assert.match(source, /toolbarContentOrder: TOOLBAR_CONTENT_IDS\.slice\(\)/);
  assert.match(source, /toolbarContentVisible: \["icon"\]/);
  assert.match(source, /if \(id\) ensureToolbarButtonContent\(id\)/);
  assert.match(source, /if \(!next\.size\)/);
  assert.match(styles, /\.toolbar-content-button\.toolbar-content-has-text/);
  assert.match(styles, /\.toolbar-action\.toolbar-user-hidden\s*\{\s*display:\s*none;/);
  assert.match(styles, /--toolbar-item-size/);
  assert.match(styles, /\.toolbar-leading-action \{\s*flex: 0 0 auto;\s*\}/);
});

test("toolbar ordering uses pointer capture instead of unreliable native drag events", () => {
  assert.match(source, /handle\.addEventListener\("pointerdown", \(event\) =>/);
  assert.match(source, /handle\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(source, /handle\.addEventListener\("pointermove"/);
  assert.match(source, /placeholder\.className = "toolbar-settings-placeholder"/);
  assert.match(source, /item\.style\.position = "fixed"/);
  assert.match(source, /const animateListPlaceholder = \(state, beforeNode\) =>/);
  assert.match(source, /list\.insertBefore\(placeholder, beforeNode\)/);
  assert.match(source, /item\.style\.transform = `translateY\(\$\{dy\}px\)`/);
  assert.match(source, /const bounds = list\?\.getBoundingClientRect\(\)/);
  assert.match(
    source,
    /Math\.max\([\s\S]*?bounds\.top,[\s\S]*?Math\.min\(maxTop, event\.clientY - state\.offsetY\)/,
  );
  assert.match(source, /const bounds = contentList\?\.getBoundingClientRect\(\)/);
  assert.match(
    source,
    /Math\.max\([\s\S]*?bounds\.left,[\s\S]*?Math\.min\(maxLeft, event\.clientX - state\.offsetX\)/,
  );
  assert.match(styles, /\.toolbar-settings-placeholder\s*\{/);
  assert.match(source, /handle\.addEventListener\("pointerdown"/);
  assert.match(source, /toolbarContentOrder: contentListItems\(\)\.map/);
  assert.match(styles, /\.toolbar-content-placeholder\s*\{/);
  assert.doesNotMatch(source, /item\.draggable|dragstart|dragover|dragend/);
});

test("remaining reorder overlays are clamped to the bounds of their replacement lists", () => {
  assert.match(shelf, /const bounds = booklistBooks\.getBoundingClientRect\(\)/);
  assert.match(annotations, /const bounds=list\.getBoundingClientRect\(\)/);
  for (const code of [shelf, annotations]) {
    assert.match(code, /Math\.max\(bounds\.top,\s*Math\.min\(maxTop,/);
  }
});
