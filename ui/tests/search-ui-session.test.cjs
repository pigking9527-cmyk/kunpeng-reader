const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "search-ui.js"), "utf8");
const shelfSearchSource = fs.readFileSync(path.join(__dirname, "..", "search.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("startup restores the full-text toggle and its matching placeholder together", () => {
  assert.match(source, /shelfChk\.checked = localStorage\.getItem\("shelfSearchEnabled"\) === "1"/);
  assert.match(source, /function updateShelfSearchMode\(\)[\s\S]*?shelfChk\.checked \? "shelfSearchPlaceholder" : "searchPlaceholder"/);
  assert.match(source, /updateShelfSearchMode\(\);[\s\S]*?shelfChk\.addEventListener\("change"/);
});

test("shelf full-text search releases the main search session", () => {
  const run = source.match(/function runShelfSearch\(term\) \{([\s\S]*?)\n\}/);
  const close = source.match(/function closeShelfSearchModal\(\) \{([\s\S]*?)\n\}/);
  assert.ok(run, "full-text search launcher must exist");
  assert.ok(close, "full-text search closer must exist");
  assert.match(run[1], /closeSearch\(true\)/);
  assert.match(close[1], /shelfSearchFrame\.removeAttribute\("src"\)/);
  assert.match(close[1], /closeSearch\(true\)/);
});

test("shelf search warms semantic model when its window opens", () => {
  assert.match(shelfSearchSource, /function warmSemanticModelForShelfSearch\(\)/);
  assert.match(shelfSearchSource, /warmSemanticModelForShelfSearch\(\);/);
  assert.match(shelfSearchSource, /invoke\("warm_semantic_model"\)\.catch\(\(\) => \{\}\)/);
});

test("startup backfills full-text indices after the shelf becomes interactive", () => {
  assert.match(appSource, /runWhenNoReader\("keyword-index-startup", \(\) => invoke\("build_shelf_index"\)\)/);
  assert.match(appSource, /\}, 8000\);/);
});
