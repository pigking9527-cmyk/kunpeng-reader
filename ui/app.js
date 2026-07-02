// 书架页逻辑
const invoke = window.__TAURI__.core.invoke;
const dialog = window.__TAURI__.dialog;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单

const STARTUP_PERF_KEY = "startupPerfLogV1";
const startupPerfOrigin = performance.now();
const startupPerfSession = new Date().toISOString();
try { localStorage.setItem(STARTUP_PERF_KEY, JSON.stringify([{ session: startupPerfSession, at: 0, name: "app", phase: "start", detail: "main window script loaded" }])); } catch (e) {}
function startupPerfLog(name, phase = "mark", detail = "") {
  const at = Math.round(performance.now() - startupPerfOrigin);
  const entry = { session: startupPerfSession, at, name, phase, detail: String(detail || "") };
  console.info("[startup] +" + at + "ms " + name + " " + phase + (entry.detail ? " " + entry.detail : ""));
  try {
    const logs = JSON.parse(localStorage.getItem(STARTUP_PERF_KEY) || "[]");
    logs.push(entry);
    localStorage.setItem(STARTUP_PERF_KEY, JSON.stringify(logs.slice(-160)));
  } catch (e) {}
}
function startupPerfStart(name, detail = "") {
  const started = performance.now();
  startupPerfLog(name, "start", detail);
  return (extra = "") => startupPerfLog(name, "end", Math.round(performance.now() - started) + "ms" + (extra ? " " + extra : ""));
}
function startupTimed(name, task, detail = "") {
  const done = startupPerfStart(name, detail);
  return Promise.resolve()
    .then(task)
    .then((value) => {
      done();
      return value;
    })
    .catch((err) => {
      startupPerfLog(name, "error", err && err.message ? err.message : String(err));
      throw err;
    });
}
// 禁用浏览器自带查找（Ctrl+F / F3）
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

const shelfEl = document.getElementById("shelf");
const emptyEl = document.getElementById("empty");
const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");

let books = []; // 当前书架（原始顺序，供“随机打开”用）
let sortKey = localStorage.getItem("shelfSort") || "title";
if (sortKey === "rating") sortKey = "title"; // 已移除“按评分排序”，旧设置回落到书名
let layout = localStorage.getItem("shelfLayout") || "grid";
let readingFilter = { unread: true, reading: true, done: true };
try {
  readingFilter = Object.assign(readingFilter, JSON.parse(localStorage.getItem("readingFilter") || "{}"));
} catch (e) {}
let minRating = +(localStorage.getItem("minRating") || 0); // 评分过滤下限（0=不过滤）
// 阅读状态：done 已读 / unread 未读 / reading 正在阅读
function readStatus(b) {
  const p = b.progress || 0;
  if (p >= 99) return "done";
  if (p < 1) return "unread";
  return "reading";
}
let searchQuery = "";
let selected = new Set(); // 已选中的图书 id（单击封面切换）
let shelfLoaded = false;
let showCoverProgress = localStorage.getItem("showCoverProgress") !== "0"; // 封面右下角是否显示阅读进度
let showCoverRating = localStorage.getItem("showCoverRating") !== "0"; // 封面上是否显示评分小星
let showCoverTitle = localStorage.getItem("showCoverTitle") === "1"; // 网格视图封面下是否显示书名（默认不显示）

// 由书名稳定推导一个封面配色（与之前 egui 版一致的思路）
const PALETTE = [
  "#3e5a8c", "#8c4650", "#46785f", "#82643c",
  "#5f5082", "#3c6e78", "#78556e", "#5a6446",
];
function colorFor(title) {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

// 只读的评分小星（支持半星），叠在封面底部
function staticStars(v) {
  const wrap = document.createElement("div");
  wrap.className = "cover-stars";
  for (let i = 0; i < 5; i++) {
    const st = document.createElement("span");
    st.className = "star";
    const bg = document.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = document.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    fg.style.width = Math.max(0, Math.min(1, v - i)) * 100 + "%";
    st.append(bg, fg);
    wrap.appendChild(st);
  }
  return wrap;
}

function bookCard(b, index = 0) {
  const card = document.createElement("div");
  card.className = "book";

  const cover = document.createElement("div");
  cover.className = "cover";

  if (b.cover) {
    // EPUB 真实封面。封面带 Cache-Control，命中缓存时同帧直接画出，无任何过渡。
    // 真实封面加载前只用中性底色，避免用户看到“纯色封面”再跳成图片。
    cover.classList.add("has-img");
    const img = document.createElement("img");
    img.alt = b.title;
    img.loading = index < 24 ? "eager" : "lazy";
    img.decoding = index < 24 ? "sync" : "async";
    img.src = b.cover;
    cover.appendChild(img);
  } else {
    // 生成的占位封面：书名 + 配色
    cover.style.background = colorFor(b.title);
    const spine = document.createElement("div");
    spine.className = "spine";
    const gen = document.createElement("div");
    gen.className = "gen";
    gen.textContent = b.title;
    cover.appendChild(spine);
    cover.appendChild(gen);
  }
  if (b.progress > 0 && showCoverProgress) {
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = b.progress.toFixed(0) + "%"; // 封面右下角阅读进度
    cover.appendChild(badge);
  }
  if (b.missing) {
    card.classList.add("missing");
    const warn = document.createElement("div");
    warn.className = "missing-badge";
    warn.textContent = "⚠ 文件丢失";
    cover.appendChild(warn);
  }
  if (showCoverRating && b.rating > 0) cover.appendChild(staticStars(b.rating)); // 封面底部评分小星

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = b.title;

  const prog = document.createElement("div");
  prog.className = "prog";
  prog.textContent = b.progress > 0 ? b.progress.toFixed(1) + "%" : "未读";

  card.dataset.id = b.id;
  if (selected.has(b.id)) card.classList.add("selected");

  card.appendChild(cover);
  card.appendChild(title);
  card.appendChild(prog);

  // 单击选中（防抖以区分双击）；双击打开
  let clickTimer = null;
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      return; // 双击的第二下，不当作选中
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      toggleSelect(b.id, card);
    }, 230);
  });
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    if (b.missing) {
      relocateBook(b);
      return;
    }
    invoke("open_book", { id: b.id }).catch((err) => {
      const s = String(err);
      if (s.includes("丢失") || s.includes("定位")) relocateBook(b);
      else alert("打开失败：" + s);
    });
  });

  return card;
}

// 更换封面：挑一张图片 → 后端缩略并替换
async function changeCover(b) {
  const sel = await dialog.open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  try {
    render(await invoke("set_cover", { id: b.id, path }));
  } catch (e) {
    alert("更换封面失败：" + e);
  }
}

// 文件丢失 → 让用户重新定位到文件新位置（指纹一致则各项数据都保留）
async function relocateBook(b) {
  if (!confirm("《" + b.title + "》的源文件找不到了。\n是否重新定位到它现在的位置？")) return;
  const ext = (b.format || "").toLowerCase();
  const sel = await dialog.open({
    multiple: false,
    filters: [{ name: "电子书", extensions: ext ? [ext] : ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  render(await invoke("relocate_book", { id: b.id, path }));
}

function sortBooks(list) {
  const arr = list.slice();
  arr.sort((a, b) => {
    switch (sortKey) {
      case "author":
        return (
          (a.author || "").localeCompare(b.author || "", "zh") ||
          a.title.localeCompare(b.title, "zh")
        );
      case "added":
        return (b.added_at || 0) - (a.added_at || 0); // 新导入在前
      case "dir":
        return (a.path || "").localeCompare(b.path || "", "zh"); // 按存储目录/路径
      case "read":
        return (b.last_read_at || 0) - (a.last_read_at || 0); // 最近读的在前
      default: {
        // 书名：按拼音首字母分组排序（# 组排最后），同字母内按书名
        const ra = !a.initial || a.initial === "#" ? "~" : a.initial;
        const rb = !b.initial || b.initial === "#" ? "~" : b.initial;
        return ra.localeCompare(rb) || a.title.localeCompare(b.title, "zh");
      }
    }
  });
  return arr;
}

// 当前真正显示在书架上的书（搜索 + 阅读状态过滤后）。供渲染与"全选"共用。
function currentList() {
  let list = books;
  if (searchQuery) {
    list = books.filter(
      (b) =>
        (b.title || "").toLowerCase().includes(searchQuery) ||
        (b.author || "").toLowerCase().includes(searchQuery) ||
        (b.description || "").toLowerCase().includes(searchQuery)
    );
  }
  // 阅读状态过滤（三项全勾=全部显示）
  if (!(readingFilter.unread && readingFilter.reading && readingFilter.done)) {
    list = list.filter((b) => readingFilter[readStatus(b)]);
  }
  // 评分过滤（minRating>0 → 只显示评分≥该值的书）
  if (minRating > 0) {
    list = list.filter((b) => (b.rating || 0) >= minRating);
  }
  return list;
}

let viewRenderToken = 0;
function applyView() {
  const token = ++viewRenderToken;
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.classList.toggle("show-titles", showCoverTitle); // 网格视图是否显示书名
  shelfEl.replaceChildren();
  const list = currentList();
  if (!shelfLoaded) {
    emptyEl.style.display = "none";
  } else if (list.length) {
    emptyEl.style.display = "none";
  } else {
    emptyEl.textContent = searchQuery
      ? "没有匹配的书籍"
      : "书架还是空的。点右上角「⋮」→「导入书籍」添加（可一次选多本）。";
    emptyEl.style.display = "block";
  }
  const sorted = sortBooks(list);
  const finishCoverRender = startupPerfStart("cover-render", "critical books=" + sorted.length + " layout=" + layout);
  let i = 0;
  let chunks = 0;
  function appendChunk() {
    if (token !== viewRenderToken) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(i + 28, sorted.length);
    for (; i < end; i++) frag.appendChild(bookCard(sorted[i], i));
    shelfEl.appendChild(frag);
    chunks += 1;
    if (i < sorted.length) setTimeout(appendChunk, 0);
    else finishCoverRender("chunks=" + chunks);
  }
  appendChunk();
}
// ---- 搜索 + 历史记录 ----
const historyEl = document.getElementById("search-history");
let history = [];
try {
  history = JSON.parse(localStorage.getItem("searchHistory") || "[]");
} catch (e) {
  history = [];
}
function saveHistory() {
  localStorage.setItem("searchHistory", JSON.stringify(history.slice(0, 12)));
}
function addHistory(q) {
  q = (q || "").trim();
  if (!q) return;
  history = history.filter((h) => h !== q);
  history.unshift(q);
  history = history.slice(0, 12);
  saveHistory();
}
function renderHistory() {
  historyEl.innerHTML = "";
  if (!history.length) {
    const e = document.createElement("div");
    e.className = "sh-empty";
    e.textContent = "暂无搜索记录";
    historyEl.appendChild(e);
    return;
  }
  history.forEach((q) => {
    const item = document.createElement("div");
    item.className = "sh-item";
    const text = document.createElement("span");
    text.className = "sh-text";
    text.textContent = q;
    const del = document.createElement("span");
    del.className = "sh-del";
    del.textContent = "✕";
    item.append(text, del);
    item.addEventListener("click", (e) => {
      if (e.target === del) {
        history = history.filter((h) => h !== q);
        saveHistory();
        renderHistory();
        return;
      }
      searchInput.value = q;
      updateSearchClear();
      if (document.getElementById("shelf-search-chk").checked) {
        runShelfSearch(q);
      } else {
        searchQuery = q.toLowerCase();
        applyView();
        hideHistory();
      }
    });
    historyEl.appendChild(item);
  });
}
function showHistory() {
  renderHistory();
  historyEl.classList.add("show");
}
function hideHistory() {
  historyEl.classList.remove("show");
}
function updateSearchClear() {
  if (!searchClear) return;
  searchClear.classList.toggle("show", !!searchInput.value);
}
function clearSearchInput() {
  searchInput.value = "";
  updateSearchClear();
  if (shelfChk && shelfChk.checked) {
    showHistory();
  } else {
    searchQuery = "";
    applyView();
    showHistory();
  }
  searchInput.focus();
}

function closeSearch(clear) {
  const hadInput = !!searchInput.value.trim();
  const hadQuery = !!searchQuery;
  const wasOpen = searchWrap.classList.contains("open");
  if (hadInput) addHistory(searchInput.value); // 记下这次搜索
  hideHistory();
  searchWrap.classList.remove("open");
  if (clear) {
    searchInput.value = "";
    updateSearchClear();
    searchQuery = "";
    if (hadQuery || (wasOpen && hadInput)) applyView();
  }
}
document.getElementById("search-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  const open = !searchWrap.classList.contains("open");
  searchWrap.classList.toggle("open", open);
  if (open) {
    searchInput.focus();
    showHistory();
  } else {
    closeSearch(true);
  }
});
// 鼠标移到搜索图标/框上自动展开；移开且未输入未聚焦时延时收起
let searchCollapseTimer = null;
function cancelSearchCollapse() {
  if (searchCollapseTimer) {
    clearTimeout(searchCollapseTimer);
    searchCollapseTimer = null;
  }
}
function maybeCollapseSearch() {
  if (!searchInput.value.trim() && document.activeElement !== searchInput) {
    searchWrap.classList.remove("open");
    hideHistory();
  }
}
searchWrap.addEventListener("mouseenter", () => {
  cancelSearchCollapse();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  searchWrap.classList.add("open");
  showHistory();
});
searchWrap.addEventListener("mouseleave", () => {
  searchCollapseTimer = setTimeout(maybeCollapseSearch, 250);
});
// 移到历史记录浮层上时取消收起（历史浮层在搜索框下方，中间有空隙会触发 mouseleave）
historyEl.addEventListener("mouseenter", cancelSearchCollapse);
historyEl.addEventListener("mouseleave", () => {
  searchCollapseTimer = setTimeout(maybeCollapseSearch, 250);
});
// “书架搜索”开关：勾选后回车 → 对全书架（或选中的若干本）正文检索，结果开新窗口展示
const shelfChk = document.getElementById("shelf-search-chk");
shelfChk.addEventListener("click", (e) => e.stopPropagation());
// 整个开关（含“书架搜索”四个字）点击都不要冒泡到 document 的关闭逻辑，否则勾选会收起搜索框
document.getElementById("shelf-toggle").addEventListener("click", (e) => e.stopPropagation());
shelfChk.addEventListener("change", () => {
  searchInput.placeholder = shelfChk.checked ? "全书架正文检索，回车搜索…" : "搜索 书名 / 作者 / 简介";
  const term = searchInput.value.trim();
  if (shelfChk.checked) {
    // 有关键词时，切到全书架正文检索就直接打开全文检索页。
    if (term) {
      runShelfSearch(term);
    } else {
      searchQuery = "";
      applyView();
      showHistory();
    }
  } else {
    searchQuery = term.toLowerCase();
    applyView();
  }
  searchInput.focus();
});
function runShelfSearch(term) {
  term = (term || "").trim();
  if (!term) return;
  addHistory(term);
  hideHistory();
  const ids = selected.size ? [...selected] : null; // 有选中 → 只搜这几本；否则全部
  invoke("open_search_window", { term, ids }).catch(() => {});
}

searchInput.addEventListener("click", (e) => e.stopPropagation());
searchClear.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearSearchInput();
});
historyEl.addEventListener("click", (e) => e.stopPropagation());
searchInput.addEventListener("focus", showHistory);
searchInput.addEventListener("input", () => {
  updateSearchClear();
  if (shelfChk.checked) {
    showHistory();
    return; // 书架检索模式：输入时不过滤书架
  }
  searchQuery = searchInput.value.trim().toLowerCase();
  applyView();
  if (searchInput.value.trim()) hideHistory();
  else showHistory();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearch(true);
  else if (e.key === "Enter") {
    if (shelfChk.checked) {
      runShelfSearch(searchInput.value);
    } else {
      addHistory(searchInput.value);
      hideHistory();
    }
  }
});

let lastJSON = ""; // 上次渲染的数据快照，数据没变就不重渲染（避免封面重载闪烁）
function render(list) {
  shelfLoaded = true;
  books = list;
  const j = JSON.stringify(list);
  if (j === lastJSON) return;
  lastJSON = j;
  applyView();
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
  minRating = v;
  localStorage.setItem("minRating", String(v));
  applyView();
});
filterStarsEl.setVal(minRating);

// ---- “我的书架”设置：封面进度开关 + 自动导入目录（多目录） ----
let autoImport = { enabled: false, dirs: [] };
const setAutoChk = document.getElementById("set-auto-import");
const importDirsModal = document.getElementById("import-dirs-modal");
const dirsListEl = document.getElementById("dirs-list");
const dirsStatusEl = document.getElementById("dirs-status");
let autoImportScanSeq = 0;
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
      setTimeout(() => startupTimed("keyword-index-after-import", () => invoke("build_shelf_index"), "background").catch(() => {}), 1500);
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
setAutoChk.addEventListener("change", async () => {
  const enabled = setAutoChk.checked;
  autoImport.enabled = enabled;
  reflectAutoImport();
  if (enabled && !autoImport.dirs.length) {
    importDirsModal.classList.add("show"); // 还没设目录：顺手打开让用户添加
  }
  await applyAutoImport(enabled, {
    scan: enabled && autoImport.dirs.length > 0,
    reason: "正在扫描并导入目录…",
  });
});
// 把当前 enabled + dirs 提交后端；扫描导入单独走后台，避免设置窗口卡住。
async function applyAutoImport(enabled, opts = {}) {
  try {
    const cfg = await invoke("set_auto_import", { enabled, dirs: autoImport.dirs });
    autoImport = cfg || { enabled, dirs: autoImport.dirs };
    reflectAutoImport();
    setDirsStatus("目录设置已保存", "ok");
    if (opts.scan && autoImport.enabled && autoImport.dirs.length) {
      startAutoImportScan(opts.reason || "正在扫描并导入目录…");
    }
  } catch (e) {
    setDirsStatus("保存目录设置失败：" + e, "error");
    alert("设置自动导入失败：" + e);
    reflectAutoImport();
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
// 漏斗面板右上角齿轮 → 打开“我的书架”设置弹窗
const fpSettingsModal = document.getElementById("fp-settings-modal");
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
    return Array.isArray(list) ? list.filter((x) => x && x.username) : [];
  } catch (e) {
    return [];
  }
}
function writeSavedAccounts(list) {
  try {
    localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list.slice(0, 12)));
  } catch (e) {}
}
function saveAccountInfo(username, password) {
  username = (username || "").trim();
  if (!username || !password) return;
  const list = readSavedAccounts().filter((x) => x.username !== username);
  list.unshift({ username, password, saved_at: Date.now() });
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
    remove.title = "删除这条账号信息";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      writeSavedAccounts(readSavedAccounts().filter((x) => x.username !== item.username));
      renderSavedAccounts();
    });
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      syncUsernameEl.value = item.username;
      syncPasswordEl.value = item.password || "";
      hideSavedAccounts();
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
  e.stopPropagation();
  renderDirsList();
  importDirsModal.classList.add("show");
});
document.getElementById("dirs-add").addEventListener("click", addImportDirs);
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
    saveAccountInfo(syncUsernameEl.value, password);
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

function updateLayoutButtons() {
  document
    .querySelectorAll(".layout-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.layout === layout));
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
    invoke("build_shelf_index").catch(() => {}); // 后台为新书建检索索引
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
  menuEl.classList.remove("show");
  closeAccountPanel();
  filterPanel.classList.remove("show");
  hideHistory();
  if (!searchInput.value.trim() && !searchQuery) searchWrap.classList.remove("open");
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

// ---- 阅读统计 ----
const statsModal = document.getElementById("stats-modal");
function fmtTime(sec) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + " 小时 " + m + " 分钟";
  if (m > 0) return m + " 分钟";
  return sec + " 秒";
}
function fmtWords(n) {
  n = n || 0;
  return n >= 10000 ? (n / 10000).toFixed(2) + " 万字" : n + " 字";
}
let statScope = "day";
let statAnchor = new Date(); // 当前查看的日/月/年
const STAT_VISIBLE_KEY = "readingStatsVisibleItems";
const DEFAULT_STAT_VISIBLE = {
  duration: true,
  words: true,
  books: true,
  finished: true,
  highlights: true,
  notes: true,
};
let statVisible = readStatVisible();
function readStatVisible() {
  try {
    return Object.assign({}, DEFAULT_STAT_VISIBLE, JSON.parse(localStorage.getItem(STAT_VISIBLE_KEY) || "{}"));
  } catch (e) {
    return Object.assign({}, DEFAULT_STAT_VISIBLE);
  }
}
function saveStatVisible() {
  localStorage.setItem(STAT_VISIBLE_KEY, JSON.stringify(statVisible));
}
function syncStatVisibleControls() {
  document.querySelectorAll("[data-stat-item]").forEach((input) => {
    input.checked = statVisible[input.dataset.statItem] !== false;
  });
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function ymd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function dateFromYmd(v) {
  const y = Math.floor(v / 10000), m = Math.floor(v / 100) % 100, d = v % 100;
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); } // m: 0-based
function escapeHtml(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function statRange() {
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth();
  if (statScope === "day") { const v = ymd(d); return [v, v]; }
  if (statScope === "month") return [y * 10000 + (m + 1) * 100 + 1, y * 10000 + (m + 1) * 100 + 31];
  if (statScope === "year") return [y * 10000 + 101, y * 10000 + 1231];
  return [0, 99999999];
}
function statPeriodLabel() {
  const d = statAnchor, y = d.getFullYear(), m = d.getMonth() + 1;
  if (statScope === "day") return y + "-" + pad2(m) + "-" + pad2(d.getDate());
  if (statScope === "month") return y + " 年 " + m + " 月";
  if (statScope === "year") return y + " 年";
  return "全部";
}
function statStep(dir) {
  const d = statAnchor;
  if (statScope === "day") d.setDate(d.getDate() + dir);
  else if (statScope === "month") d.setMonth(d.getMonth() + dir);
  else if (statScope === "year") d.setFullYear(d.getFullYear() + dir);
  else return;
  renderStats();
}
function barChart(bars, color) {
  const W = 600, H = 130, pad = 18, bw = bars.length ? (W - pad * 2) / bars.length : 0;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const everyLabel = bars.length <= 24 ? 1 : Math.ceil(bars.length / 12);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  bars.forEach((b, i) => {
    const h = (b.value / max) * (H - 30), x = pad + i * bw, y = H - 20 - h;
    s += `<rect x="${x + bw * 0.12}" y="${y}" width="${bw * 0.76}" height="${h}" rx="2" fill="${b.value ? color : "#e3e6ec"}"></rect>`;
    if (i % everyLabel === 0) s += `<text x="${x + bw / 2}" y="${H - 6}" font-size="9" fill="#aaa" text-anchor="middle">${b.label}</text>`;
  });
  return s + "</svg>";
}
function statBars(data) {
  if (statScope === "day") return data.hours.map((v, h) => ({ label: h, value: v }));
  const dayMap = {};
  data.days.forEach((d) => (dayMap[d.day] = d.seconds));
  if (statScope === "month") {
    const y = statAnchor.getFullYear(), m = statAnchor.getMonth(), n = daysInMonth(y, m), bars = [];
    for (let i = 1; i <= n; i++) bars.push({ label: i, value: dayMap[y * 10000 + (m + 1) * 100 + i] || 0 });
    return bars;
  }
  if (statScope === "year") {
    const mo = new Array(12).fill(0);
    data.days.forEach((d) => (mo[(Math.floor(d.day / 100) % 100) - 1] += d.seconds));
    return mo.map((v, i) => ({ label: i + 1 + "月", value: v }));
  }
  const yr = {};
  data.days.forEach((d) => { const yy = Math.floor(d.day / 10000); yr[yy] = (yr[yy] || 0) + d.seconds; });
  return Object.keys(yr).sort().map((y) => ({ label: y, value: yr[y] }));
}
function streakStats(days) {
  const active = new Set(days.filter((d) => d.seconds > 0).map((d) => d.day));
  const today = new Date();
  let cur = 0;
  for (let d = new Date(today); active.has(ymd(d)); d = addDays(d, -1)) cur++;
  const sorted = Array.from(active).sort((a, b) => a - b).map(dateFromYmd);
  let longest = 0, run = 0, prev = null;
  sorted.forEach((d) => {
    if (prev && Math.round((d - prev) / 86400000) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prev = d;
  });
  return { current: cur, longest };
}
function contributionLevel(seconds) {
  if (!seconds) return 0;
  if (seconds < 20 * 60) return 1;
  if (seconds < 40 * 60) return 2;
  if (seconds < 60 * 60) return 3;
  if (seconds < 120 * 60) return 4;
  return 4;
}
function monthLabelsForContribution(start) {
  const labels = [];
  const end = addDays(start, 53 * 7 - 1);
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  if (cursor < start) cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  while (cursor <= end) {
    const diff = Math.floor((cursor - start) / 86400000);
    const week = Math.max(0, Math.min(52, Math.floor(diff / 7)));
    const left = (week / 53) * 100;
    labels.push(`<span class="${left > 95 ? "edge" : ""}" style="left:${left.toFixed(3)}%">${cursor.getMonth() + 1}月</span>`);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return labels.join("");
}
function contributionGraph(allData) {
  const map = {};
  allData.days.forEach((d) => (map[d.day] = d.seconds));
  const today = new Date();
  const start = addDays(today, -364);
  start.setDate(start.getDate() - start.getDay());
  let cells = "";
  for (let w = 0; w < 53; w++) {
    for (let r = 0; r < 7; r++) {
      const d = addDays(start, w * 7 + r);
      const key = ymd(d), seconds = map[key] || 0;
      cells += `<span class="contrib-cell lv${contributionLevel(seconds)}" title="${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} · ${fmtTime(seconds)}"></span>`;
    }
  }
  return (
    '<div class="contrib-card">' +
    `<div class="contrib-months">${monthLabelsForContribution(start)}</div>` +
    `<div class="contrib-grid">${cells}</div>` +
    "</div>"
  );
}
function overviewStats(allData) {
  const streak = streakStats(allData.days);
  const peak = allData.days.reduce((m, d) => Math.max(m, d.seconds || 0), 0);
  return (
    '<div class="stat-overview">' +
    `<div><b>${fmtTime(allData.total_seconds)}</b><span>累计阅读时长</span></div>` +
    `<div><b>${fmtTime(peak)}</b><span>单日峰值</span></div>` +
    `<div><b>${streak.current} 天</b><span>当前连续阅读</span></div>` +
    `<div><b>${streak.longest} 天</b><span>最长连续阅读</span></div>` +
    "</div>"
  );
}
async function renderStats() {
  document.getElementById("stats-period").textContent = statPeriodLabel();
  const navVis = statScope === "total" ? "hidden" : "visible";
  document.getElementById("stats-prev").style.visibility = navVis;
  document.getElementById("stats-next").style.visibility = navVis;
  const [from, to] = statRange();
  let data, allData;
  try {
    [data, allData] = await Promise.all([
      invoke("reading_stats_range", { from, to }),
      invoke("reading_stats_range", { from: 0, to: 99999999 }),
    ]);
  } catch (e) { return; }
  const unit = { day: "天", month: "月", year: "年", total: "段时间" }[statScope];
  const statItems = [
    ["duration", "阅读时长", fmtTime(data.total_seconds)],
    ["words", "阅读字数", fmtWords(data.total_words)],
    ["books", "读过", data.book_count + " 本"],
    ["finished", "读完", data.finished_count + " 本"],
    ["highlights", "高亮", data.total_highlights],
    ["notes", "批注", data.total_notes],
  ].filter((item) => statVisible[item[0]] !== false);
  const cards = statItems.length
    ? '<div class="stat-cards">' + statItems.map((item) => `<div class="stat-cell"><div class="k">${item[1]}</div><div class="v">${item[2]}</div></div>`).join("") + "</div>"
    : "";
  const chart = `<div class="stat-chart">${barChart(statBars(data), "#5aa0ff")}</div>`;
  let books;
  if (data.books.length) {
    books = `<div class="stat-sec-title">这一${unit}读过的书</div>`;
    data.books.forEach((b) => {
      books +=
        `<div class="sbook"><span class="st-name">${escapeHtml(b.title)} ${b.finished ? '<span class="fin">✓读完</span>' : ""}</span>` +
        `<span class="st-meta">${fmtTime(b.seconds)} · ${fmtWords(b.words)}<br>高亮 ${b.highlights} · 批注 ${b.notes}</span></div>`;
    });
  } else {
    books = '<div class="stats-empty">这段时间还没有阅读记录</div>';
  }
  document.getElementById("stats-body").innerHTML =
    overviewStats(allData) + contributionGraph(allData) + cards + chart + books;
}
document.getElementById("stats-toolbar-btn").addEventListener("click", () => {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  statScope = "day";
  statAnchor = new Date();
  document.querySelectorAll(".stats-tab").forEach((t) => t.classList.toggle("active", t.dataset.scope === "day"));
  statsModal.classList.add("show");
  renderStats();
});
document.querySelectorAll(".stats-tab").forEach((t) => {
  t.addEventListener("click", () => {
    statScope = t.dataset.scope;
    document.querySelectorAll(".stats-tab").forEach((x) => x.classList.toggle("active", x === t));
    renderStats();
  });
});
document.getElementById("stats-prev").addEventListener("click", () => statStep(-1));
document.getElementById("stats-next").addEventListener("click", () => statStep(1));
const statsSettings = document.getElementById("stats-settings");
const statsSettingsBtn = document.getElementById("stats-settings-btn");
syncStatVisibleControls();
statsSettingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  statsSettings.classList.toggle("show");
});
statsSettings.addEventListener("click", (e) => e.stopPropagation());
document.querySelectorAll("[data-stat-item]").forEach((input) => {
  input.addEventListener("change", () => {
    statVisible[input.dataset.statItem] = input.checked;
    saveStatVisible();
    renderStats();
  });
});
statsModal.addEventListener("click", (e) => {
  if (e.target === statsModal) {
    statsModal.classList.remove("show");
    statsSettings.classList.remove("show");
    return;
  }
  if (!statsSettings.contains(e.target) && e.target !== statsSettingsBtn) {
    statsSettings.classList.remove("show");
  }
});

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
// 仅选中"一本"时才显示"更换封面"
coverBtn.addEventListener("click", () => {
  if (selected.size !== 1) return;
  const id = [...selected][0];
  const b = books.find((x) => String(x.id) === String(id));
  if (b) changeCover(b);
});

function updateDeleteUI() {
  if (selected.size > 0) {
    delGroup.classList.add("show");
    coverBtn.style.display = selected.size === 1 ? "" : "none";
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
    startupTimed("shelf-books-backfill", () => invoke("shelf_books"), "background")
      .then(render)
      .catch(() => {});
  }, 10000);
  // 读取自动导入配置并反映到设置面板。真正扫描延后，避免和首屏封面加载抢资源。
  setTimeout(() => startupTimed("sync-settings", () => loadSyncSettingsOnce(), "background").catch(() => {}), 1200);
  startupTimed("auto-import-config", () => invoke("get_auto_import"), "background")
    .then((c) => { autoImport = c || autoImport; reflectAutoImport(); })
    .catch(() => {});
  setTimeout(() => {
    if (!autoImport.enabled || !autoImport.dirs || !autoImport.dirs.length) return;
    startAutoImportScan("正在自动扫描导入目录…");
  }, 20000);
  // 字数统计是锦上添花，延后到启动稳定之后。
  setTimeout(() => startupTimed("word-counts", () => invoke("compute_word_counts"), "background").catch(() => {}), 25000);
  // 启动后台检查更新（不阻塞启动，每次启动查一次）
  setTimeout(() => startupTimed("update-check", () => checkUpdate(false), "background").catch(() => {}), 15000);
  // “关于”里的版本号取自后端，保持单一来源
  startupTimed("app-version", () => invoke("app_version"), "background")
    .then((v) => {
      const el = document.getElementById("about-ver");
      if (el && v) el.textContent = "v" + String(v).replace(/^v/i, "");
    })
    .catch(() => {});

