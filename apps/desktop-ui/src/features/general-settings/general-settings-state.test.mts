import assert from "node:assert/strict";
import test from "node:test";
import type { AutoImportSettings, ClassificationSnapshot } from "./general-settings-port.ts";
import {
  createGeneralSettingsState,
  generalSettingsReducer,
  normalizeExperimentalOptions,
} from "./general-settings-state.ts";

const autoImport: AutoImportSettings = {
  enabled: false,
  directories: [{ id: "books", label: "已选书库", permission: "granted" }],
};

const classification: ClassificationSnapshot = {
  task: { state: "idle", completed: 0, total: 0 },
  coverage: { totalBooks: 3, incompleteBooks: 3 },
  settings: { useModelTags: true },
};

function readyState() {
  return generalSettingsReducer(createGeneralSettingsState(), {
    type: "load-succeeded",
    bootstrap: { autoImport, classification, experimental: { newsnowPrefetch: true, newsnowHideReturnIcon: false }, needsExperimentalCompatibilityWrite: false },
  });
}

test("failed auto-import persistence rolls the optimistic draft back to the confirmed value", () => {
  let state = readyState();
  state = generalSettingsReducer(state, { type: "patch-auto-import", patch: { enabled: true } });
  state = generalSettingsReducer(state, { type: "save-started", requestId: 3 });
  state = generalSettingsReducer(state, { type: "save-failed", requestId: 3 });
  assert.equal(state.draftAutoImport.enabled, false);
  assert.equal(state.phase, "failed");
  assert.match(state.notice ?? "", /恢复为上次保存/);
});

test("directory selection removes duplicate opaque ids without retaining a local path", () => {
  const state = generalSettingsReducer(readyState(), {
    type: "replace-auto-import-directories",
    directories: [
      { id: "books", label: "已选书库", permission: "granted" },
      { id: "books", label: "重复项目", permission: "unavailable" },
      { id: "archive", label: "归档目录", permission: "needs-attention" },
    ],
  });
  assert.deepEqual(state.draftAutoImport.directories.map((directory) => directory.id), ["books", "archive"]);
  assert.deepEqual(state.draftAutoImport.directories.map((directory) => directory.label), ["已选书库", "归档目录"]);
});

test("scan waiting, cancellation and permission errors have explicit display states", () => {
  let state = readyState();
  state = generalSettingsReducer(state, { type: "scan-progress", progress: { phase: "waiting", found: 4, processed: 0, total: 0, added: 0, deferred: 2 } });
  assert.equal(state.scanPhase, "waiting");
  state = generalSettingsReducer(state, { type: "scan-cancelled" });
  assert.equal(state.scanPhase, "cancelled");
  state = generalSettingsReducer(state, { type: "scan-progress", progress: { phase: "permission-denied", found: 0, processed: 0, total: 0, added: 0, deferred: 0 } });
  assert.match(state.scanMessage ?? "", /目录权限/);
});

test("experiment compatibility keeps News enabled and normalises only supported option keys", () => {
  assert.deepEqual(normalizeExperimentalOptions({ newsnow: false, newsnowPrefetch: false, newsnowHideReturnIcon: true }), {
    newsnowPrefetch: false,
    newsnowHideReturnIcon: true,
  });
  assert.deepEqual(normalizeExperimentalOptions({ newsnow: true }), {
    newsnowPrefetch: true,
    newsnowHideReturnIcon: false,
  });
});
