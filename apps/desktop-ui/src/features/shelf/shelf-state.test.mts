import assert from "node:assert/strict";
import test from "node:test";
import type { ShelfSnapshot } from "./shelf-port.ts";
import { createShelfState, shelfReducer } from "./shelf-state.ts";

const snapshot: ShelfSnapshot = {
  books: [{ id: "book", title: "测试图书", tags: [], collections: [] }],
  booklists: [],
};

test("a cancelled or stale shelf request cannot replace the current snapshot", () => {
  let state = createShelfState();
  state = shelfReducer(state, { type: "load-started", requestId: 2 });
  state = shelfReducer(state, { type: "load-cancelled", requestId: 2 });
  const stale = shelfReducer(state, { type: "load-succeeded", requestId: 1, snapshot });
  assert.equal(stale, state);
  assert.equal(stale.phase, "cancelled");
});

test("a successful reload clears selection that no longer belongs to its snapshot", () => {
  let state = createShelfState();
  state = shelfReducer(state, { type: "load-started", requestId: 1 });
  state = shelfReducer(state, { type: "selection-changed", selected: new Set(["old-book"]) });
  state = shelfReducer(state, { type: "load-succeeded", requestId: 1, snapshot });
  assert.equal(state.phase, "ready");
  assert.deepEqual([...state.selected], []);
  assert.equal(state.snapshot, snapshot);
});
