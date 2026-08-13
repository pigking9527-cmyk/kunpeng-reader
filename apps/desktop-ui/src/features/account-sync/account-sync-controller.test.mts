import assert from "node:assert/strict";
import test from "node:test";

import { createAccountSyncController } from "./account-sync-controller.ts";
import type { AccountSyncPort, CloudRecoveryRestoreRequest } from "./account-sync-port.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function port(overrides: Partial<AccountSyncPort> = {}): AccountSyncPort {
  return {
    loadSession: async () => null,
    login: async () => ({ username: "reader", emailVerified: true, syncEnabled: true }),
    register: async () => ({ username: "reader", emailVerified: false, syncEnabled: false }),
    logout: async () => undefined,
    requestEmailVerification: async () => undefined,
    confirmEmailVerification: async () => ({ username: "reader", emailVerified: true, syncEnabled: true }),
    changePassword: async () => undefined,
    sync: async () => ({ pushed: 0, pulled: 0, accepted: 0, ignored: 0, completedAt: "2026-08-13T00:00:00Z" }),
    listRecoveryPoints: async () => [],
    restoreRecoveryPoint: async () => ({ restoredEntities: 0, tombstonedEntities: 0 }),
    cloudRecoveryStatus: async () => ({ available: true, retentionDays: 90, restorableFrom: 100, latestVersionAt: 200, versionCount: 2, dataGeneration: 3 }),
    restoreCloudRecovery: async () => ({ restoredEntities: 2, tombstonedEntities: 1, restoredAt: 201 }),
    clearThisDevice: async () => undefined,
    clearCloudAndThisDevice: async () => undefined,
    deleteAccount: async () => undefined,
    ...overrides,
  };
}

test("cloud recovery exposes only summary status and clears account after a successful restore", async () => {
  let submitted: CloudRecoveryRestoreRequest | null = null;
  const controller = createAccountSyncController(port({
    loadSession: async () => ({ username: "reader", emailVerified: true, syncEnabled: true }),
    restoreCloudRecovery: async (request) => {
      submitted = request;
      return { restoredEntities: 4, tombstonedEntities: 2, restoredAt: 205 };
    },
  }));
  await controller.loadSession();
  await controller.loadCloudRecovery();
  await controller.restoreCloudRecovery(150, 3, "one-use-password");

  assert.deepEqual(submitted, { targetAt: 150, dataGeneration: 3, password: "one-use-password" });
  assert.equal(controller.getState().account, null);
  assert.equal(controller.getState().cloudRecovery.phase, "success");
  assert.equal(controller.getState().cloudRecovery.result?.restoredEntities, 4);
  assert.equal(JSON.stringify(controller.getState()), JSON.stringify(controller.getState()).replace("one-use-password", ""));
});

test("new recovery request aborts and ignores an older non-cooperative completion", async () => {
  const first = deferred<Awaited<ReturnType<AccountSyncPort["cloudRecoveryStatus"]>>>();
  let calls = 0;
  const controller = createAccountSyncController(port({
    cloudRecoveryStatus: async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return { available: false, retentionDays: 90, restorableFrom: 0, latestVersionAt: 0, versionCount: 0, dataGeneration: 3 };
    },
  }));
  const old = controller.loadCloudRecovery();
  await controller.loadCloudRecovery();
  first.resolve({ available: true, retentionDays: 90, restorableFrom: 100, latestVersionAt: 200, versionCount: 2, dataGeneration: 3 });
  await old;

  assert.equal(controller.getState().cloudRecovery.status?.available, false);
});

test("close aborts recovery and prevents a late restore completion from publishing", async () => {
  const pending = deferred<Awaited<ReturnType<AccountSyncPort["restoreCloudRecovery"]>>>();
  const controller = createAccountSyncController(port({ restoreCloudRecovery: async () => pending.promise }));
  const work = controller.restoreCloudRecovery(150, 3, "transient");
  controller.close();
  pending.resolve({ restoredEntities: 9, tombstonedEntities: 1, restoredAt: 201 });
  await work;

  assert.equal(controller.getState().cloudRecovery.result, null);
  assert.equal(JSON.stringify(controller.getState()).includes("transient"), false);
});
