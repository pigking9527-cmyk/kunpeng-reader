export const READER_NAVIGATION_HISTORY_LIMIT = 100;

export interface ReaderNavigationPoint {
  readonly chapter: number;
  readonly chFrac: number;
  readonly progress: number;
}

export interface ReaderNavigationPointInput {
  readonly chapter?: unknown;
  readonly chFrac?: unknown;
  readonly progress?: unknown;
}

export interface ReaderPagePositionInput {
  readonly gPage?: unknown;
  readonly page?: unknown;
  readonly chapter?: unknown;
}

export interface ReaderNavigationDismissalState {
  readonly visible: boolean;
  readonly awaitingLanding: boolean;
  readonly lastPageSignature: string;
  readonly pagesMoved: number;
}

export interface ReaderNavigationDismissalResult extends ReaderNavigationDismissalState {
  readonly dismissed: boolean;
}

function legacyNumberOrZero(value: unknown): number {
  return Number(value) || 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeReaderNavigationPoint(
  point: ReaderNavigationPointInput | null | undefined,
  fallback: ReaderNavigationPointInput = {},
): ReaderNavigationPoint {
  const source = point ?? {};
  return Object.freeze({
    chapter: Math.max(0, legacyNumberOrZero(source.chapter ?? fallback.chapter)),
    chFrac: clamp(legacyNumberOrZero(source.chFrac ?? fallback.chFrac), 0, 1),
    progress: clamp(legacyNumberOrZero(source.progress ?? fallback.progress), 0, 100),
  });
}

export function sameReaderNavigationPoint(
  left: ReaderNavigationPoint | null | undefined,
  right: ReaderNavigationPoint | null | undefined,
): boolean {
  return Boolean(
    left && right && left.chapter === right.chapter && Math.abs(left.chFrac - right.chFrac) < 0.0001,
  );
}

export function appendReaderNavigationHistory(
  entries: readonly ReaderNavigationPoint[],
  point: ReaderNavigationPointInput | null | undefined,
  fallback: ReaderNavigationPointInput,
  limit = READER_NAVIGATION_HISTORY_LIMIT,
): Readonly<{
  point: ReaderNavigationPoint;
  added: boolean;
  history: readonly ReaderNavigationPoint[];
}> {
  const next = normalizeReaderNavigationPoint(point, fallback);
  const added = !sameReaderNavigationPoint(entries.at(-1), next);
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || READER_NAVIGATION_HISTORY_LIMIT));
  const history = (added ? [...entries, next] : [...entries]).slice(-boundedLimit);
  return Object.freeze({ point: next, added, history: Object.freeze(history) });
}

export function readerPageSignature(data: ReaderPagePositionInput | null | undefined): string {
  return `${legacyNumberOrZero(data?.gPage)}_${legacyNumberOrZero(data?.page)}_${legacyNumberOrZero(data?.chapter)}`;
}

export function trackReaderPageDismissal(
  state: Partial<ReaderNavigationDismissalState> | null | undefined,
  data: ReaderPagePositionInput,
  pageLimit: number,
): ReaderNavigationDismissalResult {
  const visible = state?.visible === true;
  const awaitingLanding = state?.awaitingLanding === true;
  const lastPageSignature = String(state?.lastPageSignature ?? "");
  const pagesMoved = Math.max(0, Math.floor(legacyNumberOrZero(state?.pagesMoved)));
  if (!visible) {
    return Object.freeze({ visible, awaitingLanding, lastPageSignature, pagesMoved, dismissed: false });
  }

  const signature = readerPageSignature(data);
  if (awaitingLanding) {
    return Object.freeze({
      visible: true,
      awaitingLanding: false,
      lastPageSignature: signature,
      pagesMoved: 0,
      dismissed: false,
    });
  }
  const moved = lastPageSignature && signature !== lastPageSignature ? pagesMoved + 1 : pagesMoved;
  const limit = Math.max(1, Math.floor(Number(pageLimit) || 1));
  if (moved >= limit) {
    return Object.freeze({
      visible: false,
      awaitingLanding: false,
      lastPageSignature: "",
      pagesMoved: 0,
      dismissed: true,
    });
  }
  return Object.freeze({
    visible: true,
    awaitingLanding: false,
    lastPageSignature: signature,
    pagesMoved: moved,
    dismissed: false,
  });
}
