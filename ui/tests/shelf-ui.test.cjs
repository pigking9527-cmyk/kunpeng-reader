const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "shelf-ui.js"), "utf8");
const rulesSource = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "shelf-ui-rules.js"),
  "utf8",
);
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const settingsLayout = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "settings-layout-ui.js"),
  "utf8",
);
const appShell = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
const appI18n = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app-i18n.js"), "utf8");
const animationSettings = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "animation-settings-ui.js"),
  "utf8",
);
const semanticSettings = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "semantic-ui.js"), "utf8");
const organizationEditor = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "book-info-organization.js"), "utf8");

test("common settings use a categorized wide layout with a live shelf preview", () => {
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*width:\s*min\(920px,\s*calc\(100vw - 48px\)\);/s);
  assert.match(styles, /\.fp-set-row \{[^}]*font-size:\s*16px;/s);
  assert.match(html, /data-settings-section="basic"[\s\S]*data-settings-section="toolbar"[\s\S]*data-settings-section="shelf"[\s\S]*data-settings-section="reading"[\s\S]*data-settings-section="smart"[\s\S]*data-settings-section="data"/);
  assert.match(html, /data-settings-panel="basic"[\s\S]*data-settings-panel="toolbar"[^>]*hidden[\s\S]*data-settings-panel="shelf"[^>]*hidden[\s\S]*data-settings-panel="data"[^>]*hidden/);
  assert.match(html, /id="fp-shelf-preview-title"[\s\S]*id="fp-shelf-preview-progress"[\s\S]*id="fp-shelf-preview-rating"/);
  assert.match(html, /src="generated-ts\/settings-layout-ui\.js"/);
  assert.match(settingsLayout, /const STORAGE_KEY = "commonSettingsSectionV1"/);
  assert.match(settingsLayout, /const activateSection = \(id, persist = true\) =>/);
  assert.match(settingsLayout, /const syncShelfPreview = \(\) =>/);
  assert.doesNotMatch(html, /id="fp-settings-close"/);
  assert.doesNotMatch(html, /class="modal-head fp-settings-head"/);
  assert.match(styles, /\.fp-settings-content\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.fp-settings-nav\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test("common settings navigation can collapse to icons with the reader-preferences behavior", () => {
  assert.match(html, /id="fp-settings-nav-toggle"/);
  assert.match(html, /class="fp-settings-nav-icon"/);
  assert.match(html, /class="fp-settings-nav-label"/);
  assert.match(settingsLayout, /const NAV_COLLAPSED_KEY = "commonSettingsNavCollapsedV1"/);
  assert.match(settingsLayout, /const applyNavState = \(\) =>/);
  assert.match(settingsLayout, /navToggle\?\.addEventListener\("click"/);
  assert.match(styles, /\.fp-settings-card\.nav-collapsed \.fp-settings-layout\s*\{[^}]*grid-template-columns:\s*62px/s);
  assert.match(styles, /\.fp-settings-card\.nav-collapsed \.fp-settings-nav-label\s*\{[^}]*clip-path:\s*inset\(50%\)/s);
  assert.match(styles, /\.fp-settings-card\.nav-collapsed \.fp-settings-nav-toggle\s*\{[^}]*left:\s*62px/s);
  assert.match(styles, /\.fp-settings-card:not\(\.nav-collapsed\) \.fp-settings-nav-icon\s*\{\s*display:\s*none;/);
  assert.match(appI18n, /settingsCollapseNavigation: "收起分类"/);
  assert.match(appI18n, /settingsExpandNavigation: "展开分类"/);
});

test("every common-settings child page leaves the common settings visible", () => {
  assert.doesNotMatch(settingsLayout, /modal\.classList\.remove\("show"\)/);
  assert.doesNotMatch(animationSettings, /commonSettingsModal\?\.classList\.remove\("show"\)/);
  assert.doesNotMatch(semanticSettings, /settingsModal\?\.classList\.remove\("show"\)/);
  const dictionaryOpen = appShell.slice(appShell.indexOf("function openExternalDictSettings"), appShell.indexOf("function closeExternalDictSettings"));
  assert.doesNotMatch(dictionaryOpen, /fpSettingsModal\.classList\.remove\("show"\)/);
});

test("all common-settings child pages share the compact detail design system", () => {
  const childIds = [
    "startup-enhancement-modal",
    "animation-settings-modal",
    "import-dirs-modal",
    "gesture-settings-modal",
    "reader-recommendation-settings-modal",
    "external-dict-modal",
    "newsnow-settings-modal",
    "semantic-index-modal",
    "api-settings-modal",
  ];
  for (const id of childIds) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?class="modal settings-detail-modal"[\\s\\S]*?<div[\\s\\S]*?class="modal-card settings-detail-card`));
  }
  assert.match(styles, /\.settings-detail-modal\s*\{[^}]*backdrop-filter:\s*blur\(4px\)[^}]*\}/s);
  assert.match(styles, /\.settings-detail-card\s*\{[^}]*border-radius:\s*18px;[^}]*box-shadow:/s);
  assert.match(styles, /\.settings-detail-card > \.modal-head\s*\{[^}]*position:\s*sticky;[^}]*backdrop-filter:\s*blur\(12px\)/s);
  assert.match(styles, /\.api-settings-section\s*\{[^}]*border-radius:\s*13px;[^}]*background:\s*#f8fafd;/s);
  assert.match(styles, /\.semantic-card \.sem-section\s*\{[^}]*border-radius:\s*12px;/s);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.settings-detail-card\s*\{[^}]*max-width:\s*calc\(100vw - 24px\)/s);
});

test("book card clicks explicitly close main-window floaters", () => {
  const helper = source.match(/function closeShelfCardFloaters\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(helper, "shelf floater closer must remain explicit");
  assert.match(helper[1], /menuElement\.classList\.remove\("show"\)/);
  assert.match(helper[1], /filterPanelElement\.classList\.remove\("show"\)/);
  assert.match(helper[1], /closeAccount\(\)/);
  assert.match(helper[1], /closeShelfSearch\(false\)/);

  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /addEventListener\("click",[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.match(card, /addEventListener\("dblclick",[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.match(card, /if \(e\.metaKey \|\| e\.ctrlKey \|\| selected\.size > 0\)[\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.doesNotMatch(card, /openTimer|220/);
  assert.match(card, /if \(e\.metaKey \|\| e\.ctrlKey \|\| selected\.size > 0\)/);
  assert.match(card, /if \(e\.detail > 1\) return;[\s\S]*?openBook\("single"\)/);
  assert.match(card, /tauriApi\.invoke\("prewarm_book", \{ id: b\.id \}\)/);
  assert.match(card, /let selectionTimer = null/);
  assert.match(card, /if \(!singleClickOpensBook\) \{[\s\S]*?selectionTimer = setTimeout\([\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.match(card, /selectionTimer = setTimeout\([\s\S]*?\}, 180\)/);
  assert.match(card, /clearTimeout\(selectionTimer\)[\s\S]*?restoreDeferredSelection\(\)[\s\S]*?openBook\("double"\)/);
  assert.match(card, /addEventListener\("contextmenu"/);
  assert.match(card, /addEventListener\("contextmenu",[\s\S]*?e\.preventDefault\(\)[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.doesNotMatch(card, /openBookOrganizer/);
});

test("first shelf click retries a reader window that is still closing", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /let openingBook = false/);
  assert.match(card, /message\.includes\("阅读窗口仍在关闭"\) && retry < 3/);
  assert.match(card, /setTimeout\(\(\) => attemptOpen\(retry \+ 1\), 180\)/);
  assert.match(card, /openingBook = false;[\s\S]*?alertAction\("打开失败：" \+ message\)/);
});
test("shelf covers cannot trigger native browser drag selection", () => {
  assert.match(source, /shelfEl\.addEventListener\("dragstart", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(source, /shelfEl\.addEventListener\("selectstart", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(source, /img\.draggable = false/);
  assert.match(styles, /\.shelf\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-select:\s*none;/s);
  assert.match(styles, /\.shelf \*\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-select:\s*none;/s);
  assert.match(styles, /\.shelf img\s*\{[^}]*-webkit-user-drag:\s*none;/s);
});

test("shelf assigns every cover URL and lets only non-first-screen images use native lazy loading", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  const i18n = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app-i18n.js"), "utf8");
  const coverRulesPosition = html.indexOf('src="generated-ts/shelf-cover-loading-rules.js"');
  const shelfPosition = html.indexOf('src="generated-ts/shelf-ui.js"');
  assert.match(source, /const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24/);
  assert.match(source, /const coverRulesCandidate = global\.ReaderShelfCoverLoadingRules/);
  assert.match(source, /function estimateFirstScreenCoverCount\(\)/);
  assert.match(source, /coverLoadingRules\.firstScreenCoverCount\(/);
  assert.match(card, /coverLoadingRules\.coverLoadPriority\(index, firstScreenCoverCount\)/);
  assert.match(card, /img\.loading = coverPriority\.loading/);
  assert.match(card, /img\.decoding = coverPriority\.decoding/);
  assert.match(card, /img\.fetchPriority = coverPriority\.fetchPriority/);
  assert.ok(coverRulesPosition >= 0 && coverRulesPosition < shelfPosition);
  assert.match(card, /img\.src = b\.cover/);
  assert.doesNotMatch(card, /dataset\.coverSrc/);
  assert.doesNotMatch(source, /shelfCoverOnDemand|coverOnDemand|coverObserver|activateDeferredCovers|IntersectionObserver/);
  assert.doesNotMatch(html, /id="set-cover-on-demand"/);
  assert.doesNotMatch(i18n, /COVER_ON_DEMAND_COPY|coverOnDemand/);
});

test("shelf opening preference switches between single-click opening and double-click opening", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(html, /id="set-single-click-open"/);
  assert.match(html, /id="set-open-book-label"[^>]*>单击打开图书/);
  assert.match(source, /shelfSingleClickOpen/);
  assert.match(source, /function setSingleClickOpenPreference\(value\)/);
  assert.match(card, /if \(!singleClickOpensBook\)[\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.match(card, /if \(!singleClickOpensBook\) \{[\s\S]*?openBook\("double"\);[\s\S]*?return;/);
  assert.match(source, /reflectOpenBookPreference/);
  assert.match(source, /setSingleClickOpenPreference\(setSingleClickOpen\.checked\)/);
  assert.match(source, /"单击打开图书" : "双击打开图书"/);
});

test("book information opens organization management on demand and right click opens no organizer", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
  const info = html.slice(html.indexOf('id="book-info-modal"'), html.indexOf('id="book-organization-modal"'));
  const manager = html.slice(html.indexOf('id="book-organization-modal"'), html.indexOf('id="booklist-modal"'));
  assert.doesNotMatch(info, /id="book-info-tags-manage"/);
  assert.doesNotMatch(info, /id="book-info-collections-manage"/);
  assert.doesNotMatch(info, /id="book-info-tags"|id="book-info-collections"/);
  assert.match(manager, /id="book-info-tags" class="book-info-organization-editor"/);
  assert.match(manager, /id="book-info-collections"[\s\S]*?class="book-info-organization-editor"/);
  assert.match(manager, /role="tablist"/);
  assert.match(html, /src="generated-ts\/book-info-panel\.js"[\s\S]*?src="generated-ts\/book-info-organization\.js"/);
  assert.match(app, /ReaderBookInfoPanel\.mount\([\s\S]*?prefix: "book-info"[\s\S]*?ReaderBookOrganizationUI\.init\(/);
  assert.doesNotMatch(html, /id="batch-tag-btn"|id="batch-collection-btn"|id="batch-organization-modal"|id="book-organizer-menu"/);
  assert.match(organizationEditor, /invoke\("set_book_organization"/);
  assert.match(organizationEditor, /invoke\("rename_book_organization"/);
  assert.match(organizationEditor, /invoke\("delete_book_organization"/);
  assert.match(organizationEditor, /openBooklist\?\.\(entry\.name\)/);
  assert.match(organizationEditor, /showInlineRename\s*=/);
  assert.match(organizationEditor, /remove\.textContent = "确认删除"/);
  assert.match(organizationEditor, /openManager\s*=\s*\(field\)/);
  assert.match(organizationEditor, /infoModal\?\.classList\.remove\("show"\)/);
  assert.match(organizationEditor, /closeManager\s*=\s*\(\)[\s\S]*?infoModal\?\.classList\.add\("show"\)/);
  assert.match(organizationEditor, /renderSummary\(tagSummary, book\?\.tags\)/);
  assert.doesNotMatch(organizationEditor, /global\.prompt|global\.confirm/);
});

test("book information uses a compact identity, author row, organization controls and description layout", () => {
  const info = html.slice(html.indexOf('id="book-info-modal"'), html.indexOf('id="book-organization-modal"'));
  const panel = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "book-info-panel.js"), "utf8");
  const panelStyles = fs.readFileSync(path.join(__dirname, "..", "book-info-panel.css"), "utf8");
  assert.match(info, /^id="book-info-modal"[\s\S]*?class="modal"[\s\S]*?><\/div>/);
  assert.match(panel, /id="\$\{ids\.cover\}" class="book-info-cover"/);
  assert.match(panel, /class="book-info-cover-stack"[\s\S]*?data-book-info-action="cover"/);
  assert.match(panel, /class="book-info-hero"/);
  assert.match(panel, /class="book-info-primary"/);
  assert.match(panel, /class="book-info-author-field"/);
  assert.match(panel, /class="book-info-facts"/);
  assert.match(panel, /class="book-info-organization-grid"/);
  assert.doesNotMatch(panel, /<h3>整理<\/h3>|<span>标签与书单<\/span>/);
  assert.match(panel, /class="book-info-section book-info-description"/);
  assert.match(panelStyles, /\.book-info-facts \{ display:grid; grid-template-columns:repeat\(4,/);
  assert.match(panelStyles, /\.book-info-organization-grid \{ display:grid; grid-template-columns:repeat\(2,/);
});

test("book information keeps its cover current and opens shared related information above itself", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
  const related = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "book-info-related.js"), "utf8");
  assert.match(app, /window\.ReaderBookInfoRelated\.mount\(\{/);
  assert.match(app, /bookInfoRelated\.openSimilar\(currentInfoBookId, shelfUI\.getBook\(currentInfoBookId\)\)/);
  assert.match(app, /bookInfoRelated\.openTimeline\(currentInfoBookId\)/);
  assert.match(app, /await shelfUI\.changeCoverById\(currentInfoBookId\);[\s\S]*?bookInfoPanel\.renderCover\(shelfUI\.getBook\(currentInfoBookId\)\)/);
  assert.match(related, /id="reading-timeline-modal"[\s\S]*?data-overlay-role="information"/);
  assert.match(related, /id="similar-books-modal"[\s\S]*?data-overlay-role="information"/);
  assert.doesNotMatch(app, /function openReadingTimeline|function renderSimilarBooks/);
});

test("startup shelf can receive keyboard paging focus without stealing it on refresh", () => {
  assert.match(source, /function focusShelf\(\)[\s\S]*?contentEl\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /focusShelf,/);
  assert.match(html, /<div class="content" tabindex="-1">/);
  const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
  assert.match(app, /shelfUI\.render\(list\);[\s\S]*?requestAnimationFrame\(\(\) => shelfUI\.focusShelf\(\)\)/);
});

test("opening a book immediately updates recent-reading order without waiting for window focus", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
  const windows = fs.readFileSync(path.join(__dirname, "..", "..", "src", "window_commands.rs"), "utf8");
  assert.match(windows, /main\.emit\(\s*"shelf-book-read"/s);
  assert.match(windows, /"lastReadAt": last_read_at/);
  assert.match(app, /tauriEvent\.listen\("shelf-book-read"/);
  assert.match(app, /shelfUI\.updateBook\(String\(e\?\.payload\?\.id \|\| ""\), \{ last_read_at: Number\(e\?\.payload\?\.lastReadAt \|\| 0\) \}\)/);
});

test("reader close caches the same book and safely rebuilds for another book", () => {
  const windows = fs.readFileSync(path.join(__dirname, "..", "..", "src", "window_commands.rs"), "utf8");
  const closeCommand = windows.slice(windows.indexOf("pub(crate) fn main_window_close"), windows.indexOf("pub(crate) fn main_window_start_dragging"));
  assert.match(closeCommand, /update_reader_geom[\s\S]*?window\.hide\(\)/);
  assert.match(closeCommand, /hidden_cached/);
  assert.match(windows, /reader-switch-request/);
  assert.match(windows, /pub\(crate\) fn complete_reader_switch[\s\S]*?window\.destroy\(\)[\s\S]*?ensure_reader_window\(&app, &state, id_num\)/);
  assert.doesNotMatch(windows, /window\.navigate\(reader_url\)/);
  assert.match(windows, /WindowEvent::CloseRequested \{ api, \.\. \}[\s\S]*?api\.prevent_close\(\)[\s\S]*?reader-hide-request/);
  assert.match(windows, /fn activate_shelf_after_reader_close[\s\S]*?is_visible[\s\S]*?unminimize[\s\S]*?set_focus/);
  assert.match(windows, /main\.as_ref\(\)\.set_focus\(\)/);
  assert.match(windows, /mod windows_activation[\s\S]*?GetForegroundWindow[\s\S]*?SetForegroundWindow/);
  assert.match(windows, /focus_confirmed[\s\S]*?"focused"[\s\S]*?focus_requested[\s\S]*?"requested"/);
  assert.match(windows, /"focus_restore"/);
  assert.match(windows, /reader-window-trace/);
});

test("account overview makes clear that book source files stay local", () => {
  assert.match(html, /图书正文、原文件和本机路径不会上传/);
});

test("book information displays persisted model tags with the backend field name", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "app.js"), "utf8");
  assert.doesNotMatch(html, /<script>\s*window\.ReaderBookInfoPanel\.mount/s);
  assert.ok(app.indexOf("const bookInfoPanel = window.ReaderBookInfoPanel.mount(") < app.indexOf("const bookOrganizationUI = window.ReaderBookOrganizationUI.init("));
  assert.match(app, /bookOrganizationUI\.open\(currentInfoBookId, m\)/);
  assert.match(app, /bookInfoPanel\.render\(\{ \.\.\.book, \.\.\.m, cover: m\.cover \|\| book\.cover \}\)/);
});

test("funnel groups sorting, reading status and display controls by purpose", () => {
  const panel = html.slice(html.indexOf('<div id="filter-panel"'), html.indexOf('<div class="toolbar-action menu-wrap"'));
  assert.match(panel, /id="filter-result-summary"[^>]*>\s*0\/0/);
  assert.ok(panel.indexOf('id="filter-result-summary"') > panel.indexOf('class="layout-config-row"'));
  const top = panel.indexOf("fp-top-grid");
  const sorting = panel.indexOf("fp-sort-grid");
  const reading = panel.indexOf("fp-reading-filter-col");
  const organization = panel.indexOf("fp-org-row");
  const layout = panel.indexOf("fp-layout-bar");
  assert.ok(top >= 0 && top < sorting && sorting < reading && reading < organization && organization < layout);
  for (const value of ["read", "title", "author", "added", "reading-time", "progress", "size", "dir"]) {
    assert.match(panel, new RegExp(`name="sort" value="${value}"`));
  }
  assert.match(panel, /id="reading-filter-all"[^>]*hidden[^>]*data-i18n="clearFilters"/);
  assert.ok(panel.indexOf('id="filter-stars"') > reading);
  assert.match(styles, /\.fp-top-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 148px/s);
  assert.match(styles, /\.layout-config-row\s*\{[^}]*grid-template-columns:\s*auto auto minmax\(76px, 1fr\)/s);
});

test("active shelf filters pulse blue, explain their state and show the visible book count", () => {
  assert.match(source, /function updateShelfFilterStatus\(visibleCount\)/);
  assert.match(source, /filterButton\.classList\.toggle\("filters-active", active\)/);
  assert.match(source, /filterButton\.title = active \? shelfText\("activeFilters"/);
  assert.match(source, /readingFilterAllButton\.hidden = !active/);
  assert.match(source, /filterResultSummary\.textContent = visibleCount \+ "\/" \+ books\.length/);
  assert.match(styles, /#filter-btn\.filters-active\s*\{[^}]*animation:\s*shelf-filter-pulse/s);
  assert.match(styles, /@keyframes shelf-filter-pulse/);
  assert.match(styles, /\.fp-result-summary\s*\{[^}]*text-align:\s*right/s);
});

test("new shelf sorting uses reading duration, real file size and progress", () => {
  const sorter = rulesSource.slice(rulesSource.indexOf("function sortBooks"), rulesSource.indexOf("function matchesShelfSearch"));
  assert.match(sorter, /case "reading-time":[\s\S]*reading_seconds/);
  assert.match(sorter, /case "size":[\s\S]*bookFileSizes/);
  assert.match(sorter, /case "progress":[\s\S]*\.progress/);
  assert.match(source, /tauriApi\.invoke\("book_file_sizes"\)/);
  assert.match(source, /shelfRules\.sortBooks\(list, \{ bookFileSizes, sortKey \}\)/);
});

test("book organization uses book information controls and the existing funnel filters", () => {
  assert.match(source, /tag-filter-list/);
  assert.match(source, /collection-filter-list/);
  assert.match(organizationEditor, /set_book_organization/);
  assert.match(organizationEditor, /rename_book_organization/);
  assert.match(organizationEditor, /delete_book_organization/);
  assert.match(source, /matchesOrganizationFilters/);
  assert.match(rulesSource, /mode === "all"[\s\S]*?selectedTags\)\.every[\s\S]*?selectedCollections\)\.every/);
  assert.match(rulesSource, /selectedTags\)\.some[\s\S]*?selectedCollections\)\.some/);
  assert.match(source, /shelfOrganizationMatchMode/);
  assert.match(source, /shelfText\("matchAll"[\s\S]*?shelfText\("matchAny"/);
  assert.match(html, /id="organization-match-mode"[^>]*data-i18n="matchAny"/);
  assert.match(styles, /\.fp-org-row\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.fp-org-title-row\s*\{[^}]*width:\s*100%;/s);
  assert.match(styles, /\.fp-match-mode\s*\{[^}]*margin-left:\s*auto;[^}]*margin-right:\s*8px;/s);
  assert.match(source, /openOrganizationFilter/);
  assert.match(source, /organization-filter-modal/);
  assert.match(source, /className = "fp-choice-clear"/);
  assert.match(source, /selectedKeys\.clear\(\)/);
  assert.match(styles, /\.fp-choice-clear/);
  const opener = source.match(/function openOrganizationFilter\([\s\S]*?\n\}/);
  assert.ok(opener, "organization picker opener must exist");
  assert.ok(opener[0].indexOf("positionOrganizationFilter(anchor)") < opener[0].indexOf('filterPanelElement.classList.remove("show")'), "must capture the trigger position before hiding its panel");
  assert.match(opener[0], /organizationFilterReturnToPanel = filterPanelElement\.classList\.contains\("show"\)/);
  const closer = source.match(/function closeOrganizationFilter\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(closer, "organization picker closer must exist");
  assert.match(closer[1], /requestFrame\(\(\) =>/);
  assert.match(closer[1], /filterPanelElement\.classList\.add\("show"\)/);
  assert.match(styles, /\.book-info-organization-editor/);
  assert.match(styles, /\.organization-filter-card/);
  assert.match(styles, /\.fp-org-row/);
});

test("organization match mode applies to every selected tag and collection", () => {
  const context = { window: null };
  context.window = context;
  vm.runInNewContext(rulesSource, context);
  assert.match(source, /const organizationName = shelfRules\.organizationName/);
  assert.match(source, /shelfRules\.matchesOrganizationSelection\(book, tagFilter, collectionFilter, organizationMatchMode\)/);
  const book = { tags: ["古文"], collections: ["历史"] };
  const tags = new Set(["古文", "历史著作"]);
  const collections = new Set(["历史", "武侠小说"]);
  assert.equal(context.ReaderShelfRules.matchesOrganizationSelection(book, tags, collections, "any"), true);
  assert.equal(context.ReaderShelfRules.matchesOrganizationSelection(book, tags, collections, "all"), false);
  assert.equal(context.ReaderShelfRules.matchesOrganizationSelection(
    { tags: ["古文", "历史著作"], collections: ["历史", "武侠小说"] },
    tags,
    collections,
    "all",
  ), true);
});

test("shelf pure rules preserve layout bounds, search precedence, filters and render identity", () => {
  const context = { window: null };
  context.window = context;
  vm.runInNewContext(rulesSource, context);
  const rules = context.ReaderShelfRules;
  assert.equal(rules.parseGridColumns("-3"), 0);
  assert.equal(rules.parseGridColumns("100"), 12);
  assert.equal(rules.parseGridColumns("4"), 4);
  assert.equal(rules.colorFor("三国演义"), rules.colorFor("三国演义"));
  assert.notEqual(
    rules.bookRenderKey({ id: "a", title: "甲" }, { showCoverProgress: false, showCoverRating: false }),
    rules.bookRenderKey({ id: "a", title: "甲" }, { showCoverProgress: true, showCoverRating: false }),
  );
  const books = [
    { id: "unread", title: "Alpha", progress: 0, rating: 5, tags: ["古文"] },
    { id: "reading", title: "Beta", progress: 50, rating: 4, tags: ["历史"] },
    { id: "done", title: "Gamma", progress: 99, rating: 1, collections: ["收藏"] },
  ];
  const filters = {
    collectionFilter: new Set(),
    minRating: 4,
    organizationMatchMode: "any",
    readingFilter: { unread: false, reading: true, done: false },
    searchQuery: "",
    tagFilter: new Set(),
  };
  assert.deepEqual(rules.currentList(books, filters).map((book) => book.id), ["reading"]);
  assert.deepEqual(
    rules.currentList(books, { ...filters, searchQuery: "gamma" }).map((book) => book.id),
    ["done"],
  );
  assert.deepEqual(
    rules.sortBooks(books, { sortKey: "progress" }).map((book) => book.id),
    ["done", "reading", "unread"],
  );
});

test("shelf scrollbar geometry maps content ratios and pointer movement without DOM state", () => {
  const context = { window: null };
  context.window = context;
  vm.runInNewContext(rulesSource, context);
  const rules = context.ReaderShelfRules;
  assert.deepEqual(
    { ...rules.scrollbarGeometry({ viewport: 480, total: 4800, trackHeight: 300, scrollTop: 2160 }) },
    { maxScroll: 4320, maxTop: 270, thumbHeight: 30, top: 135, visible: true },
  );
  assert.deepEqual(
    { ...rules.scrollbarGeometry({ viewport: 480, total: 481, trackHeight: 300, scrollTop: 0 }) },
    { visible: false },
  );
  assert.equal(
    rules.scrollbarTrackScrollTop({
      clientY: 220,
      rectTop: 100,
      thumbHeight: 30,
      total: 4800,
      trackHeight: 300,
      viewport: 480,
    }),
    1680,
  );
  assert.equal(
    rules.scrollbarDragScrollTop({
      clientY: 190,
      dragStartScrollTop: 1000,
      dragStartY: 140,
      thumbHeight: 30,
      total: 4800,
      trackHeight: 300,
      viewport: 480,
    }),
    1800,
  );
  assert.match(source, /shelfRules\.scrollbarGeometry\s*\?/);
  assert.match(source, /shelfRules\.scrollbarTrackScrollTop\s*\?/);
  assert.match(source, /shelfRules\.scrollbarDragScrollTop\s*\?/);
});

test("shelf select-all ignores the current search filter and batch-removes the whole library", async () => {
  class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach((name) => this.values.add(name)); }
    contains(name) { return this.values.has(name); }
    remove(...names) { names.forEach((name) => this.values.delete(name)); }
    toggle(name, force) {
      const enabled = force === undefined ? !this.values.has(name) : !!force;
      if (enabled) this.values.add(name); else this.values.delete(name);
      return enabled;
    }
  }
  class FakeElement {
    constructor(tag = "div", fragment = false) {
      this.tagName = tag.toUpperCase();
      this.isFragment = fragment;
      this.children = [];
      this.classList = new FakeClassList();
      this.dataset = {};
      this.handlers = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
      this.checked = false;
      this.value = "";
      this.textContent = "";
      this.clientHeight = 100;
      this.scrollHeight = 100;
      this.scrollTop = 0;
      this.offsetHeight = 20;
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { this.children.push(node); return node; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 20, width: 20 }; }
    querySelector(selector) {
      if (selector === ".s-fg") return this.children.find((child) => child.className === "s-fg") || null;
      return null;
    }
    querySelectorAll(selector) {
      if (selector === ".star") return this.children.filter((child) => child.className === "star");
      return [];
    }
    replaceChildren(...nodes) {
      this.children = [];
      nodes.forEach((node) => {
        if (node?.isFragment) this.children.push(...node.children);
        else if (node) this.children.push(node);
      });
    }
    set className(value) {
      this._className = value;
      this.classList = new FakeClassList();
      String(value || "").split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
    }
    get className() { return this._className || ""; }
    emit(name, event = {}) { return this.handlers.get(name)?.(event); }
    releasePointerCapture() {}
    setPointerCapture() {}
  }
  const ids = [
    "shelf", "empty", "shelf-scrollbar", "shelf-scrollbar-thumb", "filter-btn", "filter-stars",
    "set-cover-prog", "set-cover-rating", "set-cover-title", "grid-cols-default", "grid-cols-value",
    "grid-cols-dec", "grid-cols-inc", "del-group", "del-btn", "book-info-btn", "del-cancel",
    "mi-selectall", "mi-random", "booklist-description", "booklist-books",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const content = new FakeElement();
  const root = {
    createDocumentFragment: () => new FakeElement("fragment", true),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => selector === ".content" ? content : null,
    querySelectorAll: () => [],
  };
  const storageData = new Map();
  const storage = {
    getItem: (key) => storageData.get(key) || null,
    removeItem: (key) => storageData.delete(key),
    setItem: (key, value) => storageData.set(key, value),
  };
  const calls = [];
  let searchClosed = false;
  let notice = null;
  const context = {
    addEventListener() {},
    clearTimeout,
    HTMLElement: FakeElement,
    setTimeout,
  };
  context.window = context;
  vm.runInNewContext(rulesSource, context);
  vm.runInNewContext(source, context);
  const shelf = context.ReaderShelfUI.init({
    root,
    storage,
    menuElement: new FakeElement(),
    filterPanel: new FakeElement(),
    dialog: { open: async () => null },
    closeAccountPanel() {},
    closeSearch: () => { searchClosed = true; },
    clearCrossReturnMemory() {},
    startPerformance: () => () => {},
    requestAnimationFrame: (callback) => { callback(); return 1; },
    confirmAction: () => true,
    alertAction: (message, options) => { notice = { message, options }; },
    invoke: async (command, payload) => {
      calls.push({ command, payload });
      if (command === "remove_books") return [];
      return [];
    },
  });
  shelf.render([
    { id: "a", title: "Alpha", progress: 0 },
    { id: "b", title: "Beta", progress: 0 },
  ]);
  shelf.setSearchQuery("alpha");
  await elements.get("mi-selectall").emit("click", { stopPropagation() {} });
  assert.deepEqual(Array.from(shelf.getSelectedIds()), ["a", "b"]);
  assert.equal(searchClosed, true);
  await elements.get("del-btn").emit("click");
  assert.equal(calls[0].command, "remove_books");
  assert.equal(calls[0].payload.ids.length, 2);
  assert.equal(calls[0].payload.ids[0], "a");
  assert.equal(calls[0].payload.ids[1], "b");
  assert.equal(shelf.count(), 0);
  assert.deepEqual(Array.from(shelf.getSelectedIds()), []);
  await elements.get("mi-random").emit("click");
  assert.equal(notice.message, "书架还是空的");
  assert.equal(notice.options.variant, "text");
  assert.equal(notice.options.duration, 1500);
});
