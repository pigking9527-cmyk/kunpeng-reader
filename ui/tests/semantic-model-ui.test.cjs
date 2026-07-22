const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const semanticUi = fs.readFileSync(path.join(root, "semantic-ui.js"), "utf8");

test("semantic model picker offers only the two supported BGE models", () => {
  assert.match(html, /value="bge-small-zh-v1\.5">BGE Small 中文（默认，轻量）/);
  assert.match(html, /value="bge-large-zh-v1\.5">BGE Large 中文（高精度）/);
  assert.doesNotMatch(html, /完整语义检索|GPU 加速组件|一键启用/);
});

test("model picker explains both BGE choices and reads the normal task status", () => {
  assert.match(semanticUi, /轻量语义检索 · BGE Small 中文/);
  assert.match(semanticUi, /高精度语义检索 · BGE Large 中文/);
  assert.match(semanticUi, /invoke\("semantic_tasks"\)/);
  assert.doesNotMatch(semanticUi, /GPU 加速组件/);
});
