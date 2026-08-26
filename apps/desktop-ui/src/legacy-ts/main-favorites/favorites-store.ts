export const FAVORITES_STORAGE_KEY = "kunpeng.reader.favorites.v1";
export const FAVORITES_CHANGED_EVENT = "kunpeng-reader:favorites-changed";

const FAVORITES_SCHEMA_VERSION = 1;
const MAX_FAVORITES = 500;
const MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

export type FavoriteKind = "booklist" | "news";

export interface BooklistFavoriteRecord {
  readonly kind: "booklist";
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewsFavoriteRecord {
  readonly kind: "news";
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly category: string;
  readonly url: string;
  readonly eventId?: string;
  readonly revision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type FavoriteRecord = BooklistFavoriteRecord | NewsFavoriteRecord;

export type FavoriteRecordInput =
  | Omit<BooklistFavoriteRecord, "createdAt" | "updatedAt"> & Partial<Pick<BooklistFavoriteRecord, "createdAt" | "updatedAt">>
  | Omit<NewsFavoriteRecord, "createdAt" | "updatedAt"> & Partial<Pick<NewsFavoriteRecord, "createdAt" | "updatedAt">>;

export interface FavoritesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FavoritesEventTarget {
  dispatchEvent(event: Event): boolean;
}

export interface FavoritesStoreOptions {
  readonly storage?: FavoritesStorage | null;
  readonly eventTarget?: FavoritesEventTarget | null;
  readonly now?: () => number;
}

interface StoredFavorites {
  readonly version: number;
  readonly items: readonly FavoriteRecord[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function safeHttpsUrl(value: unknown): string {
  const candidate = boundedText(value, 2_048);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    [...parsed.searchParams.keys()].forEach((key) => {
      if (/^utm_/iu.test(key) || [
        "fbclid", "gclid", "dclid", "mc_cid", "mc_eid",
        "token", "access_token", "api_key", "apikey", "auth", "authorization", "signature", "sig",
      ].includes(key.toLocaleLowerCase())) {
        parsed.searchParams.delete(key);
      }
    });
    parsed.searchParams.sort();
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeFavorite(value: unknown, now: number): FavoriteRecord | null {
  const candidate = record(value);
  const kind = candidate?.kind;
  const id = boundedText(candidate?.id, 240);
  const title = boundedText(candidate?.title, 500);
  if (!candidate || !id || !title || (kind !== "booklist" && kind !== "news")) return null;
  const createdAt = timestamp(candidate.createdAt, now);
  const updatedAt = timestamp(candidate.updatedAt, createdAt);
  if (kind === "booklist") {
    return {
      kind,
      id,
      title,
      description: boundedText(candidate.description, 1_000),
      createdAt,
      updatedAt,
    };
  }
  const revisionValue = Number(candidate.revision);
  const url = safeHttpsUrl(candidate.url);
  const eventId = boundedText(candidate.eventId, 240);
  if (!url && !eventId) return null;
  return {
    kind,
    id,
    title,
    summary: boundedText(candidate.summary, 1_200),
    source: boundedText(candidate.source, 240),
    publishedAt: boundedText(candidate.publishedAt, 100),
    category: boundedText(candidate.category, 120),
    url,
    ...(eventId ? { eventId } : {}),
    ...(Number.isInteger(revisionValue) && revisionValue >= 0 ? { revision: revisionValue } : {}),
    createdAt,
    updatedAt,
  };
}

function runtimeStorage(): FavoritesStorage | null {
  try {
    const storage = (globalThis as { readonly localStorage?: FavoritesStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function runtimeEventTarget(): FavoritesEventTarget | null {
  const target = globalThis as unknown as Partial<FavoritesEventTarget>;
  return typeof target.dispatchEvent === "function" ? target as FavoritesEventTarget : null;
}

function resolveOptions(options?: FavoritesStoreOptions): Required<Pick<FavoritesStoreOptions, "now">> & {
  readonly storage: FavoritesStorage | null;
  readonly eventTarget: FavoritesEventTarget | null;
} {
  return {
    storage: options?.storage === undefined ? runtimeStorage() : options.storage,
    eventTarget: options?.eventTarget === undefined ? runtimeEventTarget() : options.eventTarget,
    now: options?.now ?? Date.now,
  };
}

function readAll(options?: FavoritesStoreOptions): FavoriteRecord[] {
  const resolved = resolveOptions(options);
  if (!resolved.storage) return [];
  try {
    const parsed = record(JSON.parse(resolved.storage.getItem(FAVORITES_STORAGE_KEY) || "null"));
    if (parsed?.version !== FAVORITES_SCHEMA_VERSION || !Array.isArray(parsed.items)) return [];
    const now = resolved.now();
    const unique = new Map<string, FavoriteRecord>();
    parsed.items.forEach((item) => {
      const normalized = normalizeFavorite(item, now);
      if (normalized) unique.set(`${normalized.kind}:${normalized.id}`, normalized);
    });
    return [...unique.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function writeAll(items: readonly FavoriteRecord[], options?: FavoritesStoreOptions): boolean {
  const resolved = resolveOptions(options);
  if (!resolved.storage) return false;
  try {
    const boundedItems = items.slice(0, MAX_FAVORITES);
    let serialized = "";
    while (boundedItems.length >= 0) {
      const payload: StoredFavorites = { version: FAVORITES_SCHEMA_VERSION, items: boundedItems };
      serialized = JSON.stringify(payload);
      if (new TextEncoder().encode(serialized).byteLength <= MAX_SERIALIZED_BYTES || boundedItems.length === 0) break;
      boundedItems.pop();
    }
    resolved.storage.setItem(FAVORITES_STORAGE_KEY, serialized);
    resolved.eventTarget?.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function listFavorites(kind: "booklist", options?: FavoritesStoreOptions): BooklistFavoriteRecord[];
export function listFavorites(kind: "news", options?: FavoritesStoreOptions): NewsFavoriteRecord[];
export function listFavorites(kind?: undefined, options?: FavoritesStoreOptions): FavoriteRecord[];
export function listFavorites(kind: FavoriteKind | undefined, options?: FavoritesStoreOptions): FavoriteRecord[];
export function listFavorites(kind?: FavoriteKind, options?: FavoritesStoreOptions): FavoriteRecord[] {
  const items = readAll(options);
  return kind ? items.filter((item) => item.kind === kind) : items;
}

export function isFavorite(kind: FavoriteKind, id: string, options?: FavoritesStoreOptions): boolean {
  const normalizedId = boundedText(id, 240);
  return Boolean(normalizedId) && readAll(options).some((item) => item.kind === kind && item.id === normalizedId);
}

export function removeFavorite(kind: FavoriteKind, id: string, options?: FavoritesStoreOptions): boolean {
  const normalizedId = boundedText(id, 240);
  if (!normalizedId) return false;
  const items = readAll(options);
  const next = items.filter((item) => item.kind !== kind || item.id !== normalizedId);
  return next.length !== items.length && writeAll(next, options);
}

/** Returns the persisted state after the operation; a failed write keeps and reports the prior state. */
export function toggleFavorite(input: FavoriteRecordInput, options?: FavoritesStoreOptions): boolean {
  const resolved = resolveOptions(options);
  const now = resolved.now();
  const normalized = normalizeFavorite(input, now);
  if (!normalized) return false;
  const items = readAll({ ...options, storage: resolved.storage, eventTarget: resolved.eventTarget, now: resolved.now });
  const existingIndex = items.findIndex((item) => item.kind === normalized.kind && item.id === normalized.id);
  if (existingIndex >= 0) {
    items.splice(existingIndex, 1);
    return writeAll(items, { ...options, storage: resolved.storage, eventTarget: resolved.eventTarget, now: resolved.now }) ? false : true;
  }
  const next = [{ ...normalized, createdAt: now, updatedAt: now }, ...items];
  return writeAll(next, { ...options, storage: resolved.storage, eventTarget: resolved.eventTarget, now: resolved.now });
}
