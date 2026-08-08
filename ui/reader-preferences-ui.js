(function initReaderPreferences(global) {
  "use strict";
  const modal = document.getElementById("reader-preferences-modal");
  const openButton = document.getElementById("reader-preferences-btn");
  const closeButton = document.getElementById("reader-preferences-close");
  if (!modal || !openButton || !global.ReaderSettings) return;

  const PALETTE_STORAGE_KEY = "readerCustomPalettesV1";
  const PALETTE_ORDER_KEY = "readerPaletteOrderV1";
  const MAX_CUSTOM_PALETTES = 10;
  const MAX_BACKGROUND_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_INLINE_BACKGROUND_IMAGE_CHARS = 160000; // legacy migration only
  const invoke = global.__TAURI__?.core?.invoke;
  const readerPreferenceT = (key, fallback, values) => global.ReaderI18n?.t?.(key, values) || fallback;
  const preferencesContent = modal.querySelector(".reader-preferences-content");

  const preferencesScrollbar = modal.querySelector("#reader-preferences-scrollbar");
  const preferencesScrollThumb = modal.querySelector("#reader-preferences-scroll-thumb");
  let paletteSyncTimer = 0;
  let paletteSyncReady = false;
  const builtinPalettes = [
    { id: "light", name: "浅色", nameKey: "paletteLight", background: "#ffffff", text: "#222222", link: "#246ed4", selection: "#f7dc82", footnote: "#eef7ef", border: "#6f8f7d", theme: "light" },
    { id: "dark", name: "深色", nameKey: "paletteDark", background: "#1c1c1e", text: "#d2d2d2", link: "#8ab4ff", selection: "#536f9b", footnote: "#273626", border: "#82aa8c", theme: "dark" },
    { id: "paper", name: "羊皮纸", nameKey: "palettePaper", background: "#f8f1df", text: "#443a2d", link: "#7b4c26", selection: "#e8d290", footnote: "#f2e7c9", border: "#a48453", theme: "light" },
  ];
  const colorMap = { customBackgroundColor: "background", textColor: "text", linkColor: "link", selectionColor: "selection", footnoteBackground: "footnote", footnoteBorder: "border" };
  let scope = "default";
  let pointerDrag = null;
  let suppressPaletteClickUntil = 0;
  let preferencesScrollDrag = null;

  function localAssetUrl(palette) {
    const id = String(palette?.backgroundAssetId || "").toLowerCase();
    const mime = String(palette?.backgroundAssetMime || "");
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime];
    return /^[0-9a-f]{64}$/.test(id) && ext ? `http://reader.localhost/background/${id}.${ext}` : "";
  }

  function safePaletteImage(value) {
    const image = String(value || "");
    if (/^(?:reader:\/\/localhost|http:\/\/reader\.localhost)\/background\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/i.test(image)) return image;
    // Old palette payloads are only used as a bounded migration fallback.
    return image.length <= MAX_INLINE_BACKGROUND_IMAGE_CHARS && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(image) ? image : "";
  }

  function sanitizePalette(palette) {
    if (!palette || typeof palette !== "object") return palette;
    const image = localAssetUrl(palette) || safePaletteImage(palette.backgroundImage);
    return Object.assign({}, palette, { backgroundImage: image });
  }

  function loadCustomPalettes() {
    try {
      const stored = JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "[]");
      return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string" && typeof item.name === "string").slice(0, MAX_CUSTOM_PALETTES).map(sanitizePalette) : [];
    } catch (_) { return []; }
  }

  function saveCustomPalettes(palettes) {
    const limited = palettes.slice(0, MAX_CUSTOM_PALETTES);
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(limited));
    queuePaletteSync(limited);
  }

  function queuePaletteSync(palettes = loadCustomPalettes()) {
    if (!paletteSyncReady || typeof invoke !== "function") return;
    // The local reader URL is a display/cache detail, never sync payload data.
    // Only the content-addressed asset reference crosses the sync boundary.
    const syncPalettes = palettes.map((palette) => {
      const localUrl = localAssetUrl(palette);
      return localUrl || /^(?:reader:\/\/localhost|http:\/\/reader\.localhost)\/background\//i.test(String(palette?.backgroundImage || ""))
        ? Object.assign({}, palette, { backgroundImage: "" })
        : palette;
    });
    global.clearTimeout(paletteSyncTimer);
    paletteSyncTimer = global.setTimeout(() => {
      invoke("reader_palette_sync_save", { request: { palettes: syncPalettes, order: JSON.parse(localStorage.getItem(PALETTE_ORDER_KEY) || "[]") } }).catch(() => {});
    }, 180);
  }

  function isBuiltinPalette(palette) { return builtinPalettes.some((item) => item.id === palette.id); }

  function paletteLabel(palette) {
    return palette?.nameKey ? readerPreferenceT(palette.nameKey, palette.name) : String(palette?.name || "");
  }

  function paletteDeleteTone(palette) {
    const color = String(palette.background || "#ffffff").replace("#", "");
    const value = color.length === 3 ? color.split("").map((part) => part + part).join("") : color;
    if (!/^[0-9a-f]{6}$/i.test(value)) return "on-light";
    const red = parseInt(value.slice(0, 2), 16), green = parseInt(value.slice(2, 4), 16), blue = parseInt(value.slice(4, 6), 16);
    return red * 0.299 + green * 0.587 + blue * 0.114 > 154 ? "on-light" : "on-dark";
  }



  function applyPalettePreview(element, palette) {
    const image = String(palette.backgroundImage || "");
    const safeImage = safePaletteImage(image);
    element.classList.toggle("has-background-image", Boolean(safeImage));
    element.style.backgroundImage = safeImage ? `url("${safeImage}")` : "";
  }

  function updateCustomPalette(id, patch) {
    const palettes = loadCustomPalettes().map((palette) => palette.id === id ? Object.assign({}, palette, patch) : palette);
    saveCustomPalettes(palettes);
  }

  function removeCustomPalette(id) {
    const active = paletteForSettings(read());
    saveCustomPalettes(loadCustomPalettes().filter((palette) => palette.id !== id));
    if (active?.id === id) updateAppearance(palettePatch(paletteList()[0] || builtinPalettes[0]));
    else render();
  }

  function beginPaletteNameEdit(label, palette) {
    const input = document.createElement("input");
    input.className = "reader-palette-name-input";
    input.value = paletteLabel(palette);
    input.maxLength = 24;
    input.setAttribute("aria-label", readerPreferenceT("paletteName", "主题名称"));
    label.replaceWith(input);
    input.focus(); input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim().slice(0, 24);
      if (save && name) updateCustomPalette(palette.id, { name });
      render();
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
  }
  function paletteList() {
    const palettes = [...builtinPalettes, ...loadCustomPalettes()];
    let order = [];
    try { order = JSON.parse(localStorage.getItem(PALETTE_ORDER_KEY) || "[]"); } catch (_) {}
    const known = new Map(palettes.map((palette) => [palette.id, palette]));
    const ordered = (Array.isArray(order) ? order : []).map((id) => known.get(id)).filter(Boolean);
    palettes.forEach((palette) => { if (!ordered.some((item) => item.id === palette.id)) ordered.push(palette); });
    return ordered;
  }

  function read() { return global.ReaderSettings.getAppearance?.(scope) || global.ReaderSettings.get(); }

  function paletteForSettings(settings) {
    const selected = String(settings.customPaletteId || "");
    if (selected) return paletteList().find((palette) => palette.id === selected) || null;
    return paletteList().find((palette) => palette.id === settings.backgroundPreset) || null;
  }

  function applyToolbar(settings) {
    const visible = (id, value) => document.getElementById(id)?.toggleAttribute("hidden", value === false);
    global.ReaderSettings.applyToolbarVisibility();
    visible("toc-btn", settings.showTocButton);
    visible("tts-btn", settings.showTtsButton);
    visible("hl-btn", settings.showAnnotationButton);
    document.getElementById("reader-progress-group")?.toggleAttribute("hidden", settings.showPageInfo === false);
  }

  function palettePatch(palette) {
    if (builtinPalettes.some((item) => item.id === palette.id)) {
      return { backgroundPreset: palette.id, customPaletteId: "", customBackgroundImage: "", theme: palette.theme, textColor: "", linkColor: "", selectionColor: "", footnoteBackground: "", footnoteBorder: "" };
    }
    return { backgroundPreset: "custom", customPaletteId: palette.id, customBackgroundColor: palette.background, customBackgroundImage: safePaletteImage(palette.backgroundImage), textColor: palette.text, linkColor: palette.link, selectionColor: palette.selection, footnoteBackground: palette.footnote, footnoteBorder: palette.border, theme: palette.theme || "light" };
  }

  function updateAppearance(patch, targetScope = scope) {
    if (typeof global.ReaderSettings.updateAppearance === "function") global.ReaderSettings.updateAppearance(patch, targetScope);
    else global.ReaderSettings.update(patch);
    render();
  }

  // 快捷配色没有“总体 / 独立”的范围选择。若当前书已经保存了独立外观，
  // 继续写入总体设置不会影响它，用户会看到按钮已点却没有变化。此时把快捷
  // 操作写到当前书；没有独立外观时仍保持原来的总体设置行为。
  function quickPaletteScope() {
    return global.currentBookId && global.ReaderSettings.hasBookAppearance?.() ? "book" : "default";
  }

  function applyQuickPalette(palette) {
    updateAppearance(palettePatch(palette), quickPaletteScope());
  }


  // Import stays outside the reader document.  It may use FileReader once to
  // hand bytes to the native cache, but no Base64 is persisted or rendered.


  function animatePaletteInsert(state, beforeNode) {
    const grid = state.tile.parentElement;
    if (!grid) return;
    if (!beforeNode && state.placeholder === grid.lastElementChild) return;
    if (beforeNode === state.placeholder) return;
    const before = new Map();
    [...grid.children].forEach((tile) => { if (tile !== state.tile && tile !== state.placeholder) before.set(tile, tile.getBoundingClientRect()); });
    grid.insertBefore(state.placeholder, beforeNode || null);
    [...grid.children].forEach((tile) => {
      if (tile === state.tile || tile === state.placeholder) return;
      const first = before.get(tile);
      if (!first) return;
      const last = tile.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) return;
      tile.style.transition = "none";
      tile.style.transform = `translate(${dx}px, ${dy}px)`;
      tile.getBoundingClientRect();
      requestAnimationFrame(() => {
        tile.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1), background .16s ease, border-color .16s ease, box-shadow .16s ease";
        tile.style.transform = "";
      });
    });
  }

  function movePaletteDrag(clientX, clientY) {
    const state = pointerDrag;
    if (!state) return;
    state.tile.style.left = `${clientX - state.offsetX}px`;
    state.tile.style.top = `${clientY - state.offsetY}px`;
    const target = document.elementFromPoint(clientX, clientY)?.closest?.("[data-palette-id]");
    if (target && target !== state.tile) {
      const box = target.getBoundingClientRect();
      const before = clientY < box.top + box.height / 2 || (clientY <= box.bottom && clientX < box.left + box.width / 2) ? target : target.nextElementSibling;
      animatePaletteInsert(state, before === state.tile ? state.tile.nextElementSibling : before);
      state.moved = true;
      return;
    }
    const grid = state.placeholder.parentElement;
    const box = grid?.getBoundingClientRect();
    if (box && clientY > box.bottom - 4) {
      animatePaletteInsert(state, null);
      state.moved = true;
    }
  }

  function finishPointerDrag(event) {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const choosePalette = !state.moved ? state.choose : null;
    suppressPaletteClickUntil = performance.now() + 250;
    pointerDrag = null;
    try { state.capture.releasePointerCapture(event.pointerId); } catch (_) {}
    state.tile.classList.remove("dragging");
    state.placeholder.parentElement?.insertBefore(state.tile, state.placeholder);
    state.placeholder.remove();
    state.tile.style.position = "";
    state.tile.style.left = "";
    state.tile.style.top = "";
    state.tile.style.width = "";
    state.tile.style.height = "";
    localStorage.setItem(PALETTE_ORDER_KEY, JSON.stringify([...state.tile.parentElement.querySelectorAll("[data-palette-id]")].map((tile) => tile.dataset.paletteId)));
    queuePaletteSync();
    if (choosePalette) choosePalette();
    else renderQuickPalettes();
  }

  function addCurrentPalette() {
    const current = read();
    const active = paletteForSettings(current);
    const palettes = loadCustomPalettes();
    if (palettes.length >= MAX_CUSTOM_PALETTES) {
      global.alert?.(readerPreferenceT("paletteLimit", "自定义配色最多可保存 10 个。"));
      return;
    }
    const id = `custom-${Date.now().toString(36)}`;
    const nameInput = document.getElementById("pref-palette-name");
    const requestedName = String(nameInput?.value || "").trim().slice(0, 24);
    const palette = {
      id, name: requestedName || readerPreferenceT("customPaletteName", `我的配色 ${palettes.length + 1}`, { number: palettes.length + 1 }), background: current.customBackgroundColor || active?.background || "#fffdf8", backgroundImage: "", backgroundAssetId: current.customBackgroundAssetId || active?.backgroundAssetId || "", backgroundAssetSha256: current.customBackgroundAssetSha256 || active?.backgroundAssetSha256 || "", backgroundAssetMime: current.customBackgroundAssetMime || active?.backgroundAssetMime || "", backgroundAssetBytes: current.customBackgroundAssetBytes || active?.backgroundAssetBytes || 0,
      text: current.textColor || active?.text || "#222222", link: current.linkColor || active?.link || "#246ed4", selection: current.selectionColor || active?.selection || "#f7dc82", footnote: current.footnoteBackground || active?.footnote || "#eef7ef", border: current.footnoteBorder || active?.border || "#6f8f7d", theme: current.theme || "light",
    };
    palettes.push(palette);
    saveCustomPalettes(palettes);
    if (nameInput) nameInput.value = "";
    updateAppearance(palettePatch(palette));
  }


  function renderQuickPalettes() {
    const host = document.getElementById("reader-quick-palette");
    if (!host) return;
    const active = paletteForSettings(global.ReaderSettings.get());
    host.replaceChildren();
    paletteList().slice(0, 3).forEach((palette) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "reader-quick-palette-btn" + (active?.id === palette.id ? " active" : "");
      button.style.setProperty("--quick-bg", palette.background);
      button.style.setProperty("--quick-fg", palette.text);
      applyPalettePreview(button, palette);
      button.textContent = paletteLabel(palette).slice(0, 2);
      button.title = paletteLabel(palette);
      button.addEventListener("click", (event) => { event.stopPropagation(); applyQuickPalette(palette); global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.SETTINGS, true); });
      host.append(button);
    });
  }

  function renderPaletteGrid() {
    const grid = modal.querySelector("#pref-palette-grid");
    if (!grid) return;
    const settings = read();
    const active = paletteForSettings(settings);
    grid.replaceChildren();
    const palettes = paletteList();
    grid.closest(".reader-palette-scroll")?.classList.toggle("has-many-palettes", palettes.length > 9);
    palettes.forEach((palette) => {
      const tile = document.createElement("div");
      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.className = "reader-palette-tile" + (active?.id === palette.id ? " active" : "");
      tile.dataset.paletteId = palette.id;
      tile.style.setProperty("--pref-bg", palette.background);
      tile.style.setProperty("--pref-fg", palette.text);
      applyPalettePreview(tile, palette);
      tile.setAttribute("aria-label", readerPreferenceT("paletteDragHint", `${paletteLabel(palette)}，按住拖动以排序`, { name: paletteLabel(palette) }));
      const name = document.createElement("span");
      name.className = "reader-palette-name" + (isBuiltinPalette(palette) ? "" : " editable");
      name.textContent = paletteLabel(palette);
      tile.append(name);
      if (!isBuiltinPalette(palette)) {
        name.title = readerPreferenceT("editPaletteName", "编辑主题名称");
        name.addEventListener("click", (event) => { event.stopPropagation(); beginPaletteNameEdit(name, palette); });
        const remove = document.createElement("span");
        remove.className = "reader-palette-delete " + paletteDeleteTone(palette);
        remove.setAttribute("role", "button");
        remove.tabIndex = 0;
        remove.setAttribute("aria-label", readerPreferenceT("deletePaletteNamed", `删除${paletteLabel(palette)}`, { name: paletteLabel(palette) }));
        remove.title = readerPreferenceT("deletePalette", "删除配色");
        remove.textContent = "🗑";
        const removePalette = (event) => { event.preventDefault(); event.stopPropagation(); removeCustomPalette(palette.id); };
        remove.addEventListener("pointerdown", (event) => event.stopPropagation());
        remove.addEventListener("click", removePalette);
        remove.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") removePalette(event); });
        tile.append(remove);
      }
      tile.addEventListener("click", (event) => { if (performance.now() < suppressPaletteClickUntil) { event.preventDefault(); return; } updateAppearance(palettePatch(palette)); });
      tile.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".reader-palette-name,.reader-palette-delete")) return;
        if (event.button !== 0 || pointerDrag) return;
        event.preventDefault();
        const box = tile.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "reader-palette-placeholder";
        tile.parentElement.insertBefore(placeholder, tile.nextSibling);
        tile.classList.add("dragging");
        tile.style.position = "fixed";
        tile.style.left = `${box.left}px`;
        tile.style.top = `${box.top}px`;
        tile.style.width = `${box.width}px`;
        tile.style.height = `${box.height}px`;
        pointerDrag = { tile, placeholder, capture: tile, pointerId: event.pointerId, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top, moved: false, choose: () => updateAppearance(palettePatch(palette)) };
        try { tile.setPointerCapture(event.pointerId); } catch (_) {}
      });
      tile.addEventListener("pointermove", (event) => { if (pointerDrag?.pointerId === event.pointerId) { event.preventDefault(); movePaletteDrag(event.clientX, event.clientY); } });
      tile.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && event.target === tile) { event.preventDefault(); updateAppearance(palettePatch(palette)); } });
      tile.addEventListener("pointerup", finishPointerDrag);
      tile.addEventListener("pointercancel", finishPointerDrag);
      grid.append(tile);
    });
  }

  function updatePreferencesScrollbar() {
    if (!preferencesContent || !preferencesScrollbar || !preferencesScrollThumb) return;
    const viewport = preferencesContent.clientHeight;
    const total = preferencesContent.scrollHeight;
    const maxScroll = Math.max(0, total - viewport);
    preferencesScrollbar.hidden = maxScroll <= 1 || viewport <= 0;
    if (preferencesScrollbar.hidden) return;
    const thumbHeight = Math.max(36, Math.min(viewport, Math.round(viewport * viewport / total)));
    const travel = Math.max(0, viewport - thumbHeight);
    const thumbTop = maxScroll ? Math.round(preferencesContent.scrollTop / maxScroll * travel) : 0;
    preferencesScrollbar.style.top = `${preferencesContent.offsetTop}px`;
    preferencesScrollbar.style.height = `${viewport}px`;
    preferencesScrollThumb.style.height = `${thumbHeight}px`;
    preferencesScrollThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function finishPreferencesScrollDrag(event) {
    if (!preferencesScrollDrag || preferencesScrollDrag.pointerId !== event.pointerId) return;
    try { preferencesScrollThumb.releasePointerCapture(event.pointerId); } catch (_) {}
    preferencesScrollDrag = null;
  }

  function render() {
    const settings = read();
    modal.querySelectorAll("[data-pref-scope]").forEach((button) => {
      const selected = button.dataset.prefScope === scope;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const bookScope = modal.querySelector('[data-pref-scope="book"]');
    if (bookScope) bookScope.disabled = !global.currentBookId;
    const palette = paletteForSettings(settings) || builtinPalettes[0];
    modal.querySelectorAll("[data-pref-color]").forEach((input) => { input.value = settings[input.dataset.prefColor] || palette[colorMap[input.dataset.prefColor]]; });
    const imageName = modal.querySelector("#pref-background-image-name");
    if (imageName) imageName.textContent = settings.customBackgroundImage ? readerPreferenceT("backgroundImported", "已导入图片背景") : "";
    const clearBook = modal.querySelector("#pref-clear-book-appearance");
    if (clearBook) clearBook.hidden = scope !== "book" || !global.ReaderSettings.hasBookAppearance?.();
    const image = document.getElementById("pref-image-pagination");
    if (image) image.value = settings.imagePagination === "continuous" ? "continuous" : "next-page";
    modal.querySelectorAll("[data-pref-bool]").forEach((input) => { input.checked = settings[input.dataset.prefBool] !== false; });
    const jumpBackMode = settings.readerJumpBackDismissMode === "time" ? "time" : "pages";
    const jumpBackModeSelect = document.getElementById("pref-reader-jump-back-dismiss-mode");
    if (jumpBackModeSelect) jumpBackModeSelect.value = jumpBackMode;
    const jumpBackPages = document.getElementById("pref-reader-jump-back-pages");
    if (jumpBackPages) jumpBackPages.value = String(Math.max(1, Math.min(100, Number(settings.readerJumpBackDismissPages) || 3)));
    const jumpBackSeconds = document.getElementById("pref-reader-jump-back-seconds");
    if (jumpBackSeconds) jumpBackSeconds.value = String(Math.max(1, Math.min(600, Number(settings.readerJumpBackDismissSeconds) || 30)));
    const jumpBackSize = Math.max(1, Math.min(10, Number(settings.readerJumpBackSizeLevel) || 1));
    const jumpBackSizeInput = document.getElementById("pref-reader-jump-back-size");
    if (jumpBackSizeInput) jumpBackSizeInput.value = String(jumpBackSize);
    const jumpBackSizeValue = document.getElementById("pref-reader-jump-back-size-value");
    if (jumpBackSizeValue) jumpBackSizeValue.textContent = String(jumpBackSize);
    document.getElementById("pref-reader-jump-back-pages-row")?.toggleAttribute("hidden", jumpBackMode !== "pages");
    document.getElementById("pref-reader-jump-back-seconds-row")?.toggleAttribute("hidden", jumpBackMode !== "time");
    applyToolbar(global.ReaderSettings.get());
    renderPaletteGrid();
    renderQuickPalettes();
    requestAnimationFrame(updatePreferencesScrollbar);
  }

  function setSection(name) {
    modal.querySelectorAll("[data-pref-section]").forEach((button) => button.classList.toggle("active", button.dataset.prefSection === name));
    modal.querySelectorAll("[data-pref-panel]").forEach((panel) => { panel.hidden = panel.dataset.prefPanel !== name; });
    requestAnimationFrame(updatePreferencesScrollbar);
  }

  openButton.addEventListener("click", (event) => { event.stopPropagation(); global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, true); render(); });
  closeButton?.addEventListener("click", () => global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, false));
  modal.addEventListener("click", (event) => { if (event.target === modal) global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, false); });
  global.addEventListener("keydown", (event) => { if (event.key === "Escape" && global.ReaderShell?.isOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES)) global.ReaderShell.closeOverlay(); });
  preferencesContent?.addEventListener("scroll", updatePreferencesScrollbar, { passive: true });

  preferencesScrollThumb?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !preferencesContent) return;
    event.preventDefault();
    preferencesScrollDrag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: preferencesContent.scrollTop };
    try { preferencesScrollThumb.setPointerCapture(event.pointerId); } catch (_) {}
  });
  preferencesScrollThumb?.addEventListener("pointermove", (event) => {
    if (!preferencesScrollDrag || preferencesScrollDrag.pointerId !== event.pointerId || !preferencesContent) return;
    event.preventDefault();
    const viewport = preferencesContent.clientHeight;
    const maxScroll = Math.max(0, preferencesContent.scrollHeight - viewport);
    const thumbHeight = preferencesScrollThumb.offsetHeight;
    const travel = Math.max(1, viewport - thumbHeight);
    preferencesContent.scrollTop = preferencesScrollDrag.startScrollTop + (event.clientY - preferencesScrollDrag.startY) * maxScroll / travel;
  });
  preferencesScrollThumb?.addEventListener("pointerup", finishPreferencesScrollDrag);
  preferencesScrollThumb?.addEventListener("pointercancel", finishPreferencesScrollDrag);
  global.addEventListener("resize", updatePreferencesScrollbar);
  if (typeof ResizeObserver === "function" && preferencesContent) new ResizeObserver(updatePreferencesScrollbar).observe(preferencesContent);
  modal.querySelectorAll("[data-pref-section]").forEach((button) => button.addEventListener("click", () => setSection(button.dataset.prefSection)));
  modal.querySelectorAll("[data-pref-scope]").forEach((button) => button.addEventListener("click", () => { if (!button.disabled) { scope = button.dataset.prefScope; render(); } }));
  modal.querySelectorAll("[data-pref-color]").forEach((input) => input.addEventListener("input", () => updateAppearance({ backgroundPreset: "custom", customPaletteId: "", theme: read().theme, [input.dataset.prefColor]: input.value })));
  document.getElementById("pref-background-image")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const status = document.getElementById("pref-background-image-name");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > MAX_BACKGROUND_IMAGE_BYTES) { if (status) status.textContent = readerPreferenceT("backgroundImageInvalid", "请选择 10 MB 以内的 PNG、JPG、WebP 或 GIF 图片"); event.target.value = ""; return; }
    const reader = new FileReader();
reader.onload = async () => {
      const source = String(reader.result || "");
      try {
        const asset = typeof invoke === "function" ? await invoke("cache_reader_background_image", { dataUrl: source }) : null;
        if (!asset?.url || !asset?.assetId) throw new Error("cache unavailable");
        updateAppearance({ backgroundPreset: "custom", customPaletteId: "", theme: read().theme, customBackgroundImage: asset.url, customBackgroundAssetId: asset.assetId, customBackgroundAssetSha256: asset.sha256, customBackgroundAssetMime: asset.mime, customBackgroundAssetBytes: asset.byteSize });
        if (status) status.textContent = file.name;
      } catch (_) { if (status) status.textContent = readerPreferenceT("backgroundImageImportFailed", "背景图片导入失败"); }
      event.target.value = "";
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("pref-clear-background-image")?.addEventListener("click", () => updateAppearance({ customBackgroundImage: "", customBackgroundAssetId: "", customBackgroundAssetSha256: "", customBackgroundAssetMime: "", customBackgroundAssetBytes: 0 }));
  document.getElementById("pref-add-palette")?.addEventListener("click", addCurrentPalette);
  document.getElementById("pref-image-pagination")?.addEventListener("change", (event) => global.ReaderSettings.update({ imagePagination: event.target.value === "continuous" ? "continuous" : "next-page" }));
  function setReaderJumpBackConfigExpanded(expanded) {
    const config = document.getElementById("pref-reader-jump-back-config");
    const button = document.getElementById("pref-reader-jump-back-settings");
    if (!config || !button) return;
    config.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    requestAnimationFrame(updatePreferencesScrollbar);
  }
  const readerJumpBackSettingsButton = document.getElementById("pref-reader-jump-back-settings");
  readerJumpBackSettingsButton?.addEventListener("click", () => {
    const config = document.getElementById("pref-reader-jump-back-config");
    setReaderJumpBackConfigExpanded(!!config?.hidden);
  });
  global.addEventListener("click", (event) => {
    const config = document.getElementById("pref-reader-jump-back-config");
    if (!config || config.hidden) return;
    if (config.contains(event.target) || readerJumpBackSettingsButton?.contains(event.target)) return;
    setReaderJumpBackConfigExpanded(false);
  });
  document.getElementById("pref-reader-jump-back-dismiss-mode")?.addEventListener("change", (event) => {
    global.ReaderSettings.update({ readerJumpBackDismissMode: event.target.value === "time" ? "time" : "pages" });
  });
  document.getElementById("pref-reader-jump-back-pages")?.addEventListener("change", (event) => {
    const value = Math.max(1, Math.min(100, Number(event.target.value) || 3));
    global.ReaderSettings.update({ readerJumpBackDismissPages: value });
  });
  document.getElementById("pref-reader-jump-back-seconds")?.addEventListener("change", (event) => {
    const value = Math.max(1, Math.min(600, Number(event.target.value) || 30));
    global.ReaderSettings.update({ readerJumpBackDismissSeconds: value });
  });
  document.getElementById("pref-reader-jump-back-size")?.addEventListener("input", (event) => {
    const value = Math.max(1, Math.min(10, Number(event.target.value) || 1));
    const output = document.getElementById("pref-reader-jump-back-size-value");
    if (output) output.textContent = String(value);
    global.ReaderSettings.update({ readerJumpBackSizeLevel: value });
  });
  modal.querySelectorAll("[data-pref-bool]").forEach((input) => input.addEventListener("change", () => global.ReaderSettings.update({ [input.dataset.prefBool]: input.checked })));
  document.getElementById("pref-reset-colors")?.addEventListener("click", () => updateAppearance({ textColor: "", linkColor: "", selectionColor: "", footnoteBackground: "", footnoteBorder: "", customPaletteId: "" }));
  document.getElementById("pref-clear-book-appearance")?.addEventListener("click", () => { global.ReaderSettings.clearBookAppearance?.(); render(); });
  global.addEventListener("reader-settings-changed", render);
  global.addEventListener("reader-language-changed", render);
  global.ReaderPreferences = Object.freeze({ open() { global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, true); render(); } });
  async function hydrateSyncedPalettes() {
    if (typeof invoke !== "function") { paletteSyncReady = true; return; }
    try {
      const snapshot = await invoke("reader_palette_sync_get");
      if (Array.isArray(snapshot?.palettes) && snapshot.palettes.length) {
        const palettes = await Promise.all(snapshot.palettes.slice(0, MAX_CUSTOM_PALETTES).map(async (palette) => {
          if (!palette?.backgroundAssetId || !palette?.backgroundAssetMime) return sanitizePalette(palette);
          try {
            const url = await invoke("reader_background_local_url", { assetId: palette.backgroundAssetId, mime: palette.backgroundAssetMime });
            return sanitizePalette(Object.assign({}, palette, { backgroundImage: url }));
          } catch (_) { return sanitizePalette(palette); }
        }));
        localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
        if (Array.isArray(snapshot.order)) localStorage.setItem(PALETTE_ORDER_KEY, JSON.stringify(snapshot.order));
      } else if (loadCustomPalettes().length) {
        paletteSyncReady = true;
        queuePaletteSync();
      }
    } catch (_) { /* 本机浏览器预览仍使用原有 LocalStorage。 */ }
    paletteSyncReady = true;
    render();
  }
  render();
  hydrateSyncedPalettes();
})(window);
