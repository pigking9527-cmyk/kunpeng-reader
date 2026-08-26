import assert from "node:assert/strict";
import test from "node:test";

import {
  installIntelligenceAuditUi,
  normaliseIntelligenceAuditSnapshot,
} from "./intelligence-audit-ui.ts";

class FakeClassList {
  public add(): void {}
  public remove(): void {}
}

class FakeElement {
  public hidden = false;
  public textContent = "";
  public className = "";
  public type = "";
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly classList = new FakeClassList();
  private readonly listeners = new Map<string, Array<() => void>>();

  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  public replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
  public append(...children: FakeElement[]): void { this.children.push(...children); }
  public focus(): void {}
  public click(): void { this.listeners.get("click")?.forEach((listener) => listener()); }
}

function fixture(): { readonly runtime: Record<string, unknown>; readonly elements: Map<string, FakeElement> } {
  const ids = [
    "intelligence-workspace-page", "intelligence-open-audit", "intelligence-audit-view", "intelligence-audit-back",
    "intelligence-audit-overview", "intelligence-audit-flow", "intelligence-audit-detail",
    "intelligence-standard-view", "intelligence-digest-history",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const runtime: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new FakeElement(),
    },
    addEventListener: () => undefined,
  };
  return { runtime, elements };
}

test("audit snapshot bounds public text and retains the nine process stages", () => {
  const normalised = normaliseIntelligenceAuditSnapshot({
    runId: "batch-a",
    summary: "本地处理完成",
    stages: [
      { id: "article-triage", status: "accepted", items: [{ title: "甲公司财报", reason: "主体一致" }] },
      { id: "collected", count: 7, status: "cached" },
    ],
  });
  assert.equal(normalised?.stages?.length, 2);
  assert.deepEqual(normalised?.stages?.map((stage) => stage.id), ["collected", "article-triage"]);
  assert.equal(normalised?.stages?.[1]?.items?.[0]?.reason, "主体一致");
});

test("audit opens a nine-stage process map and only renders the selected detail page", () => {
  const view = fixture();
  const global = installIntelligenceAuditUi(view.runtime);
  assert.ok(global?.instance);
  global.instance.setSnapshot({
    summary: "采集 12 条，已排除主体冲突的候选。",
    stages: [
      { id: "collected", count: 12, status: "accepted" },
      { id: "article-triage", status: "running", summary: "正在逐篇判定 12 篇文章。", items: Array.from({ length: 12 }, (_, index) => ({
        title: `候选 ${index + 1}`,
        meta: "财报 · 主体冲突",
        reason: "公司主体不同，不合并。",
        status: "rejected" as const,
        confidence: 0.98,
      })) },
    ],
  });
  view.elements.get("intelligence-open-audit")?.click();
  assert.equal(view.elements.get("intelligence-audit-view")?.hidden, false);
  assert.equal(view.elements.get("intelligence-standard-view")?.hidden, true);
  assert.equal(view.elements.get("intelligence-audit-flow")?.children.length, 9);
  const detail = view.elements.get("intelligence-audit-detail")?.children[0];
  assert.equal(detail?.children[0]?.children[0]?.children[1]?.textContent, "逐篇初筛");
  const records = detail?.children[2];
  assert.equal(records?.children.length, 10);
  const more = detail?.children[3];
  more?.click();
  assert.equal(view.elements.get("intelligence-audit-detail")?.children[0]?.children[2]?.children.length, 12);
  view.elements.get("intelligence-audit-back")?.click();
  assert.equal(view.elements.get("intelligence-audit-view")?.hidden, true);
  assert.equal(view.elements.get("intelligence-standard-view")?.hidden, false);
});

test("audit detail loader fetches only one bounded page when the audit opens", async () => {
  const view = fixture();
  const global = installIntelligenceAuditUi(view.runtime);
  assert.ok(global?.instance);
  const requests: Array<{ stageId: string; offset: number; limit: number }> = [];
  global.instance.setDetailLoader(async ({ stageId, offset, limit }) => {
    requests.push({ stageId, offset, limit });
    return {
      total: 7_029,
      items: Array.from({ length: limit }, (_, index) => ({
        title: `记录 ${offset + index + 1}`,
        status: "accepted" as const,
      })),
    };
  });
  global.instance.setSnapshot({
    runId: "full-day-2026-08-23",
    stages: [
      { id: "collected", count: 7_029, outputCount: 7_029, status: "running" },
    ],
  });

  view.elements.get("intelligence-open-audit")?.click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [{ stageId: "collected", offset: 0, limit: 10 }]);
  const detail = view.elements.get("intelligence-audit-detail")?.children[0];
  assert.equal(detail?.children[2]?.children.length, 10);
  assert.equal(detail?.children[0]?.children[1]?.textContent, "10 / 7029 篇文章");
});
