import type {
  ReaderNoteSummary,
  ReaderSearchHit,
  ReaderShellEvent,
  ReaderShellPanel,
  ReaderShellPreferences,
  ReaderShellPreferencesPatch,
} from "./reader-shell-port.js";

export type ReaderShellPhase = "loading" | "ready" | "failed" | "cancelled" | "closed";
export type ReaderPanelPhase = "idle" | "loading" | "ready" | "saving" | "failed" | "cancelled";

export const DEFAULT_READER_SHELL_PREFERENCES: ReaderShellPreferences = Object.freeze({
  theme: "light",
  backgroundPreset: "light",
  customPaletteId: "",
  customBackgroundColor: "#fffdf8",
  textColor: "",
  linkColor: "",
  selectionColor: "",
  footnoteBackground: "",
  footnoteBorder: "",
  backgroundAsset: null,
  fontFamily: "",
  styleMode: "local",
  textConversion: "t2s",
  fontSize: 18,
  noteFontSize: 14,
  lineHeight: 1.7,
  paraSpacing: 0.6,
  letterSpacing: 0,
  marginTop: 18,
  marginBottom: 24,
  marginLeft: 28,
  marginRight: 28,
  dualPageGap: 40,
  flowMode: "paged",
  pageMode: "single",
  pageTurnEffect: "horizontal",
  pageTurnSpeed: 1,
  ttsSource: "edge",
  ttsRate: 1,
  imagePagination: "next-page",
  showTextConversion: true,
  showTocButton: true,
  showChapterButtons: true,
  showVocabularyButton: true,
  showTtsButton: true,
  showAnnotationButton: true,
  toolbarOrder: ["toc", "chapters", "tts", "annotations", "vocabulary", "settings"] as const,
  showPageInfo: true,
  showReaderJumpBack: true,
  readerJumpBackDismissMode: "pages",
  readerJumpBackDismissSeconds: 30,
  readerJumpBackDismissPages: 3,
  readerJumpBackIconSizePx: 32,
  readerJumpBackPositionX: 950,
  readerJumpBackPositionY: 500,
});

export interface ReaderShellState {
  readonly phase: ReaderShellPhase;
  readonly activePanel: ReaderShellPanel | null;
  readonly preferences: ReaderShellPreferences;
  readonly preferencesRequestId: number;
  readonly preferencesPhase: ReaderPanelPhase;
  readonly notes: readonly ReaderNoteSummary[];
  readonly notesRequestId: number;
  readonly notesPhase: ReaderPanelPhase;
  readonly searchQuery: string;
  readonly searchHits: readonly ReaderSearchHit[];
  readonly searchRequestId: number;
  readonly searchPhase: ReaderPanelPhase;
  readonly engine: "epub" | "pdf" | null;
  readonly notice: string | null;
}

export function createReaderShellState(): ReaderShellState {
  return {
    phase: "loading",
    activePanel: null,
    preferences: DEFAULT_READER_SHELL_PREFERENCES,
    preferencesRequestId: 0,
    preferencesPhase: "idle",
    notes: [],
    notesRequestId: 0,
    notesPhase: "idle",
    searchQuery: "",
    searchHits: [],
    searchRequestId: 0,
    searchPhase: "idle",
    engine: null,
    notice: "正在准备阅读器工具栏…",
  };
}

export type ReaderShellAction =
  | { readonly type: "preferences-loaded"; readonly preferences: ReaderShellPreferences }
  | { readonly type: "preferences-load-failed" }
  | { readonly type: "panel-opened"; readonly panel: ReaderShellPanel }
  | { readonly type: "panel-closed" }
  | { readonly type: "preferences-save-started"; readonly requestId: number }
  | { readonly type: "preferences-save-succeeded"; readonly requestId: number; readonly preferences: ReaderShellPreferences }
  | { readonly type: "preferences-save-failed"; readonly requestId: number }
  | { readonly type: "preferences-save-cancelled"; readonly requestId: number }
  | { readonly type: "notes-load-started"; readonly requestId: number }
  | { readonly type: "notes-load-succeeded"; readonly requestId: number; readonly notes: readonly ReaderNoteSummary[] }
  | { readonly type: "notes-load-failed"; readonly requestId: number }
  | { readonly type: "notes-load-cancelled"; readonly requestId: number }
  | { readonly type: "notes-save-started"; readonly requestId: number }
  | { readonly type: "notes-save-succeeded"; readonly requestId: number; readonly notes: readonly ReaderNoteSummary[] }
  | { readonly type: "notes-save-failed"; readonly requestId: number }
  | { readonly type: "search-query-changed"; readonly query: string }
  | { readonly type: "search-started"; readonly requestId: number; readonly query: string }
  | { readonly type: "search-succeeded"; readonly requestId: number; readonly hits: readonly ReaderSearchHit[] }
  | { readonly type: "search-failed"; readonly requestId: number }
  | { readonly type: "search-cancelled"; readonly requestId: number }
  | { readonly type: "engine-event"; readonly event: ReaderShellEvent }
  | { readonly type: "closed" };

function isOpen(state: ReaderShellState): boolean {
  return state.phase !== "closed";
}

function isCurrent(
  requestId: number,
  current: number,
  phase: ReaderPanelPhase,
  state: ReaderShellState,
): boolean {
  return isOpen(state) && requestId === current && (phase === "loading" || phase === "saving");
}

function clearedClosedState(state: ReaderShellState): ReaderShellState {
  return {
    ...state,
    phase: "closed",
    activePanel: null,
    notes: [],
    notesPhase: "idle",
    searchQuery: "",
    searchHits: [],
    searchPhase: "idle",
    notice: null,
  };
}

/** Pure reducer: data arriving after cancellation/close cannot repopulate panels. */
export function readerShellReducer(state: ReaderShellState, action: ReaderShellAction): ReaderShellState {
  switch (action.type) {
    case "preferences-loaded":
      return isOpen(state) ? { ...state, phase: "ready", preferences: action.preferences, preferencesPhase: "ready", notice: null } : state;
    case "preferences-load-failed":
      return isOpen(state) ? { ...state, phase: "failed", preferencesPhase: "failed", notice: "无法读取阅读偏好，请稍后重试。" } : state;
    case "panel-opened":
      return isOpen(state) ? { ...state, activePanel: action.panel, notice: null } : state;
    case "panel-closed":
      // Invalidate every panel request before dropping its display-only data.
      // A native promise resolving after Escape must not repopulate a closed
      // surface with excerpts or notes.
      return isOpen(state) ? {
        ...state,
        activePanel: null,
        preferencesRequestId: state.preferencesRequestId + 1,
        preferencesPhase: state.preferencesPhase === "saving" ? "cancelled" : state.preferencesPhase,
        notes: [],
        notesRequestId: state.notesRequestId + 1,
        notesPhase: "idle",
        searchQuery: "",
        searchHits: [],
        searchRequestId: state.searchRequestId + 1,
        searchPhase: "idle",
        notice: null,
      } : state;
    case "preferences-save-started":
      return isOpen(state) ? { ...state, preferencesRequestId: action.requestId, preferencesPhase: "saving", notice: "正在应用阅读偏好…" } : state;
    case "preferences-save-succeeded":
      return isCurrent(action.requestId, state.preferencesRequestId, state.preferencesPhase, state)
        ? { ...state, preferences: action.preferences, preferencesPhase: "ready", notice: "阅读偏好已应用。" }
        : state;
    case "preferences-save-failed":
      return isCurrent(action.requestId, state.preferencesRequestId, state.preferencesPhase, state)
        ? { ...state, preferencesPhase: "failed", notice: "应用阅读偏好失败，请重试。" }
        : state;
    case "preferences-save-cancelled":
      return isCurrent(action.requestId, state.preferencesRequestId, state.preferencesPhase, state)
        ? { ...state, preferencesPhase: "cancelled", notice: "已取消应用阅读偏好。" }
        : state;
    case "notes-load-started":
      return isOpen(state) ? { ...state, notesRequestId: action.requestId, notesPhase: "loading", notice: "正在读取笔记…" } : state;
    case "notes-load-succeeded":
      return isCurrent(action.requestId, state.notesRequestId, state.notesPhase, state)
        ? { ...state, notes: action.notes, notesPhase: "ready", notice: null }
        : state;
    case "notes-load-failed":
      return isCurrent(action.requestId, state.notesRequestId, state.notesPhase, state)
        ? { ...state, notes: [], notesPhase: "failed", notice: "无法读取笔记，请稍后重试。" }
        : state;
    case "notes-load-cancelled":
      return isCurrent(action.requestId, state.notesRequestId, state.notesPhase, state)
        ? { ...state, notes: [], notesPhase: "cancelled", notice: "已取消读取笔记。" }
        : state;
    case "notes-save-started":
      return isOpen(state) ? { ...state, notesRequestId: action.requestId, notesPhase: "saving", notice: "正在保存笔记…" } : state;
    case "notes-save-succeeded":
      return isCurrent(action.requestId, state.notesRequestId, state.notesPhase, state)
        ? { ...state, notes: action.notes, notesPhase: "ready", notice: "笔记已保存。" }
        : state;
    case "notes-save-failed":
      return isCurrent(action.requestId, state.notesRequestId, state.notesPhase, state)
        ? { ...state, notesPhase: "failed", notice: "保存笔记失败，请重试。" }
        : state;
    case "search-query-changed":
      return isOpen(state) ? { ...state, searchQuery: action.query, notice: null } : state;
    case "search-started":
      return isOpen(state) ? { ...state, searchRequestId: action.requestId, searchQuery: action.query, searchHits: [], searchPhase: "loading", notice: "正在搜索本书…" } : state;
    case "search-succeeded":
      return isCurrent(action.requestId, state.searchRequestId, state.searchPhase, state)
        ? { ...state, searchHits: action.hits, searchPhase: "ready", notice: action.hits.length ? null : "本书中没有匹配内容。" }
        : state;
    case "search-failed":
      return isCurrent(action.requestId, state.searchRequestId, state.searchPhase, state)
        ? { ...state, searchHits: [], searchPhase: "failed", notice: "搜索未完成，请稍后重试。" }
        : state;
    case "search-cancelled":
      return isCurrent(action.requestId, state.searchRequestId, state.searchPhase, state)
        ? { ...state, searchHits: [], searchPhase: "cancelled", notice: "已取消搜索。" }
        : state;
    case "engine-event": {
      if (!isOpen(state)) return state;
      if (action.event.type === "engine-ready") return { ...state, engine: action.event.engine, notice: null };
      if (action.event.type === "engine-unavailable") return { ...state, engine: null, notice: "阅读引擎暂不可用。" };
      if (action.event.type === "layout-idle") return { ...state, notice: null };
      if (action.event.type === "open-panel") return { ...state, activePanel: action.event.panel, notice: null };
      return clearedClosedState(state);
    }
    case "closed": return clearedClosedState(state);
  }
}

export function mergeReaderShellPreferences(
  current: ReaderShellPreferences,
  patch: ReaderShellPreferencesPatch,
): ReaderShellPreferences {
  return { ...current, ...patch };
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
