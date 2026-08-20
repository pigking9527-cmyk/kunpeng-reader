import assert from "node:assert/strict";
import test from "node:test";
import {
  compactReaderStartupDiagnostic,
  createReaderStartupState,
  isValidReaderDocumentSource,
  readerStartupDependencySummary,
  reduceReaderStartup,
} from "./startup-guard.ts";

test("startup source guard keeps the classic allowlist and rejects blank/external pages", () => {
  assert.equal(isValidReaderDocumentSource("reader://localhost/book/1"), true);
  assert.equal(isValidReaderDocumentSource("http://reader.localhost/book/1"), true);
  assert.equal(isValidReaderDocumentSource("pdfview.html?id=1"), true);
  assert.equal(isValidReaderDocumentSource("about:blank"), false);
  assert.equal(isValidReaderDocumentSource("https://example.com/book"), false);
  assert.equal(isValidReaderDocumentSource("  "), false);
});

test("startup reducer keeps one-way readiness and close guards", () => {
  let state = createReaderStartupState();
  state = reduceReaderStartup(state, { type: "MARK_SCRIPT_READY" });
  state = reduceReaderStartup(state, { type: "BEGIN_BOOK_LOAD" });
  state = reduceReaderStartup(state, { type: "BEGIN_FRAME_NAVIGATION" });
  state = reduceReaderStartup(state, { type: "MARK_FRAME_READY" });
  state = reduceReaderStartup(state, { type: "REQUEST_CLOSE" });
  state = reduceReaderStartup(state, { type: "REPORT_FIRST_FAILURE" });
  const reported = reduceReaderStartup(state, { type: "REPORT_FIRST_FAILURE" });
  assert.equal(reported, state);
  assert.deepEqual(state, {
    scriptReady: true,
    bookLoadStarted: true,
    frameNavigationStarted: true,
    frameReady: true,
    closeRequested: true,
    firstFailureReported: true,
  });
});

test("startup diagnostics remain compact and dependency-only", () => {
  assert.equal(compactReaderStartupDiagnostic("a\n  b"), "a b");
  assert.equal(compactReaderStartupDiagnostic("x".repeat(300)).length, 260);
  assert.equal(readerStartupDependencySummary({
    ReaderShell: {},
    ReaderSettings: undefined,
    ReaderAiHistoryRules: null,
    ReaderReadingMetrics: () => undefined,
    ReaderJumpBackRules: "ready",
    ReaderBookInfoPanel: 1,
    ReaderBookInfoRelated: true,
  }), "ReaderShell=object ReaderSettings=undefined ReaderAiHistoryRules=object ReaderReadingMetrics=function ReaderJumpBackRules=string ReaderBookInfoPanel=number ReaderBookInfoRelated=boolean");
});
