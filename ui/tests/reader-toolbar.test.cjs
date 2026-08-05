const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "reader.html"), "utf8");
const reader = fs.readFileSync(path.join(__dirname, "..", "reader.js"), "utf8");
const shell = fs.readFileSync(path.join(__dirname, "..", "reader-shell-state.js"), "utf8");
const notes = fs.readFileSync(path.join(__dirname, "..", "reader-notes-ui.js"), "utf8");
const annotations = fs.readFileSync(path.join(__dirname, "..", "reader-page-annotations.js"), "utf8");
const runtime = fs.readFileSync(path.join(__dirname, "..", "reader-page-runtime.js"), "utf8");
const layout = fs.readFileSync(path.join(__dirname, "..", "reader-page-layout.js"), "utf8");
const transition = fs.readFileSync(path.join(__dirname, "..", "reader-page-transition.js"), "utf8");
const pageStyle = fs.readFileSync(path.join(__dirname, "..", "reader-page-style.html"), "utf8");
const settingsUi = fs.readFileSync(path.join(__dirname, "..", "reader-settings-ui.js"), "utf8");
const searchUi = fs.readFileSync(path.join(__dirname, "..", "reader-search-ui.js"), "utf8");

test("reader toolbar buttons stay horizontal and do not flex-shrink", () => {
  assert.match(html, /\.tbtn\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(html, /\.tbtn\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
});

test("reader progress names the whole-book page total once it is measured", () => {
  assert.match(html, /id="reader-progress-group" data-tauri-drag-region/);
  assert.match(html, /id="chapter-progress" class="title epub-only"/);
  assert.match(html, /id="progress" class="title page-count-loading"/);
  assert.match(html, /\.reader-progress-group\s*\{[^}]*gap:\s*8px;[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /#progress\.page-count-total\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /#progress\.page-count-loading/);
  assert.match(reader, /function showWholeBookPages\(page, total\)/);
  assert.match(reader, /const text = page \+ "\/" \+ total \+ "页";/);
  assert.match(reader, /function showChapterProgress\(page, total, progress\)/);
  assert.match(reader, /showChapterProgress\(e\.data\.page, e\.data\.total, curProgress\)/);
  assert.match(reader, /else if \(pageCountMeasuring\)[\s\S]*?showProgressLoading\(\)/);
  assert.match(reader, /if \(e\.data\.pageCache\)/);
  assert.match(reader, /complete: !!pc\.complete/);
  assert.match(reader, /pageCountViewportWidth:\s*Math\.round\(document\.documentElement\.clientWidth/);
  assert.match(annotations, /if\(!sideTxn\)[\s\S]*?pageSig!==pageCountSig\(\)/);
});

test("reader toolbar supports narrow windows and macOS system fonts", () => {
  const toolbarRule = html.match(/\.toolbar\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(toolbarRule, /overflow-[xy]:\s*(?:auto|hidden)/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
  assert.match(html, /font-family:[^;]*-apple-system[^;]*"PingFang SC"/s);
});

test("reader settings dropdown is not clipped by the toolbar", () => {
  assert.match(html, /\.gear-wrap\s*\{[^}]*position:\s*relative;[^}]*flex:\s*0\s+0\s+auto;/s);
  assert.match(html, /\.settings\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*30;/s);
});

test("reader settings dropdown has no pointer gap below the toolbar", () => {
  assert.match(html, /\.settings\s*\{[^}]*top:\s*100%;/s);
  assert.doesNotMatch(html, /\.settings\s*\{[^}]*top:\s*calc\(100%\s*\+\s*8px\);/s);
});

test("整页翻页仅保留水平滑动动画，并迁移旧动画设置", () => {
  assert.match(html, /option value="horizontal">水平翻页（整页左移）<\/option>/);
  assert.doesNotMatch(html, /纸张效果（Google）|仿真翻页/);
  assert.match(settingsUi, /pageTurnEffect: "horizontal"/);
  assert.match(settingsUi, /\["google-paper", "curl"\]\.includes\(settings\.pageTurnEffect\)/);
  assert.match(transition, /return \/.*off\|horizontal.*test\(fx\)\?fx:'horizontal';/);
  assert.match(transition, /turnFxDuration\(360\)/);
  assert.match(transition, /captureTurnFxPage\('turn-fx-outgoing'\)[\s\S]*?move\(\);[\s\S]*?captureTurnFxPage\('turn-fx-incoming'\)/);
  assert.match(transition, /function beginChapterTurnFx[\s\S]*?captureTurnFxPage\('turn-fx-outgoing'\)[\s\S]*?return showChapter\(chapter,where\)\.then[\s\S]*?captureTurnFxPage\('turn-fx-incoming'\)/);
  assert.match(layout, /beginChapterTurnFx\(1,curCh\+1,'start'\)/);
  assert.match(layout, /beginChapterTurnFx\(-1,curCh-1,'end'\)/);
  assert.match(pageStyle, /#pager\.turn-fx-horizontal\.turn-fx-next[\s\S]*?turnFxHorizontalOutNext/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalOutNext[\s\S]*?translate3d\(-100%,0,0\)/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalInNext[\s\S]*?translate3d\(100%,0,0\)[\s\S]*?translate3d\(0,0,0\)/);
  assert.match(pageStyle, /@keyframes turnFxHorizontalOutPrev[\s\S]*?translate3d\(100%,0,0\)/);
  assert.doesNotMatch(pageStyle, /turn-fx-google-paper|turn-fx-curl|turn-fx-fold|turnFxGoogle|turnFxCurl/);
});

test("in-book search dropdown has no pointer gap below the toolbar", () => {
  assert.match(html, /\.rsearch\s*\{[^}]*top:\s*100%;/s);
  assert.doesNotMatch(html, /\.rsearch\s*\{[^}]*top:\s*calc\(100%\s*\+\s*8px\);/s);
});

test("in-book search remains open while the WebView briefly loses focus", () => {
  assert.doesNotMatch(searchUi, /window\.addEventListener\("(?:blur|mouseout)"[\s\S]*?toggleSearch\(false\)/);
  assert.match(searchUi, /window\.isReaderSearchEditing = function \(\)/);
  assert.match(searchUi, /rsearchEditingUntil = Date\.now\(\) \+ 1200/);
  assert.match(searchUi, /compositionstart/);
  assert.match(searchUi, /rsearchComposing \|\| rsearch\.contains\(document\.activeElement\)/);
  assert.match(reader, /function isSearchInputEditActive\(\)/);
  assert.match(reader, /if \(!isSearchInputEditActive\(\)\) ReaderShell\.closeOverlay\(\)/);
  assert.match(reader, /e\.isComposing \|\| e\.key === "Process" \|\| e\.keyCode === 229/);
  assert.match(annotations, /e\.isComposing\|\|e\.key==='Process'\|\|e\.keyCode===229/);
  assert.match(searchUi, /e\.key === "Escape"\) toggleSearch\(false\)/);
});

test("an open in-book search pins the immersive toolbar during IME pointer transitions", () => {
  assert.match(shell, /overlay === OVERLAY\.SEARCH && isImmersiveState\(current\.toolbar\)[\s\S]*?TOOLBAR\.IMMERSIVE_PINNED/);
  assert.match(shell, /current\.overlay === OVERLAY\.SEARCH && isImmersiveState\(current\.toolbar\)[\s\S]*?TOOLBAR\.IMMERSIVE_PINNED/);
});

test("智读提交携带实时已读位置、选区、锚点和本机会话记忆，并用 Enter 发起提问", () => {
  assert.match(reader, /currentChapter:\s*curChapter/);
  assert.match(reader, /currentFraction:\s*curChFrac/);
  assert.match(reader, /selectedText:\s*aiReaderSelectedText/);
  assert.match(reader, /selectedStart:\s*aiReaderSelectedAnchor\?\.start/);
  assert.match(reader, /selectedEnd:\s*aiReaderSelectedAnchor\?\.end/);
  assert.match(reader, /sessionMemory:\s*aiReaderSessionMemory\(\)/);
  assert.match(reader, /function aiReaderSessionMemoryKey\(\)/);
  assert.match(reader, /localStorage\.setItem\(aiReaderSessionMemoryKey\(\)/);
  const sessionMemoryBlock = reader.match(/function aiReaderRememberSession\(entry\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(sessionMemoryBlock, /private_sync_history_merge/);
  assert.match(reader, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229/);
  assert.match(reader, /event\.stopPropagation\(\);\s*runAiReader\("question"\)/s);
  assert.match(html, /id="ai-reader-enter-submit"[^>]*>↵ 回车提问<\/button>/);
  assert.match(reader, /getElementById\("ai-reader-enter-submit"\)\?\.addEventListener\("click", \(\) => runAiReader\("question"\)\)/);
});

test("智读历史可以删除，并将条目墓碑同步到其他设备", () => {
  assert.match(reader, /function aiReaderHistoryEntryId\(entry\)/);
  assert.match(reader, /private_sync_history_delete/);
  assert.match(reader, /删除这条智读记录/);
  assert.match(reader, /deletedAt/);
  assert.match(html, /\.ai-reader-history-delete\s*\{/);
});

test("智读显示检索阶段、证据材料类型与引用自检结果", () => {
  assert.match(reader, /function aiReaderStartProgress\(task\)/);
  assert.match(reader, /定位当前选句和邻近正文/);
  assert.match(reader, /混合检索已读内容/);
  assert.match(reader, /筛选并重排证据/);
  assert.match(reader, /生成回答并核对引用/);
  assert.match(reader, /source\?\.sourceKind/);
  assert.match(reader, /function aiReaderRenderMarkdown\(content, sources\)/);
  assert.match(reader, /function aiReaderAppendInline\(parent, value, sources\)/);
  assert.match(reader, /className = "ai-reader-citation"/);
  assert.match(reader, /function aiReaderJumpToSource\(source\)/);
  assert.doesNotMatch(reader, /citation\.title/);
  assert.match(reader, /answer\.retrievalStages/);
  assert.match(reader, /answer\.citationChecked/);
  assert.match(html, /id="ai-reader-audit"/);
  assert.doesNotMatch(html, /id="ai-reader-source-preview"/);
  assert.match(html, /\.ai-reader-answer h3 \{[^}]*font-size: 20px/s);
});

test("智读只切换书架中已配置的大模型，不在阅读页编辑密钥", () => {
  assert.match(html, /id="ai-reader-profile"/);
  assert.match(reader, /invoke\("ai_reader_profiles"\)/);
  assert.match(reader, /invoke\("select_ai_reader_profile", \{ id \}\)/);
  assert.doesNotMatch(html, /id="ai-reader-provider"|id="ai-reader-base-url"|id="ai-reader-api-key"/);
  assert.doesNotMatch(reader, /save_ai_reader_config/);
});

test("从选中文本打开智读时不再向问题框插入固定提问句", () => {
  assert.doesNotMatch(reader, /请结合已读内容解释这段文字/);
  assert.match(reader, /aiReaderQuestion\.value = String\(prefill\)\.trim\(\)\.slice\(0, 900\)/);
});

test("开关智读以覆盖层呈现，不压缩正文列宽或改变阅读位置", () => {
  assert.match(reader, /智读为覆盖层：不改变正文 iframe 宽度/);
  assert.doesNotMatch(reader, /preserveAnchor: 1/);
  assert.match(reader, /openAiReader\(request\.text \|\| "", \{[\s\S]*?start: request\.anchorStart/);
  assert.match(annotations, /aiReader:\{text:t,anchorStart:o&&o\.start,anchorEnd:o&&o\.end\}/);
  assert.match(annotations, /aiReader:\{text:highlightDisplayText\(h\),anchorStart:h\.start,anchorEnd:h\.end\}/);
  assert.doesNotMatch(html, /body\.ai-reader-open #frame\s*\{\s*width:/);
  assert.doesNotMatch(html, /body\.ai-reader-open #vbar\s*\{\s*right:/);
  assert.doesNotMatch(html, /body\.ai-reader-open \.book-progress\s*\{\s*right:/);
});

test("高亮菜单按真实高度避让页末：横排和九宫格都完整可见", () => {
  assert.match(annotations, /function visibleHighlightLineRects\(idx,fallbackEl\)/);
  assert.match(annotations, /function nearestHighlightRect\(rects,evt\)/);
  assert.match(annotations, /function highlightLineGroups\(rects\)/);
  assert.match(annotations, /function highlightMenuPlacement\(idx,fallbackEl,evt\)/);
  assert.match(annotations, /keys\.length>1[\s\S]*?highlightRectEnvelope\(groups\[keys\[0\]\]\),above:true/);
  assert.match(annotations, /lines\.length<=1[\s\S]*?nearestHighlightRect\(rects,evt\)/);
  assert.match(annotations, /var last=lines\[0\][\s\S]*?return \{rect:last,above:false\}/);
  assert.match(annotations, /highlightMenuPlacement\(idx,el,evt\)/);
  assert.match(annotations, /addEventListener\('mousemove',[\s\S]*?showHlMenu\(activeHi,false,m,e\)/);
  assert.match(annotations, /function readerViewportHeight\(\)/);
  assert.match(annotations, /function placeHighlightMenuVertically\(menu,rect,preferAbove\)/);
  assert.match(annotations, /Number\(menu&&menu\.offsetHeight\)\|\|34/);
  assert.match(annotations, /var canAbove=aboveTop>=safe,canBelow=belowTop\+mh<=vh-safe/);
  assert.match(annotations, /function repositionVisibleHighlightMenu\(menu\)/);
  assert.match(annotations, /placeHighlightMenuVertically\(menu,rect,!!menu\._menuPreferredAbove\)/);
  assert.match(annotations, /selMenu\._menuPreferredAbove=false[\s\S]*?repositionVisibleHighlightMenu\(selMenu\)/);
  assert.match(annotations, /refreshConfiguredMenus\(\)[\s\S]*?repositionVisibleHighlightMenu\(hlMenu\)/);
  assert.match(annotations, /hlMenu\._menuPreferredAbove=placement\.above[\s\S]*?repositionVisibleHighlightMenu\(hlMenu\)/);
});

test("returning to the toolbar closes settings left open after a pointer exit", () => {
  assert.match(shell, /settingsPointerExited:\s*current\.overlay === OVERLAY\.SETTINGS/);
  assert.match(shell, /current\.overlay === OVERLAY\.SETTINGS && current\.settingsPointerExited/);
  assert.match(reader, /pointerenter[\s\S]*TOOLBAR_POINTER_ENTER/);
  assert.match(reader, /pointerleave[\s\S]*TOOLBAR_POINTER_LEAVE/);
  assert.match(notes, /ReaderShell\.isOverlay\(ReaderShell\.OVERLAY\.SETTINGS\)/);
});

test("reader settings selects shrink inside the settings panel", () => {
  assert.match(html, /\.settings \.row\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.settings select\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
});

test("阅读设置提供三款按需下载并校验的开源中文字体", () => {
  assert.match(html, /data-reader-font-id="lxgw-wenkai-lite"[^>]*>霞鹜文楷 Lite/);
  assert.match(html, /data-reader-font-id="source-han-serif-sc"[^>]*>思源宋体/);
  assert.match(html, /data-reader-font-id="zhuque-fangsong"[^>]*>朱雀仿宋/);
  assert.match(html, /id="reader-font-download-status"/);
  assert.match(settingsUi, /invoke\("reader_font_status"\)/);
  assert.match(settingsUi, /invoke\("download_reader_font", \{ fontId: id \}\)/);
  assert.match(settingsUi, /下载后自动应用/);
  assert.match(layout, /@font-face\{font-family:"Kunpeng LXGW WenKai Lite"/);
  assert.match(layout, /reader:\/\/localhost\/font\/2\/SourceHanSerifSC-Regular\.otf/);
  assert.match(layout, /reader:\/\/localhost\/font\/3\/ZhuqueFangsong-Regular\.ttf/);
});

test("center taps reach the reader shell and hide the separate bottom progress", () => {
  assert.match(reader, /if \(e\.data\.centerTap\) \{\s*hideBookProgressAfterReadingAction\(\);\s*toggleReaderToolbar\(\);\s*\}/);
  assert.match(notes, /window\.toggleReaderToolbar\?\.\(\)/);
  assert.match(annotations, /if\(overlayOpen\)[\s\S]*parent\.postMessage\(\{centerTap:1\}/);
});

test("bottom progress hides independently after reading actions outside immersive mode", () => {
  assert.match(shell, /classList\.toggle\("reader-controls-visible", controlsVisible\)/);
  assert.match(html, /\.book-progress\s*\{[^}]*display:\s*none;[^}]*pointer-events:\s*none;/s);
  assert.match(html, /body\.reader-controls-visible \.book-progress\s*\{[^}]*display:\s*flex;[^}]*pointer-events:\s*auto;/s);
  assert.match(html, /body:not\(\.immersive\)\.book-progress-hidden \.book-progress\s*\{[^}]*display:\s*none;[^}]*pointer-events:\s*none;/s);
  assert.match(reader, /function hideBookProgressAfterReadingAction\(\)/);
  assert.match(reader, /if \(e\.data\.userNav\) \{[\s\S]*hideBookProgressAfterReadingAction\(\);/);
  assert.match(reader, /if \(e\.data\.centerTap\) \{\s*hideBookProgressAfterReadingAction\(\);\s*toggleReaderToolbar\(\);/);
  assert.match(reader, /hideBookProgressAfterReadingAction\(\);\s*ReaderShell\.dispatch\(\{ type: "HIDE_TOOLBAR" \}\);/);
});

test("immersive mode hides controls but keeps reading and page-count status visible", () => {
  assert.match(html, /body\.immersive \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(html, /body\.immersive\.bar-show \.toolbar > \*:not\(#reader-progress-group\),\s*body\.immersive\.bar-hover \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
  assert.match(html, /body\.immersive #reader-progress-group\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;/s);
  assert.match(html, /body\.immersive:not\(\.bar-show\):not\(\.bar-hover\) \.toolbar > \*:not\(#reader-progress-group\):not\(\.window-controls\)\s*\{[^}]*display:\s*none;/s);
  assert.match(html, /body\.immersive:not\(\.bar-show\):not\(\.bar-hover\) #reader-progress-group\s*\{[^}]*margin-left:\s*auto;/s);
});

test("immersive toolbar appears on hover and retracts when the pointer leaves", () => {
  assert.match(reader, /readerToolbar\?\.addEventListener\("pointerenter"[\s\S]*TOOLBAR_POINTER_ENTER/);
  assert.match(reader, /readerToolbar\?\.addEventListener\("pointerleave"[\s\S]*TOOLBAR_POINTER_LEAVE/);
  assert.match(shell, /bar-hover[\s\S]*TOOLBAR\.IMMERSIVE_HOVER/);
  assert.match(shell, /bar-show[\s\S]*TOOLBAR\.IMMERSIVE_PINNED/);
  assert.match(html, /body\.immersive\.bar-hover \.toolbar > \*:not\(#reader-progress-group\)\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
});

test("enabling scroll mode animates an active dual-page switch off", () => {
  assert.match(settingsUi, /const dualWasOn = !!dualModeToggle\?\.checked;/);
  assert.match(settingsUi, /READER_SHELL_IS_MAC_WEBKIT && scrollModeToggle\.checked && dualWasOn/);
  assert.match(settingsUi, /READER_SHELL_IS_MAC_WEBKIT[\s\S]*animateToggleOff\(dualModeToggle\);[\s\S]*refreshReadingModeToggles\(\)/);
  assert.doesNotMatch(settingsUi, /addEventListener\("animationend"/);
  assert.match(html, /@keyframes settings-switch-auto-off\s*\{[\s\S]*translateX\(18px\)[\s\S]*translateX\(0\)/);
  assert.match(html, /\.settings-switch\.auto-off \.settings-slider::before\s*\{[^}]*transition:\s*none;[^}]*animation:\s*settings-switch-auto-off[^;}]*both;/s);
});

test("macOS switch workaround does not run in Windows Chromium", () => {
  assert.match(settingsUi, /const READER_SHELL_IS_MAC_WEBKIT = \/Macintosh\|Mac OS X\//);
  assert.match(settingsUi, /!\/\(\?:Chrome\|Chromium\|Edg\)\\\/\//);
});

test("macOS WebKit uses a fast pointerup path without changing Chromium clicks", () => {
  assert.match(annotations, /isMacWebKit=IS_MAC_WEBKIT/);
  assert.match(annotations, /if\(isMacWebKit\)document\.addEventListener\('pointerup'/);
  assert.match(annotations, /Date\.now\(\)-macFastTap\.at<700/);
});

test("macOS WebKit switches ordinary chapters to batched geometry earlier", () => {
  assert.match(layout, /var IS_MAC_WEBKIT=.*AppleWebKit/);
  assert.match(transition, /FAST_CHAPTER_LAYOUT_CHARS=\(IS_MAC_WEBKIT\?16:120\)\*1024/);
});
