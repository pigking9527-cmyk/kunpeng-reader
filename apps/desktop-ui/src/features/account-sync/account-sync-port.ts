/**
 * Typed, injected boundary for account and synchronisation.
 *
 * This is intentionally a feature port rather than a Tauri command map. A
 * composition root may adapt existing commands to it later, after the old and
 * new flows have been compared. Callers must never read Tauri globals
 * or retain credentials/tokens themselves.
 */

export interface AccountSummary {
  readonly username: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly syncEnabled: boolean;
}

export interface TransientCredentials {
  readonly username: string;
  /** Use only for the in-flight request; never put this in persisted state. */
  readonly password: string;
}

export interface PasswordChangeRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface EmailVerificationRequest {
  readonly email: string;
  readonly code: string;
}

export type SyncStage = "preparing" | "uploading" | "downloading" | "applying";

export interface SyncProgress {
  readonly stage: SyncStage;
  /** A bounded, UI-only indication. The transport never receives this back. */
  readonly completed: number;
  readonly total: number;
}

export interface SyncReport {
  readonly pushed: number;
  readonly pulled: number;
  readonly accepted: number;
  readonly ignored: number;
  readonly completedAt: string;
}

export interface SyncConflict {
  readonly kind: "conflict";
  /** A count only: never include entity payloads or reading content in UI state. */
  readonly count: number;
}

/**
 * Expected, non-sensitive operation categories. Port implementations should
 * wrap transport failures in this value instead of exposing server text.
 */
export class AccountSyncPortError extends Error {
  public constructor(
    public readonly kind:
      "offline" | "unauthorized" | "unavailable" | "invalid-input",
  ) {
    super(kind);
    this.name = "AccountSyncPortError";
  }
}

export interface AccountSyncPort {
  loadSession(signal: AbortSignal): Promise<AccountSummary | null>;
  login(
    credentials: TransientCredentials,
    signal: AbortSignal,
  ): Promise<AccountSummary>;
  register(
    credentials: TransientCredentials,
    signal: AbortSignal,
  ): Promise<AccountSummary>;
  logout(signal: AbortSignal): Promise<void>;

  requestEmailVerification(email: string, signal: AbortSignal): Promise<void>;
  confirmEmailVerification(
    request: EmailVerificationRequest,
    signal: AbortSignal,
  ): Promise<AccountSummary>;
  changePassword(
    request: PasswordChangeRequest,
    signal: AbortSignal,
  ): Promise<void>;

  sync(
    signal: AbortSignal,
    onProgress: (progress: SyncProgress) => void,
  ): Promise<SyncReport | SyncConflict>;
  /** Clears reader data on this device only; original book files are preserved. */
  clearThisDevice(signal: AbortSignal): Promise<void>;
  /** The confirmation password is passed once and must not be cached by the port. */
  clearCloudAndThisDevice(password: string, signal: AbortSignal): Promise<void>;
  /** Account-name confirmation and password are passed once and must not be cached. */
  deleteAccount(
    usernameConfirmation: string,
    password: string,
    signal: AbortSignal,
  ): Promise<void>;
}
