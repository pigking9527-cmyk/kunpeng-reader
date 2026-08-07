/* A browser-rendered, reader-owned news page. The Rust side fetches the feed;
   a selected source article opens in a main-window child WebView. */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 18000;
  const SOURCE_STORAGE_KEY = "kunpeng.reader.news.sources.v2";
  const TIEBA_BARS_STORAGE_KEY = "kunpeng.reader.news.tieba-bars.v1";
  const TIEBA_ENABLED_BARS_STORAGE_KEY = "kunpeng.reader.news.tieba-enabled-bars.v1";
  const LAYOUT_STORAGE_KEY = "kunpeng.reader.news.layout.v1";
  const ORDER_STORAGE_KEY = "kunpeng.reader.news.order.v1";
  const MAX_SOURCES = 24;
  const MAX_TIEBA_BARS = 8;
  const BACKGROUND_PREFETCH_DELAY_MS = 30 * 1000;
  const BACKGROUND_PREFETCH_INTERVAL_MS = 5 * 60 * 1000;
  const BACKGROUND_PREFETCH_BATCHES = 4;
  const VISIBLE_IMAGE_CONCURRENCY = 4;

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
  function previewAttempted(item) {
    return item?.previewAttempted === true || item?.preview_attempted === true || Boolean(safeImageDataUrl(item?.previewDataUrl || item?.preview_data_url));
  }
  function hasPendingPreviews(result) {
    return resultItems(result).some((item) => !previewAttempted(item) && Boolean(safeHttpUrl(item?.url || item?.link || item?.href)));
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
  const sourceCategory = (source) => text(source?.category).trim() || i18n("newsCategoryOther", "其他");
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
  function enabledTiebaBars(values, bars) { const available = new Set(normalizeTiebaBars(bars)); return normalizeTiebaBars(values).filter((name) => available.has(name)); }
  function loadStoredEnabledTiebaBars(bars) { const saved = readJson(TIEBA_ENABLED_BARS_STORAGE_KEY); return Array.isArray(saved) ? enabledTiebaBars(saved, bars) : bars.slice(); }
  function storageGet(key, fallback) { try { return global.localStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
  function storageSet(key, value) { try { global.localStorage.setItem(key, value); } catch (_) { /* preferences are optional */ } }

  function init({ root = document, invoke = global.__TAURI__?.core?.invoke } = {}) {
    const button = root.getElementById("newsnow-toolbar-btn");
    const page = root.getElementById("newsnow-page");
    const back = root.getElementById("newsnow-back");
    const refresh = root.getElementById("newsnow-refresh");
    const gestureSettings = root.getElementById("newsnow-gesture-settings");
    const gestureEnabledInput = root.getElementById("newsnow-gesture-enabled");
    const gesturePrecisionSelect = root.getElementById("newsnow-gesture-precision");
    const gestureEditorToggle = root.getElementById("newsnow-gesture-editor-toggle");
    const gestureEditor = root.getElementById("newsnow-gesture-editor");
    const gesturePad = root.getElementById("newsnow-gesture-pad");
    const gestureSave = root.getElementById("newsnow-gesture-save");
    const gestureClear = root.getElementById("newsnow-gesture-clear");
    const gestureStatus = root.getElementById("newsnow-gesture-status");
    const gestureTrail = root.getElementById("newsnow-gesture-trail");
    const sourceToggle = root.getElementById("newsnow-source-toggle");
    const sourcePicker = root.getElementById("newsnow-source-picker");
    const sourceSearch = root.getElementById("newsnow-source-search");
    const sourceOptions = root.getElementById("newsnow-source-options");
    const sourceStatus = root.getElementById("newsnow-source-status");
    const sourceClose = root.getElementById("newsnow-source-close");
    const tiebaBars = root.getElementById("newsnow-tieba-bars");
    const tiebaAddToggle = root.getElementById("newsnow-tieba-add-toggle");
    const tiebaBarForm = root.getElementById("newsnow-tieba-bar-form");
    const tiebaBarInput = root.getElementById("newsnow-tieba-bar-input");
    const tiebaBarCancel = root.getElementById("newsnow-tieba-bar-cancel");
    const tiebaBarList = root.getElementById("newsnow-tieba-bar-list");
    const tiebaBarCount = root.getElementById("newsnow-tieba-bar-count");
    const sourceSelection = root.getElementById("newsnow-source-selection");
    const listLayout = root.getElementById("newsnow-layout-list");
    const gridLayout = root.getElementById("newsnow-layout-grid");
    const mixedOrder = root.getElementById("newsnow-order-mixed");
    const sourceOrder = root.getElementById("newsnow-order-source");
    const status = root.getElementById("newsnow-status");
    const feed = root.getElementById("newsnow-feed");
    const feedView = root.getElementById("newsnow-feed-view");
    const reader = root.getElementById("newsnow-reader");
    const readerStatus = root.getElementById("newsnow-reader-status");
    const readerBack = root.getElementById("newsnow-reader-back");
    const readerMeta = root.getElementById("newsnow-reader-meta");
    const readerTitle = root.getElementById("newsnow-reader-title");
    const readerOriginal = root.getElementById("newsnow-reader-original");
    const readerContent = root.getElementById("newsnow-reader-content");
    const categories = root.getElementById("newsnow-categories");
    const updated = root.getElementById("newsnow-updated");
    const shell = root.querySelector(".content-shell");
    const gestureApi = global.ReaderNewsGesture;
    if (!button || !page || !back || !refresh || !gestureSettings || !gestureEnabledInput || !gesturePrecisionSelect || !gestureEditorToggle || !gestureEditor || !gesturePad || !gestureSave || !gestureClear || !gestureStatus || !gestureTrail || !gestureApi || !sourceToggle || !sourcePicker || !sourceSearch || !sourceOptions || !sourceStatus || !sourceClose || !tiebaBars || !tiebaAddToggle || !tiebaBarForm || !tiebaBarInput || !tiebaBarCancel || !tiebaBarList || !tiebaBarCount || !sourceSelection || !listLayout || !gridLayout || !mixedOrder || !sourceOrder || !status || !feed || !feedView || !reader || !readerStatus || !readerBack || !readerMeta || !readerTitle || !readerOriginal || !readerContent || !categories || !updated || !shell) return null;

    let catalog = [], sourceIds = [], pendingSourceIds = [], tiebaBarNames = loadStoredTiebaBars(), tiebaEnabledBarNames = loadStoredEnabledTiebaBars(tiebaBarNames), pendingTiebaBarNames = [], pendingTiebaEnabledBarNames = [], allItems = [];
    let selectedCategory = "全部", loading = false, catalogueLoading = null, sourceQuery = "";
    let layout = storageGet(LAYOUT_STORAGE_KEY, "list") === "grid" ? "grid" : "list";
    let order = storageGet(ORDER_STORAGE_KEY, "mixed") === "source" ? "source" : "mixed";
    let articleScrollTop = 0, sourcePageScrollTop = 0, articleOpen = false, currentArticleUrl = "", masonryResizeTimer = 0, renderedMasonryColumnCount = 0, feedRenderPending = false;
    let backgroundRefreshRunning = false, prefetchDelayTimer = 0, prefetchIntervalTimer = 0, lastUserActivityAt = Date.now(), sourceRefreshTimer = 0;
    let savedGesture = gestureApi.load(global.localStorage), gestureEnabled = gestureApi.loadEnabled(global.localStorage), gesturePrecision = gestureApi.loadPrecision(global.localStorage), trainingPoints = [], trainingPointerId = null;
    let activeGesture = null, suppressContextMenuUntil = 0;
    let visibleImageRunning = 0;
    const visibleImageQueue = [];

    const newsEnabled = () => global.ReaderExperimentalFeatures?.enabled?.("newsnow") === true;
    const backgroundPrefetchEnabled = () => global.ReaderExperimentalFeatures?.enabled?.("newsnowPrefetch") === true;
    function applyExperimentalAvailability() {
      const enabled = newsEnabled();
      button.hidden = !enabled;
      if (!enabled && (!page.hidden || !reader.hidden)) close({ focus: false });
    }
    function setStatus(message, kind = "") { status.textContent = text(message); status.className = "newsnow-status" + (kind ? " " + kind : ""); }
    function setSourceStatus(message, kind = "") { sourceStatus.textContent = text(message); sourceStatus.className = "newsnow-source-status" + (kind ? " " + kind : ""); }
    function sourceForId(id) { return catalog.find((source) => text(source.id) === text(id)); }
    function renderSourceSelection() { sourceSelection.textContent = format("newsSelectedSources", "已选 {count} / {max}", { count: pendingSourceIds.length, max: MAX_SOURCES }); }
    function syncPendingTiebaSource() {
      pendingTiebaEnabledBarNames = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      if (!pendingTiebaEnabledBarNames.length) { pendingSourceIds = pendingSourceIds.filter((id) => id !== "tieba"); return true; }
      if (pendingSourceIds.includes("tieba")) return true;
      if (pendingSourceIds.length >= MAX_SOURCES) return false;
      pendingSourceIds = [...pendingSourceIds, "tieba"];
      return true;
    }
    function scheduleSourceRefresh() {
      global.clearTimeout(sourceRefreshTimer);
      sourceRefreshTimer = global.setTimeout(() => {
        if (loading) { scheduleSourceRefresh(); return; }
        void load(true);
      }, 450);
    }
    function persistSourceChanges() {
      const activeTiebaBars = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      const selected = allowedSourceIds(pendingSourceIds.filter((id) => id !== "tieba"), catalog);
      if (activeTiebaBars.length) {
        if (selected.length >= MAX_SOURCES) { setSourceStatus(format("maxSources", "最多选择 {max} 个来源。", { max: MAX_SOURCES }), "warning"); return false; }
        selected.push("tieba");
      }
      if (!selected.length) { setSourceStatus(i18n("newsSourceRequired", "Keep at least one news source."), "warning"); return false; }
      sourceIds = selected;
      tiebaBarNames = normalizeTiebaBars(pendingTiebaBarNames);
      tiebaEnabledBarNames = activeTiebaBars;
      storageSet(SOURCE_STORAGE_KEY, JSON.stringify(sourceIds));
      storageSet(TIEBA_BARS_STORAGE_KEY, JSON.stringify(tiebaBarNames));
      storageSet(TIEBA_ENABLED_BARS_STORAGE_KEY, JSON.stringify(tiebaEnabledBarNames));
      selectedCategory = "全部";
      renderCategories();
      setSourceStatus(i18n("newsSourcesSaved", "Saved. Refreshing news automatically…"), "muted");
      scheduleSourceRefresh();
      return true;
    }
    function renderTiebaBars() {
      pendingTiebaEnabledBarNames = enabledTiebaBars(pendingTiebaEnabledBarNames, pendingTiebaBarNames);
      tiebaBarCount.textContent = `已添加 ${pendingTiebaBarNames.length} / ${MAX_TIEBA_BARS} 个吧 · 已启用 ${pendingTiebaEnabledBarNames.length}`;
      if (!pendingTiebaBarNames.length) { const empty = root.createElement("p"); empty.className = "newsnow-tieba-bar-empty"; empty.textContent = "还没有添加吧名。"; tiebaBarList.replaceChildren(empty); return; }
      tiebaBarList.replaceChildren(...pendingTiebaBarNames.map((bar) => {
        const chip = root.createElement("span"), enabled = root.createElement("input"), name = root.createElement("span"), remove = root.createElement("button");
        chip.className = "newsnow-tieba-bar-chip";
        enabled.type = "checkbox"; enabled.checked = pendingTiebaEnabledBarNames.includes(bar); enabled.title = `启用 ${bar}吧`; enabled.setAttribute("aria-label", enabled.title);
        name.textContent = `${bar}吧`;
        enabled.addEventListener("change", () => {
          const previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice();
          if (enabled.checked) {
            if (!pendingTiebaEnabledBarNames.includes(bar)) pendingTiebaEnabledBarNames = [...pendingTiebaEnabledBarNames, bar];
            if (!syncPendingTiebaSource()) { pendingTiebaEnabledBarNames = pendingTiebaEnabledBarNames.filter((name) => name !== bar); enabled.checked = false; setSourceStatus(format("maxSources", "最多选择 {max} 个来源。", { max: MAX_SOURCES }), "warning"); }
          } else { pendingTiebaEnabledBarNames = pendingTiebaEnabledBarNames.filter((name) => name !== bar); syncPendingTiebaSource(); }
          if (!persistSourceChanges()) { pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; enabled.checked = previousEnabled.includes(bar); }
          renderTiebaBars(); renderSourceSelection();
        });
        remove.type = "button"; remove.title = `删除 ${bar}吧`; remove.setAttribute("aria-label", remove.title); remove.textContent = "×";
        remove.addEventListener("click", () => { const previousBars = pendingTiebaBarNames.slice(), previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice(); pendingTiebaBarNames = pendingTiebaBarNames.filter((name) => name !== bar); pendingTiebaEnabledBarNames = pendingTiebaEnabledBarNames.filter((name) => name !== bar); syncPendingTiebaSource(); if (!persistSourceChanges()) { pendingTiebaBarNames = previousBars; pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; } renderTiebaBars(); renderSourceSelection(); });
        chip.append(enabled, name, remove); return chip;
      }));
    }
    function setTiebaAddOpen(open, { focus = false } = {}) {
      tiebaBarForm.hidden = !open;
      tiebaAddToggle.hidden = open;
      if (!open) tiebaBarInput.value = "";
      if (open && focus) tiebaBarInput.focus({ preventScroll: true });
    }
    function newsRequest() { return { sourceIds, tiebaBars: sourceIds.includes("tieba") ? tiebaEnabledBarNames : [] }; }
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
      const groups = new Map(), query = sourceQuery.trim().toLocaleLowerCase();
      renderTiebaBars();
      renderSourceSelection();
      const selected = new Set(pendingSourceIds);
      catalog.filter((source) => text(source.id) !== "tieba" && (!query || [source.id, source.name, source.category].some((value) => text(value).toLocaleLowerCase().includes(query)))).forEach((source) => {
        const category = sourceCategory(source); if (!groups.has(category)) groups.set(category, []); groups.get(category).push(source);
      });
      if (!groups.size) { const empty = root.createElement("p"); empty.className = "newsnow-source-empty"; empty.textContent = i18n("noMatchingSources", "没有找到匹配的内置来源。"); sourceOptions.replaceChildren(empty); return; }
      sourceOptions.replaceChildren(...[...groups.entries()].map(([category, sources]) => {
        const group = root.createElement("section"), title = root.createElement("h2"), choices = root.createElement("div");
        group.className = "newsnow-source-group"; title.textContent = category; choices.className = "newsnow-source-choices";
        sources.forEach((source) => {
          const label = root.createElement("label"), checkbox = root.createElement("input"), swatch = root.createElement("i"), name = root.createElement("span"), id = text(source.id);
          checkbox.type = "checkbox"; checkbox.checked = selected.has(id); label.className = "newsnow-source-choice" + (checkbox.checked ? " selected" : ""); swatch.style.background = text(source.color || "#718097"); name.textContent = text(source.name);
          checkbox.addEventListener("change", () => {
            const previousSources = pendingSourceIds.slice();
            if (checkbox.checked) { if (pendingSourceIds.length >= MAX_SOURCES) { checkbox.checked = false; setSourceStatus(format("maxSources", "最多选择 {max} 个来源。", { max: MAX_SOURCES }), "warning"); return; } pendingSourceIds = [...pendingSourceIds, id]; }
            else pendingSourceIds = pendingSourceIds.filter((value) => value !== id);
            if (!persistSourceChanges()) { pendingSourceIds = previousSources; checkbox.checked = previousSources.includes(id); }
            label.classList.toggle("selected", checkbox.checked); renderSourceSelection();
          });
          label.append(checkbox, swatch, name); choices.appendChild(label);
        });
        group.append(title, choices); return group;
      }));
    }
    function openSourcePicker() { pendingSourceIds = sourceIds.slice(); pendingTiebaBarNames = tiebaBarNames.slice(); pendingTiebaEnabledBarNames = tiebaEnabledBarNames.slice(); syncPendingTiebaSource(); sourceQuery = ""; sourceSearch.value = ""; sourceStatus.textContent = ""; setTiebaAddOpen(false); renderSourcePicker(); sourcePageScrollTop = page.scrollTop; feedView.hidden = true; sourcePicker.hidden = false; page.classList.add("newsnow-source-page-active"); page.scrollTop = 0; sourceToggle.setAttribute("aria-expanded", "true"); sourceSearch.focus({ preventScroll: true }); }
    function closeSourcePicker({ focus = false, restoreScroll = true } = {}) { const wasOpen = !sourcePicker.hidden; setTiebaAddOpen(false); sourcePicker.hidden = true; feedView.hidden = false; page.classList.remove("newsnow-source-page-active"); sourceToggle.setAttribute("aria-expanded", "false"); if (wasOpen && restoreScroll) global.requestAnimationFrame(() => { page.scrollTop = sourcePageScrollTop; if (feedRenderPending || layout === "grid") renderFeed(); }); if (focus) sourceToggle.focus({ preventScroll: true }); }
    function setReaderVisible(visible) { reader.hidden = !visible; page.hidden = visible; closeSourcePicker({ restoreScroll: false }); }
    function renderLocalArticle(article) {
      readerMeta.textContent = [text(article?.source).trim(), text(article?.publishedAt || article?.published_at).trim()].filter(Boolean).join(" · ");
      readerTitle.textContent = text(article?.title).trim() || "资讯正文";
      readerContent.innerHTML = text(article?.contentHtml || article?.content_html);
      readerStatus.textContent = "";
      readerContent.scrollTop = 0;
    }
    function closeArticle({ focus = false, restoreScroll = true } = {}) {
      if (articleOpen && invoke) void Promise.resolve(invoke("newsnow_close_article")).catch(() => {});
      articleOpen = false; currentArticleUrl = ""; readerStatus.textContent = ""; readerMeta.textContent = ""; readerTitle.textContent = ""; readerContent.replaceChildren(); setReaderVisible(false);
      // 正文打开期间后台可能补齐了缩略图。资讯页隐藏时不能测量瀑布流
      // 宽度，因此回到列表后再用真实宽度重建；方格按钮与卡片列数始终一致。
      if (feedRenderPending || layout === "grid") renderFeed();
      if (restoreScroll) global.requestAnimationFrame(() => { page.scrollTop = articleScrollTop; });
      if (focus) feed.querySelector(".newsnow-card")?.focus({ preventScroll: true });
    }
    function activeGestureSurface() { return gestureEnabled ? (!reader.hidden ? reader : (!page.hidden ? page : null)) : null; }
    function paintGestureTrail(points) {
      gestureTrail.hidden = false;
      gestureApi.draw(gestureTrail, points, { color: "#3478d4", lineWidth: 5 });
    }
    function clearGestureTrail() {
      gestureTrail.hidden = true;
      gestureApi.draw(gestureTrail, []);
      gestureTrail.classList.remove("matched", "rejected");
    }
    function beginBackGesture(event) {
      if (event.button !== 2 || event.target?.closest?.(".modal")) return;
      const surface = activeGestureSurface();
      if (!surface || !surface.contains(event.target)) return;
      event.preventDefault();
      activeGesture = { points: [{ x: event.clientX, y: event.clientY }] };
      paintGestureTrail(activeGesture.points);
    }
    function moveBackGesture(event) {
      if (!activeGesture) return;
      event.preventDefault();
      const previous = activeGesture.points[activeGesture.points.length - 1];
      if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 4) return;
      activeGesture.points.push({ x: event.clientX, y: event.clientY });
      if (activeGesture.points.length > 160) activeGesture.points.splice(1, 1);
      paintGestureTrail(activeGesture.points);
    }
    function finishBackGesture(event, { cancelled = false } = {}) {
      if (!activeGesture) return;
      const gesture = activeGesture; activeGesture = null;
      const score = cancelled || !savedGesture.length ? 0 : gestureApi.similarity(savedGesture, gesture.points);
      const matched = score >= gestureApi.matchThreshold(gesturePrecision);
      if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
      // 松开右键便结束绘制，不保留灰色或绿色结果轨迹。
      clearGestureTrail();
      if (!matched) return;
      if (!reader.hidden) closeArticle({ focus: false });
      else if (!sourcePicker.hidden) closeSourcePicker({ focus: false });
      else close({ focus: false });
    }
    function gesturePadPoint(event) {
      const rect = gesturePad.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    function renderSavedGesture() {
      gestureEnabledInput.checked = gestureEnabled;
      gesturePrecisionSelect.value = gesturePrecision;
      if (!trainingPoints.length) gestureApi.draw(gesturePad, savedGesture, { normalized: true, color: savedGesture.length ? "#3478d4" : "#a4afbd", lineWidth: 5 });
    }
    function beginGestureTraining(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      trainingPointerId = event.pointerId;
      trainingPoints = [gesturePadPoint(event)];
      try { gesturePad.setPointerCapture(event.pointerId); } catch (_) { /* best effort */ }
      gestureStatus.textContent = "正在记录轨迹…";
      gestureApi.draw(gesturePad, trainingPoints, { color: "#3478d4", lineWidth: 5 });
    }
    function moveGestureTraining(event) {
      if (trainingPointerId !== event.pointerId) return;
      event.preventDefault();
      const point = gesturePadPoint(event), previous = trainingPoints[trainingPoints.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return;
      trainingPoints.push(point);
      gestureApi.draw(gesturePad, trainingPoints, { color: "#3478d4", lineWidth: 5 });
    }
    function finishGestureTraining(event) {
      if (trainingPointerId !== event.pointerId) return;
      trainingPointerId = null;
      try { gesturePad.releasePointerCapture(event.pointerId); } catch (_) { /* best effort */ }
      gestureStatus.textContent = gestureApi.pathLength(trainingPoints) >= gestureApi.MIN_PATH_LENGTH ? "轨迹已画好，点击“保存轨迹”生效。" : "轨迹太短，请重新画。";
    }
    async function openArticle(item) {
      const url = safeHttpUrl(item.url || item.link || item.href); if (!url) return;
      articleScrollTop = page.scrollTop; page.scrollTop = 0; articleOpen = true; currentArticleUrl = url; readerMeta.textContent = sourceName(item); readerTitle.textContent = text(item.title || item.name || "资讯正文"); readerContent.replaceChildren(); readerStatus.textContent = i18n("loadingNews", "加载中…"); setReaderVisible(true);
      try {
        const article = await invoke("newsnow_open_article", { request: {
          url,
          title: text(item.title || item.name),
          summary: text(item.summary || item.description || item.content || item.excerpt),
          publishedAt: text(item.publishedAt || item.published_at || item.pubDate || item.date),
          gestureEnabled,
          gesturePoints: savedGesture.map((point) => [point.x, point.y]),
        } });
        if (article?.local) renderLocalArticle(article);
        else readerStatus.textContent = "";
      }
      catch (_) { articleOpen = false; currentArticleUrl = ""; setReaderVisible(false); setStatus("资讯正文加载失败，请稍后重试。", "error"); }
    }
    function applyCardImage(image, card, url) {
      if (!url) return;
      image.classList.remove("loading"); image.src = url; image.hidden = false; card.classList.add("has-image");
    }
    function runVisibleImageQueue() {
      while (visibleImageRunning < VISIBLE_IMAGE_CONCURRENCY && visibleImageQueue.length) {
        const job = visibleImageQueue.shift();
        if (!job?.image?.isConnected || job.image.dataset.previewLoaded === "true") continue;
        visibleImageRunning += 1;
        job.item.previewAttempted = true;
        Promise.resolve(invoke("newsnow_preview_image", { request: {
          url: job.url,
          imageUrl: text(job.item.imageUrl || job.item.image_url || job.item.image || job.item.cover),
          sourceId: sourceId(job.item),
          itemId: text(job.item.id || job.item.itemId || job.item.item_id),
        } })).then((preview) => {
          const value = safeImageDataUrl(preview?.imageDataUrl || preview?.image_data_url);
          if (value && job.image.isConnected) {
            job.item.previewDataUrl = value;
            job.image.dataset.previewLoaded = "true";
            applyCardImage(job.image, job.card, value);
          } else if (job.image.isConnected) {
            job.image.classList.remove("loading"); job.image.hidden = true;
          }
        }).catch(() => {
          if (job.image.isConnected) { job.image.classList.remove("loading"); job.image.hidden = true; }
        }).finally(() => { visibleImageRunning -= 1; runVisibleImageQueue(); });
      }
    }
    const visibleImageObserver = typeof global.IntersectionObserver === "function" ? new global.IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        visibleImageObserver.unobserve(entry.target);
        const job = entry.target.__newsPreviewJob;
        if (job) { entry.target.__newsPreviewJob = null; visibleImageQueue.push(job); runVisibleImageQueue(); }
      });
    }, { root: page, rootMargin: "500px 0px" }) : null;
    function resetVisibleImageQueue() {
      visibleImageQueue.length = 0;
      if (!visibleImageObserver) return;
      feed.querySelectorAll(".newsnow-card-image").forEach((image) => {
        visibleImageObserver.unobserve(image); image.__newsPreviewJob = null;
      });
    }
    function scheduleVisibleImage(item, image, card, url) {
      if (!invoke || !url || previewAttempted(item)) return;
      image.hidden = false; image.classList.add("loading");
      const job = { item, image, card, url };
      if (visibleImageObserver) { image.__newsPreviewJob = job; visibleImageObserver.observe(image); }
      else global.setTimeout(() => { visibleImageQueue.push(job); runVisibleImageQueue(); }, 0);
    }
    function makeCard(item) {
      const article = root.createElement("article"), url = safeHttpUrl(item.url || item.link || item.href), rail = root.createElement("div"), content = root.createElement("div"), meta = root.createElement("div"), source = root.createElement("span"), title = root.createElement("h2");
      article.className = "newsnow-card"; article.tabIndex = url ? 0 : -1; rail.className = "newsnow-card-rail"; rail.style.background = text(item.sourceColor || item.source_color || "#718097"); content.className = "newsnow-card-content"; meta.className = "newsnow-meta"; source.className = "newsnow-source-name"; source.textContent = sourceName(item); title.textContent = text(item.title || item.name || "未命名新闻"); meta.appendChild(source);
      const time = itemDate(item); if (time) { const timeEl = root.createElement("time"); timeEl.textContent = time; meta.appendChild(timeEl); }
      const prefetchedImage = safeImageDataUrl(item.previewDataUrl || item.preview_data_url);
      const image = root.createElement("img"); image.className = "newsnow-card-image"; image.alt = ""; image.loading = "lazy"; image.hidden = true;
      image.addEventListener("error", () => { image.classList.remove("loading"); image.hidden = true; article.classList.remove("has-image"); }); content.appendChild(image);
      // 后台缓存负责大批量填充；尚未尝试过的可见卡片再走一个至多 4 路的
      // 按需队列，避免首屏等待所有来源，也避免滚动时瞬间发出数百个请求。
      if (prefetchedImage) applyCardImage(image, article, prefetchedImage);
      else scheduleVisibleImage(item, image, article, url);
      content.append(meta, title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim(); if (description) { const summary = root.createElement("p"); summary.className = "newsnow-summary"; summary.textContent = description; content.appendChild(summary); }
      if (url) { const open = root.createElement("span"); open.className = "newsnow-open-hint"; open.textContent = i18n("openWebPage", "打开网页 →"); content.appendChild(open); article.addEventListener("click", () => openArticle(item)); article.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openArticle(item); } }); }
      article.append(rail, content); return article;
    }
    function filteredItems() { return selectedCategory === "全部" ? allItems : allItems.filter((item) => sourceCategory(sourceForId(sourceId(item))) === selectedCategory); }
    function masonryColumnCount() {
      const minimumCardWidth = 210, gap = 13, width = feed.clientWidth || page.clientWidth;
      if (!width) return Math.max(1, renderedMasonryColumnCount || 1);
      return Math.max(1, Math.floor((width + gap) / (minimumCardWidth + gap)));
    }
    function estimatedCardHeight(item, columnCount) {
      const gap = 13;
      const availableWidth = Math.max(160, ((feed.clientWidth || page.clientWidth || 210) - gap * (columnCount - 1)) / columnCount - 40);
      const charsPerLine = Math.max(10, Math.floor(availableWidth / 16));
      const lineCount = (value, maximum) => Math.min(maximum, Math.max(1, Math.ceil(Array.from(text(value)).length / charsPerLine)));
      const titleLines = lineCount(item.title || item.name || "未命名新闻", 4);
      const summary = text(item.summary || item.description || item.content || item.excerpt).trim();
      const summaryLines = summary ? lineCount(summary, 3) : 0;
      const hasImage = Boolean(safeImageDataUrl(item.previewDataUrl || item.preview_data_url));
      return 68 + titleLines * 27 + summaryLines * 21 + (hasImage ? 146 : 0) + 44;
    }
    function renderCards(container, items) {
      if (layout !== "grid") { renderedMasonryColumnCount = 0; container.replaceChildren(...items.map(makeCard)); return; }
      const columnCount = masonryColumnCount(); container.style.setProperty("--newsnow-grid-columns", String(columnCount));
      const columns = Array.from({ length: columnCount }, () => {
        const column = root.createElement("div"); column.className = "newsnow-masonry-column"; return column;
      });
      const columnHeights = Array.from({ length: columnCount }, () => 0);
      items.forEach((item) => {
        const target = columnHeights.reduce((shortest, height, index) => height < columnHeights[shortest] ? index : shortest, 0);
        columns[target].appendChild(makeCard(item));
        columnHeights[target] += estimatedCardHeight(item, columnCount);
      });
      renderedMasonryColumnCount = columnCount;
      container.replaceChildren(...columns);
    }
    function renderFeed() {
      applyDisplayOptions();
      // hidden 会令 clientWidth 变成 0。此时保留最新数据，等资讯页重新可见
      // 后再渲染，避免方格布局被错误固化成单列。
      if (page.hidden || feedView.hidden) { feedRenderPending = true; return; }
      feedRenderPending = false;
      resetVisibleImageQueue();
      const items = filteredItems();
      if (!items.length) { const empty = root.createElement("div"); empty.className = "newsnow-empty"; empty.textContent = allItems.length ? i18n("noNewsInCategory", "这个分类暂时没有资讯。") : i18n("noNews", "暂无资讯。请刷新，或在“管理来源”中调整显示内容。"); feed.replaceChildren(empty); return; }
      if (order === "mixed") { renderCards(feed, items); return; }
      const groups = new Map(); items.forEach((item) => { const id = sourceId(item); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(item); });
      // 自定义贴吧是用户主动订阅的内容。放在按来源视图的首组，避免它被
      // 一串默认来源排到屏幕外，造成“已经添加却看不到”的错觉。
      const orderedIds = [...sourceIds, ...groups.keys()]
        .filter((id, index, list) => groups.has(id) && list.indexOf(id) === index)
        .sort((left, right) => {
          const leftPriority = left === "tieba" ? 0 : 1, rightPriority = right === "tieba" ? 0 : 1;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return 0;
        });
      feed.replaceChildren(...orderedIds.map((id) => { const section = root.createElement("section"), heading = root.createElement("h2"), cards = root.createElement("div"), source = sourceForId(id); section.className = "newsnow-source-section"; heading.textContent = text(source?.name || groups.get(id)[0] && sourceName(groups.get(id)[0]) || "资讯"); cards.className = "newsnow-source-cards"; renderCards(cards, groups.get(id)); section.append(heading, cards); return section; }));
    }
    async function loadSources() {
      if (catalog.length) return catalog; if (catalogueLoading) return catalogueLoading;
      catalogueLoading = Promise.resolve(invoke && invoke("newsnow_sources")).then((sources) => Array.isArray(sources) ? sources : []).then((sources) => { catalog = sources; sourceIds = loadStoredSourceIds(catalog); renderCategories(); return catalog; }).catch(() => { catalog = []; sourceIds = []; return catalog; }).finally(() => { catalogueLoading = null; });
      return catalogueLoading;
    }
    function applyNewsResult(result, { announce = false } = {}) {
      allItems = resultItems(result); renderCategories(); renderFeed();
      const stamp = result?.fetched_at || result?.fetchedAt;
      updated.textContent = stamp ? format("newsUpdatedAt", "更新于 {time}", { time: itemDate({ published_at: stamp }) }) : "";
      if (!announce || page.hidden) return;
      const message = text(result?.message).trim();
      // 不展示“已更新 N 条资讯”：资讯数量由每个已选来源实际返回的内容
      // 决定，并非阅读器设定的配额。只有错误、旧缓存或来源不可用时提示。
      setStatus(message, result?.stale ? "warning" : (message && !allItems.length ? "error" : "muted"));
    }
    async function refreshInBackground({ announce = false } = {}) {
      if (backgroundRefreshRunning || !newsEnabled() || !invoke) return;
      backgroundRefreshRunning = true;
      try {
        await loadSources();
        let result = null;
        // 后端每轮只压缩一批封面，避免一次刷新被数百张图片拖住。空闲后台
        // 连续推进有限批次，并在最后整体替换卡片，既覆盖更多文章，也避免
        // 每拿到一张图片就改变瀑布流高度。
        for (let batch = 0; batch < BACKGROUND_PREFETCH_BATCHES; batch += 1) {
          result = await withTimeout(invoke("newsnow_prefetch", { request: newsRequest() }), 60000);
          if (!hasPendingPreviews(result)) break;
        }
        if (result) applyNewsResult(result, { announce });
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
      try {
        await loadSources();
        const result = await withTimeout(invoke(force ? "newsnow_refresh" : "newsnow_list", { request: newsRequest() }));
        applyNewsResult(result, { announce: true });
        // 新安装或缓存升级后，列表会先有文字缓存但还没有缩略图；立即安排
        // 一次后台填充，保证下次进入资讯页可直接使用稳定的封面尺寸。
        const needsPreviewCache = hasPendingPreviews(result);
        if (result?.stale || needsPreviewCache) void refreshInBackground({ announce: true });
      }
      catch (error) { renderFeed(); setStatus(error?.message === "资讯请求超时" ? "资讯请求超时，正在保留当前内容。" : "资讯加载失败，请检查网络后重试。", "error"); }
      finally { loading = false; refresh.disabled = false; refresh.textContent = i18n("refresh", "刷新"); }
    }
    async function open() {
      if (!newsEnabled() || !invoke) return; root.getElementById("menu")?.classList.remove("show"); root.getElementById("filter-panel")?.classList.remove("show"); root.getElementById("account-panel")?.classList.remove("show"); if (!root.getElementById("library-ai-page")?.hidden) global.ReaderLibraryAiEntry?.close();
      page.hidden = false; feedView.hidden = false; sourcePicker.hidden = true; page.classList.remove("newsnow-source-page-active"); shell.hidden = true; global.document.body.classList.add("newsnow-active"); button.setAttribute("aria-pressed", "true");
      // 页面关闭期间完成的后台补图先应用到现有缓存，无需再点开一篇正文
      // 才能看到图片；随后正常加载最新列表。
      if (feedRenderPending) renderFeed();
      await load(false);
    }
    function close({ focus = true } = {}) { closeSourcePicker({ restoreScroll: false }); closeArticle({ restoreScroll: false }); page.hidden = true; shell.hidden = false; global.document.body.classList.remove("newsnow-active"); button.setAttribute("aria-pressed", "false"); if (focus && !button.hidden) button.focus({ preventScroll: true }); }
    gestureSettings.addEventListener("click", () => {
      trainingPoints = []; gestureStatus.textContent = ""; gestureEditor.hidden = true; gestureEditorToggle.setAttribute("aria-expanded", "false");
      global.ReaderExperimentalFeatures?.instance?.openSettings?.(); global.requestAnimationFrame(renderSavedGesture);
    });
    gestureEnabledInput.addEventListener("change", () => {
      gestureEnabled = gestureApi.saveEnabled(gestureEnabledInput.checked, global.localStorage);
      if (!gestureEnabled) { activeGesture = null; clearGestureTrail(); }
      gestureStatus.textContent = gestureEnabled && !savedGesture.length ? i18n("gestureNeedPath", "Draw and save a gesture-back path first.") : "";
    });
    gesturePrecisionSelect.addEventListener("change", () => {
      gesturePrecision = gestureApi.savePrecision(gesturePrecisionSelect.value, global.localStorage);
      gesturePrecisionSelect.value = gesturePrecision;
      const precisionKey = gesturePrecision === "low" ? "precisionLow" : gesturePrecision === "high" ? "precisionHigh" : "precisionMedium";
      gestureStatus.textContent = format("gesturePrecisionSaved", "Gesture-back precision is set to {precision}.", { precision: i18n(precisionKey, gesturePrecision) });
    });
    gestureEditorToggle.addEventListener("click", () => {
      const open = gestureEditor.hidden;
      gestureEditor.hidden = !open; gestureEditorToggle.setAttribute("aria-expanded", String(open));
      if (open) global.requestAnimationFrame(renderSavedGesture);
    });
    gesturePad.addEventListener("pointerdown", beginGestureTraining);
    gesturePad.addEventListener("pointermove", moveGestureTraining);
    gesturePad.addEventListener("pointerup", finishGestureTraining);
    gesturePad.addEventListener("pointercancel", finishGestureTraining);
    gestureSave.addEventListener("click", () => { const saved = gestureApi.save(trainingPoints, global.localStorage); if (!saved.length) { gestureStatus.textContent = i18n("gesturePathTooShort", "The path is too short to save."); return; } savedGesture = saved; gestureEnabled = gestureApi.saveEnabled(true, global.localStorage); trainingPoints = []; gestureStatus.textContent = i18n("gestureSaved", "Gesture back is saved and enabled."); renderSavedGesture(); });
    gestureClear.addEventListener("click", () => { gestureApi.clear(global.localStorage); gestureEnabled = gestureApi.saveEnabled(false, global.localStorage); savedGesture = []; trainingPoints = []; activeGesture = null; clearGestureTrail(); gestureStatus.textContent = i18n("gestureCleared", "Gesture back is cleared and disabled."); renderSavedGesture(); });
    button.addEventListener("click", () => { if (!page.hidden || !reader.hidden) close({ focus: false }); else void open(); }); back.addEventListener("click", () => close()); refresh.addEventListener("click", () => void load(true)); listLayout.addEventListener("click", () => setLayout("list")); gridLayout.addEventListener("click", () => setLayout("grid")); mixedOrder.addEventListener("click", () => setOrder("mixed")); sourceOrder.addEventListener("click", () => setOrder("source"));
    readerBack.addEventListener("click", () => closeArticle({ focus: true }));
    readerOriginal.addEventListener("click", () => { if (currentArticleUrl) void Promise.resolve(invoke("open_url", { url: currentArticleUrl })).catch(() => {}); });
    readerContent.addEventListener("click", (event) => {
      const link = event.target?.closest?.("a"); if (!link || !currentArticleUrl) return;
      event.preventDefault();
      let url = ""; try { url = safeHttpUrl(new URL(link.getAttribute("href") || "", currentArticleUrl).href); } catch (_) { url = ""; }
      if (url) void Promise.resolve(invoke("open_url", { url })).catch(() => {});
    });
    sourceToggle.addEventListener("click", () => { if (sourcePicker.hidden) void loadSources().then(openSourcePicker); else closeSourcePicker({ focus: true }); }); sourceClose.addEventListener("click", () => closeSourcePicker({ focus: true })); sourceSearch.addEventListener("input", () => { sourceQuery = sourceSearch.value; renderSourcePicker(); });
    tiebaAddToggle.addEventListener("click", () => setTiebaAddOpen(true, { focus: true }));
    tiebaBarCancel.addEventListener("click", () => setTiebaAddOpen(false, { focus: true }));
    tiebaBarForm.addEventListener("submit", (event) => { event.preventDefault(); const name = normalizeTiebaBars([tiebaBarInput.value])[0]; if (!name) { tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.includes(name)) { tiebaBarInput.value = ""; tiebaBarInput.focus(); return; } if (pendingTiebaBarNames.length >= MAX_TIEBA_BARS) { setSourceStatus(format("newsTiebaLimit", "You can add up to {max} forums.", { max: MAX_TIEBA_BARS }), "warning"); return; } const previousBars = pendingTiebaBarNames.slice(), previousEnabled = pendingTiebaEnabledBarNames.slice(), previousSources = pendingSourceIds.slice(); pendingTiebaBarNames = [...pendingTiebaBarNames, name]; pendingTiebaEnabledBarNames = [...pendingTiebaEnabledBarNames, name]; if (!syncPendingTiebaSource() || !persistSourceChanges()) { pendingTiebaBarNames = previousBars; pendingTiebaEnabledBarNames = previousEnabled; pendingSourceIds = previousSources; setSourceStatus(format("newsSourceLimit", "The source limit is reached, so {name} cannot be enabled yet.", { name }), "warning"); } renderSourcePicker(); setTiebaAddOpen(false, { focus: true }); });
    global.addEventListener("mousedown", beginBackGesture, true);
    global.addEventListener("mousemove", moveBackGesture, { capture: true, passive: false });
    global.addEventListener("mouseup", (event) => finishBackGesture(event), true);
    global.addEventListener("blur", () => finishBackGesture(null, { cancelled: true }));
    global.addEventListener("contextmenu", (event) => { const surface = activeGestureSurface(); if ((activeGesture || Date.now() < suppressContextMenuUntil) && surface?.contains(event.target)) event.preventDefault(); }, true);
    global.addEventListener("keydown", (event) => { if (event.key !== "Escape" || (page.hidden && reader.hidden)) return; if (!reader.hidden) closeArticle({ focus: true }); else if (!sourcePicker.hidden) closeSourcePicker({ focus: true }); else close(); });
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach((eventName) => global.addEventListener(eventName, () => { lastUserActivityAt = Date.now(); }, { passive: true }));
    global.addEventListener("resize", () => {
      if (layout !== "grid" || page.hidden || feedView.hidden || !feed.clientWidth) return;
      // 拖动窗口时宽度会持续变化，但列数未变无需重建全部卡片；否则图片
      // 和文章节点反复销毁/创建，会造成肉眼可见的闪烁。
      if (masonryColumnCount() === renderedMasonryColumnCount) return;
      global.clearTimeout(masonryResizeTimer);
      masonryResizeTimer = global.setTimeout(() => {
        if (masonryColumnCount() !== renderedMasonryColumnCount) renderFeed();
      }, 120);
    });
    global.addEventListener("app-language-changed", () => { renderSourceSelection(); renderCategories(); renderSourcePicker(); renderFeed(); });
    global.__TAURI__?.event?.listen?.("newsnow-return-to-feed", () => closeArticle({ focus: true }));
    global.addEventListener("reader-experimental-features-changed", (event) => { if (event.detail?.key === "newsnow") applyExperimentalAvailability(); if (event.detail?.key === "newsnow" || event.detail?.key === "newsnowPrefetch") scheduleBackgroundPrefetch(); }); applyExperimentalAvailability(); applyDisplayOptions(); scheduleBackgroundPrefetch();
    return { open, close, refresh: () => load(true), render: (items) => { allItems = resultItems(items); renderCategories(); renderFeed(); }, sources: () => catalog.slice(), layout: () => layout, order: () => order };
  }
  global.ReaderNewsUI = { init, resultItems, safeHttpUrl, withTimeout, allowedSourceIds };
  if (global.document) global.ReaderNewsUI.instance = init();
})(window);
