const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The repository root is ESM for the typed build toolchain, but this file is
// also loaded as a classic browser script.  Exercise its UMD CommonJS branch
// in an actual CommonJS-shaped context rather than relying on Node's ESM
// namespace returned by require("../reader-message.js").
function loadGuard(context) {
  const source = fs.readFileSync(path.join(__dirname, "..", "reader-message.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    Set,
    Object,
    Array,
    JSON,
    Number,
    ...context,
  }, { filename: "reader-message.js" });
  return context;
}

const commonJsModule = { exports: {} };
loadGuard({ module: commonJsModule, exports: commonJsModule.exports, globalThis: {} });
const guard = commonJsModule.exports;

test("exposes the same guard through classic-script and CommonJS entry points", () => {
  const browserGlobal = {};
  loadGuard({ globalThis: browserGlobal });
  assert.equal(typeof guard.validateData, "function");
  assert.equal(typeof guard.validateEvent, "function");
  assert.equal(typeof guard.normalizeEvent, "function");
  assert.equal(typeof browserGlobal.ReaderMessageGuard?.validateData, "function");
  assert.equal(typeof browserGlobal.ReaderMessageGuard?.validateEvent, "function");
  assert.equal(typeof browserGlobal.ReaderMessageGuard?.normalizeEvent, "function");
  assert.equal(browserGlobal.ReaderMessageGuard.validateData({ ready: 1 }), true);
  assert.equal(browserGlobal.ReaderMessageGuard.validateData({ untrusted: 1 }), false);
});

function eventFor(data, overrides = {}) {
  const contentWindow = {};
  const frame = { src: "http://reader.localhost/book/7", contentWindow };
  const event = {
    data,
    source: contentWindow,
    origin: "http://reader.localhost",
    ...overrides,
  };
  return { event, frame };
}

test("accepts a bounded allowlisted message from the current frame", () => {
  const { event, frame } = eventFor({ webSearch: "safe term" });
  assert.equal(guard.validateEvent(event, frame, { href: "http://tauri.localhost/reader.html" }), true);
  assert.equal(guard.validateData({ readerNavigated: 1 }), true);
  assert.equal(guard.validateData({ readerJump: { kind: "link", chapter: 4, chFrac: 0.25 } }), true);
  assert.equal(guard.validateData({ readerJump: { kind: "footnote", chapter: 4, chFrac: 0.25 } }), true);
  assert.equal(guard.validateData({ readerJump: { kind: "external", chapter: 4, chFrac: 0.25 } }), false);
  assert.equal(guard.validateData({ readerJump: { kind: "link", chapter: 4, chFrac: 1.5 } }), false);
});

test("keeps legacy raw payloads compatible while routing typed envelopes through the bridge", () => {
  const { event, frame } = eventFor({ ready: 1 });
  assert.deepEqual(guard.normalizeEvent(event, frame, { href: "http://tauri.localhost/reader.html" }), { ready: 1 });

  const typedEvent = {
    ...eventFor({ protocol: "kunpeng-reader-engine", version: 1, action: "ready", payload: { engine: "epub" } }).event,
  };
  const typedFrame = { src: "http://reader.localhost/book/7", contentWindow: typedEvent.source };
  const bridgeModule = { exports: {} };
  loadGuard({
    module: bridgeModule,
    exports: bridgeModule.exports,
    globalThis: {
      KunpengReaderProtocolBridge: {
        isReaderFrameProtocolEnvelope: (value) => value?.protocol === "kunpeng-reader-engine",
        normalizeReaderFrameProtocolEvent: (value) => {
          if (value.origin !== "http://reader.localhost") return null;
          return { ready: 1 };
        },
      },
    },
  });
  assert.deepEqual(bridgeModule.exports.normalizeEvent(typedEvent, typedFrame, { href: "http://tauri.localhost/reader.html" }), { ready: 1 });
});

test("bug traces accept only bounded metadata and never raw text or links", () => {
  assert.equal(guard.validateData({
    bugTrace: {
      kind: "click",
      source: "reader_page",
      outcome: "selection",
      zone: "right",
      target: "p",
      chapter: 3,
      page: 8,
      x_pct: 82.4,
    },
  }), true);
  const richWheelTurn = {
    kind: "turn", source: "reader_page", outcome: "requested", target: "unknown",
    chapter: 3, page: 8, pages: 19, chapter_pending: 0, chapter_turn_pending: false,
    turn_fx_active: false, turn_timer_active: false, scroll_paged: false, flow_mode: "paged", page_mode: "single",
    direction: "forward", turn_id: 8, input: "wheel", before_chapter: 3, before_page: 8,
    wheel_seq: 8, wheel_delta_x: 0, wheel_delta_y: 1.25, wheel_delta_px: 1.25,
    wheel_delta_mode: 0, wheel_gap_ms: 16, wheel_accumulated_px: 0, wheel_threshold_px: 2,
    wheel_quiet_ms: 36, wheel_gesture_age_ms: 32, wheel_gesture_active: true, wheel_timer_active: true,
    wheel_event_cancelable: true, wheel_replay: false, wheel_mode_pending: false,
    layout_fast: true, layout_view_height: 768, layout_root_height: 768, layout_root_style_height: 768,
    layout_padding_bottom: 0, layout_line_height: 23, layout_step: 1119, layout_current_line_count: 31,
    layout_last_top: 721, layout_last_bottom: 744, layout_last_height: 23, layout_next_top: 1,
    layout_next_bottom: 24, layout_next_height: 23, layout_visible_free: 24, layout_content_free: 24,
    layout_tail_cross: 0, layout_tail_fit: 0, layout_tail_tightened: 0,
  };
  assert.ok(Object.keys(richWheelTurn).length > 48);
  assert.equal(guard.validateData({ bugTrace: richWheelTurn }), true);
  assert.equal(guard.validateData({
    bugTrace: {
      kind: "image_pagination", source: "reader_page", outcome: "no_candidate", target: "unknown",
      chapter: 3, page: 8, pages: 19, chapter_pending: 0, chapter_turn_pending: false,
      turn_fx_active: false, turn_timer_active: false, scroll_paged: false, flow_mode: "paged", page_mode: "single",
      image_mode: "continuous", image_source_page: 8, image_candidate_page: 9,
      image_top: 126, image_width: 903, image_height: 730, image_free_height: 318,
      image_preview_height: 0, image_next_count: 1, image_future_count: 1, image_skipped_text: 0,
      image_near_top: false, image_text_before: false, image_probed: true,
    },
  }), true);
  assert.equal(guard.validateData({
    bugTrace: {
      kind: "wheel", source: "reader_page", outcome: "ignored", target: "unknown",
      chapter: 3, page: 8, pages: 19, chapter_pending: 0, chapter_turn_pending: false,
      turn_fx_active: false, turn_timer_active: false, scroll_paged: false, flow_mode: "paged", page_mode: "single",
      direction: "forward", wheel_seq: 8, wheel_delta_x: 0, wheel_delta_y: 1.25, wheel_delta_px: 1.25,
      wheel_delta_mode: 0, wheel_gap_ms: 16, wheel_accumulated_px: 0, wheel_threshold_px: 2,
      wheel_quiet_ms: 36, wheel_gesture_age_ms: 32, wheel_gesture_active: true, wheel_timer_active: true,
      wheel_event_cancelable: true, wheel_replay: false, wheel_mode_pending: false,
    },
  }), true);
  assert.equal(guard.validateData({
    bugTrace: { kind: "click", outcome: "link", href: "https://secret.invalid" },
  }), false);
  assert.equal(guard.validateData({
    bugTrace: { kind: "click", outcome: "selection", text: "选中的正文" },
  }), false);
});

test("web search accepts only the supported local engine choices", () => {
  assert.equal(guard.validateData({ webSearch: { term: "南明史", engine: "baidu" } }), true);
  assert.equal(guard.validateData({ webSearch: { term: "南明史", engine: "google" } }), true);
  assert.equal(guard.validateData({ webSearch: { term: "南明史", engine: "other" } }), false);
});

test("rejects forged sources and origins", () => {
  const { event, frame } = eventFor({ ready: 1 });
  const location = { href: "http://tauri.localhost/reader.html" };
  assert.equal(guard.validateEvent({ ...event, source: {} }, frame, location), false);
  assert.equal(guard.validateEvent({ ...event, origin: "https://evil.test" }, frame, location), false);
  assert.equal(guard.validateEvent({ ...event, origin: "null" }, frame, location), false);
  assert.equal(guard.validateEvent({ ...event, origin: "" }, frame, location), false);
});

test("rejects unknown or ambiguous actions", () => {
  assert.equal(guard.validateData({ launchAnything: 1 }), false);
  assert.equal(guard.validateData({ webSearch: "x", semanticSearch: "x" }), false);
  assert.equal(guard.validateData([]), false);
});

test("智读选区请求只接受受限文本", () => {
  assert.equal(guard.validateData({ aiReader: { text: "这一段是什么意思？" } }), true);
  assert.equal(guard.validateData({ aiReader: { text: "这一段是什么意思？", anchorStart: 20, anchorEnd: 42 } }), true);
  assert.equal(guard.validateData({ aiReader: { text: "这一段是什么意思？", anchorStart: 42, anchorEnd: 20 } }), false);
  assert.equal(guard.validateData({ aiReader: { text: "x".repeat(20_001) } }), false);
  assert.equal(guard.validateData({ aiReader: "任意对象外的内容" }), false);
});

test("highlight color changes allow only the four built-in palette keys", () => {
  assert.equal(guard.validateData({ setHighlightColor: { index: 3, color: "g" } }), true);
  assert.equal(guard.validateData({ setHighlightColor: { index: -1, color: "g" } }), false);
  assert.equal(guard.validateData({ setHighlightColor: { index: 3, color: "orange" } }), false);
});

test("highlight menu preferences allow only bounded visual settings", () => {
  assert.equal(guard.validateData({
    readerHighlightMenuPreferences: {
      displayMode: "text",
      layout: "grid",
      size: "medium",
      webSearchEngine: "baidu",
      colorful: true,
      actions: [{ key: "web", visible: true }],
    },
  }), true);
  assert.equal(guard.validateData({
    readerHighlightMenuPreferences: { layout: "grid", selectedText: "不应跨 iframe 传递" },
  }), false);
  assert.equal(guard.validateData({
    readerHighlightMenuPreferences: { actions: [{ key: "web", visible: "true" }] },
  }), false);
  assert.equal(guard.validateData({ readerHighlightMenuPreferencesReady: true }), true);
  assert.equal(guard.validateData({ readerHighlightMenuPreferencesReady: "true" }), false);
  assert.equal(guard.validateData({
    readerHighlightMenuSettings: { requestId: 1, settings: { colorful: false } },
  }), true);
  assert.equal(guard.validateData({
    readerHighlightMenuSettings: { requestId: 1, settings: { colorful: false, selectedText: "x" } },
  }), false);
});

test("legacy guard does not expose a separate highlighter settings opener", () => {
  assert.equal(guard.validateData({ openHighlightMenu: 1 }), false);
  assert.equal(guard.validateData({ openHighlightMenu: true }), false);
});

test("translation actions accept only a credential config id", () => {
  assert.equal(guard.validateData({
    translateText: {
      text: "hello",
      source: "auto",
      target: "zh-CN",
      provider: "baidu",
      credentialConfigId: "translate:baidu",
    },
  }), true);
  assert.equal(guard.validateData({
    translateText: { text: "x".repeat(20_001), credentialConfigId: "translate:baidu" },
  }), false);
});

test("download images require an allowlisted data URL and size bound", () => {
  assert.equal(guard.validateData({
    downloadImage: { name: "摘录.png", dataUrl: "data:image/png;base64,AAAA" },
  }), true);
  assert.equal(guard.validateData({
    downloadImage: { name: "x", dataUrl: "data:text/html;base64,AAAA" },
  }), false);
});

test("page-count caches are allowlisted with bounded numeric contents", () => {
  assert.equal(guard.validateData({
    pageCache: { sig: "1024|700|18", pages: [4, 7, 2], complete: true },
  }), true);
  assert.equal(guard.validateData({
    pageCache: { sig: "x", pages: [1, -1], complete: false },
  }), false);
});

test("reader gesture messages contain only a bounded phase and coordinates", () => {
  assert.equal(guard.validateData({ readerGesture: { phase: "start", x: 16, y: 32 } }), true);
  assert.equal(guard.validateData({ readerGesture: { phase: "move", x: 1e9, y: 0 } }), false);
  assert.equal(guard.validateData({ readerGesture: { phase: "run", x: 16, y: 32 } }), false);
  assert.equal(guard.validateData({ readerGesture: { phase: "end", x: "16", y: 32 } }), false);
});
