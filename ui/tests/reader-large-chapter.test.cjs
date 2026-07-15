const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = [
  "reader-page-layout.js",
  "reader-page-annotations.js",
  "reader-page-runtime.js",
].map((name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")).join("");

test("large chapter layout threshold selects only large HTML", () => {
  const snippet = source.match(
    /var FAST_CHAPTER_LAYOUT_CHARS=.*?;\s*function largeChapterFastLayout\(html\)\{.*?\}/s
  );
  assert.ok(snippet, "large chapter layout helper must remain testable");
  const context = {};
  vm.runInNewContext(snippet[0], context);
  assert.equal(context.largeChapterFastLayout("x".repeat(120 * 1024 - 1)), false);
  assert.equal(context.largeChapterFastLayout("x".repeat(120 * 1024)), true);
});

test("large chapters use batched geometry and skip repeated exact layout", () => {
  assert.match(source, /function fastPagedPageCount\(el\)/);
  assert.match(source, /columnCountFromWidth\(el\.scrollWidth\|\|0,hasEnd\)/);
  assert.match(source, /function fastDocumentTextLineRects\(\)/);
  assert.match(source, /if\(fastChapterLayout\)return fastDocumentTextLineRects\(\)/);
  assert.match(
    source,
    /if\(fastChapterLayout\)\{\s*if\(!isScrollMode\(\)\)pagesInCh=fastPagedPageCount\(root\);\s*\}else\{\s*scrollBreakSig=''[\s\S]*?applyCols\(\);\s*\}/
  );
});
