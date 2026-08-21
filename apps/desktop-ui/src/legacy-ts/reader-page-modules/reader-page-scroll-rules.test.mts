import assert from "node:assert/strict";
import test from "node:test";

import {
  installReaderPageScrollRules,
  type ReaderPageScrollItem,
  type ReaderPageScrollRulesApi,
} from "./reader-page-scroll-rules.ts";

const classic: ReaderPageScrollRulesApi = Object.freeze({
  firstUnfinishedItemIndex(items: readonly ReaderPageScrollItem[] | null | undefined, startIdx: unknown, bottom: unknown) {
    if (!items?.length) return -1;
    const size = Math.max(0, Math.floor(Number(items.length) || 0));
    const start = Math.max(0, Math.min(size - 1, Math.floor(Number(startIdx) || 0)));
    const limit = Number(bottom) || 0;
    for (let index = start; index < items.length; index += 1) if ((Number(items[index]?.bottom) || 0) > limit + 0.5) return index;
    return items.length;
  },
  pageBottomForSlice(pageTop: unknown, viewHeight: unknown, nextItem: ReaderPageScrollItem | null | undefined) {
    const top = Number(pageTop) || 0; const fullBottom = top + Math.max(0, Number(viewHeight) || 0);
    if (nextItem?.type === "block" && nextItem.atomic && !nextItem.preview && Number(nextItem.top) < fullBottom - 1 && Number(nextItem.bottom) > fullBottom + 0.5) return Math.max(top, Math.min(fullBottom, Math.round(Number(nextItem.top) || 0)));
    return fullBottom;
  },
  pageTopForStartItem(items: readonly ReaderPageScrollItem[] | null | undefined, startIdx: unknown, navMaxTop: unknown, topPad: unknown) {
    if (!items?.length || Number(startIdx) <= 0) return 0;
    const size = Math.max(0, Math.floor(Number(items.length) || 0));
    const index = Math.max(0, Math.min(size - 1, Math.floor(Number(startIdx) || 0)));
    const maximum = Math.max(0, Number(navMaxTop) || 0);
    return Math.max(0, Math.min(maximum, Math.round((Number(items[index]?.top) || 0) - (Number(topPad) || 0))));
  },
  alignedPageStart(items: readonly ReaderPageScrollItem[] | null | undefined, startIdx: unknown, navMaxTop: unknown, topPad: unknown) {
    if (!items?.length) return { startIdx: 0, pageTop: 0 };
    let start = Math.max(0, Math.min(items.length - 1, Math.floor(Number(startIdx) || 0)));
    let pageTop = classic.pageTopForStartItem(items, start, navMaxTop, topPad); let guard = 0;
    while (start > 0 && (Number(items[start - 1]?.bottom) || 0) > pageTop + 1 && guard++ < 1000) { start -= 1; pageTop = classic.pageTopForStartItem(items, start, navMaxTop, topPad); }
    return { startIdx: start, pageTop };
  },
  nearestBreakIndex(breaks: readonly unknown[] | null | undefined, top: unknown) {
    if (!breaks?.length) return 0;
    const target = Number(top) || 0; let best = 0; let bestDistance = Infinity;
    for (let index = 0; index < breaks.length; index += 1) { const distance = Math.abs((Number(breaks[index]) || 0) - target); if (distance < bestDistance) { best = index; bestDistance = distance; } }
    return best;
  },
  pageIndexForTop(breaks: readonly unknown[] | null | undefined, top: unknown, epsilon: unknown) {
    if (!breaks?.length) return 0;
    const target = Number(top) || 0; const slop = Number(epsilon) || 0; let result = 0;
    for (let index = 0; index < breaks.length; index += 1) { if ((Number(breaks[index]) || 0) <= target + slop) result = index; else break; }
    return Math.max(0, Math.min(breaks.length - 1, Math.floor(Number(result) || 0)));
  },
});

function plain(value: unknown): unknown {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

test("strict installer exposes the exact frozen classic API", () => {
  const runtime: Record<string, unknown> = {};
  const api = installReaderPageScrollRules(runtime);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(runtime.ReaderPageScrollRules, api);
  assert.deepEqual(Object.keys(api), [
    "firstUnfinishedItemIndex", "pageBottomForSlice", "pageTopForStartItem",
    "alignedPageStart", "nearestBreakIndex", "pageIndexForTop",
  ]);
});

test("first unfinished item remains VM-equivalent across coercion and threshold edges", () => {
  const strict = installReaderPageScrollRules({});
  const items = [{ bottom: 10 }, { bottom: 10.5 }, { bottom: 10.5001 }, {}, { bottom: "42" }];
  const cases: Array<[readonly typeof items[number][] | null | undefined, unknown, unknown]> = [
    [undefined, 0, 10], [null, 0, 10], [[], 0, 10], [items, -10, 10],
    [items, "2", 10], [items, 99, 100], [items, Number.NaN, "bad"],
  ];
  for (const args of cases) {
    assert.equal(strict.firstUnfinishedItemIndex(...args), classic.firstUnfinishedItemIndex(...args));
  }
});

test("atomic block slice bottoms preserve all original boundary comparisons", () => {
  const strict = installReaderPageScrollRules({});
  const items = [
    null,
    { type: "text", atomic: true, preview: false, top: 155, bottom: 220 },
    { type: "block", atomic: false, preview: false, top: 155, bottom: 220 },
    { type: "block", atomic: true, preview: true, top: 155, bottom: 220 },
    { type: "block", atomic: true, preview: false, top: 155, bottom: 220 },
    { type: "block", atomic: 1, preview: 0, top: "155.4", bottom: "220.8" },
    { type: "block", atomic: true, preview: false, top: 199, bottom: 200.5 },
  ];
  for (const item of items) {
    assert.equal(
      strict.pageBottomForSlice(100, 100, item),
      classic.pageBottomForSlice(100, 100, item),
    );
  }
  assert.equal(strict.pageBottomForSlice("bad", -20, null), 0);
});

test("start item top and backward alignment remain VM-equivalent", () => {
  const strict = installReaderPageScrollRules({});
  const items = [
    { top: 0, bottom: 24 },
    { top: 24, bottom: 50 },
    { top: 74, bottom: 90 },
    { top: 200, bottom: 250 },
  ];
  const cases: Array<[readonly typeof items[number][] | null | undefined, unknown, unknown, unknown]> = [
    [null, 0, 200, 4], [[], 3, 200, 4], [items, 0, 200, 4],
    [items, 2, 200, 4], [items, 99, 80, 4], [items, "2.9", "120", "4"],
    [items, Number.NaN, -10, Number.NaN],
  ];
  for (const args of cases) {
    assert.equal(strict.pageTopForStartItem(...args), classic.pageTopForStartItem(...args));
    assert.deepEqual(plain(strict.alignedPageStart(...args)), plain(classic.alignedPageStart(...args)));
  }
});

test("nearest break keeps first-on-tie behavior and number coercion", () => {
  const strict = installReaderPageScrollRules({});
  const breaks = [0, 108, 217, "bad"];
  for (const top of [undefined, null, -10, 54, 161, 162.5, 500, "216"]) {
    assert.equal(strict.nearestBreakIndex(breaks, top), classic.nearestBreakIndex(breaks, top));
  }
  assert.equal(strict.nearestBreakIndex([], 10), 0);
});

test("page index lookup is VM-equivalent for epsilon, unsorted tails, and invalid values", () => {
  const strict = installReaderPageScrollRules({});
  const cases: Array<[readonly unknown[] | null | undefined, unknown, unknown]> = [
    [undefined, 0, 0], [[], 10, 2], [[0, 108, 217], 106, 2],
    [[0, 108, 217], 216, 2], [[0, 108, 217], 300, -4],
    [[0, "bad", 217], "bad", "bad"], [[0, 217, 108], 200, 0],
  ];
  for (const args of cases) {
    assert.equal(strict.pageIndexForTop(...args), classic.pageIndexForTop(...args));
  }
});
