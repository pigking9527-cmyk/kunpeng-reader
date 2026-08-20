import type { KeywordSearchResponse, SearchBookResult, SearchHistoryEntry, SearchMode, SearchScope } from "./search-port.js";

export type SearchPhase = "idle" | "loading" | "ready" | "empty" | "error" | "offline" | "cancelled" | "closed";

export interface SearchState {
  readonly phase: SearchPhase;
  readonly requestId: number;
  readonly term: string;
  readonly mode: SearchMode;
  readonly scope: SearchScope;
  readonly results: readonly SearchBookResult[];
  readonly pendingBooks: number;
  readonly history: readonly SearchHistoryEntry[];
  readonly expandedBookIds: ReadonlySet<string>;
  readonly message: string | null;
}

export function createSearchState(initial: Partial<Pick<SearchState, "term" | "scope">> = {}): SearchState {
  return {
    phase: "idle",
    requestId: 0,
    term: initial.term?.trim() ?? "",
    mode: "keyword",
    scope: initial.scope ?? { bookIds: [] },
    results: [],
    pendingBooks: 0,
    history: [],
    expandedBookIds: new Set<string>(),
    message: null,
  };
}

export type SearchAction =
  | { readonly type: "term-changed"; readonly term: string }
  | { readonly type: "mode-changed"; readonly mode: SearchMode }
  | { readonly type: "history-loaded"; readonly history: readonly SearchHistoryEntry[] }
  | { readonly type: "history-updated"; readonly history: readonly SearchHistoryEntry[] }
  | { readonly type: "search-started"; readonly requestId: number; readonly term: string }
  | { readonly type: "keyword-succeeded"; readonly requestId: number; readonly response: KeywordSearchResponse }
  | { readonly type: "semantic-succeeded"; readonly requestId: number; readonly results: readonly SearchBookResult[] }
  | { readonly type: "search-failed"; readonly requestId: number; readonly offline: boolean }
  | { readonly type: "search-cancelled"; readonly requestId: number }
  | { readonly type: "window-query"; readonly term: string; readonly scope: SearchScope }
  | { readonly type: "book-toggled"; readonly bookId: string }
  | { readonly type: "more-hits-loaded"; readonly requestId: number; readonly bookId: string; readonly hits: readonly SearchBookResult["hits"][number][] }
  | { readonly type: "closed" };

function isCurrent(state: SearchState, requestId: number): boolean {
  return state.requestId === requestId
    && state.phase !== "closed"
    && state.phase !== "cancelled"
    && state.phase !== "error"
    && state.phase !== "offline";
}

function replaceHits(results: readonly SearchBookResult[], bookId: string, hits: readonly SearchBookResult["hits"][number][]): readonly SearchBookResult[] {
  return results.map((result) => result.bookId === bookId ? { ...result, hits: [...result.hits, ...hits] } : result);
}

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "term-changed": return state.phase === "closed" ? state : { ...state, term: action.term, message: null };
    case "mode-changed": return state.phase === "closed" ? state : { ...state, mode: action.mode, message: null };
    case "history-loaded":
    case "history-updated": return state.phase === "closed" ? state : { ...state, history: action.history };
    case "search-started": return state.phase === "closed" ? state : { ...state, phase: "loading", requestId: action.requestId, term: action.term, results: [], pendingBooks: 0, expandedBookIds: new Set(), message: "正在检索…" };
    case "keyword-succeeded":
      if (!isCurrent(state, action.requestId)) return state;
      return action.response.results.length
        ? { ...state, phase: "ready", results: action.response.results, pendingBooks: Math.max(0, action.response.pendingBooks), message: null }
        : { ...state, phase: "empty", results: [], pendingBooks: Math.max(0, action.response.pendingBooks), message: action.response.pendingBooks > 0 ? `全文索引正在后台准备 ${action.response.pendingBooks} 本书，完成后可再次搜索。` : "没有找到匹配结果。" };
    case "semantic-succeeded":
      if (!isCurrent(state, action.requestId)) return state;
      return action.results.length ? { ...state, phase: "ready", results: action.results, pendingBooks: 0, message: null } : { ...state, phase: "empty", results: [], pendingBooks: 0, message: "没有语义匹配结果，请确认相关图书已建立索引。" };
    case "search-failed":
      return isCurrent(state, action.requestId) ? { ...state, phase: action.offline ? "offline" : "error", results: [], pendingBooks: 0, message: action.offline ? "当前离线，无法完成搜索。" : "搜索未完成，请稍后重试。" } : state;
    case "search-cancelled": return isCurrent(state, action.requestId) ? { ...state, phase: "cancelled", message: "搜索已取消。" } : state;
    case "window-query": return state.phase === "closed" ? state : { ...state, term: action.term.trim(), scope: action.scope, message: null };
    case "book-toggled": {
      if (state.phase === "closed") return state;
      const expanded = new Set(state.expandedBookIds);
      if (expanded.has(action.bookId)) expanded.delete(action.bookId); else expanded.add(action.bookId);
      return { ...state, expandedBookIds: expanded };
    }
    case "more-hits-loaded": return isCurrent(state, action.requestId) ? { ...state, results: replaceHits(state.results, action.bookId, action.hits) } : state;
    case "closed": return { ...state, phase: "closed", results: [], expandedBookIds: new Set(), message: null };
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export function isOfflineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error && (error as { readonly kind?: unknown }).kind === "offline";
}

/** User history is bounded and contains query metadata, never search results. */
export function nextHistoryEntry(term: string, history: readonly SearchHistoryEntry[], now: number): SearchHistoryEntry | null {
  const cleaned = term.trim();
  if (!cleaned) return null;
  const previous = history.find((entry) => entry.term === cleaned);
  return { term: cleaned, count: (previous?.count ?? 0) + 1, lastUsedAt: now };
}
