// 阅读问题记录：仅在内存中保留最近一分钟的脱敏交互轨迹。
// 不记录正文、选中文本、链接地址、文件路径、账号或 API 凭据。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderBugTrace = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const WINDOW_MS = 2 * 60 * 1000;
  const MAX_EVENTS = 320;
  const SAFE_EVENT_KEYS = new Set([
    "source", "outcome", "zone", "target", "direction", "key", "overlay",
    "chapter", "page", "progress", "chapter_frac", "anchor_offset", "sequence", "total_chapters", "x_pct",
    "y_pct", "duration_ms", "format", "reason", "open", "ready", "is_pdf",
    "frame_ready", "immersive", "loading", "pages", "turn_id", "input",
    "before_chapter", "before_page", "after_chapter", "after_page",
    "chapter_pending", "chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "flow_mode", "page_mode",
    // 图片分页只保存布局数值和模式，不保存正文、图片地址或本机文件路径。
    "image_mode", "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
    "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text", "image_near_top", "image_text_before", "image_probed",
    // 分页空白诊断：只保存像素几何，绝不保存文字、DOM 路径或 URL。
    "layout_fast", "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
  ]);
  const BLOCKERS = new Set(["selection", "drag", "link", "overlay", "chapter_pending", "turn_busy"]);
  const events = [];
  let contextProvider = () => ({});
  let frozenSnapshot = null;
  let checkpointTimer = null;
  let checkpointInFlight = false;
  let checkpointPending = false;
  let cachedVersion = "";
  let cachedRuntimeDiagnostics = null;
  function traceText(key, fallback, values) {
    const value = root.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  }

  function safeLabel(value, fallback) {
    const label = String(value || "").trim();
    return /^[a-z0-9_.:-]{1,64}$/i.test(label) ? label : (fallback || "other");
  }

  function safeNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return Math.max(min, Math.min(max, Math.round(number * 1000) / 1000));
  }

  function cleanEventDetail(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    Object.keys(value).forEach((key) => {
      if (!SAFE_EVENT_KEYS.has(key)) return;
      const item = value[key];
      if (typeof item === "boolean") result[key] = item;
      else if (typeof item === "number") {
        const number = key === "anchor_offset"
          ? safeNumber(item, 0, 1_000_000_000)
          : safeNumber(item, -1_000_000, 1_000_000);
        if (number !== undefined) result[key] = number;
      } else if (typeof item === "string") result[key] = safeLabel(item);
    });
    return result;
  }

  function prune(now) {
    const cutoff = now - WINDOW_MS;
    while (events.length && events[0].at_ms < cutoff) events.shift();
    while (events.length > MAX_EVENTS) events.shift();
  }

  function record(type, detail) {
    const now = Date.now();
    const cleanType = safeLabel(type);
    prune(now);
    events.push({ at_ms: now, type: cleanType, detail: cleanEventDetail(detail) });
    prune(now);
    if (cleanType !== "capture") checkpoint();
  }

  function cleanBook(value) {
    const book = value && typeof value === "object" ? value : {};
    return {
      title: String(book.title || "").slice(0, 200),
      format: safeLabel(book.format || "unknown"),
    };
  }

  function cleanReaderState(value) {
    const state = value && typeof value === "object" ? value : {};
    return {
      chapter: safeNumber(state.chapter, 0, 1_000_000) || 0,
      progress: safeNumber(state.progress, 0, 100) || 0,
      chapter_frac: safeNumber(state.chapter_frac, 0, 1) || 0,
      total_chapters: safeNumber(state.total_chapters, 1, 1_000_000) || 1,
      overlay: safeLabel(state.overlay || "none"),
      toolbar: safeLabel(state.toolbar || "normal"),
      frame_ready: !!state.frame_ready,
      loading: !!state.loading,
      is_pdf: !!state.is_pdf,
      immersive: !!state.immersive,
      viewport: {
        width: safeNumber(state.viewport?.width, 0, 100_000) || 0,
        height: safeNumber(state.viewport?.height, 0, 100_000) || 0,
      },
    };
  }

  function systemSnapshot() {
    const nav = root.navigator || {};
    const screen = root.screen || {};
    return {
      user_agent: String(nav.userAgent || "").slice(0, 512),
      platform: String(nav.platform || "").slice(0, 80),
      language: String(nav.language || "").slice(0, 32),
      screen: {
        width: safeNumber(screen.width, 0, 100_000) || 0,
        height: safeNumber(screen.height, 0, 100_000) || 0,
        pixel_ratio: safeNumber(root.devicePixelRatio, 0, 16) || 1,
      },
    };
  }

  function lastBlocker(recent) {
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const outcome = recent[index]?.detail?.outcome;
      if (BLOCKERS.has(outcome)) return outcome;
    }
    return "none";
  }

  async function capture(source = "manual") {
    record("capture", { source: safeLabel(source, "manual") });
    const capturedAt = Date.now();
    prune(capturedAt);
    let context = {};
    try { context = contextProvider() || {}; } catch (_) { context = {}; }
    let version = cachedVersion;
    let runtimeDiagnostics = cachedRuntimeDiagnostics;
    const invoke = root.__TAURI__?.core?.invoke;
    const refreshRuntime = source !== "checkpoint" || (!cachedVersion && cachedRuntimeDiagnostics === null);
    if (typeof invoke === "function" && refreshRuntime) {
      try { version = cachedVersion = String(await invoke("app_version")); } catch (_) {}
      try { runtimeDiagnostics = cachedRuntimeDiagnostics = await invoke("runtime_diagnostics"); } catch (_) {
        runtimeDiagnostics = cachedRuntimeDiagnostics = { unavailable: true };
      }
    }
    const recent = events.map((event) => ({
      at: new Date(event.at_ms).toISOString(),
      age_ms: capturedAt - event.at_ms,
      type: event.type,
      detail: event.detail,
    }));
    frozenSnapshot = {
      schema_version: 1,
      captured_at: new Date(capturedAt).toISOString(),
      window_ms: WINDOW_MS,
      privacy: "No book text, selection text, URLs, file paths, account data, or API credentials.",
      version,
      system: systemSnapshot(),
      book: cleanBook(context.book),
      reader_state: cleanReaderState(context.state),
      last_click_blocker: lastBlocker(recent),
      runtime_diagnostics: runtimeDiagnostics,
      events: recent,
    };
    return frozenSnapshot;
  }

  // 阅读窗口关闭后其内存会消失，因此在操作停止片刻后把最近快照交给
  // 主窗口暂存。只传现有的脱敏结构，不包含正文、路径或表单内容。
  function checkpoint(delayMs = 350) {
    const eventApi = root.__TAURI__?.event;
    const invoke = root.__TAURI__?.core?.invoke;
    if ((!eventApi?.emit && typeof invoke !== "function") || typeof root.setTimeout !== "function") return;
    if (checkpointTimer) root.clearTimeout(checkpointTimer);
    checkpointTimer = root.setTimeout(async () => {
      checkpointTimer = null;
      if (checkpointInFlight) {
        checkpointPending = true;
        return;
      }
      checkpointInFlight = true;
      try {
        const snapshot = await capture("checkpoint");
        const writes = [];
        if (eventApi?.emit) writes.push(eventApi.emit("reader-bug-trace-checkpoint", { snapshot }));
        if (typeof invoke === "function") writes.push(invoke("problem_trace_checkpoint", { snapshot }));
        await Promise.allSettled(writes);
      } catch (_) {
        // 问题记录不能影响阅读；反馈页仍可通过即时请求获取。
      } finally {
        checkpointInFlight = false;
        if (checkpointPending) {
          checkpointPending = false;
          checkpoint(100);
        }
      }
    }, Math.max(0, Number(delayMs) || 0));
  }

  function ingestPageEvent(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    record("page_" + safeLabel(payload.kind), payload);
  }

  function reset() {
    events.length = 0;
    frozenSnapshot = null;
    record("trace_started", { source: "manual" });
  }

  function setContextProvider(provider) {
    if (typeof provider === "function") contextProvider = provider;
  }

  function snapshotForTests(now) {
    prune(Number.isFinite(now) ? now : Date.now());
    return events.map((event) => ({ ...event, detail: { ...event.detail } }));
  }

  function wireUi() {
    const doc = root.document;
    if (!doc) return;
    const modal = doc.getElementById("bug-trace-modal");
    const openButton = doc.getElementById("bug-trace-btn");
    const closeButton = doc.getElementById("bug-trace-close");
    const meta = doc.getElementById("bug-trace-meta");
    const eventList = doc.getElementById("bug-trace-events");
    const status = doc.getElementById("bug-trace-status");

    function appendMeta(label, value) {
      const row = doc.createElement("div");
      row.className = "bug-trace-meta-row";
      const key = doc.createElement("span");
      key.textContent = label;
      const content = doc.createElement("strong");
      content.textContent = String(value ?? "");
      row.append(key, content);
      meta.appendChild(row);
    }

    function render(snapshot) {
      meta.innerHTML = "";
      eventList.innerHTML = "";
      appendMeta(traceText("traceVersionSystem", "版本 / 系统"), "v" + (snapshot.version || "?") + " · " + (snapshot.system.platform || "unknown"));
      appendMeta(traceText("traceOpenBook", "打开图书"), snapshot.book.title || traceText("traceUnavailable", "未获取"));
      appendMeta(traceText("tracePosition", "位置"), traceText("tracePositionValue", "第 {chapter} 章 · {progress}%", { chapter: snapshot.reader_state.chapter + 1, progress: snapshot.reader_state.progress.toFixed(1) }));
      appendMeta(traceText("traceOverlay", "当前浮层"), snapshot.reader_state.overlay);
      appendMeta(traceText("traceBlocker", "最近一次点击拦截"), snapshot.last_click_blocker === "none" ? traceText("traceNone", "未发现") : snapshot.last_click_blocker);
      snapshot.events.slice().reverse().forEach((event) => {
        const row = doc.createElement("div");
        row.className = "bug-trace-event";
        const time = doc.createElement("time");
        time.textContent = "-" + Math.round(event.age_ms / 100) / 10 + "s";
        const name = doc.createElement("strong");
        name.textContent = event.type;
        const detail = doc.createElement("code");
        detail.textContent = JSON.stringify(event.detail);
        row.append(time, name, detail);
        eventList.appendChild(row);
      });
      status.textContent = traceText("traceFrozen", "已冻结最近 60 秒，共 {count} 条；不含正文、选中文字、链接和文件路径。", { count: snapshot.events.length });
    }

    async function open() {
      if (!modal) return;
      doc.getElementById("settings")?.classList.remove("show");
      modal.classList.add("show");
      status.textContent = traceText("traceFreezing", "正在冻结最近一分钟状态…");
      render(await capture());
    }

    async function ensureSnapshot() {
      return frozenSnapshot || capture();
    }

    openButton?.addEventListener("click", open);
    closeButton?.addEventListener("click", () => modal?.classList.remove("show"));
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.remove("show");
    });
    doc.getElementById("bug-trace-export")?.addEventListener("click", async () => {
      const snapshot = await ensureSnapshot();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = doc.createElement("a");
      link.href = url;
      link.download = "kunpeng-reader-bug-state-" + snapshot.captured_at.replace(/[:.]/g, "-") + ".json";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = traceText("traceExported", "问题记录 JSON 已导出。");
    });
    doc.getElementById("bug-trace-copy")?.addEventListener("click", async () => {
      const snapshot = await ensureSnapshot();
      const text = JSON.stringify(snapshot, null, 2);
      try {
        await root.navigator.clipboard.writeText(text);
        status.textContent = traceText("traceCopied", "问题记录已复制。");
      } catch (_) {
        status.textContent = traceText("traceCopyFailed", "复制失败，请使用“导出 JSON”。");
      }
    });
    doc.getElementById("bug-trace-reset")?.addEventListener("click", () => {
      reset();
      meta.innerHTML = "";
      eventList.innerHTML = "";
      status.textContent = traceText("traceReset", "已清空，重新记录接下来一分钟。");
    });
    root.addEventListener("reader-language-changed", () => {
      if (frozenSnapshot && modal?.classList.contains("show")) render(frozenSnapshot);
    });

    doc.addEventListener("click", (event) => {
      const target = event.target?.closest?.("button,[role=button],input,select,textarea,a");
      if (!target) return;
      record("shell_click", {
        source: "reader_shell",
        target: target.id || target.tagName?.toLowerCase() || "control",
      });
    }, true);
    root.addEventListener("error", (event) => {
      record("window_error", { reason: event.error?.name || "error" });
    });
    root.addEventListener("unhandledrejection", (event) => {
      record("unhandled_rejection", { reason: event.reason?.name || "error" });
    });
  }

  record("trace_started", { source: "reader_open" });
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", wireUi);
    else wireUi();
  }

  return Object.freeze({
    WINDOW_MS,
    MAX_EVENTS,
    record,
    ingestPageEvent,
    capture,
    checkpoint,
    reset,
    setContextProvider,
    _snapshotForTests: snapshotForTests,
  });
});
