const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(uiRoot, "reader-i18n.js"), "utf8");
const html = fs.readFileSync(path.join(uiRoot, "reader.html"), "utf8");
const notes = fs.readFileSync(path.join(uiRoot, "reader-notes-ui.js"), "utf8");

function loadReaderI18n(language) {
  const localStorage = { value: language, getItem() { return this.value; } };
  const document = {
    readyState: "complete", documentElement: {}, querySelectorAll() { return []; }, addEventListener() {},
  };
  const window = {
    localStorage, navigator: { language: language === "ja" ? "ja-JP" : language }, document,
    addEventListener() {}, dispatchEvent() {},
  };
  vm.runInNewContext(source, { window, document, localStorage, navigator: window.navigator, CustomEvent: function CustomEvent() {} });
  return { i18n: window.ReaderI18n, localStorage };
}

test("reader uses an independent localization entry point before reader behavior modules", () => {
  assert.match(html, /<script src="reader-i18n\.js"><\/script>\s*<script src="bridge\/reader-protocol-bridge\.js"><\/script>\s*<script src="reader-message\.js">/);
  assert.match(html, /id="prev-btn"[^>]*data-reader-i18n-title="previousChapter"/);
  assert.match(html, /id="next-btn"[^>]*data-reader-i18n-title="nextChapter"/);
  const previousPageButton = notes.slice(notes.indexOf('getElementById("prev-btn")'), notes.indexOf('getElementById("next-btn")'));
  const nextPageButton = notes.slice(notes.indexOf('getElementById("next-btn")'), notes.indexOf("let tocBuildVersion"));
  assert.match(previousPageButton, /sendToPage\(\{ pageTurn: -1 \}\);/);
  assert.match(nextPageButton, /sendToPage\(\{ pageTurn: 1 \}\);/);
  assert.doesNotMatch(previousPageButton + nextPageButton, /gotoChapter/);
  assert.match(html, /id="immersive-btn"[^>]*data-reader-i18n-title="immersive"/);
  assert.match(html, /id="vocab-gear"[^>]*data-reader-i18n-title="vocabularySettings"/);
  assert.match(html, /id="cross-return"[^>]*data-reader-i18n-title="returnToPreviousBook"/);
  assert.match(source, /global\.addEventListener\("storage"/);
  assert.match(source, /reader-language-changed/);
});

test("Japanese reader strings do not silently fall back to English", () => {
  const keys = [
    "pageTitle", "toc", "previousChapter", "nextChapter", "searchBook", "readAloud", "annotations", "immersive", "settings",
    "vocabulary", "measuringPages", "windowControls", "minimize", "maximize", "aiReading", "format", "style", "bookInformation",
    "recommendations", "crossBookSearch", "fontSize", "speech", "ttsMicrosoftAuto", "ttsSystemOffline", "noConfiguredModel", "modelSwitchFailed", "aiFailed", "chapterProgress", "dualChapterProgress",
  ];
  const english = loadReaderI18n("en").i18n;
  const japanese = loadReaderI18n("ja").i18n;
  for (const key of keys) {
    assert.notEqual(japanese.t(key), english.t(key), `Japanese reader key must not fall back to English: ${key}`);
  }
  assert.deepEqual([...japanese.missingKeys("ja")], [], "every reader message ID must have Japanese copy");
  assert.equal(japanese.t("not-a-real-key"), "⟦not-a-real-key⟧", "Japanese missing keys must not silently use a fallback language");
  assert.match(source, /filter\(\(locale\) => locale !== "ja"\)/);
  assert.doesNotMatch(source, /ja:\s*Object\.assign\(\{\}, EN/);
});

test("dynamic reader surfaces use message IDs and keep Japanese out of English fallback", () => {
  const keys = [
    "searchHits", "crossSemanticTitle", "crossKeywordTitle", "crossSemanticEmpty", "vocabEmpty", "clickToPronounce",
    "traceVersionSystem", "traceFrozen", "traceExported",
  ];
  const english = loadReaderI18n("en").i18n;
  const japanese = loadReaderI18n("ja").i18n;
  for (const key of keys) assert.notEqual(japanese.t(key), english.t(key), `Japanese dynamic key must not fall back to English: ${key}`);
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const i18n = loadReaderI18n(locale).i18n;
    for (const key of keys) assert.notEqual(i18n.t(key), key, `missing dynamic reader key ${key} for ${locale}`);
  }
});
