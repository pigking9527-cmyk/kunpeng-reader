import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  installReaderNotesUi,
  type ReaderNotesHost,
  type ReaderNotesUiController,
} from "./reader-notes-ui.ts";

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...values: string[]): void {
    values.forEach((value) => this.values.add(value));
  }
  public remove(...values: string[]): void {
    values.forEach((value) => this.values.delete(value));
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
  readonly clientX: number;
  readonly clientY: number;
  stopPropagation(): void;
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly dataset: Record<string, string> = new Proxy<Record<string, string>>({}, {
    set(target, property, value): boolean {
      if (typeof property === "string") target[property] = String(value);
      return true;
    },
  });
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();
  public readonly style: Record<string, string> = {};
  public className = "";
  public hidden = false;
  public parent: FakeElement | null = null;
  public scrollCount = 0;
  public focusCount = 0;
  public textContent = "";
  public title = "";
  public value = "";
  private html = "";

  public constructor(
    public readonly tagName: string,
    public readonly id = "",
    public readonly fragment = false,
  ) {}

  public get innerHTML(): string {
    return this.html;
  }
  public set innerHTML(value: string) {
    this.html = value;
    this.children.splice(0).forEach((child) => {
      child.parent = null;
    });
  }
  public get isConnected(): boolean {
    return this.parent !== null;
  }
  public append(...children: FakeElement[]): void {
    children.forEach((child) => this.appendChild(child));
  }
  public appendChild(child: FakeElement): FakeElement {
    if (child.fragment) {
      [...child.children].forEach((entry) => this.appendChild(entry));
      child.children.splice(0);
      return child;
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }
  public remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
  public addEventListener(type: string, listener: (event: FakeEvent) => unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  public async fire(type: string, target: FakeElement = this): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({
        target,
        clientX: 50,
        clientY: 50,
        stopPropagation: () => undefined,
      });
    }
  }
  public focus(): void {
    this.focusCount += 1;
  }
  public scrollIntoView(): void {
    this.scrollCount += 1;
  }
  public querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const className = selector.startsWith(".") ? selector.slice(1) : "";
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (
          className &&
          (child.classList.contains(className) || child.className.split(/\s+/u).includes(className))
        ) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  public querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  public readonly elements: Record<string, FakeElement>;
  public constructor() {
    const ids = [
      "toc-pane",
      "bm-pane",
      "tab-toc",
      "tab-bm",
      "toc-btn",
      "backdrop",
      "gear-btn",
      "prev-btn",
      "next-btn",
      "bm-list2",
      "bm-add2",
      "anno-modal",
      "anno-list",
      "hl-btn",
      "anno-close",
    ];
    this.elements = Object.fromEntries(ids.map((id) => [id, new FakeElement("div", id)]));
  }
  public getElementById(id: string): FakeElement | null {
    return this.elements[id] ?? null;
  }
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
  public createDocumentFragment(): FakeElement {
    return new FakeElement("fragment", "", true);
  }
}

interface Call {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

interface ShellFixture {
  readonly OVERLAY: { readonly TOC: string; readonly SETTINGS: string; readonly ANNOTATIONS: string };
  readonly open: Set<string>;
  readonly lifecycle: Map<string, { readonly onOpen: () => void }>;
  closeCount: number;
  setOverlay(name: string, open: boolean): void;
  registerOverlay(name: string, lifecycle: { readonly onOpen: () => void }): void;
  isOverlay(name: string): boolean;
  closeOverlay(): void;
}

function createShell(): ShellFixture {
  return {
    OVERLAY: { TOC: "toc", SETTINGS: "settings", ANNOTATIONS: "annotations" },
    open: new Set<string>(),
    lifecycle: new Map<string, { readonly onOpen: () => void }>(),
    closeCount: 0,
    setOverlay(name, open): void {
      if (open) {
        this.open.add(name);
        this.lifecycle.get(name)?.onOpen();
      } else {
        this.open.delete(name);
      }
    },
    registerOverlay(name, lifecycle): void {
      this.lifecycle.set(name, lifecycle);
    },
    isOverlay(name): boolean {
      return this.open.has(name);
    },
    closeOverlay(): void {
      this.open.clear();
      this.closeCount += 1;
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function responses() {
  return new Map<string, unknown[]>([
    ["add_bookmark", [[{ chapter: 2, frac: 0.4, label: "saved" }]]],
    ["remove_bookmark", [[]]],
    [
      "add_highlight",
      [
        [{ chapter: 2, text: "<new>", note: "" }],
        [{ chapter: 2, text: "draft", note: "" }],
      ],
    ],
    ["set_highlight_text", [[{ chapter: 2, text: "draft", corrected_text: "fixed", note: "" }]]],
    ["remove_highlight", [[]]],
    ["set_highlight_note", [[{ chapter: 2, text: "<new>", note: "memo" }]]],
  ]);
}

function createRuntime() {
  const document = new FakeDocument();
  const shell = createShell();
  const calls: Call[] = [];
  const messages: Record<string, unknown>[] = [];
  const commandResponses = responses();
  let now = 0;
  const invoke = <TResult,>(command: string, args?: Record<string, unknown>): Promise<TResult> => {
    calls.push(args === undefined ? { command } : { command, args: clone(args) });
    const queue = commandResponses.get(command) ?? [];
    return Promise.resolve(clone(queue.shift()) as TResult);
  };
  const host: ReaderNotesHost = {
    currentChapter: 2,
    currentProgress: 44.25,
    currentChapterFraction: 0.4,
    currentReadingAnchor: { dom_path: "p:1" },
    pdf: false,
    sendToPage(message): void {
      messages.push(clone(message));
    },
    setSettingsOpen(open): void {
      shell.setOverlay(shell.OVERLAY.SETTINGS, open);
    },
  };
  const runtime = {
    document: document as unknown as Document,
    ReaderShell: shell,
    ReaderI18n: { t: (key: string) => key },
    ReaderSettings: { clickActionAt: () => "center" },
    innerWidth: 100,
    innerHeight: 100,
    performance: { now: () => ++now },
    requestIdleCallback: (callback: (deadline: { timeRemaining(): number }) => void) => {
      callback({ timeRemaining: () => 10 });
      return 1;
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    rememberReaderJumpPosition: () => undefined,
    keepImmersiveBarAfterNav: () => undefined,
    pauseReadTracking: () => undefined,
    toggleReaderToolbar: () => undefined,
  };
  const transport: TauriTransport = { invoke };
  return { document, shell, calls, messages, host, runtime, transport, invoke };
}

function elementSnapshot(element: FakeElement): unknown {
  return {
    className: element.className,
    classes: [...element.classList.values].sort(),
    dataset: { ...element.dataset },
    hidden: element.hidden,
    html: element.innerHTML,
    style: { ...element.style },
    text: element.textContent,
    title: element.title,
    value: element.value,
    children: element.children.map(elementSnapshot),
  };
}

function uiSnapshot(document: FakeDocument): unknown {
  return Object.fromEntries(
    ["toc-pane", "bm-pane", "bm-list2", "anno-list"].map((id) => [
      id,
      elementSnapshot(document.elements[id] as FakeElement),
    ]),
  );
}

function typedHarness(): ReturnType<typeof createRuntime> & { readonly api: ReaderNotesUiController } {
  const fixture = createRuntime();
  const api = installReaderNotesUi(fixture.runtime, fixture.transport, fixture.host);
  assert.ok(api);
  return { ...fixture, api };
}

const snapshot = {
  bookmarks: [{ chapter: 1, frac: 0.25, label: "第 2 章" }],
  highlights: [{ chapter: 1, text: "<quoted>&", note: "memo" }],
};
const toc = [
  { chapter: 0, level: 0, label: "第一章", frag: "a" },
  { chapter: 2, level: 1, label: "第三章", frag: "b" },
];

test("reader notes preserves the frozen original TOC, bookmark and annotation DOM contract", () => {
  const typed = typedHarness();
  typed.api.initializeReaderNotes(snapshot);
  typed.api.scheduleTocBuild(toc);
  typed.api.openAnnotations(0, true);
  assert.deepEqual(uiSnapshot(typed.document), {
    "toc-pane": {
      className: "", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
      children: [
        {
          className: "toc-item", classes: [], dataset: { chapter: "0", frag: "a" }, hidden: false,
          html: "", style: { paddingLeft: "8px" }, text: "第一章", title: "第一章", value: "", children: [],
        },
        {
          className: "toc-item", classes: [], dataset: { chapter: "2", frag: "b" }, hidden: false,
          html: "", style: { paddingLeft: "22px" }, text: "第三章", title: "第三章", value: "", children: [],
        },
      ],
    },
    "bm-pane": {
      className: "", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "", children: [],
    },
    "bm-list2": {
      className: "", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
      children: [{
        className: "bm-item", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
        children: [
          { className: "bm-text", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "第 2 章", title: "", value: "", children: [] },
          { className: "bm-del", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "✕", title: "", value: "", children: [] },
        ],
      }],
    },
    "anno-list": {
      className: "", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
      children: [{
        className: "anno-item", classes: ["annotation-added", "target"], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
        children: [
          {
            className: "anno-meta", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
            children: [
              { className: "anno-ch", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "第 {chapter} 章 · 跳转", title: "", value: "", children: [] },
              { className: "anno-edit-btn", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "编辑批注", title: "", value: "", children: [] },
              { className: "anno-del", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "删除", title: "", value: "", children: [] },
            ],
          },
          { className: "anno-ctx", classes: [], dataset: {}, hidden: false, html: "&lt;quoted&gt;&amp;", style: {}, text: "", title: "高亮文字", value: "", children: [] },
          { className: "anno-note-view", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "memo", title: "", value: "", children: [] },
          {
            className: "anno-edit", classes: ["open"], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
            children: [
              { className: "anno-note", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "memo", children: [] },
              {
                className: "anno-edit-actions", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "", title: "", value: "",
                children: [
                  { className: "cancel", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "取消", title: "", value: "", children: [] },
                  { className: "save", classes: [], dataset: {}, hidden: false, html: "", style: {}, text: "保存", title: "", value: "", children: [] },
                ],
              },
            ],
          },
        ],
      }],
    },
  });
});

test("reader notes typed commands keep the frozen request envelopes and page messages", async () => {
  const typed = typedHarness();
  typed.api.initializeReaderNotes(snapshot);
  await typed.document.elements["bm-add2"]?.fire("click");
  const request = {
    chapter: 2,
    start: 4,
    end: 8,
    text: "<new>",
    context: "context",
    rects: "[]",
    color: "g",
    range_anchor: { start: 4 },
  };
  await typed.api.addHighlight(request, "", false, true);
  await typed.api.addCorrectedHighlight(request, " fixed ");
  assert.deepEqual(typed.calls, [
    {
      command: "add_bookmark",
      args: {
        chapter: 2,
        frac: 0.4,
        label: "第 {chapter} {part} · {progress}%",
        position: { chapter: 2, anchor: { dom_path: "p:1" }, fraction: 0.4 },
      },
    },
    {
      command: "add_highlight",
      args: { request: { chapter: 2, start: 4, end: 8, text: "<new>", context: "context", rects: "[]", color: "g", note: "", rangeAnchor: { start: 4 } } },
    },
    {
      command: "add_highlight",
      args: { request: { chapter: 2, start: 4, end: 8, text: "<new>", context: "context", rects: "[]", color: "g", note: "", rangeAnchor: { start: 4 } } },
    },
    { command: "set_highlight_text", args: { index: 0, text: "fixed" } },
  ]);
  assert.deepEqual(typed.messages, [
    { highlights: [{ chapter: 2, text: "<new>", note: "" }] },
    { editHighlightTextFor: 0 },
    { highlights: [{ chapter: 2, text: "draft", corrected_text: "fixed", note: "" }] },
  ]);
  assert.equal(typed.document.elements["bm-list2"]?.children[0]?.children[0]?.textContent, "saved");
});

test("reader notes keeps cross-script bookmark/highlight globals live", () => {
  const typed = typedHarness();
  const runtime = typed.runtime as Record<string, unknown>;
  runtime.bookmarks = [{ chapter: 5, label: "external bookmark" }];
  typed.api.renderBookmarks();
  assert.equal(typed.document.elements["bm-list2"]?.children[0]?.children[0]?.textContent, "external bookmark");
  runtime.highlights = [{ chapter: 4, text: "external highlight", note: "" }];
  typed.api.openAnnotations();
  assert.equal(
    typed.document.elements["anno-list"]?.children[0]?.children[1]?.innerHTML,
    "external highlight",
  );
});

test("reader notes installer fails closed without the classic page or Tauri transport", () => {
  const transport: TauriTransport = {
    invoke: <TResult,>() => Promise.resolve(undefined as TResult),
  };
  assert.equal(installReaderNotesUi({}, transport), null);
  const fixture = createRuntime();
  assert.equal(installReaderNotesUi(fixture.runtime, undefined, fixture.host), null);
});
