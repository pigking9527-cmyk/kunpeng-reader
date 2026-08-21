import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installStatsUi, type StatsUiGlobal } from "./stats-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
  public remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
  public contains(name: string): boolean { return this.values.has(name); }
  public toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly attributes: Record<string, string> = {};
  public readonly handlers = new Map<string, EventListener>();
  public readonly style = {
    visibility: "",
    setProperty: () => undefined,
  };
  public clientHeight = 100;
  public scrollHeight = 100;
  public scrollTop = 0;
  public checked = false;
  public disabled = false;
  public textContent = "";
  public innerHTML = "";

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.handlers.set(type, listener);
  }

  public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  public contains(): boolean { return false; }
  public fire(type: string): void {
    this.handlers.get(type)?.({ target: this, stopPropagation: () => undefined } as unknown as Event);
  }
}

function classicSource(): string {
  return readFileSync(new URL("ui/generated-ts/stats-ui.js", repositoryRoot), "utf8");
}

function emptyRange() {
  return {
    total_seconds: 0,
    total_words: 0,
    book_count: 0,
    finished_count: 0,
    total_highlights: 0,
    total_notes: 0,
    books: [],
    days: [],
    hours: new Array<number>(24).fill(0),
    hours_words: new Array<number>(24).fill(0),
  };
}

function fixture() {
  const ids = [
    "stats-modal", "stats-body", "stats-period", "stats-prev", "stats-next",
    "stats-toolbar-btn", "stats-settings", "stats-settings-btn",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const storage = new Map<string, string>();
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
  } as unknown as Document;
  const runtime: Record<string, unknown> = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  };
  runtime.window = runtime;
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return structuredClone(emptyRange()) as TResult;
    },
  };
  const options = {
    root: document,
    transport,
    menuElement: new FakeElement() as unknown as HTMLElement,
    filterPanel: new FakeElement() as unknown as HTMLElement,
    closeAccountPanel: () => undefined,
    closeSearch: () => undefined,
    storage: runtime.localStorage as {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    },
    requestAnimationFrame: runtime.requestAnimationFrame as (callback: FrameRequestCallback) => number,
  };
  return { runtime, options, elements, calls };
}

async function exercise(legacy: boolean) {
  const view = fixture();
  let api: StatsUiGlobal;
  if (legacy) {
    vm.runInNewContext(classicSource(), view.runtime);
    api = view.runtime.ReaderStatsUI as StatsUiGlobal;
    const classicOptions = {
      ...view.options,
      invoke: view.options.transport.invoke.bind(view.options.transport),
    };
    delete (classicOptions as Partial<typeof classicOptions>).transport;
    const controller = api.init(classicOptions);
    await controller.render();
    return snapshot(api, controller, view);
  }
  api = installStatsUi(view.runtime) as StatsUiGlobal;
  const controller = api.init(view.options);
  await controller.render();
  return snapshot(api, controller, view);
}

function snapshot(
  api: StatsUiGlobal,
  controller: ReturnType<StatsUiGlobal["init"]>,
  view: ReturnType<typeof fixture>,
) {
  const body = view.elements.get("stats-body") as FakeElement;
  return {
    apiKeys: Object.keys(api).sort(),
    controllerKeys: Object.keys(controller).sort(),
    frozen: Object.isFrozen(api) && Object.isFrozen(controller),
    calls: view.calls,
    body: body.innerHTML,
    loading: body.dataset.loading ?? null,
  };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("strict stats installer remains behavior-equivalent to the classic VM", async () => {
  assert.deepEqual(plain(await exercise(false)), plain(await exercise(true)));
});

test("typed transport owns both exact reading-statistics command envelopes", async () => {
  const result = await exercise(false);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, "reading_stats_range");
  assert.equal(result.calls[0]?.args?.from, result.calls[0]?.args?.to);
  assert.deepEqual(result.calls[1], {
    command: "reading_stats_range",
    args: { from: 0, to: 99999999 },
  });
});
