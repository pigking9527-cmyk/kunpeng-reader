import assert from "node:assert/strict";
import test from "node:test";

import { installIntelligenceWorkspaceUi } from "./intelligence-workspace-ui.ts";

type Listener = (event: { readonly key?: string }) => void;

class FakeClassList {
  public readonly values = new Set<string>();

  public add(value: string): void {
    this.values.add(value);
  }

  public remove(value: string): void {
    this.values.delete(value);
  }
}

class FakeElement {
  public hidden = true;
  public disabled = false;
  public type = "";
  public className = "";
  public textContent = "";
  public readonly dataset: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly children: FakeElement[] = [];
  public readonly classList = new FakeClassList();
  private readonly listeners = new Map<string, Array<() => void>>();

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public querySelectorAll(): FakeElement[] {
    return [];
  }

  public focus(): void {}

  public click(): void {
    this.listeners.get("click")?.forEach((listener) => listener());
  }
}

interface Fixture {
  readonly runtime: Record<string, unknown>;
  readonly elements: Map<string, FakeElement>;
  readonly keydown: Listener[];
  readonly calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }>;
}

function fixture(response: unknown = { items: [] }): Fixture {
  const ids = [
    "intelligence-lab-toolbar-btn",
    "intelligence-workspace-page",
    "intelligence-workspace-back",
    "intelligence-layout-briefing",
    "intelligence-layout-monitor",
    "intelligence-layout-research",
    "intelligence-layout-interstellar",
    "intelligence-refresh",
    "intelligence-open-sources",
    "intelligence-workspace-status",
    "intelligence-digest-list",
    "intelligence-signal-list",
    "intelligence-context-title",
    "intelligence-context-body",
    "intelligence-open-news",
    "intelligence-standard-view",
    "interstellar-progress-view",
    "interstellar-signal-count",
    "interstellar-signal-list",
    "interstellar-context-title",
    "interstellar-context-body",
    "interstellar-open-news",
    "newsnow-page",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const keydown: Listener[] = [];
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const runtime: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => selector === ".content-shell" ? elements.get("content-shell") ?? null : null,
      createElement: () => new FakeElement(),
      body: new FakeElement(),
    },
    addEventListener: (type: string, listener: Listener) => {
      if (type === "keydown") keydown.push(listener);
    },
  };
  elements.set("content-shell", new FakeElement());
  const transport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>): Promise<TResult> => {
      if (args === undefined) calls.push({ command });
      else calls.push({ command, args });
      return response as TResult;
    },
  };
  runtime.transport = transport;
  return { runtime, elements, keydown, calls };
}

function element(view: Fixture, id: string): FakeElement {
  const result = view.elements.get(id);
  assert.ok(result, `missing ${id}`);
  return result;
}

test("installer safely exposes a global even when the test section DOM is unavailable", () => {
  const runtime: Record<string, unknown> = {
    document: { getElementById: () => null },
    addEventListener: () => undefined,
  };
  const api = installIntelligenceWorkspaceUi(runtime);
  assert.ok(api);
  assert.equal(runtime.ReaderIntelligenceWorkspace, api);
  assert.equal(api.instance, null);
});

test("workspace opens from the test button, renders existing newsnow data and changes layouts", async () => {
  const view = fixture({
    items: [{
      title: "一条测试资讯",
      source: "示例来源",
      category: "科技",
      url: "https://example.test/news",
      summary: "用于验证统一情报中心的既有资讯数据。",
    }],
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  element(view, "intelligence-lab-toolbar-btn").click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(element(view, "intelligence-workspace-page").hidden, false);
  assert.equal(element(view, "content-shell").hidden, true);
  assert.equal((view.runtime.document as { body: FakeElement }).body.classList.values.has("intelligence-workspace-active"), true);
  assert.deepEqual(view.calls, [{ command: "newsnow_list", args: { request: {} } }]);
  assert.equal(element(view, "intelligence-digest-list").children.length, 1);
  assert.equal(element(view, "intelligence-signal-list").children.length, 1);
  assert.equal(element(view, "intelligence-context-title").textContent, "一条测试资讯");
  assert.equal(element(view, "intelligence-context-body").textContent, "用于验证统一情报中心的既有资讯数据。");

  element(view, "intelligence-layout-monitor").click();
  assert.equal(element(view, "intelligence-workspace-page").dataset.layout, "monitor");
  assert.equal(element(view, "intelligence-layout-monitor").attributes.get("aria-pressed"), "true");
  assert.equal(element(view, "intelligence-layout-briefing").attributes.get("aria-pressed"), "false");

  element(view, "intelligence-layout-interstellar").click();
  assert.equal(element(view, "intelligence-workspace-page").dataset.layout, "interstellar");
  assert.equal(element(view, "intelligence-standard-view").hidden, true);
  assert.equal(element(view, "interstellar-progress-view").hidden, false);
  assert.equal(element(view, "interstellar-signal-count").textContent, "0 条候选信号");
  assert.equal(element(view, "interstellar-signal-list").children.length, 1);

  view.keydown[0]?.({ key: "Escape" });
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
  assert.equal(element(view, "content-shell").hidden, false);
  assert.equal((view.runtime.document as { body: FakeElement }).body.classList.values.has("intelligence-workspace-active"), false);
});

test("interstellar layout filters relevant space evidence without changing the baseline", async () => {
  const relevant = {
    title: "新型核聚变推进原型完成深空环境测试",
    source: "示例航天机构",
    category: "航天",
    url: "https://example.test/fusion-propulsion",
    summary: "推进系统与高密度能源验证。",
  };
  const view = fixture({
    items: [
      relevant,
      { title: "一款新游戏发布", source: "游戏媒体", category: "游戏" },
      { title: "地方政府推进调查工作", source: "综合新闻", category: "社会" },
      { title: "Autonomous robots for warehouse surveys", source: "Product Hunt", category: "科技" },
    ],
  });
  let openedItem: Record<string, unknown> | null = null;
  view.runtime.ReaderNewsUI = {
    instance: {
      openItem: (item: Record<string, unknown>) => { openedItem = item; },
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-layout-interstellar").click();

  assert.equal(api.instance.layout(), "interstellar");
  assert.equal(element(view, "interstellar-signal-count").textContent, "1 条候选信号");
  assert.equal(element(view, "interstellar-signal-list").children.length, 1);
  assert.equal(element(view, "interstellar-context-title").textContent, relevant.title);
  assert.match(element(view, "interstellar-context-body").textContent, /尚未改变进度/);
  assert.equal(element(view, "interstellar-open-news").disabled, false);
  assert.equal(element(view, "intelligence-workspace-status").textContent, "已从 4 条资讯筛出 1 条候选信号；尚未自动计分。");

  element(view, "interstellar-open-news").click();
  await Promise.resolve();
  assert.deepEqual(openedItem, relevant);
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});

test("workspace retains a Chinese failure state and can return to the original news page", async () => {
  const view = fixture();
  let opened = 0;
  view.runtime.ReaderNewsUI = { instance: { open: () => { opened += 1; } } };
  const failingTransport = {
    invoke: async <TResult,>(): Promise<TResult> => Promise.reject(new Error("offline")),
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, failingTransport);
  assert.ok(api?.instance);
  await api.instance.open();
  assert.equal(element(view, "intelligence-workspace-status").textContent, "资讯加载失败，请检查网络后重试。");
  element(view, "intelligence-open-news").click();
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});

test("workspace uses the reader's current source selection and opens its single source manager", async () => {
  const view = fixture({ items: [] });
  let openedSources = 0;
  view.runtime.ReaderNewsUI = {
    instance: {
      sourceRequest: () => ({ sourceIds: ["ithome", "github"], tiebaBars: [] }),
      openSources: () => { openedSources += 1; },
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  assert.deepEqual(view.calls, [{
    command: "newsnow_list",
    args: { request: { sourceIds: ["ithome", "github"], tiebaBars: [] } },
  }]);

  element(view, "intelligence-open-sources").click();
  await Promise.resolve();
  assert.equal(openedSources, 1);
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});

test("workspace opens a selected item through the existing reader", async () => {
  const view = fixture({
    items: [{
      title: "一条可打开的资讯",
      source: "示例来源",
      category: "科技",
      url: "https://example.test/open",
      summary: "验证详情阅读沿用原资讯页。",
    }],
  });
  let openedItem: Record<string, unknown> | null = null;
  view.runtime.ReaderNewsUI = {
    instance: {
      openItem: (item: Record<string, unknown>) => { openedItem = item; },
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-open-news").click();
  await Promise.resolve();

  assert.deepEqual(openedItem, {
    title: "一条可打开的资讯",
    source: "示例来源",
    category: "科技",
    url: "https://example.test/open",
    summary: "验证详情阅读沿用原资讯页。",
  });
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});
