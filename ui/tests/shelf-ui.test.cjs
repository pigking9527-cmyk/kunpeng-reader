const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shelf-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const organizationEditor = fs.readFileSync(path.join(__dirname, "..", "book-info-organization.js"), "utf8");

test("common settings dialog uses the requested 560px desktop width", () => {
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*width:\s*min\(560px,\s*calc\(100vw - 48px\)\);/s);
  assert.match(styles, /\.fp-set-row \{[^}]*font-size:\s*16px;/s);
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
  assert.match(card, /openTimer = setTimeout\([\s\S]*?if \(!selected\.size\) openBook\(\)/);
  assert.match(card, /let selectionTimer = null/);
  assert.match(card, /if \(!singleClickOpensBook\) \{[\s\S]*?selectionTimer = setTimeout\([\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.match(card, /selectionTimer = setTimeout\([\s\S]*?\}, 180\)/);
  assert.match(card, /clearTimeout\(selectionTimer\)[\s\S]*?restoreDeferredSelection\(\)[\s\S]*?openBook\(\)/);
  assert.match(card, /addEventListener\("contextmenu"/);
  assert.match(card, /addEventListener\("contextmenu",[\s\S]*?e\.preventDefault\(\)[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.doesNotMatch(card, /openBookOrganizer/);
});

test("shelf opening preference switches between single-click opening and double-click opening", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(html, /id="set-single-click-open"/);
  assert.match(html, /id="set-open-book-label"[^>]*>单击打开图书/);
  assert.match(source, /shelfSingleClickOpen/);
  assert.match(source, /function setSingleClickOpenPreference\(value\)/);
  assert.match(card, /if \(!singleClickOpensBook\)[\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.match(card, /if \(!singleClickOpensBook\) \{[\s\S]*?openBook\(\);[\s\S]*?return;/);
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
  assert.match(manager, /id="book-info-collections" class="book-info-organization-editor"/);
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

test("startup shelf can receive keyboard paging focus without stealing it on refresh", () => {
  assert.match(source, /function focusShelf\(\)[\s\S]*?contentEl\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /focusShelf,/);
  assert.match(html, /<div class="content" tabindex="-1">/);
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /shelfUI\.render\(list\);[\s\S]*?requestAnimationFrame\(\(\) => shelfUI\.focusShelf\(\)\)/);
});

test("account sync description includes book tags and collections", () => {
  assert.match(html, /书签、高亮、批注、评分、标签与收藏夹/);
});

test("book information displays persisted model tags with the backend field name", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /bookOrganizationUI\.open\(currentInfoBookId, m\)/);
  assert.match(app, /renderBookInfoTags\(document\.getElementById\("book-info-model-tags"\), \[\], m\.model_tags \|\| m\.modelTags\)/);
});

test("funnel keeps sorting in two columns and reading filters on the right", () => {
  const panel = html.slice(html.indexOf('<div id="filter-panel"'), html.indexOf('<div class="menu-wrap">'));
  assert.match(panel, /id="filter-result-summary"[^>]*>0\/0/);
  assert.ok(panel.indexOf('id="filter-result-summary"') > panel.indexOf('class="layout-config-row"'));
  const primary = panel.indexOf("fp-sort-primary");
  const secondary = panel.indexOf("fp-sort-secondary");
  const reading = panel.indexOf("fp-reading-filter-col");
  assert.ok(primary >= 0 && primary < secondary && secondary < reading);
  for (const value of ["read", "reading-time", "size", "progress"]) {
    assert.match(panel, new RegExp(`name="sort" value="${value}"`));
  }
  assert.ok(panel.indexOf('id="reading-filter-all"') > secondary);
  assert.ok(panel.indexOf('id="reading-filter-all"') < reading);
  assert.ok(panel.indexOf('id="reading-filter-all"') < panel.indexOf('name="sort" value="read"'));
  assert.ok(panel.indexOf('id="filter-stars"') > reading);
  assert.match(styles, /\.fp-row\s*\{[^}]*grid-template-columns:\s*max-content max-content max-content/s);
});

test("active shelf filters pulse blue, explain their state and show the visible book count", () => {
  assert.match(source, /function updateShelfFilterStatus\(visibleCount\)/);
  assert.match(source, /filterButton\.classList\.toggle\("filters-active", active\)/);
  assert.match(source, /filterButton\.title = active \? "已启用筛选" : "排序与布局"/);
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
  assert.match(source, /"匹配全部" : "匹配任一"/);
  assert.match(html, /id="organization-match-mode"[^>]*>匹配任一/);
  assert.match(styles, /\.fp-org-col\s*\{[^}]*flex:\s*1 1 0;[^}]*max-width:\s*none;/s);
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
