const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(path.join(__dirname, "..", "reader.js"), "utf8");

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
