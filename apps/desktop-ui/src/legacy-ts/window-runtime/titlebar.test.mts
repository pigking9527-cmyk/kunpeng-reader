import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriTransport,
  WindowControls,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  initializeTitlebar,
  installTitlebar,
  platformDescription,
} from "./titlebar.ts";

interface RecordedListener {
  readonly type: string;
  readonly listener: (event: Event) => void;
}

function button() {
  const listeners: RecordedListener[] = [];
  return {
    listeners,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (typeof listener === "function") listeners.push({ type, listener });
    },
  };
}

function titlebarDocument() {
  const classes = new Set<string>();
  const buttons = {
    "win-min": button(),
    "win-max": button(),
    "win-close": button(),
  };
  return {
    document: {
      documentElement: {
        classList: {
          toggle(name: string, enabled?: boolean) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
      },
      getElementById(id: string) {
        return buttons[id as keyof typeof buttons] ?? null;
      },
    } as unknown as Document,
    classes,
    buttons,
  };
}

function controls(calls: string[]): WindowControls {
  return {
    minimize: async () => {
      calls.push("minimize");
    },
    toggleMaximize: async () => {
      calls.push("maximize");
    },
    close: async () => {
      calls.push("close");
    },
    show: async () => undefined,
    startDragging: async () => undefined,
    startResizeDragging: async () => undefined,
    isReaderWindowOpen: async () => false,
    elapsedSinceProcessStartMs: async () => 0,
  };
}

function clickEvent() {
  const state = { prevented: 0, stopped: 0 };
  return {
    event: {
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

test("platform resolution keeps legacy userAgentData, platform and userAgent priority", () => {
  assert.equal(
    platformDescription({
      userAgentData: { platform: "macOS" },
      platform: "Linux",
      userAgent: "Windows",
    }),
    "macOS",
  );
  assert.equal(platformDescription({ platform: "MacIntel" }), "MacIntel");
  assert.equal(platformDescription({ userAgent: "Linux" }), "Linux");
  assert.equal(platformDescription(undefined), "");
});

test("titlebar binds only the existing three controls with legacy event semantics", async () => {
  const fixture = titlebarDocument();
  const calls: string[] = [];
  initializeTitlebar(fixture.document, { platform: "MacIntel" }, controls(calls));
  assert.deepEqual([...fixture.classes], ["platform-macos"]);

  const minEvent = clickEvent();
  fixture.buttons["win-min"].listeners[0]?.listener(minEvent.event);
  const maxEvent = clickEvent();
  fixture.buttons["win-max"].listeners[0]?.listener(maxEvent.event);
  const closeEvent = clickEvent();
  fixture.buttons["win-close"].listeners[0]?.listener(closeEvent.event);
  await Promise.resolve();

  assert.deepEqual(calls, ["minimize", "maximize", "close"]);
  assert.deepEqual(minEvent.state, { prevented: 0, stopped: 1 });
  assert.deepEqual(maxEvent.state, { prevented: 0, stopped: 1 });
  assert.deepEqual(closeEvent.state, { prevented: 1, stopped: 1 });
});

test("classic titlebar installer uses the typed injected transport and fails closed without it", async () => {
  const fixture = titlebarDocument();
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return undefined as TResult;
    },
  };
  const runtime = {
    document: fixture.document,
    navigator: { platform: "Linux" },
  };
  installTitlebar(runtime, transport);
  const event = clickEvent();
  fixture.buttons["win-max"].listeners[0]?.listener(event.event);
  await Promise.resolve();
  assert.deepEqual(calls, [{ command: "main_window_toggle_maximize" }]);

  const noTauri = titlebarDocument();
  installTitlebar({ document: noTauri.document, navigator: { platform: "MacIntel" } });
  assert.equal(noTauri.buttons["win-min"].listeners.length, 0);
  assert.equal(noTauri.classes.has("platform-macos"), true);
});

test("titlebar records only redacted control delivery and command outcome", async () => {
  const fixture = titlebarDocument();
  const trace: Array<[string, string, string]> = [];
  const runtime = {
    document: fixture.document,
    navigator: { platform: "Win32" },
    ReaderProblemTraceUI: {
      recordWindowControl: (control: string, phase: string, outcome: string) => {
        trace.push([control, phase, outcome]);
      },
    },
  };
  installTitlebar(runtime, {
    invoke: async <TResult,>() => undefined as TResult,
  });
  fixture.buttons["win-close"].listeners[0]?.listener(clickEvent().event);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, [
    ["close", "click", "requested"],
    ["close", "command", "ok"],
  ]);
});

test("titlebar classifies a rejected native command without retaining its error text", async () => {
  const fixture = titlebarDocument();
  const trace: Array<[string, string, string]> = [];
  installTitlebar(
    {
      document: fixture.document,
      ReaderProblemTraceUI: {
        recordWindowControl: (control: string, phase: string, outcome: string) => {
          trace.push([control, phase, outcome]);
        },
      },
    },
    {
      invoke: async <TResult,>() => {
        throw new Error("invalid args: missing required key window");
        return undefined as TResult;
      },
    },
  );
  fixture.buttons["win-min"].listeners[0]?.listener(clickEvent().event);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, [
    ["minimize", "click", "requested"],
    ["minimize", "command", "failed_arguments"],
  ]);
});
