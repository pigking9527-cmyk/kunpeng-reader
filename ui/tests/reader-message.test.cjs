const test = require("node:test");
const assert = require("node:assert/strict");
const guard = require("../reader-message.js");

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
