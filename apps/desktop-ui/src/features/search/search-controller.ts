import type {
  OpenSearchResultRequest,
  SearchPort,
  SearchMode,
  SearchScope,
  SearchWindowQuery,
  Unlisten,
} from "./search-port.js";
import {
  createSearchState,
  isAbortError,
  isOfflineError,
  nextHistoryEntry,
  searchReducer,
  type SearchState,
} from "./search-state.js";

export type SearchListener = (state: SearchState) => void;

export interface SearchController {
  getState(): SearchState;
  subscribe(listener: SearchListener): () => void;
  activate(): Promise<void>;
  setTerm(term: string): void;
  setMode(mode: SearchMode): void;
  search(term?: string, scope?: SearchScope): Promise<void>;
  useHistory(term: string): Promise<void>;
  removeHistory(term: string): Promise<void>;
  toggleBook(bookId: string): void;
  loadMore(bookId: string): Promise<void>;
  openResult(request: OpenSearchResultRequest): Promise<void>;
  close(): void;
}

const OPEN_FAILURE_NOTICE = "无法打开此结果，请稍后重试。";
const MAX_TERM_LENGTH = 160;

function normaliseTerm(term: string): string {
  return term.trim().slice(0, MAX_TERM_LENGTH);
}

/**
 * Lifecycle owner for the search surface. It deliberately has no
 * Tauri/browser imports: the injected port owns native commands and the one
 * window event subscription, while this layer owns abort, stale-result and
 * unlisten behaviour.
 */
export function createSearchController(port: SearchPort, now: () => number = Date.now): SearchController {
  let state = createSearchState();
  let activeSearch: AbortController | null = null;
  let activeMore: AbortController | null = null;
  let activeOpen: AbortController | null = null;
  let activeHistory: AbortController | null = null;
  let windowUnlisten: Unlisten | null = null;
  let listening = false;
  let closed = false;
  let nextRequestId = 0;
  const listeners = new Set<SearchListener>();

  const publish = (next: SearchState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const isActive = (controller: AbortController, requestId: number): boolean => !closed
    && activeSearch === controller
    && state.requestId === requestId;

  const persistHistory = async (term: string, controller: AbortController, requestId: number): Promise<void> => {
    const entry = nextHistoryEntry(term, state.history, now());
    if (!entry || !isActive(controller, requestId)) return;
    try {
      const history = await port.saveHistory(entry, controller.signal);
      if (isActive(controller, requestId)) publish(searchReducer(state, { type: "history-updated", history }));
    } catch {
      // Search content must remain transient.  A history-storage failure is
      // non-fatal and intentionally never exposes host diagnostics.
    }
  };

  const onWindowQuery = (query: SearchWindowQuery): void => {
    if (closed) return;
    const term = normaliseTerm(query.term);
    const scope = query.bookIds.length === 0 ? { bookIds: [] } : { bookIds: [...query.bookIds] };
    publish(searchReducer(state, { type: "window-query", term, scope }));
    if (term) void controller.search(term, scope);
  };

  const controller: SearchController = {
    getState: () => state,
    subscribe(listener: SearchListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async activate(): Promise<void> {
      if (closed) return;
      if (!listening) {
        listening = true;
        try {
          const unlisten = await port.listenForWindowQuery(onWindowQuery);
          if (closed) {
            await unlisten();
          } else {
            windowUnlisten = unlisten;
          }
        } catch {
          // Existing search still works through its controls when window-event
          // wiring is unavailable; no internal/native message is rendered.
        }
      }
      const request = new AbortController();
      activeHistory?.abort();
      activeHistory = request;
      try {
        const history = await port.loadHistory(request.signal);
        if (!closed && activeHistory === request) publish(searchReducer(state, { type: "history-loaded", history }));
      } catch {
        // History is convenience data only.  Do not turn a usable search page
        // into an error screen if its stored query metadata is unavailable.
      } finally {
        if (activeHistory === request) activeHistory = null;
      }
    },
    setTerm(term: string): void {
      if (!closed) publish(searchReducer(state, { type: "term-changed", term: term.slice(0, MAX_TERM_LENGTH) }));
    },
    setMode(mode: SearchMode): void {
      if (!closed) publish(searchReducer(state, { type: "mode-changed", mode }));
    },
    async search(term = state.term, scope = state.scope): Promise<void> {
      const cleaned = normaliseTerm(term);
      if (closed || !cleaned) return;
      activeSearch?.abort();
      activeMore?.abort();
      const request = new AbortController();
      activeSearch = request;
      activeMore = null;
      const requestId = ++nextRequestId;
      publish(searchReducer(state, { type: "search-started", requestId, term: cleaned }));
      try {
        if (state.mode === "keyword") {
          const response = await port.searchKeyword(cleaned, scope, request.signal);
          if (isActive(request, requestId)) publish(searchReducer(state, { type: "keyword-succeeded", requestId, response }));
        } else {
          const results = await port.searchSemantic(cleaned, scope, request.signal);
          if (isActive(request, requestId)) publish(searchReducer(state, { type: "semantic-succeeded", requestId, results }));
        }
        await persistHistory(cleaned, request, requestId);
      } catch (error: unknown) {
        if (!isActive(request, requestId)) return;
        publish(searchReducer(state, isAbortError(error, request.signal)
          ? { type: "search-cancelled", requestId }
          : { type: "search-failed", requestId, offline: isOfflineError(error) }));
      } finally {
        if (activeSearch === request) activeSearch = null;
      }
    },
    async useHistory(term: string): Promise<void> {
      if (closed) return;
      publish(searchReducer(state, { type: "term-changed", term }));
      await controller.search(term);
    },
    async removeHistory(term: string): Promise<void> {
      if (closed) return;
      const request = new AbortController();
      activeHistory?.abort();
      activeHistory = request;
      try {
        const history = await port.removeHistory(term, request.signal);
        if (!closed && activeHistory === request) publish(searchReducer(state, { type: "history-updated", history }));
      } catch {
        // Keep the previously displayed metadata on a storage failure.
      } finally {
        if (activeHistory === request) activeHistory = null;
      }
    },
    toggleBook(bookId: string): void {
      if (!closed) publish(searchReducer(state, { type: "book-toggled", bookId }));
    },
    async loadMore(bookId: string): Promise<void> {
      if (closed || state.mode !== "keyword" || state.phase !== "ready") return;
      const result = state.results.find((item) => item.bookId === bookId);
      if (!result) return;
      activeMore?.abort();
      const request = new AbortController();
      activeMore = request;
      const requestId = state.requestId;
      try {
        const hits = await port.loadMoreKeywordHits({ bookId, term: state.term, offset: result.hits.length, limit: 20 }, request.signal);
        if (!closed && activeMore === request) publish(searchReducer(state, { type: "more-hits-loaded", requestId, bookId, hits }));
      } catch {
        // Existing excerpt results stay visible if an additional page fails.
      } finally {
        if (activeMore === request) activeMore = null;
      }
    },
    async openResult(request: OpenSearchResultRequest): Promise<void> {
      if (closed) return;
      activeOpen?.abort();
      const operation = new AbortController();
      activeOpen = operation;
      try {
        await port.openResult(request, operation.signal);
      } catch (error: unknown) {
        if (!closed && activeOpen === operation && !isAbortError(error, operation.signal)) {
          publish({ ...state, message: OPEN_FAILURE_NOTICE });
        }
      } finally {
        if (activeOpen === operation) activeOpen = null;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeSearch?.abort();
      activeMore?.abort();
      activeOpen?.abort();
      activeHistory?.abort();
      activeSearch = null;
      activeMore = null;
      activeOpen = null;
      activeHistory = null;
      const unlisten = windowUnlisten;
      windowUnlisten = null;
      if (unlisten) void Promise.resolve(unlisten()).catch(() => undefined);
      const cleanup = new AbortController();
      void port.closeWindow(cleanup.signal).catch(() => undefined);
      publish(searchReducer(state, { type: "closed" }));
      listeners.clear();
    },
  };
  return controller;
}
