// 语义索引状态的本地快照。只通过 ReaderSemanticStatusCache 公开，避免
// classic script 之间共享可变的顶层变量和隐式函数依赖。
(function exposeSemanticStatusCache(global) {
  "use strict";

  const STORAGE_KEY = "semanticIndexStatusV1";
  let lastStatus = load();

  function snapshot(p = {}) {
    return {
      model_ready: !!p.model_ready,
      model_id: p.model_id || "bge-small-zh-v1.5",
      model_label: p.model_label || "BGE Small 中文（默认）",
      model_supported: p.model_supported !== false,
      model_bytes: Number(p.model_bytes || 0),
      semantic_done: Number(p.semantic_done || 0),
      semantic_total: Number(p.semantic_total || 0),
      semantic_ready: !!p.semantic_ready,
      semantic_bytes: Number(p.semantic_bytes || 0),
      accelerator_done: Number(p.accelerator_done || 0),
      accelerator_total: Number(p.accelerator_total || 0),
      accelerator_ready: !!p.accelerator_ready,
      accelerator_resumable: !!p.accelerator_resumable,
      accelerator_bytes: Number(p.accelerator_bytes || 0),
      multi_profile_done: Number(p.multi_profile_done || 0),
      multi_profile_total: Number(p.multi_profile_total || 0),
      multi_profile_ready: !!p.multi_profile_ready,
      multi_profile_bytes: Number(p.multi_profile_bytes || 0),
      saved_at: Date.now(),
    };
  }

  function load() {
    try {
      const value = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "null");
      return value && typeof value === "object" ? value : null;
    } catch (e) {
      return null;
    }
  }

  function save(p = {}) {
    const next = snapshot(p);
    if (!next.model_ready && !next.semantic_total && !next.accelerator_total && !next.multi_profile_total) return;
    lastStatus = next;
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  function clear() {
    lastStatus = null;
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function update(patch = {}) {
    const base = lastStatus || snapshot({});
    lastStatus = Object.assign({}, base, patch, { saved_at: Date.now() });
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(lastStatus));
    } catch (e) {}
  }

  // 只有后端明确表示“刷新中”时才使用旧快照。正常返回的 0 是有效值，不能用
  // `a || b` 回填，否则删除索引后会把旧进度重新显示出来。
  function merge(p = {}) {
    if (!p.status_refreshing || !lastStatus) return p;
    if (p.model_id && lastStatus.model_id && p.model_id !== lastStatus.model_id) return p;
    const fallback = (key) => p[key] == null ? lastStatus[key] : p[key];
    return Object.assign({}, lastStatus, p, {
      model_ready: fallback("model_ready"),
      model_id: fallback("model_id") || "bge-small-zh-v1.5",
      model_label: fallback("model_label") || "BGE Small 中文（默认）",
      model_supported: fallback("model_supported") !== false,
      model_bytes: fallback("model_bytes") || 0,
      semantic_done: fallback("semantic_done") || 0,
      semantic_total: fallback("semantic_total") || 0,
      semantic_ready: fallback("semantic_ready"),
      semantic_bytes: fallback("semantic_bytes") || 0,
      accelerator_done: fallback("accelerator_done") || 0,
      accelerator_total: fallback("accelerator_total") || 0,
      accelerator_ready: fallback("accelerator_ready"),
      accelerator_resumable: fallback("accelerator_resumable"),
      accelerator_bytes: fallback("accelerator_bytes") || 0,
      multi_profile_done: fallback("multi_profile_done") || 0,
      multi_profile_total: fallback("multi_profile_total") || 0,
      multi_profile_ready: fallback("multi_profile_ready"),
      multi_profile_bytes: fallback("multi_profile_bytes") || 0,
    });
  }

  global.ReaderSemanticStatusCache = Object.freeze({
    clear,
    get: () => lastStatus,
    merge,
    save,
    snapshot,
    update,
  });
})(typeof window !== "undefined" ? window : globalThis);
