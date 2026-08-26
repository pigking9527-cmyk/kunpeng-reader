import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCombinedPreloadMemory,
  formatActualReaderOpen,
  formatBenchmarkSummary,
  formatPreloadComponents,
  formatStageDuration,
  formatPreloadBytes,
  measuredPreloadBytes,
} from "./reader-shell-preload-ui.ts";

test("reader shell preload formats cache and process memory without raw byte noise", () => {
  assert.equal(formatPreloadBytes(1024), "1.0 KiB");
  assert.equal(formatPreloadBytes(3 * 1024 * 1024), "3.0 MiB");
});

test("reader shell preload formats sub-millisecond visible-paint confirmation", () => {
  assert.equal(formatStageDuration(0), "<1 ms");
  assert.equal(formatStageDuration(1.2), "1 ms");
  assert.equal(formatStageDuration(19.6), "20 ms");
});

test("benchmark summary reports alternating rounds and P50/P95", () => {
  assert.equal(formatBenchmarkSummary({
    regularMedianMs: 800,
    preloadedMedianMs: 520,
    regularP95Ms: 940,
    preloadedP95Ms: 610,
    improvementMedianMs: 280,
    rounds: 3,
    samples: [],
  }), "3 轮 EPUB 交替测速 · 完全冷开 P50 800 ms / P95 940 ms · 预加载命中 P50 520 ms / P95 610 ms · 点击后等待减少 280 ms");
});

test("actual shelf opening stays separate from the ideal EPUB preload-hit benchmark", () => {
  assert.equal(formatActualReaderOpen(undefined), "尚无本次启动后的书架实际打开记录");
  assert.equal(formatActualReaderOpen({
    sampleCount: 3,
    format: "EPUB",
    preloadPath: "preloaded_hit",
    clickToFirstScreenMs: 138,
    firstScreenToRefillMs: 72,
    clickToCompleteMs: 210,
    refillOutcome: "ready",
    p50FirstScreenMs: 144,
    p95FirstScreenMs: 201,
  }), "EPUB · 命中外壳＋内层引擎 · 点击→首屏 138 ms · 首屏后补池 72 ms · 完整命令 210 ms · 同路径最近 3 次 P50/P95 144 ms/201 ms");
  assert.match(formatActualReaderOpen({
    sampleCount: 1,
    format: "PDF",
    preloadPath: "pdf_bypass",
    clickToFirstScreenMs: 428,
    firstScreenToRefillMs: 0,
    clickToCompleteMs: 428,
    refillOutcome: "ready",
    p50FirstScreenMs: 428,
    p95FirstScreenMs: 428,
  }), /PDF 独立冷开（不使用 EPUB 预加载）/u);
});

test("preload presents shell, engine and recent cache as one 120 MiB budget", () => {
  const cache = {
    epubDocuments: 3,
    metadataEntries: 3,
    chapterEntries: 3,
    chapterHtmlBytes: 768 * 1024,
    recentReadingChapterCacheEnabled: true,
    recentReadingChapterBooks: 7,
    recentReadingChapterLimitBytes: 64 * 1024 * 1024,
  };
  const status = {
    enabled: true,
    pooledShells: 1,
    readyShells: 1,
    innerEngineReadyShells: 1,
    innerEngineHeapBytes: 22 * 1024 * 1024,
    preloadMemoryLimitBytes: 120 * 1024 * 1024,
    cache,
  };
  assert.equal(measuredPreloadBytes(status), 22.75 * 1024 * 1024);
  assert.equal(
    formatPreloadComponents(status),
    "外壳 1/1 · 引擎 1/1 · 最近阅读缓存 已就绪",
  );
  assert.equal(
    formatCombinedPreloadMemory(status),
    "22.8 MiB / 120.0 MiB",
  );
  assert.equal(
    formatPreloadComponents({ ...status, cache: { ...cache, recentReadingChapterCacheEnabled: false } }),
    "外壳 1/1 · 引擎 1/1 · 最近阅读缓存 已关闭",
  );
  assert.equal(
    formatCombinedPreloadMemory({ ...status, enabled: false }),
    "0.0 KiB / 120.0 MiB",
  );
});
