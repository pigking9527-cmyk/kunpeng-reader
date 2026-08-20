import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installReaderJumpBackRules,
  readerJumpBackRulesApi,
} from "./reader-jump-back-rules.ts";
import {
  installReaderNavigationRules,
  readerNavigationRulesApi,
} from "./reader-navigation-rules.ts";
import {
  installReaderShell,
} from "./reader-shell-state.ts";
import type {
  ReaderShellApi,
} from "./reader-shell-state.ts";
import {
  installReaderStartupGuard,
} from "./reader-startup-guard.ts";
import type {
  ReaderStartupGuardApi,
} from "./reader-startup-guard.ts";

interface ClassListMock {
  readonly values: Set<string>;
  readonly toggle: (name: string, force?: boolean) => boolean;
  readonly remove: (...names: string[]) => void;
}

interface ElementMock {
  className: string;
  textContent: string | null;
  type: string;
  readonly classList: ClassListMock;
  readonly listeners: Map<string, ((event: Event) => void)[]>;
  readonly children: ElementMock[];
  readonly addEventListener: (
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  readonly append: (...children: ElementMock[]) => void;
  readonly replaceChildren: (...children: ElementMock[]) => void;
}

interface RuntimeEvent {
  readonly type: string;
  readonly detail?: unknown;
}

interface TimerRecord {
  readonly id: number;
  readonly callback: () => void;
  readonly delay: number;
  cleared: boolean;
}

interface TestRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Pick<Storage, "getItem" | "setItem">;
  readonly CustomEvent: typeof CustomEvent;
  readonly dispatchEvent: (event: Event) => boolean;
  readonly addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly elements: Map<string, ElementMock>;
  readonly storageWrites: string[];
  readonly dispatchedEvents: RuntimeEvent[];
  readonly globalListeners: Map<string, ((event: unknown) => void)[]>;
  readonly timers: TimerRecord[];
}

function createClassList(): ClassListMock {
  const values = new Set<string>();
  return {
    values,
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : force;
      if (on) values.add(name);
      else values.delete(name);
      return on;
    },
    remove(...names) {
      for (const name of names) values.delete(name);
    },
  };
}

function createElement(): ElementMock {
  const children: ElementMock[] = [];
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    className: "",
    textContent: null,
    type: "",
    classList: createClassList(),
    listeners,
    children,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    append(...nextChildren) {
      children.push(...nextChildren);
    },
    replaceChildren(...nextChildren) {
      children.splice(0, children.length, ...nextChildren);
    },
  };
}

function createRuntime(storedImmersive: string | null = null): TestRuntime {
  const elementIds = [
    "settings",
    "reader-preferences-modal",
    "rsearch",
    "toc",
    "vocab",
    "info-modal",
    "anno-modal",
    "cross-modal",
    "reader-end-modal",
    "ai-reader-side",
    "backdrop",
    "vocab-settings",
    "loading",
    "win-close",
  ];
  const elements = new Map(elementIds.map((id) => [id, createElement()]));
  const body = createElement();
  const storageWrites: string[] = [];
  const dispatchedEvents: RuntimeEvent[] = [];
  const globalListeners = new Map<string, ((event: unknown) => void)[]>();
  const timers: TimerRecord[] = [];
  let nextTimerId = 1;
  const runtime: TestRuntime = {
    elements,
    storageWrites,
    dispatchedEvents,
    globalListeners,
    timers,
    document: {
      body,
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => createElement(),
    } as unknown as Document,
    localStorage: {
      getItem: () => storedImmersive,
      setItem: (key: string, value: string) => {
        storageWrites.push(`${key}=${value}`);
      },
    },
    CustomEvent: class MockCustomEvent {
      readonly type: string;
      readonly detail: unknown;

      constructor(type: string, init?: CustomEventInit) {
        this.type = type;
        this.detail = init?.detail;
      }
    } as unknown as typeof CustomEvent,
    dispatchEvent: (event: Event) => {
      const shaped = event as unknown as RuntimeEvent;
      dispatchedEvents.push({ type: shaped.type, detail: shaped.detail });
      return true;
    },
    addEventListener: (type, listener) => {
      globalListeners.set(type, [...(globalListeners.get(type) ?? []), listener]);
    },
    setTimeout: ((callback: TimerHandler, delay?: number) => {
      if (typeof callback !== "function") throw new TypeError("Timer callback must be callable.");
      const id = nextTimerId++;
      const timerCallback = callback as () => void;
      timers.push({ id, callback: timerCallback, delay: Number(delay) || 0, cleared: false });
      return id;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      const timer = timers.find((candidate) => candidate.id === id);
      if (timer) timer.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout,
  };
  return runtime;
}

function loadClassicScript(runtime: TestRuntime, filename: string): void {
  const source = readFileSync(new URL(`../../../../../ui/generated-ts/${filename}`, import.meta.url), "utf8");
  runtime.window = runtime;
  vm.runInNewContext(source, runtime);
}

function publicShape(value: object): string[] {
  return Object.keys(value).sort();
}

function realmNeutral<T>(value: T): T {
  return structuredClone(value);
}

function plainState(api: ReaderShellApi): Readonly<Record<string, unknown>> {
  return { ...api.getState() };
}

test("navigation and jump-back entries expose the exact frozen classic API", () => {
  const classicNavigationRuntime = createRuntime();
  const typedNavigationRuntime = createRuntime();
  loadClassicScript(classicNavigationRuntime, "reader-navigation-rules.js");
  const typedNavigation = installReaderNavigationRules(typedNavigationRuntime);
  const classicNavigation = classicNavigationRuntime.ReaderNavigationRules as typeof readerNavigationRulesApi;
  assert.deepEqual(publicShape(typedNavigation), publicShape(classicNavigation));
  assert.equal(Object.isFrozen(typedNavigation), true);
  assert.equal(typedNavigationRuntime.ReaderNavigationRules, typedNavigation);
  assert.equal(typedNavigation.HISTORY_LIMIT, classicNavigation.HISTORY_LIMIT);
  assert.deepEqual(
    realmNeutral(typedNavigation.appendHistory([], { chapter: "2", chFrac: 2, progress: -1 }, {}, 4)),
    realmNeutral(classicNavigation.appendHistory([], { chapter: "2", chFrac: 2, progress: -1 }, {}, 4)),
  );

  const classicJumpRuntime = createRuntime();
  const typedJumpRuntime = createRuntime();
  loadClassicScript(classicJumpRuntime, "reader-jump-back-rules.js");
  const typedJump = installReaderJumpBackRules(typedJumpRuntime);
  const classicJump = classicJumpRuntime.ReaderJumpBackRules as typeof readerJumpBackRulesApi;
  assert.deepEqual(publicShape(typedJump), publicShape(classicJump));
  assert.equal(Object.isFrozen(typedJump), true);
  assert.equal(typedJumpRuntime.ReaderJumpBackRules, typedJump);
  for (const value of [-1, 0, 31.4, 160.8, "bad", undefined]) {
    assert.equal(typedJump.normalizePosition(value, 500), classicJump.normalizePosition(value, 500));
    assert.equal(typedJump.normalizeIconSizePx(value), classicJump.normalizeIconSizePx(value));
  }
});

test("reader shell installer preserves public constants, transitions, hooks, storage, and classes", () => {
  const classicRuntime = createRuntime("1");
  const typedRuntime = createRuntime("1");
  loadClassicScript(classicRuntime, "reader-shell-state.js");
  const classic = classicRuntime.ReaderShell as ReaderShellApi;
  const typed = installReaderShell(typedRuntime);

  assert.deepEqual(publicShape(typed), publicShape(classic));
  assert.deepEqual(realmNeutral(typed.OVERLAY), realmNeutral(classic.OVERLAY));
  assert.deepEqual(realmNeutral(typed.TOOLBAR), realmNeutral(classic.TOOLBAR));
  assert.deepEqual(realmNeutral(typed.SIDE_PANEL), realmNeutral(classic.SIDE_PANEL));
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(plainState(typed), plainState(classic));

  const classicHooks: string[] = [];
  const typedHooks: string[] = [];
  classic.registerOverlay(classic.OVERLAY.SEARCH, {
    onOpen: () => classicHooks.push("search:open"),
    onClose: () => classicHooks.push("search:close"),
  });
  typed.registerOverlay(typed.OVERLAY.SEARCH, {
    onOpen: () => typedHooks.push("search:open"),
    onClose: () => typedHooks.push("search:close"),
  });
  classic.registerSidePanel(classic.SIDE_PANEL.AI_READER, {
    onOpen: () => classicHooks.push("ai:open"),
    onClose: () => classicHooks.push("ai:close"),
  });
  typed.registerSidePanel(typed.SIDE_PANEL.AI_READER, {
    onOpen: () => typedHooks.push("ai:open"),
    onClose: () => typedHooks.push("ai:close"),
  });

  const actions: readonly Readonly<Record<string, unknown>>[] = [
    { type: "SET_OVERLAY", overlay: "search" },
    { type: "TOOLBAR_POINTER_LEAVE" },
    { type: "SET_SIDE_PANEL", sidePanel: "ai-reader" },
    { type: "SET_IMMERSIVE", on: false },
    { type: "SHOW_TOOLBAR" },
    { type: "SET_OVERLAY", overlay: "none" },
  ];
  for (const action of actions) {
    classic.dispatch(action);
    typed.dispatch(action);
    assert.deepEqual(plainState(typed), plainState(classic));
  }
  assert.equal(classic.closeSurface(), true);
  assert.equal(typed.closeSurface(), true);
  assert.deepEqual(plainState(typed), plainState(classic));
  assert.deepEqual(typedHooks, classicHooks);
  assert.deepEqual(typedRuntime.storageWrites, classicRuntime.storageWrites);
  assert.deepEqual(
    [...typedRuntime.elements.entries()].map(([id, element]) => [id, [...element.classList.values].sort()]),
    [...classicRuntime.elements.entries()].map(([id, element]) => [id, [...element.classList.values].sort()]),
  );
});

test("startup guard installer preserves the exact classic API and safe state transitions", async () => {
  const classicRuntime = createRuntime();
  const typedRuntime = createRuntime();
  loadClassicScript(classicRuntime, "reader-startup-guard.js");
  const classic = classicRuntime.ReaderStartupGuard as ReaderStartupGuardApi;
  const typed = installReaderStartupGuard(typedRuntime);

  assert.deepEqual(publicShape(typed), publicShape(classic));
  assert.equal(Object.isFrozen(typed), true);
  for (const source of [
    "reader://localhost/book/1",
    "http://reader.localhost/book/1",
    "pdfview.html?id=1",
    "about:blank",
    "https://example.com",
    null,
  ]) {
    assert.equal(typed.validDocumentSource(source), classic.validDocumentSource(source));
  }

  classic.markScriptReady();
  typed.markScriptReady();
  classic.beginBookLoad();
  typed.beginBookLoad();
  assert.equal(classic.beginFrameNavigation("reader://localhost/book/1"), true);
  assert.equal(typed.beginFrameNavigation("reader://localhost/book/1"), true);
  classic.markFrameReady();
  typed.markFrameReady();
  assert.deepEqual(realmNeutral(typed.state()), realmNeutral(classic.state()));
  assert.equal(await classic.closeSafely(async () => undefined), true);
  assert.equal(await typed.closeSafely(async () => undefined), true);
  assert.deepEqual(realmNeutral(typed.state()), realmNeutral(classic.state()));
  assert.equal(await typed.closeSafely(), false);
  assert.equal(await classic.closeSafely(), false);
  assert.deepEqual(
    typedRuntime.timers.map(({ delay, cleared }) => ({ delay, cleared })),
    classicRuntime.timers.map(({ delay, cleared }) => ({ delay, cleared })),
  );
});
