import type { StartupEnhancementSettings, WindowSettingsPort } from "./window-settings-port.js";
import {
  isAbortError,
  startupEnhancementRequest,
  type WindowSettingsAction,
} from "./window-settings-state.js";

export interface WindowSettingsSession {
  activate(): void;
  load(): Promise<void>;
  save(settings: StartupEnhancementSettings): Promise<void>;
  cancelSave(): void;
  dispose(): void;
}

/**
 * Owns cancellable host calls for one mounted Window Settings feature.
 *
 * It deliberately has no UI dependency: lifecycle and stale-completion
 * behaviour are exercised with a plain fake port before a WebView mounts it.
 */
export function createWindowSettingsSession(
  port: WindowSettingsPort,
  dispatch: (action: WindowSettingsAction) => void,
): WindowSettingsSession {
  let active = false;
  let nextRequestId = 0;
  let loadController: AbortController | null = null;
  let saveController: AbortController | null = null;
  let currentSaveId = 0;

  const isCurrent = (controller: AbortController, current: AbortController | null): boolean =>
    active && current === controller && !controller.signal.aborted;

  return {
    activate(): void {
      active = true;
    },
    async load(): Promise<void> {
      if (!active) return;
      loadController?.abort();
      const controller = new AbortController();
      loadController = controller;
      dispatch({ type: "load-started" });
      try {
        const settings = await port.loadStartupSettings(controller.signal);
        if (isCurrent(controller, loadController)) dispatch({ type: "load-succeeded", settings });
      } catch (error: unknown) {
        if (isCurrent(controller, loadController) && !isAbortError(error, controller.signal)) {
          dispatch({ type: "load-failed" });
        }
      } finally {
        if (loadController === controller) loadController = null;
      }
    },
    async save(settings: StartupEnhancementSettings): Promise<void> {
      if (!active) return;
      saveController?.abort();
      const controller = new AbortController();
      saveController = controller;
      const requestId = ++nextRequestId;
      currentSaveId = requestId;
      dispatch({ type: "save-started", requestId });
      try {
        const saved = await port.saveStartupSettings(startupEnhancementRequest(settings), controller.signal);
        if (isCurrent(controller, saveController) && currentSaveId === requestId) {
          dispatch({ type: "save-succeeded", requestId, settings: saved });
        }
      } catch (error: unknown) {
        if (isCurrent(controller, saveController) && currentSaveId === requestId && !isAbortError(error, controller.signal)) {
          dispatch({ type: "save-failed", requestId });
        }
      } finally {
        if (saveController === controller) saveController = null;
      }
    },
    cancelSave(): void {
      const requestId = currentSaveId;
      saveController?.abort();
      saveController = null;
      if (active && requestId > 0) dispatch({ type: "save-cancelled", requestId });
    },
    dispose(): void {
      active = false;
      loadController?.abort();
      saveController?.abort();
      loadController = null;
      saveController = null;
    },
  };
}
