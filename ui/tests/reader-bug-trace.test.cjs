const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const trace = require("../reader-bug-trace.js");
const uiRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "reader.html"), "utf8");
const mainHtml = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const mainTrace = fs.readFileSync(path.join(uiRoot, "problem-trace-ui.js"), "utf8");
const reader = fs.readFileSync(path.join(uiRoot, "reader.js"), "utf8");
const pageTrace = fs.readFileSync(path.join(uiRoot, "reader-page-bug-trace.js"), "utf8");
const layout = fs.readFileSync(path.join(uiRoot, "reader-page-layout.js"), "utf8");
const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");

test("problem trace keeps two bounded minutes of redacted metadata", () => {
  trace.reset();
  for (let index = 0; index < trace.MAX_EVENTS + 12; index += 1) {
    trace.record("click", { outcome: "selection", target: "p", text: "正文不可记录", href: "https://secret.invalid" });
  }
  const current = trace._snapshotForTests();
  assert.equal(current.length, trace.MAX_EVENTS);
  assert.equal(current.at(-1).detail.outcome, "selection");
  assert.equal(current.at(-1).detail.text, undefined);
  assert.equal(current.at(-1).detail.href, undefined);
  assert.equal(trace._snapshotForTests(Date.now() + trace.WINDOW_MS + 1).length, 0);
});

test("Bug feedback requests the reader problem-state snapshot as an attachment", () => {
  assert.doesNotMatch(html, /id="bug-trace-btn"/);
  assert.doesNotMatch(html, /id="bug-trace-modal"/);
  assert.doesNotMatch(mainHtml, /id="mi-problem-trace"/);
  assert.doesNotMatch(mainHtml, /id="problem-trace-modal"/);
  assert.match(mainHtml, /id="feedback-attach-problem-trace"[^>]*>附到本次反馈（推荐）<\/button>/);
  assert.match(mainHtml, /id="feedback-save-problem-trace"[^>]*>保存问题记录到桌面<\/button>/);
  assert.match(mainHtml, /<script src="problem-trace-ui\.js"><\/script>/);
  assert.match(html, /reader-bug-trace\.js/);
  assert.match(reader, /ReaderBugTrace\?\.setContextProvider/);
  assert.match(reader, /ReaderBugTrace\?\.ingestPageEvent/);
  assert.match(reader, /title:\s*currentBookTitle/);
  assert.match(reader, /overlay:\s*shell\.overlay/);
  assert.match(reader, /listen\("reader-bug-trace-request"/);
  assert.match(reader, /emit\("reader-bug-trace-response"/);
  assert.match(mainTrace, /eventApi\.emit\("reader-bug-trace-request"/);
  assert.match(mainTrace, /eventApi\.listen\("reader-bug-trace-response"/);
  assert.match(mainTrace, /const WINDOW_MS = 2 \* 60 \* 1000/);
  assert.match(mainTrace, /function wireShellOperations/);
  assert.match(mainTrace, /library_qa/);
  assert.match(mainTrace, /reading_stats/);
  assert.match(mainTrace, /book_organization/);
  assert.match(mainTrace, /settings/);
  assert.match(mainTrace, /news/);
  assert.doesNotMatch(mainTrace, /save_problem_trace_json/);
  assert.doesNotMatch(mainTrace, /dialog\.save/);
});

test("Chinese 注1 cross-chapter references are treated as in-place notes", () => {
  assert.match(layout, /\(\?:注\|註\)\\s\*\\d\{1,5\}/);
  assert.match(layout, /\^zww\\d\{1,5\}\$/);
  assert.match(annotations, /\(\?:\(\?:注\|註\)\\s\*\)\?\\d\{1,4\}/);
  assert.match(annotations, /isNoteLink\(a\)&&frag\)\{showFootnote\(a,ciT,frag\);return;\}/);
});

test("reader page reports why a click did not turn the page", () => {
  assert.match(pageTrace, /var chapterPending=0/);
  assert.match(pageTrace, /function readerBugTrace\(kind,outcome,e,extra\)/);
  assert.match(pageTrace, /readerBugTrace\('chapter','chapter_start'/);
  assert.match(pageTrace, /ready\?'chapter_ready':'chapter_error'/);
  assert.match(layout, /beginChapterBugTrace\(i,where\)/);
  assert.match(layout, /finishChapterBugTrace\(bugTraceToken,true,pageInCh\)/);
  ["chapter_pending", "overlay", "link", "drag", "selection"].forEach((outcome) => {
    assert.match(annotations, new RegExp("readerBugTrace\\('click','" + outcome + "'"));
  });
  assert.match(annotations, /readerBugTrace\('click','page_next'/);
  assert.match(annotations, /readerBugTrace\('click','page_prev'/);
});
