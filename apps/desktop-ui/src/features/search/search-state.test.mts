import assert from "node:assert/strict";
import test from "node:test";
import type { KeywordSearchResponse, SearchBookResult } from "./search-port.ts";
import { createSearchState, nextHistoryEntry, searchReducer } from "./search-state.ts";

const result: SearchBookResult = { bookId: "book-1", title: "书名", hits: [{ chapter: 0, snippet: "短片段" }], count: 2 };
const keyword: KeywordSearchResponse = { results: [result], pendingBooks: 0 };

test("late and cancelled searches cannot replace a newer query", () => {
  let state = createSearchState();
  state = searchReducer(state, { type: "search-started", requestId: 2, term: "新搜索" });
  const stale = searchReducer(state, { type: "keyword-succeeded", requestId: 1, response: keyword });
  assert.equal(stale, state);
  state = searchReducer(state, { type: "search-cancelled", requestId: 2 });
  const afterCancel = searchReducer(state, { type: "keyword-succeeded", requestId: 2, response: keyword });
  assert.equal(afterCancel.phase, "cancelled");
});

test("empty keyword results retain pending full-text indexing information", () => {
  let state = createSearchState();
  state = searchReducer(state, { type: "search-started", requestId: 1, term: "缺少索引" });
  state = searchReducer(state, { type: "keyword-succeeded", requestId: 1, response: { results: [], pendingBooks: 3 } });
  assert.equal(state.phase, "empty");
  assert.match(state.message ?? "", /3 本/);
});

test("history contains only query metadata and is bounded by its host", () => {
  const entry = nextHistoryEntry("  搜索词  ", [{ term: "搜索词", count: 2, lastUsedAt: 1 }], 5);
  assert.deepEqual(entry, { term: "搜索词", count: 3, lastUsedAt: 5 });
  assert.equal(nextHistoryEntry("   ", [], 5), null);
});

test("closed window drops excerpts and ignores later native results", () => {
  let state = createSearchState();
  state = searchReducer(state, { type: "search-started", requestId: 1, term: "搜索词" });
  state = searchReducer(state, { type: "keyword-succeeded", requestId: 1, response: keyword });
  state = searchReducer(state, { type: "closed" });
  assert.equal(state.phase, "closed");
  assert.deepEqual(state.results, []);
  assert.equal(searchReducer(state, { type: "semantic-succeeded", requestId: 1, results: [result] }), state);
});
