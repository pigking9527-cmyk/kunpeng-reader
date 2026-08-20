import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriEvent,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

export interface StartupEnhancementConfig {
  readonly enabled: boolean;
  readonly continueHighCost: boolean;
  readonly launchAtLogin: boolean;
  readonly launchAtLoginAvailable: boolean;
  readonly launchAtLoginBackground: boolean;
  readonly launchAtLoginBackgroundAvailable: boolean;
}

export interface StartupEnhancementState {
  readonly backgrounded?: unknown;
  readonly continueHighCost?: unknown;
  readonly highCostResumeAtMs?: unknown;
}

type StartupEnhancementCommands = {
  startup_enhancement_config: { readonly result: unknown };
  set_startup_enhancement_config: {
    readonly args: { readonly request: StartupEnhancementConfig };
    readonly result: unknown;
  };
};

type StartupEnhancementEvents = {
  "startup-enhancement-state": StartupEnhancementState;
};

type VerifiedCommands = StartupEnhancementCommands extends TauriCommandMap
  ? StartupEnhancementCommands
  : never;

export interface StartupEnhancementGlobalApi {
  backgroundWorkAllowed(): boolean;
  highCostRetryDelay(): number;
  snapshot(): Readonly<{
    enabled: boolean;
    continueHighCost: boolean;
    launchAtLogin: boolean;
    launchAtLoginBackground: boolean;
  }>;
}

interface AppNoticeLike {
  show?(
    message: string,
    options: Readonly<{ variant: "text"; duration: 1800 }>,
  ): void;
}

interface StartupEnhancementRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly AppNotice?: AppNoticeLike;
  ReaderStartupEnhancement?: StartupEnhancementGlobalApi;
}

const DEFAULT_CONFIG: StartupEnhancementConfig = Object.freeze({
  enabled: false,
  continueHighCost: false,
  launchAtLogin: false,
  launchAtLoginAvailable: false,
  launchAtLoginBackground: false,
  launchAtLoginBackgroundAvailable: false,
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): StartupEnhancementRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as StartupEnhancementRuntime;
}

export function normalizeStartupEnhancementConfig(
  loaded: unknown,
): StartupEnhancementConfig {
  const value = record(loaded);
  return {
    enabled: Boolean(value?.enabled),
    continueHighCost: Boolean(value?.continueHighCost),
    launchAtLogin: Boolean(value?.launchAtLogin),
    launchAtLoginAvailable: Boolean(value?.launchAtLoginAvailable),
    launchAtLoginBackground: Boolean(value?.launchAtLoginBackground),
    launchAtLoginBackgroundAvailable: Boolean(
      value?.launchAtLoginBackgroundAvailable,
    ),
  };
}

function checkbox(element: Element | null): HTMLInputElement | null {
  return element instanceof HTMLInputElement ? element : null;
}

function element(element: Element | null): HTMLElement | null {
  return element instanceof HTMLElement ? element : null;
}

function ignoreFailure(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

export function initializeStartupEnhancementUi(
  runtime: StartupEnhancementRuntime,
  transport: TauriTransport,
  now = Date.now,
): StartupEnhancementGlobalApi {
  const api = createTauriApi<VerifiedCommands>(transport);
  const events = api.events<StartupEnhancementEvents>();
  const document = runtime.document;
  const master = checkbox(document.getElementById("set-startup-enhancement"));
  const gear = element(document.getElementById("startup-enhancement-gear"));
  const modal = element(document.getElementById("startup-enhancement-modal"));
  const close = element(document.getElementById("startup-enhancement-close"));
  const launchAtLoginRow = element(
    document.getElementById("startup-enhancement-autostart-row"),
  );
  const launchAtLogin = checkbox(
    document.getElementById("startup-enhancement-autostart"),
  );
  const launchAtLoginBackgroundRow = element(
    document.getElementById("startup-enhancement-autostart-background-row"),
  );
  const launchAtLoginBackground = checkbox(
    document.getElementById("startup-enhancement-autostart-background"),
  );
  const processAfterClose = checkbox(
    document.getElementById("startup-enhancement-process"),
  );
  const continueHighCost = checkbox(
    document.getElementById("startup-enhancement-high-cost"),
  );
  let config = DEFAULT_CONFIG;
  let backgrounded = false;
  let highCostResumeAtMs = 0;

  const render = (): void => {
    if (master) master.checked = config.enabled;
    if (launchAtLoginRow) launchAtLoginRow.hidden = !config.launchAtLoginAvailable;
    if (launchAtLogin) {
      launchAtLogin.checked = config.launchAtLogin;
      launchAtLogin.disabled = !config.launchAtLoginAvailable;
    }
    if (launchAtLoginBackgroundRow) {
      launchAtLoginBackgroundRow.hidden =
        !config.launchAtLoginBackgroundAvailable;
    }
    if (launchAtLoginBackground) {
      launchAtLoginBackground.checked = config.launchAtLoginBackground;
      launchAtLoginBackground.disabled =
        !config.launchAtLogin || !config.launchAtLoginBackgroundAvailable;
    }
    if (processAfterClose) processAfterClose.checked = config.enabled;
    if (continueHighCost) {
      continueHighCost.checked = config.continueHighCost;
      continueHighCost.disabled = !config.enabled;
    }
  };

  const save = async (
    next: Partial<StartupEnhancementConfig>,
  ): Promise<StartupEnhancementConfig> => {
    const previous = config;
    config = normalizeStartupEnhancementConfig({ ...config, ...next });
    render();
    try {
      const saved = await api.invoke("set_startup_enhancement_config", {
        request: config,
      });
      config = normalizeStartupEnhancementConfig(saved || config);
      render();
      return config;
    } catch (error: unknown) {
      config = previous;
      render();
      runtime.AppNotice?.show?.(String(error), {
        variant: "text",
        duration: 1800,
      });
      throw error;
    }
  };

  ignoreFailure(
    api
      .invoke("startup_enhancement_config")
      .then((loaded) => {
        config = normalizeStartupEnhancementConfig(loaded);
        render();
      })
      .catch(() => {
        render();
      }),
  );

  master?.addEventListener("change", () => {
    ignoreFailure(save({ ...config, enabled: master.checked }));
  });
  launchAtLogin?.addEventListener("change", () => {
    ignoreFailure(save({ ...config, launchAtLogin: launchAtLogin.checked }));
  });
  launchAtLoginBackground?.addEventListener("change", () => {
    ignoreFailure(
      save({
        ...config,
        launchAtLoginBackground: launchAtLoginBackground.checked,
      }),
    );
  });
  processAfterClose?.addEventListener("change", () => {
    ignoreFailure(save({ ...config, enabled: processAfterClose.checked }));
  });
  continueHighCost?.addEventListener("change", () => {
    ignoreFailure(save({ ...config, continueHighCost: continueHighCost.checked }));
  });
  gear?.addEventListener("click", () => modal?.classList.add("show"));
  close?.addEventListener("click", () => modal?.classList.remove("show"));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("show");
  });
  ignoreFailure(
    events.listen(
      "startup-enhancement-state",
      (event: TauriEvent<StartupEnhancementState>) => {
        const payload = record(event.payload);
        backgrounded = Boolean(payload?.backgrounded);
        config = normalizeStartupEnhancementConfig({
          ...config,
          continueHighCost: Boolean(payload?.continueHighCost),
        });
        highCostResumeAtMs = Number(payload?.highCostResumeAtMs) || 0;
      },
    ),
  );

  const globalApi: StartupEnhancementGlobalApi = {
    backgroundWorkAllowed: () =>
      (!backgrounded || config.continueHighCost) && now() >= highCostResumeAtMs,
    highCostRetryDelay: () =>
      backgrounded ? 0 : Math.max(0, highCostResumeAtMs - now()),
    snapshot: () => ({
      enabled: config.enabled,
      continueHighCost: config.continueHighCost,
      launchAtLogin: config.launchAtLogin,
      launchAtLoginBackground: config.launchAtLoginBackground,
    }),
  };
  runtime.ReaderStartupEnhancement = globalApi;
  return globalApi;
}

/** Classic installer replacing `ui/startup-enhancement-ui.js`. */
export function installStartupEnhancementUi(
  target: unknown,
  transport?: TauriTransport,
): StartupEnhancementGlobalApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      return null;
    }
  }
  return initializeStartupEnhancementUi(runtime, resolvedTransport);
}
