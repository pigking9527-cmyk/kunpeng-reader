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
      "buildVectors", "capabilityRoutes", "configureReaderMediaComfyUi", "deleteIndex", "deleteM3Index", "deleteModel", "deleteReranker",
      "downloadModel", "downloadReranker", "gpuStatus", "installGpuRuntime",
      "installReaderMediaModel",
      "intelligenceCapabilities", "intelligencePreflight", "intelligenceStatus", "listenGpuRuntimeProgress", "localUnderstandingPreflight",
      "hostPreflight", "beginHostPairing", "confirmHostPairing", "hostPairings", "revokeHostPairing",
      "pauseVectors", "readerMediaStatus", "saveCapabilityRoute", "saveIntelligenceModel", "scoreNewsPreferences",
      "selectDevicePolicy", "selectModel", "selectRetrievalMode", "selectSolution",
      "startReaderMediaRuntime", "stopReaderMediaRuntime", "tasks",
    ].sort(),
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
  await port.intelligencePreflight();
  await port.hostPreflight();
  await port.beginHostPairing();
  await port.confirmHostPairing("KIR1C.public-confirmation-only");
  await port.hostPairings();
  await port.revokeHostPairing("pair-demo-1");
  await port.localUnderstandingPreflight();
  await port.capabilityRoutes();
  await port.saveCapabilityRoute({ capability: "companion", mode: "auto" });
  await port.scoreNewsPreferences({
    favorites: [{ id: "favorite-1", title: "偏好主题", summary: "本地收藏", category: "国际" }],
    events: [{ id: "event-1", title: "资讯标题", summary: "正式缓存正文", sourceNames: ["来源"] }],
  });
  await port.selectModel("bge-m3");
  await port.selectSolution("qwen3-embedding-0.6b", "high_precision");
  await port.selectDevicePolicy("cpu");
  await port.deleteIndex("multi_profile");
  await port.selectRetrievalMode("high_precision");
  await port.buildVectors();
  await port.configureReaderMediaComfyUi({
    comfyUiRoot: "C:\\ComfyUI",
    workflowPath: "C:\\ComfyUI\\workflow-api.json",
  });
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
    { command: "intelligence_local_model_preflight" },
    { command: "intelligence_host_preflight" },
    { command: "intelligence_host_pairing_begin" },
    {
      command: "intelligence_host_pairing_confirm",
      args: { request: { confirmationCode: "KIR1C.public-confirmation-only" } },
    },
    { command: "intelligence_host_pairings" },
    { command: "intelligence_host_pairing_revoke", args: { pairId: "pair-demo-1" } },
    { command: "local_understanding_model_preflight" },
    { command: "ai_capability_routes_status" },
    {
      command: "save_ai_capability_route",
      args: { request: { capability: "companion", mode: "auto" } },
    },
    {
      command: "score_news_preferences",
      args: {
        request: {
          favorites: [{ id: "favorite-1", title: "偏好主题", summary: "本地收藏", category: "国际" }],
          events: [{ id: "event-1", title: "资讯标题", summary: "正式缓存正文", sourceNames: ["来源"] }],
        },
      },
    },
    { command: "select_semantic_model", args: { modelId: "bge-m3" } },
    {
      command: "select_semantic_solution",
      args: { modelId: "qwen3-embedding-0.6b", retrievalMode: "high_precision" },
    },
    { command: "select_semantic_device_policy", args: { policy: "cpu" } },
    { command: "delete_semantic_index", args: { kind: "multi_profile" } },
    {
      command: "select_semantic_retrieval_mode",
      args: { mode: "high_precision" },
    },
    { command: "build_semantic_vectors" },
    {
      command: "configure_reader_media_comfyui",
      args: {
        config: {
          comfyUiRoot: "C:\\ComfyUI",
          workflowPath: "C:\\ComfyUI\\workflow-api.json",
        },
      },
    },
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
