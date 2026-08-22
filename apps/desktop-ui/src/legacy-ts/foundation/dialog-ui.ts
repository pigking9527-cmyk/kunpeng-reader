export type DialogTone = "info" | "success" | "warning" | "error";

export interface DialogOptions {
  readonly tone?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
  readonly cancelLabel?: unknown;
  readonly confirmLabel?: unknown;
}

export interface AppDialogApi {
  alert(message: unknown, options?: DialogOptions): Promise<boolean>;
  confirm(message: unknown, options?: DialogOptions): Promise<boolean>;
}

interface DialogRuntime extends Record<string, unknown> {
  readonly document: Document;
  clearTimeout(timer: ReturnType<typeof setTimeout> | 0): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  addEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
  AppDialog?: AppDialogApi;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): DialogRuntime | null {
  const target = record(value);
  if (
    !target ||
    !record(target.document) ||
    typeof target.clearTimeout !== "function" ||
    typeof target.setTimeout !== "function" ||
    typeof target.requestAnimationFrame !== "function" ||
    typeof target.addEventListener !== "function"
  ) {
    return null;
  }
  return target as unknown as DialogRuntime;
}

export function createAppDialog(runtime: DialogRuntime): AppDialogApi {
  let backdrop: HTMLDivElement | null = null;
  let card: HTMLElement | null = null;
  let icon: HTMLSpanElement | null = null;
  let title: HTMLHeadingElement | null = null;
  let message: HTMLDivElement | null = null;
  let cancelButton: HTMLButtonElement | null = null;
  let confirmButton: HTMLButtonElement | null = null;
  let activeResolve: ((result: boolean) => void) | null = null;
  let previousFocus: Element | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | 0 = 0;

  const focus = (element: Element | null): void => {
    const candidate = element as (Element & { focus?: unknown }) | null;
    if (typeof candidate?.focus === "function") candidate.focus();
  };

  const finish = (result: boolean): void => {
    if (!backdrop?.classList.contains("show")) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
    const resolve = activeResolve;
    activeResolve = null;
    runtime.clearTimeout(hideTimer);
    hideTimer = runtime.setTimeout(() => {
      if (backdrop) backdrop.hidden = true;
    }, 170);
    focus(previousFocus);
    previousFocus = null;
    resolve?.(result);
  };

  const ensureDialog = (): void => {
    if (backdrop) return;
    backdrop = runtime.document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    backdrop.dataset.overlaySurface = "dialog";
    backdrop.dataset.overlayRole = "critical";
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");
    card = runtime.document.createElement("section");
    card.className = "app-dialog";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "app-dialog-title");
    card.setAttribute("aria-describedby", "app-dialog-message");
    const heading = runtime.document.createElement("header");
    heading.className = "app-dialog-heading";
    icon = runtime.document.createElement("span");
    icon.className = "app-dialog-icon";
    icon.setAttribute("aria-hidden", "true");
    title = runtime.document.createElement("h2");
    title.id = "app-dialog-title";
    heading.append(icon, title);
    message = runtime.document.createElement("div");
    message.id = "app-dialog-message";
    message.className = "app-dialog-message";
    const actions = runtime.document.createElement("footer");
    actions.className = "app-dialog-actions";
    cancelButton = runtime.document.createElement("button");
    cancelButton.className = "app-dialog-button app-dialog-cancel";
    cancelButton.type = "button";
    confirmButton = runtime.document.createElement("button");
    confirmButton.className = "app-dialog-button app-dialog-confirm";
    confirmButton.type = "button";
    actions.append(cancelButton, confirmButton);
    card.append(heading, message, actions);
    backdrop.append(card);
    runtime.document.body.appendChild(backdrop);
    cancelButton.addEventListener("click", () => finish(false));
    confirmButton.addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(false);
    });
    runtime.addEventListener("keydown", (event) => {
      if (!backdrop?.classList.contains("show")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
  };

  const open = (options: DialogOptions = {}): Promise<boolean> => {
    ensureDialog();
    if (activeResolve) finish(false);
    runtime.clearTimeout(hideTimer);
    hideTimer = 0;
    previousFocus = runtime.document.activeElement;
    if (!backdrop || !card || !icon || !title || !message || !cancelButton || !confirmButton) {
      return Promise.resolve(false);
    }
    const tones = ["info", "success", "warning", "error"] as const;
    const tone: DialogTone = (tones as readonly unknown[]).includes(options.tone)
      ? (options.tone as DialogTone)
      : "info";
    card.dataset.tone = tone;
    icon.textContent = { info: "i", success: "✓", warning: "!", error: "!" }[tone];
    title.textContent = String(options.title || "提示");
    message.textContent = String(options.message || "");
    cancelButton.textContent = String(options.cancelLabel || "取消");
    confirmButton.textContent = String(options.confirmLabel || "确定");
    cancelButton.hidden = options.cancelLabel === null;
    backdrop.hidden = false;
    backdrop.setAttribute("aria-hidden", "false");
    void backdrop.offsetWidth;
    backdrop.classList.add("show");
    runtime.requestAnimationFrame(() => confirmButton?.focus());
    return new Promise((resolve) => {
      activeResolve = resolve;
    });
  };

  const alert = (messageText: unknown, options: DialogOptions = {}): Promise<boolean> =>
    open({ ...options, message: messageText, cancelLabel: null });
  const confirm = (messageText: unknown, options: DialogOptions = {}): Promise<boolean> =>
    open({ ...options, message: messageText });
  return Object.freeze({ alert, confirm });
}

/** Classic installer replacing `ui/dialog-ui.js`. */
export function installDialogUi(target: unknown): AppDialogApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createAppDialog(runtime);
  runtime.AppDialog = api;
  return api;
}
