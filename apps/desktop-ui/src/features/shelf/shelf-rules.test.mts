import assert from "node:assert/strict";
import test from "node:test";
import type { ShelfBook } from "./shelf-port.ts";
import {
  filterShelfBooks,
  matchesOrganization,
  organizationEntries,
  safeCoverUrl,
  sortShelfBooks,
} from "./shelf-rules.ts";

const books: readonly ShelfBook[] = [
  {
    id: "a", title: "古文观止", author: "吴楚材", description: "古文", rating: 5,
    progress: 0.5, addedAt: 20, lastReadAt: 30, readingSeconds: 8, fileSizeBytes: 10,
    tags: ["古文", "文学"], collections: ["历史"],
  },
  {
    id: "b", title: "三体", author: "刘慈欣", description: "科幻", rating: 4,
    progress: 1, addedAt: 10, lastReadAt: 40, readingSeconds: 20, fileSizeBytes: 20,
    tags: ["科幻"], collections: ["小说"],
  },
  {
    id: "c", title: "未读书", author: "作者", rating: 0, progress: 0,
    tags: [], collections: [],
  },
];

test("search keeps the legacy precedence over funnel filters", () => {
  const result = filterShelfBooks(books, {
    query: "古文",
    reading: new Set(["finished"]),
    minimumRating: 5,
    tags: new Set(["不存在"]),
    collections: new Set(),
    organizationMatch: "all",
  });
  assert.deepEqual(result.map((book) => book.id), ["a"]);
});

test("organization match supports legacy any and all semantics across tags and collections", () => {
  assert.equal(matchesOrganization(books[0]!, new Set(["古文", "不存在"]), new Set(["历史"]), "any"), true);
  assert.equal(matchesOrganization(books[0]!, new Set(["古文", "不存在"]), new Set(["历史"]), "all"), false);
  assert.equal(matchesOrganization(books[0]!, new Set(["古文"]), new Set(["历史"]), "all"), true);
});

test("sorting is stable through a title fallback and organization entries are normalized", () => {
  assert.deepEqual(sortShelfBooks(books, "last-read").map((book) => book.id), ["b", "a", "c"]);
  const entries = organizationEntries([...books, { ...books[0]!, tags: [" 古文 "] }], "tags");
  assert.deepEqual(entries.find((entry) => entry.key === "古文"), { key: "古文", name: "古文", count: 2 });
});

test("safe cover fallback accepts only image data and browser-safe image transports", () => {
  assert.equal(safeCoverUrl("javascript:alert(1)"), null);
  assert.equal(safeCoverUrl("data:text/html,bad"), null);
  assert.equal(safeCoverUrl("data:image/svg+xml,<svg />"), null);
  assert.equal(safeCoverUrl("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  assert.match(safeCoverUrl("https://example.test/cover.jpg") ?? "", /^https:/);
  assert.match(safeCoverUrl("reader://localhost/cover/1?v=2") ?? "", /^reader:/);
  assert.equal(safeCoverUrl("reader://not-localhost/cover/1"), null);
});
