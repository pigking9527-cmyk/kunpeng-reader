const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "reader.html"), "utf8");
const reader = fs.readFileSync(path.join(__dirname, "..", "reader.js"), "utf8");
const shell = fs.readFileSync(path.join(__dirname, "..", "reader-shell-state.js"), "utf8");
const notes = fs.readFileSync(path.join(__dirname, "..", "reader-notes-ui.js"), "utf8");
const annotations = fs.readFileSync(path.join(__dirname, "..", "reader-page-annotations.js"), "utf8");
const layout = fs.readFileSync(path.join(__dirname, "..", "reader-page-layout.js"), "utf8");
const settingsUi = fs.readFileSync(path.join(__dirname, "..", "reader-settings-ui.js"), "utf8");

test("reader toolbar buttons stay horizontal and do not flex-shrink", () => {
  assert.match(html, /\.tbtn\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(html, /\.tbtn\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
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

test("returning to the toolbar closes settings left open after a pointer exit", () => {
  assert.match(shell, /settingsPointerExited:\s*current\.overlay === OVERLAY\.SETTINGS/);
  assert.match(shell, /current\.overlay === OVERLAY\.SETTINGS && current\.settingsPointerExited/);
  assert.match(reader, /pointerenter[\s\S]*TOOLBAR_POINTER_ENTER/);
  assert.match(reader, /pointerleave[\s\S]*TOOLBAR_POINTER_LEAVE/);
  assert.match(notes, /ReaderShell\.isOverlay\(ReaderShell\.OVERLAY\.SETTINGS\)/);
});

test("reader settings selects shrink inside the settings panel", () => {
  assert.match(html, /\.settings \.row\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.settings select\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
});

test("center taps toggle the whole toolbar even while an overlay is closing", () => {
  assert.match(reader, /if \(e\.data\.centerTap\) toggleReaderToolbar\(\);/);
  assert.match(notes, /window\.toggleReaderToolbar\?\.\(\)/);
  assert.match(annotations, /if\(overlayOpen\)[\s\S]*parent\.postMessage\(\{centerTap:1\}/);
});

test("immersive mode hides and restores every toolbar child without ghost hit targets", () => {
  assert.match(html, /body\.immersive \.toolbar > \*\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(html, /body\.immersive\.bar-show \.toolbar > \*,\s*body\.immersive\.bar-hover \.toolbar > \*\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
});

test("immersive toolbar appears on hover and retracts when the pointer leaves", () => {
  assert.match(reader, /readerToolbar\?\.addEventListener\("pointerenter"[\s\S]*TOOLBAR_POINTER_ENTER/);
  assert.match(reader, /readerToolbar\?\.addEventListener\("pointerleave"[\s\S]*TOOLBAR_POINTER_LEAVE/);
  assert.match(shell, /bar-hover[\s\S]*TOOLBAR\.IMMERSIVE_HOVER/);
  assert.match(shell, /bar-show[\s\S]*TOOLBAR\.IMMERSIVE_PINNED/);
  assert.match(html, /body\.immersive\.bar-hover \.toolbar > \*\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
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
  assert.match(annotations, /Date\.now\(\)-macFastTap\.at<700/);
});

test("macOS WebKit switches ordinary chapters to batched geometry earlier", () => {
  assert.match(layout, /var IS_MAC_WEBKIT=.*AppleWebKit/);
  assert.match(layout, /FAST_CHAPTER_LAYOUT_CHARS=\(IS_MAC_WEBKIT\?16:120\)\*1024/);
});
