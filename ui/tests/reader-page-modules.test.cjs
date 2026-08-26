const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const combined = fs.readFileSync(path.join(uiRoot, "generated-reader-page-ts", "reader-page-layout-annotations.js"), "utf8");
const combinedSource = require("./reader-page-test-source.cjs").compact;
const pagination = combinedSource;
const measurement = combinedSource;
const layout = combinedSource;
const reader = fs.readFileSync(path.join(uiRoot, "generated-ts", "reader.js"), "utf8");
const embeddedRulesRoot = path.join(uiRoot, "generated-reader-page-ts");
const readerPageSourceRoot = path.join(
  uiRoot,
  "..",
  "apps",
  "desktop-ui",
  "src",
  "legacy-ts",
  "reader-page-modules",
);
const layoutSource = fs.readFileSync(path.join(readerPageSourceRoot, "reader-page-layout-annotations.ts"), "utf8");
const runtimeSource = fs.readFileSync(path.join(readerPageSourceRoot, "reader-page-runtime.ts"), "utf8");
const pageBugTrace = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-bug-trace.js"), "utf8");
const modeSwitch = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-mode-switch.js"), "utf8");

function readInjectedModule(name) {
  const root = name === "reader-page-bug-trace.js" || name === "reader-page-scroll-rules.js" || name === "reader-page-layout-annotations.js" || name === "reader-page-mode-switch.js" || name === "reader-page-runtime.js"
    ? embeddedRulesRoot
    : uiRoot;
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("reader page modules parse in their compiled injection order", () => {
  const source = [
    "reader-page-bug-trace.js",
    "reader-page-scroll-rules.js",
    "reader-page-layout-annotations.js",
    "reader-page-mode-switch.js",
    "reader-page-runtime.js",
  ].map(readInjectedModule).join("");
  assert.doesNotThrow(() => new vm.Script(source));
});

test("compiled mode switching restores the six original bare global hooks", () => {
  const context = {};
  vm.runInNewContext(modeSwitch, context);
  vm.runInNewContext(`
    globalThis.__modeSwitchBareHooks = [
      sourceAnchorRangeForOffset,
      clearModeSwitchAnchor,
      hasVisibleLeadMediaBeforeAnchor,
      forceModeSwitchAnchorColumn,
      padModeSwitchAnchorToColumnTop,
      modeSwitchAnchorAtVisibleTop,
    ];
  `, context);
  assert.equal(context.__modeSwitchBareHooks.length, 6);
  assert.ok(context.__modeSwitchBareHooks.every((hook) => typeof hook === "function"));
});

test("highlight menu geometry delegates to a side-effect-free rules module", () => {
  const rulesStart = combined.indexOf("const ReaderPageHighlightRules =");
  const rulesEnd = combined.indexOf("const READER_PAGE_COPY", rulesStart);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart, "highlight rules must remain extractable from the combined bundle");
  const rules = `const requiredArrayItem = (values, index) => values[index]; const requiredRecordValue = (values, key) => values[key];\n${combined.slice(rulesStart, rulesEnd)}\nglobalThis.ReaderPageHighlightRules = ReaderPageHighlightRules;`;
  const annotations = combinedSource;
  const context = {};
  vm.runInNewContext(rules, context);
  const api = context.ReaderPageHighlightRules;
  assert.ok(api);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.envelope([{ left: 8, top: 20, right: 30, bottom: 32 }, { left: 34, top: 20, right: 52, bottom: 32 }]))),
    { left: 8, top: 20, right: 52, bottom: 32, width: 44, height: 12 },
  );
  const rects = [
    { left: 8, top: 20, right: 30, bottom: 32 },
    { left: 34, top: 20, right: 52, bottom: 32 },
    { left: 8, top: 40, right: 25, bottom: 52 },
  ];
  assert.equal(api.nearestRect(rects, { x: 48, y: 25 }), rects[1]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.placement(rects, { x: 48, y: 25 }, () => 0, (rect) => `${rect.top}:${rect.bottom}`))),
    { rect: { left: 8, top: 40, right: 25, bottom: 52, width: 17, height: 12 }, above: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.placement(rects, null, (rect) => rect.top < 40 ? 1 : 2, (rect) => `${rect.top}:${rect.bottom}`))),
    { rect: { left: 8, top: 20, right: 52, bottom: 32, width: 44, height: 12 }, above: true },
  );
  assert.doesNotMatch(combined.slice(rulesStart, rulesEnd), /document\.|window\.|localStorage|parent\.postMessage/);
  assert.match(annotations, /ReaderPageHighlightRules\.placement/);
  assert.match(annotations, /ReaderPageHighlightRules\.groupedEnvelopes/);
});

test("pagination and measurement helpers stay outside the layout assembly", () => {
  assert.equal((combinedSource.match(/function fastPagedPageCount\(/g) || []).length, 1);
  assert.equal((combinedSource.match(/function fastTextRangeNeedsChunks\(/g) || []).length, 1);
  assert.equal((combinedSource.match(/function appendFastTextRangeLines\(/g) || []).length, 1);
  assert.match(pagination, /function fastPagedPageCount\(/);
  assert.match(pagination, /function pagedViewHasVisibleContent\(/);
  assert.match(pagination, /function trimTrailingBlankPagedViews\(/);
  assert.match(pagination, /function fastDualPagedPageCount\(/);
  assert.match(pagination, /querySelectorAll\('img,svg,canvas,video,object,embed,iframe'/);
  assert.match(pagination, /rr-dual-continuation/);
  assert.match(measurement, /function fastTextRangeNeedsChunks\(/);
  assert.match(measurement, /function appendFastTextRangeLines\(/);
});

test("scroll pagination geometry delegates to a side-effect-free rules module", () => {
  const rules = readInjectedModule("reader-page-scroll-rules.js");
  const context = {};
  vm.runInNewContext(rules, context);
  const api = context.ReaderPageScrollRules;
  assert.ok(api);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(api.firstUnfinishedItemIndex([{ bottom: 10 }, { bottom: 42 }], 0, 10), 1);
  assert.equal(api.pageBottomForSlice(100, 80, { type: "block", atomic: true, preview: false, top: 155, bottom: 220 }), 155);
  const aligned = api.alignedPageStart([{ top: 0, bottom: 24 }, { top: 24, bottom: 50 }, { top: 74, bottom: 90 }], 2, 200, 4);
  assert.equal(aligned.startIdx, 2);
  assert.equal(aligned.pageTop, 70);
  assert.equal(api.nearestBreakIndex([0, 108, 217], 161), 1);
  assert.equal(api.pageIndexForTop([0, 108, 217], 216, 2), 2);
  assert.doesNotMatch(rules, /document\.|window\.|localStorage|parent\.postMessage/);
  assert.match(layout, /ReaderPageScrollRules\.pageBottomForSlice/);
  assert.match(layout, /ReaderPageScrollRules\.alignedPageStart/);
  assert.match(layout, /ReaderPageScrollRules\.nearestBreakIndex/);
});

test("scroll and paged reading share one horizontal content box", () => {
  assert.match(layout, /const padL=isDualPage\(\)\?0:hm\.l/);
  assert.match(layout, /const padR=isDualPage\(\)\?0:hm\.r/);
  assert.match(layout, /if\(isScrollMode\(\)\)\{[\s\S]*?pager\.style\.top=sb\.top\+'px';[\s\S]*?pager\.style\.left='0';[\s\S]*?pager\.style\.right='0';/);
  assert.match(layout, /x=Math\.max\(2,pr\.left\+hm\.l\+8\)/);
});

test("zero dual-page gutter removes inherited content-edge spacing", () => {
  assert.match(layout, /if\(isDualPage\(\)&&dualPageGapPx\(\)===0\)c\+='\.rr,\.rr>\*,\.rr body\{margin-left:0 !important;margin-right:0 !important;padding-left:0 !important;padding-right:0 !important;\}'/);
});

test("solid reader backgrounds never render body text with insufficient contrast", () => {
  assert.match(layout, /let colorParts=function\(v\)/);
  assert.match(layout, /if\(!bgImage&&contrast\(fg,bg\)<4\.5\)fg=preset\[1\]/);
  assert.match(layout, /custom:\['#fffdf8','#222'/);
});

test("paged chapters discard a trailing spread with no actual text or media", () => {
  assert.match(layout, /const fastChromiumPageCount=IS_CHROMIUM_WEBVIEW&&!isScrollMode\(\)/);
  assert.match(layout, /pagesInCh=\(?fastLargeChapter\|\|fastChromiumPageCount\)?\?fastPagedPageCount\(root\):pagedPageCountFromContent\(root\)/);
  assert.match(layout, /if\(!fastLargeChapter&&!fastChromiumPageCount\)pagesInCh=trimTrailingBlankPagedViews\(root,pagesInCh\)/);
  assert.match(pagination, /const hasEnd=pagedEndOccupiesColumn\(el\)/);
  assert.doesNotMatch(pagination, /const hasEnd=!!el\.querySelector\('\.rr-end'\)/);
  assert.match(pagination, /while\(pages>1&&!pagedViewHasVisibleContent\(el,pages-1\)\)pages--/);
  assert.match(pagination, /closest\('\.rr-end,\.rr-dual-continuation'\)/);
});

test("scroll-mode changes defer layout but replay the first input in the target mode", () => {
  const settings = fs.readFileSync(path.join(uiRoot, "generated-ts", "reader-settings-ui.js"), "utf8");
  const runtime = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-runtime.js"), "utf8");
  const annotations = combinedSource;
  assert.match(settings, /onChange\(\{ deferModeChange: true \}\)/);
  assert.match(settings, /dualModeToggle\.addEventListener\("change", \(\) => \{[\s\S]*?settings\.flowMode = "paged";\s*settings\.pageMode = dualModeToggle\.checked \? "dual" : "single";[\s\S]*?refreshReadingModeToggles\(\);\s*onChange\(\);/);
  assert.match(runtime, /const queuePendingReaderModeInput = \(replay\)[\s\S]*?g\.pendingReaderModeApplying = true[\s\S]*?g\.setTimeout\(\(\) => dispatchInternalMessage\?\.\(\{ settings, applyQueuedReaderModeChange: 1 \}\), 0\)/);
  assert.match(runtime, /data\.deferModeChange && requestedFlow !== g\.S\.flowMode[\s\S]*?g\.pendingReaderModeSettings = \{ \.\.\.settings \}/);
  assert.match(runtime, /g\.requestAnimationFrame\(\(\) =>[\s\S]*?w\.replayPendingReaderModeInput\?\.\(replay\)/);
  assert.match(annotations, /queuePendingReaderModeInput\(readerModeWheelReplay\(e\)\)/);
  assert.match(annotations, /window\.replayPendingReaderModeInput=function\(input\)\{[\s\S]*?handleReaderWheel\(input\.event\)/);
  assert.match(annotations, /e\.replay/);
});

test("chapter iframe receives the reader language and rebuilds transient controls", () => {
  const annotations = combinedSource;
  const runtime = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-runtime.js"), "utf8");
  const settings = fs.readFileSync(path.join(uiRoot, "generated-ts", "reader-settings-ui.js"), "utf8");
  assert.match(settings, /uiLanguage: global\.ReaderI18n\?\.resolvedLanguage\?\.\(\) \|\| "zh-CN"/);
  assert.match(runtime, /previousLanguage !== g\.S\.uiLanguage && typeof g\.refreshReaderPageLanguage === "function"/);
  assert.match(annotations, /const READER_PAGE_COPY/);
  assert.match(annotations, /function refreshReaderPageLanguage\(\)/);
  assert.match(annotations, /function hlActionLabel\(key\)\{return readerPageText\(key\)\}/);
  assert.match(annotations, /readerPageText\('dictionarySettings'\)/);
});

test("reader gesture closes an open excerpt or correction editor before the reader window", () => {
  const annotations = combinedSource;
  const runtime = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-runtime.js"), "utf8");
  const reader = fs.readFileSync(path.join(uiRoot, "generated-ts", "reader.js"), "utf8");
  const messageGuard = fs.readFileSync(path.join(uiRoot, "generated-ts", "reader-message.js"), "utf8");
  assert.match(annotations, /function closeReaderPageGestureSurface\(\)[\s\S]*?hideExcerptPage\(\)[\s\S]*?hideHlTextPop\(\)/);
  assert.match(runtime, /data\.readerGestureAction === "back"/);
  assert.match(runtime, /postMessage\(\{ readerGestureSurfaceClosed: closed \}, "\*"\)/);
  assert.match(reader, /ReaderGestureClose\?\.frameSurfaceClosed\?\.\(e\.data\.readerGestureSurfaceClosed\)/);
  assert.match(messageGuard, /"readerGestureSurfaceClosed"/);
});

test("highlight menu and settings provide native copy for all ten reader languages", () => {
  const annotations = combinedSource;
  const rawAnnotations = require("./reader-page-test-source.cjs").source;
  const copyStart = rawAnnotations.indexOf("const READER_PAGE_COPY:");
  const copyEnd = rawAnnotations.indexOf("function readerPageLanguage", copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart, "highlight copy catalog must remain extractable");
  const context = {};
  const copyCatalog = require("esbuild").transformSync(
    `${rawAnnotations.slice(copyStart, copyEnd)}\nglobalThis.READER_PAGE_COPY = READER_PAGE_COPY;`,
    { loader: "ts", target: "es2020" },
  ).code;
  context.requiredRecordValue = (record, key) => record[key];
  vm.runInNewContext(copyCatalog, context);

  const locales = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"];
  const keys = [
    "gray", "yellow", "green", "blue", "pink", "web", "dict", "translate", "copy",
    "highlight", "correct", "excerpt", "cross", "semantic", "aiReader", "note",
    "bookmark", "removeHighlight", "highlightMenuSettings", "display", "both", "text",
    "icon", "colorful", "layout", "row", "grid", "size", "small", "medium", "large",
    "dragSort", "searchEngineGoogle", "searchEngineBaidu",
  ];
  for (const locale of locales) {
    assert.ok(context.READER_PAGE_COPY[locale], `missing highlight locale ${locale}`);
    for (const key of keys) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(context.READER_PAGE_COPY[locale], key),
        true,
        `${locale} must translate highlight key ${key}`
      );
    }
  }
  assert.match(annotations, /setBtn\.title=settingsLabel/);
  assert.match(annotations, /settingsPop\.setAttribute\('aria-label',readerPageText\('highlightMenuSettings'\)\)/);
});

test("default highlights and footnotes use the neutral reader palette", () => {
  const annotations = combinedSource;
  const pageStyle = fs.readFileSync(path.join(uiRoot, "reader-page-style.html"), "utf8");
  assert.match(annotations, /\{key:'y',labelKey:'gray',value:'rgba\(126,136,148,\.34\)'\}/);
  assert.match(layout, /light:\['#fff','#222','#2f6fad','#dceafa','#f3f6fa','#b7c7da'\]/);
  assert.match(pageStyle, /#fn-pop\{[\s\S]*?background:#f3f6fa;border:1px solid #b7c7da[\s\S]*?color:#303945/);
  assert.match(pageStyle, /var\(--hl-color,rgba\(126,136,148,\.34\)\)/);
});

test("footnote clicks stay inside the reader page, popup links can jump, and cards cannot overflow horizontally", () => {
  const annotations = combinedSource;
  const pageStyle = fs.readFileSync(path.join(uiRoot, "reader-page-style.html"), "utf8");
  assert.match(annotations, /const inFootnote=!!\(target\.closest&&target\.closest\('#fn-pop'\)\)/);
  assert.match(annotations, /if\(!inFootnote&&!\(targetAnchor&&isNoteLink\(targetAnchor\)\)\)parent\.postMessage\(\{uiClick:1\},'\*'\);/);
  const setupFn = annotations.slice(annotations.indexOf("function setupFn"), annotations.indexOf("// ---- 离线词典"));
  assert.match(setupFn, /pop\.addEventListener\('click',function\(e\)\{if\(e\.target instanceof Element&&e\.target\.closest\('a'\)\)e\.preventDefault\(\)\}\)/);
  assert.doesNotMatch(setupFn, /fnPop\.addEventListener\('click',function\(e\)\{e\.stopPropagation\(\)/);
  assert.match(annotations, /const targetPage=pageOf\(el\);hideFn\(\);if\(targetPage!==pageInCh\)\{rememberReaderJump/);
  assert.match(annotations, /const targetPage2=pageOf\(el2\);hideFn\(\);if\(targetPage2!==pageInCh\)\{rememberReaderJump/);
  const popFootnote = annotations.slice(annotations.indexOf("function popFootnote"), annotations.indexOf("function noteHtml"));
  assert.doesNotMatch(popFootnote, /uiClick:1/);
  assert.match(pageStyle, /#fn-pop\{[\s\S]*?overflow-x:hidden;overflow-y:auto/);
  assert.match(pageStyle, /#fn-pop \.fn-body\{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(layout, /\.rr \.rr-note-wrap\{display:inline !important;margin:0 !important;padding:0 !important/);
  assert.match(layout, /margin:0 0 0 \.02em !important/);
});

test("scroll-page taps only cross chapters at an actual chapter boundary", () => {
  const scrollTurn = layout.slice(layout.indexOf("function scrollPageBy"), layout.indexOf("function pageOf"));
  assert.match(scrollTurn, /const atChapterBoundary=canLeaveScrollChapter\(dir\)/);
  assert.match(scrollTurn, /if\(!target&&!atChapterBoundary\)\{[\s\S]*?const fallbackIndex=[\s\S]*?scrollSliceFromCanonicalBreak/);
  assert.match(scrollTurn, /if\(!target\)\{if\(!atChapterBoundary\)\{[\s\S]*?captureAnchor\(\);report\(true\);return true/);
  assert.match(scrollTurn, /if\(dir>0&&curCh<CH-1\)\{beginChapterTurnFx\(dir,curCh\+1,'start'\);return true\}/);
});

test("scroll-page taps use real long-text line geometry and leave complete glyphs visible", () => {
  const fastLines = layout.slice(layout.indexOf("function fastDocumentTextLineRects"), layout.indexOf("function documentTextLineRects"));
  const virtualPage = layout.slice(layout.indexOf("function buildVirtualPageFromIndex"), layout.indexOf("function applyVirtualFragmentStyle"));
  const mask = layout.slice(layout.indexOf("function applyScrollPageMask"), layout.indexOf("function currentScrollPageClipBlank"));
  assert.match(measurement, /function fastTextRangeNeedsChunks\(/);
  assert.match(measurement, /function appendFastTextRangeLines\(/);
  assert.match(fastLines, /if\(fastTextRangeNeedsChunks\(rects\)\)\{[\s\S]*?appendFastTextRangeLines/);
  assert.match(fastLines, /start\+=192/);
  assert.match(measurement, /for\(let i=start;i<end;i\+\+\)[\s\S]*?range\.setEnd\(node,i\+1\)/);
  assert.match(layout, /const lh=lineHeightPx\(\),glyphPad=scrollGlyphSafePx\(\),bottomGuard=IS_MAC_WEBKIT\?Math\.max\(glyphPad,scrollBottomSafePx\(\)\)/);
  assert.match(virtualPage, /startBounds\.top-glyphPad/);
  assert.match(virtualPage, /nextBounds\.top-glyphPad/);
  assert.match(virtualPage, /sourceAdvance[\s\S]*?virtualLineAdvanceCap[\s\S]*?cappedTop[\s\S]*?verticalShift/);
  assert.match(virtualPage, /sourceGap[\s\S]*?compactGap[\s\S]*?renderedAdvance[\s\S]*?advanceGap[\s\S]*?reducible[\s\S]*?verticalShift\+=reduction/);
  assert.match(mask, /if\(!scrollPagedView\)\{[\s\S]*?clipPath='none'[\s\S]*?return;/);
  assert.match(mask, /const macPage=virtualSlice\?macVirtualPageForSlice\(virtualSlice\):null/);
  assert.match(mask, /if\(rendered\)scheduleMacVirtualPagePrefetch\(virtualSlice\)/);
  assert.match(mask, /applyMacReadableScrollClip\(virtualSlice,maskPort\?maskPort\.clientHeight:0\)/);
  assert.match(layout, /function applyMacReadableScrollClip\(slice,viewH\)/);
});

test("paged touchpad gestures remain grouped across normal macOS inter-event gaps", () => {
  const annotations = combinedSource;
  const wheelHandler = annotations.slice(annotations.indexOf("let pageWheelGesture=null"), annotations.indexOf("window.addEventListener('resize'"));
  assert.match(wheelHandler, /let pageWheelGesture=null,pageWheelGestureTimer=null,pageWheelStartDelta=0,pageWheelTraceEvents=0,pageWheelGestureTraceEvents=0,pageWheelLastTraceAt=0,scrollChapterLock=false/);
  assert.match(wheelHandler, /const PAGE_WHEEL_QUIET_MS=64,PAGE_WHEEL_START_DELTA_PX=2/);
  assert.match(wheelHandler, /function tracePageWheel\(phase,e,gesture,delta,extra\)/);
  assert.match(wheelHandler, /pageWheelGestureTraceEvents\+\+;[\s\S]*?pageWheelTraceEvents\+\+;/);
  assert.doesNotMatch(wheelHandler, /PAGE_WHEEL_TRACE_MAX_EVENTS_PER_GESTURE/);
  assert.match(wheelHandler, /wheel_gap_ms:gap,wheel_accumulated_px:num\(pageWheelStartDelta\),wheel_threshold_px:PAGE_WHEEL_START_DELTA_PX,wheel_quiet_ms:PAGE_WHEEL_QUIET_MS/);
  assert.match(wheelHandler, /readerBugTrace\('wheel',phase,null,data\)/);
  assert.match(wheelHandler, /if\(pageWheelGesture===gesture\)\{[\s\S]*?tracePageWheel\('rearmed',null,null,0,\{direction:gesture.direction,wheel_timer_active:false\}\)[\s\S]*?pageWheelGestureTraceEvents=0[\s\S]*?\},PAGE_WHEEL_QUIET_MS\)/);
  assert.match(wheelHandler, /if\(gesture\)\{[\s\S]*?armPageWheelGestureQuietTimer\(gesture\);[\s\S]*?return;/);
  assert.doesNotMatch(wheelHandler, /reentry|canReenterPageWheelGesture|observePageWheelTail/);
  assert.match(wheelHandler, /pageWheelStartDelta\+=delta;[\s\S]*?if\(magnitude<PAGE_WHEEL_START_DELTA_PX\)\{tracePageWheel\('accumulating',e,null,delta\);return\}/);
  assert.match(wheelHandler, /tracePageWheel\('mode_pending',e,pageWheelGesture,wheelDeltaPx\(e\),\{wheel_mode_pending:true\}\)/);
  assert.match(wheelHandler, /pageWheelGesture=activeGesture;[\s\S]*?pageWheelGestureTraceEvents=0;[\s\S]*?const wheelTurnTrace=tracePageWheel\('turn',e,gesture,delta\);[\s\S]*?markPageTurnInput\('wheel',wheelTurnTrace\);[\s\S]*?if\(direction>0\)nextPage\(\);else prevPage\(\)/);
  assert.match(pageBugTrace, /function pageTurnTraceData\(token, extra\)[\s\S]*?\^wheel_/);
  assert.match(pageBugTrace, /function markPageTurnInput\(input, detail\)[\s\S]*?global\.pageTurnTraceDetail = record\(detail\)/);
  assert.doesNotMatch(wheelHandler, /quietFor|strongNewInput|>=700/);
});

test("only macOS WebKit applies the defensive paged-height calibration", () => {
  assert.match(layout, /function packedPagedBoxHeight\(baseH\)/);
  assert.match(layout, /const bottom=rr\.top\+h/);
  assert.match(layout, /if\(badLine\.bottom-bottom<=1\)break/);
  assert.match(layout, /const allowedTrim=Math\.max\(0,Math\.floor\(lineHeightPx\(\)\)-mg\(S\.marginBottom\)\)/);
  assert.match(layout, /return Math\.max\(raw-allowedTrim,calibrated\)/);
  assert.match(layoutSource, /if\(!isModernEpubLayout\(\)&&!fastLargeChapter&&IS_MAC_WEBKIT\)pageH=packedPagedBoxHeight\(pageH\);/);
});

test("paged paragraphs compact only the boundary gap that would otherwise push a whole line away", () => {
  assert.match(layout, /function tightenPagedParagraphTails\(\)/);
  assert.match(layout, /\.rr p\.rr-page-tail-tight\{margin-bottom:var\(--rr-page-tail-gap,0px\) !important;\}/);
  assert.match(layout, /lineBoxTail=Math\.max\(0,Math\.ceil\(\(line-before\.last\.height\)\/2\)\)/);
  assert.match(layout, /const stats=\{cross:0,fit:0,tightened:0\}/);
  assert.doesNotMatch(layout, /previous\.nextElementSibling!==next/);
  assert.match(layout, /if\(free\+1>=line&&allowed\+1<configured\)/);
  assert.match(layout, /previous\.style\.setProperty\('--rr-page-tail-gap',allowed\+'px'\)/);
  assert.match(layout, /tightenPagedParagraphTails\(\);/);
  assert.match(layoutSource, /function virtualExactBandTailProbePx\(\)/);
  assert.match(layoutSource, /exactTextLineItemsForBand\(top,virtualExactBandBottomForSlice\(page,viewH\)\)/);
});

test("local reading style lets a leading logo decoration float instead of reserving a blank row", () => {
  assert.match(layout, /\.rr h1,\.rr h2,\.rr h3,\.rr h4,\.rr h5,\.rr h6\{margin-top:\.55em !important;margin-bottom:\.55em !important/);
  assert.match(layout, /\.rr>div:first-child:has\(>img\[alt='logo'\]\)\{float:right !important/);
  assert.match(layout, /\.rr>div:first-child:has\(>img\[alt='logo'\]\)>img\{display:block !important/);
  assert.doesNotMatch(layout, /position:absolute !important;top:.*rr-chapter-logo/);
});

test("mode switching keeps a visible leading chapter logo with its title instead of forcing a logo-only column", () => {
  assert.match(modeSwitch, /const hasVisibleLeadMediaBeforeAnchor = \(offset\) =>/);
  assert.match(modeSwitch, /item\.compareDocumentPosition\(range\.startContainer\) & global\.Node\.DOCUMENT_POSITION_FOLLOWING/);
  assert.match(modeSwitch, /anchorBox\.right <= viewport\.left \+ 2 \|\| anchorBox\.left >= viewport\.right - 2/);
  assert.match(modeSwitch, /rect\.right > viewport\.left \+ 2 && rect\.left < viewport\.right - 2/);
  assert.match(modeSwitch, /const forceModeSwitchAnchorColumn = \(offset, preserveLeadMedia\) =>/);
  assert.match(modeSwitch, /if \(!root \|\| offset === null \|\| offset === void 0 \|\| preserveLeadMedia\) return false/);
  const runtime = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-runtime.js"), "utf8");
  assert.match(runtime, /const preserveLeadMedia = changingMode && offset != null && typeof g\.hasVisibleLeadMediaBeforeAnchor === "function"/);
  assert.ok(runtime.indexOf('"hasVisibleLeadMediaBeforeAnchor", offset') < runtime.indexOf("g.S = Object.assign(g.S, settings)"));
  assert.match(runtime, /preserveLeadMedia \}/);
});

test("mode switching positions by the forced marker itself and retains a text anchor for the next switch", () => {
  assert.match(modeSwitch, /mark\.setAttribute\("data-reader-offset", String\(offset\)\)/);
  assert.match(modeSwitch, /child = textChild\.splitText\(start\)/);
  assert.match(modeSwitch, /while \(child\.parentNode && child\.parentNode !== root\)/);
  assert.match(modeSwitch, /const tail = origin\.cloneNode\(false\)/);
  assert.match(modeSwitch, /mark\.__rrModeSwitchPairs = pairs/);
  assert.match(modeSwitch, /for \(let index = pairs\.length - 1; index >= 0; index -= 1\)/);
  assert.match(modeSwitch, /while \(pair\.tail\.firstChild\) pair\.origin\.appendChild\(pair\.tail\.firstChild\)/);
  assert.doesNotMatch(layout, /rr-mode-switch-anchor\{display:block !important;width:0 !important;height:0/);
  assert.match(layout, /forcedMarker=forceModeSwitchAnchorColumn\(anchorOffset,!!opts\.preserveLeadMedia\);/);
  assert.match(layout, /anchor=\{el:forcedMarker,modeSwitchMarker:true\};/);
  assert.match(layout, /if\(columnStartRange\)curTopAnchor=\{range:columnStartRange\}/);
});

test("a forced page-column continuation does not inherit the EPUB paragraph indent", () => {
  assert.match(modeSwitch, /tailElement\.classList\.add\("rr-mode-switch-continuation"\)/);
  assert.match(layout, /\.rr \.rr-mode-switch-continuation\{text-indent:0 !important;\}/);
  assert.doesNotMatch(layout, /rr-mode-switch-anchor\[data-reader-split="1"\]/);
});

test("mode switching pads a Chromium-ignored dynamic column break to the next column top", () => {
  assert.match(modeSwitch, /const padModeSwitchAnchorToColumnTop = \(mark\) =>/);
  assert.match(modeSwitch, /data-reader-mode-switch-spacer/);
  assert.match(modeSwitch, /Math\.ceil\(columnHeight - within\)/);
  assert.match(modeSwitch, /mark\.__rrModeSwitchSpacer = spacer/);
  assert.match(modeSwitch, /if \(spacer\?\.parentNode\) removeNode\(spacer\)/);
  assert.match(layout, /if\(padModeSwitchAnchorToColumnTop\(forcedMarker\)\)applyCols\(\)/);
  assert.match(layout, /if\(opts\.modeSwitch&&anchorOffset!=null\)/);
});

test("mode switching keeps the navigation-time first line and only samples geometry as fallback", () => {
  assert.match(layout, /function visibleTopTextAnchor\(\)/);
  assert.match(layout, /range\.getClientRects\(\)/);
  assert.match(layout, /const pageRank=isDualPage\(\)&&r\.left>=dualBoundary\?1:0/);
  assert.match(layout, /const rng=caretRangeInReader\(x,y\)/);
  assert.match(require("./reader-page-test-source.cjs").source, /双页以左页优先/);
  const runtime = fs.readFileSync(path.join(embeddedRulesRoot, "reader-page-runtime.js"), "utf8");
  assert.match(runtime, /changingMode && stored != null && fn\(g, "anchorValid", g\.curTopAnchor\)/);
  assert.match(runtime, /else if \(changingMode && typeof g\.visibleTopTextAnchor === "function"\) anchor = fn\(g, "visibleTopTextAnchor"\)/);
  assert.match(runtime, /if \(!fn\(g, "anchorValid", anchor\)\) anchor = fn\(g, "topAnchor"\)/);
  assert.match(modeSwitch, /const modeSwitchAnchorAtVisibleTop = \(offset\) =>/);
  assert.match(runtime, /g\.modeSwitchRecoveryOffset = null/);
  assert.doesNotMatch(runtime, /sourceAnchorRangeForOffset\(modeSwitchRecoveryOffset\)/);
});

test("every switch into paged layout forces the preserved first line to a column top", () => {
  assert.match(runtimeSource, /modeSwitch: changingMode/);
  assert.match(runtimeSource, /alignDualAnchor: changingMode && fn<boolean>\(g, "isDualPage"\)/);
  assert.match(runtimeSource, /forceAnchorColumn: \(flowChanged \|\| pageChanged\) && !fn<boolean>\(g, "isScrollMode"\)/);
});

test("mode switch paragraph fragments remain source text for highlights and search", () => {
  const annotations = combinedSource;
  const rawAnnotations = require("./reader-page-test-source.cjs").source;
  const generatedMatcher = rawAnnotations.match(/function generatedTextNode\(node:[\s\S]*?\n\}/);
  assert.ok(generatedMatcher);
  assert.doesNotMatch(generatedMatcher[0].replace(/\/\/.*$/gm, ""), /rr-mode-switch-anchor/);
  assert.match(rawAnnotations, /rr-mode-switch-anchor 承载的是从原段落拆出的真实正文/);
});

function paginationContext(width = 1200, pageMode = "single") {
  const context = {
    S: {
      styleMode: "local",
      fontSize: 18,
      noteFontSize: 14,
      lineHeight: 1.7,
      paraSpacing: 0.6,
      letterSpacing: 0,
      fontFamily: "",
      marginTop: 18,
      marginBottom: 24,
      marginLeft: 28,
      marginRight: 28,
      pageMode,
      flowMode: "paged",
    },
    window: { innerWidth: width, innerHeight: 800 },
    document: { documentElement: { clientHeight: 800 } },
    pager: null,
    scroller: null,
  };
  const compiledPagination = combined;
  const paginationStart = compiledPagination.indexOf("function isScrollMode()");
  const paginationEnd = compiledPagination.indexOf("function anchorPage", paginationStart);
  assert.ok(paginationStart >= 0 && paginationEnd > paginationStart, "pagination logic must remain extractable from the combined bundle");
  vm.runInNewContext(`${compiledPagination.slice(paginationStart, paginationEnd)}\nconst columnsPerView = () => isDualPage() ? 2 : 1;\nObject.assign(globalThis, { isDualPage, mg, pageCountSig, layoutSig, pageCountLayout, pageLayout, columnsPerView, columnCountFromWidth });\nObject.defineProperty(globalThis, 'pageCountViewportWidth', { get: () => pageCountViewportWidth, set: value => { pageCountViewportWidth = value; } });`, context);
  return context;
}

test("pagination geometry keeps whole-book signatures independent from dual-page mode", () => {
  const context = paginationContext(1200, "single");
  const singlePageCountSig = context.pageCountSig();
  const singleLayoutSig = context.layoutSig();
  context.S.pageMode = "dual";
  assert.equal(context.pageCountSig(), singlePageCountSig);
  assert.notEqual(context.layoutSig(), singleLayoutSig);
  assert.equal(context.columnsPerView(), 2);
  const dual = context.pageLayout();
  assert.equal(dual.pageStep, dual.colPitch * 2);

  context.window.innerWidth = 899;
  assert.equal(context.isDualPage(), false);
  assert.equal(context.columnsPerView(), 1);
  assert.equal(context.pageLayout().pageStep, 899);
});

test("whole-book page cache keeps its base width while a side pane shrinks the live reader", () => {
  const context = paginationContext(1200, "single");
  const baseSig = context.pageCountSig();
  assert.equal(context.pageCountLayout().width, 1200);
  context.window.innerWidth = 820;
  assert.equal(context.pageCountSig(), baseSig);
  assert.equal(context.pageCountLayout().width, 1200);
  context.pageCountViewportWidth = 1280;
  assert.notEqual(context.pageCountSig(), baseSig);
  assert.equal(context.pageCountLayout().width, 1280);
});

test("pagination geometry clamps unsafe margins and keeps dual counts in spreads", () => {
  const context = paginationContext(1200, "dual");
  assert.equal(context.mg(-8), 0);
  assert.equal(context.mg(999), 240);
  const layout = context.pageLayout();
  const sixPhysicalColumns = 6 * layout.colPitch + layout.l - layout.gap;
  assert.equal(context.columnCountFromWidth(sixPhysicalColumns, false), 3);
});

test("dual-page chapter endings fill the right page and label the cross-chapter spread", () => {
  assert.match(layout, /appendDualChapterContinuation/);
  assert.match(layout, /class='rr-dual-continuation'|class="rr-dual-continuation"/);
  assert.match(layout, /dualContinuationChapter===curCh\+1&&pageInCh===pagesInCh-1/);
  assert.match(layout, /root\.insertAdjacentHTML\('beforeend','<div class="rr-end"><\/div>'\)|root\.insertAdjacentHTML\('beforeend','<div class='rr-end'><\/div>'\)/);
  assert.match(layout, /body:not\(\.scroll-mode\):not\(\.line-paged-mode\) \.rr-end\{display:none !important;\}/);
  assert.match(layout, /beginChapterTurnFx\(1,visibleDualContinuationChapter\(\),'after-dual-continuation'\)/);
  assert.match(pagination, /\.rr-end,\.rr-dual-continuation/);
  assert.match(reader, /dualChapterNumber/);
});

test("incremental page cache resumes incomplete books and accepts complete books", () => {
  const scheduled = [];
  const context = {
    CH: 3,
    pageCountSig: () => "same-layout",
    report: () => {},
    parent: { postMessage: () => {} },
    clearTimeout: () => {},
    setTimeout: (_callback, delay) => {
      scheduled.push(delay);
      return 1;
    },
  };
  const measurementStart = combined.indexOf("var measurer, chapterPages");
  const measurementEnd = combined.indexOf("const ReaderPageHighlightRules", measurementStart);
  assert.ok(measurementStart >= 0 && measurementEnd > measurementStart, "measurement logic must remain extractable from the combined bundle");
  const measurementSource = combined.slice(measurementStart, measurementEnd)
    .replace("var measurer, chapterPages = [], measureDone = false, measureToken = 0, measureTimer = null, pageSig = \"\", measurePaused = false;", "var measurer, chapterPages = [], measureDone = false, measureToken = 0, measureTimer = null, pageSig = '', measurePaused = false;");
  vm.runInNewContext(`${measurementSource}\nObject.assign(globalThis, { applyPageCache, readerPageCacheSnapshot: () => ({ measureDone, chapterPages: chapterPages.slice() }) });`, context);
  context.applyPageCache({ sig: "same-layout", pages: [4, 0, 6], complete: false });
  assert.equal(context.readerPageCacheSnapshot().measureDone, false);
  assert.deepEqual(Array.from(context.readerPageCacheSnapshot().chapterPages), [4, 0, 6]);
  assert.deepEqual(scheduled, [60]);

  scheduled.length = 0;
  context.applyPageCache({ sig: "same-layout", pages: [4, 5, 6], complete: true });
  assert.equal(context.readerPageCacheSnapshot().measureDone, true);
  assert.deepEqual(scheduled, []);
});
