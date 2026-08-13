const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "reader-jump-back-rules.js"), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "reader-jump-back-rules.js" });
const rules = context.window.ReaderJumpBackRules;

test("jump-back rules clamp and round stored coordinates and icon sizes", () => {
  assert.equal(Object.isFrozen(rules), true);
  assert.equal(rules.normalizePosition(-1, 500), 0);
  assert.equal(rules.normalizePosition(1000.6, 500), 1000);
  assert.equal(rules.normalizePosition(Number.NaN, 499.6), 500);
  assert.equal(rules.normalizePosition(Infinity, 499.6), 500);
  assert.equal(rules.normalizeIconSizePx(29.4), 30);
  assert.equal(rules.normalizeIconSizePx(160.5), 160);
  assert.equal(rules.normalizeIconSizePx("47.6"), 48);
});

test("jump-back rules retain bounded visual geometry without legacy levels", () => {
  assert.equal("iconSizePxFromLegacyLevel" in rules, false);
  assert.equal(rules.iconHeightPx(30), 12);
  assert.equal(rules.iconHeightPx(160), 64);
  assert.equal(rules.trackPoint(0, 32, 44, 500), -6);
  assert.equal(rules.trackPoint(100, 32, 44, 0), -6);
  assert.equal(rules.trackPoint(100, 32, 44, 1000), 62);
  assert.equal(rules.trackPoint(100, 32, 20, 500), 34);
});
