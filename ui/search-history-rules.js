// 搜索窗口的本地历史纯规则。它不读取 localStorage，也不创建 DOM，
// 这样搜索外壳仍负责持久化、显示和事件生命周期。
(function registerReaderSearchHistoryRules(global) {
  "use strict";

  function normalizedSearchTerm(value) {
    return String(value || "").trim();
  }

  function recordSearchQuery(history, common, query, now, maxHistory) {
    const term = normalizedSearchTerm(query);
    const limit = Number.isInteger(maxHistory) && maxHistory > 0 ? maxHistory : 12;
    const entries = Array.isArray(history) ? history : [];
    const counts = common && typeof common === "object" && !Array.isArray(common) ? common : {};
    if (!term) return { history: entries.slice(0, limit), common: { ...counts } };

    const previous = counts[term] || {};
    return {
      history: [term, ...entries.filter((entry) => entry !== term)].slice(0, limit),
      common: {
        ...counts,
        [term]: {
          count: (Number(previous.count) || 0) + 1,
          last: Number.isFinite(now) ? now : 0,
        },
      },
    };
  }

  function removeSearchQuery(history, query) {
    const term = normalizedSearchTerm(query);
    return (Array.isArray(history) ? history : []).filter((entry) => entry !== term);
  }

  function commonSearches(common, limit) {
    const maximum = Number.isInteger(limit) && limit >= 0 ? limit : 6;
    const counts = common && typeof common === "object" && !Array.isArray(common) ? common : {};
    return Object.entries(counts)
      .sort((left, right) =>
        (Number(right[1]?.count) || 0) - (Number(left[1]?.count) || 0)
        || (Number(right[1]?.last) || 0) - (Number(left[1]?.last) || 0))
      .slice(0, maximum)
      .map(([query, value]) => ({ query, count: Number(value?.count) || 0 }));
  }

  global.ReaderSearchHistoryRules = Object.freeze({
    normalizedSearchTerm,
    recordSearchQuery,
    removeSearchQuery,
    commonSearches,
  });
}(window));
