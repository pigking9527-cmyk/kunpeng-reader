/* A browser-rendered, reader-owned news page.  Network access is kept in Rust:
   the WebView only receives source IDs and sanitized article HTML. */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 18000;
  const SOURCE_STORAGE_KEY = "kunpeng.reader.news.sources.v2";
  const LAYOUT_STORAGE_KEY = "kunpeng.reader.news.layout.v1";
  const ORDER_STORAGE_KEY = "kunpeng.reader.news.order.v1";
  const MAX_SOURCES = 12;

  const text = (value) => String(value == null ? "" : value);
  function safeHttpUrl(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" ? url.href : "";
    } catch (_) { return ""; }
  }
  function resultItems(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.items)) return result.items;
    if (Array.isArray(result?.data)) return result.data;
    if (Array.isArray(result?.news)) return result.news;
    return [];
  }
  function withTimeout(promise, timeoutMs = LOAD_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = global.setTimeout(() => reject(new Error("资讯请求超时")), timeoutMs); });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => global.clearTimeout(timer));
  }
  function itemDate(item) {
    const value = item.published_at || item.publishedAt || item.published || item.time || item.created_at || item.createdAt;
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const sourceCategory = (source) => text(source?.category).trim() || "其他";
  const sourceId = (item) => text(item?.sourceId || item?.source_id || item?.source || "资讯");
  const sourceName = (item) => text(item?.source || item?.source_name || item?.site || "资讯").trim();
  const defaultSourceIds = (catalog) => catalog.filter((source) => source.defaultEnabled || source.default_enabled).map((source) => text(source.id));
  function allowedSourceIds(ids, catalog) {
    const allowed = new Set(catalog.map((source) => text(source.id)));
    const seen = new Set();
    return (Array.isArray(ids) ? ids : []).map(text).filter((id) => allowed.has(id) && !seen.has(id) && (seen.add(id), true)).slice(0, MAX_SOURCES);
  }
  function readJson(key) { try { return JSON.parse(global.localStorage.getItem(key)); } catch (_) { return null; } }
  function loadStoredSourceIds(catalog) {
    const selected = allowedSourceIds(readJson(SOURCE_STORAGE_KEY), catalog);
    return selected.length ? selected : defaultSourceIds(catalog);
  }
  function storageGet(key, fallback) { try { return global.localStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
  function storageSet(key, value) { try { global.localStorage.setItem(key, value); } catch (_) { /* preferences are optional */ } }

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
    const mixedOrder = root.getElementById("newsnow-order-mixed");
    const sourceOrder = root.getElementById("newsnow-order-source");
    const status = root.getElementById("newsnow-status");
    const feed = root.getElementById("newsnow-feed");
    const reader = root.getElementById("newsnow-reader");
    const readerBack = root.getElementById("newsnow-reader-back");
    const readerStatus = root.getElementById("newsnow-reader-status");
    const articleTitle = root.getElementById("newsnow-article-title");
    const articleMeta = root.getElementById("newsnow-article-meta");
    const articleBody = root.getElementById("newsnow-article-body");
    const articleOriginal = root.getElementById("newsnow-article-original");
    const categories = root.getElementById("newsnow-categories");
    const updated = root.getElementById("newsnow-updated");
    const shell = root.querySelector(".content-shell");
    if (!button || !page || !back || !refresh || !sourceToggle || !sourcePicker || !sourceSearch || !sourceOptions || !sourceClose || !sourceApply || !sourceReset || !sourceSummary || !listLayout || !gridLayout || !mixedOrder || !sourceOrder || !status || !feed || !reader || !readerBack || !readerStatus || !articleTitle || !articleMeta || !articleBody || !articleOriginal || !categories || !updated || !shell) return null;

    let catalog = [], sourceIds = [], pendingSourceIds = [], allItems = [];
    let selectedCategory = "全部", loading = false, catalogueLoading = null, sourceQuery = "";
    let layout = storageGet(LAYOUT_STORAGE_KEY, "list") === "grid" ? "grid" : "list";
    let order = storageGet(ORDER_STORAGE_KEY, "mixed") === "source" ? "source" : "mixed";
    let articleScrollTop = 0;

    const newsEnabled = () => global.ReaderExperimentalFeatures?.enabled?.("newsnow") === true;
    function applyExperimentalAvailability() {
      const enabled = newsEnabled();
      button.hidden = !enabled;
      if (!enabled && !page.hidden) close({ focus: false });
    }
    function setStatus(message, kind = "") { status.textContent = text(message); status.className = "newsnow-status" + (kind ? " " + kind : ""); }
    function sourceForId(id) { return catalog.find((source) => text(source.id) === text(id)); }
    function renderSourceSummary() { sourceSummary.textContent = sourceIds.length ? `显示 ${sourceIds.length} 个来源` : "使用推荐来源"; }
    function categoriesForSelection() { return [...new Set(sourceIds.map(sourceForId).filter(Boolean).map(sourceCategory))]; }
    function applyDisplayOptions() {
      const grid = layout === "grid";
      feed.classList.toggle("newsnow-feed-grid", grid);
      feed.classList.toggle("newsnow-feed-by-source", order === "source");
      listLayout.setAttribute("aria-pressed", String(!grid));
      gridLayout.setAttribute("aria-pressed", String(grid));
      mixedOrder.setAttribute("aria-pressed", String(order === "mixed"));
      sourceOrder.setAttribute("aria-pressed", String(order === "source"));
    }
    function setLayout(next) { layout = next === "grid" ? "grid" : "list"; storageSet(LAYOUT_STORAGE_KEY, layout); applyDisplayOptions(); renderFeed(); }
    function setOrder(next) { order = next === "source" ? "source" : "mixed"; storageSet(ORDER_STORAGE_KEY, order); applyDisplayOptions(); renderFeed(); }
    function renderCategories() {
      const list = ["全部", ...categoriesForSelection()];
      if (!list.includes(selectedCategory)) selectedCategory = "全部";
      categories.replaceChildren(...list.map((name) => {
        const tag = root.createElement("button");
        tag.type = "button"; tag.className = "newsnow-category" + (name === selectedCategory ? " active" : ""); tag.textContent = name;
        tag.addEventListener("click", () => { selectedCategory = name; renderCategories(); renderFeed(); });
        return tag;
      }));
    }
    function renderSourcePicker() {
      const groups = new Map(), query = sourceQuery.trim().toLocaleLowerCase(), selected = new Set(pendingSourceIds);
      catalog.filter((source) => !query || [source.id, source.name, source.category].some((value) => text(value).toLocaleLowerCase().includes(query))).forEach((source) => {
        const category = sourceCategory(source); if (!groups.has(category)) groups.set(category, []); groups.get(category).push(source);
      });
      if (!groups.size) { const empty = root.createElement("p"); empty.className = "newsnow-source-empty"; empty.textContent = "没有找到匹配的内置来源。"; sourceOptions.replaceChildren(empty); return; }
      sourceOptions.replaceChildren(...[...groups.entries()].map(([category, sources]) => {
        const group = root.createElement("section"), title = root.createElement("h2"), choices = root.createElement("div");
        group.className = "newsnow-source-group"; title.textContent = category; choices.className = "newsnow-source-choices";
        sources.forEach((source) => {
          const label = root.createElement("label"), checkbox = root.createElement("input"), swatch = root.createElement("i"), name = root.createElement("span"), id = text(source.id);
          label.className = "newsnow-source-choice"; checkbox.type = "checkbox"; checkbox.checked = selected.has(id); swatch.style.background = text(source.color || "#718097"); name.textContent = text(source.name);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) { if (pendingSourceIds.length >= MAX_SOURCES) { checkbox.checked = false; setStatus(`最多选择 ${MAX_SOURCES} 个来源。`, "warning"); return; } pendingSourceIds = [...pendingSourceIds, id]; }
            else pendingSourceIds = pendingSourceIds.filter((value) => value !== id);
          });
          label.append(checkbox, swatch, name); choices.appendChild(label);
        });
        group.append(title, choices); return group;
      }));
    }
    function openSourcePicker() { pendingSourceIds = sourceIds.slice(); sourceQuery = ""; sourceSearch.value = ""; renderSourcePicker(); sourcePicker.hidden = false; sourceToggle.setAttribute("aria-expanded", "true"); sourceSearch.focus({ preventScroll: true }); }
    function closeSourcePicker({ focus = false } = {}) { sourcePicker.hidden = true; sourceToggle.setAttribute("aria-expanded", "false"); if (focus) sourceToggle.focus({ preventScroll: true }); }
    function setReaderVisible(visible) { reader.hidden = !visible; sourcePicker.hidden = true; sourceToggle.setAttribute("aria-expanded", "false"); page.classList.toggle("newsnow-reading", visible); }
    function clearArticle() { readerStatus.textContent = ""; articleTitle.textContent = ""; articleMeta.textContent = ""; articleBody.replaceChildren(); articleOriginal.removeAttribute("href"); articleOriginal.hidden = true; }
    function closeArticle({ focus = false, restoreScroll = true } = {}) { clearArticle(); setReaderVisible(false); if (restoreScroll) global.requestAnimationFrame(() => { page.scrollTop = articleScrollTop; }); if (focus) feed.querySelector(".newsnow-card")?.focus({ preventScroll: true }); }
    function articleRequest(item) { return { url: safeHttpUrl(item.url || item.link || item.href), title: text(item.title || item.name), source: sourceName(item), publishedAt: text(item.published_at || item.publishedAt || item.published || item.time) }; }
    async function openArticle(item) {
      const request = articleRequest(item); if (!request.url) return;
      articleScrollTop = page.scrollTop; page.scrollTop = 0; clearArticle(); setReaderVisible(true);
      readerStatus.textContent = "正在提取原文…"; articleTitle.textContent = request.title; articleMeta.textContent = [request.source, itemDate(item)].filter(Boolean).join(" · "); articleOriginal.href = request.url; articleOriginal.hidden = false;
      try {
        const article = await withTimeout(invoke("newsnow_read_article", { request }));
        articleTitle.textContent = text(article.title || request.title); articleMeta.textContent = [text(article.source || request.source), itemDate(article)].filter(Boolean).join(" · "); articleOriginal.href = safeHttpUrl(article.url) || request.url;
        // contentHtml is parsed and sanitized by the Rust command before it reaches this WebView.
        articleBody.innerHTML = text(article.contentHtml || article.content_html);
        readerStatus.textContent = "";
      } catch (error) {
        const fallback = root.createElement("p"); fallback.className = "newsnow-article-error"; fallback.textContent = text(error) || "原文提取失败，可打开原网页阅读。"; articleBody.replaceChildren(fallback); readerStatus.textContent = "";
      }
    }
    function makeCard(item) {
      const article = root.createElement("article"), url = safeHttpUrl(item.url || item.link || item.href), rail = root.createElement("div"), content = root.createElement("div"), meta = root.createElement("div"), source = root.createElement("span"), title = root.createElement("h2");
      article.className = "newsnow-card"; article.tabIndex = url ? 0 : -1; rail.className = "newsnow-card-rail"; rail.style.background = text(item.sourceColor || item.source_color || "#718097"); content.className = "newsnow-card-content"; meta.className = "newsnow-meta"; source.className = "newsnow-source-name"; source.textContent = sourceName(item); title.textContent = text(item.title || item.name || "未命名新闻"); meta.appendChild(source);
      const time = itemDate(item); if (time) { const timeEl = root.createElement("time"); timeEl.textContent = time; meta.appendChild(timeEl); }
      content.append(meta, title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim(); if (description) { const summary = root.createElement("p"); summary.className = "newsnow-summary"; summary.textContent = description; content.appendChild(summary); }
      if (url) { const open = root.createElement("span"); open.className = "newsnow-open-hint"; open.textContent = "阅读正文 →"; content.appendChild(open); article.addEventListener("click", () => void openArticle(item)); article.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openArticle(item); } }); }
      article.append(rail, content); return article;
    }
    function filteredItems() { return selectedCategory === "全部" ? allItems : allItems.filter((item) => sourceCategory(sourceForId(sourceId(item))) === selectedCategory); }
    function renderFeed() {
      const items = filteredItems(); applyDisplayOptions();
      if (!items.length) { const empty = root.createElement("div"); empty.className = "newsnow-empty"; empty.textContent = allItems.length ? "这个分类暂时没有资讯。" : "暂无资讯。请刷新，或在“添加来源”中调整显示内容。"; feed.replaceChildren(empty); return; }
      if (order === "mixed") { feed.replaceChildren(...items.map(makeCard)); return; }
      const groups = new Map(); items.forEach((item) => { const id = sourceId(item); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(item); });
      const orderedIds = [...sourceIds, ...groups.keys()].filter((id, index, list) => groups.has(id) && list.indexOf(id) === index);
      feed.replaceChildren(...orderedIds.map((id) => { const section = root.createElement("section"), heading = root.createElement("h2"), cards = root.createElement("div"), source = sourceForId(id); section.className = "newsnow-source-section"; heading.textContent = text(source?.name || groups.get(id)[0] && sourceName(groups.get(id)[0]) || "资讯"); cards.className = "newsnow-source-cards"; cards.replaceChildren(...groups.get(id).map(makeCard)); section.append(heading, cards); return section; }));
    }
    async function loadSources() {
      if (catalog.length) return catalog; if (catalogueLoading) return catalogueLoading;
      catalogueLoading = Promise.resolve(invoke && invoke("newsnow_sources")).then((sources) => Array.isArray(sources) ? sources : []).then((sources) => { catalog = sources; sourceIds = loadStoredSourceIds(catalog); renderSourceSummary(); renderCategories(); return catalog; }).catch(() => { catalog = []; sourceIds = []; renderSourceSummary(); return catalog; }).finally(() => { catalogueLoading = null; });
      return catalogueLoading;
    }
    async function load(force = false) {
      if (loading || !invoke) return; loading = true; refresh.disabled = true; refresh.textContent = force ? "刷新中…" : "加载中…"; setStatus(force ? "正在更新资讯流…" : "正在载入资讯流…", "muted");
      try { await loadSources(); const result = await withTimeout(invoke(force ? "newsnow_refresh" : "newsnow_list", { request: { sourceIds } })); allItems = resultItems(result); renderCategories(); renderFeed(); const stamp = result?.fetched_at || result?.fetchedAt; updated.textContent = stamp ? "更新于 " + itemDate({ published_at: stamp }) : ""; const message = text(result?.message).trim(); setStatus(message || (allItems.length ? `已加载 ${allItems.length} 条资讯。` : "没有获取到资讯。"), result?.stale ? "warning" : (message && !allItems.length ? "error" : "muted")); }
      catch (error) { renderFeed(); setStatus(error?.message === "资讯请求超时" ? "资讯请求超时，正在保留当前内容。" : "资讯加载失败，请检查网络后重试。", "error"); }
      finally { loading = false; refresh.disabled = false; refresh.textContent = "刷新"; }
    }
    async function open() {
      if (!newsEnabled() || !invoke) return; root.getElementById("menu")?.classList.remove("show"); root.getElementById("filter-panel")?.classList.remove("show"); root.getElementById("account-panel")?.classList.remove("show"); if (!root.getElementById("library-ai-page")?.hidden) global.ReaderLibraryAiEntry?.close();
      page.hidden = false; shell.hidden = true; global.document.body.classList.add("newsnow-active"); button.setAttribute("aria-pressed", "true"); await load(false);
    }
    function close({ focus = true } = {}) { closeSourcePicker(); closeArticle({ restoreScroll: false }); page.hidden = true; shell.hidden = false; global.document.body.classList.remove("newsnow-active"); button.setAttribute("aria-pressed", "false"); if (focus && !button.hidden) button.focus({ preventScroll: true }); }
    button.addEventListener("click", () => { void open(); }); back.addEventListener("click", () => close()); readerBack.addEventListener("click", () => closeArticle({ focus: true })); refresh.addEventListener("click", () => void load(true)); listLayout.addEventListener("click", () => setLayout("list")); gridLayout.addEventListener("click", () => setLayout("grid")); mixedOrder.addEventListener("click", () => setOrder("mixed")); sourceOrder.addEventListener("click", () => setOrder("source"));
    sourceToggle.addEventListener("click", () => { if (sourcePicker.hidden) void loadSources().then(openSourcePicker); else closeSourcePicker({ focus: true }); }); sourceClose.addEventListener("click", () => closeSourcePicker({ focus: true })); sourceSearch.addEventListener("input", () => { sourceQuery = sourceSearch.value; renderSourcePicker(); }); sourceReset.addEventListener("click", () => { pendingSourceIds = defaultSourceIds(catalog); renderSourcePicker(); });
    sourceApply.addEventListener("click", () => { const selected = allowedSourceIds(pendingSourceIds, catalog); if (!selected.length) { setStatus("至少选择一个来源，或使用“恢复推荐”。", "warning"); return; } sourceIds = selected; storageSet(SOURCE_STORAGE_KEY, JSON.stringify(sourceIds)); selectedCategory = "全部"; renderSourceSummary(); renderCategories(); closeSourcePicker({ focus: true }); void load(true); });
    global.addEventListener("keydown", (event) => { if (event.key !== "Escape" || page.hidden) return; if (!reader.hidden) closeArticle({ focus: true }); else if (!sourcePicker.hidden) closeSourcePicker({ focus: true }); else close(); });
    global.addEventListener("reader-experimental-features-changed", (event) => { if (event.detail?.key === "newsnow") applyExperimentalAvailability(); }); applyExperimentalAvailability(); applyDisplayOptions();
    return { open, close, refresh: () => load(true), render: (items) => { allItems = resultItems(items); renderCategories(); renderFeed(); }, sources: () => catalog.slice(), layout: () => layout, order: () => order };
  }
  global.ReaderNewsUI = { init, resultItems, safeHttpUrl, withTimeout, allowedSourceIds };
  if (global.document) global.ReaderNewsUI.instance = init();
})(window);
