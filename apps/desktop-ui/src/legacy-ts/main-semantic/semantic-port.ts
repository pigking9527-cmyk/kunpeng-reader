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
  readonly solution_switching?: boolean;
  readonly pending_model_id?: string;
  readonly pending_model_label?: string;
  readonly pending_retrieval_mode?: SemanticRetrievalMode | "";
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
  readonly active_model_device?: string;
  readonly active_model_device_label?: string;
  readonly device_policy?: "auto" | "gpu" | "cpu";
  readonly actual_device?: string;
  readonly total_vram_mib?: number | null;
  readonly free_vram_mib?: number | null;
}

export interface IntelligenceLocalModelCapability {
  readonly id: string;
  readonly label: string;
  readonly artifact: string;
  readonly requiredTotalVramMib: number;
  readonly selectable: boolean;
  readonly reason: string;
}

export interface IntelligenceLocalModelCapabilities {
  readonly gpu: {
    readonly detected: boolean;
    readonly name: string;
    readonly totalVramMib: number | null;
    readonly freeVramMib: number | null;
    readonly message: string;
  };
  readonly models: readonly IntelligenceLocalModelCapability[];
}

export interface IntelligenceLocalModelStatus {
  readonly configured: boolean;
  readonly baseUrl: string;
  readonly model: string;
}

export interface IntelligenceLocalModelPreflight {
  readonly configured: boolean;
  readonly hardwareReady: boolean;
  readonly serviceReady: boolean;
  readonly message: string;
}

/** Actual service readiness for the normal local 7B/8B reader model. */
export interface LocalUnderstandingModelPreflight {
  readonly configured: boolean;
  readonly local: boolean;
  readonly serviceReady: boolean;
  readonly model: string;
  readonly message: string;
}

/** Local-only routing preference for one user-facing Smart Management ability. */
export interface AiCapabilityRoute {
  readonly capability: "search" | "understanding" | "news_preference" | "deep_analysis" | "companion";
  readonly mode: "auto" | "local" | "intelligence_host" | "cloud" | "off";
  readonly profileId?: string;
  readonly hostId?: string;
  readonly updatedAt?: number;
  readonly allowAuto: boolean;
  readonly allowLocal: boolean;
  readonly allowIntelligenceHost: boolean;
  readonly allowCloud: boolean;
  readonly allowOff: boolean;
  readonly unavailableReason?: string;
}

export interface AiCapabilityRoutesStatus {
  readonly routes: readonly AiCapabilityRoute[];
}

export interface IntelligenceHostPreflight {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly compatible: boolean;
  readonly hostId?: string;
  readonly capabilityRevision?: number;
  readonly message: string;
}

/** Public-only pairing projection. The one-time invite is never persisted by
 * this port; callers should display/copy it once and then discard it. */
export interface IntelligenceHostPairingInvite {
  readonly offerId: string;
  readonly expiresAt: string;
  readonly inviteCode: string;
}

export interface IntelligenceHostPairingSummary {
  readonly pairId: string;
  readonly state: string;
  readonly hostInstallationId: string;
  readonly hostKeyFingerprint: string;
  readonly capabilityRevision: number;
  readonly capabilities: readonly string[];
  readonly local: boolean;
}

export interface IntelligenceHostPairingsStatus {
  readonly pendingConfirmation: boolean;
  readonly pairings: readonly IntelligenceHostPairingSummary[];
  readonly message: string;
}

/** Bounded, local-only input used to rank already validated formal news. */
export interface NewsPreferenceScoreRequest {
  readonly favorites: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly category: string;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly sourceNames: readonly string[];
  }[];
}

export interface NewsPreferenceScores {
  readonly model: string;
  readonly scores: readonly {
    readonly id: string;
    readonly score: number;
    readonly reason: string;
  }[];
}

export interface ReaderMediaStatus {
  readonly configured: boolean;
  readonly modelReady: boolean;
  readonly runtimeReady: boolean;
  readonly hardwareSupported: boolean;
  readonly modelId: string;
  readonly runtimeDevice: string;
  readonly totalRamMib: number;
  readonly requiredRamMib: number;
  readonly totalVramMib: number;
  readonly requiredVramMib: number;
  readonly availableDiskMib?: number;
  readonly requiredDiskMib?: number;
  readonly backend?: "comfyui";
  readonly comfyUiReady?: boolean;
  readonly workflowReady?: boolean;
  readonly modelArtifactsReady?: boolean;
  readonly installationState?: "not_installed" | "queued" | "running" | "ready" | "failed";
  readonly installationStep?: string;
  readonly installationRoot?: string;
  readonly selectedPreset?: string;
  readonly message: string;
}

export interface ReaderMediaComfyUiConfig {
  readonly comfyUiRoot: string;
  readonly workflowPath: string;
  readonly pythonPath?: string;
  readonly endpoint?: string;
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
  select_semantic_solution: {
    readonly args: {
      readonly modelId: string;
      readonly retrievalMode: SemanticRetrievalMode;
    };
    readonly result: null;
  };
  select_semantic_device_policy: {
    readonly args: { readonly policy: "auto" | "gpu" | "cpu" };
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
  intelligence_local_model_capabilities: {
    readonly result: IntelligenceLocalModelCapabilities;
  };
  intelligence_local_model_status: {
    readonly result: IntelligenceLocalModelStatus;
  };
  intelligence_local_model_preflight: {
    readonly result: IntelligenceLocalModelPreflight;
  };
  local_understanding_model_preflight: {
    readonly result: LocalUnderstandingModelPreflight;
  };
  intelligence_local_model_save: {
    readonly args: {
      readonly request: {
        readonly baseUrl: string;
        readonly model: string;
        readonly apiKey: string;
      };
    };
    readonly result: IntelligenceLocalModelStatus;
  };
  ai_capability_routes_status: { readonly result: AiCapabilityRoutesStatus };
  save_ai_capability_route: {
    readonly args: {
      readonly request: {
        readonly capability: AiCapabilityRoute["capability"];
        readonly mode: AiCapabilityRoute["mode"];
        readonly profileId?: string;
        readonly hostId?: string;
      };
    };
    readonly result: AiCapabilityRoutesStatus;
  };
  intelligence_host_preflight: { readonly result: IntelligenceHostPreflight };
  intelligence_host_pairing_begin: { readonly result: IntelligenceHostPairingInvite };
  intelligence_host_pairing_confirm: {
    readonly args: { readonly request: { readonly confirmationCode: string } };
    readonly result: IntelligenceHostPairingSummary;
  };
  intelligence_host_pairings: { readonly result: IntelligenceHostPairingsStatus };
  intelligence_host_pairing_revoke: {
    readonly args: { readonly pairId: string };
    readonly result: IntelligenceHostPairingsStatus;
  };
  score_news_preferences: {
    readonly args: { readonly request: NewsPreferenceScoreRequest };
    readonly result: NewsPreferenceScores;
  };
  reader_media_status: { readonly result: ReaderMediaStatus };
  install_reader_media_model: { readonly result: ReaderMediaStatus };
  configure_reader_media_comfyui: {
    readonly args: { readonly config: ReaderMediaComfyUiConfig };
    readonly result: ReaderMediaStatus;
  };
  start_reader_media_runtime: { readonly result: ReaderMediaStatus };
  stop_reader_media_runtime: { readonly result: ReaderMediaStatus };
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
  selectSolution(modelId: string, retrievalMode: SemanticRetrievalMode): Promise<null>;
  selectDevicePolicy(policy: "auto" | "gpu" | "cpu"): Promise<null>;
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
  intelligenceCapabilities(): Promise<IntelligenceLocalModelCapabilities>;
  intelligenceStatus(): Promise<IntelligenceLocalModelStatus>;
  intelligencePreflight(): Promise<IntelligenceLocalModelPreflight>;
  localUnderstandingPreflight(): Promise<LocalUnderstandingModelPreflight>;
  saveIntelligenceModel(request: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
  }): Promise<IntelligenceLocalModelStatus>;
  capabilityRoutes(): Promise<AiCapabilityRoutesStatus>;
  saveCapabilityRoute(request: {
    readonly capability: AiCapabilityRoute["capability"];
    readonly mode: AiCapabilityRoute["mode"];
    readonly profileId?: string;
    readonly hostId?: string;
  }): Promise<AiCapabilityRoutesStatus>;
  hostPreflight(): Promise<IntelligenceHostPreflight>;
  beginHostPairing(): Promise<IntelligenceHostPairingInvite>;
  confirmHostPairing(confirmationCode: string): Promise<IntelligenceHostPairingSummary>;
  hostPairings(): Promise<IntelligenceHostPairingsStatus>;
  revokeHostPairing(pairId: string): Promise<IntelligenceHostPairingsStatus>;
  scoreNewsPreferences(request: NewsPreferenceScoreRequest): Promise<NewsPreferenceScores>;
  readerMediaStatus(): Promise<ReaderMediaStatus>;
  installReaderMediaModel(): Promise<ReaderMediaStatus>;
  configureReaderMediaComfyUi(config: ReaderMediaComfyUiConfig): Promise<ReaderMediaStatus>;
  startReaderMediaRuntime(): Promise<ReaderMediaStatus>;
  stopReaderMediaRuntime(): Promise<ReaderMediaStatus>;
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
    selectSolution: (modelId: string, retrievalMode: SemanticRetrievalMode) =>
      api.invoke("select_semantic_solution", { modelId, retrievalMode }),
    selectDevicePolicy: (policy: "auto" | "gpu" | "cpu") =>
      api.invoke("select_semantic_device_policy", { policy }),
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
    intelligenceCapabilities: () => api.invoke("intelligence_local_model_capabilities"),
    intelligenceStatus: () => api.invoke("intelligence_local_model_status"),
    intelligencePreflight: () => api.invoke("intelligence_local_model_preflight"),
    localUnderstandingPreflight: () => api.invoke("local_understanding_model_preflight"),
    saveIntelligenceModel: (request: {
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey: string;
    }) =>
      api.invoke("intelligence_local_model_save", { request }),
    capabilityRoutes: () => api.invoke("ai_capability_routes_status"),
    saveCapabilityRoute: (request: {
      readonly capability: AiCapabilityRoute["capability"];
      readonly mode: AiCapabilityRoute["mode"];
      readonly profileId?: string;
      readonly hostId?: string;
    }) => api.invoke("save_ai_capability_route", { request }),
    hostPreflight: () => api.invoke("intelligence_host_preflight"),
    beginHostPairing: () => api.invoke("intelligence_host_pairing_begin"),
    confirmHostPairing: (confirmationCode: string) =>
      api.invoke("intelligence_host_pairing_confirm", { request: { confirmationCode } }),
    hostPairings: () => api.invoke("intelligence_host_pairings"),
    revokeHostPairing: (pairId: string) =>
      api.invoke("intelligence_host_pairing_revoke", { pairId }),
    scoreNewsPreferences: (request: NewsPreferenceScoreRequest) =>
      api.invoke("score_news_preferences", { request }),
    readerMediaStatus: () => api.invoke("reader_media_status"),
    installReaderMediaModel: () => api.invoke("install_reader_media_model"),
    configureReaderMediaComfyUi: (config: ReaderMediaComfyUiConfig) =>
      api.invoke("configure_reader_media_comfyui", { config }),
    startReaderMediaRuntime: () => api.invoke("start_reader_media_runtime"),
    stopReaderMediaRuntime: () => api.invoke("stop_reader_media_runtime"),
    listenGpuRuntimeProgress: (
      handler: (event: TauriEvent<SemanticGpuRuntimeProgress>) => void,
    ) => events.listen("semantic-gpu-runtime-progress", handler),
  });
}
