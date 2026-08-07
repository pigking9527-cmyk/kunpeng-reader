// 反馈附件用的问题记录桥接。阅读器窗口与主窗口持续保留脱敏的最近两分钟轨迹，
// 仅在用户点“提交问题记录”时向主窗口返回快照。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderProblemTraceUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const WINDOW_MS = 2 * 60 * 1000;
  const MAX_SHELL_EVENTS = 320;
  const shellEvents = [];
  let latestReaderSnapshot = null;

  function safeLabel(value, fallback = "other") {
    const label = String(value || "").trim();
    return /^[a-z0-9_.:-]{1,80}$/i.test(label) ? label : fallback;
  }

  function pruneShellEvents(now = Date.now()) {
    const cutoff = now - WINDOW_MS;
    while (shellEvents.length && shellEvents[0].at_ms < cutoff) shellEvents.shift();
    while (shellEvents.length > MAX_SHELL_EVENTS) shellEvents.shift();
  }

  function traceArea(target) {
    const id = String(target?.id || "");
    if (/library-ai/i.test(id) || target?.closest?.("#library-ai-page")) return "library_qa";
    if (/newsnow/i.test(id) || target?.closest?.("#newsnow-page,#newsnow-reader")) return "news";
    if (/stats|reading-timeline/i.test(id) || target?.closest?.("#stats-modal,#reading-timeline-modal")) return "reading_stats";
    if (/bookmark|favorite|collection|book-organization/i.test(id) || target?.closest?.("#book-info-modal,#book-organization-modal")) return "book_organization";
    if (/settings|api-|dict|animation|auto-import|recommendation/i.test(id) || target?.closest?.("#fp-settings-modal,#api-settings-modal,#animation-settings-modal,#external-dict-modal,#auto-import-modal,#reader-recommendation-settings-modal,#newsnow-settings-modal")) return "settings";
    if (/shelf|book-card|mi-|filter|sort/i.test(id) || target?.closest?.("#shelf,#filter-panel")) return "shelf";
    return "main_window";
  }

  function pushShellEvent(type, detail) {
    const now = Date.now();
    pruneShellEvents(now);
    shellEvents.push({
      at_ms: now,
      type: safeLabel(type, "shell_operation"),
      detail,
    });
    pruneShellEvents(now);
  }

  function recordShellOperation(kind, target) {
    pushShellEvent("shell_" + safeLabel(kind, "operation"), {
      source: "main_window",
      area: traceArea(target),
      target: safeLabel(target?.dataset?.problemTarget || target?.id || target?.tagName?.toLowerCase(), "control"),
    });
  }

  function recordShelfBookOpen(outcome, input) {
    pushShellEvent("book_open", {
      source: "main_window",
      area: "shelf",
      outcome: safeLabel(outcome),
      input: safeLabel(input),
    });
  }

  function wireShellOperations(doc = root.document) {
    if (!doc || doc.__problemTraceShellWired) return;
    doc.__problemTraceShellWired = true;
    const record = (event, kind) => {
      const target = event.target?.closest?.("button,[role=button],input,select,textarea,a,[contenteditable=true],[data-problem-target]");
      if (!target || target.matches("textarea,[contenteditable=true]")) return;
      recordShellOperation(kind, target);
    };
    doc.addEventListener("click", (event) => record(event, "click"), true);
    doc.addEventListener("change", (event) => record(event, "change"), true);
  }

  function summarizeDurations(values) {
    const samples = values.filter((value) => Number.isFinite(value) && value >= 0);
    if (!samples.length) return { count: 0, min_ms: 0, avg_ms: 0, max_ms: 0, latest_ms: 0 };
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
      count: samples.length,
      min_ms: Number(Math.min(...samples).toFixed(1)),
      avg_ms: Number((total / samples.length).toFixed(1)),
      max_ms: Number(Math.max(...samples).toFixed(1)),
      latest_ms: Number(samples.at(-1).toFixed(1)),
    };
  }

  function summarizeReaderPerformance(events) {
    const durations = (predicate) => events
      .filter(predicate)
      .map((event) => Number(event.detail?.duration_ms));
    return {
      window_build: summarizeDurations(durations((event) =>
        event.type === "reader_window" && event.detail?.phase === "open_build" && event.detail?.outcome === "ok")),
      book_info: summarizeDurations(durations((event) =>
        event.type === "reader_performance" && event.detail?.stage === "book_info")),
      first_page_ready: summarizeDurations(durations((event) =>
        event.type === "reader_performance" && event.detail?.stage === "frame_ready")),
      close_destroy: summarizeDurations(durations((event) =>
        event.type === "reader_window" && event.detail?.phase === "destroyed" && event.detail?.outcome === "closed")),
    };
  }

  function startupDuration(detail) {
    const match = String(detail || "").match(/^\s*(\d+(?:\.\d+)?)ms\b/i);
    return match ? Number(match[1]) : NaN;
  }

  function summarizeStartupPerformance(logs) {
    const sessions = new Map();
    (Array.isArray(logs) ? logs : []).forEach((entry) => {
      const session = String(entry?.session || "");
      if (!session) return;
      if (!sessions.has(session)) sessions.set(session, {});
      if (entry?.name === "startup" && ["webview_script", "dom_ready", "shelf_painted"].includes(entry?.phase)) {
        sessions.get(session)[entry.phase] = startupDuration(entry.detail);
      }
    });
    const values = (stage) => [...sessions.values()].map((session) => session[stage]);
    return {
      sessions: sessions.size,
      process_to_webview_script: summarizeDurations(values("webview_script")),
      process_to_dom_ready: summarizeDurations(values("dom_ready")),
      process_to_shelf_painted: summarizeDurations(values("shelf_painted")),
    };
  }

  function readStartupPerformance(storage = root.localStorage) {
    try {
      return summarizeStartupPerformance(JSON.parse(storage?.getItem?.("startupPerfLogV1") || "[]"));
    } catch (_) {
      return summarizeStartupPerformance([]);
    }
  }

  function mergeShellEvents(snapshot) {
    const capturedAt = Date.now();
    pruneShellEvents(capturedAt);
    const readerEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
    const recentShell = shellEvents.map((event) => ({
      at: new Date(event.at_ms).toISOString(),
      age_ms: Math.max(0, capturedAt - event.at_ms),
      type: event.type,
      detail: event.detail,
    }));
    return {
      ...snapshot,
      captured_at: new Date(capturedAt).toISOString(),
      window_ms: WINDOW_MS,
      privacy: "No book text, selection text, URLs, file paths, account data, API credentials, or form values.",
      startup_performance: readStartupPerformance(),
      reader_performance: summarizeReaderPerformance(recentShell),
      events: [...readerEvents, ...recentShell].sort((left, right) => String(left.at).localeCompare(String(right.at))),
    };
  }

  function rememberReaderSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const capturedAt = Date.parse(String(snapshot.captured_at || ""));
    if (!Number.isFinite(capturedAt)) return false;
    latestReaderSnapshot = snapshot;
    return true;
  }

  function recentReaderSnapshot(now = Date.now()) {
    if (!latestReaderSnapshot) return null;
    const capturedAt = Date.parse(String(latestReaderSnapshot.captured_at || ""));
    const age = Number(now) - capturedAt;
    return Number.isFinite(age) && age >= -5000 && age <= WINDOW_MS ? latestReaderSnapshot : null;
  }

  function shellOnlySnapshot(now = Date.now()) {
    const navigator = root.navigator || {};
    return {
      schema_version: 1,
      captured_at: new Date(now).toISOString(),
      window_ms: WINDOW_MS,
      privacy: "No book text, selection text, URLs, file paths, account data, API credentials, or form values.",
      version: "",
      system: {
        platform: String(navigator.platform || "").slice(0, 80),
        language: String(navigator.language || "").slice(0, 32),
      },
      book: { title: "", format: "unknown" },
      reader_state: {
        chapter: 0, progress: 0, chapter_frac: 0, total_chapters: 0,
        overlay: "none", toolbar: "normal", frame_ready: false,
        loading: false, is_pdf: false, immersive: false,
        viewport: { width: Number(root.innerWidth) || 0, height: Number(root.innerHeight) || 0 },
      },
      last_click_blocker: "none",
      runtime_diagnostics: null,
      events: [],
    };
  }

  function wireReaderCheckpoints(eventApi = root.__TAURI__?.event) {
    if (!eventApi?.listen) return;
    Promise.resolve(eventApi.listen("reader-bug-trace-checkpoint", (event) => {
      rememberReaderSnapshot(event?.payload?.snapshot);
    })).catch(() => {});
  }

  function wireReaderWindowLifecycle(eventApi = root.__TAURI__?.event) {
    if (!eventApi?.listen) return;
    Promise.resolve(eventApi.listen("reader-window-trace", (event) => {
      const payload = event?.payload || {};
      pushShellEvent("reader_window", {
        source: "window_backend",
        phase: safeLabel(payload.phase),
        outcome: safeLabel(payload.outcome),
        duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
      });
    })).catch(() => {});
    Promise.resolve(eventApi.listen("reader-performance-trace", (event) => {
      const payload = event?.payload || {};
      pushShellEvent("reader_performance", {
        source: "reader_shell",
        stage: safeLabel(payload.stage),
        duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
      });
    })).catch(() => {});
  }

  async function loadNativeCheckpoint(invoke = root.__TAURI__?.core?.invoke) {
    if (typeof invoke !== "function") return recentReaderSnapshot();
    try {
      const snapshot = await invoke("problem_trace_checkpoint", { snapshot: null });
      if (snapshot) rememberReaderSnapshot(snapshot);
    } catch (_) {}
    return recentReaderSnapshot();
  }

  async function capture({ eventApi = root.__TAURI__?.event, timeoutMs } = {}) {
    await loadNativeCheckpoint();
    if (!eventApi?.listen || !eventApi?.emit) {
      return mergeShellEvents(recentReaderSnapshot() || shellOnlySnapshot());
    }
    const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const fallbackWaitMs = recentReaderSnapshot() ? 500 : 2500;
    const waitMs = Math.max(10, Number.isFinite(timeoutMs) ? Number(timeoutMs) : fallbackWaitMs);
    return new Promise(async (resolve, reject) => {
      let settled = false;
      let unlisten = null;
      let retryTimer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        root.clearTimeout(retryTimer);
        try { unlisten?.(); } catch (_) {}
        callback(value);
      };
      const timer = root.setTimeout(() => {
        const cached = recentReaderSnapshot();
        finish(resolve, mergeShellEvents(cached || shellOnlySnapshot()));
      }, waitMs);
      try {
        unlisten = await eventApi.listen("reader-bug-trace-response", (event) => {
          const payload = event?.payload || {};
          if (payload.request_id !== requestId || !payload.snapshot || typeof payload.snapshot !== "object") return;
          rememberReaderSnapshot(payload.snapshot);
          finish(resolve, mergeShellEvents(payload.snapshot));
        });
        const request = () => eventApi.emit("reader-bug-trace-request", { request_id: requestId });
        await request();
        retryTimer = root.setTimeout(() => {
          if (!settled) Promise.resolve(request()).catch(() => {});
        }, Math.max(5, Math.min(250, waitMs / 3)));
      } catch (error) {
        const cached = recentReaderSnapshot();
        finish(resolve, mergeShellEvents(cached || shellOnlySnapshot()));
      }
    });
  }

  wireShellOperations();
  wireReaderCheckpoints();
  wireReaderWindowLifecycle();
  loadNativeCheckpoint();
  return Object.freeze({
    WINDOW_MS,
    MAX_SHELL_EVENTS,
    capture,
    recordShelfBookOpen,
    _rememberReaderSnapshotForTests: rememberReaderSnapshot,
    _recentReaderSnapshotForTests: recentReaderSnapshot,
    _shellEventsForTests: () => shellEvents.map((event) => ({ ...event, detail: { ...event.detail } })),
    _summarizeStartupPerformanceForTests: summarizeStartupPerformance,
  });
});
