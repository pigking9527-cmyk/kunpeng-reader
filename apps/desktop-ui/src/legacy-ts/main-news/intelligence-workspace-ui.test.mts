import assert from "node:assert/strict";
import test from "node:test";

import { buildIntelligenceBriefing, installIntelligenceWorkspaceUi } from "./intelligence-workspace-ui.ts";

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
  readonly storage: Map<string, string>;
}

function fixture(response: unknown | ((command: string, args?: Record<string, unknown>) => unknown) = { items: [] }, sources: unknown = [{
  id: "example-source", name: "示例来源", category: "科技", provider: "reader", kind: "news", defaultEnabled: true,
}]): Fixture {
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
    "intelligence-source-directory",
    "intelligence-source-directory-back",
    "intelligence-source-directory-summary",
    "intelligence-source-directory-search",
    "intelligence-source-directory-list",
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
    "interstellar-source-summary",
    "interstellar-source-note",
    "interstellar-source-groups",
    "interstellar-manage-sources",
    "newsnow-page",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const keydown: Listener[] = [];
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const storage = new Map<string, string>();
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
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  elements.set("content-shell", new FakeElement());
  const transport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>): Promise<TResult> => {
      if (command === "newsnow_intelligence_snapshot_get") {
        return (typeof response === "function" ? response(command, args) : null) as TResult;
      }
      if (command === "newsnow_intelligence_snapshot_save") return null as TResult;
      if (args === undefined) calls.push({ command });
      else calls.push({ command, args });
      return (command === "newsnow_sources"
        ? sources
        : typeof response === "function" ? response(command, args) : response) as TResult;
    },
  };
  runtime.transport = transport;
  return { runtime, elements, keydown, calls, storage };
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

test("briefing merges repeated headlines, ranks cross-source evidence and retains topic coverage", () => {
  const now = Date.now();
  const briefing = buildIntelligenceBriefing([
    { title: "聚变推进试验完成验证", source: "研究院 A", category: "科研", summary: "实验数据已公开。", publishedAt: now },
    { title: "聚变推进试验完成验证", source: "研究院 B", category: "科研", summary: "来自独立渠道的同一报道。", publishedAt: now },
    { title: "国际空间政策会议召开", source: "政策观察", category: "制度", summary: "跨国协作议程公布。", publishedAt: now },
  ]);

  assert.equal(briefing.inputCount, 3);
  assert.equal(briefing.uniqueCount, 2);
  assert.equal(briefing.mergedCount, 1);
  assert.equal(briefing.entries[0]?.item.title, "聚变推进试验完成验证");
  assert.deepEqual(briefing.entries[0]?.sourceNames, ["研究院 A", "研究院 B"]);
  assert.deepEqual(briefing.topics.map((topic) => topic.name).sort(), ["制度", "科研"]);
});

test("briefing consolidates differently titled reports of one event but keeps another story separate", () => {
  const now = Date.now();
  const briefing = buildIntelligenceBriefing([
    {
      title: "Aurora Labs completes fusion propulsion test",
      source: "Science Wire",
      category: "科技",
      summary: "Aurora Labs says its fusion propulsion test completed today.",
      publishedAt: now,
    },
    {
      title: "Fusion propulsion test completed by Aurora Labs",
      source: "Independent Space",
      category: "科技",
      summary: "The prototype recorded 14 minutes of stable thrust under vacuum.",
      publishedAt: now - 3_600_000,
    },
    {
      title: "Aurora Labs raises seed funding",
      source: "Startup Watch",
      category: "科技",
      summary: "The company announced a separate funding round.",
      publishedAt: now,
    },
  ]);

  assert.equal(briefing.uniqueCount, 2);
  assert.equal(briefing.mergedCount, 1);
  const propulsion = briefing.entries.find((entry) => String(entry.item.title).includes("propulsion"));
  assert.deepEqual([...(propulsion?.sourceNames ?? [])].sort(), ["Independent Space", "Science Wire"]);
  assert.match(String(propulsion?.item.summary), /14 minutes/);
});

test("briefing normalizes tracking URLs and hides low-priority evidence without deleting it", () => {
  const now = Date.now();
  const briefing = buildIntelligenceBriefing([
    {
      title: "地震预警：沿海地区发布提示",
      source: "Emergency A",
      category: "自然事件",
      url: "https://example.test/alert?id=7&utm_source=reader",
      summary: "官方发布地震预警。",
      publishedAt: now,
    },
    {
      title: "Official alert for coastal residents",
      source: "Emergency B",
      category: "社会",
      url: "https://example.test/alert?id=7&fbclid=tracking",
      summary: "A translated notice for the same official alert.",
      publishedAt: now - 3_600_000,
    },
    {
      title: "午餐菜单更新",
      source: "Local Cafe",
      category: "生活",
      summary: "今日菜单有小幅调整。",
      publishedAt: now - 14 * 24 * 3_600_000,
    },
  ]);

  assert.equal(briefing.uniqueCount, 2);
  assert.equal(briefing.entries.length, 2);
  assert.equal(briefing.visibleEntries.length, 1);
  assert.equal(briefing.hiddenCount, 1);
  assert.deepEqual([...(briefing.visibleEntries[0]?.sourceNames ?? [])].sort(), ["Emergency A", "Emergency B"]);
});

test("workspace opens from the test button, renders existing newsnow data and changes layouts", async () => {
  const view = fixture({
    items: [{
      title: "地震预警测试资讯",
      source: "示例来源",
      category: "科技",
      url: "https://example.test/news",
      summary: "用于验证统一情报中心的既有资讯数据。",
    }],
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  element(view, "intelligence-lab-toolbar-btn").click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(element(view, "intelligence-workspace-page").hidden, false);
  assert.equal(element(view, "content-shell").hidden, true);
  assert.equal((view.runtime.document as { body: FakeElement }).body.classList.values.has("intelligence-workspace-active"), true);
  assert.deepEqual(view.calls, [
    { command: "newsnow_sources" },
    { command: "newsnow_list", args: { request: { sourceIds: ["example-source"] } } },
  ]);
  assert.equal(element(view, "intelligence-digest-list").children.length, 1);
  assert.equal(element(view, "intelligence-signal-list").children.length, 1);
  assert.equal(element(view, "intelligence-context-title").textContent, "地震预警测试资讯");
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

test("workspace presents its shell before starting catalogue work and keeps the hidden source directory lazy", async () => {
  const sources = Array.from({ length: 40 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "reader",
    kind: "news",
  }));
  const view = fixture({ items: [] }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  const opening = api.instance.open();
  assert.equal(element(view, "intelligence-workspace-page").hidden, false);
  assert.equal(element(view, "intelligence-workspace-status").textContent, "正在打开情报中心…");
  assert.deepEqual(view.calls, []);

  await opening;
  assert.equal(element(view, "intelligence-source-directory-list").children.length, 0);
  element(view, "intelligence-open-sources").click();
  assert.equal(element(view, "intelligence-source-directory-list").children.length, sources.length);
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

  element(view, "interstellar-signal-list").children[0]?.click();
  await Promise.resolve();
  assert.deepEqual(openedItem, relevant);
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});

test("briefing entries open their article directly", async () => {
  const item = {
    title: "突发地震预警资讯可直接打开",
    source: "示例来源",
    category: "科技",
    url: "https://example.test/direct-open",
    summary: "简报条目不是只读选择控件。",
  };
  const view = fixture({ items: [item] });
  let openedItem: Record<string, unknown> | null = null;
  let openedOptions: Record<string, unknown> | undefined;
  view.runtime.ReaderNewsUI = {
    instance: {
      openItem: (candidate: Record<string, unknown>, options?: Record<string, unknown>) => {
        openedItem = candidate;
        openedOptions = options;
      },
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-digest-list").children[0]?.click();
  await Promise.resolve();

  assert.deepEqual(openedItem, item);
  assert.deepEqual(openedOptions, { returnToIntelligence: true });
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
  assert.equal(element(view, "intelligence-workspace-status").textContent, "全量来源抓取失败，请检查网络后重试。");
  element(view, "intelligence-open-news").click();
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});

test("workspace expands the catalogue into an all-source request and keeps its source directory separate", async () => {
  const view = fixture({ items: [] }, [
    { id: "ithome", name: "IT之家", category: "科技", provider: "reader", kind: "news", defaultEnabled: true },
    { id: "github", name: "GitHub", category: "技术", provider: "reader", kind: "news", defaultEnabled: true },
    { id: "nasa", name: "NASA", category: "航天", provider: "horizon", kind: "news", defaultEnabled: false },
  ]);
  view.runtime.ReaderNewsUI = {
    instance: {
      sourceRequest: () => ({ sourceIds: ["ithome", "github"], tiebaBars: [] }),
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  assert.deepEqual(view.calls, [
    { command: "newsnow_sources" },
    {
      command: "newsnow_list",
      args: { request: { sourceIds: ["ithome", "github", "nasa"], tiebaBars: [] } },
    },
  ]);

  assert.equal(element(view, "intelligence-source-directory-list").children.length, 0);

  element(view, "intelligence-open-sources").click();
  await Promise.resolve();
  assert.equal(element(view, "intelligence-workspace-page").hidden, false);
  assert.equal(element(view, "intelligence-source-directory").hidden, false);
  assert.equal(element(view, "intelligence-standard-view").hidden, true);
  assert.equal(element(view, "intelligence-source-directory-list").children.length, 3);
  assert.match(element(view, "intelligence-source-directory-summary").textContent, /不读取资讯页的个人启用设置/);

  element(view, "intelligence-source-directory-back").click();
  assert.equal(element(view, "intelligence-source-directory").hidden, true);
  assert.equal(element(view, "intelligence-standard-view").hidden, false);
});

test("workspace publishes an incremental briefing after each protected source batch", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const view = fixture({ items: [{ title: "批次资讯", source: "来源 1", category: "科技" }], sourceCount: 12 }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  const collectionCalls = view.calls.filter((call) => call.command === "newsnow_list");
  assert.equal(collectionCalls.length, 2);
  assert.deepEqual(collectionCalls[0]?.args, {
    request: { sourceIds: sources.slice(0, 12).map((source) => source.id) },
  });
  assert.deepEqual(collectionCalls[1]?.args, {
    request: { sourceIds: sources.slice(12).map((source) => source.id) },
  });
  assert.match(element(view, "intelligence-workspace-status").textContent, /全量资料库已完成/);
});

test("workspace keeps a completed directory on reopening until the user refreshes", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const view = fixture((_command: string, args?: Record<string, unknown>) => {
    const sourceIds = ((args?.request as Record<string, unknown> | undefined)?.sourceIds ?? []) as string[];
    return {
      items: sourceIds.map((sourceId) => ({
        title: `${sourceId} 的资讯`, source: sourceId, sourceId, category: "科技", url: `https://example.test/${sourceId}`,
      })),
      sourceCount: sourceIds.length,
    };
  }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  assert.equal(view.calls.filter((call) => call.command === "newsnow_list").length, 2);
  assert.ok(view.storage.get("kunpeng.reader.intelligence.snapshot.v1"));

  api.instance.close({ focus: false });
  await api.instance.open();
  const collectionCalls = view.calls.filter((call) => call.command === "newsnow_list");
  assert.equal(collectionCalls.length, 2);
  assert.match(element(view, "intelligence-workspace-status").textContent, /不会重新抓取/);
});

test("workspace prefers a completed native snapshot over a stale WebView copy", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const sourceIds = sources.map((source) => source.id);
  const view = fixture((command: string) => {
    if (command === "newsnow_intelligence_snapshot_get") {
      return {
        version: 1,
        sourceIds,
        items: [{ title: "完整快照资讯", source: "来源 1", category: "科技", url: "https://example.test/full" }],
        attemptedSources: sourceIds.length,
        failedSources: 0,
        nextBatch: 0,
        completed: true,
        updatedAt: 200,
      };
    }
    return { items: [] };
  }, sources);
  view.storage.set("kunpeng.reader.intelligence.snapshot.v1", JSON.stringify({
    version: 1,
    sourceIds,
    items: [],
    attemptedSources: 300,
    failedSources: 0,
    nextBatch: 25,
    completed: false,
    updatedAt: 100,
  }));
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  assert.equal(view.calls.filter((call) => call.command === "newsnow_list").length, 0);
  assert.match(element(view, "intelligence-workspace-status").textContent, /已加载完整资料库/);

  api.instance.close({ focus: false });
  await api.instance.open();
  assert.equal(view.calls.filter((call) => call.command === "newsnow_list").length, 0);
});

test("interstellar view exposes active source coverage without treating it as progress", async () => {
  const view = fixture({ items: [] }, [
    { id: "nasa", name: "NASA", category: "航天", provider: "horizon", kind: "news", defaultEnabled: false },
    { id: "arxiv-physics", name: "arXiv Physics", category: "科研", provider: "reader", kind: "news", defaultEnabled: false },
    { id: "games", name: "游戏星空", category: "游戏", provider: "reader", kind: "news", defaultEnabled: true },
  ]);
  view.runtime.ReaderNewsUI = {
    instance: {
      sourceRequest: () => ({ sourceIds: ["nasa", "arxiv-physics"], tiebaBars: [] }),
    },
  };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-layout-interstellar").click();

  assert.equal(element(view, "interstellar-source-summary").textContent, "情报中心已纳入 3 / 3 个来源；2 个进入星际候选覆盖");
  assert.equal(element(view, "interstellar-source-groups").children.length, 2);
  assert.match(element(view, "interstellar-source-note").textContent, /不判断可信度，也不计分/);

  element(view, "interstellar-manage-sources").click();
  await Promise.resolve();
  assert.equal(element(view, "intelligence-workspace-page").hidden, false);
  assert.equal(element(view, "intelligence-source-directory").hidden, false);
  assert.equal(element(view, "interstellar-progress-view").hidden, true);
});

test("interstellar source coverage surfaces a generic source only after it yields a candidate signal", async () => {
  const view = fixture({
    items: [{
      title: "星际通信：星链低轨卫星部署更新",
      source: "靠谱新闻",
      category: "综合",
      summary: "SpaceX 的空间基础设施扩展。",
    }],
  }, [
    { id: "kaopu", name: "靠谱新闻", category: "综合", provider: "reader", kind: "news", defaultEnabled: true },
  ]);
  view.runtime.ReaderNewsUI = { instance: { sourceRequest: () => ({ sourceIds: ["kaopu"] }) } };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-layout-interstellar").click();
  assert.equal(element(view, "interstellar-source-summary").textContent, "情报中心已纳入 1 / 1 个来源；1 个进入星际候选覆盖");
  assert.equal(element(view, "interstellar-source-groups").children[0]?.children[0]?.textContent, "当前相关信号 · 1");
});

test("workspace opens a selected item through the existing reader", async () => {
  const view = fixture({
    items: [{
      title: "突发地震预警资讯可打开",
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
    title: "突发地震预警资讯可打开",
    source: "示例来源",
    category: "科技",
    url: "https://example.test/open",
    summary: "验证详情阅读沿用原资讯页。",
  });
  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
});
