import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriTransport,
  WindowControls,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  initializeStartupPerf,
  installStartupPerf,
  keepRecentStartupSessions,
  readStartupPerfLogs,
  STARTUP_PERF_STORAGE_KEY,
  type StartupPerfHost,
} from "./startup-perf.ts";

function hostFixture(values: Record<string, string> = {}) {
  let now = 100;
  const messages: string[] = [];
  let domReady: (() => void) | null = null;
  const host: StartupPerfHost = {
    localStorage: {
      getItem: (key) => values[key] ?? null,
      setItem: (key, value) => {
        values[key] = value;
      },
    },
    performance: {
      now: () => now,
    },
    console: {
      info: (message) => {
        messages.push(message);
      },
    },
    addEventListener: (_type, listener) => {
      domReady = listener;
    },
  };
  return {
    host,
    values,
    messages,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    fireDomReady: () => {
      if (domReady) (domReady as () => void)();
    },
  };
}

function controls(durations: number[]): WindowControls {
  return {
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    show: async () => undefined,
    startDragging: async () => undefined,
    startResizeDragging: async () => undefined,
    isReaderWindowOpen: async () => false,
    elapsedSinceProcessStartMs: async () => durations.shift() ?? 0,
  };
}

test("startup log persistence tolerates corrupt data and keeps twelve recent sessions", () => {
  assert.deepEqual(
    readStartupPerfLogs({ getItem: () => "{", setItem: () => undefined }),
    [],
  );
  const logs = Array.from({ length: 14 }, (_, session) => ({
    session: `s${session}`,
    at: session,
  }));
  assert.deepEqual(
    keepRecentStartupSessions(logs).map((entry) =>
      typeof entry === "object" && entry !== null && "session" in entry
        ? entry.session
        : undefined,
    ),
    logs.slice(2).map(({ session }) => session),
  );
});

test("startup globals preserve logging, timing, errors and native milestones", async () => {
  const fixture = hostFixture();
  initializeStartupPerf(fixture.host, controls([27, 33]), "session-fixed");
  await Promise.resolve();
  fixture.advance(5);
  fixture.host.startupPerfLog?.("books", "mark", "ready");
  fixture.advance(2);
  const done = fixture.host.startupPerfStart?.("search");
  fixture.advance(8);
  done?.("ok");
  const value = await fixture.host.startupTimed?.("sync", async () => 42);
  assert.equal(value, 42);
  await assert.rejects(
    fixture.host.startupTimed?.("bad", async () => {
      throw new Error("failed");
    }) ?? Promise.resolve(),
    /failed/u,
  );
  fixture.fireDomReady();
  await Promise.resolve();

  const entries = JSON.parse(
    fixture.values[STARTUP_PERF_STORAGE_KEY] ?? "[]",
  ) as Array<{ readonly name: string; readonly phase: string; readonly detail: string }>;
  assert.deepEqual(entries[0], {
    session: "session-fixed",
    at: 0,
    name: "app",
    phase: "start",
    detail: "main window script loaded",
  });
  assert.ok(entries.some((entry) => entry.name === "startup" && entry.detail === "27ms"));
  assert.ok(entries.some((entry) => entry.name === "startup" && entry.detail === "33ms"));
  assert.ok(entries.some((entry) => entry.name === "bad" && entry.phase === "error" && entry.detail === "failed"));
  assert.ok(fixture.messages.some((message) => message.includes("[startup] +5ms books mark ready")));
});

test("classic startup installer uses typed transport and remains safe without Tauri", async () => {
  const fixture = hostFixture();
  const commands: string[] = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string) => {
      commands.push(command);
      return 19 as TResult;
    },
  };
  installStartupPerf(fixture.host, transport, "session");
  await Promise.resolve();
  assert.deepEqual(commands, ["startup_elapsed_ms"]);

  const browserOnly = hostFixture();
  installStartupPerf(browserOnly.host, undefined, "browser");
  assert.equal(await browserOnly.host.recordNativeStartupMilestone?.("manual"), null);
  assert.equal(typeof browserOnly.host.startupTimed, "function");
});
