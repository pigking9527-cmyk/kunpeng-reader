import type {
  AboutInfo,
  CurrentReleaseNotes,
  SupportPort,
  UpdateInfo,
} from "./support-port.js";

export type SupportLoadPhase = "idle" | "loading" | "ready" | "failure" | "closed";
export type SupportUpdatePhase = "idle" | "checking" | "available" | "up-to-date" | "failure";

/**
 * View model for the existing about/update markup.  This is deliberately data
 * only: the future legacy-DOM renderer must update the current nodes instead
 * of mounting another page, style sheet, or component tree.
 */
export interface SupportViewState {
  readonly visible: boolean;
  readonly about: {
    readonly phase: SupportLoadPhase;
    readonly info: AboutInfo | null;
  };
  readonly releaseNotes: {
    readonly phase: SupportLoadPhase;
    readonly value: CurrentReleaseNotes | null;
  };
  readonly update: {
    readonly phase: SupportUpdatePhase;
    readonly value: UpdateInfo | null;
  };
  /** Fixed user copy only. It must never contain port, path, or network errors. */
  readonly notice: string;
}

/**
 * The only DOM contract a later renderer may use for this feature.  Its
 * values intentionally name the existing legacy nodes, so the future swap can
 * keep the same markup, CSS classes and overlay behaviour.
 */
export const legacySupportDomIds = Object.freeze({
  aboutModal: "about-modal",
  aboutVersion: "about-ver",
  aboutClose: "about-close",
  aboutUpdate: "about-update",
  aboutNotes: "about-notes",
  updateBar: "update-bar",
  updateCurrentVersion: "ub-current",
  updateLatestVersion: "ub-ver",
  updateNotes: "ub-notes",
  updateView: "ub-view",
  updateIgnore: "ub-ignore",
  updateClose: "ub-close",
} as const);

/**
 * Rendering stays outside the controller. A DOM adapter will receive this
 * state and render into `legacySupportDomIds`; it cannot create an alternative
 * support surface or own any Tauri/native call.
 */
export interface SupportRenderer {
  render(state: SupportViewState): void;
}

export interface SupportController {
  getState(): SupportViewState;
  subscribe(listener: (state: SupportViewState) => void): () => void;
  open(): Promise<void>;
  checkForUpdates(): Promise<void>;
  ignoreAvailableUpdate(): Promise<void>;
  openAvailableUpdate(): Promise<void>;
  close(): void;
  dispose(): void;
}

const ABOUT_FAILURE = "无法读取版本信息，请稍后重试。";
const NOTES_FAILURE = "暂无此版本的更新说明。";
const UPDATE_FAILURE = "检查更新失败，请检查网络后重试。";
const OPEN_UPDATE_FAILURE = "无法打开更新页面，请稍后重试。";

const initialState: SupportViewState = Object.freeze({
  visible: false,
  about: Object.freeze({ phase: "idle", info: null }),
  releaseNotes: Object.freeze({ phase: "idle", value: null }),
  update: Object.freeze({ phase: "idle", value: null }),
  notice: "",
});

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError");
}

/**
 * Owns the current About modal's cancellable loading and update actions.
 *
 * It deliberately does not know about DOM, CSS, browser globals or Tauri
 * command names. Closing the legacy modal aborts every outstanding request;
 * late native completions are ignored. The controller can be reopened after a
 * close, while `dispose` is for the owning window teardown.
 */
export function createSupportController(port: SupportPort, renderer?: SupportRenderer): SupportController {
  let state = initialState;
  let aboutRequest: AbortController | null = null;
  let notesRequest: AbortController | null = null;
  let updateRequest: AbortController | null = null;
  let openRequest: AbortController | null = null;
  let disposed = false;
  let epoch = 0;
  const listeners = new Set<(state: SupportViewState) => void>();

  const publish = (next: SupportViewState): void => {
    state = next;
    renderer?.render(state);
    for (const listener of listeners) listener(state);
  };

  const current = (request: AbortController, active: AbortController | null, requestEpoch: number): boolean =>
    !disposed && state.visible && active === request && !request.signal.aborted && epoch === requestEpoch;

  const clearRequests = (): void => {
    aboutRequest?.abort();
    notesRequest?.abort();
    updateRequest?.abort();
    openRequest?.abort();
    aboutRequest = null;
    notesRequest = null;
    updateRequest = null;
    openRequest = null;
  };

  const loadAbout = async (requestEpoch: number): Promise<void> => {
    const request = new AbortController();
    aboutRequest?.abort();
    aboutRequest = request;
    try {
      const info = await port.loadAbout(request.signal);
      if (current(request, aboutRequest, requestEpoch)) {
        publish({ ...state, about: { phase: "ready", info }, notice: "" });
      }
    } catch (error: unknown) {
      if (current(request, aboutRequest, requestEpoch) && !isAbort(error, request.signal)) {
        publish({ ...state, about: { phase: "failure", info: null }, notice: ABOUT_FAILURE });
      }
    } finally {
      if (aboutRequest === request) aboutRequest = null;
    }
  };

  const loadNotes = async (requestEpoch: number): Promise<void> => {
    const request = new AbortController();
    notesRequest?.abort();
    notesRequest = request;
    try {
      const value = await port.loadCurrentReleaseNotes(request.signal);
      if (current(request, notesRequest, requestEpoch)) {
        publish({ ...state, releaseNotes: { phase: "ready", value }, notice: "" });
      }
    } catch (error: unknown) {
      if (current(request, notesRequest, requestEpoch) && !isAbort(error, request.signal)) {
        publish({ ...state, releaseNotes: { phase: "failure", value: null }, notice: NOTES_FAILURE });
      }
    } finally {
      if (notesRequest === request) notesRequest = null;
    }
  };

  return {
    getState: (): SupportViewState => state,
    subscribe(listener: (state: SupportViewState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async open(): Promise<void> {
      if (disposed) return;
      clearRequests();
      const requestEpoch = ++epoch;
      publish({
        visible: true,
        about: { phase: "loading", info: null },
        releaseNotes: { phase: "loading", value: null },
        update: state.update,
        notice: "",
      });
      await Promise.all([loadAbout(requestEpoch), loadNotes(requestEpoch)]);
    },
    async checkForUpdates(): Promise<void> {
      if (disposed || !state.visible) return;
      updateRequest?.abort();
      const request = new AbortController();
      updateRequest = request;
      const requestEpoch = epoch;
      publish({ ...state, update: { phase: "checking", value: state.update.value }, notice: "" });
      try {
        const value = await port.checkForUpdates(request.signal);
        if (!current(request, updateRequest, requestEpoch)) return;
        publish({
          ...state,
          update: { phase: value.hasUpdate ? "available" : "up-to-date", value },
          notice: "",
        });
      } catch (error: unknown) {
        if (current(request, updateRequest, requestEpoch) && !isAbort(error, request.signal)) {
          publish({ ...state, update: { phase: "failure", value: null }, notice: UPDATE_FAILURE });
        }
      } finally {
        if (updateRequest === request) updateRequest = null;
      }
    },
    async ignoreAvailableUpdate(): Promise<void> {
      const version = state.update.value?.latestVersion;
      if (disposed || !state.visible || state.update.phase !== "available" || !version) return;
      const request = new AbortController();
      updateRequest?.abort();
      updateRequest = request;
      const requestEpoch = epoch;
      try {
        await port.ignoreUpdate(version, request.signal);
        if (current(request, updateRequest, requestEpoch)) {
          publish({ ...state, update: { phase: "idle", value: null }, notice: "" });
        }
      } catch (error: unknown) {
        if (current(request, updateRequest, requestEpoch) && !isAbort(error, request.signal)) {
          publish({ ...state, update: { phase: "failure", value: null }, notice: UPDATE_FAILURE });
        }
      } finally {
        if (updateRequest === request) updateRequest = null;
      }
    },
    async openAvailableUpdate(): Promise<void> {
      const url = state.update.value?.releaseUrl;
      if (disposed || !state.visible || state.update.phase !== "available" || !url) return;
      openRequest?.abort();
      const request = new AbortController();
      openRequest = request;
      const requestEpoch = epoch;
      try {
        await port.openExternal(url, request.signal);
      } catch (error: unknown) {
        if (current(request, openRequest, requestEpoch) && !isAbort(error, request.signal)) {
          publish({ ...state, notice: OPEN_UPDATE_FAILURE });
        }
      } finally {
        if (openRequest === request) openRequest = null;
      }
    },
    close(): void {
      if (disposed || !state.visible) return;
      clearRequests();
      epoch += 1;
      publish({ ...state, visible: false, notice: "" });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearRequests();
      epoch += 1;
      listeners.clear();
      publish({ ...initialState, about: { phase: "closed", info: null }, releaseNotes: { phase: "closed", value: null } });
    },
  };
}
