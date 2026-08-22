import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import { initializeProblemTraceUi } from "./problem-trace-ui.ts";

interface Call {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function fixture(checkpoint: Record<string, unknown> | null = null) {
  const calls: Call[] = [];
  const listeners = new Map<string, (event: TauriEvent<unknown>) => void>();
  const emitted: Array<{ readonly event: string; readonly payload?: unknown }> = [];
  const storage = new Map<string, string>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return structuredClone(checkpoint) as TResult;
    },
    listen: async (event, handler) => {
      listeners.set(event, handler as (event: TauriEvent<unknown>) => void);
      return () => listeners.delete(event);
    },
    emit: async (event, payload) => {
      emitted.push(payload === undefined ? { event } : { event, payload });
    },
  };
  const document = {
    __problemTraceShellWired: false,
    addEventListener: () => undefined,
    querySelector: () => null,
    hasFocus: () => true,
  };
  const runtime: Record<string, unknown> = {
    document,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    navigator: { platform: "MacIntel", language: "zh-CN" },
    innerWidth: 1280,
    innerHeight: 800,
    ReaderAppI18n: { selectedLanguage: () => "zh-CN" },
    ReaderStartupEnhancement: {
      snapshot: () => ({ enabled: true, continueHighCost: false, launchAtLogin: true }),
    },
    setTimeout: (callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id?: number | null) => {
      if (typeof id === "number") timers.delete(id);
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    focus: () => undefined,
  };
  const fireTimer = (id: number): void => {
    const callback = timers.get(id);
    timers.delete(id);
    callback?.();
  };
  return {
    runtime,
    transport,
    calls,
    listeners,
    emitted,
    storage,
    timers,
    fireTimer,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("frozen problem trace keeps bounded redacted shell metadata", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never);
  await flush();
  api.recordShelfBookOpen("ok", "double_click");

  const snapshot = await api.capture({ timeoutMs: 10 });

  assert.ok(Object.isFrozen(api));
  assert.equal(api.WINDOW_MS, 120_000);
  assert.equal(api.MAX_SHELL_EVENTS, 320);
  assert.deepEqual(view.calls, []);
  assert.equal(snapshot.window_ms, 120_000);
  assert.match(String(snapshot.privacy), /No book text/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /api[_ -]?key|password|token/iu);
  const events = snapshot.events as Array<Record<string, unknown>>;
  assert.equal(events.at(-1)?.type, "book_open");
  assert.deepEqual(events.at(-1)?.detail, {
    source: "main_window",
    area: "shelf",
    outcome: "ok",
    input: "double_click",
  });
});

test("typed checkpoint command and event envelopes remain exact", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  const pending = api.capture({ timeoutMs: 90 });
  await flush();
  assert.deepEqual(view.calls, [
    { command: "problem_trace_checkpoint", args: { snapshot: null } },
  ]);
  assert.equal(view.emitted[0]?.event, "reader-bug-trace-request");
  const request = view.emitted[0]?.payload as { readonly request_id: string };
  assert.match(request.request_id, /^[a-z0-9]+-[a-z0-9]{1,8}$/u);

  const response = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    events: [{ at: new Date().toISOString(), type: "reader_ready", detail: {} }],
  };
  view.listeners.get("reader-bug-trace-response")?.({
    event: "reader-bug-trace-response",
    id: 1,
    payload: { request_id: request.request_id, snapshot: response },
  });
  const snapshot = await pending;
  assert.equal(snapshot.schema_version, 1);
  assert.equal(api._recentReaderSnapshotForTests()?.schema_version, 1);
});

test("software settings use the frozen allowlist and omit sensitive values", () => {
  const view = fixture();
  view.storage.set("readerSettings", JSON.stringify({
    theme: "dark",
    fontFamily: "KaiTi",
    fontSize: 23,
    customBackgroundImage: "/Users/private/background.png",
  }));
  view.storage.set("shelfSort", "recent");
  view.storage.set("syncToken", "secret-token");
  view.storage.set("apiKey", "secret-api-key");
  const api = initializeProblemTraceUi(view.runtime as never);
  const settings = api._collectSoftwareSettingsForTests();
  const serialized = JSON.stringify(settings);

  assert.deepEqual(settings.shelf, {
    sort: "recent",
    layout: "grid",
    grid_columns: 1,
    show_cover_progress: true,
    show_cover_rating: true,
    show_cover_title: false,
    single_click_opens_book: true,
    search_enabled: false,
  });
  assert.match(serialized, /"theme":"dark"/u);
  assert.match(serialized, /"custom_background_image_configured":true/u);
  assert.doesNotMatch(serialized, /private\/background|secret-token|secret-api-key/iu);
  assert.match(serialized, /"api_credentials"/u);
});

test("startup performance aggregation preserves session and activation semantics", () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never);
  const summary = api._summarizeStartupPerformanceForTests([
    { session: "a", name: "startup", phase: "webview_script", detail: "12.5ms ready" },
    { session: "a", name: "startup", phase: "dom_ready", detail: "20ms ready" },
    { session: "b", name: "startup", phase: "webview_script", detail: "30ms ready" },
    { session: "b", name: "rust:startup-enhancement", phase: "activated", detail: "8ms warm" },
  ]);

  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.process_to_webview_script, {
    count: 2,
    min_ms: 12.5,
    avg_ms: 21.3,
    max_ms: 30,
    latest_ms: 30,
  });
  assert.deepEqual(summary.hot_activation, {
    count: 1,
    min_ms: 8,
    avg_ms: 8,
    max_ms: 8,
    latest_ms: 8,
  });
});
