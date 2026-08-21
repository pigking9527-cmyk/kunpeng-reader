import {
  normalizeReaderJumpBackIconSize,
  normalizeReaderJumpBackPosition,
  readerJumpBackIconHeight,
  readerJumpBackTrackPoint,
} from "../reader/jump-back-rules.ts";

export const readerJumpBackRulesApi = Object.freeze({
  normalizePosition: normalizeReaderJumpBackPosition,
  normalizeIconSizePx: normalizeReaderJumpBackIconSize,
  iconHeightPx: readerJumpBackIconHeight,
  trackPoint: readerJumpBackTrackPoint,
});

export type ReaderJumpBackRulesApi = typeof readerJumpBackRulesApi;

export function installReaderJumpBackRules(
  target: Record<string, unknown>,
): ReaderJumpBackRulesApi {
  target.ReaderJumpBackRules = readerJumpBackRulesApi;
  return readerJumpBackRulesApi;
}
