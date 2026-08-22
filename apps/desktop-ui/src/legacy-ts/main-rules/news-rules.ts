export interface NewsItemLike extends Record<string, unknown> {
  readonly previewAttempted?: unknown;
  readonly preview_attempted?: unknown;
  readonly previewDataUrl?: unknown;
  readonly preview_data_url?: unknown;
  readonly url?: unknown;
  readonly link?: unknown;
  readonly href?: unknown;
}

export interface NewsCatalogSource extends Record<string, unknown> {
  readonly id?: unknown;
  readonly defaultEnabled?: unknown;
  readonly default_enabled?: unknown;
}

export interface NewsRulesApi {
  allowedSourceIds(ids: unknown, catalog: unknown, maxSources?: number): string[];
  defaultSourceIds(catalog: unknown): string[];
  enabledTiebaBars(values: unknown, bars: unknown, maxBars?: number): string[];
  hasPendingPreviews(result: unknown): boolean;
  normalizeTiebaBars(values: unknown, maxBars?: number): string[];
  previewAttempted(item: unknown): boolean;
  resultItems(result: unknown): unknown[];
  safeHttpUrl(value: unknown): string;
  safeImageDataUrl(value: unknown): string;
  text(value: unknown): string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function newsText(value: unknown): string {
  return String(value == null ? "" : value);
}

export function safeNewsHttpUrl(value: unknown): string {
  try {
    const url = new URL(newsText(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function safeNewsImageDataUrl(value: unknown): string {
  const image = newsText(value).trim();
  return /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/i.test(image)
    ? image
    : "";
}

export function newsResultItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const value = record(result);
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.news)) return value.news;
  return [];
}

export function newsPreviewAttempted(item: unknown): boolean {
  const value = record(item);
  return (
    value?.previewAttempted === true ||
    value?.preview_attempted === true ||
    Boolean(safeNewsImageDataUrl(value?.previewDataUrl || value?.preview_data_url))
  );
}

export function hasPendingNewsPreviews(result: unknown): boolean {
  return newsResultItems(result).some((item) => {
    const value = record(item);
    return (
      !newsPreviewAttempted(value) &&
      Boolean(safeNewsHttpUrl(value?.url || value?.link || value?.href))
    );
  });
}

export function defaultNewsSourceIds(catalog: unknown): string[] {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((source) => {
      const value = record(source);
      return value?.defaultEnabled || value?.default_enabled;
    })
    .map((source) => newsText(record(source)?.id));
}

export function allowedNewsSourceIds(
  ids: unknown,
  catalog: unknown,
  maxSources?: number,
): string[] {
  const allowed = new Set(
    (Array.isArray(catalog) ? catalog : []).map((source) =>
      newsText(record(source)?.id),
    ),
  );
  const seen = new Set<string>();
  const values = (Array.isArray(ids) ? ids : [])
    .map(newsText)
    .filter((id) => {
      if (!allowed.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
  return Number.isFinite(maxSources) && (maxSources as number) >= 0
    ? values.slice(0, Math.floor(maxSources as number))
    : values;
}

export function normalizeNewsTiebaBars(values: unknown, maxBars = 8): string[] {
  const seen = new Set<string>();
  return (Array.isArray(values) ? values : [])
    .map((value) => newsText(value).trim().replace(/吧$/u, "").trim())
    .filter((name) => {
      if (
        !name ||
        name.length > 48 ||
        /[\u0000-\u001f\u007f]/u.test(name) ||
        seen.has(name)
      ) {
        return false;
      }
      seen.add(name);
      return true;
    })
    .slice(0, Math.max(0, maxBars));
}

export function enabledNewsTiebaBars(
  values: unknown,
  bars: unknown,
  maxBars = 8,
): string[] {
  const available = new Set(normalizeNewsTiebaBars(bars, maxBars));
  return normalizeNewsTiebaBars(values, maxBars).filter((name) => available.has(name));
}

/** Classic installer replacing `ui/news-rules.js`. */
export function installNewsRules(target: Record<string, unknown>): NewsRulesApi {
  const api = Object.freeze({
    allowedSourceIds: allowedNewsSourceIds,
    defaultSourceIds: defaultNewsSourceIds,
    enabledTiebaBars: enabledNewsTiebaBars,
    hasPendingPreviews: hasPendingNewsPreviews,
    normalizeTiebaBars: normalizeNewsTiebaBars,
    previewAttempted: newsPreviewAttempted,
    resultItems: newsResultItems,
    safeHttpUrl: safeNewsHttpUrl,
    safeImageDataUrl: safeNewsImageDataUrl,
    text: newsText,
  });
  target.ReaderNewsRules = api;
  return api;
}
