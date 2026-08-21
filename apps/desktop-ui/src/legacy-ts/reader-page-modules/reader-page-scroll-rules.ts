// ---- 滚动分页纯几何规则 ----
// 与阅读页的其他模块在编译期拼接为同一份脚本。这里不读取 DOM、设置或
// 全局状态；调用方只传入已测得的行/块几何与分页索引，仍由布局模块负责
// 读取滚动容器、构建视觉图层和驱动 EPUB/PDF 命令式引擎。

export interface ReaderPageScrollItem {
  readonly top?: unknown;
  readonly bottom?: unknown;
  readonly type?: unknown;
  readonly atomic?: unknown;
  readonly preview?: unknown;
  readonly [key: string]: unknown;
}

export interface ReaderPageAlignedStart {
  readonly startIdx: number;
  readonly pageTop: number;
}

export interface ReaderPageScrollRulesApi {
  readonly firstUnfinishedItemIndex: (
    items: readonly ReaderPageScrollItem[] | null | undefined,
    startIdx: unknown,
    bottom: unknown,
  ) => number;
  readonly pageBottomForSlice: (
    pageTop: unknown,
    viewHeight: unknown,
    nextItem: ReaderPageScrollItem | null | undefined,
  ) => number;
  readonly pageTopForStartItem: (
    items: readonly ReaderPageScrollItem[] | null | undefined,
    startIdx: unknown,
    navMaxTop: unknown,
    topPad: unknown,
  ) => number;
  readonly alignedPageStart: (
    items: readonly ReaderPageScrollItem[] | null | undefined,
    startIdx: unknown,
    navMaxTop: unknown,
    topPad: unknown,
  ) => ReaderPageAlignedStart;
  readonly nearestBreakIndex: (
    breaks: readonly unknown[] | null | undefined,
    top: unknown,
  ) => number;
  readonly pageIndexForTop: (
    breaks: readonly unknown[] | null | undefined,
    top: unknown,
    epsilon: unknown,
  ) => number;
}

interface ReaderPageScrollRuntime extends Record<string, unknown> {
  ReaderPageScrollRules?: ReaderPageScrollRulesApi;
}

function boundedIndex(length: unknown, index: unknown): number {
  const size = Math.max(0, Math.floor(Number(length) || 0));
  if (!size) return 0;
  const value = Math.floor(Number(index) || 0);
  return Math.max(0, Math.min(size - 1, value));
}

function boundedTop(value: unknown, maxTop: unknown): number {
  const maximum = Math.max(0, Number(maxTop) || 0);
  return Math.max(0, Math.min(maximum, Math.round(Number(value) || 0)));
}

function firstUnfinishedItemIndex(
  items: readonly ReaderPageScrollItem[] | null | undefined,
  startIdx: unknown,
  bottom: unknown,
): number {
  if (!items?.length) return -1;
  const start = boundedIndex(items.length, startIdx);
  const limit = Number(bottom) || 0;
  for (let index = start; index < items.length; index += 1) {
    if ((Number(items[index]?.bottom) || 0) > limit + 0.5) return index;
  }
  return items.length;
}

function pageBottomForSlice(
  pageTop: unknown,
  viewHeight: unknown,
  nextItem: ReaderPageScrollItem | null | undefined,
): number {
  const top = Number(pageTop) || 0;
  const fullBottom = top + Math.max(0, Number(viewHeight) || 0);
  if (
    nextItem?.type === "block" && nextItem.atomic && !nextItem.preview &&
    Number(nextItem.top) < fullBottom - 1 && Number(nextItem.bottom) > fullBottom + 0.5
  ) {
    return Math.max(top, Math.min(fullBottom, Math.round(Number(nextItem.top) || 0)));
  }
  return fullBottom;
}

function pageTopForStartItem(
  items: readonly ReaderPageScrollItem[] | null | undefined,
  startIdx: unknown,
  navMaxTop: unknown,
  topPad: unknown,
): number {
  if (!items?.length || Number(startIdx) <= 0) return 0;
  const item = items[boundedIndex(items.length, startIdx)];
  return boundedTop((Number(item?.top) || 0) - (Number(topPad) || 0), navMaxTop);
}

function alignedPageStart(
  items: readonly ReaderPageScrollItem[] | null | undefined,
  startIdx: unknown,
  navMaxTop: unknown,
  topPad: unknown,
): ReaderPageAlignedStart {
  if (!items?.length) return { startIdx: 0, pageTop: 0 };
  let start = boundedIndex(items.length, startIdx);
  let pageTop = pageTopForStartItem(items, start, navMaxTop, topPad);
  let guard = 0;
  while (
    start > 0 && (Number(items[start - 1]?.bottom) || 0) > pageTop + 1 && guard++ < 1_000
  ) {
    start -= 1;
    pageTop = pageTopForStartItem(items, start, navMaxTop, topPad);
  }
  return { startIdx: start, pageTop };
}

function nearestBreakIndex(
  breaks: readonly unknown[] | null | undefined,
  top: unknown,
): number {
  if (!breaks?.length) return 0;
  const target = Number(top) || 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < breaks.length; index += 1) {
    const distance = Math.abs((Number(breaks[index]) || 0) - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function pageIndexForTop(
  breaks: readonly unknown[] | null | undefined,
  top: unknown,
  epsilon: unknown,
): number {
  if (!breaks?.length) return 0;
  const target = Number(top) || 0;
  const slop = Number(epsilon) || 0;
  let result = 0;
  for (let index = 0; index < breaks.length; index += 1) {
    if ((Number(breaks[index]) || 0) <= target + slop) result = index;
    else break;
  }
  return boundedIndex(breaks.length, result);
}

const readerPageScrollRules: ReaderPageScrollRulesApi = Object.freeze({
  firstUnfinishedItemIndex,
  pageBottomForSlice,
  pageTopForStartItem,
  alignedPageStart,
  nearestBreakIndex,
  pageIndexForTop,
});

export function installReaderPageScrollRules(
  global: ReaderPageScrollRuntime,
): ReaderPageScrollRulesApi {
  global.ReaderPageScrollRules = readerPageScrollRules;
  return readerPageScrollRules;
}
