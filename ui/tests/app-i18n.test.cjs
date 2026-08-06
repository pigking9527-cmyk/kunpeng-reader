const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const i18n = fs.readFileSync(path.join(uiRoot, "app-i18n.js"), "utf8");
const app = fs.readFileSync(path.join(uiRoot, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(uiRoot, "styles.css"), "utf8");

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
  assert.match(html, /id="settings-restore-backup"[^>]*data-i18n-aria="recoverySelect"/);
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
  assert.match(app, /function renderRecoveryBackupStatus/);
  assert.match(app, /appText\("recoveryStatus"/);
  assert.match(app, /app-language-changed[\s\S]*?renderRecoveryBackupStatus\(lastRecoveryBackupStatus\)/);
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s);
  assert.match(styles, /#fp-settings-modal \.fp-set-row > :first-child\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.default-apps-setting \.btn-plain\s*\{[^}]*max-width:\s*48%;[^}]*white-space:\s*normal;/s);
});
