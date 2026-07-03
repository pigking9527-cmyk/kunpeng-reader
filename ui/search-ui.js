// 主窗口搜索框、搜索历史和全书架正文检索入口。
// 书架过滤仍由 app.js 的 searchQuery/currentList/applyView 负责。
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
function syncSearchTabStops() {
  const open = searchWrap.classList.contains("open");
  const clearVisible = !!searchInput.value;
  const shelfSearchInput = document.getElementById("shelf-search-chk");
  searchInput.tabIndex = open ? 0 : -1;
  if (searchClear) searchClear.tabIndex = open && clearVisible ? 0 : -1;
  if (shelfSearchInput) shelfSearchInput.tabIndex = open ? 0 : -1;
}
function updateSearchClear() {
  if (!searchClear) return;
  searchClear.classList.toggle("show", !!searchInput.value);
  syncSearchTabStops();
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
  syncSearchTabStops();
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
  syncSearchTabStops();
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
    syncSearchTabStops();
    hideHistory();
  }
}
searchWrap.addEventListener("mouseenter", () => {
  cancelSearchCollapse();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  closeAccountPanel();
  searchWrap.classList.add("open");
  syncSearchTabStops();
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
syncSearchTabStops();
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
