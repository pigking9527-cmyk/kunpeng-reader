import {
  dialogsFromTauriGlobal,
  transportFromTauriGlobal,
  type TauriEvent,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type UnknownRecord = Record<string, unknown>;
type LegacyInvoke = TauriTransport["invoke"];
type StatusKind = "" | "busy" | "ok" | "error";

interface MainDocument extends Document {
  getElementById(elementId: string): MainElement;
}

interface MainElement extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  options: HTMLOptionsCollection;
  selectedIndex: number;
  value: string;
  blur(): void;
}

interface BookRecord extends UnknownRecord {
  readonly id?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly cover?: unknown;
  readonly format?: unknown;
  readonly rating?: unknown;
  readonly description?: unknown;
}

interface AutoImportSettings {
  enabled: boolean;
  dirs: string[];
}

interface AutoImportApplyOptions {
  readonly scan?: boolean;
  readonly reason?: string;
  readonly status?: string;
}

interface RecoveryBackup extends UnknownRecord {
  readonly id: string;
  readonly created_at?: unknown;
  readonly total_bytes?: unknown;
}

interface RecoveryBackupStatus extends UnknownRecord {
  readonly count?: unknown;
  readonly total_bytes?: unknown;
  readonly latest?: unknown;
  readonly directory?: unknown;
  readonly backups?: readonly RecoveryBackup[];
}

interface ExternalDictionary extends UnknownRecord {
  readonly id: unknown;
  readonly name?: unknown;
  readonly lang?: unknown;
  readonly format?: unknown;
  readonly entry_count?: unknown;
  readonly size_bytes?: unknown;
  readonly source_path?: unknown;
  readonly enabled?: unknown;
}

interface NoteHighlight extends UnknownRecord {
  readonly text?: string;
  readonly context?: string;
  readonly note?: string;
}

interface VocabularyNote extends UnknownRecord {
  readonly word?: string;
  readonly count?: number;
  readonly def?: string;
}

interface BookNotes extends UnknownRecord {
  readonly title?: string;
  readonly highlights?: readonly NoteHighlight[];
  readonly vocab?: readonly VocabularyNote[];
}

interface LibraryHealthBook extends UnknownRecord {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly path?: unknown;
  readonly format?: unknown;
}

interface LibraryHealthDuplicate extends UnknownRecord {
  readonly books: readonly LibraryHealthBook[];
}

interface SearchIndexHealth extends UnknownRecord {
  readonly binary_files?: unknown;
  readonly legacy_files?: unknown;
  readonly orphan_files?: unknown;
  readonly disk_bytes?: unknown;
  readonly memory_bytes?: unknown;
  readonly memory_limit_bytes?: unknown;
  readonly memory_entries?: unknown;
  readonly disk_limit_bytes?: unknown;
}

interface LibraryHealthReport extends UnknownRecord {
  readonly total?: unknown;
  readonly healthy?: unknown;
  readonly missing?: readonly LibraryHealthBook[];
  readonly duplicates?: readonly LibraryHealthDuplicate[];
  readonly search_index?: SearchIndexHealth;
}

interface StartupPerfPayload extends UnknownRecord {
  readonly name?: unknown;
  readonly phase?: unknown;
  readonly detail?: unknown;
}

interface ShelfReadPayload extends UnknownRecord {
  readonly id?: unknown;
  readonly lastReadAt?: unknown;
}

interface ImportProgressPayload extends UnknownRecord {
  readonly phase?: unknown;
  readonly total?: unknown;
  readonly processed?: unknown;
  readonly added?: unknown;
  readonly current?: unknown;
}

interface DragDropPayload extends UnknownRecord {
  readonly paths?: unknown;
}

interface ReaderGesturePayload extends UnknownRecord {
  readonly bookId?: unknown;
  readonly action?: unknown;
  readonly field?: unknown;
}

interface MainEvents extends Record<string, unknown> {
  readonly "startup-perf": StartupPerfPayload;
  readonly "shelf-book-read": ShelfReadPayload;
  readonly "book-import-progress": ImportProgressPayload;
  readonly "associated-book-open": unknown;
  readonly "tauri://drag-enter": unknown;
  readonly "tauri://drag-leave": unknown;
  readonly "tauri://drag-drop": DragDropPayload;
  readonly "reader-gesture-action": ReaderGesturePayload;
}

interface LegacyEventApi {
  listen<TEvent extends keyof MainEvents & string>(
    event: TEvent,
    handler: (event: TauriEvent<MainEvents[TEvent]>) => void,
  ): Promise<() => void>;
}

interface SyncInitOptions extends UnknownRecord {
  readonly renderShelf: (list: unknown) => void;
}

interface AboutInitOptions extends UnknownRecord {
  readonly alertAction: (message: string) => void;
}

interface ShelfInitOptions extends UnknownRecord {
  readonly closeSearch: (clear: boolean) => void;
  readonly startPerformance: (name: string, detail: string) => (detail: string) => void;
  readonly confirmAction: (message: string) => boolean;
  readonly alertAction: (message: string, options?: UnknownRecord) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
}

interface StatsInitOptions extends UnknownRecord {
  readonly closeSearch: (clear: boolean) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
}

interface AutoImportCreateOptions extends UnknownRecord {
  readonly renderShelf: (list: unknown) => void;
}

interface SyncController {
  close(): void;
  loadSettingsOnce(): Promise<void>;
  syncOnStartup(): Promise<void>;
}

interface ShelfController {
  count(): number;
  render(list: unknown): void;
  getSearchQuery(): string;
  getBooks(): BookRecord[];
  getBook(id: string): BookRecord | undefined;
  getSelectedIds(): string[];
  updateBook(id: string, patch: UnknownRecord): void;
  openBooklist(name: string): void;
  coverColor(title: unknown): string;
  changeCoverById(id: string): Promise<void>;
  focusShelf(): void;
}

interface AutoImportController {
  bindEvents(eventApi: LegacyEventApi): void;
  start(reason?: string): Promise<void>;
}

interface BookInfoPanelController {
  readonly elements: { readonly title: HTMLInputElement };
  configure(options: {
    readonly onRating: (rating: number) => void;
    readonly onTitle: (title: string) => Promise<void>;
    readonly onDescription: (description: string) => void;
    readonly onAction: (action: string) => Promise<void>;
  }): void;
  render(book: BookRecord): void;
  renderCover(book: BookRecord | undefined): void;
  setLoading(): void;
  setError(error: unknown): void;
}

interface BookOrganizationController {
  open(id: string, book?: BookRecord): void;
  openBooklist?(name: string): void;
  openManager(field: "tags" | "collections"): void;
}

interface BookInfoRelatedController {
  openSimilar(id: string, book?: BookRecord): void | Promise<void>;
  openTimeline(id: string): void | Promise<void>;
}

interface BookOrganizationInitOptions extends UnknownRecord {
  readonly onBooksChanged: (list: unknown) => void;
  readonly openBooklist: (name: string) => void;
  readonly alertAction: (message: string) => void;
}

interface BookInfoRelatedMountOptions extends UnknownRecord {
  readonly coverColor: (title: unknown) => string;
  readonly onOpenBook: (book: BookRecord) => void;
}

interface DialogUi {
  alert?(message: string, options?: UnknownRecord): Promise<unknown>;
  confirm?(message: string, options?: UnknownRecord): Promise<boolean>;
}

interface MainAppRuntime extends Window, UnknownRecord {
  readonly document: Document;
  readonly localStorage: Storage;
  readonly ReaderSyncUI: {
    init(options: SyncInitOptions): SyncController;
  };
  readonly ReaderShelfUI: {
    init(options: ShelfInitOptions): ShelfController;
    render(list: unknown): void;
  };
  readonly ReaderAboutUI: {
    init(options: AboutInitOptions): { checkUpdate(force: boolean): Promise<void> };
  };
  readonly ReaderStatsUI: { init(options: StatsInitOptions): unknown };
  readonly ReaderAutoImportUI: {
    create(options: AutoImportCreateOptions): AutoImportController;
  };
  readonly ReaderAppI18n?: {
    populate(element: HTMLSelectElement): void;
    setLanguage(language: string): void;
    t?(key: string): string;
  };
  readonly ReaderApiSettingsUI?: { init(options: UnknownRecord): unknown };
  readonly ReaderToolbarSettingsUI?: { init(options: UnknownRecord): unknown };
  readonly ReaderBookClassificationSettingsUI?: { init(options: UnknownRecord): unknown };
  readonly ReaderBooklistSettingsUI?: { init(options: UnknownRecord): unknown };
  readonly ReaderRecoverySettings?: { flush?(force: boolean): Promise<unknown> };
  readonly ReaderSemanticUI: { init(options: UnknownRecord): unknown };
  readonly ReaderSemanticStatusCache: unknown;
  readonly ReaderStartupEnhancement?: {
    backgroundWorkAllowed?(): boolean;
    highCostRetryDelay?(): number;
  };
  readonly ReaderBookInfoPanel: {
    mount(options: UnknownRecord): BookInfoPanelController;
  };
  readonly ReaderBookOrganizationUI: {
    init(options: BookOrganizationInitOptions): BookOrganizationController;
  };
  readonly ReaderBookInfoRelated: {
    mount(options: BookInfoRelatedMountOptions): BookInfoRelatedController;
  };
  readonly AppNotice: {
    show(message: string, options?: UnknownRecord): void;
  };
  readonly AppDialog?: DialogUi;
  ReaderBookInfo?: Readonly<{
    hasSingleSelected(): boolean;
    openById(id: unknown): Promise<void>;
    openSelected(): Promise<void>;
  }>;
  clearCrossReturnMemory?: () => void;
  closeSearch(clear: boolean): void;
  hideHistory(): void;
  startupPerfStart(name: string, detail: string): (detail: string) => void;
  startupPerfLog(name: string, phase: string, detail: string): void;
  startupTimed<TResult>(
    name: string,
    work: () => Promise<TResult>,
    detail: unknown,
  ): Promise<TResult>;
  recordNativeStartupMilestone(name: string): void;
}

interface MainAppController {
  readonly clearCrossReturnMemory: () => void;
  readonly openCommonSettings: () => void;
  readonly openSelectedBookInfo: () => Promise<void>;
}

interface MainFloaterOptions {
  readonly keepMenu?: boolean;
  readonly keepFilter?: boolean;
  readonly keepAccount?: boolean;
  readonly keepSearch?: boolean;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

function runtimeFrom(value: unknown): MainAppRuntime | null {
  const candidate = record(value);
  return candidate && record(candidate.document) && record(candidate.localStorage)
    ? (candidate as unknown as MainAppRuntime)
    : null;
}

function errorMessage(error: unknown): string {
  const detail = record(error);
  return detail?.message ? String(detail.message) : String(error);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function books(value: unknown): BookRecord[] {
  return Array.isArray(value) ? value.filter((item): item is BookRecord => record(item) !== null) : [];
}

function dictionaries(value: unknown): ExternalDictionary[] {
  return Array.isArray(value)
    ? value.filter((item): item is ExternalDictionary => record(item) !== null && "id" in item)
    : [];
}

function recoveryStatus(value: unknown): RecoveryBackupStatus {
  return record(value) ? (value as RecoveryBackupStatus) : {};
}

function autoImportSettings(value: unknown, fallback: AutoImportSettings): AutoImportSettings {
  const item = record(value);
  return item
    ? { enabled: item.enabled === true, dirs: strings(item.dirs) }
    : fallback;
}

export function installMainApp(target: unknown = globalThis): MainAppController | null {
const runtime = runtimeFrom(target);
if (!runtime) return null;
const window = runtime;
const document = runtime.document as MainDocument;
const localStorage = runtime.localStorage;
const closeSearch = runtime.closeSearch.bind(runtime);
const hideHistory = runtime.hideHistory.bind(runtime);
const startupPerfStart = runtime.startupPerfStart.bind(runtime);
const startupPerfLog = runtime.startupPerfLog.bind(runtime);
const startupTimed = runtime.startupTimed.bind(runtime);
const recordNativeStartupMilestone = runtime.recordNativeStartupMilestone.bind(runtime);
const transport = transportFromTauriGlobal(runtime);
const invoke: LegacyInvoke = (command, args) => transport.invoke(command, args);
const dialog = dialogsFromTauriGlobal(runtime);
const tauriEvent: LegacyEventApi | null = transport.listen
  ? {
      listen<TEvent extends keyof MainEvents & string>(
        event: TEvent,
        handler: (event: TauriEvent<MainEvents[TEvent]>) => void,
      ) {
        return transport.listen!(event, handler);
      },
    }
  : null;
if (!tauriEvent) throw new Error("Tauri event.listen is unavailable.");

// 书架页逻辑

window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单

// 禁用浏览器自带查找（Ctrl+F / F3）
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");
document.getElementById("search-clear");
const toolbarEl = document.querySelector(".toolbar");

const syncUI = window.ReaderSyncUI.init({
  root: document,
  transport,
  menuElement: menuEl,
  filterPanel,
  storage: window.localStorage,
  renderShelf: (list) => window.ReaderShelfUI.render(list),
});
const aboutUI = window.ReaderAboutUI.init({
  root: document,
  invoke,
  storage: window.localStorage,
  menuElement: menuEl,
  alertAction: (message) => window.AppNotice.show(message, { duration: 7200 }),
});
const shelfUI = window.ReaderShelfUI.init({
  root: document,
  invoke,
  dialog,
  menuElement: menuEl,
  filterPanel,
  storage: window.localStorage,
  closeAccountPanel: () => syncUI.close(),
  closeSearch: (clear) => closeSearch(clear),
  clearCrossReturnMemory: () => clearCrossReturnMemory(),
  startPerformance: (name, detail) => startupPerfStart(name, detail),
  confirmAction: (message) => window.confirm(message),
  alertAction: (message, options) => window.AppNotice.show(message, options),
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
});
window.ReaderStatsUI.init({
  root: document,
  invoke,
  menuElement: menuEl,
  filterPanel,
  storage: window.localStorage,
  closeAccountPanel: () => syncUI.close(),
  closeSearch: (clear) => closeSearch(clear),
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
});

function clearCrossReturnMemory() {
  try {
    localStorage.removeItem("crossReturnState");
    localStorage.removeItem("pendingCrossSearch");
  } catch {}
}
window.clearCrossReturnMemory = clearCrossReturnMemory;
// 应用重新启动进入书架时，跨书搜索的回跳记忆不应继续保留。
clearCrossReturnMemory();

let mainWindowRevealed = false;
function revealMainWindowAfterFirstPaint() {
  if (mainWindowRevealed) return;
  mainWindowRevealed = true;
  // macOS does not necessarily dispatch rAF while a WebView window is hidden.
  // Do not make the native reveal depend on a frame from the hidden window:
  // a login-background launch must stay hidden by Rust policy, while a regular
  // cold launch must be able to reveal itself without requiring a second click.
  invoke("main_window_show").catch((error) => {
    startupPerfLog(
      "main-window-show",
      "error",
      errorMessage(error),
    );
  });
}

function debugSettingOn(key: string): boolean {
  try {
    const settings = record(JSON.parse(localStorage.getItem("debugSettingsV1") || "{}")) ?? {};
    return settings[key] !== false;
  } catch {
    return true;
  }
}

function closeMainFloaters(options: MainFloaterOptions = {}) {
  if (!options.keepMenu) menuEl.classList.remove("show");
  if (!options.keepFilter) filterPanel.classList.remove("show");
  if (!options.keepAccount) syncUI.close();
  if (!options.keepSearch) {
    hideHistory();
    if (!searchInput.value.trim() && !shelfUI.getSearchQuery()) {
      searchWrap.classList.remove("open");
      searchInput.blur();
    }
  }
}

toolbarEl?.addEventListener("pointerdown", (e) => {
  if (e.target instanceof Element && e.target.closest(".account-wrap,.search-wrap,.filter-wrap,.menu-wrap,.window-controls,.del-group")) return;
  closeMainFloaters();
}, true);

function runWhenNoReader<TResult>(name: string, work: () => Promise<TResult>, retryMs = 30000): void {
  if (!window.ReaderStartupEnhancement?.backgroundWorkAllowed?.()) {
    const delay = window.ReaderStartupEnhancement?.highCostRetryDelay?.() || 0;
    if (delay > 0) setTimeout(() => runWhenNoReader(name, work, retryMs), delay);
    return;
  }
  invoke("reader_window_open")
    .then((open) => {
      if (open) {
        startupPerfLog(name, "paused", "reader window open");
        setTimeout(() => runWhenNoReader(name, work, retryMs), retryMs);
        return;
      }
      return startupTimed(name, work, "background");
    })
    .catch(() => {});
}

// 书架筛选、排序与评分控件由 ReaderShelfUI 管理。
// ---- “我的书架”设置：封面进度开关 + 自动导入目录（多目录） ----
let autoImport: AutoImportSettings = { enabled: false, dirs: [] };
const setAutoChk = document.getElementById("set-auto-import");
const importDirsModal = document.getElementById("import-dirs-modal");
const dirsListEl = document.getElementById("dirs-list");
const dirsStatusEl = document.getElementById("dirs-status");
const dirsGearBtn = document.getElementById("dirs-gear");
const importDirsCloseBtn = document.getElementById("import-dirs-close");
const dirsAddBtn = document.getElementById("dirs-add");
let autoImportToggleBusy = false;
function setDirsStatus(text = "", kind: StatusKind = "") {
  if (!dirsStatusEl) return;
  dirsStatusEl.textContent = text || "";
  dirsStatusEl.className = "ai-status" + (kind ? " " + kind : "");
}
function renderDirsList() {
  dirsListEl.innerHTML = "";
  if (!autoImport.dirs.length) {
    const e = document.createElement("div");
    e.className = "dirs-empty";
    e.textContent = "还没有添加目录";
    dirsListEl.appendChild(e);
    return;
  }
  autoImport.dirs.forEach((d) => {
    const row = document.createElement("div");
    row.className = "dir-item";
    const p = document.createElement("span");
    p.className = "dir-path";
    p.textContent = d;
    const del = document.createElement("button");
    del.className = "dir-del";
    del.textContent = "✕";
    del.title = "移除该目录";
    del.addEventListener("click", async () => {
      autoImport.dirs = autoImport.dirs.filter((x) => x !== d);
      reflectAutoImport();
      setDirsStatus("目录已移除，正在保存…", "busy");
      await applyAutoImport(autoImport.enabled, { scan: false });
    });
    row.append(p, del);
    dirsListEl.appendChild(row);
  });
}
function reflectAutoImport() {
  setAutoChk.checked = !!autoImport.enabled;
  renderDirsList();
}
const autoImportUI = window.ReaderAutoImportUI.create({
  invoke,
  isEnabled: () => autoImport.enabled,
  getDirs: () => autoImport.dirs,
  countShelf: () => shelfUI.count(),
  renderShelf: (list) => shelfUI.render(list),
  setStatus: setDirsStatus,
  startPerformance: startupPerfStart,
  logPerformance: startupPerfLog,
  afterAdded: () => {
    if (debugSettingOn("bg_fulltext_index")) {
      setTimeout(() => runWhenNoReader("keyword-index-after-import", () => invoke("build_shelf_index")), 1500);
    }
  },
});
function startAutoImportScan(reason = "正在扫描并导入目录…") {
  return autoImportUI.start(reason);
}
// 自动导入开关
async function setAutoImportEnabled(enabled: boolean, opts: AutoImportApplyOptions = {}): Promise<void> {
  if (autoImportToggleBusy) return;
  autoImportToggleBusy = true;
  const prev = !!autoImport.enabled;
  autoImport.enabled = enabled;
  reflectAutoImport();
  try {
    await applyAutoImport(enabled, Object.assign({
      scan: enabled && autoImport.dirs.length > 0,
      reason: "正在扫描并导入目录…",
      status: enabled ? "自动导入已开启" : "自动导入已关闭",
    }, opts));
  } catch {
    autoImport.enabled = prev;
    reflectAutoImport();
  } finally {
    autoImportToggleBusy = false;
  }
}
setAutoChk.addEventListener("change", async () => {
  await setAutoImportEnabled(setAutoChk.checked);
});
// 把当前 enabled + dirs 提交后端；扫描导入单独走后台，避免设置窗口卡住。
async function applyAutoImport(enabled: boolean, opts: AutoImportApplyOptions = {}): Promise<void> {
  try {
    const cfg = await invoke("set_auto_import", { enabled, dirs: autoImport.dirs });
    autoImport = autoImportSettings(cfg, { enabled, dirs: autoImport.dirs });
    reflectAutoImport();
    setDirsStatus(opts.status || "目录设置已保存", "ok");
    if (opts.scan && autoImport.enabled && autoImport.dirs.length) {
      startAutoImportScan(opts.reason || "正在扫描并导入目录…");
    }
  } catch (e) {
    setDirsStatus("保存目录设置失败：" + e, "error");
    alert("设置自动导入失败：" + e);
    reflectAutoImport();
    throw e;
  }
}
async function addImportDirs() {
  const sel = await dialog.open({ directory: true, multiple: true });
  if (!sel) return;
  const arr = Array.isArray(sel) ? sel : [sel];
  let added = false;
  for (const d of arr) {
    if (d && !autoImport.dirs.includes(d)) {
      autoImport.dirs.push(d);
      added = true;
    }
  }
  if (added) {
    reflectAutoImport();
    setDirsStatus("目录已添加，正在保存…", "busy");
    await applyAutoImport(autoImport.enabled, {
      scan: autoImport.enabled,
      reason: "正在扫描新目录…",
    });
  }
}
function openImportDirsSettings() {
  reflectAutoImport();
  setDirsStatus("");
  importDirsModal.classList.add("show");
}
if (dirsGearBtn) {
  dirsGearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openImportDirsSettings();
  });
}
if (importDirsCloseBtn) {
  importDirsCloseBtn.addEventListener("click", () => importDirsModal.classList.remove("show"));
}
if (importDirsModal) {
  importDirsModal.addEventListener("click", (e) => {
    if (e.target === importDirsModal) importDirsModal.classList.remove("show");
  });
}
if (dirsAddBtn) {
  dirsAddBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await addImportDirs();
  });
}
// 工具栏齿轮 → 打开“常用设置”弹窗
const fpSettingsModal = document.getElementById("fp-settings-modal");
const recoveryBackupStatus = document.getElementById("recovery-backup-status");
const recoveryBackupButton = document.getElementById("settings-create-backup");
const recoveryBackupActions = document.getElementById("recovery-backup-actions");
const recoveryBackupSelect = document.getElementById("settings-restore-backup");
const restoreRecoveryBackupButton = document.getElementById("settings-restore-backup-button");
const appLanguageSelect = document.getElementById("set-app-language") as unknown as HTMLSelectElement;
window.ReaderAppI18n?.populate(appLanguageSelect);
appLanguageSelect?.addEventListener("change", () => window.ReaderAppI18n?.setLanguage(appLanguageSelect.value));
window.ReaderApiSettingsUI?.init({ invoke });
window.ReaderToolbarSettingsUI?.init({ invoke });
window.ReaderBookClassificationSettingsUI?.init({ invoke });
window.ReaderBooklistSettingsUI?.init({ invoke });
const appText = (
  key: string,
  fallback: string,
  values: Readonly<Record<string, unknown>> = {},
): string => (window.ReaderAppI18n?.t?.(key) || fallback).replace(
  /\{(\w+)\}/g,
  (_match: string, name: string) => String(values[name] ?? ""),
);
let lastRecoveryBackupStatus: RecoveryBackupStatus | null = null;
function backupBytes(value: unknown): string {
  const bytes = Number(value) || 0;
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}
function renderRecoveryBackupStatus(value: unknown): void {
  const status = recoveryStatus(value);
  if (!recoveryBackupStatus) return;
  lastRecoveryBackupStatus = status;
  recoveryBackupStatus.textContent = status.count
    ? appText("recoveryStatus", "已保留 {count} 个恢复点，共 {size}；最近一次 {latest}。每日自动创建，最多保留 7 个。", { count: status.count, size: backupBytes(status.total_bytes), latest: status.latest })
    : appText("recoveryEmpty", "尚无恢复点；软件会每日自动创建，最多保留 7 个。");
  recoveryBackupStatus.title = String(status.directory || "");
  const backups = Array.isArray(status.backups) ? status.backups : [];
  if (recoveryBackupActions) recoveryBackupActions.hidden = backups.length === 0;
  if (recoveryBackupSelect) {
    const selected = recoveryBackupSelect.value;
    recoveryBackupSelect.replaceChildren(...backups.map((backup) => {
      const option = document.createElement("option");
      option.value = String(backup.id);
      option.textContent = appText("recoveryOption", "恢复点 {created}（{size}）", { created: backup.created_at || backup.id, size: backupBytes(backup.total_bytes) });
      return option;
    }));
    if (backups.some((backup) => backup.id === selected)) recoveryBackupSelect.value = selected;
  }
  if (restoreRecoveryBackupButton) restoreRecoveryBackupButton.disabled = backups.length === 0;
}
async function refreshRecoveryBackupStatus() {
  renderRecoveryBackupStatus(await invoke("recovery_backup_status"));
}
function openCommonSettings() {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  syncUI.close();
  closeSearch(true);
  fpSettingsModal.classList.add("show");
  refreshRecoveryBackupStatus().catch((e) => {
    if (recoveryBackupStatus) recoveryBackupStatus.textContent = appText("recoveryReadFailed", "恢复点状态读取失败：{error}", { error: e });
  });
}
document.getElementById("settings-toolbar-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openCommonSettings();
});
recoveryBackupButton?.addEventListener("click", async () => {
  recoveryBackupButton.disabled = true;
  recoveryBackupButton.textContent = appText("recoveryCreating", "正在创建…");
  try {
    await window.ReaderRecoverySettings?.flush?.(true);
    const status = await invoke("create_recovery_backup");
    renderRecoveryBackupStatus(status);
  } catch (e) {
    await window.AppDialog?.alert?.(errorMessage(e), {
      title: appText("recoveryCreateFailedTitle", "创建恢复点失败"),
      confirmLabel: appText("close", "关闭"),
      tone: "error",
    });
  } finally {
    recoveryBackupButton.disabled = false;
    recoveryBackupButton.textContent = appText("recoveryCreateShort", "创建");
  }
});
restoreRecoveryBackupButton?.addEventListener("click", async () => {
  const backupId = recoveryBackupSelect?.value;
  if (!backupId) return;
  const choice = recoveryBackupSelect.options[recoveryBackupSelect.selectedIndex]?.textContent || backupId;
  const confirmed = await window.AppDialog?.confirm?.(
    choice + "\n\n" + appText("recoveryConfirmMessage", "软件会先自动创建当前数据的保护恢复点，再恢复书架、阅读数据、软件设置、手势和阅读背景图。请先关闭所有阅读窗口。"),
    {
      title: appText("recoveryConfirmTitle", "恢复这个恢复点？"),
      confirmLabel: appText("recoveryConfirmAction", "恢复"),
      cancelLabel: appText("recoveryDialogCancel", "取消"),
      tone: "warning",
    },
  );
  if (!confirmed) return;
  restoreRecoveryBackupButton.disabled = true;
  restoreRecoveryBackupButton.textContent = appText("recoveryRestoring", "正在恢复…");
  try {
    const status = await invoke("restore_recovery_backup", { backupId });
    renderRecoveryBackupStatus(status);
    await refreshRecoveryBackupStatus();
    await window.AppDialog?.alert?.(appText("recoverySucceededMessage", "数据已恢复，书架将重新加载。"), {
      title: appText("recoverySucceededTitle", "恢复完成"),
      confirmLabel: appText("confirm", "确定"),
      tone: "success",
    });
    window.location.reload();
  } catch (e) {
    await window.AppDialog?.alert?.(errorMessage(e), {
      title: appText("recoveryFailedTitle", "恢复失败"),
      confirmLabel: appText("close", "关闭"),
      tone: "error",
    });
  } finally {
    restoreRecoveryBackupButton.disabled = false;
    restoreRecoveryBackupButton.textContent = appText("recoverySelected", "恢复选中恢复点");
  }
});
window.addEventListener("app-language-changed", () => { if (lastRecoveryBackupStatus) renderRecoveryBackupStatus(lastRecoveryBackupStatus); });
document.getElementById("open-default-apps-settings")?.addEventListener("click", async () => {
  try {
    const message = await invoke("open_default_apps_settings");
    window.AppNotice?.show(
      String(message || appText("defaultOpenToast", "默认打开方式已更新。")),
      { variant: "text", duration: 1500 },
    );
  } catch (e) {
    window.AppNotice?.show(
      appText("defaultOpenFailed", "打开 Windows 默认应用设置失败：{error}", { error: errorMessage(e) }),
      { variant: "text", duration: 1500 },
    );
  }
});
fpSettingsModal.addEventListener("click", (e) => {
  if (e.target === fpSettingsModal) fpSettingsModal.classList.remove("show");
});
// 语义设置由独立模块管理；这里只注入书架应用拥有的依赖。
window.ReaderSemanticUI.init({
  root: document,
  invoke,
  settingsModal: fpSettingsModal,
  cache: window.ReaderSemanticStatusCache,
  confirmAction: (message: string) => window.confirm(message),
});
// ---- 主设置页：外置词典 ----
const externalDictModal = document.getElementById("external-dict-modal");
const externalDictGear = document.getElementById("dict-gear");
const externalDictClose = document.getElementById("external-dict-close");
const externalDictAdd = document.getElementById("external-dict-add");
const externalDictList = document.getElementById("external-dict-list");
const externalDictStatus = document.getElementById("external-dict-status");
let externalDicts: ExternalDictionary[] = [];

function setExternalDictStatus(text = "", kind: StatusKind = "") {
  if (!externalDictStatus) return;
  externalDictStatus.textContent = text || "";
  externalDictStatus.className = "ai-status" + (kind ? " " + kind : "");
}

function dictFormatBytes(value: unknown): string {
  const n = Number(value || 0);
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n ? n + " B" : "0 B";
}

function renderExternalDicts(list: unknown = externalDicts): void {
  externalDicts = dictionaries(list);
  if (!externalDictList) return;
  externalDictList.innerHTML = "";
  if (!externalDicts.length) {
    externalDictList.innerHTML = '<div class="dict-empty">还没有外置词典。添加后会优先于内置词典查询。</div>';
    return;
  }
  externalDicts.forEach((d, idx) => {
    const item = document.createElement("div");
    item.className = "dict-item";
    const main = document.createElement("div");
    const name = document.createElement("div");
    name.className = "dict-name";
    name.textContent = String(d.name || "未命名词典");
    const meta = document.createElement("div");
    meta.className = "dict-meta";
    meta.textContent = [
      d.lang === "zh" ? "中文" : "英文",
      d.format || "词典",
      (d.entry_count || 0) + " 词条",
      dictFormatBytes(d.size_bytes),
    ].join(" · ");
    const path = document.createElement("div");
    path.className = "dict-meta";
    path.textContent = String(d.source_path || "");
    main.append(name, meta, path);

    const actions = document.createElement("div");
    actions.className = "dict-actions";
    const enable = document.createElement("label");
    enable.className = "switch";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = !!d.enabled;
    const slider = document.createElement("span");
    slider.className = "slider";
    enable.append(chk, slider);
    chk.addEventListener("change", async () => {
      setExternalDictStatus("正在更新词典状态…", "busy");
      try {
        renderExternalDicts(await invoke("external_dict_set_enabled", { id: d.id, enabled: chk.checked }));
        setExternalDictStatus("词典状态已更新", "ok");
      } catch (e) {
        chk.checked = !chk.checked;
        setExternalDictStatus("更新词典状态失败：" + e, "error");
      }
    });
    const up = document.createElement("button");
    up.className = "btn-plain";
    up.textContent = "↑";
    up.title = "提高优先级";
    up.disabled = idx === 0;
    up.addEventListener("click", async () => {
      renderExternalDicts(await invoke("external_dict_move_priority", { id: d.id, dir: -1 }));
    });
    const down = document.createElement("button");
    down.className = "btn-plain";
    down.textContent = "↓";
    down.title = "降低优先级";
    down.disabled = idx === externalDicts.length - 1;
    down.addEventListener("click", async () => {
      renderExternalDicts(await invoke("external_dict_move_priority", { id: d.id, dir: 1 }));
    });
    const del = document.createElement("button");
    del.className = "btn-plain danger-lite";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm("确定删除词典「" + (d.name || "未命名词典") + "」？")) return;
      setExternalDictStatus("正在删除词典…", "busy");
      try {
        renderExternalDicts(await invoke("external_dict_delete", { id: d.id }));
        setExternalDictStatus("词典已删除", "ok");
      } catch (e) {
        setExternalDictStatus("删除词典失败：" + e, "error");
      }
    });
    actions.append(enable, up, down, del);
    item.append(main, actions);
    externalDictList.appendChild(item);
  });
}

async function refreshExternalDicts() {
  try {
    renderExternalDicts(await invoke("external_dict_list"));
  } catch (e) {
    setExternalDictStatus("读取词典列表失败：" + e, "error");
  }
}

function openExternalDictSettings() {
  externalDictModal.classList.add("show");
  setExternalDictStatus("");
  refreshExternalDicts();
}

function closeExternalDictSettings() {
  externalDictModal.classList.remove("show");
  fpSettingsModal.classList.add("show");
}

externalDictGear?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openExternalDictSettings();
});
externalDictClose?.addEventListener("click", closeExternalDictSettings);
externalDictModal?.addEventListener("click", (e) => {
  if (e.target === externalDictModal) closeExternalDictSettings();
});
externalDictAdd?.addEventListener("click", async () => {
  const sel = await dialog.open({
    multiple: true,
    filters: [
      { name: "词典", extensions: ["tsv", "csv", "json", "ifo", "idx", "dict", "dz", "mdx", "mdd"] },
    ],
  });
  if (!sel) return;
  const paths = Array.isArray(sel) ? sel : [sel];
  setExternalDictStatus("正在导入词典…", "busy");
  try {
    renderExternalDicts(await invoke("external_dict_import", { paths }));
    setExternalDictStatus("词典已导入", "ok");
  } catch (e) {
    setExternalDictStatus("导入词典失败：" + e, "error");
  }
});
// 书架布局与列数设置由 ReaderShelfUI 管理。
let importStatusEl: HTMLElement | null = null;
let importStatusTimer = 0;
function ensureImportStatus(): HTMLElement {
  if (importStatusEl) return importStatusEl;
  importStatusEl = document.createElement("div");
  importStatusEl.className = "import-status";
  document.body.appendChild(importStatusEl);
  return importStatusEl;
}
function setImportStatus(text: string, kind: StatusKind = "busy"): void {
  const el = ensureImportStatus();
  window.clearTimeout(importStatusTimer);
  el.className = "import-status show " + kind;
  el.textContent = text || "";
}
function hideImportStatus(delay = 0): void {
  window.clearTimeout(importStatusTimer);
  importStatusTimer = window.setTimeout(() => {
    if (importStatusEl) importStatusEl.classList.remove("show");
  }, delay);
}
async function importBookPaths(input: unknown): Promise<BookRecord[] | null | undefined> {
  const paths = strings(input);
  if (!paths.length) return;
  const shelfWasEmpty = shelfUI.count() === 0;
  setImportStatus("准备导入 " + paths.length + " 本书...", "busy");
  try {
    const list = books(await startupTimed("manual-import", () => invoke("add_books", { paths }), paths.length + " files"));
    setImportStatus("正在刷新书架...", "busy");
    shelfUI.render(list);
    const shouldShowOpenHint = shelfWasEmpty && (list || []).length > 0 && localStorage.getItem("shelfClickOpenHintSeen") !== "1";
    if (shouldShowOpenHint) localStorage.setItem("shelfClickOpenHintSeen", "1");
    setImportStatus(shouldShowOpenHint ? "导入完成。单击打开图书；双击选中图书" : "导入完成，共 " + paths.length + " 个文件", "ok");
    hideImportStatus(shouldShowOpenHint ? 5200 : 3200);
    if (debugSettingOn("bg_fulltext_index")) {
      runWhenNoReader("keyword-index-after-import", () => invoke("build_shelf_index")); // 后台为新书建检索索引
    }
    return list;
  } catch (e) {
    setImportStatus("导入失败：" + errorMessage(e), "error");
    hideImportStatus(7000);
    return null;
  }
}
let associatedBookOpenQueue: Promise<void> = Promise.resolve();
function normalizeBookPath(path: unknown): string {
  return String(path || "").replace(/\//g, "\\").toLocaleLowerCase();
}
async function openAssociatedBookPaths(input: unknown): Promise<void> {
  const paths = strings(input).filter((path) => SUPPORTED.test(String(path || "")));
  if (!paths.length) return;
  const list = await importBookPaths(paths);
  if (!Array.isArray(list)) return;
  const wanted = new Set(paths.map(normalizeBookPath));
  const book = list.find((item) => wanted.has(normalizeBookPath(item.path)));
  if (book) await invoke("open_book", { id: String(book.id) });
}
function enqueueAssociatedBookOpen(paths: unknown): Promise<void> {
  associatedBookOpenQueue = associatedBookOpenQueue
    .then(() => openAssociatedBookPaths(paths))
    .catch((e) => setImportStatus("打开文件失败：" + errorMessage(e), "error"));
  return associatedBookOpenQueue;
}
async function importBooks() {
  const sel = await dialog.open({
    multiple: true,
    filters: [{ name: "电子书", extensions: ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }],
  });
  if (!sel) return;
  const paths = Array.isArray(sel) ? sel : [sel];
  await importBookPaths(paths);
}
async function exportDataPackage() {
  const path = await dialog.save({
    defaultPath: "kunpeng-reader-data.json",
    filters: [{ name: "鲲鹏阅读器数据包", extensions: ["json"] }],
  });
  if (!path) return;
  await invoke("export_data_package", { path });
  alert("数据包已导出。");
}

async function importDataPackage() {
  const path = await dialog.open({
    multiple: false,
    filters: [{ name: "鲲鹏阅读器数据包", extensions: ["json"] }],
  });
  if (!path) return;
  const count = await invoke("import_data_package", { path });
  alert("已创建导入前恢复点，并导入 " + count + " 条同步数据。数据已立即合并到当前书架。");
}

// 三点菜单
document.getElementById("menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  filterPanel.classList.remove("show");
  syncUI.close();
  closeSearch(true);
  menuEl.classList.toggle("show");
});
document.addEventListener("click", () => {
  closeMainFloaters();
});
document.getElementById("mi-import").addEventListener("click", () => {
  menuEl.classList.remove("show");
  importBooks();
});
document.getElementById("settings-export-data").addEventListener("click", () => {
  exportDataPackage().catch((e) => alert("导出数据包失败：" + e));
});
document.getElementById("settings-import-data").addEventListener("click", () => {
  importDataPackage().catch((e) => alert("导入数据包失败：" + e));
});

// ---- 通用 HTML 转义 ----
function escapeHtml(s: string): string {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return (s || "").replace(/[&<>]/g, (c) => replacements[c] ?? c);
}
// ---- 笔记汇总 ----
const notesModal = document.getElementById("notes-modal");
const notesBody = document.getElementById("notes-body");
let notesData: BookNotes[] = [];
function renderNotes(data: readonly BookNotes[]): void {
  if (!data.length) {
    notesBody.innerHTML = '<div class="stats-empty">还没有高亮、批注或可关联的查词记录</div>';
    return;
  }
  notesBody.innerHTML = data.map((book) => {
    const highlightItems = book.highlights || [];
    const vocabItems = book.vocab || [];
    const highlights = highlightItems.map((h) => (
      '<div class="note-item">' +
      '<div class="note-text">' + escapeHtml(h.text || "") + "</div>" +
      (h.context ? '<div class="note-context">' + escapeHtml(h.context) + "</div>" : "") +
      (h.note ? '<div class="note-note">' + escapeHtml(h.note) + "</div>" : "") +
      "</div>"
    )).join("");
    const words = vocabItems.map((v) => (
      '<span class="note-word">' + escapeHtml(v.word || "") + (v.count ? " ×" + v.count : "") + "</span>"
    )).join("");
    const totalItems = highlightItems.length + vocabItems.length;
    return (
      '<section class="note-book">' +
      '<div class="note-book-head"><h3>' + escapeHtml(book.title || "未命名书籍") + '</h3><span class="note-book-count">' + totalItems + " 条</span></div>" +
      (highlights ? '<div class="note-sec"><h4>高亮 / 批注</h4>' + highlights + "</div>" : "") +
      (words ? '<div class="note-sec"><h4>查词</h4><div class="note-vocab">' + words + "</div></div>" : "") +
      "</section>"
    );
  }).join("");
}
function notesToMarkdown(data: readonly BookNotes[]): string {
  let md = "# 书籍笔记汇总\n\n";
  data.forEach((book) => {
    md += "## " + (book.title || "未命名书籍") + "\n\n";
    if ((book.highlights || []).length) {
      md += "### 高亮 / 批注\n\n";
      (book.highlights || []).forEach((h) => {
        md += "- " + (h.text || "").replace(/\s+/g, " ").trim() + "\n";
        if (h.context) md += "  - 上下文：" + h.context.replace(/\s+/g, " ").trim() + "\n";
        if (h.note) md += "  - 批注：" + h.note.replace(/\s+/g, " ").trim() + "\n";
      });
      md += "\n";
    }
    if ((book.vocab || []).length) {
      md += "### 查词\n\n";
      (book.vocab || []).forEach((v) => {
        md += "- " + (v.word || "") + (v.count ? " ×" + v.count : "") + (v.def ? "：" + v.def : "") + "\n";
      });
      md += "\n";
    }
  });
  return md;
}
document.getElementById("mi-notes").addEventListener("click", async () => {
  menuEl.classList.remove("show");
  notesModal.classList.add("show");
  notesBody.innerHTML = '<div class="stats-empty">正在汇总…</div>';
  try {
    notesData = books(await invoke("notes_summary")) as BookNotes[];
    renderNotes(notesData);
  } catch (e) {
    notesBody.innerHTML = '<div class="stats-empty">读取失败：' + escapeHtml(String(e)) + "</div>";
  }
});
const libraryHealthModal = document.getElementById("library-health-modal");
const libraryHealthBody = document.getElementById("library-health-body");
function libraryHealthEscape(value: unknown): string {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value || "").replace(/[&<>"']/g, (c) => replacements[c] ?? c);
}
function libraryHealthBytes(value: unknown): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
}function renderLibraryHealth(value: unknown): void {
  const report = (record(value) ?? {}) as LibraryHealthReport;
  const missing = report.missing || [];
  const duplicates = report.duplicates || [];
  const healthStat = (label: string, content: unknown) => `<span class="health-stat"><small>${label}</small><strong>${content}</strong></span>`;
  let html = '<div class="health-summary">' +
    healthStat("书籍", `${report.total || 0} 本`) + healthStat("文件正常", `${report.healthy || 0} 本`) +
    healthStat("失效路径", `${missing.length} 本`) + healthStat("重复组", `${duplicates.length} 组`) + "</div>";
  html += '<section class="health-section"><h4>失效路径</h4>';
  html += missing.length ? missing.map((book) =>
    `<div class="health-row"><div class="health-book"><strong>${libraryHealthEscape(book.title)}</strong><small>${libraryHealthEscape(book.path)}</small></div>` +
    `<button class="btn-plain health-relocate" data-id="${libraryHealthEscape(book.id)}" data-format="${libraryHealthEscape(book.format)}">重新定位…</button></div>`
  ).join("") : '<div class="stats-empty">没有发现失效路径</div>';
  html += '</section><section class="health-section"><h4>重复内容</h4>';
  html += duplicates.length ? duplicates.map((group) =>
    `<div class="health-group"><div class="health-group-title">检测到 ${group.books.length} 个相同内容的条目。合并时会保留可用文件、较新的进度、书签和批注。</div>` +
    group.books.map((book) => `<div class="health-row"><div class="health-book"><strong>${libraryHealthEscape(book.title)}</strong><small>${libraryHealthEscape(book.path)}</small></div></div>`).join("") +
    `<button class="btn-plain health-merge" data-ids="${group.books.map((book) => libraryHealthEscape(book.id)).join(",")}">合并为一条</button>` +
    '</div>'
  ).join("") : '<div class="stats-empty">没有发现重复内容</div>';
  const index: SearchIndexHealth = report.search_index || {};
  html += '</section><section class="health-section"><h4>全文索引与缓存</h4>' +
    '<div class="health-summary health-index-summary">' +
    healthStat("压缩索引", index.binary_files || 0) + healthStat("旧 JSON", index.legacy_files || 0) +
    healthStat("孤儿文件", index.orphan_files || 0) + healthStat("磁盘占用", libraryHealthBytes(index.disk_bytes)) + "</div>" +
    `<div class="health-group-title">内存 LRU：${libraryHealthBytes(index.memory_bytes)} / ${libraryHealthBytes(index.memory_limit_bytes)}，${index.memory_entries || 0} 个缓存条目；磁盘上限 ${libraryHealthBytes(index.disk_limit_bytes)}。</div>` +
    '<button class="btn-plain health-index-clean" type="button">清理孤儿索引并执行配额治理</button></section>';
  libraryHealthBody.innerHTML = html;
  libraryHealthBody.querySelector<HTMLButtonElement>(".health-index-clean")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "正在清理…";
    try {
      await invoke("maintain_search_index");
      await openLibraryHealth();
    } catch (e) {
      alert("索引清理失败：" + e);
      button.disabled = false;
      button.textContent = "清理孤儿索引并执行配额治理";
    }
  });
  libraryHealthBody.querySelectorAll<HTMLButtonElement>(".health-relocate").forEach((button) => {
    button.addEventListener("click", async () => {
      const format = String(button.dataset.format || "").toLowerCase();
      const picked = await dialog.open({ multiple: false, filters: [{ name: "电子书", extensions: format ? [format] : ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      shelfUI.render(await invoke("relocate_book", { id: button.dataset.id, path }));
      await openLibraryHealth();
    });
  });
  libraryHealthBody.querySelectorAll<HTMLButtonElement>(".health-merge").forEach((button) => {
    button.addEventListener("click", async () => {
      const ids = String(button.dataset.ids || "").split(",").filter(Boolean);
      if (ids.length < 2 || !confirm("确认合并这组重复书籍吗？会保留一个书架条目，并合并书签、批注和较新的进度。")) return;
      button.disabled = true;
      try {
        shelfUI.render(await invoke("merge_duplicate_books", { ids }));
        await openLibraryHealth();
      } catch (e) {
        alert("合并失败：" + e);
        button.disabled = false;
      }
    });
  });
}
async function openLibraryHealth() {
  libraryHealthModal.classList.add("show");
  libraryHealthBody.innerHTML = '<div class="stats-empty">正在检查书库文件…</div>';
  try {
    renderLibraryHealth(await invoke("library_health"));
  } catch (e) {
    libraryHealthBody.innerHTML = '<div class="stats-empty">体检失败：' + libraryHealthEscape(e) + '</div>';
  }
}
document.getElementById("mi-library-health").addEventListener("click", () => {
  menuEl.classList.remove("show");
  openLibraryHealth();
});
document.getElementById("library-health-close").addEventListener("click", () => libraryHealthModal.classList.remove("show"));
libraryHealthModal.addEventListener("click", (e) => { if (e.target === libraryHealthModal) libraryHealthModal.classList.remove("show"); });
document.getElementById("notes-export").addEventListener("click", () => {
  const blob = new Blob([notesToMarkdown(notesData)], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "书籍笔记汇总.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
document.getElementById("notes-close").addEventListener("click", () => notesModal.classList.remove("show"));
notesModal.addEventListener("click", (e) => {
  if (e.target === notesModal) notesModal.classList.remove("show");
});

// ---- 拖拽导入 ----
const dropHint = document.getElementById("drop-hint");
const SUPPORTED = /\.(epub|pdf|txt|md|markdown|mobi|azw3|azw)$/i;
autoImportUI.bindEvents(tauriEvent);
tauriEvent.listen("startup-perf", (e) => {
  const p = (e && e.payload) || {};
  startupPerfLog("rust:" + String(p.name || "unknown"), String(p.phase || "mark"), String(p.detail || ""));
});
tauriEvent.listen("shelf-book-read", (e) => shelfUI.updateBook(String(e?.payload?.id || ""), { last_read_at: Number(e?.payload?.lastReadAt || 0) }));
tauriEvent.listen("book-import-progress", (e) => {
  const p = (e && e.payload) || {};
  if (!p.phase) return;
  const total = p.total || 0;
  if (p.phase === "start") {
    setImportStatus("准备导入 " + total + " 本书...", "busy");
  } else if (p.phase === "import") {
    setImportStatus(
      "正在导入 " + (p.processed || 0) + "/" + total + "，已新增 " + (p.added || 0) + " 本" + (p.current ? "：" + p.current : ""),
      "busy"
    );
  } else if (p.phase === "done") {
    setImportStatus("导入完成，新增 " + (p.added || 0) + " 本", "ok");
  }
});
tauriEvent.listen("associated-book-open", (e) => {
  enqueueAssociatedBookOpen((e && e.payload) || []);
});
tauriEvent.listen("tauri://drag-enter", () => dropHint.classList.add("show"));
tauriEvent.listen("tauri://drag-leave", () => dropHint.classList.remove("show"));
tauriEvent.listen("tauri://drag-drop", async (e) => {
  dropHint.classList.remove("show");
  const paths = strings(e.payload?.paths).filter((p) => SUPPORTED.test(p));
  if (paths.length) await importBookPaths(paths);
});
// ---- 单本图书信息与相关内容 ----
const bookInfoBtn = document.getElementById("book-info-btn");
const bookInfoModal = document.getElementById("book-info-modal");
const bookInfoPanel = window.ReaderBookInfoPanel.mount({
  root: document,
  host: bookInfoModal,
  prefix: "book-info",
  coverChangeId: "cover-btn",
  similarId: "similar-books-btn",
  timelineId: "reading-timeline-btn",
});
const bookOrganizationUI = window.ReaderBookOrganizationUI.init({
  root: document,
  invoke,
  getBooks: () => shelfUI.getBooks(),
  onBooksChanged: (list) => shelfUI.render(list),
  openBooklist: (name) => shelfUI.openBooklist(name),
  alertAction: (message) => window.AppNotice.show(message),
});
const bookInfoRelated = window.ReaderBookInfoRelated.mount({
  root: document,
  invoke,
  coverColor: (title) => shelfUI.coverColor(title),
  onOpenBook(book) {
    clearCrossReturnMemory();
    invoke("open_book", { id: book.id }).catch((error) => alert("打开失败：" + error));
  },
});
let currentInfoBookId = "";

async function openBookInfoById(id: unknown): Promise<void> {
  if (!id) return;
  currentInfoBookId = String(id);
  bookInfoModal.classList.add("show");
  bookInfoPanel.render({ ...shelfUI.getBook(currentInfoBookId), word_count: "统计中…" });
  bookInfoPanel.setLoading();
  bookOrganizationUI.open(currentInfoBookId, shelfUI.getBook(currentInfoBookId));
  try {
    const m = record(await invoke("book_meta_by_id", { id: currentInfoBookId })) ?? {};
    const book = shelfUI.getBook(currentInfoBookId) || {};
    // Tauri 的 BookMeta 维持既有 snake_case 序列化；兼容曾短暂使用过的
    // camelCase 前端载荷，避免已分类的暗标签在图书信息里被当成空数组。
    bookOrganizationUI.open(currentInfoBookId, m);
    bookInfoPanel.render({ ...book, ...m, cover: m.cover || book.cover });
  } catch (e) {
    bookInfoPanel.setError(e);
  }
}
function hasSingleSelectedBook() {
  return shelfUI.getSelectedIds().length === 1;
}
async function openSelectedBookInfo() {
  const selectedIds = shelfUI.getSelectedIds();
  if (selectedIds.length !== 1) return;
  return openBookInfoById(selectedIds[0]);
}
window.ReaderBookInfo = Object.freeze({ hasSingleSelected: hasSingleSelectedBook, openById: openBookInfoById, openSelected: openSelectedBookInfo });
tauriEvent.listen("reader-gesture-action", (event) => {
  const payload = event?.payload || {};
  if (!payload.bookId) return;
  window.setTimeout(() => {
    if (payload.action === "book_info") {
      void openBookInfoById(payload.bookId);
    } else if (payload.action === "book_organization") {
      void openBookInfoById(payload.bookId).then(() => bookOrganizationUI.openManager(payload.field === "collections" ? "collections" : "tags"));
    } else if (payload.action === "change_cover") {
      void openBookInfoById(payload.bookId).then(async () => {
        await shelfUI.changeCoverById(currentInfoBookId);
        bookInfoPanel.renderCover(shelfUI.getBook(currentInfoBookId));
      });
    } else if (payload.action === "reading_timeline") {
      void openBookInfoById(payload.bookId).then(() => bookInfoRelated.openTimeline(String(payload.bookId)));
    }
  }, 80);
});bookInfoBtn.addEventListener("click", openSelectedBookInfo);
bookInfoModal.addEventListener("click", (e) => {
  if (e.target === bookInfoModal) bookInfoModal.classList.remove("show");
});
bookInfoPanel.configure({
  onRating(rating) {
    if (!currentInfoBookId) return;
    shelfUI.updateBook(currentInfoBookId, { rating });
    invoke("set_book_rating", { id: currentInfoBookId, rating }).catch(() => {});
  },
  async onTitle(title) {
    if (!currentInfoBookId) return;
    if (!title) {
      bookInfoPanel.elements.title.value = String(shelfUI.getBook(currentInfoBookId)?.title || "");
      return;
    }
    try {
      await invoke("set_book_title", { id: currentInfoBookId, title });
      shelfUI.updateBook(currentInfoBookId, { title });
      bookInfoPanel.renderCover(shelfUI.getBook(currentInfoBookId));
    } catch (error) {
      alert("保存书名失败：" + error);
    }
  },
  onDescription(description) {
    if (!currentInfoBookId) return;
    shelfUI.updateBook(currentInfoBookId, { description });
    invoke("set_book_description", { id: currentInfoBookId, description }).catch(() => {});
  },
  async onAction(action) {
    if (!currentInfoBookId) return;
    if (action === "cover") {
      await shelfUI.changeCoverById(currentInfoBookId);
      bookInfoPanel.renderCover(shelfUI.getBook(currentInfoBookId));
    } else if (action === "tags" || action === "collections") {
      bookOrganizationUI.openManager(action);
    } else if (action === "similar") {
      void bookInfoRelated.openSimilar(currentInfoBookId, shelfUI.getBook(currentInfoBookId));
    } else if (action === "timeline") {
      void bookInfoRelated.openTimeline(currentInfoBookId);
    }
  },
});

// 书架选择、批量删除与焦点刷新由 ReaderShelfUI 管理。
window.addEventListener("DOMContentLoaded", () => {
  // 启动：先用 list_books 快速返回现有书架，让菜单栏立刻可点；旧数据元信息回填延后执行。
    startupPerfLog("startup", "schedule", "critical=list_books+cover-render background=sync/settings/import/index/update");
    startupTimed("shelf-list-books", () => invoke("list_books"), "critical")
      .then((list) => {
        startupPerfLog("shelf-list-books", "data", "books=" + books(list).length);
        shelfUI.render(list);
        requestAnimationFrame(() => requestAnimationFrame(() => recordNativeStartupMilestone("shelf_painted")));
        revealMainWindowAfterFirstPaint();
        // 首屏渲染完成后只聚焦一次书架滚动容器，让 PgUp/PgDn 开箱即用。
        // 后续后台刷新不重复聚焦，避免抢走搜索框或弹窗里的输入焦点。
        requestAnimationFrame(() => shelfUI.focusShelf());
        return invoke("take_startup_book_paths");
      })
      .then((paths) => enqueueAssociatedBookOpen(paths))
      .catch(() => revealMainWindowAfterFirstPaint())
      .finally(() => {
        startupPerfLog("startup", "interactive", "main toolbar should be responsive");
      });
    setTimeout(() => {
      if (!debugSettingOn("bg_cover_preload")) return;
      runWhenNoReader("shelf-books-backfill", () => invoke("shelf_books").then((list) => shelfUI.render(list)));
    }, 10000);
    // 首次全书架搜索不再承担索引冷启动：首屏稳定后在后台补齐缺失的全文索引。
    // build_shelf_index 自身有全局互斥，且 runWhenNoReader 会避免与阅读页争抢资源。
    setTimeout(() => {
      runWhenNoReader("keyword-index-startup", () => invoke("build_shelf_index"));
    }, 8000);
    // 读取自动导入配置并反映到设置面板。真正扫描延后，避免和首屏封面加载抢资源。
    setTimeout(() => {
      // 账号状态始终从 SQLite 恢复；后台开关只控制联网同步，不能让已登录账号看起来丢失。
      startupTimed("sync-settings", async () => {
        await syncUI.loadSettingsOnce();
        if (debugSettingOn("bg_sync")) await syncUI.syncOnStartup();
      }, "background").catch(() => {});
    }, 1200);
    startupTimed("auto-import-config", () => invoke("get_auto_import"), "background")
      .then((c) => { autoImport = autoImportSettings(c, autoImport); reflectAutoImport(); })
      .catch(() => {});
    setTimeout(() => {
      if (!window.ReaderStartupEnhancement?.backgroundWorkAllowed?.() || !autoImport.enabled || !autoImport.dirs || !autoImport.dirs.length) return;
      startAutoImportScan("正在自动扫描导入目录…");
    }, 8000);
    // 字数统计是锦上添花，延后到启动稳定之后。
    setTimeout(() => {
      if (!debugSettingOn("reader_words_detect")) return;
      runWhenNoReader("word-counts", () => invoke("compute_word_counts"));
    }, 25000);
    // 更新检查不阻塞首屏：绑定完 UI 后立刻异步请求本机发布清单。
    // 服务端不可用时后端会短超时后再回退 GitHub，不能再让首屏等待 15 秒。
    setTimeout(() => {
      if (!debugSettingOn("bg_update_check")) return;
      startupTimed("update-check", () => aboutUI.checkUpdate(false), "background").catch(() => {});
    }, 0);
    // “关于”里的版本号取自后端，保持单一来源
    startupTimed("app-version", () => invoke("app_version"), "background")
      .then((v) => {
        const el = document.getElementById("about-ver");
        if (el && v) el.textContent = "v" + String(v).replace(/^v/i, "");
      })
      .catch(() => {});
}, { once: true });

return Object.freeze({
  clearCrossReturnMemory,
  openCommonSettings,
  openSelectedBookInfo,
});
}
