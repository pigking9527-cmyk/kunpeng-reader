import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { ShelfBook } from "./shelf-port.ts";
import { filterShelfBooks, safeCoverUrl, sortShelfBooks, type ShelfFilters } from "./shelf-rules.ts";

/**
 * This is deliberately metadata-only. It approximates a large shelf without
 * putting a user's titles, paths, descriptions, covers, or book text in the
 * repository or test output.
 */
const LARGE_SHELF_SIZE = 10_000;
const BENCHMARK_RUNS = 5;
const CATASTROPHIC_OPERATION_CEILING_MS = 8_000;

function syntheticBook(index: number): ShelfBook {
  const ordinal = String(LARGE_SHELF_SIZE - index).padStart(5, "0");
  const coverUrl = (() => {
    switch (index % 4) {
      case 0: return `https://cover.example.invalid/${index}.webp`;
      case 1: return "data:image/png;base64,AAAA";
      case 2: return "javascript:synthetic-cover";
      default: return "ftp://cover.example.invalid/synthetic-cover";
    }
  })();
  return {
    id: `synthetic-${String(index).padStart(5, "0")}`,
    title: `合成图书 ${ordinal}`,
    author: `合成作者 ${index % 97}`,
    // This labels the fixture rather than representing any book content.
    description: `性能基准元数据 ${index % 31}`,
    coverUrl,
    rating: index % 6,
    progress: (index % 101) / 100,
    addedAt: 1_700_000_000_000 + index,
    lastReadAt: 1_700_100_000_000 - index,
    readingSeconds: index * 13,
    fileSizeBytes: 100_000 + index,
    tags: [`主题-${index % 16}`],
    collections: [`书架-${index % 10}`],
  };
}

const SYNTHETIC_SHELF: readonly ShelfBook[] = Object.freeze(
  Array.from({ length: LARGE_SHELF_SIZE }, (_, index) => syntheticBook(index)),
);

const ORGANIZATION_FILTERS: ShelfFilters = {
  query: "",
  reading: new Set(["unread", "reading", "finished"]),
  minimumRating: 0,
  tags: new Set(["主题-3"]),
  collections: new Set(["书架-5"]),
  organizationMatch: "all",
};

interface Measurement<T> {
  readonly result: T;
  readonly medianMilliseconds: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure<T>(operation: () => T): Measurement<T> {
  // Warm the code path before measuring: this makes the metric less sensitive
  // to cold JIT and module initialization while preserving a fixed input.
  let result = operation();
  const durations: number[] = [];
  for (let index = 0; index < BENCHMARK_RUNS; index += 1) {
    const startedAt = performance.now();
    result = operation();
    durations.push(performance.now() - startedAt);
  }
  return { result, medianMilliseconds: median(durations) };
}

function assertWithinCatastrophicBudget(label: string, elapsedMilliseconds: number): void {
  assert.ok(
    elapsedMilliseconds < CATASTROPHIC_OPERATION_CEILING_MS,
    `${label} took ${elapsedMilliseconds.toFixed(1)}ms for ${LARGE_SHELF_SIZE} synthetic books; `
      + `the ${CATASTROPHIC_OPERATION_CEILING_MS}ms ceiling catches severe complexity regressions.`,
  );
}

test("large shelf fixture remains metadata-only and deterministic", () => {
  assert.equal(SYNTHETIC_SHELF.length, LARGE_SHELF_SIZE);
  assert.deepEqual(Object.keys(SYNTHETIC_SHELF[0] ?? {}).sort(), [
    "addedAt", "author", "collections", "coverUrl", "description", "fileSizeBytes", "id",
    "lastReadAt", "progress", "rating", "readingSeconds", "tags", "title",
  ]);
  assert.equal(SYNTHETIC_SHELF[0]?.id, "synthetic-00000");
  assert.equal(SYNTHETIC_SHELF.at(-1)?.id, "synthetic-09999");
});

test("large shelf filter, sort, organization filter, and cover validation keep their contract", () => {
  const organization = measure(() => filterShelfBooks(SYNTHETIC_SHELF, ORGANIZATION_FILTERS));
  // 10,000 / lcm(16 tags, 10 collections) = 125 matching records.
  assert.equal(organization.result.length, 125);
  assert.ok(organization.result.every((book) => book.tags.includes("主题-3") && book.collections.includes("书架-5")));
  assertWithinCatastrophicBudget("organization filter", organization.medianMilliseconds);

  const sorted = measure(() => sortShelfBooks(SYNTHETIC_SHELF, "title"));
  assert.equal(sorted.result.length, LARGE_SHELF_SIZE);
  assert.equal(sorted.result[0]?.id, "synthetic-09999");
  assert.equal(sorted.result.at(-1)?.id, "synthetic-00000");
  assertWithinCatastrophicBudget("title sort", sorted.medianMilliseconds);

  const coverValidation = measure(() => SYNTHETIC_SHELF.filter((book) => safeCoverUrl(book.coverUrl) !== null));
  assert.equal(coverValidation.result.length, LARGE_SHELF_SIZE / 2);
  assertWithinCatastrophicBudget("cover URL validation", coverValidation.medianMilliseconds);

  console.log(
    `[shelf performance] ${LARGE_SHELF_SIZE} synthetic books, median of ${BENCHMARK_RUNS}: `
      + `organization ${organization.medianMilliseconds.toFixed(1)}ms, `
      + `title sort ${sorted.medianMilliseconds.toFixed(1)}ms, `
      + `cover validation ${coverValidation.medianMilliseconds.toFixed(1)}ms`,
  );
});
