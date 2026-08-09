const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const uiDir = path.resolve(__dirname, "..");
const statsSource = fs.readFileSync(path.join(uiDir, "stats-ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(uiDir, "styles.css"), "utf8");

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
      this.innerHTML = "";
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    contains() { return false; }
  }
  const ids = [
    "stats-modal", "stats-body", "stats-period", "stats-prev", "stats-next",
    "stats-toolbar-btn", "stats-settings", "stats-settings-btn",
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

test("read books render as one clipped cover row ordered by reading duration", () => {
  assert.match(statsSource, /data\.books\.slice\(\)\.sort/);
  assert.match(statsSource, /\(b\.seconds \|\| 0\) - \(a\.seconds \|\| 0\)/);
  assert.match(statsSource, /class="stats-book-strip"/);
  assert.match(statsSource, /class="stats-book-cover"/);
  assert.match(statsSource, /statsText\("statsBookNotes"/);
});

test("stats show a loading state immediately instead of a blank panel", () => {
  assert.match(statsSource, /class="stats-loading" role="status" aria-live="polite"/);
  assert.match(statsSource, /statsText\("statsLoading"/);
  assert.match(statsSource, /statsRequestSerial/);
  assert.match(statsSource, /statsText\("statsLoadFailed"/);
  assert.match(indexSource, /id="stats-body" class="stats-body"/);
});

test("stats header is folded into the scope tabs with settings after total", () => {
  const modal = indexSource.slice(indexSource.indexOf('id="stats-modal"'), indexSource.indexOf('id="notes-modal"'));
  assert.doesNotMatch(modal, /class="modal-head stats-head"/);
  assert.doesNotMatch(modal, /data-i18n="readingStats">阅读统计/);
  assert.match(modal, /data-scope="day"[\s\S]*?data-scope="month"[\s\S]*?data-scope="year"[\s\S]*?data-scope="total"[\s\S]*?id="stats-settings-btn"/);
  assert.match(stylesSource, /\.stats-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(4,minmax\(0,1fr\)\) 42px;/s);
  assert.match(stylesSource, /\.stats-settings-btn\s*\{[^}]*width:\s*42px;[^}]*height:\s*40px;/s);
});

test("stats settings persist three live heatmap palettes", () => {
  assert.match(indexSource, /data-heatmap-option="green"[\s\S]*?data-heatmap-option="blue"[\s\S]*?data-heatmap-option="orange"/);
  assert.doesNotMatch(indexSource, /data-i18n="statsVisibleItems"/);
  assert.doesNotMatch(indexSource, /<strong[^>]*data-i18n="heatmapColor"/);
  assert.match(statsSource, /STAT_HEATMAP_THEME_KEY = "readingStatsHeatmapTheme"/);
  assert.match(statsSource, /STAT_HEATMAP_THEMES = new Set\(\["green", "blue", "orange"\]\)/);
  assert.match(statsSource, /statsModal\.dataset\.heatmapTheme = statHeatmapTheme/);
  assert.match(statsSource, /localStorage\.setItem\(STAT_HEATMAP_THEME_KEY, statHeatmapTheme\)/);
  assert.match(stylesSource, /#stats-modal\[data-heatmap-theme="blue"\]/);
  assert.match(stylesSource, /#stats-modal\[data-heatmap-theme="orange"\]/);
  assert.match(stylesSource, /\.contrib-cell\.lv4\s*\{\s*background:\s*var\(--stats-heat-4\)/);
  assert.doesNotMatch(statsSource, /statsText\("yearlyHeatmap"/);
});

test("stats settings can persist a labelled line chart without changing the default bar chart", () => {
  assert.match(indexSource, /data-chart-style-option="bar"[\s\S]*?data-chart-style-option="line"/);
  assert.match(indexSource, /data-chart-metric-option="time"[\s\S]*?data-chart-metric-option="words"[^>]*data-i18n="chartWords"/);
  assert.match(stylesSource, /\.stats-chart-settings\s*\{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/s);
  assert.match(statsSource, /STAT_LINE_CHART_KEY = "readingStatsLineChart"/);
  assert.match(statsSource, /let statLineChart = localStorage\.getItem\(STAT_LINE_CHART_KEY\) === "1"/);
  assert.match(statsSource, /statLineChart\s*\? lineChart\(bars/);
  assert.match(statsSource, /class="stats-line-value"/);
  assert.match(statsSource, /localStorage\.setItem\(STAT_LINE_CHART_KEY, statLineChart \? "1" : "0"\)/);
  assert.match(statsSource, /localStorage\.setItem\(STAT_CHART_METRIC_KEY, statChartMetric\)/);
  assert.match(stylesSource, /\.stat-chart \.stats-line-path/);
});
