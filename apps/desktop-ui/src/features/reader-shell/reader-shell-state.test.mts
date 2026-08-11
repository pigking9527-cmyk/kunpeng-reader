import assert from "node:assert/strict";
import test from "node:test";
import type { ReaderNoteSummary, ReaderSearchHit } from "./reader-shell-port.ts";
import { createReaderShellState, readerShellReducer } from "./reader-shell-state.ts";

const note: ReaderNoteSummary = { id: "note-1", locationLabel: "第 2 章", excerpt: "短摘录", note: "我的笔记" };
const hit: ReaderSearchHit = { id: "hit-1", locationLabel: "第 3 章", excerpt: "匹配片段" };

test("late panel responses cannot replace a newer request", () => {
  let state = createReaderShellState();
  state = readerShellReducer(state, { type: "preferences-loaded", preferences: state.preferences });
  state = readerShellReducer(state, { type: "notes-load-started", requestId: 2 });
  state = readerShellReducer(state, { type: "notes-load-succeeded", requestId: 1, notes: [note] });
  assert.deepEqual(state.notes, []);
  state = readerShellReducer(state, { type: "notes-load-succeeded", requestId: 2, notes: [note] });
  assert.deepEqual(state.notes, [note]);
});

test("cancelling search rejects a late result", () => {
  let state = createReaderShellState();
  state = readerShellReducer(state, { type: "search-started", requestId: 4, query: "查询" });
  state = readerShellReducer(state, { type: "search-cancelled", requestId: 4 });
  state = readerShellReducer(state, { type: "search-succeeded", requestId: 4, hits: [hit] });
  assert.equal(state.searchPhase, "cancelled");
  assert.deepEqual(state.searchHits, []);
});

test("close clears transient notes, queries, and excerpts", () => {
  let state = createReaderShellState();
  state = readerShellReducer(state, { type: "notes-load-started", requestId: 1 });
  state = readerShellReducer(state, { type: "notes-load-succeeded", requestId: 1, notes: [note] });
  state = readerShellReducer(state, { type: "search-started", requestId: 2, query: "查询" });
  state = readerShellReducer(state, { type: "search-succeeded", requestId: 2, hits: [hit] });
  state = readerShellReducer(state, { type: "closed" });
  assert.equal(state.phase, "closed");
  assert.deepEqual(state.notes, []);
  assert.deepEqual(state.searchHits, []);
  assert.equal(state.searchQuery, "");
  assert.equal(readerShellReducer(state, { type: "notes-load-succeeded", requestId: 1, notes: [note] }), state);
});

test("closing a panel invalidates in-flight panel data", () => {
  let state = createReaderShellState();
  state = readerShellReducer(state, { type: "notes-load-started", requestId: 4 });
  state = readerShellReducer(state, { type: "search-started", requestId: 5, query: "查询" });
  state = readerShellReducer(state, { type: "panel-closed" });
  state = readerShellReducer(state, { type: "notes-load-succeeded", requestId: 4, notes: [note] });
  state = readerShellReducer(state, { type: "search-succeeded", requestId: 5, hits: [hit] });
  assert.deepEqual(state.notes, []);
  assert.deepEqual(state.searchHits, []);
});

test("only low-frequency engine events change reader shell state", () => {
  let state = createReaderShellState();
  state = readerShellReducer(state, { type: "engine-event", event: { type: "engine-ready", engine: "epub" } });
  assert.equal(state.engine, "epub");
  state = readerShellReducer(state, { type: "engine-event", event: { type: "open-panel", panel: "preferences" } });
  assert.equal(state.activePanel, "preferences");
});
