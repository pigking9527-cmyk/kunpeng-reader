import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  createSemanticStatusCache,
  SEMANTIC_ACTIVE_MODEL_KEY,
  SEMANTIC_STATUS_STORAGE_KEY,
  type SemanticStatusCacheApi,
} from "./semantic-status-cache.ts";
import type { StorageLike } from "./animation-settings.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function storage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  const api: StorageLike = {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
  return { api, values };
}

function legacyApi(localStorage: StorageLike, now: () => number): SemanticStatusCacheApi {
  const context: Record<string, unknown> = { localStorage, Date: { now } };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(new URL("ui/generated-ts/semantic-status-cache.js", repositoryRoot), "utf8"),
    context,
  );
  return context.ReaderSemanticStatusCache as SemanticStatusCacheApi;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function exercise(legacy: boolean) {
  const fixture = storage({
    [SEMANTIC_ACTIVE_MODEL_KEY]: "persisted",
    [SEMANTIC_STATUS_STORAGE_KEY]: JSON.stringify({
      persisted: {
        model_id: "persisted",
        model_label: "Persisted",
        semantic_total: "raw-total",
        future_field: { version: 4 },
      },
    }),
  });
  let tick = 100;
  const now = () => tick++;
  const api = legacy
    ? legacyApi(fixture.api, now)
    : createStrictCache(fixture.api, now);
  const persisted = api.get("persisted");
  api.update({ model_id: "persisted", semantic_done: "raw-done", new_field: 7 });
  api.save({ model_id: "empty" });
  api.save({ model_id: "ready", model_ready: true, model_supported: false });
  const merged = api.merge({
    model_id: "ready",
    status_refreshing: true,
    semantic_done: 0,
    semantic_total: null,
  });
  const useMissing = api.use("missing");
  api.clear("ready");
  const serialized = JSON.parse(fixture.values[SEMANTIC_STATUS_STORAGE_KEY] ?? "{}") as
    Record<string, Record<string, unknown>>;
  for (const status of Object.values(serialized)) delete status.saved_at;
  return {
    keys: Object.keys(api).sort(),
    frozen: Object.isFrozen(api),
    persisted: plain(persisted),
    updated: plain(api.get("persisted")),
    empty: api.get("empty"),
    merged: plain(merged),
    useMissing,
    active: fixture.values[SEMANTIC_ACTIVE_MODEL_KEY],
    serialized,
  };
}

function createStrictCache(storage: StorageLike, now: () => number): SemanticStatusCacheApi {
  // The public installer delegates directly to this factory; use the factory
  // here so both classic and strict executions share a deterministic clock.
  return createSemanticStatusCache(storage, now);
}

test("semantic status strict cache preserves the classic VM API and behavior", () => {
  const strict = exercise(false);
  const legacy = exercise(true);
  const stripSavedAt = (value: unknown): unknown => {
    const object = value as Record<string, unknown> | null;
    if (object && typeof object === "object") delete object.saved_at;
    return value;
  };
  stripSavedAt(strict.updated);
  stripSavedAt(legacy.updated);
  assert.deepEqual(strict, legacy);
});
