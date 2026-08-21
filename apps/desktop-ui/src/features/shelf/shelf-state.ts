import type { ShelfBookId, ShelfSnapshot } from "./shelf-port.js";
import { DEFAULT_SHELF_FILTERS, type ShelfFilters, type ShelfSortKey } from "./shelf-rules.js";

export type ShelfPhase = "loading" | "ready" | "error" | "cancelled";

export interface ShelfState {
  readonly phase: ShelfPhase;
  readonly snapshot: ShelfSnapshot | null;
  readonly filters: ShelfFilters;
  readonly sort: ShelfSortKey;
  readonly selected: ReadonlySet<ShelfBookId>;
  readonly requestId: number;
  readonly message: string | null;
}

export function createShelfState(): ShelfState {
  return {
    phase: "loading",
    snapshot: null,
    filters: DEFAULT_SHELF_FILTERS,
    sort: "title",
    selected: new Set<ShelfBookId>(),
    requestId: 0,
    message: null,
  };
}

export type ShelfAction =
  | { readonly type: "load-started"; readonly requestId: number }
  | { readonly type: "load-succeeded"; readonly requestId: number; readonly snapshot: ShelfSnapshot }
  | { readonly type: "load-failed"; readonly requestId: number; readonly message: string }
  | { readonly type: "load-cancelled"; readonly requestId: number }
  | { readonly type: "filters-changed"; readonly filters: ShelfFilters }
  | { readonly type: "sort-changed"; readonly sort: ShelfSortKey }
  | { readonly type: "selection-changed"; readonly selected: ReadonlySet<ShelfBookId> };

export function shelfReducer(state: ShelfState, action: ShelfAction): ShelfState {
  switch (action.type) {
    case "load-started":
      return { ...state, phase: "loading", requestId: action.requestId, message: "正在读取书架…" };
    case "load-succeeded":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "ready", snapshot: action.snapshot, selected: new Set(), message: null };
    case "load-failed":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "error", message: action.message || "读取书架失败。" };
    case "load-cancelled":
      if (action.requestId !== state.requestId) return state;
      return { ...state, phase: "cancelled", message: "已取消读取书架。" };
    case "filters-changed": return { ...state, filters: action.filters };
    case "sort-changed": return { ...state, sort: action.sort };
    case "selection-changed": return { ...state, selected: new Set(action.selected) };
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "发生未知错误";
}
