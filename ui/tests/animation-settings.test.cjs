const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("index.html");
const styles = read("styles.css");
const app = read("app.js");
const settings = read("animation-settings.js");
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

test("common settings exposes nine persisted animation controls and names the all-off state", () => {
  assert.match(html, /id="animation-gear"/);
  assert.match(html, /id="animation-settings-modal"/);
  for (const key of ["searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "annotationAdd", "readingMode", "pageTurn", "highlightSettings", "booklistSort"]) {
    assert.match(html, new RegExp(`data-animation-setting="${key}"`));
    assert.match(settings, new RegExp(`${key}: true`));
  }
  assert.match(settings, /readerAnimationSettingsV1/);
  assert.match(settings, /syncPageTurnEffect/);
  assert.match(settings, /localStorage\.setItem\("readerSettings"/);
  assert.match(app, /ReaderAnimationSettings\?\.set/);
  assert.match(app, /"讨厌动画"/);
  assert.match(styles, /anim-search-popup-off/);
  assert.match(styles, /anim-shelf-search-toggle-off \.shelf-toggle input/);
  assert.match(styles, /anim-common-settings-switch-off #fp-settings-modal \.switch \.slider/);
  assert.match(styles, /anim-filter-button-off/);
  assert.match(styles, /anim-booklist-sort-off/);
});

test("reader animation controls reach each requested interaction", () => {
  assert.match(readerHtml, /animation-settings\.js/);
  assert.match(readerHtml, /anim-reading-mode-off/);
  assert.match(readerSettings, /ReaderAnimationSettings\?\.applyReader/);
  assert.match(notes, /openAnnotations\(highlights\.length - 1, true\)/);
  assert.match(layout, /readerAnimationSettingOn/);
  assert.doesNotMatch(transition, /readerAnimationSettingOn\('pageTurn'\)/);
  assert.match(readerSettings, /event\.key !== "readerSettings"/);
  assert.match(readerSettings, /ReaderAnimationSettings\?\.set\?\.\("pageTurn", turnFx\.value !== "off"\)/);
  assert.match(annotations, /readerAnimationSettingOn\('highlightSettings'\)/);
  assert.match(runtime, /animationSettings/);
  assert.match(runtime, /anim-highlight-settings-off/);
  assert.match(pageStyle, /anim-highlight-settings-off/);
  assert.match(pageStyle, /hlSettingsPopIn/);
});
