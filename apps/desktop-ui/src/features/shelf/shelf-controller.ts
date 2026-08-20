import type { ShelfBookId, ShelfPort, ShelfSnapshot } from "./shelf-port.js";
import {
  createShelfState,
  isAbortError,
  shelfReducer,
  type ShelfState,
} from "./shelf-state.js";
import type { ShelfFilters, ShelfSortKey } from "./shelf-rules.js";

export type ShelfListener = (state: ShelfState) => void;

export interface ShelfController {
  getState(): ShelfState;
  subscribe(listener: ShelfListener): () => void;
  load(): Promise<void>;
  setFilters(filters: ShelfFilters): void;
  setSort(sort: ShelfSortKey): void;
  setSelected(bookIds: ReadonlySet<ShelfBookId>): void;
  openBook(bookId: ShelfBookId): Promise<void>;
  close(): void;
}

const LOAD_FAILURE_NOTICE = "书架加载失败，请稍后重试。";
const OPEN_FAILURE_NOTICE = "无法打开此图书，请稍后重试。";

/**
 * Lifecycle boundary for the first shelf surface. The injected port retains
 * ownership of native commands and legacy data transformations; this module
 * only owns request cancellation, stale-result suppression and view state.
 */
export function createShelfController(port: ShelfPort): ShelfController {
  let state = createShelfState();
  let activeLoad: AbortController | null = null;
  let activeOpen: AbortController | null = null;
  let nextRequestId = 0;
  let closed = false;
  const listeners = new Set<ShelfListener>();

  const publish = (next: ShelfState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  return {
    getState: () => state,
    subscribe(listener: ShelfListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(): Promise<void> {
      if (closed) return;
      activeLoad?.abort();
      const request = new AbortController();
      activeLoad = request;
      const requestId = ++nextRequestId;
      publish(shelfReducer(state, { type: "load-started", requestId }));
      try {
        const snapshot: ShelfSnapshot = await port.load(request.signal);
        if (!closed && activeLoad === request) {
          publish(shelfReducer(state, { type: "load-succeeded", requestId, snapshot }));
        }
      } catch (error: unknown) {
        if (closed || activeLoad !== request) return;
        publish(shelfReducer(state, isAbortError(error, request.signal)
          ? { type: "load-cancelled", requestId }
          // Host diagnostics can contain a local path or native error details.
          // Keep the user-facing failure stable and safe instead.
          : { type: "load-failed", requestId, message: LOAD_FAILURE_NOTICE }));
      } finally {
        if (activeLoad === request) activeLoad = null;
      }
    },
    setFilters(filters: ShelfFilters): void {
      if (!closed) publish(shelfReducer(state, { type: "filters-changed", filters }));
    },
    setSort(sort: ShelfSortKey): void {
      if (!closed) publish(shelfReducer(state, { type: "sort-changed", sort }));
    },
    setSelected(bookIds: ReadonlySet<ShelfBookId>): void {
      if (!closed) publish(shelfReducer(state, { type: "selection-changed", selected: bookIds }));
    },
    async openBook(bookId: ShelfBookId): Promise<void> {
      if (closed) return;
      activeOpen?.abort();
      const request = new AbortController();
      activeOpen = request;
      try {
        await port.openBook(bookId, request.signal);
      } catch (error: unknown) {
        if (!closed && activeOpen === request && !isAbortError(error, request.signal)) {
          // Keep a state-level notice rather than propagating potentially
          // sensitive native diagnostics into a DOM surface.
          publish({ ...state, message: OPEN_FAILURE_NOTICE });
        }
      } finally {
        if (activeOpen === request) activeOpen = null;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeLoad?.abort();
      activeOpen?.abort();
      activeLoad = null;
      activeOpen = null;
      publish(shelfReducer(state, { type: "load-cancelled", requestId: state.requestId }));
      listeners.clear();
    },
  };
}
