// 阅读页外壳状态机：统一管理工具栏和外壳级浮层。
// 正文 iframe 内的选区、词典、翻译、脚注等局部弹层不属于这里。
(function initReaderShellState() {
  "use strict";

  const OVERLAY = Object.freeze({
    NONE: "none",
    SETTINGS: "settings",
    SEARCH: "search",
    TOC: "toc",
    VOCAB: "vocab",
    INFO: "info",
    ANNOTATIONS: "annotations",
    CROSS_SEARCH: "cross-search",
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
    [OVERLAY.SEARCH, document.getElementById("rsearch")],
    [OVERLAY.TOC, document.getElementById("toc")],
    [OVERLAY.VOCAB, document.getElementById("vocab")],
    [OVERLAY.INFO, document.getElementById("info-modal")],
    [OVERLAY.ANNOTATIONS, document.getElementById("anno-modal")],
    [OVERLAY.CROSS_SEARCH, document.getElementById("cross-modal")],
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
        return Object.freeze({ ...current, overlay, settingsPointerExited: false });
      }
      case "TOOLBAR_POINTER_LEAVE":
        return Object.freeze({
          ...current,
          toolbar: isImmersiveState(current.toolbar) ? TOOLBAR.IMMERSIVE_HIDDEN : TOOLBAR.NORMAL,
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
        if (current.toolbar === TOOLBAR.NORMAL) {
          return Object.freeze({ ...current, toolbar: TOOLBAR.IMMERSIVE_HIDDEN });
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
    document.body.classList.toggle("immersive", immersive);
    document.body.classList.toggle("bar-hover", next.toolbar === TOOLBAR.IMMERSIVE_HOVER);
    document.body.classList.toggle("bar-show", next.toolbar === TOOLBAR.IMMERSIVE_PINNED);
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
