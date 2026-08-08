const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const uiDir = path.resolve(__dirname, "..");
const syncSource = fs.readFileSync(path.join(uiDir, "sync-ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
const i18nSource = fs.readFileSync(path.join(uiDir, "app-i18n.js"), "utf8");

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

test("同步内容总览列出新增的模型标签、配置和可选历史同步", () => {
  assert.match(indexSource, /大模型书籍分类标签/);
  assert.match(indexSource, /data-i18n="syncSoftwareSettings">软件设置/);
  assert.match(indexSource, /大模型与翻译 API 配置（不含密钥）/);
  assert.match(indexSource, /智读与书库问答记录（可选）/);
  assert.match(indexSource, /加密 API Key 与翻译密钥（可选）/);
  assert.match(indexSource, /id="account-sync-history"/);
  assert.match(indexSource, /id="account-sync-secrets"/);
  assert.match(i18nSource, /syncSoftwareSettings = label/);
  assert.match(syncSource, /function applyPrivateSyncOverview/);
  assert.match(syncSource, /account-sync-enabled/);
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
    "account-security-open", "account-security-panel", "account-security-close",
    "account-subpage-backdrop",
    "account-security-summary", "account-security-status", "account-email-toggle", "account-email-form",
    "account-email", "account-email-code", "account-email-start", "account-email-confirm",
    "account-email-bind-flow", "account-email-rebind-flow", "account-email-old-start",
    "account-email-old-code", "account-email-old-confirm", "account-email-new-step",
    "account-email-new", "account-email-new-start", "account-email-new-code", "account-email-new-confirm",
    "account-password-toggle", "account-password-form", "account-current-password",
    "account-new-password", "account-password-change", "private-sync-open", "private-sync-panel",
    "account-password-recover-toggle", "account-password-recover-form", "account-password-recover-email",
    "account-password-recover-code", "account-password-recover-new", "account-password-recover-start",
    "account-password-recover-confirm",
    "account-data-open", "account-data-panel", "account-data-close", "account-clear-local",
    "account-clear-cloud-password", "account-clear-cloud", "account-delete-password",
    "account-delete-username", "account-delete", "account-data-status",
    "private-sync-close", "private-sync-configs", "private-sync-history", "private-sync-secrets",
    "account-sync-history", "account-sync-secrets",
    "private-sync-password", "private-sync-save-password", "private-sync-unlock",
    "private-sync-forget", "private-sync-status",
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
  elements.get("account-subpage-backdrop").hidden = true;
  await elements.get("account-security-open").emit("click");
  assert.equal(elements.get("account-security-panel").hidden, false);
  assert.equal(elements.get("account-subpage-backdrop").hidden, false);
  let backdropClickStopped = false;
  elements.get("account-subpage-backdrop").emit("click", { stopPropagation() { backdropClickStopped = true; } });
  assert.equal(backdropClickStopped, true);
  assert.equal(elements.get("account-security-panel").hidden, true);
  assert.equal(elements.get("account-subpage-backdrop").hidden, true);
});

test("账户安全和同步设置点击外部区域后关闭且不穿透到底层账户操作", () => {
  assert.match(indexSource, /id="account-subpage-backdrop" class="account-subpage-backdrop" hidden/);
  assert.match(syncSource, /function closeAccountSubpages\(\)/);
  assert.match(syncSource, /accountSubpageBackdrop\.hidden = accountSecurityPanel\.hidden && accountDataPanel\.hidden && privateSyncPanel\.hidden/);
  assert.match(syncSource, /accountSubpageBackdrop\.addEventListener\("click", \(e\) => \{\s*e\.stopPropagation\(\);\s*closeAccountSubpages\(\);/s);
  assert.match(syncSource, /privateSyncOpenBtn\.addEventListener[\s\S]*?syncAccountSubpageBackdrop\(\)/);
  assert.match(syncSource, /accountSecurityOpenBtn\.addEventListener[\s\S]*?syncAccountSubpageBackdrop\(\)/);
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
