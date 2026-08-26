const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
const reader = fs.readFileSync(path.join(ui, "generated-ts", "reader.js"), "utf8");
const guard = fs.readFileSync(path.join(ui, "generated-ts", "reader-startup-guard.js"), "utf8");

function loadGuard() {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    clearTimeout() {},
    setTimeout() { return 1; },
    __TAURI__: { core: { invoke: async () => undefined } },
  };
  const close = { addEventListener() {} };
  window.document = {
    getElementById(id) { return id === "win-close" ? close : null; },
  };
  window.window = window;
  vm.runInNewContext(guard, window, { filename: "reader-startup-guard.js" });
  return window.ReaderStartupGuard;
}

test("reader startup failures stay diagnosable and closable", () => {
  assert.ok(
    html.indexOf('<script src="generated-ts/reader-startup-guard.js"></script>') <
      html.indexOf('<script src="generated-ts/reader.js"></script>'),
  );
  assert.match(guard, /addEventListener\("error"/);
  assert.match(guard, /invoke\("reader_perf_log"/);
  assert.match(guard, /getElementById\("win-close"\)[\s\S]*?closeSafely\(target\.closeReaderWindow\)/);
  assert.match(guard, /function isValidReaderDocumentSource[\s\S]*?source !== "about:blank"/);
  assert.match(guard, /function beginBookLoad[\s\S]*?book_info did not provide a document URL/);
  assert.match(guard, /function beginFrameNavigation[\s\S]*?frame_ready_timeout/);
  assert.match(guard, /function closeSafely[\s\S]*?READER_CLOSE_FALLBACK_MS[\s\S]*?nativeClose/);
  assert.match(reader, /ReaderStartupGuard\?\.markScriptReady\?\.\(\);[\s\S]*?\(async \(\) =>/);
  assert.match(reader, /ReaderStartupGuard\?\.beginBookLoad\?\.\(\);[\s\S]*?invoke\("book_info"(?:,|\))/);
  assert.match(reader, /beginFrameNavigation\?\.\(pdfSource\)[\s\S]*?frame\.src = pdfSource/);
  assert.match(reader, /beginFrameNavigation\?\.\(readerSource\)[\s\S]*?frame\.src = readerSource/);
  assert.match(reader, /e\.data\.ready[\s\S]*?ReaderStartupGuard\?\.markFrameReady/);
  assert.match(reader, /catch \(e\) \{[\s\S]*?ReaderStartupGuard\?\.failBookLoad/);
  assert.doesNotMatch(reader, /document\.body\.innerHTML\s*=\s*[\s\S]*?openBookFailed/);
});

test("reader startup guard rejects blank or external iframe sources before navigation", () => {
  const startupGuard = loadGuard();
  assert.equal(startupGuard.validDocumentSource("about:blank"), false);
  assert.equal(startupGuard.validDocumentSource("https://example.invalid/book"), false);
  assert.equal(startupGuard.validDocumentSource("reader://localhost/book/1?rc=0"), true);
  assert.equal(startupGuard.validDocumentSource("http://reader.localhost/book/1?rc=0"), true);
  assert.equal(startupGuard.validDocumentSource("pdfview.html?u=reader%3A%2F%2Flocalhost%2Fpdf%2F1"), true);
  startupGuard.markScriptReady();
  startupGuard.beginBookLoad();
  assert.equal(startupGuard.state().bookLoadStarted, true);
  assert.equal(startupGuard.beginFrameNavigation("about:blank"), false);
  assert.equal(startupGuard.state().frameNavigationStarted, false);
  assert.equal(startupGuard.beginFrameNavigation("reader://localhost/book/1"), true);
  startupGuard.markFrameReady();
  assert.equal(startupGuard.state().frameReady, true);
});
