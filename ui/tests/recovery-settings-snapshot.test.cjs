const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "generated-ts", "recovery-settings-snapshot.js"), "utf8");
const main = fs.readFileSync(path.join(root, "index.html"), "utf8");
const reader = fs.readFileSync(path.join(root, "reader.html"), "utf8");

test("recovery snapshots both WebView origins without copying credentials", () => {
  assert.match(source, /function recoveryScope\(pathname\)[\s\S]*?pathname\.endsWith\("reader\.html"\) \? "reader" : "main"/);
  assert.match(source, /token\|password\|secret\|api_key\|apikey\|credential/i);
  assert.match(source, /recovery_web_settings_save/);
  assert.match(source, /recovery_web_settings_take_restored/);
  assert.match(source, /runtime\.location\.reload\(\)/);
  assert.match(main, /<script src="generated-ts\/recovery-settings-snapshot\.js"><\/script>/);
  assert.match(reader, /<script src="generated-ts\/recovery-settings-snapshot\.js"><\/script>/);
});
