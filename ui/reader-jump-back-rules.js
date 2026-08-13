(function (global) {
  "use strict";

  function normalizePosition(value, fallback) {
    const number = Number(value);
    return Math.max(0, Math.min(1000, Math.round(Number.isFinite(number) ? number : fallback)));
  }

  function normalizeIconSizePx(value, fallback = 32) {
    const number = Number(value);
    return Math.max(30, Math.min(160, Math.round(Number.isFinite(number) ? number : fallback)));
  }

  function iconHeightPx(iconSizePx) {
    return Math.max(12, Math.round(normalizeIconSizePx(iconSizePx) * 0.4));
  }

  // The stored value describes the visible arrow.  The larger transparent
  // hit target may extend beyond that point without pulling the icon inwards.
  function trackPoint(length, iconSize, hitSize, position) {
    const normalized = normalizePosition(position, 0);
    const visualTrack = Math.max(0, length - iconSize);
    const hitTargetInset = Math.max(0, hitSize - iconSize) / 2;
    return visualTrack * normalized / 1000 - hitTargetInset;
  }

  global.ReaderJumpBackRules = Object.freeze({
    normalizePosition,
    normalizeIconSizePx,
    iconHeightPx,
    trackPoint,
  });
})(window);
