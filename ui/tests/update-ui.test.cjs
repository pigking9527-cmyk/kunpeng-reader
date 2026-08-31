const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
const about = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "about-ui.js"),
  "utf8",
);
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const gestures = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "gesture-ui.js"), "utf8");

test("startup update check runs promptly without waiting for the reader window", () => {
  assert.match(app, /startupTimed\("update-check", \(\) => aboutUI\.checkUpdate\(false\), "background"\)/);
  assert.match(app, /startupTimed\("update-check"[\s\S]{0,180}\}, 0\);/);
  const updateCall = app.indexOf('startupTimed("update-check"');
  const nearestScheduler = app.lastIndexOf("setTimeout(() => {", updateCall);
  assert.ok(nearestScheduler >= 0 && updateCall > nearestScheduler);
  assert.doesNotMatch(app.slice(nearestScheduler, updateCall), /runWhenNoReader/);
});

test("automatic checks respect an ignored release while manual checks bypass it", () => {
  assert.match(about, /const isIgnored = \(info\) => \{[\s\S]*?storage\.getItem\("ignoredUpdate"\)/);
  assert.match(about, /if \(!force && isIgnored\(info\)\) return/);
  assert.match(about, /updateButton\.addEventListener\("click"[^]*?checkUpdate\(true\)/);
});

test("manual update failures use the injected notice instead of a native dependency", () => {
  assert.match(about, /alertAction = options\.alertAction \?\? runtime\.alert/);
  assert.match(about, /if \(force\) alertAction\?\.\(text\("updateCheckFailed"/);
  assert.match(about, /alertAction\?\.\([\s\S]*?"updateCheckNetworkFailed"/);
});

test("update card is centered, icon-free, and shows readable release notes", () => {
  assert.match(html, /id="ub-current"/);
  assert.match(html, /id="ub-ver"/);
  assert.match(html, /id="ub-notes"/);
  assert.doesNotMatch(html, /class="ub-icon"/);
  assert.match(styles, /\.update-bar\s*\{[\s\S]*?display:\s*none;[\s\S]*?position:\s*fixed;/);
  assert.match(about, /const renderReleaseNotes = \(target, value, fallback/);
  assert.match(about, /const appendReleaseInline = \(parent, value\) =>/);
  assert.match(about, /target\.replaceChildren\(fragment\)/);
  assert.doesNotMatch(about, /\.innerHTML\s*=/);
  assert.match(about, /showUpdateBanner\(info\)/);
  assert.match(about, /info\.current/);
  assert.match(about, /info\.latest/);
  assert.match(about, /info\.notes/);
});

test("closing an update card is restorable and never turns its gesture into an app close", () => {
  assert.match(about, /const pendingUpdateKey = "pendingUpdateV1"/);
  assert.match(about, /const installedVersion = async \(\) =>/);
  assert.match(about, /cachedPendingUpdate\(currentVersion\)/);
  assert.match(about, /storage\.removeItem\(pendingUpdateKey\)/);
  assert.match(about, /const restorePendingUpdate = \(\) =>/);
  assert.match(about, /const discardStalePendingUpdate = \(info\) =>/);
  assert.match(about, /info\.source !== "server" \|\| info\.has_update/);
  assert.match(about, /const hideUpdateCard = \(\) =>/);
  assert.match(about, /const reopenUpdateCard = \(\) =>/);
  assert.match(about, /cachePendingUpdate\(info\)/);
  assert.match(gestures, /const updateCard = optional\("update-bar"\)/);
  assert.match(gestures, /runCloseOrUndo\(\s*action,\s*"更新说明"/);
  assert.match(gestures, /ReaderAboutUI\?\.hideUpdateCard/);
  assert.match(gestures, /ReaderAboutUI\?\.reopenUpdateCard/);
});
