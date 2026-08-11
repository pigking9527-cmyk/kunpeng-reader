import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSummary, SyncReport } from "./account-sync-port.ts";
import { accountSyncReducer, initialAccountSyncState, progressPercent, safeFailureNotice } from "./account-sync-state.ts";

const account: AccountSummary = { username: "reader", emailVerified: true, syncEnabled: true };
const report: SyncReport = { pushed: 4, pulled: 3, accepted: 6, ignored: 1, completedAt: "2026-08-10T10:00:00Z" };

test("authentication state only accepts account metadata, never credentials or tokens", () => {
  const state = accountSyncReducer(initialAccountSyncState, { type: "auth-started", requestId: 1 });
  const authenticated = accountSyncReducer(state, { type: "auth-succeeded", requestId: 1, account });
  assert.deepEqual(authenticated.account, account);
  assert.equal("password" in authenticated, false);
  assert.equal("token" in authenticated, false);
});

test("a stale successful sync cannot overwrite a later cancellation", () => {
  let state = accountSyncReducer(initialAccountSyncState, { type: "sync-started", requestId: 2 });
  state = accountSyncReducer(state, { type: "sync-cancelled", requestId: 2 });
  const stale = accountSyncReducer(state, { type: "sync-succeeded", requestId: 1, report });
  assert.equal(stale, state);
  assert.equal(stale.sync.phase, "cancelled");
});

test("sync renders bounded progress and preserves offline/conflict as explicit states", () => {
  let state = accountSyncReducer(initialAccountSyncState, { type: "sync-started", requestId: 1 });
  state = accountSyncReducer(state, { type: "sync-progress", requestId: 1, progress: { stage: "uploading", completed: 12, total: 10 } });
  assert.equal(progressPercent(state.sync.progress), 100);
  state = accountSyncReducer(state, { type: "sync-failed", requestId: 1, offline: true, notice: "当前离线，同步会在网络恢复后重试。" });
  assert.equal(state.sync.phase, "offline");
  state = accountSyncReducer(state, { type: "sync-started", requestId: 2 });
  state = accountSyncReducer(state, { type: "sync-conflict", requestId: 2, conflict: { kind: "conflict", count: 2 } });
  assert.equal(state.sync.phase, "conflict");
  assert.equal(state.sync.conflict?.count, 2);
});

test("sensitive operations require a separate confirmation state and reset account after cloud clear", () => {
  let state = accountSyncReducer(initialAccountSyncState, { type: "auth-started", requestId: 1 });
  state = accountSyncReducer(state, { type: "auth-succeeded", requestId: 1, account });
  state = accountSyncReducer(state, { type: "confirm-sensitive-action", action: "clear-cloud" });
  assert.equal(state.recovery.phase, "confirming");
  assert.equal(state.recovery.pendingAction, "clear-cloud");
  state = accountSyncReducer(state, { type: "sensitive-action-started", action: "clear-cloud" });
  state = accountSyncReducer(state, { type: "sensitive-action-succeeded", action: "clear-cloud" });
  assert.equal(state.account, null);
  assert.equal(state.notice, "云端与本机数据已清除。");
});

test("a failed confirmation stays visible for retry and a cancellation dismisses it", () => {
  let state = accountSyncReducer(initialAccountSyncState, { type: "confirm-sensitive-action", action: "delete-account" });
  state = accountSyncReducer(state, { type: "sensitive-action-started", action: "delete-account" });
  state = accountSyncReducer(state, { type: "sensitive-action-failed", action: "delete-account", notice: "操作未完成，请稍后重试。" });
  assert.equal(state.recovery.phase, "confirming");
  assert.equal(state.recovery.pendingAction, "delete-account");
  state = accountSyncReducer(state, { type: "recovery-cancelled", requestId: state.recovery.requestId });
  assert.equal(state.recovery.phase, "cancelled");
  assert.equal(state.recovery.pendingAction, null);
});

test("unsafe transport text is never selected as a user-facing error", () => {
  const error = new Error("password=do-not-show server-internal-details");
  assert.equal(safeFailureNotice(error, "同步未完成，请稍后重试。"), "同步未完成，请稍后重试。");
});
