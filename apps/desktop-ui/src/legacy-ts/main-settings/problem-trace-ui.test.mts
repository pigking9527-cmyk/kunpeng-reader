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
  const documentListeners = new Map<string, (event: Event) => void>();
  const runtimeListeners = new Map<string, () => void>();
  let timerId = 0;
  let documentFocused = true;
  let activeElement: Record<string, unknown>;
  const traceElement = (kind: "book_card" | "shelf_content" | "control" | "document" | "other") => {
    const element: Record<string, unknown> = {
      id: "",
      tagName: kind === "control" ? "BUTTON" : kind === "document" ? "BODY" : "DIV",
      dataset: kind === "book_card" ? { problemTarget: "book-card" } : {},
      closest: (selector: string) => {
        if (kind === "book_card" && selector.includes("data-problem-target")) return element;
        if (kind === "shelf_content" && /#shelf|\.content/u.test(selector)) return element;
        return null;
      },
      matches: (selector: string) => {
        if (kind === "control") return /button|input|select|textarea|a/u.test(selector);
        if (kind === "document") return /body|html/u.test(selector);
        return false;
      },
      focus: () => {
        documentFocused = true;
        activeElement = element;
      },
    };
    return element;
  };
  activeElement = traceElement("document");
  const shelfContent = traceElement("shelf_content");
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
    addEventListener: (event: string, listener: (event: Event) => void) => {
      documentListeners.set(event, listener);
    },
    querySelector: (selector: string) => selector === ".content" ? shelfContent : null,
    hasFocus: () => documentFocused,
    get activeElement() { return activeElement; },
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
    addEventListener: (event: string, listener: () => void) => {
      runtimeListeners.set(event, listener);
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
    documentListeners,
    runtimeListeners,
    fireTimer,
    traceElement,
    setDocumentFocus: (
      focused: boolean,
      kind: "book_card" | "shelf_content" | "control" | "document" | "other",
    ) => {
      documentFocused = focused;
      activeElement = traceElement(kind);
    },
    fireWindowFocus: (focused: boolean) => {
      runtimeListeners.get(focused ? "focus" : "blur")?.();
    },
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
    document_focused: true,
    active_element: "document",
  });
});

test("news article timing keeps only phase, outcome, sequence, and duration", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never);
  await flush();
  api.recordNewsArticleTiming("native_page_load", "started", 7_321, 9);

  const snapshot = await api.capture({ timeoutMs: 10 });
  const events = snapshot.events as Array<Record<string, unknown>>;
  assert.equal(events.at(-1)?.type, "news_article");
  assert.deepEqual(events.at(-1)?.detail, {
    source: "newsnow",
    stage: "native_page_load",
    outcome: "started",
    duration_ms: 7_321,
    sequence: 9,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:\/\/|article title|正文/iu);
});

test("reader opening stages keep only bounded cumulative and step timings", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);
  const listener = view.listeners.get("reader-performance-trace");
  assert.ok(listener);

  const send = (stage: string, durationMs: number, extra: Record<string, unknown> = {}) => {
    listener?.({
      event: "reader-performance-trace",
      id: 1,
      payload: { openingId: 1787584000123, stage, durationMs, ...extra },
    });
  };
  send("shell_activate_received", 0);
  send("book_info", 12.4);
  send("chapter_payload_ready", 31.8, { payload_inline_hit: 1, title: "private", path: "C:\\private.epub" });
  send("chapter_styles_ready", 46.2);
  send("chapter_dom_ready", 71.5);
  send("chapter_resources_ready", 133.7);
  send("page_layout_ready", 184.1, { layout_frame_wait_ms: 0.4, layout_apply_ms: 18.2, layout_finalize_ms: 31.4, layout_compute_ms: 49.8 });
  send("frame_ready", 190.6);
  send("page_displayed", 211.9, { display_frame_wait_ms: 21.3 });
  send("untrusted private stage", 999, { token: "secret" });

  const events = api._shellEventsForTests().filter((event) => event.type === "reader_performance");
  assert.equal(events.length, 9);
  assert.deepEqual(events.at(2)?.detail, {
    source: "reader_shell",
    stage: "chapter_payload_ready",
    duration_ms: 31.8,
    step_duration_ms: 19.4,
    sequence: 1,
    opening_id: 1787584000123,
    payload_inline_hit: 1,
  });
  assert.deepEqual(events.at(-1)?.detail, {
    source: "reader_shell",
    stage: "page_displayed",
    duration_ms: 211.9,
    step_duration_ms: 21.3,
    sequence: 1,
    opening_id: 1787584000123,
    display_frame_wait_ms: 21.3,
  });
  assert.doesNotMatch(JSON.stringify(events), /private|token|secret|\\private/iu);
  assert.ok([...view.timers.keys()].length > 0);
});

test("news article timing checkpoints its redacted trace for later inspection", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  api.recordNewsArticleTiming("click", "reader_shell_visible", 0, 4);
  const timerId = [...view.timers.keys()].at(-1);
  assert.ok(timerId);
  view.fireTimer(timerId!);
  await flush();

  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0]?.command, "problem_trace_checkpoint");
  const snapshot = view.calls[0]?.args?.snapshot as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:\/\//iu);
  const events = snapshot.events as Array<Record<string, unknown>>;
  assert.equal(events.at(-1)?.type, "news_article");
});

test("window controls and gestures checkpoint only their redacted lifecycle", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  api.recordWindowControl("close", "command", "failed");
  api.recordGesture("pointer", "finish", "no_match", 42, "none");
  const timerId = [...view.timers.keys()].at(-1);
  assert.ok(timerId);
  view.fireTimer(timerId!);
  await flush();

  const snapshot = view.calls[0]?.args?.snapshot as Record<string, unknown>;
  const events = snapshot.events as Array<Record<string, unknown>>;
  assert.deepEqual(events.slice(-2), [
    {
      at: events.at(-2)?.at,
      age_ms: events.at(-2)?.age_ms,
      type: "window_control",
      detail: {
        source: "main_window",
        control: "close",
        phase: "command",
        outcome: "failed",
      },
    },
    {
      at: events.at(-1)?.at,
      age_ms: events.at(-1)?.age_ms,
      type: "gesture",
      detail: {
        source: "main_window",
        input: "pointer",
        phase: "finish",
        outcome: "no_match",
        sample_count: 42,
        action: "none",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /https?:\/\/|[A-Z]:\\|secret|token/iu);
});

test("native close stages keep only fixed redacted lifecycle labels", async () => {
  const view = fixture();
  initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  view.listeners.get("main-window-close-trace")?.({
    event: "main-window-close-trace",
    id: 1,
    payload: { phase: "hide", outcome: "ok", ignored: "C:\\private\\book.epub" },
  });
  const timerId = [...view.timers.keys()].at(-1);
  assert.ok(timerId);
  view.fireTimer(timerId!);
  await flush();

  const snapshot = view.calls[0]?.args?.snapshot as Record<string, unknown>;
  const event = (snapshot.events as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(event?.detail, {
    source: "window_backend",
    control: "close",
    phase: "hide",
    outcome: "ok",
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /private|book\.epub/iu);
});

test("reader geometry trace keeps only bounded numeric restore evidence", async () => {
  const view = fixture();
  initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  view.listeners.get("reader-window-trace")?.({
    event: "reader-window-trace",
    id: 1,
    payload: {
      phase: "geometry_observed",
      source: "same_book",
      outcome: "shown",
      geometry: { x: 312, y: 96, w: 1508, h: 880, ignored: "C:\\private\\book.epub" },
      requested: { x: 312, y: 96, w: 1508, h: 880, title: "private book" },
      restore: {
        space: "physical_v1",
        size_applied: true,
        position_applied: true,
        clamped: false,
        target_width: 1920,
        target_height: 1080,
        monitor_name: "private monitor",
      },
    },
  });
  const timerId = [...view.timers.keys()].at(-1);
  assert.ok(timerId);
  view.fireTimer(timerId!);
  await flush();

  const snapshot = view.calls[0]?.args?.snapshot as Record<string, unknown>;
  const event = (snapshot.events as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(event?.detail, {
    source: "window_backend",
    phase: "geometry_observed",
    outcome: "shown",
    duration_ms: 0,
    open_source: "same_book",
    geometry: { x: 312, y: 96, w: 1508, h: 880 },
    requested: { x: 312, y: 96, w: 1508, h: 880 },
    restore: {
      space: "physical_v1",
      size_applied: true,
      position_applied: true,
      clamped: false,
      target_width: 1920,
      target_height: 1080,
    },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /private|book\.epub|monitor_name/iu);
});

test("shelf pointer and click arrival retain focus state without a book identity", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);
  view.setDocumentFocus(false, "other");
  view.fireWindowFocus(false);
  const card = view.traceElement("book_card");

  view.documentListeners.get("pointerdown")?.({ target: card } as unknown as Event);
  view.setDocumentFocus(true, "book_card");
  view.fireWindowFocus(true);
  view.documentListeners.get("click")?.({ target: card } as unknown as Event);
  api.recordShelfBookOpen("requested", "single_click");

  const events = api._shellEventsForTests();
  const arrivals = events.filter((event) => event.type === "shelf_input");
  assert.deepEqual(arrivals.map((event) => {
    const { focus_transition_age_ms, ...detail } = event.detail;
    void focus_transition_age_ms;
    return detail;
  }), [
    {
      source: "main_window",
      phase: "pointerdown",
      document_focused: false,
      active_element: "other",
      window_focused_before_input: false,
      recently_activated: false,
    },
    {
      source: "main_window",
      phase: "click",
      document_focused: true,
      active_element: "book_card",
      window_focused_before_input: true,
      recently_activated: true,
    },
  ]);
  arrivals.forEach((event) => {
    assert.equal(typeof event.detail.focus_transition_age_ms, "number");
    assert.ok(Number(event.detail.focus_transition_age_ms) >= 0);
  });
  assert.deepEqual(events.at(-1)?.detail, {
    source: "main_window",
    area: "shelf",
    outcome: "requested",
    input: "single_click",
    document_focused: true,
    active_element: "book_card",
  });
  assert.doesNotMatch(JSON.stringify(events), /book[_ -]?id|title|path|https?:\/\//iu);
});

test("reader checkpoint is re-merged with close focus handoff instead of replacing it", async () => {
  const view = fixture();
  initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);
  view.setDocumentFocus(false, "other");

  view.listeners.get("reader-window-trace")?.({
    event: "reader-window-trace",
    id: 2,
    payload: {
      phase: "focus_restore",
      outcome: "focused_after_retry",
      attempt: 3,
      windowRequested: true,
      nativeFocused: true,
      webviewRequested: true,
      webviewFocused: true,
      visible: true,
    },
  });
  view.listeners.get("reader-bug-trace-checkpoint")?.({
    event: "reader-bug-trace-checkpoint",
    id: 3,
    payload: {
      snapshot: {
        schema_version: 1,
        captured_at: new Date().toISOString(),
        events: [{ at: new Date().toISOString(), type: "reader_closing", detail: {} }],
      },
    },
  });
  const timerId = [...view.timers.keys()].at(-1);
  assert.ok(timerId);
  view.fireTimer(timerId!);
  await flush();

  const saved = view.calls.at(-1)?.args?.snapshot as Record<string, unknown>;
  const events = saved.events as Array<Record<string, unknown>>;
  assert.equal(events.some((event) => event.type === "reader_closing"), true);
  assert.equal(events.some((event) => event.type === "reader_window"), true);
  assert.equal(events.some((event) => event.type === "focus_handoff"), true);
  const native = events.filter((event) => event.type === "reader_window").at(-1);
  const { duration_ms: nativeDuration, ...nativeDetail } = (native?.detail ?? {}) as Record<string, unknown>;
  assert.deepEqual(nativeDetail, {
    source: "window_backend",
    phase: "focus_restore",
    outcome: "focused_after_retry",
    window_requested: true,
    native_focused: true,
    webview_requested: true,
    webview_focused: true,
    visible: true,
    attempt: 3,
  });
  assert.ok(typeof nativeDuration === "number" && Number.isSafeInteger(nativeDuration) && nativeDuration >= 0);
  const verified = events.filter((event) => event.type === "focus_handoff").at(-1);
  const { duration_ms: verifiedDuration, ...verifiedDetail } = (verified?.detail ?? {}) as Record<string, unknown>;
  assert.deepEqual(verifiedDetail, {
    source: "main_window",
    phase: "document_verified",
    outcome: "focused",
    attempts: 1,
    document_focused: true,
    active_element: "shelf_content",
  });
  assert.ok(typeof verifiedDuration === "number" && Number.isSafeInteger(verifiedDuration) && verifiedDuration >= 0);
});

test("same-book window lifecycle keeps only bounded resume and relayout numbers", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  view.listeners.get("reader-window-trace")?.({
    event: "reader-window-trace",
    id: 4,
    payload: {
      phase: "relayout_after",
      source: "same_book",
      outcome: "stable",
      viewportWidth: 1_408,
      viewportHeight: 862,
      beforePage: 17,
      afterPage: 17,
      beforeAnchorOffset: 81_250,
      afterAnchorOffset: 81_250,
      resizeSequence: 3,
      documentFocused: true,
      activeElement: "reader_frame",
      title: "private title",
      id: "private-id",
      path: "C:\\private\\book.epub",
    },
  });

  const event = api._shellEventsForTests().at(-1);
  assert.deepEqual(event?.detail, {
    source: "window_backend",
    phase: "relayout_after",
    outcome: "stable",
    duration_ms: 0,
    open_source: "same_book",
    resume_state: {
      viewport_width: 1_408,
      viewport_height: 862,
      before_page: 17,
      after_page: 17,
      before_anchor_offset: 81_250,
      after_anchor_offset: 81_250,
      resize_sequence: 3,
    },
    document_focused: true,
    active_element: "reader_frame",
  });
  assert.doesNotMatch(JSON.stringify(event), /private|book\.epub|title|"id"/iu);
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
    reader_state: {
      window_role: "reader",
      document_visible: true,
      book_bound: true,
      startup_failure_category: "none",
    },
    events: [{ at: new Date().toISOString(), type: "reader_ready", detail: {} }],
  };
  view.listeners.get("reader-bug-trace-response")?.({
    event: "reader-bug-trace-response",
    id: 1,
    payload: { request_id: request.request_id, snapshot: response },
  });
  view.fireTimer(Math.min(...view.timers.keys()));
  const snapshot = await pending;
  assert.equal(snapshot.schema_version, 1);
  assert.equal(api._recentReaderSnapshotForTests()?.schema_version, 1);
});

test("capture prefers the visible failed reader over a hidden preload pool response", async () => {
  const view = fixture();
  const api = initializeProblemTraceUi(view.runtime as never, view.transport);
  await flush();

  const pending = api.capture({ timeoutMs: 90 });
  await flush();
  const request = view.emitted.at(-1)?.payload as { readonly request_id: string };
  const respond = (snapshot: Record<string, unknown>): void => {
    view.listeners.get("reader-bug-trace-response")?.({
      event: "reader-bug-trace-response",
      id: 1,
      payload: { request_id: request.request_id, snapshot },
    });
  };
  respond({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    reader_state: {
      window_role: "preload_pool",
      window_visible: false,
      document_visible: false,
      book_bound: false,
      startup_failure_category: "none",
    },
    events: [],
  });
  respond({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    reader_state: {
      window_role: "pooled_reader",
      window_visible: true,
      document_visible: true,
      book_bound: false,
      startup_phase: "book_info",
      startup_failure_category: "unbound_window",
    },
    events: [{ type: "book_load_failed", detail: { failure_category: "unbound_window" } }],
  });
  view.fireTimer(Math.min(...view.timers.keys()));

  const snapshot = await pending;
  assert.deepEqual(snapshot.reader_state, {
    window_role: "pooled_reader",
    window_visible: true,
    document_visible: true,
    book_bound: false,
    startup_phase: "book_info",
    startup_failure_category: "unbound_window",
  });
});

test("software settings use the frozen allowlist and omit sensitive values", () => {
  const view = fixture();
  view.storage.set("readerSettings", JSON.stringify({
    theme: "dark",
    fontFamily: "KaiTi",
    fontSize: 23,
    customBackgroundImage: "/Users/private/background.png",
  }));
  view.storage.set("shelfSort", "read");
  view.storage.set("syncToken", "secret-token");
  view.storage.set("apiKey", "secret-api-key");
  const api = initializeProblemTraceUi(view.runtime as never);
  const settings = api._collectSoftwareSettingsForTests();
  const serialized = JSON.stringify(settings);

  assert.deepEqual(settings.shelf, {
    sort: "read",
    layout: "grid",
    grid_columns: 1,
    show_cover_progress: true,
    show_cover_rating: true,
    show_cover_title: false,
    book_open_interaction: "left_click_open_right_click_select",
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
