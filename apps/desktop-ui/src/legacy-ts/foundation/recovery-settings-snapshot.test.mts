import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  captureRecoverySettings,
  installRecoverySettingsSnapshot,
  isSensitiveRecoveryKey,
  recoveryScope,
  type RecoveryRuntime,
} from "./recovery-settings-snapshot.ts";

function runtimeFixture(initial: Record<string, string> = {}, pathname = "/index.html") {
  const values = new Map(Object.entries(initial));
  let reloaded = 0;
  let interval: (() => void) | null = null;
  let pagehide: (() => void) | null = null;
  const runtime: RecoveryRuntime = {
    localStorage: {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    location: {
      pathname,
      reload: () => {
        reloaded += 1;
      },
    },
    setInterval: (handler, milliseconds) => {
      assert.equal(milliseconds, 5_000);
      interval = handler;
      return 1;
    },
    addEventListener: (_type, listener, options) => {
      assert.deepEqual(options, { capture: true });
      pagehide = listener;
    },
  };
  return {
    runtime,
    values,
    reloads: () => reloaded,
    fireInterval: () => {
      if (interval) (interval as () => void)();
    },
    firePagehide: () => {
      if (pagehide) (pagehide as () => void)();
    },
  };
}

test("recovery rules preserve scope and filter every legacy sensitive-key spelling", () => {
  assert.equal(recoveryScope("/reader.html"), "reader");
  assert.equal(recoveryScope("/index.html"), "main");
  for (const key of [
    "token",
    "passwordHash",
    "clientSecret",
    "api_key",
    "apiKey",
    "credentialCache",
  ]) {
    assert.equal(isSensitiveRecoveryKey(key), true, key);
  }
  const fixture = runtimeFixture({ theme: "dark", accessToken: "hidden", empty: "" });
  assert.deepEqual(captureRecoverySettings(fixture.runtime.localStorage), {
    theme: "dark",
    empty: "",
  });
});

test("snapshot installer performs initial save and deduplicates unchanged interval/pagehide flushes", async () => {
  const fixture = runtimeFixture({ theme: "dark", api_key: "hidden" });
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return (command === "recovery_web_settings_take_restored" ? null : undefined) as TResult;
    },
  };
  const api = installRecoverySettingsSnapshot(fixture.runtime, transport);
  await api?.ready;
  assert.deepEqual(calls, [
    {
      command: "recovery_web_settings_take_restored",
      args: { scope: "main" },
    },
    {
      command: "recovery_web_settings_save",
      args: { scope: "main", settings: { theme: "dark" } },
    },
  ]);
  fixture.fireInterval();
  fixture.firePagehide();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  fixture.values.set("theme", "light");
  fixture.firePagehide();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), {
    command: "recovery_web_settings_save",
    args: { scope: "main", settings: { theme: "light" } },
  });
});

test("restored snapshot replaces only non-sensitive local settings and reloads", async () => {
  const fixture = runtimeFixture(
    { theme: "old", password: "keep", obsolete: "remove" },
    "/reader.html",
  );
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string) =>
      (command === "recovery_web_settings_take_restored"
        ? { theme: "new", password: "reject", count: 3 }
        : undefined) as TResult,
  };
  const api = installRecoverySettingsSnapshot(fixture.runtime, transport);
  await api?.ready;
  assert.equal(fixture.reloads(), 1);
  assert.deepEqual(Object.fromEntries(fixture.values), {
    password: "keep",
    theme: "new",
  });
});

test("browser-only runtime still publishes a no-op compatible API", async () => {
  const fixture = runtimeFixture({ theme: "dark" });
  const api = installRecoverySettingsSnapshot(fixture.runtime);
  await api?.ready;
  await api?.flush(true);
  assert.equal(typeof fixture.runtime.ReaderRecoverySettings?.flush, "function");
  assert.equal(fixture.reloads(), 0);
});
