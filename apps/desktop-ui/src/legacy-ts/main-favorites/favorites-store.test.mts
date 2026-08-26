import assert from "node:assert/strict";
import test from "node:test";

import {
  FAVORITES_CHANGED_EVENT,
  FAVORITES_STORAGE_KEY,
  isFavorite,
  listFavorites,
  removeFavorite,
  toggleFavorite,
  type FavoritesStorage,
} from "./favorites-store.ts";

class MemoryStorage implements FavoritesStorage {
  public readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("favorites store keeps booklists and safe news metadata in one bounded schema", () => {
  const storage = new MemoryStorage();
  const events: string[] = [];
  const options = {
    storage,
    eventTarget: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } },
    now: () => 1_725_000_000_000,
  };
  assert.equal(toggleFavorite({
    kind: "booklist",
    id: "list-1",
    title: "航天阅读",
    description: "近期书单",
  }, options), true);
  assert.equal(toggleFavorite({
    kind: "news",
    id: "event-1",
    title: "聚变推进完成验证",
    summary: "多来源综合摘要",
    source: "本机综合",
    publishedAt: "2026-08-23T08:00:00Z",
    category: "科技",
    url: "https://example.test/article",
    eventId: "event-1",
    revision: 2,
  }, options), true);

  assert.equal(isFavorite("booklist", "list-1", options), true);
  assert.equal(isFavorite("news", "event-1", options), true);
  assert.deepEqual(listFavorites("booklist", options).map((item) => item.id), ["list-1"]);
  const news = listFavorites("news", options)[0];
  assert.equal(news?.kind, "news");
  assert.equal(news?.url, "https://example.test/article");
  assert.deepEqual(events, [FAVORITES_CHANGED_EVENT, FAVORITES_CHANGED_EVENT]);
  assert.match(storage.values.get(FAVORITES_STORAGE_KEY) ?? "", /^\{"version":1,/u);
});

test("favorites store strips unsafe reopen URLs and toggles an existing record off", () => {
  const storage = new MemoryStorage();
  const options = { storage, eventTarget: null, now: () => 100 };
  const input = {
    kind: "news" as const,
    id: "news-1",
    title: "安全收藏",
    summary: "摘要",
    source: "来源",
    publishedAt: "today",
    category: "综合",
    url: "file:///C:/private/book.epub",
  };
  assert.equal(toggleFavorite(input, options), false);
  assert.equal(listFavorites("news", options).length, 0, "unsafe news without an event id must not persist");
  const safeInput = { ...input, url: "https://example.test/story?utm_source=reader&gclid=secret&token=private#section" };
  assert.equal(toggleFavorite(safeInput, options), true);
  assert.equal((listFavorites("news", options)[0] as { readonly url?: string } | undefined)?.url, "https://example.test/story");
  assert.equal(toggleFavorite(safeInput, options), false);
  assert.equal(listFavorites(undefined, options).length, 0);
});

test("removeFavorite only reports a persisted removal", () => {
  const storage = new MemoryStorage();
  const options = { storage, eventTarget: null };
  toggleFavorite({ kind: "booklist", id: "list-2", title: "待看", description: "" }, options);
  assert.equal(removeFavorite("news", "list-2", options), false);
  assert.equal(removeFavorite("booklist", "list-2", options), true);
  assert.equal(isFavorite("booklist", "list-2", options), false);
});

test("toggle reports the prior state when persistence fails", () => {
  const backing = new MemoryStorage();
  const input = { kind: "booklist" as const, id: "durable", title: "已收藏书单", description: "" };
  assert.equal(toggleFavorite(input, { storage: backing, eventTarget: null }), true);
  const failing = {
    getItem: (key: string) => backing.getItem(key),
    setItem: () => { throw new Error("quota"); },
  };
  assert.equal(toggleFavorite(input, { storage: failing, eventTarget: null }), true, "failed removal remains favorited");
  assert.equal(toggleFavorite({ ...input, id: "new" }, { storage: failing, eventTarget: null }), false, "failed addition remains absent");
});

test("favorites persistence trims oldest records to the two MiB boundary", () => {
  const storage = new MemoryStorage();
  const oversized = Array.from({ length: 500 }, (_unused, index) => ({
    kind: "news",
    id: `old-${index}`,
    title: `旧资讯 ${index} ${"题".repeat(480)}`,
    summary: "摘".repeat(1_180),
    source: "来源".repeat(100),
    publishedAt: "2026-08-23T08:00:00Z",
    category: "科技",
    url: `https://example.test/${index}/${"a".repeat(1_800)}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({ version: 1, items: oversized }));
  assert.equal(toggleFavorite({
    kind: "booklist",
    id: "newest-list",
    title: "最新收藏书单",
    description: "必须保留",
  }, { storage, eventTarget: null, now: () => 10_000 }), true);
  const serialized = storage.getItem(FAVORITES_STORAGE_KEY) ?? "";
  assert.ok(new TextEncoder().encode(serialized).byteLength <= 2 * 1024 * 1024);
  assert.equal(isFavorite("booklist", "newest-list", { storage, eventTarget: null }), true);
  assert.ok(listFavorites(undefined, { storage, eventTarget: null }).length < 500);
});
