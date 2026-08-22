interface SearchI18nLike {
  t?(key: string): string;
}

interface ShelfUiLike {
  setSearchQuery(query: string): void;
  getSearchQuery(): unknown;
  getSelectedIds(): unknown[];
  refresh(): void;
}

interface SyncUiLike {
  close(): void;
}

interface SearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SearchRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: SearchStorage;
  readonly ReaderAppI18n?: SearchI18nLike;
  readonly ReaderShelfUI: ShelfUiLike;
  readonly ReaderSyncUI: SyncUiLike;
  openDebugModal?(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  setTimeout(handler: TimerHandler, timeout?: number): number;
  clearTimeout(handle?: number): void;
  saveHistory?: SearchUiController["saveHistory"];
  addHistory?: SearchUiController["addHistory"];
  renderHistory?: SearchUiController["renderHistory"];
  showHistory?: SearchUiController["showHistory"];
  hideHistory?: SearchUiController["hideHistory"];
  syncSearchTabStops?: SearchUiController["syncSearchTabStops"];
  updateSearchClear?: SearchUiController["updateSearchClear"];
  clearSearchInput?: SearchUiController["clearSearchInput"];
  closeSearch?: SearchUiController["closeSearch"];
  cancelSearchCollapse?: SearchUiController["cancelSearchCollapse"];
  maybeCollapseSearch?: SearchUiController["maybeCollapseSearch"];
  updateShelfSearchMode?: SearchUiController["updateShelfSearchMode"];
  runShelfSearch?: SearchUiController["runShelfSearch"];
  closeShelfSearchModal?: SearchUiController["closeShelfSearchModal"];
}

export interface SearchUiController {
  saveHistory(): void;
  addHistory(query: unknown): void;
  renderHistory(): void;
  showHistory(): void;
  hideHistory(): void;
  syncSearchTabStops(): void;
  updateSearchClear(): void;
  clearSearchInput(): void;
  closeSearch(clear: unknown): void;
  cancelSearchCollapse(): void;
  maybeCollapseSearch(): void;
  updateShelfSearchMode(): void;
  runShelfSearch(term: unknown): void;
  closeShelfSearchModal(): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): SearchRuntime | null {
  const target = record(value);
  if (
    !target ||
    !record(target.document) ||
    !record(target.localStorage) ||
    !record(target.ReaderShelfUI) ||
    !record(target.ReaderSyncUI) ||
    typeof target.addEventListener !== "function" ||
    typeof target.setTimeout !== "function" ||
    typeof target.clearTimeout !== "function"
  ) {
    return null;
  }
  return target as unknown as SearchRuntime;
}

function element<T extends HTMLElement>(document: Document, id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Search UI requires #${id}.`);
  return value as T;
}

export function initializeSearchUi(runtime: SearchRuntime): SearchUiController {
  const document = runtime.document;
  const historyEl = element<HTMLElement>(document, "search-history");
  const searchWrap = element<HTMLElement>(document, "search-wrap");
  const searchInput = element<HTMLInputElement>(document, "search-input");
  const searchClear = element<HTMLElement>(document, "search-clear");
  const menuEl = element<HTMLElement>(document, "menu");
  const filterPanel = element<HTMLElement>(document, "filter-panel");
  const shelfChk = element<HTMLInputElement>(document, "shelf-search-chk");
  const shelfToggle = element<HTMLElement>(document, "shelf-toggle");
  const shelfSearchModal = element<HTMLElement>(document, "shelf-search-modal");
  const shelfSearchFrame = element<HTMLIFrameElement>(document, "shelf-search-frame");
  const searchButton = element<HTMLElement>(document, "search-btn");
  const searchText = (key: string): string => runtime.ReaderAppI18n?.t?.(key) || key;
  let history: string[] = [];
  try {
    const loaded = JSON.parse(runtime.localStorage.getItem("searchHistory") || "[]") as unknown;
    history = loaded as string[];
  } catch {
    history = [];
  }
  let searchCollapseTimer: number | null = null;

  const saveHistory = (): void => {
    runtime.localStorage.setItem("searchHistory", JSON.stringify(history.slice(0, 12)));
  };

  const addHistory = (rawQuery: unknown): void => {
    const query = ((rawQuery || "") as string).trim();
    if (!query) return;
    history = history.filter((item) => item !== query);
    history.unshift(query);
    history = history.slice(0, 12);
    saveHistory();
  };

  const renderHistory = (): void => {
    historyEl.innerHTML = "";
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "sh-empty";
      empty.textContent = searchText("noSearchHistory");
      historyEl.appendChild(empty);
      return;
    }
    history.forEach((query) => {
      const item = document.createElement("div");
      item.className = "sh-item";
      const text = document.createElement("span");
      text.className = "sh-text";
      text.textContent = query;
      const remove = document.createElement("span");
      remove.className = "sh-del";
      remove.textContent = "✕";
      item.append(text, remove);
      item.addEventListener("click", (event) => {
        if (event.target === remove) {
          history = history.filter((entry) => entry !== query);
          saveHistory();
          renderHistory();
          return;
        }
        searchInput.value = query;
        updateSearchClear();
        if (shelfChk.checked) {
          runShelfSearch(query);
        } else {
          runtime.ReaderShelfUI.setSearchQuery(query);
          hideHistory();
        }
      });
      historyEl.appendChild(item);
    });
  };

  const showHistory = (): void => {
    renderHistory();
    historyEl.classList.add("show");
  };

  const hideHistory = (): void => {
    historyEl.classList.remove("show");
  };

  const syncSearchTabStops = (): void => {
    const open = searchWrap.classList.contains("open");
    const clearVisible = Boolean(searchInput.value);
    searchInput.tabIndex = open ? 0 : -1;
    searchClear.tabIndex = open && clearVisible ? 0 : -1;
    shelfChk.tabIndex = open ? 0 : -1;
  };

  const updateSearchClear = (): void => {
    searchClear.classList.toggle("show", Boolean(searchInput.value));
    syncSearchTabStops();
  };

  const clearSearchInput = (): void => {
    searchInput.value = "";
    updateSearchClear();
    if (shelfChk.checked) {
      showHistory();
    } else {
      runtime.ReaderShelfUI.setSearchQuery("");
      showHistory();
    }
    searchInput.focus();
  };

  const closeSearch = (clear: unknown): void => {
    const hadInput = Boolean(searchInput.value.trim());
    const hadQuery = Boolean(runtime.ReaderShelfUI.getSearchQuery());
    const wasOpen = searchWrap.classList.contains("open");
    if (hadInput) addHistory(searchInput.value);
    hideHistory();
    searchWrap.classList.remove("open");
    searchInput.blur();
    syncSearchTabStops();
    if (clear) {
      searchInput.value = "";
      updateSearchClear();
      runtime.ReaderShelfUI.setSearchQuery("");
      if (!hadQuery && wasOpen && hadInput) runtime.ReaderShelfUI.refresh();
    }
  };

  const cancelSearchCollapse = (): void => {
    if (searchCollapseTimer) {
      runtime.clearTimeout(searchCollapseTimer);
      searchCollapseTimer = null;
    }
  };

  const maybeCollapseSearch = (): void => {
    if (!searchInput.value.trim() && document.activeElement !== searchInput) {
      searchWrap.classList.remove("open");
      searchInput.blur();
      syncSearchTabStops();
      hideHistory();
    }
  };

  const updateShelfSearchMode = (): void => {
    searchInput.placeholder = searchText(
      shelfChk.checked ? "shelfSearchPlaceholder" : "searchPlaceholder",
    );
  };

  const runShelfSearch = (rawTerm: unknown): void => {
    const term = ((rawTerm || "") as string).trim();
    if (!term) return;
    addHistory(term);
    hideHistory();
    const selectedIds = runtime.ReaderShelfUI.getSelectedIds();
    const ids = selectedIds.length ? selectedIds : null;
    const idsCsv = ids ? ids.join(",") : "";
    shelfSearchFrame.src =
      `search.html?q=${encodeURIComponent(term)}` +
      `&ids=${encodeURIComponent(idsCsv)}`;
    shelfSearchModal.classList.add("show");
    closeSearch(true);
  };

  const closeShelfSearchModal = (): void => {
    shelfSearchModal.classList.remove("show");
    shelfSearchFrame.removeAttribute("src");
    closeSearch(true);
  };

  searchButton.addEventListener("click", (event) => {
    event.stopPropagation();
    menuEl.classList.remove("show");
    filterPanel.classList.remove("show");
    runtime.ReaderSyncUI.close();
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

  searchWrap.addEventListener("mouseenter", () => {
    cancelSearchCollapse();
    menuEl.classList.remove("show");
    filterPanel.classList.remove("show");
    runtime.ReaderSyncUI.close();
    searchWrap.classList.add("open");
    syncSearchTabStops();
    showHistory();
  });
  searchWrap.addEventListener("mouseleave", () => {
    searchCollapseTimer = runtime.setTimeout(maybeCollapseSearch, 250);
  });
  historyEl.addEventListener("mouseenter", cancelSearchCollapse);
  historyEl.addEventListener("mouseleave", () => {
    searchCollapseTimer = runtime.setTimeout(maybeCollapseSearch, 250);
  });

  try {
    shelfChk.checked =
      runtime.localStorage.getItem("shelfSearchEnabled") === "1";
  } catch {
    // The original search toggle treats unavailable storage as optional.
  }
  updateShelfSearchMode();
  syncSearchTabStops();
  shelfChk.addEventListener("click", (event) => event.stopPropagation());
  shelfToggle.addEventListener("click", (event) => event.stopPropagation());
  shelfChk.addEventListener("change", () => {
    runtime.localStorage.setItem(
      "shelfSearchEnabled",
      shelfChk.checked ? "1" : "0",
    );
    updateShelfSearchMode();
    const term = searchInput.value.trim();
    if (shelfChk.checked) {
      if (term) {
        runShelfSearch(term);
      } else {
        runtime.ReaderShelfUI.setSearchQuery("");
        showHistory();
      }
    } else {
      runtime.ReaderShelfUI.setSearchQuery(term);
    }
    searchInput.focus();
  });

  shelfSearchModal.addEventListener("click", (event) => {
    if (event.target === shelfSearchModal) closeShelfSearchModal();
  });
  runtime.addEventListener("app-language-changed", () => {
    updateShelfSearchMode();
    if (historyEl.classList.contains("show")) renderHistory();
  });
  searchInput.addEventListener("click", (event) => event.stopPropagation());
  searchClear.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearSearchInput();
  });
  historyEl.addEventListener("click", (event) => event.stopPropagation());
  searchInput.addEventListener("focus", showHistory);
  searchInput.addEventListener("input", () => {
    updateSearchClear();
    if (shelfChk.checked) {
      showHistory();
      return;
    }
    runtime.ReaderShelfUI.setSearchQuery(searchInput.value);
    if (searchInput.value.trim()) hideHistory();
    else showHistory();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearch(true);
    else if (event.key === "Enter") {
      const raw = searchInput.value.trim();
      if (raw === "--debug-ui") {
        event.preventDefault();
        hideHistory();
        searchWrap.classList.remove("open");
        searchInput.blur();
        runtime.openDebugModal?.();
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

  return Object.freeze({
    saveHistory,
    addHistory,
    renderHistory,
    showHistory,
    hideHistory,
    syncSearchTabStops,
    updateSearchClear,
    clearSearchInput,
    closeSearch,
    cancelSearchCollapse,
    maybeCollapseSearch,
    updateShelfSearchMode,
    runShelfSearch,
    closeShelfSearchModal,
  });
}

/** Classic installer replacing `ui/search-ui.js`. */
export function installSearchUi(target: unknown): SearchUiController | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const controller = initializeSearchUi(runtime);
  Object.assign(runtime, controller);
  return controller;
}
