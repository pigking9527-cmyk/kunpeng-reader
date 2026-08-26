import type {
  BackgroundTaskSnapshot,
  SemanticProgress,
  SemanticTaskCenter,
  SemanticTaskItem,
} from "./semantic-port.js";

export const SEMANTIC_MODEL_DIMENSIONS = Object.freeze({
  "bge-small-zh-v1.5": 512,
  "bge-large-zh-v1.5": 1024,
  "bge-m3": 1024,
  "multilingual-e5-small": 384,
  "qwen3-embedding-0.6b": 1024,
  "qwen3-embedding-8b": 4096,
} as const);

export const SEMANTIC_SEARCH_SOLUTIONS = Object.freeze([
  Object.freeze({
    id: "standard",
    modelId: "qwen3-embedding-0.6b",
    retrievalMode: "high_precision",
    buttonId: "sem-solution-standard",
    capabilityTitle: "智能搜索（自动）",
    capabilityCopy: "用于关键词、相似内容和相关推荐；阅读器会自动使用适合本机的检索方式。",
  }),
  Object.freeze({
    id: "high_precision",
    modelId: "qwen3-embedding-8b",
    retrievalMode: "high_precision",
    buttonId: "sem-solution-high",
    capabilityTitle: "高精度查找",
    capabilityCopy: "适合需要更细检索依据的书库问答、智读、智能标签和书单。",
  }),
  Object.freeze({
    id: "bge_m3",
    modelId: "bge-m3",
    retrievalMode: "m3_hybrid",
    buttonId: "sem-solution-m3",
    capabilityTitle: "中英混合查找",
    capabilityCopy: "适合中英文混合、专有名词和关键词较多的内容；仅调整本地查找方式。",
  }),
] as const);

export function progressPercent(done: number, total: number): number {
  return total > 0
    ? Math.max(0, Math.min(100, Math.round((done * 100) / total)))
    : 0;
}

export function formatSemanticBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(value / (1024 * 1024)))} MB`;
}

export function legacySemanticIndexCompleted(
  task: SemanticTaskItem | null,
  total: number,
  bytes: number,
): boolean {
  return !task?.running && !total && Number(bytes || 0) > 0;
}

export function activeSemanticVectorTask(
  snapshots: readonly BackgroundTaskSnapshot[],
): BackgroundTaskSnapshot | null {
  return [...snapshots]
    .filter(
      (item) =>
        item.kind === "semantic_vectors" &&
        // 新搜索方案也复用向量任务执行器，但它的 checkpoint 明确标记了
        // pending_model。不能把它还原成“普通向量建库”，否则前端会错误
        // 尝试暂停它，且用户看不到“旧库仍在服务、新库正在建立”的状态。
        !isPendingSolutionTask(item) &&
        ["queued", "running", "pausing"].includes(item.state),
    )
    .sort(
      (left: BackgroundTaskSnapshot, right: BackgroundTaskSnapshot) =>
        right.created_at_ms - left.created_at_ms,
    )[0] ?? null;
}

function isPendingSolutionTask(task: BackgroundTaskSnapshot): boolean {
  try {
    const checkpoint: unknown = JSON.parse(task.checkpoint || "");
    return typeof checkpoint === "object" && checkpoint !== null &&
      "pending_model" in checkpoint;
  } catch {
    return false;
  }
}

export function completedBooksFromCheckpoint(
  task: BackgroundTaskSnapshot,
): number | null {
  try {
    const parsed: unknown = JSON.parse(task.checkpoint || "");
    if (typeof parsed !== "object" || parsed === null || !("completed" in parsed)) return null;
    const completed = Number((parsed as { readonly completed?: unknown }).completed);
    return Number.isFinite(completed) ? Math.max(0, completed) : null;
  } catch {
    return null;
  }
}

export function restoreLiveSemanticVectorTask(
  center: SemanticTaskCenter,
  snapshots: readonly BackgroundTaskSnapshot[],
  cachedSemanticTotal: number,
): SemanticTaskCenter {
  const taskSnapshot = activeSemanticVectorTask(snapshots);
  if (!taskSnapshot) return center;
  const progress = center.progress;
  const total = Math.max(
    0,
    progress.total,
    progress.semantic_total,
    cachedSemanticTotal,
  );
  const checkpointDone = completedBooksFromCheckpoint(taskSnapshot);
  const done = Math.min(
    total || Number.MAX_SAFE_INTEGER,
    checkpointDone ?? Math.max(0, Number(taskSnapshot.progress.done || 0)),
  );
  const restoredProgress: SemanticProgress = {
    ...progress,
    building: true,
    active_task: "semantic_vectors",
    vector_pause_requested:
      taskSnapshot.state === "pausing" || taskSnapshot.pause_requested,
    vector_paused: false,
    done,
    total,
    semantic_done: done,
    semantic_total: total,
    semantic_ready: false,
    current: taskSnapshot.current || progress.current || "正在建立语义索引…",
    error: taskSnapshot.error || "",
  };
  return {
    ...center,
    progress: restoredProgress,
    current: restoredProgress.current,
    error: restoredProgress.error,
    tasks: center.tasks.map((item) =>
      item.id !== "semantic_vectors"
        ? item
        : {
            ...item,
            status: "running",
            done,
            total,
            running: true,
            ready: false,
            resumable: false,
            can_start: false,
            can_delete: false,
          },
    ),
  };
}
