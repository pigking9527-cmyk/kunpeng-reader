import assert from "node:assert/strict";
import test from "node:test";

import { installNewsSurfaceCatalog, NEWS_SURFACE_CATALOG } from "./app-i18n-news-surface-catalog.ts";

test("news surface catalog preserves all ten locale surfaces", () => {
  const locales = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"];
  const copy = Object.fromEntries(locales.map((locale) => [locale, {}])) as Record<string, Record<string, string>>;
  NEWS_SURFACE_CATALOG.apply(copy);
  for (const locale of locales) {
    assert.equal(Object.keys(copy[locale] ?? {}).length, 49, `unexpected news surface size for ${locale}`);
  }
  assert.equal(copy["zh-CN"]?.newsTitle, "今日资讯");
  assert.equal(copy.ja?.newsLoadFailed, "ニュースを読み込めませんでした。ネットワークを確認してからもう一度お試しください。");
  assert.equal(copy["pt-BR"]?.tiebaConfirm, "Confirmar");
});
test("news surface catalog installer exposes the frozen original API", () => {
  const target: Record<string, unknown> = {};
  assert.equal(installNewsSurfaceCatalog(target), NEWS_SURFACE_CATALOG);
  assert.equal(target.ReaderAppI18nNewsSurfaceCatalog, NEWS_SURFACE_CATALOG);
  assert.equal(Object.isFrozen(NEWS_SURFACE_CATALOG), true);
});
