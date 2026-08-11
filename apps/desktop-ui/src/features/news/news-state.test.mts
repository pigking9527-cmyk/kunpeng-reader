import assert from "node:assert/strict";
import test from "node:test";
import type { NewsFeedSnapshot, NewsPreferences, NewsSource } from "./news-port.ts";
import { createNewsState, newsReducer } from "./news-state.ts";

const catalog: readonly NewsSource[] = [{ id: "source", name: "来源", category: "测试", defaultEnabled: true }];
const preferences: NewsPreferences = { sourceIds: ["source"], tiebaBars: [], enabledTiebaBars: [], layout: "list", order: "mixed" };
const feed: NewsFeedSnapshot = { items: [], fetchedAt: "2026-08-10T00:00:00Z", stale: false };

test("stale requests cannot replace a newer news result", () => {
  let state = createNewsState();
  state = newsReducer(state, { type: "load-started", requestId: 2 });
  const stale = newsReducer(state, { type: "load-empty", requestId: 1, catalog, preferences, feed });
  assert.equal(stale, state);
  const fresh = newsReducer(state, { type: "load-empty", requestId: 2, catalog, preferences, feed });
  assert.equal(fresh.phase, "empty");
});

test("opening an article does not alter request state or feed preferences", () => {
  const state = newsReducer(createNewsState(), { type: "article-opened", article: { itemId: "item", title: "正文", sourceName: "来源", paragraphs: ["安全文本"] } });
  assert.equal(state.article?.paragraphs[0], "安全文本");
  assert.equal(state.preferences, null);
});
