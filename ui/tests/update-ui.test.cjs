const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const about = fs.readFileSync(path.join(__dirname, "..", "about-ui.js"), "utf8");

test("startup update check runs promptly without waiting for the reader window", () => {
  const marker = "// 更新检查只是轻量网络请求";
  const start = app.indexOf(marker);
  const end = app.indexOf('// “关于”里的版本号', start);
  assert.ok(start >= 0 && end > start, "startup update block must remain discoverable");
  const block = app.slice(start, end);

  assert.match(block, /startupTimed\("update-check", \(\) => aboutUI\.checkUpdate\(false\), "background"\)/);
  assert.match(block, /}, 2000\);/);
  assert.doesNotMatch(block, /runWhenNoReader/);
});

test("automatic checks respect an ignored release while manual checks bypass it", () => {
  assert.match(about, /if \(!force\) \{[\s\S]*?storage\.getItem\("ignoredUpdate"\)/);
  assert.match(about, /updateButton\.addEventListener\("click"[^]*?checkUpdate\(true\)/);
});
