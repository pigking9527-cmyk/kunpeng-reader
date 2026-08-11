/**
 * Capability boundary for news integration.
 *
 * The host owns Tauri commands, persisted preferences and any network work.
 * This module intentionally carries only display-safe data, never raw HTML,
 * credentials, local-storage keys, native command names or server details.
 */

export type NewsLayout = "list" | "grid";
export type NewsOrder = "mixed" | "source";
export type NewsPhase = "loading" | "ready" | "empty" | "error" | "offline" | "cancelled";
export type NewsGestureAction = "back" | "book-info" | "reopen-last" | "restore-jump";
export type NewsGestureScope = "main" | "reader" | "auto";
export type GesturePrecisionMode = "global" | "independent";

export interface NewsSource {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly defaultEnabled: boolean;
  /** The host supplies this only after applying its own HTTPS validation. */
  readonly homepageUrl?: string;
}

export interface NewsPreferences {
  readonly sourceIds: readonly string[];
  readonly tiebaBars: readonly string[];
  readonly enabledTiebaBars: readonly string[];
  readonly layout: NewsLayout;
  readonly order: NewsOrder;
}

export interface NewsRequest {
  readonly sourceIds: readonly string[];
  readonly tiebaBars: readonly string[];
  readonly enabledTiebaBars: readonly string[];
}

export interface NewsItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly category: string;
  readonly publishedAt?: string;
  /** An optional HTTPS URL; the feature validates again before presenting it. */
  readonly originalUrl?: string;
  /** A host-provided, already sanitised thumbnail data URL. */
  readonly previewImageDataUrl?: string;
}

/** Deliberately text-only: the application never mounts remote/extracted HTML directly. */
export interface NewsArticleDocument {
  readonly itemId: string;
  readonly title: string;
  readonly sourceName: string;
  readonly publishedAt?: string;
  readonly paragraphs: readonly string[];
  readonly originalUrl?: string;
}

export interface NewsFeedSnapshot {
  readonly items: readonly NewsItem[];
  readonly fetchedAt: string;
  /** Cached data may be displayed while the host refreshes in the background. */
  readonly stale: boolean;
}

export interface NewsGesturePoint {
  readonly x: number;
  readonly y: number;
}

export interface NewsGestureProfile {
  readonly id: string;
  readonly name: string;
  readonly action: NewsGestureAction;
  readonly scope: NewsGestureScope;
  readonly enabled: boolean;
  /** Exactly 48 centred, normalised points when a path has been recorded. */
  readonly points: readonly NewsGesturePoint[];
  readonly precisionMode: GesturePrecisionMode;
  /** Inclusive 1–10 scale. */
  readonly precision: number;
}

export interface NewsGestureSettings {
  readonly enabled: boolean;
  readonly globalPrecision: number;
  readonly profiles: readonly NewsGestureProfile[];
  /** True makes an empty profile list an explicit user deletion. */
  readonly profilesInitialized: boolean;
}

export interface NewsPort {
  loadCatalog(signal: AbortSignal): Promise<readonly NewsSource[]>;
  loadPreferences(signal: AbortSignal): Promise<NewsPreferences>;
  savePreferences(preferences: NewsPreferences, signal: AbortSignal): Promise<NewsPreferences>;
  list(request: NewsRequest, signal: AbortSignal): Promise<NewsFeedSnapshot>;
  refresh(request: NewsRequest, signal: AbortSignal): Promise<NewsFeedSnapshot>;
  /** Fetches a text-only, sanitised local reading view through the host. */
  openArticle(item: NewsItem, signal: AbortSignal): Promise<NewsArticleDocument>;
  /** The host must reject non-HTTPS URLs as a second security boundary. */
  openOriginal(url: string, signal: AbortSignal): Promise<void>;
  loadGestureSettings(signal: AbortSignal): Promise<NewsGestureSettings>;
  saveGestureSettings(settings: NewsGestureSettings, signal: AbortSignal): Promise<NewsGestureSettings>;
}
