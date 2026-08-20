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
} as const);

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
        ["queued", "running", "pausing"].includes(item.state),
    )
    .sort(
      (left: BackgroundTaskSnapshot, right: BackgroundTaskSnapshot) =>
        right.created_at_ms - left.created_at_ms,
    )[0] ?? null;
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
