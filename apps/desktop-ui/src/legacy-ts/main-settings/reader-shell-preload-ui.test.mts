import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRecentReadingCacheStatus,
  formatStageDuration,
  formatPreloadBytes,
} from "./reader-shell-preload-ui.ts";

test("reader shell preload formats cache and process memory without raw byte noise", () => {
  assert.equal(formatPreloadBytes(1024), "1.0 KiB");
  assert.equal(formatPreloadBytes(3 * 1024 * 1024), "3.0 MiB");
});

test("reader shell preload shows sub-millisecond first-screen loading without a completion summary", () => {
  assert.equal(formatStageDuration(0), "<1 ms");
  assert.equal(formatStageDuration(1.2), "1 ms");
  assert.equal(formatStageDuration(19.6), "20 ms");
});

test("recent reading chapter cache reports a bounded EPUB-only working set", () => {
  const cache = {
    epubDocuments: 3,
    metadataEntries: 3,
    chapterEntries: 3,
    chapterHtmlBytes: 768 * 1024,
    recentReadingChapterCacheEnabled: true,
    recentReadingChapterBooks: 3,
    recentReadingChapterLimitBytes: 6 * 1024 * 1024,
  };
  assert.equal(
    formatRecentReadingCacheStatus(cache, true),
    "已缓存 3/3 本 · 768.0 KiB / 6.0 MiB",
  );
  assert.equal(
    formatRecentReadingCacheStatus({ ...cache, recentReadingChapterCacheEnabled: false }, true),
    "已关闭；不会额外保留最近阅读章节。",
  );
  assert.equal(formatRecentReadingCacheStatus(cache, false), "预加载关闭时不保留最近阅读缓存。");
});
