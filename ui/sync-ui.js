// 账号、登录和同步面板 UI
// 依赖 app.js 的 invoke/menuEl/filterPanel，以及 shelf-ui.js 的 render（仅在用户点击同步后调用）。
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
const syncNowBtn = document.getElementById("sync-now");
const syncLogoutBtn = document.getElementById("sync-logout");
const syncRegisterBtn = document.getElementById("sync-register");
const syncLoginBtn = document.getElementById("sync-login");
const SAVED_ACCOUNTS_KEY = "readerSavedAccountsV1";
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
  accountBtn.classList.remove("active");
  hideSavedAccounts();
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
  } catch (e) {
    syncStatusEl.classList.remove("hidden");
    syncStatusEl.textContent = "读取同步设置失败：" + e;
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
document.getElementById("fp-gear").addEventListener("click", (e) => {
  e.stopPropagation();
  filterPanel.classList.remove("show");
  closeAccountPanel();
  reflectAutoImport();
  fpSettingsModal.classList.add("show");
});
document.getElementById("fp-settings-close").addEventListener("click", () => fpSettingsModal.classList.remove("show"));
// “自动导入目录”行的齿轮 → 打开目录管理弹窗
document.getElementById("dirs-gear").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (typeof reflectAutoImport === "function") reflectAutoImport();
  renderDirsList();
  importDirsModal.classList.add("show");
});
document.getElementById("dirs-add").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  addImportDirs();
});
document.getElementById("import-dirs-close").addEventListener("click", () => importDirsModal.classList.remove("show"));
importDirsModal.addEventListener("click", (e) => {
  if (e.target === importDirsModal) importDirsModal.classList.remove("show");
});
// GitHub 链接：在系统默认浏览器打开，而不是在 WebView 里跳转
document.getElementById("about-github").addEventListener("click", (e) => {
  e.preventDefault();
  invoke("open_url", { url: e.currentTarget.href }).catch(() => {});
});
fpSettingsModal.addEventListener("click", (e) => {
  if (e.target === fpSettingsModal) fpSettingsModal.classList.remove("show");
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
      url: "",
      username,
      password,
    });
    syncUsernameEl.value = res.user?.username || syncUsernameEl.value;
    saveAccountInfo(syncUsernameEl.value);
    syncPasswordEl.value = "";
    hideSavedAccounts();
    syncSettingsLoaded = true;
    updateAccountView({ username: syncUsernameEl.value });
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
  setSyncButtonState("syncing", "同步中");
  try {
    const report = await invoke("sync_now");
    setSyncButtonState("ok", "同步成功", report.message + "；服务器时间：" + formatSyncTime(report.server_time));
    render(await invoke("shelf_books"));
  } catch (e) {
    setSyncButtonState("fail", "同步失败", String(e));
  }
});

