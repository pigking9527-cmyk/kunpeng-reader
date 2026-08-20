export interface NoticeOptions {
  readonly variant?: unknown;
  readonly onAction?: unknown;
  readonly actionLabel?: unknown;
  readonly duration?: unknown;
}

export interface AppNoticeApi {
  hide(): void;
  show(text: unknown, options?: NoticeOptions): void;
}

interface NoticeRuntime extends Record<string, unknown> {
  readonly document: Document;
  clearTimeout(timer: ReturnType<typeof setTimeout> | 0): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  AppNotice?: AppNoticeApi;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): NoticeRuntime | null {
  const target = record(value);
  if (
    !target ||
    !record(target.document) ||
    typeof target.clearTimeout !== "function" ||
    typeof target.setTimeout !== "function" ||
    typeof target.requestAnimationFrame !== "function"
  ) {
    return null;
  }
  return target as unknown as NoticeRuntime;
}

export function createAppNotice(runtime: NoticeRuntime): AppNoticeApi {
  let notice: HTMLDivElement | null = null;
  let message: HTMLSpanElement | null = null;
  let action: HTMLButtonElement | null = null;
  let close: HTMLButtonElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let actionHandler: (() => void) | null = null;

  const hide = (): void => {
    runtime.clearTimeout(hideTimer);
    hideTimer = 0;
    actionHandler = null;
    notice?.classList.remove("show");
  };

  const ensureNotice = (): void => {
    if (notice) return;
    notice = runtime.document.createElement("div");
    notice.className = "app-notice";
    notice.dataset.overlaySurface = "notice";
    notice.dataset.overlayRole = "feedback";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    message = runtime.document.createElement("span");
    message.className = "app-notice-message";
    action = runtime.document.createElement("button");
    action.className = "app-notice-action";
    action.type = "button";
    close = runtime.document.createElement("button");
    close.className = "app-notice-close";
    close.type = "button";
    close.setAttribute("aria-label", "关闭提示");
    close.textContent = "×";
    action.addEventListener("click", () => {
      const callback = actionHandler;
      hide();
      if (callback) callback();
    });
    close.addEventListener("click", hide);
    notice.append(message, action, close);
    runtime.document.body.appendChild(notice);
  };

  const show = (text: unknown, options: NoticeOptions = {}): void => {
    ensureNotice();
    runtime.clearTimeout(hideTimer);
    const textOnly = options.variant === "text";
    if (!notice || !message || !action || !close) return;
    message.textContent = String(text || "");
    actionHandler =
      typeof options.onAction === "function"
        ? (options.onAction as () => void)
        : null;
    action.textContent = actionHandler ? String(options.actionLabel || "查看") : "";
    action.hidden = textOnly || !actionHandler;
    close.hidden = textOnly;
    notice.classList.toggle("text-only", textOnly);
    notice.classList.remove("show");
    const duration = Number(options.duration) || (actionHandler ? 6_000 : 3_600);
    notice.style.setProperty("--notice-duration", `${Math.max(300, duration)}ms`);
    runtime.requestAnimationFrame(() => notice?.classList.add("show"));
    hideTimer = runtime.setTimeout(hide, Math.max(300, duration));
  };

  return Object.freeze({ hide, show });
}

/** Classic installer replacing `ui/notice-ui.js`. */
export function installNoticeUi(target: unknown): AppNoticeApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createAppNotice(runtime);
  runtime.AppNotice = api;
  return api;
}
