// 书架页逻辑
const invoke = window.__TAURI__.core.invoke;
const dialog = window.__TAURI__.dialog;

const shelfEl = document.getElementById("shelf");
const emptyEl = document.getElementById("empty");
const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");

let books = []; // 当前书架（原始顺序，供“随机打开”用）
let sortKey = localStorage.getItem("shelfSort") || "title";
let layout = localStorage.getItem("shelfLayout") || "grid";
let searchQuery = "";
let selected = new Set(); // 已选中的图书 id（单击封面切换）

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

function bookCard(b) {
  const card = document.createElement("div");
  card.className = "book";

  const cover = document.createElement("div");
  cover.className = "cover";

  if (b.cover) {
    // EPUB 真实封面
    const img = document.createElement("img");
    img.src = b.cover;
    img.alt = b.title;
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
  if (b.progress > 0) {
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = b.progress.toFixed(0) + "%"; // 封面右下角阅读进度
    cover.appendChild(badge);
  }

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
    invoke("open_book", { id: b.id });
  });

  return card;
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
      case "read":
        return (b.last_read_at || 0) - (a.last_read_at || 0); // 最近读的在前
      default:
        return a.title.localeCompare(b.title, "zh"); // 书名
    }
  });
  return arr;
}

function applyView() {
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.innerHTML = "";
  let list = books;
  if (searchQuery) {
    list = books.filter(
      (b) =>
        (b.title || "").toLowerCase().includes(searchQuery) ||
        (b.author || "").toLowerCase().includes(searchQuery) ||
        (b.description || "").toLowerCase().includes(searchQuery)
    );
  }
  if (list.length) {
    emptyEl.style.display = "none";
  } else {
    emptyEl.textContent = searchQuery
      ? "没有匹配的书籍"
      : "书架还是空的。点右上角「⋮」→「导入书籍」添加（可一次选多本）。";
    emptyEl.style.display = "block";
  }
  for (const b of sortBooks(list)) shelfEl.appendChild(bookCard(b));
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

function closeSearch(clear) {
  if (searchInput.value.trim()) addHistory(searchInput.value); // 记下这次搜索
  hideHistory();
  searchWrap.classList.remove("open");
  if (clear) {
    searchInput.value = "";
    searchQuery = "";
    applyView();
  }
}
document.getElementById("search-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  const open = !searchWrap.classList.contains("open");
  searchWrap.classList.toggle("open", open);
  if (open) {
    searchInput.focus();
    showHistory();
  } else {
    closeSearch(true);
  }
});
// 鼠标移到搜索图标/框上自动展开；移开且未输入未聚焦时收起
searchWrap.addEventListener("mouseenter", () => {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  searchWrap.classList.add("open");
  showHistory();
});
searchWrap.addEventListener("mouseleave", () => {
  if (!searchInput.value.trim() && document.activeElement !== searchInput) {
    searchWrap.classList.remove("open");
    hideHistory();
  }
});
// “书架搜索”开关：勾选后回车 → 对全书架（或选中的若干本）正文检索，结果开新窗口展示
const shelfChk = document.getElementById("shelf-search-chk");
shelfChk.addEventListener("click", (e) => e.stopPropagation());
// 整个开关（含“书架搜索”四个字）点击都不要冒泡到 document 的关闭逻辑，否则勾选会收起搜索框
document.getElementById("shelf-toggle").addEventListener("click", (e) => e.stopPropagation());
shelfChk.addEventListener("change", () => {
  searchInput.placeholder = shelfChk.checked ? "全书架正文检索，回车搜索…" : "搜索 书名 / 作者 / 简介";
  if (shelfChk.checked) {
    // 进入书架检索模式：不再按书名过滤书架
    searchQuery = "";
    applyView();
  } else {
    searchQuery = searchInput.value.trim().toLowerCase();
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
historyEl.addEventListener("click", (e) => e.stopPropagation());
searchInput.addEventListener("focus", showHistory);
searchInput.addEventListener("input", () => {
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

async function importBooks() {
  const sel = await dialog.open({
    multiple: true,
    filters: [{ name: "电子书", extensions: ["epub", "pdf", "txt", "md", "markdown"] }],
  });
  if (!sel) return;
  const paths = Array.isArray(sel) ? sel : [sel];
  render(await invoke("add_books", { paths }));
  invoke("build_shelf_index").catch(() => {}); // 后台为新书建检索索引
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
  closeSearch(true);
  menuEl.classList.toggle("show");
});
document.addEventListener("click", () => {
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeSearch(true);
});
document.getElementById("mi-random").addEventListener("click", () => {
  menuEl.classList.remove("show");
  openRandom();
});
document.getElementById("mi-import").addEventListener("click", () => {
  menuEl.classList.remove("show");
  importBooks();
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
document.getElementById("mi-stats").addEventListener("click", async () => {
  menuEl.classList.remove("show");
  const s = await invoke("reading_stats");
  document.getElementById("st-time").textContent = fmtTime(s.total_seconds);
  document.getElementById("st-words").textContent = fmtWords(s.total_words);
  document.getElementById("st-started").textContent = s.started + " 本";
  document.getElementById("st-finished").textContent = s.finished + " 本";
  document.getElementById("st-total").textContent = s.total_books + " 本";
  statsModal.classList.add("show");
});
document.getElementById("stats-close").addEventListener("click", () => statsModal.classList.remove("show"));
statsModal.addEventListener("click", (e) => {
  if (e.target === statsModal) statsModal.classList.remove("show");
});

// ---- 拖拽导入 ----
const dropHint = document.getElementById("drop-hint");
const SUPPORTED = /\.(epub|pdf|txt|md|markdown)$/i;
const tauriEvent = window.__TAURI__.event;
tauriEvent.listen("tauri://drag-enter", () => dropHint.classList.add("show"));
tauriEvent.listen("tauri://drag-leave", () => dropHint.classList.remove("show"));
tauriEvent.listen("tauri://drag-drop", async (e) => {
  dropHint.classList.remove("show");
  const paths = ((e.payload && e.payload.paths) || []).filter((p) => SUPPORTED.test(p));
  if (paths.length) {
    render(await invoke("add_books", { paths }));
    invoke("build_shelf_index").catch(() => {}); // 后台为新书建检索索引
  }
});
document.getElementById("mi-selectall").addEventListener("click", () => {
  menuEl.classList.remove("show");
  selectAll();
});

// ---- 选中 / 批量删除 ----
const delGroup = document.getElementById("del-group");
const delBtn = document.getElementById("del-btn");

function updateDeleteUI() {
  if (selected.size > 0) {
    delGroup.classList.add("show");
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
  closeSearch(true);
  selected = new Set(books.map((b) => b.id));
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

// 回到书架窗口时刷新（更新“最近阅读”、进度等）
window.addEventListener("focus", () => {
  invoke("list_books").then(render).catch(() => {});
});

// 启动：先快速显示，再回填作者/导入时间后重渲染
(async () => {
  try {
    render(await invoke("list_books"));
  } catch (e) {}
  invoke("shelf_books").then(render).catch(() => {});
  // 空闲时后台统计缺失的字数（不影响 UI）
  setTimeout(() => invoke("compute_word_counts").catch(() => {}), 1500);
})();
