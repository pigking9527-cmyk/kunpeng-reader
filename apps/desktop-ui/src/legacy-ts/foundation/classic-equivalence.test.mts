import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installBrowserNativeGuard } from "./browser-native-guard.ts";
import {
  installRecoverySettingsSnapshot,
  type RecoverySettingsApi,
} from "./recovery-settings-snapshot.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(fileName: string): string {
  return readFileSync(new URL(`ui/generated-ts/${fileName}`, repositoryRoot), "utf8");
}

function recoveryFixture() {
  const values = new Map<string, string>([
    ["theme", "dark"],
    ["apiKey", "hidden"],
  ]);
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  let interval: (() => void) | null = null;
  let pagehide: (() => void) | null = null;
  let reloads = 0;
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    return (command === "recovery_web_settings_take_restored" ? null : undefined) as TResult;
  };
  const target: Record<string, unknown> = {
    __TAURI__: { core: { invoke } },
    localStorage: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    location: {
      pathname: "/reader.html",
      reload: () => {
        reloads += 1;
      },
    },
    setInterval: (handler: () => void) => {
      interval = handler;
      return 1;
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") pagehide = listener;
    },
  };
  target.window = target;
  target.globalThis = target;
  return {
    target,
    invoke,
    values,
    calls,
    reloads: () => reloads,
    interval: () => interval,
    pagehide: () => pagehide,
  };
}

async function exerciseRecovery(legacy: boolean) {
  const fixture = recoveryFixture();
  if (legacy) {
    vm.runInNewContext(classicSource("recovery-settings-snapshot.js"), fixture.target);
  } else {
    const transport: TauriTransport = { invoke: fixture.invoke };
    installRecoverySettingsSnapshot(fixture.target, transport);
  }
  const exposed = fixture.target.ReaderRecoverySettings as RecoverySettingsApi;
  await exposed.ready;
  fixture.interval()?.();
  fixture.pagehide()?.();
  await Promise.resolve();
  fixture.values.set("theme", "light");
  await exposed.flush(false);
  return {
    calls: fixture.calls,
    values: Object.fromEntries(fixture.values),
    reloads: fixture.reloads(),
    exposed: {
      flush: typeof exposed.flush,
      readyThen: typeof exposed.ready.then,
      frozen: Object.isFrozen(exposed),
    },
  };
}

test("recovery settings installer is VM-equivalent to the classic script", async () => {
  assert.equal(
    JSON.stringify(await exerciseRecovery(false)),
    JSON.stringify(await exerciseRecovery(true)),
  );
});

interface GuardListener {
  readonly type: string;
  readonly listener: (event: Event) => void;
  readonly capture: boolean;
}

function guardFixture() {
  const listeners: GuardListener[] = [];
  const target: Record<string, unknown> = {
    document: {
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        capture: boolean,
      ) => {
        if (typeof listener === "function") listeners.push({ type, listener, capture });
      },
    },
  };
  target.window = target;
  target.globalThis = target;
  return { target, listeners };
}

function exerciseGuard(legacy: boolean) {
  const fixture = guardFixture();
  if (legacy) {
    class FakeElement {}
    fixture.target.Element = FakeElement;
    vm.runInNewContext(classicSource("browser-native-guard.js"), fixture.target);
  } else installBrowserNativeGuard(fixture.target);
  const results = fixture.listeners.map(({ type, listener, capture }) => {
    let prevented = 0;
    listener({
      target: null,
      preventDefault: () => {
        prevented += 1;
      },
    } as unknown as Event);
    return { type, capture, prevented };
  });
  return results;
}

test("browser native guard installer is VM-equivalent for non-editable surfaces", () => {
  assert.deepEqual(exerciseGuard(false), exerciseGuard(true));
});
