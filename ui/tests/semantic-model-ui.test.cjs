const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const semanticUi = fs.readFileSync(path.join(root, "semantic-ui.js"), "utf8");
const semanticCache = fs.readFileSync(path.join(root, "semantic-status-cache.js"), "utf8");
const i18n = fs.readFileSync(path.join(root, "app-i18n.js"), "utf8");

test("semantic model picker offers Chinese and multilingual local models", () => {
  assert.match(html, /value="bge-small-zh-v1\.5" data-i18n="semModelSmall"/);
  assert.match(html, /value="bge-large-zh-v1\.5" data-i18n="semModelLarge"/);
  assert.match(html, /value="bge-m3" data-i18n="semModelM3"/);
  assert.match(html, /value="multilingual-e5-small" data-i18n="semModelE5"/);
  assert.doesNotMatch(html, /完整语义检索|GPU 加速组件|一键启用/);
});

test("model picker explains local model choices and reads the normal task status", () => {
  assert.match(semanticUi, /semSmallTitle/);
  assert.match(semanticUi, /semLargeTitle/);
  assert.match(semanticUi, /semM3Title/);
  assert.match(semanticUi, /semE5Title/);
  assert.match(html, /data-i18n="semRetrievalStrategy"/);
  assert.match(html, /data-i18n="semM3Index"/);
  assert.match(html, /id="sem-retrieval-m3-option"/);
  assert.doesNotMatch(html, /id="sem-m3-long-context"/);
  assert.match(semanticUi, /semRetrievalStandardCopy/);
  assert.match(semanticUi, /semRetrievalHighCopy/);
  assert.match(semanticUi, /semRetrievalM3Copy/);
  assert.match(html, /<div class="sem-title" data-i18n="semGpu">/);
  assert.match(i18n, /const SEMANTIC_SETTINGS_COPY/);
  assert.match(semanticUi, /invoke\("semantic_gpu_status"\)/);
  assert.match(semanticUi, /invoke\("semantic_tasks", \{ reconcile \}\)/);
  assert.doesNotMatch(semanticUi, /GPU 加速组件/);
});

test("Chinese and E5 models hide M3-only controls but keep general reranking", () => {
  assert.match(semanticUi, /const supportsM3Hybrid = activeModel === "bge-m3"/);
  assert.match(semanticUi, /retrievalM3Option\.hidden = !supportsM3Hybrid/);
  assert.match(semanticUi, /m3Section\.hidden = !supportsM3Hybrid/);
  assert.match(semanticUi, /semRerankerReady/);
  assert.match(semanticUi, /semM3Ready/);
  assert.doesNotMatch(semanticUi, /set_semantic_m3_long_context/);
});

test("reranker distinguishes downloaded files from a loaded runtime", () => {
  assert.match(semanticUi, /reranker_loading/);
  assert.match(semanticUi, /reranker_downloaded/);
  assert.match(semanticUi, /semLoadReranker/);
});

test("an undownloaded model presents its expected download size", () => {
  assert.match(semanticUi, /downloadEstimate: "95 MB"/);
  assert.match(semanticUi, /downloadEstimate: "1\.3 GB"/);
  assert.match(semanticUi, /downloadEstimate: "620 MB"/);
  assert.match(semanticUi, /downloadEstimate: "450 MB"/);
  assert.match(semanticUi, /semModelNotDownloaded/);
  assert.match(semanticUi, /modelDownloadButton\.disabled = !!progress\.model_ready/);
});

test("semantic management opens with a cached lightweight snapshot and reconciles after a model switch", () => {
  const openStart = semanticUi.indexOf("function open()");
  const openEnd = semanticUi.indexOf("function close()", openStart);
  const open = semanticUi.slice(openStart, openEnd);
  assert.doesNotMatch(html, /id="sem-status-refresh"/);
  assert.ok(open.indexOf("cache.get()") < open.indexOf("setTimeout(() => { void refresh(false); }"));
  assert.doesNotMatch(open, /refreshGpuStatus\(\)/);
  assert.match(semanticUi, /invoke\("semantic_tasks", \{ reconcile \}\)/);
  assert.match(semanticUi, /select_semantic_model[\s\S]*?await refresh\(true\);/);
  assert.match(semanticUi, /if \(statusInFlight\) return/);
  assert.match(semanticUi, /updatePolling\(!!\(progress\.model_downloading \|\| progress\.building \|\| progress\.reranker_loading \|\| refreshing\)\)/);
  assert.doesNotMatch(open, /build_semantic_vectors|spawn_outdated_chunk_rebuild/);
});

test("semantic status stays usable while exact metadata verification runs", () => {
  assert.doesNotMatch(semanticUi, /disabled = busy \|\| refreshing/);
  assert.doesNotMatch(semanticUi, /正在后台读取索引状态/);
  assert.match(semanticUi, /const cachedNext = cache\.use\(next\)/);
  assert.doesNotMatch(semanticUi, /select_semantic_model[\s\S]{0,180}cache\.clear\(\)/);
  assert.match(semanticCache, /semanticIndexStatusByModelV3/);
  assert.doesNotMatch(semanticCache, /semanticIndexStatusByModelV2/);
  assert.match(semanticCache, /statuses\[next\.model_id\] = next/);
  assert.match(semanticCache, /function use\(modelId\)/);
  assert.match(semanticUi, /if \(!refreshing\) \{\s*cache\.save\(progress\)/);
});

test("semantic management does not present ambiguous disk usage as an exact size", () => {
  assert.doesNotMatch(semanticUi, /缓存大小/);
  assert.doesNotMatch(semanticUi, /，占用 /);
});

test("advanced index cards explain their user-facing effects", () => {
  assert.match(semanticUi, /semAcceleratorDescription/);
  assert.match(semanticUi, /semMultiProfileDescription/);
  assert.match(html, /data-i18n="semRefreshGpu"/);
});

test("semantic settings are catalog-based and refresh when the app language changes", () => {
  for (const key of ["semTitle", "semDescription", "semSelectModel", "semGpu", "semRetrievalStrategy", "semReranker", "semM3Index", "semAccelerator", "semMultiProfile"]) {
    assert.match(html, new RegExp(`data-i18n(?:-aria)?="${key}"`));
  }
  assert.match(i18n, /ja: \{ semTitle: "セマンティック索引"/);
  assert.match(i18n, /ko: \{ semTitle: "의미 색인"/);
  assert.match(semanticUi, /app-language-changed/);
  assert.match(semanticUi, /global\.ReaderAppI18n\?\.apply\?\.\(modal\)/);
  assert.doesNotMatch(semanticUi, /task\?\.detail/);
});
