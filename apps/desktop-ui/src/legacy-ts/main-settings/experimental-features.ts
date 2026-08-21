export const EXPERIMENTAL_FEATURES_STORAGE_KEY =
  "kunpeng.reader.experimental-features.v1";
export const EXPERIMENTAL_FEATURE_DEFAULTS = Object.freeze({
  newsnowPrefetch: true,
  newsnowHideReturnIcon: false,
});

export interface ExperimentalFeatureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ExperimentalFeatureRuntime extends Record<string, unknown> {
  readonly localStorage: ExperimentalFeatureStorage;
  readonly document?: Document;
  dispatchEvent(event: Event): boolean;
  ReaderExperimentalFeatures?: ExperimentalFeaturesApi;
}

export interface ExperimentalFeaturesUiApi {
  refresh(): void;
  openSettings(): void;
  closeSettings(): void;
}

export interface ExperimentalFeaturesApi {
  readonly STORAGE_KEY: string;
  enabled(key: string): boolean;
  set(key: string, value: unknown): boolean;
  init(options?: Readonly<{ root?: Document }>): ExperimentalFeaturesUiApi | null;
  instance: ExperimentalFeaturesUiApi | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ExperimentalFeatureRuntime | null {
  const target = record(value);
  if (
    !target ||
    !record(target.localStorage) ||
    typeof target.dispatchEvent !== "function"
  ) {
    return null;
  }
  return target as unknown as ExperimentalFeatureRuntime;
}

function checkbox(value: Element | null): HTMLInputElement | null {
  return value instanceof HTMLInputElement ? value : null;
}

function element(value: Element | null): HTMLElement | null {
  return value instanceof HTMLElement ? value : null;
}

export function createExperimentalFeaturesApi(
  runtime: ExperimentalFeatureRuntime,
): ExperimentalFeaturesApi {
  const read = (): Record<string, unknown> => {
    try {
      const saved = JSON.parse(
        runtime.localStorage.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY) || "{}",
      ) as unknown;
      return {
        ...EXPERIMENTAL_FEATURE_DEFAULTS,
        ...(record(saved) ?? {}),
      };
    } catch {
      return { ...EXPERIMENTAL_FEATURE_DEFAULTS };
    }
  };

  const enabled = (key: string): boolean => {
    if (key === "newsnow") return true;
    return read()[key] === true;
  };

  const set = (key: string, value: unknown): boolean => {
    const next = read();
    next[key] = value === true;
    try {
      runtime.localStorage.setItem(
        EXPERIMENTAL_FEATURES_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch {
      // This local preference remains optional.
    }
    runtime.dispatchEvent(
      new CustomEvent("reader-experimental-features-changed", {
        detail: { key, enabled: next[key] },
      }),
    );
    return next[key] === true;
  };

  const init = (
    { root = runtime.document }: Readonly<{ root?: Document }> = {},
  ): ExperimentalFeaturesUiApi | null => {
    const gear = element(root?.getElementById("experimental-newsnow-gear") ?? null);
    const settingsModal = element(root?.getElementById("newsnow-settings-modal") ?? null);
    const closeSettings = element(root?.getElementById("newsnow-settings-close") ?? null);
    const prefetch = checkbox(
      root?.getElementById("experimental-newsnow-prefetch") ?? null,
    );
    const hideReturnIcon = checkbox(
      root?.getElementById("experimental-newsnow-hide-return-icon") ?? null,
    );
    if (!gear || !settingsModal || !closeSettings || !prefetch || !hideReturnIcon) {
      return null;
    }
    const refresh = (): void => {
      prefetch.checked = enabled("newsnowPrefetch");
      hideReturnIcon.checked = enabled("newsnowHideReturnIcon");
    };
    prefetch.addEventListener("change", () => {
      set("newsnowPrefetch", prefetch.checked);
    });
    hideReturnIcon.addEventListener("change", () => {
      set("newsnowHideReturnIcon", hideReturnIcon.checked);
    });
    const close = (): void => {
      settingsModal.classList.remove("show");
    };
    const openSettings = (): void => {
      refresh();
      settingsModal.classList.add("show");
    };
    gear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    });
    closeSettings.addEventListener("click", close);
    settingsModal.addEventListener("click", (event) => {
      if (event.target === settingsModal) close();
    });
    refresh();
    return { refresh, openSettings, closeSettings: close };
  };

  const api: ExperimentalFeaturesApi = {
    STORAGE_KEY: EXPERIMENTAL_FEATURES_STORAGE_KEY,
    enabled,
    set,
    init,
    instance: null,
  };
  if (runtime.document) api.instance = init();
  return api;
}

/** Classic installer replacing `ui/experimental-features.js`. */
export function installExperimentalFeatures(
  target: unknown,
): ExperimentalFeaturesApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = Object.freeze(createExperimentalFeaturesApi(runtime));
  runtime.ReaderExperimentalFeatures = api;
  return api;
}
