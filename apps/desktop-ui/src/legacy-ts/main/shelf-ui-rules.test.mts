import assert from "node:assert/strict";
import test from "node:test";

import {
  currentList,
  installShelfUiRules,
  parseGridColumns,
  scrollbarGeometry,
  sortBooks,
} from "./shelf-ui-rules.ts";

test("grid columns retain the legacy clamp and invalid fallback", () => {
  assert.equal(parseGridColumns("0"), 0);
  assert.equal(parseGridColumns("4px"), 4);
  assert.equal(parseGridColumns(20), 12);
});

test("shelf sorting and filtering preserve the original ordering", () => {
  const books = [
    { id: 1, title: "乙", initial: "Y", progress: 50, tags: ["史"] },
    { id: 2, title: "甲", initial: "J", progress: 100, tags: ["文学"] },
  ];
  assert.deepEqual(sortBooks(books).map((book) => book.id), [2, 1]);
  assert.deepEqual(
    currentList(books, {
      searchQuery: "",
      minRating: 0,
      tagFilter: new Set(["史"]),
      collectionFilter: new Set(),
      organizationMatchMode: "any",
      readingFilter: { unread: true, reading: true, done: true },
    }).map((book) => book.id),
    [1],
  );
});

test("scrollbar projection and legacy global installer are deterministic", () => {
  assert.deepEqual(
    scrollbarGeometry({ viewport: 100, total: 400, trackHeight: 200, scrollTop: 150 }),
    { visible: true, maxScroll: 300, maxTop: 150, thumbHeight: 50, top: 75 },
  );
  const target: Record<string, unknown> = {};
  const api = installShelfUiRules(target);
  assert.equal(target.ReaderShelfRules, api);
  assert.equal(api.parseGridColumns("5"), 5);
});
