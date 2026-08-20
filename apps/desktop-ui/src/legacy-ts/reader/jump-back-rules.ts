function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeReaderJumpBackPosition(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1000, Math.round(finiteOr(value, fallback))));
}

export function normalizeReaderJumpBackIconSize(value: unknown, fallback = 32): number {
  return Math.max(30, Math.min(160, Math.round(finiteOr(value, fallback))));
}

export function readerJumpBackIconHeight(iconSizePx: unknown): number {
  return Math.max(12, Math.round(normalizeReaderJumpBackIconSize(iconSizePx) * 0.4));
}

/**
 * The stored point describes the visible arrow; its larger transparent hit
 * target may extend beyond the visual track without pulling the icon inward.
 */
export function readerJumpBackTrackPoint(
  length: number,
  iconSize: number,
  hitSize: number,
  position: unknown,
): number {
  const normalized = normalizeReaderJumpBackPosition(position, 0);
  const visualTrack = Math.max(0, length - iconSize);
  const hitTargetInset = Math.max(0, hitSize - iconSize) / 2;
  return (visualTrack * normalized) / 1000 - hitTargetInset;
}
