import assert from "node:assert/strict";
import test from "node:test";

import {
  ANIMATION_STORAGE_KEY,
  createAnimationSettingsApi,
  readAnimationSettings,
  type StorageLike,
} from "./animation-settings.ts";

function storage(values: Record<string, string> = {}): StorageLike {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

test("legacy stored disabled groups disable their children", () => {
  const settings = readAnimationSettings(
    storage({ [ANIMATION_STORAGE_KEY]: JSON.stringify({ mainWindow: false }) }),
  );
  assert.equal(settings.mainWindow, false);
  assert.equal(settings.searchPopup, false);
  assert.equal(settings.booklistSort, false);
});

test("reader page turn opt-in restores only the requested reader effect", () => {
  const data: Record<string, string> = {
    [ANIMATION_STORAGE_KEY]: JSON.stringify({ readerPage: false }),
  };
  const events: Event[] = [];
  const api = createAnimationSettingsApi({
    localStorage: storage(data),
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  });
  const result = api.setPageTurnFromReader(true);
  assert.equal(result.readerPage, true);
  assert.equal(result.pageTurn, true);
  assert.equal(result.annotationAdd, false);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(data.readerSettings ?? "{}").pageTurnEffect, "horizontal");
});
