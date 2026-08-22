import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installExperimentalFeatures,
  type ExperimentalFeaturesApi,
} from "./experimental-features.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function storage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    api: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    },
  };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function exercise(legacy: boolean) {
  const stored = storage();
  const events: Array<{ readonly type: string; readonly detail: unknown }> = [];
  const target: Record<string, unknown> = {
    localStorage: stored.api,
    dispatchEvent: (event: Event) => {
      const custom = event as CustomEvent;
      events.push({ type: custom.type, detail: custom.detail });
      return true;
    },
  };
  target.window = target;
  target.globalThis = target;
  if (legacy) {
    vm.runInNewContext(
      readFileSync(new URL("ui/generated-ts/experimental-features.js", repositoryRoot), "utf8"),
      {
        ...target,
        window: target,
        CustomEvent,
      },
    );
  } else installExperimentalFeatures(target);
  const api = target.ReaderExperimentalFeatures as ExperimentalFeaturesApi;
  const before = {
    news: api.enabled("newsnow"),
    prefetch: api.enabled("newsnowPrefetch"),
    hide: api.enabled("newsnowHideReturnIcon"),
    unknown: api.enabled("unknown"),
  };
  const setValues = [
    api.set("newsnowPrefetch", false),
    api.set("newsnowHideReturnIcon", true),
    api.set("unknown", 1),
  ];
  return {
    before,
    setValues,
    after: {
      news: api.enabled("newsnow"),
      prefetch: api.enabled("newsnowPrefetch"),
      hide: api.enabled("newsnowHideReturnIcon"),
      unknown: api.enabled("unknown"),
    },
    storage: plain(stored.values),
    events: plain(events),
    keys: Object.keys(api).sort(),
    frozen: Object.isFrozen(api),
    instance: api.instance,
  };
}

test("experimental feature strict installer is VM-equivalent without a document", () => {
  assert.deepEqual(exercise(false), exercise(true));
});

test("invalid saved JSON falls back and set emits the legacy event", () => {
  const stored = storage({
    "kunpeng.reader.experimental-features.v1": "{",
  });
  const events: CustomEvent[] = [];
  const target = {
    localStorage: stored.api,
    dispatchEvent: (event: Event) => {
      events.push(event as CustomEvent);
      return true;
    },
  };
  const api = installExperimentalFeatures(target);
  assert.equal(api?.enabled("newsnowPrefetch"), true);
  assert.equal(api?.set("newsnowPrefetch", false), false);
  assert.equal(events[0]?.type, "reader-experimental-features-changed");
  assert.deepEqual(events[0]?.detail, {
    key: "newsnowPrefetch",
    enabled: false,
  });
});
