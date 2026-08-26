import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import {
  SyncRequestController,
  type SyncRequestMode,
} from "./sync-request-controller.ts";

type SyncValues = Readonly<Record<string, unknown>>;
type AccountTab = "overview" | "sync" | "security" | "data";
type ConnectionState = "unknown" | "checking" | "online" | "offline";
type SyncButtonState = "" | "syncing" | "ok" | "fail";

type SyncEvents = {
  readonly "app-settings-synced": null;
  readonly "app-settings-sync-failed": null;
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear?(): void;
}

type SyncElement = HTMLInputElement &
  HTMLButtonElement &
  HTMLDetailsElement &
  HTMLDivElement;

interface SyncDocument extends Document {
  getElementById(elementId: string): SyncElement;
}

interface SyncSettings extends Record<string, unknown> {
  readonly username?: string;
  readonly last_sync_at?: unknown;
  readonly last_sync_pushed?: unknown;
  readonly last_sync_pulled?: unknown;
  readonly last_sync_accepted?: unknown;
  readonly last_sync_ignored?: unknown;
}

interface UserIdentity {
  readonly username?: string;
}

interface AuthenticationResult {
  readonly user?: UserIdentity;
  readonly sync_enabled?: boolean;
}

interface SyncReport {
  readonly message: string;
  readonly server_time: number;
  readonly pushed: number;
  readonly pulled: number;
  readonly accepted: number;
  readonly ignored: number;
}

interface AccountUsageStatus {
  readonly storageBytes?: unknown;
  readonly storageLimitBytes?: unknown;
  readonly dailyWrittenBytes?: unknown;
  readonly dailyWriteLimitBytes?: unknown;
  readonly dailyResetAt?: unknown;
}

interface AccountSecurityStatus {
  readonly email?: string;
  readonly emailBound?: boolean;
  readonly mailConfigured?: boolean;
}

interface PrivateSyncOptions {
  readonly syncProgress: boolean;
  readonly syncReadingData: boolean;
  readonly syncVocabulary: boolean;
  readonly syncStatistics: boolean;
  readonly syncSoftwareSettings: boolean;
  readonly syncModelTags: boolean;
  readonly syncReaderPalettes: boolean;
  readonly syncConfigs: boolean;
  readonly syncAiHistory: boolean;
  readonly syncSecrets: boolean;
  readonly syncNewsSubscriptions: boolean;
}

interface PrivateSyncStatus extends Partial<PrivateSyncOptions> {
  readonly cloudSecretAvailable?: boolean;
}

interface SyncConnectionStatus {
  readonly configured: boolean;
  readonly online: boolean;
  readonly credentialsReady: boolean;
  readonly requiresUserAction: boolean;
}

interface SavedAccount {
  readonly username: string;
  readonly saved_at: unknown;
}

type SyncCommands = {
  readonly auth_usage_status: { readonly result: AccountUsageStatus };
  readonly auth_security_status: { readonly result: AccountSecurityStatus };
  readonly private_sync_get_settings: { readonly result: PrivateSyncStatus };
  readonly private_sync_set_options: {
    readonly args: { readonly options: PrivateSyncOptions };
    readonly result: PrivateSyncStatus;
  };
  readonly sync_get_settings: { readonly result: SyncSettings };
  readonly sync_account_open_refresh: { readonly result: SyncConnectionStatus };
  readonly sync_start_silent: { readonly result: unknown };
  readonly private_sync_set_password: {
    readonly args: { readonly password: string };
    readonly result: PrivateSyncStatus;
  };
  readonly sync_now: { readonly result: SyncReport };
  readonly private_sync_unlock_secrets: {
    readonly args: { readonly password: string };
    readonly result: unknown;
  };
  readonly private_sync_forget_password: { readonly result: PrivateSyncStatus };
  readonly clear_local_app_data_preflight: { readonly result: unknown };
  readonly clear_local_app_data: { readonly result: unknown };
  readonly sync_reset_cloud_data: {
    readonly args: { readonly request: { readonly password: string } };
    readonly result: unknown;
  };
  readonly auth_delete_account: {
    readonly args: {
      readonly request: {
        readonly password: string;
        readonly username: string;
      };
    };
    readonly result: unknown;
  };
  readonly auth_bind_email_start: {
    readonly args: { readonly request: { readonly email: string } };
    readonly result: unknown;
  };
  readonly auth_bind_email_confirm: {
    readonly args: {
      readonly request: { readonly email: string; readonly code: string };
    };
    readonly result: AccountSecurityStatus;
  };
  readonly auth_rebind_email_old_start: { readonly result: unknown };
  readonly auth_rebind_email_old_confirm: {
    readonly args: { readonly request: { readonly code: string } };
    readonly result: string;
  };
  readonly auth_rebind_email_new_start: {
    readonly args: {
      readonly request: {
        readonly email: string;
        readonly rebindGrant: string;
      };
    };
    readonly result: unknown;
  };
  readonly auth_rebind_email_new_confirm: {
    readonly args: {
      readonly request: { readonly email: string; readonly code: string };
    };
    readonly result: AccountSecurityStatus;
  };
  readonly auth_change_password: {
    readonly args: {
      readonly request: {
        readonly currentPassword: string;
        readonly newPassword: string;
      };
    };
    readonly result: unknown;
  };
  readonly auth_login: {
    readonly args: {
      readonly request: {
        readonly url: string;
        readonly username: string;
        readonly password: string;
      };
    };
    readonly result: AuthenticationResult;
  };
  readonly auth_register_start: {
    readonly args: {
      readonly request: {
        readonly url: string;
        readonly username: string;
        readonly email: string;
      };
    };
    readonly result: unknown;
  };
  readonly auth_register_confirm: {
    readonly args: {
      readonly request: {
        readonly url: string;
        readonly username: string;
        readonly email: string;
        readonly code: string;
        readonly password: string;
      };
    };
    readonly result: AuthenticationResult;
  };
  readonly auth_logout: { readonly result: unknown };
  readonly shelf_books: { readonly result: unknown };
};
type VerifiedSyncCommands = SyncCommands extends TauriCommandMap
  ? SyncCommands
  : never;

interface ReaderAppI18nApi {
  t?(key: string): string;
  resolvedLanguage?(): string | undefined;
}

interface SyncRuntime extends Record<string, unknown> {
  readonly localStorage?: StorageLike;
  readonly sessionStorage?: { clear?(): void };
  readonly location?: { reload?(): void };
  readonly ReaderAppI18n?: ReaderAppI18nApi;
  ReaderSyncUI?: SyncUiGlobal;
  confirm(message: string): boolean;
  addEventListener?(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  setInterval(handler: () => void, timeout?: number): number;
  clearInterval(handle?: number): void;
}

export interface SyncUiController {
  close(): void;
  loadSettings(): Promise<SyncSettings | null>;
  loadSettingsOnce(): Promise<void> | void;
  open(): void;
  syncOnStartup(): Promise<void>;
}

export interface SyncUiOptions {
  readonly root?: Document;
  readonly invoke?: TauriTransport["invoke"];
  readonly transport?: TauriTransport;
  readonly menuElement?: HTMLElement;
  readonly filterPanel?: HTMLElement;
  readonly renderShelf?: (books: unknown) => void;
  readonly storage?: StorageLike;
}

export interface SyncUiGlobal {
  close(): void;
  init(options?: SyncUiOptions): SyncUiController;
  loadSettingsOnce(): Promise<void> | void;
  open(): void;
  syncOnStartup(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): SyncRuntime | null {
  const candidate = record(value);
  return candidate ? (candidate as unknown as SyncRuntime) : null;
}

// 账号、登录和同步面板。依赖由 app.js 通过 ReaderSyncUI.init 显式注入。
export function installSyncUi(target: unknown): SyncUiGlobal | null {
  const candidate = runtimeFrom(target);
  if (!candidate) return null;
  const global: SyncRuntime = candidate;

  let activeController: SyncUiController | null = null;

  function init(options: SyncUiOptions = {}): SyncUiController {
    if (activeController) return activeController;
    const root = options.root as SyncDocument | undefined;
    const transport =
      options.transport || (options.invoke ? { invoke: options.invoke } : null);
    const api = transport
      ? createTauriApi<VerifiedSyncCommands>(transport)
      : null;
    const menuEl = options.menuElement;
    const filterPanel = options.filterPanel;
    const renderShelf = options.renderShelf;
    const storage = options.storage || global.localStorage;
    if (!root || typeof root.getElementById !== "function")
      throw new Error("ReaderSyncUI.init 缺少 root");
    if (!api) throw new Error("ReaderSyncUI.init 缺少 invoke");
    if (!menuEl || !filterPanel)
      throw new Error("ReaderSyncUI.init 缺少浮层元素");
    if (typeof renderShelf !== "function")
      throw new Error("ReaderSyncUI.init 缺少 renderShelf");
    if (!storage) throw new Error("ReaderSyncUI.init 缺少 storage");
    const document: SyncDocument = root;
    const renderShelfBooks: (books: unknown) => void = renderShelf;
    const localStorage: StorageLike = storage;

    const invoke = api.invoke.bind(api);
    const syncRequests = new SyncRequestController<SyncReport>();
    function requestSync(mode: SyncRequestMode = "immediate") {
      return syncRequests.request(mode, () => invoke("sync_now"));
    }
    function syncIsAlreadyRunning(error: unknown) {
      return String(error).includes("同步任务正在进行");
    }
    const accountBtn = document.getElementById(
      "account-btn",
    ) as HTMLButtonElement;
    const accountPanel = document.getElementById("account-panel");
    const syncFormEl = document.getElementById("sync-form");
    const syncAccountEl = document.getElementById("sync-account");
    const syncAccountNameEl = document.getElementById("sync-account-name");
    const syncUsernameEl = document.getElementById("sync-username");
    const syncPasswordEl = document.getElementById("sync-password");
    const savedAccountsEl = document.getElementById("saved-accounts");
    const SYNC_ACCOUNT_CACHE_KEY = "syncAccountCacheV1";
    const syncLastTimeEl = document.getElementById("sync-last-time");
    const syncLastCountsEl = document.getElementById("sync-last-counts");
    // 概览只保留一个同步摘要位置：历史计数和当前结果直接更新同一行。
    const syncStatusEl = syncLastCountsEl;
    const syncNowBtn = document.getElementById("sync-now");
    const syncLogoutBtn = document.getElementById("sync-logout");
    const syncRegisterBtn = document.getElementById("sync-register");
    const syncLoginBtn = document.getElementById("sync-login");
    const syncAuthStatusEl = document.getElementById("sync-auth-status");
    const accountAuthOpenBtn = document.getElementById("account-auth-open");
    const syncRegistrationEl = document.getElementById("sync-registration");
    const syncRegisterEmailEl = document.getElementById("sync-register-email");
    const syncRegisterCodeEl = document.getElementById("sync-register-code");
    const syncRegisterCodeRequestBtn = document.getElementById(
      "sync-register-code-request",
    );
    const syncRegisterConfirmBtn = document.getElementById(
      "sync-register-confirm",
    );
    const syncRegisterCancelBtn = document.getElementById(
      "sync-register-cancel",
    );
    const syncRegisterStatusEl = document.getElementById(
      "sync-register-status",
    );
    const accountSecurityOpenBtn = document.getElementById(
      "account-security-open",
    );
    const accountSecurityPanel = document.getElementById(
      "account-security-panel",
    );
    const accountOverviewPanel = document.getElementById(
      "account-overview-panel",
    );
    const accountOverviewSyncStateEl = document.getElementById(
      "account-overview-sync-state",
    );
    const accountOverviewSyncLabelEl = document.getElementById(
      "account-overview-sync-label",
    );
    function prepareSyncStateExpansion() {
      const labelStyle = accountOverviewSyncLabelEl.style;
      const previousLabelStyle = {
        flex: labelStyle.flex,
        maxWidth: labelStyle.maxWidth,
        position: labelStyle.position,
        visibility: labelStyle.visibility,
        width: labelStyle.width,
      };
      // The collapsed label has max-width: 0, so scrollWidth can report only the
      // clipped box. Measure the same label off-layout at its full content width.
      labelStyle.flex = "none";
      labelStyle.maxWidth = "none";
      labelStyle.position = "absolute";
      labelStyle.visibility = "hidden";
      labelStyle.width = "max-content";
      const labelWidth = Math.ceil(accountOverviewSyncLabelEl.offsetWidth);
      labelStyle.flex = previousLabelStyle.flex;
      labelStyle.maxWidth = previousLabelStyle.maxWidth;
      labelStyle.position = previousLabelStyle.position;
      labelStyle.visibility = previousLabelStyle.visibility;
      labelStyle.width = previousLabelStyle.width;
      const collapsedWidth = Math.ceil(accountOverviewSyncStateEl.offsetHeight);
      if (labelWidth > 0 && collapsedWidth > 0) {
        accountOverviewSyncStateEl.style.setProperty(
          "--account-sync-label-width",
          `${labelWidth}px`,
        );
        accountOverviewSyncStateEl.style.setProperty(
          "--account-sync-expanded-width",
          `${labelWidth + collapsedWidth + 2}px`,
        );
      }
    }
    function clearSyncStateCollapseMotion() {
      accountOverviewSyncStateEl.classList.remove("is-collapsing");
    }
    accountOverviewSyncStateEl.addEventListener("pointerenter", () => {
      clearSyncStateCollapseMotion();
      // Measure the live label so the pill visibly grows from the light to its exact content width.
      prepareSyncStateExpansion();
      accountOverviewSyncStateEl.classList.add("is-expanded");
    });
    accountOverviewSyncStateEl.addEventListener("focus", () => {
      prepareSyncStateExpansion();
    });
    accountOverviewSyncStateEl.addEventListener("pointerleave", () => {
      accountOverviewSyncStateEl.classList.remove("is-expanded");
      if (accountOverviewSyncStateEl.classList.contains("checking")) return;
      clearSyncStateCollapseMotion();
      // Force a fresh animation when the pointer quickly re-enters and leaves.
      void accountOverviewSyncStateEl.offsetWidth;
      accountOverviewSyncStateEl.classList.add("is-collapsing");
    });
    accountOverviewSyncStateEl.addEventListener("animationend", (event) => {
      if ((event as AnimationEvent).animationName === "account-sync-dot-settle") {
        clearSyncStateCollapseMotion();
      }
    });
    const accountStorageValueEl = document.getElementById(
      "account-storage-value",
    );
    const accountStorageBarEl = document.getElementById("account-storage-bar");
    const accountStorageNoteEl = document.getElementById(
      "account-storage-note",
    );
    const accountDailyValueEl = document.getElementById("account-daily-value");
    const accountDailyBarEl = document.getElementById("account-daily-bar");
    const accountDailyNoteEl = document.getElementById("account-daily-note");
    const accountOverviewTabBtn = document.getElementById(
      "account-tab-overview",
    );
    const accountSyncTabBtn = document.getElementById("account-tab-sync");
    const accountDataTabBtn = document.getElementById("account-data-open");
    const accountSecuritySummaryEl = document.getElementById(
      "account-security-summary",
    );
    const accountSecurityStatusEl = document.getElementById(
      "account-security-status",
    );
    const accountEmailDisclosureEl = document.getElementById(
      "account-email-disclosure",
    );
    const accountEmailToggleBtn = document.getElementById(
      "account-email-toggle",
    );
    document.getElementById("account-email-form");
    const accountEmailBindFlowEl = document.getElementById(
      "account-email-bind-flow",
    );
    const accountEmailRebindFlowEl = document.getElementById(
      "account-email-rebind-flow",
    );
    const accountEmailEl = document.getElementById("account-email");
    const accountEmailCodeEl = document.getElementById("account-email-code");
    const accountEmailStartBtn = document.getElementById("account-email-start");
    const accountEmailConfirmBtn = document.getElementById(
      "account-email-confirm",
    );
    const accountEmailOldStartBtn = document.getElementById(
      "account-email-old-start",
    );
    const accountEmailOldCodeEl = document.getElementById(
      "account-email-old-code",
    );
    const accountEmailOldConfirmBtn = document.getElementById(
      "account-email-old-confirm",
    );
    const accountEmailNewStepEl = document.getElementById(
      "account-email-new-step",
    );
    const accountEmailNewEl = document.getElementById("account-email-new");
    const accountEmailNewStartBtn = document.getElementById(
      "account-email-new-start",
    );
    const accountEmailNewCodeEl = document.getElementById(
      "account-email-new-code",
    );
    const accountEmailNewConfirmBtn = document.getElementById(
      "account-email-new-confirm",
    );
    const accountPasswordDisclosureEl = document.getElementById(
      "account-password-disclosure",
    );
    const accountPasswordToggleBtn = document.getElementById(
      "account-password-toggle",
    );
    document.getElementById("account-password-form");
    const accountCurrentPasswordEl = document.getElementById(
      "account-current-password",
    );
    const accountNewPasswordEl = document.getElementById(
      "account-new-password",
    );
    const accountPasswordChangeBtn = document.getElementById(
      "account-password-change",
    );
    const accountDataOpenBtn = document.getElementById("account-data-open");
    const accountDataPanel = document.getElementById("account-data-panel");
    const accountClearLocalBtn = document.getElementById("account-clear-local");
    const accountClearCloudPasswordEl = document.getElementById(
      "account-clear-cloud-password",
    );
    const accountClearCloudBtn = document.getElementById("account-clear-cloud");
    const accountDeletePasswordEl = document.getElementById(
      "account-delete-password",
    );
    const accountDeleteUsernameEl = document.getElementById(
      "account-delete-username",
    );
    const accountDeleteBtn = document.getElementById("account-delete");
    const accountDataStatusEl = document.getElementById("account-data-status");
    const privateSyncPanel = document.getElementById("private-sync-panel");
    const accountSyncProgressEl = document.getElementById(
      "account-sync-progress",
    );
    const accountSyncReadingDataEl = document.getElementById(
      "account-sync-reading-data",
    );
    const accountSyncVocabularyEl = document.getElementById(
      "account-sync-vocabulary",
    );
    const accountSyncStatisticsEl = document.getElementById(
      "account-sync-statistics",
    );
    const accountSyncSoftwareSettingsEl = document.getElementById(
      "account-sync-software-settings",
    );
    const accountSyncModelTagsEl = document.getElementById(
      "account-sync-model-tags",
    );
    const accountSyncPalettesEl = document.getElementById(
      "account-sync-palettes",
    );
    const accountSyncConfigsEl = document.getElementById(
      "account-sync-configs",
    );
    const accountSyncHistoryEl = document.getElementById(
      "account-sync-history",
    );
    const accountSyncSecretsEl = document.getElementById(
      "account-sync-secrets",
    );
    const accountSyncNewsSubscriptionsEl = document.getElementById(
      "account-sync-news-subscriptions",
    );
    const privateSyncPasswordEl = document.getElementById(
      "private-sync-password",
    );
    const privateSyncSavePasswordBtn = document.getElementById(
      "private-sync-save-password",
    );
    const privateSyncUnlockBtn = document.getElementById("private-sync-unlock");
    const privateSyncForgetBtn = document.getElementById("private-sync-forget");
    const privateSyncStatusEl = document.getElementById("private-sync-status");
    const SAVED_ACCOUNTS_KEY = "readerSavedAccountsV1";
    let accountEmailCooldownUntil = 0;
    let accountEmailCooldownTimer = 0;
    let accountEmailRebindGrant = "";
    let accountEmailBound = false;
    let lastSyncSettings: SyncSettings = {};
    let lastAccountSecurity: AccountSecurityStatus | null = null;
    let lastPrivateSync: PrivateSyncStatus | null = null;
    let lastAccountUsage: AccountUsageStatus | null = null;
    let lastSyncButtonState: {
      state: SyncButtonState;
      key: string;
      title: string;
      values: SyncValues;
    } = {
      state: "",
      key: "syncNow",
      title: "",
      values: {},
    };
    let lastConnectionState: {
      state: ConnectionState;
      key: string;
      title: string;
      values: SyncValues;
    } = {
      state: "unknown",
      key: "serviceUnchecked",
      title: "",
      values: {},
    };
    function syncText(key: string, values: SyncValues = {}) {
      let text = global.ReaderAppI18n?.t?.(key) || key;
      for (const [name, value] of Object.entries(values))
        text = text.replaceAll(`{${name}}`, String(value));
      return text;
    }
    function formatSyncTime(v: unknown) {
      const n = Number(v) || 0;
      if (!n) return syncText("lastSyncNever");
      const ms = n > 100000000000 ? n : n * 1000;
      return new Date(ms).toLocaleString(
        global.ReaderAppI18n?.resolvedLanguage?.(),
      );
    }
    function readCachedSyncAccount() {
      try {
        const cached = JSON.parse(
          localStorage.getItem(SYNC_ACCOUNT_CACHE_KEY) || "{}",
        );
        return cached && cached.username ? cached : null;
      } catch {
        return null;
      }
    }
    function writeCachedSyncAccount(username: string) {
      try {
        if (username)
          localStorage.setItem(
            SYNC_ACCOUNT_CACHE_KEY,
            JSON.stringify({ username, saved_at: Date.now() }),
          );
        else localStorage.removeItem(SYNC_ACCOUNT_CACHE_KEY);
      } catch {}
    }
    function applyCachedSyncAccount() {
      const cached = readCachedSyncAccount();
      if (!cached) return false;
      syncUsernameEl.value = cached.username || "";
      updateAccountView({ username: cached.username });
      return true;
    }
    function setSyncButtonState(
      state: SyncButtonState,
      key = "syncNow",
      title = "",
      values: SyncValues = {},
    ) {
      lastSyncButtonState = { state, key, title, values };
      syncNowBtn.classList.remove("syncing", "ok", "fail");
      if (state) syncNowBtn.classList.add(state);
      syncNowBtn.textContent = syncText(key || "syncNow", values);
      syncNowBtn.title = title;
      if (state === "syncing") {
        syncLastCountsEl.hidden = false;
        renderOverviewState("checking", "syncInProgress", title, values);
      } else if (state === "ok") {
        // The button and indicator already communicate success. Keep this
        // detail row for progress and actionable failures only.
        syncStatusEl.textContent = "";
        syncLastCountsEl.hidden = true;
        renderOverviewState("online", "syncSuccess", title, values);
      } else if (state === "fail") {
        syncLastCountsEl.hidden = false;
        renderOverviewState("offline", "syncFailed", title, values);
      } else
        renderOverviewState(
          lastConnectionState.state,
          lastConnectionState.key,
          lastConnectionState.title,
          lastConnectionState.values,
        );
    }
    function renderOverviewState(
      state: ConnectionState = "unknown",
      key = "serviceUnchecked",
      title = "",
      values: SyncValues = {},
    ) {
      if (!accountOverviewSyncStateEl) return;
      accountOverviewSyncStateEl.classList.remove(
        "unknown",
        "checking",
        "online",
        "offline",
      );
      accountOverviewSyncStateEl.classList.add(state);
      const label = syncText(key, values);
      if (accountOverviewSyncLabelEl) {
        accountOverviewSyncLabelEl.textContent = label;
        // The status can change while the pointer is still over the pill
        // (for example “同步中” -> “同步成功”). Refresh the measured width in
        // the same task so the complete new label is available before paint.
        prepareSyncStateExpansion();
      }
      accountOverviewSyncStateEl.setAttribute("aria-label", label);
      accountOverviewSyncStateEl.title = title;
    }
    function setConnectionState(
      state: ConnectionState = "unknown",
      key = "serviceUnchecked",
      title = "",
      values: SyncValues = {},
    ) {
      lastConnectionState = { state, key, title, values };
      // Reachability is supplementary evidence. It must never repaint an
      // explicit sync result: a successful quota check cannot make a failed
      // push look successful.
      if (!lastSyncButtonState.state)
        renderOverviewState(state, key, title, values);
    }
    function formatQuotaBytes(value: unknown) {
      const bytes = Math.max(0, Number(value) || 0);
      if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)} MiB`;
      if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KiB`;
      return `${bytes} B`;
    }
    function setQuotaBar(
      element: HTMLElement | null,
      used: number,
      limit: number,
    ) {
      if (!element?.style) return;
      const ratio =
        limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
      element.style.width = `${ratio}%`;
      element.classList?.toggle("near-limit", ratio >= 85);
    }
    function applyAccountUsage(status: AccountUsageStatus = {}) {
      lastAccountUsage = status;
      const storage = Math.max(0, Number(status.storageBytes) || 0);
      const storageLimit = Math.max(0, Number(status.storageLimitBytes) || 0);
      const daily = Math.max(0, Number(status.dailyWrittenBytes) || 0);
      const dailyLimit = Math.max(0, Number(status.dailyWriteLimitBytes) || 0);
      if (accountStorageValueEl)
        accountStorageValueEl.textContent = `${formatQuotaBytes(storage)} / ${formatQuotaBytes(storageLimit)}`;
      if (accountStorageNoteEl)
        accountStorageNoteEl.textContent = "同步实体和背景资产会计入此额度";
      if (accountDailyValueEl)
        accountDailyValueEl.textContent = `${formatQuotaBytes(daily)} / ${formatQuotaBytes(dailyLimit)}`;
      if (accountDailyNoteEl) {
        const reset = Number(status.dailyResetAt) || 0;
        accountDailyNoteEl.textContent = reset
          ? `下次重置：${formatSyncTime(reset)}`
          : "每日额度按服务器时间重置";
      }
      setQuotaBar(accountStorageBarEl, storage, storageLimit);
      setQuotaBar(accountDailyBarEl, daily, dailyLimit);
    }
    async function loadAccountUsage() {
      if (!syncUsernameEl.value.trim()) return;
      setConnectionState("checking", "serviceChecking");
      try {
        applyAccountUsage(await invoke("auth_usage_status"));
        setConnectionState("online", "serviceOnline");
      } catch (error) {
        setConnectionState("offline", "serviceOffline", String(error));
        if (accountStorageValueEl)
          accountStorageValueEl.textContent = "暂不可用";
        if (accountDailyValueEl) accountDailyValueEl.textContent = "暂不可用";
        if (accountDailyNoteEl)
          accountDailyNoteEl.textContent = "连接同步服务后显示今日额度";
      }
    }
    function updateSyncSummary(settings: SyncSettings = {}) {
      lastSyncSettings = { ...lastSyncSettings, ...settings };
      if (Object.prototype.hasOwnProperty.call(settings, "last_sync_at")) {
        syncLastTimeEl.textContent = syncText("lastSync", {
          time: formatSyncTime(settings.last_sync_at),
        });
      }
      const hasCounts =
        Object.prototype.hasOwnProperty.call(settings, "last_sync_pushed") ||
        Object.prototype.hasOwnProperty.call(settings, "last_sync_pulled") ||
        Object.prototype.hasOwnProperty.call(settings, "last_sync_accepted") ||
        Object.prototype.hasOwnProperty.call(settings, "last_sync_ignored");
      if (hasCounts) {
        const pushed = Number(settings.last_sync_pushed) || 0;
        const pulled = Number(settings.last_sync_pulled) || 0;
        const accepted = Number(settings.last_sync_accepted) || 0;
        const ignored = Number(settings.last_sync_ignored) || 0;
        syncLastCountsEl.textContent = syncText("syncCounts", {
          pushed,
          accepted,
          ignored,
          pulled,
        });
      }
    }
    function readSavedAccounts() {
      try {
        const list = JSON.parse(
          localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]",
        );
        if (!Array.isArray(list)) return [];
        return list
          .filter((x) => x && x.username)
          .map((x) => ({
            username: String(x.username || ""),
            saved_at: x.saved_at || 0,
          }))
          .filter((x) => x.username);
      } catch {
        return [];
      }
    }
    function writeSavedAccounts(list: readonly SavedAccount[]) {
      try {
        localStorage.setItem(
          SAVED_ACCOUNTS_KEY,
          JSON.stringify(list.slice(0, 12)),
        );
      } catch {}
    }
    function saveAccountInfo(username: string) {
      username = (username || "").trim();
      if (!username) return;
      const list = readSavedAccounts().filter((x) => x.username !== username);
      list.unshift({ username, saved_at: Date.now() });
      writeSavedAccounts(list);
    }
    function hideSavedAccounts() {
      savedAccountsEl.classList.remove("show");
    }
    function selectAccountTab(tab: string) {
      const pages = {
        overview: accountOverviewPanel,
        sync: privateSyncPanel,
        security: accountSecurityPanel,
        data: accountDataPanel,
      };
      const buttons = {
        overview: accountOverviewTabBtn,
        sync: accountSyncTabBtn,
        security: accountSecurityOpenBtn,
        data: accountDataTabBtn,
      };
      if (
        !Object.prototype.hasOwnProperty.call(pages, tab) ||
        (accountPanel.classList.contains("logged-out") && tab !== "overview")
      )
        tab = "overview";
      const selectedTab = tab as AccountTab;
      accountPanel.dataset.accountTab = selectedTab;
      for (const [name, page] of Object.entries(pages))
        if (page) page.hidden = name !== selectedTab;
      for (const [name, button] of Object.entries(buttons)) {
        if (!button) continue;
        button.classList.toggle("active", name === selectedTab);
        button.setAttribute(
          "aria-current",
          name === selectedTab ? "page" : "false",
        );
      }
      if (selectedTab === "security") {
        setAccountSecurityDisclosure(
          accountEmailDisclosureEl,
          accountEmailToggleBtn,
          false,
        );
        setAccountSecurityDisclosure(
          accountPasswordDisclosureEl,
          accountPasswordToggleBtn,
          false,
        );
        setAccountSecurityStatus("");
        loadAccountSecurityStatus();
      }
      if (selectedTab === "data") prepareAccountDataPanel();
      if (selectedTab === "sync") {
        void loadPrivateSyncStatus();
      }
    }
    let accountOpenRefreshGeneration = 0;
    async function refreshAccountPanelConnection() {
      if (!syncUsernameEl.value.trim()) return;
      const generation = ++accountOpenRefreshGeneration;
      setConnectionState("checking", "serviceChecking");
      try {
        const status = await invoke("sync_account_open_refresh");
        if (generation !== accountOpenRefreshGeneration) return;
        if (!status.configured) {
          setConnectionState("offline", "serviceOffline", "同步服务尚未配置");
          return;
        }
        if (!status.online) {
          setConnectionState("offline", "serviceOffline", "同步服务暂时不可达");
          if (status.credentialsReady)
            syncStatusEl.textContent = "同步服务暂时不可达，网络恢复后会自动重试。";
          return;
        }
        setConnectionState("online", "serviceOnline");
        if (status.credentialsReady) {
          setSyncButtonState("syncing", "syncInProgress");
          syncStatusEl.textContent = "同步服务在线，正在自动刷新。";
          try {
            // Start only after the UI has subscribed and entered its busy state;
            // otherwise a fast terminal event can be overwritten by “同步中”.
            await invoke("sync_start_silent");
          } catch (error) {
            if (generation !== accountOpenRefreshGeneration) return;
            setSyncButtonState("fail", "syncFailed", String(error));
            syncStatusEl.textContent = syncText("syncFailed");
          }
        } else if (status.requiresUserAction) {
          setSyncButtonState(
            "fail",
            "syncFailed",
            "同步服务在线；请点击同步并允许钥匙串访问。若仍被拒绝，请退出后重新登录。",
          );
          syncStatusEl.textContent =
            "同步服务在线；请点击同步并允许钥匙串访问。若仍被拒绝，请退出后重新登录。";
        }
      } catch (error) {
        if (generation !== accountOpenRefreshGeneration) return;
        setConnectionState("offline", "serviceOffline", String(error));
      }
    }
    function showLoggedOutOverview() {
      accountPanel.classList.remove("auth-entry");
      syncFormEl.classList.remove("registration-open");
      syncFormEl.classList.add("hidden");
      syncAccountEl.classList.add("show");
      syncLastTimeEl.textContent = syncText("lastSyncNever");
      // 标题已经说明“尚未登录”；概览摘要只保留“尚未同步”一行，避免
      // 同一状态被拆成两行重复显示。
      syncStatusEl.textContent = "";
      syncLastCountsEl.hidden = true;
      selectAccountTab("overview");
    }
    function openAuthenticationPage() {
      if (!accountPanel.classList.contains("logged-out")) return;
      // Opening the form focuses the username programmatically. Keep saved
      // accounts hidden until the person deliberately clicks that field.
      hideSavedAccounts();
      accountPanel.classList.add("auth-entry");
      accountPanel.dataset.accountTab = "auth";
      syncAccountEl.classList.remove("show");
      syncFormEl.classList.remove("hidden");
      syncFormEl.classList.remove("registration-open");
      syncRegistrationEl.hidden = true;
      syncRegisterCodeEl.value = "";
      syncRegisterStatusEl.textContent = "";
      syncUsernameEl.focus();
    }
    function closeAccountSubpages() {
      setAccountSecurityDisclosure(
        accountEmailDisclosureEl,
        accountEmailToggleBtn,
        false,
      );
      setAccountSecurityDisclosure(
        accountPasswordDisclosureEl,
        accountPasswordToggleBtn,
        false,
      );
      selectAccountTab("overview");
    }
    function closeAccountPanel() {
      accountPanel.classList.remove("show");
      closeAccountSubpages();
      syncRegistrationEl.hidden = true;
      syncFormEl.classList.remove("registration-open");
      syncRegisterCodeEl.value = "";
      syncRegisterStatusEl.textContent = "";
      if (accountPanel.classList.contains("logged-out"))
        showLoggedOutOverview();
      accountBtn.classList.remove("active");
      hideSavedAccounts();
    }
    function setAccountSecurityStatus(text = "", type = "") {
      accountSecurityStatusEl.textContent = text;
      accountSecurityStatusEl.className =
        "private-sync-status" + (type ? " " + type : "");
    }
    function setAccountDataStatus(text = "", type = "") {
      accountDataStatusEl.textContent = text;
      accountDataStatusEl.className =
        "private-sync-status" + (type ? " " + type : "");
    }
    function clearBrowserStateAndReload() {
      try {
        if (typeof localStorage.clear === "function") localStorage.clear();
        else {
          localStorage.removeItem(SAVED_ACCOUNTS_KEY);
          localStorage.removeItem(SYNC_ACCOUNT_CACHE_KEY);
        }
      } catch {}
      try {
        global.sessionStorage?.clear?.();
      } catch {}
      global.location?.reload?.();
    }
    function setDataActionBusy(busy: boolean) {
      const loggedIn = !!syncUsernameEl.value.trim();
      accountClearLocalBtn.disabled = busy;
      accountClearCloudBtn.disabled = busy || !loggedIn;
      accountDeleteBtn.disabled = busy || !loggedIn;
    }
    function setAccountSecurityDisclosure(
      disclosure: HTMLDetailsElement,
      toggle: HTMLElement,
      open: boolean,
    ) {
      disclosure.open = open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("open", open);
    }
    function updateAccountEmailCooldown() {
      const remaining = Math.max(
        0,
        Math.ceil((accountEmailCooldownUntil - Date.now()) / 1000),
      );
      if (!remaining) {
        accountEmailStartBtn.disabled = false;
        accountEmailStartBtn.textContent = "发送验证码";
        if (accountEmailCooldownTimer) {
          global.clearInterval(accountEmailCooldownTimer);
          accountEmailCooldownTimer = 0;
        }
        return;
      }
      accountEmailStartBtn.disabled = true;
      accountEmailStartBtn.textContent = `已发送（${remaining} 秒）`;
    }
    function beginAccountEmailCooldown() {
      accountEmailCooldownUntil = Date.now() + 60 * 1000;
      updateAccountEmailCooldown();
      if (!accountEmailCooldownTimer) {
        accountEmailCooldownTimer = global.setInterval(
          updateAccountEmailCooldown,
          1000,
        );
      }
    }
    function applyAccountSecurityStatus(status: AccountSecurityStatus = {}) {
      lastAccountSecurity = status;
      const email = status.email || "";
      accountEmailBound = !!status.emailBound;
      accountSecuritySummaryEl.textContent = status.emailBound
        ? syncText("accountSecurityBoundEmail", { email })
        : status.mailConfigured
          ? syncText("accountSecurityEmailUnbound")
          : syncText("accountSecurityMailUnavailable");
      accountEmailEl.value = "";
      accountEmailToggleBtn.textContent = accountEmailBound
        ? syncText("changeBoundEmail")
        : syncText("bindEmail");
      accountEmailBindFlowEl.hidden = accountEmailBound;
      accountEmailRebindFlowEl.hidden = !accountEmailBound;
      if (!accountEmailBound) {
        accountEmailRebindGrant = "";
        accountEmailNewStepEl.hidden = true;
      }
    }
    async function loadAccountSecurityStatus() {
      try {
        applyAccountSecurityStatus(await invoke("auth_security_status"));
      } catch (error) {
        setAccountSecurityStatus(
          syncText("accountSecurityLoadFailed", { error }),
          "error",
        );
      }
    }
    function setPrivateSyncStatus(text = "", type = "") {
      privateSyncStatusEl.textContent = text;
      privateSyncStatusEl.className =
        "private-sync-status" + (type ? " " + type : "");
    }
    function applyPrivateSyncOverview(status: PrivateSyncStatus = {}) {
      accountSyncProgressEl.checked = status.syncProgress !== false;
      accountSyncReadingDataEl.checked = status.syncReadingData !== false;
      accountSyncVocabularyEl.checked = status.syncVocabulary !== false;
      accountSyncStatisticsEl.checked = status.syncStatistics !== false;
      accountSyncSoftwareSettingsEl.checked =
        status.syncSoftwareSettings !== false;
      accountSyncModelTagsEl.checked = status.syncModelTags !== false;
      accountSyncPalettesEl.checked = status.syncReaderPalettes !== false;
      accountSyncConfigsEl.checked = status.syncConfigs !== false;
      accountSyncHistoryEl.checked = !!status.syncAiHistory;
      accountSyncSecretsEl.checked = !!status.syncSecrets;
      accountSyncNewsSubscriptionsEl.checked = !!status.syncNewsSubscriptions;
    }
    function applyPrivateSyncStatus(status: PrivateSyncStatus = {}) {
      lastPrivateSync = status;
      applyPrivateSyncOverview(status);
      const secretText = status.cloudSecretAvailable
        ? syncText("cloudSecretAvailable")
        : syncText("localSecretsOnly");
      setPrivateSyncStatus(secretText);
    }
    async function loadPrivateSyncStatus() {
      try {
        applyPrivateSyncStatus(await invoke("private_sync_get_settings"));
      } catch (error) {
        setPrivateSyncStatus(
          syncText("privateSyncLoadFailed", { error }),
          "error",
        );
      }
    }
    async function savePrivateSyncOptions() {
      const options = {
        syncProgress: !!accountSyncProgressEl.checked,
        syncReadingData: !!accountSyncReadingDataEl.checked,
        syncVocabulary: !!accountSyncVocabularyEl.checked,
        syncStatistics: !!accountSyncStatisticsEl.checked,
        syncSoftwareSettings: !!accountSyncSoftwareSettingsEl.checked,
        syncModelTags: !!accountSyncModelTagsEl.checked,
        syncReaderPalettes: !!accountSyncPalettesEl.checked,
        syncConfigs: !!accountSyncConfigsEl.checked,
        syncAiHistory: !!accountSyncHistoryEl.checked,
        syncSecrets: !!accountSyncSecretsEl.checked,
        syncNewsSubscriptions: !!accountSyncNewsSubscriptionsEl.checked,
      };
      try {
        const status = await invoke("private_sync_set_options", { options });
        applyPrivateSyncStatus(status);
        setPrivateSyncStatus("已保存；下次同步会按这个范围上传。", "ok");
      } catch (error) {
        setPrivateSyncStatus("保存失败：" + error, "error");
        await loadPrivateSyncStatus();
      }
    }
    function openAccountPanel(options: { readonly refresh?: boolean } = {}) {
      accountPanel.classList.add("show");
      accountBtn.classList.add("active");
      if (accountPanel.classList.contains("logged-out"))
        showLoggedOutOverview();
      else {
        selectAccountTab("overview");
      }
      if (options.refresh !== false) void refreshAccountPanelConnection();
    }
    function renderSavedAccounts() {
      const list = readSavedAccounts();
      savedAccountsEl.innerHTML = "";
      if (!list.length) {
        hideSavedAccounts();
        return;
      }
      for (const item of list) {
        const row = document.createElement("div");
        row.className = "saved-account-item";
        const name = document.createElement("span");
        name.textContent = item.username;
        const remove = document.createElement("button");
        remove.className = "saved-account-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "删除这个账号";
        remove.addEventListener("click", (e) => {
          e.stopPropagation();
          writeSavedAccounts(
            readSavedAccounts().filter((x) => x.username !== item.username),
          );
          renderSavedAccounts();
        });
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          syncUsernameEl.value = item.username;
          hideSavedAccounts();
          syncPasswordEl.value = "";
          syncPasswordEl.focus();
        });
        row.append(name, remove);
        savedAccountsEl.appendChild(row);
      }
      savedAccountsEl.classList.add("show");
    }
    function updateAccountView(settings: SyncSettings = {}) {
      updateSyncSummary(settings);
      const username = settings.username || syncUsernameEl.value.trim();
      const loggedOut = !username;
      accountPanel.classList.toggle("logged-out", loggedOut);
      accountPanel.classList.remove("auth-entry");
      for (const button of [
        accountSyncTabBtn,
        accountSecurityOpenBtn,
        accountDataTabBtn,
      ])
        button.disabled = loggedOut;
      if (username) {
        syncLastCountsEl.hidden = false;
        writeCachedSyncAccount(username);
        syncFormEl.classList.add("hidden");
        syncAccountEl.classList.add("show");
        syncAccountNameEl.textContent = syncText("accountPrefix") + username;
        setSyncButtonState("", "syncNow");
      } else {
        writeCachedSyncAccount("");
        syncFormEl.classList.add("hidden");
        syncAccountEl.classList.add("show");
        syncAccountNameEl.textContent = syncText("notLoggedIn");
        accountStorageValueEl.textContent = "登录后查看";
        accountStorageBarEl.style.width = "0%";
        accountStorageNoteEl.textContent = "登录后可查看同步存储用量";
        accountDailyValueEl.textContent = "登录后查看";
        accountDailyBarEl.style.width = "0%";
        accountDailyNoteEl.textContent = "登录后可查看今日额度";
        syncLastTimeEl.textContent = syncText("lastSyncNever");
        syncStatusEl.textContent = "";
        syncLastCountsEl.hidden = true;
        setSyncButtonState("", "syncNow");
        selectAccountTab("overview");
      }
    }
    async function loadSyncSettings() {
      try {
        const s = await invoke("sync_get_settings");
        syncUsernameEl.value = s.username || "";
        updateAccountView(s);
        await loadPrivateSyncStatus();
        return s;
      } catch (e) {
        syncStatusEl.textContent = syncText("readSyncSettingsFailed", {
          error: e,
        });
        return null;
      }
    }
    let syncSettingsLoaded = false;
    let syncSettingsLoading = false;
    let syncSettingsPromise: Promise<void> | null = null;
    async function loadSyncSettingsOnce() {
      if (syncSettingsLoaded) return;
      if (syncSettingsLoading && syncSettingsPromise)
        return syncSettingsPromise;
      syncSettingsLoading = true;
      syncSettingsPromise = (async () => {
        try {
          await loadSyncSettings();
          syncSettingsLoaded = true;
        } finally {
          syncSettingsLoading = false;
          syncSettingsPromise = null;
        }
      })();
      return syncSettingsPromise;
    }
    async function settleBackgroundSync(success: boolean) {
      if (!success) {
        if (lastSyncButtonState.state !== "syncing") return;
        setSyncButtonState("fail", "syncFailed");
        syncStatusEl.textContent = syncText("syncFailed");
        void loadAccountUsage();
        return;
      }
      try {
        const settings = await invoke("sync_get_settings");
        updateSyncSummary(settings);
        setSyncButtonState("ok", "syncSuccess");
        syncStatusEl.textContent = "";
        void loadAccountUsage();
        renderShelfBooks(await invoke("shelf_books"));
      } catch (error) {
        setSyncButtonState("fail", "syncFailed", String(error));
        syncStatusEl.textContent = syncText("syncFailedDetail", { error });
      }
    }
    // An automatic run can legitimately win the native single-flight guard
    // immediately after login.  Its terminal result must settle the account
    // UI; otherwise the foreground request only sees "already running" and
    // leaves the button in a permanent syncing state.
    void api
      .events<SyncEvents>()
      .listen("app-settings-synced", () => {
        void settleBackgroundSync(true);
      })
      .catch(() => undefined);
    void api
      .events<SyncEvents>()
      .listen("app-settings-sync-failed", () => {
        void settleBackgroundSync(false);
      })
      .catch(() => undefined);
    async function syncOnStartup() {
      await loadSyncSettingsOnce();
      // Startup must remain non-interactive. A protected token may require a
      // macOS Keychain approval, so only an explicit user sync may resolve it.
    }
    accountBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuEl.classList.remove("show");
      filterPanel.classList.remove("show");
      if (accountPanel.classList.contains("show")) {
        closeAccountPanel();
        return;
      }
      applyCachedSyncAccount();
      openAccountPanel();
    });
    accountPanel.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetElement = e.target instanceof Element ? e.target : null;
      const tabButton =
        targetElement?.closest<HTMLElement>("[data-account-tab]");
      if (tabButton && accountPanel.contains(tabButton)) {
        selectAccountTab(tabButton.dataset.accountTab || "overview");
        return;
      }
      if (!targetElement?.closest(".account-input-wrap")) hideSavedAccounts();
    });
    accountAuthOpenBtn.addEventListener("click", openAuthenticationPage);
    accountOverviewTabBtn.addEventListener("click", () =>
      selectAccountTab("overview"),
    );
    accountSyncTabBtn.addEventListener("click", () => selectAccountTab("sync"));
    for (const choice of [
      accountSyncProgressEl,
      accountSyncReadingDataEl,
      accountSyncVocabularyEl,
      accountSyncStatisticsEl,
      accountSyncSoftwareSettingsEl,
      accountSyncModelTagsEl,
      accountSyncPalettesEl,
      accountSyncConfigsEl,
      accountSyncHistoryEl,
      accountSyncNewsSubscriptionsEl,
    ])
      choice.addEventListener("change", savePrivateSyncOptions);
    accountSyncSecretsEl.addEventListener("change", async () => {
      if (!accountSyncSecretsEl.checked) {
        await savePrivateSyncOptions();
        return;
      }
      accountSyncSecretsEl.checked = false;
      privateSyncPasswordEl.focus();
      setPrivateSyncStatus(
        "密钥同步需要先输入同步密码并点击“加密并同步密钥”。",
      );
    });
    privateSyncSavePasswordBtn.addEventListener("click", async () => {
      const password = privateSyncPasswordEl.value;
      try {
        const status = await invoke("private_sync_set_password", { password });
        privateSyncPasswordEl.value = "";
        applyPrivateSyncStatus(status);
        setSyncButtonState("syncing", "syncInProgress");
        const report = await requestSync("immediate");
        setSyncButtonState("ok", "syncSuccess", report.message);
        updateSyncSummary({
          last_sync_at: report.server_time,
          last_sync_pushed: report.pushed,
          last_sync_pulled: report.pulled,
          last_sync_accepted: report.accepted,
          last_sync_ignored: report.ignored,
        });
        syncStatusEl.textContent = "";
        setPrivateSyncStatus(
          "密钥已加密并同步；其他设备输入同一同步密码即可恢复，无需再次填写 API Key。",
          "ok",
        );
      } catch (error) {
        setSyncButtonState("fail", "syncFailed", String(error));
        setPrivateSyncStatus("无法同步密钥：" + error, "error");
      }
    });
    privateSyncUnlockBtn.addEventListener("click", async () => {
      const password = privateSyncPasswordEl.value;
      try {
        await invoke("private_sync_unlock_secrets", { password });
        privateSyncPasswordEl.value = "";
        setPrivateSyncStatus("已在本机解锁并保存智读、翻译密钥。", "ok");
      } catch (error) {
        setPrivateSyncStatus("无法解锁云端密钥：" + error, "error");
      }
    });
    privateSyncForgetBtn.addEventListener("click", async () => {
      if (
        !global.confirm(
          "这会撤销云端的智读和翻译密钥包。同步密码无法找回；本机现有 API Key 不会删除。确定继续吗？",
        )
      )
        return;
      try {
        const status = await invoke("private_sync_forget_password");
        privateSyncPasswordEl.value = "";
        applyPrivateSyncStatus(status);
        setPrivateSyncStatus(
          "旧云端密钥包已撤销。若本机仍有 API Key，请输入新同步密码后重新加密。",
          "ok",
        );
      } catch (error) {
        setPrivateSyncStatus("撤销失败：" + error, "error");
      }
    });
    accountSecurityOpenBtn.addEventListener("click", () =>
      selectAccountTab("security"),
    );
    // Keep interactions inside the security page from reaching the account-panel
    // navigation handler. The two disclosure buttons must only expand/collapse
    // their own forms.
    accountSecurityPanel.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    function prepareAccountDataPanel() {
      const username = syncUsernameEl.value.trim();
      accountClearCloudPasswordEl.value = "";
      accountDeletePasswordEl.value = "";
      accountDeleteUsernameEl.value = "";
      accountDeleteUsernameEl.placeholder = username || "登录后输入完整账号名";
      accountClearCloudPasswordEl.disabled = !username;
      accountDeletePasswordEl.disabled = !username;
      accountDeleteUsernameEl.disabled = !username;
      accountClearCloudBtn.disabled = !username;
      accountDeleteBtn.disabled = !username;
      setAccountDataStatus(
        username
          ? ""
          : "当前未登录；仍可清除此设备数据。只有登录后才能清除云端或删除账号。",
      );
    }
    accountDataOpenBtn.addEventListener("click", () =>
      selectAccountTab("data"),
    );
    async function runLocalClearPreflight(
      reportError: (message: string) => void,
    ): Promise<boolean> {
      try {
        await invoke("clear_local_app_data_preflight");
        return true;
      } catch (error) {
        reportError("当前无法安全清理此设备：" + error);
        setDataActionBusy(false);
        return false;
      }
    }
    accountClearLocalBtn.addEventListener("click", async () => {
      if (
        !global.confirm(
          "确定清除此设备上的全部阅读器数据吗？\n\n书架记录、进度、批注、缓存、索引、模型、字体、账号和 API 配置会被清除；原始图书文件不会删除。",
        )
      )
        return;
      setDataActionBusy(true);
      setAccountDataStatus("正在清除此设备数据…");
      try {
        await invoke("clear_local_app_data");
        clearBrowserStateAndReload();
      } catch (error) {
        setAccountDataStatus("清除失败：" + error, "error");
        setDataActionBusy(false);
      }
    });
    accountClearCloudBtn.addEventListener("click", async () => {
      const password = accountClearCloudPasswordEl.value;
      if (!password) {
        setAccountDataStatus("请输入当前账号的登录密码。", "error");
        return;
      }
      if (
        !global.confirm(
          "确定清除此设备和云端的全部阅读数据吗？\n\n所有设备会退出登录，账号仍然保留；原始图书文件不会删除。",
        )
      )
        return;
      setDataActionBusy(true);
      if (
        !(await runLocalClearPreflight((message) =>
          setAccountDataStatus(message, "error"),
        ))
      )
        return;
      setAccountDataStatus("正在清除云端数据并退出所有设备…");
      try {
        await invoke("sync_reset_cloud_data", { request: { password } });
      } catch (error) {
        setAccountDataStatus("云端数据未清除：" + error, "error");
        setDataActionBusy(false);
        return;
      }
      setAccountDataStatus("云端数据已清空，正在清除此设备数据…", "ok");
      try {
        await invoke("clear_local_app_data");
        clearBrowserStateAndReload();
      } catch (error) {
        setAccountDataStatus(
          "云端数据已清空，所有设备已退出登录；但此设备数据未清除：" +
            error +
            "。请处理后点击上方“清除此设备”。",
          "error",
        );
        setDataActionBusy(false);
      }
    });
    accountDeleteBtn.addEventListener("click", async () => {
      const username = syncUsernameEl.value.trim();
      const confirmation = accountDeleteUsernameEl.value.trim();
      const password = accountDeletePasswordEl.value;
      if (!password || confirmation !== username) {
        setAccountDataStatus(
          "请输入登录密码，并逐字输入当前完整账号名确认。",
          "error",
        );
        return;
      }
      if (
        !global.confirm(
          `永久删除账号“${username}”及全部云端和本机数据？\n\n此操作不可恢复；原始图书文件不会删除。`,
        )
      )
        return;
      setDataActionBusy(true);
      if (
        !(await runLocalClearPreflight((message) =>
          setAccountDataStatus(message, "error"),
        ))
      )
        return;
      setAccountDataStatus("正在永久删除账号…");
      try {
        await invoke("auth_delete_account", {
          request: { password, username: confirmation },
        });
      } catch (error) {
        setAccountDataStatus("账号未删除：" + error, "error");
        setDataActionBusy(false);
        return;
      }
      setAccountDataStatus("账号和云端数据已删除，正在清除此设备数据…", "ok");
      try {
        await invoke("clear_local_app_data");
        clearBrowserStateAndReload();
      } catch (error) {
        setAccountDataStatus(
          "账号和云端数据已删除；但此设备数据未清除：" +
            error +
            "。请处理后点击上方“清除此设备”。",
          "error",
        );
        setDataActionBusy(false);
      }
    });
    accountEmailToggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      const open = !accountEmailDisclosureEl.open;
      setAccountSecurityDisclosure(
        accountEmailDisclosureEl,
        accountEmailToggleBtn,
        open,
      );
      if (open) {
        if (accountEmailBound) {
          accountEmailRebindGrant = "";
          accountEmailOldCodeEl.value = "";
          accountEmailNewEl.value = "";
          accountEmailNewCodeEl.value = "";
          accountEmailNewStepEl.hidden = true;
          accountEmailOldStartBtn.focus();
        } else {
          accountEmailEl.focus();
        }
      }
    });
    accountPasswordToggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      const open = !accountPasswordDisclosureEl.open;
      setAccountSecurityDisclosure(
        accountPasswordDisclosureEl,
        accountPasswordToggleBtn,
        open,
      );
      if (open) accountCurrentPasswordEl.focus();
    });
    accountEmailStartBtn.addEventListener("click", async () => {
      try {
        await invoke("auth_bind_email_start", {
          request: { email: accountEmailEl.value.trim() },
        });
        beginAccountEmailCooldown();
        setAccountSecurityStatus(
          "验证码已发送到该邮箱，请输入后确认绑定。",
          "ok",
        );
        accountEmailCodeEl.focus();
      } catch (error) {
        setAccountSecurityStatus("发送验证码失败：" + error, "error");
      }
    });
    accountEmailConfirmBtn.addEventListener("click", async () => {
      try {
        applyAccountSecurityStatus(
          await invoke("auth_bind_email_confirm", {
            request: {
              email: accountEmailEl.value.trim(),
              code: accountEmailCodeEl.value.trim(),
            },
          }),
        );
        accountEmailCodeEl.value = "";
        setAccountSecurityStatus("邮箱已验证绑定，可用于找回登录密码。", "ok");
      } catch (error) {
        setAccountSecurityStatus("绑定失败：" + error, "error");
      }
    });
    function beginRebindButtonCooldown(button: HTMLButtonElement) {
      if (!button.dataset.defaultLabel)
        button.dataset.defaultLabel = button.textContent || "";
      const until = Date.now() + 60 * 1000;
      const tick = () => {
        const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        button.disabled = remaining > 0;
        button.textContent = remaining
          ? `已发送（${remaining} 秒）`
          : button.dataset.defaultLabel || "";
        if (!remaining) global.clearInterval(timer);
      };
      const timer = global.setInterval(tick, 1000);
      tick();
    }
    accountEmailOldStartBtn.addEventListener("click", async () => {
      try {
        await invoke("auth_rebind_email_old_start");
        beginRebindButtonCooldown(accountEmailOldStartBtn);
        setAccountSecurityStatus(
          "验证码已发送到当前绑定邮箱，请输入后验证。",
          "ok",
        );
        accountEmailOldCodeEl.focus();
      } catch (error) {
        setAccountSecurityStatus("发送旧邮箱验证码失败：" + error, "error");
      }
    });
    accountEmailOldConfirmBtn.addEventListener("click", async () => {
      try {
        accountEmailRebindGrant = await invoke(
          "auth_rebind_email_old_confirm",
          {
            request: {
              code: accountEmailOldCodeEl.value.trim(),
            },
          },
        );
        accountEmailOldCodeEl.value = "";
        accountEmailNewStepEl.hidden = false;
        setAccountSecurityStatus("旧邮箱已验证，请填写并验证新邮箱。", "ok");
        accountEmailNewEl.focus();
      } catch (error) {
        setAccountSecurityStatus("旧邮箱验证失败：" + error, "error");
      }
    });
    accountEmailNewStartBtn.addEventListener("click", async () => {
      try {
        await invoke("auth_rebind_email_new_start", {
          request: {
            email: accountEmailNewEl.value.trim(),
            rebindGrant: accountEmailRebindGrant,
          },
        });
        accountEmailRebindGrant = "";
        beginRebindButtonCooldown(accountEmailNewStartBtn);
        setAccountSecurityStatus(
          "验证码已发送到新邮箱，请输入后确认更换。",
          "ok",
        );
        accountEmailNewCodeEl.focus();
      } catch (error) {
        setAccountSecurityStatus("发送新邮箱验证码失败：" + error, "error");
      }
    });
    accountEmailNewConfirmBtn.addEventListener("click", async () => {
      try {
        applyAccountSecurityStatus(
          await invoke("auth_rebind_email_new_confirm", {
            request: {
              email: accountEmailNewEl.value.trim(),
              code: accountEmailNewCodeEl.value.trim(),
            },
          }),
        );
        accountEmailNewCodeEl.value = "";
        accountEmailNewStepEl.hidden = true;
        setAccountSecurityStatus(
          "新的验证邮箱已绑定，可用于找回登录密码。",
          "ok",
        );
      } catch (error) {
        setAccountSecurityStatus("更换绑定邮箱失败：" + error, "error");
      }
    });
    accountPasswordChangeBtn.addEventListener("click", async () => {
      try {
        await invoke("auth_change_password", {
          request: {
            currentPassword: accountCurrentPasswordEl.value,
            newPassword: accountNewPasswordEl.value,
          },
        });
        accountCurrentPasswordEl.value = "";
        accountNewPasswordEl.value = "";
        setAccountSecurityStatus("登录密码已修改，其他设备已退出登录。", "ok");
      } catch (error) {
        setAccountSecurityStatus("修改失败：" + error, "error");
      }
    });
    function saveAuthentication(res: AuthenticationResult) {
      syncUsernameEl.value = res.user?.username || syncUsernameEl.value;
      saveAccountInfo(syncUsernameEl.value);
      syncPasswordEl.value = "";
      hideSavedAccounts();
      syncSettingsLoaded = true;
      updateAccountView({ username: syncUsernameEl.value });
    }

    async function finishAuthentication(res: AuthenticationResult) {
      saveAuthentication(res);
      // Authentication is an account-panel action. Keep the panel open and
      // return to its overview so the first sync is visible immediately.
      openAccountPanel({ refresh: false });
      setSyncButtonState("syncing", "firstSyncInProgress");
      try {
        const report = await requestSync("immediate");
        setSyncButtonState("ok", "syncSuccess", report.message);
        updateSyncSummary({
          last_sync_at: report.server_time,
          last_sync_pushed: report.pushed,
          last_sync_pulled: report.pulled,
          last_sync_accepted: report.accepted,
          last_sync_ignored: report.ignored,
        });
        syncStatusEl.textContent = "";
        renderShelfBooks(await invoke("shelf_books"));
      } catch (syncError) {
        // Authentication succeeded. Keep the account signed in and let the user
        // retry synchronization without re-entering the password.
        if (syncIsAlreadyRunning(syncError)) {
          setSyncButtonState("syncing", "syncInProgress", String(syncError));
          syncStatusEl.textContent = "同步任务正在进行，完成后会自动更新。";
        } else {
          setSyncButtonState("fail", "syncFailed", String(syncError));
        }
      }
    }

    function openRegistration() {
      hideSavedAccounts();
      syncFormEl.classList.add("registration-open");
      syncRegistrationEl.hidden = false;
      syncRegisterStatusEl.textContent = "填写邮箱并获取验证码。";
      syncRegisterStatusEl.className = "private-sync-status";
      syncRegisterEmailEl.focus();
    }

    async function syncAuth() {
      syncRegisterBtn.disabled = true;
      syncLoginBtn.disabled = true;
      syncLoginBtn.textContent = "登录中…";
      syncStatusEl.textContent = "登录中…";
      syncAuthStatusEl.textContent = "正在验证账号…";
      syncAuthStatusEl.className = "sync-auth-status pending";
      const username = syncUsernameEl.value.trim();
      const password = syncPasswordEl.value;
      try {
        const res = await invoke("auth_login", {
          request: {
            url: "",
            username,
            password,
          },
        });
        if (res.sync_enabled === false) {
          saveAuthentication(res);
          openAccountPanel();
          await loadAccountSecurityStatus();
          syncStatusEl.textContent =
            "账号已创建，请在账户安全中绑定并验证邮箱后再同步。";
          setSyncButtonState("fail", "syncFailed", syncStatusEl.textContent);
          return;
        }
        await finishAuthentication(res);
      } catch (e) {
        const message = `登录失败：${e}`;
        syncStatusEl.textContent = message;
        syncAuthStatusEl.textContent = message;
        syncAuthStatusEl.className = "sync-auth-status error";
      } finally {
        syncRegisterBtn.disabled = false;
        syncLoginBtn.disabled = false;
        syncLoginBtn.textContent = "登录";
      }
    }
    syncRegisterBtn.addEventListener("click", openRegistration);
    syncRegisterCancelBtn.addEventListener("click", () => {
      syncFormEl.classList.remove("registration-open");
      syncRegistrationEl.hidden = true;
      syncRegisterCodeEl.value = "";
      syncRegisterStatusEl.textContent = "";
      syncUsernameEl.focus();
    });
    syncRegisterCodeRequestBtn.addEventListener("click", async () => {
      const username = syncUsernameEl.value.trim();
      const email = syncRegisterEmailEl.value.trim();
      if (username.length < 3 || username.length > 32) {
        syncRegisterStatusEl.textContent =
          "注册账号长度必须为 3 到 32 个字符。";
        syncRegisterStatusEl.className = "private-sync-status error";
        syncUsernameEl.focus();
        return;
      }
      if (!email || !email.includes("@")) {
        syncRegisterStatusEl.textContent = "请输入有效邮箱地址。";
        syncRegisterStatusEl.className = "private-sync-status error";
        return;
      }
      syncRegisterCodeRequestBtn.disabled = true;
      syncRegisterCodeRequestBtn.textContent = "发送中…";
      try {
        await invoke("auth_register_start", {
          request: { url: "", username, email },
        });
        syncRegisterStatusEl.textContent =
          "验证码已发送，15 分钟内有效。请检查收件箱和垃圾邮件。";
        syncRegisterStatusEl.className = "private-sync-status ok";
        syncRegisterCodeEl.focus();
      } catch (error) {
        syncRegisterStatusEl.textContent = `发送失败：${error}`;
        syncRegisterStatusEl.className = "private-sync-status error";
      } finally {
        syncRegisterCodeRequestBtn.disabled = false;
        syncRegisterCodeRequestBtn.textContent = "发送验证码";
      }
    });
    syncRegisterConfirmBtn.addEventListener("click", async () => {
      const request = {
        url: "",
        username: syncUsernameEl.value.trim(),
        email: syncRegisterEmailEl.value.trim(),
        code: syncRegisterCodeEl.value.trim(),
        password: syncPasswordEl.value,
      };
      const passwordCharacters = Array.from(request.password).length;
      if (
        request.code.length !== 6 ||
        passwordCharacters < 8 ||
        passwordCharacters > 32
      ) {
        syncRegisterStatusEl.textContent =
          "请输入 6 位验证码，并使用 8–32 个字符的密码。";
        syncRegisterStatusEl.className = "private-sync-status error";
        return;
      }
      syncRegisterConfirmBtn.disabled = true;
      syncRegisterConfirmBtn.textContent = "注册中…";
      try {
        const res = await invoke("auth_register_confirm", { request });
        syncFormEl.classList.remove("registration-open");
        syncRegistrationEl.hidden = true;
        syncRegisterCodeEl.value = "";
        await finishAuthentication(res);
      } catch (error) {
        syncRegisterStatusEl.textContent = `注册失败：${error}`;
        syncRegisterStatusEl.className = "private-sync-status error";
      } finally {
        syncRegisterConfirmBtn.disabled = false;
        syncRegisterConfirmBtn.textContent = "验证并注册";
      }
    });
    syncLoginBtn.addEventListener("click", syncAuth);
    // Programmatic focus is used when opening/cancelling the registration
    // form. It must not expose the account history; a deliberate click does.
    syncUsernameEl.addEventListener("click", renderSavedAccounts);
    syncUsernameEl.addEventListener("input", () => {
      const q = syncUsernameEl.value.trim().toLowerCase();
      renderSavedAccounts();
      if (q) {
        savedAccountsEl
          .querySelectorAll<HTMLElement>(".saved-account-item")
          .forEach((row) => {
            row.style.display = (row.textContent || "")
              .toLowerCase()
              .includes(q)
              ? ""
              : "none";
          });
      }
    });
    [syncUsernameEl, syncPasswordEl].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          syncAuth();
        } else if (e.key === "Escape") {
          hideSavedAccounts();
        }
      });
    });
    syncLogoutBtn.addEventListener("click", async () => {
      try {
        await invoke("auth_logout");
      } catch (e) {
        syncStatusEl.textContent = "退出登录失败：" + e;
        return;
      }
      syncUsernameEl.value = "";
      syncPasswordEl.value = "";
      syncSettingsLoaded = true;
      updateAccountView({ username: "" });
    });
    syncNowBtn.addEventListener("click", async () => {
      if (syncNowBtn.disabled) return;
      syncNowBtn.disabled = true;
      setSyncButtonState("syncing", "syncInProgress");
      syncStatusEl.textContent = syncText("syncConnecting");
      try {
        const report = await requestSync("immediate");
        setSyncButtonState(
          "ok",
          "syncSuccess",
          syncText("syncServerTime", {
            message: report.message,
            time: formatSyncTime(report.server_time),
          }),
        );
        updateSyncSummary({
          last_sync_at: report.server_time,
          last_sync_pushed: report.pushed,
          last_sync_pulled: report.pulled,
          last_sync_accepted: report.accepted,
          last_sync_ignored: report.ignored,
        });
        syncStatusEl.textContent = "";
        void loadAccountUsage();
        renderShelfBooks(await invoke("shelf_books"));
      } catch (e) {
        if (syncIsAlreadyRunning(e)) {
          setSyncButtonState("syncing", "syncInProgress", String(e));
          syncStatusEl.textContent = "同步任务正在进行，完成后会自动更新。";
        } else {
          setSyncButtonState("fail", "syncFailed", String(e));
          syncStatusEl.textContent = syncText("syncFailedDetail", { error: e });
          void loadAccountUsage();
        }
      } finally {
        syncNowBtn.disabled = false;
      }
    });

    if (typeof global.addEventListener === "function")
      global.addEventListener("app-language-changed", () => {
        const buttonState = { ...lastSyncButtonState };
        const connectionState = { ...lastConnectionState };
        updateAccountView({ username: syncUsernameEl.value.trim() });
        updateSyncSummary(lastSyncSettings);
        setSyncButtonState(
          buttonState.state,
          buttonState.key,
          buttonState.title,
          buttonState.values,
        );
        setConnectionState(
          connectionState.state,
          connectionState.key,
          connectionState.title,
          connectionState.values,
        );
        if (lastAccountSecurity)
          applyAccountSecurityStatus(lastAccountSecurity);
        if (lastPrivateSync) applyPrivateSyncStatus(lastPrivateSync);
        if (lastAccountUsage) applyAccountUsage(lastAccountUsage);
      });

    activeController = Object.freeze({
      close: closeAccountPanel,
      loadSettings: loadSyncSettings,
      loadSettingsOnce: loadSyncSettingsOnce,
      open: openAccountPanel,
      syncOnStartup,
    });
    return activeController;
  }

  function controller() {
    if (!activeController) throw new Error("ReaderSyncUI 尚未初始化");
    return activeController;
  }

  const publicApi = Object.freeze({
    close: () => controller().close(),
    init,
    loadSettingsOnce: () => controller().loadSettingsOnce(),
    open: () => controller().open(),
    syncOnStartup: () => controller().syncOnStartup(),
  });
  global.ReaderSyncUI = publicApi;
  return publicApi;
}
