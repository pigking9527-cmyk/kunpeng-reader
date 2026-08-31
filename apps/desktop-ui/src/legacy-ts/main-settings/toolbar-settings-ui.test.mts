import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  installToolbarSettingsUi,
  normalizeToolbarSettings,
  type ToolbarSettingsGlobalApi,
} from "./toolbar-settings-ui.ts";

class FakeClassList {
  public readonly values = new Set<string>();

  public add(...values: string[]): void {
    values.forEach((value) => this.values.add(value));
  }

  public remove(...values: string[]): void {
    values.forEach((value) => this.values.delete(value));
  }

  public toggle(value: string, enabled?: boolean): boolean {
    const next = enabled ?? !this.values.has(value);
    if (next) this.values.add(value);
    else this.values.delete(value);
    return next;
  }
}

class FakeStyle {
  public readonly values = new Map<string, string>();
  public position = "";
  public left = "";
  public top = "";
  public width = "";
  public height = "";
  public transition = "";
  public transform = "";

  public setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  public removeProperty(name: string): void {
    this.values.delete(name);
  }
}

type FakeListener = (event: Event) => void;

class FakeElement {
  public className = "";
  public textContent = "";
  public value = "";
  public checked = false;
  public disabled = false;
  public readonly dataset: Record<string, string> = {};
  public readonly classList = new FakeClassList();
  public readonly style = new FakeStyle();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, FakeListener[]>();
  public parent: FakeElement | null = null;
  public offsetHeight = 40;
  public offsetWidth = 80;
  private html = "";
  private readonly attributes = new Map<string, string>();

  public get childNodes(): FakeElement[] {
    return this.children;
  }

  public get nextSibling(): FakeElement | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
  }

  public get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }

  public set innerHTML(value: string) {
    this.html = value;
    this.replaceChildren();
    const handle = new FakeElement();
    handle.className = value.includes("toolbar-content-drag")
      ? "toolbar-content-drag"
      : "toolbar-settings-drag";
    const checkbox = new FakeElement();
    checkbox.checked = value.includes(" checked");
    checkbox.disabled = value.includes(" disabled");
    this.append(handle, checkbox);
  }

  public get innerHTML(): string {
    return this.html;
  }

  public append(...nodes: FakeElement[]): void {
    nodes.forEach((node) => this.appendChild(node));
  }

  public appendChild(node: FakeElement): FakeElement {
    node.parent?.removeChild(node);
    node.parent = this;
    this.children.push(node);
    return node;
  }

  public removeChild(node: FakeElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parent = null;
  }

  public remove(): void {
    this.parent?.removeChild(this);
  }

  public insertBefore(node: FakeElement, before: FakeElement | null): FakeElement {
    node.parent?.removeChild(node);
    const index = before ? this.children.indexOf(before) : -1;
    node.parent = this;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }

  public replaceChildren(...nodes: FakeElement[]): void {
    this.children.forEach((node) => {
      node.parent = null;
    });
    this.children.splice(0, this.children.length);
    this.append(...nodes);
  }

  public querySelector(selector: string): FakeElement | null {
    if (selector === "input") return this.children[1] ?? null;
    if (selector === ".toolbar-content-drag") return this.children[0] ?? null;
    if (selector === ".toolbar-settings-drag") return this.children[0] ?? null;
    const className = selector.match(/:scope > \.([\w-]+)/u)?.[1];
    if (className) {
      return (
        this.children.find(
          (child) =>
            child.className.split(/\s+/u).includes(className) ||
            child.classList.values.has(className),
        ) ?? null
      );
    }
    return null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes("data-toolbar-item")) {
      return this.children.filter((child) => Boolean(child.dataset.toolbarItem));
    }
    if (selector.includes("data-toolbar-content")) {
      return this.children.filter((child) => Boolean(child.dataset.toolbarContent));
    }
    return [];
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as FakeListener);
    this.listeners.set(type, listeners);
  }

  public fire(type: string, patch: Record<string, unknown> = {}): void {
    const event = {
      target: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...patch,
    } as unknown as Event;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  public getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: this.offsetWidth,
      bottom: this.offsetHeight,
      width: this.offsetWidth,
      height: this.offsetHeight,
      toJSON: () => ({}),
    };
  }

  public animate(): Animation {
    return {} as Animation;
  }

  public setPointerCapture(): void {}
  public hasPointerCapture(): boolean {
    return false;
  }
  public releasePointerCapture(): void {}
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("frozen compatibility API normalizes legacy toolbar settings", () => {
  const document = {
    getElementById: () => null,
    querySelector: () => null,
  };
  const modern = installToolbarSettingsUi({
    document,
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
  }) as ToolbarSettingsGlobalApi;
  const samples: unknown[] = [
    null,
    {},
    {
      toolbarIconSizePx: 500,
      toolbarItemOrder: ["menu", "menu", "unknown"],
      toolbarHiddenItems: ["settings", "news", "news"],
      toolbarContentOrder: ["text", "text", "future"],
      toolbarContentVisible: [],
    },
    {
      toolbarIconSizePx: 28,
      toolbarItemOrder: ["search", "account"],
      toolbarHiddenItems: ["account"],
      toolbarContentOrder: ["text", "icon"],
      toolbarContentVisible: ["text"],
    },
  ];
  const normalized = samples.map((sample) => plain(modern.normalize(sample)));
  assert.deepEqual(normalized, samples.map((sample) => plain(normalizeToolbarSettings(sample))));
  assert.deepEqual(
    normalizeToolbarSettings({
      toolbarItemOrder: ["account", "search", "stats", "library", "news", "filter", "settings", "menu"],
    }).toolbarItemOrder,
    ["account", "search", "stats", "library", "news", "intelligence-lab", "filter", "settings", "menu"],
  );
  assert.deepEqual(Object.keys(modern).sort(), ["apply", "get", "init", "normalize"]);
  assert.equal(Object.isFrozen(modern), true);
});

function fixture() {
  const ids = [
    "toolbar-actions",
    "toolbar-leading-action",
    "toolbar-settings-list",
    "toolbar-content-list",
    "toolbar-icon-size",
    "toolbar-icon-size-value",
    "toolbar-reset-layout",
    "toolbar-settings-status",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const buttons: Record<string, FakeElement> = {};
  const buttonIds = [
    "account-btn",
    "search-btn",
    "stats-toolbar-btn",
    "library-ai-toolbar-btn",
    "newsnow-toolbar-btn",
    "intelligence-lab-toolbar-btn",
    "filter-btn",
    "settings-toolbar-btn",
    "menu-btn",
  ];
  const toolbarIds = [
    "account",
    "search",
    "stats",
    "library",
    "news",
    "intelligence-lab",
    "filter",
    "settings",
    "menu",
  ];
  toolbarIds.forEach((id, index) => {
    const item = new FakeElement();
    item.dataset.toolbarItem = id;
    (index === 0
      ? elements["toolbar-leading-action"]
      : elements["toolbar-actions"]
    )?.append(item);
    const button = new FakeElement();
    button.setAttribute("title", id);
    button.append(new FakeElement());
    buttons[buttonIds[index] ?? ""] = button;
  });
  const storageValues = new Map<string, string>();
  const windowListeners = new Map<string, EventListenerOrEventListenerObject>();
  const timers = new Map<number, TimerHandler>();
  let timerId = 0;
  const runtime = {
    document: {
      getElementById: (id: string) => elements[id] ?? buttons[id] ?? null,
      querySelector: (selector: string) =>
        selector.includes('data-toolbar-item="account"')
          ? elements["toolbar-leading-action"]?.children[0] ?? null
          : null,
      createElement: () => new FakeElement(),
    } as unknown as Document,
    localStorage: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
    },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: () => 0,
    setTimeout: (handler: TimerHandler) => {
      timerId += 1;
      timers.set(timerId, handler);
      return timerId;
    },
    clearTimeout: (id?: number) => {
      if (id) timers.delete(id);
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      windowListeners.set(type, listener),
  };
  return {
    elements,
    runtime,
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((handler) => {
        if (typeof handler === "function") handler();
      });
    },
  };
}

test("fake typed transport preserves hydrate, save, and sync-event behavior", async () => {
  const view = fixture();
  const calls: Array<{
    readonly command: string;
    readonly args?: Record<string, unknown>;
  }> = [];
  let synced:
    | ((event: TauriEvent<unknown>) => void)
    | undefined;
  let remoteSize = 40;
  const transport: TauriTransport = {
    invoke: async <TResult,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(args ? { command, args } : { command });
      return {
        hasToolbarSettings: true,
        ...normalizeToolbarSettings({ toolbarIconSizePx: remoteSize }),
      } as TResult;
    },
    listen: async <TPayload,>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ) => {
      assert.equal(event, "app-settings-synced");
      synced = handler as (event: TauriEvent<unknown>) => void;
      return () => undefined;
    },
  };
  const api = installToolbarSettingsUi(view.runtime, transport);
  assert.ok(api);
  api.init({ transport });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[0], { command: "app_settings_sync_get" });
  assert.equal(api.get().toolbarIconSizePx, 40);
  assert.equal(
    view.elements["toolbar-actions"]?.style.values.get("--toolbar-item-size"),
    "40px",
  );

  const size = view.elements["toolbar-icon-size"];
  if (size) {
    size.value = "48";
    size.fire("input");
  }
  view.runTimers();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls[1]?.command, "app_settings_sync_save");
  assert.equal(
    (calls[1]?.args?.request as { toolbarIconSizePx?: unknown })
      .toolbarIconSizePx,
    48,
  );
  assert.equal(
    view.elements["toolbar-settings-status"]?.textContent,
    "已保存；下次同步会带到其他设备",
  );

  remoteSize = 32;
  synced?.({ event: "app-settings-synced", id: 1, payload: null });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls[2]?.command, "app_settings_sync_get");
  assert.equal(api.get().toolbarIconSizePx, 32);
});

test("classic invoke option still feeds the typed command boundary", async () => {
  const view = fixture();
  const calls: string[] = [];
  const api = installToolbarSettingsUi(view.runtime);
  assert.ok(api);
  api.init({
    invoke: async <TResult,>(command: string) => {
      calls.push(command);
      return { hasToolbarSettings: false } as TResult;
    },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["app_settings_sync_get"]);
});
