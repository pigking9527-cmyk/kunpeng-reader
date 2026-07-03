// 主窗口启动性能日志。保持独立，方便排查启动卡顿任务。
(function () {
  const KEY = "startupPerfLogV1";
  const origin = performance.now();
  const session = new Date().toISOString();

  try {
    localStorage.setItem(KEY, JSON.stringify([{ session, at: 0, name: "app", phase: "start", detail: "main window script loaded" }]));
  } catch (e) {}

  window.startupPerfLog = function startupPerfLog(name, phase = "mark", detail = "") {
    const at = Math.round(performance.now() - origin);
    const entry = { session, at, name, phase, detail: String(detail || "") };
    console.info("[startup] +" + at + "ms " + name + " " + phase + (entry.detail ? " " + entry.detail : ""));
    try {
      const logs = JSON.parse(localStorage.getItem(KEY) || "[]");
      logs.push(entry);
      localStorage.setItem(KEY, JSON.stringify(logs.slice(-160)));
    } catch (e) {}
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
})();
