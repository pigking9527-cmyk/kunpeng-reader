import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import {
  installSearchUi,
  type SearchUiController,
} from "./search-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

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

class FakeDocument {
  public activeElement: FakeElement | null = null;
  public readonly elements = new Map<string, FakeElement>();

  public createElement(): FakeElement {
    return new FakeElement(this);
  }

  public getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  public add(id: string): FakeElement {
    const element = new FakeElement(this);
    this.elements.set(id, element);
    return element;
  }
}

interface FakeEvent {
  readonly target: FakeElement;
  readonly key: string | undefined;
  readonly defaultPrevented: boolean;
  readonly propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeElement {
  public value = "";
  public checked = false;
  public placeholder = "";
  public tabIndex = 0;
  public className = "";
  public textContent = "";
  public src = "";
  public focused = false;
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  private html = "";

  public constructor(private readonly document: FakeDocument) {}

  public set innerHTML(value: string) {
    this.html = value;
    this.children.splice(0, this.children.length);
  }

  public get innerHTML(): string {
    return this.html;
  }

  public append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  public appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as unknown as (event: FakeEvent) => void);
    this.listeners.set(type, listeners);
  }

  public fire(type: string, target: FakeElement = this, key?: string): FakeEvent {
    let defaultPrevented = false;
    let propagationStopped = false;
    const event = {
      target,
      key,
      get defaultPrevented() {
        return defaultPrevented;
      },
      get propagationStopped() {
        return propagationStopped;
      },
      preventDefault: () => {
        defaultPrevented = true;
      },
      stopPropagation: () => {
        propagationStopped = true;
      },
    } satisfies FakeEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  public focus(): void {
    this.focused = true;
    this.document.activeElement = this;
    this.fire("focus");
  }

  public blur(): void {
    this.focused = false;
    if (this.document.activeElement === this) this.document.activeElement = null;
  }

  public removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

interface TimerRecord {
  readonly id: number;
  readonly delay: number;
  readonly callback: () => void;
}

function classicSource(): string {
  return execFileSync("git", ["show", "HEAD:ui/search-ui.js"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function fixture() {
  const document = new FakeDocument();
  const ids = [
    "search-history",
    "search-wrap",
    "search-input",
    "search-clear",
    "menu",
    "filter-panel",
    "shelf-search-chk",
    "shelf-toggle",
    "shelf-search-modal",
    "shelf-search-frame",
    "search-btn",
  ] as const;
  const elements = Object.fromEntries(ids.map((id) => [id, document.add(id)])) as Record<
    (typeof ids)[number],
    FakeElement
  >;
  elements.menu.classList.add("show");
  elements["filter-panel"].classList.add("show");

  const storage = new Map<string, string>([
    ["searchHistory", JSON.stringify(["旧词", "重复"])],
    ["shelfSearchEnabled", "0"],
  ]);
  const queryWrites: string[] = [];
  let query: unknown = "";
  let refreshes = 0;
  let syncCloses = 0;
  let debugOpens = 0;
  let nextTimerId = 0;
  const timers: TimerRecord[] = [];
  const windowListeners = new Map<string, Array<() => void>>();
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    ReaderAppI18n: {
      t: (key: string) => `译:${key}`,
    },
    ReaderShelfUI: {
      setSearchQuery: (value: string) => {
        query = value;
        queryWrites.push(value);
      },
      getSearchQuery: () => query,
      getSelectedIds: () => ["book 1", "书2"],
      refresh: () => {
        refreshes += 1;
      },
    },
    ReaderSyncUI: {
      close: () => {
        syncCloses += 1;
      },
    },
    openDebugModal: () => {
      debugOpens += 1;
    },
    addEventListener: (type: string, listener: () => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout: (callback: () => void, delay = 0) => {
      nextTimerId += 1;
      timers.push({ id: nextTimerId, delay, callback });
      return nextTimerId;
    },
    clearTimeout: (id?: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  runtime.window = runtime;
  Object.assign(runtime, {
    menuEl: elements.menu,
    filterPanel: elements["filter-panel"],
    searchWrap: elements["search-wrap"],
    searchInput: elements["search-input"],
    searchClear: elements["search-clear"],
  });

  return {
    runtime,
    document,
    elements,
    storage,
    queryWrites,
    timers,
    windowListeners,
    counts: () => ({ refreshes, syncCloses, debugOpens }),
  };
}

function snapshot(view: ReturnType<typeof fixture>) {
  const element = (id: keyof typeof view.elements) => view.elements[id];
  const history = element("search-history");
  return {
    storage: Object.fromEntries(view.storage),
    queryWrites: [...view.queryWrites],
    counts: view.counts(),
    placeholder: element("search-input").placeholder,
    input: element("search-input").value,
    inputTabIndex: element("search-input").tabIndex,
    clearTabIndex: element("search-clear").tabIndex,
    shelfTabIndex: element("shelf-search-chk").tabIndex,
    shelfChecked: element("shelf-search-chk").checked,
    searchOpen: element("search-wrap").classList.contains("open"),
    historyShown: history.classList.contains("show"),
    historyChildren: history.children.map((child) => ({
      className: child.className,
      textContent: child.textContent,
      children: child.children.map((nested) => ({
        className: nested.className,
        textContent: nested.textContent,
      })),
    })),
    modalShown: element("shelf-search-modal").classList.contains("show"),
    frameSrc: element("shelf-search-frame").src,
    menuShown: element("menu").classList.contains("show"),
    filterShown: element("filter-panel").classList.contains("show"),
    timerDelays: view.timers.map((timer) => timer.delay),
  };
}

function exercise(legacy: boolean) {
  const view = fixture();
  let controller: SearchUiController | null = null;
  if (legacy) {
    vm.runInNewContext(classicSource(), view.runtime);
  } else {
    controller = installSearchUi(view.runtime);
  }

  const searchButton = view.elements["search-btn"];
  const searchInput = view.elements["search-input"];
  const shelfCheckbox = view.elements["shelf-search-chk"];
  const modal = view.elements["shelf-search-modal"];
  searchButton.fire("click");
  searchInput.value = " 新词 ";
  searchInput.fire("input");
  searchInput.fire("keydown", searchInput, "Enter");

  shelfCheckbox.checked = true;
  shelfCheckbox.fire("change");
  modal.fire("click");

  searchButton.fire("click");
  searchInput.value = "--debug-ui";
  const debugEvent = searchInput.fire("keydown", searchInput, "Enter");

  searchInput.value = "";
  searchInput.blur();
  view.elements["search-wrap"].fire("mouseenter");
  view.elements["search-wrap"].fire("mouseleave");
  view.timers.at(-1)?.callback();
  view.windowListeners.get("app-language-changed")?.forEach((listener) => listener());

  const apiKeys = [
    "saveHistory",
    "addHistory",
    "renderHistory",
    "showHistory",
    "hideHistory",
    "syncSearchTabStops",
    "updateSearchClear",
    "clearSearchInput",
    "closeSearch",
    "cancelSearchCollapse",
    "maybeCollapseSearch",
    "updateShelfSearchMode",
    "runShelfSearch",
    "closeShelfSearchModal",
  ].filter((key) => typeof view.runtime[key] === "function");

  return {
    ...snapshot(view),
    apiKeys,
    debugPrevented: debugEvent.defaultPrevented,
    controllerFrozen: controller ? Object.isFrozen(controller) : true,
  };
}

test("strict installer remains behavior-equivalent to the original classic script", () => {
  assert.deepEqual(plain(exercise(false)), plain(exercise(true)));
});

test("installer preserves the classic global function surface and freezes its controller", () => {
  const view = fixture();
  const controller = installSearchUi(view.runtime);
  assert.ok(controller);
  assert.ok(Object.isFrozen(controller));
  assert.deepEqual(
    Object.keys(controller).sort(),
    [
      "addHistory",
      "cancelSearchCollapse",
      "clearSearchInput",
      "closeSearch",
      "closeShelfSearchModal",
      "hideHistory",
      "maybeCollapseSearch",
      "renderHistory",
      "runShelfSearch",
      "saveHistory",
      "showHistory",
      "syncSearchTabStops",
      "updateSearchClear",
      "updateShelfSearchMode",
    ],
  );
  for (const [key, value] of Object.entries(controller)) {
    assert.equal(view.runtime[key], value);
  }
});

test("search UI is DOM-only and does not require a Tauri runtime", () => {
  const view = fixture();
  assert.equal("__TAURI__" in view.runtime, false);
  assert.ok(installSearchUi(view.runtime));
});
