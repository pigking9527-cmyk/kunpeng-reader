const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const semanticUi = fs.readFileSync(path.join(root, "generated-ts", "semantic-ui.js"), "utf8");
const semanticCache = fs.readFileSync(path.join(root, "generated-ts", "semantic-status-cache.js"), "utf8");
const i18n = fs.readFileSync(path.join(root, "generated-ts", "app-i18n.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const repoRoot = path.resolve(root, "..");
const semanticTasksRust = fs.readFileSync(path.join(repoRoot, "src", "semantic_tasks.rs"), "utf8");
const cargoToml = fs.readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
const gpuRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "gpu.rs"), "utf8");
const gpuRuntimeRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "gpu_runtime.rs"), "utf8");
const modelRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "model.rs"), "utf8");
const windowsBundle = fs.readFileSync(path.join(repoRoot, "packaging", "windows", "tauri.release.conf.json"), "utf8");
const linuxBundle = fs.readFileSync(path.join(repoRoot, "tauri.linux.conf.json"), "utf8");

test("semantic model picker offers Chinese and multilingual local models", () => {
  assert.match(html, /value="bge-small-zh-v1\.5" data-i18n="semModelSmall"/);
  assert.match(html, /value="bge-large-zh-v1\.5" data-i18n="semModelLarge"/);
  assert.match(html, /value="bge-m3" data-i18n="semModelM3"/);
  assert.match(html, /value="multilingual-e5-small" data-i18n="semModelE5"/);
  assert.doesNotMatch(html, /完整语义检索|一键启用/);
});

test("Windows and Linux keep optional CUDA code but do not bundle unreviewed providers", () => {
  assert.match(cargoToml, /target_os = "windows".*target_os = "linux"/);
  assert.match(cargoToml, /ort = \{ version = "=2\.0\.0-rc\.12", features = \["cuda"\] \}/);
  assert.match(gpuRust, /provider_component_present\(\)/);
  assert.match(modelRust, /with_execution_providers\(execution_providers/);
  for (const bundle of [windowsBundle, linuxBundle]) {
    assert.doesNotMatch(bundle, /onnxruntime_providers_cuda/);
    assert.doesNotMatch(bundle, /cudart|cudnn/i);
  }
});
test("NVIDIA runtime redistribution stays disabled pending legal review", () => {
  assert.match(html, /id="sem-gpu-install"/);
  assert.match(semanticUi, /runtime_install_available/);
  assert.match(gpuRuntimeRust, /DOWNLOAD_BYTES: u64 = 0/);
  assert.match(gpuRuntimeRust, /install_available\(\) -> bool \{\s*false/);
  assert.match(gpuRuntimeRust, /自动下载已暂停/);
  assert.doesNotMatch(gpuRuntimeRust, /https:\/\//);
  assert.match(gpuRust, /spawn_blocking\(semantic_gpu_status_blocking\)/);
  assert.match(gpuRust, /runtime_downloaded_bytes/);
  assert.match(gpuRust, /creation_flags\(0x0800_0000\)/);
  assert.match(styles, /#sem-gpu-meta \{\s*height: 1\.45em;\s*overflow: hidden;/);
  assert.match(styles, /#sem-gpu-section \.sem-actions \{\s*min-width: 230px;/);
  assert.doesNotMatch(windowsBundle, /cudart64_12\.dll|cudnn64_9\.dll/);
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
  assert.match(semanticUi, /gpuStatus\?\.runtime_ready/);
  assert.match(semanticUi, /semGpuReady/);
  assert.match(i18n, /semGpuReady: "加速功能已就绪。"/);
  assert.match(semanticUi, /invoke\("semantic_tasks", \{ reconcile \}\)/);
  assert.match(semanticUi, /install_semantic_gpu_runtime/);
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
  assert.match(semanticUi, /reranker_partial/);
  assert.match(semanticUi, /progress\.reranker_ready \|\| progress\.reranker_downloaded/);
  assert.match(html, /id="sem-reranker-download"/);
  assert.match(semanticUi, /rerankerDownloadButton/);
  assert.match(semanticUi, /download_semantic_reranker/);
  assert.match(semanticUi, /semResumeReranker/);
  assert.match(semanticUi, /semRerankerNotDownloaded/);
  assert.match(semanticCache, /reranker_downloaded: Boolean\(input\.reranker_downloaded\)/);
  assert.match(semanticCache, /reranker_partial: Boolean\(input\.reranker_partial\)/);
  assert.match(semanticCache, /reranker_downloaded: fallback\("reranker_downloaded"\)/);
  assert.match(semanticCache, /reranker_partial: fallback\("reranker_partial"\)/);
  assert.match(semanticTasksRust, /fn begin_reranker_load/);
  assert.match(semanticTasksRust, /if reranker_loading \{[\s\S]*?begin_reranker_load[\s\S]*?return Ok\(task\);/);
  assert.match(semanticTasksRust, /if !reranker_task \{\s*clear_sem_status_cache\(\);/);
});

test("high-precision retrieval loads only a manually downloaded reranker without blocking a query", () => {
  const retrievalRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "retrieval.rs"), "utf8");
  const semanticRust = fs.readFileSync(path.join(repoRoot, "src", "semantic.rs"), "utf8");
  const searchRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "search.rs"), "utf8");
  assert.match(retrievalRust, /pub\(super\) fn ensure_reranker_loading\(app: &tauri::AppHandle\)/);
  assert.match(retrievalRust, /if !active_mode\(\)\.uses_reranker\(\) \|\| !reranker_available_disk\(\) \{/);
  assert.match(retrievalRust, /let _ = download_reranker\(app\.clone\(\)\);/);
  assert.doesNotMatch(retrievalRust, /select_mode[\s\S]*?ensure_reranker_loading\(&app\)/);
  assert.doesNotMatch(semanticRust, /retrieval::ensure_reranker_loading\(&app\);/);
  assert.match(searchRust, /super::retrieval::ensure_reranker_loading\(&app\);/);
});

test("an undownloaded model presents its expected download size", () => {
  assert.match(semanticUi, /downloadEstimate: "95 MB"/);
  assert.match(semanticUi, /downloadEstimate: "1\.3 GB"/);
  assert.match(semanticUi, /downloadEstimate: "620 MB"/);
  assert.match(semanticUi, /downloadEstimate: "450 MB"/);
  assert.match(semanticUi, /semModelNotDownloaded/);
  assert.match(semanticUi, /modelDownloadButton\.disabled = !!progress\.model_ready/);
});

test("an empty semantic index hides its progress track and delete action", () => {
  assert.match(html, /id="sem-vector-progress" class="sem-progressbar"/);
  assert.match(semanticUi, /const hasSemanticIndex = vectorLive \|\| vectorDone > 0 \|\| !!progress\.semantic_ready/);
  assert.match(semanticUi, /vectorProgress\.hidden = vectorStatusChecking \|\| !hasSemanticIndex/);
  assert.match(semanticUi, /!hasSemanticIndex\s*\? semText\("semNotBuilt"/);
  assert.match(semanticUi, /vectorDeleteButton\.disabled = vectorStatusChecking \|\| \(vectorTask \? !vectorTask\.can_delete : busy \|\| vectorDone <= 0\)/);
});

test("semantic index waits for verification before showing an empty or completed result", () => {
  assert.match(semanticUi, /const vectorStatusChecking = refreshing && !vectorLive/);
  assert.match(semanticUi, /vectorStatusChecking\s*\?\s*semText\("semCheckingIndex"/);
  assert.match(semanticUi, /vectorProgress\.hidden = vectorStatusChecking \|\| !hasSemanticIndex/);
  assert.match(semanticUi, /vectorBuildButton\.disabled = vectorStatusChecking \|\| busy/);
  assert.match(semanticUi, /vectorDeleteButton\.disabled = vectorStatusChecking \|\|/);
  assert.match(i18n, /semCheckingIndex: "正在检测语义索引进度…"/);
});

test("deleting a semantic index cannot keep an old cached progress snapshot", () => {
  assert.match(semanticUi, /semanticPort\.deleteIndex\("semantic"\)[\s\S]*?\(\) => semanticCache\.clear\(\)/);
  const semanticStatusRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "status.rs"), "utf8");
  const semanticRust = fs.readFileSync(path.join(repoRoot, "src", "semantic.rs"), "utf8");
  assert.match(semanticStatusRust, /cache\.snapshot = None/);
  assert.match(semanticRust, /p\.semantic_done = 0/);
  assert.match(semanticRust, /p\.accelerator_done = 0/);
});

test("semantic indexing identifies active GPU acceleration beneath the book progress", () => {
  assert.match(html, /id="sem-vector-gpu-meta"[\s\S]*?class="sem-index-acceleration"[\s\S]*?hidden/);
  assert.match(semanticUi, /const gpuIndexing = vectorLive && !!gpuStatus\?\.runtime_ready/);
  assert.match(semanticUi, /vectorGpuMeta\.hidden = !gpuIndexing/);
  assert.match(semanticUi, /semGpuIndexing/);
  assert.match(i18n, /semGpuIndexing: "GPU 加速索引中"/);
  assert.match(styles, /\.sem-index-acceleration/);
});

test("model download reports textual byte progress instead of adding a second progress bar", () => {
  assert.match(semanticUi, /function formatBytes\(bytes\)/);
  assert.match(semanticUi, /const modelDownloadPercent/);
  assert.match(semanticUi, /semModelDownloadProgress/);
  assert.match(semanticUi, /modelDownloaded > 0 && modelDownloadTotal > 0/);
  assert.match(i18n, /semModelDownloadProgress:\s*"正在下载模型：\{percent\}%（\{downloaded\}\/\{total\}）"/);
  assert.match(modelRust, /pub\(super\) fn downloaded_bytes\(\) -> u64/);
  assert.match(modelRust, /fn tree_bytes\(path: &std::path::Path\) -> u64/);
});

test("model cards and switch feedback show the actual vector dimensions", () => {
  assert.match(semanticUi, /const SEMANTIC_MODEL_DIMENSIONS = Object\.freeze/);
  assert.match(semanticUi, /"bge-small-zh-v1\.5": 512/);
  assert.match(semanticUi, /"bge-large-zh-v1\.5": 1024/);
  assert.match(semanticUi, /"bge-m3": 1024/);
  assert.match(semanticUi, /"multilingual-e5-small": 384/);
  assert.match(semanticUi, /semVectorDimensions/);
  assert.match(semanticUi, /semModelSwitching/);
  assert.match(semanticUi, /semModelSwitched/);
  assert.match(i18n, /semModelSwitched: "已切换为 \{model\}（\{dimensions\} 维向量）。"/);
  assert.match(modelRust, /Self::BgeSmallZhV15 => 512/);
  assert.match(modelRust, /Self::BgeLargeZhV15 => 1024/);
  assert.match(modelRust, /Self::BgeM3 => 1024/);
  assert.match(modelRust, /Self::MultilingualE5Small => 384/);
});

test("semantic management reconciles on open and after a background task settles", () => {
  const openStart = semanticUi.indexOf("function open()");
  const openEnd = semanticUi.indexOf("function close()", openStart);
  const open = semanticUi.slice(openStart, openEnd);
  assert.doesNotMatch(html, /id="sem-status-refresh"/);
  assert.ok(open.indexOf("semanticCache.get()") < open.indexOf("void refresh(true)"));
  assert.match(
    semanticUi,
    /global\.setInterval\(\(\) => \{\s*void refresh\(true\);\s*\}, 1500\)/,
  );
  assert.match(open, /refreshGpuStatus\(\)/);
  assert.match(semanticUi, /gpuRefreshInFlight/);
  assert.match(semanticUi, /runtime_downloaded_bytes/);
  assert.doesNotMatch(semanticUi, /semGpuDownloadSaved/);
  assert.match(semanticUi, /semResumeGpuRuntime/);
  assert.match(semanticUi, /semanticPort\.tasks\(reconcile\)/);
  assert.match(semanticUi, /semanticPort\.selectModel\(next\)[\s\S]*?await refresh\(true\);/);
  assert.match(semanticUi, /if \(statusInFlight\) return/);
  assert.match(
    semanticUi,
    /updatePolling\(\s*!!\(progress\.model_downloading \|\| progress\.building \|\| progress\.reranker_loading \|\| refreshing\)\s*\)/,
  );
  assert.doesNotMatch(open, /build_semantic_vectors|spawn_outdated_chunk_rebuild/);
});

test("closing and reopening semantic management preserves the live task snapshot until it refreshes", () => {
  for (const field of ["building", "active_task", "done", "total", "current"]) {
    assert.match(semanticCache, new RegExp(`${field}:`), `cache must preserve ${field}`);
  }
  assert.match(semanticCache, /building: Boolean\(input\.building\)/);
  const semanticStatusRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "status.rs"), "utf8");
  assert.match(semanticStatusRust, /fn hydrate_vector_task/);
  assert.match(semanticStatusRust, /BackgroundTaskState::Paused/);
  assert.match(semanticStatusRust, /progress\.building = !paused/);
  assert.match(semanticStatusRust, /\.snapshots\(\)/);
  assert.match(semanticStatusRust, /BackgroundTaskKind::SemanticVectors/);
  assert.match(semanticStatusRust, /active_vector_task_progress/);
  assert.match(semanticUi, /const cached = semanticCache\.get\(\);[\s\S]*?if \(cached\) render\(cached\);/);
  assert.match(
    semanticUi,
    /updatePolling\(\s*!!\(progress\.model_downloading \|\| progress\.building/,
  );
  assert.match(semanticUi, /vectorBuildButton\.disabled = vectorStatusChecking \|\| busy \|\| \(vectorTask \? !vectorTask\.can_start/);
});


test("semantic reopen reads the durable generic task snapshot when a vector build is running", () => {
  const semanticBuildRust = fs.readFileSync(path.join(repoRoot, "src", "semantic", "build.rs"), "utf8");
  assert.match(semanticUi, /function activeSemanticVectorTask\(snapshots\)/);
  assert.match(semanticUi, /semanticPort\.backgroundTasks\(\)/);
  assert.match(semanticUi, /function restoreLiveSemanticVectorTask\(center, snapshots, cachedSemanticTotal\)/);
  assert.match(semanticUi, /can_start: false/);
  assert.match(
    semanticUi,
    /on\(\s*vectorBuildButton,\s*"click",\s*\(\) =>[\s\S]*?semanticCache\.update\(\{[\s\S]*?building: true/,
  );
  assert.match(semanticUi, /vectorBuildButton\.disabled = vectorStatusChecking \|\| busy \|\|/);
  assert.match(semanticUi, /completedBooksFromCheckpoint/);
  assert.match(semanticBuildRust, /title: &'a str/);
  assert.ok(semanticBuildRust.includes("format!(\"{title} · 正在编码第 {offset}/{} 段\""));
});
test("semantic status stays usable while exact metadata verification runs", () => {
  assert.doesNotMatch(semanticUi, /disabled = busy \|\| refreshing/);
  assert.doesNotMatch(semanticUi, /正在后台读取索引状态/);
  assert.match(semanticUi, /const cachedNext = semanticCache\.use\(next\)/);
  assert.doesNotMatch(semanticUi, /select_semantic_model[\s\S]{0,180}cache\.clear\(\)/);
  assert.match(semanticCache, /semanticIndexStatusByModelV3/);
  assert.doesNotMatch(semanticCache, /semanticIndexStatusByModelV2/);
  assert.match(semanticCache, /statuses\[next\.model_id\] = next/);
  assert.match(semanticCache, /function use\(modelId\)/);
  assert.match(semanticUi, /if \(!refreshing\) \{\s*semanticCache\.save\(progress\)/);
});

test("semantic management does not present ambiguous disk usage as an exact size", () => {
  assert.doesNotMatch(semanticUi, /缓存大小/);
  assert.doesNotMatch(semanticUi, /，占用 /);
});

test("advanced index cards explain their user-facing effects", () => {
  assert.match(semanticUi, /semAcceleratorDescription/);
  assert.match(semanticUi, /semMultiProfileDescription/);
  assert.match(semanticUi, /const acceleratorDescription/);
  assert.match(semanticUi, /const multiProfileDescription/);
  assert.match(html, /data-i18n="semRefreshGpu"/);
});

test("semantic settings are catalog-based and refresh when the app language changes", () => {
  for (const key of ["semTitle", "semDescription", "semSelectModel", "semGpu", "semRetrievalStrategy", "semReranker", "semM3Index", "semAccelerator", "semMultiProfile"]) {
    assert.match(html, new RegExp(`data-i18n(?:-aria)?="${key}"`));
  }
  assert.match(i18n, /ja: \{\s*semTitle: "セマンティック索引"/);
  assert.match(i18n, /ko: \{\s*semTitle: "의미 색인"/);
  assert.match(semanticUi, /app-language-changed/);
  assert.match(semanticUi, /global\.ReaderAppI18n\?\.apply\?\.\(modal\)/);
  assert.doesNotMatch(semanticUi, /task\?\.detail/);
});
