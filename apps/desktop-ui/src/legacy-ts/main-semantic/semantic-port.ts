import {
  createTauriApi,
  type TauriCommandMap,
  type TauriEvent,
  type TauriTransport,
  type TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.js";

export type SemanticRetrievalMode = "standard" | "high_precision" | "m3_hybrid";
export type SemanticIndexKind = "semantic" | "accelerator" | "multi_profile";

export interface SemanticTaskItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly done: number;
  readonly total: number;
  readonly bytes: number;
  readonly running: boolean;
  readonly ready: boolean;
  readonly resumable: boolean;
  readonly can_start: boolean;
  readonly can_delete: boolean;
  readonly primary_label: string;
  readonly delete_label: string;
}

export interface SemanticProgress {
  readonly building: boolean;
  readonly model_downloading: boolean;
  readonly reranker_loading: boolean;
  readonly vector_pause_requested: boolean;
  readonly vector_paused: boolean;
  readonly status_refreshing: boolean;
  readonly active_task: string;
  readonly done: number;
  readonly total: number;
  readonly shard_done: number;
  readonly shard_total: number;
  readonly model_ready: boolean;
  readonly model_id: string;
  readonly model_label: string;
  readonly model_supported: boolean;
  readonly model_bytes: number;
  readonly semantic_done: number;
  readonly semantic_total: number;
  readonly semantic_ready: boolean;
  readonly semantic_bytes: number;
  readonly accelerator_done: number;
  readonly accelerator_total: number;
  readonly accelerator_ready: boolean;
  readonly accelerator_resumable: boolean;
  readonly accelerator_bytes: number;
  readonly multi_profile_done: number;
  readonly multi_profile_total: number;
  readonly multi_profile_ready: boolean;
  readonly multi_profile_bytes: number;
  readonly retrieval_mode: SemanticRetrievalMode;
  readonly retrieval_mode_label: string;
  readonly reranker_ready: boolean;
  readonly reranker_downloaded: boolean;
  readonly reranker_partial: boolean;
  readonly m3_long_context_enabled: boolean;
  readonly m3_index_done: number;
  readonly m3_index_total: number;
  readonly m3_index_ready: boolean;
  readonly current: string;
  readonly error: string;
}

export interface SemanticTaskCenter {
  readonly busy: boolean;
  readonly status_refreshing: boolean;
  readonly current: string;
  readonly error: string;
  readonly tasks: readonly SemanticTaskItem[];
  readonly progress: SemanticProgress;
}

export interface BackgroundTaskProgress {
  readonly done: number;
  readonly total: number;
  readonly unit: string;
}

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly label: string;
  readonly current: string;
  readonly progress: BackgroundTaskProgress;
  readonly checkpoint: string | null;
  readonly error: string | null;
  readonly cancel_requested: boolean;
  readonly pause_requested: boolean;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly updated_at_ms: number;
  readonly finished_at_ms: number | null;
  readonly logs: readonly unknown[];
}

export interface SemanticGpuStatus {
  readonly detected: boolean;
  readonly supported: boolean;
  readonly component_available: boolean;
  readonly runtime_ready: boolean;
  readonly runtime_install_available: boolean;
  readonly runtime_download_bytes: number;
  readonly runtime_downloaded_bytes: number;
  readonly name: string;
  readonly driver: string;
  readonly message: string;
}

export interface SemanticGpuRuntimeProgress {
  readonly total_bytes: number;
  readonly downloaded_bytes: number;
}

type SemanticCommands = {
  semantic_tasks: {
    readonly args: { readonly reconcile: boolean };
    readonly result: SemanticTaskCenter;
  };
  background_task_status: { readonly result: readonly BackgroundTaskSnapshot[] };
  semantic_gpu_status: { readonly result: SemanticGpuStatus };
  install_semantic_gpu_runtime: { readonly result: null };
  download_semantic_model: { readonly result: null };
  delete_semantic_model: { readonly result: null };
  select_semantic_model: {
    readonly args: { readonly modelId: string };
    readonly result: null;
  };
  build_semantic_vectors: { readonly result: null };
  pause_semantic_vectors: { readonly result: null };
  build_semantic_accelerator: { readonly result: null };
  build_semantic_multi_profile: { readonly result: null };
  delete_semantic_index: {
    readonly args: { readonly kind: SemanticIndexKind };
    readonly result: null;
  };
  select_semantic_retrieval_mode: {
    readonly args: { readonly mode: SemanticRetrievalMode };
    readonly result: null;
  };
  download_semantic_reranker: { readonly result: null };
  delete_semantic_reranker: { readonly result: null };
  build_semantic_m3_index: { readonly result: null };
  delete_semantic_m3_index: { readonly result: null };
};

type VerifiedSemanticCommands = SemanticCommands extends TauriCommandMap
  ? SemanticCommands
  : never;

export interface SemanticPort {
  tasks(reconcile: boolean): Promise<SemanticTaskCenter>;
  backgroundTasks(): Promise<readonly BackgroundTaskSnapshot[]>;
  gpuStatus(): Promise<SemanticGpuStatus>;
  installGpuRuntime(): Promise<null>;
  downloadModel(): Promise<null>;
  deleteModel(): Promise<null>;
  selectModel(modelId: string): Promise<null>;
  buildVectors(): Promise<null>;
  pauseVectors(): Promise<null>;
  buildAccelerator(): Promise<null>;
  buildMultiProfile(): Promise<null>;
  deleteIndex(kind: SemanticIndexKind): Promise<null>;
  selectRetrievalMode(mode: SemanticRetrievalMode): Promise<null>;
  downloadReranker(): Promise<null>;
  deleteReranker(): Promise<null>;
  buildM3Index(): Promise<null>;
  deleteM3Index(): Promise<null>;
  listenGpuRuntimeProgress(
    handler: (event: TauriEvent<SemanticGpuRuntimeProgress>) => void,
  ): Promise<TauriUnlisten>;
}

export function createSemanticPort(transport: TauriTransport): SemanticPort {
  const api = createTauriApi<VerifiedSemanticCommands>(transport);
  const events = api.events<{ readonly "semantic-gpu-runtime-progress": SemanticGpuRuntimeProgress }>();
  return Object.freeze({
    tasks: (reconcile: boolean) => api.invoke("semantic_tasks", { reconcile }),
    backgroundTasks: () => api.invoke("background_task_status"),
    gpuStatus: () => api.invoke("semantic_gpu_status"),
    installGpuRuntime: () => api.invoke("install_semantic_gpu_runtime"),
    downloadModel: () => api.invoke("download_semantic_model"),
    deleteModel: () => api.invoke("delete_semantic_model"),
    selectModel: (modelId: string) => api.invoke("select_semantic_model", { modelId }),
    buildVectors: () => api.invoke("build_semantic_vectors"),
    pauseVectors: () => api.invoke("pause_semantic_vectors"),
    buildAccelerator: () => api.invoke("build_semantic_accelerator"),
    buildMultiProfile: () => api.invoke("build_semantic_multi_profile"),
    deleteIndex: (kind: SemanticIndexKind) => api.invoke("delete_semantic_index", { kind }),
    selectRetrievalMode: (mode: SemanticRetrievalMode) =>
      api.invoke("select_semantic_retrieval_mode", { mode }),
    downloadReranker: () => api.invoke("download_semantic_reranker"),
    deleteReranker: () => api.invoke("delete_semantic_reranker"),
    buildM3Index: () => api.invoke("build_semantic_m3_index"),
    deleteM3Index: () => api.invoke("delete_semantic_m3_index"),
    listenGpuRuntimeProgress: (
      handler: (event: TauriEvent<SemanticGpuRuntimeProgress>) => void,
    ) => events.listen("semantic-gpu-runtime-progress", handler),
  });
}
