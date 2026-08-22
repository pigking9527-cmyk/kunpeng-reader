import {
  createWindowControls,
  transportFromTauriGlobal,
  type TauriTransport,
  type WindowControls,
} from "../../../../../packages/tauri-api/src/index.js";

interface NavigatorDataShape {
  readonly platform?: unknown;
}

interface NavigatorShape {
  readonly userAgentData?: NavigatorDataShape;
  readonly platform?: unknown;
  readonly userAgent?: unknown;
}

type WindowControlTrace = (
  control: "minimize" | "maximize" | "close",
  phase: "click" | "command",
  outcome:
    | "requested"
    | "ok"
    | "failed_arguments"
    | "failed_command"
    | "failed_permission"
    | "failed_window"
    | "failed_other",
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runtimeDocument(target: unknown): Document | null {
  if (!isRecord(target) || !isRecord(target.document)) return null;
  return target.document as unknown as Document;
}

function runtimeNavigator(target: unknown): unknown {
  return isRecord(target) ? target.navigator : undefined;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function platformDescription(navigatorValue: unknown): string {
  if (!isRecord(navigatorValue)) return "";
  const navigator = navigatorValue as NavigatorShape;
  return (
    optionalString(navigator.userAgentData?.platform) ||
    optionalString(navigator.platform) ||
    optionalString(navigator.userAgent)
  );
}

function controlsFromRuntime(
  target: unknown,
  transport?: TauriTransport,
): WindowControls | null {
  try {
    return createWindowControls(transport ?? transportFromTauriGlobal(target));
  } catch {
    return null;
  }
}

function traceWindowControls(target: unknown): WindowControlTrace {
  return (control, phase, outcome) => {
    if (!isRecord(target) || !isRecord(target.ReaderProblemTraceUI)) return;
    const record = target.ReaderProblemTraceUI.recordWindowControl;
    if (typeof record === "function")
      record.call(target.ReaderProblemTraceUI, control, phase, outcome);
  };
}

function windowControlFailure(error: unknown): Extract<
  Parameters<WindowControlTrace>[2],
  `failed_${string}`
> {
  const message = String(error || "").toLowerCase();
  if (/invalid args|missing required|deserialize|argument/u.test(message))
    return "failed_arguments";
  if (/not allowed|permission|capability/u.test(message)) return "failed_permission";
  if (/not found|not registered|unknown command/u.test(message)) return "failed_command";
  if (/window|webview|label/u.test(message)) return "failed_window";
  return "failed_other";
}

function runWindowControl(
  trace: WindowControlTrace | undefined,
  control: "minimize" | "maximize" | "close",
  task: Promise<unknown>,
): void {
  trace?.(control, "click", "requested");
  void task.then(
    () => trace?.(control, "command", "ok"),
    (error) => trace?.(control, "command", windowControlFailure(error)),
  );
}

export function initializeTitlebar(
  document: Document,
  navigatorValue: unknown,
  controls: WindowControls | null,
  trace?: WindowControlTrace,
): void {
  document.documentElement?.classList.toggle(
    "platform-macos",
    /mac/i.test(platformDescription(navigatorValue)),
  );
  if (!controls) return;

  const minButton = document.getElementById("win-min");
  const maxButton = document.getElementById("win-max");
  const closeButton = document.getElementById("win-close");

  minButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    runWindowControl(trace, "minimize", controls.minimize());
  });
  maxButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    runWindowControl(trace, "maximize", controls.toggleMaximize());
  });
  closeButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    runWindowControl(trace, "close", controls.close());
  });
}

/** Classic-script installer replacing `ui/titlebar.js` without changing its DOM. */
export function installTitlebar(target: unknown, transport?: TauriTransport): void {
  const document = runtimeDocument(target);
  if (!document) return;
  initializeTitlebar(
    document,
    runtimeNavigator(target),
    controlsFromRuntime(target, transport),
    traceWindowControls(target),
  );
}
