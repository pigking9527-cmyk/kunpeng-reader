// 显式阅读跳转的纯规则。阅读器外壳仍负责 DOM、定时器和向正文页发送命令；
// 此文件只处理可序列化的导航点与“翻过若干页后收起返回入口”的状态转换。
(function exposeReaderNavigationRules(global) {
  "use strict";

  const HISTORY_LIMIT = 100;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizePoint(point, fallback = {}) {
    const source = point && typeof point === "object" ? point : {};
    return Object.freeze({
      chapter: Math.max(0, Number(source.chapter ?? fallback.chapter) || 0),
      chFrac: clamp(Number(source.chFrac ?? fallback.chFrac) || 0, 0, 1),
      progress: clamp(Number(source.progress ?? fallback.progress) || 0, 0, 100),
    });
  }

  function samePoint(left, right) {
    return !!left && !!right
      && left.chapter === right.chapter
      && Math.abs(left.chFrac - right.chFrac) < 0.0001;
  }

  function appendHistory(entries, point, fallback, limit = HISTORY_LIMIT) {
    const history = Array.isArray(entries) ? entries : [];
    const next = normalizePoint(point, fallback);
    const added = !samePoint(history[history.length - 1], next);
    const boundedLimit = Math.max(1, Math.floor(Number(limit) || HISTORY_LIMIT));
    const nextHistory = (added ? [...history, next] : history.slice()).slice(-boundedLimit);
    return Object.freeze({
      point: next,
      added,
      history: Object.freeze(nextHistory),
    });
  }

  function pageSignature(data) {
    return `${Number(data?.gPage) || 0}_${Number(data?.page) || 0}_${Number(data?.chapter) || 0}`;
  }

  function trackPageDismissal(state, data, pageLimit) {
    const current = state && typeof state === "object" ? state : {};
    const visible = current.visible === true;
    const awaitingLanding = current.awaitingLanding === true;
    const lastPageSignature = String(current.lastPageSignature || "");
    const pagesMoved = Math.max(0, Math.floor(Number(current.pagesMoved) || 0));
    if (!visible) return Object.freeze({ visible, awaitingLanding, lastPageSignature, pagesMoved, dismissed: false });

    const signature = pageSignature(data);
    if (awaitingLanding) {
      return Object.freeze({ visible: true, awaitingLanding: false, lastPageSignature: signature, pagesMoved: 0, dismissed: false });
    }
    const moved = lastPageSignature && signature !== lastPageSignature ? pagesMoved + 1 : pagesMoved;
    const limit = Math.max(1, Math.floor(Number(pageLimit) || 1));
    if (moved >= limit) {
      return Object.freeze({ visible: false, awaitingLanding: false, lastPageSignature: "", pagesMoved: 0, dismissed: true });
    }
    return Object.freeze({ visible: true, awaitingLanding: false, lastPageSignature: signature, pagesMoved: moved, dismissed: false });
  }

  global.ReaderNavigationRules = Object.freeze({
    HISTORY_LIMIT,
    normalizePoint,
    samePoint,
    appendHistory,
    pageSignature,
    trackPageDismissal,
  });
}(window));
