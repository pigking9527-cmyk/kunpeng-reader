import { createTauriApi, type TauriCommandMap, type TauriTransport } from "../../../../../packages/tauri-api/src/index.js";
import type { ReadingStatsBook, ReadingStatsDay, ReadingStatsRange } from "../../features/reading-stats/reading-stats-port.js";
import type { StatsRulesApi } from "../main-business/stats-rules.js";
type StatsCommands = { reading_stats_range: { readonly args: { readonly from: number; readonly to: number }; readonly result: ReadingStatsRange } };
type VerifiedStatsCommands = StatsCommands extends TauriCommandMap ? StatsCommands : never;
type StatScope = "day" | "month" | "year" | "total";
type StatMetric = "time" | "words";
type StatsVisible = Record<string, boolean>;
interface StatBar { readonly label: string | number; readonly value: number }
interface StatsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface StatsRuntime extends Record<string, unknown> { readonly localStorage: StatsStorage; readonly ReaderStatsRules?: StatsRulesApi; readonly ReaderAppI18n?: { t?(key: string): string; resolvedLanguage?(): string | undefined }; requestAnimationFrame(callback: FrameRequestCallback): number; addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void; ReaderStatsUI?: StatsUiGlobal }
export interface StatsUiOptions { readonly root?: Document; readonly invoke?: TauriTransport["invoke"]; readonly transport?: TauriTransport; readonly menuElement?: HTMLElement; readonly filterPanel?: HTMLElement; readonly closeAccountPanel?: () => void; readonly closeSearch?: (clear: boolean) => void; readonly storage?: StatsStorage; readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number }
export interface StatsUiController { close(): void; open(): void; render(): Promise<void> }
export interface StatsUiGlobal { close(): void; init(options?: StatsUiOptions): StatsUiController; open(): void; render(): Promise<void> }
function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null ? value as Record<string, unknown> : null }
function runtimeFrom(value: unknown): StatsRuntime | null { const target = record(value); return target && record(target.localStorage) ? target as unknown as StatsRuntime : null }
export function installStatsUi(target: unknown): StatsUiGlobal | null {
const candidate = runtimeFrom(target);
if (!candidate) return null;
const global: StatsRuntime = candidate;

let activeController: StatsUiController | null = null;

function init(options: StatsUiOptions = {}): StatsUiController {
  if (activeController) return activeController;
  const root = options.root;
  const transport = options.transport || (options.invoke ? { invoke: options.invoke } : null);
  const api = transport ? createTauriApi<VerifiedStatsCommands>(transport) : null;
  const menuEl = options.menuElement;
  const filterPanel = options.filterPanel;
  const closeAccountPanel = options.closeAccountPanel;
  const closeSearch = options.closeSearch;
  const localStorage = options.storage || global.localStorage;
  const scheduleFrame = options.requestAnimationFrame || ((callback) => global.requestAnimationFrame(callback));
  if (!root || typeof root.getElementById !== "function") throw new Error("ReaderStatsUI.init 缺少 root");
  if (!api) throw new Error("ReaderStatsUI.init 缺少 invoke");
  if (!menuEl || !filterPanel) throw new Error("ReaderStatsUI.init 缺少浮层元素");
  if (typeof closeAccountPanel !== "function" || typeof closeSearch !== "function") {
    throw new Error("ReaderStatsUI.init 缺少浮层关闭接口");
  }
  if (typeof scheduleFrame !== "function") throw new Error("ReaderStatsUI.init 缺少 requestAnimationFrame");
  const document: Document = root; const statsApi = api; const statsMenu = menuEl; const statsFilterPanel = filterPanel; const closeStatsAccount = closeAccountPanel; const closeStatsSearch = closeSearch;

const statsModal = document.getElementById("stats-modal") as HTMLElement;
const statsText = (key: string, fallback: string, values: Record<string, unknown> = {}) => Object.entries(values).reduce(
  (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
  global.ReaderAppI18n?.t?.(key) || fallback,
);
function fmtTime(sec: number) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return statsText("statsHourMinute", "{hours} h {minutes} min", { hours: h, minutes: m });
  if (m > 0) return statsText("statsMinutes", "{minutes} min", { minutes: m });
  return statsText("statsSeconds", "{seconds} sec", { seconds: sec });
}
function fmtWords(n: number) {
  n = n || 0;
  return n >= 10000
    ? statsText("statsTenThousandWords", "{words} ×10k words", { words: (n / 10000).toFixed(2) })
    : statsText("statsWords", "{words} words", { words: n });
}
let statScope: StatScope = "day";
let statAnchor = new Date(); // 当前查看的日/月/年
let firstReadingDay: number | null = null;
const STAT_VISIBLE_KEY = "readingStatsVisibleItems";
const STAT_CHART_METRIC_KEY = "readingStatsChartMetric";
const STAT_LINE_CHART_KEY = "readingStatsLineChart";
const STAT_HEATMAP_THEME_KEY = "readingStatsHeatmapTheme";
const STAT_HEATMAP_THEMES = new Set(["green", "blue", "orange"]);
const DEFAULT_STAT_VISIBLE = {
  duration: true,
  words: true,
  speed: true,
  books: true,
  finished: true,
  highlights: true,
  notes: true,
};
const statVisible = readStatVisible();
let statChartMetric: StatMetric = localStorage.getItem(STAT_CHART_METRIC_KEY) === "words" ? "words" : "time";
let statLineChart = localStorage.getItem(STAT_LINE_CHART_KEY) === "1";
const savedStatHeatmapTheme = localStorage.getItem(STAT_HEATMAP_THEME_KEY);
let statHeatmapTheme = savedStatHeatmapTheme && STAT_HEATMAP_THEMES.has(savedStatHeatmapTheme)
  ? savedStatHeatmapTheme
  : "green";
// 图形切换只能改变绘制方式，不能改变下方内容的起始位置。
const STAT_CHART_WIDTH = 600;
const STAT_CHART_HEIGHT = 156;
let statsRequestSerial = 0;
function readStatVisible(): StatsVisible {
  try {
    return Object.assign({}, DEFAULT_STAT_VISIBLE, JSON.parse(localStorage.getItem(STAT_VISIBLE_KEY) || "{}"));
  } catch {
    return Object.assign({}, DEFAULT_STAT_VISIBLE);
  }
}
function saveStatVisible() {
  localStorage.setItem(STAT_VISIBLE_KEY, JSON.stringify(statVisible));
}
function syncStatVisibleControls() {
  document.querySelectorAll<HTMLInputElement>("[data-stat-item]").forEach((input) => {
    input.checked = statVisible[input.dataset.statItem ?? ""] !== false;
  });
}
function pad2(n: number) { return (n < 10 ? "0" : "") + n; }
function ymd(d: Date) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function dateFromYmd(v: number) {
  const y = Math.floor(v / 10000), m = Math.floor(v / 100) % 100, d = v % 100;
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); } // m: 0-based
// index.html 目前不能调整脚本加载顺序，因此保留以下等价内嵌回退。将来统计
// 规则脚本被预加载时，日期范围和导航统一委托给无副作用的 ReaderStatsRules。
const statsRulesCandidate = global.ReaderStatsRules;
const statCalendarRules = statsRulesCandidate && [
  "compareAnchors", "firstAnchor", "lastAnchor", "normalizeAnchor", "range", "steppedAnchor",
].every((name) => typeof (statsRulesCandidate as unknown as Record<string, unknown>)[name] === "function") ? statsRulesCandidate : null;
function statsEscapeHtml(s: unknown) { return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c)); }
function statsEscapeAttr(s: unknown) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}
function statsCoverHue(title: unknown) {
  let hash = 0;
  for (const ch of String(title || "书")) hash = ((hash * 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}
function statsBookCard(book: ReadingStatsBook) {
  const title = statsEscapeHtml(book.title);
  const cover = book.cover
    ? `<img src="${statsEscapeAttr(book.cover)}" alt="${statsEscapeAttr(book.title)}" loading="lazy" />`
    : `<span class="stats-book-fallback" style="--stats-cover-hue:${statsCoverHue(book.title)}">${title}</span>`;
  return (
    `<article class="stats-book-card" title="${statsEscapeAttr(book.title)}">` +
      `<div class="stats-book-cover">${cover}${book.finished ? `<span class="stats-book-finished">${statsText("finishedBook", "Finished")}</span>` : ""}</div>` +
      `<div class="stats-book-title">${title}</div>` +
      `<div class="stats-book-reading">${fmtTime(book.seconds)} · ${fmtWords(book.words)}</div>` +
      `<div class="stats-book-notes">${statsText("statsBookNotes", "Highlights {highlights} · Notes {notes}", { highlights: book.highlights, notes: book.notes })}</div>` +
    "</article>"
  );
}
function fmtReadingSpeed(words: number, seconds: number) {
  if (!words || !seconds) return "—";
  return statsText("wordsPerMinute", "{words} words/min", { words: Math.round(words / Math.max(1, seconds / 60)) });
}
function statsQualityNote(data: ReadingStatsRange) {
  const seconds = data.total_seconds || 0;
  const words = data.total_words || 0;
  if (seconds < 60 || words <= 0) return "";
  const speed = words / Math.max(1, seconds / 60);
  if (seconds >= 1800 && words < 100) return statsText("statsQualityDwell", "This period may include idle time: reading time is long but few words were counted.");
  if (speed > 3000) return statsText("statsQualityFast", "The average reading speed is high and may include rapid page turns or repeated counting.");
  if (speed < 20 && seconds >= 600) return statsText("statsQualitySlow", "The average reading speed is low and may include idle time or scanned PDFs.");
  return "";
}
function statRange() {
  if (statCalendarRules) return statCalendarRules.range(statScope, statAnchor);
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth();
  if (statScope === "day") { const v = ymd(d); return [v, v]; }
  if (statScope === "month") return [y * 10000 + (m + 1) * 100 + 1, y * 10000 + (m + 1) * 100 + 31];
  if (statScope === "year") return [y * 10000 + 101, y * 10000 + 1231];
  return [0, 99999999];
}
function statPeriodLabel() {
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth() + 1;
  if (statScope === "day") return y + "-" + pad2(m) + "-" + pad2(d.getDate());
  if (statScope === "month") return new Intl.DateTimeFormat(global.ReaderAppI18n?.resolvedLanguage?.() || undefined, { year: "numeric", month: "long" }).format(d);
  if (statScope === "year") return new Intl.DateTimeFormat(global.ReaderAppI18n?.resolvedLanguage?.() || undefined, { year: "numeric" }).format(d);
  return statsText("statsAll", "All");
}

function normalizeStatAnchor(date: Date, scope: StatScope = statScope) {
  if (statCalendarRules) return statCalendarRules.normalizeAnchor(date, scope);
  const value = new Date(date);
  if (scope === "month") return new Date(value.getFullYear(), value.getMonth(), 1);
  if (scope === "year") return new Date(value.getFullYear(), 0, 1);
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function firstStatAnchor() {
  if (statCalendarRules) return statCalendarRules.firstAnchor(firstReadingDay, statScope);
  return firstReadingDay ? normalizeStatAnchor(dateFromYmd(firstReadingDay)) : null;
}

function lastStatAnchor() {
  if (statCalendarRules) return statCalendarRules.lastAnchor(new Date(), statScope);
  return normalizeStatAnchor(new Date());
}

function compareStatAnchors(first: Date, second: Date) {
  if (statCalendarRules) return statCalendarRules.compareAnchors(first, second);
  return first.getTime() - second.getTime();
}

function syncStatsNavigation() {
  const previous = document.getElementById("stats-prev") as HTMLButtonElement | null;
  const next = document.getElementById("stats-next") as HTMLButtonElement | null;
  const showNavigation = statScope !== "total";
  const earliest = firstStatAnchor();
  const latest = lastStatAnchor();
  const anchor = normalizeStatAnchor(statAnchor);
  const previousDisabled = !showNavigation || !earliest || compareStatAnchors(anchor, earliest) <= 0;
  const nextDisabled = !showNavigation || compareStatAnchors(anchor, latest) >= 0;
  [previous, next].forEach((button) => {
    if (!button) return;
    button.style.visibility = showNavigation ? "visible" : "hidden";
  });
  if (previous) previous.disabled = previousDisabled;
  if (next) next.disabled = nextDisabled;
}

function steppedStatAnchor(direction: number) {
  if (statCalendarRules) return statCalendarRules.steppedAnchor(statScope, statAnchor, direction);
  const current = normalizeStatAnchor(statAnchor);
  if (statScope === "day") return addDays(current, direction);
  if (statScope === "month") return new Date(current.getFullYear(), current.getMonth() + direction, 1);
  if (statScope === "year") return new Date(current.getFullYear() + direction, 0, 1);
  return current;
}

function statStep(dir: number) {
  if (statScope === "total") return;
  const candidate = steppedStatAnchor(dir);
  const earliest = firstStatAnchor();
  const latest = lastStatAnchor();
  if ((dir < 0 && (!earliest || compareStatAnchors(candidate, earliest) < 0)) ||
      (dir > 0 && compareStatAnchors(candidate, latest) > 0)) {
    syncStatsNavigation();
    return;
  }
  statAnchor = candidate;
  renderStats();
}
function fmtAxisTime(sec: number) {
  sec = Math.round(sec || 0);
  if (sec < 60) return statsText("statsSeconds", "{seconds} sec", { seconds: sec });
  if (sec < 3600) return statsText("statsMinutes", "{minutes} min", { minutes: Math.round(sec / 60) });
  const h = sec / 3600;
  return statsText("statsHourMinute", "{hours} h {minutes} min", { hours: (Math.round(h * 10) / 10).toFixed(1).replace(/\.0$/, ""), minutes: 0 });
}
function fmtAxisValue(v: number, metric: StatMetric) {
  return metric === "words" ? fmtWords(v || 0) : fmtAxisTime(v || 0);
}
function statChartColumnX(index: number, count: number, width: number, padLeft: number, padRight: number) {
  const plotWidth = width - padLeft - padRight;
  return padLeft + ((index + 0.5) / Math.max(1, count)) * plotWidth;
}
function barChart(bars: readonly StatBar[], color: string, metric: StatMetric) {
  const W = STAT_CHART_WIDTH, H = STAT_CHART_HEIGHT, padL = 42, padR = 14, padT = 23, padB = 22;
  const slot = bars.length ? (W - padL - padR) / bars.length : 0;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const everyLabel = bars.length <= 24 ? 1 : Math.ceil(bars.length / 12);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  [0.5, 1].forEach((ratio) => {
    const y = padT + (1 - ratio) * (H - padT - padB);
    s += `<line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"></line>`;
    s += `<text class="axis-label" x="${padL - 5}" y="${y + 3}" text-anchor="end">${fmtAxisValue(max * ratio, metric)}</text>`;
  });
  bars.forEach((b, i) => {
    const h = (b.value / max) * (H - padT - padB), x = padL + i * slot, y = H - padB - h;
    const rectW = Math.max(4, slot * 0.72);
    s += `<rect x="${x + (slot - rectW) / 2}" y="${y}" width="${rectW}" height="${h}" rx="2" fill="${b.value ? color : "#e3e6ec"}"><title>${b.label}：${metric === "words" ? fmtWords(b.value || 0) : fmtTime(b.value || 0)}</title></rect>`;
    if (i % everyLabel === 0) s += `<text x="${statChartColumnX(i, bars.length, W, padL, padR)}" y="${H - 6}" font-size="9" fill="#aaa" text-anchor="middle">${b.label}</text>`;
  });
  return s + "</svg>";
}
function compactChartValue(value: number, metric: StatMetric) {
  const amount = Math.max(0, Number(value) || 0);
  if (metric === "words") {
    if (amount >= 10000) return `${(amount / 10000).toFixed(amount >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
    if (amount >= 1000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(Math.round(amount));
  }
  if (amount < 60) return `${Math.round(amount)}s`;
  if (amount < 3600) return `${Math.round(amount / 60)}m`;
  return `${(amount / 3600).toFixed(amount >= 36000 ? 0 : 1).replace(/\.0$/, "")}h`;
}
function lineChart(bars: readonly StatBar[], color: string, metric: StatMetric) {
  const W = STAT_CHART_WIDTH, H = STAT_CHART_HEIGHT, padL = 42, padR = 14, padT = 23, padB = 22;
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const everyLabel = bars.length <= 24 ? 1 : Math.ceil(bars.length / 12);
  const pointX = (index: number) => statChartColumnX(index, bars.length, W, padL, padR);
  const pointY = (value: number) => padT + (1 - ((Number(value) || 0) / max)) * (H - padT - padB);
  let svg = `<svg class="stats-line-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${statsEscapeAttr(statsText("lineChartData", "Line chart data"))}">`;
  [0.5, 1].forEach((ratio) => {
    const y = pointY(max * ratio);
    svg += `<line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="${padL - 5}" y="${y + 3}" text-anchor="end">${fmtAxisValue(max * ratio, metric)}</text>`;
  });
  if (bars.length) {
    const points = bars.map((bar, index) => `${pointX(index)},${pointY(bar.value)}`).join(" ");
    const areaPoints = `${pointX(0)},${H - padB} ${points} ${pointX(bars.length - 1)},${H - padB}`;
    svg += `<polygon class="stats-line-area" points="${areaPoints}" fill="${color}"></polygon>`;
    svg += `<polyline class="stats-line-path" points="${points}" stroke="${color}"></polyline>`;
  }
  bars.forEach((bar, index) => {
    const x = pointX(index), y = pointY(bar.value);
    const labelY = Math.max(10, y - 7 - ((index % 2) * 9));
    if (bar.value > 0) {
      svg += `<g class="stats-line-point"><circle cx="${x}" cy="${y}" r="3.2" fill="${color}"><title>${bar.label}：${metric === "words" ? fmtWords(bar.value) : fmtTime(bar.value)}</title></circle>`;
      svg += `<text class="stats-line-value" x="${x}" y="${labelY}" text-anchor="middle">${compactChartValue(bar.value, metric)}</text></g>`;
    }
    if (index % everyLabel === 0) svg += `<text x="${x}" y="${H - 6}" font-size="9" fill="#aaa" text-anchor="middle">${bar.label}</text>`;
  });
  return svg + "</svg>";
}
function statBars(data: ReadingStatsRange): StatBar[] {
  const metric = statChartMetric;
  if (statScope === "day") {
    const source = metric === "words" ? (data.hours_words || []) : data.hours;
    return source.map((v, h) => ({ label: h, value: v ?? 0 }));
  }
  const dayMap: Record<number, number> = {};
  data.days.forEach((d) => (dayMap[d.day] = metric === "words" ? (d.words || 0) : d.seconds));
  if (statScope === "month") {
    const y = statAnchor.getFullYear(), m = statAnchor.getMonth(), n = daysInMonth(y, m), bars: StatBar[] = [];
    for (let i = 1; i <= n; i++) bars.push({ label: i, value: dayMap[y * 10000 + (m + 1) * 100 + i] || 0 });
    return bars;
  }
  if (statScope === "year") {
    const mo: number[] = new Array<number>(12).fill(0);
    data.days.forEach((d) => (mo[(Math.floor(d.day / 100) % 100) - 1] = (mo[(Math.floor(d.day / 100) % 100) - 1] ?? 0) + (metric === "words" ? (d.words || 0) : d.seconds)));
    return mo.map((v, i) => ({ label: statsText("statsMonth", "{month} mo", { month: i + 1 }), value: v ?? 0 }));
  }
  const yr: Record<string, number> = {};
  data.days.forEach((d) => { const yy = Math.floor(d.day / 10000); yr[yy] = (yr[yy] || 0) + (metric === "words" ? (d.words || 0) : d.seconds); });
  return Object.keys(yr).sort().map((y) => ({ label: y, value: yr[y] ?? 0 }));
}
function streakStats(days: readonly ReadingStatsDay[]) {
  const active = new Set(days.filter((d) => d.seconds > 0).map((d) => d.day));
  const today = new Date();
  let cur = 0;
  for (let d = new Date(today); active.has(ymd(d)); d = addDays(d, -1)) cur++;
  const sorted = Array.from(active).sort((a, b) => a - b).map(dateFromYmd);
  let longest = 0, run = 0, prev: Date | null = null;
  sorted.forEach((d) => {
    if (prev && Math.round((d.getTime() - prev.getTime()) / 86400000) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prev = d;
  });
  return { current: cur, longest };
}
function contributionLevel(seconds: number) {
  if (!seconds) return 0;
  if (seconds < 20 * 60) return 1;
  if (seconds < 40 * 60) return 2;
  if (seconds < 60 * 60) return 3;
  if (seconds < 120 * 60) return 4;
  return 4;
}
function monthLabelsForContribution(start: Date) {
  const labels = [];
  const end = addDays(start, 53 * 7 - 1);
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  if (cursor < start) cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  while (cursor <= end) {
    const diff = Math.floor((cursor.getTime() - start.getTime()) / 86400000);
    const week = Math.max(0, Math.min(52, Math.floor(diff / 7)));
    const cls = week >= 51 ? "edge" : week <= 0 ? "first" : "";
    labels.push(`<span class="mw${week} ${cls}">${statsText("statsMonth", "{month} mo", { month: cursor.getMonth() + 1 })}</span>`);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return labels.join("");
}
function contributionGraph(allData: ReadingStatsRange) {
  const map: Record<number, number> = {};
  allData.days.forEach((d) => (map[d.day] = d.seconds));
  const today = new Date();
  const start = addDays(today, -364);
  start.setDate(start.getDate() - start.getDay());
  let cells = "";
  for (let w = 0; w < 53; w++) {
    for (let r = 0; r < 7; r++) {
      const d = addDays(start, w * 7 + r);
      const key = ymd(d), seconds = map[key] || 0;
      cells += `<span class="contrib-cell lv${contributionLevel(seconds)}" title="${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} · ${fmtTime(seconds)}"></span>`;
    }
  }
  return (
    '<div class="contrib-card">' +
    `<div class="contrib-months">${monthLabelsForContribution(start)}</div>` +
    `<div class="contrib-grid">${cells}</div>` +
    "</div>"
  );
}
function overviewStats(allData: ReadingStatsRange) {
  const streak = streakStats(allData.days);
  const peak = allData.days.reduce((m, d) => Math.max(m, d.seconds || 0), 0);
  return (
    '<div class="stat-overview">' +
    `<div><b>${fmtTime(allData.total_seconds)}</b><span>${statsText("totalReadingTime", "Total reading time")}</span></div>` +
    `<div><b>${fmtTime(peak)}</b><span>${statsText("dailyPeak", "Daily peak")}</span></div>` +
    `<div><b>${statsText("days", "{count} days", { count: streak.current })}</b><span>${statsText("currentStreak", "Current streak")}</span></div>` +
    `<div><b>${statsText("days", "{count} days", { count: streak.longest })}</b><span>${statsText("longestStreak", "Longest streak")}</span></div>` +
    "</div>"
  );
}
async function renderStats() {
  const bodyEl = document.getElementById("stats-body") as HTMLElement | null;
  const requestSerial = ++statsRequestSerial;
  const prevScrollTop = bodyEl ? bodyEl.scrollTop : 0;
  const prevHeight = bodyEl ? Math.max(bodyEl.clientHeight, bodyEl.scrollHeight) : 0;
  if (bodyEl) {
    bodyEl.dataset.loading = "1";
    if (!String(bodyEl.innerHTML || "").trim()) {
      bodyEl.innerHTML = (
        '<div class="stats-loading" role="status" aria-live="polite">' +
          '<span class="stats-loading-spinner" aria-hidden="true"></span>' +
          `<span>${statsText("statsLoading", "Loading reading statistics…")}</span>` +
        "</div>"
      );
    }
  }
  if (bodyEl && prevHeight > 0) {
    bodyEl.style.setProperty("--stats-refresh-height", `${prevHeight}px`);
    bodyEl.classList.add("refreshing");
  }
  (document.getElementById("stats-period") as HTMLElement).textContent = statPeriodLabel();
  syncStatsNavigation();
  const [from, to] = statRange();
  let data: ReadingStatsRange; let allData: ReadingStatsRange;
  try {
    [data, allData] = await Promise.all([
      statsApi.invoke("reading_stats_range", { from, to }),
      statsApi.invoke("reading_stats_range", { from: 0, to: 99999999 }),
    ]);
  } catch {
    if (requestSerial !== statsRequestSerial) return;
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="stats-empty stats-load-error">${statsText("statsLoadFailed", "Could not load reading statistics. Please try again.")}</div>`;
      bodyEl.classList.remove("refreshing");
      delete bodyEl.dataset.loading;
    }
    return;
  }
  if (requestSerial !== statsRequestSerial) return;
  firstReadingDay = (Array.isArray(allData.days) ? allData.days : []).reduce<number | null>((earliest, day) => (
    !earliest || day.day < earliest ? day.day : earliest
  ), null);
  syncStatsNavigation();
  const unit = { day: statsText("day", "Day"), month: statsText("month", "Month"), year: statsText("year", "Year"), total: statsText("statsPeriodUnit", "period") }[statScope];
  const allStatItems: Array<readonly [string, string, string | number]> = [
    ["duration", statsText("readingDuration", "Reading time"), fmtTime(data.total_seconds)],
    ["words", statsText("readingWords", "Words read"), fmtWords(data.total_words)],
    ["speed", statsText("averageSpeed", "Average speed"), fmtReadingSpeed(data.total_words, data.total_seconds)],
    ["books", statsText("booksRead", "Books read"), data.book_count],
    ["finished", statsText("finishedBooks", "Finished"), data.finished_count],
    ["highlights", statsText("highlights", "Highlights"), data.total_highlights],
    ["notes", statsText("annotations", "Notes"), data.total_notes],
  ];
  const statItems = allStatItems.filter((item) => statVisible[item[0]] !== false);
  const cards = statItems.length
    ? '<div class="stat-cards">' + statItems.map((item) => `<div class="stat-cell"><div class="k">${item[1]}</div><div class="v">${item[2]}</div></div>`).join("") + "</div>"
    : "";
  const quality = statsQualityNote(data);
  const qualityNote = quality ? `<div class="stats-quality-note">${statsEscapeHtml(quality)}</div>` : "";
  const bars = statBars(data);
  const chartSvg = statLineChart
    ? lineChart(bars, "#4d8fe8", statChartMetric)
    : barChart(bars, "#5aa0ff", statChartMetric);
  const chart = `<div class="stat-chart" data-chart-style="${statLineChart ? "line" : "bar"}">${chartSvg}</div>`;
  let books;
  if (data.books.length) {
    books = `<div class="stat-sec-title">${statsText("currentPeriodBooks", "Books read this {unit}", { unit })}</div>`;
    const orderedBooks = data.books.slice().sort((a, b) => (
      (b.seconds || 0) - (a.seconds || 0) || String(a.title || "").localeCompare(String(b.title || ""), "zh-CN")
    ));
    books += `<div class="stats-book-strip">${orderedBooks.map(statsBookCard).join("")}</div>`;
  } else {
    books = `<div class="stats-empty">${statsText("noReadingRecords", "No reading records in this period")}</div>`;
  }
  if (!bodyEl) return;
  bodyEl.innerHTML = overviewStats(allData) + contributionGraph(allData) + cards + qualityNote + chart + books;
  scheduleFrame(() => {
    if (requestSerial !== statsRequestSerial) return;
    const maxScrollTop = Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
    bodyEl.scrollTop = Math.min(prevScrollTop, maxScrollTop);
    bodyEl.classList.remove("refreshing");
    delete bodyEl.dataset.loading;
  });
}
function openStats() {
  statsMenu.classList.remove("show");
  statsFilterPanel.classList.remove("show");
  closeStatsAccount();
  closeStatsSearch(true);
  statScope = "day";
  statAnchor = new Date();
  firstReadingDay = null;
  document.querySelectorAll<HTMLElement>(".stats-tab").forEach((t) => t.classList.toggle("active", t.dataset.scope === "day"));
  statsModal.classList.add("show");
  renderStats();
}
function closeStats() {
  statsModal.classList.remove("show");
  statsSettings.classList.remove("show");
  statsSettingsBtn.setAttribute("aria-expanded", "false");
}
(document.getElementById("stats-toolbar-btn") as HTMLElement).addEventListener("click", openStats);
document.querySelectorAll<HTMLElement>(".stats-tab").forEach((t) => {
  t.addEventListener("click", () => {
    statScope = t.dataset.scope as StatScope;
    document.querySelectorAll<HTMLElement>(".stats-tab").forEach((x) => x.classList.toggle("active", x === t));
    renderStats();
  });
});
(document.getElementById("stats-prev") as HTMLElement).addEventListener("click", () => statStep(-1));
(document.getElementById("stats-next") as HTMLElement).addEventListener("click", () => statStep(1));
const statsSettings = document.getElementById("stats-settings") as HTMLElement;
const statsSettingsBtn = document.getElementById("stats-settings-btn") as HTMLElement;
function syncStatsHeatmapTheme() {
  statsModal.dataset.heatmapTheme = statHeatmapTheme;
  document.querySelectorAll<HTMLElement>("[data-heatmap-option]").forEach((button) => {
    const active = button.dataset.heatmapOption === statHeatmapTheme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}
function syncStatsChartControls() {
  document.querySelectorAll<HTMLElement>("[data-chart-style-option]").forEach((button) => {
    const active = button.dataset.chartStyleOption === (statLineChart ? "line" : "bar");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>("[data-chart-metric-option]").forEach((button) => {
    const active = button.dataset.chartMetricOption === statChartMetric;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}
syncStatVisibleControls();
syncStatsChartControls();
syncStatsHeatmapTheme();
statsSettingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = statsSettings.classList.toggle("show");
  statsSettingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
});
statsSettings.addEventListener("click", (e) => e.stopPropagation());
document.querySelectorAll<HTMLInputElement>("[data-stat-item]").forEach((input) => {
  input.addEventListener("change", () => {
    statVisible[input.dataset.statItem ?? ""] = input.checked;
    saveStatVisible();
    renderStats();
  });
});
document.querySelectorAll<HTMLElement>("[data-chart-style-option]").forEach((button) => {
  button.addEventListener("click", () => {
    statLineChart = button.dataset.chartStyleOption === "line";
    localStorage.setItem(STAT_LINE_CHART_KEY, statLineChart ? "1" : "0");
    syncStatsChartControls();
    renderStats();
  });
});
document.querySelectorAll<HTMLElement>("[data-chart-metric-option]").forEach((button) => {
  button.addEventListener("click", () => {
    statChartMetric = button.dataset.chartMetricOption === "words" ? "words" : "time";
    localStorage.setItem(STAT_CHART_METRIC_KEY, statChartMetric);
    syncStatsChartControls();
    renderStats();
  });
});
document.querySelectorAll<HTMLElement>("[data-heatmap-option]").forEach((button) => {
  button.addEventListener("click", () => {
    const theme = button.dataset.heatmapOption;
    if (!theme || !STAT_HEATMAP_THEMES.has(theme)) return;
    statHeatmapTheme = theme;
    localStorage.setItem(STAT_HEATMAP_THEME_KEY, statHeatmapTheme);
    syncStatsHeatmapTheme();
  });
});
statsModal.addEventListener("click", (e) => {
  if (e.target === statsModal) {
    closeStats();
    return;
  }
  if (!statsSettings.contains(e.target as Node | null) && e.target !== statsSettingsBtn) {
    statsSettings.classList.remove("show");
    statsSettingsBtn.setAttribute("aria-expanded", "false");
  }
});
if (typeof global.addEventListener === "function") global.addEventListener("app-language-changed", () => {
  syncStatsChartControls();
  if (statsModal.classList.contains("show")) renderStats();
});

  activeController = Object.freeze({
    close: closeStats,
    open: openStats,
    render: renderStats,
  });
  return activeController;
}

function controller() {
  if (!activeController) throw new Error("ReaderStatsUI 尚未初始化");
  return activeController;
}

const publicApi = Object.freeze({
  close: () => controller().close(),
  init,
  open: () => controller().open(),
  render: () => controller().render(),
});
global.ReaderStatsUI = publicApi;
return publicApi;
}
