import type {
  AccountSyncPort,
  CloudRecoveryRestoreResult,
  CloudRecoveryStatus,
} from "./account-sync-port.js";
import {
  accountSyncReducer,
  initialAccountSyncState,
  isAbortError,
  safeFailureNotice,
  type AccountSyncState,
} from "./account-sync-state.js";

export type AccountSyncListener = (state: AccountSyncState) => void;

export interface AccountSyncController {
  getState(): AccountSyncState;
  subscribe(listener: AccountSyncListener): () => void;
  loadSession(): Promise<void>;
  loadCloudRecovery(): Promise<void>;
  restoreCloudRecovery(targetAt: number, dataGeneration: number, password: string): Promise<void>;
  close(): void;
}

const STATUS_FAILURE = "无法读取云端恢复状态，请稍后重试。";
const RESTORE_FAILURE = "云端恢复未完成，请核对确认信息后重试。";

/**
 * Owns the cancellation and stale-result boundary for account recovery.
 *
 * Credentials are deliberately parameters, never controller state: callers
 * must clear their input immediately after calling `restoreCloudRecovery`.
 */
export function createAccountSyncController(port: AccountSyncPort): AccountSyncController {
  let state = initialAccountSyncState;
  let activeSession: AbortController | null = null;
  let activeRecovery: AbortController | null = null;
  let nextRequestId = 0;
  let closed = false;
  const listeners = new Set<AccountSyncListener>();

  const publish = (action: Parameters<typeof accountSyncReducer>[1]): void => {
    state = accountSyncReducer(state, action);
    for (const listener of listeners) listener(state);
  };

  const begin = (): [number, AbortController] => {
    activeRecovery?.abort();
    const controller = new AbortController();
    activeRecovery = controller;
    return [++nextRequestId, controller];
  };

  return {
    getState: () => state,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async loadSession(): Promise<void> {
      if (closed) return;
      activeSession?.abort();
      const controller = new AbortController();
      activeSession = controller;
      const requestId = ++nextRequestId;
      publish({ type: "session-loading", requestId });
      try {
        const account = await port.loadSession(controller.signal);
        if (!closed && activeSession === controller) publish({ type: "session-ready", requestId, account });
      } catch (error: unknown) {
        if (!closed && activeSession === controller) {
          publish(isAbortError(error) || controller.signal.aborted
            ? { type: "auth-cancelled", requestId }
            : { type: "auth-failed", requestId, notice: "无法读取账号状态，请稍后重试。" });
        }
      } finally {
        if (activeSession === controller) activeSession = null;
      }
    },
    async loadCloudRecovery(): Promise<void> {
      if (closed) return;
      const [requestId, controller] = begin();
      publish({ type: "cloud-recovery-loading", requestId });
      try {
        const status: CloudRecoveryStatus = await port.cloudRecoveryStatus(controller.signal);
        if (!closed && activeRecovery === controller) publish({ type: "cloud-recovery-ready", requestId, status });
      } catch (error: unknown) {
        if (!closed && activeRecovery === controller) {
          publish(isAbortError(error) || controller.signal.aborted
            ? { type: "cloud-recovery-cancelled", requestId }
            : { type: "cloud-recovery-failed", requestId, notice: safeFailureNotice(error, STATUS_FAILURE) });
        }
      } finally {
        if (activeRecovery === controller) activeRecovery = null;
      }
    },
    async restoreCloudRecovery(targetAt: number, dataGeneration: number, password: string): Promise<void> {
      if (closed || !Number.isSafeInteger(targetAt) || targetAt <= 0 || !Number.isSafeInteger(dataGeneration) || dataGeneration <= 0 || password.length === 0) return;
      const [requestId, controller] = begin();
      publish({ type: "cloud-recovery-restoring", requestId });
      try {
        const result: CloudRecoveryRestoreResult = await port.restoreCloudRecovery({ targetAt, dataGeneration, password }, controller.signal);
        if (!closed && activeRecovery === controller) publish({ type: "cloud-recovery-restored", requestId, result });
      } catch (error: unknown) {
        if (!closed && activeRecovery === controller) {
          publish(isAbortError(error) || controller.signal.aborted
            ? { type: "cloud-recovery-cancelled", requestId }
            : { type: "cloud-recovery-failed", requestId, notice: safeFailureNotice(error, RESTORE_FAILURE) });
        }
      } finally {
        if (activeRecovery === controller) activeRecovery = null;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeSession?.abort();
      activeRecovery?.abort();
      activeSession = null;
      activeRecovery = null;
      listeners.clear();
    },
  };
}
