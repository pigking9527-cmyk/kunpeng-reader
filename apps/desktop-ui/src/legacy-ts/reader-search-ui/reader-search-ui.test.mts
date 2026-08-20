import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installReaderSearchUi } from "./reader-search-ui.ts";

interface Listener {
  readonly type: string;
  readonly callback: (event: TestEvent) => void;
}

class TestEvent {
  readonly target: ElementMock | null;
  readonly key?: string;
  constructor(target: ElementMock | null = null, key?: string) {
    this.target = target;
    if (key !== undefined) this.key = key;
  }
}

class ElementMock {
  className = "";
  textContent = "";
  innerHTML = "";
  value = "";
  readonly style: Record<string, string> = {};
  readonly children: ElementMock[] = [];
  readonly listeners: Listener[] = [];
  parent: ElementMock | null = null;
  focusCount = 0;

  append(...children: Array<ElementMock | string>): void {
    for (const child of children) {
      if (typeof child === "string") {
        const text = new ElementMock();
        text.textContent = child;
        text.parent = this;
        this.children.push(text);
      } else {
        child.parent = this;
        this.children.push(child);
      }
    }
  }
  appendChild(child: ElementMock): ElementMock { this.append(child); return child; }
  addEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
    const listener = typeof callback === "function"
      ? callback as (event: TestEvent) => void
      : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
    this.listeners.push({ type, callback: listener });
  }
  dispatch(type: string, event = new TestEvent(this)): void {
    for (const listener of this.listeners.filter((item) => item.type === type)) listener.callback(event);
  }
  focus(): void { this.focusCount += 1; }
  contains(candidate: unknown): boolean {
    let element = candidate instanceof ElementMock ? candidate : null;
    while (element) { if (element === this) return true; element = element.parent; }
    return false;
  }
  closest(selector: string): ElementMock | null {
    if (selector === ".search-wrap" && this.className.split(" ").includes("search-wrap")) return this;
    let ancestor = this.parent;
    while (ancestor) {
      if (selector === ".search-wrap" && ancestor.className.split(" ").includes("search-wrap")) return ancestor;
      ancestor = ancestor.parent;
    }
    return null;
  }
}

interface OverlayLifecycle { onOpen(): void; onClose(): void }

interface Harness {
  readonly runtime: Record<string, unknown>;
  readonly elements: Map<string, ElementMock>;
  readonly toolbar: ElementMock;
  readonly lifecycle: OverlayLifecycle;
  readonly overlayCalls: boolean[];
  readonly posts: unknown[];
  readonly invokes: unknown[];
  readonly storage: Map<string, string>;
  readonly timers: Array<{ callback: () => void; delay: number; cleared: boolean }>;
  readonly windowListeners: Listener[];
}

function createHarness(options: { readonly pdf?: boolean } = {}): Harness {
  const ids = ["rsearch", "rsearch-input", "rsearch-count", "rsearch-results", "rsearch-btn", "rsearch-close"];
  const elements = new Map(ids.map((id) => [id, new ElementMock()]));
  const toolbar = new ElementMock();
  toolbar.className = "toolbar";
  const storage = new Map<string, string>();
  const overlayCalls: boolean[] = [];
  const posts: unknown[] = [];
  const invokes: unknown[] = [];
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  const windowListeners: Listener[] = [];
  let activeElement: ElementMock | null = null;
  let lifecycle: OverlayLifecycle = { onOpen() {}, onClose() {} };
  let overlayOpen = false;
  const document = {
    get activeElement() { return activeElement; },
    createElement: () => new ElementMock(),
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === ".toolbar" ? toolbar : null,
  };
  const input = elements.get("rsearch-input");
  if (input) input.focus = () => { input.focusCount += 1; activeElement = input; };
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    location: { href: "tauri://localhost/reader.html" },
    frame: {
      src: "reader://localhost/book/one",
      contentWindow: { postMessage: (message: unknown, origin: string) => posts.push({ message, origin }) },
    },
    isPdf: options.pdf === true,
    ReaderI18n: { t: (key: string) => key },
    ReaderShell: {
      OVERLAY: { SEARCH: "search" },
      isOverlay: () => overlayOpen,
      setOverlay: (_name: string, open: boolean) => { overlayOpen = open; overlayCalls.push(open); },
      registerOverlay: (_name: string, value: OverlayLifecycle) => { lifecycle = value; },
    },
    addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
      const listener = typeof callback === "function"
        ? callback as (event: TestEvent) => void
        : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
      windowListeners.push({ type, callback: listener });
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay, cleared: false });
      return timers.length;
    },
    clearTimeout: (id: number) => { const timer = timers[id - 1]; if (timer) timer.cleared = true; },
  };
  const transport: TauriTransport = {
    async invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
      invokes.push({ command, args });
      return [{ chapter: 2, snippet: "前<&关键词后" }] as TResult;
    },
  };
  runtime.transport = transport;
  return {
    runtime, elements, toolbar,
    get lifecycle() { return lifecycle; },
    overlayCalls, posts, invokes, storage, timers, windowListeners,
  };
}

function install(harness: Harness) {
  const api = installReaderSearchUi(harness.runtime as never, harness.runtime.transport as TauriTransport);
  assert.ok(api);
  return api;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("installer freezes the public API and exposes every legacy cross-script global", () => {
  const harness = createHarness();
  const api = install(harness);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), [
    "rsearch", "rsearchInput", "rsearchCount", "rsearchResults", "sendToPage",
    "renderResults", "runSearch", "toggleSearch", "isReaderSearchEditing",
  ]);
  for (const name of ["rsearch", "rsearchInput", "rsearchCount", "rsearchResults", "sendToPage", "renderResults", "runSearch", "toggleSearch", "isReaderSearchEditing"]) {
    assert.equal(harness.runtime[name], api[name as keyof typeof api]);
  }
  assert.equal(harness.elements.get("rsearch-btn")?.listeners.length, 1);
  assert.equal(harness.elements.get("rsearch-close")?.listeners.length, 1);
  assert.equal(harness.toolbar.listeners.length, 1);
  assert.deepEqual(harness.windowListeners.map(({ type }) => type), ["reader-language-changed"]);

  const missing = createHarness();
  missing.elements.delete("rsearch-results");
  assert.equal(installReaderSearchUi(missing.runtime as never, null), null);
});

test("overlay lifecycle keeps history, focus, editing guard, and clear-marks behavior", () => {
  const harness = createHarness();
  harness.storage.set("rsearchHistory", JSON.stringify(["甲", "乙"]));
  const api = install(harness);
  api.toggleSearch(true);
  harness.lifecycle.onOpen();
  assert.deepEqual(harness.overlayCalls, [true]);
  assert.equal(harness.elements.get("rsearch-input")?.focusCount, 1);
  assert.equal(api.rsearchResults.children.length, 2);
  assert.equal(api.isReaderSearchEditing(), true);
  harness.lifecycle.onClose();
  assert.deepEqual(harness.posts.at(-1), { message: { clearMarks: 1 }, origin: "*" });
  assert.equal(api.rsearchInput.value, "");
  assert.equal(api.rsearchCount.textContent, "");
  assert.equal(api.rsearchResults.innerHTML, "");
});

test("EPUB search uses typed transport, escapes snippets, and preserves result navigation", async () => {
  const harness = createHarness();
  const api = install(harness);
  api.rsearchInput.value = "关键词";
  api.runSearch("  关键词  ");
  await flush();
  assert.deepEqual(harness.invokes, [{ command: "search_book", args: { term: "关键词" } }]);
  assert.equal(api.rsearchCount.textContent, "约 {count} 处");
  const result = api.rsearchResults.children[0];
  assert.equal(result?.children[1]?.innerHTML, "前&lt;&amp;<mark>关键词</mark>后");
  (result as unknown as ElementMock | undefined)?.dispatch("click");
  assert.deepEqual(harness.posts.at(-1), {
    message: { gotoChapter: 2, search: "关键词" },
    origin: "*",
  });
  assert.equal(harness.overlayCalls.at(-1), false);
  assert.equal(harness.storage.get("rsearchHistory"), JSON.stringify(["关键词"]));
});

test("PDF search stays in the frame and valid or opaque frame origins retain legacy routing", () => {
  const harness = createHarness({ pdf: true });
  const api = install(harness);
  api.runSearch("pdf");
  assert.equal(harness.invokes.length, 0);
  assert.deepEqual(harness.posts.at(-1), { message: { search: "pdf" }, origin: "*" });
  const frame = harness.runtime.frame as { src: string };
  frame.src = "reader://localhost/book/two";
  api.sendToPage({ pageTurn: 1 });
  assert.equal((harness.posts.at(-1) as { origin: string }).origin, "*");
  frame.src = "not a url";
  api.sendToPage({ pageTurn: -1 });
  assert.equal((harness.posts.at(-1) as { origin: string }).origin, "*");
});

test("input debounce and IME editing events preserve the 350 ms behavior", () => {
  const harness = createHarness();
  const api = install(harness);
  api.rsearchInput.value = "第一次";
  harness.elements.get("rsearch-input")?.dispatch("input");
  api.rsearchInput.value = "第二次";
  harness.elements.get("rsearch-input")?.dispatch("input");
  assert.deepEqual(harness.timers.map(({ delay, cleared }) => ({ delay, cleared })), [
    { delay: 350, cleared: true },
    { delay: 350, cleared: false },
  ]);
  harness.elements.get("rsearch-input")?.dispatch("compositionstart");
  assert.equal(api.isReaderSearchEditing(), false);
  api.toggleSearch(true);
  assert.equal(api.isReaderSearchEditing(), true);
  harness.elements.get("rsearch-input")?.dispatch("compositionend");
  harness.elements.get("rsearch-input")?.dispatch(
    "keydown",
    new TestEvent(harness.elements.get("rsearch-input") ?? null, "Escape"),
  );
  assert.equal(harness.overlayCalls.at(-1), false);
});
