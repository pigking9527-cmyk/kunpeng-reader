(function exposeReaderAnimationSettings(global) {
  "use strict";

  const STORAGE_KEY = "readerAnimationSettingsV1";
  const DEFAULTS = Object.freeze({
    allAnimations: true,
    mainWindow: true,
    readerPage: true,
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
  const GROUPS = Object.freeze({
    mainWindow: Object.freeze(["searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "booklistSort"]),
    readerPage: Object.freeze(["annotationAdd", "readingMode", "pageTurn", "highlightSettings"]),
  });
  const GROUP_BY_KEY = Object.freeze(Object.entries(GROUPS).reduce((result, [group, keys]) => {
    keys.forEach((key) => { result[key] = group; });
    return result;
  }, {}));

  function isEnabled(values, key) {
    const group = GROUP_BY_KEY[key];
    return values[key] !== false && (key === "allAnimations" || values.allAnimations !== false) && (!group || values[group] !== false);
  }

  // 总开关是该分类当前是否还有可用效果的汇总。关闭总开关时一并关闭
  // 子项；之后重新打开任一子项，会自动重新启用对应分类。
  function normalizeEmptyGroups(values) {
    Object.entries(GROUPS).forEach(([group, keys]) => {
      // 兼容旧版本曾保存的“总开关关、子项仍开”的状态：总开关关
      // 必须落到真实的子项关闭，而不是只在运行时遮蔽效果。
      if (values[group] === false) {
        keys.forEach((key) => { values[key] = false; });
      } else if (!keys.some((key) => values[key] !== false)) {
        values[group] = false;
      }
    });
    return values;
  }

  function syncGroupForChild(values, key) {
    const group = GROUP_BY_KEY[key];
    if (group) values[group] = GROUPS[group].some((child) => values[child] !== false);
    return values;
  }

  function read() {
    try {
      const saved = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "{}");
      const values = saved && typeof saved === "object" ? saved : {};
      const settings = Object.assign({}, DEFAULTS, values);
      if (!Object.prototype.hasOwnProperty.call(values, "pageTurn")) {
        const reader = JSON.parse(global.localStorage.getItem("readerSettings") || "{}");
        if (reader?.pageTurnEffect === "off") settings.pageTurn = false;
      }
      return normalizeEmptyGroups(settings);
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function enabled(key) {
    return isEnabled(read(), key);
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

  function set(key, value, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return read();
    const next = read();
    next[key] = value !== false;
    if (GROUPS[key]) {
      if (next[key]) {
        // 总开关重新打开且这一组没有开启项时，恢复整组，避免出现无法
        // 从总开关恢复的死状态。
        if (!GROUPS[key].some((child) => next[child] !== false)) {
          GROUPS[key].forEach((child) => { next[child] = true; });
        }
      } else {
        // 总开关关闭就是明确关闭该组的全部效果，而不是只把它们遮蔽。
        GROUPS[key].forEach((child) => { next[child] = false; });
      }
    }
    // 阅读页的翻页下拉框是直接面向读者的即时控制；显式重新开启时，
    // 也恢复书页动画总开关。若此前整类动画已关闭，则这次操作只恢复
    // 翻页，不连带恢复其它书页效果。
    if (key === "pageTurn" && next.pageTurn && options.enableReaderPage) {
      const readerPageWasDisabled = next.readerPage === false;
      next.readerPage = true;
      if (readerPageWasDisabled && options.onlyPageTurn) {
        GROUPS.readerPage.forEach((effect) => {
          if (effect !== "pageTurn") next[effect] = false;
        });
      }
    }
    if (GROUP_BY_KEY[key]) syncGroupForChild(next, key);
    else normalizeEmptyGroups(next);
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (key === "pageTurn" || key === "readerPage" || key === "allAnimations") syncPageTurnEffect(isEnabled(next, "pageTurn"));
    global.dispatchEvent(new CustomEvent("reader-animation-settings-changed", { detail: next }));
    return next;
  }

  function applyMain(root) {
    const body = root?.body;
    if (!body) return;
    syncPageTurnEffect(enabled("pageTurn"));
    body.classList.toggle("animations-all-off", !enabled("allAnimations"));
    body.classList.toggle("anim-search-popup-off", !enabled("searchPopup"));
    body.classList.toggle("anim-shelf-search-toggle-off", !enabled("shelfSearchToggle"));
    body.classList.toggle("anim-common-settings-switch-off", !enabled("commonSettingsSwitch"));
    body.classList.toggle("anim-filter-button-off", !enabled("filterButton"));
    body.classList.toggle("anim-booklist-sort-off", !enabled("booklistSort"));
  }

  function applyReader(root) {
    const body = root?.body;
    if (!body) return;
    syncPageTurnEffect(enabled("pageTurn"));
    body.classList.toggle("animations-all-off", !enabled("allAnimations"));
    body.classList.toggle("anim-annotation-add-off", !enabled("annotationAdd"));
    body.classList.toggle("anim-reading-mode-off", !enabled("readingMode"));
  }

  global.ReaderAnimationSettings = Object.freeze({
    DEFAULTS,
    GROUPS,
    GROUP_BY_KEY,
    STORAGE_KEY,
    applyMain,
    applyReader,
    enabled,
    isEnabled,
    read,
    set,
    setPageTurnFromReader(value) {
      return set("pageTurn", value, {
        enableReaderPage: value !== false,
        onlyPageTurn: value !== false,
      });
    },
    syncPageTurnEffect,
  });
})(window);
