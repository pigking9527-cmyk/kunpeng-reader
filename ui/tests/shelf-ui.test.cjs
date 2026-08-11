const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shelf-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const settingsLayout = fs.readFileSync(path.join(__dirname, "..", "settings-layout-ui.js"), "utf8");
const appShell = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const appI18n = fs.readFileSync(path.join(__dirname, "..", "app-i18n.js"), "utf8");
const animationSettings = fs.readFileSync(path.join(__dirname, "..", "animation-settings-ui.js"), "utf8");
const semanticSettings = fs.readFileSync(path.join(__dirname, "..", "semantic-ui.js"), "utf8");
const organizationEditor = fs.readFileSync(path.join(__dirname, "..", "book-info-organization.js"), "utf8");

test("common settings use a categorized wide layout with a live shelf preview", () => {
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*width:\s*min\(920px,\s*calc\(100vw - 48px\)\);/s);
  assert.match(styles, /\.fp-set-row \{[^}]*font-size:\s*16px;/s);
  assert.match(html, /data-settings-section="basic"[\s\S]*data-settings-section="toolbar"[\s\S]*data-settings-section="shelf"[\s\S]*data-settings-section="reading"[\s\S]*data-settings-section="smart"[\s\S]*data-settings-section="data"/);
  assert.match(html, /data-settings-panel="basic"[\s\S]*data-settings-panel="toolbar"[^>]*hidden[\s\S]*data-settings-panel="shelf"[^>]*hidden[\s\S]*data-settings-panel="data"[^>]*hidden/);
  assert.match(html, /id="fp-shelf-preview-title"[\s\S]*id="fp-shelf-preview-progress"[\s\S]*id="fp-shelf-preview-rating"/);
  assert.match(html, /src="settings-layout-ui\.js"/);
  assert.match(settingsLayout, /const STORAGE_KEY = "commonSettingsSectionV1"/);
  assert.match(settingsLayout, /function activateSection\(id, persist = true\)/);
  assert.match(settingsLayout, /function syncShelfPreview\(\)/);
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
  assert.match(settingsLayout, /function applyNavState\(\)/);
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
  assert.match(helper[1], /menuEl\.classList\.remove\("show"\)/);
  assert.match(helper[1], /filterPanel\.classList\.remove\("show"\)/);
  assert.match(helper[1], /closeAccountPanel\(\)/);
  assert.match(helper[1], /closeSearch\(false\)/);

  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /addEventListener\("click",[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.match(card, /addEventListener\("dblclick",[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.match(card, /if \(selected\.size > 0\)[\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.match(card, /openTimer = setTimeout\([\s\S]*?if \(!selected\.size\) openBook\("single"\)/);
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
  const i18n = fs.readFileSync(path.join(__dirname, "..", "app-i18n.js"), "utf8");
  assert.match(source, /const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24/);
  assert.match(source, /function estimateFirstScreenCoverCount\(\)/);
  assert.match(source, /firstScreenCoverCount = Math\.max\(DEFAULT_FIRST_SCREEN_COVER_COUNT, estimateFirstScreenCoverCount\(\)\)/);
  assert.match(card, /const eagerCoverLoad = index < firstScreenCoverCount/);
  assert.match(card, /img\.loading = eagerCoverLoad \? "eager" : "lazy"/);
  assert.match(card, /img\.decoding = eagerCoverLoad \? "sync" : "async"/);
  assert.match(card, /img\.fetchPriority = eagerCoverLoad \? "high" : "auto"/);
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
  const info = html.slice(html.indexOf('id="book-info-modal"'), html.indexOf('id="book-organization-modal"'));
  const manager = html.slice(html.indexOf('id="book-organization-modal"'), html.indexOf('id="similar-books-modal"'));
  assert.match(info, /id="book-info-tags-manage"/);
  assert.match(info, /id="book-info-collections-manage"/);
  assert.doesNotMatch(info, /id="book-info-tags"|id="book-info-collections"/);
  assert.match(manager, /id="book-info-tags" class="book-info-organization-editor"/);
  assert.match(manager, /id="book-info-collections"[\s\S]*?class="book-info-organization-editor"/);
  assert.match(manager, /role="tablist"/);
  assert.match(html, /src="book-info-organization\.js"/);
  assert.doesNotMatch(html, /id="batch-tag-btn"|id="batch-collection-btn"|id="batch-organization-modal"|id="book-organizer-menu"/);
  assert.match(organizationEditor, /invoke\("set_book_organization"/);
  assert.match(organizationEditor, /invoke\("rename_book_organization"/);
  assert.match(organizationEditor, /invoke\("delete_book_organization"/);
  assert.match(organizationEditor, /openBooklist\?\.\(entry\.name\)/);
  assert.match(organizationEditor, /function showInlineRename/);
  assert.match(organizationEditor, /remove\.textContent = "确认删除"/);
  assert.match(organizationEditor, /function openManager\(field\)/);
  assert.match(organizationEditor, /infoModal\?\.classList\.remove\("show"\)/);
  assert.match(organizationEditor, /function closeManager\(\)[\s\S]*?infoModal\?\.classList\.add\("show"\)/);
  assert.match(organizationEditor, /renderSummary\(tagSummary, book\?\.tags\)/);
  assert.doesNotMatch(organizationEditor, /global\.prompt|global\.confirm/);
});

test("book information uses a compact identity, facts, organization and description layout", () => {
  const info = html.slice(html.indexOf('id="book-info-modal"'), html.indexOf('id="book-organization-modal"'));
  assert.doesNotMatch(info, /book-info-eyebrow|>图书信息<|id="book-info-close"/);
  assert.match(info, /id="book-info-cover"[\s\S]*?class="book-info-cover"/);
  assert.match(info, /class="book-info-cover-stack"[\s\S]*?id="cover-btn"/);
  assert.match(info, /class="book-info-hero"/);
  assert.match(info, /class="book-info-primary"/);
  assert.match(info, /class="book-info-facts"/);
  assert.match(info, /class="book-info-organization-grid"/);
  assert.match(info, /class="[^"]*book-info-description"/);
  assert.match(styles, /\.book-info-facts\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(styles, /\.book-info-organization-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
});

test("book information keeps its cover current and remains behind the reading timeline", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const timeline = app.slice(app.indexOf("async function openReadingTimeline"), app.indexOf("function fmtWords"));
  assert.doesNotMatch(timeline, /bookInfoModal\.classList\.remove\("show"\)/);
  assert.match(app, /function renderBookInfoCover\(book\)/);
  assert.match(app, /await shelfUI\.changeCoverById\(currentInfoBookId\);[\s\S]*?renderBookInfoCover\(shelfUI\.getBook\(currentInfoBookId\)\)/);
  assert.match(styles, /#reading-timeline-modal\s*\{\s*z-index:\s*55;/);
});

test("startup shelf can receive keyboard paging focus without stealing it on refresh", () => {
  assert.match(source, /function focusShelf\(\)[\s\S]*?contentEl\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /focusShelf,/);
  assert.match(html, /<div class="content" tabindex="-1">/);
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /shelfUI\.render\(list\);[\s\S]*?requestAnimationFrame\(\(\) => shelfUI\.focusShelf\(\)\)/);
});

test("opening a book immediately updates recent-reading order without waiting for window focus", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const windows = fs.readFileSync(path.join(__dirname, "..", "..", "src", "window_commands.rs"), "utf8");
  assert.match(windows, /main\.emit\(\s*"shelf-book-read"/s);
  assert.match(windows, /"lastReadAt": last_read_at/);
  assert.match(app, /tauriEvent\.listen\("shelf-book-read"/);
  assert.match(app, /shelfUI\.updateBook\(String\(e\?\.payload\?\.id \|\| ""\), \{ last_read_at: Number\(e\?\.payload\?\.lastReadAt \|\| 0\) \}\)/);
});

test("reader close keeps its transition marked until the old window unregisters", () => {
  const windows = fs.readFileSync(path.join(__dirname, "..", "..", "src", "window_commands.rs"), "utf8");
  assert.match(windows, /CLOSING_READER_WINDOWS/);
  assert.match(windows, /WindowEvent::CloseRequested[\s\S]*?set_reader_window_closing\(&event_label, true\)/);
  assert.match(windows, /WindowEvent::Destroyed[\s\S]*?不在后台按标签轮询并清 closing/);
  assert.match(windows, /else if reader_window_is_closing\(&label\)[\s\S]*?already_unregistered/);
  assert.doesNotMatch(windows, /fn clear_reader_closing_after_unregister/);
  assert.match(windows, /open_wait[\s\S]*?while app\.get_webview_window\(&label\)\.is_some\(\)[\s\S]*?open_build/);
  assert.match(windows, /force_destroy[\s\S]*?stale_window\.destroy\(\)/);
  const closeCommand = windows.slice(windows.indexOf("pub(crate) fn main_window_close"), windows.indexOf("pub(crate) fn main_window_start_dragging"));
  assert.match(closeCommand, /set_reader_window_closing\(window\.label\(\), true\)[\s\S]*?window\.close\(\)/);
  assert.match(windows, /fn activate_shelf_after_reader_close[\s\S]*?is_visible[\s\S]*?unminimize[\s\S]*?set_focus/);
  assert.match(windows, /main\.as_ref\(\)\.set_focus\(\)/);
  assert.match(windows, /fn schedule_shelf_activation_after_reader_close[\s\S]*?get_webview_window\(&label\)[\s\S]*?run_on_main_thread/);
  assert.match(windows, /WindowEvent::CloseRequested[\s\S]*?activate_shelf_after_reader_close\(&event_app\)[\s\S]*?WindowEvent::Destroyed/);
  assert.match(windows, /WindowEvent::Destroyed[\s\S]*?schedule_shelf_activation_after_reader_close\(&event_app, &event_label\)/);
  assert.match(windows, /mod windows_activation[\s\S]*?GetForegroundWindow[\s\S]*?SetForegroundWindow/);
  assert.match(windows, /focus_confirmed[\s\S]*?"focused"[\s\S]*?focus_requested[\s\S]*?"requested"/);
  assert.match(windows, /"focus_restore"/);
  assert.doesNotMatch(windows, /force_windows_foreground|focus_main_window|finish_reader_window_close|prevent_close|Duration::from_millis\(80\)|Duration::from_millis\(1200\)/);
  assert.match(windows, /reader-window-trace/);
  assert.match(windows, /READER_CLOSE_STARTED/);
  assert.match(windows, /WindowEvent::Destroyed[\s\S]*?take_reader_close_elapsed\(&event_label\)/);
});

test("account overview makes clear that book source files stay local", () => {
  assert.match(html, /图书正文、原文件和本机路径不会上传/);
});

test("book information displays persisted model tags with the backend field name", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /bookOrganizationUI\.open\(currentInfoBookId, m\)/);
  assert.match(app, /renderBookInfoTags\(document\.getElementById\("book-info-model-tags"\), \[\], m\.model_tags \|\| m\.modelTags\)/);
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
  const sorter = source.slice(source.indexOf("function sortBooks"), source.indexOf("function matchesShelfSearch"));
  assert.match(sorter, /case "reading-time":[\s\S]*reading_seconds/);
  assert.match(sorter, /case "size":[\s\S]*bookFileSizes/);
  assert.match(sorter, /case "progress":[\s\S]*\.progress/);
  assert.match(source, /invoke\("book_file_sizes"\)/);
});

test("book organization uses book information controls and the existing funnel filters", () => {
  assert.match(source, /tag-filter-list/);
  assert.match(source, /collection-filter-list/);
  assert.match(organizationEditor, /set_book_organization/);
  assert.match(organizationEditor, /rename_book_organization/);
  assert.match(organizationEditor, /delete_book_organization/);
  assert.match(source, /matchesOrganizationFilters/);
  assert.match(source, /mode === "all"[\s\S]*?selectedTags\)\.every[\s\S]*?selectedCollections\)\.every/);
  assert.match(source, /selectedTags\)\.some[\s\S]*?selectedCollections\)\.some/);
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
  assert.ok(opener[0].indexOf("positionOrganizationFilter(anchor)") < opener[0].indexOf('filterPanel.classList.remove("show")'), "must capture the trigger position before hiding its panel");
  assert.match(opener[0], /organizationFilterReturnToPanel = filterPanel\.classList\.contains\("show"\)/);
  const closer = source.match(/function closeOrganizationFilter\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(closer, "organization picker closer must exist");
  assert.match(closer[1], /requestFrame\(\(\) =>/);
  assert.match(closer[1], /filterPanel\.classList\.add\("show"\)/);
  assert.match(styles, /\.book-info-organization-editor/);
  assert.match(styles, /\.organization-filter-card/);
  assert.match(styles, /\.fp-org-row/);
});

test("organization match mode applies to every selected tag and collection", () => {
  const nameFn = source.match(/function organizationName\([^)]*\)\s*\{[^}]*\}/)?.[0];
  const keyFn = source.match(/function organizationKey\([^)]*\)\s*\{[^}]*\}/)?.[0];
  const matcherStart = source.indexOf("function matchesOrganizationSelection");
  const matcherEnd = source.indexOf("function matchesOrganizationFilters", matcherStart);
  const matcherFn = matcherStart >= 0 && matcherEnd > matcherStart ? source.slice(matcherStart, matcherEnd) : "";
  assert.ok(nameFn && keyFn && matcherFn, "pure organization matcher must remain testable");
  const context = {};
  vm.runInNewContext(`${nameFn}\n${keyFn}\n${matcherFn}`, context);
  const book = { tags: ["古文"], collections: ["历史"] };
  const tags = new Set(["古文", "历史著作"]);
  const collections = new Set(["历史", "武侠小说"]);
  assert.equal(context.matchesOrganizationSelection(book, tags, collections, "any"), true);
  assert.equal(context.matchesOrganizationSelection(book, tags, collections, "all"), false);
  assert.equal(context.matchesOrganizationSelection(
    { tags: ["古文", "历史著作"], collections: ["历史", "武侠小说"] },
    tags,
    collections,
    "all",
  ), true);
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
    "mi-selectall", "mi-random",
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
    setTimeout,
  };
  context.window = context;
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
