// 书架的无副作用规则。DOM、Tauri command 与本机存储生命周期仍由 shelf-ui.js 持有。
(function exposeShelfUiRules(global) {
"use strict";

const GRID_COL_MIN = 1;
const GRID_COL_MAX = 12;
const PALETTE = [
  "#3e5a8c", "#8c4650", "#46785f", "#82643c",
  "#5f5082", "#3c6e78", "#78556e", "#5a6446",
];

function parseGridColumns(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(GRID_COL_MIN, Math.min(GRID_COL_MAX, parsed));
}

function organizationName(value) {
  return String(value || "").trim();
}

function organizationKey(value) {
  return organizationName(value).toLocaleLowerCase("zh-CN");
}

function readStatus(book) {
  const progress = book.progress || 0;
  if (progress >= 99) return "done";
  if (progress < 1) return "unread";
  return "reading";
}

function colorFor(title) {
  let hash = 2166136261;
  const text = String(title || "");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

function bookRenderKey(book, options = {}) {
  return [
    book.id || "",
    book.title || "",
    book.cover || "",
    book.progress || 0,
    book.rating || 0,
    book.missing ? 1 : 0,
    options.showCoverProgress ? 1 : 0,
    options.showCoverRating ? 1 : 0,
  ].join("\u001f");
}

function sortBooks(list, options = {}) {
  const sortKey = options.sortKey || "title";
  const bookFileSizes = options.bookFileSizes || new Map();
  const result = list.slice();
  result.sort((left, right) => {
    switch (sortKey) {
      case "author":
        return (left.author || "").localeCompare(right.author || "", "zh")
          || left.title.localeCompare(right.title, "zh");
      case "added":
        return (right.added_at || 0) - (left.added_at || 0);
      case "dir":
        return (left.path || "").localeCompare(right.path || "", "zh");
      case "read":
        return (right.last_read_at || 0) - (left.last_read_at || 0)
          || left.title.localeCompare(right.title, "zh");
      case "reading-time":
        return (right.reading_seconds || 0) - (left.reading_seconds || 0)
          || left.title.localeCompare(right.title, "zh");
      case "size":
        return (bookFileSizes.get(String(right.id)) || 0) - (bookFileSizes.get(String(left.id)) || 0)
          || left.title.localeCompare(right.title, "zh");
      case "progress":
        return (right.progress || 0) - (left.progress || 0)
          || left.title.localeCompare(right.title, "zh");
      default: {
        const leftInitial = !left.initial || left.initial === "#" ? "~" : left.initial;
        const rightInitial = !right.initial || right.initial === "#" ? "~" : right.initial;
        return leftInitial.localeCompare(rightInitial) || left.title.localeCompare(right.title, "zh");
      }
    }
  });
  return result;
}

function matchesShelfSearch(book, searchQuery) {
  if (!searchQuery) return true;
  return (book.title || "").toLowerCase().includes(searchQuery)
    || (book.author || "").toLowerCase().includes(searchQuery)
    || (book.description || "").toLowerCase().includes(searchQuery);
}

function hasActiveShelfFilters(filters) {
  return filters.minRating > 0
    || filters.tagFilter.size > 0
    || filters.collectionFilter.size > 0
    || !(filters.readingFilter.unread && filters.readingFilter.reading && filters.readingFilter.done);
}

function matchesOrganizationSelection(book, selectedTags, selectedCollections, mode) {
  if (!selectedTags.size && !selectedCollections.size) return true;
  const bookTags = new Set((book.tags || []).map(organizationKey));
  const bookCollections = new Set((book.collections || []).map(organizationKey));
  if (mode === "all") {
    return Array.from(selectedTags).every((key) => bookTags.has(key))
      && Array.from(selectedCollections).every((key) => bookCollections.has(key));
  }
  return Array.from(selectedTags).some((key) => bookTags.has(key))
    || Array.from(selectedCollections).some((key) => bookCollections.has(key));
}

function matchesOrganizationFilters(book, filters) {
  return matchesOrganizationSelection(book, filters.tagFilter, filters.collectionFilter, filters.organizationMatchMode);
}

function currentList(books, filters) {
  if (filters.searchQuery) return books.filter((book) => matchesShelfSearch(book, filters.searchQuery));
  let result = books;
  if (!(filters.readingFilter.unread && filters.readingFilter.reading && filters.readingFilter.done)) {
    result = result.filter((book) => filters.readingFilter[readStatus(book)]);
  }
  if (filters.minRating > 0) result = result.filter((book) => (book.rating || 0) >= filters.minRating);
  return result.filter((book) => matchesOrganizationFilters(book, filters));
}

// 自定义滚动条只负责把内容/视口比例投影为 thumb，或把指针坐标投影回
// scrollTop。它不读取 DOM、不修改样式，也不持有拖拽状态。
function scrollbarGeometry(options = {}) {
  const viewport = Number(options.viewport) || 0;
  const total = Number(options.total) || 0;
  const trackHeight = Number(options.trackHeight) || 0;
  const scrollTop = Number(options.scrollTop) || 0;
  const minThumbHeight = Number(options.minThumbHeight) || 28;
  const maxScroll = Math.max(0, total - viewport);
  if (viewport <= 0 || maxScroll <= 1) return Object.freeze({ visible: false });
  const thumbHeight = Math.max(minThumbHeight, Math.round((viewport / total) * trackHeight));
  const maxTop = Math.max(0, trackHeight - thumbHeight);
  return Object.freeze({
    maxScroll,
    maxTop,
    thumbHeight,
    top: maxScroll ? Math.round((scrollTop / maxScroll) * maxTop) : 0,
    visible: true,
  });
}

function scrollbarTrackScrollTop(options = {}) {
  const trackHeight = Number(options.trackHeight) || 0;
  const thumbHeight = Number(options.thumbHeight) || 0;
  const maxTop = Math.max(1, trackHeight - thumbHeight);
  const maxScroll = Math.max(1, (Number(options.total) || 0) - (Number(options.viewport) || 0));
  const targetTop = Math.min(maxTop, Math.max(0, (Number(options.clientY) || 0) - (Number(options.rectTop) || 0) - thumbHeight / 2));
  return (targetTop / maxTop) * maxScroll;
}

function scrollbarDragScrollTop(options = {}) {
  const maxTop = Math.max(1, (Number(options.trackHeight) || 0) - (Number(options.thumbHeight) || 0));
  const maxScroll = Math.max(1, (Number(options.total) || 0) - (Number(options.viewport) || 0));
  return (Number(options.dragStartScrollTop) || 0)
    + (((Number(options.clientY) || 0) - (Number(options.dragStartY) || 0)) / maxTop) * maxScroll;
}

global.ReaderShelfRules = Object.freeze({
  bookRenderKey,
  colorFor,
  currentList,
  hasActiveShelfFilters,
  matchesOrganizationSelection,
  organizationKey,
  organizationName,
  parseGridColumns,
  readStatus,
  scrollbarDragScrollTop,
  scrollbarGeometry,
  scrollbarTrackScrollTop,
  sortBooks,
});
})(typeof window !== "undefined" ? window : globalThis);
