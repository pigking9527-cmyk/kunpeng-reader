(function initReaderClickZones(global) {
  "use strict";
  const preview = document.getElementById("reader-click-zone-preview");
  const canvas = document.getElementById("reader-click-zone-canvas");
  const resetButton = document.getElementById("reader-click-zone-reset");
  const presetSelect = document.getElementById("reader-click-zone-preset");
  const presetNameInput = document.getElementById("reader-click-zone-preset-name");
  const presetNewButton = document.getElementById("reader-click-zone-preset-new");
  const presetSaveButton = document.getElementById("reader-click-zone-preset-save");
  const presetDeleteButton = document.getElementById("reader-click-zone-preset-delete");
  if (!preview || !canvas || !resetButton || !presetSelect || !presetNameInput || !presetNewButton || !presetSaveButton || !presetDeleteButton || !global.ReaderSettings) return;

  const ACTIONS = Object.freeze(["prev", "center", "next", "none"]);
  const MAX_ZONES = 12;
  const MAX_PRESETS = 12;
  const PRESET_STORAGE_KEY = "readerClickZonePresetsV1";
  const ACTIVE_PRESET_STORAGE_KEY = "readerClickZoneActivePresetV1";
  const DEFAULTS = Object.freeze([
    Object.freeze({ id: "zone-1", action: "prev", x: 0, y: 0, width: 400, height: 1000 }),
    Object.freeze({ id: "zone-2", action: "center", x: 400, y: 0, width: 200, height: 1000 }),
    Object.freeze({ id: "zone-3", action: "next", x: 600, y: 0, width: 400, height: 1000 }),
  ]);
  const t = (key, fallback, values) => global.ReaderI18n?.t?.(key, values) || fallback;
  let zones = normalize(global.ReaderSettings.get().clickZones);
  let activeId = zones[0].id;
  let popoverId = "";
  let pointerDrag = null;
  let suppressZoneClick = false;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function uniqueZoneId(source, preferred) {
    let suffix = Math.max(1, source.length + 1);
    let id = preferred || `zone-${suffix}`;
    while (source.some((zone) => zone.id === id)) { suffix += 1; id = `zone-${suffix}`; }
    return id;
  }
  function zonesOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }
  function trimZoneAgainst(zone, blocker) {
    if (!zonesOverlap(zone, blocker)) return zone;
    const overlapLeft = Math.max(zone.x, blocker.x), overlapTop = Math.max(zone.y, blocker.y);
    const overlapRight = Math.min(zone.x + zone.width, blocker.x + blocker.width), overlapBottom = Math.min(zone.y + zone.height, blocker.y + blocker.height);
    const candidates = [
      Object.assign({}, zone, { width: overlapLeft - zone.x }),
      Object.assign({}, zone, { x: overlapRight, width: zone.x + zone.width - overlapRight }),
      Object.assign({}, zone, { height: overlapTop - zone.y }),
      Object.assign({}, zone, { y: overlapBottom, height: zone.y + zone.height - overlapBottom }),
    ].filter((candidate) => candidate.width >= 20 && candidate.height >= 20);
    candidates.sort((a, b) => b.width * b.height - a.width * a.height);
    return candidates[0] || null;
  }
  function removeOverlaps(source) {
    const accepted = [];
    source.forEach((zone) => {
      let candidate = zone;
      accepted.forEach((blocker) => { if (candidate) candidate = trimZoneAgainst(candidate, blocker); });
      if (candidate) accepted.push(candidate);
    });
    return accepted;
  }
  function normalize(value) {
    const supplied = Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
    const source = (supplied.length ? supplied : DEFAULTS).slice(0, MAX_ZONES);
    const normalized = [];
    source.forEach((raw, index) => {
      const fallback = DEFAULTS[index] || { id: `zone-${index + 1}`, action: "none", x: 350, y: 350, width: 300, height: 300 };
      const x = clamp(Math.round(Number(raw.x) || 0), 0, 980);
      const y = clamp(Math.round(Number(raw.y) || 0), 0, 980);
      const preferredId = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/i.test(raw.id) ? raw.id : fallback.id;
      normalized.push({
        id: uniqueZoneId(normalized, preferredId),
        action: ACTIONS.includes(raw.action) ? raw.action : fallback.action,
        x,
        y,
        width: clamp(Math.round(Number(raw.width) || fallback.width), 20, 1000 - x),
        height: clamp(Math.round(Number(raw.height) || fallback.height), 20, 1000 - y),
      });
    });
    const separated = removeOverlaps(normalized);
    return separated.length ? separated : DEFAULTS.map((zone) => Object.assign({}, zone));
  }

  function cloneZones(value) { return normalize(value).map((zone) => Object.assign({}, zone)); }
  function presetLabel(index) { return t("clickZonePresetUntitled", `方案 ${index + 1}`, { number: index + 1 }); }
  function normalizedPresetName(value, fallback) { return String(value || "").trim().slice(0, 24) || fallback; }
  function presetId(source, preferred) {
    const known = new Set(source.map((preset) => preset.id));
    if (preferred && !known.has(preferred)) return preferred;
    let index = source.length + 1;
    while (known.has(`preset-${index}`)) index += 1;
    return `preset-${index}`;
  }
  function normalizePresets(value, fallbackZones) {
    const raw = Array.isArray(value) ? value.slice(0, MAX_PRESETS) : [];
    const presets = [];
    raw.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const id = presetId(presets, typeof item.id === "string" && /^preset-[a-z0-9-]{1,36}$/i.test(item.id) ? item.id : "");
      presets.push({ id, name: normalizedPresetName(item.name, presetLabel(index)), zones: cloneZones(item.zones) });
    });
    return presets.length ? presets : [{ id: "preset-1", name: t("clickZonePresetDefault", "默认方案"), zones: cloneZones(fallbackZones) }];
  }
  function loadPresets(fallbackZones) {
    try { return normalizePresets(JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || "[]"), fallbackZones); }
    catch (_) { return normalizePresets([], fallbackZones); }
  }
  function savePresets() {
    try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); localStorage.setItem(ACTIVE_PRESET_STORAGE_KEY, activePresetId); }
    catch (_) {}
  }
  function activePreset() { return presets.find((preset) => preset.id === activePresetId) || presets[0]; }
  function renderPresetControls() {
    const active = activePreset();
    if (!active) return;
    presetSelect.replaceChildren();
    presets.forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      presetSelect.append(option);
    });
    presetSelect.value = active.id;
    presetNameInput.value = active.name;
    presetDeleteButton.disabled = presets.length <= 1;
  }
  function syncActivePreset() {
    const active = activePreset();
    if (!active) return;
    active.zones = cloneZones(zones);
    savePresets();
    renderPresetControls();
  }
  let presets = loadPresets(zones);
  let activePresetId = "";
  try { activePresetId = localStorage.getItem(ACTIVE_PRESET_STORAGE_KEY) || ""; } catch (_) {}
  if (!presets.some((preset) => preset.id === activePresetId)) activePresetId = presets[0].id;

  function actionMeta(action) {
    return {
      prev: { icon: "←", label: t("clickZonePrevious", "上一页") },
      center: { icon: "●", label: t("clickZoneCenter", "切换工具栏与进度") },
      next: { icon: "→", label: t("clickZoneNext", "下一页") },
      none: { icon: "×", label: t("clickZoneNone", "无操作") },
    }[action] || { icon: "×", label: t("clickZoneNone", "无操作") };
  }
  function zoneLabel(index) { return t("clickZoneNumber", `区域 ${index + 1}`, { number: index + 1 }); }
  function activeZone() { return zones.find((zone) => zone.id === activeId) || zones[0]; }
  function replaceZone(id, next) { zones = zones.map((zone) => zone.id === id ? Object.assign({}, zone, next) : zone); }
  function candidateAllowed(candidate, id) { return !zones.some((zone) => zone.id !== id && zonesOverlap(candidate, zone)); }
  function applyCandidate(state, candidate) {
    if (!candidateAllowed(candidate, state.zone.id)) return false;
    const current = zones.find((zone) => zone.id === state.zone.id);
    if (current && current.x === candidate.x && current.y === candidate.y && current.width === candidate.width && current.height === candidate.height) return false;
    replaceZone(state.zone.id, candidate);
    state.lastValid = Object.assign({}, candidate);
    return true;
  }
  function minimumZoneAt(point, id) {
    const candidates = [
      { x: point.x, y: point.y, width: 20, height: 20 },
      { x: point.x - 20, y: point.y, width: 20, height: 20 },
      { x: point.x, y: point.y - 20, width: 20, height: 20 },
      { x: point.x - 20, y: point.y - 20, width: 20, height: 20 },
    ].map((zone) => Object.assign(zone, { x: clamp(zone.x, 0, 980), y: clamp(zone.y, 0, 980) }));
    return candidates.find((candidate) => candidateAllowed(candidate, id)) || null;
  }
  function save() {
    global.ReaderSettings.update({ clickZones: zones.map((zone) => Object.assign({}, zone)) });
    syncActivePreset();
  }

  function createActionPopover(zone, index) {
    const popover = document.createElement("section");
    popover.className = "reader-click-zone-popover";
    popover.dataset.zonePopover = zone.id;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", t("clickZoneChooseAction", "设置区域功能"));
    const anchorX = clamp(zone.x + zone.width / 2, 190, 810);
    const anchorY = clamp(zone.y + zone.height / 2, 190, 810);
    popover.style.left = `${anchorX / 10}%`;
    popover.style.top = `${anchorY / 10}%`;
    popover.addEventListener("pointerdown", (event) => event.stopPropagation());

    const head = document.createElement("div");
    head.className = "reader-click-zone-popover-head";
    const title = document.createElement("strong");
    title.textContent = zoneLabel(index);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "reader-click-zone-popover-close";
    close.textContent = "×";
    close.setAttribute("aria-label", t("close", "关闭"));
    close.addEventListener("click", () => { popoverId = ""; renderCanvas(); });
    head.append(title, close);

    const choices = document.createElement("div");
    choices.className = "reader-click-zone-action-grid";
    ACTIONS.forEach((action) => {
      const meta = actionMeta(action);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `reader-click-zone-action action-${action}${zone.action === action ? " active" : ""}`;
      button.dataset.zoneAction = action;
      button.setAttribute("aria-pressed", String(zone.action === action));
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = meta.icon;
      const label = document.createElement("span");
      label.textContent = meta.label;
      button.append(icon, label);
      button.addEventListener("click", () => {
        replaceZone(zone.id, { action });
        popoverId = "";
        save();
      });
      choices.append(button);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "reader-click-zone-delete";
    remove.disabled = zones.length <= 1;
    remove.textContent = t("clickZoneDelete", "删除此区域");
    remove.addEventListener("click", () => {
      if (zones.length <= 1) return;
      zones = zones.filter((item) => item.id !== zone.id);
      activeId = zones[Math.min(index, zones.length - 1)].id;
      popoverId = "";
      save();
    });
    popover.append(head, choices, remove);
    return popover;
  }

  function renderCanvas() {
    canvas.replaceChildren();
    zones.forEach((zone, index) => {
      const meta = actionMeta(zone.action);
      const element = document.createElement("button");
      element.type = "button";
      element.className = `reader-click-zone action-${zone.action}${zone.id === activeId ? " active" : ""}`;
      element.dataset.zoneId = zone.id;
      element.style.left = `${zone.x / 10}%`;
      element.style.top = `${zone.y / 10}%`;
      element.style.width = `${zone.width / 10}%`;
      element.style.height = `${zone.height / 10}%`;
      element.setAttribute("aria-label", `${zoneLabel(index)}：${meta.label}`);
      const label = document.createElement("span");
      label.className = "reader-click-zone-label";
      const labelIcon = document.createElement("span");
      labelIcon.setAttribute("aria-hidden", "true");
      labelIcon.textContent = meta.icon;
      const labelText = document.createElement("span");
      labelText.textContent = zoneLabel(index);
      label.append(labelIcon, labelText);
      element.append(label);
      ["nw", "ne", "sw", "se"].forEach((handle) => {
        const node = document.createElement("span");
        node.className = `reader-click-zone-handle handle-${handle}`;
        node.dataset.zoneHandle = handle;
        node.setAttribute("aria-hidden", "true");
        element.append(node);
      });
      element.addEventListener("focus", () => {
        activeId = zone.id;
        canvas.querySelectorAll("[data-zone-id]").forEach((node) => node.classList.toggle("active", node.dataset.zoneId === activeId));
      });
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        if (suppressZoneClick) { suppressZoneClick = false; return; }
        activeId = zone.id;
        popoverId = popoverId === zone.id ? "" : zone.id;
        renderCanvas();
      });
      canvas.append(element);
    });
    const popoverZone = zones.find((zone) => zone.id === popoverId);
    if (popoverZone) canvas.append(createActionPopover(popoverZone, zones.indexOf(popoverZone)));
  }

  function render() {
    if (!pointerDrag) zones = normalize(global.ReaderSettings.get().clickZones);
    if (!zones.some((zone) => zone.id === activeId)) activeId = zones[0].id;
    if (!zones.some((zone) => zone.id === popoverId)) popoverId = "";
    renderPresetControls();
    renderCanvas();
  }

  function pointFromEvent(event) {
    const bounds = preview.getBoundingClientRect();
    return {
      x: clamp(Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * 1000), 0, 1000),
      y: clamp(Math.round((event.clientY - bounds.top) / Math.max(1, bounds.height) * 1000), 0, 1000),
    };
  }
  function drawnRectangle(start, point) {
    let left = Math.min(start.x, point.x), top = Math.min(start.y, point.y);
    let right = Math.max(start.x, point.x), bottom = Math.max(start.y, point.y);
    if (right - left < 20) right = Math.min(1000, left + 20);
    if (bottom - top < 20) bottom = Math.min(1000, top + 20);
    if (right - left < 20) left = Math.max(0, right - 20);
    if (bottom - top < 20) top = Math.max(0, bottom - 20);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function resizedRectangle(zone, handle, point) {
    let left = zone.x, top = zone.y, right = zone.x + zone.width, bottom = zone.y + zone.height;
    if (handle.includes("w")) left = clamp(point.x, 0, right - 20);
    if (handle.includes("e")) right = clamp(point.x, left + 20, 1000);
    if (handle.includes("n")) top = clamp(point.y, 0, bottom - 20);
    if (handle.includes("s")) bottom = clamp(point.y, top + 20, 1000);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function startPointerDrag(event) {
    if (event.button !== 0 || pointerDrag || event.target.closest?.("[data-zone-popover]")) return;
    const target = event.target.closest?.("[data-zone-id]");
    if (!target && zones.length >= MAX_ZONES) { popoverId = ""; renderCanvas(); return; }
    event.preventDefault();
    if (target) activeId = target.dataset.zoneId;
    const handle = event.target.closest?.("[data-zone-handle]")?.dataset.zoneHandle || "";
    const mode = handle ? "resize" : target ? "move" : "create";
    const start = pointFromEvent(event);
    const previousActiveId = activeId;
    let zone = activeZone();
    if (mode === "create") {
      const id = uniqueZoneId(zones);
      const rectangle = minimumZoneAt(start, id);
      if (!rectangle) { popoverId = ""; renderCanvas(); return; }
      zone = Object.assign({ id, action: "none" }, rectangle);
      zones = zones.concat(zone);
      activeId = zone.id;
    }
    pointerDrag = { pointerId: event.pointerId, mode, handle, start, zone: Object.assign({}, zone), lastValid: Object.assign({}, zone), moved: false, changed: false, previousActiveId };
    popoverId = "";
    preview.classList.add("drawing");
    try { preview.setPointerCapture(event.pointerId); } catch (_) {}
    renderCanvas();
  }
  function movePointerDrag(event) {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (Math.abs(point.x - state.start.x) + Math.abs(point.y - state.start.y) > 5) state.moved = true;
    if (!state.moved) return;
    let changed = false;
    if (state.mode === "create") changed = applyCandidate(state, drawnRectangle(state.start, point));
    else if (state.mode === "resize") changed = applyCandidate(state, resizedRectangle(state.zone, state.handle, point));
    else changed = applyCandidate(state, {
      x: clamp(state.zone.x + point.x - state.start.x, 0, 1000 - state.zone.width),
      y: clamp(state.zone.y + point.y - state.start.y, 0, 1000 - state.zone.height),
      width: state.zone.width,
      height: state.zone.height,
    });
    if (changed) state.changed = true;
    renderCanvas();
  }
  function finishPointerDrag(event) {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const state = pointerDrag;
    const openOnRelease = !state.moved && state.mode === "move";
    suppressZoneClick = state.moved || openOnRelease;
    if (suppressZoneClick) global.setTimeout(() => { suppressZoneClick = false; }, 0);
    try { preview.releasePointerCapture(event.pointerId); } catch (_) {}
    pointerDrag = null;
    preview.classList.remove("drawing");
    if (!state.moved && state.mode === "create") {
      zones = zones.filter((zone) => zone.id !== state.zone.id);
      activeId = zones.some((zone) => zone.id === state.previousActiveId) ? state.previousActiveId : zones[0]?.id || "";
      renderCanvas();
    } else if (state.changed) save();
    else if (openOnRelease) {
      activeId = state.zone.id;
      popoverId = popoverId === state.zone.id ? "" : state.zone.id;
      renderCanvas();
    } else renderCanvas();
  }

  preview.tabIndex = 0;
  preview.addEventListener("pointerdown", startPointerDrag);
  preview.addEventListener("pointermove", movePointerDrag);
  preview.addEventListener("pointerup", finishPointerDrag);
  preview.addEventListener("pointercancel", finishPointerDrag);
  resetButton.addEventListener("click", () => {
    zones = DEFAULTS.map((zone) => Object.assign({}, zone));
    activeId = zones[0].id;
    popoverId = "";
    save();
  });
  presetSelect.addEventListener("change", () => {
    const next = presets.find((preset) => preset.id === presetSelect.value);
    if (!next) return;
    activePresetId = next.id;
    zones = cloneZones(next.zones);
    activeId = zones[0].id;
    popoverId = "";
    savePresets();
    global.ReaderSettings.update({ clickZones: cloneZones(zones) });
    render();
  });
  presetNewButton.addEventListener("click", () => {
    if (presets.length >= MAX_PRESETS) return;
    const created = { id: presetId(presets), name: presetLabel(presets.length), zones: cloneZones(zones) };
    presets = presets.concat(created);
    activePresetId = created.id;
    savePresets();
    renderPresetControls();
  });
  const savePreset = () => {
    const active = activePreset();
    if (!active) return;
    active.name = normalizedPresetName(presetNameInput.value, presetLabel(presets.indexOf(active)));
    active.zones = cloneZones(zones);
    savePresets();
    renderPresetControls();
  };
  presetSaveButton.addEventListener("click", savePreset);
  presetNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); savePreset(); }
  });
  presetDeleteButton.addEventListener("click", () => {
    if (presets.length <= 1) return;
    const index = Math.max(0, presets.findIndex((preset) => preset.id === activePresetId));
    presets = presets.filter((preset) => preset.id !== activePresetId);
    const next = presets[Math.min(index, presets.length - 1)];
    activePresetId = next.id;
    zones = cloneZones(next.zones);
    activeId = zones[0].id;
    popoverId = "";
    savePresets();
    global.ReaderSettings.update({ clickZones: cloneZones(zones) });
    render();
  });
  global.addEventListener("reader-settings-changed", render);
  global.addEventListener("reader-language-changed", render);
  global.ReaderClickZones = Object.freeze({ normalize, defaults: () => DEFAULTS.map((zone) => Object.assign({}, zone)) });
  render();
})(window);
