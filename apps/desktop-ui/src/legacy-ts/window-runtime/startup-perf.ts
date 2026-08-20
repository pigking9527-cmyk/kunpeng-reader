import {
  createWindowControls,
  transportFromTauriGlobal,
  type TauriTransport,
  type WindowControls,
} from "../../../../../packages/tauri-api/src/index.js";

export const STARTUP_PERF_STORAGE_KEY = "startupPerfLogV1";
export const STARTUP_PERF_MAX_SESSIONS = 12;
export const STARTUP_PERF_MAX_LOGS = 480;

export interface StartupPerfEntry {
  readonly session: string;
  readonly at: number;
  readonly name: string;
  readonly phase: string;
  readonly detail: string;
}

export interface StartupPerfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StartupPerfClock {
  now(): number;
}

export interface StartupPerfConsole {
  info(message: string): void;
}

export interface StartupPerfHost {
  readonly localStorage: StartupPerfStorage;
  readonly performance: StartupPerfClock;
  readonly console: StartupPerfConsole;
  addEventListener(
    type: "DOMContentLoaded",
    listener: () => void,
  ): void;
  startupPerfLog?: StartupPerfLog;
  startupPerfStart?: StartupPerfStart;
  startupTimed?: StartupTimed;
  recordNativeStartupMilestone?: NativeStartupMilestone;
}

export type StartupPerfLog = (
  name: string,
  phase?: string,
  detail?: unknown,
) => void;
export type StartupPerfStart = (
  name: string,
  detail?: unknown,
) => (extra?: unknown) => void;
export type StartupTimed = <TResult>(
  name: string,
  task: () => TResult | PromiseLike<TResult>,
  detail?: unknown,
) => Promise<TResult>;
export type NativeStartupMilestone = (phase: string) => Promise<number | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function startupHost(target: unknown): StartupPerfHost | null {
  if (!isRecord(target)) return null;
  if (
    !isRecord(target.localStorage) ||
    !isRecord(target.performance) ||
    !isRecord(target.console) ||
    typeof target.addEventListener !== "function"
  ) {
    return null;
  }
  return target as unknown as StartupPerfHost;
}

function controlsFromRuntime(
  target: unknown,
  transport?: TauriTransport,
): WindowControls | null {
  try {
    return createWindowControls(transport ?? transportFromTauriGlobal(target));
  } catch {
    return null;
  }
}

function sessionOf(entry: unknown): string {
  return isRecord(entry) ? String(entry.session ?? "") : "";
}

export function readStartupPerfLogs(storage: StartupPerfStorage): unknown[] {
  try {
    const value = JSON.parse(storage.getItem(STARTUP_PERF_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function keepRecentStartupSessions(logs: readonly unknown[]): unknown[] {
  const sessions: string[] = [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const id = sessionOf(logs[index]);
    if (id && !sessions.includes(id)) sessions.push(id);
    if (sessions.length >= STARTUP_PERF_MAX_SESSIONS) break;
  }
  const allowed = new Set(sessions);
  return logs
    .filter((entry) => allowed.has(sessionOf(entry)))
    .slice(-STARTUP_PERF_MAX_LOGS);
}

function errorDetail(error: unknown): string {
  if (isRecord(error) && error.message) return String(error.message);
  return String(error);
}

function legacyDetail(value: unknown): string {
  return String(value || "");
}

export function initializeStartupPerf(
  host: StartupPerfHost,
  controls: WindowControls | null,
  session = new Date().toISOString(),
): void {
  const origin = host.performance.now();

  const saveEntry = (entry: StartupPerfEntry): void => {
    try {
      const logs = readStartupPerfLogs(host.localStorage);
      logs.push(entry);
      host.localStorage.setItem(
        STARTUP_PERF_STORAGE_KEY,
        JSON.stringify(keepRecentStartupSessions(logs)),
      );
    } catch {
      // Startup diagnostics must never prevent the application from starting.
    }
  };

  saveEntry({
    session,
    at: 0,
    name: "app",
    phase: "start",
    detail: "main window script loaded",
  });

  const startupPerfLog: StartupPerfLog = (name, phase = "mark", detail = "") => {
    const at = Math.round(host.performance.now() - origin);
    const entry: StartupPerfEntry = {
      session,
      at,
      name,
      phase,
      detail: legacyDetail(detail),
    };
    host.console.info(
      `[startup] +${at}ms ${name} ${phase}${entry.detail ? ` ${entry.detail}` : ""}`,
    );
    saveEntry(entry);
  };
  host.startupPerfLog = startupPerfLog;

  const startupPerfStart: StartupPerfStart = (name, detail = "") => {
    const started = host.performance.now();
    startupPerfLog(name, "start", detail);
    return (extra = "") => {
      startupPerfLog(
        name,
        "end",
        `${Math.round(host.performance.now() - started)}ms${extra ? ` ${String(extra)}` : ""}`,
      );
    };
  };
  host.startupPerfStart = startupPerfStart;

  const startupTimed: StartupTimed = (name, task, detail = "") => {
    const done = startupPerfStart(name, detail);
    return Promise.resolve()
      .then(task)
      .then((value) => {
        done();
        return value;
      })
      .catch((error: unknown) => {
        startupPerfLog(name, "error", errorDetail(error));
        throw error;
      });
  };
  host.startupTimed = startupTimed;

  const recordNativeStartupMilestone: NativeStartupMilestone = (phase) => {
    if (!controls) return Promise.resolve(null);
    return controls
      .elapsedSinceProcessStartMs()
      .then((durationMs) => {
        startupPerfLog(
          "startup",
          phase,
          `${Math.max(0, Number(durationMs) || 0)}ms`,
        );
        return durationMs;
      })
      .catch(() => null);
  };
  host.recordNativeStartupMilestone = recordNativeStartupMilestone;
  void recordNativeStartupMilestone("webview_script");
  host.addEventListener("DOMContentLoaded", () => {
    void recordNativeStartupMilestone("dom_ready");
  });
}

/** Classic-script installer replacing `ui/startup-perf.js`. */
export function installStartupPerf(
  target: unknown,
  transport?: TauriTransport,
  session?: string,
): void {
  const host = startupHost(target);
  if (!host) return;
  initializeStartupPerf(host, controlsFromRuntime(target, transport), session);
}
