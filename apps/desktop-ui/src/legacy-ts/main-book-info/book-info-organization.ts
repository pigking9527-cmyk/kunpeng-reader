import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

export interface OrganizationBook extends Record<string, unknown> {
  readonly id?: unknown;
  readonly tags?: readonly unknown[];
  readonly collections?: readonly unknown[];
}

type OrganizationCommands = {
  set_book_organization: {
    readonly args: {
      readonly id: string;
      readonly tags: readonly unknown[];
      readonly collections: readonly unknown[];
    };
    readonly result: unknown;
  };
  rename_book_organization: {
    readonly args: {
      readonly kind: "tag" | "collection";
      readonly name: string;
      readonly newName: string;
    };
    readonly result: unknown;
  };
  delete_book_organization: {
    readonly args: {
      readonly kind: "tag" | "collection";
      readonly name: string;
    };
    readonly result: unknown;
  };
};

type VerifiedOrganizationCommands =
  OrganizationCommands extends TauriCommandMap ? OrganizationCommands : never;

export interface BookInfoOrganizationOptions {
  readonly root?: Document;
  readonly invoke?: TauriTransport["invoke"];
  readonly getBooks?: () => readonly OrganizationBook[] | null | undefined;
  readonly onBooksChanged?: (books: unknown[]) => void;
  readonly openBooklist?: (name: string) => void;
  readonly alertAction?: (message: string) => void;
}

export interface BookInfoOrganizationController {
  open(id: unknown, book?: OrganizationBook | null): void;
  openManager(field: "tags" | "collections"): void;
  closeManager(): void;
}

export interface BookInfoOrganizationApi {
  init(options?: BookInfoOrganizationOptions): BookInfoOrganizationController | null;
}

interface OrganizationRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly alert?: (message?: unknown) => void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  ReaderBookOrganizationUI?: BookInfoOrganizationApi;
}

interface OrganizationEntry {
  readonly key: string;
  readonly name: string;
  count: number;
}

type OrganizationField = "tags" | "collections";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): OrganizationRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || typeof runtime.setTimeout !== "function") {
    return null;
  }
  return runtime as unknown as OrganizationRuntime;
}

export function createBookInfoOrganization(
  runtime: OrganizationRuntime,
): BookInfoOrganizationApi {
  const init = (
    options: BookInfoOrganizationOptions = {},
  ): BookInfoOrganizationController | null => {
    const root = options.root || runtime.document;
    const invoke = options.invoke;
    const getBooks = options.getBooks;
    const onBooksChanged = options.onBooksChanged;
    const openBooklist = options.openBooklist;
    const alertAction = options.alertAction || ((message: string) => runtime.alert?.(message));
    const tagEditor = root?.getElementById("book-info-tags") as HTMLElement | null;
    const collectionEditor = root?.getElementById("book-info-collections") as HTMLElement | null;
    const modal = root?.getElementById("book-organization-modal") as HTMLElement | null;
    const infoModal = root?.getElementById("book-info-modal") as HTMLElement | null;
    const tagSummary = root?.getElementById("book-info-tag-summary") as HTMLElement | null;
    const collectionSummary = root?.getElementById(
      "book-info-collection-summary",
    ) as HTMLElement | null;
    const panels: Record<OrganizationField, HTMLElement | null> = {
      tags: root?.getElementById("book-organization-tags-panel") as HTMLElement | null,
      collections: root?.getElementById(
        "book-organization-collections-panel",
      ) as HTMLElement | null,
    };
    const tabs: Record<OrganizationField, HTMLElement | null> = {
      tags: root?.getElementById("book-organization-tags-tab") as HTMLElement | null,
      collections: root?.getElementById(
        "book-organization-collections-tab",
      ) as HTMLElement | null,
    };
    if (
      !tagEditor ||
      !collectionEditor ||
      !modal ||
      !tagSummary ||
      !collectionSummary ||
      typeof invoke !== "function" ||
      typeof getBooks !== "function"
    ) {
      return null;
    }
    const api = createTauriApi<VerifiedOrganizationCommands>({ invoke });

    let bookId = "";
    let snapshot: OrganizationBook | null = null;
    let busy = false;
    const cleanName = (value: unknown): string =>
      String(value || "").trim().replace(/\s+/gu, " ").slice(0, 32);
    const nameKey = (value: unknown): string => cleanName(value).toLocaleLowerCase("zh-CN");
    const kindFor = (field: OrganizationField): "tag" | "collection" =>
      field === "tags" ? "tag" : "collection";
    const labelFor = (field: OrganizationField): string =>
      field === "tags" ? "标签" : "收藏书单";

    const currentBook = (): OrganizationBook | null =>
      (getBooks() || []).find((book) => String(book.id) === bookId) || snapshot;

    const valuesFor = (book: OrganizationBook | null, field: OrganizationField): readonly unknown[] => {
      const values = book?.[field];
      return Array.isArray(values) ? values : [];
    };

    const organizationEntries = (field: OrganizationField): OrganizationEntry[] => {
      const entries = new Map<string, OrganizationEntry>();
      for (const book of getBooks() || []) {
        for (const raw of valuesFor(book, field)) {
          const name = cleanName(raw);
          const key = nameKey(name);
          if (!key) continue;
          const entry = entries.get(key) || { key, name, count: 0 };
          entry.count += 1;
          entries.set(key, entry);
        }
      }
      for (const raw of valuesFor(snapshot, field)) {
        const name = cleanName(raw);
        const key = nameKey(name);
        if (key && !entries.has(key)) entries.set(key, { key, name, count: 1 });
      }
      return Array.from(entries.values()).sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      );
    };

    const updateFromList = (list: unknown): void => {
      if (Array.isArray(list)) onBooksChanged?.(list);
      const refreshed = currentBook();
      if (refreshed) snapshot = { ...snapshot, ...refreshed };
      render();
    };

    const renderSummary = (element: HTMLElement, values: unknown): void => {
      const items = (Array.isArray(values) ? values : []).map(cleanName).filter(Boolean);
      element.textContent = items.length ? items.join("、") : "未添加";
      element.title = items.join("、");
    };

    const run = async (
      action: () => Promise<unknown>,
      failureText: string,
    ): Promise<void> => {
      if (busy) return;
      busy = true;
      tagEditor.classList.add("busy");
      collectionEditor.classList.add("busy");
      try {
        updateFromList(await action());
      } catch (error) {
        alertAction(`${failureText}：${String(error)}`);
        render();
      } finally {
        busy = false;
        tagEditor.classList.remove("busy");
        collectionEditor.classList.remove("busy");
      }
    };

    const nextValues = (
      field: OrganizationField,
      name: string,
      checked: boolean,
    ): string[] => {
      const values = new Map(
        valuesFor(currentBook(), field).map((value) => [nameKey(value), cleanName(value)]),
      );
      const key = nameKey(name);
      if (checked) values.set(key, cleanName(name));
      else values.delete(key);
      return Array.from(values.values());
    };

    const saveMembership = (
      field: OrganizationField,
      name: string,
      checked: boolean,
    ): void => {
      const book = currentBook();
      if (!book) return;
      const values = nextValues(field, name, checked);
      const tags = field === "tags" ? values : valuesFor(book, "tags");
      const collections = field === "collections" ? values : valuesFor(book, "collections");
      void run(
        () => api.invoke("set_book_organization", { id: bookId, tags, collections }),
        `保存${labelFor(field)}失败`,
      );
    };

    const renameEntry = (
      field: OrganizationField,
      entry: OrganizationEntry,
      next: string,
    ): void => {
      void run(
        () =>
          api.invoke("rename_book_organization", {
            kind: kindFor(field),
            name: entry.name,
            newName: next,
          }),
        `${labelFor(field)}改名失败`,
      );
    };

    const deleteEntry = (field: OrganizationField, entry: OrganizationEntry): void => {
      void run(
        () =>
          api.invoke("delete_book_organization", {
            kind: kindFor(field),
            name: entry.name,
          }),
        `删除${labelFor(field)}失败`,
      );
    };

    const actionButton = (text: string, className = ""): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = `book-info-org-action ${className}`;
      button.textContent = text;
      return button;
    };

    const showInlineRename = (
      row: HTMLElement,
      field: OrganizationField,
      entry: OrganizationEntry,
    ): void => {
      row.replaceChildren();
      row.classList.add("renaming");
      const input = root.createElement("input");
      input.className = "book-info-org-rename";
      input.type = "text";
      input.maxLength = 32;
      input.value = entry.name;
      const save = actionButton("保存", "primary");
      const cancel = actionButton("取消");
      const submit = (): void => {
        const next = cleanName(input.value);
        if (!next || nameKey(next) === entry.key) {
          render();
          return;
        }
        renameEntry(field, entry, next);
      };
      save.addEventListener("click", submit);
      cancel.addEventListener("click", render);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          render();
        }
      });
      row.append(input, save, cancel);
      input.focus();
      input.select();
    };

    const renderEditor = (container: HTMLElement, field: OrganizationField): void => {
      container.replaceChildren();
      const selected = new Set(valuesFor(currentBook(), field).map(nameKey));
      const entries = organizationEntries(field);
      const choices = root.createElement("div");
      choices.className = "book-info-org-choices";
      if (!entries.length) {
        const empty = root.createElement("div");
        empty.className = "book-info-org-empty";
        empty.textContent = `暂无${labelFor(field)}，可在下方新建。`;
        choices.appendChild(empty);
      }
      entries.forEach((entry) => {
        const row = root.createElement("div");
        row.className = "book-info-org-option";
        const label = root.createElement("label");
        const checkbox = root.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(entry.key);
        checkbox.addEventListener("change", () =>
          saveMembership(field, entry.name, checkbox.checked),
        );
        const name = root.createElement("span");
        name.textContent = `${entry.name}（${entry.count}）`;
        label.append(checkbox, name);
        const actions = root.createElement("span");
        actions.className = "book-info-org-option-actions";
        if (field === "collections") {
          const open = actionButton("打开");
          open.addEventListener("click", () => {
            modal.classList.remove("show");
            openBooklist?.(entry.name);
          });
          actions.appendChild(open);
        }
        const rename = actionButton("改名");
        rename.addEventListener("click", () => showInlineRename(row, field, entry));
        const remove = actionButton("删除", "danger");
        let deleteArmed = false;
        remove.addEventListener("click", () => {
          if (!deleteArmed) {
            deleteArmed = true;
            remove.textContent = "确认删除";
            remove.title = "再次点击会从所有图书中移除";
            runtime.setTimeout(() => {
              if (!remove.isConnected) return;
              deleteArmed = false;
              remove.textContent = "删除";
              remove.title = "";
            }, 3_000);
            return;
          }
          deleteEntry(field, entry);
        });
        actions.append(rename, remove);
        row.append(label, actions);
        choices.appendChild(row);
      });
      const create = root.createElement("div");
      create.className = "book-info-org-create";
      const input = root.createElement("input");
      input.type = "text";
      input.maxLength = 32;
      input.placeholder = field === "tags" ? "新建标签" : "新建收藏书单";
      const add = actionButton("新建并加入", "primary");
      const addValue = (): void => {
        const name = cleanName(input.value);
        if (!name) return;
        if (selected.has(nameKey(name))) {
          alertAction(`这本书已经加入“${name}”。`);
          return;
        }
        saveMembership(field, name, true);
      };
      add.addEventListener("click", addValue);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addValue();
        }
      });
      create.append(input, add);
      container.append(choices, create);
    };

    const render = (): void => {
      if (!bookId) return;
      const book = currentBook();
      renderSummary(tagSummary, book?.tags);
      renderSummary(collectionSummary, book?.collections);
      if (modal.classList.contains("show")) {
        renderEditor(tagEditor, "tags");
        renderEditor(collectionEditor, "collections");
      }
    };

    const selectPanel = (field: OrganizationField): void => {
      for (const key of Object.keys(panels) as OrganizationField[]) {
        const active = key === field;
        const panel = panels[key];
        const tab = tabs[key];
        if (panel) panel.hidden = !active;
        tab?.classList.toggle("active", active);
        tab?.setAttribute("aria-selected", active ? "true" : "false");
      }
    };

    const openManager = (field: OrganizationField): void => {
      if (!bookId) return;
      selectPanel(field);
      infoModal?.classList.remove("show");
      modal.classList.add("show");
      renderEditor(tagEditor, "tags");
      renderEditor(collectionEditor, "collections");
    };

    const closeManager = (): void => {
      modal.classList.remove("show");
      if (bookId) infoModal?.classList.add("show");
    };

    const open = (id: unknown, book?: OrganizationBook | null): void => {
      bookId = String(id || "");
      snapshot = { ...(book || {}), id: bookId };
      render();
    };

    tabs.tags?.addEventListener("click", () => selectPanel("tags"));
    tabs.collections?.addEventListener("click", () => selectPanel("collections"));
    root.getElementById("book-organization-close")?.addEventListener("click", closeManager);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeManager();
    });

    return Object.freeze({ open, openManager, closeManager });
  };

  return Object.freeze({ init });
}

/** Classic installer replacing `ui/book-info-organization.js`. */
export function installBookInfoOrganization(target: unknown): BookInfoOrganizationApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createBookInfoOrganization(runtime);
  runtime.ReaderBookOrganizationUI = api;
  return api;
}
