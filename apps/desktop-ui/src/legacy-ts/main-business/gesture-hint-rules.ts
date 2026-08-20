export interface HintPoint {
  readonly x: number;
  readonly y: number;
}

export interface HintQuickColor {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface HintSettings {
  readonly enabled: boolean;
  readonly fontSize: number;
  readonly backgroundEnabled: boolean;
  readonly background: string;
  readonly opacity: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameShape: "rect" | "freeform";
  readonly framePath: HintPoint[];
  readonly quickColors: HintQuickColor[];
}

export const DEFAULT_HINT_SETTINGS = Object.freeze({
  background: "#173b6b",
  backgroundEnabled: true,
  fontSize: 20,
  frameHeight: 60,
  framePath: Object.freeze<HintPoint[]>([]),
  frameShape: "rect" as const,
  frameWidth: 200,
  opacity: 60,
  positionX: 0.96,
  positionY: 0.04,
});

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

export function hintHex(
  value: unknown,
  fallback = DEFAULT_HINT_SETTINGS.background,
): string {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""))
    ? String(value).toLowerCase()
    : fallback;
}

export function normalizeQuickColors(
  value: unknown,
  createId?: () => string,
): HintQuickColor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): HintQuickColor | null => {
      const color = String(property(item, "color") || "").trim();
      if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
      const name = String(property(item, "name") || "快捷颜色")
        .trim()
        .slice(0, 12);
      const generatedId = createId
        ? createId()
        : `gesture-quick-color-${index}`;
      return {
        color: color.toLowerCase(),
        id: String(property(item, "id") || generatedId).slice(0, 80),
        name: name || "快捷颜色",
      };
    })
    .filter((item): item is HintQuickColor => item !== null)
    .slice(0, 6);
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  return Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(number) ? number : fallback),
  );
}

export function hintPosition(value: unknown, fallback: number): number {
  return boundedNumber(value, fallback, 0, 1);
}

export function hintFrameSize(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return boundedNumber(value, fallback, minimum, maximum);
}

export function normalizeHintFrameShape(value: unknown): "rect" | "freeform" {
  return value === "freeform" ? "freeform" : "rect";
}

export function normalizeHintFramePath(value: unknown): HintPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => ({
      x: Number(property(point, "x")),
      y: Number(property(point, "y")),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 100 &&
        point.y >= 0 &&
        point.y <= 100,
    )
    .slice(0, 48);
}

export function normalizeHintSettings(
  value: unknown,
  createId?: () => string,
): HintSettings {
  try {
    const saved = value && typeof value === "object" ? value : {};
    return {
      background: hintHex(property(saved, "background")),
      backgroundEnabled:
        property(saved, "backgroundEnabled") !== false &&
        DEFAULT_HINT_SETTINGS.backgroundEnabled,
      enabled: property(saved, "enabled") === true,
      fontSize: boundedNumber(
        Number(property(saved, "fontSize")) || DEFAULT_HINT_SETTINGS.fontSize,
        DEFAULT_HINT_SETTINGS.fontSize,
        12,
        28,
      ),
      frameHeight: hintFrameSize(
        property(saved, "frameHeight"),
        DEFAULT_HINT_SETTINGS.frameHeight,
        40,
        240,
      ),
      framePath: normalizeHintFramePath(property(saved, "framePath")),
      frameShape: normalizeHintFrameShape(property(saved, "frameShape")),
      frameWidth: hintFrameSize(
        property(saved, "frameWidth"),
        DEFAULT_HINT_SETTINGS.frameWidth,
        96,
        520,
      ),
      opacity: boundedNumber(
        Number(property(saved, "opacity")) || DEFAULT_HINT_SETTINGS.opacity,
        DEFAULT_HINT_SETTINGS.opacity,
        20,
        100,
      ),
      positionX: hintPosition(
        property(saved, "positionX"),
        DEFAULT_HINT_SETTINGS.positionX,
      ),
      positionY: hintPosition(
        property(saved, "positionY"),
        DEFAULT_HINT_SETTINGS.positionY,
      ),
      quickColors: normalizeQuickColors(property(saved, "quickColors"), createId),
    };
  } catch {
    return {
      ...DEFAULT_HINT_SETTINGS,
      enabled: false,
      framePath: [],
      quickColors: [],
    };
  }
}

export function hintFrameClipPath(
  settings: Readonly<Pick<HintSettings, "frameShape" | "framePath">>,
): string {
  if (settings.frameShape !== "freeform" || settings.framePath.length < 3) {
    return "none";
  }
  return `polygon(${settings.framePath
    .map((point) => `${point.x}% ${point.y}%`)
    .join(",")})`;
}

export function compactFreeformPoints(
  points: readonly HintPoint[] | unknown,
  maximum: unknown,
): HintPoint[] {
  const source = Array.isArray(points) ? (points as HintPoint[]) : [];
  const limit = Math.max(2, Math.floor(Number(maximum) || 2));
  if (source.length <= limit) return source.slice();
  const last = source.length - 1;
  return Array.from({ length: limit }, (_, index) => {
    const point = source[Math.round((index * last) / (limit - 1))];
    if (!point) throw new Error("A compacted gesture path index was out of bounds.");
    return point;
  });
}

export const gestureHintRules = Object.freeze({
  DEFAULT_HINT_SETTINGS,
  compactFreeformPoints,
  hintFrameClipPath,
  hintFrameSize,
  hintHex,
  hintPosition,
  normalizeHintFramePath,
  normalizeHintFrameShape,
  normalizeHintSettings,
  normalizeQuickColors,
});

export type GestureHintRulesApi = typeof gestureHintRules;

export function installGestureHintRules(
  target: Record<string, unknown>,
): GestureHintRulesApi {
  target.ReaderGestureHintRules = gestureHintRules;
  return gestureHintRules;
}
