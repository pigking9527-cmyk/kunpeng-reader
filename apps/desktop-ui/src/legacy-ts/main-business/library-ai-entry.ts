interface LibraryAiAssistant {
  load(): Promise<unknown>;
  refreshBooks(): Promise<unknown>;
}

interface LibraryAiUi {
  init(options: { readonly root: Document }): LibraryAiAssistant | null;
}

interface NewsUiInstance {
  close(): void;
}

interface LibraryAiEntryApi {
  readonly assistant: LibraryAiAssistant;
  open(): Promise<void>;
  close(options?: { readonly focus?: boolean }): void;
  toggle(): void;
}

interface LibraryAiEntryRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly ReaderLibraryAiUI?: LibraryAiUi;
  readonly ReaderNewsUI?: { readonly instance?: NewsUiInstance };
  readonly ReaderIntelligenceWorkspace?: {
    readonly instance?: {
      readonly close?: (options?: { readonly focus?: boolean }) => void;
    };
  };
  ReaderLibraryAiEntry?: LibraryAiEntryApi;
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): LibraryAiEntryRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || typeof runtime.addEventListener !== "function") {
    return null;
  }
  return runtime as unknown as LibraryAiEntryRuntime;
}

function elementWithHidden(value: Element | null): (HTMLElement & { hidden: boolean }) | null {
  const candidate = record(value);
  return candidate && "hidden" in candidate
    ? (value as HTMLElement & { hidden: boolean })
    : null;
}

export function createLibraryAiEntry(
  runtime: LibraryAiEntryRuntime,
): LibraryAiEntryApi | null {
  const root = runtime.document;
  const button = root.getElementById("library-ai-toolbar-btn");
  const page = elementWithHidden(root.getElementById("library-ai-page"));
  const back = root.getElementById("library-ai-back");
  const shell = elementWithHidden(root.querySelector(".content-shell"));
  if (!button || !page || !back || !shell || !runtime.ReaderLibraryAiUI) return null;

  const assistant = runtime.ReaderLibraryAiUI.init({ root });
  if (!assistant) return null;
  let initialLoad: Promise<unknown> | null = null;

  const open = async (): Promise<void> => {
    root.getElementById("menu")?.classList.remove("show");
    root.getElementById("filter-panel")?.classList.remove("show");
    root.getElementById("account-panel")?.classList.remove("show");
    const newsPage = elementWithHidden(root.getElementById("newsnow-page"));
    if (newsPage && !newsPage.hidden) runtime.ReaderNewsUI?.instance?.close();
    const intelligencePage = elementWithHidden(root.getElementById("intelligence-workspace-page"));
    if (intelligencePage && !intelligencePage.hidden) {
      runtime.ReaderIntelligenceWorkspace?.instance?.close?.({ focus: false });
    }
    shell.hidden = true;
    page.hidden = false;
    root.body.classList.add("library-ai-active");
    button.setAttribute("aria-pressed", "true");
    if (!initialLoad) {
      initialLoad = assistant.load();
      await initialLoad;
    } else {
      await initialLoad;
      await assistant.refreshBooks();
    }
  };

  const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
    page.hidden = true;
    shell.hidden = false;
    root.body.classList.remove("library-ai-active");
    button.setAttribute("aria-pressed", "false");
    if (focus && "focus" in button && typeof button.focus === "function") {
      button.focus({ preventScroll: true });
    }
  };

  const toggle = (): void => {
    if (page.hidden) void open();
    else close();
  };

  button.addEventListener("click", toggle);
  back.addEventListener("click", () => close());
  runtime.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !page.hidden) close();
  });
  return Object.freeze({ open, close, toggle, assistant });
}

export function installLibraryAiEntry(target: unknown = globalThis): LibraryAiEntryApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const entry = createLibraryAiEntry(runtime);
  if (entry) runtime.ReaderLibraryAiEntry = entry;
  return entry;
}
