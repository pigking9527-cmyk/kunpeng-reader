import type { StatisticsPort } from "./statistics-port.js";
import {
  createStatisticsState,
  requestForStatisticsScope,
  statisticsReducer,
  type StatisticsScope,
  type StatisticsState,
} from "./statistics-state.js";

export type StatisticsListener = (state: StatisticsState) => void;

export interface StatisticsController {
  getState(): StatisticsState;
  subscribe(listener: StatisticsListener): () => void;
  load(scope?: StatisticsScope, anchor?: Date): Promise<void>;
  close(): void;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

/**
 * Owns one cancellable statistics load at a time.  It is deliberately outside
 * UI code so native/WebView cancellation and stale-result handling can be tested
 * without a DOM and reused by the legacy fallback host.
 */
export function createStatisticsController(
  port: StatisticsPort,
  now: Date = new Date(),
): StatisticsController {
  let state = createStatisticsState(now);
  let active: AbortController | null = null;
  let nextRequestId = 0;
  let closed = false;
  const listeners = new Set<StatisticsListener>();

  const publish = (next: StatisticsState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  return {
    getState: () => state,
    subscribe(listener: StatisticsListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(scope = state.scope, anchor = state.anchor): Promise<void> {
      if (closed) return;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const requestId = ++nextRequestId;
      publish(statisticsReducer(state, { type: "load-started", requestId, scope, anchor }));

      try {
        const [range, total] = await Promise.all([
          port.getRange(requestForStatisticsScope(scope, anchor), controller.signal),
          port.getRange(requestForStatisticsScope("total", anchor), controller.signal),
        ]);
        if (closed || active !== controller) return;
        publish(statisticsReducer(state, { type: "load-succeeded", requestId, range, total }));
      } catch (error: unknown) {
        if (closed || active !== controller) return;
        publish(statisticsReducer(
          state,
          isAbort(error, controller.signal)
            ? { type: "load-cancelled", requestId }
            : { type: "load-failed", requestId },
        ));
      } finally {
        if (active === controller) active = null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      active?.abort();
      active = null;
      publish(statisticsReducer(state, { type: "closed" }));
      listeners.clear();
    },
  };
}
