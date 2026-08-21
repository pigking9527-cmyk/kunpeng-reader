export type OverlayRole = "operation" | "information" | "critical" | "feedback";
type OverlayBand = "interactive" | "critical" | "feedback";

export const ROLE_BASE: Readonly<Record<OverlayRole, number>> = Object.freeze({
  operation: 100_000,
  information: 100_000,
  critical: 300_000,
  feedback: 400_000,
});

const ROLE_BAND: Readonly<Record<OverlayRole, OverlayBand>> = Object.freeze({
  operation: "interactive",
  information: "interactive",
  critical: "critical",
  feedback: "feedback",
});

export interface OverlayEntry {
  readonly order?: unknown;
  readonly role?: unknown;
}

export interface OverlayMountTarget {
  readonly document?: Document;
  readonly MutationObserver?: typeof MutationObserver;
}

export interface OverlayMountHandle {
  readonly sync: () => void;
  readonly disconnect: () => void;
}

export function normalizeRole(value: unknown): OverlayRole {
  return typeof value === "string" && Object.hasOwn(ROLE_BASE, value)
    ? (value as OverlayRole)
    : "operation";
}

export function computeLevels(entries: readonly OverlayEntry[]): number[] {
  const levels = new Array<number>(entries.length);
  (["interactive", "critical", "feedback"] as const).forEach((band) => {
    entries
      .map((entry, index) => ({
        index,
        order: Number(entry.order) || 0,
        role: normalizeRole(entry.role),
      }))
      .filter((entry) => ROLE_BAND[entry.role] === band)
      .sort((left, right) => left.order - right.order)
      .forEach((entry, bandIndex) => {
        levels[entry.index] = ROLE_BASE[entry.role] + bandIndex;
      });
  });
  return levels;
}

export function mountOverlayStack(
  global: OverlayMountTarget,
): OverlayMountHandle | null {
  const candidateDocument = global.document;
  const Observer = global.MutationObserver;
  if (!candidateDocument?.documentElement || typeof Observer !== "function") return null;
  const document = candidateDocument;

  let nextOrder = 1;
  const openOrder = new WeakMap<Element, number>();

  function visibleSurfaces(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.modal.show, [data-overlay-surface].show, [data-overlay-surface][data-overlay-active="true"]',
      ),
    ).filter((surface) => !surface.hidden);
  }

  function sync(): void {
    const visible = visibleSurfaces();
    const visibleSet = new Set<Element>(visible);
    document
      .querySelectorAll<HTMLElement>('[data-overlay-managed="true"]')
      .forEach((surface) => {
        if (visibleSet.has(surface)) return;
        openOrder.delete(surface);
        surface.removeAttribute("data-overlay-managed");
        surface.style.removeProperty("--overlay-z-index");
      });

    const entries = visible.map((surface) => {
      if (!openOrder.has(surface)) openOrder.set(surface, nextOrder++);
      return {
        order: openOrder.get(surface),
        role: surface.dataset.overlayRole,
      };
    });
    const levels = computeLevels(entries);
    visible.forEach((surface, index) => {
      surface.dataset.overlayManaged = "true";
      surface.style.setProperty(
        "--overlay-z-index",
        String(levels[index] ?? ROLE_BASE.operation),
      );
    });
  }

  const observer = new Observer(sync);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "class",
      "hidden",
      "data-overlay-role",
      "data-overlay-active",
    ],
  });
  sync();
  return Object.freeze({ sync, disconnect: () => observer.disconnect() });
}

export const overlayStack = Object.freeze({
  ROLE_BASE,
  normalizeRole,
  computeLevels,
  mount: mountOverlayStack,
});

export type OverlayStackApi = typeof overlayStack;

export function installOverlayStack(
  target: OverlayMountTarget & Record<string, unknown>,
): OverlayStackApi {
  target.ReaderOverlayStack = overlayStack;
  mountOverlayStack(target);
  return overlayStack;
}
