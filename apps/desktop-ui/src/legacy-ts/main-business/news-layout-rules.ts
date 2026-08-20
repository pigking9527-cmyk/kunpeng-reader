export interface NewsCardProjection {
  readonly title?: string;
  readonly summary?: string;
  readonly hasImage?: boolean;
}

export interface NewsLayoutOptions {
  readonly width?: number;
  readonly columnCount?: number;
  readonly gap?: number;
}

function text(value: unknown): string {
  return String(value == null ? "" : value);
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function masonryColumnCount(
  width: unknown,
  previousCount = 0,
  options: Readonly<{ minimumCardWidth?: number; gap?: number }> = {},
): number {
  const safeWidth = Number(width);
  if (!Number.isFinite(safeWidth) || safeWidth <= 0) {
    return Math.max(1, positiveInteger(previousCount, 1));
  }
  const minimum = positiveInteger(options.minimumCardWidth, 210);
  const spacing = Math.max(0, Number(options.gap ?? 13) || 0);
  return Math.max(1, Math.floor((safeWidth + spacing) / (minimum + spacing)));
}

export function estimateCardHeight(
  card: NewsCardProjection = {},
  options: NewsLayoutOptions = {},
): number {
  const columns = positiveInteger(options.columnCount ?? 1, 1);
  const spacing = Math.max(0, Number(options.gap ?? 13) || 0);
  const width = options.width ?? 210;
  const availableWidth = Math.max(
    160,
    (Math.max(0, Number(width) || 0) - spacing * (columns - 1)) / columns - 40,
  );
  const charsPerLine = Math.max(10, Math.floor(availableWidth / 16));
  const lineCount = (value: unknown, maximum: number): number =>
    Math.min(
      maximum,
      Math.max(1, Math.ceil(Array.from(text(value)).length / charsPerLine)),
    );
  const titleLines = lineCount(card.title ?? "", 4);
  const summaryText = text(card.summary ?? "").trim();
  const summaryLines = summaryText ? lineCount(summaryText, 3) : 0;
  return (
    68 +
    titleLines * 27 +
    summaryLines * 21 +
    (card.hasImage ? 146 : 0) +
    44
  );
}

export function balancedColumnIndexes(
  estimatedHeights: readonly unknown[] | unknown,
  columnCount: unknown,
): number[] {
  const count = positiveInteger(columnCount, 1);
  const columns = Array.from({ length: count }, () => 0);
  const heights = Array.isArray(estimatedHeights) ? estimatedHeights : [];
  return heights.map((value) => {
    let target = 0;
    for (let index = 1; index < columns.length; index += 1) {
      const candidateHeight = columns[index] ?? 0;
      const targetHeight = columns[target] ?? 0;
      if (candidateHeight < targetHeight) target = index;
    }
    const height = Number(value);
    columns[target] =
      (columns[target] ?? 0) +
      (Number.isFinite(height) && height > 0 ? height : 0);
    return target;
  });
}

export const newsLayoutRules = Object.freeze({
  balancedColumnIndexes,
  estimateCardHeight,
  masonryColumnCount,
});

export type NewsLayoutRulesApi = typeof newsLayoutRules;

export function installNewsLayoutRules(
  target: Record<string, unknown>,
): NewsLayoutRulesApi {
  target.ReaderNewsLayoutRules = newsLayoutRules;
  return newsLayoutRules;
}
