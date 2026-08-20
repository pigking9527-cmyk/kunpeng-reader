import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import { installNewsRules, type NewsRulesApi } from "./news-rules.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function legacyNewsRules(): NewsRulesApi {
  const context: Record<string, unknown> = { URL, Set };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(
    execFileSync("git", ["show", "HEAD:ui/news-rules.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    context,
  );
  return context.ReaderNewsRules as NewsRulesApi;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("news strict rules preserve the exact classic VM API and outputs", () => {
  const legacy = legacyNewsRules();
  const target: Record<string, unknown> = {};
  const strict = installNewsRules(target);
  assert.deepEqual(Object.keys(strict).sort(), Object.keys(legacy).sort());
  assert.equal(Object.isFrozen(strict), true);
  assert.equal(target.ReaderNewsRules, strict);

  for (const value of [null, undefined, 0, false, " ", "news", { value: 3 }]) {
    assert.equal(strict.text(value), legacy.text(value));
  }
  for (const value of [
    "https://example.com/a?b=1",
    "http://example.com",
    "javascript:alert(1)",
    "invalid",
    null,
  ]) {
    assert.equal(strict.safeHttpUrl(value), legacy.safeHttpUrl(value));
  }
  for (const value of [
    "data:image/png;base64,AAAA==",
    " data:image/webp;base64,a+/= ",
    "data:image/svg+xml;base64,AAAA",
    "https://example.com/image.png",
  ]) {
    assert.equal(strict.safeImageDataUrl(value), legacy.safeImageDataUrl(value));
  }

  const items = [
    { url: "https://example.com/one", previewAttempted: false },
    { link: "http://example.com/two", preview_attempted: false },
    { href: "https://example.com/three", previewDataUrl: "data:image/png;base64,AAAA" },
  ];
  for (const result of [items, { items }, { data: items }, { news: items }, { items: null }]) {
    assert.deepEqual(plain(strict.resultItems(result)), plain(legacy.resultItems(result)));
    assert.equal(strict.hasPendingPreviews(result), legacy.hasPendingPreviews(result));
  }
  for (const item of [...items, null, {}, { preview_attempted: true }]) {
    assert.equal(strict.previewAttempted(item), legacy.previewAttempted(item));
  }
  for (const item of [
    {
      previewDataUrl: "",
      preview_data_url: "data:image/png;base64,AAAA",
    },
    { url: "", link: "https://example.com/fallback" },
    { url: 0, href: "https://example.com/number-fallback" },
  ]) {
    assert.equal(strict.previewAttempted(item), legacy.previewAttempted(item));
    assert.equal(
      strict.hasPendingPreviews({ items: [item] }),
      legacy.hasPendingPreviews({ items: [item] }),
    );
  }

  const catalog = [
    { id: "a", defaultEnabled: true },
    { id: "b", default_enabled: 1 },
    { id: "c", defaultEnabled: false },
    { id: 3, defaultEnabled: true },
  ];
  assert.deepEqual(
    plain(strict.defaultSourceIds(catalog)),
    plain(legacy.defaultSourceIds(catalog)),
  );
  for (const maximum of [-1, 0, 2, 24]) {
    assert.deepEqual(
      plain(strict.allowedSourceIds(["b", "a", "b", "x", 3], catalog, maximum)),
      plain(legacy.allowedSourceIds(["b", "a", "b", "x", 3], catalog, maximum)),
    );
  }

  const bars = ["　猫吧 ", "猫", "狗吧", "bad\u0000", "x".repeat(49), 7];
  for (const maximum of [-1, 0, 2, 8]) {
    assert.deepEqual(
      plain(strict.normalizeTiebaBars(bars, maximum)),
      plain(legacy.normalizeTiebaBars(bars, maximum)),
    );
    assert.deepEqual(
      plain(strict.enabledTiebaBars(["猫", "不存在", "狗吧"], bars, maximum)),
      plain(legacy.enabledTiebaBars(["猫", "不存在", "狗吧"], bars, maximum)),
    );
  }
});
