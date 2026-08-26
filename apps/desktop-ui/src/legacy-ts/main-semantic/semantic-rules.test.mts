import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  BackgroundTaskSnapshot,
  SemanticProgress,
  SemanticTaskCenter,
} from "./semantic-port.ts";
import {
  activeSemanticVectorTask,
  completedBooksFromCheckpoint,
  formatSemanticBytes,
  legacySemanticIndexCompleted,
  progressPercent,
  restoreLiveSemanticVectorTask,
  SEMANTIC_MODEL_DIMENSIONS,
  SEMANTIC_SEARCH_SOLUTIONS,
} from "./semantic-rules.ts";

test("semantic rules stay pure and preserve the frozen model dimensions", () => {
  const source = readFileSync(new URL("./semantic-rules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /document|window|localStorage|__TAURI__|React|\.tsx|\bany\b/u);
});

test("smart search plans map to real backend model ids and dimensions", () => {
  assert.equal(SEMANTIC_MODEL_DIMENSIONS["qwen3-embedding-0.6b"], 1024);
  assert.equal(SEMANTIC_MODEL_DIMENSIONS["qwen3-embedding-8b"], 4096);
  assert.deepEqual(
    SEMANTIC_SEARCH_SOLUTIONS.map(({ id, modelId, retrievalMode }) => [
      id,
      modelId,
      retrievalMode,
    ]),
    [
      ["standard", "qwen3-embedding-0.6b", "high_precision"],
      ["high_precision", "qwen3-embedding-8b", "high_precision"],
      ["bge_m3", "bge-m3", "m3_hybrid"],
    ],
  );
  assert.equal(Object.isFrozen(SEMANTIC_SEARCH_SOLUTIONS), true);
  assert.deepEqual(
    SEMANTIC_SEARCH_SOLUTIONS.map(({ capabilityTitle }) => capabilityTitle),
    [
      "智能搜索（自动）",
      "高精度查找",
      "中英混合查找",
    ],
  );
  assert.doesNotMatch(
    SEMANTIC_SEARCH_SOLUTIONS.map(({ capabilityCopy }) => capabilityCopy).join("\n"),
    /向量模型|27B|情报主机/u,
  );
});

function progress(overrides: Partial<SemanticProgress> = {}): SemanticProgress {
  return {
    building: false, model_downloading: false, reranker_loading: false,
    vector_pause_requested: false, vector_paused: false, status_refreshing: false,
    active_task: "", done: 0, total: 6, shard_done: 0, shard_total: 0,
    model_ready: true, model_id: "bge-small-zh-v1.5", model_label: "small",
    model_supported: true, model_bytes: 1, semantic_done: 1, semantic_total: 6,
    semantic_ready: false, semantic_bytes: 1, accelerator_done: 0,
    accelerator_total: 0, accelerator_ready: false, accelerator_resumable: false,
    accelerator_bytes: 0, multi_profile_done: 0, multi_profile_total: 0,
    multi_profile_ready: false, multi_profile_bytes: 0, retrieval_mode: "standard",
    retrieval_mode_label: "standard", reranker_ready: false,
    reranker_downloaded: false, reranker_partial: false,
    m3_long_context_enabled: false, m3_index_done: 0, m3_index_total: 0,
    m3_index_ready: false, current: "", error: "", ...overrides,
  };
}

function snapshot(overrides: Partial<BackgroundTaskSnapshot> = {}): BackgroundTaskSnapshot {
  return {
    id: "task", kind: "semantic_vectors", state: "running", label: "vectors",
    current: "索引中", progress: { done: 2, total: 6, unit: "books" },
    checkpoint: '{"completed":4}', error: null, cancel_requested: false,
    pause_requested: false, created_at_ms: 2, started_at_ms: 1,
    updated_at_ms: 2, finished_at_ms: null, logs: [], ...overrides,
  };
}

test("semantic display rules retain classic clamping and byte formatting", () => {
  assert.equal(progressPercent(7, 10), 70);
  assert.equal(progressPercent(-2, 10), 0);
  assert.equal(progressPercent(15, 10), 100);
  assert.equal(progressPercent(1, 0), 0);
  assert.equal(formatSemanticBytes(0), "1 MB");
  assert.equal(formatSemanticBytes(1.3 * 1024 ** 3), "1.3 GB");
  assert.equal(legacySemanticIndexCompleted(null, 0, 3), true);
  assert.equal(legacySemanticIndexCompleted(null, 2, 3), false);
});

test("active vector rule picks the newest live semantic task", () => {
  const older = snapshot({ created_at_ms: 10, state: "queued" });
  const newer = snapshot({ created_at_ms: 20, state: "pausing" });
  const finished = snapshot({ created_at_ms: 30, state: "completed" });
  assert.equal(activeSemanticVectorTask([older, newer, finished]), newer);
  assert.equal(completedBooksFromCheckpoint(newer), 4);
  assert.equal(
    completedBooksFromCheckpoint(snapshot({ checkpoint: "invalid" })),
    null,
  );
});

test("live task restoration freezes duplicate start and keeps checkpoint progress", () => {
  const center: SemanticTaskCenter = {
    busy: false, status_refreshing: false, current: "", error: "",
    progress: progress(),
    tasks: [{
      id: "semantic_vectors", title: "", detail: "", status: "idle", done: 1,
      total: 6, bytes: 0, running: false, ready: false, resumable: true,
      can_start: true, can_delete: true, primary_label: "", delete_label: "",
    }],
  };
  const restored = restoreLiveSemanticVectorTask(center, [snapshot()], 8);
  assert.equal(restored.progress.building, true);
  assert.equal(restored.progress.semantic_done, 4);
  assert.equal(restored.progress.semantic_total, 8);
  assert.equal(restored.tasks[0]?.can_start, false);
  assert.equal(restored.tasks[0]?.can_delete, false);
});

test("pending search-solution task is not misreported as an ordinary vector build", () => {
  const center: SemanticTaskCenter = {
    busy: true,
    status_refreshing: false,
    current: "正在建立 Qwen3 Embedding 0.6B 新搜索库",
    error: "",
    progress: {
      ...progress(),
      building: true,
      active_task: "semantic_solution",
      solution_switching: true,
      pending_model_id: "qwen3-embedding-0.6b",
      pending_model_label: "Qwen3 Embedding 0.6B",
      pending_retrieval_mode: "high_precision",
    },
    tasks: [{
      id: "semantic_vectors", title: "", detail: "", status: "running", done: 2,
      total: 8, bytes: 0, running: true, ready: false, resumable: false,
      can_start: false, can_delete: false, primary_label: "", delete_label: "",
    }],
  };
  const pending = snapshot({
    checkpoint: '{"pending_model":"qwen3-embedding-0.6b","book_index":2}',
    progress: { done: 2, total: 8, unit: "books" },
  });
  const restored = restoreLiveSemanticVectorTask(center, [pending], 8);
  assert.equal(restored.progress.active_task, "semantic_solution");
  assert.equal(restored.progress.solution_switching, true);
  assert.equal(restored.progress.current, center.progress.current);
});
