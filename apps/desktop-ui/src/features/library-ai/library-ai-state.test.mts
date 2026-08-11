import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryAiBootstrap, SemanticStatus } from "./library-ai-port.ts";
import { initialLibraryAiState, libraryAiReducer, readinessNotice } from "./library-ai-state.ts";

const semantic: SemanticStatus = {
  modelId: "bge-m3",
  modelLabel: "BGE-M3",
  modelReady: true,
  modelDownloadedBytes: 10,
  modelTotalBytes: 10,
  indexReady: true,
  indexedBooks: 2,
  totalBooks: 2,
  task: "idle",
  m3LongContextEnabled: false,
};

const bootstrap: LibraryAiBootstrap = {
  configured: true,
  books: [{ id: "book-1", title: "示例书", tags: [], collections: [], available: true }],
  semantic,
  semanticModels: [{ id: "bge-m3", label: "BGE-M3" }],
  settings: { answerLength: "short", recommendationCandidateLimit: 20, recommendationResultLimit: 12 },
  history: { entries: [], syncMode: "off" },
};

test("late bootstrap results cannot replace a newer query", () => {
  let state = libraryAiReducer(initialLibraryAiState, { type: "load-started", requestId: 1 });
  state = libraryAiReducer(state, { type: "query-started", requestId: 2 });
  const stale = libraryAiReducer(state, { type: "load-succeeded", requestId: 1, bootstrap });
  assert.equal(stale, state);
  assert.equal(stale.phase, "querying");
});

test("compare selection is capped at eight without silently dropping an earlier choice", () => {
  let state = libraryAiReducer(initialLibraryAiState, { type: "task-selected", task: "compare" });
  for (let index = 0; index < 8; index += 1) state = libraryAiReducer(state, { type: "selection-changed", bookId: `book-${index}`, selected: true });
  const capped = libraryAiReducer(state, { type: "selection-changed", bookId: "book-9", selected: true });
  assert.equal(capped.selectedBookIds.size, 8);
  assert.equal(capped.selectedBookIds.has("book-9"), false);
});

test("failure state uses safe fixed copy rather than a port error message", () => {
  const state = libraryAiReducer({ ...initialLibraryAiState, requestId: 4, phase: "querying" }, { type: "query-failed", requestId: 4, offline: false });
  assert.equal(state.notice, "书库问答未完成，请检查模型和索引后重试。");
  assert.equal(state.answer, null);
});

test("readiness describes setup without exposing model configuration", () => {
  assert.equal(readinessNotice(false, { ...semantic, indexReady: false }), "请先配置大模型并建立本地语义索引。");
  assert.equal(readinessNotice(true, semantic), "");
});
