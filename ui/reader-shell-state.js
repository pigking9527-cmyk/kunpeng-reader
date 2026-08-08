// 阅读页外壳状态机：统一管理工具栏和外壳级浮层。
// 正文 iframe 内的选区、词典、翻译、脚注等局部弹层不属于这里。
(function initReaderShellState() {
  "use strict";

  const OVERLAY = Object.freeze({
    NONE: "none",
    SETTINGS: "settings",
    PREFERENCES: "preferences",
    SEARCH: "search",
    TOC: "toc",
    VOCAB: "vocab",
    INFO: "info",
    ANNOTATIONS: "annotations",
    CROSS_SEARCH: "cross-search",
    END_RECOMMENDATIONS: "end-recommendations",
  });
  const TOOLBAR = Object.freeze({
    NORMAL: "normal",
    IMMERSIVE_HIDDEN: "immersive-hidden",
    IMMERSIVE_HOVER: "immersive-hover",
    IMMERSIVE_PINNED: "immersive-pinned",
  });
  const overlayValues = new Set(Object.values(OVERLAY));
  const hooks = new Map();
  const overlayElements = new Map([
    [OVERLAY.SETTINGS, document.getElementById("settings")],
    [OVERLAY.PREFERENCES, document.getElementById("reader-preferences-modal")],
    [OVERLAY.SEARCH, document.getElementById("rsearch")],
    [OVERLAY.TOC, document.getElementById("toc")],
    [OVERLAY.VOCAB, document.getElementById("vocab")],
    [OVERLAY.INFO, document.getElementById("info-modal")],
    [OVERLAY.ANNOTATIONS, document.getElementById("anno-modal")],
    [OVERLAY.CROSS_SEARCH, document.getElementById("cross-modal")],
    [OVERLAY.END_RECOMMENDATIONS, document.getElementById("reader-end-modal")],
  ]);
  const backdrop = document.getElementById("backdrop");
  const vocabSettings = document.getElementById("vocab-settings");
  const startsImmersive = localStorage.getItem("immersive") === "1";

  let state = Object.freeze({
    overlay: OVERLAY.NONE,
    toolbar: startsImmersive ? TOOLBAR.IMMERSIVE_HIDDEN : TOOLBAR.NORMAL,
    settingsPointerExited: false,
  });

  function isImmersiveState(value) {
    return value !== TOOLBAR.NORMAL;
  }

  function reduce(current, action) {
    switch (action.type) {
      case "SET_OVERLAY": {
        const overlay = overlayValues.has(action.overlay) ? action.overlay : OVERLAY.NONE;
        // 书内搜索属于工具栏；沉浸模式下即使焦点暂时被 Windows 输入法
        // 候选窗拿走，也不能让搜索框跟着工具栏一起隐去。
        return Object.freeze({
          ...current,
          overlay,
          toolbar:
            overlay === OVERLAY.SEARCH && isImmersiveState(current.toolbar)
              ? TOOLBAR.IMMERSIVE_PINNED
              : current.toolbar,
          settingsPointerExited: false,
        });
      }
      case "TOOLBAR_POINTER_LEAVE":
        return Object.freeze({
          ...current,
          // 中文 IME 的候选窗可能导致 WebView 收到一次 pointerleave。
          // 搜索仍打开时保持工具栏可见，不能仅因这个事件把输入框视觉隐藏。
          toolbar:
            current.overlay === OVERLAY.SEARCH && isImmersiveState(current.toolbar)
              ? TOOLBAR.IMMERSIVE_PINNED
              : isImmersiveState(current.toolbar)
                ? TOOLBAR.IMMERSIVE_HIDDEN
                : TOOLBAR.NORMAL,
          settingsPointerExited: current.overlay === OVERLAY.SETTINGS,
        });
      case "TOOLBAR_POINTER_ENTER":
        return Object.freeze({
          ...current,
          overlay:
            current.overlay === OVERLAY.SETTINGS && current.settingsPointerExited
              ? OVERLAY.NONE
              : current.overlay,
          toolbar: isImmersiveState(current.toolbar) ? TOOLBAR.IMMERSIVE_HOVER : TOOLBAR.NORMAL,
          settingsPointerExited: false,
        });
      case "SET_IMMERSIVE":
        return Object.freeze({
          ...current,
          toolbar: action.on ? TOOLBAR.IMMERSIVE_HIDDEN : TOOLBAR.NORMAL,
        });
      case "TOGGLE_TOOLBAR":
        // 正常阅读模式的工具栏必须常驻。正文中部点击只负责唤出或
        // 收起已开启的沉浸模式，绝不能把普通模式意外切进沉浸模式。
        if (current.toolbar === TOOLBAR.NORMAL) {
          return current;
        }
        return Object.freeze({
          ...current,
          toolbar:
            current.toolbar === TOOLBAR.IMMERSIVE_PINNED
              ? TOOLBAR.IMMERSIVE_HIDDEN
              : TOOLBAR.IMMERSIVE_PINNED,
        });
      case "SHOW_TOOLBAR":
        return isImmersiveState(current.toolbar)
          ? Object.freeze({ ...current, toolbar: TOOLBAR.IMMERSIVE_PINNED })
          : current;
      case "HIDE_TOOLBAR":
        return isImmersiveState(current.toolbar)
          ? Object.freeze({ ...current, toolbar: TOOLBAR.IMMERSIVE_HIDDEN })
          : current;
      default:
        return current;
    }
  }

  function render(next) {
    const immersive = isImmersiveState(next.toolbar);
    const controlsVisible =
      next.toolbar === TOOLBAR.NORMAL ||
      next.toolbar === TOOLBAR.IMMERSIVE_HOVER ||
      next.toolbar === TOOLBAR.IMMERSIVE_PINNED;
    document.body.classList.toggle("immersive", immersive);
    document.body.classList.toggle("bar-hover", next.toolbar === TOOLBAR.IMMERSIVE_HOVER);
    document.body.classList.toggle("bar-show", next.toolbar === TOOLBAR.IMMERSIVE_PINNED);
    // 顶部阅读工具栏和底部整书进度条必须由同一个状态驱动。
    // 禁止两个组件各自 toggle，否则一次中部点击会把它们切成相反状态。
    document.body.classList.toggle("reader-controls-visible", controlsVisible);
    overlayElements.forEach((element, name) => element?.classList.toggle("show", next.overlay === name));
    backdrop?.classList.toggle("show", next.overlay === OVERLAY.TOC || next.overlay === OVERLAY.VOCAB);
    if (next.overlay !== OVERLAY.VOCAB) vocabSettings?.classList.remove("show");
  }

  function runHook(name, type, transition) {
    const hook = hooks.get(name)?.[type];
    if (typeof hook !== "function") return;
    hook(transition);
  }

  function dispatch(action) {
    const previous = state;
    const next = reduce(previous, action || {});
    if (
      next === previous ||
      (next.overlay === previous.overlay &&
        next.toolbar === previous.toolbar &&
        next.settingsPointerExited === previous.settingsPointerExited)
    ) return state;
    state = next;
    render(state);
    if (previous.overlay !== state.overlay) {
      runHook(previous.overlay, "onClose", { previous, next: state, action });
      runHook(state.overlay, "onOpen", { previous, next: state, action });
    }
    const wasImmersive = isImmersiveState(previous.toolbar);
    const nowImmersive = isImmersiveState(state.toolbar);
    if (wasImmersive !== nowImmersive) localStorage.setItem("immersive", nowImmersive ? "1" : "0");
    window.dispatchEvent(
      new CustomEvent("reader-shell-statechange", { detail: { previous, next: state, action } })
    );
    return state;
  }

  function setOverlay(name, open) {
    if (open) return dispatch({ type: "SET_OVERLAY", overlay: name });
    if (state.overlay === name) return dispatch({ type: "SET_OVERLAY", overlay: OVERLAY.NONE });
    return state;
  }

  const api = Object.freeze({
    OVERLAY,
    TOOLBAR,
    dispatch,
    setOverlay,
    closeOverlay() {
      return dispatch({ type: "SET_OVERLAY", overlay: OVERLAY.NONE });
    },
    registerOverlay(name, lifecycle) {
      if (name !== OVERLAY.NONE && overlayValues.has(name)) hooks.set(name, lifecycle || {});
    },
    isOverlay(name) {
      return state.overlay === name;
    },
    hasOverlay() {
      return state.overlay !== OVERLAY.NONE;
    },
    isImmersive() {
      return isImmersiveState(state.toolbar);
    },
    getState() {
      return state;
    },
  });

  window.ReaderShell = api;
  render(state);
})();
