// 阅读统计面板。依赖由 app.js 通过 ReaderStatsUI.init 显式注入。
(function exposeStatsUi(global) {
"use strict";

let activeController = null;

function init(options = {}) {
  if (activeController) return activeController;
  const document = options.root;
  const invoke = options.invoke;
  const menuEl = options.menuElement;
  const filterPanel = options.filterPanel;
  const closeAccountPanel = options.closeAccountPanel;
  const closeSearch = options.closeSearch;
  const localStorage = options.storage || global.localStorage;
  const scheduleFrame = options.requestAnimationFrame || ((callback) => global.requestAnimationFrame(callback));
  if (!document || typeof document.getElementById !== "function") throw new Error("ReaderStatsUI.init 缺少 root");
  if (typeof invoke !== "function") throw new Error("ReaderStatsUI.init 缺少 invoke");
  if (!menuEl || !filterPanel) throw new Error("ReaderStatsUI.init 缺少浮层元素");
  if (typeof closeAccountPanel !== "function" || typeof closeSearch !== "function") {
    throw new Error("ReaderStatsUI.init 缺少浮层关闭接口");
  }
  if (typeof scheduleFrame !== "function") throw new Error("ReaderStatsUI.init 缺少 requestAnimationFrame");

const statsModal = document.getElementById("stats-modal");
function fmtTime(sec) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + " 小时 " + m + " 分钟";
  if (m > 0) return m + " 分钟";
  return sec + " 秒";
}
function fmtWords(n) {
  n = n || 0;
  return n >= 10000 ? (n / 10000).toFixed(2) + " 万字" : n + " 字";
}
let statScope = "day";
let statAnchor = new Date(); // 当前查看的日/月/年
const STAT_VISIBLE_KEY = "readingStatsVisibleItems";
const STAT_CHART_METRIC_KEY = "readingStatsChartMetric";
const DEFAULT_STAT_VISIBLE = {
  duration: true,
  words: true,
  speed: true,
  books: true,
  finished: true,
  highlights: true,
  notes: true,
};
let statVisible = readStatVisible();
let statChartMetric = localStorage.getItem(STAT_CHART_METRIC_KEY) === "words" ? "words" : "time";
function readStatVisible() {
  try {
    return Object.assign({}, DEFAULT_STAT_VISIBLE, JSON.parse(localStorage.getItem(STAT_VISIBLE_KEY) || "{}"));
  } catch (e) {
    return Object.assign({}, DEFAULT_STAT_VISIBLE);
  }
}
function saveStatVisible() {
  localStorage.setItem(STAT_VISIBLE_KEY, JSON.stringify(statVisible));
}
function syncStatVisibleControls() {
  document.querySelectorAll("[data-stat-item]").forEach((input) => {
    input.checked = statVisible[input.dataset.statItem] !== false;
  });
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function ymd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function dateFromYmd(v) {
  const y = Math.floor(v / 10000), m = Math.floor(v / 100) % 100, d = v % 100;
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); } // m: 0-based
function statsEscapeHtml(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function fmtReadingSpeed(words, seconds) {
  if (!words || !seconds) return "—";
  return Math.round(words / Math.max(1, seconds / 60)) + " 字/分钟";
}
function statsQualityNote(data) {
  const seconds = data.total_seconds || 0;
  const words = data.total_words || 0;
  if (seconds < 60 || words <= 0) return "";
  const speed = words / Math.max(1, seconds / 60);
  if (seconds >= 1800 && words < 100) return "这段统计可能包含停留时间：阅读时长较长，但计入字数很少。";
  if (speed > 3000) return "这段统计的平均速度偏高，可能包含快速翻页或重复计字。";
  if (speed < 20 && seconds >= 600) return "这段统计的平均速度偏低，可能包含停留时间或扫描版 PDF。";
  return "";
}
function statRange() {
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth();
  if (statScope === "day") { const v = ymd(d); return [v, v]; }
  if (statScope === "month") return [y * 10000 + (m + 1) * 100 + 1, y * 10000 + (m + 1) * 100 + 31];
  if (statScope === "year") return [y * 10000 + 101, y * 10000 + 1231];
  return [0, 99999999];
}
function statPeriodLabel() {
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth() + 1;
  if (statScope === "day") return y + "-" + pad2(m) + "-" + pad2(d.getDate());
  if (statScope === "month") return y + " 年 " + m + " 月";
  if (statScope === "year") return y + " 年";
  return "全部";
}
function statStep(dir) {
  const d = statAnchor;
  if (statScope === "day") d.setDate(d.getDate() + dir);
  else if (statScope === "month") d.setMonth(d.getMonth() + dir);
  else if (statScope === "year") d.setFullYear(d.getFullYear() + dir);
  else return;
  renderStats();
}
function fmtAxisTime(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + "秒";
  if (sec < 3600) return Math.round(sec / 60) + "分";
  const h = sec / 3600;
  return (Math.round(h * 10) / 10).toFixed(1).replace(/\.0$/, "") + "小时";
}
function fmtAxisValue(v, metric) {
  return metric === "words" ? fmtWords(v || 0) : fmtAxisTime(v || 0);
}
function barChart(bars, color, metric) {
  const W = 600, H = 142, padL = 42, padR = 14, padT = 10, padB = 22;
  const rawSlot = bars.length ? (W - padL - padR) / bars.length : 0;
  const slot = bars.length <= 12 ? Math.min(rawSlot, 58) : rawSlot;
  const chartWidth = slot * bars.length;
  const left = padL + Math.max(0, (W - padL - padR - chartWidth) / 2);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const everyLabel = bars.length <= 24 ? 1 : Math.ceil(bars.length / 12);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  [0.5, 1].forEach((ratio) => {
    const y = padT + (1 - ratio) * (H - padT - padB);
    s += `<line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"></line>`;
    s += `<text class="axis-label" x="${padL - 5}" y="${y + 3}" text-anchor="end">${fmtAxisValue(max * ratio, metric)}</text>`;
  });
  bars.forEach((b, i) => {
    const h = (b.value / max) * (H - padT - padB), x = left + i * slot, y = H - padB - h;
    const rectW = Math.max(4, slot * 0.72);
    s += `<rect x="${x + (slot - rectW) / 2}" y="${y}" width="${rectW}" height="${h}" rx="2" fill="${b.value ? color : "#e3e6ec"}"><title>${b.label}：${metric === "words" ? fmtWords(b.value || 0) : fmtTime(b.value || 0)}</title></rect>`;
    if (i % everyLabel === 0) s += `<text x="${x + slot / 2}" y="${H - 6}" font-size="9" fill="#aaa" text-anchor="middle">${b.label}</text>`;
  });
  return s + "</svg>";
}
function statBars(data) {
  const metric = statChartMetric;
  if (statScope === "day") {
    const source = metric === "words" ? (data.hours_words || []) : data.hours;
    return source.map((v, h) => ({ label: h, value: v }));
  }
  const dayMap = {};
  data.days.forEach((d) => (dayMap[d.day] = metric === "words" ? (d.words || 0) : d.seconds));
  if (statScope === "month") {
    const y = statAnchor.getFullYear(), m = statAnchor.getMonth(), n = daysInMonth(y, m), bars = [];
    for (let i = 1; i <= n; i++) bars.push({ label: i, value: dayMap[y * 10000 + (m + 1) * 100 + i] || 0 });
    return bars;
  }
  if (statScope === "year") {
    const mo = new Array(12).fill(0);
    data.days.forEach((d) => (mo[(Math.floor(d.day / 100) % 100) - 1] += metric === "words" ? (d.words || 0) : d.seconds));
    return mo.map((v, i) => ({ label: i + 1 + "月", value: v }));
  }
  const yr = {};
  data.days.forEach((d) => { const yy = Math.floor(d.day / 10000); yr[yy] = (yr[yy] || 0) + (metric === "words" ? (d.words || 0) : d.seconds); });
  return Object.keys(yr).sort().map((y) => ({ label: y, value: yr[y] }));
}
function streakStats(days) {
  const active = new Set(days.filter((d) => d.seconds > 0).map((d) => d.day));
  const today = new Date();
  let cur = 0;
  for (let d = new Date(today); active.has(ymd(d)); d = addDays(d, -1)) cur++;
  const sorted = Array.from(active).sort((a, b) => a - b).map(dateFromYmd);
  let longest = 0, run = 0, prev = null;
  sorted.forEach((d) => {
    if (prev && Math.round((d - prev) / 86400000) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prev = d;
  });
  return { current: cur, longest };
}
function contributionLevel(seconds) {
  if (!seconds) return 0;
  if (seconds < 20 * 60) return 1;
  if (seconds < 40 * 60) return 2;
  if (seconds < 60 * 60) return 3;
  if (seconds < 120 * 60) return 4;
  return 4;
}
function monthLabelsForContribution(start) {
  const labels = [];
  const end = addDays(start, 53 * 7 - 1);
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  if (cursor < start) cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  while (cursor <= end) {
    const diff = Math.floor((cursor - start) / 86400000);
    const week = Math.max(0, Math.min(52, Math.floor(diff / 7)));
    const cls = week >= 51 ? "edge" : week <= 0 ? "first" : "";
    labels.push(`<span class="mw${week} ${cls}">${cursor.getMonth() + 1}月</span>`);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return labels.join("");
}
function contributionGraph(allData) {
  const map = {};
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
function overviewStats(allData) {
  const streak = streakStats(allData.days);
  const peak = allData.days.reduce((m, d) => Math.max(m, d.seconds || 0), 0);
  return (
    '<div class="stat-overview">' +
    `<div><b>${fmtTime(allData.total_seconds)}</b><span>累计阅读时长</span></div>` +
    `<div><b>${fmtTime(peak)}</b><span>单日峰值</span></div>` +
    `<div><b>${streak.current} 天</b><span>当前连续阅读</span></div>` +
    `<div><b>${streak.longest} 天</b><span>最长连续阅读</span></div>` +
    "</div>"
  );
}
async function renderStats() {
  const bodyEl = document.getElementById("stats-body");
  const prevScrollTop = bodyEl ? bodyEl.scrollTop : 0;
  const prevHeight = bodyEl ? Math.max(bodyEl.clientHeight, bodyEl.scrollHeight) : 0;
  if (bodyEl && prevHeight > 0) {
    bodyEl.style.setProperty("--stats-refresh-height", `${prevHeight}px`);
    bodyEl.classList.add("refreshing");
  }
  document.getElementById("stats-period").textContent = statPeriodLabel();
  const navVis = statScope === "total" ? "hidden" : "visible";
  document.getElementById("stats-prev").style.visibility = navVis;
  document.getElementById("stats-next").style.visibility = navVis;
  const [from, to] = statRange();
  let data, allData;
  try {
    [data, allData] = await Promise.all([
      invoke("reading_stats_range", { from, to }),
      invoke("reading_stats_range", { from: 0, to: 99999999 }),
    ]);
  } catch (e) {
    if (bodyEl) bodyEl.classList.remove("refreshing");
    return;
  }
  const unit = { day: "天", month: "月", year: "年", total: "段时间" }[statScope];
  const statItems = [
    ["duration", "阅读时长", fmtTime(data.total_seconds)],
    ["words", "阅读字数", fmtWords(data.total_words)],
    ["speed", "平均速度", fmtReadingSpeed(data.total_words, data.total_seconds)],
    ["books", "读过", data.book_count + " 本"],
    ["finished", "读完", data.finished_count + " 本"],
    ["highlights", "高亮", data.total_highlights],
    ["notes", "批注", data.total_notes],
  ].filter((item) => statVisible[item[0]] !== false);
  const cards = statItems.length
    ? '<div class="stat-cards">' + statItems.map((item) => `<div class="stat-cell"><div class="k">${item[1]}</div><div class="v">${item[2]}</div></div>`).join("") + "</div>"
    : "";
  const quality = statsQualityNote(data);
  const qualityNote = quality ? `<div class="stats-quality-note">${statsEscapeHtml(quality)}</div>` : "";
  const chart = `<div class="stat-chart">${barChart(statBars(data), "#5aa0ff", statChartMetric)}</div>`;
  let books;
  if (data.books.length) {
    books = `<div class="stat-sec-title">这一${unit}读过的书</div>`;
    data.books.forEach((b) => {
      books +=
        `<div class="sbook"><span class="st-name">${statsEscapeHtml(b.title)} ${b.finished ? '<span class="fin">✓读完</span>' : ""}</span>` +
        `<span class="st-meta">${fmtTime(b.seconds)} · ${fmtWords(b.words)}<br>高亮 ${b.highlights} · 批注 ${b.notes}</span></div>`;
    });
  } else {
    books = '<div class="stats-empty">这段时间还没有阅读记录</div>';
  }
  if (!bodyEl) return;
  bodyEl.innerHTML = overviewStats(allData) + '<div class="stat-sec-title">近一年每日阅读热力图</div>' + contributionGraph(allData) + cards + qualityNote + chart + books;
  scheduleFrame(() => {
    const maxScrollTop = Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
    bodyEl.scrollTop = Math.min(prevScrollTop, maxScrollTop);
    bodyEl.classList.remove("refreshing");
  });
}
function openStats() {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  statScope = "day";
  statAnchor = new Date();
  document.querySelectorAll(".stats-tab").forEach((t) => t.classList.toggle("active", t.dataset.scope === "day"));
  statsModal.classList.add("show");
  renderStats();
}
function closeStats() {
  statsModal.classList.remove("show");
  statsSettings.classList.remove("show");
}
document.getElementById("stats-toolbar-btn").addEventListener("click", openStats);
document.querySelectorAll(".stats-tab").forEach((t) => {
  t.addEventListener("click", () => {
    statScope = t.dataset.scope;
    document.querySelectorAll(".stats-tab").forEach((x) => x.classList.toggle("active", x === t));
    renderStats();
  });
});
document.getElementById("stats-prev").addEventListener("click", () => statStep(-1));
document.getElementById("stats-next").addEventListener("click", () => statStep(1));
const statsSettings = document.getElementById("stats-settings");
const statsSettingsBtn = document.getElementById("stats-settings-btn");
const statsChartMetric = document.getElementById("stats-chart-metric");
const statsChartMode = document.getElementById("stats-chart-mode");
function syncStatsChartMetricControl() {
  if (!statsChartMetric || !statsChartMode) return;
  statsChartMetric.checked = statChartMetric === "words";
  statsChartMode.textContent = statChartMetric === "words" ? "字数" : "时间";
}
syncStatVisibleControls();
syncStatsChartMetricControl();
statsSettingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  statsSettings.classList.toggle("show");
});
statsSettings.addEventListener("click", (e) => e.stopPropagation());
document.querySelectorAll("[data-stat-item]").forEach((input) => {
  input.addEventListener("change", () => {
    statVisible[input.dataset.statItem] = input.checked;
    saveStatVisible();
    renderStats();
  });
});
statsChartMetric?.addEventListener("change", () => {
  statChartMetric = statsChartMetric.checked ? "words" : "time";
  localStorage.setItem(STAT_CHART_METRIC_KEY, statChartMetric);
  syncStatsChartMetricControl();
  renderStats();
});
statsModal.addEventListener("click", (e) => {
  if (e.target === statsModal) {
    closeStats();
    return;
  }
  if (!statsSettings.contains(e.target) && e.target !== statsSettingsBtn) {
    statsSettings.classList.remove("show");
  }
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

global.ReaderStatsUI = Object.freeze({
  close: () => controller().close(),
  init,
  open: () => controller().open(),
  render: () => controller().render(),
});
})(typeof window !== "undefined" ? window : globalThis);
