const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const uiRoot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const source = fs.readFileSync(
  path.join(uiRoot, "generated-ts", "feedback-ui.js"),
  "utf8",
);

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
    assert.match(menu, new RegExp(`>\\s*${label}\\s*<`));
  }
  assert.doesNotMatch(menu, /[🎲➕🩺📝☑ℹ️]/u);
});

test("about exposes shared bug and feature feedback editor", () => {
  const aboutStart = html.indexOf('id="about-modal"');
  const about = html.slice(
    aboutStart,
    html.indexOf('id="feedback-modal"', aboutStart),
  );
  assert.doesNotMatch(about, /class="modal-head"/);
  assert.doesNotMatch(about, /about-hero|about-mark|about-product/);
  assert.match(about, /class="about-version-card"[\s\S]*?id="about-close"/);
  assert.doesNotMatch(about, /ℹ️/u);
  assert.match(html, /id="about-feedback-bug"[^>]*>[\s\S]*?提交 Bug/);
  assert.match(
    html,
    /id="about-feedback-feature"[^>]*data-i18n="suggestFeature"[^>]*>[\s\S]*?功能建议/,
  );
  assert.match(
    about,
    /id="about-github"[^>]*href="https:\/\/github\.com\/pigking9527-cmyk\/kunpeng-reader"/,
  );
  assert.match(about, /github\.com\/pigking9527-cmyk\/kunpeng-reader/);
  assert.match(html, /id="feedback-editor"[^>]*contenteditable="true"/);
  assert.match(html, /请写下 Bug 出现的步骤、操作、实际结果和期望结果/);
  assert.match(html, /id="feedback-image-input"[^>]*accept="image\/\*"/);
  assert.match(html, /问题记录（可选）/);
  assert.match(
    html,
    /id="feedback-attach-problem-trace"[^>]*data-i18n="attachTrace"[^>]*>[\s\S]*?附到本次反馈（推荐）/,
  );
  assert.match(
    html,
    /id="feedback-save-problem-trace"[^>]*data-i18n="saveTraceDesktop"[^>]*>[\s\S]*?保存问题记录到桌面/,
  );
  assert.match(html, /补充材料（可选）/);
  assert.match(html, /id="feedback-insert-image"[^>]*>[\s\S]*?添加截图/);
  assert.doesNotMatch(html, /id="feedback-json-input"/);
  assert.doesNotMatch(html, /id="feedback-insert-json"/);
  assert.match(html, /src="generated-ts\/feedback-ui\.js"/);
});

test("feedback images are compressed and submitted through the native command", () => {
  assert.match(source, /MAX_IMAGE_BYTES\s*=\s*1024\s*\*\s*1024/);
  assert.match(source, /addEventListener\("paste"/);
  assert.match(source, /addEventListener\("drop"/);
  assert.match(source, /invoke\("submit_feedback"/);
});

test("bug feedback accepts one bounded validated JSON attachment", () => {
  assert.match(source, /MAX_JSON_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /ReaderProblemTraceUI\?\.capture/);
  assert.match(source, /frozenProblemTrace/);
  assert.match(source, /freezeProblemTrace\(\)/);
  assert.match(source, /attachProblemTrace/);
  assert.match(source, /save_problem_trace_to_desktop/);
  assert.match(source, /TextEncoder\(\)\.encode/);
  assert.match(source, /mime:\s*"application\/json"/);
  assert.match(source, /attachments:/);
  assert.match(source, /kind !== "bug"/);
});
