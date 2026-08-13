const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "news-rules.js"), "utf8");

function rules() {
  const context = { URL };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "news-rules.js" });
  return context.ReaderNewsRules;
}

test("news rules only accept safe HTTPS links and supported image data URLs", () => {
  const news = rules();
  assert.equal(news.safeHttpUrl("https://example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(news.safeHttpUrl("http://example.com/a"), "");
  assert.equal(news.safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(news.safeImageDataUrl("data:image/png;base64,aGVsbG8="), "data:image/png;base64,aGVsbG8=");
  assert.equal(news.safeImageDataUrl("data:text/html;base64,PGgxPg=="), "");
});

test("news rules normalize result envelopes and identify outstanding visible previews", () => {
  const news = rules();
  const item = { url: "https://example.com/a" };
  assert.deepEqual(Array.from(news.resultItems({ data: [item] })), [item]);
  assert.deepEqual(Array.from(news.resultItems({ nope: [] })), []);
  assert.equal(news.previewAttempted({ preview_attempted: true }), true);
  assert.equal(news.previewAttempted({ previewDataUrl: "data:image/gif;base64,QQ==" }), true);
  assert.equal(news.hasPendingPreviews({ items: [item, { url: "http://example.com/b" }] }), true);
  assert.equal(news.hasPendingPreviews({ items: [{ ...item, previewAttempted: true }] }), false);
});

test("news rules constrain catalog selections and Tieba subscriptions without mutating input", () => {
  const news = rules();
  const catalog = [
    { id: "a", defaultEnabled: true },
    { id: "b", default_enabled: true },
    { id: "tieba" },
  ];
  const requested = ["b", "bad", "a", "b", "tieba"];
  assert.deepEqual(Array.from(news.defaultSourceIds(catalog)), ["a", "b"]);
  assert.deepEqual(Array.from(news.allowedSourceIds(requested, catalog, 2)), ["b", "a"]);
  assert.deepEqual(requested, ["b", "bad", "a", "b", "tieba"]);

  const bars = ["科幻吧", "科幻", "文学吧", "\u0000invalid", "x".repeat(49)];
  assert.deepEqual(Array.from(news.normalizeTiebaBars(bars, 8)), ["科幻", "文学"]);
  assert.deepEqual(Array.from(news.enabledTiebaBars(["文学吧", "不存在吧", "文学"], bars, 8)), ["文学"]);
});
