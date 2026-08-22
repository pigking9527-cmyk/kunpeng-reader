export const EDITABLE_NATIVE_SELECTION_SELECTOR =
  'input, textarea, [contenteditable="true"], [data-native-selection]';

interface ParentElementTarget {
  readonly parentElement?: Element | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runtimeDocument(target: unknown): Document | null {
  if (!isRecord(target) || !isRecord(target.document)) return null;
  return target.document as unknown as Document;
}

export function elementForNativeSelection(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) return target;
  if (!isRecord(target)) return null;
  const parent = (target as ParentElementTarget).parentElement;
  return typeof Element !== "undefined" && parent instanceof Element ? parent : null;
}

export function installBrowserNativeGuardOnDocument(document: Document): void {
  document.addEventListener(
    "dragstart",
    (event) => event.preventDefault(),
    true,
  );
  document.addEventListener(
    "selectstart",
    (event) => {
      if (
        elementForNativeSelection(event.target)?.closest(
          EDITABLE_NATIVE_SELECTION_SELECTOR,
        )
      ) {
        return;
      }
      event.preventDefault();
    },
    true,
  );
}

/** Classic installer replacing `ui/browser-native-guard.js`. */
export function installBrowserNativeGuard(target: unknown): void {
  const document = runtimeDocument(target);
  if (document) installBrowserNativeGuardOnDocument(document);
}
