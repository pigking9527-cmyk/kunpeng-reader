const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const uiRoot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const source = fs.readFileSync(path.join(uiRoot, "feedback-ui.js"), "utf8");

test("main menu keeps labels but removes decorative icons", () => {
  const menu = html.slice(
    html.indexOf('id="menu" class="menu"'),
    html.indexOf('class="window-controls"'),
  );
  for (const label of [
    "随机打开一本书",
    "导入书籍",
    "书库体检",
    "笔记汇总",
    "全选（批量删除）",
    "关于",
  ]) {
    assert.match(menu, new RegExp(`>${label}<`));
  }
  assert.doesNotMatch(menu, /[🎲➕🩺📝☑ℹ️]/u);
});

test("about exposes shared bug and feature feedback editor", () => {
  assert.match(html, /id="about-feedback-bug"[^>]*>提交 Bug</);
  assert.match(html, /id="about-feedback-feature"[^>]*>功能提议</);
  assert.match(html, /id="feedback-editor"[^>]*contenteditable="true"/);
  assert.match(html, /id="feedback-image-input"[^>]*accept="image\/\*"/);
  assert.match(html, /src="feedback-ui\.js"/);
});

test("feedback images are compressed and submitted through the native command", () => {
  assert.match(source, /MAX_IMAGE_BYTES\s*=\s*1024\s*\*\s*1024/);
  assert.match(source, /addEventListener\("paste"/);
  assert.match(source, /addEventListener\("drop"/);
  assert.match(source, /invoke\("submit_feedback"/);
});
