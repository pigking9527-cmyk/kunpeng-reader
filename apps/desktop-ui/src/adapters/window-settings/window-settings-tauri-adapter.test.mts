import assert from "node:assert/strict";
import test from "node:test";
import type {
  TauriEvent,
  TauriTransport,
  TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.ts";
import {
  createWindowSettingsTauriPort,
  WindowSettingsTauriError,
} from "./window-settings-tauri-adapter.ts";

const nativeStatus = {
  enabled: true,
  continueHighCost: false,
  launchAtLogin: true,
  launchAtLoginAvailable: true,
  launchAtLoginBackground: false,
  launchAtLoginBackgroundAvailable: true,
};

interface InvokeCall {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
}

function createTransport(
  invokeImpl: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): TauriTransport {
  return {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>): Promise<TResult> =>
      invokeImpl(command, args) as Promise<TResult>,
  };
}

test("maps audited window-settings commands to their exact Tauri names and arguments", async () => {
  const calls: InvokeCall[] = [];
  const port = createWindowSettingsTauriPort(createTransport(async (command, args) => {
    calls.push({ command, args });
    return nativeStatus;
  }));
  const signal = new AbortController().signal;

  assert.deepEqual(await port.loadStartupSettings(signal), nativeStatus);
  assert.deepEqual(await port.saveStartupSettings({
    enabled: false,
    continueHighCost: true,
    launchAtLogin: true,
    launchAtLoginBackground: true,
  }, signal), { ...nativeStatus });
  await port.closeMainWindow(signal);
  await port.requestApplicationExit(signal);

  assert.deepEqual(calls, [
    { command: "startup_enhancement_config", args: undefined },
    {
      command: "set_startup_enhancement_config",
      args: {
        request: {
          enabled: false,
          continueHighCost: true,
          launchAtLogin: true,
          launchAtLoginBackground: true,
        },
      },
    },
    { command: "main_window_close", args: undefined },
    { command: "main_window_exit", args: undefined },
  ]);
});

test("does not invoke a native command after cancellation and preserves abort semantics", async () => {
  let calls = 0;
  const port = createWindowSettingsTauriPort(createTransport(async () => {
    calls += 1;
    return nativeStatus;
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(port.loadStartupSettings(controller.signal), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(calls, 0);
});

test("converts an unknown native rejection to a command-specific safe error", async () => {
  const port = createWindowSettingsTauriPort(createTransport(async () => {
    throw "write failed";
  }));

  await assert.rejects(
    port.saveStartupSettings({
      enabled: true,
      continueHighCost: false,
      launchAtLogin: false,
      launchAtLoginBackground: false,
    }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof WindowSettingsTauriError);
      assert.equal(error.command, "set_startup_enhancement_config");
      assert.equal(error.message, "write failed");
      return true;
    },
  );
});

test("validates and forwards the audited startup-enhancement event through a fake transport", async () => {
  let handler: ((event: TauriEvent<unknown>) => void) | undefined;
  let unlistened = false;
  const transport: TauriTransport = {
    invoke: async <TResult,>() => undefined as TResult,
    listen: async <TPayload,>(
      event: string,
      next: (event: TauriEvent<TPayload>) => void,
    ): Promise<TauriUnlisten> => {
      assert.equal(event, "startup-enhancement-state");
      handler = next as (event: TauriEvent<unknown>) => void;
      return () => { unlistened = true; };
    },
  };
  const port = createWindowSettingsTauriPort(transport);
  const received: unknown[] = [];
  const unlisten = await port.listenStartupEnhancementState((event) => received.push(event.payload));

  handler?.({
    event: "startup-enhancement-state",
    id: 1,
    payload: { backgrounded: true, continueHighCost: false, highCostResumeAtMs: 30 },
  });
  assert.deepEqual(received, [{ backgrounded: true, continueHighCost: false, highCostResumeAtMs: 30 }]);
  unlisten();
  assert.equal(unlistened, true);
});
