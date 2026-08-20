import assert from "node:assert/strict";
import test from "node:test";
import {
  appendReaderNavigationHistory,
  normalizeReaderNavigationPoint,
  readerPageSignature,
  trackReaderPageDismissal,
} from "./navigation-rules.ts";

test("navigation points preserve classic coercion, bounds, and duplicate threshold", () => {
  const fallback = { chapter: 4, chFrac: 0.25, progress: 42 };
  const first = appendReaderNavigationHistory([], null, fallback);
  assert.deepEqual(first.point, fallback);
  assert.equal(first.added, true);
  const duplicate = appendReaderNavigationHistory(
    first.history,
    { chapter: 4, chFrac: 0.25005, progress: 99 },
    fallback,
  );
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.history.length, 1);
  assert.deepEqual(normalizeReaderNavigationPoint({ chapter: -2, chFrac: 2, progress: -1 }), {
    chapter: 0,
    chFrac: 1,
    progress: 0,
  });
});

test("navigation history retains only the existing bounded tail", () => {
  const bounded = appendReaderNavigationHistory(
    [
      { chapter: 0, chFrac: 0, progress: 0 },
      { chapter: 1, chFrac: 0, progress: 1 },
    ],
    { chapter: -2, chFrac: 2, progress: -1 },
    {},
    2,
  );
  assert.deepEqual(bounded.history, [
    { chapter: 1, chFrac: 0, progress: 1 },
    { chapter: 0, chFrac: 1, progress: 0 },
  ]);
});

test("page dismissal ignores landing and counts only subsequent page changes", () => {
  assert.equal(readerPageSignature({ gPage: 12, page: 4, chapter: 2 }), "12_4_2");
  const landed = trackReaderPageDismissal(
    { visible: true, awaitingLanding: true, lastPageSignature: "", pagesMoved: 8 },
    { gPage: 12, page: 4, chapter: 2 },
    2,
  );
  assert.deepEqual(landed, {
    visible: true,
    awaitingLanding: false,
    lastPageSignature: "12_4_2",
    pagesMoved: 0,
    dismissed: false,
  });
  const onePage = trackReaderPageDismissal(landed, { gPage: 13, page: 5, chapter: 2 }, 2);
  const dismissed = trackReaderPageDismissal(onePage, { gPage: 14, page: 6, chapter: 2 }, 2);
  assert.deepEqual(dismissed, {
    visible: false,
    awaitingLanding: false,
    lastPageSignature: "",
    pagesMoved: 0,
    dismissed: true,
  });
});
