const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "reader.html"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const reader = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader.js"), "utf8");
const jumpBackRules = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-jump-back-rules.js"), "utf8");
const navigationRules = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-navigation-rules.js"), "utf8");
const aiHistoryRules = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-ai-history-rules.js"), "utf8");
const i18n = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "reader-i18n.js"),
  "utf8",
);
const shell = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-shell-state.js"), "utf8");
const notes = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-notes-ui.js"), "utf8");
const annotations = require("./reader-page-test-source.cjs").compact;
const runtime = fs.readFileSync(path.join(__dirname, "..", "generated-reader-page-ts", "reader-page-runtime.js"), "utf8");
const layout = annotations;
const transition = fs.readFileSync(path.join(__dirname, "..", "generated-reader-page-ts", "reader-page-transition.js"), "utf8");
const pageStyle = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
const settingsUi = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-settings-ui.js"), "utf8");
const searchUi = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "reader-search-ui.js"),
  "utf8",
);
const libraryCommands = fs.readFileSync(path.join(__dirname, "..", "..", "src", "library_commands.rs"), "utf8");
const readerGestures = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-gesture.js"), "utf8");
const gestureManager = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "gesture-ui.js"), "utf8");

function readerShellClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : Boolean(force);
      if (on) values.add(name); else values.delete(name);
      return on;
    },
    contains(name) { return values.has(name); },
  };
}

function bootReaderShell(immersive = false) {
  const ids = [
    "settings", "reader-preferences-modal", "rsearch", "toc", "vocab", "info-modal",
    "anno-modal", "cross-modal", "reader-end-modal", "ai-reader-side", "backdrop",
    "vocab-settings",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, { classList: readerShellClassList() }]));
  const body = { classList: readerShellClassList() };
  const stored = new Map([["immersive", immersive ? "1" : "0"]]);
  const events = [];
  const context = {
    dispatchEvent(event) { events.push(event); },
    document: {
      body,
      getElementById(id) { return elements[id] || null; },
    },
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    Map,
    Object,
    Set,
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  context.CustomEvent = CustomEvent;
  context.window = context;
  vm.runInNewContext(shell, context);
  return { body, elements, events, shell: context.ReaderShell, stored };
}

test("AI reader local history is unlimited while deletion tombstones stay bounded", () => {
  assert.doesNotMatch(reader, /AI_READER_LOCAL_HISTORY_LIMIT/);
  assert.match(reader, /readerAiHistoryRules\.TOMBSTONE_LIMIT/);
  assert.match(aiHistoryRules, /const READER_AI_HISTORY_TOMBSTONE_LIMIT = 200;/);
  assert.match(aiHistoryRules, /entries\.filter\(\(entry\) => !isReaderAiHistoryDeleted\(entry\)\)\.sort/s);
});

test("reader toolbar buttons stay horizontal and do not flex-shrink", () => {
  assert.match(html, /\.tbtn\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(html, /\.tbtn\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
});

test("reader progress names the whole-book page total once it is measured", () => {
  assert.match(html, /id="reader-progress-group" data-tauri-drag-region/);
  assert.match(html, /id="chapter-progress" class="title epub-only"/);
  assert.match(html, /id="progress" class="title page-count-loading"/);
  assert.match(html, /\.reader-progress-group\s*\{[^}]*gap:\s*8px;[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /\.reader-progress-group\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s);
  assert.match(html, /#chapter-progress\s*\{[^}]*width:\s*min\(245px,\s*38vw\);[^}]*justify-content:\s*flex-start;[^}]*text-align:\s*left;/s);
  assert.match(html, /#progress\.page-count-total\s*\{[^}]*width:\s*84px;[^}]*justify-content:\s*flex-end;[^}]*text-align:\s*right;/s);
  assert.match(html, /#progress\.page-count-loading/);
  assert.match(reader, /function showWholeBookPages\(page, total\)/);
  assert.match(reader, /const text = readerText\("wholeBookPages", "\{page\}\/\{total\}页", \{ page, total \}\);/);
  assert.match(reader, /function showChapterProgress\(page, total, progress, dualContinuationChapter\)/);
  assert.match(reader, /showChapterProgress\(e\.data\.page, e\.data\.total, curProgress, e\.data\.dualContinuationChapter\)/);
  assert.match(reader, /else if \(pageCountMeasuring\)[\s\S]*?showProgressLoading\(\)/);
  assert.match(reader, /if \(e\.data\.pageCache\)/);
  assert.match(reader, /complete: !!pc\.complete/);
  assert.match(reader, /pageCountViewportWidth:\s*Math\.round\(document\.documentElement\.clientWidth/);
  assert.match(annotations, /if\(!sideTxn\)[\s\S]*?pageSig!==pageCountSig\(\)/);
});

test("all explicit reader jumps share a chronological undo gesture", () => {
  assert.doesNotMatch(reader, /bookProgressJumpHistory/);
  assert.match(reader, /const readerNavigationHistory = \[\];/);
  assert.match(reader, /const readerNavigationRules = window\.ReaderNavigationRules \|\|[\s\S]{0,40}\(\(\) =>/);
  assert.match(html, /generated-ts\/reader-jump-back-rules\.js[\s\S]*?generated-ts\/reader-navigation-rules\.js[\s\S]*?reader\.js/);
  assert.match(reader, /function rememberReaderNavigationPoint\(point\)[\s\S]*?readerNavigationRules\.appendHistory\(readerNavigationHistory/);
  assert.match(reader, /readerNavigationHistory\.splice\(0, readerNavigationHistory\.length, \.\.\.result\.history\)/);
  assert.match(navigationRules, /function appendReaderNavigationHistory\(entries, point, fallback, limit = READER_NAVIGATION_HISTORY_LIMIT\)/);
  assert.match(reader, /function rememberBookProgressRestorePoint\(point\)[\s\S]*?rememberReaderNavigationPoint\(point\)/);
  assert.match(reader, /const canRestoreProgress = readerNavigationHistory\.length > 0;/);
  assert.match(reader, /window\.restoreReaderJumpPosition = restorePreviousReaderNavigation;/);
  const restoreNavigation = reader.slice(
    reader.indexOf("function restorePreviousReaderNavigation"),
    reader.indexOf("bookProgressRestore?.addEventListener"),
  );
  assert.doesNotMatch(restoreNavigation, /isPdf/);
  assert.match(reader, /window\.hasReaderJumpHistory = \(\) => readerNavigationHistory\.length > 0;/);
  assert.match(reader, /vthumb\.addEventListener\("mousedown"[\s\S]*?rememberReaderNavigationPoint\(\)/);
  assert.match(reader, /vbar\.addEventListener\("mousedown"[\s\S]*?rememberReaderNavigationPoint\(\)/);
  assert.match(notes, /runtime\.rememberReaderJumpPosition\?\.\("toc"\)/);
  assert.match(notes, /runtime\.rememberReaderJumpPosition\?\.\(\{ kind: "bookmark" \}\)/);
  assert.match(annotations, /parent\.postMessage\(\{readerJump:/);
  assert.match(appHtml, /data-gesture-action="undo_last"/);
  assert.match(gestureManager, /value === "restore_jump"/);
  assert.match(gestureManager, /return "undo_last"/);
  assert.match(readerGestures, /undo_last: "撤销上一步"/);
  assert.match(readerGestures, /action === "undo_last" && canUndoLastReaderAction\(\)/);
  assert.match(readerGestures, /reader-undo-checkpoint/);
  assert.match(reader, /new CustomEvent\("reader-undo-checkpoint"\)/);
  assert.match(readerGestures, /global\.restoreReaderJumpPosition\?\.\(\)/);
});

test("gesture previews use the drawn route prefix and reopening tracks normal closes", () => {
  assert.match(gestureManager, /function previewProfile\(surface, points\)/);
  assert.match(gestureManager, /gestureApi\.prefixSimilarity\(profile\.points, points\)/);
  const mainFinish = gestureManager.slice(gestureManager.indexOf("function finish(event, cancelled = false)"), gestureManager.indexOf("function cancelGestureKeepHint"));
  assert.doesNotMatch(mainFinish, /showHint\(/);
  assert.match(gestureManager, /function listenForClosedMainSurfaces\(\)/);
  assert.match(gestureManager, /root\.querySelectorAll\("\.modal\.show"\)/);
  assert.match(gestureManager, /"newsnow-reader"/);
  assert.match(readerGestures, /function previewMatch\(gesture\)/);
  assert.match(readerGestures, /api\.prefixSimilarity\(profile\.points, gesture\.points\)/);
  const readerFinish = readerGestures.slice(readerGestures.indexOf("function finish(cancelled = false)"), readerGestures.indexOf("function cancelKeepHint"));
  assert.doesNotMatch(readerFinish, /showHint\(/);
  assert.match(readerGestures, /reader-shell-statechange/);
  assert.match(readerGestures, /previous\.sidePanel/);
  assert.match(readerGestures, /setSidePanel/);
});

test("gesture profiles can be automatic or explicitly scoped to the main or reader window", () => {
  assert.match(appHtml, /id="gesture-scope"/);
  assert.match(appHtml, /value="auto">自动适用（推荐）/);
  assert.match(appHtml, /value="main">仅主窗口/);
  assert.match(appHtml, /value="reader">仅阅读页/);
  assert.match(gestureManager, /function actionSupportedScopes\(action\) \{\s*return \["main", "reader"\];\s*\}/);
  assert.match(gestureManager, /scope: normalizeScope\(action, source\.scope\)/);
  assert.match(gestureManager, /scopeInput\.disabled = scopes\.length === 1;/);
  assert.match(gestureManager, /此操作目前只支持阅读页，不能设为主窗口。/);
  assert.match(gestureManager, /profile\.scope !== "reader"/);
  assert.match(gestureManager, /function scopesOverlap\(first, second\)/);
  assert.match(readerGestures, /const normalizeScope = \(_action, value\) =>/);
  assert.match(readerGestures, /profile\.scope !== "main"/);
  assert.match(
    readerGestures,
    /global\.addEventListener\([\s\S]*?"mousedown"[\s\S]*?startMouseGesture[\s\S]*?true[\s\S]*?global\.addEventListener\([\s\S]*?"mousemove"[\s\S]*?if \(active\)[\s\S]*?global\.addEventListener\("mouseup", \(\) => finish\(\), true\);/,
  );
  assert.doesNotMatch(readerGestures, /startPointerGesture|activePointerId/);
});

test("reader toolbar supports narrow windows and macOS system fonts", () => {
  const toolbarRule = html.match(/\.toolbar\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(toolbarRule, /overflow-[xy]:\s*(?:auto|hidden)/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
  assert.match(html, /font-family:[^;]*-apple-system[^;]*"PingFang SC"/s);
});

test("reader settings dropdown is not clipped by the toolbar", () => {
  assert.match(html, /\.gear-wrap\s*\{[^}]*position:\s*relative;[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /\.settings\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*30;/s);
});

test("reader settings dropdown has no pointer gap below the toolbar", () => {
  assert.match(html, /\.settings\s*\{[^}]*top:\s*100%;/s);
  assert.doesNotMatch(html, /\.settings\s*\{[^}]*top:\s*calc\(100%\s*\+\s*8px\);/s);
});

test("reader settings use an explicit shell-to-notes bridge after IIFE migration", () => {
  assert.match(reader, /window\.setReaderSettingsOpen = \(open\) => \{\s*setSettingsOpen\(open\);/s);
  assert.match(notes, /runtime\.setReaderSettingsOpen\?\.\(open\)/);
  assert.doesNotMatch(notes, /setSettingsOpen\(open\);\s*\}\s*\};\s*\}\s*function initializeReaderNotesUi/s);
});

test("dictionary enhancement switches default off and restore only explicit opt-ins", () => {
  for (const key of ["plain", "sense", "context", "hypernyms", "synonyms", "antonyms"]) {
    assert.match(annotations, new RegExp(`${key}:false`));
    assert.match(annotations, new RegExp(`${key}:v\\.${key}===true`));
    assert.match(annotations, new RegExp(`st\\.${key}!==false`));
  }
  assert.match(annotations, /DICT_HN_SETTINGS_KEY='dictEnhancementSettingsV2'/);
  assert.doesNotMatch(annotations, /localStorage\.getItem\('dictHownetSettings'\)/);
});

test("dictionary enhancement switches reject unavailable data before enabling", () => {
  assert.match(annotations, /function dictEnhancementAvailable\(result,key\)/);
  assert.match(annotations, /const field=key==='context'\?'example_note':key/);
  assert.match(annotations, /if\(input\.checked&&!dictEnhancementAvailable\(lastDict,cfg\.key\)\)/);
  assert.match(annotations, /input\.checked=false;[\s\S]*?st\[cfg\.key\]=false;[\s\S]*?setDictHnSettings\(st\)/);
  assert.match(annotations, /dictSettingsStatus=dictEnhancementUnavailableText\(cfg\)/);
  assert.match(annotations, /function openDict\(term,context(?:='')?\)\{[\s\S]*?lastDict=null;dictSettingsStatus='';/);
  assert.match(pageStyle, /\.dc-settings-status\{[^}]*background:#fff4dd[^}]*color:#8a5c00/);
});

test("built-in dictionary keeps Chinese and English meanings switchable", () => {
  assert.match(annotations, /if\(r\.def\)sources\.push\(\{k:'c',label:readerPageText\('chinese'\),text:r\.def\}\)/);
  assert.match(annotations, /if\(r\.def_en\)sources\.push\(\{k:'e',label:readerPageText\('english'\),text:r\.def_en\}\)/);
  assert.match(annotations, /if\(sources\.length>1\)[^{]*\{[^}]*className='dc-toggle'/s);
  assert.match(annotations, /setDictSel\(r\.lang,sel\);renderDict\(\)/);
});

test("reader settings show one state character and map off to simplified, on to traditional", () => {
  assert.match(html, /id="set-text-conversion-simple"/);
  assert.match(html, /id="text-conversion-state-label" class="text-conversion-label">简<\/span>/);
  assert.doesNotMatch(html, /text-conversion-simple-label|text-conversion-traditional-label/);
  assert.doesNotMatch(html, /改为简/);
  assert.match(html, /text-conversion-choice \{ display: inline-flex; align-items: center; gap: 6px; color: #444;/);
  assert.match(html, /text-conversion-label \{ display: inline; line-height: 20px; color: inherit;/);
  assert.match(html, /mode-toggle-group[\s\S]*?set-text-conversion-simple[\s\S]*?set-dual-mode[\s\S]*?set-scroll-mode/);
  assert.match(html, /\.mode-toggle-group \{[^}]*flex-wrap: wrap;[^}]*gap: 8px 10px;[^}]*width: 100%; \}/);
  assert.match(html, /id="set-dual-mode-label" data-reader-i18n="twoPages">双页<\/span>/);
  assert.match(html, /id="set-scroll-mode-label" data-reader-i18n="scrollMode">滚动<\/span>/);
  assert.match(html, /class="settings-switch"/);
  assert.match(settingsUi, /const dualModeLabel = elementById\("set-dual-mode-label"\);/);
  assert.match(settingsUi, /const scrollModeLabel = elementById\("set-scroll-mode-label"\);/);
  assert.match(settingsUi, /dualModeLabel\.textContent = dualModeToggle\?\.checked[\s\S]*?readerSettingsT\("twoPages", "双页"\)[\s\S]*?readerSettingsT\("singlePage", "单页"\)/);
  assert.match(settingsUi, /scrollModeLabel\.textContent = scrollModeToggle\?\.checked[\s\S]*?readerSettingsT\("scrollMode", "滚动"\)[\s\S]*?readerSettingsT\("pagedMode", "整屏"\)/);
  assert.match(settingsUi, /global\.addEventListener\(\s*"reader-language-changed",\s*refreshReadingModeToggles\s*\)/);
  assert.match(i18n, /singlePage: "Single page"/);
  assert.match(i18n, /pagedMode: "Full-page view"/);
  assert.match(settingsUi, /textConversion: "t2s"/);
  assert.match(settingsUi, /settings\.textConversion === "original"/);
  assert.match(settingsUi, /elementById\("set-text-conversion-simple"\)/);
  assert.match(settingsUi, /textConversionToggle\.checked = traditional/);
  assert.match(settingsUi, /textConversionToggle\.checked \? "s2t" : "t2s"/);
  assert.match(settingsUi, /textConversionLabel\.textContent = traditional \? "繁" : "简"/);
  assert.match(layout, /const conversion=S\.textConversion==='t2s'\|\|S\.textConversion==='s2t'\?S\.textConversion:'original'/);
  assert.match(runtime, /if \(previousConversion !== g\.S\.textConversion\) \{\s*fn\(g, "showChapter", g\.curCh, g\.pageInCh\);\s*return;/);
});

test("整页翻页仅保留水平滑动动画，并迁移旧动画设置", () => {
  assert.doesNotMatch(html, /纸张效果（Google）|仿真翻页/);
  assert.match(settingsUi, /pageTurnEffect: "horizontal"/);
  assert.match(settingsUi, /\["google-paper", "curl"\]\.includes\(settings\.pageTurnEffect\)/);
  assert.match(transition, /\/\^\(off\|horizontal\)\$\/u\.test\(String\(effect\)\) \? effect : "horizontal"/);
  assert.match(transition, /turnFxDuration\(360\)/);
  assert.match(transition, /captureTurnFxPage\("turn-fx-outgoing"\)[\s\S]*?move\(\);[\s\S]*?captureTurnFxPage\("turn-fx-incoming"\)/);
  assert.match(transition, /function beginChapterTurnFx[\s\S]*?captureTurnFxPage\("turn-fx-outgoing"\)[\s\S]*?showChapter\(chapter, where\)\.then[\s\S]*?captureTurnFxPage\("turn-fx-incoming"\)/);
  assert.match(transition, /if \(effect === "off"\)[\s\S]*?captureTurnFxPage\("turn-fx-outgoing"\)[\s\S]*?turn-fx-hold[\s\S]*?waitForChapterPaint/);
  assert.match(transition, /rememberCurrentChapterBoundarySnapshot\(\)[\s\S]*?showCachedChapterBoundary\(chapter, where\)/);
  assert.match(transition, /visibleVirtualPage[\s\S]*?global\.virtualPage\?\.style\.display === "block"[\s\S]*?visibleVirtualPage \?\? root/);
  assert.match(transition, /clone\.id = "virtual-page"/);
  assert.match(pageStyle, /#pager\.turn-fx-hold #turn-fx-sheet\{[^}]*opacity:1 !important/);
  assert.match(layout, /beginChapterTurnFx\(1,curCh\+1,'start'\)/);
  assert.match(layout, /beginChapterTurnFx\(-1,curCh-1,'end'\)/);
  assert.match(pageStyle, /#pager\.turn-fx-horizontal\.turn-fx-next[\s\S]*?turnFxHorizontalOutNext/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalOutNext[\s\S]*?translate3d\(-100%,0,0\)/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalInNext[\s\S]*?translate3d\(100%,0,0\)[\s\S]*?translate3d\(0,0,0\)/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalOutPrev[\s\S]*?translate3d\(100%,0,0\)/);
  assert.doesNotMatch(pageStyle, /turn-fx-google-paper|turn-fx-curl|turn-fx-fold|turnFxGoogle|turnFxCurl/);
});

test("空白 EPUB spine 章节自动跳到首个可见内容页", () => {
  const showChapter = layout.slice(layout.indexOf("function chapterHasVisibleContent"), layout.indexOf("var curTopAnchor="));
  assert.match(showChapter, /function chapterHasVisibleContent\(\)/);
  assert.match(showChapter, /root\.querySelector\('img,svg,canvas,video,object,embed,iframe,table'\)/);
  assert.match(showChapter, /if\(!chapterHasVisibleContent\(\)&&\(skippedBlankChapters\|\|0\)<16\)/);
  assert.match(showChapter, /return showChapter\(nextBlankChapter,where==='end'\?'end':'start',null,\(skippedBlankChapters\|\|0\)\+1\)/);
});

test("跨章加载在末页定位完成前隐藏新正文", () => {
  assert.match(layout, /root\.style\.visibility='hidden';\s*root\.innerHTML=/);
  assert.match(layout, /setViewOffset\(\);[\s\S]{0,300}?root\.style\.visibility='';/);
  assert.match(layout, /function\(\)\{[^}]*root\.style\.visibility='';finishChapterBugTrace\(bugTraceToken,false,0\)\}/);
});

test("章节分页等待 EPUB 样式加载，避免双页续读总页数漂移", () => {
  assert.match(annotations, /function injectHead\(htmlStr,seen\)[\s\S]*?addEventListener\('load',done/);
  assert.match(annotations, /addEventListener\('error',done/);
  assert.match(annotations, /timer=setTimeout\(done,(?:2000|2e3)\)/);
  assert.match(annotations, /return Promise\.all\(waits\)/);
  const showChapter = layout.slice(layout.indexOf("function showChapter("), layout.indexOf("var curTopAnchor="));
  assert.match(showChapter, /(?:const|let|var) headReady=d\.head\?injectHead\(d\.head,headSeen\):Promise\.resolve\(\);/);
  assert.match(showChapter, /return headReady\.then\(function\(\)\{[\s\S]*?applyCols\(\)/);
  assert.ok(showChapter.indexOf("headReady.then") < showChapter.indexOf("curCh=i"));
});
test("双页续读先采集本页锚点并把锚点恢复到左页", () => {
  const gotoPage = layout.slice(layout.indexOf("function gotoPage("), layout.indexOf("function filterTextLines("));
  const showChapter = layout.slice(layout.indexOf("function showChapter("), layout.indexOf("var curTopAnchor="));
  assert.match(gotoPage, /setViewOffset\(\);[\s\S]*?captureAnchor\(\);report\(true\)/);
  assert.doesNotMatch(gotoPage, /report\(\);[^}]*captureAnchor\(\)/);
  assert.match(showChapter, /setViewOffset\(\);root\.style\.visibility='';refreshHighlights\(\);captureAnchor\(\);report\(true\)/);
  assert.match(annotations, /restoreStoredReadingAnchor[\s\S]*?alignDualAnchorToLeftPage\(pageAnchor\)[\s\S]*?setViewOffset\(\)/);
  assert.match(annotations, /if\(restored&&isDualPage\(\)\)\{\s*dualStartColumn=0;[\s\S]*?resumePage=Math\.round\(rf\*\(pagesInCh-1\)\);[\s\S]*?pageInCh=Math\.max\(0,Math\.min\(pagesInCh-1,resumePage\)\);/);
  assert.doesNotMatch(annotations, /Math\.abs\(pageInCh-resumePage\)>1/);
});

test("续读恢复完成前不保存章节首页，真实翻页立即提交位置", () => {
  assert.match(annotations, /var initialResumePending=true/);
  assert.match(layout, /function report\(commitPosition=false,restoredPosition=false,positionSnapshotRequestId=0\)\{if\(initialResumePending\)return/);
  assert.match(layout, /positionCommit:commitPosition\?1:0/);
  assert.match(annotations, /initialResumePending=false;\s*captureAnchor\(\);\s*report\(false,true\)/);
  assert.match(reader, /if \(e\.data\.positionRestored !== 1\) reportProgress\(e\.data\.positionCommit === 1\)/);
  assert.match(annotations, /nearestTextOccurrence\(whole,probe,[^)]+\)/);
  assert.match(runtime, /if \(data\.positionSnapshotRequest !== void 0\)/);
  assert.match(runtime, /positionSnapshotTurnWaitMs/);
  assert.match(runtime, /if \(g\.chapterTurnPending && Date\.now\(\) - started < turnWaitMs\)/);
  assert.match(runtime, /"captureAnchor"[\s\S]*?"report", false, false, id/);
  assert.match(reader, /Number\(e\.data\.positionSnapshotRequestId\) === pendingPositionSnapshot\.requestId/);
  assert.equal((layout.match(/function visibleTopTextAnchor\(\)/g) || []).length, 1);
  assert.match(layout, /r\.right<=pr\.left\+1\|\|r\.left>=pr\.right-1/);
  assert.match(layout, /if\(!visible\)anchor=visibleTopTextAnchor\(\)\|\|anchor/);
  assert.match(reader, /async function closeReaderWindow\(\)[\s\S]*?const positionSnapshot = requestPagePositionSnapshot\([\s\S]*?invoke\("main_window_close"\)[\s\S]*?await positionSnapshot[\s\S]*?await sendProgressNow\(\)/);
  const delayedSave = reader.slice(reader.indexOf("progTimer = setTimeout(() => {", reader.indexOf("function reportProgress")), reader.indexOf("window.addEventListener(\"pagehide\""));
  assert.match(delayedSave, /sendProgressNow\(\)/);
  assert.doesNotMatch(delayedSave, /reportProgress\(\)/);
});

test("进度问题记录包含章内偏移和前后端保存结果但不包含原文", () => {
  const saveProgress = reader.slice(reader.indexOf("function progressSaveDetail"), reader.indexOf("async function closeReaderWindow"));
  assert.match(saveProgress, /sequence/);
  assert.match(saveProgress, /chapter_frac/);
  assert.match(saveProgress, /anchor_offset/);
  assert.match(saveProgress, /ReaderBugTrace\?\.record\?\.\("progress_save"/);
  assert.match(saveProgress, /progressSaveDetail\(sequence, request, "requested"\)/);
  assert.match(saveProgress, /progressSaveDetail\(sequence, request, "ok"\)/);
  assert.doesNotMatch(saveProgress, /context_before|context_after|dom_path|text_content/);
  assert.match(libraryCommands, /sequence:\s*u64/);
  assert.match(libraryCommands, /set_progress ok id=\{id\} seq=\{sequence\} chapter=\{chapter\} frac=\{frac:\.6\} progress=\{progress:\.4\} anchor_offset=/);
});

test("in-book search dropdown has no pointer gap below the toolbar", () => {
  assert.match(html, /\.rsearch\s*\{[^}]*top:\s*100%;/s);
  assert.doesNotMatch(html, /\.rsearch\s*\{[^}]*top:\s*calc\(100%\s*\+\s*8px\);/s);
});

test("in-book search remains open while the WebView briefly loses focus", () => {
  assert.doesNotMatch(searchUi, /window\.addEventListener\("(?:blur|mouseout)"[\s\S]*?toggleSearch\(false\)/);
  assert.match(searchUi, /global\.isReaderSearchEditing = isReaderSearchEditing/);
  assert.match(searchUi, /rsearchEditingUntil = Date\.now\(\) \+ 1200/);
  assert.match(searchUi, /compositionstart/);
  assert.match(searchUi, /rsearchComposing \|\| rsearch\.contains\(document\.activeElement\)/);
  assert.match(reader, /function isSearchInputEditActive\(\)/);
  assert.match(reader, /if \(!isSearchInputEditActive\(\)\) ReaderShell\.closeOverlay\(\)/);
  assert.match(reader, /e\.isComposing \|\| e\.key === "Process" \|\| e\.keyCode === 229/);
  assert.match(annotations, /e\.isComposing\|\|e\.key==='Process'\|\|e\.keyCode===229/);
  assert.match(searchUi, /event\.key === "Escape"\) toggleSearch\(false\)/);
});

test("an open in-book search pins the immersive toolbar during IME pointer transitions", () => {
  const { body, elements, events, shell: readerShell } = bootReaderShell(true);

  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("reader-controls-visible"), false);
  readerShell.setOverlay(readerShell.OVERLAY.SEARCH, true);
  assert.equal(readerShell.getState().overlay, readerShell.OVERLAY.SEARCH);
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_PINNED);
  assert.equal(elements.rsearch.classList.contains("show"), true);
  assert.equal(body.classList.contains("immersive"), true);
  assert.equal(body.classList.contains("bar-show"), true);
  assert.equal(body.classList.contains("reader-controls-visible"), true);

  readerShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_PINNED);
  readerShell.closeOverlay();
  readerShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("bar-show"), false);
  assert.equal(events.at(-1).type, "reader-shell-statechange");
});

test("智读提交携带实时已读位置、选区、锚点和本机会话记忆，并用 Enter 发起提问", () => {
  assert.match(reader, /currentChapter:\s*curChapter/);
  assert.match(reader, /currentFraction:\s*curChFrac/);
  assert.match(reader, /selectedText:\s*aiReaderSelectedText/);
  assert.match(reader, /selectedStart:\s*aiReaderSelectedAnchor\?\.start/);
  assert.match(reader, /selectedEnd:\s*aiReaderSelectedAnchor\?\.end/);
  assert.match(reader, /sessionMemory:\s*aiReaderSessionMemory\(\)/);
  assert.match(reader, /function aiReaderSessionMemoryKey\(\)/);
  assert.match(reader, /localStorage\.setItem\(aiReaderSessionMemoryKey\(\)/);
  assert.match(reader, /readerAiHistoryRules\.sessionPrompt\(aiReaderReadSessionMemory\(\), aiReaderTaskLabel\)/);
  assert.match(html, /<script src="generated-ts\/reader-ai-history-rules\.js"><\/script>\s*<script src="generated-ts\/reader-startup-guard\.js"><\/script>\s*<script src="generated-ts\/reader-reading-metrics\.js"><\/script>\s*<script src="generated-ts\/reader\.js"><\/script>/);
  const sessionMemoryBlock = reader.match(/function aiReaderRememberSession\(entry\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(sessionMemoryBlock, /private_sync_history_merge/);
  assert.match(reader, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229/);
  assert.match(reader, /event\.stopPropagation\(\);\s*runAiReader\("question"\)/s);
  assert.match(html, /id="ai-reader-enter-submit"[^>]*>Enter<\/button>/);
  assert.match(i18n, /submitQuestion: "Enter"/);
  assert.match(reader, /getElementById\("ai-reader-enter-submit"\)\?\.addEventListener\("click", \(\) => runAiReader\("question"\)\)/);
});

test("智读历史可以删除，并将条目墓碑同步到其他设备", () => {
  assert.match(reader, /function aiReaderHistoryEntryId\(entry\)/);
  assert.match(reader, /private_sync_history_delete/);
  assert.match(reader, /删除这条智读记录/);
  assert.match(reader, /deletedAt/);
  assert.match(html, /\.ai-reader-history-delete\s*\{/);
});

test("智读侧栏提供三档宽度、可收起脑图和按条目选择的云端历史同步", () => {
  assert.match(html, /data-ai-reader-width="current"/);
  assert.match(html, /data-ai-reader-width="half"/);
  assert.match(html, /data-ai-reader-width="full"/);
  assert.match(html, /data-ai-reader-width="current"[^>]*><span class="ai-reader-width-glyph" aria-hidden="true"><i><\/i><\/span><\/button>/);
  assert.match(html, /data-ai-reader-width="half"[^>]*><span class="ai-reader-width-glyph" aria-hidden="true"><i><\/i><i><\/i><\/span><\/button>/);
  assert.match(html, /data-ai-reader-width="full"[^>]*><span class="ai-reader-width-glyph" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span><\/button>/);
  assert.match(html, /\.ai-reader-width-glyph > i \{[^}]*width: 1px;[^}]*height: 14px;[^}]*background: currentColor;/);
  assert.match(reader, /const AI_READER_WIDTH_KEY = "aiReaderSideWidthV1";/);
  assert.match(reader, /selected === "half" \? "50%" : "100%"/);
  assert.match(html, /id="ai-reader-history-settings-btn"/);
  assert.match(html, /data-ai-reader-sync-mode="recent"/);
  assert.match(html, /data-ai-reader-sync-mode="manual"/);
  assert.match(reader, /private_sync_set_reader_history_mode/);
  assert.match(reader, /private_sync_set_reader_history_cloud_saved/);
  assert.match(html, /\.ai-reader-history-cloud\s*\{/);
  assert.match(reader, /collapseMindMap/);
  assert.match(reader, /aiReaderShowHistory\(true\)/);
});

test("智读显示检索阶段、证据材料类型与引用自检结果", () => {
  assert.match(reader, /function aiReaderStartProgress\(task\)/);
  assert.match(reader, /定位当前选句和邻近正文/);
  assert.match(reader, /混合检索已读内容/);
  assert.match(reader, /筛选并重排证据/);
  assert.match(reader, /生成回答并核对引用/);
  assert.match(reader, /source\?\.sourceKind/);
  assert.match(reader, /function aiReaderRenderMarkdown\(content, sources\)/);
  assert.match(reader, /function aiReaderAppendInline\(parent, value, sources\)/);
  assert.match(reader, /className = "ai-reader-citation"/);
  assert.match(reader, /function aiReaderJumpToSource\(source\)/);
  assert.match(reader, /function aiReaderShowSourcePreview\(source, index, citation\)/);
  assert.match(reader, /excerpt\.textContent = String\(source\?\.excerpt/);
  assert.match(reader, /citation\.addEventListener\("click", \(\) => \{\s*aiReaderShowSourcePreview\(source, index, citation\);\s*aiReaderJumpToSource\(source\);\s*\}\)/s);
  assert.doesNotMatch(reader, /citation\.title/);
  assert.match(reader, /answer\.retrievalStages/);
  assert.match(reader, /answer\.citationChecked/);
  assert.match(html, /id="ai-reader-audit"/);
  assert.match(html, /id="ai-reader-source-preview"[^>]*role="dialog"/);
  assert.match(html, /\.ai-reader-source-preview\s*\{/);
  assert.match(html, /\.ai-reader-answer h3 \{[^}]*font-size: 20px/s);
});

test("智读只切换书架中已配置的大模型，不在阅读页编辑密钥", () => {
  assert.match(html, /id="ai-reader-profile"/);
  assert.match(reader, /invoke\("ai_reader_profiles"\)/);
  assert.match(reader, /invoke\("assign_ai_reader_profile", \{ request: \{ purpose: "reading", id \} \}\)/);
  assert.doesNotMatch(html, /id="ai-reader-provider"|id="ai-reader-base-url"|id="ai-reader-api-key"/);
  assert.doesNotMatch(reader, /save_ai_reader_config/);
});

test("阅读正文先开始导航，大目录随后按空闲时间分批构建", () => {
  assert.match(notes, /const scheduleTocBuild = \(toc\) =>/);
  assert.match(notes, /runtime\.requestIdleCallback\(callback, \{ timeout: 500 \}\)/);
  assert.match(notes, /while \(index < entries\.length && added < 120\)/);
  assert.match(reader, /beginFrameNavigation\?\.\(readerSource\)[\s\S]*?frame\.src = readerSource;[\s\S]*?window\.pendingReaderToc = toc;\s*window\.scheduleTocBuild\?\.\(toc\);/s);
  assert.match(notes, /runtime\.scheduleTocBuild = scheduleTocBuild;[\s\S]*?scheduleTocBuild\(pending\)/);
  assert.match(reader, /shell_info elapsed_ms=/);
  assert.match(reader, /shell_ready elapsed_ms=/);
});

test("从选中文本打开智读时不再向问题框插入固定提问句", () => {
  assert.doesNotMatch(reader, /请结合已读内容解释这段文字/);
  assert.match(reader, /aiReaderQuestion\.value = String\(prefill\)\.trim\(\)\.slice\(0, 900\)/);
});

test("开关智读以覆盖层呈现，不压缩正文列宽或改变阅读位置", () => {
  assert.match(reader, /ReaderShell\.setSidePanel\(ReaderShell\.SIDE_PANEL\.AI_READER, !!open\)/);
  assert.match(reader, /function closeAiReaderSide\(\)[\s\S]*?setAiReaderSide\(false\)/);
  assert.match(reader, /window\.closeAiReaderSide = closeAiReaderSide/);
  assert.match(reader, /ReaderShell\.setSidePanel\(ReaderShell\.SIDE_PANEL\.AI_READER, !!open\)/);
  assert.match(reader, /ReaderShell\.registerSidePanel\(ReaderShell\.SIDE_PANEL\.AI_READER/);
  assert.doesNotMatch(reader, /preserveAnchor: 1/);
  assert.match(reader, /openAiReader\(String\(request\.text \|\| ""\), \{[\s\S]*?start: Number\(request\.anchorStart\)/);
  assert.match(annotations, /aiReader:\{text:t,anchorStart:o&&o\.start,anchorEnd:o&&o\.end\}/);
  assert.match(annotations, /aiReader:\{text:highlightDisplayText\(h\),anchorStart:h\.start,anchorEnd:h\.end\}/);
  assert.match(html, /body\.ai-reader-open \.ai-reader-side\s*\{\s*display:\s*flex;/);
  assert.doesNotMatch(html, /body\.ai-reader-open #frame\s*\{\s*width:/);
  assert.doesNotMatch(html, /body\.ai-reader-open #vbar\s*\{\s*right:/);
  assert.doesNotMatch(html, /body\.ai-reader-open \.book-progress\s*\{\s*right:/);
});

test("高亮菜单按真实高度避让页末：横排和九宫格都完整可见", () => {
  const highlightRules = annotations;
  assert.match(annotations, /function visibleHighlightLineRects\(idx,fallbackEl=null\)/);
  assert.match(annotations, /function nearestHighlightRect\(rects,evt=null\)/);
  assert.match(annotations, /function highlightLineGroups\(rects\)/);
  assert.match(annotations, /function highlightMenuPlacement\(idx,fallbackEl,evt\)/);
  assert.match(annotations, /ReaderPageHighlightRules\.placement/);
  assert.match(annotations, /ReaderPageHighlightRules\.nearestRect/);
  assert.match(annotations, /ReaderPageHighlightRules\.groupedEnvelopes/);
  assert.match(highlightRules, /pageKeys\.length>1[\s\S]*?envelope\(requiredRecordValue\(pages,firstPageKey\)\)[\s\S]*?above:true/);
  assert.match(highlightRules, /lines\.length<=1[\s\S]*?nearestRect\(rects,pointer\)/);
  assert.match(highlightRules, /let last=requiredArrayItem\(lines,0\)[\s\S]*?return\{rect:last,above:false\}/);
  assert.match(annotations, /highlightMenuPlacement\(idx,el,evt\)/);
  assert.match(annotations, /addEventListener\('mousemove',[\s\S]*?showHlMenu\(activeHi,false,m,e\)/);
  assert.match(annotations, /function readerViewportHeight\(\)/);
  assert.match(annotations, /function placeHighlightMenuVertically\(menu,rect,preferAbove\)/);
  assert.match(annotations, /Number\(menu&&menu\.offsetHeight\)\|\|34/);
  assert.match(annotations, /(?:const|let|var) canAbove=aboveTop>=safe,canBelow=belowTop\+mh<=vh-safe/);
  assert.match(annotations, /function repositionVisibleHighlightMenu\(menu\)/);
  assert.match(annotations, /placeHighlightMenuVertically\(menu,rect,!!menu\._menuPreferredAbove\)/);
  assert.match(annotations, /menu\._menuPreferredAbove=false[\s\S]*?repositionVisibleHighlightMenu\(menu\)/);
  assert.match(annotations, /refreshConfiguredMenus\(\)[\s\S]*?repositionVisibleHighlightMenu\(hlMenu\)/);
  assert.match(annotations, /hlMenu\._menuPreferredAbove=placement\.above[\s\S]*?repositionVisibleHighlightMenu\(hlMenu\)/);
});

test("returning to the toolbar closes settings left open after a pointer exit", () => {
  const { elements, shell: readerShell } = bootReaderShell();

  readerShell.setOverlay(readerShell.OVERLAY.SETTINGS, true);
  readerShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(readerShell.getState().overlay, readerShell.OVERLAY.SETTINGS);
  assert.equal(readerShell.getState().settingsPointerExited, true);
  assert.equal(elements.settings.classList.contains("show"), true);

  readerShell.dispatch({ type: "TOOLBAR_POINTER_ENTER" });
  assert.equal(readerShell.getState().overlay, readerShell.OVERLAY.NONE);
  assert.equal(readerShell.getState().settingsPointerExited, false);
  assert.equal(elements.settings.classList.contains("show"), false);
});

test("reader settings selects shrink inside the settings panel", () => {
  assert.match(html, /\.settings \.row\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.settings \.row > label:first-child\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(html, /\.mode-toggle-item\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /\.settings select\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
});

test("阅读设置提供三款按需下载并校验的开源中文字体", () => {
  assert.match(html, /data-reader-font-id="lxgw-wenkai-lite"[^>]*>霞鹜文楷 Lite/);
  assert.match(html, /data-reader-font-id="source-han-serif-sc"[^>]*>思源宋体/);
  assert.match(html, /data-reader-font-id="zhuque-fangsong"[^>]*>朱雀仿宋/);
  assert.match(html, /id="reader-font-download-status"/);
  assert.match(settingsUi, /invoke\("reader_font_status"\)/);
  assert.match(settingsUi, /settingsPort\.downloadFont\(id\)/);
  assert.match(settingsUi, /下载后自动应用/);
  assert.match(layout, /@font-face\{font-family:'Kunpeng LXGW WenKai Lite'/);
  assert.match(layout, /reader:\/\/localhost\/font\/2\/SourceHanSerifSC-Regular\.otf/);
  assert.match(layout, /reader:\/\/localhost\/font\/3\/ZhuqueFangsong-Regular\.ttf/);
});

test("center taps toggle bottom progress outside immersive mode", () => {
  assert.match(reader, /function toggleBookProgressFromCenterTap\(\)/);
  assert.match(reader, /classList\.contains\("book-progress-hidden"\)[\s\S]*showBookProgress\(\);[\s\S]*hideBookProgressAfterReadingAction\(\);/);
  assert.match(reader, /if \(e\.data\.centerTap\) \{[\s\S]*toggleBookProgressFromCenterTap\(\);\s*toggleReaderToolbar\(\);\s*\}/);
  assert.match(notes, /runtime\.toggleReaderToolbar\?\.\(\)/);
  assert.match(annotations, /if\(overlayOpen\)[\s\S]*parent\.postMessage\(\{centerTap:1\}/);
});

test("bottom progress keeps a local preview while dragging so stale iframe progress cannot make the thumb bounce", () => {
  assert.match(reader, /let bookProgressPreviewFrac = null;/);
  assert.match(reader, /function setBookProgressPreview\(frac\)/);
  assert.match(reader, /function scheduleBookProgressPreviewSettle\(\)/);
  assert.match(reader, /function settleBookProgressPreview\(\)/);
  assert.match(reader, /bookProgressPreviewFrac === null[\s\S]*?bookProgressPreviewFrac \* 100/);
  assert.match(reader, /bookProgressLastFrac = bookProgressFracFromX\(e\.clientX\);[\s\S]*?setBookProgressPreview\(bookProgressLastFrac\)/);
  assert.match(reader, /jumpByBookProgress\(bookProgressLastFrac, false\);[\s\S]*?bookProgressDragging = false;[\s\S]*?scheduleBookProgressPreviewSettle\(\)/);
  assert.match(reader, /curProgress = e\.data\.progress;[\s\S]*?settleBookProgressPreview\(\);/);
});
test("bottom progress history shares TOC and internal-link navigation history", () => {
  assert.doesNotMatch(reader, /bookProgressJumpHistory/);
  assert.match(reader, /const readerNavigationHistory = \[\]/);
  assert.match(reader, /let bookProgressPinned = false/);
  assert.match(reader, /function rememberBookProgressRestorePoint\(point\)[\s\S]*?rememberReaderNavigationPoint\(point\)/);
  assert.match(reader, /readerNavigationRules\.appendHistory\(readerNavigationHistory/);
  assert.match(reader, /readerNavigationHistory\.pop\(\)/);
  assert.doesNotMatch(reader, /if \(bookProgressRestorePoint\) return/);
  assert.match(reader, /function pinBookProgress\(\) \{\s*bookProgressPinned = true;\s*showBookProgress\(\);\s*\}/);
  assert.match(reader, /function jumpByBookProgress[\s\S]*?sendToPage\(\{ gotoFrac: target\d* \}\);[\s\S]*?pinBookProgress\(\);[\s\S]*?requestAnimationFrame\(pinBookProgress\)/);
  assert.match(reader, /immersive && toolbarPinned && !panelOpen && !bookProgressPinned/);
  assert.match(reader, /if \(e\.data\.readerJump\) \{\s*rememberReaderNavigationPoint\(e\.data\.readerJump\);\s*\}/);
  assert.match(reader, /readerJumpBack\.hidden = !readerJumpBackConfig\(\)\.enabled \|\| !readerNavigationBackVisible \|\| readerNavigationHistory\.length === 0/);
  assert.match(reader, /bookProgressRestore\?\.addEventListener\("click", restorePreviousBookProgress\)/);
  assert.match(reader, /readerJumpBack\?\.addEventListener\("click", restorePreviousReaderNavigation\)/);
  assert.match(notes, /rememberReaderJumpPosition\?\.\("toc"\)[\s\S]*?sendToPage\(\{ gotoChapter: entry\.chapter/);
  assert.match(annotations, /parent\.postMessage\(\{readerJump:\{kind:/);
  assert.match(annotations, /inFootnote\?['"]footnote['"]:['"]link['"]/);
  assert.match(html, /\.book-progress-restore \{[^}]*width: 30px;[^}]*height: 30px;[^}]*font: 27px\/1 sans-serif;/s);
  assert.match(html, /id="book-progress-restore"/);
  assert.match(html, /\.reader-jump-back \{[^}]*top: var\(--reader-jump-back-position-y, 50%\);[^}]*left: var\(--reader-jump-back-position-x, calc\(100% - var\(--reader-jump-back-hit-size, 44px\)\)\);[^}]*width: var\(--reader-jump-back-hit-size, 44px\);[^}]*height: var\(--reader-jump-back-hit-size, 44px\);/s);
  assert.match(html, /id="reader-jump-back"[^>]*hidden><svg class="reader-jump-back-arrow" viewBox="0 0 120 48"/);
  assert.match(html, /\.reader-jump-back \{[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*opacity: \.56;/s);
  assert.match(reader, /enabled: current\.showReaderJumpBack !== false/);
  assert.match(reader, /iconSizePx: readerJumpBackRules\.normalizeIconSizePx\(current\.readerJumpBackIconSizePx\)/);
  assert.doesNotMatch(reader, /iconSizePxFromLegacyLevel/);
  assert.match(reader, /positionX: readerJumpBackRules\.normalizePosition\(current\.readerJumpBackPositionX, 950\)/);
  assert.match(reader, /positionY: readerJumpBackRules\.normalizePosition\(current\.readerJumpBackPositionY, 500\)/);
  assert.match(reader, /const iconSize = readerJumpBackRules\.normalizeIconSizePx\(iconSizePx\)/);
  assert.match(reader, /const iconHeight = readerJumpBackRules\.iconHeightPx\(iconSize\)/);
  assert.match(html, /reader-settings-ui\.js[\s\S]*?generated-ts\/reader-jump-back-rules\.js[\s\S]*?reader\.js/);
  assert.doesNotMatch(reader, /const readerJumpBackTrackPoint = readerJumpBackRules\.trackPoint;/);
  assert.match(jumpBackRules, /function readerJumpBackTrackPoint\(length, iconSize, hitSize, position\)/);
  assert.match(jumpBackRules, /const hitTargetInset = Math\.max\(0, hitSize - iconSize\) \/ 2/);
  assert.match(reader, /readerJumpBack\.style\.left = `\$\{Math\.round\(readerJumpBackRules\.trackPoint\(width, iconSize, hitSize, positionX\)\)\}px`/);
  assert.match(reader, /readerJumpBack\.style\.top = `\$\{Math\.round\(readerJumpBackRules\.trackPoint\(height, iconHeight, hitSize, positionY\)\)\}px`/);
  assert.match(reader, /--reader-jump-back-icon-size/);
  assert.match(reader, /readerNavigationDismissTimer = setTimeout\(\(\) => dismissReaderNavigationBack\(false\), config\.seconds \* (?:1000|1e3)\)/);
  assert.match(reader, /readerNavigationRules\.trackPageDismissal\([\s\S]*?data, config\.pages\)/);
  assert.match(reader, /trackReaderNavigationBackProgress\(e\.data\)/);
});

test("bottom progress hides after navigation and is toggled by a normal-mode center tap", () => {
  assert.match(shell, /classList\.toggle\("reader-controls-visible", projection\.controlsVisible\)/);
  assert.match(html, /\.book-progress\s*\{[^}]*display:\s*none;[^}]*pointer-events:\s*none;/s);
  assert.match(html, /body\.reader-controls-visible \.book-progress\s*\{[^}]*display:\s*flex;[^}]*pointer-events:\s*auto;/s);
  assert.match(html, /body:not\(\.immersive\)\.book-progress-hidden \.book-progress\s*\{[^}]*display:\s*none;[^}]*pointer-events:\s*none;/s);
  assert.match(reader, /function hideBookProgressAfterReadingAction\(\)/);
  assert.match(reader, /if \(e\.data\.userNav\) \{[\s\S]*hideBookProgressAfterReadingAction\(\);/);
  assert.match(reader, /if \(e\.data\.centerTap\) \{[\s\S]*toggleBookProgressFromCenterTap\(\);/);
  assert.match(reader, /hideBookProgressAfterReadingAction\(\);\s*ReaderShell\.dispatch\(\{ type: "HIDE_TOOLBAR" \}\);/);
});

test("immersive mode hides controls but keeps reading and page-count status visible", () => {
  assert.match(html, /body\.immersive \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(html, /body\.immersive\.bar-show \.toolbar > \*:not\(#reader-progress-group\),\s*body\.immersive\.bar-hover \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
  assert.match(html, /body\.immersive #reader-progress-group\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;/s);
  assert.match(html, /body\.immersive:not\(\.bar-show\):not\(\.bar-hover\) \.toolbar > \*:not\(#reader-progress-group\):not\(\.window-controls\)\s*\{[^}]*display:\s*none;/s);
  assert.match(html, /body\.immersive:not\(\.bar-show\):not\(\.bar-hover\) #reader-progress-group\s*\{[^}]*margin-left:\s*auto;/s);
});

test("immersive toolbar appears on hover and retracts when the pointer leaves", () => {
  const { body, shell: readerShell, stored } = bootReaderShell(true);

  readerShell.dispatch({ type: "TOOLBAR_POINTER_ENTER" });
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_HOVER);
  assert.equal(body.classList.contains("bar-hover"), true);
  assert.equal(body.classList.contains("bar-show"), false);
  assert.equal(body.classList.contains("reader-controls-visible"), true);

  readerShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("bar-hover"), false);
  assert.equal(body.classList.contains("reader-controls-visible"), false);
  assert.equal(stored.get("immersive"), "1");

  readerShell.dispatch({ type: "SHOW_TOOLBAR" });
  assert.equal(readerShell.getState().toolbar, readerShell.TOOLBAR.IMMERSIVE_PINNED);
  assert.equal(body.classList.contains("bar-show"), true);
  assert.match(html, /body\.immersive\.bar-hover \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
});

test("enabling scroll mode animates an active dual-page switch off", () => {
  assert.match(settingsUi, /const dualWasOn = !!dualModeToggle\?\.checked;/);
  assert.match(settingsUi, /READER_SHELL_IS_MAC_WEBKIT && scrollModeToggle\.checked && dualWasOn/);
  assert.match(settingsUi, /READER_SHELL_IS_MAC_WEBKIT[\s\S]*animateToggleOff\(dualModeToggle\);[\s\S]*refreshReadingModeToggles\(\)/);
  assert.doesNotMatch(settingsUi, /addEventListener\("animationend"/);
  assert.match(html, /@keyframes settings-switch-auto-off\s*\{[\s\S]*translateX\(18px\)[\s\S]*translateX\(0\)/);
  assert.match(html, /\.settings-switch\.auto-off \.settings-slider::before\s*\{[^}]*transition:\s*none;[^}]*animation:\s*settings-switch-auto-off[^;}]*both;/s);
});

test("macOS switch workaround does not run in Windows Chromium", () => {
  assert.match(settingsUi, /const READER_SHELL_IS_MAC_WEBKIT = \/Macintosh\|Mac OS X\//);
  assert.match(settingsUi, /!\/\(\?:Chrome\|Chromium\|Edg\)\\\/\//);
});

test("macOS WebKit uses a fast pointerup path without changing Chromium clicks", () => {
  assert.match(annotations, /isMacWebKit=IS_MAC_WEBKIT/);
  assert.match(annotations, /if\(isMacWebKit\)document\.addEventListener\('pointerup'/);
  assert.match(annotations, /pointerTarget\.closest\([^\n]*\[data-vnote-badge=[^\n]*\.rr-note-ref[^\n]*\.vp-inline/);
  assert.match(annotations, /Date\.now\(\)-macFastTap\.at<700/);
});

test("virtual footnotes keep explicit cross-chapter targets and avoid whole-book scans", () => {
  assert.match(annotations, /const compound=\/\^c\(\\d\+\)~\(\.\+\)\$\//);
  assert.match(annotations, /showFootnote\(el,info\.targetChapter===null\?curCh:info\.targetChapter,info\.frag,info\.targetChapter!==null\)/);
  assert.match(annotations, /if\(exactTarget\)\{add\(ci\);return out;?\}/);
  assert.match(annotations, /showFootnote\(a,ciT,frag,!!m\)/);
});

test("macOS WebKit switches ordinary chapters to batched geometry earlier", () => {
  assert.match(layout, /const IS_MAC_WEBKIT=.*AppleWebKit/);
  assert.match(transition, /global\.FAST_CHAPTER_LAYOUT_CHARS = \(global\.IS_MAC_WEBKIT \? 4 : 120\) \* 1024/);
});
