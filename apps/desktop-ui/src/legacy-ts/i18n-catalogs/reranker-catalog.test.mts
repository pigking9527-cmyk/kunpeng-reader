import assert from "node:assert/strict";
import test from "node:test";

import {
  installRerankerCatalog,
  RERANKER_CATALOG,
} from "./app-i18n-reranker-catalog.ts";

test("reranker catalog keeps the exact five classic locale maps", () => {
  assert.deepEqual(Object.keys(RERANKER_CATALOG), ["zh-CN", "zh-TW", "en", "ja", "ko"]);
  for (const copy of Object.values(RERANKER_CATALOG)) assert.equal(Object.keys(copy).length, 5);
  assert.equal(RERANKER_CATALOG.en?.semResumeReranker, "Resume reranker download");
  assert.equal(RERANKER_CATALOG["zh-CN"]?.semResumeReranker, "继续下载重排模型");
});

test("installer exposes only the original data global", () => {
  const target: Record<string, unknown> = {};
  assert.equal(installRerankerCatalog(target), RERANKER_CATALOG);
  assert.equal(target.ReaderAppI18nRerankerCatalog, RERANKER_CATALOG);
  assert.equal(installRerankerCatalog(null), null);
});
