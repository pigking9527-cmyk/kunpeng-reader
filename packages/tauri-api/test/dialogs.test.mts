import assert from "node:assert/strict";
import test from "node:test";

import { dialogsFromTauriGlobal } from "../src/dialogs.js";

test("dialog capability validates and returns file selections", async () => {
  const calls: Array<{ readonly method: string; readonly value: unknown }> = [];
  const dialogs = dialogsFromTauriGlobal({
    __TAURI__: {
      dialog: {
        open: async (options: unknown) => {
          calls.push({ method: "open", value: options });
          return ["/tmp/one.epub", "/tmp/two.pdf"];
        },
        save: async (options: unknown) => {
          calls.push({ method: "save", value: options });
          return "/tmp/export.json";
        },
        message: async (message: unknown) => {
          calls.push({ method: "message", value: message });
        },
        ask: async () => true,
        confirm: async () => false,
      },
    },
  });

  assert.deepEqual(
    await dialogs.open({ multiple: true, filters: [{ name: "图书", extensions: ["epub"] }] }),
    ["/tmp/one.epub", "/tmp/two.pdf"],
  );
  assert.equal(await dialogs.save({ defaultPath: "export.json" }), "/tmp/export.json");
  await dialogs.message("完成", { kind: "info" });
  assert.equal(await dialogs.ask("继续？"), true);
  assert.equal(await dialogs.confirm("删除？"), false);
  assert.deepEqual(calls.map(({ method }) => method), ["open", "save", "message"]);
});

test("dialog capability rejects malformed native results", async () => {
  const dialogs = dialogsFromTauriGlobal({
    __TAURI__: {
      dialog: {
        open: async () => ["/tmp/book.epub", 7],
        save: async () => ({ path: "/tmp/export.json" }),
        message: async () => undefined,
        ask: async () => "yes",
        confirm: async () => 1,
      },
    },
  });

  await assert.rejects(dialogs.open(), /invalid path selection/);
  await assert.rejects(dialogs.save(), /invalid path selection/);
  await assert.rejects(dialogs.ask("继续？"), /invalid confirmation result/);
  await assert.rejects(dialogs.confirm("继续？"), /invalid confirmation result/);
});

test("dialog capability fails closed when a runtime method is absent", async () => {
  const dialogs = dialogsFromTauriGlobal({ __TAURI__: { dialog: {} } });
  await assert.rejects(dialogs.open(), /dialog\.open is unavailable/);
});
