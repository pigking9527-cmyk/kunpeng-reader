const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "reader-navigation-rules.js"), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "reader-navigation-rules.js" });
const rules = context.window.ReaderNavigationRules;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("navigation rules normalize, de-duplicate, and bound explicit jump history", () => {
  assert.equal(Object.isFrozen(rules), true);
  const fallback = { chapter: 4, chFrac: 0.25, progress: 42 };
  const first = rules.appendHistory([], null, fallback);
  assert.deepEqual(plain(first.point), fallback);
  assert.equal(first.added, true);
  assert.equal(Object.isFrozen(first.history), true);

  const duplicate = rules.appendHistory(first.history, { chapter: 4, chFrac: 0.25005, progress: 99 }, fallback);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.history.length, 1);

  const bounded = rules.appendHistory(
    [{ chapter: 0, chFrac: 0, progress: 0 }, { chapter: 1, chFrac: 0, progress: 1 }],
    { chapter: -2, chFrac: 2, progress: -1 },
    fallback,
    2,
  );
  assert.deepEqual(plain(bounded.history), [
    { chapter: 1, chFrac: 0, progress: 1 },
    { chapter: 0, chFrac: 1, progress: 0 },
  ]);
});

test("navigation rules count only page changes after the landing page", () => {
  assert.equal(rules.pageSignature({ gPage: 12, page: 4, chapter: 2 }), "12_4_2");
  const landed = rules.trackPageDismissal({
    visible: true,
    awaitingLanding: true,
    lastPageSignature: "",
    pagesMoved: 8,
  }, { gPage: 12, page: 4, chapter: 2 }, 2);
  assert.deepEqual(plain(landed), {
    visible: true,
    awaitingLanding: false,
    lastPageSignature: "12_4_2",
    pagesMoved: 0,
    dismissed: false,
  });
  const onePage = rules.trackPageDismissal(landed, { gPage: 13, page: 5, chapter: 2 }, 2);
  assert.equal(onePage.pagesMoved, 1);
  assert.equal(onePage.dismissed, false);
  const dismissed = rules.trackPageDismissal(onePage, { gPage: 14, page: 6, chapter: 2 }, 2);
  assert.deepEqual(plain(dismissed), {
    visible: false,
    awaitingLanding: false,
    lastPageSignature: "",
    pagesMoved: 0,
    dismissed: true,
  });
});
