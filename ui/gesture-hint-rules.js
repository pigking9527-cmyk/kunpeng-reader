// 手势提示框的无副作用配置与轨迹规则。手势 UI 外壳负责 DOM、存储和
// 指针事件；本文件只把输入投影为可保存的提示框设置。
(function exposeGestureHintRules(global) {
  "use strict";

  const DEFAULT_HINT_SETTINGS = Object.freeze({
    fontSize: 20,
    backgroundEnabled: true,
    background: "#173b6b",
    opacity: 60,
    positionX: 0.96,
    positionY: 0.04,
    frameWidth: 200,
    frameHeight: 60,
    frameShape: "rect",
    framePath: [],
  });

  function hintHex(value, fallback = DEFAULT_HINT_SETTINGS.background) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : fallback;
  }

  function normalizeQuickColors(value, createId) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item, index) => {
        const color = String(item?.color || "").trim();
        if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
        const name = String(item?.name || "快捷颜色")
          .trim()
          .slice(0, 12);
        const generatedId =
          typeof createId === "function"
            ? createId()
            : "gesture-quick-color-" + index;
        return {
          id: String(item?.id || generatedId).slice(0, 80),
          name: name || "快捷颜色",
          color: color.toLowerCase(),
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Math.max(
      minimum,
      Math.min(maximum, Number.isFinite(number) ? number : fallback),
    );
  }

  function hintPosition(value, fallback) {
    return boundedNumber(value, fallback, 0, 1);
  }

  function hintFrameSize(value, fallback, minimum, maximum) {
    return boundedNumber(value, fallback, minimum, maximum);
  }

  function normalizeHintFrameShape(value) {
    return value === "freeform" ? "freeform" : "rect";
  }

  function normalizeHintFramePath(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
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

  function normalizeHintSettings(value, createId) {
    try {
      const saved = value && typeof value === "object" ? value : {};
      return {
        enabled: saved.enabled === true,
        fontSize: boundedNumber(
          Number(saved.fontSize) || DEFAULT_HINT_SETTINGS.fontSize,
          DEFAULT_HINT_SETTINGS.fontSize,
          12,
          28,
        ),
        backgroundEnabled:
          saved.backgroundEnabled !== false &&
          DEFAULT_HINT_SETTINGS.backgroundEnabled,
        background: hintHex(saved.background),
        opacity: boundedNumber(
          Number(saved.opacity) || DEFAULT_HINT_SETTINGS.opacity,
          DEFAULT_HINT_SETTINGS.opacity,
          20,
          100,
        ),
        positionX: hintPosition(
          saved.positionX,
          DEFAULT_HINT_SETTINGS.positionX,
        ),
        positionY: hintPosition(
          saved.positionY,
          DEFAULT_HINT_SETTINGS.positionY,
        ),
        frameWidth: hintFrameSize(
          saved.frameWidth,
          DEFAULT_HINT_SETTINGS.frameWidth,
          96,
          520,
        ),
        frameHeight: hintFrameSize(
          saved.frameHeight,
          DEFAULT_HINT_SETTINGS.frameHeight,
          40,
          240,
        ),
        frameShape: normalizeHintFrameShape(saved.frameShape),
        framePath: normalizeHintFramePath(saved.framePath),
        quickColors: normalizeQuickColors(saved.quickColors, createId),
      };
    } catch (_) {
      return {
        enabled: false,
        ...DEFAULT_HINT_SETTINGS,
        quickColors: [],
      };
    }
  }

  function hintFrameClipPath(settings) {
    if (settings?.frameShape !== "freeform" || settings?.framePath?.length < 3)
      return "none";
    return `polygon(${settings.framePath
      .map((point) => `${point.x}% ${point.y}%`)
      .join(",")})`;
  }

  function compactFreeformPoints(points, maximum) {
    const source = Array.isArray(points) ? points : [];
    const limit = Math.max(2, Math.floor(Number(maximum) || 2));
    if (source.length <= limit) return source.slice();
    const last = source.length - 1;
    return Array.from(
      { length: limit },
      (_, index) => source[Math.round((index * last) / (limit - 1))],
    );
  }

  global.ReaderGestureHintRules = Object.freeze({
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
})(typeof window !== "undefined" ? window : globalThis);
