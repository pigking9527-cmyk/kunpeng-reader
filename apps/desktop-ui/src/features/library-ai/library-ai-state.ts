import type {
  LibraryAiAnswer,
  LibraryAiBootstrap,
  LibraryAiHistorySnapshot,
  LibraryAiSettings,
  LibraryAiTask,
  QueryProgress,
  SemanticModelOption,
  SemanticStatus,
} from "./library-ai-port.js";

export type LibraryAiPhase = "idle" | "loading" | "ready" | "querying" | "success" | "failure" | "offline" | "cancelled";

export interface LibraryAiState {
  readonly phase: LibraryAiPhase;
  readonly requestId: number;
  readonly configured: boolean;
  readonly books: LibraryAiBootstrap["books"];
  readonly semantic: SemanticStatus | null;
  readonly semanticModels: readonly SemanticModelOption[];
  readonly settings: LibraryAiSettings;
  readonly history: LibraryAiHistorySnapshot;
  readonly task: LibraryAiTask;
  readonly selectedBookIds: ReadonlySet<string>;
  readonly progress: QueryProgress | null;
  readonly answer: LibraryAiAnswer | null;
  readonly showingHistory: boolean;
  /** Safe fixed copy only; caught error text never belongs in state. */
  readonly notice: string;
}

const defaultSettings: LibraryAiSettings = Object.freeze({
  answerLength: "short",
  recommendationCandidateLimit: 20,
  recommendationResultLimit: 12,
});

export const initialLibraryAiState: LibraryAiState = Object.freeze({
  phase: "idle",
  requestId: 0,
  configured: false,
  books: [],
  semantic: null,
  semanticModels: [],
  settings: defaultSettings,
  history: Object.freeze({ entries: [], syncMode: "off" }),
  task: "question",
  selectedBookIds: new Set<string>(),
  progress: null,
  answer: null,
  showingHistory: false,
  notice: "",
});

export type LibraryAiAction =
  | { readonly type: "load-started"; readonly requestId: number }
  | { readonly type: "load-succeeded"; readonly requestId: number; readonly bootstrap: LibraryAiBootstrap }
  | { readonly type: "load-failed"; readonly requestId: number; readonly offline: boolean }
  | { readonly type: "task-selected"; readonly task: LibraryAiTask }
  | { readonly type: "selection-changed"; readonly bookId: string; readonly selected: boolean }
  | { readonly type: "query-started"; readonly requestId: number }
  | { readonly type: "query-progress"; readonly requestId: number; readonly progress: QueryProgress }
  | { readonly type: "query-succeeded"; readonly requestId: number; readonly answer: LibraryAiAnswer }
  | { readonly type: "query-failed"; readonly requestId: number; readonly offline: boolean }
  | { readonly type: "query-cancelled"; readonly requestId: number }
  | { readonly type: "semantic-updated"; readonly semantic: SemanticStatus; readonly notice: string }
  | { readonly type: "settings-updated"; readonly settings: LibraryAiSettings }
  | { readonly type: "history-updated"; readonly history: LibraryAiHistorySnapshot }
  | { readonly type: "history-toggle" }
  | { readonly type: "notice"; readonly notice: string };

function isCurrent(actionRequestId: number, state: LibraryAiState): boolean {
  return actionRequestId === state.requestId;
}

function selectionFor(state: LibraryAiState, action: Extract<LibraryAiAction, { type: "selection-changed" }>): ReadonlySet<string> {
  const next = new Set(state.selectedBookIds);
  if (action.selected) next.add(action.bookId); else next.delete(action.bookId);
  if (state.task === "compare" && next.size > 8) return state.selectedBookIds;
  return next;
}

export function libraryAiReducer(state: LibraryAiState, action: LibraryAiAction): LibraryAiState {
  switch (action.type) {
    case "load-started":
      return { ...state, phase: "loading", requestId: action.requestId, notice: "正在读取书库与语义状态…" };
    case "load-succeeded":
      if (!isCurrent(action.requestId, state)) return state;
      return {
        ...state,
        phase: "ready",
        configured: action.bootstrap.configured,
        books: action.bootstrap.books.filter((book) => book.available),
        semantic: action.bootstrap.semantic,
        semanticModels: action.bootstrap.semanticModels,
        settings: action.bootstrap.settings,
        history: action.bootstrap.history,
        notice: readinessNotice(action.bootstrap.configured, action.bootstrap.semantic),
      };
    case "load-failed":
      if (!isCurrent(action.requestId, state)) return state;
      return { ...state, phase: action.offline ? "offline" : "failure", notice: action.offline ? "当前离线，无法读取书库问答状态。" : "无法读取书库问答状态，请稍后重试。" };
    case "task-selected": {
      const selected = action.task === "compare" && state.selectedBookIds.size > 8
        ? new Set([...state.selectedBookIds].slice(0, 8))
        : state.selectedBookIds;
      return { ...state, task: action.task, selectedBookIds: selected, notice: "" };
    }
    case "selection-changed":
      return { ...state, selectedBookIds: selectionFor(state, action) };
    case "query-started":
      return { ...state, phase: "querying", requestId: action.requestId, progress: { stage: "retrieving", label: "正在检索本地语义索引…" }, answer: null, showingHistory: false, notice: "" };
    case "query-progress":
      return isCurrent(action.requestId, state) ? { ...state, progress: action.progress } : state;
    case "query-succeeded":
      return isCurrent(action.requestId, state) ? { ...state, phase: "success", progress: null, answer: action.answer, notice: "回答已生成；引用仅显示脱敏来源信息。" } : state;
    case "query-failed":
      return isCurrent(action.requestId, state)
        ? { ...state, phase: action.offline ? "offline" : "failure", progress: null, notice: action.offline ? "当前离线，问答会在网络恢复后重试。" : "书库问答未完成，请检查模型和索引后重试。" }
        : state;
    case "query-cancelled":
      return isCurrent(action.requestId, state) ? { ...state, phase: "cancelled", progress: null, notice: "问答已取消。" } : state;
    case "semantic-updated":
      return { ...state, semantic: action.semantic, notice: action.notice };
    case "settings-updated":
      return { ...state, settings: action.settings, notice: "设置已保存。" };
    case "history-updated":
      return { ...state, history: action.history, notice: "问答记录已更新。" };
    case "history-toggle":
      return { ...state, showingHistory: !state.showingHistory, notice: "" };
    case "notice":
      return { ...state, notice: action.notice };
  }
}

export function readinessNotice(configured: boolean, semantic: SemanticStatus): string {
  if (!configured && !semantic.indexReady) return "请先配置大模型并建立本地语义索引。";
  if (!configured) return "请先配置大模型。";
  if (!semantic.indexReady) return "请先下载模型并建立本地语义索引。";
  return "";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isOfflineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error && (error as { readonly kind?: unknown }).kind === "offline";
}
