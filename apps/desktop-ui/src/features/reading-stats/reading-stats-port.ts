/**
 * The only data boundary for the reading-statistics feature.
 *
 * A legacy adapter or a typed Tauri adapter may implement this port.  The
 * The feature layer deliberately does not know command names, browser storage or
 * globals, which also keeps it usable in a browser preview and unit tests.
 */
export interface ReadingStatsRangeRequest {
  /** Inclusive local-calendar date in YYYYMMDD form. */
  readonly from: number;
  /** Inclusive local-calendar date in YYYYMMDD form. */
  readonly to: number;
}

export interface ReadingStatsDay {
  readonly day: number;
  readonly seconds: number;
  readonly words: number;
}

export interface ReadingStatsBook {
  readonly id: number | string;
  readonly title: string;
  /** A host-provided, local cover URL. It is optional because old books lack covers. */
  readonly cover?: string;
  readonly seconds: number;
  readonly words: number;
  readonly highlights: number;
  readonly notes: number;
  readonly finished: boolean;
}

/** Mirrors the serialised shape returned by the existing `reading_stats_range` command. */
export interface ReadingStatsRange {
  readonly total_seconds: number;
  readonly total_words: number;
  readonly book_count: number;
  readonly finished_count: number;
  readonly total_highlights: number;
  readonly total_notes: number;
  readonly books: readonly ReadingStatsBook[];
  readonly days: readonly ReadingStatsDay[];
  /** 24 local-hour buckets for a day-range request. */
  readonly hours: readonly number[];
  /** 24 local-hour word buckets for a day-range request. */
  readonly hours_words: readonly number[];
}

export interface ReadingStatsPort {
  getRange(request: ReadingStatsRangeRequest, signal: AbortSignal): Promise<ReadingStatsRange>;
}
