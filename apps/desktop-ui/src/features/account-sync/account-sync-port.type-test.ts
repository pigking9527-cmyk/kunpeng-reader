import type { AccountSyncPort, TransientCredentials } from "./account-sync-port.js";
import type { AccountSyncState } from "./account-sync-state.js";

declare const port: AccountSyncPort;
declare const credentials: TransientCredentials;
declare const state: AccountSyncState;
declare const transientPassword: string;

void port.login(credentials, new AbortController().signal);
void port.cloudRecoveryStatus(new AbortController().signal);
void port.restoreCloudRecovery({ targetAt: Date.now(), dataGeneration: 1, password: transientPassword }, new AbortController().signal);

// Credentials are transient port input, not a renderable/persisted state field.
// @ts-expect-error AccountSyncState must never store a password.
void state.password;
// @ts-expect-error AccountSyncState must never store an auth token.
void state.token;
