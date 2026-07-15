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

test("paged image preview is limited to the page immediately before the stable original", () => {
  const helper = source.match(/function pagedImageSourcePage\(.*?\n\}/s);
  assert.ok(helper, "paged image source-page helper must remain testable");
  const context = {};
  vm.runInNewContext(helper[0], context);
  assert.equal(context.pagedImageSourcePage({ left: -900 }, { left: -2000 }, 1000), 1);
  assert.equal(context.pagedImageSourcePage({ left: 2100 }, { left: 100 }, 1000), 2);
  assert.match(source, /if\(page!==current\+1\)continue/);
  assert.match(source, /logicalLeft=candidateRect\.left-rr\.left/);
  assert.match(source, /applyScrollImagePreview\(\);/);
  assert.match(source, /sizeVirtualPreviewClone\(clone,next\)/);
  assert.match(source, /if\(flowChanged\|\|pageModeChanged\)cancelPagedImagePreview\(\)/);
  assert.match(source, /function applyScrollPageMask\(\)\{\s*if\(typeof clearPagedImagePreview==='function'\)clearPagedImagePreview\(\)/);
  assert.doesNotMatch(source, /rr-paged-media-fitted|pagedMediaFitHeight/);
});
test("mode switches restore anchors inside the already inset scroll viewport", () => {
  assert.match(source, /x=Math\.max\(2,pr\.left\+8\)/);
  assert.match(source, /y=Math\.max\(2,pr\.top\+8\)/);
  assert.doesNotMatch(source, /pr\.left\+mg\(S\.marginLeft\)\+8/);
  assert.doesNotMatch(source, /pr\.top\+mg\(S\.marginTop\)\+8/);
  assert.match(source, /scrollOffset:8/);
  assert.match(source, /var imageAnchor=captureImageVisualAnchor\(\);[\s\S]*?if\(prevFlow==='scroll'\)/);
  assert.match(source, /relayout\([\s\S]*?scheduleImageVisualAnchorRestore\(imageAnchor\)/);
  assert.match(source, /scrollPagedView=!!imageAnchor/);
  assert.match(source, /exactScroll:flowChanged&&isScrollMode\(\)&&!imageAnchor/);
  assert.match(source, /box\._rrPreviewSource=candidate/);
  assert.match(source, /scrollPreview\._rrPreviewSource=src\|\|previewSourceElement\(next\.el\)/);
  assert.match(source, /Math\.round\(last\)\+imagePreviewGapPx\(\)/);
  assert.match(source, /Math\.round\(contentBottom-top\)\+imagePreviewGapPx\(\)/);
});
test("scroll mode previews an oversized image that starts inside the viewport", () => {
  const helper = source.match(/function scrollImagePreviewEligible\(.*?\n\}/s);
  assert.ok(helper, "scroll image preview eligibility helper must remain testable");
  const context = {};
  vm.runInNewContext(helper[0], context);
  const oversized = { top: 900, bottom: 1800 };
  const fitting = { top: 900, bottom: 1100 };
  const below = { top: 1300, bottom: 1800 };
  assert.equal(context.scrollImagePreviewEligible(oversized, { previewItem: oversized }, 4, 1200), true);
  assert.equal(context.scrollImagePreviewEligible(oversized, { previewIndex: 4 }, 4, 1200), true);
  assert.equal(context.scrollImagePreviewEligible(fitting, { previewItem: fitting }, 4, 1200), false);
  assert.equal(context.scrollImagePreviewEligible(below, { previewItem: null }, 4, 1200), true);
});