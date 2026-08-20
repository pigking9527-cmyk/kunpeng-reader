import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installReaderCrossSearchUi } from "./reader-cross-search-ui.ts";

class TestClassList {
  readonly values = new Set<string>();
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class TestEvent {
  readonly target: TestElement | null;
  readonly key?: string;
  defaultPrevented = false;
  propagationStopped = false;
  constructor(target: TestElement | null = null, key?: string) {
    this.target = target;
    if (key !== undefined) this.key = key;
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

interface TestListener {
  readonly type: string;
  readonly callback: (event: TestEvent) => void;
}

class TestElement {
  className = "";
  textContent = "";
  private html = "";
  value = "";
  placeholder = "";
  readonly classList = new TestClassList();
  readonly children: TestElement[] = [];
  readonly listeners: TestListener[] = [];
  focusCount = 0;
  selectCount = 0;

  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    if (value === "") this.children.length = 0;
  }

  appendChild(child: TestElement): TestElement {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
    const listener = typeof callback === "function"
      ? callback as unknown as (event: TestEvent) => void
      : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
    this.listeners.push({ type, callback: listener });
  }
  dispatch(type: string, event = new TestEvent(this)): TestEvent {
    for (const listener of this.listeners.filter((value) => value.type === type)) {
      listener.callback(event);
    }
    return event;
  }
  focus(): void { this.focusCount += 1; }
  select(): void { this.selectCount += 1; }
}

class TestFragment extends TestElement {}

interface InvokeRecord {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
}

interface TimerRecord {
  readonly callback: () => void;
  readonly delay: number;
}

interface Harness {
  readonly runtime: Record<string, unknown>;
  readonly transport: TauriTransport;
  readonly elements: Map<string, TestElement>;
  readonly storage: Map<string, string>;
  readonly invokes: InvokeRecord[];
  readonly responses: Map<string, unknown>;
  readonly failures: Map<string, unknown>;
  readonly overlays: boolean[];
  readonly pauses: string[];
  readonly timeouts: TimerRecord[];
  readonly intervals: TimerRecord[];
  readonly clearedIntervals: unknown[];
  readonly windowListeners: TestListener[];
}

function createHarness(options: { readonly returnButton?: boolean } = {}): Harness {
  const ids = [
    "cross-modal", "cross-title", "cross-input", "cross-status", "cross-results",
    "cross-close", "cross-run",
  ];
  if (options.returnButton !== false) ids.push("cross-return");
  const elements = new Map(ids.map((id) => [id, new TestElement()]));
  const storage = new Map<string, string>();
  const invokes: InvokeRecord[] = [];
  const responses = new Map<string, unknown>();
  const failures = new Map<string, unknown>();
  const overlays: boolean[] = [];
  const pauses: string[] = [];
  const timeouts: TimerRecord[] = [];
  const intervals: TimerRecord[] = [];
  const clearedIntervals: unknown[] = [];
  const windowListeners: TestListener[] = [];
  const runtime: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new TestElement(),
      createDocumentFragment: () => new TestFragment(),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    currentBookId: "book-origin",
    curChapter: 6,
    ReaderI18n: { t: (key: string) => key },
    ReaderShell: {
      OVERLAY: { CROSS_SEARCH: "cross-search" },
      setOverlay: (_name: string, open: boolean) => overlays.push(open),
    },
    readerDebugSettingOn: () => true,
    pauseReadTracking: (reason: string) => pauses.push(reason),
    addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
      const listener = typeof callback === "function"
        ? callback as unknown as (event: TestEvent) => void
        : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
      windowListeners.push({ type, callback: listener });
    },
    setTimeout: (callback: () => void, delay: number) => {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    setInterval: (callback: () => void, delay: number) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    clearInterval: (id: unknown) => clearedIntervals.push(id),
  };
  const transport: TauriTransport = {
    async invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
      invokes.push({ command, args });
      if (failures.has(command)) throw failures.get(command);
      return responses.get(command) as TResult;
    },
  };
  return {
    runtime, transport, elements, storage, invokes, responses, failures, overlays, pauses,
    timeouts, intervals, clearedIntervals, windowListeners,
  };
}

function install(harness: Harness) {
  const api = installReaderCrossSearchUi(harness.runtime as never, harness.transport);
  assert.ok(api);
  return api;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function firstBook(api: ReturnType<typeof install>): TestElement {
  const fragment = (api.crossResults as unknown as TestElement).children[0];
  assert.ok(fragment);
  const book = fragment.children[0];
  assert.ok(book);
  return book;
}

test("installer freezes the classic API and wires the original DOM surface", () => {
  const harness = createHarness();
  const api = install(harness);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), [
    "crossModal", "crossTitle", "crossInput", "crossStatus", "crossResults", "crossRun",
    "crossReturn", "updateCrossReturnButton", "consumePendingCrossSearch", "openCrossSearch",
    "openSemanticSearch", "runCrossSearch",
  ]);
  for (const key of [
    "updateCrossReturnButton", "consumePendingCrossSearch", "openCrossSearch", "openSemanticSearch",
  ] as const) assert.equal(harness.runtime[key], api[key]);
  assert.equal(harness.elements.get("cross-close")?.listeners.length, 1);
  assert.equal(harness.elements.get("cross-modal")?.listeners.length, 1);
  assert.equal(harness.elements.get("cross-run")?.listeners.length, 1);
  assert.equal(harness.elements.get("cross-input")?.listeners.length, 1);
  assert.deepEqual(harness.timeouts.map(({ delay }) => delay), [400, 900]);
  assert.deepEqual(harness.intervals.map(({ delay }) => delay), [250]);
  assert.deepEqual(harness.windowListeners.map(({ type }) => type), ["reader-language-changed"]);

  const missing = createHarness();
  missing.elements.delete("cross-results");
  assert.equal(installReaderCrossSearchUi(missing.runtime as never, missing.transport), null);
});

test("keyword mode preserves normalization, grouped rendering, escaping, expansion, and navigation", async () => {
  const harness = createHarness();
  const hits = Array.from({ length: 10 }, (_, chapter) => ({
    chapter,
    snippet: chapter === 0 ? "前<&Key后" : `Key-${chapter}`,
  }));
  harness.responses.set("shelf_search", {
    results: [{ book_id: "book-target", title: "目标<&", author: "作者>", count: 10, hits }],
    pendingBooks: 2,
  });
  const api = install(harness);
  await api.runCrossSearch("  Key \n  ");
  assert.deepEqual(harness.invokes[0], {
    command: "shelf_search", args: { term: "Key", ids: null },
  });
  assert.equal(api.crossInput.value, "Key");
  assert.equal(api.crossStatus.textContent, "{books} 本 · {hits} 处；{count} 本正在后台建立全文索引");
  const book = firstBook(api);
  assert.equal(book.className, "cross-book");
  assert.match(book.children[0]?.innerHTML ?? "", /目标&lt;&amp;/);
  assert.match(book.children[0]?.innerHTML ?? "", /作者&gt;/);
  assert.equal(book.children.length, 10); // head + 8 hits + more
  assert.match(book.children[1]?.innerHTML ?? "", /前&lt;&amp;<mark>Key<\/mark>后/);

  book.children.at(-1)?.dispatch("click");
  const expandedBook = firstBook(api);
  assert.equal(expandedBook.children.length, 11); // head + all 10 hits
  expandedBook.children[0]?.dispatch("click");
  assert.equal(firstBook(api).className, "cross-book collapsed");
  firstBook(api).children[1]?.dispatch("click");
  await flush();
  assert.deepEqual(harness.invokes.at(-1), {
    command: "open_book_at",
    args: { request: { id: "book-target", chapter: 0, term: "Key" } },
  });
  const returnState = JSON.parse(harness.storage.get("crossReturnState") ?? "null") as Record<string, unknown>;
  assert.equal(returnState.originBookId, "book-origin");
  assert.equal(returnState.originChapter, 6);
  assert.equal(returnState.targetBookId, "book-target");
  assert.equal(returnState.term, "Key");
});

test("semantic mode warms the model, clamps scores, and never highlights snippets", async () => {
  const harness = createHarness();
  harness.responses.set("warm_semantic_model", undefined);
  harness.responses.set("semantic_search", [{
    book_id: "semantic-book",
    hits: [{ chapter: 2, score: 1.8, snippet: "相似<&文本" }],
  }]);
  const api = install(harness);
  api.openSemanticSearch("  相似  ");
  await flush();
  assert.deepEqual(harness.invokes.slice(0, 2), [
    { command: "warm_semantic_model", args: undefined },
    { command: "semantic_search", args: { query: "相似", ids: null } },
  ]);
  assert.deepEqual(harness.pauses, ["semantic-search"]);
  assert.deepEqual(harness.overlays, [true]);
  assert.equal(api.crossTitle.textContent, "相似语义");
  assert.equal(api.crossRun.textContent, "查找");
  assert.equal(api.crossInput.placeholder, "输入字、词、句、段，查找全书架相似文本");
  const hit = firstBook(api).children[1];
  assert.match(hit?.innerHTML ?? "", /相似 \{score\}/);
  assert.match(hit?.innerHTML ?? "", /相似&lt;&amp;文本/);
  assert.doesNotMatch(hit?.innerHTML ?? "", /<mark>/);
  hit?.dispatch("click");
  await flush();
  assert.deepEqual(harness.invokes.at(-1), {
    command: "open_book_at",
    args: { request: { id: "semantic-book", chapter: 2, term: "" } },
  });
});

test("empty, failed, stale, and debug-disabled searches retain their legacy state transitions", async () => {
  const harness = createHarness();
  const api = install(harness);
  await api.runCrossSearch("   ");
  assert.equal(api.crossStatus.textContent, "");
  assert.match(api.crossResults.innerHTML, /输入文字后搜索/);

  harness.failures.set("shelf_search", new Error("失败<&"));
  await api.runCrossSearch("错误");
  assert.equal(api.crossStatus.textContent, "检索失败");
  assert.match(api.crossResults.innerHTML, /Error: 失败&lt;&amp;/);

  const blocked = createHarness();
  blocked.runtime.readerDebugSettingOn = () => false;
  const blockedApi = install(blocked);
  blockedApi.openCrossSearch("不会执行");
  await flush();
  assert.equal(blocked.invokes.length, 0);
  assert.equal(blocked.overlays.length, 0);
  assert.equal(blockedApi.crossInput.value, "");
});

test("return state keeps the first origin, consumes pending searches, retries wrong books, and returns", async () => {
  const harness = createHarness();
  harness.responses.set("shelf_search", [{
    book_id: "book-target", hits: [{ chapter: 4, snippet: "链路" }],
  }]);
  const api = install(harness);
  await api.runCrossSearch("链路");
  firstBook(api).children[1]?.dispatch("click");
  await flush();

  harness.runtime.currentBookId = "book-target";
  api.updateCrossReturnButton();
  assert.equal((api.crossReturn as unknown as TestElement).classList.values.has("show"), true);
  (api.crossReturn as unknown as TestElement).dispatch("click");
  await flush();
  const pending = JSON.parse(harness.storage.get("pendingCrossSearch") ?? "null") as Record<string, unknown>;
  assert.equal(pending.term, "链路");
  assert.equal(pending.originBookId, "book-origin");
  assert.deepEqual(harness.invokes.at(-1), {
    command: "open_book_at",
    args: { request: { id: "book-origin", chapter: 6, term: "" } },
  });

  api.consumePendingCrossSearch();
  assert.equal(harness.timeouts.at(-1)?.delay, 250);
  harness.runtime.currentBookId = "book-origin";
  harness.timeouts.at(-1)?.callback();
  await flush();
  assert.equal(harness.storage.has("pendingCrossSearch"), false);
  assert.equal(harness.invokes.at(-1)?.command, "shelf_search");

  const old = Date.now() - 25 * 60 * 60 * 1_000;
  harness.storage.set("crossReturnState", JSON.stringify({ originBookId: "old", ts: old }));
  api.updateCrossReturnButton();
  assert.equal((api.crossReturn as unknown as TestElement).classList.values.has("show"), false);
});

test("modal, keyboard, timer refresh, and language events preserve lifecycle behavior", async () => {
  const harness = createHarness();
  harness.responses.set("shelf_search", []);
  const api = install(harness);
  api.openCrossSearch("术语");
  await flush();
  assert.deepEqual(harness.pauses, ["cross-search"]);
  assert.equal((api.crossInput as unknown as TestElement).focusCount, 1);
  assert.equal((api.crossInput as unknown as TestElement).selectCount, 1);
  assert.equal(api.crossTitle.textContent, "跨书搜索");

  (api.crossInput as unknown as TestElement).dispatch("keydown", new TestEvent(null, "Escape"));
  assert.equal(harness.overlays.at(-1), false);
  (api.crossModal as unknown as TestElement).dispatch("click", new TestEvent(api.crossModal as unknown as TestElement));
  assert.equal(harness.overlays.at(-1), false);

  harness.runtime.currentBookId = "";
  const interval = harness.intervals[0];
  assert.ok(interval);
  for (let index = 0; index < 12; index += 1) interval.callback();
  assert.deepEqual(harness.clearedIntervals, [1]);

  harness.windowListeners[0]?.callback(new TestEvent());
  assert.equal(api.crossTitle.textContent, "跨书搜索");
});
