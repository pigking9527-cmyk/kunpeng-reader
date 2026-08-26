import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkIntelligencePipelineArticles,
  emptyIntelligencePipelineState,
  intelligencePipelineArticleId,
  intelligencePipelineFingerprint,
  intelligenceQwenReviewGate,
  parseIntelligenceRelation,
  projectStableIntelligenceEvents,
  reduceIntelligencePipelineState,
  runIntelligenceArticleTriageQueue,
  type IntelligencePipelineArticle,
  type IntelligencePipelinePort,
} from "./intelligence-pipeline-state.ts";

function article(index: number): IntelligencePipelineArticle {
  const url = `https://example.test/news/${index}`;
  const title = `Article ${index}`;
  return {
    articleId: intelligencePipelineArticleId(url, `source-${index}`, title.toLowerCase()),
    fingerprint: intelligencePipelineFingerprint(`${url}\u001f${title}`),
    url,
    sourceKey: `source-${index}`,
    sourceName: `Source ${index}`,
    title,
  };
}

test("article batching never hard-cuts a collection to the daily briefing size", () => {
  const articles = Array.from({ length: 7_029 }, (_unused, index) => article(index));
  const batches = chunkIntelligencePipelineArticles(articles, 256);
  assert.equal(batches.length, 28);
  assert.equal(batches.flat().length, 7_029);
  assert.equal(new Set(batches.flat().map((item) => item.articleId)).size, 7_029);
});

test("pipeline counters preserve article units across queue transitions", () => {
  let state = emptyIntelligencePipelineState(1);
  state = reduceIntelligencePipelineState(state, { type: "upsert-started", received: 7_029, unique: 7_020 }, 2);
  state = reduceIntelligencePipelineState(state, { type: "upsert-finished", queued: 120, reused: 6_900 }, 3);
  state = reduceIntelligencePipelineState(state, { type: "triage-claimed", claimed: 12, remaining: 108 }, 4);
  state = reduceIntelligencePipelineState(state, {
    type: "triage-applied",
    remaining: 108,
    decisions: [
      { articleId: "a", fingerprint: "1", status: "keep" },
      { articleId: "b", fingerprint: "2", status: "filter" },
      { articleId: "c", fingerprint: "3", status: "failed" },
    ],
  }, 5);
  assert.equal(state.phase, "triaging");
  assert.equal(state.received, 7_029);
  assert.equal(state.unique, 7_020);
  assert.equal(state.queued, 120);
  assert.equal(state.reused, 6_900);
  assert.equal(state.kept, 1);
  assert.equal(state.filtered, 1);
  assert.equal(state.failed, 1);
  assert.equal(state.remaining, 108);
});

test("triage queue drains native leases and persists every returned decision", async () => {
  const batches = [[article(1), article(2)], [article(3)]];
  const applied: string[][] = [];
  let claim = 0;
  const port: IntelligencePipelinePort = {
    upsertArticles: async () => ({ received: 0, inserted: 0, updated: 0, unchanged: 0, queued: 0 }),
    claimTriage: async () => ({
      leaseOwner: "worker-a",
      articles: batches[claim++] ?? [],
      remaining: Math.max(0, 2 - claim),
    }),
    classifyArticles: async (articles) => articles.map((item, index) => ({
      articleId: item.articleId,
      fingerprint: item.fingerprint,
      status: index === 0 ? "keep" as const : "filter" as const,
      importance: 70,
      confidence: 0.9,
      reason: "bounded test",
    })),
    applyTriage: async (request) => { applied.push(request.decisions.map((decision) => decision.articleId)); },
  };
  const state = await runIntelligenceArticleTriageQueue(port, emptyIntelligencePipelineState(), {
    modelId: "Qwen3-8B-Q4_K_M",
    promptVersion: "article-triage-v2",
    yieldControl: async () => undefined,
  });
  assert.equal(state.phase, "completed");
  assert.equal(state.claimed, 3);
  assert.equal(state.kept, 2);
  assert.equal(state.filtered, 1);
  assert.deepEqual(applied.map((batch) => batch.length), [2, 1]);
});

test("model transport failure pauses without applying a leased batch", async () => {
  let applyCalls = 0;
  const port: IntelligencePipelinePort = {
    upsertArticles: async () => ({ received: 0, inserted: 0, updated: 0, unchanged: 0, queued: 0 }),
    claimTriage: async () => ({ leaseOwner: "worker-a", articles: [article(1)], remaining: 10 }),
    classifyArticles: async () => { throw new Error("model offline"); },
    applyTriage: async () => { applyCalls += 1; },
  };
  const state = await runIntelligenceArticleTriageQueue(port, emptyIntelligencePipelineState(), {
    modelId: "Qwen3-8B-Q4_K_M",
    promptVersion: "article-triage-v2",
  });
  assert.equal(state.phase, "paused");
  assert.equal(applyCalls, 0);
  assert.match(state.message, /断点续跑/);
});

test("relation taxonomy rejects unknown labels", () => {
  assert.equal(parseIntelligenceRelation("event_update"), "event_update");
  assert.equal(parseIntelligenceRelation("same topic"), null);
  assert.equal(parseIntelligenceRelation(null), null);
});

test("event projection merges only same-event edges and links updates into a stable series", () => {
  const events = projectStableIntelligenceEvents(["a", "b", "c", "d"], [
    { leftArticleId: "a", rightArticleId: "b", relation: "same_event", confidence: 0.98 },
    { leftArticleId: "b", rightArticleId: "c", relation: "event_update", confidence: 0.94 },
    { leftArticleId: "c", rightArticleId: "d", relation: "unrelated", confidence: 0.99 },
  ]);
  const merged = events.find((event) => event.articleIds.includes("a"));
  const update = events.find((event) => event.articleIds.includes("c"));
  const unrelated = events.find((event) => event.articleIds.includes("d"));
  assert.deepEqual(merged?.articleIds, ["a", "b"]);
  assert.ok(merged?.seriesId);
  assert.equal(merged?.seriesId, update?.seriesId);
  assert.equal(unrelated?.seriesId, undefined);
});

test("an additional source on the next day reuses the stored event and series ids", () => {
  const events = projectStableIntelligenceEvents(["old-source", "new-source", "follow-up"], [
    { leftArticleId: "old-source", rightArticleId: "new-source", relation: "same_event", confidence: 0.99 },
    { leftArticleId: "new-source", rightArticleId: "follow-up", relation: "event_update", confidence: 0.95 },
  ], [
    { articleId: "old-source", eventId: "event-stable-yesterday", seriesId: "series-stable-yesterday" },
  ]);
  const merged = events.find((event) => event.articleIds.includes("new-source"));
  const followUp = events.find((event) => event.articleIds.includes("follow-up"));
  assert.equal(merged?.eventId, "event-stable-yesterday");
  assert.equal(merged?.seriesId, "series-stable-yesterday");
  assert.equal(followUp?.seriesId, "series-stable-yesterday");
});

test("a model-only exact-duplicate label cannot erase two distinct source identities", () => {
  const events = projectStableIntelligenceEvents(["english-source", "chinese-source"], [
    { leftArticleId: "english-source", rightArticleId: "chinese-source", relation: "exact_duplicate", confidence: 0.99 },
  ]);
  assert.equal(events.length, 2);
});

test("Qwen review rate drops only after every quality gate passes", () => {
  const blocked = intelligenceQwenReviewGate({
    reviewed: 49,
    importantRecall: 0.99,
    mergePrecision: 0.99,
    falseMergeRate: 0,
    jsonCompliance: 1,
  });
  assert.equal(blocked.passed, false);
  assert.equal(blocked.qwenReviewRate, 1);
  const passed = intelligenceQwenReviewGate({
    reviewed: 80,
    importantRecall: 0.985,
    mergePrecision: 0.99,
    falseMergeRate: 0.005,
    jsonCompliance: 1,
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.qwenReviewRate, 0.05);
});
