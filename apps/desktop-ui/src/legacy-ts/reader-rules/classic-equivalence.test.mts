import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installReaderAiHistoryRules,
} from "./reader-ai-history-rules.ts";
import type {
  ReaderAiHistoryRulesApi,
} from "./reader-ai-history-rules.ts";
import {
  installReaderPreferenceColorRules,
} from "./reader-preference-color-rules.ts";
import type {
  ReaderPreferenceColorRulesApi,
} from "./reader-preference-color-rules.ts";

function loadClassicApi<T>(filename: string, globalName: string): T {
  const source = readFileSync(new URL(`../../../../../ui/generated-ts/${filename}`, import.meta.url), "utf8");
  const target: Record<string, unknown> = {};
  target.window = target;
  vm.runInNewContext(source, target);
  return target[globalName] as T;
}

function neutral<T>(value: T): T {
  return structuredClone(value);
}

test("AI history installer retains the exact classic API and merge semantics", () => {
  const classic = loadClassicApi<ReaderAiHistoryRulesApi>(
    "reader-ai-history-rules.js",
    "ReaderAiHistoryRules",
  );
  const target: Record<string, unknown> = {};
  const typed = installReaderAiHistoryRules(target);
  assert.equal(target.ReaderAiHistoryRules, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());
  assert.equal(typed.TOMBSTONE_LIMIT, classic.TOMBSTONE_LIMIT);

  const first = [
    { id: "live", at: "2026-01-01", content: "old" },
    { at: "2025-01-01", content: "legacy" },
    null,
  ];
  const second = [
    { id: "live", at: "2026-02-01", content: "new" },
    { id: "gone", at: "2026-03-01", deletedAt: "2026-04-01" },
    { id: "gone", at: "2026-05-01", content: "must not revive" },
  ];
  assert.deepEqual(
    neutral(typed.mergeEntries(first, second)),
    neutral(classic.mergeEntries(first, second)),
  );
  for (const entry of [null, {}, { at: 7 }, { id: 0, at: "x" }, { deleted_at: "now" }]) {
    assert.equal(typed.historyEntryId(entry), classic.historyEntryId(entry));
    assert.equal(typed.isHistoryDeleted(entry), classic.isHistoryDeleted(entry));
  }
});

test("AI session truncation, timestamps, labels, and total prompt bounds remain classic", () => {
  const classic = loadClassicApi<ReaderAiHistoryRulesApi>(
    "reader-ai-history-rules.js",
    "ReaderAiHistoryRules",
  );
  const typed = installReaderAiHistoryRules({});
  const existing = Array.from({ length: 8 }, (_, index) => ({ content: `old-${index}` }));
  const entry = {
    task: "summary",
    question: "问".repeat(300),
    content: "答".repeat(900),
  };
  const now = () => "2026-08-13T00:00:00.000Z";
  const typedEntries = typed.prependSessionEntry(existing, entry, now);
  const classicEntries = classic.prependSessionEntry(existing, entry, now);
  assert.deepEqual(neutral(typedEntries), neutral(classicEntries));
  assert.deepEqual(
    typed.sessionPrompt(typedEntries, (task: unknown) => `标签-${String(task)}`),
    classic.sessionPrompt(classicEntries, (task: unknown) => `标签-${String(task)}`),
  );
  assert.equal(typed.sessionPrompt(null, null), classic.sessionPrompt(null, null));
});

test("preference color installer preserves classic normalization and color conversion", () => {
  const classic = loadClassicApi<ReaderPreferenceColorRulesApi>(
    "reader-preference-color-rules.js",
    "ReaderPreferenceColorRules",
  );
  const target: Record<string, unknown> = {};
  const typed = installReaderPreferenceColorRules(target);
  assert.equal(target.ReaderPreferenceColorRules, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());

  for (const value of ["#abc", "ABCDEF", "  #09f  ", "#abcd", "", null, 0]) {
    assert.equal(typed.normalizedHex(value, "fallback"), classic.normalizedHex(value, "fallback"));
    assert.deepEqual(neutral(typed.hexToHsl(value)), neutral(classic.hexToHsl(value)));
  }
  const hslInputs = [
    [0, 100, 50],
    [120, 50, 25],
    [-60, 120, -20],
    [720, "bad", null],
    [359.5, 33.3, 66.6],
  ] as const;
  for (const [hue, saturation, lightness] of hslInputs) {
    assert.equal(
      typed.hslToHex(hue, saturation, lightness),
      classic.hslToHex(hue, saturation, lightness),
    );
  }
  for (const [foreground, background] of [
    ["#000000", "#ffffff"],
    ["#777777", "#ffffff"],
    ["#abc", "#123456"],
  ]) {
    assert.equal(
      typed.contrastRatio(foreground, background),
      classic.contrastRatio(foreground, background),
    );
  }
});
