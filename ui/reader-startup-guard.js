(function installReaderStartupGuard(global) {
  "use strict";

  let scriptReady = false;
  let bookLoadStarted = false;
  let frameNavigationStarted = false;
  let frameReady = false;
  let closeRequested = false;
  let firstFailureReported = false;
  let bookLoadTimer = 0;
  let frameReadyTimer = 0;
  const invoke = global.__TAURI__?.core?.invoke;
  const STARTUP_TIMEOUT_MS = 12000;
  const CLOSE_FALLBACK_MS = 4200;

  function compact(value, fallback) {
    return String(value || fallback || "unknown")
      .replace(/\s+/g, " ")
      .slice(0, 260);
  }

  function report(kind, detail) {
    if (firstFailureReported || typeof invoke !== "function") return;
    firstFailureReported = true;
    const dependencies = [
      "ReaderShell",
      "ReaderSettings",
      "ReaderAiHistoryRules",
      "ReaderReadingMetrics",
      "ReaderJumpBackRules",
      "ReaderBookInfoPanel",
      "ReaderBookInfoRelated",
    ].map((name) => `${name}=${typeof global[name]}`).join(" ");
    void Promise.resolve(invoke("reader_perf_log", {
      event: `startup_${kind} ${compact(detail)} ${dependencies}`,
    })).catch(() => {});
  }

  function loadingSurface() {
    return global.document?.getElementById("loading") || null;
  }

  function showBlocked(message) {
    const loading = loadingSurface();
    if (!loading) return;
    loading.classList.remove("hide");
    loading.replaceChildren();
    const title = global.document.createElement("strong");
    title.textContent = "阅读器未能启动正文";
    const detail = global.document.createElement("span");
    detail.textContent = message;
    const close = global.document.createElement("button");
    close.type = "button";
    close.className = "tbtn";
    close.textContent = "关闭阅读器";
    close.addEventListener("click", () => { void closeSafely(); });
    loading.append(title, detail, close);
  }

  function clearTimer(timer) {
    if (timer) global.clearTimeout(timer);
    return 0;
  }

  function nativeClose() {
    if (typeof invoke !== "function") return Promise.resolve(false);
    return Promise.resolve(invoke("main_window_close")).then(() => true).catch(() => false);
  }

  function validDocumentSource(value) {
    const source = String(value || "").trim();
    if (!source || source === "about:blank") return false;
    // EPUB content is served only by the reader scheme. PDF is a packaged
    // shell page, never an arbitrary external navigation.
    return source.startsWith("reader://")
      || source.startsWith("http://reader.localhost/")
      || source.startsWith("pdfview.html?");
  }

  function beginBookLoad() {
    bookLoadStarted = true;
    bookLoadTimer = clearTimer(bookLoadTimer);
    bookLoadTimer = global.setTimeout(() => {
      if (frameNavigationStarted) return;
      report("book_info_timeout", "book_info did not provide a document URL");
      showBlocked("无法取得图书正文地址。你可以关闭此窗口后重试。");
    }, STARTUP_TIMEOUT_MS);
  }

  function beginFrameNavigation(source) {
    if (!validDocumentSource(source)) {
      report("invalid_frame_source", `source=${compact(source, "empty")}`);
      showBlocked("图书正文地址无效，已阻止停留在空白页面。");
      return false;
    }
    frameNavigationStarted = true;
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
    frameReadyTimer = global.setTimeout(() => {
      if (frameReady) return;
      report("frame_ready_timeout", `source=${compact(source, "unknown")}`);
      showBlocked("正文加载超时。关闭后重新打开图书即可重试。");
    }, STARTUP_TIMEOUT_MS);
    return true;
  }

  function markFrameReady() {
    frameReady = true;
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
  }

  function failBookLoad(error) {
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
    report("book_info_failed", compact(error?.message || error, "unknown"));
    showBlocked("读取图书信息失败。关闭后重新打开图书即可重试。");
  }

  async function closeSafely(normalClose) {
    if (closeRequested) return false;
    closeRequested = true;
    let fallbackUsed = false;
    const fallback = global.setTimeout(() => {
      fallbackUsed = true;
      report("close_fallback", "normal close did not finish before timeout");
      void nativeClose();
    }, CLOSE_FALLBACK_MS);
    try {
      if (typeof normalClose === "function") await normalClose();
      else await nativeClose();
      return !fallbackUsed;
    } catch (error) {
      report("close_failed", compact(error?.message || error, "unknown"));
      await nativeClose();
      return false;
    } finally {
      global.clearTimeout(fallback);
    }
  }

  global.addEventListener("error", (event) => {
    const file = String(event.filename || "").split("/").pop() || "unknown";
    report(
      "error",
      `${event.error?.name || "Error"}: ${event.message || event.error?.message || "unknown"} file=${file} line=${Number(event.lineno) || 0}`,
    );
  });
  global.addEventListener("unhandledrejection", (event) => {
    report("rejection", `${event.reason?.name || "Error"}: ${event.reason?.message || event.reason || "unknown"}`);
  });

  // A failing optional module, stalled book_info IPC, or an iframe that stays
  // on about:blank must never make the reader window impossible to close.
  global.document?.getElementById("win-close")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void closeSafely(global.closeReaderWindow);
  }, true);

  global.setTimeout(() => {
    if (!scriptReady) {
      report("script_timeout", "reader.js did not finish synchronous initialization within 4000ms");
      showBlocked("阅读器界面初始化失败。你可以安全关闭此窗口后重试。");
    }
  }, 4000);

  global.ReaderStartupGuard = Object.freeze({
    markScriptReady() {
      scriptReady = true;
    },
    beginBookLoad,
    beginFrameNavigation,
    markFrameReady,
    failBookLoad,
    closeSafely,
    validDocumentSource,
    state() {
      return Object.freeze({ scriptReady, bookLoadStarted, frameNavigationStarted, frameReady, closeRequested });
    },
  });
})(window);
