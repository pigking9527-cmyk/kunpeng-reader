import assert from "node:assert/strict";
import test from "node:test";
import {
  GESTURE_SAMPLE_COUNT,
  MAX_NEWS_SOURCES,
  normaliseGesturePath,
  normalisePreferences,
  normaliseTiebaBars,
  safeHttpsUrl,
} from "./news-rules.ts";
import type { NewsPreferences, NewsSource } from "./news-port.ts";

const catalog: readonly NewsSource[] = [
  { id: "a", name: "A", category: "测试", defaultEnabled: true },
  { id: "tieba", name: "贴吧", category: "社区", defaultEnabled: false },
];

test("news URLs only accept HTTPS", () => {
  assert.equal(safeHttpsUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHttpsUrl("http://example.com/a"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
});

test("source and Tieba preferences are bounded and force tieba only with enabled bars", () => {
  const preferences: NewsPreferences = {
    sourceIds: Array.from({ length: MAX_NEWS_SOURCES + 3 }, (_, index) => `unknown-${index}`),
    tiebaBars: ["测试吧", "测试吧", "\u0000bad"],
    enabledTiebaBars: ["测试"], layout: "grid", order: "source",
  };
  const normalised = normalisePreferences(preferences, catalog);
  assert.deepEqual(normaliseTiebaBars(preferences.tiebaBars), ["测试"]);
  assert.deepEqual(normalised.sourceIds, ["tieba"]);
  assert.deepEqual(normalised.enabledTiebaBars, ["测试"]);
});

test("recorded gestures are resampled to the fixed 48-point exchange model", () => {
  const path = normaliseGesturePath([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }]);
  assert.equal(path.length, GESTURE_SAMPLE_COUNT);
  assert.ok(path.every((point) => Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1));
});
