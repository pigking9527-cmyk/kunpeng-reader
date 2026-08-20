import {
  READER_NAVIGATION_HISTORY_LIMIT,
  appendReaderNavigationHistory,
  normalizeReaderNavigationPoint,
  readerPageSignature,
  sameReaderNavigationPoint,
  trackReaderPageDismissal,
} from "../reader/navigation-rules.ts";

export const readerNavigationRulesApi = Object.freeze({
  HISTORY_LIMIT: READER_NAVIGATION_HISTORY_LIMIT,
  normalizePoint: normalizeReaderNavigationPoint,
  samePoint: sameReaderNavigationPoint,
  appendHistory: appendReaderNavigationHistory,
  pageSignature: readerPageSignature,
  trackPageDismissal: trackReaderPageDismissal,
});

export type ReaderNavigationRulesApi = typeof readerNavigationRulesApi;

export function installReaderNavigationRules(
  target: Record<string, unknown>,
): ReaderNavigationRulesApi {
  target.ReaderNavigationRules = readerNavigationRulesApi;
  return readerNavigationRulesApi;
}
