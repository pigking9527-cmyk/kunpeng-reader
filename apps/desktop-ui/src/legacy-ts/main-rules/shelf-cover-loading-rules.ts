export const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24;
export const MAX_FIRST_SCREEN_COVER_COUNT = 160;

export interface CoverViewportOptions {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly layout?: unknown;
  readonly gridColumns?: unknown;
}

export interface CoverLoadPriority {
  readonly decoding: "sync" | "async";
  readonly fetchPriority: "high" | "auto";
  readonly loading: "eager" | "lazy";
}

export interface ShelfCoverLoadingRulesApi {
  coverLoadPriority(index: unknown, firstScreenCount: unknown): CoverLoadPriority;
  estimateFirstScreenCoverCount(options?: CoverViewportOptions): number;
  firstScreenCoverCount(options?: CoverViewportOptions): number;
}

const GRID_CARD_WIDTH = 158;
const GRID_GAP = 18;
const GRID_HORIZONTAL_PADDING = 40;
const GRID_CARD_ROW_HEIGHT = 208;
const LIST_CARD_ROW_HEIGHT = 108;
const GRID_VERTICAL_PADDING = 40;

function finiteDimension(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function fixedGridColumns(value: unknown): number {
  const columns = Number(value);
  return Number.isInteger(columns) && columns > 0 ? columns : 0;
}

export function estimateFirstScreenCoverCount(
  options: CoverViewportOptions = {},
): number {
  const width = finiteDimension(options.width);
  const height = finiteDimension(options.height);
  if (!width || !height) return 0;
  if (options.layout === "list") {
    return Math.max(1, Math.ceil(height / LIST_CARD_ROW_HEIGHT));
  }
  const columns =
    fixedGridColumns(options.gridColumns) ||
    Math.max(
      1,
      Math.floor(
        (Math.max(0, width - GRID_HORIZONTAL_PADDING) + GRID_GAP) /
          (GRID_CARD_WIDTH + GRID_GAP),
      ),
    );
  const rows = Math.max(
    1,
    Math.ceil(Math.max(0, height - GRID_VERTICAL_PADDING) / GRID_CARD_ROW_HEIGHT),
  );
  return Math.min(MAX_FIRST_SCREEN_COVER_COUNT, columns * rows);
}

export function firstScreenCoverCount(options: CoverViewportOptions = {}): number {
  return Math.max(
    DEFAULT_FIRST_SCREEN_COVER_COUNT,
    estimateFirstScreenCoverCount(options),
  );
}

export function coverLoadPriority(
  index: unknown,
  firstScreenCount: unknown,
): CoverLoadPriority {
  const eager = Number(index) >= 0 && Number(index) < Number(firstScreenCount);
  return eager
    ? Object.freeze({ decoding: "sync", fetchPriority: "high", loading: "eager" })
    : Object.freeze({ decoding: "async", fetchPriority: "auto", loading: "lazy" });
}

/** Classic installer replacing `ui/shelf-cover-loading-rules.js`. */
export function installShelfCoverLoadingRules(
  target: Record<string, unknown>,
): ShelfCoverLoadingRulesApi {
  const api = Object.freeze({
    coverLoadPriority,
    estimateFirstScreenCoverCount,
    firstScreenCoverCount,
  });
  target.ReaderShelfCoverLoadingRules = api;
  return api;
}
