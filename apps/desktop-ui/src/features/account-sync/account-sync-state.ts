import type {
  AccountSummary,
  CloudRecoveryRestoreResult,
  CloudRecoveryStatus,
  RecoveryPoint,
  SyncConflict,
  SyncProgress,
  SyncReport,
} from "./account-sync-port.js";

export type AsyncPhase = "idle" | "loading" | "success" | "failure" | "cancelled";
export type SyncPhase = "idle" | "syncing" | "success" | "failure" | "cancelled" | "offline" | "conflict";
export type SensitiveAction = "clear-device" | "clear-cloud" | "delete-account";
export type RecoveryPhase = "idle" | "loading" | "ready" | "confirming" | "running" | "success" | "failure" | "cancelled";
export type CloudRecoveryPhase = "idle" | "loading" | "ready" | "restoring" | "success" | "failure" | "cancelled";

export interface AccountSyncState {
  readonly account: AccountSummary | null;
  readonly auth: AsyncPhase;
  readonly authRequestId: number;
  readonly sync: {
    readonly phase: SyncPhase;
    readonly requestId: number;
    readonly progress: SyncProgress | null;
    readonly report: SyncReport | null;
    readonly conflict: SyncConflict | null;
  };
  readonly recovery: {
    readonly phase: RecoveryPhase;
    readonly requestId: number;
    readonly points: readonly RecoveryPoint[];
    readonly pendingAction: SensitiveAction | null;
  };
  /** Summary-only server history state. It never contains synchronized entities or credentials. */
  readonly cloudRecovery: {
    readonly phase: CloudRecoveryPhase;
    readonly requestId: number;
    readonly status: CloudRecoveryStatus | null;
    readonly result: CloudRecoveryRestoreResult | null;
  };
  /** Safe, user-facing status only. Never use port error text here. */
  readonly notice: string;
}

export const initialAccountSyncState: AccountSyncState = Object.freeze({
  account: null,
  auth: "idle",
  authRequestId: 0,
  sync: Object.freeze({ phase: "idle", requestId: 0, progress: null, report: null, conflict: null }),
  recovery: Object.freeze({ phase: "idle", requestId: 0, points: [], pendingAction: null }),
  cloudRecovery: Object.freeze({ phase: "idle", requestId: 0, status: null, result: null }),
  notice: "",
});

export type AccountSyncAction =
  | { readonly type: "session-loading"; readonly requestId: number }
  | { readonly type: "session-ready"; readonly requestId: number; readonly account: AccountSummary | null }
  | { readonly type: "auth-started"; readonly requestId: number }
  | { readonly type: "auth-succeeded"; readonly requestId: number; readonly account: AccountSummary }
  | { readonly type: "auth-failed"; readonly requestId: number; readonly notice: string }
  | { readonly type: "auth-cancelled"; readonly requestId: number }
  | { readonly type: "logged-out" }
  | { readonly type: "email-verified"; readonly account: AccountSummary }
  | { readonly type: "sync-started"; readonly requestId: number }
  | { readonly type: "sync-progress"; readonly requestId: number; readonly progress: SyncProgress }
  | { readonly type: "sync-succeeded"; readonly requestId: number; readonly report: SyncReport }
  | { readonly type: "sync-conflict"; readonly requestId: number; readonly conflict: SyncConflict }
  | { readonly type: "sync-failed"; readonly requestId: number; readonly notice: string; readonly offline: boolean }
  | { readonly type: "sync-cancelled"; readonly requestId: number }
  | { readonly type: "recovery-loading"; readonly requestId: number }
  | { readonly type: "recovery-ready"; readonly requestId: number; readonly points: readonly RecoveryPoint[] }
  | { readonly type: "recovery-failed"; readonly requestId: number; readonly notice: string }
  | { readonly type: "recovery-cancelled"; readonly requestId: number }
  | { readonly type: "cloud-recovery-loading"; readonly requestId: number }
  | { readonly type: "cloud-recovery-ready"; readonly requestId: number; readonly status: CloudRecoveryStatus }
  | { readonly type: "cloud-recovery-restoring"; readonly requestId: number }
  | { readonly type: "cloud-recovery-restored"; readonly requestId: number; readonly result: CloudRecoveryRestoreResult }
  | { readonly type: "cloud-recovery-failed"; readonly requestId: number; readonly notice: string }
  | { readonly type: "cloud-recovery-cancelled"; readonly requestId: number }
  | { readonly type: "confirm-sensitive-action"; readonly action: SensitiveAction }
  | { readonly type: "dismiss-sensitive-action" }
  | { readonly type: "sensitive-action-started"; readonly action: SensitiveAction }
  | { readonly type: "sensitive-action-succeeded"; readonly action: SensitiveAction }
  | { readonly type: "sensitive-action-failed"; readonly action: SensitiveAction; readonly notice: string }
  | { readonly type: "set-notice"; readonly notice: string }
  | { readonly type: "clear-notice" };

function isCurrent(requestId: number, current: number): boolean {
  return requestId === current;
}

export function accountSyncReducer(state: AccountSyncState, action: AccountSyncAction): AccountSyncState {
  switch (action.type) {
    case "session-loading":
    case "auth-started":
      return { ...state, auth: "loading", authRequestId: action.requestId, notice: "" };
    case "session-ready":
      if (!isCurrent(action.requestId, state.authRequestId)) return state;
      return { ...state, account: action.account, auth: "success", notice: "" };
    case "auth-succeeded":
      if (!isCurrent(action.requestId, state.authRequestId)) return state;
      return { ...state, account: action.account, auth: "success", notice: "已登录。" };
    case "auth-failed":
      if (!isCurrent(action.requestId, state.authRequestId)) return state;
      return { ...state, auth: "failure", notice: action.notice };
    case "auth-cancelled":
      if (!isCurrent(action.requestId, state.authRequestId)) return state;
      return { ...state, auth: "cancelled", notice: "操作已取消。" };
    case "logged-out":
      return { ...initialAccountSyncState, auth: "success", notice: "已退出登录。" };
    case "email-verified":
      return { ...state, account: action.account, notice: "邮箱已验证绑定。" };
    case "sync-started":
      return {
        ...state,
        sync: { phase: "syncing", requestId: action.requestId, progress: null, report: null, conflict: null },
        notice: "正在同步…",
      };
    case "sync-progress":
      if (!isCurrent(action.requestId, state.sync.requestId) || state.sync.phase !== "syncing") return state;
      return { ...state, sync: { ...state.sync, progress: action.progress } };
    case "sync-succeeded":
      if (!isCurrent(action.requestId, state.sync.requestId)) return state;
      return { ...state, sync: { ...state.sync, phase: "success", progress: null, report: action.report }, notice: "同步完成。" };
    case "sync-conflict":
      if (!isCurrent(action.requestId, state.sync.requestId)) return state;
      return { ...state, sync: { ...state.sync, phase: "conflict", progress: null, conflict: action.conflict }, notice: "发现同步冲突，需要处理后再继续。" };
    case "sync-failed":
      if (!isCurrent(action.requestId, state.sync.requestId)) return state;
      return { ...state, sync: { ...state.sync, phase: action.offline ? "offline" : "failure", progress: null }, notice: action.notice };
    case "sync-cancelled":
      if (!isCurrent(action.requestId, state.sync.requestId)) return state;
      return { ...state, sync: { ...state.sync, phase: "cancelled", progress: null }, notice: "同步已取消。" };
    case "recovery-loading":
      return { ...state, recovery: { ...state.recovery, phase: "loading", requestId: action.requestId }, notice: "正在读取恢复点…" };
    case "recovery-ready":
      if (!isCurrent(action.requestId, state.recovery.requestId)) return state;
      return { ...state, recovery: { ...state.recovery, phase: "ready", points: action.points }, notice: "" };
    case "recovery-failed":
      if (!isCurrent(action.requestId, state.recovery.requestId)) return state;
      return { ...state, recovery: { ...state.recovery, phase: "failure" }, notice: action.notice };
    case "recovery-cancelled":
      if (!isCurrent(action.requestId, state.recovery.requestId)) return state;
      return { ...state, recovery: { ...state.recovery, phase: "cancelled", pendingAction: null }, notice: "操作已取消。" };
    case "cloud-recovery-loading":
      return {
        ...state,
        cloudRecovery: { phase: "loading", requestId: action.requestId, status: null, result: null },
        notice: "正在读取云端恢复状态…",
      };
    case "cloud-recovery-ready":
      if (!isCurrent(action.requestId, state.cloudRecovery.requestId)) return state;
      return { ...state, cloudRecovery: { ...state.cloudRecovery, phase: "ready", status: action.status }, notice: "" };
    case "cloud-recovery-restoring":
      return {
        ...state,
        cloudRecovery: { ...state.cloudRecovery, phase: "restoring", requestId: action.requestId, result: null },
        notice: "正在恢复云端数据…",
      };
    case "cloud-recovery-restored":
      if (!isCurrent(action.requestId, state.cloudRecovery.requestId)) return state;
      return {
        ...state,
        account: null,
        cloudRecovery: { ...state.cloudRecovery, phase: "success", result: action.result },
        notice: "云端恢复已完成，请重新登录后同步。",
      };
    case "cloud-recovery-failed":
      if (!isCurrent(action.requestId, state.cloudRecovery.requestId)) return state;
      return { ...state, cloudRecovery: { ...state.cloudRecovery, phase: "failure" }, notice: action.notice };
    case "cloud-recovery-cancelled":
      if (!isCurrent(action.requestId, state.cloudRecovery.requestId)) return state;
      return { ...state, cloudRecovery: { ...state.cloudRecovery, phase: "cancelled" }, notice: "云端恢复已取消。" };
    case "confirm-sensitive-action":
      return { ...state, recovery: { ...state.recovery, phase: "confirming", pendingAction: action.action }, notice: "请阅读确认说明后继续。" };
    case "dismiss-sensitive-action":
      return { ...state, recovery: { ...state.recovery, phase: "ready", pendingAction: null }, notice: "" };
    case "sensitive-action-started":
      return { ...state, recovery: { ...state.recovery, phase: "running", pendingAction: action.action }, notice: "正在执行敏感操作…" };
    case "sensitive-action-succeeded":
      return {
        ...initialAccountSyncState,
        auth: "success",
        notice: action.action === "delete-account"
          ? "账号已删除。"
          : action.action === "clear-cloud"
            ? "云端与本机数据已清除。"
            : "此设备数据已清除。",
      };
    case "sensitive-action-failed":
      return { ...state, recovery: { ...state.recovery, phase: "confirming", pendingAction: action.action }, notice: action.notice };
    case "set-notice":
      return { ...state, notice: action.notice };
    case "clear-notice":
      return { ...state, notice: "" };
  }
}

export function progressPercent(progress: SyncProgress | null): number | null {
  if (progress === null || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isOfflineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error && (error as { kind?: unknown }).kind === "offline";
}

/** Do not pass caught error text through this boundary: it can include private service details. */
export function safeFailureNotice(error: unknown, fallback: string): string {
  return isOfflineError(error) ? "当前离线，同步会在网络恢复后重试。" : fallback;
}
