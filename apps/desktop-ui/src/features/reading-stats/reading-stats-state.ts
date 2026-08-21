import type { ReadingStatsDay, ReadingStatsRange, ReadingStatsRangeRequest } from "./reading-stats-port.js";

export const READING_STATS_SCOPES = ["day", "week", "month", "year", "total"] as const;
export type ReadingStatsScope = (typeof READING_STATS_SCOPES)[number];
export type ReadingStatsMetric = "time" | "words";
export type ReadingStatsChartStyle = "bar" | "line";
export const READING_STATS_HEATMAP_THEMES = ["green", "blue", "orange"] as const;
export type ReadingStatsHeatmapTheme = (typeof READING_STATS_HEATMAP_THEMES)[number];

export const READING_STATS_CARD_KEYS = [
  "duration",
  "words",
  "speed",
  "books",
  "finished",
  "highlights",
  "notes",
] as const;
export type ReadingStatsCardKey = (typeof READING_STATS_CARD_KEYS)[number];

export interface ReadingStatsPreferences {
  readonly metric: ReadingStatsMetric;
  readonly chartStyle: ReadingStatsChartStyle;
  readonly heatmapTheme: ReadingStatsHeatmapTheme;
  readonly visibleCards: Readonly<Record<ReadingStatsCardKey, boolean>>;
}

export const DEFAULT_READING_STATS_PREFERENCES: ReadingStatsPreferences = Object.freeze({
  metric: "time",
  chartStyle: "bar",
  heatmapTheme: "green",
  visibleCards: Object.freeze({
    duration: true,
    words: true,
    speed: true,
    books: true,
    finished: true,
    highlights: true,
    notes: true,
  }),
});

export type ReadingStatsPhase = "idle" | "loading" | "ready" | "empty" | "error" | "cancelled";

export interface ReadingStatsState {
  readonly scope: ReadingStatsScope;
  readonly anchor: Date;
  readonly now: Date;
  readonly requestId: number;
  readonly phase: ReadingStatsPhase;
  readonly range: ReadingStatsRange | null;
  readonly all: ReadingStatsRange | null;
  readonly preferences: ReadingStatsPreferences;
}

function atLocalMidnight(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function ymd(value: Date): number {
  return value.getFullYear() * 10000 + (value.getMonth() + 1) * 100 + value.getDate();
}

export function dateFromYmd(value: number): Date | null {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (!Number.isInteger(value) || year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function addDays(date: Date, days: number): Date {
  const result = atLocalMidnight(date);
  result.setDate(result.getDate() + days);
  return result;
}

function mondayOfWeek(date: Date): Date {
  const day = atLocalMidnight(date);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

export function normalizeAnchor(scope: ReadingStatsScope, date: Date): Date {
  const value = atLocalMidnight(date);
  if (scope === "week") return mondayOfWeek(value);
  if (scope === "month") return new Date(value.getFullYear(), value.getMonth(), 1);
  if (scope === "year") return new Date(value.getFullYear(), 0, 1);
  return value;
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function rangeForScope(scope: ReadingStatsScope, anchor: Date): ReadingStatsRangeRequest {
  const normalized = normalizeAnchor(scope, anchor);
  if (scope === "total") return { from: 0, to: 99_999_999 };
  if (scope === "week") return { from: ymd(normalized), to: ymd(addDays(normalized, 6)) };
  if (scope === "month") return { from: ymd(normalized), to: ymd(endOfMonth(normalized)) };
  if (scope === "year") {
    return {
      from: normalized.getFullYear() * 10_000 + 101,
      to: normalized.getFullYear() * 10_000 + 1231,
    };
  }
  return { from: ymd(normalized), to: ymd(normalized) };
}

export function stepAnchor(scope: ReadingStatsScope, anchor: Date, direction: -1 | 1): Date {
  const current = normalizeAnchor(scope, anchor);
  if (scope === "day") return addDays(current, direction);
  if (scope === "week") return addDays(current, direction * 7);
  if (scope === "month") return new Date(current.getFullYear(), current.getMonth() + direction, 1);
  if (scope === "year") return new Date(current.getFullYear() + direction, 0, 1);
  return current;
}

export function earliestReadingDate(days: readonly ReadingStatsDay[]): Date | null {
  const earliest = days.reduce<number | null>((current, entry) => (
    current === null || entry.day < current ? entry.day : current
  ), null);
  return earliest === null ? null : dateFromYmd(earliest);
}

export function canNavigate(
  scope: ReadingStatsScope,
  anchor: Date,
  direction: -1 | 1,
  earliest: Date | null,
  now: Date,
): boolean {
  if (scope === "total") return false;
  const candidate = stepAnchor(scope, anchor, direction).getTime();
  if (direction < 0) return earliest !== null && candidate >= normalizeAnchor(scope, earliest).getTime();
  return candidate <= normalizeAnchor(scope, now).getTime();
}

export interface ReadingStatsBar {
  readonly label: string;
  readonly value: number;
}

function safeNumber(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, value) : 0;
}

export function barsForRange(
  scope: ReadingStatsScope,
  anchor: Date,
  range: ReadingStatsRange,
  metric: ReadingStatsMetric,
): readonly ReadingStatsBar[] {
  if (scope === "day") {
    const source = metric === "words" ? range.hours_words : range.hours;
    return Array.from({ length: 24 }, (_, hour) => ({ label: `${hour}:00`, value: safeNumber(source[hour]) }));
  }

  const valuesByDay = new Map<number, number>();
  for (const day of range.days) {
    valuesByDay.set(day.day, metric === "words" ? safeNumber(day.words) : safeNumber(day.seconds));
  }
  const normalized = normalizeAnchor(scope, anchor);
  if (scope === "week") {
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(normalized, index);
      return { label: `${date.getMonth() + 1}/${date.getDate()}`, value: valuesByDay.get(ymd(date)) ?? 0 };
    });
  }
  if (scope === "month") {
    const count = endOfMonth(normalized).getDate();
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(normalized.getFullYear(), normalized.getMonth(), index + 1);
      return { label: String(index + 1), value: valuesByDay.get(ymd(date)) ?? 0 };
    });
  }
  if (scope === "year") {
    const values = new Array<number>(12).fill(0);
    for (const day of range.days) {
      const date = dateFromYmd(day.day);
      if (date?.getFullYear() === normalized.getFullYear()) {
        const month = date.getMonth();
        values[month] = (values[month] ?? 0) + (metric === "words" ? safeNumber(day.words) : safeNumber(day.seconds));
      }
    }
    return values.map((value, index) => ({ label: `${index + 1}月`, value }));
  }

  const values = new Map<number, number>();
  for (const day of range.days) {
    const year = Math.floor(day.day / 10_000);
    const current = values.get(year) ?? 0;
    values.set(year, current + (metric === "words" ? safeNumber(day.words) : safeNumber(day.seconds)));
  }
  return [...values.entries()].sort(([left], [right]) => left - right).map(([year, value]) => ({ label: String(year), value }));
}

export interface ReadingStreak {
  readonly current: number;
  readonly longest: number;
}

export function readingStreak(days: readonly ReadingStatsDay[], now: Date): ReadingStreak {
  const active = new Set(days.filter((day) => safeNumber(day.seconds) > 0).map((day) => day.day));
  let current = 0;
  for (let date = atLocalMidnight(now); active.has(ymd(date)); date = addDays(date, -1)) current += 1;
  const sorted = [...active].sort((left, right) => left - right);
  let longest = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const value of sorted) {
    const date = dateFromYmd(value);
    if (date === null) continue;
    run = previous !== null && addDays(previous, 1).getTime() === date.getTime() ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return { current, longest };
}

export function contributionLevel(seconds: number): 0 | 1 | 2 | 3 | 4 {
  if (seconds <= 0) return 0;
  if (seconds < 20 * 60) return 1;
  if (seconds < 40 * 60) return 2;
  if (seconds < 60 * 60) return 3;
  return 4;
}

export function normalizePreferences(
  preferences: Partial<ReadingStatsPreferences> | undefined,
): ReadingStatsPreferences {
  const candidate = preferences ?? {};
  const visible = candidate.visibleCards ?? DEFAULT_READING_STATS_PREFERENCES.visibleCards;
  return {
    metric: candidate.metric === "words" ? "words" : "time",
    chartStyle: candidate.chartStyle === "line" ? "line" : "bar",
    heatmapTheme: candidate.heatmapTheme === "blue" || candidate.heatmapTheme === "orange" ? candidate.heatmapTheme : "green",
    visibleCards: {
      duration: visible.duration !== false,
      words: visible.words !== false,
      speed: visible.speed !== false,
      books: visible.books !== false,
      finished: visible.finished !== false,
      highlights: visible.highlights !== false,
      notes: visible.notes !== false,
    },
  };
}

export function createReadingStatsState(
  now: Date = new Date(),
  preferences?: Partial<ReadingStatsPreferences>,
): ReadingStatsState {
  return {
    scope: "day",
    anchor: atLocalMidnight(now),
    now: atLocalMidnight(now),
    requestId: 0,
    phase: "idle",
    range: null,
    all: null,
    preferences: normalizePreferences(preferences),
  };
}

export type ReadingStatsAction =
  | { readonly type: "select-scope"; readonly scope: ReadingStatsScope }
  | { readonly type: "step"; readonly direction: -1 | 1 }
  | { readonly type: "load-started"; readonly requestId: number }
  | { readonly type: "load-succeeded"; readonly requestId: number; readonly range: ReadingStatsRange; readonly all: ReadingStatsRange }
  | { readonly type: "load-failed"; readonly requestId: number }
  | { readonly type: "load-cancelled"; readonly requestId: number }
  | { readonly type: "set-preferences"; readonly preferences: Partial<ReadingStatsPreferences> };

function isEmptyRange(range: ReadingStatsRange): boolean {
  return range.total_seconds <= 0 && range.total_words <= 0 && range.books.length === 0;
}

export function readingStatsReducer(state: ReadingStatsState, action: ReadingStatsAction): ReadingStatsState {
  switch (action.type) {
    case "select-scope":
      return { ...state, scope: action.scope, anchor: normalizeAnchor(action.scope, state.anchor), phase: "idle" };
    case "step":
      return { ...state, anchor: stepAnchor(state.scope, state.anchor, action.direction), phase: "idle" };
    case "load-started":
      return { ...state, requestId: action.requestId, phase: "loading" };
    case "load-succeeded":
      if (action.requestId !== state.requestId) return state;
      return { ...state, range: action.range, all: action.all, phase: isEmptyRange(action.range) ? "empty" : "ready" };
    case "load-failed":
      return action.requestId === state.requestId ? { ...state, phase: "error" } : state;
    case "load-cancelled":
      return action.requestId === state.requestId ? { ...state, phase: "cancelled" } : state;
    case "set-preferences":
      return { ...state, preferences: normalizePreferences({ ...state.preferences, ...action.preferences }) };
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
