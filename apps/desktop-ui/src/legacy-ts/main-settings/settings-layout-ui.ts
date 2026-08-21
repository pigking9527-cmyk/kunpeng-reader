interface SettingsLayoutI18n {
  t?(key: string): string;
}

interface SettingsLayoutApi {
  activateSection(id: string | undefined, persist?: boolean): void;
  syncShelfPreview(): void;
  applyNavState(): void;
}

interface SettingsLayoutRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Storage;
  readonly ReaderAppI18n?: SettingsLayoutI18n;
  ReaderSettingsLayoutUI?: SettingsLayoutApi;
  addEventListener?(type: string, listener: () => void): void;
}

const STORAGE_KEY = "commonSettingsSectionV1";
const NAV_COLLAPSED_KEY = "commonSettingsNavCollapsedV1";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): SettingsLayoutRuntime | null {
  const target = record(value);
  if (!target || !record(target.document) || !record(target.localStorage)) return null;
  return target as unknown as SettingsLayoutRuntime;
}

function htmlElement(value: Element | null): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement ? value : null;
}

function inputElement(value: Element | null): HTMLInputElement | null {
  return typeof HTMLInputElement !== "undefined" && value instanceof HTMLInputElement
    ? value
    : null;
}

export function initializeSettingsLayout(
  runtime: SettingsLayoutRuntime,
): SettingsLayoutApi | null {
  const { document, localStorage } = runtime;
  const modal = htmlElement(document.getElementById("fp-settings-modal"));
  if (!modal) return null;

  const settingsCard = htmlElement(modal.querySelector(".fp-settings-card"));
  const navToggle = htmlElement(modal.querySelector("#fp-settings-nav-toggle"));
  const sectionButtons = Array.from(
    modal.querySelectorAll<HTMLElement>("[data-settings-section]"),
  );
  const panels = Array.from(
    modal.querySelectorAll<HTMLElement>("[data-settings-panel]"),
  );
  const sectionIds = sectionButtons.map((button) => button.dataset.settingsSection);
  let navCollapsed = false;
  try {
    navCollapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  } catch {
    // The original UI keeps working when browser storage is unavailable.
  }

  const navText = (key: string, fallback: string): string => {
    const translated = runtime.ReaderAppI18n?.t?.(key);
    return translated && translated !== key ? translated : fallback;
  };

  const applyNavState = (): void => {
    settingsCard?.classList.toggle("nav-collapsed", navCollapsed);
    if (!navToggle) return;
    const expanded = !navCollapsed;
    const label = navText(
      expanded ? "settingsCollapseNavigation" : "settingsExpandNavigation",
      expanded ? "收起分类" : "展开分类",
    );
    navToggle.setAttribute("aria-expanded", String(expanded));
    navToggle.setAttribute("aria-label", label);
    navToggle.title = label;
  };

  const activateSection = (id: string | undefined, persist = true): void => {
    const selected = sectionIds.includes(id) ? id : sectionIds[0];
    sectionButtons.forEach((button) => {
      const active = button.dataset.settingsSection === selected;
      button.setAttribute("aria-selected", String(active));
      button.classList.toggle("active", active);
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== selected;
    });
    if (persist && selected !== undefined) localStorage.setItem(STORAGE_KEY, selected);
  };

  sectionButtons.forEach((button) =>
    button.addEventListener("click", () => activateSection(button.dataset.settingsSection)),
  );
  navToggle?.addEventListener("click", () => {
    navCollapsed = !navCollapsed;
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0");
    } catch {
      // The visual state remains usable without persistence.
    }
    applyNavState();
  });
  runtime.addEventListener?.("app-language-changed", applyNavState);
  activateSection(localStorage.getItem(STORAGE_KEY) ?? undefined, false);
  applyNavState();

  const previewBindings = Object.freeze([
    Object.freeze({ input: "set-cover-title", targets: ["fp-shelf-preview-title"] }),
    Object.freeze({
      input: "set-cover-prog",
      targets: ["fp-shelf-preview-progress", "fp-shelf-preview-progress-bar"],
    }),
    Object.freeze({ input: "set-cover-rating", targets: ["fp-shelf-preview-rating"] }),
  ]);
  const syncShelfPreview = (): void => {
    previewBindings.forEach(({ input, targets }) => {
      const control = inputElement(document.getElementById(input));
      targets.forEach((targetId) => {
        const target = htmlElement(document.getElementById(targetId));
        if (target && control) target.hidden = !control.checked;
      });
    });
  };
  previewBindings.forEach(({ input }) =>
    document.getElementById(input)?.addEventListener("change", syncShelfPreview),
  );
  syncShelfPreview();

  return Object.freeze({ activateSection, syncShelfPreview, applyNavState });
}

/** Installs the controller over the existing original settings DOM. */
export function installSettingsLayout(target: unknown): SettingsLayoutApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = initializeSettingsLayout(runtime);
  if (api) runtime.ReaderSettingsLayoutUI = api;
  return api;
}
