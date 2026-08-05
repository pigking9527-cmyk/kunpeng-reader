/* A reader-oriented NewsNow client: local source preferences, bounded loading,
   and a chronological feed.  It never shares reader/account state upstream. */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 18000;
  const NEWSNOW_HOME_URL = "https://newsnow.busiyi.world/";
  const SOURCE_STORAGE_KEY = "kunpeng.reader.news.sources.v2";
  const LAYOUT_STORAGE_KEY = "kunpeng.reader.news.layout.v1";
  const MAX_SOURCES = 12;

  function text(value) {
    return String(value == null ? "" : value);
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function resultItems(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result && result.items)) return result.items;
    if (Array.isArray(result && result.data)) return result.data;
    if (Array.isArray(result && result.news)) return result.news;
    return [];
  }

  function withTimeout(promise, timeoutMs = LOAD_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = global.setTimeout(() => reject(new Error("资讯请求超时")), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout])
      .finally(() => global.clearTimeout(timer));
  }

  function itemDate(item) {
    const value = item.published_at || item.publishedAt || item.published || item.time || item.created_at || item.createdAt;
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(date);
    }
    return text(value);
  }

  function sourceCategory(source) {
    return text(source && source.category).trim() || "其他";
  }

  function defaultSourceIds(catalog) {
    return catalog.filter((source) => source.defaultEnabled || source.default_enabled).map((source) => text(source.id));
  }

  function allowedSourceIds(ids, catalog) {
    const allowed = new Set(catalog.map((source) => text(source.id)));
    const seen = new Set();
    return (Array.isArray(ids) ? ids : []).map(text).filter((id) => allowed.has(id) && !seen.has(id) && (seen.add(id), true)).slice(0, MAX_SOURCES);
  }

  function loadStoredSourceIds(catalog) {
    try {
      const saved = JSON.parse(global.localStorage.getItem(SOURCE_STORAGE_KEY));
      const selected = allowedSourceIds(saved, catalog);
      return selected.length ? selected : defaultSourceIds(catalog);
    } catch (_) {
      return defaultSourceIds(catalog);
    }
  }

  function saveSourceIds(ids) {
    try { global.localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(ids)); } catch (_) { /* preferences are optional */ }
  }

  function loadLayout() {
    try {
      return global.localStorage.getItem(LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "list";
    } catch (_) {
      return "list";
    }
  }

  function init({ root = document, invoke = global.__TAURI__?.core?.invoke } = {}) {
    const button = root.getElementById("newsnow-toolbar-btn");
    const page = root.getElementById("newsnow-page");
    const back = root.getElementById("newsnow-back");
    const refresh = root.getElementById("newsnow-refresh");
    const sourceToggle = root.getElementById("newsnow-source-toggle");
    const sourcePicker = root.getElementById("newsnow-source-picker");
    const sourceSearch = root.getElementById("newsnow-source-search");
    const sourceOptions = root.getElementById("newsnow-source-options");
    const sourceClose = root.getElementById("newsnow-source-close");
    const sourceApply = root.getElementById("newsnow-source-apply");
    const sourceReset = root.getElementById("newsnow-source-reset");
    const sourceSummary = root.getElementById("newsnow-source-summary");
    const listLayout = root.getElementById("newsnow-layout-list");
    const gridLayout = root.getElementById("newsnow-layout-grid");
    const status = root.getElementById("newsnow-status");
    const feed = root.getElementById("newsnow-feed");
    const reader = root.getElementById("newsnow-reader");
    const readerBack = root.getElementById("newsnow-reader-back");
    const readerStatus = root.getElementById("newsnow-reader-status");
    const readerFrame = root.getElementById("newsnow-reader-frame");
    const categories = root.getElementById("newsnow-categories");
    const updated = root.getElementById("newsnow-updated");
    const shell = root.querySelector(".content-shell");
    if (!button || !page || !back || !refresh || !sourceToggle || !sourcePicker || !sourceSearch || !sourceOptions || !sourceClose || !sourceApply || !sourceReset || !sourceSummary || !listLayout || !gridLayout || !status || !feed || !reader || !readerBack || !readerStatus || !readerFrame || !categories || !updated || !shell) return null;

    let catalog = [];
    let sourceIds = [];
    let pendingSourceIds = [];
    let allItems = [];
    let selectedCategory = "全部";
    let loading = false;
    let catalogueLoading = null;
    let sourceQuery = "";
    let layout = loadLayout();
    let articleUrl = "";
    let articleScrollTop = 0;

    function newsEnabled() {
      return global.ReaderExperimentalFeatures?.enabled?.("newsnow") === true;
    }

    function applyExperimentalAvailability() {
      const enabled = newsEnabled();
      button.hidden = !enabled;
      if (!enabled && !page.hidden) close({ focus: false });
    }

    function setStatus(message, kind = "") {
      status.textContent = text(message);
      status.className = "newsnow-status" + (kind ? " " + kind : "");
    }

    function applyLayout() {
      const grid = layout === "grid";
      feed.classList.toggle("newsnow-feed-grid", grid);
      listLayout.setAttribute("aria-pressed", String(!grid));
      gridLayout.setAttribute("aria-pressed", String(grid));
    }

    function setLayout(nextLayout) {
      layout = nextLayout === "grid" ? "grid" : "list";
      try { global.localStorage.setItem(LAYOUT_STORAGE_KEY, layout); } catch (_) { /* optional local preference */ }
      applyLayout();
    }

    function sourceForId(id) {
      return catalog.find((source) => text(source.id) === text(id));
    }

    function renderSourceSummary() {
      const names = sourceIds.map(sourceForId).filter(Boolean).map((source) => text(source.name));
      sourceSummary.textContent = names.length ? `已关注 ${names.length} 个来源` : "使用推荐来源";
    }

    function categoriesForSelection() {
      return [...new Set(sourceIds.map(sourceForId).filter(Boolean).map(sourceCategory))];
    }

    function renderCategories() {
      const list = ["全部", ...categoriesForSelection()];
      if (!list.includes(selectedCategory)) selectedCategory = "全部";
      categories.replaceChildren(...list.map((name) => {
        const tag = root.createElement("button");
        tag.type = "button";
        tag.className = "newsnow-category" + (name === selectedCategory ? " active" : "");
        tag.textContent = name;
        tag.addEventListener("click", () => {
          selectedCategory = name;
          renderCategories();
          renderFeed();
        });
        return tag;
      }));
    }

    function renderSourcePicker() {
      const byCategory = new Map();
      const query = sourceQuery.trim().toLocaleLowerCase();
      catalog.filter((source) => {
        if (!query) return true;
        return [source.id, source.name, source.category].some((value) => text(value).toLocaleLowerCase().includes(query));
      }).forEach((source) => {
        const category = sourceCategory(source);
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push(source);
      });
      const selected = new Set(pendingSourceIds);
      if (!byCategory.size) {
        const empty = root.createElement("p");
        empty.className = "newsnow-source-empty";
        empty.textContent = "没有找到匹配的内置来源。";
        sourceOptions.replaceChildren(empty);
        return;
      }
      sourceOptions.replaceChildren(...[...byCategory.entries()].map(([category, sources]) => {
        const group = root.createElement("section");
        group.className = "newsnow-source-group";
        const title = root.createElement("h2");
        title.textContent = category;
        group.appendChild(title);
        const choices = root.createElement("div");
        choices.className = "newsnow-source-choices";
        sources.forEach((source) => {
          const label = root.createElement("label");
          label.className = "newsnow-source-choice";
          const checkbox = root.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = selected.has(text(source.id));
          checkbox.addEventListener("change", () => {
            const id = text(source.id);
            if (checkbox.checked) {
              if (pendingSourceIds.length >= MAX_SOURCES) {
                checkbox.checked = false;
                setStatus(`最多选择 ${MAX_SOURCES} 个来源。`, "warning");
                return;
              }
              pendingSourceIds = [...pendingSourceIds, id];
            } else {
              pendingSourceIds = pendingSourceIds.filter((value) => value !== id);
            }
          });
          const swatch = root.createElement("i");
          swatch.style.background = safeHttpUrl(source.color) ? "" : text(source.color || "#718097");
          const name = root.createElement("span");
          name.textContent = text(source.name);
          label.append(checkbox, swatch, name);
          choices.appendChild(label);
        });
        group.appendChild(choices);
        return group;
      }));
    }

    function openSourcePicker() {
      pendingSourceIds = sourceIds.slice();
      sourceQuery = "";
      sourceSearch.value = "";
      renderSourcePicker();
      sourcePicker.hidden = false;
      sourceToggle.setAttribute("aria-expanded", "true");
      sourceSearch.focus({ preventScroll: true });
    }

    function closeSourcePicker({ focus = false } = {}) {
      sourcePicker.hidden = true;
      sourceToggle.setAttribute("aria-expanded", "false");
      if (focus) sourceToggle.focus({ preventScroll: true });
    }

    function setReaderVisible(visible) {
      reader.hidden = !visible;
      sourcePicker.hidden = true;
      sourceToggle.setAttribute("aria-expanded", "false");
      page.classList.toggle("newsnow-reading", visible);
    }

    function closeArticle({ focus = false, restoreScroll = true } = {}) {
      articleUrl = "";
      readerFrame.src = "about:blank";
      readerStatus.textContent = "";
      setReaderVisible(false);
      if (restoreScroll) global.requestAnimationFrame(() => { page.scrollTop = articleScrollTop; });
      if (focus) feed.querySelector(".newsnow-card")?.focus({ preventScroll: true });
    }

    function openWebPage(url, loadingMessage) {
      articleScrollTop = page.scrollTop;
      page.scrollTop = 0;
      articleUrl = url;
      readerStatus.textContent = loadingMessage;
      setReaderVisible(true);
      readerFrame.src = url;
    }

    function openArticle(item) {
      const url = safeHttpUrl(item.url || item.link || item.href);
      if (!url) return;
      openWebPage(url, "正在使用浏览器内核加载原网页…");
    }

    function openNewsHome() {
      openWebPage(NEWSNOW_HOME_URL, "正在打开资讯网页…");
    }

    function makeCard(item) {
      const article = root.createElement("article");
      article.className = "newsnow-card";
      const url = safeHttpUrl(item.url || item.link || item.href);
      article.tabIndex = url ? 0 : -1;
      const rail = root.createElement("div");
      rail.className = "newsnow-card-rail";
      rail.style.background = text(item.sourceColor || item.source_color || "#718097");
      const content = root.createElement("div");
      content.className = "newsnow-card-content";
      const meta = root.createElement("div");
      meta.className = "newsnow-meta";
      const source = root.createElement("span");
      source.className = "newsnow-source-name";
      source.textContent = text(item.source || item.source_name || item.site || "资讯").trim();
      meta.appendChild(source);
      const time = itemDate(item);
      if (time) {
        const timeEl = root.createElement("time");
        timeEl.textContent = time;
        meta.appendChild(timeEl);
      }
      const title = root.createElement("h2");
      title.textContent = text(item.title || item.name || "未命名新闻");
      content.append(meta, title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim();
      if (description) {
        const summary = root.createElement("p");
        summary.className = "newsnow-summary";
        summary.textContent = description;
        content.appendChild(summary);
      }
      if (url) {
        const open = root.createElement("span");
        open.className = "newsnow-open-hint";
        open.textContent = "阅读原文 →";
        content.appendChild(open);
        article.addEventListener("click", () => openArticle(item));
        article.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openArticle(item);
          }
        });
      }
      article.append(rail, content);
      return article;
    }

    function renderFeed() {
      const filtered = selectedCategory === "全部" ? allItems : allItems.filter((item) => sourceCategory(item) === selectedCategory);
      if (!filtered.length) {
        const empty = root.createElement("div");
        empty.className = "newsnow-empty";
        empty.textContent = allItems.length ? "这个分类暂时没有资讯。" : "暂无资讯。请刷新，或在“添加来源”中调整关注内容。";
        feed.replaceChildren(empty);
        return;
      }
      feed.replaceChildren(...filtered.map(makeCard));
    }

    async function loadSources() {
      if (catalog.length) return catalog;
      if (catalogueLoading) return catalogueLoading;
      catalogueLoading = Promise.resolve(invoke && invoke("newsnow_sources"))
        .then((sources) => Array.isArray(sources) ? sources : [])
        .then((sources) => {
          catalog = sources;
          sourceIds = loadStoredSourceIds(catalog);
          renderSourceSummary();
          renderCategories();
          return catalog;
        })
        .catch(() => {
          catalog = [];
          sourceIds = [];
          renderSourceSummary();
          return catalog;
        })
        .finally(() => { catalogueLoading = null; });
      return catalogueLoading;
    }

    async function load(force = false) {
      if (loading || !invoke) return;
      loading = true;
      refresh.disabled = true;
      refresh.textContent = force ? "刷新中…" : "加载中…";
      setStatus(force ? "正在更新资讯流…" : "正在载入资讯流…", "muted");
      try {
        await loadSources();
        const command = force ? "newsnow_refresh" : "newsnow_list";
        const request = { sourceIds };
        const result = await withTimeout(invoke(command, { request }));
        allItems = resultItems(result);
        renderCategories();
        renderFeed();
        const stamp = result && (result.fetched_at || result.fetchedAt || result.updated_at || result.updatedAt);
        updated.textContent = stamp ? "更新于 " + itemDate({ published_at: stamp }) : "";
        const message = text(result && result.message).trim();
        const stale = Boolean(result && result.stale);
        setStatus(message || (allItems.length ? `已加载 ${allItems.length} 条资讯。` : "没有获取到资讯。"), stale ? "warning" : (message && !allItems.length ? "error" : "muted"));
      } catch (error) {
        renderFeed();
        setStatus(error && error.message === "资讯请求超时"
          ? "资讯请求超时，正在保留当前内容。"
          : "资讯加载失败，请检查网络后重试。", "error");
      } finally {
        loading = false;
        refresh.disabled = false;
        refresh.textContent = "刷新";
      }
    }

    async function open() {
      if (!newsEnabled() || !invoke) return;
      root.getElementById("menu")?.classList.remove("show");
      root.getElementById("filter-panel")?.classList.remove("show");
      root.getElementById("account-panel")?.classList.remove("show");
      if (!root.getElementById("library-ai-page")?.hidden) global.ReaderLibraryAiEntry?.close();
      button.disabled = true;
      try {
        await invoke("newsnow_open_browser");
      } catch (error) {
        global.alert("无法打开资讯网页，请检查网络后重试。");
      } finally {
        button.disabled = false;
      }
    }

    function close({ focus = true } = {}) {
      closeSourcePicker();
      closeArticle({ restoreScroll: false });
      page.hidden = true;
      shell.hidden = false;
      global.document.body.classList.remove("newsnow-active");
      button.setAttribute("aria-pressed", "false");
      if (focus && !button.hidden) button.focus({ preventScroll: true });
    }

    button.addEventListener("click", () => { void open(); });
    back.addEventListener("click", close);
    readerBack.addEventListener("click", () => close({ focus: true }));
    readerFrame.addEventListener("load", () => {
      if (articleUrl) readerStatus.textContent = "资讯网页已加载。";
    });
    readerFrame.addEventListener("error", () => {
      if (articleUrl) readerStatus.textContent = "资讯网页加载失败，请稍后重试。";
    });
    refresh.addEventListener("click", () => load(true));
    listLayout.addEventListener("click", () => setLayout("list"));
    gridLayout.addEventListener("click", () => setLayout("grid"));
    sourceToggle.addEventListener("click", () => {
      if (sourcePicker.hidden) {
        loadSources().then(openSourcePicker);
      } else {
        closeSourcePicker({ focus: true });
      }
    });
    sourceClose.addEventListener("click", () => closeSourcePicker({ focus: true }));
    sourceSearch.addEventListener("input", () => {
      sourceQuery = sourceSearch.value;
      renderSourcePicker();
    });
    sourceReset.addEventListener("click", () => { pendingSourceIds = defaultSourceIds(catalog); renderSourcePicker(); });
    sourceApply.addEventListener("click", () => {
      const selected = allowedSourceIds(pendingSourceIds, catalog);
      if (!selected.length) {
        setStatus("至少选择一个来源，或使用“恢复推荐”。", "warning");
        return;
      }
      sourceIds = selected;
      saveSourceIds(sourceIds);
      selectedCategory = "全部";
      renderSourceSummary();
      renderCategories();
      closeSourcePicker({ focus: true });
      load(true);
    });
    global.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || page.hidden) return;
      if (!reader.hidden) close({ focus: true }); else if (!sourcePicker.hidden) closeSourcePicker({ focus: true }); else close();
    });
    global.addEventListener("reader-experimental-features-changed", (event) => {
      if (event.detail?.key === "newsnow") applyExperimentalAvailability();
    });
    applyExperimentalAvailability();
    applyLayout();
    return {
      open, close, toggle, refresh: () => load(true),
      render: (items) => { allItems = resultItems(items); renderCategories(); renderFeed(); },
      sources: () => catalog.slice(),
      layout: () => layout,
    };
  }

  global.ReaderNewsUI = { init, resultItems, safeHttpUrl, withTimeout, allowedSourceIds };
  if (global.document) global.ReaderNewsUI.instance = init();
})(window);
