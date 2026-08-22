import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import type { NewsGestureApi } from "../main-rules/news-gesture.js";
import type { NewsLayoutRulesApi } from "../main-business/news-layout-rules.js";
import {
  allowedNewsSourceIds,
  defaultNewsSourceIds,
  enabledNewsTiebaBars,
  hasPendingNewsPreviews,
  newsPreviewAttempted,
  newsResultItems,
  newsText,
  normalizeNewsTiebaBars,
  safeNewsHttpUrl,
  safeNewsImageDataUrl,
  type NewsRulesApi,
} from "../main-rules/news-rules.js";

type NewsRecord = Record<string, unknown>;
type NewsItem = NewsRecord;
type NewsCatalogSource = NewsRecord;
type NewsResult = NewsRecord;
type NewsLayout = "list" | "grid";
type NewsOrder = "mixed" | "source";

interface NewsSourceSettings extends NewsRecord {
  readonly hasNewsSourceSettings?: unknown;
  readonly newsSourceIds?: unknown;
  readonly newsTiebaBars?: unknown;
  readonly newsEnabledTiebaBars?: unknown;
}

interface NewsArticle extends NewsRecord {
  readonly local?: unknown;
  readonly source?: unknown;
  readonly publishedAt?: unknown;
  readonly published_at?: unknown;
  readonly title?: unknown;
  readonly contentHtml?: unknown;
  readonly content_html?: unknown;
}

/** Escaped HTML assembled from an already prepared local intelligence brief. */
export interface PreparedNewsArticle {
  readonly title: string;
  readonly source: string;
  readonly publishedAt?: string;
  readonly contentHtml: string;
}

interface CustomNewsSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly category: string;
}

type NewsCommands = {
  readonly app_settings_sync_get: { readonly result: NewsSourceSettings };
  readonly app_settings_sync_save: {
    readonly args: { readonly request: NewsRecord };
    readonly result: unknown;
  };
  readonly newsnow_sources: { readonly result: unknown };
  readonly newsnow_custom_sources_get: { readonly result: readonly CustomNewsSource[] };
  readonly newsnow_custom_sources_save: {
    readonly args: { readonly request: { readonly sources: readonly CustomNewsSource[] } };
    readonly result: readonly CustomNewsSource[];
  };
  readonly newsnow_list: {
    readonly args: { readonly request: NewsRecord };
    readonly result: NewsResult;
  };
  readonly newsnow_refresh: {
    readonly args: { readonly request: NewsRecord };
    readonly result: NewsResult;
  };
  readonly newsnow_prefetch: {
    readonly args: { readonly request: NewsRecord };
    readonly result: NewsResult;
  };
  readonly newsnow_prepare_article_shell: { readonly result: unknown };
  readonly newsnow_open_article: {
    readonly args: { readonly request: NewsRecord };
    readonly result: NewsArticle;
  };
  readonly newsnow_close_article: { readonly result: unknown };
  readonly newsnow_preview_image: {
    readonly args: { readonly request: NewsRecord };
    readonly result: NewsRecord;
  };
  readonly open_url: {
    readonly args: { readonly url: string };
    readonly result: unknown;
  };
};
type VerifiedNewsCommands = NewsCommands extends TauriCommandMap ? NewsCommands : never;

interface NewsRuntime extends Window {
  readonly ReaderNewsRules?: NewsRulesApi;
  readonly ReaderNewsLayoutRules?: NewsLayoutRulesApi;
  readonly ReaderNewsGesture?: NewsGestureApi;
  readonly ReaderAppI18n?: {
    readonly t?: (key: string) => string;
    readonly resolvedLanguage?: () => string | undefined;
  };
  readonly ReaderExperimentalFeatures?: {
    readonly enabled?: (key: string) => boolean;
    readonly instance?: { readonly openSettings?: () => void };
  };
  readonly ReaderLibraryAiEntry?: { readonly close?: () => void };
  readonly ReaderProblemTraceUI?: {
    readonly recordNewsArticleTiming?: (
      stage: unknown,
      outcome: unknown,
      durationMs: unknown,
      sequence: unknown,
    ) => void;
  };
  readonly ReaderIntelligenceWorkspace?: {
    readonly instance?: {
      readonly close?: (options?: { readonly focus?: boolean }) => void;
      readonly open?: () => Promise<void> | void;
    };
  };
  ReaderNewsUI?: NewsUiGlobal;
}

export interface NewsUiController {
  readonly open: () => Promise<void>;
  /** Opens one existing news item in the same sanitized reader used by the news page. */
  readonly openItem: (item: NewsItem, options?: { readonly returnToIntelligence?: boolean }) => Promise<void>;
  /** Opens an already prepared local intelligence article without WebView navigation. */
  readonly openPreparedArticle: (article: PreparedNewsArticle, options?: { readonly returnToIntelligence?: boolean }) => void;
  /** Opens the single reader-owned source selector rather than duplicating it elsewhere. */
  readonly openSources: () => Promise<void>;
  /** Returns a copy of the effective source selection for another reader surface. */
  readonly sourceRequest: () => Promise<NewsRecord>;
  readonly close: (options?: { readonly focus?: boolean }) => void;
  readonly gestureSurface: () => HTMLElement | null;
  readonly gestureBack: () => void;
  readonly gestureReopen: () => () => void;
  readonly refresh: () => Promise<void>;
  readonly render: (items: unknown) => void;
  readonly sources: () => NewsCatalogSource[];
  readonly layout: () => NewsLayout;
  readonly order: () => NewsOrder;
}

export interface NewsUiGlobal {
  readonly init: (options?: NewsUiOptions) => NewsUiController | null;
  readonly resultItems: (result: unknown) => unknown[];
  readonly safeHttpUrl: (value: unknown) => string;
  readonly withTimeout: <TResult>(promise: PromiseLike<TResult> | TResult, timeoutMs?: number) => Promise<TResult>;
  readonly allowedSourceIds: (ids: unknown, catalog: unknown) => string[];
  instance?: NewsUiController | null;
}

export interface NewsUiOptions {
  readonly root?: Document;
  readonly transport?: TauriTransport;
}

interface VisibleImageJob {
  readonly item: NewsItem;
  readonly image: HTMLImageElement;
  readonly card: HTMLElement;
  readonly url: string;
}

interface PreviewImageElement extends HTMLImageElement {
  __newsPreviewJob?: VisibleImageJob | null;
}

function record(value: unknown): NewsRecord | null {
  return typeof value === "object" && value !== null
    ? (value as NewsRecord)
    : null;
}

function runtimeFrom(value: unknown): NewsRuntime | null {
  const runtime = record(value);
  return runtime && runtime.document instanceof Document
    ? (runtime as unknown as NewsRuntime)
    : null;
}

function requiredElement<TElement extends HTMLElement>(
  root: Document,
  id: string,
): TElement | null {
  return root.getElementById(id) as TElement | null;
}

/* A browser-rendered, reader-owned news page. The Rust side fetches the feed;
   a selected source article opens in a main-window child WebView. */
export function installNewsUi(
  target: unknown,
  injectedTransport?: TauriTransport,
): NewsUiGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const host: NewsRuntime = runtime;
  let transport = injectedTransport;
  if (!transport) {
    try {
      transport = transportFromTauriGlobal(target);
    } catch {
      transport = undefined;
    }
  }

  const LOAD_TIMEOUT_MS = 18000;
  const SOURCE_STORAGE_KEY = "kunpeng.reader.news.sources.v2";
  const CUSTOM_SOURCES_STORAGE_KEY = "kunpeng.reader.news.custom-sources.v1";
  const TIEBA_BARS_STORAGE_KEY = "kunpeng.reader.news.tieba-bars.v1";
  const TIEBA_ENABLED_BARS_STORAGE_KEY = "kunpeng.reader.news.tieba-enabled-bars.v1";
  const LAYOUT_STORAGE_KEY = "kunpeng.reader.news.layout.v1";
  const ORDER_STORAGE_KEY = "kunpeng.reader.news.order.v1";
  const MAX_CUSTOM_SOURCES = 200;
  const MAX_CUSTOM_SOURCE_NAME_LENGTH = 80;
  const MAX_CUSTOM_SOURCE_CATEGORY_LENGTH = 48;
  const MAX_CUSTOM_SOURCE_URL_LENGTH = 2_048;
  const MAX_TIEBA_BARS = 8;
  const ALL_CATEGORY = "__all__";
  const BACKGROUND_PREFETCH_DELAY_MS = 30 * 1000;
  const BACKGROUND_PREFETCH_INTERVAL_MS = 5 * 60 * 1000;
  const BACKGROUND_PREFETCH_BATCHES = 4;
  const VISIBLE_IMAGE_CONCURRENCY = 4;

  // Pure news rules are bundled into this original page script.  The classic
  // global remains an optional compatibility hook, never a second UI asset.
  const newsRules = host.ReaderNewsRules;
  const newsLayoutRules = host.ReaderNewsLayoutRules;
  const text = newsText;
  const i18n = (key: string, fallback: string): string => host.ReaderAppI18n?.t?.(key) || fallback;
  const format = (key: string, fallback: string, values?: NewsRecord): string => i18n(key, fallback).replace(/\{(\w+)\}/g, (_, name: string) => text(values?.[name] ?? ""));
  function safeHttpUrl(value: unknown): string {
    if (typeof newsRules?.safeHttpUrl === "function") return newsRules.safeHttpUrl(value);
    return safeNewsHttpUrl(value);
  }
  function safeImageDataUrl(value: unknown): string {
    if (typeof newsRules?.safeImageDataUrl === "function") return newsRules.safeImageDataUrl(value);
    return safeNewsImageDataUrl(value);
  }
  function resultItems(result: unknown): unknown[] {
    if (typeof newsRules?.resultItems === "function") return newsRules.resultItems(result);
    return newsResultItems(result);
  }
  function previewAttempted(item: unknown): boolean {
    if (typeof newsRules?.previewAttempted === "function") return newsRules.previewAttempted(item);
    return newsPreviewAttempted(item);
  }
  function hasPendingPreviews(result: unknown): boolean {
    if (typeof newsRules?.hasPendingPreviews === "function") return newsRules.hasPendingPreviews(result);
    return hasPendingNewsPreviews(result);
  }
  function withTimeout<TResult>(promise: PromiseLike<TResult> | TResult, timeoutMs = LOAD_TIMEOUT_MS): Promise<TResult> {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = host.setTimeout(() => reject(new Error("news-request-timeout")), timeoutMs); });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => host.clearTimeout(timer));
  }
  function itemDate(item: unknown): string {
    const entry = record(item);
    const value = entry?.published_at || entry?.publishedAt || entry?.published || entry?.time || entry?.created_at || entry?.createdAt;
    if (!value) return "";
    const dateValue = typeof value === "string" || typeof value === "number" || value instanceof Date ? value : text(value);
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat(host.ReaderAppI18n?.resolvedLanguage?.() || "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const sourceCategory = (source: unknown): string => text(record(source)?.category).trim() || i18n("newsCategoryOther", "其他");
  const sourceProvider = (source: unknown): string => {
    const provider = text(record(source)?.provider).trim().toLocaleLowerCase();
    return provider || "reader";
  };
  const sourceKind = (source: unknown): string => text(record(source)?.kind).trim() || "news";
  const sourceProviderLabel = (provider: string): string => {
    switch (provider) {
      case "horizon": return "Horizon";
      case "worldmonitor": return "WorldMonitor";
      case "reader": return "阅读器资讯";
      case "custom": return "自定义来源";
      default: return provider;
    }
  };
  const sourceTypeLabel = (source: unknown): string => {
    if (sourceProvider(source) === "reader") return sourceCategory(source);
    switch (sourceKind(source)) {
      case "advisory": return "安全公告";
      case "earthquake": return "地震";
      case "natural_event": return "自然事件";
      case "disaster_alert": return "灾害预警";
      case "rss": return "RSS / Atom";
      case "news": return "资讯";
      default: return sourceKind(source);
    }
  };
  const sourceDescription = (source: unknown): string => {
    const item = record(source);
    const name = text(item?.name).trim() || "此来源";
    const provider = sourceProvider(source);
    const kind = sourceTypeLabel(source);
    const category = sourceCategory(source);
    const overview = provider === "horizon"
      ? "来自 Horizon 的公开订阅，用于资讯筛选、去重和排序。"
      : provider === "worldmonitor"
        ? "来自 WorldMonitor 的公开订阅，用于保留事件、地区和时间线索。"
        : provider === "custom"
          ? "这是你添加的自定义订阅；是否跨设备保存由账户页的“自定义 RSS / Atom 订阅”开关决定。"
          : "这是阅读器内置的公共资讯来源。";
    return `${name}：${overview}主要覆盖${category}分类，内容形式为${kind}。`;
  };
  const sourceId = (item: unknown): string => text(record(item)?.sourceId || record(item)?.source_id || record(item)?.source || i18n("news", "资讯"));
  const sourceName = (item: unknown): string => text(record(item)?.source || record(item)?.source_name || record(item)?.site || i18n("news", "资讯")).trim();
  const defaultSourceIds = (catalog: NewsCatalogSource[]): string[] => {
    if (typeof newsRules?.defaultSourceIds === "function") return newsRules.defaultSourceIds(catalog);
    return defaultNewsSourceIds(catalog);
  };
  function allowedSourceIds(ids: unknown, catalog: unknown): string[] {
    if (typeof newsRules?.allowedSourceIds === "function") return newsRules.allowedSourceIds(ids, catalog);
    return allowedNewsSourceIds(ids, catalog);
  }
  function readJson(key: string): unknown { try { return JSON.parse(host.localStorage.getItem(key) ?? "null"); } catch { return null; } }
  function customSourceText(value: unknown, maximumLength: number): string {
    return text(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximumLength);
  }
  function normalizedCustomSourceUrl(value: unknown): string {
    const raw = customSourceText(value, MAX_CUSTOM_SOURCE_URL_LENGTH);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return "";
      return parsed.toString();
    } catch {
      return "";
    }
  }
  function stableCustomSourceId(url: string): string {
    const hash = (input: string, seed: number): string => {
      let value = seed;
      for (let index = 0; index < input.length; index += 1) value = Math.imul(value ^ input.charCodeAt(index), 16_777_619);
      return (value >>> 0).toString(36);
    };
    return `custom-rss-${hash(url, 2_166_136_261)}${hash(`\u0000${url}`, 2_167_136_261)}`;
  }
  function normalizeCustomSources(values: unknown): CustomNewsSource[] {
    if (!Array.isArray(values)) return [];
    const seenUrls = new Set<string>();
    const result: CustomNewsSource[] = [];
    for (const value of values) {
      if (result.length >= MAX_CUSTOM_SOURCES) break;
      const item = record(value);
      const name = customSourceText(item?.name, MAX_CUSTOM_SOURCE_NAME_LENGTH);
      const url = normalizedCustomSourceUrl(item?.url);
      const category = customSourceText(item?.category, MAX_CUSTOM_SOURCE_CATEGORY_LENGTH);
      if (!name || !url || !category || seenUrls.has(url)) continue;
      seenUrls.add(url);
      result.push({ id: stableCustomSourceId(url), name, url, category });
    }
    return result;
  }
  function customSourceCatalogEntry(source: CustomNewsSource): NewsCatalogSource {
    return { ...source, color: "#557cae", provider: "custom", kind: "rss" };
  }
  function loadStoredCustomSources(): CustomNewsSource[] { return normalizeCustomSources(readJson(CUSTOM_SOURCES_STORAGE_KEY)); }
  function saveCustomSources(sources: CustomNewsSource[]): void {
    storageSet(CUSTOM_SOURCES_STORAGE_KEY, JSON.stringify(sources));
    if (!api) return;
    void invoke<unknown>("newsnow_custom_sources_save", { request: { sources } }).catch(() => {
      // The local copy remains usable offline. A later successful save will
      // update the optional cross-device entity when its account switch is on.
    });
  }
  function loadStoredSourceIds(catalog: NewsCatalogSource[]): string[] {
    const selected = allowedSourceIds(readJson(SOURCE_STORAGE_KEY), catalog);
    return selected.length ? selected : defaultSourceIds(catalog);
  }
  function normalizeTiebaBars(values: unknown): string[] {
    if (typeof newsRules?.normalizeTiebaBars === "function") return newsRules.normalizeTiebaBars(values, MAX_TIEBA_BARS);
    return normalizeNewsTiebaBars(values, MAX_TIEBA_BARS);
  }
  function loadStoredTiebaBars(): string[] { return normalizeTiebaBars(readJson(TIEBA_BARS_STORAGE_KEY)); }
  function enabledTiebaBars(values: unknown, bars: unknown): string[] {
    if (typeof newsRules?.enabledTiebaBars === "function") return newsRules.enabledTiebaBars(values, bars, MAX_TIEBA_BARS);
    return enabledNewsTiebaBars(values, bars, MAX_TIEBA_BARS);
  }
  function loadStoredEnabledTiebaBars(bars: string[]): string[] { const saved = readJson(TIEBA_ENABLED_BARS_STORAGE_KEY); return Array.isArray(saved) ? enabledTiebaBars(saved, bars) : bars.slice(); }
  function storageGet(key: string, fallback: string): string { try { return host.localStorage.getItem(key) || fallback; } catch { return fallback; } }
  function storageSet(key: string, value: string): void { try { host.localStorage.setItem(key, value); } catch { /* preferences are optional */ } }

  const api = transport ? createTauriApi<VerifiedNewsCommands>(transport) : null;
  function invoke<TResult>(
    command: keyof VerifiedNewsCommands,
    args?: NewsRecord,
  ): Promise<TResult> {
    if (!api) return Promise.reject(new Error("Tauri transport is unavailable."));
    return transport!.invoke<TResult>(String(command), args);
  }

  function init({ root = host.document }: NewsUiOptions = {}): NewsUiController | null {
    const canInvoke = api !== null;
    const button = requiredElement<HTMLButtonElement>(root, "newsnow-toolbar-btn")!;
    const page = requiredElement<HTMLElement>(root, "newsnow-page")!;
    const back = requiredElement<HTMLButtonElement>(root, "newsnow-back")!;
    const refresh = requiredElement<HTMLButtonElement>(root, "newsnow-refresh")!;
    const gestureSettings = requiredElement<HTMLButtonElement>(root, "newsnow-gesture-settings")!;
    const sourceToggle = requiredElement<HTMLButtonElement>(root, "newsnow-source-toggle")!;
    const sourcePicker = requiredElement<HTMLElement>(root, "newsnow-source-picker")!;
    const sourceSearch = requiredElement<HTMLInputElement>(root, "newsnow-source-search")!;
    const customSourceForm = requiredElement<HTMLFormElement>(root, "newsnow-custom-source-form")!;
    const customSourceName = requiredElement<HTMLInputElement>(root, "newsnow-custom-source-name")!;
    const customSourceUrl = requiredElement<HTMLInputElement>(root, "newsnow-custom-source-url")!;
    const customSourceCategory = requiredElement<HTMLInputElement>(root, "newsnow-custom-source-category")!;
    const customSourceList = requiredElement<HTMLElement>(root, "newsnow-custom-source-list")!;
    const customSourceCount = requiredElement<HTMLElement>(root, "newsnow-custom-source-count")!;
    const sourceDirectorySummary = requiredElement<HTMLElement>(root, "newsnow-source-directory-summary")!;
    const sourceProviderFilters = requiredElement<HTMLElement>(root, "newsnow-source-provider-filters")!;
    const sourceOptions = requiredElement<HTMLElement>(root, "newsnow-source-options")!;
    const sourceStatus = requiredElement<HTMLElement>(root, "newsnow-source-status")!;
    const sourceClose = requiredElement<HTMLButtonElement>(root, "newsnow-source-close")!;
    const tiebaBars = requiredElement<HTMLElement>(root, "newsnow-tieba-bars")!;
    const tiebaAddToggle = requiredElement<HTMLButtonElement>(root, "newsnow-tieba-add-toggle")!;
    const tiebaBarForm = requiredElement<HTMLFormElement>(root, "newsnow-tieba-bar-form")!;
    const tiebaBarInput = requiredElement<HTMLInputElement>(root, "newsnow-tieba-bar-input")!;
    const tiebaBarCancel = requiredElement<HTMLButtonElement>(root, "newsnow-tieba-bar-cancel")!;
    const tiebaBarList = requiredElement<HTMLElement>(root, "newsnow-tieba-bar-list")!;
    const tiebaBarCount = requiredElement<HTMLElement>(root, "newsnow-tieba-bar-count")!;
    const sourceSelection = requiredElement<HTMLElement>(root, "newsnow-source-selection")!;
    const listLayout = requiredElement<HTMLButtonElement>(root, "newsnow-layout-list")!;
    const gridLayout = requiredElement<HTMLButtonElement>(root, "newsnow-layout-grid")!;
    const mixedOrder = requiredElement<HTMLButtonElement>(root, "newsnow-order-mixed")!;
    const sourceOrder = requiredElement<HTMLButtonElement>(root, "newsnow-order-source")!;
    const status = requiredElement<HTMLElement>(root, "newsnow-status")!;
    const feed = requiredElement<HTMLElement>(root, "newsnow-feed")!;
    const feedView = requiredElement<HTMLElement>(root, "newsnow-feed-view")!;
    const reader = requiredElement<HTMLElement>(root, "newsnow-reader")!;
    const readerStatus = requiredElement<HTMLElement>(root, "newsnow-reader-status")!;
    const readerBack = requiredElement<HTMLButtonElement>(root, "newsnow-reader-back")!;
    const readerMeta = requiredElement<HTMLElement>(root, "newsnow-reader-meta")!;
    const readerTitle = requiredElement<HTMLElement>(root, "newsnow-reader-title")!;
    const readerOriginal = requiredElement<HTMLButtonElement>(root, "newsnow-reader-original")!;
    const readerContent = requiredElement<HTMLElement>(root, "newsnow-reader-content")!;
    const categories = requiredElement<HTMLElement>(root, "newsnow-categories")!;
    const updated = requiredElement<HTMLElement>(root, "newsnow-updated")!;
    const shell = root.querySelector<HTMLElement>(".content-shell")!;
    const gestureApi = host.ReaderNewsGesture;
    if (!button || !page || !back || !refresh || !gestureSettings || !gestureApi || !sourceToggle || !sourcePicker || !sourceSearch || !customSourceForm || !customSourceName || !customSourceUrl || !customSourceCategory || !customSourceList || !customSourceCount || !sourceDirectorySummary || !sourceProviderFilters || !sourceOptions || !sourceStatus || !sourceClose || !tiebaBars || !tiebaAddToggle || !tiebaBarForm || !tiebaBarInput || !tiebaBarCancel || !tiebaBarList || !tiebaBarCount || !sourceSelection || !listLayout || !gridLayout || !mixedOrder || !sourceOrder || !status || !feed || !feedView || !reader || !readerStatus || !readerBack || !readerMeta || !readerTitle || !readerOriginal || !readerContent || !categories || !updated || !shell) return null;
    const newsGesture: NewsGestureApi = gestureApi;

    let catalog: NewsCatalogSource[] = [], builtInCatalog: NewsCatalogSource[] = [], customSources = loadStoredCustomSources(), sourceIds: string[] = [], pendingSourceIds: string[] = [], tiebaBarNames = loadStoredTiebaBars(), tiebaEnabledBarNames = loadStoredEnabledTiebaBars(tiebaBarNames), pendingTiebaBarNames: string[] = [], pendingTiebaEnabledBarNames: string[] = [], allItems: NewsItem[] = [];
    let selectedCategory: string = ALL_CATEGORY, selectedSourceProvider = "all", loading = false, catalogueLoading: Promise<NewsCatalogSource[]> | null = null, sourceQuery = "";
    let newsSettingsSyncReady = false, newsSettingsSyncTimer = 0;
    let layout: NewsLayout = storageGet(LAYOUT_STORAGE_KEY, "list") === "grid" ? "grid" : "list";
    let order: NewsOrder = storageGet(ORDER_STORAGE_KEY, "mixed") === "source" ? "source" : "mixed";
    let articleScrollTop = 0, sourcePageScrollTop = 0, articleOpen = false, articleReturnsToIntelligence = false, currentArticleUrl = "", currentArticleItem: NewsItem | null = null, masonryResizeTimer = 0, renderedMasonryColumnCount = 0, feedRenderPending = false;
    let articleTraceSequence = 0, articleTraceStartedAt = 0, feedReturnTraceStartedAt = 0, awaitingFeedHoverTrace = false;
    let backgroundRefreshRunning = false, prefetchDelayTimer = 0, prefetchIntervalTimer = 0, lastUserActivityAt = Date.now(), sourceRefreshTimer = 0;
    let visibleImageRunning = 0;
    const visibleImageQueue: VisibleImageJob[] = [];

    function rebuildCatalog(): void {
      const builtInIds = new Set(builtInCatalog.map((source) => text(source.id)));
      catalog = [
        ...builtInCatalog,
        ...customSources
          .filter((source) => !builtInIds.has(source.id))
          .map(customSourceCatalogEntry),
      ];
    }
    function selectedCustomSources(ids = sourceIds): NewsRecord[] {
      const selected = new Set(ids);
      return customSources
        .filter((source) => selected.has(source.id))
        .map((source) => ({ id: source.id, name: source.name, url: source.url, category: source.category }));
    }
    function renderCustomSources(): void {
      customSourceCount.textContent = `已添加 ${customSources.length} / ${MAX_CUSTOM_SOURCES}`;
      if (!customSources.length) {
        const empty = root.createElement("p");
        empty.className = "newsnow-custom-source-empty";
        empty.textContent = "还没有自定义来源。";
        customSourceList.replaceChildren(empty);
        return;
      }
      const selected = new Set(pendingSourceIds);
      customSourceList.replaceChildren(...customSources.map((source) => {
        const item = root.createElement("div"), toggle = root.createElement("input"), label = root.createElement("label"), name = root.createElement("strong"), details = root.createElement("small"), remove = root.createElement("button");
        const checkboxId = `newsnow-custom-source-${source.id}`;
        item.className = "newsnow-custom-source-item";
        toggle.type = "checkbox";
        toggle.id = checkboxId;
        toggle.checked = selected.has(source.id);
        toggle.setAttribute("aria-label", `启用 ${source.name}`);
        label.htmlFor = checkboxId;
        name.textContent = source.name;
        details.textContent = `${source.category} · ${source.url}`;
        label.append(name, details);
        toggle.addEventListener("change", () => {
          const previousSources = pendingSourceIds.slice();
          if (toggle.checked) {
            pendingSourceIds = [...pendingSourceIds, source.id];
          } else {
            pendingSourceIds = pendingSourceIds.filter((id) => id !== source.id);
          }
          if (!persistSourceChanges()) {
            pendingSourceIds = previousSources;
            toggle.checked = previousSources.includes(source.id);
          }
          renderSourcePicker();
        });
        remove.type = "button";
        remove.className = "newsnow-custom-source-remove";
        remove.textContent = "×";
        remove.title = `删除 ${source.name}`;
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
          const previousCustomSources = customSources.slice();
          const previousSources = pendingSourceIds.slice();
          customSources = customSources.filter((entry) => entry.id !== source.id);
          saveCustomSources(customSources);
          rebuildCatalog();
          pendingSourceIds = pendingSourceIds.filter((id) => id !== source.id);
          if (!pendingSourceIds.length) pendingSourceIds = defaultSourceIds(catalog);
          if (!persistSourceChanges()) {
            customSources = previousCustomSources;
            saveCustomSources(customSources);
            rebuildCatalog();
            pendingSourceIds = previousSources;
          }
          renderSourcePicker();
        });
        item.append(toggle, label, remove);
        return item;
      }));
    }

    const newsEnabled = () => host.ReaderExperimentalFeatures?.enabled?.("newsnow") === true;
    const backgroundPrefetchEnabled = () => host.ReaderExperimentalFeatures?.enabled?.("newsnowPrefetch") === true;
    function applyExperimentalAvailability() {
      const enabled = newsEnabled();
      button.hidden = !enabled;
      if (!enabled && (!page.hidden || !reader.hidden)) close({ focus: false });
    }
    function setStatus(message: unknown, kind = ""): void { status.textContent = text(message); status.className = "newsnow-status" + (kind ? " " + kind : ""); }
    function setSourceStatus(message: unknown, kind = ""): void { sourceStatus.textContent = text(message); sourceStatus.className = "newsnow-source-status" + (kind ? " " + kind : ""); }
    function sourceForId(id: unknown): NewsCatalogSource | undefined { return catalog.find((source) => text(source.id) === text(id)); }
    function renderSourceSelection() { sourceSelection.textContent = `已选 ${pendingSourceIds.length} 个`; }
    function syncPendingTiebaSource() {
      pendingTiebaEnabledBarNames = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      if (!pendingTiebaEnabledBarNames.length) { pendingSourceIds = pendingSourceIds.filter((id) => id !== "tieba"); return true; }
      if (pendingSourceIds.includes("tieba")) return true;
      pendingSourceIds = [...pendingSourceIds, "tieba"];
      return true;
    }
    function scheduleSourceRefresh() {
      host.clearTimeout(sourceRefreshTimer);
      sourceRefreshTimer = host.setTimeout(() => {
        if (loading) { scheduleSourceRefresh(); return; }
        void load(true);
      }, 450);
    }
    function queueNewsSourceSettingsSync() {
      if (!newsSettingsSyncReady || !canInvoke) return;
      host.clearTimeout(newsSettingsSyncTimer);
      newsSettingsSyncTimer = host.setTimeout(() => {
        invoke("app_settings_sync_save", {
          request: {
            // Custom feed definitions are deliberately local.  Sync only the
            // portable built-in selection; otherwise another device would get
            // an opaque ID without its user-supplied HTTPS address.
            newsSourceIds: sourceIds.filter((id) => !customSources.some((source) => source.id === id)),
            newsTiebaBars: tiebaBarNames,
            newsEnabledTiebaBars: tiebaEnabledBarNames,
          },
        }).catch(() => {});
      }, 180);
    }
    function applySyncedNewsSources(remote: NewsSourceSettings): boolean {
      const bars = normalizeTiebaBars(remote?.newsTiebaBars);
      const enabledBars = enabledTiebaBars(remote?.newsEnabledTiebaBars, bars);
      const customIds = new Set(customSources.map((source) => source.id));
      const selected = allowedSourceIds(
        Array.isArray(remote?.newsSourceIds) ? remote.newsSourceIds.filter((id) => !customIds.has(text(id))) : [],
        catalog,
      );
      sourceIds.filter((id) => customIds.has(id)).forEach((id) => {
        if (!selected.includes(id)) selected.push(id);
      });
      if (!selected.length) return false;
      if (enabledBars.length && !selected.includes("tieba")) selected.push("tieba");
      sourceIds = selected;
      tiebaBarNames = bars;
      tiebaEnabledBarNames = enabledBars;
      storageSet(SOURCE_STORAGE_KEY, JSON.stringify(sourceIds));
      storageSet(TIEBA_BARS_STORAGE_KEY, JSON.stringify(tiebaBarNames));
      storageSet(TIEBA_ENABLED_BARS_STORAGE_KEY, JSON.stringify(tiebaEnabledBarNames));
      queueNewsSourceSettingsSync();
      selectedCategory = ALL_CATEGORY;
      renderCategories();
      if (!sourcePicker.hidden) {
        pendingSourceIds = sourceIds.slice();
        pendingTiebaBarNames = tiebaBarNames.slice();
        pendingTiebaEnabledBarNames = tiebaEnabledBarNames.slice();
        renderSourcePicker();
      }
      if (!page.hidden) scheduleSourceRefresh();
      return true;
    }
    async function hydrateNewsSourceSettings() {
      if (!catalog.length || !canInvoke) return;
      try {
        const remote = await invoke<NewsSourceSettings>("app_settings_sync_get");
        newsSettingsSyncReady = false;
        if (remote?.hasNewsSourceSettings) applySyncedNewsSources(remote);
        newsSettingsSyncReady = true;
        if (!remote?.hasNewsSourceSettings) queueNewsSourceSettingsSync();
      } catch {
        newsSettingsSyncReady = true;
      }
    }
    function persistSourceChanges() {
      const activeTiebaBars = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      const selected = allowedSourceIds(pendingSourceIds.filter((id) => id !== "tieba"), catalog);
      if (activeTiebaBars.length) selected.push("tieba");
      if (!selected.length) { setSourceStatus(i18n("newsSourceRequired", "Keep at least one news source."), "warning"); return false; }
      sourceIds = selected;
      tiebaBarNames = normalizeTiebaBars(pendingTiebaBarNames);
      tiebaEnabledBarNames = activeTiebaBars;
      storageSet(SOURCE_STORAGE_KEY, JSON.stringify(sourceIds));
      storageSet(TIEBA_BARS_STORAGE_KEY, JSON.stringify(tiebaBarNames));
      storageSet(TIEBA_ENABLED_BARS_STORAGE_KEY, JSON.stringify(tiebaEnabledBarNames));
      queueNewsSourceSettingsSync();
      selectedCategory = ALL_CATEGORY;
      renderCategories();
      setSourceStatus(i18n("newsSourcesSaved", "Saved. Refreshing news automatically…"), "muted");
      scheduleSourceRefresh();
      return true;
    }
    function renderTiebaBars() {
      pendingTiebaEnabledBarNames = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      tiebaBarCount.textContent = format("tiebaCount", "已添加 {count} / {max} 个吧 · 已启用 {enabled}", { count: pendingTiebaBarNames.length, max: MAX_TIEBA_BARS, enabled: pendingTiebaEnabledBarNames.length });
      if (!pendingTiebaBarNames.length) { const empty = root.createElement("p"); empty.className = "newsnow-tieba-bar-empty"; empty.textContent = i18n("tiebaEmpty", "还没有添加吧名。"); tiebaBarList.replaceChildren(empty); return; }
      tiebaBarList.replaceChildren(...pendingTiebaBarNames.map((bar) => {
        const chip = root.createElement("span"), enabled = root.createElement("input"), name = root.createElement("span"), remove = root.createElement("button");
        chip.className = "newsnow-tieba-bar-chip";
        enabled.type = "checkbox"; enabled.checked = pendingTiebaEnabledBarNames.includes(bar); enabled.title = format("tiebaEnable", "启用 {name}吧", { name: bar }); enabled.setAttribute("aria-label", enabled.title);
        name.textContent = format("tiebaBarName", "{name}吧", { name: bar });
        enabled.addEventListener("change", () => {
          const previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice();
          if (enabled.checked) {
            if (!pendingTiebaEnabledBarNames.includes(bar)) pendingTiebaEnabledBarNames = [...pendingTiebaEnabledBarNames, bar];
            syncPendingTiebaSource();
          } else { pendingTiebaEnabledBarNames = pendingTiebaEnabledBarNames.filter((name) => name !== bar); syncPendingTiebaSource(); }
          if (!persistSourceChanges()) { pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; enabled.checked = previousEnabled.includes(bar); }
          renderTiebaBars(); renderSourceSelection();
        });
        remove.type = "button"; remove.title = format("tiebaRemove", "删除 {name}吧", { name: bar }); remove.setAttribute("aria-label", remove.title); remove.textContent = "×";
        remove.addEventListener("click", () => { const previousBars = pendingTiebaBarNames.slice(), previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice(); pendingTiebaBarNames = pendingTiebaBarNames.filter((name) => name !== bar); pendingTiebaEnabledBarNames = pendingTiebaEnabledBarNames.filter((name) => name !== bar); syncPendingTiebaSource(); if (!persistSourceChanges()) { pendingTiebaBarNames = previousBars; pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; } renderTiebaBars(); renderSourceSelection(); });
        chip.append(enabled, name, remove); return chip;
      }));
    }
    function setTiebaAddOpen(open: boolean, { focus = false }: { readonly focus?: boolean } = {}): void {
      tiebaBarForm.hidden = !open;
      tiebaAddToggle.hidden = open;
      if (!open) tiebaBarInput.value = "";
      if (open && focus) tiebaBarInput.focus({ preventScroll: true });
    }
    function newsRequest() {
      return {
        sourceIds,
        tiebaBars: sourceIds.includes("tieba") ? tiebaEnabledBarNames : [],
        customSources: selectedCustomSources(),
      };
    }
    function categoriesForSelection() { return [...new Set(sourceIds.map(sourceForId).filter(Boolean).map(sourceCategory))]; }
    function applyDisplayOptions() {
      const grid = layout === "grid";
      feed.classList.toggle("newsnow-feed-grid", grid);
      feed.classList.toggle("newsnow-feed-by-source", order === "source");
      listLayout.setAttribute("aria-pressed", String(!grid));
      gridLayout.setAttribute("aria-pressed", String(grid));
      mixedOrder.setAttribute("aria-pressed", String(order === "mixed"));
      sourceOrder.setAttribute("aria-pressed", String(order === "source"));
    }
    function setLayout(next: unknown): void { layout = next === "grid" ? "grid" : "list"; storageSet(LAYOUT_STORAGE_KEY, layout); applyDisplayOptions(); renderFeed(); }
    function setOrder(next: unknown): void { order = next === "source" ? "source" : "mixed"; storageSet(ORDER_STORAGE_KEY, order); applyDisplayOptions(); renderFeed(); }
    function renderCategories() {
      const all = ALL_CATEGORY, list = [all, ...categoriesForSelection()];
      if (!list.includes(selectedCategory)) selectedCategory = all;
      categories.replaceChildren(...list.map((name) => {
        const tag = root.createElement("button");
        tag.type = "button"; tag.className = "newsnow-category" + (name === selectedCategory ? " active" : ""); tag.textContent = name === all ? i18n("newsCategoryAll", "全部") : name;
        tag.addEventListener("click", () => { selectedCategory = name; renderCategories(); renderFeed(); });
        return tag;
      }));
    }
    function renderSourcePicker() {
      const groups = new Map<string, { provider: string; category: string; sources: NewsCatalogSource[] }>(), query = sourceQuery.trim().toLocaleLowerCase();
      const availableProviders = [...new Set(catalog.filter((source) => text(source.id) !== "tieba").map(sourceProvider))];
      if (selectedSourceProvider !== "all" && !availableProviders.includes(selectedSourceProvider)) selectedSourceProvider = "all";
      const visibleSources = catalog.filter((source: NewsCatalogSource) => {
        if (text(source.id) === "tieba") return false;
        const provider = sourceProvider(source);
        return (selectedSourceProvider === "all" || provider === selectedSourceProvider)
          && (!query || [source.id, source.name, source.category, source.provider, source.kind].some((value) => text(value).toLocaleLowerCase().includes(query)));
      });
      renderTiebaBars();
      renderCustomSources();
      renderSourceSelection();
      sourceDirectorySummary.textContent = `共 ${catalog.filter((source) => text(source.id) !== "tieba").length} 个来源 · ${availableProviders.length} 个提供方 · 当前显示 ${visibleSources.length} 个`;
      sourceProviderFilters.replaceChildren(...["all", ...availableProviders].map((provider) => {
        const filter = root.createElement("button");
        filter.type = "button";
        filter.className = "newsnow-source-provider-filter";
        filter.dataset.provider = provider;
        filter.setAttribute("aria-pressed", String(provider === selectedSourceProvider));
        filter.textContent = provider === "all" ? "全部来源" : sourceProviderLabel(provider);
        filter.addEventListener("click", () => {
          selectedSourceProvider = provider;
          renderSourcePicker();
        });
        return filter;
      }));
      const selected = new Set(pendingSourceIds);
      visibleSources.forEach((source) => {
        const provider = sourceProvider(source), category = sourceCategory(source), key = `${provider}\u0000${category}`;
        const group = groups.get(key) ?? { provider, category, sources: [] };
        group.sources.push(source);
        groups.set(key, group);
      });
      if (!groups.size) { const empty = root.createElement("p"); empty.className = "newsnow-source-empty"; empty.textContent = i18n("noMatchingSources", "没有找到匹配的内置来源。"); sourceOptions.replaceChildren(empty); return; }
      sourceOptions.replaceChildren(...[...groups.values()].map(({ provider, category, sources }) => {
        const group = root.createElement("section"), title = root.createElement("h2"), choices = root.createElement("div");
        group.className = "newsnow-source-group"; group.dataset.provider = provider; group.dataset.category = category; if (sources.length >= 18) group.dataset.dense = "true"; title.textContent = `${sourceProviderLabel(provider)} · ${category}`; choices.className = "newsnow-source-choices";
        sources.forEach((source: NewsCatalogSource) => {
          const label = root.createElement("label"), checkbox = root.createElement("input"), swatch = root.createElement("i"), name = root.createElement("span"), id = text(source.id);
          const description = sourceDescription(source);
          checkbox.type = "checkbox"; checkbox.checked = selected.has(id); label.className = "newsnow-source-choice" + (checkbox.checked ? " selected" : ""); label.dataset.sourceTooltip = description; label.dataset.gestureInfoStop = "true"; label.title = description; label.setAttribute("aria-label", description); swatch.style.background = text(source.color || "#718097"); name.textContent = text(source.name);
          checkbox.addEventListener("change", () => {
            const previousSources = pendingSourceIds.slice();
            if (checkbox.checked) pendingSourceIds = [...pendingSourceIds, id];
            else pendingSourceIds = pendingSourceIds.filter((value) => value !== id);
            if (!persistSourceChanges()) { pendingSourceIds = previousSources; checkbox.checked = previousSources.includes(id); }
            renderSourcePicker();
          });
          label.append(checkbox, swatch, name);
          choices.appendChild(label);
        });
        group.append(title, choices); return group;
      }));
    }
    function openSourcePicker() { pendingSourceIds = sourceIds.slice(); pendingTiebaBarNames = tiebaBarNames.slice(); pendingTiebaEnabledBarNames = tiebaEnabledBarNames.slice(); syncPendingTiebaSource(); sourceQuery = ""; selectedSourceProvider = "all"; sourceSearch.value = ""; sourceStatus.textContent = ""; setTiebaAddOpen(false); renderSourcePicker(); sourcePageScrollTop = page.scrollTop; feedView.hidden = true; sourcePicker.hidden = false; page.classList.add("newsnow-source-page-active"); page.scrollTop = 0; sourceToggle.setAttribute("aria-expanded", "true"); sourceSearch.focus({ preventScroll: true }); }
    function closeSourcePicker({ focus = false, restoreScroll = true } = {}) { const wasOpen = !sourcePicker.hidden; setTiebaAddOpen(false); sourcePicker.hidden = true; feedView.hidden = false; page.classList.remove("newsnow-source-page-active"); sourceToggle.setAttribute("aria-expanded", "false"); if (wasOpen && restoreScroll) host.requestAnimationFrame(() => { page.scrollTop = sourcePageScrollTop; if (feedRenderPending || layout === "grid") renderFeed(); }); if (focus) sourceToggle.focus({ preventScroll: true }); }
    function setReaderVisible(visible: boolean): void { reader.hidden = !visible; page.hidden = visible; closeSourcePicker({ restoreScroll: false }); }
    function traceArticle(stage: string, outcome: string): void {
      if (!articleTraceStartedAt) return;
      // The trace API accepts only a phase, outcome, monotonically increasing
      // sequence and elapsed time. It deliberately never receives the URL,
      // title, source name or article content.
      host.ReaderProblemTraceUI?.recordNewsArticleTiming?.(
        stage,
        outcome,
        Date.now() - articleTraceStartedAt,
        articleTraceSequence,
      );
    }
    function traceFeedReturn(stage: string, outcome: string, startedAt = feedReturnTraceStartedAt): void {
      if (!startedAt) return;
      // Reuse the news-only redacted trace channel. The value is a duration
      // only; no link, article title, cursor coordinates or page text leaves
      // the renderer.
      host.ReaderProblemTraceUI?.recordNewsArticleTiming?.(
        stage,
        outcome,
        Date.now() - startedAt,
        articleTraceSequence,
      );
    }
    function renderLocalArticle(article: NewsArticle): void {
      readerMeta.textContent = [text(article?.source).trim(), text(article?.publishedAt || article?.published_at).trim()].filter(Boolean).join(" · ");
      readerTitle.textContent = text(article?.title).trim() || i18n("newsReader", "资讯正文");
      readerContent.innerHTML = text(article?.contentHtml || article?.content_html);
      readerStatus.textContent = "";
      readerContent.scrollTop = 0;
    }
    function returnToIntelligenceWorkspace(): boolean {
      const workspace = host.ReaderIntelligenceWorkspace?.instance;
      if (!workspace?.open) return false;
      page.hidden = true;
      shell.hidden = false;
      host.document.body.classList.remove("newsnow-active");
      button.setAttribute("aria-pressed", "false");
      void Promise.resolve(workspace.open()).catch(() => undefined);
      return true;
    }
    function closeArticle({ focus = false, restoreScroll = true } = {}) {
      if (articleOpen) traceArticle("close", "requested");
      const closeStartedAt = Date.now();
      if (articleOpen && canInvoke) {
        void Promise.resolve(invoke("newsnow_close_article"))
          .then(() => traceFeedReturn("close_native_command", "completed", closeStartedAt))
          .catch(() => traceFeedReturn("close_native_command", "failed", closeStartedAt));
      }
      const returnToIntelligence = articleReturnsToIntelligence;
      articleOpen = false; articleReturnsToIntelligence = false; currentArticleUrl = ""; currentArticleItem = null; readerStatus.textContent = ""; readerMeta.textContent = ""; readerTitle.textContent = ""; readerContent.replaceChildren(); setReaderVisible(false);
      if (returnToIntelligence && returnToIntelligenceWorkspace()) return;
      feedReturnTraceStartedAt = closeStartedAt; awaitingFeedHoverTrace = true;
      // 正文打开期间后台可能补齐了缩略图。资讯页隐藏时不能测量瀑布流
      // 宽度，因此回到列表后再用真实宽度重建；方格按钮与卡片列数始终一致。
      if (feedRenderPending || layout === "grid") renderFeed();
      host.requestAnimationFrame(() => {
        traceFeedReturn("feed_frame", "visible");
        if (restoreScroll) page.scrollTop = articleScrollTop;
      });
      if (focus) (feed.querySelector(".newsnow-card") as HTMLElement | null)?.focus({ preventScroll: true });
    }
    async function openArticle(item: NewsItem, { returnToIntelligence = false }: { readonly returnToIntelligence?: boolean } = {}): Promise<void> {
      const url = safeHttpUrl(item.url || item.link || item.href); if (!url) return;
      articleTraceSequence += 1; articleTraceStartedAt = Date.now();
      articleScrollTop = page.scrollTop; page.scrollTop = 0; articleOpen = true; articleReturnsToIntelligence = returnToIntelligence; currentArticleUrl = url; currentArticleItem = { ...item }; readerOriginal.hidden = false; readerMeta.textContent = sourceName(item); readerTitle.textContent = text(item.title || item.name || i18n("newsReader", "资讯正文")); readerContent.replaceChildren(); readerStatus.textContent = i18n("loadingNews", "加载中…"); setReaderVisible(true); traceArticle("click", "reader_shell_visible");
      try {
        const article = await invoke<NewsArticle>("newsnow_open_article", { request: {
          url,
          title: text(item.title || item.name),
          summary: text(item.summary || item.description || item.content || item.excerpt),
          publishedAt: text(item.publishedAt || item.published_at || item.pubDate || item.date),
          gestureEnabled: newsGesture.loadEnabled(host.localStorage),
          gesturePoints: newsGesture.load(host.localStorage).map((point) => [point.x, point.y]),
          gestureThreshold: newsGesture.matchThreshold(newsGesture.loadPrecision(host.localStorage)),
          hideReturnIcon: host.ReaderExperimentalFeatures?.enabled?.("newsnowHideReturnIcon") === true,
        } });
        if (article?.local) { traceArticle("native_command", "local_article"); renderLocalArticle(article); }
        else { traceArticle("native_command", "navigation_queued"); readerStatus.textContent = "正在加载网页原文…可随时返回。"; }
      }
      catch { traceArticle("native_command", "failed"); const returnToIntelligence = articleReturnsToIntelligence; articleOpen = false; articleReturnsToIntelligence = false; currentArticleUrl = ""; currentArticleItem = null; setReaderVisible(false); if (!returnToIntelligence || !returnToIntelligenceWorkspace()) setStatus(i18n("newsArticleLoadFailed", "资讯正文加载失败，请稍后重试。"), "error"); }
    }
    function openPreparedArticle(article: PreparedNewsArticle, { returnToIntelligence = false }: { readonly returnToIntelligence?: boolean } = {}): void {
      // Keep the shell transition identical to ordinary news links.  The
      // intelligence workspace closes before it hands us a prepared article;
      // without this synchronous activation its close path exposes the
      // bookshelf shell over the already-populated reader.
      void open({ allowWhenDisabled: true, skipFeedLoad: true });
      articleTraceSequence += 1; articleTraceStartedAt = Date.now();
      articleScrollTop = page.scrollTop; page.scrollTop = 0; articleOpen = true; articleReturnsToIntelligence = returnToIntelligence; currentArticleUrl = ""; currentArticleItem = null;
      readerOriginal.hidden = true;
      readerMeta.textContent = [article.source.trim(), article.publishedAt?.trim() ?? ""].filter(Boolean).join(" · ");
      readerTitle.textContent = article.title.trim() || i18n("newsReader", "资讯正文");
      readerContent.innerHTML = article.contentHtml;
      readerContent.scrollTop = 0;
      readerStatus.textContent = "";
      setReaderVisible(true);
      traceArticle("prepared_brief", "ready");
    }
    function applyCardImage(image: HTMLImageElement, card: HTMLElement, url: string): void {
      if (!url) return;
      image.classList.remove("loading"); image.src = url; image.hidden = false; card.classList.add("has-image");
    }
    function runVisibleImageQueue() {
      while (visibleImageRunning < VISIBLE_IMAGE_CONCURRENCY && visibleImageQueue.length) {
        const job = visibleImageQueue.shift();
        if (!job?.image?.isConnected || job.image.dataset.previewLoaded === "true") continue;
        visibleImageRunning += 1;
        job.item.previewAttempted = true;
        Promise.resolve(invoke<NewsRecord>("newsnow_preview_image", { request: {
          url: job.url,
          imageUrl: text(job.item.imageUrl || job.item.image_url || job.item.image || job.item.cover),
          sourceId: sourceId(job.item),
          itemId: text(job.item.id || job.item.itemId || job.item.item_id),
        } })).then((preview) => {
          const value = safeImageDataUrl(preview.imageDataUrl || preview.image_data_url);
          if (value && job.image.isConnected) {
            job.item.previewDataUrl = value;
            job.image.dataset.previewLoaded = "true";
            applyCardImage(job.image, job.card, value);
          } else if (job.image.isConnected) {
            job.image.classList.remove("loading"); job.image.hidden = true;
          }
        }).catch(() => {
          if (job.image.isConnected) { job.image.classList.remove("loading"); job.image.hidden = true; }
        }).finally(() => { visibleImageRunning -= 1; runVisibleImageQueue(); });
      }
    }
    const visibleImageObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries: IntersectionObserverEntry[]) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        visibleImageObserver?.unobserve(entry.target);
        const image = entry.target as PreviewImageElement;
        const job = image.__newsPreviewJob;
        if (job) { image.__newsPreviewJob = null; visibleImageQueue.push(job); runVisibleImageQueue(); }
      });
    }, { root: page, rootMargin: "500px 0px" }) : null;
    function resetVisibleImageQueue() {
      visibleImageQueue.length = 0;
      if (!visibleImageObserver) return;
      feed.querySelectorAll<PreviewImageElement>(".newsnow-card-image").forEach((image) => {
        visibleImageObserver.unobserve(image); image.__newsPreviewJob = null;
      });
    }
    function scheduleVisibleImage(item: NewsItem, image: PreviewImageElement, card: HTMLElement, url: string): void {
      if (!canInvoke || !url || previewAttempted(item)) return;
      image.hidden = false; image.classList.add("loading");
      const job = { item, image, card, url };
      // renderCards() 会先创建完整卡片树，最后才用 replaceChildren() 一次挂到
      // 页面。不能在这一刻观察尚未连接的 <img>：WebView 对 detached target
      // 不保证后续补发 IntersectionObserver 回调，结果就是整页一直只有骨架。
      // 等下一帧确认挂载后再进入原有可见队列，仍保持四路上限和 viewport 优先级。
      const enqueueWhenConnected = () => {
        if (!image.isConnected || image.dataset.previewLoaded === "true") return;
        if (visibleImageObserver) {
          image.__newsPreviewJob = job;
          visibleImageObserver.observe(image);
        } else {
          visibleImageQueue.push(job);
          runVisibleImageQueue();
        }
      };
      host.requestAnimationFrame(enqueueWhenConnected);
    }
    function makeCard(item: NewsItem): HTMLElement {
      const article = root.createElement("article"), url = safeHttpUrl(item.url || item.link || item.href), rail = root.createElement("div"), content = root.createElement("div"), meta = root.createElement("div"), source = root.createElement("span"), title = root.createElement("h2");
      article.className = "newsnow-card"; article.tabIndex = url ? 0 : -1; rail.className = "newsnow-card-rail"; rail.style.background = text(item.sourceColor || item.source_color || "#718097"); content.className = "newsnow-card-content"; meta.className = "newsnow-meta"; source.className = "newsnow-source-name"; source.textContent = sourceName(item); title.textContent = text(item.title || item.name || i18n("untitledNews", "未命名新闻")); meta.appendChild(source);
      const time = itemDate(item); if (time) { const timeEl = root.createElement("time"); timeEl.textContent = time; meta.appendChild(timeEl); }
      const prefetchedImage = safeImageDataUrl(item.previewDataUrl || item.preview_data_url);
      const image = root.createElement("img") as PreviewImageElement; image.className = "newsnow-card-image"; image.alt = ""; image.loading = "lazy"; image.hidden = true;
      image.addEventListener("error", () => { image.classList.remove("loading"); image.hidden = true; article.classList.remove("has-image"); }); content.appendChild(image);
      // 后台缓存负责大批量填充；尚未尝试过的可见卡片再走一个至多 4 路的
      // 按需队列，避免首屏等待所有来源，也避免滚动时瞬间发出数百个请求。
      if (prefetchedImage) applyCardImage(image, article, prefetchedImage);
      else scheduleVisibleImage(item, image, article, url);
      content.append(meta, title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim(); if (description) { const summary = root.createElement("p"); summary.className = "newsnow-summary"; summary.textContent = description; content.appendChild(summary); }
      if (url) { const open = root.createElement("span"); open.className = "newsnow-open-hint"; open.textContent = i18n("openWebPage", "打开网页 →"); content.appendChild(open); article.addEventListener("click", () => openArticle(item)); article.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openArticle(item); } }); }
      article.append(rail, content); return article;
    }
    function filteredItems() { return selectedCategory === ALL_CATEGORY ? allItems : allItems.filter((item) => sourceCategory(sourceForId(sourceId(item))) === selectedCategory); }
    function masonryColumnCount() {
      const minimumCardWidth = 210, gap = 13, width = feed.clientWidth || page.clientWidth;
      if (typeof newsLayoutRules?.masonryColumnCount === "function") return newsLayoutRules.masonryColumnCount(width, renderedMasonryColumnCount, { minimumCardWidth, gap });
      if (!width) return Math.max(1, renderedMasonryColumnCount || 1);
      return Math.max(1, Math.floor((width + gap) / (minimumCardWidth + gap)));
    }
    function estimatedCardHeight(item: NewsItem, columnCount: number): number {
      const gap = 13;
      const width = feed.clientWidth || page.clientWidth || 210;
      const title = text(item.title || item.name || i18n("untitledNews", "未命名新闻"));
      const summary = text(item.summary || item.description || item.content || item.excerpt).trim();
      const hasImage = Boolean(safeImageDataUrl(item.previewDataUrl || item.preview_data_url));
      if (typeof newsLayoutRules?.estimateCardHeight === "function") return newsLayoutRules.estimateCardHeight({ title, summary, hasImage }, { width, columnCount, gap });
      const availableWidth = Math.max(160, (width - gap * (columnCount - 1)) / columnCount - 40);
      const charsPerLine = Math.max(10, Math.floor(availableWidth / 16));
      const lineCount = (value: unknown, maximum: number): number => Math.min(maximum, Math.max(1, Math.ceil(Array.from(text(value)).length / charsPerLine)));
      const titleLines = lineCount(title, 4);
      const summaryLines = summary ? lineCount(summary, 3) : 0;
      return 68 + titleLines * 27 + summaryLines * 21 + (hasImage ? 146 : 0) + 44;
    }
    function renderCards(container: HTMLElement, items: NewsItem[]): void {
      if (layout !== "grid") { renderedMasonryColumnCount = 0; container.replaceChildren(...items.map(makeCard)); return; }
      const columnCount = masonryColumnCount(); container.style.setProperty("--newsnow-grid-columns", String(columnCount));
      const columns = Array.from({ length: columnCount }, () => {
        const column = root.createElement("div"); column.className = "newsnow-masonry-column"; return column;
      });
      const columnHeights = Array.from({ length: columnCount }, () => 0);
      const estimatedHeights = items.map((item) => estimatedCardHeight(item, columnCount));
      const targets = typeof newsLayoutRules?.balancedColumnIndexes === "function"
        ? newsLayoutRules.balancedColumnIndexes(estimatedHeights, columnCount)
        : estimatedHeights.map((_, itemIndex) => {
          const target = columnHeights.reduce((shortest, height, index) => height < (columnHeights[shortest] ?? 0) ? index : shortest, 0);
          columnHeights[target] = (columnHeights[target] ?? 0) + (estimatedHeights[itemIndex] ?? 0);
          return target;
        });
      items.forEach((item, itemIndex) => {
        const target = targets[itemIndex] ?? 0;
        columns[target]?.appendChild(makeCard(item));
      });
      renderedMasonryColumnCount = columnCount;
      container.replaceChildren(...columns);
    }
    function renderFeed() {
      applyDisplayOptions();
      // hidden 会令 clientWidth 变成 0。此时保留最新数据，等资讯页重新可见
      // 后再渲染，避免方格布局被错误固化成单列。
      if (page.hidden || feedView.hidden) { feedRenderPending = true; return; }
      feedRenderPending = false;
      resetVisibleImageQueue();
      const items = filteredItems();
      if (!items.length) { const empty = root.createElement("div"); empty.className = "newsnow-empty"; empty.textContent = allItems.length ? i18n("noNewsInCategory", "这个分类暂时没有资讯。") : i18n("noNews", "暂无资讯。请刷新，或在“管理来源”中调整显示内容。"); feed.replaceChildren(empty); return; }
      if (order === "mixed") { renderCards(feed, items); return; }
      const groups = new Map<string, NewsItem[]>(); items.forEach((item) => { const id = sourceId(item); if (!groups.has(id)) groups.set(id, []); groups.get(id)?.push(item); });
      // 自定义贴吧是用户主动订阅的内容。放在按来源视图的首组，避免它被
      // 一串默认来源排到屏幕外，造成“已经添加却看不到”的错觉。
      const orderedIds = [...sourceIds, ...groups.keys()]
        .filter((id, index, list) => groups.has(id) && list.indexOf(id) === index)
        .sort((left, right) => {
          const leftPriority = left === "tieba" ? 0 : 1, rightPriority = right === "tieba" ? 0 : 1;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return 0;
        });
      feed.replaceChildren(...orderedIds.map((id) => { const section = root.createElement("section"), heading = root.createElement("h2"), cards = root.createElement("div"), source = sourceForId(id), groupItems = groups.get(id) ?? []; section.className = "newsnow-source-section"; heading.textContent = text(source?.name || groupItems[0] && sourceName(groupItems[0]) || i18n("news", "资讯")); cards.className = "newsnow-source-cards"; renderCards(cards, groupItems); section.append(heading, cards); return section; }));
    }
    async function loadSources() {
      if (catalog.length) return catalog; if (catalogueLoading) return catalogueLoading;
      catalogueLoading = invoke<unknown>("newsnow_sources")
        .then((sources) => Array.isArray(sources) ? sources.map((source) => record(source) ?? {}) : [])
        .then(async (sources) => {
          builtInCatalog = sources;
          if (canInvoke) {
            try {
              const persisted = normalizeCustomSources(await invoke<unknown>("newsnow_custom_sources_get"));
              // First-run migration keeps an existing local list if the native
              // store has no state yet. A non-empty synced store wins on a new
              // device and is then cached for offline use.
              if (persisted.length || !customSources.length) {
                customSources = persisted;
                storageSet(CUSTOM_SOURCES_STORAGE_KEY, JSON.stringify(customSources));
              } else {
                saveCustomSources(customSources);
              }
            } catch { /* legacy/native-unavailable fallback remains local */ }
          }
          rebuildCatalog();
          sourceIds = loadStoredSourceIds(catalog);
          renderCategories();
          await hydrateNewsSourceSettings();
          return catalog;
        })
        .catch(() => { builtInCatalog = []; rebuildCatalog(); sourceIds = loadStoredSourceIds(catalog); return catalog; })
        .finally(() => { catalogueLoading = null; });
      return catalogueLoading;
    }
    function applyNewsResult(result: NewsResult, { announce = false }: { readonly announce?: boolean } = {}): void {
      allItems = resultItems(result).map((item) => record(item) ?? {}); renderCategories(); renderFeed();
      const stamp = result.fetched_at || result.fetchedAt;
      updated.textContent = stamp ? format("newsUpdatedAt", "更新于 {time}", { time: itemDate({ published_at: stamp }) }) : "";
      if (!announce || page.hidden) return;
      const message = text(result.message).trim();
      // 不展示“已更新 N 条资讯”：资讯数量由每个已选来源实际返回的内容
      // 决定，并非阅读器设定的配额。只有错误、旧缓存或来源不可用时提示。
      setStatus(message, result.stale ? "warning" : (message && !allItems.length ? "error" : "muted"));
    }
    async function refreshInBackground({ announce = false }: { readonly announce?: boolean } = {}): Promise<void> {
      if (backgroundRefreshRunning || !newsEnabled() || !canInvoke) return;
      backgroundRefreshRunning = true;
      try {
        await loadSources();
        let result: NewsResult | null = null;
        // 后端每轮只压缩一批封面，避免一次刷新被数百张图片拖住。空闲后台
        // 连续推进有限批次，并在最后整体替换卡片，既覆盖更多文章，也避免
        // 每拿到一张图片就改变瀑布流高度。
        for (let batch = 0; batch < BACKGROUND_PREFETCH_BATCHES; batch += 1) {
          result = await withTimeout(invoke<NewsResult>("newsnow_prefetch", { request: newsRequest() }), 60000);
          if (!hasPendingPreviews(result)) break;
        }
        if (result) applyNewsResult(result, { announce });
      } catch {
        if (announce && !page.hidden) setStatus(i18n("newsBackgroundRefreshFailed", "资讯后台更新失败，正在保留已显示内容。"), "warning");
      } finally { backgroundRefreshRunning = false; }
    }
    function stopBackgroundPrefetch() {
      if (prefetchDelayTimer) host.clearTimeout(prefetchDelayTimer);
      if (prefetchIntervalTimer) host.clearInterval(prefetchIntervalTimer);
      prefetchDelayTimer = 0; prefetchIntervalTimer = 0;
    }
    function refreshIfIdle() {
      if (Date.now() - lastUserActivityAt < BACKGROUND_PREFETCH_DELAY_MS) return;
      void refreshInBackground();
    }
    function scheduleBackgroundPrefetch() {
      stopBackgroundPrefetch();
      if (!newsEnabled() || !backgroundPrefetchEnabled() || !canInvoke) return;
      prefetchDelayTimer = host.setTimeout(() => {
        refreshIfIdle();
        prefetchIntervalTimer = host.setInterval(refreshIfIdle, BACKGROUND_PREFETCH_INTERVAL_MS);
      }, BACKGROUND_PREFETCH_DELAY_MS);
    }
    async function load(force = false): Promise<void> {
      if (loading || !canInvoke) return; loading = true; refresh.disabled = true; refresh.textContent = force ? i18n("refreshingNews", "刷新中…") : i18n("loadingNews", "加载中…"); setStatus(force ? i18n("refreshingNews", "刷新中…") : i18n("loadingNews", "加载中…"), "muted");
      try {
        await loadSources();
        const result = await withTimeout(invoke<NewsResult>(force ? "newsnow_refresh" : "newsnow_list", { request: newsRequest() }));
        applyNewsResult(result, { announce: true });
        // 新安装或缓存升级后，列表会先有文字缓存但还没有缩略图；立即安排
        // 一次后台填充，保证下次进入资讯页可直接使用稳定的封面尺寸。
        const needsPreviewCache = hasPendingPreviews(result);
        if (result.stale || needsPreviewCache) void refreshInBackground({ announce: true });
      }
      catch (error) { renderFeed(); setStatus(error instanceof Error && error.message === "news-request-timeout" ? i18n("newsRequestTimedOut", "资讯请求超时，正在保留当前内容。") : i18n("newsLoadFailed", "资讯加载失败，请检查网络后重试。"), "error"); }
      finally { loading = false; refresh.disabled = false; refresh.textContent = i18n("refresh", "刷新"); }
    }
    async function open({ allowWhenDisabled = false, skipFeedLoad = false }: { readonly allowWhenDisabled?: boolean; readonly skipFeedLoad?: boolean } = {}): Promise<void> {
      if ((!allowWhenDisabled && !newsEnabled()) || !canInvoke) return; root.getElementById("menu")?.classList.remove("show"); root.getElementById("filter-panel")?.classList.remove("show"); root.getElementById("account-panel")?.classList.remove("show"); if (!root.getElementById("library-ai-page")?.hidden) host.ReaderLibraryAiEntry?.close?.();
      const intelligencePage = root.getElementById("intelligence-workspace-page");
      if (intelligencePage && !intelligencePage.hidden) {
        host.ReaderIntelligenceWorkspace?.instance?.close?.({ focus: false });
      }
      page.hidden = false; feedView.hidden = false; sourcePicker.hidden = true; page.classList.remove("newsnow-source-page-active"); shell.hidden = true; host.document.body.classList.add("newsnow-active"); button.setAttribute("aria-pressed", "true");
      // 页面关闭期间完成的后台补图先应用到现有缓存，无需再点开一篇正文
      // 才能看到图片；随后正常加载最新列表。
      if (feedRenderPending) renderFeed();
      if (!skipFeedLoad) await load(false);
    }
    function close({ focus = true }: { readonly focus?: boolean } = {}) { closeSourcePicker({ restoreScroll: false }); closeArticle({ restoreScroll: false }); page.hidden = true; shell.hidden = false; host.document.body.classList.remove("newsnow-active"); button.setAttribute("aria-pressed", "false"); if (focus && !button.hidden) button.focus({ preventScroll: true }); }
    gestureSettings.addEventListener("click", () => host.ReaderExperimentalFeatures?.instance?.openSettings?.());
    button.addEventListener("click", () => { if (!page.hidden || !reader.hidden) close({ focus: false }); else void open(); }); back.addEventListener("click", () => close()); refresh.addEventListener("click", () => void load(true)); listLayout.addEventListener("click", () => setLayout("list")); gridLayout.addEventListener("click", () => setLayout("grid")); mixedOrder.addEventListener("click", () => setOrder("mixed")); sourceOrder.addEventListener("click", () => setOrder("source"));
    readerBack.addEventListener("click", () => closeArticle({ focus: true }));
    readerOriginal.addEventListener("click", () => { if (currentArticleUrl) void Promise.resolve(invoke("open_url", { url: currentArticleUrl })).catch(() => {}); });
    readerContent.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null; if (!link) return;
      const preparedSourceUrl = safeHttpUrl(link.getAttribute("data-newsnow-prepared-source-url"));
      if (preparedSourceUrl) {
        // A local intelligence brief has no current upstream URL. Its source
        // citations must therefore re-enter the same in-app article flow,
        // rather than falling through to `open_url` and an external browser.
        event.preventDefault();
        void openArticle({
          url: preparedSourceUrl,
          title: text(link.textContent) || i18n("newsReader", "资讯正文"),
          source: i18n("newsReader", "资讯正文"),
        }, { returnToIntelligence: articleReturnsToIntelligence });
        return;
      }
      if (!currentArticleUrl) return;
      event.preventDefault();
      let url = ""; try { url = safeHttpUrl(new URL(link.getAttribute("href") || "", currentArticleUrl).href); } catch { url = ""; }
      if (url) void Promise.resolve(invoke("open_url", { url })).catch(() => {});
    });
    sourceToggle.addEventListener("click", () => { if (sourcePicker.hidden) void loadSources().then(openSourcePicker); else closeSourcePicker({ focus: true }); }); sourceClose.addEventListener("click", () => closeSourcePicker({ focus: true })); sourceSearch.addEventListener("input", () => { sourceQuery = sourceSearch.value; renderSourcePicker(); });
    customSourceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = customSourceText(customSourceName.value, MAX_CUSTOM_SOURCE_NAME_LENGTH);
      const url = normalizedCustomSourceUrl(customSourceUrl.value);
      const category = customSourceText(customSourceCategory.value, MAX_CUSTOM_SOURCE_CATEGORY_LENGTH);
      if (!name || !url || !category) {
        setSourceStatus("请填写名称、分类和有效的 HTTPS RSS / Atom 地址。", "warning");
        if (!name) customSourceName.focus(); else if (!url) customSourceUrl.focus(); else customSourceCategory.focus();
        return;
      }
      if (customSources.some((source) => source.url === url)) {
        setSourceStatus("该自定义来源已经添加。", "warning");
        customSourceUrl.focus();
        return;
      }
      if (customSources.length >= MAX_CUSTOM_SOURCES) {
        setSourceStatus(`本机最多保存 ${MAX_CUSTOM_SOURCES} 条自定义来源。`, "warning");
        return;
      }
      const source: CustomNewsSource = { id: stableCustomSourceId(url), name, url, category };
      const previousCustomSources = customSources.slice();
      const previousSources = pendingSourceIds.slice();
      customSources = [...customSources, source];
      saveCustomSources(customSources);
      rebuildCatalog();
      pendingSourceIds = [...pendingSourceIds, source.id];
      const automaticallyEnabled = persistSourceChanges();
      if (!automaticallyEnabled && pendingSourceIds.includes(source.id)) {
        customSources = previousCustomSources;
        saveCustomSources(customSources);
        rebuildCatalog();
        pendingSourceIds = previousSources;
        setSourceStatus("无法保存此来源，请稍后重试。", "error");
        renderSourcePicker();
        return;
      }
        customSourceForm.reset();
      customSourceCategory.value = "自定义";
      setSourceStatus(
        automaticallyEnabled ? "已添加并启用自定义来源。" : "已添加自定义来源；暂时无法保存启用状态。",
        automaticallyEnabled ? "muted" : "warning",
      );
      renderSourcePicker();
      customSourceName.focus({ preventScroll: true });
    });
    tiebaAddToggle.addEventListener("click", () => setTiebaAddOpen(true, { focus: true }));
    tiebaBarCancel.addEventListener("click", () => setTiebaAddOpen(false, { focus: true }));
    tiebaBarForm.addEventListener("submit", (event) => { event.preventDefault(); const name = normalizeTiebaBars([tiebaBarInput.value])[0]; if (!name) { tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.includes(name)) { tiebaBarInput.value = ""; tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.length >= MAX_TIEBA_BARS) { setSourceStatus(format("newsTiebaLimit", "You can add up to {max} forums.", { max: MAX_TIEBA_BARS }), "warning"); return; } const previousBars = pendingTiebaBarNames.slice(), previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice(); pendingTiebaBarNames = [...pendingTiebaBarNames, name]; pendingTiebaEnabledBarNames = [...pendingTiebaEnabledBarNames, name]; if (!syncPendingTiebaSource() || !persistSourceChanges()) { pendingTiebaBarNames = previousBars; pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; setSourceStatus(format("newsSourceLimit", "The source limit is reached, so {name} cannot be enabled yet.", { name }), "warning"); } renderSourcePicker(); setTiebaAddOpen(false, { focus: true }); });
    host.addEventListener("keydown", (event) => { if (event.key !== "Escape" || (page.hidden && reader.hidden)) return; if (!reader.hidden) closeArticle({ focus: true }); else if (!sourcePicker.hidden) closeSourcePicker({ focus: true }); else close(); });
    feed.addEventListener("pointerover", (event) => {
      if (!awaitingFeedHoverTrace || !(event.target instanceof Element) || !event.target.closest(".newsnow-card")) return;
      awaitingFeedHoverTrace = false;
      const receivedAt = Date.now();
      const eventTimestamp = Number(event.timeStamp);
      const dispatchLag = Number.isFinite(eventTimestamp) && eventTimestamp >= 0 && eventTimestamp <= host.performance.now()
        ? Math.max(0, host.performance.now() - eventTimestamp)
        : 0;
      traceFeedReturn("feed_hover_dispatch", "received", receivedAt - dispatchLag);
      host.requestAnimationFrame(() => traceFeedReturn("feed_hover_frame", "rendered", receivedAt));
    }, { passive: true });
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach((eventName) => host.addEventListener(eventName, () => { lastUserActivityAt = Date.now(); }, { passive: true }));
    host.addEventListener("resize", () => {
      if (layout !== "grid" || page.hidden || feedView.hidden || !feed.clientWidth) return;
      // 拖动窗口时宽度会持续变化，但列数未变无需重建全部卡片；否则图片
      // 和文章节点反复销毁/创建，会造成肉眼可见的闪烁。
      if (masonryColumnCount() === renderedMasonryColumnCount) return;
      host.clearTimeout(masonryResizeTimer);
      masonryResizeTimer = host.setTimeout(() => {
        if (masonryColumnCount() !== renderedMasonryColumnCount) renderFeed();
      }, 120);
    });
    host.addEventListener("app-language-changed", () => { renderSourceSelection(); renderCategories(); renderSourcePicker(); renderFeed(); if (loading) refresh.textContent = i18n("loadingNews", "加载中…"); });
    if (transport?.listen) {
      void transport.listen("app-settings-synced", () => {
        void hydrateNewsSourceSettings();
        if (!canInvoke) return;
        void invoke<unknown>("newsnow_custom_sources_get")
          .then((sources) => {
            customSources = normalizeCustomSources(sources);
            storageSet(CUSTOM_SOURCES_STORAGE_KEY, JSON.stringify(customSources));
            rebuildCatalog();
            sourceIds = allowedSourceIds(sourceIds, catalog);
            pendingSourceIds = sourceIds.slice();
            if (!sourcePicker.hidden) renderSourcePicker();
          })
          .catch(() => undefined);
      }).catch(() => undefined);
      void transport.listen("newsnow-return-to-feed", () => {
        closeArticle({ focus: true });
      }).catch(() => undefined);
      void transport.listen("newsnow-article-loading", () => {
        if (!articleOpen || reader.hidden) return;
        traceArticle("native_page_load", "started");
        readerStatus.textContent = "正在加载网页原文…可随时返回。";
      }).catch(() => undefined);
      void transport.listen("newsnow-article-ready", () => {
        if (!articleOpen || reader.hidden) return;
        traceArticle("native_page_load", "finished");
        readerStatus.textContent = "";
      }).catch(() => undefined);
    }
    // Keep the native article WebView warm while the main reader is idle. It
    // uses a local loading shell and remains hidden until a news or
    // intelligence link is clicked, so the click path only reveals and
    // navigates an existing surface.
    if (canInvoke) void invoke("newsnow_prepare_article_shell").catch(() => undefined);
    host.addEventListener("reader-experimental-features-changed", (event) => { const detail = event instanceof CustomEvent ? record(event.detail) : null; if (detail?.key === "newsnow") applyExperimentalAvailability(); if (detail?.key === "newsnow" || detail?.key === "newsnowPrefetch") scheduleBackgroundPrefetch(); }); applyExperimentalAvailability(); applyDisplayOptions(); scheduleBackgroundPrefetch();
    function gestureBack(): void {
      if (!reader.hidden) closeArticle({ focus: false });
      else if (!sourcePicker.hidden) closeSourcePicker({ focus: false });
      else if (!page.hidden) close({ focus: false });
    }
    function gestureReopen(): () => void {
      if (!reader.hidden) {
        const item = currentArticleItem ? { ...currentArticleItem } : null;
        const returnToIntelligence = articleReturnsToIntelligence;
        return item ? () => void openArticle(item, { returnToIntelligence }) : () => void open();
      }
      if (!sourcePicker.hidden)
        return () => void loadSources().then(openSourcePicker);
      return () => void open();
    }
    const sourceRequest = async (): Promise<NewsRecord> => {
      await loadSources();
      return {
        sourceIds: sourceIds.slice(),
        tiebaBars: sourceIds.includes("tieba") ? tiebaEnabledBarNames.slice() : [],
        customSources: selectedCustomSources(),
      };
    };
    const openSources = async (): Promise<void> => {
      await open({ allowWhenDisabled: true });
      await loadSources();
      openSourcePicker();
    };
    const openItem = (item: NewsItem, options: { readonly returnToIntelligence?: boolean } = {}): Promise<void> => {
      // The intelligence workspace already owns the feed data. Avoid awaiting
      // a second list request here, otherwise the ordinary news page can paint
      // briefly before the article WebView covers it.
      // Both calls publish their visible state before their first await. Do not
      // await `open` here: doing so defers the reader transition to a later
      // microtask and can make a link click appear unresponsive under load.
      void open({ allowWhenDisabled: true, skipFeedLoad: true });
      return openArticle(item, options);
    };
    return { open, openItem, openPreparedArticle, openSources, sourceRequest, close, gestureSurface: () => (!reader.hidden ? reader : (!page.hidden ? page : null)), gestureBack, gestureReopen, refresh: () => load(true), render: (items: unknown) => { allItems = resultItems(items).map((item) => record(item) ?? {}); renderCategories(); renderFeed(); }, sources: () => catalog.slice(), layout: (): NewsLayout => layout, order: (): NewsOrder => order };
  }
  const publicApi: NewsUiGlobal = {
    init,
    resultItems,
    safeHttpUrl,
    withTimeout,
    allowedSourceIds,
  };
  host.ReaderNewsUI = publicApi;
  publicApi.instance = init();
  return publicApi;
}
