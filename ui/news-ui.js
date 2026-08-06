/* A browser-rendered, reader-owned news page. The Rust side fetches the feed;
   a selected source article opens in a main-window child WebView. */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 18000;
  const SOURCE_STORAGE_KEY = "kunpeng.reader.news.sources.v2";
  const TIEBA_BARS_STORAGE_KEY = "kunpeng.reader.news.tieba-bars.v1";
  const LAYOUT_STORAGE_KEY = "kunpeng.reader.news.layout.v1";
  const ORDER_STORAGE_KEY = "kunpeng.reader.news.order.v1";
  const MAX_SOURCES = 24;
  const MAX_TIEBA_BARS = 8;
  const BACKGROUND_PREFETCH_DELAY_MS = 30 * 1000;
  const BACKGROUND_PREFETCH_INTERVAL_MS = 5 * 60 * 1000;

  const text = (value) => String(value == null ? "" : value);
  const i18n = (key, fallback) => global.ReaderAppI18n?.t?.(key) || fallback;
  const format = (key, fallback, values) => i18n(key, fallback).replace(/\{(\w+)\}/g, (_, name) => values?.[name] ?? "");
  function safeHttpUrl(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" ? url.href : "";
    } catch (_) { return ""; }
  }
  function safeImageDataUrl(value) {
    const image = text(value).trim();
    return /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/i.test(image) ? image : "";
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
  function normalizeTiebaBars(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map((value) => text(value).trim().replace(/吧$/, "").trim()).filter((name) => name && name.length <= 48 && !/[\u0000-\u001f\u007f]/.test(name) && !seen.has(name) && (seen.add(name), true)).slice(0, MAX_TIEBA_BARS);
  }
  function loadStoredTiebaBars() { return normalizeTiebaBars(readJson(TIEBA_BARS_STORAGE_KEY)); }
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
    const tiebaBars = root.getElementById("newsnow-tieba-bars");
    const tiebaBarForm = root.getElementById("newsnow-tieba-bar-form");
    const tiebaBarInput = root.getElementById("newsnow-tieba-bar-input");
    const tiebaBarList = root.getElementById("newsnow-tieba-bar-list");
    const tiebaBarCount = root.getElementById("newsnow-tieba-bar-count");
    const sourceSelection = root.getElementById("newsnow-source-selection");
    const sourceSummary = root.getElementById("newsnow-source-summary");
    const listLayout = root.getElementById("newsnow-layout-list");
    const gridLayout = root.getElementById("newsnow-layout-grid");
    const mixedOrder = root.getElementById("newsnow-order-mixed");
    const sourceOrder = root.getElementById("newsnow-order-source");
    const status = root.getElementById("newsnow-status");
    const feed = root.getElementById("newsnow-feed");
    const reader = root.getElementById("newsnow-reader");
    const readerStatus = root.getElementById("newsnow-reader-status");
    const categories = root.getElementById("newsnow-categories");
    const updated = root.getElementById("newsnow-updated");
    const shell = root.querySelector(".content-shell");
    if (!button || !page || !back || !refresh || !sourceToggle || !sourcePicker || !sourceSearch || !sourceOptions || !sourceClose || !sourceApply || !sourceReset || !tiebaBars || !tiebaBarForm || !tiebaBarInput || !tiebaBarList || !tiebaBarCount || !sourceSelection || !sourceSummary || !listLayout || !gridLayout || !mixedOrder || !sourceOrder || !status || !feed || !reader || !readerStatus || !categories || !updated || !shell) return null;

    let catalog = [], sourceIds = [], pendingSourceIds = [], tiebaBarNames = loadStoredTiebaBars(), pendingTiebaBarNames = [], allItems = [];
    let selectedCategory = "全部", loading = false, catalogueLoading = null, sourceQuery = "";
    let layout = storageGet(LAYOUT_STORAGE_KEY, "list") === "grid" ? "grid" : "list";
    let order = storageGet(ORDER_STORAGE_KEY, "mixed") === "source" ? "source" : "mixed";
    let articleScrollTop = 0, articleOpen = false, masonryResizeTimer = 0;
    let backgroundRefreshRunning = false, prefetchDelayTimer = 0, prefetchIntervalTimer = 0, lastUserActivityAt = Date.now();
    const previewImageCache = new Map(), previewImageWaiters = new Map(), previewImageQueue = [];
    let previewImageActive = 0;

    const newsEnabled = () => global.ReaderExperimentalFeatures?.enabled?.("newsnow") === true;
    const backgroundPrefetchEnabled = () => global.ReaderExperimentalFeatures?.enabled?.("newsnowPrefetch") === true;
    function applyExperimentalAvailability() {
      const enabled = newsEnabled();
      button.hidden = !enabled;
      if (!enabled && (!page.hidden || !reader.hidden)) close({ focus: false });
    }
    function setStatus(message, kind = "") { status.textContent = text(message); status.className = "newsnow-status" + (kind ? " " + kind : ""); }
    function sourceForId(id) { return catalog.find((source) => text(source.id) === text(id)); }
    function renderSourceSummary() { const tiebaCount = sourceIds.includes("tieba") ? tiebaBarNames.length : 0; sourceSummary.textContent = sourceIds.length ? format("newsSourceSummary", "显示 {count} 个来源", { count: sourceIds.length }) + (tiebaCount ? ` · ${tiebaCount} 个贴吧` : "") : i18n("newsRecommendedSources", "使用推荐来源"); }
    function renderSourceSelection() { sourceSelection.textContent = format("newsSelectedSources", "已选 {count} / {max}", { count: pendingSourceIds.length, max: MAX_SOURCES }); }
    function renderTiebaBars() {
      tiebaBarCount.textContent = `已添加 ${pendingTiebaBarNames.length} / ${MAX_TIEBA_BARS} 个吧`;
      if (!pendingTiebaBarNames.length) { const empty = root.createElement("p"); empty.className = "newsnow-tieba-bar-empty"; empty.textContent = "还没有添加吧名。"; tiebaBarList.replaceChildren(empty); return; }
      tiebaBarList.replaceChildren(...pendingTiebaBarNames.map((bar) => { const chip = root.createElement("span"), name = root.createElement("span"), remove = root.createElement("button"); chip.className = "newsnow-tieba-bar-chip"; name.textContent = `${bar}吧`; remove.type = "button"; remove.title = `删除 ${bar}吧`; remove.setAttribute("aria-label", remove.title); remove.textContent = "×"; remove.addEventListener("click", () => { pendingTiebaBarNames = pendingTiebaBarNames.filter((name) => name !== bar); renderTiebaBars(); }); chip.append(name, remove); return chip; }));
    }
    function newsRequest() { return { sourceIds, tiebaBars: sourceIds.includes("tieba") ? tiebaBarNames : [] }; }
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
      const all = "全部", list = [all, ...categoriesForSelection()];
      if (!list.includes(selectedCategory)) selectedCategory = all;
      categories.replaceChildren(...list.map((name) => {
        const tag = root.createElement("button");
        tag.type = "button"; tag.className = "newsnow-category" + (name === selectedCategory ? " active" : ""); tag.textContent = name === all ? i18n("newsCategoryAll", "全部") : name;
        tag.addEventListener("click", () => { selectedCategory = name; renderCategories(); renderFeed(); });
        return tag;
      }));
    }
    function renderSourcePicker() {
      const groups = new Map(), query = sourceQuery.trim().toLocaleLowerCase(), selected = new Set(pendingSourceIds);
      renderSourceSelection();
      catalog.filter((source) => !query || [source.id, source.name, source.category].some((value) => text(value).toLocaleLowerCase().includes(query))).forEach((source) => {
        const category = sourceCategory(source); if (!groups.has(category)) groups.set(category, []); groups.get(category).push(source);
      });
      renderTiebaBars();
      if (!groups.size) { const empty = root.createElement("p"); empty.className = "newsnow-source-empty"; empty.textContent = i18n("noMatchingSources", "没有找到匹配的内置来源。"); sourceOptions.replaceChildren(empty); return; }
      sourceOptions.replaceChildren(...[...groups.entries()].map(([category, sources]) => {
        const group = root.createElement("section"), title = root.createElement("h2"), choices = root.createElement("div");
        group.className = "newsnow-source-group"; title.textContent = category; choices.className = "newsnow-source-choices";
        sources.forEach((source) => {
          const label = root.createElement("label"), checkbox = root.createElement("input"), swatch = root.createElement("i"), name = root.createElement("span"), id = text(source.id);
          checkbox.type = "checkbox"; checkbox.checked = selected.has(id); label.className = "newsnow-source-choice" + (checkbox.checked ? " selected" : ""); swatch.style.background = text(source.color || "#718097"); name.textContent = text(source.name);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) { if (pendingSourceIds.length >= MAX_SOURCES) { checkbox.checked = false; setStatus(format("maxSources", "最多选择 {max} 个来源。", { max: MAX_SOURCES }), "warning"); return; } pendingSourceIds = [...pendingSourceIds, id]; }
            else pendingSourceIds = pendingSourceIds.filter((value) => value !== id);
            label.classList.toggle("selected", checkbox.checked); renderSourceSelection();
          });
          label.append(checkbox, swatch, name); choices.appendChild(label);
        });
        group.append(title, choices); return group;
      }));
    }
    function openSourcePicker() { pendingSourceIds = sourceIds.slice(); pendingTiebaBarNames = tiebaBarNames.slice(); sourceQuery = ""; sourceSearch.value = ""; renderSourcePicker(); sourcePicker.hidden = false; sourceToggle.setAttribute("aria-expanded", "true"); sourceSearch.focus({ preventScroll: true }); }
    function closeSourcePicker({ focus = false } = {}) { sourcePicker.hidden = true; sourceToggle.setAttribute("aria-expanded", "false"); if (focus) sourceToggle.focus({ preventScroll: true }); }
    function setReaderVisible(visible) { reader.hidden = !visible; page.hidden = visible; sourcePicker.hidden = true; sourceToggle.setAttribute("aria-expanded", "false"); }
    function closeArticle({ focus = false, restoreScroll = true } = {}) { if (articleOpen && invoke) void Promise.resolve(invoke("newsnow_close_article")).catch(() => {}); articleOpen = false; readerStatus.textContent = ""; setReaderVisible(false); if (restoreScroll) global.requestAnimationFrame(() => { page.scrollTop = articleScrollTop; }); if (focus) feed.querySelector(".newsnow-card")?.focus({ preventScroll: true }); }
    async function openArticle(item) {
      const url = safeHttpUrl(item.url || item.link || item.href); if (!url) return;
      articleScrollTop = page.scrollTop; page.scrollTop = 0; articleOpen = true; readerStatus.textContent = i18n("loadingNews", "加载中…"); setReaderVisible(true);
      try { await invoke("newsnow_open_article", { request: { url } }); }
      catch (_) { articleOpen = false; setReaderVisible(false); setStatus("网页无法在阅读器中打开，请稍后重试。", "error"); }
    }
    function applyCardImage(image, card, url) {
      if (!url) return;
      image.src = url; image.hidden = false; card.classList.add("has-image");
    }
    function drainPreviewImageQueue() {
      while (previewImageActive < 3 && previewImageQueue.length) {
        const request = previewImageQueue.shift(); previewImageActive += 1;
        Promise.resolve(invoke("newsnow_preview_image", { request: { url: request.pageUrl, imageUrl: request.imageUrl, sourceId: request.sourceId, itemId: request.itemId } }))
          .then((result) => safeImageDataUrl(result?.imageDataUrl || result?.image_data_url))
          .catch(() => "")
          .then((dataUrl) => {
            previewImageCache.set(request.key, dataUrl);
            (previewImageWaiters.get(request.key) || []).forEach(({ image, card }) => applyCardImage(image, card, dataUrl));
          })
          .finally(() => { previewImageWaiters.delete(request.key); previewImageActive -= 1; drainPreviewImageQueue(); });
      }
    }
    function requestPreviewImage(pageUrl, imageUrl, sourceId, itemId, image, card) {
      const key = pageUrl + "\n" + imageUrl + "\n" + sourceId + "\n" + itemId;
      if (previewImageCache.has(key)) { applyCardImage(image, card, previewImageCache.get(key)); return; }
      const waiters = previewImageWaiters.get(key);
      if (waiters) { waiters.push({ image, card }); return; }
      previewImageWaiters.set(key, [{ image, card }]); previewImageQueue.push({ key, pageUrl, imageUrl, sourceId, itemId }); drainPreviewImageQueue();
    }
    const previewImageObserver = typeof global.IntersectionObserver === "function"
      ? new global.IntersectionObserver((entries) => entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        previewImageObserver.unobserve(entry.target);
        const preview = entry.target.__newsPreview;
        if (preview) requestPreviewImage(preview.pageUrl, preview.imageUrl, preview.sourceId, preview.itemId, preview.image, entry.target);
      }), { root: page, rootMargin: "420px 0px" })
      : null;
    function schedulePreviewImage(pageUrl, imageUrl, sourceId, itemId, image, card) {
      if (previewImageObserver) { card.__newsPreview = { pageUrl, imageUrl, sourceId, itemId, image }; previewImageObserver.observe(card); }
      else requestPreviewImage(pageUrl, imageUrl, sourceId, itemId, image, card);
    }
    function makeCard(item) {
      const article = root.createElement("article"), url = safeHttpUrl(item.url || item.link || item.href), rail = root.createElement("div"), content = root.createElement("div"), meta = root.createElement("div"), source = root.createElement("span"), title = root.createElement("h2");
      article.className = "newsnow-card"; article.tabIndex = url ? 0 : -1; rail.className = "newsnow-card-rail"; rail.style.background = text(item.sourceColor || item.source_color || "#718097"); content.className = "newsnow-card-content"; meta.className = "newsnow-meta"; source.className = "newsnow-source-name"; source.textContent = sourceName(item); title.textContent = text(item.title || item.name || "未命名新闻"); meta.appendChild(source);
      const time = itemDate(item); if (time) { const timeEl = root.createElement("time"); timeEl.textContent = time; meta.appendChild(timeEl); }
      const imageUrl = safeHttpUrl(item.imageUrl || item.image_url || item.cover || item.thumbnail);
      const image = root.createElement("img"); image.className = "newsnow-card-image"; image.alt = ""; image.loading = "lazy"; image.hidden = true;
      image.addEventListener("error", () => { image.hidden = true; article.classList.remove("has-image"); }); content.appendChild(image);
      if (url) schedulePreviewImage(url, imageUrl, sourceId(item), text(item.id), image, article);
      content.append(meta, title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim(); if (description) { const summary = root.createElement("p"); summary.className = "newsnow-summary"; summary.textContent = description; content.appendChild(summary); }
      if (url) { const open = root.createElement("span"); open.className = "newsnow-open-hint"; open.textContent = i18n("openWebPage", "打开网页 →"); content.appendChild(open); article.addEventListener("click", () => openArticle(item)); article.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openArticle(item); } }); }
      article.append(rail, content); return article;
    }
    function filteredItems() { return selectedCategory === "全部" ? allItems : allItems.filter((item) => sourceCategory(sourceForId(sourceId(item))) === selectedCategory); }
    function masonryColumnCount() {
      const minimumCardWidth = 210, gap = 13, width = feed.clientWidth || page.clientWidth || minimumCardWidth;
      return Math.max(1, Math.floor((width + gap) / (minimumCardWidth + gap)));
    }
    function renderCards(container, items) {
      if (layout !== "grid") { container.replaceChildren(...items.map(makeCard)); return; }
      const columnCount = masonryColumnCount(); container.style.setProperty("--newsnow-grid-columns", String(columnCount));
      const columns = Array.from({ length: columnCount }, () => {
        const column = root.createElement("div"); column.className = "newsnow-masonry-column"; return column;
      });
      items.forEach((item, index) => columns[index % columns.length].appendChild(makeCard(item)));
      container.replaceChildren(...columns);
    }
    function renderFeed() {
      const items = filteredItems(); applyDisplayOptions();
      if (!items.length) { const empty = root.createElement("div"); empty.className = "newsnow-empty"; empty.textContent = allItems.length ? i18n("noNewsInCategory", "这个分类暂时没有资讯。") : i18n("noNews", "暂无资讯。请刷新，或在“管理来源”中调整显示内容。"); feed.replaceChildren(empty); return; }
      if (order === "mixed") { renderCards(feed, items); return; }
      const groups = new Map(); items.forEach((item) => { const id = sourceId(item); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(item); });
      const orderedIds = [...sourceIds, ...groups.keys()].filter((id, index, list) => groups.has(id) && list.indexOf(id) === index);
      feed.replaceChildren(...orderedIds.map((id) => { const section = root.createElement("section"), heading = root.createElement("h2"), cards = root.createElement("div"), source = sourceForId(id); section.className = "newsnow-source-section"; heading.textContent = text(source?.name || groups.get(id)[0] && sourceName(groups.get(id)[0]) || "资讯"); cards.className = "newsnow-source-cards"; renderCards(cards, groups.get(id)); section.append(heading, cards); return section; }));
    }
    async function loadSources() {
      if (catalog.length) return catalog; if (catalogueLoading) return catalogueLoading;
      catalogueLoading = Promise.resolve(invoke && invoke("newsnow_sources")).then((sources) => Array.isArray(sources) ? sources : []).then((sources) => { catalog = sources; sourceIds = loadStoredSourceIds(catalog); renderSourceSummary(); renderCategories(); return catalog; }).catch(() => { catalog = []; sourceIds = []; renderSourceSummary(); return catalog; }).finally(() => { catalogueLoading = null; });
      return catalogueLoading;
    }
    function applyNewsResult(result, { announce = false } = {}) {
      allItems = resultItems(result); renderCategories(); renderFeed();
      const stamp = result?.fetched_at || result?.fetchedAt;
      updated.textContent = stamp ? format("newsUpdatedAt", "更新于 {time}", { time: itemDate({ published_at: stamp }) }) : "";
      if (!announce || page.hidden) return;
      const message = text(result?.message).trim();
      setStatus(message || (allItems.length ? `已更新 ${allItems.length} 条资讯。` : "没有获取到资讯。"), result?.stale ? "warning" : (message && !allItems.length ? "error" : "muted"));
    }
    async function refreshInBackground({ announce = false } = {}) {
      if (backgroundRefreshRunning || !newsEnabled() || !invoke) return;
      backgroundRefreshRunning = true;
      try {
        await loadSources();
        const result = await withTimeout(invoke("newsnow_prefetch", { request: newsRequest() }), 60000);
        applyNewsResult(result, { announce });
      } catch (_) {
        if (announce && !page.hidden) setStatus("资讯后台更新失败，正在保留已显示内容。", "warning");
      } finally { backgroundRefreshRunning = false; }
    }
    function stopBackgroundPrefetch() {
      if (prefetchDelayTimer) global.clearTimeout(prefetchDelayTimer);
      if (prefetchIntervalTimer) global.clearInterval(prefetchIntervalTimer);
      prefetchDelayTimer = 0; prefetchIntervalTimer = 0;
    }
    function refreshIfIdle() {
      if (Date.now() - lastUserActivityAt < BACKGROUND_PREFETCH_DELAY_MS) return;
      void refreshInBackground();
    }
    function scheduleBackgroundPrefetch() {
      stopBackgroundPrefetch();
      if (!newsEnabled() || !backgroundPrefetchEnabled() || !invoke) return;
      prefetchDelayTimer = global.setTimeout(() => {
        refreshIfIdle();
        prefetchIntervalTimer = global.setInterval(refreshIfIdle, BACKGROUND_PREFETCH_INTERVAL_MS);
      }, BACKGROUND_PREFETCH_DELAY_MS);
    }
    async function load(force = false) {
      if (loading || !invoke) return; loading = true; refresh.disabled = true; refresh.textContent = force ? i18n("refreshingNews", "刷新中…") : i18n("loadingNews", "加载中…"); setStatus(force ? i18n("refreshingNews", "刷新中…") : i18n("loadingNews", "加载中…"), "muted");
      try { await loadSources(); const result = await withTimeout(invoke(force ? "newsnow_refresh" : "newsnow_list", { request: newsRequest() })); applyNewsResult(result, { announce: true }); if (!force && result?.stale) void refreshInBackground({ announce: true }); }
      catch (error) { renderFeed(); setStatus(error?.message === "资讯请求超时" ? "资讯请求超时，正在保留当前内容。" : "资讯加载失败，请检查网络后重试。", "error"); }
      finally { loading = false; refresh.disabled = false; refresh.textContent = i18n("refresh", "刷新"); }
    }
    async function open() {
      if (!newsEnabled() || !invoke) return; root.getElementById("menu")?.classList.remove("show"); root.getElementById("filter-panel")?.classList.remove("show"); root.getElementById("account-panel")?.classList.remove("show"); if (!root.getElementById("library-ai-page")?.hidden) global.ReaderLibraryAiEntry?.close();
      page.hidden = false; shell.hidden = true; global.document.body.classList.add("newsnow-active"); button.setAttribute("aria-pressed", "true"); await load(false);
    }
    function close({ focus = true } = {}) { closeSourcePicker(); closeArticle({ restoreScroll: false }); page.hidden = true; shell.hidden = false; global.document.body.classList.remove("newsnow-active"); button.setAttribute("aria-pressed", "false"); if (focus && !button.hidden) button.focus({ preventScroll: true }); }
    button.addEventListener("click", () => { if (!page.hidden || !reader.hidden) close({ focus: false }); else void open(); }); back.addEventListener("click", () => close()); refresh.addEventListener("click", () => void load(true)); listLayout.addEventListener("click", () => setLayout("list")); gridLayout.addEventListener("click", () => setLayout("grid")); mixedOrder.addEventListener("click", () => setOrder("mixed")); sourceOrder.addEventListener("click", () => setOrder("source"));
    sourceToggle.addEventListener("click", () => { if (sourcePicker.hidden) void loadSources().then(openSourcePicker); else closeSourcePicker({ focus: true }); }); sourceClose.addEventListener("click", () => closeSourcePicker({ focus: true })); sourceSearch.addEventListener("input", () => { sourceQuery = sourceSearch.value; renderSourcePicker(); }); sourceReset.addEventListener("click", () => { pendingSourceIds = defaultSourceIds(catalog); renderSourcePicker(); });
    tiebaBarForm.addEventListener("submit", (event) => { event.preventDefault(); const name = normalizeTiebaBars([tiebaBarInput.value])[0]; if (!name) { tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.includes(name)) { tiebaBarInput.value = ""; tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.length >= MAX_TIEBA_BARS) { setStatus(`最多添加 ${MAX_TIEBA_BARS} 个贴吧。`, "warning"); return; } pendingTiebaBarNames = [...pendingTiebaBarNames, name]; if (!pendingSourceIds.includes("tieba") && pendingSourceIds.length < MAX_SOURCES) pendingSourceIds = [...pendingSourceIds, "tieba"]; tiebaBarInput.value = ""; renderSourcePicker(); tiebaBarInput.focus(); });
    sourceApply.addEventListener("click", () => { const selected = allowedSourceIds(pendingSourceIds, catalog); if (!selected.length) { setStatus(i18n("chooseSource", "至少选择一个来源，或使用“恢复推荐”。"), "warning"); return; } if (selected.includes("tieba") && !pendingTiebaBarNames.length) { setStatus("请先添加至少一个贴吧吧名，或取消选择百度贴吧。", "warning"); return; } sourceIds = selected; tiebaBarNames = normalizeTiebaBars(pendingTiebaBarNames); storageSet(SOURCE_STORAGE_KEY, JSON.stringify(sourceIds)); storageSet(TIEBA_BARS_STORAGE_KEY, JSON.stringify(tiebaBarNames)); selectedCategory = "全部"; renderSourceSummary(); renderCategories(); closeSourcePicker({ focus: true }); void load(true); });
    global.addEventListener("keydown", (event) => { if (event.key !== "Escape" || (page.hidden && reader.hidden)) return; if (!reader.hidden) closeArticle({ focus: true }); else if (!sourcePicker.hidden) closeSourcePicker({ focus: true }); else close(); });
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach((eventName) => global.addEventListener(eventName, () => { lastUserActivityAt = Date.now(); }, { passive: true }));
    global.addEventListener("resize", () => { if (layout !== "grid" || page.hidden || !feed.clientWidth) return; global.clearTimeout(masonryResizeTimer); masonryResizeTimer = global.setTimeout(renderFeed, 120); });
    global.addEventListener("app-language-changed", () => { renderSourceSummary(); renderSourceSelection(); renderCategories(); renderSourcePicker(); renderFeed(); });
    global.__TAURI__?.event?.listen?.("newsnow-return-to-feed", () => closeArticle({ focus: true }));
    global.addEventListener("reader-experimental-features-changed", (event) => { if (event.detail?.key === "newsnow") applyExperimentalAvailability(); if (event.detail?.key === "newsnow" || event.detail?.key === "newsnowPrefetch") scheduleBackgroundPrefetch(); }); applyExperimentalAvailability(); applyDisplayOptions(); scheduleBackgroundPrefetch();
    return { open, close, refresh: () => load(true), render: (items) => { allItems = resultItems(items); renderCategories(); renderFeed(); }, sources: () => catalog.slice(), layout: () => layout, order: () => order };
  }
  global.ReaderNewsUI = { init, resultItems, safeHttpUrl, withTimeout, allowedSourceIds };
  if (global.document) global.ReaderNewsUI.instance = init();
})(window);
