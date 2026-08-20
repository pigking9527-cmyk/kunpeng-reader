const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ui = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ui, name), "utf8");
const guard = read("generated-ts/browser-native-guard.js");
const styles = read("styles.css");
const index = read("index.html");
const reader = read("reader.html");
const pdf = read("pdfview.html");
const readerPage = read("generated-reader-page-ts/reader-page-runtime.js");

test("application surfaces suppress browser-native drag and incidental text selection", () => {
  assert.match(guard, /document\.addEventListener\([\s\S]*?"dragstart"[\s\S]*?event\.preventDefault\(\)[\s\S]*?true/);
  assert.match(guard, /document\.addEventListener\([\s\S]*?"selectstart"/);
  assert.match(guard, /input, textarea, \[contenteditable="true"\], \[data-native-selection\]/);
  assert.match(styles, /body,\s*body \*\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-drag:\s*none;/s);
  assert.match(styles, /input,\s*textarea,\s*\[contenteditable="true"\],\s*\[data-native-selection\]\s*\{[^}]*user-select:\s*text;/s);
  assert.match(index, /<script src="generated-ts\/browser-native-guard\.js"><\/script>[\s\S]*?<script src="generated-ts\/app\.js">/);
  assert.match(reader, /<script src="generated-ts\/browser-native-guard\.js"><\/script>[\s\S]*?<script src="generated-ts\/reader\.js">/);
});

test("functional reading selections remain available while native drag is disabled", () => {
  assert.match(pdf, /<body data-native-selection>/);
  assert.match(pdf, /<script src="generated-ts\/browser-native-guard\.js"><\/script>/);
  assert.match(readerPage, /addEventListener\("dragstart", \(event\) => event\.preventDefault\(\), true\)/);
  assert.doesNotMatch(readerPage, /addEventListener\('selectstart'/);
});
