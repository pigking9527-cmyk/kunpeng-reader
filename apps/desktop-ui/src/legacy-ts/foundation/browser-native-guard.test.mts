import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITABLE_NATIVE_SELECTION_SELECTOR,
  elementForNativeSelection,
  installBrowserNativeGuardOnDocument,
} from "./browser-native-guard.ts";

interface ListenerRecord {
  readonly type: string;
  readonly listener: (event: Event) => void;
  readonly capture: boolean;
}

test("native guard blocks drag and blocks selection outside the legacy editable selector", () => {
  const listeners: ListenerRecord[] = [];
  const document = {
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      capture: boolean,
    ) => {
      if (typeof listener === "function") listeners.push({ type, listener, capture });
    },
  } as unknown as Document;
  installBrowserNativeGuardOnDocument(document);
  assert.deepEqual(
    listeners.map(({ type, capture }) => ({ type, capture })),
    [
      { type: "dragstart", capture: true },
      { type: "selectstart", capture: true },
    ],
  );
  let dragPrevented = 0;
  listeners[0]?.listener({
    preventDefault: () => {
      dragPrevented += 1;
    },
  } as unknown as Event);
  assert.equal(dragPrevented, 1);

  let selectionPrevented = 0;
  listeners[1]?.listener({
    target: null,
    preventDefault: () => {
      selectionPrevented += 1;
    },
  } as unknown as Event);
  assert.equal(selectionPrevented, 1);
  assert.equal(elementForNativeSelection(null), null);
  assert.equal(
    EDITABLE_NATIVE_SELECTION_SELECTOR,
    'input, textarea, [contenteditable="true"], [data-native-selection]',
  );
});
