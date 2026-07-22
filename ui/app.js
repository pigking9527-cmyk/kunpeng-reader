// 书架页逻辑
const invoke = window.__TAURI__.core.invoke;
const dialog = window.__TAURI__.dialog;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单

// 禁用浏览器自带查找（Ctrl+F / F3）
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const toolbarEl = document.querySelector(".toolbar");

const syncUI = window.ReaderSyncUI.init({
  root: document,
  invoke,
  menuElement: menuEl,
  filterPanel,
  storage: window.localStorage,
  renderShelf: (list) => window.ReaderShelfUI.render(list),
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
  alertAction: (message) => window.alert(message),
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
  } catch (e) {}
}
window.clearCrossReturnMemory = clearCrossReturnMemory;
// 应用重新启动进入书架时，跨书搜索的回跳记忆不应继续保留。
clearCrossReturnMemory();

function debugSettingOn(key) {
  try {
    const settings = JSON.parse(localStorage.getItem("debugSettingsV1") || "{}");
    return settings[key] !== false;
  } catch (e) {
    return true;
  }
}

function closeMainFloaters(options = {}) {
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
  if (e.target.closest(".account-wrap,.search-wrap,.filter-wrap,.menu-wrap,.window-controls,.del-group")) return;
  closeMainFloaters();
}, true);

function runWhenNoReader(name, work, retryMs = 30000) {
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
let autoImport = { enabled: false, dirs: [] };
const setAutoChk = document.getElementById("set-auto-import");
const importDirsEnabledChk = document.getElementById("import-dirs-enabled");
const importDirsEnabledRow = document.getElementById("import-dirs-enabled-row");
const importDirsModal = document.getElementById("import-dirs-modal");
const dirsListEl = document.getElementById("dirs-list");
const dirsStatusEl = document.getElementById("dirs-status");
const dirsGearBtn = document.getElementById("dirs-gear");
const importDirsCloseBtn = document.getElementById("import-dirs-close");
const dirsAddBtn = document.getElementById("dirs-add");
let autoImportScanSeq = 0;
let autoImportToggleBusy = false;
function setDirsStatus(text = "", kind = "") {
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
  if (importDirsEnabledChk) importDirsEnabledChk.checked = !!autoImport.enabled;
  renderDirsList();
}
async function startAutoImportScan(reason = "正在扫描并导入目录…") {
  if (!autoImport.enabled || !autoImport.dirs.length) return;
  const finishAutoImport = startupPerfStart("auto-import-scan", "background dirs=" + autoImport.dirs.length);
  const seq = ++autoImportScanSeq;
  const before = shelfUI.count();
  setDirsStatus(reason, "busy");
  try {
    const list = await invoke("auto_import_scan");
    if (seq !== autoImportScanSeq) return;
    const added = Math.max(0, (list || []).length - before);
    shelfUI.render(list || []);
    if (added > 0) {
      setDirsStatus("导入完成，新增 " + added + " 本书", "ok");
      finishAutoImport("added=" + added);
      if (debugSettingOn("bg_fulltext_index")) {
        setTimeout(() => runWhenNoReader("keyword-index-after-import", () => invoke("build_shelf_index")), 1500);
      }
    } else {
      setDirsStatus("扫描完成，没有新书", "ok");
      finishAutoImport("added=0");
    }
  } catch (e) {
    startupPerfLog("auto-import-scan", "error", e && e.message ? e.message : String(e));
    if (seq === autoImportScanSeq) setDirsStatus("扫描失败：" + e, "error");
  }
}
// 自动导入开关
async function setAutoImportEnabled(enabled, opts = {}) {
  if (autoImportToggleBusy) return;
  autoImportToggleBusy = true;
  const prev = !!autoImport.enabled;
  autoImport.enabled = enabled;
  reflectAutoImport();
  if (enabled && !autoImport.dirs.length) {
    importDirsModal.classList.add("show"); // 还没设目录：顺手打开让用户添加
  }
  try {
    await applyAutoImport(enabled, Object.assign({
      scan: enabled && autoImport.dirs.length > 0,
      reason: "正在扫描并导入目录…",
      status: enabled ? "自动导入已开启" : "自动导入已关闭",
    }, opts));
  } catch (e) {
    autoImport.enabled = prev;
    reflectAutoImport();
  } finally {
    autoImportToggleBusy = false;
  }
}
setAutoChk.addEventListener("change", async () => {
  await setAutoImportEnabled(setAutoChk.checked);
});
if (importDirsEnabledChk) {
  importDirsEnabledChk.addEventListener("change", async (e) => {
    e.stopPropagation();
    await setAutoImportEnabled(importDirsEnabledChk.checked);
  });
}
if (importDirsEnabledRow) {
  importDirsEnabledRow.addEventListener("click", async (e) => {
    if (e.target === importDirsEnabledChk) return;
    e.preventDefault();
    e.stopPropagation();
    await setAutoImportEnabled(!autoImport.enabled);
  });
}
// 把当前 enabled + dirs 提交后端；扫描导入单独走后台，避免设置窗口卡住。
async function applyAutoImport(enabled, opts = {}) {
  try {
    const cfg = await invoke("set_auto_import", { enabled, dirs: autoImport.dirs });
    autoImport = cfg || { enabled, dirs: autoImport.dirs };
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
function backupBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}
function renderRecoveryBackupStatus(status) {
  if (!recoveryBackupStatus) return;
  recoveryBackupStatus.textContent = status.count
    ? ("已保留 " + status.count + " 个恢复点，共 " + backupBytes(status.total_bytes) +
       "；最近一次 " + status.latest + "。每日自动创建，最多保留 7 个。")
    : "尚无恢复点；软件会每日自动创建，最多保留 7 个。";
  recoveryBackupStatus.title = status.directory || "";
  const backups = Array.isArray(status.backups) ? status.backups : [];
  if (recoveryBackupActions) recoveryBackupActions.hidden = backups.length === 0;
  if (recoveryBackupSelect) {
    const selected = recoveryBackupSelect.value;
    recoveryBackupSelect.replaceChildren(...backups.map((backup) => {
      const option = document.createElement("option");
      option.value = backup.id;
      option.textContent = "恢复点 " + (backup.created_at || backup.id) + "（" + backupBytes(backup.total_bytes) + "）";
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
    if (recoveryBackupStatus) recoveryBackupStatus.textContent = "恢复点状态读取失败：" + e;
  });
}
document.getElementById("settings-toolbar-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openCommonSettings();
});
recoveryBackupButton?.addEventListener("click", async () => {
  recoveryBackupButton.disabled = true;
  recoveryBackupButton.textContent = "正在创建…";
  try {
    const status = await invoke("create_recovery_backup");
    renderRecoveryBackupStatus(status);
  } catch (e) {
    alert("创建恢复点失败：" + e);
  } finally {
    recoveryBackupButton.disabled = false;
    recoveryBackupButton.textContent = "立即创建";
  }
});
restoreRecoveryBackupButton?.addEventListener("click", async () => {
  const backupId = recoveryBackupSelect?.value;
  if (!backupId) return;
  const choice = recoveryBackupSelect.options[recoveryBackupSelect.selectedIndex]?.textContent || backupId;
  if (!confirm("恢复到“" + choice + "”吗？\n\n软件会先自动创建一个当前数据的保护恢复点，然后覆盖书架、统计、生词本和同步数据。请先关闭所有阅读窗口。")) return;
  restoreRecoveryBackupButton.disabled = true;
  restoreRecoveryBackupButton.textContent = "正在恢复…";
  try {
    const status = await invoke("restore_recovery_backup", { backupId });
    renderRecoveryBackupStatus(status);
    await refreshRecoveryBackupStatus();
    alert("数据已恢复。书架将重新加载以显示恢复后的内容。");
    window.location.reload();
  } catch (e) {
    alert("恢复数据失败：" + e);
  } finally {
    restoreRecoveryBackupButton.disabled = false;
    restoreRecoveryBackupButton.textContent = "恢复选中恢复点";
  }
});
document.getElementById("open-default-apps-settings")?.addEventListener("click", async () => {
  try {
    await invoke("open_default_apps_settings");
    alert("已打开 Windows 默认应用设置。请在“按文件类型选择默认值”中，分别将 .epub 和 .pdf 设为由“鲲鹏阅读器”打开。");
  } catch (e) {
    alert("打开默认应用设置失败：" + (e && e.message ? e.message : e));
  }
});
document.getElementById("fp-settings-close").addEventListener("click", () => fpSettingsModal.classList.remove("show"));
fpSettingsModal.addEventListener("click", (e) => {
  if (e.target === fpSettingsModal) fpSettingsModal.classList.remove("show");
});
// GitHub 链接：在系统默认浏览器打开，而不是在 WebView 里跳转。
document.getElementById("about-github")?.addEventListener("click", (e) => {
  e.preventDefault();
  invoke("open_url", { url: e.currentTarget.href }).catch(() => {});
});

// 语义设置由独立模块管理；这里只注入书架应用拥有的依赖。
window.ReaderSemanticUI.init({
  root: document,
  invoke,
  settingsModal: fpSettingsModal,
  cache: window.ReaderSemanticStatusCache,
  confirmAction: (message) => window.confirm(message),
});
// ---- 主设置页：外置词典 ----
const externalDictModal = document.getElementById("external-dict-modal");
const externalDictGear = document.getElementById("dict-gear");
const externalDictClose = document.getElementById("external-dict-close");
const externalDictAdd = document.getElementById("external-dict-add");
const externalDictList = document.getElementById("external-dict-list");
const externalDictStatus = document.getElementById("external-dict-status");
let externalDicts = [];

function setExternalDictStatus(text = "", kind = "") {
  if (!externalDictStatus) return;
  externalDictStatus.textContent = text || "";
  externalDictStatus.className = "ai-status" + (kind ? " " + kind : "");
}

function dictFormatBytes(n) {
  n = Number(n || 0);
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n ? n + " B" : "0 B";
}

function renderExternalDicts(list = externalDicts) {
  externalDicts = list || [];
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
    name.textContent = d.name || "未命名词典";
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
    path.textContent = d.source_path || "";
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
  fpSettingsModal.classList.remove("show");
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
let importStatusEl = null;
let importStatusTimer = 0;
function ensureImportStatus() {
  if (importStatusEl) return importStatusEl;
  importStatusEl = document.createElement("div");
  importStatusEl.className = "import-status";
  document.body.appendChild(importStatusEl);
  return importStatusEl;
}
function setImportStatus(text, kind = "busy") {
  const el = ensureImportStatus();
  clearTimeout(importStatusTimer);
  el.className = "import-status show " + kind;
  el.textContent = text || "";
}
function hideImportStatus(delay = 0) {
  clearTimeout(importStatusTimer);
  importStatusTimer = setTimeout(() => {
    if (importStatusEl) importStatusEl.classList.remove("show");
  }, delay);
}
async function importBookPaths(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) return;
  setImportStatus("准备导入 " + paths.length + " 本书...", "busy");
  try {
    const list = await startupTimed("manual-import", () => invoke("add_books", { paths }), paths.length + " files");
    setImportStatus("正在刷新书架...", "busy");
    shelfUI.render(list);
    setImportStatus("导入完成，共 " + paths.length + " 个文件", "ok");
    hideImportStatus(3200);
    if (debugSettingOn("bg_fulltext_index")) {
      runWhenNoReader("keyword-index-after-import", () => invoke("build_shelf_index")); // 后台为新书建检索索引
    }
    return list;
  } catch (e) {
    setImportStatus("导入失败：" + (e && e.message ? e.message : e), "error");
    hideImportStatus(7000);
    return null;
  }
}
let associatedBookOpenQueue = Promise.resolve();
function normalizeBookPath(path) {
  return String(path || "").replace(/\//g, "\\").toLocaleLowerCase();
}
async function openAssociatedBookPaths(paths) {
  paths = (paths || []).filter((path) => SUPPORTED.test(String(path || "")));
  if (!paths.length) return;
  const list = await importBookPaths(paths);
  if (!Array.isArray(list)) return;
  const wanted = new Set(paths.map(normalizeBookPath));
  const book = list.find((item) => wanted.has(normalizeBookPath(item.path)));
  if (book) await invoke("open_book", { id: String(book.id) });
}
function enqueueAssociatedBookOpen(paths) {
  associatedBookOpenQueue = associatedBookOpenQueue
    .then(() => openAssociatedBookPaths(paths))
    .catch((e) => setImportStatus("打开文件失败：" + (e && e.message ? e.message : e), "error"));
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
function escapeHtml(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
// ---- 笔记汇总 ----
const notesModal = document.getElementById("notes-modal");
const notesBody = document.getElementById("notes-body");
let notesData = [];
function renderNotes(data) {
  if (!data.length) {
    notesBody.innerHTML = '<div class="stats-empty">还没有高亮、批注或可关联的查词记录</div>';
    return;
  }
  notesBody.innerHTML = data.map((book) => {
    const highlights = (book.highlights || []).map((h) => (
      '<div class="note-item">' +
      '<div class="note-text">' + escapeHtml(h.text || "") + "</div>" +
      (h.context ? '<div class="note-context">' + escapeHtml(h.context) + "</div>" : "") +
      (h.note ? '<div class="note-note">' + escapeHtml(h.note) + "</div>" : "") +
      "</div>"
    )).join("");
    const words = (book.vocab || []).map((v) => (
      '<span class="note-word">' + escapeHtml(v.word || "") + (v.count ? " ×" + v.count : "") + "</span>"
    )).join("");
    return (
      '<section class="note-book">' +
      "<h3>" + escapeHtml(book.title || "未命名书籍") + "</h3>" +
      (highlights ? '<div class="note-sec"><h4>高亮 / 批注</h4>' + highlights + "</div>" : "") +
      (words ? '<div class="note-sec"><h4>查词</h4><div class="note-vocab">' + words + "</div></div>" : "") +
      "</section>"
    );
  }).join("");
}
function notesToMarkdown(data) {
  let md = "# 书籍笔记汇总\n\n";
  data.forEach((book) => {
    md += "## " + (book.title || "未命名书籍") + "\n\n";
    if ((book.highlights || []).length) {
      md += "### 高亮 / 批注\n\n";
      book.highlights.forEach((h) => {
        md += "- " + (h.text || "").replace(/\s+/g, " ").trim() + "\n";
        if (h.context) md += "  - 上下文：" + h.context.replace(/\s+/g, " ").trim() + "\n";
        if (h.note) md += "  - 批注：" + h.note.replace(/\s+/g, " ").trim() + "\n";
      });
      md += "\n";
    }
    if ((book.vocab || []).length) {
      md += "### 查词\n\n";
      book.vocab.forEach((v) => {
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
    notesData = await invoke("notes_summary");
    renderNotes(notesData);
  } catch (e) {
    notesBody.innerHTML = '<div class="stats-empty">读取失败：' + escapeHtml(String(e)) + "</div>";
  }
});
const libraryHealthModal = document.getElementById("library-health-modal");
const libraryHealthBody = document.getElementById("library-health-body");
function libraryHealthEscape(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function libraryHealthBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
}function renderLibraryHealth(report) {
  const missing = report.missing || [];
  const duplicates = report.duplicates || [];
  let html = '<div class="health-summary">' +
    `<span>书籍 ${report.total || 0} 本</span><span>文件正常 ${report.healthy || 0} 本</span>` +
    `<span>失效路径 ${missing.length} 本</span><span>重复组 ${duplicates.length} 组</span></div>`;
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
  const index = report.search_index || {};
  html += '</section><section class="health-section"><h4>全文索引与缓存</h4>' +
    '<div class="health-summary">' +
    `<span>压缩索引 ${index.binary_files || 0}</span><span>旧 JSON ${index.legacy_files || 0}</span>` +
    `<span>孤儿文件 ${index.orphan_files || 0}</span><span>磁盘 ${libraryHealthBytes(index.disk_bytes)}</span></div>` +
    `<div class="health-group-title">内存 LRU：${libraryHealthBytes(index.memory_bytes)} / ${libraryHealthBytes(index.memory_limit_bytes)}，${index.memory_entries || 0} 个缓存条目；磁盘上限 ${libraryHealthBytes(index.disk_limit_bytes)}。</div>` +
    '<button class="btn-plain health-index-clean" type="button">清理孤儿索引并执行配额治理</button></section>';
  libraryHealthBody.innerHTML = html;
  libraryHealthBody.querySelector(".health-index-clean")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
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
  libraryHealthBody.querySelectorAll(".health-relocate").forEach((button) => {
    button.addEventListener("click", async () => {
      const format = String(button.dataset.format || "").toLowerCase();
      const picked = await dialog.open({ multiple: false, filters: [{ name: "电子书", extensions: format ? [format] : ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      shelfUI.render(await invoke("relocate_book", { id: button.dataset.id, path }));
      await openLibraryHealth();
    });
  });
  libraryHealthBody.querySelectorAll(".health-merge").forEach((button) => {
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

// ---- 检查更新（后端多源：Gitee 优先、GitHub 兜底）----
const updateBar = document.getElementById("update-bar");
let pendingRelease = null;
// 比较两个版本号：a>b 返回 1，a<b 返回 -1，相等 0
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
function showUpdateBanner(ver, url) {
  pendingRelease = { ver, url: url || "" };
  document.getElementById("ub-ver").textContent = "v" + String(ver).replace(/^v/i, "");
  updateBar.classList.add("show");
}
// 每次启动都查一次（不再节流）；force=true 为手动检查，结果都给提示、并忽略“已忽略版本”
async function checkUpdate(force) {
  let info;
  try {
    info = await invoke("check_update");
  } catch (e) {
    if (force) alert("检查更新失败：" + e);
    return;
  }
  if (!info || !info.ok) {
    if (force) alert("检查更新失败：无法连接更新服务器，请检查网络后重试。");
    return;
  }
  if (!info.has_update) {
    if (force) {
      const btn = document.getElementById("about-update");
      if (btn) btn.textContent = "最新版本";
    }
    return;
  }
  if (!force) {
    const ignored = localStorage.getItem("ignoredUpdate");
    if (ignored && cmpVer(info.latest, ignored) <= 0) return; // 忽略过这个（或更早）版本
  }
  showUpdateBanner(info.latest, info.url);
}
document.getElementById("ub-view").addEventListener("click", () => {
  if (pendingRelease && pendingRelease.url) invoke("open_url", { url: pendingRelease.url }).catch(() => {});
});
document.getElementById("ub-ignore").addEventListener("click", () => {
  if (pendingRelease) localStorage.setItem("ignoredUpdate", pendingRelease.ver);
  updateBar.classList.remove("show");
});
document.getElementById("ub-close").addEventListener("click", () => updateBar.classList.remove("show"));
document.getElementById("about-update").addEventListener("click", () => {
  const btn = document.getElementById("about-update");
  if (btn) btn.textContent = "检查中…";
  checkUpdate(true);
});
// 关于弹窗里展示“本版更新内容”（取当前版本对应的 GitHub 发行说明，带本地缓存以便离线显示）
async function loadCurrentNotes() {
  const el = document.getElementById("about-notes");
  let ver = "";
  try {
    ver = await invoke("app_version");
  } catch (e) {}
  const v = "v" + String(ver || "").replace(/^v/i, "");
  const cached = localStorage.getItem("notes_" + v);
  el.textContent = cached || "加载中…";
  let notes = "";
  try {
    notes = await invoke("release_notes", { tag: v });
  } catch (e) {}
  notes = (notes || "").trim();
  if (notes) {
    localStorage.setItem("notes_" + v, notes);
    el.textContent = notes;
  } else if (!cached) {
    el.textContent = "（暂时无法获取更新说明：可能是网络问题，或该版本尚未发布说明）";
  }
}

// ---- 关于（从 ⋮ 菜单打开）----
const aboutModal = document.getElementById("about-modal");
document.getElementById("mi-about").addEventListener("click", () => {
  menuEl.classList.remove("show");
  aboutModal.classList.add("show");
  loadCurrentNotes();
});
document.getElementById("about-close").addEventListener("click", () => aboutModal.classList.remove("show"));
aboutModal.addEventListener("click", (e) => {
  if (e.target === aboutModal) aboutModal.classList.remove("show");
});

// ---- 拖拽导入 ----
const dropHint = document.getElementById("drop-hint");
const SUPPORTED = /\.(epub|pdf|txt|md|markdown|mobi|azw3|azw)$/i;
const tauriEvent = window.__TAURI__.event;
tauriEvent.listen("startup-perf", (e) => {
  const p = (e && e.payload) || {};
  startupPerfLog("rust:" + (p.name || "unknown"), p.phase || "mark", p.detail || "");
});
tauriEvent.listen("auto-import-progress", (e) => {
  const p = (e && e.payload) || {};
  if (!p.phase) return;
  if (p.phase === "scan") {
    setDirsStatus("正在扫描目录…已发现 " + (p.found || 0) + " 个文件", "busy");
  } else if (p.phase === "import") {
    setDirsStatus("正在导入 " + (p.processed || 0) + "/" + (p.total || 0) + "，已新增 " + (p.added || 0) + " 本" + (p.current ? "：" + p.current : ""), "busy");
  } else if (p.phase === "done") {
    setDirsStatus("扫描完成，新增 " + (p.added || 0) + " 本书", "ok");
  }
});
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
  const paths = ((e.payload && e.payload.paths) || []).filter((p) => SUPPORTED.test(p));
  if (paths.length) await importBookPaths(paths);
});
// ---- 单本图书信息与相关内容 ----
const coverBtn = document.getElementById("cover-btn");
const bookInfoBtn = document.getElementById("book-info-btn");
const similarBooksBtn = document.getElementById("similar-books-btn");
const readingTimelineBtn = document.getElementById("reading-timeline-btn");
const bookInfoModal = document.getElementById("book-info-modal");
const bookInfoTitle = document.getElementById("book-info-title");
const bookInfoDesc = document.getElementById("book-info-desc");
const bookInfoStars = document.getElementById("book-info-stars");
const similarBooksModal = document.getElementById("similar-books-modal");
const similarBooksSource = document.getElementById("similar-books-source");
const similarBooksList = document.getElementById("similar-books-list");
let currentInfoBookId = "";

function timelineDateTime(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
}
function timelineDayLabel(day) {
  const raw = String(day || "");
  return raw.length === 8 ? `${raw.slice(4, 6)}/${raw.slice(6)}` : "—";
}
function timelineAxisTime(seconds) {
  const minutes = Math.round(Number(seconds || 0) / 60);
  return minutes >= 60 ? `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)}时` : `${minutes}分`;
}
function timelineAxisWords(words) {
  words = Number(words || 0);
  return words >= 10000 ? `${(words / 10000).toFixed(1)}万` : `${Math.round(words)}`;
}
function timelineDailyBars(buckets) {
  const days = new Map();
  (buckets || []).forEach((bucket) => {
    const key = String(bucket.day || "");
    const item = days.get(key) || { day: bucket.day, seconds: 0, words: 0 };
    item.seconds += Number(bucket.seconds || 0);
    item.words += Number(bucket.words || 0);
    days.set(key, item);
  });
  const items = [...days.values()].sort((a, b) => Number(a.day) - Number(b.day)).slice(-28);
  if (!items.length) return '<div class="stats-empty">暂无历史阅读时段</div>';
  const maxSeconds = Math.max(...items.map((item) => item.seconds), 1);
  const maxWords = Math.max(...items.map((item) => item.words), 1);
  return `<div class="timeline-legend"><span><i class="time"></i>阅读时长</span><span><i class="words"></i>阅读字数</span><span class="timeline-peak">峰值参考：${fmtTime(maxSeconds)} · ${fmtWords(maxWords)}</span></div>` +
    (() => {
      const plotWidth = Math.max(640, items.length * 58);
      const axisWidth = 48, chartWidth = plotWidth + axisWidth * 2;
      const top = 24, baseline = 170, chartHeight = baseline - top;
      const left = axisWidth, right = left + plotWidth;
      const step = plotWidth / items.length;
      const grid = Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const y = baseline - chartHeight * ratio;
        return `<line class="timeline-gridline" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text class="timeline-axis-time" x="${left - 7}" y="${y + 4}" text-anchor="end">${timelineAxisTime(maxSeconds * ratio)}</text><text class="timeline-axis-words" x="${right + 7}" y="${y + 4}">${timelineAxisWords(maxWords * ratio)}</text>`;
      }).join("");
      const bars = items.map((item, index) => {
      const timeHeight = Math.max(1, Math.round(item.seconds / maxSeconds * chartHeight));
      const wordsHeight = Math.max(1, Math.round(item.words / maxWords * chartHeight));
      const raw = String(item.day || "");
      const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : "未知日期";
      const tip = `${date} · 阅读 ${fmtTime(item.seconds)} · ${fmtWords(item.words)}`;
      const x = Math.round(left + index * step + step / 2);
      const tooltipWidth = 126, tooltipHeight = 52;
      const tooltipX = Math.max(left, Math.min(x - tooltipWidth / 2, right - tooltipWidth));
      return `<g class="timeline-bar-group"><title>${tip}</title><rect x="${x - 8}" y="${baseline - timeHeight}" width="7" height="${timeHeight}" rx="2" fill="#3778df"/><rect x="${x + 2}" y="${baseline - wordsHeight}" width="7" height="${wordsHeight}" rx="2" fill="#8053ca"/><text class="timeline-day-label" x="${x}" y="188" text-anchor="middle">${timelineDayLabel(item.day)}</text><g class="timeline-svg-tooltip" pointer-events="none"><rect x="${tooltipX}" y="${top + 5}" width="${tooltipWidth}" height="${tooltipHeight}" rx="5"/><text x="${tooltipX + 8}" y="${top + 21}">${date}</text><text x="${tooltipX + 8}" y="${top + 36}">时长 ${fmtTime(item.seconds)} · ${fmtWords(item.words)}</text></g></g>`;
      }).join("");
      return `<div class="timeline-chart" aria-label="每日阅读时长和字数柱状图"><svg viewBox="0 0 ${chartWidth} 196" role="img">${grid}${bars}</svg></div>`;
    })() + '<div class="timeline-chart-note">左轴为时长、右轴为字数；横线为两项峰值参考线。悬停任一天柱组可查看具体数据</div>';
}
async function openReadingTimeline() {
  if (!currentInfoBookId) return;
  const modal = document.getElementById("reading-timeline-modal");
  const body = document.getElementById("reading-timeline-body");
  bookInfoModal.classList.remove("show");
  modal.classList.add("show");
  body.innerHTML = '<div class="stats-empty">正在整理阅读记录…</div>';
  try {
    const data = await invoke("book_reading_timeline", { id: currentInfoBookId });
    document.getElementById("reading-timeline-title").textContent = "阅读时间线 · " + (data.title || "");
    const events = (data.events || []).slice().reverse();
    const eventHtml = events.length ? events.map((event) =>
      `<div class="timeline-event"><time>${timelineDateTime(event.at)}</time><span>第 ${Number(event.chapter || 0) + 1} 章</span><span class="timeline-progress">${Number(event.progress || 0).toFixed(1)}%</span></div>`
    ).join("") : '<div class="stats-empty">从现在起，阅读到新的章节或进度时会记录在这里。</div>';
    body.innerHTML = `<section class="timeline-section"><h4>何时阅读</h4>${timelineDailyBars(data.buckets)}</section><section class="timeline-section"><h4>每天最后读到哪里</h4>${eventHtml}</section>`;
  } catch (e) {
    body.innerHTML = '<div class="stats-empty">读取失败：' + libraryHealthEscape(e) + '</div>';
  }
}
readingTimelineBtn.addEventListener("click", openReadingTimeline);
document.getElementById("reading-timeline-close").addEventListener("click", () => document.getElementById("reading-timeline-modal").classList.remove("show"));
document.getElementById("reading-timeline-modal").addEventListener("click", (e) => { if (e.target.id === "reading-timeline-modal") e.currentTarget.classList.remove("show"); });

function fmtWords(n) {
  n = n || 0;
  if (n >= 10000) return (n / 10000).toFixed(2) + " 万字";
  return n + " 字";
}
function fmtSize(bytes) {
  bytes = bytes || 0;
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + "M";
  if (bytes >= 1024) return Math.round(bytes / 1024) + "K";
  return bytes + "B";
}
async function openSelectedBookInfo() {
  const selectedIds = shelfUI.getSelectedIds();
  if (selectedIds.length !== 1) return;
  currentInfoBookId = String(selectedIds[0]);
  bookInfoModal.classList.add("show");
  document.getElementById("book-info-words").textContent = "统计中…";
  try {
    const m = await invoke("book_meta_by_id", { id: currentInfoBookId });
    bookInfoTitle.value = m.title || "";
    document.getElementById("book-info-author").textContent = m.author || "未知";
    document.getElementById("book-info-format").textContent = (m.format || "").toUpperCase();
    document.getElementById("book-info-words").textContent = fmtWords(m.word_count);
    document.getElementById("book-info-size").textContent = fmtSize(m.size);
    bookInfoDesc.textContent = m.description || "";
    bookInfoStars.setVal(m.rating || 0);
  } catch (e) {
    document.getElementById("book-info-words").textContent = "读取失败：" + e;
  }
}
shelfUI.makeStars(bookInfoStars, (rating) => {
  if (!currentInfoBookId) return;
  bookInfoStars.setVal(rating);
  shelfUI.updateBook(currentInfoBookId, { rating });
  invoke("set_book_rating", { id: currentInfoBookId, rating }).catch(() => {});
});
bookInfoBtn.addEventListener("click", openSelectedBookInfo);
document.getElementById("book-info-close").addEventListener("click", () => bookInfoModal.classList.remove("show"));
bookInfoModal.addEventListener("click", (e) => {
  if (e.target === bookInfoModal) bookInfoModal.classList.remove("show");
});
bookInfoTitle.addEventListener("blur", async () => {
  if (!currentInfoBookId) return;
  const title = bookInfoTitle.value.trim();
  if (!title) {
    const b = shelfUI.getBook(currentInfoBookId);
    bookInfoTitle.value = b?.title || "";
    return;
  }
  try {
    await invoke("set_book_title", { id: currentInfoBookId, title });
    shelfUI.updateBook(currentInfoBookId, { title });
  } catch (e) {
    alert("保存书名失败：" + e);
  }
});
bookInfoDesc.addEventListener("blur", () => {
  if (!currentInfoBookId) return;
  const description = bookInfoDesc.textContent.trim();
  shelfUI.updateBook(currentInfoBookId, { description });
  invoke("set_book_description", { id: currentInfoBookId, description }).catch(() => {});
});

function renderSimilarCover(b) {
  const cover = document.createElement("div");
  cover.className = "similar-cover";
  if (b.cover) {
    cover.classList.add("has-img");
    const img = document.createElement("img");
    img.alt = b.title || "";
    img.src = b.cover;
    cover.appendChild(img);
  } else {
    cover.style.background = shelfUI.coverColor(b.title || "");
    const spine = document.createElement("div");
    spine.className = "spine";
    const gen = document.createElement("div");
    gen.className = "gen";
    gen.textContent = b.title || "未命名";
    cover.append(spine, gen);
  }
  return cover;
}
function renderSimilarBooks(sourceTitle, list) {
  similarBooksSource.textContent = sourceTitle ? "基于《" + sourceTitle + "》的正文语义相似度" : "基于正文语义相似度";
  similarBooksList.innerHTML = "";
  if (!list.length) {
    similarBooksList.innerHTML = '<div class="similar-empty">没有找到相似图书。可能需要先建立语义索引，或其它图书尚未参与索引。</div>';
    return;
  }
  list.forEach((b) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "similar-item";
    item.appendChild(renderSimilarCover(b));
    const body = document.createElement("div");
    body.className = "similar-body";
    const title = document.createElement("div");
    title.className = "similar-title";
    title.textContent = b.title || "未命名";
    const meta = document.createElement("div");
    meta.className = "similar-meta";
    const pct = Math.round(Math.max(0, Math.min(1, Number(b.score || 0))) * 100);
    meta.textContent = (b.author ? b.author + " · " : "") + "相关性 " + pct + "%";
    const bar = document.createElement("div");
    bar.className = "similar-score";
    const fill = document.createElement("span");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    body.append(title, meta, bar);
    item.appendChild(body);
    item.addEventListener("click", () => {
      similarBooksModal.classList.remove("show");
      clearCrossReturnMemory();
      invoke("open_book", { id: b.id }).catch((e) => alert("打开失败：" + e));
    });
    similarBooksList.appendChild(item);
  });
}
async function openSimilarBooks(id = currentInfoBookId) {
  if (!id) return;
  id = String(id);
  const source = shelfUI.getBook(id);
  similarBooksModal.classList.add("show");
  similarBooksSource.textContent = source ? "基于《" + source.title + "》的正文语义相似度" : "基于正文语义相似度";
  similarBooksList.innerHTML = '<div class="similar-empty">正在计算相似图书…</div>';
  try {
    const list = await invoke("similar_books", { id });
    renderSimilarBooks(source && source.title, list || []);
  } catch (e) {
    similarBooksList.innerHTML = '<div class="similar-empty">读取失败：' + escapeHtml(String(e || "")) + "</div>";
  }
}
similarBooksBtn.addEventListener("click", () => openSimilarBooks());
document.getElementById("similar-books-close").addEventListener("click", () => similarBooksModal.classList.remove("show"));
similarBooksModal.addEventListener("click", (e) => {
  if (e.target === similarBooksModal) similarBooksModal.classList.remove("show");
});

// 图书信息里的单本操作。
coverBtn.addEventListener("click", () => {
  if (!currentInfoBookId) return;
  shelfUI.changeCoverById(currentInfoBookId);
});

// 书架选择、批量删除与焦点刷新由 ReaderShelfUI 管理。
window.addEventListener("DOMContentLoaded", () => {
  // 启动：先用 list_books 快速返回现有书架，让菜单栏立刻可点；旧数据元信息回填延后执行。
    startupPerfLog("startup", "schedule", "critical=list_books+cover-render background=sync/settings/import/index/update");
    startupTimed("shelf-list-books", () => invoke("list_books"), "critical")
      .then((list) => {
        startupPerfLog("shelf-list-books", "data", "books=" + ((list && list.length) || 0));
        shelfUI.render(list);
        return invoke("take_startup_book_paths");
      })
      .then((paths) => enqueueAssociatedBookOpen(paths))
      .catch(() => {})
      .finally(() => {
        startupPerfLog("startup", "interactive", "main toolbar should be responsive");
      });
    setTimeout(() => {
      if (!debugSettingOn("bg_cover_preload")) return;
      runWhenNoReader("shelf-books-backfill", () => invoke("shelf_books").then((list) => shelfUI.render(list)));
    }, 10000);
    // 读取自动导入配置并反映到设置面板。真正扫描延后，避免和首屏封面加载抢资源。
    setTimeout(() => {
      // 账号状态始终从 SQLite 恢复；后台开关只控制联网同步，不能让已登录账号看起来丢失。
      startupTimed("sync-settings", async () => {
        await syncUI.loadSettingsOnce();
        if (debugSettingOn("bg_sync")) await syncUI.syncOnStartup();
      }, "background").catch(() => {});
    }, 1200);
    startupTimed("auto-import-config", () => invoke("get_auto_import"), "background")
      .then((c) => { autoImport = c || autoImport; reflectAutoImport(); })
      .catch(() => {});
    setTimeout(() => {
      if (!debugSettingOn("bg_auto_import")) return;
      if (!autoImport.enabled || !autoImport.dirs || !autoImport.dirs.length) return;
      runWhenNoReader("auto-import-scan", () => startAutoImportScan("正在自动扫描导入目录…"));
    }, 20000);
    // 字数统计是锦上添花，延后到启动稳定之后。
    setTimeout(() => {
      if (!debugSettingOn("reader_words_detect")) return;
      runWhenNoReader("word-counts", () => invoke("compute_word_counts"));
    }, 25000);
    // 启动后台检查更新（不阻塞启动，每次启动查一次）
    setTimeout(() => {
      if (!debugSettingOn("bg_update_check")) return;
      runWhenNoReader("update-check", () => checkUpdate(false));
    }, 15000);
    // “关于”里的版本号取自后端，保持单一来源
    startupTimed("app-version", () => invoke("app_version"), "background")
      .then((v) => {
        const el = document.getElementById("about-ver");
        if (el && v) el.textContent = "v" + String(v).replace(/^v/i, "");
      })
      .catch(() => {});
}, { once: true });
