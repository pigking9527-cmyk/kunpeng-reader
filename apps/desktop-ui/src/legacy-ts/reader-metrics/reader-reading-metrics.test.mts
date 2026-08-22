import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installReaderReadingMetrics,
} from "./reader-reading-metrics.ts";
import type {
  ReaderReadingMetricsApi,
} from "./reader-reading-metrics.ts";

function classicReadingMetrics(): ReaderReadingMetricsApi {
  const source = readFileSync(
    new URL("../../../../../ui/generated-ts/reader-reading-metrics.js", import.meta.url),
    "utf8",
  );
  const target: Record<string, unknown> = {};
  target.window = target;
  vm.runInNewContext(source, target, {
    filename: "reader-reading-metrics.js",
  });
  return target.ReaderReadingMetrics as ReaderReadingMetricsApi;
}

function neutral<T>(value: T): T {
  return structuredClone(value);
}

test("reading metrics installer exposes the exact frozen classic API and constants", () => {
  const classic = classicReadingMetrics();
  const target: Record<string, unknown> = {};
  const typed = installReaderReadingMetrics(target);

  assert.equal(target.ReaderReadingMetrics, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.equal(Object.isFrozen(typed.READ_TRACK), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());
  assert.deepEqual(neutral(typed.READ_TRACK), neutral(classic.READ_TRACK));
});

test("page identity and ordering preserve legacy number coercion and fallbacks", () => {
  const classic = classicReadingMetrics();
  const typed = installReaderReadingMetrics({});
  const cases = [
    [{ chapter: 3, gPage: 5, page: 2 }, 9],
    [{ chapter: 3, gPage: 0, page: 2 }, 9],
    [{ chapter: "3", gPage: "7", page: "2" }, 9],
    [{ chapter: Number.NaN, gPage: null, page: -2 }, 4],
    [{ chapter: Number.POSITIVE_INFINITY, gPage: -1, page: undefined }, 0],
    [{}, "6"],
  ] as const;
  for (const [data, fallback] of cases) {
    assert.equal(typed.pageKey(data, fallback), classic.pageKey(data, fallback));
    assert.equal(typed.pagePosition(data, fallback), classic.pagePosition(data, fallback));
  }
});

test("reading dwell thresholds retain tiny, short, normal, and exceptional inputs", () => {
  const classic = classicReadingMetrics();
  const typed = installReaderReadingMetrics({});
  for (const chars of [
    -1,
    0,
    1,
    29,
    30,
    31,
    149,
    150,
    1_200,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(typed.requiredDwellMs(chars), classic.requiredDwellMs(chars));
  }
  for (const [value, min, max] of [
    [-1, 0, 10],
    [5, 0, 10],
    [20, 0, 10],
    [Number.NaN, 0, 10],
  ] as const) {
    assert.ok(Object.is(typed.clamp(value, min, max), classic.clamp(value, min, max)));
  }
});
