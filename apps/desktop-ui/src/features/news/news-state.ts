import type { NewsArticleDocument, NewsFeedSnapshot, NewsPhase, NewsPreferences, NewsSource } from "./news-port.js";

export interface NewsState {
  readonly phase: NewsPhase;
  readonly requestId: number;
  readonly catalog: readonly NewsSource[];
  readonly preferences: NewsPreferences | null;
  readonly feed: NewsFeedSnapshot | null;
  readonly article: NewsArticleDocument | null;
  readonly message: string | null;
}

export function createNewsState(): NewsState {
  return { phase: "loading", requestId: 0, catalog: [], preferences: null, feed: null, article: null, message: null };
}

export type NewsAction =
  | { readonly type: "load-started"; readonly requestId: number }
  | { readonly type: "load-succeeded"; readonly requestId: number; readonly catalog: readonly NewsSource[]; readonly preferences: NewsPreferences; readonly feed: NewsFeedSnapshot }
  | { readonly type: "load-empty"; readonly requestId: number; readonly catalog: readonly NewsSource[]; readonly preferences: NewsPreferences; readonly feed: NewsFeedSnapshot }
  | { readonly type: "load-failed"; readonly requestId: number; readonly offline: boolean; readonly message: string }
  | { readonly type: "load-cancelled"; readonly requestId: number }
  | { readonly type: "preferences-changed"; readonly preferences: NewsPreferences }
  | { readonly type: "article-opened"; readonly article: NewsArticleDocument }
  | { readonly type: "article-closed" }
  | { readonly type: "message"; readonly message: string | null };

export function newsReducer(state: NewsState, action: NewsAction): NewsState {
  switch (action.type) {
    case "load-started": return { ...state, phase: "loading", requestId: action.requestId, message: "正在读取资讯…" };
    case "load-succeeded":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "ready", catalog: action.catalog, preferences: action.preferences, feed: action.feed, message: action.feed.stale ? "正在显示缓存内容；可手动刷新。" : null };
    case "load-empty":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "empty", catalog: action.catalog, preferences: action.preferences, feed: action.feed, message: "当前来源没有可显示的资讯。" };
    case "load-failed":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: action.offline ? "offline" : "error", message: action.message };
    case "load-cancelled":
      return action.requestId === state.requestId ? { ...state, phase: "cancelled", message: "资讯请求已取消。" } : state;
    case "preferences-changed": return { ...state, preferences: action.preferences };
    case "article-opened": return { ...state, article: action.article, message: null };
    case "article-closed": return { ...state, article: null };
    case "message": return { ...state, message: action.message };
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export function isOfflineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error && (error as { readonly kind?: unknown }).kind === "offline";
}
