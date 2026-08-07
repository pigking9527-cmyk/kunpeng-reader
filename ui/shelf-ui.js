// 书架渲染、选择、批量操作、排序、过滤与自定义滚动条。
// 所有外部能力由 app.js 通过 ReaderShelfUI.init 显式注入。
(function exposeShelfUi(global) {
"use strict";

let activeController = null;

function init(options = {}) {
  if (activeController) return activeController;
  const document = options.root;
  const invoke = options.invoke;
  const dialog = options.dialog;
  const localStorage = options.storage || global.localStorage;
  const menuEl = options.menuElement;
  const filterPanel = options.filterPanel;
  const closeAccountPanel = options.closeAccountPanel;
  const closeSearch = options.closeSearch;
  const clearCrossReturnMemory = options.clearCrossReturnMemory;
  const startPerformance = options.startPerformance;
  const confirmAction = options.confirmAction || ((message) => global.confirm(message));
  const alertAction = options.alertAction || ((message) => global.alert(message));
  const requestFrame = options.requestAnimationFrame || ((callback) => global.requestAnimationFrame(callback));
  if (!document || typeof document.getElementById !== "function") throw new Error("ReaderShelfUI.init 缺少 root");
  if (typeof invoke !== "function" || !dialog) throw new Error("ReaderShelfUI.init 缺少后端或对话框接口");
  if (!menuEl || !filterPanel) throw new Error("ReaderShelfUI.init 缺少浮层元素");
  if (typeof closeAccountPanel !== "function" || typeof closeSearch !== "function") throw new Error("ReaderShelfUI.init 缺少浮层关闭接口");
  if (typeof clearCrossReturnMemory !== "function" || typeof startPerformance !== "function") throw new Error("ReaderShelfUI.init 缺少书架生命周期接口");

const shelfEl = document.getElementById("shelf");
const emptyEl = document.getElementById("empty");
const contentEl = document.querySelector(".content");
const shelfScrollbar = document.getElementById("shelf-scrollbar");
const shelfScrollbarThumb = document.getElementById("shelf-scrollbar-thumb");
const filterButton = document.getElementById("filter-btn");
const filterResultSummary = document.getElementById("filter-result-summary");
const tagFilterList = document.getElementById("tag-filter-list");
const collectionFilterList = document.getElementById("collection-filter-list");
const organizationMatchModeButton = document.getElementById("organization-match-mode");
const organizationFilterModal = document.getElementById("organization-filter-modal");
const organizationFilterTitle = document.getElementById("organization-filter-title");
const organizationFilterNote = document.getElementById("organization-filter-note");
const organizationFilterOptions = document.getElementById("organization-filter-options");
const organizationFilterClose = document.getElementById("organization-filter-close");
const organizationFilterCancel = document.getElementById("organization-filter-cancel");
const organizationFilterClear = document.getElementById("organization-filter-clear");
const organizationFilterApply = document.getElementById("organization-filter-apply");
const batchTagButton = document.getElementById("batch-tag-btn");
const batchCollectionButton = document.getElementById("batch-collection-btn");
const batchOrganizationModal = document.getElementById("batch-organization-modal");
const batchOrganizationTitle = document.getElementById("batch-organization-title");
const batchOrganizationNote = document.getElementById("batch-organization-note");
const batchOrganizationOptions = document.getElementById("batch-organization-options");
const batchOrganizationNew = document.getElementById("batch-organization-new");
const batchOrganizationAdd = document.getElementById("batch-organization-add");
const batchOrganizationClose = document.getElementById("batch-organization-close");
const batchOrganizationCancel = document.getElementById("batch-organization-cancel");
const batchOrganizationApply = document.getElementById("batch-organization-apply");
const organizerMenu = options.organizerMenuElement || document.getElementById("book-organizer-menu");
const booklistModal = document.getElementById("booklist-modal");
const booklistTitle = document.getElementById("booklist-title");
const booklistClose = document.getElementById("booklist-close");
const booklistCover = document.getElementById("booklist-cover");
const booklistDescription = document.getElementById("booklist-description");
const booklistBooks = document.getElementById("booklist-books");
let activeBooklist = null;
let books = [];
let sortKey = localStorage.getItem("shelfSort") || "title";
if (sortKey === "rating") sortKey = "title";
const bookFileSizes = new Map();
let bookFileSizesPromise = null;
let layout = localStorage.getItem("shelfLayout") || "grid";
const GRID_COL_MIN = 1;
const GRID_COL_MAX = 12;
function parseGridColumns(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(GRID_COL_MIN, Math.min(GRID_COL_MAX, parsed));
}
let shelfGridColumns = parseGridColumns(localStorage.getItem("shelfGridColumns") || "0");
let shelfGridColumnsValue = parseGridColumns(localStorage.getItem("shelfGridColumnsValue") || "3") || 3;
let readingFilter = { unread: true, reading: true, done: true };
try {
  readingFilter = Object.assign(readingFilter, JSON.parse(localStorage.getItem("readingFilter") || "{}"));
} catch (e) {}
let minRating = +(localStorage.getItem("minRating") || 0);
let searchQuery = "";
let selected = new Set();
const shelfText = (key, fallback) => global.ReaderAppI18n?.t?.(key) || fallback;
function organizationName(value) { return String(value || "").trim(); }
function organizationKey(value) { return organizationName(value).toLocaleLowerCase("zh-CN"); }
function loadOrganizationFilter(key) {
  try {
    const values = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(values) ? values.map(organizationKey).filter(Boolean) : []);
  } catch (_) { return new Set(); }
}
function saveOrganizationFilter(key, values) {
  localStorage.setItem(key, JSON.stringify(Array.from(values)));
}
let tagFilter = loadOrganizationFilter("shelfTagFilter");
let collectionFilter = loadOrganizationFilter("shelfCollectionFilter");
let organizationMatchMode = localStorage.getItem("shelfOrganizationMatchMode") === "all" ? "all" : "any";
let organizationFilterDraft = null;
let organizationFilterReturnToPanel = false;
let shelfLoaded = false;
let showCoverProgress = localStorage.getItem("showCoverProgress") !== "0";
let showCoverRating = localStorage.getItem("showCoverRating") !== "0";
let showCoverTitle = localStorage.getItem("showCoverTitle") === "1";
let singleClickOpensBook = localStorage.getItem("shelfSingleClickOpen") !== "0";
// 所有封面都立即拥有 URL；原生 lazy 只调整浏览器的请求调度，不能制造空白书卡。
const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24;
const MAX_FIRST_SCREEN_COVER_COUNT = 160;
let firstScreenCoverCount = DEFAULT_FIRST_SCREEN_COVER_COUNT;

// 书架是应用控件，不是网页正文。禁止浏览器把拖过的封面图片、书名和进度
// 当成可拖对象或文本选区；多选只通过阅读器自己的选中态完成。
shelfEl.addEventListener("dragstart", (event) => event.preventDefault());
shelfEl.addEventListener("selectstart", (event) => event.preventDefault());

function setSingleClickOpenPreference(value) {
  singleClickOpensBook = value !== false;
  localStorage.setItem("shelfSingleClickOpen", singleClickOpensBook ? "1" : "0");
}


function estimateFirstScreenCoverCount() {
  const width = Number(contentEl?.clientWidth || 0);
  const height = Number(contentEl?.clientHeight || 0);
  if (width <= 0 || height <= 0) return 0;
  if (layout === "list") return Math.max(1, Math.ceil(height / 108));
  const columns = shelfGridColumns > 0
    ? shelfGridColumns
    : Math.max(1, Math.floor((Math.max(0, width - 40) + 18) / 158));
  // 网格封面 190px，高度间距 18px；标题隐藏时仍保留卡片的最小行高。
  const rows = Math.max(1, Math.ceil(Math.max(0, height - 40) / 208));
  return Math.min(MAX_FIRST_SCREEN_COVER_COUNT, columns * rows);
}


// 通用半星组件：左半=半星、右半=整星。
function makeStars(container, onPick) {
  for (let i = 0; i < 5; i++) {
    const star = document.createElement("span");
    star.className = "star";
    const background = document.createElement("span");
    background.className = "s-bg";
    background.textContent = "★";
    const foreground = document.createElement("span");
    foreground.className = "s-fg";
    foreground.textContent = "★";
    star.append(background, foreground);
    container.appendChild(star);
  }
  const stars = [...container.querySelectorAll(".star")];
  function paint(value) {
    stars.forEach((star, index) => {
      const fill = Math.max(0, Math.min(1, value - index));
      star.querySelector(".s-fg").style.width = fill * 100 + "%";
    });
  }
  function valueAt(event) {
    for (let i = 0; i < stars.length; i++) {
      const rect = stars[i].getBoundingClientRect();
      if (event.clientX <= rect.right) return i + (event.clientX < rect.left + rect.width / 2 ? 0.5 : 1);
    }
    return 5;
  }
  container.addEventListener("mousemove", (event) => paint(valueAt(event)));
  container.addEventListener("mouseleave", () => paint(container._val || 0));
  container.addEventListener("click", (event) => {
    let value = valueAt(event);
    if (value === container._val) value = 0;
    container._val = value;
    paint(value);
    onPick(value);
  });
  container.setVal = (value) => {
    container._val = value || 0;
    paint(container._val);
  };
  paint(0);
}

filterButton.addEventListener("click", (event) => {
  event.stopPropagation();
  menuEl.classList.remove("show");
  closeAccountPanel();
  closeSearch(true);
  filterPanel.classList.toggle("show");
});
filterPanel.addEventListener("click", (event) => event.stopPropagation());
document.querySelectorAll('input[name="sort"]').forEach((radio) => {
  radio.checked = radio.value === sortKey;
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    sortKey = radio.value;
    localStorage.setItem("shelfSort", sortKey);
    if (sortKey === "size") void ensureBookFileSizes();
    applyView();
  });
});

async function ensureBookFileSizes() {
  if (bookFileSizesPromise) return bookFileSizesPromise;
  bookFileSizesPromise = invoke("book_file_sizes")
    .then((sizes) => {
      Object.entries(sizes || {}).forEach(([id, bytes]) => {
        bookFileSizes.set(String(id), Number(bytes) || 0);
      });
      if (sortKey === "size") applyView();
    })
    .catch(() => {})
    .finally(() => { bookFileSizesPromise = null; });
  return bookFileSizesPromise;
}
if (sortKey === "size") void ensureBookFileSizes();
document.querySelectorAll(".rfilter").forEach((checkbox) => {
  checkbox.checked = !!readingFilter[checkbox.value];
  checkbox.addEventListener("change", () => {
    readingFilter[checkbox.value] = checkbox.checked;
    localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
    applyView();
  });
});
const filterStarsEl = document.getElementById("filter-stars");
makeStars(filterStarsEl, (value) => {
  minRating = value > 0 && books.length && !books.some((book) => (book.rating || 0) >= value) ? 0 : value;
  if (minRating > 0) localStorage.setItem("minRating", String(minRating));
  else localStorage.removeItem("minRating");
  filterStarsEl.setVal(minRating);
  applyView();
});
filterStarsEl.setVal(minRating);

document.getElementById("reading-filter-all")?.addEventListener("click", () => {
  readingFilter = { unread: true, reading: true, done: true };
  localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
  document.querySelectorAll(".rfilter").forEach((checkbox) => { checkbox.checked = true; });
  minRating = 0;
  localStorage.removeItem("minRating");
  filterStarsEl.setVal(0);
  tagFilter.clear();
  collectionFilter.clear();
  saveOrganizationFilter("shelfTagFilter", tagFilter);
  saveOrganizationFilter("shelfCollectionFilter", collectionFilter);
  renderOrganizationFilters();
  applyView();
});

const setCoverProgress = document.getElementById("set-cover-prog");
const setCoverRating = document.getElementById("set-cover-rating");
const setCoverTitle = document.getElementById("set-cover-title");
const setSingleClickOpen = document.getElementById("set-single-click-open");
const openBookLabel = document.getElementById("set-open-book-label");
function reflectOpenBookPreference() {
  if (!setSingleClickOpen || !openBookLabel) return;
  setSingleClickOpen.checked = singleClickOpensBook;
  openBookLabel.textContent = singleClickOpensBook ? "单击打开图书" : "双击打开图书";
}
setCoverProgress.checked = showCoverProgress;
setCoverProgress.addEventListener("change", () => {
  showCoverProgress = setCoverProgress.checked;
  localStorage.setItem("showCoverProgress", showCoverProgress ? "1" : "0");
  applyView();
});
setCoverRating.checked = showCoverRating;
setCoverRating.addEventListener("change", () => {
  showCoverRating = setCoverRating.checked;
  localStorage.setItem("showCoverRating", showCoverRating ? "1" : "0");
  applyView();
});
setCoverTitle.checked = showCoverTitle;
setCoverTitle.addEventListener("change", () => {
  showCoverTitle = setCoverTitle.checked;
  localStorage.setItem("showCoverTitle", showCoverTitle ? "1" : "0");
  applyView();
});
reflectOpenBookPreference();
setSingleClickOpen?.addEventListener("change", () => {
  setSingleClickOpenPreference(setSingleClickOpen.checked);
  reflectOpenBookPreference();
});

function updateLayoutButtons() {
  document.querySelectorAll(".layout-btn").forEach((button) => button.classList.toggle("active", button.dataset.layout === layout));
}
function updateGridColumnsControls() {
  const defaultButton = document.getElementById("grid-cols-default");
  const valueElement = document.getElementById("grid-cols-value");
  if (defaultButton) defaultButton.classList.toggle("active", !shelfGridColumns);
  if (valueElement) valueElement.textContent = String(shelfGridColumns || shelfGridColumnsValue);
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
document.querySelectorAll(".layout-btn").forEach((button) => {
  button.addEventListener("click", () => {
    layout = button.dataset.layout;
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

// 阅读状态：done 已读 / unread 未读 / reading 正在阅读
function readStatus(b) {
  const p = b.progress || 0;
  if (p >= 99) return "done";
  if (p < 1) return "unread";
  return "reading";
}

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

function bookRenderKey(b) {
  return [
    b.id || "",
    b.title || "",
    b.cover || "",
    b.progress || 0,
    b.rating || 0,
    b.missing ? 1 : 0,
    showCoverProgress ? 1 : 0,
    showCoverRating ? 1 : 0,
  ].join("\u001f");
}
function closeShelfCardFloaters() {
  // 书卡会阻止事件冒泡，因此不能依赖 document 的兜底点击处理器。
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  closeSearch(false);
  closeBookOrganizer();
}

function bookCard(b, index = 0) {
  const card = document.createElement("div");
  card.className = "book";

  const cover = document.createElement("div");
  cover.className = "cover";

  if (b.cover) {
    // 所有封面先拥有 URL；首屏优先同步解码，余下由浏览器原生 lazy 调度。
    cover.classList.add("has-img");
    const img = document.createElement("img");
    img.alt = b.title;
    img.draggable = false;
    const eagerCoverLoad = index < firstScreenCoverCount;
    img.loading = eagerCoverLoad ? "eager" : "lazy";
    img.decoding = eagerCoverLoad ? "sync" : "async";
    img.fetchPriority = eagerCoverLoad ? "high" : "auto";
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
  card.dataset.problemTarget = "book-card";
  card.dataset.renderKey = bookRenderKey(b);
  if (selected.has(b.id)) card.classList.add("selected");

  card.appendChild(cover);
  card.appendChild(title);
  card.appendChild(prog);

  // 浏览器先派发两次 click、才派发 dblclick。两种打开模式都要短暂等待：
  // 单击打开模式避免双击先打开；双击打开模式避免第一下先把书选中。
  let openTimer = null;
  let selectionTimer = null;
  let selectionBeforeClick = false;
  let selectionApplied = false;
  const restoreDeferredSelection = () => {
    if (selectionApplied && selected.has(b.id) !== selectionBeforeClick) {
      toggleSelect(b.id, card);
    }
    selectionApplied = false;
  };
  const openBook = (input) => {
    if (b.missing) {
      window.ReaderProblemTraceUI?.recordShelfBookOpen?.("missing", input);
      relocateBook(b);
      return;
    }
    clearCrossReturnMemory();
    window.ReaderProblemTraceUI?.recordShelfBookOpen?.("requested", input);
    invoke("open_book", { id: b.id }).then(() => {
      window.ReaderProblemTraceUI?.recordShelfBookOpen?.("ok", input);
    }).catch((err) => {
      window.ReaderProblemTraceUI?.recordShelfBookOpen?.("failed", input);
      const s = String(err);
      if (s.includes("丢失") || s.includes("定位")) relocateBook(b);
      else alertAction("打开失败：" + s);
    });
  };
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    closeShelfCardFloaters();
    if (!singleClickOpensBook) {
      // 双击打开模式：先等一个很短的判定窗口。快速双击会在 dblclick
      // 中取消这个延迟选择，因而不会出现“第一下先选中”的闪动。
      if (e.detail !== 1) return;
      selectionBeforeClick = selected.has(b.id);
      selectionApplied = false;
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        toggleSelect(b.id, card);
        selectionApplied = true;
      }, 180);
      return;
    }
    // 已有任意选中项时，单击直接加入/移出多选；第二个 click 是双击的一部分，
    // 不重复切换，随后 dblclick 也不再改变已有选择。
    if (selected.size > 0) {
      if (e.detail === 1) toggleSelect(b.id, card);
      return;
    }
    if (e.detail > 1) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      if (!selected.size) openBook("single");
    }, 220);
  });
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    closeShelfCardFloaters();
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (!singleClickOpensBook) {
      if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
      // 若用户的双击间隔较长，延迟选择可能已执行；还原到双击前状态，
      // 确保最终结果仍是“直接打开、不改变选中”。
      restoreDeferredSelection();
      openBook("double");
      return;
    }
    // 单击打开模式中，双击把当前书加入选择。已经在多选模式时，前一个单击
    // 已完成一次切换，双击不应再反向切换一次。
    if (!selected.size) toggleSelect(b.id, card);
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeShelfCardFloaters();
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
    alertAction("更换封面失败：" + e);
  }
}

// 文件丢失 → 让用户重新定位到文件新位置（指纹一致则各项数据都保留）
async function relocateBook(b) {
  if (!confirmAction("《" + b.title + "》的源文件找不到了。\n是否重新定位到它现在的位置？")) return;
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
        return (b.last_read_at || 0) - (a.last_read_at || 0) ||
          a.title.localeCompare(b.title, "zh"); // 最近读的在前
      case "reading-time":
        return (b.reading_seconds || 0) - (a.reading_seconds || 0) ||
          a.title.localeCompare(b.title, "zh");
      case "size":
        return (bookFileSizes.get(String(b.id)) || 0) -
          (bookFileSizes.get(String(a.id)) || 0) ||
          a.title.localeCompare(b.title, "zh");
      case "progress":
        return (b.progress || 0) - (a.progress || 0) ||
          a.title.localeCompare(b.title, "zh");
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

function matchesShelfSearch(b) {
  if (!searchQuery) return true;
  return (
    (b.title || "").toLowerCase().includes(searchQuery) ||
    (b.author || "").toLowerCase().includes(searchQuery) ||
    (b.description || "").toLowerCase().includes(searchQuery)
  );
}
function hasActiveShelfFilters() {
  return minRating > 0 || tagFilter.size > 0 || collectionFilter.size > 0 || !(readingFilter.unread && readingFilter.reading && readingFilter.done);
}
function updateShelfFilterStatus(visibleCount) {
  const active = hasActiveShelfFilters();
  filterButton.classList.toggle("filters-active", active);
  filterButton.title = active ? shelfText("activeFilters", "Filters active") : shelfText("sortAndLayout", "Sort & layout");
  if (filterResultSummary) {
    filterResultSummary.textContent = visibleCount + "/" + books.length;
  }
}

function matchesOrganizationSelection(book, selectedTags, selectedCollections, mode) {
  if (!selectedTags.size && !selectedCollections.size) return true;
  const bookTags = new Set((book.tags || []).map(organizationKey));
  const bookCollections = new Set((book.collections || []).map(organizationKey));
  if (mode === "all") {
    return Array.from(selectedTags).every((key) => bookTags.has(key))
      && Array.from(selectedCollections).every((key) => bookCollections.has(key));
  }
  return Array.from(selectedTags).some((key) => bookTags.has(key))
    || Array.from(selectedCollections).some((key) => bookCollections.has(key));
}
function matchesOrganizationFilters(book) {
  return matchesOrganizationSelection(book, tagFilter, collectionFilter, organizationMatchMode);
}

function renderOrganizationMatchMode() {
  if (!organizationMatchModeButton) return;
  const matchAll = organizationMatchMode === "all";
  organizationMatchModeButton.textContent = matchAll ? shelfText("matchAll", "Match all") : shelfText("matchAny", "Match any");
  organizationMatchModeButton.title = matchAll
    ? shelfText("matchAllHint", "Tags and collections must all match; click to match any")
    : shelfText("matchAnyHint", "Any tag or collection may match; click to match all");
  organizationMatchModeButton.setAttribute("aria-pressed", matchAll ? "true" : "false");
}
organizationMatchModeButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  organizationMatchMode = organizationMatchMode === "all" ? "any" : "all";
  localStorage.setItem("shelfOrganizationMatchMode", organizationMatchMode);
  renderOrganizationMatchMode();
  applyView();
});
renderOrganizationMatchMode();

// 当前真正显示在书架上的书。搜索永远搜索整座书架，避免被评分/阅读过滤误挡住。
function currentList() {
  let list = books;
  if (searchQuery) {
    return books.filter(matchesShelfSearch);
  }
  // 阅读状态过滤（三项全勾=全部显示）
  if (!(readingFilter.unread && readingFilter.reading && readingFilter.done)) {
    list = list.filter((b) => readingFilter[readStatus(b)]);
  }
  // 评分过滤（minRating>0 → 只显示评分≥该值的书）
  if (minRating > 0) {
    list = list.filter((b) => (b.rating || 0) >= minRating);
  }
  list = list.filter(matchesOrganizationFilters);
  return list;
}

function organizationEntries(field) {
  const entries = new Map();
  books.forEach((book) => (book[field] || []).forEach((rawName) => {
    const name = organizationName(rawName);
    const key = organizationKey(name);
    if (!key) return;
    const entry = entries.get(key) || { name, key, count: 0 };
    entry.count += 1;
    entries.set(key, entry);
  }));
  return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}
function pruneOrganizationFilter(field, values, storageKey) {
  const known = new Set(organizationEntries(field).map((entry) => entry.key));
  let changed = false;
  Array.from(values).forEach((key) => {
    if (!known.has(key)) { values.delete(key); changed = true; }
  });
  if (changed) saveOrganizationFilter(storageKey, values);
}
function renderOrganizationFilterList(element, field, selectedKeys, emptyText) {
  if (!element) return;
  element.replaceChildren();
  const entries = organizationEntries(field);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "fp-choice-empty";
    empty.textContent = emptyText;
    element.appendChild(empty);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fp-choice-open";
  const label = document.createElement("span");
  label.textContent = field === "tags" ? "选择标签" : "选择收藏夹";
  const summary = document.createElement("small");
  summary.textContent = selectedKeys.size ? "已选 " + selectedKeys.size + " 项" : "全部";
  button.append(label, summary);
  button.addEventListener("click", (event) => openOrganizationFilter(field, event.currentTarget));
  element.appendChild(button);
  if (selectedKeys.size) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "fp-choice-clear";
    clear.textContent = "×";
    clear.title = field === "tags" ? "清除标签选择" : "清除收藏夹选择";
    clear.setAttribute("aria-label", clear.title);
    clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedKeys.clear();
      saveOrganizationFilter(field === "tags" ? "shelfTagFilter" : "shelfCollectionFilter", selectedKeys);
      renderOrganizationFilters();
      applyView();
    });
    element.appendChild(clear);
  }
}
function renderOrganizationFilters() {
  pruneOrganizationFilter("tags", tagFilter, "shelfTagFilter");
  pruneOrganizationFilter("collections", collectionFilter, "shelfCollectionFilter");
  renderOrganizationFilterList(tagFilterList, "tags", tagFilter, "暂无标签");
  renderOrganizationFilterList(collectionFilterList, "collections", collectionFilter, "暂无收藏夹");
}

function organizationFilterConfig(field) {
  return field === "tags"
    ? { field, title: "标签", selected: tagFilter, storageKey: "shelfTagFilter", empty: "暂无标签" }
    : { field, title: "收藏夹", selected: collectionFilter, storageKey: "shelfCollectionFilter", empty: "暂无收藏夹" };
}
function renderOrganizationFilterOptions() {
  if (!organizationFilterOptions || !organizationFilterDraft) return;
  const config = organizationFilterConfig(organizationFilterDraft.field);
  organizationFilterOptions.replaceChildren();
  const entries = organizationEntries(config.field);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "organization-filter-empty";
    empty.textContent = config.empty;
    organizationFilterOptions.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "organization-filter-option-row";
    const label = document.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = organizationFilterDraft.keys.has(entry.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) organizationFilterDraft.keys.add(entry.key);
      else organizationFilterDraft.keys.delete(entry.key);
    });
    const name = document.createElement("span");
    name.textContent = entry.name;
    label.append(checkbox, name);
    row.appendChild(label);
    if (config.field === "collections") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "booklist-open-link";
      open.textContent = "打开书单";
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeOrganizationFilter();
        openBooklist(entry.name);
      });
      row.appendChild(open);
    }
    organizationFilterOptions.appendChild(row);
  });
}
function closeOrganizationFilter() {
  const returnToPanel = organizationFilterReturnToPanel;
  organizationFilterDraft = null;
  organizationFilterReturnToPanel = false;
  organizationFilterModal?.classList?.remove("show");
  // 确认/取消按钮的点击还会继续冒泡到 document；下一帧恢复可避免刚打开又被全局点击处理器关闭。
  if (returnToPanel) {
    requestFrame(() => {
      if (!organizationFilterModal?.classList?.contains("show")) {
        filterPanel.classList.add("show");
      }
    });
  }
}
function positionOrganizationFilter(anchor) {
  if (!anchor?.getBoundingClientRect || !organizationFilterModal) return;
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = global.innerWidth || 1280;
  const viewportHeight = global.innerHeight || 800;
  const width = Math.min(430, viewportWidth - 32);
  const height = 320;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const top = Math.max(8, Math.min(rect.top, viewportHeight - height - 8));
  organizationFilterModal.style.setProperty("--organization-filter-left", left + "px");
  organizationFilterModal.style.setProperty("--organization-filter-top", top + "px");
}
function openOrganizationFilter(field, anchor) {
  if (!organizationFilterModal || !organizationFilterOptions) return;
  const config = organizationFilterConfig(field);
  organizationFilterDraft = { field, keys: new Set(config.selected) };
  organizationFilterReturnToPanel = filterPanel.classList.contains("show");
  organizationFilterTitle.textContent = shelfText("selectItems", "Select {title}").replace("{title}", config.title);
  organizationFilterNote.textContent = shelfText("multiSelectNoFilter", "You may select multiple items; select none to disable filtering.");
  renderOrganizationFilterOptions();
  // 必须在隐藏漏斗面板前取坐标；隐藏后的按钮 rect 会退化为 (0,0)，导致弹窗跑到左上角。
  positionOrganizationFilter(anchor);
  filterPanel.classList.remove("show");
  organizationFilterModal.classList.add("show");
}
organizationFilterClose?.addEventListener("click", closeOrganizationFilter);
organizationFilterCancel?.addEventListener("click", closeOrganizationFilter);
organizationFilterClear?.addEventListener("click", () => {
  if (!organizationFilterDraft) return;
  organizationFilterDraft.keys.clear();
  renderOrganizationFilterOptions();
});
organizationFilterApply?.addEventListener("click", () => {
  if (!organizationFilterDraft) return;
  const config = organizationFilterConfig(organizationFilterDraft.field);
  if (config.field === "tags") tagFilter = new Set(organizationFilterDraft.keys);
  else collectionFilter = new Set(organizationFilterDraft.keys);
  saveOrganizationFilter(config.storageKey, config.field === "tags" ? tagFilter : collectionFilter);
  closeOrganizationFilter();
  renderOrganizationFilters();
  applyView();
});
organizationFilterModal?.addEventListener("click", (event) => {
  if (event.target === organizationFilterModal) closeOrganizationFilter();
});

// 多选图书时只做“加入”，绝不覆盖或移除各书已有的标签/书单，避免一次误操作清空整理结果。
let batchOrganizationDraft = null;
function closeBatchOrganization() {
  batchOrganizationDraft = null;
  batchOrganizationModal?.classList?.remove("show");
}
function batchOrganizationConfig(field) {
  return field === "tags"
    ? { field, title: "标签", action: "添加标签", placeholder: "新建标签" }
    : { field, title: "收藏书单", action: "加入收藏书单", placeholder: "新建收藏书单" };
}
function renderBatchOrganizationOptions() {
  if (!batchOrganizationOptions || !batchOrganizationDraft) return;
  const config = batchOrganizationConfig(batchOrganizationDraft.field);
  batchOrganizationOptions.replaceChildren();
  const entries = organizationEntries(config.field);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "organization-filter-empty";
    empty.textContent = "还没有" + config.title + "，可在下方新建。";
    batchOrganizationOptions.appendChild(empty);
  }
  entries.forEach((entry) => {
    const label = document.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = batchOrganizationDraft.names.has(entry.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) batchOrganizationDraft.names.set(entry.key, entry.name);
      else batchOrganizationDraft.names.delete(entry.key);
    });
    const name = document.createElement("span");
    name.textContent = entry.name;
    label.append(checkbox, name);
    batchOrganizationOptions.appendChild(label);
  });
  // 新建但尚未用于其它图书的名称也要在当前草稿中可见。
  Array.from(batchOrganizationDraft.names.entries()).forEach(([key, name]) => {
    if (entries.some((entry) => entry.key === key)) return;
    const label = document.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) batchOrganizationDraft.names.delete(key);
    });
    const text = document.createElement("span");
    text.textContent = name;
    label.append(checkbox, text);
    batchOrganizationOptions.appendChild(label);
  });
}
function openBatchOrganization(field) {
  if (!selected.size || !batchOrganizationModal) return;
  const config = batchOrganizationConfig(field);
  batchOrganizationDraft = { field, names: new Map() };
  batchOrganizationTitle.textContent = "为已选 " + selected.size + " 本图书" + config.action;
  batchOrganizationNote.textContent = "可多选；确认后会加入全部已选图书，不会移除它们原有的标签或书单。";
  batchOrganizationNew.value = "";
  batchOrganizationNew.placeholder = config.placeholder;
  renderBatchOrganizationOptions();
  batchOrganizationModal.classList.add("show");
}
function addBatchOrganizationName() {
  if (!batchOrganizationDraft) return;
  const name = organizationName(batchOrganizationNew?.value);
  if (!name) return;
  batchOrganizationDraft.names.set(organizationKey(name), name);
  batchOrganizationNew.value = "";
  renderBatchOrganizationOptions();
}
function organizationAlreadyAssigned(book, field, names) {
  if (!book || !Array.isArray(names) || !names.length) return false;
  const wanted = new Set(names.map(organizationKey).filter(Boolean));
  return (book[field] || []).some((value) => wanted.has(organizationKey(value)));
}
function alreadyAssignedMessages(ids, field, names) {
  const kind = field === "tags" ? "标签" : "收藏";
  return ids
    .map((id) => getBook(id))
    .filter((book) => organizationAlreadyAssigned(book, field, names))
    .map((book) => "《" + (book.title || "未命名图书") + "》已加入" + kind);
}
async function applyBatchOrganization() {
  if (!batchOrganizationDraft || !selected.size) return;
  const names = Array.from(batchOrganizationDraft.names.values());
  if (!names.length) {
    alertAction("请至少选择或新建一个" + batchOrganizationConfig(batchOrganizationDraft.field).title + "。");
    return;
  }
  const ids = Array.from(selected);
  const organizationField = batchOrganizationDraft.field;
  const field = organizationField === "tags" ? "tag" : "collection";
  // 写入前保存重复成员关系。后端依然会做去重，前端仅负责把用户关心的状态说明出来。
  const existingMessages = alreadyAssignedMessages(ids, organizationField, names);
  try {
    const list = await invoke("add_books_organization", { ids, field, names });
    closeBatchOrganization();
    render(list);
    if (existingMessages.length) alertAction(existingMessages.join("\n"));
  } catch (error) {
    alertAction("批量加入失败：" + error);
  }
}
batchTagButton?.addEventListener("click", () => openBatchOrganization("tags"));
batchCollectionButton?.addEventListener("click", () => openBatchOrganization("collections"));
batchOrganizationClose?.addEventListener("click", closeBatchOrganization);
batchOrganizationCancel?.addEventListener("click", closeBatchOrganization);
batchOrganizationAdd?.addEventListener("click", addBatchOrganizationName);
batchOrganizationNew?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addBatchOrganizationName(); }
});
batchOrganizationApply?.addEventListener("click", applyBatchOrganization);
batchOrganizationModal?.addEventListener("click", (event) => {
  if (event.target === batchOrganizationModal) closeBatchOrganization();
});

let organizerBookId = null;
let organizerAnchor = null;
let organizerPositionScheduled = false;
function booklistBook(id) {
  return books.find((book) => String(book.id) === String(id));
}
function setBooklistCover(list) {
  if (!booklistCover) return;
  booklistCover.replaceChildren();
  const coverBook = booklistBook(list.cover_book_id) || booklistBook(list.book_ids?.[0]);
  if (coverBook?.cover) {
    const image = document.createElement("img");
    image.src = coverBook.cover;
    image.alt = list.name;
    booklistCover.appendChild(image);
  } else {
    booklistCover.textContent = list.name || "书单";
  }
}
async function saveActiveBooklist() {
  if (!activeBooklist) return;
  const lists = await invoke("update_booklist", {
    name: activeBooklist.name,
    description: booklistDescription?.value || "",
    coverBookId: String(activeBooklist.cover_book_id || ""),
    bookIds: activeBooklist.book_ids || [],
  });
  activeBooklist = (lists || []).find((list) => organizationKey(list.name) === organizationKey(activeBooklist.name)) || activeBooklist;
}
let booklistDragState = null;
function animateBooklistInsert(beforeNode) {
  const state = booklistDragState;
  if (!state) return;
  const placeholder = state.placeholder;
  if ((beforeNode && beforeNode === placeholder) || placeholder.nextSibling === beforeNode) return;
  if (!beforeNode && placeholder === booklistBooks.lastElementChild) return;
  if (!global.ReaderAnimationSettings?.enabled?.("booklistSort")) {
    booklistBooks.insertBefore(placeholder, beforeNode || null);
    return;
  }
  const before = new Map();
  Array.from(booklistBooks.children).forEach((row) => {
    if (row !== state.row) before.set(row, row.getBoundingClientRect().top);
  });
  booklistBooks.insertBefore(placeholder, beforeNode || null);
  Array.from(booklistBooks.children).forEach((row) => {
    if (row === state.row) return;
    const first = before.get(row);
    if (first === undefined) return;
    const delta = first - row.getBoundingClientRect().top;
    if (!delta) return;
    row.style.transition = "none";
    row.style.transform = "translateY(" + delta + "px)";
    row.getBoundingClientRect();
    requestFrame(() => {
      row.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1), background .16s ease, border-color .16s ease, box-shadow .16s ease";
      row.style.transform = "";
    });
  });
}
function moveBooklistDrag(clientY) {
  const state = booklistDragState;
  if (!state) return;
  state.row.style.top = clientY - state.offsetY + "px";
  const rows = Array.from(booklistBooks.querySelectorAll(".booklist-row")).filter((row) => row !== state.row);
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      animateBooklistInsert(row);
      return;
    }
  }
  animateBooklistInsert(null);
}
function attachBooklistDrag(row, grip) {
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const box = row.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "booklist-placeholder";
    booklistBooks.insertBefore(placeholder, row.nextSibling);
    row.classList.add("dragging");
    row.style.position = "fixed";
    row.style.left = box.left + "px";
    row.style.top = box.top + "px";
    row.style.width = box.width + "px";
    row.style.height = box.height + "px";
    booklistDragState = { row, placeholder, offsetY: event.clientY - box.top };
    try { grip.setPointerCapture(event.pointerId); } catch (_) {}
  });
  grip.addEventListener("pointermove", (event) => {
    if (!booklistDragState) return;
    event.preventDefault();
    event.stopPropagation();
    moveBooklistDrag(event.clientY);
  });
  const finish = async (event) => {
    const state = booklistDragState;
    if (!state || state.row !== row) return;
    event?.preventDefault();
    event?.stopPropagation();
    try { grip.releasePointerCapture(event.pointerId); } catch (_) {}
    booklistDragState = null;
    booklistBooks.insertBefore(state.row, state.placeholder);
    state.placeholder.remove();
    state.row.classList.remove("dragging");
    state.row.style.position = "";
    state.row.style.left = "";
    state.row.style.top = "";
    state.row.style.width = "";
    state.row.style.height = "";
    activeBooklist.book_ids = Array.from(booklistBooks.querySelectorAll(".booklist-row")).map((item) => item.dataset.bookId);
    try {
      await saveActiveBooklist();
      renderBooklist(activeBooklist);
    } catch (error) {
      alertAction("保存书单顺序失败：" + error);
      openBooklist(activeBooklist.name);
    }
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}
function renderBooklist(list) {
  activeBooklist = list;
  booklistTitle.textContent = "书单 · " + list.name;
  booklistDescription.value = list.description || "";
  setBooklistCover(list);
  booklistBooks.replaceChildren();
  const ids = Array.isArray(list.book_ids) ? list.book_ids : [];
  if (!ids.length) {
    const empty = document.createElement("div");
    empty.className = "similar-empty";
    empty.textContent = "这份书单暂时没有图书。";
    booklistBooks.appendChild(empty);
    return;
  }
  ids.forEach((id, index) => {
    const book = booklistBook(id);
    if (!book) return;
    const row = document.createElement("div");
    row.className = "booklist-row";
    row.dataset.bookId = String(book.id);
    const rank = document.createElement("div");
    rank.className = "booklist-rank";
    rank.textContent = String(index + 1);
    const thumb = document.createElement("div");
    thumb.className = "booklist-thumb";
    if (book.cover) {
      const image = document.createElement("img");
      image.src = book.cover;
      image.alt = book.title || "";
      thumb.appendChild(image);
    } else {
      thumb.textContent = book.title || "未命名";
    }
    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "booklist-book-title";
    title.textContent = book.title || "未命名";
    const meta = document.createElement("div");
    meta.className = "booklist-book-meta";
    meta.textContent = book.author || "未知作者";
    info.append(title, meta);
    info.addEventListener("dblclick", () => invoke("open_book", { id: String(book.id) }).catch((error) => alertAction("打开失败：" + error)));
    const actions = document.createElement("div");
    actions.className = "booklist-row-actions";
    const cover = menuButton(String(activeBooklist.cover_book_id) === String(book.id) ? "当前封面" : "设为封面");
    cover.disabled = String(activeBooklist.cover_book_id) === String(book.id);
    cover.addEventListener("click", async () => {
      activeBooklist.cover_book_id = String(book.id);
      await saveActiveBooklist();
      renderBooklist(activeBooklist);
    });
    const grip = menuButton("", "booklist-grip");
    grip.title = "拖动排序";
    grip.setAttribute("aria-label", "拖动排序");
    attachBooklistDrag(row, grip);
    actions.append(cover, grip);
    row.append(rank, thumb, info, actions);
    booklistBooks.appendChild(row);
  });
}
async function openBooklist(name) {
  if (!booklistModal) return;
  booklistModal.classList.add("show");
  booklistTitle.textContent = "书单 · " + name;
  booklistBooks.innerHTML = '<div class="similar-empty">正在读取书单…</div>';
  try {
    const lists = await invoke("list_booklists");
    const list = (lists || []).find((item) => organizationKey(item.name) === organizationKey(name));
    if (!list) throw new Error("找不到这个书单");
    renderBooklist(list);
  } catch (error) {
    booklistBooks.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "similar-empty";
    empty.textContent = "读取失败：" + error;
    booklistBooks.appendChild(empty);
  }
}
booklistDescription?.addEventListener("blur", () => {
  if (!activeBooklist) return;
  activeBooklist.description = booklistDescription.value;
  saveActiveBooklist().catch((error) => alertAction("保存书单简介失败：" + error));
});
booklistClose?.addEventListener("click", () => booklistModal?.classList.remove("show"));
booklistModal?.addEventListener("click", (event) => {
  if (event.target === booklistModal) booklistModal.classList.remove("show");
});
function closeBookOrganizer() {
  organizerBookId = null;
  organizerAnchor = null;
  organizerMenu?.classList?.remove("show");
}
function menuButton(text, className = "org-action") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}
function createBookOrganizerAnchor(element, event) {
  if (!element?.getBoundingClientRect) return null;
  const rect = element.getBoundingClientRect();
  const width = Number.isFinite(rect.width) ? rect.width : Math.max(0, (rect.right || 0) - (rect.left || 0));
  const height = Number.isFinite(rect.height) ? rect.height : Math.max(0, (rect.bottom || 0) - (rect.top || 0));
  const pointerX = Number.isFinite(event?.clientX) ? event.clientX : rect.left + width / 2;
  const pointerY = Number.isFinite(event?.clientY) ? event.clientY : rect.top + height / 2;
  return {
    element,
    offsetX: Math.max(0, Math.min(width, pointerX - rect.left)),
    offsetY: Math.max(0, Math.min(height, pointerY - rect.top)),
    menuOffsetX: null,
    menuOffsetY: null,
  };
}
function organizerAnchorIsVisible(rect, viewportWidth, viewportHeight) {
  const contentRect = contentEl?.getBoundingClientRect?.();
  const left = Math.max(0, Number.isFinite(contentRect?.left) ? contentRect.left : 0);
  const top = Math.max(0, Number.isFinite(contentRect?.top) ? contentRect.top : 0);
  const right = Math.min(viewportWidth, Number.isFinite(contentRect?.right) ? contentRect.right : viewportWidth);
  const bottom = Math.min(viewportHeight, Number.isFinite(contentRect?.bottom) ? contentRect.bottom : viewportHeight);
  return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
}
function positionBookOrganizer(initialPlacement = false) {
  if (!organizerMenu || !organizerAnchor?.element?.getBoundingClientRect) return;
  if (organizerAnchor.element.isConnected === false) {
    closeBookOrganizer();
    return;
  }
  const margin = 8;
  const width = organizerMenu.offsetWidth || 300;
  const height = organizerMenu.offsetHeight || 360;
  const viewportWidth = global.innerWidth || 1280;
  const viewportHeight = global.innerHeight || 800;
  const rect = organizerAnchor.element.getBoundingClientRect();
  if (!organizerAnchorIsVisible(rect, viewportWidth, viewportHeight)) {
    closeBookOrganizer();
    return;
  }
  const anchorX = rect.left + organizerAnchor.offsetX;
  const anchorY = rect.top + organizerAnchor.offsetY;
  // 整理菜单属于书架内容区，不能盖住固定的窗口工具栏。右键首排封面时尤其
  // 需要用内容区而非整个 viewport 作为纵向边界。
  const contentRect = contentEl?.getBoundingClientRect?.();
  const contentTop = Math.max(margin, Number.isFinite(contentRect?.top) ? contentRect.top + margin : margin);
  const contentBottom = Math.min(viewportHeight - margin, Number.isFinite(contentRect?.bottom) ? contentRect.bottom - margin : viewportHeight - margin);
  const maxTop = Math.max(contentTop, contentBottom - height);
  if (initialPlacement || !Number.isFinite(organizerAnchor.menuOffsetX) || !Number.isFinite(organizerAnchor.menuOffsetY)) {
    const left = Math.max(margin, Math.min(anchorX, viewportWidth - width - margin));
    const top = Math.max(contentTop, Math.min(anchorY, maxTop));
    organizerAnchor.menuOffsetX = left - rect.left;
    organizerAnchor.menuOffsetY = top - rect.top;
  }
  // 打开时只做一次内容区内定位；书架发生滚动时会直接收起菜单，避免弹层
  // 脱离原封面并遮住窗口菜单栏。
  organizerMenu.style.left = rect.left + organizerAnchor.menuOffsetX + "px";
  organizerMenu.style.top = rect.top + organizerAnchor.menuOffsetY + "px";
}
function scheduleBookOrganizerPosition() {
  if (organizerPositionScheduled || !organizerAnchor || !organizerMenu?.classList?.contains("show")) return;
  organizerPositionScheduled = true;
  requestFrame(() => {
    organizerPositionScheduled = false;
    positionBookOrganizer();
  });
}
function scheduleBookOrganizerResize() {
  if (organizerAnchor) {
    organizerAnchor.menuOffsetX = null;
    organizerAnchor.menuOffsetY = null;
  }
  scheduleBookOrganizerPosition();
}
function applyOrganizationChoice(book, field, entry, checked) {
  const values = new Map((book[field] || []).map((value) => [organizationKey(value), organizationName(value)]));
  if (checked) values.set(entry.key, entry.name); else values.delete(entry.key);
  return Array.from(values.values());
}
async function saveBookOrganization(book, tags, collections) {
  try {
    const list = await invoke("set_book_organization", { id: book.id, tags, collections });
    render(list);
    const refreshed = getBook(book.id);
    if (refreshed) renderBookOrganizer(refreshed);
  } catch (error) {
    alertAction("保存标签或收藏夹失败：" + error);
  }
}
function appendOrganizationSection(menu, book, field, heading, addPlaceholder) {
  const section = document.createElement("section");
  section.className = "org-section";
  const head = document.createElement("div");
  head.className = "org-section-head";
  const title = document.createElement("strong");
  title.textContent = heading;
  const manage = menuButton("管理");
  manage.addEventListener("click", () => renderOrganizationManager(field, heading));
  head.append(title, manage);
  section.appendChild(head);

  const entries = organizationEntries(field);
  const selectedKeys = new Set((book[field] || []).map(organizationKey));
  if (entries.length) {
    const choices = document.createElement("div");
    choices.className = "org-choices";
    entries.forEach((entry) => {
      const label = document.createElement("label");
      label.className = "org-choice";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedKeys.has(entry.key);
      checkbox.addEventListener("change", () => {
        const values = applyOrganizationChoice(book, field, entry, checkbox.checked);
        saveBookOrganization(book, field === "tags" ? values : (book.tags || []), field === "collections" ? values : (book.collections || []));
      });
      const labelText = document.createElement("span");
      labelText.textContent = entry.name;
      label.append(checkbox, labelText);
      choices.appendChild(label);
    });
    section.appendChild(choices);
  }
  const create = document.createElement("div");
  create.className = "org-create";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 32;
  input.placeholder = addPlaceholder;
  const add = menuButton("添加", "org-add");
  const addValue = () => {
    const name = organizationName(input.value);
    if (!name) return;
    if (organizationAlreadyAssigned(book, field, [name])) {
      alertAction("《" + (book.title || "未命名图书") + "》已加入" + (field === "tags" ? "标签" : "收藏"));
      return;
    }
    const entry = { name, key: organizationKey(name) };
    const values = applyOrganizationChoice(book, field, entry, true);
    saveBookOrganization(book, field === "tags" ? values : (book.tags || []), field === "collections" ? values : (book.collections || []));
  };
  add.addEventListener("click", addValue);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); addValue(); }
  });
  create.append(input, add);
  section.appendChild(create);
  menu.appendChild(section);
}
function renderBookOrganizer(book) {
  if (!organizerMenu || !book) return;
  organizerBookId = String(book.id);
  organizerMenu.replaceChildren();
  const head = document.createElement("div");
  head.className = "org-menu-head";
  const title = document.createElement("strong");
  title.textContent = "整理《" + (book.title || "未命名图书") + "》";
  const close = menuButton("×", "org-close");
  close.setAttribute("aria-label", "关闭");
  close.addEventListener("click", closeBookOrganizer);
  head.append(title, close);
  organizerMenu.appendChild(head);
  appendOrganizationSection(organizerMenu, book, "tags", "标签", "新建标签");
  appendOrganizationSection(organizerMenu, book, "collections", "收藏夹", "新建收藏夹");
  scheduleBookOrganizerPosition();
}
function renderOrganizationManager(field, heading) {
  if (!organizerMenu) return;
  organizerMenu.replaceChildren();
  const head = document.createElement("div");
  head.className = "org-menu-head";
  const back = menuButton("‹ 返回", "org-back");
  back.addEventListener("click", () => {
    const book = getBook(organizerBookId);
    if (book) renderBookOrganizer(book); else closeBookOrganizer();
  });
  const title = document.createElement("strong");
  title.textContent = "管理" + heading;
  head.append(back, title);
  organizerMenu.appendChild(head);
  const entries = organizationEntries(field);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "org-empty";
    empty.textContent = "暂无" + heading;
    organizerMenu.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "org-manage-row";
    const name = document.createElement("span");
    name.textContent = entry.name + "（" + entry.count + "）";
    const rename = menuButton("改名");
    rename.addEventListener("click", async () => {
      const next = organizationName(global.prompt("新的" + heading + "名称：", entry.name));
      if (!next || next === entry.name) return;
      try {
        render(await invoke("rename_book_organization", { kind: field === "tags" ? "tag" : "collection", name: entry.name, newName: next }));
        renderOrganizationManager(field, heading);
      } catch (error) { alertAction("改名失败：" + error); }
    });
    const remove = menuButton("删除", "org-danger");
    remove.addEventListener("click", async () => {
      if (!confirmAction("删除“" + entry.name + "”？它会从所有图书中移除。")) return;
      try {
        render(await invoke("delete_book_organization", { kind: field === "tags" ? "tag" : "collection", name: entry.name }));
        renderOrganizationManager(field, heading);
      } catch (error) { alertAction("删除失败：" + error); }
    });
    if (field === "collections") {
      const open = menuButton("打开");
      open.addEventListener("click", () => {
        closeBookOrganizer();
        openBooklist(entry.name);
      });
      row.append(name, open, rename, remove);
    } else {
      row.append(name, rename, remove);
    }
    organizerMenu.appendChild(row);
  });
  scheduleBookOrganizerPosition();
}
function openBookOrganizer(book, event, anchorElement) {
  if (!organizerMenu) return;
  organizerAnchor = createBookOrganizerAnchor(anchorElement, event);
  renderBookOrganizer(book);
  organizerMenu.classList.add("show");
  positionBookOrganizer(true);
}
if (organizerMenu) organizerMenu.addEventListener("click", (event) => event.stopPropagation());
if (typeof document.addEventListener === "function") {
  document.addEventListener("pointerdown", (event) => {
    if (organizerMenu?.classList?.contains("show") && !organizerMenu.contains?.(event.target)) closeBookOrganizer();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeBookOrganizer(); });
}

const selectionGroup = document.getElementById("del-group");
const selectionDeleteButton = document.getElementById("del-btn");
const bookInfoButton = document.getElementById("book-info-btn");
function updateSelectionUi() {
  if (selected.size > 0) {
    selectionGroup.classList.add("show");
    bookInfoButton.style.display = selected.size === 1 ? "" : "none";
    selectionDeleteButton.textContent = "🗑 删除选中 (" + selected.size + ")";
  } else {
    selectionGroup.classList.remove("show");
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
  updateSelectionUi();
}
function clearSelection() {
  selected = new Set();
  applyView();
  updateSelectionUi();
}
function selectAll() {
  // 菜单入口承诺的是“全选”，应覆盖完整书库；搜索和筛选只影响展示，
  // 不能让批量删除悄悄漏掉当前未显示的图书。
  closeSearch(true);
  selected = new Set(books.map((book) => book.id));
  applyView();
  updateSelectionUi();
}
selectionDeleteButton.addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirmAction("确定删除选中的 " + selected.size + " 本书？（不会删除磁盘上的文件）")) return;
  const ids = Array.from(selected);
  const list = await invoke("remove_books", { ids });
  selected = new Set();
  updateSelectionUi();
  render(list);
});
document.getElementById("del-cancel").addEventListener("click", clearSelection);
document.getElementById("mi-selectall").addEventListener("click", () => {
  menuEl.classList.remove("show");
  selectAll();
});
document.getElementById("mi-random").addEventListener("click", () => {
  menuEl.classList.remove("show");
  if (!books.length) {
    alertAction("书架还是空的", { variant: "text", duration: 1500 });
    return;
  }
  const book = books[Math.floor(Math.random() * books.length)];
  clearCrossReturnMemory();
  invoke("open_book", { id: book.id });
});

let shelfScrollUpdateRaf = 0;
let shelfRendering = false;
function updateShelfScrollbar() {
  shelfScrollUpdateRaf = 0;
  if (shelfRendering) return;
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  const viewport = contentEl.clientHeight;
  const total = contentEl.scrollHeight;
  const maxScroll = Math.max(0, total - viewport);
  if (viewport <= 0 || maxScroll <= 1) {
    shelfScrollbar.classList.remove("show");
    return;
  }
  shelfScrollbar.classList.add("show");
  const trackHeight = shelfScrollbar.clientHeight;
  const thumbHeight = Math.max(28, Math.round((viewport / total) * trackHeight));
  const maxTop = Math.max(0, trackHeight - thumbHeight);
  const top = maxScroll ? Math.round((contentEl.scrollTop / maxScroll) * maxTop) : 0;
  shelfScrollbarThumb.style.height = thumbHeight + "px";
  shelfScrollbarThumb.style.transform = "translateY(" + top + "px)";
}
function scheduleShelfScrollbarUpdate() {
  if (shelfScrollUpdateRaf) return;
  shelfScrollUpdateRaf = requestFrame(updateShelfScrollbar);
}
function initShelfScrollbar() {
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  contentEl.addEventListener("scroll", scheduleShelfScrollbarUpdate, { passive: true });
  contentEl.addEventListener("scroll", closeBookOrganizer, { passive: true });
  global.addEventListener("resize", scheduleShelfScrollbarUpdate);
  global.addEventListener("resize", scheduleBookOrganizerResize);

  shelfScrollbar.addEventListener("pointerdown", (e) => {
    if (!shelfScrollbar.classList.contains("show")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = shelfScrollbar.getBoundingClientRect();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    const maxTop = Math.max(1, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    if (e.target !== shelfScrollbarThumb) {
      const targetTop = Math.min(maxTop, Math.max(0, e.clientY - rect.top - thumbHeight / 2));
      contentEl.scrollTop = (targetTop / maxTop) * maxScroll;
    }
    dragging = true;
    dragStartY = e.clientY;
    dragStartScrollTop = contentEl.scrollTop;
    shelfScrollbar.classList.add("dragging");
    shelfScrollbar.setPointerCapture(e.pointerId);
  });
  shelfScrollbar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    const maxTop = Math.max(1, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    contentEl.scrollTop = dragStartScrollTop + ((e.clientY - dragStartY) / maxTop) * maxScroll;
  });
  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    shelfScrollbar.classList.remove("dragging");
    try { shelfScrollbar.releasePointerCapture(e.pointerId); } catch (_) {}
    scheduleShelfScrollbarUpdate();
  };
  shelfScrollbar.addEventListener("pointerup", stopDrag);
  shelfScrollbar.addEventListener("pointercancel", stopDrag);
  scheduleShelfScrollbarUpdate();
}
initShelfScrollbar();

let viewRenderToken = 0;
function applyView(options = {}) {
  const token = ++viewRenderToken;
  const preserveScroll = options.preserveScroll !== false && shelfLoaded;
  const savedScrollTop = preserveScroll && contentEl ? contentEl.scrollTop : 0;
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.classList.toggle("show-titles", showCoverTitle); // 网格视图是否显示书名
  applyShelfGridColumns();
  firstScreenCoverCount = Math.max(DEFAULT_FIRST_SCREEN_COVER_COUNT, estimateFirstScreenCoverCount());
  shelfRendering = true;
  const list = currentList();
  updateShelfFilterStatus(list.length);
  if (!shelfLoaded) {
    emptyEl.style.display = "none";
  } else if (list.length) {
    emptyEl.style.display = "none";
  } else {
    emptyEl.textContent = searchQuery
      ? "没有匹配的书籍"
      : hasActiveShelfFilters()
        ? "没有符合当前筛选条件的书籍。"
        : "书架还是空的。点右上角「⋮」→「导入书籍」添加（可一次选多本）。";
    emptyEl.style.display = "block";
  }
  const sorted = sortBooks(list);
  const finishCoverRender = startPerformance("cover-render", "critical books=" + sorted.length + " layout=" + layout);
  let chunks = 0;
  function restoreShelfScroll() {
    if (!preserveScroll || !contentEl) return;
    const maxScroll = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
    contentEl.scrollTop = Math.min(savedScrollTop, maxScroll);
  }
  function finishRender() {
    restoreShelfScroll();
    shelfRendering = false;
    finishCoverRender("chunks=" + chunks);
    scheduleShelfScrollbarUpdate();
  }
  if (!sorted.length) {
    shelfEl.replaceChildren();
    finishRender();
    return;
  }

  const existingCards = new Map();
  Array.from(shelfEl.children).forEach((node) => {
    if (node.classList && node.classList.contains("book") && node.dataset.id) existingCards.set(node.dataset.id, node);
  });
  let changedCards = 0;
  for (const b of sorted) {
    const card = existingCards.get(b.id);
    if (!card || card.dataset.renderKey !== bookRenderKey(b)) changedCards += 1;
  }
  const shouldReuse = existingCards.size > 0 && changedCards <= Math.max(24, sorted.length * 0.35);
  if (shouldReuse) {
    const frag = document.createDocumentFragment();
    sorted.forEach((b, index) => {
      const key = bookRenderKey(b);
      let card = existingCards.get(b.id);
      if (!card || card.dataset.renderKey !== key) {
        card = bookCard(b, index);
      } else {
        card.classList.toggle("selected", selected.has(b.id));
      }
      frag.appendChild(card);
    });
    shelfEl.replaceChildren(frag);
    chunks = 1;
    finishRender();
    return;
  }

  let i = 0;
  function makeChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + 28, sorted.length);
    for (; i < end; i++) frag.appendChild(bookCard(sorted[i], i));
    chunks += 1;
    return frag;
  }
  shelfEl.replaceChildren(makeChunk());
  restoreShelfScroll();
  function appendChunk() {
    if (token !== viewRenderToken) {
      shelfRendering = false;
      return;
    }
    shelfEl.appendChild(makeChunk());
    restoreShelfScroll();
    if (i < sorted.length) setTimeout(appendChunk, 0);
    else finishRender();
  }
  if (i < sorted.length) setTimeout(appendChunk, 0);
  else finishRender();
}
let lastJSON = ""; // 上次渲染的数据快照，数据没变就不重渲染（避免封面重载闪烁）
function render(list) {
  shelfLoaded = true;
  books = list;
  renderOrganizationFilters();
  if (books.length && minRating > 0 && !books.some((b) => (b.rating || 0) >= minRating)) {
    minRating = 0;
    localStorage.removeItem("minRating");
    filterStarsEl?.setVal?.(0);
  }
  const j = JSON.stringify(list);
  if (j === lastJSON) return;
  lastJSON = j;
  applyView();
}

function getBook(id) {
  return books.find((book) => String(book.id) === String(id)) || null;
}
function updateBook(id, patch) {
  const index = books.findIndex((book) => String(book.id) === String(id));
  if (index >= 0) books[index] = Object.assign({}, books[index], patch);
  lastJSON = JSON.stringify(books);
  applyView();
  updateSelectionUi();
}
function setSearchQuery(value) {
  const next = String(value || "").trim().toLowerCase();
  if (next === searchQuery) return;
  searchQuery = next;
  applyView();
}
function focusShelf() {
  if (!contentEl || typeof contentEl.focus !== "function") return;
  contentEl.focus({ preventScroll: true });
}
async function changeCoverById(id) {
  const book = getBook(id);
  if (book) await changeCover(book);
}

let lastFocusRefreshAt = 0;
global.addEventListener("focus", () => {
  if (!shelfLoaded) return;
  const now = Date.now();
  if (now - lastFocusRefreshAt < 1500) return;
  lastFocusRefreshAt = now;
  invoke("list_books").then(render).catch(() => {});
});
global.addEventListener("app-language-changed", () => {
  updateShelfFilterStatus(currentList().length);
  renderOrganizationMatchMode();
});

  activeController = Object.freeze({
    applyView,
    changeCoverById,
    clearSelection,
    count: () => books.length,
    coverColor: colorFor,
    getBook,
    getBooks: () => books.slice(),
    getSearchQuery: () => searchQuery,
    getSelectedIds: () => Array.from(selected),
    getVisibleBooks: () => currentList().slice(),
    focusShelf,
    makeStars,
    openBooklist,
    render,
    selectAll,
    setSearchQuery,
    updateBook,
  });
  return activeController;
}

function controller() {
  if (!activeController) throw new Error("ReaderShelfUI 尚未初始化");
  return activeController;
}

global.ReaderShelfUI = Object.freeze({
  clearSelection: () => controller().clearSelection(),
  getSearchQuery: () => controller().getSearchQuery(),
  getSelectedIds: () => controller().getSelectedIds(),
  init,
  focusShelf: () => controller().focusShelf(),
  refresh: () => controller().applyView(),
  render: (list) => controller().render(list),
  setSearchQuery: (value) => controller().setSearchQuery(value),
});
})(typeof window !== "undefined" ? window : globalThis);
