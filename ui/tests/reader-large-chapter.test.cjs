const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = [
  require("./reader-page-test-source.cjs").compact,
  "generated-reader-page-ts/reader-page-mode-switch.js",
  "generated-reader-page-ts/reader-page-runtime.js",
  "generated-reader-page-ts/reader-page-transition.js",
].map((value) => value.endsWith?.(".js") ? fs.readFileSync(path.join(__dirname, "..", value), "utf8") : value).join("");
const readerPageSourceRoot = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "desktop-ui",
  "src",
  "legacy-ts",
  "reader-page-modules",
);
const runtimeSource = fs.readFileSync(path.join(readerPageSourceRoot, "reader-page-runtime.ts"), "utf8");

test("large chapter layout threshold selects only large HTML", () => {
  assert.match(source, /global\.FAST_CHAPTER_LAYOUT_CHARS = \(global\.IS_MAC_WEBKIT \? 4 : 120\) \* 1024/);
  assert.match(source, /function largeChapterFastLayout\(html\)[\s\S]*?String\(html \|\| ""\)\.length >= \(global\.FAST_CHAPTER_LAYOUT_CHARS/);
});

test("highlight menu keeps settings in the original reader without selection text", () => {
  const annotations = require("./reader-page-test-source.cjs").compact;
  const runtime = fs.readFileSync(path.join(__dirname, "..", "generated-reader-page-ts", "reader-page-runtime.js"), "utf8");
  assert.match(annotations, /window\.ReaderHighlightMenuSettings\s*=\s*Object\.freeze\(\{[\s\S]*?get:function\(\)[\s\S]*?update:function\(value\)/);
  assert.match(annotations, /actions:readHlMenuConfig\(\)\.map\(function\(item\)\{return\{key:item\.key,visible:item\.show!==false\}\}\)/);
  assert.doesNotMatch(annotations.match(/function highlightMenuPreferencesSnapshot\(\)\{[\s\S]*?\n\}/)?.[0] || "", /selectedText|chapterHtml|documentUrl/);
  assert.match(runtime, /readerHighlightMenuSettings/);
  assert.match(runtime, /api\.update\(menu\.settings\)/);
  assert.match(runtime, /readerHighlightMenuPreferencesReady: true/);
  assert.match(annotations, /showHlSettings\(menu\)/);
  assert.match(annotations, /showHlSettings\(hlMenu\)/);
  assert.match(annotations, /parent\.postMessage\(\{readerHighlightMenuPreferences:highlightMenuPreferencesSnapshot\(\)\}/);
  const reader = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader.js"), "utf8");
  assert.match(reader, /const READER_HIGHLIGHT_MENU_PREFERENCES_KEY = "readerHighlightMenuPreferencesV1";/);
  assert.match(reader, /const operation = preferences \? "update" : "get";/);
  assert.match(reader, /readerHighlightMenuSettings:\s*\{\s*requestId:\s*1,\s*operation,\s*settings:\s*preferences\s*\}/);
  assert.match(reader, /if \(e\.data\.readerHighlightMenuPreferencesReady\) \{\s*restoreHighlightMenuPreferences\(\);/);
  assert.match(reader, /requestId === 1/);
  assert.match(reader, /persistHighlightMenuPreferences\(e\.data\.readerHighlightMenuPreferences\)/);
  assert.doesNotMatch(reader, /frame\.addEventListener\("load", \(\) => \{[\s\S]*?restoreHighlightMenuPreferences/);
});

test("whole-book page counts are enabled and resume from incremental cache", () => {
  assert.match(source, /const fullBookMeasureEnabled=true/);
  assert.match(source, /function pageCountSig\(\)\{[\s\S]*?S\.flowMode/);
  const pageCountSig = source.match(/function pageCountSig\(\).*?\}/s)?.[0] || "";
  assert.doesNotMatch(pageCountSig, /S\.pageMode/);
  assert.match(source, /function pageCountFromMeasuredContent\(el\)/);
  assert.match(source, /return pageCountFromMeasuredContent\(measurer\)/);
  assert.match(source, /const progressPage=isDualPage\(\)&&!useScrollPagesForReport[\s\S]*?pageInCh\*2/);
  assert.match(source, /const displayPage=isDualPage\(\)\?Math\.floor\(Math\.max\(0,tp-dualStartColumn\)\/2\):tp/);
  assert.match(source, /function publishPageCache\(complete\)/);
  assert.match(source, /while\(i<CH&&\(chapterPages\[i\]\?\?0\)>0\)i\+\+/);
  assert.match(source, /if\(i%4===0\)publishPageCache\(false\)/);
  assert.match(source, /measureDone=!!pc\.complete\|\|chapterPages\.every/);
  assert.match(source, /if\(!measureDone\)scheduleMeasure\(60\)/);
});

test("large chapters use batched geometry and skip repeated exact layout", () => {
  assert.match(
    source,
    /body:not\(\.scroll-mode\):not\(\.line-paged-mode\) \.rr-end\{display:none !important[\s\S]*?body\.scroll-mode \.rr-end\{display:block !important[\s\S]*?break-before:auto !important/
  );
  assert.match(source, /function fastPagedPageCount\(el\)/);
  assert.match(source, /if\(isDualPage\(\)\)return fastDualPagedPageCount\(el\)/);
  assert.match(source, /const hasEnd=pagedEndOccupiesColumn\(el\)/);
  assert.match(source, /function pagedEndOccupiesColumn\(el\)[\s\S]*?end\.getClientRects\(\)/);
  assert.match(source, /columnCountFromWidth\(el\.scrollWidth\|\|0,hasEnd\)/);
  assert.match(source, /function fastDocumentTextLineRects\(\)/);
  assert.match(source, /if\(fastChapterLayout\)return fastDocumentTextLineRects\(\)/);
  assert.match(
    source,
    /waitForFlowResources\(\)\.then[\s\S]*?const performChapterLayout=function\(\)\{[\s\S]*?applyStyle\(\);applyCols\(\);[\s\S]*?const finishChapterLayout=function\(\)\{[\s\S]*?if\(fastChapterLayout\)\{[\s\S]*?if\(!isScrollMode\(\)\)pagesInCh=fastPagedPageCount\(root\)/
  );
});

test("macOS preserves reader line height and renders only complete page lines", () => {
  const pagination = require("./reader-page-test-source.cjs").compact;
  assert.doesNotMatch(source, /function effectiveLineHeight\(/);
  assert.match(source, /line-height:'\+S\.lineHeight/);
  assert.match(source, /if\(IS_MAC_WEBKIT\)\{[\s\S]*?macVirtualPageForSlice\(virtualSlice\)[\s\S]*?renderVirtualScrollPage\(macPage\)/);
  assert.match(source, /function exactTextLineItemsForBand\(/);
  assert.match(source, /function macVirtualPageForSlice\([\s\S]*?exactTextLineItemsForBand\(top,virtualExactBandBottomForSlice\(page,viewH\)\)[\s\S]*?buildVirtualPageFromIndex\(exact,0,viewH,top\+viewH,top\)/);
  assert.match(source, /function virtualExactBandBottomForSlice\([\s\S]*?virtualLineAdvanceCap[\s\S]*?verticalShift[\s\S]*?bandBottom=Math\.max/);
  assert.match(source, /function virtualExactBandTailProbePx\([\s\S]*?Math\.max\(lh,fontSize\)\+paragraphGap\+scrollGlyphSafePx\(\)\+2/);
  assert.match(source, /function primaryCharacterRect\(rects\)[\s\S]*?score>bestScore/);
  assert.doesNotMatch(source, /for\(var ri=0;ri<rects\.length;ri\+\+\)\{\s*var r=rects\[ri\]/);
  assert.match(source, /function virtualItemVisualBounds\(it\)[\s\S]*?it\.fragments[\s\S]*?fragment\.bottom/);
  assert.match(source, /const fitLimit=viewH-bottomGuard\+\.5[\s\S]*?renderedBottom<=fitLimit/);
  assert.match(source, /if\(scroller\)\{scroller\.style\.clipPath='none'/);
  assert.doesNotMatch(source, /var macBlank=currentScrollPageClipBlank\(\)/);
  assert.match(source, /root\.style\.overflow=''/);
  assert.match(pagination, /return\{top,bottom,left:pl\.l,right:pl\.r,height:usable\}/);
  assert.match(pagination, /function pagedBoxHeight\(\)\{return viewportHeight\(\)\}/);
  assert.doesNotMatch(pagination, /whole=Math\.max\(1,whole-1\)/);
});

test("paged image preview is limited to the page immediately before the stable original", () => {
  assert.match(source, /const pagedImageSourcePage = \(rect, rootRect, step\) =>/);
  assert.match(source, /page === current \+ 1/);
  assert.match(source, /hasPagedTextBeforeMedia\(lines, rootRect, step, current \+ 1, rect\.top\)/);
  assert.match(source, /immediatePagedImageAfterVisibleText: immediateImageAfterText/);
  assert.match(source, /hasPagedTextBetween:/);
  assert.match(source, /probePagedImageElement: probeImage/);
  assert.match(source, /pageBeforePagedImage: pageBeforeImage/);
  assert.match(source, /nextPagedImageByPrecedingContent/);
  assert.match(source, /image\.__kpPagedPreviewFromPage === current - 1/);
  assert.match(source, /hasPendingContinuousPagedImageSource/);
  assert.match(source, /continuousPagedImageSourceState/);
  assert.match(source, /g\.S\.imagePagination !== "continuous"/);
  assert.match(source, /if \(hasPendingContinuousPagedImageSource\(\)\)/);
  assert.match(source, /function stabilizeProgrammaticViewPaint\(\)/);
  assert.match(source, /pendingContinuous[\s\S]*?!pendingContinuous&&typeof refreshPagedImagePreview/);
  assert.match(source, /applyScrollPageMask\(true\)/);
  assert.match(source, /void root\.offsetWidth;[\s\S]*?root\.style\.transform='translateX\(-'/);
  assert.match(source, /refreshPagedImagePreview\(\);[\s\S]*?stabilizeProgrammaticViewPaint\(\)/);
  assert.match(source, /updateScrollPageAfterProgrammatic\(\);[\s\S]*?stabilizeProgrammaticViewPaint\(\)/);
  assert.match(source, /cropSource\(box, candidate, original - consumed\)/);
  assert.match(source, /__kpPagedOriginalHeight[\s\S]*?original - consumed/);
  assert.match(source, /candidate\.__kpPagedPreviewFromPage === current - 1/);
  assert.match(source, /if \(consumed < 32\)/);
  assert.match(source, /applyScrollImagePreview\(\);/);
  assert.match(source, /sizeVirtualPreviewClone\(clone,next\)/);
  assert.match(runtimeSource, /if \(flowChanged \|\| pageChanged \|\| layoutEngineChanged\) cancelPagedImagePreview\(\)/);
  assert.match(source, /function applyScrollPageMask\(force=false\)\{[\s\S]*?clearPagedImagePreview\(\)/);
  assert.doesNotMatch(source, /rr-paged-media-fitted|pagedMediaFitHeight/);
});
test("scroll image preview reflows through the virtual page instead of covering text", () => {
  assert.match(source, /const virtualSlice=activeScrollSliceAtTop\(maskTop\);/);
  assert.match(source, /if\(page&&\(scrollPagedView\|\|Math\.abs\(Math\.round\(page\.top\|\|0\)-top\)<=3\)\)return page/);
  assert.match(source, /function scrollPagePreviewCandidate\(slice,top,viewH\)\{/);
  assert.match(source, /const virtualPreview=virtualSlice\?scrollPagePreviewCandidate\(virtualSlice,maskTop,maskPort\?maskPort\.clientHeight:0\):null/);
  assert.match(source, /if\(virtualSlice&&virtualPreview\)\{[\s\S]*?renderVirtualScrollPage\(virtualPageSlice\);[\s\S]*?return;/);
  assert.match(source, /function renderVirtualScrollPage\(pageOverride\)[\s\S]*?const preview=renderVirtualPreview\(page,viewH\)/);
  assert.match(source, /function buildVirtualPageFromIndex\([\s\S]*?if\(!fits\)\{[\s\S]*?previewIndex=i/);
  assert.match(source, /function isInlineAuxiliaryImage\(el\)\{/);
  assert.match(source, /if\(overlapsText\(top,bottom\)&&!\(tag==='img'&&!isInlineAuxiliaryImage\(el\)\)\)continue;/);
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(style, /#virtual-page\{[^}]*background:var\(--reader-bg,#fff\)/);
  assert.match(style, /#scroll-preview\{[^}]*background:transparent/);
});
test("mode switches restore anchors inside the already inset scroll viewport", () => {
  assert.match(source, /function applyCols\(\)\{[\s\S]*?if\(isScrollMode\(\)\)[\s\S]*?viewOffset=0;const sb=scrollPageBox\(\)/);
  assert.match(source, /x=Math\.max\(2,pr\.left\+hm\.l\+8\)/);
  assert.match(source, /y=Math\.max\(2,pr\.top\+8\)/);
  assert.doesNotMatch(source, /pr\.left\+mg\(S\.marginLeft\)\+8/);
  assert.doesNotMatch(source, /pr\.top\+mg\(S\.marginTop\)\+8/);
  assert.match(source, /scrollOffset: 8/);
  assert.match(source, /let anchor = null;[\s\S]*?const offset = fn[\s\S]*?const imageAnchor = offset == null/);
  assert.match(source, /"relayout"[\s\S]*?"scheduleImageVisualAnchorRestore", imageAnchor/);
  assert.match(source, /g\.scrollPagedView = Boolean\(imageAnchor\)/);
  assert.match(source, /exactScroll: flowChanged && fn[\s\S]*?&& !imageAnchor/);
  assert.doesNotMatch(source, /forwardPagedAnchor/);
  assert.match(source, /box\._rrPreviewSource = candidate/);
  assert.match(source, /let src=previewSourceElement\(next\.el\)[\s\S]*?scrollPreview\._rrPreviewSource=src/);
  assert.match(source, /Math\.round\(last\) \+ fn\(g, "imagePreviewGapPx"\)/);
  assert.match(source, /Math\.round\(contentBottom-top\)\+imagePreviewGapPx\(\)/);
  assert.match(source, /function modeSwitchDiagBegin\(/);
  assert.match(source, /"modeSwitchDiagLog", diagnostics, "after_relayout", offset/);
  assert.match(source, /"modeSwitchDiagSchedule", diagnostics, offset/);
  assert.match(source, /modeSwitchDiagEvent\('resize_before'\)/);
  assert.match(source, /modeSwitchDiagEvent\('media_refresh'\)/);
});

test("single and dual page switches keep the viewport first line on the left page", () => {
  assert.doesNotMatch(source, /function pageModeAnchor\(\)/);
  assert.match(source, /let anchor = null/);
  assert.match(source, /const forceModeSwitchAnchorColumn = \(offset, preserveLeadMedia\) =>/);
  assert.match(source, /const sourceAnchorRangeForOffset = \(offset\) =>/);
  assert.match(source, /if \(at >= record\.end && index < records\.length - 1\) continue/);
  assert.match(source, /break-before:column !important/);
  assert.match(runtimeSource, /forceAnchorColumn: \(flowChanged \|\| pageChanged\) && !fn<boolean>\(g, "isScrollMode"\)/);
  assert.match(source, /let root,[\s\S]*?dualStartColumn=0/);
  assert.match(source, /function alignDualAnchorToLeftPage\(a\)/);
  assert.match(source, /dualStartColumn=physical%2/);
  assert.match(source, /viewOffset=pageInCh\*pageStep\+\(isDualPage\(\)\?dualStartColumn\*pageLayout\(\)\.colPitch:0\)/);
  assert.match(source, /alignDualAnchor: changingMode && fn\(g, "isDualPage"\)/);
  assert.match(source, /pageInCh\*2\+dualStartColumn/);
  assert.match(source, /dualStartColumn>0&&pageInCh===0/);
});
test("scroll mode previews an oversized image that starts inside the viewport", () => {
  const helperStart = source.indexOf("function scrollImagePreviewEligible(");
  const helperEnd = source.indexOf("function scrollPagePreviewCandidate(", helperStart);
  const helper = helperStart >= 0 && helperEnd > helperStart ? source.slice(helperStart, helperEnd) : "";
  assert.ok(helper, "scroll image preview eligibility helper must remain testable");
  const context = {};
  vm.runInNewContext(helper, context);
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
  assert.match(source, /const items=scrollPageItems\(\)/);
  const clipStart = source.indexOf("function currentScrollPageClipBlank(");
  const clipEnd = source.indexOf("function buildScrollBreaks(", clipStart);
  const clip = clipStart >= 0 && clipEnd > clipStart ? source.slice(clipStart, clipEnd) : "";
  assert.ok(clip, "scroll clipping helper must remain inspectable");
  assert.doesNotMatch(clip, /documentTextLineRects\(\)/);
});

test("highlight menus support a persisted three-column layout below the selection", () => {
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(source, /const HL_MENU_LAYOUT_KEY='highlightMenuLayoutV1'/);
  assert.match(source, /data-layout='row'>'\+readerPageText\('row'\)\+'<\/button><button type='button' data-layout='grid'>'\+readerPageText\('grid'\)/);
  assert.match(source, /function placeHighlightMenuVertically\(menu,rect,preferAbove\)/);
  assert.match(source, /const mh=Math\.min\(Math\.max\(Number\(menu&&menu\.offsetHeight\)\|\|34,1\)/);
  assert.match(source, /function repositionVisibleHighlightMenu\(menu\)/);
  assert.match(source, /repositionVisibleHighlightMenu\(selMenu\);repositionVisibleHighlightMenu\(hlMenu\)/);
  assert.match(source, /const safe=6,gap=6,vh=readerViewportHeight\(\);[\s\S]*?const aboveTop=rect\.top-mh-gap,belowTop=rect\.bottom\+gap/);
  assert.match(style, /\.hm-layout-grid \.hm-action-host[^\{]*\{display:grid;grid-template-columns:repeat\(3/);
});

test("highlight web search keeps a local Baidu or Google choice", () => {
  assert.match(source, /const HL_WEB_ENGINE_KEY='highlightWebSearchEngineV1'/);
  assert.match(source, /engines\.className='hs-mode-buttons hs-engine-buttons'/);
  assert.match(source, /\['baidu','google'\]\.forEach/);
  assert.match(source, /b\.textContent=engine==='google'\?readerPageText\('searchEngineGoogle'\):readerPageText\('searchEngineBaidu'\)/);
  assert.match(source, /webSearch:\{term:t,engine:readHlWebEngine\(\)\}/);
  assert.match(source, /webSearch:\{term:highlightDisplayText\(h\),engine:readHlWebEngine\(\)\}/);
});

test("highlight menu starts with the product defaults for new readers", () => {
  assert.match(source, /function readHlMenuMode\(\)\{[\s\S]*?\?m:'text'\}/);
  assert.match(source, /function readHlMenuLayout\(\)\{[\s\S]*?s==='row'\?'row':'grid'\}/);
  assert.match(source, /function readHlMenuSize\(\)\{[\s\S]*?\?s:'medium'\}/);
  assert.match(source, /function readHlWebEngine\(\)\{[\s\S]*?\?'google':'baidu'\}/);
});

test("highlight menu keeps appearance compact and supports persisted four-color highlights", () => {
  const style = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
  assert.match(source, /const HL_MENU_COLOR_KEY='highlightMenuMultiColorV1'/);
  assert.match(source, /const HL_COLORS=\[/);
  assert.match(source, /hs-mode hs-appearance/);
  assert.match(source, /hs-mode hs-layout-size/);
  assert.match(source, /hs-color-enabled/);
  assert.match(source, /o\.color=readHlColor\(\);parent\.postMessage\(\{addHighlight:o\}/);
  assert.match(source, /setHighlightColor:\{index:activeHi,color\}/);
  assert.match(style, /\.hs-appearance\{grid-template-columns:auto auto 1fr 38px/);
  assert.match(style, /\.hs-layout-size\{grid-template-columns:auto auto auto auto/);
  assert.match(source, /function hlActionIconMarkup\(key\)/);
  assert.match(source, /web:'<svg viewBox=/);
  assert.match(style, /\.hm-color-host .hm-color-button/);
  assert.match(style, /var\(--hl-color,rgba\(126,136,148,.34\)\)/);
  assert.match(source, /hlMenuPreferencesSynced=false/);
  assert.match(source, /if\(hlMenuPreferencesRestoring\|\|!hlMenuPreferencesSynced\)return/);
});
