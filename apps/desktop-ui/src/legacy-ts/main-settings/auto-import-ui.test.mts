import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  installAutoImportUi,
  type AutoImportGlobalApi,
} from "./auto-import-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  return readFileSync(
    new URL("ui/generated-ts/auto-import-ui.js", repositoryRoot),
    "utf8",
  );
}

interface TimerRecord {
  readonly id: number;
  readonly delay: number;
  readonly callback: () => void;
}

function timerRuntime() {
  let nextId = 0;
  const timers: TimerRecord[] = [];
  const runtime: Record<string, unknown> = {
    setTimeout: (callback: () => void, delay = 0) => {
      nextId += 1;
      timers.push({ id: nextId, delay, callback });
      return nextId;
    },
    clearTimeout: (id?: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  runtime.window = runtime;
  return { runtime, timers };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function install(legacy: boolean, runtime: Record<string, unknown>): AutoImportGlobalApi {
  if (legacy) {
    vm.runInNewContext(classicSource(), runtime);
    return runtime.ReaderAutoImportUI as AutoImportGlobalApi;
  }
  return installAutoImportUi(runtime) as AutoImportGlobalApi;
}

async function exercise(legacy: boolean) {
  const clock = timerRuntime();
  const api = install(legacy, clock.runtime);
  const calls: string[] = [];
  const rendered: unknown[][] = [];
  const statuses: Array<readonly [string, string]> = [];
  const performance: string[] = [];
  const scanResolvers: Array<(value: unknown[]) => void> = [];
  let afterAdded = 0;
  const instance = api.create({
    invoke: async <TResult,>(command: string) => {
      calls.push(command);
      if (command === "auto_import_scan") {
        return new Promise<unknown[]>((resolve) => scanResolvers.push(resolve)) as Promise<TResult>;
      }
      if (command === "list_books") {
        return [{ id: "live" }] as TResult;
      }
      throw new Error(`unexpected command: ${command}`);
    },
    isEnabled: () => true,
    getDirs: () => ["D:\\books"],
    countShelf: () => 0,
    renderShelf: (books) => rendered.push(plain(books) as unknown[]),
    setStatus: (message, state) => statuses.push([message, state]),
    startPerformance: (name, detail) => {
      performance.push(`${name}:${detail}`);
      return (result) => performance.push(`finish:${result}`);
    },
    logPerformance: (name, phase, detail) =>
      performance.push(`${name}:${phase}:${detail}`),
    afterAdded: () => {
      afterAdded += 1;
    },
  });

  const first = instance.start("first");
  const second = instance.start("second");
  assert.equal(first, second);
  scanResolvers.shift()?.([{ id: "first" }]);
  await settle();
  scanResolvers.shift()?.([{ id: "first" }, { id: "second" }]);
  await first;

  instance.handleProgress({
    phase: "import",
    processed: 5,
    total: 20,
    added: 3,
    current: "book.epub",
  });
  const refreshTimer = clock.timers.find((timer) => timer.delay === 350);
  refreshTimer?.callback();
  await settle();
  instance.handleProgress({ phase: "waiting", deferred: 2 });
  const stabilityTimer = clock.timers.find((timer) => timer.delay === 5000);
  instance.handleProgress({ phase: "done", added: 2 });

  return {
    calls,
    rendered,
    statuses,
    performance,
    afterAdded,
    keys: Object.keys(instance).sort(),
    apiKeys: Object.keys(api).sort(),
    frozen: Object.isFrozen(instance) && Object.isFrozen(api),
    timerDelays: clock.timers.map((timer) => timer.delay),
    hasStabilityTimer: Boolean(stabilityTimer),
  };
}

test("strict installer remains behavior-equivalent to the classic VM", async () => {
  assert.deepEqual(await exercise(false), await exercise(true));
});

test("typed transport owns commands and all three native events", async () => {
  const clock = timerRuntime();
  const calls: string[] = [];
  const handlers = new Map<string, (event: TauriEvent<unknown>) => void>();
  const statuses: Array<readonly [string, string]> = [];
  let scanResolve: ((books: unknown[]) => void) | undefined;
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string) => {
      calls.push(command);
      if (command === "auto_import_scan") {
        return new Promise<unknown[]>((resolve) => {
          scanResolve = resolve;
        }) as Promise<TResult>;
      }
      return [{ id: "live" }] as TResult;
    },
    listen: async <TPayload,>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ) => {
      handlers.set(event, handler as (event: TauriEvent<unknown>) => void);
      return () => undefined;
    },
  };
  const api = installAutoImportUi(clock.runtime);
  assert.ok(api);
  const instance = api.create({
    transport,
    isEnabled: () => true,
    getDirs: () => ["opaque-directory"],
    countShelf: () => 0,
    renderShelf: () => undefined,
    setStatus: (message, state) => statuses.push([message, state]),
    startPerformance: () => () => undefined,
    logPerformance: () => undefined,
    afterAdded: () => undefined,
  });
  instance.bindEvents();
  assert.deepEqual([...handlers.keys()], [
    "auto-import-progress",
    "auto-import-change",
    "auto-import-watch-status",
  ]);
  handlers.get("auto-import-progress")?.({
    event: "auto-import-progress",
    id: 1,
    payload: { phase: "scan", found: 9 },
  });
  handlers.get("auto-import-watch-status")?.({
    event: "auto-import-watch-status",
    id: 2,
    payload: { message: "watch failed", state: "error" },
  });
  handlers.get("auto-import-change")?.({
    event: "auto-import-change",
    id: 3,
    payload: { reason: "changed" },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["auto_import_scan"]);
  assert.deepEqual(statuses.slice(0, 3), [
    ["正在扫描目录…已发现 9 个文件", "busy"],
    ["watch failed", "error"],
    ["changed", "busy"],
  ]);
  scanResolve?.([]);
  await settle();
});

test("disabled or unconfigured scans stay inert and preserve frozen globals", async () => {
  const clock = timerRuntime();
  const calls: string[] = [];
  const api = installAutoImportUi(clock.runtime);
  assert.ok(api);
  const instance = api.create({
    invoke: async <TResult,>(command: string) => {
      calls.push(command);
      return [] as TResult;
    },
    isEnabled: () => false,
    getDirs: () => [],
    countShelf: () => 0,
    renderShelf: () => undefined,
    setStatus: () => undefined,
    startPerformance: () => () => undefined,
    logPerformance: () => undefined,
    afterAdded: () => undefined,
  });
  await instance.start();
  assert.deepEqual(calls, []);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(instance), true);
  assert.deepEqual(Object.keys(api), ["create"]);
  assert.deepEqual(Object.keys(instance).sort(), [
    "bindEvents",
    "handleProgress",
    "start",
  ]);
});
