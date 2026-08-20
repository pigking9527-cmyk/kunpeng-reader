import assert from "node:assert/strict";
import test from "node:test";

import {
  createSemanticStatusCache,
  installSemanticStatusCache,
  SEMANTIC_ACTIVE_MODEL_KEY,
  SEMANTIC_STATUS_STORAGE_KEY,
  semanticStatusSnapshot,
} from "./semantic-status-cache.ts";
import type { StorageLike } from "./animation-settings.ts";

function storage(values: Record<string, string> = {}): StorageLike {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

test("semantic snapshot preserves explicit zero and defaults", () => {
  const result = semanticStatusSnapshot({ model_supported: false, semantic_done: 0 }, "m", 9);
  assert.equal(result.model_id, "m");
  assert.equal(result.model_supported, false);
  assert.equal(result.semantic_done, 0);
  assert.equal(result.saved_at, 9);
});

test("refresh merge falls back only for nullish values", () => {
  let tick = 1;
  const values: Record<string, string> = {};
  const cache = createSemanticStatusCache(storage(values), () => tick++);
  cache.save({ model_id: "m", model_ready: true, semantic_total: 10, semantic_done: 8 });
  const merged = cache.merge({
    model_id: "m",
    status_refreshing: true,
    semantic_done: 0,
    semantic_total: null,
  });
  assert.equal(merged.semantic_done, 0);
  assert.equal(merged.semantic_total, 10);
  assert.ok(values[SEMANTIC_STATUS_STORAGE_KEY]);
});

test("empty not-ready snapshots are not persisted", () => {
  const values: Record<string, string> = {};
  const cache = createSemanticStatusCache(storage(values));
  cache.save({ model_id: "m" });
  assert.equal(cache.get("m"), null);
});

test("persisted and patched unknown fields retain classic shallow-object semantics", () => {
  const values: Record<string, string> = {
    [SEMANTIC_ACTIVE_MODEL_KEY]: "m",
    [SEMANTIC_STATUS_STORAGE_KEY]: JSON.stringify({
      m: { model_id: "m", semantic_total: "raw", future_field: { enabled: true } },
    }),
  };
  let tick = 9;
  const cache = createSemanticStatusCache(storage(values), () => tick++);
  assert.equal(cache.get("m")?.semantic_total, "raw");
  assert.deepEqual(cache.get("m")?.future_field, { enabled: true });
  cache.update({ model_id: "m", semantic_done: "raw-done", new_field: 7 });
  assert.equal(cache.get("m")?.semantic_done, "raw-done");
  assert.deepEqual(cache.get("m")?.future_field, { enabled: true });
  assert.equal(cache.get("m")?.new_field, 7);
});

test("installer exposes the original frozen global API", () => {
  const target = { localStorage: storage() } as {
    readonly localStorage: StorageLike;
  } & Record<string, unknown>;
  const api = installSemanticStatusCache(target);
  assert.equal(target.ReaderSemanticStatusCache, api);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), [
    "clear",
    "get",
    "merge",
    "save",
    "snapshot",
    "update",
    "use",
  ]);
});
