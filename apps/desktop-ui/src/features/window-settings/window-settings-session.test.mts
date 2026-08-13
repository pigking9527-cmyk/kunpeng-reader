import assert from "node:assert/strict";
import test from "node:test";

import type { StartupEnhancementSettings, WindowSettingsPort } from "./window-settings-port.ts";
import { createWindowSettingsSession } from "./window-settings-session.ts";
import type { WindowSettingsAction } from "./window-settings-state.ts";

const settings: StartupEnhancementSettings = {
  enabled: true,
  continueHighCost: false,
  launchAtLogin: true,
  launchAtLoginAvailable: true,
  launchAtLoginBackground: false,
  launchAtLoginBackgroundAvailable: true,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

test("only the most recent save completion is dispatched, even when an old host promise ignores abort", async () => {
  const first = deferred<StartupEnhancementSettings>();
  const second = deferred<StartupEnhancementSettings>();
  const actions: WindowSettingsAction[] = [];
  let saveCount = 0;
  const port: WindowSettingsPort = {
    loadStartupSettings: async () => settings,
    saveStartupSettings: async () => (++saveCount === 1 ? first.promise : second.promise),
    closeMainWindow: async () => undefined,
    requestApplicationExit: async () => undefined,
  };
  const session = createWindowSettingsSession(port, (action) => actions.push(action));
  session.activate();
  const firstSave = session.save(settings);
  const secondSave = session.save({ ...settings, enabled: false });
  first.resolve(settings);
  await firstSave;
  second.resolve({ ...settings, enabled: false });
  await secondSave;

  assert.deepEqual(actions.map((action) => action.type), ["save-started", "save-started", "save-succeeded"]);
  assert.deepEqual(actions.at(-1), {
    type: "save-succeeded",
    requestId: 2,
    settings: { ...settings, enabled: false },
  });
});

test("dispose aborts pending host work and suppresses a completion after unmount", async () => {
  const load = deferred<StartupEnhancementSettings>();
  const actions: WindowSettingsAction[] = [];
  let receivedSignal: AbortSignal | undefined;
  const port: WindowSettingsPort = {
    loadStartupSettings: async (signal) => {
      receivedSignal = signal;
      return load.promise;
    },
    saveStartupSettings: async () => settings,
    closeMainWindow: async () => undefined,
    requestApplicationExit: async () => undefined,
  };
  const session = createWindowSettingsSession(port, (action) => actions.push(action));
  session.activate();
  const pending = session.load();
  session.dispose();
  assert.equal(receivedSignal?.aborted, true);
  load.resolve(settings);
  await pending;
  assert.deepEqual(actions, [{ type: "load-started" }]);
});
