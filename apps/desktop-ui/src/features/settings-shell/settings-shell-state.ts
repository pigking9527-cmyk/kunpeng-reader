/**
 * State and persistence contracts for settings integration.
 *
 * This module deliberately contains no UI framework, Tauri, browser-storage, or
 * legacy-global access. The legacy host owns those integrations and injects a
 * small port when it mounts the feature.
 */

export const SETTINGS_SECTIONS = [
  "basic",
  "toolbar",
  "shelf",
  "reading",
  "smart",
  "data",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type PreviewTheme = "system" | "light" | "dark";
export type SavePhase = "idle" | "saving" | "saved" | "failed" | "cancelled";

export interface SettingsAppearance {
  readonly previewTheme: PreviewTheme;
  readonly showTitle: boolean;
  readonly showProgress: boolean;
  readonly showRating: boolean;
}

export interface SettingsShellLoadResult {
  /** The previously selected category, if the host persists one. */
  readonly selectedSection?: SettingsSection;
  /** Persisted appearance values. Unknown fields must be discarded by the host. */
  readonly appearance?: Partial<SettingsAppearance>;
}

/**
 * The feature's only persistence boundary. It can be backed by a typed Tauri
 * API, a legacy adapter, or an in-memory fake in a test.
 */
export interface SettingsShellPort {
  load(signal: AbortSignal): Promise<SettingsShellLoadResult>;
  save(appearance: SettingsAppearance, signal: AbortSignal): Promise<void>;
}

export interface SettingsShellState {
  readonly activeSection: SettingsSection;
  readonly navigationCollapsed: boolean;
  readonly initialAppearance: SettingsAppearance;
  readonly draftAppearance: SettingsAppearance;
  readonly phase: SavePhase;
  readonly statusMessage: string | null;
  /** Increments for every save so a late result cannot overwrite a newer one. */
  readonly requestId: number;
}

export const DEFAULT_APPEARANCE: SettingsAppearance = Object.freeze({
  previewTheme: "system",
  showTitle: true,
  showProgress: true,
  showRating: true,
});

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTIONS.includes(value as SettingsSection);
}

export function normalizeAppearance(
  appearance: Partial<SettingsAppearance> | undefined,
): SettingsAppearance {
  const candidate = appearance ?? {};
  return {
    previewTheme:
      candidate.previewTheme === "light" || candidate.previewTheme === "dark"
        ? candidate.previewTheme
        : "system",
    showTitle: candidate.showTitle ?? DEFAULT_APPEARANCE.showTitle,
    showProgress: candidate.showProgress ?? DEFAULT_APPEARANCE.showProgress,
    showRating: candidate.showRating ?? DEFAULT_APPEARANCE.showRating,
  };
}

export function createSettingsShellState(
  initialSection: SettingsSection = "basic",
  preview: Partial<SettingsAppearance> = {},
): SettingsShellState {
  const appearance = normalizeAppearance(preview);
  return {
    activeSection: initialSection,
    navigationCollapsed: false,
    initialAppearance: appearance,
    draftAppearance: appearance,
    phase: "idle",
    statusMessage: null,
    requestId: 0,
  };
}

export type SettingsShellAction =
  | { readonly type: "select-section"; readonly section: SettingsSection }
  | { readonly type: "toggle-navigation" }
  | { readonly type: "patch-appearance"; readonly patch: Partial<SettingsAppearance> }
  | {
      readonly type: "load-succeeded";
      readonly result: SettingsShellLoadResult;
      readonly fixedInitialSection?: SettingsSection;
    }
  | { readonly type: "load-failed"; readonly message: string }
  | { readonly type: "reset-draft" }
  | { readonly type: "save-started"; readonly requestId: number }
  | { readonly type: "save-succeeded"; readonly requestId: number }
  | { readonly type: "save-failed"; readonly requestId: number; readonly message: string }
  | { readonly type: "save-cancelled"; readonly requestId: number };

function statusForLoadFailure(message: string): string {
  return message.trim() ? `无法读取已保存设置：${message}` : "无法读取已保存设置。";
}

function statusForSaveFailure(message: string): string {
  return message.trim() ? `保存失败：${message}` : "保存失败，请重试。";
}

/** Pure state reducer shared by the UI and its Node-level tests. */
export function settingsShellReducer(
  state: SettingsShellState,
  action: SettingsShellAction,
): SettingsShellState {
  switch (action.type) {
    case "select-section":
      return { ...state, activeSection: action.section };
    case "toggle-navigation":
      return { ...state, navigationCollapsed: !state.navigationCollapsed };
    case "patch-appearance":
      return {
        ...state,
        draftAppearance: normalizeAppearance({ ...state.draftAppearance, ...action.patch }),
        phase: state.phase === "saved" ? "idle" : state.phase,
        statusMessage: state.phase === "saved" ? null : state.statusMessage,
      };
    case "load-succeeded": {
      const appearance = normalizeAppearance({ ...state.initialAppearance, ...action.result.appearance });
      return {
        ...state,
        activeSection: action.fixedInitialSection ?? action.result.selectedSection ?? state.activeSection,
        initialAppearance: appearance,
        draftAppearance: appearance,
        phase: "idle",
        statusMessage: null,
      };
    }
    case "load-failed":
      return { ...state, statusMessage: statusForLoadFailure(action.message) };
    case "reset-draft":
      return {
        ...state,
        draftAppearance: state.initialAppearance,
        phase: "idle",
        statusMessage: "已恢复为上次保存的设置。",
      };
    case "save-started":
      return {
        ...state,
        phase: "saving",
        requestId: action.requestId,
        statusMessage: "正在保存…",
      };
    case "save-succeeded":
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        initialAppearance: state.draftAppearance,
        phase: "saved",
        statusMessage: "设置已保存。",
      };
    case "save-failed":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "failed", statusMessage: statusForSaveFailure(action.message) };
    case "save-cancelled":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "cancelled", statusMessage: "已取消保存，尚未写入任何更改。" };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
