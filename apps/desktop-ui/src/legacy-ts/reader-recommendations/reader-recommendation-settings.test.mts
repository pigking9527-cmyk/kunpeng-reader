import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installReaderRecommendationSettings,
} from "./reader-recommendation-settings.ts";
import type {
  ReaderRecommendationSettingsApi,
  RecommendationPrefetcher,
} from "./reader-recommendation-settings.ts";

function loadClassic(target: Record<string, unknown>): ReaderRecommendationSettingsApi {
  const source = readFileSync(
    new URL("../../../../../ui/generated-ts/reader-recommendation-settings.js", import.meta.url),
    "utf8",
  );
  const context: Record<string, unknown> = {
    window: target,
    globalThis: target,
    Object,
    Number,
    Math,
    String,
    Array,
    Promise,
  };
  vm.runInNewContext(source, context);
  return target.ReaderRecommendationSettings as ReaderRecommendationSettingsApi;
}

function neutral<T>(value: T): T {
  return structuredClone(value);
}

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
      writes.push(`${key}=${value}`);
    },
  };
}

test("recommendation settings preserve exact frozen API, constants, and storage behavior", () => {
  const classicStorage = memoryStorage({
    readerEndRecommendationsV1: "0",
    readerRecommendationMinWordsV1: "15001.6",
  });
  const typedStorage = memoryStorage({
    readerEndRecommendationsV1: "0",
    readerRecommendationMinWordsV1: "15001.6",
  });
  const classic = loadClassic({ localStorage: classicStorage });
  const typedTarget: Record<string, unknown> = { localStorage: typedStorage };
  const typed = installReaderRecommendationSettings(typedTarget);

  assert.equal(typedTarget.ReaderRecommendationSettings, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());
  for (const key of [
    "STORAGE_KEY",
    "MIN_WORDS_STORAGE_KEY",
    "PREFETCH_PROGRESS_PERCENT",
    "DEFAULT_MIN_RECOMMENDATION_WORDS",
    "MAX_MIN_RECOMMENDATION_WORDS",
  ] as const) {
    assert.equal(typed[key], classic[key]);
  }
  assert.equal(typed.isEnabled(), classic.isEnabled());
  assert.equal(typed.minimumWords(), classic.minimumWords());
  for (const value of [-1, 0, 1.5, 999_999.8, 2_000_000, "bad", null]) {
    assert.equal(
      typed.setMinimumWords(value, typedStorage),
      classic.setMinimumWords(value, classicStorage),
    );
  }
  assert.deepEqual(typedStorage.writes, classicStorage.writes);
});

test("eligibility and prefetch boundary remain strictly greater-than and ninety percent", () => {
  const classic = loadClassic({});
  const typed = installReaderRecommendationSettings({});
  for (const [words, threshold] of [
    [0, 0],
    [10_000, 10_000],
    [10_001, 10_000],
    ["20001", "20000"],
    [Number.NaN, 10],
  ] as const) {
    assert.equal(
      typed.recommendationLengthEligible(words, threshold),
      classic.recommendationLengthEligible(words, threshold),
    );
  }
  for (const progress of [0, 89.99, 90, 100, "90", Number.NaN]) {
    assert.equal(typed.shouldPrefetch({ progress }), classic.shouldPrefetch({ progress }));
  }
});

interface PrefetchHarness {
  readonly prefetcher: RecommendationPrefetcher;
  readonly calls: string[];
  readonly images: string[];
}

function createPrefetchHarness(
  api: ReaderRecommendationSettingsApi,
): PrefetchHarness {
  const calls: string[] = [];
  const images: string[] = [];
  class ImageMock {
    decoding = "";
    private source = "";

    set src(value: string) {
      this.source = value;
      images.push(`${this.decoding}:${value}`);
    }

    get src(): string {
      return this.source;
    }
  }
  const prefetcher = api.createPrefetcher({
    invoke: async (command: string, arguments_?: Readonly<Record<string, unknown>>) => {
      calls.push(`${command}:${String(arguments_?.id ?? "")}`);
      return Array.from({ length: 7 }, (_, index) => ({
        id: index,
        cover: index < 2 ? `cover-${index}` : "",
      }));
    },
    enabled: () => true,
    minimumWords: () => 0,
    ImageCtor: ImageMock,
  });
  assert.ok(prefetcher);
  return { prefetcher, calls, images };
}

test("prefetcher retains reset, progress, five-result cache, and cover warming semantics", async () => {
  const classicHarness = createPrefetchHarness(loadClassic({}));
  const typedHarness = createPrefetchHarness(installReaderRecommendationSettings({}));
  for (const harness of [classicHarness, typedHarness]) {
    harness.prefetcher.reset("book-1", { wordCount: 20_000 });
    assert.equal(harness.prefetcher.observe({ progress: 89 }), null);
  }
  const [classicList, typedList] = await Promise.all([
    classicHarness.prefetcher.observe({ progress: 90 }),
    typedHarness.prefetcher.observe({ progress: 90 }),
  ]);
  assert.deepEqual(neutral(typedList), neutral(classicList));
  assert.equal(typedList?.length, 5);
  assert.deepEqual(typedHarness.calls, classicHarness.calls);
  assert.deepEqual(typedHarness.images, classicHarness.images);
  assert.equal(typedHarness.prefetcher.observe({ progress: 100 }), null);
  assert.equal(classicHarness.prefetcher.observe({ progress: 100 }), null);
  assert.deepEqual(
    neutral(await typedHarness.prefetcher.loadAtEnd()),
    neutral(await classicHarness.prefetcher.loadAtEnd()),
  );
  assert.deepEqual(typedHarness.calls, classicHarness.calls);
});

test("prefetcher retries one failed end-load and ignores a stale reset completion", async () => {
  function retryHarness(api: ReaderRecommendationSettingsApi) {
    let calls = 0;
    const prefetcher = api.createPrefetcher({
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary");
        return [{ id: "ok" }];
      },
      enabled: () => true,
      minimumWords: () => 0,
    });
    assert.ok(prefetcher);
    prefetcher.reset("retry");
    return { prefetcher, calls: () => calls };
  }
  const classic = retryHarness(loadClassic({}));
  const typed = retryHarness(installReaderRecommendationSettings({}));
  assert.deepEqual(neutral(await typed.prefetcher.loadAtEnd()), neutral(await classic.prefetcher.loadAtEnd()));
  assert.equal(typed.calls(), classic.calls());

  async function staleHarness(api: ReaderRecommendationSettingsApi) {
    let resolveRequest: ((value: unknown[]) => void) | null = null;
    const prefetcher = api.createPrefetcher({
      invoke: () => new Promise<unknown[]>((resolve) => {
        resolveRequest = resolve;
      }),
      enabled: () => true,
      minimumWords: () => 0,
    });
    assert.ok(prefetcher);
    prefetcher.reset("old");
    const pending = prefetcher.loadAtEnd();
    await Promise.resolve();
    prefetcher.reset("new");
    const resolver = resolveRequest as ((value: unknown[]) => void) | null;
    if (!resolver) throw new Error("Request did not start.");
    resolver([{ id: "stale" }]);
    return pending;
  }
  assert.equal(await staleHarness(installReaderRecommendationSettings({})), null);
  assert.equal(await staleHarness(loadClassic({})), null);
});
