(function exposeReaderAnimationSettings(global) {
  "use strict";

  const STORAGE_KEY = "readerAnimationSettingsV1";
  const DEFAULTS = Object.freeze({
    searchPopup: true,
    shelfSearchToggle: true,
    commonSettingsSwitch: true,
    filterButton: true,
    annotationAdd: true,
    readingMode: true,
    pageTurn: true,
    highlightSettings: true,
    booklistSort: true,
  });

  function read() {
    try {
      const saved = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "{}");
      const values = saved && typeof saved === "object" ? saved : {};
      const settings = Object.assign({}, DEFAULTS, values);
      if (!Object.prototype.hasOwnProperty.call(values, "pageTurn")) {
        const reader = JSON.parse(global.localStorage.getItem("readerSettings") || "{}");
        if (reader?.pageTurnEffect === "off") settings.pageTurn = false;
      }
      return settings;
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function enabled(key) {
    return read()[key] !== false;
  }

  function syncPageTurnEffect(value) {
    try {
      const saved = JSON.parse(global.localStorage.getItem("readerSettings") || "{}");
      const next = saved && typeof saved === "object" ? saved : {};
      const effect = value === false ? "off" : "horizontal";
      if (next.pageTurnEffect === effect) return;
      next.pageTurnEffect = effect;
      global.localStorage.setItem("readerSettings", JSON.stringify(next));
    } catch (_) {}
  }

  function set(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return read();
    const next = read();
    next[key] = value !== false;
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (key === "pageTurn") syncPageTurnEffect(next.pageTurn);
    global.dispatchEvent(new CustomEvent("reader-animation-settings-changed", { detail: next }));
    return next;
  }

  function applyMain(root) {
    const body = root?.body;
    if (!body) return;
    const settings = read();
    syncPageTurnEffect(settings.pageTurn);
    body.classList.toggle("anim-search-popup-off", settings.searchPopup === false);
    body.classList.toggle("anim-shelf-search-toggle-off", settings.shelfSearchToggle === false);
    body.classList.toggle("anim-common-settings-switch-off", settings.commonSettingsSwitch === false);
    body.classList.toggle("anim-filter-button-off", settings.filterButton === false);
    body.classList.toggle("anim-booklist-sort-off", settings.booklistSort === false);
  }

  function applyReader(root) {
    const body = root?.body;
    if (!body) return;
    const settings = read();
    syncPageTurnEffect(settings.pageTurn);
    body.classList.toggle("anim-annotation-add-off", settings.annotationAdd === false);
    body.classList.toggle("anim-reading-mode-off", settings.readingMode === false);
  }

  global.ReaderAnimationSettings = Object.freeze({
    DEFAULTS,
    STORAGE_KEY,
    applyMain,
    applyReader,
    enabled,
    read,
    set,
    syncPageTurnEffect,
  });
})(window);
