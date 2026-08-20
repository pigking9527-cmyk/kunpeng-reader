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

function ignoreFailure(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

export function initializeTitlebar(
  document: Document,
  navigatorValue: unknown,
  controls: WindowControls | null,
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
    ignoreFailure(controls.minimize());
  });
  maxButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    ignoreFailure(controls.toggleMaximize());
  });
  closeButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    ignoreFailure(controls.close());
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
  );
}
