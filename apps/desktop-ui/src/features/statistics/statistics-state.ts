import {
  normalizeAnchor,
  rangeForScope,
  type ReadingStatsScope,
} from "../reading-stats/reading-stats-state.js";
import type { StatisticsRange } from "./statistics-port.js";

export const STATISTICS_SCOPES = ["day", "week", "month", "year", "total"] as const;
export type StatisticsScope = (typeof STATISTICS_SCOPES)[number];
export type StatisticsPhase = "idle" | "loading" | "ready" | "empty" | "error" | "cancelled" | "closed";

/** A bounded Chinese message; adapters must not pass transport details through it. */
export const STATISTICS_LOAD_ERROR = "暂时无法加载阅读统计，请稍后重试。";

export interface StatisticsState {
  readonly scope: StatisticsScope;
  readonly anchor: Date;
  readonly requestId: number;
  readonly phase: StatisticsPhase;
  readonly range: StatisticsRange | null;
  readonly total: StatisticsRange | null;
  readonly message: string | null;
}

export function createStatisticsState(now: Date = new Date()): StatisticsState {
  return {
    scope: "day",
    anchor: normalizeAnchor("day", now),
    requestId: 0,
    phase: "idle",
    range: null,
    total: null,
    message: null,
  };
}

export type StatisticsAction =
  | { readonly type: "load-started"; readonly requestId: number; readonly scope: StatisticsScope; readonly anchor: Date }
  | { readonly type: "load-succeeded"; readonly requestId: number; readonly range: StatisticsRange; readonly total: StatisticsRange }
  | { readonly type: "load-failed"; readonly requestId: number }
  | { readonly type: "load-cancelled"; readonly requestId: number }
  | { readonly type: "closed" };

function isEmpty(range: StatisticsRange): boolean {
  return range.total_seconds <= 0 && range.total_words <= 0 && range.books.length === 0;
}

/**
 * State transitions reject old completions and every completion after close.
 * This is important because a legacy/native adapter may resolve despite an
 * AbortSignal being cancelled.
 */
export function statisticsReducer(state: StatisticsState, action: StatisticsAction): StatisticsState {
  if (state.phase === "closed" && action.type !== "closed") return state;

  switch (action.type) {
    case "load-started":
      return {
        ...state,
        scope: action.scope,
        anchor: normalizeAnchor(action.scope, action.anchor),
        requestId: action.requestId,
        phase: "loading",
        message: null,
      };
    case "load-succeeded":
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        phase: isEmpty(action.range) ? "empty" : "ready",
        range: action.range,
        total: action.total,
        message: null,
      };
    case "load-failed":
      return action.requestId === state.requestId
        ? { ...state, phase: "error", message: STATISTICS_LOAD_ERROR }
        : state;
    case "load-cancelled":
      return action.requestId === state.requestId
        ? { ...state, phase: "cancelled", message: "已取消加载阅读统计。" }
        : state;
    case "closed":
      return { ...state, phase: "closed", message: null };
  }
}

export function requestForStatisticsScope(scope: StatisticsScope, anchor: Date) {
  return rangeForScope(scope as ReadingStatsScope, anchor);
}
