export const NEWS_GESTURE_STORAGE_KEY = "kunpeng.reader.news.back-gesture.v2";
export const NEWS_GESTURE_ENABLED_KEY =
  "kunpeng.reader.news.back-gesture.enabled.v1";
export const NEWS_GESTURE_PRECISION_KEY =
  "kunpeng.reader.news.back-gesture.precision.v1";
export const NEWS_GESTURE_SAMPLE_COUNT = 48;
export const NEWS_GESTURE_MIN_PATH_LENGTH = 32;
export const NEWS_GESTURE_MATCH_THRESHOLD = 0.78;
export const NEWS_GESTURE_PRECISION_THRESHOLDS = Object.freeze([
  0.62, 0.66, 0.7, 0.74, NEWS_GESTURE_MATCH_THRESHOLD, 0.82, 0.86, 0.89, 0.92,
  0.95,
]);
export const NEWS_GESTURE_MATCH_THRESHOLDS = Object.freeze({
  low: NEWS_GESTURE_PRECISION_THRESHOLDS[2] ?? 0.7,
  medium: NEWS_GESTURE_MATCH_THRESHOLD,
  high: NEWS_GESTURE_PRECISION_THRESHOLDS[6] ?? 0.86,
});

export interface GesturePoint {
  readonly x: number;
  readonly y: number;
}

export interface GestureStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface GestureRuntime extends Record<string, unknown> {
  readonly localStorage?: GestureStorage;
  readonly devicePixelRatio?: unknown;
  ReaderNewsGesture?: NewsGestureApi;
}

export interface GestureDrawOptions {
  readonly normalized?: boolean;
  readonly color?: string;
  readonly lineWidth?: number;
}

export interface NewsGestureApi {
  readonly STORAGE_KEY: string;
  readonly ENABLED_KEY: string;
  readonly PRECISION_KEY: string;
  readonly SAMPLE_COUNT: number;
  readonly MIN_PATH_LENGTH: number;
  readonly MATCH_THRESHOLD: number;
  readonly MATCH_THRESHOLDS: Readonly<Record<"low" | "medium" | "high", number>>;
  readonly PRECISION_THRESHOLDS: readonly number[];
  cleanPoints(points: unknown): GesturePoint[];
  pathLength(points: unknown): number;
  normalize(points: unknown): GesturePoint[];
  directionSequence(points: unknown): number[];
  directionSimilarity(reference: unknown, candidate: unknown): number;
  prefixSimilarity(reference: unknown, candidate: unknown): number;
  similarity(reference: unknown, candidate: unknown): number;
  parseStored(value: unknown): GesturePoint[];
  load(storage?: GestureStorage): GesturePoint[];
  save(points: unknown, storage?: GestureStorage): GesturePoint[];
  loadEnabled(storage?: GestureStorage): boolean;
  saveEnabled(enabled: unknown, storage?: GestureStorage): boolean;
  normalizePrecision(value: unknown): string;
  loadPrecision(storage?: GestureStorage): string;
  savePrecision(precision: unknown, storage?: GestureStorage): string;
  matchThreshold(precision: unknown): number;
  clear(storage?: GestureStorage): void;
  draw(
    canvas: HTMLCanvasElement | null | undefined,
    points: unknown,
    options?: GestureDrawOptions,
  ): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function cleanGesturePoints(points: unknown): GesturePoint[] {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const value = record(point);
      return { x: Number(value?.x), y: Number(value?.y) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, 320);
}

export function gesturePathLength(points: unknown): number {
  const list = cleanGesturePoints(points);
  let length = 0;
  for (let index = 1; index < list.length; index += 1) {
    const current = list[index];
    const previous = list[index - 1];
    if (current && previous) {
      length += Math.hypot(current.x - previous.x, current.y - previous.y);
    }
  }
  return length;
}

function resampleGesture(points: unknown, count = NEWS_GESTURE_SAMPLE_COUNT): GesturePoint[] {
  const list = cleanGesturePoints(points);
  const total = gesturePathLength(list);
  const first = list[0];
  if (list.length < 2 || !first || total < NEWS_GESTURE_MIN_PATH_LENGTH || count < 2) {
    return [];
  }
  const interval = total / (count - 1);
  const output: GesturePoint[] = [{ ...first }];
  let traversed = 0;
  let previous = { ...first };
  for (let index = 1; index < list.length && output.length < count; index += 1) {
    const current = list[index];
    if (!current) continue;
    let segment = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (!segment) continue;
    while (traversed + segment >= interval && output.length < count) {
      const ratio = (interval - traversed) / segment;
      previous = {
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      };
      output.push({ ...previous });
      segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      traversed = 0;
    }
    traversed += segment;
    previous = { ...current };
  }
  const last = list[list.length - 1];
  if (!last) return [];
  while (output.length < count) output.push({ ...last });
  return output;
}

export function normalizeGesture(points: unknown): GesturePoint[] {
  const sampled = resampleGesture(points);
  if (!sampled.length) return [];
  const xs = sampled.map((point) => point.x);
  const ys = sampled.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const scale = Math.max(width, height);
  if (!Number.isFinite(scale) || scale < 1) return [];
  const centerX = xs.reduce((sum, value) => sum + value, 0) / sampled.length;
  const centerY = ys.reduce((sum, value) => sum + value, 0) / sampled.length;
  return sampled.map((point) => ({
    x: Math.round(((point.x - centerX) / scale) * 10_000) / 10_000,
    y: Math.round(((point.y - centerY) / scale) * 10_000) / 10_000,
  }));
}

function meanDistance(left: readonly GesturePoint[], right: readonly GesturePoint[]): number {
  if (left.length !== right.length || !left.length) return Infinity;
  return (
    left.reduce((sum, point, index) => {
      const other = right[index];
      return other ? sum + Math.hypot(point.x - other.x, point.y - other.y) : sum;
    }, 0) / left.length
  );
}

function normalizedInput(points: unknown): GesturePoint[] {
  const list = cleanGesturePoints(points);
  const alreadyNormalized =
    list.length === NEWS_GESTURE_SAMPLE_COUNT &&
    list.every((point) => Math.abs(point.x) <= 1.5 && Math.abs(point.y) <= 1.5);
  return alreadyNormalized ? list : normalizeGesture(list);
}

function directionDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 8;
  return Math.min(delta, 8 - delta);
}

export function gestureDirectionSequence(points: unknown): number[] {
  const list = normalizedInput(points);
  if (!list.length) return [];
  const directions: number[] = [];
  for (let index = 2; index < list.length; index += 1) {
    const point = list[index];
    const earlier = list[index - 2];
    if (!point || !earlier) continue;
    const dx = point.x - earlier.x;
    const dy = point.y - earlier.y;
    if (Math.hypot(dx, dy) < 0.008) continue;
    const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    if (directions[directions.length - 1] !== sector) directions.push(sector);
  }
  let changed = true;
  while (changed && directions.length >= 3) {
    changed = false;
    for (let index = 1; index < directions.length - 1; index += 1) {
      const previous = directions[index - 1];
      const current = directions[index];
      const next = directions[index + 1];
      if (previous === undefined || current === undefined || next === undefined) continue;
      if (
        previous === next ||
        (directionDistance(previous, next) === 2 &&
          directionDistance(previous, current) === 1 &&
          directionDistance(current, next) === 1)
      ) {
        directions.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return directions.slice(0, 16);
}

function directionSequenceSimilarity(saved: readonly number[], current: readonly number[]): number {
  if (!saved.length || !current.length) return 0;
  const rows = Array.from({ length: saved.length + 1 }, () =>
    Array<number>(current.length + 1).fill(0),
  );
  for (let left = 0; left <= saved.length; left += 1) {
    const row = rows[left];
    if (row) row[0] = left;
  }
  const firstRow = rows[0];
  if (!firstRow) return 0;
  for (let right = 0; right <= current.length; right += 1) firstRow[right] = right;
  for (let left = 1; left <= saved.length; left += 1) {
    const row = rows[left];
    const previousRow = rows[left - 1];
    const savedDirection = saved[left - 1];
    if (!row || !previousRow || savedDirection === undefined) continue;
    for (let right = 1; right <= current.length; right += 1) {
      const currentDirection = current[right - 1];
      if (currentDirection === undefined) continue;
      const substitution = directionDistance(savedDirection, currentDirection) / 4;
      row[right] = Math.min(
        (previousRow[right] ?? 0) + 1,
        (row[right - 1] ?? 0) + 1,
        (previousRow[right - 1] ?? 0) + substitution,
      );
    }
  }
  const distance = rows[saved.length]?.[current.length] ?? Infinity;
  return Math.max(0, Math.min(1, 1 - distance / Math.max(saved.length, current.length)));
}

export function gestureDirectionSimilarity(reference: unknown, candidate: unknown): number {
  return directionSequenceSimilarity(
    gestureDirectionSequence(reference),
    gestureDirectionSequence(candidate),
  );
}

export function gesturePrefixSimilarity(reference: unknown, candidate: unknown): number {
  const saved = gestureDirectionSequence(reference);
  const current = gestureDirectionSequence(candidate);
  if (!saved.length || !current.length) return 0;
  return directionSequenceSimilarity(
    saved.slice(0, Math.min(saved.length, current.length)),
    current,
  );
}

export function gestureSimilarity(reference: unknown, candidate: unknown): number {
  const saved = normalizedInput(reference);
  const current = normalizedInput(candidate);
  if (!saved.length || !current.length) return 0;
  const forward = meanDistance(saved, current);
  const shapeScore = Math.max(0, Math.min(1, 1 - forward / 0.72));
  return Math.max(shapeScore, gestureDirectionSimilarity(saved, current));
}

export function parseStoredGesture(value: unknown): GesturePoint[] {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    const container = record(parsed);
    const points = cleanGesturePoints(container?.points ?? parsed);
    return points.length === NEWS_GESTURE_SAMPLE_COUNT ? points : [];
  } catch {
    return [];
  }
}

export function normalizeGesturePrecision(value: unknown): string {
  const legacy = { low: "3", medium: "5", high: "7" }[String(value)];
  const parsed = Number(legacy || value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? String(parsed) : "5";
}

function resizeCanvas(canvas: HTMLCanvasElement, root: GestureRuntime) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, Number(root.devicePixelRatio) || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

export function createNewsGestureApi(root: GestureRuntime): NewsGestureApi {
  const defaultStorage = (): GestureStorage | undefined => root.localStorage;
  const load = (storage = defaultStorage()): GesturePoint[] => {
    try {
      return parseStoredGesture(storage?.getItem?.(NEWS_GESTURE_STORAGE_KEY));
    } catch {
      return [];
    }
  };
  const save = (points: unknown, storage = defaultStorage()): GesturePoint[] => {
    const normalized = normalizeGesture(points);
    if (!normalized.length) return [];
    try {
      storage?.setItem?.(
        NEWS_GESTURE_STORAGE_KEY,
        JSON.stringify({ version: 1, points: normalized }),
      );
    } catch {
      // Local preference storage is optional.
    }
    return normalized;
  };
  const loadEnabled = (storage = defaultStorage()): boolean => {
    try {
      const stored = storage?.getItem?.(NEWS_GESTURE_ENABLED_KEY);
      if (stored === "true" || stored === "1") return true;
      if (stored === "false" || stored === "0") return false;
    } catch {
      // Fall back to the existing saved gesture.
    }
    return load(storage).length > 0;
  };
  const saveEnabled = (enabled: unknown, storage = defaultStorage()): boolean => {
    try {
      storage?.setItem?.(NEWS_GESTURE_ENABLED_KEY, enabled ? "true" : "false");
    } catch {
      // Local preference storage is optional.
    }
    return Boolean(enabled);
  };
  const loadPrecision = (storage = defaultStorage()): string => {
    try {
      return normalizeGesturePrecision(storage?.getItem?.(NEWS_GESTURE_PRECISION_KEY));
    } catch {
      return "5";
    }
  };
  const savePrecision = (precision: unknown, storage = defaultStorage()): string => {
    const normalized = normalizeGesturePrecision(precision);
    try {
      storage?.setItem?.(NEWS_GESTURE_PRECISION_KEY, normalized);
    } catch {
      // Local preference storage is optional.
    }
    return normalized;
  };
  const matchThreshold = (precision: unknown): number =>
    NEWS_GESTURE_PRECISION_THRESHOLDS[Number(normalizeGesturePrecision(precision)) - 1] ??
    NEWS_GESTURE_MATCH_THRESHOLD;
  const clear = (storage = defaultStorage()): void => {
    try {
      storage?.removeItem?.(NEWS_GESTURE_STORAGE_KEY);
    } catch {
      // Local preference storage is optional.
    }
  };
  const draw = (
    canvas: HTMLCanvasElement | null | undefined,
    points: unknown,
    { normalized = false, color = "#3478d4", lineWidth = 5 }: GestureDrawOptions = {},
  ): void => {
    if (!canvas) return;
    const list = cleanGesturePoints(points);
    const { context, width, height } = resizeCanvas(canvas, root);
    context.clearRect(0, 0, width, height);
    if (!list.length) return;
    context.beginPath();
    list.forEach((point, index) => {
      const x = normalized
        ? width / 2 + point.x * Math.min(width, height) * 0.78
        : point.x;
      const y = normalized
        ? height / 2 + point.y * Math.min(width, height) * 0.78
        : point.y;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(19,67,131,.28)";
    context.shadowBlur = 5;
    const first = list[0];
    if (list.length === 1 && first) {
      context.fillStyle = color;
      context.arc(first.x, first.y, Math.max(lineWidth / 2, 3), 0, Math.PI * 2);
      context.fill();
    } else context.stroke();
  };
  return {
    STORAGE_KEY: NEWS_GESTURE_STORAGE_KEY,
    ENABLED_KEY: NEWS_GESTURE_ENABLED_KEY,
    PRECISION_KEY: NEWS_GESTURE_PRECISION_KEY,
    SAMPLE_COUNT: NEWS_GESTURE_SAMPLE_COUNT,
    MIN_PATH_LENGTH: NEWS_GESTURE_MIN_PATH_LENGTH,
    MATCH_THRESHOLD: NEWS_GESTURE_MATCH_THRESHOLD,
    MATCH_THRESHOLDS: NEWS_GESTURE_MATCH_THRESHOLDS,
    PRECISION_THRESHOLDS: NEWS_GESTURE_PRECISION_THRESHOLDS,
    cleanPoints: cleanGesturePoints,
    pathLength: gesturePathLength,
    normalize: normalizeGesture,
    directionSequence: gestureDirectionSequence,
    directionSimilarity: gestureDirectionSimilarity,
    prefixSimilarity: gesturePrefixSimilarity,
    similarity: gestureSimilarity,
    parseStored: parseStoredGesture,
    load,
    save,
    loadEnabled,
    saveEnabled,
    normalizePrecision: normalizeGesturePrecision,
    loadPrecision,
    savePrecision,
    matchThreshold,
    clear,
    draw,
  };
}

/** Classic installer replacing `ui/news-gesture.js`. */
export function installNewsGesture(target: GestureRuntime): NewsGestureApi {
  const api = Object.freeze(createNewsGestureApi(target));
  target.ReaderNewsGesture = api;
  return api;
}
