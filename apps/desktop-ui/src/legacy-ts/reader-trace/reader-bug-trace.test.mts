import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  createReaderBugTrace,
  installReaderBugTrace,
} from "./reader-bug-trace.ts";
import type { ReaderBugTraceApi } from "./reader-bug-trace.ts";

interface TimerRecord {
  readonly id: number;
  readonly callback: () => void | Promise<void>;
  readonly delay: number;
  cleared: boolean;
}

interface TraceRuntime extends Record<string, unknown> {
  readonly timers: TimerRecord[];
  readonly listeners: Map<string, EventListener>;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly navigator: Readonly<Record<string, unknown>>;
  readonly screen: Readonly<Record<string, unknown>>;
  readonly devicePixelRatio: number;
}

function createRuntime(): TraceRuntime {
  const timers: TimerRecord[] = [];
  const listeners = new Map<string, EventListener>();
  let nextTimerId = 1;
  return {
    timers,
    listeners,
    navigator: {
      userAgent: "Test Agent",
      platform: "Test OS",
      language: "zh-CN",
    },
    screen: { width: 1_920, height: 1_080 },
    devicePixelRatio: 2,
    setTimeout: ((callback: TimerHandler, delay?: number) => {
      if (typeof callback !== "function") throw new TypeError("Timer callback required.");
      const id = nextTimerId++;
      timers.push({ id, callback: callback as () => void | Promise<void>, delay: Number(delay) || 0, cleared: false });
      return id;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      const timer = timers.find((candidate) => candidate.id === id);
      if (timer) timer.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout,
    addEventListener: ((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }) as Window["addEventListener"],
  };
}

function loadClassic(runtime: TraceRuntime): ReaderBugTraceApi {
  const source = readFileSync(new URL("../../../../../ui/generated-ts/reader-bug-trace.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    globalThis: runtime,
    Object,
    Number,
    Math,
    String,
    Array,
    Set,
    Date,
    Promise,
    JSON,
  });
  return runtime.ReaderBugTrace as ReaderBugTraceApi;
}

function neutral<T>(value: T): T {
  return structuredClone(value);
}

function withFakeClock<T>(now: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try { return run(); } finally { Date.now = originalNow; }
}

test("trace installer preserves exact frozen global API and initial event", () => {
  const classicRuntime = createRuntime();
  const typedRuntime = createRuntime();
  const classic = withFakeClock(1_000, () => loadClassic(classicRuntime));
  const typed = withFakeClock(1_000, () => installReaderBugTrace(typedRuntime, null));
  assert.equal(typedRuntime.ReaderBugTrace, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());
  assert.equal(typed.WINDOW_MS, classic.WINDOW_MS);
  assert.deepEqual(neutral(typed._snapshotForTests(1_000)), neutral(classic._snapshotForTests(1_000)));
});

test("trace cleaning, labels, number bounds, page ingestion, reset, and pruning are VM-equivalent", () => {
  const classic = withFakeClock(10_000, () => loadClassic(createRuntime()));
  const typed = withFakeClock(10_000, () => installReaderBugTrace(createRuntime(), null));
  withFakeClock(20_000, () => {
    const detail = {
      source: "reader shell",
      outcome: "selection",
      anchor_offset: 2_000_000_000,
      x_pct: 1_000_001,
      ready: true,
      secret: "must disappear",
      nested: { no: true },
    };
    classic.record("bad label /", detail);
    typed.record("bad label /", detail);
    const pageEvent = { kind: "footnote", chapter: 4, page: 2, note_marker: true, note_virtual: true, note_link_present: true, note_fragment_present: true, note_click_consumed: true, note_popup_visible: false, note_target_chapter: 8, note_search_chapters: 12, text: "private", href: "reader://private" };
    classic.ingestPageEvent(pageEvent);
    typed.ingestPageEvent(pageEvent);
  });
  assert.deepEqual(
    neutral(typed._snapshotForTests(20_000)),
    neutral(classic._snapshotForTests(20_000)),
  );
  withFakeClock(300_001, () => {
    assert.deepEqual(
      neutral(typed._snapshotForTests(300_001)),
      neutral(classic._snapshotForTests(300_001)),
    );
    classic.reset();
    typed.reset();
  });
  assert.deepEqual(
    neutral(typed._snapshotForTests(300_001)),
    neutral(classic._snapshotForTests(300_001)),
  );
});

test("capture output and context sanitization remain equivalent without native transport", async () => {
  const classicRuntime = createRuntime();
  const typedRuntime = createRuntime();
  const classic = withFakeClock(50_000, () => loadClassic(classicRuntime));
  const typed = withFakeClock(50_000, () => installReaderBugTrace(typedRuntime, null));
  const provider = () => ({
    book: { title: "A".repeat(250), format: "epub", path: "/private/book.epub" },
    state: {
      chapter: 2,
      progress: 42.55555,
      chapter_frac: 0.5,
      total_chapters: 100,
      overlay: "settings",
      toolbar: "normal",
      frame_ready: true,
      loading: false,
      is_pdf: false,
      immersive: true,
      viewport: { width: 1_200, height: 800 },
      secret: "no",
    },
  });
  classic.setContextProvider(provider);
  typed.setContextProvider(provider);
  withFakeClock(50_100, () => {
    classic.record("click", { outcome: "overlay" });
    typed.record("click", { outcome: "overlay" });
  });
  const [classicSnapshot, typedSnapshot] = await withFakeClock(50_200, () =>
    Promise.all([classic.capture("manual"), typed.capture("manual")]),
  );
  assert.deepEqual(neutral(typedSnapshot), neutral(classicSnapshot));
  assert.equal(JSON.stringify(typedSnapshot).includes("/private/book.epub"), false);
  assert.equal(JSON.stringify(typedSnapshot).includes("secret"), false);
});

test("fake typed transport preserves command and emit checkpoint semantics without direct Tauri access", async () => {
  const runtime = createRuntime();
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const transport: TauriTransport = {
    async invoke<TResult>(command: string, arguments_?: Record<string, unknown>): Promise<TResult> {
      calls.push(command);
      payloads.push(arguments_);
      if (command === "app_version") return "1.2.3" as TResult;
      if (command === "runtime_diagnostics") return { engine: "webkit" } as TResult;
      return undefined as TResult;
    },
    async emit(event: string, payload?: unknown): Promise<void> {
      calls.push(`emit:${event}`);
      payloads.push(payload);
    },
  };
  const api = withFakeClock(1_000, () => createReaderBugTrace(runtime, transport));
  api.setContextProvider(() => ({ book: { title: "Safe", format: "epub" }, state: {} }));
  const manual = await withFakeClock(2_000, () => api.capture("manual"));
  assert.equal(manual.version, "1.2.3");
  assert.deepEqual(manual.runtime_diagnostics, { engine: "webkit" });
  assert.deepEqual(calls, ["app_version", "runtime_diagnostics"]);

  withFakeClock(3_000, () => api.checkpoint(0));
  const timer = runtime.timers.at(-1);
  assert.ok(timer);
  await withFakeClock(3_000, async () => timer.callback());
  assert.deepEqual(calls.slice(-2), ["emit:reader-bug-trace-checkpoint", "problem_trace_checkpoint"]);
  assert.equal(JSON.stringify(payloads).includes("Safe"), true);
});

test("closing the reader immediately checkpoints the final bounded snapshot once", async () => {
  const runtime = createRuntime();
  const calls: string[] = [];
  const transport: TauriTransport = {
    async invoke<TResult>(command: string): Promise<TResult> {
      calls.push(command);
      if (command === "app_version") return "1.2.3" as TResult;
      if (command === "runtime_diagnostics") return {} as TResult;
      return undefined as TResult;
    },
    async emit(event: string): Promise<void> {
      calls.push(`emit:${event}`);
    },
  };
  createReaderBugTrace(runtime, transport);
  runtime.listeners.get("pagehide")?.(new Event("pagehide"));
  runtime.listeners.get("beforeunload")?.(new Event("beforeunload"));
  const activeTimer = runtime.timers.slice().reverse().find((timer) => !timer.cleared);
  assert.equal(activeTimer?.delay, 0);
  await activeTimer?.callback();
  assert.equal(calls.filter((command) => command === "problem_trace_checkpoint").length, 1);
});

test("global boundary adapts Tauri once while feature code uses the injected transport", async () => {
  const runtime = createRuntime();
  const calls: string[] = [];
  runtime.__TAURI__ = {
    core: {
      invoke: async (command: string) => {
        calls.push(command);
        return command === "app_version" ? "9.0.0" : {};
      },
    },
    event: {
      emit: async (event: string) => { calls.push(`emit:${event}`); },
    },
  };
  const api = installReaderBugTrace(runtime);
  const snapshot = await api.capture();
  assert.equal(snapshot.version, "9.0.0");
  assert.deepEqual(calls, ["app_version", "runtime_diagnostics"]);
});
