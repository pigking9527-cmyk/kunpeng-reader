import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installStartupPerf } from "./startup-perf.ts";
import { installTitlebar } from "./titlebar.ts";
import { installWindowResize } from "./window-resize.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(fileName: string): string {
  return readFileSync(new URL(`ui/generated-ts/${fileName}`, repositoryRoot), "utf8");
}

interface FakeEventState {
  prevented: number;
  stopped: number;
}

interface FakeListener {
  readonly type: string;
  readonly listener: (event: Event) => void;
}

class FakeElement {
  public id = "";
  public className = "";
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners: FakeListener[] = [];

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.push({ type, listener });
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

function event(currentTarget: unknown, button = 0, isPrimary = true) {
  const state: FakeEventState = { prevented: 0, stopped: 0 };
  return {
    value: {
      button,
      isPrimary,
      currentTarget,
      preventDefault: () => {
        state.prevented += 1;
      },
      stopPropagation: () => {
        state.stopped += 1;
      },
    } as unknown as Event,
    state,
  };
}

function titlebarFixture() {
  const classes = new Set<string>();
  const buttons = {
    "win-min": new FakeElement(),
    "win-max": new FakeElement(),
    "win-close": new FakeElement(),
  };
  return {
    classes,
    buttons,
    document: {
      documentElement: {
        classList: {
          toggle(name: string, enabled?: boolean) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
      },
      getElementById: (id: string) => buttons[id as keyof typeof buttons] ?? null,
    } as unknown as Document,
  };
}

async function exerciseTitlebar(legacy: boolean) {
  const fixture = titlebarFixture();
  const commands: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    commands.push(args ? { command, args } : { command });
    return undefined as TResult;
  };
  const target: Record<string, unknown> = {
    document: fixture.document,
    navigator: { userAgentData: { platform: "macOS" } },
    __TAURI__: { core: { invoke } },
  };
  target.window = target;
  target.globalThis = target;
  if (legacy) vm.runInNewContext(classicSource("titlebar.js"), target);
  else installTitlebar(target, { invoke });

  const eventStates: FakeEventState[] = [];
  for (const id of ["win-min", "win-max", "win-close"] as const) {
    const click = event(fixture.buttons[id]);
    eventStates.push(click.state);
    fixture.buttons[id].listeners[0]?.listener(click.value);
  }
  await Promise.resolve();
  return { classes: [...fixture.classes], commands, eventStates };
}

test("titlebar strict installer is VM-equivalent to the classic script", async () => {
  assert.deepEqual(await exerciseTitlebar(false), await exerciseTitlebar(true));
});

function resizeFixture() {
  const body = new FakeElement();
  return {
    body,
    document: {
      body,
      createElement: () => new FakeElement(),
      getElementById: (id: string) =>
        body.children.find((child) => child.id === id) ?? null,
      addEventListener: () => undefined,
    } as unknown as Document,
  };
}

async function exerciseResize(legacy: boolean) {
  const fixture = resizeFixture();
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    return undefined as TResult;
  };
  const target: Record<string, unknown> = {
    document: fixture.document,
    navigator: { userAgent: "X11; Linux x86_64" },
    __TAURI__: { core: { invoke } },
  };
  target.window = target;
  target.globalThis = target;
  if (legacy) vm.runInNewContext(classicSource("window-resize.js"), target);
  else installWindowResize(target, { invoke });

  const container = fixture.body.children[0];
  const first = container?.children[0];
  const primary = event(first);
  const secondary = event(first, 2);
  first?.listeners[0]?.listener(primary.value);
  first?.listeners[0]?.listener(secondary.value);
  await Promise.resolve();
  return {
    container: container
      ? {
          id: container.id,
          ariaHidden: container.attributes.get("aria-hidden"),
          directions: container.children.map((child) => child.dataset.resizeDirection),
          classes: container.children.map((child) => child.className),
        }
      : null,
    calls,
    primary: primary.state,
    secondary: secondary.state,
  };
}

test("Linux resize strict installer is VM-equivalent to the classic script", async () => {
  assert.equal(
    JSON.stringify(await exerciseResize(false)),
    JSON.stringify(await exerciseResize(true)),
  );
});

function startupFixture() {
  const stored: Record<string, string> = {};
  const messages: string[] = [];
  let now = 100;
  let domReady: (() => void) | null = null;
  const target: Record<string, unknown> = {
    localStorage: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => {
        stored[key] = value;
      },
    },
    performance: { now: () => now },
    console: { info: (message: string) => messages.push(message) },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "DOMContentLoaded") domReady = listener;
    },
  };
  target.window = target;
  target.globalThis = target;
  return {
    target,
    stored,
    messages,
    advance: (amount: number) => {
      now += amount;
    },
    fireDomReady: () => {
      if (domReady) (domReady as () => void)();
    },
  };
}

interface StartupGlobals {
  startupPerfLog(name: string, phase?: string, detail?: unknown): void;
  startupPerfStart(name: string, detail?: unknown): (extra?: unknown) => void;
  startupTimed<TResult>(
    name: string,
    task: () => TResult | PromiseLike<TResult>,
    detail?: unknown,
  ): Promise<TResult>;
}

async function exerciseStartup(legacy: boolean) {
  const fixture = startupFixture();
  const commands: string[] = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string) => {
      commands.push(command);
      return 24 as TResult;
    },
  };
  (fixture.target.__TAURI__ as Record<string, unknown>) = {
    core: { invoke: transport.invoke },
  };
  if (legacy) vm.runInNewContext(classicSource("startup-perf.js"), fixture.target);
  else installStartupPerf(fixture.target, transport, "normalized-session");
  await Promise.resolve();

  const globals = fixture.target as unknown as StartupGlobals;
  fixture.advance(5);
  globals.startupPerfLog("books", "mark", "ready");
  fixture.advance(2);
  const done = globals.startupPerfStart("search");
  fixture.advance(8);
  done("ok");
  assert.equal(await globals.startupTimed("load", async () => 7), 7);
  fixture.fireDomReady();
  await Promise.resolve();

  const logs = JSON.parse(fixture.stored.startupPerfLogV1 ?? "[]") as Array<
    Record<string, unknown>
  >;
  return {
    logs: logs.map((entry) => {
      const normalized = { ...entry };
      delete normalized.session;
      return normalized;
    }),
    messages: fixture.messages,
    commands,
  };
}

test("startup performance strict installer is VM-equivalent to the classic script", async () => {
  assert.deepEqual(await exerciseStartup(false), await exerciseStartup(true));
});
