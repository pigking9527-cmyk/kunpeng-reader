import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  initializeStartupEnhancementUi,
  normalizeStartupEnhancementConfig,
  type StartupEnhancementState,
} from "./startup-enhancement-ui.ts";

class FakeClassList {
  private readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
  public remove(value: string): void {
    this.values.delete(value);
  }
  public contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  public checked = false;
  public disabled = false;
  public hidden = false;
  public readonly classList = new FakeClassList();
  public readonly listeners = new Map<string, (event: Event) => void>();
  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener);
  }
  public fire(type: string, target: EventTarget = this as unknown as EventTarget): void {
    this.listeners.get(type)?.({ target } as Event);
  }
}

function fixture() {
  const elements = Object.fromEntries(
    [
      "set-startup-enhancement",
      "startup-enhancement-gear",
      "startup-enhancement-modal",
      "startup-enhancement-close",
      "startup-enhancement-autostart-row",
      "startup-enhancement-autostart",
      "startup-enhancement-autostart-background-row",
      "startup-enhancement-autostart-background",
      "startup-enhancement-process",
      "startup-enhancement-high-cost",
    ].map((id) => [id, new FakeElement()]),
  );
  return {
    elements,
    runtime: {
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      } as unknown as Document,
    },
  };
}

function withDomConstructors<TResult>(operation: () => TResult): TResult {
  const previousInput = globalThis.HTMLInputElement;
  const previousElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement,
  });
  try {
    return operation();
  } finally {
    Object.defineProperty(globalThis, "HTMLInputElement", {
      configurable: true,
      value: previousInput,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousElement,
    });
  }
}

test("normalization keeps classic truthiness and all availability fields", () => {
  assert.deepEqual(
    normalizeStartupEnhancementConfig({
      enabled: 1,
      continueHighCost: "yes",
      launchAtLogin: 0,
      launchAtLoginAvailable: true,
      launchAtLoginBackground: null,
      launchAtLoginBackgroundAvailable: {},
    }),
    {
      enabled: true,
      continueHighCost: true,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      launchAtLoginBackground: false,
      launchAtLoginBackgroundAvailable: true,
    },
  );
});

test("typed fake transport preserves load, render, save and native event behavior", async () => {
  const view = fixture();
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  let eventHandler:
    | ((event: TauriEvent<StartupEnhancementState>) => void)
    | undefined;
  const loaded = {
    enabled: true,
    continueHighCost: false,
    launchAtLogin: true,
    launchAtLoginAvailable: true,
    launchAtLoginBackground: true,
    launchAtLoginBackgroundAvailable: true,
  };
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return loaded as TResult;
    },
    listen: async <TPayload,>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ) => {
      assert.equal(event, "startup-enhancement-state");
      eventHandler = handler as (event: TauriEvent<StartupEnhancementState>) => void;
      return () => undefined;
    },
  };
  let now = 1_000;
  const api = withDomConstructors(() =>
    initializeStartupEnhancementUi(view.runtime, transport, () => now),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[0], { command: "startup_enhancement_config" });
  assert.equal(view.elements["set-startup-enhancement"]?.checked, true);
  assert.equal(view.elements["startup-enhancement-autostart-row"]?.hidden, false);
  assert.equal(
    view.elements["startup-enhancement-autostart-background"]?.disabled,
    false,
  );
  assert.deepEqual(api.snapshot(), {
    enabled: true,
    continueHighCost: false,
    launchAtLogin: true,
    launchAtLoginBackground: true,
  });

  eventHandler?.({
    event: "startup-enhancement-state",
    id: 1,
    payload: {
      backgrounded: true,
      continueHighCost: false,
      highCostResumeAtMs: 1_500,
    },
  });
  assert.equal(api.backgroundWorkAllowed(), false);
  assert.equal(api.highCostRetryDelay(), 0);
  now = 2_000;
  assert.equal(api.backgroundWorkAllowed(), false);

  const master = view.elements["set-startup-enhancement"];
  if (master) {
    master.checked = false;
    master.fire("change");
  }
  await Promise.resolve();
  assert.equal(calls[1]?.command, "set_startup_enhancement_config");
  assert.deepEqual(calls[1]?.args?.request, {
    enabled: false,
    continueHighCost: false,
    launchAtLogin: true,
    launchAtLoginAvailable: true,
    launchAtLoginBackground: true,
    launchAtLoginBackgroundAvailable: true,
  });
});
