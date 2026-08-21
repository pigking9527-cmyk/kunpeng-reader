import type { NewsFeedSnapshot, NewsItem, NewsPort, NewsPreferences, NewsSource } from "./news-port.js";
import { parseNewsArticleOpenResult } from "./news-article-result.js";
import { normalisePreferences, sourceRequest } from "./news-rules.js";
import { createNewsState, isAbortError, isOfflineError, newsReducer, type NewsState } from "./news-state.js";

export type NewsListener = (state: NewsState) => void;

export interface NewsController {
  getState(): NewsState;
  subscribe(listener: NewsListener): () => void;
  load(): Promise<void>;
  refresh(): Promise<void>;
  openArticle(item: NewsItem): Promise<void>;
  closeArticle(): void;
  openOriginal(url: string): Promise<void>;
  close(): void;
}

const LOAD_FAILURE_NOTICE = "资讯加载失败，请检查网络后重试。";
const ARTICLE_FAILURE_NOTICE = "资讯正文加载失败，请稍后重试。";

/**
 * Owns every cancellable request made by the isolated news surface.
 *
 * The composition root injects a host adapter.  This controller deliberately
 * knows neither Tauri command names nor browser globals, so closing the UI
 * root always aborts in-flight work and late completions cannot update it.
 */
export function createNewsController(port: NewsPort): NewsController {
  let state = createNewsState();
  let activeLoad: AbortController | null = null;
  let activeArticle: AbortController | null = null;
  let activeOriginal: AbortController | null = null;
  let nextRequestId = 0;
  let closed = false;
  const listeners = new Set<NewsListener>();

  const publish = (next: NewsState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const applyFeed = (
    requestId: number,
    catalog: readonly NewsSource[],
    preferences: NewsPreferences,
    feed: NewsFeedSnapshot,
  ): void => {
    publish(newsReducer(state, feed.items.length === 0
      ? { type: "load-empty", requestId, catalog, preferences, feed }
      : { type: "load-succeeded", requestId, catalog, preferences, feed }));
  };

  const start = async (refresh: boolean): Promise<void> => {
    if (closed) return;
    activeLoad?.abort();
    const controller = new AbortController();
    activeLoad = controller;
    const requestId = ++nextRequestId;
    publish(newsReducer(state, { type: "load-started", requestId }));

    try {
      const catalog = state.catalog.length > 0 ? state.catalog : await port.loadCatalog(controller.signal);
      const loadedPreferences = state.preferences ?? await port.loadPreferences(controller.signal);
      const preferences = normalisePreferences(loadedPreferences, catalog);
      const feed = refresh
        ? await port.refresh(sourceRequest(preferences), controller.signal)
        : await port.list(sourceRequest(preferences), controller.signal);
      if (closed || activeLoad !== controller) return;
      applyFeed(requestId, catalog, preferences, feed);
    } catch (error: unknown) {
      if (closed || activeLoad !== controller) return;
      if (isAbortError(error, controller.signal)) {
        publish(newsReducer(state, { type: "load-cancelled", requestId }));
      } else {
        publish(newsReducer(state, {
          type: "load-failed",
          requestId,
          offline: isOfflineError(error),
          message: isOfflineError(error) ? "当前离线，正在保留可用资讯。" : LOAD_FAILURE_NOTICE,
        }));
      }
    } finally {
      if (activeLoad === controller) activeLoad = null;
    }
  };

  return {
    getState: () => state,
    subscribe(listener: NewsListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: () => start(false),
    refresh: () => start(true),
    async openArticle(item: NewsItem): Promise<void> {
      if (closed) return;
      // Only a feed member may cross this boundary.  The host receives its
      // opaque ID, never a caller-supplied URL, title, or extracted document.
      if (!state.feed?.items.some((candidate) => candidate.id === item.id)) return;
      activeArticle?.abort();
      const controller = new AbortController();
      activeArticle = controller;
      try {
        const response = await port.openArticle({ itemId: item.id }, controller.signal);
        if (closed || activeArticle !== controller) return;
        const result = parseNewsArticleOpenResult(response, item.id);
        if (!result) {
          publish(newsReducer(state, { type: "message", message: ARTICLE_FAILURE_NOTICE }));
        } else if (result.kind === "text") {
          publish(newsReducer(state, { type: "article-opened", article: result.article }));
        } else {
          // The legacy host owns native child-WebView close/return lifecycle.
          // Do not manufacture one inside this iframe before a dedicated port
          // contract exists.
          publish(newsReducer(state, { type: "native-article-opened" }));
        }
      } catch (error: unknown) {
        if (!closed && activeArticle === controller && !isAbortError(error, controller.signal)) {
          publish(newsReducer(state, { type: "message", message: ARTICLE_FAILURE_NOTICE }));
        }
      } finally {
        if (activeArticle === controller) activeArticle = null;
      }
    },
    closeArticle(): void {
      activeArticle?.abort();
      activeArticle = null;
      if (!closed) publish(newsReducer(state, { type: "article-closed" }));
    },
    async openOriginal(url: string): Promise<void> {
      if (closed) return;
      activeOriginal?.abort();
      const controller = new AbortController();
      activeOriginal = controller;
      try {
        await port.openOriginal(url, controller.signal);
      } catch (error: unknown) {
        if (!closed && activeOriginal === controller && !isAbortError(error, controller.signal)) {
          publish(newsReducer(state, { type: "message", message: "无法打开原始链接，请稍后重试。" }));
        }
      } finally {
        if (activeOriginal === controller) activeOriginal = null;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeLoad?.abort();
      activeArticle?.abort();
      activeOriginal?.abort();
      activeLoad = null;
      activeArticle = null;
      activeOriginal = null;
      publish(newsReducer(state, { type: "load-cancelled", requestId: state.requestId }));
      listeners.clear();
    },
  };
}
