export type ReaderClickZoneAction = "prev" | "center" | "next" | "none";

export interface ReaderClickZone {
  readonly id: string;
  readonly action: ReaderClickZoneAction;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface MutableReaderClickZone {
  id: string;
  action: ReaderClickZoneAction;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReaderClickZonePreset {
  id: string;
  name: string;
  zones: MutableReaderClickZone[];
}

interface ReaderSettingsApi {
  get(): { readonly clickZones?: unknown };
  update(settings: { readonly clickZones: readonly ReaderClickZone[] }): void;
}

interface ReaderClickZoneRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly localStorage?: Storage;
  readonly ReaderSettings?: ReaderSettingsApi;
  readonly ReaderI18n?: {
    t?(key: string, values?: Readonly<Record<string, unknown>>): string;
  };
  ReaderClickZones?: ReaderClickZonesApi;
  addEventListener: Window["addEventListener"];
  setTimeout: typeof globalThis.setTimeout;
}

export interface ReaderClickZonesApi {
  readonly normalize: (value: unknown) => MutableReaderClickZone[];
  readonly defaults: () => MutableReaderClickZone[];
}

type DragMode = "resize" | "move" | "create";
type ResizeHandle = "nw" | "ne" | "sw" | "se" | "";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly mode: DragMode;
  readonly handle: ResizeHandle;
  readonly start: Point;
  readonly zone: MutableReaderClickZone;
  lastValid: MutableReaderClickZone;
  moved: boolean;
  changed: boolean;
  readonly previousActiveId: string;
}

const ACTIONS = Object.freeze<readonly ReaderClickZoneAction[]>(["prev", "center", "next", "none"]);
const MAX_ZONES = 12;
const MAX_PRESETS = 12;
const PRESET_STORAGE_KEY = "readerClickZonePresetsV1";
const ACTIVE_PRESET_STORAGE_KEY = "readerClickZoneActivePresetV1";
const DEFAULTS = Object.freeze<readonly Readonly<ReaderClickZone>[]>([
  Object.freeze({ id: "zone-1", action: "prev", x: 0, y: 0, width: 400, height: 1000 }),
  Object.freeze({ id: "zone-2", action: "center", x: 400, y: 0, width: 200, height: 1000 }),
  Object.freeze({ id: "zone-3", action: "next", x: 600, y: 0, width: 400, height: 1000 }),
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function cloneZone(zone: Readonly<ReaderClickZone>): MutableReaderClickZone {
  return { ...zone };
}

function uniqueZoneId(source: readonly ReaderClickZone[], preferred = ""): string {
  let suffix = Math.max(1, source.length + 1);
  let id = preferred || `zone-${suffix}`;
  while (source.some((zone) => zone.id === id)) {
    suffix += 1;
    id = `zone-${suffix}`;
  }
  return id;
}

function zonesOverlap(a: ReaderClickZone, b: ReaderClickZone): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function trimZoneAgainst(
  zone: MutableReaderClickZone,
  blocker: ReaderClickZone,
): MutableReaderClickZone | null {
  if (!zonesOverlap(zone, blocker)) return zone;
  const overlapLeft = Math.max(zone.x, blocker.x);
  const overlapTop = Math.max(zone.y, blocker.y);
  const overlapRight = Math.min(zone.x + zone.width, blocker.x + blocker.width);
  const overlapBottom = Math.min(zone.y + zone.height, blocker.y + blocker.height);
  const candidates = [
    { ...zone, width: overlapLeft - zone.x },
    { ...zone, x: overlapRight, width: zone.x + zone.width - overlapRight },
    { ...zone, height: overlapTop - zone.y },
    { ...zone, y: overlapBottom, height: zone.y + zone.height - overlapBottom },
  ].filter((candidate) => candidate.width >= 20 && candidate.height >= 20);
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0] ?? null;
}

function removeOverlaps(source: readonly MutableReaderClickZone[]): MutableReaderClickZone[] {
  const accepted: MutableReaderClickZone[] = [];
  source.forEach((zone) => {
    let candidate: MutableReaderClickZone | null = zone;
    accepted.forEach((blocker) => {
      if (candidate) candidate = trimZoneAgainst(candidate, blocker);
    });
    if (candidate) accepted.push(candidate);
  });
  return accepted;
}

export function normalizeReaderClickZones(value: unknown): MutableReaderClickZone[] {
  const supplied = Array.isArray(value)
    ? value.filter((item) => typeof item === "object" && item !== null)
    : [];
  const source: unknown[] = (supplied.length ? supplied : [...DEFAULTS]).slice(0, MAX_ZONES);
  const normalized: MutableReaderClickZone[] = [];
  source.forEach((rawValue, index) => {
    const raw = record(rawValue);
    const fallback = DEFAULTS[index] ?? {
      id: `zone-${index + 1}`, action: "none", x: 350, y: 350, width: 300, height: 300,
    };
    const x = clamp(Math.round(Number(raw.x) || 0), 0, 980);
    const y = clamp(Math.round(Number(raw.y) || 0), 0, 980);
    const preferredId = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/i.test(raw.id)
      ? raw.id
      : fallback.id;
    normalized.push({
      id: uniqueZoneId(normalized, preferredId),
      action: ACTIONS.includes(raw.action as ReaderClickZoneAction)
        ? raw.action as ReaderClickZoneAction
        : fallback.action,
      x,
      y,
      width: clamp(Math.round(Number(raw.width) || fallback.width), 20, 1000 - x),
      height: clamp(Math.round(Number(raw.height) || fallback.height), 20, 1000 - y),
    });
  });
  const separated = removeOverlaps(normalized);
  return separated.length ? separated : DEFAULTS.map(cloneZone);
}

function elementById<T extends HTMLElement>(document: Document, id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function installReaderClickZones(global: ReaderClickZoneRuntime): ReaderClickZonesApi | null {
  const documentCandidate = global.document;
  const settingsCandidate = global.ReaderSettings;
  if (!documentCandidate || !settingsCandidate) return null;
  const previewCandidate = elementById<HTMLElement>(documentCandidate, "reader-click-zone-preview");
  const canvasCandidate = elementById<HTMLElement>(documentCandidate, "reader-click-zone-canvas");
  const resetButtonCandidate = elementById<HTMLButtonElement>(documentCandidate, "reader-click-zone-reset");
  const presetSelectCandidate = elementById<HTMLSelectElement>(documentCandidate, "reader-click-zone-preset");
  const presetNameInputCandidate = elementById<HTMLInputElement>(documentCandidate, "reader-click-zone-preset-name");
  const presetNewButtonCandidate = elementById<HTMLButtonElement>(documentCandidate, "reader-click-zone-preset-new");
  const presetSaveButtonCandidate = elementById<HTMLButtonElement>(documentCandidate, "reader-click-zone-preset-save");
  const presetDeleteButtonCandidate = elementById<HTMLButtonElement>(documentCandidate, "reader-click-zone-preset-delete");
  if (!previewCandidate || !canvasCandidate || !resetButtonCandidate || !presetSelectCandidate ||
      !presetNameInputCandidate || !presetNewButtonCandidate || !presetSaveButtonCandidate ||
      !presetDeleteButtonCandidate) return null;
  const document: Document = documentCandidate;
  const settings: ReaderSettingsApi = settingsCandidate;
  const preview: HTMLElement = previewCandidate;
  const canvas: HTMLElement = canvasCandidate;
  const resetButton: HTMLButtonElement = resetButtonCandidate;
  const presetSelect: HTMLSelectElement = presetSelectCandidate;
  const presetNameInput: HTMLInputElement = presetNameInputCandidate;
  const presetNewButton: HTMLButtonElement = presetNewButtonCandidate;
  const presetSaveButton: HTMLButtonElement = presetSaveButtonCandidate;
  const presetDeleteButton: HTMLButtonElement = presetDeleteButtonCandidate;

  const localStorage = global.localStorage;
  const t = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ): string => global.ReaderI18n?.t?.(key, values) || fallback;
  const normalize = normalizeReaderClickZones;
  const cloneZones = (value: unknown): MutableReaderClickZone[] => normalize(value).map(cloneZone);
  let zones = normalize(settings.get().clickZones);
  let activeId = zones[0]?.id ?? "";
  let popoverId = "";
  let pointerDrag: PointerDrag | null = null;
  let suppressZoneClick = false;

  const presetLabel = (index: number): string =>
    t("clickZonePresetUntitled", `方案 ${index + 1}`, { number: index + 1 });
  const normalizedPresetName = (value: unknown, fallback: string): string =>
    String(value || "").trim().slice(0, 24) || fallback;
  function presetId(source: readonly ReaderClickZonePreset[], preferred = ""): string {
    const known = new Set(source.map((preset) => preset.id));
    if (preferred && !known.has(preferred)) return preferred;
    let index = source.length + 1;
    while (known.has(`preset-${index}`)) index += 1;
    return `preset-${index}`;
  }
  function normalizePresets(value: unknown, fallbackZones: unknown): ReaderClickZonePreset[] {
    const raw: unknown[] = Array.isArray(value) ? value.slice(0, MAX_PRESETS) : [];
    const result: ReaderClickZonePreset[] = [];
    raw.forEach((itemValue, index) => {
      if (typeof itemValue !== "object" || itemValue === null) return;
      const item = record(itemValue);
      const preferred = typeof item.id === "string" && /^preset-[a-z0-9-]{1,36}$/i.test(item.id)
        ? item.id
        : "";
      result.push({
        id: presetId(result, preferred),
        name: normalizedPresetName(item.name, presetLabel(index)),
        zones: cloneZones(item.zones),
      });
    });
    return result.length ? result : [{
      id: "preset-1",
      name: t("clickZonePresetDefault", "默认方案"),
      zones: cloneZones(fallbackZones),
    }];
  }
  function loadPresets(fallbackZones: unknown): ReaderClickZonePreset[] {
    try {
      return normalizePresets(JSON.parse(localStorage?.getItem(PRESET_STORAGE_KEY) || "[]"), fallbackZones);
    } catch {
      return normalizePresets([], fallbackZones);
    }
  }

  let presets = loadPresets(zones);
  let activePresetId = "";
  try { activePresetId = localStorage?.getItem(ACTIVE_PRESET_STORAGE_KEY) || ""; } catch { /* preserve storage denial fallback */ }
  if (!presets.some((preset) => preset.id === activePresetId)) activePresetId = presets[0]?.id ?? "";

  function savePresets(): void {
    try {
      localStorage?.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
      localStorage?.setItem(ACTIVE_PRESET_STORAGE_KEY, activePresetId);
    } catch { /* storage failures were intentionally silent in the classic implementation */ }
  }
  function activePreset(): ReaderClickZonePreset | undefined {
    return presets.find((preset) => preset.id === activePresetId) ?? presets[0];
  }
  function renderPresetControls(): void {
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
  function syncActivePreset(): void {
    const active = activePreset();
    if (!active) return;
    active.zones = cloneZones(zones);
    savePresets();
    renderPresetControls();
  }

  function actionMeta(action: ReaderClickZoneAction): { readonly icon: string; readonly label: string } {
    return {
      prev: { icon: "←", label: t("clickZonePrevious", "上一页") },
      center: { icon: "●", label: t("clickZoneCenter", "切换工具栏与进度") },
      next: { icon: "→", label: t("clickZoneNext", "下一页") },
      none: { icon: "×", label: t("clickZoneNone", "无操作") },
    }[action];
  }
  const zoneLabel = (index: number): string =>
    t("clickZoneNumber", `区域 ${index + 1}`, { number: index + 1 });
  function activeZone(): MutableReaderClickZone | undefined {
    return zones.find((zone) => zone.id === activeId) ?? zones[0];
  }
  function replaceZone(id: string, next: Partial<MutableReaderClickZone>): void {
    zones = zones.map((zone) => zone.id === id ? { ...zone, ...next } : zone);
  }
  function candidateAllowed(candidate: ReaderClickZone, id: string): boolean {
    return !zones.some((zone) => zone.id !== id && zonesOverlap(candidate, zone));
  }
  function applyCandidate(state: PointerDrag, candidate: MutableReaderClickZone): boolean {
    if (!candidateAllowed(candidate, state.zone.id)) return false;
    const current = zones.find((zone) => zone.id === state.zone.id);
    if (current && current.x === candidate.x && current.y === candidate.y &&
        current.width === candidate.width && current.height === candidate.height) return false;
    replaceZone(state.zone.id, candidate);
    state.lastValid = cloneZone(candidate);
    return true;
  }
  function minimumZoneAt(point: Point, id: string): MutableReaderClickZone | null {
    const candidates = [
      { x: point.x, y: point.y, width: 20, height: 20 },
      { x: point.x - 20, y: point.y, width: 20, height: 20 },
      { x: point.x, y: point.y - 20, width: 20, height: 20 },
      { x: point.x - 20, y: point.y - 20, width: 20, height: 20 },
    ].map((zone) => ({ id, action: "none" as const, ...zone,
      x: clamp(zone.x, 0, 980), y: clamp(zone.y, 0, 980) }));
    return candidates.find((candidate) => candidateAllowed(candidate, id)) ?? null;
  }
  function save(): void {
    settings.update({ clickZones: zones.map(cloneZone) });
    syncActivePreset();
  }

  function createActionPopover(zone: MutableReaderClickZone, index: number): HTMLElement {
    const popover = document.createElement("section");
    popover.className = "reader-click-zone-popover";
    popover.dataset.zonePopover = zone.id;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", t("clickZoneChooseAction", "设置区域功能"));
    popover.style.left = `${clamp(zone.x + zone.width / 2, 190, 810) / 10}%`;
    popover.style.top = `${clamp(zone.y + zone.height / 2, 190, 810) / 10}%`;
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
      activeId = zones[Math.min(index, zones.length - 1)]?.id ?? "";
      popoverId = "";
      save();
    });
    popover.append(head, choices, remove);
    return popover;
  }

  function renderCanvas(): void {
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
      (["nw", "ne", "sw", "se"] as const).forEach((handle) => {
        const node = document.createElement("span");
        node.className = `reader-click-zone-handle handle-${handle}`;
        node.dataset.zoneHandle = handle;
        node.setAttribute("aria-hidden", "true");
        element.append(node);
      });
      element.addEventListener("focus", () => {
        activeId = zone.id;
        canvas.querySelectorAll<HTMLElement>("[data-zone-id]").forEach((node) =>
          node.classList.toggle("active", node.dataset.zoneId === activeId));
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

  function render(): void {
    if (!pointerDrag) zones = normalize(settings.get().clickZones);
    if (!zones.some((zone) => zone.id === activeId)) activeId = zones[0]?.id ?? "";
    if (!zones.some((zone) => zone.id === popoverId)) popoverId = "";
    renderPresetControls();
    renderCanvas();
  }

  function pointFromEvent(event: PointerEvent): Point {
    const bounds = preview.getBoundingClientRect();
    return {
      x: clamp(Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * 1000), 0, 1000),
      y: clamp(Math.round((event.clientY - bounds.top) / Math.max(1, bounds.height) * 1000), 0, 1000),
    };
  }
  function drawnRectangle(start: Point, point: Point): Omit<MutableReaderClickZone, "id" | "action"> {
    let left = Math.min(start.x, point.x);
    let top = Math.min(start.y, point.y);
    let right = Math.max(start.x, point.x);
    let bottom = Math.max(start.y, point.y);
    if (right - left < 20) right = Math.min(1000, left + 20);
    if (bottom - top < 20) bottom = Math.min(1000, top + 20);
    if (right - left < 20) left = Math.max(0, right - 20);
    if (bottom - top < 20) top = Math.max(0, bottom - 20);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function resizedRectangle(
    zone: MutableReaderClickZone,
    handle: ResizeHandle,
    point: Point,
  ): MutableReaderClickZone {
    let left = zone.x;
    let top = zone.y;
    let right = zone.x + zone.width;
    let bottom = zone.y + zone.height;
    if (handle.includes("w")) left = clamp(point.x, 0, right - 20);
    if (handle.includes("e")) right = clamp(point.x, left + 20, 1000);
    if (handle.includes("n")) top = clamp(point.y, 0, bottom - 20);
    if (handle.includes("s")) bottom = clamp(point.y, top + 20, 1000);
    return { ...zone, x: left, y: top, width: right - left, height: bottom - top };
  }

  function startPointerDrag(event: PointerEvent): void {
    const eventTarget = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || pointerDrag || eventTarget?.closest("[data-zone-popover]")) return;
    const target = eventTarget?.closest<HTMLElement>("[data-zone-id]") ?? null;
    if (!target && zones.length >= MAX_ZONES) { popoverId = ""; renderCanvas(); return; }
    event.preventDefault();
    if (target?.dataset.zoneId) activeId = target.dataset.zoneId;
    const rawHandle = eventTarget?.closest<HTMLElement>("[data-zone-handle]")?.dataset.zoneHandle ?? "";
    const handle: ResizeHandle = rawHandle === "nw" || rawHandle === "ne" ||
      rawHandle === "sw" || rawHandle === "se" ? rawHandle : "";
    const mode: DragMode = handle ? "resize" : target ? "move" : "create";
    const start = pointFromEvent(event);
    const previousActiveId = activeId;
    let zone = activeZone();
    if (mode === "create") {
      const id = uniqueZoneId(zones);
      const rectangle = minimumZoneAt(start, id);
      if (!rectangle) { popoverId = ""; renderCanvas(); return; }
      zone = rectangle;
      zones = zones.concat(zone);
      activeId = zone.id;
    }
    if (!zone) return;
    pointerDrag = {
      pointerId: event.pointerId, mode, handle, start,
      zone: cloneZone(zone), lastValid: cloneZone(zone), moved: false, changed: false, previousActiveId,
    };
    popoverId = "";
    preview.classList.add("drawing");
    try { preview.setPointerCapture(event.pointerId); } catch { /* unsupported in some WebViews */ }
    renderCanvas();
  }
  function movePointerDrag(event: PointerEvent): void {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (Math.abs(point.x - state.start.x) + Math.abs(point.y - state.start.y) > 5) state.moved = true;
    if (!state.moved) return;
    let changed: boolean;
    if (state.mode === "create") {
      changed = applyCandidate(state, { ...state.zone, ...drawnRectangle(state.start, point) });
    } else if (state.mode === "resize") {
      changed = applyCandidate(state, resizedRectangle(state.zone, state.handle, point));
    } else {
      changed = applyCandidate(state, {
        ...state.zone,
        x: clamp(state.zone.x + point.x - state.start.x, 0, 1000 - state.zone.width),
        y: clamp(state.zone.y + point.y - state.start.y, 0, 1000 - state.zone.height),
      });
    }
    if (changed) state.changed = true;
    renderCanvas();
  }
  function finishPointerDrag(event: PointerEvent): void {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const state = pointerDrag;
    const openOnRelease = !state.moved && state.mode === "move";
    suppressZoneClick = state.moved || openOnRelease;
    if (suppressZoneClick) global.setTimeout(() => { suppressZoneClick = false; }, 0);
    try { preview.releasePointerCapture(event.pointerId); } catch { /* unsupported in some WebViews */ }
    pointerDrag = null;
    preview.classList.remove("drawing");
    if (!state.moved && state.mode === "create") {
      zones = zones.filter((zone) => zone.id !== state.zone.id);
      activeId = zones.some((zone) => zone.id === state.previousActiveId)
        ? state.previousActiveId
        : zones[0]?.id ?? "";
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
    zones = DEFAULTS.map(cloneZone);
    activeId = zones[0]?.id ?? "";
    popoverId = "";
    save();
  });
  presetSelect.addEventListener("change", () => {
    const next = presets.find((preset) => preset.id === presetSelect.value);
    if (!next) return;
    activePresetId = next.id;
    zones = cloneZones(next.zones);
    activeId = zones[0]?.id ?? "";
    popoverId = "";
    savePresets();
    settings.update({ clickZones: cloneZones(zones) });
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
  const savePreset = (): void => {
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
    if (!next) return;
    activePresetId = next.id;
    zones = cloneZones(next.zones);
    activeId = zones[0]?.id ?? "";
    popoverId = "";
    savePresets();
    settings.update({ clickZones: cloneZones(zones) });
    render();
  });
  global.addEventListener("reader-settings-changed", render);
  global.addEventListener("reader-language-changed", render);
  const api = Object.freeze<ReaderClickZonesApi>({
    normalize,
    defaults: () => DEFAULTS.map(cloneZone),
  });
  global.ReaderClickZones = api;
  render();
  return api;
}
