const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = [
  "reader-page-layout.js",
  "reader-page-pagination.js",
  "reader-page-measurement.js",
  "reader-page-annotations.js",
  "reader-page-mode-switch.js",
  "reader-page-runtime.js",
  "reader-page-transition.js",
].map((name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")).join("");

test("large chapter layout threshold selects only large HTML", () => {
  const snippet = source.match(
    /var FAST_CHAPTER_LAYOUT_CHARS=.*?;\s*function largeChapterFastLayout\(html\)\{.*?\}/s
  );
  assert.ok(snippet, "large chapter layout helper must remain testable");
  const context = { IS_MAC_WEBKIT: false };
  vm.runInNewContext(snippet[0], context);
  assert.equal(context.largeChapterFastLayout("x".repeat(120 * 1024 - 1)), false);
  assert.equal(context.largeChapterFastLayout("x".repeat(120 * 1024)), true);
  const macContext = { IS_MAC_WEBKIT: true };
  vm.runInNewContext(snippet[0], macContext);
  assert.equal(macContext.largeChapterFastLayout("x".repeat(16 * 1024 - 1)), false);
  assert.equal(macContext.largeChapterFastLayout("x".repeat(16 * 1024)), true);
});

test("whole-book page counts are enabled and resume from incremental cache", () => {
  assert.match(source, /var fullBookMeasureEnabled=true;/);
  assert.match(source, /function pageCountSig\(\)\{[\s\S]*?S\.flowMode/);
  const pageCountSig = source.match(/function pageCountSig\(\)\{.*?\}/s)?.[0] || "";
  assert.doesNotMatch(pageCountSig, /S\.pageMode/);
  assert.match(source, /function pageCountFromMeasuredContent\(el\)/);
  assert.match(source, /return pageCountFromMeasuredContent\(measurer\);/);
  assert.match(source, /var progressPage=isDualPage\(\)&&!useScrollPagesForReport[\s\S]*?pageInCh\*2/);
  assert.match(source, /var displayPage=isDualPage\(\)\?Math\.floor\(Math\.max\(0,tp-dualStartColumn\)\/2\):tp/);
  assert.match(source, /function publishPageCache\(complete\)/);
  assert.match(source, /while\(i<CH&&chapterPages\[i\]>0\)i\+\+;/);
  assert.match(source, /if\(i%4===0\)publishPageCache\(false\)/);
  assert.match(source, /publishPageCache\(false\);\s*measureToken\+\+;/);
  assert.match(source, /measureDone=!!pc\.complete\|\|chapterPages\.every/);
  assert.match(source, /if\(!measureDone\)scheduleMeasure\(60\)/);
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

test("macOS preserves reader line height and renders only complete page lines", () => {
  const pagination = fs.readFileSync(path.join(__dirname, "..", "reader-page-pagination.js"), "utf8");
  assert.doesNotMatch(source, /function effectiveLineHeight\(/);
  assert.match(source, /line-height:'\+S\.lineHeight/);
  assert.match(source, /if\(IS_MAC_WEBKIT\)\{[\s\S]*?macVirtualPageForSlice\(virtualSlice\)[\s\S]*?renderVirtualScrollPage\(macPage\)/);
  assert.match(source, /function exactTextLineItemsForBand\(/);
  assert.match(source, /function macVirtualPageForSlice\([\s\S]*?exactTextLineItemsForBand\(top,top\+viewH\)/);
  assert.match(source, /function primaryCharacterRect\(rects\)[\s\S]*?score>bestScore/);
  assert.doesNotMatch(source, /for\(var ri=0;ri<rects\.length;ri\+\+\)\{\s*var r=rects\[ri\]/);
  assert.match(source, /var fits=IS_MAC_WEBKIT&&it\.type==='line'[\s\S]*?it\.bottom/);
  assert.match(source, /if\(scroller\)\{scroller\.style\.clipPath='none'/);
  assert.doesNotMatch(source, /var macBlank=currentScrollPageClipBlank\(\)/);
  assert.match(source, /root\.style\.overflow=''/);
  assert.match(pagination, /return \{top:top,bottom:bottom,left:pl\.l,right:pl\.r,height:usable\}/);
  assert.match(pagination, /function pagedBoxHeight\(\)\{\s*return viewportHeight\(\)/);
  assert.doesNotMatch(pagination, /whole=Math\.max\(1,whole-1\)/);
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
  assert.match(source, /function applyScrollPageMask\(force\)\{[\s\S]*?if\(typeof clearPagedImagePreview==='function'\)clearPagedImagePreview\(\)/);
  assert.doesNotMatch(source, /rr-paged-media-fitted|pagedMediaFitHeight/);
});
test("scroll image preview reflows through the virtual page instead of covering text", () => {
  assert.match(source, /var virtualSlice=activeScrollSliceAtTop\(maskTop\);/);
  assert.match(source, /function scrollPagePreviewCandidate\(slice,top,viewH\)\{/);
  assert.match(source, /var virtualPreview=virtualSlice\?scrollPagePreviewCandidate\(virtualSlice,maskTop,maskPort\?maskPort\.clientHeight:0\):null;/);
  assert.match(source, /if\(virtualSlice&&virtualPreview\)\{[\s\S]*?renderVirtualScrollPage\(virtualPageSlice\);[\s\S]*?return;/);
  assert.match(source, /function renderVirtualScrollPage\(pageOverride\)[\s\S]*?var preview=renderVirtualPreview\(page,viewH\);/);
  assert.match(source, /function buildVirtualPageFromIndex\([\s\S]*?if\(!fits\)\{[\s\S]*?previewIndex=i;/);
  assert.match(source, /function isInlineAuxiliaryImage\(el\)\{/);
  assert.match(source, /if\(overlapsText\(top,bottom\)&&!\(tag==='img'&&!isInlineAuxiliaryImage\(el\)\)\)continue;/);
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(style, /#virtual-page\{[^}]*background:var\(--reader-bg,#fff\)/);
  assert.match(style, /#scroll-preview\{[^}]*background:transparent/);
});
test("mode switches restore anchors inside the already inset scroll viewport", () => {
  assert.match(source, /function applyCols\(\)\{[\s\S]*?if\(isScrollMode\(\)\)\{\s*\/\/[\s\S]*?viewOffset=0;\s*var sb=scrollPageBox\(\)/);
  assert.match(source, /x=Math\.max\(2,pr\.left\+8\)/);
  assert.match(source, /y=Math\.max\(2,pr\.top\+8\)/);
  assert.doesNotMatch(source, /pr\.left\+mg\(S\.marginLeft\)\+8/);
  assert.doesNotMatch(source, /pr\.top\+mg\(S\.marginTop\)\+8/);
  assert.match(source, /scrollOffset:8/);
  assert.match(source, /var anchor=topAnchor\(\);[\s\S]*?var anchorOffset=anchorTextOffset\(anchor\);[\s\S]*?var imageAnchor=anchorOffset==null\?captureImageVisualAnchor\(\):null;[\s\S]*?if\(prevFlow==='scroll'\)/);
  assert.doesNotMatch(source, /if\(prevFlow==='scroll'\)[\s\S]{0,300}?var anchor=topAnchor\(\)/);
  assert.match(source, /relayout\([\s\S]*?scheduleImageVisualAnchorRestore\(imageAnchor\)/);
  assert.match(source, /scrollPagedView=!!imageAnchor/);
  assert.match(source, /exactScroll:flowChanged&&isScrollMode\(\)&&!imageAnchor/);
  assert.doesNotMatch(source, /forwardPagedAnchor/);
  assert.match(source, /box\._rrPreviewSource=candidate/);
  assert.match(source, /scrollPreview\._rrPreviewSource=src\|\|previewSourceElement\(next\.el\)/);
  assert.match(source, /Math\.round\(last\)\+imagePreviewGapPx\(\)/);
  assert.match(source, /Math\.round\(contentBottom-top\)\+imagePreviewGapPx\(\)/);
  assert.match(source, /function modeSwitchDiagBegin\(/);
  assert.match(source, /modeSwitchDiagLog\(modeDiagSeq,'after_relayout',anchorOffset\)/);
  assert.match(source, /modeSwitchDiagSchedule\(modeDiagSeq,anchorOffset\)/);
  assert.match(source, /modeSwitchDiagEvent\('resize_before'\)/);
  assert.match(source, /modeSwitchDiagEvent\('media_refresh'\)/);
});

test("single and dual page switches keep the viewport first line on the left page", () => {
  assert.doesNotMatch(source, /function pageModeAnchor\(\)/);
  assert.match(source, /var anchor=topAnchor\(\);/);
  assert.match(source, /function forceModeSwitchAnchorColumn\(offset,preserveLeadMedia\)/);
  assert.match(source, /function sourceAnchorRangeForOffset\(offset\)/);
  assert.match(source, /if\(at>=rec\.end&&i<recs\.length-1\)continue/);
  assert.match(source, /break-before:column !important/);
  assert.match(source, /forceAnchorColumn:incomingModeChange&&!isScrollMode\(\)/);
  assert.match(source, /var root,[\s\S]*?dualStartColumn=0/);
  assert.match(source, /function alignDualAnchorToLeftPage\(a\)/);
  assert.match(source, /dualStartColumn=physical%2/);
  assert.match(source, /viewOffset=pageInCh\*pageStep\+\(isDualPage\(\)\?dualStartColumn\*pageLayout\(\)\.colPitch:0\)/);
  assert.match(source, /alignDualAnchor:incomingModeChange&&isDualPage\(\)/);
  assert.match(source, /pageInCh\*2\+dualStartColumn/);
  assert.match(source, /dualStartColumn>0&&pageInCh===0/);
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

test("scroll paging reuses cached geometry and skips duplicate mask renders", () => {
  assert.match(source, /if\(!force&&maskSig===scrollMaskSig\)return/);
  assert.match(source, /var items=scrollPageItems\(\);/);
  const clip = source.match(/function currentScrollPageClipBlank\(\)[\s\S]*?\n\}/);
  assert.ok(clip, "scroll clipping helper must remain inspectable");
  assert.doesNotMatch(clip[0], /documentTextLineRects\(\)/);
});

test("highlight menus support a persisted three-column layout below the selection", () => {
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(source, /var HL_MENU_LAYOUT_KEY='highlightMenuLayoutV1'/);
  assert.match(source, /data-layout="row">横排<\/button><button type="button" data-layout="grid">九宫格/);
  assert.match(source, /function placeHighlightMenuVertically\(menu,rect,preferAbove\)/);
  assert.match(source, /var mh=Math\.min\(Math\.max\(Number\(menu&&menu\.offsetHeight\)\|\|34,1\)/);
  assert.match(source, /function repositionVisibleHighlightMenu\(menu\)/);
  assert.match(source, /repositionVisibleHighlightMenu\(selMenu\);[\s\S]*?repositionVisibleHighlightMenu\(hlMenu\);/);
  assert.match(source, /var safe=6,gap=6,vh=readerViewportHeight\(\);[\s\S]*?var aboveTop=rect\.top-mh-gap,belowTop=rect\.bottom\+gap/);
  assert.match(style, /\.hm-layout-grid \.hm-action-host[^\{]*\{display:grid;grid-template-columns:repeat\(3/);
});

test("highlight web search keeps a local Baidu or Google choice", () => {
  assert.match(source, /var HL_WEB_ENGINE_KEY='highlightWebSearchEngineV1'/);
  assert.match(source, /engines\.className='hs-mode-buttons hs-engine-buttons'/);
  assert.match(source, /\['baidu','google'\]\.forEach/);
  assert.match(source, /b\.textContent=engine==='google'\?'谷歌':'百度'/);
  assert.match(source, /webSearch:\{term:t,engine:readHlWebEngine\(\)\}/);
  assert.match(source, /webSearch:\{term:highlightDisplayText\(h\),engine:readHlWebEngine\(\)\}/);
});

test("highlight menu keeps appearance compact and supports persisted four-color highlights", () => {
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(source, /var HL_MENU_COLOR_KEY='highlightMenuMultiColorV1'/);
  assert.match(source, /var HL_COLORS=\[/);
  assert.match(source, /hs-mode hs-appearance/);
  assert.match(source, /hs-mode hs-layout-size/);
  assert.match(source, /hs-color-enabled/);
  assert.match(source, /o\.color=readHlColor\(\);parent\.postMessage\(\{addHighlight:o\}/);
  assert.match(source, /setHighlightColor:\{index:activeHi,color:color\}/);
  assert.match(style, /\.hs-appearance\{grid-template-columns:auto auto 1fr 38px/);
  assert.match(style, /\.hs-layout-size\{grid-template-columns:auto auto auto auto/);
  assert.match(style, /\.hm-color-host .hm-color-button/);
  assert.match(style, /var\(--hl-color,rgba\(255,218,92,.34\)\)/);
});
