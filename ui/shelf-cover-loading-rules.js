// 书架封面加载的无副作用规则。DOM 创建和浏览器加载属性写入仍由 shelf-ui.js 持有。
(function exposeShelfCoverLoadingRules(global) {
"use strict";

const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24;
const MAX_FIRST_SCREEN_COVER_COUNT = 160;
const GRID_CARD_WIDTH = 158;
const GRID_GAP = 18;
const GRID_HORIZONTAL_PADDING = 40;
const GRID_CARD_ROW_HEIGHT = 208;
const LIST_CARD_ROW_HEIGHT = 108;
const GRID_VERTICAL_PADDING = 40;

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function fixedGridColumns(value) {
  const columns = Number(value);
  return Number.isInteger(columns) && columns > 0 ? columns : 0;
}

function estimateFirstScreenCoverCount(options = {}) {
  const width = finiteDimension(options.width);
  const height = finiteDimension(options.height);
  if (!width || !height) return 0;
  if (options.layout === "list") return Math.max(1, Math.ceil(height / LIST_CARD_ROW_HEIGHT));

  const columns = fixedGridColumns(options.gridColumns)
    || Math.max(1, Math.floor((Math.max(0, width - GRID_HORIZONTAL_PADDING) + GRID_GAP) / (GRID_CARD_WIDTH + GRID_GAP)));
  const rows = Math.max(1, Math.ceil(Math.max(0, height - GRID_VERTICAL_PADDING) / GRID_CARD_ROW_HEIGHT));
  return Math.min(MAX_FIRST_SCREEN_COVER_COUNT, columns * rows);
}

function firstScreenCoverCount(options = {}) {
  return Math.max(DEFAULT_FIRST_SCREEN_COVER_COUNT, estimateFirstScreenCoverCount(options));
}

function coverLoadPriority(index, firstScreenCount) {
  const eager = Number(index) >= 0 && Number(index) < Number(firstScreenCount);
  return eager
    ? Object.freeze({ decoding: "sync", fetchPriority: "high", loading: "eager" })
    : Object.freeze({ decoding: "async", fetchPriority: "auto", loading: "lazy" });
}

global.ReaderShelfCoverLoadingRules = Object.freeze({
  coverLoadPriority,
  estimateFirstScreenCoverCount,
  firstScreenCoverCount,
});
})(typeof window !== "undefined" ? window : globalThis);
