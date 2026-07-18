const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "reader-shell-state.js"), "utf8");

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
    "cross-modal", "backdrop", "vocab-settings",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, { classList: classList() }]));
  const body = { classList: classList() };
  const stored = new Map([["immersive", immersive ? "1" : "0"]]);
  const events = [];
  const window = {
    dispatchEvent(event) { events.push(event); },
  };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  vm.runInNewContext(source, {
    window,
    document: {
      body,
      getElementById(id) { return elements[id] || null; },
    },
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    CustomEvent,
    Set,
    Map,
    Object,
  });
  return { shell: window.ReaderShell, elements, events, stored, body };
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

  shell.dispatch({ type: "TOGGLE_TOOLBAR" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("immersive"), true);
  shell.dispatch({ type: "TOGGLE_TOOLBAR" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_PINNED);
  assert.equal(body.classList.contains("bar-show"), true);
  shell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(shell.getState().toolbar, shell.TOOLBAR.IMMERSIVE_HIDDEN);
  assert.equal(body.classList.contains("bar-show"), false);
});

test("managed shell modules do not mutate overlay visibility directly", () => {
  const files = [
    "reader.js", "reader-search-ui.js", "reader-notes-ui.js",
    "vocab-ui.js", "reader-cross-search-ui.js",
  ];
  const managed = files
    .map((name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    managed,
    /(?:settingsEl|rsearch|tocEl|vocabEl|infoModal|annoModal|crossModal|backdropEl)\.classList\.(?:add|remove|toggle)\("show"/
  );
});
