import type {
  BugFeedbackDraft,
  FeedbackDraft,
  FeedbackKind,
  FeatureFeedbackDraft,
} from "./support-port.js";

/** UI-only async state shared by about, feedback and diagnostics actions. */
export type SupportOperationPhase = "idle" | "loading" | "success" | "failure" | "cancelled";

export interface SupportOperationState {
  readonly phase: SupportOperationPhase;
  readonly label: string;
}

export const supportIdleState: SupportOperationState = { phase: "idle", label: "" };

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

/**
 * A deliberately generic message for port failures. Port error strings can
 * contain filesystem paths or service details, neither of which belongs in a
 * support form's visible state or telemetry.
 */
export function operationFailureState(): SupportOperationState {
  return { phase: "failure", label: "操作未完成，请稍后重试。" };
}

export function operationCancelledState(): SupportOperationState {
  return { phase: "cancelled", label: "操作已取消。" };
}

export const maximumFeedbackImages = 3;
export const maximumFeedbackImageBytes = 1024 * 1024;

type FeedbackFileMetadata = Pick<File, "name" | "size" | "type">;

export interface FeedbackFileSelection {
  /** Safe-to-pass file handles only; this helper never reads file bytes. */
  readonly accepted: readonly FeedbackFileMetadata[];
  readonly rejectedUnsupported: number;
  readonly rejectedOversized: number;
  readonly rejectedOverLimit: number;
}

/**
 * Keep the UI's selection rules in one pure function. The native port repeats
 * its own validation: this only gives an immediate, non-sensitive explanation
 * before a file is read or stored as an opaque attachment.
 */
export function selectFeedbackImages(
  files: readonly FeedbackFileMetadata[],
  existingCount: number,
): FeedbackFileSelection {
  const capacity = Math.max(0, maximumFeedbackImages - Math.max(0, existingCount));
  const accepted: FeedbackFileMetadata[] = [];
  let rejectedUnsupported = 0;
  let rejectedOversized = 0;
  let rejectedOverLimit = 0;

  for (const file of files) {
    if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
      rejectedUnsupported += 1;
    } else if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maximumFeedbackImageBytes) {
      rejectedOversized += 1;
    } else if (accepted.length >= capacity) {
      rejectedOverLimit += 1;
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejectedUnsupported, rejectedOversized, rejectedOverLimit };
}

export function feedbackFileSelectionMessage(selection: FeedbackFileSelection): string {
  const rejected = selection.rejectedUnsupported + selection.rejectedOversized + selection.rejectedOverLimit;
  if (selection.accepted.length === 0 && rejected === 0) return "未选择截图。";
  if (selection.accepted.length === 0) {
    if (selection.rejectedUnsupported > 0) return "截图仅支持 JPEG、PNG 或 WebP 格式。";
    if (selection.rejectedOversized > 0) return "单张截图必须大于 0 且不超过 1 MB。";
    return `最多只能添加 ${maximumFeedbackImages} 张截图。`;
  }
  if (rejected === 0) return "截图已准备好。";
  return `已准备 ${selection.accepted.length} 张截图；其余文件因格式、大小或数量限制未添加。`;
}

/** Builds a discriminated draft so a feature suggestion cannot carry traces. */
export function createFeedbackDraft(
  kind: "bug",
  text: string,
  imageAttachmentIds: readonly string[],
  diagnosticAttachmentId?: string,
): BugFeedbackDraft;
export function createFeedbackDraft(
  kind: "feature",
  text: string,
  imageAttachmentIds: readonly string[],
): FeatureFeedbackDraft;
export function createFeedbackDraft(
  kind: FeedbackKind,
  text: string,
  imageAttachmentIds: readonly string[],
  diagnosticAttachmentId?: string,
): FeedbackDraft {
  if (kind === "bug") return { kind, text, imageAttachmentIds, ...(diagnosticAttachmentId ? { diagnosticAttachmentId } : {}) };
  return { kind, text, imageAttachmentIds };
}
