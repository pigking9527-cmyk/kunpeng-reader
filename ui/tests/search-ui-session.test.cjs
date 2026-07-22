const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "search-ui.js"), "utf8");

test("shelf full-text search releases the main search session", () => {
  const run = source.match(/function runShelfSearch\(term\) \{([\s\S]*?)\n\}/);
  const close = source.match(/function closeShelfSearchModal\(\) \{([\s\S]*?)\n\}/);
  assert.ok(run, "full-text search launcher must exist");
  assert.ok(close, "full-text search closer must exist");
  assert.match(run[1], /closeSearch\(true\)/);
  assert.match(close[1], /shelfSearchFrame\.removeAttribute\("src"\)/);
  assert.match(close[1], /closeSearch\(true\)/);
});
