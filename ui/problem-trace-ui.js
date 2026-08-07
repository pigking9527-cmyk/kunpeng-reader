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

  function recordShellOperation(kind, target) {
    const now = Date.now();
    pruneShellEvents(now);
    shellEvents.push({
      at_ms: now,
      type: "shell_" + safeLabel(kind, "operation"),
      detail: {
        source: "main_window",
        area: traceArea(target),
        target: safeLabel(target?.id || target?.tagName?.toLowerCase(), "control"),
      },
    });
    pruneShellEvents(now);
  }

  function wireShellOperations(doc = root.document) {
    if (!doc || doc.__problemTraceShellWired) return;
    doc.__problemTraceShellWired = true;
    const record = (event, kind) => {
      const target = event.target?.closest?.("button,[role=button],input,select,textarea,a,[contenteditable=true]");
      if (!target || target.matches("textarea,[contenteditable=true]")) return;
      recordShellOperation(kind, target);
    };
    doc.addEventListener("click", (event) => record(event, "click"), true);
    doc.addEventListener("change", (event) => record(event, "change"), true);
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
      events: [...readerEvents, ...recentShell].sort((left, right) => String(left.at).localeCompare(String(right.at))),
    };
  }

  async function capture({ eventApi = root.__TAURI__?.event, timeoutMs = 2500 } = {}) {
    if (!eventApi?.listen || !eventApi?.emit) throw new Error("当前系统无法读取阅读器问题记录。");
    const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    return new Promise(async (resolve, reject) => {
      let settled = false;
      let unlisten = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        try { unlisten?.(); } catch (_) {}
        callback(value);
      };
      const timer = root.setTimeout(() => finish(reject, new Error("未收到阅读器状态；请先打开一本书并复现问题。")), timeoutMs);
      try {
        unlisten = await eventApi.listen("reader-bug-trace-response", (event) => {
          const payload = event?.payload || {};
          if (payload.request_id !== requestId || !payload.snapshot || typeof payload.snapshot !== "object") return;
          finish(resolve, mergeShellEvents(payload.snapshot));
        });
        await eventApi.emit("reader-bug-trace-request", { request_id: requestId });
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error(String(error || "读取问题记录失败")));
      }
    });
  }

  wireShellOperations();
  return Object.freeze({ WINDOW_MS, MAX_SHELL_EVENTS, capture, _shellEventsForTests: () => shellEvents.map((event) => ({ ...event, detail: { ...event.detail } })) });
});
