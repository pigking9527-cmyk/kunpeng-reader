import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriTransport,
  WindowResizeDirection,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  installWindowResize,
  WINDOW_RESIZE_DIRECTIONS,
} from "./window-resize.ts";

class FakeElement {
  public id = "";
  public className = "";
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, (event: PointerEvent) => void>();

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") {
      this.listeners.set(type, listener as (event: PointerEvent) => void);
    }
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

function resizeRuntime(userAgent = "X11; Linux x86_64") {
  const body = new FakeElement();
  const document = {
    body,
    createElement: () => new FakeElement(),
    getElementById: (id: string) =>
      body.children.find((child) => child.id === id) ?? null,
    addEventListener: () => undefined,
  } as unknown as Document;
  return { runtime: { navigator: { userAgent }, document }, body };
}

test("Linux resize installer preserves the eight Rust directions and primary-pointer gate", async () => {
  assert.deepEqual(WINDOW_RESIZE_DIRECTIONS, [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
  ]);
  const fixture = resizeRuntime();
  const calls: WindowResizeDirection[] = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      assert.equal(command, "main_window_start_resize_dragging");
      calls.push(args?.direction as WindowResizeDirection);
      return undefined as TResult;
    },
  };
  installWindowResize(fixture.runtime, transport);
  const container = fixture.body.children[0];
  assert.equal(container?.id, "window-resize-handles");
  assert.equal(container?.attributes.get("aria-hidden"), "true");
  assert.deepEqual(
    container?.children.map((child) => child.dataset.resizeDirection),
    WINDOW_RESIZE_DIRECTIONS,
  );

  const first = container?.children[0];
  let prevented = 0;
  let stopped = 0;
  first?.listeners.get("pointerdown")?.({
    button: 0,
    isPrimary: true,
    currentTarget: first,
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  } as unknown as PointerEvent);
  first?.listeners.get("pointerdown")?.({
    button: 2,
    isPrimary: true,
    currentTarget: first,
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  } as unknown as PointerEvent);
  await Promise.resolve();
  assert.deepEqual(calls, ["north"]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("resize installer remains Linux-only and idempotent", () => {
  const mac = resizeRuntime("Macintosh");
  installWindowResize(mac.runtime, { invoke: async <TResult,>() => undefined as TResult });
  assert.equal(mac.body.children.length, 0);

  const linux = resizeRuntime();
  const transport: TauriTransport = { invoke: async <TResult,>() => undefined as TResult };
  installWindowResize(linux.runtime, transport);
  installWindowResize(linux.runtime, transport);
  assert.equal(linux.body.children.length, 1);
});
