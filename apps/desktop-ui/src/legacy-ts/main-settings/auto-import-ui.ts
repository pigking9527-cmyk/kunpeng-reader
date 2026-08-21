import {
  createTauriApi,
  type TauriCommandMap,
  type TauriEventApi,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface AutoImportProgress extends Record<string, unknown> {
  readonly phase?: string;
  readonly found?: number;
  readonly processed?: number;
  readonly added?: number;
  readonly total?: number;
  readonly deferred?: number;
  readonly current?: string;
}

interface AutoImportChange extends Record<string, unknown> {
  readonly reason?: string;
}

interface AutoImportWatchStatus extends Record<string, unknown> {
  readonly message?: string;
  readonly state?: string;
}

type AutoImportCommands = {
  list_books: { readonly result: unknown };
  auto_import_scan: { readonly result: unknown };
};

type AutoImportEvents = {
  "auto-import-progress": AutoImportProgress;
  "auto-import-change": AutoImportChange;
  "auto-import-watch-status": AutoImportWatchStatus;
};

type VerifiedAutoImportCommands = AutoImportCommands extends TauriCommandMap
  ? AutoImportCommands
  : never;

export interface AutoImportOptions {
  readonly invoke?: TauriTransport["invoke"];
  readonly transport?: TauriTransport;
  readonly isEnabled: () => boolean;
  readonly getDirs: () => readonly unknown[];
  readonly countShelf: () => number;
  readonly renderShelf: (books: unknown[]) => void;
  readonly setStatus: (message: string, state: "busy" | "ok" | "error") => void;
  readonly startPerformance: (
    name: string,
    detail: string,
  ) => (detail: string) => void;
  readonly logPerformance: (
    name: string,
    phase: string,
    detail: string,
  ) => void;
  readonly afterAdded: () => void;
}

export interface AutoImportEventApi {
  listen<TEvent extends keyof AutoImportEvents & string>(
    event: TEvent,
    handler: (event: { readonly payload: AutoImportEvents[TEvent] }) => void,
  ): unknown;
}

export interface AutoImportInstance {
  bindEvents(eventApi?: AutoImportEventApi): void;
  handleProgress(progress: AutoImportProgress): void;
  start(reason?: string): Promise<void>;
}

export interface AutoImportGlobalApi {
  create(options: AutoImportOptions): AutoImportInstance;
}

interface AutoImportRuntime extends Record<string, unknown> {
  setTimeout(handler: TimerHandler, timeout?: number): number;
  clearTimeout(handle?: number): void;
  ReaderAutoImportUI?: AutoImportGlobalApi;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): AutoImportRuntime | null {
  const target = record(value);
  if (
    !target ||
    typeof target.setTimeout !== "function" ||
    typeof target.clearTimeout !== "function"
  ) {
    return null;
  }
  return target as unknown as AutoImportRuntime;
}

function errorMessage(error: unknown): string {
  const value = record(error);
  return value?.message ? String(value.message) : String(error);
}

function resultList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function eventApiFromTransport(
  transport: TauriTransport | undefined,
): TauriEventApi<AutoImportEvents> | undefined {
  return transport?.listen
    ? createTauriApi<VerifiedAutoImportCommands>(transport).events<AutoImportEvents>()
    : undefined;
}

export function createAutoImportGlobal(
  runtime: AutoImportRuntime,
): AutoImportGlobalApi {
  const create = (options: AutoImportOptions): AutoImportInstance => {
    const transport =
      options.transport ??
      (options.invoke ? ({ invoke: options.invoke } satisfies TauriTransport) : undefined);
    if (!transport) {
      throw new Error("Auto-import requires a Tauri transport or invoke function.");
    }
    const api = createTauriApi<VerifiedAutoImportCommands>(transport);
    const isEnabled = options.isEnabled;
    const getDirs = options.getDirs;
    const countShelf = options.countShelf;
    const renderShelf = options.renderShelf;
    const setStatus = options.setStatus;
    const startPerformance = options.startPerformance;
    const logPerformance = options.logPerformance;
    const afterAdded = options.afterAdded;
    let scanPromise: Promise<void> | null = null;
    let scanQueued = false;
    let queuedReason = "";
    let refreshTimer = 0;
    let refreshRunning = false;
    let refreshPending = false;
    let stabilityRetryTimer = 0;

    const refreshShelf = async (): Promise<void> => {
      if (refreshRunning) {
        refreshPending = true;
        return;
      }
      refreshRunning = true;
      try {
        do {
          refreshPending = false;
          renderShelf(resultList((await api.invoke("list_books")) || []));
        } while (refreshPending);
      } catch {
        // The scan's final result still refreshes the full shelf.
      } finally {
        refreshRunning = false;
      }
    };

    const scheduleRefresh = (delay = 350): void => {
      if (refreshTimer && delay > 0) return;
      runtime.clearTimeout(refreshTimer);
      refreshTimer = runtime.setTimeout(() => {
        refreshTimer = 0;
        void refreshShelf();
      }, delay);
    };

    const runScan = async (reason: string): Promise<void> => {
      if (!isEnabled() || !getDirs().length) return;
      const finish = startPerformance(
        "auto-import-scan",
        `background dirs=${getDirs().length}`,
      );
      const before = countShelf();
      setStatus(reason, "busy");
      try {
        const list = resultList((await api.invoke("auto_import_scan")) || []);
        const added = Math.max(0, list.length - before);
        runtime.clearTimeout(refreshTimer);
        refreshTimer = 0;
        renderShelf(list);
        if (added > 0) {
          setStatus(`导入完成，新增 ${added} 本书`, "ok");
          finish(`added=${added}`);
          afterAdded();
        } else {
          setStatus("扫描完成，没有新书", "ok");
          finish("added=0");
        }
      } catch (error: unknown) {
        logPerformance("auto-import-scan", "error", errorMessage(error));
        setStatus(`扫描失败：${String(error)}`, "error");
      }
    };

    const start = (reason = "正在扫描并导入目录…"): Promise<void> => {
      if (!isEnabled() || !getDirs().length) return Promise.resolve();
      if (scanPromise) {
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
      })().finally(() => {
        scanPromise = null;
      });
      return scanPromise;
    };

    const handleProgress = (progress: AutoImportProgress): void => {
      if (!progress.phase) return;
      if (progress.phase === "scan") {
        setStatus(
          `正在扫描目录…已发现 ${progress.found || 0} 个文件`,
          "busy",
        );
      } else if (progress.phase === "import") {
        setStatus(
          `正在导入 ${progress.processed || 0}/${progress.total || 0}，已新增 ${progress.added || 0} 本${progress.current ? `：${progress.current}` : ""}`,
          "busy",
        );
        scheduleRefresh();
      } else if (progress.phase === "waiting") {
        const deferred = progress.deferred || 0;
        setStatus(
          `检测到 ${deferred} 个仍在复制的文件，复制完成后自动导入`,
          "busy",
        );
        runtime.clearTimeout(stabilityRetryTimer);
        stabilityRetryTimer = runtime.setTimeout(() => {
          stabilityRetryTimer = 0;
          void start("正在重新检查尚未复制完成的文件…");
        }, 5000);
      } else if (progress.phase === "done") {
        setStatus(`扫描完成，新增 ${progress.added || 0} 本书`, "ok");
        scheduleRefresh(0);
      }
    };

    const bindEvents = (legacyEventApi?: AutoImportEventApi): void => {
      const events = legacyEventApi ?? eventApiFromTransport(options.transport);
      if (!events) return;
      void events.listen("auto-import-progress", (event) => {
        handleProgress(event?.payload || {});
      });
      void events.listen("auto-import-change", (event) => {
        const payload = event?.payload || {};
        void start(
          payload.reason ||
            "检测到自动导入目录变化，正在检查新书…",
        );
      });
      void events.listen("auto-import-watch-status", (event) => {
        const payload = event?.payload || {};
        if (!payload.message) return;
        setStatus(payload.message, payload.state === "error" ? "error" : "ok");
      });
    };

    return Object.freeze({ bindEvents, handleProgress, start });
  };

  return Object.freeze({ create });
}

/** Classic installer replacing `ui/auto-import-ui.js`. */
export function installAutoImportUi(target: unknown): AutoImportGlobalApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createAutoImportGlobal(runtime);
  runtime.ReaderAutoImportUI = api;
  return api;
}
