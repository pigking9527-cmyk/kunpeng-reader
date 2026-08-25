import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntelligenceBriefing,
  installIntelligenceWorkspaceUi,
  parseIntelligenceModelBriefs,
  selectIntelligenceBriefCandidates,
  selectIntelligenceRelationReviewIds,
} from "./intelligence-workspace-ui.ts";
import { FAVORITES_STORAGE_KEY } from "../main-favorites/favorites-store.ts";

type Invoke = (command: string, args?: Record<string, unknown>) => unknown;

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void { this.values.add(value); }
  public remove(value: string): void { this.values.delete(value); }
}

class FakeElement {
  public hidden = true;
  public disabled = false;
  public type = "";
  public className = "";
  public textContent = "";
  public value = "";
  public title = "";
  public readonly dataset: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly children: FakeElement[] = [];
  public readonly classList = new FakeClassList();
  public closestTarget: FakeElement | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();

  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  public replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
  public append(...children: FakeElement[]): void { this.children.push(...children); }
  public querySelectorAll(): FakeElement[] { return []; }
  public closest<T>(): T | null { return this.closestTarget as T | null; }
  public focus(): void {}
  public emit(type: string): void { this.listeners.get(type)?.forEach((listener) => listener()); }
  public click(): void { this.emit("click"); }
}

interface Fixture {
  readonly runtime: Record<string, unknown>;
  readonly elements: Map<string, FakeElement>;
  readonly calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }>;
  readonly transport: { readonly invoke: <TResult>(command: string, args?: Record<string, unknown>) => Promise<TResult> };
  readonly storage: Map<string, string>;
}

const ELEMENT_IDS = [
  "intelligence-lab-toolbar-btn", "intelligence-workspace-page", "intelligence-workspace-back",
  "intelligence-layout-briefing", "intelligence-layout-monitor", "intelligence-layout-research", "intelligence-layout-interstellar",
  "intelligence-refresh", "intelligence-open-sources", "intelligence-source-directory", "intelligence-source-directory-back",
  "intelligence-source-directory-summary", "intelligence-source-directory-search", "intelligence-source-directory-list",
  "intelligence-workspace-status", "intelligence-digest-history", "intelligence-digest-history-summary", "intelligence-digest-history-date",
  "intelligence-filter-kind", "intelligence-filter-importance", "intelligence-filter-scope", "intelligence-archive-day", "intelligence-archive-request", "intelligence-archive-retry", "intelligence-archive-status",
  "intelligence-digest-history-previous", "intelligence-digest-history-next", "intelligence-digest-history-readonly",
  "intelligence-processing-summary", "intelligence-briefing-model-status", "intelligence-local-model-base-url",
  "intelligence-local-model-name", "intelligence-local-model-qwen27b", "intelligence-local-model-requirement",
  "intelligence-local-model-key", "intelligence-local-model-save", "intelligence-briefing-count", "intelligence-digest-list",
  "intelligence-signal-list", "intelligence-context-title", "intelligence-context-body", "intelligence-context-meta",
  "intelligence-context-reasons", "intelligence-context-evidence", "intelligence-open-news", "intelligence-standard-view",
  "interstellar-progress-view", "interstellar-signal-count", "interstellar-signal-list", "interstellar-context-title",
  "interstellar-context-body", "interstellar-open-news", "interstellar-source-summary", "interstellar-source-note",
  "interstellar-source-groups", "interstellar-manage-sources", "newsnow-page", "newsnow-reader",
  "intelligence-event-judge-base-url", "intelligence-event-judge-model", "intelligence-open-audit",
  "intelligence-audit-view", "intelligence-audit-back", "library-ai-page",
];

function fixture(
  respond: Invoke,
  stored: Record<string, string> = {},
  options: { readonly withToolbarAction?: boolean } = {},
): Fixture {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, new FakeElement()]));
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const storage = new Map(Object.entries(stored));
  const contentShell = new FakeElement();
  if (options.withToolbarAction) {
    elementFrom(elements, "intelligence-lab-toolbar-btn").closestTarget = new FakeElement();
  }
  const runtime: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => selector === ".content-shell" ? contentShell : null,
      createElement: () => new FakeElement(),
      body: new FakeElement(),
    },
    addEventListener: () => undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  };
  const transport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>): Promise<TResult> => {
      calls.push(args === undefined ? { command } : { command, args });
      return respond(command, args) as TResult;
    },
  };
  return { runtime, elements, calls, transport, storage };
}

function elementFrom(elements: Map<string, FakeElement>, id: string): FakeElement {
  const result = elements.get(id);
  if (!result) throw new Error(`missing ${id}`);
  return result;
}

function workspace(view: Fixture): NonNullable<NonNullable<ReturnType<typeof installIntelligenceWorkspaceUi>>["instance"]> {
  const api = installIntelligenceWorkspaceUi(view.runtime, view.transport);
  assert.ok(api?.instance, "fixture must expose the single intelligence workspace");
  return api.instance;
}

function element(view: Fixture, id: string): FakeElement {
  const result = view.elements.get(id);
  assert.ok(result, `missing ${id}`);
  return result;
}

function cachedPublication() {
  return [{
    publicationId: "pub-20260823-001", kind: "daily", publishedAt: "2026-08-23T10:00:00Z", expiresAt: "2026-09-22T10:00:00Z",
    importance: 80,
    events: [{
      eventId: "event-001", revisionNo: 2, title: "已校验的正式情报", occurredAt: "2026-08-23T09:00:00Z",
      body: "第一段正式内容。\n\n第二段正式内容。",
      segments: [
        { text: "第一段正式内容。", noteIds: ["note-001"] },
        { text: "第二段正式内容。", noteIds: ["note-001"] },
      ],
      sources: [{ noteId: "note-001", publisher: "公开来源", title: "原始报道", originalUrl: "https://example.test/source", publishedAt: "2026-08-23T09:00:00Z", fallbackExcerpt: "公开来源摘要。" }],
      media: [],
    }],
  }];
}

function cacheStatus() {
  return { cachePresent: true, publicationCount: 1, unacknowledgedCount: 0, lastRefreshAt: 0 };
}

function favoriteStorage(): Record<string, string> {
  return {
    [FAVORITES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      items: [{
        kind: "news", id: "favorite-news-1", title: "航天推进", summary: "关注推进技术和深空任务。", source: "本机", publishedAt: "2026-08-23", category: "科技", url: "https://example.test/favorite", createdAt: 1, updatedAt: 2,
      }],
    }),
  };
}

function cachedPublicationWithTwoEvents() {
  const publication = cachedPublication()[0]!;
  return [{
    ...publication,
    events: [
      {
        ...publication.events[0]!,
        eventId: "event-ordinary",
        revisionNo: 1,
        title: "普通事件",
        body: "普通正式内容。",
        segments: [{ text: "普通正式内容。", noteIds: ["note-001"] }],
      },
      {
        ...publication.events[0]!,
        eventId: "event-preferred",
        revisionNo: 1,
        title: "偏好事件",
        body: "航天推进与深空任务的正式内容。",
        segments: [{ text: "航天推进与深空任务的正式内容。", noteIds: ["note-001"] }],
      },
    ],
  }];
}

function cachedPublicationsWithImportanceLevels() {
  const important = cachedPublication()[0]!;
  return [
    important,
    {
      ...important,
      publicationId: "pub-20260822-001",
      kind: "event",
      importance: 20,
      events: important.events.map((event) => ({
        ...event,
        eventId: "event-low-importance",
        title: "一般资讯",
      })),
    },
  ];
}

function modelCandidateItems(): Array<Record<string, unknown>> {
  return [
    { title: "沿海预警", source: "应急来源甲", sourceId: "emergency-a", category: "自然事件", url: "https://example.test/alert", summary: "官方发布预警。", publishedAt: Date.now() },
    { title: "沿海预警", source: "应急来源乙", sourceId: "emergency-b", category: "自然事件", url: "https://example.test/alert?utm_source=reader", summary: "独立来源印证预警。", publishedAt: Date.now() },
  ];
}

function modelSourceDifferences(sources: readonly { readonly name: string }[]) {
  return sources.map((source) => ({ source: source.name, detail: "提供可核对的公开事实。" }));
}

test("installer safely exposes a global when the workspace DOM is unavailable", () => {
  const runtime: Record<string, unknown> = { document: { getElementById: () => null }, addEventListener: () => undefined };
  const api = installIntelligenceWorkspaceUi(runtime);
  assert.ok(api);
  assert.equal(runtime.ReaderIntelligenceWorkspace, api);
  assert.equal(api.instance, null);
});

test("relation quality gate sends every pair to 27B during full review", () => {
  const pairs = Array.from({ length: 73 }, (_, index) => ({ id: `pair-${index}`, sampleKey: `batch:${index}`, important: false, conflicting: false, lowConfidence: false }));
  assert.deepEqual(selectIntelligenceRelationReviewIds(pairs, "full"), pairs.map((pair) => pair.id));
  assert.deepEqual(selectIntelligenceRelationReviewIds(pairs, null), pairs.map((pair) => pair.id));
});

test("relation quality gate sampled mode retains all risks and a stable ten-percent sample", () => {
  const ordinary = Array.from({ length: 100 }, (_, index) => ({ id: `ordinary-${index}`, sampleKey: `ordinary:${index}`, important: false, conflicting: false, lowConfidence: false }));
  const pairs = [...ordinary, { id: "important", sampleKey: "important", important: true, conflicting: false, lowConfidence: false }, { id: "conflict", sampleKey: "conflict", important: false, conflicting: true, lowConfidence: false }, { id: "low", sampleKey: "low", important: false, conflicting: false, lowConfidence: true }];
  const selected = selectIntelligenceRelationReviewIds(pairs, "sample");
  assert.ok(selected.includes("important") && selected.includes("conflict") && selected.includes("low"));
  assert.ok(selected.filter((id) => id.startsWith("ordinary-")).length >= Math.ceil(pairs.length * 0.1));
  assert.deepEqual([...selected].sort(), [...selectIntelligenceRelationReviewIds([...pairs].reverse(), "sample")].sort());
});

test("briefing performs only deterministic exact evidence consolidation", () => {
  const now = Date.now();
  const briefing = buildIntelligenceBriefing([
    { title: "聚变试验完成", source: "研究院 A", category: "科研", url: "https://example.test/fusion", summary: "实验数据公开。", publishedAt: now },
    { title: "聚变试验完成", source: "研究院 B", category: "科研", url: "https://example.test/fusion?utm_source=reader", summary: "独立报道。", publishedAt: now },
    { title: "国际空间政策会议", source: "政策观察", category: "制度", summary: "协作议程公布。", publishedAt: now },
  ]);
  assert.equal(briefing.inputCount, 3);
  assert.equal(briefing.uniqueCount, 2);
  assert.deepEqual(briefing.entries[0]?.sourceNames, ["研究院 A", "研究院 B"]);
});

test("differently titled reports remain separate until the worker judges their relationship", () => {
  const briefing = buildIntelligenceBriefing([
    { title: "Aurora completes propulsion test", source: "Science Wire", category: "科技", summary: "Test completed today.", publishedAt: Date.now() },
    { title: "Fusion propulsion test completed by Aurora", source: "Independent Space", category: "科技", summary: "Stable thrust recorded.", publishedAt: Date.now() },
  ]);
  assert.equal(briefing.uniqueCount, 2);
  assert.equal(briefing.mergedCount, 0);
});

test("model brief parser rejects invented identifiers and accepts bounded evidence", () => {
  const candidates = selectIntelligenceBriefCandidates(buildIntelligenceBriefing(modelCandidateItems()), 1);
  const candidate = candidates[0]!;
  const briefs = parseIntelligenceModelBriefs(JSON.stringify({ briefs: [{
    id: candidate.id, priority: "P0", importance: 91, confidence: 0.94, headline: "已核对热点", summary: "来源相互印证。",
    article: "第一段。\n\n第二段。", sourceDifferences: modelSourceDifferences(candidate.sources), whyItMatters: "需要关注。", reasons: ["独立来源"],
  }, { id: "invented", priority: "P0", importance: 100, confidence: 1, headline: "虚构", summary: "不得采用", whyItMatters: "不得采用" }] }), candidates);
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0]?.id, candidate.id);
});

test("event candidates retain all independent sources instead of an old fixed cap", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ title: "央行政策公告", source: `独立来源 ${index + 1}`, sourceId: `source-${index + 1}`, category: "财经", url: `https://example.test/policy?id=1&utm_source=${index}`, summary: "政策细节。", publishedAt: Date.now() }));
  assert.equal(selectIntelligenceBriefCandidates(buildIntelligenceBriefing(items), 1)[0]?.sources.length, 12);
});

test("model scores in the ten-point notation are normalized before display", () => {
  const candidate = selectIntelligenceBriefCandidates(buildIntelligenceBriefing(modelCandidateItems()), 1)[0]!;
  const briefs = parseIntelligenceModelBriefs(JSON.stringify({ briefs: [{ id: candidate.id, priority: "P1", importance: 8, confidence: 9, headline: "标题", summary: "摘要", article: "正文。", sourceDifferences: modelSourceDifferences(candidate.sources), whyItMatters: "意义", reasons: ["证据"] }] }), [candidate]);
  assert.equal(briefs[0]?.importance, 80);
  assert.equal(briefs[0]?.confidence, 0.9);
});

test("opening the workspace only reads the account-scoped validated cache", async () => {
  const view = fixture((command) => command === "intelligence_client_cache_status" ? cacheStatus() : cachedPublication());
  const controller = workspace(view);
  await controller.open();
  assert.deepEqual(view.calls.map((call) => call.command), ["intelligence_client_cache_status", "intelligence_client_cached_publications"]);
  assert.match(element(view, "intelligence-workspace-status").textContent, /已读取本地正式缓存/);
  assert.equal(element(view, "intelligence-briefing-model-status").textContent, "本机缓存阅读模式 · 不会自动调用模型");
  assert.equal(element(view, "intelligence-digest-list").children.length, 1);
});

test("anonymous accounts keep the push intelligence entry hidden", async () => {
  const view = fixture(
    (command) => command === "sync_get_settings" ? { userId: "", url: "" } : cacheStatus(),
    {},
    { withToolbarAction: true },
  );
  workspace(view);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const toolbar = element(view, "intelligence-lab-toolbar-btn");
  assert.equal(toolbar.closestTarget?.hidden, true);
  assert.deepEqual(view.calls.map((call) => call.command), ["sync_get_settings"]);
});

test("explicit refresh is the sole workspace action allowed to invoke native synchronization", async () => {
  const view = fixture((command) => command === "intelligence_client_cache_status" ? cacheStatus() : cachedPublication());
  const controller = workspace(view);
  await controller.open();
  view.calls.splice(0);
  element(view, "intelligence-refresh").click();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(view.calls.map((call) => call.command), ["intelligence_client_refresh", "intelligence_client_cache_status", "intelligence_client_cached_publications"]);
  assert.equal(view.calls.some((call) => /^(newsnow_|intelligence_store_|intelligence_generate_|intelligence_local_model_)/u.test(call.command)), false);
});

test("an empty validated cache remains a Chinese read-only empty state", async () => {
  const view = fixture((command) => command === "intelligence_client_cache_status" ? { cachePresent: false, publicationCount: 0, unacknowledgedCount: 0, lastRefreshAt: 0 } : []);
  const controller = workspace(view);
  await controller.open();
  assert.equal(element(view, "intelligence-briefing-count").textContent, "暂无正式资讯");
  assert.match(element(view, "intelligence-context-body").textContent, /本页不会自行联网/);
});

test("formal cache filters only change the visible account-local reader list", async () => {
  const publications = cachedPublicationsWithImportanceLevels();
  const view = fixture((command) => command === "intelligence_client_cache_status" ? cacheStatus() : publications);
  const controller = workspace(view);
  await controller.open();
  assert.equal(element(view, "intelligence-digest-list").children.length, 2);
  const importance = element(view, "intelligence-filter-importance");
  importance.value = "80";
  importance.emit("change");
  assert.equal(element(view, "intelligence-digest-list").children.length, 1);
  assert.equal(view.calls.some((call) => call.command === "intelligence_client_refresh"), false);
  assert.equal(view.calls.some((call) => /archive|newsnow_|intelligence_store_|intelligence_generate_/u.test(call.command)), false);
});

test("historic retrieval waits for ready content, then downloads and acknowledges through native commands", async () => {
  const view = fixture((command) => {
    if (command === "intelligence_client_cache_status") return cacheStatus();
    if (command === "intelligence_client_cached_publications") return cachedPublication();
    if (command === "intelligence_archive_calendar") return { days: [{ day: "2026-07-01", entryCount: 2 }] };
    if (command === "intelligence_archive_request") return { requestId: "archive-request-1", state: "QUEUED" };
    if (command === "intelligence_archive_request_status") return { requestId: "archive-request-1", state: "READY", contentReady: true };
    if (command === "intelligence_archive_download") return { requestId: "archive-request-1", state: "ACKED" };
    throw new Error(`unexpected ${command}`);
  });
  const controller = workspace(view);
  await controller.open();
  const day = element(view, "intelligence-archive-day");
  day.emit("focus");
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  day.value = "2026-07-01";
  element(view, "intelligence-archive-request").click();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const commands = view.calls.map((call) => call.command);
  assert.ok(commands.includes("intelligence_archive_calendar"));
  assert.ok(commands.includes("intelligence_archive_request"));
  assert.ok(commands.includes("intelligence_archive_request_status"));
  assert.ok(commands.includes("intelligence_archive_download"));
  assert.match(element(view, "intelligence-archive-status").textContent, /已校验、保存并确认/);
});

test("cache failures are reported without falling back to collection or model work", async () => {
  const view = fixture(() => { throw new Error("cache unavailable"); });
  const controller = workspace(view);
  await controller.open();
  assert.match(element(view, "intelligence-workspace-status").textContent, /不会因此启动网络采集或模型任务/);
  assert.equal(view.calls.some((call) => /^(newsnow_|intelligence_store_|intelligence_generate_|intelligence_local_model_)/u.test(call.command)), false);
});

test("a cached formal event opens through the existing prepared reader with its public citations", async () => {
  const view = fixture((command) => command === "intelligence_client_cache_status" ? cacheStatus() : cachedPublication());
  let prepared: Record<string, unknown> | undefined;
  view.runtime.ReaderNewsUI = { instance: { openPreparedArticle: (article: Record<string, unknown>) => { prepared = article; } } };
  const controller = workspace(view);
  await controller.open();
  element(view, "intelligence-open-news").click();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  assert.equal(prepared?.title, "已校验的正式情报");
  assert.match(String(prepared?.contentHtml), /https:\/\/example\.test\/source/);
  assert.match(String(prepared?.contentHtml), /注1/);
  assert.match(String(prepared?.contentHtml), /公开来源摘要/);
  assert.equal(view.calls.some((call) => /^(newsnow_|intelligence_store_|intelligence_generate_|intelligence_local_model_)/u.test(call.command)), false);
});

test("formal cached publications use local favourites only to reorder the visible event list", async () => {
  const publications = cachedPublicationWithTwoEvents();
  const view = fixture((command, args) => {
    if (command === "intelligence_client_cache_status") return cacheStatus();
    if (command === "intelligence_client_cached_publications") return publications;
    if (command === "ai_capability_routes_status") {
      return { routes: [{ capability: "news_preference", mode: "local" }] };
    }
    if (command === "score_news_preferences") {
      const request = args?.request as { readonly events?: readonly { readonly id: string; readonly title: string }[] } | undefined;
      return {
        model: "local-8b",
        scores: request?.events?.map((event) => ({
          id: event.id,
          score: event.title === "偏好事件" ? 95 : 4,
          reason: "仅用于本机排序",
        })) ?? [],
      };
    }
    throw new Error(`unexpected ${command}`);
  }, favoriteStorage());
  const controller = workspace(view);
  await controller.open();
  assert.equal(view.calls.filter((call) => call.command === "score_news_preferences").length, 1);
  const firstCard = element(view, "intelligence-digest-list").children[0]!;
  assert.equal(firstCard.children[1]?.children[0]?.textContent, "偏好事件");
  assert.equal(element(view, "intelligence-digest-list").children.length, 2, "scoring must never hide formal events");
  assert.match(element(view, "intelligence-processing-summary").textContent, /已按本机收藏偏好排序/);
  const preferenceRequest = view.calls.find((call) => call.command === "score_news_preferences")?.args?.request as Record<string, unknown> | undefined;
  assert.ok(preferenceRequest);
  assert.equal(JSON.stringify(preferenceRequest).includes("example.test"), false, "ranking request must not include source URLs");
});

test("news preference route off skips the model and retains formal publication order", async () => {
  const publications = cachedPublicationWithTwoEvents();
  const view = fixture((command) => {
    if (command === "intelligence_client_cache_status") return cacheStatus();
    if (command === "intelligence_client_cached_publications") return publications;
    if (command === "ai_capability_routes_status") return { routes: [{ capability: "news_preference", mode: "off" }] };
    throw new Error(`unexpected ${command}`);
  }, favoriteStorage());
  await workspace(view).open();
  assert.equal(view.calls.some((call) => call.command === "score_news_preferences"), false);
  const firstCard = element(view, "intelligence-digest-list").children[0]!;
  assert.equal(firstCard.children[1]?.children[0]?.textContent, "普通事件");
});

test("preference score cache avoids repeat model calls for unchanged formal cache and favourites", async () => {
  const publications = cachedPublicationWithTwoEvents();
  const view = fixture((command, args) => {
    if (command === "intelligence_client_cache_status") return cacheStatus();
    if (command === "intelligence_client_cached_publications") return publications;
    if (command === "ai_capability_routes_status") return { routes: [{ capability: "news_preference", mode: "auto" }] };
    if (command === "score_news_preferences") {
      const request = args?.request as { readonly events?: readonly { readonly id: string }[] } | undefined;
      return { model: "local-8b", scores: request?.events?.map((event) => ({ id: event.id, score: 50, reason: "缓存测试" })) ?? [] };
    }
    throw new Error(`unexpected ${command}`);
  }, favoriteStorage());
  const controller = workspace(view);
  await controller.open();
  view.calls.splice(0);
  await controller.open();
  assert.equal(view.calls.some((call) => call.command === "score_news_preferences"), false);
  assert.ok(view.storage.has("kunpeng.reader.intelligence.news-preference-scores.v1"));
});

test("malformed local preference output preserves the formal cached order", async () => {
  const publications = cachedPublicationWithTwoEvents();
  const view = fixture((command) => {
    if (command === "intelligence_client_cache_status") return cacheStatus();
    if (command === "intelligence_client_cached_publications") return publications;
    if (command === "ai_capability_routes_status") return { routes: [{ capability: "news_preference", mode: "local" }] };
    if (command === "score_news_preferences") return { model: "local-8b", scores: [{ id: "invented", score: 100, reason: "bad" }] };
    throw new Error(`unexpected ${command}`);
  }, favoriteStorage());
  await workspace(view).open();
  const firstCard = element(view, "intelligence-digest-list").children[0]!;
  assert.equal(firstCard.children[1]?.children[0]?.textContent, "普通事件");
  assert.equal(element(view, "intelligence-digest-list").children.length, 2);
});
