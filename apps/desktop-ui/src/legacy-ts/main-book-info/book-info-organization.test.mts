import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installBookInfoOrganization,
  type BookInfoOrganizationApi,
  type BookInfoOrganizationController,
  type OrganizationBook,
} from "./book-info-organization.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  try {
    return readFileSync(
      new URL("ui/generated-ts/book-info-organization.js", repositoryRoot),
      "utf8",
    );
  } catch {
    return execFileSync(
      "git",
      ["show", "HEAD:ui/generated-ts/book-info-organization.js"],
      {
      cwd: repositoryRoot,
      encoding: "utf8",
      },
    );
  }
}

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
  public remove(value: string): void {
    this.values.delete(value);
  }
  public contains(value: string): boolean {
    return this.values.has(value);
  }
  public toggle(value: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(value);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

interface FakeEvent {
  readonly target: FakeElement;
  readonly key?: string;
  preventDefault(): void;
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();
  public readonly attributes = new Map<string, string>();
  public checked = false;
  public hidden = false;
  public isConnected = true;
  public maxLength = 0;
  public placeholder = "";
  public textContent = "";
  public title = "";
  public type = "";
  public value = "";
  public className = "";
  public focusCount = 0;
  public selectCount = 0;

  public constructor(public readonly tagName: string, public readonly id = "") {}

  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => unknown,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public async fire(type: string, key?: string, target: FakeElement = this): Promise<boolean> {
    let prevented = false;
    for (const listener of this.listeners.get(type) ?? []) {
      const event: FakeEvent = {
        target,
        preventDefault: () => {
          prevented = true;
        },
      };
      if (key !== undefined) Object.defineProperty(event, "key", { value: key });
      await listener(event);
    }
    return prevented;
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  public focus(): void {
    this.focusCount += 1;
  }
  public select(): void {
    this.selectCount += 1;
  }
}

type CommandCall = { readonly command: string; readonly args?: Record<string, unknown> };

function fixture() {
  const ids = [
    "book-info-tags",
    "book-info-collections",
    "book-organization-modal",
    "book-info-modal",
    "book-info-tag-summary",
    "book-info-collection-summary",
    "book-info-collections-manage",
    "book-organization-tags-panel",
    "book-organization-collections-panel",
    "book-organization-tags-tab",
    "book-organization-collections-tab",
    "book-organization-close",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement("div", id)]));
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  const calls: CommandCall[] = [];
  const responses = new Map<string, unknown[]>([
    ["list_booklists", []],
    ["set_book_organization", []],
    ["rename_book_organization", []],
    ["delete_book_organization", []],
  ]);
  const timers: Array<{ readonly callback: () => void; readonly milliseconds: number }> = [];
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    const value = responses.get(command)?.shift();
    if (value instanceof Error) throw value;
    return value as TResult;
  };
  const target: Record<string, unknown> = {
    document,
    alert: () => undefined,
    setTimeout: (callback: () => void, milliseconds: number) => {
      timers.push({ callback, milliseconds });
      return timers.length;
    },
  };
  target.window = target;
  target.globalThis = target;
  return { target, document, elements, calls, responses, timers, invoke };
}

function enqueue(
  responses: Map<string, unknown[]>,
  command: string,
  ...values: unknown[]
): void {
  responses.get(command)?.push(...values);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function editorSnapshot(editor: FakeElement): unknown {
  return editor.children.map((group) => ({
    className: group.className,
    children: group.children.map((row) => ({
      className: row.className,
      text: row.textContent,
      children: row.children.map((child) => ({
        tag: child.tagName,
        className: child.className,
        text: child.textContent,
        value: child.value,
        placeholder: child.placeholder,
        checked: child.checked,
        children: child.children.map((nested) => ({
          tag: nested.tagName,
          className: nested.className,
          text: nested.textContent,
          checked: nested.checked,
          children: nested.children.map((deep) => ({
            text: deep.textContent,
            className: deep.className,
          })),
        })),
      })),
    })),
  }));
}

function state(view: ReturnType<typeof fixture>): unknown {
  return {
    modal: [...(view.elements["book-organization-modal"]?.classList.values ?? [])],
    infoModal: [...(view.elements["book-info-modal"]?.classList.values ?? [])],
    tagSummary: {
      text: view.elements["book-info-tag-summary"]?.textContent,
      title: view.elements["book-info-tag-summary"]?.title,
    },
    collectionSummary: {
      text: view.elements["book-info-collection-summary"]?.textContent,
      title: view.elements["book-info-collection-summary"]?.title,
    },
    collectionManage: {
      text: view.elements["book-info-collections-manage"]?.textContent,
      title: view.elements["book-info-collections-manage"]?.title,
    },
    tabs: {
      tags: {
        active: view.elements["book-organization-tags-tab"]?.classList.contains("active"),
        selected: view.elements["book-organization-tags-tab"]?.attributes.get("aria-selected"),
        hidden: view.elements["book-organization-tags-panel"]?.hidden,
      },
      collections: {
        active: view.elements["book-organization-collections-tab"]?.classList.contains("active"),
        selected: view.elements["book-organization-collections-tab"]?.attributes.get("aria-selected"),
        hidden: view.elements["book-organization-collections-panel"]?.hidden,
      },
    },
    tags: editorSnapshot(view.elements["book-info-tags"] as FakeElement),
    collections: editorSnapshot(view.elements["book-info-collections"] as FakeElement),
  };
}

function optionRows(editor: FakeElement): FakeElement[] {
  return editor.children[0]?.children.filter(({ className }) => className === "book-info-org-option") ?? [];
}

function createRow(editor: FakeElement): FakeElement | undefined {
  return editor.children.find(({ className }) => className === "book-info-org-create");
}

async function exercise(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else installBookInfoOrganization(view.target);
  const api = view.target.ReaderBookOrganizationUI as BookInfoOrganizationApi;
  let books: OrganizationBook[] = [
    { id: "1", tags: [" 历史  ", "传记"], collections: ["珍藏"] },
    { id: "2", tags: ["历史"], collections: ["待读"] },
  ];
  const changed: unknown[][] = [];
  const opened: string[] = [];
  const alerts: string[] = [];
  const controller = api.init({
    root: view.document as unknown as Document,
    invoke: view.invoke,
    getBooks: () => books,
    onBooksChanged: (list) => {
      changed.push(list);
      books = list as OrganizationBook[];
    },
    openBooklist: (name) => opened.push(name),
    alertAction: (message) => alerts.push(message),
  }) as BookInfoOrganizationController;
  controller.open("1", books[0]);
  const summaries = state(view);
  controller.openManager("tags");
  const openedTags = state(view);

  const tagRows = optionRows(view.elements["book-info-tags"] as FakeElement);
  const historyRow = tagRows.find((row) =>
    row.children[0]?.children[1]?.textContent.startsWith("历史"),
  );
  const historyCheckbox = historyRow?.children[0]?.children[0];
  if (historyCheckbox) historyCheckbox.checked = false;
  const updated = [
    { id: "1", tags: ["传记"], collections: ["珍藏"] },
    books[1] as OrganizationBook,
  ];
  enqueue(view.responses, "set_book_organization", updated);
  await historyCheckbox?.fire("change");
  await settle();
  const membership = state(view);

  const firstTagRow = optionRows(view.elements["book-info-tags"] as FakeElement)[0];
  const rename = firstTagRow?.children[1]?.children.find(({ textContent }) => textContent === "改名");
  await rename?.fire("click");
  const renameInput = firstTagRow?.children[0];
  if (renameInput) renameInput.value = "  人物   传记  ";
  enqueue(view.responses, "rename_book_organization", updated);
  const renameSave = firstTagRow?.children.find(({ textContent }) => textContent === "保存");
  await renameSave?.fire("click");
  await settle();

  enqueue(view.responses, "list_booklists", [
    { id: "empty", name: "空书单" },
    { id: "existing", name: "珍藏" },
  ]);
  controller.openManager("collections");
  await settle();
  const emptyBooklistRow = optionRows(view.elements["book-info-collections"] as FakeElement).find(
    (row) => row.children[0]?.children[1]?.textContent.startsWith("空书单"),
  );
  const collectionRow = optionRows(view.elements["book-info-collections"] as FakeElement).find(
    (row) => row.children[0]?.children[1]?.textContent.startsWith("珍藏"),
  );
  const joinExisting = emptyBooklistRow?.children[1]?.children.find(
    ({ textContent }) => textContent === "加入",
  );
  const joinLabel = {
    text: joinExisting?.textContent,
    title: joinExisting?.title,
  };
  enqueue(view.responses, "set_book_organization", [
    { id: "1", tags: ["传记"], collections: ["珍藏", "空书单"] },
    books[1] as OrganizationBook,
  ]);
  await joinExisting?.fire("click");
  await settle();
  const open = collectionRow?.children[1]?.children.find(({ textContent }) => textContent === "打开");
  await open?.fire("click");
  const remove = collectionRow?.children[1]?.children.find(({ textContent }) => textContent === "删除");
  await remove?.fire("click");
  const armed = { text: remove?.textContent, title: remove?.title, delay: view.timers.at(-1)?.milliseconds };
  enqueue(view.responses, "delete_book_organization", updated);
  await remove?.fire("click");
  await settle();

  controller.openManager("tags");
  const create = createRow(view.elements["book-info-tags"] as FakeElement);
  const createInput = create?.children[0];
  if (createInput) createInput.value = "传记";
  await create?.children[1]?.fire("click");
  const duplicateAlert = [...alerts];
  if (createInput) createInput.value = "新标签";
  enqueue(view.responses, "set_book_organization", new Error("save failed"));
  await create?.children[1]?.fire("click");
  await settle();
  controller.closeManager();
  return {
    api: { keys: Object.keys(api).sort(), frozen: Object.isFrozen(api) },
    controller: { keys: Object.keys(controller).sort(), frozen: Object.isFrozen(controller) },
    summaries,
    openedTags,
    membership,
    armed,
    opened,
    emptyBooklist: {
      visible: Boolean(emptyBooklistRow),
      count: emptyBooklistRow?.children[0]?.children[1]?.textContent,
    },
    joinExisting: joinLabel,
    duplicateAlert,
    alerts,
    calls: view.calls,
    changed,
    closed: state(view),
  };
}

test("book organization strict installer is behavior-equivalent to classic VM", async () => {
  assert.equal(JSON.stringify(await exercise(false)), JSON.stringify(await exercise(true)));
});

test("typed organization transport preserves membership, rename, delete and create behavior", async () => {
  const result = await exercise(false);
  assert.deepEqual(result.api, { keys: ["init"], frozen: true });
  assert.deepEqual(result.controller, {
    keys: ["closeManager", "open", "openManager"],
    frozen: true,
  });
  assert.deepEqual(
    (result.summaries as { readonly tagSummary: unknown }).tagSummary,
    { text: "历史、传记", title: "历史、传记" },
  );
  assert.deepEqual(result.armed, {
    text: "确认删除",
    title: "再次点击会从所有图书中移除",
    delay: 3_000,
  });
  assert.deepEqual(result.opened, ["珍藏"]);
  assert.deepEqual(result.emptyBooklist, { visible: true, count: "空书单（0）" });
  assert.deepEqual(result.joinExisting, {
    text: "加入",
    title: "将这本书加入“空书单”",
  });
  assert.deepEqual(
    (result.summaries as { readonly collectionManage: unknown }).collectionManage,
    { text: "添加到书单", title: "加入现有书单或新建书单" },
  );
  assert.deepEqual(result.duplicateAlert, ["这本书已经加入“传记”。"]);
  assert.equal(result.alerts.at(-1), "保存标签失败：Error: save failed");
  assert.equal(
    result.calls.some(
      ({ command, args }) =>
        command === "set_book_organization" &&
        Array.isArray(args?.collections) &&
        args.collections.includes("空书单"),
    ),
    true,
  );
  assert.equal(
    result.calls.some(
      ({ command, args }) =>
        command === "rename_book_organization" &&
        args?.kind === "tag" &&
        args.newName === "人物 传记",
    ),
    true,
  );
  assert.equal(
    result.calls.some(
      ({ command, args }) =>
        command === "delete_book_organization" && args?.kind === "collection",
    ),
    true,
  );
});

test("book organization installer fails closed without the original runtime", () => {
  assert.equal(installBookInfoOrganization({ document: {} }), null);
});
