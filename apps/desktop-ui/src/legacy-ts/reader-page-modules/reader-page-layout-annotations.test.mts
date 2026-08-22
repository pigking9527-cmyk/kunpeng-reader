import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./reader-page-layout-annotations.ts", import.meta.url), "utf8");
const bundle = readFileSync(
  new URL("../../../../../ui/generated-reader-page-ts/reader-page-layout-annotations.js", import.meta.url),
  "utf8",
);

const liveNames = Array.from(
  source.matchAll(/^\s*([A-Za-z_$][\w$]*):liveProperty\(/gmu),
  (match) => match[1] ?? "",
).filter(Boolean);

const lazyDependencies = [
  "scrollPort", "viewRect", "readerBugTrace", "perfLog", "beginChapterTurnFx",
  "queuePendingReaderModeInput", "markPageTurnInput", "userNav",
  "sourceAnchorRangeForOffset", "scrollGlyphSafePx", "reportReaderPaintPerf",
  "modeSwitchDiagEvent", "refreshPagedImagePreview", "pageDebugSettingOn",
  "hasPendingContinuousPagedImageSource", "finishChapterBugTrace",
  "clearPagedImagePreview", "clearModeSwitchAnchor", "beginTurnFx",
  "beginPageTurnBugTrace", "scrollStartEpsilonPx", "scrollBottomSafePx",
  "schedulePagedImagePreview", "padModeSwitchAnchorToColumnTop",
  "modeSwitchAnchorAtVisibleTop", "largeChapterFastLayout",
  "forceModeSwitchAnchorColumn", "finishPageTurnBugTrace", "beginChapterBugTrace",
  "clearTurnFx", "cacheChapterBoundarySnapshot",
] as const;

function rect(): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) };
}

function headRuntime(): Record<string, unknown> {
  const calls: Record<string, number> = {};
  class NodePort {}
  class ElementPort extends NodePort {}
  class HtmlElementPort extends ElementPort {}
  class TextPort extends NodePort {}
  class RangePort {}
  const documentPort = {
    getElementById: () => null,
    querySelector: () => null,
    elementFromPoint: () => null,
    documentElement: { lang: "zh-CN", clientWidth: 800 },
  };
  const runtime: Record<string, unknown> = {
    window: null,
    document: documentPort,
    navigator: { userAgent: "unit-test" },
    location: { search: "", origin: "reader://localhost" },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    parent: { postMessage: () => undefined },
    performance: { now: () => 0 },
    Node: NodePort,
    Element: ElementPort,
    HTMLElement: HtmlElementPort,
    Text: TextPort,
    Range: RangePort,
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    getComputedStyle: () => ({ fontSize: "18px", lineHeight: "30px" }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    fetch: async () => ({ json: async () => ({ body: "", head: "" }) }),
    ReaderPageScrollRules: {},
    fastChapterLayout: false,
    scrollCaptureTimer: null,
    pagedImagePreview: null,
    chapterPending: 0,
  };
  runtime.window = runtime;
  for (const name of lazyDependencies) {
    runtime[name] = (...args: readonly unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      if (name === "beginTurnFx") (args[1] as (() => void) | undefined)?.();
      if (name === "viewRect") return rect();
      if (name === "scrollPort") return null;
      if (name === "beginPageTurnBugTrace") return { id: 1, direction: "forward", chapter: 0, page: 0, input: "", detail: null };
      if (name === "beginChapterBugTrace") return { chapter: 0, started: 0 };
      if (name === "beginChapterTurnFx") return Promise.resolve();
      return false;
    };
  }
  runtime.__calls = calls;
  return runtime;
}

test("combined reader page source keeps live, lazy, dictionary and resource gates", () => {
  assert.equal(liveNames.length, 48);
  for (const required of ["S", "CH", "HL", "pageInCh", "pagesInCh", "chapterPending", "fastChapterLayout", "pagedImagePreview"]) {
    assert(liveNames.includes(required), `missing live property ${required}`);
  }
  for (const name of lazyDependencies) {
    assert.match(source, new RegExp(`const\\s+${name}\\s*=.*?=>\\s*runtime\\.${name}\\s*\\(`, "u"));
    assert.doesNotMatch(source, new RegExp(`const\\s+${name}\\s*=\\s*runtime\\.${name}\\s*;`, "u"));
  }
  assert.match(source, /defaults(?:: DictSettings)?=\{plain:false,sense:false,context:false,hypernyms:false,synonyms:false,antonyms:false\}/u);
  assert.match(source, /if\(input\.checked&&!dictEnhancementAvailable\(lastDict,cfg\.key\)\)\{[\s\S]*?input\.checked=false;[\s\S]*?st\[cfg\.key\]=false;/u);
  assert.match(source, /function activeReaderFontReady\(\): boolean\{[\s\S]*?document\.fonts\.check\(fontSize\+'px '\+fontFamily,'中文Aa'\)/u);
  assert.match(source, /function waitForFlowResources\([^)]*\): Promise<void>\{[\s\S]*?!activeReaderFontReady\(\)[\s\S]*?querySelectorAll<HTMLImageElement>\('img'\)[\s\S]*?if\(img\.complete\)continue;[\s\S]*?addEventListener\('load',done\)[\s\S]*?Promise\.race/u);
  assert.match(source, /waitForFlowResources\(\)\.then\(function\(\)\{return new Promise<void>\(function\(resolve\)\{\s*requestAnimationFrame\(function\(\)\{requestAnimationFrame\(function\(\)/u);
  assert.match(source, /function pagedPageCountFromContent[\s\S]*?const textCount=[\s\S]*?return isModernEpubLayout\(\)\?Math\.max\(textCount,fastPagedPageCount\(el\)\):textCount;/u);
  assert.match(source, /function trimTrailingBlankPagedViews[\s\S]*?if\(isModernEpubLayout\(\)\)return pages;[\s\S]*?while\(pages>1&&!pagedViewHasVisibleContent/u);
  assert.match(source, /function buildChapterOpeningSnapshot\(body: string\): HTMLElement\|null\{[\s\S]*?body\.slice\(0,CHAPTER_OPENING_SNAPSHOT_BYTES\)[\s\S]*?querySelectorAll\('script,style,link,base,\[id\]'\)/u);
  assert.match(source, /function scheduleChapterOpeningSnapshotPrefetch[\s\S]*?cacheChapterBoundarySnapshot\(chapter,'start',page\)[\s\S]*?chapter_opening_snapshot_prefetch/u);
  assert.match(source, /scheduleAdjacentChapterPayloadPrefetch[\s\S]*?target===chapter\+1\)scheduleChapterOpeningSnapshotPrefetch\(target,conversion,payload\)/u);
});

test("classic IIFE installs in a head-like VM without a reader DOM", () => {
  const runtime = headRuntime();
  assert.doesNotThrow(() => vm.runInNewContext(bundle, runtime, { filename: "reader-page-layout-annotations.js" }));
  for (const required of ["init", "nextPage", "prevPage", "showChapter", "showDictResult"]) assert.equal(typeof runtime[required], "function");
  for (const name of liveNames) {
    const descriptor = Object.getOwnPropertyDescriptor(runtime, name);
    assert.equal(typeof descriptor?.get, "function", `${name} getter`);
    assert.equal(typeof descriptor?.set, "function", `${name} setter`);
  }
  runtime.pagesInCh = 4;
  runtime.pageInCh = 1;
  (runtime.gotoPage as (page: number, direction: number) => void)(2, 0);
  assert.equal(runtime.pageInCh, 2);
  assert.equal((runtime.__calls as Record<string, number>).beginTurnFx, 1);
});

test("classic compatibility wrappers resolve later globals and never recurse", () => {
  const runtime = headRuntime();
  vm.runInNewContext(bundle, runtime);
  let laterCalls = 0;
  runtime.beginTurnFx = (_direction: number, move: () => void) => { laterCalls += 1; move(); };
  runtime.pagesInCh = 3;
  runtime.pageInCh = 0;
  (runtime.nextPage as () => void)();
  assert.equal(runtime.pageInCh, 1);
  assert.equal(laterCalls, 1);

  const wrapperNames = new Set(
    Array.from(source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^;\n]*?\)\s*=>\s*runtime\.\1\s*\(/gu), (match) => match[1] ?? ""),
  );
  const apiBody = /const\s+api\s*=\s*\{([\s\S]*?)\};\s*Object\.assign\(global,\s*api\)/u.exec(source)?.[1] ?? "";
  const apiNames = new Set(apiBody.split(",").map((part) => part.trim().split(/\s*:\s*/u)[0]).filter(Boolean));
  assert.deepEqual([...wrapperNames].filter((name) => apiNames.has(name)), []);
});

test("hidden paged end markers do not collapse a two-page chapter to one page", () => {
  const start = bundle.indexOf("function fastDualPagedPageCount");
  const end = bundle.indexOf("let pageCountViewportWidth", start);
  assert(start >= 0 && end > start, "fast page-count logic must remain extractable");
  const context: Record<string, unknown> = {
    isDualPage: () => false,
    isScrollMode: () => false,
    columnCountFromWidth: (width: number, hasEnd: boolean) => Math.max(1, Math.round(width / 800) - (hasEnd ? 1 : 0)),
    requiredArrayItem: (items: ArrayLike<DOMRect>, index: number) => items[index],
  };
  vm.runInNewContext(
    `${bundle.slice(start, end)}\nObject.assign(globalThis, { fastPagedPageCount, pagedEndOccupiesColumn });`,
    context,
  );
  const hiddenEnd = { getClientRects: () => [] };
  const visibleEnd = { getClientRects: () => [rect()] };
  const chapter = (marker: unknown, scrollWidth: number) => ({
    scrollWidth,
    querySelector: () => marker,
  });
  const fastPageCount = context.fastPagedPageCount as (element: unknown) => number;

  assert.equal(fastPageCount(chapter(hiddenEnd, 1600)), 2);
  assert.equal(fastPageCount(chapter(visibleEnd, 2400)), 2);
});

test("macOS click paging never clips the whole page when live slice geometry is incomplete", () => {
  const liveSliceStart = source.indexOf("function scrollSliceFromStartIndex");
  const liveSliceEnd = source.indexOf("function firstVisibleScrollItemIndex", liveSliceStart);
  assert(liveSliceStart >= 0 && liveSliceEnd > liveSliceStart, "live slice logic must remain extractable");
  assert.match(source.slice(liveSliceStart, liveSliceEnd), /virtualBottom:virtualBottom/u);

  const clipStart = bundle.indexOf("function applyMacReadableScrollClip");
  const clipEnd = bundle.indexOf("function currentScrollPageClipBlank", clipStart);
  assert(clipStart >= 0 && clipEnd > clipStart, "macOS readable clip logic must remain extractable");
  const style: Record<string, unknown> = { clipPath: "" };
  style.setProperty = (name: string, value: string) => { style[name] = value; };
  const context: Record<string, unknown> = {
    scroller: { clientHeight: 800, style },
    window: { innerHeight: 800 },
    lineHeightPx: () => 20,
  };
  vm.runInNewContext(
    `${bundle.slice(clipStart, clipEnd)}\nObject.assign(globalThis, { applyMacReadableScrollClip });`,
    context,
  );
  const applyClip = context.applyMacReadableScrollClip as (slice: unknown, height: number) => void;

  applyClip({ top: 800, bottom: 1600 }, 800);
  assert.equal(style.clipPath, "none");
  assert.equal(style["-webkit-clip-path"], "none");

  applyClip({ virtualBottom: 400 }, 800);
  assert.match(String(style.clipPath), /^inset\(0px 0px [1-9]\d*px 0px\)$/u);
});

test("macOS compatibility pages use fragment bounds and reclaim only a blocking paragraph gap", () => {
  const start = bundle.indexOf("function virtualItemVisualBounds");
  const end = bundle.indexOf("function applyVirtualFragmentStyle", start);
  assert(start >= 0 && end > start, "virtual page packing must remain extractable");
  const context: Record<string, unknown> = {
    IS_MAC_WEBKIT: true,
    S: { fontSize: 23, paraSpacing: 0.4 },
    fastChapterLayout: true,
    scrollItemsCache: [],
    lineHeightPx: () => 23,
    scrollGlyphSafePx: () => 4,
    scrollBottomSafePx: () => 4,
    isPreviewableBlock: () => false,
  };
  vm.runInNewContext(
    `${bundle.slice(start, end)}\nObject.assign(globalThis, { buildVirtualPageFromIndex, virtualExactBandTailProbePx, virtualExactBandBottomForSlice });`,
    context,
  );
  const buildPage = context.buildVirtualPageFromIndex as (
    items: readonly Record<string, unknown>[],
    start: number,
    height: number,
    maxTop: number,
  ) => Record<string, unknown>;
  const exactTailProbe = context.virtualExactBandTailProbePx as () => number;
  const exactBandBottom = context.virtualExactBandBottomForSlice as (
    page: Record<string, number>,
    height: number,
  ) => number;
  const line = (top: number, bottom: number, fragmentBottom = bottom) => ({
    top,
    bottom,
    height: bottom - top,
    type: "line",
    atomic: false,
    fragments: [{ top, bottom: fragmentBottom }],
  });

  const packed = buildPage([line(0, 27), line(36, 63)], 0, 63, 200);
  assert.equal(packed.endIndex, 1, "the next complete line should fill space wasted only by a paragraph gap");
  assert(Number(packed.virtualBottom) <= 59.5);

  const compactPage = buildPage([line(0, 27), line(36, 63)], 0, 70, 200);
  assert.equal(compactPage.endIndex, 1, "a complete line must not be moved merely to reserve another line");
  assert(Number(compactPage.virtualBottom) <= 63.5);
  assert(70 - Number(compactPage.virtualBottom) < 23, "the residual page tail must stay below one line");

  const overhangingGlyphBoundary = buildPage([line(0, 28), line(32, 60)], 0, 60, 200);
  assert.equal(overhangingGlyphBoundary.endIndex, 1, "glyph overhang must not hide reclaimable paragraph advance");
  assert(Number(overhangingGlyphBoundary.virtualBottom) <= 56.5);
  assert.equal(exactTailProbe(), 39, "the exact macOS scan must include a whole compactable line below the raw viewport band");
  context.scrollItemsCache = [line(0, 27), line(190, 217), line(230, 257), line(270, 297)];
  assert(
    exactBandBottom({ top: 0, startIndex: 0 }, 100) >= 297,
    "the exact scan must advance through source lines that become visible after title-gap compaction",
  );
  assert.match(source, /exactTextLineItemsForBand\(top,virtualExactBandBottomForSlice\(page,viewH\)\)/u);

  const drifted = buildPage([line(0, 27), line(72, 99)], 0, 110, 200);
  const driftedLayout = drifted.virtualLayout as Array<{ top: number }>;
  assert(driftedLayout[1] && driftedLayout[1].top < 45, "an impossible multi-line Range gap must be clamped");

  const clipped = buildPage([line(0, 28), line(27, 55, 60)], 0, 57, 200);
  assert.equal(clipped.endIndex, 0, "a fragment extending beyond the viewport must move to the next page");
  assert.equal(clipped.nextIndex, 1);
  const sourceStart = source.indexOf("function renderVirtualLine");
  const sourceEnd = source.indexOf("function sizeVirtualPreviewClone", sourceStart);
  assert.match(source.slice(sourceStart, sourceEnd), /f\.top\|\|entry\.sourceTop/u);
});

test("virtual footnote badges recover their enclosing link and consume the click", () => {
  const start = bundle.indexOf("function noteLinkInfo");
  const end = bundle.indexOf("function noteFontSizePx", start);
  assert(start >= 0 && end > start, "virtual footnote click helpers must remain extractable");

  let clickListener: ((event: { preventDefault(): void; stopPropagation(): void }) => void) | undefined;
  let popup: { chapter: number; fragment: string } | undefined;
  const traceCalls: Array<{ kind: string; outcome: string; extra: Record<string, unknown> }> = [];
  let prevented = 0;
  let stopped = 0;
  const anchor = {
    tagName: "A",
    getAttribute: (name: string) => name === "href" ? "reader://localhost/book/1#c124~z3" : null,
  };
  const badge = {
    tagName: "SPAN",
    closest: (selector: string) => selector === "a[href]" ? anchor : null,
    querySelector: () => null,
    getAttribute: () => null,
  };
  const context: Record<string, unknown> = {
    curCh: 116,
    pageDebugSettingOn: () => true,
    showFootnote: (_el: unknown, chapter: number, fragment: string) => { popup = { chapter, fragment }; },
    readerBugTrace: (kind: string, outcome: string, _event: unknown, extra: Record<string, unknown>) => { traceCalls.push({ kind, outcome, extra }); },
  };
  vm.runInNewContext(
    `${bundle.slice(start, end)}\nObject.assign(globalThis, { noteLinkInfo, bindVirtualNoteClick });`,
    context,
  );

  const info = (context.noteLinkInfo as (element: unknown) => { anchor: unknown; href: string; frag: string; targetChapter: number | null } | null)(badge);
  assert(info);
  assert.equal(info.anchor, anchor);
  assert.equal(info.href, "reader://localhost/book/1#c124~z3");
  assert.equal(info.frag, "z3");
  assert.equal(info.targetChapter, 124);

  const virtualBadge = {
    style: {} as Record<string, string>,
    addEventListener: (type: string, listener: typeof clickListener) => {
      if (type === "click") clickListener = listener;
    },
  };
  (context.bindVirtualNoteClick as (element: unknown, note: unknown) => void)(virtualBadge, info);
  assert.equal(virtualBadge.style.cursor, "pointer");
  assert(clickListener);
  clickListener({
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(popup, { chapter: 124, fragment: "z3" });
  assert.equal(traceCalls.length, 1);
  assert.equal(traceCalls[0]?.kind, "footnote");
  assert.equal(traceCalls[0]?.outcome, "virtual_click");
  assert.equal(traceCalls[0]?.extra.note_click_consumed, true);
  assert.equal(traceCalls[0]?.extra.note_fragment_present, true);
  const plainAnchor = {
    tagName: "A",
    getAttribute: (name: string) => name === "href" ? "chapter.xhtml#note%2D7" : null,
  };
  const plainInfo = (context.noteLinkInfo as (element: unknown) => { frag: string; targetChapter: number | null } | null)(plainAnchor);
  assert(plainInfo);
  assert.equal(plainInfo.frag, "note-7");
  assert.equal(plainInfo.targetChapter, null);

  const searchStart = bundle.indexOf("function footnoteSearchOrder");
  const searchEnd = bundle.indexOf("function findFootnoteHtmlAcrossChapters", searchStart);
  assert(searchStart >= 0 && searchEnd > searchStart, "footnote search order must remain extractable");
  const searchContext: Record<string, unknown> = { CH: 140, curCh: 116 };
  vm.runInNewContext(
    `${bundle.slice(searchStart, searchEnd)}\nObject.assign(globalThis, { footnoteSearchOrder });`,
    searchContext,
  );
  const searchOrder = searchContext.footnoteSearchOrder as (chapter: number, exact?: boolean) => number[];
  assert.deepEqual(Array.from(searchOrder(124, true)), [124], "an explicit cross-chapter footnote must only fetch its target chapter");
  assert(Array.from(searchOrder(116, false)).length > 1, "legacy fragments without a chapter keep the compatibility fallback");
  const footnoteSource = source.slice(source.indexOf("function popFootnote"), source.indexOf("let sMarks"));
  for (const outcome of ["popup_shown", "open_requested", "toggle_closed", "local_found", "search_started", "search_found", "search_not_found", "search_failed"]) {
    assert.match(footnoteSource, new RegExp(`['\"]${outcome}['\"]`, "u"));
  }
  assert.doesNotMatch(footnoteSource, /readerBugTrace\([^\n]*(?:html|frag|href)\s*:/u);

  const pointerStart = source.indexOf("if(isMacWebKit)document.addEventListener('pointerup'");
  const pointerEnd = source.indexOf("document.addEventListener('click'", pointerStart);
  assert(pointerStart >= 0 && pointerEnd > pointerStart, "macOS fast pointer path must remain extractable");
  const pointerPath = source.slice(pointerStart, pointerEnd);
  assert.match(pointerPath, /pointerTarget\.closest\([^\n]*\[data-vnote-badge=[^\n]*\.rr-note-ref[^\n]*\.vp-inline/u);
  assert.match(pointerPath, /\)\)return;\s*macFastTap=/u);
});

test("chapter scroll pagination is rebuilt only after WebKit can measure visible text", () => {
  const colsStart = source.indexOf("function applyCols");
  const colsEnd = source.indexOf("function setViewOffset", colsStart);
  assert(colsStart >= 0 && colsEnd > colsStart, "column application must remain extractable");
  const columnApplication = source.slice(colsStart, colsEnd);
  assert.match(
    columnApplication,
    /if\(root\.style\.visibility!=='hidden'\)buildScrollBreaks\(true\);/u,
  );
  assert.match(
    columnApplication,
    /if\(root\.style\.visibility!=='hidden'\)buildScrollBreaks\(\);/u,
  );

  const helperStart = bundle.indexOf("function rebuildVisibleScrollPagination");
  const helperEnd = bundle.indexOf("function scrollMaxTop", helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, "visible pagination rebuild must remain extractable");
  const events: string[] = [];
  const chapterRoot = { style: { visibility: "hidden" } };
  const context: Record<string, unknown> = {
    root: chapterRoot,
    scrollBreakSig: "stale",
    usesLineBreakPaging: () => true,
    invalidateScrollItemsCache: () => events.push(`invalidate:${chapterRoot.style.visibility}`),
    buildScrollBreaks: (sync: boolean) => events.push(`build:${sync}:${chapterRoot.style.visibility}`),
  };
  vm.runInNewContext(
    `${bundle.slice(helperStart, helperEnd)}\nObject.assign(globalThis, { rebuildVisibleScrollPagination });`,
    context,
  );

  (context.rebuildVisibleScrollPagination as () => void)();
  assert.equal(chapterRoot.style.visibility, "");
  assert.deepEqual(events, ["invalidate:", "build:true:"]);

  const chapterStart = source.indexOf("function showChapter");
  const chapterEnd = source.indexOf("var curTopAnchor", chapterStart);
  assert(chapterStart >= 0 && chapterEnd > chapterStart, "chapter reveal logic must remain extractable");
  assert.match(
    source.slice(chapterStart, chapterEnd),
    /applyStyle\(\);applyCols\(\);[\s\S]*?rebuildVisibleScrollPagination\(\);\s*pageInCh=0/u,
  );
});

test("fast macOS pages reuse coarse flow nodes and retain exact page results", () => {
  const fastStart = source.indexOf("function fastDocumentTextLineRects");
  const fastEnd = source.indexOf("function documentTextLineRects", fastStart);
  assert(fastStart >= 0 && fastEnd > fastStart, "fast text measurement must remain extractable");
  const fastMeasurement = source.slice(fastStart, fastEnd);
  assert.match(fastMeasurement, /fastTextNodeOffsets=new WeakMap<Text,number>\(\)/u);
  assert.match(fastMeasurement, /fastTextNodeOffsets\.set\(node,docPos\);docPos\+=text\.length;[\s\S]*?if\(!text\.trim\(\)\)continue;/u);

  const candidatesStart = source.indexOf("function exactBandCandidateTextNodes");
  const exactStart = source.indexOf("function exactTextLineItemsForBand", candidatesStart);
  assert(candidatesStart >= 0 && exactStart > candidatesStart, "exact-band candidate lookup must remain extractable");
  const candidates = source.slice(candidatesStart, exactStart);
  assert.match(candidates, /scrollItemsCache[\s\S]*?item\.bottom<bandTop-extra[\s\S]*?item\.top>bandBottom\+extra/u);
  assert.match(candidates, /fastTextNodeOffsets\.get\(node\)/u);

  const exactEnd = source.indexOf("function measureChapterPages", exactStart);
  const exactMeasurement = source.slice(exactStart, exactEnd);
  assert.match(exactMeasurement, /const candidates=exactBandCandidateTextNodes\(bandTop,bandBottom,extra\)/u);
  assert.match(exactMeasurement, /measureNode\(candidate\.node,candidate\.start,false\)/u);
  assert.match(exactMeasurement, /measureNode\(node,nodeStart,true\)/u, "unindexed books must retain the full-walk fallback");
  assert.match(exactMeasurement, /fastChapterLayout&&bandTop<=1[\s\S]*?startsAfterBand[\s\S]*?if\(startsAfterBand\)break/u);
  assert.match(exactMeasurement, /function measureSimpleTextNodeByLine[\s\S]*?caretOffsetInTextNode[\s\S]*?appendMeasuredTextRangeLine/u);
  assert.match(exactMeasurement, /if\(r\.height>Math\.max\(lineHeightPx\(\)\*1\.8,48\)\)return false;/u);
  assert.match(exactMeasurement, /if\(rows\.length===1\)\{[\s\S]*?appendMeasuredTextRangeLine\(linesByKey,keys,node,text,only,pr,scrollTop,style,nodeStart,nodeStart\+text\.length\);/u, "ordinary one-line text must not pay a per-character Range cost");
  assert.match(exactMeasurement, /if\(measureSimpleTextNodeByLine\(node,text,nodeStart,style\)\)\{lastExactBandFastNodes\+\+;return;\}[\s\S]*?lastExactBandCharNodes\+\+;/u);
  assert.match(exactMeasurement, /if\(offset==null\)return false;[\s\S]*?if\(start<0\|\|end<=start\|\|end>text\.length\)return false;/u, "ambiguous caret geometry must use the exact character fallback");

  const pageCacheStart = source.indexOf("function macVirtualPageForSlice");
  const pageCacheEnd = source.indexOf("function scrollImagePreviewEligible", pageCacheStart);
  const pageCache = source.slice(pageCacheStart, pageCacheEnd);
  assert.match(pageCache, /macVirtualPageCacheByKey\.get\(key\)/u);
  assert.match(pageCache, /while\(macVirtualPageCacheByKey\.size>48\)/u);
  assert.match(pageCache, /function scheduleMacVirtualPagePrefetch\(page: ReaderScrollSlice\|null\): void\{/u);
  assert.match(pageCache, /function queueMacVirtualPagePrefetch\([\s\S]*?macVirtualPagePrefetchTimers\.has\(key\)[\s\S]*?macVirtualPageForSlice\(page\)[\s\S]*?page_prefetch/u);
  assert.match(pageCache, /if\(next\)queueMacVirtualPagePrefetch\(next,pageIndex\+1,18\);[\s\S]*?if\(following\)queueMacVirtualPagePrefetch\(following,pageIndex\+2,48\);/u);
  assert.match(source, /function invalidateScrollItemsCache\(\)\{[\s\S]*?macVirtualPagePrefetchTimers\.forEach[\s\S]*?macVirtualPagePrefetchTimers\.clear\(\)/u);
  const maskStart = source.indexOf("function applyScrollPageMask");
  const maskEnd = source.indexOf("function currentScrollPageClipBlank", maskStart);
  const mask = source.slice(maskStart, maskEnd);
  assert.match(mask, /if\(rendered\)scheduleMacVirtualPagePrefetch\(virtualSlice\)/u);
});

test("large chapter transitions reveal an exact opening page before full pagination", () => {
  const paintStart = source.indexOf("function paintFastChapterOpeningPage");
  const paintEnd = source.indexOf("function sourceTextAround", paintStart);
  assert(paintStart >= 0 && paintEnd > paintStart, "opening-page paint helper must remain extractable");
  const openingPaint = source.slice(paintStart, paintEnd);
  assert.match(openingPaint, /initialBottom=viewH\+tail[\s\S]*?exactTextLineItemsForBand\(0,initialBottom\)/u);
  assert.match(openingPaint, /Number\(first\.virtualBottom\|\|0\)<viewH-Math\.max\(lineHeightPx\(\)\*3,72\)[\s\S]*?exactTextLineItemsForBand\(0,viewH\*2\+tail\)/u);
  assert.match(openingPaint, /buildVirtualPageFromIndex\(exact,0,viewH,Math\.max\(viewH,root\.scrollHeight-viewH\),0\)/u);
  assert.match(openingPaint, /renderVirtualScrollPage\(first\)/u);

  const chapterStart = source.indexOf("function showChapter");
  const chapterEnd = source.indexOf("var curTopAnchor", chapterStart);
  const chapterReveal = source.slice(chapterStart, chapterEnd);
  assert.match(chapterReveal, /where==='start'&&!frag&&paintFastChapterOpeningPage\(\)/u);
  assert.match(chapterReveal, /clearTurnFx\(\);[\s\S]*?'chapter_first_page'[\s\S]*?line_nodes='\+lastExactBandFastNodes\+' char_nodes='\+lastExactBandCharNodes[\s\S]*?requestAnimationFrame\(finishChapterLayout\)/u);
});

test("chapter reveal schedules the same WebKit paint stabilization as in-chapter paging", () => {
  const start = source.indexOf("function showChapter");
  const end = source.indexOf("var curTopAnchor", start);
  assert(start >= 0 && end > start, "chapter reveal logic must remain extractable");
  const chapterReveal = source.slice(start, end);
  assert.match(
    chapterReveal,
    /setViewOffset\(\);root\.style\.visibility='';[\s\S]*?stabilizeProgrammaticViewPaint\(\);/u,
  );
});

test("chapter landing keeps real rapid taps and only consumes WebKit's duplicate click", () => {
  const chapterStart = source.indexOf("function showChapter");
  const chapterEnd = source.indexOf("var curTopAnchor", chapterStart);
  const chapterReveal = source.slice(chapterStart, chapterEnd);
  assert.doesNotMatch(chapterReveal, /chapterLandingTapGuard/u);

  const tapStart = source.indexOf("function handleReaderTap");
  const clickEnd = source.indexOf("document.addEventListener('keydown'", tapStart);
  const tapHandlers = source.slice(tapStart, clickEnd);
  assert.doesNotMatch(tapHandlers, /chapter_landing_guard/u);
  assert.match(tapHandlers, /Date\.now\(\)-macFastTap\.at<700&&Math\.abs\(macFastTap\.x-e\.clientX\)<5&&Math\.abs\(macFastTap\.y-e\.clientY\)<5/u);
  assert.doesNotMatch(tapHandlers, /macFastTap\.target===e\.target/u);
});
