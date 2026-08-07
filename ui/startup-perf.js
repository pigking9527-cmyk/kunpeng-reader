// 主窗口启动性能日志。保持独立，方便排查启动卡顿任务。
(function () {
  const KEY = "startupPerfLogV1";
  const MAX_SESSIONS = 12;
  const MAX_LOGS = 480;
  const origin = performance.now();
  const session = new Date().toISOString();

  function readLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (e) {
      return [];
    }
  }

  function keepRecentSessions(logs) {
    const sessions = [];
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const id = String(logs[index]?.session || "");
      if (id && !sessions.includes(id)) sessions.push(id);
      if (sessions.length >= MAX_SESSIONS) break;
    }
    const allowed = new Set(sessions);
    return logs.filter((entry) => allowed.has(String(entry?.session || ""))).slice(-MAX_LOGS);
  }

  function saveEntry(entry) {
    try {
      const logs = readLogs();
      logs.push(entry);
      localStorage.setItem(KEY, JSON.stringify(keepRecentSessions(logs)));
    } catch (e) {}
  }

  saveEntry({ session, at: 0, name: "app", phase: "start", detail: "main window script loaded" });

  window.startupPerfLog = function startupPerfLog(name, phase = "mark", detail = "") {
    const at = Math.round(performance.now() - origin);
    const entry = { session, at, name, phase, detail: String(detail || "") };
    console.info("[startup] +" + at + "ms " + name + " " + phase + (entry.detail ? " " + entry.detail : ""));
    saveEntry(entry);
  };

  window.startupPerfStart = function startupPerfStart(name, detail = "") {
    const started = performance.now();
    window.startupPerfLog(name, "start", detail);
    return (extra = "") => window.startupPerfLog(name, "end", Math.round(performance.now() - started) + "ms" + (extra ? " " + extra : ""));
  };

  window.startupTimed = function startupTimed(name, task, detail = "") {
    const done = window.startupPerfStart(name, detail);
    return Promise.resolve()
      .then(task)
      .then((value) => {
        done();
        return value;
      })
      .catch((err) => {
        window.startupPerfLog(name, "error", err && err.message ? err.message : String(err));
        throw err;
      });
  };

  window.recordNativeStartupMilestone = function recordNativeStartupMilestone(phase) {
    return window.__TAURI__.core.invoke("startup_elapsed_ms")
      .then((durationMs) => {
        window.startupPerfLog("startup", phase, Math.max(0, Number(durationMs) || 0) + "ms");
        return durationMs;
      })
      .catch(() => null);
  };
  window.recordNativeStartupMilestone("webview_script");
  window.addEventListener("DOMContentLoaded", () => window.recordNativeStartupMilestone("dom_ready"));
})();
