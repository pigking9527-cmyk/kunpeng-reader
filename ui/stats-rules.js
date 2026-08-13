// 阅读统计的纯日期规则。统计外壳负责 DOM、存储、国际化和 Tauri command；本文件
// 只处理范围、日历锚点和前后导航边界，因而可在不启动 WebView 的情况下回归。
(function exposeStatsRules(global) {
"use strict";

function ymd(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function dateFromYmd(value) {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function range(scope, anchor) {
  const date = new Date(anchor);
  const year = date.getFullYear();
  const month = date.getMonth();
  if (scope === "day") { const value = ymd(date); return [value, value]; }
  if (scope === "month") return [year * 10000 + (month + 1) * 100 + 1, year * 10000 + (month + 1) * 100 + 31];
  if (scope === "year") return [year * 10000 + 101, year * 10000 + 1231];
  return [0, 99999999];
}

function normalizeAnchor(date, scope) {
  const value = new Date(date);
  if (scope === "month") return new Date(value.getFullYear(), value.getMonth(), 1);
  if (scope === "year") return new Date(value.getFullYear(), 0, 1);
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function firstAnchor(firstReadingDay, scope) {
  return firstReadingDay ? normalizeAnchor(dateFromYmd(firstReadingDay), scope) : null;
}

function lastAnchor(now, scope) {
  return normalizeAnchor(now, scope);
}

function compareAnchors(first, second) {
  return first.getTime() - second.getTime();
}

function steppedAnchor(scope, anchor, direction) {
  const current = normalizeAnchor(anchor, scope);
  if (scope === "day") return addDays(current, direction);
  if (scope === "month") return new Date(current.getFullYear(), current.getMonth() + direction, 1);
  if (scope === "year") return new Date(current.getFullYear() + direction, 0, 1);
  return current;
}

function navigation(scope, anchor, firstReadingDay, now) {
  const showNavigation = scope !== "total";
  const earliest = firstAnchor(firstReadingDay, scope);
  const latest = lastAnchor(now, scope);
  const current = normalizeAnchor(anchor, scope);
  return {
    earliest,
    latest,
    showNavigation,
    previousDisabled: !showNavigation || !earliest || compareAnchors(current, earliest) <= 0,
    nextDisabled: !showNavigation || compareAnchors(current, latest) >= 0,
  };
}

function canStep(scope, anchor, direction, firstReadingDay, now) {
  if (scope === "total") return false;
  const candidate = steppedAnchor(scope, anchor, direction);
  const state = navigation(scope, anchor, firstReadingDay, now);
  if (direction < 0) return Boolean(state.earliest) && compareAnchors(candidate, state.earliest) >= 0;
  if (direction > 0) return compareAnchors(candidate, state.latest) <= 0;
  return false;
}

global.ReaderStatsRules = Object.freeze({
  addDays,
  canStep,
  compareAnchors,
  dateFromYmd,
  daysInMonth,
  firstAnchor,
  lastAnchor,
  navigation,
  normalizeAnchor,
  range,
  steppedAnchor,
  ymd,
});
})(typeof window !== "undefined" ? window : globalThis);
