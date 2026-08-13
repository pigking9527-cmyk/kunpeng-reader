// 资讯页的无副作用规则。新闻外壳保留 DOM、Tauri command、本机存储和
// 国际化生命周期；本文件只处理可独立回归的来源选择与不可信资讯字段。
(function exposeNewsRules(global) {
"use strict";

function text(value) {
  return String(value == null ? "" : value);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

function safeImageDataUrl(value) {
  const image = text(value).trim();
  return /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/i.test(image) ? image : "";
}

function resultItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.news)) return result.news;
  return [];
}

function previewAttempted(item) {
  return item?.previewAttempted === true
    || item?.preview_attempted === true
    || Boolean(safeImageDataUrl(item?.previewDataUrl || item?.preview_data_url));
}

function hasPendingPreviews(result) {
  return resultItems(result).some((item) => !previewAttempted(item)
    && Boolean(safeHttpUrl(item?.url || item?.link || item?.href)));
}

function defaultSourceIds(catalog) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((source) => source?.defaultEnabled || source?.default_enabled)
    .map((source) => text(source?.id));
}

function allowedSourceIds(ids, catalog, maxSources = 24) {
  const allowed = new Set((Array.isArray(catalog) ? catalog : []).map((source) => text(source?.id)));
  const seen = new Set();
  return (Array.isArray(ids) ? ids : [])
    .map(text)
    .filter((id) => allowed.has(id) && !seen.has(id) && (seen.add(id), true))
    .slice(0, Math.max(0, maxSources));
}

function normalizeTiebaBars(values, maxBars = 8) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => text(value).trim().replace(/吧$/, "").trim())
    .filter((name) => name && name.length <= 48 && !/[\u0000-\u001f\u007f]/.test(name)
      && !seen.has(name) && (seen.add(name), true))
    .slice(0, Math.max(0, maxBars));
}

function enabledTiebaBars(values, bars, maxBars = 8) {
  const available = new Set(normalizeTiebaBars(bars, maxBars));
  return normalizeTiebaBars(values, maxBars).filter((name) => available.has(name));
}

global.ReaderNewsRules = Object.freeze({
  allowedSourceIds,
  defaultSourceIds,
  enabledTiebaBars,
  hasPendingPreviews,
  normalizeTiebaBars,
  previewAttempted,
  resultItems,
  safeHttpUrl,
  safeImageDataUrl,
  text,
});
})(typeof window !== "undefined" ? window : globalThis);
