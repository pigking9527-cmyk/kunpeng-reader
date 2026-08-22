/**
 * Typed, privacy-preserving boundary for the Support feature.
 *
 * The feature layer only sees attachment metadata and opaque IDs. The bridge
 * that implements this port owns file bytes, native commands and any local
 * diagnostic snapshot, so a component cannot accidentally log or render
 * private feedback contents.
 */
export type FeedbackKind = "bug" | "feature";

export interface AboutInfo {
  readonly appVersion: string;
  readonly buildLabel?: string;
}

export interface UpdateInfo {
  readonly hasUpdate: boolean;
  readonly latestVersion?: string;
  readonly releaseUrl?: string;
  /** Release notes returned with an available update, never rendered as HTML. */
  readonly releaseNotes?: string;
}

/** The bundled/current version's release notes, suitable for safe text rendering. */
export interface CurrentReleaseNotes {
  readonly version: string;
  readonly markdown: string;
}

export interface PreparedAttachment {
  /** Opaque handle understood only by the port implementation. */
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}

interface FeedbackDraftBase {
  readonly text: string;
  /** Opaque image handles, never base64/image data. */
  readonly imageAttachmentIds: readonly string[];
}

/** Only Bug feedback may include an opaque, redacted diagnostics handle. */
export interface BugFeedbackDraft extends FeedbackDraftBase {
  readonly kind: "bug";
  readonly diagnosticAttachmentId?: string;
}

/** Feature suggestions are intentionally unable to carry a diagnostic trace. */
export interface FeatureFeedbackDraft extends FeedbackDraftBase {
  readonly kind: "feature";
  readonly diagnosticAttachmentId?: never;
}

export type FeedbackDraft = BugFeedbackDraft | FeatureFeedbackDraft;

export interface FeedbackSubmission {
  readonly id: string;
}

export interface DiagnosticsSummary {
  readonly appVersion: string;
  readonly bookCount?: number;
  readonly disabledSwitchCount?: number;
  readonly runtimeStatus?: "ready" | "degraded" | "unavailable";
}

/**
 * All native communication, collection, serialization and upload is injected
 * through this port. Implementations must honour AbortSignal where their
 * underlying protocol supports it and must not write feedback content to logs.
 */
export interface SupportPort {
  loadAbout(signal: AbortSignal): Promise<AboutInfo>;
  loadCurrentReleaseNotes(signal: AbortSignal): Promise<CurrentReleaseNotes>;
  checkForUpdates(signal: AbortSignal): Promise<UpdateInfo>;
  /** Persists the user's opt-out for this version and all older versions. */
  ignoreUpdate(version: string, signal: AbortSignal): Promise<void>;
  openExternal(url: string, signal: AbortSignal): Promise<void>;

  prepareFeedbackImages(
    files: readonly File[],
    signal: AbortSignal,
  ): Promise<readonly PreparedAttachment[]>;
  captureRedactedDiagnostics(signal: AbortSignal): Promise<PreparedAttachment | null>;
  /** Saves an opt-in, redacted problem record to the desktop; no path reaches callers. */
  saveRedactedProblemTraceToDesktop(signal: AbortSignal): Promise<void>;
  submitFeedback(draft: FeedbackDraft, signal: AbortSignal): Promise<FeedbackSubmission>;
  /** Drops opaque attachment bytes that the UI no longer needs. */
  releaseFeedbackAttachments(ids: readonly string[]): void;

  loadDiagnostics(signal: AbortSignal): Promise<DiagnosticsSummary>;
  exportRedactedDiagnostics(signal: AbortSignal): Promise<void>;
  enableSafeMode(signal: AbortSignal): Promise<void>;
}
