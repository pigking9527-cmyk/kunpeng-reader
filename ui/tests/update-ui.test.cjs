const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const about = fs.readFileSync(path.join(__dirname, "..", "about-ui.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const gestures = fs.readFileSync(path.join(__dirname, "..", "gesture-ui.js"), "utf8");

test("startup update check runs promptly without waiting for the reader window", () => {
  const marker = "// 更新检查不阻塞首屏";
  const start = app.indexOf(marker);
  const end = app.indexOf('// “关于”里的版本号', start);
  assert.ok(start >= 0 && end > start, "startup update block must remain discoverable");
  const block = app.slice(start, end);

  assert.match(block, /startupTimed\("update-check", \(\) => aboutUI\.checkUpdate\(false\), "background"\)/);
  assert.match(block, /}, 0\);/);
  assert.doesNotMatch(block, /runWhenNoReader/);
});

test("automatic checks respect an ignored release while manual checks bypass it", () => {
  assert.match(about, /function isIgnored\(info\) \{[\s\S]*?storage\.getItem\("ignoredUpdate"\)/);
  assert.match(about, /if \(!force\) \{[\s\S]*?isIgnored\(info\)/);
  assert.match(about, /updateButton\.addEventListener\("click"[^]*?checkUpdate\(true\)/);
});

test("manual update failures use the injected notice instead of a native dependency", () => {
  assert.match(about, /alertAction = global\.alert/);
  assert.match(about, /if \(force\) alertAction\(text\("updateCheckFailed"/);
  assert.match(about, /if \(force\) alertAction\(text\("updateCheckNetworkFailed"/);
});

test("update card is centered, icon-free, and shows readable release notes", () => {
  assert.match(html, /id="ub-current"/);
  assert.match(html, /id="ub-ver"/);
  assert.match(html, /id="ub-notes"/);
  assert.doesNotMatch(html, /class="ub-icon"/);
  assert.match(styles, /\.update-bar\s*\{[\s\S]*?display:\s*none;[\s\S]*?position:\s*fixed;/);
  assert.match(about, /function renderReleaseNotes\(target, value, fallback/);
  assert.match(about, /function appendReleaseInline\(parent, value\)/);
  assert.match(about, /target\.replaceChildren\(fragment\)/);
  assert.doesNotMatch(about, /\.innerHTML\s*=/);
  assert.match(about, /showUpdateBanner\(info\)/);
  assert.match(about, /info\.current/);
  assert.match(about, /info\.latest/);
  assert.match(about, /info\.notes/);
});

test("closing an update card is restorable and never turns its gesture into an app close", () => {
  assert.match(about, /const pendingUpdateKey = "pendingUpdateV1"/);
  assert.match(about, /function restorePendingUpdate\(\)/);
  assert.match(about, /function discardStalePendingUpdate\(info\)/);
  assert.match(about, /info\?\.source !== "server" \|\| info\?\.has_update/);
  assert.match(about, /function hideUpdateCard\(\)/);
  assert.match(about, /function reopenUpdateCard\(\)/);
  assert.match(about, /cachePendingUpdate\(info\)/);
  assert.match(gestures, /const updateCard = root\.getElementById\("update-bar"\)/);
  assert.match(gestures, /runCloseOrUndo\(\s*action,\s*"更新说明"/);
  assert.match(gestures, /ReaderAboutUI\?\.hideUpdateCard/);
  assert.match(gestures, /ReaderAboutUI\?\.reopenUpdateCard/);
});
