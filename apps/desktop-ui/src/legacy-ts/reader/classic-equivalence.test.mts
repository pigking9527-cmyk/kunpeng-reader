import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  appendReaderNavigationHistory,
  readerPageSignature,
  trackReaderPageDismissal,
} from "./navigation-rules.ts";
import {
  normalizeReaderJumpBackIconSize,
  normalizeReaderJumpBackPosition,
  readerJumpBackIconHeight,
  readerJumpBackTrackPoint,
} from "./jump-back-rules.ts";

interface ClassicNavigationRules {
  readonly appendHistory: typeof appendReaderNavigationHistory;
  readonly pageSignature: typeof readerPageSignature;
  readonly trackPageDismissal: typeof trackReaderPageDismissal;
}

interface ClassicJumpBackRules {
  readonly normalizePosition: typeof normalizeReaderJumpBackPosition;
  readonly normalizeIconSizePx: typeof normalizeReaderJumpBackIconSize;
  readonly iconHeightPx: typeof readerJumpBackIconHeight;
  readonly trackPoint: typeof readerJumpBackTrackPoint;
}

function loadClassicGlobal<T>(file: string, globalName: string): T {
  const source = readFileSync(new URL(`../../../../../ui/generated-ts/${file}`, import.meta.url), "utf8");
  const context: Record<string, unknown> = {};
  context.window = context;
  vm.runInNewContext(source, context);
  return context[globalName] as T;
}

test("strict navigation rules remain output-equivalent to the original classic script", () => {
  const classic = loadClassicGlobal<ClassicNavigationRules>(
    "reader-navigation-rules.js",
    "ReaderNavigationRules",
  );
  const fallback = { chapter: 4, chFrac: 0.25, progress: 42 };
  const points = [
    null,
    { chapter: 4, chFrac: 0.25005, progress: 99 },
    { chapter: -2, chFrac: 2, progress: -1 },
    { chapter: "3", chFrac: "0.5", progress: "75" },
  ] as const;
  let typedHistory: readonly { readonly chapter: number; readonly chFrac: number; readonly progress: number }[] = [];
  let classicHistory = typedHistory;
  for (const point of points) {
    const typed = appendReaderNavigationHistory(typedHistory, point, fallback, 3);
    const legacy = classic.appendHistory(classicHistory, point, fallback, 3);
    assert.deepEqual(structuredClone(typed), structuredClone(legacy));
    typedHistory = typed.history;
    classicHistory = legacy.history;
  }

  const position = { gPage: 12, page: 4, chapter: 2 };
  assert.equal(readerPageSignature(position), classic.pageSignature(position));
  const dismissal = { visible: true, awaitingLanding: true, lastPageSignature: "", pagesMoved: 4 };
  assert.deepEqual(
    structuredClone(trackReaderPageDismissal(dismissal, position, 2)),
    structuredClone(classic.trackPageDismissal(dismissal, position, 2)),
  );
});

test("strict jump-back geometry remains output-equivalent to the original classic script", () => {
  const classic = loadClassicGlobal<ClassicJumpBackRules>(
    "reader-jump-back-rules.js",
    "ReaderJumpBackRules",
  );
  for (const value of [-10, 0, 31.7, 159.8, 200, "bad", undefined]) {
    assert.equal(normalizeReaderJumpBackPosition(value, 500), classic.normalizePosition(value, 500));
    assert.equal(normalizeReaderJumpBackIconSize(value), classic.normalizeIconSizePx(value));
    assert.equal(readerJumpBackIconHeight(value), classic.iconHeightPx(value));
  }
  assert.equal(readerJumpBackTrackPoint(1000, 40, 60, 500), classic.trackPoint(1000, 40, 60, 500));
});
