import type {
  NewsGestureAction,
  NewsGesturePoint,
  NewsGestureProfile,
  NewsGestureScope,
  NewsItem,
  NewsLayout,
  NewsOrder,
  NewsPreferences,
  NewsSource,
} from "./news-port.js";

export const MAX_TIEBA_BARS = 8;
export const MAX_GESTURE_PROFILES = 24;
export const GESTURE_SAMPLE_COUNT = 48;
export const MIN_GESTURE_LENGTH = 32;

export function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function safeImageDataUrl(value: string | undefined): string | null {
  return value && /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/i.test(value.trim())
    ? value.trim()
    : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normaliseSourceIds(values: readonly string[], catalog: readonly NewsSource[]): string[] {
  const allowed = new Set(catalog.map((source) => source.id));
  return unique(values).filter((value) => allowed.has(value));
}

export function defaultSourceIds(catalog: readonly NewsSource[]): string[] {
  return normaliseSourceIds(catalog.filter((source) => source.defaultEnabled).map((source) => source.id), catalog);
}

export function normaliseTiebaBars(values: readonly string[]): string[] {
  return unique(values.map((value) => value.replace(/吧$/u, "").trim()))
    .filter((value) => value.length <= 48 && !/[\u0000-\u001f\u007f]/u.test(value))
    .slice(0, MAX_TIEBA_BARS);
}

export function normaliseEnabledTiebaBars(values: readonly string[], bars: readonly string[]): string[] {
  const allowed = new Set(normaliseTiebaBars(bars));
  return normaliseTiebaBars(values).filter((value) => allowed.has(value));
}

export function normalisePreferences(
  preferences: NewsPreferences,
  catalog: readonly NewsSource[],
): NewsPreferences {
  const bars = normaliseTiebaBars(preferences.tiebaBars);
  const enabledTiebaBars = normaliseEnabledTiebaBars(preferences.enabledTiebaBars, bars);
  const withoutTieba = normaliseSourceIds(preferences.sourceIds.filter((id) => id !== "tieba"), catalog);
  const sourceIds = enabledTiebaBars.length > 0 && catalog.some((source) => source.id === "tieba")
    ? [...withoutTieba, "tieba"]
    : withoutTieba;
  const fallback = sourceIds.length ? sourceIds : defaultSourceIds(catalog);
  return {
    sourceIds: fallback,
    tiebaBars: bars,
    enabledTiebaBars,
    layout: preferences.layout === "grid" ? "grid" : "list",
    order: preferences.order === "source" ? "source" : "mixed",
  };
}

export function sourceRequest(preferences: NewsPreferences): Pick<NewsPreferences, "sourceIds" | "tiebaBars" | "enabledTiebaBars"> {
  return {
    sourceIds: preferences.sourceIds,
    tiebaBars: preferences.tiebaBars,
    enabledTiebaBars: preferences.enabledTiebaBars,
  };
}

export function sortNewsItems(items: readonly NewsItem[], order: NewsOrder): readonly NewsItem[] {
  if (order === "mixed") return items;
  return [...items].sort((left, right) => {
    const source = left.sourceName.localeCompare(right.sourceName, "zh-CN");
    return source || right.publishedAt?.localeCompare(left.publishedAt ?? "") || left.title.localeCompare(right.title, "zh-CN");
  });
}

export function cleanGesturePoints(points: readonly NewsGesturePoint[]): NewsGesturePoint[] {
  return points
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, 320);
}

export function gestureLength(points: readonly NewsGesturePoint[]): number {
  return cleanGesturePoints(points).reduce((length, point, index, list) => {
    const previous = list[index - 1];
    return previous ? length + Math.hypot(point.x - previous.x, point.y - previous.y) : length;
  }, 0);
}

function resampleGesture(points: readonly NewsGesturePoint[], count = GESTURE_SAMPLE_COUNT): NewsGesturePoint[] {
  const list = cleanGesturePoints(points);
  const total = gestureLength(list);
  if (list.length < 2 || total < MIN_GESTURE_LENGTH || count < 2) return [];
  const interval = total / (count - 1);
  const sampled: NewsGesturePoint[] = [{ ...list[0]! }];
  let traversed = 0;
  let previous = { ...list[0]! };
  for (let index = 1; index < list.length && sampled.length < count; index += 1) {
    const current = list[index]!;
    let segment = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (segment === 0) continue;
    while (traversed + segment >= interval && sampled.length < count) {
      const ratio = (interval - traversed) / segment;
      previous = { x: previous.x + ((current.x - previous.x) * ratio), y: previous.y + ((current.y - previous.y) * ratio) };
      sampled.push({ ...previous });
      segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      traversed = 0;
    }
    traversed += segment;
    previous = { ...current };
  }
  const last = list.at(-1)!;
  while (sampled.length < count) sampled.push({ ...last });
  return sampled;
}

export function normaliseGesturePath(points: readonly NewsGesturePoint[]): NewsGesturePoint[] {
  const sampled = resampleGesture(points);
  if (sampled.length !== GESTURE_SAMPLE_COUNT) return [];
  const xs = sampled.map((point) => point.x);
  const ys = sampled.map((point) => point.y);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!Number.isFinite(scale) || scale < 1) return [];
  const centerX = xs.reduce((sum, value) => sum + value, 0) / sampled.length;
  const centerY = ys.reduce((sum, value) => sum + value, 0) / sampled.length;
  return sampled.map((point) => ({
    x: Math.round(((point.x - centerX) / scale) * 10000) / 10000,
    y: Math.round(((point.y - centerY) / scale) * 10000) / 10000,
  }));
}

export function normalisePrecision(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : 5;
}

export function gestureThreshold(precision: number): number {
  return [0.62, 0.66, 0.70, 0.74, 0.78, 0.82, 0.86, 0.89, 0.92, 0.95][normalisePrecision(precision) - 1]!;
}

export function gestureSimilarity(reference: readonly NewsGesturePoint[], candidate: readonly NewsGesturePoint[]): number {
  const left = reference.length === GESTURE_SAMPLE_COUNT ? cleanGesturePoints(reference) : normaliseGesturePath(reference);
  const right = candidate.length === GESTURE_SAMPLE_COUNT ? cleanGesturePoints(candidate) : normaliseGesturePath(candidate);
  if (left.length !== GESTURE_SAMPLE_COUNT || right.length !== GESTURE_SAMPLE_COUNT) return 0;
  const distance = left.reduce((sum, point, index) => sum + Math.hypot(point.x - right[index]!.x, point.y - right[index]!.y), 0) / left.length;
  return Math.max(0, Math.min(1, 1 - (distance / 0.72)));
}

export function allowedScopes(action: NewsGestureAction): readonly NewsGestureScope[] {
  return action === "restore-jump" ? ["reader"] : ["main", "reader", "auto"];
}

export function normaliseScope(action: NewsGestureAction, scope: NewsGestureScope): NewsGestureScope {
  return allowedScopes(action).includes(scope) ? scope : allowedScopes(action)[0]!;
}

export function normaliseProfile(profile: NewsGestureProfile, fallbackId: string): NewsGestureProfile {
  const action: NewsGestureAction = ["back", "book-info", "reopen-last", "restore-jump"].includes(profile.action) ? profile.action : "back";
  const points = cleanGesturePoints(profile.points);
  return {
    id: profile.id.trim() || fallbackId,
    name: profile.name.trim().slice(0, 24) || "返回／关闭当前页",
    action,
    scope: normaliseScope(action, profile.scope),
    enabled: profile.enabled,
    points: points.length === GESTURE_SAMPLE_COUNT ? points : [],
    precisionMode: profile.precisionMode === "global" ? "global" : "independent",
    precision: normalisePrecision(profile.precision),
  };
}

export function effectivePrecision(profile: NewsGestureProfile, globalPrecision: number): number {
  return profile.precisionMode === "global" ? normalisePrecision(globalPrecision) : normalisePrecision(profile.precision);
}

export function hasGestureConflict(profile: NewsGestureProfile, profiles: readonly NewsGestureProfile[]): boolean {
  return profiles.some((other) => other.id !== profile.id && other.enabled && profile.enabled && other.action === profile.action && allowedScopes(other.action).some((scope) => scope === profile.scope || scope === "auto" || profile.scope === "auto"));
}

export function gridColumns(layout: NewsLayout): number {
  return layout === "grid" ? 3 : 1;
}
