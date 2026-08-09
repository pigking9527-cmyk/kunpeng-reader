const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const uiDir = path.resolve(__dirname, "..");
const syncSource = fs.readFileSync(path.join(uiDir, "sync-ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
const i18nSource = fs.readFileSync(path.join(uiDir, "app-i18n.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(uiDir, "styles.css"), "utf8");

test("sync UI only binds elements that exist in the main page", () => {
  const referencedIds = [...syncSource.matchAll(/getElementById\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  const missingIds = [...new Set(referencedIds)]
    .filter((id) => !indexSource.includes(`id="${id}"`));

  assert.deepEqual(missingIds, []);
});

test("manual sync button has a click handler", () => {
  assert.match(syncSource, /syncNowBtn\.addEventListener\("click",\s*async\s*\(\)\s*=>/);
  assert.match(syncSource, /setSyncButtonState\("syncing", "syncInProgress"\)/);
  assert.match(syncSource, /setSyncButtonState\("ok", "syncSuccess"/);
  assert.match(syncSource, /setSyncButtonState\("fail", "syncFailed"/);
  assert.match(syncSource, /syncStatusEl\.textContent = syncText\("syncFailedDetail"/);
  assert.doesNotMatch(syncSource, /setSyncButtonState\("fail", "同步失败"/);
});

test("private sync explains the 100 plus 100 cloud history policy", () => {
  assert.match(i18nSource, /包括单书与书库问答；云端各保留 100 条/);
});

test("账户概览保留同步执行和额度；同步管理仍在独立页面", () => {
  assert.match(indexSource, /id="sync-now"/);
  assert.match(indexSource, /id="account-storage-value"/);
  assert.match(indexSource, /id="account-daily-value"/);
  assert.match(indexSource, /class="account-center-nav"/);
  assert.match(indexSource, /id="account-tab-sync"/);
  assert.match(indexSource, /id="private-sync-panel"/);
  assert.doesNotMatch(indexSource, /id="private-sync-open"/);
  assert.match(syncSource, /function applyPrivateSyncOverview/);
});

test("同步内容逐项说明真实实体范围并包含书单元数据", () => {
  assert.match(indexSource, /id="account-sync-progress"[\s\S]*?阅读进度、续读位置与阅读时间线/);
  assert.match(indexSource, /id="account-sync-reading-data"[\s\S]*?标签、收藏夹与书单/);
  assert.match(indexSource, /id="account-sync-statistics"[\s\S]*?时长、字数与完成时间/);
  assert.match(indexSource, /id="account-sync-palettes"[\s\S]*?data-i18n="syncPalettes"/);
  assert.match(i18nSource, /syncReadingData:\s*"书签、高亮、批注、评分、标签、收藏夹与书单"/);
  assert.match(i18nSource, /syncPalettes:\s*"自定义阅读主题与背景"/);
});

test("账户概览展示服务端权威的总存储与每日同步额度", () => {
  const overview = indexSource.match(/<section id="account-overview-panel"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(overview, /id="sync-account-name"/);
  assert.match(overview, /id="sync-now"/);
  assert.match(overview, /id="sync-logout"/);
  assert.match(indexSource, /id="account-storage-value"/);
  assert.match(indexSource, /id="account-daily-value"/);
  assert.match(syncSource, /invoke\("auth_usage_status"\)/);
  assert.match(syncSource, /function applyAccountUsage/);
  assert.match(syncSource, /dailyResetAt/);
});

test("账户概览区分立即同步操作与同步服务连通状态", () => {
  assert.match(indexSource, /id="account-overview-sync-state"[^>]*class="account-sync-state checking"[^>]*role="status"/);
  assert.match(indexSource, /id="account-overview-sync-label"[^>]*>检测中<\/span>/);
  assert.match(indexSource, /id="sync-now"[^>]*>立即同步<\/button>/);
  assert.match(syncSource, /function setConnectionState\(state = "unknown", key = "serviceUnchecked"/);
  assert.doesNotMatch(syncSource, /accountOverviewSyncStateEl\.textContent = syncText\(key \|\| "syncNow"/);
  assert.match(syncSource, /invoke\("auth_usage_status"\)[\s\S]*setConnectionState\("online", "serviceOnline"\)/);
  assert.match(syncSource, /setConnectionState\("offline", "serviceOffline", String\(error\)\)/);
  assert.match(stylesSource, /\.account-sync-state\.online[^{]*\{[^}]*color:\s*#1c7c49/);
  assert.match(stylesSource, /\.account-sync-state\.offline[^{]*\{[^}]*color:\s*#c34545/);
  assert.match(stylesSource, /\.account-overview-commands\s*\{[^}]*--account-command-height:\s*34px/);
  assert.match(stylesSource, /\.account-overview-commands \.sync-now-btn, \.account-overview-commands \.sync-logout-btn\s*\{[^}]*height:\s*var\(--account-command-height\)/);
  assert.match(stylesSource, /\.account-sync-state\s*\{[^}]*width:\s*var\(--account-command-height\)[^}]*height:\s*var\(--account-command-height\)[^}]*overflow:\s*hidden/);
  assert.match(stylesSource, /\.account-sync-state:is\(:hover, :focus-visible\)[^{]*\{[^}]*width:\s*auto/);
  assert.match(i18nSource, /syncNow:\s*"立即同步"/);
  assert.match(i18nSource, /serviceOnline:\s*"服务畅通"/);
  assert.match(i18nSource, /serviceOffline:\s*"连接异常"/);
});

test("persisted account is restored and automatically synced on startup", () => {
  const appSource = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  assert.match(syncSource, /async function syncOnStartup\(\)/);
  assert.match(syncSource, /await loadSyncSettingsOnce\(\)/);
  assert.match(syncSource, /await invoke\("sync_now"\)/);
  assert.match(syncSource, /setSyncButtonState\("fail", "autoSyncFailed", String\(e\)\);\s*syncStatusEl\.classList\.remove\("hidden"\);\s*syncStatusEl\.textContent = syncText\("syncFailedDetail", \{ error: e \}\);/s);
  assert.match(appSource, /await syncUI\.loadSettingsOnce\(\);[\s\S]*await syncUI\.syncOnStartup\(\)/);
});

test("sync UI exposes an explicit init API and preserves authentication payloads", async () => {
  class FakeElement {
    constructor() {
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          } else if (force) classes.add(name);
          else classes.delete(name);
          return classes.has(name);
        },
      };
      this.handlers = new Map();
      this.style = {};
      this.dataset = {};
      this.value = "";
      this.disabled = false;
      this.textContent = "";
      this.hidden = false;
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, event = {}) { return this.handlers.get(name)?.(event); }
    focus() {}
    setAttribute() {}
    querySelectorAll() { return []; }
  }
  const ids = [
    "account-btn", "account-panel", "sync-form", "sync-account", "sync-account-name",
    "sync-username", "sync-password", "saved-accounts", "sync-status", "sync-last-time",
    "sync-last-counts", "sync-now", "sync-logout", "sync-register", "sync-login",
    "sync-password-reset-open", "sync-password-reset", "sync-reset-email", "sync-reset-code",
    "sync-reset-new-password", "sync-reset-request", "sync-reset-confirm", "sync-reset-status",
    "account-security-open", "account-security-panel", "account-overview-panel", "account-overview-sync-state", "account-overview-sync-label",
    "account-storage-value", "account-storage-bar", "account-storage-note", "account-daily-value", "account-daily-bar", "account-daily-note",
    "account-tab-overview", "account-tab-sync",
    "account-security-summary", "account-security-status", "account-email-toggle", "account-email-form",
    "account-email", "account-email-code", "account-email-start", "account-email-confirm",
    "account-email-bind-flow", "account-email-rebind-flow", "account-email-old-start",
    "account-email-old-code", "account-email-old-confirm", "account-email-new-step",
    "account-email-new", "account-email-new-start", "account-email-new-code", "account-email-new-confirm",
    "account-password-toggle", "account-password-form", "account-current-password",
    "account-new-password", "account-password-change", "private-sync-panel",
    "account-data-open", "account-data-panel", "account-clear-local",
    "account-clear-cloud-password", "account-clear-cloud", "account-delete-password",
    "account-delete-username", "account-delete", "account-data-status",
    "account-sync-progress", "account-sync-reading-data", "account-sync-vocabulary", "account-sync-statistics",
    "account-sync-software-settings", "account-sync-model-tags", "account-sync-palettes", "account-sync-configs",
    "account-sync-history", "account-sync-secrets", "private-sync-password", "private-sync-save-password",
    "private-sync-unlock", "private-sync-forget", "private-sync-status",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const root = {
    createElement: () => new FakeElement(),
    getElementById: (id) => elements.get(id) || null,
  };
  const storageData = new Map();
  const storage = {
    getItem: (key) => storageData.get(key) || null,
    removeItem: (key) => storageData.delete(key),
    setItem: (key, value) => storageData.set(key, value),
  };
  const calls = [];
  const context = {};
  context.window = context;
  vm.runInNewContext(syncSource, context);
  context.ReaderSyncUI.init({
    root,
    storage,
    menuElement: new FakeElement(),
    filterPanel: new FakeElement(),
    renderShelf() {},
    invoke: async (command, payload) => {
      calls.push({ command, payload });
      if (command === "auth_login") return { user: { username: "alice" } };
      if (command === "sync_now") return { message: "ok", server_time: 1, pushed: 1, pulled: 2, accepted: 1, ignored: 0 };
      if (command === "shelf_books") return [];
      return {};
    },
  });
  elements.get("sync-username").value = "alice";
  elements.get("sync-password").value = "secret";
  await elements.get("sync-login").emit("click");
  assert.equal(calls[0].command, "auth_login");
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0].payload)),
    { request: { url: "", username: "alice", password: "secret" } },
  );
  assert.equal(calls[1].command, "sync_now");
  assert.equal(calls[2].command, "shelf_books");

  elements.get("account-security-panel").hidden = true;
  elements.get("account-data-panel").hidden = true;
  elements.get("private-sync-panel").hidden = true;
  elements.get("account-overview-panel").hidden = false;
  await elements.get("account-security-open").emit("click");
  assert.equal(elements.get("account-security-panel").hidden, false);
  assert.equal(elements.get("account-overview-panel").hidden, true);
  assert.equal(elements.get("account-panel").dataset.accountTab, "security");
});

test("账户中心在同一窗口切换概览、同步、安全和数据页面", () => {
  assert.match(indexSource, /id="account-tab-overview"/);
  assert.match(indexSource, /id="account-tab-sync"/);
  assert.match(syncSource, /accountSyncTabBtn\.addEventListener\("click", \(\) => selectAccountTab\("sync"\)\)/);
  assert.match(syncSource, /accountSecurityOpenBtn\.addEventListener\("click", \(\) => selectAccountTab\("security"\)\)/);
  assert.match(syncSource, /accountDataOpenBtn\.addEventListener\("click", \(\) => selectAccountTab\("data"\)\)/);
});

test("账户中心仅在非概览页使用统一的扩展高度", () => {
  assert.match(syncSource, /accountPanel\.dataset\.accountTab = tab/);
  assert.match(stylesSource, /\.account-panel\[data-account-tab="sync"\],[\s\S]*?height:\s*min\(720px, calc\(100vh - 48px\)\)/);
  assert.match(stylesSource, /\.account-panel\[data-account-tab="security"\],[\s\S]*?\.account-panel\[data-account-tab="data"\]/);
  assert.doesNotMatch(stylesSource, /\.account-panel\[data-account-tab="overview"\][\s\S]{0,180}height:/);
  assert.match(stylesSource, /\.account-panel\[data-account-tab="sync"\] \.account-center-pages[\s\S]*?overflow-y:\s*auto/);
});

test("账户中心安全与数据入口使用统一图标导航和轻量焦点状态", () => {
  assert.match(indexSource, /id="account-tab-overview"[\s\S]*?class="account-tab-icon"/);
  assert.match(indexSource, /id="account-tab-sync"[\s\S]*?class="account-tab-icon"/);
  assert.doesNotMatch(indexSource, /账户中心<\/strong>/);
  assert.match(indexSource, /id="account-security-open" class="account-tab-button account-tab-secondary"[\s\S]*?data-i18n="accountSecurity"/);
  assert.match(indexSource, /id="account-data-open" class="account-tab-button"[\s\S]*?data-i18n="accountDataPrivacy"/);
  assert.match(stylesSource, /\.account-tab-button\.active::after\s*\{[^}]*width:\s*3px;[^}]*background:\s*#3d82d8;/s);
  assert.match(stylesSource, /\.account-tab-button:focus-visible\s*\{[^}]*rgba\(68,137,226,\.22\)/s);
  assert.match(stylesSource, /\.account-tab-secondary::before/);
  assert.match(stylesSource, /\.account-security-disclosure\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*#fff;/s);
  assert.match(stylesSource, /\.account-data-card::before/);
});

test("数据与隐私提供本机、云端和账号三级清理并明确保留原始图书", () => {
  assert.match(indexSource, /id="account-clear-local"/);
  assert.match(indexSource, /id="account-clear-cloud"/);
  assert.match(indexSource, /id="account-delete"/);
  assert.match(indexSource, /不会删除电脑中的原始 EPUB、PDF、TXT、MOBI 或 AZW 图书文件/);
  assert.match(syncSource, /invoke\("clear_local_app_data"\)/);
  assert.match(syncSource, /invoke\("sync_reset_cloud_data"/);
  assert.match(syncSource, /invoke\("auth_delete_account"/);
});
