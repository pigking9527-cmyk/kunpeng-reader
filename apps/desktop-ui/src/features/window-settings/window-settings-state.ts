import type {
  StartupEnhancementSettings,
  StartupEnhancementSettingsRequest,
} from "./window-settings-port";

export type WindowSettingsPhase = "loading" | "ready" | "saving" | "saved" | "failed" | "cancelled";

export const DEFAULT_STARTUP_ENHANCEMENT_SETTINGS: StartupEnhancementSettings = Object.freeze({
  enabled: false,
  continueHighCost: false,
  launchAtLogin: false,
  launchAtLoginAvailable: false,
  launchAtLoginBackground: false,
  launchAtLoginBackgroundAvailable: false,
});

export interface WindowSettingsState {
  readonly phase: WindowSettingsPhase;
  readonly saved: StartupEnhancementSettings;
  readonly draft: StartupEnhancementSettings;
  readonly requestId: number;
  readonly statusMessage: string | null;
}

export function normalizeStartupEnhancementSettings(
  candidate: Partial<StartupEnhancementSettings> | undefined,
): StartupEnhancementSettings {
  const value = candidate ?? {};
  const launchAtLogin = value.launchAtLogin === true && value.launchAtLoginAvailable === true;
  return {
    enabled: value.enabled === true,
    continueHighCost: value.continueHighCost === true,
    launchAtLogin,
    launchAtLoginAvailable: value.launchAtLoginAvailable === true,
    launchAtLoginBackground:
      launchAtLogin
      && value.launchAtLoginBackgroundAvailable === true
      && value.launchAtLoginBackground === true,
    launchAtLoginBackgroundAvailable: value.launchAtLoginBackgroundAvailable === true,
  };
}

export function startupEnhancementRequest(
  settings: StartupEnhancementSettings,
): StartupEnhancementSettingsRequest {
  return {
    enabled: settings.enabled,
    continueHighCost: settings.continueHighCost,
    launchAtLogin: settings.launchAtLogin,
    launchAtLoginBackground: settings.launchAtLoginBackground,
  };
}

export function createWindowSettingsState(): WindowSettingsState {
  return {
    phase: "loading",
    saved: DEFAULT_STARTUP_ENHANCEMENT_SETTINGS,
    draft: DEFAULT_STARTUP_ENHANCEMENT_SETTINGS,
    requestId: 0,
    statusMessage: null,
  };
}

export type WindowSettingsAction =
  | { readonly type: "load-succeeded"; readonly settings: StartupEnhancementSettings }
  | { readonly type: "load-failed"; readonly message: string }
  | { readonly type: "patch"; readonly patch: Partial<StartupEnhancementSettings> }
  | { readonly type: "reset" }
  | { readonly type: "save-started"; readonly requestId: number }
  | { readonly type: "save-succeeded"; readonly requestId: number; readonly settings: StartupEnhancementSettings }
  | { readonly type: "save-failed"; readonly requestId: number; readonly message: string }
  | { readonly type: "save-cancelled"; readonly requestId: number };

function failureMessage(prefix: string, message: string): string {
  return message.trim() ? `${prefix}：${message}` : `${prefix}。`;
}

/** Pure state machine so save races and platform capabilities can be unit tested. */
export function windowSettingsReducer(
  state: WindowSettingsState,
  action: WindowSettingsAction,
): WindowSettingsState {
  switch (action.type) {
    case "load-succeeded": {
      const settings = normalizeStartupEnhancementSettings(action.settings);
      return { ...state, phase: "ready", saved: settings, draft: settings, statusMessage: null };
    }
    case "load-failed":
      return {
        ...state,
        phase: "failed",
        statusMessage: failureMessage("无法读取窗口设置", action.message),
      };
    case "patch":
      return {
        ...state,
        phase: state.phase === "saved" ? "ready" : state.phase,
        draft: normalizeStartupEnhancementSettings({ ...state.draft, ...action.patch }),
        statusMessage: state.phase === "saved" ? null : state.statusMessage,
      };
    case "reset":
      return {
        ...state,
        phase: "ready",
        draft: state.saved,
        statusMessage: "已恢复为上次保存的窗口设置。",
      };
    case "save-started":
      return { ...state, phase: "saving", requestId: action.requestId, statusMessage: "正在保存窗口设置…" };
    case "save-succeeded": {
      if (action.requestId !== state.requestId) return state;
      const settings = normalizeStartupEnhancementSettings(action.settings);
      return { ...state, phase: "saved", saved: settings, draft: settings, statusMessage: "窗口设置已保存。" };
    }
    case "save-failed":
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        phase: "failed",
        statusMessage: failureMessage("保存窗口设置失败", action.message),
      };
    case "save-cancelled":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "cancelled", statusMessage: "已取消保存，尚未写入更改。" };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
