// 阅读统计的纯规则。阅读器外壳负责时钟、焦点和 Tauri 写入；本文件不访问 DOM、
// 存储或原生 API，因此可以独立回归已读字数的阈值与页面定位语义。
(function exposeReaderReadingMetrics(global) {
  "use strict";

  const READ_TRACK = Object.freeze({
    normalCpmLimit: 1200,
    shortPageCpmLimit: 900,
    shortPageChars: 150,
    tinyPageChars: 30,
    shortMinMs: 2000,
    shortMaxMs: 8000,
    fastTurnRatio: 0.3,
    fastTurnStreak: 3,
    fastTurnCredit: 0.25,
    idleCapMs: 2 * 60 * 1000,
    minDwellMs: 500,
    periodicCreditMs: 10000,
    backtrackCooldownMs: 2500,
    readingTimeTickMs: 15000,
    readingTimeMaxCreditSec: 20,
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pageKey(data, fallbackChapter) {
    const chapter = Number.isFinite(data.chapter) ? data.chapter : fallbackChapter || 0;
    const globalPage = Number(data.gPage || 0);
    const page = Number(data.page || 0);
    return chapter + ":" + (globalPage > 0 ? "g" + globalPage : "p" + page);
  }

  function pagePosition(data, fallbackChapter) {
    const globalPage = Number(data.gPage || 0);
    if (globalPage > 0) return globalPage;
    const chapter = Number.isFinite(data.chapter) ? data.chapter : fallbackChapter || 0;
    const page = Number(data.page || 0);
    return chapter * 100000 + page;
  }

  function requiredDwellMs(chars) {
    if (chars <= 0) return 0;
    if (chars < READ_TRACK.tinyPageChars) return 1000;
    if (chars < READ_TRACK.shortPageChars) {
      return clamp(
        (chars / READ_TRACK.shortPageCpmLimit) * 60000,
        READ_TRACK.shortMinMs,
        READ_TRACK.shortMaxMs,
      );
    }
    return (chars / READ_TRACK.normalCpmLimit) * 60000;
  }

  global.ReaderReadingMetrics = Object.freeze({
    READ_TRACK,
    clamp,
    pageKey,
    pagePosition,
    requiredDwellMs,
  });
})(window);
