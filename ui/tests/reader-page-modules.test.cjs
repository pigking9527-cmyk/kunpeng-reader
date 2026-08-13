const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const pagination = fs.readFileSync(path.join(uiRoot, "reader-page-pagination.js"), "utf8");
const measurement = fs.readFileSync(path.join(uiRoot, "reader-page-measurement.js"), "utf8");
const layout = fs.readFileSync(path.join(uiRoot, "reader-page-layout.js"), "utf8");
const reader = fs.readFileSync(path.join(uiRoot, "reader.js"), "utf8");
const modeSwitch = fs.readFileSync(path.join(uiRoot, "reader-page-mode-switch.js"), "utf8");
const pageBugTrace = fs.readFileSync(path.join(uiRoot, "reader-page-bug-trace.js"), "utf8");

test("reader page modules parse in their compiled injection order", () => {
  const source = [
    "reader-page-bug-trace.js",
    "reader-page-scroll-rules.js",
    "reader-page-layout.js",
    "reader-page-end.js",
    "reader-page-pagination.js",
    "reader-page-measurement.js",
    "reader-page-highlight-rules.js",
    "reader-page-annotations.js",
    "reader-page-mode-switch.js",
    "reader-page-runtime.js",
  ].map((name) => fs.readFileSync(path.join(uiRoot, name), "utf8")).join("");
  assert.doesNotThrow(() => new vm.Script(source));
});

test("highlight menu geometry delegates to a side-effect-free rules module", () => {
  const rules = fs.readFileSync(path.join(uiRoot, "reader-page-highlight-rules.js"), "utf8");
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
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
  assert.match(rules, /不读取 DOM、设置或/);
  assert.doesNotMatch(rules, /document\.|window\.|localStorage|parent\.postMessage/);
  assert.match(annotations, /ReaderPageHighlightRules\.placement/);
  assert.match(annotations, /ReaderPageHighlightRules\.groupedEnvelopes/);
});

test("pagination and measurement helpers stay outside the layout assembly", () => {
  assert.doesNotMatch(layout, /function fastPagedPageCount\(/);
  assert.doesNotMatch(layout, /function fastTextRangeNeedsChunks\(/);
  assert.doesNotMatch(layout, /function appendFastTextRangeLines\(/);
  assert.match(pagination, /function fastPagedPageCount\(el\)/);
  assert.match(pagination, /function pagedViewHasVisibleContent\(el,index\)/);
  assert.match(pagination, /function trimTrailingBlankPagedViews\(el,count\)/);
  assert.match(pagination, /function fastDualPagedPageCount\(el\)/);
  assert.match(pagination, /var els=el\.querySelectorAll\('img,svg,canvas,video,object,embed,iframe'\)/);
  assert.match(pagination, /rr-dual-continuation/);
  assert.match(measurement, /function fastTextRangeNeedsChunks\(rects\)/);
  assert.match(measurement, /function appendFastTextRangeLines\(out,node,range,start,end,pr,scrollTop\)/);
});

test("scroll pagination geometry delegates to a side-effect-free rules module", () => {
  const rules = fs.readFileSync(path.join(uiRoot, "reader-page-scroll-rules.js"), "utf8");
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
  assert.match(rules, /不读取 DOM、设置或\n\/\/ 全局状态/);
  assert.doesNotMatch(rules, /document\.|window\.|localStorage|parent\.postMessage/);
  assert.match(layout, /ReaderPageScrollRules\.pageBottomForSlice/);
  assert.match(layout, /ReaderPageScrollRules\.alignedPageStart/);
  assert.match(layout, /ReaderPageScrollRules\.nearestBreakIndex/);
});

test("scroll and paged reading share one horizontal content box", () => {
  assert.match(layout, /var padL=isDualPage\(\)\?0:hm\.l/);
  assert.match(layout, /var padR=isDualPage\(\)\?0:hm\.r/);
  assert.match(layout, /if\(isScrollMode\(\)\)\{[\s\S]*?pager\.style\.top=sb\.top\+'px';[\s\S]*?pager\.style\.left='0';[\s\S]*?pager\.style\.right='0';/);
  assert.match(layout, /x=Math\.max\(2,pr\.left\+hm\.l\+8\)/);
});

test("zero dual-page gutter removes inherited content-edge spacing", () => {
  assert.match(layout, /if\(isDualPage\(\)&&dualPageGapPx\(\)===0\)c\+='\.rr,\.rr>\*,\.rr body\{margin-left:0 !important;margin-right:0 !important;padding-left:0 !important;padding-right:0 !important;\}'/);
});

test("solid reader backgrounds never render body text with insufficient contrast", () => {
  assert.match(layout, /var colorParts=function\(v\)/);
  assert.match(layout, /if\(!bgImage&&contrast\(fg,bg\)<4\.5\)fg=preset\[1\]/);
  assert.match(layout, /custom:\['#fffdf8','#222'/);
});

test("paged chapters discard a trailing spread with no actual text or media", () => {
  assert.match(layout, /if\(!fastLargeChapter\)pagesInCh=trimTrailingBlankPagedViews\(root,pagesInCh\)/);
  assert.match(pagination, /while\(pages>1&&!pagedViewHasVisibleContent\(el,pages-1\)\)pages--/);
  assert.match(pagination, /parent\.closest&&parent\.closest\('\.rr-end,\.rr-dual-continuation'\)/);
});

test("scroll-mode changes defer layout but replay the first input in the target mode", () => {
  const settings = fs.readFileSync(path.join(uiRoot, "reader-settings-ui.js"), "utf8");
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  assert.match(settings, /onChange\(\{ deferModeChange: true \}\)/);
  assert.match(settings, /dualModeToggle\.addEventListener\("change", \(\) => \{[\s\S]*?settings\.flowMode = "paged";\s*settings\.pageMode = dualModeToggle\.checked \? "dual" : "single";[\s\S]*?refreshReadingModeToggles\(\);\s*onChange\(\);/);
  assert.match(runtime, /function queuePendingReaderModeInput\(replay\)[\s\S]*?pendingReaderModeApplying=true[\s\S]*?window\.postMessage\(\{settings:next,applyQueuedReaderModeChange:1\},'\*'\)/);
  assert.match(runtime, /var shouldDeferFlowModeChange=!!e\.data\.deferModeChange&&requestedFlow!==S\.flowMode;[\s\S]*?if\(shouldDeferFlowModeChange\)[\s\S]*?pendingReaderModeSettings=Object\.assign\(\{\},e\.data\.settings\)/);
  assert.match(runtime, /requestAnimationFrame\(function\(\)\{[\s\S]*?window\.replayPendingReaderModeInput\(replay\)/);
  assert.match(annotations, /queuePendingReaderModeInput\(readerModeWheelReplay\(e\)\)/);
  assert.match(annotations, /window\.replayPendingReaderModeInput=function\(input\)\{[\s\S]*?handleReaderWheel\(input\.event\)/);
  assert.match(annotations, /else if\(e\.replay\)\{/);
});

test("chapter iframe receives the reader language and rebuilds transient controls", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  const settings = fs.readFileSync(path.join(uiRoot, "reader-settings-ui.js"), "utf8");
  assert.match(settings, /uiLanguage: window\.ReaderI18n\?\.resolvedLanguage\?\.\(\) \|\| "zh-CN"/);
  assert.match(runtime, /previousUiLanguage!==S\.uiLanguage&&typeof refreshReaderPageLanguage==='function'/);
  assert.match(annotations, /var READER_PAGE_COPY=/);
  assert.match(annotations, /function refreshReaderPageLanguage\(\)/);
  assert.match(annotations, /function hlActionLabel\(key\)\{return readerPageText\(key\);\}/);
  assert.match(annotations, /readerPageText\('dictionarySettings'\)/);
});

test("reader gesture closes an open excerpt or correction editor before the reader window", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  const reader = fs.readFileSync(path.join(uiRoot, "reader.js"), "utf8");
  const messageGuard = fs.readFileSync(path.join(uiRoot, "reader-message.js"), "utf8");
  assert.match(annotations, /function closeReaderPageGestureSurface\(\)[\s\S]*?hideExcerptPage\(\)[\s\S]*?hideHlTextPop\(\)/);
  assert.match(runtime, /e\.data\.readerGestureAction==='back'/);
  assert.match(runtime, /parent\.postMessage\(\{readerGestureSurfaceClosed:!!readerGestureSurfaceClosed\},'\*'\)/);
  assert.match(reader, /ReaderGestureClose\?\.frameSurfaceClosed\?\.\(e\.data\.readerGestureSurfaceClosed\)/);
  assert.match(messageGuard, /"readerGestureSurfaceClosed"/);
});

test("highlight menu and settings provide native copy for all ten reader languages", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const copyStart = annotations.indexOf("var READER_PAGE_COPY=");
  const copyEnd = annotations.indexOf("function readerPageLanguage", copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart, "highlight copy catalog must remain extractable");
  const context = {};
  vm.runInNewContext(annotations.slice(copyStart, copyEnd), context);

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
  assert.match(annotations, /hlSettingsPop\.setAttribute\('aria-label',readerPageText\('highlightMenuSettings'\)\)/);
});

test("default highlights and footnotes use the neutral reader palette", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const pageStyle = fs.readFileSync(path.join(uiRoot, "reader-page-style.html"), "utf8");
  assert.match(annotations, /\{key:'y',labelKey:'gray',value:'rgba\(126,136,148,\.34\)'\}/);
  assert.match(layout, /light:\['#fff','#222','#2f6fad','#dceafa','#f3f6fa','#b7c7da'\]/);
  assert.match(pageStyle, /#fn-pop\{[\s\S]*?background:#f3f6fa;border:1px solid #b7c7da[\s\S]*?color:#303945/);
  assert.match(pageStyle, /var\(--hl-color,rgba\(126,136,148,\.34\)\)/);
});

test("footnote clicks stay inside the reader page, popup links can jump, and cards cannot overflow horizontally", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const pageStyle = fs.readFileSync(path.join(uiRoot, "reader-page-style.html"), "utf8");
  assert.match(annotations, /var inFootnote=!!\(target\.closest&&target\.closest\('#fn-pop'\)\);/);
  assert.match(annotations, /if\(!inFootnote&&!\(targetAnchor&&isNoteLink\(targetAnchor\)\)\)parent\.postMessage\(\{uiClick:1\},'\*'\);/);
  const setupFn = annotations.slice(annotations.indexOf("function setupFn"), annotations.indexOf("// ---- 离线词典"));
  assert.match(setupFn, /fnPop\.addEventListener\('click',function\(e\)\{if\(e\.target\.closest&&e\.target\.closest\('a'\)\)e\.preventDefault\(\);\}\);/);
  assert.doesNotMatch(setupFn, /fnPop\.addEventListener\('click',function\(e\)\{e\.stopPropagation\(\)/);
  assert.match(annotations, /var targetPage=pageOf\(el\);hideFn\(\);if\(targetPage!==pageInCh\)\{rememberReaderJump/);
  assert.match(annotations, /var targetPage2=pageOf\(el2\);hideFn\(\);if\(targetPage2!==pageInCh\)\{rememberReaderJump/);
  const popFootnote = annotations.slice(annotations.indexOf("function popFootnote"), annotations.indexOf("function noteHtml"));
  assert.doesNotMatch(popFootnote, /uiClick:1/);
  assert.match(pageStyle, /#fn-pop\{[\s\S]*?overflow-x:hidden;overflow-y:auto/);
  assert.match(pageStyle, /#fn-pop \.fn-body\{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(layout, /\.rr \.rr-note-wrap\{display:inline !important;margin:0 !important;padding:0 !important/);
  assert.match(layout, /margin:0 0 0 \.02em !important/);
});

test("scroll-page taps only cross chapters at an actual chapter boundary", () => {
  const scrollTurn = layout.slice(layout.indexOf("function scrollPageBy"), layout.indexOf("function pageOf"));
  assert.match(scrollTurn, /var atChapterBoundary=canLeaveScrollChapter\(dir\);/);
  assert.match(scrollTurn, /if\(!target&&!atChapterBoundary\)\{[\s\S]*?var fallbackIndex=[\s\S]*?scrollSliceFromCanonicalBreak/);
  assert.match(scrollTurn, /if\(!target\)\{\s*if\(!atChapterBoundary\)\{[\s\S]*?captureAnchor\(\);report\(true\);\s*return true;/);
  assert.match(scrollTurn, /if\(dir>0&&curCh<CH-1\)\{beginChapterTurnFx\(dir,curCh\+1,'start'\);return true;\}/);
});

test("scroll-page taps use real long-text line geometry and leave complete glyphs visible", () => {
  const fastLines = layout.slice(layout.indexOf("function fastDocumentTextLineRects"), layout.indexOf("function documentTextLineRects"));
  const virtualPage = layout.slice(layout.indexOf("function buildVirtualPageFromIndex"), layout.indexOf("function applyVirtualFragmentStyle"));
  const mask = layout.slice(layout.indexOf("function applyScrollPageMask"), layout.indexOf("function currentScrollPageClipBlank"));
  assert.match(measurement, /function fastTextRangeNeedsChunks\(rects\)/);
  assert.match(measurement, /function appendFastTextRangeLines\(out,node,range,start,end,pr,scrollTop\)/);
  assert.match(fastLines, /if\(fastTextRangeNeedsChunks\(rects\)\)\{[\s\S]*?appendFastTextRangeLines/);
  assert.match(fastLines, /start\+=192/);
  assert.match(measurement, /极少数电子书会把每个 192 字片段也合成一个高矩形/);
  assert.match(virtualPage, /var lh=lineHeightPx\(\),glyphPad=scrollGlyphSafePx\(\),bottomGuard=IS_MAC_WEBKIT\?Math\.max\(glyphPad,Math\.ceil\(lh\*0\.36\)\)/);
  assert.match(virtualPage, /items\[startIdx\].top\)\|\|0\)-glyphPad/);
  assert.match(virtualPage, /items\[nextIdx\].top\)\|\|0\)-glyphPad/);
  assert.match(mask, /if\(!scrollPagedView\)\{[\s\S]*?clipPath='none'[\s\S]*?return;/);
  assert.match(mask, /var macPage=!fastChapterLayout&&virtualSlice\?macVirtualPageForSlice\(virtualSlice\):null;/);
  assert.match(mask, /applyMacReadableScrollClip\(virtualSlice,maskPort\?maskPort\.clientHeight:0\)/);
  assert.match(layout, /function applyMacReadableScrollClip\(slice,viewH\)/);
});

test("paged touchpad gestures remain grouped across normal macOS inter-event gaps", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const wheelHandler = annotations.slice(annotations.indexOf("var pageWheelGesture=null"), annotations.indexOf("window.addEventListener('resize'"));
  assert.match(wheelHandler, /var pageWheelGesture=null,pageWheelGestureTimer=null,pageWheelStartDelta=0,pageWheelTraceEvents=0,pageWheelGestureTraceEvents=0,pageWheelLastTraceAt=0,scrollChapterLock=false/);
  assert.match(wheelHandler, /var PAGE_WHEEL_QUIET_MS=64,PAGE_WHEEL_START_DELTA_PX=2/);
  assert.match(wheelHandler, /function tracePageWheel\(phase,e,gesture,delta,extra\)/);
  assert.match(wheelHandler, /pageWheelGestureTraceEvents\+\+;[\s\S]*?pageWheelTraceEvents\+\+;/);
  assert.doesNotMatch(wheelHandler, /PAGE_WHEEL_TRACE_MAX_EVENTS_PER_GESTURE/);
  assert.match(wheelHandler, /wheel_gap_ms:gap,wheel_accumulated_px:num\(pageWheelStartDelta\),wheel_threshold_px:PAGE_WHEEL_START_DELTA_PX,wheel_quiet_ms:PAGE_WHEEL_QUIET_MS/);
  assert.match(wheelHandler, /readerBugTrace\('wheel',phase,null,data\)/);
  assert.match(wheelHandler, /if\(pageWheelGesture===gesture\)\{[\s\S]*?tracePageWheel\('rearmed',null,null,0,\{direction:gesture.direction,wheel_timer_active:false\}\);[\s\S]*?pageWheelGestureTraceEvents=0;[\s\S]*?\},PAGE_WHEEL_QUIET_MS\)/);
  assert.match(wheelHandler, /if\(gesture\)\{[\s\S]*?armPageWheelGestureQuietTimer\(gesture\);[\s\S]*?return;/);
  assert.doesNotMatch(wheelHandler, /reentry|canReenterPageWheelGesture|observePageWheelTail/);
  assert.match(wheelHandler, /pageWheelStartDelta\+=delta;[\s\S]*?if\(magnitude<PAGE_WHEEL_START_DELTA_PX\)\{tracePageWheel\('accumulating',e,null,delta\);return;\}/);
  assert.match(wheelHandler, /tracePageWheel\('mode_pending',e,pageWheelGesture,wheelDeltaPx\(e\),\{wheel_mode_pending:true\}\)/);
  assert.match(wheelHandler, /pageWheelGesture=gesture;[\s\S]*?pageWheelGestureTraceEvents=0;[\s\S]*?var wheelTurnTrace=tracePageWheel\('turn',e,gesture,delta\);[\s\S]*?markPageTurnInput\('wheel',wheelTurnTrace\);[\s\S]*?if\(direction>0\)nextPage\(\);else prevPage\(\);/);
  assert.match(pageBugTrace, /function pageTurnTraceData\(token,extra\)[\s\S]*?\^wheel_/);
  assert.match(pageBugTrace, /markPageTurnInput\(input,detail\)[\s\S]*?pageTurnTraceDetail=detail/);
  assert.doesNotMatch(wheelHandler, /quietFor|strongNewInput|>=700/);
});

test("only macOS WebKit applies the defensive paged-height calibration", () => {
  assert.match(layout, /function packedPagedBoxHeight\(baseH\)/);
  assert.match(layout, /var bottom=rr\.top\+h;/);
  assert.match(layout, /if\(lines\[bad\]\.bottom-bottom<=1\)break;/);
  assert.match(layout, /var allowedTrim=Math\.max\(0,Math\.floor\(lineHeightPx\(\)\)-mg\(S\.marginBottom\)\);/);
  assert.match(layout, /return Math\.max\(raw-allowedTrim,calibrated\);/);
  assert.match(layout, /if\(!fastLargeChapter&&IS_MAC_WEBKIT\)pageH=packedPagedBoxHeight\(pageH\);/);
});

test("paged paragraphs compact only the boundary gap that would otherwise push a whole line away", () => {
  assert.match(layout, /function tightenPagedParagraphTails\(\)/);
  assert.match(layout, /\.rr p\.rr-page-tail-tight\{margin-bottom:var\(--rr-page-tail-gap,0px\) !important;\}/);
  assert.match(layout, /lineBoxTail=Math\.max\(0,Math\.ceil\(\(line-before\.last\.height\)\/2\)\)/);
  assert.match(layout, /var stats=\{cross:0,fit:0,tightened:0\};/);
  assert.doesNotMatch(layout, /previous\.nextElementSibling!==next/);
  assert.match(layout, /if\(free\+1>=line&&allowed\+1<configured\)/);
  assert.match(layout, /previous\.style\.setProperty\('--rr-page-tail-gap',allowed\+'px'\)/);
  assert.match(layout, /tightenPagedParagraphTails\(\);/);
});

test("local reading style lets a leading logo decoration float instead of reserving a blank row", () => {
  assert.match(layout, /\.rr h1,\.rr h2,\.rr h3,\.rr h4,\.rr h5,\.rr h6\{margin-top:\.55em !important;margin-bottom:\.55em !important/);
  assert.match(layout, /\.rr>div:first-child:has\(>img\[alt="logo"\]\)\{float:right !important/);
  assert.match(layout, /\.rr>div:first-child:has\(>img\[alt="logo"\]\)>img\{display:block !important/);
  assert.doesNotMatch(layout, /position:absolute !important;top:.*rr-chapter-logo/);
});

test("mode switching keeps a visible leading chapter logo with its title instead of forcing a logo-only column", () => {
  assert.match(modeSwitch, /function hasVisibleLeadMediaBeforeAnchor\(offset\)/);
  assert.match(modeSwitch, /item\.compareDocumentPosition\(range\.startContainer\)&Node\.DOCUMENT_POSITION_FOLLOWING/);
  assert.match(modeSwitch, /anchorBox\.right<=vr\.left\+2\|\|anchorBox\.left>=vr\.right-2/);
  assert.match(modeSwitch, /r\.right>vr\.left\+2&&r\.left<vr\.right-2/);
  assert.match(modeSwitch, /function forceModeSwitchAnchorColumn\(offset,preserveLeadMedia\)/);
  assert.match(modeSwitch, /if\(!root\|\|offset==null\|\|preserveLeadMedia\)return false;/);
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  assert.match(runtime, /var preserveLeadMedia=incomingModeChange&&anchorOffset!=null&&typeof hasVisibleLeadMediaBeforeAnchor==='function'/);
  assert.ok(runtime.indexOf("hasVisibleLeadMediaBeforeAnchor(anchorOffset)") < runtime.indexOf("S=Object.assign(S,e.data.settings)"));
  assert.match(runtime, /preserveLeadMedia:preserveLeadMedia/);
});

test("mode switching positions by the forced marker itself and retains a text anchor for the next switch", () => {
  assert.match(modeSwitch, /mark\.setAttribute\('data-reader-offset',String\(offset\)\)/);
  assert.match(modeSwitch, /child=child\.splitText\(start\)/);
  assert.match(modeSwitch, /while\(child&&child\.parentNode&&child\.parentNode!==root\)/);
  assert.match(modeSwitch, /tail=origin\.cloneNode\(false\)/);
  assert.match(modeSwitch, /mark\.__rrModeSwitchPairs=pairs/);
  assert.match(modeSwitch, /for\(var j=pairs\.length-1;j>=0;j--\)/);
  assert.match(modeSwitch, /while\(tail\.firstChild\)origin\.appendChild\(tail\.firstChild\)/);
  assert.doesNotMatch(layout, /rr-mode-switch-anchor\{display:block !important;width:0 !important;height:0/);
  assert.match(layout, /forcedMarker=forceModeSwitchAnchorColumn\(anchorOffset,!!opts\.preserveLeadMedia\);/);
  assert.match(layout, /anchor=\{el:forcedMarker,modeSwitchMarker:true\};/);
  assert.match(layout, /if\(columnStartRange\)curTopAnchor=\{range:columnStartRange\};/);
});

test("a forced page-column continuation does not inherit the EPUB paragraph indent", () => {
  assert.match(modeSwitch, /tail\.classList\.add\('rr-mode-switch-continuation'\)/);
  assert.match(layout, /\.rr \.rr-mode-switch-continuation\{text-indent:0 !important;\}/);
  assert.doesNotMatch(layout, /rr-mode-switch-anchor\[data-reader-split="1"\]/);
});

test("mode switching pads a Chromium-ignored dynamic column break to the next column top", () => {
  assert.match(modeSwitch, /function padModeSwitchAnchorToColumnTop\(mark\)/);
  assert.match(modeSwitch, /data-reader-mode-switch-spacer/);
  assert.match(modeSwitch, /Math\.ceil\(columnH-within\)/);
  assert.match(modeSwitch, /mark\.__rrModeSwitchSpacer=spacer/);
  assert.match(modeSwitch, /if\(spacer&&spacer\.parentNode\)spacer\.remove\(\)/);
  assert.match(layout, /if\(padModeSwitchAnchorToColumnTop\(forcedMarker\)\)applyCols\(\)/);
  assert.match(layout, /if\(opts\.modeSwitch&&anchorOffset!=null\)/);
});

test("mode switching keeps the navigation-time first line and only samples geometry as fallback", () => {
  assert.match(layout, /function visibleTopTextAnchor\(\)/);
  assert.match(layout, /range\.getClientRects\(\)/);
  assert.match(layout, /var pageRank=isDualPage\(\)&&r\.left>=dualBoundary\?1:0;/);
  assert.match(layout, /var rng=caretRangeInReader\(x,y\)/);
  assert.match(layout, /双页以左页优先/);
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  assert.match(runtime, /incomingModeChange&&storedOffsetBefore!=null&&anchorValid\(curTopAnchor\)/);
  assert.match(runtime, /anchor=curTopAnchor;\s*\}else if\(incomingModeChange&&typeof visibleTopTextAnchor==='function'\)\{\s*anchor=visibleTopTextAnchor\(\)/);
  assert.match(runtime, /if\(!anchorValid\(anchor\)\)anchor=topAnchor\(\)/);
  assert.match(modeSwitch, /function modeSwitchAnchorAtVisibleTop\(offset\)/);
  assert.match(runtime, /modeSwitchRecoveryOffset=null;/);
  assert.doesNotMatch(runtime, /sourceAnchorRangeForOffset\(modeSwitchRecoveryOffset\)/);
});

test("every switch into paged layout forces the preserved first line to a column top", () => {
  const runtime = fs.readFileSync(path.join(uiRoot, "reader-page-runtime.js"), "utf8");
  assert.match(runtime, /modeSwitch:incomingModeChange/);
  assert.match(runtime, /alignDualAnchor:incomingModeChange&&isDualPage\(\)/);
  assert.match(runtime, /forceAnchorColumn:incomingModeChange&&!isScrollMode\(\)/);
});

test("mode switch paragraph fragments remain source text for highlights and search", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const generatedMatcher = annotations.match(/function generatedTextNode\(node\)\{[\s\S]*?\n\}/);
  assert.ok(generatedMatcher);
  assert.doesNotMatch(generatedMatcher[0].replace(/\/\/.*$/gm, ""), /rr-mode-switch-anchor/);
  assert.match(annotations, /rr-mode-switch-anchor 承载的是从原段落拆出的真实正文/);
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
  vm.runInNewContext(pagination, context);
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
  assert.match(layout, /class="rr-dual-continuation"/);
  assert.match(layout, /dualContinuationChapter===curCh\+1&&pageInCh===pagesInCh-1/);
  assert.match(layout, /root\.insertAdjacentHTML\('beforeend','<div class="rr-end"><\/div>'\)/);
  assert.match(layout, /body:not\(\.scroll-mode\):not\(\.line-paged-mode\) \.rr-end\{display:none !important;\}/);
  assert.match(layout, /beginChapterTurnFx\(1,visibleDualContinuationChapter\(\),'after-dual-continuation'\)/);
  assert.match(pagination, /\.rr-end,\.rr-dual-continuation/);
  assert.match(reader, /dualChapterProgress/);
});

test("incremental page cache resumes incomplete books and accepts complete books", () => {
  const scheduled = [];
  const context = {
    CH: 3,
    pageCountSig: () => "same-layout",
    report: () => {},
    scheduleMeasure: (delay) => scheduled.push(delay),
    clearTimeout: () => {},
    setTimeout: () => 1,
  };
  vm.runInNewContext(measurement, context);
  // Replace the module function so this test observes the resume request directly.
  context.scheduleMeasure = (delay) => scheduled.push(delay);
  context.applyPageCache({ sig: "same-layout", pages: [4, 0, 6], complete: false });
  assert.equal(context.measureDone, false);
  assert.deepEqual(Array.from(context.chapterPages), [4, 0, 6]);
  assert.deepEqual(scheduled, [60]);

  scheduled.length = 0;
  context.applyPageCache({ sig: "same-layout", pages: [4, 5, 6], complete: true });
  assert.equal(context.measureDone, true);
  assert.deepEqual(scheduled, []);
});
