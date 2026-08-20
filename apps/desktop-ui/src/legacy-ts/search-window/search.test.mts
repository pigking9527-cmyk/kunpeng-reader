import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { initializeSearchWindow } from "./search.ts";

type Listener = (event: FakeEvent) => unknown;

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
  public remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
  public contains(name: string): boolean { return this.values.has(name); }
  public toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

interface FakeEvent {
  readonly key: string;
  readonly target: FakeElement;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  preventDefault(): void;
}

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly listeners = new Map<string, Listener[]>();
  public readonly style = { display: "" };
  public className = "";
  public disabled = false;
  public placeholder = "";
  public textContent = "";
  public value = "";
  public parent: FakeElement | null = null;
  public showModalCalls = 0;
  public closeCalls = 0;
  private html = "";

  public constructor(public readonly tagName: string, public readonly id = "") {}
  public get innerHTML(): string { return this.html; }
  public set innerHTML(value: string) {
    this.html = value;
    this.children.splice(0);
  }
  public append(...children: FakeElement[]): void {
    children.forEach((child) => this.appendChild(child));
  }
  public appendChild(child: FakeElement): FakeElement {
    if (child.tagName === "fragment") {
      [...child.children].forEach((entry) => this.appendChild(entry));
      child.children.splice(0);
      return child;
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }
  public insertBefore(child: FakeElement, before: FakeElement): FakeElement {
    if (child.tagName === "fragment") {
      [...child.children].forEach((entry) => this.insertBefore(entry, before));
      child.children.splice(0);
      return child;
    }
    const index = this.children.indexOf(before);
    child.parent = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
  public remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
  public addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  public async fire(type: string, overrides: Partial<FakeEvent> = {}): Promise<void> {
    const event: FakeEvent = {
      key: "",
      target: this,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => undefined,
      ...overrides,
    };
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
  public querySelector(selector: string): FakeElement | null {
    if (selector !== ".qh-text") return null;
    const existing = this.children.find((child) => child.className === "qh-text");
    if (existing) return existing;
    if (!this.innerHTML.includes('class="qh-text"')) return null;
    const generated = new FakeElement("span");
    generated.className = "qh-text";
    this.appendChild(generated);
    return generated;
  }
  public showModal(): void { this.showModalCalls += 1; }
  public close(): void { this.closeCalls += 1; }
}

class FakeDocument {
  public readonly body = new FakeElement("body", "body");
  public readonly elements = new Map<string, FakeElement>();
  public constructor() {
    for (const id of [
      "q", "go", "sort", "summary", "results", "qhistory", "search-alert",
      "search-alert-title", "search-alert-message", "search-alert-ok", "mode-kw",
      "mode-sem", "build-sem", "sem-progress",
    ]) this.elements.set(id, new FakeElement("div", id));
    this.elements.get("sort")!.value = "count";
  }
  public getElementById(id: string): FakeElement | null { return this.elements.get(id) ?? null; }
  public createElement(tagName: string): FakeElement { return new FakeElement(tagName); }
  public createDocumentFragment(): FakeElement { return new FakeElement("fragment"); }
}

interface CommandCall {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function fixture(query = "q=北洋&ids=book-1,book-2") {
  const document = new FakeDocument();
  const storage = new Map<string, string>();
  const calls: CommandCall[] = [];
  const intervals: Array<() => void> = [];
  const eventHandlers = new Map<string, (event: { readonly event: string; readonly id: number; readonly payload: unknown }) => void>();
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      if (command === "shelf_search") {
        return {
          results: [{
            book_id: "book-1",
            title: "北洋史",
            author: "作者",
            count: 2,
            score: 0,
            hits: [{ chapter: 3, snippet: "北洋<军阀", count: 1, score: 0 }],
          }],
          pendingBooks: 0,
        } as TResult;
      }
      if (command === "semantic_status") {
        return { model_ready: true, building: false, total: 1, current: "完成" } as TResult;
      }
      if (command === "semantic_index_done" || command === "warm_semantic_model") {
        return true as TResult;
      }
      if (command === "semantic_search" || command === "shelf_search_book_hits") {
        return [] as TResult;
      }
      return undefined as TResult;
    },
    listen: async (event, handler) => {
      eventHandlers.set(event, handler as (event: { readonly event: string; readonly id: number; readonly payload: unknown }) => void);
      return () => undefined;
    },
  };
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: { search: `?${query}` },
    alert: () => undefined,
    confirm: () => true,
    addEventListener: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    setTimeout: (callback: () => void, timeout = 0) => {
      if (timeout === 0) callback();
      return 1;
    },
    clearTimeout: () => undefined,
    setInterval: (callback: () => void) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval: () => undefined,
  };
  runtime.parent = runtime;
  return { runtime, document, storage, calls, transport, eventHandlers, intervals };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("frozen search-window behavior keeps the original initial keyword flow", async () => {
  const view = fixture();
  const controller = initializeSearchWindow(
    view.runtime as never,
    view.transport,
  );
  await flush();

  assert.ok(Object.isFrozen(controller));
  assert.deepEqual(view.calls.slice(0, 2), [
    {
      command: "shelf_search",
      args: { term: "北洋", ids: ["book-1", "book-2"] },
    },
  ]);
  assert.equal(view.document.elements.get("q")?.value, "北洋");
  assert.equal(view.document.elements.get("summary")?.textContent, "在 1 本书中找到 2 处（限定 2 本）");
  assert.match(view.document.elements.get("results")?.children[0]?.children[1]?.children[0]?.innerHTML ?? "", /<mark>北洋<\/mark>&lt;军阀/u);
  assert.deepEqual(JSON.parse(view.storage.get("shelfSearchHistory") ?? "[]"), ["北洋"]);
  assert.ok(view.eventHandlers.has("shelf-search-query"));
});

test("typed transport preserves exact semantic readiness and search envelopes", async () => {
  const view = fixture("q=");
  const controller = initializeSearchWindow(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  await controller.setMode("sem");
  await controller.runSearch("社会革命");

  assert.deepEqual(view.calls, [
    { command: "semantic_status" },
    { command: "semantic_index_done", args: { ids: null } },
    { command: "warm_semantic_model" },
    { command: "semantic_search", args: { query: "社会革命", ids: null } },
  ]);
  assert.equal(view.document.body.classList.contains("semantic-mode"), true);
  assert.equal(view.document.elements.get("sort")?.style.display, "none");
  assert.equal(view.document.elements.get("q")?.placeholder, "描述你想找的“意思”，回车检索…");
});

test("reused search window event filters ids and issues the unchanged keyword command", async () => {
  const view = fixture("q=");
  initializeSearchWindow(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  view.eventHandlers.get("shelf-search-query")?.({
    event: "shelf-search-query",
    id: 1,
    payload: { term: "湖南", ids: ["book-7", "", "book-9"] },
  });
  await flush();

  assert.deepEqual(view.calls, [{
    command: "shelf_search",
    args: { term: "湖南", ids: ["book-7", "book-9"] },
  }]);
});

test("semantic build action keeps the original command envelope and polling state", async () => {
  const view = fixture("q=");
  initializeSearchWindow(view.runtime as never, view.transport);
  await flush();
  view.calls.splice(0);

  await view.document.elements.get("build-sem")?.fire("click");

  assert.deepEqual(view.calls, [
    { command: "semantic_index_done", args: { ids: null } },
  ]);
  assert.equal(view.document.elements.get("sem-progress")?.textContent, "语义索引已就绪（已完成）");
});
