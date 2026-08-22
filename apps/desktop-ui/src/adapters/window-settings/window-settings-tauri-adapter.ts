import {
  createTauriApi,
  type TauriCommandMap,
  type TauriEvent,
  type TauriTransport,
  type TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.js";
import type {
  StartupEnhancementSettings,
  StartupEnhancementSettingsRequest,
  WindowSettingsPort,
} from "../../features/window-settings/window-settings-port.js";

/**
 * Exact JSON shape emitted by Rust's `StartupEnhancementStatus`.
 *
 * `#[serde(rename_all = "camelCase")]` on that struct makes these names part
 * of the Tauri boundary. Keep this separate from the feature port so native
 * serialization details do not leak into components.
 */
export interface StartupEnhancementStatusPayload {
  readonly enabled: boolean;
  readonly continueHighCost: boolean;
  readonly launchAtLogin: boolean;
  readonly launchAtLoginAvailable: boolean;
  readonly launchAtLoginBackground: boolean;
  readonly launchAtLoginBackgroundAvailable: boolean;
}

/** Exact JSON body accepted by Rust's `StartupEnhancementConfig`. */
export interface StartupEnhancementConfigPayload {
  readonly enabled: boolean;
  readonly continueHighCost: boolean;
  readonly launchAtLogin: boolean;
  readonly launchAtLoginBackground: boolean;
}

/** Exact payload emitted by Rust's `BackgroundStatePayload`. */
export interface StartupEnhancementStatePayload {
  readonly backgrounded: boolean;
  readonly continueHighCost: boolean;
  readonly highCostResumeAtMs: number;
}

/**
 * Commands audited against `src/startup_enhancement.rs` and
 * `src/window_commands.rs`. Do not put unrelated window commands here.
 */
export type WindowSettingsCommands = {
  startup_enhancement_config: { result: StartupEnhancementStatusPayload };
  set_startup_enhancement_config: {
    args: { request: StartupEnhancementConfigPayload };
    result: StartupEnhancementStatusPayload;
  };
  main_window_close: { result: void };
  main_window_exit: { result: void };
};

export type WindowSettingsEvents = {
  "startup-enhancement-state": StartupEnhancementStatePayload;
};

type VerifiedWindowSettingsCommands = WindowSettingsCommands extends TauriCommandMap
  ? WindowSettingsCommands
  : never;

export type WindowSettingsCommandName = keyof WindowSettingsCommands;
export type WindowSettingsNativeOperation = WindowSettingsCommandName | "startup-enhancement-state";

/**
 * A safe, feature-specific error. Tauri rejects Rust `Result<_, String>`
 * commands, but the JavaScript rejection can be an Error, string, or another
 * host value; exposing a uniform Error preserves the command name for UI and
 * tests without leaking raw runtime objects.
 */
export class WindowSettingsTauriError extends Error {
  /** Command name, or the audited event name when event payload validation fails. */
  public readonly command: WindowSettingsNativeOperation;
  public readonly original: unknown;

  public constructor(command: WindowSettingsNativeOperation, message: string, original: unknown) {
    super(message);
    this.name = "WindowSettingsTauriError";
    this.command = command;
    this.original = original;
  }
}

export interface WindowSettingsNativeApi extends WindowSettingsPort {
  /** Subscribe to the native background-state event without accessing a global. */
  listenStartupEnhancementState(
    listener: (event: TauriEvent<StartupEnhancementStatePayload>) => void,
    signal?: AbortSignal,
  ): Promise<TauriUnlisten>;
}

function abortError(): DOMException {
  return new DOMException("The operation was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Native command failed without an error message.";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function requireBoolean(value: Record<string, unknown>, field: string, command: WindowSettingsNativeOperation): boolean {
  if (typeof value[field] !== "boolean") {
    throw new WindowSettingsTauriError(
      command,
      `Native response for ${command} has an invalid ${field} field.`,
      value,
    );
  }
  return value[field];
}

function statusFromNative(value: unknown, command: WindowSettingsCommandName): StartupEnhancementSettings {
  const payload = asRecord(value);
  if (!payload) {
    throw new WindowSettingsTauriError(
      command,
      `Native response for ${command} is not an object.`,
      value,
    );
  }
  return {
    enabled: requireBoolean(payload, "enabled", command),
    continueHighCost: requireBoolean(payload, "continueHighCost", command),
    launchAtLogin: requireBoolean(payload, "launchAtLogin", command),
    launchAtLoginAvailable: requireBoolean(payload, "launchAtLoginAvailable", command),
    launchAtLoginBackground: requireBoolean(payload, "launchAtLoginBackground", command),
    launchAtLoginBackgroundAvailable: requireBoolean(
      payload,
      "launchAtLoginBackgroundAvailable",
      command,
    ),
  };
}

function stateEventFromNative(value: unknown): StartupEnhancementStatePayload {
  const payload = asRecord(value);
  if (!payload) {
    throw new WindowSettingsTauriError(
      "startup-enhancement-state",
      "Native startup enhancement event is not an object.",
      value,
    );
  }
  const backgrounded = requireBoolean(payload, "backgrounded", "startup-enhancement-state");
  const continueHighCost = requireBoolean(payload, "continueHighCost", "startup-enhancement-state");
  const highCostResumeAtMs = payload.highCostResumeAtMs;
  if (typeof highCostResumeAtMs !== "number" || !Number.isFinite(highCostResumeAtMs)) {
    throw new WindowSettingsTauriError(
      "startup-enhancement-state",
      "Native startup enhancement event has an invalid highCostResumeAtMs field.",
      payload,
    );
  }
  return { backgrounded, continueHighCost, highCostResumeAtMs };
}

function configForNative(request: StartupEnhancementSettingsRequest): StartupEnhancementConfigPayload {
  return {
    enabled: request.enabled,
    continueHighCost: request.continueHighCost,
    launchAtLogin: request.launchAtLogin,
    launchAtLoginBackground: request.launchAtLoginBackground,
  };
}

async function invokeWithAbort<TResult>(
  signal: AbortSignal,
  command: WindowSettingsCommandName,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error: unknown) {
    if (signal.aborted) throw abortError();
    if (error instanceof WindowSettingsTauriError) throw error;
    throw new WindowSettingsTauriError(command, errorMessage(error), error);
  }
}

/**
 * Production adapter for the WindowSettings feature boundary.
 *
 * The caller creates `transport` once at its composition root with
 * `transportFromTauriGlobal()`. This adapter deliberately receives that
 * transport instead of reading `window.__TAURI__`, so browser tests can use a
 * pure fake transport and business code stays independent from runtime globals.
 */
export function createWindowSettingsTauriPort(transport: TauriTransport): WindowSettingsNativeApi {
  const api = createTauriApi<VerifiedWindowSettingsCommands>(transport);
  const events = api.events<WindowSettingsEvents>();

  return {
    async loadStartupSettings(signal: AbortSignal): Promise<StartupEnhancementSettings> {
      const result = await invokeWithAbort(signal, "startup_enhancement_config", () =>
        api.invoke("startup_enhancement_config"),
      );
      return statusFromNative(result, "startup_enhancement_config");
    },
    async saveStartupSettings(
      request: StartupEnhancementSettingsRequest,
      signal: AbortSignal,
    ): Promise<StartupEnhancementSettings> {
      const result = await invokeWithAbort(signal, "set_startup_enhancement_config", () =>
        api.invoke("set_startup_enhancement_config", { request: configForNative(request) }),
      );
      return statusFromNative(result, "set_startup_enhancement_config");
    },
    async closeMainWindow(signal: AbortSignal): Promise<void> {
      await invokeWithAbort(signal, "main_window_close", () => api.invoke("main_window_close"));
    },
    async requestApplicationExit(signal: AbortSignal): Promise<void> {
      await invokeWithAbort(signal, "main_window_exit", () => api.invoke("main_window_exit"));
    },
    async listenStartupEnhancementState(
      listener: (event: TauriEvent<StartupEnhancementStatePayload>) => void,
      signal?: AbortSignal,
    ): Promise<TauriUnlisten> {
      if (signal?.aborted) throw abortError();
      try {
        const unlisten = await events.listen("startup-enhancement-state", (event) => {
          const payload = stateEventFromNative(event.payload);
          listener({ ...event, payload });
        });
        if (signal?.aborted) {
          unlisten();
          throw abortError();
        }
        return unlisten;
      } catch (error: unknown) {
        if (signal?.aborted) throw abortError();
        if (error instanceof WindowSettingsTauriError) throw error;
        throw new WindowSettingsTauriError("startup-enhancement-state", errorMessage(error), error);
      }
    },
  };
}
