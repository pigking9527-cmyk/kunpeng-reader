const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "generated-ts", "reader-preference-color-rules.js"), "utf8");
const readerHtml = fs.readFileSync(path.join(root, "reader.html"), "utf8");
const preferences = fs.readFileSync(path.join(root, "generated-ts", "reader-preferences-ui.js"), "utf8");

function rules() {
  const window = {};
  window.window = window;
  vm.runInNewContext(source, window);
  return window.ReaderPreferenceColorRules;
}

test("reader preference color rules normalize only CSS hex colors", () => {
  const color = rules();
  assert.ok(Object.isFrozen(color));
  assert.equal(color.normalizedHex(" #AbC "), "#aabbcc");
  assert.equal(color.normalizedHex("A1B2C3"), "#a1b2c3");
  assert.equal(color.normalizedHex("rgb(1, 2, 3)", "#abcdef"), "#abcdef");
  assert.equal(color.normalizedHex("#12", "#abcdef"), "#abcdef");
});

test("reader preference color rules convert canonical hex and bounded HSL", () => {
  const color = rules();
  assert.equal(JSON.stringify(color.hexToHsl("#ff0000")), JSON.stringify({ h: 0, s: 100, l: 50 }));
  assert.equal(JSON.stringify(color.hexToHsl("#808080")), JSON.stringify({ h: 0, s: 0, l: 50 }));
  assert.equal(color.hslToHex(120, 100, 50), "#00ff00");
  assert.equal(color.hslToHex(-120, 120, -5), "#000000");
  assert.equal(color.hslToHex(480, 100, 50), "#00ff00");
});

test("reader preference color rules calculate WCAG contrast ratios", () => {
  const color = rules();
  assert.equal(color.contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(color.contrastRatio("#ffffff", "#ffffff"), 1);
  assert.ok(color.contrastRatio("#777777", "#ffffff") < 4.5);
  assert.ok(color.contrastRatio("#595959", "#ffffff") >= 7);
});

test("reader preference UI loads color rules first and retains its standalone fallback", () => {
  assert.match(readerHtml, /reader-settings-ui\.js[\s\S]*?generated-ts\/reader-preference-color-rules\.js[\s\S]*?reader-preferences-ui\.js/);
  assert.match(preferences, /const colorRules = colorRulesFrom\(global\.ReaderPreferenceColorRules\)/);
  assert.match(preferences, /if \(colorRules\) return colorRules\.normalizedHex\(value, fallback\)/);
  assert.match(preferences, /if \(colorRules\) return colorRules\.hexToHsl\(value\)/);
  assert.match(preferences, /if \(colorRules\) return colorRules\.hslToHex\(hue, saturation, lightness\)/);
  assert.match(preferences, /if \(colorRules\) return colorRules\.contrastRatio\(foreground, background\)/);
});
