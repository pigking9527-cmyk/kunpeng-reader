export const GRID_COL_MIN = 1;
export const GRID_COL_MAX = 12;

const PALETTE: readonly [string, ...string[]] = Object.freeze([
  "#3e5a8c",
  "#8c4650",
  "#46785f",
  "#82643c",
  "#5f5082",
  "#3c6e78",
  "#78556e",
  "#5a6446",
]);

export interface ShelfBook {
  readonly id?: string | number;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly cover?: string;
  readonly path?: string;
  readonly initial?: string;
  readonly progress?: number;
  readonly rating?: number;
  readonly missing?: boolean;
  readonly added_at?: number;
  readonly last_read_at?: number;
  readonly reading_seconds?: number;
  readonly tags?: readonly string[];
  readonly collections?: readonly string[];
}

export type ReadStatus = "unread" | "reading" | "done";
export type ShelfSortKey =
  | "title"
  | "author"
  | "added"
  | "dir"
  | "read"
  | "reading-time"
  | "size"
  | "progress";

export const SHELF_SORT_MIGRATION_REVISION = "recent-read-default-v2";

export interface ShelfSortPreferenceResolution {
  readonly sortKey: ShelfSortKey;
  readonly revision: typeof SHELF_SORT_MIGRATION_REVISION;
  readonly shouldPersist: boolean;
}

export interface ShelfPrimaryPointerOpenInput {
  readonly singleClickOpensBook: boolean;
  readonly pointerType: string;
  readonly button: number;
  readonly isPrimary: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly hasSelection: boolean;
}

export interface ShelfFilters {
  readonly searchQuery: string;
  readonly minRating: number;
  readonly tagFilter: ReadonlySet<string>;
  readonly collectionFilter: ReadonlySet<string>;
  readonly organizationMatchMode: "all" | "any";
  readonly readingFilter: Readonly<Record<ReadStatus, boolean>>;
}

export interface ScrollbarGeometryInput {
  readonly viewport?: number;
  readonly total?: number;
  readonly trackHeight?: number;
  readonly scrollTop?: number;
  readonly minThumbHeight?: number;
}

export type ScrollbarGeometry =
  | Readonly<{ visible: false }>
  | Readonly<{
      visible: true;
      maxScroll: number;
      maxTop: number;
      thumbHeight: number;
      top: number;
    }>;

export interface ScrollbarPointerInput {
  readonly trackHeight?: number;
  readonly thumbHeight?: number;
  readonly total?: number;
  readonly viewport?: number;
  readonly clientY?: number;
  readonly rectTop?: number;
  readonly dragStartScrollTop?: number;
  readonly dragStartY?: number;
}

export function parseGridColumns(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(GRID_COL_MIN, Math.min(GRID_COL_MAX, parsed));
}

export function organizationName(value: unknown): string {
  return String(value ?? "").trim();
}

export function organizationKey(value: unknown): string {
  return organizationName(value).toLocaleLowerCase("zh-CN");
}

export function readStatus(book: ShelfBook): ReadStatus {
  const progress = book.progress ?? 0;
  if (progress >= 99) return "done";
  if (progress < 1) return "unread";
  return "reading";
}

export function colorFor(title: unknown): string {
  let hash = 2166136261;
  const text = String(title ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0];
}

export function bookRenderKey(
  book: ShelfBook,
  options: Readonly<{ showCoverProgress?: boolean; showCoverRating?: boolean }> = {},
): string {
  return [
    book.id ?? "",
    book.title ?? "",
    book.cover ?? "",
    book.progress ?? 0,
    book.rating ?? 0,
    book.missing ? 1 : 0,
    options.showCoverProgress ? 1 : 0,
    options.showCoverRating ? 1 : 0,
  ].join("\u001f");
}

function title(book: ShelfBook): string {
  return book.title ?? "";
}

const SHELF_SORT_KEYS: ReadonlySet<string> = new Set<ShelfSortKey>([
  "title",
  "author",
  "added",
  "dir",
  "read",
  "reading-time",
  "size",
  "progress",
]);

function shelfSortKey(value: unknown): ShelfSortKey | null {
  return typeof value === "string" && SHELF_SORT_KEYS.has(value)
    ? (value as ShelfSortKey)
    : null;
}

/**
 * Applies the product's recent-reading order to existing shelves exactly once. The shell owns
 * storage and should persist both `sortKey` and `revision` when
 * `shouldPersist` is true. Once the revision is current, an explicit title or
 * other supported sort remains a user preference and is never rewritten.
 */
export function resolveShelfSortPreference(
  storedSortKey: unknown,
  storedRevision: unknown,
): ShelfSortPreferenceResolution {
  const parsedSortKey = shelfSortKey(storedSortKey);
  const migrationPending = storedRevision !== SHELF_SORT_MIGRATION_REVISION;
  if (migrationPending) {
    return Object.freeze({
      revision: SHELF_SORT_MIGRATION_REVISION,
      shouldPersist: true,
      sortKey: "read",
    });
  }
  return Object.freeze({
    revision: SHELF_SORT_MIGRATION_REVISION,
    shouldPersist: parsedSortKey === null,
    sortKey: parsedSortKey ?? "read",
  });
}

export function shouldOpenBookOnPrimaryPointerDown(
  input: ShelfPrimaryPointerOpenInput,
): boolean {
  return (
    input.singleClickOpensBook &&
    input.pointerType === "mouse" &&
    input.button === 0 &&
    input.isPrimary &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.hasSelection
  );
}

export function sortBooks(
  list: readonly ShelfBook[],
  options: Readonly<{
    sortKey?: ShelfSortKey;
    bookFileSizes?: ReadonlyMap<string, number>;
  }> = {},
): ShelfBook[] {
  const sortKey = options.sortKey ?? "read";
  const bookFileSizes = options.bookFileSizes ?? new Map<string, number>();
  const result = list.slice();
  result.sort((left, right) => {
    switch (sortKey) {
      case "author":
        return (
          (left.author ?? "").localeCompare(right.author ?? "", "zh") ||
          title(left).localeCompare(title(right), "zh")
        );
      case "added":
        return (right.added_at ?? 0) - (left.added_at ?? 0);
      case "dir":
        return (left.path ?? "").localeCompare(right.path ?? "", "zh");
      case "read":
        return (
          (right.last_read_at ?? 0) - (left.last_read_at ?? 0) ||
          title(left).localeCompare(title(right), "zh")
        );
      case "reading-time":
        return (
          (right.reading_seconds ?? 0) - (left.reading_seconds ?? 0) ||
          title(left).localeCompare(title(right), "zh")
        );
      case "size":
        return (
          (bookFileSizes.get(String(right.id)) ?? 0) -
            (bookFileSizes.get(String(left.id)) ?? 0) ||
          title(left).localeCompare(title(right), "zh")
        );
      case "progress":
        return (
          (right.progress ?? 0) - (left.progress ?? 0) ||
          title(left).localeCompare(title(right), "zh")
        );
      default: {
        const leftInitial =
          !left.initial || left.initial === "#" ? "~" : left.initial;
        const rightInitial =
          !right.initial || right.initial === "#" ? "~" : right.initial;
        return (
          leftInitial.localeCompare(rightInitial) ||
          title(left).localeCompare(title(right), "zh")
        );
      }
    }
  });
  return result;
}

export function matchesShelfSearch(
  book: ShelfBook,
  searchQuery: string,
): boolean {
  if (!searchQuery) return true;
  return (
    (book.title ?? "").toLowerCase().includes(searchQuery) ||
    (book.author ?? "").toLowerCase().includes(searchQuery) ||
    (book.description ?? "").toLowerCase().includes(searchQuery)
  );
}

export function hasActiveShelfFilters(filters: ShelfFilters): boolean {
  return (
    filters.minRating > 0 ||
    filters.tagFilter.size > 0 ||
    filters.collectionFilter.size > 0 ||
    !(
      filters.readingFilter.unread &&
      filters.readingFilter.reading &&
      filters.readingFilter.done
    )
  );
}

export function matchesOrganizationSelection(
  book: ShelfBook,
  selectedTags: ReadonlySet<string>,
  selectedCollections: ReadonlySet<string>,
  mode: "all" | "any",
): boolean {
  if (!selectedTags.size && !selectedCollections.size) return true;
  const bookTags = new Set((book.tags ?? []).map(organizationKey));
  const bookCollections = new Set(
    (book.collections ?? []).map(organizationKey),
  );
  if (mode === "all") {
    return (
      Array.from(selectedTags).every((key) => bookTags.has(key)) &&
      Array.from(selectedCollections).every((key) => bookCollections.has(key))
    );
  }
  return (
    Array.from(selectedTags).some((key) => bookTags.has(key)) ||
    Array.from(selectedCollections).some((key) => bookCollections.has(key))
  );
}

export function matchesOrganizationFilters(
  book: ShelfBook,
  filters: ShelfFilters,
): boolean {
  return matchesOrganizationSelection(
    book,
    filters.tagFilter,
    filters.collectionFilter,
    filters.organizationMatchMode,
  );
}

export function currentList(
  books: readonly ShelfBook[],
  filters: ShelfFilters,
): ShelfBook[] {
  if (filters.searchQuery) {
    return books.filter((book) => matchesShelfSearch(book, filters.searchQuery));
  }
  let result = books.slice();
  if (
    !(
      filters.readingFilter.unread &&
      filters.readingFilter.reading &&
      filters.readingFilter.done
    )
  ) {
    result = result.filter((book) => filters.readingFilter[readStatus(book)]);
  }
  if (filters.minRating > 0) {
    result = result.filter((book) => (book.rating ?? 0) >= filters.minRating);
  }
  return result.filter((book) => matchesOrganizationFilters(book, filters));
}

export function scrollbarGeometry(
  options: ScrollbarGeometryInput = {},
): ScrollbarGeometry {
  const viewport = Number(options.viewport) || 0;
  const total = Number(options.total) || 0;
  const trackHeight = Number(options.trackHeight) || 0;
  const scrollTop = Number(options.scrollTop) || 0;
  const minThumbHeight = Number(options.minThumbHeight) || 28;
  const maxScroll = Math.max(0, total - viewport);
  if (viewport <= 0 || maxScroll <= 1) return Object.freeze({ visible: false });
  const thumbHeight = Math.max(
    minThumbHeight,
    Math.round((viewport / total) * trackHeight),
  );
  const maxTop = Math.max(0, trackHeight - thumbHeight);
  return Object.freeze({
    maxScroll,
    maxTop,
    thumbHeight,
    top: maxScroll ? Math.round((scrollTop / maxScroll) * maxTop) : 0,
    visible: true,
  });
}

export function scrollbarTrackScrollTop(
  options: ScrollbarPointerInput = {},
): number {
  const trackHeight = Number(options.trackHeight) || 0;
  const thumbHeight = Number(options.thumbHeight) || 0;
  const maxTop = Math.max(1, trackHeight - thumbHeight);
  const maxScroll = Math.max(
    1,
    (Number(options.total) || 0) - (Number(options.viewport) || 0),
  );
  const targetTop = Math.min(
    maxTop,
    Math.max(
      0,
      (Number(options.clientY) || 0) -
        (Number(options.rectTop) || 0) -
        thumbHeight / 2,
    ),
  );
  return (targetTop / maxTop) * maxScroll;
}

export function scrollbarDragScrollTop(
  options: ScrollbarPointerInput = {},
): number {
  const maxTop = Math.max(
    1,
    (Number(options.trackHeight) || 0) - (Number(options.thumbHeight) || 0),
  );
  const maxScroll = Math.max(
    1,
    (Number(options.total) || 0) - (Number(options.viewport) || 0),
  );
  return (
    (Number(options.dragStartScrollTop) || 0) +
    (((Number(options.clientY) || 0) - (Number(options.dragStartY) || 0)) /
      maxTop) *
      maxScroll
  );
}

export const shelfUiRules = Object.freeze({
  bookRenderKey,
  colorFor,
  currentList,
  hasActiveShelfFilters,
  matchesOrganizationSelection,
  organizationKey,
  organizationName,
  parseGridColumns,
  readStatus,
  resolveShelfSortPreference,
  shouldOpenBookOnPrimaryPointerDown,
  scrollbarDragScrollTop,
  scrollbarGeometry,
  scrollbarTrackScrollTop,
  sortBooks,
});

export type ShelfUiRulesApi = typeof shelfUiRules;

export function installShelfUiRules(target: Record<string, unknown>): ShelfUiRulesApi {
  target.ReaderShelfRules = shelfUiRules;
  return shelfUiRules;
}
