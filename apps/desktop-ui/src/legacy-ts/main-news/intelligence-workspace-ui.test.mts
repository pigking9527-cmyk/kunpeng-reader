import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntelligenceBriefing,
  hasFreshCompletedSnapshot,
  installIntelligenceWorkspaceUi,
  parseIntelligenceModelBriefs,
  selectIntelligenceBriefCandidates,
} from "./intelligence-workspace-ui.ts";

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
  public value = "";
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

  public emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  public click(): void {
    this.emit("click");
  }
}

interface Fixture {
  readonly runtime: Record<string, unknown>;
  readonly elements: Map<string, FakeElement>;
  readonly keydown: Listener[];
  readonly calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }>;
  readonly snapshotSaves: readonly Record<string, unknown>[];
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
    "intelligence-digest-history",
    "intelligence-digest-history-summary",
    "intelligence-digest-history-date",
    "intelligence-digest-history-previous",
    "intelligence-digest-history-next",
    "intelligence-digest-history-readonly",
    "intelligence-processing-summary",
    "intelligence-briefing-model-status",
    "intelligence-local-model-base-url",
    "intelligence-local-model-name",
    "intelligence-local-model-key",
    "intelligence-local-model-save",
    "intelligence-briefing-count",
    "intelligence-digest-list",
    "intelligence-signal-list",
    "intelligence-context-title",
    "intelligence-context-body",
    "intelligence-context-meta",
    "intelligence-context-reasons",
    "intelligence-context-evidence",
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
  const snapshotSaves: Record<string, unknown>[] = [];
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
      if (command === "newsnow_intelligence_snapshot_save") {
        snapshotSaves.push(args?.snapshot as Record<string, unknown>);
        return null as TResult;
      }
      if (args === undefined) calls.push({ command });
      else calls.push({ command, args });
      return (command === "newsnow_sources"
        ? sources
        : typeof response === "function" ? response(command, args) : response) as TResult;
    },
  };
  runtime.transport = transport;
  return { runtime, elements, keydown, calls, snapshotSaves, storage };
}

function element(view: Fixture, id: string): FakeElement {
  const result = view.elements.get(id);
  assert.ok(result, `missing ${id}`);
  return result;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
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
    { title: "聚变推进试验完成验证", source: "研究院 A", category: "科研", url: "https://example.test/fusion", summary: "实验数据已公开。", publishedAt: now },
    { title: "聚变推进试验完成验证", source: "研究院 B", category: "科研", url: "https://example.test/fusion?utm_source=reader", summary: "来自独立渠道的同一报道。", publishedAt: now },
    { title: "国际空间政策会议召开", source: "政策观察", category: "制度", summary: "跨国协作议程公布。", publishedAt: now },
  ]);

  assert.equal(briefing.inputCount, 3);
  assert.equal(briefing.uniqueCount, 2);
  assert.equal(briefing.mergedCount, 1);
  assert.equal(briefing.entries[0]?.item.title, "聚变推进试验完成验证");
  assert.deepEqual(briefing.entries[0]?.sourceNames, ["研究院 A", "研究院 B"]);
  assert.deepEqual(briefing.topics.map((topic) => topic.name).sort(), ["制度", "科研"]);
});

test("briefing leaves differently titled reports separate until an explicit event judgement", () => {
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

  assert.equal(briefing.uniqueCount, 3);
  assert.equal(briefing.mergedCount, 0);
  assert.equal(briefing.entries.filter((entry) => String(entry.item.title).includes("propulsion")).length, 2);
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

function modelCandidateItems(): Array<Record<string, unknown>> {
  return [
    {
      title: "地震预警：沿海地区发布提示",
      source: "应急来源甲",
      sourceId: "emergency-a",
      category: "自然事件",
      url: "https://example.test/emergency-alert",
      summary: "官方发布的地震预警和沿海避险提示。",
      publishedAt: Date.now(),
    },
    {
      title: "Official coastal earthquake alert",
      source: "Emergency Source B",
      sourceId: "emergency-b",
      category: "社会",
      url: "https://example.test/emergency-alert?utm_source=reader",
      summary: "Independent evidence for the same official coastal alert.",
      publishedAt: Date.now(),
    },
  ];
}

function modelSourceDifferences(
  sources: readonly { readonly name: string }[],
): Array<{ source: string; detail: string }> {
  return sources.map((source, index) => ({
    source: source.name,
    detail: index === 0
      ? "提供了可与其他来源交叉核对的核心事实和背景。"
      : "补充了独立角度，并印证共同事实没有明显冲突。",
  }));
}

test("brief candidates are bounded evidence projections and model parsing rejects invented ids or invalid JSON", () => {
  const candidates = selectIntelligenceBriefCandidates(buildIntelligenceBriefing(modelCandidateItems()), 1);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.match(candidate.id, /^event-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(candidate.sources.length, 2);
  assert.deepEqual(Object.keys(candidate.sources[0] ?? {}).sort(), ["name", "summary", "title", "url"]);
  assert.match(candidate.summary, /官方发布|Independent evidence/);
  assert.match(candidate.sources[0]?.summary ?? "", /官方发布|Independent evidence/);

  const briefs = parseIntelligenceModelBriefs(JSON.stringify({
    briefs: [
      {
        id: candidate.id,
        priority: "P0",
        importance: 91,
        confidence: 0.94,
        headline: "模型确认的沿海预警热点",
        summary: "两个独立来源均指向同一份官方预警。",
        article: "沿海地区发布了新的预警信息。\n\n两个独立来源均指向同一项官方措施。",
        sourceDifferences: modelSourceDifferences(candidate.sources),
        whyItMatters: "需要优先关注更新和影响范围。",
        reasons: ["来源相互独立", "事件时效高"],
      },
      {
        id: "event:invented-by-model",
        priority: "P0",
        importance: 100,
        confidence: 1,
        headline: "模型虚构事件",
        summary: "不得进入页面。",
        whyItMatters: "不得采用。",
      },
    ],
  }), candidates);
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0]?.id, candidate.id);
  assert.equal(parseIntelligenceModelBriefs(JSON.stringify({ briefs: [{
    id: candidate.id,
    priority: "P1",
    importance: 70,
    confidence: 0.8,
    headline: "缺少正文的模型结果",
    summary: "不得伪装成综合报道。",
    whyItMatters: "必须等待可读正文。",
  }] }), candidates).length, 0);
  assert.equal(parseIntelligenceModelBriefs("{not-json", candidates).length, 0);
});

test("model briefs normalize Qwen's bounded ten-point score presentation", () => {
  const candidates = selectIntelligenceBriefCandidates(buildIntelligenceBriefing(modelCandidateItems()), 1);
  const candidate = candidates[0]!;
  const briefs = parseIntelligenceModelBriefs(JSON.stringify({
    briefs: [{
      id: candidate.id,
      priority: "P1",
      importance: 8,
      confidence: 9,
      headline: "多来源事件级标题",
      summary: "两个来源的共同事实已经删重合并。",
      article: "两家来源确认同一项事件正在发展。\n\n后续影响仍需根据官方更新判断。",
      sourceDifferences: modelSourceDifferences(candidate.sources),
      whyItMatters: "可继续关注后续影响。",
      reasons: ["两个来源相互印证"],
    }],
  }), candidates);

  assert.equal(briefs[0]?.importance, 80);
  assert.equal(briefs[0]?.confidence, 0.9);
});

test("configured local model receives only rule candidates and renders its verified hotspot with evidence", async () => {
  let modelRequest: Record<string, unknown> | undefined;
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") {
      return { configured: true, model: "Qwen 27B Q3", baseUrl: "http://127.0.0.1:8080" };
    }
    if (command === "intelligence_generate_brief") {
      modelRequest = args?.request as Record<string, unknown>;
      const candidates = modelRequest?.candidates as Array<Record<string, unknown>>;
      const candidate = candidates[0]!;
      const sources = candidate.sources as Array<{ name: string }>;
      return {
        model: "Qwen 27B Q3",
        content: JSON.stringify({
          briefs: [{
            id: candidate.id,
            priority: "P0",
            importance: 92,
            confidence: 0.96,
            headline: "模型确认的沿海预警热点",
            summary: "两个独立来源均指向同一份官方预警。",
            article: "沿海地区发布新的官方预警。\n\n独立来源对影响范围的描述一致。",
            sourceDifferences: modelSourceDifferences(sources),
            whyItMatters: "需要优先关注更新和影响范围。",
            reasons: ["来源相互独立", "事件时效高"],
            notify: true,
          }],
        }),
      };
    }
    return { items: modelCandidateItems() };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  const candidates = modelRequest?.candidates as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 1);
  assert.deepEqual(Object.keys(candidates[0] ?? {}).sort(), ["id", "publishedAt", "sources", "summary", "title"]);
  assert.equal("entry" in (candidates[0] ?? {}), false);
  assert.equal(element(view, "intelligence-briefing-model-status").textContent, "已生成每日简报 · Qwen 27B Q3");
  assert.match(element(view, "intelligence-briefing-count").textContent, /已编辑 1 \/ 1 条重要资讯/);
  assert.equal(element(view, "intelligence-context-title").textContent, "模型确认的沿海预警热点");
  assert.equal(element(view, "intelligence-context-reasons").children.length, 2);
  assert.equal(element(view, "intelligence-context-evidence").children.length, 2);
});

test("different issuers are never sent to the event judge as one financial report", async () => {
  let judgeCalls = 0;
  const modelCandidates: Array<Record<string, unknown>> = [];
  const items = [
    { title: "突发：科沃斯 2026 年半年度归母净利润 12.48 亿元", source: "财经甲", category: "财经", summary: "科沃斯披露半年报。", publishedAt: Date.now() },
    { title: "突发：紫金矿业(601899.SH)上半年净利润391.70亿元", source: "财经乙", category: "财经", summary: "紫金矿业披露半年报。", publishedAt: Date.now() },
  ];
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") return { configured: true, model: "Qwen 27B Q3" };
    if (command === "intelligence_judge_event_pairs") { judgeCalls += 1; return { decisions: [] }; }
    if (command === "intelligence_generate_brief") {
      const candidate = (args?.request as { candidates: Array<Record<string, unknown>> }).candidates[0]!;
      modelCandidates.push(candidate);
      return { content: JSON.stringify({ briefs: [{
        id: candidate.id, priority: "P1", importance: 70, confidence: 0.8,
        headline: String(candidate.title), summary: "独立财报事件。",
        article: "该公司披露了本期财务业绩。\n\n此报道不与其他公司财报合并。",
        sourceDifferences: modelSourceDifferences(candidate.sources as Array<{ name: string }>),
        whyItMatters: "主体和财报期可单独核查。", reasons: ["主体明确"], notify: false,
      }] }) };
    }
    return { items };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);
  await api.instance.open();

  assert.equal(judgeCalls, 0);
  assert.equal(modelCandidates.length, 2);
  assert.ok(modelCandidates.every((candidate) => (candidate.sources as unknown[]).length === 1));
});

test("unchanged event pairs reuse the local judgement cache on an incremental refresh", async () => {
  let judgeCalls = 0;
  const items = [
    { title: "突发：科沃斯发布2026年半年度业绩报告", source: "财经甲", category: "财经", summary: "科沃斯半年报披露净利润增长。", publishedAt: Date.now() },
    { title: "突发：科沃斯半年报：净利润同比增长27.4%", source: "财经乙", category: "财经", summary: "公司发布同一期业绩说明。", publishedAt: Date.now() },
  ];
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") return { configured: true, model: "Qwen 27B Q3" };
    if (command === "intelligence_judge_event_pairs") {
      judgeCalls += 1;
      const pair = (args?.request as { pairs: Array<Record<string, unknown>> }).pairs[0]!;
      return { decisions: [{ id: pair.id, sameEvent: true, confidence: 0.95, reason: "公司主体、财报期与业绩动作一致。" }] };
    }
    if (command === "intelligence_generate_brief") {
      const candidate = (args?.request as { candidates: Array<Record<string, unknown>> }).candidates[0]!;
      return { content: JSON.stringify({ briefs: [{
        id: candidate.id, priority: "P1", importance: 70, confidence: 0.8,
        headline: "科沃斯半年度业绩", summary: "两家来源报道同一期科沃斯业绩。",
        article: "科沃斯披露半年度业绩。\n\n两家来源围绕同一财报事实提供了互相印证的表述。",
        sourceDifferences: modelSourceDifferences(candidate.sources as Array<{ name: string }>),
        whyItMatters: "业绩数据可继续关注。", reasons: ["同一主体与期间"], notify: false,
      }] }) };
    }
    return { items };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);
  await api.instance.open();
  await api.instance.refresh();

  assert.equal(judgeCalls, 1);
});

test("local model failure falls back to rule candidates without reporting a generated hotspot", async () => {
  const view = fixture((command: string) => {
    if (command === "intelligence_local_model_status") {
      return { configured: true, model: "Qwen 27B Q3" };
    }
    if (command === "intelligence_generate_brief") {
      return Promise.reject(new Error("local model offline"));
    }
    return { items: modelCandidateItems() };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  assert.equal(view.calls.filter((call) => call.command === "intelligence_generate_brief").length, 1);
  assert.equal(element(view, "intelligence-briefing-model-status").textContent, "本机模型未响应；正在展示规则候选");
  assert.match(element(view, "intelligence-briefing-count").textContent, /规则已筛出 1 条重要资讯/);
  assert.doesNotMatch(element(view, "intelligence-briefing-model-status").textContent, /已生成每日简报|推送成功/);
  assert.equal(element(view, "intelligence-context-reasons").children.length, 1);
  assert.match(element(view, "intelligence-context-reasons").children[0]?.textContent ?? "", /规则候选/);
});

test("clicking an unfinished briefing prioritizes one local synthesis and opens its article", async () => {
  let generationCalls = 0;
  let preparedHtml = "";
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") return { configured: true, model: "Qwen 27B Q3" };
    if (command === "intelligence_generate_brief") {
      generationCalls += 1;
      const candidate = (args?.request as { candidates: Array<Record<string, unknown>> }).candidates[0]!;
      if (generationCalls === 1) return { content: JSON.stringify({ briefs: [] }) };
      const sources = candidate.sources as Array<{ name: string }>;
      return { content: JSON.stringify({ briefs: [{
        id: candidate.id, priority: "P1", importance: 71, confidence: 0.82,
        headline: "优先整合后的事件", summary: "已按多来源整理。",
        article: "第一家与第二家来源都支持同一项事件。\n\n本机模型已删除重复描述并保留共同事实。",
        sourceDifferences: modelSourceDifferences(sources),
        whyItMatters: "适合直接阅读。", reasons: ["两个独立来源"], notify: false,
      }] }) };
    }
    return { items: modelCandidateItems() };
  });
  view.runtime.ReaderNewsUI = { instance: {
    openPreparedArticle: (article: { readonly contentHtml: string }) => { preparedHtml = article.contentHtml; },
  } };
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-digest-list").children[0]?.click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(generationCalls, 2);
  assert.match(preparedHtml, /本机模型已删除重复描述/);
  assert.match(preparedHtml, /各来源的独有信息与差异/);
  assert.match(preparedHtml, /引用来源/);
});

test("daily briefing selects 25 important events and sends one evidence-bounded event per local edit", async () => {
  const items = Array.from({ length: 27 }, (_, index) => ({
    title: `突发政策更新 ${String(index + 1).padStart(2, "0")}`,
    source: `独立来源 ${index + 1}`,
    sourceId: `source-${index + 1}`,
    category: "政策",
    url: `https://example.test/policy/${index + 1}`,
    summary: `第 ${index + 1} 条政策变化的公开摘要。`,
    publishedAt: Date.now(),
  }));
  const batchSizes: number[] = [];
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") return { configured: true, model: "Qwen 27B Q3" };
    if (command === "intelligence_generate_brief") {
      const candidates = (args?.request as { candidates: Array<Record<string, unknown>> }).candidates;
      batchSizes.push(candidates.length);
      return {
        model: "Qwen 27B Q3",
        content: JSON.stringify({ briefs: candidates.map((candidate) => ({
          id: candidate.id,
          importance: 70,
          confidence: 0.8,
          priority: "P1",
          headline: `本机编辑 ${candidate.title}`,
          summary: "已根据本地候选生成摘要。",
          article: "本机模型依据候选来源完成了事件级整合。\n\n这是一条可直接阅读的中文综合报道。",
          sourceDifferences: modelSourceDifferences(candidate.sources as Array<{ name: string }>),
          whyItMatters: "属于当天的重要政策变化。",
          reasons: ["来源和时效符合规则门槛"],
        })) }),
      };
    }
    return { items };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  assert.equal(element(view, "intelligence-digest-list").children.length, 25);
  assert.equal(batchSizes.reduce((total, size) => total + size, 0), 25);
  assert.ok(batchSizes.every((size) => size === 1));
  const saved = view.calls.find((call) => call.command === "intelligence_daily_digest_save");
  const entries = (saved?.args?.request as { entries: unknown[] } | undefined)?.entries;
  assert.equal(entries?.length, 25);
  assert.match(element(view, "intelligence-briefing-count").textContent, /已编辑 25 \/ 25 条重要资讯/);
});

test("daily digest history renders an older local snapshot as read-only and returns to today", async () => {
  const history = {
    day: "2026-08-21",
    generatedAt: 1_787_280_000_000,
    count: 1,
    overview: "昨日的本机简报。",
    model: "Qwen 27B Q3",
    entries: [{
      id: "event-history-01",
      title: "昨日的重要事件",
      summary: "这是已经固化的昨日摘要。",
      whyItMatters: "便于回顾昨天的变化。",
      importance: 81,
      confidence: 0.88,
      priority: "P1",
      category: "政策",
      sourceCount: 2,
      reasons: ["两家独立来源"],
      notify: false,
      evidence: [
        { source: "来源甲", title: "昨日原文甲", url: "https://example.test/yesterday/a" },
        { source: "来源乙", title: "昨日原文乙", url: "https://example.test/yesterday/b" },
      ],
    }],
  };
  const view = fixture((command: string) => {
    if (command === "intelligence_daily_digest_list") {
      return [{ day: history.day, generatedAt: history.generatedAt, count: history.count, overview: history.overview, model: history.model }];
    }
    if (command === "intelligence_daily_digest_get") return history;
    return { items: modelCandidateItems() };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();
  element(view, "intelligence-digest-history-previous").click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(element(view, "intelligence-digest-history").dataset.mode, "historical");
  assert.equal(element(view, "intelligence-digest-history-readonly").hidden, false);
  assert.equal(element(view, "intelligence-context-title").textContent, "昨日的重要事件");
  assert.match(element(view, "intelligence-briefing-count").textContent, /2026-08-21 · 已固化 1 条重要资讯/);

  element(view, "intelligence-digest-history-next").click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(element(view, "intelligence-digest-history").dataset.mode, "live");
  assert.equal(element(view, "intelligence-digest-history-readonly").hidden, true);
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
  assert.deepEqual(view.calls.slice(0, 4), [
    { command: "intelligence_daily_digest_list" },
    { command: "intelligence_local_model_status" },
    { command: "newsnow_sources" },
    { command: "newsnow_list", args: { request: { sourceIds: ["example-source"], preserveEvidence: true } } },
  ]);
  assert.equal(view.calls.filter((call) => call.command === "intelligence_daily_digest_save").length, 0);
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

test("workspace removes stale anchor attributes and never uses a raw URL as context text", async () => {
  const view = fixture({
    items: [{
      title: "突发政策：旧快照中的链接属性不应显示",
      source: "示例来源",
      category: "科技",
      url: "https://example.test/very-long-original-url",
      summary: 'target="_blank" a href="https://news.google.com/rss/articles/very-long-tracking-identifier" /a &nbsp; font color="#6f6f6f" /font',
      publishedAt: Date.now(),
    }],
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  const context = element(view, "intelligence-context-body").textContent;
  assert.match(context, /未提供可显示摘要/);
  assert.doesNotMatch(context, /href|target|font|https?:\/\//i);
  assert.equal(element(view, "intelligence-open-news").hidden, true);
  assert.equal(element(view, "intelligence-open-news").disabled, true);
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

test("briefing cards display merged content and open a prepared local article", async () => {
  const item = {
    title: "突发地震预警资讯可直接打开",
    source: "示例来源",
    category: "科技",
    url: "https://example.test/direct-open",
    summary: "简报条目不是只读选择控件。",
  };
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "intelligence_local_model_status") return { configured: true, model: "Qwen 27B Q3" };
    if (command === "intelligence_generate_brief") {
      const candidate = (args?.request as { candidates: Array<Record<string, unknown>> }).candidates[0]!;
      const sources = candidate.sources as Array<{ name: string }>;
      return { content: JSON.stringify({ briefs: [{
        id: candidate.id, priority: "P1", importance: 70, confidence: 0.8,
        headline: item.title, summary: "两家来源确认同一项预警资讯。",
        article: "有关预警资讯已由本机模型整合。\n\n两个独立来源对核心事实给出一致描述。",
        sourceDifferences: modelSourceDifferences(sources),
        whyItMatters: "需要关注后续官方更新。", reasons: ["两个独立来源"], notify: false,
      }] }) };
    }
    return { items: [
      item,
      { ...item, source: "独立来源", sourceId: "independent-source", url: "https://example.test/direct-open?utm_source=reader" },
    ] };
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);
  let preparedTitle = "";
  let preparedHtml = "";
  view.runtime.ReaderNewsUI = {
    instance: {
      openPreparedArticle: (article: { readonly title: string; readonly contentHtml: string }) => {
        preparedTitle = article.title;
        preparedHtml = article.contentHtml;
      },
    },
  };

  await api.instance.open();
  const firstBriefingCard = element(view, "intelligence-digest-list").children[0];
  assert.ok(firstBriefingCard);
  assert.equal(firstBriefingCard.type, "button");
  assert.equal(firstBriefingCard.children.length, 3);
  assert.match(firstBriefingCard.children[1]?.children[1]?.textContent ?? "", /两家来源确认同一项预警资讯/);
  firstBriefingCard.click();
  await Promise.resolve();
  assert.equal(preparedTitle, item.title);
  assert.match(preparedHtml, /综合报道/);
  assert.match(preparedHtml, /各来源的独有信息与差异/);
  assert.match(preparedHtml, /引用来源/);
  assert.match(preparedHtml, /<a href="https:\/\/example\.test\/direct-open" data-newsnow-prepared-source-url="https:\/\/example\.test\/direct-open">/);
  assert.doesNotMatch(preparedHtml, /target="_blank"/);
  assert.equal(element(view, "intelligence-open-news").hidden, true);
  assert.equal(element(view, "intelligence-open-news").disabled, true);
});

test("aggregated briefing retains multiple sources and opens HTTPS evidence in the reader", async () => {
  const view = fixture({
    items: [
      {
        title: "多来源事件需要聚合后打开原文",
        source: "无链接快讯",
        sourceId: "no-url",
        category: "科技",
        url: "https://example.test/openable-source?utm_source=reader",
        summary: "这一篇摘要更长，因此会被精确去重选为事件代表。",
      },
      {
        title: "多来源事件需要聚合后打开原文",
        source: "可打开来源",
        sourceId: "openable",
        category: "科技",
        url: "https://example.test/openable-source",
        summary: "独立来源给出可打开的原文依据。",
      },
    ],
  });
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);
  let openedUrl = "";
  view.runtime.ReaderNewsUI = {
    instance: {
      openItem: (candidate: Record<string, unknown>) => { openedUrl = String(candidate.url ?? ""); },
    },
  };

  await api.instance.open();
  assert.equal(element(view, "intelligence-context-evidence").children.length, 2);
  const evidence = element(view, "intelligence-context-evidence").children;
  assert.equal(evidence[0]?.type, "button");
  assert.equal(evidence[1]?.type, "button");
  evidence[1]?.click();
  await Promise.resolve();
  assert.equal(openedUrl, "https://example.test/openable-source");
  assert.equal(element(view, "intelligence-open-news").hidden, true);
  assert.equal(element(view, "intelligence-open-news").disabled, true);
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
  assert.deepEqual(view.calls.slice(0, 4), [
    { command: "intelligence_daily_digest_list" },
    { command: "intelligence_local_model_status" },
    { command: "newsnow_sources" },
    {
      command: "newsnow_list",
      args: { request: { sourceIds: ["ithome", "github", "nasa"], tiebaBars: [], preserveEvidence: true } },
    },
  ]);

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
    request: { sourceIds: sources.slice(0, 12).map((source) => source.id), preserveEvidence: true },
  });
  assert.deepEqual(collectionCalls[1]?.args, {
    request: { sourceIds: sources.slice(12).map((source) => source.id), preserveEvidence: true },
  });
  assert.match(element(view, "intelligence-workspace-status").textContent, /全量资料库已完成/);
  assert.doesNotMatch(element(view, "intelligence-workspace-status").textContent, /暂时不可用/);
});

test("workspace keeps a fresh completed directory on reopening without fetching", async () => {
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
  const savedSnapshot = JSON.parse(view.storage.get("kunpeng.reader.intelligence.snapshot.v1") ?? "{}") as Record<string, unknown>;
  view.storage.set("kunpeng.reader.intelligence.snapshot.v1", JSON.stringify({ ...savedSnapshot, failedSources: 2 }));

  api.instance.close({ focus: false });
  const callsBeforeReopen = view.calls.length;
  const statusBeforeReopen = element(view, "intelligence-workspace-status").textContent;
  await api.instance.open();
  const collectionCalls = view.calls.filter((call) => call.command === "newsnow_list");
  assert.equal(collectionCalls.length, 2);
  assert.equal(view.calls.length, callsBeforeReopen);
  assert.equal(element(view, "intelligence-workspace-status").textContent, statusBeforeReopen);
});

test("workspace keeps a fresh completed directory when its source catalogue is reordered", async () => {
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
        sourceIds: sourceIds.slice().reverse(),
        items: [{ title: "已缓存资讯", source: "来源 1", sourceId: "source-1", category: "科技" }],
        attemptedSources: sourceIds.length,
        failedSources: 0,
        nextBatch: 1,
        completed: true,
        updatedAt: Date.now(),
      };
    }
    return { items: [] };
  }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  assert.equal(view.calls.filter((call) => call.command === "newsnow_list" || call.command === "newsnow_refresh").length, 0);
  assert.match(element(view, "intelligence-workspace-status").textContent, /不会重新抓取/);
});

test("workspace automatically refreshes exactly one rotating batch when a completed snapshot is older than six hours", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const sourceIds = sources.map((source) => source.id);
  const view = fixture((command: string, args?: Record<string, unknown>) => {
    if (command === "newsnow_intelligence_snapshot_get") {
      return {
        version: 1,
        sourceIds,
        items: [{ title: "过期快照资讯", source: "来源 1", sourceId: "source-1", category: "科技" }],
        attemptedSources: sourceIds.length,
        failedSources: 0,
        nextBatch: 0,
        completed: true,
        updatedAt: Date.now() - 7 * 60 * 60 * 1_000,
      };
    }
    const requested = ((args?.request as Record<string, unknown> | undefined)?.sourceIds ?? []) as string[];
    return {
      items: requested.map((sourceId) => ({
        title: `${sourceId} 的增量资讯`, source: sourceId, sourceId, category: "科技",
      })),
    };
  }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  const collectionCalls = view.calls.filter((call) => (
    call.command === "newsnow_list" || call.command === "newsnow_refresh"
  ));
  assert.equal(collectionCalls.length, 1);
  assert.deepEqual(collectionCalls[0]?.args, {
    request: { sourceIds: sourceIds.slice(0, 12), preserveEvidence: true },
  });
});

test("a completed snapshot from the prior local day refreshes before becoming today's digest", () => {
  const now = new Date(2026, 7, 22, 0, 15).getTime();
  const yesterdayLate = new Date(2026, 7, 21, 23, 50).getTime();
  const currentDay = new Date(2026, 7, 22, 0, 10).getTime();
  const makeSnapshot = (updatedAt: number) => ({
    sourceIds: ["source-1"],
    items: [],
    attemptedSources: 1,
    failedSources: 0,
    nextBatch: 0,
    completed: true,
    updatedAt,
  });

  assert.equal(hasFreshCompletedSnapshot(makeSnapshot(yesterdayLate), now), false);
  assert.equal(hasFreshCompletedSnapshot(makeSnapshot(currentDay), now), true);
});

test("workspace preserves no-URL evidence from different sources until briefing-time consolidation", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const view = fixture((_command: string, args?: Record<string, unknown>) => {
    const sourceIds = ((args?.request as Record<string, unknown> | undefined)?.sourceIds ?? []) as string[];
    if (sourceIds.includes("source-1")) {
      return {
        items: [
          { title: "同一事件的无链接报道", source: "来源甲", sourceId: "source-1", category: "科技", summary: "较短摘要。" },
          { title: "同一事件的无链接报道", source: "来源甲", sourceId: "source-1", category: "科技", summary: "同一来源的较长摘要，应只保留一次。" },
        ],
      };
    }
    return {
      items: [{
        title: "同一事件的无链接报道", source: "来源乙", sourceId: "source-13", category: "科技", summary: "另一来源的独立证据必须保留。",
      }],
    };
  }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  const saved = JSON.parse(view.storage.get("kunpeng.reader.intelligence.snapshot.v1") ?? "null") as {
    readonly items?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(saved.items?.map((item) => item.sourceId).sort(), ["source-1", "source-13"]);
  const briefing = buildIntelligenceBriefing(saved.items ?? []);
  assert.equal(briefing.uniqueCount, 2);
  assert.deepEqual(new Set(briefing.entries.flatMap((entry) => entry.sourceNames)), new Set(["来源甲", "来源乙"]));
});

test("workspace stops after close and ignores an already-started batch response", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `来源 ${index + 1}`,
    category: "科技",
    provider: "worldmonitor",
    kind: "rss",
  }));
  const firstBatch = deferred<unknown>();
  const view = fixture((command: string) => (
    command === "newsnow_list" ? firstBatch.promise : { items: [] }
  ), sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  const opening = api.instance.open();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(view.calls.filter((call) => call.command === "newsnow_list").length, 1);
  const statusBeforeClose = element(view, "intelligence-workspace-status").textContent;

  api.instance.close({ focus: false });
  const statusAfterClose = element(view, "intelligence-workspace-status").textContent;
  const digestCountAfterClose = element(view, "intelligence-digest-list").children.length;
  firstBatch.resolve({
    items: [{ title: "迟到的批次资讯", source: "来源 1", sourceId: "source-1", category: "科技" }],
  });
  await opening;

  assert.equal(element(view, "intelligence-workspace-page").hidden, true);
  assert.equal(view.calls.filter((call) => call.command === "newsnow_list").length, 1);
  assert.equal(view.snapshotSaves.length, 0);
  assert.notEqual(statusBeforeClose, "");
  assert.equal(element(view, "intelligence-workspace-status").textContent, statusAfterClose);
  assert.equal(element(view, "intelligence-digest-list").children.length, digestCountAfterClose);
});

test("workspace reports unavailable sources in the completed collection status", async () => {
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
        title: `${sourceId} 的资讯`, source: sourceId, sourceId, category: "科技",
      })),
      failedSources: sourceIds.includes("source-1") ? ["source-1"] : ["source-13"],
    };
  }, sources);
  const api = installIntelligenceWorkspaceUi(view.runtime, view.runtime.transport as never);
  assert.ok(api?.instance);

  await api.instance.open();

  assert.match(element(view, "intelligence-workspace-status").textContent, /2 个来源暂时不可用/);
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
        updatedAt: Date.now(),
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
  element(view, "intelligence-signal-list").children[0]?.click();
  assert.equal(element(view, "intelligence-open-news").hidden, false);
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
