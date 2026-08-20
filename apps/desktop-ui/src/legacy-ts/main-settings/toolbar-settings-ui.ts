import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

export const TOOLBAR_ITEM_IDS = Object.freeze([
  "account",
  "search",
  "stats",
  "library",
  "news",
  "filter",
  "settings",
  "menu",
] as const);
export const TOOLBAR_CONTENT_IDS = Object.freeze(["icon", "text"] as const);

export type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number];
export type ToolbarContentId = (typeof TOOLBAR_CONTENT_IDS)[number];

export interface ToolbarSettings {
  toolbarIconSizePx: number;
  toolbarItemOrder: ToolbarItemId[];
  toolbarHiddenItems: ToolbarItemId[];
  toolbarContentOrder: ToolbarContentId[];
  toolbarContentVisible: ToolbarContentId[];
}

interface AppSettingsSnapshot extends Partial<ToolbarSettings> {
  readonly hasToolbarSettings?: unknown;
}

type ToolbarSettingsCommands = {
  app_settings_sync_get: { readonly result: AppSettingsSnapshot };
  app_settings_sync_save: {
    readonly args: { readonly request: ToolbarSettings };
    readonly result: AppSettingsSnapshot;
  };
};

type ToolbarSettingsEvents = {
  "app-settings-synced": unknown;
};

type VerifiedToolbarSettingsCommands =
  ToolbarSettingsCommands extends TauriCommandMap
    ? ToolbarSettingsCommands
    : never;

export interface ToolbarSettingsInitOptions {
  readonly invoke?: TauriTransport["invoke"];
  readonly transport?: TauriTransport;
}

interface ToolbarSettingsInit {
  (options?: ToolbarSettingsInitOptions): void;
  ready?: boolean;
}

export interface ToolbarSettingsGlobalApi {
  init: ToolbarSettingsInit;
  get(): ToolbarSettings;
  apply(animate?: boolean): void;
  normalize(raw: unknown): ToolbarSettings;
}

interface ToolbarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface MediaQueryLike {
  readonly matches: boolean;
}

interface ToolbarSettingsRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage?: ToolbarStorage;
  matchMedia?(query: string): MediaQueryLike;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  setTimeout(handler: TimerHandler, timeout?: number): number;
  clearTimeout(handle?: number): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  ReaderToolbarSettingsUI?: ToolbarSettingsGlobalApi;
}

interface PointerDragState {
  readonly item: HTMLElement;
  readonly placeholder: HTMLElement;
  readonly capture: HTMLElement;
  readonly pointerId: number;
  readonly offsetY: number;
  readonly startY: number;
  moved: boolean;
}

interface ContentDragState {
  readonly item: HTMLElement;
  readonly placeholder: HTMLElement;
  readonly capture: HTMLElement;
  readonly pointerId: number;
  readonly offsetX: number;
  readonly startX: number;
  moved: boolean;
}

const DEFAULT_SIZE = 36;
const STORAGE_KEY = "mainToolbarSettingsV1";
export const DEFAULT_TOOLBAR_SETTINGS: Readonly<ToolbarSettings> = Object.freeze<ToolbarSettings>({
  toolbarIconSizePx: DEFAULT_SIZE,
  toolbarItemOrder: TOOLBAR_ITEM_IDS.slice(),
  toolbarHiddenItems: [],
  toolbarContentOrder: TOOLBAR_CONTENT_IDS.slice(),
  toolbarContentVisible: ["icon"],
});

const ITEM_COPY: Readonly<Record<ToolbarItemId, readonly [string, string]>> =
  Object.freeze({
    account: ["账户", "登录、同步与账户管理"],
    search: ["搜索", "搜索书架和全文"],
    stats: ["阅读统计", "打开阅读数据统计"],
    library: ["书库问答", "在全书库中提问"],
    news: ["资讯", "启用资讯功能后显示"],
    filter: ["筛选与布局", "排序、过滤和书架布局"],
    settings: ["设置", "始终显示，不能隐藏"],
    menu: ["更多菜单", "导入、笔记和关于等功能"],
  });

const BUTTON_IDS: Readonly<Record<ToolbarItemId, string>> = Object.freeze({
  account: "account-btn",
  search: "search-btn",
  stats: "stats-toolbar-btn",
  library: "library-ai-toolbar-btn",
  news: "newsnow-toolbar-btn",
  filter: "filter-btn",
  settings: "settings-toolbar-btn",
  menu: "menu-btn",
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ToolbarSettingsRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as ToolbarSettingsRuntime;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isToolbarItemId(value: unknown): value is ToolbarItemId {
  return typeof value === "string" && TOOLBAR_ITEM_IDS.includes(value as ToolbarItemId);
}

function isToolbarContentId(value: unknown): value is ToolbarContentId {
  return (
    typeof value === "string" &&
    TOOLBAR_CONTENT_IDS.includes(value as ToolbarContentId)
  );
}

function normalizeOrder(value: unknown): ToolbarItemId[] {
  const seen = new Set<ToolbarItemId>();
  const ordered = Array.isArray(value)
    ? value.filter(
        (id): id is ToolbarItemId =>
          isToolbarItemId(id) && !seen.has(id) && Boolean(seen.add(id)),
      )
    : [];
  if (!seen.has("account")) {
    ordered.unshift("account");
    seen.add("account");
  }
  TOOLBAR_ITEM_IDS.forEach((id) => {
    if (!seen.has(id)) ordered.push(id);
  });
  return ordered;
}

function normalizeHidden(value: unknown): ToolbarItemId[] {
  const seen = new Set<ToolbarItemId>();
  return Array.isArray(value)
    ? value.filter(
        (id): id is ToolbarItemId =>
          id !== "settings" &&
          isToolbarItemId(id) &&
          !seen.has(id) &&
          Boolean(seen.add(id)),
      )
    : [];
}

function normalizeContentOrder(value: unknown): ToolbarContentId[] {
  const seen = new Set<ToolbarContentId>();
  const ordered = Array.isArray(value)
    ? value.filter(
        (id): id is ToolbarContentId =>
          isToolbarContentId(id) && !seen.has(id) && Boolean(seen.add(id)),
      )
    : [];
  TOOLBAR_CONTENT_IDS.forEach((id) => {
    if (!seen.has(id)) ordered.push(id);
  });
  return ordered;
}

function normalizeContentVisible(value: unknown): ToolbarContentId[] {
  const seen = new Set<ToolbarContentId>();
  const visible = Array.isArray(value)
    ? value.filter(
        (id): id is ToolbarContentId =>
          isToolbarContentId(id) && !seen.has(id) && Boolean(seen.add(id)),
      )
    : [];
  return visible.length ? visible : ["icon"];
}

export function normalizeToolbarSettings(raw: unknown): ToolbarSettings {
  const source = record(raw) ?? {};
  return {
    toolbarIconSizePx: Math.max(
      28,
      Math.min(52, Number(source.toolbarIconSizePx) || DEFAULT_SIZE),
    ),
    toolbarItemOrder: normalizeOrder(source.toolbarItemOrder),
    toolbarHiddenItems: normalizeHidden(source.toolbarHiddenItems),
    toolbarContentOrder: normalizeContentOrder(source.toolbarContentOrder),
    toolbarContentVisible: normalizeContentVisible(source.toolbarContentVisible),
  };
}

function errorText(error: unknown): string {
  const value = record(error);
  return value?.message ? String(value.message) : String(error);
}

function toolbarItemId(element: HTMLElement): ToolbarItemId | null {
  const value = element.dataset.toolbarItem;
  return isToolbarItemId(value) ? value : null;
}

export function createToolbarSettingsGlobal(
  runtime: ToolbarSettingsRuntime,
  defaultTransport?: TauriTransport,
): ToolbarSettingsGlobalApi {
  const document = runtime.document;
  const root = document.getElementById("toolbar-actions") as HTMLElement | null;
  const leading = document.getElementById(
    "toolbar-leading-action",
  ) as HTMLElement | null;
  const list = document.getElementById("toolbar-settings-list") as HTMLElement | null;
  const contentList = document.getElementById(
    "toolbar-content-list",
  ) as HTMLElement | null;
  const sizeInput = document.getElementById(
    "toolbar-icon-size",
  ) as HTMLInputElement | null;
  const sizeOutput = document.getElementById(
    "toolbar-icon-size-value",
  ) as HTMLElement | null;
  const resetButton = document.getElementById(
    "toolbar-reset-layout",
  ) as HTMLElement | null;
  const status = document.getElementById(
    "toolbar-settings-status",
  ) as HTMLElement | null;

  let transport: TauriTransport | undefined;
  let settings = clone(DEFAULT_TOOLBAR_SETTINGS) as ToolbarSettings;
  let saveTimer = 0;
  let dragState: PointerDragState | null = null;
  let contentDragState: ContentDragState | null = null;

  const readCached = (): ToolbarSettings => {
    try {
      return normalizeToolbarSettings(
        JSON.parse(runtime.localStorage?.getItem(STORAGE_KEY) || "null") as unknown,
      );
    } catch {
      return clone(DEFAULT_TOOLBAR_SETTINGS) as ToolbarSettings;
    }
  };

  const cache = (): void => {
    try {
      runtime.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage may be unavailable in a restricted WebView.
    }
  };

  const setStatus = (message?: string): void => {
    if (status) status.textContent = message || "";
  };

  const toolbarItems = (): HTMLElement[] => {
    if (!root) return [];
    const items = [
      ...Array.from(
        leading?.querySelectorAll<HTMLElement>(
          ":scope > [data-toolbar-item]",
        ) || [],
      ),
      ...Array.from(
        root.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item]"),
      ),
    ];
    const account = document.querySelector<HTMLElement>(
      '.account-wrap[data-toolbar-item="account"]',
    );
    return account && !items.includes(account) ? [account, ...items] : items;
  };

  const toolbarButton = (id: ToolbarItemId): HTMLElement | null =>
    document.getElementById(BUTTON_IDS[id]) as HTMLElement | null;

  const toolbarLabel = (id: ToolbarItemId, button: HTMLElement): string =>
    button.getAttribute("title") ||
    button.getAttribute("aria-label") ||
    ITEM_COPY[id][0] ||
    id;

  const ensureToolbarButtonContent = (id: ToolbarItemId): void => {
    const button = toolbarButton(id);
    if (!button) return;
    let icon = button.querySelector<HTMLElement>(":scope > .toolbar-item-icon");
    let text = button.querySelector<HTMLElement>(":scope > .toolbar-item-text");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = "toolbar-item-icon";
      Array.from(button.childNodes).forEach((node) => icon?.appendChild(node));
      button.appendChild(icon);
    }
    if (!text) {
      text = document.createElement("span");
      text.className = "toolbar-item-text";
      button.appendChild(text);
    }
    text.textContent = toolbarLabel(id, button);
    const parts: Record<ToolbarContentId, HTMLElement> = { icon, text };
    settings.toolbarContentOrder.forEach((part) => button.appendChild(parts[part]));
    const visible = new Set(settings.toolbarContentVisible);
    TOOLBAR_CONTENT_IDS.forEach((part) =>
      parts[part].classList.toggle(
        "toolbar-content-hidden",
        !visible.has(part),
      ),
    );
    button.classList.add("toolbar-content-button");
    button.classList.toggle("toolbar-content-has-text", visible.has("text"));
    button.classList.toggle("toolbar-content-has-icon", visible.has("icon"));
  };

  const animateReflow = (before: Map<HTMLElement, DOMRect>): void => {
    if (!runtime.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      toolbarItems().forEach((item) => {
        const from = before.get(item);
        const to = item.getBoundingClientRect();
        if (!from) return;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (dx || dy) {
          item.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 190, easing: "cubic-bezier(.2,.8,.25,1)" },
          );
        }
      });
    }
  };

  const apply = (animate = false): void => {
    if (!root) return;
    const before = new Map(
      toolbarItems().map((item) => [item, item.getBoundingClientRect()]),
    );
    const byId = new Map(
      toolbarItems()
        .map((item) => [toolbarItemId(item), item] as const)
        .filter((entry): entry is readonly [ToolbarItemId, HTMLElement] =>
          Boolean(entry[0]),
        ),
    );
    settings.toolbarItemOrder.forEach((id, index) => {
      const item = byId.get(id);
      if (item) (index === 0 && leading ? leading : root).append(item);
    });
    root.style.setProperty(
      "--toolbar-item-size",
      `${settings.toolbarIconSizePx}px`,
    );
    leading?.style.setProperty(
      "--toolbar-item-size",
      `${settings.toolbarIconSizePx}px`,
    );
    const hidden = new Set(settings.toolbarHiddenItems);
    toolbarItems().forEach((item) => {
      const id = toolbarItemId(item);
      item.classList.toggle("toolbar-user-hidden", id ? hidden.has(id) : false);
      if (id) ensureToolbarButtonContent(id);
    });
    if (animate) animateReflow(before);
  };

  const listItems = (): HTMLElement[] =>
    Array.from(
      list?.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item]") || [],
    );
  const contentListItems = (): HTMLElement[] =>
    Array.from(
      contentList?.querySelectorAll<HTMLElement>(
        ":scope > [data-toolbar-content]",
      ) || [],
    );

  const animateListPlaceholder = (
    state: PointerDragState | null,
    beforeNode: HTMLElement | null,
  ): void => {
    const placeholder = state?.placeholder;
    if (!placeholder || !list || beforeNode === placeholder) return;
    if (!beforeNode && placeholder === list.lastElementChild) return;
    if (runtime.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      list.insertBefore(placeholder, beforeNode);
      return;
    }
    const before = new Map<HTMLElement, DOMRect>();
    listItems().forEach((item) => {
      if (item !== state.item && item !== placeholder) {
        before.set(item, item.getBoundingClientRect());
      }
    });
    list.insertBefore(placeholder, beforeNode);
    listItems().forEach((item) => {
      if (item === state.item || item === placeholder) return;
      const first = before.get(item);
      if (!first) return;
      const dy = first.top - item.getBoundingClientRect().top;
      if (!dy) return;
      item.style.transition = "none";
      item.style.transform = `translateY(${dy}px)`;
      item.classList.add("reflowing");
      void item.offsetHeight;
      runtime.requestAnimationFrame(() => {
        item.style.transition =
          "transform 180ms cubic-bezier(.2,.8,.2,1), border-color .16s ease, box-shadow .16s ease";
        item.style.transform = "";
        const clean = (): void => {
          item.style.removeProperty("transition");
          item.style.removeProperty("transform");
          item.classList.remove("reflowing");
        };
        item.addEventListener("transitionend", clean, { once: true });
        runtime.setTimeout(clean, 230);
      });
    });
  };

  const moveDraggedItem = (event: PointerEvent): void => {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const bounds = list?.getBoundingClientRect();
    const maxTop = bounds
      ? Math.max(bounds.top, bounds.bottom - state.item.offsetHeight)
      : event.clientY;
    const top = bounds
      ? Math.max(
          bounds.top,
          Math.min(maxTop, event.clientY - state.offsetY),
        )
      : event.clientY - state.offsetY;
    const probeY = bounds
      ? Math.max(bounds.top, Math.min(bounds.bottom, event.clientY))
      : event.clientY;
    state.item.style.top = `${top}px`;
    if (Math.abs(probeY - state.startY) > 4) state.moved = true;
    for (const row of listItems().filter((item) => item !== state.item)) {
      const box = row.getBoundingClientRect();
      if (probeY < box.top + box.height / 2) {
        animateListPlaceholder(state, row);
        return;
      }
    }
    animateListPlaceholder(state, null);
  };

  const listOrder = (): ToolbarItemId[] =>
    listItems()
      .map(toolbarItemId)
      .filter((id): id is ToolbarItemId => id !== null);

  const finishPointerDrag = (event: PointerEvent): void => {
    const state = dragState;
    if (!state || event.pointerId !== state.pointerId || !list) return;
    dragState = null;
    if (state.capture.hasPointerCapture?.(event.pointerId)) {
      state.capture.releasePointerCapture(event.pointerId);
    }
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
  };

  const animateContentPlaceholder = (beforeNode: HTMLElement | null): void => {
    const state = contentDragState;
    const placeholder = state?.placeholder;
    if (!state || !placeholder || !contentList || beforeNode === placeholder) return;
    if (!beforeNode && placeholder === contentList.lastElementChild) return;
    const before = new Map(
      contentListItems()
        .filter((item) => item !== state.item)
        .map((item) => [item, item.getBoundingClientRect()]),
    );
    contentList.insertBefore(placeholder, beforeNode);
    contentListItems().forEach((item) => {
      if (item === state.item || item === placeholder) return;
      const first = before.get(item);
      if (!first) return;
      const dx = first.left - item.getBoundingClientRect().left;
      if (
        !dx ||
        runtime.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
      ) {
        return;
      }
      item.animate(
        [
          { transform: `translateX(${dx}px)` },
          { transform: "translateX(0)" },
        ],
        { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    });
  };

  const moveContentDrag = (event: PointerEvent): void => {
    const state = contentDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const bounds = contentList?.getBoundingClientRect();
    const maxLeft = bounds
      ? Math.max(bounds.left, bounds.right - state.item.offsetWidth)
      : event.clientX;
    const left = bounds
      ? Math.max(
          bounds.left,
          Math.min(maxLeft, event.clientX - state.offsetX),
        )
      : event.clientX - state.offsetX;
    const probeX = bounds
      ? Math.max(bounds.left, Math.min(bounds.right, event.clientX))
      : event.clientX;
    state.item.style.left = `${left}px`;
    if (Math.abs(probeX - state.startX) > 4) state.moved = true;
    for (const item of contentListItems().filter(
      (candidate) => candidate !== state.item,
    )) {
      const box = item.getBoundingClientRect();
      if (probeX < box.left + box.width / 2) {
        animateContentPlaceholder(item);
        return;
      }
    }
    animateContentPlaceholder(null);
  };

  const finishContentDrag = (event: PointerEvent): void => {
    const state = contentDragState;
    if (!state || event.pointerId !== state.pointerId || !contentList) return;
    contentDragState = null;
    if (state.capture.hasPointerCapture?.(event.pointerId)) {
      state.capture.releasePointerCapture(event.pointerId);
    }
    contentList.insertBefore(state.item, state.placeholder);
    state.placeholder.remove();
    state.item.classList.remove("dragging");
    state.item.style.position = "";
    state.item.style.left = "";
    state.item.style.top = "";
    state.item.style.width = "";
    state.item.style.height = "";
    if (state.moved) {
      update(
        {
          toolbarContentOrder: contentListItems()
            .map((item) => item.dataset.toolbarContent)
            .filter(isToolbarContentId),
        },
        true,
      );
    }
  };

  const renderContentList = (): void => {
    if (!contentList) return;
    const visible = new Set(settings.toolbarContentVisible);
    contentList.replaceChildren(
      ...settings.toolbarContentOrder.map((id) => {
        const name = id === "icon" ? "图标" : "文字";
        const sample = id === "icon" ? "◈" : "文";
        const item = document.createElement("div");
        item.className = "toolbar-content-item";
        item.dataset.toolbarContent = id;
        item.setAttribute("role", "listitem");
        item.innerHTML = `<button class="toolbar-content-drag" type="button" aria-label="拖动${name}调整顺序" title="拖动调整顺序">⠿</button><span class="toolbar-content-sample" aria-hidden="true">${sample}</span><strong>${name}</strong><label><input type="checkbox" ${visible.has(id) ? "checked" : ""} /><span>显示</span></label>`;
        const handle = item.querySelector<HTMLElement>(".toolbar-content-drag");
        const checkbox = item.querySelector<HTMLInputElement>("input");
        if (!handle || !checkbox) return item;
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
          contentDragState = {
            item,
            placeholder,
            capture: handle,
            pointerId: event.pointerId,
            offsetX: event.clientX - box.left,
            startX: event.clientX,
            moved: false,
          };
          handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener("pointermove", moveContentDrag);
        handle.addEventListener("pointerup", finishContentDrag);
        handle.addEventListener("pointercancel", finishContentDrag);
        handle.addEventListener("lostpointercapture", finishContentDrag);
        checkbox.addEventListener("change", () => {
          const next = new Set(settings.toolbarContentVisible);
          if (checkbox.checked) next.add(id);
          else next.delete(id);
          if (!next.size) {
            checkbox.checked = true;
            setStatus("图标和文字至少保留一项");
            return;
          }
          update({ toolbarContentVisible: Array.from(next) }, true);
        });
        return item;
      }),
    );
  };

  const renderList = (): void => {
    if (!list) return;
    list.replaceChildren(
      ...settings.toolbarItemOrder.map((id) => {
        const [name, detail] = ITEM_COPY[id];
        const required = id === "settings";
        const item = document.createElement("div");
        item.className = "toolbar-settings-item";
        item.dataset.toolbarItem = id;
        item.setAttribute("role", "listitem");
        item.innerHTML = `<button class="toolbar-settings-drag" type="button" aria-label="拖动${name}调整顺序" title="拖动调整顺序">⠿</button><span class="toolbar-settings-copy"><strong>${name}</strong><small>${detail}</small></span><label class="toolbar-settings-visible${required ? " is-required" : ""}"><input type="checkbox" ${required || !settings.toolbarHiddenItems.includes(id) ? "checked" : ""} ${required ? "disabled" : ""} /><span>${required ? "固定显示" : "显示"}</span></label>`;
        const handle = item.querySelector<HTMLElement>(".toolbar-settings-drag");
        const visible = item.querySelector<HTMLInputElement>("input");
        if (!handle || !visible) return item;
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
          dragState = {
            item,
            placeholder,
            capture: handle,
            pointerId: event.pointerId,
            offsetY: event.clientY - box.top,
            startY: event.clientY,
            moved: false,
          };
          handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener("pointermove", moveDraggedItem);
        handle.addEventListener("pointerup", finishPointerDrag);
        handle.addEventListener("pointercancel", finishPointerDrag);
        handle.addEventListener("lostpointercapture", finishPointerDrag);
        visible.addEventListener("change", () => {
          if (required) return;
          const hidden = new Set(settings.toolbarHiddenItems);
          if (visible.checked) hidden.delete(id);
          else hidden.add(id);
          update({ toolbarHiddenItems: Array.from(hidden) }, false);
        });
        return item;
      }),
    );
  };

  const render = (): void => {
    if (sizeInput) sizeInput.value = String(settings.toolbarIconSizePx);
    if (sizeOutput) sizeOutput.textContent = `${settings.toolbarIconSizePx} px`;
    renderContentList();
    renderList();
  };

  const scheduleSave = (): void => {
    runtime.clearTimeout(saveTimer);
    saveTimer = runtime.setTimeout(async () => {
      if (!transport) return;
      const api = createTauriApi<VerifiedToolbarSettingsCommands>(transport);
      setStatus("正在保存…");
      try {
        const remote = await api.invoke("app_settings_sync_save", {
          request: settings,
        });
        if (remote?.hasToolbarSettings) settings = normalizeToolbarSettings(remote);
        cache();
        setStatus("已保存；下次同步会带到其他设备");
      } catch (error: unknown) {
        setStatus(`保存失败：${errorText(error)}`);
      }
    }, 260);
  };

  const update = (patch: Partial<ToolbarSettings>, animate: boolean): void => {
    settings = normalizeToolbarSettings(Object.assign({}, settings, patch));
    cache();
    apply(Boolean(animate));
    render();
    scheduleSave();
  };

  const hydrate = async (): Promise<void> => {
    if (!transport) return;
    const api = createTauriApi<VerifiedToolbarSettingsCommands>(transport);
    try {
      const remote = await api.invoke("app_settings_sync_get");
      if (remote?.hasToolbarSettings) {
        settings = normalizeToolbarSettings(remote);
        cache();
        apply(false);
        render();
      }
    } catch {
      // The local cache remains usable while the database is unavailable.
    }
  };

  const init: ToolbarSettingsInit = (options = {}) => {
    if (!root || !list || !sizeInput || init.ready) return;
    init.ready = true;
    transport = options.transport;
    if (!transport && options.invoke) {
      transport = { ...defaultTransport, invoke: options.invoke };
    }
    transport ??= defaultTransport;
    settings = readCached();
    apply(false);
    render();
    sizeInput.addEventListener("input", () =>
      update({ toolbarIconSizePx: Number(sizeInput.value) }, false),
    );
    resetButton?.addEventListener("click", () =>
      update(clone(DEFAULT_TOOLBAR_SETTINGS) as ToolbarSettings, true),
    );
    runtime.addEventListener("app-language-changed", () => apply(false));
    if (transport?.listen) {
      const events = createTauriApi<VerifiedToolbarSettingsCommands>(
        transport,
      ).events<ToolbarSettingsEvents>();
      void events
        .listen("app-settings-synced", () => {
          void hydrate();
        })
        .catch(() => undefined);
    }
    void hydrate();
  };

  return Object.freeze({
    init,
    get: () => clone(settings),
    apply,
    normalize: normalizeToolbarSettings,
  });
}

/** Classic installer replacing `ui/toolbar-settings-ui.js`. */
export function installToolbarSettingsUi(
  target: unknown,
  transport?: TauriTransport,
): ToolbarSettingsGlobalApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      resolvedTransport = undefined;
    }
  }
  const api = createToolbarSettingsGlobal(runtime, resolvedTransport);
  runtime.ReaderToolbarSettingsUI = api;
  return api;
}
