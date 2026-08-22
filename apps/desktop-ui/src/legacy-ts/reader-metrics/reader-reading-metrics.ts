export const READER_READ_TRACK = Object.freeze({
  normalCpmLimit: 1_200,
  shortPageCpmLimit: 900,
  shortPageChars: 150,
  tinyPageChars: 30,
  shortMinMs: 2_000,
  shortMaxMs: 8_000,
  fastTurnRatio: 0.3,
  fastTurnStreak: 3,
  fastTurnCredit: 0.25,
  idleCapMs: 2 * 60 * 1_000,
  minDwellMs: 500,
  periodicCreditMs: 10_000,
  backtrackCooldownMs: 2_500,
  readingTimeTickMs: 15_000,
  readingTimeMaxCreditSec: 20,
});

export interface ReaderPageMetricsInput {
  readonly chapter?: unknown;
  readonly gPage?: unknown;
  readonly page?: unknown;
}

export function clampReaderMetric(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function readerMetricPageKey(
  data: ReaderPageMetricsInput,
  fallbackChapter: unknown,
): string {
  const chapter = Number.isFinite(data.chapter)
    ? data.chapter
    : fallbackChapter || 0;
  const globalPage = Number(data.gPage || 0);
  const page = Number(data.page || 0);
  return `${String(chapter)}:${globalPage > 0 ? `g${globalPage}` : `p${page}`}`;
}

export function readerMetricPagePosition(
  data: ReaderPageMetricsInput,
  fallbackChapter: unknown,
): number {
  const globalPage = Number(data.gPage || 0);
  if (globalPage > 0) return globalPage;
  const chapter = Number.isFinite(data.chapter)
    ? Number(data.chapter)
    : Number(fallbackChapter || 0);
  const page = Number(data.page || 0);
  return chapter * 100_000 + page;
}

export function requiredReaderMetricDwellMs(chars: number): number {
  if (chars <= 0) return 0;
  if (chars < READER_READ_TRACK.tinyPageChars) return 1_000;
  if (chars < READER_READ_TRACK.shortPageChars) {
    return clampReaderMetric(
      (chars / READER_READ_TRACK.shortPageCpmLimit) * 60_000,
      READER_READ_TRACK.shortMinMs,
      READER_READ_TRACK.shortMaxMs,
    );
  }
  return (chars / READER_READ_TRACK.normalCpmLimit) * 60_000;
}

export const readerReadingMetricsApi = Object.freeze({
  READ_TRACK: READER_READ_TRACK,
  clamp: clampReaderMetric,
  pageKey: readerMetricPageKey,
  pagePosition: readerMetricPagePosition,
  requiredDwellMs: requiredReaderMetricDwellMs,
});

export type ReaderReadingMetricsApi = typeof readerReadingMetricsApi;

export function installReaderReadingMetrics(
  target: Record<string, unknown>,
): ReaderReadingMetricsApi {
  target.ReaderReadingMetrics = readerReadingMetricsApi;
  return readerReadingMetricsApi;
}
