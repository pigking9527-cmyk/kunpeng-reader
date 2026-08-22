import type { ShelfBook, ShelfBookId } from "./shelf-port.js";

export const SHELF_SORT_KEYS = [
  "title",
  "author",
  "added",
  "last-read",
  "reading-time",
  "progress",
  "rating",
  "size",
] as const;

export type ShelfSortKey = (typeof SHELF_SORT_KEYS)[number];
export type ShelfReadingFilter = "unread" | "reading" | "finished";
export type OrganizationMatchMode = "any" | "all";

export interface ShelfFilters {
  readonly query: string;
  readonly reading: ReadonlySet<ShelfReadingFilter>;
  readonly minimumRating: number;
  readonly tags: ReadonlySet<string>;
  readonly collections: ReadonlySet<string>;
  readonly organizationMatch: OrganizationMatchMode;
}

export const DEFAULT_SHELF_FILTERS: ShelfFilters = Object.freeze({
  query: "",
  reading: new Set<ShelfReadingFilter>(["unread", "reading", "finished"]),
  minimumRating: 0,
  tags: new Set<string>(),
  collections: new Set<string>(),
  organizationMatch: "any",
});

export interface ShelfOrganizationEntry {
  readonly key: string;
  readonly name: string;
  readonly count: number;
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN");
}

export function organizationKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function cleanOrganizationName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

export function readingStatus(book: ShelfBook): ShelfReadingFilter {
  const progress = Math.min(1, Math.max(0, book.progress ?? 0));
  if (progress >= 1) return "finished";
  return progress > 0 ? "reading" : "unread";
}

export function matchesOrganization(
  book: ShelfBook,
  tags: ReadonlySet<string>,
  collections: ReadonlySet<string>,
  mode: OrganizationMatchMode,
): boolean {
  if (tags.size === 0 && collections.size === 0) return true;
  const bookTags = new Set(book.tags.map(organizationKey));
  const bookCollections = new Set(book.collections.map(organizationKey));
  if (mode === "all") {
    return [...tags].every((key) => bookTags.has(key))
      && [...collections].every((key) => bookCollections.has(key));
  }
  return [...tags].some((key) => bookTags.has(key))
    || [...collections].some((key) => bookCollections.has(key));
}

/** Search intentionally has legacy precedence over all funnel filters. */
export function filterShelfBooks(books: readonly ShelfBook[], filters: ShelfFilters): readonly ShelfBook[] {
  const query = normalizedText(filters.query);
  if (query) {
    return books.filter((book) => [book.title, book.author, book.description]
      .some((value) => normalizedText(value).includes(query)));
  }
  return books.filter((book) => (
    filters.reading.has(readingStatus(book))
    && (book.rating ?? 0) >= filters.minimumRating
    && matchesOrganization(book, filters.tags, filters.collections, filters.organizationMatch)
  ));
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "", "zh-CN");
}

function compareNumberDescending(left: number | undefined, right: number | undefined): number {
  return (right ?? 0) - (left ?? 0);
}

export function sortShelfBooks(books: readonly ShelfBook[], key: ShelfSortKey): readonly ShelfBook[] {
  return [...books].sort((left, right) => {
    const title = (): number => compareText(left.title, right.title);
    switch (key) {
      case "author": return compareText(left.author, right.author) || title();
      case "added": return compareNumberDescending(left.addedAt, right.addedAt) || title();
      case "last-read": return compareNumberDescending(left.lastReadAt, right.lastReadAt) || title();
      case "reading-time": return compareNumberDescending(left.readingSeconds, right.readingSeconds) || title();
      case "progress": return compareNumberDescending(left.progress, right.progress) || title();
      case "rating": return compareNumberDescending(left.rating, right.rating) || title();
      case "size": return compareNumberDescending(left.fileSizeBytes, right.fileSizeBytes) || title();
      case "title": return title();
    }
  });
}

export function organizationEntries(
  books: readonly ShelfBook[],
  field: "tags" | "collections",
): readonly ShelfOrganizationEntry[] {
  const entries = new Map<string, ShelfOrganizationEntry>();
  for (const book of books) {
    for (const raw of book[field]) {
      const name = cleanOrganizationName(raw);
      const key = organizationKey(name);
      if (!key) continue;
      const previous = entries.get(key);
      entries.set(key, previous ? { ...previous, count: previous.count + 1 } : { key, name, count: 1 });
    }
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function selectedBookIds(
  selected: ReadonlySet<ShelfBookId>,
  available: readonly ShelfBook[],
): readonly ShelfBookId[] {
  const availableIds = new Set(available.map((book) => book.id));
  return [...selected].filter((id) => availableIds.has(id));
}

export function safeCoverUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(trimmed)) return trimmed;
  try {
    // The host supplies an already-resolved local/remote image URL. Refusing
    // relative strings keeps this pure module independent of browser globals.
    const url = new URL(trimmed);
    return url.protocol === "https:"
      || url.protocol === "http:"
      || url.protocol === "blob:"
      || (url.protocol === "reader:" && url.hostname === "localhost")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
