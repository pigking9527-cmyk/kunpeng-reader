const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const uiDir = path.resolve(__dirname, "..");
const statsSource = fs.readFileSync(path.join(uiDir, "stats-ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");

test("stats UI only binds elements that exist in the main page", () => {
  const referencedIds = [...statsSource.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  const missingIds = [...new Set(referencedIds)].filter((id) => !indexSource.includes(`id="${id}"`));
  assert.deepEqual(missingIds, []);
});

test("stats UI uses an injected command boundary and keeps range payloads", async () => {
  class FakeElement {
    constructor() {
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      };
      this.handlers = new Map();
      this.style = { setProperty() {}, visibility: "" };
      this.dataset = {};
      this.clientHeight = 100;
      this.scrollHeight = 100;
      this.scrollTop = 0;
      this.checked = false;
      this.textContent = "";
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    contains() { return false; }
  }
  const ids = [
    "stats-modal", "stats-body", "stats-period", "stats-prev", "stats-next",
    "stats-toolbar-btn", "stats-settings", "stats-settings-btn", "stats-chart-metric", "stats-chart-mode",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const storage = { getItem: () => null, setItem() {} };
  const calls = [];
  const emptyStats = {
    total_seconds: 0,
    total_words: 0,
    book_count: 0,
    finished_count: 0,
    total_highlights: 0,
    total_notes: 0,
    books: [],
    days: [],
    hours: new Array(24).fill(0),
    hours_words: new Array(24).fill(0),
  };
  const context = {};
  context.window = context;
  vm.runInNewContext(statsSource, context);
  const controller = context.ReaderStatsUI.init({
    root: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
    },
    storage,
    menuElement: new FakeElement(),
    filterPanel: new FakeElement(),
    closeAccountPanel() {},
    closeSearch() {},
    requestAnimationFrame: (callback) => callback(),
    invoke: async (command, payload) => {
      calls.push({ command, payload });
      return emptyStats;
    },
  });
  await controller.render();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "reading_stats_range");
  assert.equal(calls[0].payload.from, calls[0].payload.to);
  assert.equal(calls[1].command, "reading_stats_range");
  assert.equal(calls[1].payload.from, 0);
  assert.equal(calls[1].payload.to, 99999999);
});

test("stats and sync APIs load before app.js initializes them", () => {
  const syncPosition = indexSource.indexOf('src="sync-ui.js"');
  const statsPosition = indexSource.indexOf('src="stats-ui.js"');
  const appPosition = indexSource.indexOf('src="app.js"');
  assert.ok(syncPosition >= 0 && syncPosition < appPosition);
  assert.ok(statsPosition >= 0 && statsPosition < appPosition);
  assert.match(statsSource, /global\.ReaderStatsUI = Object\.freeze/);
});
