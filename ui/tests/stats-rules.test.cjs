const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "stats-rules.js"), "utf8");

function rules() {
  const context = { window: null };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.ReaderStatsRules;
}

test("statistics rules derive stable day, month, year and total payload ranges", () => {
  const stats = rules();
  const anchor = new Date(2024, 1, 29, 23, 59, 59);
  assert.deepEqual(Array.from(stats.range("day", anchor)), [20240229, 20240229]);
  assert.deepEqual(Array.from(stats.range("month", anchor)), [20240201, 20240231]);
  assert.deepEqual(Array.from(stats.range("year", anchor)), [20240101, 20241231]);
  assert.deepEqual(Array.from(stats.range("total", anchor)), [0, 99999999]);
});

test("statistics rules normalize and step anchors without retaining input dates", () => {
  const stats = rules();
  const original = new Date(2024, 1, 29, 12, 30, 10);
  assert.equal(stats.normalizeAnchor(original, "day").getTime(), new Date(2024, 1, 29).getTime());
  assert.equal(stats.normalizeAnchor(original, "month").getTime(), new Date(2024, 1, 1).getTime());
  assert.equal(stats.normalizeAnchor(original, "year").getTime(), new Date(2024, 0, 1).getTime());
  assert.equal(stats.steppedAnchor("day", original, 1).getTime(), new Date(2024, 2, 1).getTime());
  assert.equal(stats.steppedAnchor("month", original, 1).getTime(), new Date(2024, 2, 1).getTime());
  assert.equal(stats.steppedAnchor("year", original, -1).getTime(), new Date(2023, 0, 1).getTime());
  assert.equal(original.getTime(), new Date(2024, 1, 29, 12, 30, 10).getTime());
});

test("statistics rules prevent navigation before the first reading day or after today", () => {
  const stats = rules();
  const now = new Date(2024, 4, 15, 18, 0, 0);
  const firstReadingDay = 20240331;
  const atFirst = stats.navigation("month", new Date(2024, 2, 31), firstReadingDay, now);
  assert.equal(atFirst.showNavigation, true);
  assert.equal(atFirst.previousDisabled, true);
  assert.equal(atFirst.nextDisabled, false);
  assert.equal(stats.canStep("month", new Date(2024, 2, 31), -1, firstReadingDay, now), false);
  assert.equal(stats.canStep("month", new Date(2024, 2, 31), 1, firstReadingDay, now), true);
  const atLast = stats.navigation("day", now, firstReadingDay, now);
  assert.equal(atLast.nextDisabled, true);
  assert.equal(stats.canStep("day", now, 1, firstReadingDay, now), false);
  const total = stats.navigation("total", now, firstReadingDay, now);
  assert.equal(total.showNavigation, false);
  assert.equal(total.previousDisabled, true);
  assert.equal(total.nextDisabled, true);
});
