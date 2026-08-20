import {
  READER_CLOSE_FALLBACK_MS,
  READER_STARTUP_TIMEOUT_MS,
  compactReaderStartupDiagnostic,
  createReaderStartupState,
  isValidReaderDocumentSource,
  readerStartupDependencySummary,
  reduceReaderStartup,
} from "../reader/startup-guard.ts";
import type {
  ReaderStartupDependencyName,
  ReaderStartupState,
} from "../reader/startup-guard.ts";

type TimerId = ReturnType<typeof globalThis.setTimeout>;
type Invoke = (command: string, arguments_?: Readonly<Record<string, unknown>>) => unknown;

export interface ReaderStartupGuardApi {
  readonly markScriptReady: () => void;
  readonly beginBookLoad: () => void;
  readonly beginFrameNavigation: (source: unknown) => boolean;
  readonly markFrameReady: () => void;
  readonly failBookLoad: (error: unknown) => void;
  readonly closeSafely: (normalClose?: unknown) => Promise<boolean>;
  readonly validDocumentSource: (source: unknown) => boolean;
  readonly state: () => Readonly<Omit<ReaderStartupState, "firstFailureReported">>;
}

interface StartupRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function errorMessage(value: unknown): unknown {
  return isRecord(value) && "message" in value ? value.message : value;
}

function errorName(value: unknown): unknown {
  return isRecord(value) && "name" in value ? value.name : undefined;
}

function nestedInvoke(target: StartupRuntime): Invoke | null {
  const tauri = isRecord(target.__TAURI__) ? target.__TAURI__ : null;
  const core = tauri && isRecord(tauri.core) ? tauri.core : null;
  return core && typeof core.invoke === "function" ? core.invoke as Invoke : null;
}

function dependencyLookup(target: StartupRuntime): Readonly<Record<ReaderStartupDependencyName, unknown>> {
  return {
    ReaderShell: target.ReaderShell,
    ReaderSettings: target.ReaderSettings,
    ReaderAiHistoryRules: target.ReaderAiHistoryRules,
    ReaderReadingMetrics: target.ReaderReadingMetrics,
    ReaderJumpBackRules: target.ReaderJumpBackRules,
    ReaderBookInfoPanel: target.ReaderBookInfoPanel,
    ReaderBookInfoRelated: target.ReaderBookInfoRelated,
  };
}

export function installReaderStartupGuard(target: StartupRuntime): ReaderStartupGuardApi {
  const invoke = nestedInvoke(target);
  let state = createReaderStartupState();
  let bookLoadTimer: TimerId | null = null;
  let frameReadyTimer: TimerId | null = null;

  function report(kind: string, detail: unknown): void {
    if (state.firstFailureReported || !invoke) return;
    state = reduceReaderStartup(state, { type: "REPORT_FIRST_FAILURE" });
    const dependencies = readerStartupDependencySummary(dependencyLookup(target));
    void Promise.resolve(invoke("reader_perf_log", {
      event: `startup_${kind} ${compactReaderStartupDiagnostic(detail)} ${dependencies}`,
    })).catch(() => undefined);
  }

  function loadingSurface(): HTMLElement | null {
    return target.document?.getElementById("loading") ?? null;
  }

  function showBlocked(message: string): void {
    const loading = loadingSurface();
    const document = target.document;
    if (!loading || !document) return;
    loading.classList.remove("hide");
    loading.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "阅读器未能启动正文";
    const detail = document.createElement("span");
    detail.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tbtn";
    close.textContent = "关闭阅读器";
    close.addEventListener("click", () => {
      void closeSafely();
    });
    loading.append(title, detail, close);
  }

  function clearTimer(timer: TimerId | null): null {
    if (timer !== null) target.clearTimeout(timer);
    return null;
  }

  async function nativeClose(): Promise<boolean> {
    if (!invoke) return false;
    try {
      await Promise.resolve(invoke("main_window_close"));
      return true;
    } catch {
      return false;
    }
  }

  function beginBookLoad(): void {
    state = reduceReaderStartup(state, { type: "BEGIN_BOOK_LOAD" });
    bookLoadTimer = clearTimer(bookLoadTimer);
    bookLoadTimer = target.setTimeout(() => {
      if (state.frameNavigationStarted) return;
      report("book_info_timeout", "book_info did not provide a document URL");
      showBlocked("无法取得图书正文地址。你可以关闭此窗口后重试。");
    }, READER_STARTUP_TIMEOUT_MS);
  }

  function beginFrameNavigation(source: unknown): boolean {
    if (!isValidReaderDocumentSource(source)) {
      report(
        "invalid_frame_source",
        `source=${compactReaderStartupDiagnostic(source, "empty")}`,
      );
      showBlocked("图书正文地址无效，已阻止停留在空白页面。");
      return false;
    }
    state = reduceReaderStartup(state, { type: "BEGIN_FRAME_NAVIGATION" });
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
    frameReadyTimer = target.setTimeout(() => {
      if (state.frameReady) return;
      report(
        "frame_ready_timeout",
        `source=${compactReaderStartupDiagnostic(source, "unknown")}`,
      );
      showBlocked("正文加载超时。关闭后重新打开图书即可重试。");
    }, READER_STARTUP_TIMEOUT_MS);
    return true;
  }

  function markFrameReady(): void {
    state = reduceReaderStartup(state, { type: "MARK_FRAME_READY" });
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
  }

  function failBookLoad(error: unknown): void {
    bookLoadTimer = clearTimer(bookLoadTimer);
    frameReadyTimer = clearTimer(frameReadyTimer);
    report("book_info_failed", compactReaderStartupDiagnostic(errorMessage(error), "unknown"));
    showBlocked("读取图书信息失败。关闭后重新打开图书即可重试。");
  }

  async function closeSafely(normalClose?: unknown): Promise<boolean> {
    if (state.closeRequested) return false;
    state = reduceReaderStartup(state, { type: "REQUEST_CLOSE" });
    let fallbackUsed = false;
    const fallback = target.setTimeout(() => {
      fallbackUsed = true;
      report("close_fallback", "normal close did not finish before timeout");
      void nativeClose();
    }, READER_CLOSE_FALLBACK_MS);
    try {
      if (typeof normalClose === "function") await normalClose();
      else await nativeClose();
      return !fallbackUsed;
    } catch (error) {
      report("close_failed", compactReaderStartupDiagnostic(errorMessage(error), "unknown"));
      await nativeClose();
      return false;
    } finally {
      target.clearTimeout(fallback);
    }
  }

  target.addEventListener("error", (event) => {
    const record = isRecord(event) ? event : {};
    const error = record.error;
    const filename = String(record.filename ?? "");
    const file = filename.split("/").pop() || "unknown";
    report(
      "error",
      `${errorName(error) || "Error"}: ${record.message || errorMessage(error) || "unknown"} file=${file} line=${Number(record.lineno) || 0}`,
    );
  });
  target.addEventListener("unhandledrejection", (event) => {
    const reason = isRecord(event) ? event.reason : undefined;
    report(
      "rejection",
      `${errorName(reason) || "Error"}: ${errorMessage(reason) || "unknown"}`,
    );
  });

  target.document?.getElementById("win-close")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void closeSafely(target.closeReaderWindow);
  }, true);

  target.setTimeout(() => {
    if (state.scriptReady) return;
    report("script_timeout", "reader.js did not finish synchronous initialization within 4000ms");
    showBlocked("阅读器界面初始化失败。你可以安全关闭此窗口后重试。");
  }, 4_000);

  const api: ReaderStartupGuardApi = Object.freeze({
    markScriptReady(): void {
      state = reduceReaderStartup(state, { type: "MARK_SCRIPT_READY" });
    },
    beginBookLoad,
    beginFrameNavigation,
    markFrameReady,
    failBookLoad,
    closeSafely,
    validDocumentSource: isValidReaderDocumentSource,
    state() {
      return Object.freeze({
        scriptReady: state.scriptReady,
        bookLoadStarted: state.bookLoadStarted,
        frameNavigationStarted: state.frameNavigationStarted,
        frameReady: state.frameReady,
        closeRequested: state.closeRequested,
      });
    },
  });
  target.ReaderStartupGuard = api;
  return api;
}
