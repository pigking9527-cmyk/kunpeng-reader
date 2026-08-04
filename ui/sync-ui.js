// 账号、登录和同步面板。依赖由 app.js 通过 ReaderSyncUI.init 显式注入。
(function exposeSyncUi(global) {
"use strict";

let activeController = null;

function init(options = {}) {
  if (activeController) return activeController;
  const document = options.root;
  const invoke = options.invoke;
  const menuEl = options.menuElement;
  const filterPanel = options.filterPanel;
  const renderShelf = options.renderShelf;
  const localStorage = options.storage || global.localStorage;
  if (!document || typeof document.getElementById !== "function") throw new Error("ReaderSyncUI.init 缺少 root");
  if (typeof invoke !== "function") throw new Error("ReaderSyncUI.init 缺少 invoke");
  if (!menuEl || !filterPanel) throw new Error("ReaderSyncUI.init 缺少浮层元素");
  if (typeof renderShelf !== "function") throw new Error("ReaderSyncUI.init 缺少 renderShelf");

const accountBtn = document.getElementById("account-btn");
const accountPanel = document.getElementById("account-panel");
const syncFormEl = document.getElementById("sync-form");
const syncAccountEl = document.getElementById("sync-account");
const syncAccountNameEl = document.getElementById("sync-account-name");
const syncUsernameEl = document.getElementById("sync-username");
const syncPasswordEl = document.getElementById("sync-password");
const savedAccountsEl = document.getElementById("saved-accounts");
const SYNC_ACCOUNT_CACHE_KEY = "syncAccountCacheV1";
const syncStatusEl = document.getElementById("sync-status");
const syncLastTimeEl = document.getElementById("sync-last-time");
const syncLastCountsEl = document.getElementById("sync-last-counts");
const syncNowBtn = document.getElementById("sync-now");
const syncLogoutBtn = document.getElementById("sync-logout");
const syncRegisterBtn = document.getElementById("sync-register");
const syncLoginBtn = document.getElementById("sync-login");
const syncPasswordResetOpenBtn = document.getElementById("sync-password-reset-open");
const syncPasswordResetEl = document.getElementById("sync-password-reset");
const syncResetEmailEl = document.getElementById("sync-reset-email");
const syncResetCodeEl = document.getElementById("sync-reset-code");
const syncResetNewPasswordEl = document.getElementById("sync-reset-new-password");
const syncResetRequestBtn = document.getElementById("sync-reset-request");
const syncResetConfirmBtn = document.getElementById("sync-reset-confirm");
const syncResetStatusEl = document.getElementById("sync-reset-status");
const accountSecurityOpenBtn = document.getElementById("account-security-open");
const accountSecurityPanel = document.getElementById("account-security-panel");
const accountSecurityCloseBtn = document.getElementById("account-security-close");
const accountSecuritySummaryEl = document.getElementById("account-security-summary");
const accountSecurityStatusEl = document.getElementById("account-security-status");
const accountEmailToggleBtn = document.getElementById("account-email-toggle");
const accountEmailFormEl = document.getElementById("account-email-form");
const accountEmailBindFlowEl = document.getElementById("account-email-bind-flow");
const accountEmailRebindFlowEl = document.getElementById("account-email-rebind-flow");
const accountEmailEl = document.getElementById("account-email");
const accountEmailCodeEl = document.getElementById("account-email-code");
const accountEmailStartBtn = document.getElementById("account-email-start");
const accountEmailConfirmBtn = document.getElementById("account-email-confirm");
const accountEmailOldStartBtn = document.getElementById("account-email-old-start");
const accountEmailOldCodeEl = document.getElementById("account-email-old-code");
const accountEmailOldConfirmBtn = document.getElementById("account-email-old-confirm");
const accountEmailNewStepEl = document.getElementById("account-email-new-step");
const accountEmailNewEl = document.getElementById("account-email-new");
const accountEmailNewStartBtn = document.getElementById("account-email-new-start");
const accountEmailNewCodeEl = document.getElementById("account-email-new-code");
const accountEmailNewConfirmBtn = document.getElementById("account-email-new-confirm");
const accountPasswordToggleBtn = document.getElementById("account-password-toggle");
const accountPasswordFormEl = document.getElementById("account-password-form");
const accountCurrentPasswordEl = document.getElementById("account-current-password");
const accountNewPasswordEl = document.getElementById("account-new-password");
const accountPasswordChangeBtn = document.getElementById("account-password-change");
const accountPasswordRecoverToggleBtn = document.getElementById("account-password-recover-toggle");
const accountPasswordRecoverFormEl = document.getElementById("account-password-recover-form");
const accountPasswordRecoverEmailEl = document.getElementById("account-password-recover-email");
const accountPasswordRecoverCodeEl = document.getElementById("account-password-recover-code");
const accountPasswordRecoverNewEl = document.getElementById("account-password-recover-new");
const accountPasswordRecoverStartBtn = document.getElementById("account-password-recover-start");
const accountPasswordRecoverConfirmBtn = document.getElementById("account-password-recover-confirm");
const privateSyncOpenBtn = document.getElementById("private-sync-open");
const privateSyncPanel = document.getElementById("private-sync-panel");
const privateSyncCloseBtn = document.getElementById("private-sync-close");
const privateSyncConfigsEl = document.getElementById("private-sync-configs");
const privateSyncHistoryEl = document.getElementById("private-sync-history");
const privateSyncSecretsEl = document.getElementById("private-sync-secrets");
const accountSyncHistoryEl = document.getElementById("account-sync-history");
const accountSyncSecretsEl = document.getElementById("account-sync-secrets");
const privateSyncPasswordEl = document.getElementById("private-sync-password");
const privateSyncSavePasswordBtn = document.getElementById("private-sync-save-password");
const privateSyncUnlockBtn = document.getElementById("private-sync-unlock");
const privateSyncForgetBtn = document.getElementById("private-sync-forget");
const privateSyncStatusEl = document.getElementById("private-sync-status");
const SAVED_ACCOUNTS_KEY = "readerSavedAccountsV1";
let accountEmailCooldownUntil = 0;
let accountEmailCooldownTimer = 0;
let accountEmailRebindGrant = "";
let accountEmailBound = false;
let accountPasswordRecoverCooldownUntil = 0;
let accountPasswordRecoverCooldownTimer = 0;
function formatSyncTime(v) {
  const n = Number(v) || 0;
  if (!n) return "尚未同步";
  const ms = n > 100000000000 ? n : n * 1000;
  return new Date(ms).toLocaleString();
}
function readCachedSyncAccount() {
  try {
    const cached = JSON.parse(localStorage.getItem(SYNC_ACCOUNT_CACHE_KEY) || "{}");
    return cached && cached.username ? cached : null;
  } catch (e) {
    return null;
  }
}
function writeCachedSyncAccount(username) {
  try {
    if (username) localStorage.setItem(SYNC_ACCOUNT_CACHE_KEY, JSON.stringify({ username, saved_at: Date.now() }));
    else localStorage.removeItem(SYNC_ACCOUNT_CACHE_KEY);
  } catch (e) {}
}
function applyCachedSyncAccount() {
  const cached = readCachedSyncAccount();
  if (!cached) return false;
  syncUsernameEl.value = cached.username || "";
  updateAccountView({ username: cached.username });
  return true;
}
function setSyncButtonState(state, text, title = "") {
  syncNowBtn.classList.remove("syncing", "ok", "fail");
  if (state) syncNowBtn.classList.add(state);
  syncNowBtn.textContent = text || "同步";
  syncNowBtn.title = title;
}
function updateSyncSummary(settings = {}) {
  if (Object.prototype.hasOwnProperty.call(settings, "last_sync_at")) {
    syncLastTimeEl.textContent = "最近同步：" + formatSyncTime(settings.last_sync_at);
  }
  const hasCounts = Object.prototype.hasOwnProperty.call(settings, "last_sync_pushed")
    || Object.prototype.hasOwnProperty.call(settings, "last_sync_pulled")
    || Object.prototype.hasOwnProperty.call(settings, "last_sync_accepted")
    || Object.prototype.hasOwnProperty.call(settings, "last_sync_ignored");
  if (hasCounts) {
    const pushed = Number(settings.last_sync_pushed) || 0;
    const pulled = Number(settings.last_sync_pulled) || 0;
    const accepted = Number(settings.last_sync_accepted) || 0;
    const ignored = Number(settings.last_sync_ignored) || 0;
    syncLastCountsEl.textContent = `上次尝试上传 ${pushed} 项，新增 ${accepted} 项，重复/冲突 ${ignored} 项，接收 ${pulled} 项；图书文件本身不会上传`;
  }
}
function readSavedAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((x) => x && x.username)
      .map((x) => ({ username: String(x.username || ""), saved_at: x.saved_at || 0 }))
      .filter((x) => x.username);
  } catch (e) {
    return [];
  }
}
function writeSavedAccounts(list) {
  try {
    localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list.slice(0, 12)));
  } catch (e) {}
}
function saveAccountInfo(username) {
  username = (username || "").trim();
  if (!username) return;
  const list = readSavedAccounts().filter((x) => x.username !== username);
  list.unshift({ username, saved_at: Date.now() });
  writeSavedAccounts(list);
}
function hideSavedAccounts() {
  savedAccountsEl.classList.remove("show");
}
function closeAccountPanel() {
  accountPanel.classList.remove("show");
  privateSyncPanel.hidden = true;
  accountSecurityPanel.hidden = true;
  setAccountSecurityDisclosure(accountEmailToggleBtn, accountEmailFormEl, false);
  setAccountSecurityDisclosure(accountPasswordToggleBtn, accountPasswordFormEl, false);
  setAccountSecurityDisclosure(accountPasswordRecoverToggleBtn, accountPasswordRecoverFormEl, false);
  syncPasswordResetEl.hidden = true;
  accountBtn.classList.remove("active");
  hideSavedAccounts();
}
function setAccountSecurityStatus(text = "", type = "") {
  accountSecurityStatusEl.textContent = text;
  accountSecurityStatusEl.className = "private-sync-status" + (type ? " " + type : "");
}
function setAccountSecurityDisclosure(toggle, form, open) {
  form.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("open", open);
}
function updateAccountEmailCooldown() {
  const remaining = Math.max(0, Math.ceil((accountEmailCooldownUntil - Date.now()) / 1000));
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
    accountEmailCooldownTimer = global.setInterval(updateAccountEmailCooldown, 1000);
  }
}
function updateAccountPasswordRecoverCooldown() {
  const remaining = Math.max(0, Math.ceil((accountPasswordRecoverCooldownUntil - Date.now()) / 1000));
  if (!remaining) {
    accountPasswordRecoverStartBtn.disabled = false;
    accountPasswordRecoverStartBtn.textContent = "发送验证码";
    if (accountPasswordRecoverCooldownTimer) {
      global.clearInterval(accountPasswordRecoverCooldownTimer);
      accountPasswordRecoverCooldownTimer = 0;
    }
    return;
  }
  accountPasswordRecoverStartBtn.disabled = true;
  accountPasswordRecoverStartBtn.textContent = `已发送（${remaining} 秒）`;
}
function beginAccountPasswordRecoverCooldown() {
  accountPasswordRecoverCooldownUntil = Date.now() + 60 * 1000;
  updateAccountPasswordRecoverCooldown();
  if (!accountPasswordRecoverCooldownTimer) {
    accountPasswordRecoverCooldownTimer = global.setInterval(updateAccountPasswordRecoverCooldown, 1000);
  }
}
function setResetStatus(text = "", type = "") {
  syncResetStatusEl.textContent = text;
  syncResetStatusEl.className = "private-sync-status" + (type ? " " + type : "");
}
function applyAccountSecurityStatus(status = {}) {
  const email = status.email || "";
  accountEmailBound = !!status.emailBound;
  accountSecuritySummaryEl.textContent = status.emailBound
    ? `已绑定验证邮箱：${email}。可用于找回登录密码。`
    : (status.mailConfigured ? "尚未绑定验证邮箱。绑定后才能找回登录密码。" : "账户安全邮件暂未配置；暂时不能绑定或找回登录密码。");
  accountEmailEl.value = "";
  accountEmailToggleBtn.textContent = accountEmailBound ? "更换绑定邮箱" : "绑定邮箱";
  accountEmailBindFlowEl.hidden = accountEmailBound;
  accountEmailRebindFlowEl.hidden = !accountEmailBound;
  if (!accountEmailBound) {
    accountEmailRebindGrant = "";
    accountEmailNewStepEl.hidden = true;
  }
}
async function loadAccountSecurityStatus() {
  try { applyAccountSecurityStatus(await invoke("auth_security_status")); }
  catch (error) { setAccountSecurityStatus("读取账户安全状态失败：" + error, "error"); }
}
function setPrivateSyncStatus(text = "", type = "") {
  privateSyncStatusEl.textContent = text;
  privateSyncStatusEl.className = "private-sync-status" + (type ? " " + type : "");
}
function applyPrivateSyncOverview(status = {}) {
  accountSyncHistoryEl.classList.toggle("account-sync-enabled", !!status.syncAiHistory);
  accountSyncSecretsEl.classList.toggle("account-sync-enabled", !!status.syncSecrets);
}
function applyPrivateSyncStatus(status = {}) {
  privateSyncConfigsEl.checked = status.syncConfigs !== false;
  privateSyncHistoryEl.checked = !!status.syncAiHistory;
  privateSyncSecretsEl.checked = !!status.syncSecrets;
  applyPrivateSyncOverview(status);
  const secretText = status.cloudSecretAvailable
    ? "云端已有加密密钥包；需要同步密码才能在本机解锁。"
    : "API Key 和翻译密钥默认仅保留在本机。";
  setPrivateSyncStatus(secretText);
}
async function loadPrivateSyncStatus() {
  try { applyPrivateSyncStatus(await invoke("private_sync_get_settings")); }
  catch (error) { setPrivateSyncStatus("读取私密同步设置失败：" + error, "error"); }
}
async function savePrivateSyncOptions() {
  const options = {
    syncConfigs: !!privateSyncConfigsEl.checked,
    syncAiHistory: !!privateSyncHistoryEl.checked,
    syncSecrets: !!privateSyncSecretsEl.checked,
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
function openAccountPanel() {
  accountPanel.classList.add("show");
  accountBtn.classList.add("active");
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
      writeSavedAccounts(readSavedAccounts().filter((x) => x.username !== item.username));
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
function updateAccountView(settings = {}) {
  updateSyncSummary(settings);
  const username = settings.username || syncUsernameEl.value.trim();
  if (username) {
    writeCachedSyncAccount(username);
    syncFormEl.classList.add("hidden");
    syncAccountEl.classList.add("show");
    syncStatusEl.classList.add("hidden");
    syncAccountNameEl.textContent = "账号：" + username;
    setSyncButtonState("", "同步");
  } else {
    writeCachedSyncAccount("");
    syncFormEl.classList.remove("hidden");
    syncAccountEl.classList.remove("show");
    syncStatusEl.classList.remove("hidden");
    syncStatusEl.textContent = "尚未登录";
    setSyncButtonState("", "同步");
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
    syncStatusEl.classList.remove("hidden");
    syncStatusEl.textContent = "读取同步设置失败：" + e;
    return null;
  }
}
let syncSettingsLoaded = false;
let syncSettingsLoading = false;
let syncSettingsPromise = null;
async function loadSyncSettingsOnce() {
  if (syncSettingsLoaded) return;
  if (syncSettingsLoading && syncSettingsPromise) return syncSettingsPromise;
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
let startupAutoSyncStarted = false;
async function syncOnStartup() {
  await loadSyncSettingsOnce();
  if (startupAutoSyncStarted || !syncUsernameEl.value.trim()) return;
  startupAutoSyncStarted = true;
  syncNowBtn.disabled = true;
  setSyncButtonState("syncing", "自动同步中");
  try {
    const report = await invoke("sync_now");
    setSyncButtonState("ok", "同步成功", report.message);
    updateSyncSummary({
      last_sync_at: report.server_time,
      last_sync_pushed: report.pushed,
      last_sync_pulled: report.pulled,
      last_sync_accepted: report.accepted,
      last_sync_ignored: report.ignored,
    });
    renderShelf(await invoke("shelf_books"));
  } catch (e) {
    // Keep the persisted login. Offline startup should not turn into logout.
    setSyncButtonState("fail", "自动同步失败", String(e));
  } finally {
    syncNowBtn.disabled = false;
  }
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
  if (!e.target.closest(".account-input-wrap")) hideSavedAccounts();
});
privateSyncOpenBtn.addEventListener("click", async () => {
  privateSyncPanel.hidden = false;
  accountSecurityPanel.hidden = true;
  await loadPrivateSyncStatus();
});
privateSyncCloseBtn.addEventListener("click", () => { privateSyncPanel.hidden = true; });
privateSyncPanel.addEventListener("click", (e) => e.stopPropagation());
privateSyncConfigsEl.addEventListener("change", savePrivateSyncOptions);
privateSyncHistoryEl.addEventListener("change", savePrivateSyncOptions);
privateSyncSecretsEl.addEventListener("change", async () => {
  if (!privateSyncSecretsEl.checked) { await savePrivateSyncOptions(); return; }
  privateSyncSecretsEl.checked = false;
  privateSyncPasswordEl.focus();
  setPrivateSyncStatus("密钥同步需要先输入同步密码并点击“加密并同步密钥”。");
});
privateSyncSavePasswordBtn.addEventListener("click", async () => {
  const password = privateSyncPasswordEl.value;
  try {
    const status = await invoke("private_sync_set_password", { password });
    privateSyncPasswordEl.value = "";
    applyPrivateSyncStatus(status);
    const report = await invoke("sync_now");
    setSyncButtonState("ok", "同步成功", report.message);
    updateSyncSummary({
      last_sync_at: report.server_time,
      last_sync_pushed: report.pushed,
      last_sync_pulled: report.pulled,
      last_sync_accepted: report.accepted,
      last_sync_ignored: report.ignored,
    });
    setPrivateSyncStatus("密钥已加密并同步；其他设备输入同一同步密码即可恢复，无需再次填写 API Key。", "ok");
  } catch (error) { setPrivateSyncStatus("无法同步密钥：" + error, "error"); }
});
privateSyncUnlockBtn.addEventListener("click", async () => {
  const password = privateSyncPasswordEl.value;
  try {
    await invoke("private_sync_unlock_secrets", { password });
    privateSyncPasswordEl.value = "";
    setPrivateSyncStatus("已在本机解锁并保存智读、翻译密钥。", "ok");
  } catch (error) { setPrivateSyncStatus("无法解锁云端密钥：" + error, "error"); }
});
privateSyncForgetBtn.addEventListener("click", async () => {
  if (!global.confirm("这会撤销云端的智读和翻译密钥包。同步密码无法找回；本机现有 API Key 不会删除。确定继续吗？")) return;
  try {
    const status = await invoke("private_sync_forget_password");
    privateSyncPasswordEl.value = "";
    applyPrivateSyncStatus(status);
    setPrivateSyncStatus("旧云端密钥包已撤销。若本机仍有 API Key，请输入新同步密码后重新加密。", "ok");
  } catch (error) { setPrivateSyncStatus("撤销失败：" + error, "error"); }
});
syncPasswordResetOpenBtn.addEventListener("click", () => {
  syncPasswordResetEl.hidden = !syncPasswordResetEl.hidden;
  if (!syncPasswordResetEl.hidden) syncResetEmailEl.focus();
});
syncResetRequestBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_request_password_reset", { request: {
      url: "", username: syncUsernameEl.value.trim(), email: syncResetEmailEl.value.trim(),
    }});
    setResetStatus("若账号已绑定该邮箱，验证码将发送至邮箱。", "ok");
  } catch (error) { setResetStatus("发送验证码失败：" + error, "error"); }
});
syncResetConfirmBtn.addEventListener("click", async () => {
  try {
    const res = await invoke("auth_confirm_password_reset", { request: {
      url: "", username: syncUsernameEl.value.trim(), email: syncResetEmailEl.value.trim(),
      code: syncResetCodeEl.value.trim(), newPassword: syncResetNewPasswordEl.value,
    }});
    syncResetCodeEl.value = "";
    syncResetNewPasswordEl.value = "";
    syncPasswordResetEl.hidden = true;
    syncSettingsLoaded = true;
    updateAccountView({ username: res.user?.username || syncUsernameEl.value });
    saveAccountInfo(res.user?.username || syncUsernameEl.value);
    setSyncButtonState("ok", "同步", "登录密码已重置");
    syncStatusEl.textContent = "密码已重置并登录；其他设备已退出登录。";
  } catch (error) { setResetStatus("重置失败：" + error, "error"); }
});
accountSecurityOpenBtn.addEventListener("click", async () => {
  accountSecurityPanel.hidden = false;
  privateSyncPanel.hidden = true;
  setAccountSecurityDisclosure(accountEmailToggleBtn, accountEmailFormEl, false);
  setAccountSecurityDisclosure(accountPasswordToggleBtn, accountPasswordFormEl, false);
  setAccountSecurityStatus("");
  await loadAccountSecurityStatus();
});
accountSecurityCloseBtn.addEventListener("click", () => { accountSecurityPanel.hidden = true; });
accountSecurityPanel.addEventListener("click", (e) => e.stopPropagation());
accountEmailToggleBtn.addEventListener("click", () => {
  const open = accountEmailFormEl.hidden;
  setAccountSecurityDisclosure(accountEmailToggleBtn, accountEmailFormEl, open);
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
accountPasswordToggleBtn.addEventListener("click", () => {
  const open = accountPasswordFormEl.hidden;
  setAccountSecurityDisclosure(accountPasswordToggleBtn, accountPasswordFormEl, open);
  if (open) accountCurrentPasswordEl.focus();
});
accountPasswordRecoverToggleBtn.addEventListener("click", () => {
  const open = accountPasswordRecoverFormEl.hidden;
  setAccountSecurityDisclosure(accountPasswordRecoverToggleBtn, accountPasswordRecoverFormEl, open);
  if (open) accountPasswordRecoverEmailEl.focus();
});
accountEmailStartBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_bind_email_start", { request: { email: accountEmailEl.value.trim() } });
    beginAccountEmailCooldown();
    setAccountSecurityStatus("验证码已发送到该邮箱，请输入后确认绑定。", "ok");
    accountEmailCodeEl.focus();
  } catch (error) { setAccountSecurityStatus("发送验证码失败：" + error, "error"); }
});
accountEmailConfirmBtn.addEventListener("click", async () => {
  try {
    applyAccountSecurityStatus(await invoke("auth_bind_email_confirm", { request: {
      email: accountEmailEl.value.trim(), code: accountEmailCodeEl.value.trim(),
    }}));
    accountEmailCodeEl.value = "";
    setAccountSecurityStatus("邮箱已验证绑定，可用于找回登录密码。", "ok");
  } catch (error) { setAccountSecurityStatus("绑定失败：" + error, "error"); }
});
function beginRebindButtonCooldown(button) {
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  const until = Date.now() + 60 * 1000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    button.disabled = remaining > 0;
    button.textContent = remaining ? `已发送（${remaining} 秒）` : button.dataset.defaultLabel;
    if (!remaining) global.clearInterval(timer);
  };
  const timer = global.setInterval(tick, 1000);
  tick();
}
accountEmailOldStartBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_rebind_email_old_start");
    beginRebindButtonCooldown(accountEmailOldStartBtn);
    setAccountSecurityStatus("验证码已发送到当前绑定邮箱，请输入后验证。", "ok");
    accountEmailOldCodeEl.focus();
  } catch (error) { setAccountSecurityStatus("发送旧邮箱验证码失败：" + error, "error"); }
});
accountEmailOldConfirmBtn.addEventListener("click", async () => {
  try {
    accountEmailRebindGrant = await invoke("auth_rebind_email_old_confirm", { request: {
      code: accountEmailOldCodeEl.value.trim(),
    }});
    accountEmailOldCodeEl.value = "";
    accountEmailNewStepEl.hidden = false;
    setAccountSecurityStatus("旧邮箱已验证，请填写并验证新邮箱。", "ok");
    accountEmailNewEl.focus();
  } catch (error) { setAccountSecurityStatus("旧邮箱验证失败：" + error, "error"); }
});
accountEmailNewStartBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_rebind_email_new_start", { request: {
      email: accountEmailNewEl.value.trim(), rebindGrant: accountEmailRebindGrant,
    }});
    accountEmailRebindGrant = "";
    beginRebindButtonCooldown(accountEmailNewStartBtn);
    setAccountSecurityStatus("验证码已发送到新邮箱，请输入后确认更换。", "ok");
    accountEmailNewCodeEl.focus();
  } catch (error) { setAccountSecurityStatus("发送新邮箱验证码失败：" + error, "error"); }
});
accountEmailNewConfirmBtn.addEventListener("click", async () => {
  try {
    applyAccountSecurityStatus(await invoke("auth_rebind_email_new_confirm", { request: {
      email: accountEmailNewEl.value.trim(), code: accountEmailNewCodeEl.value.trim(),
    }}));
    accountEmailNewCodeEl.value = "";
    accountEmailNewStepEl.hidden = true;
    setAccountSecurityStatus("新的验证邮箱已绑定，可用于找回登录密码。", "ok");
  } catch (error) { setAccountSecurityStatus("更换绑定邮箱失败：" + error, "error"); }
});
accountPasswordChangeBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_change_password", { request: {
      currentPassword: accountCurrentPasswordEl.value,
      newPassword: accountNewPasswordEl.value,
    }});
    accountCurrentPasswordEl.value = "";
    accountNewPasswordEl.value = "";
    setAccountSecurityStatus("登录密码已修改，其他设备已退出登录。", "ok");
  } catch (error) { setAccountSecurityStatus("修改失败：" + error, "error"); }
});
accountPasswordRecoverStartBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_request_password_reset", { request: {
      url: "", username: syncUsernameEl.value.trim(), email: accountPasswordRecoverEmailEl.value.trim(),
    }});
    beginAccountPasswordRecoverCooldown();
    setAccountSecurityStatus("若账号已绑定该邮箱，验证码将发送至邮箱。", "ok");
    accountPasswordRecoverCodeEl.focus();
  } catch (error) { setAccountSecurityStatus("发送验证码失败：" + error, "error"); }
});
accountPasswordRecoverConfirmBtn.addEventListener("click", async () => {
  try {
    const res = await invoke("auth_confirm_password_reset", { request: {
      url: "", username: syncUsernameEl.value.trim(), email: accountPasswordRecoverEmailEl.value.trim(),
      code: accountPasswordRecoverCodeEl.value.trim(), newPassword: accountPasswordRecoverNewEl.value,
    }});
    accountPasswordRecoverCodeEl.value = "";
    accountPasswordRecoverNewEl.value = "";
    applyAccountSecurityStatus(await invoke("auth_security_status"));
    updateAccountView({ username: res.user?.username || syncUsernameEl.value });
    setAccountSecurityStatus("登录密码已重置，其他设备已退出登录。", "ok");
  } catch (error) { setAccountSecurityStatus("重置失败：" + error, "error"); }
});
async function syncAuth(action) {
  const isRegister = action === "register";
  const activeBtn = isRegister ? syncRegisterBtn : syncLoginBtn;
  const idleText = isRegister ? "注册" : "登录";
  syncRegisterBtn.disabled = true;
  syncLoginBtn.disabled = true;
  activeBtn.textContent = isRegister ? "注册中…" : "登录中…";
  syncStatusEl.textContent = isRegister ? "注册中…" : "登录中…";
  const username = syncUsernameEl.value.trim();
  const password = syncPasswordEl.value;
  closeAccountPanel();
  try {
    const res = await invoke(isRegister ? "auth_register" : "auth_login", {
      request: {
        url: "",
        username,
        password,
      },
    });
    syncUsernameEl.value = res.user?.username || syncUsernameEl.value;
    saveAccountInfo(syncUsernameEl.value);
    syncPasswordEl.value = "";
    hideSavedAccounts();
    syncSettingsLoaded = true;
    updateAccountView({ username: syncUsernameEl.value });
    setSyncButtonState("syncing", "首次同步中");
    try {
      const report = await invoke("sync_now");
      setSyncButtonState("ok", "同步成功", report.message);
      updateSyncSummary({
        last_sync_at: report.server_time,
        last_sync_pushed: report.pushed,
        last_sync_pulled: report.pulled,
        last_sync_accepted: report.accepted,
        last_sync_ignored: report.ignored,
      });
      renderShelf(await invoke("shelf_books"));
    } catch (syncError) {
      // Authentication succeeded. Keep the account signed in and let the user
      // retry synchronization without re-entering the password.
      setSyncButtonState("fail", "同步失败", String(syncError));
    }
  } catch (e) {
    openAccountPanel();
    syncStatusEl.classList.remove("hidden");
    syncStatusEl.textContent = `${isRegister ? "注册" : "登录"}失败：${e}`;
  } finally {
    syncRegisterBtn.disabled = false;
    syncLoginBtn.disabled = false;
    activeBtn.textContent = idleText;
  }
}
syncRegisterBtn.addEventListener("click", () => syncAuth("register"));
syncLoginBtn.addEventListener("click", () => syncAuth("login"));
syncUsernameEl.addEventListener("focus", renderSavedAccounts);
syncUsernameEl.addEventListener("click", renderSavedAccounts);
syncUsernameEl.addEventListener("input", () => {
  const q = syncUsernameEl.value.trim().toLowerCase();
  renderSavedAccounts();
  if (q) {
    savedAccountsEl.querySelectorAll(".saved-account-item").forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  }
});
[syncUsernameEl, syncPasswordEl].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      syncAuth("login");
    } else if (e.key === "Escape") {
      hideSavedAccounts();
    }
  });
});
syncLogoutBtn.addEventListener("click", async () => {
  try {
    await invoke("auth_logout");
  } catch (e) {
    syncStatusEl.classList.remove("hidden");
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
  setSyncButtonState("syncing", "同步中");
  syncStatusEl.classList.remove("hidden");
  syncStatusEl.textContent = "正在连接同步服务器…";
  try {
    const report = await invoke("sync_now");
    setSyncButtonState("ok", "同步成功", report.message + "；服务器时间：" + formatSyncTime(report.server_time));
    syncStatusEl.textContent = report.message;
    updateSyncSummary({
      last_sync_at: report.server_time,
      last_sync_pushed: report.pushed,
      last_sync_pulled: report.pulled,
      last_sync_accepted: report.accepted,
      last_sync_ignored: report.ignored,
    });
    renderShelf(await invoke("shelf_books"));
  } catch (e) {
    setSyncButtonState("fail", "同步失败", String(e));
    syncStatusEl.textContent = "同步失败：" + e;
  } finally {
    syncNowBtn.disabled = false;
  }
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

global.ReaderSyncUI = Object.freeze({
  close: () => controller().close(),
  init,
  loadSettingsOnce: () => controller().loadSettingsOnce(),
  open: () => controller().open(),
  syncOnStartup: () => controller().syncOnStartup(),
});
})(typeof window !== "undefined" ? window : globalThis);
