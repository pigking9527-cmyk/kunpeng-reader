// 资讯瀑布流的无副作用布局规则。资讯外壳负责测量 DOM、创建卡片和
// 图片生命周期；本文件只根据已知尺寸和文本投影给出稳定的列分配。
(function exposeNewsLayoutRules(global) {
"use strict";

function text(value) {
  return String(value == null ? "" : value);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function masonryColumnCount(width, previousCount = 0, { minimumCardWidth = 210, gap = 13 } = {}) {
  const safeWidth = Number(width);
  if (!Number.isFinite(safeWidth) || safeWidth <= 0) return Math.max(1, positiveInteger(previousCount, 1));
  const minimum = positiveInteger(minimumCardWidth, 210);
  const spacing = Math.max(0, Number(gap) || 0);
  return Math.max(1, Math.floor((safeWidth + spacing) / (minimum + spacing)));
}

function estimateCardHeight({ title = "", summary = "", hasImage = false } = {}, { width = 210, columnCount = 1, gap = 13 } = {}) {
  const columns = positiveInteger(columnCount, 1);
  const spacing = Math.max(0, Number(gap) || 0);
  const availableWidth = Math.max(160, (Math.max(0, Number(width) || 0) - spacing * (columns - 1)) / columns - 40);
  const charsPerLine = Math.max(10, Math.floor(availableWidth / 16));
  const lineCount = (value, maximum) => Math.min(maximum, Math.max(1, Math.ceil(Array.from(text(value)).length / charsPerLine)));
  const titleLines = lineCount(title, 4);
  const summaryText = text(summary).trim();
  const summaryLines = summaryText ? lineCount(summaryText, 3) : 0;
  return 68 + titleLines * 27 + summaryLines * 21 + (hasImage ? 146 : 0) + 44;
}

function balancedColumnIndexes(estimatedHeights, columnCount) {
  const count = positiveInteger(columnCount, 1);
  const columns = Array.from({ length: count }, () => 0);
  return (Array.isArray(estimatedHeights) ? estimatedHeights : []).map((value) => {
    let target = 0;
    for (let index = 1; index < columns.length; index += 1) {
      if (columns[index] < columns[target]) target = index;
    }
    const height = Number(value);
    columns[target] += Number.isFinite(height) && height > 0 ? height : 0;
    return target;
  });
}

global.ReaderNewsLayoutRules = Object.freeze({
  balancedColumnIndexes,
  estimateCardHeight,
  masonryColumnCount,
});
})(typeof window !== "undefined" ? window : globalThis);
