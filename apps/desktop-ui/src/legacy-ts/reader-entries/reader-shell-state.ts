import {
  createLegacyReaderShellState,
  isImmersiveToolbar,
  nextImmersiveStorageValue,
  projectLegacyReaderShell,
  reduceLegacyReaderShell,
} from "../reader/shell-state.ts";
import type {
  LegacyReaderShellAction,
  LegacyReaderShellState,
} from "../reader/shell-state.ts";

export const READER_SHELL_OVERLAY = Object.freeze({
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
} as const);

export const READER_SHELL_TOOLBAR = Object.freeze({
  NORMAL: "normal",
  IMMERSIVE_HIDDEN: "immersive-hidden",
  IMMERSIVE_HOVER: "immersive-hover",
  IMMERSIVE_PINNED: "immersive-pinned",
} as const);

export const READER_SHELL_SIDE_PANEL = Object.freeze({
  NONE: "none",
  AI_READER: "ai-reader",
} as const);

export interface ReaderShellTransition {
  readonly previous: LegacyReaderShellState;
  readonly next: LegacyReaderShellState;
  readonly action: unknown;
}

export interface ReaderShellLifecycle {
  readonly onOpen?: (transition: ReaderShellTransition) => void;
  readonly onClose?: (transition: ReaderShellTransition) => void;
}

export interface ReaderShellApi {
  readonly OVERLAY: typeof READER_SHELL_OVERLAY;
  readonly TOOLBAR: typeof READER_SHELL_TOOLBAR;
  readonly SIDE_PANEL: typeof READER_SHELL_SIDE_PANEL;
  readonly dispatch: (action: unknown) => LegacyReaderShellState;
  readonly setOverlay: (name: unknown, open: unknown) => LegacyReaderShellState;
  readonly closeOverlay: () => LegacyReaderShellState;
  readonly registerOverlay: (name: unknown, lifecycle: unknown) => void;
  readonly setSidePanel: (name: unknown, open: unknown) => LegacyReaderShellState;
  readonly closeSidePanel: () => LegacyReaderShellState;
  readonly closeSurface: () => boolean;
  readonly registerSidePanel: (name: unknown, lifecycle: unknown) => void;
  readonly isOverlay: (name: unknown) => boolean;
  readonly hasOverlay: () => boolean;
  readonly isSidePanel: (name: unknown) => boolean;
  readonly hasSidePanel: () => boolean;
  readonly hasSurface: () => boolean;
  readonly isImmersive: () => boolean;
  readonly getState: () => LegacyReaderShellState;
}

interface ReaderShellRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Pick<Storage, "getItem" | "setItem">;
  readonly CustomEvent: typeof CustomEvent;
  readonly dispatchEvent: (event: Event) => boolean;
}

const overlayValues = new Set<string>(Object.values(READER_SHELL_OVERLAY));
const sidePanelValues = new Set<string>(Object.values(READER_SHELL_SIDE_PANEL));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function lifecycleFrom(value: unknown): ReaderShellLifecycle {
  if (!isRecord(value)) return Object.freeze({});
  const lifecycle: {
    onOpen?: (transition: ReaderShellTransition) => void;
    onClose?: (transition: ReaderShellTransition) => void;
  } = {};
  if (typeof value.onOpen === "function") {
    lifecycle.onOpen = value.onOpen as (transition: ReaderShellTransition) => void;
  }
  if (typeof value.onClose === "function") {
    lifecycle.onClose = value.onClose as (transition: ReaderShellTransition) => void;
  }
  return Object.freeze(lifecycle);
}

function actionFrom(value: unknown): LegacyReaderShellAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "SET_OVERLAY":
      return { type: "SET_OVERLAY", overlay: value.overlay };
    case "SET_SIDE_PANEL":
      return { type: "SET_SIDE_PANEL", sidePanel: value.sidePanel };
    case "TOOLBAR_POINTER_LEAVE":
    case "TOOLBAR_POINTER_ENTER":
    case "TOGGLE_TOOLBAR":
    case "SHOW_TOOLBAR":
    case "HIDE_TOOLBAR":
      return { type: value.type };
    case "SET_IMMERSIVE":
      return { type: "SET_IMMERSIVE", on: Boolean(value.on) };
    default:
      return null;
  }
}

function sameState(left: LegacyReaderShellState, right: LegacyReaderShellState): boolean {
  return (
    left.overlay === right.overlay &&
    left.sidePanel === right.sidePanel &&
    left.toolbar === right.toolbar &&
    left.settingsPointerExited === right.settingsPointerExited
  );
}

export function installReaderShell(target: ReaderShellRuntime): ReaderShellApi {
  const overlayHooks = new Map<string, ReaderShellLifecycle>();
  const sidePanelHooks = new Map<string, ReaderShellLifecycle>();
  const overlayElements = new Map<string, HTMLElement | null>([
    [READER_SHELL_OVERLAY.SETTINGS, target.document.getElementById("settings")],
    [READER_SHELL_OVERLAY.PREFERENCES, target.document.getElementById("reader-preferences-modal")],
    [READER_SHELL_OVERLAY.SEARCH, target.document.getElementById("rsearch")],
    [READER_SHELL_OVERLAY.TOC, target.document.getElementById("toc")],
    [READER_SHELL_OVERLAY.VOCAB, target.document.getElementById("vocab")],
    [READER_SHELL_OVERLAY.INFO, target.document.getElementById("info-modal")],
    [READER_SHELL_OVERLAY.ANNOTATIONS, target.document.getElementById("anno-modal")],
    [READER_SHELL_OVERLAY.CROSS_SEARCH, target.document.getElementById("cross-modal")],
    [READER_SHELL_OVERLAY.END_RECOMMENDATIONS, target.document.getElementById("reader-end-modal")],
  ]);
  const sidePanelElements = new Map<string, HTMLElement | null>([
    [READER_SHELL_SIDE_PANEL.AI_READER, target.document.getElementById("ai-reader-side")],
  ]);
  const backdrop = target.document.getElementById("backdrop");
  const vocabSettings = target.document.getElementById("vocab-settings");
  let state = createLegacyReaderShellState(target.localStorage.getItem("immersive"));

  function render(next: LegacyReaderShellState): void {
    const projection = projectLegacyReaderShell(next);
    target.document.body.classList.toggle("immersive", projection.immersive);
    target.document.body.classList.toggle("bar-hover", projection.showBarHover);
    target.document.body.classList.toggle("bar-show", projection.showBarPinned);
    target.document.body.classList.toggle("reader-controls-visible", projection.controlsVisible);
    overlayElements.forEach((element, name) => {
      element?.classList.toggle("show", next.overlay === name);
    });
    sidePanelElements.forEach((element, name) => {
      element?.classList.toggle("show", next.sidePanel === name);
    });
    backdrop?.classList.toggle("show", projection.showBackdrop);
    if (next.overlay !== READER_SHELL_OVERLAY.VOCAB) vocabSettings?.classList.remove("show");
  }

  function runHook(
    registry: ReadonlyMap<string, ReaderShellLifecycle>,
    name: string,
    type: keyof ReaderShellLifecycle,
    transition: ReaderShellTransition,
  ): void {
    registry.get(name)?.[type]?.(transition);
  }

  function dispatch(rawAction: unknown): LegacyReaderShellState {
    const action = actionFrom(rawAction);
    if (!action) return state;
    const previous = state;
    const next = reduceLegacyReaderShell(previous, action);
    if (next === previous || sameState(next, previous)) return state;
    state = next;
    render(state);
    const transition = Object.freeze({ previous, next: state, action: rawAction });
    if (previous.overlay !== state.overlay) {
      runHook(overlayHooks, previous.overlay, "onClose", transition);
      runHook(overlayHooks, state.overlay, "onOpen", transition);
    }
    if (previous.sidePanel !== state.sidePanel) {
      runHook(sidePanelHooks, previous.sidePanel, "onClose", transition);
      runHook(sidePanelHooks, state.sidePanel, "onOpen", transition);
    }
    const storageValue = nextImmersiveStorageValue(previous, state);
    if (storageValue !== null) target.localStorage.setItem("immersive", storageValue);
    target.dispatchEvent(
      new target.CustomEvent("reader-shell-statechange", {
        detail: transition,
      }),
    );
    return state;
  }

  function setOverlay(name: unknown, open: unknown): LegacyReaderShellState {
    if (open) return dispatch({ type: "SET_OVERLAY", overlay: name });
    if (state.overlay === name) {
      return dispatch({ type: "SET_OVERLAY", overlay: READER_SHELL_OVERLAY.NONE });
    }
    return state;
  }

  function closeOverlay(): LegacyReaderShellState {
    return dispatch({ type: "SET_OVERLAY", overlay: READER_SHELL_OVERLAY.NONE });
  }

  function setSidePanel(name: unknown, open: unknown): LegacyReaderShellState {
    if (open) return dispatch({ type: "SET_SIDE_PANEL", sidePanel: name });
    if (state.sidePanel === name) {
      return dispatch({ type: "SET_SIDE_PANEL", sidePanel: READER_SHELL_SIDE_PANEL.NONE });
    }
    return state;
  }

  function closeSidePanel(): LegacyReaderShellState {
    return dispatch({ type: "SET_SIDE_PANEL", sidePanel: READER_SHELL_SIDE_PANEL.NONE });
  }

  const api: ReaderShellApi = Object.freeze({
    OVERLAY: READER_SHELL_OVERLAY,
    TOOLBAR: READER_SHELL_TOOLBAR,
    SIDE_PANEL: READER_SHELL_SIDE_PANEL,
    dispatch,
    setOverlay,
    closeOverlay,
    registerOverlay(name: unknown, lifecycle: unknown): void {
      if (name !== READER_SHELL_OVERLAY.NONE && typeof name === "string" && overlayValues.has(name)) {
        overlayHooks.set(name, lifecycleFrom(lifecycle));
      }
    },
    setSidePanel,
    closeSidePanel,
    closeSurface(): boolean {
      if (state.sidePanel !== READER_SHELL_SIDE_PANEL.NONE) {
        closeSidePanel();
        return true;
      }
      if (state.overlay !== READER_SHELL_OVERLAY.NONE) {
        closeOverlay();
        return true;
      }
      return false;
    },
    registerSidePanel(name: unknown, lifecycle: unknown): void {
      if (name !== READER_SHELL_SIDE_PANEL.NONE && typeof name === "string" && sidePanelValues.has(name)) {
        sidePanelHooks.set(name, lifecycleFrom(lifecycle));
      }
    },
    isOverlay: (name: unknown) => state.overlay === name,
    hasOverlay: () => state.overlay !== READER_SHELL_OVERLAY.NONE,
    isSidePanel: (name: unknown) => state.sidePanel === name,
    hasSidePanel: () => state.sidePanel !== READER_SHELL_SIDE_PANEL.NONE,
    hasSurface: () =>
      state.overlay !== READER_SHELL_OVERLAY.NONE || state.sidePanel !== READER_SHELL_SIDE_PANEL.NONE,
    isImmersive: () => isImmersiveToolbar(state.toolbar),
    getState: () => state,
  });

  target.ReaderShell = api;
  render(state);
  return api;
}
