import assert from "node:assert/strict";
import test from "node:test";

import {
  installSemanticRuntimeCatalog,
  SEMANTIC_RUNTIME_CATALOG,
} from "./app-i18n-semantic-runtime-catalog.ts";

test("semantic runtime catalog preserves locale overrides and English fallback", () => {
  const copy: Record<string, Record<string, string>> = { en: {}, ja: {}, ko: {}, fr: {} };
  SEMANTIC_RUNTIME_CATALOG.apply(copy);
  assert.equal(copy.ja?.semModelReady, "準備完了");
  assert.equal(copy.ko?.semBuildMulti, "다중 프로필 만들기");
  assert.equal(copy.fr?.semSmallTitle, "Light semantic search · BGE Small Chinese");
});

test("semantic runtime catalog installer exposes the frozen original API", () => {
  const target: Record<string, unknown> = {};
  assert.equal(installSemanticRuntimeCatalog(target), SEMANTIC_RUNTIME_CATALOG);
  assert.equal(target.ReaderAppI18nSemanticRuntimeCatalog, SEMANTIC_RUNTIME_CATALOG);
  assert.equal(Object.isFrozen(SEMANTIC_RUNTIME_CATALOG), true);
});
