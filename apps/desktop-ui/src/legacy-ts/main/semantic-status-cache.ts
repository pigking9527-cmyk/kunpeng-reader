import type { StorageLike } from "./animation-settings.ts";

export const SEMANTIC_STATUS_STORAGE_KEY = "semanticIndexStatusByModelV3";
export const SEMANTIC_ACTIVE_MODEL_KEY = "semanticIndexStatusActiveModelV3";
export const DEFAULT_SEMANTIC_MODEL_ID = "bge-small-zh-v1.5";

export interface SemanticStatus {
  building: boolean;
  model_downloading: boolean;
  reranker_loading: boolean;
  vector_pause_requested: boolean;
  vector_paused: boolean;
  active_task: string;
  done: number;
  total: number;
  shard_done: number;
  shard_total: number;
  current: string;
  error: string;
  model_ready: boolean;
  model_id: string;
  model_label: string;
  model_supported: boolean;
  model_bytes: number;
  reranker_downloaded: boolean;
  reranker_partial: boolean;
  semantic_done: number;
  semantic_total: number;
  semantic_ready: boolean;
  semantic_bytes: number;
  accelerator_done: number;
  accelerator_total: number;
  accelerator_ready: boolean;
  accelerator_resumable: boolean;
  accelerator_bytes: number;
  multi_profile_done: number;
  multi_profile_total: number;
  multi_profile_ready: boolean;
  multi_profile_bytes: number;
  saved_at: number;
  status_refreshing?: boolean;
  [key: string]: unknown;
}

export type SemanticStatusInput = {
  [Key in keyof SemanticStatus]?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function semanticStatusSnapshot(
  input: SemanticStatusInput = {},
  activeModelId = DEFAULT_SEMANTIC_MODEL_ID,
  now = Date.now(),
): SemanticStatus {
  return {
    building: Boolean(input.building),
    model_downloading: Boolean(input.model_downloading),
    reranker_loading: Boolean(input.reranker_loading),
    vector_pause_requested: Boolean(input.vector_pause_requested),
    vector_paused: Boolean(input.vector_paused),
    active_task: text(input.active_task),
    done: Number(input.done) || 0,
    total: Number(input.total) || 0,
    shard_done: Number(input.shard_done) || 0,
    shard_total: Number(input.shard_total) || 0,
    current: text(input.current),
    error: text(input.error),
    model_ready: Boolean(input.model_ready),
    model_id: text(input.model_id, activeModelId || DEFAULT_SEMANTIC_MODEL_ID),
    model_label: text(input.model_label, "BGE Small 中文（默认）"),
    model_supported: input.model_supported !== false,
    model_bytes: Number(input.model_bytes) || 0,
    reranker_downloaded: Boolean(input.reranker_downloaded),
    reranker_partial: Boolean(input.reranker_partial),
    semantic_done: Number(input.semantic_done) || 0,
    semantic_total: Number(input.semantic_total) || 0,
    semantic_ready: Boolean(input.semantic_ready),
    semantic_bytes: Number(input.semantic_bytes) || 0,
    accelerator_done: Number(input.accelerator_done) || 0,
    accelerator_total: Number(input.accelerator_total) || 0,
    accelerator_ready: Boolean(input.accelerator_ready),
    accelerator_resumable: Boolean(input.accelerator_resumable),
    accelerator_bytes: Number(input.accelerator_bytes) || 0,
    multi_profile_done: Number(input.multi_profile_done) || 0,
    multi_profile_total: Number(input.multi_profile_total) || 0,
    multi_profile_ready: Boolean(input.multi_profile_ready),
    multi_profile_bytes: Number(input.multi_profile_bytes) || 0,
    saved_at: now,
  };
}

export function createSemanticStatusCache(storage: StorageLike, now = Date.now) {
  let activeModelId =
    storage.getItem(SEMANTIC_ACTIVE_MODEL_KEY) || DEFAULT_SEMANTIC_MODEL_ID;
  const statuses: Record<string, SemanticStatus> = load();

  function load(): Record<string, SemanticStatus> {
    try {
      const parsed = record(JSON.parse(storage.getItem(SEMANTIC_STATUS_STORAGE_KEY) || "null") as unknown);
      if (!parsed) return {};
      // The classic cache trusts its own persisted object verbatim. Unknown
      // fields may be consumed by a newer caller, so loading must not normalize
      // or strip them before a later explicit save/update.
      return parsed as Record<string, SemanticStatus>;
    } catch {
      return {};
    }
  }

  function persist(): void {
    try {
      storage.setItem(SEMANTIC_STATUS_STORAGE_KEY, JSON.stringify(statuses));
      storage.setItem(SEMANTIC_ACTIVE_MODEL_KEY, activeModelId);
    } catch {
      // Cache persistence is opportunistic in the legacy runtime.
    }
  }

  function get(modelId = activeModelId): SemanticStatus | null {
    return statuses[modelId] ?? null;
  }

  function use(modelId?: string): SemanticStatus | null {
    if (modelId) activeModelId = modelId;
    persist();
    return get();
  }

  function save(input: SemanticStatusInput = {}): void {
    const next = semanticStatusSnapshot(input, activeModelId, now());
    if (
      !next.model_ready &&
      !next.semantic_total &&
      !next.accelerator_total &&
      !next.multi_profile_total
    ) {
      return;
    }
    activeModelId = next.model_id;
    statuses[next.model_id] = next;
    persist();
  }

  function clear(modelId = activeModelId): void {
    delete statuses[modelId];
    persist();
  }

  function update(patch: SemanticStatusInput = {}): void {
    const modelId = text(patch.model_id, activeModelId);
    const base =
      get(modelId) ?? semanticStatusSnapshot({ model_id: modelId }, modelId, now());
    // Update is intentionally a shallow patch. Unlike snapshot/save it must
    // preserve unknown fields and the caller's raw values for classic API
    // compatibility.
    statuses[modelId] = {
      ...base,
      ...patch,
      model_id: modelId,
      saved_at: now(),
    } as SemanticStatus;
    activeModelId = modelId;
    persist();
  }

  function merge(input: SemanticStatusInput = {}): SemanticStatusInput {
    const modelId = text(input.model_id, activeModelId);
    const lastStatus = get(modelId);
    if (!input.status_refreshing || !lastStatus) return input;
    const fallback = <Key extends keyof SemanticStatus>(key: Key): SemanticStatus[Key] =>
      input[key] == null
        ? lastStatus[key]
        : (input[key] as SemanticStatus[Key]);
    return {
      ...lastStatus,
      ...input,
      model_ready: fallback("model_ready"),
      model_id: fallback("model_id") || DEFAULT_SEMANTIC_MODEL_ID,
      model_label: fallback("model_label") || "BGE Small 中文（默认）",
      model_supported: fallback("model_supported") !== false,
      model_bytes: fallback("model_bytes") || 0,
      reranker_downloaded: fallback("reranker_downloaded"),
      reranker_partial: fallback("reranker_partial"),
      semantic_done: fallback("semantic_done") || 0,
      semantic_total: fallback("semantic_total") || 0,
      semantic_ready: fallback("semantic_ready"),
      semantic_bytes: fallback("semantic_bytes") || 0,
      accelerator_done: fallback("accelerator_done") || 0,
      accelerator_total: fallback("accelerator_total") || 0,
      accelerator_ready: fallback("accelerator_ready"),
      accelerator_resumable: fallback("accelerator_resumable"),
      accelerator_bytes: fallback("accelerator_bytes") || 0,
      multi_profile_done: fallback("multi_profile_done") || 0,
      multi_profile_total: fallback("multi_profile_total") || 0,
      multi_profile_ready: fallback("multi_profile_ready"),
      multi_profile_bytes: fallback("multi_profile_bytes") || 0,
    };
  }

  return Object.freeze({
    clear,
    get,
    merge,
    save,
    snapshot: (input: SemanticStatusInput = {}) =>
      semanticStatusSnapshot(input, activeModelId, now()),
    update,
    use,
  });
}

export type SemanticStatusCacheApi = ReturnType<typeof createSemanticStatusCache>;

export function installSemanticStatusCache(
  target: { readonly localStorage: StorageLike } & Record<string, unknown>,
): SemanticStatusCacheApi {
  const api = createSemanticStatusCache(target.localStorage);
  target.ReaderSemanticStatusCache = api;
  return api;
}
