export interface ReaderPreferenceHsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

export function normalizeReaderPreferenceHex(
  value: unknown,
  fallback = "#222222",
): string {
  const raw = String(value || "").trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  const matchedColor = match?.[1];
  if (matchedColor === undefined) return fallback;
  const color = matchedColor.toLowerCase();
  return `#${
    color.length === 3
      ? color.split("").map((part) => part + part).join("")
      : color
  }`;
}

export function readerPreferenceHexToHsl(value: unknown): ReaderPreferenceHsl {
  const hex = normalizeReaderPreferenceHex(value).slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(lightness * 100) };
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === red
    ? ((green - blue) / delta) % 6
    : max === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  hue = Math.round((hue * 60 + 360) % 360);
  return {
    h: hue,
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100),
  };
}

export function readerPreferenceHslToHex(
  hue: unknown,
  saturation: unknown,
  lightness: unknown,
): string {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, Number(saturation) || 0)) / 100;
  const l = Math.max(0, Math.min(100, Number(lightness) || 0)) / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [red, green, blue] = h < 60
    ? [chroma, x, 0]
    : h < 120
      ? [x, chroma, 0]
      : h < 180
        ? [0, chroma, x]
        : h < 240
          ? [0, x, chroma]
          : h < 300
            ? [x, 0, chroma]
            : [chroma, 0, x];
  const channel = (value: number): string =>
    Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

export const readerPreferenceColorRulesApi = Object.freeze({
  normalizedHex: normalizeReaderPreferenceHex,
  hexToHsl: readerPreferenceHexToHsl,
  hslToHex: readerPreferenceHslToHex,
});

export type ReaderPreferenceColorRulesApi = typeof readerPreferenceColorRulesApi;

export function installReaderPreferenceColorRules(
  target: Record<string, unknown>,
): ReaderPreferenceColorRulesApi {
  target.ReaderPreferenceColorRules = readerPreferenceColorRulesApi;
  return readerPreferenceColorRulesApi;
}
