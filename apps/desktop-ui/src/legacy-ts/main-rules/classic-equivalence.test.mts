import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installNewsGesture,
  type GesturePoint,
  type GestureRuntime,
  type NewsGestureApi,
} from "./news-gesture.ts";
import {
  installShelfCoverLoadingRules,
  type ShelfCoverLoadingRulesApi,
} from "./shelf-cover-loading-rules.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicApi<TApi>(fileName: string, globalName: string): TApi {
  const context: Record<string, unknown> = {};
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(new URL(`ui/${fileName}`, repositoryRoot), "utf8"),
    context,
  );
  return context[globalName] as TApi;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("shelf cover loading strict rules are VM-equivalent to the classic API", () => {
  const legacy = classicApi<ShelfCoverLoadingRulesApi>(
    "generated-ts/shelf-cover-loading-rules.js",
    "ReaderShelfCoverLoadingRules",
  );
  const target: Record<string, unknown> = {};
  const strict = installShelfCoverLoadingRules(target);
  for (const options of [
    {},
    { width: 0, height: 0 },
    { width: 1024, height: 800 },
    { width: 1024, height: 800, gridColumns: 3 },
    { width: 640, height: 701, layout: "list" },
    { width: "bad", height: Infinity },
    { width: 100_000, height: 100_000 },
  ]) {
    assert.equal(
      strict.estimateFirstScreenCoverCount(options),
      legacy.estimateFirstScreenCoverCount(options),
    );
    assert.equal(
      strict.firstScreenCoverCount(options),
      legacy.firstScreenCoverCount(options),
    );
  }
  for (const [index, count] of [
    [0, 24],
    [23, 24],
    [24, 24],
    [-1, 24],
    ["2", "3"],
    [Number.NaN, 24],
  ]) {
    assert.deepEqual(
      plain(strict.coverLoadPriority(index, count)),
      plain(legacy.coverLoadPriority(index, count)),
    );
  }
  assert.equal(target.ReaderShelfCoverLoadingRules, strict);
  assert.equal(Object.isFrozen(strict), true);
});

function newsApiWithStorage() {
  const values = new Map<string, string>();
  const runtime: GestureRuntime = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  };
  return { runtime, values };
}

function sampleRoutes(): GesturePoint[][] {
  return [
    [],
    [{ x: 0, y: 0 }],
    [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ],
    Array.from({ length: 60 }, (_, index) => ({
      x: index * 2,
      y: Math.sin(index / 8) * 40,
    })),
  ];
}

test("news gesture geometry and preference APIs are VM-equivalent", () => {
  const legacy = classicApi<NewsGestureApi>("generated-ts/news-gesture.js", "ReaderNewsGesture");
  const fixture = newsApiWithStorage();
  const strict = installNewsGesture(fixture.runtime);
  assert.deepEqual(
    {
      storage: strict.STORAGE_KEY,
      enabled: strict.ENABLED_KEY,
      precision: strict.PRECISION_KEY,
      sample: strict.SAMPLE_COUNT,
      minimum: strict.MIN_PATH_LENGTH,
      threshold: strict.MATCH_THRESHOLD,
      thresholds: strict.MATCH_THRESHOLDS,
      precisionThresholds: strict.PRECISION_THRESHOLDS,
    },
    plain({
      storage: legacy.STORAGE_KEY,
      enabled: legacy.ENABLED_KEY,
      precision: legacy.PRECISION_KEY,
      sample: legacy.SAMPLE_COUNT,
      minimum: legacy.MIN_PATH_LENGTH,
      threshold: legacy.MATCH_THRESHOLD,
      thresholds: legacy.MATCH_THRESHOLDS,
      precisionThresholds: legacy.PRECISION_THRESHOLDS,
    }),
  );

  const routes = sampleRoutes();
  for (const route of routes) {
    assert.deepEqual(plain(strict.cleanPoints(route)), plain(legacy.cleanPoints(route)));
    assert.equal(strict.pathLength(route), legacy.pathLength(route));
    assert.deepEqual(plain(strict.normalize(route)), plain(legacy.normalize(route)));
    assert.deepEqual(
      plain(strict.directionSequence(route)),
      plain(legacy.directionSequence(route)),
    );
  }
  for (const left of routes) {
    for (const right of routes) {
      assert.equal(strict.directionSimilarity(left, right), legacy.directionSimilarity(left, right));
      assert.equal(strict.prefixSimilarity(left, right), legacy.prefixSimilarity(left, right));
      assert.equal(strict.similarity(left, right), legacy.similarity(left, right));
    }
  }

  const route = routes[2] ?? [];
  const strictSaved = strict.save(route);
  const legacyFixture = newsApiWithStorage();
  const legacySaved = legacy.save(route, legacyFixture.runtime.localStorage);
  assert.deepEqual(plain(strictSaved), plain(legacySaved));
  assert.deepEqual(plain(strict.load()), plain(legacy.load(legacyFixture.runtime.localStorage)));
  assert.equal(strict.loadEnabled(), legacy.loadEnabled(legacyFixture.runtime.localStorage));
  for (const value of ["low", "medium", "high", "1", "5", "10", "bad", null]) {
    assert.equal(strict.normalizePrecision(value), legacy.normalizePrecision(value));
    assert.equal(strict.matchThreshold(value), legacy.matchThreshold(value));
  }
  assert.equal(strict.saveEnabled(false), legacy.saveEnabled(false, legacyFixture.runtime.localStorage));
  assert.equal(strict.savePrecision("high"), legacy.savePrecision("high", legacyFixture.runtime.localStorage));
  strict.clear();
  legacy.clear(legacyFixture.runtime.localStorage);
  assert.deepEqual(Object.fromEntries(fixture.values), Object.fromEntries(legacyFixture.values));
  assert.equal(fixture.runtime.ReaderNewsGesture, strict);
  assert.equal(Object.isFrozen(strict), true);
});
