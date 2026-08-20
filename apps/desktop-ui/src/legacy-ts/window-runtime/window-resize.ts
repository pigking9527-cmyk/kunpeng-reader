import {
  createWindowControls,
  transportFromTauriGlobal,
  type TauriTransport,
  type WindowControls,
  type WindowResizeDirection,
} from "../../../../../packages/tauri-api/src/index.js";

export const WINDOW_RESIZE_DIRECTIONS = Object.freeze<readonly WindowResizeDirection[]>([
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runtimeDocument(target: unknown): Document | null {
  if (!isRecord(target) || !isRecord(target.document)) return null;
  return target.document as unknown as Document;
}

function userAgent(target: unknown): string {
  if (!isRecord(target) || !isRecord(target.navigator)) return "";
  return typeof target.navigator.userAgent === "string" ? target.navigator.userAgent : "";
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

function isResizeDirection(value: string | undefined): value is WindowResizeDirection {
  return WINDOW_RESIZE_DIRECTIONS.some((direction) => direction === value);
}

function resizeDirectionFromTarget(value: EventTarget | null): string | undefined {
  if (!isRecord(value) || !isRecord(value.dataset)) return undefined;
  return typeof value.dataset.resizeDirection === "string"
    ? value.dataset.resizeDirection
    : undefined;
}

function ignoreFailure(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

export function installLinuxResizeHandles(
  document: Document,
  controls: WindowControls,
): void {
  const beginResize = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const direction = resizeDirectionFromTarget(event.currentTarget);
    if (!isResizeDirection(direction)) return;
    event.preventDefault();
    event.stopPropagation();
    ignoreFailure(controls.startResizeDragging(direction));
  };

  const installHandles = (): void => {
    if (!document.body || document.getElementById("window-resize-handles")) return;
    const container = document.createElement("div");
    container.id = "window-resize-handles";
    container.setAttribute("aria-hidden", "true");
    for (const direction of WINDOW_RESIZE_DIRECTIONS) {
      const handle = document.createElement("div");
      handle.className = "window-resize-handle";
      handle.dataset.resizeDirection = direction;
      handle.addEventListener("pointerdown", beginResize);
      container.appendChild(handle);
    }
    document.body.appendChild(container);
  };

  if (document.body) installHandles();
  else document.addEventListener("DOMContentLoaded", installHandles, { once: true });
}

/** Classic-script installer replacing `ui/window-resize.js`. */
export function installWindowResize(target: unknown, transport?: TauriTransport): void {
  const controls = controlsFromRuntime(target, transport);
  const document = runtimeDocument(target);
  if (!controls || !document || !/Linux/i.test(userAgent(target))) return;
  installLinuxResizeHandles(document, controls);
}
