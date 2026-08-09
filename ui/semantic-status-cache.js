// 语义索引状态的本地快照。只通过 ReaderSemanticStatusCache 公开，避免
// classic script 之间共享可变的顶层变量和隐式函数依赖。
(function exposeSemanticStatusCache(global) {
  "use strict";

  // V3 intentionally does not import V1/V2 snapshots. Earlier versions could cache a
  // provisional "all files exist" result as completed before metadata verification.
  const STORAGE_KEY = "semanticIndexStatusByModelV3";
  const ACTIVE_KEY = "semanticIndexStatusActiveModelV3";
  let activeModelId = global.localStorage.getItem(ACTIVE_KEY) || "bge-small-zh-v1.5";
  let statuses = load();

  function snapshot(p = {}) {
    return {
      // 关闭语义设置只是关闭弹窗，后台任务仍在同一 WebView 进程中继续。
      // 保存这组运行态可让用户立刻重开时仍看到“正在建立”，并禁用重复的
      // 建立按钮；随后异步状态请求会用 Rust 的实时数据覆盖它。
      building: !!p.building,
      model_downloading: !!p.model_downloading,
      reranker_loading: !!p.reranker_loading,
      vector_pause_requested: !!p.vector_pause_requested,
      vector_paused: !!p.vector_paused,
      active_task: p.active_task || "",
      done: Number(p.done || 0),
      total: Number(p.total || 0),
      shard_done: Number(p.shard_done || 0),
      shard_total: Number(p.shard_total || 0),
      current: p.current || "",
      error: p.error || "",
      model_ready: !!p.model_ready,
      model_id: p.model_id || activeModelId || "bge-small-zh-v1.5",
      model_label: p.model_label || "BGE Small 中文（默认）",
      model_supported: p.model_supported !== false,
      model_bytes: Number(p.model_bytes || 0),
      // 文件已下载可跨弹窗复用；“已加载”仍由 Rust 的当前进程状态决定，
      // 不持久化，避免重启软件后把未载入的模型误显示为已就绪。
      reranker_downloaded: !!p.reranker_downloaded,
      reranker_partial: !!p.reranker_partial,
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
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      return {};
    } catch (e) {
      return {};
    }
  }

  function persist() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
      global.localStorage.setItem(ACTIVE_KEY, activeModelId);
    } catch (e) {}
  }

  function use(modelId) {
    if (modelId) activeModelId = modelId;
    persist();
    return get();
  }

  function get(modelId = activeModelId) {
    return statuses[modelId] || null;
  }

  function save(p = {}) {
    const next = snapshot(p);
    if (!next.model_ready && !next.semantic_total && !next.accelerator_total && !next.multi_profile_total) return;
    activeModelId = next.model_id;
    statuses[next.model_id] = next;
    persist();
  }

  function clear(modelId = activeModelId) {
    delete statuses[modelId];
    persist();
  }

  function update(patch = {}) {
    const modelId = patch.model_id || activeModelId;
    const base = get(modelId) || snapshot({ model_id: modelId });
    statuses[modelId] = Object.assign({}, base, patch, { model_id: modelId, saved_at: Date.now() });
    activeModelId = modelId;
    persist();
  }

  // 只有后端明确表示“刷新中”时才使用旧快照。正常返回的 0 是有效值，不能用
  // `a || b` 回填，否则删除索引后会把旧进度重新显示出来。
  function merge(p = {}) {
    const lastStatus = get(p.model_id || activeModelId);
    if (!p.status_refreshing || !lastStatus) return p;
    const fallback = (key) => p[key] == null ? lastStatus[key] : p[key];
    return Object.assign({}, lastStatus, p, {
      model_ready: fallback("model_ready"),
      model_id: fallback("model_id") || "bge-small-zh-v1.5",
      model_label: fallback("model_label") || "BGE Small 中文（默认）",
      model_supported: fallback("model_supported") !== false,
      model_bytes: fallback("model_bytes") || 0,
      reranker_downloaded: fallback("reranker_downloaded"),
      reranker_partial: fallback("reranker_partial"),
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
    get,
    merge,
    save,
    snapshot,
    update,
    use,
  });
})(typeof window !== "undefined" ? window : globalThis);
