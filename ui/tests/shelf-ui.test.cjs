const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shelf-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("common settings dialog stays compact on desktop", () => {
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*width:\s*min\(600px,\s*calc\(100vw - 48px\)\);/s);
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
});

test("shelf state, filtered selection and batch removal stay inside the injected API", async () => {
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
    alertAction() {},
    invoke: async (command, payload) => {
      calls.push({ command, payload });
      if (command === "remove_books") return [{ id: "b", title: "Beta", progress: 0 }];
      return [];
    },
  });
  shelf.render([
    { id: "a", title: "Alpha", progress: 0 },
    { id: "b", title: "Beta", progress: 0 },
  ]);
  shelf.setSearchQuery("alpha");
  await elements.get("mi-selectall").emit("click", { stopPropagation() {} });
  assert.deepEqual(Array.from(shelf.getSelectedIds()), ["a"]);
  assert.equal(searchClosed, true);
  await elements.get("del-btn").emit("click");
  assert.equal(calls[0].command, "remove_books");
  assert.equal(calls[0].payload.ids.length, 1);
  assert.equal(calls[0].payload.ids[0], "a");
  assert.equal(shelf.count(), 1);
  assert.deepEqual(Array.from(shelf.getSelectedIds()), []);
});
