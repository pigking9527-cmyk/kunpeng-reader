import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  installBooklistSettingsUi,
  type BooklistSettingsGlobal,
} from "./booklist-settings-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
  public remove(value: string): void {
    this.values.delete(value);
  }
  public toggle(value: string, enabled?: boolean): void {
    if (enabled) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  public type = "";
  public className = "";
  public textContent = "";
  public value = "";
  public disabled = false;
  public focused = false;
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, (event: Event) => void>();
  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener);
  }
  public append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  public replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  public querySelector(selector: string): FakeElement | null {
    return selector === "button" ? this.children.find((node) => node.type === "button") ?? null : null;
  }
  public focus(): void {
    this.focused = true;
  }
  public fire(type: string, target: EventTarget = this as unknown as EventTarget): void {
    this.listeners.get(type)?.({
      target,
      preventDefault: () => undefined,
    } as unknown as Event);
  }
}

function oldSource(): string {
  return execFileSync("git", ["show", "HEAD:ui/booklist-settings-ui.js"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function exercise(legacy: boolean) {
  const ids = [
    "booklist-shortcuts-modal",
    "booklist-shortcuts-open",
    "booklist-shortcuts-close",
    "booklist-shortcuts-create",
    "booklist-shortcuts-name",
    "booklist-shortcuts-list",
    "booklist-shortcuts-status",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["booklist-shortcuts-create"]?.append(
    Object.assign(new FakeElement(), { type: "button" }),
  );
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const booklists = [
    { id: "one", name: "历史", description: "已读", bookIds: [1, 2] },
  ];
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    return booklists as TResult;
  };
  const opened: unknown[] = [];
  const target: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => {
        const node = new FakeElement();
        return node;
      },
    },
    __TAURI__: { core: { invoke } },
    ReaderShelfUI: { openBooklist: (name: unknown) => opened.push(name) },
    AppDialog: { confirm: async () => true },
    confirm: () => true,
  };
  target.window = target;
  target.globalThis = target;
  let api: BooklistSettingsGlobal;
  let restoreDom: (() => void) | null = null;
  if (legacy) {
    vm.runInNewContext(oldSource(), target);
    api = target.ReaderBooklistSettingsUI as BooklistSettingsGlobal;
  } else {
    const transport: TauriTransport = { invoke };
    const names = ["HTMLElement", "HTMLInputElement", "HTMLFormElement", "HTMLButtonElement"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
    Object.defineProperties(
      globalThis,
      Object.fromEntries(names.map((name) => [name, { configurable: true, value: FakeElement }])),
    );
    restoreDom = () => {
      Object.defineProperties(
        globalThis,
        Object.fromEntries(
          names.map((name) => [name, { configurable: true, value: previous[name] }]),
        ),
      );
    };
    api = installBooklistSettingsUi(target, transport) as BooklistSettingsGlobal;
  }
  const instance = api.init({
    root: target.document as Document,
    ...(legacy ? {} : { transport: { invoke } }),
  });
  assert.ok(instance);
  await instance.open();
  const list = elements["booklist-shortcuts-list"];
  const initialRow = list?.children[0];
  initialRow?.children[0]?.fire("click");
  const name = elements["booklist-shortcuts-name"];
  if (name) name.value = "  科幻  ";
  elements["booklist-shortcuts-create"]?.fire("submit");
  for (let index = 0; index < 20 && !calls.some(({ command }) => command === "create_booklist"); index += 1) {
    await Promise.resolve();
  }
  for (let index = 0; index < 20 && name?.value; index += 1) await Promise.resolve();
  const createdState = {
    command: calls.find(({ command }) => command === "create_booklist"),
    nameValue: name?.value,
    statusText: elements["booklist-shortcuts-status"]?.textContent,
    statusError: elements["booklist-shortcuts-status"]?.classList.values.has("error"),
  };
  const refreshedRow = list?.children[0];
  refreshedRow?.children[1]?.fire("click");
  for (let index = 0; index < 20 && !calls.some(({ command }) => command === "delete_booklist"); index += 1) {
    await Promise.resolve();
  }
  for (
    let index = 0;
    index < 20 && elements["booklist-shortcuts-status"]?.textContent !== "已删除书单；下次同步会同步删除。";
    index += 1
  ) {
    await Promise.resolve();
  }
  const deletedState = {
    command: calls.find(({ command }) => command === "delete_booklist"),
    statusText: elements["booklist-shortcuts-status"]?.textContent,
    statusError: elements["booklist-shortcuts-status"]?.classList.values.has("error"),
  };
  const result = {
    initialCommand: calls[0],
    createdState,
    deletedState,
    opened,
    modalShown: elements["booklist-shortcuts-modal"]?.classList.values.has("show"),
    rows: list?.children.map((child) => ({
      className: child.className,
      body: child.children[0]
        ? {
            className: child.children[0].className,
            title: child.children[0].children[0]?.textContent,
            meta: child.children[0].children[1]?.textContent,
          }
        : null,
      remove: child.children[1]?.textContent,
    })),
    apiKeys: Object.keys(api).sort(),
    instanceKeys: Object.keys(instance).sort(),
  };
  restoreDom?.();
  return result;
}

test("booklist settings strict installer is behavior-equivalent to classic VM", async () => {
  assert.equal(JSON.stringify(await exercise(false)), JSON.stringify(await exercise(true)));
});

test("typed installer fails closed without Tauri transport", () => {
  const target = {
    document: { getElementById: () => null } as unknown as Document,
    confirm: () => false,
  };
  const api = installBooklistSettingsUi(target);
  assert.equal(api?.init(), null);
});
