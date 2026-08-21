import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "./index.js";

/** The eight directions accepted by Rust's `parse_resize_direction`. */
export type WindowResizeDirection =
  | "north"
  | "north-east"
  | "east"
  | "south-east"
  | "south"
  | "south-west"
  | "west"
  | "north-west";

/**
 * Audited window commands only. Do not add unrelated commands here: a feature
 * should define its own command map after checking the Rust handler.
 */
export type WindowControlCommands = {
  main_window_minimize: { result: void };
  main_window_toggle_maximize: { result: void };
  main_window_close: { result: void };
  main_window_show: { result: void };
  main_window_start_dragging: { result: void };
  main_window_start_resize_dragging: {
    args: { direction: WindowResizeDirection };
    result: void;
  };
  reader_window_open: { result: boolean };
  startup_elapsed_ms: { result: number };
};

type VerifiedWindowControlCommands = WindowControlCommands extends TauriCommandMap
  ? WindowControlCommands
  : never;

/** A feature-oriented API that never exposes raw command strings to its caller. */
export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  show(): Promise<void>;
  startDragging(): Promise<void>;
  startResizeDragging(direction: WindowResizeDirection): Promise<void>;
  isReaderWindowOpen(): Promise<boolean>;
  elapsedSinceProcessStartMs(): Promise<number>;
}

export function createWindowControls(transport: TauriTransport): WindowControls {
  const api = createTauriApi<VerifiedWindowControlCommands>(transport);

  return {
    minimize: () => api.invoke("main_window_minimize"),
    toggleMaximize: () => api.invoke("main_window_toggle_maximize"),
    close: () => api.invoke("main_window_close"),
    show: () => api.invoke("main_window_show"),
    startDragging: () => api.invoke("main_window_start_dragging"),
    startResizeDragging: (direction) =>
      api.invoke("main_window_start_resize_dragging", { direction }),
    isReaderWindowOpen: () => api.invoke("reader_window_open"),
    elapsedSinceProcessStartMs: () => api.invoke("startup_elapsed_ms"),
  };
}
