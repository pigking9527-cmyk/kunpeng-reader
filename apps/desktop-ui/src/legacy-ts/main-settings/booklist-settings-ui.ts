import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type BooklistCommands = {
  list_booklists: { readonly result: unknown };
  create_booklist: {
    readonly args: { readonly name: string };
    readonly result: unknown;
  };
  delete_booklist: {
    readonly args: { readonly id: unknown };
    readonly result: unknown;
  };
};

type VerifiedBooklistCommands = BooklistCommands extends TauriCommandMap
  ? BooklistCommands
  : never;

interface BooklistEntry extends Record<string, unknown> {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly bookIds?: unknown;
}

interface AppDialogLike {
  confirm?(
    message: string,
    options: Readonly<{
      title: "删除书单";
      confirmLabel: "删除";
      cancelLabel: "取消";
      tone: "warning";
    }>,
  ): boolean | Promise<boolean>;
}

interface ShelfUiLike {
  openBooklist?(name: unknown): void;
}

interface BooklistRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly AppDialog?: AppDialogLike;
  readonly ReaderShelfUI?: ShelfUiLike;
  confirm(message: string): boolean;
  ReaderBooklistSettingsUI?: BooklistSettingsGlobal;
}

export interface BooklistSettingsInstance {
  open(): Promise<unknown>;
  refresh(): Promise<unknown>;
}

export interface BooklistSettingsGlobal {
  init(options?: Readonly<{ root?: Document; transport?: TauriTransport }>):
    | BooklistSettingsInstance
    | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): BooklistRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as BooklistRuntime;
}

function htmlElement(value: Element | null): HTMLElement | null {
  return value instanceof HTMLElement ? value : null;
}

function inputElement(value: Element | null): HTMLInputElement | null {
  return value instanceof HTMLInputElement ? value : null;
}

function formElement(value: Element | null): HTMLFormElement | null {
  return value instanceof HTMLFormElement ? value : null;
}

function buttonElement(value: Element | null): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function entries(value: unknown): BooklistEntry[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is BooklistEntry => entry !== null)
    : [];
}

export function createBooklistSettingsGlobal(
  runtime: BooklistRuntime,
  defaultTransport?: TauriTransport,
): BooklistSettingsGlobal {
  const init: BooklistSettingsGlobal["init"] = ({
    root = runtime.document,
    transport = defaultTransport,
  } = {}) => {
    if (!transport) return null;
    const api = createTauriApi<VerifiedBooklistCommands>(transport);
    const byId = (id: string): Element | null => root.getElementById(id);
    const modal = htmlElement(byId("booklist-shortcuts-modal"));
    const openButton = htmlElement(byId("booklist-shortcuts-open"));
    const closeButton = htmlElement(byId("booklist-shortcuts-close"));
    const form = formElement(byId("booklist-shortcuts-create"));
    const name = inputElement(byId("booklist-shortcuts-name"));
    const list = htmlElement(byId("booklist-shortcuts-list"));
    const status = htmlElement(byId("booklist-shortcuts-status"));
    if (!modal || !openButton || !form || !name || !list) return null;

    const setStatus = (message = "", error = false): void => {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("error", error);
    };
    const countLabel = (entry: BooklistEntry): string =>
      `${Array.isArray(entry.bookIds) ? entry.bookIds.length : 0} 本图书`;

    const render = (value: unknown): void => {
      const booklists = entries(value);
      list.replaceChildren();
      if (!booklists.length) {
        const empty = root.createElement("p");
        empty.className = "booklist-shortcuts-empty";
        empty.textContent =
          "还没有保存的书单。可先新建一个空书单，或在书库问答中生成推荐书单。";
        list.append(empty);
        return;
      }
      booklists.forEach((entry) => {
        const row = root.createElement("article");
        row.className = "booklist-shortcuts-row";
        const body = root.createElement("button");
        body.type = "button";
        body.className = "booklist-shortcuts-open-list";
        const title = root.createElement("strong");
        title.textContent = String(entry.name || "未命名书单");
        const meta = root.createElement("span");
        meta.textContent = `${countLabel(entry)}${entry.description ? ` · ${String(entry.description)}` : ""}`;
        body.append(title, meta);
        body.addEventListener("click", () => {
          modal.classList.remove("show");
          runtime.ReaderShelfUI?.openBooklist?.(entry.name);
        });
        const remove = root.createElement("button");
        remove.type = "button";
        remove.className = "btn-plain booklist-shortcuts-delete";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          const confirmed =
            (await runtime.AppDialog?.confirm?.(
              `删除“${String(entry.name)}”及其书单成员关系？图书本身不会删除。`,
              {
                title: "删除书单",
                confirmLabel: "删除",
                cancelLabel: "取消",
                tone: "warning",
              },
            )) ?? runtime.confirm(`删除书单“${String(entry.name)}”？`);
          if (!confirmed) return;
          remove.disabled = true;
          try {
            render(await api.invoke("delete_booklist", { id: entry.id }));
            setStatus("已删除书单；下次同步会同步删除。", false);
          } catch (error: unknown) {
            setStatus(`删除书单失败：${String(error)}`, true);
          } finally {
            remove.disabled = false;
          }
        });
        row.append(body, remove);
        list.append(row);
      });
    };

    const refresh = async (): Promise<unknown> => {
      setStatus("正在读取书单…");
      try {
        const result = await api.invoke("list_booklists");
        render(result);
        setStatus("");
        return result;
      } catch (error: unknown) {
        setStatus(`读取书单失败：${String(error)}`, true);
        throw error;
      }
    };

    openButton.addEventListener("click", () => {
      modal.classList.add("show");
      void refresh();
    });
    closeButton?.addEventListener("click", () => modal.classList.remove("show"));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.remove("show");
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = String(name.value || "").trim();
      if (!value) {
        name.focus();
        return;
      }
      const button = buttonElement(form.querySelector("button"));
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api.invoke("create_booklist", { name: value });
        name.value = "";
        render(result);
        setStatus("已保存快捷书单。", false);
      } catch (error: unknown) {
        setStatus(`新建书单失败：${String(error)}`, true);
      } finally {
        button.disabled = false;
      }
    });
    return {
      open: () => {
        modal.classList.add("show");
        return refresh();
      },
      refresh,
    };
  };
  return { init };
}

/** Classic installer replacing `ui/booklist-settings-ui.js`. */
export function installBooklistSettingsUi(
  target: unknown,
  transport?: TauriTransport,
): BooklistSettingsGlobal | null {
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
  const globalApi = createBooklistSettingsGlobal(runtime, resolvedTransport);
  runtime.ReaderBooklistSettingsUI = globalApi;
  return globalApi;
}
