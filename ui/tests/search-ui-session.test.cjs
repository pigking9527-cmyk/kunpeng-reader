const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "search-ui.js"), "utf8");
const shelfSearchSource = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "search.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const searchHtml = fs.readFileSync(path.join(__dirname, "..", "search.html"), "utf8");

test("startup restores the full-text toggle and its matching placeholder together", () => {
  assert.match(source, /shelfChk\.checked = runtime\.localStorage\.getItem\("shelfSearchEnabled"\) === "1"/);
  assert.match(source, /updateShelfSearchMode[\s\S]*?shelfChk\.checked \? "shelfSearchPlaceholder" : "searchPlaceholder"/);
  assert.match(source, /updateShelfSearchMode\(\);[\s\S]*?shelfChk\.addEventListener\("change"/);
});

test("shelf full-text search releases the main search session", () => {
  assert.match(source, /runShelfSearch[\s\S]*?shelfSearchFrame\.src[\s\S]*?closeSearch\(true\)/);
  assert.match(source, /closeShelfSearchModal[\s\S]*?shelfSearchFrame\.removeAttribute\("src"\)[\s\S]*?closeSearch\(true\)/);
});

test("shelf search warms semantic model when its window opens", () => {
  assert.match(shelfSearchSource, /runtime\.setTimeout\(\(\) => \{/);
  assert.match(shelfSearchSource, /api\.invoke\("warm_semantic_model"\)\.catch\(\(\) => void 0\)/);
});

test("full-text search uses one clean embedded page without a duplicate heading or close X", () => {
  const modal = html.slice(html.indexOf('id="shelf-search-modal"'), html.indexOf('id="organization-filter-modal"'));
  assert.doesNotMatch(modal, /书架全文检索/);
  assert.doesNotMatch(modal, /shelf-search-close/);
  assert.match(searchHtml, /class="search-shell"/);
  assert.match(searchHtml, /id="search-alert"/);
});

test("keyword search automatically retries while its background index is being prepared", () => {
  assert.match(shelfSearchSource, /const scheduleKeywordRetry = \(term\) =>/);
  assert.match(shelfSearchSource, /runSearch\(term, \{ retry: true \}\)/);
  assert.match(shelfSearchSource, /if \(mode === "kw" && pendingBooks > 0\) scheduleKeywordRetry\(curTerm\)/);
  assert.match(shelfSearchSource, /页面将自动显示结果/);
});

test("semantic search checks model and index readiness and shows a visible dialog", () => {
  assert.match(shelfSearchSource, /const semanticReadiness = async \(\) =>/);
  assert.match(shelfSearchSource, /api\.invoke\("semantic_status"\)/);
  assert.match(shelfSearchSource, /api\.invoke\("semantic_index_done", \{\s*ids:/);
  assert.match(shelfSearchSource, /showSearchAlert\(warning, "语义检索未就绪"\)/);
  assert.match(shelfSearchSource, /if \(warning\) \{[\s\S]*?return;[\s\S]*?\}/);
});

test("startup backfills full-text indices after the shelf becomes interactive", () => {
  assert.match(appSource, /runWhenNoReader\("keyword-index-startup", \(\) => invoke\("build_shelf_index"\)\)/);
  assert.match(appSource, /\}, 8e3\);/);
});
