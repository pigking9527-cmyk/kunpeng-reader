export type StatsScope = "day" | "month" | "year" | "total";
export type StatsRange = readonly [number, number];

export interface StatsNavigation {
  readonly earliest: Date | null;
  readonly latest: Date;
  readonly showNavigation: boolean;
  readonly previousDisabled: boolean;
  readonly nextDisabled: boolean;
}

export function ymd(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function dateFromYmd(value: number): Date {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  return new Date(year, month - 1, day);
}

export function addDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + amount);
  return result;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function range(scope: StatsScope, anchor: Date): StatsRange {
  const date = new Date(anchor.getTime());
  const year = date.getFullYear();
  const month = date.getMonth();
  if (scope === "day") {
    const value = ymd(date);
    return [value, value];
  }
  if (scope === "month") {
    return [
      year * 10000 + (month + 1) * 100 + 1,
      year * 10000 + (month + 1) * 100 + 31,
    ];
  }
  if (scope === "year") return [year * 10000 + 101, year * 10000 + 1231];
  return [0, 99999999];
}

export function normalizeAnchor(date: Date, scope: StatsScope): Date {
  const value = new Date(date.getTime());
  if (scope === "month") return new Date(value.getFullYear(), value.getMonth(), 1);
  if (scope === "year") return new Date(value.getFullYear(), 0, 1);
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function firstAnchor(
  firstReadingDay: number | null | undefined,
  scope: StatsScope,
): Date | null {
  return firstReadingDay
    ? normalizeAnchor(dateFromYmd(firstReadingDay), scope)
    : null;
}

export function lastAnchor(now: Date, scope: StatsScope): Date {
  return normalizeAnchor(now, scope);
}

export function compareAnchors(first: Date, second: Date): number {
  return first.getTime() - second.getTime();
}

export function steppedAnchor(
  scope: StatsScope,
  anchor: Date,
  direction: number,
): Date {
  const current = normalizeAnchor(anchor, scope);
  if (scope === "day") return addDays(current, direction);
  if (scope === "month") {
    return new Date(current.getFullYear(), current.getMonth() + direction, 1);
  }
  if (scope === "year") {
    return new Date(current.getFullYear() + direction, 0, 1);
  }
  return current;
}

export function navigation(
  scope: StatsScope,
  anchor: Date,
  firstReadingDay: number | null | undefined,
  now: Date,
): StatsNavigation {
  const showNavigation = scope !== "total";
  const earliest = firstAnchor(firstReadingDay, scope);
  const latest = lastAnchor(now, scope);
  const current = normalizeAnchor(anchor, scope);
  return {
    earliest,
    latest,
    showNavigation,
    previousDisabled:
      !showNavigation || !earliest || compareAnchors(current, earliest) <= 0,
    nextDisabled:
      !showNavigation || compareAnchors(current, latest) >= 0,
  };
}

export function canStep(
  scope: StatsScope,
  anchor: Date,
  direction: number,
  firstReadingDay: number | null | undefined,
  now: Date,
): boolean {
  if (scope === "total") return false;
  const candidate = steppedAnchor(scope, anchor, direction);
  const state = navigation(scope, anchor, firstReadingDay, now);
  if (direction < 0) {
    return Boolean(state.earliest) &&
      state.earliest !== null &&
      compareAnchors(candidate, state.earliest) >= 0;
  }
  if (direction > 0) return compareAnchors(candidate, state.latest) <= 0;
  return false;
}

export const statsRules = Object.freeze({
  addDays,
  canStep,
  compareAnchors,
  dateFromYmd,
  daysInMonth,
  firstAnchor,
  lastAnchor,
  navigation,
  normalizeAnchor,
  range,
  steppedAnchor,
  ymd,
});

export type StatsRulesApi = typeof statsRules;

export function installStatsRules(target: Record<string, unknown>): StatsRulesApi {
  target.ReaderStatsRules = statsRules;
  return statsRules;
}
