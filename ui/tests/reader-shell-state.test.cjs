const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "reader-shell-state.js"), "utf8");

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : !!force;
      if (on) values.add(name); else values.delete(name);
      return on;
    },
    contains(name) { return values.has(name); },
  };
}

function boot(immersive = false) {
  const ids = [
    "settings", "rsearch", "toc", "vocab", "info-modal", "anno-modal",
    "cross-modal", "reader-end-modal", "ai-reader-side",
    "backdrop", "vocab-settings",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, { classList: classList() }]));
  const body = { classList: classList() };
  const stored = new Map([["immersive", immersive ? "1" : "0"]]);
  const events = [];
  const context = {
    dispatchEvent(event) { events.push(event); },
    document: {
      body,
      getElementById(id) { return elements[id] || null; },
    },
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    Set,
    Map,
    Object,
  };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  context.CustomEvent = CustomEvent;
  context.window = context;
  vm.runInNewContext(source, context);
  return { shell: context.ReaderShell, elements, events, stored, body };
}

test("shell overlays are exclusive and lifecycle cleanup runs once", () => {
  const { shell, elements } = boot();
  let searchClosed = 0;
  shell.registerOverlay(shell.OVERLAY.SEARCH, { onClose() { searchClosed += 1; } });
  shell.setOverlay(shell.OVERLAY.SEARCH, true);
  assert.equal(shell.getState().overlay, "search");
  assert.equal(elements.rsearch.classList.contains("show"), true);

  shell.setOverlay(shell.OVERLAY.SETTINGS, true);
  assert.equal(shell.getState().overlay, "settings");
  assert.equal(elements.rsearch.classList.contains("show"), false);
  assert.equal(elements.settings.classList.contains("show"), true);
  assert.equal(searchClosed, 1);
});

test("settings stay open across the contiguous panel and close after leave-return", () => {
  const { shell, elements } = boot();
  shell.setOverlay(shell.OVERLAY.SETTINGS, true);
  assert.equal(elements.settings.classList.contains("show"), true);

  shell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(shell.getState().overlay, "settings");
  assert.equal(shell.getState().settingsPointerExited, true);

  shell.dispatch({ type: "TOOLBAR_POINTER_ENTER" });
  assert.equal(shell.getState().overlay, "none");
  assert.equal(elements.settings.classList.contains("show"), false);
});

test("sidebar, modal and toolbar rendering all come from shell state", () => {
  const { shell, elements, body } = boot();
  assert.equal(body.classList.contains("reader-controls-visible"), true);
  shell.setOverlay(shell.OVERLAY.TOC, true);
  assert.equal(elements.toc.classList.contains("show"), true);
  assert.equal(elements.backdrop.classList.contains("show"), true);

  shell.setOverlay(shell.OVERLAY.VOCAB, true);
  assert.equal(elements.toc.classList.contains("show"), false);
  assert.equal(elements.vocab.classList.contains("show"), true);

  shell.setOverlay(shell.OVERLAY.CROSS_SEARCH, true);
  assert.equal(elements.vocab.classList.contains("show"), false);
  assert.equal(elements["cross-modal"].classList.contains("show"), true);
  assert.equal(elements.backdrop.classList.contains("show"), false);

  shell.setOverlay(shell.OVERLAY.END_RECOMMENDATIONS, true);
  assert.equal(elements["cross-modal"].classList.contains("show"), false);
  assert.equal(elements["reader-end-modal"].classList.contains("show"), true);

  // 普通模式下点正文中部不能收起常驻菜单，也不能误开沉浸模式。
  shell.dispatch({ type: "TOGGLE_TOOLBAR" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.NORMAL);
  assert.equal(body.classList.contains("immersive"), false);
  assert.equal(body.classList.contains("reader-controls-visible"), true);

  shell.dispatch({ type: "SET_IMMERSIVE", on: true });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("immersive"), true);
  assert.equal(body.classList.contains("reader-controls-visible"), false);
  shell.dispatch({ type: "TOGGLE_TOOLBAR" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_PINNED);
  assert.equal(body.classList.contains("bar-show"), true);
  assert.equal(body.classList.contains("reader-controls-visible"), true);
  shell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("bar-show"), false);
  assert.equal(body.classList.contains("reader-controls-visible"), false);
});

test("side panels coexist with overlays and close before them", () => {
  const { shell, elements } = boot();
  let closed = 0;
  shell.registerSidePanel(shell.SIDE_PANEL.AI_READER, { onClose() { closed += 1; } });
  shell.setOverlay(shell.OVERLAY.SETTINGS, true);
  shell.setSidePanel(shell.SIDE_PANEL.AI_READER, true);

  assert.equal(shell.getState().overlay, "settings");
  assert.equal(shell.getState().sidePanel, "ai-reader");
  assert.equal(elements.settings.classList.contains("show"), true);
  assert.equal(elements["ai-reader-side"].classList.contains("show"), true);
  assert.equal(shell.hasSurface(), true);

  assert.equal(shell.closeSurface(), true);
  assert.equal(shell.getState().overlay, "settings");
  assert.equal(shell.getState().sidePanel, "none");
  assert.equal(elements["ai-reader-side"].classList.contains("show"), false);
  assert.equal(closed, 1);

  assert.equal(shell.closeSurface(), true);
  assert.equal(shell.getState().overlay, "none");
  assert.equal(shell.hasSurface(), false);
});

test("managed shell modules do not mutate overlay visibility directly", () => {
  const files = [
    "generated-ts/reader.js", "generated-ts/reader-search-ui.js", "generated-ts/reader-notes-ui.js",
    "generated-ts/vocab-ui.js", "generated-ts/reader-cross-search-ui.js",
  ];
  const managed = files
    .map((name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    managed,
    /(?:settingsEl|rsearch|tocEl|vocabEl|infoModal|annoModal|crossModal|backdropEl|aiReaderSide)\.classList\.(?:add|remove|toggle)\("show"/
  );
});
