const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const reader = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader.js"), "utf8");
const metrics = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-reading-metrics.js"), "utf8");

function loadMetrics() {
  const context = {};
  context.window = context;
  vm.runInNewContext(metrics, context, { filename: "reader-reading-metrics.js" });
  return context.window.ReaderReadingMetrics;
}

test("a qualified reread receives a new per-visit word credit", () => {
  assert.match(reader, /const alreadyCredited = seg\.credited \|\| 0/);
  assert.match(reader, /seg\.credited = alreadyCredited \+ delta/);
  assert.match(reader, /rwSegment = \{ key, chars, startedAt: Date\.now\(\), credited: 0 \}/);
  assert.doesNotMatch(reader, /readWordsCredit:v1/);
  assert.doesNotMatch(reader, /rwCreditedByPage/);
});

test("periodic settlement only adds the uncredited portion of one visit", () => {
  assert.match(reader, /creditReadSegment\("periodic", \{ keep: true \}\)/);
  assert.match(reader, /const delta = Math\.max\(0, totalCreditForPage - alreadyCredited\)/);
});

test("word-credit thresholds and page keys are pure reader-shell rules", () => {
  const api = loadMetrics();
  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(api.READ_TRACK), true);
  assert.equal(api.requiredDwellMs(0), 0);
  assert.equal(api.requiredDwellMs(29), 1000);
  assert.equal(api.requiredDwellMs(30), 2000);
  assert.equal(api.requiredDwellMs(150), 7500);
  assert.equal(api.pageKey({ chapter: 4, gPage: 11, page: 3 }, 1), "4:g11");
  assert.equal(api.pageKey({ page: 3 }, 4), "4:p3");
  assert.equal(api.pagePosition({ chapter: 4, page: 3 }, 1), 400003);
  assert.equal(api.pagePosition({ gPage: 11 }, 1), 11);
});

test("reader shell consumes the metrics boundary before its own script", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "reader.html"), "utf8");
  assert.match(html, /<script src="generated-ts\/reader-reading-metrics\.js"><\/script>\s*<script src="generated-ts\/reader\.js"><\/script>/);
  assert.match(reader, /const readerReadingMetrics = window\.ReaderReadingMetrics;/);
  assert.match(reader, /readerReadingMetrics\.pageKey\(d, curChapter\)/);
  assert.match(reader, /readerReadingMetrics\.requiredDwellMs\(chars\)/);
});
