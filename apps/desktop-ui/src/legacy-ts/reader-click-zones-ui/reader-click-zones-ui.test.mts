import assert from "node:assert/strict";
import test from "node:test";

import {
  installReaderClickZones,
  normalizeReaderClickZones,
  type ReaderClickZonesApi,
} from "./reader-click-zones-ui.ts";

interface Listener {
  readonly type: string;
  readonly callback: (event: TestEvent) => void;
}

class TestEvent {
  readonly key: string;
  prevented = false;
  stopped = false;

  constructor(key = "") { this.key = key; }
  preventDefault(): void { this.prevented = true; }
  stopPropagation(): void { this.stopped = true; }
}

class ClassListMock {
  private readonly owner: ElementMock;

  constructor(owner: ElementMock) {
    this.owner = owner;
  }
  add(name: string): void {
    const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    names.add(name);
    this.owner.className = [...names].join(" ");
  }
  remove(name: string): void {
    this.owner.className = this.owner.className.split(/\s+/).filter((item) => item && item !== name).join(" ");
  }
  toggle(name: string, force?: boolean): boolean {
    const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    const next = force ?? !names.has(name);
    if (next) names.add(name); else names.delete(name);
    this.owner.className = [...names].join(" ");
    return next;
  }
}

class ElementMock {
  readonly id: string;
  readonly tagName: string;
  readonly children: ElementMock[] = [];
  readonly listeners: Listener[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList = new ClassListMock(this);
  className = "";
  textContent = "";
  value = "";
  type = "";
  disabled = false;
  tabIndex = -1;

  constructor(tagName = "div", id = "") {
    this.tagName = tagName;
    this.id = id;
  }

  append(...children: ElementMock[]): void { this.children.push(...children); }
  appendChild(child: ElementMock): ElementMock { this.append(child); return child; }
  replaceChildren(...children: ElementMock[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
  addEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
    const listener = typeof callback === "function"
      ? callback as unknown as (event: TestEvent) => void
      : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
    this.listeners.push({ type, callback: listener });
  }
  dispatch(type: string, event = new TestEvent()): TestEvent {
    this.listeners.filter((listener) => listener.type === type).forEach(({ callback }) => callback(event));
    return event;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  querySelectorAll(selector: string): ElementMock[] {
    if (selector !== "[data-zone-id]") return [];
    return this.children.filter((child) => Boolean(child.dataset.zoneId));
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 1000, height: 1000 } as DOMRect;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

interface Harness {
  readonly runtime: Record<string, unknown>;
  readonly elements: Map<string, ElementMock>;
  readonly updates: unknown[];
  readonly storage: Map<string, string>;
  readonly windowListeners: Listener[];
}

function createHarness(clickZones: unknown = undefined): Harness {
  const ids = [
    "reader-click-zone-preview", "reader-click-zone-canvas", "reader-click-zone-reset",
    "reader-click-zone-preset", "reader-click-zone-preset-name", "reader-click-zone-preset-new",
    "reader-click-zone-preset-save", "reader-click-zone-preset-delete",
  ];
  const elements = new Map(ids.map((id) => [id, new ElementMock("div", id)]));
  const storage = new Map<string, string>();
  const updates: unknown[] = [];
  const windowListeners: Listener[] = [];
  const runtime: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tagName: string) => new ElementMock(tagName),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    ReaderSettings: {
      get: () => ({ clickZones }),
      update: (value: unknown) => updates.push(value),
    },
    ReaderI18n: {
      t: (key: string, values?: Readonly<Record<string, unknown>>) =>
        key === "clickZoneNumber" ? `区域 ${String(values?.number)}` : "",
    },
    addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
      const listener = typeof callback === "function"
        ? callback as unknown as (event: TestEvent) => void
        : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
      windowListeners.push({ type, callback: listener });
    },
    setTimeout: (callback: () => void) => { callback(); return 1; },
  };
  return { runtime, elements, updates, storage, windowListeners };
}

function install(harness: Harness): ReaderClickZonesApi {
  const api = installReaderClickZones(harness.runtime as never);
  assert.ok(api);
  return api;
}

function domSnapshot(harness: Harness): unknown {
  const canvas = harness.elements.get("reader-click-zone-canvas");
  const preset = harness.elements.get("reader-click-zone-preset");
  return {
    previewTabIndex: harness.elements.get("reader-click-zone-preview")?.tabIndex,
    zones: canvas?.children.map((zone) => ({
      className: zone.className,
      zoneId: zone.dataset.zoneId,
      style: { ...zone.style },
      ariaLabel: zone.attributes.get("aria-label"),
      handles: zone.children.slice(1).map((handle) => ({
        className: handle.className,
        zoneHandle: handle.dataset.zoneHandle,
      })),
    })),
    presets: preset?.children.map((option) => ({ value: option.value, text: option.textContent })),
    presetValue: preset?.value,
    listeners: harness.windowListeners.map(({ type }) => type),
  };
}

test("normalization preserves legacy defaults, bounds, ids, actions, and overlap trimming", () => {
  assert.deepEqual(normalizeReaderClickZones(undefined), [
    { id: "zone-1", action: "prev", x: 0, y: 0, width: 400, height: 1000 },
    { id: "zone-2", action: "center", x: 400, y: 0, width: 200, height: 1000 },
    { id: "zone-3", action: "next", x: 600, y: 0, width: 400, height: 1000 },
  ]);
  assert.deepEqual(normalizeReaderClickZones([
    { id: "same", action: "prev", x: -4, y: 2, width: 700, height: 500 },
    { id: "same", action: "invalid", x: 600, y: 2, width: 700, height: 500 },
  ]), [
    { id: "same", action: "prev", x: 0, y: 2, width: 700, height: 500 },
    { id: "zone-3", action: "center", x: 700, y: 2, width: 300, height: 500 },
  ]);
});

test("custom zones retain the frozen geometry, labels, preset, and event contract", () => {
  const input = [
    { id: "left", action: "prev", x: 12, y: 23, width: 310, height: 700 },
    { id: "right", action: "next", x: 500, y: 0, width: 500, height: 1000 },
  ];
  const harness = createHarness(input);
  const api = install(harness);
  assert.deepEqual(api.normalize(input), input);
  assert.deepEqual(domSnapshot(harness), {
    previewTabIndex: 0,
    zones: [
      {
        className: "reader-click-zone action-prev active",
        zoneId: "left",
        style: { left: "1.2%", top: "2.3%", width: "31%", height: "70%" },
        ariaLabel: "区域 1：上一页",
        handles: [
          { className: "reader-click-zone-handle handle-nw", zoneHandle: "nw" },
          { className: "reader-click-zone-handle handle-ne", zoneHandle: "ne" },
          { className: "reader-click-zone-handle handle-sw", zoneHandle: "sw" },
          { className: "reader-click-zone-handle handle-se", zoneHandle: "se" },
        ],
      },
      {
        className: "reader-click-zone action-next",
        zoneId: "right",
        style: { left: "50%", top: "0%", width: "50%", height: "100%" },
        ariaLabel: "区域 2：下一页",
        handles: [
          { className: "reader-click-zone-handle handle-nw", zoneHandle: "nw" },
          { className: "reader-click-zone-handle handle-ne", zoneHandle: "ne" },
          { className: "reader-click-zone-handle handle-sw", zoneHandle: "sw" },
          { className: "reader-click-zone-handle handle-se", zoneHandle: "se" },
        ],
      },
    ],
    presets: [{ value: "preset-1", text: "默认方案" }],
    presetValue: "preset-1",
    listeners: ["reader-settings-changed", "reader-language-changed"],
  });
});

test("installer keeps the frozen ReaderClickZones global and original DOM structure", () => {
  const harness = createHarness();
  const api = install(harness);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(harness.runtime.ReaderClickZones, api);
  assert.deepEqual(api.defaults(), api.normalize(undefined));
  assert.notEqual(api.defaults(), api.defaults());

  const preview = harness.elements.get("reader-click-zone-preview");
  const canvas = harness.elements.get("reader-click-zone-canvas");
  assert.equal(preview?.tabIndex, 0);
  assert.deepEqual(preview?.listeners.map(({ type }) => type), [
    "pointerdown", "pointermove", "pointerup", "pointercancel",
  ]);
  assert.equal(canvas?.children.length, 3);
  assert.deepEqual(canvas?.children.map((zone) => ({
    className: zone.className,
    zoneId: zone.dataset.zoneId,
    handles: zone.children.slice(1).map((handle) => handle.dataset.zoneHandle),
  })), [
    { className: "reader-click-zone action-prev active", zoneId: "zone-1", handles: ["nw", "ne", "sw", "se"] },
    { className: "reader-click-zone action-center", zoneId: "zone-2", handles: ["nw", "ne", "sw", "se"] },
    { className: "reader-click-zone action-next", zoneId: "zone-3", handles: ["nw", "ne", "sw", "se"] },
  ]);
  assert.deepEqual(harness.windowListeners.map(({ type }) => type), [
    "reader-settings-changed", "reader-language-changed",
  ]);
});

test("reset retains the classic settings and preset storage contract", () => {
  const harness = createHarness([
    { id: "custom", action: "none", x: 10, y: 20, width: 100, height: 200 },
  ]);
  install(harness);
  harness.elements.get("reader-click-zone-reset")?.dispatch("click");
  assert.deepEqual(harness.updates.at(-1), { clickZones: [
    { id: "zone-1", action: "prev", x: 0, y: 0, width: 400, height: 1000 },
    { id: "zone-2", action: "center", x: 400, y: 0, width: 200, height: 1000 },
    { id: "zone-3", action: "next", x: 600, y: 0, width: 400, height: 1000 },
  ] });
  assert.equal(harness.storage.get("readerClickZoneActivePresetV1"), "preset-1");
  const presets = JSON.parse(harness.storage.get("readerClickZonePresetsV1") ?? "[]") as unknown[];
  assert.equal(presets.length, 1);
});

test("preset creation, naming, selection, and deletion keep the original event behavior", () => {
  const harness = createHarness();
  install(harness);
  const select = harness.elements.get("reader-click-zone-preset");
  const name = harness.elements.get("reader-click-zone-preset-name");
  harness.elements.get("reader-click-zone-preset-new")?.dispatch("click");
  assert.equal(select?.children.length, 2);
  assert.equal(select?.value, "preset-2");
  if (name) name.value = "  我的方案  ";
  harness.elements.get("reader-click-zone-preset-save")?.dispatch("click");
  assert.equal(select?.children[1]?.textContent, "我的方案");

  if (select) select.value = "preset-1";
  select?.dispatch("change");
  assert.equal(harness.updates.length, 1);
  harness.elements.get("reader-click-zone-preset-delete")?.dispatch("click");
  assert.equal(select?.children.length, 1);
  assert.equal(select?.value, "preset-2");
  assert.equal(harness.updates.length, 2);
});

test("installer remains inert when any required legacy dependency is absent", () => {
  const harness = createHarness();
  harness.elements.delete("reader-click-zone-canvas");
  assert.equal(installReaderClickZones(harness.runtime as never), null);
  assert.equal(harness.runtime.ReaderClickZones, undefined);
  assert.equal(harness.windowListeners.length, 0);
});
