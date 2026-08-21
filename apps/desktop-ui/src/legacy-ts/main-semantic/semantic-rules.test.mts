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
} from "./semantic-rules.ts";

test("semantic rules stay pure and preserve the frozen model dimensions", () => {
  const source = readFileSync(new URL("./semantic-rules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /document|window|localStorage|__TAURI__|React|\.tsx|\bany\b/u);
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
