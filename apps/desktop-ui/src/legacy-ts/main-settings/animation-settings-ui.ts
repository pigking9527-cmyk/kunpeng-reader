interface AnimationSettingsApi {
  readonly STORAGE_KEY?: string;
  applyMain?(document: Document): void;
  read?(): Readonly<Record<string, unknown>>;
  set?(key: string, enabled: boolean): void;
}

interface AnimationSettingsUiApi {
  init(): void;
}

interface AnimationSettingsRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly ReaderAnimationSettings?: AnimationSettingsApi;
  ReaderAnimationSettingsUI?: AnimationSettingsUiApi;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): AnimationSettingsRuntime | null {
  const target = record(value);
  if (!target || !record(target.document) || typeof target.addEventListener !== "function") {
    return null;
  }
  return target as unknown as AnimationSettingsRuntime;
}

function htmlElement(value: Element | null): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement ? value : null;
}

function inputElement(value: Element | null): HTMLInputElement | null {
  return typeof HTMLInputElement !== "undefined" && value instanceof HTMLInputElement
    ? value
    : null;
}

export function createAnimationSettingsUi(
  runtime: AnimationSettingsRuntime,
): AnimationSettingsUiApi {
  const init = (): void => {
    const { document } = runtime;
    const commonSettingsModal = htmlElement(document.getElementById("fp-settings-modal"));
    const modal = htmlElement(document.getElementById("animation-settings-modal"));
    const closeButton = htmlElement(document.getElementById("animation-settings-close"));
    const masterInput = inputElement(document.getElementById("set-animation-master"));
    const settingInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-animation-setting]"),
    );
    const groupInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-animation-group]"),
    );

    const apply = (): void => runtime.ReaderAnimationSettings?.applyMain?.(document);
    const render = (): void => {
      const settings = runtime.ReaderAnimationSettings?.read?.() || {};
      const masterEnabled = settings.allAnimations !== false;
      if (masterInput) masterInput.checked = masterEnabled;
      groupInputs.forEach((input) => {
        const key = input.dataset.animationGroup;
        if (key) input.checked = settings[key] !== false;
        input.disabled = !masterEnabled;
      });
      settingInputs.forEach((input) => {
        const key = input.dataset.animationSetting;
        if (key) input.checked = settings[key] !== false;
        input.disabled = !masterEnabled;
      });
      document.querySelectorAll<HTMLElement>("[data-animation-group-section]").forEach(
        (section) => section.classList.toggle("animation-master-disabled", !masterEnabled),
      );
      apply();
    };
    const close = (returnToCommon = true): void => {
      modal?.classList.remove("show");
      if (returnToCommon) commonSettingsModal?.classList.add("show");
    };

    document.getElementById("animation-gear")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      render();
      modal?.classList.add("show");
    });
    masterInput?.addEventListener("change", () => {
      runtime.ReaderAnimationSettings?.set?.("allAnimations", masterInput.checked);
      render();
    });
    closeButton?.addEventListener("click", () => close(true));
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) close(true);
    });
    settingInputs.forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.animationSetting;
        if (key) runtime.ReaderAnimationSettings?.set?.(key, input.checked);
        render();
      });
    });
    groupInputs.forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.animationGroup;
        if (key) runtime.ReaderAnimationSettings?.set?.(key, input.checked);
        render();
      });
    });
    runtime.addEventListener("reader-animation-settings-changed", render);
    runtime.addEventListener("storage", (event) => {
      const storageEvent = event as StorageEvent;
      if (storageEvent.key === runtime.ReaderAnimationSettings?.STORAGE_KEY) render();
    });
    apply();
  };
  return Object.freeze({ init });
}

export function installAnimationSettingsUi(target: unknown): AnimationSettingsUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createAnimationSettingsUi(runtime);
  runtime.ReaderAnimationSettingsUI = api;
  api.init();
  return api;
}
