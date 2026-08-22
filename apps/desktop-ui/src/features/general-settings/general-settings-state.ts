import type {
  AutoImportDirectory,
  AutoImportProgress,
  AutoImportSettings,
  ClassificationSnapshot,
  ExperimentalOptions,
  ExperimentalOptionsCompatibilityInput,
} from "./general-settings-port.js";

export const DEFAULT_EXPERIMENTAL_OPTIONS: ExperimentalOptions = Object.freeze({
  newsnowPrefetch: true,
  newsnowHideReturnIcon: false,
});

export type GeneralSettingsPhase = "loading" | "ready" | "saving" | "saved" | "failed" | "cancelled";
export type AutoImportScanPhase = "idle" | "scanning" | "waiting" | "completed" | "failed" | "cancelled";

export interface GeneralSettingsState {
  readonly phase: GeneralSettingsPhase;
  readonly requestId: number;
  readonly savedAutoImport: AutoImportSettings;
  readonly draftAutoImport: AutoImportSettings;
  readonly classification: ClassificationSnapshot | null;
  readonly experimental: ExperimentalOptions;
  readonly needsExperimentalCompatibilityWrite: boolean;
  readonly scanPhase: AutoImportScanPhase;
  readonly scanMessage: string | null;
  readonly notice: string | null;
}

const EMPTY_AUTO_IMPORT: AutoImportSettings = Object.freeze({ enabled: false, directories: Object.freeze([]) });

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Converts current persisted keys and safely ignores the retired News master switch. */
export function normalizeExperimentalOptions(
  candidate: ExperimentalOptionsCompatibilityInput | undefined,
): ExperimentalOptions {
  return {
    newsnowPrefetch: booleanValue(candidate?.newsnowPrefetch, DEFAULT_EXPERIMENTAL_OPTIONS.newsnowPrefetch),
    newsnowHideReturnIcon: booleanValue(candidate?.newsnowHideReturnIcon, DEFAULT_EXPERIMENTAL_OPTIONS.newsnowHideReturnIcon),
  };
}

export function uniqueDirectories(directories: readonly AutoImportDirectory[]): readonly AutoImportDirectory[] {
  const ids = new Set<string>();
  return directories.filter((directory) => {
    if (!directory.id.trim() || !directory.label.trim() || ids.has(directory.id)) return false;
    ids.add(directory.id);
    return true;
  });
}

export function normalizeAutoImportSettings(candidate: AutoImportSettings | undefined): AutoImportSettings {
  const source = candidate ?? EMPTY_AUTO_IMPORT;
  return { enabled: source.enabled === true, directories: uniqueDirectories(source.directories) };
}

export function createGeneralSettingsState(): GeneralSettingsState {
  return {
    phase: "loading",
    requestId: 0,
    savedAutoImport: EMPTY_AUTO_IMPORT,
    draftAutoImport: EMPTY_AUTO_IMPORT,
    classification: null,
    experimental: DEFAULT_EXPERIMENTAL_OPTIONS,
    needsExperimentalCompatibilityWrite: false,
    scanPhase: "idle",
    scanMessage: null,
    notice: null,
  };
}

export interface GeneralSettingsBootstrap {
  readonly autoImport: AutoImportSettings;
  readonly classification: ClassificationSnapshot;
  readonly experimental: ExperimentalOptions;
  readonly needsExperimentalCompatibilityWrite: boolean;
}

export type GeneralSettingsAction =
  | { readonly type: "load-succeeded"; readonly bootstrap: GeneralSettingsBootstrap }
  | { readonly type: "load-failed" }
  | { readonly type: "patch-auto-import"; readonly patch: Partial<AutoImportSettings> }
  | { readonly type: "replace-auto-import-directories"; readonly directories: readonly AutoImportDirectory[] }
  | { readonly type: "save-started"; readonly requestId: number }
  | { readonly type: "save-succeeded"; readonly requestId: number; readonly settings: AutoImportSettings }
  | { readonly type: "save-failed"; readonly requestId: number }
  | { readonly type: "save-cancelled"; readonly requestId: number }
  | { readonly type: "scan-progress"; readonly progress: AutoImportProgress }
  | { readonly type: "scan-succeeded"; readonly added: number }
  | { readonly type: "scan-failed" }
  | { readonly type: "scan-cancelled" }
  | { readonly type: "classification-succeeded"; readonly classification: ClassificationSnapshot }
  | { readonly type: "classification-failed" }
  | { readonly type: "experimental-saved"; readonly options: ExperimentalOptions }
  | { readonly type: "experimental-failed" };

function noticeForProgress(progress: AutoImportProgress): string {
  if (progress.phase === "scan") return `正在扫描目录…已发现 ${Math.max(0, progress.found)} 个文件`;
  if (progress.phase === "import") return `正在导入 ${Math.max(0, progress.processed)}/${Math.max(0, progress.total)}，已新增 ${Math.max(0, progress.added)} 本`;
  if (progress.phase === "waiting") return `检测到 ${Math.max(0, progress.deferred)} 个仍在复制的文件，完成后会自动检查。`;
  if (progress.phase === "permission-denied") return "部分自动导入目录无法读取，请检查目录权限。";
  return `扫描完成，新增 ${Math.max(0, progress.added)} 本图书。`;
}

function nextScanPhase(progress: AutoImportProgress): AutoImportScanPhase {
  if (progress.phase === "waiting") return "waiting";
  if (progress.phase === "done") return "completed";
  return "scanning";
}

/** Pure reducer keeps save rollback and scan cancellation deterministic. */
export function generalSettingsReducer(
  state: GeneralSettingsState,
  action: GeneralSettingsAction,
): GeneralSettingsState {
  switch (action.type) {
    case "load-succeeded": {
      const autoImport = normalizeAutoImportSettings(action.bootstrap.autoImport);
      return {
        ...state,
        phase: "ready",
        savedAutoImport: autoImport,
        draftAutoImport: autoImport,
        classification: action.bootstrap.classification,
        experimental: action.bootstrap.experimental,
        needsExperimentalCompatibilityWrite: action.bootstrap.needsExperimentalCompatibilityWrite,
        notice: null,
      };
    }
    case "load-failed":
      return { ...state, phase: "failed", notice: "无法读取通用设置，请稍后重试。" };
    case "patch-auto-import": {
      const draft = normalizeAutoImportSettings({ ...state.draftAutoImport, ...action.patch });
      const noDirectories = draft.enabled && draft.directories.length === 0;
      return {
        ...state,
        phase: state.phase === "saved" ? "ready" : state.phase,
        draftAutoImport: draft,
        notice: noDirectories ? "请至少选择一个可访问的导入目录。" : null,
      };
    }
    case "replace-auto-import-directories": {
      const draft = normalizeAutoImportSettings({ ...state.draftAutoImport, directories: action.directories });
      return { ...state, draftAutoImport: draft, notice: draft.directories.length ? "目录选择已更新，尚未保存。" : "尚未选择导入目录。" };
    }
    case "save-started":
      return { ...state, phase: "saving", requestId: action.requestId, notice: "正在保存自动导入设置…" };
    case "save-succeeded": {
      if (action.requestId !== state.requestId) return state;
      const settings = normalizeAutoImportSettings(action.settings);
      return { ...state, phase: "saved", savedAutoImport: settings, draftAutoImport: settings, notice: "自动导入设置已保存。" };
    }
    case "save-failed":
      if (action.requestId !== state.requestId) return state;
      // The native save did not complete: render the confirmed value, not an optimistic lie.
      return { ...state, phase: "failed", draftAutoImport: state.savedAutoImport, notice: "保存自动导入设置失败，已恢复为上次保存的设置。" };
    case "save-cancelled":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "cancelled", draftAutoImport: state.savedAutoImport, notice: "已取消保存，尚未写入更改。" };
    case "scan-progress":
      return { ...state, scanPhase: nextScanPhase(action.progress), scanMessage: noticeForProgress(action.progress) };
    case "scan-succeeded":
      return { ...state, scanPhase: "completed", scanMessage: action.added > 0 ? `扫描完成，新增 ${action.added} 本图书。` : "扫描完成，没有发现新图书。" };
    case "scan-failed":
      return { ...state, scanPhase: "failed", scanMessage: "自动导入扫描失败，请检查目录权限后重试。" };
    case "scan-cancelled":
      return { ...state, scanPhase: "cancelled", scanMessage: "已取消自动导入扫描；已完成的批次会保留。" };
    case "classification-succeeded":
      return { ...state, classification: action.classification, notice: "书籍分类状态已更新。" };
    case "classification-failed":
      return { ...state, notice: "无法更新书籍分类状态，请稍后重试。" };
    case "experimental-saved":
      return { ...state, experimental: action.options, needsExperimentalCompatibilityWrite: false, notice: "资讯实验设置已保存。" };
    case "experimental-failed":
      return { ...state, notice: "保存资讯实验设置失败，请重试。" };
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
