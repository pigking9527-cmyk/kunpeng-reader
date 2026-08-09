const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const pagination = fs.readFileSync(path.join(uiRoot, "reader-page-pagination.js"), "utf8");
const measurement = fs.readFileSync(path.join(uiRoot, "reader-page-measurement.js"), "utf8");
const layout = fs.readFileSync(path.join(uiRoot, "reader-page-layout.js"), "utf8");
const modeSwitch = fs.readFileSync(path.join(uiRoot, "reader-page-mode-switch.js"), "utf8");

test("reader page modules parse in their compiled injection order", () => {
  const source = [
    "reader-page-bug-trace.js",
    "reader-page-layout.js",
    "reader-page-end.js",
    "reader-page-pagination.js",
    "reader-page-measurement.js",
    "reader-page-annotations.js",
    "reader-page-mode-switch.js",
    "reader-page-runtime.js",
  ].map((name) => fs.readFileSync(path.join(uiRoot, name), "utf8")).join("");
  assert.doesNotThrow(() => new vm.Script(source));
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

test("paged touchpad gestures end on actual wheel quiet instead of a fixed cooldown", () => {
  const annotations = fs.readFileSync(path.join(uiRoot, "reader-page-annotations.js"), "utf8");
  const wheelHandler = annotations.slice(annotations.indexOf("var pageWheelGesture=null"), annotations.indexOf("window.addEventListener('resize'"));
  assert.match(wheelHandler, /var pageWheelGesture=null,pageWheelGestureTimer=null,pageWheelTraceEvents=0,scrollChapterLock=false/);
  assert.match(wheelHandler, /function tracePageWheel\(phase,e,gesture\)/);
  assert.match(wheelHandler, /if\(pageWheelTraceEvents\+\+>=48\)return;/);
  assert.match(wheelHandler, /if\(pageWheelGesture===gesture\)pageWheelGesture=null;[\s\S]*?\},80\)/);
  assert.match(wheelHandler, /if\(gesture\)\{[\s\S]*?armPageWheelGestureQuietTimer\(gesture\);[\s\S]*?return;/);
  assert.match(wheelHandler, /if\(direction>0\)nextPage\(\);else prevPage\(\);/);
  assert.doesNotMatch(wheelHandler, /quietFor|strongNewInput|>=700/);
});

test("paged height calibration never creates more than one line of extra bottom whitespace", () => {
  assert.match(layout, /function packedPagedBoxHeight\(baseH\)/);
  assert.match(layout, /var allowedTrim=Math\.max\(0,Math\.floor\(lineHeightPx\(\)\)-mg\(S\.marginBottom\)\);/);
  assert.match(layout, /return Math\.max\(raw-allowedTrim,calibrated\);/);
  assert.match(layout, /pageH=packedPagedBoxHeight\(pageH\)/);
  assert.doesNotMatch(layout, /normalizeChapterLeadDecoration/);
  assert.doesNotMatch(layout, /rr-chapter-logo/);
});

test("local reading style keeps chapter logos in normal flow but caps heading whitespace", () => {
  assert.match(layout, /\.rr h1,\.rr h2,\.rr h3,\.rr h4,\.rr h5,\.rr h6\{margin-top:\.55em !important;margin-bottom:\.55em !important/);
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
