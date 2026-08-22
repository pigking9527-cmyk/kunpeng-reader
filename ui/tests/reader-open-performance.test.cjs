const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const reader = fs.readFileSync(path.join(ui, "generated-ts", "reader.js"), "utf8");
const shelf = fs.readFileSync(path.join(ui, "generated-ts", "shelf-ui.js"), "utf8");
const layout = require("./reader-page-test-source.cjs").compact;
const epub = fs.readFileSync(path.join(ui, "..", "src", "epub_runtime.rs"), "utf8");
const windows = fs.readFileSync(path.join(ui, "..", "src", "window_commands.rs"), "utf8");

test("book cards prewarm EPUB content without creating a reader shell on hover", () => {
  assert.doesNotMatch(shelf, /openTimer|220/);
  assert.match(shelf, /tauriApi\.invoke\("prewarm_book", \{ id: b\.id \}\)/);
  assert.match(shelf, /addEventListener\("pointerenter", prewarm/);
  const hoverPrewarm = epub.slice(epub.indexOf("async fn prewarm_book"), epub.indexOf("fn process_virtual_chapter"));
  assert.doesNotMatch(hoverPrewarm, /schedule_clean_reader_shell/);
  assert.match(hoverPrewarm, /prewarm_book_data/);
  assert.match(epub, /prewarm_book_data[\s\S]*?if format != "epub"[\s\S]*?ensure_epub_meta[\s\S]*?process_virtual_chapter/);
});

test("recent reading EPUB chapter preparation stays bounded and never keeps extra WebViews", () => {
  assert.match(epub, /RECENT_READING_CHAPTER_CACHE_BOOK_LIMIT: usize = 3/);
  assert.match(epub, /RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT: u64 = 6 \* 1024 \* 1024/);
  assert.match(epub, /fn prewarm_recent_reading_chapters[\s\S]*?take\(RECENT_READING_CHAPTER_CACHE_BOOK_LIMIT\)[\s\S]*?prewarm_book_data/);
  assert.match(epub, /struct ChapterHtmlCache[\s\S]*?entry_order[\s\S]*?book_order[\s\S]*?bytes/);
  assert.match(windows, /fn set_recent_reading_chapter_cache_enabled[\s\S]*?schedule_recent_reading_chapter_cache/);
  assert.match(windows, /fn clear_recent_reading_chapter_cache[\s\S]*?clear_recent_reading_chapter_cache/);
  assert.doesNotMatch(epub.slice(epub.indexOf("fn prewarm_recent_reading_chapters"), epub.indexOf("async fn prewarm_book")), /WebviewWindow|reader\.html/);
});

test("reader starts navigation before ancillary UI", () => {
  const epubNavigation = reader.indexOf("frame.src = readerSource");
  assert.ok(epubNavigation >= 0);
  assert.ok(epubNavigation < reader.indexOf("scheduleAncillaryReaderUi();", epubNavigation));
  assert.match(reader, /requestIdleCallback\(initializeAncillaryReaderUi, \{ timeout: 250 \}\)/);
  assert.match(reader, /frame\.src = readerSource;[\s\S]*?window\.pendingReaderToc = toc/);
  assert.match(reader, /window\.pendingReaderNotesSnapshot = readerNotesSnapshot[\s\S]*?window\.initializeReaderNotes\?\.\(readerNotesSnapshot\)/);
});

test("clean reader shell pool warms UI without binding or reading a book", () => {
  const pooledStart = reader.lastIndexOf("if (isCleanPooledShell)");
  const pooledGuard = reader.slice(pooledStart, pooledStart + 1000);
  assert.match(pooledGuard, /reader-shell-activate[\s\S]*?reader_shell_pool_ready[\s\S]*?return/);
  assert.doesNotMatch(pooledGuard, /book_info|frame\.src|sendProgressNow/);
  assert.match(windows, /reader\.html\?pool=1/);
  assert.match(windows, /take_clean_reader_shell[\s\S]*?reader-shell-activate/);
  assert.match(windows, /READER_WINDOW_BOOK_IDS[\s\S]*?pooled_label[\s\S]*?id_num/);
  assert.match(epub, /book_info[\s\S]*?reader_window_id\(&window\)/);
  assert.match(reader, /listen\("reader-shell-activate"[\s\S]*?readerBookBound = true[\s\S]*?loadBoundReaderBook/);
});

test("reader open timing distinguishes pooled, new, and same-book shells", () => {
  assert.match(windows, /\(open_started, "pooled_shell"\)/);
  assert.match(windows, /\(open_started, "new_shell"\)/);
  assert.match(windows, /source=same_book/);
  assert.match(windows, /reader_open_total/);
});

test("reader switch skips only a freshly confirmed hidden-reader position save", () => {
  const listener = reader.slice(reader.indexOf('listen("reader-switch-request"'), reader.indexOf('listen("reader-hide-request"'));
  const executor = reader.slice(reader.indexOf("async function executeReaderSwitchRequest"), reader.indexOf('listen("reader-switch-request"'));
  assert.match(listener, /readerCloseSettlementPending[\s\S]*?queueReaderSwitchRequest\(request\)[\s\S]*?executeReaderSwitchRequest\(request\)/);
  assert.match(executor, /prepare_reader_switch_target[\s\S]*?requestPagePositionSnapshot/);
  assert.match(executor, /const \{ id, reuseClosedSave \} = request/);
  assert.match(executor, /if \(reuseClosedSave\)[\s\S]*?outcome: "reused_closed_save"[\s\S]*?else \{[\s\S]*?requestPagePositionSnapshot/);
  assert.match(executor, /requestPagePositionSnapshot\(\{\s*turnWaitMs: 180,\s*responseTimeoutMs: 420\s*\}\)[\s\S]*?await sendProgressNow\(\)[\s\S]*?await flushReadWords\(true\)[\s\S]*?complete_reader_switch/);
  assert.match(executor, /cancel_prepared_reader_switch_target/);
  assert.match(executor, /switch_position_snapshot[\s\S]*?snapshotConfirmed \? "confirmed" : "recent_position"/);
});

test("preload prepares a clean shell while a cross-book switch saves state", () => {
  const nativeSwitch = windows.slice(windows.indexOf("// 同一本书直接复用隐藏的 WebView"), windows.indexOf("if let Some(window) = app.get_webview_window(&label)"));
  assert.match(nativeSwitch, /READER_SHELL_PRELOAD_ENABLED[\s\S]*?schedule_clean_reader_shell\(app\)[\s\S]*?"reader-switch-request"/);
  assert.match(windows, /"open_pool", "preparing"/);
  assert.match(windows, /"open_pool", "unavailable"/);
  assert.match(windows, /"open_pool", "activated"/);
  assert.match(nativeSwitch, /skip_final_save[\s\S]*?reader_was_recently_hidden_after_save[\s\S]*?"skipFinalSave": skip_final_save/);
});

test("cached reader marks a confirmed save only after native hide", () => {
  const close = reader.slice(reader.indexOf("async function closeReaderWindow"), reader.indexOf("function reportProgress"));
  assert.match(close, /const positionSnapshot = requestPagePositionSnapshot\([\s\S]*?await invoke\("main_window_close"\);[\s\S]*?pauseHiddenReaderShell\(\{ preservePositionSnapshot: true \}\)[\s\S]*?await positionSnapshot[\s\S]*?const saved = await sendProgressNow\(\);[\s\S]*?if \(saved\) await invoke\("reader_shell_hidden_after_save"\);[\s\S]*?readerWindowClosePending = false/);
  assert.match(windows, /fn reader_was_recently_hidden_after_save[\s\S]*?RECENT_HIDDEN_READER_SAVE_WINDOW/);
});

test("hidden cached readers pause late frame messages and resume only when shown", () => {
  assert.match(reader, /function pauseHiddenReaderShell\(options = \{\}\)[\s\S]*?clearTimeout\(progTimer\)[\s\S]*?clearTimeout\(rwBacktrackResumeTimer\)[\s\S]*?flushReadWords\(true\)/);
  assert.match(reader, /listen\("reader-shell-resume", \(\) => \{[\s\S]*?resumeHiddenReaderShell\(\)[\s\S]*?sendToPage\(\{ sameBookResume: position \}\)/);
  const messages = reader.slice(reader.indexOf('window.addEventListener("message"'));
  assert.match(messages, /if \(readerShellHidden\) \{[\s\S]*?positionSnapshotRequestId[\s\S]*?hiddenReaderResumePosition = sameBookResumePosition[\s\S]*?pending\.resolve\(true\)[\s\S]*?return/);
  assert.match(windows, /clear_recent_hidden_reader_save\(window\.label\(\)\)[\s\S]*?window\.emit\("reader-shell-resume"/);
});

test("initial EPUB layout waits for media and fonts before final measurement", () => {
  const chapter = layout.slice(layout.indexOf("function showChapter"), layout.indexOf("var curTopAnchor"));
  assert.match(chapter, /waitForFlowResources\(\)[\s\S]*?applyStyle\(\);applyCols\(\)/);
});
