import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./reader.ts", import.meta.url);

function values(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string")
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

test("reader shell freezes the original native, event, DOM and storage contract", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const [pattern, expected] of [
    [/\binvoke(?:<[^>]+>)?\(\s*["']([^"']+)/gu, ["add_bookmark", "add_read_words", "add_reading_time", "ai_reader_profiles", "ai_reader_status", "ask_reading_assistant", "assign_ai_reader_profile", "begin_page_count_task", "begin_reader_media_generation_cycle", "book_info", "book_meta", "cancel_prepared_reader_switch_target", "capture_reading_memory", "complete_reader_switch", "create_reader_media_video", "dict_lookup", "edge_tts", "finish_reader_media_generation_cycle", "generate_reader_media_image", "get_page_cache", "get_pdf_state", "main_window_close", "main_window_minimize", "main_window_toggle_maximize", "open_book_at", "prepare_reader_switch_target", "private_sync_history_delete", "private_sync_history_merge", "private_sync_reader_history_snapshot", "private_sync_set_reader_history_cloud_saved", "private_sync_set_reader_history_mode", "query_reader_media_video", "reader_companion_settings_get", "reader_companion_settings_save", "reader_perf_log", "reader_shell_hidden_after_save", "reader_shell_inner_engine_ready", "reader_shell_inner_engine_url", "reader_shell_pool_ready", "reader_window_diagnostic_state", "remove_highlight", "report_page_count_task", "save_download_image", "save_page_cache", "save_translation_credential", "set_book_description", "set_book_rating", "set_book_title", "set_highlight_color", "set_highlight_note", "set_highlight_text", "set_pdf_state", "set_progress", "set_translation_active_provider", "similar_books", "take_pending_jump", "translate_text", "translation_credential_status", "translation_credentials_status", "vocab_add", "web_search"]],
    [/\blisten\(\s*["']([^"']+)/gu, ["reader-bug-trace-request", "reader-bug-trace-reset", "reader-hide-request", "reader-shell-activate", "reader-shell-resume", "reader-switch-request", "shelf-jump"]],
    [/\bemit\(\s*["']([^"']+)/gu, ["reader-bug-trace-response", "reader-gesture-action", "reader-performance-trace"]],
    [/getElementById(?:<[^>]+>)?\(\s*["']([^"']+)/gu, ["ai-reader-answer", "ai-reader-ask", "ai-reader-audit", "ai-reader-btn", "ai-reader-close", "ai-reader-companion-characters", "ai-reader-companion-negative", "ai-reader-companion-settings", "ai-reader-companion-settings-close", "ai-reader-companion-settings-panel", "ai-reader-companion-settings-save", "ai-reader-companion-settings-status", "ai-reader-companion-style", "ai-reader-enter-submit", "ai-reader-history", "ai-reader-history-btn", "ai-reader-history-menu", "ai-reader-history-settings-btn", "ai-reader-image", "ai-reader-media-cancel", "ai-reader-media-composer", "ai-reader-media-consent", "ai-reader-media-consent-copy", "ai-reader-media-prompt", "ai-reader-media-result", "ai-reader-media-submit", "ai-reader-media-title", "ai-reader-mindmap", "ai-reader-profile", "ai-reader-question", "ai-reader-side", "ai-reader-source-preview", "ai-reader-sources", "ai-reader-status", "ai-reader-summary", "ai-reader-video", "backdrop", "book-progress", "book-progress-fill", "book-progress-restore", "book-progress-thumb", "book-progress-track", "chapter-number", "chapter-page", "chapter-progress", "frame", "immersive-btn", "info-btn", "info-modal", "loading", "pdf-dual", "progress", "progress-percentage", "reader-end-close", "reader-end-list", "reader-end-modal", "reader-jump-back", "reader-progress-group", "settings", "toc", "toc-pane", "tts-btn", "vbar", "vthumb", "win-close", "win-max", "win-min", "zoom-in", "zoom-out"]],
    [/(?:getItem|setItem|removeItem)\(\s*["']([^"']+)/gu, ["debugSettingsV1", "readerMediaPolicyV1"]],
  ] as const) {
    assert.deepEqual(values(source, pattern), [...expected].sort());
  }
  assert.match(source, /transportFromTauriGlobal\(target\)/u);
  assert.doesNotMatch(source, /window\.__TAURI__|\bany\b|@ts-(?:ignore|expect-error|nocheck)|eval\s*\(|new\s+Function/u);
});

test("reader startup failures record only fixed window and binding diagnostics", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /function readerWindowRole\(\)/u);
  assert.match(source, /function readerStartupErrorCategory\(error: unknown\)/u);
  assert.match(source, /window\.ReaderBugTrace\?\.record\?\.\("book_load_failed"/u);
  assert.match(source, /window_role: readerWindowRole\(\)/u);
  assert.match(source, /document_visible: readerDocumentVisible\(\)/u);
  assert.match(source, /"reader_window_diagnostic_state"/u);
  assert.match(source, /window_visible: nativeWindowState\.window_visible/u);
  assert.match(source, /book_bound: readerBookBound/u);
  assert.match(source, /recordReaderStartupFailure\(readerStartupPhase, e\)/u);
  assert.doesNotMatch(source, /book_load_failed[\s\S]{0,500}(?:path|title|book_id):/u);
});

test("pooled reader activation is scoped and can recover from an earlier unbound attempt", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /transportFromTauriGlobal\(target\)/u);
  assert.match(source, /if \(currentBookId\) return/u);
  assert.match(source, /if \(readerBookLoadInFlight\) \{\s*readerBookActivationPending = true/u);
  assert.match(source, /do \{[\s\S]*?await loadBoundReaderBook\(\)[\s\S]*?\} while \(readerBookActivationPending && !currentBookId\)/u);
});

test("automatic companion and memory work only after a completed chapter", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /currentFraction:\s*1,/u);
  assert.doesNotMatch(source, /currentFraction:\s*0\.5,/u);
  assert.match(source, /previousFraction >= 0\.98/u);
  assert.match(source, /queueCompletedReadingMemory\(previousChapter, curChapter, curChFrac\)/u);
  assert.match(source, /"capture_reading_memory"/u);
  assert.match(source, /const readerMemoryCapturePending = new Map<string, ReadingMemoryCaptureJob>\(\)/u);
  assert.match(source, /async function drainReadingMemoryCaptureQueue\(\)/u);
  assert.match(source, /job\.retries < 1/u);
});

test("companion visual guidance is loaded locally per book and attached to prompts", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /reader_companion_settings_get/u);
  assert.match(source, /reader_companion_settings_save/u);
  assert.match(source, /function companionVisualGuidance\(\)/u);
  assert.match(source, /function companionPromptWithGuidance\(/u);
  assert.match(source, /question: `\$\{instruction\}\$\{companionVisualGuidance\(\)/u);
  assert.match(source, /prompt: companionPromptWithGuidance\(plan\.prompt/u);
  assert.match(source, /void loadReaderCompanionSettings\(\);/u);
});

test("automatic companion prepares completed chapters before rotating GPU to H3", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const batchStart = source.indexOf("async function flushReaderContextMediaBatch");
  const batchEnd = source.indexOf("function observeReaderContextMediaChapter", batchStart);
  const batch = source.slice(batchStart, batchEnd);

  assert.match(source, /task:\s*"companion_prompt"/u);
  assert.match(source, /previousFraction >= 0\.98/u);
  assert.match(source, /readerContextMediaPolicy\(\) !== "auto"/u);
  assert.match(source, /readerMediaImageDensity/u);
  assert.match(source, /readerMediaVideoDensity/u);
  for (const placement of ["chapterStart", "chapterEnd"]) {
    assert.match(source, new RegExp(`placement: "${placement}"`, "u"));
  }

  // Prompt plans must be completed while the local understanding model is
  // still available. Only then can the native lease stop it and start H3.
  assert.ok(batch.indexOf("buildContextMediaPromptPlans") < batch.indexOf("beginReaderMediaCycle"));
  assert.ok(batch.indexOf("beginReaderMediaCycle") < batch.indexOf("generateReaderContextMediaPlan"));
  assert.ok(batch.indexOf("finishReaderMediaCycle") > batch.indexOf("generateReaderContextMediaPlan"));
  assert.match(batch, /slice\(0, 3\)/u);
});

test("IIFE keeps one dynamic reader state and resolves post-shell dependencies lazily", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const name of ["curChapter", "curProgress", "curChFrac", "curReadingAnchor", "isPdf"]) {
    assert.ok(source.includes(`exposeReaderState("${name}"`), `missing ${name} accessor`);
  }
  for (const dependency of [
    "openCrossSearch", "openSemanticSearch", "prefetchMicrosoftWord", "speakMicrosoftWord",
    "scheduleTocBuild", "addHighlight", "addCorrectedHighlight", "openAnnotations",
    "renderHighlights", "renderBookmarks", "markToc",
  ]) {
    assert.doesNotMatch(source, new RegExp(`window\\.${dependency}\\.bind`));
    assert.match(source, new RegExp(`window\\.${dependency}\\?\\.`));
  }
  assert.match(source, /window\.closeReaderWindow = closeReaderWindow/u);
  assert.match(source, /window\.readerDebugSettingOn = readerDebugSettingOn/u);
});

test("reader close hides first and completes the final position save in the cached shell", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const closeStart = source.indexOf("async function closeReaderWindow");
  const closeEnd = source.indexOf("window.closeReaderWindow = closeReaderWindow", closeStart);
  const closeSource = source.slice(closeStart, closeEnd);

  assert.match(closeSource, /turnWaitMs:\s*180/u);
  assert.match(closeSource, /responseTimeoutMs:\s*420/u);
  assert.ok(
    closeSource.indexOf('await invoke("main_window_close")') <
      closeSource.indexOf("const saved = await sendProgressNow()"),
  );
  assert.match(closeSource, /pauseHiddenReaderShell\(\{ preservePositionSnapshot: true \}\)/u);
  assert.doesNotMatch(closeSource, /await requestPagePositionSnapshot\(\)/u);
});

test("same-book reveal blocks transient saves until the exact page anchor is restored", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const pauseStart = source.indexOf("function pauseHiddenReaderShell");
  const reportStart = source.indexOf("function reportProgress", pauseStart);
  const resumeSource = source.slice(pauseStart, reportStart);

  assert.match(resumeSource, /hiddenReaderResumePosition = sameBookResumePosition\(curChapter, curReadingAnchor\)/u);
  assert.match(resumeSource, /sendToPage\(\{ sameBookResume: position \}\)/u);
  assert.match(resumeSource, /sameBookResumePending = true/u);
  assert.match(source, /if \(sameBookResumePending\) \{[\s\S]*?save_suppressed: true[\s\S]*?return Promise\.resolve\(false\)/u);
  assert.match(source, /if \(!readerBookBound \|\| readerShellHidden \|\| sameBookResumePending\) return/u);
  assert.match(source, /e\.data\.positionRestored === 1 && sameBookResumePending[\s\S]*?sameBookResumePending = false/u);
  assert.match(source, /if \(readerShellHidden\) \{[\s\S]*?positionSnapshotRequestId[\s\S]*?hiddenReaderResumePosition = sameBookResumePosition\(curChapter, curReadingAnchor\)[\s\S]*?pending\.resolve\(true\)/u);
  assert.match(source, /resumeRestoreWasPending = sameBookResumePending[\s\S]*?if \(!saved && !resumeRestoreWasPending\)/u);
});

test("a switch request arriving during close settlement is replayed once instead of dropped", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const queueStart = source.indexOf("function queueReaderSwitchRequest");
  const listenerEnd = source.indexOf('listen("reader-hide-request"', queueStart);
  const queueSource = source.slice(queueStart, listenerEnd);
  const closeStart = source.indexOf("async function closeReaderWindow");
  const closeEnd = source.indexOf("window.closeReaderWindow = closeReaderWindow", closeStart);
  const closeSource = source.slice(closeStart, closeEnd);

  assert.match(queueSource, /queued\?\.id === request\.id[\s\S]*?sequence: queued\.sequence[\s\S]*?queuedAt: queued\.queuedAt/u);
  assert.match(queueSource, /queuedReaderSwitchRequest = null[\s\S]*?age > READER_SWITCH_QUEUE_MAX_AGE_MS/u);
  assert.match(queueSource, /recordReaderSwitchQueue\("replayed", "started"[\s\S]*?executeReaderSwitchRequest\(queued\)/u);
  assert.match(queueSource, /if \(readerWindowClosePending\) \{\s*if \(readerCloseSettlementPending\) queueReaderSwitchRequest\(request\)/u);
  assert.match(queueSource, /reason: "switch_in_progress"/u);
  assert.match(closeSource, /readerCloseSettlementPending = true/u);
  assert.match(closeSource, /\.finally\(\(\) => \{[\s\S]*?readerCloseSettlementPending = false[\s\S]*?readerWindowClosePending = false[\s\S]*?replayQueuedReaderSwitchRequest\(\)/u);
});
