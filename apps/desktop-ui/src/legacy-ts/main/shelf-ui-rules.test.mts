import assert from "node:assert/strict";
import test from "node:test";

import {
  currentList,
  installShelfUiRules,
  parseGridColumns,
  resolveShelfSortPreference,
  SHELF_SORT_MIGRATION_REVISION,
  shouldOpenBookOnPrimaryPointerDown,
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
    { id: 1, title: "乙", initial: "Y", progress: 50, last_read_at: 200, tags: ["史"] },
    { id: 2, title: "甲", initial: "J", progress: 100, last_read_at: 100, tags: ["文学"] },
  ];
  assert.deepEqual(sortBooks(books).map((book) => book.id), [1, 2]);
  assert.deepEqual(
    sortBooks(books, { sortKey: "title" }).map((book) => book.id),
    [2, 1],
  );
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

test("historical title, empty and rating preferences migrate to recent reading once", () => {
  for (const storedSortKey of [null, "title", "rating"]) {
    assert.deepEqual(resolveShelfSortPreference(storedSortKey, null), {
      revision: SHELF_SORT_MIGRATION_REVISION,
      shouldPersist: true,
      sortKey: "read",
    });
  }
});

test("the new product migration switches every historical sort to recent reading once", () => {
  for (const sortKey of [
    "title",
    "author",
    "added",
    "dir",
    "read",
    "reading-time",
    "size",
    "progress",
  ] as const) {
    assert.deepEqual(resolveShelfSortPreference(sortKey, "legacy-revision"), {
      revision: SHELF_SORT_MIGRATION_REVISION,
      shouldPersist: true,
      sortKey: "read",
    });
  }
});

test("completed migration respects later explicit title and other choices", () => {
  for (const sortKey of ["title", "author", "added", "read"] as const) {
    assert.deepEqual(
      resolveShelfSortPreference(sortKey, SHELF_SORT_MIGRATION_REVISION),
      {
        revision: SHELF_SORT_MIGRATION_REVISION,
        shouldPersist: false,
        sortKey,
      },
    );
  }
});

test("completed migration heals an unsupported stored sort without repeating migration", () => {
  assert.deepEqual(
    resolveShelfSortPreference("rating", SHELF_SORT_MIGRATION_REVISION),
    {
      revision: SHELF_SORT_MIGRATION_REVISION,
      shouldPersist: true,
      sortKey: "read",
    },
  );
});

test("only an unmodified primary left mouse press opens immediately", () => {
  const primaryMouse = {
    singleClickOpensBook: true,
    pointerType: "mouse",
    button: 0,
    isPrimary: true,
    metaKey: false,
    ctrlKey: false,
    hasSelection: false,
  };
  assert.equal(shouldOpenBookOnPrimaryPointerDown(primaryMouse), true);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, pointerType: "touch" }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, pointerType: "pen" }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, button: 2 }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, isPrimary: false }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, metaKey: true }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, ctrlKey: true }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, hasSelection: true }), false);
  assert.equal(shouldOpenBookOnPrimaryPointerDown({ ...primaryMouse, singleClickOpensBook: false }), false);
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
  assert.equal(api.resolveShelfSortPreference, resolveShelfSortPreference);
  assert.equal(api.shouldOpenBookOnPrimaryPointerDown, shouldOpenBookOnPrimaryPointerDown);
});
