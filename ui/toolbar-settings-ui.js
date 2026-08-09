(function initToolbarSettingsUI(global) {
  "use strict";

  const ITEM_IDS = Object.freeze(["account", "search", "stats", "library", "news", "filter", "settings", "menu"]);
  const CONTENT_IDS = Object.freeze(["icon", "text"]);
  const DEFAULT_SIZE = 36;
  const DEFAULT_SETTINGS = Object.freeze({
    toolbarIconSizePx: DEFAULT_SIZE,
    toolbarItemOrder: ITEM_IDS.slice(),
    toolbarHiddenItems: [],
    toolbarContentOrder: CONTENT_IDS.slice(),
    toolbarContentVisible: ["icon"],
  });
  const ITEM_COPY = Object.freeze({
    account: ["账户", "登录、同步与账户管理"],
    search: ["搜索", "搜索书架和全文"],
    stats: ["阅读统计", "打开阅读数据统计"],
    library: ["书库问答", "在全书库中提问"],
    news: ["资讯", "启用资讯功能后显示"],
    filter: ["筛选与布局", "排序、过滤和书架布局"],
    settings: ["设置", "始终显示，不能隐藏"],
    menu: ["更多菜单", "导入、笔记和关于等功能"],
  });
  const STORAGE_KEY = "mainToolbarSettingsV1";

  let invoke = null;
  let settings = clone(DEFAULT_SETTINGS);
  let saveTimer = 0;
  let dragState = null;
  let contentDragState = null;

  const root = document.getElementById("toolbar-actions");
  const leading = document.getElementById("toolbar-leading-action");
  const list = document.getElementById("toolbar-settings-list");
  const contentList = document.getElementById("toolbar-content-list");
  const sizeInput = document.getElementById("toolbar-icon-size");
  const sizeOutput = document.getElementById("toolbar-icon-size-value");
  const resetButton = document.getElementById("toolbar-reset-layout");
  const status = document.getElementById("toolbar-settings-status");

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function validId(value) { return ITEM_IDS.includes(value); }
  function normalizeOrder(value) {
    const seen = new Set();
    const ordered = Array.isArray(value) ? value.filter((id) => validId(id) && !seen.has(id) && (seen.add(id), true)) : [];
    if (!seen.has("account")) {
      ordered.unshift("account");
      seen.add("account");
    }
    ITEM_IDS.forEach((id) => { if (!seen.has(id)) ordered.push(id); });
    return ordered;
  }
  function normalizeHidden(value) {
    const seen = new Set();
    return Array.isArray(value) ? value.filter((id) => id !== "settings" && validId(id) && !seen.has(id) && (seen.add(id), true)) : [];
  }
  function normalizeContentOrder(value) {
    const seen = new Set();
    const ordered = Array.isArray(value) ? value.filter((id) => CONTENT_IDS.includes(id) && !seen.has(id) && (seen.add(id), true)) : [];
    CONTENT_IDS.forEach((id) => { if (!seen.has(id)) ordered.push(id); });
    return ordered;
  }
  function normalizeContentVisible(value) {
    const seen = new Set();
    const visible = Array.isArray(value) ? value.filter((id) => CONTENT_IDS.includes(id) && !seen.has(id) && (seen.add(id), true)) : [];
    return visible.length ? visible : ["icon"];
  }
  function normalize(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      toolbarIconSizePx: Math.max(28, Math.min(52, Number(source.toolbarIconSizePx) || DEFAULT_SIZE)),
      toolbarItemOrder: normalizeOrder(source.toolbarItemOrder),
      toolbarHiddenItems: normalizeHidden(source.toolbarHiddenItems),
      toolbarContentOrder: normalizeContentOrder(source.toolbarContentOrder),
      toolbarContentVisible: normalizeContentVisible(source.toolbarContentVisible),
    };
  }
  function readCached() {
    try { return normalize(JSON.parse(global.localStorage?.getItem(STORAGE_KEY) || "null")); } catch (_) { return clone(DEFAULT_SETTINGS); }
  }
  function cache() {
    try { global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* storage may be unavailable */ }
  }
  function setStatus(message) { if (status) status.textContent = message || ""; }
  function toolbarItems() {
    if (!root) return [];
    const items = [
      ...Array.from(leading?.querySelectorAll(":scope > [data-toolbar-item]") || []),
      ...Array.from(root.querySelectorAll(":scope > [data-toolbar-item]")),
    ];
    const account = document.querySelector('.account-wrap[data-toolbar-item="account"]');
    return account && !items.includes(account) ? [account, ...items] : items;
  }
  function toolbarButton(id) {
    const ids = {
      account: "account-btn",
      search: "search-btn",
      stats: "stats-toolbar-btn",
      library: "library-ai-toolbar-btn",
      news: "newsnow-toolbar-btn",
      filter: "filter-btn",
      settings: "settings-toolbar-btn",
      menu: "menu-btn",
    };
    return document.getElementById(ids[id] || "");
  }
  function toolbarLabel(id, button) {
    return button?.getAttribute("title") || button?.getAttribute("aria-label") || ITEM_COPY[id]?.[0] || id;
  }
  function ensureToolbarButtonContent(id) {
    const button = toolbarButton(id);
    if (!button) return;
    let icon = button.querySelector(":scope > .toolbar-item-icon");
    let text = button.querySelector(":scope > .toolbar-item-text");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = "toolbar-item-icon";
      Array.from(button.childNodes).forEach((node) => icon.appendChild(node));
      button.appendChild(icon);
    }
    if (!text) {
      text = document.createElement("span");
      text.className = "toolbar-item-text";
      button.appendChild(text);
    }
    text.textContent = toolbarLabel(id, button);
    const parts = { icon, text };
    settings.toolbarContentOrder.forEach((part) => button.appendChild(parts[part]));
    const visible = new Set(settings.toolbarContentVisible);
    CONTENT_IDS.forEach((part) => parts[part].classList.toggle("toolbar-content-hidden", !visible.has(part)));
    button.classList.add("toolbar-content-button");
    button.classList.toggle("toolbar-content-has-text", visible.has("text"));
    button.classList.toggle("toolbar-content-has-icon", visible.has("icon"));
  }

  function animateReflow(before) {
    if (!global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      toolbarItems().forEach((item) => {
        const from = before.get(item);
        const to = item.getBoundingClientRect();
        if (!from) return;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (dx || dy) item.animate([
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ], { duration: 190, easing: "cubic-bezier(.2,.8,.25,1)" });
      });
    }
  }
  function apply(animate = false) {
    if (!root) return;
    const before = new Map(toolbarItems().map((item) => [item, item.getBoundingClientRect()]));
    const byId = new Map(toolbarItems().map((item) => [item.dataset.toolbarItem, item]));
    settings.toolbarItemOrder.forEach((id, index) => {
      const item = byId.get(id);
      if (item) (index === 0 && leading ? leading : root).append(item);
    });
    root.style.setProperty("--toolbar-item-size", `${settings.toolbarIconSizePx}px`);
    leading?.style.setProperty("--toolbar-item-size", `${settings.toolbarIconSizePx}px`);
    const hidden = new Set(settings.toolbarHiddenItems);
    toolbarItems().forEach((item) => {
      item.classList.toggle("toolbar-user-hidden", hidden.has(item.dataset.toolbarItem));
      ensureToolbarButtonContent(item.dataset.toolbarItem);
    });
    if (animate) animateReflow(before);
  }
  function listItems() { return Array.from(list?.querySelectorAll(":scope > [data-toolbar-item]") || []); }
  function contentListItems() { return Array.from(contentList?.querySelectorAll(":scope > [data-toolbar-content]") || []); }
  function animateListPlaceholder(state, beforeNode) {
    const placeholder = state?.placeholder;
    if (!placeholder || !list || beforeNode === placeholder) return;
    if (!beforeNode && placeholder === list.lastElementChild) return;
    if (global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      list.insertBefore(placeholder, beforeNode || null);
      return;
    }
    const before = new Map();
    listItems().forEach((item) => {
      if (item !== state.item && item !== placeholder) before.set(item, item.getBoundingClientRect());
    });
    list.insertBefore(placeholder, beforeNode || null);
    listItems().forEach((item) => {
      if (item === state.item || item === placeholder) return;
      const first = before.get(item);
      if (!first) return;
      const dy = first.top - item.getBoundingClientRect().top;
      if (!dy) return;
      item.style.transition = "none";
      item.style.transform = `translateY(${dy}px)`;
      item.classList.add("reflowing");
      // Same FLIP boundary as the highlight-menu settings editor: the
      // surrounding rows visibly yield while the dragged row follows the
      // pointer above the list.
      void item.offsetHeight;
      global.requestAnimationFrame(() => {
        item.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1), border-color .16s ease, box-shadow .16s ease";
        item.style.transform = "";
        const clean = () => {
          item.style.removeProperty("transition");
          item.style.removeProperty("transform");
          item.classList.remove("reflowing");
        };
        item.addEventListener("transitionend", clean, { once: true });
        global.setTimeout(clean, 230);
      });
    });
  }
  function moveDraggedItem(event) {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const bounds = list?.getBoundingClientRect();
    const maxTop = bounds ? Math.max(bounds.top, bounds.bottom - state.item.offsetHeight) : event.clientY;
    const top = bounds ? Math.max(bounds.top, Math.min(maxTop, event.clientY - state.offsetY)) : event.clientY - state.offsetY;
    const probeY = bounds ? Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)) : event.clientY;
    state.item.style.top = `${top}px`;
    if (Math.abs(probeY - state.startY) > 4) state.moved = true;
    const rows = listItems().filter((item) => item !== state.item);
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (probeY < box.top + box.height / 2) {
        animateListPlaceholder(state, row);
        return;
      }
    }
    animateListPlaceholder(state, null);
  }
  function finishPointerDrag(event) {
    const state = dragState;
    if (!state || event.pointerId !== state.pointerId) return;
    dragState = null;
    if (state.capture.hasPointerCapture?.(event.pointerId)) state.capture.releasePointerCapture(event.pointerId);
    list.insertBefore(state.item, state.placeholder);
    state.placeholder.remove();
    state.item.classList.remove("dragging");
    state.item.removeAttribute("aria-grabbed");
    state.item.style.position = "";
    state.item.style.left = "";
    state.item.style.top = "";
    state.item.style.width = "";
    state.item.style.height = "";
    if (state.moved) update({ toolbarItemOrder: listOrder() }, true);
  }
  function animateContentPlaceholder(beforeNode) {
    const state = contentDragState;
    const placeholder = state?.placeholder;
    if (!placeholder || !contentList || beforeNode === placeholder) return;
    if (!beforeNode && placeholder === contentList.lastElementChild) return;
    const before = new Map(contentListItems().filter((item) => item !== state.item).map((item) => [item, item.getBoundingClientRect()]));
    contentList.insertBefore(placeholder, beforeNode || null);
    contentListItems().forEach((item) => {
      if (item === state.item || item === placeholder) return;
      const first = before.get(item);
      if (!first) return;
      const dx = first.left - item.getBoundingClientRect().left;
      if (!dx || global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      item.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  }
  function moveContentDrag(event) {
    const state = contentDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const bounds = contentList?.getBoundingClientRect();
    const maxLeft = bounds ? Math.max(bounds.left, bounds.right - state.item.offsetWidth) : event.clientX;
    const left = bounds ? Math.max(bounds.left, Math.min(maxLeft, event.clientX - state.offsetX)) : event.clientX - state.offsetX;
    const probeX = bounds ? Math.max(bounds.left, Math.min(bounds.right, event.clientX)) : event.clientX;
    state.item.style.left = `${left}px`;
    if (Math.abs(probeX - state.startX) > 4) state.moved = true;
    const items = contentListItems().filter((item) => item !== state.item);
    for (const item of items) {
      const box = item.getBoundingClientRect();
      if (probeX < box.left + box.width / 2) {
        animateContentPlaceholder(item);
        return;
      }
    }
    animateContentPlaceholder(null);
  }
  function finishContentDrag(event) {
    const state = contentDragState;
    if (!state || event.pointerId !== state.pointerId) return;
    contentDragState = null;
    if (state.capture.hasPointerCapture?.(event.pointerId)) state.capture.releasePointerCapture(event.pointerId);
    contentList.insertBefore(state.item, state.placeholder);
    state.placeholder.remove();
    state.item.classList.remove("dragging");
    state.item.style.position = "";
    state.item.style.left = "";
    state.item.style.top = "";
    state.item.style.width = "";
    state.item.style.height = "";
    if (state.moved) update({ toolbarContentOrder: contentListItems().map((item) => item.dataset.toolbarContent) }, true);
  }
  function renderContentList() {
    if (!contentList) return;
    const visible = new Set(settings.toolbarContentVisible);
    contentList.replaceChildren(...settings.toolbarContentOrder.map((id) => {
      const name = id === "icon" ? "图标" : "文字";
      const sample = id === "icon" ? "◈" : "文";
      const item = document.createElement("div");
      item.className = "toolbar-content-item";
      item.dataset.toolbarContent = id;
      item.setAttribute("role", "listitem");
      item.innerHTML = `<button class="toolbar-content-drag" type="button" aria-label="拖动${name}调整顺序" title="拖动调整顺序">⠿</button><span class="toolbar-content-sample" aria-hidden="true">${sample}</span><strong>${name}</strong><label><input type="checkbox" ${visible.has(id) ? "checked" : ""} /><span>显示</span></label>`;
      const handle = item.querySelector(".toolbar-content-drag");
      const checkbox = item.querySelector("input");
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || contentDragState) return;
        event.preventDefault();
        const box = item.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "toolbar-content-placeholder";
        placeholder.style.width = `${box.width}px`;
        contentList.insertBefore(placeholder, item.nextSibling);
        item.classList.add("dragging");
        item.style.position = "fixed";
        item.style.left = `${box.left}px`;
        item.style.top = `${box.top}px`;
        item.style.width = `${box.width}px`;
        item.style.height = `${box.height}px`;
        contentDragState = { item, placeholder, capture: handle, pointerId: event.pointerId, offsetX: event.clientX - box.left, startX: event.clientX, moved: false };
        handle.setPointerCapture?.(event.pointerId);
      });
      handle.addEventListener("pointermove", moveContentDrag);
      handle.addEventListener("pointerup", finishContentDrag);
      handle.addEventListener("pointercancel", finishContentDrag);
      handle.addEventListener("lostpointercapture", finishContentDrag);
      checkbox.addEventListener("change", () => {
        const next = new Set(settings.toolbarContentVisible);
        if (checkbox.checked) next.add(id); else next.delete(id);
        if (!next.size) {
          checkbox.checked = true;
          setStatus("图标和文字至少保留一项");
          return;
        }
        update({ toolbarContentVisible: Array.from(next) }, true);
      });
      return item;
    }));
  }
  function renderList() {
    if (!list) return;
    list.replaceChildren(...settings.toolbarItemOrder.map((id) => {
      const [name, detail] = ITEM_COPY[id];
      const required = id === "settings";
      const item = document.createElement("div");
      item.className = "toolbar-settings-item";
      item.dataset.toolbarItem = id;
      item.setAttribute("role", "listitem");
      item.innerHTML = `<button class="toolbar-settings-drag" type="button" aria-label="拖动${name}调整顺序" title="拖动调整顺序">⠿</button><span class="toolbar-settings-copy"><strong>${name}</strong><small>${detail}</small></span><label class="toolbar-settings-visible${required ? " is-required" : ""}"><input type="checkbox" ${required || !settings.toolbarHiddenItems.includes(id) ? "checked" : ""} ${required ? "disabled" : ""} /><span>${required ? "固定显示" : "显示"}</span></label>`;
      const handle = item.querySelector(".toolbar-settings-drag");
      const visible = item.querySelector("input");
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || dragState) return;
        event.preventDefault();
        const box = item.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "toolbar-settings-placeholder";
        placeholder.style.height = `${box.height}px`;
        list.insertBefore(placeholder, item.nextSibling);
        item.classList.add("dragging");
        item.setAttribute("aria-grabbed", "true");
        item.style.position = "fixed";
        item.style.left = `${box.left}px`;
        item.style.top = `${box.top}px`;
        item.style.width = `${box.width}px`;
        item.style.height = `${box.height}px`;
        dragState = { item, placeholder, capture: handle, pointerId: event.pointerId, offsetY: event.clientY - box.top, startY: event.clientY, moved: false };
        handle.setPointerCapture?.(event.pointerId);
      });
      handle.addEventListener("pointermove", (event) => {
        moveDraggedItem(event);
      });
      handle.addEventListener("pointerup", finishPointerDrag);
      handle.addEventListener("pointercancel", finishPointerDrag);
      handle.addEventListener("lostpointercapture", finishPointerDrag);
      visible.addEventListener("change", () => {
        if (required) return;
        const hidden = new Set(settings.toolbarHiddenItems);
        if (visible.checked) hidden.delete(id); else hidden.add(id);
        update({ toolbarHiddenItems: Array.from(hidden) }, false);
      });
      return item;
    }));
  }
  function listOrder() { return Array.from(list?.querySelectorAll(":scope > [data-toolbar-item]") || []).map((item) => item.dataset.toolbarItem); }
  function render() {
    if (sizeInput) sizeInput.value = String(settings.toolbarIconSizePx);
    if (sizeOutput) sizeOutput.textContent = `${settings.toolbarIconSizePx} px`;
    renderContentList();
    renderList();
  }
  function scheduleSave() {
    global.clearTimeout(saveTimer);
    saveTimer = global.setTimeout(async () => {
      if (!invoke) return;
      setStatus("正在保存…");
      try {
        const remote = await invoke("app_settings_sync_save", { request: settings });
        if (remote?.hasToolbarSettings) settings = normalize(remote);
        cache();
        setStatus("已保存；下次同步会带到其他设备");
      } catch (error) {
        setStatus(`保存失败：${error?.message || error}`);
      }
    }, 260);
  }
  function update(patch, animate) {
    settings = normalize(Object.assign({}, settings, patch));
    cache();
    apply(Boolean(animate));
    render();
    scheduleSave();
  }
  async function hydrate() {
    if (!invoke) return;
    try {
      const remote = await invoke("app_settings_sync_get");
      if (remote?.hasToolbarSettings) {
        settings = normalize(remote);
        cache();
        apply(false);
        render();
      }
    } catch (_) { /* local cache remains usable while the database is unavailable */ }
  }
  function init(deps) {
    if (!root || !list || !sizeInput || init.ready) return;
    init.ready = true;
    invoke = deps?.invoke || null;
    settings = readCached();
    apply(false);
    render();
    sizeInput.addEventListener("input", () => update({ toolbarIconSizePx: Number(sizeInput.value) }, false));
    resetButton?.addEventListener("click", () => update(clone(DEFAULT_SETTINGS), true));
    global.addEventListener("app-language-changed", () => apply(false));
    global.__TAURI__?.event?.listen?.("app-settings-synced", () => { void hydrate(); });
    void hydrate();
  }

  global.ReaderToolbarSettingsUI = Object.freeze({ init, get: () => clone(settings), apply, normalize });
})(window);
