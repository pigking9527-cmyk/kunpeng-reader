import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import { installGestureUi, type GestureUiRuntime } from "./gesture-ui.ts";

type EventHandler = (event: Event) => void;

class FakeElement {
  public readonly dataset: Record<string, string> = {};
  public readonly style = {
    display: "",
    left: "",
    right: "",
    top: "",
    setProperty: (name: string, value: string) => {
      void name;
      void value;
    },
    removeProperty: (name: string) => {
      void name;
      return "";
    },
  };
  public readonly classList = {
    add: (...names: string[]) => {
      void names;
    },
    remove: (...names: string[]) => {
      void names;
    },
    contains: (name: string) => {
      void name;
      return false;
    },
    toggle: (name: string, force?: boolean) => {
      void name;
      void force;
      return false;
    },
  };
  public readonly listeners = new Map<string, EventHandler[]>();
  public parentElement: FakeElement | null = null;
  public textContent = "";
  public className = "";
  public id = "";
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public width = 640;
  public height = 360;
  public type = "";
  public offsetWidth = 200;
  public offsetHeight = 60;
  public isConnected = true;

  public addEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  public appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    return child;
  }
  public append(...children: FakeElement[]): void {
    children.forEach((child) => {
      child.parentElement = this;
    });
  }
  public click(): void {}
  public closest<T extends Element = Element>(selector: string): T | null {
    void selector;
    return null;
  }
  public contains(target: Node | null): boolean {
    void target;
    return false;
  }
  public getAttribute(name: string): string | null {
    void name;
    return null;
  }
  public getBoundingClientRect(): DOMRect {
    return {
      bottom: 360,
      height: 360,
      left: 0,
      right: 640,
      top: 0,
      width: 640,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }
  public querySelector<T extends Element = Element>(
    selector: string,
  ): T | null {
    void selector;
    return new FakeElement() as unknown as T;
  }
  public querySelectorAll<T extends Element = Element>(
    selector: string,
  ): NodeListOf<T> {
    void selector;
    return [] as unknown as NodeListOf<T>;
  }
  public replaceChildren(...children: FakeElement[]): void {
    children.forEach((child) => {
      child.parentElement = this;
    });
  }
  public removeAttribute(name: string): void {
    if (name === "data-overlay-active") delete this.dataset.overlayActive;
  }
  public setAttribute(name: string, value: string): void {
    void name;
    void value;
  }
  public setPointerCapture(pointerId: number): void {
    void pointerId;
  }
}

class FakeDocument {
  public readonly body = new FakeElement();
  private readonly elements = new Map<string, FakeElement>();

  public getElementById(id: string): FakeElement {
    const existing = this.elements.get(id);
    if (existing) return existing;
    const created = new FakeElement();
    created.id = id;
    created.parentElement = new FakeElement();
    this.elements.set(id, created);
    return created;
  }
  public createElement(): FakeElement {
    return new FakeElement();
  }
  public querySelector(): FakeElement {
    return new FakeElement();
  }
  public querySelectorAll(): FakeElement[] {
    return [];
  }
  public addEventListener(): void {}
}

function gestureApi(): NonNullable<GestureUiRuntime["ReaderNewsGesture"]> {
  const points = Array.from({ length: 48 }, (_, index) => ({
    x: index / 47,
    y: 0,
  }));
  return {
    SAMPLE_COUNT: 48,
    STORAGE_KEY: "legacy-gesture",
    MIN_PATH_LENGTH: 32,
    cleanPoints: (value) =>
      Array.isArray(value) ? (value as typeof points) : [],
    load: () => points,
    save: (value) => (Array.isArray(value) ? (value as typeof points) : []),
    clear: () => undefined,
    loadPrecision: () => "5",
    savePrecision: (value) => String(value),
    normalizePrecision: (value) => String(value || "5"),
    normalize: (value) =>
      Array.isArray(value) ? (value as typeof points) : [],
    similarity: () => 1,
    prefixSimilarity: () => 1,
    matchThreshold: () => 0.78,
    pathLength: () => 100,
    draw: () => undefined,
    saveEnabled: (value) => Boolean(value),
  };
}

interface NativeCall {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function harness() {
  const calls: NativeCall[] = [];
  const emits: Array<{ event: string; payload: unknown }> = [];
  const listeners = new Map<string, (event: TauriEvent<unknown>) => void>();
  const transport: TauriTransport = {
    async invoke<TResult>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<TResult> {
      calls.push(args ? { command, args } : { command });
      return (
        command === "app_settings_sync_get"
          ? { hasGestureSettings: false }
          : undefined
      ) as TResult;
    },
    async listen<TPayload>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ) {
      listeners.set(event, handler as (event: TauriEvent<unknown>) => void);
      return () => undefined;
    },
    async emit<TPayload>(event: string, payload?: TPayload) {
      emits.push({ event, payload });
    },
  };
  const values = new Map<string, string>();
  const document = new FakeDocument();
  const runtime = {
    document: document as unknown as Document,
    ReaderNewsGesture: gestureApi(),
    ReaderGestureHintRules: undefined,
    ReaderGestureUI: undefined,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    addEventListener: () => undefined,
    dispatchEvent: () => true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    queueMicrotask: () => undefined,
    innerWidth: 1200,
    innerHeight: 800,
    confirm: () => true,
  };
  return { calls, emits, listeners, runtime, transport, values };
}

test("gesture UI freezes the original DOM, storage, command and event contract", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  for (const key of [
    "kunpeng.reader.gesture-manager.v1",
    "kunpeng.reader.gesture-manager.enabled.v1",
    "kunpeng.reader.gesture-hint.v1",
  ])
    assert.ok(source.includes(`"${key}"`), `missing storage key ${key}`);
  for (const command of [
    "reader_gesture_settings_save",
    "app_settings_sync_get",
    "app_settings_sync_save",
    "open_book",
    "main_window_close",
  ])
    assert.ok(
      source.includes(`nativeApi.invoke("${command}"`),
      `missing native command ${command}`,
    );
  for (const event of [
    "reader-gesture-settings",
    "reader-gesture-settings-request",
    "reader-closed-for-reopen",
    "app-settings-synced",
  ])
    assert.ok(source.includes(`"${event}"`), `missing event ${event}`);
  for (const id of [
    "gesture-settings-modal",
    "gesture-manager-layout",
    "gesture-global-precision",
    "gesture-hint-background",
    "gesture-hint-preview-path",
    "gesture-pad",
    "gesture-list",
    "gesture-editor",
    "newsnow-gesture-trail",
  ])
    assert.ok(source.includes(`get("${id}")`), `missing original DOM id ${id}`);
  assert.doesNotMatch(
    source,
    /__TAURI__|\bany\b|@ts-ignore|@ts-expect-error|eval\s*\(|new\s+Function/u,
  );
});

test("background-off hints keep their text visible and preview-positionable", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /hintPreview\.hidden = hintDrawingFrame/);
  assert.match(source, /node\.style\.background = background/);
  assert.match(
    source,
    /node\.style\.color = hintSettings\.backgroundEnabled \? "" : "#35516f"/,
  );
  assert.match(
    source,
    /node\.style\.boxShadow = hintSettings\.backgroundEnabled \? "" : "none"/,
  );
  assert.match(source, /placeHintPreview\(\);/);
  assert.match(
    source,
    /if \(event\.target === hintPreview\) \{\s*updateHintPreviewPosition\(event\);\s*return;\s*\}\s*if \(!hintSettings\.backgroundEnabled\) return;/,
  );
});

test("close dismisses gesture editing before closing settings and records the editor for undo", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /gestureSettings\.contains\(target\)[\s\S]*?if \(!editor\.hidden\)[\s\S]*?returnToSettingsOverview\(\);[\s\S]*?runCloseOrUndo\([\s\S]*?"手势设置"[\s\S]*?closeSettings[\s\S]*?openSettings/,
  );
  assert.match(
    source,
    /function returnToSettingsOverview\(\): void \{[\s\S]*?captureEditorSnapshot\(\);[\s\S]*?closeEditor\(\);[\s\S]*?rememberClosedPage\([\s\S]*?restoreEditorSnapshot\(snapshot\)/,
  );
  assert.match(
    source,
    /points: training\.slice\(\)[\s\S]*?actionSearch: actionSearch\.value[\s\S]*?status: status\.textContent/,
  );
});

test("main-window close never restores a closed surface", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function reopenLastClosedPage\(\): boolean \{[\s\S]*?const previous = closedPages\.pop\(\);[\s\S]*?previous\.reopen\(\);[\s\S]*?return true;/,
  );
  assert.match(
    source,
    /function closeMainWindowOrUndo\(action: GestureAction\): void \{[\s\S]*?if \(action === "undo_last"\)[\s\S]*?reopenLastClosedPage\(\);[\s\S]*?return;[\s\S]*?mainWindowClose\(\);/,
  );
  assert.doesNotMatch(source, /action === "back"[^\n]*reopenLastClosedPage/);
  assert.match(
    source,
    /function activeSurface\(target: Node \| null\): GestureSurface \| null \{[\s\S]*?syncMainCloseHistory\(\);[\s\S]*?withGestureInfo\(target, baseSurface\(target\)\)/,
  );
});

test("account panel close is handled before the main-window fallback", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const accountPanel = optional\("account-panel"\);[\s\S]*?accountPanel\?\.classList\.contains\("show"\)[\s\S]*?accountPanel\.contains\(target\)[\s\S]*?runCloseOrUndo\([\s\S]*?"账户"[\s\S]*?global\.ReaderSyncUI\?\.close\?\.\(\)/,
  );
  const accountSurface = source.slice(
    source.indexOf('const accountPanel = optional("account-panel")'),
    source.indexOf('const statsModal = optional("stats-modal")'),
  );
  assert.doesNotMatch(accountSurface, /mainWindowClose/);
});

test("closed main surfaces are deduplicated and restored with their exact state", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const duplicateIndex = closedPages\.findIndex\([\s\S]*?page\.key === normalizedKey[\s\S]*?closedPages\.splice\(duplicateIndex, 1\)/,
  );
  assert.match(
    source,
    /function runCloseOrUndo\([\s\S]*?if \(name && reopen\) rememberClosedPage\(name, reopen, key \|\| name\);[\s\S]*?close\?\.\(\)/,
  );
  assert.match(
    source,
    /const selectedAccountTab = accountTab\(accountPanel\);[\s\S]*?reopenAccountPanel\(selectedAccountTab\)[\s\S]*?"main:account-panel"/,
  );
  assert.match(
    source,
    /const account = optional\("account-panel"\);[\s\S]*?account\?\.classList\.contains\("show"\)[\s\S]*?add\(account\)/,
  );
  assert.match(
    source,
    /function reopenAccountPanel\(tab: AccountTab\): void \{[\s\S]*?ReaderSyncUI\?\.open[\s\S]*?optional\(tabButtons\[tab\]\)\?\.click\(\)/,
  );
  assert.match(
    source,
    /node\.id\.startsWith\("newsnow-"\)[\s\S]*?gestureReopen\?\.\(\)[\s\S]*?reopenNewsSurface \|\|/,
  );
});

test("legacy default back names migrate to the close label", async () => {
  const source = await readFile(
    new URL("./gesture-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /back: "关闭"/);
  assert.match(
    source,
    /\["返回／关闭当前页", "返回\/关闭当前页"\]\.includes\(savedName\)/,
  );
  assert.match(
    source,
    /关闭当前页面、面板或窗口；不会返回上一级，也不会恢复先前页面。/,
  );
});

test("typed transport preserves initial gesture publish and sync envelopes", async () => {
  const originalElement = Object.getOwnPropertyDescriptor(
    globalThis,
    "Element",
  );
  const originalCustomEvent = Object.getOwnPropertyDescriptor(
    globalThis,
    "CustomEvent",
  );
  const originalMutationObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "MutationObserver",
  );
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: class {
      public constructor(
        public readonly type: string,
        public readonly init: unknown,
      ) {}
    },
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: class {
      public constructor(callback: MutationCallback) {
        void callback;
      }
      public observe(): void {}
    },
  });
  try {
    const view = harness();
    const installed = installGestureUi(
      view.runtime as unknown as GestureUiRuntime,
      view.transport,
    );
    assert.ok(installed);
    assert.equal(
      (view.runtime as { ReaderGestureUI?: unknown }).ReaderGestureUI,
      installed,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const save = view.calls.find(
      (call) => call.command === "reader_gesture_settings_save",
    );
    assert.ok(save?.args?.settings);
    assert.deepEqual(
      view.calls.filter((call) => call.command === "app_settings_sync_get"),
      [{ command: "app_settings_sync_get" }],
    );
    assert.equal(view.emits[0]?.event, "reader-gesture-settings");
    assert.ok(view.listeners.has("reader-gesture-settings-request"));
    assert.ok(view.listeners.has("reader-closed-for-reopen"));
    assert.ok(view.listeners.has("app-settings-synced"));
    assert.equal(
      view.values.get("kunpeng.reader.gesture-manager.enabled.v1"),
      undefined,
    );
  } finally {
    if (originalElement)
      Object.defineProperty(globalThis, "Element", originalElement);
    else Reflect.deleteProperty(globalThis, "Element");
    if (originalCustomEvent)
      Object.defineProperty(globalThis, "CustomEvent", originalCustomEvent);
    else Reflect.deleteProperty(globalThis, "CustomEvent");
    if (originalMutationObserver)
      Object.defineProperty(
        globalThis,
        "MutationObserver",
        originalMutationObserver,
      );
    else Reflect.deleteProperty(globalThis, "MutationObserver");
  }
});

test("missing classic dependencies keep installation inert", () => {
  const runtime = { document: new FakeDocument() as unknown as Document };
  assert.equal(installGestureUi(runtime as unknown as GestureUiRuntime), null);
  assert.equal(
    (runtime as { ReaderGestureUI?: unknown }).ReaderGestureUI,
    undefined,
  );
});

test("missing original gesture DOM keeps installation inert without throwing", () => {
  const runtime = {
    document: {
      getElementById: () => null,
      querySelector: () => null,
    } as unknown as Document,
    ReaderNewsGesture: gestureApi(),
  };
  assert.equal(installGestureUi(runtime as unknown as GestureUiRuntime), null);
  assert.equal(
    (runtime as { ReaderGestureUI?: unknown }).ReaderGestureUI,
    undefined,
  );
});
