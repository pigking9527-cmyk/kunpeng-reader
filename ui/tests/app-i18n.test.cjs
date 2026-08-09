const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const i18n = fs.readFileSync(path.join(uiRoot, "app-i18n.js"), "utf8");
const app = fs.readFileSync(path.join(uiRoot, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(uiRoot, "styles.css"), "utf8");

test("main settings expose a persistent software language selector", () => {
  assert.match(html, /id="set-app-language"/);
  assert.match(html, /id="set-end-recommendations"[^>]*checked/);
  assert.match(html, /data-i18n="endRecommendations"/);
  assert.match(html, /src="reader-recommendation-settings\.js"/);
  assert.match(i18n, /COPY\[locale\]\.endRecommendations = label/);
  assert.match(html, /src="app-i18n\.js"/);
  assert.match(i18n, /const STORAGE_KEY = "appLanguageV1"/);
  assert.match(i18n, /\["system", "跟随系统"\]/);
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    assert.match(i18n, new RegExp(`\\["${locale.replace("-", "\\-")}"`));
  }
  assert.match(app, /ReaderAppI18n\?\.populate\(appLanguageSelect\)/);
  assert.match(app, /ReaderAppI18n\?\.setLanguage\(appLanguageSelect\.value\)/);
  assert.match(i18n, /data-i18n-placeholder/);
  assert.match(i18n, /function t\(key\)[\s\S]*?language === "ja"/);
  assert.match(html, /id="newsnow-page"[\s\S]*?data-i18n="manageSources"/);
  assert.match(html, /id="library-ai-page"[\s\S]*?data-i18n="libraryQuestion"/);
  assert.doesNotMatch(html, /data-i18n="libraryDescription"/);
  assert.match(fs.readFileSync(path.join(uiRoot, "news-ui.js"), "utf8"), /app-language-changed/);
  assert.match(fs.readFileSync(path.join(uiRoot, "library-ai.js"), "utf8"), /app-language-changed/);
  assert.match(html, /id="open-default-apps-settings"[^>]*data-i18n="defaultOpenButton"/);
  assert.match(html, /id="recovery-backup-status"[^>]*data-i18n="recoveryLoading"/);
  assert.match(html, /id="settings-export-data"[^>]*data-i18n="dataExport"/);
  assert.match(html, /id="settings-restore-backup"[^>]*data-i18n-aria="recoverySelect"/);
  assert.match(html, /id="sync-now"[^>]*data-i18n="syncNow"/);
  assert.match(html, /id="account-security-panel"[^>]*data-i18n-aria="accountSecurity"/);
  assert.match(html, /id="account-data-panel"[^>]*data-i18n-aria="accountDataPrivacy"/);
  assert.match(html, /id="private-sync-panel"[^>]*data-i18n-aria="privateSyncTitle"/);
  assert.match(html, /id="library-ai-answer-settings-title"[^>]*data-i18n="answerSettings"/);
  assert.match(html, /id="newsnow-settings-title"[^>]*data-i18n="newsSettings"/);
  assert.match(html, /id="filter-btn"[^>]*data-i18n-title="sortAndLayout"/);
  assert.match(html, /id="stats-chart-mode"[^>]*data-i18n="time"/);
  assert.match(i18n, /const ACCOUNT_SUBPAGE_COPY/);
  assert.match(i18n, /const PANEL_COPY/);
  assert.match(i18n, /const ACCOUNT_RUNTIME_COPY/);
  assert.doesNotMatch(html, /id="search-input"[^>]*data-i18n-placeholder/);
  assert.match(fs.readFileSync(path.join(uiRoot, "search-ui.js"), "utf8"), /updateShelfSearchMode\(\)[\s\S]*?shelfSearchPlaceholder/);
  assert.match(i18n, /const SETTINGS_COPY/);
  const settingsCopy = i18n.slice(i18n.indexOf("const SETTINGS_COPY"), i18n.indexOf("Object.entries(SETTINGS_COPY)"));
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const localeMarker = ["zh-CN", "zh-TW", "pt-BR"].includes(locale) ? `"${locale}": {` : `${locale}: {`;
    const localeStart = settingsCopy.indexOf(localeMarker);
    const localeEnd = settingsCopy.indexOf("\n    ", localeStart + localeMarker.length);
    const localeCopy = settingsCopy.slice(localeStart, localeEnd < 0 ? undefined : localeEnd);
    assert.notEqual(localeStart, -1, `missing settings copy for ${locale}`);
    for (const key of ["defaultOpenTitle", "recoveryTitle", "recoverySelect", "recoveryStatus", "dataImport"]) assert.match(localeCopy, new RegExp(`${key}:`));
  }
  const accountCopy = i18n.slice(i18n.indexOf("const ACCOUNT_SEARCH_COPY"), i18n.indexOf("const SYNC_COUNTS_COPY"));
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const marker = ["zh-CN", "zh-TW", "pt-BR"].includes(locale) ? `"${locale}": {` : `${locale}: {`;
    const start = accountCopy.indexOf(marker);
    const end = accountCopy.indexOf("\n    ", start + marker.length);
    const copy = accountCopy.slice(start, end < 0 ? undefined : end);
    assert.notEqual(start, -1, `missing account/search copy for ${locale}`);
    for (const key of ["syncContent", "lastSync", "searchPlaceholder", "shelfSearchPlaceholder"]) assert.match(copy, new RegExp(`${key}:`));
  }
  assert.match(app, /function renderRecoveryBackupStatus/);
  assert.match(app, /appText\("recoveryStatus"/);
  assert.match(app, /app-language-changed[\s\S]*?renderRecoveryBackupStatus\(lastRecoveryBackupStatus\)/);
  assert.match(i18n, /const DEFAULT_APPS_NOTICE_COPY/);
  assert.match(app, /AppNotice\?\.show\([\s\S]*?defaultOpenToast[\s\S]*?variant:\s*"text"[\s\S]*?duration:\s*1500/s);
  assert.match(app, /defaultOpenFailed/);
  assert.doesNotMatch(app, /alert\("已打开 Windows 默认应用设置/);
  assert.match(fs.readFileSync(path.join(uiRoot, "sync-ui.js"), "utf8"), /app-language-changed[\s\S]*?applyAccountSecurityStatus\(lastAccountSecurity\)/);
  assert.match(fs.readFileSync(path.join(uiRoot, "stats-ui.js"), "utf8"), /app-language-changed[\s\S]*?renderStats\(\)/);
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;[^}]*user-select:\s*none;/s);
  assert.match(styles, /#fp-settings-modal \.modal-card input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\),[\s\S]*user-select:\s*text;/);
  assert.match(styles, /#fp-settings-modal \.fp-set-row > :first-child\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.default-apps-setting > \.btn-plain\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*48%;/s);
  assert.match(styles, /\.recovery-backup-actions \.btn-plain\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*100%;/s);
});

function loadAppI18n(language) {
  const document = { readyState: "complete", documentElement: {}, querySelectorAll() { return []; }, addEventListener() {} };
  const localStorage = { getItem() { return language; }, setItem() {} };
  const window = { document, localStorage, navigator: { language: language === "ja" ? "ja-JP" : language }, addEventListener() {}, dispatchEvent() {} };
  vm.runInNewContext(i18n, { window, document, localStorage, navigator: window.navigator, CustomEvent: function CustomEvent() {} });
  return window.ReaderAppI18n;
}

test("Japanese main-window catalog is complete and never uses English fallback", () => {
  const japanese = loadAppI18n("ja");
  const english = loadAppI18n("en");
  assert.deepEqual([...japanese.missingKeys("ja")], [], "every English UI message must have Japanese copy");
  for (const key of [
    "newsTitle", "manageSources", "libraryQuestion", "questionHistory", "accountDataPrivacy",
    "clearThisDeviceData", "sortAndLayout", "newsSettings", "gestureBack", "answerSettings",
    "statsLoading", "accountSecurityBoundEmail",
  ]) {
    assert.notEqual(japanese.t(key), english.t(key), `Japanese main-window key must not fall back to English: ${key}`);
    assert.doesNotMatch(japanese.t(key), /^⟦.+⟧$/, `Japanese main-window key must not be an unresolved token: ${key}`);
  }
  assert.match(i18n, /locale !== "ja" && locale !== "ko"/);
  assert.match(i18n, /language === "ja" \|\| language === "ko"/);
});

test("Korean secondary panels have a complete catalog and never inherit English", () => {
  const korean = loadAppI18n("ko");
  const english = loadAppI18n("en");
  assert.deepEqual([...korean.missingKeys("ko")], [], "every English UI message must have Korean copy");
  for (const key of [
    "accountDataPrivacy", "privateSyncTitle", "clearThisDeviceData", "sortAndLayout",
    "newsSettings", "gestureBack", "libraryQuestion", "questionHistory",
    "libraryScopeTip", "libraryFilterTip", "statsLoading", "accountSecurityBoundEmail",
  ]) {
    assert.notEqual(korean.t(key), english.t(key), `Korean key must not inherit English: ${key}`);
    assert.doesNotMatch(korean.t(key), /^⟦.+⟧$/, `Korean key must not be an unresolved token: ${key}`);
  }
});

test("all ten languages localize the five settings child pages", () => {
  const chinese = loadAppI18n("zh-CN");
  const keys = [
    "recommendationSettings", "apiSettingsTitle", "animationSettings",
    "importDirectoriesTitle", "externalDictionaryTitle", "apiSettingsNote",
    "animationMainHelp", "importDirectoriesNote", "externalDictionaryNote",
  ];
  assert.match(i18n, /const SETTINGS_SUBPAGE_COPY/);
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const localized = loadAppI18n(locale);
    for (const key of keys) {
      assert.doesNotMatch(localized.t(key), /^⟦.+⟧$/, `${locale} must define ${key}`);
      if (locale !== "zh-CN") assert.notEqual(localized.t(key), chinese.t(key), `${locale} must not retain Chinese ${key}`);
    }
  }
  for (const id of ["reader-recommendation-settings-modal", "api-settings-modal", "animation-settings-modal", "import-dirs-modal", "external-dict-modal"]) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?data-i18n`), `${id} must use catalog keys`);
  }
});

test("all ten languages localize About, feedback, and sync runtime states", () => {
  const chinese = loadAppI18n("zh-CN");
  const keys = [
    "aboutSoftware", "aboutReleaseNotes", "submitBug", "suggestFeature",
    "feedbackBugNote", "feedbackFeaturePlaceholder", "problemTraceOptional",
    "feedbackSubmitting", "feedbackSubmitFailed", "syncInProgress",
    "syncSuccess", "syncFailed", "syncConnecting", "syncFailedDetail",
  ];
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const localized = loadAppI18n(locale);
    for (const key of keys) {
      assert.doesNotMatch(localized.t(key), /^⟦.+⟧$/, `${locale} must define ${key}`);
    }
    if (locale !== "zh-CN") {
      for (const key of ["feedbackBugNote", "suggestFeature", "syncConnecting"]) {
        assert.notEqual(localized.t(key), chinese.t(key), `${locale} must not retain Chinese ${key}`);
      }
    }
  }
  for (const key of ["aboutSoftware", "aboutVersion", "aboutReleaseNotes", "submitBug", "suggestFeature", "problemTraceOptional", "addScreenshot"]) {
    assert.match(html, new RegExp(`data-i18n="${key}"`), `About/feedback HTML must bind ${key}`);
  }
  const feedback = fs.readFileSync(path.join(uiRoot, "feedback-ui.js"), "utf8");
  const sync = fs.readFileSync(path.join(uiRoot, "sync-ui.js"), "utf8");
  assert.match(feedback, /app-language-changed/);
  assert.match(feedback, /feedbackTextFor\("feedbackSubmitting"\)/);
  assert.match(sync, /setSyncButtonState\("fail", "syncFailed"/);
  assert.match(sync, /syncText\("syncFailedDetail"/);
});
