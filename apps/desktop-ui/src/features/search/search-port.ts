/**
 * Injected capability boundary for the shelf search window.
 *
 * The host is the only layer that knows Tauri command and event names. Search
 * excerpts are rendered transiently by the feature but must never be logged or
 * persisted by a port implementation. Local file paths and full book content
 * deliberately have no representation here.
 */

export type SearchMode = "keyword" | "semantic";
export type SearchBookId = string;

export interface SearchScope {
  /** An empty list means the complete local shelf. */
  readonly bookIds: readonly SearchBookId[];
}

export interface SearchHit {
  readonly chapter: number;
  /** A short, host-bounded display excerpt. It is display-only, never history. */
  readonly snippet: string;
  readonly count?: number;
  readonly score?: number;
}

export interface SearchBookResult {
  readonly bookId: SearchBookId;
  readonly title: string;
  readonly author?: string;
  readonly count?: number;
  readonly score?: number;
  readonly hits: readonly SearchHit[];
}

export interface KeywordSearchResponse {
  readonly results: readonly SearchBookResult[];
  /** Books whose full-text index is being built in the background. */
  readonly pendingBooks: number;
}

/** Search history stores a query and bounded aggregate metadata only. */
export interface SearchHistoryEntry {
  readonly term: string;
  readonly count: number;
  readonly lastUsedAt: number;
}

export interface OpenSearchResultRequest {
  readonly bookId: SearchBookId;
  readonly chapter: number;
  readonly term: string;
}

/** Payload emitted when the existing Tauri window is focused/reused. */
export interface SearchWindowQuery {
  readonly term: string;
  readonly bookIds: readonly SearchBookId[];
}

export type Unlisten = () => void | Promise<void>;

export class SearchPortError extends Error {
  public constructor(public readonly kind: "offline" | "unavailable" | "invalid-query") {
    super(kind);
    this.name = "SearchPortError";
  }
}

export interface SearchPort {
  /** Full-text keyword search across the requested local shelf scope. */
  searchKeyword(term: string, scope: SearchScope, signal: AbortSignal): Promise<KeywordSearchResponse>;
  /** Local semantic search across the requested shelf scope. */
  searchSemantic(term: string, scope: SearchScope, signal: AbortSignal): Promise<readonly SearchBookResult[]>;
  /** Fetch the next bounded page of keyword excerpts for an expanded book. */
  loadMoreKeywordHits(request: { readonly bookId: SearchBookId; readonly term: string; readonly offset: number; readonly limit: number }, signal: AbortSignal): Promise<readonly SearchHit[]>;
  /** Opens the existing reader at a result; no path or book body crosses this boundary. */
  openResult(request: OpenSearchResultRequest, signal: AbortSignal): Promise<void>;

  loadHistory(signal: AbortSignal): Promise<readonly SearchHistoryEntry[]>;
  saveHistory(entry: SearchHistoryEntry, signal: AbortSignal): Promise<readonly SearchHistoryEntry[]>;
  removeHistory(term: string, signal: AbortSignal): Promise<readonly SearchHistoryEntry[]>;

  /**
   * The adapter owns `listen("shelf-search-query", ...)`. It must return the
   * unlisten function supplied by Tauri; the component invokes it on close.
   */
  listenForWindowQuery(onQuery: (query: SearchWindowQuery) => void): Promise<Unlisten>;
  /** Releases any host-owned window state before the feature is unmounted. */
  closeWindow(signal: AbortSignal): Promise<void>;
}
