import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type RecoveryScope = "main" | "reader";

type RecoveryCommands = {
  recovery_web_settings_save: {
    readonly args: {
      readonly scope: RecoveryScope;
      readonly settings: Readonly<Record<string, string>>;
    };
    readonly result: void;
  };
  recovery_web_settings_take_restored: {
    readonly args: { readonly scope: RecoveryScope };
    readonly result: unknown;
  };
};

type VerifiedRecoveryCommands = RecoveryCommands extends TauriCommandMap
  ? RecoveryCommands
  : never;

export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RecoveryLocation {
  readonly pathname: string;
  reload(): void;
}

export interface RecoveryRuntime {
  readonly localStorage: RecoveryStorage;
  readonly location: RecoveryLocation;
  setInterval(handler: () => void, milliseconds: number): unknown;
  addEventListener(
    type: "pagehide",
    listener: () => void,
    options: Readonly<{ capture: true }>,
  ): void;
  ReaderRecoverySettings?: RecoverySettingsApi;
}

export interface RecoverySettingsApi {
  flush(force: boolean): Promise<void>;
  readonly ready: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runtimeFrom(value: unknown): RecoveryRuntime | null {
  if (!isRecord(value)) return null;
  if (
    !isRecord(value.localStorage) ||
    !isRecord(value.location) ||
    typeof value.setInterval !== "function" ||
    typeof value.addEventListener !== "function"
  ) {
    return null;
  }
  return value as unknown as RecoveryRuntime;
}

export function recoveryScope(pathname: string): RecoveryScope {
  return pathname.endsWith("reader.html") ? "reader" : "main";
}

export function isSensitiveRecoveryKey(key: string): boolean {
  return /token|password|secret|api_key|apikey|credential/i.test(key);
}

export function captureRecoverySettings(
  storage: RecoveryStorage,
): Readonly<Record<string, string>> {
  const settings: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || isSensitiveRecoveryKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) settings[key] = value;
  }
  return settings;
}

function restoredSettings(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

function ignoreFailure(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

export function createRecoverySettingsApi(
  runtime: RecoveryRuntime,
  transport: TauriTransport | null,
): RecoverySettingsApi {
  const scope = recoveryScope(runtime.location.pathname);
  const api = transport ? createTauriApi<VerifiedRecoveryCommands>(transport) : null;
  let previous = "";

  const flush = async (force: boolean): Promise<void> => {
    if (!api) return;
    const settings = captureRecoverySettings(runtime.localStorage);
    const serialized = JSON.stringify(settings);
    if (!force && serialized === previous) return;
    await api.invoke("recovery_web_settings_save", { scope, settings });
    previous = serialized;
  };

  const applyRestoredSettings = async (): Promise<boolean> => {
    if (!api) return false;
    const restored = restoredSettings(
      await api.invoke("recovery_web_settings_take_restored", { scope }),
    );
    if (!restored) return false;
    const currentKeys: string[] = [];
    for (let index = 0; index < runtime.localStorage.length; index += 1) {
      const key = runtime.localStorage.key(index);
      if (key && !isSensitiveRecoveryKey(key)) currentKeys.push(key);
    }
    currentKeys.forEach((key) => runtime.localStorage.removeItem(key));
    Object.entries(restored).forEach(([key, value]) => {
      if (!isSensitiveRecoveryKey(key) && typeof value === "string") {
        runtime.localStorage.setItem(key, value);
      }
    });
    previous = JSON.stringify(captureRecoverySettings(runtime.localStorage));
    return true;
  };

  const ready = (async (): Promise<void> => {
    try {
      if (await applyRestoredSettings()) {
        runtime.location.reload();
        return;
      }
      await flush(true);
      runtime.setInterval(() => {
        ignoreFailure(flush(false));
      }, 5_000);
      runtime.addEventListener(
        "pagehide",
        () => {
          ignoreFailure(flush(false));
        },
        { capture: true },
      );
    } catch {
      // Preference snapshots are additive: UI storage remains usable offline.
    }
  })();

  return Object.freeze({ flush, ready });
}

/** Classic installer replacing `ui/recovery-settings-snapshot.js`. */
export function installRecoverySettingsSnapshot(
  target: unknown,
  transport?: TauriTransport,
): RecoverySettingsApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport: TauriTransport | null = transport ?? null;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      resolvedTransport = null;
    }
  }
  const api = createRecoverySettingsApi(runtime, resolvedTransport);
  runtime.ReaderRecoverySettings = api;
  return api;
}
