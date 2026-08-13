const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "search-history-rules.js"), "utf8");
const context = { window: {}, Date, Number, Object, Array, String };
vm.runInNewContext(source, context, { filename: "search-history-rules.js" });
const rules = context.window.ReaderSearchHistoryRules;

test("search history rules normalize, deduplicate and bound recent entries", () => {
  const next = rules.recordSearchQuery(["旧词", "查询"], { 查询: { count: 4, last: 1 } }, " 查询 ", 88, 2);
  assert.deepEqual(Array.from(next.history), ["查询", "旧词"]);
  assert.deepEqual(JSON.parse(JSON.stringify(next.common.查询)), { count: 5, last: 88 });
});

test("blank query does not create a history or common-count entry", () => {
  const next = rules.recordSearchQuery(["已存在"], { 已存在: { count: 2, last: 3 } }, "  ", 99, 12);
  assert.deepEqual(Array.from(next.history), ["已存在"]);
  assert.deepEqual(JSON.parse(JSON.stringify(next.common)), { 已存在: { count: 2, last: 3 } });
});

test("common searches rank by count then recency and retain display count", () => {
  const ranked = rules.commonSearches({
    旧词: { count: 2, last: 1 },
    新词: { count: 2, last: 9 },
    高频: { count: 4, last: 0 },
  }, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ranked)), [
    { query: "高频", count: 4 },
    { query: "新词", count: 2 },
  ]);
});

test("removing a recent history entry does not delete its all-time common count", () => {
  assert.deepEqual(Array.from(rules.removeSearchQuery(["甲", "乙", "甲"], "甲")), ["乙"]);
});
