// 主窗口搜索框、搜索历史和全书架正文检索入口。
// 书架过滤状态通过 ReaderShelfUI API 读写。
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
        window.ReaderShelfUI.setSearchQuery(q);
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
    window.ReaderShelfUI.setSearchQuery("");
    showHistory();
  }
  searchInput.focus();
}

function closeSearch(clear) {
  const hadInput = !!searchInput.value.trim();
  const hadQuery = !!window.ReaderShelfUI.getSearchQuery();
  const wasOpen = searchWrap.classList.contains("open");
  if (hadInput) addHistory(searchInput.value); // 记下这次搜索
  hideHistory();
  searchWrap.classList.remove("open");
  searchInput.blur();
  syncSearchTabStops();
  if (clear) {
    searchInput.value = "";
    updateSearchClear();
    window.ReaderShelfUI.setSearchQuery("");
    if (!hadQuery && wasOpen && hadInput) window.ReaderShelfUI.refresh();
  }
}
document.getElementById("search-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  window.ReaderSyncUI.close();
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
    searchInput.blur();
    syncSearchTabStops();
    hideHistory();
  }
}
searchWrap.addEventListener("mouseenter", () => {
  cancelSearchCollapse();
  menuEl.classList.remove("show");
  filterPanel.classList.remove("show");
  window.ReaderSyncUI.close();
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
// “书架搜索”开关：勾选后回车 → 对全书架（或选中的若干本）正文检索，结果在主窗口内展示
const shelfChk = document.getElementById("shelf-search-chk");
const shelfSearchModal = document.getElementById("shelf-search-modal");
const shelfSearchFrame = document.getElementById("shelf-search-frame");
const shelfSearchClose = document.getElementById("shelf-search-close");
try {
  shelfChk.checked = localStorage.getItem("shelfSearchEnabled") === "1";
} catch (e) {}
function updateShelfSearchMode() {
  searchInput.placeholder = shelfChk.checked ? "全书架正文检索，回车搜索…" : "搜索 书名 / 作者 / 简介";
}
updateShelfSearchMode();
syncSearchTabStops();
shelfChk.addEventListener("click", (e) => e.stopPropagation());
// 整个开关（含“书架搜索”四个字）点击都不要冒泡到 document 的关闭逻辑，否则勾选会收起搜索框
document.getElementById("shelf-toggle").addEventListener("click", (e) => e.stopPropagation());
shelfChk.addEventListener("change", () => {
  localStorage.setItem("shelfSearchEnabled", shelfChk.checked ? "1" : "0");
  updateShelfSearchMode();
  const term = searchInput.value.trim();
  if (shelfChk.checked) {
    // 有关键词时，切到全书架正文检索就直接打开全文检索页。
    if (term) {
      runShelfSearch(term);
    } else {
      window.ReaderShelfUI.setSearchQuery("");
      showHistory();
    }
  } else {
    window.ReaderShelfUI.setSearchQuery(term);
  }
  searchInput.focus();
});
function runShelfSearch(term) {
  term = (term || "").trim();
  if (!term) return;
  addHistory(term);
  hideHistory();
  const selectedIds = window.ReaderShelfUI.getSelectedIds();
  const ids = selectedIds.length ? selectedIds : null; // 有选中 → 只搜这几本；否则全部
  const idsCsv = ids ? ids.join(",") : "";
  shelfSearchFrame.src = "search.html?q=" + encodeURIComponent(term) + "&ids=" + encodeURIComponent(idsCsv);
  shelfSearchModal.classList.add("show");
  // 全文检索页已经接管了查询词。主窗口不应保留它，否则关闭结果页后再次
  // 展开搜索框会出现陈旧关键词，并让“点击空白处收起”的规则失效。
  closeSearch(true);
}

function closeShelfSearchModal() {
  shelfSearchModal.classList.remove("show");
  // 卸载结果页，避免下次打开时短暂显示上一轮搜索结果或保留其滚动/焦点状态。
  shelfSearchFrame.removeAttribute("src");
  closeSearch(true);
}
shelfSearchClose.addEventListener("click", closeShelfSearchModal);
shelfSearchModal.addEventListener("click", (e) => {
  if (e.target === shelfSearchModal) closeShelfSearchModal();
});

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
  window.ReaderShelfUI.setSearchQuery(searchInput.value);
  if (searchInput.value.trim()) hideHistory();
  else showHistory();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearch(true);
  else if (e.key === "Enter") {
    const raw = searchInput.value.trim();
    if (raw === "--debug-ui") {
      e.preventDefault();
      hideHistory();
      searchWrap.classList.remove("open");
      searchInput.blur();
      window.openDebugModal?.();
      return;
    }
    if (shelfChk.checked) {
      runShelfSearch(searchInput.value);
    } else {
      addHistory(searchInput.value);
      hideHistory();
    }
  }
});
