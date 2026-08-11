const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const script = fs.readFileSync(path.join(ui, "news-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");
const backend = fs.readFileSync(
  path.join(ui, "..", "src", "newsnow.rs"),
  "utf8",
);

function loadBrowserGestureApi() {
  const context = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(ui, "news-gesture.js"), "utf8"),
    context,
    { filename: "news-gesture.js" },
  );
  return context.ReaderNewsGesture;
}

// `news-gesture.js` is loaded as a classic browser script.  The root package is
// ESM now, so CommonJS `require()` correctly yields no named module exports;
// exercise the production global API instead of testing a loader-only branch.
const gestures = loadBrowserGestureApi();

test("NewsNow has a shelf toolbar entry and an independently mounted news page", () => {
  assert.match(html, /id="newsnow-toolbar-btn"[^>]*hidden/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="newsnow-back"/);
  assert.match(
    html,
    /<div class="newsnow-toolbar-actions">[\s\S]*?<div class="newsnow-actions">[\s\S]*?<span[\s\S]*?id="newsnow-updated"/,
  );
  assert.match(
    html,
    /id="newsnow-order-source"[\s\S]*?<button[\s\S]*?id="newsnow-back"/,
  );
  assert.doesNotMatch(html, /<header class="newsnow-head">/);
  assert.doesNotMatch(backend, /正在显示本地缓存，后台正在更新/);
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<\/section>\s*<section[\s\S]*?id="newsnow-reader"/);
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
  assert.doesNotMatch(html, /class="newsnow-title-row"/);
  assert.doesNotMatch(html, />READING BRIEF</);
  assert.doesNotMatch(html, />今日资讯</);
  assert.doesNotMatch(html, /按时间归并的轻量资讯流/);
  assert.doesNotMatch(html, /id="newsnow-source-summary"/);
  assert.doesNotMatch(script, /renderSourceSummary/);
  assert.doesNotMatch(
    html,
    /<div class="newsnow-layout-control"[^>]*>\s*<span[^>]*>布局<\/span>/,
  );
});

test("NewsNow is always available while its detailed local options remain configurable", () => {
  const experiments = fs.readFileSync(
    path.join(ui, "experimental-features.js"),
    "utf8",
  );
  assert.doesNotMatch(html, /id="experimental-newsnow"(?![-\w])/);
  assert.match(html, /id="experimental-newsnow-gear"/);
  assert.match(
    html,
    /id="newsnow-settings-modal"[\s\S]*?class="modal settings-detail-modal"/,
  );
  assert.match(html, /id="newsnow-settings-close"/);
  assert.match(html, /id="experimental-newsnow-prefetch"/);
  assert.match(html, /id="experimental-newsnow-hide-return-icon"/);
  assert.match(
    html,
    /<section class="experimental-settings" aria-label="资讯">/,
  );
  assert.doesNotMatch(html, /<div class="fp-title">实验室<\/div>/);
  assert.match(
    experiments,
    /const DEFAULTS = Object\.freeze\(\{ newsnowPrefetch: true, newsnowHideReturnIcon: false \}\)/,
  );
  assert.match(experiments, /if \(key === "newsnow"\) return true;/);
  assert.match(experiments, /set\("newsnowPrefetch", prefetch\.checked\)/);
  assert.match(
    experiments,
    /set\("newsnowHideReturnIcon", hideReturnIcon\.checked\)/,
  );
  assert.match(experiments, /settingsModal\.classList\.add\("show"\)/);
  assert.match(experiments, /settingsModal\.classList\.remove\("show"\)/);
  assert.doesNotMatch(experiments, /fp-settings-modal/);
  assert.match(experiments, /"kunpeng\.reader\.experimental-features\.v1"/);
  assert.match(
    script,
    /ReaderExperimentalFeatures\?\.enabled\?\.\("newsnow"\) === true/,
  );
  assert.match(script, /reader-experimental-features-changed/);
  assert.match(
    script,
    /if \(!enabled && \(!page\.hidden \|\| !reader\.hidden\)\) close\(\{ focus: false \}\)/,
  );
});

test("NewsNow opens source pages and renders extracted local articles with a stable return control", () => {
  assert.match(script, /function safeHttpUrl/);
  assert.match(script, /url\.protocol === "https:" \? url\.href : ""/);
  assert.match(
    script,
    /page\.hidden = false; feedView\.hidden = false; sourcePicker\.hidden = true;[\s\S]*?shell\.hidden = true/,
  );
  assert.match(script, /newsnow_open_article/);
  assert.match(script, /title: text\(item\.title \|\| item\.name\)/);
  assert.match(script, /summary: text\(item\.summary \|\| item\.description/);
  assert.match(script, /function withTimeout/);
  assert.match(script, /news-request-timeout/);
  assert.match(script, /reader\.hidden = !visible; page\.hidden = visible/);
  assert.match(script, /ReaderLibraryAiEntry\?\.close\(\)/);
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(html, /id="newsnow-reader-content"/);
  assert.match(html, /id="newsnow-reader-original"/);
  assert.match(script, /if \(article\?\.local\) renderLocalArticle\(article\)/);
  assert.match(
    script,
    /readerContent\.innerHTML = text\(article\?\.contentHtml/,
  );
  assert.match(script, /readerBack\.addEventListener\("click"/);
  assert.match(script, /invoke\("open_url", \{ url: currentArticleUrl \}\)/);
  assert.doesNotMatch(html, /id="newsnow-reader-frame"/);
});

test("News original-page return icon can be hidden while gesture close remains available", () => {
  const experiments = fs.readFileSync(
    path.join(ui, "experimental-features.js"),
    "utf8",
  );
  assert.match(html, /data-i18n="newsHideReturnIcon">关闭返回图标/);
  assert.match(html, /data-i18n="newsHideReturnIconNote"/);
  assert.match(experiments, /newsnowHideReturnIcon: false/);
  assert.match(
    script,
    /hideReturnIcon: global\.ReaderExperimentalFeatures\?\.enabled\?\.\("newsnowHideReturnIcon"\) === true/,
  );
  assert.match(backend, /pub hide_return_icon: bool/);
  assert.match(backend, /const hideReturnIcon = __KUNPENG_HIDE_RETURN_ICON__;/);
  assert.match(
    backend,
    /if \(hideReturnIcon \|\| document\.getElementById\("kunpeng-news-return"\)\) return;/,
  );
  assert.match(backend, /也可以通过手势关闭页面/);
  assert.match(
    backend,
    /if request\.hide_return_icon\s*\{\s*"true"\s*\}\s*else\s*\{\s*"false"\s*\}/,
  );
});

test("NewsNow syncs its bounded source selection and optional Tieba bar names", () => {
  assert.match(html, /id="newsnow-source-picker"/);
  assert.match(html, /id="newsnow-source-search"/);
  assert.doesNotMatch(html, /id="newsnow-source-apply"/);
  assert.doesNotMatch(html, /id="newsnow-source-reset"/);
  assert.match(
    script,
    /const SOURCE_STORAGE_KEY = "kunpeng\.reader\.news\.sources\.v2"/,
  );
  assert.match(script, /const MAX_SOURCES = 24/);
  assert.match(script, /function allowedSourceIds/);
  assert.match(script, /sourceQuery = ""/);
  assert.match(script, /sourceSearch\.addEventListener\("input"/);
  assert.match(html, /id="newsnow-tieba-bar-form"/);
  assert.doesNotMatch(html, /id="newsnow-tieba-enabled"/);
  assert.match(html, /id="newsnow-tieba-bar-input"/);
  assert.match(html, /id="newsnow-tieba-add-toggle"/);
  assert.match(html, /id="newsnow-tieba-bar-cancel"/);
  assert.match(html, /id="newsnow-tieba-bar-list"/);
  assert.match(
    script,
    /const TIEBA_BARS_STORAGE_KEY = "kunpeng\.reader\.news\.tieba-bars\.v1"/,
  );
  assert.match(
    script,
    /const TIEBA_ENABLED_BARS_STORAGE_KEY = "kunpeng\.reader\.news\.tieba-enabled-bars\.v1"/,
  );
  assert.match(script, /const MAX_TIEBA_BARS = 8/);
  assert.match(script, /function normalizeTiebaBars/);
  assert.match(script, /function setTiebaAddOpen/);
  assert.match(script, /text\(source\.id\) !== "tieba"/);
  assert.match(script, /function syncPendingTiebaSource/);
  assert.match(script, /function persistSourceChanges/);
  assert.match(script, /function queueNewsSourceSettingsSync/);
  assert.match(script, /function hydrateNewsSourceSettings/);
  assert.match(script, /newsSourceIds: sourceIds/);
  assert.match(script, /newsTiebaBars: tiebaBarNames/);
  assert.match(script, /newsEnabledTiebaBars: tiebaEnabledBarNames/);
  assert.match(script, /hasNewsSourceSettings/);
  assert.match(script, /function scheduleSourceRefresh/);
  assert.match(
    script,
    /setTimeout\(\(\) => \{[\s\S]*?void load\(true\);[\s\S]*?\}, 450\)/,
  );
  assert.match(script, /enabled\.type = "checkbox"/);
  assert.match(script, /pendingTiebaEnabledBarNames/);
  assert.match(
    script,
    /function newsRequest\(\) \{ return \{ sourceIds, tiebaBars:/,
  );
  assert.match(script, /left === "tieba" \? 0 : 1/);
  assert.match(script, /tiebaBarForm\.addEventListener\("submit"/);
  assert.match(
    script,
    /format\("maxSources", "最多选择 \{max\} 个来源。", \{ max: MAX_SOURCES \}\)/,
  );
  assert.match(script, /app-language-changed/);
});

test("source management is an independent page that hides and restores the news feed", () => {
  assert.match(html, /id="newsnow-feed-view" class="newsnow-feed-view"/);
  assert.match(html, /id="newsnow-source-status"/);
  assert.match(html, /id="newsnow-source-close"[^>]*>\s*←\s*<\/button>/);
  assert.match(script, /sourcePageScrollTop = page\.scrollTop/);
  assert.match(script, /feedView\.hidden = true; sourcePicker\.hidden = false/);
  assert.match(script, /sourcePicker\.hidden = true; feedView\.hidden = false/);
  assert.match(script, /page\.classList\.add\("newsnow-source-page-active"\)/);
  assert.match(
    script,
    /page\.classList\.remove\("newsnow-source-page-active"\)/,
  );
  assert.match(script, /page\.scrollTop = sourcePageScrollTop/);
  assert.match(
    styles,
    /\.newsnow-feed-view\[hidden\],\s*\.newsnow-source-picker\[hidden\]\s*\{\s*display: none/,
  );
  assert.match(
    styles,
    /\.newsnow-source-picker\s*\{[^}]*width: 100%;[^}]*border: 0;[^}]*box-shadow: none/s,
  );
  assert.doesNotMatch(html, /newsnow-source-picker-actions/);
  assert.doesNotMatch(styles, /\.newsnow-source-picker-actions/);
});

test("Gesture settings live in common settings and return from news, library, and reader", () => {
  const gestureUi = fs.readFileSync(path.join(ui, "gesture-ui.js"), "utf8");
  const readerGesture = fs.readFileSync(
    path.join(ui, "reader-gesture.js"),
    "utf8",
  );
  const readerHtml = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
  const readerPage = fs.readFileSync(
    path.join(ui, "reader-page-annotations.js"),
    "utf8",
  );
  const readerMessage = fs.readFileSync(
    path.join(ui, "reader-message.js"),
    "utf8",
  );
  assert.match(
    html,
    /id="gesture-gear"[^>]*fp-settings-detail[\s\S]*?data-i18n="settingsManage"[\s\S]*?<\/button>/,
  );
  assert.match(html, /id="gesture-settings-modal"/);
  assert.doesNotMatch(html, /id="gesture-settings-close"/);
  assert.match(html, /id="set-gesture-enabled"[\s\S]*?type="checkbox"/);
  assert.doesNotMatch(html, /id="gesture-manager-enabled"/);
  assert.match(
    html,
    /id="gesture-settings-toggle"[^>]*aria-controls="gesture-settings-content"[^>]*aria-expanded="false"[\s\S]*?手势设置[\s\S]*?⌄/,
  );
  assert.match(
    html,
    /id="gesture-editor-close"[^>]*aria-label="收起手势编辑器"/,
  );
  assert.match(html, /id="gesture-settings-content"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-global-precision-toggle"[^>]*aria-controls="gesture-global-precision-settings"/,
  );
  assert.match(html, /id="gesture-global-precision-settings"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-global-precision"[\s\S]*?type="range"[\s\S]*?min="1"[\s\S]*?max="10"[\s\S]*?step="1"/,
  );
  assert.match(html, /id="gesture-hint-enabled"[\s\S]*?type="checkbox"[\s\S]*?role="switch"/);
  assert.match(html, /id="gesture-hint-settings-toggle"[^>]*>\s*手势提示/);
  assert.match(html, /id="gesture-hint-settings"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-new"[\s\S]*?class="gesture-create-button"[^>]*>\s*创建手势\s*<\/button>/,
  );
  assert.match(
    html,
    /id="gesture-global-precision-settings"[\s\S]*?id="gesture-hint-enabled"/,
  );
  assert.match(
    styles,
    /\.gesture-settings-toggle \{[^}]*background: transparent;[^}]*font-size: 22px/,
  );
  assert.match(
    styles,
    /\.fp-settings-content::\-webkit-scrollbar-button,[\s\S]*?\.gesture-settings-card::\-webkit-scrollbar-button \{[^}]*display: none !important;[^}]*width: 0 !important;[^}]*height: 0 !important/,
  );
  assert.match(
    styles,
    /\.fp-settings-content::\-webkit-scrollbar-thumb,[\s\S]*?\.gesture-settings-card::\-webkit-scrollbar-thumb \{/,
  );
  assert.match(
    styles,
    /\.gesture-settings-content \{[^}]*border-left: 2px solid/,
  );
  assert.match(
    styles,
    /\.gesture-disclosure-toggle \{[^}]*font-size: 16px;[^}]*font-weight: 650/,
  );
  assert.match(
    styles,
    /\.gesture-hint-settings-entry \{[^}]*font-size: 16px;[^}]*font-weight: 650/,
  );
  assert.match(
    styles,
    /\.gesture-disclosure \{[^}]*border: 0;[^}]*background: transparent/,
  );
  assert.match(
    html,
    /id="gesture-action-choice"[\s\S]*?id="gesture-search"[\s\S]*?id="gesture-new"[\s\S]*?id="gesture-list"/,
  );
  assert.match(
    html,
    /id="gesture-editor"[\s\S]*?id="gesture-editor-options"[\s\S]*?id="gesture-editor-title"[\s\S]*?id="gesture-pad"[\s\S]*?id="gesture-save"/,
  );
  assert.match(html, /id="gesture-search"/);
  assert.doesNotMatch(html, /id="gesture-scope-filters"/);
  assert.match(html, /id="gesture-list"/);
  assert.match(html, /id="gesture-editor"[^>]*hidden/);
  assert.doesNotMatch(html, /id="gesture-scope-options"/);
  assert.doesNotMatch(html, /id="gesture-scope" type="hidden"/);
  assert.match(
    html,
    /id="gesture-action-choice"[\s\S]*?class="gesture-choice-section"[\s\S]*?hidden/,
  );
  assert.match(
    html,
    /id="gesture-editor-options"[\s\S]*?class="gesture-editor-options"[\s\S]*?hidden/,
  );
  assert.match(
    html,
    /id="gesture-action-options"[\s\S]*?class="gesture-action-options"/,
  );
  assert.match(html, /data-gesture-action="back"/);
  assert.match(
    html,
    /id="gesture-action-hint" class="gesture-auto-scope-note"/,
  );
  assert.match(html, /id="gesture-action"[\s\S]*?type="hidden"/);
  assert.doesNotMatch(html, /id="gesture-test"/);
  assert.match(html, /id="gesture-precision-global"[^>]*value="global"/);
  assert.match(
    html,
    /id="gesture-precision-independent"[^>]*value="independent"/,
  );
  assert.doesNotMatch(html, /id="gesture-settings-enabled"/);
  assert.match(
    html,
    /id="gesture-precision"[\s\S]*?type="range"[\s\S]*?min="1"[\s\S]*?max="10"[\s\S]*?step="1"/,
  );
  assert.match(
    html,
    /<script src="news-ui\.js"><\/script>[\s\S]*?<script src="gesture-ui\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /id="newsnow-gesture-enabled"/);
  assert.doesNotMatch(html, /id="newsnow-gesture-precision"/);
  assert.match(html, /<canvas[\s\S]*?id="newsnow-gesture-trail"[^>]*hidden/);
  assert.match(gestureUi, /kunpeng\.reader\.gesture-manager\.v1/);
  assert.match(gestureUi, /syncLegacyGesture/);
  assert.match(gestureUi, /kunpeng\.reader\.gesture-manager\.enabled\.v1/);
  assert.match(
    gestureUi,
    /gestureSettings: normalizedGestureSettingsSyncPayload\(\)/,
  );
  assert.match(gestureUi, /app_settings_sync_get/);
  assert.match(gestureUi, /app_settings_sync_save/);
  assert.match(gestureUi, /hasGestureSettings/);
  assert.match(gestureUi, /profilesInitialized: true/);
  assert.match(gestureUi, /isLegacyUnconfiguredEmptyGestureSettings/);
  assert.match(gestureUi, /app-settings-synced/);
  const enabledDefault = gestureUi.slice(
    gestureUi.indexOf("function loadManagerEnabled"),
    gestureUi.indexOf("function saveManagerEnabled"),
  );
  assert.match(enabledDefault, /return true;/);
  assert.match(
    gestureUi,
    /function collapseNewGestureDisclosures\(\) \{[\s\S]*?settingsOpen = false;[\s\S]*?globalPrecisionSettingsOpen = false;[\s\S]*?hintSettingsOpen = false;/,
  );
  assert.match(
    gestureUi,
    /function openEditor\(profile\) \{\s*if \(!profile\) collapseNewGestureDisclosures\(\);/,
  );
  assert.match(
    gestureUi,
    /newButton\.addEventListener\("click", \(\) => \{\s*collapseNewGestureDisclosures\(\);\s*openEditor\(\);/,
  );
  assert.match(
    gestureUi,
    /function saveEditor\(\) \{[\s\S]*?saveProfiles\(\);\s*training = \[\];\s*editing = next;\s*api\.draw\(pad, \[\]\);/,
  );
  const gestureConflict = gestureUi.slice(
    gestureUi.indexOf("function conflictFor"),
    gestureUi.indexOf("function deleteProfile"),
  );
  assert.match(
    gestureConflict,
    /function profileBoundToAction\(profile\)[\s\S]*?other\.action === profile\.action/,
  );
  assert.match(
    gestureConflict,
    /const actionOwner = profileBoundToAction\(next\);[\s\S]*?一个功能只能保留一条手势[\s\S]*?return;/,
  );
  assert.doesNotMatch(
    gestureConflict.slice(
      gestureConflict.indexOf("function conflictFor"),
      gestureConflict.indexOf("function profileBoundToAction"),
    ),
    /other\.action === profile\.action/,
  );
  assert.match(gestureUi, /profile\.points\.length === api\.SAMPLE_COUNT/);
  assert.match(gestureUi, /return false;/);
  assert.match(
    gestureUi,
    /precisionMode:\s*source\.precisionMode === "global"/,
  );
  assert.match(gestureUi, /global\.ReaderNewsUI\?\.instance/);
  assert.match(gestureUi, /ReaderLibraryAiEntry\?\.close/);
  assert.match(gestureUi, /getElementById\("fp-settings-modal"\)/);
  assert.match(gestureUi, /commonSettings\.classList\.remove\("show"\)/);
  assert.match(gestureUi, /getElementById\("stats-modal"\)/);
  assert.match(gestureUi, /ReaderStatsUI\?\.close\?\.\(\)/);
  assert.match(gestureUi, /querySelector\("\.content-shell"\)/);
  assert.match(gestureUi, /invoke\("main_window_close"\)/);
  assert.match(gestureUi, /event\.button !== 2/);
  assert.match(gestureUi, /pad\.addEventListener\("pointermove", moveTraining/);
  assert.match(gestureUi, /pad\.addEventListener\("lostpointercapture", cancelTraining\)/);
  assert.match(gestureUi, /"PointerEvent" in global/);
  assert.doesNotMatch(gestureUi, /test\.addEventListener\("click"/);
  assert.match(gestureUi, /api\.similarity\(profile\.points, points\)/);
  assert.match(gestureUi, /相似度较高/);
  assert.match(script, /gestureSurface: \(\) => \(!reader\.hidden \? reader/);
  assert.match(
    script,
    /gestureBack: \(\) => \{ if \(!reader\.hidden\) closeArticle/,
  );
  assert.match(
    readerHtml,
    /<script src="news-gesture\.js"><\/script>[\s\S]*?<script src="reader-gesture\.js"><\/script>/,
  );
  assert.match(readerGesture, /global\.closeReaderWindow\?\.\(\)/);
  assert.match(
    readerPage,
    /readerGestureDrawing=true;readerGestureSource=source;readerGesturePointerId=source==='pointer'\?e\.pointerId:null/,
  );
  assert.match(
    readerPage,
    /document\.documentElement\.setPointerCapture\(e\.pointerId\)/,
  );
  assert.match(
    readerPage,
    /readerGesture:\{phase:phase,x:e\.clientX,y:e\.clientY\}/,
  );
  assert.match(readerPage, /ToSwak.*MouseEvent/);
  assert.match(readerMessage, /"readerGesture"/);
  assert.match(styles, /\.gesture-precision-control input\[type="range"\]/);
  assert.match(styles, /\.gesture-create-button/);
  assert.match(styles, /\.gesture-manager-card\.is-editor-open/);

  const reference = [
    { x: 0, y: 0 },
    { x: 70, y: 10 },
    { x: 30, y: 60 },
    { x: 100, y: 100 },
  ];
  const translatedAndScaled = reference.map((point) => ({
    x: point.x * 2 + 30,
    y: point.y * 2 - 10,
  }));
  const different = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ];
  assert.equal(gestures.normalize(reference).length, gestures.SAMPLE_COUNT);
  assert.ok(
    gestures.similarity(reference, translatedAndScaled) >=
      gestures.MATCH_THRESHOLD,
  );
  assert.ok(
    gestures.similarity(reference, different) < gestures.MATCH_THRESHOLD,
  );
  assert.ok(
    gestures.similarity(reference, reference.slice().reverse()) <
      gestures.matchThreshold("5"),
  );
  const downThenRight = [
    { x: 0, y: 0 },
    { x: 0, y: 110 },
    { x: 90, y: 110 },
  ];
  const downThenShortRight = [
    { x: 20, y: 10 },
    { x: 20, y: 150 },
    { x: 35, y: 150 },
  ];
  const rightThenDown = [
    { x: 0, y: 0 },
    { x: 90, y: 0 },
    { x: 90, y: 110 },
  ];
  assert.deepEqual(
    gestures.directionSequence(downThenRight),
    gestures.directionSequence(downThenShortRight),
  );
  assert.ok(
    gestures.similarity(downThenRight, downThenShortRight) >=
      gestures.matchThreshold("10"),
  );
  assert.ok(
    gestures.similarity(downThenRight, rightThenDown) <
      gestures.matchThreshold("5"),
  );
  assert.equal(
    gestures.similarity(downThenRight, [
      { x: 0, y: 0 },
      { x: 0, y: 8 },
      { x: 5, y: 8 },
    ]),
    0,
  );
  assert.equal(
    gestures.normalize([
      { x: 0, y: 0 },
      { x: 24, y: 24 },
    ]).length,
    gestures.SAMPLE_COUNT,
  );
  const storage = new Map();
  const local = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  assert.equal(gestures.loadEnabled(local), false);
  assert.equal(gestures.saveEnabled(true, local), true);
  assert.equal(gestures.savePrecision("10", local), "10");
  assert.equal(gestures.loadPrecision(local), "10");
  assert.equal(gestures.loadPrecision({ getItem: () => "low" }), "3");
  assert.equal(gestures.loadPrecision({ getItem: () => "medium" }), "5");
  assert.equal(gestures.loadPrecision({ getItem: () => "high" }), "7");
  assert.ok(gestures.matchThreshold("1") < gestures.matchThreshold("5"));
  assert.ok(gestures.matchThreshold("10") > gestures.matchThreshold("5"));
});
test("Gesture feedback, reopen, and contextual information are integrated across the shell and reader", () => {
  const gestureUi = fs.readFileSync(path.join(ui, "gesture-ui.js"), "utf8");
  const readerGesture = fs.readFileSync(
    path.join(ui, "reader-gesture.js"),
    "utf8",
  );
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  assert.match(html, /data-gesture-action="book_info"/);
  assert.match(
    html,
    /data-gesture-action="book_info"[^>]*>[\s\S]*?信息提取／说明/,
  );
  assert.match(html, /data-gesture-action="undo_last"/);
  assert.match(html, /id="gesture-info-modal"[^>]*role="dialog"/);
  assert.match(html, /id="gesture-info-title"/);
  assert.match(html, /id="gesture-info-body"/);
  assert.match(html, /id="gesture-info-close"/);
  assert.match(
    html,
    /id="stats-modal"[^>]*data-gesture-info-title="阅读统计"[^>]*data-gesture-info=/,
  );
  assert.match(
    html,
    /id="library-ai-page"[^>]*data-gesture-info-title="书库问答"[^>]*data-gesture-info=/,
  );
  assert.match(
    html,
    /id="newsnow-page"[^>]*data-gesture-info-title="资讯"[^>]*data-gesture-info=/,
  );
  assert.match(html, /id="gesture-hint-font-size"/);
  assert.match(html, /id="gesture-hint-background-enabled"/);
  assert.match(
    html,
    /gesture-hint-background-switch"[\s\S]*?role="switch"[\s\S]*?id="gesture-hint-background-state"/,
  );
  assert.match(html, /id="gesture-hint-background"/);
  assert.match(html, /id="gesture-hint-background-reset"[^>]*>\s*恢复默认/);
  assert.match(html, /id="gesture-hint-background-presets"/);
  assert.match(html, /id="gesture-hint-color-picker-toggle"[^>]*aria-label="打开背景色盘"/);
  assert.match(html, /id="gesture-hint-background"[^>]*class="gesture-hint-native-color-input"[^>]*type="color"/);
  assert.match(html, /id="gesture-hint-quick-color-add"[^>]*aria-label="添加当前颜色为快捷色"[^>]*hidden[^>]*>\s*\+/);
  assert.match(html, /id="gesture-hint-shape-rect"[^>]*aria-pressed="true"/);
  assert.match(html, /id="gesture-hint-shape-freeform"[^>]*aria-pressed="false"/);
  assert.match(html, /id="gesture-hint-preview-path"/);
  assert.doesNotMatch(html, /gesture-hint-frame-draw/);
  assert.match(html, /id="gesture-hint-background"[^>]*type="color"/);
  assert.doesNotMatch(html, /gesture-hint-quick-color-editor/);
  assert.match(html, />\s*20px\s*<\/output>/);
  assert.match(html, />\s*60%\s*<\/output>/);
  assert.match(html, /id="gesture-hint-opacity"/);
  assert.match(html, /id="gesture-hint-preview-text"/);
  assert.match(html, /拖动提示文字可调整显示位置/);
  assert.match(html, /id="gesture-action-search"/);
  assert.match(html, /id="gesture-action-empty"[^>]*hidden/);
  assert.match(gestureUi, /getElementById\("gesture-action-choice"\)/);
  assert.match(gestureUi, /actionChoice\.hidden = false/);
  assert.match(gestureUi, /actionChoice\.hidden = true/);
  assert.match(gestureUi, /editorOptions\.hidden = false/);
  assert.match(gestureUi, /editorOptions\.hidden = true/);
  assert.match(gestureUi, /function filterActionOptions\(\)/);
  assert.match(
    gestureUi,
    /actionSearch\.addEventListener\("input", filterActionOptions\)/,
  );
  assert.match(gestureUi, /value === "book_info"/);
  assert.match(gestureUi, /value === "reopen_last"/);
  assert.match(gestureUi, /value === "restore_jump"/);
  assert.match(gestureUi, /return "undo_last"/);
  assert.match(gestureUi, /HINT_SETTINGS_KEY/);
  assert.match(gestureUi, /enabled: saved\.enabled === true/);
  assert.match(
    gestureUi,
    /backgroundEnabled:\s*saved\.backgroundEnabled !== false/,
  );
  assert.match(gestureUi, /const DEFAULT_HINT_SETTINGS = Object\.freeze/);
  assert.match(gestureUi, /fontSize: 20/);
  assert.match(gestureUi, /opacity: 60/);
  assert.match(gestureUi, /positionX: 0\.96/);
  assert.match(gestureUi, /positionY: 0\.04/);
  assert.match(gestureUi, /frameWidth: 200/);
  assert.match(gestureUi, /frameHeight: 60/);
  assert.match(gestureUi, /frameShape: "rect"/);
  assert.match(
    gestureUi,
    /hintBackgroundReset\.addEventListener\("click"/,
  );
  assert.match(gestureUi, /function normalizeHintQuickColors\(value\)/);
  assert.match(gestureUi, /function renderHintBackgroundPresets\(\)/);
  assert.match(gestureUi, /let selectedQuickColorId = null/);
  assert.match(gestureUi, /let hoveredQuickColorId = null/);
  assert.match(gestureUi, /gesture-hint-quick-color-bridge/);
  assert.match(gestureUi, /hoveredQuickColorId = null;\s*selectedQuickColorId = null/);
  assert.match(gestureUi, /let hintColorPickerOpen = false/);
  assert.match(gestureUi, /hintQuickColorAdd\.addEventListener\("click"/);
  assert.match(gestureUi, /hintColorPickerToggle\.addEventListener\("click"/);
  assert.match(gestureUi, /hintQuickColorAdd\.hidden = !hintColorPickerOpen/);
  assert.match(gestureUi, /hintBackground\.addEventListener\("change"/);
  assert.match(gestureUi, /hintSettings\.quickColors\.length < 6/);
  assert.match(gestureUi, /hintPreview\.hidden = !hintSettings\.backgroundEnabled \|\| hintDrawingFrame/);
  assert.match(gestureUi, /function updateHintFrame\(event\)/);
  assert.match(gestureUi, /function commitHintFrame\(\)/);
  assert.match(gestureUi, /hintDrawingFrame = true/);
  assert.match(gestureUi, /function cancelHintPreviewDrawing\(\)/);
  assert.match(gestureUi, /hintPreviewPathLine\.setAttribute\("points", ""\)/);
  assert.match(gestureUi, /hintPreviewPath\.style\.display = "none"/);
  assert.match(gestureUi, /hintPreviewArea\.addEventListener\("pointerleave"/);
  assert.doesNotMatch(
    gestureUi,
    /\.\.\.hintFreeformPoints, hintFreeformPoints\[0\]/,
  );
  assert.match(
    gestureUi,
    /commitHintFreeform\(\);[\s\S]*?clearHintDraftPreview\(\);[\s\S]*?releasePointerCapture\?\.\(pointerId\)/,
  );
  assert.match(gestureUi, /function commitHintFreeform\(\)/);
  assert.match(
    gestureUi,
    /function compactHintFreeformPoints\(points, maximum\)/,
  );
  assert.match(
    gestureUi,
    /compactHintFreeformPoints\(hintFreeformPoints, 48\)/,
  );
  assert.match(gestureUi, /hintBackground\.click\(\)/);
  assert.match(gestureUi, /if \(event\.target === hintPreview\)/);
  assert.match(gestureUi, /getElementById\("gesture-hint-enabled"\)/);
  assert.match(gestureUi, /function applySettingsDisclosure\(\)/);
  assert.match(gestureUi, /settingsToggle\.addEventListener\("click"/);
  assert.match(
    gestureUi,
    /editorClose\.addEventListener\("click", \(\) => \{\s*if \(editor\.hidden\) closeSettings\(\);\s*else closeEditor\(\);/,
  );
  assert.match(gestureUi, /globalPrecisionToggle\.addEventListener\("click"/);
  assert.match(gestureUi, /function showHint\(name\)/);
  assert.match(gestureUi, /function gestureInfoForTarget\(target\)/);
  assert.match(gestureUi, /target\?\.closest\?\.\("\[data-gesture-info\]"\)/);
  assert.match(gestureUi, /if \(!body\) return null/);
  assert.match(gestureUi, /function openGestureInfo\(info\)/);
  assert.match(gestureUi, /function withGestureInfo\(target, surface\)/);
  assert.match(gestureUi, /surface\.allowedActions\.concat\("book_info"\)/);
  assert.match(
    gestureUi,
    /if \(action === "book_info"\) \{\s*openGestureInfo\(info\);\s*return;\s*\}/,
  );
  assert.match(
    gestureUi,
    /return withGestureInfo\(target, baseSurface\(target\)\)/,
  );
  assert.match(gestureUi, /没有说明时不会执行/);
  assert.match(gestureUi, /function previewMatch\(gesture\)/);
  assert.match(
    gestureUi,
    /paintTrail\(active\.points\);\s*previewMatch\(active\);/,
  );
  assert.match(
    readerGesture,
    /paint\(active\.points\);\s*previewMatch\(active\);/,
  );
  assert.match(gestureUi, /if \(!hintSettings\.enabled\) return;/);
  assert.match(
    gestureUi,
    /if \(!hintSettings\.backgroundEnabled\) return "transparent"/,
  );
  assert.match(
    styles,
    /\.gesture-hint-background-switch \{[^}]*align-items: center/,
  );
  assert.match(
    styles,
    /\.gesture-hint-controls \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /\.gesture-hint-background-row \{[^}]*flex-wrap: wrap/,
  );
  assert.match(styles, /\.gesture-hint-quick-color-bridge \{[^}]*top: 100%;[^}]*width: 18px;[^}]*height: 6px/);
  assert.match(styles, /\.gesture-hint-quick-color-remove \{[^}]*top: calc\(100% \+ 5px\)/);
  assert.match(styles, /\.gesture-hint-quick-color-remove\[hidden\] \{[^}]*display: none/);
  assert.match(styles, /\.gesture-hint-background-preset \{[^}]*border: 0/);
  assert.match(styles, /\.gesture-hint-preview span\[hidden\] \{[^}]*display: none/);
  assert.doesNotMatch(styles, /\.gesture-hint-color-picker-panel \{/);
  assert.match(styles, /\.gesture-hint-color-picker-toggle \{[^}]*conic-gradient/);
  assert.match(styles, /\.gesture-hint-native-color-input \{[^}]*opacity: 0/);
  assert.match(styles, /\.gesture-hint-shape-tools \{[^}]*backdrop-filter: blur/);
  assert.match(styles, /\.gesture-hint-quick-color-add \{[^}]*background: #3478d4/);
  assert.match(styles, /\.gesture-hint-preview \{[^}]*min-height: 180px/);
  assert.match(styles, /\.gesture-hint-preview span \{[^}]*cursor: grab/);
  assert.match(
    styles,
    /\.gesture-hint-preview span,\s*\.reader-gesture-hint \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/,
  );
  assert.match(styles, /\.gesture-info-card \{[^}]*width: min\(560px/);
  assert.match(styles, /\.gesture-info-body \{[^}]*white-space: pre-line/);
  assert.match(gestureUi, /function placeHintPreview\(\)/);
  assert.match(gestureUi, /function updateHintPreviewPosition\(event\)/);
  assert.match(readerGesture, /function placeHint\(settings\)/);
  assert.match(readerGesture, /if \(!settings\.enabled\) return;/);
  assert.match(gestureUi, /function cancelGestureKeepHint\(\)/);
  assert.match(gestureUi, /scope: normalizeScope\(action, source\.scope\)/);
  assert.match(gestureUi, /手势会在所有页面参与匹配/);
  assert.match(gestureUi, /function fallbackSurface\(target\)/);
  assert.match(
    gestureUi,
    /const gestureSettings = root\.getElementById\("gesture-settings-modal"\)/,
  );
  assert.match(
    gestureUi,
    /runCloseOrUndo\(action, "手势设置", closeSettings, openSettings\)/,
  );
  assert.match(gestureUi, /allowedActions: supportedActions\(\["back"\]\)/);
  assert.match(gestureUi, /function canApplyAction\(surface, action\)/);
  assert.match(gestureUi, /reader-closed-for-reopen/);
  assert.match(gestureUi, /invoke\("open_book", \{ id \}\)/);
  assert.match(
    gestureUi,
    /matched && canApplyAction\(gesture\.surface, matched\.profile\.action\)/,
  );
  assert.match(gestureUi, /onMatch\(matched\.profile\.action\)/);
  assert.match(gestureUi, /getElementById\("book-info-modal"\)/);
  assert.match(gestureUi, /bookInfo\.classList\.remove\("show"\)/);
  assert.match(gestureUi, /getElementById\("book-organization-modal"\)/);
  assert.match(
    gestureUi,
    /getElementById\("book-organization-close"\)\?\.click\(\)/,
  );
  assert.match(gestureUi, /getElementById\("booklist-modal"\)/);
  assert.match(gestureUi, /getElementById\("booklist-close"\)\?\.click\(\)/);
  assert.match(gestureUi, /supportedActions\(\["back"\]\)/);
  assert.match(gestureUi, /target\?\.closest\?\.\("\.book\[data-id\]"\)/);
  assert.match(gestureUi, /const bookId = cardBookId \|\| selectedBookId/);
  assert.match(gestureUi, /ReaderBookInfo\?\.openById\?\.\(bookId\)/);
  assert.match(gestureUi, /reader-gesture-settings-request/);
  assert.match(gestureUi, /reader-gesture-settings/);
  assert.match(gestureUi, /reader_gesture_settings_save/);
  assert.match(gestureUi, /function runCloseOrUndo\(/);
  assert.match(
    styles,
    /\.gesture-settings-card \{[^}]*max-height: calc\(100dvh - 32px\);[^}]*overflow-y: auto/,
  );
  assert.match(
    styles,
    /\.gesture-manager-card\.is-editor-open \.gesture-manager-layout \{\s*align-items: start;\s*\}/,
  );
  assert.match(
    styles,
    /\.gesture-manager-list-pane,\s*\.gesture-editor \{\s*display: grid;\s*align-content: start;/,
  );
  assert.doesNotMatch(styles, /\.gesture-editor \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(styles, /\.gesture-list \{[^}]*overflow: auto/);
  assert.doesNotMatch(
    styles,
    /\.gesture-action-options \{[^}]*overflow-y: auto/,
  );
  assert.match(
    gestureUi,
    /pad\.addEventListener\("pointermove", moveTraining, \{ passive: false \}\)/,
  );
  assert.match(gestureUi, /pad\.addEventListener\("pointerup", finishTraining\)/);
  const matcher = gestureUi.slice(
    gestureUi.indexOf("function matchProfile"),
    gestureUi.indexOf("function begin"),
  );
  assert.doesNotMatch(matcher, /profile\.action === "back"/);
  assert.doesNotMatch(matcher, /profile\.scope === surface\.scope/);
  assert.doesNotMatch(
    matcher,
    /surface\.allowedActions\.includes\(profile\.action\)/,
  );
  assert.match(readerGesture, /async function closeReaderSurface\(source\)/);
  assert.match(
    readerGesture,
    /if \(shell\?\.closeSurface\?\.\(\)\) return;/,
  );
  assert.match(
    readerGesture,
    /previous\.sidePanel === "ai-reader" \? "智读" : previous\.sidePanel/,
  );
  assert.match(
    readerGesture,
    /ReaderShell\?\.setSidePanel\?\.\(previous\.sidePanel, true\)/,
  );
  assert.match(readerGesture, /function requestFrameSurfaceClose\(\)/);
  assert.match(
    readerGesture,
    /frame\.contentWindow\.postMessage\(\{ readerGestureAction: "back" \}, "\*"\)/,
  );
  assert.match(
    readerGesture,
    /source === "frame" && await requestFrameSurfaceClose\(\)/,
  );
  assert.match(readerGesture, /frameSurfaceClosed/);
  assert.doesNotMatch(
    readerGesture,
    /event\.target\?\.closest\?\.\("\.modal"\)/,
  );
  assert.match(readerGesture, /function undoLastReaderAction\(\)/);
  assert.match(readerGesture, /const undoHistory = \[\];/);
  assert.match(readerGesture, /reader-undo-checkpoint/);
  assert.match(readerGesture, /global\.openReaderBookInfo/);
  assert.match(readerGesture, /book_info: "信息提取／说明"/);
  assert.match(
    readerGesture,
    /action === "book_info" && typeof global\.openReaderBookInfo === "function"/,
  );
  assert.match(readerGesture, /connectSharedSettings\(\)/);
  assert.match(readerGesture, /reader-gesture-settings-request/);
  assert.match(readerGesture, /reader_gesture_settings_load/);
  assert.doesNotMatch(
    readerGesture,
    /profile\.action !== "book_info" \|\| String\(global\.currentBookId/,
  );
  assert.doesNotMatch(readerGesture, /reader-gesture-action/);
  assert.match(readerGesture, /function cancelKeepHint\(\)/);
  assert.match(readerGesture, /function hideHint\(\)/);
  assert.match(readerGesture, /if \(!active\) \{ hideHint\(\); return; \}/);
  assert.match(app, /hasSingleSelected: hasSingleSelectedBook/);
  assert.match(app, /openById: openBookInfoById/);
  assert.match(app, /tauriEvent\.listen\("reader-gesture-action"/);
});
test("NewsNow has a persisted horizontal and grid layout switch", () => {
  assert.match(html, /id="newsnow-layout-list"/);
  assert.match(html, /id="newsnow-layout-grid"/);
  assert.match(
    script,
    /const LAYOUT_STORAGE_KEY = "kunpeng\.reader\.news\.layout\.v1"/,
  );
  assert.match(script, /function setLayout\(next\)/);
  assert.match(script, /feed\.classList\.toggle\("newsnow-feed-grid", grid\)/);
  assert.match(script, /newsnow-card-image/);
  assert.match(script, /safeImageDataUrl/);
  assert.match(script, /item\.previewDataUrl \|\| item\.preview_data_url/);
  assert.match(script, /const VISIBLE_IMAGE_CONCURRENCY = 4/);
  assert.match(script, /new global\.IntersectionObserver/);
  assert.match(script, /invoke\("newsnow_preview_image"/);
  assert.match(script, /rootMargin: "500px 0px"/);
  assert.match(styles, /\.newsnow-card-image\.loading/);
  assert.match(
    script,
    /gridLayout\.addEventListener\("click", \(\) => setLayout\("grid"\)\)/,
  );
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
  assert.match(
    styles,
    /\.newsnow-layout-grid-icon::before\s*\{[^}]*width: 9px[^}]*height: 9px[^}]*box-shadow:\s*11px 0 currentColor,\s*0 11px currentColor,\s*11px 11px currentColor/s,
  );
  assert.match(script, /function masonryColumnCount\(\)/);
  assert.match(script, /className = "newsnow-masonry-column"/);
  assert.match(script, /function estimatedCardHeight\(item, columnCount\)/);
  assert.match(script, /const columnHeights = Array\.from/);
  assert.match(script, /renderedMasonryColumnCount = columnCount/);
  assert.match(
    script,
    /if \(page\.hidden \|\| feedView\.hidden\) \{ feedRenderPending = true; return; \}/,
  );
  assert.match(
    script,
    /if \(feedRenderPending \|\| layout === "grid"\) renderFeed\(\)/,
  );
  assert.match(script, /renderedMasonryColumnCount \|\| 1/);
  assert.match(script, /global\.addEventListener\("resize"/);
  assert.match(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*repeat\(var\(--newsnow-grid-columns, 1\)/s,
  );
  assert.match(
    styles,
    /\.newsnow-masonry-column\s*\{[^}]*flex-direction: column/s,
  );
  assert.doesNotMatch(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*column-width/s,
  );
  assert.match(styles, /\.newsnow-card-image\s*\{/);
  assert.match(styles, /\.newsnow-card-image\[hidden\]\s*\{\s*display: none/);
  assert.doesNotMatch(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid \.newsnow-card\s*\{[^}]*height: 222px/s,
  );
  assert.match(styles, /\.newsnow-card h2\s*\{[^}]*-webkit-line-clamp: 4/s);
});

test("NewsNow prefetches enabled sources and bounds visible image requests", () => {
  assert.match(script, /const BACKGROUND_PREFETCH_DELAY_MS = 30 \* 1000/);
  assert.match(
    script,
    /const BACKGROUND_PREFETCH_INTERVAL_MS = 5 \* 60 \* 1000/,
  );
  assert.match(script, /const BACKGROUND_PREFETCH_BATCHES = 4/);
  assert.match(script, /function scheduleBackgroundPrefetch\(\)/);
  assert.match(script, /function refreshIfIdle\(\)/);
  assert.match(
    script,
    /Date\.now\(\) - lastUserActivityAt < BACKGROUND_PREFETCH_DELAY_MS/,
  );
  assert.match(
    script,
    /invoke\("newsnow_prefetch", \{ request: newsRequest\(\) \}\)/,
  );
  assert.match(script, /function previewAttempted\(item\)/);
  assert.match(script, /function hasPendingPreviews\(result\)/);
  assert.match(script, /batch < BACKGROUND_PREFETCH_BATCHES/);
  assert.match(
    script,
    /const needsPreviewCache = hasPendingPreviews\(result\)/,
  );
  assert.match(script, /visibleImageRunning < VISIBLE_IMAGE_CONCURRENCY/);
  assert.match(
    backend,
    /const PREVIEW_IMAGE_MAX_BYTES: u64 = 4 \* 1024 \* 1024/,
  );
  assert.match(backend, /remember_preview_attempt/);
  assert.match(
    script,
    /if \(result\?\.stale \|\| needsPreviewCache\) void refreshInBackground\(\{ announce: true \}\)/,
  );
  assert.match(script, /masonryColumnCount\(\) === renderedMasonryColumnCount/);
  assert.match(
    styles,
    /\.experimental-settings\s*\{[^}]*padding: 0;[^}]*border: 0/s,
  );
  assert.doesNotMatch(styles, /\.experimental-settings \.fp-set-row\s*\{/);
  assert.match(
    styles,
    /\.experimental-settings \+ \.default-apps-setting\s*\{[^}]*border-top: 0/s,
  );
});

test("NewsNow persists mixed or source-grouped ordering", () => {
  assert.match(html, /id="newsnow-order-mixed"/);
  assert.match(html, /id="newsnow-order-source"/);
  assert.match(
    script,
    /const ORDER_STORAGE_KEY = "kunpeng\.reader\.news\.order\.v1"/,
  );
  assert.match(script, /function setOrder\(next\)/);
  assert.match(script, /newsnow-feed-by-source/);
  assert.match(styles, /\.newsnow-source-section\s*\{/);
});

test("NewsNow toolbar toggles the main-window news page", () => {
  assert.match(
    script,
    /button\.addEventListener\("click", \(\) => \{ if \(!page\.hidden \|\| !reader\.hidden\) close/,
  );
  assert.match(
    script,
    /page\.hidden = false; feedView\.hidden = false; sourcePicker\.hidden = true;[\s\S]*?shell\.hidden = true/,
  );
});

test("NewsNow presents a chronological reading feed and stays usable on narrow windows", () => {
  assert.match(styles, /\.newsnow-page\s*\{/);
  assert.match(styles, /\.newsnow-toolbar\s*\{[^}]*max-width: 1280px/s);
  assert.match(styles, /\.newsnow-categories\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card-rail\s*\{/);
  assert.match(styles, /\.newsnow-source-picker\s*\{/);
  assert.match(styles, /\.newsnow-card:hover,\s*\.newsnow-card:focus-visible/);
  assert.match(styles, /\.newsnow-reader\s*\{/);
  assert.match(styles, /\.newsnow-reader\[hidden\]\s*\{\s*display: none/);
  assert.match(styles, /\.newsnow-reader\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /\.newsnow-reader-content\s*\{/);
  assert.match(styles, /\.newsnow-source-notice\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
