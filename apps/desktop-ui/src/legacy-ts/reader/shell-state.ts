/**
 * Strict, view-free equivalent of the state transitions in ui/reader-shell-state.js.
 * The classic page remains the only renderer; this module deliberately contains no DOM.
 */

export const READER_IMMERSIVE_STORAGE_KEY = "immersive";

export const READER_OVERLAYS = [
  "none",
  "settings",
  "preferences",
  "search",
  "toc",
  "vocab",
  "info",
  "annotations",
  "cross-search",
  "end-recommendations",
] as const;

export type ReaderOverlay = (typeof READER_OVERLAYS)[number];
export type ReaderToolbar = "normal" | "immersive-hidden" | "immersive-hover" | "immersive-pinned";
export type ReaderSidePanel = "none" | "ai-reader";

export interface LegacyReaderShellState {
  readonly overlay: ReaderOverlay;
  readonly sidePanel: ReaderSidePanel;
  readonly toolbar: ReaderToolbar;
  readonly settingsPointerExited: boolean;
}

export type LegacyReaderShellAction =
  | { readonly type: "SET_OVERLAY"; readonly overlay: unknown }
  | { readonly type: "SET_SIDE_PANEL"; readonly sidePanel: unknown }
  | { readonly type: "TOOLBAR_POINTER_LEAVE" }
  | { readonly type: "TOOLBAR_POINTER_ENTER" }
  | { readonly type: "SET_IMMERSIVE"; readonly on: boolean }
  | { readonly type: "TOGGLE_TOOLBAR" }
  | { readonly type: "SHOW_TOOLBAR" }
  | { readonly type: "HIDE_TOOLBAR" };

const overlayValues = new Set<string>(READER_OVERLAYS);
const sidePanelValues = new Set<string>(["none", "ai-reader"]);

export function isReaderOverlay(value: unknown): value is ReaderOverlay {
  return typeof value === "string" && overlayValues.has(value);
}

export function isReaderSidePanel(value: unknown): value is ReaderSidePanel {
  return typeof value === "string" && sidePanelValues.has(value);
}

export function isImmersiveToolbar(value: ReaderToolbar): boolean {
  return value !== "normal";
}

export function createLegacyReaderShellState(storedImmersive: string | null): LegacyReaderShellState {
  return Object.freeze({
    overlay: "none",
    sidePanel: "none",
    toolbar: storedImmersive === "1" ? "immersive-hidden" : "normal",
    settingsPointerExited: false,
  });
}

function freezeState(state: LegacyReaderShellState): LegacyReaderShellState {
  return Object.freeze(state);
}

/** Preserves the exact classic toolbar/overlay transition semantics. */
export function reduceLegacyReaderShell(
  current: LegacyReaderShellState,
  action: LegacyReaderShellAction,
): LegacyReaderShellState {
  switch (action.type) {
    case "SET_OVERLAY": {
      const overlay = isReaderOverlay(action.overlay) ? action.overlay : "none";
      return freezeState({
        ...current,
        overlay,
        toolbar:
          overlay === "search" && isImmersiveToolbar(current.toolbar)
            ? "immersive-pinned"
            : current.toolbar,
        settingsPointerExited: false,
      });
    }
    case "SET_SIDE_PANEL":
      return freezeState({
        ...current,
        sidePanel: isReaderSidePanel(action.sidePanel) ? action.sidePanel : "none",
      });
    case "TOOLBAR_POINTER_LEAVE":
      return freezeState({
        ...current,
        toolbar:
          current.overlay === "search" && isImmersiveToolbar(current.toolbar)
            ? "immersive-pinned"
            : isImmersiveToolbar(current.toolbar)
              ? "immersive-hidden"
              : "normal",
        settingsPointerExited: current.overlay === "settings",
      });
    case "TOOLBAR_POINTER_ENTER":
      return freezeState({
        ...current,
        overlay:
          current.overlay === "settings" && current.settingsPointerExited
            ? "none"
            : current.overlay,
        toolbar: isImmersiveToolbar(current.toolbar) ? "immersive-hover" : "normal",
        settingsPointerExited: false,
      });
    case "SET_IMMERSIVE":
      return freezeState({ ...current, toolbar: action.on ? "immersive-hidden" : "normal" });
    case "TOGGLE_TOOLBAR":
      if (current.toolbar === "normal") return current;
      return freezeState({
        ...current,
        toolbar: current.toolbar === "immersive-pinned" ? "immersive-hidden" : "immersive-pinned",
      });
    case "SHOW_TOOLBAR":
      return isImmersiveToolbar(current.toolbar)
        ? freezeState({ ...current, toolbar: "immersive-pinned" })
        : current;
    case "HIDE_TOOLBAR":
      return isImmersiveToolbar(current.toolbar)
        ? freezeState({ ...current, toolbar: "immersive-hidden" })
        : current;
  }
}

export interface ReaderShellProjection {
  readonly immersive: boolean;
  readonly controlsVisible: boolean;
  readonly showBarHover: boolean;
  readonly showBarPinned: boolean;
  readonly showBackdrop: boolean;
}

export function projectLegacyReaderShell(state: LegacyReaderShellState): ReaderShellProjection {
  return Object.freeze({
    immersive: isImmersiveToolbar(state.toolbar),
    controlsVisible:
      state.toolbar === "normal" || state.toolbar === "immersive-hover" || state.toolbar === "immersive-pinned",
    showBarHover: state.toolbar === "immersive-hover",
    showBarPinned: state.toolbar === "immersive-pinned",
    showBackdrop: state.overlay === "toc" || state.overlay === "vocab",
  });
}

export function nextImmersiveStorageValue(
  previous: LegacyReaderShellState,
  next: LegacyReaderShellState,
): "0" | "1" | null {
  const before = isImmersiveToolbar(previous.toolbar);
  const after = isImmersiveToolbar(next.toolbar);
  return before === after ? null : after ? "1" : "0";
}
