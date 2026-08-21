import assert from "node:assert/strict";
import test from "node:test";

import type {
  TauriEvent,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";
import { createSemanticPort } from "./semantic-port.ts";

test("semantic boundary remains view-free and covers every classic native operation", () => {
  const port = createSemanticPort({ invoke: async <TResult,>() => null as TResult });
  assert.deepEqual(
    Object.keys(port).sort(),
    [
      "backgroundTasks", "buildAccelerator", "buildM3Index", "buildMultiProfile",
      "buildVectors", "deleteIndex", "deleteM3Index", "deleteModel", "deleteReranker",
      "downloadModel", "downloadReranker", "gpuStatus", "installGpuRuntime",
      "listenGpuRuntimeProgress", "pauseVectors", "selectModel", "selectRetrievalMode", "tasks",
    ],
  );
  assert.ok(Object.isFrozen(port));
});

test("semantic port owns the exact command envelopes and progress event", async () => {
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  let listenedEvent = "";
  let listener: ((event: TauriEvent<unknown>) => void) | null = null;
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      if (command === "semantic_tasks") {
        return { progress: {}, tasks: [] } as TResult;
      }
      if (command === "background_task_status") return [] as TResult;
      if (command === "semantic_gpu_status") return { runtime_ready: false } as TResult;
      return null as TResult;
    },
    listen: async <TPayload,>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ) => {
      listenedEvent = event;
      listener = handler as (event: TauriEvent<unknown>) => void;
      return () => undefined;
    },
  };
  const port = createSemanticPort(transport);
  await port.tasks(true);
  await port.backgroundTasks();
  await port.gpuStatus();
  await port.selectModel("bge-m3");
  await port.deleteIndex("multi_profile");
  await port.selectRetrievalMode("high_precision");
  await port.buildVectors();
  let progress = 0;
  await port.listenGpuRuntimeProgress((event) => {
    progress = event.payload.downloaded_bytes;
  });
  const capturedListener = listener as
    | ((event: TauriEvent<unknown>) => void)
    | null;
  if (!capturedListener) throw new Error("semantic progress listener was not captured");
  capturedListener({
    event: listenedEvent,
    id: 1,
    payload: { total_bytes: 10, downloaded_bytes: 4 },
  });

  assert.deepEqual(calls, [
    { command: "semantic_tasks", args: { reconcile: true } },
    { command: "background_task_status" },
    { command: "semantic_gpu_status" },
    { command: "select_semantic_model", args: { modelId: "bge-m3" } },
    { command: "delete_semantic_index", args: { kind: "multi_profile" } },
    {
      command: "select_semantic_retrieval_mode",
      args: { mode: "high_precision" },
    },
    { command: "build_semantic_vectors" },
  ]);
  assert.equal(listenedEvent, "semantic-gpu-runtime-progress");
  assert.equal(progress, 4);
});

test("semantic port refuses event subscription when the transport has no listener", async () => {
  const port = createSemanticPort({ invoke: async <TResult,>() => null as TResult });
  await assert.rejects(
    port.listenGpuRuntimeProgress(() => undefined),
    /event\.listen is unavailable/u,
  );
});
