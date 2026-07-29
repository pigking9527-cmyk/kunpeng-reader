const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("index.html");
const styles = read("styles.css");
const app = read("app.js");
const settings = read("animation-settings.js");
const settingsUi = read("animation-settings-ui.js");
const readerHtml = read("reader.html");
const readerSettings = read("reader-settings-ui.js");
const notes = read("reader-notes-ui.js");
const layout = read("reader-page-layout.js");
const transition = read("reader-page-transition.js");
const annotations = read("reader-page-annotations.js");
const runtime = read("reader-page-runtime.js");
const pageStyle = read("reader-page-style.html");

test("visible-book count shares the layout and column row", () => {
  const row = html.slice(html.indexOf('<div class="layout-config-row">'), html.indexOf("</div>", html.indexOf('id="filter-result-summary"')) + 6);
  assert.match(row, /class="layout-setting"/);
  assert.match(row, /class="grid-cols-setting"/);
  assert.match(row, /id="filter-result-summary"/);
  assert.ok(row.indexOf("filter-result-summary") > row.indexOf("grid-cols-setting"));
  assert.match(styles, /\.fp-result-summary\s*\{[^}]*margin:\s*0 0 5px auto;/s);
});

test("common settings separates main-window and reader-page master animation controls", () => {
  assert.match(html, /id="animation-gear"/);
  assert.match(html, /id="animation-settings-modal"/);
  for (const group of ["mainWindow", "readerPage"]) {
    assert.match(html, new RegExp(`data-animation-group="${group}"`));
    assert.match(settings, new RegExp(`${group}: true`));
  }
  for (const key of ["searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "annotationAdd", "readingMode", "pageTurn", "highlightSettings", "booklistSort"]) {
    assert.match(html, new RegExp(`data-animation-setting="${key}"`));
    assert.match(settings, new RegExp(`${key}: true`));
  }
  assert.match(settings, /readerAnimationSettingsV1/);
  assert.match(settings, /GROUP_BY_KEY/);
  assert.match(settings, /function isEnabled/);
  assert.match(settings, /syncPageTurnEffect/);
  assert.match(settings, /localStorage\.setItem\("readerSettings"/);
  assert.match(settingsUi, /ReaderAnimationSettings\?\.set/);
  assert.doesNotMatch(settingsUi, /讨厌动画/);
  assert.match(settingsUi, /ReaderAnimationSettingsUI/);
  assert.match(html, /主窗口动画/);
  assert.match(html, /书页动画/);
  assert.match(styles, /anim-search-popup-off/);
  assert.match(styles, /anim-shelf-search-toggle-off \.shelf-toggle input/);
  assert.match(styles, /anim-common-settings-switch-off #fp-settings-modal \.switch \.slider/);
  assert.match(styles, /anim-filter-button-off/);
  assert.match(styles, /anim-booklist-sort-off/);
  assert.ok(html.indexOf("animation-settings-ui.js") < html.indexOf("app.js"));
});

test("animation category switches clear their children and child switches restore the category", () => {
  const stored = new Map();
  const fakeWindow = {
    localStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    dispatchEvent() {},
  };
  vm.runInNewContext(settings, {
    window: fakeWindow,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  const api = fakeWindow.ReaderAnimationSettings;

  api.set("pageTurn", true);
  api.set("readerPage", false);
  assert.equal(api.read().pageTurn, false);
  assert.equal(api.enabled("pageTurn"), false);
  assert.equal(JSON.parse(stored.get("readerSettings")).pageTurnEffect, "off");

  api.set("readerPage", true);
  assert.equal(api.enabled("pageTurn"), true);
  assert.equal(JSON.parse(stored.get("readerSettings")).pageTurnEffect, "horizontal");

  api.set("readerPage", false);
  assert.equal(api.read().annotationAdd, false);
  assert.equal(api.read().readingMode, false);
  assert.equal(api.read().highlightSettings, false);
  api.setPageTurnFromReader(true);
  assert.equal(api.read().readerPage, true);
  assert.equal(api.enabled("pageTurn"), true);
  assert.equal(api.read().annotationAdd, false);
  assert.equal(api.read().readingMode, false);
  assert.equal(api.read().highlightSettings, false);

  api.set("pageTurn", false);
  assert.equal(api.read().readerPage, false);
  api.set("annotationAdd", true);
  assert.equal(api.read().readerPage, true);

  for (const key of ["searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "booklistSort"]) {
    api.set(key, false);
  }
  assert.equal(api.read().mainWindow, false);
  api.set("mainWindow", true);
  assert.equal(api.read().mainWindow, true);
  assert.equal(api.read().searchPopup, true);
  assert.equal(api.read().booklistSort, true);
  api.set("mainWindow", false);
  for (const key of ["searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "booklistSort"]) {
    assert.equal(api.read()[key], false);
  }
  api.set("filterButton", true);
  assert.equal(api.read().mainWindow, true);
  assert.equal(api.read().filterButton, true);
  for (const key of ["annotationAdd", "readingMode", "pageTurn", "highlightSettings"]) {
    api.set(key, false);
  }
  assert.equal(api.read().readerPage, false);
  api.set("readerPage", true);
  assert.equal(api.read().readerPage, true);
  assert.equal(api.read().pageTurn, true);
  api.set("filterButton", true);
  assert.equal(api.read().mainWindow, true);
});

test("reader animation controls reach each requested interaction", () => {
  assert.match(readerHtml, /animation-settings\.js/);
  assert.match(readerHtml, /anim-reading-mode-off/);
  assert.match(readerSettings, /ReaderAnimationSettings\?\.applyReader/);
  assert.match(notes, /openAnnotations\(highlights\.length - 1, true\)/);
  assert.match(layout, /readerAnimationSettingOn/);
  assert.match(transition, /readerAnimationSettingOn\('pageTurn'\)/);
  assert.match(readerSettings, /event\.key !== "readerSettings"/);
  assert.match(readerSettings, /ReaderAnimationSettings\?\.setPageTurnFromReader\?\.\(turnFx\.value !== "off"\)/);
  assert.match(annotations, /readerAnimationSettingOn\('highlightSettings'\)/);
  assert.match(runtime, /animationSettings/);
  assert.match(runtime, /anim-highlight-settings-off/);
  assert.match(pageStyle, /anim-highlight-settings-off/);
  assert.match(pageStyle, /hlSettingsPopIn/);
});
