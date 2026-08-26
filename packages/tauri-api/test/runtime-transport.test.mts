import assert from "node:assert/strict";
import test from "node:test";

import { transportFromTauriGlobal, type TauriEvent } from "../src/index.js";

test("runtime transport scopes listeners to the current WebviewWindow", async () => {
  const calls: string[] = [];
  const currentWindow = {
    async listen<TPayload>(
      event: string,
      _handler: (event: TauriEvent<TPayload>) => void,
    ): Promise<() => void> {
      void _handler;
      assert.equal(this, currentWindow);
      calls.push(`window:${event}`);
      return () => undefined;
    },
  };
  const transport = transportFromTauriGlobal({
    __TAURI__: {
      core: { invoke: async () => undefined },
      event: {
        listen: async (event: string) => {
          calls.push(`global:${event}`);
          return () => undefined;
        },
      },
      webviewWindow: { getCurrentWebviewWindow: () => currentWindow },
    },
  });

  await transport.listen?.("reader-shell-activate", () => undefined);
  assert.deepEqual(calls, ["window:reader-shell-activate"]);
});

test("runtime transport keeps the global listener as a compatibility fallback", async () => {
  const calls: string[] = [];
  const transport = transportFromTauriGlobal({
    __TAURI__: {
      core: { invoke: async () => undefined },
      event: {
        listen: async (event: string) => {
          calls.push(event);
          return () => undefined;
        },
      },
    },
  });

  await transport.listen?.("application-broadcast", () => undefined);
  assert.deepEqual(calls, ["application-broadcast"]);
});
