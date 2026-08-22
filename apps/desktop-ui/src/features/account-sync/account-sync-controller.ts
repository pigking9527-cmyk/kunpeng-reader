import type { AccountSyncPort } from "./account-sync-port.js";
import {
  accountSyncReducer,
  initialAccountSyncState,
  isAbortError,
  type AccountSyncState,
} from "./account-sync-state.js";

export type AccountSyncListener = (state: AccountSyncState) => void;

export interface AccountSyncController {
  getState(): AccountSyncState;
  subscribe(listener: AccountSyncListener): () => void;
  loadSession(): Promise<void>;
  close(): void;
}

/**
 * Owns the cancellation and stale-result boundary for account session loading.
 */
export function createAccountSyncController(
  port: AccountSyncPort,
): AccountSyncController {
  let state = initialAccountSyncState;
  let activeSession: AbortController | null = null;
  let nextRequestId = 0;
  let closed = false;
  const listeners = new Set<AccountSyncListener>();

  const publish = (action: Parameters<typeof accountSyncReducer>[1]): void => {
    state = accountSyncReducer(state, action);
    for (const listener of listeners) listener(state);
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
        if (!closed && activeSession === controller)
          publish({ type: "session-ready", requestId, account });
      } catch (error: unknown) {
        if (!closed && activeSession === controller) {
          publish(
            isAbortError(error) || controller.signal.aborted
              ? { type: "auth-cancelled", requestId }
              : {
                  type: "auth-failed",
                  requestId,
                  notice: "无法读取账号状态，请稍后重试。",
                },
          );
        }
      } finally {
        if (activeSession === controller) activeSession = null;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      activeSession?.abort();
      activeSession = null;
      listeners.clear();
    },
  };
}
