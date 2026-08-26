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
const library = fs.readFileSync(path.join(ui, "..", "src", "library_commands.rs"), "utf8");
const mainTrace = fs.readFileSync(path.join(ui, "..", "apps", "desktop-ui", "src", "legacy-ts", "main-settings", "problem-trace-ui.ts"), "utf8");
const preloadUi = fs.readFileSync(path.join(ui, "..", "apps", "desktop-ui", "src", "legacy-ts", "main-settings", "reader-shell-preload-ui.ts"), "utf8");
const mainHtml = fs.readFileSync(path.join(ui, "index.html"), "utf8");

test("book cards prewarm supported content without creating a reader shell on hover", () => {
  assert.doesNotMatch(shelf, /openTimer|220/);
  assert.match(shelf, /tauriApi\.invoke\("prewarm_book", \{ id: b\.id \}\)/);
  assert.match(shelf, /addEventListener\("pointerenter", \(\) => prewarmBook\(\)/);
  const hoverPrewarm = epub.slice(epub.indexOf("async fn prewarm_book"), epub.indexOf("fn process_virtual_chapter"));
  assert.doesNotMatch(hoverPrewarm, /schedule_clean_reader_shell/);
  assert.match(hoverPrewarm, /prewarm_book_data/);
  assert.match(epub, /prewarm_book_data[\s\S]*?format == "pdf"[\s\S]*?prewarm_pdf_source[\s\S]*?format != "epub"[\s\S]*?process_text_chapter[\s\S]*?ensure_epub_meta[\s\S]*?process_virtual_chapter/);
});

test("reader protocol reuses the blocking pool instead of creating one OS thread per resource", () => {
  const protocol = epub.slice(epub.indexOf("pub(crate) fn handle_protocol_request"), epub.indexOf("#[cfg(test)]", epub.indexOf("pub(crate) fn handle_protocol_request")));
  assert.match(protocol, /tauri::async_runtime::spawn_blocking\(move \|\|/u);
  assert.doesNotMatch(protocol, /std::thread::spawn/u);
  assert.match(protocol, /responder\.respond\(response\)/u);
});

test("a prepared resume chapter rides with the reader shell without blocking on cache misses", () => {
  const cachedPayload = epub.slice(
    epub.indexOf("fn cached_initial_chapter_payload"),
    epub.indexOf("#[tauri::command]", epub.indexOf("fn cached_initial_chapter_script")),
  );
  assert.match(cachedPayload, /chapter_html_cache[\s\S]*?\.get\(\([\s\S]*?id,[\s\S]*?source_mtime,[\s\S]*?chapter_index,[\s\S]*?\)\)/u);
  assert.doesNotMatch(cachedPayload, /process_virtual_chapter|process_text_chapter|read_epub_resource/u);
  assert.match(cachedPayload, /MAX_INLINE_INITIAL_CHAPTER_BYTES/u);
  assert.match(cachedPayload, /cached_converted_chapter_body\([\s\S]*?conversion/u);
  assert.match(cachedPayload, /"conversion": conversion\.as_str\(\)/u);
  assert.match(epub, /window\.__INITIAL_CHAPTER__=\{\};/u);
  assert.match(epub, /escape_json_for_inline_script/u);
  assert.match(epub, /query\.split\('&'\)[\s\S]*?name == "tc"[\s\S]*?ReaderTextConversion::parse/u);
  assert.match(reader, /const requestedTextConversion = settings\.textConversion === "t2s" \|\| settings\.textConversion === "s2t"[\s\S]*?const textConversion = requestedTextConversion[\s\S]*?"&tc=" \+ encodeURIComponent\(textConversion\)/u);
  assert.match(layout, /function seedInitialChapterPayload\(\)[\s\S]*?initial\.conversion!==['"]t2s['"][\s\S]*?rememberChapterPayload\(chapterPayloadKey\(chapter,conversion\)/u);
  assert.match(layout, /payloadInlineHit=payloadKey===initialChapterPayloadKey[\s\S]*?payload_inline_hit:payloadInlineHit\?1:0/u);
  assert.match(reader, /READER_PERFORMANCE_METRIC_KEYS[\s\S]*?payload_inline_hit/u);
  assert.match(layout, /seedInitialChapterPayload\(\);\s*showChapter\(rc,'start'\)/u);
});

test("recent reading content preparation supports all formats and is byte-budgeted", () => {
  assert.match(epub, /RECENT_READING_CONTENT_CACHE_BOOK_LIMIT: usize = usize::MAX/);
  assert.match(epub, /RECENT_READING_CHAPTER_CACHE_BYTE_LIMIT: u64 = 32 \* 1024 \* 1024/);
  assert.match(epub, /RECENT_READING_CONVERTED_CHAPTER_CACHE_BYTE_LIMIT: u64 = 12 \* 1024 \* 1024/);
  assert.match(epub, /RECENT_READING_TEXT_CACHE_BYTE_LIMIT: u64 = 44 \* 1024 \* 1024/);
  assert.match(epub, /RECENT_READING_RESOURCE_CACHE_BYTE_LIMIT: u64 = 8 \* 1024 \* 1024/);
  const recent = epub.slice(epub.indexOf("pub(crate) fn prewarm_recent_reading_chapters"), epub.indexOf("pub(crate) async fn prewarm_book"));
  assert.match(recent, /filter\(\|book\| book\.path\.exists\(\)\)/);
  assert.match(epub, /fn recent_reading_prewarm_order[\s\S]*?ids\.into_iter\(\)\.map/);
  assert.doesNotMatch(epub, /take\(RECENT_READING_CONTENT_CACHE_BOOK_LIMIT\)/);
  assert.match(recent, /recent_reading_prewarm_order[\s\S]*?recent_reading_cache_should_yield[\s\S]*?prewarm_book_data[\s\S]*?prepared\.into_iter\(\)\.rev\(\)[\s\S]*?retain_recent_prepared_book/);
  assert.doesNotMatch(recent, /format\.eq_ignore_ascii_case\("epub"\)/);
  assert.match(epub, /fn prewarm_pdf_source[\s\S]*?PDF_READ_AHEAD_BYTES[\s\S]*?PDF_READ_AHEAD_TAIL_BYTES/);
  assert.match(epub, /fn process_text_chapter[\s\S]*?sanitize_mobi_html[\s\S]*?md_to_html[\s\S]*?txt_body/);
  assert.match(epub, /struct ChapterHtmlCache[\s\S]*?entry_order[\s\S]*?book_order[\s\S]*?bytes/);
  assert.match(epub, /struct ConvertedChapterCache[\s\S]*?entry_order[\s\S]*?book_order[\s\S]*?bytes/);
  assert.match(epub, /prewarm_book_data[\s\S]*?prewarm_text_conversion[\s\S]*?cached_converted_chapter_body/);
  assert.match(epub, /fn cached_converted_chapter_body[\s\S]*?chapter_cache::load_converted[\s\S]*?convert_reader_html_text[\s\S]*?chapter_cache::save_converted/u);
  assert.match(windows, /fn set_recent_reading_chapter_cache_enabled[\s\S]*?schedule_recent_reading_chapter_cache/);
  assert.match(windows, /fn schedule_recent_reading_chapter_cache[\s\S]*?RECENT_READING_CACHE_SCHEDULED[\s\S]*?RECENT_READING_CACHE_IDLE_DELAY[\s\S]*?recent_reading_cache_foreground_busy/);
  assert.match(windows, /fn clear_recent_reading_chapter_cache[\s\S]*?clear_recent_reading_content_cache/);
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

test("clean reader shell pool warms the unique inner engine before binding a book", () => {
  const pooledStart = reader.lastIndexOf("if (isCleanPooledShell)");
  const pooledGuard = reader.slice(pooledStart, pooledStart + 1800);
  assert.match(pooledGuard, /reader-shell-activate[\s\S]*?preloadInnerReaderEngine[\s\S]*?reader_shell_inner_engine_url[\s\S]*?frame\.src = engineUrl[\s\S]*?reader_shell_pool_ready[\s\S]*?return/);
  assert.doesNotMatch(pooledGuard, /reader:\/\/localhost\/engine\/0/);
  assert.doesNotMatch(pooledGuard, /book_info|sendProgressNow/);
  assert.match(windows, /reader\.html\?pool=1/);
  assert.match(windows, /take_clean_reader_shell[\s\S]*?reader-shell-activate/);
  assert.match(windows, /READER_WINDOW_BOOK_IDS[\s\S]*?pooled_label[\s\S]*?id_num/);
  assert.match(epub, /book_info[\s\S]*?reader_window_id\(&window\)/);
  assert.match(reader, /listen\("reader-shell-activate"[\s\S]*?readerBookLoadInFlight[\s\S]*?readerBookBound = true[\s\S]*?loadBoundReaderBook/);
  assert.match(reader, /readerEngineWarmReady[\s\S]*?reader_shell_inner_engine_ready/);
  assert.match(reader, /includeInitialChapter: true[\s\S]*?readerEngineBind/);
  assert.match(epub, /"engine"[\s\S]*?__READER_ENGINE_WARM__/);
  assert.match(layout, /readerEngineWarm[\s\S]*?readerEngineBind[\s\S]*?readerEngineWarmReady/);
});

test("native inner-engine URL follows the platform resource base", () => {
  assert.match(windows, /fn reader_shell_inner_engine_url\(\)[\s\S]*?format!\("\{\}\/engine\/0", crate::runtime_support::RES_BASE\)/);
});

test("pooled shells become visible before native activation is dispatched", () => {
  const prepareStart = windows.indexOf("pub(crate) fn prepare_reader_switch_target");
  const prepareEnd = windows.indexOf("pub(crate) fn cancel_prepared_reader_switch_target", prepareStart);
  const prepare = windows.slice(prepareStart, prepareEnd);
  const openStart = windows.indexOf("pub(crate) fn ensure_reader_window");
  const openEnd = windows.indexOf("pub(crate) async fn complete_reader_switch", openStart);
  const pooledOpen = windows.slice(openStart, openEnd);
  for (const source of [prepare, pooledOpen]) {
    assert.ok(source.indexOf("show_pooled_reader_shell") >= 0);
    assert.ok(source.indexOf("show_pooled_reader_shell") < source.indexOf('emit_to(&'));
    assert.match(source, /"open_pool",\s*"visible"[\s\S]*?"open_pool",\s*"activate_emitted"/);
  }
  const listener = reader.slice(reader.indexOf('listen("reader-shell-activate"'), reader.indexOf("reader_shell_pool_ready"));
  assert.match(listener, /readerShellStartedAt = performance\.now\(\);[\s\S]*?recordReaderPerformance\("shell_activate_received", 0\)[\s\S]*?loadBoundReaderBook/);
});

test("a new reader open cancels stale shelf focus retries before touching WebView2", () => {
  const ensureStart = windows.indexOf("pub(crate) fn ensure_reader_window");
  const ensureEnd = windows.indexOf("pub(crate) async fn complete_reader_switch", ensureStart);
  const ensure = windows.slice(ensureStart, ensureEnd);
  assert.ok(ensure.indexOf("cancel_shelf_focus_handoff_for_reader_open()") >= 0);
  assert.ok(ensure.indexOf("cancel_shelf_focus_handoff_for_reader_open()") < ensure.indexOf("request_recent_reading_cache_yield()"));

  const retryStart = windows.indexOf("fn schedule_shelf_focus_handoff_after_hidden_reader");
  const retryEnd = windows.indexOf("fn schedule_shelf_activation_after_reader_close", retryStart);
  const retry = windows.slice(retryStart, retryEnd);
  assert.match(retry, /SHELF_FOCUS_HANDOFF_GENERATION\.load\(Ordering::Acquire\) != generation/);
  assert.match(retry, /"cancelled_reader_open"/);
});

test("prepared reader targets do not steal focus before the old reader is destroyed", () => {
  const prepareStart = windows.indexOf("pub(crate) fn prepare_reader_switch_target");
  const prepareEnd = windows.indexOf("pub(crate) fn cancel_prepared_reader_switch_target", prepareStart);
  const prepare = windows.slice(prepareStart, prepareEnd);
  assert.match(prepare, /show_pooled_reader_shell/);
  assert.doesNotMatch(prepare, /\.set_focus\(\)/);

  const completeStart = windows.indexOf("pub(crate) async fn complete_reader_switch");
  const complete = windows.slice(completeStart);
  assert.match(complete, /window\.destroy\(\)[\s\S]*?prepared\.set_focus\(\)/);
});

test("cross-book completion stays async and shelf open waits for the visible target", () => {
  assert.match(windows, /static READER_SWITCH_COMPLETION_LOCK:[\s\S]*?tokio::sync::Mutex/);
  assert.match(windows, /pub\(crate\) async fn complete_reader_switch[\s\S]*?READER_SWITCH_COMPLETION_LOCK\.lock\(\)\.await/);
  assert.match(windows, /pub\(crate\) async fn wait_for_reader_open_completion[\s\S]*?reader_open_has_completed[\s\S]*?tokio::time::sleep/);
  assert.match(library, /ensure_reader_window[\s\S]*?wait_for_reader_open_completion\(&app, id_num, started\)\.await/);
});

test("pool refill starts after first-screen readiness and gates only rapid queued opens", () => {
  const readyStart = windows.indexOf("pub(crate) fn record_reader_ready");
  const readyEnd = windows.indexOf("fn emit_reader_window_trace", readyStart);
  const ready = windows.slice(readyStart, readyEnd);
  assert.match(ready, /READER_OPEN_STARTED_AT[\s\S]*?schedule_clean_reader_shell_now/);

  const schedulerStart = windows.indexOf("fn schedule_clean_reader_shell_after");
  const schedulerEnd = windows.indexOf("pub(crate) fn reader_shell_pool_ready", schedulerStart);
  const scheduler = windows.slice(schedulerStart, schedulerEnd);
  assert.match(scheduler, /if !delay\.is_zero\(\)[\s\S]*?std::thread::sleep\(delay\)/);
  assert.match(scheduler, /schedule_clean_reader_shell_after\(app, Duration::ZERO\)/);

  const waitStart = windows.indexOf("pub(crate) async fn wait_for_reader_open_completion");
  const waitEnd = windows.indexOf("pub(crate) async fn complete_reader_switch", waitStart);
  const wait = windows.slice(waitStart, waitEnd);
  assert.match(wait, /reader_open_has_completed[\s\S]*?clean_reader_shell_is_ready/);
  assert.match(wait, /Duration::from_millis\(800\)[\s\S]*?open_refill[\s\S]*?timeout/);

  const preparedStart = windows.indexOf("pub(crate) fn prepare_reader_switch_target");
  const preparedEnd = windows.indexOf("pub(crate) fn cancel_prepared_reader_switch_target", preparedStart);
  const prepared = windows.slice(preparedStart, preparedEnd);
  assert.doesNotMatch(prepared, /binding[\s\S]*?schedule_clean_reader_shell/);
});

test("PDF bypasses the reflowable inner-engine pool and a closed failed target releases the queue", () => {
  const prepareStart = windows.indexOf("pub(crate) fn prepare_reader_switch_target");
  const prepareEnd = windows.indexOf("pub(crate) fn cancel_prepared_reader_switch_target", prepareStart);
  const prepare = windows.slice(prepareStart, prepareEnd);
  assert.match(prepare, /format\.eq_ignore_ascii_case\("pdf"\)[\s\S]*?"bypass_pdf"[\s\S]*?return Ok\(false\)/u);

  const ensureStart = windows.indexOf("pub(crate) fn ensure_reader_window");
  const ensureEnd = windows.indexOf("fn reader_open_has_completed", ensureStart);
  const ensure = windows.slice(ensureStart, ensureEnd);
  assert.match(ensure, /can_use_reflowable_pool = !book_format\.eq_ignore_ascii_case\("pdf"\)/u);
  assert.match(ensure, /can_use_reflowable_pool[\s\S]*?take_clean_reader_shell/u);

  const waitStart = windows.indexOf("pub(crate) async fn wait_for_reader_open_completion");
  const waitEnd = windows.indexOf("pub(crate) async fn complete_reader_switch", waitStart);
  const wait = windows.slice(waitStart, waitEnd);
  assert.match(wait, /!target\.is_visible[\s\S]*?READER_OPEN_STARTED_AT[\s\S]*?target\.destroy\(\)[\s\S]*?cancelled_hidden/u);
  assert.match(wait, /Duration::from_millis\(250\)[\s\S]*?target_missing/u);
});

test("shelf pointer-down opens immediately without a click-decision timer", () => {
  const card = shelf.slice(shelf.indexOf("function bookCard"), shelf.indexOf("// 更换封面"));
  assert.match(card, /prewarmBook\(true\);\s*openBook\("pointerdown"\)/);
  assert.doesNotMatch(card, /prepare_shelf_reader_target|complete_shelf_reader_target|primaryOpenTimer|160/);
  assert.doesNotMatch(windows, /pub\(crate\) fn prepare_shelf_reader_target|pub\(crate\) fn complete_shelf_reader_target/);
});

test("reader open timing distinguishes pooled, new, and same-book shells", () => {
  assert.match(windows, /\(open_started, "pooled_shell"\)/);
  assert.match(windows, /\(open_started, "new_shell"\)/);
  assert.match(windows, /source=same_book/);
  assert.match(windows, /reader_open_total/);
});

test("normal reader opens forward every allowlisted first-screen phase to the problem trace", () => {
  for (const stage of [
    "chapter_payload_ready",
    "chapter_styles_ready",
    "chapter_dom_ready",
    "chapter_resources_ready",
    "page_layout_ready",
    "page_displayed",
  ]) {
    assert.match(reader, new RegExp(`OPENING_READER_PAGE_PERFORMANCE_STAGES[\\s\\S]*?${stage}`));
    assert.match(layout, new RegExp(stage));
  }
  const messages = reader.slice(reader.indexOf('window.addEventListener("message"'));
  assert.match(messages, /OPENING_READER_PAGE_PERFORMANCE_STAGES\.has\(e\.data\.readerPerf\)[\s\S]*?recordReaderPerformance\(e\.data\.readerPerf, (?:undefined|void 0), e\.data\.readerPerfMetrics\)/);
  assert.match(reader, /READER_PERFORMANCE_METRIC_KEYS[\s\S]*?stylesheet_cssom_ready[\s\S]*?boundedReaderPerformanceMetrics/u);
  assert.match(reader, /READER_PERFORMANCE_METRIC_KEYS[\s\S]*?image_total[\s\S]*?image_blocking[\s\S]*?image_deferred[\s\S]*?resource_timeout/u);
  assert.match(mainTrace, /image_total[\s\S]*?image_blocking[\s\S]*?image_deferred[\s\S]*?resource_timeout/u);
  assert.match(reader, /READER_PERFORMANCE_METRIC_KEYS[\s\S]*?layout_frame_wait_ms[\s\S]*?layout_apply_ms[\s\S]*?layout_finalize_ms[\s\S]*?display_frame_wait_ms/u);
  assert.match(reader, /readerPerformanceOpeningId[\s\S]*?openingId: readerPerformanceOpeningId/u);
  const loadInit = layout.slice(layout.indexOf("function loadInit("), layout.indexOf("function requiredHtmlElement"));
  assert.doesNotMatch(loadInit, /if\(benchmark\)\{\s*parent\.postMessage\(\{readerPerf:'page_layout_ready'/);
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

test("cached reader marks a confirmed save without blocking the next open", () => {
  const close = reader.slice(reader.indexOf("async function closeReaderWindow"), reader.indexOf("function reportProgress"));
  assert.match(close, /const positionSnapshot = requestPagePositionSnapshot\([\s\S]*?await invoke\("main_window_close"\);[\s\S]*?pauseHiddenReaderShell\(\{ preservePositionSnapshot: true \}\)[\s\S]*?await positionSnapshot[\s\S]*?const saved = await sendProgressNow\(\);[\s\S]*?if \(saved\) \{[\s\S]*?void invoke\("reader_shell_hidden_after_save"\)[\s\S]*?readerWindowClosePending = false/);
  assert.doesNotMatch(close, /await invoke\("reader_shell_hidden_after_save"\)/);
  assert.match(windows, /fn reader_was_recently_hidden_after_save[\s\S]*?RECENT_HIDDEN_READER_SAVE_WINDOW/);
});

test("hidden cached readers pause late frame messages and resume only when shown", () => {
  assert.match(reader, /function pauseHiddenReaderShell\(options = \{\}\)[\s\S]*?clearTimeout\(progTimer\)[\s\S]*?clearTimeout\(rwBacktrackResumeTimer\)[\s\S]*?flushReadWords\(true\)/);
  assert.match(reader, /listen\("reader-shell-resume", \(\) => \{[\s\S]*?resumeHiddenReaderShell\(\)[\s\S]*?sendToPage\(\{ sameBookResume: position \}\)/);
  const messages = reader.slice(reader.indexOf('window.addEventListener("message"'));
  assert.match(messages, /if \(readerShellHidden\) \{[\s\S]*?positionSnapshotRequestId[\s\S]*?hiddenReaderResumePosition = sameBookResumePosition[\s\S]*?pending\.resolve\(true\)[\s\S]*?return/);
  assert.match(windows, /clear_recent_hidden_reader_save\(window\.label\(\)\)[\s\S]*?emit_to\(window\.label\(\), "reader-shell-resume"/);
});

test("initial EPUB layout waits for media and fonts before final measurement", () => {
  const chapter = layout.slice(layout.indexOf("function showChapter"), layout.indexOf("var curTopAnchor"));
  assert.match(chapter, /waitForFlowResources\(\)[\s\S]*?applyStyle\(\);applyCols\(\)/);
  assert.match(layout, /function flowImageBlocksInitialLayout[\s\S]*?if\(!isScrollMode\(\)\)return true;[\s\S]*?rect\.top<=view\.bottom/);
  assert.match(layout, /function installChapterBodyForInitialLayout[\s\S]*?createElement\('template'\)[\s\S]*?loading='lazy'[\s\S]*?replaceChildren\(template\.content\)/);
  assert.match(layout, /if\(!flowImageBlocksInitialLayout\(img\)\)\{img\.loading='lazy'[\s\S]*?if\(img\.loading==='lazy'\)img\.loading='eager'/);
  assert.match(chapter, /chapter_resources_ready',resourceMetrics/);
});

test("opening benchmark compares cold ordinary opens with fully preloaded opens", () => {
  const benchmark = windows.slice(windows.indexOf("fn build_benchmark_reader_window"), windows.indexOf("pub(crate) fn record_reader_ready"));
  assert.match(benchmark, /\.visible\(initially_visible\)[\s\S]*?\.focused\(false\)[\s\S]*?\.skip_taskbar\(true\)/);
  assert.match(windows, /READER_SHELL_BENCHMARK_ROUNDS: usize = 3/);
  assert.match(benchmark, /fn benchmark_cold_regular_reader_open[\s\S]*?evict_recent_reading_content_book[\s\S]*?benchmark_regular_reader_open/);
  assert.match(benchmark, /fn benchmark_fully_preloaded_reader_open[\s\S]*?prewarm_book_data[\s\S]*?benchmark_preloaded_reader_open/);
  assert.match(benchmark, /struct BenchmarkBookCacheRestore[\s\S]*?impl Drop[\s\S]*?prewarm_book_data/);
  assert.match(benchmark, /benchmark_fully_preloaded_reader_open[\s\S]*?for round/);
  assert.match(benchmark, /for round[\s\S]*?benchmark_cold_regular_reader_open[\s\S]*?benchmark_fully_preloaded_reader_open/);
  assert.match(benchmark, /\(book_index \+ round\) % 2/);
  assert.match(benchmark, /fn clear_benchmark_reader_window[\s\S]*?window\.hide\(\)[\s\S]*?window\.destroy\(\)[\s\S]*?get_webview_window\(label\)[\s\S]*?READER_WINDOW_BOOK_IDS/);
  assert.match(windows, /fn reader_id_from_label[\s\S]*?!id\.contains\('-'\)/);
  assert.doesNotMatch(benchmark, /shell_preloaded_(?:median|p95)|shell_preloaded_runs|all_shell_preloaded_times|inner_engine_improvement/);
  for (const phase of ["chapter_payload_ready", "chapter_styles_ready", "chapter_dom_ready", "chapter_resources_ready", "page_layout_ready", "page_displayed"]) {
    assert.match(layout, new RegExp(phase));
  }
  const nativePhases = windows.slice(windows.indexOf("fn benchmark_phase_at_native_elapsed"), windows.indexOf("fn build_benchmark_reader_window"));
  assert.match(nativePhases, /ShellBootstrap\(_\)[\s\S]*?ShellBootstrap\(elapsed_ms\)/);
  assert.match(nativePhases, /FrameReady\(_\)[\s\S]*?FrameReady\(elapsed_ms\)/);
});

test("settings distinguish actual shelf latency from the idealized EPUB preload hit", () => {
  assert.match(windows, /RECENT_ACTUAL_READER_OPENS[\s\S]*?RECENT_ACTUAL_READER_OPEN_LIMIT/);
  assert.match(windows, /record_actual_reader_open[\s\S]*?pdf_bypass[\s\S]*?preloaded_hit[\s\S]*?cold_window/);
  assert.match(windows, /click_to_first_screen_ms[\s\S]*?first_screen_to_refill_ms[\s\S]*?click_to_complete_ms/);
  assert.match(library, /wait_for_reader_open_completion\(&app, id_num, started\)[\s\S]*?record_actual_reader_open/);
  assert.match(mainHtml, /id="reader-shell-actual-open-status"/);
  assert.match(preloadUi, /EPUB 完全冷开[\s\S]*?EPUB 预加载命中/);
  assert.match(preloadUi, /PDF 独立冷开（不使用 EPUB 预加载）/u);
});
