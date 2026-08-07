// 自动导入扫描串行化、进度状态与书架增量刷新。
(function exposeAutoImportUi(global) {
"use strict";

function create(options) {
  const invoke = options.invoke;
  const isEnabled = options.isEnabled;
  const getDirs = options.getDirs;
  const countShelf = options.countShelf;
  const renderShelf = options.renderShelf;
  const setStatus = options.setStatus;
  const startPerformance = options.startPerformance;
  const logPerformance = options.logPerformance;
  const afterAdded = options.afterAdded;
  let scanPromise = null;
  let scanQueued = false;
  let queuedReason = "";
  let refreshTimer = 0;
  let refreshRunning = false;
  let refreshPending = false;
  let stabilityRetryTimer = 0;

  async function refreshShelf() {
    if (refreshRunning) {
      refreshPending = true;
      return;
    }
    refreshRunning = true;
    try {
      do {
        refreshPending = false;
        renderShelf((await invoke("list_books")) || []);
      } while (refreshPending);
    } catch (_) {
      // 扫描命令的最终结果仍会刷新完整书架；中途刷新失败不终止导入。
    } finally {
      refreshRunning = false;
    }
  }

  function scheduleRefresh(delay = 350) {
    // 节流而不是防抖：大批文件连续产生进度事件时也要定期刷新，
    // 不能一直把计时器推迟到整个导入结束。
    if (refreshTimer && delay > 0) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refreshShelf();
    }, delay);
  }

  async function runScan(reason) {
    if (!isEnabled() || !getDirs().length) return;
    const finish = startPerformance("auto-import-scan", "background dirs=" + getDirs().length);
    const before = countShelf();
    setStatus(reason, "busy");
    try {
      const list = (await invoke("auto_import_scan")) || [];
      const added = Math.max(0, list.length - before);
      clearTimeout(refreshTimer);
      refreshTimer = 0;
      renderShelf(list);
      if (added > 0) {
        setStatus("导入完成，新增 " + added + " 本书", "ok");
        finish("added=" + added);
        afterAdded();
      } else {
        setStatus("扫描完成，没有新书", "ok");
        finish("added=0");
      }
    } catch (error) {
      logPerformance("auto-import-scan", "error", error && error.message ? error.message : String(error));
      setStatus("扫描失败：" + error, "error");
    }
  }

  function start(reason = "正在扫描并导入目录…") {
    if (!isEnabled() || !getDirs().length) return Promise.resolve();
    if (scanPromise) {
      // 启动定时器和设置变更可能同时要求扫描；串行补跑，禁止中间快照互相覆盖。
      scanQueued = true;
      queuedReason = reason;
      return scanPromise;
    }
    scanPromise = (async () => {
      let nextReason = reason;
      do {
        scanQueued = false;
        await runScan(nextReason);
        nextReason = queuedReason || "正在继续扫描导入目录…";
        queuedReason = "";
      } while (scanQueued && isEnabled() && getDirs().length);
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  function handleProgress(progress) {
    if (!progress.phase) return;
    if (progress.phase === "scan") {
      setStatus("正在扫描目录…已发现 " + (progress.found || 0) + " 个文件", "busy");
    } else if (progress.phase === "import") {
      setStatus("正在导入 " + (progress.processed || 0) + "/" + (progress.total || 0) + "，已新增 " + (progress.added || 0) + " 本" + (progress.current ? "：" + progress.current : ""), "busy");
      scheduleRefresh();
    } else if (progress.phase === "waiting") {
      const deferred = progress.deferred || 0;
      setStatus("检测到 " + deferred + " 个仍在复制的文件，复制完成后自动导入", "busy");
      clearTimeout(stabilityRetryTimer);
      stabilityRetryTimer = setTimeout(() => {
        stabilityRetryTimer = 0;
        start("正在重新检查尚未复制完成的文件…");
      }, 5000);
    } else if (progress.phase === "done") {
      setStatus("扫描完成，新增 " + (progress.added || 0) + " 本书", "ok");
      scheduleRefresh(0);
    }
  }

  function bindEvents(eventApi) {
    eventApi.listen("auto-import-progress", (event) => {
      handleProgress((event && event.payload) || {});
    });
    eventApi.listen("auto-import-change", (event) => {
      const payload = (event && event.payload) || {};
      start(payload.reason || "检测到自动导入目录变化，正在检查新书…");
    });
    eventApi.listen("auto-import-watch-status", (event) => {
      const payload = (event && event.payload) || {};
      if (!payload.message) return;
      setStatus(payload.message, payload.state === "error" ? "error" : "ok");
    });
  }

  return Object.freeze({ bindEvents, handleProgress, start });
}

global.ReaderAutoImportUI = Object.freeze({ create });
})(window);
