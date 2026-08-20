import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  compactFreeformPoints,
  hintFrameClipPath,
  masonryColumnCount,
  estimateCardHeight,
  balancedColumnIndexes,
  normalizeHintFramePath,
  normalizeHintSettings,
  normalizeQuickColors,
  highlightNeedles,
  highlightSnippet,
  sortSearchResults,
  normalizedSearchTerm,
  recordSearchQuery,
  removeSearchQuery,
  commonSearches,
  range,
  normalizeAnchor,
  steppedAnchor,
  navigation,
  canStep,
  daysInMonth,
} from "./index.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function legacyApi<T>(
  fileName: string,
  globalName: string,
  additions: Record<string, unknown> = {},
): T {
  const source = readFileSync(
    new URL(`ui/generated-ts/${fileName}`, repositoryRoot),
    "utf8",
  );
  const context: Record<string, unknown> = { ...additions };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: fileName });
  return context[globalName] as T;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

interface LegacySearchResultRules {
  highlightNeedles(value: unknown): unknown;
  highlightSnippet(snippet: unknown, term: unknown): unknown;
  sortSearchResults(list: unknown, mode: string): unknown;
}

interface LegacySearchHistoryRules {
  normalizedSearchTerm(value: unknown): unknown;
  recordSearchQuery(
    history: unknown,
    common: unknown,
    query: unknown,
    now: number,
    maximum: number,
  ): unknown;
  removeSearchQuery(history: unknown, query: unknown): unknown;
  commonSearches(common: unknown, limit: number): unknown;
}

interface LegacyStatsNavigation {
  readonly earliest: Date | null;
  readonly latest: Date;
  readonly showNavigation: boolean;
  readonly previousDisabled: boolean;
  readonly nextDisabled: boolean;
}

interface LegacyStatsRules {
  range(scope: string, anchor: Date): unknown;
  normalizeAnchor(anchor: Date, scope: string): Date;
  steppedAnchor(scope: string, anchor: Date, direction: number): Date;
  navigation(
    scope: string,
    anchor: Date,
    firstReadingDay: number | null,
    now: Date,
  ): LegacyStatsNavigation;
  canStep(
    scope: string,
    anchor: Date,
    direction: number,
    firstReadingDay: number | null,
    now: Date,
  ): boolean;
  daysInMonth(year: number, month: number): number;
}

interface LegacyNewsLayoutRules {
  masonryColumnCount(width: unknown, previous: number, options?: unknown): number;
  estimateCardHeight(card?: unknown, options?: unknown): number;
  balancedColumnIndexes(heights: unknown, columns: unknown): unknown;
}

interface LegacyGestureHintRules {
  normalizeQuickColors(value: unknown, createId?: () => string): unknown;
  normalizeHintFramePath(value: unknown): unknown;
  normalizeHintSettings(value: unknown, createId?: () => string): unknown;
  hintFrameClipPath(value: unknown): string;
  compactFreeformPoints(points: unknown, maximum: unknown): unknown;
}

test("search result TypeScript preserves classic highlighting and sorting", () => {
  const legacy = legacyApi<LegacySearchResultRules>(
    "search-result-rules.js",
    "ReaderSearchResultRules",
    { Set },
  );
  for (const term of ["中文检索", "书", "a", "alpha ALPHA beta", "  "]) {
    assert.deepEqual(plain(highlightNeedles(term)), plain(legacy.highlightNeedles(term)));
  }
  for (const [snippet, term] of [
    ["<alpha & beta>", "beta"],
    ["中文检索结果", "中文检索"],
    ["Aa aA", "aa"],
    ["", "term"],
  ]) {
    assert.equal(highlightSnippet(snippet, term), legacy.highlightSnippet(snippet, term));
  }
  const results = [
    { title: "乙", author: "王", count: 2, score: 0.3 },
    { title: "甲", author: "李", count: 4, score: 0 },
    { title: "丙", author: "赵", count: 1, score: 0.9 },
  ];
  for (const mode of ["title", "author", "hits", "score"]) {
    assert.deepEqual(
      plain(sortSearchResults(results, mode)),
      plain(legacy.sortSearchResults(results, mode)),
    );
  }
});

test("search history TypeScript preserves classic normalization and ranking", () => {
  const legacy = legacyApi<LegacySearchHistoryRules>(
    "search-history-rules.js",
    "ReaderSearchHistoryRules",
  );
  assert.equal(normalizedSearchTerm(" 查询 "), legacy.normalizedSearchTerm(" 查询 "));
  const history = ["旧词", "查询", "旧词"];
  const counts = {
    查询: { count: 4, last: 1 },
    高频: { count: "8", last: 0 },
    无效: null,
  };
  assert.deepEqual(
    plain(recordSearchQuery(history, counts, " 查询 ", 88, 2)),
    plain(legacy.recordSearchQuery(history, counts, " 查询 ", 88, 2)),
  );
  assert.deepEqual(
    plain(recordSearchQuery(history, counts, " ", Number.NaN, 0)),
    plain(legacy.recordSearchQuery(history, counts, " ", Number.NaN, 0)),
  );
  assert.deepEqual(
    plain(removeSearchQuery(history, "旧词")),
    plain(legacy.removeSearchQuery(history, "旧词")),
  );
  assert.deepEqual(
    plain(commonSearches(counts, 3)),
    plain(legacy.commonSearches(counts, 3)),
  );
});

test("statistics TypeScript preserves classic range and navigation boundaries", () => {
  const legacy = legacyApi<LegacyStatsRules>("stats-rules.js", "ReaderStatsRules");
  const leapDay = new Date(2024, 1, 29, 23, 59, 59);
  for (const scope of ["day", "month", "year", "total"] as const) {
    assert.deepEqual(plain(range(scope, leapDay)), plain(legacy.range(scope, leapDay)));
    assert.equal(
      normalizeAnchor(leapDay, scope).getTime(),
      legacy.normalizeAnchor(leapDay, scope).getTime(),
    );
    for (const direction of [-1, 0, 1]) {
      assert.equal(
        steppedAnchor(scope, leapDay, direction).getTime(),
        legacy.steppedAnchor(scope, leapDay, direction).getTime(),
      );
    }
  }
  assert.equal(daysInMonth(2024, 1), legacy.daysInMonth(2024, 1));
  const now = new Date(2024, 4, 15, 18, 0, 0);
  for (const scope of ["day", "month", "year", "total"] as const) {
    for (const first of [20240331, null]) {
      const typed = navigation(scope, leapDay, first, now);
      const old = legacy.navigation(scope, leapDay, first, now);
      assert.deepEqual(
        {
          ...typed,
          earliest: typed.earliest?.getTime() ?? null,
          latest: typed.latest.getTime(),
        },
        {
          ...old,
          earliest: old.earliest?.getTime() ?? null,
          latest: old.latest.getTime(),
        },
      );
      for (const direction of [-1, 0, 1]) {
        assert.equal(
          canStep(scope, leapDay, direction, first, now),
          legacy.canStep(scope, leapDay, direction, first, now),
        );
      }
    }
  }
});

test("news layout TypeScript preserves classic estimates and balancing", () => {
  const legacy = legacyApi<LegacyNewsLayoutRules>(
    "news-layout-rules.js",
    "ReaderNewsLayoutRules",
  );
  for (const input of [
    [0, 3, undefined],
    [656, 0, undefined],
    [656, 0, { minimumCardWidth: 300, gap: 20 }],
  ] as const) {
    const [width, previous, options] = input;
    assert.equal(
      masonryColumnCount(width, previous, options),
      legacy.masonryColumnCount(width, previous, options),
    );
  }
  const card = {
    title: "很长的标题".repeat(30),
    summary: "摘要".repeat(80),
    hasImage: true,
  };
  const options = { width: 220, columnCount: 1, gap: 13 };
  assert.equal(
    estimateCardHeight(card, options),
    legacy.estimateCardHeight(card, options),
  );
  const heights = [100, 200, Number.NaN, -1, 50];
  assert.deepEqual(
    plain(balancedColumnIndexes(heights, 2)),
    plain(legacy.balancedColumnIndexes(heights, 2)),
  );
});

test("gesture hint TypeScript preserves classic settings and path projection", () => {
  const legacy = legacyApi<LegacyGestureHintRules>(
    "gesture-hint-rules.js",
    "ReaderGestureHintRules",
  );
  const colors = [
    { color: "#112233", name: "  海蓝  " },
    { color: "invalid" },
    { color: "#445566", id: "fixed" },
  ];
  let typedId = 0;
  let legacyId = 0;
  assert.deepEqual(
    plain(normalizeQuickColors(colors, () => `generated-${++typedId}`)),
    plain(legacy.normalizeQuickColors(colors, () => `generated-${++legacyId}`)),
  );
  const path = [
    { x: 0, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 0 },
    { x: 101, y: 0 },
  ];
  assert.deepEqual(
    plain(normalizeHintFramePath(path)),
    plain(legacy.normalizeHintFramePath(path)),
  );
  const settings = {
    enabled: true,
    fontSize: 99,
    backgroundEnabled: false,
    background: "#ABCDEF",
    opacity: 1,
    positionX: -2,
    positionY: 2,
    frameWidth: 1,
    frameHeight: 999,
    frameShape: "freeform",
    framePath: path,
    quickColors: colors,
  };
  typedId = 0;
  legacyId = 0;
  const typedSettings = normalizeHintSettings(
    settings,
    () => `generated-${++typedId}`,
  );
  const legacySettings = legacy.normalizeHintSettings(
    settings,
    () => `generated-${++legacyId}`,
  );
  assert.deepEqual(plain(typedSettings), plain(legacySettings));
  assert.equal(
    hintFrameClipPath(typedSettings),
    legacy.hintFrameClipPath(legacySettings),
  );
  assert.deepEqual(
    plain(compactFreeformPoints(path, 3)),
    plain(legacy.compactFreeformPoints(path, 3)),
  );
});
