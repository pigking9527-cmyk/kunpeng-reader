import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import type {
  GestureDrawOptions,
  GesturePoint,
  GestureStorage,
  NewsGestureApi,
} from "../main-rules/news-gesture.ts";
import {
  installReaderGesture,
  type ReaderGestureCloseApi,
} from "./reader-gesture.ts";

interface ListenerRecord {
  readonly type: string;
  readonly listener: (event: unknown) => void;
  readonly options: unknown;
}

interface TimerRecord {
  readonly id: number;
  readonly callback: () => void;
  readonly delay: number;
  cleared: boolean;
}

class MemoryStorage implements GestureStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class ElementMock {
  readonly id: string;
  hidden = false;
  className = "";
  textContent = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly posts: unknown[] = [];
  offsetWidth = 80;
  offsetHeight = 20;
  clickCount = 0;
  rect = { left: 20, top: 30 };
  contentWindow: {
    postMessage: (payload: unknown, target: string) => void;
  } | null = null;

  constructor(id = "") {
    this.id = id;
  }

  removeAttribute(name: string): void {
    if (name === "data-overlay-active") delete this.dataset.overlayActive;
  }

  click(): void {
    this.clickCount += 1;
  }

  getBoundingClientRect(): { left: number; top: number } {
    return this.rect;
  }
}

class DocumentMock {
  hidden = false;
  readonly listeners: ListenerRecord[] = [];
  readonly appended: ElementMock[] = [];
  readonly elements = new Map<string, ElementMock>();
  readonly body = {
    appendChild: (element: ElementMock) => {
      this.appended.push(element);
      return element;
    },
  };

  constructor() {
    const trail = new ElementMock("reader-gesture-trail");
    trail.hidden = true;
    const frame = new ElementMock("frame");
    frame.contentWindow = {
      postMessage: (payload, target) => frame.posts.push({ payload, target }),
    };
    this.elements.set(trail.id, trail);
    this.elements.set(frame.id, frame);
    this.elements.set("win-close", new ElementMock("win-close"));
    this.elements.set("info-btn", new ElementMock("info-btn"));
  }

  getElementById(id: string): ElementMock | null {
    return this.elements.get(id) ?? null;
  }

  createElement(): ElementMock {
    return new ElementMock();
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: unknown,
  ): void {
    const callback =
      typeof listener === "function"
        ? (listener as (event: unknown) => void)
        : (event: unknown) => listener.handleEvent(event as Event);
    this.listeners.push({ type, listener: callback, options });
  }
}

interface HarnessRuntime extends Record<string, unknown> {
  document: Document;
  localStorage: MemoryStorage;
  location: { search: string };
  innerWidth: number;
  innerHeight: number;
  ReaderNewsGesture: NewsGestureApi;
  ReaderGestureClose?: ReaderGestureCloseApi;
  readonly listeners: ListenerRecord[];
  readonly timers: TimerRecord[];
  readonly draws: unknown[];
  readonly shellCalls: string[];
  readonly traceEvents: Array<{ readonly type: unknown; readonly detail: unknown }>;
  readonly traceCheckpoints: unknown[];
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  addEventListener: Window["addEventListener"];
}

interface TransportHarness {
  readonly transport: TauriTransport;
  readonly invokes: unknown[];
  readonly emits: unknown[];
  readonly listeners: Map<
    string,
    (event: { event: string; id: number; payload: unknown }) => void
  >;
}

function cleanPoints(value: unknown): GesturePoint[] {
  return (Array.isArray(value) ? value : []).map((point) => {
    const item = point as Record<string, unknown>;
    return { x: Number(item.x), y: Number(item.y) };
  });
}

function createGestureApi(draws: unknown[]): NewsGestureApi {
  const path = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];
  return {
    STORAGE_KEY: "legacy-path",
    ENABLED_KEY: "legacy-enabled",
    PRECISION_KEY: "legacy-precision",
    SAMPLE_COUNT: 3,
    MIN_PATH_LENGTH: 1,
    MATCH_THRESHOLD: 0.7,
    MATCH_THRESHOLDS: { low: 0.6, medium: 0.7, high: 0.8 },
    PRECISION_THRESHOLDS: [0.7],
    cleanPoints,
    pathLength: () => 20,
    normalize: cleanPoints,
    directionSequence: () => [0],
    directionSimilarity: () => 1,
    prefixSimilarity: () => 1,
    similarity: () => 1,
    parseStored: cleanPoints,
    load: () => path,
    save: cleanPoints,
    loadEnabled: () => true,
    saveEnabled: (enabled) => Boolean(enabled),
    normalizePrecision: (value) => String(value || "medium"),
    loadPrecision: () => "medium",
    savePrecision: (value) => String(value),
    matchThreshold: () => 0.7,
    clear: () => undefined,
    draw: (
      _canvas: HTMLCanvasElement | null | undefined,
      points: unknown,
      options?: GestureDrawOptions,
    ) => {
      draws.push({ points: cleanPoints(points), options: options ?? null });
    },
  };
}

function createRuntime(search = "?pool=1"): HarnessRuntime {
  const document = new DocumentMock();
  const listeners: ListenerRecord[] = [];
  const timers: TimerRecord[] = [];
  const draws: unknown[] = [];
  const shellCalls: string[] = [];
  const traceEvents: Array<{ readonly type: unknown; readonly detail: unknown }> = [];
  const traceCheckpoints: unknown[] = [];
  let nextTimerId = 1;
  const runtime: HarnessRuntime = {
    document: document as unknown as Document,
    localStorage: new MemoryStorage(),
    location: { search },
    innerWidth: 1_000,
    innerHeight: 800,
    ReaderNewsGesture: createGestureApi(draws),
    listeners,
    timers,
    draws,
    shellCalls,
    traceEvents,
    traceCheckpoints,
    ReaderBugTrace: {
      record: (type: unknown, detail?: unknown) => traceEvents.push({ type, detail }),
      checkpoint: (delayMs?: unknown) => traceCheckpoints.push(delayMs),
    },
    setTimeout: ((callback: TimerHandler, delay?: number) => {
      if (typeof callback !== "function")
        throw new TypeError("Callback required.");
      const id = nextTimerId++;
      timers.push({
        id,
        callback: callback as () => void,
        delay: Number(delay) || 0,
        cleared: false,
      });
      return id;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      const timer = timers.find((candidate) => candidate.id === id);
      if (timer) timer.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout,
    addEventListener: ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: unknown,
    ) => {
      const callback =
        typeof listener === "function"
          ? (listener as (event: unknown) => void)
          : (event: unknown) => listener.handleEvent(event as Event);
      listeners.push({ type, listener: callback, options });
    }) as Window["addEventListener"],
  };
  runtime.ReaderShell = {
    OVERLAY: { NONE: "none" },
    SIDE_PANEL: { NONE: "none" },
    closeSurface: () => {
      shellCalls.push("closeSurface");
      return true;
    },
    setSidePanel: (name: string, open: boolean) =>
      shellCalls.push(`side:${name}:${open}`),
    setOverlay: (name: string, open: boolean) =>
      shellCalls.push(`overlay:${name}:${open}`),
  };
  return runtime;
}

function sharedSettings(action: "back" | "book_info" | "undo_last" = "back") {
  return {
    enabled: true,
    globalPrecision: "medium",
    profiles: [
      {
        name: action === "back" ? "关闭测试" : action,
        scope: "reader",
        action,
        enabled: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        precision: "medium",
      },
    ],
    hintSettings: {
      enabled: true,
      fontSize: 22,
      backgroundEnabled: true,
      background: "#123456",
      opacity: 50,
      positionX: 0.5,
      positionY: 0.25,
      frameWidth: 240,
      frameHeight: 70,
      frameShape: "freeform",
      framePath: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 100 },
      ],
    },
  };
}

function createTransport(
  settings: unknown = sharedSettings(),
): TransportHarness {
  const invokes: unknown[] = [];
  const emits: unknown[] = [];
  const listeners = new Map<
    string,
    (event: { event: string; id: number; payload: unknown }) => void
  >();
  const transport: TauriTransport = {
    async invoke<TResult>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<TResult> {
      invokes.push({ command, args: args ?? null });
      if (command === "reader_gesture_settings_load")
        return settings as TResult;
      return undefined as TResult;
    },
    async listen<TPayload>(
      event: string,
      handler: (event: {
        event: string;
        id: number;
        payload: TPayload;
      }) => void,
    ) {
      listeners.set(
        event,
        handler as (event: {
          event: string;
          id: number;
          payload: unknown;
        }) => void,
      );
      return () => undefined;
    },
    async emit(event: string, payload?: unknown): Promise<void> {
      emits.push({ event, payload });
    },
  };
  return { transport, invokes, emits, listeners };
}

function attachTauri(runtime: HarnessRuntime, harness: TransportHarness): void {
  runtime.__TAURI__ = {
    core: { invoke: harness.transport.invoke.bind(harness.transport) },
    event: {
      listen: harness.transport.listen?.bind(harness.transport),
      emit: harness.transport.emit?.bind(harness.transport),
    },
  };
}

function installTyped(
  runtime: HarnessRuntime,
  transport: TauriTransport | null,
): ReaderGestureCloseApi {
  const api = installReaderGesture(runtime, transport);
  assert.ok(api);
  return api;
}

function dispatch(
  runtime: HarnessRuntime,
  type: string,
  event: unknown = {},
): void {
  for (const record of runtime.listeners.filter((item) => item.type === type))
    record.listener(event);
}

function documentOf(runtime: HarnessRuntime): DocumentMock {
  return runtime.document as unknown as DocumentMock;
}

function snapshot(runtime: HarnessRuntime): unknown {
  const document = documentOf(runtime);
  const hint = document.appended[0];
  const trail = document.getElementById("reader-gesture-trail");
  const frame = document.getElementById("frame");
  return structuredClone({
    listenerTypes: runtime.listeners.map(({ type, options }) => ({
      type,
      options: options ?? null,
    })),
    documentListenerTypes: document.listeners.map(({ type, options }) => ({
      type,
      options: options ?? null,
    })),
    hint: hint
      ? {
          className: hint.className,
          dataset: hint.dataset,
          hidden: hint.hidden,
          textContent: hint.textContent,
          style: hint.style,
        }
      : null,
    trail: trail ? { hidden: trail.hidden, dataset: trail.dataset } : null,
    draws: runtime.draws,
    shellCalls: runtime.shellCalls,
    posts: frame?.posts,
    winCloseClicks: document.getElementById("win-close")?.clickCount,
    infoClicks: document.getElementById("info-btn")?.clickCount,
    timers: runtime.timers.map(({ delay, cleared }) => ({ delay, cleared })),
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const COMPATIBILITY_API_KEYS = Object.freeze([
  "activate",
  "frameSurfaceClosed",
  "fromFrame",
]);

const COMPATIBILITY_RUNTIME_LISTENERS = Object.freeze([
  { type: "mousedown", options: true },
  { type: "mousemove", options: { capture: true, passive: false } },
  { type: "mouseup", options: true },
  { type: "blur", options: null },
  { type: "contextmenu", options: true },
  { type: "reader-shell-statechange", options: null },
  { type: "reader-undo-checkpoint", options: null },
]);

test("installer guard and pool bootstrap retain the frozen compatibility contract", () => {
  const runtime = createRuntime();
  const api = installTyped(runtime, null);
  assert.deepEqual(Object.keys(api).sort(), COMPATIBILITY_API_KEYS);
  assert.equal(runtime.ReaderGestureClose, api);
  assert.equal(runtime.listeners.length, 0);
  assert.deepEqual(snapshot(runtime), {
    listenerTypes: [],
    documentListenerTypes: [],
    hint: {
      className: "reader-gesture-hint",
      dataset: { overlaySurface: "gesture-hint", overlayRole: "feedback" },
      hidden: true,
      textContent: "",
      style: {},
    },
    trail: { hidden: true, dataset: {} },
    draws: [],
    shellCalls: [],
    posts: [],
    winCloseClicks: 0,
    infoClicks: 0,
    timers: [],
  });

  const missingRuntime = createRuntime();
  documentOf(missingRuntime).elements.delete("reader-gesture-trail");
  assert.equal(installReaderGesture(missingRuntime, null), null);
  assert.equal(missingRuntime.ReaderGestureClose, undefined);
});

test("typed transport, activation, canvas, hint, and back keep the compatibility behavior", async () => {
  const runtime = createRuntime();
  const transport = createTransport();
  const api = installTyped(runtime, transport.transport);
  api.activate();
  api.activate();
  await flush();

  assert.deepEqual(
    runtime.listeners.map(({ type, options }) => ({
      type,
      options: options ?? null,
    })),
    COMPATIBILITY_RUNTIME_LISTENERS,
  );
  assert.deepEqual(
    documentOf(runtime).listeners.map(({ type, options }) => ({
      type,
      options: options ?? null,
    })),
    [{ type: "visibilitychange", options: null }],
  );
  assert.deepEqual(transport.invokes, [
    { command: "reader_gesture_settings_load", args: null },
    {
      command: "reader_perf_log",
      args: { event: "gesture config durable enabled=true actions=back" },
    },
  ]);
  assert.deepEqual(transport.emits, [
    { event: "reader-gesture-settings-request", payload: {} },
  ]);
  assert.equal(transport.listeners.has("reader-gesture-settings"), true);

  api.fromFrame({ phase: "start", x: 2, y: 3 });
  api.fromFrame({ phase: "move", x: 20, y: 3 });
  assert.deepEqual(runtime.draws, [
    {
      points: [{ x: 22, y: 33 }],
      options: { color: "#3478d4", lineWidth: 5 },
    },
    {
      points: [
        { x: 22, y: 33 },
        { x: 40, y: 33 },
      ],
      options: { color: "#3478d4", lineWidth: 5 },
    },
  ]);
  const hint = documentOf(runtime).appended[0];
  assert.equal(hint?.textContent, "关闭测试");
  assert.equal(hint?.hidden, false);
  assert.equal(hint?.dataset.overlayActive, "true");
  assert.deepEqual(hint?.style, {
    fontSize: "22px",
    background: "rgba(18,52,86,0.5)",
    width: "240px",
    minHeight: "70px",
    clipPath: "polygon(0% 0%,100% 0%,50% 100%)",
    left: "460px",
    top: "195px",
    right: "auto",
  });
  assert.deepEqual(
    runtime.timers.map(({ delay, cleared }) => ({ delay, cleared })),
    [],
  );

  api.fromFrame({ phase: "end", x: 20, y: 3 });
  await flush();
  assert.deepEqual(runtime.draws.at(-1), { points: [], options: null });
  assert.deepEqual(runtime.shellCalls, ["closeSurface"]);
  const gestureEvents = runtime.traceEvents.filter(({ type }) =>
    String(type).startsWith("gesture_"),
  );
  assert.deepEqual(gestureEvents.map(({ type }) => type), [
    "gesture_start",
    "gesture_preview",
    "gesture_finish",
    "gesture_execute",
  ]);
  assert.equal(
    new Set(gestureEvents.map(({ detail }) => (detail as { gesture_id?: unknown }).gesture_id)).size,
    1,
  );
  assert.deepEqual(gestureEvents.at(-1)?.detail, {
    gesture_id: 1,
    source: "frame",
    action: "back",
    route: "shell_surface",
    handled: true,
    outcome: "succeeded",
  });
  assert.equal(runtime.traceCheckpoints.includes(0), true);
  const serializedTrace = JSON.stringify(gestureEvents);
  assert.equal(serializedTrace.includes("关闭测试"), false);
  assert.equal(serializedTrace.includes('"x"'), false);
  assert.equal(serializedTrace.includes('"y"'), false);
  assert.equal(hint?.hidden, true);
  assert.equal(
    documentOf(runtime).getElementById("reader-gesture-trail")?.hidden,
    true,
  );

  const nextSettings = sharedSettings("book_info");
  transport.listeners.get("reader-gesture-settings")?.({
    event: "reader-gesture-settings",
    id: 1,
    payload: nextSettings,
  });
  await flush();
  assert.deepEqual(transport.invokes.at(-1), {
    command: "reader_perf_log",
    args: { event: "gesture config event enabled=true actions=book_info" },
  });
});

test("frame close handshake waits for acknowledgement and does not close the window", async () => {
  const runtime = createRuntime();
  runtime.ReaderShell = { closeSurface: () => false };
  const api = installTyped(runtime, null);
  api.activate();
  api.fromFrame({ phase: "start", x: 0, y: 0 });
  api.fromFrame({ phase: "move", x: 20, y: 0 });
  api.fromFrame({ phase: "end", x: 20, y: 0 });
  await flush();
  assert.deepEqual(documentOf(runtime).getElementById("frame")?.posts, [
    { payload: { readerGestureAction: "back" }, target: "*" },
  ]);
  assert.deepEqual(
    runtime.timers.map(({ delay, cleared }) => ({ delay, cleared })),
    [{ delay: 120, cleared: false }],
  );
  api.frameSurfaceClosed(true);
  await flush();
  assert.equal(runtime.timers[0]?.cleared, true);
  assert.equal(documentOf(runtime).getElementById("win-close")?.clickCount, 0);
  const frameResult = runtime.traceEvents.find(({ type, detail }) =>
    type === "gesture_execute" &&
    (detail as { route?: unknown }).route === "frame_surface",
  );
  const { duration_ms: durationMs, ...stableDetail } = (frameResult?.detail ?? {}) as Record<string, unknown>;
  assert.deepEqual(stableDetail, {
    gesture_id: 1,
    source: "frame",
    action: "back",
    route: "frame_surface",
    handled: true,
    outcome: "succeeded",
  });
  assert.equal(typeof durationMs, "number");
  assert.ok(typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0);
});

test("finish executes the action shown by a hint after an arbitrarily long tail", async () => {
  const runtime = createRuntime();
  runtime.localStorage.setItem(
    "kunpeng.reader.gesture-hint.v1",
    JSON.stringify({ enabled: true }),
  );
  runtime.ReaderNewsGesture = {
    ...runtime.ReaderNewsGesture,
    prefixSimilarity: () => 1,
    similarity: () => 0,
  };
  const api = installTyped(runtime, null);
  api.activate();

  api.fromFrame({ phase: "start", x: 0, y: 0 });
  api.fromFrame({ phase: "move", x: 20, y: 0 });
  for (let x = 24; x <= 160; x += 4)
    api.fromFrame({ phase: "move", x, y: 0 });
  api.fromFrame({ phase: "end", x: 160, y: 0 });
  await flush();

  assert.deepEqual(runtime.shellCalls, ["closeSurface"]);
  assert.equal(documentOf(runtime).appended[0]?.hidden, true);
});

test("cancelling a hinted gesture never executes its action", async () => {
  const runtime = createRuntime();
  const transport = createTransport();
  const api = installTyped(runtime, transport.transport);
  api.activate();
  await flush();

  api.fromFrame({ phase: "start", x: 0, y: 0 });
  api.fromFrame({ phase: "move", x: 20, y: 0 });
  api.fromFrame({ phase: "cancel", x: 20, y: 0 });
  await flush();

  assert.deepEqual(runtime.shellCalls, []);
  assert.equal(documentOf(runtime).appended[0]?.hidden, true);
});

test("closed-surface undo reopens the most recent original shell surface", async () => {
  const runtime = createRuntime();
  runtime.localStorage.setItem(
    "kunpeng.reader.gesture-manager.enabled.v1",
    "true",
  );
  runtime.localStorage.setItem(
    "kunpeng.reader.gesture-manager.v1",
    JSON.stringify({
      globalPrecision: "medium",
      profiles: [
        {
          name: "撤销上一步",
          action: "undo_last",
          scope: "reader",
          enabled: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 20, y: 0 },
          ],
          precision: "medium",
        },
      ],
    }),
  );
  const api = installTyped(runtime, null);
  api.activate();
  const shellEvent = {
    detail: {
      previous: { sidePanel: "ai-reader", overlay: "none" },
      next: { sidePanel: "none", overlay: "none" },
    },
  };
  dispatch(runtime, "reader-shell-statechange", shellEvent);
  api.fromFrame({ phase: "start", x: 0, y: 0 });
  api.fromFrame({ phase: "move", x: 20, y: 0 });
  api.fromFrame({ phase: "end", x: 20, y: 0 });
  await flush();
  assert.deepEqual(runtime.shellCalls, ["side:ai-reader:true"]);
  assert.deepEqual(runtime.draws.at(-1), { points: [], options: null });
  assert.equal(
    runtime.traceEvents.some(({ type, detail }) =>
      type === "gesture_execute" &&
      (detail as { route?: unknown }).route === "undo_surface" &&
      (detail as { handled?: unknown }).handled === true,
    ),
    true,
  );
});

test("reading-position checkpoint is restored by the undo gesture", async () => {
  const runtime = createRuntime();
  runtime.localStorage.setItem(
    "kunpeng.reader.gesture-manager.enabled.v1",
    "true",
  );
  runtime.localStorage.setItem(
    "kunpeng.reader.gesture-manager.v1",
    JSON.stringify({
      globalPrecision: "medium",
      profiles: [
        {
          name: "撤销上一步",
          action: "undo_last",
          scope: "reader",
          enabled: true,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 20, y: 0 },
          ],
          precision: "medium",
        },
      ],
    }),
  );
  let restored = 0;
  runtime.hasReaderJumpHistory = () => true;
  runtime.restoreReaderJumpPosition = () => {
    restored += 1;
    return true;
  };
  const api = installTyped(runtime, null);
  api.activate();
  dispatch(runtime, "reader-undo-checkpoint");
  api.fromFrame({ phase: "start", x: 0, y: 0 });
  api.fromFrame({ phase: "move", x: 20, y: 0 });
  api.fromFrame({ phase: "end", x: 20, y: 0 });
  await flush();
  assert.equal(restored, 1);
});

test("global boundary adapts the Tauri transport while preserving the same public contract", async () => {
  const runtime = createRuntime();
  const harness = createTransport();
  attachTauri(runtime, harness);
  const api = installReaderGesture(runtime);
  assert.ok(api);
  assert.deepEqual(Object.keys(api).sort(), COMPATIBILITY_API_KEYS);
  api.activate();
  await flush();
  assert.equal(
    harness.invokes.some(
      (call) =>
        (call as { command?: string }).command ===
        "reader_gesture_settings_load",
    ),
    true,
  );
  assert.equal(harness.listeners.has("reader-gesture-settings"), true);
});
