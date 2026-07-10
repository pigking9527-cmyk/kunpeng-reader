// 书架页逻辑
const invoke = window.__TAURI__.core.invoke;
const dialog = window.__TAURI__.dialog;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单

// 禁用浏览器自带查找（Ctrl+F / F3）
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

const shelfEl = document.getElementById("shelf");
const emptyEl = document.getElementById("empty");
const contentEl = document.querySelector(".content");
const shelfScrollbar = document.getElementById("shelf-scrollbar");
const shelfScrollbarThumb = document.getElementById("shelf-scrollbar-thumb");
const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const toolbarEl = document.querySelector(".toolbar");

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

let books = []; // 当前书架（原始顺序，供“随机打开”用）
let sortKey = localStorage.getItem("shelfSort") || "title";
if (sortKey === "rating") sortKey = "title"; // 已移除“按评分排序”，旧设置回落到书名
let layout = localStorage.getItem("shelfLayout") || "grid";
const GRID_COL_MIN = 1;
const GRID_COL_MAX = 12;
function parseGridColumns(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(GRID_COL_MIN, Math.min(GRID_COL_MAX, n));
}
let shelfGridColumns = parseGridColumns(localStorage.getItem("shelfGridColumns") || "0"); // 0=默认自适应
let shelfGridColumnsValue = parseGridColumns(localStorage.getItem("shelfGridColumnsValue") || "3") || 3;
let readingFilter = { unread: true, reading: true, done: true };
try {
  readingFilter = Object.assign(readingFilter, JSON.parse(localStorage.getItem("readingFilter") || "{}"));
} catch (e) {}
let minRating = +(localStorage.getItem("minRating") || 0); // 评分过滤下限（0=不过滤）
// 书架渲染/排序/滚动在 shelf-ui.js；这里保留状态与应用事件。
let searchQuery = "";
let selected = new Set(); // 已选中的图书 id（单击封面切换）
let shelfLoaded = false;
let showCoverProgress = localStorage.getItem("showCoverProgress") !== "0"; // 封面右下角是否显示阅读进度
let showCoverRating = localStorage.getItem("showCoverRating") !== "0"; // 封面上是否显示评分小星
let showCoverTitle = localStorage.getItem("showCoverTitle") === "1"; // 网格视图封面下是否显示书名（默认不显示）

function closeMainFloaters(options = {}) {
  if (!options.keepMenu) menuEl.classList.remove("show");
  if (!options.keepFilter) filterPanel.classList.remove("show");
  if (!options.keepAccount) closeAccountPanel();
  if (!options.keepSearch) {
    hideHistory();
    if (!searchInput.value.trim() && !searchQuery) {
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

// ---- 排序与布局面板 ----
document.getElementById("filter-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuEl.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  filterPanel.classList.toggle("show");
});
filterPanel.addEventListener("click", (e) => e.stopPropagation()); // 面板内点击不收起

document.querySelectorAll('input[name="sort"]').forEach((r) => {
  r.checked = r.value === sortKey;
  r.addEventListener("change", () => {
    if (r.checked) {
      sortKey = r.value;
      localStorage.setItem("shelfSort", sortKey);
      applyView();
    }
  });
});

// 阅读过滤复选框
document.querySelectorAll(".rfilter").forEach((c) => {
  c.checked = !!readingFilter[c.value];
  c.addEventListener("change", () => {
    readingFilter[c.value] = c.checked;
    localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
    applyView();
  });
});

// 评分过滤：五颗星（支持半星），点星=只看≥该评分的书，再点同一处取消
// 通用半星组件：左半=半星、右半=整星，悬停预览，点击回调 onPick(value)
function makeStars(container, onPick) {
  for (let i = 0; i < 5; i++) {
    const st = document.createElement("span");
    st.className = "star";
    const bg = document.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = document.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    st.append(bg, fg);
    container.appendChild(st);
  }
  const stars = [...container.querySelectorAll(".star")];
  function paint(v) {
    stars.forEach((st, i) => {
      const f = Math.max(0, Math.min(1, v - i));
      st.querySelector(".s-fg").style.width = f * 100 + "%";
    });
  }
  function valAt(e) {
    for (let i = 0; i < stars.length; i++) {
      const r = stars[i].getBoundingClientRect();
      if (e.clientX <= r.right) return i + (e.clientX < r.left + r.width / 2 ? 0.5 : 1);
    }
    return 5;
  }
  container.addEventListener("mousemove", (e) => paint(valAt(e)));
  container.addEventListener("mouseleave", () => paint(container._val || 0));
  container.addEventListener("click", (e) => {
    let v = valAt(e);
    if (v === container._val) v = 0;
    container._val = v;
    paint(v);
    onPick(v);
  });
  container.setVal = (v) => {
    container._val = v || 0;
    paint(container._val);
  };
  paint(0);
}
const filterStarsEl = document.getElementById("filter-stars");
makeStars(filterStarsEl, (v) => {
  minRating = v > 0 && books.length && !books.some((b) => (b.rating || 0) >= v) ? 0 : v;
  if (minRating > 0) localStorage.setItem("minRating", String(minRating));
  else localStorage.removeItem("minRating");
  filterStarsEl.setVal(minRating);
  applyView();
});
filterStarsEl.setVal(minRating);

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
  const before = books.length;
  setDirsStatus(reason, "busy");
  try {
    const list = await invoke("auto_import_scan");
    if (seq !== autoImportScanSeq) return;
    const added = Math.max(0, (list || []).length - before);
    render(list || []);
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
// 封面显示阅读进度开关
const setCoverProg = document.getElementById("set-cover-prog");
setCoverProg.checked = showCoverProgress;
setCoverProg.addEventListener("change", () => {
  showCoverProgress = setCoverProg.checked;
  localStorage.setItem("showCoverProgress", showCoverProgress ? "1" : "0");
  applyView();
});
// 封面上显示评分小星开关
const setCoverRating = document.getElementById("set-cover-rating");
setCoverRating.checked = showCoverRating;
setCoverRating.addEventListener("change", () => {
  showCoverRating = setCoverRating.checked;
  localStorage.setItem("showCoverRating", showCoverRating ? "1" : "0");
  applyView();
});
// 封面下显示书名开关
const setCoverTitle = document.getElementById("set-cover-title");
setCoverTitle.checked = showCoverTitle;
setCoverTitle.addEventListener("change", () => {
  showCoverTitle = setCoverTitle.checked;
  localStorage.setItem("showCoverTitle", showCoverTitle ? "1" : "0");
  applyView();
});
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
function openCommonSettings() {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  fpSettingsModal.classList.add("show");
}
document.getElementById("settings-toolbar-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openCommonSettings();
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

// ---- 主设置页：语义模型 / 语义索引 / 加速索引 / 多中心画像 ----
const semanticIndexModal = document.getElementById("semantic-index-modal");
const semanticGearBtn = document.getElementById("semantic-gear");
const semanticIndexCloseBtn = document.getElementById("semantic-index-close");
const semModelMeta = document.getElementById("sem-model-meta");
const semVectorMeta = document.getElementById("sem-vector-meta");
const semAccelMeta = document.getElementById("sem-accel-meta");
const semMultiMeta = document.getElementById("sem-multi-meta");
const semStatusEl = document.getElementById("sem-status");
const semVectorBar = document.getElementById("sem-vector-bar");
const semAccelBar = document.getElementById("sem-accel-bar");
const semMultiBar = document.getElementById("sem-multi-bar");
const semModelDownloadBtn = document.getElementById("sem-model-download");
const semModelDeleteBtn = document.getElementById("sem-model-delete");
const semVectorBuildBtn = document.getElementById("sem-vector-build");
const semVectorDeleteBtn = document.getElementById("sem-vector-delete");
const semAccelBuildBtn = document.getElementById("sem-accel-build");
const semAccelDeleteBtn = document.getElementById("sem-accel-delete");
const semMultiBuildBtn = document.getElementById("sem-multi-build");
const semMultiDeleteBtn = document.getElementById("sem-multi-delete");
let semStatusPoll = null;
let semStatusInFlight = false;
const SEM_STATUS_KEY = "semanticIndexStatusV1";
let lastSemStatus = loadSemanticStatusCache();

function semanticStatusSnapshot(p = {}) {
  return {
    model_ready: !!p.model_ready,
    model_path: p.model_path || "",
    model_bytes: Number(p.model_bytes || 0),
    semantic_done: Number(p.semantic_done || 0),
    semantic_total: Number(p.semantic_total || 0),
    semantic_ready: !!p.semantic_ready,
    semantic_bytes: Number(p.semantic_bytes || 0),
    accelerator_done: Number(p.accelerator_done || 0),
    accelerator_total: Number(p.accelerator_total || 0),
    accelerator_ready: !!p.accelerator_ready,
    accelerator_resumable: !!p.accelerator_resumable,
    accelerator_bytes: Number(p.accelerator_bytes || 0),
    multi_profile_done: Number(p.multi_profile_done || 0),
    multi_profile_total: Number(p.multi_profile_total || 0),
    multi_profile_ready: !!p.multi_profile_ready,
    multi_profile_bytes: Number(p.multi_profile_bytes || 0),
    saved_at: Date.now(),
  };
}

function loadSemanticStatusCache() {
  try {
    const p = JSON.parse(localStorage.getItem(SEM_STATUS_KEY) || "null");
    return p && typeof p === "object" ? p : null;
  } catch (e) {
    return null;
  }
}

function saveSemanticStatusCache(p = {}) {
  const snap = semanticStatusSnapshot(p);
  if (!snap.model_ready && !snap.semantic_total && !snap.accelerator_total && !snap.multi_profile_total) return;
  lastSemStatus = snap;
  try {
    localStorage.setItem(SEM_STATUS_KEY, JSON.stringify(snap));
  } catch (e) {}
}

function clearSemanticStatusCache() {
  lastSemStatus = null;
  try {
    localStorage.removeItem(SEM_STATUS_KEY);
  } catch (e) {}
}

function updateSemanticStatusCache(patch = {}) {
  const base = lastSemStatus || semanticStatusSnapshot({});
  lastSemStatus = Object.assign({}, base, patch, { saved_at: Date.now() });
  try {
    localStorage.setItem(SEM_STATUS_KEY, JSON.stringify(lastSemStatus));
  } catch (e) {}
}

function mergeSemanticStatusWithCache(p = {}) {
  if (!p.status_refreshing || !lastSemStatus) return p;
  return Object.assign({}, lastSemStatus, p, {
    model_ready: p.model_ready || lastSemStatus.model_ready,
    model_path: p.model_path || lastSemStatus.model_path || "",
    model_bytes: p.model_bytes || lastSemStatus.model_bytes || 0,
    semantic_done: p.semantic_done || lastSemStatus.semantic_done || 0,
    semantic_total: p.semantic_total || lastSemStatus.semantic_total || 0,
    semantic_ready: p.semantic_ready || lastSemStatus.semantic_ready,
    semantic_bytes: p.semantic_bytes || lastSemStatus.semantic_bytes || 0,
    accelerator_done: p.accelerator_done || lastSemStatus.accelerator_done || 0,
    accelerator_total: p.accelerator_total || lastSemStatus.accelerator_total || 0,
    accelerator_ready: p.accelerator_ready || lastSemStatus.accelerator_ready,
    accelerator_resumable: p.accelerator_resumable || lastSemStatus.accelerator_resumable,
    accelerator_bytes: p.accelerator_bytes || lastSemStatus.accelerator_bytes || 0,
    multi_profile_done: p.multi_profile_done || lastSemStatus.multi_profile_done || 0,
    multi_profile_total: p.multi_profile_total || lastSemStatus.multi_profile_total || 0,
    multi_profile_ready: p.multi_profile_ready || lastSemStatus.multi_profile_ready,
    multi_profile_bytes: p.multi_profile_bytes || lastSemStatus.multi_profile_bytes || 0,
  });
}

function semBytes(n) {
  n = Number(n || 0);
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n ? n + " B" : "0 B";
}

function setSemBar(bar, done, total, ready) {
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
  if (bar) {
    bar.style.width = pct + "%";
    bar.parentElement?.classList.toggle("done", !!ready);
  }
}

function setSemStatus(text = "", kind = "") {
  if (!semStatusEl) return;
  semStatusEl.textContent = text || "";
  semStatusEl.className = "ai-status" + (kind ? " " + kind : "");
}

function semTask(center, id) {
  return Array.isArray(center?.tasks) ? center.tasks.find((t) => t.id === id) : null;
}

function renderSemanticStatus(p = {}) {
  const center = Array.isArray(p?.tasks) ? p : null;
  if (center) p = center.progress || {};
  p = mergeSemanticStatusWithCache(p);
  const busy = !!(p.building || p.model_downloading);
  const refreshing = !!p.status_refreshing;
  // 后端正在后台校验时，任务 detail 只是“正在读取…”。优先展示上次可靠快照，
  // 避免四张卡片一起闪回加载态；按钮仍保持禁用直到校验完成。
  const taskSource = refreshing && lastSemStatus ? null : center;
  const modelTask = semTask(taskSource, "semantic_model");
  const vectorTask = semTask(taskSource, "semantic_vectors");
  const accelTask = semTask(taskSource, "semantic_accelerator");
  const multiTask = semTask(taskSource, "semantic_multi_profile");
  const activeTask = p.active_task || "";
  const vectorLive = p.building && p.total > 0 && (
    activeTask === "semantic_vectors" ||
    activeTask === "semantic_full" ||
    (!activeTask && !p.shard_total)
  );
  const vectorDone = vectorLive ? (p.done || 0) : (p.semantic_done || 0);
  const vectorTotal = vectorLive ? (p.total || 0) : (p.semantic_total || 0);
  const accelDone = p.accelerator_done || 0;
  const accelTotal = p.accelerator_total || 0;
  const multiDone = p.multi_profile_done || 0;
  const multiTotal = p.multi_profile_total || 0;
  const vectorSize = p.semantic_bytes ? "，占用 " + semBytes(p.semantic_bytes) : "";
  const accelSize = p.accelerator_bytes ? "，占用 " + semBytes(p.accelerator_bytes) : "";
  const multiSize = p.multi_profile_bytes ? "，占用 " + semBytes(p.multi_profile_bytes) : "";

  semModelMeta.textContent = modelTask?.detail
    ? (modelTask.detail + (modelTask.bytes ? "，缓存大小 " + semBytes(modelTask.bytes) : ""))
    : p.model_downloading
    ? "正在下载/加载模型…"
    : (p.model_ready ? ("已就绪" + (p.model_bytes ? "，缓存大小 " + semBytes(p.model_bytes) : "")) : (refreshing ? "正在读取模型状态…" : "未下载。首次下载约 120MB。"));
  semVectorMeta.textContent = vectorTask?.detail
    ? (vectorTask.detail + (vectorTask.bytes ? "，占用 " + semBytes(vectorTask.bytes) : ""))
    : refreshing && !vectorTotal
    ? "正在读取语义索引状态…"
    : (vectorTotal
    ? (vectorDone + "/" + vectorTotal + " 本" + (p.semantic_ready ? "，已完成" : "") + vectorSize)
    : "书架中暂无可建立语义索引的图书");
  semAccelMeta.textContent = accelTask?.detail
    ? (accelTask.detail + (accelTask.bytes ? "，占用 " + semBytes(accelTask.bytes) : ""))
    : refreshing && !accelTotal
    ? "正在读取加速索引状态…"
    : (accelTotal
    ? (accelDone + "/" + accelTotal + " 片" + (p.accelerator_ready ? "，已完成" : (p.accelerator_resumable ? "，可续建" : "")) + accelSize)
    : "建立语义索引后可建立加速索引");
  semMultiMeta.textContent = multiTask?.detail
    ? (multiTask.detail + (multiTask.bytes ? "，占用 " + semBytes(multiTask.bytes) : ""))
    : refreshing && !multiTotal
    ? "正在读取多中心画像状态…"
    : (multiTotal
    ? (multiDone + "/" + multiTotal + " 本" + (p.multi_profile_ready ? "，已完成" : (multiDone ? "，需要更新" : "")) + multiSize)
    : "建立语义索引后可生成多中心画像");

  setSemBar(semVectorBar, vectorTask?.done ?? vectorDone, vectorTask?.total ?? vectorTotal, vectorTask?.ready ?? p.semantic_ready);
  setSemBar(semAccelBar, accelTask?.done ?? accelDone, accelTask?.total ?? accelTotal, accelTask?.ready ?? p.accelerator_ready);
  setSemBar(semMultiBar, multiTask?.done ?? multiDone, multiTask?.total ?? multiTotal, multiTask?.ready ?? p.multi_profile_ready);

  semModelDownloadBtn.disabled = modelTask ? !modelTask.can_start : (busy || refreshing);
  semModelDeleteBtn.disabled = modelTask ? !modelTask.can_delete : (busy || !p.model_ready);
  semVectorBuildBtn.disabled = vectorTask ? !vectorTask.can_start : (busy || refreshing || !p.model_ready || !vectorTotal);
  semVectorDeleteBtn.disabled = vectorTask ? !vectorTask.can_delete : (busy || vectorDone <= 0);
  semAccelBuildBtn.disabled = accelTask ? !accelTask.can_start : (busy || refreshing || !p.model_ready || vectorDone <= 0);
  semAccelDeleteBtn.disabled = accelTask ? !accelTask.can_delete : (busy || (!p.accelerator_ready && accelDone <= 0));
  semMultiBuildBtn.disabled = multiTask ? !multiTask.can_start : (busy || refreshing || vectorDone <= 0);
  semMultiDeleteBtn.disabled = multiTask ? !multiTask.can_delete : (busy || !p.multi_profile_bytes);
  semModelDownloadBtn.textContent = modelTask?.primary_label || "下载模型";
  semModelDeleteBtn.textContent = modelTask?.delete_label || "删除模型";
  semVectorBuildBtn.textContent = vectorTask?.primary_label || (vectorDone > 0 && !p.semantic_ready ? "续建语义索引" : "建立语义索引");
  semVectorDeleteBtn.textContent = vectorTask?.delete_label || "删除";
  semAccelBuildBtn.textContent = accelTask?.primary_label || (p.accelerator_resumable ? "续建加速索引" : "建立加速索引");
  semAccelDeleteBtn.textContent = accelTask?.delete_label || "删除";
  semMultiBuildBtn.textContent = multiTask?.primary_label || (multiDone > 0 && !p.multi_profile_ready ? "更新多中心画像" : "建立多中心画像");
  semMultiDeleteBtn.textContent = multiTask?.delete_label || "删除";

  if (p.error) setSemStatus(p.error, "error");
  else if (p.model_downloading || p.building) setSemStatus(p.current || "任务正在后台运行…", "busy");
  else if (refreshing) setSemStatus("正在后台读取索引状态…", "busy");
  else setSemStatus(p.current || "", p.current ? "ok" : "");

  const shouldPoll = !!(p.model_downloading || p.building || refreshing);
  if (shouldPoll && !semStatusPoll) {
    semStatusPoll = setInterval(refreshSemanticStatus, 1500);
  } else if (!shouldPoll && semStatusPoll) {
    clearInterval(semStatusPoll);
    semStatusPoll = null;
  }
  if (!refreshing || p.model_ready || vectorTotal || accelTotal || multiTotal || p.building || p.model_downloading) saveSemanticStatusCache(p);
}

async function refreshSemanticStatus() {
  if (semStatusInFlight) return;
  semStatusInFlight = true;
  try {
    renderSemanticStatus(await invoke("semantic_tasks"));
  } catch (e) {
    setSemStatus("读取语义索引状态失败：" + e, "error");
  } finally {
    semStatusInFlight = false;
  }
}

function openSemanticIndexSettings() {
  fpSettingsModal.classList.remove("show");
  semanticIndexModal.classList.add("show");
  if (lastSemStatus) renderSemanticStatus(lastSemStatus);
  setTimeout(refreshSemanticStatus, 30);
  if (semStatusPoll) clearInterval(semStatusPoll);
  semStatusPoll = null;
}

function closeSemanticIndexSettings() {
  semanticIndexModal.classList.remove("show");
  if (semStatusPoll) clearInterval(semStatusPoll);
  semStatusPoll = null;
}

semanticGearBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openSemanticIndexSettings();
});
semanticIndexCloseBtn?.addEventListener("click", closeSemanticIndexSettings);
semanticIndexModal?.addEventListener("click", (e) => {
  if (e.target === semanticIndexModal) closeSemanticIndexSettings();
});
semModelDownloadBtn?.addEventListener("click", async () => {
  setSemStatus("正在启动模型下载…", "busy");
  try {
    await invoke("download_semantic_model");
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("启动模型下载失败：" + e, "error");
  }
});
semModelDeleteBtn?.addEventListener("click", async () => {
  if (!confirm("确定删除本机语义模型缓存？之后使用语义检索需要重新下载模型。")) return;
  try {
    await invoke("delete_semantic_model");
    updateSemanticStatusCache({ model_ready: false, model_bytes: 0 });
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("删除模型失败：" + e, "error");
  }
});
semVectorBuildBtn?.addEventListener("click", async () => {
  setSemStatus("正在启动语义索引任务…", "busy");
  try {
    await invoke("build_semantic_vectors");
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("启动语义索引失败：" + e, "error");
  }
});
semAccelBuildBtn?.addEventListener("click", async () => {
  setSemStatus("正在启动加速索引任务…", "busy");
  try {
    await invoke("build_semantic_accelerator");
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("启动加速索引失败：" + e, "error");
  }
});
semMultiBuildBtn?.addEventListener("click", async () => {
  setSemStatus("正在启动多中心画像任务…", "busy");
  try {
    await invoke("build_semantic_multi_profile");
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("启动多中心画像失败：" + e, "error");
  }
});
semVectorDeleteBtn?.addEventListener("click", async () => {
  if (!confirm("确定删除语义索引？加速索引也会一起删除。")) return;
  try {
    await invoke("delete_semantic_index", { kind: "semantic" });
    clearSemanticStatusCache();
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("删除语义索引失败：" + e, "error");
  }
});
semAccelDeleteBtn?.addEventListener("click", async () => {
  if (!confirm("确定删除加速索引？语义索引会保留，可之后续建加速索引。")) return;
  try {
    await invoke("delete_semantic_index", { kind: "accelerator" });
    updateSemanticStatusCache({
      accelerator_done: 0,
      accelerator_total: 0,
      accelerator_ready: false,
      accelerator_resumable: false,
      accelerator_bytes: 0,
    });
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("删除加速索引失败：" + e, "error");
  }
});
semMultiDeleteBtn?.addEventListener("click", async () => {
  if (!confirm("确定删除多中心画像索引？语义索引和加速索引会保留。")) return;
  try {
    await invoke("delete_semantic_index", { kind: "multi_profile" });
    updateSemanticStatusCache({
      multi_profile_done: 0,
      multi_profile_ready: false,
      multi_profile_bytes: 0,
    });
    await refreshSemanticStatus();
  } catch (e) {
    setSemStatus("删除多中心画像失败：" + e, "error");
  }
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
// 账号、登录和同步面板 UI 在 sync-ui.js。
function updateLayoutButtons() {
  document
    .querySelectorAll(".layout-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.layout === layout));
}
function updateGridColumnsControls() {
  const defBtn = document.getElementById("grid-cols-default");
  const valEl = document.getElementById("grid-cols-value");
  if (defBtn) defBtn.classList.toggle("active", !shelfGridColumns);
  if (valEl) valEl.textContent = String(shelfGridColumns || shelfGridColumnsValue);
}
function saveGridColumns() {
  localStorage.setItem("shelfGridColumns", shelfGridColumns ? String(shelfGridColumns) : "0");
  localStorage.setItem("shelfGridColumnsValue", String(shelfGridColumnsValue));
}
function applyShelfGridColumns() {
  const fixed = layout === "grid" && shelfGridColumns > 0;
  shelfEl.classList.toggle("fixed-cols", fixed);
  if (fixed) shelfEl.style.setProperty("--shelf-grid-cols", String(shelfGridColumns));
  else shelfEl.style.removeProperty("--shelf-grid-cols");
}
document.querySelectorAll(".layout-btn").forEach((b) => {
  b.addEventListener("click", () => {
    layout = b.dataset.layout;
    localStorage.setItem("shelfLayout", layout);
    updateLayoutButtons();
    applyView();
  });
});
updateLayoutButtons();
updateGridColumnsControls();

document.getElementById("grid-cols-default")?.addEventListener("click", () => {
  shelfGridColumns = 0;
  saveGridColumns();
  updateGridColumnsControls();
  applyView();
});
document.getElementById("grid-cols-dec")?.addEventListener("click", () => {
  shelfGridColumnsValue = Math.max(GRID_COL_MIN, (shelfGridColumns || shelfGridColumnsValue) - 1);
  shelfGridColumns = shelfGridColumnsValue;
  layout = "grid";
  localStorage.setItem("shelfLayout", layout);
  saveGridColumns();
  updateLayoutButtons();
  updateGridColumnsControls();
  applyView();
});
document.getElementById("grid-cols-inc")?.addEventListener("click", () => {
  shelfGridColumnsValue = Math.min(GRID_COL_MAX, (shelfGridColumns || shelfGridColumnsValue) + 1);
  shelfGridColumns = shelfGridColumnsValue;
  layout = "grid";
  localStorage.setItem("shelfLayout", layout);
  saveGridColumns();
  updateLayoutButtons();
  updateGridColumnsControls();
  applyView();
});

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
    render(list);
    setImportStatus("导入完成，共 " + paths.length + " 个文件", "ok");
    hideImportStatus(3200);
    if (debugSettingOn("bg_fulltext_index")) {
      runWhenNoReader("keyword-index-after-import", () => invoke("build_shelf_index")); // 后台为新书建检索索引
    }
  } catch (e) {
    setImportStatus("导入失败：" + (e && e.message ? e.message : e), "error");
    hideImportStatus(7000);
  }
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
  alert("已导入 " + count + " 条同步数据。重启软件后可继续迁移/合并到运行数据。");
}

function openRandom() {
  if (!books.length) {
    alert("书架还是空的，先导入书籍吧～");
    return;
  }
  const b = books[Math.floor(Math.random() * books.length)];
  clearCrossReturnMemory();
  invoke("open_book", { id: b.id });
}

// 三点菜单
document.getElementById("menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  filterPanel.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  menuEl.classList.toggle("show");
});
document.addEventListener("click", () => {
  closeMainFloaters();
});
document.getElementById("mi-random").addEventListener("click", () => {
  menuEl.classList.remove("show");
  openRandom();
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
tauriEvent.listen("tauri://drag-enter", () => dropHint.classList.add("show"));
tauriEvent.listen("tauri://drag-leave", () => dropHint.classList.remove("show"));
tauriEvent.listen("tauri://drag-drop", async (e) => {
  dropHint.classList.remove("show");
  const paths = ((e.payload && e.payload.paths) || []).filter((p) => SUPPORTED.test(p));
  if (paths.length) await importBookPaths(paths);
});
document.getElementById("mi-selectall").addEventListener("click", () => {
  menuEl.classList.remove("show");
  selectAll();
});

// ---- 选中 / 批量删除 ----
const delGroup = document.getElementById("del-group");
const delBtn = document.getElementById("del-btn");
const coverBtn = document.getElementById("cover-btn");
const bookInfoBtn = document.getElementById("book-info-btn");
const similarBooksBtn = document.getElementById("similar-books-btn");
const bookInfoModal = document.getElementById("book-info-modal");
const bookInfoTitle = document.getElementById("book-info-title");
const bookInfoDesc = document.getElementById("book-info-desc");
const bookInfoStars = document.getElementById("book-info-stars");
const similarBooksModal = document.getElementById("similar-books-modal");
const similarBooksSource = document.getElementById("similar-books-source");
const similarBooksList = document.getElementById("similar-books-list");
let currentInfoBookId = "";

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
function updateBookInShelf(id, patch) {
  const idx = books.findIndex((b) => String(b.id) === String(id));
  if (idx >= 0) books[idx] = Object.assign({}, books[idx], patch);
  applyView();
  updateDeleteUI();
}
async function openSelectedBookInfo() {
  if (selected.size !== 1) return;
  currentInfoBookId = String([...selected][0]);
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
makeStars(bookInfoStars, (rating) => {
  if (!currentInfoBookId) return;
  bookInfoStars.setVal(rating);
  updateBookInShelf(currentInfoBookId, { rating });
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
    const b = books.find((x) => String(x.id) === String(currentInfoBookId));
    bookInfoTitle.value = b?.title || "";
    return;
  }
  try {
    await invoke("set_book_title", { id: currentInfoBookId, title });
    updateBookInShelf(currentInfoBookId, { title });
  } catch (e) {
    alert("保存书名失败：" + e);
  }
});
bookInfoDesc.addEventListener("blur", () => {
  if (!currentInfoBookId) return;
  const description = bookInfoDesc.textContent.trim();
  updateBookInShelf(currentInfoBookId, { description });
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
    cover.style.background = colorFor(b.title || "");
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
  const source = books.find((x) => String(x.id) === id);
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
  const b = books.find((x) => String(x.id) === String(currentInfoBookId));
  if (b) changeCover(b);
});

function updateDeleteUI() {
  if (selected.size > 0) {
    delGroup.classList.add("show");
    bookInfoBtn.style.display = selected.size === 1 ? "" : "none";
    delBtn.textContent = "🗑 删除选中 (" + selected.size + ")";
  } else {
    delGroup.classList.remove("show");
  }
}
function toggleSelect(id, card) {
  if (selected.has(id)) {
    selected.delete(id);
    card.classList.remove("selected");
  } else {
    selected.add(id);
    card.classList.add("selected");
  }
  updateDeleteUI();
}
function clearSelection() {
  selected = new Set();
  applyView();
  updateDeleteUI();
}
function selectAll() {
  const list = currentList(); // 只选当前过滤/搜索后真正显示的这些书
  closeSearch(true);
  selected = new Set(list.map((b) => b.id));
  applyView();
  updateDeleteUI();
}
delBtn.addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirm("确定删除选中的 " + selected.size + " 本书？（不会删除磁盘上的文件）")) return;
  const ids = Array.from(selected);
  const list = await invoke("remove_books", { ids });
  selected = new Set();
  updateDeleteUI();
  render(list);
});
document.getElementById("del-cancel").addEventListener("click", clearSelection);

let initialShelfLoading = true;
let lastShelfFocusRefreshAt = 0;
// 回到书架窗口时刷新（更新“最近阅读”、进度等），但做节流，避免窗口焦点抖动时连续重刷。
window.addEventListener("focus", () => {
  if (initialShelfLoading) return;
  const now = Date.now();
  if (now - lastShelfFocusRefreshAt < 1500) return;
  lastShelfFocusRefreshAt = now;
  invoke("list_books").then(render).catch(() => {});
});

window.addEventListener("DOMContentLoaded", () => {
  // 启动：先用 list_books 快速返回现有书架，让菜单栏立刻可点；旧数据元信息回填延后执行。
    startupPerfLog("startup", "schedule", "critical=list_books+cover-render background=sync/settings/import/index/update");
    startupTimed("shelf-list-books", () => invoke("list_books"), "critical")
      .then((list) => {
        startupPerfLog("shelf-list-books", "data", "books=" + ((list && list.length) || 0));
        render(list);
      })
      .catch(() => {})
      .finally(() => {
        initialShelfLoading = false;
        startupPerfLog("startup", "interactive", "main toolbar should be responsive");
      });
    setTimeout(() => {
      if (!debugSettingOn("bg_cover_preload")) return;
      runWhenNoReader("shelf-books-backfill", () => invoke("shelf_books").then(render));
    }, 10000);
    // 读取自动导入配置并反映到设置面板。真正扫描延后，避免和首屏封面加载抢资源。
    setTimeout(() => {
      if (!debugSettingOn("bg_sync")) return;
      startupTimed("sync-settings", () => loadSyncSettingsOnce(), "background").catch(() => {});
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











