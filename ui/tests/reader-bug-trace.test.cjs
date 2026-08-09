const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const trace = require("../reader-bug-trace.js");
const uiRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "reader.html"), "utf8");
const mainHtml = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const mainTrace = fs.readFileSync(path.join(uiRoot, "problem-trace-ui.js"), "utf8");
const feedbackUi = fs.readFileSync(path.join(uiRoot, "feedback-ui.js"), "utf8");
const reader = fs.readFileSync(path.join(uiRoot, "reader.js"), "utf8");
const pageTrace = fs.readFileSync(path.join(uiRoot, "reader-page-bug-trace.js"), "utf8");
const layout = fs.readFileSync(path.join(uiRoot, "reader-page-layout.js"), "utf8");
const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
const mainTraceApi = require("../problem-trace-ui.js");

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

test("problem trace includes allowlisted software settings without secrets or raw images", () => {
  const storage = new Map([
    ["readerSettings", JSON.stringify({ theme: "dark", fontFamily: "Noto Serif CJK SC", fontSize: 27, flowMode: "paged", customBackgroundImage: "data:image/png;base64,PRIVATE_IMAGE" })],
    ["readerAnimationSettingsV1", JSON.stringify({ allAnimations: false, pageTurn: true })],
    ["debugSettingsV1", JSON.stringify({ bg_sync: false })],
    ["kunpeng.reader.experimental-features.v1", JSON.stringify({ newsnow: true })],
    ["kunpeng.reader.news.back-gesture.enabled.v1", "true"],
    ["kunpeng.reader.news.back-gesture.precision.v1", "7"],
    ["kunpeng.reader.news.back-gesture.v2", JSON.stringify({ points: [{ x: 0, y: 0 }] })],
    ["shelfLayout", "list"],
    ["shelfGridColumnsValue", "4"],
    ["syncAccountCacheV1", JSON.stringify({ username: "private-user", token: "PRIVATE_TOKEN" })],
    ["readerCustomPalettesV1", JSON.stringify([{ id: "private-palette", backgroundImage: "data:image/png;base64,PRIVATE_PALETTE" }])],
  ]);
  const settings = mainTraceApi._collectSoftwareSettingsForTests({
    getItem: (key) => storage.get(key) ?? null,
  });
  assert.equal(settings.reader.theme, "dark");
  assert.equal(settings.reader.font_size, 27);
  assert.equal(settings.reader.custom_background_image_configured, true);
  assert.equal(settings.animations.allAnimations, false);
  assert.equal(settings.experimental_features.newsnow, true);
  assert.equal(settings.gestures.precision, 7);
  assert.equal(settings.shelf.layout, "list");
  const serialized = JSON.stringify(settings);
  assert.doesNotMatch(serialized, /PRIVATE_TOKEN|PRIVATE_IMAGE|PRIVATE_PALETTE|private-user/);
  assert.ok(settings.omitted_sensitive_settings.includes("sync_account"));
});
test("problem trace summarizes startup speed across application restarts", () => {
  const summary = mainTraceApi._summarizeStartupPerformanceForTests([
    { session: "one", name: "startup", phase: "webview_script", detail: "120ms" },
    { session: "one", name: "startup", phase: "dom_ready", detail: "180ms" },
    { session: "one", name: "startup", phase: "shelf_painted", detail: "420ms" },
    { session: "two", name: "startup", phase: "webview_script", detail: "100ms" },
    { session: "two", name: "startup", phase: "dom_ready", detail: "170ms" },
    { session: "two", name: "startup", phase: "shelf_painted", detail: "380ms" },
    { session: "two", name: "rust:startup-enhancement", phase: "activated", detail: "145ms hot activation" },
  ]);
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.process_to_webview_script, { count: 2, min_ms: 100, avg_ms: 110, max_ms: 120, latest_ms: 100 });
  assert.equal(summary.process_to_dom_ready.avg_ms, 175);
  assert.equal(summary.process_to_shelf_painted.avg_ms, 400);
  assert.equal(summary.hot_activation.latest_ms, 145);
});

test("progress trace keeps numeric chapter offset metadata without book text", () => {
  trace.reset();
  trace.record("progress_save", {
    source: "reader_shell",
    outcome: "ok",
    sequence: 7,
    chapter: 13,
    chapter_frac: 0.625,
    progress: 42.5,
    anchor_offset: 1510000,
    text_content: "正文不可记录",
  });
  const event = trace._snapshotForTests().at(-1);
  assert.deepEqual(event.detail, {
    source: "reader_shell",
    outcome: "ok",
    sequence: 7,
    chapter: 13,
    chapter_frac: 0.625,
    progress: 42.5,
    anchor_offset: 1510000,
  });
});

test("image pagination trace keeps only layout geometry and mode", () => {
  trace.reset();
  trace.record("page_image_pagination", {
    source: "reader_page",
    outcome: "no_candidate",
    image_mode: "continuous",
    image_source_page: 8,
    image_candidate_page: 9,
    image_top: 126,
    image_width: 903,
    image_height: 730,
    image_free_height: 318,
    image_preview_height: 0,
    image_next_count: 1,
    image_skipped_text: 0,
    image_url: "reader://private/image.png",
    body_text: "正文不可记录",
  });
  const event = trace._snapshotForTests().at(-1);
  assert.equal(event.detail.image_mode, "continuous");
  assert.equal(event.detail.image_height, 730);
  assert.equal(event.detail.image_url, undefined);
  assert.equal(event.detail.body_text, undefined);
});

test("Bug feedback requests the reader problem-state snapshot as an attachment", () => {
  assert.doesNotMatch(html, /id="bug-trace-btn"/);
  assert.doesNotMatch(html, /id="bug-trace-modal"/);
  assert.doesNotMatch(mainHtml, /id="mi-problem-trace"/);
  assert.doesNotMatch(mainHtml, /id="problem-trace-modal"/);
  assert.match(mainHtml, /id="feedback-attach-problem-trace"[^>]*data-i18n="attachTrace"[^>]*>附到本次反馈（推荐）<\/button>/);
  assert.match(mainHtml, /id="feedback-save-problem-trace"[^>]*data-i18n="saveTraceDesktop"[^>]*>保存问题记录到桌面<\/button>/);
  assert.match(mainHtml, /<script src="problem-trace-ui\.js"><\/script>/);
  assert.match(html, /reader-bug-trace\.js/);
  assert.match(reader, /ReaderBugTrace\?\.setContextProvider/);
  assert.match(reader, /ReaderBugTrace\?\.ingestPageEvent/);
  assert.match(reader, /title:\s*currentBookTitle/);
  assert.match(reader, /overlay:\s*shell\.overlay/);
  assert.match(reader, /listen\("reader-bug-trace-request"/);
  assert.match(reader, /emit\("reader-bug-trace-response"/);
  assert.match(reader, /bugTraceRequestReady/);
  assert.match(reader, /ReaderBugTrace\?\.checkpoint\?\.\(0\)/);
  assert.match(mainTrace, /reader-bug-trace-checkpoint/);
  assert.match(mainTrace, /problem_trace_checkpoint/);
  assert.match(mainTrace, /recentReaderSnapshot/);
  assert.match(mainTrace, /function shellOnlySnapshot/);
  assert.doesNotMatch(mainTrace + feedbackUi, /请先打开一本书并复现问题/);
  assert.match(mainTrace, /retryTimer/);
  assert.match(mainTrace, /eventApi\.emit\("reader-bug-trace-request"/);
  assert.match(mainTrace, /eventApi\.listen\("reader-bug-trace-response"/);
  assert.match(mainTrace, /const WINDOW_MS = 2 \* 60 \* 1000/);
  assert.match(mainTrace, /function wireShellOperations/);
  assert.match(mainTrace, /\[data-problem-target\]/);
  assert.match(mainTrace, /reader-window-trace/);
  assert.match(mainTrace, /function restoreShelfDocumentFocus/);
  assert.match(mainTrace, /root\.focus\?\.\(\)/);
  assert.match(mainTrace, /querySelector\?\.\("\.content"\)\?\.focus/);
  assert.match(mainTrace, /attempts < 6/);
  assert.match(mainTrace, /pushShellEvent\("main_focus"/);
  assert.match(mainTrace, /reader-performance-trace/);
  assert.match(mainTrace, /function summarizeReaderPerformance/);
  assert.match(mainTrace, /reader_performance: summarizeReaderPerformance\(recentShell\)/);
  assert.match(mainTrace, /startup_performance: readStartupPerformance\(\)/);
  assert.match(reader, /function recordReaderPerformance/);
  assert.match(reader, /recordReaderPerformance\("book_info"/);
  assert.match(reader, /recordReaderPerformance\("frame_ready"/);
  assert.match(mainTrace, /function recordShelfBookOpen/);
  assert.match(fs.readFileSync(path.join(uiRoot, "shelf-ui.js"), "utf8"), /dataset\.problemTarget = "book-card"/);
  assert.match(mainTrace, /library_qa/);
  assert.match(mainTrace, /reading_stats/);
  assert.match(mainTrace, /book_organization/);
  assert.match(mainTrace, /settings/);
  assert.match(mainTrace, /news/);
  assert.doesNotMatch(mainTrace, /save_problem_trace_json/);
  assert.doesNotMatch(mainTrace, /dialog\.save/);
  assert.match(fs.readFileSync(path.join(uiRoot, "reader-bug-trace.js"), "utf8"), /problem_trace_checkpoint/);
});

test("main-window bugs can attach a shell-only trace without opening a reader", async () => {
  const snapshot = await mainTraceApi.capture({
    timeoutMs: 15,
    eventApi: {
      listen: async () => () => {},
      emit: async () => {},
    },
  });
  assert.equal(snapshot.book.title, "");
  assert.equal(snapshot.book.format, "unknown");
  assert.ok(Array.isArray(snapshot.events));
});

test("closed reader falls back to its recent checkpoint", async () => {
  const capturedAt = new Date().toISOString();
  mainTraceApi._rememberReaderSnapshotForTests({
    schema_version: 1,
    captured_at: capturedAt,
    events: [{ at: capturedAt, age_ms: 0, type: "page_click", detail: { outcome: "page_next" } }],
    book: { title: "测试图书", format: "epub" },
    reader_state: { chapter: 2, progress: 12 },
  });
  const snapshot = await mainTraceApi.capture({
    timeoutMs: 15,
    eventApi: {
      listen: async () => () => {},
      emit: async () => {},
    },
  });
  assert.equal(snapshot.book.title, "测试图书");
  assert.equal(snapshot.events[0].type, "page_click");
});

test("first trace request is retried after the reader listener becomes ready", async () => {
  let responder = null;
  let requests = 0;
  const capturedAt = new Date().toISOString();
  const snapshot = await mainTraceApi.capture({
    timeoutMs: 90,
    eventApi: {
      listen: async (_name, callback) => {
        responder = callback;
        return () => {};
      },
      emit: async (_name, payload) => {
        requests += 1;
        if (requests === 2) responder({ payload: {
          request_id: payload.request_id,
          snapshot: { schema_version: 1, captured_at: capturedAt, events: [], book: { title: "重试成功" } },
        } });
      },
    },
  });
  assert.equal(requests, 2);
  assert.equal(snapshot.book.title, "重试成功");
});

test("Chinese 注1 cross-chapter references are treated as in-place notes", () => {
  assert.match(layout, /\(\?:注\|註\)\\s\*\\d\{1,5\}/);
  assert.match(layout, /\^zww\\d\{1,5\}\$/);
  assert.match(annotations, /\(\?:\(\?:注\|註\)\\s\*\)\?\\d\{1,4\}/);
  assert.match(annotations, /var footnoteJump=inFootnote\|\|isNoteLink\(a\)/);
  assert.match(annotations, /footnoteJump&&frag\)\{showFootnote\(a,ciT,frag\);return;\}/);
});

test("reader page reports why a click did not turn the page", () => {
  assert.match(pageTrace, /var chapterPending=0/);
  assert.match(pageTrace, /function readerBugTrace\(kind,outcome,e,extra\)/);
  assert.match(pageTrace, /function pagedLayoutSnapshot\(\)/);
  assert.match(pageTrace, /layout_visible_free/);
  assert.match(pageTrace, /layout_content_free/);
  assert.match(pageTrace, /layout_tail_tightened/);
  assert.match(pageTrace, /readerBugTrace\('chapter','chapter_start'/);
  assert.match(pageTrace, /ready\?'chapter_ready':'chapter_error'/);
  assert.match(pageTrace, /function beginPageTurnBugTrace\(direction\)/);
  assert.match(pageTrace, /function finishPageTurnBugTrace\(token\)/);
  assert.match(pageTrace, /chapter_turn_pending/);
  assert.match(pageTrace, /turn_fx_active/);
  assert.match(layout, /beginPageTurnBugTrace\('forward'\)/);
  assert.match(layout, /finishPageTurnBugTrace\(trace\)/);
  assert.match(annotations, /markPageTurnInput\('tap'\)/);
  assert.match(annotations, /markPageTurnInput\('keyboard'\)/);
  assert.match(runtime, /markPageTurnInput\('shell'\)/);
  assert.match(runtime, /function tracePagedImageLayout\(outcome,detail\)/);
  assert.match(runtime, /readerBugTrace\('image_pagination',outcome,null,data\)/);
  assert.match(runtime, /tracePagedImageLayout\('no_candidate'/);
  assert.match(runtime, /tracePagedImageLayout\('fits_full'/);
  assert.match(runtime, /tracePagedImageLayout\('scheduled'/);
  assert.match(pageTrace, /image_candidate_page/);
  assert.match(fs.readFileSync(path.join(uiRoot, "reader-message.js"), "utf8"), /layout_tail_fit/);
  assert.match(fs.readFileSync(path.join(uiRoot, "reader-message.js"), "utf8"), /image_preview_height/);
  assert.match(layout, /beginChapterBugTrace\(i,where\)/);
  assert.match(layout, /finishChapterBugTrace\(bugTraceToken,true,pageInCh\)/);
  ["chapter_pending", "overlay", "drag"].forEach((outcome) => {
    assert.match(annotations, new RegExp("readerBugTrace\\('click','" + outcome + "'"));
  });
  assert.match(annotations, /readerBugTrace\('click',inFootnote\?'footnote':'link',e\)/);
  assert.match(annotations, /readerBugTrace\('click','page_next'/);
  assert.match(annotations, /readerBugTrace\('click','page_prev'/);
  assert.match(annotations, /readerBugTrace\('click','none'/);
  assert.match(annotations, /function tapActionAt\(x,y\)/);
});

test("a transient selection no longer swallows the first page-turn click", () => {
  assert.match(annotations, /if\(didDrag\)\{readerBugTrace\('click','drag',e\);return;\}/);
  assert.match(annotations, /if\(tapHasSelection\(\)\)\{\s*if\(window\.getSelection\)window\.getSelection\(\)\.removeAllRanges\(\);\s*hideSelMenu\(\);\s*\}/s);
  assert.doesNotMatch(annotations, /tapHasSelection\(\)\)\{readerBugTrace\('click','selection',e\);return;/);
  assert.match(annotations, /document\.addEventListener\('mouseup',function\(\)\{downX=null;downY=null;\}\)/);
});
