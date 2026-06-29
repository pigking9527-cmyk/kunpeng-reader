// 书架页逻辑
const invoke = window.__TAURI__.core.invoke;
const dialog = window.__TAURI__.dialog;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单

const shelfEl = document.getElementById("shelf");
const emptyEl = document.getElementById("empty");
const menuEl = document.getElementById("menu");
const filterPanel = document.getElementById("filter-panel");
const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");

let books = []; // 当前书架（原始顺序，供“随机打开”用）
let sortKey = localStorage.getItem("shelfSort") || "title";
let layout = localStorage.getItem("shelfLayout") || "grid";
let readingFilter = { unread: true, reading: true, done: true };
try {
  readingFilter = Object.assign(readingFilter, JSON.parse(localStorage.getItem("readingFilter") || "{}"));
} catch (e) {}
// 阅读状态：done 已读 / unread 未读 / reading 正在阅读
function readStatus(b) {
  const p = b.progress || 0;
  if (p >= 99) return "done";
  if (p < 1) return "unread";
  return "reading";
}
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
  if (b.missing) {
    card.classList.add("missing");
    const warn = document.createElement("div");
    warn.className = "missing-badge";
    warn.textContent = "⚠ 文件丢失";
    cover.appendChild(warn);
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
    filters: [{ name: "电子书", extensions: ext ? [ext] : ["epub", "pdf", "txt", "md", "markdown"] }],
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
      default:
        return a.title.localeCompare(b.title, "zh"); // 书名
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
  return list;
}

function applyView() {
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.innerHTML = "";
  const list = currentList();
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

// 阅读过滤复选框
document.querySelectorAll(".rfilter").forEach((c) => {
  c.checked = !!readingFilter[c.value];
  c.addEventListener("change", () => {
    readingFilter[c.value] = c.checked;
    localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
    applyView();
  });
});

// 漏斗面板右上角齿轮 → 弹出（暂为空白）设置
const fpSettingsModal = document.getElementById("fp-settings-modal");
document.getElementById("fp-gear").addEventListener("click", (e) => {
  e.stopPropagation();
  filterPanel.classList.remove("show");
  fpSettingsModal.classList.add("show");
});
document.getElementById("fp-settings-close").addEventListener("click", () => fpSettingsModal.classList.remove("show"));
// GitHub 链接：在系统默认浏览器打开，而不是在 WebView 里跳转
document.getElementById("about-github").addEventListener("click", (e) => {
  e.preventDefault();
  invoke("open_url", { url: e.currentTarget.href }).catch(() => {});
});
fpSettingsModal.addEventListener("click", (e) => {
  if (e.target === fpSettingsModal) fpSettingsModal.classList.remove("show");
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
let statScope = "day";
let statAnchor = new Date(); // 当前查看的日/月/年
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function ymd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
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
async function renderStats() {
  document.getElementById("stats-period").textContent = statPeriodLabel();
  const navVis = statScope === "total" ? "hidden" : "visible";
  document.getElementById("stats-prev").style.visibility = navVis;
  document.getElementById("stats-next").style.visibility = navVis;
  const [from, to] = statRange();
  let data;
  try { data = await invoke("reading_stats_range", { from, to }); } catch (e) { return; }
  const unit = { day: "天", month: "月", year: "年", total: "段时间" }[statScope];
  const cards =
    '<div class="stat-cards">' +
    `<div class="stat-cell"><div class="k">阅读时长</div><div class="v">${fmtTime(data.total_seconds)}</div></div>` +
    `<div class="stat-cell"><div class="k">阅读字数</div><div class="v">${fmtWords(data.total_words)}</div></div>` +
    `<div class="stat-cell"><div class="k">读过</div><div class="v">${data.book_count} 本</div></div>` +
    `<div class="stat-cell"><div class="k">读完</div><div class="v">${data.finished_count} 本</div></div>` +
    `<div class="stat-cell"><div class="k">高亮</div><div class="v">${data.total_highlights}</div></div>` +
    `<div class="stat-cell"><div class="k">批注</div><div class="v">${data.total_notes}</div></div>` +
    "</div>";
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
  document.getElementById("stats-body").innerHTML = cards + chart + books;
}
document.getElementById("mi-stats").addEventListener("click", () => {
  menuEl.classList.remove("show");
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
document.getElementById("stats-close").addEventListener("click", () => statsModal.classList.remove("show"));
statsModal.addEventListener("click", (e) => {
  if (e.target === statsModal) statsModal.classList.remove("show");
});

// ---- 关于（从 ⋮ 菜单打开）----
const aboutModal = document.getElementById("about-modal");
document.getElementById("mi-about").addEventListener("click", () => {
  menuEl.classList.remove("show");
  aboutModal.classList.add("show");
});
document.getElementById("about-close").addEventListener("click", () => aboutModal.classList.remove("show"));
aboutModal.addEventListener("click", (e) => {
  if (e.target === aboutModal) aboutModal.classList.remove("show");
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
