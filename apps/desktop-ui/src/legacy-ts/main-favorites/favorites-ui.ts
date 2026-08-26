import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import {
  FAVORITES_CHANGED_EVENT,
  listFavorites,
  removeFavorite,
  type FavoritesStoreOptions,
  type NewsFavoriteRecord,
} from "./favorites-store.ts";

type FavoriteTab = "booklist" | "news";

interface BooklistProjection extends Record<string, unknown> {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly bookIds?: unknown;
  readonly book_ids?: unknown;
}

type FavoriteCommands = {
  list_booklists: { readonly result: unknown };
};

type VerifiedFavoriteCommands = FavoriteCommands extends TauriCommandMap
  ? FavoriteCommands
  : never;

interface FavoritesRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage?: Storage;
  readonly ReaderShelfUI?: {
    openBooklist?(name: unknown): Promise<void> | void;
  };
  readonly ReaderIntelligenceWorkspace?: {
    readonly instance?: {
      openFavorite?(favorite: NewsFavoriteRecord): Promise<boolean>;
    } | null;
  };
  ReaderFavoritesUI?: FavoritesUiGlobal;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  dispatchEvent?(event: Event): boolean;
}

export interface FavoritesUiInstance {
  open(tab?: FavoriteTab): Promise<void>;
  close(): void;
  refresh(): Promise<void>;
}

export interface FavoritesUiGlobal {
  readonly instance: FavoritesUiInstance;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function runtimeFrom(value: unknown): FavoritesRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document)) return null;
  return runtime as unknown as FavoritesRuntime;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booklists(value: unknown): BooklistProjection[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is BooklistProjection => Boolean(item))
    : [];
}

function addStylesheet(document: Document): void {
  if (document.getElementById("favorites-ui-stylesheet")) return;
  const link = document.createElement("link");
  link.id = "favorites-ui-stylesheet";
  link.rel = "stylesheet";
  link.href = "favorites.css";
  document.head?.append(link);
}

function installToolbarButton(document: Document): HTMLButtonElement | null {
  const existing = document.getElementById("favorites-toolbar-btn");
  if (existing) return existing as HTMLButtonElement;
  const toolbar = document.getElementById("toolbar-actions");
  if (!toolbar) return null;
  const action = document.createElement("div");
  action.className = "toolbar-action";
  action.dataset.toolbarItem = "favorites";
  const button = document.createElement("button");
  button.id = "favorites-toolbar-btn";
  button.type = "button";
  button.className = "icon-btn";
  button.title = "收藏夹";
  button.setAttribute("aria-label", "打开收藏夹");
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.7 14.6 9l5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1L9.4 9 12 3.7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  action.append(button);
  const intelligence = toolbar.querySelector<HTMLElement>(
    ':scope > [data-toolbar-item="intelligence-lab"]',
  );
  intelligence?.insertAdjacentElement("afterend", action);
  if (!action.parentElement) toolbar.prepend(action);
  return button;
}

function createModal(document: Document): {
  readonly modal: HTMLElement;
  readonly closeButton: HTMLButtonElement;
  readonly tabs: Readonly<Record<FavoriteTab, HTMLButtonElement>>;
  readonly status: HTMLElement;
  readonly list: HTMLElement;
} {
  const modal = document.createElement("div");
  modal.id = "favorites-modal";
  modal.className = "modal favorites-modal";
  modal.dataset.overlaySurface = "favorites";
  modal.dataset.overlayRole = "information";
  modal.setAttribute("aria-hidden", "true");
  const shell = document.createElement("section");
  shell.className = "modal-box favorites-shell";
  shell.setAttribute("role", "dialog");
  shell.setAttribute("aria-modal", "true");
  shell.setAttribute("aria-labelledby", "favorites-title");
  const header = document.createElement("header");
  header.className = "favorites-header";
  const title = document.createElement("h2");
  title.id = "favorites-title";
  title.textContent = "收藏夹";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "favorites-close";
  closeButton.setAttribute("aria-label", "关闭收藏夹");
  closeButton.textContent = "×";
  header.append(title, closeButton);
  const tablist = document.createElement("nav");
  tablist.className = "favorites-tabs";
  tablist.setAttribute("role", "tablist");
  const makeTab = (id: FavoriteTab, label: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "favorites-tab";
    button.dataset.favoriteTab = id;
    button.setAttribute("role", "tab");
    button.textContent = label;
    tablist.append(button);
    return button;
  };
  const tabs = {
    booklist: makeTab("booklist", "书单"),
    news: makeTab("news", "收藏新闻"),
  } as const;
  const status = document.createElement("p");
  status.className = "favorites-status";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "favorites-list";
  shell.append(header, tablist, status, list);
  modal.append(shell);
  document.body.append(modal);
  return { modal, closeButton, tabs, status, list };
}

export function installFavoritesUi(
  target: unknown,
  transport?: TauriTransport,
): FavoritesUiGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  if (runtime.ReaderFavoritesUI) return runtime.ReaderFavoritesUI;
  const toolbarButton = installToolbarButton(runtime.document);
  if (!toolbarButton) return null;
  addStylesheet(runtime.document);
  const view = createModal(runtime.document);
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      resolvedTransport = undefined;
    }
  }
  const api = resolvedTransport
    ? createTauriApi<VerifiedFavoriteCommands>(resolvedTransport)
    : null;
  const storeOptions: FavoritesStoreOptions = {
    storage: runtime.localStorage ?? null,
    eventTarget: typeof runtime.dispatchEvent === "function"
      ? { dispatchEvent: (event: Event) => runtime.dispatchEvent!(event) }
      : null,
  };
  let activeTab: FavoriteTab = "booklist";
  let latestBooklists: BooklistProjection[] = [];

  const setStatus = (message = "", error = false): void => {
    view.status.textContent = message;
    view.status.classList.toggle("error", error);
  };

  const close = (): void => {
    view.modal.classList.remove("show");
    view.modal.setAttribute("aria-hidden", "true");
    toolbarButton.setAttribute("aria-expanded", "false");
  };

  const removeButton = (
    kind: "news",
    id: string,
  ): HTMLButtonElement => {
    const button = runtime.document.createElement("button");
    button.type = "button";
    button.className = "btn-plain";
    button.textContent = "取消收藏";
    button.addEventListener("click", () => {
      if (!removeFavorite(kind, id, storeOptions)) {
        setStatus("取消收藏失败，请稍后重试。", true);
        return;
      }
      void refresh();
    });
    return button;
  };

  const renderBooklists = (): void => {
    view.list.replaceChildren();
    if (!latestBooklists.length) {
      const empty = runtime.document.createElement("p");
      empty.className = "favorites-empty";
      empty.textContent = "还没有书单。可在书单管理或图书信息页新建书单。";
      view.list.append(empty);
      return;
    }
    latestBooklists.forEach((current) => {
      const row = runtime.document.createElement("article");
      row.className = "favorite-row";
      const copy = runtime.document.createElement("div");
      copy.className = "favorite-copy";
      const title = runtime.document.createElement("strong");
      title.textContent = text(current.name) || "未命名书单";
      const description = runtime.document.createElement("span");
      const count = Array.isArray(current?.book_ids)
        ? current.book_ids.length
        : Array.isArray(current?.bookIds)
          ? current.bookIds.length
          : 0;
      description.textContent = `${count} 本图书${text(current.description) ? ` · ${text(current.description)}` : ""}`;
      copy.append(title, description);
      const actions = runtime.document.createElement("div");
      actions.className = "favorite-actions";
      const open = runtime.document.createElement("button");
      open.type = "button";
      open.className = "btn-plain primary";
      open.textContent = "打开书单";
      open.addEventListener("click", () => {
        close();
        void Promise.resolve(runtime.ReaderShelfUI?.openBooklist?.(current.name));
      });
      actions.append(open);
      row.append(copy, actions);
      view.list.append(row);
    });
  };

  const renderNews = (): void => {
    const favorites = listFavorites("news", storeOptions) as NewsFavoriteRecord[];
    view.list.replaceChildren();
    if (!favorites.length) {
      const empty = runtime.document.createElement("p");
      empty.className = "favorites-empty";
      empty.textContent = "还没有收藏新闻。可在情报中心的新闻或简报上添加收藏。";
      view.list.append(empty);
      return;
    }
    favorites.forEach((favorite) => {
      const row = runtime.document.createElement("article");
      row.className = "favorite-row";
      const copy = runtime.document.createElement("div");
      copy.className = "favorite-copy";
      const title = runtime.document.createElement("strong");
      title.textContent = favorite.title;
      const summary = runtime.document.createElement("span");
      summary.textContent = favorite.summary || "暂无摘要";
      const meta = runtime.document.createElement("span");
      meta.className = "favorite-meta";
      meta.textContent = [favorite.source, favorite.category, favorite.publishedAt]
        .filter(Boolean)
        .join(" · ");
      copy.append(title, summary, meta);
      const actions = runtime.document.createElement("div");
      actions.className = "favorite-actions";
      const open = runtime.document.createElement("button");
      open.type = "button";
      open.className = "btn-plain primary";
      open.textContent = "打开新闻";
      open.addEventListener("click", () => {
        void (async () => {
          const opened = await runtime.ReaderIntelligenceWorkspace?.instance
            ?.openFavorite?.(favorite);
          if (opened) close();
          else setStatus("这条收藏暂时无法打开，可保留后稍后重试。", true);
        })();
      });
      actions.append(open, removeButton("news", favorite.id));
      row.append(copy, actions);
      view.list.append(row);
    });
  };

  const selectTab = (tab: FavoriteTab): void => {
    activeTab = tab;
    (Object.keys(view.tabs) as FavoriteTab[]).forEach((id) => {
      view.tabs[id].setAttribute("aria-selected", String(id === activeTab));
      view.tabs[id].tabIndex = id === activeTab ? 0 : -1;
    });
    if (activeTab === "booklist") renderBooklists();
    else renderNews();
  };

  const refresh = async (): Promise<void> => {
    setStatus("");
    if (activeTab === "booklist" && api) {
      try {
        latestBooklists = booklists(await api.invoke("list_booklists"));
      } catch (error: unknown) {
        setStatus(`读取书单失败：${String(error)}`, true);
      }
    }
    selectTab(activeTab);
  };

  const open = async (tab: FavoriteTab = activeTab): Promise<void> => {
    activeTab = tab;
    view.modal.classList.add("show");
    view.modal.setAttribute("aria-hidden", "false");
    toolbarButton.setAttribute("aria-expanded", "true");
    await refresh();
    view.closeButton.focus();
  };

  toolbarButton.setAttribute("aria-expanded", "false");
  toolbarButton.addEventListener("click", () => { void open(); });
  view.closeButton.addEventListener("click", close);
  view.modal.addEventListener("click", (event) => {
    if (event.target === view.modal) close();
  });
  view.tabs.booklist.addEventListener("click", () => selectTab("booklist"));
  view.tabs.news.addEventListener("click", () => selectTab("news"));
  runtime.addEventListener("keydown", ((event: KeyboardEvent) => {
    if (event.key === "Escape" && view.modal.classList.contains("show")) close();
  }) as EventListener);
  runtime.addEventListener(FAVORITES_CHANGED_EVENT, () => {
    if (view.modal.classList.contains("show")) void refresh();
  });

  const instance = Object.freeze({ open, close, refresh });
  const global = Object.freeze({ instance });
  runtime.ReaderFavoritesUI = global;
  return global;
}
