// NewsNow 自定义返回手势：保存用户亲自绘制的轨迹，并用归一化采样比较相似度。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderNewsGesture = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const STORAGE_KEY = "kunpeng.reader.news.back-gesture.v2";
  const ENABLED_KEY = "kunpeng.reader.news.back-gesture.enabled.v1";
  const PRECISION_KEY = "kunpeng.reader.news.back-gesture.precision.v1";
  const SAMPLE_COUNT = 48;
  const MIN_PATH_LENGTH = 64;
  const MATCH_THRESHOLD = 0.78;
  const PRECISION_THRESHOLDS = Object.freeze([0.62, 0.66, 0.70, 0.74, MATCH_THRESHOLD, 0.82, 0.86, 0.89, 0.92, 0.95]);
  const MATCH_THRESHOLDS = Object.freeze({ low: PRECISION_THRESHOLDS[2], medium: MATCH_THRESHOLD, high: PRECISION_THRESHOLDS[6] });

  function cleanPoints(points) {
    return (Array.isArray(points) ? points : []).map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).slice(0, 320);
  }

  function pathLength(points) {
    const list = cleanPoints(points);
    let length = 0;
    for (let index = 1; index < list.length; index += 1) length += Math.hypot(list[index].x - list[index - 1].x, list[index].y - list[index - 1].y);
    return length;
  }

  function resample(points, count = SAMPLE_COUNT) {
    const list = cleanPoints(points);
    const total = pathLength(list);
    if (list.length < 2 || total < MIN_PATH_LENGTH || count < 2) return [];
    const interval = total / (count - 1);
    const output = [{ ...list[0] }];
    let traversed = 0;
    let previous = { ...list[0] };
    for (let index = 1; index < list.length && output.length < count; index += 1) {
      const current = list[index];
      let segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      if (!segment) continue;
      while (traversed + segment >= interval && output.length < count) {
        const ratio = (interval - traversed) / segment;
        previous = { x: previous.x + (current.x - previous.x) * ratio, y: previous.y + (current.y - previous.y) * ratio };
        output.push({ ...previous });
        segment = Math.hypot(current.x - previous.x, current.y - previous.y);
        traversed = 0;
      }
      traversed += segment;
      previous = { ...current };
    }
    while (output.length < count) output.push({ ...list[list.length - 1] });
    return output;
  }

  function normalize(points) {
    const sampled = resample(points);
    if (!sampled.length) return [];
    const xs = sampled.map((point) => point.x), ys = sampled.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
    const scale = Math.max(width, height);
    if (!Number.isFinite(scale) || scale < 1) return [];
    const centerX = xs.reduce((sum, value) => sum + value, 0) / sampled.length;
    const centerY = ys.reduce((sum, value) => sum + value, 0) / sampled.length;
    return sampled.map((point) => ({
      x: Math.round(((point.x - centerX) / scale) * 10000) / 10000,
      y: Math.round(((point.y - centerY) / scale) * 10000) / 10000,
    }));
  }

  function meanDistance(left, right) {
    if (left.length !== right.length || !left.length) return Infinity;
    return left.reduce((sum, point, index) => sum + Math.hypot(point.x - right[index].x, point.y - right[index].y), 0) / left.length;
  }

  function normalizedInput(points) {
    const list = cleanPoints(points);
    const alreadyNormalized = list.length === SAMPLE_COUNT && list.every((point) => Math.abs(point.x) <= 1.5 && Math.abs(point.y) <= 1.5);
    return alreadyNormalized ? list : normalize(list);
  }

  function similarity(reference, candidate) {
    const saved = normalizedInput(reference), current = normalizedInput(candidate);
    if (!saved.length || !current.length) return 0;
    const forward = meanDistance(saved, current);
    const reverse = meanDistance(saved, current.slice().reverse());
    return Math.max(0, Math.min(1, 1 - Math.min(forward, reverse) / 0.72));
  }

  function parseStored(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      const points = cleanPoints(parsed?.points || parsed);
      return points.length === SAMPLE_COUNT ? points : [];
    } catch (_) { return []; }
  }

  function load(storage = root.localStorage) {
    try { return parseStored(storage?.getItem?.(STORAGE_KEY)); } catch (_) { return []; }
  }

  function save(points, storage = root.localStorage) {
    const normalized = normalize(points);
    if (!normalized.length) return [];
    try { storage?.setItem?.(STORAGE_KEY, JSON.stringify({ version: 1, points: normalized })); } catch (_) { /* local preference */ }
    return normalized;
  }

  function loadEnabled(storage = root.localStorage) {
    try {
      const stored = storage?.getItem?.(ENABLED_KEY);
      if (stored === "true" || stored === "1") return true;
      if (stored === "false" || stored === "0") return false;
    } catch (_) { /* fall back to the existing saved gesture */ }
    // 兼容已经保存过轨迹的用户：升级后不擅自关闭原本正在使用的手势。
    return load(storage).length > 0;
  }

  function saveEnabled(enabled, storage = root.localStorage) {
    try { storage?.setItem?.(ENABLED_KEY, enabled ? "true" : "false"); } catch (_) { /* local preference */ }
    return Boolean(enabled);
  }

  function normalizePrecision(value) {
    const legacy = { low: "3", medium: "5", high: "7" }[value];
    const parsed = Number(legacy || value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? String(parsed) : "5";
  }

  function loadPrecision(storage = root.localStorage) {
    try { return normalizePrecision(storage?.getItem?.(PRECISION_KEY)); } catch (_) { return "5"; }
  }

  function savePrecision(precision, storage = root.localStorage) {
    const normalized = normalizePrecision(precision);
    try { storage?.setItem?.(PRECISION_KEY, normalized); } catch (_) { /* local preference */ }
    return normalized;
  }

  function matchThreshold(precision) {
    return PRECISION_THRESHOLDS[Number(normalizePrecision(precision)) - 1];
  }

  function clear(storage = root.localStorage) {
    try { storage?.removeItem?.(STORAGE_KEY); } catch (_) { /* local preference */ }
  }

  function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, Number(root.devicePixelRatio) || 1);
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  }

  function draw(canvas, points, { normalized = false, color = "#3478d4", lineWidth = 5 } = {}) {
    if (!canvas) return;
    const list = cleanPoints(points);
    const { context, width, height } = resizeCanvas(canvas);
    context.clearRect(0, 0, width, height);
    if (!list.length) return;
    context.beginPath();
    list.forEach((point, index) => {
      const x = normalized ? width / 2 + point.x * Math.min(width, height) * 0.78 : point.x;
      const y = normalized ? height / 2 + point.y * Math.min(width, height) * 0.78 : point.y;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(19,67,131,.28)";
    context.shadowBlur = 5;
    context.stroke();
  }

  return { STORAGE_KEY, ENABLED_KEY, PRECISION_KEY, SAMPLE_COUNT, MIN_PATH_LENGTH, MATCH_THRESHOLD, MATCH_THRESHOLDS, PRECISION_THRESHOLDS, cleanPoints, pathLength, normalize, similarity, parseStored, load, save, loadEnabled, saveEnabled, normalizePrecision, loadPrecision, savePrecision, matchThreshold, clear, draw };
});
