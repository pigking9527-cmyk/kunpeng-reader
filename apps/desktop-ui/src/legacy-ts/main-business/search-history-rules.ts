export interface CommonSearchEntry {
  readonly count?: unknown;
  readonly last?: unknown;
}

export type CommonSearches = Readonly<Record<string, CommonSearchEntry | unknown>>;

export interface RecordedSearchQuery {
  readonly history: string[];
  readonly common: Record<string, CommonSearchEntry | unknown>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function entry(value: unknown): CommonSearchEntry {
  return objectRecord(value);
}

export function normalizedSearchTerm(value: unknown): string {
  return String(value || "").trim();
}

export function recordSearchQuery(
  history: readonly string[] | unknown,
  common: CommonSearches | unknown,
  query: unknown,
  now: number,
  maxHistory: number,
): RecordedSearchQuery {
  const term = normalizedSearchTerm(query);
  const limit = Number.isInteger(maxHistory) && maxHistory > 0 ? maxHistory : 12;
  const entries = Array.isArray(history) ? (history as string[]) : [];
  const counts = objectRecord(common);
  if (!term) {
    return { history: entries.slice(0, limit), common: { ...counts } };
  }

  const previous = entry(counts[term]);
  return {
    history: [term, ...entries.filter((item) => item !== term)].slice(0, limit),
    common: {
      ...counts,
      [term]: {
        count: (Number(previous.count) || 0) + 1,
        last: Number.isFinite(now) ? now : 0,
      },
    },
  };
}

export function removeSearchQuery(
  history: readonly string[] | unknown,
  query: unknown,
): string[] {
  const term = normalizedSearchTerm(query);
  return (Array.isArray(history) ? (history as string[]) : []).filter(
    (item) => item !== term,
  );
}

export function commonSearches(
  common: CommonSearches | unknown,
  limit: number,
): Array<Readonly<{ query: string; count: number }>> {
  const maximum = Number.isInteger(limit) && limit >= 0 ? limit : 6;
  return Object.entries(objectRecord(common))
    .sort((left, right) => {
      const leftEntry = entry(left[1]);
      const rightEntry = entry(right[1]);
      return (
        (Number(rightEntry.count) || 0) - (Number(leftEntry.count) || 0) ||
        (Number(rightEntry.last) || 0) - (Number(leftEntry.last) || 0)
      );
    })
    .slice(0, maximum)
    .map(([query, value]) => ({
      count: Number(entry(value).count) || 0,
      query,
    }));
}

export const searchHistoryRules = Object.freeze({
  commonSearches,
  normalizedSearchTerm,
  recordSearchQuery,
  removeSearchQuery,
});

export type SearchHistoryRulesApi = typeof searchHistoryRules;

export function installSearchHistoryRules(
  target: Record<string, unknown>,
): SearchHistoryRulesApi {
  target.ReaderSearchHistoryRules = searchHistoryRules;
  return searchHistoryRules;
}
