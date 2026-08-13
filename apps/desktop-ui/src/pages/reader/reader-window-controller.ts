import type { ReaderBookInfo, ReaderWindowPort } from "./reader-window-port.js";

export type ReaderWindowPhase = "loading" | "ready" | "failed" | "closed";

export interface ReaderWindowState {
  readonly phase: ReaderWindowPhase;
  readonly book: ReaderBookInfo | null;
  readonly notice: string | null;
}

export type ReaderWindowListener = (state: ReaderWindowState) => void;

export interface ReaderWindowController {
  getState(): ReaderWindowState;
  subscribe(listener: ReaderWindowListener): () => void;
  load(): Promise<void>;
  close(): Promise<void>;
  dispose(): void;
}

const LOADING: ReaderWindowState = Object.freeze({
  phase: "loading",
  book: null,
  notice: "正在打开图书…",
});

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

/**
 * Window lifecycle with stale-result suppression.  It intentionally knows
 * nothing about iframe DOM, page measurement or PDF.js: those stay in the
 * imperative engine adapter.
 */
export function createReaderWindowController(port: ReaderWindowPort): ReaderWindowController {
  let state: ReaderWindowState = LOADING;
  let activeLoad: AbortController | null = null;
  let activeClose: AbortController | null = null;
  let closed = false;
  const listeners = new Set<ReaderWindowListener>();

  const publish = (next: ReaderWindowState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const clearRequests = (): void => {
    activeLoad?.abort();
    activeClose?.abort();
    activeLoad = null;
    activeClose = null;
  };

  return {
    getState: (): ReaderWindowState => state,
    subscribe(listener: ReaderWindowListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(): Promise<void> {
      if (closed) return;
      activeLoad?.abort();
      const request = new AbortController();
      activeLoad = request;
      publish(LOADING);
      try {
        const book = await port.loadBook(request.signal);
        if (!closed && activeLoad === request) publish({ phase: "ready", book, notice: null });
      } catch (error: unknown) {
        if (!closed && activeLoad === request && !isAbort(error, request.signal)) {
          publish({ phase: "failed", book: null, notice: "无法打开这本图书，请返回书架后重试。" });
        }
      } finally {
        if (activeLoad === request) activeLoad = null;
      }
    },
    async close(): Promise<void> {
      if (closed || activeClose) return;
      activeLoad?.abort();
      const request = new AbortController();
      activeClose = request;
      try {
        await port.close(request.signal);
        if (!closed && activeClose === request) {
          closed = true;
          publish({ phase: "closed", book: null, notice: null });
          clearRequests();
          listeners.clear();
        }
      } catch (error: unknown) {
        if (!closed && activeClose === request && !isAbort(error, request.signal)) {
          publish({ ...state, notice: "关闭阅读窗口失败，请重试。" });
        }
      } finally {
        if (activeClose === request) activeClose = null;
      }
    },
    dispose(): void {
      if (closed) return;
      closed = true;
      clearRequests();
      publish({ phase: "closed", book: null, notice: null });
      listeners.clear();
    },
  };
}
