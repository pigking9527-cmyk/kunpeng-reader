import assert from "node:assert/strict";
import test from "node:test";

import { createAccountSyncController } from "./account-sync-controller.ts";
import type { AccountSyncPort } from "./account-sync-port.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function port(overrides: Partial<AccountSyncPort> = {}): AccountSyncPort {
  return {
    loadSession: async () => null,
    login: async () => ({
      username: "reader",
      emailVerified: true,
      syncEnabled: true,
    }),
    register: async () => ({
      username: "reader",
      emailVerified: false,
      syncEnabled: false,
    }),
    logout: async () => undefined,
    requestEmailVerification: async () => undefined,
    confirmEmailVerification: async () => ({
      username: "reader",
      emailVerified: true,
      syncEnabled: true,
    }),
    changePassword: async () => undefined,
    sync: async () => ({
      pushed: 0,
      pulled: 0,
      accepted: 0,
      ignored: 0,
      completedAt: "2026-08-13T00:00:00Z",
    }),
    clearThisDevice: async () => undefined,
    clearCloudAndThisDevice: async () => undefined,
    deleteAccount: async () => undefined,
    ...overrides,
  };
}

test("session loading publishes only account metadata", async () => {
  const account = {
    username: "reader",
    emailVerified: true,
    syncEnabled: true,
  };
  const controller = createAccountSyncController(
    port({ loadSession: async () => account }),
  );
  await controller.loadSession();

  assert.deepEqual(controller.getState().account, account);
  assert.equal(controller.getState().auth, "success");
});

test("a newer session request ignores an older non-cooperative completion", async () => {
  const first = deferred<Awaited<ReturnType<AccountSyncPort["loadSession"]>>>();
  let calls = 0;
  const controller = createAccountSyncController(
    port({
      loadSession: async () => {
        calls += 1;
        return calls === 1
          ? first.promise
          : { username: "new-reader", emailVerified: true, syncEnabled: true };
      },
    }),
  );
  const old = controller.loadSession();
  await controller.loadSession();
  first.resolve({
    username: "old-reader",
    emailVerified: true,
    syncEnabled: true,
  });
  await old;

  assert.equal(controller.getState().account?.username, "new-reader");
});

test("close aborts session loading and prevents a late completion from publishing", async () => {
  const pending =
    deferred<Awaited<ReturnType<AccountSyncPort["loadSession"]>>>();
  const controller = createAccountSyncController(
    port({ loadSession: async () => pending.promise }),
  );
  const work = controller.loadSession();
  controller.close();
  pending.resolve({
    username: "late-reader",
    emailVerified: true,
    syncEnabled: true,
  });
  await work;

  assert.equal(controller.getState().account, null);
});
