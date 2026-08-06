const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const i18n = fs.readFileSync(path.join(uiRoot, "app-i18n.js"), "utf8");
const app = fs.readFileSync(path.join(uiRoot, "app.js"), "utf8");

test("main settings expose a persistent software language selector", () => {
  assert.match(html, /id="set-app-language"/);
  assert.match(html, /src="app-i18n\.js"/);
  assert.match(i18n, /const STORAGE_KEY = "appLanguageV1"/);
  assert.match(i18n, /\["system", "跟随系统"\]/);
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    assert.match(i18n, new RegExp(`\\["${locale.replace("-", "\\-")}"`));
  }
  assert.match(app, /ReaderAppI18n\?\.populate\(appLanguageSelect\)/);
  assert.match(app, /ReaderAppI18n\?\.setLanguage\(appLanguageSelect\.value\)/);
  assert.match(i18n, /data-i18n-placeholder/);
  assert.match(i18n, /function t\(key\).*COPY\.en\[key\]/);
  assert.match(html, /id="newsnow-page"[\s\S]*?data-i18n="newsTitle"/);
  assert.match(html, /id="library-ai-page"[\s\S]*?data-i18n="libraryDescription"/);
  assert.match(fs.readFileSync(path.join(uiRoot, "news-ui.js"), "utf8"), /app-language-changed/);
  assert.match(fs.readFileSync(path.join(uiRoot, "library-ai.js"), "utf8"), /app-language-changed/);
  assert.match(html, /id="open-default-apps-settings"[^>]*data-i18n="defaultOpenButton"/);
  assert.match(html, /id="recovery-backup-status"[^>]*data-i18n="recoveryLoading"/);
  assert.match(html, /id="settings-export-data"[^>]*data-i18n="dataExport"/);
  assert.match(i18n, /const SETTINGS_COPY/);
  assert.match(app, /function renderRecoveryBackupStatus/);
  assert.match(app, /appText\("recoveryStatus"/);
  assert.match(app, /app-language-changed[\s\S]*?renderRecoveryBackupStatus\(lastRecoveryBackupStatus\)/);
});
