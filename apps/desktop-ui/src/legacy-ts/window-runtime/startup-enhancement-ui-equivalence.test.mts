import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  installStartupEnhancementUi,
  type StartupEnhancementGlobalApi,
  type StartupEnhancementState,
} from "./startup-enhancement-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicStartupSource(): string {
  try {
    return readFileSync(new URL("ui/startup-enhancement-ui.js", repositoryRoot), "utf8");
  } catch {
    return execFileSync("git", ["show", "HEAD:ui/startup-enhancement-ui.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
}

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
  public remove(value: string): void {
    this.values.delete(value);
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
  public fire(type: string): void {
    this.listeners.get(type)?.({ target: this } as unknown as Event);
  }
}

function domGlobals<TResult>(operation: () => TResult): TResult {
  const priorInput = globalThis.HTMLInputElement;
  const priorElement = globalThis.HTMLElement;
  Object.defineProperties(globalThis, {
    HTMLInputElement: { configurable: true, value: FakeElement },
    HTMLElement: { configurable: true, value: FakeElement },
  });
  try {
    return operation();
  } finally {
    Object.defineProperties(globalThis, {
      HTMLInputElement: { configurable: true, value: priorInput },
      HTMLElement: { configurable: true, value: priorElement },
    });
  }
}

async function exercise(legacy: boolean) {
  const ids = [
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
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  let handler:
    | ((event: TauriEvent<StartupEnhancementState>) => void)
    | undefined;
  const loaded = {
    enabled: true,
    continueHighCost: false,
    launchAtLogin: true,
    launchAtLoginAvailable: true,
    launchAtLoginBackground: false,
    launchAtLoginBackgroundAvailable: true,
  };
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    return loaded as TResult;
  };
  const listen = async <TPayload,>(
    event: string,
    listener: (event: TauriEvent<TPayload>) => void,
  ) => {
    assert.equal(event, "startup-enhancement-state");
    handler = listener as (event: TauriEvent<StartupEnhancementState>) => void;
    return () => undefined;
  };
  const target: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    __TAURI__: { core: { invoke }, event: { listen } },
  };
  target.window = target;
  target.globalThis = target;

  if (legacy) {
    vm.runInNewContext(
      classicStartupSource(),
      target,
    );
  } else {
    const transport: TauriTransport = { invoke, listen };
    domGlobals(() => installStartupEnhancementUi(target, transport));
  }
  await Promise.resolve();
  await Promise.resolve();
  const api = target.ReaderStartupEnhancement as StartupEnhancementGlobalApi;
  handler?.({
    event: "startup-enhancement-state",
    id: 1,
    payload: {
      backgrounded: true,
      continueHighCost: true,
      highCostResumeAtMs: 0,
    },
  });
  const master = elements["set-startup-enhancement"];
  if (master) {
    master.checked = false;
    master.fire("change");
  }
  elements["startup-enhancement-gear"]?.fire("click");
  const shown = elements["startup-enhancement-modal"]?.classList.values.has("show");
  elements["startup-enhancement-close"]?.fire("click");
  await Promise.resolve();
  return {
    calls,
    snapshot: api.snapshot(),
    allowed: api.backgroundWorkAllowed(),
    retryDelay: api.highCostRetryDelay(),
    shown,
    closed: !elements["startup-enhancement-modal"]?.classList.values.has("show"),
    controlState: Object.fromEntries(
      Object.entries(elements).map(([id, node]) => [
        id,
        { checked: node.checked, disabled: node.disabled, hidden: node.hidden },
      ]),
    ),
    apiKeys: Object.keys(api).sort(),
  };
}

test("startup enhancement strict installer is behavior-equivalent to classic VM", async () => {
  assert.equal(JSON.stringify(await exercise(false)), JSON.stringify(await exercise(true)));
});
