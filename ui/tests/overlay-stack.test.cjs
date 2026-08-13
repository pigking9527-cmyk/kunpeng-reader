const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { ROLE_BASE, normalizeRole, computeLevels } = require("../overlay-stack.js");

const ui = resolve(__dirname, "..");
const indexHtml = readFileSync(resolve(ui, "index.html"), "utf8");
const readerHtml = readFileSync(resolve(ui, "reader.html"), "utf8");
const dialogUi = readFileSync(resolve(ui, "dialog-ui.js"), "utf8");
const overlayCss = readFileSync(resolve(ui, "overlay-stack.css"), "utf8");
const overlaySource = readFileSync(resolve(ui, "overlay-stack.js"), "utf8");
const relatedSource = readFileSync(resolve(ui, "book-info-related.js"), "utf8");
const gestureSource = readFileSync(resolve(ui, "gesture-ui.js"), "utf8");
const readerGestureSource = readFileSync(resolve(ui, "reader-gesture.js"), "utf8");
const noticeSource = readFileSync(resolve(ui, "notice-ui.js"), "utf8");
const styles = readFileSync(resolve(ui, "styles.css"), "utf8");

test("interactive overlays follow opening order across information and operation roles", () => {
  const levels = computeLevels([
    { role: "information", order: 1 },
    { role: "operation", order: 4 },
    { role: "operation", order: 2 },
  ]);

  assert.equal(levels[0], ROLE_BASE.information);
  assert.equal(levels[2], ROLE_BASE.operation + 1);
  assert.equal(levels[1], ROLE_BASE.operation + 2);
  assert.ok(levels[1] > levels[0]);
});

test("same-role overlays follow opening order and unknown roles stay operational", () => {
  const levels = computeLevels([
    { role: "information", order: 9 },
    { role: "information", order: 3 },
    { role: "future-role", order: 12 },
    { role: "critical", order: 1 },
  ]);

  assert.equal(levels[1], ROLE_BASE.information);
  assert.equal(levels[0], ROLE_BASE.information + 1);
  assert.equal(levels[2], ROLE_BASE.operation + 2);
  assert.equal(levels[3], ROLE_BASE.critical);
  assert.equal(normalizeRole("future-role"), "operation");
});

test("global feedback always outranks pages and confirmations", () => {
  const levels = computeLevels([
    { role: "feedback", order: 1 },
    { role: "critical", order: 4 },
    { role: "information", order: 7 },
    { role: "operation", order: 10 },
  ]);

  assert.equal(levels[0], ROLE_BASE.feedback);
  assert.ok(levels[0] > levels[1]);
  assert.ok(levels[0] > levels[2]);
  assert.ok(levels[0] > levels[3]);
});

test("critical confirmations remain above every interactive overlay", () => {
  const levels = computeLevels([
    { role: "critical", order: 1 },
    { role: "operation", order: 99 },
    { role: "information", order: 100 },
  ]);

  assert.ok(levels[0] > levels[1]);
  assert.ok(levels[0] > levels[2]);
});

test("desktop windows share the semantic overlay rule without page-id branching", () => {
  assert.match(indexHtml, /href="overlay-stack\.css"/);
  assert.match(indexHtml, /src="overlay-stack\.js"/);
  assert.match(readerHtml, /href="overlay-stack\.css"/);
  assert.match(readerHtml, /src="overlay-stack\.js"/);
  assert.match(
    indexHtml,
    /id="gesture-info-modal"[\s\S]*?data-overlay-role="information"/,
  );
  assert.match(
    indexHtml,
    /id="book-info-modal"[\s\S]*?data-overlay-role="information"/,
  );
  assert.match(
    readerHtml,
    /id="info-modal"[^>]*data-overlay-role="information"/,
  );
  assert.match(dialogUi, /dataset\.overlayRole = "critical"/);
  assert.match(relatedSource, /data-book-related="similar" data-overlay-role="information"/);
  assert.match(relatedSource, /data-book-related="timeline" data-overlay-role="information"/);
  assert.match(
    indexHtml,
    /id="newsnow-gesture-trail"[\s\S]*?data-overlay-role="feedback"/,
  );
  assert.match(
    readerHtml,
    /id="reader-gesture-trail"[^>]*data-overlay-role="feedback"/,
  );
  assert.match(gestureSource, /node\.dataset\.overlayRole = "feedback"/);
  assert.match(readerGestureSource, /node\.dataset\.overlayRole = "feedback"/);
  assert.match(noticeSource, /notice\.dataset\.overlayRole = "feedback"/);
  assert.match(
    overlaySource,
    /\[data-overlay-surface\]\[data-overlay-active=\\"true\\"\]/,
  );
  assert.match(
    overlayCss,
    /\.modal\[data-overlay-managed="true"\][\s\S]*?\[data-overlay-surface\]\[data-overlay-managed="true"\]/,
  );
  assert.match(
    overlayCss,
    /z-index:\s*var\(--overlay-z-index\)\s*!important/,
  );
  for (const id of [
    "newsnow-settings-modal",
    "reader-recommendation-settings-modal",
    "import-dirs-modal",
    "semantic-index-modal",
  ]) {
    assert.doesNotMatch(
      styles,
      new RegExp(`#${id}\\s*\\{[^}]*z-index`, "s"),
    );
  }
  assert.doesNotMatch(
    styles,
    /\.(?:reader-gesture-hint|newsnow-gesture-trail)\s*\{[^}]*z-index/s,
  );
  assert.doesNotMatch(
    readerHtml,
    /\.reader-gesture-trail\s*\{[^}]*z-index/s,
  );
  assert.doesNotMatch(readerGestureSource, /z-index\s*:\s*10050/);
  assert.doesNotMatch(overlaySource, /gesture-info-modal|book-info-modal|about-modal/);
});
