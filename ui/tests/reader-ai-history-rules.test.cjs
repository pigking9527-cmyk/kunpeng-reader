const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rulesSource = fs.readFileSync(path.join(__dirname, "..", "reader-ai-history-rules.js"), "utf8");

function loadRules() {
  const context = { window: {} };
  vm.runInNewContext(rulesSource, context, { filename: "reader-ai-history-rules.js" });
  return context.window.ReaderAiHistoryRules;
}

test("AI history rules expose a frozen, DOM-free boundary", () => {
  const rules = loadRules();
  assert.equal(Object.isFrozen(rules), true);
  assert.equal(rules.TOMBSTONE_LIMIT, 200);
  assert.doesNotMatch(rulesSource, /document|localStorage|invoke|postMessage|ReaderShell/);
});

test("AI history merge keeps all live entries and bounds only tombstones", () => {
  const rules = loadRules();
  const live = Array.from({ length: 205 }, (_, index) => ({ id: `live-${index}`, at: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const deleted = Array.from({ length: 205 }, (_, index) => ({ id: `deleted-${index}`, deletedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const merged = rules.mergeEntries(live, deleted, [{ id: "live-1", deleted_at: "2026-09-01T00:00:00.000Z" }]);
  assert.equal(merged.filter((entry) => !rules.isHistoryDeleted(entry)).length, 204);
  assert.equal(merged.filter(rules.isHistoryDeleted).length, 200);
  assert.equal(merged.find((entry) => entry.id === "live-1").deleted_at, "2026-09-01T00:00:00.000Z");
  assert.equal(rules.historyEntryId({ at: "legacy-at" }), "legacy:legacy-at");
});

test("session continuity is bounded independently from synced history", () => {
  const rules = loadRules();
  const first = rules.prependSessionEntry([], { task: "summary", question: "q".repeat(300), content: "c".repeat(900), at: "2026-08-13T00:00:00.000Z" });
  assert.equal(first[0].question.length, 220);
  assert.equal(first[0].content.length, 760);
  const entries = Array.from({ length: 8 }, (_, index) => ({ task: "question", content: String(index), at: `2026-08-13T00:00:0${index}.000Z` }));
  const saved = rules.prependSessionEntry(entries, { task: "mindmap", content: "new" }, () => "now");
  assert.equal(saved.length, 6);
  assert.equal(saved[0].task, "mindmap");
  assert.equal(saved[0].at, "now");
  assert.match(rules.sessionPrompt(saved, (task) => ({ mindmap: "脑图", question: "提问" })[task]), /^会话 1（脑图）：new/);
});
