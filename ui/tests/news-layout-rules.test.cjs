const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "news-layout-rules.js"), "utf8");

function rules() {
  const context = {};
  context.window = context;
  vm.runInNewContext(source, context, { filename: "news-layout-rules.js" });
  return context.ReaderNewsLayoutRules;
}

test("news layout rules calculate bounded column counts without a DOM", () => {
  const layout = rules();
  assert.equal(layout.masonryColumnCount(0, 3), 3);
  assert.equal(layout.masonryColumnCount(0, 0), 1);
  assert.equal(layout.masonryColumnCount(210), 1);
  assert.equal(layout.masonryColumnCount(433), 2);
  assert.equal(layout.masonryColumnCount(656), 3);
  assert.equal(layout.masonryColumnCount(656, 0, { minimumCardWidth: 300, gap: 20 }), 2);
});

test("news layout rules estimate cards from projected content and image presence", () => {
  const layout = rules();
  const base = layout.estimateCardHeight({ title: "标题" }, { width: 220, columnCount: 1 });
  const rich = layout.estimateCardHeight({ title: "很长的标题".repeat(30), summary: "摘要".repeat(80), hasImage: true }, { width: 220, columnCount: 1 });
  assert.equal(base, 139);
  assert.ok(rich > base + 146);
  assert.equal(layout.estimateCardHeight({}, { width: 0, columnCount: 0 }), 139);
});

test("news layout rules stably place each card in the shortest estimated column", () => {
  const layout = rules();
  assert.deepEqual(Array.from(layout.balancedColumnIndexes([100, 200, 50, 150, 20], 2)), [0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(layout.balancedColumnIndexes([100, Number.NaN, -1], 0)), [0, 0, 0]);
});
