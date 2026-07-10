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
