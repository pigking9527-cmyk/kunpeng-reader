/* Local-only opt-in switches for unfinished desktop capabilities. */
(function exposeExperimentalFeatures(global) {
  "use strict";

  const STORAGE_KEY = "kunpeng.reader.experimental-features.v1";
  const DEFAULTS = Object.freeze({ newsnow: false });

  function read() {
    try {
      const saved = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "{}");
      return Object.assign({}, DEFAULTS, saved && typeof saved === "object" ? saved : {});
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function enabled(key) {
    return read()[key] === true;
  }

  function set(key, value) {
    const next = read();
    next[key] = value === true;
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) { /* optional local preference */ }
    global.dispatchEvent(new CustomEvent("reader-experimental-features-changed", { detail: { key, enabled: next[key] } }));
    return next[key];
  }

  function init({ root = global.document } = {}) {
    const news = root?.getElementById("experimental-newsnow");
    if (!news) return null;
    news.checked = enabled("newsnow");
    news.addEventListener("change", () => set("newsnow", news.checked));
    return { refresh: () => { news.checked = enabled("newsnow"); } };
  }

  const api = { STORAGE_KEY, enabled, set, init, instance: null };
  if (global.document) api.instance = init();
  global.ReaderExperimentalFeatures = Object.freeze(api);
})(window);
